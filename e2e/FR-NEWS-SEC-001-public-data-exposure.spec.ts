import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { SEED_IMAGE_PNG_BASE64 } from '../scripts/e2e/seed-storage';
import { insertLegacyImageRow } from './legacy-image-rows';
import { withLocalDb } from './order-email-test-utils';

/**
 * FR-NEWS-SEC-001 NEWS の公開の読み出しが漏らすもの（公開面 /news・/news/<id>・/api/news・/api/search だけ）
 * 対応 AC: SEC-NEWS-001-AC-02、SEC-NEWS-003-AC-02、SEC-NEWS-004-AC-01、SEC-NEWS-005-AC-01・AC-02、
 * SEC-NEWS-007-AC-01・AC-02、SEC-NEWS-008-AC-01、SEC-NEWS-009-AC-01、SEC-NEWS-012-AC-01、FREQ-185-AC-01・AC-02
 *
 * 前提: 手元の Supabase。記事と置き場の画像は service role で入れ、終わりに自分の分だけ消す。
 * ファイルの中の試験は並列の worker に散るので、beforeAll は worker ごとに自分の分を作る（題・画像の道筋に乱数を入れて干渉させない）。
 * 公開の行は公開日を 2000-01-01 にして、一覧の先頭を取る既存の試験を崩さない。非公開の行は、漏れれば一覧の先頭に出る 2099-12-31 にする。
 * /api/news は 10分60回の共有枠なので、このファイル全体で 40 回以内に収める（画面を描く 3 本は 3 つの幅で 1 回ずつ、HTTP だけの試験は幅に依らず 1 回で、合わせて 11 回）。
 * SEC-NEWS-004-AC-01・007-AC-01・007-AC-02・008-AC-01 は AC の文のとおり /api/news の応答を読む。/api/news の先頭の20件に自分の行が入るよう、
 * 試験の中で 1 件ずつ、分類 SUSTAINABILITY・公開日 2000-01-03（見本の 8 件より古く、分類で絞るので先頭の20件に入る。ほかの試験の 2000-01-01/02 の行より新しい）の行を入れて、読んだら消す。
 * FREQ-185-AC-01 と SEC-NEWS-005-AC-01 の裏づけは、画像が要る検索の結果（/api/search）から取る。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const BUCKET = 'news-images';
const NOT_FOUND_TEXT = 'This page could not be found';
const SIGNED_URL_PATH = '/storage/v1/object/sign/';

type Row = { id: number; title: string };
type Fixture = {
  tag: string;
  /** 全部の固定の題の頭（検索で全部が当たる） */
  prefix: string;
  /** 公開・news/ の下の本物の画像 */
  pub: Row;
  /** 非公開 */
  priv: Row;
  /** 置き場にある news/ の下の本物の画像 */
  pubPath: string;
  /** 置き場にある news/ の外（other/）の本物の画像 */
  otherPath: string;
  rowIds: number[];
  objectPaths: string[];
};

let fx: Fixture | null = null;

function fixture(): Fixture {
  if (!fx) throw new Error('beforeAll が記事を作れていない');
  return fx;
}

function localAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('記事と画像を作れるのは手元の Supabase だけ');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function supabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !isLocalUrl(url)) throw new Error('手元の Supabase の住所が無い');
  return url.replace(/\/+$/, '');
}

type ArticleInput = {
  title: string;
  imageUrl: string;
  status: 'published' | 'private';
  publishedDate: string;
  category?: string;
};

async function insertArticles(admin: SupabaseClient, inputs: ArticleInput[]): Promise<Row[]> {
  const { data, error } = await admin
    .from('news_articles')
    .insert(
      inputs.map((input) => ({
        title: input.title,
        category: input.category ?? 'COLLECTION',
        published_date: input.publishedDate,
        image_url: input.imageUrl,
        content: 'E2E news-sec-001 summary.',
        detailed_content: 'E2E news-sec-001 body.',
        status: input.status,
      })),
    )
    .select('id, title');
  if (error || !data) {
    throw new Error(`記事を作れない（code: ${error?.code ?? '不明'}）`);
  }
  return data as Row[];
}

test.beforeAll(async () => {
  const admin = localAdmin();
  const tag = randomUUID().replace(/-/g, '').slice(0, 10);
  const prefix = `secnews${tag}`;
  // 置き場の物の数を数える FR-NEWS-SEC-005 の SEC-NEWS-017-AC-01 と混ざらないよう、news/e2e-・other/e2e- の頭を付ける。
  const pubPath = `news/e2e-sec001-${tag}/${randomUUID()}.png`;
  const otherPath = `other/e2e-sec001-${tag}-${randomUUID()}.png`;
  const png = Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64');

  const objectPaths: string[] = [];
  for (const path of [pubPath, otherPath]) {
    const { error } = await admin.storage.from(BUCKET).upload(path, png, { contentType: 'image/png', upsert: true });
    if (error) throw new Error('置き場に画像を置けない');
    objectPaths.push(path);
  }

  const titles = {
    pub: `${prefix}pub public fixture`,
    priv: `${prefix}prv private fixture`,
  };
  const published = { status: 'published', publishedDate: '2000-01-01' } as const;
  const rows = await insertArticles(admin, [
    { ...published, title: titles.pub, imageUrl: pubPath },
    { status: 'private', publishedDate: '2099-12-31', title: titles.priv, imageUrl: 'news/e2e/news-1.png' },
  ]);
  const byTitle = (title: string): Row => {
    const row = rows.find((candidate) => candidate.title === title);
    if (!row) throw new Error('作った記事が戻らない');
    return row;
  };

  fx = {
    tag,
    prefix,
    pub: byTitle(titles.pub),
    priv: byTitle(titles.priv),
    pubPath,
    otherPath,
    rowIds: rows.map((row) => row.id),
    objectPaths,
  };
});

test.afterAll(async () => {
  if (!fx) return;
  const admin = localAdmin();
  await admin.from('news_articles').delete().in('id', fx.rowIds);
  await admin.storage.from(BUCKET).remove(fx.objectPaths);
  fx = null;
});

type SearchNews = { id: string; title: string; imageUrl: string | null };

/** /api/search を引く。news の結果と、応答の文字列そのまま（題や道筋が混ざっていないかを見る用）を返す */
async function search(
  request: APIRequestContext,
  query: string,
  tab: 'all' | 'news' = 'news',
): Promise<{ news: SearchNews[]; raw: string }> {
  const response = await request.get(`/api/search?q=${encodeURIComponent(query)}&tab=${tab}`);
  expect(response.status(), '/api/search の状態').toBe(200);
  const raw = await response.text();
  const payload = JSON.parse(raw) as { news: SearchNews[] };
  return { news: payload.news, raw };
}

function findNews(news: SearchNews[], row: Row): SearchNews {
  const found = news.find((result) => result.id === String(row.id));
  if (!found) throw new Error(`検索の結果に記事 ${row.id} が無い`);
  return found;
}

type ApiNewsItem = Record<string, unknown> & { id: number; title: string };

async function getApiNews(request: APIRequestContext, query: string): Promise<{ status: number; raw: string; items: ApiNewsItem[] }> {
  const response = await request.get(`/api/news${query}`);
  const raw = await response.text();
  let items: ApiNewsItem[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) items = parsed as ApiNewsItem[];
  } catch {
    items = [];
  }
  return { status: response.status(), raw, items };
}

const PROBE_CATEGORY = 'SUSTAINABILITY';
const PROBE_DATE = '2000-01-03';

type ProbeResult = { api: { status: number; raw: string; items: ApiNewsItem[] }; items: ApiNewsItem[] };

/**
 * 画像の値ごとに公開の記事を 1 件ずつ入れ、/api/news の同じ分類の先頭の20件から自分の行を探して返す。行は読んだら消す。
 * 見本の 8 件より古い公開日（2000-01-03）なので、分類を絞れば他の worker の同じ試験の行と合わせても先頭の20件に入る。
 */
async function readNewsApiWithProbes(request: APIRequestContext, imageUrls: string[]): Promise<ProbeResult> {
  const admin = localAdmin();
  const probeTag = randomUUID().replace(/-/g, '').slice(0, 10);
  // 外の道筋・別ホストの URL は DB の CHECK（news/ の下だけ）に合わない旧い行を表すので、CHECK より前の行として入れる
  const rows = await withLocalDb(async (db) => {
    const created: Row[] = [];
    for (const [index, imageUrl] of imageUrls.entries()) {
      const title = `secnews${probeTag}probe${index} signing fixture`;
      const id = await insertLegacyImageRow(
        db,
        'news_articles',
        'news_articles_image_url_path_check',
        `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
         values ($1, $2, $3::date, $4, 'E2E news-sec-001 summary.', 'E2E news-sec-001 body.', 'published')`,
        [title, PROBE_CATEGORY, PROBE_DATE, imageUrl],
      );
      created.push({ id, title });
    }
    return created;
  });
  try {
    const api = await getApiNews(request, `?category=${PROBE_CATEGORY}&limit=20`);
    expect(api.status, '/api/news の状態').toBe(200);
    const items = rows.map((row) => {
      const found = api.items.find((item) => item.id === row.id);
      if (!found) throw new Error(`/api/news の応答に記事 ${row.id} が無い`);
      return found;
    });
    return { api, items };
  } finally {
    await admin.from('news_articles').delete().in('id', rows.map((row) => row.id));
  }
}

/** 応答の文字列に出てくる署名つき URL を全部取り出す */
function signedUrlsIn(raw: string): string[] {
  return raw.match(/https?:\/\/[^"\s]*\/storage\/v1\/object\/sign\/[^"\s]*/g) ?? [];
}

function jwtClaims(token: string): { exp?: number; iat?: number } {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number; iat?: number };
}

async function expectNotFound(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `${path} の状態`).toBe(404);
  await expect(page.getByText(NOT_FOUND_TEXT)).toBeVisible();
}

for (const { name, width, height } of VIEWPORTS) {
  test.describe(`FR-NEWS-SEC-001 NEWS の公開の画面 (${name} ${width}px)`, () => {
    test.use({ viewport: { width, height } });

    test(`SEC-NEWS-001-AC-02 ${name}: 非公開の記事の詳細は 404 で、一覧・/api/news・検索に題が出ない`, async ({ page, request }) => {
      const { priv, pub, prefix } = fixture();

      // /news/<id>
      await expectNotFound(page, `/news/${priv.id}`);
      expect(await page.content(), '詳細の 404 の HTML').not.toContain(priv.title);

      // /news
      const listHtml = await (await request.get('/news')).text();
      expect(listHtml, '/news の HTML').not.toContain(priv.title);
      await page.goto('/news');
      await expect(page.locator('a[href^="/news/"]').first()).toBeVisible();
      await expect(page.getByText(priv.title)).toHaveCount(0);

      // /api/news（漏れれば公開日が一番新しいので先頭に出る）
      const api = await getApiNews(request, '?limit=20');
      expect(api.status, '/api/news の状態').toBe(200);
      expect(api.items.length, '/api/news の件数').toBeGreaterThan(0);
      expect(api.raw).not.toContain(priv.title);
      expect(api.items.map((item) => item.id)).not.toContain(priv.id);

      // 検索（公開の記事は当たるので、検索が動いていることも同時に確かめる）
      const found = await search(request, prefix);
      expect(found.news.map((result) => result.title)).toContain(pub.title);
      expect(found.raw).not.toContain(priv.title);
      expect(found.news.map((result) => result.id)).not.toContain(String(priv.id));
    });

    test(`SEC-NEWS-005-AC-02 ${name}: 公開の一覧と詳細の頁の HTML と埋めたデータに署名つき URL が無い`, async ({ page, request }) => {
      const { pub } = fixture();
      const signed = new RegExp(`${SIGNED_URL_PATH}|[?&]token=eyJ`);

      // 頁に埋めたデータを含む、サーバーが返した HTML そのまま
      const listResponse = await request.get('/news');
      expect(listResponse.status()).toBe(200);
      expect(await listResponse.text(), '/news の HTML').not.toMatch(signed);

      const detailResponse = await request.get(`/news/${pub.id}`);
      expect(detailResponse.status()).toBe(200);
      const detailHtml = await detailResponse.text();
      expect(detailHtml, '詳細の頁の中身が出ている').toContain(pub.title);
      expect(detailHtml, `/news/${pub.id} の HTML`).not.toMatch(signed);

      // 描画した後の DOM
      await page.goto('/news');
      await expect(page.locator('a[href^="/news/"]').first()).toBeVisible();
      expect(await page.content(), '描画後の /news').not.toMatch(signed);

      await page.goto(`/news/${pub.id}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(pub.title);
      expect(await page.content(), '描画後の詳細').not.toMatch(signed);
    });

    test(`FREQ-185-AC-02 ${name}: 検索の結果のサムネイルが読み込まれ（naturalWidth>0）、画像の要求に 400 が返らない`, async ({ page }) => {
      const { pub, prefix } = fixture();

      const failedImageRequests: string[] = [];
      page.on('response', (response) => {
        const url = response.url();
        if ((url.includes('/_next/image') || url.includes('/storage/v1/object/')) && response.status() >= 400) {
          failedImageRequests.push(`${response.status()} ${url}`);
        }
      });

      await page.goto(`/search?q=${encodeURIComponent(`${prefix}pub`)}`);

      // ローディングのスケルトンには img が無いため、結果行の描画を待ってから数える
      const row = page.locator('[data-testid="search-result-row"]').filter({ hasText: pub.title });
      await expect(row).toBeVisible();

      const thumbnails = row.locator('img');
      await expect.poll(async () => thumbnails.count()).toBeGreaterThan(0);
      const thumbnailCount = await thumbnails.count();
      for (let index = 0; index < thumbnailCount; index += 1) {
        const thumbnail = thumbnails.nth(index);
        await expect(thumbnail).toBeVisible();
        await expect
          .poll(async () => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth))
          .toBeGreaterThan(0);
      }

      expect(failedImageRequests).toEqual([]);
    });
  });
}

// 画面を描かず HTTP の応答だけを見る試験は、幅に依らないので 1 回だけ流す（/api/news の回数・DB の行を 3 倍にしない）。
test.describe('FR-NEWS-SEC-001 NEWS の公開の応答', () => {
  test(`SEC-NEWS-003-AC-02 公開の URL（/object/public/news-images/…）では記事の画像を開けない`, async ({ request }) => {
    const { pubPath } = fixture();
    const base = supabaseUrl();

    // 置き場には本物の画像がある（署名つき URL なら開ける）ので、4xx になるのは置き場が公開でないから
    for (const path of [pubPath, 'news/e2e/news-1.png']) {
      const response = await request.get(`${base}/storage/v1/object/public/${BUCKET}/${path}`);
      expect(response.status(), `公開の URL の状態（${path}）`).toBeGreaterThanOrEqual(400);
      expect(response.status(), `公開の URL の状態（${path}）`).toBeLessThan(500);
      expect(response.headers()['content-type'] ?? '').not.toMatch(/^image\//i);
    }
  });

  test(`SEC-NEWS-004-AC-01 /api/news の応答の署名つき URL の期限が 1 時間以下`, async ({ request }) => {
    const { pubPath } = fixture();
    const { api, items } = await readNewsApiWithProbes(request, [pubPath]);
    const [item] = items;

    // image_url を返す間は、自分の記事に署名つき URL が付く（署名されない値のまま素通りしていない）
    if ('image_url' in item) {
      expect(item.image_url, '/api/news の image_url').toEqual(expect.stringContaining(SIGNED_URL_PATH));
    }
    for (const imageUrl of signedUrlsIn(api.raw)) {
      const url = new URL(imageUrl);
      expect(url.pathname).toContain(`${SIGNED_URL_PATH}${BUCKET}/`);
      const token = url.searchParams.get('token');
      expect(token, '署名つき URL の token').toBeTruthy();

      const claims = jwtClaims(token as string);
      expect(typeof claims.iat, 'token の iat').toBe('number');
      expect(typeof claims.exp, 'token の exp').toBe('number');
      const lifetime = (claims.exp as number) - (claims.iat as number);
      expect(lifetime).toBeGreaterThan(0);
      expect(lifetime, `署名の期限（秒）: ${imageUrl}`).toBeLessThanOrEqual(3600);
    }
  });

  test(`SEC-NEWS-005-AC-01 /api/news の応答に image_url が無い（画像の要る検索の結果は署名つき URL を返す）`, async ({ request }) => {
    const { pub, prefix } = fixture();

    const api = await getApiNews(request, '?limit=20');
    expect(api.status, '/api/news の状態').toBe(200);
    expect(api.items.length, '/api/news の件数').toBeGreaterThanOrEqual(1);
    for (const item of api.items) {
      expect(Object.keys(item), `記事 ${item.id} の項目`).not.toContain('image_url');
    }
    expect(api.raw).not.toContain('image_url');
    expect(api.raw).not.toContain(SIGNED_URL_PATH);

    // 対象外の検索の結果には画像が残る（記事が無くて空振りしていないことの裏づけ）
    const { news } = await search(request, `${prefix}pub`);
    expect(news.length, '検索の結果の件数').toBeGreaterThanOrEqual(1);
    expect(findNews(news, pub).imageUrl).toContain(SIGNED_URL_PATH);
  });

  test(`SEC-NEWS-007-AC-01 画像の道筋が news/ の外（other/…）の記事には /api/news で署名しない`, async ({ request }) => {
    const { otherPath } = fixture();

    // 置き場に other/ の下の本物の画像があるので、署名されれば開ける URL が出てしまう
    const { api, items } = await readNewsApiWithProbes(request, [otherPath]);
    const [item] = items;
    expect(item.image_url ?? null, '/api/news の image_url').toBeNull();
    expect(api.raw).not.toContain(otherPath);
    expect(signedUrlsIn(api.raw).filter((url) => url.includes(otherPath))).toEqual([]);
  });

  test(`SEC-NEWS-007-AC-02 別のホストの URL の画像には /api/news で署名しない`, async ({ request }) => {
    const { pubPath } = fixture();
    const foreignUrl = `https://attacker.sec-news.invalid/storage/v1/object/public/${BUCKET}/${pubPath}`;

    // 別のホストの URL だが道筋は置き場にある本物の画像と同じ。署名されれば自分の置き場の画像が出てしまう
    const { api, items } = await readNewsApiWithProbes(request, [foreignUrl]);
    const [item] = items;
    expect(item.image_url ?? null, '/api/news の image_url').toBeNull();
    expect(api.raw).not.toContain('attacker.sec-news.invalid');
    expect(signedUrlsIn(api.raw).filter((url) => url.includes(pubPath))).toEqual([]);
  });

  test(`SEC-NEWS-008-AC-01 署名できない画像の値（置き場に無い道筋・置き場の URL でない値）は /api/news で元の値でなく null になる`, async ({ request }) => {
    const missingPath = `news/e2e-sec001-${fixture().tag}/${randomUUID()}.png`;
    const unparsableUrl = `https://cdn.sec-news.invalid/images/${randomUUID()}.png`;

    const { api, items } = await readNewsApiWithProbes(request, [missingPath, unparsableUrl]);
    const [missingItem, unparsableItem] = items;
    expect(missingItem.image_url ?? null, '置き場に無い道筋の記事の image_url').toBeNull();
    expect(unparsableItem.image_url ?? null, '置き場の URL でない値の記事の image_url').toBeNull();
    expect(api.raw).not.toContain(missingPath);
    expect(api.raw).not.toContain(unparsableUrl);
  });

  test(`SEC-NEWS-009-AC-01 /api/news?limit=1000 は 20 件を超えて返さない`, async ({ request }) => {
    // 公開済みが 20 件を超えている状態で確かめる（見本の 8 件と合わせて 20 件を超える）。自分の行は終わりに消す
    const admin = localAdmin();
    const bulkTag = randomUUID().slice(0, 8);
    const rows = await insertArticles(
      admin,
      Array.from({ length: 21 }, (_, index) => ({
        title: `secnews${bulkTag}bulk${index} limit fixture`,
        imageUrl: 'news/e2e/news-1.png',
        status: 'published' as const,
        publishedDate: '2000-01-02',
      })),
    );

    try {
      const api = await getApiNews(request, '?limit=1000');
      expect(api.status, '/api/news の状態').toBe(200);
      expect(api.items.length, '返った件数').toBeGreaterThan(0);
      expect(api.items.length, '返った件数').toBeLessThanOrEqual(20);
    } finally {
      await admin.from('news_articles').delete().in('id', rows.map((row) => row.id));
    }
  });

  test(`SEC-NEWS-012-AC-01 /api/news は許可の一覧に無い分類（長文）を取り出しに渡さない`, async ({ request }) => {
    const all = await getApiNews(request, '?category=ALL&limit=5');
    expect(all.status, 'ALL の状態').toBe(200);
    expect(all.items.length, 'ALL の件数').toBeGreaterThan(0);

    const invalid = await getApiNews(request, `?category=${'X'.repeat(300)}&limit=5`);
    // 外れた値は ALL として扱う（200 の側）。分類として取り出しに渡されると、空の一覧になる
    expect(invalid.status, '外れた分類の状態').toBe(200);
    expect(invalid.items.length, '外れた分類の件数（空でない）').toBeGreaterThan(0);
    expect(invalid.items.map((item) => item.id), 'ALL と同じ記事').toEqual(all.items.map((item) => item.id));
  });

  test(`FREQ-185-AC-01 /api/search の news の画像の URL が署名つきの形（/object/sign/）で、公開の形（/object/public/）でない`, async ({ request }) => {
    const { pub, prefix } = fixture();

    const { news } = await search(request, `${prefix}pub`, 'all');
    const imageUrls = news.map((result) => result.imageUrl).filter((url): url is string => Boolean(url));
    expect(imageUrls.length, '画像の URL がある news の結果').toBeGreaterThan(0);
    expect(news.map((result) => result.id)).toContain(String(pub.id));
    for (const url of imageUrls) {
      expect(url).toContain('/storage/v1/object/sign/');
      expect(url).not.toContain('/storage/v1/object/public/');
    }
  });
});
