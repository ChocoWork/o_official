import { NextRequest, NextResponse } from 'next/server';
import { GET } from '@/app/api/cart/route';
import { openShoppingContext } from '@/features/cart/services/shopping-context';
import { buildCartJson } from '@/features/cart/services/cart-view';
import { createServiceRoleClient } from '@/lib/supabase/server';

jest.mock('@/features/cart/services/shopping-context', () => ({
  openShoppingContext: jest.fn(),
  denyIfCsrfInvalid: jest.fn(),
}));
jest.mock('@/features/cart/services/cart-view', () => ({ buildCartJson: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));

// 既存の Jest の Response は json() を持たないため、実際の NextResponse を使えるよう補う。
if (typeof Response.json !== 'function') {
  Response.json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

const supabase = { rpc: jest.fn() };
const context = {
  kind: 'cart',
  owner: { kind: 'guest', tokenHash: 'f'.repeat(64) },
  rateLimitSubject: `guest:${'f'.repeat(64)}`,
  auditOwner: { owner: 'guest', guest_hash_prefix: 'ffffffffffff' },
  findOwnerId: jest.fn(),
  ensureOwnerId: jest.fn(),
  finish: jest.fn((res: NextResponse) => res),
};
const emptyCart = { item_count: 0, currency: 'JPY', items_subtotal_price: 0, total_price: 0, items: [] };

describe('GET /api/cart', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (createServiceRoleClient as jest.Mock).mockResolvedValue(supabase);
    (openShoppingContext as jest.Mock).mockResolvedValue({ ok: true, context });
    (buildCartJson as jest.Mock).mockResolvedValue(emptyCart);
    context.findOwnerId.mockResolvedValue('cart-1');
    context.finish.mockImplementation((res: NextResponse) => res);
  });

  afterEach(() => jest.restoreAllMocks());

  test('持ち主の確認が 401 ならその応答をそのまま返す', async () => {
    const denied = NextResponse.json({ error: 'session_expired' }, { status: 401 });
    (openShoppingContext as jest.Mock).mockResolvedValueOnce({ ok: false, response: denied });

    const req = new NextRequest('http://localhost:3000/api/cart');
    const res = await GET(req);

    expect(res).toBe(denied);
    expect(openShoppingContext).toHaveBeenCalledWith(req, 'cart', supabase, { write: false });
    expect(context.findOwnerId).not.toHaveBeenCalled();
    expect(buildCartJson).not.toHaveBeenCalled();
  });

  test('持ち主の行が無ければ空のカートを 200 で返し finish を通す', async () => {
    context.findOwnerId.mockResolvedValueOnce(null);

    const res = await GET(new NextRequest('http://localhost:3000/api/cart'));

    expect(buildCartJson).toHaveBeenCalledWith(supabase, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(emptyCart);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(context.finish).toHaveBeenCalledWith(res);
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
  });

  test('カートの読み込みが失敗したら Shopify の形の 500 を返す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (buildCartJson as jest.Mock).mockRejectedValueOnce(new Error('DB unavailable'));

    const res = await GET(new NextRequest('http://localhost:3000/api/cart'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      status: 500,
      message: 'Cart Error',
      description: 'カートを更新できませんでした。時間をおいてもう一度お試しください。',
    });
  });

  test('持ち主の行があれば組み立てたカートを 200 で返す', async () => {
    const cart = {
      item_count: 1, currency: 'JPY', items_subtotal_price: 12000, total_price: 12000,
      items: [{
        key: 'line-1', id: 1201, variant_id: 1201, product_id: 45, quantity: 1,
        title: 'リネンシャツ', product_title: 'リネンシャツ', variant_title: null, options_with_values: [],
        price: 12000, line_price: 12000, image: null, url: '/item/45', fulfillment: 'stock',
      }],
    };
    (buildCartJson as jest.Mock).mockResolvedValueOnce(cart);

    const res = await GET(new NextRequest('http://localhost:3000/api/cart'));

    expect(buildCartJson).toHaveBeenCalledWith(supabase, 'cart-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(cart);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(context.finish).toHaveBeenCalledWith(res);
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
  });
});
