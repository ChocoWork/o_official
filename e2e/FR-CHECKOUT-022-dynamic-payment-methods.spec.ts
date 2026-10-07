import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  fillShippingForm,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';

/**
 * FR-CHECKOUT-022 決済手段の動的化
 * 表示される手段はダッシュボード設定に依存するため、特定の手段名は確かめない。
 * グループ F から、決済の入力欄は最終確認画面の「お支払い方法」の欄に出る。
 */
test.describe('FR-CHECKOUT-022 決済手段の動的化', () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）最終確認画面のお支払い方法の欄に決済フォームが出る`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);

      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-dynamic-methods-${viewport.name}@example.com`);
      await proceedToFinal(page);

      await expect(
        page.locator('section.checkout-section').filter({ hasText: 'お支払い方法' }).locator('iframe').first(),
      ).toBeVisible({ timeout: 30_000 });
    });
  }
});
