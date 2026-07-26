import { test, expect, Page } from '@playwright/test';

// FREQ-239: 管理画面のフォント一括指定からヘッダー・フッターを除外し、他ページと同じ表示にする
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

async function mockAdminApis(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true } }),
    }),
  );

  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          targetYear: 2026,
          monthlyYearOptions: [2026],
          monthlyKpiByYear: [],
          seasonalKpi: [],
        },
      }),
    }),
  );

  await page.route('**/api/admin/kpi/targets', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { currentSeason: '2026SS', seasons: ['2026SS'], definitions: [], values: {} },
      }),
    }),
  );

  await page.route('**/api/admin/kpi/monthly-record**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { season: '2026SS', monthKeys: [], values: {} } }),
    }),
  );

  await page.route('**/api/admin/kpi/cost-profit**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          seasonKey: '2026SS',
          businessType: 'soleProprietor',
          plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
          expenses: [],
          incomes: [],
          products: [],
          partners: [],
          templates: [],
        },
      }),
    }),
  );
}

// 要素の実効 font-family の先頭フォント名を返す。
function firstFontFamily(page: Page, selector: string) {
  return page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!element) return null;
    return getComputedStyle(element).fontFamily.split(',')[0].replace(/["']/g, '').trim();
  }, selector);
}

for (const viewport of viewports) {
  test.describe(`FR-HEADER-007 admin font scope excludes site chrome (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('ヘッダーのサイトタイトルは /admin でも他ページと同じフォント', async ({ page }) => {
      // FREQ-239-AC-01
      // 公開ページと管理画面の2ルートを跨ぐため、dev サーバーの初回コンパイル分を見込む。
      test.slow();
      await page.goto('/item', { waitUntil: 'domcontentloaded' });
      const publicFont = await firstFontFamily(page, 'header .header-title');

      await mockAdminApis(page);
      await page.goto('/admin', { waitUntil: 'domcontentloaded' });
      const adminFont = await firstFontFamily(page, 'header .header-title');

      expect(publicFont).toBe('Didot');
      expect(adminFont).toBe(publicFont);
    });

    test('フッターの見出しは /admin でも他ページと同じフォント', async ({ page }) => {
      // FREQ-239-AC-02
      // 公開ページと管理画面の2ルートを跨ぐため、dev サーバーの初回コンパイル分を見込む。
      test.slow();
      await page.goto('/item', { waitUntil: 'domcontentloaded' });
      const publicFont = await firstFontFamily(page, 'footer .footer-brand-title');

      await mockAdminApis(page);
      await page.goto('/admin', { waitUntil: 'domcontentloaded' });
      const adminFont = await firstFontFamily(page, 'footer .footer-brand-title');

      expect(publicFont).toBe('Didot');
      expect(adminFont).toBe(publicFont);
    });

    test('管理コンテンツ側の見出しは Acumin のまま統一されている', async ({ page }) => {
      // FREQ-239-AC-03
      await mockAdminApis(page);
      await page.goto('/admin', { waitUntil: 'domcontentloaded' });
      // 見出しが確実に描画されるタブを開く。
      await page.getByRole('button', { name: 'ACCOUNTING' }).click();
      await page.getByRole('tab', { name: '取引管理' }).click();
      await expect(page.getByRole('heading', { name: '支出一覧（0件）' })).toBeVisible();

      // h1〜h5 は既定で Didot。管理コンテンツ内では Acumin に統一されたままであること。
      const contentFont = await firstFontFamily(page, '.admin-font-scope h4');
      expect(contentFont).toBe('acumin-pro');
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-239-AC-04
      await mockAdminApis(page);
      await page.goto('/admin', { waitUntil: 'domcontentloaded' });

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
