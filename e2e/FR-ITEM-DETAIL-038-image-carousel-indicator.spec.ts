import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-271: 商品画像が複数あるとき、画像下のセグメント線インジケータで現在位置を示す。
// mobile / tablet はスワイプ、desktop は左右の三角ボタンで切り替える。

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

/** 1スライド分だけ横スクロールさせ、スワイプ相当の位置に移動する */
async function scrollOneSlide(page: Page, carouselTestId: string): Promise<void> {
  await page.getByTestId(carouselTestId).evaluate((el) => {
    const first = el.children[0] as HTMLElement;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    el.scrollLeft = first.offsetWidth + gap;
  });
}

test.describe('FR-ITEM-DETAIL-038 商品画像カルーセルのインジケータと送りボタン', () => {
  test.describe('mobile 390x844', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('FREQ-271-AC-01: 画像枚数と同じ数の線が表示され、2本目を押すと2枚目が選択される', async ({
      page,
    }) => {
      await openItemDetail(page);

      const indicator = page.getByTestId('item-detail-carousel-indicator');
      await expect(indicator).toBeVisible();

      const segments = indicator.getByRole('tab');
      await expect(segments).toHaveCount(item.image_urls!.length);
      await expect(segments.nth(0)).toHaveAttribute('data-active', 'true');

      await segments.nth(1).click();
      await expect(segments.nth(1)).toHaveAttribute('data-active', 'true');
      await expect(segments.nth(0)).toHaveAttribute('data-active', 'false');
    });

    test('FREQ-271-AC-02: 横スワイプするとインジケータの選択位置が次へ移る', async ({
      page,
    }) => {
      await openItemDetail(page);

      await scrollOneSlide(page, 'item-detail-carousel');

      const segments = page
        .getByTestId('item-detail-carousel-indicator')
        .getByRole('tab');
      await expect(segments.nth(1)).toHaveAttribute('data-active', 'true');
    });
  });

  test.describe('tablet 768x1024', () => {
    test.use({ viewport: { width: 768, height: 1024 } });

    test('FREQ-271-AC-01: 画像枚数と同じ数の線が表示され、3本目を押すと3枚目が選択される', async ({
      page,
    }) => {
      await openItemDetail(page);

      const indicator = page.getByTestId(
        'item-detail-tablet-carousel-indicator',
      );
      await expect(indicator).toBeVisible();

      const segments = indicator.getByRole('tab');
      await expect(segments).toHaveCount(item.image_urls!.length);

      await segments.nth(2).click();
      await expect(segments.nth(2)).toHaveAttribute('data-active', 'true');
    });

    test('FREQ-271-AC-02: 横スワイプするとインジケータの選択位置が次へ移る', async ({
      page,
    }) => {
      await openItemDetail(page);

      await scrollOneSlide(page, 'item-detail-tablet-carousel');

      const segments = page
        .getByTestId('item-detail-tablet-carousel-indicator')
        .getByRole('tab');
      await expect(segments.nth(1)).toHaveAttribute('data-active', 'true');
    });
  });

  test.describe('desktop 1280x900', () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test('FREQ-271-AC-03: 初期表示は次ボタンのみ。押すと2枚目が選択され前ボタンが現れる', async ({
      page,
    }) => {
      await openItemDetail(page);

      const next = page.getByTestId('item-detail-main-image-next');
      const prev = page.getByTestId('item-detail-main-image-prev');
      await expect(next).toBeVisible();
      await expect(prev).toHaveCount(0);

      await next.click();

      const segments = page
        .getByTestId('item-detail-main-image-indicator')
        .getByRole('tab');
      await expect(segments.nth(1)).toHaveAttribute('data-active', 'true');
      await expect(prev).toBeVisible();
    });

    test('FREQ-271-AC-01: 画像下に画像枚数と同じ数の線が表示される', async ({
      page,
    }) => {
      await openItemDetail(page);

      const indicator = page.getByTestId('item-detail-main-image-indicator');
      await expect(indicator).toBeVisible();
      await expect(indicator.getByRole('tab')).toHaveCount(
        item.image_urls!.length,
      );
    });
  });
});
