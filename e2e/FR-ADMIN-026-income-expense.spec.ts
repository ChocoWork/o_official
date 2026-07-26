import { test, expect, Page } from '@playwright/test';

// FREQ-233: コスト入力タブを「収支入力」に改称し、支出だけでなく収入も管理（収入は売上高へ反映）
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
  let nextId = 100;

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as { operation: string; expense?: Record<string, unknown>; template?: Record<string, unknown> };
      if (body.operation === 'expense.create' && body.expense) {
        const entry = { id: (nextId += 1), ...body.expense };
        if (body.expense.entryType === 'income') finance.incomes.unshift(entry);
        else finance.expenses.unshift(entry);
      }
      if (body.operation === 'template.create' && body.template) {
        finance.templates = [...finance.templates.filter((t) => t.name !== body.template!.name), body.template];
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: finance }) });
  });
}

async function openIncomeExpenseTab(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '取引管理' }).click();
  await page.getByRole('button', { name: '支出', exact: true }).waitFor();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-026 income & expense (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('タブ名が「取引管理」で、支出一覧と収入一覧が並ぶ', async ({ page }) => {
      // FREQ-233-AC-01
      await mockAdminApis(page);
      await page.goto('/admin');
      await page.getByRole('button', { name: 'ACCOUNTING' }).click();

      await expect(page.getByRole('tab', { name: '取引管理' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'コスト入力' })).toHaveCount(0);

      await page.getByRole('tab', { name: '取引管理' }).click();
      await expect(page.getByText('支出一覧（0件）')).toBeVisible();
      await expect(page.getByText('収入一覧（0件）')).toBeVisible();
    });

    test('種別を収入にして登録すると収入一覧と売上へ反映される', async ({ page }) => {
      // FREQ-233-AC-02 / AC-03
      await mockAdminApis(page);
      await openIncomeExpenseTab(page);

      await page.getByRole('button', { name: '収入', exact: true }).click();
      // 収入時は「収入概要」ラベルになり、収入用の選択肢が選べる。
      await expect(page.getByRole('button', { name: '収入概要' })).toBeVisible();
      await page.getByRole('button', { name: '収入概要' }).click();
      await page.getByRole('option', { name: 'オンライン販売' }).click();
      await page.getByRole('button', { name: '勘定科目' }).click();
      await page.getByRole('option', { name: '売上（収入）金額 / 売上高', exact: true }).click();
      await page.getByPlaceholder('0').fill('120000');
      await page.getByRole('button', { name: '保存', exact: true }).click();

      await expect(page.getByText('収入を保存し、仕訳帳と財務概要へ反映しました。')).toBeVisible();
      await expect(page.getByText('収入一覧（1件）')).toBeVisible();

      // 財務概要の売上に収入合計が反映される。
      await page.getByRole('tab', { name: '財務概要' }).click();
      await expect(page.getByText('¥120,000').first()).toBeVisible();
    });

    test('テンプレートは支出・収入で別管理される', async ({ page }) => {
      // FREQ-236-AC-02
      await mockAdminApis(page);
      await openIncomeExpenseTab(page);

      // 支出でテンプレートを1件作る。
      await page.getByRole('button', { name: '支出概要' }).click();
      await page.getByRole('option', { name: '縫製外注' }).click();
      await page.getByPlaceholder('0').fill('50000');
      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await page.getByRole('option', { name: '＋ 現在の入力を保存' }).click();
      await page.getByPlaceholder('テンプレート名').fill('縫製外注（支出）');
      await page.getByRole('button', { name: 'テンプレートを保存' }).click();
      await expect(page.getByText('テンプレートを保存しました。')).toBeVisible();

      // 支出のプルダウンには出る。
      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await expect(page.getByRole('option', { name: '縫製外注（支出）' })).toBeVisible();
      await page.getByRole('option', { name: '（テンプレートを選択）' }).click();

      // 収入へ切り替えると出ない。
      await page.getByRole('button', { name: '収入', exact: true }).click();
      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await expect(page.getByRole('option', { name: '縫製外注（支出）' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-233-AC-04
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
