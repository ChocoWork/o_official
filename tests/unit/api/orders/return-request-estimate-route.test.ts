/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockAuthenticate = jest.fn();
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  authFailureResponse: (reason: string, headers: Record<string, string> = {}) =>
    new Response(
      JSON.stringify({ error: reason === 'unavailable' ? 'Service temporarily unavailable' : 'Unauthorized' }),
      { status: reason === 'unavailable' ? 503 : 401, headers: { 'content-type': 'application/json', ...headers } },
    ),
}));
const mockDenyIfCsrfInvalid = jest.fn();
jest.mock('@/features/cart/services/shopping-context', () => ({
  denyIfCsrfInvalid: (...args: unknown[]) => mockDenyIfCsrfInvalid(...args),
}));
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));
const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
const mockServiceClient = { name: 'service-client' };
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: async () => mockServiceClient }));
// 持ち主の確かめ（DB の関数）と見込みの計算だけ差し替える。誤りの型は本物を残す
const mockLoadMaterials = jest.fn();
jest.mock('@/lib/orders/returns/customer-return-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/customer-return-store'),
  loadCustomerReturnRequestMaterials: (...args: unknown[]) => mockLoadMaterials(...args),
}));
const mockEstimate = jest.fn();
jest.mock('@/lib/orders/unit-pricing/unit-pricing-service', () => ({
  estimateCustomerReturn: (...args: unknown[]) => mockEstimate(...args),
}));

import { POST } from '@/app/api/orders/[id]/return-request/estimate/route';
import { CustomerOrderNotFoundError } from '@/lib/orders/returns/customer-return-store';
import type { CustomerReturnRequestMaterials } from '@/lib/orders/returns/customer-return-types';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import { UnitPricingError } from '@/lib/orders/unit-pricing/unit-pricing-types';
import {
  CUSTOMER_ID, FAILURE_MESSAGE, FULFILLMENT_ID, HEADERS, ORDER_ID, ORDER_ITEM_ID, ORDER_ITEM_ID_2,
} from '../../lib/orders/returns/customer-return-route-fixtures';

const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const BAD_ORDER_CONTEXT = { params: Promise.resolve({ id: 'order-1' }) };
const AUTH_OK = { ok: true, claims: { sub: CUSTOMER_ID, session_id: 'session-1', email: 'customer@example.com' } };

const MATERIALS = {
  order: { id: ORDER_ID, status: 'shipped' },
  reasons: [
    { reason: 'size_too_small', resolutions: 'refund_and_exchange' },
    { reason: 'defective', resolutions: 'exchange_only' },
  ],
  shipments: [
    {
      fulfillmentId: FULFILLMENT_ID,
      lines: [{ orderItemId: ORDER_ITEM_ID, quantity: 2, selectable: 2, state: 'selectable' }],
    },
  ],
} as unknown as CustomerReturnRequestMaterials;

const LINE = { orderItemId: ORDER_ITEM_ID, quantity: 1, reason: 'size_too_small', requestedResolution: 'refund' };

function request(body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/orders/${ORDER_ID}/return-request/estimate`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockAuthenticate.mockResolvedValue(AUTH_OK);
  mockLoadMaterials.mockResolvedValue(MATERIALS);
  mockEstimate.mockResolvedValue({ refundAmount: 17000, moneyMoves: true });
});

describe('POST /api/orders/[id]/return-request/estimate（FREQ-642）', () => {
  test('FREQ-642-AC-21: 注文の持ち主には見込みを data で返す（no-store）。値段の計算は本文の選びだけで行う', async () => {
    const response = await POST(request({ lines: [LINE] }), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ data: { refundAmount: 17000, moneyMoves: true } });
    expect(mockLoadMaterials).toHaveBeenCalledWith(mockServiceClient, { orderId: ORDER_ID, customerId: CUSTOMER_ID });
    expect(mockEstimate).toHaveBeenCalledWith(mockServiceClient, ORDER_ID, [LINE]);
  });

  test('FREQ-642-AC-21: 交換だけの見込みは、お金が動かないと返す', async () => {
    mockEstimate.mockResolvedValue({ refundAmount: 0, moneyMoves: false });

    const response = await POST(request({ lines: [{ ...LINE, requestedResolution: 'exchange' }] }), ORDER_CONTEXT);

    await expect(response.json()).resolves.toEqual({ data: { refundAmount: 0, moneyMoves: false } });
  });

  test('FREQ-642-AC-21: ログインしていない時は 401。見込みも持ち主の確かめも行わない', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'unauthenticated' });

    const response = await POST(request({ lines: [LINE] }), ORDER_CONTEXT);

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mockLoadMaterials).not.toHaveBeenCalled();
    expect(mockEstimate).not.toHaveBeenCalled();
  });

  test('FREQ-642-AC-21: 持ち主でない・無い・お客様に隠す状態の注文は 404（有無を漏らさない）。見込みは出さない', async () => {
    mockLoadMaterials.mockResolvedValue(null);

    const response = await POST(request({ lines: [LINE] }), ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
    expect(mockEstimate).not.toHaveBeenCalled();
    expect((await POST(request({ lines: [LINE] }), BAD_ORDER_CONTEXT)).status).toBe(404);
  });

  test('FREQ-642-AC-21: 読むだけなので CSRF も回数の制限も通さず、監査も書かない', async () => {
    await POST(request({ lines: [LINE] }), ORDER_CONTEXT);

    expect(mockDenyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test.each([
    ['本文が JSON でない', undefined, '{'],
    ['行が無い', { lines: [] }, undefined],
    ['行が101行', { lines: Array.from({ length: 101 }, () => LINE) }, undefined],
    ['数が0', { lines: [{ ...LINE, quantity: 0 }] }, undefined],
    ['理由が不明（お客様には出さない）', { lines: [{ ...LINE, reason: 'unknown' }] }, undefined],
    ['ご希望が知らない値', { lines: [{ ...LINE, requestedResolution: 'credit' }] }, undefined],
    ['注文の行の番号が UUID でない', { lines: [{ ...LINE, orderItemId: 'x' }] }, undefined],
    ['この注文の返品できる品にない行', { lines: [{ ...LINE, orderItemId: ORDER_ITEM_ID_2 }] }, undefined],
  ])('FREQ-642-AC-21: %s は 400 で見込みを出さない', async (_name, body, raw) => {
    const response = await POST(request(body, raw), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'RETURN_ARGUMENT_INVALID' });
    expect(mockEstimate).not.toHaveBeenCalled();
  });

  test('FREQ-642-AC-30: 交換だけの理由（不良）で返金を選んだ行は、申し込みの DB の規則と同じ RETURN_NOT_ELIGIBLE の409。見込みは出さない', async () => {
    const response = await POST(request({ lines: [{ ...LINE, reason: 'defective' }] }), ORDER_CONTEXT);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'RETURN_NOT_ELIGIBLE' });
    expect(mockEstimate).not.toHaveBeenCalled();

    await POST(request({ lines: [{ ...LINE, reason: 'defective', requestedResolution: 'exchange' }] }), ORDER_CONTEXT);
    expect(mockEstimate).toHaveBeenCalledTimes(1);
  });

  test('FREQ-642-AC-21: 枠が足りないなど見込みを出せない時は、額を出さずに 409（申し込みは止めない）', async () => {
    mockEstimate.mockRejectedValue(new UnitPricingError('unit_not_available'));

    const response = await POST(request({ lines: [LINE] }), ORDER_CONTEXT);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: '返金の見込みを出せませんでした。', code: 'ESTIMATE_UNAVAILABLE' });
  });

  test('FREQ-642-AC-21: 注文が無い誤りは 404、想定外の失敗は 500 の固定の言葉（DB の文を出さない）', async () => {
    mockEstimate.mockRejectedValueOnce(new CustomerOrderNotFoundError());
    expect((await POST(request({ lines: [LINE] }), ORDER_CONTEXT)).status).toBe(404);

    mockEstimate.mockRejectedValueOnce(new RefundStoreError('order_unit_pricing_materials', { message: '宛先 東京都…', code: '08006' }));
    const response = await POST(request({ lines: [LINE] }), ORDER_CONTEXT);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain(FAILURE_MESSAGE);
    expect(text).not.toContain('宛先');
  });
});
