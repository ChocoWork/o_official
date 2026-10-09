import { NextRequest } from 'next/server';

jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
      })),
    },
  };
});

const mockFrom = jest.fn();
const mockGetUser = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: mockFrom, auth: { getUser: mockGetUser } }),
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockRetrieveCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    checkout: { sessions: { retrieve: mockRetrieveCheckoutSession } },
  }),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockExtractAuthToken = jest.fn();
jest.mock('@/lib/auth/request-token', () => ({
  extractAuthToken: (...args: unknown[]) => mockExtractAuthToken(...args),
}));

// 注文の作成・状態の変更・メールは照合関数が持つ（checkout-payment-reconciler.test.ts が確かめる）。
const mockReconcile = jest.fn();
const mockReconcilerDeps = { name: 'reconciler-deps' };
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: (...args: unknown[]) => mockReconcile(...args),
  ReconcileTransientError: jest.requireActual('@/lib/stripe/checkout-payment-reader').ReconcileTransientError,
}));
jest.mock('@/lib/stripe/checkout-payment-reconciler-deps', () => ({
  createDefaultReconcilerDeps: async () => mockReconcilerDeps,
}));

// 照合が書いた注文のメールを返事の後に送る予約（after() を使うので、試験では差し替える）
const mockScheduleOrderEmailDelivery = jest.fn();
jest.mock('@/lib/orders/email/order-email-schedule', () => ({
  scheduleOrderEmailDelivery: (...args: unknown[]) => mockScheduleOrderEmailDelivery(...args),
}));

import { POST } from '@/app/api/checkout/complete/route';
import { ReconcileTransientError } from '@/lib/stripe/checkout-payment-reader';

type RouteResponse = { status: number; body: Record<string, unknown> };

function makeRequest(body: Record<string, unknown>, sessionId = 'sess-abc'): NextRequest {
  const req = new NextRequest('http://localhost/api/checkout/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  Object.defineProperty(req, 'cookies', {
    value: { get: (name: string) => (name === 'session_id' && sessionId ? { value: sessionId } : undefined) },
  });

  return req;
}

async function post(body: Record<string, unknown> = { checkoutSessionId: 'cs_test' }, sessionId?: string) {
  return (await POST(makeRequest(body, sessionId))) as unknown as RouteResponse;
}

function stripeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    currency: 'jpy',
    amount_total: 5500,
    total_details: { amount_discount: 0 },
    metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-123' },
    payment_intent: {
      id: 'pi_test',
      payment_method_types: ['card'],
      latest_charge: { payment_method_details: { type: 'card' } },
    },
    ...overrides,
  };
}

function setupSupabase(draft: { id: string; session_id: string } | null = { id: 'draft-123', session_id: 'sess-abc' }) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'checkout_drafts') {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockResolvedValue({ data: draft, error: null }),
          }),
        }),
      };
    }

    return {};
  });
}

describe('POST /api/checkout/complete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession());
    mockReconcile.mockResolvedValue({
      kind: 'ok',
      action: { type: 'mark_paid', expectedStatus: 'payment_in_progress', emailVariant: 'order_confirmed' },
      orderId: 'order-1',
      orderStatus: 'paid',
    });
    setupSupabase();
  });

  test('session_id Cookie がない場合は 400 を返す', async () => {
    expect((await post({ checkoutSessionId: 'cs_test' }, '')).status).toBe(400);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('bank 決済と空の Session ID は入力の誤りとして 400 を返す', async () => {
    expect((await post({ paymentMethod: 'bank', checkoutSessionId: 'cs_test' })).status).toBe(400);
    expect((await post({ checkoutSessionId: '' })).status).toBe(400);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('決済完了の Session は照合関数に任せ、注文 ID・状態・支払方法を返す', async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orderId: 'order-1', status: 'paid', paymentMethod: 'stripe_card' });
    expect(mockReconcile).toHaveBeenCalledWith(mockReconcilerDeps, { checkoutSessionId: 'cs_test' });
    expect(mockRetrieveCheckoutSession).toHaveBeenCalledWith('cs_test', {
      expand: ['payment_intent', 'payment_intent.payment_method', 'payment_intent.latest_charge'],
    });
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'checkout:complete' }));
    expect(mockScheduleOrderEmailDelivery).toHaveBeenCalledTimes(1);
  });

  test('払込票を発行した Session は入金待ちの注文を返す', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession({ payment_status: 'unpaid' }));
    mockReconcile.mockResolvedValue({
      kind: 'ok',
      action: { type: 'place_and_mark_awaiting' },
      orderId: 'order-2',
      orderStatus: 'pending',
    });

    const res = await post();

    expect(res.body).toMatchObject({ orderId: 'order-2', status: 'pending' });
  });

  test('別のお客様の Session と下書きは 403 を返し、照合しない', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(
      stripeSession({ metadata: { session_id: 'someone-else', draft_id: 'draft-123' } }),
    );
    expect((await post()).status).toBe(403);

    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession());
    setupSupabase({ id: 'draft-123', session_id: 'someone-else' });
    expect((await post()).status).toBe(403);

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('下書き ID の無い Session と見つからない下書きは 400 を返す', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession({ metadata: { session_id: 'sess-abc' } }));
    expect((await post()).status).toBe(400);

    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession());
    setupSupabase(null);
    expect((await post()).status).toBe(400);

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('合計が0円の Session は理由を明示して 400 を返す（FREQ-389）', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession({ amount_total: 0, payment_status: 'no_payment_required' }));

    const res = await post();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Zero-amount checkout is not supported' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      detail: 'Zero-amount checkout session is not supported',
    }));
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('支払いが終わっていない Session は 400 を返す', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue(stripeSession({ status: 'open', payment_status: 'unpaid' }));

    expect((await post()).status).toBe(400);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('注文を作れなかった支払い（要対応）は 409 を返す', async () => {
    mockReconcile.mockResolvedValue({
      kind: 'needs_action',
      exceptionId: 'exception-1',
      reason: 'order_not_creatable',
      orderId: null,
      orderStatus: null,
    });

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Order could not be registered' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      metadata: expect.objectContaining({ exception_reason: 'order_not_creatable' }),
    }));
  });

  test('支払額の違いで要対応でも、入金済みの注文があれば注文 ID を返す', async () => {
    mockReconcile.mockResolvedValue({
      kind: 'needs_action',
      exceptionId: 'exception-2',
      reason: 'paid_amount_mismatch',
      orderId: 'order-3',
      orderStatus: 'paid',
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderId: 'order-3', status: 'paid' });
  });

  test('失敗・取消の注文は完了として返さない', async () => {
    mockReconcile.mockResolvedValue({
      kind: 'ok',
      action: { type: 'none' },
      orderId: 'order-4',
      orderStatus: 'failed',
    });

    expect((await post()).status).toBe(409);
  });

  test('照合の一時的な失敗は 503 を返す', async () => {
    mockReconcile.mockRejectedValue(new ReconcileTransientError('stripe_unavailable'));

    const res = await post();

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Temporarily unavailable' });
    expect(mockScheduleOrderEmailDelivery).not.toHaveBeenCalled();
  });

  test('ログインしていても注文の持ち主を書かず、ログインの確かめを呼ばない', async () => {
    const request = makeRequest({ checkoutSessionId: 'cs_test' });
    request.headers.set('Authorization', 'Bearer token-1');

    const res = await POST(request) as unknown as RouteResponse;

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orderId: 'order-1', status: 'paid', paymentMethod: 'stripe_card' });
    expect(mockReconcile).toHaveBeenCalledWith(mockReconcilerDeps, { checkoutSessionId: 'cs_test' });
    expect(mockFrom).not.toHaveBeenCalledWith('orders');
    expect(mockExtractAuthToken).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.link_order_to_user' }));
  });

  describe('Session の取得の失敗と、想定外の失敗の監査', () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    test.each<[string, unknown]>([
      ['通信の失敗', { type: 'StripeConnectionError' }],
      ['Stripe の障害', { type: 'StripeAPIError', statusCode: 500 }],
      ['回数制限', { type: 'StripeRateLimitError', statusCode: 429 }],
      ['type の無い 5xx', { statusCode: 503 }],
    ])('Session の取得が一時的な Stripe の失敗（%s）なら 503 を返し、監査に残して、照合しない', async (_name, stripeError) => {
      mockRetrieveCheckoutSession.mockRejectedValue(stripeError);

      const res = await post();

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Temporarily unavailable' });
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'checkout.complete',
        outcome: 'error',
        detail: 'Stripe checkout session retrieval is temporarily unavailable',
        metadata: { session_id: 'sess-abc', checkout_session_id: 'cs_test', reason: 'stripe_unavailable' },
      }));
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ detail: 'Complete checkout handler error' }));
    });

    test.each<[string, unknown]>([
      ['存在しない Session', { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 }],
      ['認証の失敗', { type: 'StripeAuthenticationError', statusCode: 401 }],
      ['想定外のコードの失敗', new TypeError('unexpected')],
    ])('Session の取得が一時的でない失敗（%s）は、これまでどおり 500 を返し、一般の失敗として監査に残す', async (_name, stripeError) => {
      mockRetrieveCheckoutSession.mockRejectedValue(stripeError);

      const res = await post();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'checkout.complete',
        outcome: 'error',
        detail: 'Complete checkout handler error',
      }));
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({
        detail: 'Stripe checkout session retrieval is temporarily unavailable',
      }));
    });

    test('Error でない DB のエラー（PostgREST の形）で失敗しても、監査に message と code を残して 500 を返す', async () => {
      mockReconcile.mockRejectedValue({
        code: '23514',
        message: 'new row for relation "orders" violates check constraint "orders_total_amount_check"',
        details: 'Failing row contains (a1b2c3d4, hanako@example.com)',
        hint: null,
      });

      const res = await post();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      // 残すのは message と code だけ。details は行の内容（個人情報）を含みうるので残さない
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'checkout.complete',
        outcome: 'error',
        detail: 'Complete checkout handler error',
        metadata: {
          error_message: 'new row for relation "orders" violates check constraint "orders_total_amount_check"',
          error_code: '23514',
        },
      }));
    });

    // code は文字列で付いているときだけ残す（無ければ、これまでの { error_message } のまま）
    test.each<[string, unknown, Record<string, string>]>([
      ['Error', new Error('unexpected failure'), { error_message: 'unexpected failure' }],
      [
        'code の付いた Error',
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        { error_message: 'socket hang up', error_code: 'ECONNRESET' },
      ],
      ['message の無いオブジェクト（code が文字列でない）', { code: 42 }, { error_message: 'Unknown error' }],
      ['文字列', 'boom', { error_message: 'Unknown error' }],
    ])('想定外の失敗が %s のときの監査の内容', async (_name, thrown, expectedMetadata) => {
      mockReconcile.mockRejectedValue(thrown);

      const res = await post();

      expect(res.status).toBe(500);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        detail: 'Complete checkout handler error',
        metadata: expectedMetadata,
      }));
    });
  });
});
