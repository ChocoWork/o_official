import { expect, Page, test } from '@playwright/test';
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

test.describe('FR-ITEM-DETAIL-037 thumbnail ring width', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('FREQ-175-AC-01: 選択中サムネイルのリングが1pxである', async ({
      page,
    }) => {
      await openItemDetail(page);

      const second = page
        .getByTestId('item-detail-thumbnail-list')
        .locator('button')
        .nth(1);
      await second.click();
      await expect(second).toHaveClass(/ring-1/);

      // Tailwind の ring は box-shadow で描画される（広がり 1px の黒）
      const boxShadow = await second.evaluate(
        (el) => getComputedStyle(el).boxShadow,
      );
      expect(boxShadow).toContain('0px 0px 0px 1px');
    });
  });

  for (const viewport of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ]) {
    test(`FREQ-175-AC-02: ${viewport.name}（${viewport.width}px）では縦サムネイルが表示されない`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await openItemDetail(page);

      await expect(page.getByTestId('item-detail-thumbnail-list')).toBeHidden();
    });
  }
});
