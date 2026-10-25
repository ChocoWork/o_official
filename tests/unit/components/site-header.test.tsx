import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Header from '@/components/Header';
import { categories as newsCategories } from '@/lib/news-data';
import { LOOK_SEASON_OPTIONS } from '@/lib/look/public';
import { VISIBLE_SOCIAL_LINKS } from '@/lib/social';

type Role = 'admin' | 'supporter' | 'user' | null;

let mockPathname = '/';
let mockLogin: { isLoggedIn: boolean; userRole: Role } = {
  isLoggedIn: false,
  userRole: null,
};
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

// ログインのモーダルは開く所が無い。渡された開閉の値と閉じる関数だけ見る。
jest.mock('@/components/LoginModal', () => ({
  __esModule: true,
  default: ({ open, onClose }: { open: boolean; onClose?: () => void }) => (
    <div data-testid="login-modal" data-open={String(open)}>
      <button type="button" onClick={onClose}>
        mock-login-close
      </button>
    </div>
  ),
}));

function setScrollY(value: number) {
  Object.defineProperty(window, 'scrollY', {
    value,
    configurable: true,
    writable: true,
  });
}

function scrollTo(value: number) {
  act(() => {
    setScrollY(value);
    fireEvent.scroll(window);
  });
}

function renderHeader(options: {
  path?: string;
  loggedIn?: boolean;
  role?: Role;
  cartCount?: number;
} = {}) {
  mockPathname = options.path ?? '/';
  mockLogin = {
    isLoggedIn: options.loggedIn ?? false,
    userRole: options.role ?? null,
  };
  mockCartCount = options.cartCount ?? 0;
  const view = render(<Header />);
  const header = view.container.querySelector('header') as HTMLElement;
  return { ...view, header };
}

async function openDrawer() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  return { user, drawer: screen.getByRole('dialog') };
}

function underlineOf(link: HTMLElement) {
  return link.querySelector('span.underline-animation-left2right') as HTMLElement;
}

describe('Header', () => {
  beforeEach(() => {
    setScrollY(0);
    delete document.documentElement.dataset.headerVisible;
  });

  it('DD-AUTH-007 位置 0・下へ 60px・上へ・下へ 30px で出し隠しと html の印が決まる', () => {
    const { header } = renderHeader();
    expect(header.className).toContain('translate-y-0');
    expect(header.className).not.toContain('-translate-y-full');
    expect(document.documentElement.dataset.headerVisible).toBe('true');

    scrollTo(60);
    expect(header.className).toContain('-translate-y-full');
    expect(document.documentElement.dataset.headerVisible).toBe('false');

    scrollTo(40);
    expect(header.className).toContain('translate-y-0');
    expect(header.className).not.toContain('-translate-y-full');
    expect(document.documentElement.dataset.headerVisible).toBe('true');

    scrollTo(0);
    scrollTo(30);
    expect(header.className).not.toContain('-translate-y-full');
    expect(document.documentElement.dataset.headerVisible).toBe('true');
  });

  it('DD-AUTH-007 描いた直後に1回位置を見て、すでに下にいれば隠して始まる', () => {
    setScrollY(100);
    const { header } = renderHeader();
    expect(header.className).toContain('-translate-y-full');
    expect(document.documentElement.dataset.headerVisible).toBe('false');
  });

  it('DD-AUTH-007 隠している間に動かない・50px 以下で下へ動いてもそのままで、位置が 0 以下なら出す', () => {
    const { header } = renderHeader();

    scrollTo(60);
    expect(header.className).toContain('-translate-y-full');

    // 位置が変わらない（下でも上でもない）時は隠したまま
    scrollTo(60);
    expect(header.className).toContain('-translate-y-full');
    expect(document.documentElement.dataset.headerVisible).toBe('false');

    // 位置が 0 以下なら出す
    scrollTo(0);
    expect(header.className).not.toContain('-translate-y-full');
    expect(document.documentElement.dataset.headerVisible).toBe('true');

    // 50px ちょうどまでの下への動きは隠さない
    scrollTo(50);
    expect(header.className).not.toContain('-translate-y-full');
  });

  it('DD-AUTH-007 外すとスクロールの監視を解く', () => {
    const removeSpy = jest.spyOn(window, 'removeEventListener');
    const { unmount } = renderHeader();
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('DD-AUTH-007 題を / へのリンクにし、ナビに7項目を並べる', () => {
    const { header } = renderHeader();
    expect(
      within(header).getByRole('link', { name: 'Le Fil des Heures home' }),
    ).toHaveAttribute('href', '/');

    const labels = ['NEWS', 'ITEM', 'LOOK', 'STOCKIST', 'ABOUT', 'CONTACT', 'UI'];
    const paths = ['/news', '/item', '/look', '/stockist', '/about', '/contact', '/ui'];
    labels.forEach((label, index) => {
      expect(within(header).getByRole('link', { name: label })).toHaveAttribute(
        'href',
        paths[index],
      );
    });
  });

  it('DD-AUTH-007 道が /admin で始まる時だけ白い地の板を別に描き、ヘッダーの重なり順を下げる', () => {
    const admin = renderHeader({ path: '/admin/items' });
    const background = admin.container.querySelector('[data-site-header-background]');
    expect(background).not.toBeNull();
    expect(background).toHaveAttribute('aria-hidden', 'true');
    expect(admin.header.className).toContain('z-30');
    expect(admin.header.className).not.toContain('z-50');
    expect(admin.header.className).not.toContain('bg-white');
    admin.unmount();

    const normal = renderHeader({ path: '/news' });
    expect(normal.container.querySelector('[data-site-header-background]')).toBeNull();
    expect(normal.header.className).toContain('z-50');
    expect(normal.header.className).toContain('bg-white');
  });

  it('DD-AUTH-007 隠している間は地の板もヘッダーと一緒に上へずらす', () => {
    const { container, header } = renderHeader({ path: '/admin' });
    const background = container.querySelector('[data-site-header-background]') as HTMLElement;
    expect(background.className).toContain('translate-y-0');

    scrollTo(60);
    expect(background.className).toContain('-translate-y-full');
    expect(header.className).toContain('-translate-y-full');

    scrollTo(10);
    expect(background.className).not.toContain('-translate-y-full');
    expect(background.className).toContain('translate-y-0');
  });

  it('DD-AUTH-007 道が /news/1 の時 NEWS に下線を出し、同じ頭の /newsx では出さない', () => {
    const inside = renderHeader({ path: '/news/1' });
    expect(underlineOf(within(inside.header).getByRole('link', { name: 'NEWS' })).className).toContain(
      'scale-x-100',
    );
    expect(underlineOf(within(inside.header).getByRole('link', { name: 'ITEM' })).className).toContain(
      'scale-x-0',
    );
    inside.unmount();

    const similar = renderHeader({ path: '/newsx' });
    expect(underlineOf(within(similar.header).getByRole('link', { name: 'NEWS' })).className).toContain(
      'scale-x-0',
    );
  });

  it('DD-AUTH-007 道が項目の道と同じか下の時、ドロワーで今のページの印を付ける', async () => {
    const same = renderHeader({ path: '/stockist' });
    let opened = await openDrawer();
    expect(within(opened.drawer).getByRole('link', { name: 'STOCKIST' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(opened.drawer).getByRole('link', { name: 'STOCKIST' })).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(within(opened.drawer).getByRole('link', { name: 'ABOUT' })).not.toHaveAttribute(
      'aria-current',
    );
    same.unmount();

    const below = renderHeader({ path: '/stockist/12' });
    opened = await openDrawer();
    expect(within(opened.drawer).getByRole('link', { name: 'STOCKIST' })).toHaveAttribute(
      'data-active',
      'true',
    );
    below.unmount();

    renderHeader({ path: '/stockistx' });
    opened = await openDrawer();
    const link = within(opened.drawer).getByRole('link', { name: 'STOCKIST' });
    expect(link).not.toHaveAttribute('aria-current');
    expect(link).not.toHaveAttribute('data-active');
  });

  it.each([
    ['admin', true, true],
    ['supporter', false, true],
    ['user', false, false],
    [null, false, false],
  ] as Array<[Role, boolean, boolean]>)(
    'DD-AUTH-007 役割が %s の時 LOADING は %s・MANAGE は %s でナビとドロワーに出る',
    async (role, loading, manage) => {
      const { header } = renderHeader({ loggedIn: role !== null, role });

      const navLoading = within(header).queryByRole('link', { name: 'LOADING' });
      const navManage = within(header).queryByRole('link', { name: 'MANAGE' });
      expect(Boolean(navLoading)).toBe(loading);
      expect(Boolean(navManage)).toBe(manage);
      if (navLoading) expect(navLoading).toHaveAttribute('href', '/loading');
      if (navManage) expect(navManage).toHaveAttribute('href', '/admin');

      const { drawer } = await openDrawer();
      const drawerLoading = within(drawer).queryByRole('link', { name: 'LOADING' });
      const drawerManage = within(drawer).queryByRole('link', { name: 'MANAGE' });
      expect(Boolean(drawerLoading)).toBe(loading);
      expect(Boolean(drawerManage)).toBe(manage);
      if (drawerLoading) expect(drawerLoading).toHaveAttribute('href', '/loading');
      if (drawerManage) expect(drawerManage).toHaveAttribute('href', '/admin');
    },
  );

  it('DD-AUTH-007 LOADING・MANAGE は道がその下の時に下線とドロワーの今のページの印を付ける', async () => {
    const loading = renderHeader({ path: '/loading', loggedIn: true, role: 'admin' });
    expect(
      underlineOf(within(loading.header).getByRole('link', { name: 'LOADING' })).className,
    ).toContain('scale-x-100');
    expect(
      underlineOf(within(loading.header).getByRole('link', { name: 'MANAGE' })).className,
    ).toContain('scale-x-0');
    let opened = await openDrawer();
    expect(within(opened.drawer).getByRole('link', { name: 'LOADING' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(opened.drawer).getByRole('link', { name: 'LOADING' })).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(within(opened.drawer).getByRole('link', { name: 'MANAGE' })).not.toHaveAttribute(
      'data-active',
    );
    loading.unmount();

    const manage = renderHeader({ path: '/admin/orders', loggedIn: true, role: 'admin' });
    expect(
      underlineOf(within(manage.header).getByRole('link', { name: 'MANAGE' })).className,
    ).toContain('scale-x-100');
    expect(
      underlineOf(within(manage.header).getByRole('link', { name: 'LOADING' })).className,
    ).toContain('scale-x-0');
    opened = await openDrawer();
    expect(within(opened.drawer).getByRole('link', { name: 'MANAGE' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(opened.drawer).getByRole('link', { name: 'MANAGE' })).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(within(opened.drawer).getByRole('link', { name: 'LOADING' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('DD-AUTH-007 カートの点数が 3 の時は読み上げの名前に点数を入れてバッジを重ねる', () => {
    const { header } = renderHeader({ cartCount: 3 });
    const cart = within(header).getByRole('link', { name: 'カート（3点）' });
    expect(cart).toHaveAttribute('href', '/cart');
    const badge = cart.querySelector('[data-ui-badge]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute('data-ui-badge-variant', 'count');
    expect(badge).toHaveAttribute('data-ui-size', '2xs');
    expect(badge).toHaveTextContent('3');
  });

  it('DD-AUTH-007 カートの点数が 0 の時は「カート」だけでバッジを出さない', () => {
    const { header } = renderHeader({ cartCount: 0 });
    const cart = within(header).getByRole('link', { name: 'カート' });
    expect(cart).toHaveAttribute('href', '/cart');
    expect(cart.querySelector('[data-ui-badge]')).toBeNull();
  });

  it('DD-AUTH-036 /login と /auth/* にいる時のログインのアイコンは next を付けない', () => {
    const onLogin = renderHeader({ loggedIn: false, path: '/login' });
    expect(within(onLogin.header).getByRole('link', { name: 'ログイン' })).toHaveAttribute('href', '/login');
    onLogin.unmount();

    const onAuth = renderHeader({ loggedIn: false, path: '/auth/verified' });
    expect(within(onAuth.header).getByRole('link', { name: 'ログイン' })).toHaveAttribute('href', '/login');
  });

  it('DD-AUTH-007 検索とお気に入りのアイコンを出す', () => {
    const { header } = renderHeader();
    expect(within(header).getByRole('link', { name: '検索' })).toHaveAttribute('href', '/search');
    expect(within(header).getByRole('link', { name: 'ウィッシュリスト' })).toHaveAttribute(
      'href',
      '/wishlist',
    );
  });

  it('DD-AUTH-007 ログインしていれば /account のアイコン、いなければ今の頁を next に載せた /login のアイコンを出す', () => {
    const out = renderHeader({ loggedIn: false, path: '/stockist' });
    expect(within(out.header).getByRole('link', { name: 'ログイン' })).toHaveAttribute(
      'href',
      '/login?next=%2Fstockist',
    );
    expect(within(out.header).queryByRole('link', { name: 'アカウント' })).toBeNull();
    out.unmount();

    const inn = renderHeader({ loggedIn: true, role: 'user' });
    expect(within(inn.header).getByRole('link', { name: 'アカウント' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(within(inn.header).queryByRole('link', { name: 'ログイン' })).toBeNull();
  });

  it.each([
    ['/news', 'news'],
    ['/news/3', 'news'],
    ['/item', 'item'],
    ['/item/abc', 'item'],
    ['/look', 'look'],
    ['/look/9', 'look'],
  ])('DD-AUTH-007 道が %s の時ドロワーは %s の節を初めから開く', async (path, key) => {
    renderHeader({ path });
    const { drawer } = await openDrawer();
    const triggers = drawer.querySelectorAll('[data-ui-accordion-trigger]');
    const expanded = Array.from(triggers)
      .filter((trigger) => trigger.getAttribute('aria-expanded') === 'true')
      .map((trigger) => trigger.textContent);
    expect(expanded).toEqual([key.toUpperCase()]);
  });

  it('DD-AUTH-007 道が分類の節の外の時ドロワーの節は全部閉じている', async () => {
    renderHeader({ path: '/stockist' });
    const { drawer } = await openDrawer();
    const triggers = Array.from(drawer.querySelectorAll('[data-ui-accordion-trigger]'));
    expect(triggers).toHaveLength(3);
    triggers.forEach((trigger) => {
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
    expect(within(drawer).queryByRole('link', { name: 'COLLECTION' })).toBeNull();
  });

  it('DD-AUTH-007 分類のリンクは ALL なら一覧の道だけ、ほかは値を問い合わせに入れる', async () => {
    renderHeader({ path: '/stockist' });
    const { user, drawer } = await openDrawer();

    const sections = [
      { label: 'NEWS', basePath: '/news', queryKey: 'category', values: newsCategories },
      {
        label: 'ITEM',
        basePath: '/item',
        queryKey: 'category',
        values: ['ALL', 'TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'],
      },
      { label: 'LOOK', basePath: '/look', queryKey: 'season', values: LOOK_SEASON_OPTIONS },
    ];

    for (const section of sections) {
      await user.click(within(drawer).getByRole('button', { name: section.label }));
      const links = drawer.querySelector('.header-drawer-accordion-links') as HTMLElement;
      expect(links).not.toBeNull();
      for (const value of section.values) {
        const expected =
          value === 'ALL'
            ? section.basePath
            : `${section.basePath}?${section.queryKey}=${encodeURIComponent(value)}`;
        expect(within(links).getByRole('link', { name: value })).toHaveAttribute('href', expected);
      }
    }
  });

  it('DD-AUTH-007 ドロワーはほかのページのリンクと SNS を出し、NEWS・ITEM・LOOK は静的リンクに含めない', async () => {
    renderHeader({ path: '/stockist' });
    const { drawer } = await openDrawer();
    const nav = within(drawer).getByRole('navigation', { name: 'Mobile navigation' });
    for (const label of ['STOCKIST', 'ABOUT', 'CONTACT', 'UI']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(drawer.querySelectorAll('.header-drawer-primary-link')).toHaveLength(4);

    expect(within(drawer).getByText('FOLLOW US')).toBeInTheDocument();
    for (const social of VISIBLE_SOCIAL_LINKS) {
      const anchor = within(drawer).getByRole('link', { name: social.label });
      expect(anchor).toHaveAttribute('href', social.href);
      expect(anchor).toHaveAttribute('target', '_blank');
      expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('DD-AUTH-007 ドロワーはボタンで開き、閉じるボタンで閉じる', async () => {
    renderHeader();
    expect(screen.queryByRole('dialog')).toBeNull();

    const { user } = await openDrawer();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('DD-AUTH-007 ドロワーの外（板）を押しても閉じる', async () => {
    renderHeader();
    const { user } = await openDrawer();
    const overlay = document.querySelector('.drawer-overlay') as HTMLElement;
    expect(overlay).not.toBeNull();
    await user.click(overlay);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('DD-AUTH-007 ページのリンクを押すとドロワーが閉じる', async () => {
    renderHeader({ path: '/' });
    const { user, drawer } = await openDrawer();
    await user.click(within(drawer).getByRole('link', { name: 'ABOUT' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('DD-AUTH-007 役割の入口を押すとドロワーが閉じる', async () => {
    renderHeader({ loggedIn: true, role: 'admin' });
    let opened = await openDrawer();
    await opened.user.click(within(opened.drawer).getByRole('link', { name: 'LOADING' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    opened = await openDrawer();
    await opened.user.click(within(opened.drawer).getByRole('link', { name: 'MANAGE' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('DD-AUTH-007 分類のリンクを押すとドロワーが閉じる', async () => {
    renderHeader({ path: '/news' });
    const { user, drawer } = await openDrawer();
    await user.click(within(drawer).getByRole('link', { name: 'COLLECTION' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('DD-AUTH-007 SNS のリンクを押すとドロワーが閉じる', async () => {
    const preventNavigation = (event: Event) => event.preventDefault();
    document.addEventListener('click', preventNavigation);
    try {
      renderHeader();
      const { user, drawer } = await openDrawer();
      await user.click(within(drawer).getByRole('link', { name: VISIBLE_SOCIAL_LINKS[0].label }));
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      document.removeEventListener('click', preventNavigation);
    }
  });

  it('DD-AUTH-007 ログインのモーダルはいつも閉じていて、閉じる関数を呼んでも閉じたまま', () => {
    renderHeader({ loggedIn: false });
    const modal = screen.getByTestId('login-modal');
    expect(modal).toHaveAttribute('data-open', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'mock-login-close' }));
    expect(screen.getByTestId('login-modal')).toHaveAttribute('data-open', 'false');
  });

  it('DD-AUTH-007 ログインしている時もログインのモーダルは閉じたまま', () => {
    renderHeader({ loggedIn: true, role: 'user' });
    expect(screen.getByTestId('login-modal')).toHaveAttribute('data-open', 'false');
  });
});
