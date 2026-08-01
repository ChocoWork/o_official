import { test, expect, Page } from '@playwright/test';

// FREQ-242: 帳簿タブを法定帳簿の形（仕訳帳・総勘定元帳・合計残高試算表）で表示し、
// 取引管理の実データだけから導出する。架空仕訳は出さない。
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

// 掛売上→回収、掛仕入→支払、現金経費。合計 ¥427,000 の貸借が立つ。
const EXPENSES = [
  {
    id: 11, entryType: 'expense', date: '2026-02-10', category: '仕入高', item: '生地・材料仕入',
    partner: 'B社', amount: 90000, paymentMethod: '買掛金', memo: '', seasonTag: '2026SS',
  },
  {
    id: 12, entryType: 'expense', date: '2026-02-28', category: '買掛金', item: '生地・材料仕入',
    partner: 'B社', amount: 90000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
  },
  {
    id: 13, entryType: 'expense', date: '2026-03-05', category: '広告宣伝費', item: '広告出稿',
    partner: 'A社', amount: 27000, paymentMethod: '現金', memo: '', seasonTag: null,
  },
];

const INCOMES = [
  {
    id: 21, entryType: 'income', date: '2026-04-20', category: '売上高', item: 'オンライン販売',
    partner: '', amount: 110000, paymentMethod: '売掛金', memo: '', seasonTag: '2026SS',
  },
  {
    id: 22, entryType: 'income', date: '2026-05-31', category: '売掛金', item: 'オンライン販売',
    partner: '', amount: 110000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
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

async function openLedger(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '帳簿', exact: true }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-032 ledger & trial balance (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('帳簿タブに3サブビューが並び、架空仕訳が出ない', async ({ page }) => {
      // FREQ-242-AC-05
      await openLedger(page);

      for (const label of ['仕訳・元帳', '固定資産', '決算・試算表']) {
        await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
      }
      // 従来ハードコードしていた架空仕訳は出さない。
      await expect(page.getByText('売上計上')).toHaveCount(0);
      await expect(page.getByText('売上原価振替')).toHaveCount(0);
    });

    test('仕訳一覧が実取引の相手科目と貸借を表示する', async ({ page }) => {
      // FREQ-242-AC-02
      await openLedger(page);

      // 現金元帳に広告宣伝費への出金が貸方で立つ。
      await page.getByLabel('勘定科目を検索').fill('現金');
      await page
        .getByRole('region', { name: '勘定科目' })
        .getByRole('button', { name: /1010\s*現金/ })
        .click();
      const adRow = page.getByRole('row').filter({ hasText: 'JE-20260305-001' });
      await expect(adRow).toContainText('広告宣伝費');
    });

    test('科目ツリーで科目を選び、期末残高と元帳CSVを出せる', async ({ page }) => {
      // FREQ-242-AC-03
      await openLedger(page);

      await expect(page.getByRole('region', { name: '勘定科目' })).toBeVisible();
      await expect(page.getByRole('button', { name: '総勘定元帳CSV' })).toBeVisible();

      // 現金科目を選ぶと出金27,000のみなので残高がマイナスになる。
      await page.getByLabel('勘定科目を検索').fill('現金');
      await page
        .getByRole('region', { name: '勘定科目' })
        .getByRole('button', { name: /1010\s*現金/ })
        .click();
      await expect(
        page.getByRole('region', { name: '残高推移' }).getByText('¥-27,000', { exact: true }),
      ).toBeVisible();
    });

    test('合計残高試算表で貸借一致を確認できる', async ({ page }) => {
      // FREQ-242-AC-04
      await openLedger(page);
      await page.getByRole('tab', { name: '決算・試算表', exact: true }).click();
      await page.getByRole('tab', { name: '合計残高試算表', exact: true }).click();

      await expect(page.getByText('貸借一致（借方合計 = 貸方合計）')).toBeVisible();
      await expect(page.getByRole('button', { name: '試算表CSV' })).toBeVisible();

      // 借方合計・貸方合計はいずれも 90000+90000+27000+110000+110000 = 427,000
      const totalRow = page.getByRole('row').filter({ hasText: '合計' }).last();
      await expect(totalRow).toContainText('¥427,000');
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-242-AC-06
      await openLedger(page);
      await page.getByRole('tab', { name: '決算・試算表', exact: true }).click();
      await page.getByRole('tab', { name: '合計残高試算表', exact: true }).click();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
