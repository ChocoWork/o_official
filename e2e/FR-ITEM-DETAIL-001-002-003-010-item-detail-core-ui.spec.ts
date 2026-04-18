import { expect, test } from '@playwright/test';
import { mockCartApis, mockItemDetailApis, sampleItemDetail } from './shop-test-utils';

test.describe('FR-ITEM-DETAIL-001/002/003/010 item detail core ui', () => {
  test('商品データ読み込み後に画像・選択 UI・パンくずを表示する', async ({ page }) => {
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
    ]);

    await page.goto('/item/101');

    await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'HOME', exact: true })).toHaveAttribute('href', '/');
    await expect(page.getByRole('link', { name: 'ITEMS', exact: true })).toHaveAttribute('href', '/item');
    await expect(page.getByRole('heading', { level: 2, name: 'Silk Blouse' })).toBeVisible();
    await expect(page.getByText('¥12,000')).toBeVisible();
    await expect(page.getByText('COLOR')).toBeVisible();
    await expect(page.getByText('SIZE')).toBeVisible();
    await expect(page.getByText('QUANTITY')).toBeVisible();

    await expect(page.getByRole('button', { name: 'Black' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'M' }).click();
    await expect(page.getByRole('button', { name: 'M' })).toHaveAttribute('aria-pressed', 'true');

    const thumbnails = page.locator('button[aria-label*="枚目を表示"]');
    await expect(thumbnails).toHaveCount(3);
    await thumbnails.nth(1).click();
    await expect(page.locator('img[alt="Silk Blouse - Black - 2枚目"]').last()).toBeVisible();
  });
});