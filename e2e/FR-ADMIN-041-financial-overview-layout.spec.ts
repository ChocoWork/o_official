import { test, expect, Page } from '@playwright/test';

// FREQ-253: ACCOUNTING > 財務概要の情報構造。
// 上から サブタブ行 → 資金推移 → キャッシュブリッジ → 財務3表 → 利益構造 → 構成比。
// CSV 出力は財務3表の各パネル見出しへ、同期状態は丸＋短いラベル、再読み込みは「更新」。
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

// 構成比・グラフが描けるだけの実データを積む（比率は必ずこの取引から導かれる）。
const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-03-10', category: '仕入高', item: '生地仕入',
    partner: '生地仕入先C', amount: 400000, paymentMethod: '現金', memo: '', seasonTag: null, receipts: [],
  },
  {
    id: 2, entryType: 'expense', date: '2026-04-20', category: '広告宣伝費', item: 'Instagram広告',
    partner: 'A社', amount: 120000, paymentMethod: '現金', memo: '', seasonTag: null, receipts: [],
  },
];

const INCOMES = [
  {
    id: 11, entryType: 'income', date: '2026-02-15', category: '売上高', item: '商品売上',
    partner: '得意先A', amount: 1000000, paymentMethod: '現金', memo: '', seasonTag: null, receipts: [],
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
          expenses: EXPENSES,
          incomes: INCOMES,
          products: [],
          partners: ['A社', '得意先A', '生地仕入先C'],
          templates: [],
          fixedAssets: [],
          closing: {
            closingInventoryGoods: 0, closingInventoryMaterials: 0,
            allowanceForDoubtful: 0, closingBalances: {}, closedAt: null,
          },
          previousClosingBalances: null,
          revisions: [],
          cumulativeEntries: [],
        },
      }),
    });
  });
}

async function openAccounting(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await expect(page.getByText('同期済み')).toBeVisible();
}

/**
 * 見出し（h3/h4）の縦位置。並び順の検証に使う。
 * 「財務3表」の見出しは横に「自動連動」バッジを含むので部分一致で拾う。
 */
async function headingTop(page: Page, name: string): Promise<number> {
  const box = await page.getByRole('heading', { name }).first().boundingBox();
  expect(box, `見出し「${name}」が見つからない`).not.toBeNull();
  return box!.y;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-041 financial overview layout (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('財務概要のセクションが指定の順番で並ぶ', async ({ page }) => {
      // FREQ-253-AC-01
      await openAccounting(page);

      const tabBox = await page.getByRole('tab', { name: '財務概要' }).boundingBox();
      expect(tabBox).not.toBeNull();

      const order = [
        await headingTop(page, '資金推移'),
        await headingTop(page, 'キャッシュブリッジ'),
        await headingTop(page, '財務3表'),
        await headingTop(page, '利益構造'),
        await headingTop(page, '売上高構成'),
      ];

      // サブタブ行より下に全セクションがある
      expect(order[0]).toBeGreaterThan(tabBox!.y);
      // 上から順に並ぶ
      for (let i = 1; i < order.length; i += 1) {
        expect(order[i]).toBeGreaterThan(order[i - 1]);
      }
    });

    test('CSV出力が財務3表の各パネル内に1つずつある', async ({ page }) => {
      // FREQ-253-AC-02
      await openAccounting(page);

      for (const [panel, label] of [
        ['損益計算書（P/L）', '損益計算書CSV'],
        ['貸借対照表（B/S）', '貸借対照表CSV'],
        ['キャッシュ・フロー計算書（C/F）', 'キャッシュフローCSV'],
      ]) {
        const button = page.getByRole('button', { name: label });
        // ページ全体で1つだけ（下部の重複ボタンを廃止したこと）
        await expect(button).toHaveCount(1);
        await expect(
          page.getByRole('region', { name: panel }).getByRole('button', { name: label }),
        ).toBeVisible();
      }
    });

    test('損益計算書に構成比が売上高100%基準で表示される', async ({ page }) => {
      // FREQ-253-AC-03
      await openAccounting(page);

      const pl = page.getByRole('region', { name: '損益計算書（P/L）' });
      await expect(pl.getByText('構成比', { exact: true })).toBeVisible();
      await expect(pl.getByText('売上高', { exact: true })).toBeVisible();
      await expect(pl.getByText('100.0%', { exact: true }).first()).toBeVisible();
      // 売上原価はマイナスの金額と構成比で示す
      await expect(pl.getByText('-¥400,000', { exact: true })).toBeVisible();
      await expect(pl.getByText('-40.0%', { exact: true })).toBeVisible();
    });

    test('貸借対照表に財政状態のバランスと貸借差額が出る', async ({ page }) => {
      // FREQ-253-AC-04
      await openAccounting(page);

      const bs = page.getByRole('region', { name: '貸借対照表（B/S）' });
      await expect(bs.getByText('財政状態のバランス')).toBeVisible();
      await expect(bs.getByText('負債＋純資産')).toBeVisible();
      await expect(bs.getByText('貸借差額 ¥0')).toBeVisible();
    });

    test('キャッシュ・フロー計算書に現金増減額と検算が出る', async ({ page }) => {
      // FREQ-253-AC-05
      await openAccounting(page);

      const cf = page.getByRole('region', { name: 'キャッシュ・フロー計算書（C/F）' });
      await expect(cf.getByText('現金増減額')).toBeVisible();
      await expect(cf.getByText('期首残高')).toBeVisible();
      await expect(cf.getByText('増減額', { exact: true })).toBeVisible();
      await expect(cf.getByText('期末残高')).toBeVisible();
      await expect(cf.getByText('検算一致')).toBeVisible();
    });

    test('タブ行の右端に年度・同期状態・更新が並ぶ', async ({ page }) => {
      // FREQ-253-AC-06
      await openAccounting(page);

      const tabBox = await page.getByRole('tab', { name: '財務概要' }).boundingBox();
      const year = page.getByRole('button', { name: '会計年' });
      const update = page.getByRole('button', { name: '更新' });
      await expect(year).toBeVisible();
      await expect(page.getByText('2026年', { exact: true })).toBeVisible();
      await expect(update).toBeVisible();
      await expect(page.getByText('同期済み')).toBeVisible();

      const yearBox = await year.boundingBox();
      const updateBox = await update.boundingBox();
      expect(yearBox).not.toBeNull();
      expect(updateBox).not.toBeNull();
      expect(yearBox!.x).toBeGreaterThan(tabBox!.x);
      expect(updateBox!.x).toBeGreaterThan(yearBox!.x);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-253-AC-07
      await openAccounting(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
