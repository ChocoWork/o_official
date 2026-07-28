import { test, expect, Page } from '@playwright/test';

// FREQ-250: 財務概要の「開業以来の累計」パネル。
// 損益は期間の表なので、年度で切ると積み上げが見えない点を補う。
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

// 当年度（2026）の取引
const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-06-01', category: '仕入高', item: '生地・材料仕入',
    partner: 'B社', amount: 200000, paymentMethod: '買掛金', memo: '', seasonTag: null, receipts: [],
  },
];
const INCOMES = [
  {
    id: 2, entryType: 'income', date: '2026-05-01', category: '売上高', item: 'オンライン販売',
    partner: '', amount: 500000, paymentMethod: '銀行', memo: '', seasonTag: null, receipts: [],
  },
];

// 累計集計用：開業年（2025）を含む全取引
// 2025: 売上300,000 / 仕入100,000　2026: 売上500,000 / 仕入200,000
// → 累計売上800,000・累計費用300,000＋減価償却100,200＝400,200・累計利益399,800
const CUMULATIVE_ENTRIES = [
  { entryType: 'income', date: '2025-08-01', category: '売上高', amount: 300000 },
  { entryType: 'expense', date: '2025-09-01', category: '仕入高', amount: 100000 },
  { entryType: 'income', date: '2026-05-01', category: '売上高', amount: 500000 },
  { entryType: 'expense', date: '2026-06-01', category: '仕入高', amount: 200000 },
  // 固定資産の取得は費用ではないので累計費用に含めない
  { entryType: 'expense', date: '2026-01-10', category: '工具器具備品', amount: 600000 },
];

const FIXED_ASSETS = [
  {
    id: 1, name: '工業用ミシン', account: '工具器具備品', acquiredOn: '2026-01-10',
    acquisitionCost: 600000, usefulLife: 6, method: 'straightLine',
    businessUseRatio: 100, disposedOn: null, memo: '',
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

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    const year = Number(new URL(req.url()).searchParams.get('year'));
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          fiscalYear: year,
          seasonKey: '2026SS',
          businessType: 'soleProprietor',
          plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
          expenses: year === 2026 ? EXPENSES : [],
          incomes: year === 2026 ? INCOMES : [],
          products: [],
          partners: ['B社'],
          templates: [],
          fixedAssets: FIXED_ASSETS,
          closing: {
            closingInventoryGoods: 0, closingInventoryMaterials: 0,
            allowanceForDoubtful: 0, closingBalances: {}, closedAt: null,
          },
          previousClosingBalances: null,
          revisions: [],
          // サーバ側は選択年度の年末までで絞る。
          cumulativeEntries: CUMULATIVE_ENTRIES.filter(
            (entry) => entry.date <= `${year}-12-31`,
          ),
        },
      }),
    });
  });
}

async function openSummary(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  // 累計は独立パネルをやめ、利益構造のトグルへ移した（FREQ-255）。
  await expect(page.getByRole('heading', { name: '利益構造' })).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-039 cumulative summary (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('利益構造は年度と累計を切り替えられる', async ({ page }) => {
      // FREQ-250-AC-03（FREQ-255 で独立パネルから利益構造のトグルへ移設）
      await openSummary(page);

      const panel = page.getByRole('region', { name: '利益構造' });
      // 既定は年度
      await expect(panel.getByRole('button', { name: '年度' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(panel.getByText('売上高', { exact: true })).toBeVisible();

      await panel.getByRole('button', { name: '累計' }).click();
      for (const label of [
        '累計売上高',
        '累計売上原価',
        '累計販売費及び一般管理費',
        '累計利益',
        '累計設備投資',
        '元入金（期末）',
      ]) {
        await expect(panel.getByText(label, { exact: true })).toBeVisible();
      }
    });

    test('前年度を含む累計値が計算される', async ({ page }) => {
      // FREQ-250-AC-01 / AC-02
      await openSummary(page);
      const panel = page.getByRole('region', { name: '利益構造' });
      await panel.getByRole('button', { name: '累計' }).click();

      // 累計売上高 = 300,000 + 500,000
      await expect(panel).toContainText('¥800,000');
      // 累計売上原価 = 仕入300,000
      await expect(panel).toContainText('¥300,000');
      // 累計販管費 = 減価償却100,200（固定資産の取得600,000は費用でない）
      await expect(panel).toContainText('¥100,200');
      // 累計利益 = 800,000 − 400,200
      await expect(panel).toContainText('¥399,800');
      // 累計設備投資 = 600,000
      await expect(panel).toContainText('¥600,000');
    });

    test('集計期間と件数が利益構造に出る', async ({ page }) => {
      // FREQ-250-AC-04
      await openSummary(page);
      const panel = page.getByRole('region', { name: '利益構造' });
      await panel.getByRole('button', { name: '累計' }).click();

      // 開業年2025〜2026年で2期、取引5件
      await expect(panel).toContainText('2025年〜2026年（2期）・5件の積み上げ');
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-250-AC-05
      await openSummary(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
