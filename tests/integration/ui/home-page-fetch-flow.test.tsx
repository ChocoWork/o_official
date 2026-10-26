import ReactDOM from 'react-dom';
import { render, screen } from '@testing-library/react';
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

jest.mock('@/features/look/components/PublicLookGrid', () => ({ PublicLookGrid: () => null }));
jest.mock('@/features/stockist/components/PublicStockistGrid', () => ({
  PublicStockistGrid: () => null,
}));
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/features/search/components/SearchHomePreview', () => ({
  SearchHomePreview: () => null,
}));

// 実物の TextReveal は表示の検知と動きの設定を端末に問い合わせる。jsdom には無いので何もしない形で補う
function stubBrowserApis() {
  window.matchMedia = jest.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// 取得の関数の戻りを外から解決できるようにして、待ち方を確かめる
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const items = [
  { id: 1, name: 'WOOL COAT', price: 1000, image_url: '/item.png', category: 'OUTERWEAR' },
];
const looks = [{ id: 'look-1' }];
const news = [
  {
    id: 'news-1',
    title: 'AUTUMN NOTICE',
    published_date: '2026-10-01',
    category: 'NEWS',
    content: 'body',
  },
];
const stockists = [{ id: 'stockist-1' }];

const mockItems = getPublishedItems as jest.Mock;
const mockItemsCount = getPublishedItemsCount as jest.Mock;
const mockLooks = getPublishedLooks as jest.Mock;
const mockLooksCount = getPublishedLooksCount as jest.Mock;
const mockNews = getPublishedNews as jest.Mock;
const mockNewsCount = getPublishedNewsCount as jest.Mock;
const mockStockists = getHomePublicStockists as jest.Mock;

const allFetchers = [
  mockItems,
  mockLooks,
  mockNews,
  mockStockists,
  mockItemsCount,
  mockLooksCount,
  mockNewsCount,
];

function resolveAllFetchers() {
  mockItems.mockResolvedValue(items);
  mockLooks.mockResolvedValue(looks);
  mockNews.mockResolvedValue(news);
  mockStockists.mockResolvedValue(stockists);
  mockItemsCount.mockResolvedValue(42);
  mockLooksCount.mockResolvedValue(17);
  mockNewsCount.mockResolvedValue(9);
}

describe('ホームのページのサーバーでの取得の流れ', () => {
  let preload: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    stubBrowserApis();
    preload = jest.spyOn(ReactDOM, 'preload').mockImplementation(() => undefined);
    resolveAllFetchers();
  });

  afterEach(() => {
    preload.mockRestore();
  });

  it('ARC-HOME-001 7つの取得を、どれの結果も待たずに一度に呼び出す', async () => {
    const pending = allFetchers.map(() => deferred<unknown>());
    allFetchers.forEach((fetcher, index) => fetcher.mockReturnValue(pending[index].promise));

    const result = Home();

    // 1つも解決していない時点で、7つ全部がもう呼ばれている
    for (const fetcher of allFetchers) {
      expect(fetcher).toHaveBeenCalledTimes(1);
    }

    pending[0].resolve(items);
    pending[1].resolve(looks);
    pending[2].resolve(news);
    pending[3].resolve(stockists);
    pending[4].resolve(1);
    pending[5].resolve(2);
    pending[6].resolve(3);
    await expect(result).resolves.toBeTruthy();
  });

  it('ARC-HOME-001 7つ全部が終わるまでページを返さず、一番遅い1つを待つ', async () => {
    const slowest = deferred<number>();
    mockNewsCount.mockReturnValue(slowest.promise);

    let settled = false;
    const result = Home().then((element) => {
      settled = true;
      return element;
    });

    // 6つが解決済みでも、残る1つが終わるまでは返らない
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(preload).not.toHaveBeenCalled();

    slowest.resolve(9);
    await result;
    expect(settled).toBe(true);
  });

  it('ARC-HOME-001 取った商品名と記事の題を、実物の格子が字として並べる', async () => {
    render(await Home());

    expect(screen.getByText('WOOL COAT')).toBeInTheDocument();
    expect(screen.getByText('AUTUMN NOTICE')).toBeInTheDocument();
  });
});
