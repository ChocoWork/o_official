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
const mockRemoveCartLines = jest.fn();
jest.mock('@/features/checkout/services/checkout-cart.service', () => ({
  loadCheckoutCart: (...args: unknown[]) => mockLoadCheckoutCart(...args),
  // 割引コードの確かめはカートを変えない。呼ばれていないことを確かめるために差し替えておく
  removeCartLines: (...args: unknown[]) => mockRemoveCartLines(...args),
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

// route が作る Supabase のクライアント。本物の loadCheckoutCart を通す試験だけが、読み込みの結果を差し替える
const mockSupabaseFrom = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: (...args: unknown[]) => mockSupabaseFrom(...args) }),
}));

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
    mockSupabaseFrom.mockReset();
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

  // 取り扱いを終えた色・サイズ、非公開・無い商品の明細は、カートの画面（GET /api/cart）に出ない。
  // 割引コードの確かめはそれで断らず、画面に出ている明細だけの金額で確かめ、カートは変えない（設計書 6-1）。本物の loadCheckoutCart を通す
  test('買えない明細があっても 409 にせず、買える明細だけの金額で確かめる。カートは変えない', async () => {
    const lineOf = (id: string, itemId: number, variantId: number, quantity: number, isActive: boolean) => ({
      id,
      quantity,
      item_variants: { id: variantId, item_id: itemId, is_active: isActive, item_colors: null, item_sizes: null },
    });
    const cartLines = [
      lineOf('line-1', 1, 101, 1, true),
      lineOf('line-2', 2, 201, 3, false),
      lineOf('line-3', 3, 301, 1, true),
      lineOf('line-4', 4, 401, 1, true),
    ];
    const items = [
      { id: 1, name: 'シャツ', price: 5000, image_url: null, status: 'published' },
      { id: 2, name: '終了したパンツ', price: 8000, image_url: null, status: 'published' },
      { id: 3, name: '非公開のコート', price: 30000, image_url: null, status: 'private' },
    ];
    const deleteLines = jest.fn();
    const linesQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ data: cartLines, error: null }),
      delete: deleteLines,
    };
    const itemsQuery = { select: jest.fn().mockReturnThis(), in: jest.fn().mockResolvedValue({ data: items, error: null }) };
    mockSupabaseFrom.mockImplementation((table: string) => (table === 'cart_lines' ? linesQuery : itemsQuery));
    mockLoadCheckoutCart.mockImplementationOnce(
      jest.requireActual('@/features/checkout/services/checkout-cart.service').loadCheckoutCart,
    );
    mockCheckPromotionCode.mockResolvedValue({
      ok: true,
      promotionCodeId: 'promo_1',
      code: 'WELCOME10',
      discountAmount: 500,
      totalAfterDiscount: 4500,
    });

    const res = await POST(makeRequest({ code: 'WELCOME10' }));

    expect(res.status).toBe(200);
    expect(mockCheckPromotionCode).toHaveBeenCalledWith(mockStripe, {
      code: 'WELCOME10',
      preDiscountTotal: 5000,
      now: expect.any(Date),
    });
    await expect(res.json()).resolves.toMatchObject({ subtotalAmount: 5000, totalAmount: 4500 });
    expect(mockRemoveCartLines).not.toHaveBeenCalled();
    expect(deleteLines).not.toHaveBeenCalled();
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

  // PostgREST の失敗は Error ではない素のオブジェクトで投げられる。メッセージを取りこぼさず、details・hint は残さない
  test('カートの読み込みの素の PostgREST エラーも、監査には code と message だけを残す', async () => {
    mockLoadCheckoutCart.mockRejectedValue({
      code: '42P01', message: 'relation does not exist', details: '監査に残さない詳細', hint: '監査に残さないヒント',
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await POST(makeRequest({ code: 'WELCOME10' }));

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({ error: 'promotion_code_failed' });
      expect(consoleError).toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'checkout.promotion_code.check',
          outcome: 'error',
          metadata: { session_id: 'sess-abc', error_message: 'relation does not exist', error_code: '42P01' },
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test('Stripe に問い合わせられなければ 500 で、時間をおいて試すよう案内する', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockCheckPromotionCode.mockRejectedValue(new Error('stripe down'));

    const res = await POST(makeRequest({ code: 'WELCOME10' }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'promotion_code_failed',
      message: '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。',
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
