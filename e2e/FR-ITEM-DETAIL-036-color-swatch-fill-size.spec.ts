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

test.describe('FR-ITEM-DETAIL-036 color swatch fill size', () => {
  for (const viewport of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    test(`FREQ-296: ${viewport.name}（${viewport.width}px）でスウォッチが外形23px・塗り19pxである`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await openItemDetail(page);

      const swatch = page
        .getByTestId('item-spec-table')
        .locator('button[aria-label]')
        .first();
      await expect(swatch).toBeVisible();

      // AC-01: 外形は 23×23px（1px 枠 + 1px 余白）
      const swatchBox = await box(swatch);
      expect(swatchBox.width).toBeCloseTo(23, 0);
      expect(swatchBox.height).toBeCloseTo(23, 0);

      // AC-02: 内側の塗りつぶし四角が 19×19px
      const fillBox = await box(swatch.locator('span'));
      expect(fillBox.width).toBeCloseTo(19, 0);
      expect(fillBox.height).toBeCloseTo(19, 0);
    });
  }
});
