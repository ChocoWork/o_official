/**
 * FR-NEWS-SEC-003 NEWS の HTTP の応答の守り（キャッシュ・画像の最適化・守りの見出し）と /api/news の回数の制限
 * 対応: SEC-NEWS-004-AC-02 / SEC-NEWS-006-AC-01 / SEC-NEWS-006-AC-02 / SEC-NEWS-009-AC-02 / SEC-NEWS-011-AC-01 / SEC-NEWS-023-AC-01 / SEC-NEWS-024-AC-01
 *
 * 道具立て
 * - 主に Playwright の request（HTTP）で本番ビルドの応答の見出しを読む。画面の中身は見ない。
 *   SEC-NEWS-024-AC-01 だけは、頁（/news・/news/<id>）をブラウザで開いた時の応答も読む。
 *   画面を描く SEC-NEWS-024-AC-01 だけ 3つの幅（mobile 390・tablet 768・desktop 1280）で流す。ほかは応答の見出しだけを見る
 *   HTTP の試験なので幅に依らず、1本だけ流す（/api/news の回数を3倍に増やさない）。
 * - SEC-NEWS-004-AC-02 の署名つき URL は、手元の Supabase の service role で news-images の見本の画像（global-setup が置く
 *   e2e/news-1.png）に対して発行する。管理の一覧が /_next/image に渡す署名つき URL と同じ形（/storage/v1/object/sign/news-images/…）。
 *
 * 回数の制限（SEC-NEWS-006-AC-02・009-AC-02・011-AC-01）の注意
 * - /api/news の枠は「送り元 × 10分（時計の10分きざみ）」で数える。送り元は今のコードでは x-forwarded-for の先頭の値なので、
 *   試験ごとに違う（走らせるたびに乱数で決める）x-forwarded-for を付けて枠を分け、ほかの試験・ほかの spec と枠を共有しない。
 *   SEC-NEWS-011 が直って x-forwarded-for を使わなくなると、この spec の全部が接続の送り元（127.0.0.1 など）の1つの枠を共有する。
 *   そのため 61回目が 429 であること（61回目より前の結果は問わない）を確かめる形にして、枠を使い切った後でも意味が保てるようにしている。
 *   ただしその場合、同じ時間帯に /api/news を叩くほかの spec は 429 になるので、この spec は最後か単独の worker で流す。
 * - 61回送る途中で10分の枠が切り替わると数えが0に戻るので、枠の切れ目の手前45秒以内に始まるときは、切り替わるのを条件で待つ。
 * - ファイル内の試験は1つの worker で順に流す（fullyParallel でも）。回数の制限の試験は最後に置く。
 *   serial にはしない（赤の試験の後ろが「流れなかった」扱いにならないよう、各試験の結果を独立に見るため）。
 */
import { randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
type Viewport = (typeof viewports)[number];

const NEWS_API = '/api/news';
/** /api/news の枠（src/app/api/news/route.ts）: 10分に60回、61回目から 429 */
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const REQUESTS_TO_REACH_61ST = 61;
/** 枠の切れ目までこれより短いと、61回の途中で枠が切り替わりうるので、切り替わるのを待つ */
const MIN_ROOM_IN_WINDOW_MS = 45_000;

async function applyViewport(page: Page, viewport: Viewport): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
}

// ---- 回数の制限の送り元（x-forwarded-for）----

const usedForwardedFor = new Set<string>();

/** 走らせるたび・試験ごとに違う x-forwarded-for（ベンチマーク用の 198.18.0.0/15 から乱数で選ぶ） */
function uniqueForwardedFor(): string {
  for (;;) {
    const ip = `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
    if (!usedForwardedFor.has(ip)) {
      usedForwardedFor.add(ip);
      return ip;
    }
  }
}

function getNews(request: APIRequestContext, forwardedFor: string): Promise<APIResponse> {
  return request.get(NEWS_API, { headers: { 'x-forwarded-for': forwardedFor } });
}

/** 時計の10分の枠の切れ目が近いときだけ、次の枠に入るまで条件で待つ（固定の sleep はしない） */
async function ensureRoomInRateLimitWindow(): Promise<void> {
  const remaining = RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
  if (remaining >= MIN_ROOM_IN_WINDOW_MS) {
    return;
  }
  const nextWindowStart = Date.now() + remaining;
  await expect
    .poll(() => Date.now() >= nextWindowStart, {
      message: '10分の枠が切り替わるのを待つ',
      timeout: MIN_ROOM_IN_WINDOW_MS + 15_000,
      intervals: [250],
    })
    .toBe(true);
}

// ---- 守りの見出し ----

function expectNewsSecurityHeaders(
  response: { status(): number; headers(): Record<string, string> } | null,
  target: string,
): void {
  expect(response, `${target} の応答が得られること`).not.toBeNull();
  if (!response) {
    return;
  }
  expect(response.status(), `${target} の状態`).toBe(200);
  const headers = response.headers();
  expect(headers['content-security-policy'], `${target} の Content-Security-Policy`).toBeTruthy();
  expect(headers['x-content-type-options'], `${target} の X-Content-Type-Options`).toBe('nosniff');
  expect((headers['x-frame-options'] ?? '').toUpperCase(), `${target} の X-Frame-Options`).toBe('DENY');
  expect(headers['strict-transport-security'], `${target} の Strict-Transport-Security`).toBeTruthy();
}

// ---- 試験 ----

test.describe('FR-NEWS-SEC-003 NEWS の HTTP の守りと回数の制限', () => {
  // ファイル内の試験を1つの worker で順に流す（回数の制限の試験が最後）。失敗しても後ろは流す。
  test.describe.configure({ mode: 'default' });

  test(`SEC-NEWS-004-AC-02 署名つき URL の最適化の画像の Cache-Control の max-age が3600以下`, async ({ request }) => {
    test.fail(true, 'SEC-NEWS-004 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
    if (!SUPABASE_URL || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
      throw new Error('手元の Supabase の住所と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.storage.from('news-images').createSignedUrl('e2e/news-1.png', 3600);
    expect(error, '署名つき URL を発行できること').toBeNull();
    const signedUrl = data?.signedUrl ?? '';
    expect(signedUrl).toContain('/storage/v1/object/sign/news-images/');

    const response = await request.get(`/_next/image?url=${encodeURIComponent(signedUrl)}&w=64&q=75`);
    expect(response.status(), '/_next/image が署名つき URL の画像を返すこと').toBe(200);

    const cacheControl = response.headers()['cache-control'] ?? '';
    const maxAge = /max-age=(\d+)/i.exec(cacheControl);
    expect(maxAge, `Cache-Control に max-age があること（実際: ${cacheControl}）`).not.toBeNull();
    expect(Number(maxAge?.[1]), `Cache-Control の max-age が3600以下であること（実際: ${cacheControl}）`).toBeLessThanOrEqual(
      3600,
    );
  });

  test(`SEC-NEWS-006-AC-01 /api/news の 200 の応答の Cache-Control に no-store か private が含まれる`, async ({ request }) => {
    test.fail(true, 'SEC-NEWS-006 今のコードは満たさない（docs/02_Requirements/areas/news.md）');

    const response = await getNews(request, uniqueForwardedFor());
    expect(response.status()).toBe(200);

    const cacheControl = response.headers()['cache-control'] ?? '';
    expect(cacheControl, `Cache-Control に no-store か private が含まれること（実際: ${cacheControl || '(無し)'}）`).toMatch(
      /no-store|private/i,
    );
  });

  test(`SEC-NEWS-023-AC-01 別のプロジェクトのホストの URL を渡した /_next/image が 400`, async ({ request }) => {
    test.fail(true, 'SEC-NEWS-023 今のコードは満たさない（docs/02_Requirements/areas/news.md）');

    const otherProjectUrl = 'https://e2e-other-project.supabase.co/storage/v1/object/public/x/y.png';
    const response = await request.get(`/_next/image?url=${encodeURIComponent(otherProjectUrl)}&w=64&q=75`);

    expect(response.status()).toBe(400);
  });

  for (const viewport of viewports) {
    test(`SEC-NEWS-024-AC-01 (${viewport.name}) /news・/news/<id>・/api/news の応答に守りの4つの見出しが付く`, async ({
      page,
      request,
    }) => {
      await applyViewport(page, viewport);

      const listResponse = await page.goto('/news', { waitUntil: 'domcontentloaded' });
      expectNewsSecurityHeaders(listResponse, '/news');

      const firstDetailLink = page.locator('a[href^="/news/"]').first();
      await expect(firstDetailLink).toHaveAttribute('href', /^\/news\/[^/?#]+/);
      const detailHref = (await firstDetailLink.getAttribute('href')) ?? '';
      const detailResponse = await page.goto(detailHref, { waitUntil: 'domcontentloaded' });
      expectNewsSecurityHeaders(detailResponse, detailHref);

      const apiResponse = await getNews(request, uniqueForwardedFor());
      expectNewsSecurityHeaders(apiResponse, NEWS_API);
    });
  }

  // ---- 回数の制限（ここから下は枠を使うので最後に置く）----

  test(`SEC-NEWS-009-AC-02 同じ送り元から61回送ると61回目が 429 で Retry-After が付く`, async ({ request }) => {
    test.setTimeout(180_000);
    await ensureRoomInRateLimitWindow();

    const forwardedFor = uniqueForwardedFor();
    const responses: APIResponse[] = [];
    for (let i = 0; i < REQUESTS_TO_REACH_61ST; i += 1) {
      responses.push(await getNews(request, forwardedFor));
    }

    const statuses = responses.map((response) => response.status());
    const sixtyFirst = responses[REQUESTS_TO_REACH_61ST - 1];
    expect(sixtyFirst.status(), `61回目の状態（全部: ${statuses.join(',')}）`).toBe(429);
    expect(sixtyFirst.headers()['retry-after'], '61回目に Retry-After が付くこと').toMatch(/^\d+$/);
  });

  test(`SEC-NEWS-006-AC-02 /api/news の 429 の応答の Cache-Control に no-store が含まれる`, async ({ request }) => {
    test.fail(true, 'SEC-NEWS-006 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
    test.setTimeout(180_000);
    await ensureRoomInRateLimitWindow();

    const forwardedFor = uniqueForwardedFor();
    let limited: APIResponse | undefined;
    for (let i = 0; i < REQUESTS_TO_REACH_61ST; i += 1) {
      const response = await getNews(request, forwardedFor);
      if (response.status() === 429) {
        limited = response;
        break;
      }
    }

    expect(limited, `同じ送り元から${REQUESTS_TO_REACH_61ST}回送るまでに 429 が返ること`).toBeDefined();
    if (!limited) {
      return;
    }
    const cacheControl = limited.headers()['cache-control'] ?? '';
    expect(cacheControl, `429 の Cache-Control に no-store が含まれること（実際: ${cacheControl || '(無し)'}）`).toMatch(
      /no-store/i,
    );
  });

  test(`SEC-NEWS-011-AC-01 毎回違う x-forwarded-for を付けても61回目が 429`, async ({ request }) => {
    test.fail(true, 'SEC-NEWS-011 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
    test.setTimeout(180_000);
    await ensureRoomInRateLimitWindow();

    const statuses: number[] = [];
    for (let i = 0; i < REQUESTS_TO_REACH_61ST; i += 1) {
      const response = await getNews(request, uniqueForwardedFor());
      statuses.push(response.status());
    }

    expect(statuses[REQUESTS_TO_REACH_61ST - 1], `61回目の状態（全部: ${statuses.join(',')}）`).toBe(429);
  });
});
