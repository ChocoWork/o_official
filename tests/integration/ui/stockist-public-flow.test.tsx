/**
 * 取扱店の公開の画面遷移（FLOW-STOCKIST-001）を確かめる結合テスト。
 * 入口（ヘッダーのナビ・ヘッダーの引き出し・フッター）が `/stockist` を指し、
 * 一覧とホームの節のカードが住所から地図、電話番号から発信へ移るリンクを持ち、
 * ホームで店が0件の時は `/item` へ渡し、一覧の絞り込みは同じ道の `pref` を書き換えることを、実物の部品を描いて見る。
 * ログイン・カートの文脈とログインの窓だけを差し替える。
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';
import type { PublicStockist } from '@/features/stockist/types';

const pushMock = jest.fn();
let currentPath = '/';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => currentPath,
  useRouter: () => ({ push: (...args: unknown[]) => pushMock(...args) }),
  useSearchParams: () => new URLSearchParams(''),
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: false, userRole: null }),
}));
jest.mock('@/contexts/CartContext', () => ({
  useCart: () => ({ cartCount: 0 }),
}));
jest.mock('@/components/LoginModal', () => ({
  __esModule: true,
  default: () => null,
}));

const SHOP: PublicStockist = {
  id: 1,
  name: 'Atelier Quiet',
  address: '東京都渋谷区神宮前 1-2-3',
  phone: '03-1234-5678',
  time: '11:00-19:00',
  holiday: '水曜',
};

const OSAKA_SHOP: PublicStockist = {
  id: 2,
  name: 'Osaka Shop',
  address: '大阪府大阪市北区1-1',
  phone: '+81 6-1234-5678',
  time: '10:00-18:00',
  holiday: '木曜',
};

function cardOf(name: string): HTMLElement {
  return screen.getByRole('heading', { level: 3, name }).closest('article') as HTMLElement;
}

describe('FLOW-STOCKIST-001 stockist public flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentPath = '/';
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
  });

  it('FLOW-STOCKIST-001 ヘッダーのナビの STOCKIST は /stockist へ移るリンクで、別のタブでは開かず、1つだけ', () => {
    render(<Header />);

    const nav = screen.getAllByRole('navigation')[0];
    const link = within(nav).getByRole('link', { name: 'STOCKIST' });
    expect(link).toHaveAttribute('href', '/stockist');
    expect(link).not.toHaveAttribute('target');
    expect(screen.getAllByRole('link', { name: 'STOCKIST' })).toHaveLength(1);
  });

  it('FLOW-STOCKIST-001 ヘッダーの引き出しを開くと、モバイルのナビにも STOCKIST が /stockist を指して並ぶ', async () => {
    render(<Header />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Open menu' }));

    const mobileNav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    expect(within(mobileNav).getByRole('link', { name: 'STOCKIST' })).toHaveAttribute('href', '/stockist');
    expect(screen.getAllByRole('link', { name: 'STOCKIST' }).map((link) => link.getAttribute('href'))).toEqual([
      '/stockist',
      '/stockist',
    ]);
  });

  it('FLOW-STOCKIST-001 /stockist を開いている時、ヘッダーのナビの STOCKIST だけが選ばれた印（下線）を持つ', () => {
    currentPath = '/stockist';
    render(<Header />);

    const nav = screen.getAllByRole('navigation')[0];
    const underlineOf = (label: string) => within(nav).getByRole('link', { name: label }).querySelector('span');
    expect(underlineOf('STOCKIST')).toHaveClass('scale-x-100');
    expect(underlineOf('NEWS')).toHaveClass('scale-x-0');
  });

  it('FLOW-STOCKIST-001 フッターの INFORMATION の STOCKIST は /stockist へ移るリンクで、別のタブでは開かず、1つだけ', () => {
    render(<Footer />);

    const list = screen.getByRole('heading', { name: 'INFORMATION' }).parentElement as HTMLElement;
    const link = within(list).getByRole('link', { name: 'STOCKIST' });
    expect(link).toHaveAttribute('href', '/stockist');
    expect(link).not.toHaveAttribute('target');
    expect(screen.getAllByRole('link', { name: 'STOCKIST' })).toHaveLength(1);
  });

  it('FLOW-STOCKIST-001 一覧のカードの住所は、住所を符号化した Google Maps の検索へ新しいタブで開き、元の頁を触らせない', () => {
    currentPath = '/stockist';
    render(<PublicStockistGrid variant="catalog" stockists={[SHOP]} />);

    const map = within(cardOf('Atelier Quiet')).getByRole('link', { name: SHOP.address });
    expect(map).toHaveAttribute(
      'href',
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(SHOP.address)}`,
    );
    expect(map).toHaveAttribute('target', '_blank');
    expect(map).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('FLOW-STOCKIST-001 住所に記号や空白があっても、地図の検索の値は符号化されて URL の区切りを壊さない', () => {
    render(<PublicStockistGrid variant="catalog" stockists={[{ ...SHOP, address: '東京都 渋谷区&x=1#frag?y=2' }]} />);

    const map = within(cardOf('Atelier Quiet')).getByRole('link', { name: '東京都 渋谷区&x=1#frag?y=2' });
    const url = new URL(map.getAttribute('href') as string);
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/search/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('query')).toBe('東京都 渋谷区&x=1#frag?y=2');
    expect(url.hash).toBe('');
  });

  it('FLOW-STOCKIST-001 一覧のカードの電話番号は、数字と + だけにした tel: のリンクで、新しいタブでは開かない', () => {
    render(<PublicStockistGrid variant="catalog" stockists={[SHOP, OSAKA_SHOP]} />);

    const tel = within(cardOf('Atelier Quiet')).getByRole('link', { name: '03-1234-5678' });
    expect(tel).toHaveAttribute('href', 'tel:0312345678');
    expect(tel).not.toHaveAttribute('target');
    const international = within(cardOf('Osaka Shop')).getByRole('link', { name: '+81 6-1234-5678' });
    expect(international).toHaveAttribute('href', 'tel:+81612345678');
  });

  it('FLOW-STOCKIST-001 電話番号が空の店は、電話の行もリンクも出さず、住所の地図のリンクだけが残る', () => {
    render(<PublicStockistGrid variant="catalog" stockists={[{ ...SHOP, phone: '' }]} />);

    const card = cardOf('Atelier Quiet');
    const hrefs = within(card)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toMatch(/^https:\/\/www\.google\.com\/maps\/search\//);
    expect(card.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('FLOW-STOCKIST-001 640px 未満のカードでは電話の行を隠す（モバイルからは発信できない）が、住所の行は隠さない', () => {
    render(<PublicStockistGrid variant="catalog" stockists={[SHOP]} />);

    const card = cardOf('Atelier Quiet');
    const phoneRow = card.querySelector('a[href^="tel:"]')?.closest('.stockist-card-row');
    expect(phoneRow).toHaveClass('hidden', 'sm:flex');
    const addressRow = card.querySelector('a[href^="https://www.google.com/maps/"]')?.closest('.stockist-card-row');
    expect(addressRow).not.toHaveClass('hidden');
  });

  it('FLOW-STOCKIST-001 ホームの節のカードも、一覧と同じ地図と発信のリンクを持ち、節から /stockist へのリンクは持たない', () => {
    const { container } = render(<PublicStockistGrid variant="home" stockists={[SHOP]} />);

    const section = container.querySelector('section#stockist') as HTMLElement;
    const card = within(section).getByRole('heading', { level: 3, name: 'Atelier Quiet' }).closest('article') as HTMLElement;
    expect(within(card).getByRole('link', { name: SHOP.address })).toHaveAttribute(
      'href',
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(SHOP.address)}`,
    );
    expect(within(card).getByRole('link', { name: SHOP.phone })).toHaveAttribute('href', 'tel:0312345678');
    expect(section.querySelector('a[href="/stockist"]')).toBeNull();
  });

  it('FLOW-STOCKIST-001 ホームで店が0件の時は、取扱店が無い旨の文と /item へ移る VIEW COLLECTION を出し、カードは出さない', () => {
    render(<PublicStockistGrid variant="home" stockists={[]} />);

    expect(screen.getByText('現在、取扱店舗はございません。オンラインストアにて販売中です。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'VIEW COLLECTION' })).toHaveAttribute('href', '/item');
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(1);
  });

  it('FLOW-STOCKIST-001 一覧の絞り込みは、頁を移らず同じ道の pref を書き換えて履歴を足し、画面の位置は動かさない', async () => {
    currentPath = '/stockist';
    render(<PublicStockistGrid variant="catalog" stockists={[SHOP, OSAKA_SHOP]} />);

    await userEvent.setup().click(screen.getByRole('checkbox', { name: '近畿' }));

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/stockist?pref=%E5%A4%A7%E9%98%AA%E5%BA%9C', { scroll: false });
  });
});
