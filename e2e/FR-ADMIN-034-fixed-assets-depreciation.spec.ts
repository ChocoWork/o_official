import { test, expect, Page } from '@playwright/test';

// FREQ-244: 固定資産台帳と減価償却計算。定額法・一括償却・即時償却・事業按分。
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

// 定額法（1月取得・6年）／一括償却（3年均等）／定額法＋事業按分70%
const FIXED_ASSETS = [
  {
    id: 1, name: '工業用ミシン', account: '工具器具備品', acquiredOn: '2026-01-10',
    acquisitionCost: 600000, usefulLife: 6, method: 'straightLine',
    businessUseRatio: 100, disposedOn: null, memo: '',
  },
  {
    id: 2, name: 'タブレット', account: '工具器具備品', acquiredOn: '2026-05-01',
    acquisitionCost: 180000, usefulLife: 4, method: 'lumpSum3Year',
    businessUseRatio: 100, disposedOn: null, memo: '',
  },
  {
    id: 3, name: '自宅兼用ノートPC', account: '工具器具備品', acquiredOn: '2026-01-05',
    acquisitionCost: 240000, usefulLife: 4, method: 'straightLine',
    businessUseRatio: 70, disposedOn: null, memo: '',
  },
];

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

  const posted: Array<Record<string, unknown>> = [];
  await page.exposeFunction('__postedOps', () => posted);

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      posted.push(req.postDataJSON() as Record<string, unknown>);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          fiscalYear: 2026,
          seasonKey: '2026SS',
          businessType: 'soleProprietor',
          plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
          expenses: [],
          incomes: [],
          products: [],
          partners: [],
          templates: [],
          fixedAssets: FIXED_ASSETS,
        },
      }),
    });
  });
}

async function openFixedAssets(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '帳簿', exact: true }).click();
  await page.getByRole('tab', { name: '固定資産', exact: true }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-034 fixed assets & depreciation (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('固定資産サブビューと候補レビューがある', async ({ page }) => {
      // FREQ-244-AC-01
      await openFixedAssets(page);

      await expect(
        page.getByRole('heading', { name: /固定資産登録/ }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: '固定資産の候補' })).toBeVisible();
      await expect(page.getByText('未確認の候補はありません。')).toBeVisible();
      await expect(page.getByRole('tab', { name: '直接登録' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '固定資産にする', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: '固定資産にしない', exact: true })).toBeDisabled();
    });

    test('定額法の当期償却費が手計算と一致する', async ({ page }) => {
      // FREQ-244-AC-02: 600,000 × 0.167 = 100,200（1月取得なので12/12）
      await openFixedAssets(page);

      const plan = page.getByRole('region', { name: '減価償却予定表' });
      const sewingRow = plan.getByRole('row').filter({ hasText: '工業用ミシン' });
      await expect(sewingRow).toContainText('¥100,200');
      await expect(sewingRow).toContainText('12/12');
      // 期末簿価 600,000 − 100,200 = 499,800
      await expect(sewingRow).toContainText('¥499,800');
    });

    test('一括償却資産は月割せず3年均等になる', async ({ page }) => {
      // FREQ-244-AC-03: 180,000 ÷ 3 = 60,000（5月取得でも月割しない）
      await openFixedAssets(page);

      const plan = page.getByRole('region', { name: '減価償却予定表' });
      const tabletRow = plan.getByRole('row').filter({ hasText: 'タブレット' });
      await expect(tabletRow).toContainText('一括償却（3年均等）');
      await expect(tabletRow).toContainText('¥60,000');
      // 月割しないので使用月数は表示しない
      await expect(tabletRow).toContainText('—');
    });

    test('指標カードとCSV、事業按分が表示される', async ({ page }) => {
      // FREQ-244-AC-04
      await openFixedAssets(page);

      await expect(page.getByText(/^当期償却（\d{4}年度）$/)).toBeVisible();
      await expect(page.getByText('必要経費算入額', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('未償却残高', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: '台帳CSV' })).toBeVisible();

      // 自宅兼用PC: 240,000 × 0.25 = 60,000 → 事業70% = 42,000
      const plan = page.getByRole('region', { name: '減価償却予定表' });
      const pcRow = plan.getByRole('row').filter({ hasText: '自宅兼用ノートPC' });
      await expect(pcRow).toContainText('70%');
      await expect(pcRow).toContainText('¥60,000');
      await expect(pcRow).toContainText('¥42,000');
    });

    test('取引候補がない場合は直接登録できない', async ({ page }) => {
      await openFixedAssets(page);
      const simulation = page.getByRole('region', { name: '固定資産登録' });
      await expect(simulation.getByText('未確認の候補はありません。')).toBeVisible();
      await expect(simulation.getByRole('tab', { name: '直接登録' })).toHaveCount(0);
      await expect(simulation.getByRole('button', { name: '固定資産として登録' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-244-AC-05
      await openFixedAssets(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
