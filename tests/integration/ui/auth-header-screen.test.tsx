import React from 'react';
import { render, within } from '@testing-library/react';
import Header from '@/components/Header';

type Role = 'admin' | 'supporter' | 'user' | null;

// 画面は Header 本物に、外との境目（道・ログインの値・カートの値・リンク・ログインのモーダル）だけ偽物を当てる。
let mockPathname = '/';
let mockLogin: { isLoggedIn: boolean; userRole: Role } = { isLoggedIn: false, userRole: null };
let mockCartCount = 0;

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => mockLogin,
}));

jest.mock('@/contexts/CartContext', () => ({
  useCart: () => ({ cartCount: mockCartCount }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock('@/components/LoginModal', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) => <div data-testid="login-modal" data-open={String(open)} />,
}));

function renderHeader(options: { path?: string; loggedIn?: boolean; role?: Role; cartCount?: number } = {}) {
  mockPathname = options.path ?? '/';
  mockLogin = { isLoggedIn: options.loggedIn ?? false, userRole: options.role ?? null };
  mockCartCount = options.cartCount ?? 0;
  const view = render(<Header />);
  const header = view.container.querySelector('header') as HTMLElement;
  return { ...view, header };
}

function underlineOf(link: HTMLElement) {
  return link.querySelector('span.underline-animation-left2right') as HTMLElement;
}

describe('SCR-AUTH-009 ヘッダー', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    delete document.documentElement.dataset.headerVisible;
  });

  it('SCR-AUTH-009 題「Le Fil des Heures」を / へのリンクにする', () => {
    const { header } = renderHeader();
    const title = within(header).getByRole('link', { name: 'Le Fil des Heures home' });
    expect(title).toHaveAttribute('href', '/');
    expect(title).toHaveTextContent('Le Fil des Heures');
  });

  it('SCR-AUTH-009 ナビは NEWS・ITEM・LOOK・STOCKIST・ABOUT・CONTACT・UI の順で7項目を出す', () => {
    const { header } = renderHeader();
    const nav = header.querySelector('nav') as HTMLElement;
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'NEWS',
      'ITEM',
      'LOOK',
      'STOCKIST',
      'ABOUT',
      'CONTACT',
      'UI',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/news',
      '/item',
      '/look',
      '/stockist',
      '/about',
      '/contact',
      '/ui',
    ]);
  });

  it('SCR-AUTH-009 ナビは大きい画面だけに出す部品の位置クラスの中に置く', () => {
    const { header } = renderHeader();
    const nav = header.querySelector('nav') as HTMLElement;
    expect(nav).toHaveClass('header-nav-position');
  });

  it('SCR-AUTH-009 今のページの項目に下線を出し、ほかはホバーで出す下線のまま', () => {
    const { header } = renderHeader({ path: '/look' });
    const look = underlineOf(within(header).getByRole('link', { name: 'LOOK' }));
    expect(look.className).toContain('scale-x-100');
    expect(look.className).not.toContain('group-hover:scale-x-100');
    const news = underlineOf(within(header).getByRole('link', { name: 'NEWS' }));
    expect(news.className).toContain('scale-x-0');
    expect(news.className).toContain('group-hover:scale-x-100');
  });

  it('SCR-AUTH-009 下の階層（/news/1）でも項目に下線を出すが、同じ頭の別の道（/newsx）には出さない', () => {
    const inside = renderHeader({ path: '/news/1' });
    expect(underlineOf(within(inside.header).getByRole('link', { name: 'NEWS' })).className).toContain(
      'scale-x-100',
    );
    inside.unmount();

    const similar = renderHeader({ path: '/newsx' });
    expect(underlineOf(within(similar.header).getByRole('link', { name: 'NEWS' })).className).toContain(
      'scale-x-0',
    );
  });

  it('SCR-AUTH-009 下線は文字の幅に合わせる共通のクラスの要素で出す', () => {
    const { header } = renderHeader();
    for (const name of ['NEWS', 'ITEM', 'LOOK', 'STOCKIST', 'ABOUT', 'CONTACT', 'UI']) {
      const link = within(header).getByRole('link', { name });
      expect(link).toHaveClass('group');
      expect(underlineOf(link)).not.toBeNull();
    }
  });

  it.each([
    ['admin', true, true],
    ['supporter', false, true],
    ['user', false, false],
    [null, false, false],
  ] as Array<[Role, boolean, boolean]>)(
    'SCR-AUTH-009 役割が %s の時 LOADING は %s・MANAGE は %s で出す',
    (role, loading, manage) => {
      const { header } = renderHeader({ loggedIn: role !== null, role });
      const navLoading = within(header).queryByRole('link', { name: 'LOADING' });
      const navManage = within(header).queryByRole('link', { name: 'MANAGE' });
      expect(Boolean(navLoading)).toBe(loading);
      expect(Boolean(navManage)).toBe(manage);
      if (navLoading) expect(navLoading).toHaveAttribute('href', '/loading');
      if (navManage) expect(navManage).toHaveAttribute('href', '/admin');
    },
  );

  it('SCR-AUTH-009 LOADING・MANAGE の下線は道がその下の時だけ出す', () => {
    const loading = renderHeader({ path: '/loading', loggedIn: true, role: 'admin' });
    expect(underlineOf(within(loading.header).getByRole('link', { name: 'LOADING' })).className).toContain(
      'scale-x-100',
    );
    expect(underlineOf(within(loading.header).getByRole('link', { name: 'MANAGE' })).className).toContain(
      'scale-x-0',
    );
    loading.unmount();

    const manage = renderHeader({ path: '/admin/orders', loggedIn: true, role: 'admin' });
    expect(underlineOf(within(manage.header).getByRole('link', { name: 'MANAGE' })).className).toContain(
      'scale-x-100',
    );
    expect(underlineOf(within(manage.header).getByRole('link', { name: 'LOADING' })).className).toContain(
      'scale-x-0',
    );
  });

  it('SCR-AUTH-009 検索とお気に入りのアイコンを出す', () => {
    const { header } = renderHeader();
    expect(within(header).getByRole('link', { name: '検索' })).toHaveAttribute('href', '/search');
    expect(within(header).getByRole('link', { name: 'ウィッシュリスト' })).toHaveAttribute('href', '/wishlist');
  });

  it('SCR-AUTH-009 カートの点数が 3 の時は読み上げの名前に点数を入れ、右上の角にバッジを重ねる', () => {
    const { header } = renderHeader({ cartCount: 3 });
    const cart = within(header).getByRole('link', { name: 'カート（3点）' });
    expect(cart).toHaveAttribute('href', '/cart');
    const badge = cart.querySelector('[data-ui-badge]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute('data-ui-badge-variant', 'count');
    expect(badge).toHaveAttribute('data-ui-size', '2xs');
    expect(badge).toHaveTextContent('3');
    const wrapper = badge.parentElement as HTMLElement;
    expect(wrapper.className).toContain('absolute');
    expect(wrapper.className).toContain('top-0');
    expect(wrapper.className).toContain('right-0');
  });

  it('SCR-AUTH-009 カートの点数が 99 ちょうどなら 99、100 なら 99+ で出す', () => {
    const ninetyNine = renderHeader({ cartCount: 99 });
    expect(
      within(ninetyNine.header).getByRole('link', { name: 'カート（99点）' }).querySelector('[data-ui-badge]'),
    ).toHaveTextContent(/^99$/);
    ninetyNine.unmount();

    const hundred = renderHeader({ cartCount: 100 });
    expect(
      within(hundred.header).getByRole('link', { name: 'カート（100点）' }).querySelector('[data-ui-badge]'),
    ).toHaveTextContent('99+');
  });

  it('SCR-AUTH-009 カートが空の時は名前を「カート」だけにしてバッジを出さない', () => {
    const { header } = renderHeader({ cartCount: 0 });
    const cart = within(header).getByRole('link', { name: 'カート' });
    expect(cart).toHaveAttribute('href', '/cart');
    expect(cart.querySelector('[data-ui-badge]')).toBeNull();
  });

  it('SCR-AUTH-009 ログインしていなければ今の頁を next に載せた /login のアイコン、していれば /account のアイコンを出す', () => {
    const out = renderHeader({ loggedIn: false, path: '/stockist' });
    expect(within(out.header).getByRole('link', { name: 'ログイン' })).toHaveAttribute(
      'href',
      '/login?next=%2Fstockist',
    );
    expect(within(out.header).queryByRole('link', { name: 'アカウント' })).toBeNull();
    out.unmount();

    const inn = renderHeader({ loggedIn: true, role: 'user' });
    expect(within(inn.header).getByRole('link', { name: 'アカウント' })).toHaveAttribute('href', '/account');
    expect(within(inn.header).queryByRole('link', { name: 'ログイン' })).toBeNull();
  });

  it('SCR-AUTH-009 /login にいる時のログインのアイコンは next を付けない', () => {
    const out = renderHeader({ loggedIn: false, path: '/login' });
    expect(within(out.header).getByRole('link', { name: 'ログイン' })).toHaveAttribute('href', '/login');
  });

  it('SCR-AUTH-009 ドロワーを開くボタンを右側のアイコン群の最後に置く', () => {
    const { header } = renderHeader();
    const group = header.querySelector('.header-nav-icon-position') as HTMLElement;
    expect(group).not.toBeNull();
    const last = group.lastElementChild as HTMLElement;
    expect(last).toHaveAttribute('aria-label', 'Open menu');
    expect(last.tagName).toBe('BUTTON');
  });

  it('SCR-AUTH-009 /admin の下では白い地を別の要素に分けて低い重なり順に置き、ヘッダーも公開のページより低くする', () => {
    const admin = renderHeader({ path: '/admin/items' });
    const background = admin.container.querySelector('[data-site-header-background]') as HTMLElement;
    expect(background).not.toBeNull();
    expect(background).toHaveAttribute('aria-hidden', 'true');
    expect(background.className).toContain('bg-white');
    expect(background.className).toContain('z-10');
    expect(admin.header.className).toContain('z-30');
    expect(admin.header.className).not.toContain('z-50');
    expect(admin.header.className).not.toContain('bg-white');
    admin.unmount();

    const normal = renderHeader({ path: '/news' });
    expect(normal.container.querySelector('[data-site-header-background]')).toBeNull();
    expect(normal.header.className).toContain('z-50');
    expect(normal.header.className).toContain('bg-white');
  });

  it('SCR-AUTH-009 /admin で始まらない道（/adm）では地の板を分けない', () => {
    const { container, header } = renderHeader({ path: '/adm' });
    expect(container.querySelector('[data-site-header-background]')).toBeNull();
    expect(header.className).toContain('z-50');
  });

  it('SCR-AUTH-009 site-chrome の印を付けて管理画面のフォントの一括指定から外す', () => {
    const { header } = renderHeader({ path: '/admin' });
    expect(header).toHaveClass('site-chrome');
  });

  it('SCR-AUTH-009 ログインのモーダルは持つが開く所が無く、ログインしていてもいなくても閉じたまま', () => {
    const out = renderHeader({ loggedIn: false });
    expect(out.getByTestId('login-modal')).toHaveAttribute('data-open', 'false');
    out.unmount();

    const inn = renderHeader({ loggedIn: true, role: 'user' });
    expect(inn.getByTestId('login-modal')).toHaveAttribute('data-open', 'false');
  });
});
