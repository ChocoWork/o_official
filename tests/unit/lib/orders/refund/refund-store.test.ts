import fs from 'node:fs';
import path from 'node:path';
import {
  beginOrderRefund,
  getOrderRefund,
  getShopSettings,
  listAwaitingOrderRefunds,
  listOrderRefundSummaries,
  listOrderRefunds,
  listPendingRefundPaymentIntents,
  markOrderRefundError,
  recordCancelledOrderPaidAmount,
  recordExternalOrderRefund,
  recordOrderRefundResult,
  RefundOperationError,
  RefundStoreError,
  resolvePaymentExceptionBySystem,
  toRefundErrorCode,
  updateShopSettings,
  type BeginRefundInput,
  type RefundStore,
  type StripeRefundFields,
} from '@/lib/orders/refund/refund-store';
import { REFUND_ERROR_CODES, type RefundErrorCode } from '@/lib/orders/refund/refund-types';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const OTHER_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455557777';
const EMPTY_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455558888';
const ACTOR_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'c1b2c3d4-1111-4222-8333-444455556666';
const REFUND_ID = 'd1b2c3d4-1111-4222-8333-444455556666';
const EXCEPTION_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = 'f1b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = 'f1b2c3d4-1111-4222-8333-444455556662';
const STRIPE_REFUND_ID = 're_3AbcXyz123';
const PAYMENT_INTENT_ID = 'pi_3Abc123';

type RpcAnswer = { data?: unknown; error?: { message?: string; code?: string } | null };

/** rpc だけを持つ入れ物。関数の名前ごとに答えを決める。決めていない関数は空の行を返す */
function storeWith(answers: Record<string, RpcAnswer>) {
  const rpc = jest.fn(async (...call: [name: string, args?: Record<string, unknown>]) => {
    const answer = answers[call[0]];
    return { data: answer?.data ?? [], error: answer?.error ?? null };
  });
  return { store: { rpc } as unknown as RefundStore, rpc };
}

/** 版の頭の数字は本番に当てる時に付け替わるので、移行のファイルは名前の後ろで探す */
function migrationText(suffix: string): string {
  const directory = path.join(process.cwd(), 'supabase/migrations');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(suffix));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(directory, files[0]), 'utf8');
}

// 管理画面の返金（道 admin）を始める入力。X を発送前に 1 個、Y を発送後に 1 個、送料 500
const BEGIN_INPUT: BeginRefundInput = {
  orderId: ORDER_ID,
  source: 'admin',
  requestKey: REQUEST_KEY,
  lines: [
    { orderItemId: ITEM_1, quantity: 1, beforeShipment: true },
    { orderItemId: ITEM_2, quantity: 1, beforeShipment: false },
  ],
  restock: true,
  shippingAmount: 500,
  amount: 4055,
  note: '返品の相談あり',
  stripeReason: 'requested_by_customer',
  cancelReason: null,
  notifyCustomer: true,
  actorId: ACTOR_ID,
};

// Stripe が保留で受け付けた返金（コンビニ払い。口座の入力の期限つき）
const PENDING_FIELDS: StripeRefundFields = {
  stripeRefundId: STRIPE_REFUND_ID,
  stripeStatus: 'pending',
  pendingReason: 'processing',
  failureReason: null,
  customerActionExpiresAt: '2026-11-25T00:00:00.000Z',
  paymentMethodType: 'konbini',
  referenceNumber: null,
  referenceType: null,
};

// Stripe の画面から返された、すぐ成功した返金（カード）
const SUCCEEDED_FIELDS: StripeRefundFields = {
  stripeRefundId: STRIPE_REFUND_ID,
  stripeStatus: 'succeeded',
  pendingReason: null,
  failureReason: null,
  customerActionExpiresAt: null,
  paymentMethodType: 'card',
  referenceNumber: null,
  referenceType: null,
};

const EXTERNAL_INPUT = {
  orderId: ORDER_ID,
  amount: 8500,
  stripeReason: 'requested_by_customer',
  stripeCreatedAt: '2026-10-11T03:00:00.000Z',
  ...SUCCEEDED_FIELDS,
};

const SETTINGS_INPUT = { autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: true, actorId: ACTOR_ID };

// 取り消した注文への入金の受け取った額を書く入力（本計画 P27）
const CANCELLED_PAID_INPUT = { orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, receivedAmount: 8500 };

// DB の関数が止める言葉 → 誤りの記号（共通の約束 C-2）
const DB_WORDS = [
  ['ORDER_NOT_FOUND', 'order_not_found'],
  ['ORDER_NOT_REFUNDABLE', 'order_not_refundable'],
  ['ORDER_NOT_CANCELLABLE', 'order_not_cancellable'],
  ['AWAITING_REFUND_EXISTS', 'awaiting_refund_exists'],
  ['REFUND_REQUEST_MISMATCH', 'refund_request_mismatch'],
  ['REFUND_LINE_NOT_IN_ORDER', 'refund_line_not_in_order'],
  ['REFUND_QUANTITY_EXCEEDS_UNSHIPPED', 'quantity_exceeds_unshipped'],
  ['REFUND_QUANTITY_EXCEEDS_SHIPPED', 'quantity_exceeds_shipped'],
  ['REFUND_SHIPPING_EXCEEDS', 'shipping_exceeds'],
  ['REFUND_EXCEEDS_REFUNDABLE', 'exceeds_refundable'],
  ['REFUND_MUST_INCLUDE_UNSHIPPED', 'must_include_unshipped'],
  ['REFUND_MUST_BE_FULL', 'must_be_full'],
  ['REFUND_ARGUMENT_INVALID', 'invalid_argument'],
  ['SETTINGS_ARGUMENT_INVALID', 'invalid_argument'],
] as const satisfies ReadonlyArray<readonly [string, RefundErrorCode]>;

// TS が呼ぶ DB の関数（移行 B・C。load_order_refund_materials は refund-materials.ts が呼ぶ）
const RPC_NAMES = [
  'begin_order_refund',
  'get_order_refund',
  'load_order_refund_materials',
  'list_order_refunds',
  'list_awaiting_order_refunds',
  'list_pending_refund_payment_intents',
  'get_shop_settings',
  'admin_update_shop_settings',
  'record_order_refund_result',
  'record_external_order_refund',
  'mark_order_refund_error',
  'record_cancelled_order_paid_amount',
  'list_order_refund_summaries',
  'resolve_payment_exception_by_system',
];

describe('toRefundErrorCode', () => {
  it.each(DB_WORDS)('DB の言葉 %s は %s', (word, code) => {
    expect(toRefundErrorCode(word)).toBe(code);
    // PostgREST は言葉の前後に別の文を足すことがある
    expect(toRefundErrorCode(`error: ${word} (detail)`)).toBe(code);
  });

  it('13の記号が全部、どれかの DB の言葉から届く', () => {
    expect(new Set(DB_WORDS.map(([, code]) => code))).toEqual(new Set(REFUND_ERROR_CODES));
  });

  it('言葉は長い物から先に照らす: 2つの言葉が両方入った文は、表に書いた順ではなく、長い方の記号になる（Review Focus 3）', () => {
    // REFUND_QUANTITY_EXCEEDS_UNSHIPPED を REFUND_QUANTITY_EXCEEDS_SHIPPED より先に照らす
    expect(toRefundErrorCode('REFUND_QUANTITY_EXCEEDS_SHIPPED / REFUND_QUANTITY_EXCEEDS_UNSHIPPED')).toBe('quantity_exceeds_unshipped');
    expect(toRefundErrorCode('REFUND_QUANTITY_EXCEEDS_UNSHIPPED / REFUND_QUANTITY_EXCEEDS_SHIPPED')).toBe('quantity_exceeds_unshipped');
    // 表の先頭の短い ORDER_NOT_FOUND より、後ろの長い REFUND_MUST_BE_FULL が先に当たる
    expect(toRefundErrorCode('ORDER_NOT_FOUND / REFUND_MUST_BE_FULL')).toBe('must_be_full');
    expect(toRefundErrorCode('REFUND_MUST_BE_FULL / ORDER_NOT_FOUND')).toBe('must_be_full');
  });

  it('表に無い言葉・空・undefined は null', () => {
    expect(toRefundErrorCode('TOO_MANY_ORDERS')).toBeNull();
    expect(toRefundErrorCode('REFUND_NOT_FOUND')).toBeNull();
    expect(toRefundErrorCode('connection refused')).toBeNull();
    expect(toRefundErrorCode('')).toBeNull();
    expect(toRefundErrorCode(undefined)).toBeNull();
  });

  it('DB の関数が止める言葉は、移行の本文にある（綴りが食い違うと、画面に出る言葉が変わる）', () => {
    const sql = `${migrationText('_order_refund_requests.sql')}\n${migrationText('_order_refund_results.sql')}`;

    for (const [word] of DB_WORDS) {
      expect(sql).toContain(word);
    }
  });

  it('TS が呼ぶ DB の関数の名前は、移行の本文にある（名前が食い違うと、呼んだ時に初めて分かる）', () => {
    const sql = `${migrationText('_order_refund_requests.sql')}\n${migrationText('_order_refund_results.sql')}`;

    for (const name of RPC_NAMES) {
      expect(sql).toContain(`FUNCTION public.${name}(`);
    }
  });
});

describe('知らない DB の失敗は、どの呼び出しでも RefundStoreError（DB の文はメッセージに入れず、cause にだけ残す）', () => {
  const dbError = { message: '宛先・氏名を含む DB の文', code: '08006' };
  const CALLS: Array<[rpcName: string, run: (store: RefundStore) => Promise<unknown>]> = [
    ['begin_order_refund', (store) => beginOrderRefund(store, BEGIN_INPUT)],
    ['record_order_refund_result', (store) => recordOrderRefundResult(store, REFUND_ID, PENDING_FIELDS)],
    ['record_external_order_refund', (store) => recordExternalOrderRefund(store, EXTERNAL_INPUT)],
    ['mark_order_refund_error', (store) => markOrderRefundError(store, REFUND_ID, 'stripe_rejected', false)],
    ['record_cancelled_order_paid_amount', (store) => recordCancelledOrderPaidAmount(store, CANCELLED_PAID_INPUT)],
    ['get_order_refund', (store) => getOrderRefund(store, REFUND_ID)],
    ['list_order_refunds', (store) => listOrderRefunds(store, ORDER_ID)],
    ['list_awaiting_order_refunds', (store) => listAwaitingOrderRefunds(store, new Date('2026-10-11T02:45:00.000Z'), 20)],
    ['list_pending_refund_payment_intents', (store) => listPendingRefundPaymentIntents(store, 500)],
    ['list_order_refund_summaries', (store) => listOrderRefundSummaries(store, [ORDER_ID])],
    ['get_shop_settings', (store) => getShopSettings(store)],
    ['admin_update_shop_settings', (store) => updateShopSettings(store, SETTINGS_INPUT)],
    ['resolve_payment_exception_by_system', (store) => resolvePaymentExceptionBySystem(store, EXCEPTION_ID, 'メモ')],
  ];

  it.each(CALLS)('%s', async (rpcName, run) => {
    const { store } = storeWith({ [rpcName]: { error: dbError } });

    const error = (await run(store).catch((caught: unknown) => caught)) as RefundStoreError;

    expect(error).toBeInstanceOf(RefundStoreError);
    expect(error).not.toBeInstanceOf(RefundOperationError);
    expect(error.message).toBe(`refund store failed: ${rpcName}`);
    expect(error.operation).toBe(rpcName);
    expect(error.code).toBe('08006');
    expect(error.cause).toEqual(dbError);
  });
});

describe('beginOrderRefund', () => {
  it('DB の関数の引数名のとおりに渡し、1行の答えを窓口の形に直す。受け取った額は渡さなければ null', async () => {
    const { store, rpc } = storeWith({
      begin_order_refund: { data: [{ refund_id: REFUND_ID, amount: 4055, status: 'awaiting_response', replayed: false }] },
    });

    await expect(beginOrderRefund(store, BEGIN_INPUT)).resolves.toEqual({
      refundId: REFUND_ID, amount: 4055, status: 'awaiting_response', replayed: false,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('begin_order_refund', {
      _order_id: ORDER_ID,
      _source: 'admin',
      _request_key: REQUEST_KEY,
      _lines: [
        { order_item_id: ITEM_1, quantity: 1, before_shipment: true },
        { order_item_id: ITEM_2, quantity: 1, before_shipment: false },
      ],
      _restock: true,
      _shipping_amount: 500,
      _amount: 4055,
      _note: '返品の相談あり',
      _stripe_reason: 'requested_by_customer',
      _cancel_reason: null,
      _notify_customer: true,
      _actor_id: ACTOR_ID,
      _received_amount: null,
    });
  });

  it('システムが始める返金（自動の返金①）は、二重防止の番号・実行した人・商品の行が空で、受け取った額を渡す', async () => {
    const { store, rpc } = storeWith({
      begin_order_refund: { data: [{ refund_id: REFUND_ID, amount: 8500, status: 'awaiting_response', replayed: false }] },
    });

    await beginOrderRefund(store, {
      orderId: ORDER_ID,
      source: 'auto_cancelled_order_payment',
      requestKey: null,
      lines: [],
      restock: false,
      shippingAmount: 0,
      amount: 8500,
      note: null,
      stripeReason: null,
      cancelReason: null,
      notifyCustomer: true,
      actorId: null,
      receivedAmount: 8500,
    });

    expect(rpc).toHaveBeenCalledWith('begin_order_refund', {
      _order_id: ORDER_ID,
      _source: 'auto_cancelled_order_payment',
      _request_key: null,
      _lines: [],
      _restock: false,
      _shipping_amount: 0,
      _amount: 8500,
      _note: null,
      _stripe_reason: null,
      _cancel_reason: null,
      _notify_customer: true,
      _actor_id: null,
      _received_amount: 8500,
    });
  });

  it('同じ二重防止の番号の送り直しは、前の記録をそのまま返す（replayed が true。Review Focus 1）', async () => {
    // PostgREST は行を1つのオブジェクトで返すこともある
    const { store } = storeWith({
      begin_order_refund: { data: { refund_id: REFUND_ID, amount: 4055, status: 'pending', replayed: true } },
    });

    await expect(beginOrderRefund(store, BEGIN_INPUT)).resolves.toEqual({
      refundId: REFUND_ID, amount: 4055, status: 'pending', replayed: true,
    });
  });

  it.each(['awaiting_response', 'error', 'pending', 'succeeded', 'failed'] as const)(
    '送り直しで返った記録の状態 %s は、そのまま写す（呼ぶ側が、Stripe に頼み直すかを状態で決める）',
    async (status) => {
      const { store } = storeWith({
        begin_order_refund: { data: [{ refund_id: REFUND_ID, amount: 4055, status, replayed: true }] },
      });

      await expect(beginOrderRefund(store, BEGIN_INPUT)).resolves.toMatchObject({ status, replayed: true });
    },
  );

  it.each([
    ['REFUND_QUANTITY_EXCEEDS_UNSHIPPED', 'quantity_exceeds_unshipped'],
    ['REFUND_QUANTITY_EXCEEDS_SHIPPED', 'quantity_exceeds_shipped'],
    ['AWAITING_REFUND_EXISTS', 'awaiting_refund_exists'],
    ['REFUND_REQUEST_MISMATCH', 'refund_request_mismatch'],
  ] as const)('DB が %s で断れば、記号 %s を持つ RefundOperationError（Review Focus 3）', async (word, code) => {
    const { store } = storeWith({ begin_order_refund: { error: { message: word, code: '22023' } } });

    const error = await beginOrderRefund(store, BEGIN_INPUT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RefundOperationError);
    expect(error).toMatchObject({ code });
  });

  it('行が返らなければ RefundStoreError', async () => {
    const { store } = storeWith({ begin_order_refund: { data: [] } });

    await expect(beginOrderRefund(store, BEGIN_INPUT)).rejects.toBeInstanceOf(RefundStoreError);
  });
});

describe('recordOrderRefundResult', () => {
  const RESULT_ROW = {
    refund_id: REFUND_ID, order_id: ORDER_ID, status: 'pending', newly_accepted: true, newly_failed: false,
    order_status: 'paid', refunded_amount: 0, rereserve_shortage: 0, email_enqueued: true, exception_id: null,
  };

  it('DB の関数の引数名のとおりに渡し、1行の答えを窓口の形に直す', async () => {
    const { store, rpc } = storeWith({ record_order_refund_result: { data: [RESULT_ROW] } });

    await expect(recordOrderRefundResult(store, REFUND_ID, PENDING_FIELDS)).resolves.toEqual({
      refundId: REFUND_ID,
      orderId: ORDER_ID,
      status: 'pending',
      newlyAccepted: true,
      newlyFailed: false,
      orderStatus: 'paid',
      refundedAmount: 0,
      rereserveShortage: 0,
      emailEnqueued: true,
      exceptionId: null,
    });

    expect(rpc).toHaveBeenCalledWith('record_order_refund_result', {
      _refund_id: REFUND_ID,
      _stripe_refund_id: STRIPE_REFUND_ID,
      _stripe_status: 'pending',
      _stripe_pending_reason: 'processing',
      _stripe_failure_reason: null,
      _customer_action_expires_at: '2026-11-25T00:00:00.000Z',
      _payment_method_type: 'konbini',
      _reference_number: null,
      _reference_type: null,
    });
  });

  it('失敗の後始末の答え（確保し直せなかった数・要対応の番号）を写す', async () => {
    const { store } = storeWith({
      record_order_refund_result: {
        data: [{
          ...RESULT_ROW, status: 'failed', newly_accepted: false, newly_failed: true, rereserve_shortage: 2,
          email_enqueued: false, exception_id: EXCEPTION_ID,
        }],
      },
    });

    await expect(recordOrderRefundResult(store, REFUND_ID, { ...PENDING_FIELDS, stripeStatus: 'failed', failureReason: 'expired' }))
      .resolves.toMatchObject({
        status: 'failed', newlyAccepted: false, newlyFailed: true, rereserveShortage: 2, emailEnqueued: false, exceptionId: EXCEPTION_ID,
      });
  });

  it('引数の誤りは記号 invalid_argument。返金が無い・Stripe の番号が違う断りは、記号の表に無いので RefundStoreError', async () => {
    const invalid = storeWith({ record_order_refund_result: { error: { message: 'REFUND_ARGUMENT_INVALID', code: '22023' } } });
    await expect(recordOrderRefundResult(invalid.store, REFUND_ID, PENDING_FIELDS)).rejects.toMatchObject({ code: 'invalid_argument' });

    for (const word of ['REFUND_NOT_FOUND', 'REFUND_STRIPE_ID_MISMATCH']) {
      const unexpected = storeWith({ record_order_refund_result: { error: { message: word, code: 'P0002' } } });
      const error = await recordOrderRefundResult(unexpected.store, REFUND_ID, PENDING_FIELDS).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RefundStoreError);
      expect(error).not.toBeInstanceOf(RefundOperationError);
    }
  });

  it('行が返らなければ RefundStoreError', async () => {
    const { store } = storeWith({ record_order_refund_result: { data: [] } });

    await expect(recordOrderRefundResult(store, REFUND_ID, PENDING_FIELDS)).rejects.toBeInstanceOf(RefundStoreError);
  });
});

describe('recordExternalOrderRefund', () => {
  const EXTERNAL_ROW = {
    refund_id: REFUND_ID, created: true, source: 'stripe_dashboard', status: 'succeeded', newly_accepted: true,
    newly_failed: false, order_status: 'cancelled', refunded_amount: 8500, rereserve_shortage: 0, email_enqueued: true,
    exception_id: null,
  };

  it('DB の関数の引数名のとおりに渡し、答えを窓口の形に直す。注文の番号は入力の値を写す（DB は返さない）', async () => {
    const { store, rpc } = storeWith({ record_external_order_refund: { data: [EXTERNAL_ROW] } });

    await expect(recordExternalOrderRefund(store, EXTERNAL_INPUT)).resolves.toEqual({
      refundId: REFUND_ID,
      orderId: ORDER_ID,
      created: true,
      source: 'stripe_dashboard',
      status: 'succeeded',
      newlyAccepted: true,
      newlyFailed: false,
      orderStatus: 'cancelled',
      refundedAmount: 8500,
      rereserveShortage: 0,
      emailEnqueued: true,
      exceptionId: null,
    });

    expect(rpc).toHaveBeenCalledWith('record_external_order_refund', {
      _order_id: ORDER_ID,
      _stripe_refund_id: STRIPE_REFUND_ID,
      _amount: 8500,
      _stripe_status: 'succeeded',
      _stripe_pending_reason: null,
      _stripe_failure_reason: null,
      _customer_action_expires_at: null,
      _payment_method_type: 'card',
      _reference_number: null,
      _reference_type: null,
      _stripe_reason: 'requested_by_customer',
      _stripe_created_at: '2026-10-11T03:00:00.000Z',
    });
  });

  it('切り替えの前に作られた返金は legacy の写し。同じ返金を2回目に渡すと created が false', async () => {
    const legacy = storeWith({
      record_external_order_refund: { data: [{ ...EXTERNAL_ROW, source: 'legacy', email_enqueued: false }] },
    });
    await expect(recordExternalOrderRefund(legacy.store, { ...EXTERNAL_INPUT, stripeReason: null })).resolves.toMatchObject({
      created: true, source: 'legacy', emailEnqueued: false,
    });
    expect(legacy.rpc).toHaveBeenCalledWith('record_external_order_refund', expect.objectContaining({ _stripe_reason: null }));

    const again = storeWith({ record_external_order_refund: { data: [{ ...EXTERNAL_ROW, created: false }] } });
    await expect(recordExternalOrderRefund(again.store, EXTERNAL_INPUT)).resolves.toMatchObject({ created: false });
  });

  it('注文が無い断りは記号 order_not_found', async () => {
    const { store } = storeWith({ record_external_order_refund: { error: { message: 'ORDER_NOT_FOUND', code: 'P0002' } } });

    await expect(recordExternalOrderRefund(store, EXTERNAL_INPUT)).rejects.toMatchObject({ code: 'order_not_found' });
  });

  it('行が返らなければ RefundStoreError', async () => {
    const { store } = storeWith({ record_external_order_refund: { data: [] } });

    await expect(recordExternalOrderRefund(store, EXTERNAL_INPUT)).rejects.toBeInstanceOf(RefundStoreError);
  });
});

describe('markOrderRefundError', () => {
  it('DB の関数の引数名のとおりに渡し、エラーにした結果と要対応の番号を返す', async () => {
    const { store, rpc } = storeWith({
      mark_order_refund_error: { data: [{ outcome: 'errored', order_id: ORDER_ID, exception_id: EXCEPTION_ID }] },
    });

    await expect(markOrderRefundError(store, REFUND_ID, 'not_found_in_stripe', true)).resolves.toEqual({
      outcome: 'errored', orderId: ORDER_ID, exceptionId: EXCEPTION_ID,
    });

    expect(rpc).toHaveBeenCalledWith('mark_order_refund_error', {
      _refund_id: REFUND_ID, _reason: 'not_found_in_stripe', _raise_exception: true,
    });
  });

  it('もう返事待ちではなければ not_awaiting（何度押しても同じ結果）。要対応は無い', async () => {
    const { store } = storeWith({
      mark_order_refund_error: { data: [{ outcome: 'not_awaiting', order_id: ORDER_ID, exception_id: null }] },
    });

    await expect(markOrderRefundError(store, REFUND_ID, 'stripe_rejected', false)).resolves.toEqual({
      outcome: 'not_awaiting', orderId: ORDER_ID, exceptionId: null,
    });
  });

  it('引数の誤りは記号 invalid_argument。知らない結果の言葉・行が無い答えは RefundStoreError', async () => {
    const invalid = storeWith({ mark_order_refund_error: { error: { message: 'REFUND_ARGUMENT_INVALID', code: '22023' } } });
    await expect(markOrderRefundError(invalid.store, REFUND_ID, 'x', false)).rejects.toMatchObject({ code: 'invalid_argument' });

    const weird = storeWith({ mark_order_refund_error: { data: [{ outcome: 'weird', order_id: ORDER_ID, exception_id: null }] } });
    await expect(markOrderRefundError(weird.store, REFUND_ID, 'stripe_rejected', false)).rejects.toBeInstanceOf(RefundStoreError);

    const empty = storeWith({ mark_order_refund_error: { data: [] } });
    await expect(markOrderRefundError(empty.store, REFUND_ID, 'stripe_rejected', false)).rejects.toBeInstanceOf(RefundStoreError);
  });
});

describe('recordCancelledOrderPaidAmount（取り消した注文への入金の受け取った額。本計画 P27）', () => {
  it('DB の関数の引数名のとおりに渡し、書いたら true を返す', async () => {
    const { store, rpc } = storeWith({ record_cancelled_order_paid_amount: { data: true } });

    await expect(recordCancelledOrderPaidAmount(store, CANCELLED_PAID_INPUT)).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('record_cancelled_order_paid_amount', {
      _order_id: ORDER_ID, _payment_intent_id: PAYMENT_INTENT_ID, _received_amount: 8500,
    });
  });

  it('書かなかった時（取り消していない・書き済み・注文に別の支払いの番号がある）は false。誤りではない。答えが無い時も「書いた」とは読まない', async () => {
    const notWritten = storeWith({ record_cancelled_order_paid_amount: { data: false } });
    await expect(recordCancelledOrderPaidAmount(notWritten.store, CANCELLED_PAID_INPUT)).resolves.toBe(false);

    // boolean を返す関数なので、PostgREST の答えは true か false そのもの。storeWith は決めていない答えを空の配列にする
    const noAnswer = storeWith({});
    await expect(recordCancelledOrderPaidAmount(noAnswer.store, CANCELLED_PAID_INPUT)).resolves.toBe(false);
  });

  // 表に無い DB の失敗が RefundStoreError になることは、上の「知らない DB の失敗は、どの呼び出しでも RefundStoreError」の表がこの関数も確かめている
  it.each([
    ['REFUND_ARGUMENT_INVALID', 'invalid_argument', '22023'],
    ['ORDER_NOT_FOUND', 'order_not_found', 'P0002'],
  ] as const)('DB が %s で断れば、記号 %s を持つ RefundOperationError', async (word, code, sqlstate) => {
    const { store } = storeWith({ record_cancelled_order_paid_amount: { error: { message: word, code: sqlstate } } });

    const error = await recordCancelledOrderPaidAmount(store, CANCELLED_PAID_INPUT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RefundOperationError);
    expect(error).toMatchObject({ code });
  });
});

describe('getOrderRefund', () => {
  it('返金1件の要点を窓口の形に直す。送り直しと確かめ直しで同じ中身を Stripe に頼むための理由と実行した人も写す。支払いの番号が空でもよい', async () => {
    const { store, rpc } = storeWith({
      get_order_refund: {
        data: [{
          refund_id: REFUND_ID, order_id: ORDER_ID, source: 'admin', status: 'awaiting_response', stripe_refund_id: null,
          amount: 4055, payment_intent_id: null, created_at: '2026-10-11T02:00:00+00:00',
          stripe_reason: 'requested_by_customer', actor_id: ACTOR_ID, stripe_failure_reason: null,
        }],
      },
    });

    await expect(getOrderRefund(store, REFUND_ID)).resolves.toEqual({
      refundId: REFUND_ID, orderId: ORDER_ID, source: 'admin', status: 'awaiting_response', stripeRefundId: null,
      amount: 4055, paymentIntentId: null, createdAt: '2026-10-11T02:00:00+00:00',
      stripeReason: 'requested_by_customer', actorId: ACTOR_ID, failureReason: null,
    });
    expect(rpc).toHaveBeenCalledWith('get_order_refund', { _refund_id: REFUND_ID });
  });

  it('Stripe の番号と支払いの番号があれば写す。理由も実行した人も無い返金（Stripe の画面から）は null で写す。返金が無ければ null', async () => {
    const found = storeWith({
      get_order_refund: {
        data: [{
          refund_id: REFUND_ID, order_id: ORDER_ID, source: 'stripe_dashboard', status: 'succeeded', stripe_refund_id: STRIPE_REFUND_ID,
          amount: 8500, payment_intent_id: PAYMENT_INTENT_ID, created_at: '2026-10-11T02:00:00+00:00',
          stripe_reason: null, actor_id: null, stripe_failure_reason: null,
        }],
      },
    });
    await expect(getOrderRefund(found.store, REFUND_ID)).resolves.toMatchObject({
      stripeRefundId: STRIPE_REFUND_ID, paymentIntentId: PAYMENT_INTENT_ID, stripeReason: null, actorId: null, failureReason: null,
    });

    const none = storeWith({ get_order_refund: { data: [] } });
    await expect(getOrderRefund(none.store, REFUND_ID)).resolves.toBeNull();
  });

  it('エラー・失敗の返金は、失敗の理由（こちらの理由 stripe_rejected か Stripe の記号）も写す', async () => {
    const { store } = storeWith({
      get_order_refund: {
        data: [{
          refund_id: REFUND_ID, order_id: ORDER_ID, source: 'admin', status: 'error', stripe_refund_id: null,
          amount: 4055, payment_intent_id: PAYMENT_INTENT_ID, created_at: '2026-10-11T02:00:00+00:00',
          stripe_reason: 'fraudulent', actor_id: ACTOR_ID, stripe_failure_reason: 'stripe_rejected',
        }],
      },
    });

    await expect(getOrderRefund(store, REFUND_ID)).resolves.toMatchObject({
      status: 'error', stripeReason: 'fraudulent', actorId: ACTOR_ID, failureReason: 'stripe_rejected',
    });
  });
});

describe('listOrderRefunds', () => {
  const REFUND_ROW = {
    refund_id: REFUND_ID, source: 'admin', status: 'succeeded', stripe_status: 'succeeded', stripe_pending_reason: null,
    stripe_failure_reason: null, customer_action_expires_at: null, payment_method_type: 'card', amount: 4055,
    shipping_amount: 500, adjustment_amount: 0, note: '返品の相談あり', stripe_reason: 'requested_by_customer',
    cancel_reason: null, notify_customer: true, actor_email: 'admin@example.com', reference_number: '74123456789012345678901',
    reference_type: 'acquirer_reference_number', created_at: '2026-10-11T02:00:00+00:00', accepted_at: '2026-10-11T02:00:01+00:00',
    succeeded_at: '2026-10-11T02:00:02+00:00', failed_at: null, errored_at: null,
    lines: [{
      order_item_id: ITEM_1, quantity: 1, before_shipment: true, restock_type: 'cancel', amount: 2666, released_quantity: 1,
      restocked_quantity: 1, rereserved_quantity: 0, rereserve_shortage: 0,
    }],
  };

  it('返金の一覧を窓口の形に直す。商品の行は jsonb の配列から読む', async () => {
    const { store, rpc } = storeWith({ list_order_refunds: { data: [REFUND_ROW] } });

    await expect(listOrderRefunds(store, ORDER_ID)).resolves.toEqual([{
      refundId: REFUND_ID,
      source: 'admin',
      status: 'succeeded',
      stripeStatus: 'succeeded',
      pendingReason: null,
      failureReason: null,
      customerActionExpiresAt: null,
      paymentMethodType: 'card',
      amount: 4055,
      shippingAmount: 500,
      adjustmentAmount: 0,
      note: '返品の相談あり',
      stripeReason: 'requested_by_customer',
      cancelReason: null,
      notifyCustomer: true,
      actorEmail: 'admin@example.com',
      referenceNumber: '74123456789012345678901',
      referenceType: 'acquirer_reference_number',
      createdAt: '2026-10-11T02:00:00+00:00',
      acceptedAt: '2026-10-11T02:00:01+00:00',
      succeededAt: '2026-10-11T02:00:02+00:00',
      failedAt: null,
      erroredAt: null,
      lines: [{
        orderItemId: ITEM_1, quantity: 1, beforeShipment: true, restockType: 'cancel', amount: 2666, releasedQuantity: 1,
        restockedQuantity: 1, rereservedQuantity: 0, rereserveShortage: 0,
      }],
    }]);
    expect(rpc).toHaveBeenCalledWith('list_order_refunds', { _order_id: ORDER_ID });
  });

  it('Stripe の画面からの返金（実行した人も商品の行も無い）と、保留・失敗の細目も読める', async () => {
    const { store } = storeWith({
      list_order_refunds: {
        data: [{
          ...REFUND_ROW, source: 'stripe_dashboard', status: 'failed', stripe_status: 'failed', stripe_failure_reason: 'expired',
          customer_action_expires_at: '2026-11-25T00:00:00+00:00', payment_method_type: 'konbini', note: null, stripe_reason: null,
          actor_email: null, reference_number: null, reference_type: null, succeeded_at: null, failed_at: '2026-11-26T00:00:00+00:00',
          lines: null,
        }],
      },
    });

    const [refund] = await listOrderRefunds(store, ORDER_ID);

    expect(refund).toMatchObject({
      source: 'stripe_dashboard', status: 'failed', failureReason: 'expired', customerActionExpiresAt: '2026-11-25T00:00:00+00:00',
      paymentMethodType: 'konbini', note: null, stripeReason: null, actorEmail: null, referenceNumber: null,
      succeededAt: null, failedAt: '2026-11-26T00:00:00+00:00', lines: [],
    });
  });

  it('取消の理由（道 order_cancel）を写す', async () => {
    const { store } = storeWith({
      list_order_refunds: { data: [{ ...REFUND_ROW, source: 'order_cancel', cancel_reason: 'customer_request' }] },
    });

    const [refund] = await listOrderRefunds(store, ORDER_ID);

    expect(refund).toMatchObject({ source: 'order_cancel', cancelReason: 'customer_request' });
  });

  describe('PostgREST の max_rows（1000）で答えが切れうる時', () => {
    const rows = (count: number) => Array.from({ length: count }, () => ({ ...REFUND_ROW }));

    it('1回の答えが 1000 行に届いたら、切れている恐れがあるので RefundStoreError で止める', async () => {
      const { store } = storeWith({ list_order_refunds: { data: rows(1000) } });

      const error = await listOrderRefunds(store, ORDER_ID).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RefundStoreError);
      expect(error).toMatchObject({ operation: 'list_order_refunds' });
    });

    it('999 行なら通る', async () => {
      const { store } = storeWith({ list_order_refunds: { data: rows(999) } });

      await expect(listOrderRefunds(store, ORDER_ID)).resolves.toHaveLength(999);
    });
  });
});

describe('listAwaitingOrderRefunds / listPendingRefundPaymentIntents', () => {
  it('15分より前の返事待ちの返金を、古い順に読む。時刻は ISO の文字で渡す', async () => {
    const { store, rpc } = storeWith({
      list_awaiting_order_refunds: {
        data: [
          { refund_id: REFUND_ID, order_id: ORDER_ID, payment_intent_id: PAYMENT_INTENT_ID, created_at: '2026-10-11T02:00:00+00:00' },
          { refund_id: 'd1b2c3d4-1111-4222-8333-444455556667', order_id: OTHER_ORDER_ID, payment_intent_id: null, created_at: '2026-10-11T02:10:00+00:00' },
        ],
      },
    });

    await expect(listAwaitingOrderRefunds(store, new Date('2026-10-11T02:45:00.000Z'), 20)).resolves.toEqual([
      { refundId: REFUND_ID, orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, createdAt: '2026-10-11T02:00:00+00:00' },
      { refundId: 'd1b2c3d4-1111-4222-8333-444455556667', orderId: OTHER_ORDER_ID, paymentIntentId: null, createdAt: '2026-10-11T02:10:00+00:00' },
    ]);
    expect(rpc).toHaveBeenCalledWith('list_awaiting_order_refunds', { _older_than: '2026-10-11T02:45:00.000Z', _limit: 20 });
  });

  it('保留の返金がある注文の支払いの番号を読む', async () => {
    const { store, rpc } = storeWith({
      list_pending_refund_payment_intents: { data: [{ payment_intent_id: 'pi_3Aaa' }, { payment_intent_id: 'pi_3Bbb' }] },
    });

    await expect(listPendingRefundPaymentIntents(store, 500)).resolves.toEqual(['pi_3Aaa', 'pi_3Bbb']);
    expect(rpc).toHaveBeenCalledWith('list_pending_refund_payment_intents', { _limit: 500 });
  });
});

describe('listOrderRefundSummaries', () => {
  const summaryRow = (orderId: string, overrides: Record<string, unknown> = {}) => ({
    order_id: orderId, paid_amount: 8500, succeeded_amount: 0, open_amount: 8500, refundable_amount: 0,
    has_open_refund: true, has_unresolved_refund_failure: false, ...overrides,
  });
  const summary = (orderId: string, overrides: Record<string, unknown> = {}) => ({
    orderId, paidAmount: 8500, succeededAmount: 0, openAmount: 8500, refundableAmount: 0,
    hasOpenRefund: true, hasUnresolvedRefundFailure: false, ...overrides,
  });

  it('空の入力は DB を呼ばず、空の Map を返す', async () => {
    const { store, rpc } = storeWith({});

    await expect(listOrderRefundSummaries(store, [])).resolves.toEqual(new Map());

    expect(rpc).not.toHaveBeenCalled();
  });

  it('要約を注文ごとに集める。DB が行を返さなかった注文も、受け取った額 null・各額 0・印 false の要約でキーに入る', async () => {
    const { store, rpc } = storeWith({
      list_order_refund_summaries: {
        data: [
          summaryRow(ORDER_ID),
          summaryRow(OTHER_ORDER_ID, {
            paid_amount: null, open_amount: 0, has_open_refund: false, has_unresolved_refund_failure: true,
          }),
        ],
      },
    });

    const result = await listOrderRefundSummaries(store, [ORDER_ID, OTHER_ORDER_ID, EMPTY_ORDER_ID]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_order_refund_summaries', { _order_ids: [ORDER_ID, OTHER_ORDER_ID, EMPTY_ORDER_ID] });
    expect([...result.keys()]).toEqual([ORDER_ID, OTHER_ORDER_ID, EMPTY_ORDER_ID]);
    expect(result.get(ORDER_ID)).toEqual(summary(ORDER_ID));
    expect(result.get(OTHER_ORDER_ID)).toEqual(
      summary(OTHER_ORDER_ID, { paidAmount: null, openAmount: 0, hasOpenRefund: false, hasUnresolvedRefundFailure: true }),
    );
    expect(result.get(EMPTY_ORDER_ID)).toEqual({
      orderId: EMPTY_ORDER_ID, paidAmount: null, succeededAmount: 0, openAmount: 0, refundableAmount: 0,
      hasOpenRefund: false, hasUnresolvedRefundFailure: false,
    });
  });

  it('同じ番号は1回として数える', async () => {
    const { store, rpc } = storeWith({ list_order_refund_summaries: { data: [summaryRow(ORDER_ID)] } });

    const result = await listOrderRefundSummaries(store, [ORDER_ID, ORDER_ID]);

    expect(rpc).toHaveBeenCalledWith('list_order_refund_summaries', { _order_ids: [ORDER_ID] });
    expect(result.size).toBe(1);
  });

  it('大文字の番号を渡すと、RPC へは小文字で渡り、DB が小文字で返した行は渡した文字のキーに入る', async () => {
    const upper = ORDER_ID.toUpperCase();
    // 実際の DB は uuid をいつも小文字で返す
    const { store, rpc } = storeWith({ list_order_refund_summaries: { data: [summaryRow(ORDER_ID)] } });

    const result = await listOrderRefundSummaries(store, [upper]);

    expect(rpc).toHaveBeenCalledWith('list_order_refund_summaries', { _order_ids: [ORDER_ID] });
    expect([...result.keys()]).toEqual([upper]);
    expect(result.get(upper)).toEqual(summary(ORDER_ID));
  });

  it('200件ずつに分けて呼ぶ（DB の関数は201件以上を断るため）。渡した番号は全部キーに入る', async () => {
    const ids = Array.from({ length: 450 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const { store, rpc } = storeWith({ list_order_refund_summaries: { data: [] } });

    const result = await listOrderRefundSummaries(store, ids);

    expect(rpc.mock.calls.map(([, args]) => (args?._order_ids as string[]).length)).toEqual([200, 200, 50]);
    expect(rpc.mock.calls[0][1]?._order_ids).toEqual(ids.slice(0, 200));
    expect(rpc.mock.calls[2][1]?._order_ids).toEqual(ids.slice(400));
    expect(result.size).toBe(450);
  });
});

describe('getShopSettings / updateShopSettings', () => {
  const SETTINGS_ROW = {
    auto_refund_cancelled_order_payment: true,
    auto_refund_cancelled_order_payment_updated_by_email: null,
    auto_refund_cancelled_order_payment_updated_at: null,
    auto_cancel_amount_mismatch: false,
    auto_cancel_amount_mismatch_updated_by_email: 'owner@example.com',
    auto_cancel_amount_mismatch_updated_at: '2026-10-12T01:00:00+00:00',
    refund_ledger_started_at: '2026-10-11T12:00:00+00:00',
  };
  const SETTINGS = {
    autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null },
    autoCancelAmountMismatch: { enabled: false, updatedAt: '2026-10-12T01:00:00+00:00', updatedByEmail: 'owner@example.com' },
    refundLedgerStartedAt: '2026-10-11T12:00:00+00:00',
  };

  it('ショップの設定を読む。2つのトグルに、最後に変えた人と時刻を添える', async () => {
    const { store, rpc } = storeWith({ get_shop_settings: { data: [SETTINGS_ROW] } });

    await expect(getShopSettings(store)).resolves.toEqual(SETTINGS);
    expect(rpc).toHaveBeenCalledWith('get_shop_settings', {});
  });

  it('ショップの設定を変える。DB の関数の引数名のとおりに渡し、変えた後の設定を返す', async () => {
    const { store, rpc } = storeWith({ admin_update_shop_settings: { data: [SETTINGS_ROW] } });

    await expect(updateShopSettings(store, SETTINGS_INPUT)).resolves.toEqual(SETTINGS);
    expect(rpc).toHaveBeenCalledWith('admin_update_shop_settings', {
      _auto_refund_cancelled_order_payment: false, _auto_cancel_amount_mismatch: true, _actor_id: ACTOR_ID,
    });
  });

  it('設定の引数の誤りは記号 invalid_argument。行が返らなければ RefundStoreError', async () => {
    const invalid = storeWith({ admin_update_shop_settings: { error: { message: 'SETTINGS_ARGUMENT_INVALID', code: '22023' } } });
    await expect(updateShopSettings(invalid.store, SETTINGS_INPUT)).rejects.toMatchObject({ code: 'invalid_argument' });

    const empty = storeWith({ get_shop_settings: { data: [] } });
    await expect(getShopSettings(empty.store)).rejects.toBeInstanceOf(RefundStoreError);
  });
});

describe('resolvePaymentExceptionBySystem', () => {
  it('要対応を「システムが自動で解決した」と閉じる。閉じたら true、もう閉じていれば false', async () => {
    const closed = storeWith({ resolve_payment_exception_by_system: { data: true } });
    await expect(resolvePaymentExceptionBySystem(closed.store, EXCEPTION_ID, 'システムが自動で返金しました')).resolves.toBe(true);
    expect(closed.rpc).toHaveBeenCalledWith('resolve_payment_exception_by_system', {
      _exception_id: EXCEPTION_ID, _note: 'システムが自動で返金しました',
    });

    const alreadyClosed = storeWith({ resolve_payment_exception_by_system: { data: false } });
    await expect(resolvePaymentExceptionBySystem(alreadyClosed.store, EXCEPTION_ID, 'メモ')).resolves.toBe(false);
  });
});

describe('src/lib/orders/refund/ のファイルの書き方', () => {
  it("どのファイルも import 'server-only' を書かない（単体テストと DB 結合テストが直接 import するため。src/lib/orders/fulfillment/ と同じ）", () => {
    const directory = path.join(process.cwd(), 'src/lib/orders/refund');
    const files = fs.readdirSync(directory).filter((name) => /\.tsx?$/.test(name));

    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(fs.readFileSync(path.join(directory, name), 'utf8')).not.toMatch(/import\s+['"]server-only['"]/);
    }
  });
});
