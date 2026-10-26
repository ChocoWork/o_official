import { randomBytes } from 'node:crypto';
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createTestMember, loginAsMember } from './member-session-helpers';

// ホームの応答・画像・OG の守りを、利用者の受け取る形（応答の見出し・ブラウザの挙動・画面）で確かめる。
// 対象: SEC-HOME-008-AC-02 / 009-AC-01 / 009-AC-02 / 010-AC-01 / 010-AC-02 / 015-AC-01 / 016-AC-01 /
//       017-AC-01 / 017-AC-02 / 018-AC-01
// 今のコードが満たさない（TM-HOME-37・43・44・45・46）ものは、要件どおりに書いて test.fail で印を付けてある（直ると「想定外の成功」で知らせる）。SEC-HOME-009-AC-02 は文書に無い食い違い（zod の eval 探り）で同じく印を付けた。

// 会員のログインは確認コードとログインの Cookie をブラウザの通信に載せるので、通信記録（trace）を残さない。
// trace は worker 単位の設定なので、test.describe の中ではなくファイルの最上位に置く（中に置くと読み込みで落ちる）。
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

// SEC-HOME-016-AC-01 が作った会員（手元の Supabase の Auth）。終わりに消す。消せなくても db reset で消える。
const createdMemberIds: string[] = [];

test.afterAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (createdMemberIds.length === 0 || !url || !serviceKey || !isLocalUrl(url)) return;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const userId of createdMemberIds.splice(0)) {
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
});

/** CSP の文字列を、指令の名前ごとの値の並びに分ける。 */
function parseCsp(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...values] = tokens;
    directives.set(name.toLowerCase(), values);
  }
  return directives;
}

async function readHomeHeaders(request: APIRequestContext) {
  const response = await request.get('/', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  return response.headers();
}

/** /api/search を 500 にして `?q=` 付きでホームを開き、出た端末の記録を 1 つの文字列にして返す。 */
async function openHomeWithFailedSearch(page: Page): Promise<{ marker: string; joined: string }> {
  const marker = `e2e-db-detail-${randomBytes(4).toString('hex')}`;
  const consoleTexts: string[] = [];
  page.on('console', (message) => consoleTexts.push(message.text()));

  let searchRequested: () => void = () => undefined;
  const searchRequestedPromise = new Promise<void>((resolve) => {
    searchRequested = resolve;
  });
  await page.route('**/api/search*', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: `relation "public.${marker}" does not exist` }),
    });
    searchRequested();
  });

  await page.goto('/?q=abc');
  await searchRequestedPromise;
  await page.waitForLoadState('networkidle');
  // 失敗の記録は応答のあとに非同期で出る。描画の1周を挟んで、出るはずの記録を取りこぼさない。
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  return { marker, joined: consoleTexts.join('\n') };
}

test.describe('FR-HOME-022 home response hardening', () => {
  test('SEC-HOME-008-AC-02 the CSP of / requires a nonce in script-src and excludes unsafe-inline', async ({ request }) => {
    const headers = await readHomeHeaders(request);
    const csp = headers['content-security-policy'];
    expect(csp, 'Content-Security-Policy ヘッダー').toBeTruthy();

    const scriptSrc = parseCsp(csp).get('script-src');
    expect(scriptSrc, 'script-src 指令').toBeDefined();
    expect(scriptSrc!.some((value) => value.startsWith("'nonce-"))).toBe(true);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test('SEC-HOME-009-AC-01 the CSP of / has no unused CDN and no wildcard supabase connect-src', async ({ request }) => {
    test.fail(true, 'SEC-HOME-009 今のコードは満たさない（docs/02_Requirements/areas/home.md）');
    const headers = await readHomeHeaders(request);
    const csp = headers['content-security-policy'];
    expect(csp, 'Content-Security-Policy ヘッダー').toBeTruthy();

    expect(csp).not.toContain('cdn.jsdelivr.net');
    const connectSrc = parseCsp(csp).get('connect-src');
    expect(connectSrc, 'connect-src 指令').toBeDefined();
    expect(connectSrc).not.toContain('https://*.supabase.co');
  });

  test('SEC-HOME-010-AC-01 the response of / carries the protective headers', async ({ request }) => {
    const headers = await readHomeHeaders(request);

    const csp = headers['content-security-policy'];
    expect(csp, 'Content-Security-Policy ヘッダー').toBeTruthy();
    expect(parseCsp(csp).get('frame-ancestors')).toContain("'none'");
    expect(headers['x-frame-options']?.toUpperCase()).toBe('DENY');
    expect(headers['x-content-type-options']?.toLowerCase()).toBe('nosniff');
    expect(headers['strict-transport-security'] ?? '').toContain('max-age');
    expect(headers['referrer-policy']?.toLowerCase()).toBe('no-referrer');
  });

  test('SEC-HOME-017-AC-01 /_next/image refuses readdy.ai and another supabase project with 400', async ({ request }) => {
    test.fail(true, 'SEC-HOME-017 今のコードは満たさない（docs/02_Requirements/areas/home.md）');
    const disallowed = [
      'https://readdy.ai/api/search-image/e2e-home-017.png',
      'https://e2eotherprojectref.supabase.co/storage/v1/object/public/other/e2e-home-017.png',
    ];
    for (const url of disallowed) {
      const response = await request.get(`/_next/image?url=${encodeURIComponent(url)}&w=640&q=75`, {
        maxRedirects: 0,
      });
      expect(response.status(), `/_next/image?url=${url}`).toBe(400);
      expect(response.headers()['content-type'] ?? '').not.toMatch(/^image\//);
    }
  });

  for (const viewport of viewports) {
    test.describe(`${viewport.name} (${viewport.width}px)`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
      });

      test(`SEC-HOME-009-AC-02 ${viewport.name}: the h1 and five section headings are shown`, async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        await expect(page.getByRole('heading', { level: 1, name: 'Le Fil des Heures' })).toBeVisible();
        for (const title of ['ITEMS', 'LOOK', 'NEWS', 'ABOUT', 'STOCKIST']) {
          await expect(page.getByRole('heading', { level: 2, name: title, exact: true })).toBeVisible();
        }
      });

      test(`SEC-HOME-009-AC-02 ${viewport.name}: no CSP violation is recorded`, async ({ page }) => {
        test.fail(true, 'SEC-HOME-009 文書に無い食い違い（ユーザーの判断待ち）');
        const consoleCspMessages: string[] = [];
        page.on('console', (message) => {
          const text = message.text();
          if (/content security policy|refused to (load|execute|apply|connect)/i.test(text)) {
            consoleCspMessages.push(text);
          }
        });
        await page.addInitScript(() => {
          const violations: string[] = [];
          (window as unknown as { __cspViolations: string[] }).__cspViolations = violations;
          document.addEventListener('securitypolicyviolation', (event) => {
            violations.push(`${event.violatedDirective} ${event.blockedURI}`);
          });
        });

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const violations = await page.evaluate(
          () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
        );
        expect(violations, 'securitypolicyviolation').toEqual([]);
        expect(consoleCspMessages, 'CSP に関する端末の記録').toEqual([]);
      });

      test(`SEC-HOME-010-AC-02 ${viewport.name}: / does not render its h1 inside an iframe of another origin`, async ({ page, baseURL }) => {
        const embedderOrigin = 'http://e2e-embedder.example';
        await page.route(`${embedderOrigin}/**`, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><body><iframe id="victim" src="${new URL('/', baseURL).toString()}" width="100%" height="700"></iframe></body></html>`,
          }),
        );

        await page.goto(`${embedderOrigin}/`);
        await expect(page.locator('iframe#victim')).toBeAttached();

        const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
        expect(frame, '埋め込んだ枠').toBeDefined();
        // 枠の読み込みが終わってから（ブロックされた枠は エラーの頁に切り替わって終わる）、h1 が無いことを見る。
        await expect
          .poll(() => frame!.url(), { message: '枠が読み込みを始める' })
          .not.toBe('about:blank');
        await frame!.waitForLoadState('load');

        // 拒まれた枠は Chromium の誤りの頁（chrome-error://chromewebdata/）に替わり、その頁にも h1 があるので、
        // 枠の中にホームのブランド名の見出しが無いことと、枠の住所がこのサイトでないこと（誤りの頁であること）を見る。
        await expect(frame!.getByRole('heading', { name: 'Le Fil des Heures' })).toHaveCount(0);
        expect(frame!.url().startsWith(new URL('/', baseURL).origin), '枠がこのサイトの頁として読み込まれていない').toBe(false);
      });

      test(`SEC-HOME-015-AC-01 ${viewport.name}: a failed /api/search leaves no response body in the console`, async ({ page }) => {
        const { marker, joined } = await openHomeWithFailedSearch(page);
        expect(joined, '応答の中身').not.toContain(marker);
      });

      test(`SEC-HOME-015-AC-01 ${viewport.name}: a failed /api/search leaves no stack in the console`, async ({ page }) => {
        const { joined } = await openHomeWithFailedSearch(page);
        expect(joined, '誤りの積み重ね（stack）').not.toMatch(/\n\s+at\s+\S+/);
        expect(joined, '誤りの積み重ね（stack）').not.toMatch(/\bat\s+.+:\d+:\d+/);
      });

      test(`SEC-HOME-016-AC-01 ${viewport.name}: the /api/auth/me response while opening / does not contain the member email`, async ({ page }) => {
        const label = `home-016-${viewport.name}`;
        const member = await createTestMember(label);
        createdMemberIds.push(member.userId);
        // 全部の E2E が共有する 127.0.0.1 の回数の枠を使い切らないよう、試験ごとに別の送り元を付ける（192.0.2.0/24 は文書用の範囲）。
        const forwardedFor = `192.0.2.${1 + (randomBytes(1)[0] % 253)}`;
        await loginAsMember(page, member, forwardedFor);

        const meResponsePromise = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/auth/me',
        );
        await page.goto('/');
        const meResponse = await meResponsePromise;

        expect(meResponse.status()).toBe(200);
        const text = await meResponse.text();
        expect(JSON.parse(text).authenticated, 'ログインした状態の応答であること').toBe(true);
        expect(text.toLowerCase()).not.toContain(member.email.toLowerCase());
      });

      test(`SEC-HOME-017-AC-02 ${viewport.name}: hero, ABOUT, item and look images finish loading`, async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const heroImage = page.locator('img[alt^="ニュートラルな日常着をまとう"]');
        const aboutImage = page.locator('img[alt="About Le Fil des Heures"]');
        await expectImageLoaded(heroImage);
        await expectImageLoaded(aboutImage);

        for (const [sectionId, cardSelector] of [
          ['items', '[data-testid="item-card-link"]'],
          ['look', '[data-testid="look-card"]'],
        ] as const) {
          const cards = page.locator(`#${sectionId} ${cardSelector}:visible`);
          const count = await cards.count();
          expect(count, `#${sectionId} の表示中のカード`).toBeGreaterThan(0);
          for (let index = 0; index < count; index += 1) {
            await expectImageLoaded(cards.nth(index).locator('img').first());
          }
        }
      });

      test(`SEC-HOME-018-AC-01 ${viewport.name}: og:image points at the site origin and ends with /mainphoto.png`, async ({ page, baseURL }) => {
        await page.goto('/');

        const content = await page.locator('head meta[property="og:image"]').first().getAttribute('content');
        expect(content, 'og:image の content').toBeTruthy();
        const ogImage = new URL(content!);
        // AC は「設定したサイトの住所」。E2E は NEXT_PUBLIC_SITE_URL を設定して流すので、あればそれと比べる
        const siteOrigin = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? baseURL!).origin;
        expect(ogImage.origin).toBe(siteOrigin);
        expect(ogImage.pathname.endsWith('/mainphoto.png')).toBe(true);
      });
    });
  }
});

/** 画像が表示され、読み込みを終えて実寸を持つこと（遅延読み込みの画像は画面に入れてから見る）。 */
async function expectImageLoaded(image: Locator): Promise<void> {
  await expect(image).toHaveCount(1);
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0))
    .toBe(true);
}
