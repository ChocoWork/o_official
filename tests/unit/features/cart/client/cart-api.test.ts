import { fetchCartJson, findVariantId, postCart, sendShoppingRequest, toCartEntries } from '@/features/cart/client/cart-api';
import { refreshSessionOnce } from '@/lib/client-fetch';
import type { CartJson } from '@/features/cart/types/cart-json';

jest.mock('@/lib/client-fetch', () => ({
  ...jest.requireActual('@/lib/client-fetch'),
  refreshSessionOnce: jest.fn(),
}));

const CART: CartJson = {
  item_count: 2,
  currency: 'JPY',
  items_subtotal_price: 24000,
  total_price: 24000,
  items: [{
    key: 'line-1', id: 1201, variant_id: 1201, product_id: 45, quantity: 2,
    title: 'リネンシャツ - ブラック / M', product_title: 'リネンシャツ', variant_title: 'ブラック / M',
    options_with_values: [{ name: 'カラー', value: 'ブラック' }, { name: 'サイズ', value: 'M' }],
    price: 12000, line_price: 24000, image: '/img.png', url: '/item/45', fulfillment: 'backorder',
  }],
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('cart-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.cookie = 'sb-csrf-token=; max-age=0';
    global.fetch = jest.fn();
  });

  test('Shopify の形を今の画面用の形に直す', () => {
    expect(toCartEntries(CART)).toEqual([{
      id: 'line-1', item_id: 45, variant_id: 1201, quantity: 2, color: 'ブラック', size: 'M', fulfillment: 'backorder',
      items: { id: 45, name: 'リネンシャツ', price: 12000, image_url: '/img.png' },
    }]);
  });

  test('色・サイズの無い商品と画像の無い商品も、画面用の形に直せる', () => {
    const plain: CartJson = {
      ...CART,
      items: [{ ...CART.items[0], options_with_values: [], variant_title: null, image: null, fulfillment: null }],
    };
    expect(toCartEntries(plain)).toEqual([{
      id: 'line-1', item_id: 45, variant_id: 1201, quantity: 2, color: null, size: null, fulfillment: null,
      items: { id: 45, name: 'リネンシャツ', price: 12000, image_url: '' },
    }]);
  });

  test('ゲスト（読める CSRF の Cookie が無い）は合言葉を付けず、印の更新も呼ばない', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { items: [] }));
    await postCart('/api/cart/add', { items: [{ id: 1201, quantity: 1 }] }, 'x');
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has('x-csrf-token')).toBe(false);
    expect(refreshSessionOnce).not.toHaveBeenCalled();
  });

  test('会員は読める CSRF の Cookie の合言葉を付ける', async () => {
    document.cookie = 'sb-csrf-token=abc';
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, CART));
    await postCart('/api/cart/change', { id: 'line-1', quantity: 0 }, 'x');
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('abc');
  });

  test('401 auth_expired は印を1回だけ新しくして送り直す', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse(401, { error: 'auth_expired' }))
      .mockResolvedValueOnce(jsonResponse(200, CART));
    (refreshSessionOnce as jest.Mock).mockResolvedValue('refreshed');
    await expect(fetchCartJson()).resolves.toEqual(CART);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('印を新しくできなければ送り直さない', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(401, { error: 'auth_expired' }));
    (refreshSessionOnce as jest.Mock).mockResolvedValue('expired');
    const response = await sendShoppingRequest('/api/cart');
    expect(response.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('CSRF の 403 も印を1回だけ新しくして、新しい合言葉で送り直す', async () => {
    document.cookie = 'sb-csrf-token=old';
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse(403, { error: 'Forbidden', reason: 'CSRF validation failed' }))
      .mockResolvedValueOnce(jsonResponse(200, CART));
    // 印の更新で合言葉の Cookie が入れ替わる
    (refreshSessionOnce as jest.Mock).mockImplementation(async () => {
      document.cookie = 'sb-csrf-token=new';
      return 'refreshed';
    });
    const result = await postCart('/api/cart/change', { id: 'line-1', quantity: 1 }, 'x');
    expect(result.ok).toBe(true);
    expect(refreshSessionOnce).toHaveBeenCalledTimes(1);
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(new Headers((calls[0][1] as RequestInit).headers).get('x-csrf-token')).toBe('old');
    expect(new Headers((calls[1][1] as RequestInit).headers).get('x-csrf-token')).toBe('new');
  });

  test('CSRF 以外の 403 は印を新しくせず、そのまま返す', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(403, { error: 'Forbidden', reason: 'Origin mismatch' }));
    const response = await sendShoppingRequest('/api/cart/add', { method: 'POST' });
    expect(response.status).toBe(403);
    expect(refreshSessionOnce).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('読み取り（GET）には会員でも合言葉を付けない', async () => {
    document.cookie = 'sb-csrf-token=abc';
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, CART));
    await fetchCartJson();
    const [endpoint, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('/api/cart');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).has('x-csrf-token')).toBe(false);
  });

  test('カートを読めなかった時は例外にする', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(500, { status: 500, message: 'Cart Error', description: 'x' }));
    await expect(fetchCartJson()).rejects.toThrow('カートの取得に失敗しました');
  });

  test('断りの description をそのまま返す', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(422, { status: 422, message: 'Cart Error', description: '1つの商品は20個までです。' }));
    await expect(postCart('/api/cart/add', {}, '失敗')).resolves.toEqual({ ok: false, status: 422, description: '1つの商品は20個までです。' });
  });

  test('断りに description が無ければ、呼び出し側の文言を返す', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(postCart('/api/cart/add', {}, '失敗')).resolves.toEqual({ ok: false, status: 502, description: '失敗' });
  });

  test('選んだ色・サイズのバリアントの番号を探す（DeliveryNote と同じ比べ方）', () => {
    const availability = [
      { colorName: 'Black', sizeLabel: 'M', inStock: true, variantId: 11 },
      { colorName: null, sizeLabel: null, inStock: false, variantId: 12 },
    ];
    expect(findVariantId(availability, 'Black', 'M')).toBe(11);
    expect(findVariantId(availability, '', null)).toBe(12);
    expect(findVariantId(availability, 'Ivory', 'M')).toBeNull();
    expect(findVariantId(undefined, 'Black', 'M')).toBeNull();
  });
});
