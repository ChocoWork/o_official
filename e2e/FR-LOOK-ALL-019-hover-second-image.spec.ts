import { expect, test } from '@playwright/test';

// FREQ-132: ホバー時の画像ズーム（scale）を廃止。2 枚目の画像がある場合のみ
// ホバーでクロスフェード表示し、ない場合は画像に何も起こらない。

test.describe('FR-LOOK-ALL-019 ホバーでズームせず2枚目画像を表示', () => {
  test('desktop ホバーしても1枚目画像が拡大されない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();

    const firstLink = page.locator('main a[href^="/look/"]').first();
    const firstImage = firstLink.locator('img').first();
    await expect(firstImage).toBeVisible();

    await firstLink.hover();
    // AC-01: scale クラス削除により transform は none のまま（遷移待ちの猶予をとる）
    await page.waitForTimeout(700);
    await expect(firstImage).toHaveCSS('transform', 'none');
  });

  test('desktop 2枚目画像があるカードはホバーで opacity 1 になる', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();

    const hoverImages = page.locator('main [data-testid="look-card-image-hover"]');
    const count = await hoverImages.count();
    test.skip(count === 0, '2枚目画像を持つ LOOK がないため対象外');

    const hoverImage = hoverImages.first();
    // AC-02: 非ホバー時 0 → ホバー時 1
    await expect(hoverImage).toHaveCSS('opacity', '0');
    const link = page
      .locator('main a[href^="/look/"]:has([data-testid="look-card-image-hover"])')
      .first();
    await link.hover();
    await expect(hoverImage).toHaveCSS('opacity', '1');
  });

  // mobile / tablet: hover 用 2 枚目画像が描画されていても非表示（opacity 0）のまま
  for (const vp of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ] as const) {
    test(`${vp.name} では2枚目画像が opacity 0 のまま表示されない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();

      const hoverImages = page.locator('main [data-testid="look-card-image-hover"]');
      const count = await hoverImages.count();
      test.skip(count === 0, '2枚目画像を持つ LOOK がないため対象外');
      await expect(hoverImages.first()).toHaveCSS('opacity', '0');
    });
  }
});
