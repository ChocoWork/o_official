import { fireEvent, render, screen } from '@testing-library/react';
import OrderSection, { type OrderItem } from '@/components/OrderSection';

const paidOrder: OrderItem = {
  id: 'paid-order',
  customerName: 'Paid Customer',
  customerEmail: 'paid@example.com',
  orderDate: '2026-09-22',
  itemCount: '1点',
  items: [],
  totalAmount: '¥10,000',
  status: '決済完了',
  canRefund: true,
  canShip: true,
};

const pendingOrder: OrderItem = {
  ...paidOrder,
  id: 'pending-order',
  status: '未決済',
  canRefund: false,
  canShip: false,
};

describe('OrderSection order actions', () => {
  it('shows cancel only for an unpaid order', () => {
    const onCancelOrder = jest.fn();

    render(
      <OrderSection
        orders={[paidOrder, pendingOrder]}
        onCancelOrder={onCancelOrder}
        onRefundOrder={jest.fn()}
        onShipOrder={jest.fn()}
      />,
    );

    const cancelButtons = screen.getAllByRole('button', { name: 'キャンセル' });
    expect(cancelButtons).toHaveLength(1);

    fireEvent.click(cancelButtons[0]);
    expect(onCancelOrder).toHaveBeenCalledWith('pending-order');
  });

  it('配送先が欠けた決済済み注文は発送操作を出さず確認を促す', () => {
    render(
      <OrderSection
        orders={[{ ...paidOrder, canShip: false, missingShippingFields: ['address', 'phone'] }]}
        onShipOrder={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '発送済みにする' })).not.toBeInTheDocument();
    expect(screen.getByText('配送先要確認')).toBeInTheDocument();
  });
});
