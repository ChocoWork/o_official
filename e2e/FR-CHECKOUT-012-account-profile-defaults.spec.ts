import { test, expect } from '@playwright/test';
import { injectTurnstileToken } from './turnstile-test-utils';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';
import { mockOtpAuthentication } from './account-test-utils';

test.describe('FR-CHECKOUT-012 account profile defaults', () => {
  test('ログイン済みユーザーは account の登録情報が配送情報初期値に入る', async ({ page }) => {
    await mockOtpAuthentication(page);

    await page.route('**/api/cart', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'cart-1',
            item_id: 1,
            quantity: 1,
            color: 'Black',
            size: 'M',
            added_at: '2026-04-18T00:00:00.000Z',
            items: {
              id: 1,
              name: 'Silk Blouse',
              price: 12000,
              image_url: '/images/test-item.jpg',
              category: 'tops',
            },
          },
        ]),
      });
    });

    await page.route('**/api/profile', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          email: 'user@example.com',
          fullName: '山田 花子',
          phone: '090-1111-2222',
          address: {
            postalCode: '1500001',
            prefecture: '東京都',
            city: '渋谷区',
            address: '神宮前1-2-3',
            building: '青山ハイツ 101',
          },
        }),
      });
    });

    await page.goto('/login');

    await injectTurnstileToken(page);
    // /api/auth/login はモックなので本物の 2FA Cookie が発行されない。
    // /login/verify はサーバーで Cookie を検証するため、テスト側で置く。
    await setLoginTwoFactorCookie(page, 'user@example.com');
    await page.getByLabel('EMAIL').fill('user@example.com');
    await page.getByLabel('PASSWORD').fill('Password123456789!');
    await page.getByRole('button', { name: 'ログイン' }).click();

    // FREQ-334: 認証コードの入力は専用画面
    await page.waitForURL('**/login/verify');

    for (let index = 0; index < 8; index += 1) {
      await page.getByLabel(`認証コード ${index + 1} 桁目`).fill(String((index + 1) % 10));
    }

    await page.getByRole('button', { name: 'サインイン' }).click();
    await page.waitForURL('**/account');
    await page.goto('/checkout');

    await expect(page.locator('input[name="email"]').first()).toHaveValue('user@example.com');
    await expect(page.locator('input[name="fullName"]').first()).toHaveValue('山田 花子');
    await expect(page.locator('input[name="postalCode"]').first()).toHaveValue('150-0001');
    await expect(page.locator('input[name="city"]').first()).toHaveValue('渋谷区');
    await expect(page.locator('input[name="address"]').first()).toHaveValue('神宮前1-2-3');
    await expect(page.locator('input[name="building"]').first()).toHaveValue('青山ハイツ 101');
    await expect(page.locator('input[name="phone"]').first()).toHaveValue('090-1111-2222');
  });
});