import { expect, Locator, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

const item = sampleItemDetail({
  image_url: '/original.jpg',
  image_urls: ['/original.jpg', '/mainphoto.png'],
});

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

test.describe('FR-ITEM-DETAIL-029 desktop main image viewport fit', () => {
  for (const viewport of [
    { width: 1024, height: 600 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    test(`FREQ-167: ${viewport.width}x${viewport.height}でメイン画像が1画面内に収まる`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openItemDetail(page);

      const mainImage = await box(
        page.getByTestId('item-detail-main-image-frame'),
      );

      expect(mainImage.width / mainImage.height).toBeCloseTo(2 / 3, 2);
      expect(mainImage.y).toBeGreaterThanOrEqual(0);
      expect(mainImage.y + mainImage.height).toBeLessThanOrEqual(
        viewport.height,
      );
    });
  }
});
