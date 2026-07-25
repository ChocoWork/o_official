import { test, expect, Page } from '@playwright/test';

// FREQ-210: KPIカードのアイコンをホバーすると指標の意味を説明するツールチップを表示
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

async function mockAdminApis(page: Page): Promise<void> {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'admin-1', email: 'admin@example.com', role: 'admin', mfaVerified: true },
      }),
    });
  });

  await page.route('**/api/admin/kpi', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          targetYear: 2026,
          monthlyYearOptions: [2026],
          monthlyKpiByYear: [{ year: 2026, metrics: [] }],
          seasonalKpi: [],
        },
      }),
    });
  });

  await page.route('**/api/admin/kpi/targets', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          currentSeason: '2026SS',
          seasons: ['2026SS'],
          definitions: [{ key: 'cvr', label: 'CVR', definition: '', priority: '◎' }],
          values: { cvr: { '2026SS': '3.0%' } },
        },
      }),
    });
  });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-009 KPI icon tooltip (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('各KPIアイコンに説明の aria-label が付与される', async ({ page }) => {
      // FREQ-210-AC-01
      await page.goto('/admin');
      await expect(page.getByText('リーチ数', { exact: true })).toBeVisible();

      // KPIカードのアイコンは role="img"（19指標）
      await expect(page.locator('span[role="img"]')).toHaveCount(19);

      const cpmCard = page.locator('div.rounded-lg.border').filter({ hasText: 'CPM' }).first();
      await expect(cpmCard.getByRole('img')).toHaveAttribute('aria-label', /表示単価/);

      const ltvCard = page.locator('div.rounded-lg.border').filter({ hasText: 'LTV' }).first();
      await expect(ltvCard.getByRole('img')).toHaveAttribute('aria-label', /顧客生涯価値/);
    });

    test('アイコンをホバーすると説明ツールチップが表示される', async ({ page }) => {
      // FREQ-210-AC-02
      await page.goto('/admin');
      await expect(page.getByText('リーチ数', { exact: true })).toBeVisible();

      const cpmCard = page.locator('div.rounded-lg.border').filter({ hasText: 'CPM' }).first();
      const tooltip = cpmCard.getByText('広告を1,000回表示するのにかかった費用（表示単価）');

      // ホバー前は非表示（display:none）
      await expect(tooltip).toBeHidden();

      await cpmCard.getByRole('img').hover();
      await expect(tooltip).toBeVisible();
    });

    test('（ホバーなしで）横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-210-AC-03
      await page.goto('/admin');
      await expect(page.getByText('リーチ数', { exact: true })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
