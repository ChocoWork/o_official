import { test, expect, Page } from '@playwright/test';

// FREQ-259: 税務レポートを「税務サマリー／青色申告決算書／税務調整／税務カレンダー／申告資料」の
// 5枚に再構成し、従来の 1P〜4P は「青色申告決算書」の中に置く。
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

const RECEIPT = {
  id: 900, storagePath: '2026/6/invoice.pdf', fileName: 'invoice.pdf',
  mimeType: 'application/pdf', fileSize: 1024, createdAt: '2026-06-18T00:00:00.000Z',
};

let nextId = 1;

// 12か月分の売上と仕入を入れて、月別欄・推移グラフ・内訳が空にならないようにする。
const INCOMES = Array.from({ length: 12 }, (_, index) => ({
  id: nextId++, entryType: 'income', date: `2026-${String(index + 1).padStart(2, '0')}-20`,
  category: '売上高', item: 'オンライン販売', partner: '', amount: 3800000 + index * 120000,
  paymentMethod: '銀行', memo: '', seasonTag: null, receipts: [RECEIPT],
}));

const EXPENSES = [
  ...Array.from({ length: 12 }, (_, index) => ({
    id: nextId++, entryType: 'expense', date: `2026-${String(index + 1).padStart(2, '0')}-10`,
    category: '仕入高', item: '生地・材料仕入', partner: 'B社', amount: 2450000 + index * 90000,
    paymentMethod: '買掛金', memo: '', seasonTag: null, receipts: [RECEIPT],
  })),
  ...Array.from({ length: 12 }, (_, index) => ({
    id: nextId++, entryType: 'expense', date: `2026-${String(index + 1).padStart(2, '0')}-25`,
    category: '給料賃金', item: '給与', partner: '山田 太郎', amount: 360000,
    paymentMethod: '銀行', memo: '', seasonTag: null, receipts: [RECEIPT],
  })),
  // 証憑なし＝「証憑不足」の判定材料。
  ...Array.from({ length: 12 }, (_, index) => ({
    id: nextId++, entryType: 'expense', date: `2026-${String(index + 1).padStart(2, '0')}-01`,
    category: '地代家賃', item: '事務所家賃', partner: '山田不動産（株）', amount: 140000,
    paymentMethod: '銀行', memo: '', seasonTag: null,
  })),
  // 税務調整の材料（寄附金＝加算、接待交際費＝要確認）。
  {
    id: nextId++, entryType: 'expense', date: '2026-06-30', category: '寄附金',
    item: '寄附', partner: '○○財団', amount: 120000, paymentMethod: '銀行',
    memo: '', seasonTag: null,
  },
  {
    id: nextId++, entryType: 'expense', date: '2026-05-12', category: '接待交際費',
    item: '会食費', partner: '株式会社○○', amount: 1200000, paymentMethod: '現金',
    memo: '', seasonTag: null, receipts: [RECEIPT],
  },
];

// 車両は事業専用割合80%＝家事按分ありなので、減価償却の「要確認」判定に効く。
const FIXED_ASSETS = [
  {
    id: 1, name: '工業用ミシン', account: '機械装置', acquiredOn: '2023-06-01',
    acquisitionCost: 3600000, usefulLife: 7, method: 'straightLine',
    businessUseRatio: 100, disposedOn: null, memo: '',
  },
  {
    id: 2, name: '車両', account: '車両運搬具', acquiredOn: '2022-07-01',
    acquisitionCost: 4000000, usefulLife: 6, method: 'straightLine',
    businessUseRatio: 80, disposedOn: null, memo: '',
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
          values: {},
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
          plan: {
            salesRevenue: 50000000, openingCash: 32500000, accountsReceivable: 28000000,
            fixedAssets: 18000000, accountsPayable: 12500000, openingCapital: 50000000,
          },
          expenses: EXPENSES,
          incomes: INCOMES,
          products: [],
          partners: ['B社'],
          templates: [],
          fixedAssets: FIXED_ASSETS,
          closing: {
            closingInventoryGoods: 0, closingInventoryMaterials: 0, allowanceForDoubtful: 0,
            closingBalances: {}, closedAt: null,
          },
          previousClosingBalances: null,
          revisions: [],
          cumulativeEntries: [],
        },
      }),
    });
  });
}

async function openTaxReport(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '税務レポート', exact: true }).click();
  await expect(page.getByRole('tab', { name: '税務サマリー', exact: true })).toBeVisible();
}

/** 横方向のページスクロールが出ていないこと。 */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-045 tax report five tabs (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('税務レポートが5タブに分かれ、1P〜4Pは第1階層に出ない', async ({ page }) => {
      // FREQ-259-AC-01
      await openTaxReport(page);

      for (const label of ['税務サマリー', '青色申告決算書', '税務調整', '税務カレンダー', '申告資料']) {
        await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
      }
      // 税務サマリーを開いている状態では 1P〜4P のタブは存在しない。
      await expect(page.getByRole('tab', { name: '1P 損益計算書', exact: true })).toHaveCount(0);
      await expectNoHorizontalScroll(page);
    });

    test('青色申告決算書の中に1P〜4Pが並び、進捗と入力状況を出す', async ({ page }) => {
      // FREQ-259-AC-02
      await openTaxReport(page);
      await page.getByRole('tab', { name: '青色申告決算書', exact: true }).click();

      await expect(page.getByText('申告書全体の進捗')).toBeVisible();
      for (const label of ['1P 損益計算書', '2P 月別・内訳', '3P 減価償却', '4P 貸借対照表']) {
        await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
      }
      await expect(page.getByRole('region', { name: 'ページ完成度' })).toBeVisible();
      await expect(
        page.getByRole('region', { name: '入力元', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('region', { name: '1ページ 損益計算書' })).toBeVisible();

      await page.getByRole('tab', { name: '4P 貸借対照表', exact: true }).click();
      await expect(page.getByRole('region', { name: '4ページ 貸借対照表' })).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    test('税務サマリーに税額・準備率・推移・要対応・期限が並ぶ', async ({ page }) => {
      // FREQ-259-AC-03
      await openTaxReport(page);

      await expect(page.getByText('推定所得税')).toBeVisible();
      await expect(page.getByText('課税所得', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('控除見込')).toBeVisible();
      await expect(page.getByText('申告準備', { exact: true })).toBeVisible();

      await expect(
        page.getByRole('region', { name: '課税売上・必要経費・所得推移' }),
      ).toBeVisible();
      await expect(page.getByRole('region', { name: '申告準備チェック' })).toBeVisible();
      await expect(page.getByRole('region', { name: '税額見込' })).toBeVisible();
      await expect(page.getByRole('region', { name: '要対応一覧' })).toBeVisible();
      await expect(page.getByRole('region', { name: '申告期限・納付予定' })).toBeVisible();

      // 税額は所得控除を含まない概算であることを明記する。
      await expect(page.getByText(/所得控除.*帳簿の外/)).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    test('税務調整に加算・減算と課税所得までの調整が並ぶ', async ({ page }) => {
      // FREQ-259-AC-04
      await openTaxReport(page);
      await page.getByRole('tab', { name: '税務調整', exact: true }).click();

      await expect(page.getByText('会計上の利益').first()).toBeVisible();
      await expect(page.getByText('加算調整').first()).toBeVisible();
      await expect(page.getByText('減算調整').first()).toBeVisible();

      await expect(
        page.getByRole('region', { name: '会計利益から課税所得までの調整ウォーターフォール' }),
      ).toBeVisible();
      await expect(page.getByRole('region', { name: '税務調整明細' })).toBeVisible();
      await expect(page.getByRole('region', { name: '税額見込' })).toBeVisible();

      // 寄附金は必要経費にならないので加算調整の明細として並ぶ
      // （同じ文言がウォーターフォールの軸ラベルにも出るので明細行で確かめる）。
      await expect(
        page
          .getByRole('region', { name: '税務調整明細' })
          .getByRole('cell', { name: '寄附金の必要経費不算入' }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    test('税務カレンダーに期限・スケジュール・納税資金予測が並ぶ', async ({ page }) => {
      // FREQ-259-AC-05
      await openTaxReport(page);
      await page.getByRole('tab', { name: '税務カレンダー', exact: true }).click();

      await expect(page.getByText('今後30日の期限').first()).toBeVisible();
      await expect(page.getByText('未完了タスク')).toBeVisible();
      await expect(page.getByText('証憑不足').first()).toBeVisible();
      await expect(page.getByText('準備完了率')).toBeVisible();

      await expect(page.getByRole('region', { name: '税務スケジュール' })).toBeVisible();
      await expect(page.getByRole('region', { name: '納税資金予測' })).toBeVisible();
      await expect(page.getByRole('region', { name: '申告準備チェックリスト' })).toBeVisible();
      await expect(
        page.getByRole('region', { name: '申告資料・証憑インベントリ' }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    test('申告資料に一覧・詳細・パッケージが並び、検索で絞り込める', async ({ page }) => {
      // FREQ-259-AC-06
      await openTaxReport(page);
      await page.getByRole('tab', { name: '申告資料', exact: true }).click();

      await expect(page.getByText('必要資料')).toBeVisible();
      await expect(page.getByText('準備完了', { exact: true })).toBeVisible();

      const list = page.getByRole('region', { name: '申告資料一覧' });
      await expect(list).toBeVisible();
      await expect(page.getByRole('region', { name: '資料詳細' })).toBeVisible();
      await expect(page.getByRole('region', { name: '申告資料パッケージ' })).toBeVisible();

      await expect(list).toContainText('固定資産台帳');
      await page.getByLabel('資料名を検索').fill('貸借対照表');
      await expect(list).toContainText('貸借対照表');
      await expect(list).not.toContainText('固定資産台帳');
      await expectNoHorizontalScroll(page);
    });
  });
}
