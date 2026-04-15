import { expect, test } from '@playwright/test';

type PublicItemDetail = {
  id: number;
  name: string;
  colors?: Array<{ name: string; hex: string }> | string[];
  sizes?: string[];
  stock_quantity?: number | null;
};

async function clearSessionCollections(page: Parameters<typeof test>[0]['page']) {
  await page.goto('/wishlist');
  await page.waitForLoadState('networkidle').catch(() => undefined);

  await page.evaluate(async () => {
    const clearCollection = async (basePath: string) => {
      const response = await fetch(basePath);
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
          .map((item) => fetch(`${basePath}/${item.id}`, { method: 'DELETE' }))
      );
    };

    await clearCollection('/api/cart');
    await clearCollection('/api/wishlist');
  });
}

async function findMergeableItem(page: Parameters<typeof test>[0]['page']): Promise<PublicItemDetail | null> {
  for (let id = 1; id <= 50; id += 1) {
    const detailResponse = await page.request.get(`/api/items/${id}`);
    if (!detailResponse.ok()) {
      continue;
    }

    const detail = (await detailResponse.json()) as PublicItemDetail;
    const sizes = Array.isArray(detail.sizes) ? detail.sizes : [];
    const stockQuantity = detail.stock_quantity;

    if (stockQuantity === 0) {
      continue;
    }

    if (sizes.length <= 1) {
      return detail;
    }
  }

  return null;
}

test.describe('FR-WISHLIST-007 カートに追加ボタン', () => {
  test('カードにカート追加ボタンがある', async ({ page }) => {
    await page.goto('/wishlist');

    const addToCartButton = page.getByRole('button', { name: 'カートに追加' }).first();
    const visible = await addToCartButton.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    await expect(addToCartButton).toBeEnabled();
  });

  test('wishlist からのカート追加は商品詳細と同じ color と size を送る', async ({ page }) => {
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
          },
        ]),
      });
    });

    let cartRequestBody: Record<string, unknown> | null = null;
    await page.route('**/api/cart', async (route) => {
      if (route.request().method() === 'POST') {
        cartRequestBody = route.request().postDataJSON() as Record<string, unknown>;
      }

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'cart-1', item_id: 101, quantity: 1, color: 'BLACK', size: 'FREE' }),
      });
    });

    await page.goto('/wishlist');
    await page.getByRole('button', { name: 'カートに追加' }).click();

    await expect.poll(() => cartRequestBody).not.toBeNull();
    expect(cartRequestBody).toMatchObject({
      item_id: 101,
      quantity: 1,
      color: 'BLACK',
      size: 'FREE',
    });
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

    await expect.poll(async () => {
      return page.evaluate(async (itemId) => {
        const response = await fetch('/api/cart');
        if (!response.ok) {
          return 0;
        }

        const cartItems = await response.json();
        if (!Array.isArray(cartItems)) {
          return 0;
        }

        return cartItems
          .filter((entry) => entry.item_id === itemId)
          .reduce((sum, entry) => sum + Number(entry.quantity ?? 0), 0);
      }, item!.id);
    }).toBe(1);

    await page.goto('/wishlist');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.getByRole('button', { name: 'カートに追加' }).first().click();

    await expect.poll(async () => {
      return page.evaluate(async ({ itemId, color, size }) => {
        const response = await fetch('/api/cart');
        if (!response.ok) {
          return { rowCount: 0, quantity: 0, color: null, size: null };
        }

        const cartItems = await response.json();
        if (!Array.isArray(cartItems)) {
          return { rowCount: 0, quantity: 0, color: null, size: null };
        }

        const matchingRows = cartItems.filter((entry) => entry.item_id === itemId);
        return {
          rowCount: matchingRows.length,
          quantity: matchingRows.reduce((sum, entry) => sum + Number(entry.quantity ?? 0), 0),
          color: matchingRows[0]?.color ?? null,
          size: matchingRows[0]?.size ?? null,
        };
      }, { itemId: item!.id, color: expectedColor, size: expectedSize });
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
