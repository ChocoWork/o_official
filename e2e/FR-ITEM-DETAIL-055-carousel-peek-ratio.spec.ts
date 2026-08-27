import { expect, Locator, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-307: 760px 未満のカルーセルのピーク余白と隙間を px 固定ではなく割合にする。
// 320px 時（余白 20px / 隙間 2px / スライド幅 280px）の見え方を基準とし、
// 隙間 : 余白 = 1 : 10（ssstein.com の商品ページと同じ比）を全幅で保つ。
const PEEK_RATIO = 20 / 280; // ≒ 0.0714
const SLIDE_RATIO = 0.875; // スライド幅 ÷ 画面幅
const GAP_TO_PEEK_RATIO = 2 / 20; // 0.1

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

for (const width of [320, 390, 540, 759]) {
  test.describe(`FR-ITEM-DETAIL-055 カルーセルのピーク比率 (${width}px)`, () => {
    test.use({ viewport: { width, height: 844 } });

    test('FREQ-307-AC-01: 左余白 ÷ スライド幅が 320px 時と同じ比率', async ({
      page,
    }) => {
      await openItemDetail(page);

      const slide = await box(
        page.getByTestId('item-detail-carousel-slide').first(),
      );
      expect(slide.x / slide.width).toBeCloseTo(PEEK_RATIO, 2);
    });

    test('FREQ-307-AC-02: スライド幅 ÷ 画面幅が 0.875', async ({ page }) => {
      await openItemDetail(page);

      const slide = await box(
        page.getByTestId('item-detail-carousel-slide').first(),
      );
      expect(slide.width / width).toBeCloseTo(SLIDE_RATIO, 2);
    });

    test('FREQ-307-AC-03: 2枚目の左端が画面内に見え、横スクロールしない', async ({
      page,
    }) => {
      await openItemDetail(page);

      const slides = page.getByTestId('item-detail-carousel-slide');
      const first = await box(slides.nth(0));
      const second = await box(slides.nth(1));
      expect(second.x).toBeGreaterThan(first.x + first.width - 1);
      expect(second.x).toBeLessThan(width);

      const widths = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    });

    test('FREQ-307-AC-04: 隙間 ÷ 左余白が 1:10', async ({ page }) => {
      await openItemDetail(page);

      const slides = page.getByTestId('item-detail-carousel-slide');
      const first = await box(slides.nth(0));
      const second = await box(slides.nth(1));
      const gap = second.x - (first.x + first.width);
      expect(gap / first.x).toBeCloseTo(GAP_TO_PEEK_RATIO, 2);
    });
  });
}
