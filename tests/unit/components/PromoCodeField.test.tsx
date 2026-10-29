import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PromoCodeField, type PromoCodeFieldProps } from '@/app/checkout/_components/PromoCodeField';
import { BETTER_DISCOUNT_MESSAGE, GUEST_DISCOUNT_REFUSAL_MESSAGE } from '@/lib/discounts/discount-messages';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));

function renderField(overrides: Partial<PromoCodeFieldProps> = {}) {
  const props: PromoCodeFieldProps = {
    codes: [], onApply: jest.fn().mockResolvedValue(undefined), onRemove: jest.fn().mockResolvedValue(undefined),
    error: null, busy: false, unusedCodes: [], buyerKind: 'member', ...overrides,
  };
  return { props, ...render(<PromoCodeField {...props} />) };
}

// 親の状態（codes / error / busy）を持ち、通信の結果で入力欄の挙動を確かめる
function Harness({ settle, buyerKind = 'member' as const }: { settle: (code: string) => Promise<string | null>; buyerKind?: 'member' | 'guest' }) {
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onApply = async (code: string) => {
    setError(null);
    setBusy(true);
    const message = await settle(code);
    if (message === null) setCodes((current) => [...current, code.toUpperCase()]);
    else setError(message);
    setBusy(false);
  };
  return <PromoCodeField codes={codes} onApply={onApply} onRemove={async () => undefined} error={error} busy={busy} unusedCodes={[]} buyerKind={buyerKind} />;
}

describe('PromoCodeField（入力画面の割引コード）', () => {
  test('FREQ-550-AC-01: 入力して「適用」で親に渡す（前後の空白は除く）', async () => {
    const { props } = renderField();

    fireEvent.change(screen.getByLabelText('プロモーションコード'), { target: { value: ' welcome10 ' } });
    fireEvent.click(screen.getByRole('button', { name: '適用' }));

    await waitFor(() => expect(props.onApply).toHaveBeenCalledWith('welcome10'));
    expect(screen.getByPlaceholderText('コードを入力')).toBeInTheDocument();
  });

  test('FREQ-550-AC-01: ５コードを削除と内訳と未採用文で操作でき最終画面では変更できない', () => {
    const { props } = renderField({ codes: ['A1', 'B2', 'C3', 'D4', 'E5'], unusedCodes: ['B2'] });

    for (const code of ['A1', 'B2', 'C3', 'D4', 'E5']) {
      expect(screen.getByRole('button', { name: `${code}を削除` })).toHaveTextContent('削除');
    }
    expect(screen.getByText('コードは5つまで入力できます。')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '適用' })).toBeNull();
    expect(screen.getByText(`B2：${BETTER_DISCOUNT_MESSAGE}`)).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(BETTER_DISCOUNT_MESSAGE))).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'C3を削除' }));
    expect(props.onRemove).toHaveBeenCalledTimes(1);
    expect(props.onRemove).toHaveBeenCalledWith('C3');
  });

  test('FREQ-550-AC-01: 確認の通信中は適用も削除も押せない', () => {
    renderField({ codes: ['A1'], busy: true });

    expect(screen.getByRole('button', { name: 'A1を削除' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('プロモーションコード'), { target: { value: 'X' } });
    expect(screen.getByRole('button', { name: '適用' })).toBeDisabled();
  });

  test('FREQ-550-AC-02: 通ったら欄を空にし、通らなければ入力を残して理由を結び付け、欄へフォーカスを戻す', async () => {
    const settle = jest.fn().mockResolvedValueOnce('このコードは使えません').mockResolvedValueOnce(null);
    render(<Harness settle={settle} />);
    const input = screen.getByLabelText('プロモーションコード');

    fireEvent.change(input, { target: { value: 'BAD10' } });
    fireEvent.click(screen.getByRole('button', { name: '適用' }));

    await waitFor(() => expect(input).toHaveAccessibleDescription('このコードは使えません'));
    expect(input).toHaveValue('BAD10');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'good10' } });
    fireEvent.click(screen.getByRole('button', { name: '適用' }));

    expect(await screen.findByRole('button', { name: 'GOOD10を削除' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('プロモーションコード')).toHaveValue(''));
    expect(screen.getByLabelText('プロモーションコード')).not.toHaveAttribute('aria-invalid');
  });

  test('FREQ-550-AC-02: 理由の入れ物は理由が無い間も常設のalertとして置く', () => {
    const { rerender, props } = renderField();
    const region = screen.getByRole('alert');
    expect(region).toBeEmptyDOMElement();

    rerender(<PromoCodeField {...props} error="このコードは使えません" />);
    expect(screen.getByRole('alert')).toBe(region);
    expect(region).toHaveTextContent('このコードは使えません');
    expect(screen.getByLabelText('プロモーションコード')).toHaveAccessibleDescription('このコードは使えません');
  });

  test('FREQ-550-AC-02: ゲストの全拒否は同じ文と、コードやメールを含まないログインのリンクを出す', () => {
    renderField({ buyerKind: 'guest', error: GUEST_DISCOUNT_REFUSAL_MESSAGE, defaultCode: 'SECRET10' });

    expect(screen.getByLabelText('プロモーションコード')).toHaveAccessibleDescription(GUEST_DISCOUNT_REFUSAL_MESSAGE);
    const link = screen.getByRole('link', { name: 'ログインして割引を確かめる' });
    expect(link).toHaveAttribute('href', '/login?next=%2Fcheckout');
    expect(link.getAttribute('href')).not.toMatch(/SECRET10|@/);
  });

  test.each([
    ['会員に同じ文', { buyerKind: 'member' as const, error: GUEST_DISCOUNT_REFUSAL_MESSAGE }],
    ['ゲストの別の失敗', { buyerKind: 'guest' as const, error: '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。' }],
    ['ゲストでエラーなし', { buyerKind: 'guest' as const, error: null }],
  ])('FREQ-550-AC-02: ログインのリンクは出さない（%s）', (_label, overrides) => {
    renderField(overrides);
    expect(screen.queryByRole('link', { name: 'ログインして割引を確かめる' })).toBeNull();
  });

  test('FREQ-550-AC-02: 復元したコードを初めの入力値にして、使えない理由を欄の下へ出す', () => {
    renderField({ error: 'このコードは使えません', defaultCode: 'OLD10' });

    const input = screen.getByLabelText('プロモーションコード');
    expect(input).toHaveValue('OLD10');
    expect(input).toHaveAccessibleDescription('このコードは使えません');
    fireEvent.change(input, { target: { value: 'NEW10' } });
    expect(input).toHaveValue('NEW10');
  });

  test('FREQ-550-AC-01: 親が通信中にしないまま返った適用は、次の通信を取り違えない', async () => {
    const onApply = jest.fn().mockResolvedValue(undefined);
    const { props, rerender } = renderField({ onApply });
    fireEvent.change(screen.getByLabelText('プロモーションコード'), { target: { value: 'X1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '適用' })); });

    rerender(<PromoCodeField {...props} busy />);
    rerender(<PromoCodeField {...props} busy={false} />);

    expect(screen.getByLabelText('プロモーションコード')).toHaveValue('X1');
  });
});
