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

test.describe('FR-ITEM-DETAIL-030 desktop centered columns', () => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test(`FREQ-168-AC-01/02: ${viewport.width}x${viewport.height}で画像と情報欄が56px間隔で中央に配置される`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openItemDetail(page);

      const mainImage = await box(
        page.getByTestId('item-detail-main-image-frame'),
      );
      const information = await box(
        page.getByTestId('item-detail-information'),
      );
      const imageColumn = await box(
        page.getByTestId('item-detail-desktop-images'),
      );

      // AC-01: 画像枠右端 ↔ 情報欄左端の間隔が約56px（近接）
      const gap = information.x - (mainImage.x + mainImage.width);
      expect(gap).toBeGreaterThanOrEqual(54);
      expect(gap).toBeLessThanOrEqual(58);

      // AC-02: 2カラム全体が水平中央に配置される（整列）
      const clientWidth = await page.evaluate(
        () => document.documentElement.clientWidth,
      );
      const pairCenter =
        (imageColumn.x + information.x + information.width) / 2;
      expect(Math.abs(pairCenter - clientWidth / 2)).toBeLessThanOrEqual(8);
    });
  }

  test('FREQ-168-AC-03: tablet（768px）では従来の58%/42%2カラムが維持される', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await openItemDetail(page);

    const layout = await box(page.getByTestId('item-detail-layout'));
    const imageColumn = await box(
      page.getByTestId('item-detail-desktop-images'),
    );

    // 画像列の右端 = レイアウト左端 + 58%
    const expectedBoundary = layout.x + layout.width * 0.58;
    expect(
      Math.abs(imageColumn.x + imageColumn.width - expectedBoundary),
    ).toBeLessThanOrEqual(2);
  });

  test('FREQ-168-AC-03: mobile（390px）では画像の下に情報欄の1カラムが維持される', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openItemDetail(page);

    const carousel = await box(page.getByTestId('item-detail-carousel'));
    const information = await box(
      page.getByTestId('item-detail-information'),
    );

    expect(information.y).toBeGreaterThanOrEqual(
      carousel.y + carousel.height - 1,
    );
  });
});
