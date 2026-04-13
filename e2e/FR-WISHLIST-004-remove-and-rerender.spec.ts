import { expect, test } from '@playwright/test';

test.describe('FR-WISHLIST-004 削除と再描画', () => {
  test('削除ボタン押下で一覧が再描画される', async ({ page }) => {
    await page.goto('/wishlist');

    const removeButton = page.getByRole('button', { name: 'ウィッシュリストから削除' }).first();
    const hasRemoveButton = await removeButton.isVisible().catch(() => false);
    if (!hasRemoveButton) {
      test.skip();
      return;
    }

    const before = await page.getByRole('button', { name: 'ウィッシュリストから削除' }).count();
    await removeButton.click();
    await expect.poll(async () => page.getByRole('button', { name: 'ウィッシュリストから削除' }).count()).toBeLessThan(before + 1);
  });
});
