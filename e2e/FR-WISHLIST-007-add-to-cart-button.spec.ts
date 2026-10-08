import { expect, test, type Page } from '@playwright/test';
import { CART_OPTION_NAMES } from '../src/features/cart/types/cart-json';

type PublicItemDetail = {
  id: number;
  name: string;
  colors?: Array<{ name: string; hex: string }> | string[];
  sizes?: string[];
  stock_quantity?: number | null;
};

async function clearSessionCollections(page: Page) {
  await page.goto('/wishlist');
  await page.waitForLoadState('networkidle').catch(() => undefined);

  await page.evaluate(async () => {
    // カートの窓口に削除は無い。カート全体（CartJson）の明細を、key を指して数量0に変えて消す（POST /api/cart/change）
    const clearCart = async () => {
      const response = await fetch('/api/cart');
      if (!response.ok) {
        return;
      }

      const cart = (await response.json()) as { items?: Array<{ key?: unknown }> };
      await Promise.all(
        (cart.items ?? [])
          .filter((line) => typeof line.key === 'string')
          .map((line) =>
            fetch('/api/cart/change', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: line.key, quantity: 0 }),
            })
          )
      );
    };

    const clearWishlist = async () => {
      const response = await fetch('/api/wishlist');
      if (!response.ok) {
        return;
      }

      const items = await response.json();
      if (!Array.isArray(items)) {
        return;
      }

      await Promise.all(
        items
          .filter((item) => item && typeof item.id === 'string')
          .map((item) => fetch(`/api/wishlist/${item.id}`, { method: 'DELETE' }))
      );
    };

    await clearCart();
    await clearWishlist();
  });
}

async function findMergeableItem(page: Page): Promise<PublicItemDetail | null> {
  for (let id = 1; id <= 50; id += 1) {
    const detailResponse = await page.request.get(`/api/items/${id}`);
    if (!detailResponse.ok()) {
      continue;
    }

    const detail = (await detailResponse.json()) as PublicItemDetail;
    const sizes = Array.isArray(detail.sizes) ? detail.sizes : [];
    const colors = Array.isArray(detail.colors) ? detail.colors : [];
    const stockQuantity = detail.stock_quantity;

    if (stockQuantity === 0) {
      continue;
    }

    if (sizes.length <= 1 && colors.length <= 1) {
      return detail;
    }
  }

  return null;
}

test.describe('FR-WISHLIST-007 カートに追加ボタン', () => {
  test('カードにカート追加ボタンがある', async ({ page }) => {
    await page.goto('/wishlist');

    const addToCartButton = page.getByRole('button', { name: 'ADD TO CART', exact: true }).first();
    const visible = await addToCartButton.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    await expect(addToCartButton).toBeEnabled();
  });

  test('wishlist からのカート追加は商品詳細と同じ color と size を送る', async ({ page }) => {
    // お気に入りの窓口は、各行に販売中のバリアント（番号・色・サイズ）を添える。
    // カードのカートに入れるボタンは、色・サイズが決まった商品の、その組み合わせのバリアントの番号を送る
    const blackFreeVariantId = 7101;
    await page.route('**/api/wishlist', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'wish-1',
            item_id: 101,
            added_at: '2026-04-15T00:00:00.000Z',
            items: {
              id: 101,
              name: 'Short Sleeveless Vest',
              price: 24800,
              image_url: '/images/test-item.jpg',
              category: 'TOPS',
              colors: [{ name: 'BLACK', hex: '#000000' }],
              sizes: ['FREE'],
            },
            variants: [{ id: blackFreeVariantId, color: 'BLACK', size: 'FREE' }],
          },
        ]),
      });
    });

    let cartRequestBody: Record<string, unknown> | null = null;
    await page.route('**/api/cart/add', async (route) => {
      cartRequestBody = route.request().postDataJSON() as Record<string, unknown>;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    });

    await page.goto('/wishlist');
    await page.getByRole('button', { name: 'ADD TO CART', exact: true }).click();

    await expect.poll(() => cartRequestBody).not.toBeNull();
    expect(cartRequestBody).toEqual({ items: [{ id: blackFreeVariantId, quantity: 1 }] });
  });

  test('実データで商品詳細追加後に wishlist から追加しても cart は1行に統合される', async ({ page }) => {
    await clearSessionCollections(page);

    const item = await findMergeableItem(page);
    test.skip(!item, '統合検証に使える公開商品がないためスキップ');

    const expectedColor = Array.isArray(item!.colors) && item!.colors.length > 0
      ? typeof item!.colors[0] === 'string'
        ? item!.colors[0]
        : item!.colors[0].name
      : null;
    const expectedSize = Array.isArray(item!.sizes) && item!.sizes.length === 1 ? item!.sizes[0] : null;

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle').catch(() => undefined);

    await page.getByRole('button', { name: 'Add to wishlist' }).click();
    await expect.poll(async () => {
      return page.evaluate(async (itemId) => {
        const response = await fetch('/api/wishlist');
        if (!response.ok) {
          return false;
        }

        const wishlistItems = await response.json();
        return Array.isArray(wishlistItems) && wishlistItems.some((entry) => entry.item_id === itemId);
      }, item!.id);
    }).toBeTruthy();

    await page.getByText('ADD TO CART').first().click();

    // 実のカートの窓口（GET /api/cart）はカート全体（CartJson）を返す。この商品の明細は items の product_id で絞る
    await expect.poll(async () => {
      return page.evaluate(async (itemId) => {
        const response = await fetch('/api/cart');
        if (!response.ok) {
          return 0;
        }

        const cart = (await response.json()) as { items?: Array<{ product_id: number; quantity: number }> };
        return (cart.items ?? [])
          .filter((line) => line.product_id === itemId)
          .reduce((sum, line) => sum + Number(line.quantity ?? 0), 0);
      }, item!.id);
    }).toBe(1);

    await page.goto('/wishlist');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.getByRole('button', { name: 'ADD TO CART', exact: true }).first().click();

    await expect.poll(async () => {
      return page.evaluate(async ({ itemId, optionNames }) => {
        const response = await fetch('/api/cart');
        if (!response.ok) {
          return { rowCount: 0, quantity: 0, color: null, size: null };
        }

        const cart = (await response.json()) as {
          items?: Array<{
            product_id: number;
            quantity: number;
            options_with_values: Array<{ name: string; value: string }>;
          }>;
        };
        const matchingRows = (cart.items ?? []).filter((line) => line.product_id === itemId);
        // 色・サイズは明細の options_with_values に、オプション名（カラー・サイズ）と値の組で入っている
        const optionOf = (name: string) =>
          matchingRows[0]?.options_with_values.find((option) => option.name === name)?.value ?? null;
        return {
          rowCount: matchingRows.length,
          quantity: matchingRows.reduce((sum, line) => sum + Number(line.quantity ?? 0), 0),
          color: optionOf(optionNames.color),
          size: optionOf(optionNames.size),
        };
      }, { itemId: item!.id, optionNames: CART_OPTION_NAMES });
    }).toEqual({
      rowCount: 1,
      quantity: 2,
      color: expectedColor,
      size: expectedSize,
    });

    await page.goto('/cart');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await expect(page.getByRole('heading', { name: item!.name })).toHaveCount(1);
  });
});
