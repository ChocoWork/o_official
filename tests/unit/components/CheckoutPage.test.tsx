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
const mockRefreshAuthState = jest.fn();
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: true, refreshAuthState: mockRefreshAuthState }),
}));

const PROFILE = {
  email: 'a@example.com',
  fullName: '山田 花子',
  kanaName: 'ヤマダ ハナコ',
  phone: '0311112222',
  address: { postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-1-1', building: '' },
};
// プロフィールと住所帳の応答。既定は今までどおり（プロフィールだけが返り、住所帳は失敗する）。
// 入り直しのテストが、中身と返るタイミング（門が開くまで待つ）を差し替える
let mockProfileBody: unknown = PROFILE;
let mockSavedAddresses: unknown[] | null = null;
let mockProfileGate: Promise<void> | null = null;
let mockAddressesGate: Promise<void> | null = null;
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: async (url: string) => {
    if (url === '/api/profile') {
      await mockProfileGate;
      return { ok: true, json: async () => mockProfileBody };
    }
    if (url === '/api/profile/addresses' && mockSavedAddresses !== null) {
      await mockAddressesGate;
      return { ok: true, json: async () => ({ addresses: mockSavedAddresses }) };
    }
    return { ok: false, json: async () => ({}) };
  },
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

// 保存済み住所。郵便番号は住所帳に数字だけで残り、文字は入力のまま（B の番地は全角）残る。
// 既定は東京（A）、大阪（B）は既定でない
const SAVED_TOKYO = { id: 'addr-tokyo', postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-1-1', building: '', isDefault: true };
const SAVED_OSAKA = { id: 'addr-osaka', postalCode: '5300001', prefecture: '大阪府', city: '大阪市北区', address: '梅田２－２－２', building: '', isDefault: false };
const draftWith = (shipping: Record<string, string | null>) => ({
  ...CONFIRMATION,
  shipping: { ...CONFIRMATION.shipping, ...shipping },
});
// 保存済みの B と同じ住所の下書き。サーバーは文字を半角（NFKC）にそろえるので番地は半角、住所の後ろに空白があり、
// 建物名は null（住所帳は空文字）でも、同じ住所として扱う。画面は下書きの郵便番号を「530-0001」の形にして
// 入力欄へ戻すので、住所帳の数字だけの郵便番号とは数字だけで比べる
const CONFIRMATION_OSAKA = draftWith({ postalCode: '5300001', prefecture: '大阪府', city: '大阪市北区', address: '梅田2-2-2 ', building: null });
// どの保存済み住所とも違う下書き
const CONFIRMATION_KYOTO = draftWith({ postalCode: '6008001', prefecture: '京都府', city: '京都市下京区', address: '四条通3-3-3', building: null });

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// 待っている読み込み（プロフィール・住所帳）を終わらせる
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

// 入力画面から「確認へ進む」で最終確認画面まで進む。requestCheckoutConfirmation の応答は呼ぶ前に決めておく
async function openFinalStep() {
  render(<CheckoutPage />);
  fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));
  await screen.findByTestId('final-step');
}

// 送った配送先を下書きにして返す。サーバーと同じく、文字を NFKC にそろえて前後の空白を除き、郵便番号は数字だけにして残す
function echoDraft() {
  mockApi.requestCheckoutConfirmation.mockImplementation(async (body: { shipping: Record<string, string> }) => {
    const shipping = Object.fromEntries(
      Object.entries(body.shipping).map(([key, value]) => [key, value.normalize('NFKC').trim()]),
    );
    return {
      kind: 'confirmation',
      confirmation: { ...CONFIRMATION, shipping: { ...shipping, postalCode: shipping.postalCode.replace(/\D/g, '') } },
    };
  });
}

// プロフィール・住所帳の読み込みが、下書きを戻す前に終わる／後に終わる順
const LOAD_ORDERS = [
  ['読み込みが先に終わる', 'loadedBefore'],
  ['読み込みが後に終わる', 'loadedAfter'],
] as const;
type LoadOrder = (typeof LOAD_ORDERS)[number][1];

// 入り直し（URL に決済の画面の ID）で最終確認画面を開く。読み込みの終わる順をテストが作る
async function openReentered(confirmation: unknown, order: LoadOrder) {
  mockSearch = 'session_id=cs_test_1';
  const gate = createDeferred();
  if (order === 'loadedBefore') {
    // 下書きを戻す側（入り直しの問い合わせの応答）を、読み込みが済むまで止める
    mockApi.resumeCheckout.mockImplementation(async () => {
      await gate.promise;
      return { state: 'resume', confirmation };
    });
  } else {
    // 読み込みの側を止める。下書きを戻してから開ける
    mockProfileGate = gate.promise;
    mockAddressesGate = gate.promise;
    mockApi.resumeCheckout.mockResolvedValue({ state: 'resume', confirmation });
  }
  render(<CheckoutPage />);

  if (order === 'loadedBefore') {
    await settle();
    await act(async () => {
      gate.resolve();
    });
    await screen.findByTestId('final-step');
  } else {
    await screen.findByTestId('final-step');
    await act(async () => {
      gate.resolve();
    });
    await settle();
  }
}

describe('決済の画面（グループ F）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks は once の積み残しと mockImplementation を消さない。テストの間に持ち越さない
    mockApi.requestCheckoutConfirmation.mockReset();
    mockApi.completeCheckout.mockReset();
    mockApi.checkPromotionCodeRequest.mockReset();
    window.sessionStorage.clear();
    mockSearch = '';
    mockFinalProps = null;
    mockProfileBody = PROFILE;
    mockSavedAddresses = null;
    mockProfileGate = null;
    mockAddressesGate = null;
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
    expect(screen.getByLabelText('プロモーションコード')).toHaveValue('MIN10000');
    expect(window.sessionStorage.getItem('checkout:promotion-code')).toBeNull();
  });

  test('適用成功でコードを覚え、削除で記録を消す', async () => {
    mockApi.checkPromotionCodeRequest.mockResolvedValue({ kind: 'applied', preview: { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 } });
    render(<CheckoutPage />);
    fireEvent.change(await screen.findByLabelText('プロモーションコード'), { target: { value: 'welcome10' } });
    fireEvent.click(screen.getByRole('button', { name: '適用' }));
    await screen.findByText('WELCOME10');
    expect(JSON.parse(window.sessionStorage.getItem('checkout:promotion-code') ?? 'null')).toEqual({ code: 'WELCOME10' });
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(window.sessionStorage.getItem('checkout:promotion-code')).toBeNull();
    expect(screen.getByLabelText('プロモーションコード')).toHaveValue('');
  });

  test.each(['none', 'unavailable'])('入力画面を開き直す（%s）と記録したコードを確かめ直して割引を表示する', async (state) => {
    window.sessionStorage.setItem('checkout:promotion-code', JSON.stringify({ code: 'WELCOME10' }));
    mockApi.resumeCheckout.mockResolvedValue({ state });
    mockApi.checkPromotionCodeRequest.mockResolvedValue({ kind: 'applied', preview: { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 } });
    render(<CheckoutPage />);
    expect(await screen.findByText('WELCOME10')).toBeInTheDocument();
    expect(screen.getByText('¥4,500')).toBeInTheDocument();
    expect(mockApi.checkPromotionCodeRequest).toHaveBeenCalledTimes(1);
    expect(mockApi.checkPromotionCodeRequest).toHaveBeenCalledWith('WELCOME10');
  });

  test.each(['none', 'unavailable'])('開き直した記録のコードが使えない（%s）ときは欄と理由を残し、記録を消す', async (state) => {
    window.sessionStorage.setItem('checkout:promotion-code', JSON.stringify({ code: 'OLD10' }));
    mockApi.resumeCheckout.mockResolvedValue({ state });
    mockApi.checkPromotionCodeRequest.mockResolvedValue({ kind: 'rejected', message: 'このコードは有効期限が切れています', transient: false });
    render(<CheckoutPage />);
    const input = await screen.findByLabelText('プロモーションコード');
    expect(input).toHaveValue('OLD10');
    expect(input).toHaveAccessibleDescription('このコードは有効期限が切れています');
    expect(window.sessionStorage.getItem('checkout:promotion-code')).toBeNull();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
  });

  test.each(['resume', 'proceed'])('最終確認の内容にあるコードを覚える（%s）', async (source) => {
    const confirmation = { ...CONFIRMATION, promotionCode: 'WELCOME10' };
    mockApi.checkPromotionCodeRequest.mockResolvedValue({ kind: 'applied', preview: { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 } });
    if (source === 'resume') {
      mockApi.resumeCheckout.mockResolvedValue({ state: 'resume', confirmation });
      render(<CheckoutPage />);
      await screen.findByTestId('final-step');
    } else {
      mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation });
      await openFinalStep();
    }
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem('checkout:promotion-code') ?? 'null')).toEqual({ code: 'WELCOME10' }));
  });

  test('最終確認のコードの確かめ直しで使えないときは記録を消し、変更した入力画面にコードと理由を残す', async () => {
    window.sessionStorage.setItem('checkout:promotion-code', JSON.stringify({ code: 'OLD10' }));
    mockApi.resumeCheckout.mockResolvedValue({ state: 'resume', confirmation: { ...CONFIRMATION, promotionCode: 'OLD10' } });
    mockApi.checkPromotionCodeRequest.mockResolvedValue({ kind: 'rejected', message: 'このコードは使えません', transient: false });
    render(<CheckoutPage />);
    await screen.findByTestId('final-step');
    act(() => mockFinalProps.onEdit());
    expect(await screen.findByLabelText('プロモーションコード')).toHaveValue('OLD10');
    expect(screen.getByLabelText('プロモーションコード')).toHaveAccessibleDescription('このコードは使えません');
    expect(window.sessionStorage.getItem('checkout:promotion-code')).toBeNull();
  });

  test.each(['none', 'unavailable', 'resume'])('確かめ直しが一時的に失敗（%s）したら記録を残し、欄にコードと失敗の文を出す', async (state) => {
    const message = '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。';
    window.sessionStorage.setItem('checkout:promotion-code', JSON.stringify({ code: 'WELCOME10' }));
    mockApi.resumeCheckout.mockResolvedValue(state === 'resume'
      ? { state, confirmation: { ...CONFIRMATION, promotionCode: 'WELCOME10' } }
      : { state });
    mockApi.checkPromotionCodeRequest.mockResolvedValue({ kind: 'rejected', message, transient: true });
    render(<CheckoutPage />);
    if (state === 'resume') {
      await screen.findByTestId('final-step');
      act(() => mockFinalProps.onEdit());
    }

    expect(await screen.findByLabelText('プロモーションコード')).toHaveValue('WELCOME10');
    expect(screen.getByLabelText('プロモーションコード')).toHaveAccessibleDescription(message);
    expect(JSON.parse(window.sessionStorage.getItem('checkout:promotion-code') ?? 'null')).toEqual({ code: 'WELCOME10' });
    expect(mockApi.checkPromotionCodeRequest).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '削除' })).toBeNull();
  });

  test('記録したコードの確かめ直しが終わるまで、読み込み表示で入力操作を待たせる', async () => {
    window.sessionStorage.setItem('checkout:promotion-code', JSON.stringify({ code: 'WELCOME10' }));
    const gate = createDeferred<any>();
    mockApi.checkPromotionCodeRequest.mockReturnValue(gate.promise);
    render(<CheckoutPage />);
    await waitFor(() => expect(mockApi.checkPromotionCodeRequest).toHaveBeenCalledWith('WELCOME10'));
    expect(screen.queryByLabelText('プロモーションコード')).toBeNull();
    expect(screen.queryByRole('button', { name: '確認へ進む' })).toBeNull();

    await act(async () => gate.resolve({ kind: 'applied', preview: { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 } }));

    expect(await screen.findByText('WELCOME10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
    expect(mockApi.resumeCheckout).toHaveBeenCalledTimes(1);
    expect(mockApi.checkPromotionCodeRequest).toHaveBeenCalledTimes(1);
  });

  test('同じ適用済みコードを2回断られても、毎回そのコードを欄に戻す', async () => {
    mockApi.checkPromotionCodeRequest.mockResolvedValue({ kind: 'applied', preview: { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 } });
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'promotion_code_invalid', message: 'このコードは使えません' });
    render(<CheckoutPage />);
    await screen.findByLabelText('プロモーションコード');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.change(screen.getByLabelText('プロモーションコード'), { target: { value: 'WELCOME10' } });
      fireEvent.click(screen.getByRole('button', { name: '適用' }));
      await screen.findByText('WELCOME10');
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByText('このコードは使えません');
      expect(screen.getByLabelText('プロモーションコード')).toHaveValue('WELCOME10');
      expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
    }
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(2);
  });

  test.each(['completed', 'error'])('注文の完了処理が %s のとき、成功の場合だけコードの記録を消す', async (kind) => {
    window.sessionStorage.setItem('checkout:promotion-code', JSON.stringify({ code: 'WELCOME10' }));
    mockApi.resumeCheckout.mockResolvedValue({ state: 'payment_done', checkoutSessionId: 'cs_test_1' });
    mockApi.completeCheckout.mockResolvedValue(kind === 'completed' ? { kind, orderId: 'a1b2c3d4-0000', orderStatus: 'paid' } : { kind, message: '注文確定に失敗しました' });
    render(<CheckoutPage />);
    if (kind === 'completed') {
      await screen.findByRole('heading', { name: 'ご注文は確定しています' });
      expect(window.sessionStorage.getItem('checkout:promotion-code')).toBeNull();
    } else {
      await screen.findByText('注文確定に失敗しました');
      expect(JSON.parse(window.sessionStorage.getItem('checkout:promotion-code') ?? 'null')).toEqual({ code: 'WELCOME10' });
      expect(mockApi.checkPromotionCodeRequest).not.toHaveBeenCalled();
    }
  });

  test('別のブラウザでは状態を出さず、入力画面の上で確認メールを案内し URL を戻す', async () => {
    mockSearch = 'session_id=cs_other';
    mockApi.resumeCheckout.mockResolvedValue({ state: 'unavailable' });
    // 誤って完了の処理へ進めば注文番号を出せる応答にして、非表示の検証を空振りさせない。
    mockApi.completeCheckout.mockResolvedValue({
      kind: 'completed', orderId: 'a1b2c3d4-0000-0000-0000-000000000000', orderStatus: 'paid',
    });
    render(<CheckoutPage />);
    const notice = await screen.findByTestId('checkout-resume-notice');
    await waitFor(() => expect(notice).toHaveTextContent('このブラウザではご注文の状態を表示できません。お支払いがお済みの場合は、ご注文確認のメールをお送りしています。'));
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice.closest('.checkout-grid')).toBeNull();
    expect(mockRouter.replace).toHaveBeenCalledWith('/checkout');
    expect(screen.queryByTestId('final-step')).toBeNull();
    expect(screen.queryByText(/^ORD-/)).toBeNull();
    expect(mockApi.completeCheckout).not.toHaveBeenCalled();
  });

  test('入り直しが unavailable でも、最終確認へ進んだ後は「変更」で戻っても別のブラウザの案内を残さない', async () => {
    mockSearch = 'session_id=cs_other';
    mockApi.resumeCheckout.mockResolvedValue({ state: 'unavailable' });
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    render(<CheckoutPage />);
    await waitFor(() => expect(screen.getByTestId('checkout-resume-notice')).toHaveTextContent(
      'このブラウザではご注文の状態を表示できません。お支払いがお済みの場合は、ご注文確認のメールをお送りしています。',
    ));

    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
    await screen.findByTestId('final-step');
    act(() => { mockFinalProps.onEdit(); });

    expect(await screen.findByRole('button', { name: '確認へ進む' })).toBeInTheDocument();
    expect(screen.getByTestId('checkout-resume-notice')).toBeEmptyDOMElement();
  });

  test('入り直しの案内の入れ物は、案内が無い入力画面にも置く', async () => {
    render(<CheckoutPage />);
    expect(await screen.findByTestId('checkout-resume-notice')).toBeEmptyDOMElement();
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

  test('時間切れの作り直しで買えない商品が見つかったら、商品名の案内を渡してカートへ移る', async () => {
    const message = '以下の商品は現在購入できません: 非公開のシャツ';
    mockApi.requestCheckoutConfirmation
      .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION })
      .mockResolvedValueOnce({ kind: 'error', code: 'out_of_stock', message, retryable: false, correlationId: null });
    await openFinalStep();

    await act(async () => { mockFinalProps.onRejected({ code: 'session_expired', message: '時間がたったため、お支払い情報をもう一度入力してください', changedLines: [] }); });

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/cart'));
    expect(JSON.parse(window.sessionStorage.getItem('checkout:cart-notice') ?? 'null')).toEqual({ kind: 'message', message });
    expect(screen.queryByRole('button', { name: '確認へ進む' })).toBeNull();
  });

  test('ふつうの確認で買えない商品が見つかったら、入力画面で商品名を案内してボタンを無効にする', async () => {
    const message = '以下の商品は現在購入できません: 非公開のシャツ';
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'error', code: 'out_of_stock', message, retryable: false, correlationId: null });
    render(<CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeDisabled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  test('金額が食い違ったらカートを読み直して案内し、新しい金額で押し直せる', async () => {
    const message = '価格が変わりました。金額をご確認のうえ、もう一度「確認へ進む」を押してください。';
    jest.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => CART } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...CART[0], items: { ...CART[0].items, price: 7000 } }] } as Response);
    mockApi.requestCheckoutConfirmation
      .mockResolvedValueOnce({ kind: 'error', code: 'checkout_amount_mismatch', message: '金額の食い違い', retryable: false, correlationId: null })
      .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION });
    render(<CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getAllByText('¥7,000').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
    await screen.findByTestId('final-step');
    expect(mockApi.requestCheckoutConfirmation.mock.calls[1][0].displayedAmounts).toEqual({ subtotalAmount: 7000, taxAmount: 0, shippingAmount: 0, totalAmount: 7000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('割引適用中に金額が食い違ったら、カートを読んだ後にコードを1回確かめ直し、要約を新しくする', async () => {
    const refreshed = { code: 'WELCOME10', subtotalAmount: 7000, shippingAmount: 600, discountAmount: 700, totalAmount: 6900 };
    jest.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => CART } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...CART[0], items: { ...CART[0].items, price: 7000 } }] } as Response);
    mockApi.checkPromotionCodeRequest
      .mockResolvedValueOnce({ kind: 'applied', preview: { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 } })
      .mockImplementationOnce(async () => {
        expect(fetch).toHaveBeenCalledTimes(2);
        return { kind: 'applied', preview: refreshed };
      });
    mockApi.requestCheckoutConfirmation
      .mockResolvedValueOnce({ kind: 'error', code: 'checkout_amount_mismatch', message: '金額の食い違い', retryable: false, correlationId: null })
      .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION });
    render(<CheckoutPage />);
    fireEvent.change(await screen.findByLabelText('プロモーションコード'), { target: { value: 'WELCOME10' } });
    fireEvent.click(screen.getByRole('button', { name: '適用' }));
    await screen.findByText('WELCOME10');
    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

    await screen.findByText('価格が変わりました。金額をご確認のうえ、もう一度「確認へ進む」を押してください。');
    expect(mockApi.checkPromotionCodeRequest).toHaveBeenCalledTimes(2);
    expect(mockApi.checkPromotionCodeRequest).toHaveBeenLastCalledWith('WELCOME10');
    expect(screen.getByText('小計').parentElement).toHaveTextContent('¥7,000');
    expect(screen.getByText('配送料').parentElement).toHaveTextContent('¥600');
    expect(screen.getByText('割引').parentElement).toHaveTextContent('-¥700');
    expect(screen.getByText('合計').parentElement).toHaveTextContent('¥6,900');
    expect(screen.queryByText('¥4,500')).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem('checkout:promotion-code') ?? 'null')).toEqual({ code: 'WELCOME10' });
    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
    await screen.findByTestId('final-step');
    expect(mockApi.requestCheckoutConfirmation.mock.calls[1][0]).toMatchObject({
      promotionCode: 'WELCOME10', displayedAmounts: { subtotalAmount: 7000, taxAmount: 0, shippingAmount: 0, totalAmount: 7000 },
    });
  });

  test.each([false, true])('価格変更後のコードの確かめ直しで断られたら、欄と理由を戻し目安を外す（一時的: %s）', async (transient) => {
    const message = transient
      ? '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。'
      : 'このコードは有効期限が切れています';
    jest.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => CART } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...CART[0], items: { ...CART[0].items, price: 7000 } }] } as Response);
    mockApi.checkPromotionCodeRequest
      .mockResolvedValueOnce({ kind: 'applied', preview: { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 } })
      .mockResolvedValueOnce({ kind: 'rejected', message, transient });
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'error', code: 'checkout_amount_mismatch', message: '金額の食い違い', retryable: false, correlationId: null });
    render(<CheckoutPage />);
    fireEvent.change(await screen.findByLabelText('プロモーションコード'), { target: { value: 'WELCOME10' } });
    fireEvent.click(screen.getByRole('button', { name: '適用' }));
    await screen.findByText('WELCOME10');
    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

    const input = await screen.findByLabelText('プロモーションコード');
    expect(input).toHaveValue('WELCOME10');
    expect(input).toHaveAccessibleDescription(message);
    expect(screen.queryByText('割引')).toBeNull();
    expect(screen.getByText('合計').parentElement).toHaveTextContent('¥7,000');
    expect(mockApi.checkPromotionCodeRequest).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.sessionStorage.getItem('checkout:promotion-code') ?? 'null')).toEqual(transient ? { code: 'WELCOME10' } : null);
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
  });

  test('やり直せない断りは配送先の新規・保存済み選択や入力変更でも消えない', async () => {
    mockSavedAddresses = [SAVED_TOKYO, SAVED_OSAKA];
    const message = '以下の商品は現在購入できません: シャツ';
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'error', code: 'out_of_stock', message, retryable: false, correlationId: null });
    render(<CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeDisabled();

    fireEvent.click(screen.getByRole('combobox', { name: '保存済みの配送先' }));
    fireEvent.click(await screen.findByRole('option', { name: '新規' }));
    fireEvent.change(await screen.findByLabelText(/郵便番号/), { target: { value: '6008001' } });
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeDisabled();

    fireEvent.click(screen.getByRole('combobox', { name: '保存済みの配送先' }));
    fireEvent.click(await screen.findByRole('option', { name: /大阪府/ }));
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeDisabled();
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(1);
  });

  test('やり直せる断りは配送先で新規を選ぶと消せる', async () => {
    mockSavedAddresses = [SAVED_TOKYO];
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'error', code: 'checkout_session_failed', message: '一時的な失敗', retryable: true, correlationId: null });
    render(<CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));
    await screen.findByText('一時的な失敗');
    fireEvent.click(screen.getByRole('combobox', { name: '保存済みの配送先' }));
    fireEvent.click(await screen.findByRole('option', { name: '新規' }));
    expect(screen.queryByText('一時的な失敗')).toBeNull();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
  });

  test('最初の入力画面では見出しへフォーカスを移さない', async () => {
    render(<CheckoutPage />);
    const heading = await screen.findByRole('heading', { name: 'お客様情報' });
    expect(document.activeElement).not.toBe(heading);
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
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'お客様情報' }));
  });

  test.each([
    ['item_unavailable', 'ご注文いただけない商品が含まれています'],
    ['price_changed', '商品の価格が変わりました。内容をご確認ください'],
    ['cart_changed', 'カートの内容が変わりました。カートをご確認のうえ、もう一度お手続きください。'],
  ])('受け付けで %s を断られたら、カート画面へ案内の文言を渡して移る', async (code, message) => {
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    await openFinalStep();

    await act(async () => {
      mockFinalProps.onRejected({ code, message, changedLines: [] });
    });

    expect(JSON.parse(window.sessionStorage.getItem('checkout:cart-notice') ?? 'null')).toEqual({ kind: 'message', message });
    expect(mockRouter.push).toHaveBeenCalledWith('/cart');
  });

  test('受け付けで合計0円を断られたら、入力画面に戻って断りの文言を出す', async () => {
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    await openFinalStep();

    await act(async () => {
      mockFinalProps.onRejected({
        code: 'zero_amount',
        message: 'このご注文は合計が0円になるため、お受けできません',
        changedLines: [],
      });
    });

    expect(screen.queryByTestId('final-step')).toBeNull();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeInTheDocument();
    expect(screen.getByTestId('checkout-session-error')).toHaveTextContent('このご注文は合計が0円になるため、お受けできません');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'お客様情報' }));
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/checkout');
  });

  test('受け付けでログインの状態が変わったと断られたら、入力画面に戻って案内を出し、ログインの状態を読み直して、押し直せる', async () => {
    const message = 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。';
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    await openFinalStep();

    await act(async () => {
      mockFinalProps.onRejected({ code: 'login_changed', message, changedLines: [] });
    });

    expect(screen.queryByTestId('final-step')).toBeNull();
    expect(screen.getByTestId('checkout-session-error')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
    expect(mockRefreshAuthState).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/checkout');
    expect(mockRouter.push).not.toHaveBeenCalled();
    // 自動で送り直さない。お客様が押し直すと、今のログインで最終確認画面へ進む
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
    await screen.findByTestId('final-step');
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['auth_expired', 'ログインの有効期限が切れました。ログインし直すか、そのままもう一度「確認へ進む」を押してください。'],
    ['login_changed', 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。'],
  ])('「確認へ進む」が %s で返ったら、入力画面のまま案内を出し、ログインの状態を読み直して、押し直せる', async (code, message) => {
    mockApi.requestCheckoutConfirmation
      .mockResolvedValueOnce({ kind: 'error', code, message, retryable: true, correlationId: null })
      .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION });
    render(<CheckoutPage />);

    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByTestId('checkout-session-error')).toHaveTextContent(message);
    expect(screen.queryByTestId('final-step')).toBeNull();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
    expect(mockRefreshAuthState).toHaveBeenCalledTimes(1);
    // 自動でゲストとして送り直さない。お客様が押し直したときだけ、もう一度送る
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
    await screen.findByTestId('final-step');
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(2);
  });

  test('ログインと関係のない失敗では、ログインの状態を読み直さない', async () => {
    mockApi.requestCheckoutConfirmation.mockResolvedValue({
      kind: 'error', code: 'checkout_session_failed', message: '一時的な失敗', retryable: true, correlationId: null,
    });
    render(<CheckoutPage />);

    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));

    expect(await screen.findByText('一時的な失敗')).toBeInTheDocument();
    expect(mockRefreshAuthState).not.toHaveBeenCalled();
  });

  test('受け付けで別の画面の手続きを断られたら、最終確認画面の案内に出し、画面の上へ戻す', async () => {
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    await openFinalStep();
    // 最終確認画面へ進んだときの呼び出しを数えない
    (window.scrollTo as jest.Mock).mockClear();

    await act(async () => {
      mockFinalProps.onRejected({
        code: 'superseded',
        message: '別の画面で手続きが進んでいます。画面を読み込み直してください',
        changedLines: [],
      });
    });

    expect(screen.getByTestId('final-notice')).toHaveTextContent('別の画面で手続きが進んでいます。画面を読み込み直してください');
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  test('支払いの後の完了の処理が失敗したら、最終確認画面の案内に出し、画面の上へ戻す', async () => {
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    mockApi.completeCheckout.mockResolvedValue({
      kind: 'error',
      message: '注文確定に失敗しました。時間をおいて再度お試しください。',
    });
    await openFinalStep();
    (window.scrollTo as jest.Mock).mockClear();

    await act(async () => {
      mockFinalProps.onPaid('cs_test_1');
    });

    await waitFor(() =>
      expect(screen.getByTestId('final-notice')).toHaveTextContent('注文確定に失敗しました。時間をおいて再度お試しください。'),
    );
    expect(mockApi.completeCheckout).toHaveBeenCalledWith('cs_test_1');
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  test('最終確認で別の画面の支払い済み ID を受け取ると、その注文を仕上げて確定済みと案内する', async () => {
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    mockApi.completeCheckout.mockResolvedValue({ kind: 'completed', orderId: 'order-1', orderStatus: 'paid' });
    await openFinalStep();
    await act(async () => { mockFinalProps.onPaid('cs_paid'); });
    expect(mockApi.completeCheckout).toHaveBeenCalledWith('cs_paid');
    expect(await screen.findByRole('heading', { name: 'ご注文は確定しています' })).toBeInTheDocument();
  });

  test('「確認へ進む」で注文済みと分かったら、その決済の画面の ID で完了の処理をして「ご注文は確定しています」を出す', async () => {
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'order_already_placed', checkoutSessionId: 'cs_test_9' });
    mockApi.completeCheckout.mockResolvedValue({
      kind: 'completed',
      orderId: 'a1b2c3d4-0000-0000-0000-000000000000',
      orderStatus: 'paid',
    });
    render(<CheckoutPage />);

    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));

    expect(await screen.findByRole('heading', { name: 'ご注文は確定しています' })).toBeInTheDocument();
    expect(mockApi.completeCheckout).toHaveBeenCalledWith('cs_test_9');
    expect(screen.queryByTestId('final-step')).toBeNull();
  });

  test('時間切れの作り直しを待つ間は最終確認画面を押せず、終わると押せる', async () => {
    const rebuilt = createDeferred<unknown>();
    mockApi.requestCheckoutConfirmation
      .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION })
      .mockReturnValueOnce(rebuilt.promise);
    await openFinalStep();
    expect(mockFinalProps.completing).toBe(false);

    await act(async () => {
      mockFinalProps.onRejected({
        code: 'session_expired',
        message: '時間がたったため、お支払い情報をもう一度入力してください',
        changedLines: [],
      });
    });

    expect(mockFinalProps.completing).toBe(true);

    await act(async () => {
      rebuilt.resolve({ kind: 'confirmation', confirmation: { ...CONFIRMATION, checkoutSessionId: 'cs_test_2' } });
    });

    await waitFor(() => expect(screen.getByTestId('final-session')).toHaveTextContent('cs_test_2'));
    expect(mockFinalProps.completing).toBe(false);
  });

  test('時間切れの作り直しが失敗したら、入力画面に戻り、「確認へ進む」をもう一度押せる', async () => {
    mockApi.requestCheckoutConfirmation
      .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION })
      .mockResolvedValueOnce({
        kind: 'error',
        message: '決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。',
        retryable: true,
        correlationId: null,
      });
    await openFinalStep();

    await act(async () => {
      mockFinalProps.onRejected({
        code: 'session_expired',
        message: '時間がたったため、お支払い情報をもう一度入力してください',
        changedLines: [],
      });
    });

    expect(await screen.findByRole('button', { name: '確認へ進む' })).toBeEnabled();
    expect(screen.getByTestId('checkout-session-error')).toHaveTextContent('決済の準備に失敗しました');
    expect(screen.queryByTestId('final-step')).toBeNull();
  });

  describe('入り直しで下書きの配送先を戻したとき', () => {
    test.each(LOAD_ORDERS)(
      '下書きに建物名が無ければ、プロフィールの建物名は「変更」で戻った入力欄に入らない（プロフィールの%s）',
      async (_label, order) => {
        mockProfileBody = { ...PROFILE, address: { ...PROFILE.address, building: '101号室' } };
        mockSavedAddresses = [];
        await openReentered(CONFIRMATION, order);

        act(() => {
          mockFinalProps.onEdit();
        });

        expect(await screen.findByLabelText('建物名・部屋番号（任意）')).toHaveValue('');
      },
    );

    test.each(LOAD_ORDERS)(
      '下書きの住所が保存済みの B と同じなら、「変更」で戻った選択欄は B を指す（住所帳の%s）',
      async (_label, order) => {
        mockSavedAddresses = [SAVED_TOKYO, SAVED_OSAKA];
        await openReentered(CONFIRMATION_OSAKA, order);

        act(() => {
          mockFinalProps.onEdit();
        });

        const select = await screen.findByRole('combobox', { name: '保存済みの配送先' });
        expect(select).toHaveTextContent('〒530-0001');
        expect(select).not.toHaveTextContent('〒150-0001');
      },
    );

    test.each(LOAD_ORDERS)(
      '下書きの住所が保存済みのどれとも違えば、「変更」で戻った選択欄は「新規」を指す（住所帳の%s）',
      async (_label, order) => {
        mockSavedAddresses = [SAVED_TOKYO, SAVED_OSAKA];
        await openReentered(CONFIRMATION_KYOTO, order);

        act(() => {
          mockFinalProps.onEdit();
        });

        expect(await screen.findByRole('combobox', { name: '保存済みの配送先' })).toHaveTextContent('新規');
        expect(screen.getByLabelText(/郵便番号/)).toHaveValue('600-8001');
      },
    );
  });

  describe('普段の「確認へ進む」でも通る下書きの取り込み', () => {
    test('選んでいた保存済みの住所のまま「変更」で戻る', async () => {
      mockSavedAddresses = [SAVED_TOKYO, SAVED_OSAKA];
      echoDraft();
      render(<CheckoutPage />);

      const select = await screen.findByRole('combobox', { name: '保存済みの配送先' });
      await waitFor(() => expect(select).toHaveTextContent('〒150-0001'));
      fireEvent.click(select);
      fireEvent.click(await screen.findByRole('option', { name: /大阪府/ }));
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByTestId('final-step');

      act(() => {
        mockFinalProps.onEdit();
      });

      expect(await screen.findByRole('combobox', { name: '保存済みの配送先' })).toHaveTextContent('〒530-0001');
    });

    test('「新規」に入れた住所は「新規」のまま「変更」で戻る', async () => {
      mockSavedAddresses = [SAVED_TOKYO, SAVED_OSAKA];
      echoDraft();
      render(<CheckoutPage />);

      fireEvent.click(await screen.findByRole('combobox', { name: '保存済みの配送先' }));
      fireEvent.click(await screen.findByRole('option', { name: '新規' }));
      fireEvent.change(await screen.findByLabelText(/郵便番号/), { target: { value: '600-8001' } });
      fireEvent.click(screen.getByRole('combobox', { name: /都道府県/ }));
      fireEvent.click(await screen.findByRole('option', { name: '京都府' }));
      fireEvent.change(screen.getByLabelText(/市区町村/), { target: { value: '京都市下京区' } });
      fireEvent.change(screen.getByLabelText(/番地/), { target: { value: '四条通3-3-3' } });
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByTestId('final-step');

      act(() => {
        mockFinalProps.onEdit();
      });

      expect(await screen.findByRole('combobox', { name: '保存済みの配送先' })).toHaveTextContent('新規');
    });
  });

  describe('完了画面の「注文日」', () => {
    const renderPaid = async (justPaid: boolean) => {
      mockSearch = 'session_id=cs_test_1';
      if (justPaid) {
        window.sessionStorage.setItem(
          'checkout:payment-attempt',
          JSON.stringify({ checkoutSessionId: 'cs_test_1', paymentType: 'paypay' }),
        );
      }
      mockApi.resumeCheckout.mockResolvedValue({ state: 'payment_done', checkoutSessionId: 'cs_test_1' });
      mockApi.completeCheckout.mockResolvedValue({ kind: 'completed', orderId: 'a1b2c3d4-0000', orderStatus: 'paid' });
      render(<CheckoutPage />);
      await screen.findByText('ORD-A1B2C3D4');
    };

    test('入り直しの完了画面には出さない（後日に開くと日付がずれる）', async () => {
      await renderPaid(false);

      expect(screen.queryByText('注文日')).toBeNull();
      expect(screen.getByText('ご注文の状態')).toBeInTheDocument();
    });

    test('支払った直後の完了画面には出す', async () => {
      await renderPaid(true);

      expect(screen.getByText('注文日')).toBeInTheDocument();
    });
  });
});
