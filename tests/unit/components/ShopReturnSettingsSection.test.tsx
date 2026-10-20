import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShopReturnSettingsSection from '@/components/ShopReturnSettingsSection';
import type { ReturnReason, ShopReturnSettings, ShopReturnSettingsUpdate } from '@/lib/orders/returns/return-types';
import { buildShopReturnSettings } from './shop-return-settings-test-fixtures';

/** 日本時間では 2026/10/12 11:30 */
const CHANGED_AT = '2026-10-12T02:30:00.000Z';
/** 日本時間では 2026/10/11 10:30 */
const EARLIER_AT = '2026-10-11T01:30:00.000Z';

const ADDRESS = {
  name: '返品係 山田',
  postalCode: '150-0001',
  address: '東京都渋谷区神宮前1-2-3',
  phone: '03-1234-5678',
};

const GROUP_NAMES = ['申し込み', '返送', '受付の期限', '理由ごとの設定', '手数料', '受け取り'];

const SUMMARY = '入力を確かめてください。';
const WINDOW_DAYS_MESSAGE = '1から365までの整数（半角）で入れてください。';
const DELIVERY_BUFFER_MESSAGE = '0から14までの整数（半角）で入れてください。';
const AMOUNT_MESSAGE = '0から1000000までの整数（半角）で入れてください。';
const PERCENT_MESSAGE = '0から100までの整数（半角）で入れてください。';
const ADDRESS_REQUIRED_MESSAGE = '返送先は4つとも入れてください。';
const TOO_LONG_MESSAGE = '200字までで入れてください。';
const POSTAL_CODE_MESSAGE = '郵便番号は 123-4567 の形で入れてください。';
const PHONE_MESSAGE = '電話番号は、数字と「+」「-」だけで6〜20文字にしてください。';
const PRESSED_WHILE_SAVING_MESSAGE = '保存の最中です。済んでから、もう一度「保存する」を押してください。';
const NOTICE_TOO_LONG_MESSAGE = '2000字までで入れてください。';
const PHOTO_INSTRUCTIONS_TOO_LONG_MESSAGE = '500字までで入れてください。';

const DEFECT_PHOTO_NOTE = '傷や不具合の場所がわかる写真をお送りください';
const SIZE_PHOTO_NOTE = 'タグの付いた状態がわかる写真をお送りください';

/** 既定の設定（仕様書 8-3 の最初の値）を保存した時に、窓口へ渡る理由ごとの行（段1の2つの欄と、段2の4つの欄） */
const DEFAULT_REASONS: ShopReturnSettingsUpdate['reasons'] = [
  { reason: 'defective', shown: true, resolutions: 'refund_and_exchange', photo: 'required', photoInstructions: DEFECT_PHOTO_NOTE, shippingPayer: 'shop', outOfStockExchange: 'make' },
  { reason: 'wrong_item', shown: true, resolutions: 'refund_and_exchange', photo: 'required', photoInstructions: DEFECT_PHOTO_NOTE, shippingPayer: 'shop', outOfStockExchange: 'make' },
  { reason: 'size_too_small', shown: true, resolutions: 'exchange_only', photo: 'optional', photoInstructions: SIZE_PHOTO_NOTE, shippingPayer: 'customer', outOfStockExchange: 'decline' },
  { reason: 'size_too_large', shown: true, resolutions: 'exchange_only', photo: 'optional', photoInstructions: SIZE_PHOTO_NOTE, shippingPayer: 'customer', outOfStockExchange: 'decline' },
  { reason: 'color', shown: false, resolutions: 'refund_and_exchange', photo: 'optional', photoInstructions: '', shippingPayer: 'customer', outOfStockExchange: 'decline' },
  { reason: 'style', shown: false, resolutions: 'refund_and_exchange', photo: 'optional', photoInstructions: '', shippingPayer: 'customer', outOfStockExchange: 'decline' },
  { reason: 'not_as_described', shown: false, resolutions: 'refund_and_exchange', photo: 'optional', photoInstructions: '', shippingPayer: 'customer', outOfStockExchange: 'decline' },
  { reason: 'unwanted', shown: false, resolutions: 'refund_and_exchange', photo: 'optional', photoInstructions: '', shippingPayer: 'customer', outOfStockExchange: 'decline' },
  { reason: 'other', shown: true, resolutions: 'refund_and_exchange', photo: 'optional', photoInstructions: '', shippingPayer: 'customer', outOfStockExchange: 'decline' },
  { reason: 'unknown', shown: false, resolutions: 'refund_and_exchange', photo: 'none', photoInstructions: '', shippingPayer: 'customer', outOfStockExchange: 'decline' },
];

/** 既定の設定を何も変えずに保存した時に、窓口へ渡る中身 */
const DEFAULT_INPUT: ShopReturnSettingsUpdate = {
  requestsEnabled: true,
  requestTypes: 'returns_only',
  noticeText: '',
  returnAddress: null,
  customerPaidMethod: 'customer_ships',
  shopLabelFee: 0,
  noReturnNeededEnabled: false,
  windowDays: 7,
  windowStart: 'each_item',
  deliveryBufferDays: 3,
  reasons: DEFAULT_REASONS,
  restockingFeeEnabled: false,
  restockingFeePercent: 0,
  exchangeFeesEnabled: false,
  exchangeFee: 0,
  exchangeShippingFee: 0,
  inspectionEnabled: false,
};

/** 既定の理由ごとの行のうち、指した理由だけを変えた物 */
function reasonsWith(
  changes: Partial<Record<ReturnReason, Partial<Omit<ShopReturnSettingsUpdate['reasons'][number], 'reason'>>>>,
): ShopReturnSettingsUpdate['reasons'] {
  return DEFAULT_REASONS.map((row) => ({ ...row, ...changes[row.reason] }));
}

/** 画面と同じ書き方の日本時間 */
function screenTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

type SaveMock = jest.Mock<Promise<ShopReturnSettings | null>, [ShopReturnSettingsUpdate]>;

/** 欄を描く。onSave は、渡した設定をそのまま「保存できた」と返す。rerender は、saving を切り替える試験が使う */
function renderSection(overrides: Partial<ShopReturnSettings> = {}, options: { saving?: boolean } = {}) {
  const settings = buildShopReturnSettings(overrides);
  const onSave: SaveMock = jest.fn<Promise<ShopReturnSettings | null>, [ShopReturnSettingsUpdate]>().mockResolvedValue(settings);
  const { rerender } = render(
    <ShopReturnSettingsSection settings={settings} saving={options.saving ?? false} onSave={onSave} />,
  );
  return { settings, onSave, rerender };
}

const region = (name: string) => screen.getByRole('region', { name });
const reasonRow = (name: string) => screen.getByRole('group', { name });
const saveButton = () => screen.getByRole('button', { name: '保存する' });
/** 入力欄と選択欄の値を入れ直す（見出しの文字で探す） */
const setValue = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
/** 理由ごとの行の中の選択欄を入れ直す（同じ見出しの選択欄が10行にあるので、行で絞る） */
const setReasonValue = (reasonName: string, label: string, value: string) =>
  fireEvent.change(within(reasonRow(reasonName)).getByLabelText(label), { target: { value } });
const toggle = (name: string) => fireEvent.click(screen.getByRole('switch', { name }));
const fillAddress = () => {
  setValue('名前', ADDRESS.name);
  setValue('郵便番号', ADDRESS.postalCode);
  setValue('住所', ADDRESS.address);
  setValue('電話番号', ADDRESS.phone);
};

describe('ShopReturnSettingsSection の表示', () => {
  it('欄の見出し「返品」と、6つのまとまり（申し込み・返送・受付の期限・理由ごとの設定・手数料・受け取り）を、この順に出す', () => {
    renderSection();

    expect(screen.getByRole('heading', { name: '返品', level: 3 })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)).toEqual(GROUP_NAMES);
    for (const name of GROUP_NAMES) {
      expect(region(name)).toBeInTheDocument();
    }
  });

  it('スイッチ5つ・選択欄43個・入力欄18個（複数行の欄を含む）・チェック11個を出す', () => {
    renderSection();

    // 申し込みの受付・「返送不要」・返品の手数料・交換の手数料と送料・要検品
    expect(screen.getAllByRole('switch')).toHaveLength(5);
    // 申し込みの種類・お客様の負担の時の送り方・数え始め、と、理由10個×（返送料の負担・在庫の無い交換・ご希望・写真）
    expect(screen.getAllByRole('combobox')).toHaveLength(43);
    // 注意書き・返送先4・返送料の定額・日数・届いた日の目安と、理由10個の写真の案内の文（手数料の欄は、トグルがオフの間は出ない）
    expect(screen.getAllByRole('textbox')).toHaveLength(18);
    // 「無制限」と、理由10個の「出す」
    expect(screen.getAllByRole('checkbox')).toHaveLength(11);
  });

  it('保存してある値を入力欄に出す', () => {
    renderSection({
      returnAddress: ADDRESS,
      customerPaidMethod: 'shop_label',
      shopLabelFee: 800,
      noReturnNeededEnabled: true,
      windowDays: 14,
      windowStart: 'last_item',
      deliveryBufferDays: 5,
      restockingFeeEnabled: true,
      restockingFeePercent: 10,
      exchangeFeesEnabled: true,
      exchangeFee: 300,
      exchangeShippingFee: 700,
      inspectionEnabled: true,
    });

    expect(screen.getByLabelText('名前')).toHaveValue(ADDRESS.name);
    expect(screen.getByLabelText('郵便番号')).toHaveValue(ADDRESS.postalCode);
    expect(screen.getByLabelText('住所')).toHaveValue(ADDRESS.address);
    expect(screen.getByLabelText('電話番号')).toHaveValue(ADDRESS.phone);
    expect(screen.getByLabelText('お客様の負担の時の送り方')).toHaveValue('shop_label');
    expect(screen.getByLabelText('返送料の定額（円）')).toHaveValue('800');
    expect(screen.getByRole('switch', { name: '「返送不要」を選べるようにする' })).toBeChecked();
    expect(screen.getByLabelText('日数')).toHaveValue('14');
    expect(screen.getByRole('checkbox', { name: '無制限' })).not.toBeChecked();
    expect(screen.getByLabelText('数え始め')).toHaveValue('last_item');
    expect(screen.getByLabelText('届いた日がわからない時の目安（日）')).toHaveValue('5');
    expect(screen.getByRole('switch', { name: '返品の手数料を使う' })).toBeChecked();
    expect(screen.getByLabelText('返品の手数料（%）')).toHaveValue('10');
    expect(screen.getByRole('switch', { name: '交換の手数料と送料を使う' })).toBeChecked();
    expect(screen.getByLabelText('交換の手数料（円）')).toHaveValue('300');
    expect(screen.getByLabelText('交換の送料（円）')).toHaveValue('700');
    expect(screen.getByRole('switch', { name: '要検品を使う' })).toBeChecked();
  });

  it('理由ごとに「返送料の負担」と「在庫の無い交換」を出し、最初の値を入れる（破損・不良と注文と違う品はお店負担で作って送る、ほかはお客様負担で受けない）', () => {
    renderSection();

    const expected: Array<[string, string, string]> = [
      ['破損・不良', 'shop', 'make'],
      ['注文と違う品が届いた', 'shop', 'make'],
      ['サイズが小さい', 'customer', 'decline'],
      ['サイズが大きい', 'customer', 'decline'],
      ['色がイメージと違った', 'customer', 'decline'],
      ['デザインが好みでない', 'customer', 'decline'],
      ['説明と違った', 'customer', 'decline'],
      ['不要になった', 'customer', 'decline'],
      ['その他', 'customer', 'decline'],
      ['不明', 'customer', 'decline'],
    ];
    for (const [name, payer, outOfStock] of expected) {
      const row = within(reasonRow(name));
      expect(row.getByLabelText('返送料の負担')).toHaveValue(payer);
      expect(row.getByLabelText('在庫の無い交換')).toHaveValue(outOfStock);
    }
  });

  it('手数料の入力欄は、使うトグルをオンにした時だけ出す', () => {
    renderSection();
    expect(screen.queryByLabelText('返品の手数料（%）')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('交換の手数料（円）')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('交換の送料（円）')).not.toBeInTheDocument();

    toggle('返品の手数料を使う');
    expect(screen.getByLabelText('返品の手数料（%）')).toHaveValue('0');
    expect(screen.queryByLabelText('交換の手数料（円）')).not.toBeInTheDocument();

    toggle('交換の手数料と送料を使う');
    expect(screen.getByLabelText('交換の手数料（円）')).toHaveValue('0');
    expect(screen.getByLabelText('交換の送料（円）')).toHaveValue('0');

    toggle('返品の手数料を使う');
    expect(screen.queryByLabelText('返品の手数料（%）')).not.toBeInTheDocument();
  });

  it('日数は「無制限」にチェックすると入力できなくなり、外すと元の日数で入力できる', () => {
    renderSection();
    const days = screen.getByLabelText('日数');
    expect(days).toBeEnabled();

    fireEvent.click(screen.getByRole('checkbox', { name: '無制限' }));
    expect(screen.getByRole('checkbox', { name: '無制限' })).toBeChecked();
    expect(days).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: '無制限' }));
    expect(days).toBeEnabled();
    expect(days).toHaveValue('7');
  });

  it('保存してある日数が無制限（null）の時は、チェックが入って日数は入力できない。外すと既定の7日が入る', () => {
    renderSection({ windowDays: null });
    expect(screen.getByRole('checkbox', { name: '無制限' })).toBeChecked();
    expect(screen.getByLabelText('日数')).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: '無制限' }));

    expect(screen.getByLabelText('日数')).toBeEnabled();
    expect(screen.getByLabelText('日数')).toHaveValue('7');
  });

  it('まとまりごとに「最後に変えた人」を出す。誰も変えていなければ「まだ変えていません」、メールが空なら「不明」', () => {
    const base = buildShopReturnSettings();
    renderSection({
      updated: {
        ...base.updated,
        shipping: { at: CHANGED_AT, byEmail: 'owner@example.com' },
        reasons: { at: EARLIER_AT, byEmail: null },
      },
    });

    const shipping = within(region('返送'));
    expect(shipping.getByText(`最後に変えた人: owner@example.com（${screenTime(CHANGED_AT)}）`)).toBeInTheDocument();
    // 日本時間で出す（UTC の 02:30 は日本時間の 11:30）。試験をする場所の時刻に左右されない
    expect(shipping.getByText(/11:30/)).toBeInTheDocument();
    expect(within(region('理由ごとの設定')).getByText(`最後に変えた人: 不明（${screenTime(EARLIER_AT)}）`)).toBeInTheDocument();
    for (const name of ['受付の期限', '手数料', '受け取り']) {
      expect(within(region(name)).getByText('まだ変えていません')).toBeInTheDocument();
    }
  });

  it('説明の文を出す', () => {
    renderSection();

    for (const text of [
      '返品の受付のお知らせに載せます。空の間は、返品を作れません。',
      'オンにすると、返品を作る画面で「返送不要」を選べます。',
      '配達の記録ができるまでは、発送の日にこの日数を足した日を届いた日とみなします。',
      '手で受け取った手数料は、帳簿に自動では入りません。',
      'オンにすると、受け取りの画面に「検品待ち」が出て、後で在庫に戻すかを決められます。',
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('返送先のまとまりと、選択欄の選択肢を C-5 の言葉で出す', () => {
    renderSection();
    const optionTexts = (select: HTMLElement) => within(select).getAllByRole('option').map((option) => option.textContent);

    expect(screen.getByRole('group', { name: '返送先' })).toBeInTheDocument();
    expect(optionTexts(screen.getByLabelText('お客様の負担の時の送り方'))).toEqual([
      'ご自身で送っていただく',
      'お店の送り状で送っていただき、返送料を差し引く',
    ]);
    expect(optionTexts(screen.getByLabelText('数え始め'))).toEqual(['品ごとの届いた日', '最後の品の届いた日']);
    const row = within(reasonRow('破損・不良'));
    expect(optionTexts(row.getByLabelText('返送料の負担'))).toEqual(['お店', 'お客様']);
    expect(optionTexts(row.getByLabelText('在庫の無い交換'))).toEqual(['作って送る', '受けない']);
  });
});

describe('ShopReturnSettingsSection の保存', () => {
  it('何も変えずに保存すると、保存してある値を、窓口の形（段1の14の欄と段2の3つの欄、理由の行は7つの欄）でそのまま渡す', async () => {
    const { onSave } = renderSection();

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(DEFAULT_INPUT);
  });

  it('入力欄で Enter を押しても保存する（フォームの送信）', async () => {
    const user = userEvent.setup();
    const { onSave } = renderSection();

    await user.type(screen.getByLabelText('日数'), '{Enter}');

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].windowDays).toBe(7);
  });

  it('入れ直した値を、数や文字に直して渡す（前後の空白は取り除く）', async () => {
    const { onSave } = renderSection();

    setValue('名前', ` ${ADDRESS.name} `);
    setValue('郵便番号', ADDRESS.postalCode);
    setValue('住所', ADDRESS.address);
    setValue('電話番号', ADDRESS.phone);
    setValue('お客様の負担の時の送り方', 'shop_label');
    setValue('返送料の定額（円）', '800');
    toggle('「返送不要」を選べるようにする');
    setValue('日数', '14');
    setValue('数え始め', 'last_item');
    setValue('届いた日がわからない時の目安（日）', '5');
    setReasonValue('サイズが小さい', '在庫の無い交換', 'make');
    setReasonValue('不明', '返送料の負担', 'shop');
    toggle('返品の手数料を使う');
    setValue('返品の手数料（%）', '10');
    toggle('交換の手数料と送料を使う');
    setValue('交換の手数料（円）', '300');
    setValue('交換の送料（円）', '700');
    toggle('要検品を使う');
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      requestsEnabled: true,
      requestTypes: 'returns_only',
      noticeText: '',
      returnAddress: ADDRESS,
      customerPaidMethod: 'shop_label',
      shopLabelFee: 800,
      noReturnNeededEnabled: true,
      windowDays: 14,
      windowStart: 'last_item',
      deliveryBufferDays: 5,
      reasons: reasonsWith({ size_too_small: { outOfStockExchange: 'make' }, unknown: { shippingPayer: 'shop' } }),
      restockingFeeEnabled: true,
      restockingFeePercent: 10,
      exchangeFeesEnabled: true,
      exchangeFee: 300,
      exchangeShippingFee: 700,
      inspectionEnabled: true,
    });
  });

  it('保存してあった返送先を4つとも空にして保存すると、返送先なし（null）で渡す', async () => {
    const { onSave } = renderSection({ returnAddress: ADDRESS });

    setValue('名前', '');
    setValue('郵便番号', '');
    setValue('住所', '');
    setValue('電話番号', '');
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].returnAddress).toBeNull();
  });

  it('トグルやチェックを切り替えただけでは保存しない。「保存する」を押した時だけ渡す', () => {
    const { onSave } = renderSection();

    toggle('「返送不要」を選べるようにする');
    toggle('返品の手数料を使う');
    toggle('要検品を使う');
    fireEvent.click(screen.getByRole('checkbox', { name: '無制限' }));

    expect(onSave).not.toHaveBeenCalled();
  });

  it('使わない手数料の欄は確かめず、保存してある値をそのまま渡す（変えたことにしない）', async () => {
    const { onSave } = renderSection({ restockingFeePercent: 15, exchangeFee: 400, exchangeShippingFee: 600 });
    // トグルがオフの間は欄が出ない。オンにして文字を入れ、またオフにする
    toggle('返品の手数料を使う');
    setValue('返品の手数料（%）', 'abc');
    toggle('返品の手数料を使う');

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      restockingFeeEnabled: false,
      restockingFeePercent: 15,
      exchangeFeesEnabled: false,
      exchangeFee: 400,
      exchangeShippingFee: 600,
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('無制限にチェックを入れた日数は確かめず、期限なし（null）で渡す', async () => {
    const { onSave } = renderSection();
    setValue('日数', 'abc');
    fireEvent.click(screen.getByRole('checkbox', { name: '無制限' }));

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].windowDays).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('保存できたら、窓口が返した値で入力を置き換える', async () => {
    const saved = buildShopReturnSettings({ returnAddress: { ...ADDRESS, name: '返品係（窓口が整えた名前）' } });
    const { onSave } = renderSection();
    onSave.mockResolvedValueOnce(saved);
    fillAddress();

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByLabelText('名前')).toHaveValue('返品係（窓口が整えた名前）'));
  });

  it('保存できなかった（null）時は、入力を残す', async () => {
    const { onSave } = renderSection();
    onSave.mockResolvedValueOnce(null);
    setValue('日数', '30');

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('日数')).toHaveValue('30');
    expect(saveButton()).toBeEnabled();
  });

  it('保存の最中（saving）に「保存する」を押しても、何も渡さない。ボタンは押せないようにしない', () => {
    const { onSave } = renderSection({}, { saving: true });

    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('保存の最中に「保存する」を押すと、済んでから押し直すよう知らせる。保存が済むと知らせは消え、次の保存の間には出ない', () => {
    const { settings, onSave, rerender } = renderSection({}, { saving: true });
    expect(screen.queryByText(PRESSED_WHILE_SAVING_MESSAGE)).not.toBeInTheDocument();

    fireEvent.click(saveButton());

    expect(screen.getByText(PRESSED_WHILE_SAVING_MESSAGE)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    rerender(<ShopReturnSettingsSection settings={settings} saving={false} onSave={onSave} />);
    expect(screen.queryByText(PRESSED_WHILE_SAVING_MESSAGE)).not.toBeInTheDocument();

    // 押していない次の保存の間は、前の押し直しの知らせを出さない
    rerender(<ShopReturnSettingsSection settings={settings} saving onSave={onSave} />);
    expect(screen.queryByText(PRESSED_WHILE_SAVING_MESSAGE)).not.toBeInTheDocument();
  });
});

describe('ShopReturnSettingsSection の入力の確かめ', () => {
  type InvalidCase = { name: string; prepare?: () => void; label: string; value: string; message: string };

  const INVALID_CASES: InvalidCase[] = [
    { name: '日数が0', label: '日数', value: '0', message: WINDOW_DAYS_MESSAGE },
    { name: '日数が366', label: '日数', value: '366', message: WINDOW_DAYS_MESSAGE },
    { name: '日数が文字', label: '日数', value: 'abc', message: WINDOW_DAYS_MESSAGE },
    { name: '日数が空', label: '日数', value: '', message: WINDOW_DAYS_MESSAGE },
    { name: '届いた日の目安が15', label: '届いた日がわからない時の目安（日）', value: '15', message: DELIVERY_BUFFER_MESSAGE },
    { name: '届いた日の目安がマイナス', label: '届いた日がわからない時の目安（日）', value: '-1', message: DELIVERY_BUFFER_MESSAGE },
    { name: '返送料の定額が小数', label: '返送料の定額（円）', value: '1.5', message: AMOUNT_MESSAGE },
    { name: '返送料の定額が1000001', label: '返送料の定額（円）', value: '1000001', message: AMOUNT_MESSAGE },
    {
      name: '返品の手数料が101%',
      prepare: () => toggle('返品の手数料を使う'),
      label: '返品の手数料（%）',
      value: '101',
      message: PERCENT_MESSAGE,
    },
    {
      name: '返品の手数料が小数',
      prepare: () => toggle('返品の手数料を使う'),
      label: '返品の手数料（%）',
      value: '2.5',
      message: PERCENT_MESSAGE,
    },
    {
      name: '交換の手数料がマイナス',
      prepare: () => toggle('交換の手数料と送料を使う'),
      label: '交換の手数料（円）',
      value: '-1',
      message: AMOUNT_MESSAGE,
    },
    {
      name: '交換の送料が文字',
      prepare: () => toggle('交換の手数料と送料を使う'),
      label: '交換の送料（円）',
      value: 'abc',
      message: AMOUNT_MESSAGE,
    },
    { name: '郵便番号が短い', prepare: fillAddress, label: '郵便番号', value: '1234', message: POSTAL_CODE_MESSAGE },
    { name: '郵便番号の桁が多い', prepare: fillAddress, label: '郵便番号', value: '150-00011', message: POSTAL_CODE_MESSAGE },
    { name: '電話番号が短い', prepare: fillAddress, label: '電話番号', value: '12345', message: PHONE_MESSAGE },
    { name: '電話番号に文字', prepare: fillAddress, label: '電話番号', value: '03-1234-abcd', message: PHONE_MESSAGE },
    { name: '名前が201字', prepare: fillAddress, label: '名前', value: 'あ'.repeat(201), message: TOO_LONG_MESSAGE },
    { name: '住所が201字', prepare: fillAddress, label: '住所', value: 'あ'.repeat(201), message: TOO_LONG_MESSAGE },
  ];

  it.each(INVALID_CASES)('$name の時は、その欄に誤りを出して移り、窓口へは渡さない', ({ prepare, label, value, message }) => {
    const { onSave } = renderSection();
    prepare?.();
    setValue(label, value);

    fireEvent.click(saveButton());

    const field = screen.getByLabelText(label);
    expect(field).toBeInvalid();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(field).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(SUMMARY);
    expect(onSave).not.toHaveBeenCalled();
  });

  type ValidCase = {
    name: string;
    prepare?: () => void;
    label: string;
    value: string;
    expected: Partial<ShopReturnSettingsUpdate>;
  };

  const VALID_CASES: ValidCase[] = [
    { name: '日数1', label: '日数', value: '1', expected: { windowDays: 1 } },
    { name: '日数365', label: '日数', value: '365', expected: { windowDays: 365 } },
    { name: '日数の前後に空白', label: '日数', value: ' 30 ', expected: { windowDays: 30 } },
    { name: '届いた日の目安0', label: '届いた日がわからない時の目安（日）', value: '0', expected: { deliveryBufferDays: 0 } },
    { name: '届いた日の目安14', label: '届いた日がわからない時の目安（日）', value: '14', expected: { deliveryBufferDays: 14 } },
    { name: '返送料の定額1000000', label: '返送料の定額（円）', value: '1000000', expected: { shopLabelFee: 1000000 } },
    {
      name: '返品の手数料100%',
      prepare: () => toggle('返品の手数料を使う'),
      label: '返品の手数料（%）',
      value: '100',
      expected: { restockingFeeEnabled: true, restockingFeePercent: 100 },
    },
  ];

  it.each(VALID_CASES)('範囲の中の値（$name）は通って、窓口へ渡る', async ({ prepare, label, value, expected }) => {
    const { onSave } = renderSection();
    prepare?.();
    setValue(label, value);

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject(expected);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('返送先を1つだけ入れて保存すると、残りの3つに誤りを出し、最初の誤りの欄に移る。窓口へは渡さない', () => {
    const { onSave } = renderSection();
    setValue('名前', ADDRESS.name);

    fireEvent.click(saveButton());

    expect(screen.getByRole('alert')).toHaveTextContent(SUMMARY);
    expect(screen.getAllByText(ADDRESS_REQUIRED_MESSAGE)).toHaveLength(3);
    expect(screen.getByLabelText('名前')).not.toBeInvalid();
    for (const label of ['郵便番号', '住所', '電話番号']) {
      expect(screen.getByLabelText(label)).toBeInvalid();
    }
    expect(screen.getByLabelText('郵便番号')).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('誤りが2つ以上ある時は、全部の欄に誤りを出し、画面の上にある欄に移る', () => {
    renderSection();
    setValue('届いた日がわからない時の目安（日）', '99');
    setValue('日数', '0');

    fireEvent.click(saveButton());

    expect(screen.getByLabelText('日数')).toBeInvalid();
    expect(screen.getByLabelText('届いた日がわからない時の目安（日）')).toBeInvalid();
    expect(screen.getByLabelText('日数')).toHaveFocus();
  });

  it('誤りを直すと、その欄の誤りとまとめの文が消え、直した後の保存は窓口へ渡る', async () => {
    const { onSave } = renderSection();
    setValue('日数', '0');
    fireEvent.click(saveButton());
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('日数')).toBeInvalid();

    setValue('日数', '30');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('日数')).not.toBeInvalid();
    expect(screen.queryByText(WINDOW_DAYS_MESSAGE)).not.toBeInTheDocument();

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].windowDays).toBe(30);
  });

  it('「保存する」を押す前は、誤りの入力があっても誤りを出さない', () => {
    renderSection();

    setValue('日数', '0');

    expect(screen.getByLabelText('日数')).not.toBeInvalid();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ここから下は、グループ E-3 段2（Task 13）で足した試験。申し込みのまとまりと、理由ごとの出す・ご希望・写真・写真の案内の文

const REQUESTS_LABEL = 'お客様からの申し込みを受け付ける';
const NOTICE_LABEL = '申し込みの画面の注意書き';
const UNKNOWN_NOT_SHOWN_NOTE = '「不明」はお客様に出しません。';

/** 保存してある返品の設定の理由ごとの行を、指した理由だけ書き換えた物 */
function savedReasons(
  changes: Partial<Record<ReturnReason, Partial<ShopReturnSettings['reasons'][number]>>>,
): ShopReturnSettings['reasons'] {
  return buildShopReturnSettings().reasons.map((row) => ({ ...row, ...changes[row.reason] }));
}

const selectOptionTexts = (select: HTMLElement) => within(select).getAllByRole('option').map((option) => option.textContent);
/** 理由ごとの行（名前は理由の言葉）の中の欄を、見出しの文字で探す。同じ見出しが10行にあるので、行で絞る */
const reasonField = (reasonName: string, label: string) => within(reasonRow(reasonName)).getByLabelText(label);
const shownCheckbox = (reasonName: string) => within(reasonRow(reasonName)).getByRole('checkbox', { name: '出す' });

describe('ShopReturnSettingsSection の申し込みのまとまり（段2）', () => {
  it('受付のトグル・申し込みの種類・注意書きを、保存してある値で出す', () => {
    renderSection({
      requestsEnabled: false,
      requestTypes: 'cancellations_only',
      noticeText: '返品はお申し込みの後にご案内します。',
    });

    const requests = within(region('申し込み'));
    expect(requests.getByRole('switch', { name: REQUESTS_LABEL })).not.toBeChecked();
    expect(requests.getByLabelText('申し込みの種類')).toHaveValue('cancellations_only');
    expect(requests.getByLabelText(NOTICE_LABEL)).toHaveValue('返品はお申し込みの後にご案内します。');
  });

  it('最初の値（受付はオン・返品だけ・注意書きは空）を出す', () => {
    renderSection();

    expect(screen.getByRole('switch', { name: REQUESTS_LABEL })).toBeChecked();
    expect(screen.getByLabelText('申し込みの種類')).toHaveValue('returns_only');
    expect(screen.getByLabelText(NOTICE_LABEL)).toHaveValue('');
  });

  it('申し込みの種類の選択肢を「返品とキャンセル」「返品だけ」「キャンセルだけ」の順に出し、注意書きの説明を出す', () => {
    renderSection();

    expect(selectOptionTexts(screen.getByLabelText('申し込みの種類'))).toEqual(['返品とキャンセル', '返品だけ', 'キャンセルだけ']);
    expect(screen.getByText('申し込みの画面のいちばん上に出します（2000字まで）。')).toBeInTheDocument();
  });

  it('注意書きは複数行の欄（textarea）で入れる', () => {
    renderSection();

    expect(screen.getByLabelText(NOTICE_LABEL).tagName).toBe('TEXTAREA');
  });

  it('受付のトグルを切り替えただけでは保存しない', () => {
    const { onSave } = renderSection();

    toggle(REQUESTS_LABEL);

    expect(screen.getByRole('switch', { name: REQUESTS_LABEL })).not.toBeChecked();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('入れ直した受付・種類・注意書きを、窓口の形で渡す。注意書きの前後の空白は取り除き、途中の改行は残す', async () => {
    const { onSave } = renderSection();

    toggle(REQUESTS_LABEL);
    setValue('申し込みの種類', 'returns_and_cancellations');
    setValue(NOTICE_LABEL, '  返品は商品到着後7日以内に\nお申し込みください。\n');
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      requestsEnabled: false,
      requestTypes: 'returns_and_cancellations',
      noticeText: '返品は商品到着後7日以内に\nお申し込みください。',
    });
  });

  it('注意書きは前後の空白を数えず、2000字までなら通る', async () => {
    const { onSave } = renderSection();
    setValue(NOTICE_LABEL, `${'あ'.repeat(2000)}  `);

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].noticeText).toBe('あ'.repeat(2000));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('注意書きが2001字だと、欄に誤りを出し、窓口へ渡さず、その欄へ移る', () => {
    const { onSave } = renderSection();
    setValue(NOTICE_LABEL, 'あ'.repeat(2001));

    fireEvent.click(saveButton());

    const field = screen.getByLabelText(NOTICE_LABEL);
    expect(field).toBeInvalid();
    expect(screen.getByText(NOTICE_TOO_LONG_MESSAGE)).toBeInTheDocument();
    expect(field).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(SUMMARY);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('申し込みのまとまりの「最後に変えた人」は updated.requests を出す。ほかのまとまりは変わらない', () => {
    const base = buildShopReturnSettings();
    renderSection({ updated: { ...base.updated, requests: { at: CHANGED_AT, byEmail: 'owner@example.com' } } });

    expect(within(region('申し込み')).getByText(`最後に変えた人: owner@example.com（${screenTime(CHANGED_AT)}）`)).toBeInTheDocument();
    for (const name of ['返送', '受付の期限', '理由ごとの設定', '手数料', '受け取り']) {
      expect(within(region(name)).getByText('まだ変えていません')).toBeInTheDocument();
    }
  });

  it('保存できたら、受付・種類・注意書きも窓口が返した値で置き換える', async () => {
    const saved = buildShopReturnSettings({
      requestsEnabled: false,
      requestTypes: 'returns_and_cancellations',
      noticeText: '窓口が整えた注意書き',
    });
    const { onSave } = renderSection();
    onSave.mockResolvedValueOnce(saved);
    setValue(NOTICE_LABEL, '入れた注意書き');

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByLabelText(NOTICE_LABEL)).toHaveValue('窓口が整えた注意書き'));
    expect(screen.getByRole('switch', { name: REQUESTS_LABEL })).not.toBeChecked();
    expect(screen.getByLabelText('申し込みの種類')).toHaveValue('returns_and_cancellations');
  });
});

describe('ShopReturnSettingsSection の理由ごとの出す・ご希望・写真・写真の案内の文（段2）', () => {
  it('理由ごとの行に「出す」「ご希望」「写真」「写真の案内の文」を出し、最初の値は仕様書 8-3 の表のとおり', () => {
    renderSection();

    const expected: Array<[string, boolean, string, string, string]> = [
      ['破損・不良', true, 'refund_and_exchange', 'required', DEFECT_PHOTO_NOTE],
      ['注文と違う品が届いた', true, 'refund_and_exchange', 'required', DEFECT_PHOTO_NOTE],
      ['サイズが小さい', true, 'exchange_only', 'optional', SIZE_PHOTO_NOTE],
      ['サイズが大きい', true, 'exchange_only', 'optional', SIZE_PHOTO_NOTE],
      ['色がイメージと違った', false, 'refund_and_exchange', 'optional', ''],
      ['デザインが好みでない', false, 'refund_and_exchange', 'optional', ''],
      ['説明と違った', false, 'refund_and_exchange', 'optional', ''],
      ['不要になった', false, 'refund_and_exchange', 'optional', ''],
      ['その他', true, 'refund_and_exchange', 'optional', ''],
      ['不明', false, 'refund_and_exchange', 'none', ''],
    ];
    for (const [name, shown, resolutions, photo, instructions] of expected) {
      expect(shownCheckbox(name)).toHaveProperty('checked', shown);
      expect(reasonField(name, 'ご希望')).toHaveValue(resolutions);
      expect(reasonField(name, '写真')).toHaveValue(photo);
      expect(reasonField(name, '写真の案内の文')).toHaveValue(instructions);
    }
  });

  it('ご希望と写真の選択肢を C-5 の言葉で、この順に出す', () => {
    renderSection();

    expect(selectOptionTexts(reasonField('破損・不良', 'ご希望'))).toEqual(['返金と交換', '交換だけ', '返金だけ']);
    expect(selectOptionTexts(reasonField('破損・不良', '写真'))).toEqual(['なし', '任意', '必須']);
  });

  it('「写真の案内の文」は複数行の欄（textarea）で入れる', () => {
    renderSection();

    expect(reasonField('破損・不良', '写真の案内の文').tagName).toBe('TEXTAREA');
  });

  it('「不明」の行の「出す」はオフで選べず、「「不明」はお客様に出しません。」の説明が付く。ほかの行には説明も無効も無い', () => {
    renderSection();

    expect(shownCheckbox('不明')).not.toBeChecked();
    expect(shownCheckbox('不明')).toBeDisabled();
    expect(shownCheckbox('不明')).toHaveAccessibleDescription(UNKNOWN_NOT_SHOWN_NOTE);
    expect(screen.getAllByText(UNKNOWN_NOT_SHOWN_NOTE)).toHaveLength(1);
    for (const name of ['破損・不良', '色がイメージと違った', 'その他']) {
      expect(shownCheckbox(name)).toBeEnabled();
    }
  });

  it('保存してある「不明」の「出す」がオンでも、画面ではオフにし、保存ではオフで渡す', async () => {
    const { onSave } = renderSection({ reasons: savedReasons({ unknown: { shown: true } }) });

    expect(shownCheckbox('不明')).not.toBeChecked();
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].reasons.find((row) => row.reason === 'unknown')?.shown).toBe(false);
  });

  it('入れ直した「出す」「ご希望」「写真」「写真の案内の文」を、理由ごとの行で渡す。案内の文の前後の空白は取り除く', async () => {
    const { onSave } = renderSection();

    fireEvent.click(shownCheckbox('色がイメージと違った'));
    fireEvent.click(shownCheckbox('その他'));
    setReasonValue('サイズが小さい', 'ご希望', 'refund_only');
    setReasonValue('サイズが小さい', '写真', 'required');
    fireEvent.change(reasonField('その他', '写真の案内の文'), { target: { value: ' 全体と傷の写真をお送りください \n' } });
    setReasonValue('不明', '写真', 'optional');
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].reasons).toEqual(
      reasonsWith({
        color: { shown: true },
        size_too_small: { resolutions: 'refund_only', photo: 'required' },
        other: { shown: false, photoInstructions: '全体と傷の写真をお送りください' },
        unknown: { photo: 'optional' },
      }),
    );
  });

  it('写真の案内の文は前後の空白を数えず、500字までなら通る', async () => {
    const { onSave } = renderSection();
    fireEvent.change(reasonField('サイズが小さい', '写真の案内の文'), { target: { value: `${'あ'.repeat(500)}  ` } });

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].reasons.find((row) => row.reason === 'size_too_small')?.photoInstructions).toBe('あ'.repeat(500));
  });

  it('写真の案内の文が501字だと、その行の欄に誤りを出し、窓口へ渡さず、その欄へ移る。ほかの行には誤りを出さない', () => {
    const { onSave } = renderSection();
    fireEvent.change(reasonField('サイズが小さい', '写真の案内の文'), { target: { value: 'あ'.repeat(501) } });

    fireEvent.click(saveButton());

    const field = reasonField('サイズが小さい', '写真の案内の文');
    expect(field).toBeInvalid();
    expect(within(reasonRow('サイズが小さい')).getByText(PHOTO_INSTRUCTIONS_TOO_LONG_MESSAGE)).toBeInTheDocument();
    expect(screen.getAllByText(PHOTO_INSTRUCTIONS_TOO_LONG_MESSAGE)).toHaveLength(1);
    expect(reasonField('サイズが大きい', '写真の案内の文')).not.toBeInvalid();
    expect(field).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(SUMMARY);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('誤りが2つ以上ある時は、画面の上にある欄に移る（注意書き → 写真の案内の文 → 手数料の順）', () => {
    renderSection();
    toggle('返品の手数料を使う');
    setValue('返品の手数料（%）', '101');
    fireEvent.change(reasonField('その他', '写真の案内の文'), { target: { value: 'あ'.repeat(501) } });

    fireEvent.click(saveButton());
    expect(reasonField('その他', '写真の案内の文')).toHaveFocus();

    setValue(NOTICE_LABEL, 'あ'.repeat(2001));
    fireEvent.click(saveButton());
    expect(screen.getByLabelText(NOTICE_LABEL)).toHaveFocus();
  });

  it('保存できたら、理由ごとの列も窓口が返した値で置き換える', async () => {
    const saved = buildShopReturnSettings({
      reasons: savedReasons({ other: { photo: 'required', photoInstructions: '窓口が整えた案内' } }),
    });
    const { onSave } = renderSection();
    onSave.mockResolvedValueOnce(saved);
    fireEvent.change(reasonField('その他', '写真の案内の文'), { target: { value: '入れた案内' } });

    fireEvent.click(saveButton());

    await waitFor(() => expect(reasonField('その他', '写真の案内の文')).toHaveValue('窓口が整えた案内'));
    expect(reasonField('その他', '写真')).toHaveValue('required');
  });

  it('理由ごとの行は10個のまま。行の中に別の group を作らない（FR-ADMIN-092 が数える）', () => {
    renderSection();

    expect(within(region('理由ごとの設定')).getAllByRole('group')).toHaveLength(10);
  });
});
