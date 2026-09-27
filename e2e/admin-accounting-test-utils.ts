import { expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

/**
 * ACCOUNTING（会計）画面の E2E 用モックとナビゲーション。
 *
 * Playwright は spec ファイル同士の import を禁じており、spec から spec を読むと
 * 「should not import test file」でスイート全体の収集が失敗する。共有するヘルパーは
 * spec ではなくこのユーティリティに置くこと。
 *
 * フィクスチャは mockAdminApis の応答を組み立てるためだけのものなので公開しない。
 */

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

// 普通預金（1040）に借方・貸方の両方が立つように支出と収入を混ぜる。
const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-06-12', category: '荷造運賃', item: '国内配送料（6月分）',
    partner: '物流会社C', amount: 128000, paymentMethod: '銀行', memo: '', seasonTag: null,
    receipts: [RECEIPT],
  },
  {
    id: 2, entryType: 'expense', date: '2026-06-18', category: '仕入高', item: '生地・材料仕入',
    partner: '生地仕入先B', amount: 650000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
    receipts: [RECEIPT],
  },
  {
    id: 3, entryType: 'expense', date: '2026-06-21', category: '広告宣伝費', item: '広告出稿',
    partner: '広告代理店A', amount: 320000, paymentMethod: '銀行', memo: '', seasonTag: null,
    receipts: [],
  },
  {
    id: 6, entryType: 'expense', date: '2026-07-01', category: 'ソフトウェア', item: '在庫管理システム',
    partner: 'システム会社D', amount: 1000000, paymentMethod: '銀行', memo: '', seasonTag: null,
    fixedAssetExempt: false, receipts: [RECEIPT],
  },
];

const INCOMES = [
  {
    id: 4, entryType: 'income', date: '2026-06-22', category: '売上高', item: 'オンライン販売',
    partner: 'EC売上', amount: 1240000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
    receipts: [RECEIPT],
  },
  {
    id: 5, entryType: 'income', date: '2026-03-15', category: '売上高', item: '卸売',
    partner: 'セレクトショップB', amount: 780000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
    receipts: [RECEIPT],
  },
  {
    id: 7, entryType: 'income', date: '2026-07-05', category: '売上高', item: 'オンライン注文',
    partner: '', amount: 59600, paymentMethod: 'Stripe', memo: '', seasonTag: null,
    receipts: [],
  },
  {
    id: 8, entryType: 'income', date: '2026-07-05', category: '売上高', item: 'オンライン注文',
    partner: '', amount: 22222, paymentMethod: 'Stripe', memo: '', seasonTag: null,
    receipts: [],
  },
];

// 定額法・一括償却の2件。予測年度の列と償却完了予定を出すのに使う。
const FIXED_ASSETS = [
  {
    id: 11, name: '工業用ミシン', account: '工具器具備品', acquiredOn: '2025-06-15',
    acquisitionCost: 600000, usefulLife: 6, method: 'straightLine',
    businessUseRatio: 100, disposedOn: null, memo: '',
  },
  {
    id: 12, name: 'ノートPC', account: '工具器具備品', acquiredOn: '2026-04-01',
    acquisitionCost: 180000, usefulLife: 4, method: 'lumpSum3Year',
    businessUseRatio: 80, disposedOn: null, memo: '',
  },
];

const REVISIONS = [
  {
    id: 1, entryId: 2, operation: 'update', changedAt: '2026-06-20T10:15:00.000Z',
    before: { date: '2026-06-18', category: '仕入高', item: '生地・材料仕入', partner: '生地仕入先B', amount: '600000' },
    after: { date: '2026-06-18', category: '仕入高', item: '生地・材料仕入', partner: '生地仕入先B', amount: '650000' },
  },
];

export async function mockAdminApis(page: Page): Promise<void> {
  await mockAdminBackgroundApis(page);
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
    if (new URL(req.url()).pathname.endsWith('/receipt')) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { url: 'https://example.com/x.pdf' } }) });
      return;
    }
    if (req.method() === 'POST') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, resourceId: '7' }) });
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
          partners: ['物流会社C', '生地仕入先B'],
          templates: [],
          fixedAssets: FIXED_ASSETS,
          closing: {
            closingInventoryGoods: 0, closingInventoryMaterials: 0,
            allowanceForDoubtful: 0, closingBalances: {}, closedAt: null,
          },
          // 期首残高（前年度末）。普通預金に前期末残高が立つ。
          previousClosingBalances: { '1040': 3340000, '2910': 3340000 },
          revisions: REVISIONS,
          cumulativeEntries: [
            { id: 101, entryType: 'income', date: '2025-12-20', category: '売上高', item: '前年売上', partner: '', amount: 100000, paymentMethod: '銀行', memo: '' },
            { id: 102, entryType: 'expense', date: '2025-12-25', category: '広告宣伝費', item: '前年広告', partner: '', amount: 30000, paymentMethod: 'クレジットカード', memo: '' },
            { id: 103, entryType: 'income', date: '2026-01-10', category: '売上高', item: '当年売上', partner: '', amount: 20000, paymentMethod: '現金', memo: '' },
            { id: 104, entryType: 'expense', date: '2026-02-05', category: '広告宣伝費', item: '当年広告', partner: '', amount: 5000, paymentMethod: '銀行', memo: '' },
          ],
        },
      }),
    });
  });
}

export async function openLedgerTab(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '帳簿', exact: true }).click();
  await expect(page.getByRole('tab', { name: '仕訳・元帳', exact: true })).toBeVisible();
}
