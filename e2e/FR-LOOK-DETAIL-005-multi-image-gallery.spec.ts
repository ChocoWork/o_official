import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

test.describe('FR-LOOK-DETAIL-005 複数画像ギャラリー', () => {
  test('メイン画像とサムネイルを表示し、サムネイル選択で切り替えできる', async ({ page }) => {
    await gotoFirstLookDetail(page);

    const mainImage = page.locator('[data-testid="look-main-image"]');
    await expect(mainImage).toBeVisible();

    const thumbs = page.locator('[data-testid="look-thumb-button"]');
    const count = await thumbs.count();
    expect(count).toBeGreaterThan(0);

    if (count > 1) {
      const beforeSrc = await mainImage.getAttribute('src');
      await thumbs.nth(1).click();
      const afterSrc = await mainImage.getAttribute('src');
      expect(afterSrc).not.toBe(beforeSrc);
    }
  });
});
