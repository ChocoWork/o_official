import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import HomeItemsSection from '@/components/HomeItemsSection';

jest.mock('next/link', () => {
  return ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('@/features/items/hooks/usePublicItems', () => ({
  usePublicItems: () => ({
    items: Array.from({ length: 8 }).map((_, index) => ({
      id: index + 1,
      name: `Item ${index + 1}`,
      description: 'desc',
      price: 1000,
      image_url: '/img.png',
      category: 'TOPS',
    })),
    loading: false,
    error: null,
  }),
}));


// stub next/image globally to simple <img>
jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, ...props }: any) => React.createElement('img', { src: src as string, alt: alt as string, ...props }),
}));

describe('HomeItemsSectionClient', () => {
  beforeEach(() => {
    let listener: ((event: MediaQueryListEvent) => void) | null = null;
    let matches = true;

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        media: query,
        matches,
        addEventListener: (event: string, cb: (event: MediaQueryListEvent) => void) => {
          if (event === 'change') {
            listener = cb;
          }
        },
        removeEventListener: (event: string) => {
          if (event === 'change') {
            listener = null;
          }
        },
        dispatchEvent: (event: any) => {
          if (listener) {
            listener(event);
            return true;
          }
          return false;
        },
      }),
    });

    (window.matchMedia as unknown as any).setMatches = (newMatches: boolean) => {
      matches = newMatches;
      if (listener) {
        listener({ matches: newMatches } as MediaQueryListEvent);
      }
    };
  });

  test('renders 8 items on wide screens and switches to 6 on narrow screens', async () => {
    render(<HomeItemsSection limit={6} />);

    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { level: 3 });
      expect(headings.length).toBe(8);
    });

    expect(screen.queryByRole('link', { name: 'VIEW ALL ITEMS' })).not.toBeInTheDocument();

    // simulate narrow
    (window.matchMedia as any).setMatches(false);

    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { level: 3 });
      expect(headings.length).toBe(6);
    });

    expect(screen.getByRole('link', { name: 'VIEW ALL ITEMS' })).toBeInTheDocument();
  });
});
