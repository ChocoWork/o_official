import { expect, test } from '@playwright/test';

test.describe('FR-CHECKOUT-004 フィールドバリデーション＆aria-describedby', () => {
  test('必須フィールドに required 属性が存在する', async ({ page }) => {
    await page.goto('/checkout');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    await expect(page.locator('input[name="email"]')).toHaveAttribute('required');
    await expect(page.locator('input[name="fullName"]')).toHaveAttribute('required');
    await expect(page.locator('input[name="postalCode"]')).toHaveAttribute('required');
    await expect(page.locator('input[name="city"]')).toHaveAttribute('required');
    await expect(page.locator('input[name="address"]')).toHaveAttribute('required');
    await expect(page.locator('input[name="phone"]')).toHaveAttribute('required');
  });

  test('空のまま送信を試みるとメールフィールドにエラーメッセージが表示される', async ({ page }) => {
    await page.goto('/checkout');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // 空のまま送信
    await page.getByRole('button', { name: '次へ' }).first().click();

    // メールアドレスのエラーメッセージが表示される
    await expect(page.getByText('メールアドレスを入力してください')).toBeVisible();
  });

  test('不正なメールアドレスを入力するとエラーメッセージが表示される', async ({ page }) => {
    await page.goto('/checkout');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    await page.fill('input[name="email"]', 'not-an-email');
    await page.getByRole('button', { name: '次へ' }).first().click();

    await expect(page.getByText('正しいメールアドレスを入力してください')).toBeVisible();
  });

  test('エラーメッセージが表示されたフィールドに aria-describedby が設定される', async ({ page }) => {
    await page.goto('/checkout');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // 空のまま送信してエラー状態にする
    await page.getByRole('button', { name: '次へ' }).first().click();

    // email フィールドに aria-describedby が設定される
    const emailInput = page.locator('input[name="email"]');
    const ariaDescribedBy = await emailInput.getAttribute('aria-describedby');
    expect(ariaDescribedBy).toBeTruthy();
    expect(ariaDescribedBy).toContain('email-error');

    // aria-describedby が指すエラー要素が存在する
    const errorEl = page.locator('#email-error');
    await expect(errorEl).toBeVisible();
  });

  test('エラー後に正しい値を入力するとエラーがクリアされる', async ({ page }) => {
    await page.goto('/checkout');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    await page.getByRole('button', { name: '次へ' }).first().click();
    await expect(page.getByText('メールアドレスを入力してください')).toBeVisible();

    await page.fill('input[name="email"]', 'valid@example.com');
    await expect(page.getByText('メールアドレスを入力してください')).not.toBeVisible();
  });

  test('aria-invalid 属性がエラー状態で設定される', async ({ page }) => {
    await page.goto('/checkout');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    await page.getByRole('button', { name: '次へ' }).first().click();

    const emailInput = page.locator('input[name="email"]');
    await expect(emailInput).toHaveAttribute('aria-invalid', 'true');
  });
});
