import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-399: 商品編集画面で、色 × サイズごとの在庫を台帳経由で入れられるようにする。
// 在庫の正はバリアント。画面から直接 item_variants を書き換えず、必ず台帳への追記を送る。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ITEM_ID = '7';

type VariantState = {
  id: number;
  colorName: string;
  colorHex: string;
  sizeLabel: string;
  stockQuantity: number;
  isActive: boolean;
  backorderQuantity: number;
};

type MovementState = {
  id: number;
  variant_id: number;
  delta: number;
  reason: string;
  note: string | null;
  created_at: string;
};

async function mockAdminApis(
  page: Page,
  options: { movementStatus?: number; movementError?: string } = {},
): Promise<void> {
  await mockAdminBackgroundApis(page);

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );

  await page.route('**/api/admin/item-color-presets**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );

  await page.route(`**/api/admin/items/${ITEM_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: Number(ITEM_ID),
          name: 'リネンシャツ',
          description: '説明',
          price: 28000,
          category: 'TOPS',
          colors: [{ name: 'BLACK', hex: '#000000' }],
          sizes: ['M', 'L'],
          material: '',
          origin: '',
          care: '',
          product_note: '',
          status: 'published',
          image_url: null,
          image_urls: [],
        },
      }),
    }),
  );

  // サーバ側の状態を画面から動かせるよう、モック内に持つ。
  const variants: VariantState[] = [
    { id: 11, colorName: 'BLACK', colorHex: '#000000', sizeLabel: 'M', stockQuantity: 4, isActive: true, backorderQuantity: 2 },
    { id: 12, colorName: 'BLACK', colorHex: '#000000', sizeLabel: 'L', stockQuantity: 0, isActive: true, backorderQuantity: 0 },
  ];
  const movements: MovementState[] = [
    { id: 5, variant_id: 11, delta: 4, reason: 'restock', note: '初回入荷', created_at: '2026-09-20T01:00:00Z' },
  ];
  let nextMovementId = 6;

  await page.route(`**/api/admin/items/${ITEM_ID}/variants`, async (route) => {
    if (route.request().method() === 'POST') {
      if (options.movementStatus && options.movementStatus !== 201) {
        await route.fulfill({
          status: options.movementStatus,
          contentType: 'application/json',
          body: JSON.stringify({ error: options.movementError ?? 'error' }),
        });
        return;
      }

      const body = route.request().postDataJSON() as { variantId: number; delta: number; reason: string; note?: string };
      const target = variants.find((variant) => variant.id === body.variantId);
      if (target) {
        target.stockQuantity += body.delta;
      }
      movements.unshift({
        id: nextMovementId++,
        variant_id: body.variantId,
        delta: body.delta,
        reason: body.reason,
        note: body.note ?? null,
        created_at: '2026-09-21T02:00:00Z',
      });
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ variants, movements }),
    });
  });
}

/** 指定した色 × サイズの行。 */
function variantRow(page: Page, label: string) {
  return page.getByTestId(`variant-row-${label}`);
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}（${viewport.width}px）`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-399-AC-01: 色・サイズ・在庫数・受注生産の受注数が出る', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const row = variantRow(page, '11');
      await expect(row).toBeVisible();
      await expect(row.getByTestId('variant-color')).toHaveText('BLACK');
      await expect(row.getByTestId('variant-size')).toHaveText('M');
      await expect(row.getByTestId('variant-stock')).toHaveText('4');
      await expect(row.getByTestId('variant-backorder')).toHaveText('2');

      await expect(variantRow(page, '12').getByTestId('variant-stock')).toHaveText('0');
    });

    test('FREQ-399-AC-02: 入荷を記録すると在庫数が増える', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const row = variantRow(page, '12');
      await row.getByTestId('variant-delta').fill('3');
      await row.getByTestId('variant-submit').click();

      await expect(row.getByTestId('variant-stock')).toHaveText('3');
    });

    test('FREQ-399-AC-03: 在庫を超える引き落としは断られ、在庫が変わらない', async ({ page }) => {
      await mockAdminApis(page, {
        movementStatus: 409,
        movementError: '在庫が足りないため、この数量は引けません。',
      });
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const row = variantRow(page, '11');
      await row.getByTestId('variant-reason').selectOption('adjustment');
      await row.getByTestId('variant-delta').fill('-99');
      await row.getByTestId('variant-submit').click();

      await expect(page.getByTestId('variant-stock-error')).toContainText('在庫が足りない');
      await expect(row.getByTestId('variant-stock')).toHaveText('4');
    });

    test('FREQ-399-AC-04: 履歴が理由と増減つきで新しい順に出る', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      await expect(page.getByTestId('stock-movement-row').first()).toContainText('入荷');

      const row = variantRow(page, '11');
      await row.getByTestId('variant-reason').selectOption('adjustment');
      await row.getByTestId('variant-delta').fill('-1');
      await row.getByTestId('variant-submit').click();

      const first = page.getByTestId('stock-movement-row').first();
      await expect(first).toContainText('棚卸調整');
      await expect(first).toContainText('-1');
    });

    test('FREQ-399-AC-05: 横スクロールが出ない', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);
      await expect(variantRow(page, '11')).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
