/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, movementsOf, revisionsOf, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 返金を始める関数・返金の読み出しの関数・ショップの設定の関数（グループ E-2 設計書 3・4・5・9・11 章、移行 B）。
 * 返金は Stripe に頼む前の「返事待ち」の記録までを作る。結果を書く関数（在庫・メールの予定・要対応・注文の額と状態）は移行 C なので、
 * 試験では記録の状態を直接進める。1件ごとに取引の中で動かし、終わったら戻す。
 * 返金と発送の同時の操作だけは2つの接続が要るので、別の describe で確定した行を使う（消せない注文が手元の DB に残る）。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

async function createActor(db: PgClient): Promise<{ id: string; email: string }> {
  const email = `refund-request-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

type LineSpec = {
  quantity: number;
  price: number;
  fulfillmentType: 'stock' | 'backorder';
  /** 在庫の品で、台帳に確保（purchase）を入れるか。既定は入れる。入れない注文は「確保の記録が無い古い商品」（R-41）を再現する */
  reserved?: boolean;
};

type TestOrder = { orderId: string; itemIds: string[]; variantIds: number[]; paymentIntentId: string | null };

/**
 * 返金の試験の注文を直接作る。注文の金額の列は後から書き換えられないので、送料・割引・受け取った額は作る時に決める。
 * 割引の割り振りの「最後の商品」は商品の登録順で決まる。同じ取引の中では created_at が同じになるので、明細ごとに1秒ずつずらして固定する
 */
async function createOrder(
  db: PgClient,
  options: {
    lines: LineSpec[];
    status?: string;
    shippingAmount?: number;
    discountAmount?: number;
    /** 受け取った額。省くと注文の合計。null なら空（入金をまだ記録していない注文） */
    paidAmount?: number | null;
    /** true なら支払いの番号（pi_fx_…）を付ける。番号そのものを決めたい時は paymentIntentId */
    withPaymentIntent?: boolean;
    paymentIntentId?: string | null;
  },
): Promise<TestOrder> {
  const suffix = uniqueSuffix();
  const shippingAmount = options.shippingAmount ?? 0;
  const discountAmount = options.discountAmount ?? 0;
  const subtotal = options.lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const total = subtotal + shippingAmount - discountAmount;
  const paymentIntentId = options.paymentIntentId ?? (options.withPaymentIntent ? `pi_fx_${suffix}` : null);
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status,
        subtotal_amount, shipping_amount, discount_amount, total_amount, paid_amount, currency,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone)
     values ($1, $2, $3, $4::public.order_status, $5, $6, $7, $8, $9, 'jpy',
             'fixture@example.com', '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222')
     returning id`,
    [
      `fx-order-${suffix}`,
      `cs_fx_${suffix}`,
      paymentIntentId,
      options.status ?? 'paid',
      subtotal,
      shippingAmount,
      discountAmount,
      total,
      options.paidAmount === undefined ? total : options.paidAmount,
    ],
  );
  const orderId = order.rows[0].id as string;
  const itemIds: string[] = [];
  const variantIds: number[] = [];
  const base = Date.now();
  for (const [index, line] of options.lines.entries()) {
    const fx = await createCatalogFixture(db, { stock: line.fulfillmentType === 'stock' ? line.quantity : 0 });
    const inserted = await db.query(
      `insert into public.order_items
         (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type, created_at)
       values ($1, $2, $3, $4, 'BLACK', 'M', $5, $6, $7, $8, $9::timestamptz)
       returning id`,
      [
        orderId,
        fx.itemId,
        `商品${index + 1}`,
        line.price,
        line.quantity,
        line.price * line.quantity,
        fx.variantId,
        line.fulfillmentType,
        new Date(base + index * 1000).toISOString(),
      ],
    );
    const itemId = inserted.rows[0].id as string;
    itemIds.push(itemId);
    variantIds.push(fx.variantId);
    if (line.fulfillmentType === 'stock' && (line.reserved ?? true)) {
      await db.query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
         values ($1, $2, 'purchase', $3, $4)`,
        [fx.variantId, -line.quantity, orderId, itemId],
      );
    }
  }
  return { orderId, itemIds, variantIds, paymentIntentId };
}

/** 割り振りの試験の値 A（Task 1・Task 4 と同じ）: X（3000×2・在庫）と Y（1000×3・受注生産）、割引 1000、送料 500。合計 8500。Dx = 667、Dy = 333 */
function createValueAOrder(db: PgClient, options: { paidAmount?: number | null } = {}): Promise<TestOrder> {
  return createOrder(db, {
    lines: [
      { quantity: 2, price: 3000, fulfillmentType: 'stock' },
      { quantity: 3, price: 1000, fulfillmentType: 'backorder' },
    ],
    shippingAmount: 500,
    discountAmount: 1000,
    paidAmount: options.paidAmount,
    withPaymentIntent: true,
  });
}

type BeginInput = {
  source?: string | null;
  /** 省くと新しい番号。null なら SQL の NULL */
  requestKey?: string | null;
  lines?: unknown;
  restock?: boolean | null;
  shipping?: number | null;
  amount?: number | null;
  note?: string | null;
  stripeReason?: string | null;
  cancelReason?: string | null;
  notify?: boolean | null;
  actorId?: string | null;
  receivedAmount?: number | null;
};

const BEGIN_SQL = 'select * from public.begin_order_refund($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)';

/** 省いた引数は、管理画面の返金（ア）の普通の呼び方になる。null を渡すと SQL の NULL を渡す */
function beginParams(orderId: string | null, input: BeginInput): unknown[] {
  return [
    orderId,
    input.source === undefined ? 'admin' : input.source,
    input.requestKey === undefined ? crypto.randomUUID() : input.requestKey,
    JSON.stringify(input.lines === undefined ? [] : input.lines),
    input.restock === undefined ? true : input.restock,
    input.shipping === undefined ? 0 : input.shipping,
    input.amount === undefined ? 0 : input.amount,
    input.note === undefined ? null : input.note,
    input.stripeReason === undefined ? null : input.stripeReason,
    input.cancelReason === undefined ? null : input.cancelReason,
    input.notify === undefined ? true : input.notify,
    input.actorId === undefined ? null : input.actorId,
    input.receivedAmount === undefined ? null : input.receivedAmount,
  ];
}

function beginRefund(db: PgClient, orderId: string | null, input: BeginInput) {
  return db.query(BEGIN_SQL, beginParams(orderId, input));
}

const refundBefore = (orderItemId: string, quantity: number) => ({ order_item_id: orderItemId, quantity, before_shipment: true });
const refundAfter = (orderItemId: string, quantity: number) => ({ order_item_id: orderItemId, quantity, before_shipment: false });

async function refundRow(db: PgClient, refundId: string): Promise<Row> {
  const res = await db.query(
    `select order_id, source, request_key, request_fingerprint, status, stripe_refund_id, payment_method_type, amount,
            shipping_amount, adjustment_amount, note, stripe_reason, cancel_reason, notify_customer, actor_id
     from public.order_refunds where id = $1`,
    [refundId],
  );
  return res.rows[0];
}

/** 返金の商品の行を「商品の番号:before|after」で引ける形にする（行の並びは商品の番号の順で、試験では決まらない） */
async function refundLines(db: PgClient, refundId: string): Promise<Record<string, Row>> {
  const res = await db.query(
    `select order_item_id, quantity, before_shipment, restock_type, amount, released_quantity, restocked_quantity,
            rereserved_quantity, rereserve_shortage
     from public.order_refund_lines where refund_id = $1`,
    [refundId],
  );
  return Object.fromEntries(res.rows.map((row) => [`${row.order_item_id}:${row.before_shipment ? 'before' : 'after'}`, row]));
}

async function countRefunds(db: PgClient, orderId: string): Promise<number> {
  const res = await db.query('select count(*)::int as n from public.order_refunds where order_id = $1', [orderId]);
  return res.rows[0].n as number;
}

const SETTLE_SQL = {
  pending: "status = 'pending', stripe_status = 'pending', accepted_at = now()",
  succeeded: "status = 'succeeded', stripe_status = 'succeeded', accepted_at = now(), succeeded_at = now()",
  error: "status = 'error', stripe_failure_reason = 'stripe_rejected', errored_at = now()",
};

/** Stripe の返事を書く関数（移行 C）はまだ無いので、返事待ちの記録の状態を直接進める（表の守りが許す移り方だけ） */
async function settle(db: PgClient, refundId: string, to: keyof typeof SETTLE_SQL): Promise<void> {
  await db.query(`update public.order_refunds set ${SETTLE_SQL[to]} where id = $1`, [refundId]);
}

/** 返金の記録を、作った時刻を決めて直接書く（begin_order_refund は今の時刻でしか作れない） */
async function insertRefundRow(
  db: PgClient,
  orderId: string,
  options: { status: 'awaiting_response' | 'error' | 'pending' | 'succeeded' | 'failed'; minutesAgo: number },
): Promise<string> {
  const res = await db.query(
    `insert into public.order_refunds
       (order_id, source, request_key, request_fingerprint, status, amount, notify_customer, created_at)
     values ($1, 'admin', gen_random_uuid(), 'fixture', $2, 100, true, now() - make_interval(mins => $3::int))
     returning id`,
    [orderId, options.status, options.minutesAgo],
  );
  return res.rows[0].id as string;
}

function ship(db: PgClient, orderId: string, actorId: string, lines: unknown) {
  return db.query('select * from public.admin_create_fulfillment($1, $2, $3, $4, $5, $6, $7::jsonb)', [
    orderId, actorId, crypto.randomUUID(), 'yamato', '1234-5678-9012', false, JSON.stringify(lines),
  ]);
}

function recordCompletion(db: PgClient, orderId: string, actorId: string, lines: unknown) {
  return db.query('select * from public.admin_record_completion($1, $2, $3, $4::jsonb)', [
    orderId, actorId, crypto.randomUUID(), JSON.stringify(lines),
  ]);
}

async function lineCounts(db: PgClient, orderId: string): Promise<Record<string, Row>> {
  const res = await db.query('select * from private.order_line_fulfillment($1)', [orderId]);
  return Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row]));
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

/** 失敗した文の SQLSTATE と言葉を返す（成功したら null）。表の試験で、どの入力が外れたかを名前で見せるために使う */
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

/** 新しい public の関数。service_role だけが実行できる（anon・authenticated・PUBLIC からは外す） */
const SERVICE_ONLY_FUNCTIONS = [
  'public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)',
  'public.get_order_refund(uuid)',
  'public.load_order_refund_materials(uuid)',
  'public.list_order_refunds(uuid)',
  'public.list_awaiting_order_refunds(timestamptz,integer)',
  'public.list_pending_refund_payment_intents(integer)',
  'public.get_shop_settings()',
  'public.admin_update_shop_settings(boolean,boolean,uuid)',
  'public.record_cancelled_order_paid_amount(uuid,text,integer)',
  'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
];

describeLocalDb('integration: 返金を始める関数と読み出しの関数（移行 B）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('管理画面の返金（ア）', () => {
    test('商品と数を選ぶと、返事待ちの記録と商品の行ができ、額は割引を割り振った値になる（値 A）', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      const key = crypto.randomUUID();

      const res = await beginRefund(db(), order.orderId, {
        requestKey: key,
        actorId: actor.id,
        lines: [refundBefore(x, 1), refundBefore(y, 2)],
        restock: true,
        amount: 4444,
        note: 'お客様の希望',
        stripeReason: 'requested_by_customer',
      });

      expect(res.rows).toEqual([{ refund_id: expect.any(String), amount: 4444, status: 'awaiting_response', replayed: false }]);
      const refundId = res.rows[0].refund_id as string;
      // 始めただけでは Stripe に頼んでいない: 返金の番号も支払いの種類も空
      expect(await refundRow(db(), refundId)).toMatchObject({
        order_id: order.orderId,
        source: 'admin',
        request_key: key,
        status: 'awaiting_response',
        stripe_refund_id: null,
        payment_method_type: null,
        amount: 4444,
        shipping_amount: 0,
        adjustment_amount: 0,
        note: 'お客様の希望',
        stripe_reason: 'requested_by_customer',
        cancel_reason: null,
        notify_customer: true,
        actor_id: actor.id,
      });
      // X: disc(1) = floor((2·667·1 + 2) / 4) = 334 → 3000 − 334 = 2666。Y: disc(2) = floor((2·333·2 + 3) / 6) = 222 → 2000 − 222 = 1778
      const lines = await refundLines(db(), refundId);
      expect(Object.keys(lines).sort()).toEqual([`${x}:before`, `${y}:before`].sort());
      expect(lines[`${x}:before`]).toMatchObject({ quantity: 1, restock_type: 'cancel', amount: 2666, released_quantity: 0, restocked_quantity: 0 });
      expect(lines[`${y}:before`]).toMatchObject({ quantity: 2, restock_type: 'no_restock', amount: 1778 });
    });

    test('2回に分けて返すと、商品ごとの額の合計が小計から割り振った割引を引いた額とぴったり合う（値 A）', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      const first = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundBefore(x, 1), refundBefore(y, 2)], amount: 4444,
      });
      await settle(db(), first.rows[0].refund_id, 'pending');

      // 残りの未発送を全部入れる最後の返金は、送料の全部（500）と返せる額の全部（8500 − 4444 = 4056）を返す
      const second = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundBefore(x, 1), refundBefore(y, 1)], restock: false, shipping: 500, amount: 4056,
      });

      const secondId = second.rows[0].refund_id as string;
      expect(second.rows[0]).toMatchObject({ amount: 4056, status: 'awaiting_response', replayed: false });
      expect(await refundRow(db(), secondId)).toMatchObject({ shipping_amount: 500, adjustment_amount: 0 });
      // X は前に1点返したので 3000 − (667 − 334) = 2667、Y は前に2点返したので 1000 − (333 − 222) = 889
      const lines = await refundLines(db(), secondId);
      expect(lines[`${x}:before`]).toMatchObject({ amount: 2667, restock_type: 'no_restock' });
      expect(lines[`${y}:before`]).toMatchObject({ amount: 889 });
      const totals = await db().query(
        `select l.order_item_id, sum(l.amount)::int as total
         from public.order_refund_lines as l join public.order_refunds as r on r.id = l.refund_id
         where r.order_id = $1 group by l.order_item_id`,
        [order.orderId],
      );
      expect(Object.fromEntries(totals.rows.map((row) => [row.order_item_id, row.total]))).toEqual({
        [x]: 6000 - 667, // 2666 + 2667
        [y]: 3000 - 333, // 1778 + 889
      });
    });

    test('1点ずつ3回に分けて返すと、割引の1円は2回目の返金に付き、合計は小計から1円引いた額になる（値 C）', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), {
        lines: [{ quantity: 3, price: 1000, fulfillmentType: 'stock' }],
        discountAmount: 1,
      });
      const [item] = order.itemIds;

      // disc(n) = floor((2·1·n + 3) / 6): disc(1) = 0、disc(2) = 1、disc(3) = 1。最後の返金は残りの未発送を全部入れるので、返せる額の全部（1000）
      const amounts: number[] = [];
      for (const amount of [1000, 999, 1000]) {
        const res = await beginRefund(db(), order.orderId, { actorId: actor.id, lines: [refundBefore(item, 1)], amount });
        const refundId = res.rows[0].refund_id as string;
        amounts.push((await refundLines(db(), refundId))[`${item}:before`].amount);
        expect((await refundRow(db(), refundId)).adjustment_amount).toBe(0);
        await settle(db(), refundId, 'pending');
      }

      expect(amounts).toEqual([1000, 999, 1000]);
      expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(3000 - 1);
    });

    test('額を手で直すと、計算との差（返金額 − 商品の額の合計 − 送料）が正負どちらでも記録に残る', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;

      // X 1点 2666 + 送料 500 = 3166 を 3000 に下げる → −166
      const lower = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundBefore(x, 1)], shipping: 500, amount: 3000,
      });
      expect(await refundRow(db(), lower.rows[0].refund_id)).toMatchObject({ amount: 3000, shipping_amount: 500, adjustment_amount: -166 });
      await settle(db(), lower.rows[0].refund_id, 'error');

      // Y 1点 1000 − 111 = 889 を 1000 に上げる → +111
      const higher = await beginRefund(db(), order.orderId, { actorId: actor.id, lines: [refundBefore(y, 1)], amount: 1000 });
      expect(await refundRow(db(), higher.rows[0].refund_id)).toMatchObject({ amount: 1000, shipping_amount: 0, adjustment_amount: 111 });

      // 行の無い返金（額だけ）は、返金額そのものが計算との差になる
      await settle(db(), higher.rows[0].refund_id, 'error');
      const amountOnly = await beginRefund(db(), order.orderId, { actorId: actor.id, amount: 700 });
      expect(await refundRow(db(), amountOnly.rows[0].refund_id)).toMatchObject({ amount: 700, adjustment_amount: 700 });
      expect(Object.keys(await refundLines(db(), amountOnly.rows[0].refund_id))).toEqual([]);
    });

    test('同じ商品の発送前と発送後を1つの返金に入れると、発送前の行を先に数える（値 A: X の発送前 1点が 2666、発送後 1点が 2667）', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x] = order.itemIds;
      await ship(db(), order.orderId, actor.id, [{ order_item_id: x, quantity: 1 }]);

      // 入力では発送後の行を先に渡す。数える順は入力の並びに依らず、発送前の行の b = 0、発送後の行の b = 0 + 1
      const res = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundAfter(x, 1), refundBefore(x, 1)], amount: 5333,
      });

      const refundId = res.rows[0].refund_id as string;
      const lines = await refundLines(db(), refundId);
      expect(lines[`${x}:before`]).toMatchObject({ quantity: 1, restock_type: 'cancel', amount: 2666 });
      expect(lines[`${x}:after`]).toMatchObject({ quantity: 1, restock_type: 'no_restock', amount: 2667 });
      expect(await refundRow(db(), refundId)).toMatchObject({ amount: 5333, adjustment_amount: 0 });
    });

    test('前に返した数がある商品でも、発送前の行の b は前に返した数、発送後の行の b は前に返した数 + 発送前の行の数（値 C）', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), {
        lines: [{ quantity: 3, price: 1000, fulfillmentType: 'stock' }],
        discountAmount: 1,
      });
      const [item] = order.itemIds;
      // 1回目: 発送前に1点（b = 0 → 1000）。そのあと1点を発送する
      const first = await beginRefund(db(), order.orderId, { actorId: actor.id, lines: [refundBefore(item, 1)], amount: 1000 });
      await settle(db(), first.rows[0].refund_id, 'pending');
      await ship(db(), order.orderId, actor.id, [{ order_item_id: item, quantity: 1 }]);

      // 2回目: 発送前 1点 + 発送後 1点。disc(1) = 0、disc(2) = 1、disc(3) = 1
      //   発送前の行の b = 1 → 1000 − (disc(2) − disc(1)) = 999
      //   発送後の行の b = 1 + 1 = 2 → 1000 − (disc(3) − disc(2)) = 1000（前の返金の数だけでは 999 になってしまう）
      const second = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundAfter(item, 1), refundBefore(item, 1)], amount: 1999,
      });

      const secondId = second.rows[0].refund_id as string;
      const lines = await refundLines(db(), secondId);
      expect(lines[`${item}:before`]).toMatchObject({ quantity: 1, amount: 999 });
      expect(lines[`${item}:after`]).toMatchObject({ quantity: 1, amount: 1000 });
      expect(await refundRow(db(), secondId)).toMatchObject({ amount: 1999, adjustment_amount: 0 });
      // 2回の返金の商品の額の合計は、小計から割引を引いた額（3000 − 1）
      const total = await db().query(
        `select sum(l.amount)::int as total
         from public.order_refund_lines as l join public.order_refunds as r on r.id = l.refund_id
         where r.order_id = $1`,
        [order.orderId],
      );
      expect(total.rows[0].total).toBe(3000 - 1);
    });

    test('発送後の商品の返金は発送後の行になり、在庫には戻さない。返せる数は発送した数から返した数を引いた数', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      await recordCompletion(db(), order.orderId, actor.id, [{ order_item_id: y, quantity: 3 }]);
      await ship(db(), order.orderId, actor.id, [{ order_item_id: x, quantity: 2 }, { order_item_id: y, quantity: 3 }]);

      const first = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundAfter(x, 1)], restock: true, amount: 2666,
      });

      const firstId = first.rows[0].refund_id as string;
      const lines = await refundLines(db(), firstId);
      expect(Object.keys(lines)).toEqual([`${x}:after`]);
      expect(lines[`${x}:after`]).toMatchObject({ quantity: 1, before_shipment: false, restock_type: 'no_restock', amount: 2666 });
      expect(await refundRow(db(), firstId)).toMatchObject({ adjustment_amount: 0 });

      // 発送した2点のうち1点は返金の途中。発送後の返金は未発送の数を変えない
      await settle(db(), firstId, 'pending');
      expect((await lineCounts(db(), order.orderId))[x]).toMatchObject({
        shipped: 2, unshipped: 0, refunded_before_shipment: 0, refunded_after_shipment: 1,
      });
      await expectRejected(
        db(),
        BEGIN_SQL,
        beginParams(order.orderId, { actorId: actor.id, lines: [refundAfter(x, 2)], amount: 5000 }),
        { code: '22023', message: 'REFUND_QUANTITY_EXCEEDS_SHIPPED' },
      );
      // 残りの1点は前に1点返したので 3000 − (667 − 334) = 2667
      const second = await beginRefund(db(), order.orderId, { actorId: actor.id, lines: [refundAfter(x, 1)], amount: 2667 });
      expect((await refundLines(db(), second.rows[0].refund_id))[`${x}:after`]).toMatchObject({ amount: 2667 });
    });

    test('記録を作っても、在庫の台帳・注文の状態・返金済みの額は動かさない（動かすのは Stripe が受け付けた後）', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x] = order.itemIds;
      const readOrder = async () =>
        (
          await db().query(
            'select status::text as status, refunded_amount, refunded_at, paid_amount from public.orders where id = $1',
            [order.orderId],
          )
        ).rows;
      const stockBefore = await movementsOf(db(), order.variantIds[0]);
      const orderBefore = await readOrder();

      await beginRefund(db(), order.orderId, { actorId: actor.id, lines: [refundBefore(x, 2)], amount: 5333 });

      expect(await movementsOf(db(), order.variantIds[0])).toEqual(stockBefore);
      expect(await readOrder()).toEqual(orderBefore);
    });

    test('同じ番号・同じ中身の送り直しは前の記録を返し、記録は増えない（Review Focus 1）', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      const input = {
        requestKey: crypto.randomUUID(), actorId: actor.id, lines: [refundBefore(x, 1), refundBefore(y, 2)], amount: 4444,
      };

      const first = await beginRefund(db(), order.orderId, input);
      // 行の並びが違っても同じ中身
      const again = await beginRefund(db(), order.orderId, { ...input, lines: [refundBefore(y, 2), refundBefore(x, 1)] });

      const refundId = first.rows[0].refund_id as string;
      expect(again.rows).toEqual([{ refund_id: refundId, amount: 4444, status: 'awaiting_response', replayed: true }]);
      expect(await countRefunds(db(), order.orderId)).toBe(1);
      expect(Object.keys(await refundLines(db(), refundId))).toHaveLength(2);

      // Stripe が受け付けた後の送り直しも、新しい記録を作らず、今の状態を返す
      await settle(db(), refundId, 'pending');
      const later = await beginRefund(db(), order.orderId, input);
      expect(later.rows).toEqual([{ refund_id: refundId, amount: 4444, status: 'pending', replayed: true }]);
      expect(await countRefunds(db(), order.orderId)).toBe(1);
    });

    test('同じ番号で中身が違えば REFUND_REQUEST_MISMATCH', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const other = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      const base = {
        requestKey: crypto.randomUUID(),
        actorId: actor.id,
        lines: [refundBefore(x, 1), refundBefore(y, 2)],
        amount: 4444,
        note: 'メモ',
        stripeReason: 'requested_by_customer',
      };
      await beginRefund(db(), order.orderId, base);

      const changed: Array<[string, string, BeginInput]> = [
        ['額', order.orderId, { ...base, amount: 4443 }],
        ['メモ', order.orderId, { ...base, note: '別のメモ' }],
        ['在庫に戻すか', order.orderId, { ...base, restock: false }],
        ['お客様に知らせるか', order.orderId, { ...base, notify: false }],
        ['Stripe に伝える理由', order.orderId, { ...base, stripeReason: 'duplicate' }],
        ['送料', order.orderId, { ...base, shipping: 100 }],
        ['行の数', order.orderId, { ...base, lines: [refundBefore(x, 1), refundBefore(y, 1)] }],
        ['別の注文', other.orderId, { ...base, lines: [refundBefore(other.itemIds[0], 1), refundBefore(other.itemIds[1], 2)] }],
      ];
      for (const [label, orderId, input] of changed) {
        expect({ label, rejection: await rejectionOf(db(), BEGIN_SQL, beginParams(orderId, input)) }).toEqual({
          label,
          rejection: { code: '22023', message: 'REFUND_REQUEST_MISMATCH' },
        });
      }
    });

    test('返事待ちの返金がある注文には別の返金を作れない。エラーの返金は数えない', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      const first = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundBefore(x, 1), refundBefore(y, 2)], amount: 4444,
      });
      const next = { actorId: actor.id, lines: [refundBefore(y, 1)], amount: 889 };

      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, next), { code: '22023', message: 'AWAITING_REFUND_EXISTS' });

      // Stripe に断られて「エラー」になれば、数えない（お金は動いていない）ので、同じ数でもう一度作れる
      await settle(db(), first.rows[0].refund_id, 'error');
      const accepted = await beginRefund(db(), order.orderId, next);
      expect(accepted.rows[0]).toMatchObject({ amount: 889, status: 'awaiting_response', replayed: false });
    });

    test('全額になるのに未発送の商品が残る返金は断る（REFUND_MUST_INCLUDE_UNSHIPPED。設計書 7-4）', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      const full = { actorId: actor.id, shipping: 500, amount: 8500 };

      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { ...full, lines: [refundBefore(x, 2)] }), {
        code: '22023', message: 'REFUND_MUST_INCLUDE_UNSHIPPED',
      });
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { ...full, lines: [] }), {
        code: '22023', message: 'REFUND_MUST_INCLUDE_UNSHIPPED',
      });

      // 一部を発送した注文でも同じ。残りの未発送を全部入れれば通り、足りない額は計算との差になる
      await ship(db(), order.orderId, actor.id, [{ order_item_id: x, quantity: 2 }]);
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { ...full, lines: [refundBefore(y, 2)] }), {
        code: '22023', message: 'REFUND_MUST_INCLUDE_UNSHIPPED',
      });
      const accepted = await beginRefund(db(), order.orderId, { ...full, lines: [refundBefore(y, 3)] });
      // Y 3点 = 3000 − 333 = 2667、送料 500 → 計算 3167、返金額 8500 → 差 5333
      expect(await refundRow(db(), accepted.rows[0].refund_id)).toMatchObject({ amount: 8500, adjustment_amount: 5333 });
    });

    test('1つも発送していない注文で残りの商品を全部返すのに、送料か額が全部でなければ断る（REFUND_MUST_BE_FULL。設計書 5-1）', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      const everything = [refundBefore(x, 2), refundBefore(y, 3)];

      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { actorId: actor.id, lines: everything, shipping: 500, amount: 8000 }), {
        code: '22023', message: 'REFUND_MUST_BE_FULL',
      });
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { actorId: actor.id, lines: everything, shipping: 0, amount: 8500 }), {
        code: '22023', message: 'REFUND_MUST_BE_FULL',
      });
      const full = await beginRefund(db(), order.orderId, { actorId: actor.id, lines: everything, shipping: 500, amount: 8500 });
      expect(await refundRow(db(), full.rows[0].refund_id)).toMatchObject({ amount: 8500, shipping_amount: 500, adjustment_amount: 0 });
      // X: 6000 − 667 = 5333、Y: 3000 − 333 = 2667
      const lines = await refundLines(db(), full.rows[0].refund_id);
      expect(lines[`${x}:before`]).toMatchObject({ quantity: 2, amount: 5333 });
      expect(lines[`${y}:before`]).toMatchObject({ quantity: 3, amount: 2667 });

      // 一部でも発送していれば、残りを全部返しても額は選べる
      const shipped = await createValueAOrder(db());
      await ship(db(), shipped.orderId, actor.id, [{ order_item_id: shipped.itemIds[0], quantity: 2 }]);
      await expect(
        beginRefund(db(), shipped.orderId, { actorId: actor.id, lines: [refundBefore(shipped.itemIds[1], 3)], amount: 1000 }),
      ).resolves.toBeTruthy();
    });

    test('前の返金で額を手で増やし、返せる額が返せる送料より小さくなった注文でも、残りを全部返せる（送料は返せる額まで）', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      // 商品を選ばず、額だけ 8200 を返す。返せる額は 300、返せる送料は 500 のままで、返せる額 < 返せる送料
      const earlier = await beginRefund(db(), order.orderId, { actorId: actor.id, amount: 8200 });
      await settle(db(), earlier.rows[0].refund_id, 'pending');
      const rest = [refundBefore(x, 2), refundBefore(y, 3)];

      // 送料が min(返せる送料 500, 返せる額 300) = 300 でなければ断る。500 は「送料 ≤ 額」に当たる
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { actorId: actor.id, lines: rest, shipping: 0, amount: 300 }), {
        code: '22023', message: 'REFUND_MUST_BE_FULL',
      });
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { actorId: actor.id, lines: rest, shipping: 200, amount: 300 }), {
        code: '22023', message: 'REFUND_MUST_BE_FULL',
      });
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { actorId: actor.id, lines: rest, shipping: 500, amount: 300 }), {
        code: '22023', message: 'REFUND_ARGUMENT_INVALID',
      });

      const full = await beginRefund(db(), order.orderId, { actorId: actor.id, lines: rest, shipping: 300, amount: 300 });

      // 商品 5333 + 2667 + 送料 300 = 8300 に対して、返金額は返せる額の 300 → 計算との差 −8000
      expect(await refundRow(db(), full.rows[0].refund_id)).toMatchObject({ amount: 300, shipping_amount: 300, adjustment_amount: -8000 });
    });

    test('取り消した注文（取消の後の入金）にアで全額を返す時も、未発送を全部選ぶ決まりが効く。確保は戻し済みで、記録を作るだけでは在庫を動かさない（P28）', async () => {
      const actor = await createActor(db());
      // 取消の時に確保は戻し済み（台帳に確保の行が無い）。取消の後に 8500 の入金が届き、受け取った額が書いてある
      const order = await createOrder(db(), {
        status: 'cancelled',
        lines: [
          { quantity: 2, price: 3000, fulfillmentType: 'stock', reserved: false },
          { quantity: 3, price: 1000, fulfillmentType: 'backorder' },
        ],
        shippingAmount: 500,
        discountAmount: 1000,
        withPaymentIntent: true,
      });
      const [x, y] = order.itemIds;
      const everything = [refundBefore(x, 2), refundBefore(y, 3)];
      const stockBefore = await movementsOf(db(), order.variantIds[0]);

      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { actorId: actor.id, shipping: 500, amount: 8500 }), {
        code: '22023', message: 'REFUND_MUST_INCLUDE_UNSHIPPED',
      });
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { actorId: actor.id, lines: everything, shipping: 500, amount: 8000 }), {
        code: '22023', message: 'REFUND_MUST_BE_FULL',
      });
      const full = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: everything, restock: true, shipping: 500, amount: 8500,
      });

      const refundId = full.rows[0].refund_id as string;
      expect(full.rows[0]).toMatchObject({ amount: 8500, status: 'awaiting_response' });
      const lines = await refundLines(db(), refundId);
      expect(lines[`${x}:before`]).toMatchObject({ quantity: 2, restock_type: 'cancel', amount: 5333, released_quantity: 0, restocked_quantity: 0 });
      expect(lines[`${y}:before`]).toMatchObject({ quantity: 3, restock_type: 'no_restock', amount: 2667 });
      // 記録を作るだけでは台帳に何も書かない（書くのは Stripe が受け付けた後の移行 C の関数。確保が無いので、書いても動かない）
      expect(await movementsOf(db(), order.variantIds[0])).toEqual(stockBefore);
      const written = await db().query('select count(*)::int as n from public.stock_movements where order_id = $1', [order.orderId]);
      expect(written.rows[0].n).toBe(0);
    });
  });

  describe('支払い済みの注文のキャンセル（イ）', () => {
    test('残りの未発送の商品を全部、送料と返せる額の全部で返す。呼ぶ側の送料と額は使わない', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;

      const res = await beginRefund(db(), order.orderId, {
        source: 'order_cancel',
        actorId: actor.id,
        lines: [],
        restock: true,
        shipping: 999,
        amount: 1,
        note: 'ご依頼',
        cancelReason: 'customer_request',
        notify: true,
      });

      expect(res.rows).toEqual([{ refund_id: expect.any(String), amount: 8500, status: 'awaiting_response', replayed: false }]);
      const refundId = res.rows[0].refund_id as string;
      expect(await refundRow(db(), refundId)).toMatchObject({
        source: 'order_cancel',
        amount: 8500,
        shipping_amount: 500,
        adjustment_amount: 0,
        note: 'ご依頼',
        cancel_reason: 'customer_request',
        stripe_reason: null,
        notify_customer: true,
        actor_id: actor.id,
      });
      // X: 6000 − 667 = 5333、Y: 3000 − 333 = 2667
      const lines = await refundLines(db(), refundId);
      expect(lines[`${x}:before`]).toMatchObject({ quantity: 2, restock_type: 'cancel', amount: 5333 });
      expect(lines[`${y}:before`]).toMatchObject({ quantity: 3, restock_type: 'no_restock', amount: 2667 });
    });

    test('不正の疑いは Stripe に伝える理由も記録し、在庫に戻さない選択は no_restock になる', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x] = order.itemIds;

      const res = await beginRefund(db(), order.orderId, {
        source: 'order_cancel',
        actorId: actor.id,
        restock: false,
        cancelReason: 'suspected_fraud',
        stripeReason: 'fraudulent',
        notify: false,
      });

      const refundId = res.rows[0].refund_id as string;
      expect(await refundRow(db(), refundId)).toMatchObject({
        cancel_reason: 'suspected_fraud', stripe_reason: 'fraudulent', note: null, notify_customer: false,
      });
      expect((await refundLines(db(), refundId))[`${x}:before`]).toMatchObject({ restock_type: 'no_restock' });
    });

    test('前に一部を返金していれば、その残りを返す（未発送の残り・送料・返せる額）', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      const partial = await beginRefund(db(), order.orderId, { actorId: actor.id, lines: [refundBefore(x, 1)], amount: 2666 });
      await settle(db(), partial.rows[0].refund_id, 'pending');

      const res = await beginRefund(db(), order.orderId, {
        source: 'order_cancel', actorId: actor.id, cancelReason: 'stock_unavailable',
      });

      // 返せる額は 8500 − 2666 = 5834。X の残り1点は 3000 − (667 − 334) = 2667、Y は 2667、送料 500 → 5834 でぴったり
      expect(res.rows[0]).toMatchObject({ amount: 5834, status: 'awaiting_response' });
      const refundId = res.rows[0].refund_id as string;
      expect(await refundRow(db(), refundId)).toMatchObject({ shipping_amount: 500, adjustment_amount: 0 });
      const lines = await refundLines(db(), refundId);
      expect(lines[`${x}:before`]).toMatchObject({ quantity: 1, amount: 2667 });
      expect(lines[`${y}:before`]).toMatchObject({ quantity: 3, amount: 2667 });
    });

    test('同じ番号の送り直しは前の記録を返し、渡された入力が違えば（取消の理由・DB が使わない額も）断る', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const input = {
        source: 'order_cancel', requestKey: crypto.randomUUID(), actorId: actor.id, cancelReason: 'customer_request', note: '電話',
      };
      const first = await beginRefund(db(), order.orderId, input);

      const again = await beginRefund(db(), order.orderId, input);

      expect(again.rows).toEqual([{ ...first.rows[0], replayed: true }]);
      // 指紋は、渡された入力をそのまま比べる。DB が使わない額でも、渡した値が違えば別の中身
      for (const changed of [{ cancelReason: 'stock_unavailable' }, { amount: 1 }, { shipping: 1 }]) {
        await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { ...input, ...changed }), {
          code: '22023', message: 'REFUND_REQUEST_MISMATCH',
        });
      }
    });
  });

  describe('取り消した注文への入金の自動の返金（エ）', () => {
    test('受け取った額が空なら注文に書いて全額を返す。行・送料・取消の理由は無く、お客様に知らせる', async () => {
      const order = await createOrder(db(), {
        status: 'cancelled',
        lines: [{ quantity: 1, price: 5000, fulfillmentType: 'stock', reserved: false }],
        paidAmount: null,
        withPaymentIntent: true,
      });

      // 呼ぶ側の送料・額・メモ・理由・知らせるかは使わない
      const res = await beginRefund(db(), order.orderId, {
        source: 'auto_cancelled_order_payment',
        requestKey: null,
        receivedAmount: 5000,
        restock: false,
        notify: false,
        note: '呼ぶ側のメモ',
        stripeReason: 'duplicate',
        cancelReason: 'other',
        shipping: 99,
        amount: 1,
      });

      expect(res.rows).toEqual([{ refund_id: expect.any(String), amount: 5000, status: 'awaiting_response', replayed: false }]);
      const refundId = res.rows[0].refund_id as string;
      expect(await refundRow(db(), refundId)).toMatchObject({
        source: 'auto_cancelled_order_payment',
        request_key: null,
        request_fingerprint: null,
        amount: 5000,
        shipping_amount: 0,
        adjustment_amount: 5000,
        note: null,
        stripe_reason: null,
        cancel_reason: null,
        notify_customer: true,
        actor_id: null,
      });
      expect(await refundLines(db(), refundId)).toEqual({});
      const stored = await db().query('select paid_amount, status::text as status from public.orders where id = $1', [order.orderId]);
      expect(stored.rows).toEqual([{ paid_amount: 5000, status: 'cancelled' }]);
      expect(await revisionsOf(db(), order.orderId)).toEqual([
        { reason: 'record_cancelled_order_payment', sourceEventId: null, changedBy: null },
      ]);
    });

    test('受け取った額が書いてあれば呼ぶ側の額は使わず、返せる額の全部を返す。返事待ちの間と全額を返した後は次の返金を断る', async () => {
      const order = await createOrder(db(), {
        status: 'cancelled',
        lines: [{ quantity: 1, price: 5000, fulfillmentType: 'stock', reserved: false }],
        paidAmount: 3000,
        withPaymentIntent: true,
      });
      const input = { source: 'auto_cancelled_order_payment', requestKey: null, receivedAmount: 9999 };

      const first = await beginRefund(db(), order.orderId, input);

      expect(first.rows[0]).toMatchObject({ amount: 3000, status: 'awaiting_response' });
      expect((await db().query('select paid_amount from public.orders where id = $1', [order.orderId])).rows).toEqual([{ paid_amount: 3000 }]);
      expect(await revisionsOf(db(), order.orderId)).toEqual([]);
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, input), { code: '22023', message: 'AWAITING_REFUND_EXISTS' });
      await settle(db(), first.rows[0].refund_id, 'succeeded');
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, input), { code: '22023', message: 'REFUND_EXCEEDS_REFUNDABLE' });
    });

    test('取り消していない注文は断り、受け取った額が空で入金の額も無い注文は引数の誤りにして、注文に何も書かない', async () => {
      const paid = await createValueAOrder(db());
      const unpaid = await createOrder(db(), {
        status: 'cancelled', lines: [{ quantity: 1, price: 5000, fulfillmentType: 'stock', reserved: false }], paidAmount: null,
      });
      const input = { source: 'auto_cancelled_order_payment', requestKey: null, receivedAmount: 5000 };

      await expectRejected(db(), BEGIN_SQL, beginParams(paid.orderId, input), { code: '22023', message: 'ORDER_NOT_REFUNDABLE' });
      for (const receivedAmount of [null, 0]) {
        await expectRejected(db(), BEGIN_SQL, beginParams(unpaid.orderId, { ...input, receivedAmount }), {
          code: '22023', message: 'REFUND_ARGUMENT_INVALID',
        });
      }
      expect((await db().query('select paid_amount from public.orders where id = $1', [unpaid.orderId])).rows).toEqual([{ paid_amount: null }]);
    });

    test('番号を渡した時は、ア・イと同じに送り直しを見分ける', async () => {
      const order = await createOrder(db(), {
        status: 'cancelled', lines: [{ quantity: 1, price: 5000, fulfillmentType: 'stock', reserved: false }], paidAmount: null,
      });
      const input = { source: 'auto_cancelled_order_payment', requestKey: crypto.randomUUID(), receivedAmount: 5000 };

      const first = await beginRefund(db(), order.orderId, input);
      const again = await beginRefund(db(), order.orderId, input);

      expect((await refundRow(db(), first.rows[0].refund_id)).request_fingerprint).toEqual(expect.any(String));
      expect(again.rows).toEqual([{ ...first.rows[0], replayed: true }]);
    });
  });

  describe('支払額の違いの自動の取消（オ）', () => {
    test('取消の理由は other、メモは決まった文、在庫に戻し、お客様に知らせる。呼ぶ側の値は使わない', async () => {
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;

      const res = await beginRefund(db(), order.orderId, {
        source: 'auto_amount_mismatch',
        requestKey: null,
        restock: false,
        notify: false,
        note: '呼ぶ側のメモ',
        stripeReason: 'duplicate',
        cancelReason: 'customer_request',
      });

      const refundId = res.rows[0].refund_id as string;
      expect(res.rows[0]).toMatchObject({ amount: 8500, status: 'awaiting_response' });
      expect(await refundRow(db(), refundId)).toMatchObject({
        source: 'auto_amount_mismatch',
        request_key: null,
        shipping_amount: 500,
        adjustment_amount: 0,
        note: '支払額の違いの自動の取消',
        cancel_reason: 'other',
        stripe_reason: null,
        notify_customer: true,
        actor_id: null,
      });
      const lines = await refundLines(db(), refundId);
      expect(lines[`${x}:before`]).toMatchObject({ quantity: 2, restock_type: 'cancel', amount: 5333 });
      expect(lines[`${y}:before`]).toMatchObject({ quantity: 3, restock_type: 'no_restock', amount: 2667 });
    });

    test('受け取った額が注文の合計と違えば、受け取った額の全部を返し、差は計算との差に残る', async () => {
      const order = await createValueAOrder(db(), { paidAmount: 9000 });

      const res = await beginRefund(db(), order.orderId, { source: 'auto_amount_mismatch', requestKey: null });

      // 商品 8000 + 送料 500 = 8500 に対して、返金額は受け取った 9000
      expect(res.rows[0]).toMatchObject({ amount: 9000 });
      expect(await refundRow(db(), res.rows[0].refund_id)).toMatchObject({ shipping_amount: 500, adjustment_amount: 500 });
    });
  });

  describe('キャンセル・自動の返金は送料と額に 0 を渡す（イ・エ・オ）', () => {
    test('0 を渡しても引数の誤りにならず、返せる額の全部（イ・オは返せる送料の全部も）を使う', async () => {
      const actor = await createActor(db());
      const toCancel = await createValueAOrder(db());
      const mismatched = await createValueAOrder(db());
      // 送料 500 を払って取り消した注文に、5500 の入金が届いた
      const cancelled = await createOrder(db(), {
        status: 'cancelled',
        lines: [{ quantity: 1, price: 5000, fulfillmentType: 'stock', reserved: false }],
        shippingAmount: 500,
        paidAmount: null,
        withPaymentIntent: true,
      });
      const zero = { shipping: 0, amount: 0 };

      const byCancel = await beginRefund(db(), toCancel.orderId, {
        ...zero, source: 'order_cancel', actorId: actor.id, cancelReason: 'customer_request',
      });
      const byMismatch = await beginRefund(db(), mismatched.orderId, { ...zero, source: 'auto_amount_mismatch', requestKey: null });
      const byPayment = await beginRefund(db(), cancelled.orderId, {
        ...zero, source: 'auto_cancelled_order_payment', requestKey: null, receivedAmount: 5500,
      });

      expect(byCancel.rows[0]).toMatchObject({ amount: 8500, status: 'awaiting_response' });
      expect(await refundRow(db(), byCancel.rows[0].refund_id)).toMatchObject({ shipping_amount: 500, adjustment_amount: 0 });
      expect(byMismatch.rows[0]).toMatchObject({ amount: 8500, status: 'awaiting_response' });
      expect(await refundRow(db(), byMismatch.rows[0].refund_id)).toMatchObject({ shipping_amount: 500, adjustment_amount: 0 });
      // エは行も送料も無く、入金の額の全部を返す（計算との差 = 返金額）
      expect(byPayment.rows[0]).toMatchObject({ amount: 5500, status: 'awaiting_response' });
      expect(await refundRow(db(), byPayment.rows[0].refund_id)).toMatchObject({ shipping_amount: 0, adjustment_amount: 5500 });
    });
  });

  describe('取り消した注文への入金の受け取った額を書く（record_cancelled_order_paid_amount。本計画 P27）', () => {
    const WRITE_SQL = 'select public.record_cancelled_order_paid_amount($1, $2, $3) as written';
    const LINE: LineSpec = { quantity: 1, price: 5000, fulfillmentType: 'stock', reserved: false };

    /** 取り消した注文で、受け取った額がまだ空（①がオフ、または①が始める前に断られた注文） */
    function cancelledWithoutPayment(paymentIntentId: string | null = null): Promise<TestOrder> {
      return createOrder(db(), { status: 'cancelled', lines: [LINE], paidAmount: null, paymentIntentId });
    }

    async function storedPayment(orderId: string): Promise<Row> {
      const res = await db().query('select paid_amount, payment_intent_id from public.orders where id = $1', [orderId]);
      return res.rows[0];
    }

    test('取り消した注文で受け取った額が空なら、受け取った額と支払いの番号を書いて true。改訂の理由が付く。書いた後のエは書いた額の全部を返す', async () => {
      const order = await cancelledWithoutPayment();
      const paymentIntentId = `pi_rec${uniqueSuffix()}`;

      const res = await db().query(WRITE_SQL, [order.orderId, paymentIntentId, 5000]);

      expect(res.rows).toEqual([{ written: true }]);
      expect(await storedPayment(order.orderId)).toEqual({ paid_amount: 5000, payment_intent_id: paymentIntentId });
      const status = await db().query('select status::text as status from public.orders where id = $1', [order.orderId]);
      expect(status.rows).toEqual([{ status: 'cancelled' }]);
      expect(await revisionsOf(db(), order.orderId)).toEqual([
        { reason: 'record_cancelled_order_payment', sourceEventId: null, changedBy: null },
      ]);
      const changed = await db().query('select changed_fields from public.order_revisions where order_id = $1', [order.orderId]);
      expect(changed.rows[0].changed_fields).toEqual(expect.arrayContaining(['paid_amount', 'payment_intent_id']));

      // 書いた後のエ（自動の返金①）は、受け取った額を書き直さず、書いた額の全部を返す
      const refund = await beginRefund(db(), order.orderId, {
        source: 'auto_cancelled_order_payment', requestKey: null, receivedAmount: 9999,
      });
      expect(refund.rows[0]).toMatchObject({ amount: 5000, status: 'awaiting_response' });
      expect(await revisionsOf(db(), order.orderId)).toHaveLength(1);
    });

    test('書き済みの注文には書き直さず false。受け取った額が違っても、支払いの番号が空でも変えない', async () => {
      const written = await cancelledWithoutPayment();
      const paymentIntentId = `pi_rec${uniqueSuffix()}`;
      await db().query(WRITE_SQL, [written.orderId, paymentIntentId, 5000]);
      // 受け取った額だけが書いてあって支払いの番号が空の注文も、書き済みとして何も書かない
      const amountOnly = await createOrder(db(), { status: 'cancelled', lines: [LINE], paidAmount: 3000 });

      const again = await db().query(WRITE_SQL, [written.orderId, `pi_rec${uniqueSuffix()}`, 9999]);
      const second = await db().query(WRITE_SQL, [amountOnly.orderId, `pi_rec${uniqueSuffix()}`, 9999]);

      expect(again.rows).toEqual([{ written: false }]);
      expect(second.rows).toEqual([{ written: false }]);
      expect(await storedPayment(written.orderId)).toEqual({ paid_amount: 5000, payment_intent_id: paymentIntentId });
      expect(await storedPayment(amountOnly.orderId)).toEqual({ paid_amount: 3000, payment_intent_id: null });
      expect(await revisionsOf(db(), written.orderId)).toHaveLength(1);
      expect(await revisionsOf(db(), amountOnly.orderId)).toEqual([]);
    });

    test('取り消していない注文には書かず false', async () => {
      for (const status of ['paid', 'shipped', 'pending', 'payment_in_progress', 'failed', 'abandoned']) {
        const order = await createOrder(db(), { status, lines: [LINE], paidAmount: null });

        const res = await db().query(WRITE_SQL, [order.orderId, `pi_rec${uniqueSuffix()}`, 5000]);

        expect({ status, written: res.rows[0].written, stored: await storedPayment(order.orderId) }).toEqual({
          status, written: false, stored: { paid_amount: null, payment_intent_id: null },
        });
      }
    });

    test('注文に別の支払いの番号があれば何も書かず false。同じ支払いの番号なら受け取った額だけを書く', async () => {
      const existing = `pi_rec${uniqueSuffix()}`;
      const order = await cancelledWithoutPayment(existing);

      const other = await db().query(WRITE_SQL, [order.orderId, `pi_rec${uniqueSuffix()}`, 5000]);

      expect(other.rows).toEqual([{ written: false }]);
      expect(await storedPayment(order.orderId)).toEqual({ paid_amount: null, payment_intent_id: existing });
      expect(await revisionsOf(db(), order.orderId)).toEqual([]);

      const same = await db().query(WRITE_SQL, [order.orderId, existing, 5000]);

      expect(same.rows).toEqual([{ written: true }]);
      expect(await storedPayment(order.orderId)).toEqual({ paid_amount: 5000, payment_intent_id: existing });
    });

    test('別の注文が同じ支払いの番号を持っていれば、一意制約の誤り（23505）をそのまま返し、何も書かない', async () => {
      const taken = `pi_rec${uniqueSuffix()}`;
      await createOrder(db(), { lines: [LINE], paymentIntentId: taken });
      const order = await cancelledWithoutPayment();

      await expectRejected(db(), WRITE_SQL, [order.orderId, taken, 5000], { code: '23505' });

      expect(await storedPayment(order.orderId)).toEqual({ paid_amount: null, payment_intent_id: null });
    });

    test('引数の誤りは REFUND_ARGUMENT_INVALID（注文の番号・受け取った額が空か1未満・支払いの番号の形）', async () => {
      const order = await cancelledWithoutPayment();
      const valid = `pi_rec${uniqueSuffix()}`;
      const bad: Array<[string, unknown[]]> = [
        ['注文の番号が空', [null, valid, 5000]],
        ['受け取った額が空', [order.orderId, valid, null]],
        ['受け取った額が0', [order.orderId, valid, 0]],
        ['受け取った額が負', [order.orderId, valid, -1]],
        ['支払いの番号が空', [order.orderId, null, 5000]],
        ['支払いの番号が pi_ で始まらない', [order.orderId, `re_rec${uniqueSuffix()}`, 5000]],
        ['支払いの番号が pi_ だけ', [order.orderId, 'pi_', 5000]],
        ['支払いの番号に記号', [order.orderId, 'pi_rec-1', 5000]],
        ['支払いの番号に空白', [order.orderId, 'pi_rec 1', 5000]],
      ];
      for (const [label, params] of bad) {
        expect({ label, rejection: await rejectionOf(db(), WRITE_SQL, params) }).toEqual({
          label,
          rejection: { code: '22023', message: 'REFUND_ARGUMENT_INVALID' },
        });
      }
      expect(await storedPayment(order.orderId)).toEqual({ paid_amount: null, payment_intent_id: null });
    });

    test('無い注文は ORDER_NOT_FOUND', async () => {
      await expectRejected(db(), WRITE_SQL, [crypto.randomUUID(), `pi_rec${uniqueSuffix()}`, 5000], {
        code: 'P0002', message: 'ORDER_NOT_FOUND',
      });
    });
  });

  describe('断る場合', () => {
    test('引数の誤りは REFUND_ARGUMENT_INVALID（道ごとの必須・形・長さ）', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x] = order.itemIds;
      const ok = { actorId: actor.id, lines: [refundBefore(x, 1)], amount: 1000 };
      const cancelOk = { source: 'order_cancel', actorId: actor.id, cancelReason: 'customer_request' };
      const bad: Array<[string, string | null, BeginInput]> = [
        ['注文の番号が無い', null, ok],
        ['道が無い', order.orderId, { ...ok, source: null }],
        ['道が知らない値', order.orderId, { ...ok, source: 'unknown' }],
        ['Stripe の画面の返金は始められない', order.orderId, { ...ok, source: 'stripe_dashboard' }],
        ['前からの写しは始められない', order.orderId, { ...ok, source: 'legacy' }],
        ['アに二重防止の番号が無い', order.orderId, { ...ok, requestKey: null }],
        ['アに実行した人が無い', order.orderId, { ...ok, actorId: null }],
        ['額が0', order.orderId, { ...ok, amount: 0 }],
        ['額が無い', order.orderId, { ...ok, amount: null }],
        ['送料が負', order.orderId, { ...ok, shipping: -1 }],
        ['送料が無い', order.orderId, { ...ok, shipping: null }],
        ['送料が額より多い', order.orderId, { ...ok, shipping: 600, amount: 500 }],
        ['アに取消の理由', order.orderId, { ...ok, cancelReason: 'other' }],
        ['メモが501字', order.orderId, { ...ok, note: 'あ'.repeat(501) }],
        ['Stripe に伝える理由が知らない値', order.orderId, { ...ok, stripeReason: 'other' }],
        ['在庫に戻すかが無い', order.orderId, { ...ok, restock: null }],
        ['知らせるかが無い', order.orderId, { ...ok, notify: null }],
        ['行が配列でない', order.orderId, { ...ok, lines: { order_item_id: x } }],
        ['行の商品が uuid でない', order.orderId, { ...ok, lines: [{ order_item_id: 'x', quantity: 1, before_shipment: true }] }],
        ['行の数が0', order.orderId, { ...ok, lines: [refundBefore(x, 0)] }],
        ['行の数が1000', order.orderId, { ...ok, lines: [refundBefore(x, 1000)] }],
        ['行の数が小数', order.orderId, { ...ok, lines: [refundBefore(x, 1.5)] }],
        ['行に発送前かが無い', order.orderId, { ...ok, lines: [{ order_item_id: x, quantity: 1 }] }],
        ['同じ商品の同じ側が2行', order.orderId, { ...ok, lines: [refundBefore(x, 1), refundBefore(x, 1)] }],
        ['行が101件', order.orderId, { ...ok, lines: Array.from({ length: 101 }, () => refundBefore(crypto.randomUUID(), 1)) }],
        ['イに取消の理由が無い', order.orderId, { ...cancelOk, cancelReason: null }],
        ['イの取消の理由が知らない値', order.orderId, { ...cancelOk, cancelReason: 'refund' }],
        ['イの「その他」でメモが無い', order.orderId, { ...cancelOk, cancelReason: 'other' }],
        ['イの「その他」でメモが空白だけ', order.orderId, { ...cancelOk, cancelReason: 'other', note: '   ' }],
        ['イに行を渡した', order.orderId, { ...cancelOk, lines: [refundBefore(x, 1)] }],
        ['イに二重防止の番号が無い', order.orderId, { ...cancelOk, requestKey: null }],
        ['イに実行した人が無い', order.orderId, { ...cancelOk, actorId: null }],
        ['オに行を渡した', order.orderId, { source: 'auto_amount_mismatch', requestKey: null, lines: [refundBefore(x, 1)] }],
      ];
      for (const [label, orderId, input] of bad) {
        expect({ label, rejection: await rejectionOf(db(), BEGIN_SQL, beginParams(orderId, input)) }).toEqual({
          label,
          rejection: { code: '22023', message: 'REFUND_ARGUMENT_INVALID' },
        });
      }
    });

    test('無い注文は ORDER_NOT_FOUND', async () => {
      const actor = await createActor(db());

      await expectRejected(db(), BEGIN_SQL, beginParams(crypto.randomUUID(), { actorId: actor.id, amount: 1000 }), {
        code: 'P0002', message: 'ORDER_NOT_FOUND',
      });
    });

    test('返金できない注文は ORDER_NOT_REFUNDABLE（入金前・失敗・放棄・受け取った額が空か0）', async () => {
      const actor = await createActor(db());
      const input = { actorId: actor.id, amount: 1000 };
      const line: LineSpec = { quantity: 1, price: 5000, fulfillmentType: 'stock' };

      for (const status of ['payment_in_progress', 'pending', 'failed', 'abandoned']) {
        const order = await createOrder(db(), { status, lines: [line] });
        expect({ status, rejection: await rejectionOf(db(), BEGIN_SQL, beginParams(order.orderId, input)) }).toEqual({
          status,
          rejection: { code: '22023', message: 'ORDER_NOT_REFUNDABLE' },
        });
      }
      for (const paidAmount of [null, 0]) {
        const order = await createOrder(db(), { lines: [line], paidAmount });
        expect({ paidAmount, rejection: await rejectionOf(db(), BEGIN_SQL, beginParams(order.orderId, input)) }).toEqual({
          paidAmount,
          rejection: { code: '22023', message: 'ORDER_NOT_REFUNDABLE' },
        });
      }
    });

    test('キャンセルと支払額の違いの自動の取消は、支払い済みで1つも発送していない注文だけ（ORDER_NOT_CANCELLABLE）', async () => {
      const actor = await createActor(db());
      const partlyShipped = await createValueAOrder(db());
      await ship(db(), partlyShipped.orderId, actor.id, [{ order_item_id: partlyShipped.itemIds[0], quantity: 1 }]);
      const line: LineSpec = { quantity: 1, price: 5000, fulfillmentType: 'stock' };
      const cancelled = await createOrder(db(), { status: 'cancelled', lines: [line] });
      const shipped = await createOrder(db(), { status: 'shipped', lines: [line] });
      const cancel = { source: 'order_cancel', actorId: actor.id, cancelReason: 'customer_request' };
      const mismatch = { source: 'auto_amount_mismatch', requestKey: null };

      for (const [label, target] of [['一部を発送した', partlyShipped], ['取り消した', cancelled], ['発送済み', shipped]] as const) {
        for (const input of [cancel, mismatch]) {
          expect({
            label,
            source: input.source,
            rejection: await rejectionOf(db(), BEGIN_SQL, beginParams(target.orderId, input)),
          }).toEqual({ label, source: input.source, rejection: { code: '22023', message: 'ORDER_NOT_CANCELLABLE' } });
        }
      }
    });

    test('注文に無い商品・未発送を超える数・発送した数を超える数は断る', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const other = await createValueAOrder(db());
      const [x] = order.itemIds;
      const base = { actorId: actor.id, amount: 1000 };

      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { ...base, lines: [refundBefore(other.itemIds[0], 1)] }), {
        code: '22023', message: 'REFUND_LINE_NOT_IN_ORDER',
      });
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { ...base, lines: [refundBefore(x, 3)] }), {
        code: '22023', message: 'REFUND_QUANTITY_EXCEEDS_UNSHIPPED',
      });
      // まだ何も発送していないので、発送後の返金はできない
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { ...base, lines: [refundAfter(x, 1)] }), {
        code: '22023', message: 'REFUND_QUANTITY_EXCEEDS_SHIPPED',
      });

      // 1点発送すると、発送後に返せるのは1点、発送前に返せるのも残りの1点
      await ship(db(), order.orderId, actor.id, [{ order_item_id: x, quantity: 1 }]);
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { ...base, lines: [refundAfter(x, 2)] }), {
        code: '22023', message: 'REFUND_QUANTITY_EXCEEDS_SHIPPED',
      });
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { ...base, lines: [refundBefore(x, 2)] }), {
        code: '22023', message: 'REFUND_QUANTITY_EXCEEDS_UNSHIPPED',
      });
      await expect(beginRefund(db(), order.orderId, { ...base, lines: [refundAfter(x, 1)] })).resolves.toBeTruthy();
    });

    test('送料が返せる送料を超える・額が返せる額を超える・返せる額が0なら断る', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      const lines = [refundBefore(x, 1)];

      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { actorId: actor.id, lines, shipping: 501, amount: 3000 }), {
        code: '22023', message: 'REFUND_SHIPPING_EXCEEDS',
      });
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { actorId: actor.id, lines, amount: 8501 }), {
        code: '22023', message: 'REFUND_EXCEEDS_REFUNDABLE',
      });

      // 前の返金で送料を使い切っていれば、送料は1円も返せない
      const first = await beginRefund(db(), order.orderId, { actorId: actor.id, lines, shipping: 500, amount: 3000 });
      await settle(db(), first.rows[0].refund_id, 'pending');
      await expectRejected(
        db(),
        BEGIN_SQL,
        beginParams(order.orderId, { actorId: actor.id, lines: [refundBefore(y, 1)], shipping: 1, amount: 1000 }),
        { code: '22023', message: 'REFUND_SHIPPING_EXCEEDS' },
      );

      // 残りを全部返して返せる額が0になると、次の返金は額が1円でも断る
      const rest = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundBefore(x, 1), refundBefore(y, 3)], shipping: 0, amount: 5500,
      });
      await settle(db(), rest.rows[0].refund_id, 'pending');
      await expectRejected(db(), BEGIN_SQL, beginParams(order.orderId, { actorId: actor.id, amount: 1 }), {
        code: '22023', message: 'REFUND_EXCEEDS_REFUNDABLE',
      });
    });
  });

  describe('材料と読み出し', () => {
    test('返金の画面の材料: 注文の金額・返せる額・商品ごとの数と割り振った割引', async () => {
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;

      const res = await db().query('select * from public.load_order_refund_materials($1)', [order.orderId]);

      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({
        order_id: order.orderId,
        order_status: 'paid',
        total_amount: 8500,
        shipping_amount: 500,
        discount_amount: 1000,
        paid_amount: 8500,
        succeeded_amount: 0,
        open_amount: 0,
        refundable_amount: 8500,
        refunded_shipping: 0,
        refundable_shipping: 500,
        shipped_total: 0,
        unshipped_total: 5,
        awaiting_refund_id: null,
        awaiting_refund_amount: null,
        awaiting_refund_created_at: null,
      });
      // 商品の登録順。X の割引は 667、Y は 333。在庫の品は確保済みの2点まで戻せる
      expect(res.rows[0].lines).toEqual([
        {
          order_item_id: x, fulfillment_type: 'stock', item_price: 3000, quantity: 2, line_total: 6000, shipped: 0, unshipped: 2,
          refunded_before_shipment: 0, refunded_after_shipment: 0, shipped_refundable: 0, restockable: 2, line_discount: 667,
          refunded_units: 0,
        },
        {
          order_item_id: y, fulfillment_type: 'backorder', item_price: 1000, quantity: 3, line_total: 3000, shipped: 0, unshipped: 3,
          refunded_before_shipment: 0, refunded_after_shipment: 0, shipped_refundable: 0, restockable: 0, line_discount: 333,
          refunded_units: 0,
        },
      ]);
    });

    test('材料は、返金した数・発送後に返せる数・返事待ちの返金を返す', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      await ship(db(), order.orderId, actor.id, [{ order_item_id: x, quantity: 1 }]);
      // 発送前の返金（X 1点 2666 + Y 1点 889）は成功。発送後の返金（X 1点 3000 − (667 − 334) = 2667）は返事待ちのまま
      const done = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundBefore(x, 1), refundBefore(y, 1)], amount: 3555,
      });
      await settle(db(), done.rows[0].refund_id, 'succeeded');
      const waiting = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundAfter(x, 1)], restock: false, amount: 2667,
      });

      const res = await db().query('select * from public.load_order_refund_materials($1)', [order.orderId]);

      expect(res.rows[0]).toMatchObject({
        succeeded_amount: 3555,
        open_amount: 2667,
        refundable_amount: 8500 - 3555 - 2667,
        refunded_shipping: 0,
        refundable_shipping: 500,
        shipped_total: 1,
        unshipped_total: 2,
        awaiting_refund_id: waiting.rows[0].refund_id,
        awaiting_refund_amount: 2667,
      });
      expect(res.rows[0].awaiting_refund_created_at).toBeInstanceOf(Date);
      expect(res.rows[0].lines).toEqual([
        {
          order_item_id: x, fulfillment_type: 'stock', item_price: 3000, quantity: 2, line_total: 6000, shipped: 1, unshipped: 0,
          refunded_before_shipment: 1, refunded_after_shipment: 1, shipped_refundable: 0, restockable: 0, line_discount: 667,
          refunded_units: 2,
        },
        {
          order_item_id: y, fulfillment_type: 'backorder', item_price: 1000, quantity: 3, line_total: 3000, shipped: 0, unshipped: 2,
          refunded_before_shipment: 1, refunded_after_shipment: 0, shipped_refundable: 0, restockable: 0, line_discount: 333,
          refunded_units: 1,
        },
      ]);
    });

    test('在庫に戻せる数は、確保している数まで。確保の記録が無い古い商品と受注生産は0', async () => {
      const actor = await createActor(db());
      const order = await createOrder(db(), {
        lines: [
          { quantity: 3, price: 1000, fulfillmentType: 'stock' },
          { quantity: 3, price: 1000, fulfillmentType: 'stock', reserved: false },
          { quantity: 3, price: 1000, fulfillmentType: 'stock', reserved: false },
          { quantity: 2, price: 1000, fulfillmentType: 'backorder' },
        ],
      });
      const [reservedItem, , partlyItem] = order.itemIds;
      // 3点注文して1点しか確保できていない商品
      await db().query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
         values ($1, -1, 'purchase', $2, $3)`,
        [order.variantIds[2], order.orderId, partlyItem],
      );
      const restockable = async () => {
        const res = await db().query('select lines from public.load_order_refund_materials($1)', [order.orderId]);
        return (res.rows[0].lines as Row[]).map((line) => line.restockable);
      };

      expect(await restockable()).toEqual([3, 0, 1, 0]);

      // 確保が refund の台帳の行で1点外れた分は、戻せる数に入らない
      await db().query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
         values ($1, 1, 'refund', $2, $3)`,
        [order.variantIds[0], order.orderId, reservedItem],
      );
      expect(await restockable()).toEqual([2, 0, 1, 0]);

      // 発送した数は確保から引く: 確保 2 − 発送 1 = 1（未発送は 3 − 1 = 2）
      await ship(db(), order.orderId, actor.id, [{ order_item_id: reservedItem, quantity: 1 }]);
      expect(await restockable()).toEqual([1, 0, 1, 0]);
    });

    test('受け取った額が空の注文の材料は、受け取った額が空で、返せる額は 0', async () => {
      const order = await createOrder(db(), {
        status: 'cancelled',
        lines: [{ quantity: 1, price: 5000, fulfillmentType: 'stock', reserved: false }],
        paidAmount: null,
      });

      const res = await db().query(
        'select paid_amount, refundable_amount, refundable_shipping from public.load_order_refund_materials($1)',
        [order.orderId],
      );

      expect(res.rows).toEqual([{ paid_amount: null, refundable_amount: 0, refundable_shipping: 0 }]);
    });

    test('無い注文の材料も、無い返金も、0行', async () => {
      const materials = await db().query('select * from public.load_order_refund_materials($1)', [crypto.randomUUID()]);
      const refund = await db().query('select * from public.get_order_refund($1)', [crypto.randomUUID()]);

      expect(materials.rows).toEqual([]);
      expect(refund.rows).toEqual([]);
    });

    test('返金を1件読む: 注文・道・状態・Stripe の返金の番号・金額・注文の支払いの番号・Stripe に伝える理由・実行した人・失敗の理由', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x] = order.itemIds;
      const res = await beginRefund(db(), order.orderId, {
        actorId: actor.id, lines: [refundBefore(x, 1)], amount: 2666, stripeReason: 'requested_by_customer',
      });
      const refundId = res.rows[0].refund_id as string;

      const row = await db().query('select * from public.get_order_refund($1)', [refundId]);

      expect(row.rows).toEqual([
        {
          refund_id: refundId,
          order_id: order.orderId,
          source: 'admin',
          status: 'awaiting_response',
          stripe_refund_id: null,
          amount: 2666,
          payment_intent_id: order.paymentIntentId,
          created_at: expect.any(Date),
          stripe_reason: 'requested_by_customer',
          actor_id: actor.id,
          stripe_failure_reason: null,
        },
      ]);

      // Stripe に断られてエラーにした後は、状態と失敗の理由が変わる
      await settle(db(), refundId, 'error');
      const errored = await db().query('select status, stripe_failure_reason from public.get_order_refund($1)', [refundId]);
      expect(errored.rows).toEqual([{ status: 'error', stripe_failure_reason: 'stripe_rejected' }]);
    });

    test('注文の返金を新しい順に、商品の行と実行した人のメールを付けて返す', async () => {
      const actor = await createActor(db());
      const order = await createValueAOrder(db());
      const [x, y] = order.itemIds;
      const first = await beginRefund(db(), order.orderId, {
        actorId: actor.id,
        lines: [refundBefore(x, 1), refundBefore(y, 2)],
        amount: 4444,
        note: 'お客様の希望',
        stripeReason: 'requested_by_customer',
      });
      const firstId = first.rows[0].refund_id as string;
      await settle(db(), firstId, 'succeeded');
      // Stripe の返金の番号は表全体で一意。手元の DB に残った別の試験の番号とぶつからないよう、毎回違う番号にする
      await db().query(
        `update public.order_refunds
         set stripe_refund_id = $2, payment_method_type = 'card',
             reference_number = 'ARN0001', reference_type = 'acquirer_reference_number'
         where id = $1`,
        [firstId, `re_list${uniqueSuffix()}`],
      );
      // 作った時刻を決めた記録を、新しい物より古く書く（同じ取引の中の now() は同じなので、begin_order_refund では順番が付かない）
      const failedId = await insertRefundRow(db(), order.orderId, { status: 'failed', minutesAgo: 60 });
      const errorId = await insertRefundRow(db(), order.orderId, { status: 'error', minutesAgo: 120 });

      const res = await db().query('select * from public.list_order_refunds($1)', [order.orderId]);

      expect(res.rows.map((row) => row.refund_id)).toEqual([firstId, failedId, errorId]);
      expect(res.rows[0]).toMatchObject({
        source: 'admin',
        status: 'succeeded',
        stripe_status: 'succeeded',
        stripe_pending_reason: null,
        stripe_failure_reason: null,
        customer_action_expires_at: null,
        payment_method_type: 'card',
        amount: 4444,
        shipping_amount: 0,
        adjustment_amount: 0,
        note: 'お客様の希望',
        stripe_reason: 'requested_by_customer',
        cancel_reason: null,
        notify_customer: true,
        actor_email: actor.email,
        reference_number: 'ARN0001',
        reference_type: 'acquirer_reference_number',
        failed_at: null,
        errored_at: null,
      });
      expect(res.rows[0].created_at).toBeInstanceOf(Date);
      expect(res.rows[0].accepted_at).toBeInstanceOf(Date);
      expect(res.rows[0].succeeded_at).toBeInstanceOf(Date);
      expect(res.rows[0].lines).toHaveLength(2);
      expect(res.rows[0].lines).toEqual(
        expect.arrayContaining([
          {
            order_item_id: x, quantity: 1, before_shipment: true, restock_type: 'cancel', amount: 2666,
            released_quantity: 0, restocked_quantity: 0, rereserved_quantity: 0, rereserve_shortage: 0,
          },
          {
            order_item_id: y, quantity: 2, before_shipment: true, restock_type: 'no_restock', amount: 1778,
            released_quantity: 0, restocked_quantity: 0, rereserved_quantity: 0, rereserve_shortage: 0,
          },
        ]),
      );
      expect(res.rows[1]).toMatchObject({ status: 'failed', actor_email: null, lines: [] });
      expect(res.rows[2]).toMatchObject({ status: 'error', lines: [] });
    });

    test('返事待ちの返金を古い順に返す。作ってから15分たっていない物・返事待ちでない物は返さない', async () => {
      // 手元の DB に残った他の試験の返事待ちを、この取引の中だけ片付ける
      await db().query("update public.order_refunds set status = 'error', errored_at = now() where status = 'awaiting_response'");
      const first = await createValueAOrder(db());
      const second = await createOrder(db(), { lines: [{ quantity: 1, price: 5000, fulfillmentType: 'stock' }] });
      const third = await createValueAOrder(db());
      const oldest = await insertRefundRow(db(), first.orderId, { status: 'awaiting_response', minutesAgo: 90 });
      const middle = await insertRefundRow(db(), second.orderId, { status: 'awaiting_response', minutesAgo: 30 });
      await insertRefundRow(db(), third.orderId, { status: 'awaiting_response', minutesAgo: 5 });
      await insertRefundRow(db(), third.orderId, { status: 'pending', minutesAgo: 120 });

      const res = await db().query("select * from public.list_awaiting_order_refunds(now() - interval '15 minutes', 10)");

      expect(res.rows.map((row) => row.refund_id)).toEqual([oldest, middle]);
      expect(res.rows[0]).toMatchObject({ order_id: first.orderId, payment_intent_id: first.paymentIntentId });
      expect(res.rows[0].created_at).toBeInstanceOf(Date);
      expect(res.rows[1]).toMatchObject({ order_id: second.orderId, payment_intent_id: null });
    });

    test('返事待ちの一覧の件数は1〜200に丸める。空は50件', async () => {
      await db().query("update public.order_refunds set status = 'error', errored_at = now() where status = 'awaiting_response'");
      const order = await createValueAOrder(db());
      await db().query(
        `insert into public.order_refunds
           (order_id, source, request_key, request_fingerprint, status, amount, notify_customer, created_at)
         select $1::uuid, 'admin', gen_random_uuid(), 'fixture', 'awaiting_response', 100, true, now() - make_interval(mins => 30 + g)
         from generate_series(1, 205) as g`,
        [order.orderId],
      );
      const count = async (limit: number | null) =>
        (
          await db().query(
            "select count(*)::int as n from public.list_awaiting_order_refunds(now() - interval '15 minutes', $1)",
            [limit],
          )
        ).rows[0].n as number;

      expect(await count(1000)).toBe(200);
      expect(await count(7)).toBe(7);
      expect(await count(0)).toBe(1);
      expect(await count(-5)).toBe(1);
      expect(await count(null)).toBe(50);
      // 古い順: 1件だけ頼むと一番古い物（235分前）が返る
      const oldest = await db().query('select id from public.order_refunds where order_id = $1 order by created_at, id limit 1', [order.orderId]);
      const first = await db().query("select refund_id from public.list_awaiting_order_refunds(now() - interval '15 minutes', 1)");
      expect(first.rows).toEqual([{ refund_id: oldest.rows[0].id }]);
    });

    test('保留の返金がある注文の支払いの番号を、重複なく古い保留の順に返す', async () => {
      await db().query("update public.order_refunds set status = 'failed', failed_at = now() where status = 'pending'");
      const first = await createValueAOrder(db());
      const second = await createValueAOrder(db());
      const third = await createValueAOrder(db());
      const noPaymentIntent = await createOrder(db(), { lines: [{ quantity: 1, price: 5000, fulfillmentType: 'stock' }] });
      // 同じ注文に保留が2件、別の注文に古い保留が1件、成功だけの注文、支払いの番号が無い注文
      await insertRefundRow(db(), first.orderId, { status: 'pending', minutesAgo: 120 });
      await insertRefundRow(db(), first.orderId, { status: 'pending', minutesAgo: 60 });
      await insertRefundRow(db(), second.orderId, { status: 'pending', minutesAgo: 180 });
      await insertRefundRow(db(), third.orderId, { status: 'succeeded', minutesAgo: 200 });
      await insertRefundRow(db(), noPaymentIntent.orderId, { status: 'pending', minutesAgo: 300 });

      const all = await db().query('select * from public.list_pending_refund_payment_intents(10)');
      const one = await db().query('select * from public.list_pending_refund_payment_intents(1)');
      const rounded = await db().query('select * from public.list_pending_refund_payment_intents(0)');

      expect(all.rows).toEqual([{ payment_intent_id: second.paymentIntentId }, { payment_intent_id: first.paymentIntentId }]);
      expect(one.rows).toEqual([{ payment_intent_id: second.paymentIntentId }]);
      expect(rounded.rows).toEqual([{ payment_intent_id: second.paymentIntentId }]);
    });
  });

  describe('ショップの設定', () => {
    test('最初は ① オン・② オフで、更新者も時刻も空。切り替えの時刻が付く', async () => {
      const res = await db().query('select * from public.get_shop_settings()');

      expect(res.rows).toEqual([
        {
          auto_refund_cancelled_order_payment: true,
          auto_refund_cancelled_order_payment_updated_by_email: null,
          auto_refund_cancelled_order_payment_updated_at: null,
          auto_cancel_amount_mismatch: false,
          auto_cancel_amount_mismatch_updated_by_email: null,
          auto_cancel_amount_mismatch_updated_at: null,
          refund_ledger_started_at: expect.any(Date),
        },
      ]);
    });

    test('変わったトグルだけ、その更新者と時刻を書く。変わらない方は書き換えない', async () => {
      const first = await createActor(db());
      const second = await createActor(db());
      const update = 'select * from public.admin_update_shop_settings($1, $2, $3)';

      // ①だけ変える（オン → オフ）
      const afterFirst = await db().query(update, [false, false, first.id]);
      expect(afterFirst.rows[0]).toMatchObject({
        auto_refund_cancelled_order_payment: false,
        auto_refund_cancelled_order_payment_updated_by_email: first.email,
        auto_cancel_amount_mismatch: false,
        auto_cancel_amount_mismatch_updated_by_email: null,
        auto_cancel_amount_mismatch_updated_at: null,
      });
      expect(afterFirst.rows[0].auto_refund_cancelled_order_payment_updated_at).toBeInstanceOf(Date);

      // ①の時刻を過去にしておくと、②だけ変えた時に①の時刻が書き換わらないことが見える（同じ取引の中の now() は同じため）
      await db().query(
        "update public.shop_settings set auto_refund_cancelled_order_payment_updated_at = '2020-01-01T00:00:00Z' where id = 1",
      );
      const afterSecond = await db().query(update, [false, true, second.id]);
      expect(afterSecond.rows[0]).toMatchObject({
        auto_refund_cancelled_order_payment: false,
        auto_refund_cancelled_order_payment_updated_by_email: first.email,
        auto_cancel_amount_mismatch: true,
        auto_cancel_amount_mismatch_updated_by_email: second.email,
      });
      expect(afterSecond.rows[0].auto_refund_cancelled_order_payment_updated_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
      expect(afterSecond.rows[0].auto_cancel_amount_mismatch_updated_at.getFullYear()).toBeGreaterThan(2020);

      // 同じ値を送っても、更新者も時刻も書き換わらない
      const again = await db().query(update, [false, true, first.id]);
      expect(again.rows[0]).toMatchObject({
        auto_refund_cancelled_order_payment_updated_by_email: first.email,
        auto_cancel_amount_mismatch_updated_by_email: second.email,
      });
      expect(again.rows[0].auto_refund_cancelled_order_payment_updated_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    });

    test('引数が空なら SETTINGS_ARGUMENT_INVALID', async () => {
      const actor = await createActor(db());

      for (const params of [[null, false, actor.id], [true, null, actor.id], [true, false, null]]) {
        await expectRejected(db(), 'select * from public.admin_update_shop_settings($1, $2, $3)', params, {
          code: '22023', message: 'SETTINGS_ARGUMENT_INVALID',
        });
      }
    });
  });

  describe('権限と関数の数', () => {
    test.each(SERVICE_ONLY_FUNCTIONS)('%s は service_role だけが実行できる', async (signature) => {
      const res = await db().query(
        `select has_function_privilege('anon', $1::text, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1::text, 'EXECUTE') as authenticated,
                has_function_privilege('service_role', $1::text, 'EXECUTE') as service_role`,
        [signature],
      );

      expect(res.rows[0]).toEqual({ anon: false, authenticated: false, service_role: true });
    });

    test('返金の商品の行を解く private の関数は、だれも呼べない', async () => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const res = await db().query(
          "select has_function_privilege($1::text, 'private.parse_refund_lines(jsonb)', 'EXECUTE') as allowed",
          [role],
        );
        expect({ role, allowed: res.rows[0].allowed }).toEqual({ role, allowed: false });
      }
    });

    test.each(['anon', 'authenticated'])('%s は返金の関数・ショップの設定の関数を呼べない', async (role) => {
      const calls: Array<[string, unknown[]]> = [
        ['select * from public.get_shop_settings()', []],
        ['select * from public.admin_update_shop_settings(true, false, gen_random_uuid())', []],
        [BEGIN_SQL, beginParams(crypto.randomUUID(), { actorId: crypto.randomUUID(), amount: 1000 })],
        ['select * from public.load_order_refund_materials(gen_random_uuid())', []],
        ['select * from public.list_order_refunds(gen_random_uuid())', []],
        ["select public.record_cancelled_order_paid_amount(gen_random_uuid(), 'pi_abc', 1)", []],
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
      await expect(db().query('select * from public.get_shop_settings()')).resolves.toBeTruthy();
      await expect(db().query('select * from public.list_order_refunds(gen_random_uuid())')).resolves.toBeTruthy();
      await expect(
        db().query("select * from public.list_awaiting_order_refunds(now() - interval '15 minutes', 10)"),
      ).resolves.toBeTruthy();
      await db().query('rollback to savepoint service');
    });

    test('同じ名前の関数は1つだけ（2つあると Data API が呼び分けられない: PGRST203）', async () => {
      for (const [schema, name] of [
        ['public', 'begin_order_refund'],
        ['public', 'get_order_refund'],
        ['public', 'load_order_refund_materials'],
        ['public', 'list_order_refunds'],
        ['public', 'list_awaiting_order_refunds'],
        ['public', 'list_pending_refund_payment_intents'],
        ['public', 'get_shop_settings'],
        ['public', 'admin_update_shop_settings'],
        ['public', 'record_cancelled_order_paid_amount'],
        ['public', 'admin_cancel_fulfillment'],
        ['private', 'parse_refund_lines'],
      ]) {
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

describeLocalDb('integration: 返金と発送の同時の操作（Review Focus 3）', (db) => {
  let other: PgClient;

  beforeAll(async () => {
    other = await connectLocalDb();
  });

  afterAll(async () => {
    await other.end();
  });

  /** 確定した注文（在庫の品1つ・数3・確保済み）。もう1つの接続からも見える */
  function createCommittedOrder(): Promise<TestOrder> {
    return createOrder(db(), { lines: [{ quantity: 3, price: 5000, fulfillmentType: 'stock' }] });
  }

  test('返金が先: 発送は注文の行の鍵を待ち、返金が確定した後に発送準備中の数を超えるとして断られる。返金だけが記録される', async () => {
    const actor = await createActor(db());
    const order = await createCommittedOrder();
    const [item] = order.itemIds;
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;

    await db().query('begin');
    try {
      // 3点のうち2点を発送前に返金する（返事待ち）。発送できるのは残りの1点だけになる
      await beginRefund(db(), order.orderId, { actorId: actor.id, lines: [refundBefore(item, 2)], amount: 9000 });
      const shipping = ship(other, order.orderId, actor.id, [{ order_item_id: item, quantity: 2 }]).then(
        () => null,
        (error: unknown) => error,
      );
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await shipping).toMatchObject({ code: '22023', message: 'QUANTITY_EXCEEDS_READY' });
    } catch (error) {
      await db().query('rollback');
      throw error;
    }

    expect(await countRefunds(db(), order.orderId)).toBe(1);
    const fulfillments = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [order.orderId]);
    expect(fulfillments.rows[0].n).toBe(0);
    // 確定した返事待ちを、見回りの一覧に残さない
    await db().query("update public.order_refunds set status = 'error', errored_at = now() where order_id = $1", [order.orderId]);
  });

  test('発送が先: 返金は注文の行の鍵を待ち、発送が確定した後に未発送の数を超えるとして断られる。発送だけが記録される', async () => {
    const actor = await createActor(db());
    const order = await createCommittedOrder();
    const [item] = order.itemIds;
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;

    await db().query('begin');
    try {
      await ship(db(), order.orderId, actor.id, [{ order_item_id: item, quantity: 2 }]);
      const refunding = beginRefund(other, order.orderId, { actorId: actor.id, lines: [refundBefore(item, 2)], amount: 9000 }).then(
        () => null,
        (error: unknown) => error,
      );
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await refunding).toMatchObject({ code: '22023', message: 'REFUND_QUANTITY_EXCEEDS_UNSHIPPED' });
    } catch (error) {
      await db().query('rollback');
      throw error;
    }

    expect(await countRefunds(db(), order.orderId)).toBe(0);
    const fulfillments = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [order.orderId]);
    expect(fulfillments.rows[0].n).toBe(1);
  });
});
