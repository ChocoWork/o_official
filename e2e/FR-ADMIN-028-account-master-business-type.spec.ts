import { test, expect, Page } from '@playwright/test';

// FREQ-237: 勘定科目マスタに基づく選択肢 + 事業形態（個人事業主/法人）による出し分け
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
    businessType: 'soleProprietor',
    plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
    expenses: [] as Array<Record<string, unknown>>,
    incomes: [] as Array<Record<string, unknown>>,
    products: [] as Array<Record<string, unknown>>,
    partners: [] as string[],
    templates: [] as Array<Record<string, unknown>>,
  };

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: finance }) });
  });
}

async function openIncomeExpenseTab(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '取引管理' }).click();
  await page.getByRole('button', { name: '支出', exact: true }).waitFor();
}

async function openAccountDropdown(page: Page) {
  await page.getByRole('button', { name: '勘定科目' }).click();
}

async function selectBusinessType(page: Page, label: string) {
  await page.getByRole('button', { name: '事業形態' }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-028 account master & business type (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('勘定科目は種別ごとに出金科目・入金科目だけを表示し、非資金科目は出さない', async ({ page }) => {
      // FREQ-237-AC-01
      await mockAdminApis(page);
      await openIncomeExpenseTab(page);

      await openAccountDropdown(page);
      await expect(page.getByRole('option', { name: '経費 / 広告宣伝費', exact: true })).toBeVisible();
      await expect(page.getByRole('option', { name: '当期仕入高 / 仕入高', exact: true })).toBeVisible();
      // 非資金科目（決算整理・振替専用）は選択肢に出ない。
      await expect(page.getByRole('option', { name: '経費 / 減価償却費', exact: true })).toHaveCount(0);
      await expect(page.getByRole('option', { name: /期首商品棚卸高/ })).toHaveCount(0);
      await openAccountDropdown(page); // トリガー再クリックで閉じる

      await page.getByRole('button', { name: '収入', exact: true }).click();
      await openAccountDropdown(page);
      await expect(page.getByRole('option', { name: '売上（収入）金額 / 売上高', exact: true })).toBeVisible();
      // 出金専用科目は入金の選択肢に出ない。
      await expect(page.getByRole('option', { name: '経費 / 広告宣伝費', exact: true })).toHaveCount(0);
    });

    test('事業形態を法人へ切り替えると個人専用科目が消え法人科目が出る', async ({ page }) => {
      // FREQ-237-AC-02
      await mockAdminApis(page);
      await openIncomeExpenseTab(page);

      await openAccountDropdown(page);
      await expect(page.getByRole('option', { name: '事業主貸 / 事業主貸', exact: true })).toBeVisible();
      await expect(page.getByRole('option', { name: '経費 / 役員報酬', exact: true })).toHaveCount(0);
      await openAccountDropdown(page); // トリガー再クリックで閉じる

      await selectBusinessType(page, '法人');

      await openAccountDropdown(page);
      await expect(page.getByRole('option', { name: '経費 / 役員報酬', exact: true })).toBeVisible();
      await expect(page.getByRole('option', { name: '事業主貸 / 事業主貸', exact: true })).toHaveCount(0);
    });

    test('勘定科目が未選択のままでは保存できない', async ({ page }) => {
      // FREQ-237-AC-03
      await mockAdminApis(page);
      await openIncomeExpenseTab(page);

      await expect(page.getByRole('button', { name: '勘定科目' })).toContainText('（勘定科目を選択）');

      await page.getByRole('spinbutton').first().fill('12000');
      await page.getByRole('button', { name: '保存', exact: true }).click();

      await expect(page.getByRole('status').filter({ hasText: '勘定科目' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '支出一覧（0件）' })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-237-AC-04
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
