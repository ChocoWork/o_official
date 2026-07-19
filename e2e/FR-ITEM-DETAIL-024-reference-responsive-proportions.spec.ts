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

    test('FREQ-162-AC-01: 20px inset and 2:3 slide', async ({
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
      expect(first.x).toBeCloseTo(20, 0);
      expect(first.width).toBeCloseTo(350, 0);
      expect(first.height).toBeCloseTo(525, 0);
      expect(second.x - (first.x + first.width)).toBeCloseTo(2, 0);

      const title = page.getByRole('heading', { level: 1 });
      const titleBox = await box(title);
      expect(titleBox.y).toBeGreaterThan(first.y + first.height);
      await expectNoHorizontalOverflow(page);
    });
  });

  test.describe('tablet 768x1024', () => {
    test.use({ viewport: { width: 768, height: 1024 } });

    test('FREQ-162-AC-02: 58/42 split and 290px information column', async ({
      page,
    }) => {
      await openItemDetail(page);

      await expect(page.getByTestId('item-detail-carousel')).toBeHidden();
      const images = page.getByTestId('item-detail-desktop-images');
      const mainImage = page.getByTestId('item-detail-main-image-frame');
      const information = page.getByTestId('item-detail-information');
      await expect(images).toBeVisible();

      const layout = await box(page.getByTestId('item-detail-layout'));
      const imageBox = await box(images);
      const mainImageBox = await box(mainImage);
      const informationBox = await box(information);
      expect(layout.x).toBeCloseTo(0, 0);
      expect(layout.width).toBeCloseTo(768, 0);
      expect(informationBox.x / layout.width).toBeCloseTo(0.601, 2);
      expect(informationBox.width).toBeCloseTo(290, 0);
      expect(imageBox.x).toBeCloseTo(-20, 0);
      expect(imageBox.width).toBeCloseTo(465, 0);
      expect(mainImageBox.width / mainImageBox.height).toBeCloseTo(2 / 3, 2);
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
          expect(slide.x).toBeCloseTo(20, 0);
          expect(slide.width).toBeCloseTo(device.width - 40, 0);
          expect(slide.width / slide.height).toBeCloseTo(2 / 3, 2);
        } else {
          await expect(
            page.getByTestId('item-detail-desktop-images'),
          ).toBeVisible();
          const layout = await box(page.getByTestId('item-detail-layout'));
          const information = await box(
            page.getByTestId('item-detail-information'),
          );
          // 1024px 以上は FREQ-168 の中央寄せグリッド（-mx-5 解除）のため
          // レイアウト幅はコンテナ幅（device.width - 40px）になる
          const expectedLayoutWidth =
            device.width >= 1024 ? device.width - 40 : device.width;
          expect(layout.width).toBeCloseTo(expectedLayoutWidth, 0);
          expect(information.x + information.width).toBeLessThanOrEqual(
            device.width,
          );
        }
        await expectNoHorizontalOverflow(page);
      });
    }
  });
});
