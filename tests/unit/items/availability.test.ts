const mockFrom = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}));

import { getItemsAvailability } from '@/lib/items/availability';

/**
 * 店頭に出す在庫の見え方（FREQ-400）。
 *
 * 在庫の有無は「買えるか」ではなく「納期」を分ける。在庫のある組み合わせは早く出せて、
 * 無い組み合わせは受注生産になる。どちらも買える。
 *
 * 公開するのは有無（真偽）だけで、残数は出さない。残数を見せると在庫量が外から分かるうえ、
 * 「あと1点」で急かす売り方になり、セールをしないというブランドの方針と合わない。
 */
function setupVariants(rows: unknown[], error: { message: string } | null = null) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'item_variants') {
      return {
        select: jest.fn().mockReturnValue({
          in: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ data: rows, error }),
          }),
        }),
      };
    }
    return {};
  });
}

function variantRow(overrides: Record<string, unknown> = {}) {
  return {
    item_id: 7,
    stock_quantity: 0,
    is_active: true,
    item_colors: { name: 'BLACK' },
    item_sizes: { label: 'M' },
    ...overrides,
  };
}

describe('getItemsAvailability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('商品 id が空なら DB を見ない', async () => {
    const result = await getItemsAvailability([]);

    expect(result.size).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('在庫のある組み合わせがあれば、その商品は受注生産ではない', async () => {
    setupVariants([
      variantRow({ stock_quantity: 3 }),
      variantRow({ stock_quantity: 0, item_sizes: { label: 'L' } }),
    ]);

    const result = await getItemsAvailability([7]);

    expect(result.get(7)).toEqual({
      madeToOrder: false,
      combinations: [
        { colorName: 'BLACK', sizeLabel: 'M', inStock: true },
        { colorName: 'BLACK', sizeLabel: 'L', inStock: false },
      ],
    });
  });

  test('全部の在庫が 0 なら受注生産になる', async () => {
    setupVariants([variantRow({ stock_quantity: 0 })]);

    const result = await getItemsAvailability([7]);

    expect(result.get(7)?.madeToOrder).toBe(true);
  });

  test('止めている組み合わせは在庫があっても在庫なし扱いにする', async () => {
    setupVariants([variantRow({ stock_quantity: 5, is_active: false })]);

    const result = await getItemsAvailability([7]);

    expect(result.get(7)).toEqual({
      madeToOrder: true,
      combinations: [{ colorName: 'BLACK', sizeLabel: 'M', inStock: false }],
    });
  });

  test('残数は出さない', async () => {
    setupVariants([variantRow({ stock_quantity: 42 })]);

    const result = await getItemsAvailability([7]);

    expect(JSON.stringify(result.get(7))).not.toContain('42');
  });

  /**
   * バリアントがまだ無い商品は「組み合わせが分からない」。
   * 受注生産として扱い、注文は止めない（在庫が理由で買えなくしない）。
   */
  test('バリアントが1つも無い商品は受注生産として返す', async () => {
    setupVariants([]);

    const result = await getItemsAvailability([7]);

    expect(result.get(7)).toEqual({ madeToOrder: true, combinations: [] });
  });

  test('取得に失敗しても落とさず、受注生産として返す', async () => {
    setupVariants(null as unknown as unknown[], { message: 'boom' });

    const result = await getItemsAvailability([7, 8]);

    expect(result.get(7)).toEqual({ madeToOrder: true, combinations: [] });
    expect(result.get(8)).toEqual({ madeToOrder: true, combinations: [] });
  });

  test('公開中の商品だけを対象にする', async () => {
    const eq = jest.fn().mockResolvedValue({ data: [], error: null });
    const inFn = jest.fn().mockReturnValue({ eq });
    mockFrom.mockReturnValue({ select: jest.fn().mockReturnValue({ in: inFn }) });

    await getItemsAvailability([7]);

    expect(inFn).toHaveBeenCalledWith('item_id', [7]);
    expect(eq).toHaveBeenCalledWith('items.status', 'published');
  });
});
