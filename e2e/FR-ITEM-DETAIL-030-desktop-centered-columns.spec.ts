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
      // FREQ-286: 幅に余裕があるデスクトップでは情報列を画像と同じ幅にする。
      expect(information.width).toBeCloseTo(mainImage.width, 0);

      // AC-02: 2カラム全体が水平中央に配置される（整列）
      const clientWidth = await page.evaluate(
        () => document.documentElement.clientWidth,
      );
      const pairCenter =
        (imageColumn.x + information.x + information.width) / 2;
      expect(Math.abs(pairCenter - clientWidth / 2)).toBeLessThanOrEqual(8);
    });
  }

  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 918, height: 815 },
  ]) {
    test(`FREQ-168-AC-03 / FREQ-286: tablet（${viewport.width}px）では画像上限と2:3比率・32px余白を守り見切れない`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openItemDetail(page);

      const mainImage = await box(
        page.getByTestId('item-detail-tablet-carousel-slide').first(),
      );
      const information = await box(page.getByTestId('item-detail-information'));
      const dimensions = await page.getByTestId('item-detail-layout').evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
          contentWidth: element.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        };
      });
      const imageWidthLimit = Math.min(
        32 * dimensions.rem,
        dimensions.contentWidth * 0.56,
        (viewport.height - 6 * dimensions.rem) * 2 / 3,
      );
      // 従来の幅境界の許容差2pxを保ち、FREQ-286の幅上限に照合する。
      expect(Math.abs(mainImage.width - imageWidthLimit)).toBeLessThanOrEqual(2);
      expect(mainImage.width / mainImage.height).toBeCloseTo(2 / 3, 2);
      expect(mainImage.y).toBeGreaterThanOrEqual(0);
      expect(mainImage.y + mainImage.height).toBeLessThanOrEqual(viewport.height);
      expect(information.x - (mainImage.x + mainImage.width)).toBeCloseTo(32, 0);
      expect(viewport.width - (information.x + information.width)).toBeCloseTo(32, 0);
      const widths = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    });
  }

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
