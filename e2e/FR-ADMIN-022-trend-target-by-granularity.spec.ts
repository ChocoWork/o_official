import { test, expect, Page } from '@playwright/test';

// FREQ-224: 推移グラフの目標を粒度別に算出（年度=SS+AW合計 / シーズン=当該 / 月=該当シーズン÷6）
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
  return Array.from({ length: 12 }, (_, i) =>
    metric(`${i + 1}月`, 150000 + i * 20000 * seed, 20000 + i * 800, 0.9 + i * 0.3, 3 + i, i + seed),
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
          monthlyYearOptions: [2025, 2026],
          monthlyKpiByYear: [
            { year: 2025, metrics: months(1) },
            { year: 2026, metrics: months(2) },
          ],
          seasonalKpi: [
            metric('2026SS', 1300000, 24800, 1.6, 50, 3100),
            metric('2026AW', 1800000, 26000, 1.7, 60, 3400),
          ],
        },
      }),
    });
  });

  // 売上目標：SS 780万円 / AW 1200万円
  await page.route('**/api/admin/kpi/targets', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          currentSeason: '2026SS',
          seasons: ['2026SS', '2026AW'],
          definitions: [{ key: 'sales', label: '売上', definition: '', priority: '◎' }],
          values: { sales: { '2026SS': '780万円', '2026AW': '1200万円' } },
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

function chart(page: Page) {
  return page.locator('svg[aria-label="売上の推移グラフ"]');
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-022 trend target by granularity (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('年度は SS+AW の合計が目標になる', async ({ page }) => {
      // FREQ-224-AC-01
      await openTrendTab(page);
      await expect(chart(page).getByText('目標 ¥19,800,000', { exact: true })).toBeVisible();
    });

    test('月は該当シーズンの目標を6分割する（SS=130万 / AW=200万）', async ({ page }) => {
      // FREQ-224-AC-02
      await openTrendTab(page);
      await page.getByRole('button', { name: '月', exact: true }).click();

      await expect(chart(page).getByText('目標 ¥1,300,000', { exact: true })).toBeVisible();
      await expect(chart(page).getByText('目標 ¥2,000,000', { exact: true })).toBeVisible();
    });

    test('シーズンは各シーズン自身の目標になる', async ({ page }) => {
      // FREQ-224-AC-03
      await openTrendTab(page);
      await page.getByRole('button', { name: 'シーズン', exact: true }).click();

      await expect(chart(page).getByText('目標 ¥7,800,000', { exact: true })).toBeVisible();
      await expect(chart(page).getByText('目標 ¥12,000,000', { exact: true })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-224-AC-04
      await openTrendTab(page);
      await page.getByRole('button', { name: '月', exact: true }).click();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
