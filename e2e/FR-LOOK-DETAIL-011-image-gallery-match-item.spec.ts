import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-179: LOOK詳細ページの画像部分の3ビューポート仕様を ITEM 詳細ページと統一する。
// mobile: フルブリードスワイプカルーセル / tablet: スワイプ + 前後送りボタン /
// desktop: 左サムネイル縦列 + メイン画像

test.describe('FR-LOOK-DETAIL-011 画像ギャラリーを ITEM 詳細と同一仕様にする', () => {
  test('mobile スワイプカルーセルのみ表示される', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFirstLookDetail(page);

    // AC-01: カルーセルが表示され、サムネイル・メイン画像枠は表示されない
    await expect(
      page.locator('[data-testid="look-detail-carousel"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="look-detail-carousel-slide"]').first(),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="look-thumb-button"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="look-detail-main-image-frame"]'),
    ).toBeHidden();
    await expect(
      page.locator('[data-testid="look-detail-tablet-carousel"]'),
    ).toBeHidden();
  });

  test('tablet カルーセルと前後送りボタンで切り替えできる', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await gotoFirstLookDetail(page);

    const carousel = page.locator(
      '[data-testid="look-detail-tablet-carousel"]',
    );
    await expect(carousel).toBeVisible();
    await expect(
      page.locator('[data-testid="look-detail-carousel"]'),
    ).toBeHidden();
    await expect(
      page.locator('[data-testid="look-detail-main-image-frame"]'),
    ).toBeHidden();

    const slideCount = await page
      .locator('[data-testid="look-detail-tablet-carousel-slide"]')
      .count();
    const prev = page.locator(
      '[data-testid="look-detail-tablet-carousel-prev"]',
    );
    const next = page.locator(
      '[data-testid="look-detail-tablet-carousel-next"]',
    );

    if (slideCount > 1) {
      // AC-02: 先頭では次送りのみ表示され、押すと前送りが現れる
      await expect(prev).toBeHidden();
      await expect(next).toBeVisible();
      await next.click();
      await expect(prev).toBeVisible();
    } else {
      await expect(prev).toBeHidden();
      await expect(next).toBeHidden();
    }
  });

  test('desktop サムネイル縦列とメイン画像で切り替えできる', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoFirstLookDetail(page);

    // AC-03: メイン画像が表示され、カルーセルは表示されない
    const mainImage = page.locator('[data-testid="look-main-image"]');
    await expect(mainImage).toBeVisible();
    await expect(
      page.locator('[data-testid="look-detail-carousel"]'),
    ).toBeHidden();
    await expect(
      page.locator('[data-testid="look-detail-tablet-carousel"]'),
    ).toBeHidden();

    const thumbs = page.locator('[data-testid="look-thumb-button"]');
    const count = await thumbs.count();

    if (count > 1) {
      // サムネイル選択でメイン画像が切り替わる
      const beforeSrc = await mainImage.getAttribute('src');
      await thumbs.nth(1).click();
      const afterSrc = await page
        .locator('[data-testid="look-main-image"]')
        .getAttribute('src');
      expect(afterSrc).not.toBe(beforeSrc);
    }
  });
});
