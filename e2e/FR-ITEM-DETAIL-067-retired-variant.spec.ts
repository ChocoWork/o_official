import { expect, test } from '@playwright/test';
import { mockOtpAuthentication } from './account-test-utils';
import { withReadyProgress } from './order-detail-fixtures';
import { withLocalDb } from './order-email-test-utils';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { uniqueSuffix } from '../tests/integration/db/helpers/order-fixtures';

// FREQ-517: 商品から外した色・サイズの組み合わせは止まり、どこからも買えない。
// 手元の DB の見本の商品4（Nagi Cotton Shirt・色 Clay・サイズ 1。ほかの E2E が使わない商品）に、試験だけの色を足してから外す。
// 外すのは本物の道（items.colors の書き換え → items のトリガー → 同期の関数）。外した後に在庫を入れ、止めた組み合わせの在庫が
// 「在庫あり」の判定に入らないことも見る。試験の色の行と組み合わせは消さない（止めたまま残る。消さないのが今回の決まり）。
const ITEM_ID = 4;
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

type ColorOption = { name: string; hex: string };

async function publishedColors(db: PgClient): Promise<ColorOption[]> {
  const original = await db.query('select colors from public.items where id = $1 and status = $2', [ITEM_ID, 'published']);
  if (original.rowCount !== 1) throw new Error('見本の公開中の商品4が無い');
  return original.rows[0].colors as ColorOption[];
}

async function setColors(db: PgClient, colors: ColorOption[]): Promise<void> {
  await db.query('update public.items set colors = $2::jsonb where id = $1', [ITEM_ID, JSON.stringify(colors)]);
}

async function retireTemporaryColor(
  db: PgClient,
  originalColors: ColorOption[],
  label: string,
): Promise<{ colorName: string; variantId: number }> {
  const colorName = `K4-${label}-${uniqueSuffix()}`;

  // 色を足すと、トリガーがその色の組み合わせを作る
  await setColors(db, [...originalColors, { name: colorName, hex: '#123456' }]);
  const variant = await db.query(
    `select v.id from public.item_variants v
     join public.item_colors c on c.id = v.color_id
     where v.item_id = $1 and c.name = $2`,
    [ITEM_ID, colorName],
  );
  if (variant.rowCount !== 1) throw new Error('足した色の組み合わせが作られていない');
  const variantId = Number(variant.rows[0].id);

  // 色を外す（元の色に戻す）。その色の組み合わせが止まる
  await setColors(db, originalColors);
  // 止めた後に在庫を入れる（止めた組み合わせの在庫は「在庫あり」に数えない）
  await db.query(
    `insert into public.stock_movements (variant_id, delta, reason, note) values ($1, 2, 'restock', 'FR-ITEM-DETAIL-067')`,
    [variantId],
  );
  const state = await db.query('select is_active from public.item_variants where id = $1', [variantId]);
  expect(state.rows[0].is_active).toBe(false);
  return { colorName, variantId };
}

test.describe('FR-ITEM-DETAIL-067 商品から外した色・サイズの組み合わせを止める', () => {
  // 同じ見本の商品の色を書き換えるので、3つの画面幅を順番に流す。
  test.describe.configure({ mode: 'serial' });
  test.use({ trace: 'off' });

  for (const viewport of viewports) {
    test(`FREQ-517-AC-01・FREQ-517-AC-02: 外した色は商品の詳細に出ず、再度購入では断られる (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const originalColors = await withLocalDb(publishedColors);
      try {
        const { colorName, variantId } = await withLocalDb((db) => retireTemporaryColor(db, originalColors, viewport.name));

        // 公開の窓口: 止めた組み合わせは組み合わせの一覧にも「在庫あり」の判定にも入らない
        const api = await page.request.get(`/api/items/${ITEM_ID}`);
        expect(api.status()).toBe(200);
        const body = await api.json();
        expect(body.madeToOrder).toBe(true);
        expect(body.variantAvailability.map((entry: { variantId: number }) => entry.variantId)).not.toContain(variantId);

        // 商品の詳細: 外した色は選びに出ない。残った色の納期は受注生産のまま
        await page.goto(`/item/${ITEM_ID}`);
        await expect(page.locator('[aria-label="Clay"]').first()).toBeAttached();
        await expect(page.locator(`[aria-label="${colorName}"]`)).toHaveCount(0);
        await expect(page.getByTestId('delivery-note').first()).toHaveText('受注生産・数週間〜2ヶ月');

        // 再度購入: 注文の明細の組み合わせが止まっているので、カートに入らず既存の文が出る
        await mockOtpAuthentication(page);
        await page.route('**/api/orders/order-k4-retired', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
              withReadyProgress({
                id: 'order-k4-retired',
                orderNumber: 'ORD-K4RETIRE',
                orderDate: '2026/10/01 09:00',
                status: 'paid',
                subtotalAmount: '¥24,800',
                shippingAmount: '無料',
                discountAmount: '¥0',
                totalAmount: '¥24,800',
                paymentMethod: 'クレジットカード',
                shippingFullName: '山田 花子',
                shippingEmail: 'user@example.com',
                shippingPhone: '090-1111-2222',
                shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
                items: [
                  {
                    id: 'line-k4',
                    itemId: ITEM_ID,
                    variantId,
                    name: 'Nagi Cotton Shirt',
                    imageUrl: null,
                    color: colorName,
                    size: '1',
                    quantity: 1,
                    amount: '¥24,800',
                    stockStatus: 'in_stock',
                  },
                ],
              }),
            ),
          });
        });
        const addResponse = page.waitForResponse(
          (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/cart/add',
        );
        await page.goto('/account/orders/order-k4-retired');
        await page.getByRole('button', { name: '再度購入' }).click();
        expect((await addResponse).status()).toBe(404);
        await expect(page.getByText('この商品は現在お求めいただけません。')).toBeVisible();
        await expect(page.getByText('カートに追加しました')).toHaveCount(0);
      } finally {
        // 途中で落ちても、見本の商品の色は元に戻す（足した色の組み合わせは止まったまま残る）
        await withLocalDb((db) => setColors(db, originalColors));
      }
    });
  }
});
