import { test, expect, Page } from '@playwright/test';

// FREQ-217: 過去推移タブの対象年プルダウンを廃止（FREQ-212 / FREQ-214-REQ-04 を置換）
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
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
}

async function openMonthView(page: Page) {
  await page.goto('/admin');
  await page.getByText('リーチ数', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '過去推移' }).click();
  await page.getByRole('button', { name: '月', exact: true }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-015 remove trend year dropdown (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('「月」を選んでも対象年プルダウンが存在しない', async ({ page }) => {
      // FREQ-217-AC-01
      await openMonthView(page);

      await expect(page.getByRole('button', { name: '月', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByLabel('月次推移の対象年')).toHaveCount(0);
    });

    test('粒度ボタンとKPIプルダウンだけが行に残り、月次の系列が表示される', async ({ page }) => {
      // FREQ-217-AC-02
      await openMonthView(page);

      const monthButton = page.getByRole('button', { name: '月', exact: true });
      const kpiSelector = page.getByRole('button', { name: '推移グラフに表示するKPI' });

      const monthBox = await monthButton.boundingBox();
      const kpiBox = await kpiSelector.boundingBox();
      if (!monthBox || !kpiBox) {
        throw new Error('bounding box not found');
      }
      expect(Math.abs(kpiBox.y - monthBox.y)).toBeLessThanOrEqual(8);
      expect(kpiBox.x).toBeGreaterThan(monthBox.x);

      // targetYear（2026）の月次が系列になる
      await expect(page.getByRole('columnheader', { name: '1月' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: '3月' })).toBeVisible();
      await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-217-AC-03
      await openMonthView(page);
      await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
