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
  canCancel: true,
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

  it('要確認の注文に「要確認」の印を出す', () => {
    render(<OrderSection orders={[{ ...paidOrder, needsReview: true }]} />);

    expect(screen.getByText('要確認')).toBeInTheDocument();
  });

  it('支払額の確認が必要な注文は、発送ボタンの代わりに理由を出す', () => {
    render(
      <OrderSection
        orders={[{ ...paidOrder, canShip: false, shipBlockedReason: '支払額の確認が必要です（要対応）' }]}
        onShipOrder={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '発送済みにする' })).not.toBeInTheDocument();
    expect(screen.getByText('支払額の確認が必要です（要対応）')).toBeInTheDocument();
    expect(screen.queryByText('配送先要確認')).not.toBeInTheDocument();
  });

  it('払込票が有効な注文は、取消の代わりに払込期限を出す', () => {
    render(
      <OrderSection
        orders={[{ ...pendingOrder, canCancel: false, cancelBlockedUntil: '2026-09-30T14:59:59.000Z' }]}
        onCancelOrder={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/払込票の期限切れが確定するまで取り消せません（払込期限 2026\/09\/30 23:59）/),
    ).toBeInTheDocument();
  });

  it('取り消せず払込期限も無い未決済の注文は、支払いの状態を確かめられないことを出す', () => {
    render(
      <OrderSection
        orders={[{ ...pendingOrder, canCancel: false, cancelBlockedUntil: null }]}
        onCancelOrder={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
    expect(screen.getByText('支払いの状態を確かめられないため、今は取り消せません')).toBeInTheDocument();
  });

  it('取消済みや発送済みの注文には、取り消せない理由を出さない', () => {
    render(
      <OrderSection
        orders={[
          { ...paidOrder, id: 'cancelled-order', status: 'キャンセル', canRefund: false, canShip: false, canCancel: false },
          { ...paidOrder, id: 'shipped-order', status: '発送済み', canShip: false, canCancel: false },
        ]}
        onCancelOrder={jest.fn()}
      />,
    );

    expect(screen.queryByText('支払いの状態を確かめられないため、今は取り消せません')).not.toBeInTheDocument();
    expect(screen.queryByText(/払込票の期限切れが確定するまで取り消せません/)).not.toBeInTheDocument();
  });

  it('放棄の印は、灰色の背景に読める文字色（#474747）で出す', () => {
    render(<OrderSection orders={[{ ...paidOrder, status: '放棄', canRefund: false, canShip: false }]} />);

    const badge = screen.getByText('放棄');
    expect(badge).toHaveClass('bg-gray-100', 'text-[#474747]');
    expect(badge).not.toHaveClass('text-gray-500');
  });

  it('支払い手続き中の注文も取り消せる', () => {
    const onCancelOrder = jest.fn();
    render(
      <OrderSection
        orders={[{ ...pendingOrder, id: 'in-progress', status: '支払い手続き中' }]}
        onCancelOrder={onCancelOrder}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onCancelOrder).toHaveBeenCalledWith('in-progress');
  });
});
