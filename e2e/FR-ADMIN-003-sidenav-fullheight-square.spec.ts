import { test, expect, Page } from '@playwright/test';

// FREQ-204: Admin 左側縦ナビを本文と同じ高さ（画面下端）まで伸ばし、角丸を廃して角を四角にする
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
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-003 sidenav full-height & square (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('ナビパネルと選択中タブの角が四角（border-radius 0）である', async ({ page }) => {
      // FREQ-204-AC-02
      await page.goto('/admin');

      const sideNav = page.getByRole('navigation', { name: '管理メニュー' });
      await expect(sideNav).toBeVisible();

      const navRadius = await sideNav.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
      expect(navRadius).toBe('0px');

      const kpiTab = sideNav.getByRole('button', { name: 'KPI' });
      const tabRadius = await kpiTab.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
      expect(tabRadius).toBe('0px');
    });

    if (viewport.width >= 768) {
      test('ナビパネルが本文と同じ高さ（画面下端）まで伸びる', async ({ page }) => {
        // FREQ-204-AC-01（md 以上のみ）
        await page.goto('/admin');

        const sideNav = page.getByRole('navigation', { name: '管理メニュー' });
        await expect(sideNav).toBeVisible();

        const heights = await sideNav.evaluate((nav) => {
          const aside = nav.parentElement as HTMLElement;
          const row = aside.parentElement as HTMLElement;
          return {
            nav: nav.getBoundingClientRect().height,
            row: row.getBoundingClientRect().height,
          };
        });

        // md 以上ではパネルが行（本文カラム）の高さと一致する
        expect(heights.nav).toBeGreaterThanOrEqual(heights.row - 4);
      });
    }

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-204-AC-03
      await page.goto('/admin');
      await expect(page.getByRole('navigation', { name: '管理メニュー' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
