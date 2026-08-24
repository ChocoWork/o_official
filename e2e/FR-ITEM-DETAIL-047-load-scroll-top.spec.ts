import { expect, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-297: ITEM詳細ページは最上部にスクロールした状態で読み込まれること

const item = sampleItemDetail({});

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-047 読み込み位置 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('読み込み直後のスクロール位置が最上部であること', async ({ page }) => {
      await mockCartApis(page, []);
      await mockItemDetailApis(page, item, []);
      await page.goto('/item/101');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });

    test('スクロール後にリロードしても最上部で読み込まれること', async ({
      page,
    }) => {
      await mockCartApis(page, []);
      await mockItemDetailApis(page, item, []);
      await page.goto('/item/101');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      await page.evaluate(() => window.scrollTo(0, 400));
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });
  });
}
