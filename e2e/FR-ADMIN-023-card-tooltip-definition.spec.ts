import { test, expect, Page } from '@playwright/test';

// FREQ-225: 目標＆進捗タブのカードのツールチップに月次目標の「定義」列を併記
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
          monthlyYearOptions: [2026],
          monthlyKpiByYear: [{ year: 2026, metrics: [metric('1月', 500000, 24800, 1.6, 50, 3100)] }],
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
          definitions: [
            { key: 'sales', label: '売上', definition: '総売上', priority: '◎' },
            { key: 'aov', label: '客単価（AOV）', definition: '売上 ÷ 注文数', priority: '◎' },
          ],
          values: { sales: { '2026SS': '約130万円' } },
        },
      }),
    });
  });
}

// 「売上」ラベル（exact）から祖先のカード div を得る。
// FREQ-261 でカードは選択可能なボタンになった
function salesCard(page: Page) {
  return page
    .locator('[data-ui-panel]')
    .filter({ hasText: 'KPI一覧' })
    .first()
    .getByRole('button', { name: /^売上：/ });
}

function kpiListPanel(page: Page) {
  return page.locator('[data-ui-panel]').filter({ hasText: 'KPI一覧' }).first();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-023 card tooltip definition (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('カードアイコンの aria-label に定義が含まれる', async ({ page }) => {
      // FREQ-225-AC-01
      await page.goto('/admin');
      await expect(kpiListPanel(page).getByRole('button', { name: /^リーチ数：/ })).toBeVisible();

      await expect(salesCard(page).getByRole('img')).toHaveAttribute('aria-label', /総売上/);
    });

    test('ホバーで定義行が表示される（ホバー前は非表示）', async ({ page }) => {
      // FREQ-225-AC-02
      await page.goto('/admin');
      await expect(kpiListPanel(page).getByRole('button', { name: /^リーチ数：/ })).toBeVisible();

      const card = salesCard(page);
      const definitionLine = card.getByText('定義: 総売上');

      await expect(definitionLine).toBeHidden();
      await card.getByRole('img').hover();
      await expect(definitionLine).toBeVisible();
    });

    test('（ホバーなしで）横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-225-AC-03
      await page.goto('/admin');
      await expect(kpiListPanel(page).getByRole('button', { name: /^リーチ数：/ })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
