/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import {
  addItemVariant,
  createCatalogFixture,
  createShippedOrderFixture,
  insertOrderWithLines,
  insertRefundRecord,
  insertReturnReceipt,
  insertReturnRecord,
  insertReturnRefund,
  uniqueSuffix,
  type ShippedOrderFixture,
} from './helpers/order-fixtures';

/**
 * お客様の側の DB の関数（グループ E-3 段2、移行 E）: 申し込みの画面の材料・写真の送り先・返品の申し込み・
 * キャンセルの申し込み・注文の画面の返品の欄・メールの予定を書く 2 つの private 関数。
 * 注文はお客様（auth.users の行）の持ち物にして作る。表や設定は 1 件ごとに取引の中で動かし、終わったら戻す。
 * now() は取引の中で動かないので、期限の試験は「取引の中の今日（日本時間）」から発送の日を引いて決める（Review Focus 3）。
 * 2 つの接続が要る同時の申し込みの試験だけは、別の describe で確定した行を使う
 * （確定した注文と申し込みは手元の DB に残る。npx supabase db reset で消える）。
 * 写真の送り先・キャンセルの申し込みの行は、Task 1 の道具の名前を前提にせず、この試験の中の道具で直に書く。
 */
jest.setTimeout(60000);

type Row = Record<string, any>;
type CustomerOrder = ShippedOrderFixture & { customerId: string };
type ShippedOrderOptions = NonNullable<Parameters<typeof createShippedOrderFixture>[1]>;
type OrderRef = { orderId: string; customerId: string; orderItemIds: string[] };

const NOT_FOUND = { code: 'P0002', message: 'ORDER_NOT_FOUND' };

function refusal(message: string) {
  return { code: '22023', message };
}

const INVALID_ARGUMENT = refusal('RETURN_ARGUMENT_INVALID');

const RETURN_MAIL_KINDS = [
  'return_accepted',
  'return_requested',
  'return_declined',
  'return_request_shop',
  'return_received',
  'return_sent_back',
  'return_refund_pending_shop',
  'cancel_request_received',
  'cancel_request_declined',
  'cancel_request_shop',
];

/** お客様（auth.users の行）を作る。会員の行 profiles は auth.users のトリガーができる */
async function createCustomer(db: PgClient, label = 'customer'): Promise<string> {
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [`customer-request-${label}-${uniqueSuffix()}@example.com`],
  );
  return res.rows[0].id as string;
}

/** 発送した品のある注文を作り、お客様を持ち主にする（持ち主は空から値へ 1 回だけ書ける） */
async function createCustomerOrder(db: PgClient, options: ShippedOrderOptions = {}, customerId?: string): Promise<CustomerOrder> {
  const owner = customerId ?? (await createCustomer(db));
  const fixture = await createShippedOrderFixture(db, options);
  await db.query('update public.orders set user_id = $1 where id = $2', [owner, fixture.orderId]);
  return { ...fixture, customerId: owner };
}

/** まだ発送していない注文を、指定の状態で作り、お客様を持ち主にする（在庫の品 1 つ） */
async function createUnshippedOrder(
  db: PgClient,
  status: string,
  options: { customerId?: string; quantity?: number } = {},
): Promise<OrderRef> {
  const owner = options.customerId ?? (await createCustomer(db));
  const quantity = options.quantity ?? 2;
  const fx = await createCatalogFixture(db, { stock: quantity });
  const { orderId, orderItemIds } = await insertOrderWithLines(db, {
    status,
    lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity, fulfillmentType: 'stock' }],
  });
  await db.query('update public.orders set user_id = $1 where id = $2', [owner, orderId]);
  return { orderId, orderItemIds, customerId: owner };
}

/** 日本時間の今日から daysAgo 日前の、日本時間の正午（発送の時刻に使う。取引の中の now() から決める） */
async function shippedAtJst(db: PgClient, daysAgo: number): Promise<string> {
  const res = await db.query(
    `select ((((now() at time zone 'Asia/Tokyo')::date - $1::int)::timestamp + interval '12 hours') at time zone 'Asia/Tokyo') as shipped_at`,
    [daysAgo],
  );
  return (res.rows[0].shipped_at as Date).toISOString();
}

/** 日本時間の今日に offsetDays 日を足した日付（YYYY-MM-DD） */
async function jstDate(db: PgClient, offsetDays: number): Promise<string> {
  const res = await db.query(
    `select to_char((now() at time zone 'Asia/Tokyo')::date + $1::int, 'YYYY-MM-DD') as jst_day`,
    [offsetDays],
  );
  return res.rows[0].jst_day as string;
}

/** 返品の設定の行を直接書く（関数を通さずに、試験が欲しい設定を作る） */
async function updateSettings(db: PgClient, values: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(values);
  const assignments = entries.map(([column], index) => `${column} = $${index + 1}`).join(', ');
  await db.query(`update public.shop_return_settings set ${assignments} where id = 1`, entries.map(([, value]) => value));
}

/** 理由ごとの設定の行を直接書く */
async function updateReason(db: PgClient, reason: string, values: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(values);
  const assignments = entries.map(([column], index) => `${column} = $${index + 2}`).join(', ');
  await db.query(
    `update public.shop_return_reason_settings set ${assignments} where reason = $1`,
    [reason, ...entries.map(([, value]) => value)],
  );
}

async function setReturnAddress(db: PgClient): Promise<void> {
  await updateSettings(db, {
    return_address_name: '店舗',
    return_address_postal_code: '150-0001',
    return_address_line: '東京都渋谷区神宮前1-1-1',
    return_address_phone: '03-1111-2222',
  });
}

async function clearReturnAddress(db: PgClient): Promise<void> {
  await updateSettings(db, {
    return_address_name: null,
    return_address_postal_code: null,
    return_address_line: null,
    return_address_phone: null,
  });
}

/** 写真の送り先の行を直接足す。ageHours は作った時刻を古くする。attached・purged は使い済み・消した物 */
async function insertUploads(
  db: PgClient,
  target: { orderId: string; customerId: string },
  count: number,
  options: { attached?: boolean; purged?: boolean; ageHours?: number } = {},
): Promise<void> {
  await db.query(
    `insert into public.order_return_photo_uploads (order_id, customer_id, storage_path, created_at, attached_at, purged_at)
     select $1::uuid, $2::uuid, 'requests/' || $1::uuid::text || '/' || gen_random_uuid()::text,
            now() - make_interval(hours => $3::int),
            case when $4::boolean then now() end,
            case when $5::boolean then now() end
     from generate_series(1, $6::int)`,
    [target.orderId, target.customerId, options.ageHours ?? 0, options.attached ?? false, options.purged ?? false, count],
  );
}

/** 写真の送り先の行を 1 つ足して、番号と場所を返す。ageHours は作った時刻を古くする */
async function insertUpload(
  db: PgClient,
  target: { orderId: string; customerId: string },
  options: { attached?: boolean; purged?: boolean; ageHours?: number } = {},
): Promise<{ id: string; path: string }> {
  const id = crypto.randomUUID();
  const path = `requests/${target.orderId}/${id}`;
  await db.query(
    `insert into public.order_return_photo_uploads (id, order_id, customer_id, storage_path, created_at, attached_at, purged_at)
     values ($1::uuid, $2::uuid, $3::uuid, $4, now() - make_interval(hours => $5::int),
             case when $6::boolean then now() end, case when $7::boolean then now() end)`,
    [id, target.orderId, target.customerId, path, options.ageHours ?? 0, options.attached ?? false, options.purged ?? false],
  );
  return { id, path };
}

/** 申し込みの行に付ける写真の情報（サーバーが確かめた種類と大きさ） */
function photoOf(upload: { id: string }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { upload_id: upload.id, content_type: 'image/jpeg', size_bytes: 120000, ...extra };
}

/** 申し込みの行（既定は、1 つ目の発送の、その他の理由の返金・詳しい内容つき・写真なし）。キーを undefined にするとそのキーを送らない */
function reqLine(order: CustomerOrder, itemIndex: number, quantity: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fulfillment_id: order.fulfillments[0].id,
    order_item_id: order.orderItemIds[itemIndex],
    quantity,
    reason: 'other',
    customer_note: '色落ちがありました',
    requested_resolution: 'refund',
    requested_exchange_variant_id: null,
    photos: [],
    ...extra,
  };
}

const REQUEST_SQL = 'select * from public.customer_request_return($1, $2, $3, $4::jsonb)';

type RequestInput = {
  orderId?: string | null;
  customerId?: string | null;
  requestKey?: string | null;
  /** 省くと 1 つ目の品を 1 点 */
  lines?: unknown;
};

/** 省いた引数は、注文の持ち主・新しい二重防止の番号・1 つ目の品 1 点の普通の呼び方になる。null を渡すと SQL の NULL を渡す */
function requestParams(order: CustomerOrder, input: RequestInput = {}): unknown[] {
  return [
    input.orderId === undefined ? order.orderId : input.orderId,
    input.customerId === undefined ? order.customerId : input.customerId,
    input.requestKey === undefined ? crypto.randomUUID() : input.requestKey,
    JSON.stringify(input.lines === undefined ? [reqLine(order, 0, 1)] : input.lines),
  ];
}

function requestReturn(db: PgClient, order: CustomerOrder, input: RequestInput = {}) {
  return db.query(REQUEST_SQL, requestParams(order, input));
}

const CANCEL_SQL = 'select * from public.customer_request_cancel($1, $2, $3, $4::jsonb, $5)';

type CancelInput = {
  orderId?: string | null;
  customerId?: string | null;
  requestKey?: string | null;
  /** 省くと 1 つ目の品を 1 点 */
  lines?: unknown;
  note?: string | null;
};

function cancelParams(order: OrderRef, input: CancelInput = {}): unknown[] {
  return [
    input.orderId === undefined ? order.orderId : input.orderId,
    input.customerId === undefined ? order.customerId : input.customerId,
    input.requestKey === undefined ? crypto.randomUUID() : input.requestKey,
    JSON.stringify(input.lines === undefined ? [{ order_item_id: order.orderItemIds[0], quantity: 1 }] : input.lines),
    input.note === undefined ? null : input.note,
  ];
}

function requestCancel(db: PgClient, order: OrderRef, input: CancelInput = {}) {
  return db.query(CANCEL_SQL, cancelParams(order, input));
}

const PHOTO_UPLOAD_SQL = 'select * from public.customer_create_return_photo_upload($1, $2)';

/** 未発送の品が 2 点残る支払い済みの注文（3 点のうち 1 点だけ発送済み） */
function createPartlyShippedOrder(db: PgClient, customerId?: string): Promise<CustomerOrder> {
  return createCustomerOrder(db, { lines: [{ quantity: 3 }], shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }] }] }, customerId);
}

async function materialsOf(db: PgClient, target: { orderId: string; customerId: string }): Promise<Row> {
  const res = await db.query('select public.get_customer_return_request_materials($1, $2) as materials', [target.orderId, target.customerId]);
  return res.rows[0].materials as Row;
}

async function returnsOf(db: PgClient, target: { orderId: string; customerId: string }): Promise<Row> {
  const res = await db.query('select public.get_customer_order_returns($1, $2) as result', [target.orderId, target.customerId]);
  return res.rows[0].result as Row;
}

function allLines(materials: Row): Row[] {
  return (materials.shipments as Row[]).flatMap((shipment) => shipment.lines as Row[]);
}

/** 品の番号から状態を引く */
function statesOf(materials: Row): Record<string, string> {
  return Object.fromEntries(allLines(materials).map((line) => [line.order_item_id as string, line.state as string]));
}

async function returnRow(db: PgClient, returnId: string): Promise<Row> {
  const res = await db.query('select * from public.order_returns where id = $1', [returnId]);
  return res.rows[0];
}

async function returnLineRows(db: PgClient, returnId: string): Promise<Row[]> {
  const res = await db.query('select * from public.order_return_lines where return_id = $1 order by order_item_id, id', [returnId]);
  return res.rows;
}

async function photoRows(db: PgClient, returnId: string): Promise<Row[]> {
  const res = await db.query(
    `select p.*
     from public.order_return_photos as p
     join public.order_return_lines as l on l.id = p.return_line_id
     where l.return_id = $1
     order by p.size_bytes, p.id`,
    [returnId],
  );
  return res.rows;
}

async function uploadRow(db: PgClient, uploadId: string): Promise<Row> {
  const res = await db.query('select * from public.order_return_photo_uploads where id = $1', [uploadId]);
  return res.rows[0];
}

/** 返品・キャンセルの申し込みのメールの予定（10 種類）を古い順に */
async function outboxRows(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query(
    `select kind, variant, origin, status, return_id, return_receipt_id, cancel_request_id
     from private.order_email_outbox
     where order_id = $1 and kind = any($2::text[])
     order by seq`,
    [orderId, RETURN_MAIL_KINDS],
  );
  return res.rows;
}

/** 記録の数（失敗した申し込みが何も残さないこと・送り直しで増えないことの確かめ） */
async function recordCounts(db: PgClient, orderId: string): Promise<Row> {
  const res = await db.query(
    `select (select count(*)::int from public.order_returns where order_id = $1) as returns,
            (select count(*)::int from public.order_return_lines l join public.order_returns r on r.id = l.return_id where r.order_id = $1) as lines,
            (select count(*)::int from public.order_return_photos p
               join public.order_return_lines l on l.id = p.return_line_id
               join public.order_returns r on r.id = l.return_id where r.order_id = $1) as photos,
            (select count(*)::int from public.order_return_photo_uploads where order_id = $1 and attached_at is not null) as attached,
            (select count(*)::int from public.order_cancel_requests where order_id = $1) as cancel_requests,
            (select count(*)::int from private.order_email_outbox where order_id = $1) as mails`,
    [orderId],
  );
  return res.rows[0];
}

async function countsOf(db: PgClient, orderId: string): Promise<Record<string, Row>> {
  const res = await db.query('select * from private.order_line_return_counts($1)', [orderId]);
  return Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row]));
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

/** 失敗した文の SQLSTATE と言葉を返す（成功したら null）。どの入力が外れたかを名前つきで見せるために使う */
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

/** 別の接続が鍵を待つまで待つ（最大 5 秒） */
async function waitUntilBlocked(db: PgClient, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await db.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [pid]);
    if (res.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('別の接続が注文の行の鍵を待たなかった');
}

/** オブジェクトのキーを並べ替えて返す。jsonb のキーの一覧を、共通の約束 C-2 の型のキーと突き合わせるために使う */
function keysOf(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

function sorted(keys: string[]): string[] {
  return [...keys].sort();
}

/** 交換の品の行（受け取りの関数が足す物）を直接足す。値段は 0、元の品の支払額を持つ */
async function insertExchangeItem(db: PgClient, order: CustomerOrder, returnLineId: string): Promise<string> {
  const res = await db.query(
    `insert into public.order_items
       (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type,
        line_kind, exchange_return_line_id, exchange_paid_amount)
     values ($1, $2, '交換テスト', 0, 'WHITE', 'L', 1, 0, $3, 'stock', 'exchange', $4, 5000)
     returning id`,
    [order.orderId, order.itemIds[0], order.variantIds[0], returnLineId],
  );
  return res.rows[0].id as string;
}

/** 交換の品を 2 回目の発送で送ったことにする */
async function shipExchangeItem(db: PgClient, order: CustomerOrder, exchangeItemId: string): Promise<void> {
  const shipment = await db.query(
    `insert into public.order_fulfillments
       (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order, shipped_at)
     values ($1, 2, gen_random_uuid(), 'yamato', '1234-5678-9012', false, false, now())
     returning id`,
    [order.orderId],
  );
  await db.query('insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, 1)', [
    shipment.rows[0].id,
    exchangeItemId,
  ]);
}

/** お返し（sent_back）の受け取りを、お返しのメッセージ・配送業者・伝票番号つきで直接書く */
async function insertSentBackReceipt(
  db: PgClient,
  returnId: string,
  returnLineId: string,
  quantity: number,
  sentBack: { message: string | null; carrier: string | null; trackingNumber: string | null },
): Promise<void> {
  const receipt = await db.query(
    `insert into public.order_return_receipts
       (return_id, request_key, request_fingerprint, kind, refund_choice, notify_customer,
        sent_back_message, sent_back_carrier, sent_back_tracking_number)
     values ($1, gen_random_uuid(), 'fixture', 'receive', 'none', false, $2, $3, $4)
     returning id`,
    [returnId, sentBack.message, sentBack.carrier, sentBack.trackingNumber],
  );
  await db.query(
    `insert into public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity)
     values ($1, $2, 'sent_back', $3)`,
    [receipt.rows[0].id, returnLineId, quantity],
  );
}

describeLocalDb('integration: お客様の側の関数（移行 E）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    // 申し込みは返送先を問わない（P18）。返送先の有無を見る試験だけが入れるので、最初は空にそろえる
    await clearReturnAddress(db());
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('申し込みの画面の材料（get_customer_return_request_materials）', () => {
    test('キーは C-2 の CustomerReturnRequestMaterials の snake_case と一字違わず、中身は発送ごとの品・出す理由・使える色とサイズ・手数料', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 3 }] });
      const white = await addItemVariant(db(), { itemId: order.itemIds[0], colorName: 'WHITE', sizeLabel: 'L', stock: 4 });
      await addItemVariant(db(), { itemId: order.itemIds[0], colorName: 'RED', sizeLabel: 'S', isActive: false });
      // 手元の DB に E2E などが残した設定に頼らないよう、この試験が見る設定を自分で置く
      await updateSettings(db(), {
        notice_text: '返品・交換の前にお読みください',
        customer_paid_method: 'customer_ships',
        restocking_fee_enabled: false,
        exchange_fees_enabled: false,
        window_days: 7,
        delivery_buffer_days: 3,
      });

      const materials = await materialsOf(db(), order);

      expect(keysOf(materials)).toEqual(
        sorted(['order', 'availability', 'notice_text', 'shipments', 'reasons', 'exchange_options', 'fees']),
      );
      expect(keysOf(materials.order)).toEqual(sorted(['id', 'status']));
      expect(keysOf(materials.availability)).toEqual(sorted(['returns', 'ended_on']));
      expect(keysOf(materials.shipments[0])).toEqual(
        sorted(['fulfillment_id', 'number', 'shipped_at', 'deadline_date', 'past_deadline', 'lines']),
      );
      expect(keysOf(materials.shipments[0].lines[0])).toEqual(
        sorted([
          'order_item_id', 'item_id', 'item_name', 'color', 'size', 'line_kind', 'quantity', 'selectable', 'state', 'return_ineligible',
        ]),
      );
      expect(keysOf(materials.reasons[0])).toEqual(
        sorted(['reason', 'resolutions', 'out_of_stock_exchange', 'photo', 'photo_instructions', 'shipping_payer']),
      );
      expect(keysOf(materials.exchange_options[0])).toEqual(sorted(['item_id', 'variants']));
      expect(keysOf(materials.exchange_options[0].variants[0])).toEqual(
        sorted(['variant_id', 'color', 'size', 'stock_quantity', 'made_to_order_lead_days']),
      );
      expect(keysOf(materials.fees)).toEqual(
        sorted(['customer_paid_method', 'shop_label_fee', 'restocking_fee_percent', 'exchange_fee', 'exchange_shipping_fee']),
      );

      expect(materials.order).toEqual({ id: order.orderId, status: 'shipped' });
      expect(materials.availability).toEqual({ returns: 'available', ended_on: null });
      expect(materials.notice_text).toBe('返品・交換の前にお読みください');
      // 日数 7・目安 3（上で置いた）: 発送の日（取引の中の今日）+ 10 日が期限
      expect(materials.shipments).toHaveLength(1);
      expect(materials.shipments[0]).toMatchObject({
        fulfillment_id: order.fulfillments[0].id,
        number: 1,
        deadline_date: await jstDate(db(), 10),
        past_deadline: false,
      });
      expect(materials.shipments[0].lines).toEqual([
        {
          order_item_id: order.orderItemIds[0],
          item_id: order.itemIds[0],
          item_name: '照合テスト',
          color: 'BLACK',
          size: 'M',
          line_kind: 'order',
          quantity: 3,
          selectable: 3,
          state: 'selectable',
          return_ineligible: false,
        },
      ]);
      // 出す理由は最初の値の 5 つ（色・デザイン・説明と違った・不要になった・不明は出さない）。決まった順
      expect(materials.reasons.map((reason: Row) => reason.reason)).toEqual([
        'defective',
        'wrong_item',
        'size_too_small',
        'size_too_large',
        'other',
      ]);
      expect(materials.reasons[0]).toEqual({
        reason: 'defective',
        resolutions: 'refund_and_exchange',
        out_of_stock_exchange: 'make',
        photo: 'required',
        photo_instructions: '傷や不具合の場所がわかる写真をお送りください',
        shipping_payer: 'shop',
      });
      // 交換の色・サイズは同じ商品の使える物だけ（使えない RED/S は無い）。色の並び順。
      // 商品を作ると色・サイズの無いバリアントが 1 つ自動でできる（トリガー items_sync_variants）ので、色・サイズの付いた物だけを突き合わせる
      expect(materials.exchange_options).toHaveLength(1);
      expect(materials.exchange_options[0].item_id).toBe(order.itemIds[0]);
      expect(
        (materials.exchange_options[0].variants as Row[]).filter((variant) => variant.color !== null || variant.size !== null),
      ).toEqual([
        { variant_id: order.variantIds[0], color: 'BLACK', size: 'M', stock_quantity: 0, made_to_order_lead_days: null },
        { variant_id: white.variantId, color: 'WHITE', size: 'L', stock_quantity: 4, made_to_order_lead_days: null },
      ]);
      expect(materials.fees).toEqual({
        customer_paid_method: 'customer_ships',
        shop_label_fee: 0,
        restocking_fee_percent: 0,
        exchange_fee: 0,
        exchange_shipping_fee: 0,
      });
    });

    test('手数料は設定の値で、使わない手数料は 0（返送料の定額はお店の送り状の時だけ）', async () => {
      const order = await createCustomerOrder(db(), {});
      await updateSettings(db(), {
        customer_paid_method: 'customer_ships',
        shop_label_fee: 800,
        restocking_fee_enabled: false,
        restocking_fee_percent: 10,
        exchange_fees_enabled: false,
        exchange_fee: 300,
        exchange_shipping_fee: 500,
      });
      expect((await materialsOf(db(), order)).fees).toEqual({
        customer_paid_method: 'customer_ships',
        shop_label_fee: 0,
        restocking_fee_percent: 0,
        exchange_fee: 0,
        exchange_shipping_fee: 0,
      });

      await updateSettings(db(), { customer_paid_method: 'shop_label', restocking_fee_enabled: true, exchange_fees_enabled: true });
      expect((await materialsOf(db(), order)).fees).toEqual({
        customer_paid_method: 'shop_label',
        shop_label_fee: 800,
        restocking_fee_percent: 10,
        exchange_fee: 300,
        exchange_shipping_fee: 500,
      });
    });

    test('品の状態は 5 つ: selectable・past_deadline・requested・sent_back・unavailable。選べる数は selectable の行だけ', async () => {
      const order = await createCustomerOrder(db(), {
        lines: [{ quantity: 3 }, { quantity: 2 }, { quantity: 2 }, { quantity: 1 }, { quantity: 1 }],
        shipments: [
          {
            lines: [
              { lineIndex: 0, quantity: 3 },
              { lineIndex: 2, quantity: 2 },
              { lineIndex: 3, quantity: 1 },
              { lineIndex: 4, quantity: 1 },
            ],
            shippedAt: await shippedAtJst(db(), 2),
          },
          { lines: [{ lineIndex: 1, quantity: 2 }], shippedAt: await shippedAtJst(db(), 30) },
        ],
      });
      const first = order.fulfillments[0].id;
      // 申し込み中の返品が全部の数を指している品（index 2）
      await insertReturnRecord(db(), {
        orderId: order.orderId,
        status: 'requested',
        lines: [{ fulfillmentId: first, orderItemId: order.orderItemIds[2], quantity: 2 }],
      });
      // お返しした品（index 3）
      const sentBack = await insertReturnRecord(db(), {
        orderId: order.orderId,
        status: 'closed',
        lines: [{ fulfillmentId: first, orderItemId: order.orderItemIds[3], quantity: 1 }],
      });
      await insertReturnReceipt(db(), {
        returnId: sentBack.returnId,
        lines: [{ returnLineId: sentBack.lineIds[0], disposition: 'sent_back', quantity: 1 }],
      });
      // ふつうの返金で返した品（index 4）は、申し込める数が無い
      await insertRefundRecord(db(), {
        orderId: order.orderId,
        status: 'succeeded',
        amount: 5000,
        lines: [{ orderItemId: order.orderItemIds[4], quantity: 1, beforeShipment: false, amount: 5000 }],
      });

      const materials = await materialsOf(db(), order);

      const lineOf = (index: number) => allLines(materials).find((line) => line.order_item_id === order.orderItemIds[index]) as Row;
      expect([0, 1, 2, 3, 4].map((index) => [lineOf(index).state, lineOf(index).selectable])).toEqual([
        ['selectable', 3],
        ['past_deadline', 0],
        ['requested', 0],
        ['sent_back', 0],
        ['unavailable', 0],
      ]);
      // 発送ごとの期限。1 回目は今日から 8 日後、2 回目は 20 日前（30 日前に発送 + 10 日）
      expect(materials.shipments.map((shipment: Row) => [shipment.number, shipment.deadline_date, shipment.past_deadline])).toEqual([
        [1, await jstDate(db(), 8), false],
        [2, await jstDate(db(), -20), true],
      ]);
    });

    test('受付の有無は 4 つ: available・ended（終わった日つき）・closed（設定が受け付けない）・none', async () => {
      const fresh = await createCustomerOrder(db(), {});
      const expired = await createCustomerOrder(db(), {
        lines: [{ quantity: 1 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }], shippedAt: await shippedAtJst(db(), 30) }],
      });
      const taken = await createCustomerOrder(db(), { lines: [{ quantity: 2 }] });
      await insertReturnRecord(db(), {
        orderId: taken.orderId,
        status: 'requested',
        lines: [{ fulfillmentId: taken.fulfillments[0].id, orderItemId: taken.orderItemIds[0], quantity: 2 }],
      });
      const pending = await createUnshippedOrder(db(), 'pending');

      expect((await materialsOf(db(), fresh)).availability).toEqual({ returns: 'available', ended_on: null });
      expect((await materialsOf(db(), expired)).availability).toEqual({ returns: 'ended', ended_on: await jstDate(db(), -20) });
      // 申し込める品も期限切れの品も無い・支払い済みでも発送済みでもない注文は none
      expect((await materialsOf(db(), taken)).availability).toEqual({ returns: 'none', ended_on: null });
      const pendingMaterials = await materialsOf(db(), pending);
      expect(pendingMaterials.availability).toEqual({ returns: 'none', ended_on: null });
      expect(pendingMaterials.shipments).toEqual([]);

      // 設定が受け付けない（受付オフ・種類がキャンセルだけ）時は、期限切れの注文も closed
      await updateSettings(db(), { requests_enabled: false });
      expect((await materialsOf(db(), fresh)).availability.returns).toBe('closed');
      expect((await materialsOf(db(), expired)).availability.returns).toBe('closed');
      await updateSettings(db(), { requests_enabled: true, request_types: 'cancellations_only' });
      expect((await materialsOf(db(), fresh)).availability.returns).toBe('closed');
      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      expect((await materialsOf(db(), fresh)).availability.returns).toBe('available');
    });

    test('期限の境目: 期限の日（日本時間）は選べ、翌日は選べない。接続の時間帯が違っても同じで、窓口に直接送っても DB が断る（Review Focus 3）', async () => {
      // 日数 7・目安 3 なので期限 = 発送の日 + 10 日（手元の DB の残りの設定に頼らないよう、ここで置く）。
      // 取引の中の now() は動かないので、日本時間の今日から発送の日を引いて、期限が今日・昨日・明日になる 3 つの発送を作る
      await updateSettings(db(), { window_days: 7, window_start: 'each_item', delivery_buffer_days: 3 });
      const order = await createCustomerOrder(db(), {
        lines: [{ quantity: 2 }, { quantity: 1 }, { quantity: 1 }],
        shipments: [
          { lines: [{ lineIndex: 0, quantity: 2 }], shippedAt: await shippedAtJst(db(), 10) },
          { lines: [{ lineIndex: 1, quantity: 1 }], shippedAt: await shippedAtJst(db(), 11) },
          { lines: [{ lineIndex: 2, quantity: 1 }], shippedAt: await shippedAtJst(db(), 9) },
        ],
      });
      const expected = {
        [order.orderItemIds[0]]: 'selectable',
        [order.orderItemIds[1]]: 'past_deadline',
        [order.orderItemIds[2]]: 'selectable',
      };

      // 接続の時間帯（日本・協定世界時・西の端・東の端）によらず、日本時間の日付で比べる。
      // 画面の品の状態も、窓口を通さずに直接送った申し込みの DB の確かめも同じ（4 つの時間帯を合わせると、どの時刻に流しても
      // 日本時間と日付が違う時間帯が 1 つはある。通った申し込みは rejectionOf が savepoint で戻すので、次の時間帯に残らない）。
      // 期限の日の品は申し込めて（null）、翌日の品は DB が RETURN_NOT_ELIGIBLE で断る
      const lineOf = (index: number, quantity: number) =>
        reqLine(order, index, quantity, { fulfillment_id: order.fulfillments[index].id });
      for (const zone of ['Asia/Tokyo', 'UTC', 'Etc/GMT+12', 'Etc/GMT-14']) {
        await db().query(`set local time zone '${zone}'`);
        expect({ zone, states: statesOf(await materialsOf(db(), order)) }).toEqual({ zone, states: expected });
        expect({
          zone,
          deadlineToday: await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [lineOf(0, 2)] })),
          deadlineYesterday: await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [lineOf(1, 1)] })),
          deadlineTomorrow: await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [lineOf(2, 1)] })),
        }).toEqual({ zone, deadlineToday: null, deadlineYesterday: refusal('RETURN_NOT_ELIGIBLE'), deadlineTomorrow: null });
      }
      await db().query("set local time zone 'Asia/Tokyo'");
    });

    test('期限が無制限（日数が空）なら、ずっと前に発送した品も選べて、期限は空', async () => {
      const order = await createCustomerOrder(db(), {
        lines: [{ quantity: 1 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }], shippedAt: await shippedAtJst(db(), 400) }],
      });
      await updateSettings(db(), { window_days: null });

      const materials = await materialsOf(db(), order);

      expect(materials.availability).toEqual({ returns: 'available', ended_on: null });
      expect(materials.shipments[0]).toMatchObject({ deadline_date: null, past_deadline: false });
      expect(statesOf(materials)).toEqual({ [order.orderItemIds[0]]: 'selectable' });
    });

    test('返品不可の品は return_ineligible が真。出す理由は設定で出す物だけで、不明は設定が出すでも出さない', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 1 }, { quantity: 1 }] });
      await db().query('update public.items set return_ineligible = true where id = $1', [order.itemIds[1]]);
      await updateReason(db(), 'unknown', { shown: true });
      await updateReason(db(), 'unwanted', { shown: true });
      await updateReason(db(), 'size_too_large', { shown: false });

      const materials = await materialsOf(db(), order);

      expect(Object.fromEntries(allLines(materials).map((line) => [line.order_item_id, line.return_ineligible]))).toEqual({
        [order.orderItemIds[0]]: false,
        [order.orderItemIds[1]]: true,
      });
      expect(materials.reasons.map((reason: Row) => reason.reason)).toEqual([
        'defective',
        'wrong_item',
        'size_too_small',
        'unwanted',
        'other',
      ]);
    });

    test('取り消した発送は載せない。申し込める数は取り消していない発送の分だけ', async () => {
      const order = await createCustomerOrder(db(), {
        lines: [{ quantity: 3 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 2 }] }, { lines: [{ lineIndex: 0, quantity: 1 }], cancelled: true }],
      });

      const materials = await materialsOf(db(), order);

      expect(materials.shipments).toHaveLength(1);
      expect(materials.shipments[0].number).toBe(1);
      expect(materials.shipments[0].lines.map((line: Row) => line.selectable)).toEqual([2]);
    });
  });

  describe('写真の送り先（customer_create_return_photo_upload）', () => {
    test('送り先を 1 行足し、場所は requests/{注文の番号}/{送り先の番号}。まだ使っていない・消していない。呼ぶたびに別の送り先', async () => {
      const order = await createCustomerOrder(db(), {});

      const first = await db().query(PHOTO_UPLOAD_SQL, [order.orderId, order.customerId]);
      const second = await db().query(PHOTO_UPLOAD_SQL, [order.orderId, order.customerId]);

      const uploadId = first.rows[0].upload_id as string;
      expect(first.rows).toEqual([{ upload_id: uploadId, storage_path: `requests/${order.orderId}/${uploadId}` }]);
      expect(second.rows[0].upload_id).not.toBe(uploadId);
      expect(await uploadRow(db(), uploadId)).toMatchObject({
        order_id: order.orderId,
        customer_id: order.customerId,
        storage_path: `requests/${order.orderId}/${uploadId}`,
        attached_at: null,
        purged_at: null,
      });
    });

    test('受付が available でなければ送り先を出さない: 受け付けない設定は RETURN_REQUESTS_CLOSED、期限切れ・申し込める品が無い・支払い済みでも発送済みでもない注文は RETURN_NOT_ELIGIBLE', async () => {
      const fresh = await createCustomerOrder(db(), {});
      const expired = await createCustomerOrder(db(), {
        lines: [{ quantity: 1 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }], shippedAt: await shippedAtJst(db(), 30) }],
      });
      const taken = await createCustomerOrder(db(), { lines: [{ quantity: 1 }] });
      await insertReturnRecord(db(), {
        orderId: taken.orderId,
        status: 'requested',
        lines: [{ fulfillmentId: taken.fulfillments[0].id, orderItemId: taken.orderItemIds[0], quantity: 1 }],
      });
      const pending = await createUnshippedOrder(db(), 'pending');

      for (const [label, target] of [
        ['期限切れ', expired],
        ['申し込める品が無い', taken],
        ['未入金の注文', pending],
      ] as Array<[string, { orderId: string; customerId: string }]>) {
        const rejection = await rejectionOf(db(), PHOTO_UPLOAD_SQL, [target.orderId, target.customerId]);
        expect({ label, rejection }).toEqual({ label, rejection: refusal('RETURN_NOT_ELIGIBLE') });
      }

      await updateSettings(db(), { requests_enabled: false });
      expect(await rejectionOf(db(), PHOTO_UPLOAD_SQL, [fresh.orderId, fresh.customerId])).toEqual(refusal('RETURN_REQUESTS_CLOSED'));
      await updateSettings(db(), { requests_enabled: true, request_types: 'cancellations_only' });
      expect(await rejectionOf(db(), PHOTO_UPLOAD_SQL, [fresh.orderId, fresh.customerId])).toEqual(refusal('RETURN_REQUESTS_CLOSED'));
    });

    test('使っていない・消していない・1 日以内の送り先が 60 になると、61 個目は RETURN_PHOTO_INVALID。使い済み・消した・古い・ほかのお客様・ほかの注文の送り先は数えない', async () => {
      const order = await createCustomerOrder(db(), {});
      const stranger = await createCustomer(db(), 'stranger');
      const otherOrder = await createCustomerOrder(db(), {}, order.customerId);
      await insertUploads(db(), order, 59);
      // 数えない物
      await insertUploads(db(), order, 1, { attached: true });
      await insertUploads(db(), order, 1, { purged: true });
      await insertUploads(db(), order, 1, { ageHours: 25 });
      await insertUploads(db(), { orderId: order.orderId, customerId: stranger }, 1);
      await insertUploads(db(), otherOrder, 1);

      // 60 個目は出せる
      await expect(db().query(PHOTO_UPLOAD_SQL, [order.orderId, order.customerId])).resolves.toBeTruthy();
      // 61 個目は断る。ほかの注文は別に数える
      expect(await rejectionOf(db(), PHOTO_UPLOAD_SQL, [order.orderId, order.customerId])).toEqual(refusal('RETURN_PHOTO_INVALID'));
      await expect(db().query(PHOTO_UPLOAD_SQL, [otherOrder.orderId, otherOrder.customerId])).resolves.toBeTruthy();
    });
  });

  describe('返品を申し込む（customer_request_return）', () => {
    test('返金のご希望で申し込むと、状態 requested の返品・返品の行の仮の値・メールの予定 2 行ができ、申し込みの数は返品できる数から引かれる', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 3 }] });
      const key = crypto.randomUUID();

      const res = await requestReturn(db(), order, {
        requestKey: key,
        lines: [reqLine(order, 0, 2, { customer_note: '  色落ちがありました  ' })],
      });

      expect(res.rows).toEqual([{ return_id: expect.any(String), number: 1, status: 'requested', replayed: false }]);
      const returnId = res.rows[0].return_id as string;
      const created = await returnRow(db(), returnId);
      expect(created).toMatchObject({
        order_id: order.orderId,
        number: 1,
        source: 'customer_request',
        status: 'requested',
        request_key: key,
        requested_by: order.customerId,
        approved_at: null,
        approved_by: null,
        declined_at: null,
        closed_at: null,
        return_method: 'customer_ships',
        return_shipping_payer: 'customer',
        return_carrier: null,
        return_tracking_number: null,
        return_shipping_fee: 0,
        restocking_fee_percent: 0,
        exchange_fee: 0,
        exchange_shipping_fee: 0,
        fee_due_amount: 0,
        notify_customer: true,
        shop_note: null,
        created_by: null,
      });
      expect(created.requested_at).not.toBeNull();
      expect(created.request_fingerprint).toMatch(/^[0-9a-f]{32}$/);

      // 返品の行: 解決の仮の値はご希望と同じ（返金）。詳しい内容は前後の空白を外して残る
      expect(await returnLineRows(db(), returnId)).toEqual([
        expect.objectContaining({
          fulfillment_id: order.fulfillments[0].id,
          order_item_id: order.orderItemIds[0],
          quantity: 2,
          reason: 'other',
          reason_note: null,
          customer_note: '色落ちがありました',
          requested_resolution: 'refund',
          requested_exchange_variant_id: null,
          resolution: 'refund',
          exchange_variant_id: null,
          exchange_method: null,
        }),
      ]);
      expect(await photoRows(db(), returnId)).toEqual([]);
      // 申し込みの数は申し込みの時から数えに入る（段 1 の rq）
      expect((await countsOf(db(), order.orderId))[order.orderItemIds[0]]).toMatchObject({ shipped: 3, requested: 2, returnable: 1 });
      // メールの予定は、お客様への受付と店への知らせの 2 行。返品の番号が付き、受け取りの番号は空
      expect(await outboxRows(db(), order.orderId)).toEqual([
        { kind: 'return_requested', variant: null, origin: 'auto', status: 'pending', return_id: returnId, return_receipt_id: null, cancel_request_id: null },
        { kind: 'return_request_shop', variant: null, origin: 'auto', status: 'pending', return_id: returnId, return_receipt_id: null, cancel_request_id: null },
      ]);
    });

    test('交換のご希望と写真 2 枚で申し込むと、交換の色・サイズと送り方（在庫から）・写真の行・送り先の使用済みの印ができる。破損・不良はお店の負担', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 2 }] });
      const white = await addItemVariant(db(), { itemId: order.itemIds[0], colorName: 'WHITE', sizeLabel: 'L', stock: 5 });
      const first = await insertUpload(db(), order);
      const second = await insertUpload(db(), order);

      const res = await requestReturn(db(), order, {
        lines: [
          reqLine(order, 0, 1, {
            reason: 'defective',
            customer_note: '縫い目がほどけています',
            requested_resolution: 'exchange',
            requested_exchange_variant_id: white.variantId,
            photos: [photoOf(first), photoOf(second, { content_type: 'image/png', size_bytes: 4321 })],
          }),
        ],
      });

      const returnId = res.rows[0].return_id as string;
      expect(await returnRow(db(), returnId)).toMatchObject({
        return_method: 'customer_ships',
        return_shipping_payer: 'shop',
        return_shipping_fee: 0,
      });
      const [line] = await returnLineRows(db(), returnId);
      expect(line).toMatchObject({
        reason: 'defective',
        customer_note: '縫い目がほどけています',
        requested_resolution: 'exchange',
        resolution: 'exchange',
        exchange_method: 'stock',
      });
      expect(Number(line.requested_exchange_variant_id)).toBe(white.variantId);
      expect(Number(line.exchange_variant_id)).toBe(white.variantId);

      // 写真の行は送り先の場所を写し、確かめた種類と大きさを持つ（大きさの順に並べる）
      const photos = await photoRows(db(), returnId);
      expect(photos).toEqual([
        expect.objectContaining({ return_line_id: line.id, upload_id: second.id, storage_path: second.path, content_type: 'image/png', size_bytes: 4321, purged_at: null }),
        expect.objectContaining({ return_line_id: line.id, upload_id: first.id, storage_path: first.path, content_type: 'image/jpeg', size_bytes: 120000, purged_at: null }),
      ]);
      expect((await uploadRow(db(), first.id)).attached_at).not.toBeNull();
      expect((await uploadRow(db(), second.id)).attached_at).not.toBeNull();
    });

    test('同じ二重防止の番号で同じ中身を送り直すと、前の返品を返し、返品・写真・メールの予定は増えない。使い済みの写真でも、承認が進んでいても、設定が変わっても同じ（Review Focus 1）', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 2 }, { quantity: 1 }] });
      const upload = await insertUpload(db(), order);
      const key = crypto.randomUUID();
      const lines = [
        reqLine(order, 0, 1),
        reqLine(order, 1, 1, { reason: 'defective', customer_note: '破れています', photos: [photoOf(upload)] }),
      ];

      const first = await requestReturn(db(), order, { requestKey: key, lines });
      const returnId = first.rows[0].return_id as string;
      const before = await recordCounts(db(), order.orderId);
      expect(before).toEqual({ returns: 1, lines: 2, photos: 1, attached: 1, cancel_requests: 0, mails: 2 });
      const attachedAt = (await uploadRow(db(), upload.id)).attached_at;

      // 通信が切れた後の「もう一度確かめる」: 同じ番号・同じ中身（行の並びは逆）。送り先は使い済みだが、前の返品を返す
      const again = await requestReturn(db(), order, { requestKey: key, lines: [...lines].reverse() });
      expect(again.rows).toEqual([{ return_id: returnId, number: 1, status: 'requested', replayed: true }]);
      expect(await recordCounts(db(), order.orderId)).toEqual(before);
      expect((await uploadRow(db(), upload.id)).attached_at).toEqual(attachedAt);

      // 承認が先に進んでいても、受付を止めても、同じ番号の送り直しは前の返品を返す
      await db().query("update public.order_returns set status = 'open', approved_at = now(), approved_by = gen_random_uuid() where id = $1", [returnId]);
      await updateSettings(db(), { requests_enabled: false });
      const late = await requestReturn(db(), order, { requestKey: key, lines });
      expect(late.rows).toEqual([{ return_id: returnId, number: 1, status: 'requested', replayed: true }]);
      expect(await recordCounts(db(), order.orderId)).toEqual(before);

      // 別のお客様は、持ち主を確かめる段で断られる（前の返品があるかどうかを漏らさない）
      const stranger = await createCustomer(db(), 'stranger');
      expect(await rejectionOf(db(), REQUEST_SQL, requestParams(order, { customerId: stranger, requestKey: key, lines }))).toEqual(NOT_FOUND);
    });

    test('同じ番号で違う中身（数・詳しい内容・理由・ご希望・写真・ほかの注文）が来たら RETURN_REQUEST_MISMATCH で断り、記録は増えない', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 3 }] });
      const other = await createCustomerOrder(db(), { lines: [{ quantity: 1 }] }, order.customerId);
      const white = await addItemVariant(db(), { itemId: order.itemIds[0], colorName: 'WHITE', sizeLabel: 'L', stock: 5 });
      const upload = await insertUpload(db(), order);
      const key = crypto.randomUUID();
      await requestReturn(db(), order, { requestKey: key, lines: [reqLine(order, 0, 1)] });
      const before = await recordCounts(db(), order.orderId);

      const variants: Array<[string, RequestInput]> = [
        ['数', { lines: [reqLine(order, 0, 2)] }],
        ['詳しい内容', { lines: [reqLine(order, 0, 1, { customer_note: '別の内容' })] }],
        ['理由', { lines: [reqLine(order, 0, 1, { reason: 'size_too_small' })] }],
        ['ご希望', { lines: [reqLine(order, 0, 1, { requested_resolution: 'exchange', requested_exchange_variant_id: white.variantId })] }],
        ['写真', { lines: [reqLine(order, 0, 1, { photos: [photoOf(upload)] })] }],
        ['ほかの注文', { orderId: other.orderId, lines: [reqLine(other, 0, 1)] }],
      ];
      for (const [label, input] of variants) {
        const rejection = await rejectionOf(db(), REQUEST_SQL, requestParams(order, { ...input, requestKey: key }));
        expect({ label, rejection }).toEqual({ label, rejection: refusal('RETURN_REQUEST_MISMATCH') });
      }
      expect(await recordCounts(db(), order.orderId)).toEqual(before);
      expect((await recordCounts(db(), other.orderId)).returns).toBe(0);
    });

    test('受け付けない設定（受付オフ・種類がキャンセルだけ）は RETURN_REQUESTS_CLOSED。種類が返品だけ・返品とキャンセルなら受ける', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 3 }] });

      await updateSettings(db(), { requests_enabled: false });
      expect(await rejectionOf(db(), REQUEST_SQL, requestParams(order))).toEqual(refusal('RETURN_REQUESTS_CLOSED'));
      await updateSettings(db(), { requests_enabled: true, request_types: 'cancellations_only' });
      expect(await rejectionOf(db(), REQUEST_SQL, requestParams(order))).toEqual(refusal('RETURN_REQUESTS_CLOSED'));

      for (const types of ['returns_only', 'returns_and_cancellations']) {
        await updateSettings(db(), { request_types: types });
        await expect(requestReturn(db(), order)).resolves.toBeTruthy();
      }
      expect((await recordCounts(db(), order.orderId)).returns).toBe(2);
    });

    test('注文が支払い済みでも発送済みでもなければ ORDER_NOT_RETURNABLE（未入金・失敗・取消）', async () => {
      const owner = await createCustomer(db());
      for (const status of ['pending', 'failed', 'cancelled']) {
        const target = await createUnshippedOrder(db(), status, { customerId: owner });
        const lines = [
          {
            fulfillment_id: crypto.randomUUID(),
            order_item_id: target.orderItemIds[0],
            quantity: 1,
            reason: 'other',
            customer_note: 'メモ',
            requested_resolution: 'refund',
            requested_exchange_variant_id: null,
            photos: [],
          },
        ];
        const rejection = await rejectionOf(db(), REQUEST_SQL, [target.orderId, owner, crypto.randomUUID(), JSON.stringify(lines)]);
        expect({ status, rejection }).toEqual({ status, rejection: refusal('ORDER_NOT_RETURNABLE') });
      }
    });

    test('発送の行がこの注文の取り消していない発送の行でなければ RETURN_ARGUMENT_INVALID（取り消した発送・知らない発送・ほかの注文の発送と商品）', async () => {
      const order = await createCustomerOrder(db(), {
        lines: [{ quantity: 3 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 2 }] }, { lines: [{ lineIndex: 0, quantity: 1 }], cancelled: true }],
      });
      const other = await createCustomerOrder(db(), { lines: [{ quantity: 1 }] }, order.customerId);

      for (const [label, extra] of [
        ['取り消した発送', { fulfillment_id: order.fulfillments[1].id }],
        ['知らない発送', { fulfillment_id: crypto.randomUUID() }],
        ['ほかの注文の発送', { fulfillment_id: other.fulfillments[0].id }],
        ['ほかの注文の商品', { order_item_id: other.orderItemIds[0] }],
      ] as Array<[string, Record<string, unknown>]>) {
        const rejection = await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [reqLine(order, 0, 1, extra)] }));
        expect({ label, rejection }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
    });

    test('返品できる数を超えると RETURN_QUANTITY_EXCEEDS（発送の行ごと・注文の商品ごと・別の発送の合計・申し込み中の数を含めて）。数は 0 より小さくならない（Review Focus 4）', async () => {
      const exceeds = refusal('RETURN_QUANTITY_EXCEEDS');

      // 発送の行ごと: 注文は 3 点でも、2 回目の発送は 1 点だけ。申し込み中の数も引く
      const split = await createCustomerOrder(db(), {
        lines: [{ quantity: 3 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 2 }] }, { lines: [{ lineIndex: 0, quantity: 1 }] }],
      });
      const onFirst = (quantity: number) => reqLine(split, 0, quantity, { fulfillment_id: split.fulfillments[0].id });
      const onSecond = (quantity: number) => reqLine(split, 0, quantity, { fulfillment_id: split.fulfillments[1].id });
      await expectRejected(db(), REQUEST_SQL, requestParams(split, { lines: [onSecond(2)] }), exceeds);
      await expect(requestReturn(db(), split, { lines: [onSecond(1)] })).resolves.toBeTruthy();
      await expectRejected(db(), REQUEST_SQL, requestParams(split, { lines: [onSecond(1)] }), exceeds);
      await expect(requestReturn(db(), split, { lines: [onFirst(2)] })).resolves.toBeTruthy();
      await expectRejected(db(), REQUEST_SQL, requestParams(split, { lines: [onFirst(1)] }), exceeds);
      expect((await countsOf(db(), split.orderId))[split.orderItemIds[0]]).toMatchObject({ requested: 3, returnable: 0 });

      // 注文の商品ごと: ふつうの返金で 2 点を先に返した後は、申し込めるのは 1 点だけ
      const refunded = await createCustomerOrder(db(), { lines: [{ quantity: 3 }] });
      await insertRefundRecord(db(), {
        orderId: refunded.orderId,
        status: 'succeeded',
        amount: 10000,
        lines: [{ orderItemId: refunded.orderItemIds[0], quantity: 2, beforeShipment: false, amount: 10000 }],
      });
      await expectRejected(db(), REQUEST_SQL, requestParams(refunded, { lines: [reqLine(refunded, 0, 2)] }), exceeds);
      await expect(requestReturn(db(), refunded, { lines: [reqLine(refunded, 0, 1)] })).resolves.toBeTruthy();

      // 別の発送の同じ商品は合計で確かめる（1 行ずつなら通る数）
      const together = await createCustomerOrder(db(), {
        lines: [{ quantity: 3 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 2 }] }, { lines: [{ lineIndex: 0, quantity: 1 }] }],
      });
      await insertRefundRecord(db(), {
        orderId: together.orderId,
        status: 'succeeded',
        amount: 5000,
        lines: [{ orderItemId: together.orderItemIds[0], quantity: 1, beforeShipment: false, amount: 5000 }],
      });
      await expectRejected(
        db(),
        REQUEST_SQL,
        requestParams(together, {
          lines: [
            reqLine(together, 0, 2, { fulfillment_id: together.fulfillments[0].id }),
            reqLine(together, 0, 1, { fulfillment_id: together.fulfillments[1].id }),
          ],
        }),
        exceeds,
      );
    });

    test('お断り（declined）にした返品の品は、同じお客様がもう一度申し込める: 品の状態は selectable に戻り、同じ品・同じ数の新しい申し込みが次の番号で通り、メールの予定が新しい返品に 1 組できる（仕様書 5-2）', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 2 }] });
      const itemId = order.orderItemIds[0];
      const stateOfItem = async () => statesOf(await materialsOf(db(), order))[itemId];

      // 全部の数を申し込むと、品は申し込み中（requested）で選べず、もう 1 点も申し込めない
      const first = await requestReturn(db(), order, { lines: [reqLine(order, 0, 2)] });
      const firstId = first.rows[0].return_id as string;
      expect(first.rows[0].number).toBe(1);
      expect(await stateOfItem()).toBe('requested');
      expect(await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [reqLine(order, 0, 1)] }))).toEqual(
        refusal('RETURN_QUANTITY_EXCEEDS'),
      );

      // お断り（requested → declined）。お断りの関数は移行 F（Task 3）にあり、この試験が流れる時点では無いので、
      // 返品の表を直に進める（Task 1 の守りが通す、状態とお断りの列だけの更新。数・理由などの列は変えない）
      await db().query(
        `update public.order_returns
         set status = 'declined', declined_at = now(), declined_by = gen_random_uuid(),
             decline_reason = 'final_sale', decline_message = 'この商品は返品不可の商品のため、お受けできませんでした。'
         where id = $1`,
        [firstId],
      );

      // お断りの返品は数に入らない（段 1 の数え方は requested・open・closed だけ）。品は選べる状態に戻り、受付も available のまま
      expect((await countsOf(db(), order.orderId))[itemId]).toMatchObject({ shipped: 2, requested: 0, returnable: 2 });
      const materials = await materialsOf(db(), order);
      expect(allLines(materials).find((line) => line.order_item_id === itemId)).toMatchObject({ state: 'selectable', selectable: 2 });
      expect(materials.availability).toMatchObject({ returns: 'available' });

      // 同じ品・同じ数で、新しい二重防止の番号の申し込みが通る。番号は次（2）で、お断りの返品はそのまま残る
      const second = await requestReturn(db(), order, { lines: [reqLine(order, 0, 2)] });
      const secondId = second.rows[0].return_id as string;
      expect(second.rows).toEqual([{ return_id: expect.any(String), number: 2, status: 'requested', replayed: false }]);
      expect(secondId).not.toBe(firstId);
      expect(await returnRow(db(), firstId)).toMatchObject({ number: 1, status: 'declined' });
      expect((await countsOf(db(), order.orderId))[itemId]).toMatchObject({ shipped: 2, requested: 2, returnable: 0 });
      expect(await stateOfItem()).toBe('requested');
      expect((await returnsOf(db(), order)).returns.map((entry: Row) => [entry.number, entry.customer_status])).toEqual([
        [2, 'requested'],
        [1, 'declined'],
      ]);

      // メールの予定は、新しい返品に受付と店への知らせの 1 組ができる（お断りの返品の 1 組とは別の行。返品ごと・種類ごとに 1 行の一意の索引にぶつからない）
      expect((await outboxRows(db(), order.orderId)).map((mail) => [mail.kind, mail.return_id])).toEqual([
        ['return_requested', firstId],
        ['return_request_shop', firstId],
        ['return_requested', secondId],
        ['return_request_shop', secondId],
      ]);
    });

    test('出していない理由・不明・返品不可の品に許さない理由は RETURN_NOT_ELIGIBLE。返品不可の品は破損・不良と注文と違う品だけ申し込める', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 4 }, { quantity: 4 }] });
      await db().query('update public.items set return_ineligible = true where id = $1', [order.itemIds[1]]);
      // 不明は、設定が出すにしてもお客様には出さない
      await updateReason(db(), 'unknown', { shown: true });

      for (const [label, line] of [
        ['出していない理由（色）', reqLine(order, 0, 1, { reason: 'color' })],
        ['出していない理由（不要になった）', reqLine(order, 0, 1, { reason: 'unwanted' })],
        ['不明', reqLine(order, 0, 1, { reason: 'unknown' })],
        ['返品不可の品のその他', reqLine(order, 1, 1, { reason: 'other' })],
        ['返品不可の品のサイズ', reqLine(order, 1, 1, { reason: 'size_too_small', requested_resolution: 'exchange', requested_exchange_variant_id: order.variantIds[1] })],
      ] as Array<[string, Record<string, unknown>]>) {
        const rejection = await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [line] }));
        expect({ label, rejection }).toEqual({ label, rejection: refusal('RETURN_NOT_ELIGIBLE') });
      }

      // 返品不可の品でも、破損・不良と注文と違う品は申し込める
      const defective = await insertUpload(db(), order);
      const wrong = await insertUpload(db(), order);
      await expect(
        requestReturn(db(), order, { lines: [reqLine(order, 1, 1, { reason: 'defective', photos: [photoOf(defective)] })] }),
      ).resolves.toBeTruthy();
      await expect(
        requestReturn(db(), order, { lines: [reqLine(order, 1, 1, { reason: 'wrong_item', customer_note: null, photos: [photoOf(wrong)] })] }),
      ).resolves.toBeTruthy();
    });

    test('詳しい内容は破損・不良とその他では必須（前後の空白・全角の空白・改行を外して 1〜300 字）、ほかは任意。301 字は RETURN_ARGUMENT_INVALID', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 6 }] });
      const photo = await insertUpload(db(), order);

      for (const [label, extra] of [
        ['破損・不良で詳しい内容が空', { reason: 'defective', customer_note: null, photos: [photoOf(photo)] }],
        ['破損・不良で空白だけ', { reason: 'defective', customer_note: '   ', photos: [photoOf(photo)] }],
        ['破損・不良で全角の空白と改行だけ', { reason: 'defective', customer_note: '\u3000\n', photos: [photoOf(photo)] }],
        ['その他で詳しい内容が空', { reason: 'other', customer_note: null }],
        ['その他で空文字', { reason: 'other', customer_note: '' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const rejection = await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [reqLine(order, 0, 1, extra)] }));
        expect({ label, rejection }).toEqual({ label, rejection: refusal('RETURN_CUSTOMER_NOTE_REQUIRED') });
      }
      expect(
        await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [reqLine(order, 0, 1, { customer_note: 'あ'.repeat(301) })] })),
      ).toEqual(INVALID_ARGUMENT);

      // 300 字ちょうどは通る。注文と違う品は詳しい内容が任意
      const long = await requestReturn(db(), order, { lines: [reqLine(order, 0, 1, { customer_note: 'あ'.repeat(300) })] });
      expect((await returnLineRows(db(), long.rows[0].return_id))[0].customer_note).toHaveLength(300);
      await expect(
        requestReturn(db(), order, { lines: [reqLine(order, 0, 1, { reason: 'wrong_item', customer_note: null, photos: [photoOf(photo)] })] }),
      ).resolves.toBeTruthy();
    });

    test('ご希望が理由の設定の「ご希望」に無ければ RETURN_NOT_ELIGIBLE（交換だけの理由に返金・返金だけの理由に交換）', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 4 }] });
      const white = await addItemVariant(db(), { itemId: order.itemIds[0], colorName: 'WHITE', sizeLabel: 'L', stock: 5 });
      const notEligible = refusal('RETURN_NOT_ELIGIBLE');
      const exchange = { requested_resolution: 'exchange', requested_exchange_variant_id: white.variantId };

      // サイズが小さい: 最初の値は交換だけ
      expect(await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [reqLine(order, 0, 1, { reason: 'size_too_small', customer_note: null })] }))).toEqual(notEligible);
      await expect(
        requestReturn(db(), order, { lines: [reqLine(order, 0, 1, { reason: 'size_too_small', customer_note: null, ...exchange })] }),
      ).resolves.toBeTruthy();

      // その他を返金だけに変えると、交換は受けない。返金は通る
      await updateReason(db(), 'other', { resolutions: 'refund_only' });
      expect(await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [reqLine(order, 0, 1, exchange)] }))).toEqual(notEligible);
      await expect(requestReturn(db(), order, { lines: [reqLine(order, 0, 1)] })).resolves.toBeTruthy();

      // 返金と交換なら、どちらも通る
      await updateReason(db(), 'other', { resolutions: 'refund_and_exchange' });
      await expect(requestReturn(db(), order, { lines: [reqLine(order, 0, 1, exchange)] })).resolves.toBeTruthy();
    });

    test('交換の色・サイズは同じ商品の使える物だけ（RETURN_EXCHANGE_VARIANT_INVALID）。在庫が申し込む数より少ない時は、理由の設定が decline なら RETURN_NOT_ELIGIBLE、make なら作って送る行になる', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 6 }] });
      const other = await createCustomerOrder(db(), { lines: [{ quantity: 1 }] }, order.customerId);
      const stocked = await addItemVariant(db(), { itemId: order.itemIds[0], colorName: 'WHITE', sizeLabel: 'L', stock: 2 });
      const shortage = await addItemVariant(db(), { itemId: order.itemIds[0], colorName: 'GREEN', sizeLabel: 'XL', stock: 1 });
      const retired = await addItemVariant(db(), { itemId: order.itemIds[0], colorName: 'RED', sizeLabel: 'S', isActive: false });
      const exchangeOf = (variantId: number | null, quantity = 1, extra: Record<string, unknown> = {}) =>
        reqLine(order, 0, quantity, {
          reason: 'size_too_small',
          customer_note: null,
          requested_resolution: 'exchange',
          requested_exchange_variant_id: variantId,
          ...extra,
        });

      for (const [label, variantId] of [
        ['ほかの商品の色・サイズ', other.variantIds[0]],
        ['使えない色・サイズ', retired.variantId],
        ['知らない色・サイズ', 999999999],
        ['色・サイズが空', null],
      ] as Array<[string, number | null]>) {
        const rejection = await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [exchangeOf(variantId)] }));
        expect({ label, rejection }).toEqual({ label, rejection: refusal('RETURN_EXCHANGE_VARIANT_INVALID') });
      }
      // 返金なのに色・サイズがある形は引数の誤り
      expect(
        await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [reqLine(order, 0, 1, { requested_exchange_variant_id: stocked.variantId })] })),
      ).toEqual(INVALID_ARGUMENT);

      // 在庫が申し込む数より少ない: サイズが小さいの最初の値は decline（受けない）
      expect(await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [exchangeOf(shortage.variantId, 2)] }))).toEqual(
        refusal('RETURN_NOT_ELIGIBLE'),
      );
      // 在庫がちょうどなら stock
      const exact = await requestReturn(db(), order, { lines: [exchangeOf(stocked.variantId, 2)] });
      expect((await returnLineRows(db(), exact.rows[0].return_id))[0]).toMatchObject({ resolution: 'exchange', exchange_method: 'stock' });
      // make にすると、足りない色・サイズも選べて、作って送る行になる
      await updateReason(db(), 'size_too_small', { out_of_stock_exchange: 'make' });
      const made = await requestReturn(db(), order, { lines: [exchangeOf(shortage.variantId, 2)] });
      const [madeLine] = await returnLineRows(db(), made.rows[0].return_id);
      expect(madeLine).toMatchObject({ resolution: 'exchange', exchange_method: 'make' });
      expect(Number(madeLine.exchange_variant_id)).toBe(shortage.variantId);
    });

    test('写真は理由の設定の「写真」に合う枚数で、送り先がこの注文とこのお客様の、使っていない・消していない・作ってから 23 時間以内の物だけ（RETURN_PHOTO_INVALID）。5 枚まで', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 3 }, { quantity: 3 }] });
      const stranger = await createCustomer(db(), 'stranger');
      const otherOrder = await createCustomerOrder(db(), {}, order.customerId);
      const mine = await insertUpload(db(), order);
      const strangers = await insertUpload(db(), { orderId: order.orderId, customerId: stranger });
      const ofOtherOrder = await insertUpload(db(), otherOrder);
      const used = await insertUpload(db(), order, { attached: true });
      const gone = await insertUpload(db(), order, { purged: true });
      // 消す処理は作ってから 1 日を過ぎた物を消すので、申し込みに使えるのは 23 時間まで（1 時間あける。P6）
      const stale = await insertUpload(db(), order, { ageHours: 24 });
      const defective = (photos: unknown[], extra: Record<string, unknown> = {}) =>
        reqLine(order, 0, 1, { reason: 'defective', customer_note: '破れています', photos, ...extra });
      const invalidPhoto = refusal('RETURN_PHOTO_INVALID');

      for (const [label, line] of [
        ['必須なのに写真が無い', defective([])],
        ['知らない送り先', defective([{ upload_id: crypto.randomUUID(), content_type: 'image/jpeg', size_bytes: 1000 }])],
        ['ほかのお客様の送り先', defective([photoOf(strangers)])],
        ['ほかの注文の送り先', defective([photoOf(ofOtherOrder)])],
        ['使い済みの送り先', defective([photoOf(used)])],
        ['消した送り先', defective([photoOf(gone)])],
        ['作ってから 23 時間を過ぎた送り先', defective([photoOf(stale)])],
        ['種類が違う', defective([photoOf(mine, { content_type: 'image/gif' })])],
        ['大きさが 0', defective([photoOf(mine, { size_bytes: 0 })])],
        ['大きさが 10MiB を超える', defective([photoOf(mine, { size_bytes: 10485761 })])],
        ['同じ送り先を 2 回', defective([photoOf(mine), photoOf(mine)])],
      ] as Array<[string, Record<string, unknown>]>) {
        const rejection = await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [line] }));
        expect({ label, rejection }).toEqual({ label, rejection: invalidPhoto });
      }

      // 6 枚は断る。同じ送り先を 2 つの行で使うことも断る
      const six = await Promise.all(Array.from({ length: 6 }, () => insertUpload(db(), order)));
      expect(await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [defective(six.map((upload) => photoOf(upload)))] }))).toEqual(invalidPhoto);
      expect(
        await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [defective([photoOf(mine)]), reqLine(order, 1, 1, { photos: [photoOf(mine)] })] })),
      ).toEqual(invalidPhoto);

      // 写真が「なし」の理由に写真は付けられない
      await updateReason(db(), 'other', { photo: 'none' });
      expect(await rejectionOf(db(), REQUEST_SQL, requestParams(order, { lines: [reqLine(order, 1, 1, { photos: [photoOf(mine)] })] }))).toEqual(invalidPhoto);
      expect(await recordCounts(db(), order.orderId)).toMatchObject({ returns: 0, lines: 0, photos: 0, attached: 1 });

      // 5 枚は通る（22 時間前に作った送り先も使える）。写真の行も 5 つ。使った送り先に印が付く
      const recent = await insertUpload(db(), order, { ageHours: 22 });
      const five = [recent, ...six.slice(0, 4)];
      const ok = await requestReturn(db(), order, { lines: [defective(five.map((upload) => photoOf(upload)))] });
      expect(await photoRows(db(), ok.rows[0].return_id)).toHaveLength(5);
      expect(await recordCounts(db(), order.orderId)).toMatchObject({ returns: 1, lines: 1, photos: 5, attached: 6 });
    });

    test('返送の方法と負担、手数料の仮の値（P5）: 理由のどれかがお店の負担ならお店・着払い、ほかは設定のお客様負担の送り方。手数料は設定で使う時だけ', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 2 }, { quantity: 2 }, { quantity: 2 }] });
      const photo = await insertUpload(db(), order);
      const feesOf = async (returnId: string) => {
        const row = await returnRow(db(), returnId);
        return {
          method: row.return_method,
          payer: row.return_shipping_payer,
          shippingFee: row.return_shipping_fee,
          restocking: row.restocking_fee_percent,
          exchangeFee: row.exchange_fee,
          exchangeShippingFee: row.exchange_shipping_fee,
        };
      };
      const ask = async (lines: unknown[]) => (await requestReturn(db(), order, { lines })).rows[0].return_id as string;
      const shopPays = reqLine(order, 1, 1, { reason: 'wrong_item', customer_note: null, photos: [photoOf(photo)] });

      // 最初の設定: お客様が自分で送る。手数料は使わない（設定の値があっても 0）。
      // 手元の DB に E2E などが残した設定に頼らないよう、使う・使わないの印も自分で置く
      await updateSettings(db(), {
        customer_paid_method: 'customer_ships',
        shop_label_fee: 800,
        restocking_fee_enabled: false,
        restocking_fee_percent: 10,
        exchange_fees_enabled: false,
        exchange_fee: 300,
        exchange_shipping_fee: 500,
      });
      expect(await feesOf(await ask([reqLine(order, 0, 1)]))).toEqual({
        method: 'customer_ships',
        payer: 'customer',
        shippingFee: 0,
        restocking: 0,
        exchangeFee: 0,
        exchangeShippingFee: 0,
      });

      // お店の送り状・手数料を使う: お客様の負担なら定額が付く。手数料は設定の値
      await updateSettings(db(), { customer_paid_method: 'shop_label', restocking_fee_enabled: true, exchange_fees_enabled: true });
      expect(await feesOf(await ask([reqLine(order, 0, 1)]))).toEqual({
        method: 'shop_label',
        payer: 'customer',
        shippingFee: 800,
        restocking: 10,
        exchangeFee: 300,
        exchangeShippingFee: 500,
      });

      // 行のどれかがお店の負担（注文と違う品）なら、全体がお店の負担・着払いで、定額は 0
      expect(await feesOf(await ask([reqLine(order, 2, 1), shopPays]))).toMatchObject({
        method: 'customer_ships',
        payer: 'shop',
        shippingFee: 0,
      });
    });

    test('行の形が違えば RETURN_ARGUMENT_INVALID。交換なのに色・サイズが無ければ RETURN_EXCHANGE_VARIANT_INVALID', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 2 }] });
      const withLine = (extra: Record<string, unknown>) => ({ lines: [reqLine(order, 0, 1, extra)] });
      const cases: Array<[string, RequestInput]> = [
        ['行が配列でない', { lines: {} }],
        ['行が空の配列', { lines: [] }],
        ['行が 101 行', { lines: Array.from({ length: 101 }, () => reqLine(order, 0, 1)) }],
        ['行がオブジェクトでない', { lines: [5] }],
        ['同じ発送の同じ商品が 2 行', { lines: [reqLine(order, 0, 1), reqLine(order, 0, 1)] }],
        ['発送が空', withLine({ fulfillment_id: undefined })],
        ['発送が文字でない', withLine({ fulfillment_id: 123 })],
        ['発送が番号の形でない', withLine({ fulfillment_id: 'abc' })],
        ['商品が空', withLine({ order_item_id: undefined })],
        ['数が 0', withLine({ quantity: 0 })],
        ['数が小数', withLine({ quantity: 1.5 })],
        ['数が 1000', withLine({ quantity: 1000 })],
        ['数が文字', withLine({ quantity: '1' })],
        ['理由が空', withLine({ reason: undefined })],
        ['理由が違う', withLine({ reason: 'broken' })],
        ['詳しい内容が数', withLine({ customer_note: 5 })],
        ['詳しい内容が 301 字', withLine({ customer_note: 'あ'.repeat(301) })],
        ['ご希望が空', withLine({ requested_resolution: undefined })],
        ['ご希望が違う', withLine({ requested_resolution: 'swap' })],
        ['交換の色・サイズが文字', withLine({ requested_exchange_variant_id: '5' })],
        ['返金なのに色・サイズがある', withLine({ requested_exchange_variant_id: 5 })],
        ['写真の欄が無い', withLine({ photos: undefined })],
        ['写真が配列でない', withLine({ photos: 'x' })],
        ['写真がオブジェクトでない', withLine({ photos: [5] })],
        ['写真の送り先が番号の形でない', withLine({ photos: [{ upload_id: 'abc', content_type: 'image/jpeg', size_bytes: 1000 }] })],
        ['写真の種類が文字でない', withLine({ photos: [{ upload_id: crypto.randomUUID(), content_type: 5, size_bytes: 1000 }] })],
        ['写真の大きさが文字', withLine({ photos: [{ upload_id: crypto.randomUUID(), content_type: 'image/jpeg', size_bytes: '1000' }] })],
      ];
      for (const [label, input] of cases) {
        const rejection = await rejectionOf(db(), REQUEST_SQL, requestParams(order, input));
        expect({ label, rejection }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
      expect(
        await rejectionOf(db(), REQUEST_SQL, requestParams(order, withLine({ requested_resolution: 'exchange', requested_exchange_variant_id: null }))),
      ).toEqual(refusal('RETURN_EXCHANGE_VARIANT_INVALID'));
      expect(await recordCounts(db(), order.orderId)).toMatchObject({ returns: 0, lines: 0, photos: 0, mails: 0 });
    });

    test('注文の番号・お客様の番号・二重防止の番号・行が空なら RETURN_ARGUMENT_INVALID', async () => {
      const order = await createCustomerOrder(db(), {});
      for (const [label, params] of [
        ['注文の番号が空', requestParams(order, { orderId: null })],
        ['お客様の番号が空', requestParams(order, { customerId: null })],
        ['二重防止の番号が空', requestParams(order, { requestKey: null })],
        ['行が SQL の NULL', [order.orderId, order.customerId, crypto.randomUUID(), null]],
      ] as Array<[string, unknown[]]>) {
        expect({ label, rejection: await rejectionOf(db(), REQUEST_SQL, params) }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
    });

    test('断る順番は最初に当たった物で止める: 期限 → 数 → 理由 → 詳しい内容 → ご希望 → 交換の色・サイズ → 写真（P4）', async () => {
      const expired = await createCustomerOrder(db(), {
        lines: [{ quantity: 1 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }], shippedAt: await shippedAtJst(db(), 30) }],
      });
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 1 }] });
      const other = await createCustomerOrder(db(), { lines: [{ quantity: 1 }] }, order.customerId);
      const first = (target: CustomerOrder, input: RequestInput) => rejectionOf(db(), REQUEST_SQL, requestParams(target, input));

      // 期限切れで、数も多い → 期限（RETURN_NOT_ELIGIBLE。数の誤りではない）
      expect(await first(expired, { lines: [reqLine(expired, 0, 5)] })).toEqual(refusal('RETURN_NOT_ELIGIBLE'));
      // 数が多くて、出していない理由 → 数
      expect(await first(order, { lines: [reqLine(order, 0, 5, { reason: 'color' })] })).toEqual(refusal('RETURN_QUANTITY_EXCEEDS'));
      // 出していない理由で、詳しい内容も無い → 理由（RETURN_NOT_ELIGIBLE）
      await updateReason(db(), 'defective', { shown: false });
      expect(await first(order, { lines: [reqLine(order, 0, 1, { reason: 'defective', customer_note: null })] })).toEqual(
        refusal('RETURN_NOT_ELIGIBLE'),
      );
      // 詳しい内容が無くて、ご希望も違う → 詳しい内容
      await updateReason(db(), 'other', { resolutions: 'refund_only' });
      expect(
        await first(order, {
          lines: [reqLine(order, 0, 1, { customer_note: null, requested_resolution: 'exchange', requested_exchange_variant_id: other.variantIds[0] })],
        }),
      ).toEqual(refusal('RETURN_CUSTOMER_NOTE_REQUIRED'));
      // ご希望が違って、交換の色・サイズも違う → ご希望（RETURN_NOT_ELIGIBLE）
      expect(
        await first(order, {
          lines: [reqLine(order, 0, 1, { requested_resolution: 'exchange', requested_exchange_variant_id: other.variantIds[0] })],
        }),
      ).toEqual(refusal('RETURN_NOT_ELIGIBLE'));
      // 交換の色・サイズが違って、必須の写真も無い → 交換の色・サイズ
      await updateReason(db(), 'defective', { shown: true });
      expect(
        await first(order, {
          lines: [
            reqLine(order, 0, 1, { reason: 'defective', requested_resolution: 'exchange', requested_exchange_variant_id: other.variantIds[0] }),
          ],
        }),
      ).toEqual(refusal('RETURN_EXCHANGE_VARIANT_INVALID'));
      // 最後が写真
      expect(await first(order, { lines: [reqLine(order, 0, 1, { reason: 'defective' })] })).toEqual(refusal('RETURN_PHOTO_INVALID'));
    });
  });

  describe('キャンセルを申し込む（customer_request_cancel）', () => {
    test('未発送の品と数・ご連絡事項で申し込むと、状態 requested の申し込み・行・メールの予定 2 行ができる。注文はまだ変わらない', async () => {
      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      const order = await createPartlyShippedOrder(db());
      const key = crypto.randomUUID();

      const res = await requestCancel(db(), order, {
        requestKey: key,
        lines: [{ order_item_id: order.orderItemIds[0], quantity: 2 }],
        note: '  届く前にやめたいです  ',
      });

      expect(res.rows).toEqual([{ cancel_request_id: expect.any(String), status: 'requested', replayed: false }]);
      const cancelId = res.rows[0].cancel_request_id as string;
      const row = (await db().query('select * from public.order_cancel_requests where id = $1', [cancelId])).rows[0];
      expect(row).toMatchObject({
        order_id: order.orderId,
        status: 'requested',
        request_key: key,
        customer_note: '届く前にやめたいです',
        requested_by: order.customerId,
        decline_reason: null,
        decline_message: null,
        declined_at: null,
        resolved_at: null,
        closed_at: null,
      });
      expect(row.request_fingerprint).toMatch(/^[0-9a-f]{32}$/);
      const lines = await db().query('select order_item_id, quantity from public.order_cancel_request_lines where cancel_request_id = $1', [cancelId]);
      expect(lines.rows).toEqual([{ order_item_id: order.orderItemIds[0], quantity: 2 }]);
      expect((await db().query('select status::text as status from public.orders where id = $1', [order.orderId])).rows[0].status).toBe('paid');
      expect(await outboxRows(db(), order.orderId)).toEqual([
        { kind: 'cancel_request_received', variant: null, origin: 'auto', status: 'pending', return_id: null, return_receipt_id: null, cancel_request_id: cancelId },
        { kind: 'cancel_request_shop', variant: null, origin: 'auto', status: 'pending', return_id: null, return_receipt_id: null, cancel_request_id: cancelId },
      ]);
    });

    test('未入金の注文も申し込める。ご連絡事項は空白（全角の空白・改行を含む）だけなら空になる', async () => {
      await updateSettings(db(), { request_types: 'cancellations_only' });
      const pending = await createUnshippedOrder(db(), 'pending', { quantity: 2 });

      const res = await requestCancel(db(), pending, {
        lines: [{ order_item_id: pending.orderItemIds[0], quantity: 2 }],
        note: ' \u3000\n ',
      });

      const row = (await db().query('select status, customer_note from public.order_cancel_requests where id = $1', [res.rows[0].cancel_request_id])).rows[0];
      expect(row).toEqual({ status: 'requested', customer_note: null });
    });

    test('同じ番号で同じ中身を送り直すと前の申し込みを返し、記録もメールの予定も増えない。違う中身は RETURN_REQUEST_MISMATCH、持ち主でないお客様は ORDER_NOT_FOUND', async () => {
      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      const order = await createPartlyShippedOrder(db());
      const key = crypto.randomUUID();
      const input = { requestKey: key, lines: [{ order_item_id: order.orderItemIds[0], quantity: 2 }], note: 'お願いします' };
      const first = await requestCancel(db(), order, input);
      const before = await recordCounts(db(), order.orderId);
      expect(before).toMatchObject({ cancel_requests: 1, mails: 2 });

      const again = await requestCancel(db(), order, input);
      expect(again.rows).toEqual([{ cancel_request_id: first.rows[0].cancel_request_id, status: 'requested', replayed: true }]);
      expect(await recordCounts(db(), order.orderId)).toEqual(before);

      for (const [label, changed] of [
        ['数', { lines: [{ order_item_id: order.orderItemIds[0], quantity: 1 }] }],
        ['ご連絡事項', { note: '別の内容' }],
      ] as Array<[string, CancelInput]>) {
        const rejection = await rejectionOf(db(), CANCEL_SQL, cancelParams(order, { ...input, ...changed }));
        expect({ label, rejection }).toEqual({ label, rejection: refusal('RETURN_REQUEST_MISMATCH') });
      }
      // 同じお客様のほかの注文に同じ番号を使うと、中身が違うとして断る
      const other = await createPartlyShippedOrder(db(), order.customerId);
      const otherInput = { requestKey: key, lines: [{ order_item_id: other.orderItemIds[0], quantity: 2 }], note: 'お願いします' };
      expect(await rejectionOf(db(), CANCEL_SQL, cancelParams(other, otherInput))).toEqual(refusal('RETURN_REQUEST_MISMATCH'));
      const stranger = await createCustomer(db(), 'stranger');
      expect(await rejectionOf(db(), CANCEL_SQL, cancelParams(order, { ...input, customerId: stranger }))).toEqual(NOT_FOUND);
      expect(await recordCounts(db(), order.orderId)).toEqual(before);
    });

    test('設定が受け付けない（受付オフ・種類が返品だけ）なら RETURN_REQUESTS_CLOSED。種類にキャンセルが入っていれば受ける', async () => {
      const order = await createPartlyShippedOrder(db());

      await updateSettings(db(), { request_types: 'returns_only' });
      expect(await rejectionOf(db(), CANCEL_SQL, cancelParams(order))).toEqual(refusal('RETURN_REQUESTS_CLOSED'));
      await updateSettings(db(), { request_types: 'cancellations_only', requests_enabled: false });
      expect(await rejectionOf(db(), CANCEL_SQL, cancelParams(order))).toEqual(refusal('RETURN_REQUESTS_CLOSED'));
      await updateSettings(db(), { requests_enabled: true });
      await expect(requestCancel(db(), order)).resolves.toBeTruthy();
    });

    test('注文が未入金でも支払い済みでもなければ CANCEL_REQUEST_NOT_ELIGIBLE（発送済み・失敗・取消）', async () => {
      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      const shipped = await createCustomerOrder(db(), { lines: [{ quantity: 2 }] });
      const owner = shipped.customerId;
      const targets: Array<[string, OrderRef]> = [
        ['発送済み', shipped],
        ['失敗', await createUnshippedOrder(db(), 'failed', { customerId: owner })],
        ['取消', await createUnshippedOrder(db(), 'cancelled', { customerId: owner })],
      ];
      for (const [label, target] of targets) {
        const rejection = await rejectionOf(db(), CANCEL_SQL, cancelParams(target));
        expect({ label, rejection }).toEqual({ label, rejection: refusal('CANCEL_REQUEST_NOT_ELIGIBLE') });
      }
    });

    test('開いている申し込みがあれば CANCEL_REQUEST_EXISTS。お断りで閉じた後は、新しい申し込みができる', async () => {
      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      const order = await createPartlyShippedOrder(db());
      const first = await requestCancel(db(), order);

      expect(await rejectionOf(db(), CANCEL_SQL, cancelParams(order))).toEqual(refusal('CANCEL_REQUEST_EXISTS'));

      await db().query(
        `update public.order_cancel_requests
         set status = 'declined', decline_reason = 'other', decline_message = '申し訳ありません', declined_at = now(), declined_by = gen_random_uuid()
         where id = $1`,
        [first.rows[0].cancel_request_id],
      );
      const second = await requestCancel(db(), order);
      expect(second.rows[0].cancel_request_id).not.toBe(first.rows[0].cancel_request_id);
      expect((await recordCounts(db(), order.orderId)).cancel_requests).toBe(2);
    });

    test('未発送の数を超える・この注文の品でない時は CANCEL_REQUEST_QUANTITY_EXCEEDS。未発送の数ちょうどは通る', async () => {
      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      const order = await createPartlyShippedOrder(db());
      const other = await createPartlyShippedOrder(db(), order.customerId);

      for (const [label, lines] of [
        ['発送済みの分まで', [{ order_item_id: order.orderItemIds[0], quantity: 3 }]],
        ['この注文の品でない', [{ order_item_id: other.orderItemIds[0], quantity: 1 }]],
        ['知らない品', [{ order_item_id: crypto.randomUUID(), quantity: 1 }]],
      ] as Array<[string, unknown]>) {
        const rejection = await rejectionOf(db(), CANCEL_SQL, cancelParams(order, { lines }));
        expect({ label, rejection }).toEqual({ label, rejection: refusal('CANCEL_REQUEST_QUANTITY_EXCEEDS') });
      }
      await expect(requestCancel(db(), order, { lines: [{ order_item_id: order.orderItemIds[0], quantity: 2 }] })).resolves.toBeTruthy();
    });

    test('引数の形が違えば RETURN_ARGUMENT_INVALID（行・数・同じ品の 2 回・ご連絡事項・空の番号）', async () => {
      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      const order = await createPartlyShippedOrder(db());
      const item = order.orderItemIds[0];
      const cases: Array<[string, unknown[]]> = [
        ['注文の番号が空', cancelParams(order, { orderId: null })],
        ['お客様の番号が空', cancelParams(order, { customerId: null })],
        ['二重防止の番号が空', cancelParams(order, { requestKey: null })],
        ['行が SQL の NULL', [order.orderId, order.customerId, crypto.randomUUID(), null, null]],
        ['行が配列でない', cancelParams(order, { lines: {} })],
        ['行が空の配列', cancelParams(order, { lines: [] })],
        ['行が 101 行', cancelParams(order, { lines: Array.from({ length: 101 }, () => ({ order_item_id: item, quantity: 1 })) })],
        ['行がオブジェクトでない', cancelParams(order, { lines: [5] })],
        ['品が空', cancelParams(order, { lines: [{ quantity: 1 }] })],
        ['品が番号の形でない', cancelParams(order, { lines: [{ order_item_id: 'abc', quantity: 1 }] })],
        ['数が空', cancelParams(order, { lines: [{ order_item_id: item }] })],
        ['数が 0', cancelParams(order, { lines: [{ order_item_id: item, quantity: 0 }] })],
        ['数が小数', cancelParams(order, { lines: [{ order_item_id: item, quantity: 1.5 }] })],
        ['数が 1000', cancelParams(order, { lines: [{ order_item_id: item, quantity: 1000 }] })],
        ['同じ品が 2 行', cancelParams(order, { lines: [{ order_item_id: item, quantity: 1 }, { order_item_id: item, quantity: 1 }] })],
        ['ご連絡事項が 301 字', cancelParams(order, { note: 'あ'.repeat(301) })],
      ];
      for (const [label, params] of cases) {
        expect({ label, rejection: await rejectionOf(db(), CANCEL_SQL, params) }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
      // 300 字ちょうどは通る
      await expect(requestCancel(db(), order, { note: 'あ'.repeat(300) })).resolves.toBeTruthy();
    });
  });

  describe('注文の画面の返品の欄（get_customer_order_returns）', () => {
    test('キーは C-2 の CustomerOrderReturns の snake_case と一字違わない（label は DB が作らない）', async () => {
      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 3 }] });
      const white = await addItemVariant(db(), { itemId: order.itemIds[0], colorName: 'WHITE', sizeLabel: 'L', stock: 3 });
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        lines: [{ fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 1, resolution: 'exchange', exchangeVariantId: white.variantId }],
      });
      await insertSentBackReceipt(db(), created.returnId, created.lineIds[0], 1, { message: 'お返しします', carrier: 'yamato', trackingNumber: '1234-5678' });
      const partly = await createPartlyShippedOrder(db(), order.customerId);
      await requestCancel(db(), partly);

      const result = await returnsOf(db(), order);
      const cancelResult = await returnsOf(db(), partly);

      expect(keysOf(result)).toEqual(sorted(['returns', 'cancel_requests', 'availability']));
      expect(keysOf(result.availability)).toEqual(sorted(['returns', 'ended_on', 'cancel']));
      expect(keysOf(result.returns[0])).toEqual(
        sorted([
          'id', 'number', 'status', 'customer_status', 'return_method', 'return_shipping_payer', 'return_shipping_fee', 'return_address',
          'requested_at', 'closed_at', 'lines', 'refund_amount', 'sent_back', 'decline_message', 'exchange_shipping',
        ]),
      );
      expect(keysOf(result.returns[0].lines[0])).toEqual(
        sorted(['item_name', 'color', 'size', 'quantity', 'requested_resolution', 'requested_exchange', 'resolution', 'exchange']),
      );
      expect(keysOf(result.returns[0].sent_back[0])).toEqual(
        sorted(['item_name', 'color', 'size', 'quantity', 'message', 'carrier', 'tracking_number']),
      );
      expect(keysOf(cancelResult.cancel_requests[0])).toEqual(sorted(['id', 'status', 'requested_at', 'lines', 'decline_message']));
      expect(keysOf(cancelResult.cancel_requests[0].lines[0])).toEqual(sorted(['item_name', 'color', 'size', 'quantity']));

      expect(result.returns[0]).toMatchObject({
        id: created.returnId,
        number: 1,
        status: 'open',
        customer_status: 'accepted',
        return_method: 'customer_ships',
        return_shipping_payer: 'shop',
        return_shipping_fee: 0,
        return_address: null,
        refund_amount: null,
        decline_message: null,
        exchange_shipping: 'none',
      });
      expect(result.returns[0].lines).toEqual([
        {
          item_name: '照合テスト',
          color: 'BLACK',
          size: 'M',
          quantity: 1,
          requested_resolution: null,
          requested_exchange: null,
          resolution: 'exchange',
          exchange: { color: 'WHITE', size: 'L' },
        },
      ]);
      expect(result.returns[0].sent_back).toEqual([
        { item_name: '照合テスト', color: 'BLACK', size: 'M', quantity: 1, message: 'お返しします', carrier: 'yamato', tracking_number: '1234-5678' },
      ]);
      expect(cancelResult.cancel_requests[0]).toMatchObject({ status: 'requested', decline_message: null });
      expect(cancelResult.cancel_requests[0].lines).toEqual([{ item_name: '照合テスト', color: 'BLACK', size: 'M', quantity: 1 }]);
    });

    test('お客様の状態 customer_status は P10 の決め方の 8 つ全部。お支払い待ちは一部の受け取りより先', async () => {
      const target = (order: CustomerOrder) => ({ fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 2 });
      const statusOf = async (build: (order: CustomerOrder) => Promise<void>): Promise<string> => {
        const order = await createCustomerOrder(db(), { lines: [{ quantity: 2 }] });
        await build(order);
        return (await returnsOf(db(), order)).returns[0].customer_status as string;
      };
      const received = async (returnId: string, lineId: string, disposition: 'restocked' | 'pending_inspection', quantity: number) => {
        await insertReturnReceipt(db(), { returnId, lines: [{ returnLineId: lineId, disposition, quantity }] });
      };

      const actual: Record<string, string> = {
        requested: await statusOf(async (order) => {
          await insertReturnRecord(db(), { orderId: order.orderId, status: 'requested', lines: [target(order)] });
        }),
        declined: await statusOf(async (order) => {
          await insertReturnRecord(db(), { orderId: order.orderId, status: 'declined', lines: [target(order)] });
        }),
        accepted: await statusOf(async (order) => {
          await insertReturnRecord(db(), { orderId: order.orderId, lines: [target(order)] });
        }),
        partially_received: await statusOf(async (order) => {
          const created = await insertReturnRecord(db(), { orderId: order.orderId, lines: [target(order)] });
          await received(created.returnId,created.lineIds[0], 'restocked', 1);
        }),
        inspecting: await statusOf(async (order) => {
          const created = await insertReturnRecord(db(), { orderId: order.orderId, lines: [target(order)] });
          await received(created.returnId,created.lineIds[0], 'pending_inspection', 2);
        }),
        awaiting_fee: await statusOf(async (order) => {
          await insertReturnRecord(db(), { orderId: order.orderId, feeDueAmount: 500, lines: [target(order)] });
        }),
        awaiting_fee_and_partial: await statusOf(async (order) => {
          const created = await insertReturnRecord(db(), { orderId: order.orderId, feeDueAmount: 500, lines: [target(order)] });
          await received(created.returnId,created.lineIds[0], 'restocked', 1);
        }),
        refund_preparing: await statusOf(async (order) => {
          const created = await insertReturnRecord(db(), { orderId: order.orderId, lines: [target(order)] });
          await received(created.returnId,created.lineIds[0], 'restocked', 2);
        }),
        returned: await statusOf(async (order) => {
          const created = await insertReturnRecord(db(), { orderId: order.orderId, status: 'closed', lines: [target(order)] });
          await received(created.returnId,created.lineIds[0], 'restocked', 2);
          await insertReturnRefund(db(), {
            orderId: order.orderId,
            returnId: created.returnId,
            status: 'succeeded',
            amount: 8000,
            lines: [{ orderItemId: order.orderItemIds[0], quantity: 2, amount: 8000 }],
          });
        }),
      };

      expect(actual).toEqual({
        requested: 'requested',
        declined: 'declined',
        accepted: 'accepted',
        partially_received: 'partially_received',
        inspecting: 'inspecting',
        awaiting_fee: 'awaiting_fee',
        awaiting_fee_and_partial: 'awaiting_fee',
        refund_preparing: 'refund_preparing',
        returned: 'returned',
      });
    });

    test('返送先は受付中（open）の間だけ出す。申し込み中・完了・お断りには出さず、お店が返送先を入れていなければ空', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 4 }] });
      const line = { fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 1 };
      for (const status of ['open', 'requested', 'closed', 'declined'] as const) {
        await insertReturnRecord(db(), { orderId: order.orderId, status, lines: [line] });
      }
      const addressByStatus = async () =>
        Object.fromEntries((await returnsOf(db(), order)).returns.map((item: Row) => [item.status, item.return_address]));

      // 返送先が空の間は、受付中でも空
      expect(await addressByStatus()).toEqual({ open: null, requested: null, closed: null, declined: null });

      await setReturnAddress(db());
      expect(await addressByStatus()).toEqual({
        open: { name: '店舗', postal_code: '150-0001', address: '東京都渋谷区神宮前1-1-1', phone: '03-1111-2222' },
        requested: null,
        closed: null,
        declined: null,
      });
    });

    test('取消の返品は入れない。返品と申し込みは新しい順。お断りのメッセージはお断りの返品だけに付く。お店のメモ・お断りの理由の記号は出さない', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 4 }] });
      const line = { fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 1 };
      const first = await insertReturnRecord(db(), { orderId: order.orderId, lines: [line] });
      await insertReturnRecord(db(), { orderId: order.orderId, status: 'cancelled', lines: [line] });
      const declined = await insertReturnRecord(db(), { orderId: order.orderId, status: 'declined', lines: [line] });
      await db().query("update public.order_returns set decline_message = 'お受けできませんでした' where id = $1", [declined.returnId]);
      // お店だけが見る値（メモ・した人）は守りで直せないので、守りを外して書く
      const staff = await createCustomer(db(), 'staff');
      const staffEmail = (await db().query('select email from auth.users where id = $1', [staff])).rows[0].email as string;
      await db().query('set local session_replication_role = replica');
      await db().query("update public.order_returns set shop_note = 'お店だけのメモ', approved_by = $2, created_by = $2 where id = $1", [first.returnId, staff]);
      await db().query('set local session_replication_role = origin');

      const result = await returnsOf(db(), order);

      expect(result.returns.map((item: Row) => [item.number, item.status, item.customer_status, item.decline_message])).toEqual([
        [3, 'declined', 'declined', 'お受けできませんでした'],
        [1, 'open', 'accepted', null],
      ]);
      expect(result.returns[1].id).toBe(first.returnId);
      // お店だけが見る物（メモ・お断りの理由の記号・した人・手数料の記録・知らせる印）は、キーにも値にも、どの階層にも出ない
      const text = JSON.stringify(result);
      for (const internal of ['shop_note', 'decline_reason', 'approved_by', 'created_by', 'fee_due_amount', 'notify_customer', 'request_key', 'actor']) {
        expect({ internal, found: text.includes(internal) }).toEqual({ internal, found: false });
      }
      for (const value of ['お店だけのメモ', staff, staffEmail]) {
        expect({ value, found: text.includes(value) }).toEqual({ value, found: false });
      }
    });

    test('返金の額は、その返品の返金（返事待ち・保留・成功）の合計。失敗・エラーは入れず、返金が無ければ空', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 6 }] });
      const line = { fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 1 };
      const refunded = await insertReturnRecord(db(), { orderId: order.orderId, status: 'closed', lines: [line] });
      const plain = await insertReturnRecord(db(), { orderId: order.orderId, lines: [line] });
      for (const [status, amount] of [
        ['succeeded', 3000],
        ['awaiting_response', 1000],
        ['failed', 500],
        ['error', 700],
      ] as Array<['succeeded' | 'awaiting_response' | 'failed' | 'error', number]>) {
        await insertReturnRefund(db(), {
          orderId: order.orderId,
          returnId: refunded.returnId,
          status,
          amount,
          lines: [{ orderItemId: order.orderItemIds[0], quantity: 1, amount }],
        });
      }

      const result = await returnsOf(db(), order);

      const amountOf = (returnId: string) => result.returns.find((item: Row) => item.id === returnId).refund_amount;
      expect(amountOf(refunded.returnId)).toBe(4000);
      expect(amountOf(plain.returnId)).toBeNull();
    });

    test('お返しした品は、品・数・お店のメッセージ・配送業者・伝票番号つきで出る。お断りのメッセージは出ない', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 3 }, { quantity: 1 }] });
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        lines: [
          { fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 2 },
          { fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[1], quantity: 1 },
        ],
      });
      await insertSentBackReceipt(db(), created.returnId, created.lineIds[0], 1, { message: 'お返しします', carrier: 'yamato', trackingNumber: '1234-5678' });
      await insertSentBackReceipt(db(), created.returnId, created.lineIds[1], 1, { message: null, carrier: null, trackingNumber: null });

      const result = await returnsOf(db(), order);

      expect(result.returns[0].sent_back).toHaveLength(2);
      expect(result.returns[0].sent_back).toEqual(
        expect.arrayContaining([
          { item_name: '照合テスト', color: 'BLACK', size: 'M', quantity: 1, message: 'お返しします', carrier: 'yamato', tracking_number: '1234-5678' },
          { item_name: '照合テスト', color: 'BLACK', size: 'M', quantity: 1, message: null, carrier: null, tracking_number: null },
        ]),
      );
      expect(result.returns[0].decline_message).toBeNull();
    });

    test('交換の品の発送は、交換の品が無ければ none、送りきっていなければ pending、全部送っていれば shipped', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 2 }] });
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        status: 'closed',
        lines: [{ fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 1, resolution: 'exchange', exchangeVariantId: order.variantIds[0] }],
      });
      const shippingOf = async () => (await returnsOf(db(), order)).returns[0].exchange_shipping as string;

      expect(await shippingOf()).toBe('none');
      const exchangeItemId = await insertExchangeItem(db(), order, created.lineIds[0]);
      expect(await shippingOf()).toBe('pending');
      await shipExchangeItem(db(), order, exchangeItemId);
      expect(await shippingOf()).toBe('shipped');
    });

    test('キャンセルの申し込みの状態と、お断りのメッセージ。新しい順で、取り消した返品とは別の欄', async () => {
      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      const order = await createPartlyShippedOrder(db());
      const first = await requestCancel(db(), order);
      await db().query(
        `update public.order_cancel_requests
         set status = 'declined', decline_reason = 'other', decline_message = '申し訳ありません', declined_at = now(), declined_by = gen_random_uuid()
         where id = $1`,
        [first.rows[0].cancel_request_id],
      );
      const second = await requestCancel(db(), order);
      // 同じ取引の中では申し込みの時刻が同じになるので、1 つ目を 1 分前にずらして並びを決める
      // （申し込みの時刻は守りで直せないため、守りを外す session_replication_role を一時的に使う）
      await db().query('set local session_replication_role = replica');
      await db().query("update public.order_cancel_requests set requested_at = requested_at - interval '1 minute' where id = $1", [
        first.rows[0].cancel_request_id,
      ]);
      await db().query('set local session_replication_role = origin');

      const result = await returnsOf(db(), order);

      expect(result.returns).toEqual([]);
      expect(result.cancel_requests.map((request: Row) => [request.id, request.status, request.decline_message])).toEqual([
        [second.rows[0].cancel_request_id, 'requested', null],
        [first.rows[0].cancel_request_id, 'declined', '申し訳ありません'],
      ]);
    });

    test('受付の有無とキャンセルの可否: 返品の受付は材料と同じ、cancel は種類にキャンセルが入り、未発送の品があり、開いている申し込みが無い時だけ真', async () => {
      const partly = await createPartlyShippedOrder(db());
      const shipped = await createCustomerOrder(db(), { lines: [{ quantity: 1 }] });
      const pending = await createUnshippedOrder(db(), 'pending');
      const cancelOf = async (target: { orderId: string; customerId: string }) => (await returnsOf(db(), target)).availability.cancel as boolean;

      // 最初の設定は返品だけ: キャンセルは申し込めない
      expect((await returnsOf(db(), partly)).availability).toEqual({ returns: 'available', ended_on: null, cancel: false });

      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      expect(await cancelOf(partly)).toBe(true);
      expect(await cancelOf(pending)).toBe(true);
      // 全部発送済みの注文には、未発送の品が無い
      expect(await cancelOf(shipped)).toBe(false);
      // 開いている申し込みがあれば、もう申し込めない
      await requestCancel(db(), partly);
      expect(await cancelOf(partly)).toBe(false);

      // キャンセルだけの種類: 返品は closed、キャンセルは申し込める
      await updateSettings(db(), { request_types: 'cancellations_only' });
      expect((await returnsOf(db(), pending)).availability).toEqual({ returns: 'closed', ended_on: null, cancel: true });
      // 受付オフ: どちらも申し込めない
      await updateSettings(db(), { requests_enabled: false });
      expect((await returnsOf(db(), pending)).availability).toEqual({ returns: 'closed', ended_on: null, cancel: false });
    });
  });

  describe('メールの予定を書く private 関数', () => {
    const enqueueReturn = async (orderId: string, kind: string | null, returnId: string, receiptId: string | null): Promise<boolean> =>
      (await db().query('select private.enqueue_return_email($1, $2, $3, $4) as enqueued', [orderId, kind, returnId, receiptId])).rows[0]
        .enqueued as boolean;
    const enqueueCancel = async (orderId: string, kind: string | null, cancelRequestId: string): Promise<boolean> =>
      (await db().query('select private.enqueue_cancel_request_email($1, $2, $3) as enqueued', [orderId, kind, cancelRequestId])).rows[0]
        .enqueued as boolean;

    test('新しい返品の 3 つの種類（申し込みの受付・お断り・店への知らせ）は返品ごと・種類ごとに 1 行で、受け取りの番号は空。同じ注文の別の返品なら別の行', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 3 }] });
      const line = { fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 1 };
      const first = await insertReturnRecord(db(), { orderId: order.orderId, status: 'requested', lines: [line] });
      const second = await insertReturnRecord(db(), { orderId: order.orderId, status: 'requested', lines: [line] });

      for (const kind of ['return_requested', 'return_declined', 'return_request_shop']) {
        expect(await enqueueReturn(order.orderId, kind, first.returnId, null)).toBe(true);
        expect(await enqueueReturn(order.orderId, kind, first.returnId, null)).toBe(false);
        expect(await enqueueReturn(order.orderId, kind, second.returnId, null)).toBe(true);
      }
      const rows = await outboxRows(db(), order.orderId);
      expect(rows.map((row) => [row.kind, row.return_id, row.return_receipt_id, row.variant, row.origin])).toEqual([
        ['return_requested', first.returnId, null, null, 'auto'],
        ['return_requested', second.returnId, null, null, 'auto'],
        ['return_declined', first.returnId, null, null, 'auto'],
        ['return_declined', second.returnId, null, null, 'auto'],
        ['return_request_shop', first.returnId, null, null, 'auto'],
        ['return_request_shop', second.returnId, null, null, 'auto'],
      ]);
    });

    test('段 1 の 4 つの種類は今までどおり: 返品の受付は番号が空、受け取りの 3 つは受け取りの番号が要る', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 2 }] });
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        lines: [{ fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 2 }],
      });
      const { receiptId } = await insertReturnReceipt(db(), {
        returnId: created.returnId,
        lines: [{ returnLineId: created.lineIds[0], disposition: 'sent_back', quantity: 1 }],
      });

      expect(await enqueueReturn(order.orderId, 'return_accepted', created.returnId, null)).toBe(true);
      expect(await enqueueReturn(order.orderId, 'return_accepted', created.returnId, null)).toBe(false);
      for (const kind of ['return_received', 'return_sent_back', 'return_refund_pending_shop']) {
        expect(await enqueueReturn(order.orderId, kind, created.returnId, receiptId)).toBe(true);
        expect(await enqueueReturn(order.orderId, kind, created.returnId, receiptId)).toBe(false);
      }
      expect((await outboxRows(db(), order.orderId)).map((row) => row.kind)).toEqual([
        'return_accepted',
        'return_received',
        'return_sent_back',
        'return_refund_pending_shop',
      ]);
    });

    test('種類が違う・受け取りの番号の有無が種類に合わない・番号が空の時は RETURN_ARGUMENT_INVALID で断る', async () => {
      const order = await createCustomerOrder(db(), { lines: [{ quantity: 2 }] });
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        lines: [{ fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 2 }],
      });
      const { receiptId } = await insertReturnReceipt(db(), {
        returnId: created.returnId,
        lines: [{ returnLineId: created.lineIds[0], disposition: 'sent_back', quantity: 1 }],
      });
      const sql = 'select private.enqueue_return_email($1, $2, $3, $4)';

      for (const [label, params] of [
        ['返金のお知らせ（E-2 の関数の種類）', [order.orderId, 'refund', created.returnId, receiptId]],
        ['キャンセルの申し込みの種類', [order.orderId, 'cancel_request_received', created.returnId, null]],
        ['知らない種類', [order.orderId, 'return_unknown', created.returnId, null]],
        ['申し込みの受付に受け取りの番号', [order.orderId, 'return_requested', created.returnId, receiptId]],
        ['お断りに受け取りの番号', [order.orderId, 'return_declined', created.returnId, receiptId]],
        ['店への知らせに受け取りの番号', [order.orderId, 'return_request_shop', created.returnId, receiptId]],
        ['返品の受付に受け取りの番号', [order.orderId, 'return_accepted', created.returnId, receiptId]],
        ['受け取りの種類に受け取りの番号が無い', [order.orderId, 'return_received', created.returnId, null]],
        ['返品の番号が空', [order.orderId, 'return_requested', null, null]],
        ['注文の番号が空', [null, 'return_requested', created.returnId, null]],
        ['種類が空', [order.orderId, null, created.returnId, null]],
      ] as Array<[string, unknown[]]>) {
        expect({ label, rejection: await rejectionOf(db(), sql, params) }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
      expect(await outboxRows(db(), order.orderId)).toEqual([]);
    });

    test('キャンセルの申し込みの 3 つの種類は申し込みごと・種類ごとに 1 行。同じ注文の別の申し込みなら別の行。種類が違えば RETURN_ARGUMENT_INVALID', async () => {
      await updateSettings(db(), { request_types: 'returns_and_cancellations' });
      const order = await createPartlyShippedOrder(db());
      const first = await requestCancel(db(), order);
      await db().query(
        `update public.order_cancel_requests
         set status = 'declined', decline_reason = 'other', decline_message = '申し訳ありません', declined_at = now(), declined_by = gen_random_uuid()
         where id = $1`,
        [first.rows[0].cancel_request_id],
      );
      const second = await requestCancel(db(), order);
      const firstId = first.rows[0].cancel_request_id as string;
      const secondId = second.rows[0].cancel_request_id as string;

      // 申し込みの時に書いた 2 つ（受付・店への知らせ）は、もう書いてある
      expect(await enqueueCancel(order.orderId, 'cancel_request_received', firstId)).toBe(false);
      expect(await enqueueCancel(order.orderId, 'cancel_request_shop', firstId)).toBe(false);
      // お断りのお知らせは 1 回だけ。別の申し込みなら別の行
      expect(await enqueueCancel(order.orderId, 'cancel_request_declined', firstId)).toBe(true);
      expect(await enqueueCancel(order.orderId, 'cancel_request_declined', firstId)).toBe(false);
      expect(await enqueueCancel(order.orderId, 'cancel_request_declined', secondId)).toBe(true);

      const declinedRows = (await outboxRows(db(), order.orderId)).filter((row) => row.kind === 'cancel_request_declined');
      expect(declinedRows.map((row) => row.cancel_request_id)).toEqual([firstId, secondId]);

      const sql = 'select private.enqueue_cancel_request_email($1, $2, $3)';
      for (const [label, params] of [
        ['返品の種類', [order.orderId, 'return_requested', firstId]],
        ['知らない種類', [order.orderId, 'cancel_request_unknown', firstId]],
        ['種類が空', [order.orderId, null, firstId]],
        ['申し込みの番号が空', [order.orderId, 'cancel_request_declined', null]],
        ['注文の番号が空', [null, 'cancel_request_declined', firstId]],
      ] as Array<[string, unknown[]]>) {
        expect({ label, rejection: await rejectionOf(db(), sql, params) }).toEqual({ label, rejection: INVALID_ARGUMENT });
      }
    });
  });

  describe('持ち主・隠す状態・権限', () => {
    test('持ち主でない・知らない・お客様に隠す状態の注文は、どの関数も ORDER_NOT_FOUND（P0002）で断る。持ち主でない注文があるかどうかを漏らさない', async () => {
      const owner = await createCustomerOrder(db(), { lines: [{ quantity: 2 }] });
      const stranger = await createCustomer(db(), 'stranger');
      const hiddenOrders = [
        await createUnshippedOrder(db(), 'payment_in_progress', { customerId: owner.customerId }),
        await createUnshippedOrder(db(), 'abandoned', { customerId: owner.customerId }),
      ];
      const calls: Array<[string, (orderId: string, customerId: string) => [string, unknown[]]]> = [
        ['材料', (orderId, customerId) => ['select public.get_customer_return_request_materials($1, $2)', [orderId, customerId]]],
        ['写真の送り先', (orderId, customerId) => [PHOTO_UPLOAD_SQL, [orderId, customerId]]],
        [
          '返品の申し込み',
          (orderId, customerId) => [REQUEST_SQL, [orderId, customerId, crypto.randomUUID(), JSON.stringify([reqLine(owner, 0, 1)])]],
        ],
        [
          'キャンセルの申し込み',
          (orderId, customerId) => [
            CANCEL_SQL,
            [orderId, customerId, crypto.randomUUID(), JSON.stringify([{ order_item_id: owner.orderItemIds[0], quantity: 1 }]), null],
          ],
        ],
        ['注文の返品の欄', (orderId, customerId) => ['select public.get_customer_order_returns($1, $2)', [orderId, customerId]]],
      ];
      const targets: Array<[string, string, string]> = [
        ['持ち主でないお客様', owner.orderId, stranger],
        ['知らない注文', crypto.randomUUID(), owner.customerId],
        ['隠す状態（支払い手続き中）', hiddenOrders[0].orderId, owner.customerId],
        ['隠す状態（放棄）', hiddenOrders[1].orderId, owner.customerId],
      ];

      for (const [label, build] of calls) {
        for (const [target, orderId, customerId] of targets) {
          const [sql, params] = build(orderId, customerId);
          expect({ label, target, rejection: await rejectionOf(db(), sql, params) }).toEqual({ label, target, rejection: NOT_FOUND });
        }
      }
      // 持ち主本人は読める
      await expect(materialsOf(db(), owner)).resolves.toBeTruthy();
    });

    const SERVICE_ONLY_FUNCTIONS = [
      'public.get_customer_return_request_materials(uuid,uuid)',
      'public.customer_create_return_photo_upload(uuid,uuid)',
      'public.customer_request_return(uuid,uuid,uuid,jsonb)',
      'public.customer_request_cancel(uuid,uuid,uuid,jsonb,text)',
      'public.get_customer_order_returns(uuid,uuid)',
    ];
    const PRIVATE_FUNCTIONS = [
      'private.customer_order_for_request(uuid,uuid,boolean)',
      'private.customer_return_line_states(uuid)',
      'private.customer_return_availability(public.orders)',
      'private.parse_customer_return_lines(jsonb)',
      'private.enqueue_return_email(uuid,text,uuid,uuid)',
      'private.enqueue_cancel_request_email(uuid,text,uuid)',
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

    test.each(['anon', 'authenticated'])('%s は お客様の側の関数を呼べない', async (role) => {
      const id = crypto.randomUUID();
      const calls: Array<[string, unknown[]]> = [
        ['select public.get_customer_return_request_materials($1, $2)', [id, id]],
        [PHOTO_UPLOAD_SQL, [id, id]],
        [REQUEST_SQL, [id, id, id, '[]']],
        [CANCEL_SQL, [id, id, id, '[]', null]],
        ['select public.get_customer_order_returns($1, $2)', [id, id]],
      ];
      for (const [sql, params] of calls) {
        await db().query('savepoint denied');
        await db().query(`set local role ${role}`);
        await expect(db().query(sql, params)).rejects.toMatchObject({ code: '42501' });
        await db().query('rollback to savepoint denied');
      }
    });

    test('service_role は読み出しの関数を呼べる', async () => {
      const order = await createCustomerOrder(db(), {});
      await db().query('savepoint service');
      await db().query('set local role service_role');
      await expect(db().query('select public.get_customer_return_request_materials($1, $2)', [order.orderId, order.customerId])).resolves.toBeTruthy();
      await expect(db().query('select public.get_customer_order_returns($1, $2)', [order.orderId, order.customerId])).resolves.toBeTruthy();
      await db().query('rollback to savepoint service');
    });

    test('同じ名前の関数は 1 つだけ（2 つあると Data API が呼び分けられない: PGRST203）', async () => {
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

describeLocalDb('integration: 申し込みの同時の操作（Review Focus 4）', (db) => {
  let other: PgClient;
  // 返送先を確定して戻す専用の接続（共通の入口が afterAll で db() の接続を閉じる順に左右されない）
  let settings: PgClient;

  beforeAll(async () => {
    other = await connectLocalDb();
    settings = await connectLocalDb();
    // お店が返品を作る関数は、返送先が空の間は断る。確定した値なので、終わったら空に戻す
    await setReturnAddress(settings);
  });

  afterAll(async () => {
    await clearReturnAddress(settings);
    await settings.end();
    await other.end();
  });

  /** 確定した注文（在庫の品 1 点）。もう 1 つの接続からも見える */
  function createCommittedOrder(): Promise<CustomerOrder> {
    return createCustomerOrder(db(), { lines: [{ quantity: 1 }] });
  }

  /** お店が返品を作る関数（段 1）の呼び出し。知らせない（確定したメールの予定を残さない） */
  function adminCreateReturn(client: PgClient, order: CustomerOrder, actorId: string, quantity: number) {
    return client.query('select * from public.admin_create_return($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)', [
      order.orderId,
      actorId,
      crypto.randomUUID(),
      JSON.stringify([
        {
          fulfillment_id: order.fulfillments[0].id,
          order_item_id: order.orderItemIds[0],
          quantity,
          reason: 'defective',
          reason_note: null,
          resolution: 'refund',
          exchange_variant_id: null,
          exchange_method: null,
        },
      ]),
      'customer_ships',
      'customer',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      false,
    ]);
  }

  test('同じ品を 2 つのタブで同時に申し込む: 注文の行の鍵を先に取った方だけが記録され、後の申し込みは RETURN_QUANTITY_EXCEEDS で断られる。数は 0 より小さくならない（Review Focus 4）', async () => {
    const order = await createCommittedOrder();
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;

    await db().query('begin');
    try {
      await requestReturn(db(), order);
      const second = requestReturn(other, order).then(
        () => null,
        (error: unknown) => error,
      );
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await second).toMatchObject({ code: '22023', message: 'RETURN_QUANTITY_EXCEEDS' });
    } catch (error) {
      await db().query('rollback');
      throw error;
    }

    expect((await recordCounts(db(), order.orderId)).returns).toBe(1);
    expect((await countsOf(db(), order.orderId))[order.orderItemIds[0]]).toMatchObject({ requested: 1, returnable: 0 });
  });

  test('申し込みが先、お店の返品の作成が後: お店の作成は注文の行の鍵を待ち、申し込みが確定した後に RETURN_QUANTITY_EXCEEDS で断られる（Review Focus 4）', async () => {
    const order = await createCommittedOrder();
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;

    await db().query('begin');
    try {
      await requestReturn(db(), order);
      const creating = adminCreateReturn(other, order, crypto.randomUUID(), 1).then(
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

    const counts = await recordCounts(db(), order.orderId);
    expect(counts.returns).toBe(1);
    expect((await db().query('select source, status from public.order_returns where order_id = $1', [order.orderId])).rows).toEqual([
      { source: 'customer_request', status: 'requested' },
    ]);
  });

  test('お店の返品の作成が先、申し込みが後: 申し込みは注文の行の鍵を待ち、作成が確定した後に RETURN_QUANTITY_EXCEEDS で断られる（Review Focus 4）', async () => {
    const order = await createCommittedOrder();
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    const actorId = crypto.randomUUID();
    let returnId = '';

    await db().query('begin');
    try {
      returnId = (await adminCreateReturn(db(), order, actorId, 1)).rows[0].return_id as string;
      const requesting = requestReturn(other, order).then(
        () => null,
        (error: unknown) => error,
      );
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await requesting).toMatchObject({ code: '22023', message: 'RETURN_QUANTITY_EXCEEDS' });
    } catch (error) {
      await db().query('rollback');
      throw error;
    } finally {
      // 確定した受付中の返品を、一覧の絞り込みに残さない（元の誤りを隠さないよう、取消の失敗は無視する）
      if (returnId) {
        await db().query('select * from public.admin_cancel_return($1, $2)', [returnId, actorId]).catch(() => undefined);
      }
    }

    expect((await recordCounts(db(), order.orderId)).returns).toBe(1);
  });

  test('同じ二重防止の番号を 2 つの接続から同時に送る: 後の方は注文の行の鍵を待ち、確定した後に前の返品を replayed で返す（二重に作らない。Review Focus 1・Review Focus 4）', async () => {
    const order = await createCommittedOrder();
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    const key = crypto.randomUUID();

    await db().query('begin');
    try {
      const first = await requestReturn(db(), order, { requestKey: key });
      const second = requestReturn(other, order, { requestKey: key }).then(
        (res) => res.rows[0],
        (error: unknown) => error,
      );
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await second).toEqual({ return_id: first.rows[0].return_id, number: 1, status: 'requested', replayed: true });
    } catch (error) {
      await db().query('rollback');
      throw error;
    }

    expect((await recordCounts(db(), order.orderId)).returns).toBe(1);
  });

  test('持ち主でないお客様の呼び出しは、注文の行の鍵を待たずに ORDER_NOT_FOUND で終わる（鍵の待ちから注文の有無が分からない。Review Focus 4）', async () => {
    const order = await createCommittedOrder();
    const stranger = await createCustomer(db(), 'stranger');

    await db().query('begin');
    try {
      await db().query('select id from public.orders where id = $1 for update', [order.orderId]);
      const attempt = other
        .query(REQUEST_SQL, requestParams(order, { customerId: stranger }))
        .then(() => null, (error: { code: string; message: string }) => ({ code: error.code, message: error.message }));
      const outcome = await Promise.race([attempt, new Promise((resolve) => setTimeout(() => resolve('blocked'), 3000))]);
      expect(outcome).toEqual(NOT_FOUND);
    } finally {
      await db().query('rollback');
    }
  });
});
