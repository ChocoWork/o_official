/** @jest-environment node */

import Stripe from 'stripe';
import {
  createStripeRefund,
  listPaymentIntentRefunds,
  readPaymentMethodType,
  refundIdempotencyKey,
  toStripeRefundSnapshot,
  type CreateStripeRefundInput,
} from '@/lib/orders/refund/refund-stripe';
import { ACTOR_ID, ORDER_ID, REFUND_ID, asyncIterableOf, stripeRefund } from './refund-test-fixtures';

const PAYMENT_INTENT_ID = 'pi_card_1';

type CreateMock = jest.Mock<Promise<Stripe.Refund>, [Record<string, unknown>, { idempotencyKey: string }]>;

/** refunds.create だけを持つ Stripe。呼ばれた引数を読めるように、引数の型を付けておく */
function stripeWithCreate(refund: Stripe.Refund = stripeRefund()): { stripe: Stripe; create: CreateMock } {
  const create = jest.fn(async () => refund) as unknown as CreateMock;
  return { stripe: { refunds: { create } } as unknown as Stripe, create };
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('refundIdempotencyKey', () => {
  it('記録の番号から order-refund-{番号} を作る（同じ記録は同じキー、別の記録は別のキー）', () => {
    expect(refundIdempotencyKey(REFUND_ID)).toBe(`order-refund-${REFUND_ID}`);
    expect(refundIdempotencyKey(REFUND_ID)).toBe(refundIdempotencyKey(REFUND_ID));
    expect(refundIdempotencyKey('b1b2c3d4-1111-4222-8333-444455557777')).not.toBe(refundIdempotencyKey(REFUND_ID));
  });
});

describe('toStripeRefundSnapshot', () => {
  it('カードの返金: 照会番号とその種類、Stripe の項目、支払いの種類を写す。時刻は秒から ISO にする', () => {
    const refund = stripeRefund({
      status: 'succeeded',
      destination_details: {
        type: 'card',
        card: {
          type: 'refund',
          reference: '24492159275000012345678',
          reference_status: 'available',
          reference_type: 'acquirer_reference_number',
        },
      },
    });

    expect(toStripeRefundSnapshot(refund, 'card')).toEqual({
      stripeRefundId: 're_test_1',
      stripeStatus: 'succeeded',
      pendingReason: null,
      failureReason: null,
      customerActionExpiresAt: null,
      paymentMethodType: 'card',
      referenceNumber: '24492159275000012345678',
      referenceType: 'acquirer_reference_number',
      amount: 5000,
      reason: 'requested_by_customer',
      created: '2026-10-03T04:00:00.000Z',
      paymentIntentId: 'pi_card_1',
      metadataRefundId: REFUND_ID,
      metadataOrderId: ORDER_ID,
    });
  });

  it.each([
    [
      '照会番号がまだ届いていないカードは、番号が null、種類は返金先の種類',
      { type: 'card', card: { type: 'pending', reference_status: 'pending' } },
      null,
      'card',
    ],
    ['カード以外（PayPay）は、番号が null、種類は返金先の種類', { type: 'paypay' }, null, 'paypay'],
    ['返金先の詳細がまだ無ければ、どちらも null', undefined, null, null],
    [
      '照会番号が空の文字なら null（記録の列は1文字以上）。種類が空の文字なら返金先の種類',
      { type: 'card', card: { type: 'refund', reference: '', reference_type: '' } },
      null,
      'card',
    ],
  ] as const)('%s', (_name, destination, referenceNumber, referenceType) => {
    const snapshot = toStripeRefundSnapshot(stripeRefund({ destination_details: destination }), 'card');

    expect(snapshot.referenceNumber).toBe(referenceNumber);
    expect(snapshot.referenceType).toBe(referenceType);
  });

  it('コンビニ払いの返金: 口座の入力の期限（秒）を ISO にして写す', () => {
    const refund = stripeRefund({
      status: 'requires_action',
      next_action: {
        type: 'display_details',
        display_details: {
          expires_at: 1_795_575_600,
          email_sent: { email_sent_at: 1_791_687_600, email_sent_to: 'buyer@example.com' },
        },
      },
    });

    const snapshot = toStripeRefundSnapshot(refund, 'konbini');

    expect(snapshot).toMatchObject({
      stripeStatus: 'requires_action',
      paymentMethodType: 'konbini',
      customerActionExpiresAt: '2026-11-25T03:00:00.000Z',
    });
  });

  it('保留の理由と失敗の理由をそのまま写す', () => {
    expect(toStripeRefundSnapshot(stripeRefund({ status: 'pending', pending_reason: 'insufficient_funds' }), null)).toMatchObject({
      stripeStatus: 'pending',
      pendingReason: 'insufficient_funds',
      failureReason: null,
    });
    expect(
      toStripeRefundSnapshot(stripeRefund({ status: 'failed', failure_reason: 'expired_or_canceled_card' }), null),
    ).toMatchObject({ stripeStatus: 'failed', pendingReason: null, failureReason: 'expired_or_canceled_card' });
  });

  it.each([
    ['文字', 'pi_card_1', 'pi_card_1'],
    ['物（expand された PaymentIntent）', { id: 'pi_object_1' }, 'pi_object_1'],
    ['null', null, null],
  ] as const)('payment_intent が%sの時、支払いの番号を写す', (_name, paymentIntent, expected) => {
    expect(toStripeRefundSnapshot(stripeRefund({ payment_intent: paymentIntent }), null).paymentIntentId).toBe(expected);
  });

  it.each([
    ['こちらが付けた印が両方ある', { order_id: ORDER_ID, refund_id: REFUND_ID }, REFUND_ID, ORDER_ID],
    ['印が空（Stripe の画面からの返金）', {}, null, null],
    ['印そのものが null', null, null, null],
    ['注文の印だけ、返金の印は空の文字', { order_id: ORDER_ID, refund_id: '' }, null, ORDER_ID],
  ] as const)('%s', (_name, metadata, refundId, orderId) => {
    const snapshot = toStripeRefundSnapshot(stripeRefund({ metadata }), null);

    expect(snapshot.metadataRefundId).toBe(refundId);
    expect(snapshot.metadataOrderId).toBe(orderId);
  });

  it('状態も理由も無い返金は、状態を保留、理由を null にする（お金が戻ったとは書かない）', () => {
    const snapshot = toStripeRefundSnapshot(stripeRefund({ status: null, reason: null }), null);

    expect(snapshot.stripeStatus).toBe('pending');
    expect(snapshot.reason).toBeNull();
  });
});

describe('createStripeRefund', () => {
  const INPUT: CreateStripeRefundInput = {
    refundId: REFUND_ID,
    orderId: ORDER_ID,
    actorId: ACTOR_ID,
    paymentIntentId: PAYMENT_INTENT_ID,
    amount: 5000,
    stripeReason: 'requested_by_customer',
    instructionsEmail: null,
  };

  it('重複防止キーは order-refund-{記録の番号}。印には注文・返金の記録・実行した人の番号だけを入れる', async () => {
    const { stripe, create } = stripeWithCreate();

    await createStripeRefund(stripe, INPUT);

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
  });

  it('実行した人がいない返金（自動の返金）は、印に actor_id を入れない', async () => {
    const { stripe, create } = stripeWithCreate();

    await createStripeRefund(stripe, { ...INPUT, actorId: null });

    const [params] = create.mock.calls[0];
    expect(params.metadata).toEqual({ order_id: ORDER_ID, refund_id: REFUND_ID });
    expect(params.metadata).not.toHaveProperty('actor_id');
  });

  it('Stripe に伝える理由が無い返金（自動の返金①）は、reason ごと送らない', async () => {
    const { stripe, create } = stripeWithCreate();

    await createStripeRefund(stripe, { ...INPUT, stripeReason: null });

    const [params] = create.mock.calls[0];
    expect(params).not.toHaveProperty('reason');
  });

  it.each(['requested_by_customer', 'fraudulent'] as const)('取消で伝える理由 %s はそのまま送る', async (stripeReason) => {
    const { stripe, create } = stripeWithCreate();
    await createStripeRefund(stripe, { ...INPUT, stripeReason });
    expect(create.mock.calls[0][0]).toHaveProperty('reason', stripeReason);
  });

  it('instructions_email は、渡した時だけ（コンビニ払いだけ）送る。お客様のメールは印に入れない', async () => {
    const withoutEmail = stripeWithCreate();
    await createStripeRefund(withoutEmail.stripe, INPUT);
    expect(withoutEmail.create.mock.calls[0][0]).not.toHaveProperty('instructions_email');

    const withEmail = stripeWithCreate();
    await createStripeRefund(withEmail.stripe, { ...INPUT, instructionsEmail: 'buyer@example.com' });
    const [params] = withEmail.create.mock.calls[0];
    expect(params).toMatchObject({ instructions_email: 'buyer@example.com' });
    expect(JSON.stringify(params.metadata)).not.toContain('buyer@example.com');
  });

  it('作れたら、Stripe の返金の写しを返す（支払いの種類は呼ぶ側が埋めるので null）', async () => {
    const refund = stripeRefund({ status: 'requires_action' });
    const { stripe } = stripeWithCreate(refund);

    await expect(createStripeRefund(stripe, INPUT)).resolves.toEqual({
      kind: 'created',
      refund: toStripeRefundSnapshot(refund, null),
    });
  });

  const REJECTED_CASES: Array<[string, unknown, string | null]> = [
    [
      'カードの誤り（402）',
      new Stripe.errors.StripeCardError({ type: 'card_error', message: 'declined', code: 'card_declined', statusCode: 402 }),
      'card_declined',
    ],
    [
      '要求の誤り（400。返金済みの支払い）',
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'already refunded',
        code: 'charge_already_refunded',
        statusCode: 400,
      }),
      'charge_already_refunded',
    ],
    [
      '要求の誤り（402。Stripe の残高が足りない）',
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'insufficient balance',
        code: 'balance_insufficient',
        statusCode: 402,
      }),
      'balance_insufficient',
    ],
    [
      '要求の誤り（404。支払いが無い）',
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'no such payment_intent',
        code: 'resource_missing',
        statusCode: 404,
      }),
      'resource_missing',
    ],
    [
      '要求の誤り（409。コードなし）',
      new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'conflict', statusCode: 409 }),
      null,
    ],
  ];

  it.each(REJECTED_CASES)('%s は rejected（Stripe が受け付けなかった）', async (_name, error, code) => {
    const { stripe, create } = stripeWithCreate();
    create.mockRejectedValue(error);

    await expect(createStripeRefund(stripe, INPUT)).resolves.toEqual({ kind: 'rejected', code });
  });

  const UNKNOWN_CASES: Array<[string, unknown]> = [
    ['通信の誤り', new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'socket hang up' })],
    ['API の誤り（500）', new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'internal error', statusCode: 500 })],
    ['回数の制限（429）', new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: 'slow down', statusCode: 429 })],
    ['認証の誤り（401）', new Stripe.errors.StripeAuthenticationError({ type: 'authentication_error', message: 'bad key', statusCode: 401 })],
    [
      // 同じキーで中身が違う頼み。前の頼みが通ったかを Stripe は教えないので、断られたとは言えない
      '重複防止キーの誤り（同じキーで中身が違う）',
      new Stripe.errors.StripeIdempotencyError({
        type: 'idempotency_error',
        message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.',
        statusCode: 400,
      }),
    ],
    [
      '同じ重複防止キーの頼みが処理の途中（409。idempotency_key_in_use）',
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'another request is in progress',
        code: 'idempotency_key_in_use',
        statusCode: 409,
      }),
    ],
    ['Stripe の誤りではない失敗（時間切れなど）', new Error('timeout')],
    ['誤りの形ではない物', 'boom'],
  ];

  it.each(UNKNOWN_CASES)('%s は unknown（Stripe が返金を作ったか分からない）', async (_name, error) => {
    const { stripe, create } = stripeWithCreate();
    create.mockRejectedValue(error);

    await expect(createStripeRefund(stripe, INPUT)).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('listPaymentIntentRefunds', () => {
  /** refunds.list（for await で読む）と paymentIntents.retrieve を持つ Stripe。一覧は支払いを読まないことを確かめるために retrieve も置く */
  function stripeWithList(refunds: Stripe.Refund[]) {
    const list = jest.fn(() => asyncIterableOf(refunds));
    const retrieve = jest.fn(async () => ({ latest_charge: { payment_method_details: { type: 'konbini' } } }));
    return { stripe: { refunds: { list }, paymentIntents: { retrieve } } as unknown as Stripe, list, retrieve };
  }

  it('その支払いの返金を、全部のページを順にたどって読む。写しの支払いの種類は null で、支払いは読まない', async () => {
    const { stripe, list, retrieve } = stripeWithList([
      stripeRefund({ id: 're_1' }),
      stripeRefund({ id: 're_2', metadata: {} }),
      stripeRefund({ id: 're_3', status: 'succeeded' }),
    ]);

    const snapshots = await listPaymentIntentRefunds(stripe, PAYMENT_INTENT_ID);

    expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_card_1', limit: 100 });
    expect(retrieve).not.toHaveBeenCalled();
    expect(snapshots.map((snapshot) => snapshot.stripeRefundId)).toEqual(['re_1', 're_2', 're_3']);
    expect(snapshots.map((snapshot) => snapshot.paymentMethodType)).toEqual([null, null, null]);
    // 印の無い返金（Stripe の画面からの返金）は、印が null の写しになる
    expect(snapshots.map((snapshot) => snapshot.metadataRefundId)).toEqual([REFUND_ID, null, REFUND_ID]);
  });

  it('返金が1件も無ければ空の配列', async () => {
    const { stripe, retrieve } = stripeWithList([]);

    await expect(listPaymentIntentRefunds(stripe, PAYMENT_INTENT_ID)).resolves.toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe('readPaymentMethodType', () => {
  function stripeWithRetrieve(retrieve: jest.Mock): Stripe {
    return { paymentIntents: { retrieve } } as unknown as Stripe;
  }

  it.each([
    ['カード', { latest_charge: { payment_method_details: { type: 'card' } } }, 'card'],
    ['コンビニ払い', { latest_charge: { payment_method_details: { type: 'konbini' } } }, 'konbini'],
    ['latest_charge が文字（expand されていない）', { latest_charge: 'ch_1' }, null],
    ['latest_charge が無い', { latest_charge: null }, null],
    ['支払いの詳細が無い', { latest_charge: { payment_method_details: null } }, null],
  ] as const)('支払いの種類: %s', async (_name, paymentIntent, expected) => {
    const retrieve = jest.fn(async () => paymentIntent);

    await expect(readPaymentMethodType(stripeWithRetrieve(retrieve), PAYMENT_INTENT_ID)).resolves.toBe(expected);
    expect(retrieve).toHaveBeenCalledWith('pi_card_1', { expand: ['latest_charge'] });
  });

  it('読めなければ null（例外を投げない）。ログには誤りの名前だけを出し、文は出さない', async () => {
    const retrieve = jest.fn(async () => {
      throw new Error('secret detail from stripe');
    });

    await expect(readPaymentMethodType(stripeWithRetrieve(retrieve), PAYMENT_INTENT_ID)).resolves.toBeNull();

    expect(console.warn).toHaveBeenCalledWith('[refund] payment method type was not read', 'Error');
    expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain('secret detail');
  });
});
