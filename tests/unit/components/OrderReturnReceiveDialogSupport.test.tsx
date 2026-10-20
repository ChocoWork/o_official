import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';
import { LABEL, ORDER_ID, RETURN_ID, RETURNS_URL, jsonResponse, returnDetail, returnLine } from './return-review-test-fixtures';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderReturnReceiveDialog from '@/components/OrderReturnReceiveDialog';

const TITLE = `受け取る（${LABEL}）`;
// 返金の品は2点で、1点 12,000 円（道具の返品の行）。手数料は 0
const AUTO_TEXT = `受け取ると、計算どおり ${formatYen(24000)} を自動で返金します（額は変えられません）。`;
const NOW_LABEL = `計算どおり ${formatYen(24000)} を返金する`;
const CONSULT_LABEL = '額を相談してから返金する（店長が額を決めます）';
const SUPPORT_NOTICE = '返金は店長が行います（受け取ると「返金待ち」になります）。';
const SUPPORT_CONSULT_BUTTON = '受け取りだけ記録する（額は店長が決める）';
const AWAITING_REFUND = '確かめ中の返金があります。先に確かめてください。';
const NOTICE_RECORDED = '受け取りを記録しました。';
const NOTICE_ACCEPTED = '受け取りを記録し、返金を受け付けました。';

/** 受付中（承認した後）の、お客様の申し込みの返品。2点とも未処理で、返金の品 */
const acceptedReturn = (overrides: Partial<OrderReturnDetail> = {}) =>
  returnDetail({
    status: 'open',
    displayStatus: 'in_progress',
    marks: ['awaiting_items'],
    approvedAt: '2026-10-13T06:00:00.000Z',
    ...overrides,
  });

async function openReceive(detail: OrderReturnDetail, canRefund: boolean, refundableAmount = 54800) {
  mockClientFetch.mockResolvedValueOnce(
    jsonResponse({
      data: { returns: [detail], canRefund, returnableUnits: 0, refundableAmount, refundableShipping: 800, inspectionEnabled: false },
    }),
  );
  const props = { onClose: jest.fn(), onDone: jest.fn(), onUncertain: jest.fn() };
  render(<OrderReturnReceiveDialog orderId={ORDER_ID} returnId={RETURN_ID} {...props} />);
  const dialog = await screen.findByRole('dialog', { name: TITLE });
  return { ...props, dialog };
}

function receiveData(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: 'receipt-1',
    returnStatus: 'open',
    refundId: null,
    refundAmount: null,
    refundStatus: null,
    feeDueAmount: 0,
    replayed: false,
    ...overrides,
  };
}

/** n 番目（0 始まり）の送信の本文。呼び出しの最初は返品の読み込み（GET）なので、1つ後ろを読む */
function requestBodyOf(sendIndex: number): Record<string, unknown> {
  const init = mockClientFetch.mock.calls[sendIndex + 1][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** 確定のボタン（フォームの送信ボタン）。言葉は中身で変わるので、型で探す */
const submitButton = (dialog: HTMLElement) => dialog.querySelector('button[type="submit"]') as HTMLButtonElement;

/** まだ処理していない品を、全部「届いた」にして状態を選ぶ */
function receiveAll(dialog: HTMLElement, disposition = 'restocked') {
  const rows = within(within(dialog).getByRole('list', { name: '受け取る品' })).getAllByRole('listitem');
  rows.forEach((row) => {
    fireEvent.click(within(row).getByRole('checkbox', { name: '届いた' }));
    fireEvent.change(within(row).getByRole('combobox', { name: '品の状態' }), { target: { value: disposition } });
  });
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderReturnReceiveDialog のサポートの受け取り（お客様の申し込みの返品。Review Focus 5）', () => {
  it('返金の品があれば、計算どおりの自動の返金を最初の選びにし、額と送料の入力は出さない', async () => {
    const { dialog } = await openReceive(acceptedReturn(), false);
    receiveAll(dialog);

    expect(mockClientFetch).toHaveBeenCalledWith(RETURNS_URL, { cache: 'no-store' });
    expect(within(dialog).getByRole('group', { name: '返金' })).toBeInTheDocument();
    expect(within(dialog).getByText(AUTO_TEXT)).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: NOW_LABEL })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: CONSULT_LABEL })).not.toBeChecked();
    expect(within(dialog).queryByLabelText(/^返金額/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/^送料/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(SUPPORT_NOTICE)).not.toBeInTheDocument();
    expect(submitButton(dialog)).toHaveTextContent(`すべて受け取って ${formatYen(24000)} を返金する`);
    expect(submitButton(dialog)).toBeEnabled();
  });

  it('今返金のまま受け取ると、窓口へは今返金だけを送る（額・送料・上書きは送らない）', async () => {
    const { dialog, onDone } = await openReceive(acceptedReturn(), false);
    mockClientFetch.mockResolvedValueOnce(
      jsonResponse({ data: receiveData({ refundId: 'refund-1', refundAmount: 24000, refundStatus: 'pending' }) }),
    );
    receiveAll(dialog);

    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_ACCEPTED));
    expect(requestBodyOf(0)).toMatchObject({ refundChoice: 'now', refundAmount: null, refundShippingAmount: 0, exchangeOverrides: [] });
  });

  it('「額を相談してから返金する」を選ぶと、自動の返金の文を隠し、受け取りだけ記録して相談（店への知らせの返金待ち）で送る（Review Focus 5）', async () => {
    const { dialog, onDone } = await openReceive(acceptedReturn(), false);
    mockClientFetch.mockResolvedValueOnce(jsonResponse({ data: receiveData() }));
    receiveAll(dialog);

    fireEvent.click(within(dialog).getByRole('radio', { name: CONSULT_LABEL }));

    expect(within(dialog).queryByText(AUTO_TEXT)).not.toBeInTheDocument();
    expect(submitButton(dialog)).toHaveTextContent(SUPPORT_CONSULT_BUTTON);

    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_RECORDED));
    expect(requestBodyOf(0)).toMatchObject({ refundChoice: 'consult', refundAmount: null, refundShippingAmount: 0 });
  });

  it('今返金が E-2 の「確かめ中の返金がある」で断られたら、受け取りも返金も残らず、断りの文を出す。相談に変えて新しい番号で送り直せる（Review Focus 5）', async () => {
    const { dialog, onDone } = await openReceive(acceptedReturn(), false);
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse({ error: AWAITING_REFUND, code: 'awaiting_refund_exists' }, 409))
      .mockResolvedValueOnce(jsonResponse({ data: receiveData() }));
    receiveAll(dialog);

    fireEvent.click(submitButton(dialog));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(AWAITING_REFUND);
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('radio', { name: CONSULT_LABEL }));
    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0).refundChoice).toBe('now');
    expect(requestBodyOf(1).refundChoice).toBe('consult');
    // 断られた（何も記録していない）ので、次の送信は新しい二重防止の番号
    expect(requestBodyOf(1).requestKey).not.toBe(requestBodyOf(0).requestKey);
  });

  it.each([
    ['返送不要の返品', acceptedReturn({ returnMethod: 'not_required' })],
    ['お店が作った返品', acceptedReturn({ source: 'shop' })],
  ])('%s は段1のまま: 文だけで選びを出さず、今返金は送らず相談（返金待ち）として送る（Review Focus 5）', async (_name, detail) => {
    const { dialog, onDone } = await openReceive(detail, false);
    mockClientFetch.mockResolvedValueOnce(jsonResponse({ data: receiveData() }));
    receiveAll(dialog);

    expect(within(dialog).getByText(SUPPORT_NOTICE)).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: '返金' })).not.toBeInTheDocument();
    expect(submitButton(dialog)).toHaveTextContent(SUPPORT_CONSULT_BUTTON);

    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({ refundChoice: 'consult', refundAmount: null, refundShippingAmount: 0 });
  });

  it('返金の品が無い受け取り（交換の品だけ）には、返金の欄を出さず、返金の選びは none で送る', async () => {
    const exchangeOnly = acceptedReturn({
      lines: [
        returnLine({
          id: 'line-coat',
          orderItemId: 'item-coat',
          itemName: 'ウールコート',
          color: '黒',
          size: 'L',
          quantity: 1,
          resolution: 'exchange',
          exchange: { variantId: 501, color: '黒', size: 'XL', method: 'stock', stockQuantity: 3, madeToOrderLeadDays: 14, outOfStockExchange: 'make' },
          requestedResolution: 'exchange',
          requestedExchange: { variantId: 501, color: '黒', size: 'XL' },
          progress: {
            restocked: 0, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0,
            processed: 0, unprocessed: 1, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 0,
          },
          refundAmountsByCount: [],
        }),
      ],
    });
    const { dialog, onDone } = await openReceive(exchangeOnly, false);
    mockClientFetch.mockResolvedValueOnce(jsonResponse({ data: receiveData() }));
    receiveAll(dialog, 'not_restocked');

    expect(within(dialog).queryByRole('group', { name: '返金' })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(SUPPORT_NOTICE)).not.toBeInTheDocument();

    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({
      units: [{ returnLineId: 'line-coat', disposition: 'not_restocked', quantity: 1 }],
      exchangeOverrides: [],
      refundChoice: 'none',
    });
  });

  it('店長（返金の権限がある人）は、申し込みの返品でも段1のまま: 額と送料を入れられ、相談の言葉は短いまま', async () => {
    const { dialog } = await openReceive(acceptedReturn(), true);
    receiveAll(dialog);

    expect(within(dialog).getByRole('radio', { name: '額を相談してから返金する' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: CONSULT_LABEL })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(`返金額（返せる額: ${formatYen(54800)}）`)).toBeInTheDocument();
    expect(within(dialog).queryByText(AUTO_TEXT)).not.toBeInTheDocument();
  });

  it('返せる額より見込みが大きくても、サポートは額を送らない（DB が計算する）', async () => {
    const { dialog, onDone } = await openReceive(acceptedReturn(), false, 10000);
    mockClientFetch.mockResolvedValueOnce(jsonResponse({ data: receiveData() }));
    receiveAll(dialog);

    // ボタンの額は、文の額（計算どおり）と同じ。返せる額（￥10,000）で切った額は書かない
    expect(within(dialog).getByText(AUTO_TEXT)).toBeInTheDocument();
    expect(submitButton(dialog)).toHaveTextContent(`すべて受け取って ${formatYen(24000)} を返金する`);

    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({ refundChoice: 'now', refundAmount: null, refundShippingAmount: 0 });
  });

  it('交換の手数料が商品の額を上回る受け取りは、サポートの今返金にも「お支払い待ち」の見込みを出す', async () => {
    const onePiece = {
      restocked: 0, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0,
      processed: 0, unprocessed: 1, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 0,
    };
    // 返金の品 1点（商品の額 12,000 円）と交換の品 1点。交換の手数料 15,000 円は商品の額を 3,000 円上回る
    const detail = acceptedReturn({
      fees: { ...returnDetail().fees, exchangeFee: 15000 },
      lines: [
        returnLine({ quantity: 1, refundAmountsByCount: [12000], progress: onePiece }),
        returnLine({
          id: 'line-coat',
          orderItemId: 'item-coat',
          itemName: 'ウールコート',
          color: '黒',
          size: 'L',
          quantity: 1,
          resolution: 'exchange',
          exchange: { variantId: 501, color: '黒', size: 'XL', method: 'stock', stockQuantity: 3, madeToOrderLeadDays: 14, outOfStockExchange: 'make' },
          requestedResolution: 'exchange',
          requestedExchange: { variantId: 501, color: '黒', size: 'XL' },
          progress: onePiece,
          refundAmountsByCount: [],
        }),
      ],
    });
    const { dialog } = await openReceive(detail, false);
    receiveAll(dialog);

    expect(within(dialog).getByText(`お支払い待ち ${formatYen(3000)}（交換の品は、お支払いを確かめてから送ります）`)).toBeInTheDocument();
  });
});
