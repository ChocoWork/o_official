import { buildCartJson } from '@/features/cart/services/cart-view';
import { previewFulfillment } from '@/features/checkout/services/checkout-fulfillment.service';

jest.mock('@/features/checkout/services/checkout-fulfillment.service', () => ({ previewFulfillment: jest.fn() }));
jest.mock('@/lib/storage/item-images', () => ({ signItemImageUrl: jest.fn(async (_s: unknown, url: string) => `${url}?signed`) }));

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    quantity: 2,
    added_at: '2026-10-08T00:00:00Z',
    item_variants: {
      id: 1201,
      item_id: 45,
      is_active: true,
      item_colors: { name: 'ブラック' },
      item_sizes: { label: 'M' },
      items: { id: 45, name: 'リネンシャツ', price: 12000, image_url: 'items/45.png', status: 'published' },
    },
    ...overrides,
  };
}

function supabaseWith(rows: unknown[]) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    then: (resolve: (result: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
  };
  return { from: jest.fn().mockReturnValue(query), rpc: jest.fn() } as never;
}

describe('buildCartJson', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (previewFulfillment as jest.Mock).mockResolvedValue([{ lineNo: 1, fulfillment: 'stock' }]);
  });

  afterEach(() => jest.restoreAllMocks());

  test('持ち主が無ければ空のカート', async () => {
    const supabase = supabaseWith([]);
    await expect(buildCartJson(supabase, null)).resolves.toEqual({ item_count: 0, currency: 'JPY', items_subtotal_price: 0, total_price: 0, items: [] });
  });

  test('Shopify の /cart.js の形で返し、印は返さない', async () => {
    const cart = await buildCartJson(supabaseWith([line()]), 'cart-1');
    expect(cart).toEqual({
      item_count: 2,
      currency: 'JPY',
      items_subtotal_price: 24000,
      total_price: 24000,
      items: [{
        key: 'line-1',
        id: 1201,
        variant_id: 1201,
        product_id: 45,
        quantity: 2,
        title: 'リネンシャツ - ブラック / M',
        product_title: 'リネンシャツ',
        variant_title: 'ブラック / M',
        options_with_values: [{ name: 'カラー', value: 'ブラック' }, { name: 'サイズ', value: 'M' }],
        price: 12000,
        line_price: 24000,
        image: 'items/45.png?signed',
        url: '/item/45',
        fulfillment: 'stock',
      }],
    });
    expect(JSON.stringify(cart)).not.toContain('token');
  });

  test('色・サイズの無いバリアントは題名が商品名だけ', async () => {
    const plain = line({ item_variants: { ...line().item_variants, item_colors: null, item_sizes: null } });
    const cart = await buildCartJson(supabaseWith([plain]), 'cart-1');
    expect(cart.items[0]).toMatchObject({ title: 'リネンシャツ', variant_title: null, options_with_values: [] });
  });

  test('非公開の商品と取り扱い終了のバリアントは出さず、数にも入れない', async () => {
    const hidden = line({ id: 'line-2', item_variants: { ...line().item_variants, items: { ...line().item_variants.items, status: 'private' } } });
    const inactive = line({ id: 'line-3', item_variants: { ...line().item_variants, id: 1300, is_active: false } });
    const cart = await buildCartJson(supabaseWith([line(), hidden, inactive]), 'cart-1');
    expect(cart.items.map((item) => item.key)).toEqual(['line-1']);
    expect(cart.item_count).toBe(2);
  });

  test('お届けの目安が読めなくてもカートは返す', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (previewFulfillment as jest.Mock).mockRejectedValueOnce(new Error('rpc down'));
    const cart = await buildCartJson(supabaseWith([line()]), 'cart-1');
    expect(cart.items[0].fulfillment).toBeNull();
    expect(spy).toHaveBeenCalledWith('Failed to preview cart fulfillment:', expect.any(Error));
    spy.mockRestore();
  });

  test('同じ日時の明細の並びを決めるため、日時の降順の次に id の昇順を指定する', async () => {
    const supabase = supabaseWith([line(), line({ id: 'line-2', item_variants: { ...line().item_variants, id: 1300 } })]);

    const cart = await buildCartJson(supabase, 'cart-1');

    const query = (supabase as { from: jest.Mock }).from.mock.results[0].value;
    expect(query.order).toHaveBeenCalledTimes(2);
    expect(query.order).toHaveBeenNthCalledWith(1, 'added_at', { ascending: false });
    expect(query.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
    expect(cart.items.map((item) => item.key)).toEqual(['line-1', 'line-2']);
  });

  test('隠す明細を間に挟んでも lineNo を見える明細の順に対応させる', async () => {
    const hidden = line({ id: 'hidden', item_variants: { ...line().item_variants, items: { ...line().item_variants.items, status: 'private' } } });
    const inactive = line({ id: 'inactive', item_variants: { ...line().item_variants, is_active: false } });
    const second = line({ id: 'line-2', quantity: 3, item_variants: { ...line().item_variants, id: 1300, item_id: 46, item_colors: { name: 'ホワイト' }, items: { ...line().item_variants.items, id: 46 } } });
    const third = line({ id: 'line-3', quantity: 1, item_variants: { ...line().item_variants, id: 1400, item_id: 47, item_sizes: { label: 'L' }, items: { ...line().item_variants.items, id: 47 } } });
    const supabase = supabaseWith([line(), hidden, second, inactive, third]);
    (previewFulfillment as jest.Mock).mockResolvedValueOnce([
      { lineNo: 3, fulfillment: 'stock' },
      { lineNo: 1, fulfillment: 'stock' },
      { lineNo: 2, fulfillment: 'backorder' },
    ]);

    const cart = await buildCartJson(supabase, 'cart-1');

    expect(previewFulfillment).toHaveBeenCalledWith(supabase, [
      { item_id: 45, color: 'ブラック', size: 'M', quantity: 2 },
      { item_id: 46, color: 'ホワイト', size: 'M', quantity: 3 },
      { item_id: 47, color: 'ブラック', size: 'L', quantity: 1 },
    ]);
    expect(cart.items.map((item) => ({ key: item.key, fulfillment: item.fulfillment }))).toEqual([
      { key: 'line-1', fulfillment: 'stock' },
      { key: 'line-2', fulfillment: 'backorder' },
      { key: 'line-3', fulfillment: 'stock' },
    ]);
    expect(cart.item_count).toBe(6);
    expect(cart.total_price).toBe(72000);
  });
});
