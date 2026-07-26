import { test, expect, Page } from '@playwright/test';

// FREQ-246: 決算処理（棚卸・引当金・減価償却・元入金振替・翌年度繰越）。
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

const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-02-01', category: '仕入高', item: '生地・材料仕入',
    partner: 'B社', amount: 800000, paymentMethod: '買掛金', memo: '', seasonTag: '2026SS',
  },
  {
    id: 2, entryType: 'expense', date: '2026-03-01', category: '地代家賃', item: '家賃等',
    partner: '', amount: 120000, paymentMethod: '銀行', memo: '', seasonTag: null,
  },
];

const INCOMES = [
  {
    id: 3, entryType: 'income', date: '2026-06-20', category: '売上高', item: 'オンライン販売',
    partner: '', amount: 1500000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
  },
];

const FIXED_ASSETS = [
  {
    id: 1, name: '工業用ミシン', account: '工具器具備品', acquiredOn: '2026-01-10',
    acquisitionCost: 600000, usefulLife: 6, method: 'straightLine',
    businessUseRatio: 100, disposedOn: null, memo: '',
  },
];

type ClosingState = {
  closingInventoryGoods: number;
  closingInventoryMaterials: number;
  allowanceForDoubtful: number;
  closingBalances: Record<string, number>;
  closedAt: string | null;
};

async function mockAdminApis(page: Page, options: { closed?: boolean } = {}): Promise<void> {
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

  const closing: ClosingState = {
    closingInventoryGoods: 200000,
    closingInventoryMaterials: 0,
    allowanceForDoubtful: 0,
    closingBalances: {},
    closedAt: options.closed ? '2027-02-15T00:00:00.000Z' : null,
  };
  const posted: Array<Record<string, unknown>> = [];
  await page.exposeFunction('__postedOps', () => posted);

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as {
        operation: string;
        adjustment?: ClosingState;
        closingBalances?: Record<string, number>;
      };
      posted.push(body);
      if (body.operation === 'closing.update' && body.adjustment) {
        Object.assign(closing, body.adjustment);
      }
      if (body.operation === 'closing.finalize' && body.adjustment) {
        Object.assign(closing, body.adjustment);
        closing.closingBalances = body.closingBalances ?? {};
        closing.closedAt = new Date().toISOString();
      }
      if (body.operation === 'closing.reopen') {
        closing.closingBalances = {};
        closing.closedAt = null;
      }
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
          expenses: EXPENSES,
          incomes: INCOMES,
          products: [],
          partners: ['B社'],
          templates: [],
          fixedAssets: FIXED_ASSETS,
          closing,
          previousClosingBalances: null,
        },
      }),
    });
  });
}

async function openClosing(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '帳簿', exact: true }).click();
  await page.getByRole('tab', { name: '決算', exact: true }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-036 year end closing (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('決算サブビューに決算整理の入力と締めボタンがある', async ({ page }) => {
      // FREQ-246-AC-01
      await mockAdminApis(page);
      await openClosing(page);

      await expect(page.getByLabel('期末商品棚卸高')).toBeVisible();
      await expect(page.getByLabel('期末材料棚卸高')).toBeVisible();
      await expect(page.getByLabel('貸倒引当金繰入額')).toBeVisible();
      await expect(page.getByRole('button', { name: '決算整理を保存' })).toBeVisible();
      await expect(page.getByRole('button', { name: '2026年を締める' })).toBeVisible();
      // 減価償却費は台帳から自動計算される
      await expect(page.getByText('減価償却費（自動）')).toBeVisible();
    });

    test('棚卸と減価償却の決算整理仕訳が生成される', async ({ page }) => {
      // FREQ-246-AC-02
      await mockAdminApis(page);
      await openClosing(page);

      // 期末商品棚卸高200,000 → 借方 商品 / 貸方 期末商品棚卸高
      const inventoryRow = page.getByRole('row').filter({ hasText: '期末商品棚卸高の計上' });
      await expect(inventoryRow).toContainText('商品');
      await expect(inventoryRow).toContainText('¥200,000');

      // 減価償却 600,000 × 0.167 = 100,200
      const depreciationRow = page.getByRole('row').filter({ hasText: '減価償却費 工業用ミシン' });
      await expect(depreciationRow).toContainText('¥100,200');
      await expect(depreciationRow).toContainText('工具器具備品');
    });

    test('翌年度の繰越期首残高で貸借が一致する', async ({ page }) => {
      // FREQ-246-AC-04
      await mockAdminApis(page);
      await openClosing(page);

      await expect(page.getByRole('heading', { name: /翌年度（2027年）へ繰り越す期首残高/ })).toBeVisible();
      await expect(page.getByText('翌年期首BS = 当年期末BS')).toBeVisible();

      // 元入金へ振り替わっている（損益科目は繰り越されない）
      const capitalRow = page.getByRole('row').filter({ hasText: '元入金' });
      await expect(capitalRow).toBeVisible();
      const salesRow = page.getByRole('row').filter({ hasText: '売上高' });
      await expect(salesRow).toHaveCount(0);
    });

    test('締めると closing.finalize がスナップショット付きでPOSTされる', async ({ page }) => {
      await mockAdminApis(page);
      await openClosing(page);

      await page.getByRole('button', { name: '2026年を締める' }).click();
      await expect(page.getByText(/2026年を締めました/)).toBeVisible();

      const posted = await page.evaluate(() => (window as unknown as {
        __postedOps: () => Promise<Array<Record<string, unknown>>>;
      }).__postedOps());
      const finalize = posted.find((body) => body.operation === 'closing.finalize') as
        | { fiscalYear: number; closingBalances: Record<string, number> }
        | undefined;

      expect(finalize).toBeTruthy();
      expect(finalize?.fiscalYear).toBe(2026);
      // 元入金(2910)が含まれ、損益科目(4010 売上高)は含まれない
      expect(finalize?.closingBalances['2910']).toBeDefined();
      expect(finalize?.closingBalances['4010']).toBeUndefined();
      // 期末商品棚卸(1310)が繰り越される
      expect(finalize?.closingBalances['1310']).toBe(200000);
    });

    test('締めた年度は入力不可になり解除ボタンが出る', async ({ page }) => {
      // FREQ-246-AC-05
      await mockAdminApis(page, { closed: true });
      await openClosing(page);

      await expect(page.getByLabel('期末商品棚卸高')).toBeDisabled();
      await expect(page.getByText(/決算を確定済み/)).toBeVisible();
      await expect(page.getByRole('button', { name: '決算を解除して修正する' })).toBeVisible();
      await expect(page.getByRole('button', { name: '2026年を締める' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-246-AC-07
      await mockAdminApis(page);
      await openClosing(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
