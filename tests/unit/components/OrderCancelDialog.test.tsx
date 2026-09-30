import { fireEvent, render, screen } from '@testing-library/react';
import OrderCancelDialog from '@/components/OrderCancelDialog';

/**
 * 取消の画面（設計書 5-2。Shopify の取消画面に合わせる）。
 * 理由は必須。メモは「その他」と要対応の解決で必須。お知らせは既定でオン、外せる。
 */
function renderDialog(overrides: Partial<Parameters<typeof OrderCancelDialog>[0]> = {}) {
  const onSubmit = jest.fn();
  render(
    <OrderCancelDialog
      open
      title="注文を取り消す"
      targetLabel="ORD-A1B2C3D4"
      showNotifyOption
      noteRequired={false}
      submitting={false}
      onClose={jest.fn()}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onSubmit };
}

describe('OrderCancelDialog', () => {
  it('理由を選ぶまで「取り消す」を押せない', () => {
    renderDialog();

    const submit = screen.getByRole('button', { name: '取り消す' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });
    expect(submit).toBeEnabled();
  });

  it('お知らせは既定でオンで、外すと notifyCustomer=false で送る', () => {
    const { onSubmit } = renderDialog();

    const notify = screen.getByRole('checkbox', { name: 'お客様に取消のお知らせを送る' });
    expect(notify).toBeChecked();

    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'stock_unavailable' } });
    fireEvent.click(notify);
    fireEvent.change(screen.getByRole('textbox', { name: /メモ/ }), { target: { value: '  在庫を確認した  ' } });
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));

    expect(onSubmit).toHaveBeenCalledWith({ reason: 'stock_unavailable', note: '在庫を確認した', notifyCustomer: false });
  });

  it('「その他」はメモが要る', () => {
    renderDialog();

    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'other' } });
    expect(screen.getByRole('button', { name: '取り消す' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'メモ（必須・店内のみ）' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /メモ/ }), { target: { value: '電話で依頼' } });
    expect(screen.getByRole('button', { name: '取り消す' })).toBeEnabled();
  });

  it('要対応の解決では、理由に関係なくメモが要る', () => {
    renderDialog({ noteRequired: true, title: '注文を取り消して解決' });

    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'suspected_fraud' } });

    expect(screen.getByRole('button', { name: '取り消す' })).toBeDisabled();
  });

  it('失敗の注文の取消ではお知らせの選択肢を出さず、notifyCustomer=false で送る', () => {
    const { onSubmit } = renderDialog({ showNotifyOption: false });

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));

    expect(onSubmit).toHaveBeenCalledWith({ reason: 'customer_request', note: '', notifyCustomer: false });
  });

  it('処理中は押せない', () => {
    renderDialog({ submitting: true });

    fireEvent.change(screen.getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });

    expect(screen.getByRole('button', { name: '処理中...' })).toBeDisabled();
  });

  it('開くと取消の理由へフォーカスが移る', () => {
    renderDialog();

    expect(screen.getByRole('combobox', { name: '取消の理由' })).toHaveFocus();
  });

  it('Escape で onClose を呼ぶ', () => {
    const onClose = jest.fn();
    renderDialog({ onClose });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
