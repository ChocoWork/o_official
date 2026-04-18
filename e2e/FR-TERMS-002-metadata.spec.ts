import { expect, test } from '@playwright/test';

test.describe('FR-TERMS-002 metadata', () => {
  test('/terms に title と description と OGP を設定する', async ({ page }) => {
    await page.goto('/terms');

    await expect(page).toHaveTitle('Terms of Service | Le Fil des Heures');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      'Le Fil des Heures の利用規約ページです。会員登録、注文、支払方法、配送、返品・交換、免責事項をご確認いただけます。',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Terms of Service | Le Fil des Heures');
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
      'content',
      'Le Fil des Heures の利用規約ページです。会員登録、注文、支払方法、配送、返品・交換、免責事項をご確認いただけます。',
    );
  });
});