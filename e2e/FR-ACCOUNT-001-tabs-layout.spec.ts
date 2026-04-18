import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-001 account tabs layout', () => {
  test('プロフィールと配送情報と購入履歴タブを表示し、タブ変更でURLと表示が同期する', async ({ page }) => {
    await mockOtpAuthentication(page);

    await page.route('**/api/profile', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          email: 'user@example.com',
          fullName: '山田 花子',
          kanaName: 'ヤマダ ハナコ',
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

    await page.route('**/api/orders', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });

    await loginAndOpenAccount(page);

    await expect(page.getByRole('button', { name: 'プロフィール' })).toBeVisible();
    await expect(page.getByRole('button', { name: '配送情報' })).toBeVisible();
    await expect(page.getByRole('button', { name: '購入履歴' })).toBeVisible();
    await expect(page.getByText('メールアドレス')).toBeVisible();
    await expect(page.getByText('user@example.com')).toBeVisible();

    await page.getByRole('button', { name: '配送情報' }).click();
    await expect(page).toHaveURL(/tab=shipping/);
    await expect(page.getByText('150-0001')).toBeVisible();

    await page.getByRole('button', { name: '購入履歴' }).click();
    await expect(page).toHaveURL(/tab=orders/);
    await expect(page.getByText('注文履歴はまだありません')).toBeVisible();
  });
});