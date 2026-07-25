import { test, expect, Page } from '@playwright/test';

// FREQ-222: 推移グラフ改善（1点でも描画 / 区切りのよいY軸 / 目標線）
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
  return ['1月', '2月', '3月'].map((m, i) => metric(m, 40000 + i * 30000 * seed, 20000 + i * 800, 0.9 + i * 0.3, 3 + i, i + seed));
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
          seasonalKpi: [metric('2026SS', 620000, 24800, 1.6, 50, 3100)],
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
          values: {
            sales: { '2026SS': '¥600,000' },
            cvr: { '2026SS': '3.0%' },
          },
        },
      }),
    });
  });
}

async function openTrendTab(page: Page) {
  await page.goto('/admin');
  await page.getByText('リーチ数', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '過去推移' }).click();
  await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toBeVisible();
}

async function selectKpi(page: Page, label: string) {
  await page.getByRole('button', { name: '推移グラフに表示するKPI' }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-020 trend chart ticks & target (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('データが1点でも点が描画される', async ({ page }) => {
      // FREQ-222-AC-01
      await openTrendTab(page);
      await page.getByRole('button', { name: 'シーズン', exact: true }).click();

      const chart = page.locator('svg[aria-label="売上の推移グラフ"]');
      await expect(chart).toBeVisible();
      await expect(chart.locator('circle')).toHaveCount(1);
      // 1点では折れ線は描かない
      await expect(chart.locator('polyline')).toHaveCount(0);
    });

    test('Y軸が区切りのよい目盛りになる', async ({ page }) => {
      // FREQ-222-AC-02
      await openTrendTab(page);

      const salesChart = page.locator('svg[aria-label="売上の推移グラフ"]');
      await expect(salesChart.getByText('¥0', { exact: true })).toBeVisible();
      await expect(salesChart.getByText('¥200,000', { exact: true })).toBeVisible();

      await selectKpi(page, 'CVR');
      const cvrChart = page.locator('svg[aria-label="CVRの推移グラフ"]');
      await expect(cvrChart.getByText('0.0%', { exact: true })).toBeVisible();
      await expect(cvrChart.getByText('3.0%', { exact: true })).toBeVisible();
    });

    test('目標値が実データKPIには破線で表示され、参考値KPIには表示されない', async ({ page }) => {
      // FREQ-222-AC-03
      await openTrendTab(page);

      const salesChart = page.locator('svg[aria-label="売上の推移グラフ"]');
      await expect(salesChart.getByText('目標 ¥600,000', { exact: true })).toBeVisible();
      await expect(salesChart.locator('line[stroke-dasharray]')).toHaveCount(1);

      // 参考値KPI（リーチ数）は目標線を出さない
      await selectKpi(page, 'リーチ数');
      const reachChart = page.locator('svg[aria-label="リーチ数の推移グラフ"]');
      await expect(reachChart).toBeVisible();
      await expect(reachChart.getByText('目標', { exact: false })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-222-AC-04
      await openTrendTab(page);
      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
