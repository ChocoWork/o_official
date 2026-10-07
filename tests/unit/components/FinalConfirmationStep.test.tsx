import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next/link', () => {
  return ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});
jest.mock('next/image', () => {
  return ({ src, alt }: any) => React.createElement('img', { src, alt });
});
jest.mock('@stripe/stripe-js', () => ({ loadStripe: jest.fn(() => Promise.resolve(null)) }));

const mockConfirm = jest.fn();
let mockCheckoutState: any = { type: 'loading' };
jest.mock('@stripe/react-stripe-js/checkout', () => ({
  CheckoutProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  // 押すと支払い方法を PayPay に選んだことにする（onChange の形は Stripe の PaymentElement と同じ）
  PaymentElement: ({ onChange }: any) => (
    <button type="button" data-testid="payment-element" onClick={() => onChange?.({ value: { type: 'paypay' } })} />
  ),
  useCheckout: () => mockCheckoutState,
}));

const mockPlaceOrder = jest.fn();
jest.mock('@/app/checkout/_lib/checkout-api', () => ({
  placeOrder: (...args: unknown[]) => mockPlaceOrder(...args),
}));
jest.mock('@/app/checkout/_lib/page-reload', () => ({ reloadPage: jest.fn() }));

import { FinalConfirmationStep } from '@/app/checkout/_components/FinalConfirmationStep';
import { reloadPage } from '@/app/checkout/_lib/page-reload';

const CONFIRMATION = {
  checkoutSessionId: 'cs_test_1',
  clientSecret: 'cs_test_1_secret',
  promotionCode: 'WELCOME10',
  shipping: {
    email: 'a@example.com',
    fullName: '山田 花子',
    kanaName: 'ヤマダ ハナコ',
    postalCode: '1500001',
    prefecture: '東京都',
    city: '渋谷区',
    address: '神宮前1-1-1',
    building: null,
    phone: '0311112222',
  },
  lines: [
    { itemId: 1, name: 'シャツ', price: 5000, imageUrl: null, color: 'BLACK', size: 'M', quantity: 1, variantId: 11, fulfillment: 'stock' as const },
    { itemId: 2, name: 'パンツ', price: 8000, imageUrl: null, color: 'NAVY', size: 'L', quantity: 2, variantId: 22, fulfillment: 'backorder' as const },
  ],
};

function setReady() {
  mockCheckoutState = {
    type: 'success',
    checkout: {
      confirm: mockConfirm,
      total: {
        subtotal: { amount: '¥21,000', minorUnitsAmount: 21000 },
        discount: { amount: '¥2,100', minorUnitsAmount: 2100 },
        shippingRate: { amount: '¥0', minorUnitsAmount: 0 },
        total: { amount: '¥18,900', minorUnitsAmount: 18900 },
      },
    },
  };
}

function renderStep(overrides: Partial<React.ComponentProps<typeof FinalConfirmationStep>> = {}) {
  const props = {
    confirmation: CONFIRMATION,
    notice: null,
    completing: false,
    onEdit: jest.fn(),
    onPaid: jest.fn(),
    onRejected: jest.fn(),
    ...overrides,
  };
  render(<FinalConfirmationStep {...props} />);
  return props;
}

describe('FinalConfirmationStep（設計書 2-3・第4章）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    mockCheckoutState = { type: 'loading' };
  });

  test('表題と、特定商取引法の項目（支払いの時期・方法、明細ごとのお届けの時期、返品）を出す', () => {
    setReady();
    renderStep();

    expect(screen.getByRole('heading', { name: '注文内容の最終確認' })).toBeInTheDocument();
    const terms = screen.getByTestId('checkout-terms');
    expect(terms).toHaveTextContent('クレジットカード：ご注文時にお支払いが確定します');
    expect(terms).toHaveTextContent('PayPay：ご注文時に PayPay の画面でお支払いが確定します');
    expect(terms).toHaveTextContent(
      'コンビニ払い：ご注文から7日以内に、発行される払込番号でお支払いください。期限までにお支払いが確認できないときは、ご注文をキャンセルします',
    );
    expect(terms).toHaveTextContent('シャツ（BLACK / M）× 1：在庫あり・ご注文（コンビニはご入金）の確認後、3〜7営業日で発送');
    expect(terms).toHaveTextContent('パンツ（NAVY / L）× 2：受注生産・発送まで数週間〜2か月以上（目安）');
    expect(terms).toHaveTextContent(
      'ご注文後のお客様都合による返品・交換・キャンセルはお受けできません。初期不良・誤送は、商品到着後7日以内にご連絡ください。詳しくは特定商取引法の表記をご覧ください',
    );
    expect(screen.getByRole('link', { name: '特定商取引法の表記' })).toHaveAttribute('href', '/legal');
    expect(screen.getByText('WELCOME10')).toBeInTheDocument();
    expect(screen.getByText('¥18,900')).toBeInTheDocument();
    expect(screen.getByText('150-0001', { exact: false })).toBeInTheDocument();
  });

  test('決済フォームの準備ができるまで「注文する」は押せない', () => {
    renderStep();

    expect(screen.getByRole('button', { name: '決済フォームを準備中...' })).toBeDisabled();
  });

  test('「注文する」で、在庫ありと見せた明細だけを送って受け付け、支払い、済んだら完了へ進む', async () => {
    setReady();
    mockPlaceOrder.mockResolvedValue({ kind: 'accepted', orderId: 'order-1' });
    mockConfirm.mockResolvedValue({ type: 'success' });
    const props = renderStep();

    fireEvent.click(screen.getByRole('button', { name: '注文する' }));

    await waitFor(() => expect(props.onPaid).toHaveBeenCalledWith('cs_test_1'));
    expect(mockPlaceOrder).toHaveBeenCalledWith({ checkoutSessionId: 'cs_test_1', inStockVariantIds: [11] });
    expect(mockConfirm).toHaveBeenCalledWith({
      redirect: 'if_required',
      returnUrl: 'http://localhost/checkout?session_id={CHECKOUT_SESSION_ID}',
    });
    expect(window.sessionStorage.getItem('checkout:payment-attempt')).toBeNull();
  });

  test('処理中は「注文する」を押せない（二度押しで2回受け付けない）', async () => {
    setReady();
    let resolvePlace!: (value: unknown) => void;
    mockPlaceOrder.mockReturnValue(new Promise((resolve) => (resolvePlace = resolve)));
    renderStep();

    fireEvent.click(screen.getByRole('button', { name: '注文する' }));
    const busy = await screen.findByRole('button', { name: '注文を確定しています...' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);

    resolvePlace({ kind: 'error', message: 'ご注文を受け付けられませんでした。' });
    expect(await screen.findByText('ご注文を受け付けられませんでした。')).toBeInTheDocument();
  });

  test('受け付けで断られたら、支払わずに親へ渡す', async () => {
    setReady();
    const rejection = { code: 'stock_changed', message: '在庫の状況が変わりました。…', changedLines: [] };
    mockPlaceOrder.mockResolvedValue({ kind: 'rejected', rejection });
    const props = renderStep();

    fireEvent.click(screen.getByRole('button', { name: '注文する' }));

    await waitFor(() => expect(props.onRejected).toHaveBeenCalledWith(rejection));
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test('カードが断られたら理由を出し、受け付け済みのまま同じ画面でやり直せる', async () => {
    setReady();
    mockPlaceOrder.mockResolvedValue({ kind: 'accepted', orderId: 'order-1' });
    mockConfirm.mockResolvedValueOnce({ type: 'error', error: { message: 'カードが拒否されました。' } });
    const props = renderStep();

    fireEvent.click(screen.getByRole('button', { name: '注文する' }));

    expect(await screen.findByText('カードが拒否されました。')).toBeInTheDocument();
    expect(props.onPaid).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '注文する' })).toBeEnabled();
    expect(window.sessionStorage.getItem('checkout:payment-attempt')).toBeNull();
  });

  test('受け付けの後に支払いの処理が例外で止まったら、受け付けられなかったとは言わず、支払いの案内を出す', async () => {
    setReady();
    mockPlaceOrder.mockResolvedValue({ kind: 'accepted', orderId: 'order-1' });
    mockConfirm.mockRejectedValueOnce(new Error('network'));
    const props = renderStep();

    fireEvent.click(screen.getByRole('button', { name: '注文する' }));

    expect(await screen.findByText('お支払いを完了できませんでした。もう一度お試しください。')).toBeInTheDocument();
    expect(props.onPaid).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '注文する' })).toBeEnabled();
    expect(window.sessionStorage.getItem('checkout:payment-attempt')).toBeNull();
  });

  test('支払い方法で PayPay を選んで「注文する」を押すと、Stripe の画面へ移る前に支払いの試みを残す（決め事 D10）', async () => {
    setReady();
    mockPlaceOrder.mockResolvedValue({ kind: 'accepted', orderId: 'order-1' });
    mockConfirm.mockReturnValueOnce(new Promise(() => {}));
    renderStep();

    fireEvent.click(screen.getByTestId('payment-element'));
    fireEvent.click(screen.getByRole('button', { name: '注文する' }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(JSON.parse(window.sessionStorage.getItem('checkout:payment-attempt') ?? 'null')).toEqual({
      checkoutSessionId: 'cs_test_1',
      paymentType: 'paypay',
    });
  });

  test('もう支払いが済んでいれば、支払わずに完了へ進む', async () => {
    setReady();
    mockPlaceOrder.mockResolvedValue({ kind: 'payment_done' });
    const props = renderStep();

    fireEvent.click(screen.getByRole('button', { name: '注文する' }));

    await waitFor(() => expect(props.onPaid).toHaveBeenCalledWith('cs_test_1'));
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test('支払いの後の完了の処理の間は「注文する」も「変更」も「戻る」も押せない', () => {
    setReady();
    renderStep({ completing: true });

    expect(screen.getByRole('button', { name: '注文を確定しています...' })).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: '変更' })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: '戻る' })).toBeDisabled();
  });

  test('ブラウザの「戻る」でページが保存から復元されたときだけ読み込み直す（Stripe の画面から戻って「処理中」のまま残さない）', () => {
    setReady();
    renderStep();
    const dispatchPageShow = (persisted: boolean) => {
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: persisted });
      window.dispatchEvent(event);
    };

    dispatchPageShow(false);
    expect(reloadPage).not.toHaveBeenCalled();

    dispatchPageShow(true);
    expect(reloadPage).toHaveBeenCalledTimes(1);

    // 画面を離れた後は、この部品の読み込み直しが残らない
    cleanup();
    dispatchPageShow(true);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  test('「変更」で入力画面へ戻る。案内があれば画面の上に出す', () => {
    setReady();
    const props = renderStep({ notice: 'PayPay でのお支払いが完了しませんでした' });

    expect(screen.getByTestId('checkout-final-notice')).toHaveTextContent('PayPay でのお支払いが完了しませんでした');
    fireEvent.click(screen.getAllByRole('button', { name: '変更' })[0]);
    expect(props.onEdit).toHaveBeenCalled();
  });
});
