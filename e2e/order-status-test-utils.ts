/** E-5 の合成データと秘密値を報告へ持ち出さない道具。実行は controller の手元だけ。 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_FIXED_ENV, isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import {
  createCatalogFixture, createDraft, insertCancelRequest, insertReturnReceipt, insertReturnRecord,
  insertReturnRefund, PRICE,
} from '../tests/integration/db/helpers/order-fixtures';
import { insertDeliveryFixture, insertDeliveryRegistration } from '../tests/integration/db/helpers/delivery-tracking-fixtures';
import { expectNoHorizontalOverflow, isolateCustomerApiIp } from './delivery-tracking-test-utils';
import { mailsTo, uniqueEmail, withLocalDb } from './order-email-test-utils';
import { ensureReturnSettings, RETURN_ADDRESS } from './return-test-utils';

export const orderStatusViewports = [
  { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 },
] as const;
export const STATUS_PRIVATE = {
  name: 'E5_PRIVATE_NAME', address: 'E5_PRIVATE_ADDRESS', postalCode: '9999999',
  phone: '09012345678', emailPrefix: 'e2e-order-email-e5-private-',
  tracking: 'E5-PRIVATE-TRACKING', sentBack: 'E5-PRIVATE-SENT-BACK',
  // 返送先の設定は既存の返品の試験と共有する1行。同じ値を書く既存の約束（ensureReturnSettings）に合わせる。
  returnAddress: RETURN_ADDRESS.address,
} as const;
export const STATUS_SHOP_MESSAGE = '<b data-e5-shop-html="yes">店からのご案内</b>';
const ORIGIN = 'http://localhost:3000';
const ENDPOINT = 'order-status:verify';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const checkedClients = new WeakSet<PgClient>();
type Scope = { orders: Set<string>; ips: Set<string> };
const scopes = new WeakMap<PgClient, Scope>();
const isolatedIps = new Set<string>();

/** 失敗の文に添える手がかり。例外の種類（name と、Playwright が包む内側の *Error）だけで、メッセージ本体は出さない。 */
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const inner = /^[\w.]+: ([A-Z][A-Za-z]*Error)\b/.exec(error.message)?.[1];
  return inner ? `${error.name}/${inner}` : error.name;
}

/** DB の SQLSTATE（5文字）だけを取り出す。メッセージや値は出さない。 */
function sqlState(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : '-';
}

/** 接続済みの実際の接続先も確認する。URLだけを検査して、渡された別接続を信用しない。 */
async function localPostgres(db: PgClient): Promise<PgClient> {
  if (checkedClients.has(db)) return db;
  const connection = (db as unknown as { connectionParameters?: { host?: string; user?: string } }).connectionParameters;
  if (!connection || !LOCAL_HOSTS.has(connection.host ?? '') || connection.user !== 'postgres') {
    throw new Error('注文状況の試験DBは loopback の postgres 接続だけ');
  }
  let identity;
  try { identity = (await db.query('select current_user as role')).rows[0]; }
  catch { throw new Error('注文状況の試験DBを確認できない'); }
  // Docker の DB 内の listen address は loopback とは限らない。接続先は上の client metadata で検査する。
  if (identity.role !== 'postgres') throw new Error('注文状況の試験DBは loopback の postgres 接続だけ');
  const safe: PgClient = {
    query: async (sql, params) => {
      try { return await db.query(sql, params); }
      catch (error) {
        // 操作の種類（先頭の語）と SQLSTATE だけ添える。SQL 本体・値は出さない。
        throw new Error(`注文状況の試験DBの操作に失敗した (${sql.trimStart().split(/\s+/, 1)[0].toLowerCase()} ${sqlState(error)})`);
      }
    },
    end: () => db.end(),
  };
  checkedClients.add(safe);
  return safe;
}

function remember(db: PgClient, orderId: string): void { scopes.get(db)?.orders.add(orderId); }

/** 自分のリンク・メール・枠を finally で片づける。注文は次のresetで捨てる。共有の設定は書き換えないので、直列化の鍵は取らない。 */
export async function withOrderStatusDb<T>(run: (db: PgClient) => Promise<T>): Promise<T> {
  const configured = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error('注文状況の試験DBの住所が不正'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname) || url.username !== 'postgres') {
    throw new Error('注文状況の試験DBは loopback の postgres 接続だけ');
  }
  return withLocalDb(async (raw) => {
    const db = await localPostgres(raw);
    const scope: Scope = { orders: new Set(), ips: new Set(isolatedIps) };
    isolatedIps.clear();
    scopes.set(db, scope);
    try { return await run(db); }
    finally {
      try {
        const ids = [...scope.orders];
        await db.query(`update private.fulfillment_tracking_registrations set state='stopped',stop_reason='expired',
          stopped_at=now(),failure_kind=null,expires_at=now()-interval '1 minute',lease_token=null,
          lease_expires_at=null,provider_stop_pending=false
          where fulfillment_id in (select id from public.order_fulfillments where order_id=any($1::uuid[]))`, [ids]);
        await db.query('delete from private.order_email_outbox where order_id=any($1::uuid[])', [ids]);
        await db.query('delete from private.order_status_links where order_id=any($1::uuid[])', [ids]);
        const subjects = ids.map((id) => `${ENDPOINT}|acct:${createHash('sha512').update(id).digest('hex')}`);
        await db.query(`delete from public.rate_limit_counters
          where (ip=any($1::inet[]) and endpoint=$2) or (ip is null and endpoint=any($3::text[]))`,
        [[...scope.ips], ENDPOINT, subjects]);
      } finally {
        scopes.delete(db);
      }
    }
  });
}

type Scenario = { orderId: string; orderItemId: string; lastFour: string | null };
type ScenarioInput = { kind: 'public' | 'returns' | 'delivery'; customerId?: string | null; phone?: string | null };
async function createBase(db: PgClient, input: ScenarioInput, status = 'paid'): Promise<Scenario> {
  const catalog = await createCatalogFixture(db, { stock: 4, itemStatus: 'private' });
  const draft = await createDraft(db, { itemId: catalog.itemId, quantity: 4 });
  const paymentIntent = `pi_e5_${randomUUID().replaceAll('-', '')}`;
  await db.query("update public.checkout_drafts set payment_intent_id=$2,payment_method='stripe_card' where id=$1", [draft.draftId, paymentIntent]);
  const phone = input.phone === undefined ? STATUS_PRIVATE.phone : input.phone;
  const order = (await db.query(`insert into public.orders
    (session_id,checkout_session_id,payment_intent_id,user_id,status,subtotal_amount,shipping_amount,
     discount_amount,total_amount,paid_amount,currency,shipping_email,shipping_full_name,shipping_postal_code,
     shipping_prefecture,shipping_city,shipping_address,shipping_building,shipping_phone)
    values ($1,$2,$3,$4,$5::public.order_status,$6,0,0,$6,$6,'jpy',$7,$8,$9,'東京都','試験区',$10,'試験棟',$11) returning id`,
  [draft.cartSessionId, draft.checkoutSessionId, paymentIntent, input.customerId ?? null, status, PRICE * 4,
    uniqueEmail('e5-private'), STATUS_PRIVATE.name, STATUS_PRIVATE.postalCode, STATUS_PRIVATE.address, phone])).rows[0];
  const orderId = order.id as string;
  remember(db, orderId);
  const line = (await db.query(`insert into public.order_items
    (order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,fulfillment_type)
    values ($1,$2,$3,'公開用の試験商品',$4,'BLACK','M',4,$5,'stock') returning id`,
  [orderId, catalog.itemId, catalog.variantId, PRICE, PRICE * 4])).rows[0];
  await db.query(`insert into public.stock_movements (variant_id,delta,reason,order_id,order_item_id)
    values ($1,-4,'purchase',$2,$3)`, [catalog.variantId, orderId, line.id]);
  const digits = phone?.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9]/g, '') ?? '';
  return { orderId, orderItemId: line.id as string, lastFour: digits.length >= 4 ? digits.slice(-4) : null };
}

async function ship(db: PgClient, order: Scenario, quantity = 4): Promise<string> {
  const shippedAt = (await db.query("select (now()-interval '1 hour')::text as at")).rows[0].at as string;
  const { fulfillmentId } = await insertDeliveryFixture(db, { orderId: order.orderId, shippedAt,
    trackingNumber: `${STATUS_PRIVATE.tracking}-${randomUUID().slice(0, 8)}` });
  await db.query('insert into public.order_fulfillment_lines (fulfillment_id,order_item_id,quantity) values ($1,$2,$3)',
    [fulfillmentId, order.orderItemId, quantity]);
  return fulfillmentId;
}

export async function createOrderStatusScenario(db: PgClient, input: ScenarioInput): Promise<Scenario> {
  db = await localPostgres(db);
  const order = await createBase(db, input);
  if (input.kind === 'returns') {
    await ensureReturnSettings(db);
    const fulfillmentId = await ship(db, order);
    await insertReturnRecord(db, { orderId: order.orderId, lines: [{ fulfillmentId, orderItemId: order.orderItemId, quantity: 1 }] });
    const back = await insertReturnRecord(db, { orderId: order.orderId,
      lines: [{ fulfillmentId, orderItemId: order.orderItemId, quantity: 1 }] });
    // 受け取りの追記は immutable なので、番号と品のひも付けを INSERT 時にそろえる。
    const receipt = (await db.query(`insert into public.order_return_receipts
      (return_id,request_key,request_fingerprint,kind,refund_choice,sent_back_carrier,sent_back_tracking_number,sent_back_message)
      values ($1,gen_random_uuid(),'e5','receive','none','yamato',$2,'送り返しのご案内') returning id`, [back.returnId, STATUS_PRIVATE.sentBack])).rows[0];
    await db.query(`insert into public.order_return_receipt_lines (receipt_id,return_line_id,disposition,quantity)
      values ($1,$2,'sent_back',1)`, [receipt.id, back.lineIds[0]]);
  }
  if (input.kind === 'delivery') await createDeliveryMaterial(db, order);
  return order;
}

export async function createOrderStatusStateCase(db: PgClient, status: 'payment_in_progress' | 'abandoned' | 'cancelled'): Promise<Scenario> {
  return createBase(await localPostgres(db), { kind: 'public' }, status);
}

export async function createOrderStatusReturnCase(db: PgClient,
  state: 'requested' | 'accepted' | 'partially_received' | 'inspecting' | 'awaiting_fee' | 'refund_preparing' | 'returned' | 'declined',
): Promise<Scenario> {
  db = await localPostgres(db);
  await ensureReturnSettings(db);
  const order = await createBase(db, { kind: 'returns' });
  const fulfillmentId = await ship(db, order);
  const record = await insertReturnRecord(db, { orderId: order.orderId,
    status: state === 'requested' || state === 'declined' ? state : state === 'returned' ? 'closed' : 'open',
    feeDueAmount: state === 'awaiting_fee' ? 500 : 0,
    lines: [{ fulfillmentId, orderItemId: order.orderItemId, quantity: 2 }] });
  if (state === 'declined') await db.query('update public.order_returns set decline_message=$2 where id=$1', [record.returnId, STATUS_SHOP_MESSAGE]);
  if (['partially_received', 'inspecting', 'refund_preparing', 'returned'].includes(state)) {
    await insertReturnReceipt(db, { returnId: record.returnId, lines: [{ returnLineId: record.lineIds[0],
      disposition: state === 'inspecting' ? 'pending_inspection' : 'restocked', quantity: state === 'partially_received' ? 1 : 2 }] });
  }
  if (state === 'returned') await insertReturnRefund(db, { orderId: order.orderId, returnId: record.returnId,
    status: 'succeeded', amount: 8000, lines: [{ orderItemId: order.orderItemId, quantity: 2, amount: 8000 }] });
  return order;
}

export async function createOrderStatusCancelCase(db: PgClient, status: 'requested' | 'declined' | 'resolved' | 'closed'): Promise<Scenario> {
  db = await localPostgres(db);
  const order = await createBase(db, { kind: 'public' });
  await insertCancelRequest(db, { orderId: order.orderId, status, lines: [{ orderItemId: order.orderItemId, quantity: 1 }] });
  return order;
}

async function createDeliveryMaterial(db: PgClient, order: Scenario): Promise<void> {
  const first = (await db.query(`insert into public.order_fulfillments
    (order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order,shipped_at,
     tracking_version,delivery_status,delivery_status_at)
    values ($1,1,gen_random_uuid(),'yamato',$2,false,false,now()-interval '2 hours',2,'in_transit',now()-interval '1 hour') returning id`,
  [order.orderId, `${STATUS_PRIVATE.tracking}-${randomUUID().slice(0, 8)}`])).rows[0].id as string;
  await db.query(`insert into public.order_fulfillment_lines (fulfillment_id,order_item_id,quantity) values ($1,$2,1)`, [first, order.orderItemId]);
  await db.query(`insert into public.order_fulfillment_events (fulfillment_id,tracking_version,status,happened_at,source)
    values ($1,1,'attempted_delivery',now()-interval '90 minutes','tracking'),
           ($1,2,'confirmed',now()-interval '2 hours','shipment'),
           ($1,2,'in_transit',now()-interval '1 hour','tracking')`, [first]);
  await insertDeliveryRegistration(db, first, { version: 2, state: 'stopped', stopReason: 'provider_stopped', everRegistered: true });
  const cancelled = await ship(db, order, 1);
  await db.query('update public.order_fulfillments set cancelled_at=now() where id=$1', [cancelled]);
  const clock = (await db.query("select (now()-interval '2 hours')::text as shipped,(now()-interval '30 minutes')::text as delivered")).rows[0];
  const delivered = await insertDeliveryFixture(db, { orderId: order.orderId, shippedAt: clock.shipped,
    deliveredAt: clock.delivered, trackingNumber: `${STATUS_PRIVATE.tracking}-${randomUUID().slice(0, 8)}` });
  await db.query('insert into public.order_fulfillment_lines (fulfillment_id,order_item_id,quantity) values ($1,$2,1)', [delivered.fulfillmentId, order.orderItemId]);
  // 古い順でなく INSERT し、表示順と failed/error の除外を一緒に確かめる。
  for (const [status, amount, days] of [['succeeded', 2000, 1], ['pending', 1000, 2], ['failed', 3000, 3], ['error', 4000, 4]]) {
    await db.query(`insert into public.order_refunds
      (order_id,source,request_key,request_fingerprint,status,amount,notify_customer,note,created_at)
      values ($1,'admin',gen_random_uuid(),'e5',$2,$3,false,'E5_INTERNAL_REFUND',now()-$4::integer*interval '1 day')`,
    [order.orderId, status, amount, days]);
  }
}

export async function prepareOrderStatusTestLink(db: PgClient, orderId: string): Promise<string> {
  db = await localPostgres(db);
  const token = (await db.query('select public.ensure_order_status_link($1) as token', [orderId])).rows[0].token as string;
  await db.query("update private.order_status_links set verify_until=now()+interval '21 days' where order_id=$1", [orderId]);
  return token;
}

export async function setOrderStatusTestState(db: PgClient, input: { orderId: string; verifyUntil?: string | null; failedAttempts?: number }): Promise<void> {
  db = await localPostgres(db);
  const result = await db.query(`update private.order_status_links
    set verify_until=case when $2 then $3::timestamptz else verify_until end,
        failed_attempts=case when $4 then $5::integer else failed_attempts end where order_id=$1`,
  [input.orderId, input.verifyUntil !== undefined, input.verifyUntil ?? null, input.failedAttempts !== undefined, input.failedAttempts ?? null]);
  if (result.rowCount !== 1) throw new Error('注文状況の試験リンクが無い');
}

export async function readOrderStatusTestState(db: PgClient, orderId: string): Promise<{ failedAttempts: number }> {
  db = await localPostgres(db);
  const row = (await db.query('select failed_attempts as "failedAttempts" from private.order_status_links where order_id=$1', [orderId])).rows[0];
  if (!row) throw new Error('注文状況の試験リンクが無い');
  return row;
}

export async function expireOrderStatusTestBuckets(db: PgClient, input: { ip: string; orderId: string }): Promise<void> {
  db = await localPostgres(db);
  scopes.get(db)?.ips.add(input.ip);
  const subject = `${ENDPOINT}|acct:${createHash('sha512').update(input.orderId).digest('hex')}`;
  const params = [input.ip, ENDPOINT, subject];
  await db.query('begin');
  try {
    // 移動先にある自分の古い行だけ削除。元のbucketの差を保って移し、複数の最近の枠も衝突させない。
    await db.query(`delete from public.rate_limit_counters old using public.rate_limit_counters recent
      where ((recent.ip=$1::inet and recent.endpoint=$2) or (recent.ip is null and recent.endpoint=$3))
        and recent.bucket>now()-interval '1 day' and old.ip is not distinct from recent.ip
        and old.endpoint=recent.endpoint and old.bucket=recent.bucket-interval '2 days'`, params);
    await db.query(`update public.rate_limit_counters set bucket=bucket-interval '2 days'
      where ((ip=$1::inet and endpoint=$2) or (ip is null and endpoint=$3)) and bucket>now()-interval '1 day'`, params);
    await db.query('commit');
  } catch {
    await db.query('rollback');
    throw new Error('注文状況の試験の枠を移せない');
  }
}

export async function queueOrderStatusPaidMail(db: PgClient, orderId: string): Promise<string> {
  db = await localPostgres(db);
  await db.query(`insert into private.order_email_outbox (order_id,kind,variant,origin,status)
    values ($1,'paid','order_confirmed','auto','pending')`, [orderId]);
  return (await db.query('select shipping_email from public.orders where id=$1', [orderId])).rows[0].shipping_email as string;
}

export async function setOrderStatusSessionForTest(page: Page, input: {
  orderId: string; token: string; issuedAt: Date; verifyUntil: Date; tamper?: boolean; keepExpiredTransport?: boolean;
}): Promise<void> {
  const secret = E2E_FIXED_ENV.ORDER_STATUS_SESSION_SECRET;
  if (!secret || process.env.ORDER_STATUS_SESSION_SECRET !== secret) throw new Error('注文状況の確認印は専用のE2E鍵だけ');
  const iat = Math.floor(input.issuedAt.getTime() / 1000);
  const exp = Math.min(iat + 86400, Math.floor(input.verifyUntil.getTime() / 1000));
  const payload = Buffer.from(JSON.stringify({ purpose: 'order_status', orderId: input.orderId,
    tokenHashPrefix: createHash('sha256').update(input.token).digest('hex').slice(0, 16), iat, exp })).toString('base64url');
  let signature = createHmac('sha256', secret).update(payload).digest('base64url');
  if (input.tamper) signature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  try {
    await page.context().addCookies([{ name: 'sb-order-status', value: `${payload}.${signature}`, domain: 'localhost',
      path: `/api/order-status/${input.token}`, httpOnly: true, secure: true, sameSite: 'Strict',
      expires: input.keepExpiredTransport ? Math.floor(Date.now() / 1000) + 3600 : exp }]);
  } catch { throw new Error('注文状況の試験の確認印を保存できない'); }
}

export async function openOrderStatusPage(page: Page, token: string): Promise<number> {
  try { return (await page.goto(`/order-status/${encodeURIComponent(token)}`))?.status() ?? 0; }
  catch { throw new Error('注文状況のページを開けない'); }
}
export async function reloadOrderStatusPage(page: Page): Promise<void> {
  try { await page.reload(); } catch { throw new Error('注文状況のページを読み直せない'); }
}

type StatusJson = { access?: string; code?: string; verifiable?: boolean; reason?: string | null; [key: string]: unknown };
type StatusReply = { status: number; body: StatusJson; cacheControl: string | null; referrerPolicy: string | null; retryAfter?: string | null };
export async function readOrderStatusPrivate(page: Page, token: string): Promise<StatusReply> {
  try {
    return await page.evaluate(async (value) => {
      const response = await fetch(`/api/order-status/${encodeURIComponent(value)}/private`, { cache: 'no-store', credentials: 'same-origin' });
      return { status: response.status, body: await response.json(), cacheControl: response.headers.get('cache-control'), referrerPolicy: response.headers.get('referrer-policy') };
    }, token);
  } catch { throw new Error('注文状況の個人情報の応答を読めない'); }
}

export async function postOrderStatusVerify(request: APIRequestContext, token: string, lastFour: string,
  input: { ip: string; origin?: string | null },
): Promise<StatusReply> {
  try {
    const response = await request.post(`/api/order-status/${encodeURIComponent(token)}/verify`, {
      headers: { 'x-forwarded-for': input.ip, ...(input.origin === null ? { referer: '' } : { origin: input.origin ?? ORIGIN }) },
      data: { lastFour }, maxRedirects: 0,
    });
    return { status: response.status(), body: await response.json(), cacheControl: response.headers()['cache-control'] ?? null,
      referrerPolicy: response.headers()['referrer-policy'] ?? null, retryAfter: response.headers()['retry-after'] ?? null };
  } catch { throw new Error('注文状況の確認の応答を読めない'); }
}

export async function isolateOrderStatusApiIp(page: Page): Promise<string> {
  const ip = await isolateCustomerApiIp(page);
  isolatedIps.add(ip);
  await page.route('**/api/order-status/**', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) { await route.fallback(); return; }
    await route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } });
  });
  return ip;
}

export async function verifyOrderStatusInPage(page: Page, lastFour: string): Promise<void> {
  try {
    await page.getByLabel('ご注文の時の電話番号の下4桁', { exact: true }).fill(lastFour);
    await page.getByRole('button', { name: '確かめる', exact: true }).click();
  } catch { throw new Error('注文状況の下4桁を送信できない'); }
  await expect(page.getByRole('heading', { name: 'お届け先', exact: true })).toBeVisible();
}

/** 確認後の個人情報を項目ごとに見る（値は出さず、項目名つきの true/false だけ）。phone は注文に入れた電話の元の文字。 */
export async function expectOrderStatusPrivateVisible(page: Page, input: { returns?: boolean; phone?: string } = {}): Promise<void> {
  await expect(page.getByRole('heading', { name: 'お届け先', exact: true })).toBeVisible();
  const found = await page.evaluate((values) => {
    // 項目は見出しごとの欄の中だけで探す（注文番号や金額に偶然入った文字で通らないようにする）。
    const section = (heading: string): Element | undefined =>
      [...document.querySelectorAll('section')].find((node) => node.querySelector('h2')?.textContent === heading);
    const text = (heading: string): string => section(heading)?.textContent ?? '';
    const phoneLabel = [...(section('お届け先')?.querySelectorAll('dt') ?? [])].find((node) => node.textContent === '電話番号');
    const shipping = text('お届け先');
    const returns = text('返品の返送先・送り返しの伝票番号');
    return {
      name: shipping.includes(values.name),
      postalCode: shipping.includes(values.postalCode),
      address: shipping.includes(values.address),
      phone: (phoneLabel?.nextElementSibling?.textContent ?? '').normalize('NFKC') === values.phone.normalize('NFKC'),
      email: text('ご連絡先').includes(values.emailPrefix),
      payment: text('お支払い方法').includes('クレジットカード'),
      tracking: text('伝票番号').includes(values.tracking),
      sentBack: returns.includes(values.sentBack),
      returnAddress: returns.includes(values.returnAddress),
    };
  }, { ...STATUS_PRIVATE, phone: input.phone ?? STATUS_PRIVATE.phone });
  expect(found.name, 'お届け先に氏名が表示される').toBe(true);
  expect(found.postalCode, 'お届け先に郵便番号が表示される').toBe(true);
  expect(found.address, 'お届け先に住所が表示される').toBe(true);
  expect(found.phone, 'お届け先に電話番号が元の形で表示される').toBe(true);
  expect(found.email, 'ご連絡先にメールアドレスが表示される').toBe(true);
  expect(found.payment, 'お支払い方法にクレジットカードが表示される').toBe(true);
  if (input.returns) {
    await expect(page.getByRole('heading', { name: '返品の返送先・送り返しの伝票番号', exact: true })).toBeVisible();
    expect(found.tracking, '発送の伝票番号が表示される').toBe(true);
    expect(found.sentBack, '送り返しの伝票番号が表示される').toBe(true);
    expect(found.returnAddress, '返品の返送先が表示される').toBe(true);
  }
  await expectNoHorizontalOverflow(page);
}

function privateMaterial(text: string): boolean {
  return [...Object.values(STATUS_PRIVATE), 'shipping_full_name', 'shipping_email', 'shipping_phone',
    'shipping_postal_code', 'shipping_prefecture', 'shipping_city', 'shipping_address', 'shipping_building',
    'payment_intent_id', 'payment_method', 'customerId', 'fullName', 'contactEmail',
    'tracking_number', 'tracking_url', 'return_address', 'trackingNumber', 'trackingUrl',
    'returnAddress', 'paymentMethod', 'E5_INTERNAL_REFUND']
    .some((value) => text.includes(value));
}
export async function inspectOrderStatusPublicTransport(page: Page, token: string): Promise<{ htmlPrivate: boolean; rscPrivate: boolean; rsc: boolean }> {
  try {
    const htmlPrivate = privateMaterial(await page.content());
    const result = await page.evaluate(async (value) => {
      // Next は _rsc の無い RSC 要求を `?_rsc` へ 307 で戻す。ページの CSP（upgrade-insecure-requests）が
      // その転送先を https に上げて失敗するため、転送先と同じ `?_rsc` を最初から付けて直接取る。
      const response = await fetch(`/order-status/${encodeURIComponent(value)}?_rsc`, { headers: { RSC: '1' }, cache: 'no-store' });
      return { text: await response.text(), rsc: response.headers.get('content-type')?.includes('text/x-component') ?? false };
    }, token);
    return { htmlPrivate, rscPrivate: privateMaterial(result.text), rsc: result.rsc };
  } catch (error) { throw new Error(`注文状況の公開の応答を調べられない (${errorKind(error)})`); }
}

/** 生本文を読むのは006だけ。本文・URL・元の例外は一切報告へ渡さない。 */
export async function readOrderStatusUrlFromMail(request: APIRequestContext, email: string): Promise<URL> {
  try {
    const mailUrl = process.env.MAIL_LOCAL_URL;
    if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error();
    const messages = (await mailsTo(request, email)).filter((message) => message.Subject.includes('ご注文ありがとうございます'));
    if (messages.length !== 1) throw new Error();
    const response = await request.get(new URL(`/api/v1/message/${encodeURIComponent(messages[0].ID)}`, mailUrl).href, { timeout: 5000, maxRedirects: 0 });
    if (!response.ok()) throw new Error();
    const body = await response.json() as { Text: string };
    const matches = [...body.Text.replace(/\r\n/g, '\n').matchAll(/^ご注文の状況はこちら: (.+)$/gm)];
    if (matches.length !== 1) throw new Error();
    const url = new URL(matches[0][1]);
    if (url.origin !== ORIGIN || !/^\/order-status\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
      || url.search || url.hash || url.username || url.password) throw new Error();
    return url;
  } catch { throw new Error('注文確認のメールに正しい手元の注文状況リンクが1本必要'); }
}
