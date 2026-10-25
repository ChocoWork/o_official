/**
 * FR-SEARCH-022 公開の検索の回数の制限（窓口・送り元・締め出し）と、画面の要らない呼び出し
 * 対応: SEC-SEARCH-005-AC-01 / SEC-SEARCH-005-AC-02 / SEC-SEARCH-006-AC-01 / SEC-SEARCH-020-AC-01 / SEC-SEARCH-017-AC-01
 *
 * 道具立て
 * - 窓口の回数の制限（005-AC-01・006-AC-01）は Playwright の request（HTTP）で本番ビルドの応答を読む。
 *   005-AC-02 と 020-AC-01 は頁をブラウザで開く。3つの幅（mobile 390・tablet 768・desktop 1280）は試験の頭で当て、
 *   AC ごとに幅ごとの試験を1本ずつ流す。
 * - 回数の制限の枠は search:public（120 / 600秒）・suggest:public（200 / 600秒）・search:preview（20 / 600秒）。
 *   送り元ごとに数えるので、127.0.0.1 から出る検索系の試験（ほかの FR-SEARCH-* ・ホームの /?q= の試験）と枠を共有する。
 *   そのため試験の前後に、手元の DB の public.rate_limit_counters からこの3つの枠の行を消す。
 *   消す行にはほかの試験の行も入り、この spec は枠を使い切る（006-AC-01 は x-forwarded-for を変えても 127.0.0.1 の枠を使う）ので、
 *   ほかの検索の試験と同時に流さない。playwright.config.ts で、この spec は isolated-global の project に置く
 *   （chromium の project が全部終わった後に、その teardown として流れる。chromium の試験が赤でも流れる）。
 *   単独で流す時は `npx playwright test e2e/FR-SEARCH-022` でも同じ project になる。
 * - SEC-SEARCH-017-AC-01 は検索の関数 search_news の EXECUTE を手元の DB で外して、検索の関数が本当に失敗した時の表示を確かめる。
 *   外している間は、ほかの検索の試験が壊れるので、この spec（最後に単独で流れる）に置く。外した権限は finally で元に戻す。
 *   中断して戻らなかった時は `npm run db:reset` で戻る。
 * - 枠は「送り元 × 10分（時計の10分きざみ）」。途中で枠が切り替わると数えが0に戻るので、切れ目が近いときは切り替わるのを条件で待つ。
 * - 送り元は今のコードでは x-forwarded-for の先頭の値。005-AC-01 は試験ごとに違う x-forwarded-for を付けて枠を分ける
 *   （SEC-SEARCH-006 が直って使わなくなると、全部が接続の送り元の1つの枠になり、消した直後なら同じ結果になる）。
 * - 006-AC-01・020-AC-01 は本番と同じ中継の構成が要る。手元では中継の見出しの付け方をまねる
 *   （x-forwarded-for は中継が付け足した形、x-real-ip と x-vercel-forwarded-for は中継が付けた送り元）。
 * - ファイル内の試験は1つの worker で順に流す（describe の mode: 'default'）。赤の試験の後ろが「流れなかった」扱いにならないよう serial にはしない。
 * - HTTP だけの試験（005-AC-01・006-AC-01）は幅で結果が変わらないので 1 回だけ流す。画面を開く試験は 3 つの幅で流す。
 */
import { randomInt } from 'node:crypto';
import { Client } from 'pg';
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
type Viewport = (typeof viewports)[number];

/** src/app/api/search/route.ts・src/app/api/suggest/route.ts の枠 */
const RATE_LIMIT_ENDPOINTS = ['search:public', 'suggest:public', 'search:preview'] as const;
const SEARCH_LIMIT = 120;
const SUGGEST_LIMIT = 200;
const PREVIEW_LIMIT = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
/** 枠の切れ目までこれより短いと、数える途中で枠が切り替わりうるので、切り替わるのを待つ */
const MIN_ROOM_IN_WINDOW_MS = 45_000;
const BURST_CHUNK = 20;

/** supabase/seed.sql の 'Tsubame Brass Brooch' に当たる語 */
const SEARCH_TERM = 'Tsubame';

async function applyViewport(page: Page, viewport: Viewport): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
}

// ---- 手元の DB の枠の行 ----

async function resetSearchCounters(): Promise<void> {
  if (!isLocalUrl(LOCAL_DB_URL)) {
    throw new Error('手元の DB 以外の回数の行は消さない');
  }
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    await client.query('delete from public.rate_limit_counters where endpoint = any($1::text[])', [
      [...RATE_LIMIT_ENDPOINTS],
    ]);
  } finally {
    await client.end();
  }
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

// ---- 送り元（x-forwarded-for）----

const usedForwardedFor = new Set<string>();

/** 走らせるたび・使うたびに違う送り元（ベンチマーク用の 198.18.0.0/15 から乱数で選ぶ） */
function uniqueForwardedFor(): string {
  for (;;) {
    const ip = `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
    if (!usedForwardedFor.has(ip)) {
      usedForwardedFor.add(ip);
      return ip;
    }
  }
}

/** 中継を通った要求の見出し。clientIp は中継が見た本当の送り元、spoofedFirst は利用者が先頭に書いた偽りの送り元 */
function proxyHeaders(clientIp: string, spoofedFirst?: string): Record<string, string> {
  return {
    'x-forwarded-for': spoofedFirst ? `${spoofedFirst}, ${clientIp}` : clientIp,
    'x-real-ip': clientIp,
    'x-vercel-forwarded-for': clientIp,
  };
}

// ---- 検索の関数の EXECUTE（SEC-SEARCH-017-AC-01）----

/** search_news の EXECUTE を anon・authenticated から外して場面を流し、finally で外す前の状態に戻す */
async function withSearchNewsRevoked(scenario: () => Promise<void>): Promise<void> {
  if (!isLocalUrl(LOCAL_DB_URL)) {
    throw new Error('手元の DB 以外の関数の権限は変えない');
  }
  const signature = 'public.search_news(text, integer)';
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    const held = await client.query<{ role: string }>(
      `select r.role from (values ('anon'), ('authenticated')) as r(role)
        where has_function_privilege(r.role, '${signature}', 'execute')`,
    );
    const roles = held.rows.map((row) => row.role);
    expect(roles, '外す前に anon と authenticated が search_news を呼べること').toEqual(['anon', 'authenticated']);
    try {
      await client.query(`revoke execute on function ${signature} from ${roles.join(', ')}`);
      await scenario();
    } finally {
      await client.query(`grant execute on function ${signature} to ${roles.join(', ')}`);
    }
  } finally {
    await client.end();
  }
}

// ---- 窓口を続けて叩く ----

function getApi(request: APIRequestContext, path: string, headers: Record<string, string>): Promise<APIResponse> {
  return request.get(path, { headers });
}

/** count 回を BURST_CHUNK ずつ並べて送り、状態を送った順に返す（数えは DB で原子的なので、並べても上限の数は変わらない） */
async function sendBurst(count: number, send: (index: number) => Promise<APIResponse>): Promise<number[]> {
  const statuses: number[] = [];
  for (let start = 0; start < count; start += BURST_CHUNK) {
    const size = Math.min(BURST_CHUNK, count - start);
    const chunk = await Promise.all(Array.from({ length: size }, (_, offset) => send(start + offset)));
    statuses.push(...chunk.map((response) => response.status()));
  }
  return statuses;
}

function expectNoneLimited(statuses: number[], label: string): void {
  const limited = statuses.filter((status) => status === 429).length;
  expect(limited, `${label}（状態の内訳: 429 が ${limited} 件）`).toBe(0);
}

// ---- 試験 ----

test.describe('FR-SEARCH-022 公開の検索の回数の制限', () => {
  // ファイル内の試験を1つの worker で順に流す。失敗しても後ろは流す。
  test.describe.configure({ mode: 'default' });

  test.beforeEach(async () => {
    await resetSearchCounters();
  });

  test.afterEach(async () => {
    await resetSearchCounters();
  });

  test(`SEC-SEARCH-005-AC-01 /api/search の121回目と /api/suggest の201回目が 429 で Retry-After が付く`, async ({
    request,
  }) => {
    test.setTimeout(180_000);
    await ensureRoomInRateLimitWindow();

    // /api/search: 600秒の中で121回目
    const searchHeaders = { 'x-forwarded-for': uniqueForwardedFor() };
    const searchPath = `/api/search?q=${SEARCH_TERM}`;
    const searchBefore = await sendBurst(SEARCH_LIMIT, () => getApi(request, searchPath, searchHeaders));
    expectNoneLimited(searchBefore, `/api/search の${SEARCH_LIMIT}回目までは 429 にならないこと`);
    const search121 = await getApi(request, searchPath, searchHeaders);
    expect(search121.status(), '/api/search の121回目の状態').toBe(429);
    expect(search121.headers()['retry-after'], '/api/search の121回目の Retry-After').toBeTruthy();

    // /api/suggest: 600秒の中で201回目
    const suggestHeaders = { 'x-forwarded-for': uniqueForwardedFor() };
    const suggestPath = '/api/suggest?q=Ts';
    const suggestBefore = await sendBurst(SUGGEST_LIMIT, () => getApi(request, suggestPath, suggestHeaders));
    expectNoneLimited(suggestBefore, `/api/suggest の${SUGGEST_LIMIT}回目までは 429 にならないこと`);
    const suggest201 = await getApi(request, suggestPath, suggestHeaders);
    expect(suggest201.status(), '/api/suggest の201回目の状態').toBe(429);
    expect(suggest201.headers()['retry-after'], '/api/suggest の201回目の Retry-After').toBeTruthy();
  });

  for (const viewport of viewports) {
    test(`SEC-SEARCH-005-AC-02 (${viewport.name}) 5文字を続けて打つと /api/suggest は5回より少なく、ALL から ITEM への切り替えで /api/search を呼び直さない`, async ({
      page,
    }) => {
      test.fail(true, 'SEC-SEARCH-005 今のコードは満たさない（docs/02_Requirements/areas/search.md）');
      await applyViewport(page, viewport);

      // 5文字を続けて打つ（/search を開いて、画面が動き出す = 最初の検索が返るのを待ってから打つ）
      const suggestRequests: Request[] = [];
      const onSuggestRequest = (req: Request): void => {
        if (new URL(req.url()).pathname === '/api/suggest') {
          suggestRequests.push(req);
        }
      };
      page.on('request', onSuggestRequest);
      const typedQuery = SEARCH_TERM.slice(0, 5);
      const firstSearch = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/search');
      await page.goto('/search');
      await firstSearch;

      const lastSuggest = page.waitForResponse((res) => {
        const url = new URL(res.url());
        return url.pathname === '/api/suggest' && url.searchParams.get('q') === typedQuery;
      });
      const input = page.locator('input[type="search"]');
      await input.click();
      await input.pressSequentially(typedQuery, { delay: 20 });
      await expect(input).toHaveValue(typedQuery);
      await lastSuggest;
      expect.soft(
        suggestRequests.length,
        `${typedQuery.length}文字を続けて打った時の /api/suggest への要求の数は ${typedQuery.length} 回より少ないこと`,
      ).toBeLessThan(typedQuery.length);
      page.off('request', onSuggestRequest);

      // ALL から ITEM へ切り替える（最初の検索が返った後の、新しい /api/search の要求を数える）
      const searchRequests: Request[] = [];
      const firstTabSearch = page.waitForResponse((res) => {
        const url = new URL(res.url());
        return url.pathname === '/api/search' && url.searchParams.get('q') === SEARCH_TERM;
      });
      await page.goto(`/search?q=${SEARCH_TERM}`);
      await firstTabSearch;
      const allTab = page.getByRole('tab', { name: 'ALL', exact: true });
      await expect(allTab).toHaveAttribute('aria-selected', 'true');

      page.on('request', (req) => {
        if (new URL(req.url()).pathname === '/api/search') {
          searchRequests.push(req);
        }
      });
      const itemTab = page.getByRole('tab', { name: 'ITEM', exact: true });
      await itemTab.click();
      await expect(page).toHaveURL(/[?&]tab=item(&|$)/);
      await expect(itemTab).toHaveAttribute('aria-selected', 'true');
      // 切り替え後の ITEM の一覧が描画されるのを待ってから、要求を読む（時間の当てずっぽうで待たない）
      await expect(page.getByText(/^\d+ RESULTS$/)).toBeVisible();
      await expect(
        page.getByTestId('search-result-row').filter({ hasText: 'Tsubame Brass Brooch' }),
      ).toBeVisible();
      expect(
        searchRequests.map((req) => req.url()),
        'ALL から ITEM へ切り替えた後に、/api/search への新しい要求が送られないこと',
      ).toEqual([]);
    });
  }

  test(`SEC-SEARCH-006-AC-01 x-forwarded-for を毎回変えて /api/search を121回送っても121回目が 429`, async ({
    request,
  }) => {
    test.fail(true, 'SEC-SEARCH-006 今のコードは満たさない（docs/02_Requirements/areas/search.md）');
    test.setTimeout(180_000);
    await ensureRoomInRateLimitWindow();

    const path = `/api/search?q=${SEARCH_TERM}`;
    // 同じ接続から、毎回違う送り元の見出しを付けて送る
    const before = await sendBurst(SEARCH_LIMIT, () =>
      getApi(request, path, { 'x-forwarded-for': uniqueForwardedFor() }),
    );
    expectNoneLimited(before, `x-forwarded-for を変えた${SEARCH_LIMIT}回目までは 429 にならないこと`);
    const last = await getApi(request, path, { 'x-forwarded-for': uniqueForwardedFor() });
    expect(last.status(), 'x-forwarded-for を変えた121回目の状態').toBe(429);
  });

  for (const viewport of viewports) {
    test(`SEC-SEARCH-020-AC-01 (${viewport.name}) 他人の送り元を名乗った21回と外のオリジンからの21回の後も、その利用者の /?q= にプレビューが出る`, async ({
      page,
      request,
      baseURL,
    }) => {
      test.fail(true, 'SEC-SEARCH-020 今のコードは満たさない（docs/02_Requirements/areas/search.md）');
      test.setTimeout(180_000);
      await applyViewport(page, viewport);
      await ensureRoomInRateLimitWindow();

      const previewPath = `/api/search?preview=true&q=${SEARCH_TERM}`;
      const isPreviewCall = (url: string): boolean => {
        const parsed = new URL(url);
        return parsed.pathname === '/api/search' && parsed.searchParams.get('preview') === 'true';
      };
      const openHomePreview = async (): Promise<Response> => {
        const waiter = page.waitForResponse((res) => isPreviewCall(res.url()));
        await page.goto(`/?q=${SEARCH_TERM}`);
        return waiter;
      };

      // 1) 攻撃者が、利用者 A の送り元を x-forwarded-for の先頭に書いて /api/search?preview=true を21回送る
      const victimIp = uniqueForwardedFor();
      const attackerIp = uniqueForwardedFor();
      const forged = await sendBurst(PREVIEW_LIMIT + 1, () =>
        getApi(request, previewPath, proxyHeaders(attackerIp, victimIp)),
      );
      expect(forged.length, '偽の送り元で送った回数').toBe(PREVIEW_LIMIT + 1);

      // 利用者 A（中継が見た送り元が victimIp）が /?q=<語> を開く
      const victimRoute = '**/api/search**';
      await page.route(victimRoute, async (route) => {
        await route.continue({ headers: { ...route.request().headers(), ...proxyHeaders(victimIp) } });
      });
      const victimResponse = await openHomePreview();
      expect.soft(victimResponse.status(), '送り元を名乗られた後の利用者 A のプレビューの応答の状態').toBe(200);
      await expect
        .soft(page.getByRole('heading', { name: 'Search Preview' }), '送り元を名乗られた後も利用者 A の /?q= にプレビューが出る')
        .toBeVisible();
      await page.unroute(victimRoute);

      // 2) 外のオリジンの頁から、同じ閲覧者の端末に /api/search?preview=true&q=x を21回読み込ませる
      await resetSearchCounters();
      const base = new URL(baseURL ?? 'http://localhost:3000');
      const outside = new URL(base);
      outside.hostname = base.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      const outsidePage = `${outside.origin}/attacker-page`;
      await page.route(outsidePage, (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>outside</title>' }),
      );
      const loaded: Request[] = [];
      const onLoadedRequest = (req: Request): void => {
        const url = new URL(req.url());
        if (url.origin === base.origin && url.pathname === '/api/search') {
          loaded.push(req);
        }
      };
      page.on('request', onLoadedRequest);
      await page.goto(outsidePage);
      const target = `${base.origin}/api/search?preview=true&q=x`;
      await page.evaluate(
        async ({ url, count }) => {
          await Promise.allSettled(
            Array.from({ length: count }, () => fetch(url, { mode: 'no-cors', cache: 'no-store' })),
          );
        },
        { url: target, count: PREVIEW_LIMIT + 1 },
      );
      page.off('request', onLoadedRequest);
      await page.unroute(outsidePage);

      // 外のオリジンから送られた要求であることを確かめる（そうでなければ、この試験は何も確かめていない）
      expect(loaded.length, '外のオリジンの頁から読み込ませた /api/search の回数').toBe(PREVIEW_LIMIT + 1);
      for (const req of loaded) {
        expect((await req.allHeaders())['sec-fetch-site'], '読み込ませた要求の Sec-Fetch-Site').toBe('cross-site');
      }

      const viewerResponse = await openHomePreview();
      expect.soft(viewerResponse.status(), '外のオリジンから読み込まされた後の閲覧者のプレビューの応答の状態').toBe(200);
      await expect
        .soft(page.getByRole('heading', { name: 'Search Preview' }), '外のオリジンから読み込まされた後も同じ閲覧者の /?q= にプレビューが出る')
        .toBeVisible();
    });
  }

  for (const viewport of viewports) {
    test(`SEC-SEARCH-017-AC-01 (${viewport.name}) 検索の関数が失敗した時、「検索結果を読み込めませんでした」が表示され「の検索結果はありません」は表示されない`, async ({
      page,
    }) => {
      test.fail(true, 'SEC-SEARCH-017 今のコードは満たさない（docs/02_Requirements/areas/search.md）');
      await applyViewport(page, viewport);

      await withSearchNewsRevoked(async () => {
        // 'Sustainability Note' はニュース 1 件だけに一致する（seed.sql）。その取り出しが失敗しても、
        // 失敗が 0 件として返ると「検索結果はありません」になってしまう語
        await page.goto('/search?q=Sustainability%20Note');

        await expect(page.getByText('検索結果を読み込めませんでした')).toBeVisible();
        await expect(page.getByText('の検索結果はありません')).toHaveCount(0);
      });
    });
  }
});
