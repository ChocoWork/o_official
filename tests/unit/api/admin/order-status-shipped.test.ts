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

const mockSelect = jest.fn();
const mockIs = jest.fn(() => ({ select: mockSelect }));
const mockEqStatus = jest.fn(() => ({ is: mockIs }));
const mockEqId = jest.fn(() => ({ eq: mockEqStatus }));
const mockUpdate = jest.fn(() => ({ eq: mockEqId }));

const mockMaybeSingle = jest.fn();
const mockSelectCurrentOrder = jest.fn(() => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }));

const mockFrom = jest.fn(() => ({ update: mockUpdate, select: mockSelectCurrentOrder }));

const mockRpc = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn().mockResolvedValue({ from: mockFrom }),
  createServiceRoleClient: jest.fn().mockResolvedValue({ rpc: mockRpc }),
}));

const mockPaymentIntentsRetrieve = jest.fn();
const mockPaymentIntentsCancel = jest.fn();
const mockCheckoutSessionsRetrieve = jest.fn();
const mockCheckoutSessionsList = jest.fn();
const mockCheckoutSessionsExpire = jest.fn();
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => ({
    paymentIntents: { retrieve: mockPaymentIntentsRetrieve, cancel: mockPaymentIntentsCancel },
    checkout: {
      sessions: {
        retrieve: mockCheckoutSessionsRetrieve,
        list: mockCheckoutSessionsList,
        expire: mockCheckoutSessionsExpire,
      },
    },
  }),
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

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

function makeRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };

describe('POST /api/admin/orders/[id]/status - shipped', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('paid の注文を発送済みにできる', async () => {
    mockRpc.mockResolvedValue({
      data: [{ id: ORDER_ID, shipping_email: 'hanako@example.com' }],
      error: null,
    });

    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' }),
      CONTEXT,
    );

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_ship_paid_order', {
      _actor_id: 'admin-1',
      _order_id: ORDER_ID,
      _shipping_carrier: 'yamato',
      _tracking_number: '1234-5678-9012',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSendOrderShippedEmail).toHaveBeenCalledTimes(1);
  });

  test('更新対象が無ければ 409 を返し、メールを送らない', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' }),
      CONTEXT,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('配送先');
    expect(mockSendOrderShippedEmail).not.toHaveBeenCalled();
  });

  test('failed の注文は専用 RPC でだけ cancelled にする', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'failed', payment_intent_id: 'pi_failed' },
      error: null,
    });
    mockRpc.mockResolvedValue({
      data: [{ id: ORDER_ID, status: 'cancelled' }],
      error: null,
    });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_cancel_failed_order', {
      _actor_id: 'admin-1',
      _order_id: ORDER_ID,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('failed の取消と別更新が競合したら 409 を返す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'failed', payment_intent_id: 'pi_failed' },
      error: null,
    });
    mockRpc.mockResolvedValue({ data: [], error: null });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(409);
    expect(res.body.success).not.toBe(true);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('未知の配送業者は 400 を返す', async () => {
    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'dhl', trackingNumber: '1234' }),
      CONTEXT,
    );

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('追跡番号に記号が混ざると 400 を返す', async () => {
    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'yamato', trackingNumber: '12 34/56' }),
      CONTEXT,
    );

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('発送済みの注文はキャンセルできず 409 を返す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'shipped' },
      error: null,
    });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('支払い済みの注文は返金なしでキャンセルできず 409 を返す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: ORDER_ID,
        status: 'paid',
        payment_intent_id: 'pi_paid',
        checkout_session_id: 'cs_paid',
      },
      error: null,
    });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('返金処理');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/orders/[id]/status - pending 注文のキャンセル（レビュー指摘 C2）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: ORDER_ID }], error: null });
  });

  test('open の Checkout Session は expire してから在庫を戻し、PaymentIntent は直接 cancel しない', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'pending', payment_intent_id: 'pi_1', checkout_session_id: 'cs_1' },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'requires_action' });
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      id: 'cs_1',
      status: 'open',
      payment_status: 'unpaid',
      payment_intent: 'pi_1',
    });
    mockCheckoutSessionsExpire.mockResolvedValue({
      id: 'cs_1',
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: 'pi_1',
    });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(200);
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsExpire).toHaveBeenCalledWith(
      'cs_1',
      {},
      { idempotencyKey: 'expire-checkout-session:cs_1' },
    );
    expect(mockRpc).toHaveBeenCalledWith('release_stock_for_unpaid_order', {
      _payment_intent_id: 'pi_1',
      _next_status: 'cancelled',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('succeeded の PaymentIntent はキャンセルを拒否する（返金は別操作）', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'pending', payment_intent_id: 'pi_2', checkout_session_id: 'cs_2' },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'succeeded' });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(409);
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsExpire).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('processing の PaymentIntent はキャンセルを拒否する（コンビニ/銀行振込は入金済みの可能性がある）', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'pending', payment_intent_id: 'pi_3', checkout_session_id: 'cs_3' },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'processing' });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(409);
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsExpire).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('PaymentIntent が resource_missing なら未入金と推定せず注文と在庫を変更しない', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: ORDER_ID,
        status: 'pending',
        payment_intent_id: 'pi_missing',
        checkout_session_id: 'cs_expired',
      },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockRejectedValue(
      Object.assign(new Error('No such payment_intent'), { code: 'resource_missing' }),
    );
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      id: 'cs_expired',
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: 'pi_missing',
    });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('決済状態を確認できない');
    expect(mockCheckoutSessionsRetrieve).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsExpire).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'conflict',
      detail: 'Cannot cancel: payment intent could not be verified',
      metadata: { stripe_error_code: 'resource_missing' },
    }));
  });

  test('PaymentIntent の取得障害では汎用500を返し注文と在庫を変更しない', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: ORDER_ID,
        status: 'pending',
        payment_intent_id: 'pi_unavailable',
        checkout_session_id: 'cs_unavailable',
      },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockRejectedValue(new Error('Stripe unavailable'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Stripe 決済のキャンセルに失敗しました。');
    expect(mockCheckoutSessionsRetrieve).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsExpire).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error',
      detail: 'Failed to terminate Stripe Checkout payment',
    }));

    consoleErrorSpy.mockRestore();
  });

  test('complete かつ unpaid の Checkout Session は将来入金され得るため注文も在庫も変更しない', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: ORDER_ID,
        status: 'pending',
        payment_intent_id: 'pi_complete',
        checkout_session_id: 'cs_complete',
      },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'requires_action' });
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      id: 'cs_complete',
      status: 'complete',
      payment_status: 'unpaid',
      payment_intent: 'pi_complete',
    });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(409);
    expect(mockCheckoutSessionsExpire).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('checkout_session_id が無い旧注文は PaymentIntent から Session を特定して expire する', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'pending', payment_intent_id: 'pi_legacy', checkout_session_id: null },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'requires_action' });
    mockCheckoutSessionsList.mockResolvedValue({
      data: [{
        id: 'cs_legacy',
        status: 'open',
        payment_status: 'unpaid',
        payment_intent: 'pi_legacy',
      }],
    });
    mockCheckoutSessionsExpire.mockResolvedValue({
      id: 'cs_legacy',
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: 'pi_legacy',
    });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(200);
    expect(mockCheckoutSessionsList).toHaveBeenCalledWith({ payment_intent: 'pi_legacy', limit: 1 });
    expect(mockCheckoutSessionsExpire).toHaveBeenCalled();
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalled();
  });

  test('Session expire と支払完了が競合したら再取得結果を優先し、在庫を戻さない', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'pending', payment_intent_id: 'pi_race', checkout_session_id: 'cs_race' },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'requires_action' });
    mockCheckoutSessionsRetrieve
      .mockResolvedValueOnce({
        id: 'cs_race',
        status: 'open',
        payment_status: 'unpaid',
        payment_intent: 'pi_race',
      })
      .mockResolvedValueOnce({
        id: 'cs_race',
        status: 'complete',
        payment_status: 'unpaid',
        payment_intent: 'pi_race',
      });
    mockCheckoutSessionsExpire.mockRejectedValue(new Error('session is no longer open'));

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(409);
    expect(mockCheckoutSessionsRetrieve).toHaveBeenCalledTimes(2);
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('既に expired の Checkout Session は Stripe を再操作せず在庫を戻す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: ORDER_ID,
        status: 'pending',
        payment_intent_id: 'pi_expired',
        checkout_session_id: 'cs_expired',
      },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'requires_action' });
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      id: 'cs_expired',
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: 'pi_expired',
    });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(200);
    expect(mockCheckoutSessionsExpire).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalled();
  });

  test('Session を特定できなければ安全側で拒否し、注文も在庫も変更しない', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'pending', payment_intent_id: 'pi_unknown', checkout_session_id: null },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'requires_action' });
    mockCheckoutSessionsList.mockResolvedValue({ data: [] });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(409);
    expect(mockCheckoutSessionsExpire).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('release RPC が released:false を返したら 409 を返し success にしない', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'pending', payment_intent_id: 'pi_5', checkout_session_id: 'cs_5' },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'requires_action' });
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      id: 'cs_5',
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: 'pi_5',
    });
    mockRpc.mockResolvedValue({ data: [{ released: false, order_id: ORDER_ID }], error: null });

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(409);
    expect(res.body.success).not.toBe(true);
  });

  test('release RPC がエラーを返したら 500 を返す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: ORDER_ID, status: 'pending', payment_intent_id: 'pi_4', checkout_session_id: 'cs_4' },
      error: null,
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'requires_action' });
    mockCheckoutSessionsRetrieve.mockResolvedValue({
      id: 'cs_4',
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: 'pi_4',
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db error' } });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res: any = await POST(makeRequest({ status: 'cancelled' }), CONTEXT);

    expect(res.status).toBe(500);

    consoleErrorSpy.mockRestore();
  });
});
