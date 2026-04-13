import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-006 送信状態フィードバック', () => {
  test('送信中・成功/失敗メッセージを表示する', async ({ page }) => {
    await page.goto('/contact');

    await page.locator('input[name="name"]').fill('テスト太郎');
    await page.locator('input[name="email"]').fill('tester@example.com');
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole('button', { name: 'その他' }).click();
    await page.locator('input[name="subject"]').fill('送信状態テスト');
    await page.locator('textarea[name="message"]').fill('送信状態を確認します。');

    await page.getByRole('button', { name: 'SEND MESSAGE' }).click();
    await expect(page.getByRole('button', { name: /送信中|SENDING/i })).toBeVisible();

    await expect(page.getByText(/送信完了|送信しました|失敗しました|エラー/i)).toBeVisible();
  });
});
