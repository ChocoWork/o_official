/** @jest-environment node */
import { NextRequest, NextResponse } from 'next/server';

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockGuard = jest.fn();
jest.mock('@/features/checkout/services/checkout-route-guard', () => ({
  PROMOTION_CODE_GUARD: { ipLimits: [], sessionLimit: { endpoint: 'x', limit: 1, windowSeconds: 1 } },
  guardCheckoutPost: (...args: unknown[]) => mockGuard(...args),
}));

const mockLoadCheckoutCart = jest.fn();
jest.mock('@/features/checkout/services/checkout-cart.service', () => ({
  loadCheckoutCart: (...args: unknown[]) => mockLoadCheckoutCart(...args),
}));

// カートは session_id ではなく、確かめた買い手（持ち主）から引く（カートの引き継ぎ設計書 第7章）
const mockResolveCheckoutBuyer = jest.fn();
jest.mock('@/features/checkout/services/checkout-buyer', () => ({
  ...jest.requireActual('@/features/checkout/services/checkout-buyer'),
  resolveCheckoutBuyer: (...args: unknown[]) => mockResolveCheckoutBuyer(...args),
}));

const mockFindCartIdForBuyer = jest.fn();
jest.mock('@/features/cart/services/shopping-context', () => ({
  findCartIdForBuyer: (...args: unknown[]) => mockFindCartIdForBuyer(...args),
}));

const mockCheckPromotionCode = jest.fn();
jest.mock('@/features/checkout/services/promotion-code.service', () => ({
  ...jest.requireActual('@/features/checkout/services/promotion-code.service'),
  checkPromotionCode: (...args: unknown[]) => mockCheckPromotionCode(...args),
}));

const mockStripe = { promotionCodes: { list: jest.fn() } };
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: () => mockStripe }));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn().mockReturnValue({}) }));

import { POST } from '@/app/api/checkout/promotion-code/route';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/checkout/promotion-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const OK_CART = {
  kind: 'ok',
  cartRows: [{ id: 'line-1', item_id: 1, quantity: 1, color: 'BLACK', size: 'M', variant_id: 101, variant_active: true }],
  itemMap: new Map(),
  amounts: { subtotalAmount: 5000, taxAmount: 0, shippingAmount: 0, totalAmount: 5000 },
};

describe('POST /api/checkout/promotion-code', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGuard.mockResolvedValue({
      ok: true,
      sessionId: 'sess-abc',
      clientIp: '203.0.113.5',
      userAgent: 'jest',
      finish: (response: NextResponse) => response,
    });
    mockLoadCheckoutCart.mockResolvedValue(OK_CART);
    mockResolveCheckoutBuyer.mockReset().mockResolvedValue({ kind: 'guest' });
    mockFindCartIdForBuyer.mockReset().mockResolvedValue('cart-1');
  });

  test('守りで断られたら、その応答を返す', async () => {
    const denied = new Response(null, { status: 429 });
    mockGuard.mockResolvedValue({ ok: false, response: denied });

    const res = await POST(makeRequest({ code: 'WELCOME10' }));

    expect(res).toBe(denied);
    expect(mockLoadCheckoutCart).not.toHaveBeenCalled();
  });

  test('コードに使えない文字があれば 400', async () => {
    const res = await POST(makeRequest({ code: 'SALE 10' }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_request' });
    expect(mockCheckPromotionCode).not.toHaveBeenCalled();
  });

  test('カートが空なら 400', async () => {
    mockLoadCheckoutCart.mockResolvedValue({ kind: 'empty' });

    const res = await POST(makeRequest({ code: 'WELCOME10' }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'cart_empty' });
  });

  test('持ち主のカートが無ければ（印の無いゲストなど）、カートの ID を null で渡して 400', async () => {
    mockFindCartIdForBuyer.mockResolvedValue(null);
    mockLoadCheckoutCart.mockResolvedValue({ kind: 'empty' });

    const res = await POST(makeRequest({ code: 'WELCOME10' }));

    expect(mockLoadCheckoutCart).toHaveBeenCalledWith(expect.anything(), null);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'cart_empty' });
    expect(mockCheckPromotionCode).not.toHaveBeenCalled();
  });

  test.each([
    { kind: 'expired', status: 401, body: { error: 'auth_expired' } },
    { kind: 'unavailable', status: 503, body: { error: 'Service temporarily unavailable' } },
  ])('買い手が $kind なら $status を返し、カートも割引コードの確かめにも進まない', async ({ kind, status, body }) => {
    mockResolveCheckoutBuyer.mockResolvedValue({ kind });
    const finish = jest.fn((response: NextResponse) => response);
    mockGuard.mockResolvedValue({ ok: true, sessionId: 'sess-abc', clientIp: '203.0.113.5', userAgent: 'jest', finish });

    const res = await POST(makeRequest({ code: 'WELCOME10' }));

    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual(body);
    if (kind === 'unavailable') expect(res.headers.get('Retry-After')).toBe('30');
    expect(finish).toHaveBeenCalledTimes(1);
    expect(mockFindCartIdForBuyer).not.toHaveBeenCalled();
    expect(mockLoadCheckoutCart).not.toHaveBeenCalled();
    expect(mockCheckPromotionCode).not.toHaveBeenCalled();
  });

  test('持ち主のカートを引けなければ 500 で、時間をおいて試すよう案内する', async () => {
    mockFindCartIdForBuyer.mockRejectedValue(new Error('db down'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await POST(makeRequest({ code: 'WELCOME10' }));

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({ error: 'promotion_code_failed' });
      expect(mockLoadCheckoutCart).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'checkout.promotion_code.check',
          outcome: 'error',
          metadata: { session_id: 'sess-abc', error_message: 'db down' },
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test('買えない商品があれば 409 で、その案内を返す', async () => {
    mockLoadCheckoutCart.mockResolvedValue({
      kind: 'unavailable',
      body: { error: 'out_of_stock', message: '以下の商品は現在購入できません: A', items: [] },
    });

    const res = await POST(makeRequest({ code: 'WELCOME10' }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'out_of_stock' });
  });

  test('サーバーの割引前の合計で確かめ、使えれば割引後の金額を返す', async () => {
    mockCheckPromotionCode.mockResolvedValue({
      ok: true,
      promotionCodeId: 'promo_1',
      code: 'WELCOME10',
      discountAmount: 500,
      totalAfterDiscount: 4500,
    });

    const req = makeRequest({ code: ' welcome10 ' });
    const res = await POST(req);

    // カートは session_id ではなく、確かめた買い手のカートで読む
    expect(mockResolveCheckoutBuyer).toHaveBeenCalledWith(req);
    expect(mockFindCartIdForBuyer).toHaveBeenCalledWith(expect.anything(), req, { kind: 'guest' });
    expect(mockLoadCheckoutCart).toHaveBeenCalledWith(expect.anything(), 'cart-1');
    expect(mockCheckPromotionCode).toHaveBeenCalledWith(mockStripe, {
      code: 'welcome10',
      preDiscountTotal: 5000,
      now: expect.any(Date),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      code: 'WELCOME10',
      subtotalAmount: 5000,
      shippingAmount: 0,
      discountAmount: 500,
      totalAmount: 4500,
    });
  });

  test('使えなければ 422 で理由の文言を返し、監査ログには理由の記号だけを残す', async () => {
    mockCheckPromotionCode.mockResolvedValue({
      ok: false,
      reason: 'zero_total',
      message: 'このコードでは合計が0円になるため使えません',
    });

    const res = await POST(makeRequest({ code: 'FREE' }));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      error: 'promotion_code_invalid',
      reason: 'zero_total',
      message: 'このコードでは合計が0円になるため使えません',
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.promotion_code.check',
        outcome: 'failure',
        metadata: { session_id: 'sess-abc', reason: 'zero_total' },
      }),
    );
  });

  test('Stripe に問い合わせられなければ 500 で、時間をおいて試すよう案内する', async () => {
    mockCheckPromotionCode.mockRejectedValue(new Error('stripe down'));

    const res = await POST(makeRequest({ code: 'WELCOME10' }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'promotion_code_failed',
      message: '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。',
    });
  });
});
