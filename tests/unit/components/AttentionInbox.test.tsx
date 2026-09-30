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

function renderInbox(attention: OrderAttention | null = ATTENTION) {
  const handlers = { onReview: jest.fn(), onResolve: jest.fn(), onCancelAndResolve: jest.fn() };
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
});
