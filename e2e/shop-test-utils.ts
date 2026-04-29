import { expect, Page } from '@playwright/test';

export type MockCartItem = {
  id: string;
  item_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
  added_at: string;
  items: {
    id: number;
    name: string;
    price: number;
    image_url: string;
    category: string;
  } | null;
};

export type MockWishlistItem = {
  id: string;
  item_id: number;
  added_at: string;
  items: {
    id: number;
    name: string;
    price: number;
    image_url: string;
    category: string;
    colors?: Array<{ hex: string; name: string }> | string[];
    sizes?: string[];
  } | null;
};

export type MockItemDetail = {
  id: number;
  name: string;
  price: number;
  description: string;
  category: string;
  image_url: string;
  image_urls: string[];
  colors: Array<{ hex: string; name: string }>;
  sizes: string[];
  product_details: string[];
  stockStatus?: 'in_stock' | 'low_stock' | 'sold_out' | 'unknown';
  stock_quantity?: number | null;
};

export const sampleCartItem = (overrides: Partial<MockCartItem> = {}): MockCartItem => ({
  id: 'cart-1',
  item_id: 101,
  quantity: 1,
  color: 'Black',
  size: 'M',
  added_at: '2026-04-18T00:00:00.000Z',
  items: {
    id: 101,
    name: 'Silk Blouse',
    price: 12000,
    image_url: '/images/test-item.jpg',
    category: 'TOPS',
  },
  ...overrides,
});

export const sampleWishlistItem = (
  overrides: Partial<MockWishlistItem> = {},
): MockWishlistItem => ({
  id: 'wishlist-1',
  item_id: 101,
  added_at: '2026-04-18T00:00:00.000Z',
  items: {
    id: 101,
    name: 'Silk Blouse',
    price: 12000,
    image_url: '/images/test-item.jpg',
    category: 'TOPS',
    colors: [{ hex: '#000000', name: 'Black' }],
    sizes: ['M'],
  },
  ...overrides,
});

export const sampleItemDetail = (
  overrides: Partial<MockItemDetail> = {},
): MockItemDetail => ({
  id: 101,
  name: 'Silk Blouse',
  price: 12000,
  description: 'Signature silk blouse for all seasons.',
  category: 'TOPS',
  image_url: '/images/test-item.jpg',
  image_urls: [
    '/images/test-item.jpg',
    '/images/test-item-2.jpg',
    '/images/test-item-3.jpg',
  ],
  colors: [
    { hex: '#000000', name: 'Black' },
    { hex: '#f5f5f5', name: 'Ivory' },
  ],
  sizes: ['S', 'M'],
  product_details: ['Silk 100%', 'Made in Japan'],
  stockStatus: 'low_stock',
  ...overrides,
});

export async function mockCartApis(
  page: Page,
  initialItems: MockCartItem[],
): Promise<{
  patchBodies: Array<{ id: string; quantity: number }>;
  deleteIds: string[];
  postBodies: Array<Record<string, unknown>>;
}> {
  let cartItems = [...initialItems];
  const patchBodies: Array<{ id: string; quantity: number }> = [];
  const deleteIds: string[] = [];
  const postBodies: Array<Record<string, unknown>> = [];

  await page.route('**/api/cart', async (route) => {
    const request = route.request();

    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cartItems),
      });
      return;
    }

    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      postBodies.push(body);
      const nextItem = sampleCartItem({
        id: `cart-${cartItems.length + 1}`,
        item_id: Number(body.item_id ?? 101),
        quantity: Number(body.quantity ?? 1),
        color: typeof body.color === 'string' ? body.color : null,
        size: typeof body.size === 'string' ? body.size : null,
        items: {
          id: Number(body.item_id ?? 101),
          name: 'Silk Blouse',
          price: 12000,
          image_url: '/images/test-item.jpg',
          category: 'TOPS',
        },
      });
      cartItems = [...cartItems, nextItem];
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(nextItem),
      });
      return;
    }

    await route.fallback();
  });

  await page.route('**/api/cart/*', async (route) => {
    const request = route.request();
    const id = request.url().split('/').pop() ?? '';

    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as { quantity?: number };
      const quantity = Number(body.quantity ?? 1);
      patchBodies.push({ id, quantity });
      cartItems = cartItems.map((item) => (item.id === id ? { ...item, quantity } : item));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id, quantity }),
      });
      return;
    }

    if (request.method() === 'DELETE') {
      deleteIds.push(id);
      cartItems = cartItems.filter((item) => item.id !== id);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
      return;
    }

    await route.fallback();
  });

  return { patchBodies, deleteIds, postBodies };
}

export async function mockWishlistApis(
  page: Page,
  initialItems: MockWishlistItem[],
): Promise<{
  deleteIds: string[];
}> {
  let wishlistItems = [...initialItems];
  const deleteIds: string[] = [];

  await page.route('**/api/wishlist', async (route) => {
    const request = route.request();

    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(wishlistItems),
      });
      return;
    }

    await route.fallback();
  });

  await page.route('**/api/wishlist/*', async (route) => {
    const request = route.request();
    const id = request.url().split('/').pop() ?? '';

    if (request.method() === 'DELETE') {
      deleteIds.push(id);
      wishlistItems = wishlistItems.filter((item) => item.id !== id);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
      return;
    }

    await route.fallback();
  });

  return { deleteIds };
}

export async function mockItemDetailApis(
  page: Page,
  item: MockItemDetail,
  relatedItems: Array<{ id: number; name: string; price: number; image_url: string; category: string }>,
): Promise<void> {
  await page.route(`**/api/items/${item.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(item),
    });
  });

  await page.route('**/api/items?*', async (route) => {
    const requestUrl = new URL(route.request().url());
    const pageSize = requestUrl.searchParams.get('pageSize');
    const category = requestUrl.searchParams.get('category');

    if (pageSize === '5' && category === item.category) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [item, ...relatedItems] }),
      });
      return;
    }

    await route.fallback();
  });
}

export async function seedSupabaseSession(page: Page, role: 'admin' | 'supporter' | 'user'): Promise<void> {
  await page.addInitScript((sessionRole) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    window.localStorage.setItem(
      'supabase.auth.token',
      JSON.stringify({
        currentSession: {
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: expiresAt,
          user: {
            id: 'test-user-id',
            email: 'admin@example.com',
            app_metadata: { role: sessionRole },
            user_metadata: { display_name: 'Admin User' },
            aud: 'authenticated',
          },
        },
      }),
    );
  }, role);
}

export async function expectCartBadge(page: Page, count: number): Promise<void> {
  await expect(page.locator('a[href="/cart"] span').filter({ hasText: String(count) })).toBeVisible();
}