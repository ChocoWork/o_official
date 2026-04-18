import { test, expect } from '@playwright/test';

test.describe('FR-LOGIN-006 resend countdown', () => {
  test('shows the resend countdown immediately after OTP send', async ({ page }) => {
    await page.route('**/api/auth/identify', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          message: '認証コードを送信しました。メールに届いたコードを入力してください。',
        }),
      });
    });

    await page.goto('/login');

    if (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
      await page.evaluate(() => {
        window.onTurnstileSuccess?.('test-turnstile-token');
      });
    }

    await page.getByLabel('EMAIL').fill('user@example.com');
    await page.getByRole('button', { name: 'メールで認証コードを受け取る' }).click();

    await expect(page.getByText(/後に再送可能/)).toBeVisible();
    await expect(page.getByRole('button', { name: '再送信' })).toHaveCount(0);
  });
});