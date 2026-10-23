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

// 支払い済みのキャンセルは、回数の制限と返金の流れ（Stripe に頼む所まで）を通る。試験では差し替える
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockSubmitPaidOrderCancel = jest.fn();
const mockRefundDeps = { name: 'refund-deps' };
jest.mock('@/lib/orders/refund/refund-service', () => ({
  submitPaidOrderCancel: (...args: unknown[]) => mockSubmitPaidOrderCancel(...args),
  createDefaultRefundServiceDeps: async () => mockRefundDeps,
}));

import { POST } from '@/app/api/admin/orders/[id]/status/route';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
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
  test.each(['payment_declined', 'shop_error'])('新理由 %s を未入金の照合へ渡す', async (reason) => {
    currentOrder('payment_in_progress', { payment_intent_id: null });
    expect((await post({ ...CANCEL, reason })).status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, expect.objectContaining({
      adminCancel: expect.objectContaining({ reason }),
    }));
  });

  test.each(['payment_declined', 'shop_error'])('新理由 %s を失敗注文のRPCへ渡す', async (reason) => {
    currentOrder('failed');
    mockRpc.mockResolvedValue({ data: [{ id: ORDER_ID, status: 'cancelled' }], error: null });
    expect((await post({ ...CANCEL, reason })).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_cancel_failed_order', expect.objectContaining({ _cancel_reason: reason }));
  });

  test('知らない取消理由は400で、DBを読まない', async () => {
    expect((await post({ ...CANCEL, reason: 'unknown_reason' })).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test.each(['payment_declined', 'shop_error'])('新理由 %s を支払済みキャンセルへ渡す', async (reason) => {
    currentOrder('paid');
    mockSubmitPaidOrderCancel.mockResolvedValue({ kind: 'accepted', refundId: 'refund-1', status: 'pending', amount: 1000, replayed: false });
    expect((await post({ status: 'cancelled', requestKey: '10000000-0000-4000-8000-000000000001', restock: true, reason })).status).toBe(200);
    expect(mockSubmitPaidOrderCancel).toHaveBeenCalledWith(mockRefundDeps, expect.objectContaining({
      request: expect.objectContaining({ reason }),
    }));
  });
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
    // 二重防止の番号の無い送り直し（未入金の取消）は、返金の流れに回さない
    expect(mockSubmitPaidOrderCancel).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/orders/[id]/status - 支払い済みのキャンセル', () => {
  const REQUEST_KEY = 'b1b2c3d4-1111-4222-8333-444455556666';
  const REFUND_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
  const PAID_CANCEL = { ...CANCEL, requestKey: REQUEST_KEY, restock: true };
  const ACCEPTED = { kind: 'accepted', refundId: REFUND_ID, status: 'pending', amount: 13500, replayed: false };
  const ACCEPTED_BODY = { refundId: REFUND_ID, status: 'pending', amount: 13500, replayed: false };

  // 注文の管理の権限だけを持ち、返金の権限を持たない人（サポート）
  const supporter = async (permission: string) =>
    permission === 'admin.orders.refund'
      ? { ok: false, response: { status: 403, body: { error: 'Forbidden' } } }
      : { ok: true, userId: 'supporter-1' };

  beforeEach(() => {
    currentOrder('paid');
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockSubmitPaidOrderCancel.mockResolvedValue(ACCEPTED);
  });

  afterEach(() => {
    mockMaybeSingle.mockReset();
    mockSubmitPaidOrderCancel.mockReset();
    mockEnforceRateLimit.mockReset();
  });

  test('返金の権限も確かめ、返金とセットで取り消す。在庫・メモ・お知らせの指定をそのまま渡す', async () => {
    const res = await post({ ...PAID_CANCEL, note: '電話で依頼', notifyCustomer: false, restock: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(ACCEPTED_BODY);
    expect(mockAuthorize.mock.calls.map(([permission]) => permission)).toEqual(['admin.orders.manage', 'admin.orders.refund']);
    expect(mockSubmitPaidOrderCancel).toHaveBeenCalledWith(mockRefundDeps, {
      orderId: ORDER_ID,
      actorId: 'admin-1',
      request: { requestKey: REQUEST_KEY, reason: 'customer_request', note: '電話で依頼', restock: false, notifyCustomer: false },
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.orders.status.update',
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Refund accepted',
      metadata: { refund_id: REFUND_ID, status: 'pending', amount: 13500, replayed: false, source: 'order_cancel' },
    }));
    // 未入金の取消の道には入らない。メールの worker は返金の流れが動かす（窓口は動かさない）
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockScheduleOrderEmailDelivery).not.toHaveBeenCalled();
  });

  test('在庫に戻すを省くと戻す。メモが無ければ null、お知らせの既定は送る', async () => {
    await post({ status: 'cancelled', reason: 'customer_request', requestKey: REQUEST_KEY });

    expect(mockSubmitPaidOrderCancel).toHaveBeenCalledWith(mockRefundDeps, {
      orderId: ORDER_ID,
      actorId: 'admin-1',
      request: { requestKey: REQUEST_KEY, reason: 'customer_request', note: null, restock: true, notifyCustomer: true },
    });
  });

  // Review Focus 1: カードの返金は Stripe がその場で成功を返し、1回目の POST の中で注文が取消になる。返事が届かずに送り直しても、前の記録の答えを返す
  test('返金が成功して取消になった注文に同じ番号で送り直すと、返金の流れに回し、前の記録の答え（replayed）を返す', async () => {
    currentOrder('cancelled');
    mockSubmitPaidOrderCancel.mockResolvedValue({ ...ACCEPTED, status: 'succeeded', replayed: true });

    const res = await post(PAID_CANCEL);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...ACCEPTED_BODY, status: 'succeeded', replayed: true });
    expect(mockSubmitPaidOrderCancel).toHaveBeenCalledWith(mockRefundDeps, expect.objectContaining({ orderId: ORDER_ID }));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'Refund accepted' }));
  });

  test.each([
    { label: 'requestKey が UUID でない', body: { ...PAID_CANCEL, requestKey: 'abc' } },
    { label: '在庫に戻すが真偽でない', body: { ...PAID_CANCEL, restock: 'yes' } },
  ])('取消済みへの再送の誤り（$label）は、返金の権限と回数の制限を通して 400。返金を始めない', async ({ body }) => {
    currentOrder('cancelled');

    const res = await post(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockAuthorize.mock.calls.map(([permission]) => permission)).toEqual(['admin.orders.manage', 'admin.orders.refund']);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request: expect.any(Request), endpoint: 'admin:orders:paid-cancel', limit: 30, windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: expect.any(Request), endpoint: 'admin:orders:paid-cancel', limit: 30, windowSeconds: 600, subject: 'admin-1',
    });
    expect(mockMaybeSingle.mock.invocationCallOrder[0]).toBeLessThan(mockAuthorize.mock.invocationCallOrder[1]);
    expect(mockAuthorize.mock.invocationCallOrder[1]).toBeLessThan(mockEnforceRateLimit.mock.invocationCallOrder[0]);
    expect(mockEnforceRateLimit.mock.invocationCallOrder[1]).toBeLessThan(mockLogAudit.mock.invocationCallOrder[0]);
    expect(mockSubmitPaidOrderCancel).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure', detail: 'Invalid request body', metadata: null,
    }));
  });

  test('取消済みへの番号なしの再送は、返金の権限と回数の制限を通さず、従来の 200 を返す', async () => {
    currentOrder('cancelled');

    const res = await post(CANCEL);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: 'cancelled' });
    expect(mockAuthorize.mock.calls.map(([permission]) => permission)).toEqual(['admin.orders.manage']);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockSubmitPaidOrderCancel).not.toHaveBeenCalled();
  });

  test('返金の権限が無い人（サポート）は、中身が足りなくても 400 でなく 403（権限が先）。回数も数えず、返金も始めない', async () => {
    mockAuthorize.mockImplementation(supporter);

    const res = await post(CANCEL);

    expect(res.status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockSubmitPaidOrderCancel).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('未入金の取消は、返金の権限が無いサポートの人もできる（返金の権限は確かめない）', async () => {
    mockAuthorize.mockImplementation(supporter);
    currentOrder('payment_in_progress', { payment_intent_id: null });

    const res = await post(CANCEL);

    expect(res.status).toBe(200);
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockSubmitPaidOrderCancel).not.toHaveBeenCalled();
  });

  test('回数の制限は、支払い済みのキャンセルの名前と回数で、送信元ごと・管理者ごとに数える', async () => {
    await post(PAID_CANCEL);

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request: expect.any(Request), endpoint: 'admin:orders:paid-cancel', limit: 30, windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: expect.any(Request), endpoint: 'admin:orders:paid-cancel', limit: 30, windowSeconds: 600, subject: 'admin-1',
    });
  });

  test('送信元ごとの回数の制限を超えたら 429。管理者ごとの回数も数えず、返金を始めない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));

    const res = await post(PAID_CANCEL);

    expect(res.status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockSubmitPaidOrderCancel).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('管理者ごとの回数の制限を超えたら 429。返金を始めない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    const res = await post(PAID_CANCEL);

    expect(res.status).toBe(429);
    expect(mockSubmitPaidOrderCancel).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test.each([
    { label: 'requestKey が無い', body: { ...CANCEL, restock: true } },
    { label: 'requestKey が UUID でない', body: { ...CANCEL, requestKey: 'abc' } },
    { label: '在庫に戻すが真偽でない', body: { ...PAID_CANCEL, restock: 'yes' } },
  ])('中身の誤り（$label）は 400。返金を始めず、固定の文だけを監査に残す', async ({ body }) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockSubmitPaidOrderCancel).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.status.update', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: null, user_agent: null, metadata: null,
    }]]);
  });

  test('CSRF が合わなければ、注文も読まず返金も始めない', async () => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status: 403 }));

    const res = await post(PAID_CANCEL);

    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockSubmitPaidOrderCancel).not.toHaveBeenCalled();
  });

  test('理由が「その他」でメモが無ければ 400。注文を読む前に断り、返金は始めない', async () => {
    const res = await post({ ...PAID_CANCEL, reason: 'other', note: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('メモ');
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockSubmitPaidOrderCancel).not.toHaveBeenCalled();
  });

  // 返金の窓口と同じ答え・同じ監査（HTTP の対応は toRefundReply の1か所）
  test.each([
    {
      label: '発送した商品がある注文（DB の断り）',
      result: { kind: 'refused', code: 'order_not_cancellable' },
      status: 409,
      body: { error: '発送した商品がある注文はキャンセルできません。返金の画面を使ってください。', code: 'order_not_cancellable' },
      outcome: 'conflict',
      detail: 'Refund refused',
      metadata: { code: 'order_not_cancellable' },
    },
    {
      label: '確かめ中の返金がある注文',
      result: { kind: 'refused', code: 'awaiting_refund_exists' },
      status: 409,
      body: { error: '確かめ中の返金があります。先に確かめてください。', code: 'awaiting_refund_exists' },
      outcome: 'conflict',
      detail: 'Refund refused',
      metadata: { code: 'awaiting_refund_exists' },
    },
    {
      label: 'Stripe の断り',
      result: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: 'カード会社に断られました' },
      status: 422,
      body: { error: 'Stripe が返金を受け付けませんでした（カード会社に断られました）。', code: 'stripe_rejected', refundId: REFUND_ID },
      outcome: 'failure',
      detail: 'Stripe rejected the refund',
      metadata: { refund_id: REFUND_ID },
    },
    {
      label: '答えが分からない（Review Focus 1。記録の番号を返し、画面が確かめ直せる）',
      result: { kind: 'unknown', refundId: REFUND_ID },
      status: 502,
      body: {
        error: '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
        code: 'unknown_outcome',
        refundId: REFUND_ID,
      },
      outcome: 'error',
      detail: 'Refund outcome is unknown',
      metadata: { refund_id: REFUND_ID },
    },
  ])('$label は、返金の窓口と同じ答えを返し、監査に残す', async ({ result, status, body, outcome, detail, metadata }) => {
    mockSubmitPaidOrderCancel.mockResolvedValue(result);

    const res = await post(PAID_CANCEL);

    expect(res.status).toBe(status);
    expect(res.body).toEqual(body);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.orders.status.update', outcome, detail, metadata: { ...metadata, source: 'order_cancel' },
    }));
  });

  test('思いがけない失敗は 500。ログは例外名と DB の記号だけ（DB の文は出さない）', async () => {
    mockSubmitPaidOrderCancel.mockRejectedValue(
      new RefundStoreError('begin_order_refund', { message: '宛先・氏名を含む DB の文', code: '08006' }),
    );
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await post(PAID_CANCEL);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: '注文のキャンセルに失敗しました。', code: 'failed' });
      expect(error.mock.calls).toEqual([['[admin.orders.status] Failed to cancel paid order', 'RefundStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error', detail: 'Failed to cancel paid order', metadata: null,
      }));
    } finally {
      error.mockRestore();
    }
  });

  test('監査にメモ・メール・お客様の情報を入れない。入れた鍵が maskAuditEvent に伏せられることもない', async () => {
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', actorEmail: 'admin@example.com' });

    await post({ ...PAID_CANCEL, note: '電話で依頼' });

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'Refund accepted' }));
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    expect(audited).not.toContain('電話で依頼');
    expect(audited).not.toContain('@example.com');
    const { maskAuditEvent } = jest.requireActual('@/lib/audit');
    const event = mockLogAudit.mock.calls[0][0];
    expect(maskAuditEvent(event).metadata).toEqual(event.metadata);
  });
});
