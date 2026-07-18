import { test, expect } from '@playwright/test';

// FREQ-126〜128: VIEW ALL 導線は各セクション見出し右側のリンクに統一された。
// FREQ-147〜149: 表示/非表示は「公開総数 > 帯域別表示数」で切り替わるため
// （FR-HOME-013 で検証）、ここでは導線が DOM に存在することのみ確認する。
test.describe('FR-HOME-004 home CTA buttons', () => {
  test('home sections include VIEW ALL links for item, lookbook, and news', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('#items a[href="/item"]:has-text("VIEW ALL")')).toBeAttached();
    await expect(page.locator('#look a[href="/look"]:has-text("VIEW ALL")')).toBeAttached();
    await expect(page.locator('#news a[href="/news"]:has-text("VIEW ALL")')).toBeAttached();
  });
});
