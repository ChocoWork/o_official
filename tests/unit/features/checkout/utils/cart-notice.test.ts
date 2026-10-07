import {
  isSameCartLine,
  parseCartNotice,
  saveCartNotice,
  takeCartNotice,
} from '@/features/checkout/utils/cart-notice';

describe('カート画面への案内の受け渡し（決め事 D11）', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('保存した案内を1回だけ読める（読んだら消える）', () => {
    saveCartNotice({
      kind: 'stock_changed',
      message: '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）',
      lines: [{ itemId: 2, name: 'パンツ', color: 'NAVY', size: 'L' }],
    });

    expect(takeCartNotice()).toEqual({
      kind: 'stock_changed',
      message: '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）',
      lines: [{ itemId: 2, name: 'パンツ', color: 'NAVY', size: 'L' }],
    });
    expect(takeCartNotice()).toBeNull();
  });

  test('形の違う値は読まない（壊れた値で画面を落とさない）', () => {
    window.sessionStorage.setItem('checkout:cart-notice', '{not json');
    expect(takeCartNotice()).toBeNull();
    expect(window.sessionStorage.getItem('checkout:cart-notice')).toBeNull();

    expect(parseCartNotice({ kind: 'message' })).toBeNull();
    expect(parseCartNotice({ kind: 'stock_changed', message: 'x', lines: [{ itemId: '2' }] })).toBeNull();
    expect(parseCartNotice({ kind: 'message', message: '商品の価格が変わりました。内容をご確認ください' })).toEqual({
      kind: 'message',
      message: '商品の価格が変わりました。内容をご確認ください',
    });
  });

  test('保存できない環境でも投げない', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => saveCartNotice({ kind: 'message', message: 'x' })).not.toThrow();
    setItem.mockRestore();
  });

  test('商品・色・サイズが同じ行を同じ明細とみなす（色・サイズが無い商品も）', () => {
    const line = { itemId: 2, name: 'パンツ', color: 'NAVY', size: 'L' };
    expect(isSameCartLine(line, { item_id: 2, color: 'NAVY', size: 'L' })).toBe(true);
    expect(isSameCartLine(line, { item_id: 2, color: 'NAVY', size: 'M' })).toBe(false);
    expect(
      isSameCartLine({ itemId: 3, name: 'バッグ', color: null, size: null }, { item_id: 3, color: null, size: null }),
    ).toBe(true);
  });
});
