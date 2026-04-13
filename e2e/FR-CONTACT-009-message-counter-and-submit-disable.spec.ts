import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-009 文字数カウンターと送信ボタン制御', () => {
  test('message文字数カウンターを表示し未入力時と送信中はボタン無効化', async ({ page }) => {
    await page.goto('/contact');

    const submit = page.getByRole('button', { name: 'SEND MESSAGE' });
    await expect(submit).toBeDisabled();

    await page.locator('input[name="name"]').fill('テスト太郎');
    await page.locator('input[name="email"]').fill('tester@example.com');
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole('button', { name: '商品について' }).click();
    await page.locator('input[name="subject"]').fill('文字数確認');
    await page.locator('textarea[name="message"]').fill('12345');

    await expect(page.getByText('5 / 500')).toBeVisible();
    await expect(submit).toBeEnabled();
  });
});
