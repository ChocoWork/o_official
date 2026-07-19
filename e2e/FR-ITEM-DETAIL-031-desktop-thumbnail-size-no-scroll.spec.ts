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

test.describe('FR-ITEM-DETAIL-031 desktop thumbnail size and no scroll', () => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
  ]) {
    test.describe(`${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport });

      test('FREQ-169-AC-01: サムネイルが64px幅・2:3比率で表示される', async ({
        page,
      }) => {
        await openItemDetail(page);

        const thumbnails = page
          .getByTestId('item-detail-thumbnail-list')
          .locator('button');
        await expect(thumbnails).toHaveCount(3);

        const first = await box(thumbnails.first());
        expect(first.width).toBeCloseTo(64, 0);
        expect(first.width / first.height).toBeCloseTo(2 / 3, 2);
      });

      test('FREQ-169-AC-02: サムネイル列にスクロールバーが表示されない', async ({
        page,
      }) => {
        await openItemDetail(page);

        const list = page.getByTestId('item-detail-thumbnail-list');
        await expect(list).toBeVisible();

        const overflow = await list.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY: getComputedStyle(el).overflowY,
        }));
        expect(overflow.overflowY).toBe('visible');
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
        expect(overflow.scrollHeight).toBeLessThanOrEqual(
          overflow.clientHeight,
        );
      });

      test('FREQ-169-AC-03: 選択中サムネイルのringを含む右端が欠けない', async ({
        page,
      }) => {
        await openItemDetail(page);

        const list = page.getByTestId('item-detail-thumbnail-list');
        const second = list.locator('button').nth(1);
        await second.click();
        await expect(second).toHaveClass(/ring-2/);

        const listBox = await box(list);
        const secondBox = await box(second);
        // ring-2 はボタンの外側2pxに描画されるため、その分を含めて列内に収まること
        expect(secondBox.x + secondBox.width + 2).toBeLessThanOrEqual(
          listBox.x + listBox.width + 0.5,
        );
      });
    });
  }
});
