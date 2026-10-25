import { expect, test } from '@playwright/test';
import { SEED_STOCKISTS, stockistCardByName } from './stockist-test-utils';

test.describe('FR-STOCKIST-001 カタログ表示', () => {
  test('FREQ-13-AC-01 公開済みストックリストをレスポンシブグリッドで表示する', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto('/stockist');

    // 正しい店舗情報: 手元の見本の公開の店が、店名と住所つきで出る
    for (const shop of SEED_STOCKISTS) {
      const card = stockistCardByName(page, shop.name);
      await expect(card, shop.name).toHaveCount(1);
      await expect(card.getByRole('link', { name: shop.address, exact: true }), shop.address).toBeVisible();
    }
    // エラーが発生せず
    expect(pageErrors).toEqual([]);
  });
});
