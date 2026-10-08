import { loadCheckoutCart, readCheckoutCartRows } from '@/features/checkout/services/checkout-cart.service';

function supabaseWith(lines: unknown[], items: unknown[]) {
  const linesQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockResolvedValue({ data: lines, error: null }) };
  const itemsQuery = { select: jest.fn().mockReturnThis(), in: jest.fn().mockResolvedValue({ data: items, error: null }) };
  return { from: jest.fn((table: string) => (table === 'cart_lines' ? linesQuery : itemsQuery)) } as never;
}

const LINE = {
  id: 'line-1',
  quantity: 2,
  item_variants: { id: 1201, item_id: 45, is_active: true, item_colors: { name: 'ブラック' }, item_sizes: { label: 'M' } },
};
const ITEM = { id: 45, name: 'リネンシャツ', price: 12000, image_url: null, status: 'published' };

describe('checkout-cart.service', () => {
  test('明細をバリアントから下書き用の行にする', async () => {
    await expect(readCheckoutCartRows(supabaseWith([LINE], [ITEM]), 'cart-1')).resolves.toEqual([
      { id: 'line-1', item_id: 45, quantity: 2, color: 'ブラック', size: 'M', variant_id: 1201, variant_active: true },
    ]);
  });

  test('カートが無ければ空', async () => {
    await expect(loadCheckoutCart(supabaseWith([], []), null)).resolves.toEqual({ kind: 'empty' });
  });

  test('取り扱い終了のバリアントがあれば買えない', async () => {
    const inactive = { ...LINE, item_variants: { ...LINE.item_variants, is_active: false } };
    const result = await loadCheckoutCart(supabaseWith([inactive], [ITEM]), 'cart-1');
    expect(result.kind).toBe('unavailable');
  });

  // 以下は、上の3本が確かめない枝（買える場合・明細が無い場合・非公開・DB の失敗）を確かめる
  test('カートはあっても明細が無ければ空', async () => {
    await expect(loadCheckoutCart(supabaseWith([], []), 'cart-1')).resolves.toEqual({ kind: 'empty' });
  });

  test('買えるカートは、明細・商品・割引前の金額を返す', async () => {
    const result = await loadCheckoutCart(supabaseWith([LINE], [ITEM]), 'cart-1');

    expect(result).toEqual({
      kind: 'ok',
      cartRows: [
        { id: 'line-1', item_id: 45, quantity: 2, color: 'ブラック', size: 'M', variant_id: 1201, variant_active: true },
      ],
      itemMap: new Map([[45, ITEM]]),
      amounts: { subtotalAmount: 24000, taxAmount: 0, shippingAmount: 0, totalAmount: 24000 },
    });
  });

  test('非公開の商品は、状態で絞らずに読んで商品名で案内する', async () => {
    const privateItem = { ...ITEM, status: 'private' };
    const result = await loadCheckoutCart(supabaseWith([LINE], [privateItem]), 'cart-1');

    expect(result).toMatchObject({
      kind: 'unavailable',
      body: { error: 'out_of_stock', message: '以下の商品は現在購入できません: リネンシャツ' },
    });
  });

  test('バリアントの無い明細は読まない', async () => {
    const orphan = { id: 'line-2', quantity: 1, item_variants: null };
    const rows = await readCheckoutCartRows(supabaseWith([LINE, orphan], []), 'cart-1');

    expect(rows.map((row) => row.id)).toEqual(['line-1']);
  });

  test('カートの読み込みで DB が失敗したら投げる', async () => {
    const failure = { message: 'db down' };
    const linesQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockResolvedValue({ data: null, error: failure }) };
    const supabase = { from: jest.fn(() => linesQuery) } as never;

    await expect(readCheckoutCartRows(supabase, 'cart-1')).rejects.toBe(failure);
  });

  test('商品の読み込みで DB が失敗したら投げる', async () => {
    const failure = { message: 'db down' };
    const linesQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockResolvedValue({ data: [LINE], error: null }) };
    const itemsQuery = { select: jest.fn().mockReturnThis(), in: jest.fn().mockResolvedValue({ data: null, error: failure }) };
    const supabase = { from: jest.fn((table: string) => (table === 'cart_lines' ? linesQuery : itemsQuery)) } as never;

    await expect(loadCheckoutCart(supabase, 'cart-1')).rejects.toBe(failure);
  });
});
