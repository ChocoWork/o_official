import { expect, test } from '@playwright/test';
import { mockCartApis, mockItemDetailApis, sampleItemDetail } from './shop-test-utils';

test.describe('FR-ITEM-DETAIL-012/013 related items and alt', () => {
  test('関連商品セクションと詳細 alt テキストを表示する', async ({ page }) => {
    const item = sampleItemDetail();
    await mockCartApis(page, []);
    await mockItemDetailApis(page, item, [
      {
        id: 202,
        name: 'Tailored Pants',
        price: 18000,
        image_url: '/images/test-item-2.jpg',
        category: 'TOPS',
      },
      {
        id: 303,
        name: 'Cashmere Cardigan',
        price: 26000,
        image_url: '/images/test-item-3.jpg',
        category: 'TOPS',
      },
    ]);

    await page.goto('/item/101');

    await expect(page.getByTestId('related-items')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'YOU MAY ALSO LIKE' })).toBeVisible();
    await expect(page.getByTestId('item-card')).toHaveCount(2);
    await expect(page.locator('img[alt="Silk Blouse - Black - 1枚目"]').last()).toBeVisible();
  });
});