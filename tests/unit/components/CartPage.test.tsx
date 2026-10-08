import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CartPage from '@/app/cart/page';
import { CART_OPTION_NAMES, type CartJson, type CartJsonLine } from '@/features/cart/types/cart-json';

// mock next/link and next/image to simplify tests
jest.mock('next/link', () => {
  return ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});
jest.mock('next/image', () => {
  return ({ src, alt, ...props }: any) => React.createElement('img', { src, alt, ...props });
});

// stub useCart hook so the component renders without context issues
const mockUpdateCartCount = jest.fn();
jest.mock('@/contexts/CartContext', () => {
  return {
    useCart: () => ({
      updateCartCount: mockUpdateCartCount,
      wishlistedItems: new Set<number>(),
      toggleWishlist: jest.fn(),
    }),
  };
});

type LineSpec = {
  key: string;
  productId: number;
  name: string;
  price: number;
  quantity?: number;
  color?: string;
  size?: string;
  fulfillment?: CartJsonLine['fulfillment'];
};

// カートの窓口（GET /api/cart・POST /api/cart/change）の応答の作り方。
// 明細は Shopify の形で、色・サイズは options_with_values に入る（画面が toCartEntries で今の形に直す）
function cartJson(...specs: LineSpec[]): CartJson {
  const items = specs.map((spec): CartJsonLine => {
    const quantity = spec.quantity ?? 1;
    const variantTitle = [spec.color, spec.size].filter(Boolean).join(' / ') || null;
    return {
      key: spec.key,
      id: spec.productId * 100,
      variant_id: spec.productId * 100,
      product_id: spec.productId,
      quantity,
      title: variantTitle ? `${spec.name} - ${variantTitle}` : spec.name,
      product_title: spec.name,
      variant_title: variantTitle,
      options_with_values: [
        ...(spec.color ? [{ name: CART_OPTION_NAMES.color, value: spec.color }] : []),
        ...(spec.size ? [{ name: CART_OPTION_NAMES.size, value: spec.size }] : []),
      ],
      price: spec.price,
      line_price: spec.price * quantity,
      image: '/x.png',
      url: `/item/${spec.productId}`,
      fulfillment: spec.fulfillment ?? null,
    };
  });
  const subtotal = items.reduce((sum, line) => sum + line.line_price, 0);
  return {
    item_count: items.reduce((sum, line) => sum + line.quantity, 0),
    currency: 'JPY',
    items_subtotal_price: subtotal,
    total_price: subtotal,
    items,
  };
}

// 画面が読む応答（ok と json だけ持つ最小の Response）
const okJson = (body: unknown) => ({ ok: true, json: async () => body });
// 窓口の断り（Shopify の Ajax Cart API と同じ形）
const cartError = (status: number, description: string) => ({
  ok: false,
  status,
  json: async () => ({ status, message: 'Cart Error', description }),
});

const TEST_ITEM: LineSpec = { key: '1', productId: 1, name: 'Test item', price: 100 };
const SHIRT: LineSpec = { key: '1', productId: 1, name: 'シャツ', price: 5000, color: 'BLACK', size: 'M', fulfillment: 'stock' };
const PANTS: LineSpec = { key: '2', productId: 2, name: 'パンツ', price: 8000, quantity: 2, color: 'NAVY', size: 'L', fulfillment: 'backorder' };

describe('CartPage', () => {
  beforeEach(() => {
    // reset fetch mock
    (global as any).fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('明細が1つも無いカート（取り扱いが終わった商品の明細はサーバーが返さない）は、空のカートを表示する', async () => {
    (global as any).fetch.mockResolvedValueOnce(okJson(cartJson()));

    render(<CartPage />);

    // wait for loading to finish and EmptyCart to appear
    await waitFor(() => {
      expect(screen.getByText(/YOUR CART IS EMPTY/i)).toBeInTheDocument();
    });
  });

  it('optimistically updates quantity and debounces server call', async () => {
    // use real timers to avoid complexity with jest fake timers and waitFor
    let resolveFirst: (value?: any) => void = () => {};
    const firstPromise = new Promise((res) => {
      resolveFirst = res;
    });
    let resolveSecond: (value?: any) => void = () => {};
    const secondPromise = new Promise((res) => {
      resolveSecond = res;
    });

    // initial GET followed by two POSTs (/api/cart/change) with manual control
    (global as any).fetch
      .mockResolvedValueOnce(okJson(cartJson(TEST_ITEM)))
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise);

    render(<CartPage />);
    await waitFor(() => screen.getByText('Test item'));

    const inc = screen.getByLabelText('increase');
    // perform one click to 2, wait for timer to fire (simulate 500ms)
    await userEvent.click(inc);
    await new Promise((r) => setTimeout(r, 500));

    // at this point first POST should be pending
    expect(fetch).toHaveBeenCalledTimes(2);

    // click again while first request is still in flight
    await userEvent.click(inc);
    await userEvent.click(inc);

    // quantity should continue updating locally
    expect(screen.getByDisplayValue('4')).toBeInTheDocument();

    // now resolve first request
    resolveFirst(okJson(cartJson({ ...TEST_ITEM, quantity: 2 })));
    // allow microtasks to run and scheduling logic to execute
    await Promise.resolve();

    // wait for second POST to be issued (may happen after debounce)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const calls = (fetch as unknown as jest.Mock).mock.calls;
    expect(calls[1][0]).toBe('/api/cart/change');
    expect(JSON.parse(calls[1][1].body)).toEqual({ id: '1', quantity: 2 });
    expect(calls[2][0]).toBe('/api/cart/change');
    expect(calls[2][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(calls[2][1].body)).toEqual({ id: '1', quantity: 4 });

    // clean up second promise resolution
    resolveSecond(okJson(cartJson({ ...TEST_ITEM, quantity: 4 })));
  });

  it('数量の変更が断られたら、確定値へロールバックして窓口の description と再試行UIを表示する', async () => {
    (global as any).fetch
      .mockResolvedValueOnce(okJson(cartJson(TEST_ITEM)))
      .mockResolvedValueOnce(cartError(422, '1つの商品は20個までです。'));

    render(<CartPage />);
    await waitFor(() => screen.getByText('Test item'));

    const inc = screen.getByLabelText('increase');
    await userEvent.click(inc);

    await new Promise((r) => setTimeout(r, 550));

    await waitFor(() => {
      expect(screen.getByDisplayValue('1')).toBeInTheDocument();
      expect(screen.getByText('1つの商品は20個までです。')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '再試行' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: '最新状態を再取得' }).length).toBeGreaterThan(0);
    });
  });

  it('数量の変更の応答（CartJson）の数量とお届けの目安が、その明細に出る', async () => {
    (global as any).fetch
      .mockResolvedValueOnce(okJson(cartJson(SHIRT)))
      // 画面は 2 にするが、画面が確定値として採るのは応答の明細の数量とお届けの目安
      .mockResolvedValueOnce(okJson(cartJson({ ...SHIRT, quantity: 3, fulfillment: 'backorder' })));

    render(<CartPage />);
    expect(await screen.findByTestId('cart-fulfillment')).toHaveTextContent('在庫あり・3〜7営業日で発送');

    await userEvent.click(screen.getByLabelText('increase'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('3')).toBeInTheDocument();
      expect(screen.getByTestId('cart-fulfillment')).toHaveTextContent('受注生産・数週間〜2か月以上');
    });
    const [endpoint, init] = (fetch as unknown as jest.Mock).mock.calls[1];
    expect(endpoint).toBe('/api/cart/change');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(init.body)).toEqual({ id: '1', quantity: 2 });
    expect(mockUpdateCartCount).toHaveBeenCalled();
  });

  it('削除は同じ窓口に数量0を送り、その明細を画面から外してヘッダーの数を読み直す', async () => {
    (global as any).fetch
      .mockResolvedValueOnce(okJson(cartJson(SHIRT, PANTS)))
      .mockResolvedValueOnce(okJson(cartJson(PANTS)));

    render(<CartPage />);
    await screen.findByText('シャツ');

    await userEvent.click(screen.getAllByRole('button', { name: 'カートから削除' })[0]);

    await waitFor(() => expect(screen.queryByText('シャツ')).toBeNull());
    expect(screen.getByText('パンツ')).toBeInTheDocument();
    const [endpoint, init] = (fetch as unknown as jest.Mock).mock.calls[1];
    expect(endpoint).toBe('/api/cart/change');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(init.body)).toEqual({ id: '1', quantity: 0 });
    expect(mockUpdateCartCount).toHaveBeenCalled();
  });

  it('削除が断られたら、窓口の description をトーストで出して、明細は残す', async () => {
    (global as any).fetch
      .mockResolvedValueOnce(okJson(cartJson(SHIRT)))
      .mockResolvedValueOnce(cartError(404, 'カートの商品が見つかりません。ページを読み込み直してください。'));

    render(<CartPage />);
    await screen.findByText('シャツ');

    await userEvent.click(screen.getByRole('button', { name: 'カートから削除' }));

    expect(await screen.findByTestId('cart-action-toast')).toHaveTextContent(
      'カートの商品が見つかりません。ページを読み込み直してください。',
    );
    expect(screen.getByText('シャツ')).toBeInTheDocument();
    expect(mockUpdateCartCount).not.toHaveBeenCalled();
  });

  it('明細ごとにお届けの目安を出す（設計書 5-2）', async () => {
    (global as any).fetch.mockResolvedValueOnce(okJson(cartJson(SHIRT, PANTS)));

    render(<CartPage />);

    const labels = await screen.findAllByTestId('cart-fulfillment');
    expect(labels.map((label) => label.textContent)).toEqual(['在庫あり・3〜7営業日で発送', '受注生産・数週間〜2か月以上']);
  });

  it('受け付けで在庫の変化を断られた後は、案内と変わった商品を出し、その行に印を付ける（設計書 5-3）', async () => {
    window.sessionStorage.setItem(
      'checkout:cart-notice',
      JSON.stringify({
        kind: 'stock_changed',
        message: '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）',
        lines: [{ itemId: 2, name: 'パンツ', color: 'NAVY', size: 'L' }],
      }),
    );
    (global as any).fetch.mockResolvedValueOnce(okJson(cartJson(SHIRT, PANTS)));

    render(<CartPage />);

    const notice = await screen.findByTestId('cart-notice');
    await waitFor(() =>
      expect(notice).toHaveTextContent('在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）'),
    );
    expect(notice).toHaveTextContent('パンツ（NAVY / L）');
    const marks = await screen.findAllByTestId('cart-stock-changed');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('在庫あり → 受注生産');
    expect(window.sessionStorage.getItem('checkout:cart-notice')).toBeNull();
  });

  it('カートが空でも、保存された案内があれば出す（設計書 5-3）', async () => {
    window.sessionStorage.setItem(
      'checkout:cart-notice',
      JSON.stringify({ kind: 'message', message: '商品の価格が変わりました。内容をご確認ください' }),
    );
    (global as any).fetch.mockResolvedValueOnce(okJson(cartJson()));

    render(<CartPage />);

    await waitFor(() => expect(screen.getByText(/YOUR CART IS EMPTY/i)).toBeInTheDocument());
    const notice = await screen.findByTestId('cart-notice');
    await waitFor(() => expect(notice).toHaveTextContent('商品の価格が変わりました。内容をご確認ください'));
    // --pad-x は商品ありの外枠でしか定義されない。空のカートでも余白が 0 にならないよう既定値を持つ
    expect(notice.style.padding).toMatch(/^var\(--pad-x, .+\)$/);
  });

  it('在庫の変化の案内があっても、今のお届けの目安が在庫ありの行には印を付けない（設計書 5-3）', async () => {
    // 断られた後に数量を減らして在庫に収まった行は、目安が在庫ありに変わっている。古い印を残さない
    window.sessionStorage.setItem(
      'checkout:cart-notice',
      JSON.stringify({
        kind: 'stock_changed',
        message: '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）',
        lines: [
          { itemId: 1, name: 'シャツ', color: 'BLACK', size: 'M' },
          { itemId: 2, name: 'パンツ', color: 'NAVY', size: 'L' },
        ],
      }),
    );
    (global as any).fetch.mockResolvedValueOnce(okJson(cartJson(SHIRT, PANTS)));

    render(<CartPage />);

    // お届けの目安と印は、同じ行の上段に並ぶ
    const [stockRow, backorderRow] = (await screen.findAllByTestId('cart-fulfillment')).map(
      (label) => label.parentElement as HTMLElement,
    );
    expect(await within(backorderRow).findByTestId('cart-stock-changed')).toHaveTextContent('在庫あり → 受注生産');
    expect(within(stockRow).queryByTestId('cart-stock-changed')).toBeNull();
    expect(screen.getAllByTestId('cart-stock-changed')).toHaveLength(1);
  });

  it('案内の入れ物は空のまま先に置かれ、文言はあとから同じ入れ物に入る（読み上げの入れ物）', async () => {
    const message = '商品の価格が変わりました。内容をご確認ください';
    window.sessionStorage.setItem('checkout:cart-notice', JSON.stringify({ kind: 'message', message }));
    (global as any).fetch.mockResolvedValueOnce(okJson(cartJson()));

    // 文言ごと入れ物を差し込むと、スクリーンリーダーが読まないことがある。DOM が変わった順で確かめる
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(document.body, { childList: true, subtree: true });

    render(<CartPage />);

    const notice = await screen.findByTestId('cart-notice');
    await waitFor(() => expect(notice).toHaveTextContent(message));
    records.push(...observer.takeRecords());
    observer.disconnect();

    expect(
      records.some(
        (record) =>
          record.target === notice && Array.from(record.addedNodes).some((node) => node.textContent === message),
      ),
    ).toBe(true);
  });
});
