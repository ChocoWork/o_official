import { test, expect, Page } from '@playwright/test';

// FREQ-238: ACCOUNTING タブを KPI の直下に追加し、コスト & 利益の中身を移設
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ACCOUNTING_SUB_TABS = ['財務概要', '取引管理', '帳簿', '商品原価', '税務レポート'];

function metric(period: string) {
  return {
    period,
    salesAmount: 0, formattedSales: '¥0',
    cvr: 0, formattedCvr: '0.0%',
    aov: 0, formattedAov: '¥0',
    setPurchaseRate: 0, formattedSetPurchaseRate: '0.0%',
    inventoryConsumptionRate: 0, formattedInventoryConsumptionRate: '0.0%',
    ltv: 0, formattedLtv: '¥0',
    repeatRate: 0, formattedRepeatRate: '0.0%',
    returnRate: 0, formattedReturnRate: '0.0%',
    orderCount: 0, paidOrderCount: 0, customerCount: 0, repeatCustomerCount: 0,
    setOrderCount: 0, cancelledOrderCount: 0, soldItemCount: 0, publishedItemCount: 0,
  };
}

async function mockAdminApis(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true } }),
    }),
  );

  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          targetYear: 2026,
          monthlyYearOptions: [2026],
          monthlyKpiByYear: [{ year: 2026, metrics: Array.from({ length: 12 }, (_, i) => metric(`${i + 1}月`)) }],
          seasonalKpi: [metric('2026SS')],
        },
      }),
    }),
  );

  await page.route('**/api/admin/kpi/targets', (route) =>
    route.fulfill({
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
    }),
  );

  await page.route('**/api/admin/kpi/monthly-record**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { season: '2026SS', monthKeys: [], values: {} } }),
    }),
  );

  await page.route('**/api/admin/kpi/cost-profit**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          seasonKey: '2026SS',
          businessType: 'soleProprietor',
          plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
          expenses: [],
          incomes: [],
          products: [],
          partners: [],
          templates: [],
        },
      }),
    }),
  );
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-029 accounting tab (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('左ナビの ACCOUNTING が KPI の直後に並ぶ', async ({ page }) => {
      // FREQ-238-AC-01
      await page.goto('/admin');

      const navButtons = page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button');
      await expect(navButtons).toHaveText(['KPI', 'ACCOUNTING', 'NEWS', 'ITEM', 'LOOK', 'STOCKIST', 'USER', 'ORDER']);
    });

    test('KPI タブのサブタブから「コスト & 利益」が消える', async ({ page }) => {
      // FREQ-238-AC-02
      await page.goto('/admin');

      await expect(page.getByRole('tab', { name: '目標 & 進捗' })).toBeVisible();
      await expect(page.getByRole('tab', { name: '過去推移' })).toBeVisible();
      await expect(page.getByRole('tab', { name: '月次記録' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'コスト & 利益' })).toHaveCount(0);
    });

    test('ACCOUNTING タブに5つのサブタブとシーズン選択が並ぶ', async ({ page }) => {
      // FREQ-238-AC-03
      await page.goto('/admin');
      await page.getByRole('button', { name: 'ACCOUNTING' }).click();

      for (const label of ACCOUNTING_SUB_TABS) {
        await expect(page.getByRole('tab', { name: label })).toBeVisible();
      }
      await expect(page.getByRole('button', { name: '2026 S/S' })).toBeVisible();

      await page.getByRole('tab', { name: '取引管理' }).click();
      await expect(page.getByRole('heading', { name: '支出一覧（0件）' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '収入一覧（0件）' })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-238-AC-04
      await page.goto('/admin');
      await page.getByRole('button', { name: 'ACCOUNTING' }).click();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
