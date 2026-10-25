import { expect, test } from '@playwright/test';

test.describe('FR-PRIVACY-001 policy content', () => {
  test('FR-PRIVACY-001-AC-01 /privacy にプライバシーポリシー本文を表示する', async ({ page }) => {
    await page.goto('/privacy');

    await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '個人情報の取り扱いについて' })).toBeVisible();
    for (const name of [
      '1. 個人情報の定義',
      '2. 個人情報の収集方法',
      '3. 個人情報の利用目的',
      '4. 個人情報の第三者提供',
      '8. 個人情報の安全管理',
      '9. Cookie 及び外部サービスの利用',
    ]) {
      await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
    }
    await expect(page.getByText('privacy@lefildesheures.com')).toBeVisible();
  });
});