import { expect, test } from '@playwright/test';

test.describe('FR-TERMS-001 terms content', () => {
  test('/terms に利用規約本文を表示する', async ({ page }) => {
    await page.goto('/terms');

    await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '利用規約' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '第4条（支払方法）' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '第6条（返品・交換）' })).toBeVisible();
    await expect(page.getByText('東京地方裁判所を第一審の専属的合意管轄裁判所')).toBeVisible();
  });
});