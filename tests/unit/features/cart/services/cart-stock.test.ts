import { collectInventoryIssues } from '@/features/cart/services/cart-stock';

const PUBLISHED = { id: 45, name: 'リネンシャツ', status: 'published' };

describe('collectInventoryIssues', () => {
  test('公開中の商品で、バリアントが取り扱い中なら買える', () => {
    expect(collectInventoryIssues([{ item_id: 45, quantity: 2, variant_active: true }], [PUBLISHED])).toEqual([]);
  });

  test('variant_active を持たない行は、取り扱い中として扱う', () => {
    expect(collectInventoryIssues([{ item_id: 45, quantity: 2 }], [PUBLISHED])).toEqual([]);
  });

  test('取り扱いを終えたバリアントの行がある商品は、公開中でも unavailable', () => {
    expect(collectInventoryIssues([{ item_id: 45, quantity: 2, variant_active: false }], [PUBLISHED])).toEqual([
      { item_id: 45, name: 'リネンシャツ', requestedQuantity: 2, availableQuantity: null, reason: 'unavailable' },
    ]);
  });

  test('同じ商品に取り扱い中の行があっても、終了した行が1つでもあれば商品ごと1件で unavailable', () => {
    const rows = [
      { item_id: 45, quantity: 1, variant_active: true },
      { item_id: 45, quantity: 3, variant_active: false },
    ];

    expect(collectInventoryIssues(rows, [PUBLISHED])).toEqual([
      { item_id: 45, name: 'リネンシャツ', requestedQuantity: 4, availableQuantity: null, reason: 'unavailable' },
    ]);
  });

  test('終了したバリアントが無い別の商品は巻き込まない', () => {
    const rows = [
      { item_id: 45, quantity: 1, variant_active: false },
      { item_id: 46, quantity: 1, variant_active: true },
    ];
    const items = [PUBLISHED, { id: 46, name: 'ウールパンツ', status: 'published' }];

    expect(collectInventoryIssues(rows, items).map((issue) => issue.item_id)).toEqual([45]);
  });

  test('非公開・存在しない商品は unavailable（取り扱い中のバリアントでも）', () => {
    const rows = [
      { item_id: 45, quantity: 1, variant_active: true },
      { item_id: 99, quantity: 1, variant_active: true },
    ];
    const items = [{ ...PUBLISHED, status: 'private' }];

    expect(collectInventoryIssues(rows, items)).toEqual([
      { item_id: 45, name: 'リネンシャツ', requestedQuantity: 1, availableQuantity: null, reason: 'unavailable' },
      { item_id: 99, name: '商品 99', requestedQuantity: 1, availableQuantity: null, reason: 'unavailable' },
    ]);
  });
});
