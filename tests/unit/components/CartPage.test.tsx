import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ({ src, alt, ...props }: any) => <img src={src} alt={alt} {...props} />;
});

// stub useCart hook so the component renders without context issues
jest.mock('@/app/components/CartContext', () => {
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
      expect(screen.getByText(/カートは空です/i)).toBeInTheDocument();
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

    let resolveFirst: (value?: any) => void;
    const firstPromise = new Promise((res) => {
      resolveFirst = res;
    });
    let resolveSecond: (value?: any) => void;
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
    resolveFirst({ ok: true });
    // allow microtasks to run and scheduling logic to execute
    await Promise.resolve();

    // wait for second PATCH to be issued (may happen after debounce)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'PATCH' });

    // clean up second promise resolution
    resolveSecond({ ok: true });
  });
});
