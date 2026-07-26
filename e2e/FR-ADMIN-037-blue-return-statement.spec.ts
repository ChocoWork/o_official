import { test, expect, Page } from '@playwright/test';

// FREQ-247: 税務レポートを青色申告決算書（一般用）1〜4ページの様式に対応させる。
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

// 3月売上200,000 ＋ 3月売上値引30,000 → 3月の売上は170,000
// 給料賃金・地代家賃・利子割引料・支払報酬で各内訳欄を埋める
const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-03-20', category: '売上値引・返品', item: '返品対応',
    partner: '', amount: 30000, paymentMethod: '現金', memo: '', seasonTag: null,
  },
  {
    id: 2, entryType: 'expense', date: '2026-04-25', category: '給料賃金', item: '給料賃金',
    partner: '山田太郎', amount: 250000, paymentMethod: '銀行', memo: '', seasonTag: null,
  },
  {
    id: 3, entryType: 'expense', date: '2026-05-01', category: '地代家賃', item: '家賃等',
    partner: '大家不動産', amount: 96000, paymentMethod: '銀行', memo: '', seasonTag: null,
  },
  {
    id: 4, entryType: 'expense', date: '2026-06-01', category: '利子割引料', item: '利息の支払い',
    partner: '信用金庫', amount: 12000, paymentMethod: '銀行', memo: '', seasonTag: null,
  },
  {
    id: 5, entryType: 'expense', date: '2026-07-01', category: '支払報酬', item: '支払手数料',
    partner: '税理士事務所', amount: 60000, paymentMethod: '銀行', memo: '', seasonTag: null,
  },
  {
    id: 6, entryType: 'expense', date: '2026-08-01', category: '仕入高', item: '生地・材料仕入',
    partner: 'B社', amount: 400000, paymentMethod: '買掛金', memo: '', seasonTag: null,
  },
];

const INCOMES = [
  {
    id: 7, entryType: 'income', date: '2026-03-01', category: '売上高', item: 'オンライン販売',
    partner: '', amount: 200000, paymentMethod: '銀行', memo: '', seasonTag: null,
  },
  {
    id: 8, entryType: 'income', date: '2026-09-15', category: '売上高', item: '卸売',
    partner: '', amount: 3000000, paymentMethod: '銀行', memo: '', seasonTag: null,
  },
  {
    id: 9, entryType: 'income', date: '2026-10-01', category: '雑収入', item: 'その他',
    partner: '', amount: 8000, paymentMethod: '現金', memo: '', seasonTag: null,
  },
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
    if (route.request().method() === 'POST') {
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
          partners: ['山田太郎', '大家不動産', '信用金庫', '税理士事務所', 'B社'],
          templates: [],
          fixedAssets: FIXED_ASSETS,
          closing: {
            closingInventoryGoods: 0,
            closingInventoryMaterials: 0,
            allowanceForDoubtful: 0,
            closingBalances: {},
            closedAt: null,
          },
          previousClosingBalances: null,
        },
      }),
    });
  });
}

async function openTax(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '税務レポート', exact: true }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-037 blue return statement (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('1〜4ページのサブページが並び、旧パネルが消えている', async ({ page }) => {
      // FREQ-247-AC-01
      await openTax(page);

      for (const label of ['1P 損益計算書', '2P 月別・内訳', '3P 減価償却', '4P 貸借対照表']) {
        await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
      }
      await expect(page.getByText('作成可能な帳簿・申告資料')).toHaveCount(0);
      await expect(page.getByText('確定申告準備チェックリスト')).toHaveCount(0);
    });

    test('1ページに損益計算書と経費内訳が出る', async ({ page }) => {
      // FREQ-247-AC-02
      await openTax(page);

      await expect(page.getByRole('heading', { name: '1ページ 損益計算書' })).toBeVisible();
      await expect(page.getByText('青色申告特別控除前の所得金額').first()).toBeVisible();
      await expect(page.getByText('所得金額', { exact: true })).toBeVisible();
      await expect(page.getByText('経費の内訳')).toBeVisible();
      // 経費内訳に給料賃金・地代家賃が並ぶ
      await expect(page.getByRole('row').filter({ hasText: '給料賃金' }).first()).toBeVisible();
    });

    test('2ページの月別集計で売上値引が該当月から控除される', async ({ page }) => {
      // FREQ-247-AC-03
      await openTax(page);
      await page.getByRole('tab', { name: '2P 月別・内訳', exact: true }).click();

      // 3月：売上200,000 − 値引30,000 = 170,000
      const marchRow = page.getByRole('row').filter({ hasText: '3月' }).first();
      await expect(marchRow).toContainText('¥170,000');

      // 雑収入は月別と分離
      const miscRow = page.getByRole('row').filter({ hasText: '雑収入' });
      await expect(miscRow).toContainText('¥8,000');

      // 8月に仕入400,000
      const augustRow = page.getByRole('row').filter({ hasText: '8月' }).first();
      await expect(augustRow).toContainText('¥400,000');
    });

    test('内訳パネルが2ページ・3ページに出る', async ({ page }) => {
      // FREQ-247-AC-04
      await openTax(page);

      await page.getByRole('tab', { name: '2P 月別・内訳', exact: true }).click();
      await expect(page.getByRole('heading', { name: '給料賃金の内訳' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '専従者給与の内訳' })).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: '山田太郎' })).toContainText('¥250,000');

      await page.getByRole('tab', { name: '3P 減価償却', exact: true }).click();
      await expect(page.getByRole('heading', { name: '利子割引料の内訳' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '地代家賃の内訳' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '税理士・弁護士等の報酬・料金の内訳' })).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: '大家不動産' })).toContainText('¥96,000');
    });

    test('e-Taxの有無で控除限度額が65万/55万に切り替わる', async ({ page }) => {
      // FREQ-247-AC-05
      await openTax(page);
      await page.getByRole('tab', { name: '2P 月別・内訳', exact: true }).click();

      const etax = page.getByRole('checkbox');
      await expect(etax).toBeChecked();
      const limitRow = page.locator('div').filter({ hasText: /^控除限度額/ }).first();
      await expect(limitRow).toContainText('¥650,000');

      await etax.uncheck();
      await expect(limitRow).toContainText('¥550,000');
    });

    test('3ページに減価償却費の計算欄が決算書の構成で出る', async ({ page }) => {
      // FREQ-247-AC-06
      await openTax(page);
      await page.getByRole('tab', { name: '3P 減価償却', exact: true }).click();

      await expect(page.getByRole('columnheader', { name: '償却率' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: '未償却残高' })).toBeVisible();
      const assetRow = page.getByRole('row').filter({ hasText: '工業用ミシン' });
      await expect(assetRow).toContainText('0.167');
      await expect(assetRow).toContainText('¥100,200');
      await expect(assetRow).toContainText('¥499,800');
    });

    test('4ページに貸借対照表が期首・期末2列で出て一致する', async ({ page }) => {
      // FREQ-247-AC-07
      await openTax(page);
      await page.getByRole('tab', { name: '4P 貸借対照表', exact: true }).click();

      await expect(page.getByText('資産', { exact: true })).toBeVisible();
      await expect(page.getByText('負債・資本', { exact: true })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: '期首' }).first()).toBeVisible();
      await expect(page.getByRole('columnheader', { name: '期末' }).first()).toBeVisible();
      await expect(
        page.getByRole('row').filter({ hasText: '青色申告特別控除前の所得金額' }),
      ).toBeVisible();

      // 資産合計と負債・資本合計が一致する
      const totals = await page.getByRole('row')
        .filter({ hasText: '合計' })
        .allInnerTexts();
      expect(totals).toHaveLength(2);
      const amounts = totals.map((text) => text.match(/¥-?[\d,]+/g)?.at(-1));
      expect(amounts[0]).toBe(amounts[1]);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-247-AC-08
      await openTax(page);
      await page.getByRole('tab', { name: '4P 貸借対照表', exact: true }).click();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
