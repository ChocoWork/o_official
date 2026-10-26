import { NextRequest } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse.json が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

// 取り出しの関数・種別ごとの署名の部品・窓口は本物のまま通し、Supabase の client と数え場所だけを差し替える
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
}));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { incrementCounter } = require('@/features/auth/ratelimit');
const { executeSearch } = require('@/features/search/services/search.service');
const { GET } = require('@/app/api/search/route');

type Rows = Record<string, unknown[]>;
type SignCall = { bucket: string; path: string };

// service role の client は人気商品の関数と画像の署名を受け持ち、利用者の client は検索の関数だけを受ける
function setup(options: { popular?: unknown[]; search?: Rows; signFails?: boolean } = {}) {
  const signCalls: SignCall[] = [];
  const serviceRpc = jest.fn(async (name: string) => {
    if (name === 'get_popular_items') return { data: options.popular ?? [], error: null };
    return { data: null, error: { message: `unexpected ${name}` } };
  });
  const serviceClient = {
    rpc: serviceRpc,
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: jest.fn(async (path: string) => {
          signCalls.push({ bucket, path });
          if (options.signFails) return { data: null, error: { message: 'sign failed' } };
          return { data: { signedUrl: `https://signed.example/${bucket}/${path}` }, error: null };
        }),
      }),
    },
  };
  const userRpc = jest.fn(async (name: string) => ({ data: options.search?.[name] ?? [], error: null }));
  const userStorageFrom = jest.fn();
  const userClient = { rpc: userRpc, storage: { from: userStorageFrom } };
  createServiceRoleClient.mockResolvedValue(serviceClient);
  createClient.mockResolvedValue(userClient);
  return { signCalls, serviceRpc, userRpc, userStorageFrom };
}

const itemRow = (id: number, image_url: string | null) => ({
  id,
  name: `Coat ${id}`,
  description: 'wool coat',
  category: 'OUTER',
  image_url,
  price: 1000,
});

const lookRow = (id: number, image_urls: string[] | null) => ({
  id,
  season_year: 2026,
  season_type: 'SS',
  theme: `Coat look ${id}`,
  theme_description: 'a coat styling',
  image_urls,
});

const newsRow = (id: number, image_url: string | null) => ({
  id,
  title: `Coat news ${id}`,
  category: 'EVENT',
  image_url,
  content: 'about the coat',
  published_date: '2026-10-24',
});

describe('結果と人気商品の画像の署名（ARC-SEARCH-003）', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    incrementCounter.mockResolvedValue(1);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('ARC-SEARCH-003 商品は置き場 item-images で署名し、署名つき URL を imageUrl に入れる', async () => {
    const { signCalls } = setup({ search: { search_items: [itemRow(1, 'items/sign-item-1.jpg')] } });

    const result = await executeSearch({ query: 'coat' });

    expect(signCalls).toEqual([{ bucket: 'item-images', path: 'items/sign-item-1.jpg' }]);
    expect(result.items[0].imageUrl).toBe('https://signed.example/item-images/items/sign-item-1.jpg');
  });

  it('ARC-SEARCH-003 ルックは置き場 look-images で署名し、image_urls の1枚目だけを署名する', async () => {
    const { signCalls } = setup({
      search: { search_looks: [lookRow(1, ['looks/first.jpg', 'looks/second.jpg'])] },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(signCalls).toEqual([{ bucket: 'look-images', path: 'looks/first.jpg' }]);
    expect(result.looks[0].imageUrl).toBe('https://signed.example/look-images/looks/first.jpg');
  });

  it('ARC-SEARCH-003 ニュースは置き場 news-images で署名する', async () => {
    const { signCalls } = setup({ search: { search_news: [newsRow(1, 'news/a.jpg')] } });

    const result = await executeSearch({ query: 'coat' });

    expect(signCalls).toEqual([{ bucket: 'news-images', path: 'news/a.jpg' }]);
    expect(result.news[0].imageUrl).toBe('https://signed.example/news-images/news/a.jpg');
  });

  it('ARC-SEARCH-003 人気商品も商品の署名で置き換える', async () => {
    const { signCalls } = setup({ popular: [itemRow(9, 'items/sign-popular-9.jpg')] });

    const result = await executeSearch({ query: '' });

    expect(signCalls).toEqual([{ bucket: 'item-images', path: 'items/sign-popular-9.jpg' }]);
    expect(result.popularItems[0].imageUrl).toBe(
      'https://signed.example/item-images/items/sign-popular-9.jpg',
    );
  });

  it('ARC-SEARCH-003 語が空でも人気商品は署名し、利用者の client は作らない', async () => {
    setup({ popular: [itemRow(8, 'items/sign-empty-8.jpg')] });

    const result = await executeSearch({ query: '   ' });

    expect(createClient).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.empty).toBe(false);
    expect(result.popularItems[0].imageUrl).toContain('item-images/items/sign-empty-8.jpg');
  });

  it('ARC-SEARCH-003 署名は service role の client だけで行い、利用者の client の storage は使わない', async () => {
    const { signCalls, userStorageFrom } = setup({
      search: {
        search_items: [itemRow(1, 'items/sign-role-1.jpg')],
        search_looks: [lookRow(1, ['looks/role.jpg'])],
        search_news: [newsRow(1, 'news/role.jpg')],
      },
    });

    await executeSearch({ query: 'coat' });

    expect(signCalls).toHaveLength(3);
    expect(createServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(userStorageFrom).not.toHaveBeenCalled();
  });

  it('ARC-SEARCH-003 3種の結果を1回の検索で署名し、種別を取り違えない', async () => {
    const { signCalls } = setup({
      search: {
        search_items: [itemRow(1, 'items/sign-mix-1.jpg')],
        search_looks: [lookRow(1, ['looks/mix.jpg'])],
        search_news: [newsRow(1, 'news/mix.jpg')],
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(signCalls.map((c) => c.bucket).sort()).toEqual(['item-images', 'look-images', 'news-images']);
    expect(result.items[0].imageUrl).toContain('item-images/');
    expect(result.looks[0].imageUrl).toContain('look-images/');
    expect(result.news[0].imageUrl).toContain('news-images/');
  });

  it('ARC-SEARCH-003 画像の無い行は署名を呼ばず imageUrl を null のまま返す', async () => {
    const { signCalls } = setup({
      search: {
        search_items: [itemRow(1, null)],
        search_looks: [lookRow(1, null), lookRow(2, [])],
        search_news: [newsRow(1, null)],
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(signCalls).toEqual([]);
    expect(result.items[0].imageUrl).toBeNull();
    expect(result.looks.map((l: { imageUrl: unknown }) => l.imageUrl)).toEqual([null, null]);
    expect(result.news[0].imageUrl).toBeNull();
  });

  it('ARC-SEARCH-003 署名に失敗しても検索は止めず、3種の結果を返す', async () => {
    const { signCalls } = setup({
      signFails: true,
      search: {
        search_items: [itemRow(1, 'items/sign-fail-1.jpg')],
        search_looks: [lookRow(1, ['looks/fail.jpg'])],
        search_news: [newsRow(1, 'news/fail.jpg')],
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(signCalls).toHaveLength(3);
    expect(result.items).toHaveLength(1);
    expect(result.looks).toHaveLength(1);
    expect(result.news).toHaveLength(1);
    expect(result.counts.all).toBe(3);
  });

  it('ARC-SEARCH-003 窓口の応答に署名つき URL が入り、署名つき URL を共有のキャッシュに残させないよう Cache-Control: private, no-store が付く', async () => {
    setup({ search: { search_items: [itemRow(1, 'items/sign-route-1.jpg')] } });

    const res = await GET(new NextRequest('https://shop.example.com/api/search?q=coat'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].imageUrl).toContain('https://signed.example/item-images/items/sign-route-1.jpg');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
