import React, { useState } from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { CartProvider, useCart } from '@/contexts/CartContext';

const WISHLISTED_ITEM = 7;
const NEW_ITEM = 8;

function Harness() {
  const { wishlistedItems, toggleWishlist } = useCart();
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
      <span data-testid="wishlisted">{wishlistedItems.has(WISHLISTED_ITEM) ? 'yes' : 'no'}</span>
      <span data-testid="new-wishlisted">{wishlistedItems.has(NEW_ITEM) ? 'yes' : 'no'}</span>
      <span data-testid="error">{error}</span>
      <button type="button" onClick={toggle(WISHLISTED_ITEM)}>
        toggle-existing
      </button>
      <button type="button" onClick={toggle(NEW_ITEM)}>
        toggle-new
      </button>
    </div>
  );
}

type Call = { url: string; method: string };

describe('toggleWishlist', () => {
  const originalFetch = global.fetch;
  let calls: Call[];
  let wishlistGet: { status: number; body: unknown };
  let wishlistDelete: { status: number; body: unknown };
  let wishlistPost: { status: number; body: unknown };
  /** 設定すると DELETE はこの Promise が解決するまで返らない。楽観更新の検証用。 */
  let deleteGate: Promise<void> | null;

  beforeEach(() => {
    calls = [];
    wishlistGet = { status: 200, body: [{ id: 'w1', item_id: WISHLISTED_ITEM }] };
    wishlistDelete = { status: 200, body: { success: true } };
    wishlistPost = { status: 201, body: { id: 'w2', item_id: NEW_ITEM } };
    deleteGate = null;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });

      let route = { status: 200, body: [] as unknown };
      if (url.startsWith('/api/wishlist/') && method === 'DELETE') {
        if (deleteGate) await deleteGate;
        route = wishlistDelete;
      } else if (url === '/api/wishlist' && method === 'GET') {
        route = wishlistGet;
      } else if (url === '/api/wishlist' && method === 'POST') {
        route = wishlistPost;
      }

      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  async function renderLoaded() {
    render(
      <CartProvider>
        <Harness />
      </CartProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('wishlisted')).toHaveTextContent('yes'));
    calls.length = 0;
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
    await renderLoaded();
    wishlistDelete = { status: 500, body: { error: 'boom' } };

    fireEvent.click(screen.getByRole('button', { name: 'toggle-existing' }));

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('ウィッシュリストから削除できません'),
    );
    expect(screen.getByTestId('wishlisted')).toHaveTextContent('yes');
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
    await renderLoaded();
    wishlistPost = { status: 500, body: { error: 'boom' } };

    fireEvent.click(screen.getByRole('button', { name: 'toggle-new' }));

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('ウィッシュリストに追加できません'),
    );
    expect(screen.getByTestId('new-wishlisted')).toHaveTextContent('no');
  });
});
