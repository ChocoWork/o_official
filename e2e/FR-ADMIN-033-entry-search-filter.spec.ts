import { test, expect, Page } from '@playwright/test';

// FREQ-243: 取引管理の検索・絞り込み。電子帳簿保存法の検索機能要件を満たす。
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

// 支出3件・収入2件。日付・金額・取引先がすべて異なるので各条件を分離して検証できる。
const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-01-15', category: '広告宣伝費', item: '広告出稿',
    partner: 'A社', amount: 10000, paymentMethod: '現金', memo: '冬キャンペーン', seasonTag: null,
  },
  {
    id: 2, entryType: 'expense', date: '2026-03-31', category: '仕入高', item: '生地・材料仕入',
    partner: 'B社', amount: 90000, paymentMethod: '買掛金', memo: '', seasonTag: '2026SS',
  },
  {
    id: 3, entryType: 'expense', date: '2026-06-01', category: '通信費', item: 'システム・ツール利用料',
    partner: '', amount: 3300, paymentMethod: '銀行', memo: 'SaaS', seasonTag: null,
  },
];

const INCOMES = [
  {
    id: 4, entryType: 'income', date: '2026-06-20', category: '売上高', item: 'オンライン販売',
    partner: '', amount: 120000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
  },
  {
    id: 5, entryType: 'income', date: '2026-12-31', category: '売上高', item: '卸売',
    partner: 'A社', amount: 250000, paymentMethod: '売掛金', memo: '年末締め', seasonTag: '2026AW',
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
          partners: ['A社', 'B社'],
          templates: [],
        },
      }),
    });
  });
}

async function openEntries(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '取引管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '取引管理', exact: true })).toBeVisible();
}

/** FREQ-257 以降、検索条件は「詳細条件」Drawer の中にある。 */
async function openFilterDrawer(page: Page) {
  await page.getByRole('button', { name: '詳細条件' }).click();
  await expect(page.getByLabel('取引年月日（開始）')).toBeVisible();
}

/** 条件を適用して Drawer を閉じ、一覧の件数を読めるようにする。 */
async function applyFilter(page: Page) {
  await page.getByRole('button', { name: '適用して閉じる' }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-033 entry search filter (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('検索パネルに電帳法の必須条件がそろっている', async ({ page }) => {
      // FREQ-243-AC-01
      await openEntries(page);
      await openFilterDrawer(page);

      await expect(page.getByLabel('取引年月日（開始）')).toBeVisible();
      await expect(page.getByLabel('取引年月日（終了）')).toBeVisible();
      await expect(page.getByLabel('取引金額（下限）')).toBeVisible();
      await expect(page.getByLabel('取引金額（上限）')).toBeVisible();
      await expect(page.getByRole('button', { name: '絞り込み：相手先' })).toBeVisible();
      await expect(page.getByRole('button', { name: '絞り込み：科目' })).toBeVisible();
      await expect(page.getByRole('button', { name: '絞り込み：収支区分' })).toBeVisible();
      await expect(page.getByLabel('絞り込み：キーワード')).toBeVisible();

      await expect(page.getByText('条件なし')).toBeVisible();
      await applyFilter(page);
      await expect(page.getByText('1-5 / 5件')).toBeVisible();
    });

    test('金額・日付は片側のみの範囲指定でも絞り込める', async ({ page }) => {
      // FREQ-243-AC-02
      await openEntries(page);
      await openFilterDrawer(page);

      // 下限のみ：120,000以上 → 収入2件（120,000 / 250,000）だけが残る
      await page.getByLabel('取引金額（下限）').fill('120000');
      await applyFilter(page);
      await expect(page.getByText('1-2 / 2件')).toBeVisible();

      await openFilterDrawer(page);
      await page.getByRole('button', { name: '条件をクリア' }).click();
      await applyFilter(page);
      await expect(page.getByText('1-5 / 5件')).toBeVisible();

      // 終了のみ：2026-01-31以前 → 支出1件のみ
      await openFilterDrawer(page);
      await page.getByLabel('取引年月日（終了）').fill('2026-01-31');
      await applyFilter(page);
      await expect(page.getByText('1-1 / 1件')).toBeVisible();
    });

    test('2以上の条件を組み合わせられる', async ({ page }) => {
      // FREQ-243-AC-03
      await openEntries(page);
      await openFilterDrawer(page);

      // 取引先 A社（支出1件・収入1件）× 2026-06-01以降 → 収入1件だけ残る
      await page.getByRole('button', { name: '絞り込み：相手先' }).click();
      await page.getByRole('option', { name: 'A社', exact: true }).click();
      await page.getByLabel('取引年月日（開始）').fill('2026-06-01');

      await expect(page.getByText(/2条件で絞り込み中/)).toBeVisible();
      await applyFilter(page);
      await expect(page.getByText('1-1 / 1件')).toBeVisible();
      await expect(
        page.getByRole('region', { name: '取引一覧' }).getByText('卸売 / A社'),
      ).toBeVisible();
    });

    test('絞り込みは帳簿の集計に影響しない', async ({ page }) => {
      // FREQ-243-AC-04
      await openEntries(page);
      await openFilterDrawer(page);

      await page.getByLabel('取引金額（下限）').fill('200000');
      await applyFilter(page);
      await expect(page.getByText('1-1 / 1件')).toBeVisible();

      // 帳簿は年度の全件（5件）で集計されたままであること。
      await page.getByRole('tab', { name: '帳簿', exact: true }).click();
      await expect(page.getByText('5件')).toBeVisible();

      // 取引管理へ戻って条件をクリアすると全件表示に戻る。
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();
      await openFilterDrawer(page);
      await page.getByRole('button', { name: '条件をクリア' }).click();
      await applyFilter(page);
      await expect(page.getByText('1-5 / 5件')).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-243-AC-05
      await openEntries(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
