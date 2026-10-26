import { fireEvent, render, screen, within } from '@testing-library/react';
import AdminOrderItemsTable from '@/components/AdminOrderItemsTable';
import type { AdminOrderDetail } from '@/lib/orders/admin-orders/admin-order-types';

const row: AdminOrderDetail['rows'][number] = { orderItemId: 'item-1', itemName: 'ブラウス', color: '白', size: 'M', isExchange: false, status: 'in_production', statusRank: 3, quantity: 2, unitPrice: 12800, lineAmount: 25600, refundAmount: 100, blockedReasons: ['stock_shortage'] };
it('FREQ-539-AC-01: 9列と状態別の金額、交換と補足を表示する', () => {
  render(<AdminOrderItemsTable rows={[{ ...row, isExchange: true }]} orderNumber="ORD-A1B2C3D4" canSwap={false} onSwap={jest.fn()} />);
  expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['商品名', '色', 'サイズ', 'ステータス', '数量', '単価', '合計金額', '返金額', '補足']);
  const item = screen.getAllByRole('row')[1];
  for (const text of ['ブラウス（交換品）', '受注生産中', '¥12,800', '¥25,600', '¥100', '在庫の入荷待ちです']) expect(within(item).getByText(text)).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'ORD-A1B2C3D4 明細の表' })).toHaveClass('overflow-x-auto');
});
it('FREQ-523-AC-05: 受注生産中かつ入荷待ちだけの行を選べる', () => {
  const onSwap = jest.fn();
  render(<AdminOrderItemsTable rows={[row, { ...row, status: 'ready' }, { ...row, blockedReasons: ['stock_shortage', 'payment_review'] }, { ...row, blockedReasons: [] }]} orderNumber="ORD-A1B2C3D4" canSwap onSwap={onSwap} />);
  const buttons = screen.getAllByRole('button', { name: 'ブラウス 白 M の割り当てを入れ替える' });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  expect(onSwap).toHaveBeenCalledWith(row);
});
it('FREQ-523-AC-05: allocateの旗が無ければ入口を出さない', () => {
  render(<AdminOrderItemsTable rows={[row]} orderNumber="ORD-A1B2C3D4" canSwap={false} onSwap={jest.fn()} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
