import { test, expect, Page } from '@playwright/test';

// FREQ-214: KPIタブの生ボタンを Button UI コンポーネント（outline / selected / iconOnly）へ
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

async function openKpi(page: Page) {
  await page.goto('/admin');
  await page.getByText('リーチ数', { exact: true }).waitFor();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-012 KPI buttons via Button UI component (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('非選択のシーズンボタンが outline バリアントの Button である', async ({ page }) => {
      // FREQ-214-AC-01
      await openKpi(page);

      const inactiveSeason = page.getByRole('button', { name: '2027 S/S' });
      await expect(inactiveSeason).toBeVisible();
      await expect(inactiveSeason).toHaveAttribute('data-ui-button', 'true');
      await expect(inactiveSeason).toHaveAttribute('data-ui-button-variant', 'outline');

      const style = await inactiveSeason.evaluate((el) => {
        const s = getComputedStyle(el);
        return { border: s.borderTopColor, color: s.color, background: s.backgroundColor };
      });

      expect(style.border).toBe('rgb(212, 212, 212)');
      expect(style.color).toBe('rgb(71, 71, 71)');
      expect(style.background).toBe('rgba(0, 0, 0, 0)');
    });

    test('選択中のシーズンボタンが aria-pressed と黒塗りで示され、高さは非選択と同じ', async ({ page }) => {
      // FREQ-214-AC-02
      await openKpi(page);

      const activeSeason = page.getByRole('button', { name: '2026 S/S' });
      const inactiveSeason = page.getByRole('button', { name: '2027 S/S' });

      await expect(activeSeason).toHaveAttribute('aria-pressed', 'true');
      await expect(inactiveSeason).toHaveAttribute('aria-pressed', 'false');

      const style = await activeSeason.evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor };
      });
      expect(style.background).toBe('rgb(17, 17, 17)');
      expect(style.color).toBe('rgb(255, 255, 255)');

      const activeBox = await activeSeason.boundingBox();
      const inactiveBox = await inactiveSeason.boundingBox();
      if (!activeBox || !inactiveBox) {
        throw new Error('bounding box not found');
      }
      // 選択状態で幾何（黄金比の余白・行送り）が変わらないこと
      expect(Math.abs(activeBox.height - inactiveBox.height)).toBeLessThanOrEqual(1);
    });

    test('KPIカードの目標編集ボタンが iconOnly の正方形 Button である', async ({ page }) => {
      // FREQ-214-AC-03
      await openKpi(page);

      const editButton = page.getByRole('button', { name: 'CVRの目標を編集' });
      await expect(editButton).toBeVisible();
      await expect(editButton).toHaveAttribute('data-ui-button', 'true');
      await expect(editButton).toHaveAttribute('data-ui-button-icon-only', 'true');

      const box = await editButton.boundingBox();
      if (!box) {
        throw new Error('bounding box not found');
      }
      expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);

      // 保存・キャンセルも同じ寸法の iconOnly Button
      await editButton.click();
      const saveButton = page.getByRole('button', { name: '目標を保存' });
      const cancelButton = page.getByRole('button', { name: '編集をキャンセル' });
      await expect(saveButton).toHaveAttribute('data-ui-button-icon-only', 'true');
      await expect(cancelButton).toHaveAttribute('data-ui-button-icon-only', 'true');

      const saveBox = await saveButton.boundingBox();
      if (!saveBox) {
        throw new Error('bounding box not found');
      }
      expect(Math.abs(saveBox.width - saveBox.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(saveBox.height - box.height)).toBeLessThanOrEqual(1);
    });

    test('粒度ボタンが Button で揃い、横スクロールしない', async ({ page }) => {
      // FREQ-214-AC-04（対象年プルダウンは FREQ-217 で廃止）
      await openKpi(page);
      await page.getByRole('tab', { name: '過去推移' }).click();
      await page.getByRole('button', { name: '月', exact: true }).click();

      for (const name of ['年度', 'シーズン', '月']) {
        await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('data-ui-button', 'true');
      }

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
