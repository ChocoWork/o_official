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

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export async function withLocalDb<T>(fn: (db: PgClient) => Promise<T>): Promise<T> {
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB 以外では注文を作らない');
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    return await fn(client as unknown as PgClient);
  } finally {
    await client.end();
  }
}

export function uniqueEmail(label: string): string {
  return `e2e-order-email-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

/**
 * 入金済みの注文（在庫の明細1行）を、試験ごとの宛先で作る。
 * 商品は非公開にする。公開のままだと、同じ実行の中で並行して流れる他の購入 spec の seedCart が選ぶ
 * 「新しい順の最初の商品」が、この試験用の商品に入れ替わってしまう。
 */
export async function createPaidOrder(db: PgClient, email: string): Promise<string> {
  const fx = await createCatalogFixture(db, { stock: 1, itemStatus: 'private' });
  const { orderId } = await insertOrderWithStockLine(db, {
    status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true, shippingEmail: email,
  });
  return orderId;
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
  });
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
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { messages?: MailpitMessage[] };
  return body.messages ?? [];
}

// ---- ここから下がグループ E-1 で足した物 ----

export type MailBody = { Subject: string; Text: string };

/** その宛先へのメールを、本文つきで読む。件名に含む文字で絞れる（Mailpit は1通ごとに本文の API が別） */
export async function mailBodies(request: APIRequestContext, email: string, subjectIncludes = ''): Promise<MailBody[]> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  const found = (await mailsTo(request, email)).filter((message) => message.Subject.includes(subjectIncludes));
  const bodies: MailBody[] = [];
  for (const message of found) {
    const response = await request.get(new URL(`/api/v1/message/${encodeURIComponent(message.ID)}`, mailUrl).toString(), {
      timeout: 5_000,
    });
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as MailBody;
    bodies.push({ Subject: body.Subject, Text: body.Text });
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

export type E2eCreatedOrder = { orderId: string; orderItemIds: string[]; itemId: number; variantId: number };

/**
 * 明細を自由に決めた注文を作る。在庫の明細は台帳に確保（purchase）も入れ、受注生産の明細は台帳を動かさない
 * （注文を受け付ける DB の関数と同じ形）。配送先は後から書き換えられないので、発送できる形で最初から入れる。
 * 同じ色・サイズの在庫を複数の注文で使う時は、先の注文の itemId・variantId を catalog に渡す
 * （2件目からは在庫を足さないので、足りる数を最初の注文の在庫の明細で用意する）。
 * 商品は非公開にする（理由は createPaidOrder と同じ）。
 */
export async function createOrderWithLines(
  db: PgClient,
  email: string,
  lines: E2eOrderLine[],
  options: {
    status?: 'paid' | 'pending' | 'payment_in_progress' | 'cancelled';
    reviewReason?: 'stock_not_reserved';
    catalog?: { itemId: number; variantId: number };
  } = {},
): Promise<E2eCreatedOrder> {
  const stockQuantity = lines
    .filter((line) => line.fulfillmentType === 'stock')
    .reduce((sum, line) => sum + line.quantity, 0);
  const catalog = options.catalog ?? (await createCatalogFixture(db, { stock: stockQuantity, itemStatus: 'private' }));
  const suffix = uniqueSuffix();
  const subtotal = lines.reduce((sum, line) => sum + PRICE * line.quantity, 0);
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status, review_reason,
        subtotal_amount, shipping_amount, total_amount, currency,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone)
     values ($1, $2, null, $3::public.order_status, $4,
             $5, 0, $5, 'jpy',
             $6, '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222')
     returning id`,
    [`e2e-lines-${suffix}`, `cs_e2e_${suffix}`, options.status ?? 'paid', options.reviewReason ?? null, subtotal, email],
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
    if (line.fulfillmentType === 'stock') {
      await db.query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
         values ($1, $2, 'purchase', $3, $4)`,
        [catalog.variantId, -line.quantity, orderId, orderItemId],
      );
    }
  }
  return { orderId, orderItemIds, itemId: catalog.itemId, variantId: catalog.variantId };
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

/** 発送の DB の関数 admin_create_fulfillment。管理画面の発送の画面の代わりに、同じ関数を直に呼ぶ */
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
  },
): Promise<E2eFulfillment> {
  const res = await db.query(
    `select * from public.admin_create_fulfillment(
       $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::boolean, $7::jsonb)`,
    [
      orderId, actorId, input.requestKey ?? randomUUID(), input.carrier ?? 'yamato',
      input.trackingNumber, input.notify ?? true, dbLines(input.lines),
    ],
  );
  const row = res.rows[0];
  return {
    fulfillmentId: row.fulfillment_id as string,
    number: Number(row.number),
    completesOrder: row.completes_order as boolean,
    orderStatus: row.order_status as string,
    replayed: row.replayed as boolean,
  };
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
  inProduction: number;
  readyUnshipped: number;
  unshipped: number;
};

/** 商品ごとの数（画面も窓口も同じ数え方を使う公開の関数）。キーは注文の明細の番号 */
export async function lineCounts(db: PgClient, orderId: string): Promise<Record<string, E2eLineCounts>> {
  const res = await db.query('select * from public.list_order_line_fulfillment(array[$1::uuid])', [orderId]);
  const counts: Record<string, E2eLineCounts> = {};
  for (const row of res.rows) {
    counts[row.order_item_id as string] = {
      quantity: Number(row.quantity),
      shipped: Number(row.shipped),
      completed: Number(row.completed),
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
