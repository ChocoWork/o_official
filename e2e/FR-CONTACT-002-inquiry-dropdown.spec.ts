import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-002 問い合わせ種別ドロップダウン', () => {
  test('問い合わせ種別を選択できる', async ({ page }) => {
    await page.goto('/contact');

    const inquirySelectButton = page.locator('button[aria-haspopup="listbox"]').first();
    await expect(inquirySelectButton).toBeVisible();
    await inquirySelectButton.click();

    const option = page.getByRole('button', { name: '商品について' });
    await expect(option).toBeVisible();
    await option.click();

    await expect(inquirySelectButton).toContainText('商品について');
  });
});
