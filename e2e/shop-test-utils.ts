import { expect, Page } from '@playwright/test';

export type MockCartItem = {
  id: string;
  item_id: number;
  /** バリアントの番号。カートの窓口は色・サイズではなくこの番号で明細を指す */
  variant_id?: number;
  quantity: number;
  color: string | null;
  size: string | null;
  added_at: string;
  fulfillment?: 'stock' | 'backorder' | null;
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
  /** カートに入れられる（販売中の）バリアント。お気に入りの画面はこの番号を /api/cart/add へ送る */
  variants: Array<{ id: number; color: string | null; size: string | null }>;
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
  material?: string | null;
  care?: string | null;
  origin?: string | null;
  product_note?: string | null;
  stockStatus?: 'in_stock' | 'low_stock' | 'sold_out' | 'unknown';
  stock_quantity?: number | null;
  /** すぐ出せる在庫がある組み合わせが1つも無い（FREQ-400） */
  madeToOrder?: boolean;
  /** 色 × サイズごとの在庫の有無。残数は含めない（FREQ-400） */
  variantAvailability?: Array<{
    colorName: string | null;
    sizeLabel: string | null;
    inStock: boolean;
    /** バリアントの番号。カートに入れる窓口（/api/cart/add）へ送る */
    variantId: number;
  }>;
};

export const sampleCartItem = (overrides: Partial<MockCartItem> = {}): MockCartItem => ({
  id: 'cart-1',
  item_id: 101,
  variant_id: 1012,
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
  // 既定の色・サイズ（Black / M）に合わせる。画面が選ぶバリアントはこの中から探すので、合わないと入れられない
  variants: [{ id: 1012, color: 'Black', size: 'M' }],
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
  // 既定の色 × サイズ（Black・Ivory × S・M）の全組み合わせ。商品詳細は選んだ色・サイズの variantId を
  // /api/cart/add へ送るので、組み合わせが無いと「現在お求めいただけません」になり、カートに入れられない
  variantAvailability: [
    { colorName: 'Black', sizeLabel: 'S', inStock: true, variantId: 1011 },
    { colorName: 'Black', sizeLabel: 'M', inStock: true, variantId: 1012 },
    { colorName: 'Ivory', sizeLabel: 'S', inStock: true, variantId: 1021 },
    { colorName: 'Ivory', sizeLabel: 'M', inStock: true, variantId: 1022 },
  ],
  ...overrides,
});

/** 明細1行。サーバーの CartJsonLine（src/features/cart/types/cart-json.ts）と同じ形にする */
function toCartJsonLine(item: MockCartItem) {
  const price = item.items?.price ?? 0;
  const variantTitle = [item.color, item.size].filter((value): value is string => Boolean(value)).join(' / ') || null;
  const name = item.items?.name ?? '';
  return {
    key: item.id,
    id: item.variant_id ?? item.item_id,
    variant_id: item.variant_id ?? item.item_id,
    product_id: item.item_id,
    quantity: item.quantity,
    title: variantTitle ? `${name} - ${variantTitle}` : name,
    product_title: name,
    variant_title: variantTitle,
    options_with_values: [
      ...(item.color ? [{ name: 'カラー', value: item.color }] : []),
      ...(item.size ? [{ name: 'サイズ', value: item.size }] : []),
    ],
    price,
    line_price: price * item.quantity,
    image: item.items?.image_url ?? null,
    url: `/item/${item.item_id}`,
    fulfillment: item.fulfillment ?? null,
  };
}

/** GET /api/cart の応答（カート全体）。カートを直接真似る spec も、同じ形をここから作る */
export function toCartJson(items: MockCartItem[]) {
  // 非公開・削除の商品（items: null）は新しい窓口が返さないので、真似る時も出さない
  const lines = items.filter((item) => item.items !== null).map(toCartJsonLine);
  const subtotal = lines.reduce((sum, line) => sum + line.line_price, 0);
  return {
    item_count: lines.reduce((sum, line) => sum + line.quantity, 0),
    currency: 'JPY',
    items_subtotal_price: subtotal,
    total_price: subtotal,
    items: lines,
  };
}

/**
 * カートの窓口（Shopify の Ajax Cart API の形）を真似る。
 * GET /api/cart はカート全体、POST /api/cart/add はバリアントの番号と数量、POST /api/cart/change は
 * 明細の key と数量（0 で削除）。戻り値の記録は、patchBodies が数量1以上の変更、deleteIds が数量0の変更
 * （削除した明細の key）、postBodies が /api/cart/add に送られた本文そのまま。
 */
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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toCartJson(cartItems)) });
  });

  await page.route('**/api/cart/add', async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { items?: Array<{ id: number; quantity: number }> };
    postBodies.push(body as Record<string, unknown>);
    const added = (body.items ?? []).map(({ id, quantity }) => {
      const existing = cartItems.find((item) => (item.variant_id ?? item.item_id) === id);
      if (existing) {
        existing.quantity += quantity;
        return existing;
      }
      const created = sampleCartItem({ id: `cart-added-${cartItems.length + 1}`, variant_id: id, quantity });
      cartItems = [...cartItems, created];
      return created;
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: added.map(toCartJsonLine) }) });
  });

  await page.route('**/api/cart/change', async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { id: string; quantity: number };
    if (body.quantity === 0) {
      deleteIds.push(body.id);
      cartItems = cartItems.filter((item) => item.id !== body.id);
    } else {
      patchBodies.push({ id: body.id, quantity: body.quantity });
      cartItems = cartItems.map((item) => (item.id === body.id ? { ...item, quantity: body.quantity } : item));
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toCartJson(cartItems)) });
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
  await expect(page.locator('a[href="/cart"] span.absolute', { hasText: String(count) })).toBeVisible();
}
