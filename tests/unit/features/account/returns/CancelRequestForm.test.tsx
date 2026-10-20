import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CustomerReturnCallResult } from '@/features/account/returns/customer-return-client';

// 窓口の呼び出し（4つの答えの分け方）は customer-cancel-request-client.test.ts が確かめる。ここでは答えを差し替える
const mockSubmit = jest.fn();
jest.mock('@/features/account/returns/customer-return-client', () => ({
  submitCustomerCancelRequest: (...args: unknown[]) => mockSubmit(...args),
}));

import { CancelRequestForm, type CancelableLine } from '@/features/account/returns/CancelRequestForm';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_OUTCOME =
  'お申し込みの結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
const RATE_LIMITED = 'しばらくしてから、もう一度お試しください。';

const SHIRT: CancelableLine = { orderItemId: 'item-shirt', label: 'リネンシャツ（白 / M）', unshipped: 2 };
const COAT: CancelableLine = { orderItemId: 'item-coat', label: 'ウールコート（黒 / L）', unshipped: 1 };

const ACCEPTED: CustomerReturnCallResult = {
  kind: 'ok',
  body: { data: { cancelRequestId: 'cr-1', replayed: false } },
};
const UNKNOWN: CustomerReturnCallResult = { kind: 'unknown' };
function blocked(message: string): CustomerReturnCallResult {
  return { kind: 'blocked', message };
}
function refused(message: string, code: string): CustomerReturnCallResult {
  return { kind: 'refused', message, code, invalidPhotoUploadIds: [] };
}

function renderForm(lines: CancelableLine[] = [SHIRT, COAT]) {
  const onSubmitted = jest.fn();
  const onClose = jest.fn();
  render(<CancelRequestForm orderId={ORDER_ID} lines={lines} onSubmitted={onSubmitted} onClose={onClose} />);
  return { onSubmitted, onClose };
}

function lineGroup(line: CancelableLine) {
  return screen.getByRole('group', { name: line.label });
}
function lineCheckbox(line: CancelableLine) {
  return screen.getByRole('checkbox', { name: line.label });
}
function chooseLine(line: CancelableLine) {
  fireEvent.click(lineCheckbox(line));
}
function quantitySelect(line: CancelableLine) {
  return within(lineGroup(line)).getByLabelText('数') as HTMLSelectElement;
}
function noteField() {
  return screen.getByRole('textbox', { name: 'ご連絡事項（任意・300字まで）' });
}
function submitButton() {
  return screen.getByRole('button', { name: '申し込む' });
}
function backButton() {
  return screen.getByRole('button', { name: '戻る' });
}
function retryButton() {
  return screen.getByRole('button', { name: 'もう一度確かめる' });
}
function buttonTexts() {
  return screen.getAllByRole('button').map((button) => button.textContent);
}
/** n 回目に窓口の呼び出しへ渡した中身 */
function sentBody(call: number) {
  return mockSubmit.mock.calls[call - 1][1] as {
    requestKey: string;
    lines: Array<{ orderItemId: string; quantity: number }>;
    customerNote: string | null;
  };
}
/** 案内の入れ物は常にあるので、文が入るまで待つ */
async function expectAlert(text: string) {
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(text));
}

describe('CancelRequestForm の入力', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
  });

  it('題・商品の一覧・ご連絡事項・ボタンを出し、開いた時は題にフォーカスを移す。数の欄は商品を選ぶまで出さない', () => {
    renderForm();

    expect(screen.getByRole('heading', { name: 'キャンセルのお申し込み' })).toHaveFocus();
    expect(screen.getByRole('group', { name: 'キャンセルする商品' })).toBeInTheDocument();
    expect(lineCheckbox(SHIRT)).not.toBeChecked();
    expect(lineCheckbox(COAT)).not.toBeChecked();
    expect(screen.queryByLabelText('数')).not.toBeInTheDocument();
    expect(noteField()).toHaveAttribute('maxlength', '300');
    expect(buttonTexts()).toEqual(['戻る', '申し込む']);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('商品を選ぶと「数」を出す。最初の値は未発送の数で、選べる数は未発送の数まで。選びを外すと「数」を消す', () => {
    renderForm();

    chooseLine(SHIRT);
    expect(lineCheckbox(SHIRT)).toBeChecked();
    expect(quantitySelect(SHIRT)).toHaveValue('2');
    expect(Array.from(quantitySelect(SHIRT).options).map((option) => option.value)).toEqual(['1', '2']);

    chooseLine(COAT);
    expect(quantitySelect(COAT)).toHaveValue('1');
    expect(Array.from(quantitySelect(COAT).options).map((option) => option.value)).toEqual(['1']);

    fireEvent.change(quantitySelect(SHIRT), { target: { value: '1' } });
    expect(quantitySelect(SHIRT)).toHaveValue('1');

    chooseLine(SHIRT);
    expect(lineCheckbox(SHIRT)).not.toBeChecked();
    expect(within(lineGroup(SHIRT)).queryByLabelText('数')).not.toBeInTheDocument();
    // 選び直すと、数は未発送の数に戻る
    chooseLine(SHIRT);
    expect(quantitySelect(SHIRT)).toHaveValue('2');
  });

  it('商品を選ばずに「申し込む」を押すと、誤りを出して送らない。商品を選ぶと誤りを消す', async () => {
    renderForm();

    fireEvent.click(submitButton());

    await expectAlert('キャンセルする商品を選んでください。');
    expect(mockSubmit).not.toHaveBeenCalled();
    chooseLine(COAT);
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('選んだ品と数・ご連絡事項（前後の空白を外す）を二重防止の番号つきで渡し、受け付けられたら親に知らせる', async () => {
    const { onSubmitted } = renderForm();
    mockSubmit.mockResolvedValueOnce(ACCEPTED);
    chooseLine(SHIRT);
    fireEvent.change(quantitySelect(SHIRT), { target: { value: '1' } });
    chooseLine(COAT);
    fireEvent.change(noteField(), { target: { value: '  サイズが合わなかったため  ' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit.mock.calls[0][0]).toBe(ORDER_ID);
    expect(sentBody(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [
        { orderItemId: 'item-shirt', quantity: 1 },
        { orderItemId: 'item-coat', quantity: 1 },
      ],
      customerNote: 'サイズが合わなかったため',
    });
  });

  it('ご連絡事項が空白だけなら、null で渡す', async () => {
    renderForm();
    mockSubmit.mockResolvedValueOnce(ACCEPTED);
    chooseLine(COAT);
    fireEvent.change(noteField(), { target: { value: '   ' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(sentBody(1).customerNote).toBeNull();
  });

  it('送っている間は入力もボタンも止まり、二重に送らない', async () => {
    const { onSubmitted } = renderForm();
    let finish: (value: CustomerReturnCallResult) => void = () => {};
    mockSubmit.mockImplementationOnce(
      () =>
        new Promise<CustomerReturnCallResult>((resolve) => {
          finish = resolve;
        }),
    );
    chooseLine(SHIRT);
    fireEvent.click(submitButton());

    expect(submitButton()).toBeDisabled();
    expect(backButton()).toBeDisabled();
    expect(lineCheckbox(SHIRT)).toBeDisabled();
    expect(lineCheckbox(COAT)).toBeDisabled();
    expect(quantitySelect(SHIRT)).toBeDisabled();
    expect(noteField()).toBeDisabled();
    fireEvent.click(submitButton());
    expect(mockSubmit).toHaveBeenCalledTimes(1);

    finish(ACCEPTED);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });
});

describe('CancelRequestForm の窓口の答え', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
  });

  it('受付オフで断られた時は、キャンセルの言葉を表示し、返品・交換の言葉を表示しない', async () => {
    const { onSubmitted } = renderForm();
    const message = '現在、キャンセルのお申し込みを受け付けていません。';
    mockSubmit.mockResolvedValueOnce(refused(message, 'RETURN_REQUESTS_CLOSED'));
    chooseLine(SHIRT);
    fireEvent.click(submitButton());

    await expectAlert(message);
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(screen.queryByText('現在、返品・交換のお申し込みを受け付けていません。')).not.toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('窓口が断った時は、その文を出し、入力を残し、次の送信は新しい二重防止の番号にする', async () => {
    const { onSubmitted } = renderForm();
    const message = 'お申し込みいただける数を超えています。画面を開き直してください。';
    mockSubmit
      .mockResolvedValueOnce(refused(message, 'CANCEL_REQUEST_QUANTITY_EXCEEDS'))
      .mockResolvedValueOnce(ACCEPTED);
    chooseLine(SHIRT);
    fireEvent.click(submitButton());

    await expectAlert(message);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(lineCheckbox(SHIRT)).toBeChecked();
    expect(lineCheckbox(SHIRT)).toBeEnabled();
    expect(quantitySelect(SHIRT)).toHaveValue('2');
    expect(submitButton()).toBeEnabled();

    fireEvent.click(submitButton());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(sentBody(2).requestKey).toMatch(UUID_PATTERN);
    expect(sentBody(2).requestKey).not.toBe(sentBody(1).requestKey);
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('処理に入る前の断り（ログイン切れ・回数の制限）は、その文を出し、入力と二重防止の番号を保つ', async () => {
    const { onSubmitted } = renderForm();
    mockSubmit.mockResolvedValueOnce(blocked(RATE_LIMITED)).mockResolvedValueOnce(ACCEPTED);
    chooseLine(SHIRT);
    fireEvent.click(submitButton());

    await expectAlert(RATE_LIMITED);
    expect(lineCheckbox(SHIRT)).toBeEnabled();
    expect(submitButton()).toBeEnabled();

    fireEvent.click(submitButton());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(sentBody(2).requestKey).toBe(sentBody(1).requestKey);
  });

  it('Review Focus 1: 結果が分からない時は、入力を止め、文と「戻る」「もう一度確かめる」だけを出す。確かめ直しは同じ番号・同じ本文で送り、受け付けられたら親に知らせる', async () => {
    const { onSubmitted, onClose } = renderForm();
    mockSubmit.mockResolvedValueOnce(UNKNOWN).mockResolvedValueOnce(ACCEPTED);
    chooseLine(SHIRT);
    fireEvent.change(noteField(), { target: { value: 'サイズが合わなかったため' } });
    fireEvent.click(submitButton());

    await expectAlert(UNKNOWN_OUTCOME);
    expect(lineCheckbox(SHIRT)).toBeDisabled();
    expect(lineCheckbox(COAT)).toBeDisabled();
    expect(quantitySelect(SHIRT)).toBeDisabled();
    expect(noteField()).toBeDisabled();
    expect(screen.queryByRole('button', { name: '申し込む' })).not.toBeInTheDocument();
    expect(buttonTexts()).toEqual(['戻る', 'もう一度確かめる']);

    fireEvent.click(retryButton());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(mockSubmit).toHaveBeenCalledTimes(2);
    expect(sentBody(2)).toEqual(sentBody(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('結果が分からない間に処理前の断りを受けたら、断りの文の後ろに結果が分からない時の文を続け、次も同じ番号・同じ本文で送る', async () => {
    const { onSubmitted } = renderForm();
    mockSubmit
      .mockResolvedValueOnce(UNKNOWN)
      .mockResolvedValueOnce(blocked(RATE_LIMITED))
      .mockResolvedValueOnce(ACCEPTED);
    chooseLine(SHIRT);
    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole('button', { name: 'もう一度確かめる' }));

    await expectAlert(`${RATE_LIMITED}${UNKNOWN_OUTCOME}`);
    expect(lineCheckbox(SHIRT)).toBeDisabled();
    expect(buttonTexts()).toEqual(['戻る', 'もう一度確かめる']);

    fireEvent.click(retryButton());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(sentBody(2)).toEqual(sentBody(1));
    expect(sentBody(3)).toEqual(sentBody(1));
  });

  it('Review Focus 1: 確かめ直しても分からない時はそのまま止まる。「戻る」は、受け付けられていたかもしれないので、読み直しを頼める形で閉じる', async () => {
    const { onSubmitted, onClose } = renderForm();
    mockSubmit.mockResolvedValueOnce(UNKNOWN).mockResolvedValueOnce(UNKNOWN);
    chooseLine(SHIRT);
    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(retryButton()).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(onSubmitted).not.toHaveBeenCalled();

    fireEvent.click(backButton());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ uncertain: true });
  });

  it('確かめ直しで窓口に断られたら、結果が分からない状態を終えて入力を戻し、新しい二重防止の番号で送れる', async () => {
    const { onSubmitted } = renderForm();
    const message = 'キャンセルのお申し込みは、すでに受け付けています。';
    mockSubmit
      .mockResolvedValueOnce(UNKNOWN)
      .mockResolvedValueOnce(refused(message, 'CANCEL_REQUEST_EXISTS'))
      .mockResolvedValueOnce(ACCEPTED);
    chooseLine(SHIRT);
    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole('button', { name: 'もう一度確かめる' }));

    await expectAlert(message);
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(lineCheckbox(SHIRT)).toBeEnabled();
    expect(buttonTexts()).toEqual(['戻る', '申し込む']);

    fireEvent.click(submitButton());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(sentBody(3).requestKey).not.toBe(sentBody(1).requestKey);
  });

  it('「戻る」は送らずに閉じる（結果が分からない状態ではないので、読み直しは頼まない）', () => {
    const { onSubmitted, onClose } = renderForm();
    chooseLine(SHIRT);

    fireEvent.click(backButton());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ uncertain: false });
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
