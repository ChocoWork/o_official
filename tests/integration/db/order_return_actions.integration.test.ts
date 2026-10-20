/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import {
  createCatalogFixture,
  insertOrderWithLines,
  insertRefundRecord,
  PRICE,
  uniqueSuffix,
  variantStock,
} from './helpers/order-fixtures';

/**
 * 返品の操作の関数・読み出しの関数・返品の設定の関数・返品のメールの予定の関数・発送の取消の守り（グループ E-3 設計書 3〜9 章、移行 B）。
 * 受け取りの関数（移行 C）はまだ無いので、受け取りの記録（検品待ち・戻した・お返し・返金待ちの品）は、試験の中で直接書く
 * （返品の行は作った後に変えない。受け取りの行には、その受け取りで実際に決まった解決を resolution に残す）。
 * 1件ごとに取引の中で動かし、終わったら戻す。
 * 返品を作る操作と発送の取消の同時の操作だけは2つの接続が要るので、別の describe で確定した行を使う（消せない注文が手元の DB に残る）。
 */
jest.setTimeout(60000);

type Row = Record<string, any>;

async function createActor(db: PgClient): Promise<{ id: string; email: string }> {
  const email = `return-actions-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

type OrderSpec = {
  lines: Array<{ quantity: number; price?: number }>;
  /** 発送の分け方。発送ごとに { 行の番号: 数 }。省くと全部を1回で発送する */
  shipments?: Array<Record<number, number>>;
  shippingAmount?: number;
  discountAmount?: number;
};

type ShippedOrder = {
  orderId: string;
  /** 注文の商品（order_items.id）。spec.lines と同じ並び */
  itemIds: string[];
  /** 商品（items.id）。spec.lines と同じ並び */
  catalogItemIds: number[];
  /** 色・サイズ（item_variants.id）。spec.lines と同じ並び */
  variantIds: number[];
  /** 発送（order_fulfillments.id）。spec.shipments と同じ並び */
  fulfillmentIds: string[];
  /** 発送した人（返品の操作もこの人が行う） */
  actorId: string;
  actorEmail: string;
};

/**
 * 在庫の品だけの支払い済みの注文を直接作り、いつもの発送の関数で発送する（受け取った額は合計と同じ）。
 * 割引の割り振りは登録順で決まる。同じ取引の中では created_at が同じになるので、明細ごとに1秒ずつずらして固定する
 */
async function createShippedOrder(db: PgClient, spec: OrderSpec): Promise<ShippedOrder> {
  const actor = await createActor(db);
  const catalogs: Array<{ itemId: number; variantId: number }> = [];
  for (const orderLine of spec.lines) {
    catalogs.push(await createCatalogFixture(db, { stock: orderLine.quantity }));
  }
  const base = Date.now();
  const shippingAmount = spec.shippingAmount ?? 0;
  const discountAmount = spec.discountAmount ?? 0;
  const subtotal = spec.lines.reduce((sum, orderLine) => sum + (orderLine.price ?? PRICE) * orderLine.quantity, 0);
  const { orderId, orderItemIds } = await insertOrderWithLines(db, {
    status: 'paid',
    lines: spec.lines.map((orderLine, index) => ({
      itemId: catalogs[index].itemId,
      variantId: catalogs[index].variantId,
      quantity: orderLine.quantity,
      fulfillmentType: 'stock' as const,
      itemPrice: orderLine.price ?? PRICE,
      createdAt: new Date(base + index * 1000).toISOString(),
    })),
    shippingAmount,
    discountAmount,
    paidAmount: subtotal + shippingAmount - discountAmount,
  });
  const shipments = spec.shipments ?? [Object.fromEntries(spec.lines.map((orderLine, index) => [index, orderLine.quantity]))];
  const fulfillmentIds: string[] = [];
  for (const shipment of shipments) {
    const res = await db.query('select * from public.admin_create_fulfillment($1, $2, $3, $4, $5, $6, $7::jsonb)', [
      orderId,
      actor.id,
      crypto.randomUUID(),
      'yamato',
      '1234-5678-9012',
      false,
      JSON.stringify(Object.entries(shipment).map(([index, quantity]) => ({ order_item_id: orderItemIds[Number(index)], quantity }))),
    ]);
    fulfillmentIds.push(res.rows[0].fulfillment_id as string);
  }
  return {
    orderId,
    itemIds: orderItemIds,
    catalogItemIds: catalogs.map((catalog) => catalog.itemId),
    variantIds: catalogs.map((catalog) => catalog.variantId),
    fulfillmentIds,
    actorId: actor.id,
    actorEmail: actor.email,
  };
}

/** 同じ商品の別の色・サイズ（交換の色・サイズの候補）を足す。在庫は台帳の restock で入れる */
async function addVariant(
  db: PgClient,
  itemId: number,
  options: { color: string; size: string; stock?: number; active?: boolean },
): Promise<number> {
  const color = await db.query(
    "insert into public.item_colors (item_id, name, hex, position) values ($1, $2, '#ffffff', 1) returning id",
    [itemId, options.color],
  );
  const size = await db.query('insert into public.item_sizes (item_id, label, position) values ($1, $2, 1) returning id', [
    itemId,
    options.size,
  ]);
  const variant = await db.query(
    'insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, $4) returning id',
    [itemId, color.rows[0].id, size.rows[0].id, options.active ?? true],
  );
  const variantId = Number(variant.rows[0].id);
  if ((options.stock ?? 0) > 0) {
    await db.query("insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'restock', 'fixture')", [
      variantId,
      options.stock,
    ]);
  }
  return variantId;
}

/** 返品の行の入力（既定は、1つ目の発送の、破損・不良の返金） */
function line(order: ShippedOrder, itemIndex: number, quantity: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fulfillment_id: order.fulfillmentIds[0],
    order_item_id: order.itemIds[itemIndex],
    quantity,
    reason: 'defective',
    reason_note: null,
    resolution: 'refund',
    exchange_variant_id: null,
    exchange_method: null,
    ...extra,
  };
}

type CreateInput = {
  actorId?: string | null;
  /** 省くと新しい番号。null なら SQL の NULL */
  requestKey?: string | null;
  lines?: unknown;
  method?: string | null;
  payer?: string | null;
  carrier?: string | null;
  tracking?: string | null;
  shippingFee?: number | null;
  restockingPercent?: number | null;
  exchangeFee?: number | null;
  exchangeShippingFee?: number | null;
  shopNote?: string | null;
  notify?: boolean | null;
};

const CREATE_SQL = 'select * from public.admin_create_return($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)';

/** 省いた引数は、お客様が送る・お客様の負担・手数料は設定どおり・知らせるの普通の呼び方になる。null を渡すと SQL の NULL を渡す */
function createParams(orderId: string | null, input: CreateInput): unknown[] {
  return [
    orderId,
    input.actorId === undefined ? null : input.actorId,
    input.requestKey === undefined ? crypto.randomUUID() : input.requestKey,
    JSON.stringify(input.lines === undefined ? [] : input.lines),
    input.method === undefined ? 'customer_ships' : input.method,
    input.payer === undefined ? 'customer' : input.payer,
    input.carrier === undefined ? null : input.carrier,
    input.tracking === undefined ? null : input.tracking,
    input.shippingFee === undefined ? null : input.shippingFee,
    input.restockingPercent === undefined ? null : input.restockingPercent,
    input.exchangeFee === undefined ? null : input.exchangeFee,
    input.exchangeShippingFee === undefined ? null : input.exchangeShippingFee,
    input.shopNote === undefined ? null : input.shopNote,
    input.notify === undefined ? true : input.notify,
  ];
}

function createReturn(db: PgClient, orderId: string | null, input: CreateInput) {
  return db.query(CREATE_SQL, createParams(orderId, input));
}

/** 返品を作って、返品の番号を返す */
async function openReturn(db: PgClient, order: ShippedOrder, lines: unknown[], extra: CreateInput = {}): Promise<string> {
  const res = await createReturn(db, order.orderId, { actorId: order.actorId, lines, ...extra });
  return res.rows[0].return_id as string;
}

function cancelReturn(db: PgClient, returnId: string | null, actorId: string | null) {
  return db.query('select * from public.admin_cancel_return($1, $2)', [returnId, actorId]);
}

function closeMissing(db: PgClient, returnId: string | null, actorId: string | null, requestKey: string | null = crypto.randomUUID()) {
  return db.query('select * from public.admin_close_return_missing($1, $2, $3)', [returnId, actorId, requestKey]);
}

function reopenReturn(db: PgClient, returnId: string | null, actorId: string | null, requestKey: string | null = crypto.randomUUID()) {
  return db.query('select * from public.admin_reopen_return($1, $2, $3)', [returnId, actorId, requestKey]);
}

function inspectReturn(
  db: PgClient,
  returnId: string | null,
  actorId: string | null,
  lines: unknown,
  requestKey: string | null = crypto.randomUUID(),
) {
  return db.query('select * from public.admin_inspect_return($1, $2, $3, $4::jsonb)', [returnId, actorId, requestKey, JSON.stringify(lines)]);
}

/** waive が真なら「いただかないで終える」（本計画 P27）。省くと偽（受け取りの記録）。null を渡すと SQL の NULL を渡す */
function recordFeePayment(
  db: PgClient,
  returnId: string | null,
  actorId: string | null,
  note: string | null = null,
  waive: boolean | null = false,
) {
  return db.query('select * from public.admin_record_return_fee_payment($1, $2, $3, $4)', [returnId, actorId, note, waive]);
}

function releaseExchange(db: PgClient, returnId: string | null, actorId: string | null) {
  return db.query('select * from public.admin_release_return_exchange($1, $2)', [returnId, actorId]);
}

function cancelFulfillment(db: PgClient, orderId: string, fulfillmentId: string, actorId: string) {
  return db.query('select * from public.admin_cancel_fulfillment($1, $2, $3)', [orderId, fulfillmentId, actorId]);
}

/** ふつうの返金（E-2）を返事待ちで始める。発送後の商品を1つ返す（restock なし・送料なし） */
function beginOrdinaryRefund(db: PgClient, order: ShippedOrder, itemIndex: number, quantity: number, amount: number) {
  return db.query('select * from public.begin_order_refund($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)', [
    order.orderId,
    'admin',
    crypto.randomUUID(),
    JSON.stringify([{ order_item_id: order.itemIds[itemIndex], quantity, before_shipment: false }]),
    false,
    0,
    amount,
    null,
    'requested_by_customer',
    null,
    false,
    order.actorId,
    null,
  ]);
}

/** 返送先を入れる（空の間は返品を作れない）。戻す時は updateSettingsRow で4つとも null にする */
async function setReturnAddress(db: PgClient): Promise<void> {
  await updateSettingsRow(db, {
    return_address_name: '店舗',
    return_address_postal_code: '150-0001',
    return_address_line: '東京都渋谷区神宮前1-1-1',
    return_address_phone: '03-1111-2222',
  });
}

/** 返品の設定の行を直接書く（関数を通さずに、試験が欲しい設定を作る。最後に変えた人は書かない） */
async function updateSettingsRow(db: PgClient, values: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(values);
  const assignments = entries.map(([column], index) => `${column} = $${index + 1}`).join(', ');
  await db.query(`update public.shop_return_settings set ${assignments} where id = 1`, entries.map(([, value]) => value));
}

async function returnRow(db: PgClient, returnId: string): Promise<Row> {
  const res = await db.query('select * from public.order_returns where id = $1', [returnId]);
  return res.rows[0];
}

async function returnLineRows(db: PgClient, returnId: string): Promise<Row[]> {
  const res = await db.query('select * from public.order_return_lines where return_id = $1 order by order_item_id, resolution, id', [returnId]);
  return res.rows;
}

/** 返品の行の番号。同じ商品に返金と交換の2行がある時は resolution で見分ける */
async function lineIdOf(db: PgClient, returnId: string, orderItemId: string, resolution = 'refund'): Promise<string> {
  const res = await db.query(
    'select id from public.order_return_lines where return_id = $1 and order_item_id = $2 and resolution = $3 order by id limit 1',
    [returnId, orderItemId, resolution],
  );
  return res.rows[0].id as string;
}

async function receiptRows(db: PgClient, returnId: string): Promise<Row[]> {
  const res = await db.query('select * from public.order_return_receipts where return_id = $1 order by created_at, id', [returnId]);
  return res.rows;
}

async function receiptLineRows(db: PgClient, receiptId: string): Promise<Row[]> {
  const res = await db.query(
    `select return_line_id, disposition, quantity, resolution, exchange_method
     from public.order_return_receipt_lines where receipt_id = $1 order by disposition, return_line_id`,
    [receiptId],
  );
  return res.rows;
}

/** 返品のメールの予定（4つの種類）を古い順に */
async function outboxRows(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query(
    `select kind, variant, origin, status, return_id, return_receipt_id
     from private.order_email_outbox
     where order_id = $1
       and kind in ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop')
     order by seq`,
    [orderId],
  );
  return res.rows;
}

async function countsOf(db: PgClient, orderId: string): Promise<Record<string, Row>> {
  const res = await db.query('select * from private.order_line_return_counts($1)', [orderId]);
  return Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row]));
}

async function fulfillmentReturnable(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query('select * from private.fulfillment_line_returnable($1) order by fulfillment_number, order_item_id', [orderId]);
  return res.rows;
}

async function progressOf(db: PgClient, returnId: string): Promise<Record<string, Row>> {
  const res = await db.query('select * from private.order_return_line_progress($1)', [returnId]);
  return Object.fromEntries(res.rows.map((row) => [row.return_line_id as string, row]));
}

async function displayStateOf(db: PgClient, returnId: string): Promise<Row> {
  const res = await db.query('select * from private.return_display_state($1)', [returnId]);
  return res.rows[0];
}

type ReceiptLineInput = {
  returnLineId: string;
  disposition:
    | 'restocked'
    | 'not_restocked'
    | 'pending_inspection'
    | 'inspected_restocked'
    | 'inspected_not_restocked'
    | 'sent_back'
    | 'missing'
    | 'missing_reopened'
    | 'refund_waived';
  quantity: number;
  /** 受け取りの行（restocked・not_restocked・pending_inspection）の実際の解決。省くと返品の行の予定 */
  resolution?: 'refund' | 'exchange';
  /** 解決が交換の時の送り方。省くと返品の行の予定 */
  exchangeMethod?: 'stock' | 'make';
};

/**
 * 受け取りの記録を直接書く（受け取りの関数は移行 C）。受け取りの行（restocked・not_restocked・pending_inspection）は
 * 実際の解決を必ず持ち、ほかの行（検品・お返し・届かない・開き直し・返金しない）は持たない。
 * minutesAgo は記録の時刻をずらす（同じ取引の中では時刻が同じになるので、並びを試す時だけ使う）
 */
async function insertReceipt(
  db: PgClient,
  returnId: string,
  options: {
    kind?: 'receive' | 'inspect' | 'close_missing' | 'reopen' | 'waive_refund';
    refundChoice?: 'now' | 'consult' | 'none';
    actorId?: string | null;
    minutesAgo?: number;
    lines: ReceiptLineInput[];
  },
): Promise<string> {
  const kind = options.kind ?? 'receive';
  const receipt = await db.query(
    `insert into public.order_return_receipts
       (return_id, request_key, request_fingerprint, kind, refund_choice, notify_customer, actor_id, created_at)
     values ($1, gen_random_uuid(), 'fixture', $2, $3, false, $4, now() - make_interval(mins => $5::int))
     returning id`,
    [returnId, kind, kind === 'receive' ? (options.refundChoice ?? 'none') : null, options.actorId ?? null, options.minutesAgo ?? 0],
  );
  const receiptId = receipt.rows[0].id as string;
  for (const entry of options.lines) {
    const received = ['restocked', 'not_restocked', 'pending_inspection'].includes(entry.disposition);
    const plan = await db.query('select resolution, exchange_method from public.order_return_lines where id = $1', [entry.returnLineId]);
    const resolution = received ? (entry.resolution ?? (plan.rows[0].resolution as string)) : null;
    const exchangeMethod = resolution === 'exchange' ? (entry.exchangeMethod ?? (plan.rows[0].exchange_method as string)) : null;
    await db.query(
      `insert into public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity, resolution, exchange_method)
       values ($1, $2, $3, $4, $5, $6)`,
      [receiptId, entry.returnLineId, entry.disposition, entry.quantity, resolution, exchangeMethod],
    );
  }
  return receiptId;
}

/** 交換の品の行（受け取りの関数が足す物）を直接足す。値段は0、元の品1点の支払額を持つ */
async function insertExchangeItem(
  db: PgClient,
  order: ShippedOrder,
  itemIndex: number,
  returnLineId: string,
  variantId: number,
): Promise<string> {
  const res = await db.query(
    `insert into public.order_items
       (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type,
        line_kind, exchange_return_line_id, exchange_paid_amount)
     values ($1, $2, '交換テスト', 0, 'WHITE', 'L', 1, 0, $3, 'stock', 'exchange', $4, $5)
     returning id`,
    [order.orderId, order.catalogItemIds[itemIndex], variantId, returnLineId, PRICE],
  );
  return res.rows[0].id as string;
}

/**
 * お客様の申し込みの返品（返品の申し込み・お断り。段2の形）を直接書く。お客様の申し込みとお断りの関数は段2なので、段1では記録だけを書く。
 * 返品の行は、1つ目の発送の商品を返金で指す
 */
async function insertCustomerReturn(
  db: PgClient,
  order: ShippedOrder,
  status: 'requested' | 'declined',
  quantity = 1,
): Promise<string> {
  const created = await db.query(
    `insert into public.order_returns
       (order_id, number, source, status, request_key, request_fingerprint, requested_at, declined_at, decline_reason,
        return_method, return_shipping_payer, notify_customer)
     values ($1, 1, 'customer_request', $2::text, gen_random_uuid(), 'fixture', now(),
             case when $2::text = 'declined' then now() end,
             case when $2::text = 'declined' then 'other' end,
             'customer_ships', 'customer', true)
     returning id`,
    [order.orderId, status],
  );
  const returnId = created.rows[0].id as string;
  await db.query(
    `insert into public.order_return_lines (return_id, fulfillment_id, order_item_id, quantity, reason, resolution)
     values ($1, $2, $3, $4, 'defective', 'refund')`,
    [returnId, order.fulfillmentIds[0], order.itemIds[0], quantity],
  );
  return returnId;
}

/**
 * 返品の返金の記録（source = return）と、発送後の商品の行を直接書く。返金の関数（移行 C）が作る形。
 * Task 1 が order-fixtures.ts に足す `insertReturnRefund` とは別の道具（名前を重ねない）: ここでは注文を ShippedOrder で、商品を itemIndex で指す
 */
async function insertReturnRefundRow(
  db: PgClient,
  order: ShippedOrder,
  returnId: string,
  options: { itemIndex: number; quantity: number; amount: number; status: 'awaiting_response' | 'pending' | 'succeeded' | 'failed' },
): Promise<string> {
  const refund = await db.query(
    `insert into public.order_refunds
       (order_id, source, request_key, request_fingerprint, status, amount, shipping_amount, notify_customer, return_id)
     values ($1, 'return', gen_random_uuid(), 'fixture', $2, $3, 0, false, $4)
     returning id`,
    [order.orderId, options.status, options.amount, returnId],
  );
  const refundId = refund.rows[0].id as string;
  await db.query(
    `insert into public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
     values ($1, $2, $3, false, 'return', $4)`,
    [refundId, order.itemIds[options.itemIndex], options.quantity, options.amount],
  );
  return refundId;
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

/** 失敗した文の SQLSTATE と言葉を返す（成功したら null）。入力ごとの断りを、どの入力が外れたかの名前つきで見せるために使う */
async function rejectionOf(db: PgClient, sql: string, params: unknown[]): Promise<{ code: string; message: string } | null> {
  await db.query('savepoint rejection_of');
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    const { code, message } = error as { code: string; message: string };
    return { code, message };
  } finally {
    await db.query('rollback to savepoint rejection_of');
  }
}

/** 別の接続が鍵を待つまで待つ（最大5秒）。pg_blocking_pids は取引の写しではなく今の鍵を見る */
async function waitUntilBlocked(db: PgClient, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await db.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [pid]);
    if (res.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('別の接続が注文の行の鍵を待たなかった');
}

/** オブジェクトのキーを並べ替えて返す。jsonb のキーの一覧を、計画の冒頭の C-2 の型のキーと突き合わせるために使う */
function keysOf(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

function sorted(keys: string[]): string[] {
  return [...keys].sort();
}

const INVALID_ARGUMENT = { code: '22023', message: 'RETURN_ARGUMENT_INVALID' };

async function materialsOf(db: PgClient, orderId: string): Promise<Row | null> {
  const res = await db.query('select public.get_order_return_materials($1) as materials', [orderId]);
  return res.rows[0].materials as Row | null;
}

async function listReturns(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query('select public.list_order_returns($1) as returns', [orderId]);
  return res.rows[0].returns as Row[];
}

async function summariesOf(db: PgClient, orderIds: string[]): Promise<Record<string, Row>> {
  const res = await db.query('select * from public.list_order_return_summaries($1::uuid[])', [orderIds]);
  return Object.fromEntries(res.rows.map((row) => [row.order_id as string, row]));
}

async function attentionOf(db: PgClient): Promise<{ requested: number; refund_waiting: number }> {
  const res = await db.query('select * from public.count_order_return_attention()');
  return res.rows[0];
}

async function orderIdsByStatus(db: PgClient, displayStatus: string): Promise<string[]> {
  const res = await db.query('select * from public.list_order_ids_by_return_status($1)', [displayStatus]);
  return res.rows.map((row) => row.order_id as string);
}

/**
 * 完了した返品の返金が失敗した後の形（本計画 P21）を作る。受け取った1点を返品の返金が覆って返品が完了し、
 * その後に返金が失敗して覆いが外れ、完了のまま返金待ちの品（rw = 1）が戻る
 */
async function createFailedRefundReturn(db: PgClient): Promise<{ order: ShippedOrder; returnId: string; refundId: string }> {
  const order = await createShippedOrder(db, { lines: [{ quantity: 1 }] });
  const returnId = await openReturn(db, order, [line(order, 0, 1)]);
  await insertReceipt(db, returnId, {
    lines: [{ returnLineId: await lineIdOf(db, returnId, order.itemIds[0]), disposition: 'restocked', quantity: 1 }],
  });
  const refundId = await insertReturnRefundRow(db, order, returnId, { itemIndex: 0, quantity: 1, amount: PRICE, status: 'pending' });
  const closed = await db.query('select private.refresh_order_return_status($1) as status', [returnId]);
  expect(closed.rows[0].status).toBe('closed');
  await db.query("update public.order_refunds set status = 'failed', failed_at = now() where id = $1", [refundId]);
  return { order, returnId, refundId };
}

/**
 * 返品の状態の見せ方の場面を、注文ごとに作る（一覧の要約・一行の数・絞り込みの試験が共有する）。
 * 受け取りの関数（移行 C）は無いので、受け取りの記録と返金の記録は直接書く。
 */
async function buildReturnScenario(db: PgClient): Promise<{
  orders: Record<string, ShippedOrder>;
  unshipped: string;
}> {
  const orders: Record<string, ShippedOrder> = {};

  // 返品が無い
  orders.none = await createShippedOrder(db, { lines: [{ quantity: 1 }] });

  // 受付中で、何も届いていない
  orders.awaitingItems = await createShippedOrder(db, { lines: [{ quantity: 1 }] });
  await openReturn(db, orders.awaitingItems, [line(orders.awaitingItems, 0, 1)]);

  // 2点のうち1点を受け取った（もう1点は未処理）。受け取った1点は返金待ち
  orders.partial = await createShippedOrder(db, { lines: [{ quantity: 2 }] });
  const partialReturn = await openReturn(db, orders.partial, [line(orders.partial, 0, 2)]);
  await insertReceipt(db, partialReturn, {
    lines: [{ returnLineId: await lineIdOf(db, partialReturn, orders.partial.itemIds[0]), disposition: 'restocked', quantity: 1 }],
  });

  // 全部受け取って、返金待ち（同じ注文に返金待ちの返品が2つ）
  orders.refundWaiting = await createShippedOrder(db, { lines: [{ quantity: 2 }] });
  for (let index = 0; index < 2; index += 1) {
    const waitingReturn = await openReturn(db, orders.refundWaiting, [line(orders.refundWaiting, 0, 1)]);
    await insertReceipt(db, waitingReturn, {
      lines: [{ returnLineId: await lineIdOf(db, waitingReturn, orders.refundWaiting.itemIds[0]), disposition: 'restocked', quantity: 1 }],
    });
  }

  // 交換の品を検品待ち（返金の品が無いので返金待ちにならない）
  orders.inspection = await createShippedOrder(db, { lines: [{ quantity: 1 }] });
  const variantW = await addVariant(db, orders.inspection.catalogItemIds[0], { color: 'WHITE', size: 'L', stock: 2 });
  const inspectionReturn = await openReturn(db, orders.inspection, [
    line(orders.inspection, 0, 1, { resolution: 'exchange', exchange_variant_id: variantW, exchange_method: 'stock', reason: 'size_too_small' }),
  ]);
  await insertReceipt(db, inspectionReturn, {
    lines: [
      {
        returnLineId: await lineIdOf(db, inspectionReturn, orders.inspection.itemIds[0], 'exchange'),
        disposition: 'pending_inspection',
        quantity: 1,
      },
    ],
  });

  // 届かないで終えて、完了
  orders.returned = await createShippedOrder(db, { lines: [{ quantity: 1 }] });
  const returnedReturn = await openReturn(db, orders.returned, [line(orders.returned, 0, 1)]);
  await closeMissing(db, returnedReturn, orders.returned.actorId);

  // 取消
  orders.cancelled = await createShippedOrder(db, { lines: [{ quantity: 1 }] });
  await cancelReturn(db, await openReturn(db, orders.cancelled, [line(orders.cancelled, 0, 1)]), orders.cancelled.actorId);

  // 手数料のお支払い待ち（届かないで終えても、受付中のまま）
  orders.feeDue = await createShippedOrder(db, { lines: [{ quantity: 1 }] });
  const feeReturn = await openReturn(db, orders.feeDue, [line(orders.feeDue, 0, 1)]);
  await db.query('update public.order_returns set fee_due_amount = 300 where id = $1', [feeReturn]);
  await closeMissing(db, feeReturn, orders.feeDue.actorId);

  // 返品が2つ: 1つ目は届かないで完了、2つ目は受付中で何も届いていない
  orders.twoReturns = await createShippedOrder(db, { lines: [{ quantity: 2 }] });
  await closeMissing(db, await openReturn(db, orders.twoReturns, [line(orders.twoReturns, 0, 1)]), orders.twoReturns.actorId);
  await openReturn(db, orders.twoReturns, [line(orders.twoReturns, 0, 1)]);

  // 返品の申し込み（段2の形。お客様の申し込みは段1では作らないので、記録を直接書く）
  orders.requested = await createShippedOrder(db, { lines: [{ quantity: 2 }] });
  await insertCustomerReturn(db, orders.requested, 'requested');

  // 完了した返品の返金が失敗した後（P21）
  orders.failedRefund = (await createFailedRefundReturn(db)).order;

  // まだ発送していない注文
  const fx = await createCatalogFixture(db, { stock: 1 });
  const unshipped = await insertOrderWithLines(db, {
    status: 'pending',
    lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 1, fulfillmentType: 'stock' }],
  });

  return { orders, unshipped: unshipped.orderId };
}

describeLocalDb('integration: 返品の操作・読み出し・設定の関数（移行 B）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    // 返送先が空の間は返品を作れない。ほとんどの試験は返送先がある前提なので、先に入れる
    await setReturnAddress(db());
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('返品を作る（admin_create_return）', () => {
    test('発送した品を返金で返品に作ると、受付中の返品・返品の行・受付のお知らせの予定が1つずつでき、返品中の数に数えられる', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const key = crypto.randomUUID();

      const res = await createReturn(db(), order.orderId, {
        actorId: order.actorId,
        requestKey: key,
        lines: [line(order, 0, 1, { reason: 'size_too_small' })],
        shopNote: '電話でいただいた連絡',
      });

      expect(res.rows).toEqual([{ return_id: expect.any(String), number: 1, status: 'open', replayed: false }]);
      const returnId = res.rows[0].return_id as string;
      const created = await returnRow(db(), returnId);
      expect(created).toMatchObject({
        order_id: order.orderId,
        number: 1,
        source: 'shop',
        status: 'open',
        request_key: key,
        return_method: 'customer_ships',
        return_shipping_payer: 'customer',
        return_carrier: null,
        return_tracking_number: null,
        return_shipping_fee: 0,
        restocking_fee_percent: 0,
        exchange_fee: 0,
        exchange_shipping_fee: 0,
        fee_due_amount: 0,
        fee_pending_deduction: 0,
        notify_customer: true,
        shop_note: '電話でいただいた連絡',
        approved_by: order.actorId,
        created_by: order.actorId,
        closed_at: null,
        cancelled_at: null,
      });
      expect(created.approved_at).not.toBeNull();
      expect(created.request_fingerprint).toMatch(/^[0-9a-f]{32}$/);

      expect(await returnLineRows(db(), returnId)).toEqual([
        expect.objectContaining({
          fulfillment_id: order.fulfillmentIds[0],
          order_item_id: order.itemIds[0],
          quantity: 1,
          reason: 'size_too_small',
          reason_note: null,
          resolution: 'refund',
          exchange_variant_id: null,
          exchange_method: null,
        }),
      ]);
      // 受付のお知らせの予定が1行。返品の番号が付き、受け取りの番号は空
      expect(await outboxRows(db(), order.orderId)).toEqual([
        { kind: 'return_accepted', variant: null, origin: 'auto', status: 'pending', return_id: returnId, return_receipt_id: null },
      ]);
      // 返品中の品は、返品できる数にも、ふつうの返金の画面で選べる発送済みの数にも残らない（Review Focus 4）
      expect((await countsOf(db(), order.orderId))[order.itemIds[0]]).toMatchObject({
        shipped: 2,
        open_unprocessed: 1,
        returnable: 1,
        refundable_after_shipment: 1,
      });
      expect((await fulfillmentReturnable(db(), order.orderId))[0]).toMatchObject({ quantity: 2, in_returns: 1, returnable: 1 });
    });

    test('お客様に知らせないなら、受付のお知らせの予定は書かない', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });

      const res = await createReturn(db(), order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1)], notify: false });

      expect((await returnRow(db(), res.rows[0].return_id)).notify_customer).toBe(false);
      expect(await outboxRows(db(), order.orderId)).toEqual([]);
    });

    test('番号は注文ごとに1から数え、取り消した返品の番号も飛ばさない。返品ごとに受付のお知らせの予定が1行ずつできる', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      const other = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });

      const first = await createReturn(db(), order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1)] });
      await cancelReturn(db(), first.rows[0].return_id, order.actorId);
      const second = await createReturn(db(), order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1)] });
      const otherFirst = await createReturn(db(), other.orderId, { actorId: other.actorId, lines: [line(other, 0, 1)] });

      expect([first.rows[0].number, second.rows[0].number, otherFirst.rows[0].number]).toEqual([1, 2, 1]);
      // 同じ注文の2つ目の返品も、受付のお知らせの予定が書ける（注文ごとに1行の索引に当たらない）
      const mails = await outboxRows(db(), order.orderId);
      expect(mails.map((mail) => mail.return_id)).toEqual([first.rows[0].return_id, second.rows[0].return_id]);
    });

    test('同じ番号で同じ中身を送り直すと、前の返品を返し、記録も受付のお知らせの予定も増えない。行の並びだけが違っても同じ中身', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }, { quantity: 1 }] });
      const key = crypto.randomUUID();
      const lines = [line(order, 0, 1), line(order, 1, 1, { reason: 'wrong_item' })];

      const first = await createReturn(db(), order.orderId, { actorId: order.actorId, requestKey: key, lines });
      const again = await createReturn(db(), order.orderId, { actorId: order.actorId, requestKey: key, lines: [...lines].reverse() });

      expect(again.rows).toEqual([{ return_id: first.rows[0].return_id, number: 1, status: 'open', replayed: true }]);
      const counts = await db().query(
        `select (select count(*)::int from public.order_returns where order_id = $1) as returns,
                (select count(*)::int from public.order_return_lines where return_id = $2) as lines`,
        [order.orderId, first.rows[0].return_id],
      );
      expect(counts.rows[0]).toEqual({ returns: 1, lines: 2 });
      expect(await outboxRows(db(), order.orderId)).toHaveLength(1);
    });

    test('送り直しは、作った後に返品を取り消していても、前の記録をそのまま返す（状態は今の値。受付のお知らせも増えない）', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      const key = crypto.randomUUID();
      const first = await createReturn(db(), order.orderId, { actorId: order.actorId, requestKey: key, lines: [line(order, 0, 1)] });
      await cancelReturn(db(), first.rows[0].return_id, order.actorId);

      // 取り消した後は、品がまた返品できる数に戻っているが、同じ番号の送り直しは確かめ直さず前の記録を返す
      const again = await createReturn(db(), order.orderId, { actorId: order.actorId, requestKey: key, lines: [line(order, 0, 1)] });

      expect(again.rows).toEqual([{ return_id: first.rows[0].return_id, number: 1, status: 'cancelled', replayed: true }]);
      expect(await outboxRows(db(), order.orderId)).toHaveLength(1);
    });

    test('同じ番号で違う中身（数・メモ・送り方・知らせ・ほかの注文）が来たら RETURN_REQUEST_MISMATCH で断り、記録は増えない', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      const other = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      const key = crypto.randomUUID();
      await createReturn(db(), order.orderId, { actorId: order.actorId, requestKey: key, lines: [line(order, 0, 1)] });

      const variants: Array<[string, string, CreateInput]> = [
        ['数', order.orderId, { lines: [line(order, 0, 2)] }],
        ['メモ', order.orderId, { lines: [line(order, 0, 1)], shopNote: '違うメモ' }],
        ['送り方', order.orderId, { lines: [line(order, 0, 1)], method: 'shop_label' }],
        ['知らせ', order.orderId, { lines: [line(order, 0, 1)], notify: false }],
        ['ほかの注文', other.orderId, { lines: [line(other, 0, 1)] }],
      ];
      for (const [label, orderId, input] of variants) {
        const rejection = await rejectionOf(db(), CREATE_SQL, createParams(orderId, { actorId: order.actorId, requestKey: key, ...input }));
        expect({ label, rejection }).toEqual({ label, rejection: { code: '22023', message: 'RETURN_REQUEST_MISMATCH' } });
      }
      const count = await db().query('select count(*)::int as n from public.order_returns where order_id = any($1::uuid[])', [
        [order.orderId, other.orderId],
      ]);
      expect(count.rows[0].n).toBe(1);
    });

    test('手数料は、引数が空なら設定の値、設定で使わない手数料は0。返送料の定額は、お客様の負担でお店の送り状の時だけ付く', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 8 }] });
      const feesOf = async (returnId: string) => {
        const res = await db().query(
          'select return_shipping_fee, restocking_fee_percent, exchange_fee, exchange_shipping_fee from public.order_returns where id = $1',
          [returnId],
        );
        return res.rows[0];
      };
      const create = (input: CreateInput) => openReturn(db(), order, [line(order, 0, 1)], input);

      // 設定で手数料を使わない（最初の値）: 全部0
      await updateSettingsRow(db(), { shop_label_fee: 800, restocking_fee_percent: 10, exchange_fee: 300, exchange_shipping_fee: 500 });
      expect(await feesOf(await create({ method: 'shop_label', payer: 'customer' }))).toEqual({
        return_shipping_fee: 800,
        restocking_fee_percent: 0,
        exchange_fee: 0,
        exchange_shipping_fee: 0,
      });

      // 設定で手数料を使う: 引数が空なら設定の値
      await updateSettingsRow(db(), { restocking_fee_enabled: true, exchange_fees_enabled: true });
      expect(await feesOf(await create({ method: 'shop_label', payer: 'customer' }))).toEqual({
        return_shipping_fee: 800,
        restocking_fee_percent: 10,
        exchange_fee: 300,
        exchange_shipping_fee: 500,
      });
      // お店の負担・お客様が自分で送る時は、返送料の定額は0。お店の負担なら、渡した値があっても0（受付のお知らせは「当店が負担」と書く。C-6）
      expect((await feesOf(await create({ method: 'shop_label', payer: 'shop' }))).return_shipping_fee).toBe(0);
      expect((await feesOf(await create({ method: 'shop_label', payer: 'shop', shippingFee: 1200 }))).return_shipping_fee).toBe(0);
      expect((await feesOf(await create({ method: 'customer_ships', payer: 'customer' }))).return_shipping_fee).toBe(0);
      // 渡した値は設定より先。0も渡せる
      expect(
        await feesOf(
          await create({ method: 'shop_label', payer: 'customer', shippingFee: 1200, restockingPercent: 0, exchangeFee: 0, exchangeShippingFee: 250 }),
        ),
      ).toEqual({ return_shipping_fee: 1200, restocking_fee_percent: 0, exchange_fee: 0, exchange_shipping_fee: 250 });
      expect((await feesOf(await create({ method: 'shop_label', payer: 'customer', shippingFee: 0 }))).return_shipping_fee).toBe(0);
      // お店の送り状でない返品に返送料を渡しても、0に直して残す
      expect((await feesOf(await create({ method: 'customer_ships', payer: 'customer', shippingFee: 1200 }))).return_shipping_fee).toBe(0);
    });

    test('返送不要は、設定で出している時だけ選べる。返送しないので配送業者と伝票番号は付けられない', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });

      await expectRejected(
        db(),
        CREATE_SQL,
        createParams(order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1)], method: 'not_required' }),
        INVALID_ARGUMENT,
      );

      await updateSettingsRow(db(), { no_return_needed_enabled: true });
      const res = await createReturn(db(), order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1)], method: 'not_required' });
      expect((await returnRow(db(), res.rows[0].return_id)).return_method).toBe('not_required');

      await expectRejected(
        db(),
        CREATE_SQL,
        createParams(order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1)], method: 'not_required', carrier: 'yamato' }),
        INVALID_ARGUMENT,
      );
    });

    test('返送先が空の間は、返送不要も含めて返品を作れない（RETURN_ADDRESS_REQUIRED）', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      await updateSettingsRow(db(), {
        return_address_name: null,
        return_address_postal_code: null,
        return_address_line: null,
        return_address_phone: null,
        no_return_needed_enabled: true,
      });

      for (const method of ['customer_ships', 'not_required']) {
        await expectRejected(
          db(),
          CREATE_SQL,
          createParams(order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1)], method }),
          { code: '22023', message: 'RETURN_ADDRESS_REQUIRED' },
        );
      }
    });

    test('返品できる数を超えると RETURN_QUANTITY_EXCEEDS で断る（発送の行ごと・注文の商品ごと・同じ商品の複数の行の合計）', async () => {
      const exceeds = { code: '22023', message: 'RETURN_QUANTITY_EXCEEDS' };

      // 発送の行ごと: 注文の数は3でも、2回目の発送は1点だけ
      const split = await createShippedOrder(db(), { lines: [{ quantity: 3 }], shipments: [{ 0: 2 }, { 0: 1 }] });
      await expectRejected(
        db(),
        CREATE_SQL,
        createParams(split.orderId, { actorId: split.actorId, lines: [line(split, 0, 2, { fulfillment_id: split.fulfillmentIds[1] })] }),
        exceeds,
      );
      await expect(
        createReturn(db(), split.orderId, { actorId: split.actorId, lines: [line(split, 0, 1, { fulfillment_id: split.fulfillmentIds[1] })] }),
      ).resolves.toBeTruthy();

      // 注文の商品ごと: ふつうの返金で2点を先に返した後は、返品できるのは1点だけ
      const refunded = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      await insertRefundRecord(db(), {
        orderId: refunded.orderId,
        status: 'succeeded',
        amount: 10000,
        lines: [{ orderItemId: refunded.itemIds[0], quantity: 2, beforeShipment: false, amount: 10000 }],
      });
      await expectRejected(
        db(),
        CREATE_SQL,
        createParams(refunded.orderId, { actorId: refunded.actorId, lines: [line(refunded, 0, 2)] }),
        exceeds,
      );
      await expect(createReturn(db(), refunded.orderId, { actorId: refunded.actorId, lines: [line(refunded, 0, 1)] })).resolves.toBeTruthy();

      // 同じ商品を2つの行に分けた時は合計で確かめる（1行ずつなら通る数）
      const together = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      await expectRejected(
        db(),
        CREATE_SQL,
        createParams(together.orderId, {
          actorId: together.actorId,
          lines: [line(together, 0, 2), line(together, 0, 2, { reason: 'unwanted' })],
        }),
        exceeds,
      );

      // 返品が全部の品を指している間は、もう返品できない。取り消せば、また返品できる
      const all = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const allReturn = await openReturn(db(), all, [line(all, 0, 2)]);
      await expectRejected(db(), CREATE_SQL, createParams(all.orderId, { actorId: all.actorId, lines: [line(all, 0, 1)] }), exceeds);
      await cancelReturn(db(), allReturn, all.actorId);
      await expect(createReturn(db(), all.orderId, { actorId: all.actorId, lines: [line(all, 0, 2)] })).resolves.toBeTruthy();
    });

    test('取り消した発送の品は返品できない（RETURN_QUANTITY_EXCEEDS）。この注文の発送の行でなければ引数の誤り', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }], shipments: [{ 0: 2 }, { 0: 1 }] });
      const other = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      await cancelFulfillment(db(), order.orderId, order.fulfillmentIds[1], order.actorId);

      await expectRejected(
        db(),
        CREATE_SQL,
        createParams(order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1, { fulfillment_id: order.fulfillmentIds[1] })] }),
        { code: '22023', message: 'RETURN_QUANTITY_EXCEEDS' },
      );
      for (const [label, overrides] of [
        ['知らない発送', { fulfillment_id: crypto.randomUUID() }],
        ['ほかの注文の発送', { fulfillment_id: other.fulfillmentIds[0] }],
        ['ほかの注文の商品', { order_item_id: other.itemIds[0] }],
      ] as Array<[string, Record<string, unknown>]>) {
        const rejection = await rejectionOf(
          db(),
          CREATE_SQL,
          createParams(order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1, overrides)] }),
        );
        expect({ label, rejection }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
    });

    test('理由が「その他」ならメモが要る（RETURN_REASON_NOTE_REQUIRED）。メモは前後の空白を落として255字まで', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 6 }] });
      const required = { code: '22023', message: 'RETURN_REASON_NOTE_REQUIRED' };

      for (const reasonNote of [null, '', '   ']) {
        await expectRejected(
          db(),
          CREATE_SQL,
          createParams(order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1, { reason: 'other', reason_note: reasonNote })] }),
          required,
        );
      }

      const res = await createReturn(db(), order.orderId, {
        actorId: order.actorId,
        lines: [line(order, 0, 1, { reason: 'other', reason_note: '  袖の長さが違う  ' }), line(order, 0, 1, { reason: 'unknown' })],
      });
      const rows = await returnLineRows(db(), res.rows[0].return_id);
      expect(rows.map((row) => [row.reason, row.reason_note]).sort()).toEqual([
        ['other', '袖の長さが違う'],
        ['unknown', null],
      ]);

      await expect(
        createReturn(db(), order.orderId, {
          actorId: order.actorId,
          lines: [line(order, 0, 1, { reason: 'defective', reason_note: 'あ'.repeat(255) })],
        }),
      ).resolves.toBeTruthy();
      await expectRejected(
        db(),
        CREATE_SQL,
        createParams(order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1, { reason_note: 'あ'.repeat(256) })] }),
        INVALID_ARGUMENT,
      );
    });

    test('交換は、同じ商品の使える色・サイズだけ選べる。同じ商品を返金と交換の2行に分けられる', async () => {
      // 数を確かめる段が色・サイズを確かめる段より先なので、断りの試験の分も返品できる数を残しておく
      const order = await createShippedOrder(db(), { lines: [{ quantity: 8 }] });
      const other = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      const white = await addVariant(db(), order.catalogItemIds[0], { color: 'WHITE', size: 'L', stock: 5 });
      const retired = await addVariant(db(), order.catalogItemIds[0], { color: 'RED', size: 'S', active: false });
      const exchangeOf = (variantId: number | null, extra: Record<string, unknown> = {}) =>
        line(order, 0, 1, {
          resolution: 'exchange',
          exchange_variant_id: variantId,
          exchange_method: 'stock',
          reason: 'size_too_small',
          ...extra,
        });

      // 返金1点と交換1点（在庫から）を1つの返品に
      const res = await createReturn(db(), order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1), exchangeOf(white)] });
      const rows = await returnLineRows(db(), res.rows[0].return_id);
      expect(rows.map((row) => [row.resolution, row.exchange_variant_id === null ? null : Number(row.exchange_variant_id), row.exchange_method])).toEqual([
        ['exchange', white, 'stock'],
        ['refund', null, null],
      ]);
      // 作って送る・今と同じ色・サイズへの交換も作れる
      await expect(
        createReturn(db(), order.orderId, { actorId: order.actorId, lines: [exchangeOf(white, { exchange_method: 'make' })] }),
      ).resolves.toBeTruthy();
      await expect(createReturn(db(), order.orderId, { actorId: order.actorId, lines: [exchangeOf(order.variantIds[0])] })).resolves.toBeTruthy();

      const invalidVariant = { code: '22023', message: 'RETURN_EXCHANGE_VARIANT_INVALID' };
      for (const [label, variantId] of [
        ['ほかの商品の色・サイズ', other.variantIds[0]],
        ['使えない色・サイズ', retired],
        ['知らない色・サイズ', 999999999],
        ['色・サイズが空', null],
      ] as Array<[string, number | null]>) {
        const rejection = await rejectionOf(
          db(),
          CREATE_SQL,
          createParams(order.orderId, { actorId: order.actorId, lines: [exchangeOf(variantId)] }),
        );
        expect({ label, rejection }).toEqual({ label, rejection: invalidVariant });
      }

      // 形の誤り: 交換なのに送り方が空・知らない送り方、返金なのに色・サイズや送り方がある
      for (const [label, extra] of [
        ['送り方が空', { exchange_method: null }],
        ['知らない送り方', { exchange_method: 'ship' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const rejection = await rejectionOf(
          db(),
          CREATE_SQL,
          createParams(order.orderId, { actorId: order.actorId, lines: [exchangeOf(white, extra)] }),
        );
        expect({ label, rejection }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
      for (const [label, extra] of [
        ['返金に色・サイズ', { exchange_variant_id: white }],
        ['返金に送り方', { exchange_method: 'stock' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const rejection = await rejectionOf(
          db(),
          CREATE_SQL,
          createParams(order.orderId, { actorId: order.actorId, lines: [line(order, 0, 1, extra)] }),
        );
        expect({ label, rejection }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
    });

    test('引数の形が違えば RETURN_ARGUMENT_INVALID で断る', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const base = { actorId: order.actorId, lines: [line(order, 0, 1)] };
      const withLine = (extra: Record<string, unknown>) => ({ ...base, lines: [line(order, 0, 1, extra)] });
      const cases: Array<[string, unknown[]]> = [
        ['注文の番号が空', createParams(null, base)],
        ['実行した人が空', createParams(order.orderId, { ...base, actorId: null })],
        ['二重防止の番号が空', createParams(order.orderId, { ...base, requestKey: null })],
        ['知らせるかが空', createParams(order.orderId, { ...base, notify: null })],
        ['行が空の配列', createParams(order.orderId, { ...base, lines: [] })],
        ['行が配列でない', createParams(order.orderId, { ...base, lines: {} })],
        ['行が101行', createParams(order.orderId, { ...base, lines: Array.from({ length: 101 }, () => line(order, 0, 1)) })],
        ['行の発送が空', createParams(order.orderId, withLine({ fulfillment_id: undefined }))],
        ['行の発送が文字でない', createParams(order.orderId, withLine({ fulfillment_id: 123 }))],
        ['行の数が0', createParams(order.orderId, withLine({ quantity: 0 }))],
        ['行の数が小数', createParams(order.orderId, withLine({ quantity: 1.5 }))],
        ['行の数が1000', createParams(order.orderId, withLine({ quantity: 1000 }))],
        ['行の理由が違う', createParams(order.orderId, withLine({ reason: 'broken' }))],
        ['行の解決が違う', createParams(order.orderId, withLine({ resolution: 'swap' }))],
        ['行の理由のメモが数', createParams(order.orderId, withLine({ reason_note: 5 }))],
        ['返送の方法が違う', createParams(order.orderId, { ...base, method: 'ship' })],
        ['返送料の負担が違う', createParams(order.orderId, { ...base, payer: 'both' })],
        ['配送業者が違う', createParams(order.orderId, { ...base, carrier: 'ups' })],
        ['伝票番号が違う', createParams(order.orderId, { ...base, tracking: 'a b' })],
        ['メモが501字', createParams(order.orderId, { ...base, shopNote: 'あ'.repeat(501) })],
      ];

      for (const [label, params] of cases) {
        expect({ label, rejection: await rejectionOf(db(), CREATE_SQL, params) }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
    });

    test('手数料の値が範囲の外なら RETURN_FEE_INVALID で断る', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const base = { actorId: order.actorId, lines: [line(order, 0, 1)] };
      const cases: Array<[string, CreateInput]> = [
        ['返送料がマイナス', { ...base, shippingFee: -1 }],
        ['返送料が100万円を超える', { ...base, shippingFee: 1000001 }],
        ['返品の手数料がマイナス', { ...base, restockingPercent: -1 }],
        ['返品の手数料が100%を超える', { ...base, restockingPercent: 101 }],
        ['交換の手数料がマイナス', { ...base, exchangeFee: -1 }],
        ['交換の送料が100万円を超える', { ...base, exchangeShippingFee: 1000001 }],
      ];

      for (const [label, input] of cases) {
        const rejection = await rejectionOf(db(), CREATE_SQL, createParams(order.orderId, input));
        expect({ label, rejection }).toEqual({ label, rejection: { code: '22023', message: 'RETURN_FEE_INVALID' } });
      }
    });

    test('知らない注文は ORDER_NOT_FOUND、支払い済みでも発送済みでもない注文は ORDER_NOT_RETURNABLE で断る', async () => {
      const actor = await createActor(db());
      const fx = await createCatalogFixture(db(), { stock: 1 });
      const pending = await insertOrderWithLines(db(), {
        status: 'pending',
        lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 1, fulfillmentType: 'stock' }],
      });
      const sample = (orderItemId: string) => ({
        actorId: actor.id,
        lines: [
          {
            fulfillment_id: crypto.randomUUID(),
            order_item_id: orderItemId,
            quantity: 1,
            reason: 'defective',
            reason_note: null,
            resolution: 'refund',
            exchange_variant_id: null,
            exchange_method: null,
          },
        ],
      });

      await expectRejected(db(), CREATE_SQL, createParams(crypto.randomUUID(), sample(pending.orderItemIds[0])), {
        code: 'P0002',
        message: 'ORDER_NOT_FOUND',
      });
      await expectRejected(db(), CREATE_SQL, createParams(pending.orderId, sample(pending.orderItemIds[0])), {
        code: '22023',
        message: 'ORDER_NOT_RETURNABLE',
      });
    });
  });

  describe('返品を取り消す（admin_cancel_return）', () => {
    test('何も処理していない受付中の返品は取り消せ、品はまた返品できる。取消のメールは書かず、まだ送っていない受付のお知らせは取りやめる', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 2)]);

      const res = await cancelReturn(db(), returnId, order.actorId);

      expect(res.rows).toEqual([{ return_id: returnId, status: 'cancelled' }]);
      const cancelled = await returnRow(db(), returnId);
      expect(cancelled).toMatchObject({ status: 'cancelled', cancelled_by: order.actorId });
      expect(cancelled.cancelled_at).not.toBeNull();
      expect((await countsOf(db(), order.orderId))[order.itemIds[0]]).toMatchObject({
        open_unprocessed: 0,
        returnable: 2,
        refundable_after_shipment: 2,
      });
      // 書いてあるのは、返品を作った時の受付のお知らせだけ。まだ送っていないので取りやめる（取り消した返品の受付を知らせない。仕様書 7-3）
      expect((await outboxRows(db(), order.orderId)).map((row) => row.status)).toEqual(['skipped']);
      const skipped = await db().query(
        "select last_error_code, finished_at is not null as finished from private.order_email_outbox where return_id = $1 and kind = 'return_accepted'",
        [returnId],
      );
      expect(skipped.rows).toEqual([{ last_error_code: 'return_cancelled', finished: true }]);
      await expect(createReturn(db(), order.orderId, { actorId: order.actorId, lines: [line(order, 0, 2)] })).resolves.toBeTruthy();
    });

    test('取消が取りやめるのは、まだ送っていない受付のお知らせ（送る前・やり直し待ち）だけ。送っている途中の行と送り済みの行は触らない', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 4 }] });
      const states = {
        retryWait: await openReturn(db(), order, [line(order, 0, 1)]),
        sending: await openReturn(db(), order, [line(order, 0, 1)]),
        sent: await openReturn(db(), order, [line(order, 0, 1)]),
        pending: await openReturn(db(), order, [line(order, 0, 1)]),
      };
      // 受付のお知らせの行の状態を直接変える（送る側の関数は別のタスク）
      await db().query(
        "update private.order_email_outbox set status = 'retry_wait', attempts = 1, next_attempt_at = now() + interval '1 minute' where return_id = $1 and kind = 'return_accepted'",
        [states.retryWait],
      );
      await db().query(
        `update private.order_email_outbox
         set status = 'sending', attempts = 1, lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes'
         where return_id = $1 and kind = 'return_accepted'`,
        [states.sending],
      );
      await db().query(
        "update private.order_email_outbox set status = 'sent', attempts = 1, sent_at = now(), finished_at = now() where return_id = $1 and kind = 'return_accepted'",
        [states.sent],
      );

      for (const returnId of Object.values(states)) {
        await cancelReturn(db(), returnId, order.actorId);
      }

      const rows = await db().query(
        "select return_id, status, last_error_code from private.order_email_outbox where order_id = $1 and kind = 'return_accepted'",
        [order.orderId],
      );
      const byReturn = Object.fromEntries(rows.rows.map((row) => [row.return_id as string, row]));
      expect(byReturn[states.retryWait]).toMatchObject({ status: 'skipped', last_error_code: 'return_cancelled' });
      expect(byReturn[states.pending]).toMatchObject({ status: 'skipped', last_error_code: 'return_cancelled' });
      expect(byReturn[states.sending]).toMatchObject({ status: 'sending', last_error_code: null });
      expect(byReturn[states.sent]).toMatchObject({ status: 'sent', last_error_code: null });
    });

    test('受け取りを記録した返品・届かないで終えた返品・取り消した返品は、取り消せない（RETURN_STATE_CONFLICT）', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      const received = await openReturn(db(), order, [line(order, 0, 1)]);
      await insertReceipt(db(), received, {
        lines: [{ returnLineId: await lineIdOf(db(), received, order.itemIds[0]), disposition: 'restocked', quantity: 1 }],
      });
      const missing = await openReturn(db(), order, [line(order, 0, 1)]);
      await closeMissing(db(), missing, order.actorId);
      const cancelled = await openReturn(db(), order, [line(order, 0, 1)]);
      await cancelReturn(db(), cancelled, order.actorId);

      for (const returnId of [received, missing, cancelled]) {
        await expectRejected(db(), 'select * from public.admin_cancel_return($1, $2)', [returnId, order.actorId], {
          code: '22023',
          message: 'RETURN_STATE_CONFLICT',
        });
      }
      expect((await returnRow(db(), received)).status).toBe('open');
    });

    test('知らない返品は RETURN_NOT_FOUND、引数が空なら RETURN_ARGUMENT_INVALID で断る', async () => {
      const actor = await createActor(db());

      await expectRejected(db(), 'select * from public.admin_cancel_return($1, $2)', [crypto.randomUUID(), actor.id], {
        code: 'P0002',
        message: 'RETURN_NOT_FOUND',
      });
      for (const params of [[null, actor.id], [crypto.randomUUID(), null]]) {
        await expectRejected(db(), 'select * from public.admin_cancel_return($1, $2)', params, INVALID_ARGUMENT);
      }
    });
  });

  describe('残りを届かないものとして終える（admin_close_return_missing）', () => {
    test('未処理の数を届かないとして記録して完了にし、品はまたその発送から返品できる。メールは書かない', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 2)]);
      const lineId = await lineIdOf(db(), returnId, order.itemIds[0]);
      const key = crypto.randomUUID();

      const res = await closeMissing(db(), returnId, order.actorId, key);

      expect(res.rows).toEqual([{ receipt_id: expect.any(String), return_status: 'closed', replayed: false }]);
      const receiptId = res.rows[0].receipt_id as string;
      expect(await receiptRows(db(), returnId)).toEqual([
        expect.objectContaining({
          id: receiptId,
          kind: 'close_missing',
          refund_choice: null,
          refund_id: null,
          notify_customer: false,
          actor_id: order.actorId,
          request_key: key,
        }),
      ]);
      expect(await receiptLineRows(db(), receiptId)).toEqual([
        { return_line_id: lineId, disposition: 'missing', quantity: 2, resolution: null, exchange_method: null },
      ]);
      const closed = await returnRow(db(), returnId);
      expect(closed.status).toBe('closed');
      expect(closed.closed_at).not.toBeNull();
      expect((await progressOf(db(), returnId))[lineId]).toMatchObject({ missing: 2, processed: 2, unprocessed: 0 });
      // 届かなかった品は、まだお客様の手元にある。またその発送から返品できる
      expect((await fulfillmentReturnable(db(), order.orderId))[0]).toMatchObject({ missing: 2, returnable: 2 });
      expect((await countsOf(db(), order.orderId))[order.itemIds[0]]).toMatchObject({ open_unprocessed: 0, returnable: 2 });
      expect(await outboxRows(db(), order.orderId)).toHaveLength(1);
    });

    test('返金待ちの品が残る時は、届かないを記録しても受付中のまま（返金待ち）。お返しと届かないだけで全部が処理されれば完了になる', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 4 }] });

      // 2点のうち1点を戻して受け取り（返金はまだ）。残りの1点を届かないにしても、返金待ちの品があるので閉じない
      const waiting = await openReturn(db(), order, [line(order, 0, 2)]);
      const waitingLine = await lineIdOf(db(), waiting, order.itemIds[0]);
      await insertReceipt(db(), waiting, { lines: [{ returnLineId: waitingLine, disposition: 'restocked', quantity: 1 }] });
      const waitingRes = await closeMissing(db(), waiting, order.actorId);
      expect(waitingRes.rows[0]).toMatchObject({ return_status: 'open', replayed: false });
      expect((await progressOf(db(), waiting))[waitingLine]).toMatchObject({ restocked: 1, missing: 1, unprocessed: 0, refund_waiting: 1 });
      expect(await displayStateOf(db(), waiting)).toMatchObject({ display_status: 'refund_waiting', marks: [] });

      // 1点をお返し、1点を届かない: 返金の品が無いので完了
      const sentBack = await openReturn(db(), order, [line(order, 0, 2)]);
      const sentBackLine = await lineIdOf(db(), sentBack, order.itemIds[0]);
      await insertReceipt(db(), sentBack, { lines: [{ returnLineId: sentBackLine, disposition: 'sent_back', quantity: 1 }] });
      const sentBackRes = await closeMissing(db(), sentBack, order.actorId);
      expect(sentBackRes.rows[0]).toMatchObject({ return_status: 'closed', replayed: false });
      expect((await progressOf(db(), sentBack))[sentBackLine]).toMatchObject({ sent_back: 1, missing: 1, processed: 2, unprocessed: 0 });
    });

    test('未処理が無い返品・受付中でない返品は RETURN_STATE_CONFLICT で断る', async () => {
      const conflict = { code: '22023', message: 'RETURN_STATE_CONFLICT' };
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      // 全部をお返しにした（記録を直接書いたので、完了にはなっていない）
      const processed = await openReturn(db(), order, [line(order, 0, 1)]);
      await insertReceipt(db(), processed, {
        lines: [{ returnLineId: await lineIdOf(db(), processed, order.itemIds[0]), disposition: 'sent_back', quantity: 1 }],
      });
      const closed = await openReturn(db(), order, [line(order, 0, 1)]);
      await closeMissing(db(), closed, order.actorId);
      const cancelled = await openReturn(db(), order, [line(order, 0, 1)]);
      await cancelReturn(db(), cancelled, order.actorId);

      for (const returnId of [processed, closed, cancelled]) {
        await expectRejected(db(), 'select * from public.admin_close_return_missing($1, $2, $3)', [returnId, order.actorId, crypto.randomUUID()], conflict);
      }
    });

    test('同じ番号の送り直しは前の結果を返して記録を増やさず、ほかの返品に使うと RETURN_REQUEST_MISMATCH で断る', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const other = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 2)]);
      const otherReturn = await openReturn(db(), other, [line(other, 0, 1)]);
      const key = crypto.randomUUID();

      const first = await closeMissing(db(), returnId, order.actorId, key);
      const again = await closeMissing(db(), returnId, order.actorId, key);

      expect(again.rows).toEqual([{ receipt_id: first.rows[0].receipt_id, return_status: 'closed', replayed: true }]);
      expect(await receiptRows(db(), returnId)).toHaveLength(1);
      await expectRejected(db(), 'select * from public.admin_close_return_missing($1, $2, $3)', [otherReturn, other.actorId, key], {
        code: '22023',
        message: 'RETURN_REQUEST_MISMATCH',
      });
      expect((await returnRow(db(), otherReturn)).status).toBe('open');
    });

    test('知らない返品は RETURN_NOT_FOUND、引数が空なら RETURN_ARGUMENT_INVALID で断る', async () => {
      const actor = await createActor(db());
      const sql = 'select * from public.admin_close_return_missing($1, $2, $3)';

      await expectRejected(db(), sql, [crypto.randomUUID(), actor.id, crypto.randomUUID()], { code: 'P0002', message: 'RETURN_NOT_FOUND' });
      for (const params of [
        [null, actor.id, crypto.randomUUID()],
        [crypto.randomUUID(), null, crypto.randomUUID()],
        [crypto.randomUUID(), actor.id, null],
      ]) {
        await expectRejected(db(), sql, params, INVALID_ARGUMENT);
      }
    });
  });

  describe('返品を開き直す（admin_reopen_return）', () => {
    test('届かないで閉じた品を、また受け取れる受付中に戻す。書くのは届かないを打ち消す行だけで、メールは書かない', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 2)]);
      const lineId = await lineIdOf(db(), returnId, order.itemIds[0]);
      await closeMissing(db(), returnId, order.actorId);
      const key = crypto.randomUUID();

      const res = await reopenReturn(db(), returnId, order.actorId, key);

      expect(res.rows).toEqual([{ receipt_id: expect.any(String), return_status: 'open', replayed: false }]);
      const reopen = (await receiptRows(db(), returnId)).find((row) => row.kind === 'reopen') as Row;
      expect(reopen).toMatchObject({
        id: res.rows[0].receipt_id,
        refund_choice: null,
        notify_customer: false,
        actor_id: order.actorId,
        request_key: key,
      });
      expect(await receiptLineRows(db(), reopen.id)).toEqual([
        { return_line_id: lineId, disposition: 'missing_reopened', quantity: 2, resolution: null, exchange_method: null },
      ]);
      const reopened = await returnRow(db(), returnId);
      expect(reopened).toMatchObject({ status: 'open', reopened_by: order.actorId });
      expect(reopened.reopened_at).not.toBeNull();
      expect((await progressOf(db(), returnId))[lineId]).toMatchObject({ missing: 0, unprocessed: 2, processed: 0 });
      expect((await fulfillmentReturnable(db(), order.orderId))[0]).toMatchObject({ missing: 0, returnable: 0 });
      expect(await outboxRows(db(), order.orderId)).toHaveLength(1);
    });

    test('届かないで閉じた後に、ふつうの返金でその品を返金していても開き直せる（受け取っても返金しない扱いは移行 C。Review Focus 3）', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 1)]);
      const lineId = await lineIdOf(db(), returnId, order.itemIds[0]);
      await closeMissing(db(), returnId, order.actorId);

      // 品が届かないので、ふつうの返金の画面でお客様に返金した
      const refund = await beginOrdinaryRefund(db(), order, 0, 1, PRICE);
      expect(refund.rows[0]).toMatchObject({ amount: PRICE, status: 'awaiting_response', replayed: false });

      const res = await reopenReturn(db(), returnId, order.actorId);

      expect(res.rows[0]).toMatchObject({ return_status: 'open', replayed: false });
      expect((await progressOf(db(), returnId))[lineId]).toMatchObject({ missing: 0, unprocessed: 1 });
    });

    test('届かない品が無い完了・受付中・取消の返品は RETURN_STATE_CONFLICT で断る', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      const open = await openReturn(db(), order, [line(order, 0, 1)]);
      const cancelled = await openReturn(db(), order, [line(order, 0, 1)]);
      await cancelReturn(db(), cancelled, order.actorId);
      // 全部をお返しにして完了した返品（届かない品は無い）
      const sentBack = await openReturn(db(), order, [line(order, 0, 1)]);
      await insertReceipt(db(), sentBack, {
        lines: [{ returnLineId: await lineIdOf(db(), sentBack, order.itemIds[0]), disposition: 'sent_back', quantity: 1 }],
      });
      const refreshed = await db().query('select private.refresh_order_return_status($1) as status', [sentBack]);
      expect(refreshed.rows[0].status).toBe('closed');

      for (const returnId of [open, cancelled, sentBack]) {
        await expectRejected(db(), 'select * from public.admin_reopen_return($1, $2, $3)', [returnId, order.actorId, crypto.randomUUID()], {
          code: '22023',
          message: 'RETURN_STATE_CONFLICT',
        });
      }
    });

    test('ほかの返品が同じ発送の品をもう指している時は、数を超えるので開き直せない（RETURN_QUANTITY_EXCEEDS）', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const first = await openReturn(db(), order, [line(order, 0, 2)]);
      await closeMissing(db(), first, order.actorId);
      // 届かなかった2点を、別の返品が引き受けた
      await openReturn(db(), order, [line(order, 0, 2)]);

      await expectRejected(db(), 'select * from public.admin_reopen_return($1, $2, $3)', [first, order.actorId, crypto.randomUUID()], {
        code: '22023',
        message: 'RETURN_QUANTITY_EXCEEDS',
      });
      expect((await returnRow(db(), first)).status).toBe('closed');
    });

    test('知らない返品は RETURN_NOT_FOUND、引数が空なら RETURN_ARGUMENT_INVALID で断る', async () => {
      const actor = await createActor(db());
      const sql = 'select * from public.admin_reopen_return($1, $2, $3)';

      await expectRejected(db(), sql, [crypto.randomUUID(), actor.id, crypto.randomUUID()], { code: 'P0002', message: 'RETURN_NOT_FOUND' });
      for (const params of [
        [null, actor.id, crypto.randomUUID()],
        [crypto.randomUUID(), null, crypto.randomUUID()],
        [crypto.randomUUID(), actor.id, null],
      ]) {
        await expectRejected(db(), sql, params, INVALID_ARGUMENT);
      }
    });

    test('同じ番号の送り直しは前の結果を返し、ほかの返品に使うと RETURN_REQUEST_MISMATCH で断る', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 1)]);
      const other = await openReturn(db(), order, [line(order, 0, 1)]);
      await closeMissing(db(), returnId, order.actorId);
      await closeMissing(db(), other, order.actorId);
      const key = crypto.randomUUID();

      const first = await reopenReturn(db(), returnId, order.actorId, key);
      const again = await reopenReturn(db(), returnId, order.actorId, key);

      expect(again.rows).toEqual([{ receipt_id: first.rows[0].receipt_id, return_status: 'open', replayed: true }]);
      expect((await receiptRows(db(), returnId)).filter((row) => row.kind === 'reopen')).toHaveLength(1);
      await expectRejected(db(), 'select * from public.admin_reopen_return($1, $2, $3)', [other, order.actorId, key], {
        code: '22023',
        message: 'RETURN_REQUEST_MISMATCH',
      });
    });
  });

  describe('検品待ちを決める（admin_inspect_return）', () => {
    /** 3点を返金の解決で検品待ちとして受け取った返品 */
    async function pendingInspectionReturn() {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 3)]);
      const lineId = await lineIdOf(db(), returnId, order.itemIds[0]);
      await insertReceipt(db(), returnId, { lines: [{ returnLineId: lineId, disposition: 'pending_inspection', quantity: 3 }] });
      return { order, returnId, lineId };
    }

    test('検品待ちを戻す・戻さないに決めると、決めた数だけ検品待ちが減り、戻す品は在庫の台帳に理由 return で足される', async () => {
      const { order, returnId, lineId } = await pendingInspectionReturn();
      const stockBefore = await variantStock(db(), order.variantIds[0]);
      const key = crypto.randomUUID();

      const res = await inspectReturn(db(), returnId, order.actorId, [{ return_line_id: lineId, restocked: 2, not_restocked: 1 }], key);

      // 返金の品の返金待ちが残るので、返品は受付中のまま
      expect(res.rows).toEqual([{ receipt_id: expect.any(String), return_status: 'open', replayed: false }]);
      const receiptId = res.rows[0].receipt_id as string;
      expect((await receiptRows(db(), returnId)).find((row) => row.id === receiptId)).toMatchObject({
        kind: 'inspect',
        refund_choice: null,
        notify_customer: false,
        actor_id: order.actorId,
        request_key: key,
      });
      expect(await receiptLineRows(db(), receiptId)).toEqual([
        { return_line_id: lineId, disposition: 'inspected_not_restocked', quantity: 1, resolution: null, exchange_method: null },
        { return_line_id: lineId, disposition: 'inspected_restocked', quantity: 2, resolution: null, exchange_method: null },
      ]);
      expect((await progressOf(db(), returnId))[lineId]).toMatchObject({
        pending_inspection: 0,
        restocked: 2,
        not_restocked: 1,
        processed: 3,
        unprocessed: 0,
        refund_waiting: 3,
      });
      expect(await displayStateOf(db(), returnId)).toMatchObject({ display_status: 'refund_waiting', marks: [] });

      const moves = await db().query(
        `select delta, reason, order_id, order_item_id, return_id, created_by, note
         from public.stock_movements where variant_id = $1 and reason = 'return'`,
        [order.variantIds[0]],
      );
      expect(moves.rows).toEqual([
        {
          delta: 2,
          reason: 'return',
          order_id: order.orderId,
          order_item_id: order.itemIds[0],
          return_id: returnId,
          created_by: order.actorId,
          note: null,
        },
      ]);
      expect(await variantStock(db(), order.variantIds[0])).toBe(stockBefore + 2);
    });

    test('戻さないだけを決めた時は在庫を動かさない。一部の数だけ決めてもよく、残りは検品待ちのまま', async () => {
      const { order, returnId, lineId } = await pendingInspectionReturn();
      const stockBefore = await variantStock(db(), order.variantIds[0]);

      await inspectReturn(db(), returnId, order.actorId, [{ return_line_id: lineId, restocked: 0, not_restocked: 1 }]);

      expect(await variantStock(db(), order.variantIds[0])).toBe(stockBefore);
      expect((await progressOf(db(), returnId))[lineId]).toMatchObject({ pending_inspection: 2, not_restocked: 1, unprocessed: 0 });
      expect(await displayStateOf(db(), returnId)).toMatchObject({ display_status: 'in_progress', marks: ['pending_inspection'] });
    });

    test('検品待ちの数を超えると RETURN_RECEIPT_EXCEEDS、受付中でない返品は RETURN_STATE_CONFLICT で断る', async () => {
      const { order, returnId, lineId } = await pendingInspectionReturn();
      const sql = 'select * from public.admin_inspect_return($1, $2, $3, $4::jsonb)';
      const exceeds = { code: '22023', message: 'RETURN_RECEIPT_EXCEEDS' };

      await expectRejected(
        db(),
        sql,
        [returnId, order.actorId, crypto.randomUUID(), JSON.stringify([{ return_line_id: lineId, restocked: 2, not_restocked: 2 }])],
        exceeds,
      );
      await inspectReturn(db(), returnId, order.actorId, [{ return_line_id: lineId, restocked: 3, not_restocked: 0 }]);
      await expectRejected(
        db(),
        sql,
        [returnId, order.actorId, crypto.randomUUID(), JSON.stringify([{ return_line_id: lineId, restocked: 1, not_restocked: 0 }])],
        exceeds,
      );

      const cancelledOrder = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      const cancelled = await openReturn(db(), cancelledOrder, [line(cancelledOrder, 0, 1)]);
      const cancelledLine = await lineIdOf(db(), cancelled, cancelledOrder.itemIds[0]);
      await cancelReturn(db(), cancelled, cancelledOrder.actorId);
      await expectRejected(
        db(),
        sql,
        [cancelled, cancelledOrder.actorId, crypto.randomUUID(), JSON.stringify([{ return_line_id: cancelledLine, restocked: 1, not_restocked: 0 }])],
        { code: '22023', message: 'RETURN_STATE_CONFLICT' },
      );
    });

    test('行の形が違う・この返品の行でない・決める数が無い時は RETURN_ARGUMENT_INVALID で断る', async () => {
      const { order, returnId, lineId } = await pendingInspectionReturn();
      const other = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      const otherReturn = await openReturn(db(), other, [line(other, 0, 1)]);
      const otherLine = await lineIdOf(db(), otherReturn, other.itemIds[0]);
      const cases: Array<[string, unknown]> = [
        ['行が空', []],
        ['行が配列でない', {}],
        ['返品の行の番号が空', [{ restocked: 1, not_restocked: 0 }]],
        ['数が文字', [{ return_line_id: lineId, restocked: '1', not_restocked: 0 }]],
        ['数がマイナス', [{ return_line_id: lineId, restocked: -1, not_restocked: 1 }]],
        ['数が小数', [{ return_line_id: lineId, restocked: 1.5, not_restocked: 0 }]],
        ['決める数が0', [{ return_line_id: lineId, restocked: 0, not_restocked: 0 }]],
        ['同じ行が2つ', [{ return_line_id: lineId, restocked: 1, not_restocked: 0 }, { return_line_id: lineId, restocked: 1, not_restocked: 0 }]],
        ['知らない行', [{ return_line_id: crypto.randomUUID(), restocked: 1, not_restocked: 0 }]],
        ['ほかの返品の行', [{ return_line_id: otherLine, restocked: 1, not_restocked: 0 }]],
      ];

      for (const [label, lines] of cases) {
        const rejection = await rejectionOf(db(), 'select * from public.admin_inspect_return($1, $2, $3, $4::jsonb)', [
          returnId,
          order.actorId,
          crypto.randomUUID(),
          JSON.stringify(lines),
        ]);
        expect({ label, rejection }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
    });

    test('知らない返品は RETURN_NOT_FOUND、返品・実行した人・二重防止の番号が空なら RETURN_ARGUMENT_INVALID で断る', async () => {
      const actor = await createActor(db());
      const sql = 'select * from public.admin_inspect_return($1, $2, $3, $4::jsonb)';
      const lines = JSON.stringify([{ return_line_id: crypto.randomUUID(), restocked: 1, not_restocked: 0 }]);

      await expectRejected(db(), sql, [crypto.randomUUID(), actor.id, crypto.randomUUID(), lines], {
        code: 'P0002',
        message: 'RETURN_NOT_FOUND',
      });
      for (const params of [
        [null, actor.id, crypto.randomUUID(), lines],
        [crypto.randomUUID(), null, crypto.randomUUID(), lines],
        [crypto.randomUUID(), actor.id, null, lines],
      ]) {
        await expectRejected(db(), sql, params, INVALID_ARGUMENT);
      }
    });

    test('同じ番号の送り直しは前の結果を返して在庫を二重に戻さず、違う中身・違う返品に使うと RETURN_REQUEST_MISMATCH で断る', async () => {
      const { order, returnId, lineId } = await pendingInspectionReturn();
      const other = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      const otherReturn = await openReturn(db(), other, [line(other, 0, 1)]);
      const otherLine = await lineIdOf(db(), otherReturn, other.itemIds[0]);
      const key = crypto.randomUUID();
      const lines = [{ return_line_id: lineId, restocked: 2, not_restocked: 0 }];

      const first = await inspectReturn(db(), returnId, order.actorId, lines, key);
      const again = await inspectReturn(db(), returnId, order.actorId, lines, key);

      expect(again.rows).toEqual([{ receipt_id: first.rows[0].receipt_id, return_status: 'open', replayed: true }]);
      const moves = await db().query("select count(*)::int as n from public.stock_movements where return_id = $1 and reason = 'return'", [returnId]);
      expect(moves.rows[0].n).toBe(1);
      const mismatch = { code: '22023', message: 'RETURN_REQUEST_MISMATCH' };
      await expectRejected(
        db(),
        'select * from public.admin_inspect_return($1, $2, $3, $4::jsonb)',
        [returnId, order.actorId, key, JSON.stringify([{ return_line_id: lineId, restocked: 1, not_restocked: 0 }])],
        mismatch,
      );
      await expectRejected(
        db(),
        'select * from public.admin_inspect_return($1, $2, $3, $4::jsonb)',
        [otherReturn, other.actorId, key, JSON.stringify([{ return_line_id: otherLine, restocked: 1, not_restocked: 0 }])],
        mismatch,
      );
    });

    test('検品を終えて返金待ちなども無くなれば、返品は自動で完了になる（交換の品を検品待ちで受け取った返品）', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      const white = await addVariant(db(), order.catalogItemIds[0], { color: 'WHITE', size: 'L', stock: 2 });
      const returnId = await openReturn(db(), order, [
        line(order, 0, 1, { resolution: 'exchange', exchange_variant_id: white, exchange_method: 'stock', reason: 'size_too_small' }),
      ]);
      const lineId = await lineIdOf(db(), returnId, order.itemIds[0], 'exchange');
      await insertReceipt(db(), returnId, { lines: [{ returnLineId: lineId, disposition: 'pending_inspection', quantity: 1 }] });
      expect(await displayStateOf(db(), returnId)).toMatchObject({ display_status: 'in_progress', marks: ['pending_inspection'] });

      const res = await inspectReturn(db(), returnId, order.actorId, [{ return_line_id: lineId, restocked: 1, not_restocked: 0 }]);

      expect(res.rows[0]).toMatchObject({ return_status: 'closed', replayed: false });
      expect((await returnRow(db(), returnId)).closed_at).not.toBeNull();
      // 戻す品は、元の色・サイズ（交換の色・サイズではない）に戻る
      expect(await variantStock(db(), order.variantIds[0])).toBe(1);
      expect(await variantStock(db(), white)).toBe(2);
    });

    test('色・サイズの無い古い商品は、在庫に戻す検品を断る（RETURN_ARGUMENT_INVALID。受け取りの「在庫に戻す」と同じ）。戻さない検品なら決められ、在庫は動かない', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      // 色・サイズの参照が無い古い明細にする（明細は後から書き換えられないので、トリガーを止めて直す）
      await db().query('set local session_replication_role = replica');
      await db().query('update public.order_items set variant_id = null where id = $1', [order.itemIds[0]]);
      await db().query('set local session_replication_role = origin');
      const returnId = await openReturn(db(), order, [line(order, 0, 2)]);
      const lineId = await lineIdOf(db(), returnId, order.itemIds[0]);
      await insertReceipt(db(), returnId, { lines: [{ returnLineId: lineId, disposition: 'pending_inspection', quantity: 2 }] });
      const stockBefore = await variantStock(db(), order.variantIds[0]);

      await expectRejected(
        db(),
        'select * from public.admin_inspect_return($1, $2, $3, $4::jsonb)',
        [returnId, order.actorId, crypto.randomUUID(), JSON.stringify([{ return_line_id: lineId, restocked: 1, not_restocked: 1 }])],
        INVALID_ARGUMENT,
      );
      const res = await inspectReturn(db(), returnId, order.actorId, [{ return_line_id: lineId, restocked: 0, not_restocked: 2 }]);

      // 戻さないに決めた分だけが記録され、在庫の台帳は書かない
      expect(res.rows[0]).toMatchObject({ return_status: 'open', replayed: false });
      expect((await progressOf(db(), returnId))[lineId]).toMatchObject({ pending_inspection: 0, not_restocked: 2, restocked: 0 });
      const moves = await db().query("select count(*)::int as n from public.stock_movements where return_id = $1 and reason = 'return'", [returnId]);
      expect(moves.rows[0].n).toBe(0);
      expect(await variantStock(db(), order.variantIds[0])).toBe(stockBefore);
    });
  });

  describe('手数料の受け取りの記録・支払いを待たずに送る', () => {
    /** 手数料 300円のお支払い待ちの返品（受け取りの関数が付ける fee_due_amount を直接書く） */
    async function feeDueReturn() {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 1)]);
      await db().query('update public.order_returns set fee_due_amount = 300 where id = $1', [returnId]);
      return { order, returnId };
    }

    test('手数料の受け取りを記録すると、時刻・人・メモが残る。メモの前後の空白は落とし、何度も記録できない', async () => {
      const { order, returnId } = await feeDueReturn();

      const res = await recordFeePayment(db(), returnId, order.actorId, '  銀行振込  ');

      // 未処理の品があるので、返品は受付中のまま
      expect(res.rows).toEqual([{ return_id: returnId, return_status: 'open' }]);
      const row = await returnRow(db(), returnId);
      // 受け取りを記録しただけなので、いただかないことにした印（fee_waived）は偽のまま
      expect(row).toMatchObject({ fee_due_amount: 0, fee_settled_amount: 300, fee_waived: false, fee_received_by: order.actorId, fee_received_note: '銀行振込' });
      expect(row.fee_received_at).not.toBeNull();
      // 記録した後は、受け取りの記録も「いただかないで終える」も断る
      for (const waive of [false, true]) {
        await expectRejected(db(), 'select * from public.admin_record_return_fee_payment($1, $2, $3, $4)', [returnId, order.actorId, null, waive], {
          code: '22023',
          message: 'RETURN_STATE_CONFLICT',
        });
      }
    });

    test('お支払い待ちが最後の待ち物なら、受け取りを記録した時に返品が自動で完了になる', async () => {
      const { order, returnId } = await feeDueReturn();
      await closeMissing(db(), returnId, order.actorId);
      // 届かないで終えても、手数料のお支払い待ちが残るので完了にならない
      expect((await returnRow(db(), returnId)).status).toBe('open');
      expect(await displayStateOf(db(), returnId)).toMatchObject({ display_status: 'in_progress', marks: ['awaiting_fee'] });

      const res = await recordFeePayment(db(), returnId, order.actorId);

      expect(res.rows).toEqual([{ return_id: returnId, return_status: 'closed' }]);
      expect((await returnRow(db(), returnId)).fee_received_note).toBeNull();
      expect((await returnRow(db(), returnId)).fee_waived).toBe(false);
    });

    test('いただかないで終える（_waive）と、受け取りを記録した時と同じ時刻・人・メモが残り、fee_waived が真になる。額は決着した合計へ移り、最後の待ち物なら返品が自動で完了になる', async () => {
      const { order, returnId } = await feeDueReturn();
      await closeMissing(db(), returnId, order.actorId);
      expect(await displayStateOf(db(), returnId)).toMatchObject({ display_status: 'in_progress', marks: ['awaiting_fee'] });

      const res = await recordFeePayment(db(), returnId, order.actorId, '  店長の判断でいただかない  ', true);

      expect(res.rows).toEqual([{ return_id: returnId, return_status: 'closed' }]);
      const row = await returnRow(db(), returnId);
      // 決着した額は合計に残し、未収額を0にするので、新しい手数料に以前の免除分を含めない。
      expect(row).toMatchObject({
        status: 'closed',
        fee_due_amount: 0,
        fee_settled_amount: 300,
        fee_waived: true,
        fee_received_by: order.actorId,
        fee_received_note: '店長の判断でいただかない',
      });
      expect(row.fee_received_at).not.toBeNull();
      expect(await displayStateOf(db(), returnId)).toMatchObject({ display_status: 'returned', marks: [] });
    });

    test('お支払い待ちでない・受付中でない返品は、受け取りの記録も「いただかないで終える」も断る。長すぎるメモ、引数が空、知らない返品も断る', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const noFee = await openReturn(db(), order, [line(order, 0, 1)]);
      const cancelled = await openReturn(db(), order, [line(order, 0, 1)]);
      await db().query('update public.order_returns set fee_due_amount = 300 where id = $1', [cancelled]);
      await cancelReturn(db(), cancelled, order.actorId);
      const sql = 'select * from public.admin_record_return_fee_payment($1, $2, $3, $4)';

      for (const returnId of [noFee, cancelled]) {
        for (const waive of [false, true]) {
          await expectRejected(db(), sql, [returnId, order.actorId, null, waive], { code: '22023', message: 'RETURN_STATE_CONFLICT' });
        }
      }
      await expectRejected(db(), sql, [noFee, order.actorId, 'あ'.repeat(501), false], INVALID_ARGUMENT);
      await expectRejected(db(), sql, [null, order.actorId, null, false], INVALID_ARGUMENT);
      await expectRejected(db(), sql, [noFee, null, null, false], INVALID_ARGUMENT);
      await expectRejected(db(), sql, [noFee, order.actorId, null, null], INVALID_ARGUMENT);
      await expectRejected(db(), sql, [crypto.randomUUID(), order.actorId, null, false], { code: 'P0002', message: 'RETURN_NOT_FOUND' });
    });

    test('支払いを待たずに送ると、時刻と人が残る。手数料はお支払い待ちのまま残り、何度も押せない', async () => {
      const { order, returnId } = await feeDueReturn();

      const res = await releaseExchange(db(), returnId, order.actorId);

      expect(res.rows).toEqual([{ return_id: returnId, return_status: 'open' }]);
      const row = await returnRow(db(), returnId);
      expect(row).toMatchObject({ exchange_released_by: order.actorId, fee_due_amount: 300, fee_received_at: null });
      expect(row.exchange_released_at).not.toBeNull();
      expect(await displayStateOf(db(), returnId)).toMatchObject({ marks: ['awaiting_items', 'awaiting_fee'] });
      await expectRejected(db(), 'select * from public.admin_release_return_exchange($1, $2)', [returnId, order.actorId], {
        code: '22023',
        message: 'RETURN_STATE_CONFLICT',
      });
    });

    test('お支払い待ちでない・受け取りを記録済み（いただかないで終えた返品を含む）の返品は支払いを待たずに送れず、引数が空・知らない返品は断る', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      const noFee = await openReturn(db(), order, [line(order, 0, 1)]);
      const paid = await openReturn(db(), order, [line(order, 0, 1)]);
      await db().query('update public.order_returns set fee_due_amount = 300 where id = $1', [paid]);
      await recordFeePayment(db(), paid, order.actorId);
      const waived = await openReturn(db(), order, [line(order, 0, 1)]);
      await db().query('update public.order_returns set fee_due_amount = 300 where id = $1', [waived]);
      await recordFeePayment(db(), waived, order.actorId, null, true);
      const sql = 'select * from public.admin_release_return_exchange($1, $2)';

      for (const returnId of [noFee, paid, waived]) {
        await expectRejected(db(), sql, [returnId, order.actorId], { code: '22023', message: 'RETURN_STATE_CONFLICT' });
      }
      await expectRejected(db(), sql, [null, order.actorId], INVALID_ARGUMENT);
      await expectRejected(db(), sql, [noFee, null], INVALID_ARGUMENT);
      await expectRejected(db(), sql, [crypto.randomUUID(), order.actorId], { code: 'P0002', message: 'RETURN_NOT_FOUND' });
    });
  });

  describe('返品を作る画面の材料（get_order_return_materials）', () => {
    test('発送ごとに品と返品できる数と期限を並べ、交換の色・サイズと設定を添える。キーは C-2 の ReturnCreateMaterials の snake_case', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }], shipments: [{ 0: 2 }, { 0: 1 }] });
      const white = await addVariant(db(), order.catalogItemIds[0], { color: 'WHITE', size: 'L', stock: 3, active: false });
      await updateSettingsRow(db(), {
        window_days: 7,
        delivery_buffer_days: 3,
        window_start: 'each_item',
        no_return_needed_enabled: true,
        customer_paid_method: 'shop_label',
        shop_label_fee: 800,
        restocking_fee_enabled: true,
        restocking_fee_percent: 10,
        exchange_fees_enabled: true,
        exchange_fee: 300,
        exchange_shipping_fee: 500,
      });
      await db().query("update public.shop_return_reason_settings set shipping_payer = 'shop' where reason = 'defective'");
      await db().query("update public.shop_return_reason_settings set out_of_stock_exchange = 'make' where reason = 'size_too_small'");

      const materials = (await materialsOf(db(), order.orderId)) as Row;

      expect(keysOf(materials)).toEqual(sorted(['order', 'shipments', 'exchange_options', 'settings']));
      expect(keysOf(materials.order)).toEqual(sorted(['id', 'status', 'has_awaiting_refund']));
      expect(materials.order).toEqual({ id: order.orderId, status: 'shipped', has_awaiting_refund: false });

      // 発送ごと（番号の順）。返品できる数は、発送の行の数と注文の商品の数の小さい方
      expect(materials.shipments.map((shipment: Row) => [shipment.fulfillment_id, shipment.number])).toEqual([
        [order.fulfillmentIds[0], 1],
        [order.fulfillmentIds[1], 2],
      ]);
      expect(keysOf(materials.shipments[0])).toEqual(
        sorted(['fulfillment_id', 'number', 'shipped_at', 'deadline_date', 'past_deadline', 'lines']),
      );
      expect(keysOf(materials.shipments[0].lines[0])).toEqual(
        sorted(['order_item_id', 'item_id', 'variant_id', 'item_name', 'color', 'size', 'line_kind', 'quantity', 'returnable', 'return_ineligible']),
      );
      expect(materials.shipments[0].lines).toEqual([
        {
          order_item_id: order.itemIds[0],
          item_id: order.catalogItemIds[0],
          variant_id: order.variantIds[0],
          item_name: '照合テスト',
          color: 'BLACK',
          size: 'M',
          line_kind: 'order',
          quantity: 2,
          returnable: 2,
          return_ineligible: false,
        },
      ]);
      expect(materials.shipments[1].lines[0]).toMatchObject({ quantity: 1, returnable: 1 });
      expect(materials.shipments.map((shipment: Row) => shipment.past_deadline)).toEqual([false, false]);
      // 期限は日本時間の発送日 + 目安 3日 + 日数 7日
      const expected = await db().query(
        "select ((f.shipped_at at time zone 'Asia/Tokyo')::date + 10)::text as deadline from public.order_fulfillments as f where f.id = $1",
        [order.fulfillmentIds[0]],
      );
      expect(materials.shipments[0].deadline_date).toBe(expected.rows[0].deadline);

      // 交換の色・サイズ: 発送した品と同じ商品の全部（使えない物は is_active が偽）
      expect(materials.exchange_options).toHaveLength(1);
      expect(keysOf(materials.exchange_options[0])).toEqual(sorted(['item_id', 'variants']));
      expect(materials.exchange_options[0].item_id).toBe(order.catalogItemIds[0]);
      expect(keysOf(materials.exchange_options[0].variants[0])).toEqual(
        sorted(['variant_id', 'color', 'size', 'is_active', 'stock_quantity', 'made_to_order_lead_days']),
      );
      expect(materials.exchange_options[0].variants).toEqual(
        expect.arrayContaining([
          { variant_id: order.variantIds[0], color: 'BLACK', size: 'M', is_active: true, stock_quantity: 0, made_to_order_lead_days: null },
          { variant_id: white, color: 'WHITE', size: 'L', is_active: false, stock_quantity: 3, made_to_order_lead_days: null },
        ]),
      );

      // 設定: 返送先の有無、手数料、理由ごとの返送料の負担と在庫の無い交換（キーは理由の記号そのまま）
      const reasons = ['defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style', 'not_as_described', 'unwanted', 'other', 'unknown'];
      expect(keysOf(materials.settings)).toEqual(
        sorted([
          'return_address_set',
          'no_return_needed_enabled',
          'customer_paid_method',
          'shop_label_fee',
          'restocking_fee_enabled',
          'restocking_fee_percent',
          'exchange_fees_enabled',
          'exchange_fee',
          'exchange_shipping_fee',
          'reason_shipping_payers',
          'reason_out_of_stock_exchange',
        ]),
      );
      expect(materials.settings).toMatchObject({
        return_address_set: true,
        no_return_needed_enabled: true,
        customer_paid_method: 'shop_label',
        shop_label_fee: 800,
        restocking_fee_enabled: true,
        restocking_fee_percent: 10,
        exchange_fees_enabled: true,
        exchange_fee: 300,
        exchange_shipping_fee: 500,
      });
      expect(keysOf(materials.settings.reason_shipping_payers)).toEqual(sorted(reasons));
      expect(keysOf(materials.settings.reason_out_of_stock_exchange)).toEqual(sorted(reasons));
      expect(materials.settings.reason_shipping_payers.defective).toBe('shop');
      expect(materials.settings.reason_out_of_stock_exchange.size_too_small).toBe('make');
    });

    test('返品を作ると返品できる数が減り、返事待ちの返金があれば has_awaiting_refund が真になる。返送先の有無も出す', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }], shipments: [{ 0: 2 }, { 0: 1 }] });
      await openReturn(db(), order, [line(order, 0, 2)]);

      const created = (await materialsOf(db(), order.orderId)) as Row;
      // 1回目の発送の2点は返品が指している。2回目の1点は、注文の商品の残り（3 − 2 = 1）まで
      expect(created.shipments.map((shipment: Row) => shipment.lines[0].returnable)).toEqual([0, 1]);

      await insertRefundRecord(db(), { orderId: order.orderId, status: 'awaiting_response', amount: 1000 });
      await updateSettingsRow(db(), {
        return_address_name: null,
        return_address_postal_code: null,
        return_address_line: null,
        return_address_phone: null,
      });
      const waiting = (await materialsOf(db(), order.orderId)) as Row;
      expect(waiting.order.has_awaiting_refund).toBe(true);
      expect(waiting.settings.return_address_set).toBe(false);
    });

    test('取り消した発送は載せない。期限は日本時間の日付で、過ぎていれば past_deadline が真、無制限なら期限は空', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }], shipments: [{ 0: 2 }, { 0: 1 }] });
      await updateSettingsRow(db(), { window_days: 7, delivery_buffer_days: 3, window_start: 'each_item' });
      // 1回目の発送を40日前にずらす（発送の記録は後から変えられないので、トリガーを止めて直す）
      await db().query('set local session_replication_role = replica');
      await db().query("update public.order_fulfillments set shipped_at = now() - interval '40 days' where id = $1", [order.fulfillmentIds[0]]);
      await db().query('set local session_replication_role = origin');

      const late = (await materialsOf(db(), order.orderId)) as Row;
      expect(late.shipments.map((shipment: Row) => shipment.past_deadline)).toEqual([true, false]);
      const expected = await db().query(
        "select ((f.shipped_at at time zone 'Asia/Tokyo')::date + 10)::text as deadline from public.order_fulfillments as f where f.id = $1",
        [order.fulfillmentIds[0]],
      );
      expect(late.shipments[0].deadline_date).toBe(expected.rows[0].deadline);

      await updateSettingsRow(db(), { window_days: null });
      const unlimited = (await materialsOf(db(), order.orderId)) as Row;
      expect(unlimited.shipments.map((shipment: Row) => [shipment.deadline_date, shipment.past_deadline])).toEqual([
        [null, false],
        [null, false],
      ]);

      await cancelFulfillment(db(), order.orderId, order.fulfillmentIds[1], order.actorId);
      const cancelled = (await materialsOf(db(), order.orderId)) as Row;
      expect(cancelled.shipments.map((shipment: Row) => shipment.fulfillment_id)).toEqual([order.fulfillmentIds[0]]);
    });

    test('知らない注文は空を返す', async () => {
      expect(await materialsOf(db(), crypto.randomUUID())).toBeNull();
    });
  });

  describe('注文の返品の中身（list_order_returns）', () => {
    test('返金と交換の行・進み具合・返金・受け取り・交換の品を返す。キーは C-2 の OrderReturnDetail の snake_case（label は入れない）', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      const white = await addVariant(db(), order.catalogItemIds[0], { color: 'WHITE', size: 'L', stock: 4 });
      await db().query("update public.shop_return_reason_settings set out_of_stock_exchange = 'make' where reason = 'size_too_small'");
      const returnId = await openReturn(
        db(),
        order,
        [
          line(order, 0, 1),
          line(order, 0, 1, { resolution: 'exchange', exchange_variant_id: white, exchange_method: 'stock', reason: 'size_too_small' }),
        ],
        { method: 'shop_label', payer: 'customer', carrier: 'yamato', tracking: '1234-5678', shippingFee: 800, shopNote: 'メモ' },
      );
      const refundLineId = await lineIdOf(db(), returnId, order.itemIds[0]);
      const exchangeLineId = await lineIdOf(db(), returnId, order.itemIds[0], 'exchange');
      // 返金の品の1点を受け取って、返金も済んでいる。交換の品は足してあるが、まだ受け取りの記録は無い
      const receiptId = await insertReceipt(db(), returnId, {
        actorId: order.actorId,
        lines: [{ returnLineId: refundLineId, disposition: 'restocked', quantity: 1 }],
      });
      const refundId = await insertReturnRefundRow(db(), order, returnId, { itemIndex: 0, quantity: 1, amount: PRICE, status: 'succeeded' });
      const exchangeItemId = await insertExchangeItem(db(), order, 0, exchangeLineId, white);

      const [detail] = await listReturns(db(), order.orderId);

      expect(keysOf(detail)).toEqual(
        sorted([
          'id', 'number', 'status', 'source', 'display_status', 'marks', 'return_method', 'return_shipping_payer', 'return_carrier',
          'return_tracking_number', 'fees', 'first_receipt_done', 'first_exchange_receipt_done', 'shop_note', 'notify_customer',
          'created_at', 'created_by_email', 'closed_at', 'cancelled_at', 'lines', 'refunds', 'receipts', 'exchange_items',
          'requested_at', 'approved_at', 'approved_by_email', 'declined_at', 'decline_reason', 'decline_message',
        ]),
      );
      expect(keysOf(detail.fees)).toEqual(
        sorted([
          'return_shipping_fee', 'restocking_fee_percent', 'exchange_fee', 'exchange_shipping_fee', 'fee_due_amount',
          'fee_pending_deduction', 'fee_received_at', 'exchange_released_at',
        ]),
      );
      expect(detail).toMatchObject({
        id: returnId,
        number: 1,
        status: 'open',
        source: 'shop',
        display_status: 'in_progress',
        marks: ['partially_received'],
        return_method: 'shop_label',
        return_shipping_payer: 'customer',
        return_carrier: 'yamato',
        return_tracking_number: '1234-5678',
        fees: {
          return_shipping_fee: 800,
          restocking_fee_percent: 0,
          exchange_fee: 0,
          exchange_shipping_fee: 0,
          fee_due_amount: 0,
          fee_pending_deduction: 0,
          fee_received_at: null,
          exchange_released_at: null,
        },
        first_receipt_done: true,
        first_exchange_receipt_done: false,
        shop_note: 'メモ',
        notify_customer: true,
        created_by_email: order.actorEmail,
        closed_at: null,
        cancelled_at: null,
      });

      // 行は発送・商品の順、同じ商品は解決の名前順（exchange → refund）
      expect(detail.lines).toHaveLength(2);
      const [exchangeLine, refundLine] = detail.lines as Row[];
      const lineKeys = sorted([
        'id', 'fulfillment_id', 'fulfillment_number', 'order_item_id', 'item_name', 'color', 'size', 'quantity', 'reason', 'reason_note',
        'resolution', 'exchange', 'progress', 'refund_amounts_by_count', 'refund_waiting_amount',
        'customer_note', 'requested_resolution', 'requested_exchange', 'photos', 'return_ineligible',
      ]);
      const progressKeys = sorted([
        'restocked', 'not_restocked', 'pending_inspection', 'sent_back', 'missing', 'processed', 'unprocessed', 'exchanged',
        'refund_covered', 'refund_waived', 'refund_waiting',
      ]);
      expect(keysOf(exchangeLine)).toEqual(lineKeys);
      expect(keysOf(exchangeLine.progress)).toEqual(progressKeys);
      expect(exchangeLine).toMatchObject({
        id: exchangeLineId,
        fulfillment_id: order.fulfillmentIds[0],
        fulfillment_number: 1,
        order_item_id: order.itemIds[0],
        item_name: '照合テスト',
        color: 'BLACK',
        size: 'M',
        quantity: 1,
        reason: 'size_too_small',
        reason_note: null,
        resolution: 'exchange',
        // 受付中の返品の交換の予定の行にも、返金に変えた時の見込みが入る。長さはこの返品で同じ注文の商品を指す行の未処理の合計（1点）。返品の返金で1点返してあるので、2点目の額（値引きの無い注文で 5000円）
        refund_amounts_by_count: [PRICE],
        refund_waiting_amount: 0,
      });
      expect(keysOf(exchangeLine.exchange)).toEqual(
        sorted(['variant_id', 'color', 'size', 'method', 'stock_quantity', 'made_to_order_lead_days', 'out_of_stock_exchange']),
      );
      expect(exchangeLine.exchange).toEqual({
        variant_id: white,
        color: 'WHITE',
        size: 'L',
        method: 'stock',
        stock_quantity: 4,
        made_to_order_lead_days: null,
        out_of_stock_exchange: 'make',
      });
      expect(exchangeLine.progress).toEqual({
        restocked: 0,
        not_restocked: 0,
        pending_inspection: 0,
        sent_back: 0,
        missing: 0,
        processed: 0,
        unprocessed: 1,
        exchanged: 0,
        refund_covered: 0,
        refund_waived: 0,
        refund_waiting: 0,
      });

      expect(keysOf(refundLine)).toEqual(lineKeys);
      expect(refundLine).toMatchObject({
        id: refundLineId,
        reason: 'defective',
        resolution: 'refund',
        exchange: null,
        // 受け取り済みの行でも、同じ注文の商品の交換の予定の行に未処理が1点あるので、同じ列を持つ（C-2）
        refund_amounts_by_count: [PRICE],
        refund_waiting_amount: 0,
      });
      expect(keysOf(refundLine.progress)).toEqual(progressKeys);
      expect(refundLine.progress).toMatchObject({ restocked: 1, processed: 1, unprocessed: 0, refund_covered: 1, refund_waiting: 0 });

      expect(detail.refunds).toEqual([{ id: refundId, amount: PRICE, status: 'succeeded', created_at: expect.any(String) }]);
      expect(detail.receipts).toEqual([
        { id: receiptId, kind: 'receive', refund_choice: 'none', created_at: expect.any(String), actor_email: order.actorEmail },
      ]);
      expect(detail.exchange_items).toEqual([
        { order_item_id: exchangeItemId, item_name: '交換テスト', color: 'WHITE', size: 'L', quantity: 1, fulfillment_type: 'stock', shipped: 0 },
      ]);
      expect(keysOf(detail.refunds[0])).toEqual(sorted(['id', 'amount', 'status', 'created_at']));
      expect(keysOf(detail.receipts[0])).toEqual(sorted(['id', 'kind', 'refund_choice', 'created_at', 'actor_email']));
      expect(keysOf(detail.exchange_items[0])).toEqual(
        sorted(['order_item_id', 'item_name', 'color', 'size', 'quantity', 'fulfillment_type', 'shipped']),
      );
    });

    test('額を決めて返金する時に引く手数料（fee_pending_deduction）と、お支払い待ちの手数料（fee_due_amount）を別々に返す', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 1)]);
      // 相談の受け取りで付いた手数料は fee_pending_deduction に、引けなかった手数料は fee_due_amount に、受け取りの関数（移行 C）が足す。ここでは列を直接書く
      await db().query('update public.order_returns set fee_pending_deduction = 150, fee_due_amount = 300 where id = $1', [returnId]);

      const [detail] = await listReturns(db(), order.orderId);

      expect(detail.fees).toEqual({
        return_shipping_fee: 0,
        restocking_fee_percent: 0,
        exchange_fee: 0,
        exchange_shipping_fee: 0,
        fee_due_amount: 300,
        fee_pending_deduction: 150,
        fee_received_at: null,
        exchange_released_at: null,
      });
    });

    test('新しい返品（番号の大きい順）から返し、取り消した返品も返す。見込みの額は受付中の返品だけが持ち、取り消した返品は空', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      const first = await openReturn(db(), order, [line(order, 0, 1)]);
      await cancelReturn(db(), first, order.actorId);
      const second = await openReturn(db(), order, [line(order, 0, 2)]);

      const list = await listReturns(db(), order.orderId);

      expect(list.map((item) => [item.id, item.number, item.status, item.display_status, item.marks])).toEqual([
        [second, 2, 'open', 'in_progress', ['awaiting_items']],
        [first, 1, 'cancelled', null, []],
      ]);
      expect(list[1].cancelled_at).not.toBeNull();
      // 値引きの無い注文: 1点 5000円、2点 10000円。取り消した返品は見込みを出さない
      expect(list[0].lines[0].refund_amounts_by_count).toEqual([PRICE, PRICE * 2]);
      expect(list[1].lines[0].refund_amounts_by_count).toEqual([]);
    });

    test('返金の解決の行の見込みの額は、E-2 の割引の割り振りと同じ額（割引のある注文）。返品の無い注文・知らない注文は空の配列', async () => {
      const spec: OrderSpec = { lines: [{ quantity: 2, price: 3000 }, { quantity: 3, price: 1000 }], shippingAmount: 500, discountAmount: 1000 };
      const order = await createShippedOrder(db(), spec);
      const twin = await createShippedOrder(db(), spec);
      await openReturn(db(), order, [line(order, 0, 2), line(order, 1, 3)]);

      const [detail] = await listReturns(db(), order.orderId);

      // 商品の割引は 667 円と 333 円。k 点の額 = 単価 × k − (disc(k) − disc(0))。X: disc(1) = 334・disc(2) = 667、Y: disc(1) = 111・disc(2) = 222・disc(3) = 333
      const byItem = Object.fromEntries((detail.lines as Row[]).map((item) => [item.order_item_id, item]));
      expect(byItem[order.itemIds[0]].refund_amounts_by_count).toEqual([2666, 5333]);
      expect(byItem[order.itemIds[1]].refund_amounts_by_count).toEqual([889, 1778, 2667]);

      // 同じ注文を E-2 の返金を始める関数で、発送後の全部の品を返金した時の行の額と、見込みの最後の額が同じ
      const refund = await db().query('select * from public.begin_order_refund($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)', [
        twin.orderId,
        'admin',
        crypto.randomUUID(),
        JSON.stringify([
          { order_item_id: twin.itemIds[0], quantity: 2, before_shipment: false },
          { order_item_id: twin.itemIds[1], quantity: 3, before_shipment: false },
        ]),
        false,
        0,
        8000,
        null,
        'requested_by_customer',
        null,
        false,
        twin.actorId,
        null,
      ]);
      const refundLines = await db().query('select order_item_id, amount from public.order_refund_lines where refund_id = $1', [
        refund.rows[0].refund_id,
      ]);
      expect(Object.fromEntries(refundLines.rows.map((row) => [row.order_item_id, row.amount]))).toEqual({
        [twin.itemIds[0]]: 5333,
        [twin.itemIds[1]]: 2667,
      });

      expect(await listReturns(db(), twin.orderId)).toEqual([]);
      expect(await listReturns(db(), crypto.randomUUID())).toEqual([]);
    });

    test('交換の予定の行にも、受付中の返品の未処理の数（その注文の商品を指す行の合計）だけ見込みの額が入る（受け取りで「返金に変える」時の見込み）。受け取りが進むと残りの数だけになり、取り消した返品は空', async () => {
      const order = await createShippedOrder(db(), {
        lines: [{ quantity: 2, price: 3000 }, { quantity: 3, price: 1000 }],
        shippingAmount: 500,
        discountAmount: 1000,
      });
      const white = await addVariant(db(), order.catalogItemIds[0], { color: 'WHITE', size: 'L', stock: 4 });
      const exchangePlan = { resolution: 'exchange', exchange_variant_id: white, exchange_method: 'stock', reason: 'size_too_small' };
      const cancelled = await openReturn(db(), order, [line(order, 0, 1, exchangePlan)]);
      await cancelReturn(db(), cancelled, order.actorId);
      const returnId = await openReturn(db(), order, [line(order, 0, 2, exchangePlan), line(order, 1, 3)]);

      const list = await listReturns(db(), order.orderId);

      expect(list.map((item) => item.id)).toEqual([returnId, cancelled]);
      // 商品 X（交換の予定）も、返金に変えた時の見込みを出す。額は返金の予定の行と同じ式（X: 2666・5333円、Y: 889・1778・2667円）
      const byItem = Object.fromEntries((list[0].lines as Row[]).map((item) => [item.order_item_id, item]));
      expect(byItem[order.itemIds[0]]).toMatchObject({ resolution: 'exchange', refund_amounts_by_count: [2666, 5333] });
      expect(byItem[order.itemIds[1]]).toMatchObject({ resolution: 'refund', refund_amounts_by_count: [889, 1778, 2667] });
      // 取り消した返品は、交換の予定の行にも見込みを出さない
      expect(list[1].lines[0]).toMatchObject({ resolution: 'exchange', refund_amounts_by_count: [] });

      // 交換の予定の1点を受け取ると、見込みは残りの1点だけになる（受け取った1点は交換にするので、先に返した数に入らない）
      const exchangeLineId = await lineIdOf(db(), returnId, order.itemIds[0], 'exchange');
      await insertReceipt(db(), returnId, { lines: [{ returnLineId: exchangeLineId, disposition: 'restocked', quantity: 1 }] });

      const [received] = await listReturns(db(), order.orderId);

      const receivedExchange = (received.lines as Row[]).find((item) => item.resolution === 'exchange');
      expect(receivedExchange?.progress).toMatchObject({ restocked: 1, exchanged: 1, unprocessed: 1 });
      expect(receivedExchange?.refund_amounts_by_count).toEqual([2666]);
    });

    test('同じ注文の商品を指す行が2つある時（2回に分けて送った品）は、両方の行がその商品の同じ列を持つ。長さは2行の未処理の合計（受け取りが注文の商品ごとに数を足して1回で額を出すのに合わせる。C-2）。行は発送の番号の順に返る', async () => {
      const order = await createShippedOrder(db(), {
        lines: [{ quantity: 2, price: 3000 }, { quantity: 3, price: 1000 }],
        shipments: [{ 0: 1, 1: 3 }, { 0: 1 }],
        shippingAmount: 500,
        discountAmount: 1000,
      });
      // 2回目の発送の行を先に入力しても、返る行は発送の番号の順（「返品の行の並び」。決め事 6）
      const returnId = await openReturn(db(), order, [
        line(order, 0, 1, { fulfillment_id: order.fulfillmentIds[1] }),
        line(order, 0, 1),
        line(order, 1, 1),
      ]);

      const [detail] = await listReturns(db(), order.orderId);

      // 行の並びは 発送の番号 → 注文の商品の登録順（X が先、Y が後）。2回目の発送の X は最後
      expect((detail.lines as Row[]).map((item) => [item.order_item_id, item.fulfillment_id])).toEqual([
        [order.itemIds[0], order.fulfillmentIds[0]],
        [order.itemIds[1], order.fulfillmentIds[0]],
        [order.itemIds[0], order.fulfillmentIds[1]],
      ]);
      // X の2行は同じ列 [2666, 5333]（2点をまとめて返すと 6000 − 667 = 5333。行ごとに [2666] を2つ足すと 5332 になる）。Y は Y だけの列
      const xLines = (detail.lines as Row[]).filter((item) => item.order_item_id === order.itemIds[0]);
      expect(xLines.map((item) => [item.fulfillment_id, item.refund_amounts_by_count])).toEqual([
        [order.fulfillmentIds[0], [2666, 5333]],
        [order.fulfillmentIds[1], [2666, 5333]],
      ]);
      expect((detail.lines as Row[]).find((item) => item.order_item_id === order.itemIds[1])?.refund_amounts_by_count).toEqual([889]);

      // 1回目の発送の行を受け取ると（返金はまだ。返金待ち）、残りは2回目の発送の1点だけ。2行とも残りの1点の列になる
      await insertReceipt(db(), returnId, { lines: [{ returnLineId: xLines[0].id as string, disposition: 'restocked', quantity: 1 }] });

      const [received] = await listReturns(db(), order.orderId);

      expect(
        (received.lines as Row[]).filter((item) => item.order_item_id === order.itemIds[0]).map((item) => item.refund_amounts_by_count),
      ).toEqual([[2666], [2666]]);
    });

    test('ふつうの返金で先に返した数は、前に返した数として足す（2点のうち先に1点を返した後の最後の1点は 2667円）', async () => {
      const order = await createShippedOrder(db(), {
        lines: [{ quantity: 2, price: 3000 }, { quantity: 3, price: 1000 }],
        shippingAmount: 500,
        discountAmount: 1000,
      });
      await insertRefundRecord(db(), {
        orderId: order.orderId,
        status: 'succeeded',
        amount: 2666,
        lines: [{ orderItemId: order.itemIds[0], quantity: 1, beforeShipment: false, amount: 2666 }],
      });
      await openReturn(db(), order, [line(order, 0, 1)]);

      const [detail] = await listReturns(db(), order.orderId);

      expect(detail.lines[0].refund_amounts_by_count).toEqual([2667]);
    });

    test('返金待ちの品の額は、同じ商品を指す行を合わせた額に一致し（額を決めて返金する時に1行にまとまる）、返金しないことにした数・交換にした数も進み具合に出る', async () => {
      const order = await createShippedOrder(db(), {
        lines: [{ quantity: 2, price: 3000 }, { quantity: 3, price: 1000 }],
        shippingAmount: 500,
        discountAmount: 1000,
      });
      // 商品 X の2点を、1点ずつ2つの行に分けて受け取る
      const split = await openReturn(db(), order, [line(order, 0, 1), line(order, 0, 1, { reason: 'unwanted' })]);
      const splitLines = await returnLineRows(db(), split);
      await insertReceipt(db(), split, {
        lines: splitLines.map((row) => ({ returnLineId: row.id as string, disposition: 'restocked' as const, quantity: 1 })),
      });

      const [waiting] = await listReturns(db(), order.orderId);

      // 2点を合わせると 6000 − 667 = 5333 円。行ごとの額は 2666 円と 2667 円で、前の行の数を前に返した数として足している
      expect((waiting.lines as Row[]).map((item) => item.refund_waiting_amount).sort((a, b) => a - b)).toEqual([2666, 2667]);
      expect((waiting.lines as Row[]).map((item) => item.progress.refund_waiting)).toEqual([1, 1]);
      expect(waiting.display_status).toBe('refund_waiting');
    });

    test('返金しないことにした数（waive_refund の受け取り）と、交換にした数が進み具合に出て、受け取りの種類にも出る', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 4 }] });
      const white = await addVariant(db(), order.catalogItemIds[0], { color: 'WHITE', size: 'L', stock: 4 });
      const returnId = await openReturn(db(), order, [
        line(order, 0, 2),
        line(order, 0, 1, { resolution: 'exchange', exchange_variant_id: white, exchange_method: 'make', reason: 'size_too_small' }),
      ]);
      const refundLineId = await lineIdOf(db(), returnId, order.itemIds[0]);
      const exchangeLineId = await lineIdOf(db(), returnId, order.itemIds[0], 'exchange');
      await insertReceipt(db(), returnId, {
        minutesAgo: 10,
        lines: [
          { returnLineId: refundLineId, disposition: 'restocked', quantity: 2 },
          { returnLineId: exchangeLineId, disposition: 'restocked', quantity: 1 },
        ],
      });
      await insertReceipt(db(), returnId, {
        kind: 'waive_refund',
        minutesAgo: 5,
        lines: [{ returnLineId: refundLineId, disposition: 'refund_waived', quantity: 2 }],
      });

      const [detail] = await listReturns(db(), order.orderId);

      const byResolution = Object.fromEntries((detail.lines as Row[]).map((item) => [item.resolution, item]));
      expect(byResolution.refund.progress).toMatchObject({ restocked: 2, refund_waived: 2, refund_waiting: 0 });
      expect(byResolution.refund.refund_waiting_amount).toBe(0);
      expect(byResolution.exchange.progress).toMatchObject({ restocked: 1, exchanged: 1, refund_waiting: 0 });
      // 新しい受け取りから
      expect((detail.receipts as Row[]).map((item) => [item.kind, item.refund_choice])).toEqual([
        ['waive_refund', null],
        ['receive', 'none'],
      ]);
      // 受け取りの行に残した実際の解決（交換）で、交換の手数料と送料の「最初」の受け取りが済んだことを見る
      expect(detail.first_receipt_done).toBe(true);
      expect(detail.first_exchange_receipt_done).toBe(true);
    });
  });

  describe('完了した返品の返金が失敗した後（P21）', () => {
    test('完了のままでも返金待ちとして返し、額を決めて返金する見込みの額を出す', async () => {
      const { order, returnId, refundId } = await createFailedRefundReturn(db());

      const [detail] = await listReturns(db(), order.orderId);

      expect(detail).toMatchObject({ id: returnId, status: 'closed', display_status: 'refund_waiting', marks: [] });
      expect(detail.lines[0].progress).toMatchObject({ refund_covered: 0, refund_waiting: 1, unprocessed: 0 });
      expect(detail.lines[0].refund_waiting_amount).toBe(PRICE);
      // 完了した返品は、受け取りの見込みを出さない
      expect(detail.lines[0].refund_amounts_by_count).toEqual([]);
      expect(detail.refunds).toEqual([{ id: refundId, amount: PRICE, status: 'failed', created_at: expect.any(String) }]);
      expect(await displayStateOf(db(), returnId)).toMatchObject({ display_status: 'refund_waiting', unprocessed: 0, refund_waiting: 1 });
    });
  });

  describe('返金の額の部品（private.return_refund_amount）', () => {
    test('注文の商品は割引の差、交換の品の行は支払額の累積の割り振り、点数が0なら0円、注文の数を超える点数は頭打ち', async () => {
      const amount = async (...args: Array<string | number | null>): Promise<number> =>
        (await db().query('select private.return_refund_amount($1, $2, $3, $4, $5, $6, $7) as amount', args)).rows[0].amount as number;

      // 値 A の X（3000円・2点・割引 667円）
      expect([await amount('order', 3000, 2, 667, null, 0, 1), await amount('order', 3000, 2, 667, null, 0, 2), await amount('order', 3000, 2, 667, null, 1, 1)]).toEqual([
        2666, 5333, 2667,
      ]);
      expect([await amount('order', 3000, 2, 667, null, 0, 0), await amount('order', 3000, 2, 667, null, 1, 5)]).toEqual([0, 2667]);
      // 交換の品の行（元の品の支払額 5000円・2点）
      expect([await amount('exchange', 0, 2, 0, 5000, 0, 1), await amount('exchange', 0, 2, 0, 5000, 0, 2), await amount('exchange', 0, 2, 0, 5000, 1, 1)]).toEqual([
        2500, 5000, 2500,
      ]);
    });
  });

  describe('一覧の要約・一行の数・絞り込み', () => {
    test('注文ごとに、返品の状態・印・次にすること・返品できる品の有無・件数を返す。知らない注文の行は返さない', async () => {
      const { orders, unshipped } = await buildReturnScenario(db());
      const ids = [...Object.values(orders).map((order) => order.orderId), unshipped, crypto.randomUUID()];

      const summaries = await summariesOf(db(), ids);

      expect(Object.keys(summaries).sort()).toEqual(ids.slice(0, -1).sort());
      // 注文の番号の列を除いた、残りの列
      const view = (orderId: string): Row => Object.fromEntries(Object.entries(summaries[orderId]).filter(([key]) => key !== 'order_id'));
      const empty = { refund_waiting_returns: 0, requested_returns: 0 };
      expect(keysOf(summaries[orders.none.orderId])).toEqual(
        sorted(['order_id', 'display_status', 'marks', 'next_action', 'has_returnable', 'refund_waiting_returns', 'requested_returns']),
      );
      expect(view(orders.none.orderId)).toEqual({ display_status: null, marks: [], next_action: 'none', has_returnable: true, ...empty });
      expect(view(orders.awaitingItems.orderId)).toEqual({
        display_status: 'in_progress',
        marks: ['awaiting_items'],
        next_action: 'receive',
        has_returnable: false,
        ...empty,
      });
      // 受け取った1点が返金待ちで、残りの1点が未処理: 次にすることは「返金」（受け取りより先）
      expect(view(orders.partial.orderId)).toEqual({
        display_status: 'in_progress',
        marks: ['partially_received'],
        next_action: 'refund',
        has_returnable: false,
        ...empty,
      });
      expect(view(orders.refundWaiting.orderId)).toEqual({
        display_status: 'refund_waiting',
        marks: [],
        next_action: 'refund',
        has_returnable: false,
        refund_waiting_returns: 2,
        requested_returns: 0,
      });
      expect(view(orders.inspection.orderId)).toEqual({
        display_status: 'in_progress',
        marks: ['pending_inspection'],
        next_action: 'none',
        has_returnable: false,
        ...empty,
      });
      expect(view(orders.returned.orderId)).toEqual({ display_status: 'returned', marks: [], next_action: 'none', has_returnable: true, ...empty });
      // 取消の返品しかない注文には、返品の状態を出さない
      expect(view(orders.cancelled.orderId)).toEqual({ display_status: null, marks: [], next_action: 'none', has_returnable: true, ...empty });
      expect(view(orders.feeDue.orderId)).toEqual({
        display_status: 'in_progress',
        marks: ['awaiting_fee'],
        next_action: 'none',
        has_returnable: true,
        ...empty,
      });
      // 返品が2つ: いちばん手前の状態（返品中）を出す
      expect(view(orders.twoReturns.orderId)).toEqual({
        display_status: 'in_progress',
        marks: ['awaiting_items'],
        next_action: 'receive',
        has_returnable: true,
        ...empty,
      });
      expect(view(orders.requested.orderId)).toEqual({
        display_status: 'requested',
        marks: [],
        next_action: 'review_request',
        has_returnable: true,
        refund_waiting_returns: 0,
        requested_returns: 1,
      });
      // 完了した返品の返金が失敗して返金待ちの品が戻った後も、返金待ち（P21）
      expect(view(orders.failedRefund.orderId)).toEqual({
        display_status: 'refund_waiting',
        marks: [],
        next_action: 'refund',
        has_returnable: false,
        refund_waiting_returns: 1,
        requested_returns: 0,
      });
      expect(view(unshipped)).toEqual({ display_status: null, marks: [], next_action: 'none', has_returnable: false, ...empty });
    });

    test('受付中の返品が2つある注文の印は、2つの返品の印を決まった順に合わせた物', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }] });
      const partial = await openReturn(db(), order, [line(order, 0, 2)]);
      await insertReceipt(db(), partial, {
        lines: [{ returnLineId: await lineIdOf(db(), partial, order.itemIds[0]), disposition: 'restocked', quantity: 1 }],
      });
      const feeDue = await openReturn(db(), order, [line(order, 0, 1)]);
      await db().query('update public.order_returns set fee_due_amount = 300 where id = $1', [feeDue]);

      const summaries = await summariesOf(db(), [order.orderId]);

      // 1つ目は一部受け取り、2つ目は受け取り待ちでお支払い待ち。印は 受け取り待ち → 一部受け取り → 検品待ち → お支払い待ち の順
      expect(summaries[order.orderId]).toMatchObject({
        display_status: 'in_progress',
        marks: ['awaiting_items', 'partially_received', 'awaiting_fee'],
      });
    });

    test('一覧の1ページは200件まで（TOO_MANY_ORDERS）。空の渡し方は何も返さない', async () => {
      await expectRejected(
        db(),
        'select * from public.list_order_return_summaries($1::uuid[])',
        [Array.from({ length: 201 }, () => crypto.randomUUID())],
        { code: '22023', message: 'TOO_MANY_ORDERS' },
      );
      expect((await db().query('select * from public.list_order_return_summaries($1::uuid[])', [[]])).rows).toEqual([]);
      expect((await db().query('select * from public.list_order_return_summaries(null)')).rows).toEqual([]);
    });

    test('一覧の上の一行の数は、返品の申し込みがある注文の数と、返金待ちの返品がある注文の数（返品ではなく注文を数える）', async () => {
      const before = await attentionOf(db());

      await buildReturnScenario(db());

      const after = await attentionOf(db());
      // 返品の申し込みの注文が1つ。返金待ちは、返金待ちの返品が2つある注文が1つ、完了後に返金が失敗した注文が1つ
      expect({ requested: after.requested - before.requested, refund_waiting: after.refund_waiting - before.refund_waiting }).toEqual({
        requested: 1,
        refund_waiting: 2,
      });
    });

    test('絞り込みは、その状態の返品がどれか1つでもある注文を返す。完了後に返金が失敗した注文は「返品済み」でなく「返金待ち」', async () => {
      const { orders } = await buildReturnScenario(db());
      const idsOf = async (status: string) => new Set(await orderIdsByStatus(db(), status));
      const requested = await idsOf('requested');
      const inProgress = await idsOf('in_progress');
      const refundWaiting = await idsOf('refund_waiting');
      const returned = await idsOf('returned');

      const pick = (ids: Set<string>) => Object.entries(orders).filter(([, order]) => ids.has(order.orderId)).map(([name]) => name).sort();
      expect(pick(requested)).toEqual(['requested']);
      expect(pick(inProgress)).toEqual(['awaitingItems', 'feeDue', 'inspection', 'partial', 'twoReturns']);
      expect(pick(refundWaiting)).toEqual(['failedRefund', 'refundWaiting']);
      // 返品が2つの注文は、1つが完了なので「返品済み」にも出る
      expect(pick(returned)).toEqual(['returned', 'twoReturns']);

      await expectRejected(db(), 'select * from public.list_order_ids_by_return_status($1)', ['all'], INVALID_ARGUMENT);
      await expectRejected(db(), 'select * from public.list_order_ids_by_return_status($1)', [null], INVALID_ARGUMENT);
    });
  });

  describe('返品の設定を書く（admin_update_shop_return_settings）', () => {
    const UPDATE_SETTINGS_SQL = 'select public.admin_update_shop_return_settings($1::jsonb, $2) as settings';
    const INVALID_SETTINGS = { code: '22023', message: 'SETTINGS_ARGUMENT_INVALID' };

    async function updateSettings(patch: unknown, actorId: string | null): Promise<Row> {
      const res = await db().query(UPDATE_SETTINGS_SQL, [JSON.stringify(patch), actorId]);
      return res.rows[0].settings as Row;
    }

    async function readSettings(): Promise<Row> {
      const res = await db().query('select public.get_shop_return_settings() as settings');
      return res.rows[0].settings as Row;
    }

    test('渡した欄だけ保存し、値が変わったまとまりだけ、最後に変えた人と時刻を書く（返送料の定額は返送のまとまり）', async () => {
      const actor = await createActor(db());
      const before = await readSettings();

      const settings = await updateSettings({ window_days: 14, shop_label_fee: 800, restocking_fee_percent: 10, inspection_enabled: true }, actor.id);

      expect(settings).toMatchObject({ window_days: 14, shop_label_fee: 800, restocking_fee_percent: 10, inspection_enabled: true });
      // 渡さなかった欄は変わらない。段2の欄（申し込み・種類・注意書き）も、理由ごとの設定も同じ
      expect(settings).toMatchObject({
        requests_enabled: before.requests_enabled,
        request_types: before.request_types,
        notice_text: before.notice_text,
        window_start: before.window_start,
        delivery_buffer_days: before.delivery_buffer_days,
        customer_paid_method: before.customer_paid_method,
        no_return_needed_enabled: before.no_return_needed_enabled,
        restocking_fee_enabled: before.restocking_fee_enabled,
        exchange_fees_enabled: before.exchange_fees_enabled,
        exchange_fee: before.exchange_fee,
        exchange_shipping_fee: before.exchange_shipping_fee,
      });
      expect(settings.reasons).toEqual(before.reasons);
      const stamp = { at: expect.any(String), by_email: actor.email };
      expect(keysOf(settings.updated)).toEqual(sorted(['requests', 'window', 'shipping', 'reasons', 'fees', 'receiving']));
      expect(settings.updated).toMatchObject({ window: stamp, shipping: stamp, fees: stamp, receiving: stamp });
      expect(settings.updated.requests).toEqual(before.updated.requests);
      expect(settings.updated.reasons).toEqual(before.updated.reasons);
    });

    test('値が変わらない更新・キーの無い更新は、最後に変えた人も時刻も書き換えない', async () => {
      const first = await createActor(db());
      const second = await createActor(db());
      const written = await updateSettings({ window_days: 14, shop_label_fee: 800 }, first.id);

      const same = await updateSettings({ window_days: 14, shop_label_fee: 800 }, second.id);
      const empty = await updateSettings({}, second.id);

      expect(same.updated).toEqual(written.updated);
      expect(empty.updated).toEqual(written.updated);
      expect(same.updated.window.by_email).toBe(first.email);
      expect(same.updated.shipping.by_email).toBe(first.email);
    });

    test('受付の日数は null で無制限にでき、日数は1〜365、目安の日数は0〜14の整数だけ受ける', async () => {
      const actor = await createActor(db());

      expect((await updateSettings({ window_days: null }, actor.id)).window_days).toBeNull();
      expect(await updateSettings({ window_days: 365, delivery_buffer_days: 0 }, actor.id)).toMatchObject({
        window_days: 365,
        delivery_buffer_days: 0,
      });
      for (const patch of [
        { window_days: 0 },
        { window_days: 366 },
        { window_days: 1.5 },
        { window_days: '7' },
        { delivery_buffer_days: 15 },
        { delivery_buffer_days: -1 },
        { delivery_buffer_days: null },
      ]) {
        await expectRejected(db(), UPDATE_SETTINGS_SQL, [JSON.stringify(patch), actor.id], INVALID_SETTINGS);
      }
    });

    test('返送先は4つとも入れるか、null で4つとも空にする。形が違えば断る', async () => {
      const actor = await createActor(db());
      const address = { name: '株式会社テスト', postal_code: '1500001', address: '東京都渋谷区神宮前2-2-2', phone: '+81-3-1234-5678' };

      const addressSet = async () => (await db().query('select private.shop_return_address_set() as address_set')).rows[0].address_set as boolean;

      const written = await updateSettings({ return_address: address }, actor.id);
      expect(written.return_address).toEqual(address);
      expect(written.updated.shipping).toEqual({ at: expect.any(String), by_email: actor.email });
      expect(await addressSet()).toBe(true);

      // 空にすると、返品を作れなくなる
      const cleared = await updateSettings({ return_address: null }, actor.id);
      expect(cleared.return_address).toBeNull();
      expect(await addressSet()).toBe(false);

      for (const [label, value] of [
        ['電話番号が無い', { name: address.name, postal_code: address.postal_code, address: address.address }],
        ['郵便番号の形が違う', { ...address, postal_code: '15-0001' }],
        ['電話番号の形が違う', { ...address, phone: 'abc' }],
        ['名前が空', { ...address, name: '' }],
        ['名前が201字', { ...address, name: 'あ'.repeat(201) }],
        ['知らないキー', { ...address, fax: '03' }],
        ['文字', 'x'],
        ['配列', []],
      ] as Array<[string, unknown]>) {
        const rejection = await rejectionOf(db(), UPDATE_SETTINGS_SQL, [JSON.stringify({ return_address: value }), actor.id]);
        expect({ label, rejection }).toEqual({ label, rejection: INVALID_SETTINGS });
      }
    });

    test('理由ごとの設定は、画面（段1）が送る形（理由の記号・返送料の負担・在庫の無い交換の10行）で保存し、出す・ご希望・写真・案内の文は変えない', async () => {
      const actor = await createActor(db());
      const other = await createActor(db());
      const before = await readSettings();
      expect(before.reasons).toHaveLength(10);
      const flip = (value: string, a: string, b: string) => (value === a ? b : a);
      const rows = (before.reasons as Row[]).map((row) => ({
        reason: row.reason,
        shipping_payer: row.reason === 'defective' ? flip(row.shipping_payer, 'shop', 'customer') : row.shipping_payer,
        out_of_stock_exchange: row.reason === 'size_too_small' ? flip(row.out_of_stock_exchange, 'make', 'decline') : row.out_of_stock_exchange,
      }));

      const settings = await updateSettings({ reasons: rows }, actor.id);

      const reasonOf = (source: Row, reason: string): Row => (source.reasons as Row[]).find((row) => row.reason === reason) as Row;
      expect(reasonOf(settings, 'defective').shipping_payer).toBe(flip(reasonOf(before, 'defective').shipping_payer, 'shop', 'customer'));
      expect(reasonOf(settings, 'size_too_small').out_of_stock_exchange).toBe(
        flip(reasonOf(before, 'size_too_small').out_of_stock_exchange, 'make', 'decline'),
      );
      expect(keysOf(reasonOf(settings, 'defective'))).toEqual(
        sorted(['reason', 'shown', 'resolutions', 'out_of_stock_exchange', 'photo', 'photo_instructions', 'shipping_payer']),
      );
      for (const row of before.reasons as Row[]) {
        const next = reasonOf(settings, row.reason);
        expect({ reason: row.reason, shown: next.shown, resolutions: next.resolutions, photo: next.photo, photo_instructions: next.photo_instructions }).toEqual({
          reason: row.reason,
          shown: row.shown,
          resolutions: row.resolutions,
          photo: row.photo,
          photo_instructions: row.photo_instructions,
        });
      }
      expect(settings.updated.reasons).toEqual({ at: expect.any(String), by_email: actor.email });
      // 返送のまとまりなど、ほかのまとまりは書かない
      expect(settings.updated.shipping).toEqual(before.updated.shipping);
      // 同じ10行をもう一度送っても、最後に変えた人は書き換わらない
      expect((await updateSettings({ reasons: rows }, other.id)).updated.reasons).toEqual(settings.updated.reasons);
    });

    test('段2の欄（申し込みの受付・種類・注意書き・理由ごとの出す・ご希望・写真・案内の文）も受けて保存する。「不明」はお客様に出せない', async () => {
      const actor = await createActor(db());

      const settings = await updateSettings(
        {
          requests_enabled: false,
          request_types: 'cancellations_only',
          notice_text: '開店前にお読みください',
          reasons: [
            { reason: 'defective', shown: false, resolutions: 'exchange_only', photo: 'optional', photo_instructions: '写真をお送りください' },
          ],
        },
        actor.id,
      );

      expect(settings).toMatchObject({ requests_enabled: false, request_types: 'cancellations_only', notice_text: '開店前にお読みください' });
      expect((settings.reasons as Row[]).find((row) => row.reason === 'defective')).toMatchObject({
        shown: false,
        resolutions: 'exchange_only',
        photo: 'optional',
        photo_instructions: '写真をお送りください',
      });
      const stamp = { at: expect.any(String), by_email: actor.email };
      expect(settings.updated).toMatchObject({ requests: stamp, reasons: stamp });
      await expectRejected(db(), UPDATE_SETTINGS_SQL, [JSON.stringify({ reasons: [{ reason: 'unknown', shown: true }] }), actor.id], INVALID_SETTINGS);
    });

    test('形や範囲が違う設定は SETTINGS_ARGUMENT_INVALID で断り、何も残さない', async () => {
      const actor = await createActor(db());
      const before = await readSettings();
      const cases: Array<[string, unknown]> = [
        ['設定が配列', []],
        ['設定が文字', 'x'],
        ['知らないキー', { requests: true }],
        ['受付が文字', { requests_enabled: 'yes' }],
        ['種類が違う', { request_types: 'everything' }],
        ['注意書きが2001字', { notice_text: 'あ'.repeat(2001) }],
        ['注意書きが空', { notice_text: null }],
        ['数え始めが違う', { window_start: 'first_item' }],
        ['送り方が違う', { customer_paid_method: 'courier' }],
        ['返送料の定額がマイナス', { shop_label_fee: -1 }],
        ['返品の手数料が101%', { restocking_fee_percent: 101 }],
        ['交換の手数料が小数', { exchange_fee: 1.5 }],
        ['交換の送料が100万円超', { exchange_shipping_fee: 1000001 }],
        ['理由が配列でない', { reasons: {} }],
        ['理由の記号が違う', { reasons: [{ reason: 'broken', shipping_payer: 'shop' }] }],
        ['理由の記号が空', { reasons: [{ shipping_payer: 'shop' }] }],
        ['理由が重なる', { reasons: [{ reason: 'defective' }, { reason: 'defective' }] }],
        ['理由の行に知らないキー', { reasons: [{ reason: 'defective', note: 'x' }] }],
        ['返送料の負担が違う', { reasons: [{ reason: 'defective', shipping_payer: 'both' }] }],
        ['在庫の無い交換が違う', { reasons: [{ reason: 'defective', out_of_stock_exchange: 'wait' }] }],
        ['写真が違う', { reasons: [{ reason: 'defective', photo: 'always' }] }],
        ['案内の文が501字', { reasons: [{ reason: 'defective', photo_instructions: 'あ'.repeat(501) }] }],
        // 途中までの更新も残らない: 前の欄は正しく、後の欄が違う
        ['後の欄だけ違う', { window_days: 30, shop_label_fee: -1 }],
      ];

      for (const [label, patch] of cases) {
        const rejection = await rejectionOf(db(), UPDATE_SETTINGS_SQL, [JSON.stringify(patch), actor.id]);
        expect({ label, rejection }).toEqual({ label, rejection: INVALID_SETTINGS });
      }
      expect(await rejectionOf(db(), UPDATE_SETTINGS_SQL, ['{}', null])).toEqual(INVALID_SETTINGS);
      expect(await readSettings()).toEqual(before);
    });
  });

  describe('発送の取消の返品の守り（admin_cancel_fulfillment）', () => {
    test('申し込み・受付中・完了の返品が指す発送は FULFILLMENT_HAS_RETURN で取り消せず、返品の無い発送は今どおり取り消せる', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 3 }], shipments: [{ 0: 1 }, { 0: 1 }, { 0: 1 }] });
      const [first, second, third] = order.fulfillmentIds;
      await openReturn(db(), order, [line(order, 0, 1)]);
      const closedReturn = await openReturn(db(), order, [line(order, 0, 1, { fulfillment_id: second })]);
      await closeMissing(db(), closedReturn, order.actorId);
      const blocked = { code: '22023', message: 'FULFILLMENT_HAS_RETURN' };

      for (const fulfillmentId of [first, second]) {
        await expectRejected(db(), 'select * from public.admin_cancel_fulfillment($1, $2, $3)', [order.orderId, fulfillmentId, order.actorId], blocked);
      }
      const unchanged = await db().query('select id, cancelled_at from public.order_fulfillments where id = any($1::uuid[])', [[first, second]]);
      expect(unchanged.rows.map((row) => row.cancelled_at)).toEqual([null, null]);

      const cancelled = await cancelFulfillment(db(), order.orderId, third, order.actorId);
      expect(cancelled.rows).toEqual([{ outcome: 'cancelled', order_status: 'paid' }]);
    });

    test('返品の申し込み（段2の形）が指す発送も取り消せない', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      await insertCustomerReturn(db(), order, 'requested');

      await expectRejected(
        db(),
        'select * from public.admin_cancel_fulfillment($1, $2, $3)',
        [order.orderId, order.fulfillmentIds[0], order.actorId],
        { code: '22023', message: 'FULFILLMENT_HAS_RETURN' },
      );
    });

    test('取消・お断りの返品しか指していない発送は、今と同じく取り消せる', async () => {
      const cancelledOrder = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      await cancelReturn(db(), await openReturn(db(), cancelledOrder, [line(cancelledOrder, 0, 1)]), cancelledOrder.actorId);
      expect((await cancelFulfillment(db(), cancelledOrder.orderId, cancelledOrder.fulfillmentIds[0], cancelledOrder.actorId)).rows).toEqual([
        { outcome: 'cancelled', order_status: 'paid' },
      ]);

      // お断りの返品（段2の形。お客様の申し込みをお店がお断りした記録）
      const declinedOrder = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      await insertCustomerReturn(db(), declinedOrder, 'declined');
      expect((await cancelFulfillment(db(), declinedOrder.orderId, declinedOrder.fulfillmentIds[0], declinedOrder.actorId)).rows).toEqual([
        { outcome: 'cancelled', order_status: 'paid' },
      ]);
    });
  });

  describe('返品のメールの予定（private.enqueue_return_email）', () => {
    const enqueue = async (orderId: string, kind: string, returnId: string, receiptId: string | null): Promise<boolean> =>
      (await db().query('select private.enqueue_return_email($1, $2, $3, $4) as enqueued', [orderId, kind, returnId, receiptId])).rows[0]
        .enqueued as boolean;

    test('返品の受付は返品ごとに1行、受け取りの3つは受け取りと種類ごとに1行で、同じ物は二度書かない', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 2)], { notify: false });
      const lineId = await lineIdOf(db(), returnId, order.itemIds[0]);
      const firstReceipt = await insertReceipt(db(), returnId, { lines: [{ returnLineId: lineId, disposition: 'sent_back', quantity: 1 }] });
      const secondReceipt = await insertReceipt(db(), returnId, { lines: [{ returnLineId: lineId, disposition: 'sent_back', quantity: 1 }] });

      expect(await enqueue(order.orderId, 'return_accepted', returnId, null)).toBe(true);
      expect(await enqueue(order.orderId, 'return_accepted', returnId, null)).toBe(false);
      for (const kind of ['return_received', 'return_sent_back', 'return_refund_pending_shop']) {
        expect(await enqueue(order.orderId, kind, returnId, firstReceipt)).toBe(true);
        expect(await enqueue(order.orderId, kind, returnId, firstReceipt)).toBe(false);
      }
      // 別の受け取りは別の行
      expect(await enqueue(order.orderId, 'return_received', returnId, secondReceipt)).toBe(true);

      const rows = await outboxRows(db(), order.orderId);
      expect(rows).toEqual([
        { kind: 'return_accepted', variant: null, origin: 'auto', status: 'pending', return_id: returnId, return_receipt_id: null },
        { kind: 'return_received', variant: null, origin: 'auto', status: 'pending', return_id: returnId, return_receipt_id: firstReceipt },
        { kind: 'return_sent_back', variant: null, origin: 'auto', status: 'pending', return_id: returnId, return_receipt_id: firstReceipt },
        {
          kind: 'return_refund_pending_shop',
          variant: null,
          origin: 'auto',
          status: 'pending',
          return_id: returnId,
          return_receipt_id: firstReceipt,
        },
        { kind: 'return_received', variant: null, origin: 'auto', status: 'pending', return_id: returnId, return_receipt_id: secondReceipt },
      ]);
    });

    test('種類が違う・受け取りの番号の有無が種類に合わない・番号が空の時は RETURN_ARGUMENT_INVALID で断る', async () => {
      const order = await createShippedOrder(db(), { lines: [{ quantity: 1 }] });
      const returnId = await openReturn(db(), order, [line(order, 0, 1)], { notify: false });
      const receiptId = await insertReceipt(db(), returnId, {
        lines: [{ returnLineId: await lineIdOf(db(), returnId, order.itemIds[0]), disposition: 'sent_back', quantity: 1 }],
      });
      const sql = 'select private.enqueue_return_email($1, $2, $3, $4)';

      for (const [label, params] of [
        ['返金のお知らせ（E-2 の関数の種類）', [order.orderId, 'refund', returnId, receiptId]],
        ['知らない種類', [order.orderId, 'return_unknown', returnId, null]],
        ['返品の受付に受け取りの番号', [order.orderId, 'return_accepted', returnId, receiptId]],
        ['受け取りの種類に受け取りの番号が無い', [order.orderId, 'return_received', returnId, null]],
        ['返品の番号が空', [order.orderId, 'return_accepted', null, null]],
        ['注文の番号が空', [null, 'return_accepted', returnId, null]],
        ['種類が空', [order.orderId, null, returnId, null]],
      ] as Array<[string, unknown[]]>) {
        const rejection = await rejectionOf(db(), sql, params);
        expect({ label, rejection }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
      expect(await outboxRows(db(), order.orderId)).toEqual([]);
    });
  });

  describe('権限と関数の数', () => {
    const SERVICE_ONLY_FUNCTIONS = [
      'public.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
      'public.admin_cancel_return(uuid,uuid)',
      'public.admin_close_return_missing(uuid,uuid,uuid)',
      'public.admin_reopen_return(uuid,uuid,uuid)',
      'public.admin_inspect_return(uuid,uuid,uuid,jsonb)',
      'public.admin_record_return_fee_payment(uuid,uuid,text,boolean)',
      'public.admin_release_return_exchange(uuid,uuid)',
      'public.get_order_return_materials(uuid)',
      'public.list_order_returns(uuid)',
      'public.list_order_return_summaries(uuid[])',
      'public.count_order_return_attention()',
      'public.list_order_ids_by_return_status(text)',
      'public.admin_update_shop_return_settings(jsonb,uuid)',
      'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
    ];
    const PRIVATE_FUNCTIONS = [
      'private.parse_return_lines(jsonb)',
      'private.parse_return_inspect_lines(jsonb)',
      'private.lock_order_return(uuid)',
      'private.find_return_receipt(uuid,uuid,text)',
      'private.insert_return_receipt(uuid,uuid,text,text,uuid)',
      'private.enqueue_return_email(uuid,text,uuid,uuid)',
      'private.return_refund_amount(text,integer,integer,integer,integer,integer,integer)',
      'private.shop_return_address_set()',
      'private.return_display_state(uuid)',
      'private.return_detail_json(uuid)',
      'private.settings_bool(jsonb,text,boolean)',
      'private.settings_int(jsonb,text,integer,integer,integer,boolean)',
      'private.settings_enum(jsonb,text,text,text[])',
      'private.settings_text(jsonb,text,text,integer)',
    ];

    test.each(SERVICE_ONLY_FUNCTIONS)('%s は service_role だけが実行できる', async (signature) => {
      const res = await db().query(
        `select has_function_privilege('anon', $1::text, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1::text, 'EXECUTE') as authenticated,
                has_function_privilege('service_role', $1::text, 'EXECUTE') as service_role`,
        [signature],
      );

      expect(res.rows[0]).toEqual({ anon: false, authenticated: false, service_role: true });
    });

    test.each(PRIVATE_FUNCTIONS)('private の %s は、だれも呼べない', async (signature) => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const res = await db().query("select has_function_privilege($1::text, $2::text, 'EXECUTE') as allowed", [role, signature]);
        expect({ role, allowed: res.rows[0].allowed }).toEqual({ role, allowed: false });
      }
    });

    test.each(['anon', 'authenticated'])('%s は返品の関数・読み出しの関数・設定の関数を呼べない', async (role) => {
      const calls: Array<[string, unknown[]]> = [
        [CREATE_SQL, createParams(crypto.randomUUID(), { actorId: crypto.randomUUID(), lines: [] })],
        ['select * from public.admin_cancel_return(gen_random_uuid(), gen_random_uuid())', []],
        ['select * from public.get_order_return_materials(gen_random_uuid())', []],
        ['select * from public.list_order_returns(gen_random_uuid())', []],
        ['select * from public.list_order_return_summaries(array[gen_random_uuid()])', []],
        ['select * from public.count_order_return_attention()', []],
        ["select * from public.list_order_ids_by_return_status('returned')", []],
        ["select * from public.admin_update_shop_return_settings('{}'::jsonb, gen_random_uuid())", []],
      ];
      for (const [sql, params] of calls) {
        await db().query('savepoint denied');
        await db().query(`set local role ${role}`);
        await expect(db().query(sql, params)).rejects.toMatchObject({ code: '42501' });
        await db().query('rollback to savepoint denied');
      }
    });

    test('service_role は読み出しの関数を呼べる', async () => {
      await db().query('savepoint service');
      await db().query('set local role service_role');
      await expect(db().query('select * from public.get_order_return_materials(gen_random_uuid())')).resolves.toBeTruthy();
      await expect(db().query('select * from public.list_order_returns(gen_random_uuid())')).resolves.toBeTruthy();
      await expect(db().query('select * from public.list_order_return_summaries(array[gen_random_uuid()])')).resolves.toBeTruthy();
      await expect(db().query('select * from public.count_order_return_attention()')).resolves.toBeTruthy();
      await expect(db().query("select * from public.list_order_ids_by_return_status('returned')")).resolves.toBeTruthy();
      await db().query('rollback to savepoint service');
    });

    test('同じ名前の関数は1つだけ（2つあると Data API が呼び分けられない: PGRST203）', async () => {
      for (const signature of [...SERVICE_ONLY_FUNCTIONS, ...PRIVATE_FUNCTIONS]) {
        const [schema, rest] = signature.split('.');
        const name = rest.slice(0, rest.indexOf('('));
        const count = await db().query(
          `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = $1 and p.proname = $2`,
          [schema, name],
        );
        expect({ name, n: count.rows[0].n }).toEqual({ name, n: 1 });
      }
    });
  });
});

describeLocalDb('integration: 返品を作る操作と発送の取消・ほかの返品の同時の操作（Review Focus 4）', (db) => {
  let other: PgClient;
  // 設定を確定して戻す専用の接続（共通の入口が afterAll で db() の接続を閉じる順に左右されない）
  let settings: PgClient;

  beforeAll(async () => {
    other = await connectLocalDb();
    settings = await connectLocalDb();
    // 返送先が空の間は返品を作れない。確定した値なので、終わったら空に戻す
    await setReturnAddress(settings);
  });

  afterAll(async () => {
    await updateSettingsRow(settings, {
      return_address_name: null,
      return_address_postal_code: null,
      return_address_line: null,
      return_address_phone: null,
    });
    await settings.end();
    await other.end();
  });

  /** 確定した注文（在庫の品1つ・数2・1点ずつ2回に分けて発送）。もう1つの接続からも見える */
  function createCommittedOrder(): Promise<ShippedOrder> {
    return createShippedOrder(db(), { lines: [{ quantity: 2 }], shipments: [{ 0: 1 }, { 0: 1 }] });
  }

  test('返品を作るのが先: 発送の取消は注文の行の鍵を待ち、返品が確定した後に FULFILLMENT_HAS_RETURN で断られる。取り消せなかった発送は残る', async () => {
    const order = await createCommittedOrder();
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    let returnId = '';

    await db().query('begin');
    try {
      // 確定したメールの予定を残さないよう、お客様に知らせない
      returnId = await openReturn(db(), order, [line(order, 0, 1)], { notify: false });
      const cancelling = cancelFulfillment(other, order.orderId, order.fulfillmentIds[0], order.actorId).then(
        () => null,
        (error: unknown) => error,
      );
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await cancelling).toMatchObject({ code: '22023', message: 'FULFILLMENT_HAS_RETURN' });
    } catch (error) {
      await db().query('rollback');
      throw error;
    } finally {
      // 確定した受付中の返品を、一覧の絞り込みに残さない（元の誤りを隠さないよう、取消の失敗は無視する）
      if (returnId) await cancelReturn(db(), returnId, order.actorId).catch(() => undefined);
    }

    const fulfillment = await db().query('select cancelled_at from public.order_fulfillments where id = $1', [order.fulfillmentIds[0]]);
    expect(fulfillment.rows[0].cancelled_at).toBeNull();
  });

  test('発送の取消が先: 返品を作る操作は注文の行の鍵を待ち、取り消した発送は返品できる数が無いとして RETURN_QUANTITY_EXCEEDS で断られる。取消だけが記録される', async () => {
    const order = await createCommittedOrder();
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;

    await db().query('begin');
    try {
      await cancelFulfillment(db(), order.orderId, order.fulfillmentIds[1], order.actorId);
      const creating = createReturn(other, order.orderId, {
        actorId: order.actorId,
        notify: false,
        lines: [line(order, 0, 1, { fulfillment_id: order.fulfillmentIds[1] })],
      }).then(
        () => null,
        (error: unknown) => error,
      );
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await creating).toMatchObject({ code: '22023', message: 'RETURN_QUANTITY_EXCEEDS' });
    } catch (error) {
      await db().query('rollback');
      throw error;
    }

    const counts = await db().query(
      `select (select count(*)::int from public.order_returns where order_id = $1) as returns,
              (select count(*)::int from public.order_fulfillments where order_id = $1 and cancelled_at is not null) as cancelled`,
      [order.orderId],
    );
    expect(counts.rows[0]).toEqual({ returns: 0, cancelled: 1 });
  });

  test('最後の1点を2つの返品が取り合う: 先に確定した返品だけが記録され、後の返品は数を超えるとして断られる', async () => {
    const order = await createShippedOrder(db(), { lines: [{ quantity: 2 }] });
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    let returnId = '';

    await db().query('begin');
    try {
      returnId = await openReturn(db(), order, [line(order, 0, 2)], { notify: false });
      const creating = createReturn(other, order.orderId, { actorId: order.actorId, notify: false, lines: [line(order, 0, 1)] }).then(
        () => null,
        (error: unknown) => error,
      );
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await creating).toMatchObject({ code: '22023', message: 'RETURN_QUANTITY_EXCEEDS' });
    } catch (error) {
      await db().query('rollback');
      throw error;
    } finally {
      if (returnId) await cancelReturn(db(), returnId, order.actorId).catch(() => undefined);
    }

    const count = await db().query('select count(*)::int as n from public.order_returns where order_id = $1', [order.orderId]);
    expect(count.rows[0].n).toBe(1);
  });
});
