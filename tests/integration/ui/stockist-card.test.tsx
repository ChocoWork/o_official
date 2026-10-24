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

jest.mock('next/navigation', () => ({
  usePathname: () => '/stockist',
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

function makeShop(overrides: Partial<PublicStockist> = {}): PublicStockist {
  return {
    id: 7,
    name: 'Atelier Quiet',
    address: '東京都渋谷区神宮前 1-2-3',
    phone: '03-1234-5678',
    time: '11:00-19:00',
    holiday: '水曜',
    ...overrides,
  };
}

function renderCard(shop: PublicStockist = makeShop()): HTMLElement {
  render(<PublicStockistGrid variant="catalog" stockists={[shop]} />);
  return screen.getByRole('heading', { level: 3 }).closest('article') as HTMLElement;
}

// 行の入れ物は、アイコン（aria-hidden の i）を持つ div
function detailRows(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>('.stockist-card-row'));
}

describe('SCR-STOCKIST-002 stockist card', () => {
  it('SCR-STOCKIST-002 共有の Card（sm・hoverable）に stockist-card の印を付け、店舗名の見出し h3・区切り線・詳細の順に並べる', () => {
    const card = renderCard();

    expect(card.tagName).toBe('ARTICLE');
    expect(card).toHaveClass('stockist-card');
    expect(card).toHaveAttribute('data-ui-card-size', 'sm');
    expect(card).toHaveAttribute('data-ui-card-hoverable', 'true');
    const parts = Array.from(card.children).map((child) => child.className);
    expect(parts).toEqual(['stockist-card-identity', 'stockist-card-divider', 'stockist-card-details']);
    const title = within(card).getByRole('heading', { level: 3 });
    expect(title).toHaveTextContent('Atelier Quiet');
    expect(title).toHaveClass('stockist-card-title');
  });

  it('SCR-STOCKIST-002 詳細は住所・電話・営業時間・定休日の順で、住所の行だけ全幅で出し、あとの3行は 640px 未満で隠す', () => {
    const card = renderCard();

    const rows = detailRows(card);
    expect(rows.map((row) => row.textContent)).toEqual([
      '東京都渋谷区神宮前 1-2-3',
      '03-1234-5678',
      '11:00-19:00',
      '水曜',
    ]);
    expect(rows[0]).not.toHaveClass('hidden');
    for (const row of rows.slice(1)) {
      expect(row).toHaveClass('hidden', 'sm:flex', 'stockist-card-row--compact');
    }
  });

  it('SCR-STOCKIST-002 住所は Google Maps の検索へのリンクで、住所を URL の部品として符号化し、新しいタブで opener を渡さずに開く', () => {
    const address = '東京都渋谷区神宮前 1-2-3 A&B #4F';
    const card = renderCard(makeShop({ address }));

    const link = within(card).getByRole('link', { name: address });
    expect(link).toHaveAttribute(
      'href',
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`,
    );
    expect(link.getAttribute('href')).not.toContain(' ');
    expect(link.getAttribute('href')).not.toContain('#');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('SCR-STOCKIST-002 電話は数字と + 以外を消した tel: のリンクにし、画面には書かれたままの電話を出す', () => {
    const card = renderCard(makeShop({ phone: '+81 (3) 1234-5678 内線9' }));

    const link = within(card).getByRole('link', { name: '+81 (3) 1234-5678 内線9' });
    expect(link).toHaveAttribute('href', 'tel:+813123456789');
    expect(link).not.toHaveAttribute('target');
  });

  it('SCR-STOCKIST-002 電話が空の店は電話の行を出さず、リンクは住所の1つだけにする', () => {
    const card = renderCard(makeShop({ phone: '' }));

    expect(detailRows(card).map((row) => row.textContent)).toEqual(['東京都渋谷区神宮前 1-2-3', '11:00-19:00', '水曜']);
    expect(within(card).getAllByRole('link')).toHaveLength(1);
    expect(card.querySelector('a[href^="tel:"]')).not.toBeInTheDocument();
    expect(card.querySelector('.ri-phone-line')).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-002 各行のアイコンは読み上げから外し、住所だけがピンのアイコンの印を持つ', () => {
    const card = renderCard();

    const icons = Array.from(card.querySelectorAll('i'));
    expect(icons).toHaveLength(4);
    for (const icon of icons) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
    expect(icons[0]).toHaveClass('ri-map-pin-line', 'stockist-card-icon--pin');
    expect(icons.slice(1).map((icon) => icon.classList.contains('stockist-card-icon--pin'))).toEqual([false, false, false]);
  });

  it('SCR-STOCKIST-002 店舗の値は文字として出し、HTML を解釈せず、リンクは決まった形でだけ作る', () => {
    const card = renderCard(
      makeShop({
        name: '<script>alert(1)</script>Shop',
        address: '<b>東京都</b>"><a href="javascript:alert(1)">x</a>',
        time: '<i>11:00</i>',
        holiday: '<u>水</u>',
        phone: 'javascript:alert(1)',
      }),
    );

    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe('<script>alert(1)</script>Shop');
    expect(card.querySelector('script')).not.toBeInTheDocument();
    expect(card.querySelector('b, u')).not.toBeInTheDocument();
    expect(card.querySelector('a[href^="javascript:"]')).not.toBeInTheDocument();
    expect(within(card).getByText('<i>11:00</i>')).toBeInTheDocument();
    // 電話に細工があっても、tel: の後ろは数字と + だけ（ここでは alert(1) の 1）になる
    expect(card.querySelector('a[href^="tel:"]')).toHaveAttribute('href', 'tel:1');
    const hrefs = within(card).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs.every((href) => href?.startsWith('https://www.google.com/maps/search/') || href?.startsWith('tel:'))).toBe(true);
  });

  it('SCR-STOCKIST-002 カードの区別は店の id で行い、同じ名前の店が2つあっても2枚とも描く', () => {
    render(
      <PublicStockistGrid
        variant="catalog"
        stockists={[makeShop({ id: 1, name: 'Same name' }), makeShop({ id: 2, name: 'Same name' })]}
      />,
    );

    expect(screen.getAllByRole('heading', { level: 3, name: 'Same name' })).toHaveLength(2);
  });

  it('SCR-STOCKIST-002 一覧とホームは同じカードの作りを使い、ホームでも店舗名は h3 で住所は同じ形のリンクにする', () => {
    const shop = makeShop();
    const { unmount } = render(<PublicStockistGrid variant="catalog" stockists={[shop]} />);
    const catalogCard = screen.getByRole('heading', { level: 3 }).closest('article') as HTMLElement;
    const catalogHtml = catalogCard.outerHTML;
    unmount();

    render(<PublicStockistGrid variant="home" stockists={[shop]} />);
    const homeCard = screen.getByRole('heading', { level: 3 }).closest('article') as HTMLElement;

    expect(homeCard.outerHTML).toBe(catalogHtml);
  });
});
