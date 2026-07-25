import { test, expect, Page } from '@playwright/test';

// FREQ-209: サブタブ上の「KPI」見出しと「最終更新」表示を削除
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
  test.describe(`FR-ADMIN-008 remove KPI heading (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('「最終更新」表示が存在しない', async ({ page }) => {
      // FREQ-209-AC-01
      await page.goto('/admin');
      await expect(page.getByRole('tab', { name: '目標 & 進捗' })).toBeVisible();

      await expect(page.getByText(/最終更新/)).toHaveCount(0);
    });

    test('font-display の「KPI」見出しが存在しない', async ({ page }) => {
      // FREQ-209-AC-02（左ナビのKPIタブは button なので対象外）
      await page.goto('/admin');
      await expect(page.getByRole('tab', { name: '目標 & 進捗' })).toBeVisible();

      await expect(page.locator('p.font-display', { hasText: 'KPI' })).toHaveCount(0);
    });
  });
}
