import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RefundAcceptedResponse, RefundMaterialLine, RefundMaterials } from '@/lib/orders/refund/refund-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderRefundDialog from '@/components/OrderRefundDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const REFUND_URL = `/api/admin/orders/${ORDER_ID}/refund`;
const CONFIRM_URL = `${REFUND_URL}/confirm`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_OUTCOME = '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
/** 回数の制限（429）で処理の前に断られた時の文。管理画面のほかの所に決まった文が無いので、ここで決めた物 */
const RATE_LIMITED = '操作が続いたため受け付けませんでした。しばらく待ってから、もう一度お試しください。';
const BEFORE = '発送前の商品';
const AFTER = '発送済みの商品';
// 割引の行の符号は U+2212（ハイフンではなくマイナス記号）
const MINUS = '\u2212';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 在庫の品。2つとも未発送 */
const STOCK_LINE: RefundMaterialLine = {
  orderItemId: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
  itemPrice: 12000, quantity: 2, lineTotal: 24000, shipped: 0, unshipped: 2,
  refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 2,
  lineDiscount: 0, refundedUnits: 0,
};

/** 受注生産の品。1つとも未発送（在庫は確保していない） */
const BACKORDER_LINE: RefundMaterialLine = {
  orderItemId: 'item-backorder', name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder',
  itemPrice: 30000, quantity: 1, lineTotal: 30000, shipped: 0, unshipped: 1,
  refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 0,
  lineDiscount: 0, refundedUnits: 0,
};

/** 3つのうち1つを送り済み。発送前（2）と発送済み（1）の両方に出る */
const PARTLY_SHIPPED_LINE: RefundMaterialLine = {
  orderItemId: 'item-partly', name: 'ウールパンツ', color: null, size: '2', fulfillmentType: 'stock',
  itemPrice: 18000, quantity: 3, lineTotal: 54000, shipped: 1, unshipped: 2,
  refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 1, restockable: 2,
  lineDiscount: 0, refundedUnits: 0,
};

/** 全部送り済み。発送済みだけに出る */
const SHIPPED_LINE: RefundMaterialLine = {
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

type MaterialsOverrides = {
  order?: Partial<RefundMaterials['order']>;
  lines?: RefundMaterialLine[];
  awaitingRefund?: RefundMaterials['awaitingRefund'];
};

function materials({ order = {}, lines = [STOCK_LINE, BACKORDER_LINE], awaitingRefund = null }: MaterialsOverrides = {}): RefundMaterials {
  return { order: { ...BASE_ORDER, ...order }, lines, awaitingRefund };
}

/** 一部を送った注文。発送前（ブラウス 2・パンツ 2）と発送済み（パンツ 1・ベルト 1）の両方がある（87,000 + 送料 800） */
function shippedMaterials(): RefundMaterials {
  return materials({
    lines: [STOCK_LINE, PARTLY_SHIPPED_LINE, SHIPPED_LINE],
    order: { totalAmount: 87800, paidAmount: 87800, refundableAmount: 87800, shippedTotal: 2, unshippedTotal: 4 },
  });
}

/** 割引のある注文（5,000 × 3 に割引 1,000、送料 500 で 14,500）。1 個の返金は 5,000 − 333 = 4,667 */
function discountedMaterials(): RefundMaterials {
  return materials({
    lines: [
      {
        ...STOCK_LINE, orderItemId: 'item-discounted', name: 'リネンシャツ', itemPrice: 5000, quantity: 3, lineTotal: 15000,
        unshipped: 3, restockable: 3, lineDiscount: 1000,
      },
    ],
    order: {
      totalAmount: 14500, shippingAmount: 500, discountAmount: 1000, paidAmount: 14500,
      refundableAmount: 14500, refundableShipping: 500, unshippedTotal: 3,
    },
  });
}

/** 返せる額（300）が返せる送料（500）より小さい注文（前に額だけを返して、残りが少ない）。未発送のブラウス 1 */
function lowRefundableMaterials(): RefundMaterials {
  return materials({
    lines: [{ ...STOCK_LINE, itemPrice: 500, quantity: 1, lineTotal: 500, unshipped: 1, restockable: 1 }],
    order: {
      totalAmount: 1000, shippingAmount: 500, paidAmount: 1000, succeededAmount: 700,
      refundableAmount: 300, refundableShipping: 500, shippedTotal: 0, unshippedTotal: 1,
    },
  });
}

function accepted(overrides: Partial<RefundAcceptedResponse> = {}): RefundAcceptedResponse {
  return { refundId: 'refund-1', status: 'pending', amount: 54800, replayed: false, ...overrides };
}

/** 画面を開き、返金の材料を読み終えるまで待つ（読み込み中の文が消える） */
async function openDialog(loaded: RefundMaterials = materials()) {
  mockClientFetch.mockResolvedValueOnce(json(loaded));
  const props = { onClose: jest.fn(), onRefunded: jest.fn(), onUncertain: jest.fn() };
  const utils = render(<OrderRefundDialog orderId={ORDER_ID} {...props} />);
  const dialog = await screen.findByRole('dialog', { name: '返金' });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return { ...utils, ...props, props, dialog };
}

/** n 番目（0 始まり）の呼び出しが窓口へ送った本文 */
function requestBodyOf(callIndex: number): Record<string, unknown> {
  const init = mockClientFetch.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** 区分（発送前・発送済み）の領域の中の、商品の行の「返金する数」の入力。同じ商品が両方の区分に出るので、区分で絞って探す */
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

/** 発送前の商品を全部選ぶ（ブラウス 2・コート 1）。1つも発送していない注文なので、送料と返金額が全部に固定される */
function selectAllBeforeShipment(dialog: HTMLElement) {
  fireEvent.change(blouseBefore(dialog), { target: { value: '2' } });
  fireEvent.change(coatBefore(dialog), { target: { value: '1' } });
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderRefundDialog の材料と画面', () => {
  it('開くと返金の材料を読み、発送前の商品を並べる。最初は何も選ばず、返金のボタンは押せない', async () => {
    const { dialog } = await openDialog();

    expect(mockClientFetch).toHaveBeenCalledWith(REFUND_URL, { cache: 'no-store' });
    const before = within(dialog).getByRole('region', { name: BEFORE });
    expect(within(before).getByRole('heading', { name: BEFORE })).toBeInTheDocument();
    const blouse = within(before).getByRole('group', { name: 'シルクブラウス（白 / M）' });
    expect(within(blouse).getByText('在庫')).toBeInTheDocument();
    expect(within(blouse).getByLabelText('返金する数')).toHaveValue(0);
    expect(within(blouse).getByLabelText('返金する数')).toHaveAttribute('max', '2');
    const coat = within(before).getByRole('group', { name: 'ウールコート（黒 / L）' });
    expect(within(coat).getByText('受注生産')).toBeInTheDocument();
    expect(within(coat).getByLabelText('返金する数')).toHaveAttribute('max', '1');
    // 発送済みの商品が無い注文には、その見出しも注意も出さない
    expect(within(dialog).queryByRole('region', { name: AFTER })).not.toBeInTheDocument();
    expect(within(dialog).queryByText('品物が戻る時は、先に返品を作ってください。')).not.toBeInTheDocument();
    // 送料・返金額・内訳・理由・メモ・メール・注意書き
    expect(shippingInput(dialog)).toHaveValue(0);
    expect(within(dialog).getByText('返せる送料: ￥800')).toBeInTheDocument();
    expect(amountInput(dialog)).toHaveValue(0);
    expect(within(dialog).getByText('返せる額: ￥54,800')).toBeInTheDocument();
    expect(breakdownRow(dialog, '商品')).toBe('商品￥0');
    expect(breakdownRow(dialog, '割引')).toBe('割引￥0');
    expect(breakdownRow(dialog, '送料')).toBe('送料￥0');
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥0');
    expect(within(dialog).getByRole('combobox', { name: 'Stripe に伝える理由' })).toHaveValue('requested_by_customer');
    expect(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' })).toHaveValue('');
    expect(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' })).toBeChecked();
    expect(within(dialog).getByText('返金は取り消せません。')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'すべて選ぶ' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '￥0 を返金する' })).toBeDisabled();
  });

  it('発送前の商品と発送済みの商品に分けて並べる。両方に数がある商品は両方に出る', async () => {
    const { dialog } = await openDialog(shippedMaterials());

    const before = within(dialog).getByRole('region', { name: BEFORE });
    expect(within(before).getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'シルクブラウス（白 / M）',
      'ウールパンツ（2）',
    ]);
    const after = within(dialog).getByRole('region', { name: AFTER });
    expect(within(after).getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'ウールパンツ（2）',
      'レザーベルト（茶）',
    ]);
    // 上限は、発送前は未発送の数、発送済みは発送後に返せる数
    expect(quantityInput(dialog, BEFORE, 'ウールパンツ（2）')).toHaveAttribute('max', '2');
    expect(quantityInput(dialog, AFTER, 'ウールパンツ（2）')).toHaveAttribute('max', '1');
    expect(quantityInput(dialog, AFTER, 'レザーベルト（茶）')).toHaveAttribute('max', '1');
    // 発送済みの注意は、発送済みの見出しの下だけに出る
    expect(within(after).getByText('品物が戻る時は、先に返品を作ってください。')).toBeInTheDocument();
    expect(within(before).queryByText('品物が戻る時は、先に返品を作ってください。')).not.toBeInTheDocument();
  });

  it('返金する数は 0 から上限までに収まる', async () => {
    const { dialog } = await openDialog();
    const input = blouseBefore(dialog);

    fireEvent.change(input, { target: { value: '1' } });
    expect(input).toHaveValue(1);
    fireEvent.change(input, { target: { value: '9' } });
    expect(input).toHaveValue(2);
    fireEvent.change(input, { target: { value: '-4' } });
    expect(input).toHaveValue(0);
  });

  it('「在庫に戻す」は、発送前の在庫の品を選んだ時だけ出て、最初から入っている', async () => {
    const { dialog } = await openDialog(shippedMaterials());
    expect(within(dialog).queryByRole('checkbox', { name: '在庫に戻す' })).not.toBeInTheDocument();

    fireEvent.change(quantityInput(dialog, BEFORE, 'シルクブラウス（白 / M）'), { target: { value: '1' } });
    expect(within(dialog).getByRole('checkbox', { name: '在庫に戻す' })).toBeChecked();
    expect(within(dialog).getByText('発送前の在庫の品を、すぐ出せる数に戻します。')).toBeInTheDocument();

    fireEvent.change(quantityInput(dialog, BEFORE, 'シルクブラウス（白 / M）'), { target: { value: '0' } });
    expect(within(dialog).queryByRole('checkbox', { name: '在庫に戻す' })).not.toBeInTheDocument();

    // 発送済みの商品だけを選んでも出ない（品物が戻る時は、先に返品を作る）
    fireEvent.change(quantityInput(dialog, AFTER, 'レザーベルト（茶）'), { target: { value: '1' } });
    expect(within(dialog).queryByRole('checkbox', { name: '在庫に戻す' })).not.toBeInTheDocument();
  });

  it('受注生産の品を発送前に選ぶと、在庫には戻らない注意が出る。在庫の品を選ばない間は「在庫に戻す」も出ない', async () => {
    const { dialog } = await openDialog();
    const notice =
      '受注生産の品は在庫を確保していないため、在庫には戻りません。仕上がった品を売る時は、商品の在庫の画面で「入荷」してください。';
    expect(within(dialog).queryByText(notice)).not.toBeInTheDocument();

    fireEvent.change(coatBefore(dialog), { target: { value: '1' } });
    expect(within(dialog).getByText(notice)).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: '在庫に戻す' })).not.toBeInTheDocument();

    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    expect(within(dialog).getByText(notice)).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: '在庫に戻す' })).toBeChecked();

    fireEvent.change(coatBefore(dialog), { target: { value: '0' } });
    expect(within(dialog).queryByText(notice)).not.toBeInTheDocument();
  });

  it('在庫に戻せる数が 0 の品（在庫を確保できなかった注文）を選んでも、「在庫に戻す」は出さない', async () => {
    const { dialog } = await openDialog(materials({ lines: [{ ...STOCK_LINE, restockable: 0 }, BACKORDER_LINE] }));

    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });

    expect(within(dialog).queryByRole('checkbox', { name: '在庫に戻す' })).not.toBeInTheDocument();
    expect(within(dialog).queryByText('発送前の在庫の品を、すぐ出せる数に戻します。')).not.toBeInTheDocument();
  });

  it.each([
    ['card', 'お金はカード会社によって、5〜10営業日ほどで戻ります。'],
    ['link', 'お金はカード会社によって、5〜10営業日ほどで戻ります。'],
    ['paypay', 'お金は PayPay 残高にすぐ戻ります。'],
    [
      'konbini',
      'コンビニ払いの返金は、お客様に返金先の口座を入れてもらう必要があります（Stripe からお客様にメールが届きます。45日以内）。',
    ],
    ['unknown', 'お金が戻るまでの日数は、お支払いの方法によって異なります。'],
  ] as const)('支払い方法 %s の案内を、商品の一覧の前（画面の上）に出す', async (paymentMethod, note) => {
    const { dialog } = await openDialog(materials({ order: { paymentMethod } }));

    const guide = within(dialog).getByText(note);
    const before = within(dialog).getByRole('region', { name: BEFORE });
    expect(guide.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async () => {
    const { dialog } = await openDialog();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });

  it('orderId が null の間は閉じていて、窓口を読まない', () => {
    render(<OrderRefundDialog orderId={null} onClose={jest.fn()} onRefunded={jest.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it('閉じて開き直すと、材料を読み直し、入力は既定へ戻り、二重防止の番号も新しくなる', async () => {
    const { rerender, dialog, props } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(accepted()));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Stripe に伝える理由' }), { target: { value: 'duplicate' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' }), { target: { value: '二重に払われた' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' }));
    selectAllBeforeShipment(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '￥54,800 を返金する' }));
    await waitFor(() => expect(props.onRefunded).toHaveBeenCalledTimes(1));
    const firstKey = requestBodyOf(1).requestKey;

    rerender(<OrderRefundDialog orderId={null} {...props} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    mockClientFetch.mockResolvedValueOnce(json(materials())).mockResolvedValueOnce(json(accepted()));
    rerender(<OrderRefundDialog orderId={ORDER_ID} {...props} />);
    const reopened = await screen.findByRole('dialog', { name: '返金' });
    await waitFor(() => expect(within(reopened).queryByText('読み込み中です...')).not.toBeInTheDocument());

    expect(mockClientFetch).toHaveBeenCalledTimes(3);
    expect(blouseBefore(reopened)).toHaveValue(0);
    expect(within(reopened).getByRole('combobox', { name: 'Stripe に伝える理由' })).toHaveValue('requested_by_customer');
    expect(within(reopened).getByRole('textbox', { name: 'メモ（お客様には見えません）' })).toHaveValue('');
    expect(within(reopened).getByRole('checkbox', { name: 'お客様に返金のメールを送る' })).toBeChecked();
    selectAllBeforeShipment(reopened);
    fireEvent.click(within(reopened).getByRole('button', { name: '￥54,800 を返金する' }));
    await waitFor(() => expect(props.onRefunded).toHaveBeenCalledTimes(2));
    expect(requestBodyOf(3)).toMatchObject({ stripeReason: 'requested_by_customer', note: null, notifyCustomer: true });
    expect(requestBodyOf(3).requestKey).not.toBe(firstKey);
  });
});

describe('OrderRefundDialog の金額', () => {
  it('「すべて選ぶ」は、残りの商品の全部（発送前も発送済みも）と送料の全部を入れる', async () => {
    const { dialog } = await openDialog(shippedMaterials());

    fireEvent.click(within(dialog).getByRole('button', { name: 'すべて選ぶ' }));

    expect(quantityInput(dialog, BEFORE, 'シルクブラウス（白 / M）')).toHaveValue(2);
    expect(quantityInput(dialog, BEFORE, 'ウールパンツ（2）')).toHaveValue(2);
    expect(quantityInput(dialog, AFTER, 'ウールパンツ（2）')).toHaveValue(1);
    expect(quantityInput(dialog, AFTER, 'レザーベルト（茶）')).toHaveValue(1);
    expect(shippingInput(dialog)).toHaveValue(800);
    expect(breakdownRow(dialog, '商品')).toBe('商品￥87,000');
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥87,800');
    expect(amountInput(dialog)).toHaveValue(87800);
    expect(within(dialog).getByRole('button', { name: '￥87,800 を返金する' })).toBeEnabled();
    // 発送した商品がある注文なので、送料と返金額は固定されない
    expect(shippingInput(dialog)).toBeEnabled();
    expect(amountInput(dialog)).toBeEnabled();
  });

  it('数と送料から内訳（商品・割引・送料・返金額）を出し、返金額の入力は内訳の合計から始まる', async () => {
    const { dialog } = await openDialog(discountedMaterials());
    const shirt = (value: string) =>
      fireEvent.change(quantityInput(dialog, BEFORE, 'リネンシャツ（白 / M）'), { target: { value } });

    shirt('1');
    expect(breakdownRow(dialog, '商品')).toBe('商品￥5,000');
    expect(breakdownRow(dialog, '割引')).toBe(`割引${MINUS}￥333`);
    expect(breakdownRow(dialog, '送料')).toBe('送料￥0');
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥4,667');
    expect(amountInput(dialog)).toHaveValue(4667);

    fireEvent.change(shippingInput(dialog), { target: { value: '500' } });
    expect(breakdownRow(dialog, '送料')).toBe('送料￥500');
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥5,167');
    expect(amountInput(dialog)).toHaveValue(5167);
    expect(within(dialog).getByRole('button', { name: '￥5,167 を返金する' })).toBeEnabled();

    shirt('2');
    expect(breakdownRow(dialog, '商品')).toBe('商品￥10,000');
    expect(breakdownRow(dialog, '割引')).toBe(`割引${MINUS}￥667`);
    expect(amountInput(dialog)).toHaveValue(9833);
  });

  it('返金額は手で直せて、上限は返せる額。商品の数を変えると内訳の合計に戻る', async () => {
    const { dialog } = await openDialog();
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    expect(amountInput(dialog)).toHaveValue(12000);

    fireEvent.change(amountInput(dialog), { target: { value: '5000' } });
    expect(amountInput(dialog)).toHaveValue(5000);
    expect(within(dialog).getByRole('button', { name: '￥5,000 を返金する' })).toBeEnabled();
    // 内訳は、数と送料から出した見込みのまま
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥12,000');

    fireEvent.change(amountInput(dialog), { target: { value: '99999999' } });
    expect(amountInput(dialog)).toHaveValue(54800);

    fireEvent.change(amountInput(dialog), { target: { value: '0' } });
    expect(within(dialog).getByRole('button', { name: '￥0 を返金する' })).toBeDisabled();

    fireEvent.change(blouseBefore(dialog), { target: { value: '2' } });
    expect(amountInput(dialog)).toHaveValue(24000);
  });

  it('送料は 0 から返せる送料までに収まる', async () => {
    const { dialog } = await openDialog();

    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });
    expect(shippingInput(dialog)).toHaveValue(300);
    fireEvent.change(shippingInput(dialog), { target: { value: '5000' } });
    expect(shippingInput(dialog)).toHaveValue(800);
    fireEvent.change(shippingInput(dialog), { target: { value: '-1' } });
    expect(shippingInput(dialog)).toHaveValue(0);
  });

  it('返せる送料が無い注文では、送料の入力を止める', async () => {
    const { dialog } = await openDialog(
      materials({
        order: { totalAmount: 54000, shippingAmount: 0, paidAmount: 54000, refundableAmount: 54000, refundableShipping: 0 },
      }),
    );

    expect(shippingInput(dialog)).toBeDisabled();
    expect(within(dialog).getByText('返せる送料: ￥0')).toBeInTheDocument();
  });

  it('返金額が送料より小さい間は、返金のボタンを押せない（DB は送料 ≤ 額を入力の誤りにする）', async () => {
    const { dialog } = await openDialog();
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.change(shippingInput(dialog), { target: { value: '500' } });

    fireEvent.change(amountInput(dialog), { target: { value: '300' } });
    expect(within(dialog).getByRole('button', { name: '￥300 を返金する' })).toBeDisabled();

    fireEvent.change(amountInput(dialog), { target: { value: '500' } });
    expect(within(dialog).getByRole('button', { name: '￥500 を返金する' })).toBeEnabled();
  });

  it('1つも発送していない注文の商品を全部選ぶと、送料と返金額が全部に固定され、入力が止まって注意が出る。1つ減らすと戻る', async () => {
    const { dialog } = await openDialog();
    const notice = 'まだ発送していない注文の商品を全部返すので、送料と返金額も全部返します。';
    fireEvent.change(blouseBefore(dialog), { target: { value: '2' } });
    expect(within(dialog).queryByText(notice)).not.toBeInTheDocument();
    expect(shippingInput(dialog)).toBeEnabled();

    fireEvent.change(coatBefore(dialog), { target: { value: '1' } });

    expect(within(dialog).getByText(notice)).toBeInTheDocument();
    expect(shippingInput(dialog)).toHaveValue(800);
    expect(shippingInput(dialog)).toBeDisabled();
    expect(amountInput(dialog)).toHaveValue(54800);
    expect(amountInput(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '￥54,800 を返金する' })).toBeEnabled();

    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });

    expect(within(dialog).queryByText(notice)).not.toBeInTheDocument();
    expect(shippingInput(dialog)).toBeEnabled();
    expect(shippingInput(dialog)).toHaveValue(0);
    expect(amountInput(dialog)).toBeEnabled();
    expect(amountInput(dialog)).toHaveValue(42000);
  });

  it('発送した商品がある注文は、発送前の商品を全部選んでも、送料と返金額を固定しない', async () => {
    const { dialog } = await openDialog(shippedMaterials());

    fireEvent.change(quantityInput(dialog, BEFORE, 'シルクブラウス（白 / M）'), { target: { value: '2' } });
    fireEvent.change(quantityInput(dialog, BEFORE, 'ウールパンツ（2）'), { target: { value: '2' } });

    expect(
      within(dialog).queryByText('まだ発送していない注文の商品を全部返すので、送料と返金額も全部返します。'),
    ).not.toBeInTheDocument();
    expect(shippingInput(dialog)).toBeEnabled();
    expect(amountInput(dialog)).toBeEnabled();
  });

  it('返せる額が返せる送料より小さい注文で、未発送の商品を全部選ぶと、送料も返金額も返せる額に固定される（DB の REFUND_MUST_BE_FULL）', async () => {
    const { dialog, onRefunded } = await openDialog(lowRefundableMaterials());
    mockClientFetch.mockResolvedValueOnce(json(accepted({ amount: 300 })));

    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });

    // 送料は min(返せる送料 500, 返せる額 300) = 300。「返せる送料」の表示は、そのまま 500
    expect(within(dialog).getByText('返せる送料: ￥500')).toBeInTheDocument();
    expect(shippingInput(dialog)).toHaveValue(300);
    expect(shippingInput(dialog)).toBeDisabled();
    expect(amountInput(dialog)).toHaveValue(300);
    expect(amountInput(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '￥300 を返金する' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '￥300 を返金する' }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toMatchObject({ shippingAmount: 300, amount: 300 });
  });

  it('返せる額が返せる送料より小さい注文で、発送した商品がある時も、「すべて選ぶ」の送料は返せる額までにする（返金のボタンが押せなくならない）', async () => {
    const { dialog } = await openDialog(
      materials({
        lines: [SHIPPED_LINE],
        order: {
          totalAmount: 9500, shippingAmount: 500, paidAmount: 9500, succeededAmount: 9200,
          refundableAmount: 300, refundableShipping: 500, shippedTotal: 1, unshippedTotal: 0,
        },
      }),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'すべて選ぶ' }));

    // 発送した商品があるので固定はされない。送料は、返せる額（300）を超えない 300
    expect(quantityInput(dialog, AFTER, 'レザーベルト（茶）')).toHaveValue(1);
    expect(shippingInput(dialog)).toHaveValue(300);
    expect(shippingInput(dialog)).toBeEnabled();
    expect(amountInput(dialog)).toHaveValue(300);
    expect(within(dialog).getByRole('button', { name: '￥300 を返金する' })).toBeEnabled();
  });

  it('取り消した注文に届いた入金は、「すべて選ぶ」で全額を返せる。在庫に戻せる数は0なので「在庫に戻す」は出ない（P28）', async () => {
    const { dialog, onRefunded } = await openDialog(
      materials({ lines: [{ ...STOCK_LINE, restockable: 0 }, BACKORDER_LINE], order: { status: 'cancelled' } }),
    );
    mockClientFetch.mockResolvedValueOnce(json(accepted()));

    fireEvent.click(within(dialog).getByRole('button', { name: 'すべて選ぶ' }));

    expect(blouseBefore(dialog)).toHaveValue(2);
    expect(coatBefore(dialog)).toHaveValue(1);
    expect(shippingInput(dialog)).toHaveValue(800);
    expect(amountInput(dialog)).toHaveValue(54800);
    expect(within(dialog).queryByRole('checkbox', { name: '在庫に戻す' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '￥54,800 を返金する' }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toMatchObject({
      lines: [
        { orderItemId: 'item-stock', quantity: 2, beforeShipment: true },
        { orderItemId: 'item-backorder', quantity: 1, beforeShipment: true },
      ],
      shippingAmount: 800,
      amount: 54800,
    });
  });

  it('Stripe に伝える理由は「お客様の希望」から始まり、「不正の疑い」を選ぶと注意が出る', async () => {
    const { dialog } = await openDialog();
    const select = within(dialog).getByRole('combobox', { name: 'Stripe に伝える理由' });
    const notice = '「不正の疑い」を選ぶと、Stripe がこのカードとメールアドレスを拒否の一覧に入れます。';

    expect(select).toHaveValue('requested_by_customer');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'お客様の希望',
      '重複した支払い',
      '不正の疑い',
    ]);
    expect(within(dialog).queryByText(notice)).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'fraudulent' } });
    expect(within(dialog).getByText(notice)).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'duplicate' } });
    expect(within(dialog).queryByText(notice)).not.toBeInTheDocument();
  });
});

describe('OrderRefundDialog の返金', () => {
  it('全部を返す: 発送前の商品の全部・送料の全部・返せる額の全部を、二重防止の番号つきで窓口へ送り、結果を親へ渡す', async () => {
    const { dialog, onRefunded, onClose } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(accepted()));
    selectAllBeforeShipment(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '￥54,800 を返金する' }));

    await waitFor(() => expect(onRefunded).toHaveBeenCalledWith(accepted()));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, REFUND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [
        { orderItemId: 'item-stock', quantity: 2, beforeShipment: true },
        { orderItemId: 'item-backorder', quantity: 1, beforeShipment: true },
      ],
      restock: true,
      shippingAmount: 800,
      amount: 54800,
      note: null,
      stripeReason: 'requested_by_customer',
      notifyCustomer: true,
    });
    // 閉じるのは親。画面が自分で閉じることはしない
    expect(onClose).not.toHaveBeenCalled();
  });

  it('一部を返す: 商品・送料・額・メモ・理由・知らせる・在庫に戻すの選びを、そのまま送る', async () => {
    const { dialog, onRefunded } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(accepted({ status: 'succeeded', amount: 11000 })));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });
    fireEvent.change(amountInput(dialog), { target: { value: '11000' } });
    const memo = within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' });
    expect(memo).toHaveAttribute('maxlength', '500');
    fireEvent.change(memo, { target: { value: '  重複して決済された  ' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Stripe に伝える理由' }), { target: { value: 'duplicate' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '在庫に戻す' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '￥11,000 を返金する' }));

    await waitFor(() => expect(onRefunded).toHaveBeenCalledWith(accepted({ status: 'succeeded', amount: 11000 })));
    expect(requestBodyOf(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [{ orderItemId: 'item-stock', quantity: 1, beforeShipment: true }],
      restock: false,
      shippingAmount: 300,
      amount: 11000,
      note: '重複して決済された',
      stripeReason: 'duplicate',
      notifyCustomer: false,
    });
  });

  it('発送前と発送済みを分けて送る（同じ商品でも、区分ごとに1行）', async () => {
    const { dialog, onRefunded } = await openDialog(shippedMaterials());
    mockClientFetch.mockResolvedValueOnce(json(accepted()));
    fireEvent.change(quantityInput(dialog, BEFORE, 'ウールパンツ（2）'), { target: { value: '1' } });
    fireEvent.change(quantityInput(dialog, AFTER, 'ウールパンツ（2）'), { target: { value: '1' } });
    fireEvent.change(quantityInput(dialog, AFTER, 'レザーベルト（茶）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥45,000 を返金する' }));

    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).lines).toEqual([
      { orderItemId: 'item-partly', quantity: 1, beforeShipment: true },
      { orderItemId: 'item-partly', quantity: 1, beforeShipment: false },
      { orderItemId: 'item-shipped', quantity: 1, beforeShipment: false },
    ]);
    expect(requestBodyOf(1)).toMatchObject({ restock: true, shippingAmount: 0, amount: 45000 });
  });

  it('「キャンセル」では送らずに閉じる（答えが分からない状態ではないので、一覧の読み直しは頼まない）', async () => {
    const { dialog, onClose, onRefunded, onUncertain } = await openDialog();
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();
    expect(onRefunded).not.toHaveBeenCalled();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('送っている間は返金のボタンを押せず、二重に送らない', async () => {
    const { dialog, onRefunded } = await openDialog();
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));

    expect(within(dialog).getByRole('button', { name: '￥12,000 を返金する' })).toBeDisabled();
    expect(blouseBefore(dialog)).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);

    resolvePost(json(accepted()));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
  });

  it('送っている間は画面を閉じられない（キャンセルも Esc も背景も効かない）。返事が来たら親へ渡す', async () => {
    const { dialog, onClose, onRefunded, onUncertain } = await openDialog();
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));

    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(dialog.closest('[data-ui-dialog]') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();

    resolvePost(json(accepted()));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it('Enter キーでは返金を送らない（数や額の欄でも、チェックでも）。メモの欄の Enter は改行のまま', async () => {
    const { dialog } = await openDialog();
    const quantity = blouseBefore(dialog);
    fireEvent.change(quantity, { target: { value: '1' } });

    // preventDefault されている（フォームの送信にならない）
    expect(fireEvent.keyDown(quantity, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(amountInput(dialog), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' }), { key: 'Enter' })).toBe(false);
    // メモの欄は改行に使う。ボタンの Enter は押す動き
    expect(fireEvent.keyDown(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' }), { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }), { key: 'Enter' })).toBe(true);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });
});

describe('OrderRefundDialog の窓口の断り', () => {
  it('最初の送信が403で処理前に断られても、次の送信は同じ二重防止の番号を使う', async () => {
    const { dialog, onRefunded } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json(accepted()));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('この操作の権限がありません。');
    expect(blouseBefore(dialog)).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).toBe(requestBodyOf(1).requestKey);
  });

  it('窓口が断ったら、その文を画面の中に出し、入力は残して、次の送信は新しい二重防止の番号にする', async () => {
    const { dialog, onRefunded } = await openDialog();
    const message = '返せる額を超えています。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'exceeds_refundable' }, 409))
      .mockResolvedValueOnce(json(accepted()));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onRefunded).not.toHaveBeenCalled();
    expect(blouseBefore(dialog)).toHaveValue(1);
    expect(within(dialog).getByRole('button', { name: '￥12,000 を返金する' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).toMatch(UUID_PATTERN);
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(1).requestKey);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Stripe が受け付けなかった（422）時も、窓口の文をそのまま出し、新しい二重防止の番号で送り直せる', async () => {
    const { dialog, onRefunded } = await openDialog();
    const message = 'Stripe が返金を受け付けませんでした（カードが使えません）。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'stripe_rejected', refundId: 'refund-1' }, 422))
      .mockResolvedValueOnce(json(accepted()));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(blouseBefore(dialog)).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(1).requestKey);
  });

  it('権限が無い・認証が切れた時は固定の文、回数の制限（英語の短い文）は回数の制限の固定の文を出す（「記録に失敗しました」とは言わない）', async () => {
    const { dialog } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });

    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    expect(await within(dialog).findByText('この操作の権限がありません。')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    expect(await within(dialog).findByText(RATE_LIMITED)).toBeInTheDocument();
    expect(within(dialog).queryByText('返金の記録に失敗しました。')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Too many requests')).not.toBeInTheDocument();
  });
});

const UNKNOWN_ANSWERS: Array<[string, () => Promise<unknown>]> = [
  ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['サーバーが失敗した（500）', () => Promise.resolve(json({ error: '返金の記録に失敗しました。', code: 'failed' }, 500))],
  [
    'Stripe の返事を確かめられなかった（502）',
    () => Promise.resolve(json({ error: UNKNOWN_OUTCOME, code: 'unknown_outcome', refundId: 'refund-1' }, 502)),
  ],
];

describe('OrderRefundDialog の答えが分からない時', () => {
  it.each([
    [401, '認証が必要です。再ログインしてください。'],
    [403, 'この操作の権限がありません。'],
    [429, RATE_LIMITED],
  ])('再送が%iで処理前に断られても結果不明のまま、次も同じ番号・同じ本文で送る', async (status, message) => {
    const { dialog, onRefunded, onUncertain } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: 'Blocked' }, status))
      .mockResolvedValueOnce(json(accepted({ replayed: true })));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' }), { target: { value: '電話で依頼' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    // 断りの文の後ろに、答えが分からない時の文を続けて出す（取り消せない操作の結果が分からないことを、断りの文で隠さない）
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(`${message}${UNKNOWN_OUTCOME}`));
    expect(blouseBefore(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: /を返金する$/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '閉じる' })).toBeEnabled();
    expect(mockClientFetch).toHaveBeenCalledTimes(3);

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledWith(accepted({ replayed: true })));
    expect(mockClientFetch.mock.calls.slice(1).map(([url, init]) => [url, (init as RequestInit).body])).toEqual([
      [REFUND_URL, (mockClientFetch.mock.calls[1][1] as RequestInit).body],
      [REFUND_URL, (mockClientFetch.mock.calls[1][1] as RequestInit).body],
      [REFUND_URL, (mockClientFetch.mock.calls[1][1] as RequestInit).body],
    ]);
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it('答えが分からない間の再送が429で断られても、回数の制限の文と答えが分からない時の文の両方を出す。番号と中身は同じまま、押せるのは「閉じる」と「もう一度確かめる」だけ', async () => {
    const { dialog, onRefunded } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429))
      .mockResolvedValueOnce(json(accepted({ replayed: true })));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    const alert = await within(dialog).findByRole('alert');
    await waitFor(() => expect(alert).toHaveTextContent(`${RATE_LIMITED}${UNKNOWN_OUTCOME}`));
    // 取り消せない操作の結果が分からないのに「記録に失敗しました」（失敗した）と読ませない
    expect(alert).not.toHaveTextContent('返金の記録に失敗しました。');
    const enabledButtons = within(dialog)
      .getAllByRole('button')
      .filter((button) => !(button as HTMLButtonElement).disabled)
      .map((button) => button.textContent);
    expect(enabledButtons).toEqual(['閉じる', 'もう一度確かめる']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledWith(accepted({ replayed: true })));
    // 429 で断られても、3回目は最初の送信と同じ二重防止の番号・同じ本文
    expect(requestBodyOf(3)).toEqual(requestBodyOf(1));
    expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
  });

  it('結果不明の再送が403で処理前に断られた後に閉じても、一覧の読み直しを親に頼む', async () => {
    const { dialog, onClose, onUncertain } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('この操作の権限がありません。'));

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(UNKNOWN_ANSWERS)(
    '%s時は、入力を止めて「もう一度確かめる」と「閉じる」だけを出し、同じ二重防止の番号・同じ中身で確かめ直す',
    async (_label, firstAnswer) => {
      const { dialog, onRefunded, onClose, onUncertain } = await openDialog();
      mockClientFetch.mockImplementationOnce(firstAnswer).mockResolvedValueOnce(json(accepted({ replayed: true })));
      fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
      // 入力は変えられない
      expect(blouseBefore(dialog)).toBeDisabled();
      expect(coatBefore(dialog)).toBeDisabled();
      expect(shippingInput(dialog)).toBeDisabled();
      expect(amountInput(dialog)).toBeDisabled();
      expect(within(dialog).getByRole('combobox', { name: 'Stripe に伝える理由' })).toBeDisabled();
      expect(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' })).toBeDisabled();
      expect(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' })).toBeDisabled();
      expect(within(dialog).getByRole('checkbox', { name: '在庫に戻す' })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'すべて選ぶ' })).toBeDisabled();
      // 操作は「もう一度確かめる」と「閉じる」だけ
      expect(within(dialog).queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: /を返金する$/ })).not.toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: '閉じる' })).toBeEnabled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
      await waitFor(() => expect(onRefunded).toHaveBeenCalledWith(accepted({ replayed: true })));
      // 同じ二重防止の番号・同じ中身で送り直す（Stripe が返金を作っていても、DB は前の記録を返し、返金は1件のまま）
      expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
      expect(onClose).not.toHaveBeenCalled();
      expect(onUncertain).not.toHaveBeenCalled();
    },
  );

  it('確かめ直しても分からない時は、そのまま止まる。「閉じる」で閉じる時に、一覧の読み直しを親に頼む', async () => {
    const { dialog, onRefunded, onClose, onUncertain } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'もう一度確かめる' })).toBeEnabled());

    expect(within(dialog).getByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(onRefunded).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 409, 422])('再送が%iで断られたら、材料を読み直し、入力を戻して新しい番号で送れる', async (status) => {
    const { dialog, onRefunded } = await openDialog();
    const message = '返せる額を超えています。';
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: message, code: 'exceeds_refundable' }, status))
      .mockResolvedValueOnce(json(materials({ order: { refundableAmount: 10000 } })))
      .mockResolvedValueOnce(json(accepted()));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(within(dialog).getByRole('button', { name: '￥10,000 を返金する' })).toBeEnabled());
    expect(within(dialog).getByRole('alert')).toHaveTextContent(message);
    expect(mockClientFetch).toHaveBeenNthCalledWith(4, REFUND_URL, { cache: 'no-store' });
    expect(blouseBefore(dialog)).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '￥10,000 を返金する' }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(4).requestKey).not.toBe(requestBodyOf(1).requestKey);
  });

  it('再送が409で断られた後の材料の読み直しが失敗したら、その文を出す', async () => {
    const { dialog, onRefunded } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: '返せる額を超えています。' }, 409))
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('この操作の権限がありません。'));
    expect(mockClientFetch).toHaveBeenNthCalledWith(4, REFUND_URL, { cache: 'no-store' });
    expect(blouseBefore(dialog)).toBeEnabled();
    expect(onRefunded).not.toHaveBeenCalled();
  });

  it('Escape で閉じる。答えが分からない時だけ、一覧の読み直しを親に頼む', async () => {
    const { dialog, onClose, onUncertain } = await openDialog();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();

    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.change(blouseBefore(dialog), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥12,000 を返金する' }));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onUncertain).toHaveBeenCalledTimes(1);
  });
});

describe('OrderRefundDialog の材料を読めない時と確かめ中の返金', () => {
  it('confirmが断られた後の材料の読み直しが失敗したら、その文を出す', async () => {
    const { dialog, onRefunded } = await openDialog(
      materials({ awaitingRefund: { id: 'refund-awaiting', amount: 12000, createdAt: '2026-10-11T01:00:00.000Z' } }),
    );
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Stripe が返金を受け付けませんでした。' }, 422))
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('この操作の権限がありません。'));
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, REFUND_URL, { cache: 'no-store' });
    expect(within(dialog).getByRole('button', { name: 'もう一度確かめる' })).toBeEnabled();
    expect(onRefunded).not.toHaveBeenCalled();
  });

  it.each([
    [404, { error: '注文が見つかりません。', code: 'order_not_found' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '返金の材料を読み込めませんでした。'],
  ])('材料を読めなかった時（%i）は理由と「閉じる」だけを出す', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    const onClose = jest.fn();
    render(<OrderRefundDialog orderId={ORDER_ID} onClose={onClose} onRefunded={jest.fn()} onUncertain={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '返金' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['閉じる']);
    expect(within(dialog).queryByLabelText('返金額')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('確かめ中の返金がある注文は、入力を出さず、文と「もう一度確かめる」「閉じる」だけを出す。確かめ直しの窓口へ記録の番号を送る', async () => {
    const { dialog, onRefunded } = await openDialog(
      materials({ awaitingRefund: { id: 'refund-awaiting', amount: 12000, createdAt: '2026-10-11T01:00:00.000Z' } }),
    );

    expect(within(dialog).getByText('確かめ中の返金があります（￥12,000）。')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('返金額')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('region', { name: BEFORE })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);

    mockClientFetch.mockResolvedValueOnce(json(accepted({ refundId: 'refund-awaiting', replayed: true })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onRefunded).toHaveBeenCalledWith(accepted({ refundId: 'refund-awaiting', replayed: true })));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, CONFIRM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refundId: 'refund-awaiting' }),
    });
  });

  it('確かめ直しが断られたら（Stripe が受け付けなかった）その文を出し、材料を読み直して返金の入力を出す', async () => {
    const { dialog, onRefunded } = await openDialog(
      materials({ awaitingRefund: { id: 'refund-awaiting', amount: 12000, createdAt: '2026-10-11T01:00:00.000Z' } }),
    );
    const rejected = 'Stripe が返金を受け付けませんでした（Stripe に届きませんでした）。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: rejected, code: 'stripe_rejected', refundId: 'refund-awaiting' }, 422))
      // 読み直した材料。記録はもうエラーなので、返事待ちは無い
      .mockResolvedValueOnce(json(materials()));

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    // 断りの文は残り、返金の入力が出る（閉じて開き直さなくても、返金をやり直せる）
    expect(await within(dialog).findByLabelText('返金額')).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(rejected);
    expect(within(dialog).queryByText(/確かめ中の返金があります/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBeEnabled();
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, REFUND_URL, { cache: 'no-store' });
    expect(onRefunded).not.toHaveBeenCalled();
  });

  it('確かめ直しの答えが分からない時は、同じ呼び出しで送り直す', async () => {
    const { dialog, onRefunded, onUncertain } = await openDialog(
      materials({ awaitingRefund: { id: 'refund-awaiting', amount: 12000, createdAt: '2026-10-11T01:00:00.000Z' } }),
    );
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(accepted({ refundId: 'refund-awaiting', replayed: true })));

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME));

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
    expect(mockClientFetch.mock.calls.slice(1).map(([url]) => url)).toEqual([CONFIRM_URL, CONFIRM_URL]);
    expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
    expect(onUncertain).not.toHaveBeenCalled();
  });
});
