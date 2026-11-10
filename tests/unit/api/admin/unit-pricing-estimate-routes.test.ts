/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));
const mockRequireCsrf = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: (...args: unknown[]) => mockRequireCsrf(...args) }));
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
const mockServiceClient = { name: 'service-client' };
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: async () => mockServiceClient }));
const mockEstimateReceive = jest.fn();
const mockPlanRefund = jest.fn();
jest.mock('@/lib/orders/unit-pricing/unit-pricing-service', () => ({
  estimateReturnReceive: (...args: unknown[]) => mockEstimateReceive(...args),
  planOrderRefund: (...args: unknown[]) => mockPlanRefund(...args),
}));

import { POST as postRefundEstimate } from '@/app/api/admin/orders/[id]/refund-estimate/route';
import { POST as postReceiveEstimate } from '@/app/api/admin/returns/[returnId]/receive-estimate/route';
import { RefundOperationError, RefundStoreError } from '@/lib/orders/refund/refund-store';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import { HEADERS, LINE_ID, ORDER_ID, RETURN_ID } from '../../lib/orders/returns/return-route-fixtures';

const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const UNAVAILABLE = new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), { status: 503 });
const ADMIN = { ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' };
const RETURN_CONTEXT = { params: Promise.resolve({ returnId: RETURN_ID }) };
const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };

/** 持っている権限だけを通す認可の差し替え。それ以外は 403 */
function grant(...permissions: string[]) {
  mockAuthorize.mockImplementation(async (permission: string) =>
    permissions.includes(permission) ? ADMIN : { ok: false, response: DENIED },
  );
}

function post(path: string, body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/admin/${path}`, { method: 'POST', headers: HEADERS, body: rawBody ?? JSON.stringify(body) });
}

const RECEIVE_ESTIMATE = {
  legacy: false, standardRefund: 17000, nowRefund: 17000, consultRefund: 0, feeAmount: 0, fixedFees: 0, refundAmount: 17000, refundCap: 17000,
};
const RECEIVE_BODY = {
  units: [{ returnLineId: LINE_ID, disposition: 'restocked', quantity: 1, refundChoice: 'now' }],
  exchangeOverrides: [],
  refundChoice: 'now',
  refundShippingAmount: 0,
  treatments: [{ returnLineId: LINE_ID, treatment: 'shop' }],
};
const REFUND_ESTIMATE = { legacy: false, suggestedAmount: 17000, refundCap: 37000, changesUnits: true };
const REFUND_BODY = { lines: [{ orderItemId: LINE_ID, quantity: 1, beforeShipment: true }], shippingAmount: 0 };

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockLogAudit.mockResolvedValue(undefined);
  grant('admin.orders.return', 'admin.orders.refund');
  mockEstimateReceive.mockResolvedValue(RECEIVE_ESTIMATE);
  mockPlanRefund.mockResolvedValue({ plan: null, estimate: REFUND_ESTIMATE });
});

describe('POST /api/admin/returns/[returnId]/receive-estimate（FREQ-642）', () => {
  const call = (body: unknown = RECEIVE_BODY, rawBody?: string, context = RETURN_CONTEXT) =>
    postReceiveEstimate(post(`returns/${RETURN_ID}/receive-estimate`, body, rawBody), context);

  test('DD-ADMIN-022: 受け取りの選びから見込みを data で返す（no-store）。返金の権限を渡して計画を作る', async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ data: RECEIVE_ESTIMATE });
    expect(mockEstimateReceive).toHaveBeenCalledWith(mockServiceClient, RETURN_ID, RECEIVE_BODY, { canRefund: true });
  });

  test('DD-ADMIN-022: 返金の権限を持たない人（サポート）も読める。割引の扱いを直せるかは権限で決める', async () => {
    grant('admin.orders.return');

    const response = await call();

    expect(response.status).toBe(200);
    expect(mockEstimateReceive).toHaveBeenCalledWith(mockServiceClient, RETURN_ID, RECEIVE_BODY, { canRefund: false });
  });

  test('DD-ADMIN-022: 返品の権限が無ければ 403、確かめられなければその応答。見込みは出さない', async () => {
    grant();
    expect((await call()).status).toBe(403);

    mockAuthorize.mockResolvedValue({ ok: false, response: UNAVAILABLE });
    expect((await call()).status).toBe(503);

    expect(mockEstimateReceive).not.toHaveBeenCalled();
  });

  test('DD-ADMIN-022: 返金の権限を確かめられない（503）時は、持たない扱いにせずその応答を返す', async () => {
    mockAuthorize.mockImplementation(async (permission: string) =>
      permission === 'admin.orders.return' ? ADMIN : { ok: false, response: UNAVAILABLE },
    );

    expect((await call()).status).toBe(503);
    expect(mockEstimateReceive).not.toHaveBeenCalled();
  });

  test('DD-ADMIN-022: 読むだけなので CSRF も回数の制限も通さず、監査も書かない。額の欄は本文から受け付けない', async () => {
    await call({ ...RECEIVE_BODY, refundAmount: 1 });

    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockEstimateReceive.mock.calls[0][2]).not.toHaveProperty('refundAmount');
  });

  test.each([
    ['本文が JSON でない', undefined, '{'],
    ['品の行が配列でない', { ...RECEIVE_BODY, units: 'x' }, undefined],
    ['品の行が101行', { ...RECEIVE_BODY, units: Array.from({ length: 101 }, () => RECEIVE_BODY.units[0]) }, undefined],
    ['状態が知らない値', { ...RECEIVE_BODY, units: [{ ...RECEIVE_BODY.units[0], disposition: 'lost' }] }, undefined],
    ['数が0', { ...RECEIVE_BODY, units: [{ ...RECEIVE_BODY.units[0], quantity: 0 }] }, undefined],
    ['返金の選びが知らない値', { ...RECEIVE_BODY, refundChoice: 'later' }, undefined],
    ['割引の扱いが知らない値', { ...RECEIVE_BODY, treatments: [{ returnLineId: LINE_ID, treatment: 'free' }] }, undefined],
    ['送料が負', { ...RECEIVE_BODY, refundShippingAmount: -1 }, undefined],
  ])('DD-ADMIN-022: %s は400で見込みを出さない', async (_name, body, raw) => {
    const response = await call(body, raw);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockEstimateReceive).not.toHaveBeenCalled();
  });

  test('DD-ADMIN-022: 返品の番号が UUID でなければ400', async () => {
    const response = await call(RECEIVE_BODY, undefined, { params: Promise.resolve({ returnId: 'x' }) });
    expect(response.status).toBe(400);
  });

  test('DD-ADMIN-022: 決まった断りは HTTP と言葉に直す（返品が無い404・割引の扱いの権限403・版が古い409）', async () => {
    mockEstimateReceive.mockRejectedValueOnce(new ReturnStoreError('RETURN_NOT_FOUND'));
    expect((await call()).status).toBe(404);

    mockEstimateReceive.mockRejectedValueOnce(new ReturnStoreError('RETURN_FORBIDDEN'));
    expect((await call()).status).toBe(403);

    mockEstimateReceive.mockRejectedValueOnce(new ReturnStoreError('UNIT_PRICING_INVALID'));
    const invalid = await call();
    expect(invalid.status).toBe(409);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'UNIT_PRICING_INVALID' });
  });

  test('DD-ADMIN-022: 想定外の失敗は500の固定の言葉（DB の文を出さない）', async () => {
    mockEstimateReceive.mockRejectedValueOnce(new RefundStoreError('order_unit_pricing_materials', { message: '宛先 東京都…', code: '08006' }));

    const response = await call();

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('返品の材料を読み込めませんでした。');
    expect(text).not.toContain('宛先');
  });
});

describe('POST /api/admin/orders/[id]/refund-estimate（FREQ-642）', () => {
  const call = (body: unknown = REFUND_BODY, rawBody?: string, context = ORDER_CONTEXT) =>
    postRefundEstimate(post(`orders/${ORDER_ID}/refund-estimate`, body, rawBody), context);

  test('DD-ADMIN-023: 選んだ品と送料から標準の額と上限を data で返す（no-store）。計画そのものは返さない', async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ data: REFUND_ESTIMATE });
    expect(mockPlanRefund).toHaveBeenCalledWith(mockServiceClient, ORDER_ID, REFUND_BODY);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.refund', expect.any(Request));
  });

  test('DD-ADMIN-023: 返金の権限が無ければ 403。見込みは出さない', async () => {
    grant('admin.orders.return');

    expect((await call()).status).toBe(403);
    expect(mockPlanRefund).not.toHaveBeenCalled();
  });

  test('DD-ADMIN-023: 品を選ばない返金（送料・お詫びだけ）の見込みも出せる。送料は省くと0', async () => {
    await call({ lines: [] });

    expect(mockPlanRefund).toHaveBeenCalledWith(mockServiceClient, ORDER_ID, { lines: [], shippingAmount: 0 });
  });

  test('DD-ADMIN-023: 読むだけなので CSRF も回数の制限も通さず、監査も書かない。額の欄は本文から受け付けない', async () => {
    await call({ ...REFUND_BODY, amount: 1 });

    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockPlanRefund.mock.calls[0][2]).not.toHaveProperty('amount');
  });

  test.each([
    ['本文が JSON でない', undefined, '{'],
    ['商品の行の番号が UUID でない', { ...REFUND_BODY, lines: [{ ...REFUND_BODY.lines[0], orderItemId: 'x' }] }, undefined],
    ['数が0', { ...REFUND_BODY, lines: [{ ...REFUND_BODY.lines[0], quantity: 0 }] }, undefined],
    ['発送前の印が無い', { ...REFUND_BODY, lines: [{ orderItemId: LINE_ID, quantity: 1 }] }, undefined],
    ['同じ商品の発送前が2行', { ...REFUND_BODY, lines: [REFUND_BODY.lines[0], REFUND_BODY.lines[0]] }, undefined],
    ['送料が負', { ...REFUND_BODY, shippingAmount: -1 }, undefined],
    ['送料が integer の上限を超える', { ...REFUND_BODY, shippingAmount: 2147483648 }, undefined],
  ])('DD-ADMIN-023: %s は400で見込みを出さない', async (_name, body, raw) => {
    const response = await call(body, raw);

    expect(response.status).toBe(400);
    expect(mockPlanRefund).not.toHaveBeenCalled();
  });

  test('DD-ADMIN-023: 注文の番号が UUID でなければ400', async () => {
    expect((await call(REFUND_BODY, undefined, { params: Promise.resolve({ id: 'x' }) })).status).toBe(400);
  });

  test('DD-ADMIN-023: 注文が無ければ404、計画の計算が断れば409、想定外の失敗は500の固定の言葉', async () => {
    mockPlanRefund.mockRejectedValueOnce(new RefundOperationError('order_not_found'));
    expect((await call()).status).toBe(404);

    mockPlanRefund.mockRejectedValueOnce(new RefundOperationError('unit_pricing_invalid'));
    expect((await call()).status).toBe(409);

    mockPlanRefund.mockRejectedValueOnce(new RefundStoreError('order_unit_pricing_materials', { message: '宛先 東京都…', code: '08006' }));
    const response = await call();
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('返金の材料を読み込めませんでした。');
    expect(text).not.toContain('宛先');
  });
});
