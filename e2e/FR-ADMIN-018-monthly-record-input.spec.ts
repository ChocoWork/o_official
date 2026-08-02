import { test, expect, Page } from '@playwright/test';

// FREQ-227 / FREQ-228: 月次記録タブ = 選択シーズン（6ヶ月）の各KPI算出元データ入力 + KPI自動計算
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

// 全月同一の既知メトリクス。
function metric(period: string) {
  return {
    period,
    salesAmount: 800000,
    formattedSales: '¥800,000',
    cvr: 40,
    formattedCvr: '40.0%',
    aov: 20000,
    formattedAov: '¥20,000',
    setPurchaseRate: 60,
    formattedSetPurchaseRate: '60.0%',
    inventoryConsumptionRate: 75,
    formattedInventoryConsumptionRate: '75.0%',
    ltv: 16000,
    formattedLtv: '¥16,000',
    repeatRate: 20,
    formattedRepeatRate: '20.0%',
    returnRate: 5,
    formattedReturnRate: '5.0%',
    orderCount: 100,
    paidOrderCount: 40,
    customerCount: 50,
    repeatCustomerCount: 10,
    setOrderCount: 24,
    cancelledOrderCount: 5,
    soldItemCount: 15,
    publishedItemCount: 20,
  };
}

function months() {
  return Array.from({ length: 12 }, (_, i) => metric(`${i + 1}月`));
}

function seasonMonthKeys(season: string): string[] {
  const year = Number.parseInt(season.slice(0, 4), 10);
  if (season.endsWith('SS')) {
    return [4, 5, 6, 7, 8, 9].map((m) => `${year}-${String(m).padStart(2, '0')}`);
  }
  return [`${year}-10`, `${year}-11`, `${year}-12`, `${year + 1}-01`, `${year + 1}-02`, `${year + 1}-03`];
}

async function mockAdminApis(page: Page, seedValues: Record<string, Record<string, number>> = {}): Promise<void> {
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
          monthlyKpiByYear: [{ year: 2026, metrics: months() }],
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

  await page.route('**/api/admin/kpi/monthly-record**', (route) => {
    const method = route.request().method();
    const season = method === 'GET' ? new URL(route.request().url()).searchParams.get('season') || '2026SS' : '2026SS';
    const keys = seasonMonthKeys(season);
    const values: Record<string, Record<string, number>> = {};
    keys.forEach((k) => {
      values[k] = seedValues[k] ?? {};
    });
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { season, monthKeys: keys, values } }),
    });
  });
}

// FREQ-261 で算出元データの入力表は「算出元データを確認」から開くドロワーへ移動した。
async function openRecordTab(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: '算出元データを確認' }).click();
  await page.getByLabel('売上額 4月の値').waitFor();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-018 monthly record input (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('選択シーズン(2026SS)の6ヶ月(4〜9月)が列に並び、算出元データ表とKPI表が出る', async ({ page }) => {
      // FREQ-228-AC-01
      await mockAdminApis(page);
      await openRecordTab(page);

      await expect(page.getByText('2026年4月〜9月', { exact: true })).toBeVisible();
      await expect(page.getByText('算出元データ', { exact: true })).toBeVisible();
      await expect(page.getByText('KPI（自動計算）', { exact: true })).toBeVisible();

      for (const month of ['4月', '5月', '6月', '7月', '8月', '9月']) {
        await expect(page.getByLabel(`売上額 ${month}の値`)).toBeVisible();
      }
      // KPIは各月の記録値入力（19指標 × 6ヶ月）
      await expect(page.locator('input[aria-label$="の記録値（上書き）"]')).toHaveCount(19 * 6);
    });

    test('シーズンをA/Wにすると10〜翌3月に切り替わる', async ({ page }) => {
      // FREQ-228-AC-02
      await mockAdminApis(page);
      await openRecordTab(page);

      await page.getByRole('button', { name: '算出元データを閉じる' }).click();
      await page.getByRole('button', { name: '対象シーズン' }).click();
      await page.getByRole('option', { name: '2026 A/W' }).click();
      await page.getByRole('button', { name: '算出元データを確認' }).click();
      await expect(page.getByText('2026年10月〜2027年3月', { exact: true })).toBeVisible();
      await expect(page.getByLabel('売上額 10月の値')).toBeVisible();
      await expect(page.getByLabel('売上額 3月の値')).toBeVisible();
    });

    test('order由来は各月の自動値プレースホルダ+自動バッジ、SNS系は手入力バッジ', async ({ page }) => {
      // FREQ-228-AC-03
      await mockAdminApis(page);
      await openRecordTab(page);

      await expect(page.getByLabel('売上額 4月の値')).toHaveAttribute('placeholder', '¥800,000');

      const salesRow = page.getByLabel('売上額 4月の値').locator('xpath=ancestor::tr');
      await expect(salesRow.getByText('自動', { exact: true })).toBeVisible();

      const reachRow = page.getByLabel('リーチ数 4月の値').locator('xpath=ancestor::tr');
      await expect(reachRow.getByText('手入力', { exact: true })).toBeVisible();
    });

    test('order実績からKPIが各月自動計算される（CVR4月=40.0%）', async ({ page }) => {
      // FREQ-228-AC-04（order側・自動計算はKPI入力のプレースホルダに表示）
      await mockAdminApis(page);
      await openRecordTab(page);

      await expect(page.getByLabel('CVR 4月の記録値（上書き）')).toHaveAttribute('placeholder', '40.0%');
      await expect(page.getByLabel('客単価（AOV） 4月の記録値（上書き）')).toHaveAttribute('placeholder', '¥20,000');
    });

    test('SNS系の元データ入力でその月のKPIが自動計算される（保存率4月=25.0%）', async ({ page }) => {
      // FREQ-228-AC-04（manual側）
      await mockAdminApis(page);
      await openRecordTab(page);

      await expect(page.getByLabel('保存率 4月の記録値（上書き）')).toHaveAttribute('placeholder', '—');

      await page.getByLabel('リーチ数 4月の値').fill('1000');
      await page.getByLabel('保存数 4月の値').fill('250');

      await expect(page.getByLabel('保存率 4月の記録値（上書き）')).toHaveAttribute('placeholder', '25.0%');
    });

    test('保存でseasonと月別更新分がPUTされる', async ({ page }) => {
      // FREQ-228-AC-05
      await mockAdminApis(page);
      await openRecordTab(page);

      const captured: {
        body: { season?: string; updates?: Array<{ monthKey: string; metricKey: string; value: number | '' }> } | null;
      } = { body: null };
      await page.route('**/api/admin/kpi/monthly-record', (route) => {
        if (route.request().method() === 'PUT') {
          captured.body = route.request().postDataJSON();
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: { season: '2026SS', monthKeys: seasonMonthKeys('2026SS'), values: { '2026-04': { 'src:reach': 1000 } } } }),
          });
        } else {
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: { season: '2026SS', monthKeys: seasonMonthKeys('2026SS'), values: {} } }),
          });
        }
      });

      await page.getByLabel('リーチ数 5月の値').fill('1000');
      await page.getByRole('button', { name: '保存', exact: true }).click();

      await expect.poll(() => captured.body?.season).toBe('2026SS');
      expect(captured.body?.updates).toContainEqual({ monthKey: '2026-05', metricKey: 'src:reach', value: 1000 });
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-228-AC-06
      await mockAdminApis(page);
      await openRecordTab(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
