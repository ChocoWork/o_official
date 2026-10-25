import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-DETAIL-005 複数画像ギャラリー', () => {
  test('FR-LOOK-DETAIL-005-AC-01 メイン画像とサムネイルを表示し、サムネイル選択で切り替えできる', async ({ page }) => {
    // PC（1280px）で、画像が2枚の見本の LOOK 1（supabase/seed.sql）を開く
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/look/1');

    const mainImage = page.locator('[data-testid="look-main-image"]');
    await expect(mainImage).toBeVisible();

    // FREQ-179: ITEM 詳細と同様、サムネイル縦列は画像が2枚以上のときに表示される。画像の数だけ並ぶ
    const thumbs = page.locator('[data-testid="look-thumb-button"]');
    await expect(thumbs).toHaveCount(2);

    const beforeSrc = await mainImage.getAttribute('src');
    expect(beforeSrc).toBeTruthy();
    await thumbs.nth(1).click();
    await expect(mainImage).not.toHaveAttribute('src', beforeSrc!);
  });
});
