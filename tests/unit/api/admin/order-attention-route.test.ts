jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));

const mockRequireCsrf = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: (...args: unknown[]) => mockRequireCsrf(...args),
}));

const mockRpc = jest.fn();
const mockSelectColumns: string[] = [];
let exceptionRows: unknown[] = [];
let reviewRows: unknown[] = [];
// 要対応に付いた注文。「注文を取り消して解決」が取り消しの前に読む
let attachedOrder: Record<string, unknown> | null = null;
let attachedOrderError: unknown = null;

function listQuery(rows: () => unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ['is', 'not', 'order', 'eq']) {
    query[method] = () => query;
  }
  query.limit = async () => ({ data: rows(), count: rows().length, error: null });
  query.maybeSingle = async () => ({
    data: attachedOrderError ? null : { orders: attachedOrder },
    error: attachedOrderError,
  });
  return query;
}

const mockServiceClient = {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: (table: string) => ({
    select: (columns: string) => {
      mockSelectColumns.push(columns);
      return table === 'payment_exceptions' ? listQuery(() => exceptionRows) : listQuery(() => reviewRows);
    },
  }),
};
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockServiceClient),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

const mockSendOrderCanceledEmail = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/orders/order-lifecycle-emails', () => ({
  sendOrderCanceledEmail: (...args: unknown[]) => mockSendOrderCanceledEmail(...args),
}));

const mockStripe = { name: 'stripe' };
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => mockStripe,
}));

const mockExpireOpenCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/checkout-session-expiry', () => ({
  expireOpenCheckoutSession: (...args: unknown[]) => mockExpireOpenCheckoutSession(...args),
}));

const mockReadCheckoutPayment = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reader', () => ({
  ...jest.requireActual('@/lib/stripe/checkout-payment-reader'),
  readCheckoutPayment: (...args: unknown[]) => mockReadCheckoutPayment(...args),
}));

import { GET as getAttention } from '@/app/api/admin/order-attention/route';
import { POST as postReview } from '@/app/api/admin/orders/[id]/review/route';
import { POST as postResolve } from '@/app/api/admin/payment-exceptions/[id]/resolve/route';
import { ReconcileTransientError } from '@/lib/stripe/checkout-payment-reader';

type RouteResponse = { status: number; body: Record<string, any> };

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const EXCEPTION_ID = 'b1b2c3d4-1111-2222-8333-444455556666';
const RESOLVE_URL = `http://localhost/api/admin/payment-exceptions/${EXCEPTION_ID}/resolve`;
const RESOLVE_CONTEXT = { params: Promise.resolve({ id: EXCEPTION_ID }) };

function jsonRequest(url: string, body: unknown = {}) {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function resolve(body: Record<string, unknown>): Promise<RouteResponse> {
  return (await postResolve(jsonRequest(RESOLVE_URL, body), RESOLVE_CONTEXT)) as unknown as RouteResponse;
}

async function resolveRawBody(rawBody: string): Promise<RouteResponse> {
  const request = new Request(RESOLVE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
  return (await postResolve(request, RESOLVE_CONTEXT)) as unknown as RouteResponse;
}

async function review(id = ORDER_ID): Promise<RouteResponse> {
  return (await postReview(
    jsonRequest(`http://localhost/api/admin/orders/${id}/review`),
    { params: Promise.resolve({ id }) },
  )) as unknown as RouteResponse;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectColumns.length = 0;
  exceptionRows = [];
  reviewRows = [];
  attachedOrder = null;
  attachedOrderError = null;
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'supporter', actorEmail: null });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockExpireOpenCheckoutSession.mockResolvedValue('expired');
  mockReadCheckoutPayment.mockResolvedValue({ state: { kind: 'missing' }, voucherExpiresAt: null });
});

describe('GET /api/admin/order-attention', () => {
  it('未解決の要対応と未確認の要確認を、件数と一緒に返す', async () => {
    exceptionRows = [{
      id: EXCEPTION_ID,
      reason: 'order_not_creatable',
      detail: 'item_unavailable',
      order_id: null,
      payment_ref: 'cs_1',
      first_detected_at: '2026-09-27T01:00:00.000Z',
      last_detected_at: '2026-09-27T02:00:00.000Z',
      detection_count: 2,
      orders: null,
    }, {
      id: 'c1b2c3d4-1111-2222-8333-444455556666',
      reason: 'unexpected_state',
      detail: null,
      order_id: ORDER_ID,
      payment_ref: 'cs_2',
      first_detected_at: '2026-09-27T01:30:00.000Z',
      last_detected_at: '2026-09-27T01:30:00.000Z',
      detection_count: 1,
      orders: { status: 'payment_in_progress' },
    }];
    reviewRows = [{ id: ORDER_ID, status: 'paid', review_reason: 'stock_not_reserved', review_marked_at: '2026-09-27T01:00:00.000Z' }];

    const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;

    expect(res.status).toBe(200);
    expect(res.body.data.counts).toEqual({ exceptions: 2, reviews: 1 });
    expect(res.body.data.exceptions[0]).toEqual({
      id: EXCEPTION_ID,
      reason: 'order_not_creatable',
      reasonLabel: '注文を作れない支払い',
      detail: 'item_unavailable',
      orderId: null,
      orderNumber: null,
      orderStatus: null,
      paymentRef: 'cs_1',
      firstDetectedAt: '2026-09-27T01:00:00.000Z',
      lastDetectedAt: '2026-09-27T02:00:00.000Z',
      detectionCount: 2,
      canCancelOrder: false,
    });
    expect(res.body.data.exceptions[1]).toMatchObject({ orderNumber: 'ORD-A1B2C3D4', canCancelOrder: true });
    expect(res.body.data.reviews[0]).toEqual({
      orderId: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      orderStatus: 'paid',
      reviewReason: 'stock_not_reserved',
      reviewReasonLabel: '在庫を確保できなかった注文',
      reviewMarkedAt: '2026-09-27T01:00:00.000Z',
    });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.read', expect.any(Request));
  });

  it('お客様の個人情報の列を読まない', async () => {
    await getAttention(new Request('http://localhost/api/admin/order-attention'));

    expect(mockSelectColumns.join(',')).not.toMatch(/shipping_|email|name|phone/);
  });

  it('権限が無ければ認可の応答をそのまま返す', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, body: { error: 'Forbidden' } } });

    const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;

    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/orders/:id/review', () => {
  it('確認済みにし、実行者を渡す', async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });

    const res = await review();

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('mark_order_reviewed', { _order_id: ORDER_ID, _actor_id: 'admin-1' });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.orders.review', actor_id: 'admin-1', outcome: 'success' }));
  });

  it('確認済みにできる要確認が無ければ 409', async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });

    expect((await review()).status).toBe(409);
  });

  it('CSRF トークンが合わなければ何もしない', async () => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status: 403 }));

    expect((await review()).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('注文 ID の形が違えば 400', async () => {
    expect((await review('not-a-uuid')).status).toBe(400);
  });
});

describe('POST /api/admin/payment-exceptions/:id/resolve', () => {
  const IN_PROGRESS_ORDER = { id: ORDER_ID, status: 'payment_in_progress', checkout_session_id: 'cs_1', payment_intent_id: null };
  const PENDING_ORDER = { id: ORDER_ID, status: 'pending', checkout_session_id: 'cs_2', payment_intent_id: 'pi_2' };
  const CANCEL_BODY = { cancelOrder: true, cancelReason: 'other', note: 'Stripe に支払いが無い' };
  const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

  function cancelResolved(cancelledFrom: 'payment_in_progress' | 'pending' = 'payment_in_progress') {
    mockRpc.mockResolvedValue({ data: [{ resolved: true, order_id: ORDER_ID, cancelled_from: cancelledFrom }], error: null });
  }

  it('メモを付けて解決済みにする', async () => {
    mockRpc.mockResolvedValue({ data: [{ resolved: true, order_id: null, cancelled_from: null }], error: null });

    const res = await resolve({ note: 'Stripe で返金済み' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, orderCancelled: false });
    expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', {
      _exception_id: EXCEPTION_ID,
      _actor_id: 'admin-1',
      _note: 'Stripe で返金済み',
      _cancel_order: false,
      _cancel_reason: null,
      _notify_customer: null,
    });
    // 取り消さない解決は、注文も Stripe も読まない
    expect(mockSelectColumns).toHaveLength(0);
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
  });

  it('別の管理者が先に解決していたら 409(二重に取り消さない)', async () => {
    mockRpc.mockResolvedValue({ data: [{ resolved: false, order_id: ORDER_ID, cancelled_from: null }], error: null });

    const res = await resolve({ note: 'メモ' });

    expect(res.status).toBe(409);
    expect(mockSendOrderCanceledEmail).not.toHaveBeenCalled();
  });

  it('「注文を取り消して解決」は理由とメモが要る', async () => {
    expect((await resolve({ cancelOrder: true, note: 'メモ' })).status).toBe(400);
    expect((await resolve({ cancelOrder: true, cancelReason: 'other' })).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([true, false])('注文を取り消して解決し、取消のお知らせは notifyCustomer=%s のときだけ送る', async (notifyCustomer) => {
    attachedOrder = IN_PROGRESS_ORDER;
    mockRpc.mockResolvedValue({ data: [{ resolved: true, order_id: ORDER_ID, cancelled_from: 'payment_in_progress' }], error: null });

    const res = await resolve({ cancelOrder: true, cancelReason: 'other', note: 'Stripe に支払いが無い', notifyCustomer });

    expect(res.body).toEqual({ success: true, orderCancelled: true });
    expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({
      _cancel_order: true,
      _cancel_reason: 'other',
      _notify_customer: notifyCustomer,
    }));
    expect(mockSendOrderCanceledEmail).toHaveBeenCalledTimes(notifyCustomer ? 1 : 0);
  });

  it('取り消すときに notifyCustomer を送らなければ、既定でお知らせを送る（RPC には true を渡す）', async () => {
    attachedOrder = IN_PROGRESS_ORDER;
    cancelResolved();

    const res = await resolve(CANCEL_BODY);

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({ _notify_customer: true }));
    expect(mockSendOrderCanceledEmail).toHaveBeenCalledTimes(1);
  });

  it('未入金でない注文は取り消せず 409（Stripe には触れず、RPC が断る）', async () => {
    attachedOrder = { ...IN_PROGRESS_ORDER, status: 'paid' };
    mockRpc.mockResolvedValue({ data: null, error: { message: 'ORDER_NOT_CANCELLABLE' } });

    const res = await resolve({ cancelOrder: true, cancelReason: 'other', note: 'メモ' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('未入金');
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
  });

  it('注文が付いていない要対応も、Stripe には触れず RPC に断らせる', async () => {
    attachedOrder = null;
    mockRpc.mockResolvedValue({ data: null, error: { message: 'ORDER_NOT_CANCELLABLE' } });

    const res = await resolve(CANCEL_BODY);

    expect(res.status).toBe(409);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
  });

  it('メモは500文字まで', async () => {
    expect((await resolve({ note: 'あ'.repeat(501) })).status).toBe(400);
  });

  it('CSRF トークンが合わなければ何もしない', async () => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status: 403 }));

    expect((await resolve({ note: 'メモ' })).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['壊れた JSON', '{"note": '],
    ['空の本文', ''],
    ['null', 'null'],
  ])('本文が %s なら 400 で、解決しない（解決は開き直せないので既定値で補わない）', async (_name, rawBody) => {
    const res = await resolveRawBody(rawBody);

    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  describe('注文を取り消して解決するときの Stripe の確認', () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    describe('支払い手続き中の注文', () => {
      beforeEach(() => {
        attachedOrder = IN_PROGRESS_ORDER;
      });

      it('開いている決済画面を失効させてから、取り消して解決する', async () => {
        cancelResolved();

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, orderCancelled: true });
        expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(mockStripe, 'cs_1');
        expect(mockExpireOpenCheckoutSession.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[0]);
        expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
      });

      it('決済画面が開いていなければ（決済が進んだ可能性）409 で、取り消さない', async () => {
        mockExpireOpenCheckoutSession.mockResolvedValue('not_open');

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(409);
        expect(res.body.error).toContain('決済が進んだ');
        expect(mockRpc).not.toHaveBeenCalled();
        expect(mockSendOrderCanceledEmail).not.toHaveBeenCalled();
        expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
          action: 'admin.payment_exceptions.resolve',
          outcome: 'conflict',
          resource_id: EXCEPTION_ID,
        }));
      });

      it('Stripe に決済画面が無ければ、そのまま取り消して解決する', async () => {
        mockExpireOpenCheckoutSession.mockResolvedValue('missing');
        cancelResolved();

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(200);
        expect(mockRpc).toHaveBeenCalledTimes(1);
      });

      it('決済画面の ID が無ければ、Stripe には触れずに取り消して解決する', async () => {
        attachedOrder = { ...IN_PROGRESS_ORDER, checkout_session_id: null };
        cancelResolved();

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(200);
        expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
        expect(mockRpc).toHaveBeenCalledTimes(1);
      });

      it('失効が一時的な Stripe の失敗なら 503 で「時間をおいて再試行」を返し、取り消さない', async () => {
        mockExpireOpenCheckoutSession.mockRejectedValue({ type: 'StripeConnectionError' });

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(503);
        expect(res.body.error).toContain('時間をおいて再試行');
        expect(mockRpc).not.toHaveBeenCalled();
      });

      it('失効が一時的でない失敗なら 500 で中立な文言を返し、失敗した段階を監査に残して、取り消さない', async () => {
        mockExpireOpenCheckoutSession.mockRejectedValue({ type: 'StripeInvalidRequestError', statusCode: 400 });

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('未入金の注文を取り消せませんでした。');
        expect(mockRpc).not.toHaveBeenCalled();
        expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
          outcome: 'error',
          metadata: { order_id: ORDER_ID, step: 'expire' },
        }));
      });
    });

    describe('入金待ちの注文', () => {
      beforeEach(() => {
        attachedOrder = PENDING_ORDER;
      });

      it.each<[string, Record<string, unknown>, Date | null, string | null]>([
        ['払込票が有効な入金待ち', { kind: 'awaiting_payment' }, new Date(FAR_FUTURE), FAR_FUTURE],
        ['状態を分類できなくても払込期限がまだ先', { kind: 'not_applicable', reason: 'unexpected' }, new Date(FAR_FUTURE), FAR_FUTURE],
        ['払込期限が読めなくても Stripe が支払いを待っている', { kind: 'awaiting_payment' }, null, null],
      ])('%s なら 409 と払込期限を返し、取り消さない', async (_name, state, voucherExpiresAt, cancelBlockedUntil) => {
        mockReadCheckoutPayment.mockResolvedValue({ state, voucherExpiresAt });

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(409);
        expect(res.body.cancelBlockedUntil).toBe(cancelBlockedUntil);
        expect(res.body.error).toContain('払込期限');
        expect(mockReadCheckoutPayment).toHaveBeenCalledWith(mockStripe, { checkoutSessionId: 'cs_2', paymentIntentId: 'pi_2' });
        expect(mockRpc).not.toHaveBeenCalled();
        expect(mockSendOrderCanceledEmail).not.toHaveBeenCalled();
        expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
        expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
          outcome: 'conflict',
          metadata: { order_id: ORDER_ID, voucher_expires_at: cancelBlockedUntil },
        }));
      });

      it('払込票の期限が切れていれば、取り消して解決する', async () => {
        mockReadCheckoutPayment.mockResolvedValue({ state: { kind: 'voucher_expired' }, voucherExpiresAt: null });
        cancelResolved('pending');

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, orderCancelled: true });
        expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({ _cancel_order: true }));
      });

      it('Stripe に支払いが無ければ、取り消して解決する', async () => {
        mockReadCheckoutPayment.mockResolvedValue({ state: { kind: 'missing' }, voucherExpiresAt: null });
        cancelResolved('pending');

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(200);
        expect(mockRpc).toHaveBeenCalledTimes(1);
        expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
      });

      it('確認が一時的な Stripe の失敗なら 503 で「時間をおいて再試行」を返し、取り消さない', async () => {
        mockReadCheckoutPayment.mockRejectedValue(new ReconcileTransientError('stripe_unavailable'));

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(503);
        expect(res.body.error).toContain('時間をおいて再試行');
        expect(mockRpc).not.toHaveBeenCalled();
      });

      it('確認が一時的でない失敗なら 500 で中立な文言を返し、失敗した段階を監査に残して、取り消さない', async () => {
        mockReadCheckoutPayment.mockRejectedValue(new Error('checkoutSessionId or paymentIntentId is required'));

        const res = await resolve(CANCEL_BODY);

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('未入金の注文を取り消せませんでした。');
        expect(mockRpc).not.toHaveBeenCalled();
        expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
          outcome: 'error',
          metadata: { order_id: ORDER_ID, step: 'read' },
        }));
      });
    });

    it('付いている注文を読めなければ 500 で、取り消さない', async () => {
      attachedOrderError = { code: 'XX000', message: 'connection lost' };

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(500);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    });
  });
});
