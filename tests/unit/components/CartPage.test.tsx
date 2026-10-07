import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CartPage from '@/app/cart/page';

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
jest.mock('@/contexts/CartContext', () => {
  return {
    useCart: () => ({
      updateCartCount: jest.fn(),
      wishlistedItems: new Set<number>(),
      toggleWishlist: jest.fn(),
    }),
  };
});

describe('CartPage', () => {
  beforeEach(() => {
    // reset fetch mock
    (global as any).fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('does not crash when an item returned from API lacks product details', async () => {
    const badCart = [
      {
        id: 'abc',
        item_id: 123,
        quantity: 1,
        color: null,
        size: null,
        added_at: '2025-01-01T00:00:00Z',
        items: null,
      },
    ];

    (global as any).fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => badCart,
    });

    render(<CartPage />);

    // wait for loading to finish and EmptyCart to appear
    await waitFor(() => {
      expect(screen.getByText(/YOUR CART IS EMPTY/i)).toBeInTheDocument();
    });
  });

  it('optimistically updates quantity and debounces server call', async () => {
    // use real timers to avoid complexity with jest fake timers and waitFor
    const initialCart = [
      {
        id: '1',
        item_id: 1,
        quantity: 1,
        color: null,
        size: null,
        added_at: '2025-01-01T00:00:00Z',
        items: {
          id: 1,
          name: 'Test item',
          price: 100,
          image_url: '/x.png',
          category: 'TEST',
        },
      },
    ];

    let resolveFirst: (value?: any) => void = () => {};
    const firstPromise = new Promise((res) => {
      resolveFirst = res;
    });
    let resolveSecond: (value?: any) => void = () => {};
    const secondPromise = new Promise((res) => {
      resolveSecond = res;
    });

    // initial GET followed by two PATCHs with manual control
    (global as any).fetch
      .mockResolvedValueOnce({ ok: true, json: async () => initialCart })
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise);

    render(<CartPage />);
    await waitFor(() => screen.getByText('Test item'));

    const inc = screen.getByLabelText('increase');
    // perform one click to 2, wait for timer to fire (simulate 500ms)
    await userEvent.click(inc);
    await new Promise((r) => setTimeout(r, 500));

    // at this point first PATCH should be pending
    expect(fetch).toHaveBeenCalledTimes(2);

    // click again while first request is still in flight
    await userEvent.click(inc);
    await userEvent.click(inc);

    // quantity should continue updating locally
    expect(screen.getByDisplayValue('4')).toBeInTheDocument();

    // now resolve first request
    resolveFirst({ ok: true, json: async () => ({ quantity: 2 }) });
    // allow microtasks to run and scheduling logic to execute
    await Promise.resolve();

    // wait for second PATCH to be issued (may happen after debounce)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect((fetch as unknown as jest.Mock).mock.calls[2][1]).toMatchObject({ method: 'PATCH' });

    // clean up second promise resolution
    resolveSecond({ ok: true, json: async () => ({ quantity: 4 }) });
  });

  it('PATCH失敗時に確定値へロールバックし再試行UIを表示する', async () => {
    const initialCart = [
      {
        id: '1',
        item_id: 1,
        quantity: 1,
        color: null,
        size: null,
        added_at: '2025-01-01T00:00:00Z',
        items: {
          id: 1,
          name: 'Test item',
          price: 100,
          image_url: '/x.png',
          category: 'TEST',
        },
      },
    ];

    (global as any).fetch
      .mockResolvedValueOnce({ ok: true, json: async () => initialCart })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ message: '在庫不足' }) });

    render(<CartPage />);
    await waitFor(() => screen.getByText('Test item'));

    const inc = screen.getByLabelText('increase');
    await userEvent.click(inc);

    await new Promise((r) => setTimeout(r, 550));

    await waitFor(() => {
      expect(screen.getByDisplayValue('1')).toBeInTheDocument();
      expect(screen.getByText('在庫不足')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '再試行' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: '最新状態を再取得' }).length).toBeGreaterThan(0);
    });
  });
  it('明細ごとにお届けの目安を出す（設計書 5-2）', async () => {
    (global as any).fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: '1', item_id: 1, quantity: 1, color: 'BLACK', size: 'M', added_at: '2026-10-08T00:00:00Z', fulfillment: 'stock',
          items: { id: 1, name: 'シャツ', price: 5000, image_url: '/x.png', category: 'TOPS' },
        },
        {
          id: '2', item_id: 2, quantity: 2, color: 'NAVY', size: 'L', added_at: '2026-10-08T00:00:00Z', fulfillment: 'backorder',
          items: { id: 2, name: 'パンツ', price: 8000, image_url: '/y.png', category: 'BOTTOMS' },
        },
      ],
    });

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
    (global as any).fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: '1', item_id: 1, quantity: 1, color: 'BLACK', size: 'M', added_at: '2026-10-08T00:00:00Z', fulfillment: 'stock',
          items: { id: 1, name: 'シャツ', price: 5000, image_url: '/x.png', category: 'TOPS' },
        },
        {
          id: '2', item_id: 2, quantity: 2, color: 'NAVY', size: 'L', added_at: '2026-10-08T00:00:00Z', fulfillment: 'backorder',
          items: { id: 2, name: 'パンツ', price: 8000, image_url: '/y.png', category: 'BOTTOMS' },
        },
      ],
    });

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
    (global as any).fetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

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
    (global as any).fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: '1', item_id: 1, quantity: 1, color: 'BLACK', size: 'M', added_at: '2026-10-08T00:00:00Z', fulfillment: 'stock',
          items: { id: 1, name: 'シャツ', price: 5000, image_url: '/x.png', category: 'TOPS' },
        },
        {
          id: '2', item_id: 2, quantity: 2, color: 'NAVY', size: 'L', added_at: '2026-10-08T00:00:00Z', fulfillment: 'backorder',
          items: { id: 2, name: 'パンツ', price: 8000, image_url: '/y.png', category: 'BOTTOMS' },
        },
      ],
    });

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
    (global as any).fetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

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
