import { test, expect, Page } from '@playwright/test';

// FREQ-208: シーズン選択ボタンをサブタブの下に配置
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
  test.describe(`FR-ADMIN-007 season selector below sub-tabs (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('シーズンボタンがサブタブの下に配置される', async ({ page }) => {
      // FREQ-208-AC-01
      await page.goto('/admin');

      const subTab = page.getByRole('tab', { name: '目標 & 進捗' });
      await expect(subTab).toBeVisible();

      const seasonButton = page.getByRole('button', { name: '2026 S/S' });
      await expect(seasonButton).toBeVisible();

      const subTabBox = await subTab.boundingBox();
      const seasonBox = await seasonButton.boundingBox();
      if (!subTabBox || !seasonBox) {
        throw new Error('bounding box not found');
      }

      // シーズンボタンの上端がサブタブの下端より下にある
      expect(seasonBox.y).toBeGreaterThan(subTabBox.y + subTabBox.height);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-208-AC-02
      await page.goto('/admin');
      await expect(page.getByRole('button', { name: '2026 S/S' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
