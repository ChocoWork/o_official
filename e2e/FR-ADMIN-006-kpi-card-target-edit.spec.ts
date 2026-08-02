import { test, expect, Page } from '@playwright/test';

// FREQ-207: KPIカード右上の編集ボタンから現在シーズンの目標値を設定できる
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

function makeTargetsPayload(values: Record<string, Record<string, string>>) {
  return {
    data: {
      currentSeason: '2026SS',
      seasons: ['2025AW', '2026SS', '2026AW'],
      definitions: [
        { key: 'reach', label: 'リーチ数', definition: '', priority: '◎' },
        { key: 'cvr', label: 'CVR', definition: '', priority: '◎' },
        { key: 'sales', label: '売上', definition: '', priority: '◎' },
      ],
      values,
    },
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
          monthlyKpiByYear: [{ year: 2026, metrics: [buildMetric('1月')] }],
          seasonalKpi: [buildMetric('2026SS')],
        },
      }),
    });
  });

  // 目標のGET/PUTを可変ストアでモックする。
  const store: Record<string, Record<string, string>> = {
    cvr: { '2026SS': '3.0%' },
    reach: { '2026SS': '200,000 人' },
    sales: { '2026SS': '2,000,000' },
  };

  await page.route('**/api/admin/kpi/targets', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const body = JSON.parse(request.postData() ?? '{}') as {
        updates?: Array<{ season: string; kpiKey: string; value: string }>;
      };
      for (const update of body.updates ?? []) {
        store[update.kpiKey] = { ...(store[update.kpiKey] ?? {}), [update.season]: update.value };
      }
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeTargetsPayload(store)),
    });
  });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-006 KPI card target edit (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    // FREQ-261 で編集はカード右上の鉛筆から、選択中KPIのサマリー行の「目標を編集」に一本化された。
    test('選択中KPIのサマリーに目標編集ボタンが表示される', async ({ page }) => {
      // FREQ-207-AC-01
      await page.goto('/admin');

      await expect(page.getByText('リーチ数', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '目標を編集' })).toHaveCount(1);
      await expect(page.getByRole('button', { name: /の目標を編集$/ })).toHaveCount(0);
    });

    test('編集ボタンから目標値を設定するとカードとサマリーに反映される', async ({ page }) => {
      // FREQ-207-AC-02
      await page.goto('/admin');

      const cvrCard = page.getByRole('button', { name: /^CVR/ });
      await cvrCard.click();
      await expect(cvrCard).toContainText('目標 3.0%');

      await page.getByRole('button', { name: '目標を編集' }).click();

      const input = page.getByLabel('CVRの目標値');
      await expect(input).toHaveValue('3.0%');
      await input.fill('4.5%');

      // 編集中は横スクロールが発生しない
      const hasOverflowWhileEditing = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasOverflowWhileEditing).toBe(false);

      await page.getByRole('button', { name: '目標を保存' }).click();

      await expect(cvrCard).toContainText('目標 4.5%');
      await expect(page.getByLabel('CVRの目標値')).toHaveCount(0);
    });

    test('キャンセルすると目標値が変更されない', async ({ page }) => {
      // FREQ-207-AC-03
      await page.goto('/admin');

      const cvrCard = page.getByRole('button', { name: /^CVR/ });
      await cvrCard.click();
      await page.getByRole('button', { name: '目標を編集' }).click();

      const input = page.getByLabel('CVRの目標値');
      await input.fill('9.9%');
      await page.getByRole('button', { name: '編集をキャンセル' }).click();

      await expect(cvrCard).toContainText('目標 3.0%');
      await expect(cvrCard).not.toContainText('目標 9.9%');
    });
  });
}
