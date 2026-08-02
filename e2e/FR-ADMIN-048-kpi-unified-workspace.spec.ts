import { test, expect, Page } from '@playwright/test';

// FREQ-261: KPI タブのサブタブを廃止し、1画面で完結する KPI ワークスペースにする
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

function buildMetric(period: string, salesAmount: number) {
  return {
    period,
    salesAmount,
    formattedSales: `¥${salesAmount.toLocaleString('ja-JP')}`,
    cvr: 1.6,
    formattedCvr: '1.6%',
    aov: 24800,
    formattedAov: '¥24,800',
    setPurchaseRate: 12.4,
    formattedSetPurchaseRate: '12.4%',
    inventoryConsumptionRate: 68.2,
    formattedInventoryConsumptionRate: '68.2%',
    ltv: 112300,
    formattedLtv: '¥112,300',
    repeatRate: 30,
    formattedRepeatRate: '30.0%',
    returnRate: 5,
    formattedReturnRate: '5.0%',
    orderCount: 100,
    paidOrderCount: 80,
    customerCount: 70,
    repeatCustomerCount: 20,
    setOrderCount: 10,
    cancelledOrderCount: 5,
    soldItemCount: 60,
    publishedItemCount: 90,
  };
}

// 12ヶ月分。4〜9月（2026 S/S）に山を作り、前年（2025）は低めにする。
function buildYear(year: number, scale: number) {
  const monthlySales = [820000, 860000, 900000, 950000, 1142000, 1240000, 1180000, 1210000, 1260000, 990000, 1020000, 1060000];
  return {
    year,
    metrics: monthlySales.map((sales, index) => buildMetric(`${index + 1}月`, Math.round(sales * scale))),
  };
}

async function mockAdminApis(page: Page): Promise<void> {
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
          monthlyKpiByYear: [buildYear(2025, 0.62), buildYear(2026, 1)],
          seasonalKpi: [buildMetric('2026SS', 1240000), buildMetric('2025AW', 980000)],
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
          seasons: ['2026SS', '2026AW'],
          definitions: [
            { key: 'cvr', label: 'CVR', definition: '購入率', priority: '◎' },
            { key: 'sales', label: '売上', definition: '売上高', priority: '◎' },
          ],
          values: {
            cvr: { '2026SS': '3.0%' },
            sales: { '2026SS': '2,000,000' },
          },
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
          values: {},
        },
      }),
    });
  });
}

async function openKpiWorkspace(page: Page): Promise<void> {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'KPIダッシュボード' })).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-048 KPI unified workspace (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('サブタブが無く、ヘッダーにシーズン選択・更新が並ぶ', async ({ page }) => {
      // FREQ-261-AC-01
      await openKpiWorkspace(page);

      await expect(page.getByRole('tab', { name: '目標 & 進捗' })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: '過去推移' })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: '月次記録' })).toHaveCount(0);

      await expect(page.getByLabel('対象シーズン')).toBeVisible();
      await expect(page.getByRole('button', { name: '更新' })).toBeVisible();
    });

    test('KPI一覧のカード選択とカテゴリ絞り込みができる', async ({ page }) => {
      // FREQ-261-AC-02
      await openKpiWorkspace(page);

      const cards = page.getByRole('button', { pressed: false }).filter({ hasText: '目標' });
      await expect(page.getByText('KPI一覧', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^売上/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(cards.first()).toBeVisible();

      const cvrCard = page.getByRole('button', { name: /^CVR/ });
      await cvrCard.click();
      await expect(cvrCard).toHaveAttribute('aria-pressed', 'true');

      await page.getByRole('button', { name: '広告', exact: true }).click();
      await expect(page.getByRole('button', { name: /^ROAS/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^売上/ })).toHaveCount(0);
    });

    test('選択中KPIの現在値・目標・達成率と目標編集が表示される', async ({ page }) => {
      // FREQ-261-AC-03
      await openKpiWorkspace(page);

      const summary = page.locator('section', { has: page.getByRole('button', { name: '目標を編集' }) }).last();
      await expect(summary.getByText('現在値', { exact: true })).toBeVisible();
      await expect(summary.getByText('目標', { exact: true })).toBeVisible();
      await expect(summary.getByText('達成率', { exact: true })).toBeVisible();
      await expect(summary.getByText('¥2,000,000', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: '目標を編集' }).click();
      await expect(page.getByLabel('売上の目標値')).toHaveValue('2,000,000');
      await expect(page.getByRole('button', { name: '目標を保存' })).toBeVisible();
      await page.getByRole('button', { name: '編集をキャンセル' }).click();
      await expect(page.getByLabel('売上の目標値')).toHaveCount(0);
    });

    test('推移グラフが表示され、粒度を切り替えられる', async ({ page }) => {
      // FREQ-261-AC-04
      await openKpiWorkspace(page);

      await expect(page.getByText('売上推移', { exact: true })).toBeVisible();
      await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toBeVisible();

      await page.getByRole('tab', { name: 'シーズン' }).click();
      await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toBeVisible();
      await page.getByRole('tab', { name: '年度' }).click();
      await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toBeVisible();
    });

    test('月次記録の入力・一覧・インサイトが同一画面に並ぶ', async ({ page }) => {
      // FREQ-261-AC-05
      await openKpiWorkspace(page);

      await expect(page.getByText('月次記録を入力', { exact: true })).toBeVisible();
      await expect(page.getByText('月次記録', { exact: true })).toBeVisible();
      await expect(page.getByText('インサイト', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '記録を保存' })).toBeVisible();

      await page.getByRole('button', { name: '算出元データを確認' }).click();
      await expect(page.getByLabel('売上額 4月の値')).toBeVisible();
      await page.getByRole('button', { name: '算出元データを閉じる' }).click();
      await expect(page.getByLabel('売上額 4月の値')).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-261-AC-06
      await openKpiWorkspace(page);

      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
