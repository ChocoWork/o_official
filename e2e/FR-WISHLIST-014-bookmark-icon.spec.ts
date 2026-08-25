import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  mockWishlistApis,
  sampleItemDetail,
  sampleWishlistItem,
} from './shop-test-utils';

// FREQ-302: ウィッシュリストのアイコンをハートからブックマークに差し替える

const RED = 'rgb(239, 68, 68)';

const item = sampleItemDetail({ name: 'Short Sleeveless Vest' });

async function openItemDetail(page: Page, wishlisted: boolean): Promise<void> {
  await mockCartApis(page, []);
  await mockWishlistApis(
    page,
    wishlisted ? [sampleWishlistItem({ item_id: item.id })] : [],
  );
  await mockItemDetailApis(page, item, []);
  await page.goto(`/item/${item.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-WISHLIST-014 ブックマークアイコン (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-302-AC-01: ハートが無くなり未登録はブックマークの線アイコンになる', async ({
      page,
    }) => {
      await openItemDetail(page, false);

      await expect(page.locator('i.ri-heart-line, i.ri-heart-fill')).toHaveCount(
        0,
      );
      // md+ 専用のアイコンは mobile では hidden なので、表示中のものを見る
      await expect(page.locator('i.ri-bookmark-line:visible').first()).toBeVisible();

      // ヘッダーのウィッシュリストリンク
      await expect(
        page.locator('a[href="/wishlist"] i.ri-bookmark-line').first(),
      ).toBeVisible();
    });

    test('FREQ-302-AC-02/AC-03: 登録済みは塗りアイコンで、色は赤ではない', async ({
      page,
    }) => {
      await openItemDetail(page, true);

      const filled = page.locator('i.ri-bookmark-fill:visible').first();
      await expect(filled).toBeVisible();

      const color = await filled.evaluate(
        (el) => getComputedStyle(el).color,
      );
      expect(color).not.toBe(RED);
    });

    test('FREQ-302-AC-01: ウィッシュリスト空状態のアイコンもブックマークになる', async ({
      page,
    }) => {
      await page.route('**/api/wishlist', async (route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '[]',
        });
      });
      await page.goto('/wishlist');

      const emptyIcon = page.locator('.empty-page__icon');
      await expect(emptyIcon).toBeVisible();
      await expect(emptyIcon).toHaveClass(/ri-bookmark-line/);
      await expect(page.locator('i.ri-heart-line, i.ri-heart-fill')).toHaveCount(
        0,
      );
    });
  });
}
