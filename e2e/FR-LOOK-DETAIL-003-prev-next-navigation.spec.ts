import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-DETAIL-003 前後ルックナビゲーション', () => {
  test('FR-LOOK-DETAIL-003-AC-01 PREV/NEXTリンクを表示し遷移できる', async ({ page }) => {
    // 一覧の並びは新しい順。見本の LOOK 2 の前は LOOK 1、次は LOOK 3（既定の幅 1280px ではインラインナビのリンク）
    await page.goto('/look/2');

    const prevLink = page.locator('a[aria-label^="Previous look"]');
    const nextLink = page.locator('a[aria-label^="Next look"]');
    await expect(prevLink).toBeVisible();
    await expect(nextLink).toBeVisible();

    await nextLink.click();
    await expect(page).toHaveURL(/\/look\/3$/);

    await page.goto('/look/2');
    await page.locator('a[aria-label^="Previous look"]').click();
    await expect(page).toHaveURL(/\/look\/1$/);
  });
});
