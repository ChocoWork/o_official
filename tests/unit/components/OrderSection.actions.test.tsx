import { fireEvent, render, screen, within } from '@testing-library/react';
import OrderSection, { type OrderItem, type OrderLineItem, type OrderStatus } from '@/components/OrderSection';
import { ORDER_PROGRESS_LABELS, PARTIALLY_SHIPPED_LABEL } from '@/lib/orders/order-progress';
import { PAYMENT_STATUS_LABELS, REFUND_FAILED_BADGE, REFUND_PENDING_BADGE, type PaymentStatusKey } from '@/lib/orders/payment-status';

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
  it('キャンセルは canCancel の注文に出る（未入金の注文も、支払い済みで1つも発送していない注文も）。出ない注文には出さない', () => {
    const onCancelOrder = jest.fn();

    render(
      <OrderSection
        orders={[
          { ...paidOrder, id: 'paid-cancellable', canCancel: true, cancelKind: 'paid' },
          { ...paidOrder, id: 'shipped-order', status: '配送中', orderStatus: 'shipped', canShip: false, canCancel: false, cancelKind: null },
          { ...pendingOrder, cancelKind: 'unpaid' },
        ]}
        onCancelOrder={onCancelOrder}
        onRefundOrder={jest.fn()}
        onShipOrder={jest.fn()}
      />,
    );

    const cancelButtons = screen.getAllByRole('button', { name: 'キャンセル' });
    expect(cancelButtons).toHaveLength(2);

    fireEvent.click(cancelButtons[0]);
    fireEvent.click(cancelButtons[1]);
    expect(onCancelOrder).toHaveBeenNthCalledWith(1, 'paid-cancellable');
    expect(onCancelOrder).toHaveBeenNthCalledWith(2, 'pending-order');
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
    ['キャンセルの手続き中', 'bg-gray-100 text-[#474747]', 'warning'],
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

/** 注文の行（注文ID の文字で探す）。一覧の行の中だけを調べるため */
function orderRowOf(id: string): HTMLElement {
  const row = screen.getAllByRole('row').find((candidate) => candidate.textContent?.includes(id));
  if (!row) throw new Error(`行が見つかりません: ${id}`);
  return row;
}

describe('OrderSection の列の見出し', () => {
  it('「支払い」「進み具合」の順に並び、「決済状況」は無い', () => {
    render(<OrderSection orders={[paidOrder]} />);

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      '注文ID', '顧客名', '注文日', '購入商品', '商品数', '合計金額', '支払い', '進み具合', '操作',
    ]);
    expect(screen.queryByRole('columnheader', { name: '決済状況' })).not.toBeInTheDocument();
  });
});

describe('OrderSection の支払いの列と返金の印', () => {
  it.each<[PaymentStatusKey, string, string, string]>([
    ['unpaid', '未入金', 'bg-red-100 text-red-800', 'warning'],
    ['failed', '支払いの失敗', 'bg-orange-100 text-orange-800', 'danger'],
    ['none', '支払いなし', 'bg-gray-100 text-[#474747]', 'neutral'],
    ['paid', '支払い済み', 'bg-green-100 text-green-800', 'positive'],
    ['partially_refunded', '一部返金', 'bg-yellow-100 text-yellow-800', 'warning'],
    ['refunded', '返金済み', 'bg-gray-100 text-[#474747]', 'neutral'],
  ])('支払いの記号 %s は「%s」と出し、印は %s の色で、tone は %s', (key, word, classes, tone) => {
    render(<OrderSection orders={[{ ...paidOrder, paymentStatusKey: key }]} />);

    const badge = screen.getByText(word, { selector: 'span' });
    expect(badge).toHaveClass(...classes.split(' '));
    expect(badge).toHaveAttribute('data-ui-badge-tone', tone);
  });

  it('返事待ち・保留の返金がある注文に「返金の手続き中」、開いている返金の失敗がある注文に「返金の失敗」の小さな印を出す。無い注文には出さない', () => {
    render(
      <OrderSection
        orders={[
          { ...paidOrder, id: 'refund-pending', paymentStatusKey: 'paid', refundPending: true },
          { ...paidOrder, id: 'refund-failed', paymentStatusKey: 'paid', refundFailed: true },
          { ...paidOrder, id: 'refund-plain', paymentStatusKey: 'paid' },
        ]}
      />,
    );

    expect(screen.getAllByText('返金の手続き中')).toHaveLength(1);
    expect(screen.getAllByText('返金の失敗')).toHaveLength(1);
    expect(within(orderRowOf('refund-pending')).getByText('返金の手続き中')).toBeInTheDocument();
    expect(within(orderRowOf('refund-pending')).queryByText('返金の失敗')).not.toBeInTheDocument();
    expect(within(orderRowOf('refund-failed')).getByText('返金の失敗')).toBeInTheDocument();
    expect(within(orderRowOf('refund-failed')).queryByText('返金の手続き中')).not.toBeInTheDocument();
    expect(within(orderRowOf('refund-plain')).queryByText('返金の手続き中')).not.toBeInTheDocument();
    expect(within(orderRowOf('refund-plain')).queryByText('返金の失敗')).not.toBeInTheDocument();
  });

  it('支払いの言葉は、進み具合の言葉・行の小さな印・操作のボタンの字と1つも同じにならない（行の中の言葉を exact で探す E2E が、支払いの列を足しても1つに決まるように）', () => {
    const paymentWords: string[] = Object.values(PAYMENT_STATUS_LABELS);
    const otherWords: string[] = [
      ...Object.values(ORDER_PROGRESS_LABELS),
      PARTIALLY_SHIPPED_LABEL,
      '要確認',
      REFUND_PENDING_BADGE,
      REFUND_FAILED_BADGE,
      '履歴',
      '返金',
      'キャンセル',
      '発送済みにする',
      '仕上がりを記録する',
    ];

    expect(paymentWords).toHaveLength(6);
    expect(paymentWords.filter((word) => otherWords.includes(word))).toEqual([]);
  });

  it('「返金」は canRefund の注文だけに出し、押すと注文の番号を渡す。返金の手続き中の印があっても、canRefund が true なら出す', () => {
    const onRefundOrder = jest.fn();

    render(
      <OrderSection
        orders={[
          { ...paidOrder, id: 'refundable', canRefund: true },
          { ...paidOrder, id: 'refundable-while-pending', canRefund: true, refundPending: true },
          { ...paidOrder, id: 'nothing-left', canRefund: false },
        ]}
        onRefundOrder={onRefundOrder}
      />,
    );

    // 出すかどうかは窓口が決めた canRefund だけで決める（返せる額が残っていれば、返事待ち・保留の返金があっても出る）
    const buttons = screen.getAllByRole('button', { name: '返金' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(onRefundOrder).toHaveBeenCalledWith('refundable-while-pending');
    expect(within(orderRowOf('nothing-left')).queryByRole('button', { name: '返金' })).not.toBeInTheDocument();
  });
});
