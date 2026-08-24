import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-288: LOOK詳細ページのタブレット・PC の画像サイズ / 複数枚時のセグメント線
// インジケータ / 右側情報列の幅を ITEM 詳細ページと同じ仕様にする。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, indicator: 'look-detail-carousel-indicator' },
  { name: 'tablet', width: 768, height: 1024, indicator: 'look-detail-tablet-carousel-indicator' },
  { name: 'desktop', width: 1280, height: 800, indicator: 'look-detail-main-image-indicator' },
] as const;

test.describe('FR-LOOK-DETAIL-016 タブレット・PC の画像仕様を ITEM 詳細と揃える', () => {
  for (const viewport of VIEWPORTS) {
    // AC-01: 画像が複数あるとき、枚数分のセグメント線が出て現在位置だけ active
    test(`${viewport.name} 複数枚のときセグメント線インジケータが枚数分表示される`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await gotoFirstLookDetail(page);

      const imageCount = await page
        .locator('[data-testid="look-detail-carousel-slide"]')
        .count();
      const indicator = page.locator(`[data-testid="${viewport.indicator}"]`);
      const segments = page.locator(
        `[data-testid="${viewport.indicator}-segment"]`,
      );

      if (imageCount > 1) {
        await expect(indicator).toBeVisible();
        await expect(segments).toHaveCount(imageCount);
        await expect(
          page.locator(
            `[data-testid="${viewport.indicator}-segment"][data-active="true"]`,
          ),
        ).toHaveCount(1);
      } else {
        await expect(indicator).toHaveCount(0);
      }
    });
  }

  // AC-02: タブレットの前後送りボタンは画像枠の縦方向中央にある
  test('tablet 前後送りシェブロンが画像枠の縦中央にある', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await gotoFirstLookDetail(page);

    const carousel = page.locator('[data-testid="look-detail-tablet-carousel"]');
    const next = page.locator('[data-testid="look-detail-tablet-carousel-next"]');

    if ((await next.count()) === 0) {
      test.skip(true, '画像が1枚のため送りボタンなし');
    }

    const carouselBox = await carousel.boundingBox();
    const nextBox = await next.boundingBox();
    expect(carouselBox).not.toBeNull();
    expect(nextBox).not.toBeNull();
    if (!carouselBox || !nextBox) return;

    const carouselCenter = carouselBox.y + carouselBox.height / 2;
    const buttonCenter = nextBox.y + nextBox.height / 2;
    expect(Math.abs(carouselCenter - buttonCenter)).toBeLessThanOrEqual(2);
  });

  // AC-03: PC のメイン画像枠は 2:3 で viewport 内に収まり、情報列は画像と同じ幅
  test('desktop 画像枠が 2:3 で viewport に収まり情報列が画像と同幅', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoFirstLookDetail(page);

    const frame = page.locator('[data-testid="look-detail-main-image-frame"]');
    await expect(frame).toBeVisible();

    const frameBox = await frame.boundingBox();
    const infoBox = await page
      .locator('[data-testid="look-detail-layout"] > div')
      .nth(1)
      .boundingBox();
    expect(frameBox).not.toBeNull();
    expect(infoBox).not.toBeNull();
    if (!frameBox || !infoBox) return;

    const ratio = frameBox.width / frameBox.height;
    expect(ratio).toBeGreaterThan((2 / 3) * 0.98);
    expect(ratio).toBeLessThan((2 / 3) * 1.02);
    expect(frameBox.height).toBeLessThanOrEqual(800);
    expect(Math.abs(infoBox.width - frameBox.width)).toBeLessThanOrEqual(2);
  });
});
