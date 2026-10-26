import { expect, test, type APIResponse } from '@playwright/test';

// 検索・サジェストの窓口の契約（件数の上限・入力の確かめ・応答の見出し・署名の期限）を、
// 匿名の HTTP で確かめる。HTTP の応答は画面の幅で変わらないので、幅のくり返しはせず 1 回だけ流す。
// 共有の送り元 127.0.0.1 の枠（search:public 120 回/600 秒）を使い切らないよう、このファイルだけの
// x-forwarded-for を付ける（SEC-SEARCH-006 が直って x-forwarded-for を信用しなくなると、この分離は効かなくなる）。
// SEC-SEARCH-003-AC-01 は題に \ を含む公開の商品を足す必要があるので FR-SEARCH-021 に置く。

type SearchResult = {
  title: string;
  description: string;
  meta: string;
  imageUrl: string | null;
};

type SearchBody = {
  items: SearchResult[];
  looks: SearchResult[];
  news: SearchResult[];
  popularItems: SearchResult[];
  counts: { all: number; item: number; look: number; news: number };
};

const FORWARDED_FOR = '198.18.19.19';

async function searchJson(response: APIResponse): Promise<SearchBody> {
  expect(response.status()).toBe(200);
  return (await response.json()) as SearchBody;
}

function decodeJwtPayload(token: string): { exp?: number; iat?: number } {
  const segment = token.split('.')[1] ?? '';
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { exp?: number; iat?: number };
}

function expectSignedUrlWithinOneHour(imageUrl: string): void {
  const token = new URL(imageUrl).searchParams.get('token');
  expect(token, imageUrl).toBeTruthy();
  const { exp, iat } = decodeJwtPayload(token as string);
  expect(typeof exp, imageUrl).toBe('number');
  expect(typeof iat, imageUrl).toBe('number');
  expect((exp as number) - (iat as number), imageUrl).toBeLessThanOrEqual(3600);
}

test.describe('FR-SEARCH-019 検索の窓口の契約と見出し', () => {
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': FORWARDED_FOR } });

  test(`FREQ-187-AC-01 preview を付けない /api/search は、いずれかの種別が 3 件を超えて返る`, async ({ request }) => {
    const body = await searchJson(await request.get('/api/search?q=a'));

    const perType = [body.counts.item, body.counts.look, body.counts.news];
    expect(Math.max(...perType)).toBeGreaterThan(3);
    // 1種別あたりの上限は 3 ではなく 8
    for (const count of perType) {
      expect(count).toBeLessThanOrEqual(8);
    }
  });

  test(`SEC-SEARCH-004-AC-01 制御文字を含む語と101字の語は /api/suggest で 400 になる`, async ({ request }) => {
    for (const q of ['a%00b', 'a%1Fb', 'a'.repeat(101)]) {
      const response = await request.get(`/api/suggest?q=${q}`);
      expect(response.status(), `/api/suggest?q=${q.slice(0, 8)}`).toBe(400);
    }
  });

  test(`SEC-SEARCH-004-AC-01 101字の語は /api/search で 400 になる`, async ({ request }) => {
    const response = await request.get(`/api/search?q=${'a'.repeat(101)}`);
    expect(response.status(), '/api/search?q=aaaaaaaa').toBe(400);
  });

  test(`SEC-SEARCH-004-AC-01 制御文字を含む語は /api/search で 400 になる`, async ({ request }) => {
    for (const q of ['a%00b', 'a%1Fb']) {
      const response = await request.get(`/api/search?q=${q}`);
      expect(response.status(), `/api/search?q=${q.slice(0, 8)}`).toBe(400);
    }
  });

  test(`SEC-SEARCH-009-AC-02 検索の応答の本文に purchase_count・purchaseCount の字が含まれない`, async ({ request }) => {
    const emptyQueryResponse = await request.get('/api/search?q=');
    const emptyBody = await searchJson(emptyQueryResponse);
    const emptyText = JSON.stringify(emptyBody);

    const itemName = emptyBody.items[0]?.title ?? emptyBody.popularItems[0]?.title ?? '';
    expect(itemName.length).toBeGreaterThan(0);
    const namedResponse = await request.get(`/api/search?q=${encodeURIComponent(itemName)}`);
    expect(namedResponse.status()).toBe(200);
    const namedText = await namedResponse.text();

    for (const text of [emptyText, namedText]) {
      expect(text).not.toContain('purchase_count');
      expect(text).not.toContain('purchaseCount');
    }
  });

  test(`SEC-SEARCH-010-AC-01 200 と 400 の応答の Cache-Control に no-store と private が含まれる`, async ({ request }) => {
    const tooLong = 'a'.repeat(101);
    const cases = [
      { url: '/api/search?q=a', status: 200 },
      { url: `/api/search?q=${tooLong}`, status: 400 },
      { url: '/api/search?q=a', status: 403, headers: { 'sec-fetch-site': 'cross-site' } },
      { url: '/api/suggest?q=a', status: 200 },
      { url: `/api/suggest?q=${tooLong}`, status: 400 },
      { url: '/api/suggest?q=a', status: 403, headers: { 'sec-fetch-site': 'cross-site' } },
    ];

    for (const { url, status, headers } of cases) {
      const response = await request.get(url, { headers });
      expect(response.status(), url.slice(0, 24)).toBe(status);
      const cacheControl = (response.headers()['cache-control'] ?? '').toLowerCase();
      expect(cacheControl, url.slice(0, 24)).toContain('no-store');
      expect(cacheControl, url.slice(0, 24)).toContain('private');
    }
  });

  test('SEC-SEARCH-012-AC-01 /search?q= の頁の応答の Referrer-Policy が no-referrer', async ({ request }) => {
    const response = await request.get('/search?q=a');
    expect(response.status()).toBe(200);
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
  });

  test(`SEC-SEARCH-014-AC-01 looks・news の imageUrl の署名の期限が発行から 1 時間以内`, async ({ request }) => {
    const bodies = [
      await searchJson(await request.get('/api/search?q=a')),
      await searchJson(await request.get('/api/search?q=')),
    ];

    for (const type of ['looks', 'news'] as const) {
      const imageUrls = bodies
        .flatMap((body) => body[type])
        .map((result) => result.imageUrl)
        .filter((url): url is string => Boolean(url));
      expect(imageUrls.length, type).toBeGreaterThan(0);
      for (const imageUrl of imageUrls) {
        expectSignedUrlWithinOneHour(imageUrl);
      }
    }
  });

  test(`SEC-SEARCH-014-AC-01 items・popularItems の imageUrl の署名の期限が発行から 1 時間以内`, async ({ request }) => {
    test.fail(true, 'SEC-SEARCH-014 今のコードは満たさない（docs/02_Requirements/areas/search.md）');
    const bodies = [
      await searchJson(await request.get('/api/search?q=a')),
      await searchJson(await request.get('/api/search?q=')),
    ];

    const imageUrls = bodies
      .flatMap((body) => [...body.items, ...body.popularItems])
      .map((result) => result.imageUrl)
      .filter((url): url is string => Boolean(url));
    expect(imageUrls.length).toBeGreaterThan(0);

    for (const imageUrl of imageUrls) {
      expectSignedUrlWithinOneHour(imageUrl);
    }
  });

  test(`SEC-SEARCH-019-AC-01 /api/search の応答に x-search-duration-ms の見出しが無い`, async ({ request }) => {
    const response = await request.get('/api/search?q=a');
    expect(response.status()).toBe(200);
    expect(response.headers()['x-search-duration-ms']).toBeUndefined();
  });
});
