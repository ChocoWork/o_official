import { ORDER_PROGRESS_LABELS } from '@/lib/orders/order-progress';
import { formatOrderStatus } from '@/lib/orders/order-status';

describe('formatOrderStatus', () => {
  // お客様の一覧の窓口は日本語の言葉をそのまま返す。ここで言い換えると、管理画面や注文の画面と言葉が食い違う
  it.each(Object.values(ORDER_PROGRESS_LABELS))('窓口が返す言葉「%s」はそのまま出る', (label) => {
    expect(formatOrderStatus(label)).toBe(label);
  });

  it('英語の状態の値は日本語にし、知らない値はそのまま返す（今のまま）', () => {
    expect(formatOrderStatus('shipped')).toBe('発送済み');
    expect(formatOrderStatus('cancelled')).toBe('キャンセル');
    expect(formatOrderStatus('unknown-status')).toBe('unknown-status');
  });
});
