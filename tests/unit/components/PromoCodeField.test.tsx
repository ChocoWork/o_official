import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PromoCodeField } from '@/app/checkout/_components/PromoCodeField';

describe('PromoCodeField（入力画面の割引コード）', () => {
  test('入力して「適用」で親に渡し、適用できたら欄を空にする', async () => {
    const onApply = jest.fn().mockResolvedValue(true);
    render(<PromoCodeField applied={null} error={null} onApply={onApply} onRemove={jest.fn()} />);

    const input = screen.getByLabelText('プロモーションコード');
    fireEvent.change(input, { target: { value: ' welcome10 ' } });
    fireEvent.click(screen.getByRole('button', { name: '適用' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledWith('welcome10'));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  test('理由は入力欄に結び付けて読み上げ、欄を誤りの状態にする（FREQ-374）', () => {
    render(<PromoCodeField applied={null} error="このコードは使えません" onApply={jest.fn()} onRemove={jest.fn()} />);

    const input = screen.getByLabelText('プロモーションコード');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('このコードは使えません');
  });

  test('復元したコードを初めの入力値にして、使えない理由を欄の下へ出す', () => {
    render(<PromoCodeField applied={null} error="このコードは使えません" defaultCode="OLD10" onApply={jest.fn()} onRemove={jest.fn()} />);
    const input = screen.getByLabelText('プロモーションコード');
    expect(input).toHaveValue('OLD10');
    expect(input).toHaveAccessibleDescription('このコードは使えません');
    fireEvent.change(input, { target: { value: 'NEW10' } });
    expect(input).toHaveValue('NEW10');
  });

  test('適用済みならコードと「削除」を出す', () => {
    const onRemove = jest.fn();
    render(
      <PromoCodeField
        applied={{ code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 }}
        error={null}
        onApply={jest.fn()}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText('WELCOME10')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(onRemove).toHaveBeenCalled();
  });
});
