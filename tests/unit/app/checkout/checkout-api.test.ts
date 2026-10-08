const mockClientFetch = jest.fn();
const mockRefreshSessionOnce = jest.fn();
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
  refreshSessionOnce: (...args: unknown[]) => mockRefreshSessionOnce(...args),
}));

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
      code: 'out_of_stock',
      retryable: false,
      correlationId: null,
    });
    await expect(call()).resolves.toEqual({ kind: 'error', code: 'checkout_session_failed', message: '一時的に…', retryable: true, correlationId: 'c-1' });
    await expect(call()).resolves.toEqual({
      kind: 'error',
      message: '決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。',
      code: 'Cart is empty',
      retryable: true,
      correlationId: null,
    });
  });

  test('買えなくなった明細をサーバーが外した断り（409 cart_updated）は、サーバーの文のまま、やり直せるエラーで渡す', async () => {
    const message = '次の商品はお求めいただけなくなったため、カートから外しました: シャツ（BLACK / M）。内容をご確認のうえ、もう一度「確認へ進む」を押してください。';
    mockClientFetch.mockResolvedValueOnce(jsonResponse(409, { error: 'cart_updated', retryable: true, message }));

    await expect(
      requestCheckoutConfirmation({ shipping: SHIPPING, displayedAmounts: AMOUNTS, promotionCode: null }),
    ).resolves.toEqual({ kind: 'error', code: 'cart_updated', message, retryable: true, correlationId: null });
  });

  test('通信が失敗しても reject せず、やり直せるエラーの値で返す', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(
      requestCheckoutConfirmation({ shipping: SHIPPING, displayedAmounts: AMOUNTS, promotionCode: null }),
    ).resolves.toEqual({
      kind: 'error',
      message: '決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。',
      code: null,
      retryable: true,
      correlationId: null,
    });
  });

  test('使えないログインのメールは、サーバーの案内と押し直せない結果を画面へ渡す', async () => {
    const message = 'ログイン中のメールアドレスを確かめられませんでした。ログインし直してから、もう一度お試しください。';
    mockClientFetch.mockResolvedValueOnce(jsonResponse(400, {
      error: 'invalid_member_email', message, retryable: false,
    }));

    await expect(requestCheckoutConfirmation({
      shipping: SHIPPING, displayedAmounts: AMOUNTS, promotionCode: null,
    })).resolves.toEqual({
      kind: 'error', code: 'invalid_member_email', message, retryable: false, correlationId: null,
    });
  });
});

test('金額不一致のエラー記号を画面へ渡す', async () => {
  mockClientFetch.mockResolvedValue(jsonResponse(409, { error: 'checkout_amount_mismatch' }));
  await expect(requestCheckoutConfirmation({ shipping: SHIPPING, displayedAmounts: AMOUNTS, promotionCode: null }))
    .resolves.toMatchObject({ kind: 'error', code: 'checkout_amount_mismatch', retryable: true });
});

describe('resumeCheckout', () => {
  beforeEach(() => mockClientFetch.mockReset());

  test.each([[400, 'session_not_found'], [403, 'forbidden']])('ID を送った %s %s は unavailable', async (status, error) => {
    mockClientFetch.mockResolvedValue(jsonResponse(status as number, { error }));
    await expect(resumeCheckout('cs_other')).resolves.toEqual({ state: 'unavailable' });
  });

  test.each([
    [null, 400, 'session_not_found'], [null, 403, 'forbidden'],
    ['cs_other', 400, 'invalid_request'], ['cs_other', 403, 'other'],
    ['cs_other', 500, 'session_not_found'], ['cs_other', 429, 'forbidden'],
  ])('ID が無いか別の失敗なら none（%s %s %s）', async (id, status, error) => {
    mockClientFetch.mockResolvedValue(jsonResponse(status as number, { error }));
    await expect(resumeCheckout(id as string | null)).resolves.toEqual({ state: 'none' });
  });

  test('通信の失敗も none', async () => {
    mockClientFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(resumeCheckout('cs_other')).resolves.toEqual({ state: 'none' });
  });

  test('決済の画面の ID は有るときだけ送り、応答を状態に分ける。失敗は入力画面から（none）', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(200, { state: 'none' }))
      .mockResolvedValueOnce(jsonResponse(200, { state: 'payment_done', checkoutSessionId: 'cs_paid' }))
      .mockResolvedValueOnce(jsonResponse(200, { state: 'resume', confirmation: CONFIRMATION }))
      .mockResolvedValueOnce(jsonResponse(403, { error: 'forbidden' }));

    await expect(resumeCheckout(null)).resolves.toEqual({ state: 'none' });
    await expect(resumeCheckout('cs_paid')).resolves.toEqual({ state: 'payment_done', checkoutSessionId: 'cs_paid' });
    await expect(resumeCheckout('cs_test_1')).resolves.toEqual({ state: 'resume', confirmation: CONFIRMATION });
    await expect(resumeCheckout('cs_other')).resolves.toEqual({ state: 'unavailable' });
    expect(JSON.parse(mockClientFetch.mock.calls[0][1].body)).toEqual({});
    expect(JSON.parse(mockClientFetch.mock.calls[1][1].body)).toEqual({ checkoutSessionId: 'cs_paid' });
  });
});

describe('placeOrder', () => {
  beforeEach(() => mockClientFetch.mockReset());

  test('支払い済みの別の画面の ID を返す。ID が無い古い応答も読める', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(409, { error: 'payment_done', checkoutSessionId: 'cs_paid' }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'payment_done' }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'cart_changed', message: 'カートが変わりました' }));
    const call = () => placeOrder({ checkoutSessionId: 'cs_test_1', inStockVariantIds: [] });
    await expect(call()).resolves.toEqual({ kind: 'payment_done', checkoutSessionId: 'cs_paid' });
    await expect(call()).resolves.toEqual({ kind: 'payment_done' });
    await expect(call()).resolves.toEqual({
      kind: 'rejected', rejection: { code: 'cart_changed', message: 'カートが変わりました', changedLines: [] },
    });
  });

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
    await expect(call()).resolves.toEqual({ kind: 'payment_done', checkoutSessionId: 'cs_test_1' });
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

  test('完了の応答に状態が無いときは、入金済みにせず unknown を返す', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(200, { orderId: 'order-1' })) as unknown as typeof fetch;

    await expect(completeCheckout('cs_test_1')).resolves.toEqual({
      kind: 'completed',
      orderId: 'order-1',
      orderStatus: 'unknown',
    });
  });
});

describe('checkPromotionCodeRequest', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
    mockRefreshSessionOnce.mockReset();
  });

  test('適用できれば金額の目安を、できなければ理由を返す', async () => {
    const preview = { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 };
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(200, preview))
      .mockResolvedValueOnce(jsonResponse(422, { error: 'promotion_code_invalid', message: 'このコードは使えません' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(checkPromotionCodeRequest('welcome10')).resolves.toEqual({ kind: 'applied', preview });
    await expect(checkPromotionCodeRequest('nope')).resolves.toEqual({ kind: 'rejected', message: 'このコードは使えません', transient: false });
    await expect(checkPromotionCodeRequest('x')).resolves.toEqual({
      kind: 'rejected',
      message: '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。',
      transient: true,
    });
    expect(JSON.parse(mockClientFetch.mock.calls[0][1].body)).toEqual({ code: 'welcome10' });
  });

  test.each([400, 403, 429, 500, 503, 200, 422])('理由つき422以外の失敗（HTTP %s）は一時的な失敗を返す', async (status) => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(status, { error: 'failed' }));

    await expect(checkPromotionCodeRequest('WELCOME10')).resolves.toEqual({
      kind: 'rejected',
      message: '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。',
      transient: true,
    });
  });

  test.each([429, 500, 503])('HTTP %sは文があっても一時的な失敗を返す', async (status) => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(status, { message: 'しばらくしてからお試しください' }));

    await expect(checkPromotionCodeRequest('WELCOME10')).resolves.toEqual({
      kind: 'rejected', message: 'しばらくしてからお試しください', transient: true,
    });
  });
});

const LOGIN_EXPIRED_MESSAGE = 'ログインの有効期限が切れました。ログインし直すか、そのままもう一度「確認へ進む」を押してください。';
const LOGIN_CHANGED_MESSAGE = 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。';
const PROCEED_FAILED_MESSAGE = '決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。';
const PLACE_ORDER_FAILED_MESSAGE = 'ご注文を受け付けられませんでした。少し時間をおいてから、もう一度お試しください。';
const PROMOTION_LOGIN_EXPIRED_MESSAGE = 'ログインの有効期限が切れました。ログインし直してから、もう一度「適用」を押してください。';
const PROMOTION_FAILED_MESSAGE = '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。';
const PROMOTION_PREVIEW = { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 };

// ログインの印が古いと断られた時（401 auth_expired）に印を新しくして送り直す4つの入口（割引コードの「適用」を含む）。
// 印の更新の結果は3つ: refreshed は1回だけ送り直す。expired（更新の入口が 401）と unavailable（回数の制限・通信の失敗・待ち時間中）は
// 送り直さず、入口ごとの結果を返す。送り直しの通信が失敗した時の結果（failed）も入口ごとに違う
const RESEND_ENTRIES = [
  {
    name: 'requestCheckoutConfirmation（create-session）',
    url: '/api/checkout/create-session',
    call: () => requestCheckoutConfirmation({ shipping: SHIPPING, displayedAmounts: AMOUNTS, promotionCode: null }),
    success: jsonResponse(200, { confirmation: CONFIRMATION }),
    succeeded: { kind: 'confirmation', confirmation: CONFIRMATION },
    expired: { kind: 'error', code: 'auth_expired', message: LOGIN_EXPIRED_MESSAGE, retryable: true, correlationId: null },
    unavailable: { kind: 'error', code: 'auth_unavailable', message: PROCEED_FAILED_MESSAGE, retryable: true, correlationId: null },
    failed: {
      kind: 'error',
      code: null,
      message: PROCEED_FAILED_MESSAGE,
      retryable: true,
      correlationId: null,
    },
  },
  {
    name: 'placeOrder（place-order）',
    url: '/api/checkout/place-order',
    call: () => placeOrder({ checkoutSessionId: 'cs_test_1', inStockVariantIds: [11] }),
    success: jsonResponse(200, { orderId: 'order-1', orderStatus: 'payment_in_progress' }),
    succeeded: { kind: 'accepted', orderId: 'order-1' },
    expired: { kind: 'rejected', rejection: { code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, changedLines: [] } },
    unavailable: { kind: 'error', message: PLACE_ORDER_FAILED_MESSAGE },
    failed: { kind: 'error', message: PLACE_ORDER_FAILED_MESSAGE },
  },
  {
    name: 'resumeCheckout（resume）',
    url: '/api/checkout/resume',
    call: () => resumeCheckout('cs_test_1'),
    success: jsonResponse(200, { state: 'resume', confirmation: CONFIRMATION }),
    succeeded: { state: 'resume', confirmation: CONFIRMATION },
    expired: { state: 'none' },
    unavailable: { state: 'none' },
    failed: { state: 'none' },
  },
  {
    name: 'checkPromotionCodeRequest（promotion-code）',
    url: '/api/checkout/promotion-code',
    call: () => checkPromotionCodeRequest('WELCOME10'),
    success: jsonResponse(200, PROMOTION_PREVIEW),
    succeeded: { kind: 'applied', preview: PROMOTION_PREVIEW },
    // 「適用」は押し直せる。コードが使えないと確定したわけではないので、どちらも一時的な失敗（transient）にして、記憶しているコードを消さない
    expired: { kind: 'rejected', message: PROMOTION_LOGIN_EXPIRED_MESSAGE, transient: true },
    unavailable: { kind: 'rejected', message: PROMOTION_FAILED_MESSAGE, transient: true },
    failed: { kind: 'rejected', message: PROMOTION_FAILED_MESSAGE, transient: true },
  },
];

describe.each(RESEND_ENTRIES)('ログインの印が古いと断られた時の送り直し: $name', ({ url, call, success, succeeded, expired, unavailable, failed }) => {
  beforeEach(() => {
    mockClientFetch.mockReset();
    mockRefreshSessionOnce.mockReset();
  });

  test('印を新しくして（refreshed）、同じ要求を1回だけ送り直し、2回目の応答で結果を返す', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(401, { error: 'auth_expired' }))
      .mockResolvedValueOnce(success);
    mockRefreshSessionOnce.mockResolvedValue('refreshed');

    await expect(call()).resolves.toEqual(succeeded);

    expect(mockRefreshSessionOnce).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(mockClientFetch.mock.calls[0][0]).toBe(url);
    expect(mockClientFetch.mock.calls[1]).toEqual(mockClientFetch.mock.calls[0]);
  });

  test.each([
    ['401 でも error が auth_expired ではない', 401, { error: 'unauthorized' }],
    ['401 で本文が読めない', 401, null],
    ['auth_expired でも 401 ではない', 403, { error: 'auth_expired' }],
  ])('送り直さない（%s）', async (_label, status, body) => {
    mockClientFetch.mockResolvedValue(jsonResponse(status, body));

    await call();

    expect(mockRefreshSessionOnce).not.toHaveBeenCalled();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  test('印が失効していたら（expired）送り直さず、印が古い時の結果を返す', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(401, { error: 'auth_expired' }));
    mockRefreshSessionOnce.mockResolvedValue('expired');

    await expect(call()).resolves.toEqual(expired);

    expect(mockRefreshSessionOnce).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  test('印の更新が一時的にできなければ（unavailable）送り直さず、一時的な失敗の結果を返す', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(401, { error: 'auth_expired' }));
    mockRefreshSessionOnce.mockResolvedValue('unavailable');

    await expect(call()).resolves.toEqual(unavailable);

    expect(mockRefreshSessionOnce).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  test('送り直しでもまた 401 auth_expired なら、もう送り直さず、失効した時と同じ結果を返す', async () => {
    mockClientFetch.mockResolvedValue(jsonResponse(401, { error: 'auth_expired' }));
    mockRefreshSessionOnce.mockResolvedValue('refreshed');

    await expect(call()).resolves.toEqual(expired);

    expect(mockRefreshSessionOnce).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
  });

  test('送り直しの通信が失敗したら、今までの通信の失敗と同じ扱いにする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(jsonResponse(401, { error: 'auth_expired' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mockRefreshSessionOnce.mockResolvedValue('refreshed');

    await expect(call()).resolves.toEqual(failed);
  });
});

describe('ログインの状態が変わったと断られた時（409 login_changed）', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
    mockRefreshSessionOnce.mockReset();
  });

  test('place-order の 409 login_changed は、サーバーの文を持つ断り（login_changed）として返す。送り直さない', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(409, { error: 'login_changed', message: LOGIN_CHANGED_MESSAGE }));

    await expect(placeOrder({ checkoutSessionId: 'cs_test_1', inStockVariantIds: [11] })).resolves.toEqual({
      kind: 'rejected',
      rejection: { code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, changedLines: [] },
    });

    expect(mockRefreshSessionOnce).not.toHaveBeenCalled();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  test('place-order の 409 login_changed に message が無ければ、ログインの状態が変わった時の文を持つ断りとして返す', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(409, { error: 'login_changed' }));

    await expect(placeOrder({ checkoutSessionId: 'cs_test_1', inStockVariantIds: [11] })).resolves.toEqual({
      kind: 'rejected',
      rejection: { code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, changedLines: [] },
    });

    expect(mockRefreshSessionOnce).not.toHaveBeenCalled();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  test('place-order の login_changed 以外の断りは message が無ければ、これまでどおり受け付けられなかった時の失敗にする', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(409, { error: 'stock_changed' }));

    await expect(placeOrder({ checkoutSessionId: 'cs_test_1', inStockVariantIds: [11] })).resolves.toEqual({
      kind: 'error',
      message: PLACE_ORDER_FAILED_MESSAGE,
    });
  });

  test('create-session の 409 login_changed は、サーバーの文を持つ一般のエラー（code login_changed・やり直せる）で返す。送り直さない', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(409, { error: 'login_changed', message: LOGIN_CHANGED_MESSAGE }));

    await expect(
      requestCheckoutConfirmation({ shipping: SHIPPING, displayedAmounts: AMOUNTS, promotionCode: null }),
    ).resolves.toEqual({
      kind: 'error',
      code: 'login_changed',
      message: LOGIN_CHANGED_MESSAGE,
      retryable: true,
      correlationId: null,
    });

    expect(mockRefreshSessionOnce).not.toHaveBeenCalled();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });
});

// ログインはカートの印（session_id の Cookie）を新しい値に替える（セッション固定への守り）。そのため「確認へ進む」の後に
// ログインして「注文する」を押すと、サーバーは買い手を比べる前に「決済の画面がこのカートのものでない」と 403 forbidden で断る
// （設計書 4-3）。お客様には、買い手の比べで断られた時（409 login_changed）と同じ案内を出して入力画面へ戻す
describe('「注文する」が決済の画面はこのカートのものでないと断られた時（403 forbidden）', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
    mockRefreshSessionOnce.mockReset();
  });

  test('403 forbidden は、ログインの状態が変わった時の文を持つ断り（login_changed）として返す。送り直さない', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(403, { error: 'forbidden' }));

    await expect(placeOrder({ checkoutSessionId: 'cs_test_1', inStockVariantIds: [11] })).resolves.toEqual({
      kind: 'rejected',
      rejection: { code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, changedLines: [] },
    });

    expect(mockRefreshSessionOnce).not.toHaveBeenCalled();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(mockClientFetch.mock.calls[0][0]).toBe('/api/checkout/place-order');
  });

  test('403 forbidden の本文に文があっても、案内はログインの状態が変わった時の文に決まっている', async () => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(403, { error: 'forbidden', message: '別の文' }));

    await expect(placeOrder({ checkoutSessionId: 'cs_test_1', inStockVariantIds: [11] })).resolves.toEqual({
      kind: 'rejected',
      rejection: { code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, changedLines: [] },
    });
  });

  // CSRF の守りの 403（error は大文字始まりの Forbidden）など、ほかの 403 と、403 以外の forbidden は読み替えない
  test.each([
    ['CSRF の守りの 403', 403, { error: 'Forbidden', reason: 'CSRF validation failed' }],
    ['error が別の 403', 403, { error: 'other' }],
    ['本文が読めない 403', 403, null],
    ['409 の forbidden', 409, { error: 'forbidden' }],
    ['500 の forbidden', 500, { error: 'forbidden' }],
  ])('%s は読み替えず、受け付けられなかった時の失敗にする', async (_label, status, body) => {
    mockClientFetch.mockResolvedValueOnce(jsonResponse(status, body));

    await expect(placeOrder({ checkoutSessionId: 'cs_test_1', inStockVariantIds: [11] })).resolves.toEqual({
      kind: 'error',
      message: PLACE_ORDER_FAILED_MESSAGE,
    });
  });
});
