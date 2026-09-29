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

function listQuery(rows: () => unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ['is', 'not', 'order']) {
    query[method] = () => query;
  }
  query.limit = async () => ({ data: rows(), count: rows().length, error: null });
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

import { GET as getAttention } from '@/app/api/admin/order-attention/route';
import { POST as postReview } from '@/app/api/admin/orders/[id]/review/route';
import { POST as postResolve } from '@/app/api/admin/payment-exceptions/[id]/resolve/route';

type RouteResponse = { status: number; body: Record<string, any> };

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const EXCEPTION_ID = 'b1b2c3d4-1111-2222-8333-444455556666';

function jsonRequest(url: string, body: unknown = {}) {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function resolve(body: Record<string, unknown>): Promise<RouteResponse> {
  return (await postResolve(
    jsonRequest(`http://localhost/api/admin/payment-exceptions/${EXCEPTION_ID}/resolve`, body),
    { params: Promise.resolve({ id: EXCEPTION_ID }) },
  )) as unknown as RouteResponse;
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
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'supporter', actorEmail: null });
  mockRequireCsrf.mockResolvedValue(undefined);
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

  it('未入金でない注文は取り消せず 409', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'ORDER_NOT_CANCELLABLE' } });

    const res = await resolve({ cancelOrder: true, cancelReason: 'other', note: 'メモ' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('未入金');
  });

  it('メモは500文字まで', async () => {
    expect((await resolve({ note: 'あ'.repeat(501) })).status).toBe(400);
  });

  it('CSRF トークンが合わなければ何もしない', async () => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status: 403 }));

    expect((await resolve({ note: 'メモ' })).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
