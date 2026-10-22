import React, { StrictMode, useLayoutEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ContactPage from '@/app/contact/page';

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const orderNumberLabel = /注文番号（任意）$/;

function readUnrelatedFields() {
  return {
    name: screen.getByLabelText<HTMLInputElement>(/^NAME \/ お名前/).value,
    email: screen.getByLabelText<HTMLInputElement>(/^EMAIL \/ メールアドレス/).value,
    subject: screen.getByLabelText<HTMLInputElement>(/^SUBJECT \/ 件名/).value,
    message: screen.getByLabelText<HTMLTextAreaElement>(/^MESSAGE \/ メッセージ/).value,
  };
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/^NAME \/ お名前/), { target: { value: 'テスト太郎' } });
  fireEvent.change(screen.getByLabelText(/^EMAIL \/ メールアドレス/), { target: { value: 'tester@example.com' } });
  fireEvent.change(screen.getByLabelText(/^SUBJECT \/ 件名/), { target: { value: '手入力の件名' } });
  fireEvent.change(screen.getByLabelText(/^MESSAGE \/ メッセージ/), { target: { value: '手入力の本文' } });
}

function selectInquiry(label: string) {
  fireEvent.click(screen.getByRole('combobox', { name: 'お問い合わせ内容' }));
  fireEvent.click(screen.getByRole('option', { name: label }));
}

// 初回の passive effect より先に入力された場合も、実際の入力イベントで確かめる。
function EditBeforePrefill() {
  useLayoutEffect(() => {
    const field = screen.getByLabelText(orderNumberLabel);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('入力欄の value setter がありません');
    // render の act 内なので、ネイティブイベントを送り act の入れ子を避ける。
    setValue.call(field, 'ORD-11112222');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, []);
  return <ContactPage />;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/contact');
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, '', '/contact');
});

test('フォームを入力済みで開き後の編集を上書きしない', () => {
  window.history.replaceState({}, '', '/contact?type=order&order=ord-a1b2c3d4');
  const { rerender } = render(<StrictMode><ContactPage /></StrictMode>);

  expect(screen.getByLabelText(orderNumberLabel)).toHaveValue('ORD-A1B2C3D4');
  expect(screen.getByRole('combobox', { name: 'お問い合わせ内容' })).toHaveTextContent('ご注文について');

  fireEvent.change(screen.getByLabelText(orderNumberLabel), { target: { value: 'ORD-11112222' } });
  selectInquiry('その他');
  window.history.replaceState({}, '', '/contact?type=product&order=ORD-99999999');
  rerender(<StrictMode><ContactPage /></StrictMode>);

  const numberAfterRerender = screen.getByLabelText<HTMLInputElement>(orderNumberLabel).value;
  expect(numberAfterRerender).toBe('ORD-11112222');
  expect(screen.getByRole('combobox', { name: 'お問い合わせ内容' })).toHaveTextContent('その他');
  fireEvent.change(screen.getByLabelText(orderNumberLabel), { target: { value: '' } });
  rerender(<StrictMode><ContactPage /></StrictMode>);
  expect(screen.getByLabelText(orderNumberLabel)).toHaveValue('');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('URL無しのフォームと送信の本文は従来どおり', async () => {
  render(<ContactPage />);

  const previousEmptyFields = { name: '', email: '', subject: '', message: '' };
  const unrelatedFields = readUnrelatedFields();
  expect(unrelatedFields).toEqual(previousEmptyFields);
  expect(screen.getByLabelText(orderNumberLabel)).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'お問い合わせ内容' })).toHaveTextContent('選択してください');
  expect(screen.getByRole('button', { name: 'SEND MESSAGE' })).toBeDisabled();

  fillRequiredFields();
  selectInquiry('ご注文について');
  fireEvent.change(screen.getByLabelText(orderNumberLabel), { target: { value: 'ORD-11112222' } });
  fireEvent.click(screen.getByRole('button', { name: 'SEND MESSAGE' }));

  await screen.findByRole('dialog', { name: 'お問い合わせありがとうございます' });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch).toHaveBeenCalledWith('/api/contact', expect.objectContaining({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }));
  const submitted = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body));
  expect(submitted.orderNumber).toBe('ORD-11112222');
  expect(submitted).toEqual({
    name: 'テスト太郎', email: 'tester@example.com', inquiryType: 'order',
    subject: '手入力の件名', orderNumber: 'ORD-11112222', message: '手入力の本文', website: '',
  });
});

test.each([
  ['product', '商品について'],
  ['other', 'その他'],
])('%s のURLでも種別を入力済みで開く', (type, label) => {
  window.history.replaceState({}, '', `/contact?type=${type}`);
  render(<ContactPage />);
  expect(screen.getByRole('combobox', { name: 'お問い合わせ内容' })).toHaveTextContent(label);
  expect(screen.getByLabelText(orderNumberLabel)).toHaveValue('');
});

test.each([
  '?type=unknown&order=ORD-ZZZZZZZZ',
  '?type=order&type=other&order=ORD-A1B2C3D4&order=ORD-11112222',
  '?type=%3Cscript%3E&order=%3Cscript%3E',
])('不正なURLは空欄のままで誤りを出さない: %s', (search) => {
  window.history.replaceState({}, '', `/contact${search}`);
  render(<ContactPage />);
  expect(screen.getByLabelText(orderNumberLabel)).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'お問い合わせ内容' })).toHaveTextContent('選択してください');
  expect(screen.getByRole('combobox', { name: 'お問い合わせ内容' })).not.toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText(orderNumberLabel)).not.toHaveAttribute('aria-invalid', 'true');
  expect(screen.queryByText(/入力してください|選択してください。|入力内容を確認してください/)).not.toBeInTheDocument();
});

test('URLの件名・氏名・メール・本文・tokenは埋めず編集後の2項目だけを送る', async () => {
  window.history.replaceState({}, '', '/contact?type=order&order=ORD-A1B2C3D4'
    + '&subject=URL件名&name=URL氏名&email=url%40example.com&message=URL本文&token=ignored&website=ignored');
  const { rerender } = render(<ContactPage />);
  expect(readUnrelatedFields()).toEqual({ name: '', email: '', subject: '', message: '' });
  expect(screen.getByLabelText(orderNumberLabel)).toHaveValue('ORD-A1B2C3D4');

  fillRequiredFields();
  fireEvent.change(screen.getByLabelText(orderNumberLabel), { target: { value: 'ORD-11112222' } });
  selectInquiry('商品について');
  fireEvent.click(screen.getByRole('button', { name: 'SEND MESSAGE' }));

  await screen.findByRole('dialog', { name: 'お問い合わせありがとうございます' });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body))).toEqual({
    name: 'テスト太郎', email: 'tester@example.com', inquiryType: 'product',
    subject: '手入力の件名', orderNumber: 'ORD-11112222', message: '手入力の本文', website: '',
  });
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
  rerender(<ContactPage />);
  expect(screen.getByLabelText(orderNumberLabel)).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'お問い合わせ内容' })).toHaveTextContent('選択してください');
});

test('mount後にURLが付いても初期値を取り直さない', () => {
  const { rerender } = render(<ContactPage />);
  window.history.replaceState({}, '', '/contact?type=order&order=ORD-A1B2C3D4');
  rerender(<ContactPage />);
  expect(screen.getByLabelText(orderNumberLabel)).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'お問い合わせ内容' })).toHaveTextContent('選択してください');
});

test('初期値の反映前の注文番号の編集を守り種別だけを埋める', () => {
  window.history.replaceState({}, '', '/contact?type=order&order=ORD-A1B2C3D4');
  render(<EditBeforePrefill />);
  expect(screen.getByLabelText(orderNumberLabel)).toHaveValue('ORD-11112222');
  expect(screen.getByRole('combobox', { name: 'お問い合わせ内容' })).toHaveTextContent('ご注文について');
});
