import { expect, Locator, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

const item = sampleItemDetail({
  name: 'DEFORMATION WIDE COLOR DENIM PANTS',
  price: 48400,
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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

test.describe('FR-ITEM-DETAIL-024 reference responsive proportions', () => {
  test.describe('mobile 390x844', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    // FREQ-307: 左右余白は 20px 固定から画面幅比 6.25% に変更
    test('FREQ-162-AC-01: 6.25% inset and 2:3 slide', async ({
      page,
    }) => {
      await openItemDetail(page);

      const carousel = page.getByTestId('item-detail-carousel');
      const slides = page.getByTestId('item-detail-carousel-slide');
      await expect(carousel).toBeVisible();
      await expect(page.getByTestId('item-detail-desktop-images')).toBeHidden();

      const carouselBox = await box(carousel);
      const first = await box(slides.nth(0));
      const second = await box(slides.nth(1));
      expect(carouselBox.x).toBeCloseTo(0, 0);
      expect(carouselBox.width).toBeCloseTo(390, 0);
      expect(first.x).toBeCloseTo(390 * 0.0625, 0);
      expect(first.width).toBeCloseTo(390 * 0.875, 0);
      expect(first.height).toBeCloseTo(390 * 0.875 * 1.5, 0);
      expect(second.x - (first.x + first.width)).toBeCloseTo(390 * 0.00625, 0);

      const title = page.getByRole('heading', { level: 1 });
      const titleBox = await box(title);
      expect(titleBox.y).toBeGreaterThan(first.y + first.height);
      await expectNoHorizontalOverflow(page);
    });
  });

  test.describe('tablet 768x1024', () => {
    test.use({ viewport: { width: 768, height: 1024 } });

    test('FREQ-162-AC-02 / FREQ-286: bounded image column and equal 32px gaps', async ({
      page,
    }) => {
      await openItemDetail(page);

      await expect(page.getByTestId('item-detail-carousel')).toBeHidden();
      const images = page.getByTestId('item-detail-desktop-images');
      // タブレット帯のメイン画像は FREQ-171 でスワイプカルーセルに置換
      const mainImage = page
        .getByTestId('item-detail-tablet-carousel-slide')
        .first();
      const information = page.getByTestId('item-detail-information');
      await expect(images).toBeVisible();

      const layout = await box(page.getByTestId('item-detail-layout'));
      const imageBox = await box(images);
      const mainImageBox = await box(mainImage);
      const informationBox = await box(information);
      const dimensions = await page.getByTestId('item-detail-layout').evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
          contentWidth: element.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        };
      });
      expect(layout.x).toBeCloseTo(0, 0);
      const imageWidthLimit = Math.min(
        32 * dimensions.rem,
        dimensions.contentWidth * 0.56,
        (1024 - 6 * dimensions.rem) * 2 / 3,
      );
      expect(imageBox.x - layout.x).toBeCloseTo(-20, 0);
      expect(mainImageBox.width).toBeCloseTo(imageWidthLimit, 0);
      expect(imageBox.width).toBeCloseTo(mainImageBox.width, 0);
      expect(informationBox.width).toBeGreaterThanOrEqual(18.125 * dimensions.rem);
      expect(informationBox.x - (mainImageBox.x + mainImageBox.width)).toBeCloseTo(32, 0);
      expect(768 - (informationBox.x + informationBox.width)).toBeCloseTo(32, 0);
      expect(mainImageBox.width / mainImageBox.height).toBeCloseTo(2 / 3, 2);
      expect(mainImageBox.y).toBeGreaterThanOrEqual(0);
      expect(mainImageBox.y + mainImageBox.height).toBeLessThanOrEqual(1024);
      await expect(page.getByTestId('item-detail-first-view')).toHaveCSS(
        'min-height',
        '960px',
      );

      await expectNoHorizontalOverflow(page);
    });
  });

  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    // 58/42 分割・情報欄幅指定は FREQ-168（中央寄せ2カラム）で置換。
    // 本テストは残存要件（縦サムネイル表示・2:3比率・非オーバーフロー）のみ検証する
    test('FREQ-162-AC-03: existing vertical thumbnails beside main image', async ({
      page,
    }) => {
      await openItemDetail(page);

      const mainImage = await box(page.getByTestId('item-detail-main-image-frame'));
      expect(mainImage.width / mainImage.height).toBeCloseTo(2 / 3, 2);

      const thumbnails = page
        .getByTestId('item-detail-desktop-images')
        .locator('button[aria-label*="枚目を表示"]');
      await expect(thumbnails).toHaveCount(3);
      const firstThumbnail = await box(thumbnails.first());
      expect(firstThumbnail.x + firstThumbnail.width).toBeLessThan(mainImage.x);
      await expectNoHorizontalOverflow(page);
    });
  });

  test('FREQ-162-AC-04: all requested device widths keep the intended breakpoint without overflow', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const devices = [
      { name: 'iPhone SE', width: 375, height: 667 },
      { name: 'iPhone XR', width: 414, height: 896 },
      { name: 'iPhone 12 Pro', width: 390, height: 844 },
      { name: '768px breakpoint - 1', width: 767, height: 1024 },
      { name: 'iPhone 14 Pro Max', width: 430, height: 932 },
      { name: 'Pixel 7', width: 412, height: 915 },
      { name: 'Galaxy S8+', width: 360, height: 740 },
      { name: 'Galaxy S20 Ultra', width: 412, height: 915 },
      { name: 'iPad Mini', width: 768, height: 1024 },
      { name: 'iPad Air', width: 820, height: 1180 },
      { name: 'iPad Pro', width: 1024, height: 1366 },
      { name: 'Surface Pro 7', width: 912, height: 1368 },
      { name: 'Surface Duo', width: 540, height: 720 },
      { name: 'Galaxy Z Fold 5', width: 344, height: 882 },
      { name: 'Asus Zenbook Fold', width: 853, height: 1280 },
      { name: 'Galaxy A51/71', width: 412, height: 914 },
    ];

    await mockCartApis(page, []);
    await mockItemDetailApis(page, item, []);

    for (const device of devices) {
      await test.step(device.name, async () => {
        await page.setViewportSize({ width: device.width, height: device.height });
        await page.goto('/item/101');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

        if (device.width < 768) {
          const slide = await box(
            page.getByTestId('item-detail-carousel-slide').first(),
          );
          await expect(page.getByTestId('item-detail-carousel')).toBeVisible();
          await expect(page.getByTestId('item-detail-desktop-images')).toBeHidden();
          expect(slide.x).toBeCloseTo(device.width * 0.0625, 0);
          expect(slide.width).toBeCloseTo(device.width * 0.875, 0);
          expect(slide.width / slide.height).toBeCloseTo(2 / 3, 2);
          const information = await box(page.getByTestId('item-detail-information'));
          expect(information.y).toBeGreaterThanOrEqual(slide.y + slide.height);
        } else {
          await expect(
            page.getByTestId('item-detail-desktop-images'),
          ).toBeVisible();
          await expect(page.getByTestId('item-detail-carousel')).toBeHidden();
          const mainImage = await box(
            device.width < 1024
              ? page.getByTestId('item-detail-tablet-carousel-slide').first()
              : page.getByTestId('item-detail-main-image-frame'),
          );
          const information = await box(
            page.getByTestId('item-detail-information'),
          );
          // FREQ-286 後はコンテナの固定幅でなく、768px境界の2列配置と画像上限を検証する。
          expect(mainImage.x + mainImage.width).toBeLessThan(information.x);
          expect(mainImage.width / mainImage.height).toBeCloseTo(2 / 3, 2);
          expect(mainImage.y).toBeGreaterThanOrEqual(0);
          expect(mainImage.y + mainImage.height).toBeLessThanOrEqual(device.height);
          if (device.width < 1024) {
            const dimensions = await page.getByTestId('item-detail-layout').evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
                contentWidth: element.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
              };
            });
            expect(mainImage.width).toBeCloseTo(Math.min(
              32 * dimensions.rem,
              dimensions.contentWidth * 0.56,
              (device.height - 6 * dimensions.rem) * 2 / 3,
            ), 0);
            expect(information.x - (mainImage.x + mainImage.width)).toBeCloseTo(32, 0);
            expect(device.width - (information.x + information.width)).toBeCloseTo(32, 0);
          }
          expect(information.x + information.width).toBeLessThanOrEqual(
            device.width,
          );
        }
        await expectNoHorizontalOverflow(page);
      });
    }
  });
});
