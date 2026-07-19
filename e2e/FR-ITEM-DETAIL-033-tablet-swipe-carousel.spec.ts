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

test.describe('FR-ITEM-DETAIL-033 tablet swipe carousel', () => {
  test.describe('tablet 768x1024', () => {
    test.use({ viewport: { width: 768, height: 1024 } });

    test('FREQ-171-AC-01: 画像列内にカルーセルが表示され、スライドが画像数分・2:3比率である', async ({
      page,
    }) => {
      await openItemDetail(page);

      const carousel = page.getByTestId('item-detail-tablet-carousel');
      await expect(carousel).toBeVisible();

      const slides = page.getByTestId('item-detail-tablet-carousel-slide');
      await expect(slides).toHaveCount(3);

      const first = await box(slides.first());
      expect(first.width / first.height).toBeCloseTo(2 / 3, 2);

      // 画像列（desktop-images ブロック）内に収まっている
      const imagesBlock = await box(
        page.getByTestId('item-detail-desktop-images'),
      );
      expect(first.width).toBeLessThanOrEqual(imagesBlock.width + 0.5);
    });

    test('FREQ-171-AC-02: カルーセルが横スクロール可能でスクロールバーが非表示である', async ({
      page,
    }) => {
      await openItemDetail(page);

      const carousel = page.getByTestId('item-detail-tablet-carousel');
      const state = await carousel.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollbarWidth: getComputedStyle(el).scrollbarWidth,
        snapType: getComputedStyle(el).scrollSnapType,
      }));
      expect(state.scrollWidth).toBeGreaterThan(state.clientWidth);
      expect(state.scrollbarWidth).toBe('none');
      expect(state.snapType).toContain('x');

      // スクロールで2枚目のスライドが表示位置に来る
      const slideWidth = await page
        .getByTestId('item-detail-tablet-carousel-slide')
        .first()
        .evaluate((el) => (el as HTMLElement).offsetWidth);
      await carousel.evaluate((el, left) => el.scrollTo({ left }), slideWidth);
      await expect
        .poll(async () => carousel.evaluate((el) => el.scrollLeft))
        .toBeGreaterThan(0);
    });

    test('FREQ-171-AC-03: モバイルカルーセルと縦サムネイル列は表示されない', async ({
      page,
    }) => {
      await openItemDetail(page);

      await expect(page.getByTestId('item-detail-carousel')).toBeHidden();
      await expect(page.getByTestId('item-detail-thumbnail-list')).toBeHidden();
      await expect(
        page.getByTestId('item-detail-main-image-frame'),
      ).toBeHidden();
    });
  });

  test.describe('mobile 390x844', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('FREQ-171-AC-03: モバイルは従来のカルーセルが表示され、タブレット用カルーセルは表示されない', async ({
      page,
    }) => {
      await openItemDetail(page);

      await expect(page.getByTestId('item-detail-carousel')).toBeVisible();
      await expect(
        page.getByTestId('item-detail-tablet-carousel'),
      ).toBeHidden();
    });
  });

  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('FREQ-171-AC-03: desktopは縦サムネイル＋静的メイン画像で、タブレット用カルーセルは表示されない', async ({
      page,
    }) => {
      await openItemDetail(page);

      await expect(
        page.getByTestId('item-detail-thumbnail-list'),
      ).toBeVisible();
      await expect(
        page.getByTestId('item-detail-main-image-frame'),
      ).toBeVisible();
      await expect(
        page.getByTestId('item-detail-tablet-carousel'),
      ).toBeHidden();
    });
  });
});
