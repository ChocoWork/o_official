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

test.describe('FR-ITEM-DETAIL-034 tablet carousel arrows', () => {
  test.describe('tablet 768x1024', () => {
    test.use({ viewport: { width: 768, height: 1024 } });

    test('FREQ-172-AC-01: 初期表示で右下に次ボタンが表示され、前ボタンは表示されない', async ({
      page,
    }) => {
      await openItemDetail(page);

      const next = page.getByTestId('item-detail-tablet-carousel-next');
      await expect(next).toBeVisible();
      await expect(
        page.getByTestId('item-detail-tablet-carousel-prev'),
      ).toBeHidden();

      // 画像（カルーセル表示領域）の右下に配置されている
      const carousel = await box(
        page.getByTestId('item-detail-tablet-carousel'),
      );
      const nextBox = await box(next);
      expect(nextBox.x + nextBox.width).toBeLessThanOrEqual(
        carousel.x + carousel.width,
      );
      expect(nextBox.x).toBeGreaterThan(carousel.x + carousel.width / 2);
      expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(
        carousel.y + carousel.height,
      );
      expect(nextBox.y).toBeGreaterThan(carousel.y + carousel.height / 2);

      // タッチターゲット 44px 以上
      expect(nextBox.width).toBeGreaterThanOrEqual(44);
      expect(nextBox.height).toBeGreaterThanOrEqual(44);
    });

    test('FREQ-172-AC-02: 次ボタンでスライドが送られ、前ボタンが左下に表示される。末尾では次ボタンが消える', async ({
      page,
    }) => {
      await openItemDetail(page);

      const carousel = page.getByTestId('item-detail-tablet-carousel');
      const next = page.getByTestId('item-detail-tablet-carousel-next');
      const prev = page.getByTestId('item-detail-tablet-carousel-prev');

      await next.click();
      await expect
        .poll(async () => carousel.evaluate((el) => el.scrollLeft))
        .toBeGreaterThan(0);
      await expect(prev).toBeVisible();

      // 前ボタンは左下に配置されている
      const carouselBox = await box(carousel);
      const prevBox = await box(prev);
      expect(prevBox.x).toBeGreaterThanOrEqual(carouselBox.x);
      expect(prevBox.x + prevBox.width).toBeLessThan(
        carouselBox.x + carouselBox.width / 2,
      );
      expect(prevBox.y).toBeGreaterThan(carouselBox.y + carouselBox.height / 2);

      // 末尾（3枚目)へ送ると次ボタンが消える
      await next.click();
      await expect(next).toBeHidden();
      await expect(prev).toBeVisible();

      // 前ボタンで戻れる
      await prev.click();
      await expect(next).toBeVisible();
    });
  });

  test.describe('mobile 390x844', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('FREQ-172-AC-03: mobileでは前後ボタンが表示されない', async ({
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

  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('FREQ-172-AC-03: desktopでは前後ボタンが表示されない', async ({
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
});
