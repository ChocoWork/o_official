import { test, expect, Page } from '@playwright/test';

// FREQ-251: 会計画面ヘッダーの整理。
// 更新（再読み込み）はタブ行の右端へ、常時表示は短い状態ラベルのみ、
// 詳細な文言（エラー・完了）は右下の Toast へ。
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
    id: 1, entryType: 'expense', date: '2026-06-01', category: '広告宣伝費', item: 'Instagram広告',
    partner: 'A社', amount: 32000, paymentMethod: 'クレジットカード', memo: '', seasonTag: null, receipts: [],
  },
];

// POST を失敗させるかどうかをテストごとに切り替える。
let failMutations = false;

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
      if (failMutations) {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: '取引の保存に失敗しました。' }),
        });
        return;
      }
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
          incomes: [],
          products: [],
          partners: ['A社'],
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

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-040 accounting header status & toast (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      failMutations = false;
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('更新ボタンがタブ行と同じ高さで右端に並ぶ', async ({ page }) => {
      // FREQ-251-AC-01
      await openAccounting(page);

      const reload = page.getByRole('button', { name: '更新' });
      const tab = page.getByRole('tab', { name: '財務概要' });
      await expect(reload).toBeVisible();

      const reloadBox = await reload.boundingBox();
      const tabBox = await tab.boundingBox();
      expect(reloadBox).not.toBeNull();
      expect(tabBox).not.toBeNull();

      // 再読み込みの垂直中心がタブ行の範囲内にある＝同じ行に並んでいる
      const reloadCenter = reloadBox!.y + reloadBox!.height / 2;
      expect(reloadCenter).toBeGreaterThanOrEqual(tabBox!.y - 4);
      expect(reloadCenter).toBeLessThanOrEqual(tabBox!.y + tabBox!.height + 4);

      // タブより右にある
      expect(reloadBox!.x).toBeGreaterThan(tabBox!.x);
    });

    test('ヘッダーには短い状態だけを出し、長い文言を出さない', async ({ page }) => {
      // FREQ-251-AC-02
      await openAccounting(page);

      await expect(page.getByText('同期済み')).toBeVisible();
      await expect(page.getByText('Supabaseと同期済み')).toHaveCount(0);
      await expect(page.getByText('Supabaseから会計データを読み込み中...')).toHaveCount(0);
    });

    test('保存に失敗すると右下にToastが出てヘッダーが同期エラーになる', async ({ page }) => {
      // FREQ-251-AC-03
      await openAccounting(page);
      failMutations = true;

      await page.getByRole('tab', { name: '取引管理' }).click();
      await page.getByRole('button', { name: `${EXPENSES[0].item}を削除` }).click();
      await page.getByRole('button', { name: '削除を確定' }).click();

      const toast = page.getByTestId('finance-toast');
      await expect(toast).toBeVisible();
      await expect(toast).toContainText('失敗');
      await expect(page.getByText('同期エラー')).toBeVisible();

      // 右下に固定表示されている
      const box = await toast.boundingBox();
      const viewportSize = page.viewportSize()!;
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeGreaterThan(viewportSize.width / 2);
      expect(box!.y + box!.height).toBeGreaterThan(viewportSize.height / 2);
    });

    test('Toastの閉じるで消える', async ({ page }) => {
      // FREQ-251-AC-04
      await openAccounting(page);
      failMutations = true;

      await page.getByRole('tab', { name: '取引管理' }).click();
      await page.getByRole('button', { name: `${EXPENSES[0].item}を削除` }).click();
      await page.getByRole('button', { name: '削除を確定' }).click();

      const toast = page.getByTestId('finance-toast');
      await expect(toast).toBeVisible();

      await toast.getByRole('button', { name: '閉じる' }).click();
      await expect(toast).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-251-AC-01（溢れないこと）
      await openAccounting(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
