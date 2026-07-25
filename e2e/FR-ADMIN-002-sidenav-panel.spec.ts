import { test, expect, Page } from '@playwright/test';

// FREQ-203: Admin 左側縦ナビを薄いグレーの角丸パネル + アイコン + 選択中タブの濃いグレー塗りに刷新
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

// "rgb(244, 243, 241)" → [244, 243, 241]
function parseRgb(value: string): [number, number, number] {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) {
    throw new Error(`Unexpected color value: ${value}`);
  }
  const [r, g, b] = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
  return [r, g, b];
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-002 sidenav panel (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('各タブにアイコンが表示される', async ({ page }) => {
      // FREQ-203-AC-01
      await page.goto('/admin');

      const sideNav = page.getByRole('navigation', { name: '管理メニュー' });
      await expect(sideNav).toBeVisible();

      const kpiTab = sideNav.getByRole('button', { name: 'KPI' });
      const icon = kpiTab.locator('i');
      await expect(icon).toHaveCount(1);
      await expect(icon).toHaveClass(/ri-/);
    });

    test('選択中タブがパネル背景より濃いグレーで塗られる', async ({ page }) => {
      // FREQ-203-AC-02
      await page.goto('/admin');

      const sideNav = page.getByRole('navigation', { name: '管理メニュー' });
      const kpiTab = sideNav.getByRole('button', { name: 'KPI' });
      await expect(kpiTab).toHaveAttribute('aria-current', 'page');

      const panelColor = parseRgb(
        await sideNav.evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      const activeColor = parseRgb(
        await kpiTab.evaluate((el) => getComputedStyle(el).backgroundColor),
      );

      // 選択中タブの各 RGB 成分がパネルより小さい = より濃い
      expect(activeColor[0]).toBeLessThan(panelColor[0]);
      expect(activeColor[1]).toBeLessThan(panelColor[1]);
      expect(activeColor[2]).toBeLessThan(panelColor[2]);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-203-AC-03
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
