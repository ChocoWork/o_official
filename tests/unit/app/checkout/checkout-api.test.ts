const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import {
  checkPromotionCodeRequest,
  completeCheckout,
  placeOrder,
  requestCheckoutConfirmation,
  resumeCheckout,
} from '@/app/checkout/_lib/checkout-api';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const SHIPPING = {
  email: 'a@example.com',
  fullName: '山田 花子',
  kanaName: 'ヤマダ ハナコ',
  postalCode: '150-0001',
  prefecture: '東京都',
  city: '渋谷区',
  address: '神宮前1-1-1',
  building: '',
  phone: '03-1111-2222',
};
const AMOUNTS = { subtotalAmount: 5000, taxAmount: 0, shippingAmount: 0, totalAmount: 5000 };
const CONFIRMATION = { checkoutSessionId: 'cs_test_1', clientSecret: 's', shipping: {}, lines: [], promotionCode: null };

describe('requestCheckoutConfirmation', () => {
  beforeEach(() => mockClientFetch.mockReset());

  test('custom で送り、割引コードは有るときだけ送る', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse(200, { confirmation: CONFIRMATION }));

    await requestCheckoutConfirmation({ shipping: SHIPPING, displayedAmounts: AMOUNTS, promotionCode: null });
    await requestCheckoutConfirmation({ shipping: SHIPPING, displayedAmounts: AMOUNTS, promotionCode: 'WELCOME10' });

    const bodies = mockClientFetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(mockClientFetch.mock.calls[0][0]).toBe('/api/checkout/create-session');
    expect(bodies[0]).toEqual({ uiMode: 'custom', shipping: SHIPPING, displayedAmounts: AMOUNTS });
    expect(bodies[1]).toEqual({ uiMode: 'custom', shipping: SHIPPING, displayedAmounts: AMOUNTS, promotionCode: 'WELCOME10' });
  });

  test('応答を画面で使う形に分ける', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(200, { confirmation: CONFIRMATION }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'order_already_placed', checkoutSessionId: 'cs_paid' }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'promotion_code_invalid', message: 'このコードは使えません' }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'out_of_stock', message: '以下の商品は現在購入できません: A' }))
      .mockResolvedValueOnce(jsonResponse(503, { error: 'checkout_session_failed', message: '一時的に…', correlationId: 'c-1', retryable: true }))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'Cart is empty' }));
    const call = () => requestCheckoutConfirmation({ shipping: SHIPPING, displayedAmounts: AMOUNTS, promotionCode: null });

    await expect(call()).resolves.toEqual({ kind: 'confirmation', confirmation: CONFIRMATION });
    await expect(call()).resolves.toEqual({ kind: 'order_already_placed', checkoutSessionId: 'cs_paid' });
    await expect(call()).resolves.toEqual({ kind: 'promotion_code_invalid', message: 'このコードは使えません' });
    await expect(call()).resolves.toEqual({
      kind: 'error',
      message: '以下の商品は現在購入できません: A',
      retryable: false,
      correlationId: null,
    });
    await expect(call()).resolves.toEqual({ kind: 'error', message: '一時的に…', retryable: true, correlationId: 'c-1' });
    await expect(call()).resolves.toEqual({
      kind: 'error',
      message: '決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。',
      retryable: true,
      correlationId: null,
    });
  });
});

describe('resumeCheckout', () => {
  beforeEach(() => mockClientFetch.mockReset());

  test('決済の画面の ID は有るときだけ送り、応答を状態に分ける。失敗は入力画面から（none）', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(200, { state: 'none' }))
      .mockResolvedValueOnce(jsonResponse(200, { state: 'payment_done', checkoutSessionId: 'cs_paid' }))
      .mockResolvedValueOnce(jsonResponse(200, { state: 'resume', confirmation: CONFIRMATION }))
      .mockResolvedValueOnce(jsonResponse(403, { error: 'forbidden' }));

    await expect(resumeCheckout(null)).resolves.toEqual({ state: 'none' });
    await expect(resumeCheckout('cs_paid')).resolves.toEqual({ state: 'payment_done', checkoutSessionId: 'cs_paid' });
    await expect(resumeCheckout('cs_test_1')).resolves.toEqual({ state: 'resume', confirmation: CONFIRMATION });
    await expect(resumeCheckout('cs_other')).resolves.toEqual({ state: 'none' });
    expect(JSON.parse(mockClientFetch.mock.calls[0][1].body)).toEqual({});
    expect(JSON.parse(mockClientFetch.mock.calls[1][1].body)).toEqual({ checkoutSessionId: 'cs_paid' });
  });
});

describe('placeOrder', () => {
  beforeEach(() => mockClientFetch.mockReset());

  test('受け付け・支払い済み・断り・失敗に分ける', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(200, { orderId: 'order-1', orderStatus: 'payment_in_progress' }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'payment_done', checkoutSessionId: 'cs_test_1' }))
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: 'stock_changed',
          message: '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）',
          changedLines: [{ itemId: 2, name: 'パンツ', color: 'NAVY', size: 'L' }, { bad: true }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(500, { error: 'place_order_failed', message: 'ご注文を受け付けられませんでした。' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const call = () => placeOrder({ checkoutSessionId: 'cs_test_1', inStockVariantIds: [11] });

    await expect(call()).resolves.toEqual({ kind: 'accepted', orderId: 'order-1' });
    await expect(call()).resolves.toEqual({ kind: 'payment_done' });
    await expect(call()).resolves.toEqual({
      kind: 'rejected',
      rejection: {
        code: 'stock_changed',
        message: '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）',
        changedLines: [{ itemId: 2, name: 'パンツ', color: 'NAVY', size: 'L' }],
      },
    });
    await expect(call()).resolves.toEqual({ kind: 'error', message: 'ご注文を受け付けられませんでした。' });
    await expect(call()).resolves.toEqual({
      kind: 'error',
      message: 'ご注文を受け付けられませんでした。少し時間をおいてから、もう一度お試しください。',
    });
    expect(JSON.parse(mockClientFetch.mock.calls[0][1].body)).toEqual({
      checkoutSessionId: 'cs_test_1',
      inStockVariantIds: [11],
    });
  });
});

describe('completeCheckout', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('注文の確定を送り、注文と状態を返す。失敗は案内を返す', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { orderId: 'order-1', status: 'paid', paymentMethod: 'stripe_card' }))
      .mockResolvedValueOnce(jsonResponse(503, { error: 'Temporarily unavailable' }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(completeCheckout('cs_test_1')).resolves.toEqual({ kind: 'completed', orderId: 'order-1', orderStatus: 'paid' });
    await expect(completeCheckout('cs_test_1')).resolves.toEqual({
      kind: 'error',
      message: '注文確定に失敗しました。時間をおいて再度お試しください。',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/checkout/complete', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ checkoutSessionId: 'cs_test_1' });
  });
});

describe('checkPromotionCodeRequest', () => {
  beforeEach(() => mockClientFetch.mockReset());

  test('適用できれば金額の目安を、できなければ理由を返す', async () => {
    const preview = { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 };
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(200, preview))
      .mockResolvedValueOnce(jsonResponse(422, { error: 'promotion_code_invalid', message: 'このコードは使えません' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(checkPromotionCodeRequest('welcome10')).resolves.toEqual({ kind: 'applied', preview });
    await expect(checkPromotionCodeRequest('nope')).resolves.toEqual({ kind: 'rejected', message: 'このコードは使えません' });
    await expect(checkPromotionCodeRequest('x')).resolves.toEqual({
      kind: 'rejected',
      message: '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。',
    });
    expect(JSON.parse(mockClientFetch.mock.calls[0][1].body)).toEqual({ code: 'welcome10' });
  });
});
