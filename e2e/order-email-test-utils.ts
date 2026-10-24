/**
 * 注文のメールの E2E の道具（グループ D）。手元の DB・手元のメール受け（Mailpit）・worker の定期処理の入口だけを使う。
 * 本物の管理者のログインには2段階認証（TOTP）が要るので、管理画面の操作の代わりに DB の関数を直に呼ぶ（本計画 P11）。
 * グループ E-1 で、明細つきの注文を作る道具・仕上がり/発送/取消の DB の関数の呼び出し・メールの本文を読む道具を足した。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { isLocalUrl } from '../scripts/e2e/environment';
import {
  PRICE,
  createCatalogFixture,
  insertOrderWithStockLine,
  uniqueSuffix,
} from '../tests/integration/db/helpers/order-fixtures';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import {
  allocationKindOf,
  lockE2eInventory,
  releaseE2eUnpaidOrder,
  seedE2eAllocation,
  seedE2eRestock,
  shipE2eOrder,
  withGroupG1Material,
} from './group-g1-test-utils';

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export async function withLocalDb<T>(fn: (db: PgClient) => Promise<T>): Promise<T> {
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB 以外では注文を作らない');
  const client = new Client({ connectionString: LOCAL_DB_URL });
  try { await client.connect(); }
  catch {
    await client.end().catch(() => undefined);
    throw new Error('手元の試験DBへ接続できない');
  }
  try {
    return await fn(client as unknown as PgClient);
  } finally {
    try { await client.end(); }
    catch { throw new Error('手元の試験DBの接続を閉じられない'); }
  }
}

export function uniqueEmail(label: string): string {
  return `e2e-order-email-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

/**
 * 入金済みの注文（在庫の明細1行）を、試験ごとの宛先で作る。
 * 商品は非公開にする。公開のままだと、同じ実行の中で並行して流れる他の購入 spec の seedCart が選ぶ
 * 「新しい順の最初の商品」が、この試験用の商品に入れ替わってしまう。
 * G-1: 在庫は本物の入荷の入口で入れ、注文と A（入金済みの割当）を同じ取引で作る。
 */
export async function createPaidOrder(db: PgClient, email: string): Promise<string> {
  return withGroupG1Material(db, async () => {
    const fx = await createCatalogFixture(db, { stock: 0, itemStatus: 'private' });
    await seedE2eRestock(db, { itemId: fx.itemId, variantId: fx.variantId, quantity: 1 });
    await lockE2eInventory(db, { variantIds: [fx.variantId] });
    const { orderId } = await insertOrderWithStockLine(db, {
      status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true, shippingEmail: email,
    });
    return orderId;
  });
}

/** 再送と発送の関数は実行者（auth.users への外部キー）が要る */
export async function createActor(db: PgClient): Promise<string> {
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [uniqueEmail('admin')],
  );
  return res.rows[0].id as string;
}

/** worker の定期処理の入口を1回叩く（Stripe の知らせの後に注文のメールを送る） */
export async function runWorkerOnce(request: APIRequestContext): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET が無い（E2E の固定の値）');
  const response = await request.post('/api/cron/process-stripe-webhooks', {
    headers: { authorization: `Bearer ${secret}` },
    timeout: 90_000,
  }).catch(() => { throw new Error('手元のworkerを呼び出せない'); });
  expect(response.status()).toBe(200);
}

export type MailpitMessage = { ID: string; Subject: string };

/** 手元のメール受けで、その宛先へのメールを読む（API: https://mailpit.axllent.org/docs/api-v1/） */
export async function mailsTo(request: APIRequestContext, email: string): Promise<MailpitMessage[]> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  const response = await request.get(new URL('/api/v1/search', mailUrl).toString(), {
    params: { query: `to:${email}` },
    timeout: 5_000,
  }).catch(() => { throw new Error('手元のメール一覧を取得できない'); });
  expect(response.ok()).toBe(true);
  const body = (await response.json().catch(() => { throw new Error('手元のメール一覧を読めない'); })) as { messages?: MailpitMessage[] };
  return body.messages ?? [];
}

// ---- ここから下がグループ E-1 で足した物 ----

export type MailBody = { Subject: string; Text: string };

/** P30: 読んだ後の値だけを伏せ、送る本文と DB の保存済み本文には触れない。 */
export function maskOrderStatusMailLinks(text: string): string {
  return text.replace(/(\/order-status\/)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '$1[ORDER_STATUS_LINK]');
}

/** その宛先へのメールを、本文つきで読む。件名に含む文字で絞れる（Mailpit は1通ごとに本文の API が別） */
export async function mailBodies(request: APIRequestContext, email: string, subjectIncludes = ''): Promise<MailBody[]> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  const found = (await mailsTo(request, email)).filter((message) => message.Subject.includes(subjectIncludes));
  const bodies: MailBody[] = [];
  for (const message of found) {
    const response = await request.get(new URL(`/api/v1/message/${encodeURIComponent(message.ID)}`, mailUrl).toString(), {
      timeout: 5_000,
    }).catch(() => { throw new Error('手元のメールを取得できない'); });
    expect(response.ok()).toBe(true);
    const body = (await response.json().catch(() => { throw new Error('手元のメールを読めない'); })) as MailBody;
    // 返金・キャンセルのお知らせは、行の並びを続けて確かめる。メール受けが CRLF で返しても、LF にそろえる
    bodies.push({ Subject: body.Subject, Text: maskOrderStatusMailLinks(body.Text.replace(/\r\n/g, '\n')) });
  }
  return bodies;
}

/**
 * 条件が満たされるまで、worker の定期処理の入口を叩き直す。
 * worker は10秒の予算で止まり、別の起動が取った行は飛ばすので、1回叩いただけでは送り切った証拠にならない。
 */
export async function runWorkerUntil(
  request: APIRequestContext,
  done: () => Promise<boolean>,
  message: string,
  timeoutMs = 90_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await runWorkerOnce(request);
        return done();
      },
      { timeout: timeoutMs, intervals: [500, 1_000, 2_000], message },
    )
    .toBe(true);
}

/** DB の関数が決まった言葉（例 QUANTITY_EXCEEDS_READY）で断ることを確かめる。pg の誤りの message にその言葉が入る */
export async function expectDbError(operation: Promise<unknown>, code: string): Promise<void> {
  let message = '';
  try {
    await operation;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message, `${code} で断られること`).toContain(code);
}

export type E2eOrderLine = {
  name: string;
  quantity: number;
  fulfillmentType: 'stock' | 'backorder';
  color?: string;
  size?: string;
};

export type E2eCreatedOrder = { orderId: string; orderItemIds: string[]; itemId: number; variantId: number; totalAmount: number };

/**
 * 明細を自由に決めた注文を作る。配送先は後から書き換えられないので、発送できる形で最初から入れる。
 * G-1（Task 17）: 1つの G-1 の取引で、在庫の明細の数を本物の入荷の入口で入れ → 色・サイズを押さえ → 注文と明細 →
 * 在庫の明細ごとに割当（入金済みは A、未入金は H。台帳の purchase は割当と一緒に1組だけ）を作る。受注生産の明細は割り当てない。
 * 取消（cancelled）は支払い手続き中で H を作り、同じ取引の本物の解放で H を0にしてから取消にする。
 * 在庫を確保し直せなかった注文（reviewReason: stock_not_reserved）は意図した不足で、入荷も割当もしない。
 * 同じ色・サイズの在庫を複数の注文で使う時は、先の注文の itemId・variantId を catalog に渡す
 * （2件目からは在庫を足さないので、足りる数を最初の注文の在庫の明細で用意する）。
 * 商品は非公開にする（理由は createPaidOrder と同じ）。
 * グループ E-2: 返金の試験のために、お客様から受け取った額（paidAmount。'total' なら注文の合計）・Stripe の支払いの番号・送料・
 * 会員の持ち主を決められるようにした。渡さなければ今までと同じ（受け取った額と支払いの番号と持ち主は空、送料は 0）。
 * 受け取った額が空の注文は、返金の関数が ORDER_NOT_REFUNDABLE で断る。
 */
export async function createOrderWithLines(
  db: PgClient,
  email: string,
  lines: E2eOrderLine[],
  options: E2eOrderOptions = {},
): Promise<E2eCreatedOrder> {
  return withGroupG1Material(db, () => insertOrderWithLinesInMaterial(db, email, lines, options));
}

export type E2eOrderOptions = {
  status?: 'paid' | 'pending' | 'payment_in_progress' | 'cancelled';
  reviewReason?: 'stock_not_reserved';
  catalog?: { itemId: number; variantId: number };
  paidAmount?: number | 'total';
  paymentIntentId?: string;
  shippingAmount?: number;
  userId?: string;
};

/** createOrderWithLines の本体。呼び手の G-1 の取引（共通の鍵の後）の中で流す */
async function insertOrderWithLinesInMaterial(
  db: PgClient,
  email: string,
  lines: E2eOrderLine[],
  options: E2eOrderOptions,
): Promise<E2eCreatedOrder> {
  const status = options.status ?? 'paid';
  const released = status === 'cancelled';
  const insertStatus = released ? 'payment_in_progress' : status;
  const reserves = (line: E2eOrderLine) => line.fulfillmentType === 'stock' && options.reviewReason !== 'stock_not_reserved';
  const stockQuantity = lines.filter(reserves).reduce((sum, line) => sum + line.quantity, 0);
  const catalog = options.catalog ?? (await createCatalogFixture(db, { stock: 0, itemStatus: 'private' }));
  if (!options.catalog && stockQuantity > 0) {
    await seedE2eRestock(db, { itemId: catalog.itemId, variantId: catalog.variantId, quantity: stockQuantity });
  }
  await lockE2eInventory(db, { variantIds: [catalog.variantId] });
  const suffix = uniqueSuffix();
  const subtotal = lines.reduce((sum, line) => sum + PRICE * line.quantity, 0);
  const shipping = options.shippingAmount ?? 0;
  const total = subtotal + shipping;
  const paidAmount = options.paidAmount === 'total' ? total : (options.paidAmount ?? null);
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status, review_reason,
        subtotal_amount, shipping_amount, total_amount, paid_amount, currency,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone, user_id)
     values ($1, $2, $3, $4::public.order_status, $5,
             $6, $7, $8, $9, 'jpy',
             $10, '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222', $11)
     returning id`,
    [
      `e2e-lines-${suffix}`, `cs_e2e_${suffix}`, options.paymentIntentId ?? null, insertStatus,
      options.reviewReason ?? null, subtotal, shipping, total, paidAmount, email, options.userId ?? null,
    ],
  );
  const orderId = order.rows[0].id as string;
  const orderItemIds: string[] = [];
  for (const line of lines) {
    const saved = await db.query(
      `insert into public.order_items
         (order_id, item_id, item_name, item_price, quantity, line_total, variant_id, fulfillment_type, color, size)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        orderId, catalog.itemId, line.name, PRICE, line.quantity, PRICE * line.quantity,
        catalog.variantId, line.fulfillmentType, line.color ?? 'ホワイト', line.size ?? 'M',
      ],
    );
    const orderItemId = saved.rows[0].id as string;
    orderItemIds.push(orderItemId);
    if (reserves(line)) {
      await seedE2eAllocation(db, { orderItemId, quantity: line.quantity, kind: allocationKindOf(insertStatus) });
    }
  }
  if (released) await releaseE2eUnpaidOrder(db, { orderId, status: 'cancelled' });
  return { orderId, orderItemIds, itemId: catalog.itemId, variantId: catalog.variantId, totalAmount: total };
}

/** 注文の明細の番号（作った順） */
export async function orderItemIdsOf(db: PgClient, orderId: string): Promise<string[]> {
  const res = await db.query('select id from public.order_items where order_id = $1 order by created_at, id', [orderId]);
  return res.rows.map((row) => row.id as string);
}

export type E2eLineQuantity = { orderItemId: string; quantity: number };

function dbLines(lines: E2eLineQuantity[]): string {
  return JSON.stringify(lines.map((line) => ({ order_item_id: line.orderItemId, quantity: line.quantity })));
}

export type E2eFulfillment = {
  fulfillmentId: string;
  number: number;
  completesOrder: boolean;
  orderStatus: string;
  replayed: boolean;
};

/**
 * 発送の材料。旧の発送の関数 admin_create_fulfillment は G-1 で止まった（LEGACY_FULFILLMENT_DISABLED）ので呼ばず、
 * 合成の発送（group-g1-test-utils の shipE2eOrder）で A を消費して作る。A が足りなければ材料の失敗（入荷や purchase で補わない）。
 * 業務の操作の成功の証拠ではない（replayed は常に false）。deliveredAt を渡すと、最初から配達済みの発送の材料にする。
 */
export async function createFulfillment(
  db: PgClient,
  orderId: string,
  actorId: string,
  input: {
    lines: E2eLineQuantity[];
    trackingNumber: string;
    carrier?: 'yamato' | 'sagawa' | 'japanpost';
    notify?: boolean;
    requestKey?: string;
    deliveredAt?: string;
  },
): Promise<E2eFulfillment> {
  const shipment = await shipE2eOrder(db, {
    orderId,
    actorId,
    lines: input.lines,
    trackingNumber: input.trackingNumber,
    carrier: input.carrier ?? 'yamato',
    notify: input.notify ?? true,
    requestKey: input.requestKey ?? randomUUID(),
    deliveredAt: input.deliveredAt,
  });
  return { ...shipment, replayed: false };
}

/** 発送の取消の DB の関数 admin_cancel_fulfillment */
export async function cancelFulfillment(
  db: PgClient,
  orderId: string,
  fulfillmentId: string,
  actorId: string,
): Promise<{ outcome: string; orderStatus: string }> {
  const res = await db.query('select * from public.admin_cancel_fulfillment($1::uuid, $2::uuid, $3::uuid)', [
    orderId, fulfillmentId, actorId,
  ]);
  return { outcome: res.rows[0].outcome as string, orderStatus: res.rows[0].order_status as string };
}

/** 仕上がりの記録の DB の関数 admin_record_completion（記録した行ごとに返る） */
export async function recordCompletion(
  db: PgClient,
  orderId: string,
  actorId: string,
  lines: E2eLineQuantity[],
  requestKey: string = randomUUID(),
): Promise<Array<{ completionId: string; orderItemId: string; quantity: number; replayed: boolean }>> {
  const res = await db.query('select * from public.admin_record_completion($1::uuid, $2::uuid, $3::uuid, $4::jsonb)', [
    orderId, actorId, requestKey, dbLines(lines),
  ]);
  return res.rows.map((row) => ({
    completionId: row.completion_id as string,
    orderItemId: row.order_item_id as string,
    quantity: Number(row.quantity),
    replayed: row.replayed as boolean,
  }));
}

/** 仕上がりの取消の DB の関数 admin_cancel_completion。outcome（cancelled・already_cancelled）を返す */
export async function cancelCompletion(
  db: PgClient,
  orderId: string,
  completionId: string,
  actorId: string,
): Promise<string> {
  const res = await db.query('select * from public.admin_cancel_completion($1::uuid, $2::uuid, $3::uuid)', [
    orderId, completionId, actorId,
  ]);
  return res.rows[0].outcome as string;
}

export type E2eLineCounts = {
  quantity: number;
  shipped: number;
  completed: number;
  refundedBeforeShipment: number;
  refundedAfterShipment: number;
  inProduction: number;
  readyUnshipped: number;
  unshipped: number;
};

/** 商品ごとの数（画面も窓口も同じ数え方を使う公開の関数）。キーは注文の明細の番号。グループ E-2 で、返金した数の2つを足した */
export async function lineCounts(db: PgClient, orderId: string): Promise<Record<string, E2eLineCounts>> {
  const res = await db.query('select * from public.list_order_line_fulfillment(array[$1::uuid])', [orderId]);
  const counts: Record<string, E2eLineCounts> = {};
  for (const row of res.rows) {
    counts[row.order_item_id as string] = {
      quantity: Number(row.quantity),
      shipped: Number(row.shipped),
      completed: Number(row.completed),
      refundedBeforeShipment: Number(row.refunded_before_shipment),
      refundedAfterShipment: Number(row.refunded_after_shipment),
      inProduction: Number(row.in_production),
      readyUnshipped: Number(row.ready_unshipped),
      unshipped: Number(row.unshipped),
    };
  }
  return counts;
}

/** 注文の状態と、全部を送った時の値（出荷日時・配送業者・伝票番号） */
export async function orderState(db: PgClient, orderId: string) {
  const res = await db.query(
    'select status::text as status, shipped_at, shipping_carrier, tracking_number from public.orders where id = $1',
    [orderId],
  );
  return res.rows[0] as {
    status: string;
    shipped_at: Date | null;
    shipping_carrier: string | null;
    tracking_number: string | null;
  };
}

export type OutboxRow = {
  fulfillment_id: string | null;
  origin: string;
  status: string;
  last_error_code: string | null;
};

/** 注文のメールの表の、その種類の行を、書いた順に読む */
export async function outboxRows(db: PgClient, orderId: string, kind = 'shipped'): Promise<OutboxRow[]> {
  const res = await db.query(
    `select fulfillment_id, origin, status, last_error_code
     from private.order_email_outbox where order_id = $1 and kind = $2 order by seq`,
    [orderId, kind],
  );
  return res.rows as OutboxRow[];
}

// ---- ここから下がグループ E-2 で足した物 ----

export type E2eRefundSource = 'admin' | 'order_cancel' | 'auto_cancelled_order_payment' | 'auto_amount_mismatch';
export type E2eCancelReason = 'customer_request' | 'payment_declined' | 'suspected_fraud' | 'stock_unavailable' | 'shop_error' | 'other';
export type E2eStripeReason = 'requested_by_customer' | 'duplicate' | 'fraudulent';
export type E2eStripeStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
export type E2eRefundLine = { orderItemId: string; quantity: number; beforeShipment: boolean };
export type E2eBeganRefund = { refundId: string; amount: number; status: string; replayed: boolean };

/**
 * 返金を始める DB の関数 begin_order_refund（記録を「返事待ち」で作るだけ）。管理画面の返金の窓口・支払い済みのキャンセルの窓口の
 * 代わりに、同じ関数を直に呼ぶ。source が admin（既定）なら、商品の行・送料・額は呼ぶ側が決める（額は必須。行が空なら額だけの返金）。
 * order_cancel は DB が残りの未発送を全部入れて全額にするので、行・送料・額は渡さない（取消の理由は必須）。
 * 二重防止の番号は admin と order_cancel の時だけ要る（渡さなければ新しく作る）。断りは pg の誤りの message にその言葉が入る。
 */
export async function beginRefund(
  db: PgClient,
  orderId: string,
  input: {
    source?: E2eRefundSource;
    requestKey?: string;
    lines?: E2eRefundLine[];
    restock?: boolean;
    shippingAmount?: number;
    amount?: number;
    note?: string | null;
    stripeReason?: E2eStripeReason | null;
    cancelReason?: E2eCancelReason | null;
    notifyCustomer?: boolean;
    actorId?: string | null;
    receivedAmount?: number | null;
  } = {},
): Promise<E2eBeganRefund> {
  const source = input.source ?? 'admin';
  if (source === 'admin' && input.amount === undefined) throw new Error('管理画面の返金には額（amount）が要る');
  const needsKey = source === 'admin' || source === 'order_cancel';
  const res = await db.query(
    `select * from public.begin_order_refund(
       $1::uuid, $2::text, $3::uuid, $4::jsonb, $5::boolean, $6::integer, $7::integer, $8::text,
       $9::text, $10::text, $11::boolean, $12::uuid, $13::integer)`,
    [
      orderId,
      source,
      needsKey ? (input.requestKey ?? randomUUID()) : (input.requestKey ?? null),
      JSON.stringify(
        (input.lines ?? []).map((line) => ({
          order_item_id: line.orderItemId,
          quantity: line.quantity,
          before_shipment: line.beforeShipment,
        })),
      ),
      input.restock ?? true,
      source === 'admin' ? (input.shippingAmount ?? 0) : null,
      source === 'admin' ? (input.amount ?? null) : null,
      input.note ?? null,
      input.stripeReason ?? null,
      input.cancelReason ?? null,
      input.notifyCustomer ?? true,
      input.actorId ?? null,
      input.receivedAmount ?? null,
    ],
  );
  const row = res.rows[0];
  return {
    refundId: row.refund_id as string,
    amount: Number(row.amount),
    status: row.status as string,
    replayed: row.replayed as boolean,
  };
}

export type E2eRefundResultFields = {
  /** 同じ記録に続けて結果を書く時（成功の後の失敗など）は、前の答えの stripeRefundId を渡す */
  stripeRefundId?: string;
  stripeStatus?: E2eStripeStatus;
  pendingReason?: 'processing' | 'insufficient_funds' | 'charge_pending' | null;
  failureReason?: string | null;
  customerActionExpiresAt?: string | null;
  paymentMethodType?: string | null;
  referenceNumber?: string | null;
  referenceType?: string | null;
};

export type E2eRefundResult = {
  refundId: string;
  orderId: string;
  status: string;
  newlyAccepted: boolean;
  newlyFailed: boolean;
  orderStatus: string;
  refundedAmount: number;
  rereserveShortage: number;
  emailEnqueued: boolean;
  exceptionId: string | null;
  /** 書いた Stripe の返金の番号 */
  stripeRefundId: string;
};

function toRefundResult(row: Record<string, unknown>, stripeRefundId: string): E2eRefundResult {
  return {
    refundId: row.refund_id as string,
    orderId: row.order_id as string,
    status: row.status as string,
    newlyAccepted: row.newly_accepted as boolean,
    newlyFailed: row.newly_failed as boolean,
    orderStatus: row.order_status as string,
    refundedAmount: Number(row.refunded_amount),
    rereserveShortage: Number(row.rereserve_shortage),
    emailEnqueued: row.email_enqueued as boolean,
    exceptionId: (row.exception_id as string | null) ?? null,
    stripeRefundId,
  };
}

/**
 * 返金の結果を書く DB の関数 record_order_refund_result（Stripe が返した値で状態を進め、在庫・メールの予定・要対応・注文の額と状態を
 * 1回で書く）。何も渡さなければ「カードで成功した返金」を書く。
 */
export async function recordRefundResult(
  db: PgClient,
  refundId: string,
  fields: E2eRefundResultFields = {},
): Promise<E2eRefundResult> {
  const stripeRefundId = fields.stripeRefundId ?? `re_e2e${uniqueSuffix()}`;
  const res = await db.query(
    `select * from public.record_order_refund_result(
       $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::timestamptz, $7::text, $8::text, $9::text)`,
    [
      refundId,
      stripeRefundId,
      fields.stripeStatus ?? 'succeeded',
      fields.pendingReason ?? null,
      fields.failureReason ?? null,
      fields.customerActionExpiresAt ?? null,
      fields.paymentMethodType === undefined ? 'card' : fields.paymentMethodType,
      fields.referenceNumber ?? null,
      fields.referenceType ?? null,
    ],
  );
  return toRefundResult(res.rows[0], stripeRefundId);
}

export type E2eExternalRefundResult = E2eRefundResult & { created: boolean; source: string };

/**
 * 印の無い返金（Stripe の画面からの返金）を記録する DB の関数 record_external_order_refund。
 * createdBeforeSwitch が true なら、切り替えの時刻（private.refund_ledger_state.started_at）の1時間前に作られた返金として渡す（写しになる）。
 */
export async function recordExternalRefund(
  db: PgClient,
  orderId: string,
  input: {
    amount: number;
    stripeRefundId?: string;
    stripeStatus?: E2eStripeStatus;
    paymentMethodType?: string | null;
    stripeReason?: string | null;
    createdBeforeSwitch?: boolean;
  },
): Promise<E2eExternalRefundResult> {
  const stripeRefundId = input.stripeRefundId ?? `re_e2e${uniqueSuffix()}`;
  const res = await db.query(
    `select * from public.record_external_order_refund(
       $1::uuid, $2::text, $3::integer, $4::text, null, null, null, $5::text, null, null, $6::text,
       case when $7::boolean
         then (select s.started_at - interval '1 hour' from private.refund_ledger_state as s)
         else pg_catalog.now()
       end)`,
    [
      orderId,
      stripeRefundId,
      input.amount,
      input.stripeStatus ?? 'succeeded',
      input.paymentMethodType === undefined ? 'card' : input.paymentMethodType,
      input.stripeReason ?? null,
      input.createdBeforeSwitch ?? false,
    ],
  );
  const row = res.rows[0];
  return { ...toRefundResult(row, stripeRefundId), created: row.created as boolean, source: row.source as string };
}

/** 返事待ちの返金をエラーにする DB の関数 mark_order_refund_error（Stripe の断り・見回りの時間切れ）。raiseException が true なら要対応も作る */
export async function markRefundError(
  db: PgClient,
  refundId: string,
  reason: string,
  raiseException = false,
): Promise<{ outcome: string; orderId: string; exceptionId: string | null }> {
  const res = await db.query('select * from public.mark_order_refund_error($1::uuid, $2::text, $3::boolean)', [
    refundId, reason, raiseException,
  ]);
  const row = res.rows[0];
  return {
    outcome: row.outcome as string,
    orderId: row.order_id as string,
    exceptionId: (row.exception_id as string | null) ?? null,
  };
}

export type E2eRefundRow = {
  id: string;
  source: string;
  status: string;
  amount: number;
  shipping_amount: number;
  adjustment_amount: number;
  stripe_refund_id: string | null;
  stripe_failure_reason: string | null;
  payment_method_type: string | null;
  notify_customer: boolean;
  request_key: string | null;
  actor_id: string | null;
  reference_number: string | null;
  stock_applied_at: Date | null;
  email_enqueued_at: Date | null;
  failure_applied_at: Date | null;
};

/** その注文の返金の記録を、作った順に読む */
export async function refundRows(db: PgClient, orderId: string): Promise<E2eRefundRow[]> {
  const res = await db.query(
    `select id, source, status, amount, shipping_amount, adjustment_amount, stripe_refund_id, stripe_failure_reason,
            payment_method_type, notify_customer, request_key, actor_id, reference_number,
            stock_applied_at, email_enqueued_at, failure_applied_at
     from public.order_refunds where order_id = $1 order by created_at, id`,
    [orderId],
  );
  return res.rows as E2eRefundRow[];
}

export type E2eRefundLineRow = {
  order_item_id: string;
  quantity: number;
  before_shipment: boolean;
  restock_type: string;
  amount: number;
  released_quantity: number;
  restocked_quantity: number;
  rereserved_quantity: number;
  rereserve_shortage: number;
};

/** 返金の商品の行を、発送前の行が先、商品の番号の順に読む */
export async function refundLineRows(db: PgClient, refundId: string): Promise<E2eRefundLineRow[]> {
  const res = await db.query(
    `select order_item_id, quantity, before_shipment, restock_type, amount,
            released_quantity, restocked_quantity, rereserved_quantity, rereserve_shortage
     from public.order_refund_lines where refund_id = $1 order by before_shipment desc, order_item_id`,
    [refundId],
  );
  return res.rows as E2eRefundLineRow[];
}

export type StockLedgerRow = { reason: string; delta: number; refund_id: string | null; order_item_id: string | null };

/** その注文で動いた在庫の台帳を、書いた順に読む（返金で動いた行は refund_id を持つ） */
export async function stockLedger(db: PgClient, orderId: string): Promise<StockLedgerRow[]> {
  const res = await db.query(
    'select reason, delta, refund_id, order_item_id from public.stock_movements where order_id = $1 order by id',
    [orderId],
  );
  return res.rows as StockLedgerRow[];
}

/** 色・サイズの、すぐ出せる数（stock）・引き当て済み（committed）・受注生産（backorder）。手元の数は stock + committed */
export async function variantStockState(
  db: PgClient,
  variantId: number,
): Promise<{ stock: number; committed: number; backorder: number }> {
  const stock = await db.query('select stock_quantity from public.item_variants where id = $1', [variantId]);
  const states = await db.query('select committed, backorder from public.list_variant_stock_states(array[$1::bigint])', [variantId]);
  return {
    stock: Number(stock.rows[0].stock_quantity),
    committed: Number(states.rows[0]?.committed ?? 0),
    backorder: Number(states.rows[0]?.backorder ?? 0),
  };
}

export type RefundOutboxRow = {
  variant: string | null;
  refund_id: string | null;
  origin: string;
  status: string;
  last_error_code: string | null;
};

/** 注文のメールの表の、その種類（refund・canceled など）の行を、書いた順に読む。返金の番号と書き分けも見る */
export async function refundOutboxRows(db: PgClient, orderId: string, kind: string): Promise<RefundOutboxRow[]> {
  const res = await db.query(
    `select variant, refund_id, origin, status, last_error_code
     from private.order_email_outbox where order_id = $1 and kind = $2 order by seq`,
    [orderId, kind],
  );
  return res.rows as RefundOutboxRow[];
}

/** 送信済みになった、その種類のメールの行の数。メールが着いてから行が送信済みになるまでの、わずかな差を待つために使う */
export async function sentOutboxCount(orderId: string, kind: string): Promise<number> {
  const rows = await withLocalDb((db) => refundOutboxRows(db, orderId, kind));
  return rows.filter((row) => row.status === 'sent').length;
}

/** 返金の画面の材料（load_order_refund_materials）の、返せる額 */
export async function refundableAmountOf(db: PgClient, orderId: string): Promise<number> {
  const res = await db.query('select refundable_amount from public.load_order_refund_materials($1::uuid)', [orderId]);
  return Number(res.rows[0].refundable_amount);
}

export type PaymentExceptionRow = {
  id: string;
  reason: string;
  detail: string | null;
  payment_ref: string;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
};

/** その注文の要対応を、見つけた順に読む */
export async function paymentExceptionsOf(db: PgClient, orderId: string): Promise<PaymentExceptionRow[]> {
  const res = await db.query(
    `select id, reason, detail, payment_ref, resolved_at, resolved_by, resolution_note
     from public.payment_exceptions where order_id = $1 order by first_detected_at, id`,
    [orderId],
  );
  return res.rows as PaymentExceptionRow[];
}
