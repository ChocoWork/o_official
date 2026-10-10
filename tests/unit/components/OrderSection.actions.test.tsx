import { fireEvent, render, screen, within } from '@testing-library/react';
import OrderSection, { type OrderItem, type OrderLineItem, type OrderStatus } from '@/components/OrderSection';

function line(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  return {
    id: 'line-1', name: 'シルクブラウス', color: '白', size: 'M', quantity: 1, fulfillmentType: 'stock',
    shipped: 0, inProduction: 0, readyUnshipped: 1,
    ...overrides,
  };
}

const paidOrder: OrderItem = {
  id: 'paid-order',
  customerName: 'Paid Customer',
  customerEmail: 'paid@example.com',
  orderDate: '2026-09-22',
  itemCount: '1点',
  items: [line()],
  totalAmount: '¥10,000',
  status: '発送準備中',
  orderStatus: 'paid',
  progressKey: 'ready',
  partiallyShipped: false,
  canRefund: true,
  canShip: true,
  canRecordCompletion: false,
};

const pendingOrder: OrderItem = {
  ...paidOrder,
  id: 'pending-order',
  status: '未決済',
  orderStatus: 'pending',
  progressKey: 'unpaid',
  items: [line({ readyUnshipped: 0 })],
  canRefund: false,
  canShip: false,
  canCancel: true,
};

/** 受注生産の品が1つ作り中の注文 */
const inProductionOrder: OrderItem = {
  ...paidOrder,
  id: 'in-production-order',
  status: '受注生産中',
  progressKey: 'in_production',
  items: [line({ id: 'line-coat', name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder', inProduction: 1, readyUnshipped: 0 })],
  canRecordCompletion: true,
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

  it('受注生産中の言葉の注文でも、配送先が欠けていれば確認を促し、支払額の確認が必要なら理由を出す', () => {
    render(
      <OrderSection
        orders={[
          { ...inProductionOrder, id: 'no-address', canShip: false, missingShippingFields: ['address'] },
          { ...inProductionOrder, id: 'blocked', canShip: false, shipBlockedReason: '支払額の確認が必要です（要対応）' },
        ]}
        onShipOrder={jest.fn()}
      />,
    );

    expect(screen.getAllByText('配送先要確認')).toHaveLength(1);
    expect(screen.getByText('支払額の確認が必要です（要対応）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送済みにする' })).not.toBeInTheDocument();
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

  it('送る品が残っていない発送待ちの注文（canShip: false）は、配送先がそろっていれば「配送先要確認」を出さない', () => {
    render(
      <OrderSection
        orders={[
          { ...paidOrder, id: 'nothing-left-a', canShip: false, missingShippingFields: [] },
          { ...paidOrder, id: 'nothing-left-b', canShip: false },
          { ...paidOrder, id: 'no-address', canShip: false, missingShippingFields: ['address'] },
        ]}
        onShipOrder={jest.fn()}
      />,
    );

    // 出るのは、配送先が実際に足りない注文だけ
    const rows = screen.getAllByRole('row');
    const rowOf = (id: string) => rows.find((row) => row.textContent?.includes(id)) as HTMLElement;
    expect(within(rowOf('no-address')).getByText('配送先要確認')).toBeInTheDocument();
    expect(within(rowOf('nothing-left-a')).queryByText('配送先要確認')).not.toBeInTheDocument();
    expect(within(rowOf('nothing-left-b')).queryByText('配送先要確認')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送済みにする' })).not.toBeInTheDocument();
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

  it('取消済みや配送中の注文には、取り消せない理由を出さない', () => {
    render(
      <OrderSection
        orders={[
          { ...paidOrder, id: 'cancelled-order', status: 'キャンセル', orderStatus: 'cancelled', canRefund: false, canShip: false, canCancel: false },
          { ...paidOrder, id: 'shipped-order', status: '配送中', orderStatus: 'shipped', canShip: false, canCancel: false },
        ]}
        onCancelOrder={jest.fn()}
      />,
    );

    expect(screen.queryByText('支払いの状態を確かめられないため、今は取り消せません')).not.toBeInTheDocument();
    expect(screen.queryByText(/払込票の期限切れが確定するまで取り消せません/)).not.toBeInTheDocument();
  });

  it('放棄の印は、灰色の背景に読める文字色（#474747）で出す', () => {
    render(<OrderSection orders={[{ ...paidOrder, status: '放棄', orderStatus: 'abandoned', canRefund: false, canShip: false }]} />);

    const badge = screen.getByText('放棄');
    expect(badge).toHaveClass('bg-gray-100', 'text-[#474747]');
    expect(badge).not.toHaveClass('text-gray-500');
  });

  it('支払い手続き中の注文も取り消せる', () => {
    const onCancelOrder = jest.fn();
    render(
      <OrderSection
        orders={[{ ...pendingOrder, id: 'in-progress', status: '支払い手続き中', orderStatus: 'payment_in_progress' }]}
        onCancelOrder={onCancelOrder}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onCancelOrder).toHaveBeenCalledWith('in-progress');
  });

  it('どの注文にも「履歴」を出し、押すと注文の番号を渡す', () => {
    const onShowHistory = jest.fn();

    render(<OrderSection orders={[paidOrder, pendingOrder]} onShowHistory={onShowHistory} />);

    const buttons = screen.getAllByRole('button', { name: /の履歴$/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent('履歴');
    fireEvent.click(buttons[1]);
    expect(onShowHistory).toHaveBeenCalledWith('pending-order');
  });
});

describe('OrderSection の注文の言葉と印', () => {
  it.each<[OrderStatus, string, string]>([
    ['未決済', 'bg-red-100 text-red-800', 'warning'],
    ['受注生産中', 'bg-blue-100 text-blue-800', 'positive'],
    ['発送準備中', 'bg-yellow-100 text-yellow-800', 'positive'],
    ['配送中', 'bg-green-100 text-green-800', 'positive'],
    ['配達済み', 'bg-green-100 text-green-800', 'positive'],
    ['決済失敗', 'bg-orange-100 text-orange-800', 'danger'],
    ['キャンセル', 'bg-gray-100 text-gray-500', 'danger'],
  ])('「%s」の印は %s の色で、tone は %s', (status, classes, tone) => {
    render(<OrderSection orders={[{ ...paidOrder, status }]} />);

    const badge = screen.getByText(status, { selector: 'span' });
    expect(badge).toHaveClass(...classes.split(' '));
    expect(badge).toHaveAttribute('data-ui-badge-tone', tone);
  });

  it('一部を発送した注文には、言葉の隣に「一部発送済み」の印を出す', () => {
    render(
      <OrderSection
        orders={[
          { ...inProductionOrder, id: 'partial', partiallyShipped: true },
          { ...paidOrder, id: 'plain' },
        ]}
      />,
    );

    expect(screen.getAllByText('一部発送済み')).toHaveLength(1);
    const rows = screen.getAllByRole('row');
    expect(within(rows.find((row) => row.textContent?.includes('partial')) as HTMLElement).getByText('一部発送済み')).toBeInTheDocument();
  });

  it('購入商品は「名前（色 / サイズ）×数」と、0でない数だけを括弧に出す', () => {
    render(
      <OrderSection
        orders={[
          {
            ...paidOrder,
            items: [
              line({ id: 'line-a', quantity: 2, inProduction: 1, readyUnshipped: 0, shipped: 1 }),
              line({ id: 'line-b', name: 'ウールパンツ', color: null, size: '2', quantity: 3, readyUnshipped: 3 }),
              line({ id: 'line-c', name: 'ストール', color: null, size: null, quantity: 1, readyUnshipped: 0, shipped: 0 }),
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText('シルクブラウス（白 / M）×2（受注生産中 1・発送済み 1）')).toBeInTheDocument();
    expect(screen.getByText('ウールパンツ（2）×3（発送準備中 3）')).toBeInTheDocument();
    expect(screen.getByText('ストール×1')).toBeInTheDocument();
  });

  it('受注生産中・発送準備中・発送済みが全部ある商品は、手前の段階から順に並べる', () => {
    render(
      <OrderSection
        orders={[{ ...paidOrder, items: [line({ quantity: 6, inProduction: 1, readyUnshipped: 2, shipped: 3 })] }]}
      />,
    );

    expect(screen.getByText('シルクブラウス（白 / M）×6（受注生産中 1・発送準備中 2・発送済み 3）')).toBeInTheDocument();
  });

  it('同じ名前の商品が色違いで並んでも、商品の番号で区別し、key の警告を出さない', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <OrderSection
          orders={[
            {
              ...paidOrder,
              items: [line({ id: 'line-white', color: '白' }), line({ id: 'line-black', color: '黒' })],
            },
          ]}
        />,
      );

      expect(screen.getByText('シルクブラウス（白 / M）×1（発送準備中 1）')).toBeInTheDocument();
      expect(screen.getByText('シルクブラウス（黒 / M）×1（発送準備中 1）')).toBeInTheDocument();
      expect(error.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });
});

describe('OrderSection の仕上がりと発送のボタン', () => {
  it('受注生産中の数がある注文には「仕上がりを記録する」を出し、押すと注文の番号を渡す', () => {
    const onRecordCompletion = jest.fn();

    render(<OrderSection orders={[inProductionOrder, paidOrder]} onRecordCompletion={onRecordCompletion} />);

    const buttons = screen.getAllByRole('button', { name: '仕上がりを記録する' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onRecordCompletion).toHaveBeenCalledWith('in-production-order');
  });

  it('仕上がりを記録できない注文や、押した時の処理が無い一覧には「仕上がりを記録する」を出さない', () => {
    const { rerender } = render(<OrderSection orders={[inProductionOrder]} />);
    expect(screen.queryByRole('button', { name: '仕上がりを記録する' })).not.toBeInTheDocument();

    rerender(<OrderSection orders={[{ ...inProductionOrder, canRecordCompletion: false }]} onRecordCompletion={jest.fn()} />);
    expect(screen.queryByRole('button', { name: '仕上がりを記録する' })).not.toBeInTheDocument();
  });

  it('「発送済みにする」は言葉ではなく canShip で決める（受注生産中の言葉の注文にも出る。配送中の注文には出ない）', () => {
    const onShipOrder = jest.fn();

    render(
      <OrderSection
        orders={[
          { ...inProductionOrder, canShip: true },
          { ...paidOrder, id: 'shipped-order', status: '配送中', orderStatus: 'shipped', canShip: false },
        ]}
        onShipOrder={onShipOrder}
      />,
    );

    const buttons = screen.getAllByRole('button', { name: '発送済みにする' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onShipOrder).toHaveBeenCalledWith('in-production-order');
  });

  it('処理中の注文のボタンは押せず「処理中...」と出す', () => {
    render(
      <OrderSection
        orders={[{ ...inProductionOrder, canShip: true }]}
        onShipOrder={jest.fn()}
        onRecordCompletion={jest.fn()}
        processingOrderIds={['in-production-order']}
      />,
    );

    expect(screen.getAllByRole('button', { name: '処理中...' })).toHaveLength(2);
    for (const button of screen.getAllByRole('button', { name: '処理中...' })) {
      expect(button).toBeDisabled();
    }
  });
});
