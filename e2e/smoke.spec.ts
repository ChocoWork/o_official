import { test, expect } from '@playwright/test';

/**
 * 基本的なスモークテスト - E2E環境の動作確認
 */

test.describe('スモークテスト', () => {
  test('トップページが正しく表示される', async ({ page }) => {
    await page.goto('/');
    
    // ヘッダーが表示されることを確認
    await expect(page.locator('header')).toBeVisible();
    
    // サイトタイトルが表示されることを確認
    await expect(page.locator('h1:has-text("Le Fil des Heures")')).toBeVisible();
  });

  test('ログインページにアクセスできる', async ({ page }) => {
    await page.goto('/login');
    
    // ログインフォームが表示されることを確認
    await expect(page.locator('button:has-text("ログイン")')).toBeVisible();
    await expect(page.locator('button:has-text("新規登録")')).toBeVisible();
  });
});
