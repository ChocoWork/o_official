import { SIZES } from '@/app/admin/item/types';
import { SIZE_ORDER, sortSizes } from '@/lib/items/sizes';

// FREQ-305: ITEM詳細ページのサイズは Admin の選択肢の並び順で表示する
describe('sortSizes', () => {
  it('保存順が逆でも S → M → L に並べ替える', () => {
    expect(sortSizes(['L', 'M', 'S'])).toEqual(['S', 'M', 'L']);
    expect(sortSizes(['M', 'S'])).toEqual(['S', 'M']);
  });

  it('FREE は末尾に置く', () => {
    expect(sortSizes(['FREE', 'M', 'S'])).toEqual(['S', 'M', 'FREE']);
  });

  it('SIZE_ORDER に無い値は元の相対順のまま末尾に置く', () => {
    expect(sortSizes(['ONE SIZE', 'M', 'KIDS', 'S'])).toEqual([
      'S',
      'M',
      'ONE SIZE',
      'KIDS',
    ]);
  });

  it('元の配列を破壊しない', () => {
    const original = ['L', 'S'];
    sortSizes(original);
    expect(original).toEqual(['L', 'S']);
  });

  it('Admin の選択肢は SIZE_ORDER の並びの部分集合である', () => {
    const ranks = SIZES.map((size) =>
      (SIZE_ORDER as readonly string[]).indexOf(size),
    );
    expect(ranks).not.toContain(-1);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});
