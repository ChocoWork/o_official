import { test, expect, Page } from '@playwright/test';

// FREQ-205: Admin 左側縦ナビを無彩色（白・黒・グレー）に統一し、選択中タブ左端に黒い縦線を表示
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

// "rgb(244, 244, 244)" → [244, 244, 244]
function parseRgb(value: string): [number, number, number] {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) {
    throw new Error(`Unexpected color value: ${value}`);
  }
  const [r, g, b] = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
  return [r, g, b];
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-004 sidenav monochrome & active bar (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('ナビパネルと選択中タブの背景色が無彩色である', async ({ page }) => {
      // FREQ-205-AC-01
      await page.goto('/admin');

      const sideNav = page.getByRole('navigation', { name: '管理メニュー' });
      await expect(sideNav).toBeVisible();

      const panel = parseRgb(await sideNav.evaluate((el) => getComputedStyle(el).backgroundColor));
      expect(panel[0]).toBe(panel[1]);
      expect(panel[1]).toBe(panel[2]);

      const kpiTab = sideNav.getByRole('button', { name: 'KPI' });
      const active = parseRgb(await kpiTab.evaluate((el) => getComputedStyle(el).backgroundColor));
      expect(active[0]).toBe(active[1]);
      expect(active[1]).toBe(active[2]);
    });

    test('選択中タブの左端に黒い縦線が表示される', async ({ page }) => {
      // FREQ-205-AC-02
      await page.goto('/admin');

      const sideNav = page.getByRole('navigation', { name: '管理メニュー' });
      const kpiTab = sideNav.getByRole('button', { name: 'KPI' });

      const active = await kpiTab.evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.borderLeftColor, width: Number.parseFloat(style.borderLeftWidth) };
      });
      expect(active.color).toBe('rgb(0, 0, 0)');
      expect(active.width).toBeGreaterThanOrEqual(1);

      const newsTab = sideNav.getByRole('button', { name: 'NEWS' });
      const inactiveColor = await newsTab.evaluate((el) => getComputedStyle(el).borderLeftColor);
      expect(inactiveColor).not.toBe('rgb(0, 0, 0)');
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-205-AC-03
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
