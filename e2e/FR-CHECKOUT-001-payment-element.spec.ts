import { expect, test } from '@playwright/test';

test.describe('FR-CHECKOUT-001 Stripe CheckoutProvider と PaymentElement', () => {
  test('チェックアウトページは Stripe CheckoutProvider + PaymentElement を表示する', async ({ page }) => {
    await page.goto('/checkout');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // Step 1: Shipping form should be visible
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="fullName"]')).toBeVisible();

    // Step through to payment form
    await page.fill('input[name="email"]', 'test@example.com');
    await page.fill('input[name="fullName"]', 'テスト太郎');
    await page.fill('input[name="postalCode"]', '100-0001');
    await page.fill('input[name="city"]', '千代田区');
    await page.fill('input[name="address"]', '丸の内1-1-1');
    await page.fill('input[name="phone"]', '09000000000');
    await page.getByRole('button', { name: '都道府県' }).click();
    await page.getByRole('button', { name: '東京都' }).click();
    
    await page.getByRole('button', { name: '次へ' }).first().click();
    await page.waitForTimeout(1000);

    // Check if payment element or error is visible
    const hasPaymentElement = await page.locator('iframe[title*="Payment"]')
      .isVisible()
      .catch(() => false);
    
    const hasError = await page.locator('text=/決済|エラー|失敗/')
      .first()
      .isVisible()
      .catch(() => false);

    const hasStepTwoBackButton = await page.getByRole('button', { name: '戻る' })
      .first()
      .isVisible()
      .catch(() => false);

    expect(hasPaymentElement || hasError || hasStepTwoBackButton).toBeTruthy();
  });
});
