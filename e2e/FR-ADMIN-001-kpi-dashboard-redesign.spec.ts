import { test, expect, Page } from '@playwright/test';

// FREQ-202: Admin ダッシュボード刷新（左側縦ナビ + KPI「目標 & 進捗」カードグリッド）
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
          monthlyKpiByYear: [
            {
              year: 2026,
              metrics: ['1月', '2月', '3月', '4月'].map((label) => buildMetric(label)),
            },
          ],
          seasonalKpi: [buildMetric('2026SS'), buildMetric('2025AW')],
          returnRateNote: '返品率はキャンセル率を代替表示しています。',
          inventoryConsumptionRateNote: '在庫消化率は販売実績のある公開商品数で算出しています。',
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
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-001 KPI dashboard redesign (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('管理メニューが左側縦ナビで表示され、既定でKPIが選択される', async ({ page }) => {
      // FREQ-202-AC-01
      await page.goto('/admin');

      const sideNav = page.getByRole('navigation', { name: '管理メニュー' });
      await expect(sideNav).toBeVisible();

      const kpiTab = sideNav.getByRole('button', { name: 'KPI' });
      await expect(kpiTab).toBeVisible();
      await expect(kpiTab).toHaveAttribute('aria-current', 'page');
    });

    test('「目標 & 進捗」にKPIカードグリッドとサンプルの参考バッジが表示される', async ({ page }) => {
      // FREQ-202-AC-02
      await page.goto('/admin');

      await expect(page.getByText('リーチ数', { exact: true })).toBeVisible();
      await expect(page.getByText('CVR', { exact: true })).toBeVisible();
      await expect(page.getByText('CPA', { exact: true })).toBeVisible();
      await expect(page.getByText('ROAS', { exact: true })).toBeVisible();

      // SNS・広告系カードのサンプル参考バッジ
      await expect(page.getByText('参考', { exact: true }).first()).toBeVisible();
    });

    test('サブタブ切替で過去推移・月次記録の表が表示される', async ({ page }) => {
      // FREQ-202-AC-03
      await page.goto('/admin');
      await expect(page.getByText('リーチ数', { exact: true })).toBeVisible();

      await page.getByRole('tab', { name: '過去推移' }).click();
      // FREQ-215 で見出しは「主要KPI推移」から「{選択KPI}推移」（既定=売上）に変更
      await expect(page.getByText('売上推移', { exact: true })).toBeVisible();

      // FREQ-226 でタブ名を「月次目標」から「月次記録」に変更
      await page.getByRole('tab', { name: '月次記録' }).click();
      // FREQ-227 で内容をシーズン別目標管理表から月次記録の入力UIへ刷新
      await expect(page.getByText('算出元データ', { exact: true })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-202-AC-04
      await page.goto('/admin');
      await expect(page.getByText('リーチ数', { exact: true })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
