import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-005 フォーム送信API連携', () => {
  test('onSubmitでAPIに送信できる', async ({ page }) => {
    await page.goto('/contact');

    await page.locator('input[name="name"]').fill('テスト太郎');
    await page.locator('input[name="email"]').fill('tester@example.com');
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole('button', { name: '商品について' }).click();
    await page.locator('input[name="subject"]').fill('問い合わせテスト');
    await page.locator('textarea[name="message"]').fill('問い合わせ本文です。');

    await page.getByRole('button', { name: 'SEND MESSAGE' }).click();

    await expect(page.getByRole('heading', { name: 'お問い合わせありがとうございます' })).toBeVisible();
  });
});
