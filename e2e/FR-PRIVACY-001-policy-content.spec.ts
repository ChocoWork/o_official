import { expect, test } from '@playwright/test';

test.describe('FR-PRIVACY-001 policy content', () => {
  test('/privacy にプライバシーポリシー本文を表示する', async ({ page }) => {
    await page.goto('/privacy');

    await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '個人情報の取り扱いについて' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '3. 個人情報の利用目的' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '4. 個人情報の第三者提供' })).toBeVisible();
    await expect(page.getByText('privacy@lefildesheures.com')).toBeVisible();
  });
});