jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockSelect = jest.fn();
const mockOr = jest.fn();
const mockRange = jest.fn();
const mockServiceClient = { from: () => ({ select: mockSelect }) };
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockServiceClient),
}));

const mockStripe = { name: 'stripe' };
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => mockStripe,
}));

const mockExpireOpenCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/checkout-session-expiry', () => ({
  expireOpenCheckoutSession: (...args: unknown[]) => mockExpireOpenCheckoutSession(...args),
}));

const mockReconcile = jest.fn();
const mockNotifyShop = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: (...args: unknown[]) => mockReconcile(...args),
  notifyShopOfException: (...args: unknown[]) => mockNotifyShop(...args),
}));

const mockDeps = { name: 'reconciler-deps' };
const mockListUnsentShopAlerts = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reconciler-deps', () => ({
  createDefaultReconcilerDeps: async () => mockDeps,
  listUnsentShopAlerts: (...args: unknown[]) => mockListUnsentShopAlerts(...args),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

// 設定ミス（CRON_SECRET 未設定）の監査ログを間引くための回数制限。既定は「まだ上限に達していない」。
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

import { POST } from '@/app/api/cron/expire-pending-orders/route';

type SweepRow = {
  id: string;
  status: 'payment_in_progress' | 'pending';
  payment_intent_id: string | null;
  checkout_session_id: string | null;
};

type SweepResponse = { status: number; body: Record<string, unknown> };

const NOW = Date.parse('2026-09-27T03:00:00.000Z');

function request(authorization?: string): Request {
  return new Request('http://localhost/api/cron/expire-pending-orders', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

async function sweep(authorization = 'Bearer cron-secret'): Promise<SweepResponse> {
  return (await POST(request(authorization))) as unknown as SweepResponse;
}

/** 件数の取得（head）と一覧の取得（order → order → range）を、同じ or 条件で受ける */
function candidates(rows: SweepRow[], totalCount = rows.length) {
  mockRange.mockResolvedValue({ data: rows, error: null });
  const listQuery: { order: () => unknown; range: jest.Mock } = { order: () => listQuery, range: mockRange };
  mockSelect.mockImplementation((_columns: string, options?: { head?: boolean }) => ({
    or: (filter: string) => {
      mockOr(filter);
      return options?.head ? Promise.resolve({ count: totalCount, error: null }) : listQuery;
    },
  }));
}

function ok(action: string) {
  return { kind: 'ok', action: { type: action }, orderId: 'order-1', orderStatus: 'paid' };
}

describe('POST /api/cron/expire-pending-orders（照合の見回り）', () => {
  let dateSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockExpireOpenCheckoutSession.mockResolvedValue('not_open');
    mockReconcile.mockResolvedValue(ok('none'));
    mockListUnsentShopAlerts.mockResolvedValue([]);
    mockNotifyShop.mockResolvedValue(true);
    candidates([]);
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  it('CRON_SECRET が一致しなければ 401', async () => {
    expect((await sweep('Bearer wrong')).status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('長さが同じでも値が違う secret は 401（timingSafeEqual の分岐を通す）', async () => {
    expect((await sweep('Bearer cron-secreX')).status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が未設定なら 401 で、理由付きの監査ログを残す（レビュー指摘 I5）', async () => {
    delete process.env.CRON_SECRET;

    const response = await sweep();

    expect(response.status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.pending_orders.expire',
      outcome: 'failure',
      detail: expect.stringContaining('CRON_SECRET'),
    }));
  });

  it('CRON_SECRET 未設定の監査ログは、IP に依らない共通の枠で10分に1回までに絞る（FREQ-370）', async () => {
    delete process.env.CRON_SECRET;

    await sweep();

    expect(mockEnforceRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'cron:expire-pending-orders:misconfigured',
      limit: 1,
      windowSeconds: 600,
      subject: expect.any(String),
    }));
  });

  it('枠を使い切ったら、CRON_SECRET 未設定でも監査ログを残さず 401 だけ返す（FREQ-370）', async () => {
    delete process.env.CRON_SECRET;
    mockEnforceRateLimit.mockResolvedValue(new Response(null, { status: 429 }));

    expect((await sweep()).status).toBe(401);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('Authorization ヘッダが無い・一致しない要求は監査ログを残さず、ヘッダの値をログに出さない（FREQ-370）', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect((await POST(request()) as unknown as SweepResponse).status).toBe(401);
    expect((await sweep('Bearer attacker-supplied-value')).status).toBe(401);

    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[cron] expire-pending-orders unauthorized'),
      expect.stringContaining('Missing Authorization header'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('attacker-supplied-value');
    warn.mockRestore();
  });

  it('開いてから30分を超えた支払い手続き中の注文と、入金待ちの全件を対象にする', async () => {
    await sweep();

    expect(mockOr).toHaveBeenCalledWith(
      'and(status.eq.payment_in_progress,checkout_session_created_at.lt.2026-09-27T02:30:00.000Z),status.eq.pending',
    );
  });

  it('支払い手続き中の注文は、まだ開いている Session を失効させてから照合する', async () => {
    candidates([{ id: 'order-1', status: 'payment_in_progress', payment_intent_id: null, checkout_session_id: 'cs_1' }]);
    mockExpireOpenCheckoutSession.mockResolvedValue('expired');
    mockReconcile.mockResolvedValue({
      kind: 'ok',
      action: { type: 'release', expectedStatus: 'payment_in_progress', nextStatus: 'abandoned' },
      orderId: 'order-1',
      orderStatus: 'abandoned',
    });

    const response = await sweep();

    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(mockStripe, 'cs_1');
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, { checkoutSessionId: 'cs_1', paymentIntentId: null });
    expect(mockExpireOpenCheckoutSession.mock.invocationCallOrder[0]).toBeLessThan(mockReconcile.mock.invocationCallOrder[0]);
    expect(response.body).toMatchObject({ processed: 1, expiredSessions: 1, actions: { release: 1 } });
  });

  it('入金待ちの注文は失効させずに照合する。Session ID の無い古い注文は PaymentIntent で照合する', async () => {
    candidates([
      { id: 'order-1', status: 'pending', payment_intent_id: 'pi_1', checkout_session_id: 'cs_1' },
      { id: 'order-legacy', status: 'pending', payment_intent_id: 'pi_legacy', checkout_session_id: null },
    ]);

    await sweep();

    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, { checkoutSessionId: 'cs_1', paymentIntentId: 'pi_1' });
    expect(mockReconcile).toHaveBeenCalledWith(mockDeps, { checkoutSessionId: null, paymentIntentId: 'pi_legacy' });
  });

  it('照合の結果を種類ごとに数え、1件の失敗で残りを止めない', async () => {
    candidates([
      { id: 'order-1', status: 'pending', payment_intent_id: 'pi_1', checkout_session_id: 'cs_1' },
      { id: 'order-2', status: 'pending', payment_intent_id: 'pi_2', checkout_session_id: 'cs_2' },
      { id: 'order-3', status: 'pending', payment_intent_id: 'pi_3', checkout_session_id: 'cs_3' },
      { id: 'order-4', status: 'pending', payment_intent_id: 'pi_4', checkout_session_id: 'cs_4' },
    ]);
    mockReconcile
      .mockResolvedValueOnce(ok('mark_paid'))
      .mockResolvedValueOnce({ kind: 'needs_review', action: { type: 'mark_paid' }, orderId: 'order-2', orderStatus: 'paid' })
      .mockResolvedValueOnce({ kind: 'needs_action', exceptionId: 'exception-1', reason: 'stripe_object_missing', orderId: 'order-3', orderStatus: 'pending' })
      .mockRejectedValueOnce(Object.assign(new Error('stripe down'), { code: 'stripe_unavailable' }));

    const response = await sweep();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      processed: 4,
      actions: { mark_paid: 2 },
      needsReview: 1,
      needsAction: 1,
      failed: 1,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error',
      metadata: expect.objectContaining({ failed_order_ids: ['order-4'] }),
    }));
  });

  it('店へ未送信の要対応を送り直す', async () => {
    const alert = { reason: 'paid_amount_mismatch', detail: null, orderId: 'order-1', paymentRef: 'cs_1', detectedAt: new Date(NOW) };
    mockListUnsentShopAlerts.mockResolvedValue([
      { exceptionId: 'exception-1', alert },
      { exceptionId: 'exception-2', alert },
    ]);
    mockNotifyShop.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const response = await sweep();

    expect(mockListUnsentShopAlerts).toHaveBeenCalledWith(mockServiceClient, 20);
    expect(mockNotifyShop).toHaveBeenCalledWith(mockDeps, 'exception-1', alert);
    expect(response.body).toMatchObject({ shopAlertsSent: 1 });
  });

  it('対象がなければ 200 と 0 件を返し、監査ログを1回だけ残す', async () => {
    const response = await sweep();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ processed: 0, candidateCount: 0, failed: 0 });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.pending_orders.expire',
      resource: 'orders',
      outcome: 'success',
      detail: 'Checkout payment reconciliation sweep',
    }));
  });

  it('1回の実行の上限は50件（レビュー指摘 I3）', async () => {
    candidates([], 50);

    await sweep();

    expect(mockRange).toHaveBeenCalledWith(0, 49);
  });

  it('50件を超える場合は時間ごとに取得範囲を巡回し、残り続ける注文による後続の飢餓を防ぐ', async () => {
    candidates([{ id: 'order-51', status: 'pending', payment_intent_id: 'pi_51', checkout_session_id: 'cs_51' }], 120);
    dateSpy.mockReturnValue(60 * 60 * 1000);

    const response = await sweep();

    expect(mockRange).toHaveBeenCalledWith(50, 99);
    expect(response.body).toMatchObject({ candidateCount: 120, batchOffset: 50, capped: true });
  });

  it('件数の取得と一覧の間に状態が変わり、巡回範囲が空なら先頭範囲へ1回だけ戻す', async () => {
    candidates([], 120);
    dateSpy.mockReturnValue(60 * 60 * 1000);

    const response = await sweep();

    expect(mockRange).toHaveBeenNthCalledWith(1, 50, 99);
    expect(mockRange).toHaveBeenNthCalledWith(2, 0, 49);
    expect(response.body).toMatchObject({ batchOffset: 0, processed: 0 });
  });

  it('45秒の時間予算を超えたら残りを打ち切り、店への送り直しもしない（レビュー指摘 I3）', async () => {
    candidates([
      { id: 'order-1', status: 'pending', payment_intent_id: 'pi_1', checkout_session_id: 'cs_1' },
      { id: 'order-2', status: 'pending', payment_intent_id: 'pi_2', checkout_session_id: 'cs_2' },
    ]);
    dateSpy
      .mockReturnValueOnce(1_000_000) // 対象の時刻と巡回位置
      .mockReturnValueOnce(1_000_000) // startedAt
      .mockReturnValueOnce(1_000_100) // order-1 の予算チェック（予算内）
      .mockReturnValueOnce(1_050_000); // order-2 の予算チェック（予算超過）

    const response = await sweep();

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockListUnsentShopAlerts).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ processed: 1, timeBudgetExhausted: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });
});
