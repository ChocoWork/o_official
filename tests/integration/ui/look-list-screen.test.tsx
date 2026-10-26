import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { PublicLookListItem } from '@/lib/look/public';

const pushMock = jest.fn();
let currentQuery = '';
const mockLooks: { current: PublicLookListItem[] } = { current: [] };
const mockGetPublishedLookList = jest.fn(async () => mockLooks.current);

// ページ・部品・共通 UI（絞り込み・引き出し・ボタン）は本物を通し、公開の LOOK の取り出しだけを固定の並びで返す偽物にする
jest.mock('@/lib/look/server', () => ({
  getPublishedLookList: () => mockGetPublishedLookList(),
}));

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, ...rest }: { src: string; alt: string; fill?: boolean; sizes?: string }) => {
    const { fill: _fill, sizes: _sizes, ...passthrough } = rest;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} {...passthrough} />;
  },
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/look',
  useRouter: () => ({ push: (...args: unknown[]) => pushMock(...args) }),
  useSearchParams: () => {
    const params = new URLSearchParams(currentQuery);
    return {
      get: (key: string) => params.get(key),
      toString: () => params.toString(),
    };
  },
}));

const lookPageModule = require('@/app/look/page');
const LookPage = lookPageModule.default;

function makeLook(id: number, seasonType: 'SS' | 'AW', overrides: Partial<PublicLookListItem> = {}): PublicLookListItem {
  return {
    id,
    seasonYear: 2026,
    seasonType,
    theme: `Theme ${id}`,
    imageUrls: [`https://signed.test/look-${id}.jpg`],
    createdAt: `2026-0${id}-01T00:00:00Z`,
    linkedItems: [],
    ...overrides,
  };
}

const MIXED_LOOKS = [makeLook(4, 'AW'), makeLook(3, 'SS'), makeLook(2, 'AW'), makeLook(1, 'SS')];

async function renderLookPage(season?: string) {
  currentQuery = season ? new URLSearchParams({ season }).toString() : '';
  const element = await LookPage({ searchParams: Promise.resolve(season ? { season } : {}) });
  return render(element);
}

function filterPanel() {
  return within(screen.getByRole('complementary'));
}

function cardThemes(): string[] {
  return screen
    .queryAllByTestId('look-card-caption')
    .map((caption) => within(caption).getByRole('heading', { level: 3 }).textContent ?? '');
}

function checkedSeasons(): string[] {
  return ['ALL', 'SS', 'AW'].filter(
    (name) => (filterPanel().getByRole('checkbox', { name }) as HTMLInputElement).checked,
  );
}

describe('SCR-LOOK-001 look list screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentQuery = '';
    mockLooks.current = MIXED_LOOKS;
  });

  it('SCR-LOOK-001 title・description・OG の画像は LOOK に左右されない固定の値を返す', async () => {
    const metadata = await lookPageModule.generateMetadata();

    expect(metadata.title).toBe('LOOK BOOK | Le Fil des Heures');
    expect(metadata.description).toBe(
      'Le Fil des Heures の公開LOOKを一覧で掲載。シーズン別のスタイリングと関連アイテムを確認できます。',
    );
    expect(metadata.openGraph).toEqual({
      title: 'LOOK BOOK | Le Fil des Heures',
      description: metadata.description,
      images: ['/mainphoto.png'],
    });
    expect(mockGetPublishedLookList).not.toHaveBeenCalled();
  });

  it('SCR-LOOK-001 公開の LOOK を一覧用の取り出しで1回取り、見出し h1 を置かずに取り出した並びのまま格子にする', async () => {
    await renderLookPage();

    expect(mockGetPublishedLookList).toHaveBeenCalledTimes(1);
    expect(mockGetPublishedLookList).toHaveBeenCalledWith();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    expect(cardThemes()).toEqual(['Theme 4', 'Theme 3', 'Theme 2', 'Theme 1']);
  });

  it('SCR-LOOK-001 件数が多くてもページングせず取り出した分を一度に出す', async () => {
    mockLooks.current = Array.from({ length: 30 }, (_, index) => makeLook(index + 1, index % 2 === 0 ? 'SS' : 'AW'));

    await renderLookPage();

    expect(screen.getAllByTestId('look-card')).toHaveLength(30);
    expect(screen.queryByRole('button', { name: /more|次/i })).not.toBeInTheDocument();
  });

  it('SCR-LOOK-001 格子は2列・md で3列・2xl で4列で、行の間隔は lg 未満で広く lg 以上は縦横を同じにする', async () => {
    await renderLookPage();

    const grid = within(screen.getByTestId('look-content-column')).getAllByTestId('look-card')[0].parentElement;
    expect(grid).toHaveClass('grid', 'grid-cols-2', 'md:grid-cols-3', '2xl:grid-cols-4');
    expect(grid).toHaveClass('gap-y-8.5', 'sm:gap-y-13.75', 'lg:gap-4');
    expect(grid?.className).not.toMatch(/(^| )(lg|xl):grid-cols/);
  });

  it('SCR-LOOK-001 lg 以上はヘッダーの真下に留まる左のサイドバーに ALL・SS・AW の選択肢を出す', async () => {
    await renderLookPage();

    const sidebar = screen.getByRole('complementary');
    expect(sidebar).toHaveClass('hidden', 'lg:block', 'sticky', 'w-58.25', 'xl:w-[288px]');
    expect(sidebar).toHaveStyle({ top: 'var(--site-header-offset)' });
    const panel = filterPanel();
    expect(panel.getAllByRole('checkbox')).toHaveLength(3);
    expect(checkedSeasons()).toEqual(['ALL']);
  });

  it('SCR-LOOK-001 lg 未満はヘッダーの真下に付く FILTER のバーと、同じ高さの見えない置き物を出す', async () => {
    await renderLookPage();

    const floating = document.querySelector<HTMLElement>('[data-filter-bar="floating"]');
    const placeholder = document.querySelector<HTMLElement>('[data-filter-bar="placeholder"]');
    expect(floating).toBeInTheDocument();
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    expect(placeholder).toHaveClass('invisible', 'pointer-events-none');
    expect(floating?.closest('.fixed')).toHaveStyle({ top: 'var(--site-header-height)' });
    expect(within(placeholder as HTMLElement).getByRole('button', { hidden: true })).toHaveAttribute('tabindex', '-1');
  });

  it('SCR-LOOK-001 FILTER のボタンで左の引き出しを開き、閉じるボタンで閉じる', async () => {
    const user = userEvent.setup();
    await renderLookPage();

    const filterButton = document.querySelector<HTMLElement>('[data-filter-button="floating"]') as HTMLElement;
    expect(filterButton).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('[data-ui-drawer]')).not.toBeInTheDocument();

    await user.click(filterButton);

    const drawer = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-ui-drawer]');
      if (!node) throw new Error('drawer not open');
      return node;
    });
    expect(drawer).toHaveAttribute('data-ui-drawer-side', 'left');
    expect(filterButton).toHaveAttribute('aria-expanded', 'true');
    expect(within(drawer).getByRole('checkbox', { name: 'SS' })).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'Close filter drawer' }));

    await waitFor(() => {
      expect(document.querySelector('[data-ui-drawer]')).not.toBeInTheDocument();
    });
  });

  it('SCR-LOOK-001 URL の season が SS ならサーバーで直して最初の描画から SS だけに絞る', async () => {
    await renderLookPage('SS');

    expect(checkedSeasons()).toEqual(['SS']);
    expect(cardThemes()).toEqual(['Theme 3', 'Theme 1']);
  });

  it('SCR-LOOK-001 URL の season は大文字小文字と前後の空白を無視し、正しくない値は ALL として全件を出す', async () => {
    const { unmount } = await renderLookPage(' aw ');
    expect(checkedSeasons()).toEqual(['AW']);
    expect(cardThemes()).toEqual(['Theme 4', 'Theme 2']);
    unmount();

    await renderLookPage('SPRING');
    expect(checkedSeasons()).toEqual(['ALL']);
    expect(cardThemes()).toHaveLength(4);
  });

  it('SCR-LOOK-001 公開の LOOK が無い時は「公開中のLOOKがありません」だけを出し、戻すボタンは出さない', async () => {
    mockLooks.current = [];

    await renderLookPage();

    expect(screen.getByText('公開中のLOOKがありません')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'すべて見る' })).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('look-card')).toHaveLength(0);
  });

  it('SCR-LOOK-001 絞った結果が0件の時は理由と、ALL に戻す「すべて見る」のボタンを出す', async () => {
    const user = userEvent.setup();
    mockLooks.current = [makeLook(2, 'AW'), makeLook(1, 'AW')];

    await renderLookPage('SS');

    expect(screen.getByText('該当シーズンのLOOKがありません')).toBeInTheDocument();
    expect(screen.queryAllByTestId('look-card')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'すべて見る' }));

    expect(pushMock).toHaveBeenLastCalledWith('/look', { scroll: false });
    expect(checkedSeasons()).toEqual(['ALL']);
    expect(cardThemes()).toEqual(['Theme 2', 'Theme 1']);
  });

  it('SCR-LOOK-001 テーマと関連商品の名前は文字として出し、管理で書かれた HTML を解釈しない', async () => {
    mockLooks.current = [
      makeLook(1, 'SS', {
        theme: '<img src=x onerror=alert(1)>Theme',
        linkedItems: [
          { category: 'COAT', id: 10, name: '<b>Bold coat</b>', price: 48000, imageUrl: 'https://signed.test/i.jpg' },
        ],
      }),
    ];

    await renderLookPage();

    expect(screen.getAllByText('<img src=x onerror=alert(1)>Theme').length).toBeGreaterThan(0);
    expect(screen.getAllByText('<b>Bold coat</b>').length).toBeGreaterThan(0);
    expect(document.querySelector('b')).not.toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).not.toBeInTheDocument();
  });
});
