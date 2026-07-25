import { test, expect, Page } from '@playwright/test';

// FREQ-218: KPI選択プルダウンのトリガー内の文字を左寄せに
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

function months() {
  return ['1月', '2月', '3月'].map((m, i) => metric(m, 40000 + i * 30000, 20000 + i * 800, 0.9 + i * 0.3, 3 + i, i));
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
            { year: 2025, metrics: months() },
            { year: 2026, metrics: months() },
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
}

const KPI_SELECTOR = '推移グラフに表示するKPI';

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-016 trend KPI selector align left (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('選択値がトリガーの内容領域の左端に揃う', async ({ page }) => {
      // FREQ-218-AC-01
      await openTrendTab(page);

      const trigger = page.getByRole('button', { name: KPI_SELECTOR });
      await expect(trigger).toBeVisible();

      const triggerBox = await trigger.boundingBox();
      const valueBox = await trigger.getByText('売上', { exact: true }).boundingBox();
      if (!triggerBox || !valueBox) {
        throw new Error('bounding box not found');
      }

      const inset = await trigger.evaluate((el) => {
        const style = getComputedStyle(el);
        return Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
      });

      expect(Math.abs(valueBox.x - (triggerBox.x + inset))).toBeLessThanOrEqual(2);
    });

    test('選択値とシェブロンが両端に分かれる', async ({ page }) => {
      // FREQ-218-AC-02
      await openTrendTab(page);

      const trigger = page.getByRole('button', { name: KPI_SELECTOR });
      const valueBox = await trigger.getByText('売上', { exact: true }).boundingBox();
      const chevronBox = await trigger.locator('.single-select__chevron').boundingBox();
      if (!valueBox || !chevronBox) {
        throw new Error('bounding box not found');
      }

      expect(valueBox.x + valueBox.width).toBeLessThan(chevronBox.x);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-218-AC-03
      await openTrendTab(page);
      await expect(page.getByRole('button', { name: KPI_SELECTOR })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
