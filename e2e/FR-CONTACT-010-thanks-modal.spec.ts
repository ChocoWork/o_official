import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-010 送信完了サンクス表示', () => {
  test('送信後にサンクスメッセージまたはモーダルを表示する', async ({ page }) => {
    await page.goto('/contact');

    await page.locator('input[name="name"]').fill('テスト太郎');
    await page.locator('input[name="email"]').fill('tester@example.com');
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole('button', { name: 'その他' }).click();
    await page.locator('input[name="subject"]').fill('サンクス確認');
    await page.locator('textarea[name="message"]').fill('送信完了後表示の確認です。');

    await page.getByRole('button', { name: 'SEND MESSAGE' }).click();

    await expect(page.getByText(/お問い合わせありがとうございます|送信完了|THANK YOU|サンクス/i)).toBeVisible();
  });
});
