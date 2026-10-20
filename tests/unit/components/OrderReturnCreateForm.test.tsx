import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CreateReturnResponse } from '@/components/OrderReturnCreateForm';
import type { ReturnCreateMaterials } from '@/lib/orders/returns/return-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderReturnCreateForm from '@/components/OrderReturnCreateForm';

type Materials = ReturnCreateMaterials;
type Shipment = Materials['shipments'][number];
type ShipmentLine = Shipment['lines'][number];

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const MATERIALS_URL = `/api/admin/orders/${ORDER_ID}/returns/materials`;
const RETURNS_URL = `/api/admin/orders/${ORDER_ID}/returns`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TITLE = '返品を作る（ORD-A1B2C3D4）';
const CREATE = '返品を作る';
const UNKNOWN_OUTCOME = '返品を作れたか確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
/** 回数の制限（429）で処理の前に断られた時の文。E-2 の返金の画面と同じ */
const RATE_LIMITED = '操作が続いたため受け付けませんでした。しばらく待ってから、もう一度お試しください。';
const ADDRESS_MISSING = '返送先が設定されていません。ショップの設定で返送先を入れてから作ってください。';
const NOTE_REQUIRED = '理由が「その他」の時は、理由のメモを入れてください。';
const NOT_RETURNABLE = 'この注文は返品を作れません。';
const AWAITING_REFUND = '確かめ中の返金があります。先に確かめてください。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// ブランドの最初の値（設計書 8-3）: 不良品と誤送の返送料はお店の負担、ほかはお客様
const REASON_PAYERS: Materials['settings']['reasonShippingPayers'] = {
  defective: 'shop',
  wrong_item: 'shop',
  size_too_small: 'customer',
  size_too_large: 'customer',
  color: 'customer',
  style: 'customer',
  not_as_described: 'customer',
  unwanted: 'customer',
  other: 'customer',
  unknown: 'customer',
};
const REASON_OUT_OF_STOCK: Materials['settings']['reasonOutOfStockExchange'] = {
  defective: 'make',
  wrong_item: 'make',
  size_too_small: 'decline',
  size_too_large: 'decline',
  color: 'decline',
  style: 'decline',
  not_as_described: 'decline',
  unwanted: 'decline',
  other: 'decline',
  unknown: 'decline',
};
const SETTINGS: Materials['settings'] = {
  returnAddressSet: true,
  noReturnNeededEnabled: false,
  customerPaidMethod: 'customer_ships',
  shopLabelFee: 0,
  restockingFeeEnabled: false,
  restockingFeePercent: 0,
  exchangeFeesEnabled: false,
  exchangeFee: 0,
  exchangeShippingFee: 0,
  reasonShippingPayers: REASON_PAYERS,
  reasonOutOfStockExchange: REASON_OUT_OF_STOCK,
};

/** 返せる数が2。同じ商品に、使える色・サイズが2つと使えない色・サイズが1つ */
const BLOUSE: ShipmentLine = {
  orderItemId: 'item-blouse', itemId: 11, variantId: 101, itemName: 'シルクブラウス', color: '白', size: 'M', returnIneligible: false,
  lineKind: 'order', quantity: 2, returnable: 2,
};
/** 色が無い品。サイズだけが括弧に入る */
const PANTS: ShipmentLine = {
  orderItemId: 'item-pants', itemId: 12, variantId: 201, itemName: 'ウールパンツ', color: null, size: '2', returnIneligible: false,
  lineKind: 'order', quantity: 1, returnable: 1,
};
/** 交換できる色・サイズが材料に無い品（交換を選べない） */
const BELT: ShipmentLine = {
  orderItemId: 'item-belt', itemId: 13, variantId: null, itemName: 'レザーベルト', color: '茶', size: null, returnIneligible: false,
  lineKind: 'order', quantity: 1, returnable: 1,
};

// 発送日は日本時間の日付で出す: 2026-10-10 10:30（日本時間）／2026-10-01T16:00Z は日本時間の 10月2日 の 01:00
const SHIPMENT_1: Shipment = {
  fulfillmentId: 'ful-1', number: 1, shippedAt: '2026-10-10T01:30:00.000Z',
  deadlineDate: '2026-10-20', pastDeadline: false, lines: [BLOUSE, PANTS],
};
const SHIPMENT_2: Shipment = {
  fulfillmentId: 'ful-2', number: 2, shippedAt: '2026-10-01T16:00:00.000Z',
  deadlineDate: '2026-10-11', pastDeadline: true, lines: [BELT],
};

const EXCHANGE_OPTIONS: Materials['exchangeOptions'] = [
  {
    itemId: 11,
    variants: [
      { variantId: 101, color: '白', size: 'M', isActive: true, stockQuantity: 5, madeToOrderLeadDays: null },
      { variantId: 102, color: '白', size: 'L', isActive: true, stockQuantity: 0, madeToOrderLeadDays: 14 },
      { variantId: 103, color: '黒', size: 'M', isActive: false, stockQuantity: 9, madeToOrderLeadDays: null },
      { variantId: 104, color: '青', size: 'M', isActive: true, stockQuantity: 1, madeToOrderLeadDays: 10 },
    ],
  },
  { itemId: 12, variants: [{ variantId: 201, color: null, size: '2', isActive: true, stockQuantity: 1, madeToOrderLeadDays: null }] },
];

type MaterialsOverrides = {
  order?: Partial<Materials['order']>;
  shipments?: Shipment[];
  settings?: Partial<Materials['settings']>;
};

function materials({ order = {}, shipments = [SHIPMENT_1, SHIPMENT_2], settings = {} }: MaterialsOverrides = {}): Materials {
  return {
    order: { id: ORDER_ID, status: 'shipped', hasAwaitingRefund: false, ...order },
    shipments,
    exchangeOptions: EXCHANGE_OPTIONS,
    settings: { ...SETTINGS, ...settings },
  };
}

function created(overrides: Partial<CreateReturnResponse> = {}): { data: CreateReturnResponse } {
  return { data: { returnId: 'ret-1', number: 1, status: 'open', replayed: false, ...overrides } };
}

/** 画面を開き、材料を読み終えるまで待つ（読み込み中の文が消える） */
async function openForm(loaded: Materials = materials()) {
  mockClientFetch.mockResolvedValueOnce(json({ data: loaded }));
  const props = { onClose: jest.fn(), onCreated: jest.fn(), onUncertain: jest.fn() };
  const utils = render(<OrderReturnCreateForm orderId={ORDER_ID} {...props} />);
  const dialog = await screen.findByRole('dialog', { name: TITLE });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return { ...utils, ...props, dialog };
}

/** n 番目（0 始まり）の呼び出しが窓口へ送った本文 */
function requestBodyOf(callIndex: number): Record<string, unknown> {
  const init = mockClientFetch.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const lineGroup = (dialog: HTMLElement, name: string) => within(dialog).getByRole('group', { name });
const blouse = (dialog: HTMLElement) => lineGroup(dialog, 'シルクブラウス（白 / M）');
const pants = (dialog: HTMLElement) => lineGroup(dialog, 'ウールパンツ（2）');
const belt = (dialog: HTMLElement) => lineGroup(dialog, 'レザーベルト（茶）');
const submitButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: CREATE });
const select = (scope: HTMLElement, name: string) => within(scope).getByRole('combobox', { name }) as HTMLSelectElement;
const optionTexts = (element: HTMLElement) => within(element).getAllByRole('option').map((option) => option.textContent);

function setQuantity(scope: HTMLElement, value: string) {
  fireEvent.change(within(scope).getByLabelText('返品する数'), { target: { value } });
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderReturnCreateForm の材料と画面', () => {
  it('開くと材料を読み、発送ごとに品を並べる。最初は何も選ばず、作るボタンは押せない', async () => {
    const { dialog } = await openForm();

    expect(mockClientFetch).toHaveBeenCalledWith(MATERIALS_URL, { cache: 'no-store' });
    const first = within(dialog).getByRole('region', { name: '1回目の発送（10月10日発送）' });
    expect(within(first).getByText('受付の期限: 10月20日まで')).toBeInTheDocument();
    expect(within(first).getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'シルクブラウス（白 / M）',
      'ウールパンツ（2）',
    ]);
    expect(within(blouse(dialog)).getByText('返品できる数: 2')).toBeInTheDocument();
    expect(within(blouse(dialog)).getByLabelText('返品する数')).toHaveValue(0);
    expect(within(blouse(dialog)).getByLabelText('返品する数')).toHaveAttribute('max', '2');
    // 発送の日付は日本時間で数える。期限を過ぎた発送には警告を出すが、品は選べる
    const second = within(dialog).getByRole('region', { name: '2回目の発送（10月2日発送）' });
    expect(within(second).getByText('期限を過ぎています（10月11日まで）')).toBeInTheDocument();
    expect(within(belt(dialog)).getByLabelText('返品する数')).toBeEnabled();
    // 選ぶまでは、理由などの入力を出さない
    expect(within(dialog).queryByLabelText('理由')).not.toBeInTheDocument();
    // 返送・メモ・知らせる。手数料は設定で使う物が無いので出さない
    const shipping = within(dialog).getByRole('region', { name: '返送' });
    expect(select(shipping, '返送の方法')).toHaveValue('customer_ships');
    expect(optionTexts(select(shipping, '返送の方法'))).toEqual(['お客様が送る', 'お店の送り状で送る（返送料を差し引く）']);
    expect(select(shipping, '返送料の負担')).toHaveValue('customer');
    expect(optionTexts(select(shipping, '返送料の負担'))).toEqual(['お店', 'お客様']);
    expect(select(shipping, '返送の配送業者（任意）')).toHaveValue('');
    expect(optionTexts(select(shipping, '返送の配送業者（任意）'))).toEqual(['指定しない', 'ヤマト運輸', '佐川急便', '日本郵便', 'その他']);
    expect(within(shipping).getByRole('textbox', { name: '返送の伝票番号（任意）' })).toHaveValue('');
    expect(within(dialog).queryByRole('region', { name: '手数料' })).not.toBeInTheDocument();
    const memo = within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' });
    expect(memo).toHaveValue('');
    expect(memo).toHaveAttribute('maxlength', '500');
    expect(within(dialog).getByRole('checkbox', { name: 'お客様に返品の受付のお知らせを送る' })).toBeChecked();
    expect(submitButton(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeEnabled();
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async () => {
    const { dialog } = await openForm();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });

  it('受付の期限が無い設定なら「なし」と出す', async () => {
    const { dialog } = await openForm(materials({ shipments: [{ ...SHIPMENT_1, deadlineDate: null }] }));

    expect(within(dialog).getByText('受付の期限: なし')).toBeInTheDocument();
  });

  it('返品できる数が0の品は出さない。出せる品が1つも無ければ、その文を出して作るボタンを押せなくする', async () => {
    const partly = await openForm(materials({ shipments: [{ ...SHIPMENT_1, lines: [{ ...BLOUSE, returnable: 0 }, PANTS] }] }));
    expect(within(partly.dialog).queryByRole('group', { name: 'シルクブラウス（白 / M）' })).not.toBeInTheDocument();
    expect(pants(partly.dialog)).toBeInTheDocument();
    partly.unmount();

    mockClientFetch.mockReset();
    const none = await openForm(materials({ shipments: [{ ...SHIPMENT_1, lines: [{ ...BLOUSE, returnable: 0 }] }] }));
    expect(within(none.dialog).queryByRole('region', { name: /回目の発送/ })).not.toBeInTheDocument();
    expect(within(none.dialog).getByText(NOT_RETURNABLE)).toBeInTheDocument();
    expect(submitButton(none.dialog)).toBeDisabled();
  });

  it('返品する数は 0 から返品できる数までに収まる', async () => {
    const { dialog } = await openForm();
    const input = within(blouse(dialog)).getByLabelText('返品する数');

    fireEvent.change(input, { target: { value: '1' } });
    expect(input).toHaveValue(1);
    fireEvent.change(input, { target: { value: '9' } });
    expect(input).toHaveValue(2);
    fireEvent.change(input, { target: { value: '-4' } });
    expect(input).toHaveValue(0);
  });

  it('数を入れた品だけ、理由・理由のメモ・解決の方法を出す。理由は「不明」から始まり、10の理由を選べる', async () => {
    const { dialog } = await openForm();
    setQuantity(blouse(dialog), '1');

    const reason = select(blouse(dialog), '理由');
    expect(reason).toHaveValue('unknown');
    expect(optionTexts(reason)).toEqual([
      '破損・不良',
      '注文と違う品が届いた',
      'サイズが小さい',
      'サイズが大きい',
      '色がイメージと違った',
      'デザインが好みでない',
      '説明と違った',
      '不要になった',
      'その他',
      '不明',
    ]);
    const note = within(blouse(dialog)).getByRole('textbox', { name: '理由のメモ' });
    expect(note).toHaveValue('');
    expect(note).toHaveAttribute('maxlength', '255');
    expect(select(blouse(dialog), '解決の方法')).toHaveValue('refund');
    expect(optionTexts(select(blouse(dialog), '解決の方法'))).toEqual(['返金', '交換']);
    // 数を入れていないウールパンツには出ない
    expect(within(pants(dialog)).queryByLabelText('理由')).not.toBeInTheDocument();

    setQuantity(blouse(dialog), '0');
    expect(within(blouse(dialog)).queryByLabelText('理由')).not.toBeInTheDocument();
  });

  it('理由が「その他」の間は、理由のメモが入るまで文を出して、作るボタンを押せなくする', async () => {
    const { dialog } = await openForm();
    setQuantity(pants(dialog), '1');
    expect(submitButton(dialog)).toBeEnabled();

    fireEvent.change(select(pants(dialog), '理由'), { target: { value: 'other' } });
    expect(within(pants(dialog)).getByText(NOTE_REQUIRED)).toBeInTheDocument();
    expect(submitButton(dialog)).toBeDisabled();

    fireEvent.change(within(pants(dialog)).getByRole('textbox', { name: '理由のメモ' }), { target: { value: '裾が短い' } });
    expect(within(pants(dialog)).queryByText(NOTE_REQUIRED)).not.toBeInTheDocument();
    expect(submitButton(dialog)).toBeEnabled();

    // 空白だけのメモは入っていないのと同じ
    fireEvent.change(within(pants(dialog)).getByRole('textbox', { name: '理由のメモ' }), { target: { value: '   ' } });
    expect(submitButton(dialog)).toBeDisabled();
  });

  it('交換を選ぶと、同じ商品の使える色・サイズだけを出す。元と同じ色・サイズから始まり、在庫の数を見せる', async () => {
    const { dialog } = await openForm();
    setQuantity(blouse(dialog), '1');

    fireEvent.change(select(blouse(dialog), '解決の方法'), { target: { value: 'exchange' } });

    const variant = select(blouse(dialog), '交換の色・サイズ');
    // 使えない色・サイズ（黒 / M）は出さない
    expect(optionTexts(variant)).toEqual(['白 / M', '白 / L', '青 / M']);
    expect(variant).toHaveValue('101');
    expect(within(blouse(dialog)).getByText('在庫: 5')).toBeInTheDocument();
    expect(select(blouse(dialog), '送り方')).toHaveValue('stock');
    expect(optionTexts(select(blouse(dialog), '送り方'))).toEqual(['在庫から', '作って送る']);

    fireEvent.change(select(blouse(dialog), '解決の方法'), { target: { value: 'refund' } });
    expect(within(blouse(dialog)).queryByLabelText('交換の色・サイズ')).not.toBeInTheDocument();
  });

  it('送り方は、選んだ色・サイズの在庫が返す数に足りる時だけ「在庫から」から始まる。手で選べて、色・サイズを選び直すと決め直す', async () => {
    const { dialog } = await openForm();
    setQuantity(blouse(dialog), '1');
    fireEvent.change(select(blouse(dialog), '解決の方法'), { target: { value: 'exchange' } });

    fireEvent.change(select(blouse(dialog), '交換の色・サイズ'), { target: { value: '102' } });
    expect(within(blouse(dialog)).getByText('在庫: 0')).toBeInTheDocument();
    expect(select(blouse(dialog), '送り方')).toHaveValue('make');

    fireEvent.change(select(blouse(dialog), '送り方'), { target: { value: 'stock' } });
    expect(select(blouse(dialog), '送り方')).toHaveValue('stock');

    // 色・サイズを選び直すと、手で選んだ送り方は捨てて、新しい在庫から決め直す
    fireEvent.change(select(blouse(dialog), '交換の色・サイズ'), { target: { value: '101' } });
    fireEvent.change(select(blouse(dialog), '交換の色・サイズ'), { target: { value: '102' } });
    expect(select(blouse(dialog), '送り方')).toHaveValue('make');
  });

  it('送り方は返す数にも合わせる: 在庫が1つの色・サイズは、1点なら在庫から、2点なら作って送るから始まる', async () => {
    const { dialog } = await openForm();
    setQuantity(blouse(dialog), '1');
    fireEvent.change(select(blouse(dialog), '解決の方法'), { target: { value: 'exchange' } });
    fireEvent.change(select(blouse(dialog), '交換の色・サイズ'), { target: { value: '104' } });
    expect(within(blouse(dialog)).getByText('在庫: 1')).toBeInTheDocument();
    expect(select(blouse(dialog), '送り方')).toHaveValue('stock');

    setQuantity(blouse(dialog), '2');
    expect(select(blouse(dialog), '送り方')).toHaveValue('make');

    setQuantity(blouse(dialog), '1');
    expect(select(blouse(dialog), '送り方')).toHaveValue('stock');
  });

  it('同じ商品に使える色・サイズが材料に無い品は、解決の方法に交換を出さない', async () => {
    const { dialog } = await openForm();
    setQuantity(belt(dialog), '1');

    expect(optionTexts(select(belt(dialog), '解決の方法'))).toEqual(['返金']);
  });

  it('交換の品の行を返品する時は、品の名前の横に「交換の品」の印を付ける', async () => {
    const exchangeLine: ShipmentLine = { ...BLOUSE, orderItemId: 'item-exchange', variantId: 102, color: '白', size: 'L', lineKind: 'exchange', returnable: 1 };
    const { dialog } = await openForm(materials({ shipments: [{ ...SHIPMENT_1, lines: [BLOUSE, exchangeLine] }] }));

    const group = lineGroup(dialog, 'シルクブラウス（白 / L）（交換の品）');
    expect(within(group).getByText('交換の品')).toBeInTheDocument();
    expect(within(blouse(dialog)).queryByText('交換の品')).not.toBeInTheDocument();
  });

  it('返送先が設定されていない間は、文を出して、品を選んでも作るボタンを押せなくする', async () => {
    const { dialog } = await openForm(materials({ settings: { returnAddressSet: false } }));
    expect(within(dialog).getByText(ADDRESS_MISSING)).toBeInTheDocument();

    setQuantity(pants(dialog), '1');
    expect(submitButton(dialog)).toBeDisabled();
  });

  it('確かめ中の返金がある注文には、その注意を出す（E-2 の言葉）。作るボタンは止めない（DB が最後に確かめる）', async () => {
    const { dialog } = await openForm(materials({ order: { hasAwaitingRefund: true } }));
    expect(within(dialog).getByText(AWAITING_REFUND)).toBeInTheDocument();

    setQuantity(pants(dialog), '1');
    expect(submitButton(dialog)).toBeEnabled();
  });
});

describe('OrderReturnCreateForm の返送と手数料', () => {
  it('返送料の負担は、選んだ理由にお店の負担があればお店から始まり、返送の方法はそれに合わせる。手で直した負担は理由を変えても保つ', async () => {
    const { dialog } = await openForm(materials({ settings: { customerPaidMethod: 'shop_label', shopLabelFee: 800 } }));
    const shipping = () => within(dialog).getByRole('region', { name: '返送' });
    // 何も選ばない間はお客様の負担。お客様の負担の時の送り方（設定）から始まり、定額の返送料を出す
    expect(select(shipping(), '返送料の負担')).toHaveValue('customer');
    expect(select(shipping(), '返送の方法')).toHaveValue('shop_label');
    expect(within(dialog).getByLabelText('返送料（円）')).toHaveValue(800);

    setQuantity(blouse(dialog), '1');
    fireEvent.change(select(blouse(dialog), '理由'), { target: { value: 'defective' } });
    expect(select(shipping(), '返送料の負担')).toHaveValue('shop');
    expect(select(shipping(), '返送の方法')).toHaveValue('customer_ships');
    expect(within(dialog).queryByLabelText('返送料（円）')).not.toBeInTheDocument();

    fireEvent.change(select(shipping(), '返送料の負担'), { target: { value: 'customer' } });
    expect(select(shipping(), '返送の方法')).toHaveValue('shop_label');
    fireEvent.change(select(blouse(dialog), '理由'), { target: { value: 'wrong_item' } });
    expect(select(shipping(), '返送料の負担')).toHaveValue('customer');
  });

  it('返送料の負担がお店の時は、お店の送り状で送るを選んでいても返送料の欄を出さず、0 で送る', async () => {
    const { dialog, onCreated } = await openForm(materials({ settings: { shopLabelFee: 800 } }));
    mockClientFetch.mockResolvedValueOnce(json(created()));
    fireEvent.change(select(dialog, '返送の方法'), { target: { value: 'shop_label' } });
    expect(within(dialog).getByLabelText('返送料（円）')).toHaveValue(800);

    setQuantity(blouse(dialog), '1');
    fireEvent.change(select(blouse(dialog), '理由'), { target: { value: 'defective' } });
    // 手で選んだ送り方は理由を変えても保つが、負担がお店になったので、定額の返送料は付けない
    expect(select(dialog, '返送料の負担')).toHaveValue('shop');
    expect(select(dialog, '返送の方法')).toHaveValue('shop_label');
    expect(within(dialog).queryByLabelText('返送料（円）')).not.toBeInTheDocument();
    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toMatchObject({ returnMethod: 'shop_label', returnShippingPayer: 'shop', returnShippingFee: 0 });
  });

  it('「返送不要」は設定でオンの時だけ選べる。選ぶと、負担・配送業者・伝票番号の欄を隠す', async () => {
    const { dialog } = await openForm(materials({ settings: { noReturnNeededEnabled: true } }));
    const shipping = () => within(dialog).getByRole('region', { name: '返送' });
    expect(optionTexts(select(shipping(), '返送の方法'))).toEqual([
      'お客様が送る',
      'お店の送り状で送る（返送料を差し引く）',
      '返送不要',
    ]);

    fireEvent.change(select(shipping(), '返送の方法'), { target: { value: 'not_required' } });

    expect(select(shipping(), '返送の方法')).toHaveValue('not_required');
    expect(within(shipping()).queryByLabelText('返送料の負担')).not.toBeInTheDocument();
    expect(within(shipping()).queryByLabelText('返送の配送業者（任意）')).not.toBeInTheDocument();
    expect(within(shipping()).queryByLabelText('返送の伝票番号（任意）')).not.toBeInTheDocument();
  });

  it('手数料は設定で使う物だけ出し、設定の値から始める。金額の負の数は 0 に収まる', async () => {
    const { dialog } = await openForm(
      materials({
        settings: {
          restockingFeeEnabled: true, restockingFeePercent: 10,
          exchangeFeesEnabled: true, exchangeFee: 500, exchangeShippingFee: 800,
        },
      }),
    );
    const fees = () => within(dialog).getByRole('region', { name: '手数料' });
    expect(within(fees()).getByLabelText('返品の手数料（%）')).toHaveValue('10');
    // 交換の手数料と送料は、交換にする品を選んだ時だけ出す。返送料は、お店の送り状で送る時だけ出す
    expect(within(fees()).queryByLabelText('交換の手数料（円）')).not.toBeInTheDocument();
    expect(within(fees()).queryByLabelText('返送料（円）')).not.toBeInTheDocument();

    setQuantity(blouse(dialog), '1');
    fireEvent.change(select(blouse(dialog), '解決の方法'), { target: { value: 'exchange' } });
    expect(within(fees()).getByLabelText('交換の手数料（円）')).toHaveValue(500);
    expect(within(fees()).getByLabelText('交換の送料（円）')).toHaveValue(800);

    const exchangeFee = within(fees()).getByLabelText('交換の手数料（円）');
    fireEvent.change(exchangeFee, { target: { value: '-300' } });
    expect(exchangeFee).toHaveValue(0);

    fireEvent.change(select(blouse(dialog), '解決の方法'), { target: { value: 'refund' } });
    expect(within(fees()).queryByLabelText('交換の手数料（円）')).not.toBeInTheDocument();
  });

  it.each(['-1', '101', '1.5', 'abc', '', '1000000000'])(
    '返品の手数料（%）が「%s」なら入力を残して誤りを出し、作るボタンを押せなくする',
    async (value) => {
      const { dialog } = await openForm(materials({
        settings: { restockingFeeEnabled: true, restockingFeePercent: 10 },
      }));
      setQuantity(blouse(dialog), '1');
      expect(submitButton(dialog)).toBeEnabled();
      const input = within(dialog).getByLabelText('返品の手数料（%）');
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveValue(value);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(within(dialog).getByText('0から100までの整数（半角）で入れてください。')).toBeInTheDocument();
      expect(submitButton(dialog)).toBeDisabled();
      fireEvent.change(input, { target: { value: '10' } });
      expect(within(dialog).queryByText('0から100までの整数（半角）で入れてください。')).not.toBeInTheDocument();
      expect(submitButton(dialog)).toBeEnabled();
    },
  );

  it.each(['0', '100'])('返品の手数料（%）の境界「%s」は通り、整数で送る', async (value) => {
    const { dialog } = await openForm(materials({
      settings: { restockingFeeEnabled: true, restockingFeePercent: 10 },
    }));
    setQuantity(blouse(dialog), '1');
    const input = within(dialog).getByLabelText('返品の手数料（%）');
    fireEvent.change(input, { target: { value } });
    expect(input).toHaveValue(value);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(within(dialog).queryByText('0から100までの整数（半角）で入れてください。')).not.toBeInTheDocument();
    expect(submitButton(dialog)).toBeEnabled();
    mockClientFetch.mockResolvedValueOnce(json(created()));
    fireEvent.click(submitButton(dialog));
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(2));
    expect(requestBodyOf(1)).toMatchObject({ restockingFeePercent: Number(value) });
  });

  it('金額（円）の欄は 100万円を超えたら、収めずに誤りを出し、作るボタンを押せなくする。100万円ちょうどは通し、出していない欄は見ない', async () => {
    const { dialog } = await openForm(
      materials({
        settings: {
          customerPaidMethod: 'shop_label', shopLabelFee: 800,
          exchangeFeesEnabled: true, exchangeFee: 500, exchangeShippingFee: 800,
        },
      }),
    );
    const OVER_MAX = '0から1000000までの整数（半角）で入れてください。';
    const fees = () => within(dialog).getByRole('region', { name: '手数料' });
    setQuantity(blouse(dialog), '1');
    fireEvent.change(select(blouse(dialog), '解決の方法'), { target: { value: 'exchange' } });
    expect(submitButton(dialog)).toBeEnabled();

    for (const label of ['返送料（円）', '交換の手数料（円）', '交換の送料（円）']) {
      const input = within(fees()).getByLabelText(label);
      fireEvent.change(input, { target: { value: '1000000' } });
      expect(input).toHaveValue(1000000);
      expect(input).not.toHaveAttribute('aria-invalid');
      expect(within(fees()).queryByText(OVER_MAX)).not.toBeInTheDocument();
      expect(submitButton(dialog)).toBeEnabled();

      // 上限を超えた数は 100万円に収めず、そのまま残して誤りを出す（桁の打ち間違いを黙って別の額に変えない）
      fireEvent.change(input, { target: { value: '1000001' } });
      expect(input).toHaveValue(1000001);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(within(fees()).getByText(OVER_MAX)).toBeInTheDocument();
      expect(submitButton(dialog)).toBeDisabled();

      fireEvent.change(input, { target: { value: '500' } });
      expect(within(fees()).queryByText(OVER_MAX)).not.toBeInTheDocument();
      expect(submitButton(dialog)).toBeEnabled();
    }

    // 欄を出していない間は送らない値なので、上限を超えていても止めない
    fireEvent.change(within(fees()).getByLabelText('返送料（円）'), { target: { value: '2000000' } });
    expect(submitButton(dialog)).toBeDisabled();
    fireEvent.change(select(dialog, '返送の方法'), { target: { value: 'customer_ships' } });
    expect(within(fees()).queryByLabelText('返送料（円）')).not.toBeInTheDocument();
    expect(submitButton(dialog)).toBeEnabled();
  });

  it('返送の伝票番号は英数字とハイフンの 64 字まで。外れる間は文を出して、作るボタンを押せなくする', async () => {
    const { dialog } = await openForm();
    setQuantity(pants(dialog), '1');
    const tracking = within(dialog).getByRole('textbox', { name: '返送の伝票番号（任意）' });
    expect(tracking).toHaveAttribute('maxlength', '64');

    fireEvent.change(tracking, { target: { value: '１２３' } });
    expect(within(dialog).getByText('伝票番号は英数字とハイフンで入力してください。')).toBeInTheDocument();
    expect(submitButton(dialog)).toBeDisabled();

    fireEvent.change(tracking, { target: { value: 'AB-123' } });
    expect(within(dialog).queryByText('伝票番号は英数字とハイフンで入力してください。')).not.toBeInTheDocument();
    expect(submitButton(dialog)).toBeEnabled();
  });
});

describe('OrderReturnCreateForm の作る', () => {
  it('入力の全部を、二重防止の番号つきで窓口へ送り、結果と返送の方法を親へ渡す', async () => {
    const { dialog, onCreated, onClose } = await openForm(
      materials({
        settings: {
          restockingFeeEnabled: true, restockingFeePercent: 10,
          exchangeFeesEnabled: true, exchangeFee: 500, exchangeShippingFee: 800,
        },
      }),
    );
    mockClientFetch.mockResolvedValueOnce(json(created()));
    // ブラウス 2 点: 不良品を、在庫の足りない白 / L に交換（在庫が足りないので作って送るから始まる）
    setQuantity(blouse(dialog), '2');
    fireEvent.change(select(blouse(dialog), '理由'), { target: { value: 'defective' } });
    fireEvent.change(within(blouse(dialog)).getByRole('textbox', { name: '理由のメモ' }), { target: { value: '縫い目のほつれ' } });
    fireEvent.change(select(blouse(dialog), '解決の方法'), { target: { value: 'exchange' } });
    fireEvent.change(select(blouse(dialog), '交換の色・サイズ'), { target: { value: '102' } });
    // パンツ 1 点: 理由は既定の「不明」のまま返金
    setQuantity(pants(dialog), '1');
    fireEvent.change(select(dialog, '返送の配送業者（任意）'), { target: { value: 'yamato' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '返送の伝票番号（任意）' }), { target: { value: 'ABC-123' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' }), { target: { value: '電話で連絡' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様に返品の受付のお知らせを送る' }));
    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, RETURNS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [
        {
          fulfillmentId: 'ful-1', orderItemId: 'item-blouse', quantity: 2, reason: 'defective', reasonNote: '縫い目のほつれ',
          resolution: 'exchange', exchangeVariantId: 102, exchangeMethod: 'make',
        },
        {
          fulfillmentId: 'ful-1', orderItemId: 'item-pants', quantity: 1, reason: 'unknown', reasonNote: null,
          resolution: 'refund', exchangeVariantId: null, exchangeMethod: null,
        },
      ],
      returnMethod: 'customer_ships',
      returnShippingPayer: 'shop',
      returnCarrier: 'yamato',
      returnTrackingNumber: 'ABC-123',
      returnShippingFee: 0,
      restockingFeePercent: 10,
      exchangeFee: 500,
      exchangeShippingFee: 800,
      shopNote: '電話で連絡',
      notifyCustomer: false,
    });
    expect(onCreated).toHaveBeenCalledWith(created().data, 'customer_ships');
    // 閉じるのは親。画面が自分で閉じることはしない
    expect(onClose).not.toHaveBeenCalled();
  });

  it('品を1つだけ選んだ最小の送信: 理由のメモ・配送業者・伝票番号・店のメモは null、使わない手数料は 0', async () => {
    const { dialog, onCreated } = await openForm();
    mockClientFetch.mockResolvedValueOnce(json(created()));
    setQuantity(pants(dialog), '1');
    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [
        {
          fulfillmentId: 'ful-1', orderItemId: 'item-pants', quantity: 1, reason: 'unknown', reasonNote: null,
          resolution: 'refund', exchangeVariantId: null, exchangeMethod: null,
        },
      ],
      returnMethod: 'customer_ships',
      returnShippingPayer: 'customer',
      returnCarrier: null,
      returnTrackingNumber: null,
      returnShippingFee: 0,
      restockingFeePercent: 0,
      exchangeFee: 0,
      exchangeShippingFee: 0,
      shopNote: null,
      notifyCustomer: true,
    });
  });

  it('同じ品の一部だけを交換にすると、同じ発送の行を返金の行と交換の行の2つに分けて送る（設計書 4-2）。送り方は交換にする数で決める', async () => {
    const { dialog, onCreated } = await openForm();
    mockClientFetch.mockResolvedValueOnce(json(created()));
    setQuantity(blouse(dialog), '2');
    // 交換にする数は、交換を選んだ時にだけ出る。最初は返す数の全部
    expect(within(blouse(dialog)).queryByLabelText('交換にする数')).not.toBeInTheDocument();
    fireEvent.change(select(blouse(dialog), '解決の方法'), { target: { value: 'exchange' } });
    // 在庫が 1 の青 / M は、2点では足りないので作って送るから始まる
    fireEvent.change(select(blouse(dialog), '交換の色・サイズ'), { target: { value: '104' } });
    expect(select(blouse(dialog), '送り方')).toHaveValue('make');
    const exchangeCount = within(blouse(dialog)).getByLabelText('交換にする数');
    expect(exchangeCount).toHaveValue(2);
    expect(exchangeCount).toHaveAttribute('max', '2');

    fireEvent.change(exchangeCount, { target: { value: '1' } });
    // 交換にする1点なら在庫が足りるので、在庫からに変わる
    expect(select(blouse(dialog), '送り方')).toHaveValue('stock');
    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).lines).toEqual([
      {
        fulfillmentId: 'ful-1', orderItemId: 'item-blouse', quantity: 1, reason: 'unknown', reasonNote: null,
        resolution: 'refund', exchangeVariantId: null, exchangeMethod: null,
      },
      {
        fulfillmentId: 'ful-1', orderItemId: 'item-blouse', quantity: 1, reason: 'unknown', reasonNote: null,
        resolution: 'exchange', exchangeVariantId: 104, exchangeMethod: 'stock',
      },
    ]);
  });

  it('交換にする数は、返す数が1点の品には出さない。0 にした間は作るボタンを押せなくする', async () => {
    const { dialog } = await openForm();
    setQuantity(blouse(dialog), '1');
    fireEvent.change(select(blouse(dialog), '解決の方法'), { target: { value: 'exchange' } });
    expect(within(blouse(dialog)).queryByLabelText('交換にする数')).not.toBeInTheDocument();
    expect(submitButton(dialog)).toBeEnabled();

    setQuantity(blouse(dialog), '2');
    const exchangeCount = within(blouse(dialog)).getByLabelText('交換にする数');
    fireEvent.change(exchangeCount, { target: { value: '0' } });
    expect(exchangeCount).toHaveValue(0);
    expect(submitButton(dialog)).toBeDisabled();

    fireEvent.change(exchangeCount, { target: { value: '2' } });
    expect(submitButton(dialog)).toBeEnabled();
  });

  it('お店の送り状で送る返品は、返送料の定額を設定の値から始めて、直した額を送る', async () => {
    const { dialog, onCreated } = await openForm(materials({ settings: { customerPaidMethod: 'shop_label', shopLabelFee: 800 } }));
    mockClientFetch.mockResolvedValueOnce(json(created()));
    setQuantity(pants(dialog), '1');
    fireEvent.change(within(dialog).getByLabelText('返送料（円）'), { target: { value: '650' } });
    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toMatchObject({ returnMethod: 'shop_label', returnShippingPayer: 'customer', returnShippingFee: 650 });
    expect(onCreated).toHaveBeenCalledWith(created().data, 'shop_label');
  });

  it('返送不要の返品は、先に入れた配送業者・伝票番号を送らない。親へ「返送不要」を渡す（親がすぐ受け取りの画面を開く）', async () => {
    const { dialog, onCreated } = await openForm(materials({ settings: { noReturnNeededEnabled: true } }));
    mockClientFetch.mockResolvedValueOnce(json(created({ returnId: 'ret-9', number: 3 })));
    setQuantity(pants(dialog), '1');
    fireEvent.change(select(dialog, '返送の配送業者（任意）'), { target: { value: 'sagawa' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '返送の伝票番号（任意）' }), { target: { value: '9999' } });
    fireEvent.change(select(dialog, '返送の方法'), { target: { value: 'not_required' } });
    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toMatchObject({ returnMethod: 'not_required', returnCarrier: null, returnTrackingNumber: null });
    expect(onCreated).toHaveBeenCalledWith(created({ returnId: 'ret-9', number: 3 }).data, 'not_required');
  });

  it('形の外れた伝票番号を入れてから返送不要にすると、作るボタンを押せ、伝票番号は null で送る', async () => {
    const { dialog, onCreated } = await openForm(materials({ settings: { noReturnNeededEnabled: true } }));
    mockClientFetch.mockResolvedValueOnce(json(created()));
    setQuantity(pants(dialog), '1');
    fireEvent.change(within(dialog).getByRole('textbox', { name: '返送の伝票番号（任意）' }), { target: { value: '１２３' } });
    expect(submitButton(dialog)).toBeDisabled();
    expect(within(dialog).getByText('伝票番号は英数字とハイフンで入力してください。')).toBeInTheDocument();

    fireEvent.change(select(dialog, '返送の方法'), { target: { value: 'not_required' } });
    expect(within(dialog).queryByLabelText('返送の伝票番号（任意）')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('伝票番号は英数字とハイフンで入力してください。')).not.toBeInTheDocument();
    expect(submitButton(dialog)).toBeEnabled();
    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toMatchObject({ returnMethod: 'not_required', returnTrackingNumber: null });
  });

  it('開き直すたびに、入力も二重防止の番号も新しくなる', async () => {
    const first = await openForm();
    mockClientFetch.mockResolvedValueOnce(json(created()));
    setQuantity(pants(first.dialog), '1');
    fireEvent.click(submitButton(first.dialog));
    await waitFor(() => expect(first.onCreated).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = await openForm();
    expect(within(pants(second.dialog)).getByLabelText('返品する数')).toHaveValue(0);
    mockClientFetch.mockResolvedValueOnce(json(created()));
    setQuantity(pants(second.dialog), '1');
    fireEvent.click(submitButton(second.dialog));
    await waitFor(() => expect(second.onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(3).requestKey).toMatch(UUID_PATTERN);
    expect(requestBodyOf(3).requestKey).not.toBe(requestBodyOf(1).requestKey);
  });

  it('「戻る」では送らずに閉じる（答えが分からない状態ではないので、読み直しは頼まない）', async () => {
    const { dialog, onClose, onCreated, onUncertain } = await openForm();
    setQuantity(pants(dialog), '1');
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('送っている間は入力もボタンも止まり、二重に送らない。画面も閉じられない（戻るも Esc も効かない）', async () => {
    const { dialog, onClose, onCreated } = await openForm();
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    setQuantity(pants(dialog), '1');
    fireEvent.click(submitButton(dialog));

    expect(submitButton(dialog)).toBeDisabled();
    expect(within(pants(dialog)).getByLabelText('返品する数')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeDisabled();
    fireEvent.click(submitButton(dialog));
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(mockClientFetch).toHaveBeenCalledTimes(2);

    resolvePost(json(created()));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Enter キーでは送らない（数や選びの欄でも）。メモの欄の Enter は改行のまま', async () => {
    const { dialog } = await openForm();
    setQuantity(pants(dialog), '1');

    expect(fireEvent.keyDown(within(pants(dialog)).getByLabelText('返品する数'), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(within(dialog).getByRole('checkbox', { name: 'お客様に返品の受付のお知らせを送る' }), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' }), { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(submitButton(dialog), { key: 'Enter' })).toBe(true);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });
});

describe('OrderReturnCreateForm の窓口の断り', () => {
  it('最初の送信が403で処理前に断られても、次の送信は同じ二重防止の番号を使う', async () => {
    const { dialog, onCreated } = await openForm();
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json(created()));
    setQuantity(pants(dialog), '1');
    fireEvent.click(submitButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('この操作の権限がありません。');
    expect(within(pants(dialog)).getByLabelText('返品する数')).toBeEnabled();
    fireEvent.click(submitButton(dialog));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).toBe(requestBodyOf(1).requestKey);
  });

  it('回数の制限（429）は、回数の制限の固定の文を出す（「作れませんでした」とは言わない）', async () => {
    const { dialog } = await openForm();
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));
    setQuantity(pants(dialog), '1');
    fireEvent.click(submitButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(RATE_LIMITED);
    expect(within(dialog).queryByText('返品を作れませんでした。')).not.toBeInTheDocument();
  });

  it('窓口が断ったら、その文を画面の中に出し、入力は残して、次の送信は新しい二重防止の番号にする', async () => {
    const { dialog, onCreated } = await openForm();
    const message = '返品できる数を超えています。画面を開き直してください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'RETURN_QUANTITY_EXCEEDS' }, 409))
      .mockResolvedValueOnce(json(created()));
    setQuantity(pants(dialog), '1');
    fireEvent.click(submitButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onCreated).not.toHaveBeenCalled();
    expect(within(pants(dialog)).getByLabelText('返品する数')).toHaveValue(1);
    expect(submitButton(dialog)).toBeEnabled();

    fireEvent.click(submitButton(dialog));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).toMatch(UUID_PATTERN);
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(1).requestKey);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('窓口の文が無い断り（400）は、代わりの文を出す', async () => {
    const { dialog } = await openForm();
    mockClientFetch.mockResolvedValueOnce(json({}, 400));
    setQuantity(pants(dialog), '1');
    fireEvent.click(submitButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返品を作れませんでした。');
  });
});

const UNKNOWN_ANSWERS: Array<[string, () => Promise<unknown>]> = [
  ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['サーバーが失敗した（500）', () => Promise.resolve(json({ error: '返品を作れませんでした。', code: 'failed' }, 500))],
  ['答えを読めなかった（502）', () => Promise.resolve(json({ error: 'Bad Gateway' }, 502))],
  ['成功なのに答えの中身が無い', () => Promise.resolve(json({}))],
];

describe('OrderReturnCreateForm の答えが分からない時', () => {
  it.each(UNKNOWN_ANSWERS)(
    '%s時は、入力を止めて「もう一度確かめる」と「閉じる」だけを出し、同じ二重防止の番号・同じ中身で確かめ直す',
    async (_label, firstAnswer) => {
      const { dialog, onCreated, onClose, onUncertain } = await openForm();
      mockClientFetch.mockImplementationOnce(firstAnswer).mockResolvedValueOnce(json(created({ replayed: true })));
      setQuantity(pants(dialog), '1');
      fireEvent.click(submitButton(dialog));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
      // 入力は変えられない
      expect(within(pants(dialog)).getByLabelText('返品する数')).toBeDisabled();
      expect(select(pants(dialog), '理由')).toBeDisabled();
      expect(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' })).toBeDisabled();
      expect(within(dialog).getByRole('checkbox', { name: 'お客様に返品の受付のお知らせを送る' })).toBeDisabled();
      // 操作は「もう一度確かめる」と「閉じる」だけ
      expect(within(dialog).queryByRole('button', { name: CREATE })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: '戻る' })).not.toBeInTheDocument();
      expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);

      fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created({ replayed: true }).data, 'customer_ships'));
      // 同じ二重防止の番号・同じ中身で送り直す（DB は前の記録を返し、返品は1件のまま）
      expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
      expect(onClose).not.toHaveBeenCalled();
      expect(onUncertain).not.toHaveBeenCalled();
    },
  );

  it.each([
    [401, '認証が必要です。再ログインしてください。'],
    [403, 'この操作の権限がありません。'],
    [429, RATE_LIMITED],
  ])('再送が%iで処理前に断られても結果不明のまま、断りの文の後ろに結果が分からない時の文を続け、次も同じ番号・同じ本文で送る', async (status, message) => {
    const { dialog, onCreated } = await openForm();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: 'Blocked' }, status))
      .mockResolvedValueOnce(json(created({ replayed: true })));
    setQuantity(pants(dialog), '1');
    fireEvent.click(submitButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(`${message}${UNKNOWN_OUTCOME}`));
    expect(within(pants(dialog)).getByLabelText('返品する数')).toBeDisabled();
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
    expect(requestBodyOf(3)).toEqual(requestBodyOf(1));
  });

  it('確かめ直しても分からない時は、そのまま止まる。「閉じる」で閉じる時に、読み直しを親に頼む', async () => {
    const { dialog, onCreated, onClose, onUncertain } = await openForm();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    setQuantity(pants(dialog), '1');
    fireEvent.click(submitButton(dialog));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'もう一度確かめる' })).toBeEnabled());

    expect(within(dialog).getByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 409])('再送が%iで断られたら、材料を読み直し、返せる数が減った品の数を収め、新しい番号で送れる', async (status) => {
    const { dialog, onCreated } = await openForm();
    const message = '返品できる数を超えています。画面を開き直してください。';
    const reloaded = materials({ shipments: [{ ...SHIPMENT_1, lines: [{ ...BLOUSE, returnable: 1 }, PANTS] }] });
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: message, code: 'RETURN_QUANTITY_EXCEEDS' }, status))
      .mockResolvedValueOnce(json({ data: reloaded }))
      .mockResolvedValueOnce(json(created()));
    setQuantity(blouse(dialog), '2');
    fireEvent.click(submitButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    // 読み直した材料で、ブラウスの返せる数は 1。入れていた 2 は 1 に収まり、入力が戻る
    await waitFor(() => expect(within(blouse(dialog)).getByText('返品できる数: 1')).toBeInTheDocument());
    expect(within(dialog).getByRole('alert')).toHaveTextContent(message);
    expect(mockClientFetch).toHaveBeenNthCalledWith(4, MATERIALS_URL, { cache: 'no-store' });
    expect(within(blouse(dialog)).getByLabelText('返品する数')).toHaveValue(1);
    expect(within(blouse(dialog)).getByLabelText('返品する数')).toBeEnabled();
    fireEvent.click(submitButton(dialog));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(4).requestKey).not.toBe(requestBodyOf(1).requestKey);
    expect((requestBodyOf(4).lines as Array<{ quantity: number }>)[0].quantity).toBe(1);
  });

  it('再送が409で断られた後の材料の読み直しが失敗したら、その文を出す', async () => {
    const { dialog, onCreated } = await openForm();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: '返品できる数を超えています。画面を開き直してください。' }, 409))
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    setQuantity(pants(dialog), '1');
    fireEvent.click(submitButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('この操作の権限がありません。'));
    expect(mockClientFetch).toHaveBeenNthCalledWith(4, MATERIALS_URL, { cache: 'no-store' });
    expect(within(pants(dialog)).getByLabelText('返品する数')).toBeEnabled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('Escape で閉じる。答えが分からない時だけ、読み直しを親に頼む', async () => {
    const { dialog, onClose, onUncertain } = await openForm();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();

    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    setQuantity(pants(dialog), '1');
    fireEvent.click(submitButton(dialog));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onUncertain).toHaveBeenCalledTimes(1);
  });
});

describe('OrderReturnCreateForm の材料を読めない時', () => {
  it.each([
    [404, { error: '注文が見つかりません。', code: 'ORDER_NOT_FOUND' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '返品の材料を読み込めませんでした。'],
  ])('材料を読めなかった時（%i）は理由と「閉じる」だけを出す', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    const onClose = jest.fn();
    render(<OrderReturnCreateForm orderId={ORDER_ID} onClose={onClose} onCreated={jest.fn()} onUncertain={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: TITLE });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['閉じる']);
    expect(within(dialog).queryByLabelText('返品する数')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
