/**
 * FR-LOGIN-079 ログインの2つの画面（/login・/login/code）の配置: 画面全体の中央・1画面に収まる・横にはみ出さない
 * 対応: FREQ-69-AC-01 / FREQ-69-AC-02 / FREQ-69-AC-03 / FREQ-70-AC-02 / FREQ-71-AC-01 / FREQ-328-AC-02 / FREQ-328-AC-03（上位: SR-AUTH-030、FR-AUTH-054）
 *
 * 旧のパスワードの画面（/login/password）の「見た目の約束」の試験を消した段4で、新しい画面へ移して書き直した（オーナーの答え3は A）。
 * 検査は同じで、向ける画面だけが /login と /login/code に替わる。/login/code は保留の Cookie が無いと /login へ送られるので、
 * 署名した保留の Cookie（sb-email-code-session）を置いて開く（localhost 専用の手助け）。
 * 手元のアプリ（本番ビルド）で流す。3つの幅でくり返し、1画面に収まる確かめだけ iPhone SE（375×667）で流す。
 */
import { expect, test, type Page } from '@playwright/test';
import { setEmailCodeSessionCookie } from './member-session-helpers';
import { stubTurnstileScript } from './turnstile-test-utils';

test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

type Route = '/login' | '/login/code';

async function openScreen(page: Page, route: Route): Promise<void> {
  await stubTurnstileScript(page);
  if (route === '/login/code') {
    await page.goto('/privacy');
    await setEmailCodeSessionCookie(page, 'layout-check@example.com');
  }
  await page.goto(route);
  await expect(page).toHaveURL(new RegExp(`${route.replace('/', '\\/')}$`));
  await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
}

async function layoutMetrics(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('#main-content > :first-child');
    const main = document.querySelector('#main-content');
    const header = document.querySelector('header');
    const footer = document.querySelector('footer');
    if (!root || !main || !header || !footer) throw new Error('Auth layout landmarks are missing');
    const rootBox = root.getBoundingClientRect();
    const mainBox = main.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    return {
      rootCenter: rootBox.top + rootBox.height / 2,
      rootTop: rootBox.top,
      rootBottom: rootBox.bottom,
      mainBottom: mainBox.bottom,
      viewportCenter: window.innerHeight / 2,
      headerBottom: headerBox.bottom,
      footerTop: footerBox.top,
      scrollHeight: document.documentElement.scrollHeight,
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-079 login screens layout (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FREQ-69-AC-03 /login is centered in the dynamic viewport (${viewport.name})`, async ({ page }) => {
      await openScreen(page, '/login');
      const metrics = await layoutMetrics(page);
      expect(Math.abs(metrics.rootCenter - metrics.viewportCenter)).toBeLessThan(1);
      expect(metrics.rootTop).toBeGreaterThanOrEqual(metrics.headerBottom);
      expect(metrics.footerTop).toBeGreaterThanOrEqual(viewport.height - 1);
      expect(metrics.hasHorizontalOverflow).toBe(false);
    });

    test(`FREQ-70-AC-02 /login/code is centered in the dynamic viewport (${viewport.name})`, async ({ page }) => {
      await openScreen(page, '/login/code');
      const metrics = await layoutMetrics(page);
      expect(Math.abs(metrics.rootCenter - metrics.viewportCenter)).toBeLessThan(1);
      expect(metrics.rootTop).toBeGreaterThanOrEqual(metrics.headerBottom);
      expect(metrics.footerTop).toBeGreaterThanOrEqual(viewport.height - 1);
      expect(metrics.hasHorizontalOverflow).toBe(false);
    });

    test(`FREQ-69-AC-02 /login main reaches the bottom of the viewport (${viewport.name})`, async ({ page }) => {
      await openScreen(page, '/login');
      const metrics = await layoutMetrics(page);
      expect(metrics.mainBottom).toBeGreaterThanOrEqual(viewport.height - 1);
    });

    test(`FREQ-69-AC-01 /login footer is not visible initially (${viewport.name})`, async ({ page }) => {
      await openScreen(page, '/login');
      const metrics = await layoutMetrics(page);
      expect(metrics.footerTop).toBeGreaterThanOrEqual(viewport.height - 1);
    });

    test(`FREQ-328-AC-02 /login Turnstile, email submit and Google button have the same width (${viewport.name})`, async ({ page }) => {
      test.skip(!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY 未設定時はウィジェット自体を描画しない');
      await openScreen(page, '/login');
      const widths = () =>
        page.evaluate(() => {
          const width = (el: Element | null) => (el ? el.getBoundingClientRect().width : null);
          const input = document.querySelector('input[name^="cf-turnstile"]');
          const container = input?.closest('div.pt-2')?.firstElementChild ?? null;
          const google = [...document.querySelectorAll('button, a')].find((el) => el.textContent?.includes('Googleでサインイン')) ?? null;
          return { turnstile: width(container), submit: width(document.querySelector('form button[type="submit"]')), google: width(google) };
        });
      await expect(page.locator('input[name^="cf-turnstile"]')).not.toHaveValue('', { timeout: 15000 });
      await expect
        .poll(async () => {
          const { turnstile, submit, google } = await widths();
          if (!turnstile || submit === null || google === null) return null;
          return Math.max(Math.abs(turnstile - submit), Math.abs(turnstile - google));
        }, { timeout: 15000 })
        .toBeLessThan(1);
    });

    test(`FREQ-328-AC-03 /login and /login/code do not scroll horizontally (${viewport.name})`, async ({ page }) => {
      for (const route of ['/login', '/login/code'] as const) {
        await openScreen(page, route);
        const metrics = await layoutMetrics(page);
        expect(metrics.hasHorizontalOverflow, `${route} は横にはみ出さない`).toBe(false);
      }
    });
  });
}

test.describe('FR-LOGIN-079 login screens on a short viewport', () => {
  test('FREQ-71-AC-01 /login fits within the iPhone SE viewport without scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openScreen(page, '/login');
    const metrics = await layoutMetrics(page);
    expect(metrics.rootBottom).toBeLessThanOrEqual(667);
    expect(metrics.footerTop).toBeGreaterThanOrEqual(667 - 1);
  });

  test('FREQ-71-AC-01 /login keeps every control reachable on a very short viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 568 });
    await openScreen(page, '/login');
    const metrics = await layoutMetrics(page);
    expect(metrics.rootTop).toBeGreaterThanOrEqual(metrics.headerBottom);
    expect(metrics.rootBottom).toBeLessThanOrEqual(metrics.scrollHeight);
  });
});
