import { fireEvent, render, screen } from '@testing-library/react';
import { ReturnRefundFields } from '@/components/ReturnDialogParts';

type FieldsProps = Parameters<typeof ReturnRefundFields>[0];

function renderFields(overrides: Partial<FieldsProps> = {}) {
  const onAmountChange = jest.fn();
  const onShippingChange = jest.fn();
  const props: FieldsProps = {
    idPrefix: 'parts',
    rows: [['商品', '￥17,000'], ['返金額', '￥15,800']],
    amount: 15800,
    refundableAmount: 54800,
    onAmountChange,
    shippingAmount: 500,
    refundableShipping: 800,
    onShippingChange,
    disabled: false,
    ...overrides,
  };
  render(<ReturnRefundFields {...props} />);
  return { onAmountChange, onShippingChange };
}

describe('ReturnRefundFields（返金の内訳と額・送料の入力）', () => {
  it('DD-ADMIN-019 上限を省くと、従来の「返金額（返せる額: X）」と max=返せる額のまま。超えた額は返せる額に丸める', () => {
    const { onAmountChange } = renderFields();
    const amount = screen.getByLabelText('返金額（返せる額: ￥54,800）');

    expect(amount).toHaveAttribute('max', '54800');
    expect(amount).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(/^上限 /)).not.toBeInTheDocument();
    fireEvent.change(amount, { target: { value: '99999' } });
    expect(onAmountChange).toHaveBeenLastCalledWith(54800);
  });

  it('DD-ADMIN-019 受け取りの上限を渡すと、見出し「返金額」と別に「上限 ￥X」を出し、max は上限。超えた額は丸めずに渡す', () => {
    const { onAmountChange } = renderFields({
      amountCap: 17500, amountCapLabel: '上限 ￥17,500', preserveAmountOverMax: true,
    });
    const amount = screen.getByRole('spinbutton', { name: '返金額' });

    expect(screen.getByText('上限 ￥17,500')).toBeVisible();
    expect(amount).toHaveAttribute('max', '17500');
    expect(amount).toHaveAttribute('aria-describedby', expect.stringContaining('parts-amount-cap'));
    fireEvent.change(amount, { target: { value: '17501' } });
    expect(onAmountChange).toHaveBeenLastCalledWith(17501);
    // 送料の入力は従来のまま
    expect(screen.getByRole('spinbutton', { name: '送料（返せる送料: ￥800）' })).toHaveAttribute('max', '800');
  });

  it('DD-ADMIN-019 誤りの文は aria-invalid と aria-describedby で額の入力に結ぶ', () => {
    renderFields({
      amount: 17501, amountCap: 17500, amountCapLabel: '上限 ￥17,500', preserveAmountOverMax: true,
      amountError: '上限を超えています。',
    });
    const amount = screen.getByRole('spinbutton', { name: '返金額' });
    const error = screen.getByText('上限を超えています。');

    expect(amount).toHaveValue(17501);
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(amount.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
    expect(amount).toHaveAccessibleDescription(expect.stringContaining('上限を超えています。'));
  });
});
