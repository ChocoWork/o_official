import React, { useState } from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { CartProvider, useCart } from '@/contexts/CartContext';
import type { CartJson } from '@/features/cart/types/cart-json';

const WISHLISTED_ITEM = 7;
const NEW_ITEM = 8;

// ヘッダーの数は GET /api/cart の item_count だけを見る（Shopify の /cart.js と同じ）。明細の中身は要らない
const cartWithCount = (count: number): CartJson => ({
  item_count: count,
  currency: 'JPY',
  items_subtotal_price: 0,
  total_price: 0,
  items: [],
});

function Harness() {
  const { cartCount, wishlistedItems, toggleWishlist, updateCartCount, refreshShopping } = useCart();
  const [error, setError] = useState('');

  const toggle = (itemId: number) => async () => {
    try {
      await toggleWishlist(itemId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown');
    }
  };

  return (
    <div>
      <span data-testid="cart-count">{cartCount}</span>
      <span data-testid="wishlisted">{wishlistedItems.has(WISHLISTED_ITEM) ? 'yes' : 'no'}</span>
      <span data-testid="new-wishlisted">{wishlistedItems.has(NEW_ITEM) ? 'yes' : 'no'}</span>
      <span data-testid="error">{error}</span>
      <button type="button" onClick={toggle(WISHLISTED_ITEM)}>
        toggle-existing
      </button>
      <button type="button" onClick={toggle(NEW_ITEM)}>
        toggle-new
      </button>
      <button type="button" onClick={() => void updateCartCount()}>
        update-cart-count
      </button>
      <button type="button" onClick={() => void refreshShopping()}>
        refresh-shopping
      </button>
    </div>
  );
}

type Call = { url: string; method: string };

describe('toggleWishlist', () => {
  const originalFetch = global.fetch;
  let calls: Call[];
  /** 送った CSRF の合言葉。キーは "METHOD /url"（無ければ null） */
  let csrfSent: Record<string, string | null>;
  let cartGet: { status: number; body: unknown };
  let wishlistGet: { status: number; body: unknown };
  let wishlistDelete: { status: number; body: unknown };
  let wishlistPost: { status: number; body: unknown };
  /** 設定すると DELETE はこの Promise が解決するまで返らない。楽観更新の検証用。 */
  let deleteGate: Promise<void> | null;
  /** true なら最初の DELETE だけ 401 auth_expired で返す（印の更新と送り直しの検証用） */
  let deleteAuthExpiredOnce: boolean;

  beforeEach(() => {
    calls = [];
    csrfSent = {};
    cartGet = { status: 200, body: cartWithCount(2) };
    wishlistGet = { status: 200, body: [{ id: 'w1', item_id: WISHLISTED_ITEM }] };
    wishlistDelete = { status: 200, body: { success: true } };
    wishlistPost = { status: 201, body: { id: 'w2', item_id: NEW_ITEM } };
    deleteGate = null;
    deleteAuthExpiredOnce = false;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      csrfSent[`${method} ${url}`] = new Headers(init?.headers).get('x-csrf-token');

      let route = { status: 200, body: [] as unknown };
      if (url.startsWith('/api/wishlist/') && method === 'DELETE') {
        if (deleteGate) await deleteGate;
        if (deleteAuthExpiredOnce) {
          deleteAuthExpiredOnce = false;
          route = { status: 401, body: { error: 'auth_expired' } };
        } else {
          route = wishlistDelete;
        }
      } else if (url === '/api/wishlist' && method === 'GET') {
        route = wishlistGet;
      } else if (url === '/api/wishlist' && method === 'POST') {
        route = wishlistPost;
      } else if (url === '/api/cart' && method === 'GET') {
        route = cartGet;
      }

      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    document.cookie = 'sb-csrf-token=; max-age=0';
    jest.restoreAllMocks();
  });

  async function renderLoaded() {
    render(
      <CartProvider>
        <Harness />
      </CartProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('wishlisted')).toHaveTextContent('yes'));
    await waitFor(() => expect(screen.getByTestId('cart-count')).toHaveTextContent('2'));
    calls.length = 0;
    csrfSent = {};
  }

  function wishlistCallsAfterMount(): Call[] {
    return calls.filter((call) => call.url.startsWith('/api/wishlist'));
  }

  test('解除は照会を挟まず DELETE 1 回で済ませる', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-existing' }));

    await waitFor(() => expect(screen.getByTestId('wishlisted')).toHaveTextContent('no'));
    expect(wishlistCallsAfterMount()).toEqual([
      { url: '/api/wishlist/w1', method: 'DELETE' },
    ]);
  });

  test('解除はレスポンスを待たずに表示へ反映する', async () => {
    await renderLoaded();
    let openGate = () => {};
    deleteGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    fireEvent.click(screen.getByRole('button', { name: 'toggle-existing' }));

    // DELETE はまだ返っていないが、表示は解除済みになっている
    await waitFor(() => expect(screen.getByTestId('wishlisted')).toHaveTextContent('no'));

    await act(async () => {
      openGate();
      await Promise.resolve();
    });
    expect(screen.getByTestId('wishlisted')).toHaveTextContent('no');
  });

  test('解除に失敗したら表示を元に戻して例外を投げる', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    await renderLoaded();
    wishlistDelete = { status: 500, body: { error: 'boom' } };

    fireEvent.click(screen.getByRole('button', { name: 'toggle-existing' }));

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('ウィッシュリストから削除できません'),
    );
    expect(screen.getByTestId('wishlisted')).toHaveTextContent('yes');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('DELETE が 404 なら既に解除済みとして扱う', async () => {
    await renderLoaded();
    wishlistDelete = { status: 404, body: { error: 'Wishlist item not found' } };

    fireEvent.click(screen.getByRole('button', { name: 'toggle-existing' }));

    await waitFor(() => expect(screen.getByTestId('wishlisted')).toHaveTextContent('no'));
    expect(screen.getByTestId('error')).toHaveTextContent('');
  });

  test('処理中の同じ商品への再操作は無視する', async () => {
    await renderLoaded();
    let openGate = () => {};
    deleteGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const button = screen.getByRole('button', { name: 'toggle-existing' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('wishlisted')).toHaveTextContent('no'));
    fireEvent.click(button);

    await act(async () => {
      openGate();
      await Promise.resolve();
    });

    expect(wishlistCallsAfterMount()).toEqual([
      { url: '/api/wishlist/w1', method: 'DELETE' },
    ]);
    expect(screen.getByTestId('wishlisted')).toHaveTextContent('no');
  });

  test('追加は行 ID を覚えるので、続けて解除しても照会しない', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-new' }));
    await waitFor(() => expect(screen.getByTestId('new-wishlisted')).toHaveTextContent('yes'));

    fireEvent.click(screen.getByRole('button', { name: 'toggle-new' }));
    await waitFor(() => expect(screen.getByTestId('new-wishlisted')).toHaveTextContent('no'));

    expect(wishlistCallsAfterMount()).toEqual([
      { url: '/api/wishlist', method: 'POST' },
      { url: '/api/wishlist/w2', method: 'DELETE' },
    ]);
  });

  test('行 ID が分からない場合だけ照会してから削除する', async () => {
    await renderLoaded();
    // 409（既に登録済み）は行 ID を返さないため、解除時に引き直す必要がある
    wishlistPost = { status: 409, body: { error: 'Item already in wishlist' } };
    wishlistGet = { status: 200, body: [{ id: 'w9', item_id: NEW_ITEM }] };

    fireEvent.click(screen.getByRole('button', { name: 'toggle-new' }));
    await waitFor(() => expect(screen.getByTestId('new-wishlisted')).toHaveTextContent('yes'));

    fireEvent.click(screen.getByRole('button', { name: 'toggle-new' }));
    await waitFor(() => expect(screen.getByTestId('new-wishlisted')).toHaveTextContent('no'));

    expect(wishlistCallsAfterMount()).toEqual([
      { url: '/api/wishlist', method: 'POST' },
      { url: '/api/wishlist', method: 'GET' },
      { url: '/api/wishlist/w9', method: 'DELETE' },
    ]);
  });

  test('追加に失敗したら表示を元に戻して例外を投げる', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    await renderLoaded();
    wishlistPost = { status: 500, body: { error: 'boom' } };

    fireEvent.click(screen.getByRole('button', { name: 'toggle-new' }));

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('ウィッシュリストに追加できません'),
    );
    expect(screen.getByTestId('new-wishlisted')).toHaveTextContent('no');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('会員（読める CSRF の Cookie がある）は、お気に入りの追加と解除に合言葉を付ける', async () => {
    document.cookie = 'sb-csrf-token=member-token';
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-new' }));
    await waitFor(() => expect(screen.getByTestId('new-wishlisted')).toHaveTextContent('yes'));
    fireEvent.click(screen.getByRole('button', { name: 'toggle-existing' }));
    await waitFor(() => expect(screen.getByTestId('wishlisted')).toHaveTextContent('no'));

    expect(csrfSent['POST /api/wishlist']).toBe('member-token');
    expect(csrfSent['DELETE /api/wishlist/w1']).toBe('member-token');
  });

  test('ゲストは合言葉を付けず、印の更新も呼ばない', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-new' }));
    await waitFor(() => expect(screen.getByTestId('new-wishlisted')).toHaveTextContent('yes'));
    fireEvent.click(screen.getByRole('button', { name: 'toggle-existing' }));
    await waitFor(() => expect(screen.getByTestId('wishlisted')).toHaveTextContent('no'));

    expect(csrfSent['POST /api/wishlist']).toBeNull();
    expect(csrfSent['DELETE /api/wishlist/w1']).toBeNull();
    expect(calls.some((call) => call.url === '/api/auth/refresh')).toBe(false);
  });

  test('解除が 401 auth_expired なら、印を1回だけ新しくして送り直す', async () => {
    await renderLoaded();
    deleteAuthExpiredOnce = true;

    fireEvent.click(screen.getByRole('button', { name: 'toggle-existing' }));

    await waitFor(() => expect(screen.getByTestId('wishlisted')).toHaveTextContent('no'));
    expect(calls).toEqual([
      { url: '/api/wishlist/w1', method: 'DELETE' },
      { url: '/api/auth/refresh', method: 'POST' },
      { url: '/api/wishlist/w1', method: 'DELETE' },
    ]);
    expect(screen.getByTestId('error')).toHaveTextContent('');
  });

  describe('ヘッダーの数', () => {
    test('最初にカートの item_count を数にする', async () => {
      cartGet = { status: 200, body: cartWithCount(5) };

      render(
        <CartProvider>
          <Harness />
        </CartProvider>,
      );

      await waitFor(() => expect(screen.getByTestId('cart-count')).toHaveTextContent('5'));
    });

    test('updateCartCount() は GET /api/cart の item_count を数にする', async () => {
      await renderLoaded();
      cartGet = { status: 200, body: cartWithCount(7) };

      fireEvent.click(screen.getByRole('button', { name: 'update-cart-count' }));

      await waitFor(() => expect(screen.getByTestId('cart-count')).toHaveTextContent('7'));
      expect(calls).toEqual([{ url: '/api/cart', method: 'GET' }]);
    });

    test('カートを読めなかった時は、今の数のまま', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await renderLoaded();
      cartGet = { status: 500, body: { status: 500, message: 'Cart Error', description: 'x' } };

      fireEvent.click(screen.getByRole('button', { name: 'update-cart-count' }));

      await waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect(screen.getByTestId('cart-count')).toHaveTextContent('2');
    });

    test('refreshShopping() はカートとお気に入りの両方を読み直す', async () => {
      await renderLoaded();
      // ログインでゲストの分が会員の分へ合わさった後の中身
      cartGet = { status: 200, body: cartWithCount(6) };
      wishlistGet = {
        status: 200,
        body: [
          { id: 'w1', item_id: WISHLISTED_ITEM },
          { id: 'w5', item_id: NEW_ITEM },
        ],
      };

      fireEvent.click(screen.getByRole('button', { name: 'refresh-shopping' }));

      await waitFor(() => expect(screen.getByTestId('cart-count')).toHaveTextContent('6'));
      await waitFor(() => expect(screen.getByTestId('new-wishlisted')).toHaveTextContent('yes'));
      expect(calls).toHaveLength(2);
      expect(calls).toEqual(
        expect.arrayContaining([
          { url: '/api/cart', method: 'GET' },
          { url: '/api/wishlist', method: 'GET' },
        ]),
      );
      // 読み直したお気に入りの行 ID で、続けて解除しても照会しない
      calls.length = 0;
      fireEvent.click(screen.getByRole('button', { name: 'toggle-new' }));
      await waitFor(() => expect(screen.getByTestId('new-wishlisted')).toHaveTextContent('no'));
      expect(calls).toEqual([{ url: '/api/wishlist/w5', method: 'DELETE' }]);
    });
  });
});
