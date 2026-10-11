/** @jest-environment node */

// DB の関数の呼び出しだけを差し替える。誤りの種類（RefundOperationError・RefundStoreError）は本物を使う
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
// 照合の部品は、createDefaultRefundServiceDeps が関数の中で import() する。ここでは外から差し替える
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({ notifyShopOfException: jest.fn() }));
jest.mock('@/lib/stripe/checkout-payment-reconciler-deps', () => ({
  createSupabaseReconcilerDatabase: jest.fn(),
  createReconcilerMailer: jest.fn(),
}));

import Stripe from 'stripe';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import type { ShopPaymentAlert } from '@/lib/orders/order-lifecycle-emails';
import {
  RefundOperationError,
  RefundStoreError,
  beginOrderRefund,
  getOrderRefund,
  listOrderRefunds,
  markOrderRefundError,
  recordOrderRefundResult,
  type BeganRefund,
  type OrderRefundLineRow,
  type OrderRefundRef,
  type OrderRefundRow,
  type RefundResultRow,
} from '@/lib/orders/refund/refund-store';
import {
  applyRefundSideEffects,
  confirmAwaitingRefund,
  createDefaultRefundServiceDeps,
  startAutomaticRefund,
  submitAdminRefund,
  submitPaidOrderCancel,
  type RefundServiceDeps,
} from '@/lib/orders/refund/refund-service';
import type { CreateRefundRequest, PaidCancelRequest } from '@/lib/orders/refund/refund-types';
import { notifyShopOfException } from '@/lib/stripe/checkout-payment-reconciler';
import { createReconcilerMailer, createSupabaseReconcilerDatabase } from '@/lib/stripe/checkout-payment-reconciler-deps';
import { getStripeServerClient } from '@/lib/stripe/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ACTOR_ID, ORDER_ID, REFUND_ID, asyncIterableOf, stripeRefund } from './refund-test-fixtures';

const mockBegin = beginOrderRefund as jest.MockedFunction<typeof beginOrderRefund>;
const mockGet = getOrderRefund as jest.MockedFunction<typeof getOrderRefund>;
const mockList = listOrderRefunds as jest.MockedFunction<typeof listOrderRefunds>;
const mockMarkError = markOrderRefundError as jest.MockedFunction<typeof markOrderRefundError>;
const mockRecord = recordOrderRefundResult as jest.MockedFunction<typeof recordOrderRefundResult>;

const REQUEST_KEY = 'd1b2c3d4-1111-4222-8333-444455556666';
const ITEM_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const OTHER_ITEM_ID = 'e1b2c3d4-1111-4222-8333-444455556667';
const OTHER_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455557777';
const OTHER_ACTOR_ID = 'c1b2c3d4-1111-4222-8333-444455557777';
const NOW = new Date('2026-10-11T03:00:00.000Z');
/** 10分前に作った返事待ちの記録 */
const FRESH = '2026-10-11T02:50:00.000Z';
/** 23時間ちょうど前。まだ同じ重複防止キーで頼み直せる */
const EXACTLY_23_HOURS_AGO = '2026-10-10T04:00:00.000Z';
/** 23時間と1秒前。Stripe は24時間以上たったキーを消してよいとしている（時計のずれも見込む）ので、頼み直さず一覧から探す */
const OVER_23_HOURS_AGO = '2026-10-10T03:59:59.000Z';

const BEGAN: BeganRefund = { refundId: REFUND_ID, amount: 5000, status: 'awaiting_response', replayed: false };
const REPLAYED: BeganRefund = { ...BEGAN, replayed: true };

const ADMIN_REQUEST: CreateRefundRequest = {
  requestKey: REQUEST_KEY,
  lines: [{ orderItemId: ITEM_ID, quantity: 1, beforeShipment: true }],
  restock: true,
  shippingAmount: 0,
  amount: 5000,
  note: '色違いのため',
  stripeReason: 'requested_by_customer',
  notifyCustomer: true,
};
const ADMIN_INPUT = { orderId: ORDER_ID, actorId: ACTOR_ID, request: ADMIN_REQUEST };

const CANCEL_REQUEST: PaidCancelRequest = {
  requestKey: REQUEST_KEY,
  reason: 'customer_request',
  note: 'お客様から連絡あり',
  restock: true,
  notifyCustomer: true,
};

const CONFIRM_INPUT = { orderId: ORDER_ID, refundId: REFUND_ID };

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
    source: 'admin',
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

function lineRow(overrides: Partial<OrderRefundLineRow> = {}): OrderRefundLineRow {
  return {
    orderItemId: ITEM_ID,
    quantity: 1,
    beforeShipment: true,
    restockType: 'cancel',
    amount: 5000,
    releasedQuantity: 1,
    restockedQuantity: 1,
    rereservedQuantity: 0,
    rereserveShortage: 0,
    ...overrides,
  };
}

function refundRow(overrides: Partial<OrderRefundRow> = {}): OrderRefundRow {
  return {
    refundId: REFUND_ID,
    source: 'admin',
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
 * 返金の流れが使う物を、一式作る。Stripe は偽の client（支払いの種類はカード、返金は保留）。
 * 表の答え（tables）は呼ばれた時に読むので、試験の中で書き換えて決められる
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
  const deps: RefundServiceDeps = {
    store: { from, rpc: jest.fn() } as unknown as RefundServiceDeps['store'],
    stripe: { refunds: { create, list }, paymentIntents: { retrieve } } as unknown as Stripe,
    now: () => NOW,
    notifyShopOfRefundFailure: notifyShop,
    scheduleOrderEmailDelivery: schedule,
  };

  mockBegin.mockResolvedValue(BEGAN);
  mockRecord.mockResolvedValue(resultRow());
  mockGet.mockResolvedValue(refundRef());
  mockList.mockResolvedValue([]);

  return { deps, tables, from, create, retrieve, list, notifyShop, schedule };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('submitAdminRefund（管理画面の返金）', () => {
  it('Stripe が受け付けた（保留）: 記録の通りに頼み、結果を書き、メールの処理を動かして、受け付けた答えを返す', async () => {
    const { deps, create, schedule } = setup();
    mockRecord.mockResolvedValue(resultRow({ status: 'pending', emailEnqueued: true }));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({
      kind: 'accepted',
      refundId: REFUND_ID,
      status: 'pending',
      amount: 5000,
      replayed: false,
    });

    expect(mockBegin).toHaveBeenCalledWith(deps.store, {
      orderId: ORDER_ID,
      source: 'admin',
      requestKey: REQUEST_KEY,
      lines: ADMIN_REQUEST.lines,
      restock: true,
      shippingAmount: 0,
      amount: 5000,
      note: '色違いのため',
      stripeReason: 'requested_by_customer',
      cancelReason: null,
      notifyCustomer: true,
      actorId: ACTOR_ID,
    });
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
    expect(mockRecord).toHaveBeenCalledWith(
      deps.store,
      REFUND_ID,
      expect.objectContaining({ stripeRefundId: 're_test_1', stripeStatus: 'pending', paymentMethodType: 'card' }),
    );
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('すぐ戻る返金（成功）は、status: succeeded で答える', async () => {
    const { deps, create } = setup();
    create.mockResolvedValue(stripeRefund({ status: 'succeeded' }));
    mockRecord.mockResolvedValue(resultRow({ status: 'succeeded', emailEnqueued: true }));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({
      kind: 'accepted',
      refundId: REFUND_ID,
      status: 'succeeded',
      amount: 5000,
      replayed: false,
    });
  });

  it('注文からは、支払いの番号と連絡先のメールだけを読む', async () => {
    const { deps, from } = setup();

    await submitAdminRefund(deps, ADMIN_INPUT);

    expect(from).toHaveBeenCalledWith('orders');
    const query = from.mock.results[0].value;
    expect(query.select).toHaveBeenCalledWith('payment_intent_id, shipping_email');
    expect(query.eq).toHaveBeenCalledWith('id', ORDER_ID);
  });

  it('コンビニ払いは、注文の連絡先のメールを instructions_email に渡す。口座の入力の期限と支払いの種類を記録に書く', async () => {
    const { deps, create, retrieve } = setup();
    retrieve.mockResolvedValue({ latest_charge: { payment_method_details: { type: 'konbini' } } });
    create.mockResolvedValue(
      stripeRefund({
        status: 'requires_action',
        next_action: {
          type: 'display_details',
          display_details: {
            expires_at: 1_795_575_600,
            email_sent: { email_sent_at: 1_791_687_600, email_sent_to: 'buyer@example.com' },
          },
        },
      }),
    );
    mockRecord.mockResolvedValue(resultRow({ status: 'pending' }));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toMatchObject({ kind: 'accepted', status: 'pending' });

    const [params] = create.mock.calls[0];
    expect(params).toMatchObject({ instructions_email: 'buyer@example.com' });
    // 印（metadata）にお客様のメールは入れない
    expect(JSON.stringify(params.metadata)).not.toContain('buyer@example.com');
    expect(mockRecord).toHaveBeenCalledWith(
      deps.store,
      REFUND_ID,
      expect.objectContaining({
        stripeStatus: 'requires_action',
        paymentMethodType: 'konbini',
        customerActionExpiresAt: '2026-11-25T03:00:00.000Z',
      }),
    );
  });

  it('注文が無ければ order_not_found で断り、記録も Stripe も動かさない', async () => {
    const { deps, tables, create } = setup();
    tables.orders = { data: null, error: null };

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({ kind: 'refused', code: 'order_not_found' });
    expect(mockBegin).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['支払いの番号が空', null],
    ['Checkout Session の番号', 'cs_test_1'],
    ['空の文字', ''],
  ])('支払いの番号が pi_ で始まらない（%s）注文は、返事待ちの記録を作らずに order_not_refundable で断る', async (_name, paymentIntentId) => {
    const { deps, tables, create } = setup();
    tables.orders = { data: { payment_intent_id: paymentIntentId, shipping_email: null }, error: null };

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({ kind: 'refused', code: 'order_not_refundable' });
    expect(mockBegin).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('注文の読み取りが DB の誤りで落ちたら、RefundStoreError を投げる（記録は作らない）', async () => {
    const { deps, tables } = setup();
    tables.orders = { data: null, error: { message: 'connection refused', code: '08006' } };

    const error = await submitAdminRefund(deps, ADMIN_INPUT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RefundStoreError);
    expect(error).toMatchObject({ operation: 'load_order', code: '08006' });
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it.each(['exceeds_refundable', 'awaiting_refund_exists', 'must_include_unshipped', 'quantity_exceeds_unshipped'] as const)(
    'DB が %s で断ったら、refused でその記号を返し、Stripe には頼まない',
    async (code) => {
      const { deps, create } = setup();
      mockBegin.mockRejectedValue(new RefundOperationError(code));

      await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({ kind: 'refused', code });
      expect(create).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
    },
  );

  it('DB の想定外の誤り（RefundStoreError）は、断りにせずそのまま投げる', async () => {
    const { deps, create } = setup();
    const failure = new RefundStoreError('begin_order_refund', { code: '08006' });
    mockBegin.mockRejectedValue(failure);

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).rejects.toBe(failure);
    expect(create).not.toHaveBeenCalled();
  });

  it('Stripe が断ったら、記録をエラーにして stripe_rejected を返す（理由は総称なので言葉にしない）', async () => {
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

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({
      kind: 'stripe_rejected',
      refundId: REFUND_ID,
      reasonLabel: null,
    });
    expect(mockMarkError).toHaveBeenCalledWith(deps.store, REFUND_ID, 'stripe_rejected', false);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('断られた時に、知らせや見回りがもう記録を進めていたら、記録の今の状態で答える', async () => {
    const { deps, create } = setup();
    create.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'conflict', statusCode: 409 }),
    );
    mockMarkError.mockResolvedValue({ outcome: 'not_awaiting', orderId: ORDER_ID, exceptionId: null });
    mockGet.mockResolvedValue(refundRef({ status: 'succeeded' }));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({
      kind: 'accepted',
      refundId: REFUND_ID,
      status: 'succeeded',
      amount: 5000,
      replayed: true,
    });
  });

  it('通信が切れた（Stripe が返金を作ったか分からない）時は unknown。記録は返事待ちのまま、何も書かない', async () => {
    const { deps, create, schedule } = setup();
    create.mockRejectedValue(new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'socket hang up' }));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
    expect(mockMarkError).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each(UNREADABLE_TYPES)(
    '支払いの種類が読めない（%s）時は、Stripe に頼まずに unknown。記録には何も書かない（頼み直しで instructions_email の有無が変わらないように）',
    async (_name, makeUnreadable) => {
      const { deps, create, retrieve } = setup();
      makeUnreadable(retrieve);

      await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
      expect(create).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
      expect(mockMarkError).not.toHaveBeenCalled();
    },
  );

  it('Stripe は受け付けたが、結果を記録に書けなかった時も unknown（同じ番号の確かめ直しで書き直す）', async () => {
    const { deps, schedule } = setup();
    mockRecord.mockRejectedValue(new RefundStoreError('record_order_refund_result', { code: '08006' }));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
    expect(console.error).toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('作ったその場で失敗の返金（PayPay など）は、stripe_rejected と失敗の理由の言葉で答え、店へ知らせる', async () => {
    const { deps, create, notifyShop } = setup();
    create.mockResolvedValue(stripeRefund({ status: 'failed', failure_reason: 'declined' }));
    mockRecord.mockResolvedValue(FAILED_RESULT);
    mockList.mockResolvedValue([refundRow({ failureReason: 'declined' })]);
    mockGet.mockResolvedValue(refundRef({ status: 'failed', stripeRefundId: 're_test_1' }));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({
      kind: 'stripe_rejected',
      refundId: REFUND_ID,
      reasonLabel: 'カード会社に断られました',
    });
    expect(notifyShop).toHaveBeenCalledTimes(1);
    expect(notifyShop).toHaveBeenCalledWith('ex-1', expect.objectContaining({ reason: 'refund_failed', detail: 'declined' }));
  });
});

describe('同じ二重防止の番号の送り直し（Review Focus 1）', () => {
  it.each(['pending', 'succeeded'] as const)(
    '記録がもう %s なら、Stripe を呼ばずに replayed: true で答える',
    async (status) => {
      const { deps, create, retrieve } = setup();
      mockBegin.mockResolvedValue({ ...REPLAYED, status });
      mockGet.mockResolvedValue(refundRef({ status }));

      await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({
        kind: 'accepted',
        refundId: REFUND_ID,
        status,
        amount: 5000,
        replayed: true,
      });
      expect(create).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['failed', 'expired', '口座の入力の期限が過ぎました'],
    ['error', 'not_found_in_stripe', 'Stripe に届きませんでした'],
    ['error', 'stripe_rejected', null],
  ] as const)(
    '記録が %s（理由 %s）なら、Stripe を呼ばずに stripe_rejected で答える',
    async (status, failureReason, reasonLabel) => {
      const { deps, create } = setup();
      mockBegin.mockResolvedValue({ ...REPLAYED, status });
      mockGet.mockResolvedValue(refundRef({ status, failureReason }));

      await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({
        kind: 'stripe_rejected',
        refundId: REFUND_ID,
        reasonLabel,
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('送り直しの記録が読めなければ order_not_found', async () => {
    const { deps, create } = setup();
    mockBegin.mockResolvedValue(REPLAYED);
    mockGet.mockResolvedValue(null);

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({ kind: 'refused', code: 'order_not_found' });
    expect(create).not.toHaveBeenCalled();
  });

  it('通信が切れた後の送り直しは、同じ重複防止キー・同じ中身で頼み直す。Stripe の返金は1件', async () => {
    const { deps, create } = setup();
    mockBegin.mockResolvedValueOnce(BEGAN).mockResolvedValueOnce(REPLAYED);
    create
      .mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'socket hang up' }))
      .mockResolvedValueOnce(stripeRefund({ status: 'pending' }));
    mockGet.mockResolvedValue(refundRef({ createdAt: FRESH }));
    mockRecord.mockResolvedValue(resultRow({ status: 'pending' }));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({
      kind: 'accepted',
      refundId: REFUND_ID,
      status: 'pending',
      amount: 5000,
      replayed: true,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: `order-refund-${REFUND_ID}` });
    // 2回目の頼みは、キーも中身も1回目と同じ（Stripe は1回目が通っていれば、同じ返金を返すだけ）
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['10分前', FRESH],
    ['ちょうど23時間前', EXACTLY_23_HOURS_AGO],
  ])('%s に作った返事待ちの記録は、同じ重複防止キーで頼み直して結果を書く', async (_age, createdAt) => {
    const { deps, create } = setup();
    mockBegin.mockResolvedValue(REPLAYED);
    mockGet.mockResolvedValue(refundRef({ createdAt }));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toMatchObject({
      kind: 'accepted',
      status: 'pending',
      replayed: true,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 5000 }), {
      idempotencyKey: `order-refund-${REFUND_ID}`,
    });
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('23時間を超えた返事待ちは、頼み直さず一覧から印で探し、見つかった返金の結果を書く（支払いの種類はその時に1回読む）', async () => {
    const { deps, create, list, retrieve } = setup();
    mockBegin.mockResolvedValue(REPLAYED);
    mockGet.mockResolvedValue(refundRef({ createdAt: OVER_23_HOURS_AGO }));
    list.mockReturnValue(
      asyncIterableOf([stripeRefund({ id: 're_other', metadata: {} }), stripeRefund({ id: 're_found', status: 'succeeded' })]),
    );
    mockRecord.mockResolvedValue(resultRow({ status: 'succeeded' }));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({
      kind: 'accepted',
      refundId: REFUND_ID,
      status: 'succeeded',
      amount: 5000,
      replayed: true,
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

  it('23時間を超えた返事待ちで、一覧に印の返金が無ければ unknown。エラーにはしない（毎時の見回りが片付ける）', async () => {
    const { deps, create, list, retrieve } = setup();
    mockBegin.mockResolvedValue(REPLAYED);
    mockGet.mockResolvedValue(refundRef({ createdAt: OVER_23_HOURS_AGO }));
    list.mockReturnValue(asyncIterableOf([stripeRefund({ id: 're_other', metadata: {} })]));

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
    expect(create).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockMarkError).not.toHaveBeenCalled();
  });

  it('23時間を超えた返事待ちで、一覧が読めなければ unknown', async () => {
    const { deps, create, list } = setup();
    mockBegin.mockResolvedValue(REPLAYED);
    mockGet.mockResolvedValue(refundRef({ createdAt: OVER_23_HOURS_AGO }));
    list.mockImplementation(() => {
      throw new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'socket hang up' });
    });

    await expect(submitAdminRefund(deps, ADMIN_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
    expect(create).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('頼み直す Stripe の返金は、今の入力ではなく記録の理由・実行した人で作る（中身が違うと Stripe が重複防止キーの誤りにする）', async () => {
    const { deps, create } = setup();
    mockBegin.mockResolvedValue(REPLAYED);
    mockGet.mockResolvedValue(refundRef({ stripeReason: 'duplicate', actorId: ACTOR_ID }));

    await submitAdminRefund(deps, { orderId: ORDER_ID, actorId: OTHER_ACTOR_ID, request: ADMIN_REQUEST });

    expect(create).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_card_1',
        amount: 5000,
        reason: 'duplicate',
        metadata: { order_id: ORDER_ID, refund_id: REFUND_ID, actor_id: ACTOR_ID },
      },
      { idempotencyKey: `order-refund-${REFUND_ID}` },
    );
  });
});

describe('submitPaidOrderCancel（支払い済みの注文のキャンセル）', () => {
  it.each([
    ['suspected_fraud', 'fraudulent'],
    ['stock_unavailable', 'requested_by_customer'],
    ['customer_request', 'requested_by_customer'],
    ['other', 'requested_by_customer'],
  ] as const)('取消の理由 %s は、Stripe に %s と伝える。額と送料は DB が決める', async (reason, stripeReason) => {
    const { deps, create } = setup();

    await expect(
      submitPaidOrderCancel(deps, { orderId: ORDER_ID, actorId: ACTOR_ID, request: { ...CANCEL_REQUEST, reason } }),
    ).resolves.toMatchObject({ kind: 'accepted', replayed: false });

    expect(mockBegin).toHaveBeenCalledWith(deps.store, {
      orderId: ORDER_ID,
      source: 'order_cancel',
      requestKey: REQUEST_KEY,
      lines: [],
      restock: true,
      shippingAmount: 0,
      amount: 0,
      note: 'お客様から連絡あり',
      stripeReason,
      cancelReason: reason,
      notifyCustomer: true,
      actorId: ACTOR_ID,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ reason: stripeReason }), {
      idempotencyKey: `order-refund-${REFUND_ID}`,
    });
  });

  it('1つでも発送した注文は DB が order_not_cancellable で断る。Stripe には頼まない', async () => {
    const { deps, create } = setup();
    mockBegin.mockRejectedValue(new RefundOperationError('order_not_cancellable'));

    await expect(
      submitPaidOrderCancel(deps, { orderId: ORDER_ID, actorId: ACTOR_ID, request: CANCEL_REQUEST }),
    ).resolves.toEqual({ kind: 'refused', code: 'order_not_cancellable' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('startAutomaticRefund（自動の返金）', () => {
  it('①取り消した注文への入金: 理由を付けずに頼む。受け取った額を DB に渡し、額は DB が決める', async () => {
    const { deps, create } = setup();

    await expect(
      startAutomaticRefund(deps, { orderId: ORDER_ID, source: 'auto_cancelled_order_payment', receivedAmount: 5500 }),
    ).resolves.toMatchObject({ kind: 'accepted', status: 'pending', replayed: false });

    expect(mockBegin).toHaveBeenCalledWith(deps.store, {
      orderId: ORDER_ID,
      source: 'auto_cancelled_order_payment',
      requestKey: null,
      lines: [],
      restock: false,
      shippingAmount: 0,
      amount: 0,
      note: null,
      stripeReason: null,
      cancelReason: null,
      notifyCustomer: true,
      actorId: null,
      receivedAmount: 5500,
    });
    const [params] = create.mock.calls[0];
    expect(params).not.toHaveProperty('reason');
    expect(params.metadata).toEqual({ order_id: ORDER_ID, refund_id: REFUND_ID });
  });

  it('②支払額の違い: 理由 other・メモ・在庫に戻す・知らせるを渡し、Stripe には requested_by_customer と伝える', async () => {
    const { deps, create } = setup();

    await expect(
      startAutomaticRefund(deps, { orderId: ORDER_ID, source: 'auto_amount_mismatch', receivedAmount: null }),
    ).resolves.toMatchObject({ kind: 'accepted', replayed: false });

    expect(mockBegin).toHaveBeenCalledWith(deps.store, {
      orderId: ORDER_ID,
      source: 'auto_amount_mismatch',
      requestKey: null,
      lines: [],
      restock: true,
      shippingAmount: 0,
      amount: 0,
      note: '支払額の違いの自動の取消',
      stripeReason: 'requested_by_customer',
      cancelReason: 'other',
      notifyCustomer: true,
      actorId: null,
      receivedAmount: null,
    });
    expect(create.mock.calls[0][0]).toMatchObject({ reason: 'requested_by_customer' });
  });

  it('DB が断ったら refused を返す（自動ではやり直さない。呼ぶ側が要対応を開いたままにする）', async () => {
    const { deps, create } = setup();
    mockBegin.mockRejectedValue(new RefundOperationError('order_not_refundable'));

    await expect(
      startAutomaticRefund(deps, { orderId: ORDER_ID, source: 'auto_cancelled_order_payment', receivedAmount: 5500 }),
    ).resolves.toEqual({ kind: 'refused', code: 'order_not_refundable' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('confirmAwaitingRefund（返事待ちの記録の確かめ直し。P24）', () => {
  it('記録が無ければ order_not_found。DB も Stripe も読まない', async () => {
    const { deps, from, create } = setup();
    mockGet.mockResolvedValue(null);

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({ kind: 'refused', code: 'order_not_found' });
    expect(from).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('別の注文の記録も order_not_found（記録があることを教えない）', async () => {
    const { deps, create } = setup();
    mockGet.mockResolvedValue(refundRef({ orderId: OTHER_ORDER_ID }));

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({ kind: 'refused', code: 'order_not_found' });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['pending', 'succeeded'] as const)('記録がもう %s なら、Stripe を呼ばずに replayed: true で答える', async (status) => {
    const { deps, from, create } = setup();
    mockGet.mockResolvedValue(refundRef({ status, amount: 3200 }));

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({
      kind: 'accepted',
      refundId: REFUND_ID,
      status,
      amount: 3200,
      replayed: true,
    });
    expect(from).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'expired', '口座の入力の期限が過ぎました'],
    ['error', 'not_found_in_stripe', 'Stripe に届きませんでした'],
    ['error', 'stripe_rejected', null],
  ] as const)('記録が %s（理由 %s）なら、Stripe を呼ばずに stripe_rejected で答える', async (status, failureReason, reasonLabel) => {
    const { deps, from, create } = setup();
    mockGet.mockResolvedValue(refundRef({ status, failureReason }));

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({
      kind: 'stripe_rejected',
      refundId: REFUND_ID,
      reasonLabel,
    });
    // 失敗の理由は getOrderRefund の答えにある。ほかの表は読まない
    expect(from).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('返事待ちの記録は、記録の額・理由・実行した人で、同じ重複防止キーで頼み直す', async () => {
    const { deps, create } = setup();
    mockGet.mockResolvedValue(refundRef({ amount: 3200, createdAt: FRESH }));

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({
      kind: 'accepted',
      refundId: REFUND_ID,
      status: 'pending',
      amount: 3200,
      replayed: true,
    });

    expect(mockBegin).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_card_1',
        amount: 3200,
        reason: 'requested_by_customer',
        metadata: { order_id: ORDER_ID, refund_id: REFUND_ID, actor_id: ACTOR_ID },
      },
      { idempotencyKey: `order-refund-${REFUND_ID}` },
    );
    expect(mockRecord).toHaveBeenCalledWith(deps.store, REFUND_ID, expect.objectContaining({ stripeRefundId: 're_test_1' }));
  });

  it('自動の返金の記録（理由も実行した人も無い）は、どちらも付けずに頼み直す', async () => {
    const { deps, create } = setup();
    mockGet.mockResolvedValue(
      refundRef({ source: 'auto_cancelled_order_payment', amount: 3200, stripeReason: null, actorId: null }),
    );

    await confirmAwaitingRefund(deps, CONFIRM_INPUT);

    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_card_1', amount: 3200, metadata: { order_id: ORDER_ID, refund_id: REFUND_ID } },
      { idempotencyKey: `order-refund-${REFUND_ID}` },
    );
  });

  it('コンビニ払いの記録だけ、注文の連絡先のメールを instructions_email に渡す', async () => {
    const { deps, create, retrieve } = setup();
    retrieve.mockResolvedValue({ latest_charge: { payment_method_details: { type: 'konbini' } } });
    mockGet.mockResolvedValue(refundRef({ createdAt: FRESH }));

    await confirmAwaitingRefund(deps, CONFIRM_INPUT);

    expect(create.mock.calls[0][0]).toMatchObject({ instructions_email: 'buyer@example.com' });
    expect(mockRecord).toHaveBeenCalledWith(deps.store, REFUND_ID, expect.objectContaining({ paymentMethodType: 'konbini' }));
  });

  it('23時間を超えた返事待ちは、頼み直さず一覧から印で探して、見つかった返金の結果を書く', async () => {
    const { deps, create, list } = setup();
    mockGet.mockResolvedValue(refundRef({ createdAt: OVER_23_HOURS_AGO }));
    list.mockReturnValue(asyncIterableOf([stripeRefund({ id: 're_found', status: 'succeeded' })]));
    mockRecord.mockResolvedValue(resultRow({ status: 'succeeded' }));

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({
      kind: 'accepted',
      refundId: REFUND_ID,
      status: 'succeeded',
      amount: 5000,
      replayed: true,
    });
    expect(create).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith(deps.store, REFUND_ID, expect.objectContaining({ stripeRefundId: 're_found' }));
  });

  it('23時間を超えた返事待ちで、一覧に印の返金が無ければ unknown', async () => {
    const { deps, create, list } = setup();
    mockGet.mockResolvedValue(refundRef({ createdAt: OVER_23_HOURS_AGO }));
    list.mockReturnValue(asyncIterableOf([stripeRefund({ id: 're_other', metadata: {} })]));

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
    expect(create).not.toHaveBeenCalled();
    expect(mockMarkError).not.toHaveBeenCalled();
  });

  it('頼み直しを Stripe が断ったら、記録をエラーにして stripe_rejected', async () => {
    const { deps, create } = setup();
    mockGet.mockResolvedValue(refundRef({ createdAt: FRESH }));
    create.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'already refunded',
        code: 'charge_already_refunded',
        statusCode: 400,
      }),
    );
    mockMarkError.mockResolvedValue({ outcome: 'errored', orderId: ORDER_ID, exceptionId: null });

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({
      kind: 'stripe_rejected',
      refundId: REFUND_ID,
      reasonLabel: null,
    });
    expect(mockMarkError).toHaveBeenCalledWith(deps.store, REFUND_ID, 'stripe_rejected', false);
  });

  it('頼み直しでも答えが分からなければ unknown（記録は返事待ちのまま）', async () => {
    const { deps, create } = setup();
    mockGet.mockResolvedValue(refundRef({ createdAt: FRESH }));
    create.mockRejectedValue(new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'socket hang up' }));

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockMarkError).not.toHaveBeenCalled();
  });

  it('頼み直しで重複防止キーの誤り（中身が違う）になっても、記録をエラーにせず unknown（前の頼みが通っているかもしれない）', async () => {
    const { deps, create } = setup();
    mockGet.mockResolvedValue(refundRef({ createdAt: FRESH }));
    create.mockRejectedValue(
      new Stripe.errors.StripeIdempotencyError({
        type: 'idempotency_error',
        message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.',
        statusCode: 400,
      }),
    );

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
    expect(mockMarkError).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it.each(UNREADABLE_TYPES)(
    '頼み直しでも、支払いの種類が読めない（%s）時は、Stripe に頼まずに unknown。記録には何も書かない',
    async (_name, makeUnreadable) => {
      const { deps, create, retrieve } = setup();
      mockGet.mockResolvedValue(refundRef({ createdAt: FRESH }));
      makeUnreadable(retrieve);

      await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({ kind: 'unknown', refundId: REFUND_ID });
      expect(create).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
      expect(mockMarkError).not.toHaveBeenCalled();
    },
  );

  it('注文の支払いの番号が pi_ で始まらなければ order_not_refundable。Stripe には頼まない', async () => {
    const { deps, tables, create } = setup();
    mockGet.mockResolvedValue(refundRef({ createdAt: FRESH }));
    tables.orders = { data: { payment_intent_id: null, shipping_email: null }, error: null };

    await expect(confirmAwaitingRefund(deps, CONFIRM_INPUT)).resolves.toEqual({ kind: 'refused', code: 'order_not_refundable' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('applyRefundSideEffects（結果を書いた後の始末。P15）', () => {
  it('メールの予定が書かれていれば、送る処理を動かす。失敗でなければ店には知らせない', async () => {
    const { deps, schedule, notifyShop } = setup();

    await applyRefundSideEffects(deps, resultRow({ status: 'pending', emailEnqueued: true }));

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(notifyShop).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('メールの予定も失敗も無ければ、何も動かさず、何も読まない', async () => {
    const { deps, schedule, notifyShop, from } = setup();

    await applyRefundSideEffects(deps, resultRow({ status: 'pending', emailEnqueued: false }));

    expect(schedule).not.toHaveBeenCalled();
    expect(notifyShop).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('初めて失敗になった返金は、失敗の理由・足りなかった商品と数・キャンセルのお知らせの有無を付けて、店へ知らせる', async () => {
    const { deps, tables, notifyShop } = setup();
    mockList.mockResolvedValue([
      refundRow({
        source: 'order_cancel',
        notifyCustomer: true,
        failureReason: 'expired',
        lines: [
          lineRow({ orderItemId: ITEM_ID, quantity: 2, rereserveShortage: 1 }),
          lineRow({ orderItemId: OTHER_ITEM_ID, quantity: 1, rereserveShortage: 0 }),
        ],
      }),
      refundRow({ refundId: 'other-refund', failureReason: 'declined' }),
    ]);
    mockGet.mockResolvedValue(refundRef({ status: 'failed', stripeRefundId: 're_test_1' }));
    tables.order_items = {
      data: [{ id: ITEM_ID, item_name: 'ワイドパンツ', color: 'ネイビー', size: 'M' }],
      error: null,
    };

    await applyRefundSideEffects(deps, FAILED_RESULT);

    expect(mockList).toHaveBeenCalledWith(deps.store, ORDER_ID);
    expect(mockGet).toHaveBeenCalledWith(deps.store, REFUND_ID);
    expect(notifyShop).toHaveBeenCalledTimes(1);
    expect(notifyShop).toHaveBeenCalledWith('ex-1', {
      reason: 'refund_failed',
      detail: 'expired',
      orderId: ORDER_ID,
      paymentRef: 're_test_1',
      detectedAt: NOW,
      refundFailure: {
        failureReasonLabel: '口座の入力の期限が過ぎました',
        shortages: [{ name: 'ワイドパンツ（ネイビー / M）', quantity: 1 }],
        cancelEmailSent: true,
      },
    });
  });

  it('色もサイズも無い商品の名前は、品名だけ。Stripe の返金の番号が記録に無ければ、記録の番号を使う', async () => {
    const { deps, tables, notifyShop } = setup();
    mockList.mockResolvedValue([refundRow({ failureReason: null, lines: [lineRow({ rereserveShortage: 2 })] })]);
    mockGet.mockResolvedValue(refundRef({ status: 'failed', stripeRefundId: null }));
    tables.order_items = { data: [{ id: ITEM_ID, item_name: 'ワイドパンツ', color: null, size: null }], error: null };

    await applyRefundSideEffects(deps, FAILED_RESULT);

    expect(notifyShop).toHaveBeenCalledWith(
      'ex-1',
      expect.objectContaining({
        detail: 'unknown',
        paymentRef: REFUND_ID,
        refundFailure: {
          failureReasonLabel: '不明な理由',
          shortages: [{ name: 'ワイドパンツ', quantity: 2 }],
          cancelEmailSent: false,
        },
      }),
    );
  });

  it('足りなかった商品が無ければ、商品の名前は読まない', async () => {
    const { deps, from, notifyShop } = setup();
    mockList.mockResolvedValue([refundRow({ lines: [lineRow({ rereserveShortage: 0 })] })]);

    await applyRefundSideEffects(deps, FAILED_RESULT);

    expect(from).not.toHaveBeenCalledWith('order_items');
    expect(notifyShop).toHaveBeenCalledWith(
      'ex-1',
      expect.objectContaining({ refundFailure: expect.objectContaining({ shortages: [] }) }),
    );
  });

  it.each([
    ['order_cancel', true, true],
    ['auto_amount_mismatch', true, true],
    ['order_cancel', false, false],
    ['admin', true, false],
    ['auto_cancelled_order_payment', true, false],
  ] as const)(
    '道 %s・お客様に知らせる %s の返金の失敗は、キャンセルのお知らせを送った注文か: %s',
    async (source, notifyCustomer, expected) => {
      const { deps, notifyShop } = setup();
      mockList.mockResolvedValue([refundRow({ source, notifyCustomer })]);

      await applyRefundSideEffects(deps, FAILED_RESULT);

      const [, alert] = notifyShop.mock.calls[0];
      expect(alert).toMatchObject({ refundFailure: { cancelEmailSent: expected } });
    },
  );

  it('返事待ちからそのまま失敗した返金（P21。受け付けた時刻が無い）は、キャンセルのお知らせを送っていないので、送った注文とは書かない', async () => {
    const { deps, notifyShop } = setup();
    mockList.mockResolvedValue([refundRow({ source: 'order_cancel', notifyCustomer: true, acceptedAt: null })]);

    await applyRefundSideEffects(deps, FAILED_RESULT);

    const [, alert] = notifyShop.mock.calls[0];
    expect(alert).toMatchObject({ refundFailure: { cancelEmailSent: false } });
  });

  it('要対応の番号が無ければ、店へ知らせない（何も読まない）', async () => {
    const { deps, notifyShop } = setup();

    await applyRefundSideEffects(deps, resultRow({ status: 'failed', newlyFailed: true, exceptionId: null }));

    expect(notifyShop).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('初めての失敗でなければ（同じ失敗の知らせをもう一度受けた時）、店へ知らせない', async () => {
    const { deps, notifyShop } = setup();

    await applyRefundSideEffects(deps, resultRow({ status: 'failed', newlyFailed: false, exceptionId: 'ex-1' }));

    expect(notifyShop).not.toHaveBeenCalled();
  });

  it('知らせの準備（返金の記録の読み取り）で落ちても、例外を投げない。未送信の要対応は毎時の見回りが送る', async () => {
    const { deps, notifyShop } = setup();
    mockList.mockRejectedValue(new RefundStoreError('list_order_refunds', { code: '08006' }));

    await expect(applyRefundSideEffects(deps, FAILED_RESULT)).resolves.toBeUndefined();

    expect(notifyShop).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('店への知らせの送信で落ちても、例外を投げない', async () => {
    const { deps, notifyShop } = setup();
    notifyShop.mockRejectedValue(new Error('smtp down'));

    await expect(applyRefundSideEffects(deps, FAILED_RESULT)).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalled();
  });
});

describe('createDefaultRefundServiceDeps', () => {
  it('service_role の client・Stripe の client・今の時刻・店への知らせ・メールの処理を束ねる', async () => {
    const client = { from: jest.fn(), rpc: jest.fn() };
    const stripe = { refunds: {}, paymentIntents: {} };
    const database = { name: 'reconciler-database' };
    const mailer = { name: 'reconciler-mailer' };
    (createServiceRoleClient as jest.MockedFunction<typeof createServiceRoleClient>).mockResolvedValue(client as never);
    (getStripeServerClient as jest.MockedFunction<typeof getStripeServerClient>).mockReturnValue(stripe as never);
    (createSupabaseReconcilerDatabase as jest.MockedFunction<typeof createSupabaseReconcilerDatabase>).mockReturnValue(
      database as never,
    );
    (createReconcilerMailer as jest.MockedFunction<typeof createReconcilerMailer>).mockReturnValue(mailer as never);
    (notifyShopOfException as jest.MockedFunction<typeof notifyShopOfException>).mockResolvedValue(true);

    const deps = await createDefaultRefundServiceDeps();

    expect(deps.store).toBe(client);
    expect(deps.stripe).toBe(stripe);
    expect(deps.now()).toBeInstanceOf(Date);
    expect(deps.scheduleOrderEmailDelivery).toBe(scheduleOrderEmailDelivery);
    expect(createSupabaseReconcilerDatabase).toHaveBeenCalledWith(client);

    const alert = {
      reason: 'refund_failed',
      detail: 'expired',
      orderId: ORDER_ID,
      paymentRef: 're_test_1',
      detectedAt: NOW,
    } as ShopPaymentAlert;
    await expect(deps.notifyShopOfRefundFailure('ex-1', alert)).resolves.toBe(true);
    expect(notifyShopOfException).toHaveBeenCalledWith({ database, mailer }, 'ex-1', alert);
  });
});
