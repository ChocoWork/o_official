import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-206: Admin KPIビュー既存パーツの暖色グレーを無彩色（白・黒・グレー）に統一
// 2026-11-07 改定: KPIカードだけは目標の達成状態で色分けする（達成=青・未達成=赤・目標なし=白）。
// 状態色の値は src/components/KpiSection.tsx の KpiListCard の statusColor。
// パネルの枠線・横スクロールなど、ほかのパーツは無彩色のまま。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

function buildMetric(period: string) {
  return {
    period,
    salesAmount: 1240000,
    formattedSales: '¥1,240,000',
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
  };
}

async function mockAdminApis(page: Page): Promise<void> {
  await mockAdminBackgroundApis(page);
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
          monthlyYearOptions: [2026],
          monthlyKpiByYear: [{ year: 2026, metrics: [buildMetric('1月')] }],
          seasonalKpi: [buildMetric('2026SS')],
        },
      }),
    });
  });
}

// "rgb(212, 212, 212)" → [212, 212, 212]
function parseRgb(value: string): [number, number, number] {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) {
    throw new Error(`Unexpected color value: ${value}`);
  }
  const [r, g, b] = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
  return [r, g, b];
}

function expectMonochrome([r, g, b]: [number, number, number]): void {
  expect(r).toBe(g);
  expect(g).toBe(b);
}

// KpiListCard の statusColor（達成 / 未達成 / 目標なし）の背景色と枠線色
const KPI_CARD_STATE_COLORS = {
  achieved: { bg: 'rgb(238, 247, 255)', border: 'rgb(185, 217, 245)' }, // #eef7ff / #b9d9f5（青）
  missed: { bg: 'rgb(255, 241, 241)', border: 'rgb(241, 196, 196)' }, // #fff1f1 / #f1c4c4（赤）
  none: { bg: 'rgb(255, 255, 255)', border: 'rgb(232, 232, 232)' }, // 白 / #e8e8e8
} as const;
// 選択中のカードは枠が黒（border-2 border-black）
const KPI_CARD_SELECTED_BORDER = 'rgb(0, 0, 0)';

function kpiListPanel(page: Page) {
  return page.locator('[data-ui-panel]').filter({ hasText: 'KPI一覧' }).first();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-005 KPI monochrome (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('KPIカードの背景色と枠線色が達成状態の色（未達成=赤）である', async ({ page }) => {
      // FREQ-206-AC-01
      await page.goto('/admin');

      // FREQ-261 でカードは選択可能なボタンになった
      const card = kpiListPanel(page).getByRole('button', { name: /^リーチ数：/ });
      await expect(card).toBeVisible();

      const styles = await card.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, border: s.borderTopColor };
      });
      // このモックの「リーチ数」は目標を下回り「未達成」（赤の背景 #fff1f1）で表示される
      await expect(card).toContainText('未達成');
      expect(styles.bg).toBe(KPI_CARD_STATE_COLORS.missed.bg);
      expect([KPI_CARD_STATE_COLORS.missed.border, KPI_CARD_SELECTED_BORDER]).toContain(styles.border);
    });

    test('パネルの枠線の色が無彩色である', async ({ page }) => {
      // FREQ-206-AC-02（FREQ-261 でサブタブを廃止したためパネル枠線で検証する）
      await page.goto('/admin');

      const panel = page.locator('[data-ui-panel]').filter({ hasText: 'KPI一覧' }).first();
      await expect(panel).toBeVisible();

      const borderColor = await panel.evaluate((el) => getComputedStyle(el).borderBottomColor);
      expectMonochrome(parseRgb(borderColor));
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-206-AC-03
      await page.goto('/admin');
      await expect(kpiListPanel(page).getByRole('button', { name: /^リーチ数：/ })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
