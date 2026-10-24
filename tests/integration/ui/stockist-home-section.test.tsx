import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';
import type { PublicStockist } from '@/features/stockist/types';

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

// ホームの URL に pref が付いていても、節は絞らないことを確かめるために pref を入れておく
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams('pref=%E5%A4%A7%E9%98%AA%E5%BA%9C'),
}));

function makeShops(count: number): PublicStockist[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Shop ${index + 1}`,
    address: `東京都渋谷区 ${index + 1}-1-1`,
    phone: `03-0000-000${index + 1}`,
    time: '11:00-19:00',
    holiday: '水曜',
  }));
}

function renderSection(count: number, className?: string) {
  const { container } = render(<PublicStockistGrid variant="home" stockists={makeShops(count)} className={className} />);
  return container.querySelector('section#stockist') as HTMLElement;
}

function cardsGrid(section: HTMLElement): HTMLElement {
  return within(section).getAllByRole('heading', { level: 3 })[0].closest('article')?.parentElement as HTMLElement;
}

describe('SCR-STOCKIST-003 home stockist section', () => {
  it('SCR-STOCKIST-003 section#stockist の中に下線付きの見出し STOCKIST と、一覧と同じカードの格子を出す', () => {
    const section = renderSection(3);

    expect(section).toBeInTheDocument();
    const heading = within(section).getByRole('heading', { level: 2, name: 'STOCKIST' });
    expect(heading).toHaveClass('underline');
    expect(within(section).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Shop 1',
      'Shop 2',
      'Shop 3',
    ]);
    expect(cardsGrid(section)).toHaveClass('stockist-grid-home', 'grid');
  });

  it('SCR-STOCKIST-003 0件の時は節の見出しを残し、「現在、取扱店舗はございません。オンラインストアにて販売中です。」と /item への VIEW COLLECTION を出す', () => {
    const section = renderSection(0);

    expect(within(section).getByRole('heading', { level: 2, name: 'STOCKIST' })).toBeInTheDocument();
    expect(within(section).getByText('現在、取扱店舗はございません。オンラインストアにて販売中です。')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'VIEW COLLECTION' })).toHaveAttribute('href', '/item');
    expect(within(section).queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    expect(section.querySelector('.stockist-grid-home')).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-003 1件の時は1列で、狭い幅で中央に寄せる', () => {
    const grid = cardsGrid(renderSection(1));

    expect(grid).toHaveClass('grid-cols-1', 'max-w-sm', 'mx-auto');
    expect(grid.className).not.toMatch(/sm:grid-cols/);
  });

  it('SCR-STOCKIST-003 2件の時は 640px 以上で2列にし、中ほどの幅で中央に寄せる', () => {
    const grid = cardsGrid(renderSection(2));

    expect(grid).toHaveClass('grid-cols-1', 'sm:grid-cols-2', 'max-w-3xl', 'mx-auto');
    expect(grid.className).not.toMatch(/lg:grid-cols/);
  });

  it('SCR-STOCKIST-003 3件以上は 640px 以上で2列・1024px 以上で3列にし、中央に寄せる指定は付けない', () => {
    for (const count of [3, 6]) {
      const { unmount } = render(<PublicStockistGrid variant="home" stockists={makeShops(count)} />);
      const grid = screen.getAllByRole('heading', { level: 3 })[0].closest('article')?.parentElement as HTMLElement;
      expect(grid).toHaveClass('grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3');
      expect(grid.className).not.toMatch(/max-w|mx-auto/);
      unmount();
    }
  });

  it('SCR-STOCKIST-003 4件目からは 768px 未満で隠し、1〜3件目は常に出す', () => {
    const cards = within(renderSection(6)).getAllByRole('heading', { level: 3 }).map((h) => h.closest('article') as HTMLElement);

    expect(cards).toHaveLength(6);
    for (const card of cards.slice(0, 3)) {
      expect(card).not.toHaveClass('hidden');
      expect(card).not.toHaveClass('md:block');
    }
    for (const card of cards.slice(3)) {
      expect(card).toHaveClass('hidden', 'md:block');
    }
  });

  it('SCR-STOCKIST-003 渡された並びのまま描き、7件以上を渡されても切らずに全部描く（6件に絞るのは取り出しの側）', () => {
    const section = renderSection(8);

    expect(within(section).getAllByRole('heading', { level: 3 })).toHaveLength(8);
    expect(within(section).getAllByRole('heading', { level: 3 })[7]).toHaveTextContent('Shop 8');
  });

  it('SCR-STOCKIST-003 節は一覧 /stockist へのリンクも、地方の絞り込みも、FILTER のバーも持たない', () => {
    const section = renderSection(3);

    expect(within(section).queryByRole('link', { name: /VIEW ALL/i })).not.toBeInTheDocument();
    expect(section.querySelector('a[href="/stockist"]')).not.toBeInTheDocument();
    expect(within(section).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(section).queryByRole('complementary')).not.toBeInTheDocument();
    expect(document.querySelector('[data-filter-bar]')).not.toBeInTheDocument();
    expect(within(section).getAllByRole('heading', { level: 3 })).toHaveLength(3);
  });

  it('SCR-STOCKIST-003 渡した className は店の格子に足し、見出しやカードには付けない', () => {
    const section = renderSection(3, 'extra-home-class');

    expect(cardsGrid(section)).toHaveClass('stockist-grid-home', 'extra-home-class');
    expect(section.querySelectorAll('.extra-home-class')).toHaveLength(1);
  });
});
