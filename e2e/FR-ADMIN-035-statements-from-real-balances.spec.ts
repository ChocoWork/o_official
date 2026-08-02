import { test, expect, Page } from '@playwright/test';

// FREQ-245: 財務3表と税務レポートを仕訳の実残高から算出する（架空係数の全廃）。
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

// 売上900,000（銀行入金）／売上値引30,000（現金）／仕入200,000（買掛）／固定資産600,000（銀行）
// ＋ ミシン600,000（耐用6年・1月取得）の減価償却100,200
const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-02-01', category: '仕入高', item: '生地・材料仕入',
    partner: 'B社', amount: 200000, paymentMethod: '買掛金', memo: '', seasonTag: '2026SS',
  },
  {
    id: 2, entryType: 'expense', date: '2026-01-10', category: '工具器具備品', item: '設備投資',
    partner: 'C社', amount: 600000, paymentMethod: '銀行', memo: '', seasonTag: null,
  },
  {
    id: 3, entryType: 'expense', date: '2026-07-01', category: '売上値引・返品', item: '返品対応',
    partner: '', amount: 30000, paymentMethod: '現金', memo: '', seasonTag: null,
  },
];

const INCOMES = [
  {
    id: 4, entryType: 'income', date: '2026-06-20', category: '売上高', item: 'オンライン販売',
    partner: '', amount: 900000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
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
          partners: ['B社', 'C社'],
          templates: [],
          fixedAssets: FIXED_ASSETS,
        },
      }),
    });
  });
}

async function openSummary(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await expect(page.getByText('損益計算書（P/L）')).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-035 statements from real balances (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('控除性科目が売上から自動控除される', async ({ page }) => {
      // FREQ-245-AC-01: 900,000 − 30,000 = 870,000
      await openSummary(page);

      await expect(page.getByText('¥870,000').first()).toBeVisible();
      // 当期仕入高200,000がそのまま売上原価になる（棚卸なし）
      const plPanel = page.getByRole('region', { name: '損益計算書（P/L）' });
      await expect(plPanel).toContainText('売上高');
      await expect(plPanel).toContainText('売上原価');
    });

    test('減価償却費が経費に入り、資産が直接減額される', async ({ page }) => {
      // FREQ-245-AC-02
      await openSummary(page);

      // 減価償却費 100,200 が必要経費に含まれる（税務サマリーの注記で確認）
      await page.getByRole('tab', { name: '税務レポート', exact: true }).click();
      await expect(
        page.getByText('減価償却費 ¥100,200を必要経費に含みます'),
      ).toBeVisible();

      // 固定資産台帳の期末簿価 499,800 と元帳残高が一致する
      await page.getByRole('tab', { name: '帳簿', exact: true }).click();
      await page.getByRole('tab', { name: '仕訳・元帳', exact: true }).click();
      await page.getByRole('searchbox', { name: '勘定科目を検索' }).fill('工具器具備品');
      await page.getByRole('button', { name: '勘定科目を検索する' }).click();
      await page
        .getByRole('region', { name: '勘定科目' })
        .getByRole('button', { name: /1535\s*工具器具備品/ })
        .click();
      await expect(
        page.getByRole('region', { name: '残高推移' }).getByText('¥499,800', { exact: true }),
      ).toBeVisible();
    });

    test('貸借差額が0になる（資産 = 負債 + 純資産 + 当期純利益）', async ({ page }) => {
      // FREQ-245-AC-03
      await openSummary(page);

      const bsPanel = page.getByRole('region', { name: '貸借対照表（B/S）' });
      await expect(bsPanel).toContainText('貸借差額');
      await expect(bsPanel).toContainText('¥0');

      // 決算書の4ページ側でも貸借の一致を示す。
      await page.getByRole('tab', { name: '税務レポート', exact: true }).click();
      await page.getByRole('tab', { name: '青色申告決算書', exact: true }).click();
      await page.getByRole('tab', { name: '4P 貸借対照表', exact: true }).click();
      await expect(page.getByText('貸借一致', { exact: true })).toBeVisible();
    });

    test('C/Fが直接法で期末残高と一致する', async ({ page }) => {
      // FREQ-245-AC-04
      // 銀行: +900,000 − 600,000 = 300,000／現金: −30,000 → 期末 270,000
      await openSummary(page);

      const cfPanel = page.getByRole('region', {
        name: 'キャッシュ・フロー計算書（C/F）',
      });
      await expect(cfPanel).toContainText('期末残高');
      await expect(cfPanel).toContainText('¥270,000');
      // 固定資産取得は投資活動
      await expect(cfPanel).toContainText('-¥600,000');
    });

    test('固定税率の税額概算が表示されない', async ({ page }) => {
      // FREQ-245-AC-05
      await openSummary(page);
      await page.getByRole('tab', { name: '税務レポート', exact: true }).click();

      await expect(page.getByText('所得税（概算）')).toHaveCount(0);
      await expect(page.getByText('住民税（概算）')).toHaveCount(0);
      await expect(page.getByText('概算税率20%')).toHaveCount(0);
      // 控除は固定税率ではなく青色申告特別控除の実額として出す。
      await expect(page.getByText('控除見込')).toBeVisible();
      await expect(page.getByText('青色申告特別控除（上限')).toBeVisible();
    });

    test('財務概要からシーズン見込みが消え、資金の増減内訳が出る', async ({ page }) => {
      // FREQ-245-AC-06
      await openSummary(page);

      await expect(page.getByText('シーズン全体の見込み')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '資金の増減内訳' })).toBeVisible();
      await expect(page.getByText('営業活動によるキャッシュ・フロー')).toBeVisible();
      await expect(page.getByText('投資活動によるキャッシュ・フロー')).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-245-AC-07
      await openSummary(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
