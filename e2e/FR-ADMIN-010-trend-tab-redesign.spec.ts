import { test, expect, Page } from '@playwright/test';

// FREQ-211: 過去推移タブ（主要KPI推移グラフ + KPI一覧テーブル + 年度/シーズン/月 粒度セレクター）
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
            { year: 2025, metrics: [metric('1月', 100000, 22000, 1.2, 30, 300), metric('2月', 120000, 22500, 1.3, 33, 340)] },
            { year: 2026, metrics: [metric('1月', 180000, 24800, 1.6, 50, 600), metric('2月', 200000, 25200, 1.7, 55, 640)] },
          ],
          seasonalKpi: [
            metric('2026SS', 1240000, 24800, 1.6, 50, 3100),
            metric('2025AW', 980000, 22400, 1.3, 44, 2530),
          ],
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
  test.describe(`FR-ADMIN-010 trend tab redesign (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('年度/シーズン/月の粒度セレクターで系列が切り替わる', async ({ page }) => {
      // FREQ-211-AC-01
      await page.goto('/admin');
      await expect(page.getByText('リーチ数', { exact: true })).toBeVisible();
      await page.getByRole('tab', { name: '過去推移' }).click();

      const yearButton = page.getByRole('button', { name: '年度' });
      const seasonButton = page.getByRole('button', { name: 'シーズン' });
      const monthButton = page.getByRole('button', { name: '月', exact: true });
      await expect(yearButton).toBeVisible();
      await expect(seasonButton).toBeVisible();
      await expect(monthButton).toBeVisible();

      // 既定は年度が選択（年ラベルが列に出る）
      await expect(yearButton).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('columnheader', { name: '2026' })).toBeVisible();

      // シーズンに切替 → シーズンラベルの列になる
      await seasonButton.click();
      await expect(page.getByRole('columnheader', { name: '2026 S/S' })).toBeVisible();
    });

    test('推移グラフとKPI一覧テーブルが表示される', async ({ page }) => {
      // FREQ-211-AC-02 / AC-03（グラフは FREQ-215 で選択KPI1指標の単系列に変更）
      await page.goto('/admin');
      await expect(page.getByText('リーチ数', { exact: true })).toBeVisible();
      await page.getByRole('tab', { name: '過去推移' }).click();

      await expect(page.getByText('売上推移', { exact: true })).toBeVisible();
      await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toBeVisible();

      await expect(page.getByText('KPI一覧', { exact: true })).toBeVisible();
      // FREQ-219 で行はプルダウンと同じ19指標に変更
      await expect(page.getByRole('cell', { name: 'リーチ数' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: '成長率(CAGR)' })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-211-AC-01（横スクロールなし）
      await page.goto('/admin');
      await expect(page.getByText('リーチ数', { exact: true })).toBeVisible();
      await page.getByRole('tab', { name: '過去推移' }).click();
      await expect(page.getByText('売上推移', { exact: true })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
