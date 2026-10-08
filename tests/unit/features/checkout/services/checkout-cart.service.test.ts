import {
  loadCheckoutCart,
  readCheckoutCartRows,
  removeCartLines,
  splitPurchasableCartRows,
} from '@/features/checkout/services/checkout-cart.service';
import type {
  CheckoutCartSnapshotRow,
  CheckoutItemSnapshotRow,
} from '@/features/checkout/services/checkout-draft.service';

function supabaseWithSpies(lines: unknown[], items: unknown[]) {
  const linesQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockResolvedValue({ data: lines, error: null }),
    // loadCheckoutCart は読むだけ。カートを変えていないことを確かめるため、呼ばれたかを見られるようにしておく
    delete: jest.fn(),
  };
  const itemsQuery = { select: jest.fn().mockReturnThis(), in: jest.fn().mockResolvedValue({ data: items, error: null }) };
  const supabase = { from: jest.fn((table: string) => (table === 'cart_lines' ? linesQuery : itemsQuery)) } as never;
  return { supabase, linesQuery };
}

function supabaseWith(lines: unknown[], items: unknown[]) {
  return supabaseWithSpies(lines, items).supabase;
}

const LINE = {
  id: 'line-1',
  quantity: 2,
  item_variants: { id: 1201, item_id: 45, is_active: true, item_colors: { name: 'ブラック' }, item_sizes: { label: 'M' } },
};
const ITEM = { id: 45, name: 'リネンシャツ', price: 12000, image_url: null, status: 'published' };

/** 取り扱いを終えたバリアントの明細（商品 46 は公開中） */
const ENDED_LINE = {
  id: 'line-2',
  quantity: 1,
  item_variants: { id: 1301, item_id: 46, is_active: false, item_colors: { name: 'ネイビー' }, item_sizes: { label: 'L' } },
};
const ITEM_46 = { id: 46, name: 'ウールパンツ', price: 8000, image_url: null, status: 'published' };

function snapshotRow(overrides: Partial<CheckoutCartSnapshotRow> = {}): CheckoutCartSnapshotRow {
  return { id: 'line-1', item_id: 45, quantity: 1, color: 'ブラック', size: 'M', variant_id: 1201, variant_active: true, ...overrides };
}

function itemRow(overrides: Partial<CheckoutItemSnapshotRow> = {}): CheckoutItemSnapshotRow {
  return { ...ITEM, ...overrides };
}

describe('checkout-cart.service', () => {
  test('明細をバリアントから下書き用の行にする', async () => {
    await expect(readCheckoutCartRows(supabaseWith([LINE], [ITEM]), 'cart-1')).resolves.toEqual([
      { id: 'line-1', item_id: 45, quantity: 2, color: 'ブラック', size: 'M', variant_id: 1201, variant_active: true },
    ]);
  });

  test('カートが無ければ空', async () => {
    await expect(loadCheckoutCart(supabaseWith([], []), null)).resolves.toEqual({ kind: 'empty' });
  });

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

  // 取り扱いを終えた色・サイズ、非公開・無い商品の明細は、カートの画面（GET /api/cart）に出ない。
  // 割引コードの確かめは、画面に出ている明細と同じ明細で金額を出す（設計書 6-1）
  describe('loadCheckoutCart: 買えない明細', () => {
    test('取り扱い終了のバリアントの明細を除き、買える明細だけで金額を計算する', async () => {
      const { supabase } = supabaseWithSpies([LINE, ENDED_LINE], [ITEM, ITEM_46]);

      const result = await loadCheckoutCart(supabase, 'cart-1');

      expect(result).toMatchObject({
        kind: 'ok',
        cartRows: [{ id: 'line-1', item_id: 45, quantity: 2 }],
        amounts: { subtotalAmount: 24000, taxAmount: 0, shippingAmount: 0, totalAmount: 24000 },
      });
    });

    test('非公開の商品・商品が無い明細も除いて計算する', async () => {
      const privateLine = {
        id: 'line-3', quantity: 1, item_variants: { id: 1401, item_id: 47, is_active: true, item_colors: null, item_sizes: null },
      };
      const missingLine = {
        id: 'line-4', quantity: 1, item_variants: { id: 1501, item_id: 48, is_active: true, item_colors: null, item_sizes: null },
      };
      const privateItem = { id: 47, name: '非公開のコート', price: 30000, image_url: null, status: 'private' };

      const result = await loadCheckoutCart(supabaseWith([LINE, privateLine, missingLine], [ITEM, privateItem]), 'cart-1');

      expect(result).toMatchObject({
        kind: 'ok',
        cartRows: [{ id: 'line-1' }],
        amounts: { subtotalAmount: 24000, totalAmount: 24000 },
      });
    });

    test('同じ商品の販売中のバリアントの明細は、終了したバリアントの明細があっても買える', async () => {
      const endedSameItem = {
        id: 'line-5', quantity: 3, item_variants: { id: 1202, item_id: 45, is_active: false, item_colors: { name: 'ホワイト' }, item_sizes: { label: 'S' } },
      };

      const result = await loadCheckoutCart(supabaseWith([LINE, endedSameItem], [ITEM]), 'cart-1');

      expect(result).toMatchObject({
        kind: 'ok',
        cartRows: [{ id: 'line-1', variant_id: 1201 }],
        amounts: { subtotalAmount: 24000, totalAmount: 24000 },
      });
    });

    test('全部が買えない明細なら空（買えない商品の案内は返さない）', async () => {
      await expect(loadCheckoutCart(supabaseWith([ENDED_LINE], [ITEM_46]), 'cart-1')).resolves.toEqual({ kind: 'empty' });
      await expect(
        loadCheckoutCart(supabaseWith([LINE], [{ ...ITEM, status: 'private' }]), 'cart-1'),
      ).resolves.toEqual({ kind: 'empty' });
      await expect(loadCheckoutCart(supabaseWith([LINE], []), 'cart-1')).resolves.toEqual({ kind: 'empty' });
    });

    test('割引コードの確かめはカートを変えない（買えない明細を消さない）', async () => {
      const { supabase, linesQuery } = supabaseWithSpies([LINE, ENDED_LINE], [ITEM, ITEM_46]);

      await loadCheckoutCart(supabase, 'cart-1');

      expect(linesQuery.delete).not.toHaveBeenCalled();
    });
  });
});

describe('splitPurchasableCartRows', () => {
  test('公開中の商品で、バリアントが取り扱い中の明細は買える', () => {
    const rows = [snapshotRow()];

    expect(splitPurchasableCartRows(rows, [itemRow()])).toEqual({ purchasable: rows, unavailable: [] });
  });

  test('取り扱いを終えたバリアントの明細は、商品が公開中でも買えない', () => {
    const rows = [snapshotRow({ variant_active: false })];

    expect(splitPurchasableCartRows(rows, [itemRow()])).toEqual({ purchasable: [], unavailable: rows });
  });

  test.each(['private', 'archived', null, undefined])('商品が公開中でない（状態 %s）明細は買えない', (status) => {
    const rows = [snapshotRow()];

    expect(splitPurchasableCartRows(rows, [itemRow({ status: status as string })])).toEqual({
      purchasable: [],
      unavailable: rows,
    });
  });

  test('商品が無い明細は買えない', () => {
    const rows = [snapshotRow({ item_id: 99 })];

    expect(splitPurchasableCartRows(rows, [itemRow()])).toEqual({ purchasable: [], unavailable: rows });
  });

  test('明細ごとに見る: 同じ商品でも販売中の色・サイズの明細は買え、終了した明細だけが買えない。並びは入力の順', () => {
    const rows = [
      snapshotRow({ id: 'line-a', variant_id: 1, variant_active: true }),
      snapshotRow({ id: 'line-b', variant_id: 2, variant_active: false }),
      snapshotRow({ id: 'line-c', variant_id: 3, variant_active: true }),
      snapshotRow({ id: 'line-d', item_id: 46, variant_id: 4, variant_active: true }),
      snapshotRow({ id: 'line-e', variant_id: 5, variant_active: false }),
    ];
    const items = [itemRow(), itemRow({ id: 46, name: '非公開のパンツ', status: 'private' })];

    const { purchasable, unavailable } = splitPurchasableCartRows(rows, items);

    expect(purchasable.map((row) => row.id)).toEqual(['line-a', 'line-c']);
    expect(unavailable.map((row) => row.id)).toEqual(['line-b', 'line-d', 'line-e']);
  });

  test('明細が無ければどちらも空', () => {
    expect(splitPurchasableCartRows([], [itemRow()])).toEqual({ purchasable: [], unavailable: [] });
  });
});

describe('removeCartLines', () => {
  function deleteChain(result: { error: unknown }) {
    const inFilter = jest.fn().mockResolvedValue(result);
    const eqFilter = jest.fn().mockReturnValue({ in: inFilter });
    const remove = jest.fn().mockReturnValue({ eq: eqFilter });
    const from = jest.fn().mockReturnValue({ delete: remove });
    return { supabase: { from } as never, from, remove, eqFilter, inFilter };
  }

  test('カートの ID と明細の ID の両方の条件で消す（他人のカートの明細を消さない）', async () => {
    const { supabase, from, remove, eqFilter, inFilter } = deleteChain({ error: null });

    await expect(removeCartLines(supabase, 'cart-1', ['line-2', 'line-3'])).resolves.toBeUndefined();

    expect(from).toHaveBeenCalledWith('cart_lines');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(eqFilter).toHaveBeenCalledWith('cart_id', 'cart-1');
    expect(inFilter).toHaveBeenCalledWith('id', ['line-2', 'line-3']);
  });

  test('DB が失敗したら、その失敗を投げる', async () => {
    const failure = { message: 'db down', code: '57P01' };
    const { supabase } = deleteChain({ error: failure });

    await expect(removeCartLines(supabase, 'cart-1', ['line-2'])).rejects.toBe(failure);
  });
});
