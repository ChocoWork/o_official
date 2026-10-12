/** @jest-environment node */

// DB の関数の呼び出しだけを差し替える。誤りの種類（ReturnStoreError・RefundStoreError）は本物を使う。
// 返金の流れ（confirmAwaitingRefund・applyRefundSideEffects）と Stripe への頼み方（refund-stripe.ts）は本物を通し、
// 偽の Stripe の client に届かせる（重複防止キーと中身が、本当に Stripe の呼び出しに載るかを確かめるため）
jest.mock('@/lib/orders/returns/return-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/return-store'),
  cancelReturn: jest.fn(),
  closeReturnMissing: jest.fn(),
  createReturn: jest.fn(),
  inspectReturn: jest.fn(),
  receiveReturn: jest.fn(),
  recordReturnFeePayment: jest.fn(),
  refundReturn: jest.fn(),
  releaseReturnExchange: jest.fn(),
  reopenReturn: jest.fn(),
}));
jest.mock('@/lib/orders/refund/refund-store', () => ({
  ...jest.requireActual('@/lib/orders/refund/refund-store'),
  beginOrderRefund: jest.fn(),
  getOrderRefund: jest.fn(),
  listOrderRefunds: jest.fn(),
  markOrderRefundError: jest.fn(),
  recordOrderRefundResult: jest.fn(),
}));
jest.mock('@/lib/orders/email/order-email-schedule', () => ({ scheduleOrderEmailDelivery: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn() }));

import Stripe from 'stripe';
import {
  RefundStoreError,
  beginOrderRefund,
  getOrderRefund,
  listOrderRefunds,
  markOrderRefundError,
  recordOrderRefundResult,
  type OrderRefundRef,
  type OrderRefundRow,
  type RefundResultRow,
} from '@/lib/orders/refund/refund-store';
import {
  receiveReturnAndRefund,
  refundReturnAndRequestStripe,
  submitCancelReturn,
  submitCloseReturnMissing,
  submitCreateReturn,
  submitInspectReturn,
  submitRecordReturnFeePayment,
  submitReleaseReturnExchange,
  submitReopenReturn,
  type ReturnServiceDeps,
} from '@/lib/orders/returns/return-service';
import {
  ReturnStoreError,
  cancelReturn,
  closeReturnMissing,
  createReturn,
  inspectReturn,
  receiveReturn,
  recordReturnFeePayment,
  refundReturn,
  releaseReturnExchange,
  reopenReturn,
} from '@/lib/orders/returns/return-store';
import { ACTOR_ID, ORDER_ID, REFUND_ID, asyncIterableOf, stripeRefund } from '../refund/refund-test-fixtures';

const mockCreate = createReturn as jest.MockedFunction<typeof createReturn>;
const mockReceive = receiveReturn as jest.MockedFunction<typeof receiveReturn>;
const mockRefundReturn = refundReturn as jest.MockedFunction<typeof refundReturn>;
const mockCancel = cancelReturn as jest.MockedFunction<typeof cancelReturn>;
const mockReopen = reopenReturn as jest.MockedFunction<typeof reopenReturn>;
const mockCloseMissing = closeReturnMissing as jest.MockedFunction<typeof closeReturnMissing>;
const mockInspect = inspectReturn as jest.MockedFunction<typeof inspectReturn>;
const mockFeePayment = recordReturnFeePayment as jest.MockedFunction<typeof recordReturnFeePayment>;
const mockRelease = releaseReturnExchange as jest.MockedFunction<typeof releaseReturnExchange>;
const mockBeginRefund = beginOrderRefund as jest.MockedFunction<typeof beginOrderRefund>;
const mockGet = getOrderRefund as jest.MockedFunction<typeof getOrderRefund>;
const mockList = listOrderRefunds as jest.MockedFunction<typeof listOrderRefunds>;
const mockMarkError = markOrderRefundError as jest.MockedFunction<typeof markOrderRefundError>;
const mockRecord = recordOrderRefundResult as jest.MockedFunction<typeof recordOrderRefundResult>;

// DB の関数の入力と答えの型は、return-store.ts の関数の形から取る（型の名前に頼らない）
type CreateInput = Parameters<typeof createReturn>[1];
type ReceiveInput = Parameters<typeof receiveReturn>[1];
type RefundInput = Parameters<typeof refundReturn>[1];
type Received = Awaited<ReturnType<typeof receiveReturn>>;
type Began = Awaited<ReturnType<typeof refundReturn>>;

const RETURN_ID = 'f1b2c3d4-1111-4222-8333-444455556666';
const RETURN_LINE_ID = 'f2b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_ID = 'f3b2c3d4-1111-4222-8333-444455556666';
const RECEIPT_ID = 'f4b2c3d4-1111-4222-8333-444455556666';
const ORDER_ITEM_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const EXCHANGE_ITEM_ID = 'e2b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'd1b2c3d4-1111-4222-8333-444455556666';
/** 返金が断られた後の返し直しで、DB が新しく作る返金の記録の番号と、画面が新しく作る二重防止の番号（P21） */
const SECOND_REFUND_ID = 'b2b2c3d4-1111-4222-8333-444455556666';
const SECOND_REQUEST_KEY = 'd2b2c3d4-1111-4222-8333-444455556666';
const OTHER_ACTOR_ID = 'c1b2c3d4-1111-4222-8333-444455557777';
const NOW = new Date('2026-10-12T03:00:00.000Z');
/** 10分前に作った返事待ちの記録 */
const FRESH = '2026-10-12T02:50:00.000Z';
/** 23時間と1秒前。Stripe は24時間以上たった重複防止キーを消してよいとしている（時計のずれも見込む）ので、頼み直さず一覧から探す */
const OVER_23_HOURS_AGO = '2026-10-11T03:59:59.000Z';

const RECEIVE_INPUT: ReceiveInput = {
  returnId: RETURN_ID,
  actorId: ACTOR_ID,
  actorCanRefund: true,
  requestKey: REQUEST_KEY,
  units: [{ returnLineId: RETURN_LINE_ID, disposition: 'restocked', quantity: 1 }],
  exchangeOverrides: [],
  refundChoice: 'now',
  refundAmount: null,
  refundShippingAmount: 0,
  note: null,
  notifyCustomer: true,
  sentBackMessage: null,
  sentBackCarrier: null,
  sentBackTrackingNumber: null,
};
/** サポートの受け取り。窓口が権限から actorCanRefund = false を決め、返金は店長に任せる（相談） */
const SUPPORT_RECEIVE_INPUT: ReceiveInput = { ...RECEIVE_INPUT, actorCanRefund: false, refundChoice: 'consult' };

const REFUND_INPUT: RefundInput = {
  returnId: RETURN_ID,
  actorId: ACTOR_ID,
  requestKey: REQUEST_KEY,
  amount: null,
  shippingAmount: 0,
  note: null,
  notifyCustomer: true,
};

const CREATE_INPUT: CreateInput = {
  orderId: ORDER_ID,
  actorId: ACTOR_ID,
  requestKey: REQUEST_KEY,
  lines: [
    {
      fulfillmentId: FULFILLMENT_ID,
      orderItemId: ORDER_ITEM_ID,
      quantity: 1,
      reason: 'size_too_small',
      reasonNote: null,
      resolution: 'exchange',
      exchangeVariantId: 12,
      exchangeMethod: 'stock',
    },
  ],
  returnMethod: 'customer_ships',
  returnShippingPayer: 'customer',
  returnCarrier: null,
  returnTrackingNumber: null,
  returnShippingFee: 0,
  restockingFeePercent: 0,
  exchangeFee: 0,
  exchangeShippingFee: 0,
  shopNote: null,
  notifyCustomer: true,
};
const CREATED = { returnId: RETURN_ID, number: 1, status: 'open', replayed: false } as const;

/** 支払いの種類が読めない2つの場合（どちらも readPaymentMethodType は null）: 読み取りが通信の誤りで落ちる・請求の詳細が無い */
const UNREADABLE_TYPES: Array<[string, (retrieve: jest.Mock) => void]> = [
  [
    '通信の誤り',
    (retrieve) => {
      retrieve.mockRejectedValue(new Error('network'));
    },
  ],
  [
    '請求の詳細が無い',
    (retrieve) => {
      retrieve.mockResolvedValue({ latest_charge: null });
    },
  ],
];

/** admin_receive_return の答え。ふつうは返金の記録（返事待ち）ができた、新しい受け取り */
function received(overrides: Partial<Received> = {}): Received {
  return {
    receiptId: RECEIPT_ID,
    returnStatus: 'open',
    refundId: REFUND_ID,
    refundAmount: 5000,
    refundStatus: 'awaiting_response',
    exchangeOrderItemIds: [],
    feeDueAmount: 0,
    shopNoticeEnqueued: false,
    replayed: false,
    ...overrides,
  };
}

/** 返金が無い受け取り（相談・なし・返金の品が無い）の答え */
function receivedWithoutRefund(overrides: Partial<Received> = {}): Received {
  return received({ refundId: null, refundAmount: null, refundStatus: null, ...overrides });
}

function refundBegan(overrides: Partial<Began> = {}): Began {
  return { refundId: REFUND_ID, amount: 5000, status: 'awaiting_response', replayed: false, ...overrides };
}

function resultRow(overrides: Partial<RefundResultRow> = {}): RefundResultRow {
  return {
    refundId: REFUND_ID,
    orderId: ORDER_ID,
    status: 'pending',
    newlyAccepted: true,
    newlyFailed: false,
    orderStatus: 'paid',
    refundedAmount: 0,
    rereserveShortage: 0,
    emailEnqueued: false,
    exceptionId: null,
    ...overrides,
  };
}

const FAILED_RESULT = resultRow({ status: 'failed', newlyAccepted: false, newlyFailed: true, exceptionId: 'ex-1' });

function refundRef(overrides: Partial<OrderRefundRef> = {}): OrderRefundRef {
  return {
    refundId: REFUND_ID,
    orderId: ORDER_ID,
    source: 'return',
    status: 'awaiting_response',
    stripeRefundId: null,
    amount: 5000,
    paymentIntentId: 'pi_card_1',
    createdAt: FRESH,
    stripeReason: 'requested_by_customer',
    actorId: ACTOR_ID,
    failureReason: null,
    ...overrides,
  };
}

function refundRow(overrides: Partial<OrderRefundRow> = {}): OrderRefundRow {
  return {
    refundId: REFUND_ID,
    source: 'return',
    status: 'failed',
    stripeStatus: 'failed',
    pendingReason: null,
    failureReason: 'expired',
    customerActionExpiresAt: null,
    paymentMethodType: 'konbini',
    amount: 5000,
    shippingAmount: 0,
    adjustmentAmount: 0,
    note: null,
    stripeReason: null,
    cancelReason: null,
    notifyCustomer: true,
    actorEmail: null,
    referenceNumber: null,
    referenceType: null,
    createdAt: FRESH,
    acceptedAt: FRESH,
    succeededAt: null,
    failedAt: FRESH,
    erroredAt: null,
    lines: [],
    ...overrides,
  };
}

type CreateMock = jest.Mock<Promise<Stripe.Refund>, [Record<string, unknown>, { idempotencyKey: string }]>;
type NotifyMock = jest.Mock<Promise<boolean>, [string, unknown]>;
type QueryResult = { data: unknown; error: { message?: string; code?: string } | null };

/** from('表').select().eq().maybeSingle() と from('表').select().in() が、決めた答えを返す入れ物 */
function queryOf(result: QueryResult) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(async () => result),
    maybeSingle: jest.fn(async () => result),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

/**
 * 返品の流れが使う物を、一式作る。Stripe は偽の client（支払いの種類はカード、返金は保留）。
 * DB の関数の既定の答えは、返金の記録（返事待ち）ができた新しい受け取り・返金
 */
function setup() {
  const tables: Record<string, QueryResult> = {
    orders: { data: { payment_intent_id: 'pi_card_1', shipping_email: 'buyer@example.com' }, error: null },
    order_items: { data: [], error: null },
  };
  const from = jest.fn((table: string) => queryOf(tables[table] ?? { data: null, error: null }));
  // 呼ばれた引数を読めるように、引数の型を付けておく
  const create = jest.fn(async () => stripeRefund({ status: 'pending' })) as unknown as CreateMock;
  const retrieve = jest.fn(async () => ({ latest_charge: { payment_method_details: { type: 'card' } } })) as jest.Mock;
  const list = jest.fn(() => asyncIterableOf<Stripe.Refund>([])) as jest.Mock;
  const notifyShop = jest.fn(async () => true) as unknown as NotifyMock;
  const schedule = jest.fn();
  const deps: ReturnServiceDeps = {
    store: { from, rpc: jest.fn() } as unknown as ReturnServiceDeps['store'],
    stripe: { refunds: { create, list }, paymentIntents: { retrieve } } as unknown as Stripe,
    now: () => NOW,
    notifyShopOfRefundFailure: notifyShop,
    scheduleOrderEmailDelivery: schedule,
  };

  mockReceive.mockResolvedValue(received());
  mockRefundReturn.mockResolvedValue(refundBegan());
  mockRecord.mockResolvedValue(resultRow());
  mockGet.mockResolvedValue(refundRef());
  mockList.mockResolvedValue([]);

  return { deps, from, create, retrieve, list, notifyShop, schedule };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('receiveReturnAndRefund（受け取りと返金）', () => {
  it('今返金（now）: 受け取りを記録し、記録の通りに Stripe へ頼み、結果を書き、返金のお知らせの処理を1回動かして、受け付けた返金つきで答える', async () => {
    const { deps, create, schedule } = setup();
    mockRecord.mockResolvedValue(resultRow({ status: 'pending', emailEnqueued: true }));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({
      kind: 'received',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: { refundId: REFUND_ID, amount: 5000, status: 'pending' },
      feeDueAmount: 0,
      exchangeOrderItemIds: [],
      replayed: false,
    });

    // 入力は作り直さず、そのまま DB に渡す（二重防止の番号も、権限の印 actorCanRefund も）
    expect(mockReceive).toHaveBeenCalledTimes(1);
    expect(mockReceive).toHaveBeenCalledWith(deps.store, RECEIVE_INPUT);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_card_1',
        amount: 5000,
        reason: 'requested_by_customer',
        metadata: { order_id: ORDER_ID, refund_id: REFUND_ID, actor_id: ACTOR_ID },
      },
      { idempotencyKey: `order-refund-${REFUND_ID}` },
    );
    // カード払いには instructions_email を送らない
    expect(create.mock.calls[0][0]).not.toHaveProperty('instructions_email');
    // 記録（DB）を先に書いてから Stripe に頼む
    expect(mockReceive.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(
      deps.store,
      REFUND_ID,
      expect.objectContaining({ stripeRefundId: 're_test_1', stripeStatus: 'pending', paymentMethodType: 'card' }),
    );
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('すぐ戻る返金（成功）は、refund.status: succeeded で答える', async () => {
    const { deps, create } = setup();
    create.mockResolvedValue(stripeRefund({ status: 'succeeded' }));
    mockRecord.mockResolvedValue(resultRow({ status: 'succeeded', emailEnqueued: true }));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'received',
      refund: { refundId: REFUND_ID, amount: 5000, status: 'succeeded' },
    });
  });

  it('交換の品がある受け取りの返金でも、足した交換の品の番号と残った手数料を、受け付けた返金といっしょに返す', async () => {
    const { deps } = setup();
    mockReceive.mockResolvedValue(
      received({ returnStatus: 'closed', feeDueAmount: 300, exchangeOrderItemIds: [EXCHANGE_ITEM_ID] }),
    );
    mockRecord.mockResolvedValue(resultRow({ status: 'pending', emailEnqueued: true }));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({
      kind: 'received',
      receiptId: RECEIPT_ID,
      returnStatus: 'closed',
      refund: { refundId: REFUND_ID, amount: 5000, status: 'pending' },
      feeDueAmount: 300,
      exchangeOrderItemIds: [EXCHANGE_ITEM_ID],
      replayed: false,
    });
  });

  it('お客様に知らせない受け取りの返金は、返金のお知らせの予定が無いので、メールの処理を動かさない', async () => {
    const { deps, schedule } = setup();
    mockRecord.mockResolvedValue(resultRow({ status: 'pending', emailEnqueued: false }));

    await expect(receiveReturnAndRefund(deps, { ...RECEIVE_INPUT, notifyCustomer: false })).resolves.toMatchObject({
      kind: 'received',
      refund: { status: 'pending' },
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('額を相談してから返金（consult）: Stripe にも返金の記録にも触れず、返金なしで答える。受け取りのメールの予定が書かれているので処理を動かす', async () => {
    const { deps, from, create, retrieve, schedule } = setup();
    mockReceive.mockResolvedValue(receivedWithoutRefund());

    await expect(receiveReturnAndRefund(deps, { ...RECEIVE_INPUT, refundChoice: 'consult' })).resolves.toEqual({
      kind: 'received',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: null,
      feeDueAmount: 0,
      exchangeOrderItemIds: [],
      replayed: false,
    });

    expect(create).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('Task 3 I-1: 今返金でも、通常返金で覆われた品だけなら、返金の答えが無い受け取りを返し、Stripe に頼まない', async () => {
    const { deps, from, create, retrieve, list, schedule } = setup();
    // 今回の受け取りで返金待ちが増えないため、DB は返金の記録を作らない。
    mockReceive.mockResolvedValue(receivedWithoutRefund());

    await expect(receiveReturnAndRefund(deps, { ...RECEIVE_INPUT, refundChoice: 'now' })).resolves.toEqual({
      kind: 'received',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: null,
      feeDueAmount: 0,
      exchangeOrderItemIds: [],
      replayed: false,
    });

    expect(mockReceive).toHaveBeenCalledWith(deps.store, { ...RECEIVE_INPUT, refundChoice: 'now' });
    expect(create).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('返金なし（none）: Stripe に頼まず、残った手数料と足した交換の品の番号をそのまま返す', async () => {
    const { deps, create, schedule } = setup();
    mockReceive.mockResolvedValue(receivedWithoutRefund({ feeDueAmount: 800, exchangeOrderItemIds: [EXCHANGE_ITEM_ID] }));

    await expect(receiveReturnAndRefund(deps, { ...RECEIVE_INPUT, refundChoice: 'none' })).resolves.toEqual({
      kind: 'received',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: null,
      feeDueAmount: 800,
      exchangeOrderItemIds: [EXCHANGE_ITEM_ID],
      replayed: false,
    });
    expect(create).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it.each([0, null] as const)(
    '0円で返金しない（waived。P20）: refund_amount が %s の答えでも、Stripe にも返金の記録にも触れず、refund が waived の received で答える。受け取りのメールの予定が書かれているので処理を動かす',
    async (refundAmount) => {
      const { deps, from, create, retrieve, schedule } = setup();
      mockReceive.mockResolvedValue(receivedWithoutRefund({ refundAmount, refundStatus: 'waived', feeDueAmount: 300 }));

      await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({
        kind: 'received',
        receiptId: RECEIPT_ID,
        returnStatus: 'open',
        refund: { refundId: null, amount: 0, status: 'waived' },
        feeDueAmount: 300,
        exchangeOrderItemIds: [],
        replayed: false,
      });

      expect(create).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
      // 返金のお知らせは出ない。DB が受け取りの return_received を予定したので、処理を動かすのはその1回
      expect(schedule).toHaveBeenCalledTimes(1);
    },
  );

  it('0円で返金しない受け取りの送り直し（replayed）も waived で答える。メールの予定を新しく書いていないので、処理を動かさない', async () => {
    const { deps, create, schedule } = setup();
    mockReceive.mockResolvedValue(
      receivedWithoutRefund({ refundAmount: 0, refundStatus: 'waived', feeDueAmount: 300, replayed: true }),
    );

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'received',
      refund: { refundId: null, amount: 0, status: 'waived' },
      feeDueAmount: 300,
      replayed: true,
    });
    expect(create).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('返金が無い受け取りの送り直し（replayed）は、メールの予定を新しく書いていないので、処理を動かさない', async () => {
    const { deps, schedule } = setup();
    mockReceive.mockResolvedValue(receivedWithoutRefund({ replayed: true }));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'received',
      refund: null,
      replayed: true,
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('Review Focus 5: サポートの受け取りは返金待ちで、店への知らせの処理を1回動かす。同じ番号の送り直しでは動かさず、Stripe にも頼まない', async () => {
    const { deps, create, schedule } = setup();
    mockReceive
      .mockResolvedValueOnce(receivedWithoutRefund({ shopNoticeEnqueued: true }))
      .mockResolvedValueOnce(receivedWithoutRefund({ shopNoticeEnqueued: true, replayed: true }));

    await expect(receiveReturnAndRefund(deps, SUPPORT_RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'received',
      refund: null,
      replayed: false,
    });
    await expect(receiveReturnAndRefund(deps, SUPPORT_RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'received',
      refund: null,
      replayed: true,
    });

    // 2回とも、同じ二重防止の番号・同じ権限の印で DB に渡る
    expect(mockReceive).toHaveBeenCalledTimes(2);
    expect(mockReceive.mock.calls[0]).toEqual([deps.store, SUPPORT_RECEIVE_INPUT]);
    expect(mockReceive.mock.calls[1]).toEqual([deps.store, SUPPORT_RECEIVE_INPUT]);
    expect(create).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('サポートが今返金を選んだら、DB が RETURN_FORBIDDEN で断る。権限の印と選び方は変えずに渡し、Stripe には頼まない', async () => {
    const { deps, create, schedule } = setup();
    mockReceive.mockRejectedValue(new ReturnStoreError('RETURN_FORBIDDEN'));

    await expect(receiveReturnAndRefund(deps, { ...SUPPORT_RECEIVE_INPUT, refundChoice: 'now' })).resolves.toEqual({
      kind: 'refused',
      code: 'RETURN_FORBIDDEN',
    });
    expect(mockReceive).toHaveBeenCalledWith(
      deps.store,
      expect.objectContaining({ actorCanRefund: false, refundChoice: 'now' }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each([
    'RETURN_NOT_FOUND',
    'RETURN_RECEIPT_EXCEEDS',
    'RETURN_EXCHANGE_OUT_OF_STOCK',
    'RETURN_REQUEST_MISMATCH',
    'RETURN_STATE_CONFLICT',
    'awaiting_refund_exists',
    'exceeds_refundable',
  ] as const)('DB が %s で断ったら、refused でその記号を返し、Stripe にもメールの処理にも触れない', async (code) => {
    const { deps, create, schedule } = setup();
    mockReceive.mockRejectedValue(new ReturnStoreError(code));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({ kind: 'refused', code });
    expect(create).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('DB の想定外の誤りは、断りにせずそのまま投げる（受け取りを書けたか分からないので、同じ二重防止の番号の送り直しに任せる）', async () => {
    const { deps, create, schedule } = setup();
    const failure = new Error('connection reset');
    mockReceive.mockRejectedValue(failure);

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).rejects.toBe(failure);
    expect(create).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe('受け取りの後の返金（Stripe への頼みと、答えが分からない時）', () => {
  it('Stripe が断ったら、返金の記録をエラーにして、受け取りの記録は残したまま refund_not_accepted（stripe_rejected）で答える。理由は総称なので言葉にしない。DB が受け取りのメールを予定する（P25）ので、記録をエラーにした後にメールの処理を1回動かす', async () => {
    const { deps, create, schedule } = setup();
    create.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'already refunded',
        code: 'charge_already_refunded',
        statusCode: 400,
      }),
    );
    mockMarkError.mockResolvedValue({ outcome: 'errored', orderId: ORDER_ID, exceptionId: null });

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: null },
    });
    expect(mockMarkError).toHaveBeenCalledWith(deps.store, REFUND_ID, 'stripe_rejected', false);
    expect(mockRecord).not.toHaveBeenCalled();
    // E-2 の断りの道（recordRejection）は、メールの処理を動かさない。DB が書いた受け取りのメールの予定は、記録をエラーにした後で動かす
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(mockMarkError.mock.invocationCallOrder[0]).toBeLessThan(schedule.mock.invocationCallOrder[0]);
  });

  it('通信が切れた（Stripe が返金を作ったか分からない）時は、返金の記録の番号つきの unknown。返金の記録は返事待ちのまま、何も書かない', async () => {
    const { deps, create, schedule } = setup();
    create.mockRejectedValue(new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'socket hang up' }));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: { kind: 'unknown', refundId: REFUND_ID },
    });
    expect(mockMarkError).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('P25: 通信が切れて分からない間はメールの処理を動かさず、同じ番号の送り直し（replayed: true）で Stripe が今度は断った時に、1回動かす', async () => {
    const { deps, create, schedule } = setup();
    mockReceive.mockResolvedValueOnce(received()).mockResolvedValueOnce(received({ replayed: true }));
    create
      .mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'socket hang up' }))
      .mockRejectedValueOnce(
        new Stripe.errors.StripeInvalidRequestError({
          type: 'invalid_request_error',
          message: 'already refunded',
          code: 'charge_already_refunded',
          statusCode: 400,
        }),
      );
    mockMarkError.mockResolvedValue({ outcome: 'errored', orderId: ORDER_ID, exceptionId: null });

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'refund_not_accepted',
      refund: { kind: 'unknown', refundId: REFUND_ID },
    });
    // 分からない間は、DB は何も書いていない（見回りが後でエラーにした時の予定は、毎分の定期処理が送る）
    expect(schedule).not.toHaveBeenCalled();

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: null },
    });
    // 送り直しの答え（replayed: true）でも、返金の記録がエラーになったのは今回なので、DB が受け取りのメールを予定したのも今回
    expect(mockMarkError).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('Review Focus 1: 通信が切れた後の送り直しは、同じ二重防止の番号で DB に渡り、同じ重複防止キー・同じ中身で Stripe に頼み直す。Stripe の返金は1件', async () => {
    const { deps, create, schedule } = setup();
    mockReceive.mockResolvedValueOnce(received()).mockResolvedValueOnce(received({ replayed: true }));
    create
      .mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'socket hang up' }))
      .mockResolvedValueOnce(stripeRefund({ status: 'pending' }));
    mockRecord.mockResolvedValue(resultRow({ status: 'pending', emailEnqueued: true }));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      refund: { kind: 'unknown', refundId: REFUND_ID },
    });
    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({
      kind: 'received',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: { refundId: REFUND_ID, amount: 5000, status: 'pending' },
      feeDueAmount: 0,
      exchangeOrderItemIds: [],
      replayed: true,
    });

    // 受け取りは同じ二重防止の番号で2回渡る（番号を作り直さない）。DB は2回目に前の受け取りを返す
    expect(mockReceive).toHaveBeenCalledTimes(2);
    expect(mockReceive.mock.calls[1]).toEqual(mockReceive.mock.calls[0]);
    // Stripe への頼みは、キーも中身も1回目と同じ（Stripe は1回目が通っていれば、同じ返金を返すだけ）
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: `order-refund-${REFUND_ID}` });
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    // 結果を書くのも、メールの処理を動かすのも1回
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it.each(['pending', 'succeeded'] as const)(
    '送り直しで、返金の記録がもう %s なら、Stripe を呼ばずに replayed: true で答える',
    async (status) => {
      const { deps, create, retrieve, schedule } = setup();
      mockReceive.mockResolvedValue(received({ refundStatus: status, replayed: true }));
      mockGet.mockResolvedValue(refundRef({ status, stripeRefundId: 're_test_1' }));

      await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
        kind: 'received',
        replayed: true,
        refund: { refundId: REFUND_ID, amount: 5000, status },
      });
      expect(create).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['failed', 'expired', '口座の入力の期限が過ぎました'],
    ['error', 'not_found_in_stripe', 'Stripe に届きませんでした'],
    ['error', 'stripe_rejected', null],
  ] as const)(
    '送り直しで、返金の記録が %s（理由 %s）なら、Stripe を呼ばずに、受け付けられなかった答えを返す',
    async (status, failureReason, reasonLabel) => {
      const { deps, create } = setup();
      mockReceive.mockResolvedValue(received({ refundStatus: status, replayed: true }));
      mockGet.mockResolvedValue(refundRef({ status, failureReason }));

      await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({
        kind: 'refund_not_accepted',
        receiptId: RECEIPT_ID,
        returnStatus: 'open',
        refund: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel },
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('送り直しで、返事待ちの返金が作ってから23時間を超えていたら、頼み直さず一覧から印で探し、見つかった返金の結果を書く', async () => {
    const { deps, create, list, retrieve } = setup();
    mockReceive.mockResolvedValue(received({ replayed: true }));
    mockGet.mockResolvedValue(refundRef({ createdAt: OVER_23_HOURS_AGO }));
    list.mockReturnValue(
      asyncIterableOf([stripeRefund({ id: 're_other', metadata: {} }), stripeRefund({ id: 're_found', status: 'succeeded' })]),
    );
    mockRecord.mockResolvedValue(resultRow({ status: 'succeeded' }));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'received',
      replayed: true,
      refund: { refundId: REFUND_ID, amount: 5000, status: 'succeeded' },
    });
    expect(create).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_card_1', limit: 100 });
    // 一覧の写しは支払いの種類を持たない。見つけた時に1回だけ読む
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(
      deps.store,
      REFUND_ID,
      expect.objectContaining({ stripeRefundId: 're_found', stripeStatus: 'succeeded', paymentMethodType: 'card' }),
    );
  });

  it('23時間を超えた返事待ちで、一覧に印の返金が無ければ unknown。頼み直さず、エラーにもしない（毎時の見回りが片付ける）', async () => {
    const { deps, create, list, retrieve } = setup();
    mockReceive.mockResolvedValue(received({ replayed: true }));
    mockGet.mockResolvedValue(refundRef({ createdAt: OVER_23_HOURS_AGO }));
    list.mockReturnValue(asyncIterableOf([stripeRefund({ id: 're_other', metadata: {} })]));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'refund_not_accepted',
      refund: { kind: 'unknown', refundId: REFUND_ID },
    });
    expect(create).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockMarkError).not.toHaveBeenCalled();
  });

  it.each(UNREADABLE_TYPES)(
    '支払いの種類が読めない（%s）時は、Stripe に頼まずに unknown。記録には何も書かない（頼み直しで instructions_email の有無が変わらないように）',
    async (_name, makeUnreadable) => {
      const { deps, create, retrieve } = setup();
      makeUnreadable(retrieve);

      await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
        kind: 'refund_not_accepted',
        refund: { kind: 'unknown', refundId: REFUND_ID },
      });
      expect(create).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
      expect(mockMarkError).not.toHaveBeenCalled();
    },
  );

  it('作ったその場で失敗の返金（PayPay など）は、stripe_rejected と失敗の理由の言葉で答え、店へ知らせる', async () => {
    const { deps, create, notifyShop } = setup();
    create.mockResolvedValue(stripeRefund({ status: 'failed', failure_reason: 'declined' }));
    mockRecord.mockResolvedValue(FAILED_RESULT);
    mockList.mockResolvedValue([refundRow({ failureReason: 'declined' })]);

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: 'カード会社に断られました' },
    });
    expect(notifyShop).toHaveBeenCalledTimes(1);
    expect(notifyShop).toHaveBeenCalledWith('ex-1', expect.objectContaining({ reason: 'refund_failed', detail: 'declined' }));
  });

  it('Stripe は受け付けたが、結果を記録に書けなかった時も unknown（同じ番号の送り直しで書き直す）。メールの処理は動かさない', async () => {
    const { deps, schedule } = setup();
    mockRecord.mockRejectedValue(new RefundStoreError('record_order_refund_result', { code: '08006' }));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'refund_not_accepted',
      refund: { kind: 'unknown', refundId: REFUND_ID },
    });
    expect(console.error).toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('受け取りを書いた後に、返金の記録を読めなくても例外を投げず unknown で答える。ログには誤りの名前だけを出す', async () => {
    const { deps, create } = setup();
    mockGet.mockRejectedValue(new Error('db said buyer@example.com'));

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toEqual({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: { kind: 'unknown', refundId: REFUND_ID },
    });
    expect(create).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[return] the refund request failed after the return was recorded', 'Error');
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('buyer@example.com');
  });

  it('DB が返した返金の記録が読めなければ（null）、断ったとは言えないので unknown', async () => {
    const { deps, create } = setup();
    mockGet.mockResolvedValue(null);

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'refund_not_accepted',
      refund: { kind: 'unknown', refundId: REFUND_ID },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('Stripe には、入力ではなく DB の記録の額・理由・実行した人で頼む（最初の頼みと送り直しで中身が変わらない）', async () => {
    const { deps, create } = setup();
    mockGet.mockResolvedValue(refundRef({ amount: 3200, stripeReason: 'duplicate', actorId: OTHER_ACTOR_ID }));

    await receiveReturnAndRefund(deps, RECEIVE_INPUT);

    expect(create).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_card_1',
        amount: 3200,
        reason: 'duplicate',
        metadata: { order_id: ORDER_ID, refund_id: REFUND_ID, actor_id: OTHER_ACTOR_ID },
      },
      { idempotencyKey: `order-refund-${REFUND_ID}` },
    );
  });
});

describe('refundReturnAndRequestStripe（額を決めて返金）', () => {
  it('Review Focus 5: 計算どおり（額を空で送る）で返金を始め、記録の額で Stripe に頼み、結果を書き、返金のお知らせの処理を1回動かす', async () => {
    const { deps, create, schedule } = setup();
    mockRecord.mockResolvedValue(resultRow({ status: 'pending', emailEnqueued: true }));

    await expect(refundReturnAndRequestStripe(deps, REFUND_INPUT)).resolves.toEqual({
      kind: 'accepted',
      refundId: REFUND_ID,
      status: 'pending',
      amount: 5000,
      replayed: false,
    });

    expect(mockRefundReturn).toHaveBeenCalledWith(deps.store, REFUND_INPUT);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_card_1',
        amount: 5000,
        reason: 'requested_by_customer',
        metadata: { order_id: ORDER_ID, refund_id: REFUND_ID, actor_id: ACTOR_ID },
      },
      { idempotencyKey: `order-refund-${REFUND_ID}` },
    );
    expect(mockRefundReturn.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('店長が額と送料を直した時は、その値を DB に渡し、DB が記録した額で Stripe に頼む', async () => {
    const { deps, create } = setup();
    mockRefundReturn.mockResolvedValue(refundBegan({ amount: 3200 }));
    mockGet.mockResolvedValue(refundRef({ amount: 3200 }));

    await expect(
      refundReturnAndRequestStripe(deps, { ...REFUND_INPUT, amount: 3200, shippingAmount: 200 }),
    ).resolves.toMatchObject({ kind: 'accepted', amount: 3200, replayed: false });

    expect(mockRefundReturn).toHaveBeenCalledWith(
      deps.store,
      expect.objectContaining({ amount: 3200, shippingAmount: 200 }),
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 3200 }), {
      idempotencyKey: `order-refund-${REFUND_ID}`,
    });
  });

  it('額を0円にして返金しないで終える（waived。P20）: 額 0 を変えずに DB に渡し、Stripe にも返金の記録にもメールの処理にも触れず、waived で答える', async () => {
    const { deps, create, retrieve, schedule } = setup();
    mockRefundReturn.mockResolvedValue(refundBegan({ refundId: null, amount: 0, status: 'waived' }));

    await expect(refundReturnAndRequestStripe(deps, { ...REFUND_INPUT, amount: 0 })).resolves.toEqual({
      kind: 'waived',
      replayed: false,
    });

    // 0 は「返金しないで終える」、null は「計算どおり」。0 を null に直さない
    expect(mockRefundReturn).toHaveBeenCalledWith(deps.store, expect.objectContaining({ amount: 0 }));
    expect(create).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    // 返金のお知らせは出ない（返金の記録が無い）
    expect(schedule).not.toHaveBeenCalled();
  });

  it('計算どおりの額 null でも、相談で付いた手数料が商品の額以上なら、DB の waived を返し、Stripe に頼まない', async () => {
    const { deps, from, create, retrieve, list, schedule } = setup();
    // 手数料を引いた後の額は DB が決めるため、入力の null を0に変えない。
    mockRefundReturn.mockResolvedValue(refundBegan({ refundId: null, amount: 0, status: 'waived' }));

    await expect(refundReturnAndRequestStripe(deps, { ...REFUND_INPUT, amount: null })).resolves.toEqual({
      kind: 'waived',
      replayed: false,
    });

    expect(mockRefundReturn).toHaveBeenCalledWith(deps.store, { ...REFUND_INPUT, amount: null });
    expect(create).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('0円で返金しないで終えた操作の送り直し（replayed）も waived で答え、Stripe にもメールの処理にも触れない', async () => {
    const { deps, create, schedule } = setup();
    mockRefundReturn.mockResolvedValue(refundBegan({ refundId: null, amount: 0, status: 'waived', replayed: true }));

    await expect(refundReturnAndRequestStripe(deps, { ...REFUND_INPUT, amount: 0 })).resolves.toEqual({
      kind: 'waived',
      replayed: true,
    });
    expect(create).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('P21: 返金が断られて、返品が closed のまま返金待ちの数が戻った後は、新しい二重防止の番号の「額を決めて返金」で返し直せる。返し直しは返品の返金で、E-2 のふつうの返金は通らない', async () => {
    const { deps, create, schedule } = setup();
    mockGet.mockImplementation(async (_store, refundId) => refundRef({ refundId }));
    // 1回目: 今返金の受け取り。全部の品が処理済みで返品は closed になり、Stripe が返金を断る
    mockReceive.mockResolvedValue(received({ returnStatus: 'closed' }));
    create.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'already refunded',
        code: 'charge_already_refunded',
        statusCode: 400,
      }),
    );
    mockMarkError.mockResolvedValue({ outcome: 'errored', orderId: ORDER_ID, exceptionId: null });

    await expect(receiveReturnAndRefund(deps, RECEIVE_INPUT)).resolves.toMatchObject({
      kind: 'refund_not_accepted',
      returnStatus: 'closed',
      refund: { kind: 'stripe_rejected', refundId: REFUND_ID },
    });

    // 2回目: 店長が返品の画面で返し直す。画面が新しく作った二重防止の番号で、DB が新しい返金の記録を作る
    const retryInput: RefundInput = { ...REFUND_INPUT, requestKey: SECOND_REQUEST_KEY };
    mockRefundReturn.mockResolvedValue(refundBegan({ refundId: SECOND_REFUND_ID }));
    mockRecord.mockResolvedValue(resultRow({ refundId: SECOND_REFUND_ID, status: 'pending', emailEnqueued: true }));

    await expect(refundReturnAndRequestStripe(deps, retryInput)).resolves.toEqual({
      kind: 'accepted',
      refundId: SECOND_REFUND_ID,
      status: 'pending',
      amount: 5000,
      replayed: false,
    });

    expect(mockRefundReturn).toHaveBeenCalledTimes(1);
    expect(mockRefundReturn).toHaveBeenCalledWith(deps.store, retryInput);
    // Stripe には、新しい返金の記録の番号のキーで頼む（断られた1回目のキーは使い回さない）
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: `order-refund-${REFUND_ID}` });
    expect(create.mock.calls[1][1]).toEqual({ idempotencyKey: `order-refund-${SECOND_REFUND_ID}` });
    expect(create.mock.calls[1][0]).toMatchObject({ metadata: { refund_id: SECOND_REFUND_ID } });
    // E-2 のふつうの返金（道 admin）の入口は通らない
    expect(mockBeginRefund).not.toHaveBeenCalled();
    // メールの処理は2回: 1回目の断り（DB が受け取りのメールを予定する。P25）と、2回目の受け付け（返金のお知らせ）
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('通信が切れた後の送り直しは、同じ二重防止の番号で DB に渡り、同じ重複防止キー・同じ中身で頼み直す。Stripe の返金は1件', async () => {
    const { deps, create, schedule } = setup();
    mockRefundReturn.mockResolvedValueOnce(refundBegan()).mockResolvedValueOnce(refundBegan({ replayed: true }));
    create
      .mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'socket hang up' }))
      .mockResolvedValueOnce(stripeRefund({ status: 'pending' }));
    mockRecord.mockResolvedValue(resultRow({ status: 'pending', emailEnqueued: true }));

    await expect(refundReturnAndRequestStripe(deps, REFUND_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
    await expect(refundReturnAndRequestStripe(deps, REFUND_INPUT)).resolves.toEqual({
      kind: 'accepted',
      refundId: REFUND_ID,
      status: 'pending',
      amount: 5000,
      replayed: true,
    });

    expect(mockRefundReturn.mock.calls[1]).toEqual(mockRefundReturn.mock.calls[0]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: `order-refund-${REFUND_ID}` });
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it.each([
    'RETURN_STATE_CONFLICT',
    'RETURN_NOTHING_TO_REFUND',
    'RETURN_REFUND_AMOUNT_INVALID',
    'RETURN_REQUEST_MISMATCH',
    'awaiting_refund_exists',
    'exceeds_refundable',
  ] as const)('DB が %s で断ったら、refused でその記号を返し、Stripe には頼まない', async (code) => {
    const { deps, create, schedule } = setup();
    mockRefundReturn.mockRejectedValue(new ReturnStoreError(code));

    await expect(refundReturnAndRequestStripe(deps, REFUND_INPUT)).resolves.toEqual({ kind: 'refused', code });
    expect(create).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('Stripe が断ったら、返金の記録をエラーにして stripe_rejected を返す（返品の状態は戻さない。数は DB の数え方で戻る）', async () => {
    const { deps, create, schedule } = setup();
    create.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'conflict', statusCode: 409 }),
    );
    mockMarkError.mockResolvedValue({ outcome: 'errored', orderId: ORDER_ID, exceptionId: null });

    await expect(refundReturnAndRequestStripe(deps, REFUND_INPUT)).resolves.toEqual({
      kind: 'stripe_rejected',
      refundId: REFUND_ID,
      reasonLabel: null,
    });
    expect(mockMarkError).toHaveBeenCalledWith(deps.store, REFUND_ID, 'stripe_rejected', false);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('DB の想定外の誤りは、断りにせずそのまま投げる', async () => {
    const { deps, create } = setup();
    const failure = new Error('connection reset');
    mockRefundReturn.mockRejectedValue(failure);

    await expect(refundReturnAndRequestStripe(deps, REFUND_INPUT)).rejects.toBe(failure);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('submitCreateReturn（返品を作る）', () => {
  it('作って、done で答える。受付のお知らせの予定が書かれているので、メールの処理を1回動かす', async () => {
    const { deps, schedule } = setup();
    mockCreate.mockResolvedValue(CREATED);

    await expect(submitCreateReturn(deps, CREATE_INPUT)).resolves.toEqual({ kind: 'done', ...CREATED });
    expect(mockCreate).toHaveBeenCalledWith(deps.store, CREATE_INPUT);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('お客様に知らせない（notifyCustomer: false）なら、メールの処理を動かさない', async () => {
    const { deps, schedule } = setup();
    mockCreate.mockResolvedValue(CREATED);

    await expect(submitCreateReturn(deps, { ...CREATE_INPUT, notifyCustomer: false })).resolves.toMatchObject({ kind: 'done' });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('同じ二重防止の番号の送り直し（replayed）は、メールの予定を新しく書いていないので、処理を動かさない', async () => {
    const { deps, schedule } = setup();
    mockCreate.mockResolvedValue({ ...CREATED, replayed: true });

    await expect(submitCreateReturn(deps, CREATE_INPUT)).resolves.toEqual({ kind: 'done', ...CREATED, replayed: true });
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each([
    'RETURN_ADDRESS_REQUIRED',
    'RETURN_QUANTITY_EXCEEDS',
    'RETURN_REASON_NOTE_REQUIRED',
    'RETURN_EXCHANGE_VARIANT_INVALID',
    'ORDER_NOT_RETURNABLE',
    'RETURN_REQUEST_MISMATCH',
  ] as const)('DB が %s で断ったら、refused でその記号を返す', async (code) => {
    const { deps, schedule } = setup();
    mockCreate.mockRejectedValue(new ReturnStoreError(code));

    await expect(submitCreateReturn(deps, CREATE_INPUT)).resolves.toEqual({ kind: 'refused', code });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('DB の想定外の誤りは、断りにせずそのまま投げる', async () => {
    const { deps, schedule } = setup();
    const failure = new Error('connection reset');
    mockCreate.mockRejectedValue(failure);

    await expect(submitCreateReturn(deps, CREATE_INPUT)).rejects.toBe(failure);
    expect(schedule).not.toHaveBeenCalled();
  });
});

const CANCEL_INPUT = { returnId: RETURN_ID, actorId: ACTOR_ID };
const CANCEL_ANSWER = { returnId: RETURN_ID, status: 'cancelled' } as const;
const REOPEN_INPUT = { returnId: RETURN_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY };
const CLOSE_MISSING_INPUT = { returnId: RETURN_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY };
const RECEIPT_ANSWER = { receiptId: RECEIPT_ID, returnStatus: 'open', replayed: false } as const;
const INSPECT_INPUT = {
  returnId: RETURN_ID,
  actorId: ACTOR_ID,
  requestKey: REQUEST_KEY,
  lines: [{ returnLineId: RETURN_LINE_ID, restocked: 1, notRestocked: 0 }],
};
const FEE_PAYMENT_INPUT = { returnId: RETURN_ID, actorId: ACTOR_ID, note: '振込を確かめた', waive: false };
const RELEASE_INPUT = { returnId: RETURN_ID, actorId: ACTOR_ID };
const STATUS_ANSWER = { returnId: RETURN_ID, returnStatus: 'open' } as const;

type OperationCase = {
  run(deps: ReturnServiceDeps): Promise<unknown>;
  /** DB の関数を、答える状態にする */
  succeed(): void;
  /** DB の関数を、渡した誤りで落とす */
  fail(error: Error): void;
  expectCalledWith(deps: ReturnServiceDeps): void;
  answer: object;
};

/** 返金もメールも無い6つの操作。どれも DB の関数を呼ぶだけ */
const OPERATIONS: Array<readonly [name: string, operation: OperationCase]> = [
  [
    '返品を取り消す',
    {
      run: (deps) => submitCancelReturn(deps, CANCEL_INPUT),
      succeed: () => mockCancel.mockResolvedValue(CANCEL_ANSWER),
      fail: (error) => mockCancel.mockRejectedValue(error),
      expectCalledWith: (deps) => expect(mockCancel).toHaveBeenCalledWith(deps.store, CANCEL_INPUT),
      answer: CANCEL_ANSWER,
    },
  ],
  [
    '開き直す',
    {
      run: (deps) => submitReopenReturn(deps, REOPEN_INPUT),
      succeed: () => mockReopen.mockResolvedValue(RECEIPT_ANSWER),
      fail: (error) => mockReopen.mockRejectedValue(error),
      expectCalledWith: (deps) => expect(mockReopen).toHaveBeenCalledWith(deps.store, REOPEN_INPUT),
      answer: RECEIPT_ANSWER,
    },
  ],
  [
    '届かないとして終える',
    {
      run: (deps) => submitCloseReturnMissing(deps, CLOSE_MISSING_INPUT),
      succeed: () => mockCloseMissing.mockResolvedValue(RECEIPT_ANSWER),
      fail: (error) => mockCloseMissing.mockRejectedValue(error),
      expectCalledWith: (deps) => expect(mockCloseMissing).toHaveBeenCalledWith(deps.store, CLOSE_MISSING_INPUT),
      answer: RECEIPT_ANSWER,
    },
  ],
  [
    '検品を終える',
    {
      run: (deps) => submitInspectReturn(deps, INSPECT_INPUT),
      succeed: () => mockInspect.mockResolvedValue(RECEIPT_ANSWER),
      fail: (error) => mockInspect.mockRejectedValue(error),
      expectCalledWith: (deps) => expect(mockInspect).toHaveBeenCalledWith(deps.store, INSPECT_INPUT),
      answer: RECEIPT_ANSWER,
    },
  ],
  [
    '手数料の受け取りを記録する',
    {
      run: (deps) => submitRecordReturnFeePayment(deps, FEE_PAYMENT_INPUT),
      succeed: () => mockFeePayment.mockResolvedValue(STATUS_ANSWER),
      fail: (error) => mockFeePayment.mockRejectedValue(error),
      expectCalledWith: (deps) => expect(mockFeePayment).toHaveBeenCalledWith(deps.store, FEE_PAYMENT_INPUT),
      answer: STATUS_ANSWER,
    },
  ],
  [
    '支払いを待たずに送る',
    {
      run: (deps) => submitReleaseReturnExchange(deps, RELEASE_INPUT),
      succeed: () => mockRelease.mockResolvedValue(STATUS_ANSWER),
      fail: (error) => mockRelease.mockRejectedValue(error),
      expectCalledWith: (deps) => expect(mockRelease).toHaveBeenCalledWith(deps.store, RELEASE_INPUT),
      answer: STATUS_ANSWER,
    },
  ],
];

describe('ほかの操作（取消・開き直し・届かないで終える・検品・手数料の受け取りの記録・支払いを待たずに送る）', () => {
  it.each(OPERATIONS)(
    '%s: DB の関数に deps.store と入力をそのまま渡し、答えを done で返す。メールの処理は動かさない（設計書 9-1）',
    async (_name, operation) => {
      const { deps, schedule } = setup();
      operation.succeed();

      await expect(operation.run(deps)).resolves.toEqual({ kind: 'done', ...operation.answer });
      operation.expectCalledWith(deps);
      expect(schedule).not.toHaveBeenCalled();
    },
  );

  it.each(OPERATIONS)('%s: DB が決まった言葉で断ったら、refused でその記号を返す', async (_name, operation) => {
    const { deps, schedule } = setup();
    operation.fail(new ReturnStoreError('RETURN_STATE_CONFLICT'));

    await expect(operation.run(deps)).resolves.toEqual({ kind: 'refused', code: 'RETURN_STATE_CONFLICT' });
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each(OPERATIONS)('%s: DB の想定外の誤りは、断りにせずそのまま投げる', async (_name, operation) => {
    const { deps } = setup();
    const failure = new Error('connection reset');
    operation.fail(failure);

    await expect(operation.run(deps)).rejects.toBe(failure);
  });

  it.each([true, false] as const)(
    '手数料の受け取りの記録: waive が %s の入力（P27: true は「いただかないで終える」）を、変えずに DB の関数に渡す。メールの処理は動かさない',
    async (waive) => {
      const { deps, schedule } = setup();
      mockFeePayment.mockResolvedValue(STATUS_ANSWER);
      const input = { ...FEE_PAYMENT_INPUT, waive };

      await expect(submitRecordReturnFeePayment(deps, input)).resolves.toEqual({ kind: 'done', ...STATUS_ANSWER });

      expect(mockFeePayment).toHaveBeenCalledTimes(1);
      expect(mockFeePayment).toHaveBeenCalledWith(deps.store, input);
      expect(schedule).not.toHaveBeenCalled();
    },
  );
});
