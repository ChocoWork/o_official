import { test, expect, Page } from '@playwright/test';

// FREQ-234: 支出フォームの「支払い方法」→「出金方法」改称 + 出金方法の選択肢16項目
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

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

  const finance = {
    seasonKey: '2026SS',
    plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
    expenses: [] as Array<Record<string, unknown>>,
    incomes: [] as Array<Record<string, unknown>>,
    products: [] as Array<Record<string, unknown>>,
    partners: [] as string[],
    templates: [] as Array<Record<string, unknown>>,
  };

  await page.route('**/api/admin/kpi/cost-profit**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: finance }) }),
  );
}

async function openIncomeExpenseTab(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '取引管理' }).click();
  // FREQ-257 以降、取引の入力欄は「新規取引」Drawer の中にある。
  await page.getByRole('button', { name: '新規取引' }).click();
  await page.getByRole('button', { name: '支出', exact: true }).waitFor();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-027 expense payment method (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('支出フォームのラベルが「出金方法」になる', async ({ page }) => {
      // FREQ-234-AC-01
      await mockAdminApis(page);
      await openIncomeExpenseTab(page);

      await expect(page.getByRole('button', { name: '出金方法' })).toBeVisible();
      // FREQ-257 で一覧の列は絞られ、入出金方法は入力 Drawer と CSV に残る。
      await expect(page.getByText('支払い方法', { exact: true })).toHaveCount(0);
    });

    test('出金方法プルダウンに指定の選択肢が並ぶ', async ({ page }) => {
      // FREQ-234-AC-02
      await mockAdminApis(page);
      await openIncomeExpenseTab(page);

      await page.getByRole('button', { name: '出金方法' }).click();
      for (const option of ['現金', 'プライベート', '買掛金', '未払消費税', '仮受消費税']) {
        await expect(page.getByRole('option', { name: option, exact: true })).toBeVisible();
      }
    });

    test('収入は「入金方法」ラベルで、指定の選択肢が並ぶ', async ({ page }) => {
      // FREQ-235-AC-01 / AC-02
      await mockAdminApis(page);
      await openIncomeExpenseTab(page);

      await page.getByRole('button', { name: '収入', exact: true }).click();
      await expect(page.getByRole('button', { name: '入金方法' })).toBeVisible();

      await page.getByRole('button', { name: '入金方法' }).click();
      for (const option of ['現金', 'プライベート', '銀行', '売掛金', '受取手形', '仮払消費税']) {
        await expect(page.getByRole('option', { name: option, exact: true })).toBeVisible();
      }
      // 出金専用の科目は入金方法に出ない。
      await expect(page.getByRole('option', { name: '買掛金', exact: true })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-234-AC-03
      await mockAdminApis(page);
      await openIncomeExpenseTab(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
