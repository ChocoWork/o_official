import { fireEvent, render, screen, within } from '@testing-library/react';
import AttentionInbox from '@/components/AttentionInbox';
import type { OrderAttention } from '@/lib/orders/order-payment-types';

const ATTENTION: OrderAttention = {
  exceptions: [
    {
      id: 'exception-1',
      reason: 'order_not_creatable',
      reasonLabel: '注文を作れない支払い',
      detail: 'item_unavailable',
      orderId: null,
      orderNumber: null,
      orderStatus: null,
      paymentRef: 'cs_test_1',
      firstDetectedAt: '2026-09-27T01:00:00.000Z',
      lastDetectedAt: '2026-09-27T01:00:00.000Z',
      detectionCount: 1,
      canCancelOrder: false,
      canRetryRefund: false,
      refundFailure: null,
    },
    {
      id: 'exception-2',
      reason: 'unexpected_state',
      reasonLabel: '想定外の支払い状態',
      detail: null,
      orderId: 'a1b2c3d4-1111-2222-8333-444455556666',
      orderNumber: 'ORD-A1B2C3D4',
      orderStatus: 'payment_in_progress',
      paymentRef: 'cs_test_2',
      firstDetectedAt: '2026-09-27T02:00:00.000Z',
      lastDetectedAt: '2026-09-27T02:00:00.000Z',
      detectionCount: 1,
      canCancelOrder: true,
      canRetryRefund: false,
      refundFailure: null,
    },
  ],
  reviews: [
    {
      orderId: 'b1b2c3d4-1111-2222-8333-444455556666',
      orderNumber: 'ORD-B1B2C3D4',
      orderStatus: 'paid',
      reviewReason: 'stock_not_reserved',
      reviewReasonLabel: '在庫を確保できなかった注文',
      reviewMarkedAt: '2026-09-27T03:00:00.000Z',
    },
  ],
  counts: { exceptions: 2, reviews: 1 },
};

/** 返金の失敗の要対応。1つ目は返せる額が残っていて（もう一度返金できる）、確保し直せなかった商品がある。2つ目は返せる額が残っていない */
const REFUND_FAILED_ATTENTION: OrderAttention = {
  exceptions: [
    {
      id: 'exception-refund',
      reason: 'refund_failed',
      reasonLabel: '返金の失敗',
      detail: 'expired_or_canceled_card',
      orderId: 'c1c2c3d4-1111-2222-8333-444455556666',
      orderNumber: 'ORD-C1C2C3D4',
      orderStatus: 'paid',
      paymentRef: 're_test_1',
      firstDetectedAt: '2026-10-11T04:00:00.000Z',
      lastDetectedAt: '2026-10-11T04:00:00.000Z',
      detectionCount: 1,
      canCancelOrder: false,
      canRetryRefund: true,
      refundFailure: {
        amount: 12800,
        failureReasonLabel: 'カードが使えません',
        shortages: [
          { name: 'シルクブラウス（白 / M）', quantity: 1 },
          { name: 'ウールコート（黒 / L）', quantity: 2 },
        ],
      },
    },
    {
      id: 'exception-refund-nothing-left',
      reason: 'refund_failed',
      reasonLabel: '返金の失敗',
      detail: null,
      orderId: 'd1d2d3d4-1111-2222-8333-444455556666',
      orderNumber: 'ORD-D1D2D3D4',
      orderStatus: 'cancelled',
      paymentRef: 're_test_2',
      firstDetectedAt: '2026-10-11T05:00:00.000Z',
      lastDetectedAt: '2026-10-11T05:00:00.000Z',
      detectionCount: 1,
      canCancelOrder: false,
      canRetryRefund: false,
      // 要対応の記録に合う返金が見つからなかった時の形（額 0・不足なし）
      refundFailure: { amount: 0, failureReasonLabel: '不明な理由', shortages: [] },
    },
  ],
  reviews: [],
  counts: { exceptions: 2, reviews: 0 },
};

/** 返品の返金の失敗の要対応（失敗した返金が返品の返金。P21）。返せる額が残っている（もう一度返金できる） */
const RETURN_REFUND_FAILED_ATTENTION: OrderAttention = {
  exceptions: [
    {
      id: 'exception-return-refund',
      reason: 'refund_failed',
      reasonLabel: '返金の失敗',
      detail: 'expired_or_canceled_card',
      orderId: 'c1c2c3d4-1111-2222-8333-444455556666',
      orderNumber: 'ORD-C1C2C3D4',
      orderStatus: 'paid',
      paymentRef: 're_test_3',
      firstDetectedAt: '2026-10-12T04:00:00.000Z',
      lastDetectedAt: '2026-10-12T04:00:00.000Z',
      detectionCount: 1,
      canCancelOrder: false,
      canRetryRefund: true,
      refundFailure: {
        amount: 8800,
        failureReasonLabel: 'カードが使えません',
        shortages: [],
        returnId: 'f1f1f1f1-1111-2222-8333-444455556666',
      },
    },
  ],
  reviews: [],
  counts: { exceptions: 1, reviews: 0 },
};

function renderInbox(attention: OrderAttention | null = ATTENTION) {
  const handlers = {
    onReview: jest.fn(), onResolve: jest.fn(), onCancelAndResolve: jest.fn(),
    onRetryRefund: jest.fn(), onRetryReturnRefund: jest.fn(),
  };
  render(<AttentionInbox attention={attention} processingIds={[]} {...handlers} />);
  return handlers;
}

describe('AttentionInbox', () => {
  it('未処理が0件なら何も出さない', () => {
    const { container } = render(
      <AttentionInbox
        attention={{ exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } }}
        processingIds={[]}
        onReview={jest.fn()}
        onResolve={jest.fn()}
        onCancelAndResolve={jest.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('要対応と要確認を件数と一緒に出す', () => {
    renderInbox();

    expect(screen.getByRole('heading', { name: '要対応 2件・要確認 1件' })).toBeInTheDocument();
    expect(screen.getByText('注文を作れない支払い')).toBeInTheDocument();
    expect(screen.getByText('在庫を確保できなかった注文（ORD-B1B2C3D4）')).toBeInTheDocument();
  });

  it('「確認済みにする」で注文 ID を渡す', () => {
    const { onReview } = renderInbox();

    fireEvent.click(screen.getByRole('button', { name: '確認済みにする' }));

    expect(onReview).toHaveBeenCalledWith('b1b2c3d4-1111-2222-8333-444455556666');
  });

  it('「解決済みにする」はメモを付けて送れる', () => {
    const { onResolve } = renderInbox();

    fireEvent.click(screen.getAllByRole('button', { name: '解決済みにする' })[0]);
    const dialog = screen.getByRole('dialog', { name: '解決済みにする' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /メモ/ }), { target: { value: 'Stripe で返金済み' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '解決する' }));

    expect(onResolve).toHaveBeenCalledWith({ exceptionId: 'exception-1', note: 'Stripe で返金済み' });
  });

  it('「解決済みにする」を開くとメモへフォーカスが移り、戻ると押したボタンへ返る', () => {
    renderInbox();
    const trigger = screen.getAllByRole('button', { name: '解決済みにする' })[0];
    trigger.focus();

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '解決済みにする' });
    expect(within(dialog).getByRole('textbox', { name: /メモ/ })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('未入金の注文が付いた要対応だけ「注文を取り消して解決」を出し、理由とメモを渡す', () => {
    const { onCancelAndResolve } = renderInbox();

    const buttons = screen.getAllByRole('button', { name: '注文を取り消して解決' });
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0]);
    const dialog = screen.getByRole('dialog', { name: '注文を取り消して解決' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '取消の理由' }), { target: { value: 'other' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /メモ/ }), { target: { value: 'Stripe に支払いが無い' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));

    expect(onCancelAndResolve).toHaveBeenCalledWith({
      exceptionId: 'exception-2',
      values: { reason: 'other', note: 'Stripe に支払いが無い', notifyCustomer: true },
    });
  });

  it('返金できる返金の失敗（canRetryRefund）にだけ「もう一度返金する」を出し、押すと注文の番号を渡す', () => {
    const { onRetryRefund } = renderInbox(REFUND_FAILED_ATTENTION);

    const buttons = screen.getAllByRole('button', { name: 'もう一度返金する' });
    expect(buttons).toHaveLength(1);
    // 返金できない方の行にも、解決済みにする操作は残る
    expect(screen.getAllByRole('button', { name: '解決済みにする' })).toHaveLength(2);

    fireEvent.click(buttons[0]);
    expect(onRetryRefund).toHaveBeenCalledTimes(1);
    expect(onRetryRefund).toHaveBeenCalledWith('c1c2c3d4-1111-2222-8333-444455556666');
  });

  it('返金の画面を開く処理を渡されていない時（返金の権限が無い人）は、返金できる行にも「もう一度返金する」を出さない', () => {
    const props = {
      attention: REFUND_FAILED_ATTENTION,
      processingIds: [],
      onReview: jest.fn(),
      onResolve: jest.fn(),
      onCancelAndResolve: jest.fn(),
    };
    const { rerender } = render(<AttentionInbox {...props} onRetryRefund={jest.fn()} />);
    expect(screen.getAllByRole('button', { name: 'もう一度返金する' })).toHaveLength(1);

    rerender(<AttentionInbox {...props} />);

    expect(screen.queryByRole('button', { name: 'もう一度返金する' })).not.toBeInTheDocument();
  });

  it('操作中の要対応では「もう一度返金する」を押せない', () => {
    const onRetryRefund = jest.fn();
    render(
      <AttentionInbox
        attention={REFUND_FAILED_ATTENTION}
        processingIds={['exception-refund']}
        onReview={jest.fn()}
        onResolve={jest.fn()}
        onCancelAndResolve={jest.fn()}
        onRetryRefund={onRetryRefund}
      />,
    );

    const button = screen.getByRole('button', { name: 'もう一度返金する' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onRetryRefund).not.toHaveBeenCalled();
  });

  it('「解決済みにする」の画面は、返金やお客様への連絡を済ませてからと案内し、Stripe ダッシュボードとは書かない', () => {
    renderInbox();

    fireEvent.click(screen.getAllByRole('button', { name: '解決済みにする' })[0]);
    const dialog = screen.getByRole('dialog', { name: '解決済みにする' });

    expect(within(dialog).getByText('返金やお客様への連絡を済ませてから、解決済みにしてください。')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('Stripe ダッシュボード');
  });

  it('返金の失敗の行に、返金額・失敗の理由・確保し直せなかった商品を出す（商品は「、」でつなぐ）', () => {
    renderInbox(REFUND_FAILED_ATTENTION);

    // 金額は formatYen の形（全角の ￥ と桁区切り）
    const row = screen.getAllByRole('listitem')[0];
    expect(row).toHaveTextContent('返金の失敗（ORD-C1C2C3D4）');
    expect(within(row).getByText('返金 ￥12,800')).toBeInTheDocument();
    expect(within(row).getByText('失敗の理由: カードが使えません')).toBeInTheDocument();
    expect(
      within(row).getByText('確保し直せなかった商品: シルクブラウス（白 / M） × 1、ウールコート（黒 / L） × 2'),
    ).toBeInTheDocument();
  });

  it('額が 0 の返金の失敗には「返金」の行を、不足が無ければ「確保し直せなかった商品」の行を出さない。失敗の理由は出す', () => {
    renderInbox(REFUND_FAILED_ATTENTION);

    const row = screen.getAllByRole('listitem')[1];
    expect(row).toHaveTextContent('返金の失敗（ORD-D1D2D3D4）');
    expect(within(row).getByText('失敗の理由: 不明な理由')).toBeInTheDocument();
    expect(row).not.toHaveTextContent('返金 ￥');
    expect(row).not.toHaveTextContent('確保し直せなかった商品');
  });

  it('返金の失敗以外の要対応（refundFailure が null）には、返金額・失敗の理由・確保し直せなかった商品の行を足さない', () => {
    renderInbox();

    const row = screen.getAllByRole('listitem')[0];
    expect(row).toHaveTextContent('注文を作れない支払い');
    expect(row).not.toHaveTextContent('返金 ￥');
    expect(row).not.toHaveTextContent('失敗の理由');
    expect(row).not.toHaveTextContent('確保し直せなかった商品');
  });
});

describe('AttentionInbox の返品の返金の失敗（グループ E-3 の P21）', () => {
  it('失敗した返金が返品の返金（refundFailure.returnId あり）の「もう一度返金する」は、返品の画面を開く処理に注文の番号を渡し、ふつうの返金の画面を開く処理は呼ばない', () => {
    const { onRetryRefund, onRetryReturnRefund } = renderInbox(RETURN_REFUND_FAILED_ATTENTION);

    fireEvent.click(screen.getByRole('button', { name: 'もう一度返金する' }));

    expect(onRetryReturnRefund).toHaveBeenCalledTimes(1);
    expect(onRetryReturnRefund).toHaveBeenCalledWith('c1c2c3d4-1111-2222-8333-444455556666');
    expect(onRetryRefund).not.toHaveBeenCalled();
  });

  it('ふつうの返金の失敗（returnId が無い・null）は、今のとおりふつうの返金の画面を開く処理を呼び、返品の画面を開く処理は呼ばない', () => {
    const { onRetryRefund, onRetryReturnRefund } = renderInbox(REFUND_FAILED_ATTENTION);

    fireEvent.click(screen.getByRole('button', { name: 'もう一度返金する' }));

    expect(onRetryRefund).toHaveBeenCalledWith('c1c2c3d4-1111-2222-8333-444455556666');
    expect(onRetryReturnRefund).not.toHaveBeenCalled();
  });

  it('返品の画面を開く処理を渡されていない時は、返品の返金の失敗に「もう一度返金する」を出さない（ふつうの返金の画面を開く処理があっても、返品の返金は開かない）', () => {
    const props = {
      attention: RETURN_REFUND_FAILED_ATTENTION,
      processingIds: [],
      onReview: jest.fn(),
      onResolve: jest.fn(),
      onCancelAndResolve: jest.fn(),
    };
    const { rerender } = render(<AttentionInbox {...props} onRetryRefund={jest.fn()} onRetryReturnRefund={jest.fn()} />);
    expect(screen.getAllByRole('button', { name: 'もう一度返金する' })).toHaveLength(1);

    rerender(<AttentionInbox {...props} onRetryRefund={jest.fn()} />);

    expect(screen.queryByRole('button', { name: 'もう一度返金する' })).not.toBeInTheDocument();
  });

  it('操作中の返品の返金の失敗では「もう一度返金する」を押せない', () => {
    const onRetryReturnRefund = jest.fn();
    render(
      <AttentionInbox
        attention={RETURN_REFUND_FAILED_ATTENTION}
        processingIds={['exception-return-refund']}
        onReview={jest.fn()}
        onResolve={jest.fn()}
        onCancelAndResolve={jest.fn()}
        onRetryRefund={jest.fn()}
        onRetryReturnRefund={onRetryReturnRefund}
      />,
    );

    const button = screen.getByRole('button', { name: 'もう一度返金する' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onRetryReturnRefund).not.toHaveBeenCalled();
  });
});
