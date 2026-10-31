import { expect, test, type Page } from '@playwright/test';
import { seedCart } from './checkout-flow-helpers';
import { createTestMember, loginAsMember } from './member-session-helpers';
import { isolateCheckoutIp } from './checkout-test-utils';

// 会員の確認コードと Cookie が通信記録へ残らないようにする。
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];
type Variant = { variantId: number; colorName: string | null; sizeLabel: string | null };
type Cart = { item_count: number; items: Array<{ key: string; id: number; variant_id: number; product_id: number; quantity: number; price: number; line_price: number }> };
type DiscountCart = Cart & { items_subtotal_price: number; total_price: number; discounts: Array<{ name: string; amount: number }>; total_discount: number; discount_provisional: boolean };

/** Drain before asserting the status, including errors. Playwright keeps the buffered JSON available. */
async function statusOf(response: { body(): Promise<Buffer>; status(): number }): Promise<number> {
  await response.body();
  return response.status();
}

test.beforeEach(async ({ page }) => { await isolateCheckoutIp(page); });

/** 画像の署名 URL の token と取り違えず、全階層のキー名に含まれる token を調べるため。 */
function responseKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(responseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...responseKeys(entry)]);
  }
  return [];
}

async function firstVariant(page: Page, itemId: number): Promise<Variant> {
  const response = await page.request.get(`/api/items/${itemId}`);
  expect(await statusOf(response)).toBe(200);
  const detail = await response.json() as { variantAvailability?: Variant[] };
  const variant = detail.variantAvailability?.[0];
  if (!variant) throw new Error('公開商品の最初のバリアントが無い');
  return variant;
}

async function readCart(page: Page): Promise<Cart> {
  const response = await page.request.get('/api/cart');
  expect(await statusOf(response)).toBe(200);
  const cart = await response.json() as DiscountCart;
  expect(Array.isArray(cart.discounts)).toBe(true);
  expect(cart.discounts.every(row => Object.keys(row).sort().join(',') === 'amount,name' && row.amount > 0)).toBe(true);
  expect(cart.discounts.reduce((sum, row) => sum + row.amount, 0)).toBe(cart.total_discount);
  expect(cart.total_price).toBe(cart.items_subtotal_price - cart.total_discount);
  expect(typeof cart.discount_provisional).toBe('boolean');
  return cart;
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

test('FR-CART-024 FREQ-430-AC-01・02・03・05・06・07: カート全体・加算・上限・所有権・CSRF', async ({ page, browser, context }) => {
  const seeded = await seedCart(page);
  test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
  if (!seeded.ok) return;
  const variant = await firstVariant(page, seeded.itemId);
  const origin = new URL(page.url()).origin;
  const add = (quantity: number, id = variant.variantId) => page.request.post('/api/cart/add', {
    headers: { origin }, data: { items: [{ id, quantity }] },
  });

  expect(await statusOf(await add(1))).toBe(200);
  const response = await page.request.get('/api/cart');
  expect(await statusOf(response)).toBe(200);
  const raw = await response.text();
  const value = (await context.cookies()).find((cookie) => cookie.name === 'cart')?.value ?? '';
  // 本物の印と本文を比べ、失敗時の差分に秘密の値が出ないよう真偽だけを確認する。
  expect(Boolean(value)).toBe(true);
  expect(raw.includes(value)).toBe(false);
  const cart = JSON.parse(raw) as DiscountCart;
  expect(cart).toEqual(expect.objectContaining({ discounts: expect.any(Array), total_discount: expect.any(Number), discount_provisional: expect.any(Boolean) }));
  expect(cart.total_price).toBe(cart.items_subtotal_price - cart.total_discount);
  expect(responseKeys(cart).filter((key) => /token/i.test(key))).toEqual([]);
  expect(cart.item_count).toBe(2);
  expect(cart.items).toHaveLength(1);
  expect(cart.items[0]).toMatchObject({
    key: expect.any(String), id: variant.variantId, variant_id: variant.variantId,
    product_id: seeded.itemId, quantity: 2, price: seeded.price, line_price: seeded.price * 2,
  });

  // 一度に18個を足し、IP ごとの制限を上限検証の呼び出し回数で消費しない。
  expect(await statusOf(await add(18))).toBe(200);
  expect((await readCart(page)).items[0].quantity).toBe(20);
  const over = await add(1);
  expect(await statusOf(over)).toBe(422);
  expect(await over.json()).toEqual({ status: 422, message: 'Cart Error', description: '1つの商品は20個までです。' });
  expect((await readCart(page)).items[0].quantity).toBe(20);
  const unavailable = await add(1, 999999999);
  expect(await statusOf(unavailable)).toBe(404);
  expect(await unavailable.json()).toEqual({ status: 404, message: 'Cart Error', description: '選んだ色・サイズは現在お求めいただけません。' });

  // 別のブラウザのゲストの明細を、最初のゲストが変えられないことを実際の key で確かめる。
  const other = await browser.newContext({ baseURL: origin });
  try {
    const otherPage = await other.newPage();
    await otherPage.goto('/');
    const added = await otherPage.request.post('/api/cart/add', { headers: { origin }, data: { items: [{ id: variant.variantId, quantity: 1 }] } });
    expect(await statusOf(added)).toBe(200);
    const otherCart = await readCart(otherPage);
    expect(otherCart.items).toHaveLength(1);
    const foreign = await page.request.post('/api/cart/change', { headers: { origin }, data: { id: otherCart.items[0].key, quantity: 0 } });
    expect(await statusOf(foreign)).toBe(404);
    expect((await readCart(otherPage)).items).toHaveLength(1);
  } finally {
    await other.close();
  }

  const removed = await page.request.post('/api/cart/change', { headers: { origin }, data: { id: cart.items[0].key, quantity: 0 } });
  expect(await statusOf(removed)).toBe(200);
  expect(await removed.json()).toMatchObject({ item_count: 0, items: [], discounts: [], total_discount: 0, discount_provisional: false, total_price: 0 });
  expect((await readCart(page)).items).toEqual([]);

  const member = await createTestMember('cart-api-desktop');
  await loginAsMember(page, member);
  // Origin は付け、CSRF の合言葉だけを省くことで、送信元検証との取り違えを防ぐ。
  const denied = await add(1);
  expect(await statusOf(denied)).toBe(403);
  // 同じ403でも別の拒否理由では通さず、CSRF の合言葉が無いことによる拒否まで確認する。
  const denial = await denied.json() as { reason?: string };
  expect(denial.reason).toBe('CSRF validation failed');
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
    expect(await statusOf(changed)).toBe(200);
    await page.goto(`/item/${seeded.itemId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const button = await detailAddButton(page, variant, viewport.name === 'mobile');
    await expect(button).toBeEnabled();
    const overResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/cart/add' && r.request().method() === 'POST');
    await button.click();
    expect(await statusOf(await overResponse)).toBe(422);
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
