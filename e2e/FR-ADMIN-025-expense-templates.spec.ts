import { test, expect, Page } from '@playwright/test';

// FREQ-232: 勘定科目・支出概要・金額・支払い方法・メモをテンプレート保存し、選択して経費フォームへ反映
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

type Template = { name: string; category: string; item: string; amount: number; paymentMethod: string; memo: string };

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
    templates: [] as Template[],
  };

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as { operation: string; template?: Template; templateName?: string };
      if (body.operation === 'template.create' && body.template) {
        finance.templates = [...finance.templates.filter((t) => t.name !== body.template!.name), body.template];
      }
      if (body.operation === 'template.delete' && body.templateName) {
        finance.templates = finance.templates.filter((t) => t.name !== body.templateName);
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: finance }) });
  });
}

async function openCostInputTab(page: Page) {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'コスト & 利益' }).click();
  await page.getByRole('tab', { name: '収支入力' }).click();
  await page.getByRole('button', { name: 'テンプレート' }).waitFor();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-025 expense templates (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('現在の入力をテンプレート保存（名前初期値=支出概要/金額）できる', async ({ page }) => {
      // FREQ-232-AC-01 / AC-02
      await mockAdminApis(page);
      await openCostInputTab(page);

      await page.getByRole('button', { name: '支出概要' }).click();
      await page.getByRole('option', { name: '縫製外注' }).click();
      await page.getByPlaceholder('0').fill('50000');

      await page.getByRole('button', { name: 'テンプレート' }).click();
      await page.getByRole('option', { name: '＋ 現在の入力を保存' }).click();

      await expect(page.getByPlaceholder('テンプレート名')).toHaveValue('縫製外注 / ¥50,000');
      await page.getByPlaceholder('テンプレート名').fill('縫製外注（定番）');
      await page.getByRole('button', { name: '保存', exact: true }).click();

      await expect(page.getByText('テンプレートを保存しました。')).toBeVisible();
      await page.getByRole('button', { name: 'テンプレート' }).click();
      await expect(page.getByRole('option', { name: '縫製外注（定番）' })).toBeVisible();
    });

    test('保存済みテンプレートを選ぶと支出概要・金額がフォームへ反映される', async ({ page }) => {
      // FREQ-232-AC-03
      await mockAdminApis(page);
      await openCostInputTab(page);

      // 先にテンプレートを1件作る。
      await page.getByRole('button', { name: '支出概要' }).click();
      await page.getByRole('option', { name: '縫製外注' }).click();
      await page.getByPlaceholder('0').fill('50000');
      await page.getByRole('button', { name: 'テンプレート' }).click();
      await page.getByRole('option', { name: '＋ 現在の入力を保存' }).click();
      await page.getByPlaceholder('テンプレート名').fill('縫製外注（定番）');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('テンプレートを保存しました。')).toBeVisible();

      // 別の支出概要・金額へ変更。
      await page.getByRole('button', { name: '支出概要' }).click();
      await page.getByRole('option', { name: '広告出稿' }).click();
      await page.getByPlaceholder('0').fill('12000');

      // テンプレートを選び直すと戻る。
      await page.getByRole('button', { name: 'テンプレート' }).click();
      await page.getByRole('option', { name: '縫製外注（定番）' }).click();

      await expect(page.getByRole('button', { name: '支出概要' })).toHaveText(/縫製外注/);
      await expect(page.getByPlaceholder('0')).toHaveValue('50000');
    });

    test('テンプレートを削除できる', async ({ page }) => {
      // FREQ-232-AC-03（削除）
      await mockAdminApis(page);
      await openCostInputTab(page);

      await page.getByRole('button', { name: 'テンプレート' }).click();
      await page.getByRole('option', { name: '＋ 現在の入力を保存' }).click();
      await page.getByPlaceholder('テンプレート名').fill('使い捨て');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('テンプレートを保存しました。')).toBeVisible();

      await page.getByRole('button', { name: '選択中のテンプレートを削除' }).click();
      await expect(page.getByText('テンプレートを削除しました。')).toBeVisible();

      await page.getByRole('button', { name: 'テンプレート' }).click();
      await expect(page.getByRole('option', { name: '使い捨て' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-232-AC-04
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
