import { expect, test, type Page } from '@playwright/test';
import { seedCart } from './checkout-flow-helpers';
import { createTestMember, loginAsMember } from './member-session-helpers';

// 会員の確認コードと Cookie が通信記録へ残らないようにする。
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];
type Variant = { variantId: number; colorName: string | null; sizeLabel: string | null };
type Cart = { item_count: number; items: Array<{ key: string; id: number; variant_id: number; product_id: number; quantity: number; price: number; line_price: number }> };

/** 画像の署名 URL に含まれる語と、カートの印の漏出を取り違えないよう、JSON のキーだけを調べる。 */
function responseKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(responseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...responseKeys(entry)]);
  }
  return [];
}

async function firstVariant(page: Page, itemId: number): Promise<Variant> {
  const response = await page.request.get(`/api/items/${itemId}`);
  expect(response.status()).toBe(200);
  const detail = await response.json() as { variantAvailability?: Variant[] };
  const variant = detail.variantAvailability?.[0];
  if (!variant) throw new Error('公開商品の最初のバリアントが無い');
  return variant;
}

async function readCart(page: Page): Promise<Cart> {
  const response = await page.request.get('/api/cart');
  expect(response.status()).toBe(200);
  return response.json() as Promise<Cart>;
}

async function detailAddButton(page: Page, variant: Variant, mobile: boolean) {
  // 既存の商品詳細 spec と同じ部分一致で、ボタンの名前に付く装飾も許容する。
  if (mobile) {
    const fixed = page.getByTestId('item-actions-fixed');
    await expect(fixed).toBeVisible();
    const select = fixed.getByRole('button', { name: /SELECT OPTIONS/ });
    if (await select.count()) {
      await select.click();
      const sheet = page.getByTestId('item-option-sheet');
      await expect(sheet).toBeVisible();
      if (variant.colorName) await sheet.getByRole('button', { name: variant.colorName, exact: true }).click();
      if (variant.sizeLabel) await sheet.getByTestId('item-sheet-size-select').getByRole('button', { name: variant.sizeLabel, exact: true }).click();
      return sheet.getByRole('button', { name: /ADD TO CART/ });
    }
    return fixed.getByRole('button', { name: /ADD TO CART/ });
  }
  const options = page.getByTestId('item-spec-table');
  if (variant.colorName) await options.getByRole('button', { name: variant.colorName, exact: true }).click();
  if (variant.sizeLabel) await options.getByTestId('item-size-select').getByRole('button', { name: variant.sizeLabel, exact: true }).click();
  return page.getByTestId('item-actions-main').getByRole('button', { name: /ADD TO CART/ });
}

test('FR-CART-024 FREQ-430-AC-01・02・03・05・06・07: カート全体・加算・上限・所有権・CSRF', async ({ page, browser }) => {
  const seeded = await seedCart(page);
  test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
  if (!seeded.ok) return;
  const variant = await firstVariant(page, seeded.itemId);
  const origin = new URL(page.url()).origin;
  const add = (quantity: number, id = variant.variantId) => page.request.post('/api/cart/add', {
    headers: { origin }, data: { items: [{ id, quantity }] },
  });

  expect((await add(1)).status()).toBe(200);
  const response = await page.request.get('/api/cart');
  expect(response.status()).toBe(200);
  const cart = await response.json() as Cart;
  expect(responseKeys(cart)).not.toContain('token');
  expect(cart.item_count).toBe(2);
  expect(cart.items).toHaveLength(1);
  expect(cart.items[0]).toMatchObject({
    key: expect.any(String), id: variant.variantId, variant_id: variant.variantId,
    product_id: seeded.itemId, quantity: 2, price: seeded.price, line_price: seeded.price * 2,
  });

  // 一度に18個を足し、IP ごとの制限を上限検証の呼び出し回数で消費しない。
  expect((await add(18)).status()).toBe(200);
  expect((await readCart(page)).items[0].quantity).toBe(20);
  const over = await add(1);
  expect(over.status()).toBe(422);
  expect(await over.json()).toEqual({ status: 422, message: 'Cart Error', description: '1つの商品は20個までです。' });
  expect((await readCart(page)).items[0].quantity).toBe(20);
  const unavailable = await add(1, 999999999);
  expect(unavailable.status()).toBe(404);
  expect(await unavailable.json()).toEqual({ status: 404, message: 'Cart Error', description: '選んだ色・サイズは現在お求めいただけません。' });

  // 別のブラウザのゲストの明細を、最初のゲストが変えられないことを実際の key で確かめる。
  const other = await browser.newContext({ baseURL: origin });
  try {
    const otherPage = await other.newPage();
    await otherPage.goto('/');
    const added = await otherPage.request.post('/api/cart/add', { headers: { origin }, data: { items: [{ id: variant.variantId, quantity: 1 }] } });
    expect(added.status()).toBe(200);
    const otherCart = await readCart(otherPage);
    expect(otherCart.items).toHaveLength(1);
    const foreign = await page.request.post('/api/cart/change', { headers: { origin }, data: { id: otherCart.items[0].key, quantity: 0 } });
    expect(foreign.status()).toBe(404);
    expect((await readCart(otherPage)).items).toHaveLength(1);
  } finally {
    await other.close();
  }

  const removed = await page.request.post('/api/cart/change', { headers: { origin }, data: { id: cart.items[0].key, quantity: 0 } });
  expect(removed.status()).toBe(200);
  expect(await removed.json()).toMatchObject({ item_count: 0, items: [] });
  expect((await readCart(page)).items).toEqual([]);

  const member = await createTestMember('cart-api-desktop');
  await loginAsMember(page, member);
  // Origin は付け、CSRF の合言葉だけを省くことで、送信元検証との取り違えを防ぐ。
  expect((await add(1)).status()).toBe(403);
});

for (const viewport of viewports) {
  test(`FR-CART-024 FREQ-430-AC-03・04: 商品詳細で断りの文言を表示する (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const seeded = await seedCart(page);
    test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
    if (!seeded.ok) return;
    const variant = await firstVariant(page, seeded.itemId);
    const cart = await readCart(page);
    const changed = await page.request.post('/api/cart/change', {
      headers: { origin: new URL(page.url()).origin }, data: { id: cart.items[0].key, quantity: 20 },
    });
    expect(changed.status()).toBe(200);
    await page.goto(`/item/${seeded.itemId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const button = await detailAddButton(page, variant, viewport.name === 'mobile');
    await expect(button).toBeEnabled();
    const overResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/cart/add' && r.request().method() === 'POST');
    await button.click();
    expect((await overResponse).status()).toBe(422);
    await expect(page.getByRole('alert').filter({ hasText: '1つの商品は20個までです。' })).toBeVisible();
    expect((await readCart(page)).items[0].quantity).toBe(20);

    // 51種類目の DB 判定は結合テストに任せ、画面はサーバーの description をそのまま示すことを確かめる。
    await page.route('**/api/cart/add', (route) => route.fulfill({
      status: 422, json: { status: 422, message: 'Cart Error', description: 'カートに入れられるのは50種類までです。' },
    }));
    await button.click();
    await expect(page.getByRole('alert').filter({ hasText: 'カートに入れられるのは50種類までです。' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
