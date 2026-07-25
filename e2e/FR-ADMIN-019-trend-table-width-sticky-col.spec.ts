import { test, expect, Page } from '@playwright/test';

// FREQ-221: PCはグラフを狭めKPI一覧を横スクロール不要に／縦積みはKPI列を固定して横スクロール
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

// 月粒度で列数を増やし横スクロールを起こせるよう12か月ぶん用意する。
function months(seed: number) {
  return ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'].map((m, i) =>
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
          monthlyYearOptions: [2024, 2025, 2026],
          monthlyKpiByYear: [
            { year: 2024, metrics: months(1) },
            { year: 2025, metrics: months(2) },
            { year: 2026, metrics: months(3) },
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

function noPageHOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

test.describe('FR-ADMIN-019 desktop: graph narrower, KPI list no h-scroll', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockAdminApis(page);
  });

  test('グラフパネルがKPI一覧パネルより狭い', async ({ page }) => {
    // FREQ-221-AC-01
    await openTrendTab(page);

    const widths = await page.evaluate(() => {
      const table = document.querySelector('table');
      const scroller = table?.parentElement as HTMLElement;
      const kpiPanel = scroller.parentElement as HTMLElement;
      const grid = kpiPanel.parentElement as HTMLElement;
      const graphPanel = grid.children[0] as HTMLElement;
      return {
        graph: graphPanel.getBoundingClientRect().width,
        kpi: kpiPanel.getBoundingClientRect().width,
      };
    });

    expect(widths.graph).toBeLessThan(widths.kpi);
  });

  test('既定（年度粒度）でKPI一覧が横スクロールしない', async ({ page }) => {
    // FREQ-221-AC-02
    await openTrendTab(page);

    const hOverflow = await page.evaluate(() => {
      const scroller = (document.querySelector('table') as HTMLElement).parentElement as HTMLElement;
      return scroller.scrollWidth > scroller.clientWidth + 1;
    });
    expect(hOverflow).toBe(false);
    expect(await noPageHOverflow(page)).toBe(false);
  });
});

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
]) {
  test.describe(`FR-ADMIN-019 stacked: sticky KPI column (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('横スクロールしてもKPI列が左端に固定される', async ({ page }) => {
      // FREQ-221-AC-03
      await openTrendTab(page);
      await page.getByRole('button', { name: '月', exact: true }).click();

      const firstHeader = page.getByRole('columnheader', { name: 'KPI', exact: true });

      const position = await firstHeader.evaluate((el) => getComputedStyle(el).position);
      expect(position).toBe('sticky');

      const beforeX = (await firstHeader.boundingBox())!.x;

      // 表領域を右へ横スクロール
      const scrolled = await page.evaluate(() => {
        const scroller = (document.querySelector('table') as HTMLElement).parentElement as HTMLElement;
        scroller.scrollLeft = 400;
        return scroller.scrollLeft > 0;
      });
      expect(scrolled).toBe(true);

      const afterX = (await firstHeader.boundingBox())!.x;
      expect(Math.abs(afterX - beforeX)).toBeLessThanOrEqual(1);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-221-AC-04
      await openTrendTab(page);
      await page.getByRole('button', { name: '月', exact: true }).click();
      expect(await noPageHOverflow(page)).toBe(false);
    });
  });
}
