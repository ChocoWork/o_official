import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@testing-library/react';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';

const pushMock = jest.fn();

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/navigation', () => ({
  usePathname: () => '/news',
  useRouter: () => ({
    push: (...args: unknown[]) => pushMock(...args),
  }),
  useSearchParams: () => ({
    get: () => null,
    toString: () => '',
  }),
}));

describe('PublicNewsGrid catalog filter drawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders a filter button and opens a left drawer with the panel multi-select', async () => {
    const user = userEvent.setup();

    render(
      <PublicNewsGrid
        variant="catalog"
        initialCategory="ALL"
        articles={[
          {
            id: '1',
            title: 'First article',
            published_date: '2025-01-01',
            category: 'SUSTAINABILITY',
            image_url: '/news-1.jpg',
            content: 'First content',
          },
          {
            id: '2',
            title: 'Second article',
            published_date: '2025-01-02',
            category: 'COLLABORATION',
            image_url: '/news-2.jpg',
            content: 'Second content',
          },
        ]}
      />,
    );

    expect(screen.getByRole('button', { name: 'FILTER' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'FILTER' }));

    // ドロワー内の FILTER 見出しは廃止され、閉じるボタンだけが残っている。
    // 属性契約でドロワー本体を特定する。
    await waitFor(() => {
      expect(document.querySelector('[data-ui-drawer]')).toBeInTheDocument();
    });

    const drawer = document.querySelector<HTMLElement>('[data-ui-drawer]');

    if (!drawer) {
      throw new Error('Filter drawer not found');
    }

    expect(drawer).toHaveAttribute('data-ui-drawer-side', 'left');
    expect(within(drawer).getByRole('button', { name: 'Close filter drawer' })).toBeInTheDocument();

    expect(within(drawer).getByRole('checkbox', { name: 'ALL' })).toBeInTheDocument();
    expect(within(drawer).getByRole('checkbox', { name: 'COLLABORATION' })).toBeInTheDocument();
  });
});