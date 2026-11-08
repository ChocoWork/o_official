import { expect, test } from '@playwright/test';
import { mockCartApis, mockItemDetailApis, sampleItemDetail } from './shop-test-utils';

test.describe('FR-ITEM-DETAIL-001/002/003/010 item detail core ui', () => {
  test('商品データ読み込み後に画像・選択 UI を表示し、パンくずは表示しない', async ({ page }) => {
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

    // FR-ITEM-DETAIL-010（2026-11-07 改定）: パンくずは 2026-07 に削除済みで、表示されない
    await expect(page.getByRole('navigation', { name: /breadcrumb/i })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Silk Blouse' })).toBeVisible();
    await expect(page.getByText('¥12,000')).toBeVisible();
    // FREQ-292: COLOR / SIZE のラベル、FREQ-154: QUANTITY は表示しない
    await expect(page.getByText('COLOR', { exact: true })).toHaveCount(0);
    await expect(page.getByText('SIZE', { exact: true })).toHaveCount(0);
    await expect(page.getByText('QUANTITY')).toHaveCount(0);

    // FREQ-345: 選択肢が2つ以上ある軸は未選択から始まり、押すと選択される
    const options = page.getByTestId('item-spec-table');
    await expect(options.getByRole('button', { name: 'Black', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await options.getByRole('button', { name: 'Black', exact: true }).click();
    await expect(options.getByRole('button', { name: 'Black', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await options.getByRole('button', { name: 'M', exact: true }).click();
    await expect(options.getByRole('button', { name: 'M', exact: true })).toHaveAttribute('aria-pressed', 'true');

    const thumbnails = page.locator('button[aria-label*="枚目を表示"]');
    await expect(thumbnails).toHaveCount(3);
    await thumbnails.nth(1).click();
    await expect(page.locator('img[alt="Silk Blouse - Black - 2枚目"]').last()).toBeVisible();
  });
});