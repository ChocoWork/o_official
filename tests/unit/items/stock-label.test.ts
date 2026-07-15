import { formatStockLabel } from '@/lib/items/stock-label';

// FREQ-121: 色の丸の下の在庫表示ラベル
describe('formatStockLabel', () => {
  it('在庫あり（stock_quantity>=1、SOLD OUTでない）は「残り{n}点」', () => {
    expect(formatStockLabel(3, false)).toBe('残り3点');
    expect(formatStockLabel(1, false)).toBe('残り1点');
    expect(formatStockLabel(100, false)).toBe('残り100点');
  });

  it('在庫0は「受注生産」', () => {
    expect(formatStockLabel(0, false)).toBe('受注生産');
  });

  it('在庫情報なし（null / undefined）は「受注生産」', () => {
    expect(formatStockLabel(null, false)).toBe('受注生産');
    expect(formatStockLabel(undefined, false)).toBe('受注生産');
  });

  it('SOLD OUT 判定時は在庫数があっても「受注生産」（バッジと矛盾させない）', () => {
    expect(formatStockLabel(3, true)).toBe('受注生産');
  });
});
