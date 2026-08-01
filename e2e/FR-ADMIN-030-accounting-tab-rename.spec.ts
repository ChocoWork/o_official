import { test, expect, Page } from '@playwright/test';

// FREQ-240: ACCOUNTING タブのサブタブ改称（財務サマリー→財務概要 / 収支入力→取引管理 / 帳簿（仕訳一覧）→帳簿）
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const NEW_SUB_TABS = ['財務概要', '取引管理', '帳簿', '商品原価', '税務レポート'];
const OLD_SUB_TABS = ['財務サマリー', '収支入力', '帳簿（仕訳一覧）'];

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

  // 会計データ。expense.create は保持して以降のGETに反映する。
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
  let nextExpenseId = 100;

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as { operation: string; expense?: Record<string, unknown> };
      if (body.operation === 'expense.create' && body.expense) {
        finance.expenses.unshift({ id: (nextExpenseId += 1), partner: '', ...body.expense });
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: finance }) });
  });
}

async function openAccounting(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-030 accounting sub tab rename (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('サブタブが新名称で並び、旧名称は表示されない', async ({ page }) => {
      // FREQ-240-AC-01
      await openAccounting(page);

      for (const label of NEW_SUB_TABS) {
        await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
      }
      for (const label of OLD_SUB_TABS) {
        await expect(page.getByRole('tab', { name: label, exact: true })).toHaveCount(0);
      }
    });

    test('支出保存メッセージが新名称「財務概要」を参照する', async ({ page }) => {
      // FREQ-240-AC-02
      await openAccounting(page);
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();
      // FREQ-257 以降、取引の入力欄は「新規取引」Drawer の中にある。
      await page.getByRole('button', { name: '新規取引' }).click();

      await page.getByRole('button', { name: '支出概要' }).click();
      await page.getByRole('option', { name: '展示会・イベント' }).click();
      await page.getByRole('button', { name: '勘定科目' }).click();
      await page.getByRole('option', { name: '経費 / 広告宣伝費', exact: true }).click();
      await page.getByPlaceholder('0').fill('45000');
      await page.getByRole('button', { name: '保存', exact: true }).click();

      await expect(page.getByText('支出を保存し、仕訳帳と財務概要へ反映しました。')).toBeVisible();
      await expect(page.getByText('財務サマリーへ反映')).toHaveCount(0);
    });

    test('改称後も取引管理と帳簿の中身が従来どおり表示される', async ({ page }) => {
      // FREQ-240-AC-03
      await openAccounting(page);

      await page.getByRole('tab', { name: '取引管理', exact: true }).click();
      await expect(page.getByRole('heading', { name: '取引管理', exact: true })).toBeVisible();
      await expect(page.getByText('該当する取引がありません。')).toBeVisible();

      await page.getByRole('tab', { name: '帳簿', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: '仕訳・元帳', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '仕訳帳CSV' })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-240-AC-04
      await openAccounting(page);
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
