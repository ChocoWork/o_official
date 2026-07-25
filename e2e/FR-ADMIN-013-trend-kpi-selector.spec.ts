import { test, expect, Page } from '@playwright/test';

// FREQ-215: 過去推移タブのKPI選択プルダウンと単系列グラフ
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

function metric(period: string, sales: number, aov: number, cvr: number, orders: number, customers: number) {
  return {
    period,
    salesAmount: sales,
    formattedSales: `¥${sales.toLocaleString()}`,
    cvr,
    formattedCvr: `${cvr}%`,
    aov,
    formattedAov: `¥${aov.toLocaleString()}`,
    setPurchaseRate: 12,
    formattedSetPurchaseRate: '12%',
    inventoryConsumptionRate: 68,
    formattedInventoryConsumptionRate: '68%',
    ltv: 112300,
    formattedLtv: '¥112,300',
    repeatRate: 30,
    formattedRepeatRate: '30%',
    returnRate: 5,
    formattedReturnRate: '5%',
    orderCount: orders,
    paidOrderCount: orders,
    customerCount: customers,
    repeatCustomerCount: 10,
  };
}

function months(seed: number) {
  return ['1月', '2月', '3月'].map((m, i) =>
    metric(m, 40000 + i * 30000 * seed, 20000 + i * 800, 0.9 + i * 0.3, 3 + i, i + seed),
  );
}

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
          monthlyYearOptions: [2024, 2025, 2026],
          monthlyKpiByYear: [
            { year: 2024, metrics: months(1) },
            { year: 2025, metrics: months(2) },
            { year: 2026, metrics: months(3) },
          ],
          seasonalKpi: [metric('2026SS', 1240000, 24800, 1.6, 50, 3100)],
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

async function openTrendTab(page: Page) {
  await page.goto('/admin');
  await page.getByText('リーチ数', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '過去推移' }).click();
}

const KPI_SELECTOR = '推移グラフに表示するKPI';

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-013 trend KPI selector (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('KPIプルダウンが粒度ボタンと同じ行の右側にあり、19件の選択肢を持つ', async ({ page }) => {
      // FREQ-215-AC-01
      await openTrendTab(page);

      const monthButton = page.getByRole('button', { name: '月', exact: true });
      const trigger = page.getByRole('button', { name: KPI_SELECTOR });
      await expect(trigger).toBeVisible();

      const monthBox = await monthButton.boundingBox();
      const triggerBox = await trigger.boundingBox();
      if (!monthBox || !triggerBox) {
        throw new Error('bounding box not found');
      }
      expect(Math.abs(triggerBox.y - monthBox.y)).toBeLessThanOrEqual(8);
      expect(triggerBox.x).toBeGreaterThan(monthBox.x);

      await trigger.click();
      await expect(page.getByRole('listbox')).toBeVisible();
      await expect(page.getByRole('option')).toHaveCount(19);
    });

    test('選んだKPIの単系列グラフに切り替わる', async ({ page }) => {
      // FREQ-215-AC-02
      await openTrendTab(page);

      await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toBeVisible();

      await page.getByRole('button', { name: KPI_SELECTOR }).click();
      await page.getByRole('option', { name: 'CVR', exact: true }).click();

      await expect(page.getByRole('img', { name: 'CVRの推移グラフ' })).toBeVisible();
      await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toHaveCount(0);
    });

    test('見出しと単位が選択したKPIに連動し、参考値KPIには参考バッジが付く', async ({ page }) => {
      // FREQ-215-AC-03
      await openTrendTab(page);

      // グラフ見出しは一意（表の行ラベルは「売上」で「売上推移」ではない）。
      // 参考バッジは表の行にも付くため、見出し直下のコンテナにスコープして判定する。
      const salesHeading = page.getByText('売上推移', { exact: true });
      await expect(salesHeading).toBeVisible();
      await expect(page.getByText('単位：円', { exact: true })).toBeVisible();
      await expect(salesHeading.locator('..').getByText('参考', { exact: true })).toHaveCount(0);

      await page.getByRole('button', { name: KPI_SELECTOR }).click();
      await page.getByRole('option', { name: 'CPM', exact: true }).click();

      const cpmHeading = page.getByText('CPM推移', { exact: true });
      await expect(cpmHeading).toBeVisible();
      await expect(cpmHeading.locator('..').getByText('参考', { exact: true })).toBeVisible();
    });

    test('選択肢メニューは高さ上限内でスクロールし、横スクロールを起こさない', async ({ page }) => {
      // FREQ-215-AC-04
      await openTrendTab(page);
      await page.getByRole('button', { name: KPI_SELECTOR }).click();

      const menu = page.getByRole('listbox');
      await expect(menu).toBeVisible();

      const scrollable = await menu.evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(scrollable).toBe(true);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
