import { expect, test } from '@playwright/test';

test.describe('FR-WISHLIST-002 loading/error/empty', () => {
  test('読み込み完了後にエラー・空・一覧のいずれかを表示する', async ({ page }) => {
    await page.goto('/wishlist');

    const hasLoading = await page.getByText('読み込み中...').isVisible().catch(() => false);
    if (hasLoading) {
      await expect(page.getByText('読み込み中...')).not.toBeVisible({ timeout: 10000 });
    }

    const hasError = await page.locator('text=/失敗|エラー/').first().isVisible().catch(() => false);
    const hasEmpty = await page.getByText('ウィッシュリストは空です').isVisible().catch(() => false);
    const hasCards = (await page.locator('article, [role="listitem"]').count()) > 0;

    expect(hasError || hasEmpty || hasCards).toBeTruthy();
  });
});
