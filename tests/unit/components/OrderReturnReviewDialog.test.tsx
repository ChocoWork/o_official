import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RETURN_DECLINE_MESSAGE_PREFILL } from '@/lib/orders/returns/return-messages';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';
import {
  APPROVE_URL,
  DECLINE_URL,
  LABEL,
  MATERIALS_URL,
  ORDER_ID,
  PHOTOS_URL,
  REQUESTED_AT,
  RETURNS_URL,
  RETURN_ID,
  jsonResponse,
  jstText,
  returnDetail,
  returnLine,
  reviewMaterials,
} from './return-review-test-fixtures';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderReturnReviewDialog from '@/components/OrderReturnReviewDialog';

const TITLE = `返品の申し込みを確かめる（${LABEL}）`;
const DECLINE_TITLE = `お断りする（${LABEL}）`;
const LINE_NAME = 'シルクブラウス（白 / M）';
const STATE_CONFLICT = '返品の状態が変わりました。画面を開き直してください。';
const UNKNOWN_MESSAGE = '操作の結果を確かめられませんでした。「もう一度確かめる」を押すと、確かめ直します。';
const ADDRESS_MISSING = '返送先が設定されていません。ショップの設定で返送先を入れてから作ってください。';
const NO_EXCHANGE_TARGET = '交換できる色・サイズがありません。解決の方法を返金にするか、お断りしてください。';
const PHOTO_URLS = ['https://storage.example.test/photo-1.jpg', 'https://storage.example.test/photo-2.jpg'];

type Routes = Partial<Record<'returns' | 'materials' | 'photos' | 'approve' | 'decline', () => Response>>;

/** 注文の返品の窓口（GET）の答え。操作の画面はこれを読んで、returnId の返品を探す */
function returnsAnswer(detail: OrderReturnDetail): Response {
  return jsonResponse({
    data: { returns: [detail], canRefund: true, returnableUnits: 0, refundableAmount: 24000, refundableShipping: 800, inspectionEnabled: false },
  });
}

/** 窓口ごとの答え。省いた窓口は成功の答えを返す。想定しない窓口を呼んだら試験を落とす */
function installRoutes(detail: OrderReturnDetail, routes: Routes = {}) {
  mockClientFetch.mockImplementation(async (url: string) => {
    if (url === RETURNS_URL) return (routes.returns ?? (() => returnsAnswer(detail)))();
    if (url === MATERIALS_URL) return (routes.materials ?? (() => jsonResponse({ data: reviewMaterials() })))();
    if (url === PHOTOS_URL) return (routes.photos ?? (() => jsonResponse({ data: { photos: [] } })))();
    if (url === APPROVE_URL) return (routes.approve ?? (() => jsonResponse({ data: { returnStatus: 'open' } })))();
    if (url === DECLINE_URL) return (routes.decline ?? (() => jsonResponse({ data: { returnStatus: 'declined' } })))();
    throw new Error(`想定しない窓口です: ${url}`);
  });
}

/** 画面を開き、材料を読み終えるまで待つ（承認の欄の「読み込み中です...」が消える） */
async function openDialog(detail: OrderReturnDetail = returnDetail(), routes: Routes = {}) {
  installRoutes(detail, routes);
  const props = { onClose: jest.fn(), onDone: jest.fn(), onUncertain: jest.fn(), onApproved: jest.fn() };
  const utils = render(<OrderReturnReviewDialog orderId={ORDER_ID} returnId={RETURN_ID} {...props} />);
  const dialog = await screen.findByRole('dialog', { name: TITLE });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return { ...utils, ...props, dialog };
}

/** 「お断りする」を押して、お断りの画面にする */
async function openDecline(detail: OrderReturnDetail = returnDetail(), routes: Routes = {}) {
  const opened = await openDialog(detail, routes);
  fireEvent.click(within(opened.dialog).getByRole('button', { name: 'お断りする' }));
  const decline = await screen.findByRole('dialog', { name: DECLINE_TITLE });
  return { ...opened, decline };
}

/** 窓口へ POST した本文（JSON の文字）を、呼んだ順に */
function postedBodies(url: string): string[] {
  return mockClientFetch.mock.calls
    .filter(([calledUrl, init]) => calledUrl === url && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => (init as RequestInit).body as string);
}

const postedBody = (url: string): Record<string, unknown> => JSON.parse(postedBodies(url)[0]) as Record<string, unknown>;
const buttonNames = (scope: HTMLElement) => within(scope).queryAllByRole('button').map((button) => button.textContent);
const approveButton = (scope: HTMLElement) => within(scope).getByRole('button', { name: '承認する' });
const reasonSelect = (scope: HTMLElement) => within(scope).getByRole('combobox', { name: 'お断りの理由（お客様には見えません）' });
const messageBox = (scope: HTMLElement) => within(scope).getByRole('textbox', { name: 'お客様へのメッセージ（必須・お客様に届きます）' });
const declineButton = (scope: HTMLElement) => within(scope).getByRole('button', { name: 'お断りする' });

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderReturnReviewDialog の申し込みの中身', () => {
  it('申し込みの日時・品・理由・詳しい内容・ご希望を出す', async () => {
    const { dialog } = await openDialog(
      returnDetail({ lines: [returnLine({ customerNote: '袖のほつれがあります。\n他は問題ありません。' })] }),
    );

    expect(within(dialog).getByText(`申し込み: ${jstText(REQUESTED_AT)}`)).toBeInTheDocument();
    const group = within(dialog).getByRole('group', { name: LINE_NAME });
    expect(within(group).getByText('シルクブラウス（白 / M） × 2')).toBeInTheDocument();
    expect(within(group).getByText('理由: 破損・不良')).toBeInTheDocument();
    expect(within(group).getByText(/^詳しい内容: 袖のほつれがあります。/)).toBeInTheDocument();
    expect(within(group).getByText('ご希望: 返金')).toBeInTheDocument();
    expect(within(group).queryByText('返品不可の品です')).not.toBeInTheDocument();
    expect(within(group).queryByText(/写真/)).not.toBeInTheDocument();
  });

  it('お客様が書いた文は、書かれたとおりの字で出す（HTML として読まない）', async () => {
    const { dialog } = await openDialog(returnDetail({ lines: [returnLine({ customerNote: '<b>太字</b>で書きました' })] }));

    expect(within(dialog).getByText('詳しい内容: <b>太字</b>で書きました')).toBeInTheDocument();
    expect(dialog.querySelector('b')).toBeNull();
  });

  it('交換のご希望と、返品不可の品の印を出す。詳しい内容が無ければその行は出さない', async () => {
    const { dialog } = await openDialog(
      returnDetail({
        lines: [
          returnLine({
            resolution: 'exchange',
            exchange: { variantId: 102, color: '白', size: 'L', method: 'make', stockQuantity: 0, madeToOrderLeadDays: 14, outOfStockExchange: 'make' },
            requestedResolution: 'exchange',
            requestedExchange: { variantId: 102, color: '白', size: 'L' },
            customerNote: null,
            returnIneligible: true,
          }),
        ],
      }),
    );

    const group = within(dialog).getByRole('group', { name: LINE_NAME });
    expect(within(group).getByText('ご希望: 交換（白 / L）')).toBeInTheDocument();
    expect(within(group).getByText('返品不可の品です')).toBeInTheDocument();
    expect(within(group).queryByText(/詳しい内容/)).not.toBeInTheDocument();
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async () => {
    const { dialog } = await openDialog();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });
});

describe('OrderReturnReviewDialog の写真', () => {
  const withPhotos = () =>
    returnDetail({ lines: [returnLine({ photos: [{ id: 'photo-1', purged: false }, { id: 'photo-2', purged: false }] })] });
  const photoLinks = () =>
    jsonResponse({
      data: {
        photos: [
          { photoId: 'photo-1', returnLineId: 'line-blouse', url: PHOTO_URLS[0], purged: false },
          { photoId: 'photo-2', returnLineId: 'line-blouse', url: PHOTO_URLS[1], purged: false },
        ],
      },
    });

  it('写真があれば窓口 /photos を読み、枚数・小さい写真・「写真を大きく見る」を出す', async () => {
    const { dialog } = await openDialog(withPhotos(), { photos: photoLinks });

    const group = within(dialog).getByRole('group', { name: LINE_NAME });
    expect(within(group).getByText('写真 2枚')).toBeInTheDocument();
    expect(await within(group).findByRole('button', { name: '写真 1 を大きく見る' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: '写真 2 を大きく見る' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: '写真を大きく見る' })).toBeInTheDocument();
    expect(Array.from(group.querySelectorAll('img')).map((image) => image.getAttribute('src'))).toEqual(PHOTO_URLS);
    expect(mockClientFetch).toHaveBeenCalledWith(PHOTOS_URL, { cache: 'no-store' });
  });

  it('「写真を大きく見る」で大きく見る画面を開く。確かめる画面は消え、前後の写真に動ける', async () => {
    const { dialog } = await openDialog(withPhotos(), { photos: photoLinks });

    fireEvent.click(await within(dialog).findByRole('button', { name: '写真を大きく見る' }));

    const viewer = await screen.findByRole('dialog', { name: '写真（1／2）' });
    expect(screen.queryByRole('dialog', { name: TITLE })).not.toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(viewer).getByRole('img', { name: '写真 1' })).toHaveAttribute('src', PHOTO_URLS[0]);

    fireEvent.click(within(viewer).getByRole('button', { name: '次の写真' }));
    expect(screen.getByRole('dialog', { name: '写真（2／2）' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '写真 2' })).toHaveAttribute('src', PHOTO_URLS[1]);
  });

  it('小さい写真からはその写真を開く。閉じると確かめる画面に戻り、入力は残る', async () => {
    const { dialog } = await openDialog(withPhotos(), { photos: photoLinks });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' }), { target: { value: '先に電話する' } });

    fireEvent.click(await within(dialog).findByRole('button', { name: '写真 2 を大きく見る' }));
    const viewer = await screen.findByRole('dialog', { name: '写真（2／2）' });
    fireEvent.click(within(viewer).getByRole('button', { name: '閉じる' }));

    const back = await screen.findByRole('dialog', { name: TITLE });
    expect(within(back).getByRole('textbox', { name: 'メモ（お客様には見えません）' })).toHaveValue('先に電話する');
    expect(screen.queryByRole('dialog', { name: '写真（2／2）' })).not.toBeInTheDocument();
  });

  it('写真の一覧を読めない時は、枚数のほかに読めない旨を出し、大きく見るボタンは出さない', async () => {
    const { dialog } = await openDialog(withPhotos(), { photos: () => jsonResponse({ error: 'x' }, 500) });

    const group = within(dialog).getByRole('group', { name: LINE_NAME });
    expect(await within(group).findByText('写真を読み込めませんでした。')).toBeInTheDocument();
    expect(within(group).getByText('写真 2枚')).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: '写真を大きく見る' })).not.toBeInTheDocument();
  });

  it('リンクを作れなかった写真（消した写真ではない）があれば、読めない旨を出し、作れた写真だけを大きく見られる', async () => {
    const { dialog } = await openDialog(withPhotos(), {
      photos: () =>
        jsonResponse({
          data: {
            photos: [
              { photoId: 'photo-1', returnLineId: 'line-blouse', url: PHOTO_URLS[0], purged: false },
              { photoId: 'photo-2', returnLineId: 'line-blouse', url: null, purged: false },
            ],
          },
        }),
    });

    const group = within(dialog).getByRole('group', { name: LINE_NAME });
    expect(await within(group).findByText('写真を読み込めませんでした。')).toBeInTheDocument();
    expect(within(group).getByText('写真 2枚')).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: '写真 1 を大きく見る' })).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: '写真 2 を大きく見る' })).not.toBeInTheDocument();

    fireEvent.click(within(group).getByRole('button', { name: '写真を大きく見る' }));
    expect(await screen.findByRole('dialog', { name: '写真（1／1）' })).toBeInTheDocument();
  });

  it('画像を読み込めなかった時（10分のリンクが切れた）は、読み込めない旨を出す', async () => {
    const { dialog } = await openDialog(withPhotos(), { photos: photoLinks });
    const group = within(dialog).getByRole('group', { name: LINE_NAME });
    await within(group).findByRole('button', { name: '写真 1 を大きく見る' });
    expect(within(group).queryByText('写真を読み込めませんでした。')).not.toBeInTheDocument();

    fireEvent.error(group.querySelectorAll('img')[0]);

    expect(await within(group).findByText('写真を読み込めませんでした。')).toBeInTheDocument();
  });

  it('消した写真は、枚数のほかに消した旨を出し、大きく見るボタンは出さない', async () => {
    const detail = returnDetail({ lines: [returnLine({ photos: [{ id: 'photo-1', purged: true }] })] });
    const { dialog } = await openDialog(detail, {
      photos: () =>
        jsonResponse({ data: { photos: [{ photoId: 'photo-1', returnLineId: 'line-blouse', url: null, purged: true }] } }),
    });

    const group = within(dialog).getByRole('group', { name: LINE_NAME });
    expect(within(group).getByText('写真 1枚')).toBeInTheDocument();
    expect(within(group).getByText('写真は消しました（返品が終わってから90日を過ぎたため）')).toBeInTheDocument();
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledWith(PHOTOS_URL, { cache: 'no-store' }));
    expect(within(group).queryByRole('button', { name: '写真を大きく見る' })).not.toBeInTheDocument();
  });

  it('写真が無い申し込みは、写真の窓口を読まない', async () => {
    await openDialog();

    expect(mockClientFetch.mock.calls.map(([url]) => url)).not.toContain(PHOTOS_URL);
  });
});

describe('OrderReturnReviewDialog の承認の欄の最初の値', () => {
  it('返送・手数料・メモ・知らせ・行ごとの解決は、返品の今の値から始める', async () => {
    const detail = returnDetail({
      returnMethod: 'shop_label',
      returnShippingPayer: 'customer',
      returnCarrier: 'yamato',
      returnTrackingNumber: 'AB-123',
      fees: {
        returnShippingFee: 800, restockingFeePercent: 10, exchangeFee: 500, exchangeShippingFee: 300,
        feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
      },
      shopNote: '先に確認',
      notifyCustomer: false,
      lines: [
        returnLine({
          resolution: 'exchange',
          exchange: { variantId: 104, color: '青', size: 'M', method: 'make', stockQuantity: 1, madeToOrderLeadDays: 10, outOfStockExchange: 'decline' },
          requestedResolution: 'exchange',
          requestedExchange: { variantId: 104, color: '青', size: 'M' },
        }),
      ],
    });
    const materials = reviewMaterials({ restockingFeeEnabled: true, restockingFeePercent: 10, exchangeFeesEnabled: true, noReturnNeededEnabled: true });
    const { dialog } = await openDialog(detail, { materials: () => jsonResponse({ data: materials }) });

    expect(within(dialog).getByText('承認する時の内容')).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: '返送の方法' })).toHaveValue('shop_label');
    expect(within(dialog).getByRole('combobox', { name: '返送料の負担' })).toHaveValue('customer');
    expect(within(dialog).getByRole('combobox', { name: '返送の配送業者（任意）' })).toHaveValue('yamato');
    expect(within(dialog).getByRole('textbox', { name: '返送の伝票番号（任意）' })).toHaveValue('AB-123');
    expect(within(dialog).getByLabelText('返送料（円）')).toHaveValue(800);
    expect(within(dialog).getByLabelText('返品の手数料（%）')).toHaveValue('10');
    expect(within(dialog).getByLabelText('交換の手数料（円）')).toHaveValue(500);
    expect(within(dialog).getByLabelText('交換の送料（円）')).toHaveValue(300);
    expect(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' })).toHaveValue('先に確認');
    expect(within(dialog).getByRole('checkbox', { name: 'お客様に返品の受付のお知らせを送る' })).not.toBeChecked();

    const lineGroup = within(dialog).getByRole('group', { name: `${LINE_NAME}の解決` });
    expect(within(lineGroup).getByRole('combobox', { name: '解決の方法' })).toHaveValue('exchange');
    expect(within(lineGroup).getByRole('combobox', { name: '交換の色・サイズ' })).toHaveValue('104');
    expect(within(lineGroup).getByText('在庫: 1')).toBeInTheDocument();
    expect(within(lineGroup).getByRole('combobox', { name: '送り方' })).toHaveValue('make');
  });

  it('手数料の欄は、設定で使う物だけ出す（返金の行・お客様が送る・手数料なしの設定では出ない）', async () => {
    const { dialog } = await openDialog();

    expect(within(dialog).queryByRole('region', { name: '手数料' })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('返送料（円）')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('返品の手数料（%）')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('交換の手数料（円）')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: '返送' })).toBeInTheDocument();
  });

  it('返送不要は、設定でオンの時だけ選べる', async () => {
    const off = await openDialog();
    const offMethod = within(off.dialog).getByRole('combobox', { name: '返送の方法' });
    expect(within(offMethod).queryByRole('option', { name: '返送不要' })).not.toBeInTheDocument();
    off.unmount();

    mockClientFetch.mockReset();
    const on = await openDialog(undefined, { materials: () => jsonResponse({ data: reviewMaterials({ noReturnNeededEnabled: true }) }) });
    const onMethod = within(on.dialog).getByRole('combobox', { name: '返送の方法' });
    expect(within(onMethod).getByRole('option', { name: '返送不要' })).toBeInTheDocument();
  });
});

describe('OrderReturnReviewDialog の承認', () => {
  it('そのまま「承認する」を押すと、返品の今の値を窓口へ送り、親に承認を伝える', async () => {
    const { dialog, onApproved, onDone } = await openDialog();

    fireEvent.click(approveButton(dialog));

    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
    expect(onApproved).toHaveBeenCalledWith({ notRequired: false });
    expect(onDone).not.toHaveBeenCalled();
    expect(postedBody(APPROVE_URL)).toEqual({
      lines: [{ returnLineId: 'line-blouse', resolution: 'refund', exchangeVariantId: null, exchangeMethod: null }],
      returnMethod: 'customer_ships',
      returnShippingPayer: 'shop',
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

  it('解決・交換の色・サイズ・送り方・返送・手数料・メモ・知らせを変えて承認すると、変えた値を送る', async () => {
    const materials = reviewMaterials({ restockingFeeEnabled: true, exchangeFeesEnabled: true });
    const { dialog, onApproved } = await openDialog(undefined, { materials: () => jsonResponse({ data: materials }) });

    const lineGroup = within(dialog).getByRole('group', { name: `${LINE_NAME}の解決` });
    fireEvent.change(within(lineGroup).getByRole('combobox', { name: '解決の方法' }), { target: { value: 'exchange' } });
    // 交換にすると、元と同じ色・サイズ（在庫5）が選ばれ、在庫が数（2）以上なので「在庫から」
    expect(within(lineGroup).getByRole('combobox', { name: '交換の色・サイズ' })).toHaveValue('101');
    expect(within(lineGroup).getByRole('combobox', { name: '送り方' })).toHaveValue('stock');
    // 在庫0の色・サイズを選ぶと、送り方は在庫から決め直して「作って送る」になる
    fireEvent.change(within(lineGroup).getByRole('combobox', { name: '交換の色・サイズ' }), { target: { value: '102' } });
    expect(within(lineGroup).getByText('在庫: 0')).toBeInTheDocument();
    expect(within(lineGroup).getByRole('combobox', { name: '送り方' })).toHaveValue('make');

    fireEvent.change(within(dialog).getByRole('combobox', { name: '返送の方法' }), { target: { value: 'shop_label' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '返送料の負担' }), { target: { value: 'customer' } });
    fireEvent.change(within(dialog).getByLabelText('返送料（円）'), { target: { value: '1200' } });
    fireEvent.change(within(dialog).getByLabelText('返品の手数料（%）'), { target: { value: '10' } });
    fireEvent.change(within(dialog).getByLabelText('交換の手数料（円）'), { target: { value: '500' } });
    fireEvent.change(within(dialog).getByLabelText('交換の送料（円）'), { target: { value: '300' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '返送の配送業者（任意）' }), { target: { value: 'sagawa' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '返送の伝票番号（任意）' }), { target: { value: ' ZZ-9 ' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' }), { target: { value: ' 交換に変更 ' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様に返品の受付のお知らせを送る' }));

    fireEvent.click(approveButton(dialog));

    await waitFor(() => expect(onApproved).toHaveBeenCalledWith({ notRequired: false }));
    expect(postedBody(APPROVE_URL)).toEqual({
      lines: [{ returnLineId: 'line-blouse', resolution: 'exchange', exchangeVariantId: 102, exchangeMethod: 'make' }],
      returnMethod: 'shop_label',
      returnShippingPayer: 'customer',
      returnCarrier: 'sagawa',
      returnTrackingNumber: 'ZZ-9',
      returnShippingFee: 1200,
      restockingFeePercent: 10,
      exchangeFee: 500,
      exchangeShippingFee: 300,
      shopNote: '交換に変更',
      notifyCustomer: false,
    });
  });

  it('返送料の欄は、お店の送り状・お客様の負担に切り替えた時、設定の返送料から始まる（申し込みの時は 0 円）', async () => {
    const { dialog, onApproved } = await openDialog(undefined, {
      materials: () => jsonResponse({ data: reviewMaterials({ shopLabelFee: 800 }) }),
    });

    fireEvent.change(within(dialog).getByRole('combobox', { name: '返送の方法' }), { target: { value: 'shop_label' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '返送料の負担' }), { target: { value: 'customer' } });
    expect(within(dialog).getByLabelText('返送料（円）')).toHaveValue(800);
    fireEvent.click(approveButton(dialog));

    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
    expect(postedBody(APPROVE_URL)).toMatchObject({ returnMethod: 'shop_label', returnShippingPayer: 'customer', returnShippingFee: 800 });
  });

  it('2つの品は解決を別々に決めて送る（片方を交換に変えても、もう片方の最初の値は変わらない）', async () => {
    const pants = returnLine({
      id: 'line-pants', orderItemId: 'item-pants', itemName: 'ウールパンツ', color: null, size: '2', quantity: 1,
      resolution: 'exchange',
      exchange: { variantId: 202, color: null, size: '3', method: 'stock', stockQuantity: 4, madeToOrderLeadDays: null, outOfStockExchange: 'decline' },
      requestedResolution: 'exchange',
      requestedExchange: { variantId: 202, color: null, size: '3' },
    });
    const base = reviewMaterials();
    const [shipment] = base.shipments;
    const materials = {
      ...base,
      shipments: [
        {
          ...shipment,
          lines: [
            ...shipment.lines,
            { ...shipment.lines[0], orderItemId: 'item-pants', itemId: 12, variantId: 201, itemName: 'ウールパンツ', color: null, size: '2', quantity: 1 },
          ],
        },
      ],
      exchangeOptions: [
        ...base.exchangeOptions,
        {
          itemId: 12,
          variants: [
            { variantId: 201, color: null, size: '2', isActive: true, stockQuantity: 3, madeToOrderLeadDays: null },
            { variantId: 202, color: null, size: '3', isActive: true, stockQuantity: 4, madeToOrderLeadDays: null },
          ],
        },
      ],
    };
    const { dialog, onApproved } = await openDialog(returnDetail({ lines: [returnLine(), pants] }), {
      materials: () => jsonResponse({ data: materials }),
    });
    const blouseGroup = within(dialog).getByRole('group', { name: `${LINE_NAME}の解決` });
    const pantsGroup = within(dialog).getByRole('group', { name: 'ウールパンツ（2）の解決' });
    expect(within(blouseGroup).getByRole('combobox', { name: '解決の方法' })).toHaveValue('refund');
    expect(within(pantsGroup).getByRole('combobox', { name: '解決の方法' })).toHaveValue('exchange');
    expect(within(pantsGroup).getByRole('combobox', { name: '交換の色・サイズ' })).toHaveValue('202');

    fireEvent.change(within(blouseGroup).getByRole('combobox', { name: '解決の方法' }), { target: { value: 'exchange' } });
    fireEvent.click(approveButton(dialog));

    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
    expect(postedBody(APPROVE_URL).lines).toEqual([
      { returnLineId: 'line-blouse', resolution: 'exchange', exchangeVariantId: 101, exchangeMethod: 'stock' },
      { returnLineId: 'line-pants', resolution: 'exchange', exchangeVariantId: 202, exchangeMethod: 'stock' },
    ]);
  });

  it('交換できる色・サイズが1つも無い品は、交換のまま理由を出して「承認する」を押せなくし、返金に変えれば押せる', async () => {
    const detail = returnDetail({
      lines: [
        returnLine({
          resolution: 'exchange',
          exchange: { variantId: 102, color: '白', size: 'L', method: 'make', stockQuantity: 0, madeToOrderLeadDays: 14, outOfStockExchange: 'make' },
          requestedResolution: 'exchange',
          requestedExchange: { variantId: 102, color: '白', size: 'L' },
        }),
      ],
    });
    // 申し込みの後に、同じ商品の色・サイズが全部使えなくなった（稀）
    const base = reviewMaterials();
    const materials = {
      ...base,
      exchangeOptions: [{ itemId: 11, variants: base.exchangeOptions[0].variants.map((variant) => ({ ...variant, isActive: false })) }],
    };
    const { dialog } = await openDialog(detail, { materials: () => jsonResponse({ data: materials }) });
    const lineGroup = within(dialog).getByRole('group', { name: `${LINE_NAME}の解決` });

    expect(within(lineGroup).getByRole('combobox', { name: '解決の方法' })).toHaveValue('exchange');
    expect(within(lineGroup).getByText(NO_EXCHANGE_TARGET)).toBeInTheDocument();
    expect(approveButton(dialog)).toBeDisabled();

    fireEvent.change(within(lineGroup).getByRole('combobox', { name: '解決の方法' }), { target: { value: 'refund' } });
    expect(within(lineGroup).queryByText(NO_EXCHANGE_TARGET)).not.toBeInTheDocument();
    expect(approveButton(dialog)).toBeEnabled();
  });

  it('返送不要で承認すると、負担・配送業者・伝票番号の欄を隠して送らず、親に返送不要を伝える', async () => {
    const { dialog, onApproved } = await openDialog(undefined, {
      materials: () => jsonResponse({ data: reviewMaterials({ noReturnNeededEnabled: true }) }),
    });

    fireEvent.change(within(dialog).getByRole('combobox', { name: '返送の方法' }), { target: { value: 'not_required' } });
    expect(within(dialog).queryByRole('combobox', { name: '返送料の負担' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', { name: '返送の配送業者（任意）' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: '返送の伝票番号（任意）' })).not.toBeInTheDocument();

    fireEvent.click(approveButton(dialog));

    await waitFor(() => expect(onApproved).toHaveBeenCalledWith({ notRequired: true }));
    expect(postedBody(APPROVE_URL)).toMatchObject({ returnMethod: 'not_required', returnCarrier: null, returnTrackingNumber: null });
  });

  it('伝票番号・割合・金額が外れる間は、誤りを出して「承認する」を押せなくする', async () => {
    const { dialog } = await openDialog(undefined, { materials: () => jsonResponse({ data: reviewMaterials({ restockingFeeEnabled: true }) }) });
    expect(approveButton(dialog)).toBeEnabled();

    const tracking = within(dialog).getByRole('textbox', { name: '返送の伝票番号（任意）' });
    fireEvent.change(tracking, { target: { value: '伝票あ' } });
    expect(within(dialog).getByText('伝票番号は英数字とハイフンで入力してください。')).toBeInTheDocument();
    expect(approveButton(dialog)).toBeDisabled();
    fireEvent.change(tracking, { target: { value: 'AB-1' } });
    expect(approveButton(dialog)).toBeEnabled();

    const percent = within(dialog).getByLabelText('返品の手数料（%）');
    fireEvent.change(percent, { target: { value: '101' } });
    expect(within(dialog).getByText('0から100までの整数（半角）で入れてください。')).toBeInTheDocument();
    expect(approveButton(dialog)).toBeDisabled();
    fireEvent.change(percent, { target: { value: '100' } });
    expect(approveButton(dialog)).toBeEnabled();

    fireEvent.change(within(dialog).getByRole('combobox', { name: '返送の方法' }), { target: { value: 'shop_label' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '返送料の負担' }), { target: { value: 'customer' } });
    const shippingFee = within(dialog).getByLabelText('返送料（円）');
    fireEvent.change(shippingFee, { target: { value: '1000001' } });
    expect(within(dialog).getByText('0から1000000までの整数（半角）で入れてください。')).toBeInTheDocument();
    expect(approveButton(dialog)).toBeDisabled();
    fireEvent.change(shippingFee, { target: { value: '1000000' } });
    expect(approveButton(dialog)).toBeEnabled();
  });

  it.each([
    ['返送先が空', () => jsonResponse({ data: reviewMaterials({ returnAddressSet: false }) }), ADDRESS_MISSING],
    ['材料を読み込めない', () => jsonResponse({ error: 'x' }, 500), '返品の材料を読み込めませんでした。'],
  ])('%s: 理由を出して「承認する」を押せなくし、「お断りする」は押せる', async (_name, materials, message) => {
    const { dialog } = await openDialog(undefined, { materials });

    expect(within(dialog).getByText(message)).toBeInTheDocument();
    expect(approveButton(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'お断りする' })).toBeEnabled();
    expect(within(dialog).getByRole('group', { name: LINE_NAME })).toBeInTheDocument();
  });

  it('Enter キーでは承認を送らない。メモの欄の Enter は改行のまま', async () => {
    const { dialog } = await openDialog();

    expect(fireEvent.keyDown(within(dialog).getByRole('textbox', { name: '返送の伝票番号（任意）' }), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' }), { key: 'Enter' })).toBe(true);
    expect(postedBodies(APPROVE_URL)).toHaveLength(0);
  });
});

describe('OrderReturnReviewDialog のお断り', () => {
  it('「お断りする」でお断りの画面を開く。理由を選んでメッセージを入れるまで、送れない', async () => {
    const { decline } = await openDecline();

    expect(screen.queryByRole('dialog', { name: TITLE })).not.toBeInTheDocument();
    expect(within(reasonSelect(decline)).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '選んでください',
      '期間切れ',
      '返品不可',
      'その他',
    ]);
    expect(messageBox(decline)).toHaveValue('');
    expect(declineButton(decline)).toBeDisabled();
    expect(within(decline).getByRole('button', { name: '戻る' })).toBeEnabled();

    // 理由「その他」の最初の文は空なので、メッセージを入れるまで押せない
    fireEvent.change(reasonSelect(decline), { target: { value: 'other' } });
    expect(declineButton(decline)).toBeDisabled();
    fireEvent.change(messageBox(decline), { target: { value: 'ご案内したとおりです。' } });
    expect(declineButton(decline)).toBeEnabled();
  });

  it('理由を選ぶと、その理由の最初の文（C-5）がメッセージに入る。直していなければ、選び直した理由の文に替わる', async () => {
    const { decline } = await openDecline();

    fireEvent.change(reasonSelect(decline), { target: { value: 'window_passed' } });
    expect(messageBox(decline)).toHaveValue('受付の期限を過ぎているため、今回のお申し込みはお受けできませんでした。');
    expect(declineButton(decline)).toBeEnabled();

    fireEvent.change(reasonSelect(decline), { target: { value: 'final_sale' } });
    expect(messageBox(decline)).toHaveValue('この商品は返品不可の商品のため、お客様のご都合による返品・交換はお受けできませんでした。');

    // 「その他」の最初の文は空
    fireEvent.change(reasonSelect(decline), { target: { value: 'other' } });
    expect(messageBox(decline)).toHaveValue('');
  });

  it('直した文は、理由を選び直しても残る。メッセージが空白だけなら、選んだ理由の最初の文が入る（P8）', async () => {
    const { decline } = await openDecline();
    fireEvent.change(reasonSelect(decline), { target: { value: 'window_passed' } });
    const edited = `${RETURN_DECLINE_MESSAGE_PREFILL.window_passed}\n返品の期限は到着後7日です。`;
    fireEvent.change(messageBox(decline), { target: { value: edited } });

    fireEvent.change(reasonSelect(decline), { target: { value: 'final_sale' } });
    expect(reasonSelect(decline)).toHaveValue('final_sale');
    expect(messageBox(decline)).toHaveValue(edited);

    // 「選んでください」に戻すと、理由が無いので送れないが、書いたメッセージは残る
    fireEvent.change(reasonSelect(decline), { target: { value: '' } });
    expect(reasonSelect(decline)).toHaveValue('');
    expect(messageBox(decline)).toHaveValue(edited);
    expect(declineButton(decline)).toBeDisabled();

    // 空白だけにすると、理由を選んだ時に最初の文が入る
    fireEvent.change(messageBox(decline), { target: { value: '　 ' } });
    fireEvent.change(reasonSelect(decline), { target: { value: 'window_passed' } });
    expect(messageBox(decline)).toHaveValue(RETURN_DECLINE_MESSAGE_PREFILL.window_passed);
  });

  it('確かめの文は最初から出ている。「お断りする」を1回押すと、理由とメッセージを窓口へ送って、親に伝える', async () => {
    const { decline, onDone, onApproved } = await openDecline();
    expect(within(decline).getByText('お客様にメッセージが届きます。取り消せません。')).toBeInTheDocument();
    fireEvent.change(reasonSelect(decline), { target: { value: 'other' } });
    fireEvent.change(messageBox(decline), { target: { value: ' 在庫の都合でお受けできません。 ' } });
    expect(postedBodies(DECLINE_URL)).toHaveLength(0);

    fireEvent.click(declineButton(decline));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('お断りしました。'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onApproved).not.toHaveBeenCalled();
    expect(postedBody(DECLINE_URL)).toEqual({ declineReason: 'other', declineMessage: '在庫の都合でお受けできません。' });
  });

  it('「戻る」で確かめる画面へ戻る。確かめる画面の入力もお断りの入力も残り、何も送らない', async () => {
    const { dialog } = await openDialog();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' }), { target: { value: '先に電話する' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'お断りする' }));
    const decline = await screen.findByRole('dialog', { name: DECLINE_TITLE });
    fireEvent.change(reasonSelect(decline), { target: { value: 'final_sale' } });

    fireEvent.click(within(decline).getByRole('button', { name: '戻る' }));

    const review = await screen.findByRole('dialog', { name: TITLE });
    expect(within(review).getByRole('textbox', { name: 'メモ（お客様には見えません）' })).toHaveValue('先に電話する');
    expect(postedBodies(DECLINE_URL)).toHaveLength(0);
    fireEvent.click(within(review).getByRole('button', { name: 'お断りする' }));
    const again = await screen.findByRole('dialog', { name: DECLINE_TITLE });
    expect(reasonSelect(again)).toHaveValue('final_sale');
    expect(messageBox(again)).toHaveValue(RETURN_DECLINE_MESSAGE_PREFILL.final_sale);
  });

  it('メッセージが空白だけの間と、1000字を超える間は送れない', async () => {
    const { decline } = await openDecline();
    fireEvent.change(reasonSelect(decline), { target: { value: 'other' } });

    fireEvent.change(messageBox(decline), { target: { value: '　 \n ' } });
    expect(declineButton(decline)).toBeDisabled();
    fireEvent.change(messageBox(decline), { target: { value: 'あ'.repeat(1000) } });
    expect(declineButton(decline)).toBeEnabled();
    fireEvent.change(messageBox(decline), { target: { value: 'あ'.repeat(1001) } });
    expect(declineButton(decline)).toBeDisabled();
  });
});

describe('OrderReturnReviewDialog の断りと、答えが分からない時', () => {
  it('承認が「状態に合わない」で断られたら、断りの文を出して返品を読み直し、受付中でなくなっていれば「閉じる」だけにする', async () => {
    let current = returnDetail();
    const { dialog, onApproved, onUncertain, onClose } = await openDialog(current, {
      returns: () => returnsAnswer(current),
      approve: () => {
        current = returnDetail({ status: 'open', displayStatus: 'in_progress', marks: ['awaiting_items'], approvedAt: '2026-10-13T05:30:00.000Z' });
        return jsonResponse({ error: STATE_CONFLICT, code: 'RETURN_STATE_CONFLICT' }, 409);
      },
    });

    fireEvent.click(approveButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(STATE_CONFLICT);
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: '承認する' })).not.toBeInTheDocument());
    expect(within(dialog).queryByRole('button', { name: 'お断りする' })).not.toBeInTheDocument();
    expect(within(dialog).queryByText('承認する時の内容')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: LINE_NAME })).toBeInTheDocument();
    expect(mockClientFetch.mock.calls.filter(([url]) => url === RETURNS_URL)).toHaveLength(2);
    expect(onApproved).not.toHaveBeenCalled();

    // 送信を試みた後に閉じる時は、親に一覧の読み直しを頼んでから閉じる
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('お断りが「状態に合わない」で断られた時も、確かめる画面に戻って返品を読み直し、「閉じる」だけにする', async () => {
    let current = returnDetail();
    const { decline, onDone } = await openDecline(current, {
      returns: () => returnsAnswer(current),
      decline: () => {
        current = returnDetail({
          status: 'declined', displayStatus: null, declinedAt: '2026-10-13T05:30:00.000Z',
          declineReason: 'other', declineMessage: '別の担当がお断りしました。',
        });
        return jsonResponse({ error: STATE_CONFLICT, code: 'RETURN_STATE_CONFLICT' }, 409);
      },
    });
    fireEvent.change(reasonSelect(decline), { target: { value: 'other' } });
    fireEvent.change(messageBox(decline), { target: { value: 'お受けできません。' } });
    fireEvent.click(declineButton(decline));

    expect(await screen.findByRole('alert')).toHaveTextContent(STATE_CONFLICT);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'お断りする' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: TITLE })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '閉じる' })).toBeEnabled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('承認の答えが分からない時は、入力を止めて「閉じる」「もう一度確かめる」だけにし、同じ中身で送り直す', async () => {
    const answers = [() => jsonResponse({ error: 'x' }, 500), () => jsonResponse({ data: { returnStatus: 'open' } })];
    let call = 0;
    const { dialog, onApproved } = await openDialog(undefined, { approve: () => answers[call++]() });

    fireEvent.click(approveButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_MESSAGE);
    expect(buttonNames(dialog)).toEqual(['閉じる', 'もう一度確かめる']);
    expect(within(dialog).getByRole('combobox', { name: '返送の方法' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
    const bodies = postedBodies(APPROVE_URL);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('お断りの答えが分からない時も、同じ中身で送り直せる', async () => {
    const answers = [() => jsonResponse({ error: 'x' }, 502), () => jsonResponse({ data: { returnStatus: 'declined' } })];
    let call = 0;
    const { decline, onDone } = await openDecline(undefined, { decline: () => answers[call++]() });
    fireEvent.change(reasonSelect(decline), { target: { value: 'final_sale' } });
    fireEvent.click(declineButton(decline));

    expect(await within(decline).findByRole('alert')).toHaveTextContent(UNKNOWN_MESSAGE);
    expect(buttonNames(decline)).toEqual(['閉じる', 'もう一度確かめる']);

    fireEvent.click(within(decline).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('お断りしました。'));
    const bodies = postedBodies(DECLINE_URL);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('処理の前の断り（403）は、断りの文を出して入力を残す。閉じる時は親に読み直しを頼む', async () => {
    const { dialog, onApproved, onUncertain, onClose } = await openDialog(undefined, {
      approve: () => jsonResponse({ error: 'Forbidden' }, 403),
    });

    fireEvent.click(approveButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('この操作の権限がありません。');
    expect(approveButton(dialog)).toBeEnabled();
    expect(onApproved).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('受付中でない返品を開いた時は、中身だけを出して「閉じる」だけにする', async () => {
    const { dialog, onClose, onUncertain } = await openDialog(returnDetail({ status: 'open', displayStatus: 'in_progress', marks: ['awaiting_items'] }));

    expect(within(dialog).getByRole('group', { name: LINE_NAME })).toBeInTheDocument();
    expect(within(dialog).queryByText('承認する時の内容')).not.toBeInTheDocument();
    expect(buttonNames(dialog)).toEqual(['閉じる']);

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // 何も送っていないので、親に読み直しは頼まない
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it('返品を読めない時は、理由と「閉じる」だけを出す', async () => {
    mockClientFetch.mockImplementation(async () => jsonResponse({ error: '返品が見つかりません。', code: 'RETURN_NOT_FOUND' }, 404));
    const onClose = jest.fn();
    render(<OrderReturnReviewDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={onClose} onDone={jest.fn()} onApproved={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '返品の申し込みを確かめる' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返品が見つかりません。');
    expect(buttonNames(dialog)).toEqual(['閉じる']);

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
