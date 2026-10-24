import ReactDOM from 'react-dom';
import { act, render, screen, within } from '@testing-library/react';
import Home from '@/app/page';
import { getPublishedItems, getPublishedItemsCount } from '@/lib/items/public';
import { getPublishedLooks, getPublishedLooksCount } from '@/lib/look/server';
import { getPublishedNews, getPublishedNewsCount } from '@/features/news/services/public';
import { getHomePublicStockists } from '@/features/stockist/services/public';

jest.mock('@/lib/items/public', () => ({
  getPublishedItems: jest.fn(),
  getPublishedItemsCount: jest.fn(),
}));
jest.mock('@/lib/look/server', () => ({
  getPublishedLooks: jest.fn(),
  getPublishedLooksCount: jest.fn(),
}));
jest.mock('@/features/news/services/public', () => ({
  getPublishedNews: jest.fn(),
  getPublishedNewsCount: jest.fn(),
}));
jest.mock('@/features/stockist/services/public', () => ({
  getHomePublicStockists: jest.fn(),
}));

let mockSearch = '';
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const originalFetch = global.fetch;
const originalMatchMedia = window.matchMedia;

function stubMatchMedia() {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: jest.fn(),
  }));
}

async function renderHome() {
  const element = await Home();
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(element);
  });
  return view;
}

describe('ホーム / の区画の並び', () => {
  let preload: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearch = '';
    stubMatchMedia();
    preload = jest.spyOn(ReactDOM, 'preload').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], looks: [], news: [] }),
    }) as unknown as typeof fetch;
    (getPublishedItems as jest.Mock).mockResolvedValue([]);
    (getPublishedLooks as jest.Mock).mockResolvedValue([]);
    (getPublishedNews as jest.Mock).mockResolvedValue([]);
    (getHomePublicStockists as jest.Mock).mockResolvedValue([]);
    (getPublishedItemsCount as jest.Mock).mockResolvedValue(0);
    (getPublishedLooksCount as jest.Mock).mockResolvedValue(0);
    (getPublishedNewsCount as jest.Mock).mockResolvedValue(0);
  });

  afterEach(() => {
    preload.mockRestore();
    global.fetch = originalFetch;
    window.matchMedia = originalMatchMedia;
  });

  it('SCR-HOME-001 見出しの段は h1 がブランド名の1つだけで、区画の見出しは h2 ITEMS・LOOK・NEWS・ABOUT の順に並ぶ', async () => {
    await renderHome();

    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveAccessibleName('Le Fil des Heures');

    const h2Names = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(h2Names.slice(0, 4)).toEqual(['ITEMS', 'LOOK', 'NEWS', 'ABOUT']);
  });

  it('SCR-HOME-001 ヒーロー・ITEM・LOOK・NEWS・ABOUT・取扱店の見出しが、この順に文書の上から下へ並ぶ', async () => {
    const { container } = await renderHome();

    const sequence = Array.from(container.querySelectorAll('h1, h2')).map(
      (heading) => heading.getAttribute('aria-label') ?? heading.textContent,
    );
    expect(sequence).toEqual(['Le Fil des Heures', 'ITEMS', 'LOOK', 'NEWS', 'ABOUT', 'STOCKIST']);
  });

  it('SCR-HOME-001 ヒーローの区画が最初に置かれ、ブランド名の h1 を含む', async () => {
    const { container } = await renderHome();

    const firstSection = container.querySelector('section') as HTMLElement;
    expect(within(firstSection).getByRole('heading', { level: 1, name: 'Le Fil des Heures' })).toBeInTheDocument();
  });

  it('SCR-HOME-001 ?q= がある時は検索の結果が来てから h2 Search Preview の区画を、ヒーローと ITEM の間に出す', async () => {
    mockSearch = 'q=coat';
    const { container } = await renderHome();

    const preview = await screen.findByRole('heading', { level: 2, name: 'Search Preview' });
    expect(global.fetch).toHaveBeenCalledWith('/api/search?q=coat&preview=true', { cache: 'no-store' });

    const hero = container.querySelector('section') as HTMLElement;
    const itemsHeading = screen.getByRole('heading', { level: 2, name: 'ITEMS' });
    expect(hero.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preview.compareDocumentPosition(itemsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('SCR-HOME-001 公開の物が0件でも ITEM・LOOK・NEWS の区画は消えず、見出しを出す', async () => {
    await renderHome();

    expect(screen.getByRole('heading', { level: 2, name: 'ITEMS' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'LOOK' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'NEWS' })).toBeInTheDocument();
  });
});
