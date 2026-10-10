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

const mockMaybeSingle = jest.fn();
const mockFrom = jest.fn(() => ({
  select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }),
}));
const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ from: mockFrom })),
  createServiceRoleClient: jest.fn(async () => ({ rpc: mockRpc })),
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

const mockReconcile = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: (...args: unknown[]) => mockReconcile(...args),
  ReconcileTransientError: jest.requireActual('@/lib/stripe/checkout-payment-reader').ReconcileTransientError,
}));

const mockDeps = { name: 'reconciler-deps' };
jest.mock('@/lib/stripe/checkout-payment-reconciler-deps', () => ({
  createDefaultReconcilerDeps: async () => mockDeps,
}));

// 行を書いた後に注文のメールを返事の後に送る予約（after() を使うので、試験では差し替える）
const mockScheduleOrderEmailDelivery = jest.fn();
jest.mock('@/lib/orders/email/order-email-schedule', () => ({
  scheduleOrderEmailDelivery: (...args: unknown[]) => mockScheduleOrderEmailDelivery(...args),
}));

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));

const mockRequireCsrf = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: (...args: unknown[]) => mockRequireCsrf(...args),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { POST } from '@/app/api/admin/orders/[id]/status/route';
import { ReconcileTransientError } from '@/lib/stripe/checkout-payment-reader';

type RouteResponse = { status: number; body: Record<string, unknown> };

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const CANCEL = { status: 'cancelled', reason: 'customer_request' };

async function post(body: Record<string, unknown>): Promise<RouteResponse> {
  const request = new Request(`http://localhost/api/admin/orders/${ORDER_ID}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await POST(request, CONTEXT)) as unknown as RouteResponse;
}

function currentOrder(status: string, overrides: Record<string, unknown> = {}) {
  mockMaybeSingle.mockResolvedValue({
    data: { id: ORDER_ID, status, payment_intent_id: 'pi_1', checkout_session_id: 'cs_1', ...overrides },
    error: null,
  });
}

function reconciled(orderStatus: string) {
  mockReconcile.mockResolvedValue({ kind: 'ok', action: { type: 'none' }, orderId: ORDER_ID, orderStatus });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockExpireOpenCheckoutSession.mockResolvedValue('expired');
  reconciled('cancelled');
});

describe('POST /api/admin/orders/[id]/status - CSRF トークン', () => {
  // 確認が通れば取消が成功する状態にしておく。拒否されたとき、処理が進んだことが 200 で分かる
  beforeEach(() => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
  });

  // clearAllMocks は実装を戻さない。ここで置いた既定の応答を、後ろのテストへ持ち越さない
  afterEach(() => {
    mockRpc.mockReset();
    mockMaybeSingle.mockReset();
  });

  test.each([
    ['取消', 403],
    ['取消（確認の DB の失敗）', 500],
  ])('CSRF トークンが合わなければ、%s は何もせず、確認の応答（%i）をそのまま返す', async (_name, status) => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status }));

    const res = await post(CANCEL);

    expect(res.status).toBe(status);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('CSRF トークンが合えば、取消は処理を進める', async () => {
    const res = await post(CANCEL);

    expect(mockRequireCsrf).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  test('権限が無ければ CSRF を確かめず、認可の応答をそのまま返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, body: { error: 'Forbidden' } } });

    const res = await post(CANCEL);

    expect(res.status).toBe(403);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/orders/[id]/status - 発送', () => {
  // 発送は /api/admin/orders/[id]/fulfillments に移した（グループ E-1）。この窓口は未入金の注文の取消だけ
  test.each([
    ['従来の発送の中身', { status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' }],
    ['「送るか」を付けた発送の中身', { status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012', notifyCustomer: false }],
    ['中身が足りない発送', { status: 'shipped' }],
  ])('status: shipped（%s）は 400 を返し、DB を読まず、発送の関数も呼ばない', async (_name, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request body');
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalledWith('admin_ship_paid_order', expect.anything());
    expect(mockScheduleOrderEmailDelivery).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid request body' }));
  });
});

describe('POST /api/admin/orders/[id]/status - 取消', () => {
  test('取消の理由が無ければ 400 を返す', async () => {
    expect((await post({ status: 'cancelled' })).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('理由が「その他」ならメモが要る', async () => {
    const res = await post({ status: 'cancelled', reason: 'other', note: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('メモ');
  });

  test('メモは500文字まで', async () => {
    expect((await post({ ...CANCEL, note: 'あ'.repeat(501) })).status).toBe(400);
  });

  test('支払い手続き中の注文は、開いている決済を失効させてから、実行者・理由・メモ・お知らせを付けて照合する', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });

    const res = await post({ ...CANCEL, note: '電話で依頼', notifyCustomer: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: 'cancelled' });
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(mockStripe, 'cs_1');
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, {
      checkoutSessionId: 'cs_1',
      paymentIntentId: null,
      adminCancel: { actorId: 'admin-1', reason: 'customer_request', note: '電話で依頼', notifyCustomer: false },
    });
    expect(mockExpireOpenCheckoutSession.mock.invocationCallOrder[0]).toBeLessThan(mockReconcile.mock.invocationCallOrder[0]);
    expect(mockScheduleOrderEmailDelivery).toHaveBeenCalledTimes(1);
  });

  test('お知らせは既定で送る', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });

    await post(CANCEL);

    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, expect.objectContaining({
      adminCancel: expect.objectContaining({ notifyCustomer: true }),
    }));
  });

  test('払込票が有効な入金待ちは取り消さず、409 と払込期限を返す', async () => {
    currentOrder('pending');
    mockReadCheckoutPayment.mockResolvedValue({
      state: { kind: 'awaiting_payment' },
      voucherExpiresAt: new Date('2026-09-30T14:59:59.000Z'),
    });

    const res = await post(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ cancelBlockedUntil: '2026-09-30T14:59:59.000Z' });
    expect(res.body.error).toContain('払込期限');
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
  });

  test('払込票の期限が切れた入金待ちは、照合して取消にする', async () => {
    currentOrder('pending');
    mockReadCheckoutPayment.mockResolvedValue({ state: { kind: 'voucher_expired' }, voucherExpiresAt: null });

    const res = await post(CANCEL);

    expect(res.status).toBe(200);
    expect(mockReadCheckoutPayment).toHaveBeenCalledWith(mockStripe, { checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' });
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, expect.objectContaining({ checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' }));
  });

  test('照合の結果が入金済みなら取り消さず 409 を返す', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
    reconciled('paid');

    const res = await post(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('支払いが完了した');
  });

  test('要対応になったら理由を表示する', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
    mockReconcile.mockResolvedValue({
      kind: 'needs_action',
      exceptionId: 'exception-1',
      reason: 'stripe_object_missing',
      orderId: ORDER_ID,
      orderStatus: 'payment_in_progress',
    });

    const res = await post(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Stripe に支払いが無い');
  });

  test('一時的な失敗は 503 で「時間をおいて再試行」を返す', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
    mockReconcile.mockRejectedValue(new ReconcileTransientError('stripe_unavailable'));

    const res = await post(CANCEL);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('時間をおいて再試行');
  });

  test('開いている決済の失効が一時的な Stripe の失敗なら 503 を返し、照合は呼ばない', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
    mockExpireOpenCheckoutSession.mockRejectedValue({ type: 'StripeConnectionError' });

    const res = await post(CANCEL);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('時間をおいて再試行');
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('照合が Stripe 以外の理由で失敗したら 500 で中立な文言を返し、失敗した段階を監査に残す', async () => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockReconcile.mockRejectedValue({ code: '23514', message: 'x' });

    try {
      const res = await post(CANCEL);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('未入金の注文を取り消せませんでした。');
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error',
        detail: 'Failed to cancel unpaid order',
        metadata: { step: 'reconcile' },
      }));
      expect(error).toHaveBeenCalledWith('[admin.orders.status] Failed to cancel unpaid order:', { code: '23514', message: 'x' });
    } finally {
      error.mockRestore();
    }
  });

  test('失敗の注文は専用 RPC に理由とメモを渡し、お客様には送らない', async () => {
    currentOrder('failed');
    mockRpc.mockResolvedValue({ data: [{ id: ORDER_ID, status: 'cancelled' }], error: null });

    const res = await post({ ...CANCEL, note: '電話で依頼' });

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_cancel_failed_order', {
      _order_id: ORDER_ID,
      _actor_id: 'admin-1',
      _cancel_reason: 'customer_request',
      _note: '電話で依頼',
    });
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('失敗の注文の取消と別の更新が競合したら 409 を返す', async () => {
    currentOrder('failed');
    mockRpc.mockResolvedValue({ data: [], error: null });

    const res = await post(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.success).not.toBe(true);
  });

  test.each([
    ['shipped', '発送済み'],
    ['paid', '返金処理'],
    ['abandoned', '放棄'],
  ])('%s の注文は取り消せず 409 を返す', async (status, message) => {
    currentOrder(status);

    const res = await post(CANCEL);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(message);
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('取消済みの注文への再送は 200 を返す（冪等）', async () => {
    currentOrder('cancelled');

    expect((await post(CANCEL)).body).toEqual({ success: true, status: 'cancelled' });
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
