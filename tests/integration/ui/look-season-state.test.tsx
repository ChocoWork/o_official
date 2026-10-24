import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import {
  filterLooksBySeason,
  normalizeLookSeasonSelection,
  resolveLookSeasonFilter,
  toLookSeasonValues,
  type LookSeasonFilter,
  type PublicLook,
} from '@/lib/look/public';

const pushMock = jest.fn();
let currentQuery = '';

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

const LOOKS: PublicLook[] = [
  { id: 4, seasonYear: 2026, seasonType: 'AW', theme: 'Aw four', themeDescription: '', imageUrls: [], createdAt: '2026-04-01', linkedItems: [] },
  { id: 3, seasonYear: 2026, seasonType: 'SS', theme: 'Ss three', themeDescription: '', imageUrls: [], createdAt: '2026-03-01', linkedItems: [] },
  { id: 2, seasonYear: 2025, seasonType: 'AW', theme: 'Aw two', themeDescription: '', imageUrls: [], createdAt: '2026-02-01', linkedItems: [] },
  { id: 1, seasonYear: 2025, seasonType: 'SS', theme: 'Ss one', themeDescription: '', imageUrls: [], createdAt: '2026-01-01', linkedItems: [] },
];

const SEASON_NAMES: LookSeasonFilter[] = ['ALL', 'SS', 'AW'];

function renderCatalog(query = '', initialSeason?: LookSeasonFilter) {
  currentQuery = query;
  // 同じ要素を渡し直すと再描画が省かれるので、毎回新しい要素を作る
  const ui = () => <PublicLookGrid variant="catalog" looks={LOOKS} initialSeason={initialSeason} />;
  const view = render(ui());
  return {
    ...view,
    // 利用者が戻るなどで URL だけが変わった状態を作る
    changeUrl: (nextQuery: string) => {
      currentQuery = nextQuery;
      view.rerender(ui());
    },
  };
}

function sidebar() {
  return within(screen.getByRole('complementary'));
}

function checkedSeasons(): string[] {
  return SEASON_NAMES.filter((name) => (sidebar().getByRole('checkbox', { name }) as HTMLInputElement).checked);
}

function visibleThemes(): string[] {
  return screen
    .queryAllByTestId('look-card-caption')
    .map((caption) => within(caption).getByRole('heading', { level: 3 }).textContent ?? '');
}

async function toggle(name: string) {
  const user = userEvent.setup();
  await user.click(sidebar().getByRole('checkbox', { name }));
}

describe('STATE-LOOK-002 look season selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentQuery = '';
  });

  it('STATE-LOOK-002 season が無い時は ALL だけを選び、全部の LOOK を出して URL は書き換えない', () => {
    renderCatalog();

    expect(checkedSeasons()).toEqual(['ALL']);
    expect(visibleThemes()).toEqual(['Aw four', 'Ss three', 'Aw two', 'Ss one']);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it.each([
    ['SS', 'SS', ['Ss three', 'Ss one']],
    ['AW', 'AW', ['Aw four', 'Aw two']],
    ['小文字と前後の空白', ' aw ', ['Aw four', 'Aw two']],
    ['ALL', 'ALL', ['Aw four', 'Ss three', 'Aw two', 'Ss one']],
  ])('STATE-LOOK-002 URL の season が%sなら最初の描画からその選びにして絞る', (_label, season, themes) => {
    renderCatalog(`season=${encodeURIComponent(season)}`);

    expect(checkedSeasons()).toEqual([season.trim().toUpperCase()]);
    expect(visibleThemes()).toEqual(themes);
  });

  it.each([
    ['候補に無い値', 'SPRING'],
    ['SS と AW を並べた値', 'SS,AW'],
    ['空の値', ''],
    ['空白だけの値', '%20'],
  ])('STATE-LOOK-002 URL の season が%sの時は ALL として扱い、画面を壊さない', (_label, season) => {
    renderCatalog(`season=${season}`);

    expect(checkedSeasons()).toEqual(['ALL']);
    expect(visibleThemes()).toHaveLength(4);
  });

  it('STATE-LOOK-002 URL に season が無い時は呼び元が渡した初めの選びにし、URL の season があればそれを優先する', () => {
    const { unmount } = renderCatalog('', 'AW');
    expect(checkedSeasons()).toEqual(['AW']);
    expect(visibleThemes()).toEqual(['Aw four', 'Aw two']);
    unmount();

    renderCatalog('season=SS', 'AW');
    expect(checkedSeasons()).toEqual(['SS']);
    expect(visibleThemes()).toEqual(['Ss three', 'Ss one']);
  });

  it('STATE-LOOK-002 ALL から SS を選ぶと ALL が外れて SS だけになり、URL に season=SS を書き戻す', async () => {
    renderCatalog('foo=1');

    await toggle('SS');

    expect(checkedSeasons()).toEqual(['SS']);
    expect(visibleThemes()).toEqual(['Ss three', 'Ss one']);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenLastCalledWith('/look?foo=1&season=SS', { scroll: false });
  });

  it('STATE-LOOK-002 ALL から AW を選ぶと AW だけになる', async () => {
    renderCatalog();

    await toggle('AW');

    expect(checkedSeasons()).toEqual(['AW']);
    expect(visibleThemes()).toEqual(['Aw four', 'Aw two']);
    expect(pushMock).toHaveBeenLastCalledWith('/look?season=AW', { scroll: false });
  });

  it('STATE-LOOK-002 SS を選んだまま AW を選ぶと SS が外れて AW だけになり、両方は選べない', async () => {
    renderCatalog('season=SS');

    await toggle('AW');

    expect(checkedSeasons()).toEqual(['AW']);
    expect(visibleThemes()).toEqual(['Aw four', 'Aw two']);
    expect(pushMock).toHaveBeenLastCalledWith('/look?season=AW', { scroll: false });
  });

  it('STATE-LOOK-002 AW を選んだまま SS を選ぶと AW が外れて SS だけになる', async () => {
    renderCatalog('season=AW');

    await toggle('SS');

    expect(checkedSeasons()).toEqual(['SS']);
    expect(pushMock).toHaveBeenLastCalledWith('/look?season=SS', { scroll: false });
  });

  it('STATE-LOOK-002 SS を選んだまま ALL を選ぶと ALL だけにし、URL から season を消して他の query は残す', async () => {
    renderCatalog('foo=1&season=SS');

    await toggle('ALL');

    expect(checkedSeasons()).toEqual(['ALL']);
    expect(visibleThemes()).toHaveLength(4);
    expect(pushMock).toHaveBeenLastCalledWith('/look?foo=1', { scroll: false });
  });

  it('STATE-LOOK-002 選んだ SS を外して全部を外すと ALL に戻し、URL から season を消す', async () => {
    renderCatalog('season=SS');

    await toggle('SS');

    expect(checkedSeasons()).toEqual(['ALL']);
    expect(visibleThemes()).toHaveLength(4);
    expect(pushMock).toHaveBeenLastCalledWith('/look', { scroll: false });
  });

  it('STATE-LOOK-002 ALL だけの時に ALL を外しても ALL のままで、同じ選びなので URL を書き換えない', async () => {
    renderCatalog();

    await toggle('ALL');

    expect(checkedSeasons()).toEqual(['ALL']);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('STATE-LOOK-002 URL が変わると選びを URL に合わせ直し、URL を書き戻さない', () => {
    const { changeUrl } = renderCatalog('season=SS');
    expect(checkedSeasons()).toEqual(['SS']);

    changeUrl('season=AW');

    expect(checkedSeasons()).toEqual(['AW']);
    expect(visibleThemes()).toEqual(['Aw four', 'Aw two']);

    changeUrl('');

    expect(checkedSeasons()).toEqual(['ALL']);
    expect(visibleThemes()).toHaveLength(4);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('STATE-LOOK-002 URL の season の値を前後の空白を除いて大文字にし、ALL・SS・AW 以外は fallback にする', () => {
    expect(resolveLookSeasonFilter('ss')).toBe('SS');
    expect(resolveLookSeasonFilter('  aw  ')).toBe('AW');
    expect(resolveLookSeasonFilter('all')).toBe('ALL');
    expect(resolveLookSeasonFilter('spring')).toBe('ALL');
    expect(resolveLookSeasonFilter('spring', 'AW')).toBe('AW');
    expect(resolveLookSeasonFilter('   ', 'SS')).toBe('SS');
    expect(resolveLookSeasonFilter(null, 'SS')).toBe('SS');
    expect(resolveLookSeasonFilter(undefined)).toBe('ALL');
  });

  it('STATE-LOOK-002 複数の選びからは正しい値の最後の1つを残し、正しい値が無ければ ALL にする', () => {
    expect(normalizeLookSeasonSelection(['ALL', 'SS'])).toBe('SS');
    expect(normalizeLookSeasonSelection(['SS', 'AW'])).toBe('AW');
    expect(normalizeLookSeasonSelection(['AW', 'bogus'])).toBe('AW');
    expect(normalizeLookSeasonSelection([' ss '])).toBe('SS');
    expect(normalizeLookSeasonSelection(['bogus'])).toBe('ALL');
    expect(normalizeLookSeasonSelection([])).toBe('ALL');
  });

  it('STATE-LOOK-002 選びは常に要素1つの配列にして部品へ渡し、ALL では絞らず配列をそのまま返す', () => {
    expect(toLookSeasonValues('ALL')).toEqual(['ALL']);
    expect(toLookSeasonValues('SS')).toEqual(['SS']);
    expect(toLookSeasonValues('AW')).toEqual(['AW']);

    expect(filterLooksBySeason(LOOKS, 'ALL')).toBe(LOOKS);
    expect(filterLooksBySeason(LOOKS, 'SS').map((look) => look.id)).toEqual([3, 1]);
    expect(filterLooksBySeason(LOOKS, 'AW').map((look) => look.id)).toEqual([4, 2]);
    expect(filterLooksBySeason([], 'SS')).toEqual([]);
  });
});
