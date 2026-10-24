import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Header from '@/components/Header';
import { categories as newsCategories } from '@/lib/news-data';
import { LOOK_SEASON_OPTIONS } from '@/lib/look/public';
import { VISIBLE_SOCIAL_LINKS } from '@/lib/social';

type Role = 'admin' | 'supporter' | 'user' | null;

// 画面は Header と共有の Drawer・Accordion を本物のまま通す。外との境目だけ偽物にする。
let mockPathname = '/';
let mockLogin: { isLoggedIn: boolean; userRole: Role } = { isLoggedIn: false, userRole: null };

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => mockLogin,
}));

jest.mock('@/contexts/CartContext', () => ({
  useCart: () => ({ cartCount: 0 }),
}));

// 画面遷移を起こさず、押下の副作用（ドロワーを閉じる）だけを見る。
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    onClick,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

jest.mock('@/components/LoginModal', () => ({
  __esModule: true,
  default: () => null,
}));

function renderHeader(options: { path?: string; role?: Role } = {}) {
  mockPathname = options.path ?? '/';
  mockLogin = { isLoggedIn: (options.role ?? null) !== null, userRole: options.role ?? null };
  return render(<Header />);
}

async function openDrawer() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  return { user, drawer: screen.getByRole('dialog') };
}

function expandedTitles(drawer: HTMLElement) {
  return Array.from(drawer.querySelectorAll('[data-ui-accordion-trigger]'))
    .filter((trigger) => trigger.getAttribute('aria-expanded') === 'true')
    .map((trigger) => trigger.textContent);
}

describe('SCR-AUTH-010 ドロワー', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
  });

  it('SCR-AUTH-010 ヘッダーのボタンで右から md の大きさで開き、閉じるボタンで閉じる', async () => {
    renderHeader();
    expect(screen.queryByRole('dialog')).toBeNull();

    const { user, drawer } = await openDrawer();
    const overlay = document.querySelector('.drawer-overlay') as HTMLElement;
    expect(overlay).toHaveAttribute('data-ui-drawer-side', 'right');
    expect(overlay).toHaveAttribute('data-ui-drawer-size', 'md');
    expect(drawer).toHaveAttribute('aria-modal', 'true');

    await user.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('SCR-AUTH-010 外の板を押しても閉じる', async () => {
    renderHeader();
    const { user } = await openDrawer();
    await user.click(document.querySelector('.drawer-overlay') as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('SCR-AUTH-010 中を押しても閉じない', async () => {
    renderHeader();
    const { user, drawer } = await openDrawer();
    await user.click(within(drawer).getByText('FOLLOW US'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('SCR-AUTH-010 上の行には閉じるボタンだけを置き、サイトの題は置かない', async () => {
    renderHeader();
    const { drawer } = await openDrawer();
    const topRow = drawer.querySelector('.header-drawer-top-row') as HTMLElement;
    expect(topRow).not.toBeNull();
    expect(topRow.children).toHaveLength(1);
    expect(within(topRow).getByRole('button', { name: 'Close drawer' })).toBeInTheDocument();
    expect(within(drawer).queryByText('Le Fil des Heures')).toBeNull();
  });

  it('SCR-AUTH-010 閉じるボタンはヘッダーのボタンと同じ icon-frame の枠にそろえる', async () => {
    renderHeader();
    const { drawer } = await openDrawer();
    const close = within(drawer).getByRole('button', { name: 'Close drawer' });
    expect(close).toHaveClass('icon-frame');
    expect(close).toHaveClass('header-drawer-close-button');
  });

  it('SCR-AUTH-010 分類の節は NEWS・ITEM・LOOK の順に共有のアコーディオンで出す', async () => {
    renderHeader({ path: '/stockist' });
    const { drawer } = await openDrawer();
    const triggers = Array.from(drawer.querySelectorAll('[data-ui-accordion-trigger]'));
    expect(triggers.map((trigger) => trigger.textContent)).toEqual(['NEWS', 'ITEM', 'LOOK']);
  });

  it.each([
    ['/news', 'NEWS'],
    ['/news/3', 'NEWS'],
    ['/item', 'ITEM'],
    ['/item/abc', 'ITEM'],
    ['/look', 'LOOK'],
    ['/look/9', 'LOOK'],
  ])('SCR-AUTH-010 道が %s の時は %s の節だけを初めから開く', async (path, title) => {
    renderHeader({ path });
    const { drawer } = await openDrawer();
    expect(expandedTitles(drawer)).toEqual([title]);
  });

  it('SCR-AUTH-010 道が分類の節の外の時は節を全部閉じておく', async () => {
    renderHeader({ path: '/stockist' });
    const { drawer } = await openDrawer();
    expect(expandedTitles(drawer)).toEqual([]);
    expect(within(drawer).queryByRole('link', { name: 'COLLECTION' })).toBeNull();
  });

  it('SCR-AUTH-010 節は1つずつ開き、別の節を開くと前の節が閉じる', async () => {
    renderHeader({ path: '/news' });
    const { user, drawer } = await openDrawer();
    expect(expandedTitles(drawer)).toEqual(['NEWS']);

    await user.click(within(drawer).getByRole('button', { name: 'ITEM' }));
    expect(expandedTitles(drawer)).toEqual(['ITEM']);
  });

  it('SCR-AUTH-010 NEWS の子は NEWS の分類の値から作り、ALL だけ付けずほかは category に入れる', async () => {
    renderHeader({ path: '/stockist' });
    const { user, drawer } = await openDrawer();
    await user.click(within(drawer).getByRole('button', { name: 'NEWS' }));
    const links = drawer.querySelector('.header-drawer-accordion-links') as HTMLElement;
    const anchors = within(links).getAllByRole('link');
    expect(anchors.map((anchor) => anchor.textContent)).toEqual([...newsCategories]);
    for (const value of newsCategories) {
      const expected = value === 'ALL' ? '/news' : `/news?category=${encodeURIComponent(value)}`;
      expect(within(links).getByRole('link', { name: value })).toHaveAttribute('href', expected);
    }
  });

  it('SCR-AUTH-010 ITEM の子は ALL・TOPS・BOTTOMS・OUTERWEAR・ACCESSORIES で、ALL だけ付けない', async () => {
    renderHeader({ path: '/stockist' });
    const { user, drawer } = await openDrawer();
    await user.click(within(drawer).getByRole('button', { name: 'ITEM' }));
    const links = drawer.querySelector('.header-drawer-accordion-links') as HTMLElement;
    const values = ['ALL', 'TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'];
    expect(within(links).getAllByRole('link').map((anchor) => anchor.textContent)).toEqual(values);
    for (const value of values) {
      const expected = value === 'ALL' ? '/item' : `/item?category=${value}`;
      expect(within(links).getByRole('link', { name: value })).toHaveAttribute('href', expected);
    }
  });

  it('SCR-AUTH-010 LOOK の子はシーズンの値から作り、ALL だけ付けずほかは season に入れる', async () => {
    renderHeader({ path: '/stockist' });
    const { user, drawer } = await openDrawer();
    await user.click(within(drawer).getByRole('button', { name: 'LOOK' }));
    const links = drawer.querySelector('.header-drawer-accordion-links') as HTMLElement;
    expect(within(links).getAllByRole('link').map((anchor) => anchor.textContent)).toEqual([
      ...LOOK_SEASON_OPTIONS,
    ]);
    for (const value of LOOK_SEASON_OPTIONS) {
      const expected = value === 'ALL' ? '/look' : `/look?season=${value}`;
      expect(within(links).getByRole('link', { name: value })).toHaveAttribute('href', expected);
    }
  });

  it('SCR-AUTH-010 子のリンクを押すとドロワーを閉じる', async () => {
    renderHeader({ path: '/news' });
    const { user, drawer } = await openDrawer();
    await user.click(within(drawer).getByRole('link', { name: 'COLLECTION' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('SCR-AUTH-010 ほかのページは STOCKIST・ABOUT・CONTACT・UI だけで、NEWS・ITEM・LOOK は静的リンクに含めない', async () => {
    renderHeader({ path: '/' });
    const { drawer } = await openDrawer();
    const nav = within(drawer).getByRole('navigation', { name: 'Mobile navigation' });
    const primary = Array.from(nav.querySelectorAll('.header-drawer-primary-link'));
    expect(primary.map((link) => link.textContent)).toEqual(['STOCKIST', 'ABOUT', 'CONTACT', 'UI']);
    expect(primary.map((link) => link.getAttribute('href'))).toEqual([
      '/stockist',
      '/about',
      '/contact',
      '/ui',
    ]);
  });

  it('SCR-AUTH-010 今のページ（下の階層を含む）のリンクに aria-current と data-active を付け、同じ頭の別の道には付けない', async () => {
    const same = renderHeader({ path: '/stockist' });
    let opened = await openDrawer();
    const sameLink = within(opened.drawer).getByRole('link', { name: 'STOCKIST' });
    expect(sameLink).toHaveAttribute('aria-current', 'page');
    expect(sameLink).toHaveAttribute('data-active', 'true');
    expect(within(opened.drawer).getByRole('link', { name: 'ABOUT' })).not.toHaveAttribute('aria-current');
    same.unmount();

    const below = renderHeader({ path: '/stockist/12' });
    opened = await openDrawer();
    expect(within(opened.drawer).getByRole('link', { name: 'STOCKIST' })).toHaveAttribute('data-active', 'true');
    below.unmount();

    renderHeader({ path: '/stockistx' });
    opened = await openDrawer();
    const other = within(opened.drawer).getByRole('link', { name: 'STOCKIST' });
    expect(other).not.toHaveAttribute('aria-current');
    expect(other).not.toHaveAttribute('data-active');
  });

  it('SCR-AUTH-010 ほかのページのリンクを押すとドロワーを閉じる', async () => {
    renderHeader({ path: '/' });
    const { user, drawer } = await openDrawer();
    await user.click(within(drawer).getByRole('link', { name: 'ABOUT' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['admin', true, true],
    ['supporter', false, true],
    ['user', false, false],
    [null, false, false],
  ] as Array<[Role, boolean, boolean]>)(
    'SCR-AUTH-010 役割が %s の時 LOADING は %s・MANAGE は %s で出す',
    async (role, loading, manage) => {
      renderHeader({ role });
      const { drawer } = await openDrawer();
      const drawerLoading = within(drawer).queryByRole('link', { name: 'LOADING' });
      const drawerManage = within(drawer).queryByRole('link', { name: 'MANAGE' });
      expect(Boolean(drawerLoading)).toBe(loading);
      expect(Boolean(drawerManage)).toBe(manage);
      if (drawerLoading) expect(drawerLoading).toHaveAttribute('href', '/loading');
      if (drawerManage) expect(drawerManage).toHaveAttribute('href', '/admin');
    },
  );

  it('SCR-AUTH-010 LOADING・MANAGE も今のページの印を付け、押すとドロワーを閉じる', async () => {
    const loading = renderHeader({ path: '/loading', role: 'admin' });
    let opened = await openDrawer();
    expect(within(opened.drawer).getByRole('link', { name: 'LOADING' })).toHaveAttribute('aria-current', 'page');
    expect(within(opened.drawer).getByRole('link', { name: 'MANAGE' })).not.toHaveAttribute('data-active');
    await opened.user.click(within(opened.drawer).getByRole('link', { name: 'LOADING' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    loading.unmount();

    renderHeader({ path: '/admin/orders', role: 'admin' });
    opened = await openDrawer();
    expect(within(opened.drawer).getByRole('link', { name: 'MANAGE' })).toHaveAttribute('data-active', 'true');
    expect(within(opened.drawer).getByRole('link', { name: 'LOADING' })).not.toHaveAttribute('aria-current');
    await opened.user.click(within(opened.drawer).getByRole('link', { name: 'MANAGE' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('SCR-AUTH-010 SNS は共有の見せるリンクを新しい窓で開く形で出し、押すとドロワーを閉じる', async () => {
    const preventNavigation = (event: Event) => event.preventDefault();
    document.addEventListener('click', preventNavigation);
    try {
      renderHeader();
      const { user, drawer } = await openDrawer();
      expect(within(drawer).getByText('FOLLOW US')).toBeInTheDocument();
      expect(VISIBLE_SOCIAL_LINKS.length).toBeGreaterThan(0);
      for (const social of VISIBLE_SOCIAL_LINKS) {
        const anchor = within(drawer).getByRole('link', { name: social.label });
        expect(anchor).toHaveAttribute('href', social.href);
        expect(anchor).toHaveAttribute('target', '_blank');
        expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
        expect(anchor.querySelector('i')).toHaveClass(social.iconClass);
      }
      await user.click(within(drawer).getByRole('link', { name: VISIBLE_SOCIAL_LINKS[0].label }));
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      document.removeEventListener('click', preventNavigation);
    }
  });

  it('SCR-AUTH-010 SNS のアイコンは枠の縦横の中央に、通常は純黒・ホバーは純白で描く', async () => {
    renderHeader();
    const { drawer } = await openDrawer();
    const anchor = within(drawer).getByRole('link', { name: VISIBLE_SOCIAL_LINKS[0].label });
    for (const cls of ['flex', 'items-center', 'justify-center', 'text-black', 'hover:text-white', 'hover:bg-black']) {
      expect(anchor).toHaveClass(cls);
    }
  });

  it('SCR-AUTH-010 ドロワーの板に site-chrome の印を付ける', async () => {
    renderHeader();
    const { drawer } = await openDrawer();
    expect(drawer).toHaveClass('site-chrome');
  });
});
