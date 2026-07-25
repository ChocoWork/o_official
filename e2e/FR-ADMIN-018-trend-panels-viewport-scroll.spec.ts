import { test, expect, Page } from '@playwright/test';

// FREQ-220: 過去推移タブのグラフ・KPI一覧をビューポート高に収め、KPI一覧を内部スクロールに
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

async function openTrendTab(page: Page) {
  await page.goto('/admin');
  await page.getByText('リーチ数', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '過去推移' }).click();
  await expect(page.getByRole('img', { name: '売上の推移グラフ' })).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-018 trend panels viewport scroll (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('両パネルの高さがビューポート高以下', async ({ page }) => {
      // FREQ-220-AC-01
      await openTrendTab(page);

      const heights = await page.evaluate(() => {
        const table = document.querySelector('table');
        const scroller = table?.parentElement as HTMLElement;
        const kpiPanel = scroller.parentElement as HTMLElement;
        const grid = kpiPanel.parentElement as HTMLElement;
        const graphPanel = grid.children[0] as HTMLElement;
        return {
          graph: graphPanel.getBoundingClientRect().height,
          kpi: kpiPanel.getBoundingClientRect().height,
          viewport: window.innerHeight,
        };
      });

      expect(heights.graph).toBeLessThanOrEqual(heights.viewport + 1);
      expect(heights.kpi).toBeLessThanOrEqual(heights.viewport + 1);
    });

    test('KPI一覧の表領域はパネル内スクロールになる', async ({ page }) => {
      // FREQ-220-AC-02
      await openTrendTab(page);

      const result = await page.evaluate(() => {
        const table = document.querySelector('table');
        const scroller = table?.parentElement as HTMLElement;
        scroller.scrollTop = 400;
        return {
          overflowY: getComputedStyle(scroller).overflowY,
          overflows: scroller.scrollHeight > scroller.clientHeight + 1,
          scrollTop: scroller.scrollTop,
        };
      });

      // 表領域は縦スクロール可能な設定であること
      expect(result.overflowY).toBe('auto');
      // 内容がパネルに収まらない場合は、ページではなくこの領域がスクロールすること
      if (result.overflows) {
        expect(result.scrollTop).toBeGreaterThan(0);
      }
    });

    test('表ヘッダーが sticky で、横スクロールしない', async ({ page }) => {
      // FREQ-220-AC-03
      await openTrendTab(page);

      const headerPosition = await page
        .getByRole('columnheader', { name: 'KPI', exact: true })
        .evaluate((el) => getComputedStyle(el).position);
      expect(headerPosition).toBe('sticky');

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
