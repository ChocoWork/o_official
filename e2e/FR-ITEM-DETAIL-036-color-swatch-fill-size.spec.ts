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
    test(`FREQ-174: ${viewport.name}（${viewport.width}px）で外枠24pxのまま塗り四角が約16pxである`, async ({
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

      // AC-01: 外枠は 24×24px のまま
      const swatchBox = await box(swatch);
      expect(swatchBox.width).toBeCloseTo(24, 0);
      expect(swatchBox.height).toBeCloseTo(24, 0);

      // AC-02: 内側の塗りつぶし四角が約 16×16px
      const fillBox = await box(swatch.locator('span'));
      expect(fillBox.width).toBeCloseTo(16, 0);
      expect(fillBox.height).toBeCloseTo(16, 0);
    });
  }
});
