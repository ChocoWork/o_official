import { test, expect, Page } from '@playwright/test';

// FREQ-241: 会計期間を暦年（1/1〜12/31）へ統一。シーズン軸は商品原価タブのみ。
// 取引は暦年に属し、シーズンはコレクション別分析用の任意タグ。
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

type FinanceEntry = {
  id: number;
  entryType: string;
  date: string;
  category: string;
  item: string;
  partner: string;
  amount: number;
  paymentMethod: string;
  memo: string;
  seasonTag: string | null;
};

/** 年度別の取引ストア。年度フィルタが効いていることを検証するため年で分けて持つ。 */
function financeStore() {
  const byYear = new Map<number, FinanceEntry[]>([
    [
      2026,
      [
        {
          id: 1, entryType: 'expense', date: '2026-03-10', category: '広告宣伝費',
          item: '広告出稿', partner: 'A社', amount: 11000, paymentMethod: '現金',
          memo: '2026年度の取引', seasonTag: '2026SS',
        },
      ],
    ],
  ]);
  return byYear;
}

/** cost-profit API のリクエストURL履歴 */
const requestedUrls: string[] = [];

async function mockAdminApis(page: Page): Promise<void> {
  requestedUrls.length = 0;

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

  const byYear = financeStore();
  let nextId = 100;

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();

    if (req.method() === 'POST') {
      const body = req.postDataJSON() as {
        operation: string;
        fiscalYear?: number;
        expense?: Omit<FinanceEntry, 'id'>;
      };
      if (body.operation === 'expense.create' && body.expense && body.fiscalYear) {
        const list = byYear.get(body.fiscalYear) ?? [];
        list.unshift({ id: (nextId += 1), ...body.expense });
        byYear.set(body.fiscalYear, list);
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }

    const url = new URL(req.url());
    requestedUrls.push(`${url.pathname}${url.search}`);
    const year = Number(url.searchParams.get('year'));
    const entries = byYear.get(year) ?? [];

    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          fiscalYear: year,
          seasonKey: url.searchParams.get('season'),
          businessType: 'soleProprietor',
          plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
          expenses: entries.filter((entry) => entry.entryType === 'expense'),
          incomes: entries.filter((entry) => entry.entryType === 'income'),
          products: [],
          partners: [],
          templates: [],
        },
      }),
    });
  });
}

async function openAccounting(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await expect(page.getByRole('tab', { name: '取引管理', exact: true })).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-031 accounting fiscal year axis (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('最上部が暦年ボタンで、シーズンボタンは表示されない', async ({ page }) => {
      // FREQ-241-AC-01
      await openAccounting(page);

      await expect(page.getByRole('button', { name: '2026年', exact: true })).toBeVisible();
      await expect(page.getByText('会計期間 2026/01/01〜2026/12/31')).toBeVisible();
      // 会計期間の切替軸にシーズンは出さない。
      await expect(page.getByRole('button', { name: '2026 S/S', exact: true })).toHaveCount(0);
    });

    test('年度ボタンで year クエリが切り替わり、当該年度の取引だけが出る', async ({ page }) => {
      // FREQ-241-AC-02
      await openAccounting(page);
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();

      // 2026年度には初期データが1件ある。
      await expect(page.getByText('支出一覧（1件）')).toBeVisible();
      await expect(page.getByText('2026年度の取引')).toBeVisible();
      expect(requestedUrls.some((url) => url.includes('year=2026'))).toBe(true);
    });

    test('シーズンボタンは商品原価タブにのみ表示される', async ({ page }) => {
      // FREQ-241-AC-03
      await openAccounting(page);

      // 会計期間の各タブにはシーズン切替ボタンを置かない。
      for (const label of ['財務概要', '取引管理', '帳簿', '税務レポート']) {
        await page.getByRole('tab', { name: label, exact: true }).click();
        await expect(page.getByRole('button', { name: '2026 S/S', exact: true })).toHaveCount(0);
      }

      await page.getByRole('tab', { name: '商品原価', exact: true }).click();
      await expect(page.getByText('シーズン', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '2026 S/S', exact: true })).toBeVisible();
    });

    test('取引フォームにシーズンタグ（任意）があり、一覧にシーズン列が出る', async ({ page }) => {
      // FREQ-241-AC-04
      await openAccounting(page);
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();

      const seasonTag = page.getByRole('button', { name: 'シーズンタグ' });
      await expect(seasonTag).toBeVisible();
      await seasonTag.click();
      await expect(page.getByRole('option', { name: '（なし）', exact: true })).toBeVisible();
      await page.getByRole('option', { name: '（なし）', exact: true }).click();

      await expect(page.getByRole('columnheader', { name: 'シーズン' }).first()).toBeVisible();
    });

    test('選択中の年度外の日付は保存せずエラーを出す', async ({ page }) => {
      // FREQ-241-AC-05
      await openAccounting(page);
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();

      await page.getByRole('button', { name: '支出概要' }).click();
      await page.getByRole('option', { name: '展示会・イベント' }).click();
      await page.getByRole('button', { name: '勘定科目' }).click();
      await page.getByRole('option', { name: '経費 / 広告宣伝費', exact: true }).click();
      await page.getByPlaceholder('0').fill('45000');
      // 選択中の年度（2026）とは別の年の日付を入れる。
      await page.getByLabel('取引日').fill('2030-05-01');
      await page.getByRole('button', { name: '保存', exact: true }).click();

      await expect(
        page.getByText('日付は選択中の会計期間（2026/01/01〜2026/12/31）の範囲で入力してください。'),
      ).toBeVisible();
      // 行は増えない（初期の1件のまま）。
      await expect(page.getByText('支出一覧（1件）')).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-241-AC-06
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
