import { test, expect, Page } from '@playwright/test';

// FREQ-219: KPI一覧の行をプルダウンと同じ20指標に
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

// FREQ-261 で実データ接続済みの指標を先に並べる順序に変更
const KPI_LABELS = [
  '売上',
  'CVR',
  '客単価（AOV）',
  '在庫消化率',
  'リピート率',
  '返品率',
  'ROAS',
  'CPA',
  'セット購入率',
  'LTV',
  'リーチ数',
  '保存率',
  'プロフィール遷移率',
  'フォロー率',
  'ストーリー視聴数',
  'ストーリー到達率',
  'リンククリック率',
  'CPC',
  'CPM',
  '離脱率',
];

function metric(period: string, sales: number, aov: number, cvr: number, orders: number, customers: number) {
  return {
    period,
    salesAmount: sales,
    formattedSales: `¥${sales.toLocaleString()}`,
    cvr,
    formattedCvr: `${cvr}%`,
    aov,
    formattedAov: `¥${aov.toLocaleString()}`,
    setPurchaseRate: 12,
    formattedSetPurchaseRate: '12%',
    inventoryConsumptionRate: 68,
    formattedInventoryConsumptionRate: '68%',
    ltv: 112300,
    formattedLtv: '¥112,300',
    repeatRate: 30,
    formattedRepeatRate: '30%',
    returnRate: 5,
    formattedReturnRate: '5%',
    orderCount: orders,
    paidOrderCount: orders,
    customerCount: customers,
    repeatCustomerCount: 10,
  };
}

function months(seed: number) {
  return ['1月', '2月', '3月'].map((m, i) =>
    metric(m, 40000 + i * 30000 * seed, 20000 + i * 800, 0.9 + i * 0.3, 3 + i, i + seed),
  );
}

async function mockAdminApis(
  page: Page,
  monthlyRecordValues: Record<string, Record<string, number>> = {},
): Promise<void> {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'admin-1', email: 'admin@example.com', role: 'admin', mfaVerified: true },
      }),
    });
  });

  await page.route('**/api/admin/kpi', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          targetYear: 2026,
          monthlyYearOptions: [2025, 2026],
          monthlyKpiByYear: [
            { year: 2025, metrics: months(1) },
            { year: 2026, metrics: months(2) },
          ],
          seasonalKpi: [metric('2026SS', 1240000, 24800, 1.6, 50, 3100)],
        },
      }),
    });
  });

  await page.route('**/api/admin/kpi/targets', async (route) => {
    await route.fulfill({
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
    });
  });

  await page.route('**/api/admin/kpi/monthly-record**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          season: '2026SS',
          monthKeys: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
          values: monthlyRecordValues,
        },
      }),
    });
  });
}

// FREQ-261 で全KPIの推移表はインサイト行の「内訳を見る」から開くドロワーへ移動した。
async function openTrendTab(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: /^リーチ数：/ }).waitFor();
  await page.getByRole('button', { name: '内訳を見る' }).click();
}

function trendTableBody(page: Page) {
  return page
    .locator('table')
    .filter({ has: page.getByRole('columnheader', { name: '成長率(CAGR)' }) })
    .locator('tbody');
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-017 trend table all KPIs (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('行がプルダウンと同じ20指標になる', async ({ page }) => {
      // FREQ-219-AC-01
      await openTrendTab(page);

      const rows = trendTableBody(page).locator('tr');
      await expect(rows).toHaveCount(KPI_LABELS.length);

      // 並び順がプルダウンの選択肢と一致する
      const labels = await rows.evaluateAll((elements) =>
        elements.map((el) => el.querySelector('td')?.textContent?.replace('参考', '').trim() ?? ''),
      );
      expect(labels).toEqual(KPI_LABELS);

      // 旧行は消えている
      await expect(page.getByRole('cell', { name: '注文数' })).toHaveCount(0);
      await expect(page.getByRole('cell', { name: '新規ユーザー数' })).toHaveCount(0);
    });

    test('参考値の行にバッジが付き、未記録値はダッシュで表示される', async ({ page }) => {
      // FREQ-219-AC-02
      await openTrendTab(page);

      const reachRow = trendTableBody(page).locator('tr').filter({ hasText: 'リーチ数' });
      const salesRow = trendTableBody(page).locator('tr').filter({ hasText: '売上' });

      await expect(reachRow.getByText('参考', { exact: true })).toBeVisible();
      await expect(salesRow.getByText('参考', { exact: true })).toHaveCount(0);

      await expect(salesRow.locator('td').nth(1)).toHaveText('—');

      const cvrRow = trendTableBody(page).locator('tr').filter({ hasText: 'CVR' });
      await expect(cvrRow.locator('td').nth(1)).toHaveText('—');
    });

    test('成長率(CAGR)列が維持され、横スクロールしない', async ({ page }) => {
      // FREQ-219-AC-03
      await openTrendTab(page);

      await expect(page.getByRole('columnheader', { name: '成長率(CAGR)' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    test('未記録のROASには実績推移を描画しない', async ({ page }) => {
      // FREQ-262-AC-01
      await page.goto('/admin');
      await page.getByRole('button', { name: /^リーチ数：/ }).waitFor();
      await page.getByRole('button', { name: /^ROAS：/ }).click();

      await expect(page.getByLabel('ROASの推移グラフ')).toHaveCount(0);
      await expect(page.getByText('表示できるデータがありません。', { exact: true })).toBeVisible();
    });

    test('記録済みの月だけROASの実績点を描画する', async ({ page }) => {
      // FREQ-262-AC-01
      await page.unroute('**/api/admin/kpi/monthly-record**');
      await mockAdminApis(page, { '2026-05': { 'kpi:roas': 3.2 } });
      await page.goto('/admin');
      await page.getByRole('button', { name: /^リーチ数：/ }).waitFor();
      await page.getByRole('button', { name: /^ROAS：/ }).click();

      const graph = page.getByLabel('ROASの推移グラフ');
      await expect(graph.locator('circle')).toHaveCount(1);
    });

    test('ROASのシーズン・年度にサンプル推移を描画しない', async ({ page }) => {
      // FREQ-262-AC-02
      await page.goto('/admin');
      await page.getByRole('button', { name: /^リーチ数：/ }).waitFor();
      await page.getByRole('button', { name: /^ROAS：/ }).click();

      await page.getByRole('tab', { name: 'シーズン', exact: true }).click();
      await expect(page.getByLabel('ROASの推移グラフ')).toHaveCount(0);

      await page.getByRole('tab', { name: '年度', exact: true }).click();
      await expect(page.getByLabel('ROASの推移グラフ')).toHaveCount(0);
    });
  });
}
