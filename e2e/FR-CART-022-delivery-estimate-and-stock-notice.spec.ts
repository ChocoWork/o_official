import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FR-CART-022 カートのお届けの目安と、在庫の変化の案内
 * 対応 FREQ: FREQ-417（AC-01 / AC-02）
 *
 * 目安の判定（在庫の数と数量）はサーバーの単体テストと DB の結合テストで確かめる。ここは画面の出し方を見る。
 * AC-02 の「注文する」から戻る流れは FR-CHECKOUT-038 で確かめる。ここは受け渡しの値から出し方を見る。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const STOCK_NOTICE =
  '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）';

async function setupCart(page: Page): Promise<void> {
  await mockCartApis(page, [
    sampleCartItem({ fulfillment: 'stock' }),
    sampleCartItem({
      id: 'cart-2',
      item_id: 202,
      quantity: 2,
      color: 'Ivory',
      size: 'S',
      fulfillment: 'backorder',
      items: { id: 202, name: 'Tailored Pants', price: 18000, image_url: '/images/test-item-2.jpg', category: 'BOTTOMS' },
    }),
  ]);
}

function itemRows(page: Page) {
  return page.locator('div.border-b.flex').filter({ has: page.locator('input[type="number"]') });
}

test.describe('FR-CART-022 カートのお届けの目安と在庫の変化の案内', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）明細ごとにお届けの目安が出る`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await setupCart(page);
      await page.goto('/cart');

      // FREQ-417-AC-01
      await expect(itemRows(page)).toHaveCount(2);
      await expect(itemRows(page).nth(0).getByTestId('cart-fulfillment')).toHaveText('在庫あり・3〜7営業日で発送');
      await expect(itemRows(page).nth(1).getByTestId('cart-fulfillment')).toHaveText('受注生産・数週間〜2か月以上');
      await expect(page.getByTestId('cart-stock-changed')).toHaveCount(0);
    });

    test(`${viewport.name}（${viewport.width}px）在庫の変化で断られた後は、案内と変わった商品が出て、その行にだけ印が付く`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await setupCart(page);
      await page.goto('/');
      await page.evaluate((message) => {
        window.sessionStorage.setItem(
          'checkout:cart-notice',
          JSON.stringify({
            kind: 'stock_changed',
            message,
            lines: [{ itemId: 202, name: 'Tailored Pants', color: 'Ivory', size: 'S' }],
          }),
        );
      }, STOCK_NOTICE);
      await page.goto('/cart');

      // FREQ-417-AC-02
      const notice = page.getByTestId('cart-notice');
      await expect(notice).toContainText(STOCK_NOTICE);
      await expect(notice).toContainText('Tailored Pants（Ivory / S）');
      await expect(itemRows(page).nth(1).getByTestId('cart-stock-changed')).toHaveText('在庫あり → 受注生産');
      await expect(itemRows(page).nth(0).getByTestId('cart-stock-changed')).toHaveCount(0);

      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(hasHorizontalOverflow).toBe(false);

      // 案内は1回だけ。読み込み直すと消える
      await page.reload();
      await expect(itemRows(page)).toHaveCount(2);
      await expect(page.getByTestId('cart-notice')).not.toContainText(STOCK_NOTICE);
    });
  }
});
