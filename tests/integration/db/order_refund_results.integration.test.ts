/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { PRICE, createCatalogFixture, movementsOf, uniqueSuffix, variantStock } from './helpers/order-fixtures';

/**
 * 返金の結果を書く関数・外からの返金・エラー・一覧の要約・要対応の自動の解決・注文のメールの表の変更（グループ E-2 設計書 4・6〜8章、移行 C）。
 * 返金の記録は、移行 A の表に直に入れて作る（返金を始める関数は移行 B の試験が確かめる。「通し」の1件だけ、その関数を使う）。
 * 注文のメールの取り出しは表全体から古い順に選ぶので、1件ごとに取引の中で注文のメールの表を空にし、終わったら戻す。
 * 注文の状態は直接変えない（本計画 P17）。保留の守り（order_state_transition_hardening の試験が手元の DB に当てる）が効いていても通る。
 * 最後の describe（同時の書き込み）だけは、2つの接続で確定した注文を残す。流し終えたら npx supabase db reset で手元の DB を作り直す。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

async function createActor(db: PgClient): Promise<{ id: string; email: string }> {
  const email = `refund-results-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

type LineSpec = {
  quantity: number;
  /** 受注生産の品か。既定は在庫の品 */
  backorder?: boolean;
  /** 台帳に確保（purchase）を入れる数。既定は quantity。0 は確保の記録が無い古い商品（R-41） */
  reserved?: number;
  /** 確保した後に残る、すぐ出せる数。既定は 0 */
  spare?: number;
};

type TestOrder = { orderId: string; itemIds: string[]; variantIds: number[]; total: number };

/**
 * 注文を直接作る。商品は1行ごとに別の商品・バリアントにし、作った順に登録順（created_at）を付ける。
 * 受け取った額は既定で注文の合計。送料と割引は注文を作る時に決める（後から書き換えられない）。
 */
async function createOrder(
  db: PgClient,
  options: { status?: string; lines: LineSpec[]; shippingAmount?: number; discountAmount?: number; paidAmount?: number | null },
): Promise<TestOrder> {
  const suffix = uniqueSuffix();
  const subtotal = options.lines.reduce((sum, line) => sum + PRICE * line.quantity, 0);
  const shipping = options.shippingAmount ?? 0;
  const discount = options.discountAmount ?? 0;
  const total = subtotal + shipping - discount;
  const paid = options.paidAmount === undefined ? total : options.paidAmount;
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status,
        subtotal_amount, shipping_amount, discount_amount, total_amount, currency, paid_amount,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone)
     values ($1, $2, $3, $4::public.order_status, $5, $6, $7, $8, 'jpy', $9,
             'fixture@example.com', '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222')
     returning id`,
    [`fx-order-${suffix}`, `cs_fx_${suffix}`, `pi_fx_${suffix}`, options.status ?? 'paid', subtotal, shipping, discount, total, paid],
  );
  const orderId = order.rows[0].id as string;
  const itemIds: string[] = [];
  const variantIds: number[] = [];
  for (const [index, line] of options.lines.entries()) {
    const reserved = line.backorder ? 0 : (line.reserved ?? line.quantity);
    const fx = await createCatalogFixture(db, { stock: reserved + (line.spare ?? 0) });
    const inserted = await db.query(
      `insert into public.order_items
         (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type, created_at)
       values ($1, $2, '照合テスト', $3, 'BLACK', 'M', $4, $5, $6, $7, now() + make_interval(secs => $8::float8))
       returning id`,
      [orderId, fx.itemId, PRICE, line.quantity, PRICE * line.quantity, fx.variantId, line.backorder ? 'backorder' : 'stock', index],
    );
    const itemId = inserted.rows[0].id as string;
    if (reserved > 0) {
      await db.query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
         values ($1, $2, 'purchase', $3, $4)`,
        [fx.variantId, -reserved, orderId, itemId],
      );
    }
    itemIds.push(itemId);
    variantIds.push(fx.variantId);
  }
  return { orderId, itemIds, variantIds, total };
}

type RefundLineSpec = {
  orderItemId: string;
  quantity: number;
  /** 発送前の品か。既定は発送前 */
  beforeShipment?: boolean;
  restockType?: 'cancel' | 'no_restock';
  amount?: number;
};

type RefundSpec = {
  source?: string;
  status?: string;
  amount: number;
  shippingAmount?: number;
  notifyCustomer?: boolean;
  cancelReason?: string | null;
  note?: string | null;
  actorId?: string | null;
  stripeRefundId?: string | null;
  lines?: RefundLineSpec[];
};

/** 返金の記録を表に直に入れる（返金を始める関数を通さない）。既定は管理画面の返金・返事待ち・お客様に知らせる */
async function insertRefund(db: PgClient, orderId: string, spec: RefundSpec): Promise<string> {
  const source = spec.source ?? 'admin';
  const hasKey = source === 'admin' || source === 'order_cancel';
  const cancelReason = spec.cancelReason !== undefined
    ? spec.cancelReason
    : (source === 'order_cancel' || source === 'auto_amount_mismatch' ? 'customer_request' : null);
  const refund = await db.query(
    `insert into public.order_refunds
       (order_id, source, request_key, request_fingerprint, stripe_refund_id, status, amount, shipping_amount,
        note, cancel_reason, notify_customer, actor_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      orderId, source, hasKey ? crypto.randomUUID() : null, hasKey ? 'fixture' : null, spec.stripeRefundId ?? null,
      spec.status ?? 'awaiting_response', spec.amount, spec.shippingAmount ?? 0, spec.note ?? null, cancelReason,
      spec.notifyCustomer ?? true, spec.actorId ?? null,
    ],
  );
  const refundId = refund.rows[0].id as string;
  for (const line of spec.lines ?? []) {
    const beforeShipment = line.beforeShipment ?? true;
    await db.query(
      `insert into public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
       values ($1, $2, $3, $4, $5, $6)`,
      [refundId, line.orderItemId, line.quantity, beforeShipment, line.restockType ?? (beforeShipment ? 'cancel' : 'no_restock'), line.amount ?? 0],
    );
  }
  return refundId;
}

/** 返金の記録の番号から決めた Stripe の返金の番号（re_ の後は英数字だけ）。同じ記録には、いつも同じ番号を使う */
function stripeIdOf(refundId: string): string {
  return `re_${refundId.replace(/-/g, '')}`;
}

type StripeFields = {
  stripeRefundId?: string;
  status?: string;
  pendingReason?: string | null;
  failureReason?: string | null;
  expiresAt?: string | null;
  method?: string | null;
  referenceNumber?: string | null;
  referenceType?: string | null;
};

const RECORD_SQL = `select * from public.record_order_refund_result(
  $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::timestamptz, $7::text, $8::text, $9::text)`;

function recordParams(refundId: string, fields: StripeFields = {}): unknown[] {
  return [
    refundId, fields.stripeRefundId ?? stripeIdOf(refundId), fields.status ?? 'succeeded', fields.pendingReason ?? null,
    fields.failureReason ?? null, fields.expiresAt ?? null, fields.method === undefined ? 'card' : fields.method,
    fields.referenceNumber ?? null, fields.referenceType ?? null,
  ];
}

/** 結果を書く関数を呼び、1行の答えを返す */
async function record(db: PgClient, refundId: string, fields: StripeFields = {}): Promise<Row> {
  const res = await db.query(RECORD_SQL, recordParams(refundId, fields));
  return res.rows[0];
}

type ExternalInput = {
  stripeRefundId?: string;
  amount: number;
  status?: string;
  pendingReason?: string | null;
  failureReason?: string | null;
  method?: string | null;
  stripeReason?: string | null;
  createdAt?: string;
};

const EXTERNAL_SQL = `select * from public.record_external_order_refund(
  $1::uuid, $2::text, $3::integer, $4::text, $5::text, $6::text, $7::timestamptz, $8::text, $9::text, $10::text, $11::text, $12::timestamptz)`;

function externalParams(orderId: string, input: ExternalInput): unknown[] {
  return [
    orderId, input.stripeRefundId ?? `re_${uniqueSuffix()}`, input.amount, input.status ?? 'succeeded',
    input.pendingReason ?? null, input.failureReason ?? null, null, input.method === undefined ? 'card' : input.method, null, null,
    input.stripeReason === undefined ? 'requested_by_customer' : input.stripeReason, input.createdAt ?? new Date().toISOString(),
  ];
}

/** 印の無い返金（Stripe の画面からの返金・前からの写し）を記録する関数を呼び、1行の答えを返す */
async function recordExternal(db: PgClient, orderId: string, input: ExternalInput): Promise<Row> {
  const res = await db.query(EXTERNAL_SQL, externalParams(orderId, input));
  return res.rows[0];
}

/** 返事待ちの返金をエラーにする関数（引数は 記録の番号・理由・要対応を作るか） */
const MARK_SQL = 'select * from public.mark_order_refund_error($1::uuid, $2::text, $3::boolean)';

/** 発送の関数（グループ E-1）で商品を送る。お客様には知らせない。全部を送った時だけ注文が発送済みになる */
function ship(
  db: PgClient,
  orderId: string,
  actorId: string,
  lines: Array<{ itemId: string; quantity: number }>,
  tracking = 'TRK-1',
  carrier = 'yamato',
) {
  return db.query(
    'select * from public.admin_create_fulfillment($1::uuid, $2::uuid, gen_random_uuid(), $3, $4, false, $5::jsonb)',
    [orderId, actorId, carrier, tracking, JSON.stringify(lines.map((line) => ({ order_item_id: line.itemId, quantity: line.quantity })))],
  );
}

async function ledgerStartedAt(db: PgClient): Promise<Date> {
  const res = await db.query('select started_at from private.refund_ledger_state where id = 1');
  return res.rows[0].started_at as Date;
}

async function orderState(db: PgClient, orderId: string): Promise<Row> {
  const res = await db.query(
    `select status::text as status, refunded_amount, refunded_at, payment_status_updated_at, cancel_reason, cancel_note,
            cancel_notify_customer, review_reason, review_marked_at, shipped_at, shipping_carrier, tracking_number
     from public.orders where id = $1`,
    [orderId],
  );
  return res.rows[0];
}

async function refundRow(db: PgClient, refundId: string): Promise<Row> {
  return (await db.query('select * from public.order_refunds where id = $1', [refundId])).rows[0];
}

/** 返金の行の数を、商品の登録順に並べて返す */
async function lineRows(db: PgClient, refundId: string): Promise<Row[]> {
  const res = await db.query(
    `select l.quantity, l.before_shipment, l.restock_type, l.amount, l.released_quantity, l.restocked_quantity,
            l.rereserved_quantity, l.rereserve_shortage
     from public.order_refund_lines as l
     join public.order_items as oi on oi.id = l.order_item_id
     where l.refund_id = $1
     order by oi.created_at, oi.id`,
    [refundId],
  );
  return res.rows;
}

/** 確保中の数を、商品の登録順に並べて返す */
async function reservedOf(db: PgClient, orderId: string): Promise<number[]> {
  const res = await db.query(
    `select r.reserved
     from private.order_line_reservations($1) as r
     join public.order_items as oi on oi.id = r.order_item_id
     order by oi.created_at, oi.id`,
    [orderId],
  );
  return res.rows.map((row) => Number(row.reserved));
}

/** 商品ごとの数（E-1 の数え方に返金を入れた物）を、商品の登録順に並べて返す */
async function lineCounts(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query(
    `select l.shipped, l.unshipped, l.refunded_before_shipment, l.refunded_after_shipment
     from private.order_line_fulfillment($1) as l
     join public.order_items as oi on oi.id = l.order_item_id
     order by oi.created_at, oi.id`,
    [orderId],
  );
  return res.rows;
}

/** 返金と取消のメールの予定の行 */
async function emailsOf(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query(
    `select kind, variant, origin, status, refund_id from private.order_email_outbox
     where order_id = $1 and kind in ('refund', 'canceled') order by seq`,
    [orderId],
  );
  return res.rows;
}

async function exceptionsOf(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query(
    `select id, reason, detail, payment_ref, resolved_at, resolved_by
     from public.payment_exceptions where order_id = $1 and reason = 'refund_failed' order by first_detected_at, id`,
    [orderId],
  );
  return res.rows;
}

/** 注文の状態が変わった改訂（古い順） */
async function statusRevisions(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query(
    `select before_data ->> 'status' as from_status, after_data ->> 'status' as to_status, reason, changed_by
     from public.order_revisions where order_id = $1 and 'status' = any (changed_fields) order by id`,
    [orderId],
  );
  return res.rows;
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
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

describeLocalDb('integration: 返金の結果を書く関数・外からの返金・エラー・一覧の要約・メールの表（移行 C）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('delete from private.order_email_outbox');
    await db().query('update private.order_email_send_pause set paused = false, reason = null, paused_at = null, next_probe_at = null');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('受け付けた時の在庫（1回だけ）', () => {
    test('在庫に戻す（cancel）: 確保を外してすぐ出せる数に足し、台帳の行に返金の番号が付く。行に外した数を書く', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 3, spare: 1 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 10000, notifyCustomer: false, lines: [{ orderItemId: order.itemIds[0], quantity: 2, amount: 10000 }],
      });

      const res = await record(db(), refundId, { status: 'pending', pendingReason: 'processing' });

      expect(res).toMatchObject({
        refund_id: refundId, order_id: order.orderId, status: 'pending', newly_accepted: true, newly_failed: false,
        order_status: 'paid', refunded_amount: 0, rereserve_shortage: 0, email_enqueued: false, exception_id: null,
      });
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 4, reason: 'restock' }, { delta: -3, reason: 'purchase' }, { delta: 2, reason: 'refund' },
      ]);
      expect(await variantStock(db(), order.variantIds[0])).toBe(3);
      expect(await lineRows(db(), refundId)).toEqual([
        expect.objectContaining({ released_quantity: 2, restocked_quantity: 2, rereserved_quantity: 0, rereserve_shortage: 0 }),
      ]);
      expect(await reservedOf(db(), order.orderId)).toEqual([1]);
      const row = await refundRow(db(), refundId);
      expect(row.stock_applied_at).not.toBeNull();
      expect(row.accepted_at).not.toBeNull();
      const tagged = await db().query(
        "select refund_id from public.stock_movements where variant_id = $1 and reason = 'refund'",
        [order.variantIds[0]],
      );
      expect(tagged.rows).toEqual([{ refund_id: refundId }]);
    });

    test('戻さない（no_restock）: refund の +n と adjustment の −n を同時に書く。すぐ出せる数は変わらず、確保は外れる', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 3, spare: 1 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 10000, notifyCustomer: false,
        lines: [{ orderItemId: order.itemIds[0], quantity: 2, restockType: 'no_restock', amount: 10000 }],
      });

      await record(db(), refundId, { status: 'pending' });

      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 4, reason: 'restock' }, { delta: -3, reason: 'purchase' }, { delta: 2, reason: 'refund' }, { delta: -2, reason: 'adjustment' },
      ]);
      expect(await variantStock(db(), order.variantIds[0])).toBe(1);
      expect(await lineRows(db(), refundId)).toEqual([expect.objectContaining({ released_quantity: 2, restocked_quantity: 0 })]);
      expect(await reservedOf(db(), order.orderId)).toEqual([1]);
      const tagged = await db().query(
        "select reason, refund_id from public.stock_movements where variant_id = $1 and reason in ('refund', 'adjustment') order by id",
        [order.variantIds[0]],
      );
      expect(tagged.rows).toEqual([{ reason: 'refund', refund_id: refundId }, { reason: 'adjustment', refund_id: refundId }]);
    });

    test('確保している数まで戻す。確保の記録が無い古い商品（R-41）からは在庫が湧かない', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 3, reserved: 1 }, { quantity: 2, reserved: 0 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 25000, notifyCustomer: false,
        lines: [
          { orderItemId: order.itemIds[0], quantity: 3, amount: 15000 },
          { orderItemId: order.itemIds[1], quantity: 2, amount: 10000 },
        ],
      });

      await record(db(), refundId, { status: 'pending' });

      expect(await lineRows(db(), refundId)).toEqual([
        expect.objectContaining({ quantity: 3, released_quantity: 1, restocked_quantity: 1 }),
        expect.objectContaining({ quantity: 2, released_quantity: 0, restocked_quantity: 0 }),
      ]);
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 1, reason: 'restock' }, { delta: -1, reason: 'purchase' }, { delta: 1, reason: 'refund' },
      ]);
      expect(await movementsOf(db(), order.variantIds[1])).toEqual([]);
    });

    test('受注生産の品は在庫を動かさない（確保していない）', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2, backorder: true }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 10000, notifyCustomer: false,
        lines: [{ orderItemId: order.itemIds[0], quantity: 2, restockType: 'no_restock', amount: 10000 }],
      });

      const res = await record(db(), refundId, { status: 'pending' });

      expect(res).toMatchObject({ newly_accepted: true });
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([]);
      expect(await lineRows(db(), refundId)).toEqual([expect.objectContaining({ released_quantity: 0, restocked_quantity: 0 })]);
    });

    test('発送後の行は在庫を動かさない（品物が戻る時は E-3 の返品で戻す）', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      await ship(db(), order.orderId, actor.id, [{ itemId: order.itemIds[0], quantity: 1 }]);
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 5000, notifyCustomer: false,
        lines: [{ orderItemId: order.itemIds[0], quantity: 1, beforeShipment: false, amount: 5000 }],
      });

      const res = await record(db(), refundId, { status: 'pending' });

      expect(res).toMatchObject({ newly_accepted: true, order_status: 'paid' });
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([{ delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }]);
      expect(await lineRows(db(), refundId)).toEqual([expect.objectContaining({ released_quantity: 0, restocked_quantity: 0 })]);
      expect(await reservedOf(db(), order.orderId)).toEqual([2]);
    });

    test('同じ結果を2回書いても、台帳もメールの予定も増えない。保留から成功へ進んでも在庫は動かさない', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 10000, lines: [{ orderItemId: order.itemIds[0], quantity: 2, amount: 10000 }],
      });

      const first = await record(db(), refundId, { status: 'pending', pendingReason: 'processing' });
      const again = await record(db(), refundId, { status: 'pending', pendingReason: 'processing' });
      const done = await record(db(), refundId, { status: 'succeeded' });

      expect(first).toMatchObject({ status: 'pending', newly_accepted: true, email_enqueued: true });
      expect(again).toMatchObject({ status: 'pending', newly_accepted: false, email_enqueued: false });
      expect(done).toMatchObject({
        status: 'succeeded', newly_accepted: false, email_enqueued: false, order_status: 'cancelled', refunded_amount: 10000,
      });
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }, { delta: 2, reason: 'refund' },
      ]);
      expect(await emailsOf(db(), order.orderId)).toHaveLength(1);
    });
  });

  describe('お客様へのメールの予定', () => {
    test.each([
      ['admin', 'paid', 'refund', 'standard'],
      ['stripe_dashboard', 'paid', 'refund', 'standard'],
      ['auto_cancelled_order_payment', 'cancelled', 'refund', 'after_cancel'],
      ['order_cancel', 'paid', 'canceled', 'paid'],
      ['auto_amount_mismatch', 'paid', 'canceled', 'paid'],
    ] as const)('%s の返金は、受け付けた時に、%s の注文へ「%s / %s」の予定を1行書く', async (source, status, kind, variant) => {
      const order = await createOrder(db(), { status, lines: [{ quantity: 1, reserved: status === 'cancelled' ? 0 : 1 }] });
      const stripeRefundId = `re_${uniqueSuffix()}`;
      const refundId = await insertRefund(db(), order.orderId, {
        source, amount: 1000, stripeRefundId: source === 'stripe_dashboard' ? stripeRefundId : null,
      });

      const res = await record(db(), refundId, { status: 'pending', stripeRefundId });

      expect(res).toMatchObject({ status: 'pending', email_enqueued: true });
      expect(await emailsOf(db(), order.orderId)).toEqual([{ kind, variant, origin: 'auto', status: 'pending', refund_id: refundId }]);
      expect((await refundRow(db(), refundId)).email_enqueued_at).not.toBeNull();
    });

    test('お客様に知らせない返金（「メールを送る」を外した返金）は、メールの予定を書かない', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const refundId = await insertRefund(db(), order.orderId, { amount: 1000, notifyCustomer: false });

      const res = await record(db(), refundId, { status: 'succeeded' });

      expect(res).toMatchObject({ newly_accepted: true, email_enqueued: false });
      expect(await emailsOf(db(), order.orderId)).toEqual([]);
      expect((await refundRow(db(), refundId)).email_enqueued_at).toBeNull();
    });

    test('前からの写し（legacy）は、在庫もメールの予定も動かさない', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const stripeRefundId = `re_${uniqueSuffix()}`;
      const refundId = await insertRefund(db(), order.orderId, {
        source: 'legacy', stripeRefundId, amount: 1000, notifyCustomer: false,
      });

      const res = await record(db(), refundId, { status: 'succeeded', stripeRefundId });

      expect(res).toMatchObject({ status: 'succeeded', newly_accepted: false, email_enqueued: false, refunded_amount: 1000 });
      expect(await emailsOf(db(), order.orderId)).toEqual([]);
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([{ delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }]);
      const row = await refundRow(db(), refundId);
      expect(row.stock_applied_at).toBeNull();
      expect(row.email_enqueued_at).toBeNull();
    });

    test('残高不足（insufficient_funds）の保留では、在庫は動かすがメールの予定は書かず、成功になった時に1回だけ書く', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 5000, lines: [{ orderItemId: order.itemIds[0], quantity: 1, amount: 5000 }],
      });

      const pending = await record(db(), refundId, { status: 'pending', pendingReason: 'insufficient_funds' });

      expect(pending).toMatchObject({ newly_accepted: true, email_enqueued: false });
      expect(await emailsOf(db(), order.orderId)).toEqual([]);
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }, { delta: 1, reason: 'refund' },
      ]);

      const done = await record(db(), refundId, { status: 'succeeded' });
      const again = await record(db(), refundId, { status: 'succeeded' });

      expect(done).toMatchObject({ newly_accepted: false, email_enqueued: true });
      expect(again).toMatchObject({ email_enqueued: false });
      expect(await emailsOf(db(), order.orderId)).toEqual([
        expect.objectContaining({ kind: 'refund', variant: 'standard', refund_id: refundId }),
      ]);
    });
  });

  describe('失敗の後始末（Review Focus 2）', () => {
    /** 在庫の品3つ（確保済み。確保した後に残るすぐ出せる数は spare）の注文から、2つを管理画面で返金して、受け付けた状態にする */
    async function acceptedPartialRefund(spare: number) {
      const order = await createOrder(db(), { lines: [{ quantity: 3, spare }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 10000, notifyCustomer: false, lines: [{ orderItemId: order.itemIds[0], quantity: 2, amount: 10000 }],
      });
      await record(db(), refundId, { status: 'pending', pendingReason: 'processing' });
      return { order, refundId };
    }

    /** 受け付けから失敗までの間に、すぐ出せる数が売れて 1 つになった（7 → 1）状態にする */
    function sellDownToOne(variantId: number) {
      return db().query(
        "insert into public.stock_movements (variant_id, delta, reason, note) values ($1, -6, 'adjustment', 'sold elsewhere')",
        [variantId],
      );
    }

    test('確保し直す（足りる時）: 外した数を purchase で確保し直し、要対応を1つ作る。注文の状態は変わらない', async () => {
      const { order, refundId } = await acceptedPartialRefund(5);

      const res = await record(db(), refundId, { status: 'failed', failureReason: 'expired_or_canceled_card' });

      expect(res).toMatchObject({
        status: 'failed', newly_accepted: false, newly_failed: true, order_status: 'paid', refunded_amount: 0,
        rereserve_shortage: 0, email_enqueued: false, exception_id: expect.any(String),
      });
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 8, reason: 'restock' }, { delta: -3, reason: 'purchase' }, { delta: 2, reason: 'refund' }, { delta: -2, reason: 'purchase' },
      ]);
      expect(await variantStock(db(), order.variantIds[0])).toBe(5);
      expect(await lineRows(db(), refundId)).toEqual([
        expect.objectContaining({ released_quantity: 2, rereserved_quantity: 2, rereserve_shortage: 0 }),
      ]);
      expect(await reservedOf(db(), order.orderId)).toEqual([3]);
      expect((await orderState(db(), order.orderId)).review_reason).toBeNull();
      expect(await exceptionsOf(db(), order.orderId)).toEqual([{
        id: res.exception_id, reason: 'refund_failed', detail: 'expired_or_canceled_card', payment_ref: stripeIdOf(refundId),
        resolved_at: null, resolved_by: null,
      }]);
      const tagged = await db().query(
        "select refund_id from public.stock_movements where variant_id = $1 and reason = 'purchase' and refund_id is not null",
        [order.variantIds[0]],
      );
      expect(tagged.rows).toEqual([{ refund_id: refundId }]);
      // 状態も額も変わらないので、注文の改訂は増えない
      expect(await statusRevisions(db(), order.orderId)).toEqual([]);
    });

    test('足りない時は、ある分だけ確保し、足りない数を行に残し、注文に要確認（stock_not_reserved）を付ける', async () => {
      const { order, refundId } = await acceptedPartialRefund(5);
      await sellDownToOne(order.variantIds[0]);

      const res = await record(db(), refundId, { status: 'failed', failureReason: 'expired' });

      expect(res).toMatchObject({ newly_failed: true, rereserve_shortage: 1, order_status: 'paid' });
      expect(await variantStock(db(), order.variantIds[0])).toBe(0);
      expect(await lineRows(db(), refundId)).toEqual([
        expect.objectContaining({ released_quantity: 2, rereserved_quantity: 1, rereserve_shortage: 1 }),
      ]);
      expect(await reservedOf(db(), order.orderId)).toEqual([2]);
      const state = await orderState(db(), order.orderId);
      expect(state.review_reason).toBe('stock_not_reserved');
      expect(state.review_marked_at).not.toBeNull();
      expect(await exceptionsOf(db(), order.orderId)).toHaveLength(1);
    });

    test('もう別の要確認の理由が付いていれば、上書きしない', async () => {
      const { order, refundId } = await acceptedPartialRefund(5);
      await sellDownToOne(order.variantIds[0]);
      await db().query(
        "update public.orders set review_reason = 'recovered_from_payment', review_marked_at = now() where id = $1",
        [order.orderId],
      );

      const res = await record(db(), refundId, { status: 'failed' });

      expect(res.rereserve_shortage).toBe(1);
      expect((await orderState(db(), order.orderId)).review_reason).toBe('recovered_from_payment');
    });

    test('確認済みの注文は、確保し直せなかった時に要確認を付け直し、確認済みの印を外す', async () => {
      const actor = await createActor(db());
      const { order, refundId } = await acceptedPartialRefund(5);
      await sellDownToOne(order.variantIds[0]);
      // 前に確認済みにした注文（理由が残り、確認した人と時刻が入っている）
      await db().query(
        `update public.orders
         set review_reason = 'recovered_from_payment', review_marked_at = now() - interval '1 hour',
             reviewed_at = now() - interval '30 minutes', reviewed_by = $2
         where id = $1`,
        [order.orderId, actor.id],
      );

      const res = await record(db(), refundId, { status: 'failed' });

      expect(res.rereserve_shortage).toBe(1);
      // 同じ取引の中では now() が変わらないので、付け直した時刻は今、前の時刻は1時間前
      const state = await db().query(
        `select review_reason, review_marked_at > now() - interval '10 minutes' as renewed, reviewed_at, reviewed_by
         from public.orders where id = $1`,
        [order.orderId],
      );
      expect(state.rows).toEqual([{ review_reason: 'stock_not_reserved', renewed: true, reviewed_at: null, reviewed_by: null }]);
    });

    test('失敗の後始末は1回だけ: 2回書いても確保し直し・要対応は増えず、2回目は番号を返さない', async () => {
      const { order, refundId } = await acceptedPartialRefund(5);

      const first = await record(db(), refundId, { status: 'failed', failureReason: 'declined' });
      const ledgerAfterFirst = await movementsOf(db(), order.variantIds[0]);
      const second = await record(db(), refundId, { status: 'failed', failureReason: 'declined' });

      expect(first).toMatchObject({ newly_failed: true, exception_id: expect.any(String) });
      expect(second).toMatchObject({ status: 'failed', newly_failed: false, exception_id: null, rereserve_shortage: 0 });
      expect(await movementsOf(db(), order.variantIds[0])).toEqual(ledgerAfterFirst);
      expect(await exceptionsOf(db(), order.orderId)).toHaveLength(1);
      expect((await refundRow(db(), refundId)).failure_applied_at).not.toBeNull();
    });

    test('返事待ちから直に失敗（P21）: 在庫を動かしていないので確保し直しは無く、要対応だけを作る', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 5000, lines: [{ orderItemId: order.itemIds[0], quantity: 1, amount: 5000 }],
      });

      const res = await record(db(), refundId, { status: 'failed', failureReason: 'declined', method: 'paypay' });

      expect(res).toMatchObject({
        status: 'failed', newly_accepted: false, newly_failed: true, email_enqueued: false, exception_id: expect.any(String),
      });
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([{ delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }]);
      expect(await lineRows(db(), refundId)).toEqual([
        expect.objectContaining({ released_quantity: 0, rereserved_quantity: 0, rereserve_shortage: 0 }),
      ]);
      const row = await refundRow(db(), refundId);
      expect(row).toMatchObject({ payment_method_type: 'paypay', stripe_failure_reason: 'declined' });
      expect(row.accepted_at).toBeNull();
      expect(row.stock_applied_at).toBeNull();
      expect(row.failed_at).not.toBeNull();
      expect(row.failure_applied_at).not.toBeNull();
      expect(await emailsOf(db(), order.orderId)).toEqual([]);
      expect(await exceptionsOf(db(), order.orderId)).toHaveLength(1);
    });
  });

  describe('注文の額と状態', () => {
    /** 在庫の品2つの注文を、支払い済みのキャンセル（order_cancel）の全額の返金で取り消す */
    async function cancelPaidOrder() {
      const actor = await createActor(db());
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        source: 'order_cancel', cancelReason: 'customer_request', note: 'お客様の依頼', actorId: actor.id, amount: 10000,
        lines: [{ orderItemId: order.itemIds[0], quantity: 2, amount: 10000 }],
      });
      const res = await record(db(), refundId, { status: 'succeeded' });
      return { actor, order, refundId, res };
    }

    test('全額の返金が成功すると取消になる。取消の列に理由・メモ・知らせるかを写し、改訂の理由は refund_projection', async () => {
      const { actor, order, res } = await cancelPaidOrder();

      expect(res).toMatchObject({
        status: 'succeeded', newly_accepted: true, order_status: 'cancelled', refunded_amount: 10000, email_enqueued: true,
      });
      const state = await orderState(db(), order.orderId);
      expect(state).toMatchObject({
        status: 'cancelled', refunded_amount: 10000, cancel_reason: 'customer_request', cancel_note: 'お客様の依頼',
        cancel_notify_customer: true,
      });
      expect(state.refunded_at).not.toBeNull();
      expect(state.payment_status_updated_at).not.toBeNull();
      expect(await statusRevisions(db(), order.orderId)).toEqual([
        { from_status: 'paid', to_status: 'cancelled', reason: 'refund_projection', changed_by: actor.id },
      ]);
      expect(await emailsOf(db(), order.orderId)).toEqual([expect.objectContaining({ kind: 'canceled', variant: 'paid' })]);
      const history = await db().query(
        'select from_status, to_status, change_reason, cancel_reason, actor_email from public.list_order_status_history($1)',
        [order.orderId],
      );
      expect(history.rows).toEqual([{
        from_status: 'paid', to_status: 'cancelled', change_reason: 'refund_projection', cancel_reason: 'customer_request',
        actor_email: actor.email,
      }]);
    });

    test('全額の返金が成功した後に失敗すると、未発送が残る注文は支払い済みに戻り、取消の列は空になる', async () => {
      const { actor, order, refundId } = await cancelPaidOrder();

      const res = await record(db(), refundId, { status: 'failed', failureReason: 'declined' });

      expect(res).toMatchObject({ status: 'failed', newly_failed: true, order_status: 'paid', refunded_amount: 0, rereserve_shortage: 0 });
      expect(await orderState(db(), order.orderId)).toMatchObject({
        status: 'paid', refunded_amount: 0, refunded_at: null, cancel_reason: null, cancel_note: null, cancel_notify_customer: null,
        shipped_at: null,
      });
      expect(await statusRevisions(db(), order.orderId)).toEqual([
        { from_status: 'paid', to_status: 'cancelled', reason: 'refund_projection', changed_by: actor.id },
        { from_status: 'cancelled', to_status: 'paid', reason: 'refund_projection', changed_by: actor.id },
      ]);
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }, { delta: 2, reason: 'refund' }, { delta: -2, reason: 'purchase' },
      ]);
      expect(await exceptionsOf(db(), order.orderId)).toHaveLength(1);
    });

    test('全部を発送した注文は、全額の返金の失敗で発送済みに戻り、発送の列はそのまま残る', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      await ship(db(), order.orderId, actor.id, [{ itemId: order.itemIds[0], quantity: 2 }], 'TRK-1', 'yamato');
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 10000, notifyCustomer: false,
        lines: [{ orderItemId: order.itemIds[0], quantity: 2, beforeShipment: false, amount: 10000 }],
      });

      const cancelled = await record(db(), refundId, { status: 'succeeded' });
      const restored = await record(db(), refundId, { status: 'failed', failureReason: 'declined' });

      expect(cancelled).toMatchObject({ order_status: 'cancelled', refunded_amount: 10000 });
      expect(restored).toMatchObject({ order_status: 'shipped', refunded_amount: 0 });
      const state = await orderState(db(), order.orderId);
      expect(state).toMatchObject({ status: 'shipped', shipping_carrier: 'yamato', tracking_number: 'TRK-1' });
      expect(state.shipped_at).not.toBeNull();
      expect((await statusRevisions(db(), order.orderId)).map((row) => [row.from_status, row.to_status, row.reason])).toEqual([
        ['paid', 'shipped', 'admin_create_fulfillment'],
        ['shipped', 'cancelled', 'refund_projection'],
        ['cancelled', 'shipped', 'refund_projection'],
      ]);
    });

    test('未入金で取り消した注文への返金（自動の返金①）は、失敗しても取消のまま戻さない（P5）。成功すれば額だけが入る', async () => {
      const failing = await createOrder(db(), { status: 'cancelled', lines: [{ quantity: 1, reserved: 0 }] });
      const succeeding = await createOrder(db(), { status: 'cancelled', lines: [{ quantity: 1, reserved: 0 }] });
      const failingRefund = await insertRefund(db(), failing.orderId, { source: 'auto_cancelled_order_payment', amount: 5000 });
      const succeedingRefund = await insertRefund(db(), succeeding.orderId, { source: 'auto_cancelled_order_payment', amount: 5000 });

      const accepted = await record(db(), failingRefund, { status: 'pending', pendingReason: 'processing' });
      const failed = await record(db(), failingRefund, { status: 'failed', failureReason: 'declined' });
      const succeeded = await record(db(), succeedingRefund, { status: 'succeeded' });

      expect(accepted).toMatchObject({ order_status: 'cancelled', email_enqueued: true });
      expect(await emailsOf(db(), failing.orderId)).toEqual([
        expect.objectContaining({ kind: 'refund', variant: 'after_cancel', refund_id: failingRefund }),
      ]);
      expect(failed).toMatchObject({ newly_failed: true, order_status: 'cancelled', refunded_amount: 0 });
      expect((await orderState(db(), failing.orderId)).status).toBe('cancelled');
      expect(await exceptionsOf(db(), failing.orderId)).toHaveLength(1);
      expect(succeeded).toMatchObject({ order_status: 'cancelled', refunded_amount: 5000 });
      expect(await orderState(db(), succeeding.orderId)).toMatchObject({ status: 'cancelled', refunded_amount: 5000, cancel_reason: null });
      expect(await statusRevisions(db(), succeeding.orderId)).toEqual([]);
    });

    test('残りの商品を全部返金すると発送済みになり、発送の列は取り消していない最後の発送の値。その返金が失敗すると支払い済みに戻り、発送の列は空になる', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), { lines: [{ quantity: 2 }, { quantity: 1 }] });
      await ship(db(), order.orderId, actor.id, [{ itemId: order.itemIds[0], quantity: 1 }], 'TRK-1', 'yamato');
      await ship(db(), order.orderId, actor.id, [{ itemId: order.itemIds[0], quantity: 1 }], 'TRK-2', 'sagawa');
      expect(await orderState(db(), order.orderId)).toMatchObject({ status: 'paid', shipped_at: null });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 5000, notifyCustomer: false, lines: [{ orderItemId: order.itemIds[1], quantity: 1, amount: 5000 }],
      });

      const completed = await record(db(), refundId, { status: 'pending', pendingReason: 'processing' });

      expect(completed).toMatchObject({ newly_accepted: true, order_status: 'shipped', refunded_amount: 0 });
      const shipped = await orderState(db(), order.orderId);
      expect(shipped).toMatchObject({ status: 'shipped', shipping_carrier: 'sagawa', tracking_number: 'TRK-2' });
      expect(shipped.shipped_at).not.toBeNull();
      expect(await lineCounts(db(), order.orderId)).toEqual([
        expect.objectContaining({ shipped: 2, unshipped: 0 }),
        expect.objectContaining({ shipped: 0, unshipped: 0, refunded_before_shipment: 1 }),
      ]);

      const reopened = await record(db(), refundId, { status: 'failed', failureReason: 'expired' });

      expect(reopened).toMatchObject({ newly_failed: true, order_status: 'paid' });
      expect(await orderState(db(), order.orderId)).toMatchObject({
        status: 'paid', shipped_at: null, shipping_carrier: null, tracking_number: null,
      });
      expect((await statusRevisions(db(), order.orderId)).map((row) => [row.from_status, row.to_status, row.reason])).toEqual([
        ['paid', 'shipped', 'refund_completed_order'],
        ['shipped', 'paid', 'refund_failed_reopened'],
      ]);
    });

    test('成功した返金の合計だけを注文の返金済みの額に入れる。保留は入れず、全額に届かなければ状態は変わらない', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 3 }] });
      const refundId = await insertRefund(db(), order.orderId, { amount: 5000, notifyCustomer: false });

      const pending = await record(db(), refundId, { status: 'pending', pendingReason: 'charge_pending' });
      const succeeded = await record(db(), refundId, { status: 'succeeded' });

      expect(pending).toMatchObject({ order_status: 'paid', refunded_amount: 0 });
      expect(succeeded).toMatchObject({ order_status: 'paid', refunded_amount: 5000 });
      const state = await orderState(db(), order.orderId);
      expect(state).toMatchObject({ status: 'paid', refunded_amount: 5000 });
      expect(state.refunded_at).not.toBeNull();
      expect(state.payment_status_updated_at).not.toBeNull();
      expect(await statusRevisions(db(), order.orderId)).toEqual([]);
    });

    test('Stripe の返金の合計が受け取った額を超えても、注文の返金済みの額は受け取った額で頭打ちにし、取り込みを止めない', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const first = await insertRefund(db(), order.orderId, { amount: 4000, notifyCustomer: false });
      const second = await insertRefund(db(), order.orderId, { amount: 3000, notifyCustomer: false });

      await record(db(), first, { status: 'succeeded' });
      const res = await record(db(), second, { status: 'succeeded' });

      expect(res).toMatchObject({ order_status: 'cancelled', refunded_amount: 5000 });
      expect(await orderState(db(), order.orderId)).toMatchObject({ status: 'cancelled', refunded_amount: 5000 });
    });

    test('取消から戻す時、全部の商品をほかの返金の発送前の行が数えている（未発送 0・発送 0）なら、発送済みでなく支払い済みに戻る', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const byLines = await insertRefund(db(), order.orderId, {
        amount: 5000, notifyCustomer: false, lines: [{ orderItemId: order.itemIds[0], quantity: 2, amount: 5000 }],
      });
      const amountOnly = await insertRefund(db(), order.orderId, { amount: 5000, notifyCustomer: false });
      await record(db(), byLines, { status: 'pending' });
      await record(db(), amountOnly, { status: 'succeeded' });
      const cancelled = await record(db(), byLines, { status: 'succeeded' });
      expect(cancelled).toMatchObject({ order_status: 'cancelled', refunded_amount: 10000 });

      const restored = await record(db(), amountOnly, { status: 'failed', failureReason: 'declined' });

      expect(restored).toMatchObject({ order_status: 'paid', refunded_amount: 5000 });
      expect(await lineCounts(db(), order.orderId)).toEqual([
        expect.objectContaining({ shipped: 0, unshipped: 0, refunded_before_shipment: 2 }),
      ]);
      expect(await orderState(db(), order.orderId)).toMatchObject({ status: 'paid', shipped_at: null });
      expect((await statusRevisions(db(), order.orderId)).map((row) => [row.from_status, row.to_status, row.reason])).toEqual([
        ['paid', 'cancelled', 'refund_projection'],
        ['cancelled', 'paid', 'refund_projection'],
      ]);
    });
  });

  describe('許さない移り方・エラーの後・引数', () => {
    test('成功の後の保留の知らせ、失敗の後の成功の知らせは、何も書かず今の値を返す（P22）', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const refundId = await insertRefund(db(), order.orderId, { amount: 1000, notifyCustomer: false });
      await record(db(), refundId, { status: 'succeeded' });

      const late = await record(db(), refundId, { status: 'pending', pendingReason: 'processing' });

      expect(late).toMatchObject({
        status: 'succeeded', newly_accepted: false, newly_failed: false, email_enqueued: false, exception_id: null,
        order_status: 'paid', refunded_amount: 1000,
      });
      expect(await refundRow(db(), refundId)).toMatchObject({ status: 'succeeded', stripe_status: 'succeeded', stripe_pending_reason: null });

      const failedRefund = await insertRefund(db(), order.orderId, { amount: 500, notifyCustomer: false });
      await record(db(), failedRefund, { status: 'failed', failureReason: 'declined' });
      const afterFailure = await record(db(), failedRefund, { status: 'succeeded' });

      expect(afterFailure).toMatchObject({ status: 'failed', newly_accepted: false, refunded_amount: 1000 });
      expect(await refundRow(db(), failedRefund)).toMatchObject({ status: 'failed', stripe_status: 'failed' });
    });

    /** 2つの在庫の品の注文から1つを返す返事待ちの返金を作り、答えが分からずエラーにして要対応を作る（P23 の入口） */
    async function erroredRefund() {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 5000, notifyCustomer: false, lines: [{ orderItemId: order.itemIds[0], quantity: 1, amount: 5000 }],
      });
      const marked = await db().query(MARK_SQL, [refundId, 'not_found_in_stripe', true]);
      return { order, refundId, exceptionId: marked.rows[0].exception_id as string };
    }

    test('エラーにした記録に Stripe の返金が後から見つかった時は、成功まで進める（P23）。エラーの時刻は残り、エラーの時の要対応はシステムが閉じる', async () => {
      const { order, refundId, exceptionId } = await erroredRefund();
      expect(await lineCounts(db(), order.orderId)).toEqual([expect.objectContaining({ unshipped: 2 })]);

      const found = await record(db(), refundId, { status: 'succeeded' });

      expect(found).toMatchObject({ status: 'succeeded', newly_accepted: true, refunded_amount: 5000, order_status: 'paid', exception_id: null });
      const row = await refundRow(db(), refundId);
      expect(row).toMatchObject({ status: 'succeeded', stripe_failure_reason: null });
      expect(row.errored_at).not.toBeNull();
      expect(row.accepted_at).not.toBeNull();
      expect(await lineCounts(db(), order.orderId)).toEqual([expect.objectContaining({ unshipped: 1 })]);
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }, { delta: 1, reason: 'refund' },
      ]);
      // エラーの時に作った要対応（payment_ref は記録の番号）は、Stripe で見つかったので、システムが閉じる（解決した人は空）
      const exceptions = await exceptionsOf(db(), order.orderId);
      expect(exceptions).toEqual([
        expect.objectContaining({ id: exceptionId, detail: 'not_found_in_stripe', payment_ref: refundId, resolved_by: null }),
      ]);
      expect(exceptions[0].resolved_at).not.toBeNull();
      const note = await db().query('select resolution_note from public.payment_exceptions where id = $1', [exceptionId]);
      expect(note.rows[0].resolution_note).toBe('Stripe で返金が見つかったため自動で解決');
    });

    test('エラーの間に発送した品の発送前の返金が後から成功した時は、結果を記録しても、数の関係が崩れた要対応を閉じない（P23 の controller ruling）', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 5000, notifyCustomer: false, lines: [{ orderItemId: order.itemIds[0], quantity: 1, amount: 5000 }],
      });
      expect(await refundRow(db(), refundId)).toMatchObject({ status: 'awaiting_response' });

      const marked = await db().query(MARK_SQL, [refundId, 'not_found_in_stripe', true]);
      expect(marked.rows).toEqual([{ outcome: 'errored', order_id: order.orderId, exception_id: expect.any(String) }]);
      const exceptionId = marked.rows[0].exception_id as string;
      expect(await exceptionsOf(db(), order.orderId)).toEqual([
        expect.objectContaining({ id: exceptionId, payment_ref: refundId, resolved_at: null }),
      ]);
      expect(await lineCounts(db(), order.orderId)).toEqual([
        expect.objectContaining({ shipped: 0, unshipped: 1, refunded_before_shipment: 0 }),
      ]);

      // エラーの返金の行は数えないため発送できるが、後から返金が成功しても品物はお客様に届いている
      const shipped = await ship(db(), order.orderId, actor.id, [{ itemId: order.itemIds[0], quantity: 1 }]);
      expect(shipped.rows[0]).toMatchObject({ completes_order: true, order_status: 'shipped' });

      const found = await record(db(), refundId, { status: 'succeeded' });

      expect(found).toMatchObject({ status: 'succeeded', newly_accepted: true, refunded_amount: 5000, exception_id: null });
      const row = await refundRow(db(), refundId);
      expect(row).toMatchObject({ status: 'succeeded', stripe_refund_id: stripeIdOf(refundId) });
      expect(row.accepted_at).not.toBeNull();
      expect(row.errored_at).not.toBeNull();
      const counts = await db().query(
        'select quantity, shipped, refunded_before_shipment from private.order_line_fulfillment($1) where order_item_id = $2',
        [order.orderId, order.itemIds[0]],
      );
      expect(counts.rows).toEqual([{ quantity: 1, shipped: 1, refunded_before_shipment: 1 }]);
      // s + rb > q のため、エラーの時の要対応を自動で解決せず、同じ1行を開いたまま残す
      expect(await exceptionsOf(db(), order.orderId)).toEqual([
        expect.objectContaining({
          id: exceptionId, reason: 'refund_failed', detail: 'not_found_in_stripe', payment_ref: refundId,
          resolved_at: null, resolved_by: null,
        }),
      ]);
    });

    test('エラーにした記録が保留として見つかった時も、エラーの時の要対応を閉じる（P23）。要対応は1行のまま', async () => {
      const { order, refundId, exceptionId } = await erroredRefund();

      const found = await record(db(), refundId, { status: 'pending', pendingReason: 'processing' });
      const again = await record(db(), refundId, { status: 'pending', pendingReason: 'processing' });

      expect(found).toMatchObject({ status: 'pending', newly_accepted: true, exception_id: null });
      expect(again).toMatchObject({ status: 'pending', newly_accepted: false, exception_id: null });
      const exceptions = await exceptionsOf(db(), order.orderId);
      expect(exceptions).toEqual([expect.objectContaining({ id: exceptionId, resolved_by: null })]);
      expect(exceptions[0].resolved_at).not.toBeNull();
    });

    test('エラーにした記録が、受け付けられないまま Stripe で失敗として見つかった時は、要対応を2件にしない。エラーの時の要対応と同じ1行で、閉じない（P23）', async () => {
      const { order, refundId, exceptionId } = await erroredRefund();

      const failed = await record(db(), refundId, { status: 'failed', failureReason: 'expired' });

      expect(failed).toMatchObject({ status: 'failed', newly_accepted: false, newly_failed: true, exception_id: exceptionId });
      expect(await exceptionsOf(db(), order.orderId)).toEqual([
        expect.objectContaining({ id: exceptionId, payment_ref: refundId, resolved_at: null }),
      ]);
      // 在庫を動かしていないので、確保し直しは無い
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([{ delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }]);
    });

    test('エラーにした記録が保留か成功として見つかり（エラーの時の要対応はシステムが閉じた）、その後に失敗した時は、新しい要対応を作って番号を返す。閉じた行に重ねない（P23）', async () => {
      for (const accepted of ['pending', 'succeeded'] as const) {
        const { order, refundId, exceptionId } = await erroredRefund();
        await record(db(), refundId, { status: accepted });

        const failed = await record(db(), refundId, { status: 'failed', failureReason: 'expired' });

        expect(failed).toMatchObject({ status: 'failed', newly_failed: true, exception_id: expect.any(String) });
        expect(failed.exception_id).not.toBe(exceptionId);
        // エラーの時の要対応は閉じたまま。失敗は Stripe の返金の番号を印にした新しい要対応（開いている）になる
        const exceptions = await exceptionsOf(db(), order.orderId);
        expect(exceptions).toHaveLength(2);
        expect(exceptions.find((row) => row.id === exceptionId)).toMatchObject({
          payment_ref: refundId, resolved_by: null, resolved_at: expect.any(Date),
        });
        expect(exceptions.find((row) => row.id === failed.exception_id)).toMatchObject({
          payment_ref: stripeIdOf(refundId), detail: 'expired', resolved_at: null,
        });
      }
    });

    test('Stripe の返金の番号の形は ^[a-z]{2,4}_[A-Za-z0-9]+$（P29）: re_ 以外の接頭辞（pyr_）も受け、形の違う番号は断る', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const refundId = await insertRefund(db(), order.orderId, { amount: 1000, notifyCustomer: false });

      const res = await record(db(), refundId, { status: 'succeeded', stripeRefundId: 'pyr_AbC123' });

      expect(res).toMatchObject({ status: 'succeeded' });
      expect(await refundRow(db(), refundId)).toMatchObject({ stripe_refund_id: 'pyr_AbC123' });
      const external = await recordExternal(db(), order.orderId, { stripeRefundId: 'pyr_ZzY987', amount: 500 });
      expect(external).toMatchObject({ created: true, source: 'stripe_dashboard' });
      for (const bad of ['re-1234', 'RE_1234', 're_', 'abcde_1234', '_1234']) {
        await expectRejected(db(), EXTERNAL_SQL, externalParams(order.orderId, { stripeRefundId: bad, amount: 100 }), {
          code: '22023', message: 'REFUND_ARGUMENT_INVALID',
        });
      }
    });

    test('口座の入力の期限と照会番号は、空の知らせで消えず、新しい値で上書きされる。支払いの種類は最初の値のまま', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const refundId = await insertRefund(db(), order.orderId, { amount: 1000, notifyCustomer: false });
      const expiresAt = '2026-11-25T14:59:59.000Z';

      await record(db(), refundId, {
        status: 'pending', method: 'konbini', expiresAt, referenceNumber: 'ARN-1', referenceType: 'acquirer_reference_number',
      });
      await record(db(), refundId, { status: 'pending', method: 'card' });

      const kept = await refundRow(db(), refundId);
      expect(kept).toMatchObject({ payment_method_type: 'konbini', reference_number: 'ARN-1', reference_type: 'acquirer_reference_number' });
      expect(kept.customer_action_expires_at).toEqual(new Date(expiresAt));

      await record(db(), refundId, { status: 'succeeded', referenceNumber: 'ARN-2' });
      expect(await refundRow(db(), refundId)).toMatchObject({ status: 'succeeded', reference_number: 'ARN-2' });
    });

    test('引数の誤りは REFUND_ARGUMENT_INVALID。無い記録は REFUND_NOT_FOUND、別の Stripe の番号は REFUND_STRIPE_ID_MISMATCH', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const refundId = await insertRefund(db(), order.orderId, { amount: 1000, notifyCustomer: false });
      const other = await insertRefund(db(), order.orderId, { amount: 1000, notifyCustomer: false });
      const base = recordParams(refundId, { status: 'pending' });
      // [引数の位置, 誤った値]。位置は 0 記録の番号、1 Stripe の番号、2 状態、3 保留の理由、4 失敗の理由、6 支払いの種類、7 照会番号、8 照会の種類
      const bad: Array<[number, unknown]> = [
        [0, null], [1, 're-1234'], [1, 'abcde_1234'], [1, null], [2, 'weird'], [2, null], [3, 'unknown_reason'], [4, 'Bad Reason'],
        [6, 'Card Type'], [7, 'x'.repeat(65)], [8, 'Bad Type'],
      ];
      for (const [index, value] of bad) {
        const params = [...base];
        params[index] = value;
        await expectRejected(db(), RECORD_SQL, params, { code: '22023', message: 'REFUND_ARGUMENT_INVALID' });
      }

      await expectRejected(db(), RECORD_SQL, recordParams(crypto.randomUUID(), { status: 'pending' }), {
        code: 'P0002', message: 'REFUND_NOT_FOUND',
      });

      await record(db(), refundId, { status: 'pending' });
      await expectRejected(db(), RECORD_SQL, recordParams(refundId, { status: 'pending', stripeRefundId: 're_otherid1234' }), {
        code: '22023', message: 'REFUND_STRIPE_ID_MISMATCH',
      });
      // 別の記録がもう使っている Stripe の返金の番号も断る
      await expectRejected(db(), RECORD_SQL, recordParams(other, { status: 'pending', stripeRefundId: stripeIdOf(refundId) }), {
        code: '22023', message: 'REFUND_STRIPE_ID_MISMATCH',
      });
    });
  });

  describe('外からの返金（印の無い返金）', () => {
    test('切り替えより前に作られた返金は写し（legacy）: 額だけ注文に入り、在庫もメールの予定も動かさない（Review Focus 5）', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const stripeRefundId = `re_${uniqueSuffix()}`;
      const before = new Date((await ledgerStartedAt(db())).getTime() - 86_400_000).toISOString();

      const res = await recordExternal(db(), order.orderId, { stripeRefundId, amount: 4000, createdAt: before });

      expect(res).toMatchObject({
        created: true, source: 'legacy', status: 'succeeded', newly_accepted: false, newly_failed: false,
        order_status: 'paid', refunded_amount: 4000, email_enqueued: false, exception_id: null,
      });
      const row = await refundRow(db(), res.refund_id);
      expect(row).toMatchObject({
        order_id: order.orderId, source: 'legacy', stripe_refund_id: stripeRefundId, notify_customer: false, amount: 4000,
        shipping_amount: 0, adjustment_amount: 4000, actor_id: null, request_key: null, payment_method_type: 'card',
        stripe_reason: 'requested_by_customer',
      });
      expect(row.stock_applied_at).toBeNull();
      expect(row.email_enqueued_at).toBeNull();
      expect(await lineRows(db(), res.refund_id)).toEqual([]);
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([{ delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }]);
      expect(await emailsOf(db(), order.orderId)).toEqual([]);
      const same = await db().query('select created_at = $2::timestamptz as same from public.order_refunds where id = $1', [res.refund_id, before]);
      expect(same.rows[0].same).toBe(true);

      // 同じ返金をもう一度受けても、写しのまま1行
      const again = await recordExternal(db(), order.orderId, { stripeRefundId, amount: 4000, createdAt: before });
      expect(again).toMatchObject({ created: false, source: 'legacy', refund_id: res.refund_id, refunded_amount: 4000 });
    });

    test('切り替えより後の一部の返金は Stripe の画面からの返金: 額だけ（行なし）。在庫は動かさず、お客様に返金のお知らせの予定を書く', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });

      const res = await recordExternal(db(), order.orderId, { amount: 4000, stripeReason: 'expired_uncaptured_charge' });

      expect(res).toMatchObject({
        created: true, source: 'stripe_dashboard', status: 'succeeded', newly_accepted: true, order_status: 'paid',
        refunded_amount: 4000, email_enqueued: true,
      });
      expect(await refundRow(db(), res.refund_id)).toMatchObject({
        notify_customer: true, shipping_amount: 0, adjustment_amount: 4000, stripe_reason: null, payment_method_type: 'card',
      });
      expect(await lineRows(db(), res.refund_id)).toEqual([]);
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([{ delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }]);
      expect(await emailsOf(db(), order.orderId)).toEqual([
        { kind: 'refund', variant: 'standard', origin: 'auto', status: 'pending', refund_id: res.refund_id },
      ]);
    });

    test('全額になる時は、残りの未発送を全部発送前の行に入れ、在庫に戻してメールの予定を書く。一部を発送した注文でも同じ（Review Focus 4）', async () => {
      const actor = await createActor(db());
      // 在庫の品3つ（1つ発送済み）と受注生産の品2つ。割引 1000・送料 500 で、受け取った額は 24500
      const order = await createOrder(db(), {
        lines: [{ quantity: 3 }, { quantity: 2, backorder: true }], shippingAmount: 500, discountAmount: 1000,
      });
      await ship(db(), order.orderId, actor.id, [{ itemId: order.itemIds[0], quantity: 1 }]);
      const committed = async () => (await db().query(
        'select committed from public.list_variant_stock_states(array[$1::bigint])',
        [order.variantIds[0]],
      )).rows;
      expect(await committed()).toEqual([{ committed: 2 }]);
      const stripeRefundId = `re_${uniqueSuffix()}`;

      const res = await recordExternal(db(), order.orderId, { stripeRefundId, amount: order.total });

      expect(res).toMatchObject({
        created: true, source: 'stripe_dashboard', status: 'succeeded', newly_accepted: true, order_status: 'cancelled',
        refunded_amount: 24500, email_enqueued: true,
      });
      // 割引 1000 を小計の割合で割ると 600・400。どちらの商品も 2 点で 5000×2 − 400 = 9600
      expect(await lineRows(db(), res.refund_id)).toEqual([
        expect.objectContaining({
          quantity: 2, before_shipment: true, restock_type: 'cancel', amount: 9600, released_quantity: 2, restocked_quantity: 2,
        }),
        expect.objectContaining({
          quantity: 2, before_shipment: true, restock_type: 'no_restock', amount: 9600, released_quantity: 0, restocked_quantity: 0,
        }),
      ]);
      expect(await refundRow(db(), res.refund_id)).toMatchObject({ amount: 24500, shipping_amount: 500, adjustment_amount: 4800 });
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 3, reason: 'restock' }, { delta: -3, reason: 'purchase' }, { delta: 2, reason: 'refund' },
      ]);
      expect(await committed()).toEqual([{ committed: 0 }]);
      expect(await orderState(db(), order.orderId)).toMatchObject({ status: 'cancelled', refunded_amount: 24500 });
      expect(await emailsOf(db(), order.orderId)).toEqual([
        { kind: 'refund', variant: 'standard', origin: 'auto', status: 'pending', refund_id: res.refund_id },
      ]);

      // 同じ Stripe の返金をもう一度受けても、記録・行・台帳・メールの予定は増えない
      const again = await recordExternal(db(), order.orderId, { stripeRefundId, amount: order.total });
      expect(again).toMatchObject({ created: false, refund_id: res.refund_id, newly_accepted: false, email_enqueued: false });
      const counts = await db().query(
        `select (select count(*)::int from public.order_refunds where order_id = $1) as refunds,
                (select count(*)::int from public.order_refund_lines where refund_id = $2) as lines,
                (select count(*)::int from private.order_email_outbox where order_id = $1 and kind = 'refund') as emails`,
        [order.orderId, res.refund_id],
      );
      expect(counts.rows[0]).toEqual({ refunds: 1, lines: 2, emails: 1 });
      expect(await movementsOf(db(), order.variantIds[0])).toHaveLength(3);
    });

    test('一部の返金が積み重なって全額になった時の返金だけが、残りの未発送を入れる。計算との差は負にもなる', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });

      const first = await recordExternal(db(), order.orderId, { amount: 4000 });
      const second = await recordExternal(db(), order.orderId, { amount: 6000 });

      expect(first).toMatchObject({ order_status: 'paid', refunded_amount: 4000 });
      expect(await lineRows(db(), first.refund_id)).toEqual([]);
      expect(second).toMatchObject({ order_status: 'cancelled', refunded_amount: 10000 });
      expect(await lineRows(db(), second.refund_id)).toEqual([
        expect.objectContaining({ quantity: 2, restock_type: 'cancel', amount: 10000, released_quantity: 2, restocked_quantity: 2 }),
      ]);
      expect(await refundRow(db(), second.refund_id)).toMatchObject({ amount: 6000, shipping_amount: 0, adjustment_amount: -4000 });
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }, { delta: 2, reason: 'refund' },
      ]);
      expect(await emailsOf(db(), order.orderId)).toHaveLength(2);
    });

    test('Stripe の状態が失敗の新しい返金は、全額でも行を入れず、要対応だけを作る', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });

      const res = await recordExternal(db(), order.orderId, { amount: order.total, status: 'failed', failureReason: 'declined' });

      expect(res).toMatchObject({
        created: true, source: 'stripe_dashboard', status: 'failed', newly_accepted: false, newly_failed: true,
        order_status: 'paid', refunded_amount: 0, email_enqueued: false, exception_id: expect.any(String),
      });
      expect(await lineRows(db(), res.refund_id)).toEqual([]);
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([{ delta: 1, reason: 'restock' }, { delta: -1, reason: 'purchase' }]);
      expect(await exceptionsOf(db(), order.orderId)).toHaveLength(1);
    });

    test('切り替えより前の失敗の返金も写しのままで、要対応を作らない（店にメールが飛ばない。Review Focus 5）', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const before = new Date((await ledgerStartedAt(db())).getTime() - 86_400_000).toISOString();

      const res = await recordExternal(db(), order.orderId, {
        amount: 1000, status: 'failed', failureReason: 'declined', createdAt: before,
      });

      expect(res).toMatchObject({ created: true, source: 'legacy', status: 'failed', newly_failed: false, exception_id: null });
      expect(await exceptionsOf(db(), order.orderId)).toEqual([]);
    });

    test('全額になる時の送料は返せる送料の全部で、その返金の額を超えない。全部を発送した注文でも送料を入れる', async () => {
      const actor = await createActor(db());
      // 在庫の品2つ・送料 500（合計 10500）。10400 の後の 100 で全額になる
      const stacked = await createOrder(db(), { lines: [{ quantity: 2 }], shippingAmount: 500 });
      await recordExternal(db(), stacked.orderId, { amount: 10400 });
      const last = await recordExternal(db(), stacked.orderId, { amount: 100 });
      expect(await refundRow(db(), last.refund_id)).toMatchObject({ amount: 100, shipping_amount: 100, adjustment_amount: -10000 });

      // 全部を発送した注文（合計 5500）を Stripe の画面で全額返金した。行は入らないが、送料は入る
      const shippedOrder = await createOrder(db(), { lines: [{ quantity: 1 }], shippingAmount: 500 });
      await ship(db(), shippedOrder.orderId, actor.id, [{ itemId: shippedOrder.itemIds[0], quantity: 1 }]);
      const full = await recordExternal(db(), shippedOrder.orderId, { amount: shippedOrder.total });
      expect(full).toMatchObject({ order_status: 'cancelled', refunded_amount: 5500 });
      expect(await refundRow(db(), full.refund_id)).toMatchObject({ amount: 5500, shipping_amount: 500, adjustment_amount: 5000 });
      expect(await lineRows(db(), full.refund_id)).toEqual([]);
    });

    test('引数の誤りは REFUND_ARGUMENT_INVALID、無い注文は ORDER_NOT_FOUND', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const base = externalParams(order.orderId, { amount: 1000 });
      // [引数の位置, 誤った値]。位置は 0 注文の番号、1 Stripe の番号、2 額、3 状態、7 支払いの種類、11 Stripe の作った時刻
      const bad: Array<[number, unknown]> = [
        [0, null], [1, 're-1234'], [1, 'abcde_1234'], [2, 0], [2, null], [3, 'weird'], [7, 'Card Type'], [11, null],
      ];
      for (const [index, value] of bad) {
        const params = [...base];
        params[index] = value;
        await expectRejected(db(), EXTERNAL_SQL, params, { code: '22023', message: 'REFUND_ARGUMENT_INVALID' });
      }

      await expectRejected(db(), EXTERNAL_SQL, externalParams(crypto.randomUUID(), { amount: 1000 }), {
        code: 'P0002', message: 'ORDER_NOT_FOUND',
      });
    });
  });

  describe('エラーにする関数', () => {
    test('返事待ちをエラーにする。数えなくなり（未発送が戻る）、要対応を作る時は番号を返す', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        amount: 10000, lines: [{ orderItemId: order.itemIds[0], quantity: 2, amount: 10000 }],
      });
      expect(await lineCounts(db(), order.orderId)).toEqual([expect.objectContaining({ unshipped: 0 })]);

      const res = await db().query(MARK_SQL, [refundId, 'stripe_rejected', true]);

      expect(res.rows).toEqual([{ outcome: 'errored', order_id: order.orderId, exception_id: expect.any(String) }]);
      const row = await refundRow(db(), refundId);
      expect(row).toMatchObject({ status: 'error', stripe_failure_reason: 'stripe_rejected' });
      expect(row.errored_at).not.toBeNull();
      expect(await lineCounts(db(), order.orderId)).toEqual([expect.objectContaining({ unshipped: 2 })]);
      expect(await exceptionsOf(db(), order.orderId)).toEqual([{
        id: res.rows[0].exception_id, reason: 'refund_failed', detail: 'stripe_rejected', payment_ref: refundId,
        resolved_at: null, resolved_by: null,
      }]);
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([{ delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }]);
    });

    test('要対応を作らない呼び方もできる。返事待ちでない記録は not_awaiting で、何も変えない', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const waiting = await insertRefund(db(), order.orderId, { amount: 1000 });
      const accepted = await insertRefund(db(), order.orderId, { amount: 1000 });
      await record(db(), accepted, { status: 'pending' });

      const quiet = await db().query(MARK_SQL, [waiting, 'not_found_in_stripe', false]);
      const again = await db().query(MARK_SQL, [waiting, 'not_found_in_stripe', true]);
      const notWaiting = await db().query(MARK_SQL, [accepted, 'not_found_in_stripe', true]);

      expect(quiet.rows).toEqual([{ outcome: 'errored', order_id: order.orderId, exception_id: null }]);
      expect(again.rows).toEqual([{ outcome: 'not_awaiting', order_id: order.orderId, exception_id: null }]);
      expect(notWaiting.rows).toEqual([{ outcome: 'not_awaiting', order_id: order.orderId, exception_id: null }]);
      expect((await refundRow(db(), accepted)).status).toBe('pending');
      expect(await exceptionsOf(db(), order.orderId)).toEqual([]);
    });

    test('返事待ちがエラーになって未発送が戻ったら、発送済みの注文を支払い済みに戻す（refund_failed_reopened）。戻った品はまた送れる', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), { lines: [{ quantity: 1 }, { quantity: 1 }] });
      // 2つ目の品を返す返金の Stripe の答えが分からず、返事待ちのまま。返事待ちの品は送れないので、1つ目を送ると注文が完了する
      const awaiting = await insertRefund(db(), order.orderId, {
        amount: 5000, notifyCustomer: false, lines: [{ orderItemId: order.itemIds[1], quantity: 1, amount: 5000 }],
      });
      const shipped = await ship(db(), order.orderId, actor.id, [{ itemId: order.itemIds[0], quantity: 1 }]);
      expect(shipped.rows[0]).toMatchObject({ completes_order: true, order_status: 'shipped' });

      const res = await db().query(MARK_SQL, [awaiting, 'not_found_in_stripe', true]);

      expect(res.rows[0]).toMatchObject({ outcome: 'errored', order_id: order.orderId });
      expect(await orderState(db(), order.orderId)).toMatchObject({
        status: 'paid', shipped_at: null, shipping_carrier: null, tracking_number: null,
      });
      expect((await statusRevisions(db(), order.orderId)).map((row) => [row.from_status, row.to_status, row.reason])).toEqual([
        ['paid', 'shipped', 'admin_create_fulfillment'],
        ['shipped', 'paid', 'refund_failed_reopened'],
      ]);
      const again = await ship(db(), order.orderId, actor.id, [{ itemId: order.itemIds[1], quantity: 1 }], 'TRK-2');
      expect(again.rows[0]).toMatchObject({ completes_order: true, order_status: 'shipped' });
    });

    test('引数の誤りは REFUND_ARGUMENT_INVALID、無い記録は REFUND_NOT_FOUND', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const refundId = await insertRefund(db(), order.orderId, { amount: 1000 });

      for (const params of [[null, 'stripe_rejected', true], [refundId, null, true], [refundId, 'Bad Reason', true], [refundId, 'stripe_rejected', null]]) {
        await expectRejected(db(), MARK_SQL, params, { code: '22023', message: 'REFUND_ARGUMENT_INVALID' });
      }
      await expectRejected(db(), MARK_SQL, [crypto.randomUUID(), 'stripe_rejected', true], { code: 'P0002', message: 'REFUND_NOT_FOUND' });
    });
  });

  describe('一覧の要約と要対応の自動の解決', () => {
    test('要約は、渡した注文ごとに1行。手続き中の返金（返事待ちと保留）と、開いている返金の失敗の要対応を印にする', async () => {
      const waiting = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const holding = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const partial = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const failed = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const plain = await createOrder(db(), { lines: [{ quantity: 2 }] });
      await insertRefund(db(), waiting.orderId, { amount: 3000, notifyCustomer: false });
      const pendingRefund = await insertRefund(db(), holding.orderId, { amount: 2500, notifyCustomer: false });
      await record(db(), pendingRefund, { status: 'pending', pendingReason: 'processing' });
      const done = await insertRefund(db(), partial.orderId, { amount: 4000, notifyCustomer: false });
      await record(db(), done, { status: 'succeeded' });
      const bad = await insertRefund(db(), failed.orderId, { amount: 2000, notifyCustomer: false });
      const failure = await record(db(), bad, { status: 'failed', failureReason: 'declined' });
      // 存在しない注文の番号も混ぜる（その行は返さない）
      const ids = [waiting.orderId, holding.orderId, partial.orderId, failed.orderId, plain.orderId, crypto.randomUUID()];
      const summaries = async () => {
        const res = await db().query('select * from public.list_order_refund_summaries($1::uuid[])', [ids]);
        return Object.fromEntries(res.rows.map((row) => [row.order_id as string, row]));
      };

      const before = await summaries();

      expect(Object.keys(before)).toHaveLength(5);
      expect(before[waiting.orderId]).toMatchObject({
        paid_amount: 10000, succeeded_amount: 0, open_amount: 3000, refundable_amount: 7000,
        has_open_refund: true, has_unresolved_refund_failure: false,
      });
      expect(before[holding.orderId]).toMatchObject({
        succeeded_amount: 0, open_amount: 2500, refundable_amount: 7500, has_open_refund: true, has_unresolved_refund_failure: false,
      });
      expect(before[partial.orderId]).toMatchObject({
        succeeded_amount: 4000, open_amount: 0, refundable_amount: 6000, has_open_refund: false, has_unresolved_refund_failure: false,
      });
      expect(before[failed.orderId]).toMatchObject({
        succeeded_amount: 0, open_amount: 0, refundable_amount: 10000, has_open_refund: false, has_unresolved_refund_failure: true,
      });
      expect(before[plain.orderId]).toMatchObject({
        succeeded_amount: 0, open_amount: 0, refundable_amount: 10000, has_open_refund: false, has_unresolved_refund_failure: false,
      });

      // 要対応を閉じると、返金の失敗の印が消える
      const closed = await db().query('select public.resolve_payment_exception_by_system($1::uuid, $2::text) as closed', [
        failure.exception_id, 'システムが自動で解決した',
      ]);
      expect(closed.rows[0].closed).toBe(true);
      expect((await summaries())[failed.orderId]).toMatchObject({ has_unresolved_refund_failure: false });
    });

    test('要約は、201件以上を TOO_MANY_ORDERS で断り、空の一覧には何も返さない', async () => {
      const ids = Array.from({ length: 201 }, () => crypto.randomUUID());

      await expectRejected(db(), 'select * from public.list_order_refund_summaries($1::uuid[])', [ids], {
        code: '22023', message: 'TOO_MANY_ORDERS',
      });
      expect((await db().query('select * from public.list_order_refund_summaries($1::uuid[])', [[]])).rows).toEqual([]);
      expect((await db().query('select * from public.list_order_refund_summaries(null::uuid[])')).rows).toEqual([]);
    });

    test('要対応の自動の解決: 開いている要対応を閉じ（解決した人は空）、閉じ済みは false。空の番号と長すぎるメモは断る', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const exception = await db().query(
        "select exception_id from public.record_payment_exception($1::text, 'refund_failed', 'declined', null, null, null, $2::uuid)",
        [`re_${uniqueSuffix()}`, order.orderId],
      );
      const id = exception.rows[0].exception_id as string;
      const sql = 'select public.resolve_payment_exception_by_system($1::uuid, $2::text) as closed';

      expect((await db().query(sql, [id, 'システムが自動で返金した'])).rows[0].closed).toBe(true);
      expect((await db().query(sql, [id, 'もう一度'])).rows[0].closed).toBe(false);

      expect(await exceptionsOf(db(), order.orderId)).toEqual([expect.objectContaining({ id, resolved_by: null })]);
      const closed = await db().query('select resolved_at, resolution_note from public.payment_exceptions where id = $1', [id]);
      expect(closed.rows[0].resolved_at).not.toBeNull();
      expect(closed.rows[0].resolution_note).toBe('システムが自動で返金した');
      expect((await db().query(sql, [crypto.randomUUID(), null])).rows[0].closed).toBe(false);
      await expectRejected(db(), sql, [null, 'メモ'], { code: '22023', message: 'RESOLVE_ARGUMENT_REQUIRED' });
      await expectRejected(db(), sql, [id, 'あ'.repeat(501)], { code: '22023', message: 'RESOLUTION_NOTE_TOO_LONG' });
    });
  });

  describe('注文のメールの表', () => {
    const MARK_SENT_SQL = "update private.order_email_outbox set status = 'sent', sent_at = now(), finished_at = now() where order_id = $1";

    test('支払い済みのキャンセルのお知らせは返金ごとに1行: 取り消す → 失敗 → もう一度取り消すで2行。支払い済みに戻った注文の取消のお知らせは再送できない', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), { lines: [{ quantity: 1, spare: 1 }] });
      const cancel = () => insertRefund(db(), order.orderId, {
        source: 'order_cancel', actorId: actor.id, amount: 5000, lines: [{ orderItemId: order.itemIds[0], quantity: 1, amount: 5000 }],
      });
      const first = await cancel();
      await record(db(), first, { status: 'pending' });
      await record(db(), first, { status: 'failed', failureReason: 'expired' });
      const second = await cancel();
      await record(db(), second, { status: 'pending' });

      expect(await emailsOf(db(), order.orderId)).toEqual([
        { kind: 'canceled', variant: 'paid', origin: 'auto', status: 'pending', refund_id: first },
        { kind: 'canceled', variant: 'paid', origin: 'auto', status: 'pending', refund_id: second },
      ]);

      // 取消のお知らせの再送は、注文が取消の間だけできる。ここは支払い済みのまま（2回目の返金はまだ保留）
      await db().query(MARK_SENT_SQL, [order.orderId]);
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [order.orderId, 'canceled', actor.id], {
        code: '22023', message: 'RESEND_NOT_ALLOWED',
      });
    });

    test('取消のお知らせの再送は、最後に送った取消の行の書き分けと返金の番号を写す。取り出しと履歴にも返金の番号が出る', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const refundId = await insertRefund(db(), order.orderId, {
        source: 'order_cancel', actorId: actor.id, amount: 10000, lines: [{ orderItemId: order.itemIds[0], quantity: 2, amount: 10000 }],
      });
      await record(db(), refundId, { status: 'succeeded' });
      await db().query(MARK_SENT_SQL, [order.orderId]);
      const sql = 'select public.request_order_email_resend($1, $2, $3) as email_id';

      const resent = await db().query(sql, [order.orderId, 'canceled', actor.id]);

      const row = await db().query(
        'select kind, variant, origin, status, requested_by, refund_id from private.order_email_outbox where id = $1',
        [resent.rows[0].email_id],
      );
      expect(row.rows).toEqual([{
        kind: 'canceled', variant: 'paid', origin: 'manual', status: 'pending', requested_by: actor.id, refund_id: refundId,
      }]);
      await expectRejected(db(), sql, [order.orderId, 'canceled', actor.id], { code: '23505', message: 'RESEND_ALREADY_QUEUED' });

      const claimed = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      expect(claimed).toMatchObject({
        order_id: order.orderId, kind: 'canceled', variant: 'paid', origin: 'manual', fulfillment_id: null, refund_id: refundId,
      });
      const history = await db().query(
        'select kind, variant, origin, refund_id from public.list_order_email_history($1)',
        [order.orderId],
      );
      expect(history.rows).toEqual([
        { kind: 'canceled', variant: 'paid', origin: 'manual', refund_id: refundId },
        { kind: 'canceled', variant: 'paid', origin: 'auto', refund_id: refundId },
      ]);
    });

    test('取消のお知らせの再送は、失敗した返金の行からは写さない。写せる行が無ければ RESEND_NOT_ALLOWED で、送り終えた新しい返金の行からは写す', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const cancel = () => insertRefund(db(), order.orderId, {
        source: 'order_cancel', actorId: actor.id, amount: 5000, lines: [{ orderItemId: order.itemIds[0], quantity: 1, amount: 5000 }],
      });
      // 1回目の取消は保留でお知らせを送り終えた後に失敗し、2回目の取消が成功して注文が取消になった。2通目のお知らせはまだ送信待ち
      const first = await cancel();
      await record(db(), first, { status: 'pending' });
      await db().query(MARK_SENT_SQL, [order.orderId]);
      await record(db(), first, { status: 'failed', failureReason: 'expired' });
      const second = await cancel();
      await record(db(), second, { status: 'succeeded' });
      expect((await orderState(db(), order.orderId)).status).toBe('cancelled');
      const sql = 'select public.request_order_email_resend($1, $2, $3) as email_id';

      // 送り終えたのは失敗した返金の行だけなので、写せる行が無い
      await expectRejected(db(), sql, [order.orderId, 'canceled', actor.id], { code: '22023', message: 'RESEND_NOT_ALLOWED' });

      await db().query("update private.order_email_outbox set status = 'sent', sent_at = now(), finished_at = now() where refund_id = $1", [second]);
      const resent = await db().query(sql, [order.orderId, 'canceled', actor.id]);

      const row = await db().query(
        'select kind, variant, origin, status, refund_id from private.order_email_outbox where id = $1',
        [resent.rows[0].email_id],
      );
      expect(row.rows).toEqual([{ kind: 'canceled', variant: 'paid', origin: 'manual', status: 'pending', refund_id: second }]);
    });

    test('返金のお知らせは、注文が支払い済みでも取消でも再送できない（RESEND_NOT_ALLOWED。INVALID_EMAIL_KIND ではない）', async () => {
      const actor = await createActor(db());
      const partial = await createOrder(db(), { lines: [{ quantity: 2 }] });
      const full = await createOrder(db(), { lines: [{ quantity: 1 }] });
      await record(db(), await insertRefund(db(), partial.orderId, { amount: 1000 }), { status: 'succeeded' });
      await record(db(), await insertRefund(db(), full.orderId, {
        amount: 5000, lines: [{ orderItemId: full.itemIds[0], quantity: 1, amount: 5000 }],
      }), { status: 'succeeded' });
      expect((await orderState(db(), partial.orderId)).status).toBe('paid');
      expect((await orderState(db(), full.orderId)).status).toBe('cancelled');

      for (const order of [partial, full]) {
        await db().query(MARK_SENT_SQL, [order.orderId]);
        expect(await emailsOf(db(), order.orderId)).toEqual([expect.objectContaining({ kind: 'refund', status: 'sent' })]);
        await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [order.orderId, 'refund', actor.id], {
          code: '22023', message: 'RESEND_NOT_ALLOWED',
        });
      }
    });

    test('返金の番号は、返金のお知らせと支払い済みのキャンセルのお知らせだけが持つ。自動の行は返金ごとに1行', async () => {
      const order = await createOrder(db(), { lines: [{ quantity: 1 }] });
      const first = await insertRefund(db(), order.orderId, { amount: 1000 });
      const second = await insertRefund(db(), order.orderId, { amount: 1000 });
      const enqueueSql = 'select private.enqueue_order_email($1::uuid, $2::text, $3::text, null::uuid, $4::uuid) as inserted';
      const enqueue = async (kind: string, variant: string | null, refundId: string | null) =>
        (await db().query(enqueueSql, [order.orderId, kind, variant, refundId])).rows[0].inserted as boolean;

      expect(await enqueue('refund', 'standard', first)).toBe(true);
      expect(await enqueue('refund', 'standard', first)).toBe(false);
      expect(await enqueue('refund', 'after_cancel', second)).toBe(true);
      expect(await enqueue('canceled', 'paid', first)).toBe(true);
      expect(await enqueue('canceled', 'paid', first)).toBe(false);

      const refundCheck = { code: '23514', constraint: 'order_email_outbox_refund_check' };
      const variantCheck = { code: '23514', constraint: 'order_email_outbox_variant_check' };
      await expectRejected(db(), enqueueSql, [order.orderId, 'paid', 'order_confirmed', first], refundCheck);
      await expectRejected(db(), enqueueSql, [order.orderId, 'canceled', 'pending', first], refundCheck);
      await expectRejected(db(), enqueueSql, [order.orderId, 'refund', 'standard', null], refundCheck);
      await expectRejected(db(), enqueueSql, [order.orderId, 'canceled', 'paid', null], refundCheck);
      await expectRejected(db(), enqueueSql, [order.orderId, 'refund', 'paid', first], variantCheck);
      await expectRejected(db(), enqueueSql, [order.orderId, 'refund', null, first], variantCheck);
      await expectRejected(db(), enqueueSql, [order.orderId, 'unknown', null, null], {
        code: '23514', constraint: 'order_email_outbox_kind_check',
      });
    });
  });

  describe('通し（返金を始める関数から結果まで）', () => {
    test('管理画面の全額の返金: 始める関数で返事待ちの記録を作り、成功を書くと、在庫が戻り、取消になり、返金のお知らせの予定が書かれる', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), { lines: [{ quantity: 2 }], shippingAmount: 500 });
      const began = await db().query(
        `select * from public.begin_order_refund(
           $1::uuid, 'admin', $2::uuid, $3::jsonb, true, 500, 10500, 'テスト', 'requested_by_customer', null, true, $4::uuid, null)`,
        [order.orderId, crypto.randomUUID(), JSON.stringify([{ order_item_id: order.itemIds[0], quantity: 2, before_shipment: true }]), actor.id],
      );
      expect(began.rows).toEqual([{ refund_id: expect.any(String), amount: 10500, status: 'awaiting_response', replayed: false }]);
      const refundId = began.rows[0].refund_id as string;

      const res = await record(db(), refundId, { status: 'succeeded' });

      expect(res).toMatchObject({
        status: 'succeeded', newly_accepted: true, order_status: 'cancelled', refunded_amount: 10500, email_enqueued: true,
      });
      expect(await movementsOf(db(), order.variantIds[0])).toEqual([
        { delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }, { delta: 2, reason: 'refund' },
      ]);
      expect(await emailsOf(db(), order.orderId)).toEqual([
        { kind: 'refund', variant: 'standard', origin: 'auto', status: 'pending', refund_id: refundId },
      ]);
      expect(await statusRevisions(db(), order.orderId)).toEqual([
        { from_status: 'paid', to_status: 'cancelled', reason: 'refund_projection', changed_by: actor.id },
      ]);
    });
  });

  describe('消した関数と権限', () => {
    test('前の返金の関数と、4つの引数の予定を書く関数は無く、同じ名前の関数は1つだけ', async () => {
      const res = await db().query(
        `select to_regprocedure('public.apply_order_refund_projection(uuid,public.order_status,integer,timestamptz,integer,timestamptz,timestamptz,uuid)') as old_projection,
                to_regprocedure('private.enqueue_order_email(uuid,text,text,uuid)') as old_enqueue`,
      );
      expect(res.rows[0]).toEqual({ old_projection: null, old_enqueue: null });

      // 同じ名前の関数が2つあると、Data API が呼び分けられない（PGRST203）
      for (const [schema, name] of [
        ['private', 'enqueue_order_email'],
        ['private', 'begin_order_refund_core'],
        ['public', 'begin_order_refund'],
        ['public', 'admin_receive_return'],
        ['public', 'admin_refund_return'],
        ['public', 'claim_order_email'],
        ['public', 'list_order_email_history'],
        ['public', 'request_order_email_resend'],
        ['public', 'record_order_refund_result'],
        ['public', 'record_external_order_refund'],
        ['public', 'mark_order_refund_error'],
        ['public', 'list_order_refund_summaries'],
        ['public', 'resolve_payment_exception_by_system'],
      ]) {
        const count = await db().query(
          `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = $1 and p.proname = $2`,
          [schema, name],
        );
        expect({ name, n: count.rows[0].n }).toEqual({ name, n: 1 });
      }
    });

    test.each([
      'public.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)',
      'public.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)',
      'public.mark_order_refund_error(uuid,text,boolean)',
      'public.list_order_refund_summaries(uuid[])',
      'public.resolve_payment_exception_by_system(uuid,text)',
      'public.claim_order_email(integer)',
      'public.list_order_email_history(uuid)',
      'public.request_order_email_resend(uuid,text,uuid,uuid)',
    ])('%s の実行権限は service_role だけにある', async (signature) => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const privilege = await db().query("select has_function_privilege($1::text, $2::text, 'EXECUTE') as allowed", [role, signature]);
        expect({ role, allowed: privilege.rows[0].allowed }).toEqual({ role, allowed: role === 'service_role' });
      }
    });

    test.each([
      'private.apply_order_refund_state(uuid)',
      'private.enqueue_order_email(uuid,text,text,uuid,uuid)',
      'private.order_cancelled_by_refund(uuid)',
      'private.refund_stripe_fields_valid(text,text,text,text,text,text,text)',
    ])('%s の実行権限は anon・authenticated・service_role のどれにも無い', async (signature) => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const privilege = await db().query("select has_function_privilege($1::text, $2::text, 'EXECUTE') as allowed", [role, signature]);
        expect({ role, allowed: privilege.rows[0].allowed }).toEqual({ role, allowed: false });
      }
    });

    test.each(['anon', 'authenticated'])('%s は結果を書く関数を呼べない', async (role) => {
      await db().query('savepoint denied');
      await db().query(`set local role ${role}`);
      await expect(db().query(RECORD_SQL, recordParams(crypto.randomUUID()))).rejects.toMatchObject({ code: '42501' });
      await db().query('rollback to savepoint denied');
    });
  });
});

describeLocalDb('integration: 返金の結果の同時の書き込み（Review Focus 3）', (db) => {
  let other: PgClient;

  beforeAll(async () => {
    other = await connectLocalDb();
  });

  afterAll(async () => {
    await other.end();
  });

  // 2つの接続を使うので、取引で包まず確定した行を残す（E-1 の「同時の発送」と同じ）。
  // 終わりの状態は成功・取消なので、返事待ち・保留の一覧には残らない。流し終えたら npx supabase db reset で作り直す
  test('窓口と知らせが同じ返金の結果を同時に書いても、在庫とメールの予定は1回だけ', async () => {
    const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
    const refundId = await insertRefund(db(), order.orderId, {
      amount: 5000, lines: [{ orderItemId: order.itemIds[0], quantity: 1, amount: 5000 }],
    });
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    const params = recordParams(refundId, { status: 'succeeded' });

    await db().query('begin');
    try {
      const first = (await db().query(RECORD_SQL, params)).rows[0];
      expect(first).toMatchObject({ newly_accepted: true, email_enqueued: true });
      // 後の書き込みは注文の行の鍵を待つ。待っている間に前の書き込みを確定させる
      const second = other.query(RECORD_SQL, params).then((res) => res.rows[0], (error: unknown) => error);
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await second).toMatchObject({ status: 'succeeded', newly_accepted: false, email_enqueued: false, exception_id: null });
    } catch (error) {
      await db().query('rollback');
      throw error;
    }

    expect(await movementsOf(db(), order.variantIds[0])).toEqual([
      { delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }, { delta: 1, reason: 'refund' },
    ]);
    expect(await emailsOf(db(), order.orderId)).toHaveLength(1);
  });

  test('Stripe の画面からの全額の返金と発送が同時に来ると、注文の行の鍵で1つずつ進み、後の発送は断られる', async () => {
    const actor = await createActor(db());
    const order = await createOrder(db(), { lines: [{ quantity: 2 }] });
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;

    await db().query('begin');
    try {
      expect(await recordExternal(db(), order.orderId, { amount: order.total })).toMatchObject({ order_status: 'cancelled' });
      const shipped = ship(other, order.orderId, actor.id, [{ itemId: order.itemIds[0], quantity: 1 }])
        .then(() => null, (error: unknown) => error);
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await shipped).toMatchObject({ code: '22023', message: 'ORDER_NOT_SHIPPABLE' });
    } catch (error) {
      await db().query('rollback');
      throw error;
    }

    const count = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [order.orderId]);
    expect(count.rows[0].n).toBe(0);
  });
});

describeLocalDb('E-3: 返品のメールも既存のリースと履歴で扱う',db=>{
  beforeEach(async()=>{await db().query('begin');await db().query('delete from private.order_email_outbox');});
  afterEach(async()=>{await db().query('rollback');});
  test.each(['return_accepted','return_received','return_sent_back','return_refund_pending_shop'])('%s の参照列を返し、手の再送を断り、superseded の条件を守る',async kind=>{
    const actor=await createActor(db());const order=await createOrder(db(),{lines:[{quantity:1}]});
    const ret=(await db().query(`insert into public.order_returns(order_id,number,source,status,request_key,request_fingerprint,
      return_method,return_shipping_payer,notify_customer,approved_at,approved_by,created_by)
      values($1,1,'shop','open',gen_random_uuid(),'fixture','customer_ships','customer',false,now(),$2,$2) returning id`,[order.orderId,actor.id])).rows[0].id;
    const receipt=kind==='return_accepted'?null:(await db().query(`insert into public.order_return_receipts(return_id,request_key,request_fingerprint,kind,refund_choice,actor_id,actor_can_refund)
      values($1,gen_random_uuid(),'fixture','receive','consult',$2,false) returning id`,[ret,actor.id])).rows[0].id;
    expect((await db().query('select private.enqueue_return_email($1,$2,$3,$4) enqueued',[order.orderId,kind,ret,receipt])).rows[0].enqueued).toBe(true);
    expect((await db().query('select private.enqueue_return_email($1,$2,$3,$4) enqueued',[order.orderId,kind,ret,receipt])).rows[0].enqueued).toBe(false);
    const claim=(await db().query('select * from public.claim_order_email(300)')).rows[0];
    expect(claim).toMatchObject({order_id:order.orderId,kind,return_id:ret,return_receipt_id:receipt,refund_id:null,fulfillment_id:null});
    expect(Object.keys(claim).slice(-4)).toEqual(['refund_id','return_id','return_receipt_id','cancel_request_id']);
    const history=(await db().query('select * from public.list_order_email_history($1)',[order.orderId])).rows[0];
    expect(history).toMatchObject({kind,return_id:ret,return_receipt_id:receipt});
    expect(Object.keys(history).slice(-3)).toEqual(['refund_id','return_id','return_receipt_id']);
    await expectRejected(db(),'select public.request_order_email_resend($1,$2,$3)',[order.orderId,kind,actor.id],{code:'22023',message:'RESEND_NOT_ALLOWED'});
    if(kind==='return_refund_pending_shop') {
      // この参照列の試験は返品の行が無いので返金待ちは0。店への知らせだけ取りやめられる（06-5）。
      expect((await db().query("select public.skip_order_email($1,$2,'superseded') skipped",[claim.email_id,claim.lease_token])).rows[0].skipped).toBe(true);
    } else {
      await expectRejected(db(),"select public.skip_order_email($1,$2,'superseded')",[claim.email_id,claim.lease_token],{code:'22023',message:'SUPERSEDE_NOT_ALLOWED'});
      expect((await db().query("select public.skip_order_email($1,$2,'no_recipient') skipped",[claim.email_id,claim.lease_token])).rows[0].skipped).toBe(true);
    }
  });
});
