import { expect, test, type Page } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
];

function paymentIframe(page: Page) {
  return page
    .locator('section.checkout-section')
    .filter({ hasText: '支払方法の選択' })
    .locator('iframe')
    .first();
}

test.describe('FR-CHECKOUT-022 決済手段の動的化', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const seeded = await page.evaluate(async () => {
      const itemsResponse = await fetch('/api/items?pageSize=20&sort=newest');
      if (!itemsResponse.ok) {
        return { ok: false, reason: `/api/items returned ${itemsResponse.status}` };
      }
      const body = (await itemsResponse.json()) as { items?: { id?: number; price?: number }[] };
      const item = (body.items ?? []).find((i) => typeof i?.id === 'number' && (i?.price ?? 0) >= 50);
      if (!item?.id) {
        return { ok: false, reason: 'No published item priced at 50 JPY or above' };
      }
      const cartResponse = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: item.id, quantity: 1 }),
      });
      return cartResponse.ok ? { ok: true, reason: '' } : { ok: false, reason: `cart seeding failed ${cartResponse.status}` };
    });
    if (!seeded.ok) {
      test.skip(true, seeded.reason);
    }
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）支払方法セクションに決済フォームが出る`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await page.goto('/checkout');

      // 表示される手段はダッシュボード設定に依存するため、特定手段名はアサートしない
      await expect(paymentIframe(page)).toBeVisible({ timeout: 30000 });
    });
  }
});
