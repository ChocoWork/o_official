import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';
import { stubCheckoutSessionApis } from './checkout-test-utils';
import { sampleCartItem, toCartJson } from './shop-test-utils';

test.describe('FR-CHECKOUT-012 account profile defaults', () => {
  test('ログイン済みユーザーは account の登録情報が配送情報初期値に入る', async ({ page }) => {
    await mockOtpAuthentication(page);
    await stubCheckoutSessionApis(page);

    // 保存済み配送先は未モックだと実サーバの 401 を拾う。401 は clientFetch の
    // セッション更新を誘発し、/api/auth/refresh が 401 を返した実行だけ
    // ログイン状態が落ちて読み取り表示が消える（並列実行時のフレークの原因）。
    await page.route('**/api/profile/addresses', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ addresses: [] }),
      });
    });

    // カートの窓口の応答（CartJson）
    await page.route('**/api/cart', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          toCartJson([
            sampleCartItem({
              id: 'cart-1',
              item_id: 1,
              quantity: 1,
              color: 'Black',
              size: 'M',
              items: {
                id: 1,
                name: 'Silk Blouse',
                price: 12000,
                image_url: '/images/test-item.jpg',
                category: 'tops',
              },
            }),
          ]),
        ),
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

    // パスワードのログイン画面は消したので、認証を固定した会員として /account へ入る（account-test-utils）
    await loginAndOpenAccount(page);
    await page.goto('/checkout');

    // お客様情報は「ログイン済 + 氏名/メール/電話が揃う」場合に読み取り表示になる。
    // 値がプロフィールから入っていることをカードの表示で確認する。
    const customerCard = page.locator('.checkout-card').first();
    await expect(customerCard).toContainText('山田 花子');
    await expect(customerCard).toContainText('user@example.com');
    await expect(customerCard).toContainText('090-1111-2222');

    // 配送先は入力欄のまま（保存済み配送先がないため新規入力フォーム）
    await expect(page.locator('input[name="postalCode"]').first()).toHaveValue('150-0001');
    await expect(page.locator('input[name="city"]').first()).toHaveValue('渋谷区');
    await expect(page.locator('input[name="address"]').first()).toHaveValue('神宮前1-2-3');
    await expect(page.locator('input[name="building"]').first()).toHaveValue('青山ハイツ 101');
  });
});