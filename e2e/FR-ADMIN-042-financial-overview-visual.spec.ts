import { test, expect, Page } from '@playwright/test';

// FREQ-254: 財務概要の見た目（角丸・状態色）。
// 面は Panel（--radius-md 8px）、内側の枠は --radius-sm（6px）、
// 状態は色で示す（正常＝緑・要対応＝橙・マイナス＝赤）。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

function metric(period: string) {
  return {
    period,
    salesAmount: 0, formattedSales: '¥0',
    cvr: 0, formattedCvr: '0.0%',
    aov: 0, formattedAov: '¥0',
    setPurchaseRate: 0, formattedSetPurchaseRate: '0.0%',
    inventoryConsumptionRate: 0, formattedInventoryConsumptionRate: '0.0%',
    ltv: 0, formattedLtv: '¥0',
    repeatRate: 0, formattedRepeatRate: '0.0%',
    returnRate: 0, formattedReturnRate: '0.0%',
    orderCount: 0, paidOrderCount: 0, customerCount: 0, repeatCustomerCount: 0,
    setOrderCount: 0, cancelledOrderCount: 0, soldItemCount: 0, publishedItemCount: 0,
  };
}

// 掛け売上を混ぜて「未入金」のアクションを必ず1件出す（要対応バッジの色を見るため）。
const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-03-10', category: '仕入高', item: '生地仕入',
    partner: '生地仕入先C', amount: 400000, paymentMethod: '現金', memo: '', seasonTag: null, receipts: [],
  },
];

const INCOMES = [
  {
    id: 11, entryType: 'income', date: '2026-02-15', category: '売上高', item: '商品売上',
    partner: '得意先A', amount: 1000000, paymentMethod: '現金', memo: '', seasonTag: null, receipts: [],
  },
  {
    id: 12, entryType: 'income', date: '2026-02-20', category: '売上高', item: '卸売',
    partner: '得意先B', amount: 300000, paymentMethod: '売掛金', memo: '', seasonTag: null, receipts: [],
  },
];

async function mockAdminApis(page: Page): Promise<void> {
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
          monthlyKpiByYear: [{ year: 2026, metrics: Array.from({ length: 12 }, (_, i) => metric(`${i + 1}月`)) }],
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

  await page.route('**/api/admin/kpi/monthly-record**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { season: '2026SS', monthKeys: [], values: {} } }),
    }),
  );

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    const year = Number(new URL(req.url()).searchParams.get('year'));
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          fiscalYear: year,
          seasonKey: '2026SS',
          businessType: 'soleProprietor',
          plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
          expenses: EXPENSES,
          incomes: INCOMES,
          products: [],
          partners: ['得意先A', '得意先B', '生地仕入先C'],
          templates: [],
          fixedAssets: [],
          closing: {
            closingInventoryGoods: 0, closingInventoryMaterials: 0,
            allowanceForDoubtful: 0, closingBalances: {}, closedAt: null,
          },
          previousClosingBalances: null,
          revisions: [],
          cumulativeEntries: [],
        },
      }),
    });
  });
}

async function openAccounting(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await expect(page.getByText('同期済み')).toBeVisible();
}

/** 計算後スタイルを1つ読む。 */
function styleOf(page: Page, selector: string, prop: string) {
  return page.evaluate(
    ([sel, p]) => {
      const el = document.querySelector(sel as string);
      if (!el) return null;
      return getComputedStyle(el).getPropertyValue(p as string).trim();
    },
    [selector, prop] as const,
  );
}

/** rgb(...) を #rrggbb へ。色の比較を目視値と揃えるため。 */
function toHex(rgb: string | null): string | null {
  if (!rgb) return null;
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return rgb;
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-042 financial overview visual (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('財務概要の面がすべて角丸8pxで描かれる', async ({ page }) => {
      // FREQ-254-AC-01
      await openAccounting(page);

      const radii = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-ui-panel]')).map(
          (el) => getComputedStyle(el).borderTopLeftRadius,
        ),
      );

      expect(radii.length).toBeGreaterThan(8);
      for (const radius of radii) {
        expect(radius).toBe('8px');
      }
    });

    test('面の内側の枠は一段小さい角丸6pxになる', async ({ page }) => {
      // FREQ-254-AC-02
      await openAccounting(page);

      // キャッシュブリッジの各ブロック（期首残高・営業CF…）
      const inner = page
        .getByRole('region', { name: 'キャッシュブリッジ' })
        .getByText('期首残高')
        .locator('..');
      await expect(inner).toHaveCSS('border-top-left-radius', '6px');
    });

    test('面は白、枠線は薄いグレー1pxで統一される', async ({ page }) => {
      // FREQ-254-AC-03
      await openAccounting(page);

      const panel = page.getByRole('region', { name: '資金推移' });
      await expect(panel).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(panel).toHaveCSS('border-top-width', '1px');
      await expect(panel).toHaveCSS('border-top-color', 'rgb(212, 212, 212)');
    });

    test('要対応バッジが橙、検算一致が緑で示される', async ({ page }) => {
      // FREQ-254-AC-04
      await openAccounting(page);

      const badge = page
        .getByRole('region', { name: 'アクション' })
        .getByText('要対応')
        .first();
      await expect(badge).toBeVisible();
      await expect(badge).toHaveCSS('color', 'rgb(180, 83, 9)');
      await expect(badge).toHaveCSS('border-top-left-radius', '8px');

      const verified = page
        .getByRole('region', { name: 'キャッシュブリッジ' })
        .getByText('検算一致');
      await expect(verified).toHaveCSS('color', 'rgb(22, 132, 75)');
    });

    test('同期状態の丸が緑で描かれる', async ({ page }) => {
      // FREQ-254-AC-05
      await openAccounting(page);

      const dot = page.locator('[data-ui-badge-variant="dot"]').first();
      await expect(dot).toHaveCSS('background-color', 'rgb(22, 132, 75)');
      await expect(dot).toHaveCSS('border-top-left-radius', '9999px');
    });

    test('C/Fの増加が緑・減少が赤で示される', async ({ page }) => {
      // FREQ-254-AC-06
      await openAccounting(page);

      const cf = page.getByRole('region', { name: 'キャッシュ・フロー計算書（C/F）' });
      // 営業CF は入金があるので必ずプラス
      await expect(cf.getByText(/^\+¥/).first()).toHaveCSS('color', 'rgb(22, 132, 75)');
      // 仕入の出金があるので投資または営業のいずれかにマイナスが出る
      const negative = cf.getByText(/^-¥/).first();
      if (await negative.count()) {
        await expect(negative).toHaveCSS('color', 'rgb(185, 28, 28)');
      }
    });

    test('月次・通期の切替が黒塗り／角丸で示される', async ({ page }) => {
      // FREQ-254-AC-07
      await openAccounting(page);

      const monthly = page.getByRole('button', { name: '月次' });
      await expect(monthly).toHaveCSS('background-color', 'rgb(0, 0, 0)');
      await expect(monthly).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(monthly).toHaveCSS('border-top-left-radius', '6px');
    });

    test('CSVボタンが角丸の外枠ボタンになる', async ({ page }) => {
      // FREQ-254-AC-08
      await openAccounting(page);

      const csv = page.getByRole('button', { name: '損益計算書CSV' });
      await expect(csv).toHaveCSS('border-top-left-radius', '8px');
      await expect(csv).toHaveCSS('border-top-width', '1px');
    });

    test('財務3表の見出しとCSVボタンが同じ行に並ぶ', async ({ page }) => {
      // FREQ-254-AC-09: 見出しが長い C/F でもボタンが下段へ折り返さない
      await openAccounting(page);

      const cf = page.getByRole('region', { name: 'キャッシュ・フロー計算書（C/F）' });
      const heading = cf.getByRole('heading', { name: 'キャッシュ・フロー計算書（C/F）' });
      const csv = cf.getByRole('button', { name: 'キャッシュフローCSV' });

      const headingBox = await heading.boundingBox();
      const csvBox = await csv.boundingBox();
      expect(headingBox).not.toBeNull();
      expect(csvBox).not.toBeNull();

      // 垂直方向に重なっている＝同じ行
      const overlap =
        Math.min(headingBox!.y + headingBox!.height, csvBox!.y + csvBox!.height)
        - Math.max(headingBox!.y, csvBox!.y);
      expect(overlap).toBeGreaterThan(0);
    });

    test('キャッシュブリッジの期末残高が面からはみ出さない', async ({ page }) => {
      // FREQ-254-AC-10
      await openAccounting(page);

      const panel = page.getByRole('region', { name: 'キャッシュブリッジ' });
      const closing = panel.getByText('期末残高').locator('..');

      const panelBox = await panel.boundingBox();
      const closingBox = await closing.boundingBox();
      expect(panelBox).not.toBeNull();
      expect(closingBox).not.toBeNull();

      expect(closingBox!.x + closingBox!.width).toBeLessThanOrEqual(
        panelBox!.x + panelBox!.width,
      );
    });

    test('年選択・同期状態・更新が同じ高さの角丸で揃う', async ({ page }) => {
      // FREQ-256-AC-01 / AC-02
      await openAccounting(page);

      const year = page.getByRole('button', { name: '会計年' });
      const status = page.getByText('同期済み');
      const update = page.getByRole('button', { name: '更新' });

      const boxes = await Promise.all([
        year.boundingBox(),
        // 状態は StatusBadge。バッジ本体（テキストの親）の箱を測る
        status.locator('xpath=ancestor-or-self::*[@data-ui-badge][1]').boundingBox(),
        update.boundingBox(),
      ]);
      for (const box of boxes) expect(box).not.toBeNull();

      // 高さが揃う（同じ φ 式から導出しているので誤差なし）
      const heights = boxes.map((box) => Math.round(box!.height));
      expect(heights[1]).toBe(heights[0]);
      expect(heights[2]).toBe(heights[0]);

      // 縦位置も揃う
      const tops = boxes.map((box) => Math.round(box!.y));
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);

      // 3つとも同じ角丸
      await expect(year).toHaveCSS('border-top-left-radius', '8px');
      await expect(update).toHaveCSS('border-top-left-radius', '8px');
      await expect(
        status.locator('xpath=ancestor-or-self::*[@data-ui-badge][1]'),
      ).toHaveCSS('border-top-left-radius', '8px');
    });

    test('会計期間は暦年なので「年」表記で、2025年から選べる', async ({ page }) => {
      // FREQ-256-AC-03 / AC-04
      await openAccounting(page);

      const year = page.getByRole('button', { name: '会計年' });
      await expect(page.getByText('2026年', { exact: true })).toBeVisible();
      await expect(page.getByText('2026年度', { exact: true })).toHaveCount(0);

      await year.click();
      await expect(page.getByRole('option', { name: '2025年' })).toBeVisible();
      await expect(page.getByRole('option', { name: '2026年' })).toBeVisible();
      await expect(page.getByRole('option', { name: '2024年' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-254-AC-11
      await openAccounting(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}

// 目視確認用のスクリーンショット。desktop だけ全体を1枚に収める。
test.describe('FR-ADMIN-042 screenshot', () => {
  test('財務概要の全体像', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockAdminApis(page);
    await openAccounting(page);
    await page.screenshot({
      path: 'test-results/financial-overview.png',
      fullPage: true,
    });
    expect(await styleOf(page, '[data-ui-panel]', 'border-radius')).toBe('8px');
    expect(toHex(await styleOf(page, '[data-ui-panel]', 'background-color'))).toBe('#ffffff');
  });
});
