import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RefundAcceptedResponse, RefundMaterialLine, RefundMaterials } from '@/lib/orders/refund/refund-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderRefundDialog from '@/components/OrderRefundDialog';

/**
 * 返金の画面の最初の数（グループ E-3 段2 の Task 12）。キャンセルの申し込みの「品を外す」から開く時、
 * 材料を読んだ後の発送前の商品に、申し込みの品と数を入れる。金額・固定・在庫に戻す、などのほかの動きは
 * OrderRefundDialog.test.tsx が確かめるので、ここでは最初の数に関わる所だけを見る。
 */
const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const BEFORE = '発送前の商品';
const AFTER = '発送済みの商品';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 在庫の品。2つとも未発送 */
const BLOUSE: RefundMaterialLine = {
  orderItemId: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
  itemPrice: 12000, quantity: 2, lineTotal: 24000, shipped: 0, unshipped: 2,
  refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 2,
  lineDiscount: 0, refundedUnits: 0,
};

/** 受注生産の品。1つとも未発送 */
const COAT: RefundMaterialLine = {
  orderItemId: 'item-backorder', name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder',
  itemPrice: 30000, quantity: 1, lineTotal: 30000, shipped: 0, unshipped: 1,
  refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 0,
  lineDiscount: 0, refundedUnits: 0,
};

/** もう全部送った品。発送済みの商品にだけ出る（未発送の数が 0） */
const SHIPPED: RefundMaterialLine = {
  orderItemId: 'item-shipped', name: 'レザーベルト', color: '茶', size: null, fulfillmentType: 'stock',
  itemPrice: 9000, quantity: 1, lineTotal: 9000, shipped: 1, unshipped: 0,
  refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 1, restockable: 0,
  lineDiscount: 0, refundedUnits: 0,
};

/** 何も発送していないカードの注文（ブラウス 2・コート 1・送料 800 で 54,800） */
const BASE_ORDER: RefundMaterials['order'] = {
  id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid', paymentMethod: 'card',
  totalAmount: 54800, shippingAmount: 800, discountAmount: 0, paidAmount: 54800,
  succeededAmount: 0, openAmount: 0, refundableAmount: 54800, refundedShipping: 0, refundableShipping: 800,
  shippedTotal: 0, unshippedTotal: 3,
};

function materials({
  order = {},
  lines = [BLOUSE, COAT],
}: { order?: Partial<RefundMaterials['order']>; lines?: RefundMaterialLine[] } = {}): RefundMaterials {
  return { order: { ...BASE_ORDER, ...order }, lines, awaitingRefund: null };
}

function accepted(overrides: Partial<RefundAcceptedResponse> = {}): RefundAcceptedResponse {
  return { refundId: 'refund-1', status: 'pending', amount: 12000, replayed: false, ...overrides };
}

/** 画面を開き、返金の材料を読み終えるまで待つ。prefill は申し込みの品と数 */
async function openDialog(prefill?: Array<{ orderItemId: string; quantity: number }>, loaded: RefundMaterials = materials()) {
  mockClientFetch.mockResolvedValueOnce(json(loaded));
  const props = { onClose: jest.fn(), onRefunded: jest.fn(), onUncertain: jest.fn() };
  render(<OrderRefundDialog orderId={ORDER_ID} prefillBeforeShipment={prefill} {...props} />);
  const dialog = await screen.findByRole('dialog', { name: '返金' });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return { dialog, ...props };
}

/** 区分（発送前・発送済み）の領域の中の、商品の行の「返金する数」の入力 */
function quantityInput(dialog: HTMLElement, section: string, group: string): HTMLInputElement {
  const region = within(dialog).getByRole('region', { name: section });
  return within(within(region).getByRole('group', { name: group })).getByLabelText('返金する数') as HTMLInputElement;
}

const blouseBefore = (dialog: HTMLElement) => quantityInput(dialog, BEFORE, 'シルクブラウス（白 / M）');
const coatBefore = (dialog: HTMLElement) => quantityInput(dialog, BEFORE, 'ウールコート（黒 / L）');
const shippingInput = (dialog: HTMLElement) => within(dialog).getByLabelText('送料') as HTMLInputElement;
const amountInput = (dialog: HTMLElement) => within(dialog).getByLabelText('返金額') as HTMLInputElement;

/** 内訳の1行の文字（「商品￥12,000」のように、名前と金額を続けた物） */
function breakdownRow(dialog: HTMLElement, term: '商品' | '割引' | '送料' | '返金額'): string {
  const group = within(dialog).getByRole('group', { name: '返金の内訳' });
  return within(group).getByText(term).parentElement?.textContent ?? '';
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderRefundDialog の最初の数（prefillBeforeShipment）', () => {
  it('申し込みの品と数が、発送前の商品の「返金する数」の最初の値に入る。ほかの品は 0 のままで、内訳と返金のボタンも申し込みの数から出る', async () => {
    const { dialog } = await openDialog([{ orderItemId: 'item-stock', quantity: 1 }]);

    expect(blouseBefore(dialog)).toHaveValue(1);
    expect(coatBefore(dialog)).toHaveValue(0);
    expect(breakdownRow(dialog, '商品')).toBe('商品￥12,000');
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥12,000');
    expect(amountInput(dialog)).toHaveValue(12000);
    expect(within(dialog).getByRole('button', { name: '￥12,000 を返金する' })).toBeEnabled();
  });

  it('「在庫に戻す」の最初の値は E-2 のまま（入っている）', async () => {
    const { dialog } = await openDialog([{ orderItemId: 'item-stock', quantity: 1 }]);

    expect(within(dialog).getByRole('checkbox', { name: '在庫に戻す' })).toBeChecked();
  });

  it.each<[string, number, number]>([
    ['未発送の数（2）を超える数は未発送の数に収める', 5, 2],
    ['負の数は 0', -1, 0],
    ['小数は切り捨てる', 1.9, 1],
  ])('%s（申し込み %s → 入る数 %s）', async (_label, requested, expected) => {
    const { dialog } = await openDialog([{ orderItemId: 'item-stock', quantity: requested }]);

    expect(blouseBefore(dialog)).toHaveValue(expected);
  });

  it('発送前の商品に無い品（もう全部送った品・材料に無い品）は無視する。発送済みの商品の数にも入れない', async () => {
    const { dialog } = await openDialog(
      [
        { orderItemId: 'item-shipped', quantity: 1 },
        { orderItemId: 'item-unknown', quantity: 3 },
      ],
      materials({ lines: [BLOUSE, COAT, SHIPPED], order: { shippedTotal: 1, unshippedTotal: 3 } }),
    );

    expect(blouseBefore(dialog)).toHaveValue(0);
    expect(coatBefore(dialog)).toHaveValue(0);
    expect(quantityInput(dialog, AFTER, 'レザーベルト（茶）')).toHaveValue(0);
    expect(within(dialog).getByRole('button', { name: '￥0 を返金する' })).toBeDisabled();
  });

  it('手で直した数が先: 数を変えても申し込みの数に戻らず、0 にしても 0 のまま', async () => {
    const { dialog } = await openDialog([{ orderItemId: 'item-stock', quantity: 2 }]);
    expect(blouseBefore(dialog)).toHaveValue(2);

    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    expect(blouseBefore(dialog)).toHaveValue(1);

    fireEvent.change(blouseBefore(dialog), { target: { value: '0' } });
    expect(blouseBefore(dialog)).toHaveValue(0);
    expect(within(dialog).getByRole('button', { name: '￥0 を返金する' })).toBeDisabled();
  });

  it('「すべて選ぶ」は申し込みの数を上書きして、残りの全部を入れる', async () => {
    const { dialog } = await openDialog([{ orderItemId: 'item-stock', quantity: 1 }]);
    expect(blouseBefore(dialog)).toHaveValue(1);

    fireEvent.click(within(dialog).getByRole('button', { name: 'すべて選ぶ' }));

    expect(blouseBefore(dialog)).toHaveValue(2);
    expect(coatBefore(dialog)).toHaveValue(1);
  });

  it('申し込みの数のまま返金すると、その数だけを発送前として送る（在庫に戻すは入ったまま）', async () => {
    const { dialog, onRefunded } = await openDialog([{ orderItemId: 'item-stock', quantity: 1 }]);
    mockClientFetch.mockResolvedValueOnce(json(accepted()));

    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));

    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
    const init = mockClientFetch.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      lines: [{ orderItemId: 'item-stock', quantity: 1, beforeShipment: true }],
      restock: true,
      shippingAmount: 0,
      amount: 12000,
    });
  });

  it('未発送の全部を申し込んだ時は、E-2 と同じに送料と返金額が全部に固定され、注意が出る', async () => {
    const { dialog } = await openDialog([
      { orderItemId: 'item-stock', quantity: 2 },
      { orderItemId: 'item-backorder', quantity: 1 },
    ]);

    expect(within(dialog).getByText('まだ発送していない注文の商品を全部返すので、送料と返金額も全部返します。')).toBeInTheDocument();
    expect(shippingInput(dialog)).toHaveValue(800);
    expect(shippingInput(dialog)).toBeDisabled();
    expect(amountInput(dialog)).toHaveValue(54800);
    expect(amountInput(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '￥54,800 を返金する' })).toBeEnabled();
  });

  it('最初の数を渡さない時は、今までどおり何も選ばない', async () => {
    const { dialog } = await openDialog();

    expect(blouseBefore(dialog)).toHaveValue(0);
    expect(coatBefore(dialog)).toHaveValue(0);
    expect(within(dialog).getByRole('button', { name: '￥0 を返金する' })).toBeDisabled();
  });
});
