import ReactDOM from 'react-dom';
import { render, screen } from '@testing-library/react';
import Home, { generateMetadata } from '@/app/page';
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

jest.mock('@/features/items/components/PublicItemGrid', () => ({
  PublicItemGrid: () => null,
}));
jest.mock('@/features/look/components/PublicLookGrid', () => ({
  PublicLookGrid: () => null,
}));
jest.mock('@/features/news/components/PublicNewsGrid', () => ({
  PublicNewsGrid: () => null,
}));
jest.mock('@/features/stockist/components/PublicStockistGrid', () => ({
  PublicStockistGrid: () => null,
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

describe('ホームのページの題・説明・OG と、ヒーロー画像の先読み', () => {
  let preload: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    stubBrowserApis();
    preload = jest.spyOn(ReactDOM, 'preload').mockImplementation(() => undefined);
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
  });

  it('ARC-HOME-004 OG の画像の道は相対で、要求の見出しから作る絶対の住所を含まない', async () => {
    const metadata = await generateMetadata();
    const images = metadata.openGraph?.images as string[];

    expect(images).toHaveLength(1);
    expect(images[0].startsWith('/')).toBe(true);
    expect(images[0]).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
  });

  it('ARC-HOME-004 canonical・og:url・og:type・twitter のカードは返さない', async () => {
    const metadata = await generateMetadata();

    expect(metadata.alternates).toBeUndefined();
    expect(metadata.twitter).toBeUndefined();
    expect(metadata.openGraph).not.toHaveProperty('url');
    expect(metadata.openGraph).not.toHaveProperty('type');
    expect(Object.keys(metadata).sort()).toEqual(['description', 'openGraph', 'title']);
  });

  it('ARC-HOME-004 呼ぶたびに同じ固定の値を返す', async () => {
    const first = await generateMetadata();
    const second = await generateMetadata();

    expect(second).toEqual(first);
  });

  it('ARC-HOME-004 ヒーロー画像は先読みと同じ /mainphoto.png を、遅延読み込みにせず幅の指定付きで描く', async () => {
    render(await Home());

    expect(preload).toHaveBeenCalledWith('/mainphoto.png', { as: 'image' });
    const hero = screen.getByRole('img', {
      name: 'ニュートラルな日常着をまとう Le Fil des Heures のメインビジュアル',
    });
    expect(hero.getAttribute('src')).toContain('mainphoto.png');
    expect(hero).not.toHaveAttribute('loading', 'lazy');
    expect(hero).toHaveAttribute('sizes', '(max-width: 1023px) 300vw, 100vw');
  });

  it('ARC-HOME-004 ABOUT の画像は先読みの対象にせず遅延読み込みのまま', async () => {
    render(await Home());

    const about = screen.getByRole('img', { name: 'About Le Fil des Heures' });
    expect(about).toHaveAttribute('loading', 'lazy');
  });
});
