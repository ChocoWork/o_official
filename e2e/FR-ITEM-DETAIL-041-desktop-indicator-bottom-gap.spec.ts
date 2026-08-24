import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-289: lg 以上で viewport 高さが低いとき、画像下のセグメント線インジケータが
// 画面下端すれすれに出ていた。画像枠の高さ上限を min(48rem, 100svh-6rem) にして、
// md 帯と同じくインジケータと画面下端の間に余白を持たせる。

const item = sampleItemDetail({
  image_url: '/original.jpg',
  image_urls: ['/original.jpg', '/mainphoto.png', '/about.png'],
});

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

// 縦の狭い PC。画像高さは 100svh-6rem が効く（48rem=768px より小さい）
const SHORT_DESKTOP = { width: 1280, height: 725 };

test.describe('FR-ITEM-DETAIL-041 PC で画像インジケータと画面下端の間に余白を確保する', () => {
  // AC-01: ITEM 詳細でインジケータの下端が viewport 下端より 12px 以上上にある
  test('ITEM 詳細（縦が狭い PC）', async ({ page }) => {
    await page.setViewportSize(SHORT_DESKTOP);
    await openItemDetail(page);

    const indicator = page.locator(
      '[data-testid="item-detail-main-image-indicator"]',
    );
    await expect(indicator).toBeVisible();
    const indicatorBox = await indicator.boundingBox();
    expect(indicatorBox).not.toBeNull();
    if (!indicatorBox) return;

    expect(indicatorBox.y + indicatorBox.height).toBeLessThanOrEqual(
      SHORT_DESKTOP.height - 12,
    );
  });

  // AC-02: LOOK 詳細でも同じ余白が確保される
  test('LOOK 詳細（縦が狭い PC）', async ({ page }) => {
    await page.setViewportSize(SHORT_DESKTOP);
    await gotoFirstLookDetail(page);

    const indicator = page.locator(
      '[data-testid="look-detail-main-image-indicator"]',
    );
    if ((await indicator.count()) === 0) {
      test.skip(true, '画像が1枚のためインジケータなし');
    }
    await expect(indicator).toBeVisible();
    const indicatorBox = await indicator.boundingBox();
    expect(indicatorBox).not.toBeNull();
    if (!indicatorBox) return;

    expect(indicatorBox.y + indicatorBox.height).toBeLessThanOrEqual(
      SHORT_DESKTOP.height - 12,
    );
  });
});
