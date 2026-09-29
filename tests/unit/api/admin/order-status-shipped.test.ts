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

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1' }),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockSendOrderShippedEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/orders/order-shipped-email', () => ({
  sendOrderShippedEmail: (...args: unknown[]) => mockSendOrderShippedEmail(...args),
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
  mockExpireOpenCheckoutSession.mockResolvedValue('expired');
  reconciled('cancelled');
});

describe('POST /api/admin/orders/[id]/status - 発送', () => {
  test('paid の注文を発送済みにできる', async () => {
    mockRpc.mockResolvedValue({ data: [{ id: ORDER_ID, shipping_email: 'hanako@example.com' }], error: null });

    const res = await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' });

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_ship_paid_order', {
      _actor_id: 'admin-1',
      _order_id: ORDER_ID,
      _shipping_carrier: 'yamato',
      _tracking_number: '1234-5678-9012',
    });
    expect(mockSendOrderShippedEmail).toHaveBeenCalledTimes(1);
  });

  test('更新対象が無ければ 409 を返し、配送先と支払額の確認を促し、メールを送らない', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const res = await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('配送先');
    expect(res.body.error).toContain('支払額');
    expect(mockSendOrderShippedEmail).not.toHaveBeenCalled();
  });

  test('未知の配送業者と記号の混ざった追跡番号は 400 を返す', async () => {
    expect((await post({ status: 'shipped', carrier: 'dhl', trackingNumber: '1234' })).status).toBe(400);
    expect((await post({ status: 'shipped', carrier: 'yamato', trackingNumber: '12 34/56' })).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
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
