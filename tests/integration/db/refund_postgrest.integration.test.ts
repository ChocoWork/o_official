/** @jest-environment node */
/**
 * 返金の記録の窓口（refund-store.ts・refund-materials.ts）を、実際の PostgREST（ローカル Supabase の API）に通す（グループ E-2）。
 *
 * 窓口の単体試験は Supabase のクライアントを差し替え、DB 結合の試験は pg で関数を直に呼ぶ。どちらも PostgREST を通らないので、
 * 名前つき引数の違い（uuid・uuid[]・jsonb・timestamptz の渡し方）・戻りの列の名前・移行の NOTIFY pgrst による読み直しの誤りは、
 * 本番で店主が初めて返金を押した時まで分からない（E-1 の fulfillment_postgrest と同じ考え）。
 * ここでは service_role の本物の supabase-js の client で、窓口が呼ぶ関数を1回ずつ通し、数と答えの形が DB の関数の仕様
 * （共通の約束 C-1）どおりに写ることを確かめる。額の割り振りと断りの全部は、移行ごとの DB 結合テストが確かめる。
 *
 * 後片付けはしない。試験の注文は削除禁止のトリガーで、返金の記録は追記だけのトリガーで消せないので、ほかの DB 結合テストと
 * 同じく使い捨てのローカル DB でだけ動かす（DATABASE_URL・LOCAL_SUPABASE_URL が localhost 以外なら失敗させる）。
 * 注文は毎回新しく作る。ただし、返事待ち・保留の返金は、ほかの結合テストの全体の一覧に混ざらないよう、試験の終わりに成功かエラーにする。
 * ショップの設定は、試験の前の値を控えて、終わりに戻す。
 * 要対応の窓口（GET /api/admin/order-attention）の「返金の記録 → 返金の商品の行 → 商品」の埋め込みの select は、窓口そのものを呼んで通す
 * （権限の確かめだけを通し、Service Role の client を、ここの本物の client にする）。select の文字を試験に写すと、窓口の select が
 * 変わっても試験が通ってしまう。誤ると窓口は警告だけを出して「額0・不足なし」に黙って落ちるので、額と商品の名前・数を確かめる。
 *
 * 実行方法（ローカル Supabase を起動しておく）:
 *   eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *     npx jest tests/integration/db/refund_postgrest --runInBand
 */
// 要対応の窓口（GET）そのものを呼ぶための差し替え。権限の確かめは通し、Service Role の client は beforeAll で作る本物の client にする。
// next/server は、Response の中身（status と body）だけを見る形にする（要対応の窓口の単体試験と同じ）
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn(async () => ({ ok: true })) }));
let mockRouteClient: unknown;
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(async () => mockRouteClient) }));

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { GET as getOrderAttention } from '@/app/api/admin/order-attention/route';
import type { OrderAttention } from '@/lib/orders/order-payment-types';
import { refundFailureReasonLabel } from '@/lib/orders/refund/refund-messages';
import { loadRefundMaterials } from '@/lib/orders/refund/refund-materials';
import {
  RefundOperationError,
  beginOrderRefund,
  getOrderRefund,
  getShopSettings,
  listAwaitingOrderRefunds,
  listOrderRefundSummaries,
  listOrderRefunds,
  listPendingRefundPaymentIntents,
  markOrderRefundError,
  recordExternalOrderRefund,
  recordOrderRefundResult,
  resolvePaymentExceptionBySystem,
  toRefundErrorCode,
  updateShopSettings,
  type BeginRefundInput,
  type StripeRefundFields,
} from '@/lib/orders/refund/refund-store';
import { describeLocalDb, isLocalDatabase, type PgClient } from './helpers/local-db';
import { PRICE, createCatalogFixture, uniqueSuffix, variantStock } from './helpers/order-fixtures';

jest.setTimeout(30000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 試験の注文の送料。商品2つ（PRICE × 2）と合わせて、受け取った額（全額）は 10,500 円になる */
const SHIPPING_AMOUNT = 500;

type Actor = { id: string; email: string };
type PaidOrder = { orderId: string; orderItemId: string; paymentIntentId: string; totalAmount: number };

async function createActor(db: PgClient): Promise<Actor> {
  const email = `refund-postgrest-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

/**
 * 支払い済みの注文（在庫の品を quantity 個。台帳に確保済み）。受け取った額は合計（商品の小計 + 送料）。毎回新しく作る。
 * 注文の金額の列は法定の項目で、作った後に変えられないので、送料と受け取った額は作る時に入れる。
 * 返金の試験の道具は Task 1 が order-fixtures.ts に足すが、その名前に頼らず、この試験の中で作る。
 */
async function createPaidOrder(db: PgClient, options: { quantity: number; shippingAmount?: number }): Promise<PaidOrder> {
  const shippingAmount = options.shippingAmount ?? 0;
  const catalog = await createCatalogFixture(db, { stock: options.quantity + 3 });
  const suffix = uniqueSuffix();
  const subtotal = PRICE * options.quantity;
  const totalAmount = subtotal + shippingAmount;
  const paymentIntentId = `pi_pgrst_refund_${suffix}`;
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status,
        subtotal_amount, shipping_amount, total_amount, paid_amount, currency,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture,
        shipping_city, shipping_address, shipping_phone)
     values ($1, $2, $3, 'paid'::public.order_status, $4, $5, $6, $6, 'jpy',
             'fixture@example.com', '山田 花子', '1500001', '東京都', '渋谷区', '神宮前1-1-1', '0311112222')
     returning id`,
    [`fx-order-${suffix}`, `cs_fx_${suffix}`, paymentIntentId, subtotal, shippingAmount, totalAmount],
  );
  const orderId = order.rows[0].id as string;
  const line = await db.query(
    `insert into public.order_items
       (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type)
     values ($1, $2, '照合テスト', $3, 'BLACK', 'M', $4, $5, $6, 'stock')
     returning id`,
    [orderId, catalog.itemId, PRICE, options.quantity, subtotal, catalog.variantId],
  );
  const orderItemId = line.rows[0].id as string;
  await db.query(
    `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
     values ($1, $2, 'purchase', $3, $4)`,
    [catalog.variantId, -options.quantity, orderId, orderItemId],
  );
  return { orderId, orderItemId, paymentIntentId, totalAmount };
}

/** Stripe の返金の返事（既定は成功）。返金の番号は毎回変わる。表の CHECK（P29: `^[a-z]{2,4}_[A-Za-z0-9]+$`）に合うよう、re_ の後は英数字だけ */
function stripeFields(overrides: Partial<StripeRefundFields> = {}): StripeRefundFields {
  return {
    stripeRefundId: `re_pgrst${uniqueSuffix()}`,
    stripeStatus: 'succeeded',
    pendingReason: null,
    failureReason: null,
    customerActionExpiresAt: null,
    paymentMethodType: 'card',
    referenceNumber: null,
    referenceType: null,
    ...overrides,
  };
}

async function refusalOf(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(
    () => null,
    (error: unknown) => error,
  );
}

describeLocalDb('integration: 返金の記録の窓口を実際の PostgREST に通す', (db) => {
  if (!LOCAL_API_URL || !LOCAL_SERVICE_ROLE_KEY) {
    test.skip('LOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY 未設定のためスキップ', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルの API 以外では実行しない', () => {
      throw new Error('消せない試験注文が残るため、localhost 以外の LOCAL_SUPABASE_URL では実行しない');
    });
    return;
  }

  const apiUrl = LOCAL_API_URL;
  const serviceRoleKey = LOCAL_SERVICE_ROLE_KEY;
  let client: SupabaseClient;
  let actor: Actor;

  beforeAll(async () => {
    client = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    mockRouteClient = client;
    actor = await createActor(db());
  });

  /** 管理画面の返金の入力。既定は、商品を1つ・発送前・在庫に戻す・送料なし・額は商品1つ分 */
  function adminRefund(order: PaidOrder, overrides: Partial<BeginRefundInput> = {}): BeginRefundInput {
    return {
      orderId: order.orderId,
      source: 'admin',
      requestKey: crypto.randomUUID(),
      lines: [{ orderItemId: order.orderItemId, quantity: 1, beforeShipment: true }],
      restock: true,
      shippingAmount: 0,
      amount: PRICE,
      note: 'PostgREST の試験',
      stripeReason: 'requested_by_customer',
      cancelReason: null,
      notifyCustomer: true,
      actorId: actor.id,
      ...overrides,
    };
  }

  /** 額だけの返金の入力（商品の行なし）。メールは送らない */
  function amountOnlyRefund(order: PaidOrder, amount: number): BeginRefundInput {
    return adminRefund(order, { lines: [], restock: false, amount, notifyCustomer: false });
  }

  async function refundMovements(refundId: string): Promise<Array<{ delta: number; reason: string }>> {
    const res = await db().query('select delta, reason from public.stock_movements where refund_id = $1 order by id', [refundId]);
    return res.rows.map((row) => ({ delta: Number(row.delta), reason: row.reason as string }));
  }

  test('始める: 管理画面の返金の記録が返事待ちで作られ、商品の行に額と在庫に戻す種類が付く。同じ二重防止の番号の送り直しは前の記録を返す', async () => {
    const order = await createPaidOrder(db(), { quantity: 2, shippingAmount: SHIPPING_AMOUNT });
    const input = adminRefund(order);

    const began = await beginOrderRefund(client, input);

    expect(began).toEqual({ refundId: expect.stringMatching(UUID_PATTERN), amount: PRICE, status: 'awaiting_response', replayed: false });
    const stored = await db().query(
      `select source, status, amount, shipping_amount, adjustment_amount, request_key, stripe_reason, notify_customer, actor_id, note
       from public.order_refunds where id = $1`,
      [began.refundId],
    );
    expect(stored.rows).toEqual([
      {
        source: 'admin',
        status: 'awaiting_response',
        amount: PRICE,
        shipping_amount: 0,
        adjustment_amount: 0,
        request_key: input.requestKey,
        stripe_reason: 'requested_by_customer',
        notify_customer: true,
        actor_id: actor.id,
        note: 'PostgREST の試験',
      },
    ]);
    const lines = await db().query(
      'select order_item_id, quantity, before_shipment, restock_type, amount from public.order_refund_lines where refund_id = $1',
      [began.refundId],
    );
    expect(lines.rows).toEqual([
      { order_item_id: order.orderItemId, quantity: 1, before_shipment: true, restock_type: 'cancel', amount: PRICE },
    ]);

    // 同じ番号・同じ中身の送り直し: 前の記録が返り、記録は増えない
    expect(await beginOrderRefund(client, input)).toEqual({ ...began, replayed: true });
    const count = await db().query('select count(*)::int as count from public.order_refunds where order_id = $1', [order.orderId]);
    expect(count.rows[0].count).toBe(1);

    // 同じ番号で中身が違えば断る。返事待ちがある間は、別の番号の返金も断る
    expect(await refusalOf(beginOrderRefund(client, { ...input, amount: PRICE - 1000 }))).toMatchObject({ code: 'refund_request_mismatch' });
    const second = await refusalOf(beginOrderRefund(client, adminRefund(order)));
    expect(second).toBeInstanceOf(RefundOperationError);
    expect(second).toMatchObject({ code: 'awaiting_refund_exists' });

    await markOrderRefundError(client, began.refundId, 'stripe_rejected', false);
  });

  test('断り: 未発送を超える数は、DB の言葉が PostgREST を通っても quantity_exceeds_unshipped の記号に直る。断った返金は何も書かない', async () => {
    const order = await createPaidOrder(db(), { quantity: 2 });
    const input = adminRefund(order, { lines: [{ orderItemId: order.orderItemId, quantity: 3, beforeShipment: true }] });

    const refusal = await refusalOf(beginOrderRefund(client, input));
    expect(refusal).toBeInstanceOf(RefundOperationError);
    expect(refusal).toMatchObject({ code: 'quantity_exceeds_unshipped' });

    // 窓口が拾う前の、PostgREST の誤りの文から DB の言葉を拾えること
    const raw = await client.rpc('begin_order_refund', {
      _order_id: input.orderId,
      _source: 'admin',
      _request_key: input.requestKey,
      _lines: [{ order_item_id: order.orderItemId, quantity: 3, before_shipment: true }],
      _restock: true,
      _shipping_amount: 0,
      _amount: PRICE,
      _note: null,
      _stripe_reason: 'requested_by_customer',
      _cancel_reason: null,
      _notify_customer: true,
      _actor_id: actor.id,
      _received_amount: null,
    });
    expect(raw.data).toBeNull();
    expect(toRefundErrorCode(raw.error?.message)).toBe('quantity_exceeds_unshipped');

    // 存在しない注文は別の SQLSTATE（P0002）で止まるが、同じように記号に直る
    expect(await refusalOf(beginOrderRefund(client, { ...input, orderId: crypto.randomUUID() }))).toMatchObject({ code: 'order_not_found' });

    const stored = await db().query('select count(*)::int as count from public.order_refunds where order_id = $1', [order.orderId]);
    expect(stored.rows[0].count).toBe(0);
  });

  test('結果を書く: 成功の返金は在庫・メールの予定・注文の額を1回で書く。同じ結果の2回目と、順番の逆転した古い保留の知らせは何も動かさない', async () => {
    const order = await createPaidOrder(db(), { quantity: 2, shippingAmount: SHIPPING_AMOUNT });
    const began = await beginOrderRefund(client, adminRefund(order));
    const fields = stripeFields();

    const result = await recordOrderRefundResult(client, began.refundId, fields);

    expect(result).toEqual({
      refundId: began.refundId,
      orderId: order.orderId,
      status: 'succeeded',
      newlyAccepted: true,
      newlyFailed: false,
      orderStatus: 'paid',
      refundedAmount: PRICE,
      rereserveShortage: 0,
      emailEnqueued: true,
      exceptionId: null,
    });
    // 在庫に戻す: 確保を外した1つが、台帳に refund の +1 で入る
    expect(await refundMovements(began.refundId)).toEqual([{ delta: 1, reason: 'refund' }]);
    const mails = await db().query('select kind, variant, status from private.order_email_outbox where refund_id = $1', [began.refundId]);
    expect(mails.rows).toEqual([{ kind: 'refund', variant: 'standard', status: 'pending' }]);
    const order1 = await db().query('select status::text as status, refunded_amount from public.orders where id = $1', [order.orderId]);
    expect(order1.rows).toEqual([{ status: 'paid', refunded_amount: PRICE }]);

    // 同じ結果をもう一度書いても、台帳もメールも増えない
    expect(await recordOrderRefundResult(client, began.refundId, fields)).toMatchObject({
      status: 'succeeded',
      newlyAccepted: false,
      newlyFailed: false,
      emailEnqueued: false,
    });
    // Stripe の知らせは順番どおりに届かない。成功の後に古い「保留」が届いても、誤りにせず今の値を返す
    expect(
      await recordOrderRefundResult(client, began.refundId, { ...fields, stripeStatus: 'pending', pendingReason: 'processing' }),
    ).toMatchObject({ status: 'succeeded', newlyAccepted: false });
    expect(await refundMovements(began.refundId)).toEqual([{ delta: 1, reason: 'refund' }]);
    const mailCount = await db().query('select count(*)::int as count from private.order_email_outbox where refund_id = $1', [began.refundId]);
    expect(mailCount.rows[0].count).toBe(1);

    // 読み出しの答えの形（Task 4 の `OrderRefundRef` は、この8つのほかに `stripeReason`・`actorId`・`failureReason` を持つので、`toMatchObject` で見る）
    expect(await getOrderRefund(client, began.refundId)).toMatchObject({
      refundId: began.refundId,
      orderId: order.orderId,
      source: 'admin',
      status: 'succeeded',
      stripeRefundId: fields.stripeRefundId,
      amount: PRICE,
      paymentIntentId: order.paymentIntentId,
      createdAt: expect.any(String),
    });
    expect(await getOrderRefund(client, crypto.randomUUID())).toBeNull();
    expect(await listOrderRefunds(client, order.orderId)).toEqual([
      expect.objectContaining({
        refundId: began.refundId,
        source: 'admin',
        status: 'succeeded',
        stripeStatus: 'succeeded',
        paymentMethodType: 'card',
        amount: PRICE,
        shippingAmount: 0,
        adjustmentAmount: 0,
        note: 'PostgREST の試験',
        stripeReason: 'requested_by_customer',
        cancelReason: null,
        notifyCustomer: true,
        actorEmail: actor.email,
        acceptedAt: expect.any(String),
        succeededAt: expect.any(String),
        failedAt: null,
        erroredAt: null,
        lines: [
          {
            orderItemId: order.orderItemId,
            quantity: 1,
            beforeShipment: true,
            restockType: 'cancel',
            amount: PRICE,
            releasedQuantity: 1,
            restockedQuantity: 1,
            rereservedQuantity: 0,
            rereserveShortage: 0,
          },
        ],
      }),
    ]);
  });

  test('エラーにする: 返事待ちだけがエラーになり、要対応「返金の失敗」と一覧の印が付く。システムが閉じるまで開いたまま', async () => {
    const order = await createPaidOrder(db(), { quantity: 2 });
    const began = await beginOrderRefund(client, adminRefund(order));

    const marked = await markOrderRefundError(client, began.refundId, 'not_found_in_stripe', true);

    expect(marked).toEqual({ outcome: 'errored', orderId: order.orderId, exceptionId: expect.stringMatching(UUID_PATTERN) });
    const exceptionId = marked.exceptionId as string;
    const stored = await db().query(
      'select status, stripe_failure_reason, errored_at is not null as errored from public.order_refunds where id = $1',
      [began.refundId],
    );
    expect(stored.rows).toEqual([{ status: 'error', stripe_failure_reason: 'not_found_in_stripe', errored: true }]);
    const exception = await db().query(
      'select reason, detail, order_id, resolved_at is not null as resolved from public.payment_exceptions where id = $1',
      [exceptionId],
    );
    expect(exception.rows).toEqual([{ reason: 'refund_failed', detail: 'not_found_in_stripe', order_id: order.orderId, resolved: false }]);
    expect((await listOrderRefundSummaries(client, [order.orderId])).get(order.orderId)).toMatchObject({
      hasUnresolvedRefundFailure: true,
      openAmount: 0,
    });

    // もう一度押しても、何も起きない（返事待ちではない）
    expect(await markOrderRefundError(client, began.refundId, 'not_found_in_stripe', true)).toMatchObject({ outcome: 'not_awaiting' });
    // 自動の返金の後のように、システムが閉じる。閉じ済みは false
    expect(await resolvePaymentExceptionBySystem(client, exceptionId, 'システムが自動で解決した')).toBe(true);
    expect(await resolvePaymentExceptionBySystem(client, exceptionId, 'システムが自動で解決した')).toBe(false);
    expect((await listOrderRefundSummaries(client, [order.orderId])).get(order.orderId)).toMatchObject({
      hasUnresolvedRefundFailure: false,
    });

    // エラーの返金は数えない。同じ注文に、すぐ別の返金を始められる
    const again = await beginOrderRefund(client, adminRefund(order));
    expect(again.status).toBe('awaiting_response');
    await markOrderRefundError(client, again.refundId, 'stripe_rejected', false);
  });

  test('外からの返金: Stripe の画面の全額の返金は、未発送の商品を全部入れて在庫に戻し、キャンセルにする。同じ返金を2回送っても1行。切り替えより前の返金は写し', async () => {
    const order = await createPaidOrder(db(), { quantity: 2, shippingAmount: SHIPPING_AMOUNT });
    const input = {
      orderId: order.orderId,
      amount: order.totalAmount,
      stripeReason: null,
      stripeCreatedAt: new Date().toISOString(),
      ...stripeFields(),
    };

    const recorded = await recordExternalOrderRefund(client, input);

    expect(recorded).toEqual({
      refundId: expect.stringMatching(UUID_PATTERN),
      orderId: order.orderId,
      created: true,
      source: 'stripe_dashboard',
      status: 'succeeded',
      newlyAccepted: true,
      newlyFailed: false,
      orderStatus: 'cancelled',
      refundedAmount: order.totalAmount,
      rereserveShortage: 0,
      emailEnqueued: true,
      exceptionId: null,
    });
    // 全額なので、未発送の商品2つが全部、発送前の行に入り、在庫に戻る。送料も全額
    expect(await listOrderRefunds(client, order.orderId)).toEqual([
      expect.objectContaining({
        refundId: recorded.refundId,
        source: 'stripe_dashboard',
        status: 'succeeded',
        amount: order.totalAmount,
        shippingAmount: SHIPPING_AMOUNT,
        adjustmentAmount: 0,
        notifyCustomer: true,
        actorEmail: null,
        lines: [
          expect.objectContaining({
            orderItemId: order.orderItemId,
            quantity: 2,
            beforeShipment: true,
            restockType: 'cancel',
            amount: PRICE * 2,
            releasedQuantity: 2,
            restockedQuantity: 2,
          }),
        ],
      }),
    ]);
    expect(await refundMovements(recorded.refundId)).toEqual([{ delta: 2, reason: 'refund' }]);

    // 同じ Stripe の返金の番号をもう一度送っても、記録は増えず、在庫もメールも動かさない
    expect(await recordExternalOrderRefund(client, input)).toMatchObject({
      refundId: recorded.refundId,
      created: false,
      newlyAccepted: false,
      emailEnqueued: false,
      orderStatus: 'cancelled',
    });
    const rows = await db().query('select count(*)::int as count from public.order_refunds where order_id = $1', [order.orderId]);
    expect(rows.rows[0].count).toBe(1);
    expect(await refundMovements(recorded.refundId)).toEqual([{ delta: 2, reason: 'refund' }]);

    // 切り替えより前に作られた返金は、写し（legacy）。商品の行も、在庫も、メールも動かさない
    const old = await createPaidOrder(db(), { quantity: 2 });
    const legacy = await recordExternalOrderRefund(client, {
      orderId: old.orderId,
      amount: 3000,
      stripeReason: null,
      stripeCreatedAt: '2020-01-01T00:00:00.000Z',
      ...stripeFields(),
    });
    expect(legacy).toMatchObject({
      created: true,
      source: 'legacy',
      status: 'succeeded',
      emailEnqueued: false,
      orderStatus: 'paid',
      refundedAmount: 3000,
    });
    const copy = await db().query(
      'select notify_customer, stock_applied_at, email_enqueued_at from public.order_refunds where id = $1',
      [legacy.refundId],
    );
    expect(copy.rows).toEqual([{ notify_customer: false, stock_applied_at: null, email_enqueued_at: null }]);
    const copyLines = await db().query('select count(*)::int as count from public.order_refund_lines where refund_id = $1', [legacy.refundId]);
    expect(copyLines.rows[0].count).toBe(0);
    expect(await refundMovements(legacy.refundId)).toEqual([]);
  });

  test('材料: 注文・商品の数・返事待ちの返金が出る。注文が無ければ null', async () => {
    const order = await createPaidOrder(db(), { quantity: 2, shippingAmount: SHIPPING_AMOUNT });

    // 商品の名前・色・サイズは order_items、支払い方法は下書きから読む（下書きの無い注文は unknown）
    expect(await loadRefundMaterials(client, order.orderId)).toEqual({
      order: {
        id: order.orderId,
        orderNumber: `ORD-${order.orderId.slice(0, 8).toUpperCase()}`,
        status: 'paid',
        paymentMethod: 'unknown',
        totalAmount: order.totalAmount,
        shippingAmount: SHIPPING_AMOUNT,
        discountAmount: 0,
        paidAmount: order.totalAmount,
        succeededAmount: 0,
        openAmount: 0,
        refundableAmount: order.totalAmount,
        refundedShipping: 0,
        refundableShipping: SHIPPING_AMOUNT,
        shippedTotal: 0,
        unshippedTotal: 2,
      },
      lines: [
        {
          orderItemId: order.orderItemId,
          name: '照合テスト',
          color: 'BLACK',
          size: 'M',
          fulfillmentType: 'stock',
          itemPrice: PRICE,
          quantity: 2,
          lineTotal: PRICE * 2,
          shipped: 0,
          unshipped: 2,
          refundedBeforeShipment: 0,
          refundedAfterShipment: 0,
          shippedRefundable: 0,
          restockable: 2,
          lineDiscount: 0,
          refundedUnits: 0,
        },
      ],
      awaitingRefund: null,
    });

    // 返事待ちの返金は、未発送から引かれ、返せる額から引かれ、画面には「確かめ中の返金」として出る
    const began = await beginOrderRefund(client, adminRefund(order));
    expect(await loadRefundMaterials(client, order.orderId)).toMatchObject({
      order: { openAmount: PRICE, refundableAmount: order.totalAmount - PRICE, unshippedTotal: 1 },
      lines: [{ unshipped: 1, refundedBeforeShipment: 1, refundedUnits: 1, restockable: 1 }],
      awaitingRefund: { id: began.refundId, amount: PRICE, createdAt: expect.any(String) },
    });

    expect(await loadRefundMaterials(client, crypto.randomUUID())).toBeNull();
    await markOrderRefundError(client, began.refundId, 'stripe_rejected', false);
  });

  test('見回りの材料: 返事待ちの一覧は古い順で olderThan より前だけ。保留の返金の支払いは、重複なしで出る', async () => {
    const order = await createPaidOrder(db(), { quantity: 2 });
    const first = await beginOrderRefund(client, amountOnlyRefund(order, 1000));

    const listed = await listAwaitingOrderRefunds(client, new Date(Date.now() + 60_000), 200);

    expect(listed).toContainEqual({
      refundId: first.refundId,
      orderId: order.orderId,
      paymentIntentId: order.paymentIntentId,
      createdAt: expect.any(String),
    });
    const times = listed.map((row) => Date.parse(row.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // 頼んだばかりの返金は、olderThan が1時間前なら入らない
    const older = await listAwaitingOrderRefunds(client, new Date(Date.now() - 3_600_000), 200);
    expect(older.map((row) => row.refundId)).not.toContain(first.refundId);

    // 保留の返金が2件ある注文の支払いは、1回だけ出る
    const firstPending = stripeFields({ stripeStatus: 'pending', pendingReason: 'processing' });
    await recordOrderRefundResult(client, first.refundId, firstPending);
    const second = await beginOrderRefund(client, amountOnlyRefund(order, 1000));
    const secondPending = stripeFields({ stripeStatus: 'pending', pendingReason: 'processing' });
    await recordOrderRefundResult(client, second.refundId, secondPending);
    const pendingPaymentIntents = await listPendingRefundPaymentIntents(client, 500);
    expect(pendingPaymentIntents.filter((paymentIntentId) => paymentIntentId === order.paymentIntentId)).toHaveLength(1);

    // 終わらせておく
    await recordOrderRefundResult(client, first.refundId, { ...firstPending, stripeStatus: 'succeeded', pendingReason: null });
    await recordOrderRefundResult(client, second.refundId, { ...secondPending, stripeStatus: 'succeeded', pendingReason: null });
  });

  test('要約: 渡した注文ごとに、返事待ち・保留の額と返せる額が出る（uuid[] で複数の注文）', async () => {
    const withOpen = await createPaidOrder(db(), { quantity: 2, shippingAmount: SHIPPING_AMOUNT });
    const untouched = await createPaidOrder(db(), { quantity: 2 });
    const began = await beginOrderRefund(client, amountOnlyRefund(withOpen, 1000));

    const summaries = await listOrderRefundSummaries(client, [withOpen.orderId, untouched.orderId]);

    expect(summaries.size).toBe(2);
    expect(summaries.get(withOpen.orderId)).toEqual({
      orderId: withOpen.orderId,
      paidAmount: withOpen.totalAmount,
      succeededAmount: 0,
      openAmount: 1000,
      refundableAmount: withOpen.totalAmount - 1000,
      hasOpenRefund: true,
      hasUnresolvedRefundFailure: false,
    });
    expect(summaries.get(untouched.orderId)).toEqual({
      orderId: untouched.orderId,
      paidAmount: untouched.totalAmount,
      succeededAmount: 0,
      openAmount: 0,
      refundableAmount: untouched.totalAmount,
      hasOpenRefund: false,
      hasUnresolvedRefundFailure: false,
    });

    await markOrderRefundError(client, began.refundId, 'stripe_rejected', false);
  });

  test('要対応の窓口: 返金の失敗の行の額と、確保し直せなかった商品の名前・数が、返金の商品の行から商品を埋め込む select で読める（Stripe の返金の番号の行・記録の番号の行）', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exceptionIds: string[] = [];
    try {
      // ① Stripe の返金の番号を持つ失敗。3つのうち2つを返金して受け付けられ（保留）、失敗するまでの間に在庫が売れて、1つが確保し直せなかった
      const stripeOrder = await createPaidOrder(db(), { quantity: 3 });
      const accepted = stripeFields({ stripeStatus: 'pending', pendingReason: 'processing' });
      const stripeRefund = await beginOrderRefund(
        client,
        adminRefund(stripeOrder, {
          lines: [{ orderItemId: stripeOrder.orderItemId, quantity: 2, beforeShipment: true }],
          amount: PRICE * 2,
        }),
      );
      await recordOrderRefundResult(client, stripeRefund.refundId, accepted);
      const variant = await db().query('select variant_id from public.order_items where id = $1', [stripeOrder.orderItemId]);
      const variantId = variant.rows[0].variant_id as number;
      const stockNow = await variantStock(db(), variantId);
      await db().query(
        "insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'adjustment', 'sold elsewhere')",
        [variantId, -(stockNow - 1)],
      );
      const failed = await recordOrderRefundResult(client, stripeRefund.refundId, {
        ...accepted,
        stripeStatus: 'failed',
        pendingReason: null,
        failureReason: 'expired_or_canceled_card',
      });
      expect(failed).toMatchObject({ status: 'failed', newlyFailed: true, rereserveShortage: 1 });
      exceptionIds.push(failed.exceptionId as string);

      // ② 記録の番号を持つ失敗（返事待ちのまま Stripe に見つからなかった。Stripe の返金の番号がまだ無い）。商品は1つで、確保し直しは無い
      const recordOrder = await createPaidOrder(db(), { quantity: 2 });
      const awaiting = await beginOrderRefund(client, adminRefund(recordOrder));
      const marked = await markOrderRefundError(client, awaiting.refundId, 'not_found_in_stripe', true);
      exceptionIds.push(marked.exceptionId as string);

      // 窓口は要対応を古い順に100件まで返す。ほかの結合テストが残した行に押し出されないよう、この試験の2件を一番古くする
      await db().query("update public.payment_exceptions set first_detected_at = '1970-01-01T00:00:00Z' where id = any($1::uuid[])", [
        exceptionIds,
      ]);

      // 窓口そのものを呼ぶ。返金の記録は、窓口が持つ select（返金の商品の行から商品を埋め込む）で読まれる
      const response = (await getOrderAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as {
        status: number;
        body: { data: OrderAttention };
      };

      expect(response.status).toBe(200);
      const failureOf = (orderId: string) => response.body.data.exceptions.find((exception) => exception.orderId === orderId)?.refundFailure;
      expect(failureOf(stripeOrder.orderId)).toEqual({
        amount: PRICE * 2,
        failureReasonLabel: refundFailureReasonLabel('expired_or_canceled_card'),
        shortages: [{ name: '照合テスト（BLACK / M）', quantity: 1 }],
      });
      expect(failureOf(recordOrder.orderId)).toEqual({
        amount: PRICE,
        failureReasonLabel: refundFailureReasonLabel('not_found_in_stripe'),
        shortages: [],
      });
      // 読めなかった時の警告（額0・不足なしに黙って落ちる）が出ていない
      expect(warn.mock.calls.filter(([message]) => String(message).startsWith('[admin.order-attention]'))).toEqual([]);
    } finally {
      warn.mockRestore();
      // ほかの結合テストの全体の一覧に、開いたままの要対応を残さない
      for (const exceptionId of exceptionIds) {
        await resolvePaymentExceptionBySystem(client, exceptionId, '試験の後片付け');
      }
    }
  });

  test('ショップの設定: 既定の値と切り替えの時刻が読め、変えたトグルだけに更新者と時刻が付く', async () => {
    const saved = (await db().query('select * from public.shop_settings where id = 1')).rows[0];
    try {
      const before = await getShopSettings(client);
      expect(before).toEqual({
        autoRefundCancelledOrderPayment: expect.objectContaining({ enabled: saved.auto_refund_cancelled_order_payment }),
        autoCancelAmountMismatch: expect.objectContaining({ enabled: saved.auto_cancel_amount_mismatch }),
        refundLedgerStartedAt: expect.any(String),
      });

      // ②だけを反転する。①は変えないので、更新者と時刻は前のまま
      const flipped = !before.autoCancelAmountMismatch.enabled;
      const updated = await updateShopSettings(client, {
        autoRefundCancelledOrderPayment: before.autoRefundCancelledOrderPayment.enabled,
        autoCancelAmountMismatch: flipped,
        actorId: actor.id,
      });

      expect(updated.autoCancelAmountMismatch).toEqual({ enabled: flipped, updatedAt: expect.any(String), updatedByEmail: actor.email });
      expect(updated.autoRefundCancelledOrderPayment).toEqual(before.autoRefundCancelledOrderPayment);
      expect(updated.refundLedgerStartedAt).toBe(before.refundLedgerStartedAt);
      expect(await getShopSettings(client)).toEqual(updated);
    } finally {
      // ほかの結合テストが読む既定の値と、更新者・時刻を戻す
      await db().query(
        `update public.shop_settings
         set auto_refund_cancelled_order_payment = $1,
             auto_refund_cancelled_order_payment_updated_by = $2,
             auto_refund_cancelled_order_payment_updated_at = $3,
             auto_cancel_amount_mismatch = $4,
             auto_cancel_amount_mismatch_updated_by = $5,
             auto_cancel_amount_mismatch_updated_at = $6
         where id = 1`,
        [
          saved.auto_refund_cancelled_order_payment,
          saved.auto_refund_cancelled_order_payment_updated_by,
          saved.auto_refund_cancelled_order_payment_updated_at,
          saved.auto_cancel_amount_mismatch,
          saved.auto_cancel_amount_mismatch_updated_by,
          saved.auto_cancel_amount_mismatch_updated_at,
        ],
      );
    }
  });
});
