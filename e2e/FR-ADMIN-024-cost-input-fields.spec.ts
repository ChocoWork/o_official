import { test, expect, Page } from '@playwright/test';

// FREQ-230: コスト入力タブ = カテゴリ→勘定科目 / 項目→支出概要(固定プルダウン) / 取引先(選択+新規登録)
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

function metric(period: string) {
  return {
    period,
    salesAmount: 0,
    formattedSales: '¥0',
    cvr: 0,
    formattedCvr: '0.0%',
    aov: 0,
    formattedAov: '¥0',
    setPurchaseRate: 0,
    formattedSetPurchaseRate: '0.0%',
    inventoryConsumptionRate: 0,
    formattedInventoryConsumptionRate: '0.0%',
    ltv: 0,
    formattedLtv: '¥0',
    repeatRate: 0,
    formattedRepeatRate: '0.0%',
    returnRate: 0,
    formattedReturnRate: '0.0%',
    orderCount: 0,
    paidOrderCount: 0,
    customerCount: 0,
    repeatCustomerCount: 0,
    setOrderCount: 0,
    cancelledOrderCount: 0,
    soldItemCount: 0,
    publishedItemCount: 0,
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

  // 会計データ（コスト＆利益）。partner.create はマスタへ追加し、以降のGETに反映する。
  const finance = {
    seasonKey: '2026SS',
    plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
    expenses: [] as Array<Record<string, unknown>>,
    incomes: [] as Array<Record<string, unknown>>,
    products: [] as Array<Record<string, unknown>>,
    partners: ['丸善テキスタイル'] as string[],
  };
  let nextExpenseId = 100;

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as { operation: string; partnerName?: string; expense?: Record<string, unknown> };
      if (body.operation === 'partner.create' && body.partnerName && !finance.partners.includes(body.partnerName)) {
        finance.partners.push(body.partnerName);
      }
      if (body.operation === 'expense.create' && body.expense) {
        finance.expenses.unshift({ id: (nextExpenseId += 1), ...body.expense });
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: finance }) });
  });
}

async function openCostInputTab(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '取引管理' }).click();
  // FREQ-257 以降、取引の入力欄は「新規取引」Drawer の中にある。
  await page.getByRole('button', { name: '新規取引' }).click();
  // プルダウンは黄金比UIの SingleSelect（dropdown）。トリガーは button。
  await page.getByRole('button', { name: '勘定科目' }).waitFor();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-024 cost input fields (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('「カテゴリ」が「勘定科目」に変わっている', async ({ page }) => {
      // FREQ-230-AC-01
      await mockAdminApis(page);
      await openCostInputTab(page);

      await expect(page.getByRole('button', { name: '勘定科目' })).toBeVisible();
      await expect(page.getByText('カテゴリ', { exact: true })).toHaveCount(0);
    });

    test('「支出概要」がプルダウンで、選んだ経費が仕訳帳に反映される', async ({ page }) => {
      // FREQ-230-AC-02
      await mockAdminApis(page);
      await openCostInputTab(page);

      // SingleSelect（dropdown）: トリガーを開いて選択肢を押す。
      await page.getByRole('button', { name: '支出概要' }).click();
      await page.getByRole('option', { name: '展示会・イベント' }).click();
      await page.getByRole('button', { name: '勘定科目' }).click();
      await page.getByRole('option', { name: '経費 / 広告宣伝費', exact: true }).click();
      await page.getByPlaceholder('0').fill('45000');
      await page.getByRole('button', { name: '保存', exact: true }).click();

      await expect(page.getByText('支出を保存し、仕訳帳と財務概要へ反映しました。')).toBeVisible();

      await page.getByRole('tab', { name: '帳簿', exact: true }).click();
      await expect(page.getByText('展示会・イベント')).toBeVisible();
    });

    test('「取引先」プルダウンに登録済みと「＋新規登録」がある', async ({ page }) => {
      // FREQ-230-AC-03
      await mockAdminApis(page);
      await openCostInputTab(page);

      await page.getByRole('button', { name: '取引先' }).click();
      await expect(page.getByRole('option', { name: '丸善テキスタイル' })).toBeVisible();
      await expect(page.getByRole('option', { name: '＋ 新規登録' })).toBeVisible();
    });

    test('取引先を新規登録するとプルダウンの選択肢に追加される', async ({ page }) => {
      // FREQ-230-AC-04
      await mockAdminApis(page);
      await openCostInputTab(page);

      await page.getByRole('button', { name: '取引先' }).click();
      await page.getByRole('option', { name: '＋ 新規登録' }).click();
      await page.getByPlaceholder('取引先名を入力').fill('東京副資材');
      await page.getByRole('button', { name: '登録', exact: true }).click();

      await expect(page.getByText('取引先を登録しました。')).toBeVisible();
      // 登録後に開き直すと選択肢に追加されている。
      await page.getByRole('button', { name: '取引先' }).click();
      await expect(page.getByRole('option', { name: '東京副資材' })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-230-AC-05
      await mockAdminApis(page);
      await openCostInputTab(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
