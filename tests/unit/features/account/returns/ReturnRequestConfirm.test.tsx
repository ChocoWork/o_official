import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockSubmit = jest.fn();
jest.mock('@/features/account/returns/customer-return-client', () => ({
  submitCustomerReturnRequest: (...args: unknown[]) => mockSubmit(...args),
}));
jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));

import { ReturnRequestAccepted, ReturnRequestConfirm } from '@/features/account/returns/ReturnRequestConfirm';
import type { ConfirmSummary, SubmitBody } from '@/features/account/returns/return-request-model';
import { ORDER_ID, acceptedBody } from './return-request-fixtures';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = '11111111-2222-4333-8444-555555555555';
const UNKNOWN_OUTCOME = 'お申し込みの結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
const RATE_LIMITED = 'しばらくしてから、もう一度お試しください。';
const QUANTITY_EXCEEDS = 'お申し込みいただける数を超えています。画面を開き直してください。';
const PHOTO_INVALID = '写真を確かめてください（JPEG・PNG、1枚10MBまで、1つの商品に5枚まで）。';

const BODY: SubmitBody = {
  requestKey: KEY,
  lines: [
    {
      fulfillmentId: 'ful-1', orderItemId: 'item-blouse', quantity: 2, reason: 'defective', customerNote: '縫い目がほつれています',
      requestedResolution: 'exchange', requestedExchangeVariantId: 102, photoUploadIds: ['up-1'],
    },
  ],
};

const SUMMARY: ConfirmSummary = {
  lines: [
    {
      key: 'k1', title: 'シルクブラウス（白 / M） × 2', reason: '理由: 破損・不良', note: '詳しい内容: 縫い目がほつれています',
      wish: 'ご希望: 交換（白 / L）', photos: '写真 1枚',
    },
    { key: 'k2', title: 'ウールパンツ（2） × 1', reason: '理由: サイズが小さい', note: null, wish: 'ご希望: 返金', photos: null },
  ],
  shipping: '返送料: 当店が負担します（着払いでお送りください）',
  fees: ['返品の手数料: ご返金の商品の額の 10%'],
  feeNote: '手数料はご返金から差し引きます。差し引けない分は、お支払いのご案内をお送りします。',
};

function setup(summary: ConfirmSummary = SUMMARY) {
  const props = { onBack: jest.fn(), onAccepted: jest.fn(), onPhotosRejected: jest.fn() };
  render(<ReturnRequestConfirm orderId={ORDER_ID} body={BODY} summary={summary} {...props} />);
  return props;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const submitButton = () => screen.getByRole('button', { name: '申し込む' });
const buttonTexts = () => screen.getAllByRole('button').map((button) => button.textContent);
/** n 回目（0 始まり）の呼び出しが窓口へ渡した中身 */
const sentBody = (call: number) => mockSubmit.mock.calls[call][1] as SubmitBody;

beforeEach(() => {
  mockSubmit.mockReset();
});

describe('ReturnRequestConfirm の内容', () => {
  it('入力した中身、返送料、手数料、注意を出し、見出しへフォーカスを移す。操作は「戻る」と「申し込む」', () => {
    setup();

    const region = screen.getByRole('region', { name: 'お申し込みの内容' });
    expect(screen.getByRole('heading', { name: 'お申し込みの内容' })).toHaveFocus();
    [
      'シルクブラウス（白 / M） × 2',
      '理由: 破損・不良',
      '詳しい内容: 縫い目がほつれています',
      'ご希望: 交換（白 / L）',
      '写真 1枚',
      'ウールパンツ（2） × 1',
      '理由: サイズが小さい',
      'ご希望: 返金',
      '返送料: 当店が負担します（着払いでお送りください）',
      '返品の手数料: ご返金の商品の額の 10%',
      '手数料はご返金から差し引きます。差し引けない分は、お支払いのご案内をお送りします。',
      'お申し込みの後、当店で内容を確かめてから、メールでご連絡します。',
    ].forEach((text) => expect(within(region).getByText(text)).toBeInTheDocument());
    expect(buttonTexts()).toEqual(['戻る', '申し込む']);
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('詳しい内容・写真・手数料が無い申し込みでは、その行を出さない', () => {
    setup({
      lines: [{ key: 'k2', title: 'ウールパンツ（2） × 1', reason: '理由: サイズが小さい', note: null, wish: 'ご希望: 返金', photos: null }],
      shipping: '返送料: お客様のご負担です',
      fees: [],
      feeNote: null,
    });

    expect(screen.getByText('返送料: お客様のご負担です')).toBeInTheDocument();
    expect(screen.queryByText(/詳しい内容/)).not.toBeInTheDocument();
    expect(screen.queryByText(/写真/)).not.toBeInTheDocument();
    expect(screen.queryByText(/手数料/)).not.toBeInTheDocument();
  });

  it('お客様が書いた詳しい内容は、書かれたとおりの字として出す（改行を保ち、HTML として読まない）', () => {
    setup({
      lines: [
        {
          key: 'k1', title: 'ウールパンツ（2） × 1', reason: '理由: その他', note: '詳しい内容: <b>袖</b>が短い\n2行目',
          wish: 'ご希望: 返金', photos: null,
        },
      ],
      shipping: '返送料: お客様のご負担です',
      fees: [],
      feeNote: null,
    });

    const note = screen.getByText(/袖.*が短い/);
    expect(note).toHaveClass('whitespace-pre-wrap');
    expect(note.textContent).toBe('詳しい内容: <b>袖</b>が短い\n2行目');
    expect(note.querySelector('b')).toBeNull();
    // 長い文でも横にはみ出さないよう、折り返す指定を付ける
    expect(note.closest('li')).toHaveClass('min-w-0', 'break-words');
  });

  it('「戻る」で最初の段へ戻る（送らない）', () => {
    const { onBack } = setup();

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

describe('ReturnRequestConfirm の申し込む', () => {
  it('確かめる段に入った時の二重防止の番号と中身のまま、注文の番号つきで窓口へ送り、受け付けたら返品の番号を親へ渡す', async () => {
    mockSubmit.mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(3) });
    const { onAccepted } = setup();

    fireEvent.click(submitButton());

    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith({ label: 'ORD-A1B2C3D4-R3' }));
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith(ORDER_ID, BODY);
  });

  it('送っている間は両方のボタンを止め、二重に送らない', async () => {
    const pending = deferred<unknown>();
    mockSubmit.mockReturnValueOnce(pending.promise);
    const { onAccepted, onBack } = setup();

    fireEvent.click(submitButton());

    expect(submitButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: '戻る' })).toBeDisabled();
    fireEvent.click(submitButton());
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();

    pending.resolve({ kind: 'ok', body: acceptedBody(1) });
    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith({ label: 'ORD-A1B2C3D4-R1' }));
  });

  it('同じ二重防止の番号の送り直しで前の結果（replayed）が返っても、受け付けた扱いにする', async () => {
    mockSubmit.mockResolvedValueOnce({
      kind: 'ok', body: { data: { returnId: 'ret-1', number: 2, label: 'ORD-A1B2C3D4-R2', replayed: true } },
    });
    const { onAccepted } = setup();

    fireEvent.click(submitButton());

    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith({ label: 'ORD-A1B2C3D4-R2' }));
  });

  it('返品番号は窓口の答えの label を使い、label が無い（または空の）答えは、注文の番号と返品の番号から組む', async () => {
    mockSubmit
      .mockResolvedValueOnce({ kind: 'ok', body: { data: { returnId: 'ret-1', number: 4, label: 'ORD-WINDOW-R4', replayed: false } } })
      .mockResolvedValueOnce({ kind: 'ok', body: { data: { returnId: 'ret-1', number: 5, replayed: false } } })
      .mockResolvedValueOnce({ kind: 'ok', body: { data: { returnId: 'ret-1', number: 6, label: '', replayed: false } } });
    const { onAccepted } = setup();

    fireEvent.click(submitButton());
    await waitFor(() => expect(onAccepted).toHaveBeenNthCalledWith(1, { label: 'ORD-WINDOW-R4' }));
    await waitFor(() => expect(submitButton()).toBeEnabled());
    fireEvent.click(submitButton());
    await waitFor(() => expect(onAccepted).toHaveBeenNthCalledWith(2, { label: 'ORD-A1B2C3D4-R5' }));
    await waitFor(() => expect(submitButton()).toBeEnabled());
    fireEvent.click(submitButton());
    await waitFor(() => expect(onAccepted).toHaveBeenNthCalledWith(3, { label: 'ORD-A1B2C3D4-R6' }));
  });
});

describe('ReturnRequestConfirm の窓口の断り', () => {
  it('窓口が断ったら、その文を出し、中身は残して、次の送信は新しい二重防止の番号にする', async () => {
    mockSubmit
      .mockResolvedValueOnce({ kind: 'refused', message: QUANTITY_EXCEEDS, code: 'RETURN_QUANTITY_EXCEEDS', invalidPhotoUploadIds: [] })
      .mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(1) });
    const { onAccepted, onPhotosRejected } = setup();

    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(QUANTITY_EXCEEDS));
    expect(buttonTexts()).toEqual(['戻る', '申し込む']);
    expect(submitButton()).toBeEnabled();
    expect(onPhotosRejected).not.toHaveBeenCalled();
    expect(sentBody(0).requestKey).toBe(KEY);

    fireEvent.click(submitButton());

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(sentBody(1).requestKey).toMatch(UUID_PATTERN);
    expect(sentBody(1).requestKey).not.toBe(KEY);
    expect(sentBody(1).lines).toEqual(BODY.lines);
  });

  it('処理に入る前の断り（回数の制限など）は、文を出して、次の送信も同じ二重防止の番号で送る', async () => {
    mockSubmit.mockResolvedValueOnce({ kind: 'blocked', message: RATE_LIMITED }).mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(1) });
    const { onAccepted } = setup();

    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(RATE_LIMITED));
    expect(buttonTexts()).toEqual(['戻る', '申し込む']);
    fireEvent.click(submitButton());

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(sentBody(1)).toEqual(sentBody(0));
    expect(sentBody(1).requestKey).toBe(KEY);
  });

  it('写真が合わないと断られたら、合わない写真の送り先の番号と文を親へ渡す（この段には文を出さない）', async () => {
    mockSubmit.mockResolvedValueOnce({
      kind: 'refused', message: PHOTO_INVALID, code: 'RETURN_PHOTO_INVALID', invalidPhotoUploadIds: ['up-2'],
    });
    const { onPhotosRejected } = setup();

    fireEvent.click(submitButton());

    await waitFor(() => expect(onPhotosRejected).toHaveBeenCalledWith(['up-2'], PHOTO_INVALID));
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('DB が写真を断って、合わない写真が分からない時（番号が空）も、親へ渡す（親が写真を残して手順1へ戻し、文を出す）', async () => {
    mockSubmit.mockResolvedValueOnce({
      kind: 'refused', message: PHOTO_INVALID, code: 'RETURN_PHOTO_INVALID', invalidPhotoUploadIds: [],
    });
    const { onPhotosRejected } = setup();

    fireEvent.click(submitButton());

    await waitFor(() => expect(onPhotosRejected).toHaveBeenCalledWith([], PHOTO_INVALID));
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });
});

const UNKNOWN_ANSWERS: Array<[string, unknown]> = [
  ['通信が切れた・サーバーの失敗', { kind: 'unknown' }],
  ['成功なのに答えの中身が無い', { kind: 'ok', body: {} }],
  ['成功なのに返品の番号が読めない', { kind: 'ok', body: { data: { returnId: 'ret-1' } } }],
  ['成功なのに返品の番号が1に満たない', { kind: 'ok', body: { data: { returnId: 'ret-1', number: 0 } } }],
];

describe('ReturnRequestConfirm の答えが分からない時（Review Focus 1）', () => {
  it.each(UNKNOWN_ANSWERS)('Review Focus 1: %s時は、「もう一度確かめる」だけを出し、同じ二重防止の番号・同じ中身で確かめ直す', async (_label, firstAnswer) => {
    mockSubmit.mockResolvedValueOnce(firstAnswer).mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(2) });
    const { onAccepted, onBack } = setup();

    fireEvent.click(submitButton());

    expect(await screen.findByRole('button', { name: 'もう一度確かめる' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(buttonTexts()).toEqual(['もう一度確かめる']);
    expect(onAccepted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith({ label: 'ORD-A1B2C3D4-R2' }));
    expect(sentBody(1)).toEqual(sentBody(0));
    expect(sentBody(1).requestKey).toBe(KEY);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('Review Focus 1: 確かめ直しても分からない時は、そのまま止まる', async () => {
    mockSubmit.mockResolvedValueOnce({ kind: 'unknown' }).mockResolvedValueOnce({ kind: 'unknown' });
    const { onAccepted } = setup();

    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'もう一度確かめる' })).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(buttonTexts()).toEqual(['もう一度確かめる']);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('結果が分からない間に処理前の断り（429）を受けた時は、断りの文の後ろに結果が分からない時の文を続け、次も同じ番号・同じ中身で送る', async () => {
    mockSubmit
      .mockResolvedValueOnce({ kind: 'unknown' })
      .mockResolvedValueOnce({ kind: 'blocked', message: RATE_LIMITED })
      .mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(1) });
    const { onAccepted } = setup();

    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(`${RATE_LIMITED}${UNKNOWN_OUTCOME}`));
    expect(buttonTexts()).toEqual(['もう一度確かめる']);

    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(sentBody(2)).toEqual(sentBody(0));
    expect(sentBody(1)).toEqual(sentBody(0));
  });

  it('確かめ直しが窓口に断られたら、記録されていないので、元の操作に戻して新しい番号にする', async () => {
    mockSubmit
      .mockResolvedValueOnce({ kind: 'unknown' })
      .mockResolvedValueOnce({ kind: 'refused', message: QUANTITY_EXCEEDS, code: 'RETURN_QUANTITY_EXCEEDS', invalidPhotoUploadIds: [] })
      .mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(1) });
    const { onAccepted } = setup();

    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(buttonTexts()).toEqual(['戻る', '申し込む']));
    expect(screen.getByRole('alert')).toHaveTextContent(QUANTITY_EXCEEDS);
    expect(screen.getByRole('alert')).not.toHaveTextContent('確かめられませんでした');

    fireEvent.click(submitButton());

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(sentBody(2).requestKey).toMatch(UUID_PATTERN);
    expect(sentBody(2).requestKey).not.toBe(KEY);
  });
});

describe('ReturnRequestAccepted', () => {
  it('受け付けた文と返品番号を出し、注文の画面へ戻るボタンを出す。文へフォーカスを移す', () => {
    render(<ReturnRequestAccepted orderId={ORDER_ID} label="ORD-A1B2C3D4-R3" />);

    const accepted = screen.getByTestId('return-request-accepted');
    const message = within(accepted).getByText('お申し込みを受け付けました。内容を確かめて、メールでご連絡します。');
    expect(message).toHaveFocus();
    expect(within(accepted).getByText('返品番号: ORD-A1B2C3D4-R3')).toBeInTheDocument();
    expect(within(accepted).getByRole('link', { name: '注文の画面に戻る' })).toHaveAttribute('href', `/account/orders/${ORDER_ID}`);
  });
});
