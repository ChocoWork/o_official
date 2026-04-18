import { expect, test } from '@playwright/test';

test.describe('FR-PRIVACY-002 metadata', () => {
  test('/privacy に title と description と OGP を設定する', async ({ page }) => {
    await page.goto('/privacy');

    await expect(page).toHaveTitle('Privacy Policy | Le Fil des Heures');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      'Le Fil des Heures のプライバシーポリシー。個人情報の取扱い、利用目的、第三者提供、お問い合わせ窓口をご案内します。',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Privacy Policy | Le Fil des Heures');
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
      'content',
      'Le Fil des Heures のプライバシーポリシー。個人情報の取扱い、利用目的、第三者提供、お問い合わせ窓口をご案内します。',
    );
  });
});