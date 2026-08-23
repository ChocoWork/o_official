import { expect, Locator, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-286: md 帯で画像が見切れない・中央と右端の余白が同じ・lg で情報列を画像幅まで広げる
// FREQ-287: タブレットの前後送りシェブロンを縦中央に置き、サイズを画像枠幅の比率で決める

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

const TABLET_VIEWPORTS = [
  { name: 'tablet 918x815', width: 918, height: 815 },
  { name: 'tablet 768x1024', width: 768, height: 1024 },
];

for (const viewport of TABLET_VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-286-AC-01: 画像枠の下端が viewport 内に収まる', async ({
      page,
    }) => {
      await openItemDetail(page);

      const slide = await box(
        page.getByTestId('item-detail-tablet-carousel-slide').first(),
      );
      const innerHeight = await page.evaluate(() => window.innerHeight);
      expect(slide.y + slide.height).toBeLessThanOrEqual(innerHeight);
    });

    test('FREQ-286-AC-02: 中央の隙間と右端の余白がどちらも 32px', async ({
      page,
    }) => {
      await openItemDetail(page);

      const slide = await box(
        page.getByTestId('item-detail-tablet-carousel-slide').first(),
      );
      const info = await box(page.getByTestId('item-detail-information'));
      const clientWidth = await page.evaluate(
        () => document.documentElement.clientWidth,
      );

      expect(info.x - (slide.x + slide.width)).toBeCloseTo(32, 0);
      expect(clientWidth - (info.x + info.width)).toBeCloseTo(32, 0);
    });

    test('FREQ-287-AC-01/02: シェブロンが縦中央・44px タッチターゲット・画像幅比のサイズ', async ({
      page,
    }) => {
      await openItemDetail(page);

      const carousel = await box(page.getByTestId('item-detail-tablet-carousel'));
      const next = page.getByTestId('item-detail-tablet-carousel-next');
      await expect(next).toBeVisible();
      const nextBox = await box(next);

      // 縦中央
      expect(nextBox.y + nextBox.height / 2).toBeCloseTo(
        carousel.y + carousel.height / 2,
        0,
      );
      // タッチターゲット
      expect(nextBox.width).toBeGreaterThanOrEqual(44);
      expect(nextBox.height).toBeGreaterThanOrEqual(44);

      // シェブロン自体は画像枠幅の約 4.5%、かつ従来の 24px より小さい
      const iconWidth = await next
        .locator('svg')
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(iconWidth).toBeLessThan(24);
      expect(iconWidth).toBeCloseTo(carousel.width * 0.045, 0);
    });
  });
}

const DESKTOP_VIEWPORTS = [
  { name: 'desktop 1280x800', width: 1280, height: 800 },
  { name: 'desktop 1920x1080', width: 1920, height: 1080 },
];

for (const viewport of DESKTOP_VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-286-AC-03: 情報列の幅が画像の幅と等しい', async ({ page }) => {
      await openItemDetail(page);

      const frame = await box(page.getByTestId('item-detail-main-image-frame'));
      const info = await box(page.getByTestId('item-detail-information'));
      expect(info.width).toBeCloseTo(frame.width, 0);
    });

    test('FREQ-287-AC-02: シェブロンが画像枠幅比で 15px より大きい', async ({
      page,
    }) => {
      await openItemDetail(page);

      const frame = await box(page.getByTestId('item-detail-main-image-frame'));
      const next = page.getByTestId('item-detail-main-image-next');
      await expect(next).toBeVisible();

      const iconWidth = await next
        .locator('svg')
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(iconWidth).toBeGreaterThan(15);
      expect(iconWidth).toBeCloseTo(frame.width * 0.045, 0);
    });
  });
}

test.describe('mobile 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('FREQ-287-AC-01: mobile では前後送りボタンを表示しない', async ({
    page,
  }) => {
    await openItemDetail(page);

    await expect(
      page.getByTestId('item-detail-tablet-carousel-next'),
    ).toBeHidden();
    await expect(
      page.getByTestId('item-detail-tablet-carousel-prev'),
    ).toBeHidden();
  });
});
