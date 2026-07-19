import { expect, Locator, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

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

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

test.describe('FR-ITEM-DETAIL-035 tablet prev arrow spacing', () => {
  test.describe('tablet 768x1024', () => {
    test.use({ viewport: { width: 768, height: 1024 } });

    test('FREQ-173-AC-01/02: 前ボタンの左に20px、次ボタンの右は8pxのまま', async ({
      page,
    }) => {
      await openItemDetail(page);

      const carousel = page.getByTestId('item-detail-tablet-carousel');
      const next = page.getByTestId('item-detail-tablet-carousel-next');
      await next.click();
      const prev = page.getByTestId('item-detail-tablet-carousel-prev');
      await expect(prev).toBeVisible();

      const carouselBox = await box(carousel);
      const prevBox = await box(prev);
      const nextBox = await box(next);

      expect(prevBox.x - carouselBox.x).toBeCloseTo(20, 0);
      expect(
        carouselBox.x + carouselBox.width - (nextBox.x + nextBox.width),
      ).toBeCloseTo(8, 0);
    });
  });

  for (const viewport of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    test(`FREQ-173-AC-03: ${viewport.name}（${viewport.width}px）では前後ボタンが表示されない`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await openItemDetail(page);

      await expect(
        page.getByTestId('item-detail-tablet-carousel-prev'),
      ).toBeHidden();
      await expect(
        page.getByTestId('item-detail-tablet-carousel-next'),
      ).toBeHidden();
    });
  }
});
