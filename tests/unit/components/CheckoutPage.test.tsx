import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

const mockRouter = { replace: jest.fn(), push: jest.fn() };
let mockSearch = '';
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const mockUpdateCartCount = jest.fn();
jest.mock('@/contexts/CartContext', () => ({ useCart: () => ({ updateCartCount: mockUpdateCartCount }) }));
jest.mock('@/contexts/LoginContext', () => ({ useLogin: () => ({ isLoggedIn: true }) }));

const PROFILE = {
  email: 'a@example.com',
  fullName: '山田 花子',
  kanaName: 'ヤマダ ハナコ',
  phone: '0311112222',
  address: { postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-1-1', building: '' },
};
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (url: string) =>
    Promise.resolve(
      url === '/api/profile'
        ? { ok: true, json: async () => PROFILE }
        : { ok: false, json: async () => ({}) },
    ),
}));

const mockApi = {
  requestCheckoutConfirmation: jest.fn(),
  resumeCheckout: jest.fn(),
  completeCheckout: jest.fn(),
  checkPromotionCodeRequest: jest.fn(),
};
jest.mock('@/app/checkout/_lib/checkout-api', () => ({
  requestCheckoutConfirmation: (...args: unknown[]) => mockApi.requestCheckoutConfirmation(...args),
  resumeCheckout: (...args: unknown[]) => mockApi.resumeCheckout(...args),
  completeCheckout: (...args: unknown[]) => mockApi.completeCheckout(...args),
  checkPromotionCodeRequest: (...args: unknown[]) => mockApi.checkPromotionCodeRequest(...args),
}));

// 最終確認画面の中身は FinalConfirmationStep のテストで見る。ここは画面の切り替えだけを見る
let mockFinalProps: any = null;
jest.mock('@/app/checkout/_components/FinalConfirmationStep', () => ({
  FinalConfirmationStep: (props: any) => {
    mockFinalProps = props;
    return (
      <div data-testid="final-step">
        <p data-testid="final-notice">{props.notice}</p>
        <p data-testid="final-session">{props.confirmation.checkoutSessionId}</p>
      </div>
    );
  },
}));

import CheckoutPage from '@/app/checkout/page';

const CART = [
  {
    id: 'cart-1', item_id: 1, quantity: 1, color: 'BLACK', size: 'M', added_at: '2026-10-08T00:00:00Z',
    items: { id: 1, name: 'シャツ', price: 5000, image_url: '/x.png', category: 'TOPS' },
  },
];
const CONFIRMATION = {
  checkoutSessionId: 'cs_test_1',
  clientSecret: 's',
  shipping: { ...PROFILE, postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-1-1', building: null },
  lines: [],
  promotionCode: null,
};

describe('決済の画面（グループ F）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    mockSearch = '';
    mockFinalProps = null;
    window.scrollTo = jest.fn() as unknown as typeof window.scrollTo;
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => CART });
    mockApi.resumeCheckout.mockResolvedValue({ state: 'none' });
  });

  test('開いたときに入り直しの状態を1回だけ聞き、入力画面に Stripe の部品を置かない', async () => {
    render(<CheckoutPage />);

    expect(await screen.findByRole('button', { name: '確認へ進む' })).toBeEnabled();
    expect(mockApi.resumeCheckout).toHaveBeenCalledTimes(1);
    expect(mockApi.resumeCheckout).toHaveBeenCalledWith(null);
    expect(screen.queryByTestId('final-step')).toBeNull();
  });

  test('「確認へ進む」で最終確認画面へ進み、URL を決済の画面の ID にする', async () => {
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    render(<CheckoutPage />);

    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));

    expect(await screen.findByTestId('final-step')).toBeInTheDocument();
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledWith({
      shipping: {
        email: 'a@example.com',
        fullName: '山田 花子',
        kanaName: 'ヤマダ ハナコ',
        postalCode: '150-0001',
        prefecture: '東京都',
        city: '渋谷区',
        address: '神宮前1-1-1',
        building: '',
        phone: '03-1111-2222',
      },
      displayedAmounts: { subtotalAmount: 5000, taxAmount: 0, shippingAmount: 0, totalAmount: 5000 },
      promotionCode: null,
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/checkout?session_id=cs_test_1');
  });

  test('「確認へ進む」で割引コードが断られたら、欄に理由を出して入力画面に留まる', async () => {
    mockApi.checkPromotionCodeRequest.mockResolvedValue({
      kind: 'applied',
      preview: { code: 'MIN10000', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 },
    });
    mockApi.requestCheckoutConfirmation.mockResolvedValue({
      kind: 'promotion_code_invalid',
      message: 'このコードは ¥10,000 以上のご注文で使えます',
    });
    render(<CheckoutPage />);

    fireEvent.change(await screen.findByLabelText('プロモーションコード'), { target: { value: 'MIN10000' } });
    fireEvent.click(screen.getByRole('button', { name: '適用' }));
    expect(await screen.findByText('MIN10000')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

    expect(await screen.findByText('このコードは ¥10,000 以上のご注文で使えます')).toBeInTheDocument();
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledWith(expect.objectContaining({ promotionCode: 'MIN10000' }));
    expect(screen.queryByTestId('final-step')).toBeNull();
    expect(screen.getByLabelText('プロモーションコード')).toBeInTheDocument();
  });

  test('PayPay から取りやめて戻ると、最終確認画面に案内が出る', async () => {
    mockSearch = 'session_id=cs_test_1';
    window.sessionStorage.setItem(
      'checkout:payment-attempt',
      JSON.stringify({ checkoutSessionId: 'cs_test_1', paymentType: 'paypay' }),
    );
    mockApi.resumeCheckout.mockResolvedValue({ state: 'resume', confirmation: CONFIRMATION });

    render(<CheckoutPage />);

    expect(await screen.findByTestId('final-notice')).toHaveTextContent('PayPay でのお支払いが完了しませんでした');
    expect(mockApi.resumeCheckout).toHaveBeenCalledWith('cs_test_1');
  });

  test('支払いの後に入り直すと、注文の確定を仕上げて「ご注文は確定しています」と注文番号・状態を出す', async () => {
    mockSearch = 'session_id=cs_test_1';
    mockApi.resumeCheckout.mockResolvedValue({ state: 'payment_done', checkoutSessionId: 'cs_test_1' });
    mockApi.completeCheckout.mockResolvedValue({
      kind: 'completed',
      orderId: 'a1b2c3d4-0000-0000-0000-000000000000',
      orderStatus: 'paid',
    });

    render(<CheckoutPage />);

    expect(await screen.findByRole('heading', { name: 'ご注文は確定しています' })).toBeInTheDocument();
    expect(screen.getByText('ORD-A1B2C3D4')).toBeInTheDocument();
    expect(screen.getByText('入金済み')).toBeInTheDocument();
    expect(mockApi.completeCheckout).toHaveBeenCalledTimes(1);
    expect(mockUpdateCartCount).toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/checkout?session_id=cs_test_1');
  });

  test('画面の中で支払った直後の戻り（記録あり）は、通常の完了画面にする', async () => {
    mockSearch = 'session_id=cs_test_1';
    window.sessionStorage.setItem(
      'checkout:payment-attempt',
      JSON.stringify({ checkoutSessionId: 'cs_test_1', paymentType: 'paypay' }),
    );
    mockApi.resumeCheckout.mockResolvedValue({ state: 'payment_done', checkoutSessionId: 'cs_test_1' });
    mockApi.completeCheckout.mockResolvedValue({ kind: 'completed', orderId: 'a1b2c3d4-0000', orderStatus: 'pending' });

    render(<CheckoutPage />);

    expect(await screen.findByRole('heading', { name: 'Thank you for your order' })).toBeInTheDocument();
    expect(screen.getByText('お支払い待ち')).toBeInTheDocument();
  });

  test('受け付けで在庫の変化を断られたら、カート画面へ案内を渡して移る', async () => {
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    render(<CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));
    await screen.findByTestId('final-step');

    await act(async () => {
      mockFinalProps.onRejected({
        code: 'stock_changed',
        message: '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）',
        changedLines: [{ itemId: 1, name: 'シャツ', color: 'BLACK', size: 'M' }],
      });
    });

    expect(JSON.parse(window.sessionStorage.getItem('checkout:cart-notice') ?? 'null')).toEqual({
      kind: 'stock_changed',
      message: '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）',
      lines: [{ itemId: 1, name: 'シャツ', color: 'BLACK', size: 'M' }],
    });
    expect(mockRouter.push).toHaveBeenCalledWith('/cart');
  });

  test('受け付けで時間切れを断られたら、決済の画面を作り直して案内を出す', async () => {
    mockApi.requestCheckoutConfirmation
      .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION })
      .mockResolvedValueOnce({ kind: 'confirmation', confirmation: { ...CONFIRMATION, checkoutSessionId: 'cs_test_2' } });
    render(<CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));
    await screen.findByTestId('final-step');

    await act(async () => {
      mockFinalProps.onRejected({
        code: 'session_expired',
        message: '時間がたったため、お支払い情報をもう一度入力してください',
        changedLines: [],
      });
    });

    await waitFor(() => expect(screen.getByTestId('final-session')).toHaveTextContent('cs_test_2'));
    expect(screen.getByTestId('final-notice')).toHaveTextContent('時間がたったため、お支払い情報をもう一度入力してください');
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(2);
  });

  test('「変更」で入力画面に戻り、URL から決済の画面の ID を外す', async () => {
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    render(<CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));
    await screen.findByTestId('final-step');

    act(() => {
      mockFinalProps.onEdit();
    });

    expect(await screen.findByRole('button', { name: '確認へ進む' })).toBeInTheDocument();
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/checkout');
  });
});
