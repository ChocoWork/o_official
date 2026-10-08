import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CART_OPTION_NAMES, type CartJson } from '@/features/cart/types/cart-json';

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
// 画面が読むログインの状態。ゲスト→会員のテストが書き換えて、再描画で画面に見せる。
// isAuthResolved は最初のログインの確認が済んだか（開いた時の確認と、開いたままの変化を分ける）
let mockIsLoggedIn = true;
let mockIsAuthResolved = true;
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: mockIsLoggedIn, isAuthResolved: mockIsAuthResolved, refreshAuthState: mockRefreshAuthState }),
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
// 200 以外ならプロフィールの入口は失敗を返す。ゲストは 401（保存済みの配送先も同じく失敗にするので mockSavedAddresses を null にする）。
// 0 は通信の失敗（投げる）
let mockProfileStatus = 200;
let mockSavedAddresses: unknown[] | null = null;
let mockProfileGate: Promise<void> | null = null;
let mockAddressesGate: Promise<void> | null = null;
// プロフィールを読む通信が呼ばれた順に使う応答。空なら上の既定を使う。読み直しが重なる試験で、呼び出しごとに中身と終わる時を決める
const mockProfileQueue: Array<{ body: unknown; gate?: Promise<void> }> = [];
// 保存の通信（GET 以外）の結果。200 以外なら失敗を返す
let mockWriteStatus = 200;
// 画面がプロフィール・保存済みの配送先を読んだ回数を数える（読み直しの有無を確かめる）
const mockClientFetchUrls: string[] = [];
// 保存の通信（"POST /api/profile" の形）。ゲストに前の会員の保存を試みさせていないことを確かめる
const mockClientFetchWrites: string[] = [];
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: async (url: string, init?: { method?: string }) => {
    mockClientFetchUrls.push(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      mockClientFetchWrites.push(`${method} ${url}`);
      return { ok: mockWriteStatus === 200, status: mockWriteStatus, json: async () => ({}) };
    }
    if (url === '/api/profile') {
      const queued = mockProfileQueue.shift();
      if (queued) {
        await queued.gate;
        return { ok: true, json: async () => queued.body };
      }
      await mockProfileGate;
      if (mockProfileStatus === 0) {
        throw new TypeError('Failed to fetch');
      }
      if (mockProfileStatus !== 200) {
        return { ok: false, status: mockProfileStatus, json: async () => ({ error: 'Unauthorized' }) };
      }
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

// カートの窓口（GET /api/cart）の応答の作り方。明細は Shopify の形で、画面が toCartEntries で今の形に直す
type CartLineSpec = { key: string; productId: number; name: string; price: number; color: string; size: string };
const cartJsonOf = (...specs: CartLineSpec[]): CartJson => {
  const items = specs.map((spec) => ({
    key: spec.key,
    id: spec.productId * 100,
    variant_id: spec.productId * 100,
    product_id: spec.productId,
    quantity: 1,
    title: `${spec.name} - ${spec.color} / ${spec.size}`,
    product_title: spec.name,
    variant_title: `${spec.color} / ${spec.size}`,
    options_with_values: [
      { name: CART_OPTION_NAMES.color, value: spec.color },
      { name: CART_OPTION_NAMES.size, value: spec.size },
    ],
    price: spec.price,
    line_price: spec.price,
    image: '/x.png',
    url: `/item/${spec.productId}`,
    fulfillment: null,
  }));
  const subtotal = items.reduce((sum, line) => sum + line.line_price, 0);
  return { item_count: items.length, currency: 'JPY', items_subtotal_price: subtotal, total_price: subtotal, items };
};
const SHIRT_LINE: CartLineSpec = { key: 'cart-1', productId: 1, name: 'シャツ', price: 5000, color: 'BLACK', size: 'M' };
const CART = cartJsonOf(SHIRT_LINE);
// 価格が変わった後に読み直すカート
const CART_REPRICED = cartJsonOf({ ...SHIRT_LINE, price: 7000 });
const CONFIRMATION = {
  checkoutSessionId: 'cs_test_1',
  clientSecret: 's',
  shipping: { ...PROFILE, postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-1-1', building: null },
  lines: [],
  promotionCode: null,
};

// ログインの変更（グループ C・C7）のテストで使う、もう一人の会員 B と、ゲストが入力した値。
// どの欄も PROFILE（会員 A）とも互いにも重ならない。B のプロフィールの建物名は空
const MEMBER_B = {
  email: 'b@example.com',
  fullName: '佐藤 次郎',
  kanaName: 'サトウ ジロウ',
  phone: '0661112222',
  address: { postalCode: '5300001', prefecture: '大阪府', city: '大阪市北区', address: '梅田2-2-2', building: '' },
};
const MEMBER_B_ADDRESS = { id: 'addr-b', postalCode: '5300001', prefecture: '大阪府', city: '大阪市北区', address: '梅田2-2-2', building: '', isDefault: true };
// 会員 B の内容で入力欄が置き換わっていれば、「確認へ進む」で送る配送先はこれになる
const MEMBER_B_SHIPPING = {
  email: 'b@example.com',
  fullName: '佐藤 次郎',
  kanaName: 'サトウ ジロウ',
  postalCode: '530-0001',
  prefecture: '大阪府',
  city: '大阪市北区',
  address: '梅田2-2-2',
  building: '',
  phone: '06-6111-2222',
};
// 読み直しが重なる試験で使う、3人目の会員 C（B とも重ならない）
const MEMBER_C = {
  email: 'c@example.com',
  fullName: '鈴木 三郎',
  kanaName: 'スズキ サブロウ',
  phone: '0521112222',
  address: { postalCode: '4600001', prefecture: '愛知県', city: '名古屋市中区', address: '栄3-3-3', building: '' },
};
const GUEST_INPUT = {
  email: 'guest@example.com',
  fullName: '田中 太郎',
  kanaName: 'タナカ タロウ',
  phone: '090-1234-5678',
  postalCode: '600-8001',
  prefecture: '京都府',
  city: '京都市下京区',
  address: '四条通3-3-3',
  building: 'ゲストビル201',
};
const LOGIN_CHANGED_MESSAGE = 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。';
const LOGIN_EXPIRED_MESSAGE = 'ログインの有効期限が切れました。ログインし直すか、そのままもう一度「確認へ進む」を押してください。';

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

// カート（/api/cart）を読んだ回数。開いた時の1回に加えて、ログインの状態が変わった後の読み直しを数える
const cartFetchCount = () => jest.mocked(fetch).mock.calls.filter(([url]) => url === '/api/cart').length;

// 会員が入力画面に入れた値（プロフィールの値を含む）を、9項目そろえて読む
const shippingInputs = () => ({
  email: (screen.getByLabelText(/メールアドレス/) as HTMLInputElement).value,
  fullName: (screen.getByLabelText(/氏名/) as HTMLInputElement).value,
  kanaName: (screen.getByLabelText(/フリガナ/) as HTMLInputElement).value,
  phone: (screen.getByLabelText(/電話番号/) as HTMLInputElement).value,
  postalCode: (screen.getByLabelText(/郵便番号/) as HTMLInputElement).value,
  city: (screen.getByLabelText(/市区町村/) as HTMLInputElement).value,
  address: (screen.getByLabelText(/番地/) as HTMLInputElement).value,
  building: (screen.getByLabelText(/建物名/) as HTMLInputElement).value,
});

// ゲストとして開いた入力画面に、9項目を入れる（入力欄はゲストの時だけ出る）
async function typeGuestShipping() {
  fireEvent.change(await screen.findByLabelText(/氏名/), { target: { value: GUEST_INPUT.fullName } });
  fireEvent.change(screen.getByLabelText(/フリガナ/), { target: { value: GUEST_INPUT.kanaName } });
  fireEvent.change(screen.getByLabelText(/メールアドレス/), { target: { value: GUEST_INPUT.email } });
  fireEvent.change(screen.getByLabelText(/電話番号/), { target: { value: GUEST_INPUT.phone } });
  fireEvent.change(screen.getByLabelText(/郵便番号/), { target: { value: GUEST_INPUT.postalCode } });
  fireEvent.click(screen.getByRole('combobox', { name: /都道府県/ }));
  fireEvent.click(await screen.findByRole('option', { name: GUEST_INPUT.prefecture }));
  fireEvent.change(screen.getByLabelText(/市区町村/), { target: { value: GUEST_INPUT.city } });
  fireEvent.change(screen.getByLabelText(/番地/), { target: { value: GUEST_INPUT.address } });
  fireEvent.change(screen.getByLabelText(/建物名/), { target: { value: GUEST_INPUT.building } });
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
    mockProfileStatus = 200;
    mockSavedAddresses = null;
    mockProfileGate = null;
    mockAddressesGate = null;
    mockProfileQueue.length = 0;
    mockWriteStatus = 200;
    mockIsLoggedIn = true;
    mockIsAuthResolved = true;
    // clearAllMocks は実装を消さない。ログインの状態を書き換える実装を、次のテストに持ち越さない
    mockRefreshAuthState.mockReset();
    mockClientFetchUrls.length = 0;
    mockClientFetchWrites.length = 0;
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

  test('注文の要約に、カートの窓口の明細（商品名・色 / サイズ・数量・価格）を出す', async () => {
    render(<CheckoutPage />);

    expect(await screen.findByText('シャツ')).toBeInTheDocument();
    expect(screen.getByText('BLACK / M')).toBeInTheDocument();
    expect(screen.getByText('数量: 1')).toBeInTheDocument();
    expect(screen.getByText('小計').parentElement).toHaveTextContent('¥5,000');
    expect(screen.queryByText('カートに商品がありません')).toBeNull();
  });

  test('カートの窓口が空のカートを返したら、商品が無い案内を出し、「確認へ進む」は送らない', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => cartJsonOf() });
    render(<CheckoutPage />);

    expect(await screen.findByText('カートに商品がありません')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
    expect(await screen.findByText('ご購入いただける商品がありません。商品を追加してから決済に進んでください。')).toBeInTheDocument();
    expect(mockApi.requestCheckoutConfirmation).not.toHaveBeenCalled();
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

  test('使えないログインのメールの案内を表示し、「確認へ進む」を押し直せない形にする', async () => {
    const message = 'ログイン中のメールアドレスを確かめられませんでした。ログインし直してから、もう一度お試しください。';
    mockApi.requestCheckoutConfirmation.mockResolvedValue({
      kind: 'error', code: 'invalid_member_email', message, retryable: false, correlationId: null,
    });
    render(<CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByTestId('checkout-session-error')).toHaveTextContent(message);
    const proceed = screen.getByRole('button', { name: '確認へ進む' });
    expect(proceed).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/建物名/), { target: { value: '入力を直した建物' } });
    expect(proceed).toBeDisabled();
    fireEvent.click(proceed);
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(1);
    expect(mockRefreshAuthState).not.toHaveBeenCalled();
  });

  test('時間切れの作り直しで明細を外したら、入力画面に案内し確認へ進めるままにする', async () => {
    const message = '次の商品はお求めいただけなくなったため、カートから外しました: 非公開のシャツ。内容をご確認のうえ、もう一度「確認へ進む」を押してください。';
    mockApi.requestCheckoutConfirmation
      .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION })
      .mockResolvedValueOnce({ kind: 'error', code: 'cart_updated', message, retryable: true, correlationId: null });
    await openFinalStep();

    await act(async () => { mockFinalProps.onRejected({ code: 'session_expired', message: '時間がたったため、お支払い情報をもう一度入力してください', changedLines: [] }); });

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('checkout:cart-notice')).toBeNull();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
  });

  test('ふつうの確認で明細を外したら、入力画面で商品名を案内して確認へ進めるままにする', async () => {
    const message = '次の商品はお求めいただけなくなったため、カートから外しました: 非公開のシャツ。内容をご確認のうえ、もう一度「確認へ進む」を押してください。';
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'error', code: 'cart_updated', message, retryable: true, correlationId: null });
    render(<CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  test('金額が食い違ったらカートを読み直して案内し、新しい金額で押し直せる', async () => {
    const message = '価格が変わりました。金額をご確認のうえ、もう一度「確認へ進む」を押してください。';
    jest.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => CART } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => CART_REPRICED } as Response);
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
      .mockResolvedValueOnce({ ok: true, json: async () => CART_REPRICED } as Response);
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
      .mockResolvedValueOnce({ ok: true, json: async () => CART_REPRICED } as Response);
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

  // 買えなくなった明細（取り扱い終了・非公開）は、カートの画面に出ないので会員は消せない。サーバーが外して知らせる（409 cart_updated）。
  // Shopify の決済の "Your cart has been updated" と同じく、押せなくせず、外れた後のカートで続けられるようにする
  describe('買えなくなった明細をサーバーがカートから外した（cart_updated）', () => {
    const PANTS_LINE: CartLineSpec = { key: 'cart-2', productId: 2, name: 'ズボン', price: 8000, color: 'NAVY', size: 'L' };
    const CART_WITH_PANTS = cartJsonOf(SHIRT_LINE, PANTS_LINE);
    const message = '次の商品はお求めいただけなくなったため、カートから外しました: ズボン（NAVY / L）。内容をご確認のうえ、もう一度「確認へ進む」を押してください。';
    const cartUpdated = { kind: 'error', code: 'cart_updated', message, retryable: true, correlationId: null };

    test('カートを読み直して案内し、外れた後の金額で「確認へ進む」を押し直せる', async () => {
      jest.mocked(fetch)
        .mockResolvedValueOnce({ ok: true, json: async () => CART_WITH_PANTS } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => CART } as Response);
      mockApi.requestCheckoutConfirmation
        .mockResolvedValueOnce(cartUpdated)
        .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION });
      render(<CheckoutPage />);
      expect(await screen.findByText('ズボン')).toBeInTheDocument();
      expect(screen.getByText('合計').parentElement).toHaveTextContent('¥13,000');
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

      expect(await screen.findByText(message)).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText('ズボン')).toBeNull());
      expect(screen.getByText('合計').parentElement).toHaveTextContent('¥5,000');
      expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(mockRouter.push).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByTestId('final-step');
      expect(mockApi.requestCheckoutConfirmation.mock.calls[1][0].displayedAmounts).toEqual({ subtotalAmount: 5000, taxAmount: 0, shippingAmount: 0, totalAmount: 5000 });
    });

    test('割引適用中なら、カートを読んだ後にコードも確かめ直し、要約の目安を新しくする', async () => {
      jest.mocked(fetch)
        .mockResolvedValueOnce({ ok: true, json: async () => CART_WITH_PANTS } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => CART } as Response);
      mockApi.checkPromotionCodeRequest
        .mockResolvedValueOnce({ kind: 'applied', preview: { code: 'WELCOME10', subtotalAmount: 13000, shippingAmount: 0, discountAmount: 1300, totalAmount: 11700 } })
        .mockImplementationOnce(async () => {
          expect(fetch).toHaveBeenCalledTimes(2);
          return { kind: 'applied', preview: { code: 'WELCOME10', subtotalAmount: 5000, shippingAmount: 0, discountAmount: 500, totalAmount: 4500 } };
        });
      mockApi.requestCheckoutConfirmation.mockResolvedValueOnce(cartUpdated);
      render(<CheckoutPage />);
      fireEvent.change(await screen.findByLabelText('プロモーションコード'), { target: { value: 'WELCOME10' } });
      fireEvent.click(screen.getByRole('button', { name: '適用' }));
      await screen.findByText('WELCOME10');
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

      await screen.findByText(message);
      expect(mockApi.checkPromotionCodeRequest).toHaveBeenCalledTimes(2);
      expect(mockApi.checkPromotionCodeRequest).toHaveBeenLastCalledWith('WELCOME10');
      expect(screen.getByText('小計').parentElement).toHaveTextContent('¥5,000');
      expect(screen.getByText('割引').parentElement).toHaveTextContent('-¥500');
      expect(screen.getByText('合計').parentElement).toHaveTextContent('¥4,500');
      expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
    });

    test('時間切れの作り直しで起きても、カートへは移らず、入力画面でカートを読み直して案内する', async () => {
      mockApi.requestCheckoutConfirmation
        .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION })
        .mockResolvedValueOnce(cartUpdated);
      await openFinalStep();

      await act(async () => { mockFinalProps.onRejected({ code: 'session_expired', message: '時間がたったため、お支払い情報をもう一度入力してください', changedLines: [] }); });

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByTestId('final-step')).toBeNull();
      expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
      expect(mockRouter.push).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  test('cart_updated の案内後も確認へ進め、配送先を変えると案内を消せる', async () => {
    mockSavedAddresses = [SAVED_TOKYO, SAVED_OSAKA];
    const message = '次の商品はお求めいただけなくなったため、カートから外しました: シャツ。内容をご確認のうえ、もう一度「確認へ進む」を押してください。';
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'error', code: 'cart_updated', message, retryable: true, correlationId: null });
    render(<CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: '確認へ進む' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();

    fireEvent.click(screen.getByRole('combobox', { name: '保存済みの配送先' }));
    fireEvent.click(await screen.findByRole('option', { name: '新規' }));
    fireEvent.change(await screen.findByLabelText(/郵便番号/), { target: { value: '6008001' } });
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();

    fireEvent.click(screen.getByRole('combobox', { name: '保存済みの配送先' }));
    fireEvent.click(await screen.findByRole('option', { name: /大阪府/ }));
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
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

  test('受け付けでログインの状態が変わったと断られたら、入力画面に戻って案内を出し、ログインの状態とカートを読み直して、押し直せる', async () => {
    const message = 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。';
    mockApi.requestCheckoutConfirmation.mockResolvedValue({ kind: 'confirmation', confirmation: CONFIRMATION });
    await openFinalStep();
    expect(cartFetchCount()).toBe(1);

    await act(async () => {
      mockFinalProps.onRejected({ code: 'login_changed', message, changedLines: [] });
    });

    expect(screen.queryByTestId('final-step')).toBeNull();
    expect(screen.getByTestId('checkout-session-error')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
    expect(mockRefreshAuthState).toHaveBeenCalledTimes(1);
    // ログインが変わるとカートも変わりうる。状態を読み直した後に、カートも読み直す
    expect(cartFetchCount()).toBe(2);
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
  ])('「確認へ進む」が %s で返ったら、入力画面のまま案内を出し、ログインの状態とカートを読み直して、押し直せる', async (code, message) => {
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
    await waitFor(() => expect(cartFetchCount()).toBe(2));
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

  test('ログインの印の更新が一時的にできなかった（auth_unavailable）時は、ゲストの形に落とさず、ログインの状態もカートも読み直さずに、押し直せる', async () => {
    const message = '決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。';
    mockApi.requestCheckoutConfirmation
      .mockResolvedValueOnce({ kind: 'error', code: 'auth_unavailable', message, retryable: true, correlationId: null })
      .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION });
    render(<CheckoutPage />);
    await screen.findByRole('button', { name: '確認へ進む' });
    await settle();
    const profileReads = mockClientFetchUrls.filter((url) => url === '/api/profile').length;

    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    await settle();
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
    expect(mockRefreshAuthState).not.toHaveBeenCalled();
    expect(cartFetchCount()).toBe(1);
    expect(mockClientFetchUrls.filter((url) => url === '/api/profile')).toHaveLength(profileReads);
    // 押し直せる（会員の入力もそのまま送られる）
    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
    await screen.findByTestId('final-step');
    expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(2);
  });

  // 設計書第6章・C7: ログインの状態が変わったら、入力画面をその会員の内容で読み直す（前の人の入力を残さない）
  describe('ログインの状態が変わった時の入力欄（グループ C・C7）', () => {
    // ゲストとして開いて9項目を入れ、「確認へ進む」で最終確認画面まで進む。サーバーの答えはまだゲスト（プロフィールは 401）
    async function openFinalStepAsGuest() {
      mockIsLoggedIn = false;
      mockProfileStatus = 401;
      echoDraft();
      render(<CheckoutPage />);
      await typeGuestShipping();
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByTestId('final-step');
    }

    // 別のタブで会員 B としてログインした。サーバーは B の内容で答え、画面は状態を読み直した時に会員になる
    function loginAsMemberBElsewhere() {
      mockProfileStatus = 200;
      mockProfileBody = MEMBER_B;
      mockSavedAddresses = [MEMBER_B_ADDRESS];
      mockRefreshAuthState.mockImplementation(async () => {
        mockIsLoggedIn = true;
      });
    }

    const lastShippingSent = () => {
      const calls = mockApi.requestCheckoutConfirmation.mock.calls;
      return calls[calls.length - 1][0].shipping;
    };

    test('ゲストの入力の後に会員になり「注文する」が断られたら、入力欄が会員のプロフィールと保存済みの配送先に置き換わる', async () => {
      await openFinalStepAsGuest();
      loginAsMemberBElsewhere();

      await act(async () => {
        mockFinalProps.onRejected({ code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, changedLines: [] });
      });

      // ゲストの入力は残らず、会員のメールが読み取りで出る。案内も残る
      expect(await screen.findByText('b@example.com')).toBeInTheDocument();
      expect(screen.queryByDisplayValue(GUEST_INPUT.email)).toBeNull();
      expect(screen.queryByDisplayValue(GUEST_INPUT.fullName)).toBeNull();
      expect(screen.getByTestId('checkout-session-error')).toHaveTextContent(LOGIN_CHANGED_MESSAGE);
      expect(mockRefreshAuthState).toHaveBeenCalledTimes(1);
      // プロフィールを読むのは、開いた時の1回と置き換えの1回だけ（ログインの状態の更新と読み直しの合図は同じ描画にまとまり、二重に読まない）
      expect(mockClientFetchUrls.filter((url) => url === '/api/profile')).toHaveLength(2);
      // 押し直すと、会員の内容（9項目）で送られる。ゲストの建物名も残らない
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await waitFor(() => expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(2));
      expect(lastShippingSent()).toEqual(MEMBER_B_SHIPPING);
    });

    test('会員 A から会員 B に変わって断られたら、A の入力を残さず B の内容に置き換わる。B のプロフィールが空の欄は空になる', async () => {
      // A の建物名は下書きに入り、入力欄に残る。B のプロフィールの建物名は空
      mockProfileBody = { ...PROFILE, address: { ...PROFILE.address, building: '101号室' } };
      mockSavedAddresses = [SAVED_TOKYO];
      echoDraft();
      await openFinalStep();
      mockProfileBody = MEMBER_B;
      mockSavedAddresses = [MEMBER_B_ADDRESS];

      await act(async () => {
        mockFinalProps.onRejected({ code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, changedLines: [] });
      });

      expect(await screen.findByText('b@example.com')).toBeInTheDocument();
      expect(screen.queryByText('a@example.com')).toBeNull();
      expect(screen.getByRole('combobox', { name: '保存済みの配送先' })).toHaveTextContent('〒530-0001');
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await waitFor(() => expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(2));
      expect(lastShippingSent()).toEqual(MEMBER_B_SHIPPING);
    });

    test('会員 B の保存済みの配送先が取れなかった時は、会員 A の保存済みの配送先を選択肢に残さない', async () => {
      mockSavedAddresses = [SAVED_TOKYO];
      mockApi.requestCheckoutConfirmation.mockResolvedValueOnce({
        kind: 'error', code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, retryable: true, correlationId: null,
      });
      render(<CheckoutPage />);
      expect(await screen.findByRole('combobox', { name: '保存済みの配送先' })).toHaveTextContent('〒150-0001');
      // B のプロフィールは取れるが、住所帳は取れない
      mockProfileBody = MEMBER_B;
      mockSavedAddresses = null;

      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

      expect(await screen.findByText('b@example.com')).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: '保存済みの配送先' })).toBeNull();
      expect(screen.queryByText(/150-0001/)).toBeNull();
      // 保存済みの配送先が無いので、B のプロフィールの住所が入力欄に出る
      expect(screen.getByLabelText(/郵便番号/)).toHaveValue('530-0001');
    });

    test('お客様情報を編集している途中でログインが変わったら、編集を閉じて新しい会員の内容を出す（「キャンセル」で前の人の氏名に戻らない）', async () => {
      mockApi.requestCheckoutConfirmation.mockResolvedValueOnce({
        kind: 'error', code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, retryable: true, correlationId: null,
      });
      render(<CheckoutPage />);
      fireEvent.click(await screen.findByRole('button', { name: '変更する' }));
      expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument();
      mockProfileBody = MEMBER_B;
      mockSavedAddresses = [MEMBER_B_ADDRESS];

      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

      expect(await screen.findByText('b@example.com')).toBeInTheDocument();
      expect(screen.getByText('佐藤 次郎')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull();
    });

    test('ログインの状態を読み直してもゲストのままなら、今の入力を残し、メールは入力できる形にする', async () => {
      await openFinalStepAsGuest();

      await act(async () => {
        mockFinalProps.onRejected({ code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, changedLines: [] });
      });
      await settle();

      expect(shippingInputs()).toEqual({
        email: GUEST_INPUT.email,
        fullName: GUEST_INPUT.fullName,
        kanaName: GUEST_INPUT.kanaName,
        phone: GUEST_INPUT.phone,
        postalCode: GUEST_INPUT.postalCode,
        city: GUEST_INPUT.city,
        address: GUEST_INPUT.address,
        building: GUEST_INPUT.building,
      });
      expect(screen.getByRole('combobox', { name: /都道府県/ })).toHaveTextContent(GUEST_INPUT.prefecture);
      expect(screen.getByLabelText(/メールアドレス/)).not.toHaveAttribute('readonly');
      expect(screen.getByTestId('checkout-session-error')).toHaveTextContent(LOGIN_CHANGED_MESSAGE);
      expect(mockRefreshAuthState).toHaveBeenCalledTimes(1);
      expect(cartFetchCount()).toBe(2);
    });

    test('「確認へ進む」が login_changed で返り、会員になっていたら、カートを読み直して入力欄を会員の内容に置き換える', async () => {
      mockIsLoggedIn = false;
      mockProfileStatus = 401;
      mockApi.requestCheckoutConfirmation
        .mockResolvedValueOnce({ kind: 'error', code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, retryable: true, correlationId: null })
        .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION });
      render(<CheckoutPage />);
      await typeGuestShipping();
      loginAsMemberBElsewhere();

      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

      expect(await screen.findByText('b@example.com')).toBeInTheDocument();
      expect(screen.queryByDisplayValue(GUEST_INPUT.email)).toBeNull();
      expect(screen.getByTestId('checkout-session-error')).toHaveTextContent(LOGIN_CHANGED_MESSAGE);
      expect(cartFetchCount()).toBe(2);
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByTestId('final-step');
      expect(lastShippingSent()).toEqual(MEMBER_B_SHIPPING);
    });

    test('「確認へ進む」が auth_expired で返り、ゲストになっていたら、カートを読み直し、今の入力を残してメールを入力できる形にする', async () => {
      mockApi.requestCheckoutConfirmation
        .mockResolvedValueOnce({ kind: 'error', code: 'auth_expired', message: LOGIN_EXPIRED_MESSAGE, retryable: true, correlationId: null })
        .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION });
      render(<CheckoutPage />);
      // 会員 A として入力が済んだ状態。印が失効してゲストになる
      expect(await screen.findByText('a@example.com')).toBeInTheDocument();
      mockProfileStatus = 401;
      mockRefreshAuthState.mockImplementation(async () => {
        mockIsLoggedIn = false;
      });

      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

      expect(await screen.findByText(LOGIN_EXPIRED_MESSAGE)).toBeInTheDocument();
      await waitFor(() => expect(cartFetchCount()).toBe(2));
      await waitFor(() => expect(screen.getByLabelText(/メールアドレス/)).toHaveValue('a@example.com'));
      expect(screen.getByLabelText(/メールアドレス/)).not.toHaveAttribute('readonly');
      expect(screen.getByLabelText(/氏名/)).toHaveValue('山田 花子');
    });

    test('画面を開いたまま、ゲストから会員に変わったら（ヘッダーのログインなど）、入力欄を会員の内容に置き換える', async () => {
      mockIsLoggedIn = false;
      mockProfileStatus = 401;
      echoDraft();
      const { rerender } = render(<CheckoutPage />);
      await typeGuestShipping();
      // ログインした（サーバーは B として答え、ログインの状態が false から true に変わる）
      mockProfileStatus = 200;
      mockProfileBody = MEMBER_B;
      mockSavedAddresses = [MEMBER_B_ADDRESS];
      mockIsLoggedIn = true;

      rerender(<CheckoutPage />);

      expect(await screen.findByText('b@example.com')).toBeInTheDocument();
      expect(screen.queryByDisplayValue(GUEST_INPUT.email)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await waitFor(() => expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(1));
      expect(lastShippingSent()).toEqual(MEMBER_B_SHIPPING);
      // 画面のログインの変化を拾っただけで、サーバーに断られたわけではない。状態の読み直しもカートの読み直しもしない
      expect(mockRefreshAuthState).not.toHaveBeenCalled();
      expect(cartFetchCount()).toBe(1);
    });

    test.each([
      ['同じメール', 'b@example.com'],
      ['整えると同じメール', ' Ｂ@Example.COM '],
    ])('ゲストが会員と%sを入力してからログインしても、名前・住所を会員の内容へ置き換える', async (_label, guestEmail) => {
      mockIsLoggedIn = false;
      mockProfileStatus = 401;
      echoDraft();
      const { rerender } = render(<CheckoutPage />);
      await typeGuestShipping();
      fireEvent.change(screen.getByLabelText(/メールアドレス/), { target: { value: guestEmail } });
      mockProfileStatus = 200;
      mockProfileBody = MEMBER_B;
      mockSavedAddresses = [MEMBER_B_ADDRESS];
      mockIsLoggedIn = true;

      rerender(<CheckoutPage />);

      expect(await screen.findByText(MEMBER_B.fullName)).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: '保存済みの配送先' })).toHaveTextContent('〒530-0001');
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await waitFor(() => expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(1));
      expect(lastShippingSent()).toEqual(MEMBER_B_SHIPPING);
    });

    test('会員からゲストを経て同じ会員に戻っても、ゲストの入力を会員の内容へ置き換える', async () => {
      echoDraft();
      const { rerender } = render(<CheckoutPage />);
      expect(await screen.findByText(PROFILE.fullName)).toBeInTheDocument();
      mockIsLoggedIn = false;
      rerender(<CheckoutPage />);
      fireEvent.change(screen.getByLabelText(/氏名/), { target: { value: GUEST_INPUT.fullName } });
      mockIsLoggedIn = true;

      rerender(<CheckoutPage />);

      expect(await screen.findByText(PROFILE.fullName)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await waitFor(() => expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(1));
      expect(lastShippingSent().fullName).toBe(PROFILE.fullName);
    });

    test('置き換えで会員の内容を入れた後も、同じ会員の読み直しでは直した入力を消さない', async () => {
      mockIsLoggedIn = false;
      mockProfileStatus = 401;
      const { rerender } = render(<CheckoutPage />);
      await typeGuestShipping();
      mockProfileStatus = 200;
      mockProfileBody = MEMBER_B;
      mockSavedAddresses = [MEMBER_B_ADDRESS];
      mockIsLoggedIn = true;
      rerender(<CheckoutPage />);
      fireEvent.click(await screen.findByRole('button', { name: '変更する' }));
      fireEvent.change(screen.getByLabelText(/電話番号/), { target: { value: '09099998888' } });
      mockApi.requestCheckoutConfirmation.mockResolvedValueOnce({
        kind: 'error', code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, retryable: true, correlationId: null,
      });

      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

      expect(await screen.findByText(LOGIN_CHANGED_MESSAGE)).toBeInTheDocument();
      await settle();
      expect(screen.getByLabelText(/電話番号/)).toHaveValue('090-9999-8888');
      expect(screen.getByRole('combobox', { name: '保存済みの配送先' })).toHaveTextContent('〒530-0001');
    });

    test('開いた時のログインの確認（まだ確かめていない状態から会員）では、開いた時の読み込みだけで置き換えず、お客様の入力を消さない', async () => {
      mockIsLoggedIn = false;
      mockIsAuthResolved = false;
      const { rerender } = render(<CheckoutPage />);
      // 開いた時の読み込みで会員 A の内容が入り、お客様が電話番号を直す
      await waitFor(() => expect(screen.getByLabelText(/氏名/)).toHaveValue('山田 花子'));
      fireEvent.change(screen.getByLabelText(/電話番号/), { target: { value: '09099998888' } });
      mockIsLoggedIn = true;
      mockIsAuthResolved = true;

      rerender(<CheckoutPage />);
      await settle();

      expect(screen.getByText('090-9999-8888')).toBeInTheDocument();
      expect(mockClientFetchUrls.filter((url) => url === '/api/profile')).toHaveLength(1);
      expect(mockClientFetchUrls.filter((url) => url === '/api/profile/addresses')).toHaveLength(1);
    });

    test.each([
      ['auth_expired', LOGIN_EXPIRED_MESSAGE],
      ['login_changed', LOGIN_CHANGED_MESSAGE],
    ])('時間切れの作り直しが %s で返ったら、入力画面に戻って案内を出し、自動で送り直さず、押し直せる', async (code, message) => {
      mockApi.requestCheckoutConfirmation
        .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION })
        .mockResolvedValueOnce({ kind: 'error', code, message, retryable: true, correlationId: null })
        .mockResolvedValueOnce({ kind: 'confirmation', confirmation: { ...CONFIRMATION, checkoutSessionId: 'cs_test_2' } });
      await openFinalStep();

      await act(async () => {
        mockFinalProps.onRejected({ code: 'session_expired', message: '時間がたったため、お支払い情報をもう一度入力してください', changedLines: [] });
      });

      expect(screen.queryByTestId('final-step')).toBeNull();
      expect(screen.getByTestId('checkout-session-error')).toHaveTextContent(message);
      expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
      expect(mockRefreshAuthState).toHaveBeenCalledTimes(1);
      expect(cartFetchCount()).toBe(2);
      // 自動で送り直さない（作り直しの1回だけ）。お客様が押し直したときだけ、もう一度送る
      expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByTestId('final-step');
      expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(3);
    });

    // ログインは決済の流れの印（session_id）を新しくするので、ゲストで「確認へ進む」の後にログインして「注文する」を押すと、
    // サーバーは 403 で断る（設計書 4-3）。checkout-api がこれを login_changed の断りに読み替えるので、画面は同じ扱いになる。
    // ログインでゲストのカートは会員のカートへ合わさる（設計書第5章）ので、読み直すカートにはゲストで入れた商品がある
    test('ログインでカートの印が新しくなって断られた（403 を読み替えた login_changed）時も、入力画面に戻して案内を出し、合わせた後のカートと会員の内容を読み直す', async () => {
      await openFinalStepAsGuest();
      loginAsMemberBElsewhere();
      // ゲストで入れた商品（パンツ）が、会員のカートに合わさって入っている
      const mergedCart = cartJsonOf(SHIRT_LINE, { key: 'cart-2', productId: 2, name: 'ゲストで入れたパンツ', price: 8000, color: 'NAVY', size: 'L' });
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => mergedCart });

      await act(async () => {
        mockFinalProps.onRejected({ code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, changedLines: [] });
      });

      expect(screen.queryByTestId('final-step')).toBeNull();
      expect(screen.getByTestId('checkout-session-error')).toHaveTextContent(LOGIN_CHANGED_MESSAGE);
      expect(screen.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
      expect(mockRefreshAuthState).toHaveBeenCalledTimes(1);
      expect(cartFetchCount()).toBe(2);
      expect(await screen.findByText('ゲストで入れたパンツ')).toBeInTheDocument();
      expect(screen.queryByText('カートに商品がありません')).toBeNull();
      expect(await screen.findByText('b@example.com')).toBeInTheDocument();
      expect(screen.queryByDisplayValue(GUEST_INPUT.email)).toBeNull();
      expect(mockRouter.replace).toHaveBeenLastCalledWith('/checkout');
      expect(mockRouter.push).not.toHaveBeenCalled();
      // 自動で送り直さない
      expect(mockApi.requestCheckoutConfirmation).toHaveBeenCalledTimes(1);
    });

    // 置き換え（"replace"）で、会員のプロフィールが 401 以外（500・503・通信の失敗）で取れなかった時。
    // 入力欄は残すが、前の会員の住所帳・選択・保存のチェック・保存の失敗の文は、別の会員の画面に混ぜない
    describe('置き換えでプロフィールが取れなかった時（401 以外）', () => {
      const loginChangedError = {
        kind: 'error', code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, retryable: true, correlationId: null,
      };
      // 通信の失敗は、画面が console.error に残す。この中の試験では出力を抑える
      let consoleError: jest.SpyInstance;
      beforeEach(() => {
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      });
      afterEach(() => {
        consoleError.mockRestore();
      });

      test.each([
        ['500', 500],
        ['503', 503],
        ['通信の失敗', 0],
      ])('プロフィールが %s で取れなくても、前の会員の保存済みの配送先の一覧と選択を外し、入力欄は残す', async (_label, status) => {
        mockSavedAddresses = [SAVED_TOKYO, SAVED_OSAKA];
        mockApi.requestCheckoutConfirmation.mockResolvedValueOnce(loginChangedError);
        render(<CheckoutPage />);
        expect(await screen.findByRole('combobox', { name: '保存済みの配送先' })).toHaveTextContent('〒150-0001');
        // 別の会員に変わった。プロフィールも住所帳も取れない
        mockProfileStatus = status;
        mockSavedAddresses = null;

        fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

        expect(await screen.findByText(LOGIN_CHANGED_MESSAGE)).toBeInTheDocument();
        await settle();
        expect(screen.queryByRole('combobox', { name: '保存済みの配送先' })).toBeNull();
        // 入力欄は前の内容のまま（保存済みの配送先を選んでいた形ではなく、入力欄として出る）
        expect(screen.getByLabelText(/郵便番号/)).toHaveValue('150-0001');
        expect(screen.getByLabelText(/番地/)).toHaveValue('神宮前1-1-1');
        expect(screen.getByText('山田 花子')).toBeInTheDocument();
      });

      test('「この配送先を保存する」のチェックを外す（前の会員が付けた保存を、別の会員に引き継がない）', async () => {
        mockApi.requestCheckoutConfirmation.mockResolvedValueOnce(loginChangedError);
        render(<CheckoutPage />);
        fireEvent.click(await screen.findByRole('checkbox', { name: 'この配送先を保存する' }));
        expect(screen.getByRole('checkbox', { name: 'この配送先を保存する' })).toBeChecked();
        mockProfileStatus = 500;

        fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

        expect(await screen.findByText(LOGIN_CHANGED_MESSAGE)).toBeInTheDocument();
        await settle();
        expect(screen.getByRole('checkbox', { name: 'この配送先を保存する' })).not.toBeChecked();
      });

      test('お客様情報の保存の失敗の文を消す', async () => {
        const saveFailed = 'お客様情報の保存に失敗しました。再度お試しください。';
        mockApi.requestCheckoutConfirmation.mockResolvedValueOnce(loginChangedError);
        render(<CheckoutPage />);
        fireEvent.click(await screen.findByRole('button', { name: '変更する' }));
        mockWriteStatus = 500;
        fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));
        expect(await screen.findByText(saveFailed)).toBeInTheDocument();
        mockWriteStatus = 200;
        mockProfileStatus = 503;

        fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

        expect(await screen.findByText(LOGIN_CHANGED_MESSAGE)).toBeInTheDocument();
        await settle();
        expect(screen.queryByText(saveFailed)).toBeNull();
      });
    });

    // 置き換えは、最後に始めた読み込みだけを当てる。古い読み込みが遅れて届いても、新しい内容を上書きしない
    test('読み直しが重なったら、新しく始めた読み込みだけを当てる（遅れて届いた古い読み込みで上書きしない）', async () => {
      mockIsLoggedIn = false;
      mockProfileStatus = 401;
      mockApi.requestCheckoutConfirmation.mockResolvedValue({
        kind: 'error', code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, retryable: true, correlationId: null,
      });
      render(<CheckoutPage />);
      await typeGuestShipping();
      // 会員に変わった。1回目の読み直し（B）は遅れて届き、2回目（C）は先に届く
      const slowB = createDeferred();
      mockProfileStatus = 200;
      mockSavedAddresses = [MEMBER_B_ADDRESS];
      mockProfileQueue.push({ body: MEMBER_B, gate: slowB.promise }, { body: MEMBER_C });
      mockRefreshAuthState.mockImplementation(async () => {
        mockIsLoggedIn = true;
      });

      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByText(LOGIN_CHANGED_MESSAGE);
      await waitFor(() => expect(mockProfileQueue).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

      expect(await screen.findByText('c@example.com')).toBeInTheDocument();
      await act(async () => {
        slowB.resolve();
      });
      await settle();
      expect(screen.getByText('c@example.com')).toBeInTheDocument();
      expect(screen.getByText('鈴木 三郎')).toBeInTheDocument();
      expect(screen.queryByText('b@example.com')).toBeNull();
      expect(screen.queryByText('佐藤 次郎')).toBeNull();
    });

    test('会員の内容を読み込んでいる間に、読み直した結果がゲストと分かったら、遅れて届いた会員の内容で入力欄を置き換えない', async () => {
      mockIsLoggedIn = false;
      mockProfileStatus = 401;
      mockApi.requestCheckoutConfirmation.mockResolvedValue({
        kind: 'error', code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, retryable: true, correlationId: null,
      });
      render(<CheckoutPage />);
      await typeGuestShipping();
      // 1回目の読み直しでは会員 B と分かり、プロフィールの読み込みが遅れる
      const slowB = createDeferred();
      mockProfileStatus = 200;
      mockSavedAddresses = [MEMBER_B_ADDRESS];
      mockProfileQueue.push({ body: MEMBER_B, gate: slowB.promise });
      mockRefreshAuthState.mockImplementation(async () => {
        mockIsLoggedIn = true;
      });
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByText(LOGIN_CHANGED_MESSAGE);
      await waitFor(() => expect(mockProfileQueue).toHaveLength(0));

      // B はログアウトした。2回目の読み直しの結果はゲスト
      mockRefreshAuthState.mockImplementation(async () => {
        mockIsLoggedIn = false;
      });
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await waitFor(() => expect(mockRefreshAuthState).toHaveBeenCalledTimes(2));
      await settle();
      await act(async () => {
        slowB.resolve();
      });
      await settle();

      expect(screen.queryByText('b@example.com')).toBeNull();
      expect(screen.queryByText('佐藤 次郎')).toBeNull();
      expect(shippingInputs()).toMatchObject({ email: GUEST_INPUT.email, fullName: GUEST_INPUT.fullName });
      expect(screen.getByLabelText(/メールアドレス/)).not.toHaveAttribute('readonly');
    });

    test('読み込みの間に最終確認画面へ進んだら（確認の内容を取り込んだら）、遅れて届いた読み込みで入力欄を置き換えない', async () => {
      mockIsLoggedIn = false;
      mockProfileStatus = 401;
      render(<CheckoutPage />);
      await typeGuestShipping();
      // 会員 B に変わった。読み直しは遅れて届く
      const slowB = createDeferred();
      mockProfileStatus = 200;
      mockSavedAddresses = [MEMBER_B_ADDRESS];
      mockProfileQueue.push({ body: MEMBER_B, gate: slowB.promise });
      mockRefreshAuthState.mockImplementation(async () => {
        mockIsLoggedIn = true;
      });
      echoDraft();
      mockApi.requestCheckoutConfirmation.mockResolvedValueOnce({
        kind: 'error', code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, retryable: true, correlationId: null,
      });
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByText(LOGIN_CHANGED_MESSAGE);
      await waitFor(() => expect(mockProfileQueue).toHaveLength(0));

      // 読み直しが届く前に、もう一度「確認へ進む」を押して最終確認画面へ進んだ（下書きの内容を取り込んだ）
      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
      await screen.findByTestId('final-step');
      await act(async () => {
        slowB.resolve();
      });
      await settle();

      // 「変更」で入力画面へ戻ると、取り込んだ下書きの内容のまま。遅れて届いた B の内容で置き換わっていない
      await act(async () => {
        mockFinalProps.onEdit();
      });
      expect(screen.getByText(GUEST_INPUT.fullName)).toBeInTheDocument();
      expect(screen.queryByText('佐藤 次郎')).toBeNull();
    });

    // プロフィールから入力した同じ会員のままなら置き換えない（ゲストの入力と区別する）。
    // その会員が直した入力と、読み込み済みの保存済みの配送先を消さない
    test.each([
      ['同じメール', 'a@example.com'],
      ['大文字・前後の空白だけが違うメール', ' A@Example.COM '],
    ])('読み直したプロフィールが今の入力欄と同じ会員（%s）なら、置き換えず、その会員が直した入力を消さない', async (_label, reloadedEmail) => {
      mockSavedAddresses = [SAVED_TOKYO];
      mockApi.requestCheckoutConfirmation.mockResolvedValueOnce({
        kind: 'error', code: 'login_changed', message: LOGIN_CHANGED_MESSAGE, retryable: true, correlationId: null,
      });
      render(<CheckoutPage />);
      fireEvent.click(await screen.findByRole('button', { name: '変更する' }));
      fireEvent.change(screen.getByLabelText(/電話番号/), { target: { value: '09099998888' } });
      // 読み直したプロフィールの電話番号は元のまま。置き換われば、直した電話番号が消える
      mockProfileBody = { ...PROFILE, email: reloadedEmail };
      const profileReads = mockClientFetchUrls.filter((url) => url === '/api/profile').length;

      fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

      expect(await screen.findByText(LOGIN_CHANGED_MESSAGE)).toBeInTheDocument();
      await waitFor(() => expect(mockClientFetchUrls.filter((url) => url === '/api/profile')).toHaveLength(profileReads + 1));
      await settle();
      expect(screen.getByLabelText(/電話番号/)).toHaveValue('090-9999-8888');
      expect(screen.getByRole('combobox', { name: '保存済みの配送先' })).toHaveTextContent('〒150-0001');
    });

    // 会員からゲストに変わった（読み直した結果がゲスト）。入力は残し、前の会員の住所帳は外す
    describe('会員からゲストに変わった時', () => {
      const authExpiredError = {
        kind: 'error', code: 'auth_expired', message: LOGIN_EXPIRED_MESSAGE, retryable: true, correlationId: null,
      };

      function becomeGuestElsewhere() {
        mockProfileStatus = 401;
        mockSavedAddresses = null;
        mockRefreshAuthState.mockImplementation(async () => {
          mockIsLoggedIn = false;
        });
      }

      test('前の会員の保存済みの配送先の一覧と選択を外し、入力は残す', async () => {
        mockSavedAddresses = [SAVED_TOKYO, SAVED_OSAKA];
        mockApi.requestCheckoutConfirmation.mockResolvedValueOnce(authExpiredError);
        render(<CheckoutPage />);
        expect(await screen.findByRole('combobox', { name: '保存済みの配送先' })).toHaveTextContent('〒150-0001');
        becomeGuestElsewhere();

        fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

        expect(await screen.findByText(LOGIN_EXPIRED_MESSAGE)).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole('combobox', { name: '保存済みの配送先' })).toBeNull());
        // 入力は残り、ゲストとして直せる形で出る
        expect(shippingInputs()).toEqual({
          email: 'a@example.com',
          fullName: '山田 花子',
          kanaName: 'ヤマダ ハナコ',
          phone: '03-1111-2222',
          postalCode: '150-0001',
          city: '渋谷区',
          address: '神宮前1-1-1',
          building: '',
        });
        expect(screen.getByLabelText(/メールアドレス/)).not.toHaveAttribute('readonly');
      });

      test('「この配送先を保存する」のチェックも外し、押し直してもゲストにプロフィールの保存を試みさせない', async () => {
        mockApi.requestCheckoutConfirmation
          .mockResolvedValueOnce(authExpiredError)
          .mockResolvedValueOnce({ kind: 'confirmation', confirmation: CONFIRMATION });
        render(<CheckoutPage />);
        fireEvent.click(await screen.findByRole('checkbox', { name: 'この配送先を保存する' }));
        becomeGuestElsewhere();

        fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));

        expect(await screen.findByText(LOGIN_EXPIRED_MESSAGE)).toBeInTheDocument();
        await settle();
        // 会員の間に押した時の保存の通信は済んでいる。ここから先の通信だけを見る
        mockClientFetchWrites.length = 0;
        fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
        await screen.findByTestId('final-step');
        expect(mockClientFetchWrites).toEqual([]);
      });
    });
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
