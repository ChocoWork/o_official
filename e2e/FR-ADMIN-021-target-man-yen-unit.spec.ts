import { test, expect, Page } from '@playwright/test';

// FREQ-223: 目標文字列の「万」「億」を倍率として解釈（「約130万円」→ 1,300,000）
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
  return ['1月', '2月', '3月'].map((m, i) => metric(m, 400000 + i * 50000 * seed, 20000 + i * 800, 0.9 + i * 0.3, 3 + i, i + seed));
}

// sales 目標文字列を差し替えられるモック。
async function mockAdminApis(page: Page, salesTarget: string): Promise<void> {
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
          seasonalKpi: [metric('2026SS', 1300000, 24800, 1.6, 50, 3100)],
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
          definitions: [{ key: 'sales', label: '売上', definition: '総売上', priority: '◎' }],
          values: { sales: { '2026SS': salesTarget } },
        },
      }),
    });
  });
}

// FREQ-261 でグラフ上の目標ラベルは廃止。解釈結果は選択中KPIの目標表示と達成率で確認する。
async function openKpiWorkspace(page: Page) {
  await page.goto('/admin');
  await page.getByRole('heading', { name: 'KPIダッシュボード' }).waitFor();
  await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toBeVisible();
}

function salesCard(page: Page) {
  return page
    .locator('[data-ui-panel]')
    .filter({ hasText: 'KPI一覧' })
    .first()
    .getByRole('button', { name: /^売上：/ });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-021 target 万/億 unit (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('「約130万円」の目標が ¥1,300,000 として扱われる', async ({ page }) => {
      // FREQ-223-AC-01
      await mockAdminApis(page, '約130万円');
      await openKpiWorkspace(page);

      await expect(salesCard(page)).toContainText('目標 ¥1,300,000');
      await expect(salesCard(page)).not.toContainText('目標 ¥130');
      // 実績 1,300,000 ÷ 目標 1,300,000 = 100.0%
      await expect(salesCard(page)).toContainText('100.0%');
    });

    test('範囲「600万〜1,000万円」の目標が下限 ¥6,000,000 として扱われる', async ({ page }) => {
      // FREQ-223-AC-02
      await mockAdminApis(page, '600万〜1,000万円');
      await openKpiWorkspace(page);

      // 範囲指定は表記のまま見せ、達成率は下限（600万）を基準に算出する
      await expect(salesCard(page)).toContainText('600万〜1,000万円');
      // 実績 1,300,000 ÷ 目標 6,000,000 = 21.7%
      await expect(salesCard(page)).toContainText('21.7%');
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-223-AC-03
      await mockAdminApis(page, '約130万円');
      await openKpiWorkspace(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
