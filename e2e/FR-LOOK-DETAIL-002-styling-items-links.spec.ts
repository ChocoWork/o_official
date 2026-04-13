import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

test.describe('FR-LOOK-DETAIL-002 STYLING ITEMS', () => {
  test('紐づけ商品一覧と商品遷移リンクを表示する', async ({ page }) => {
    await gotoFirstLookDetail(page);

    await expect(page.getByText('STYLING ITEMS')).toBeVisible();

    const itemLinks = page.locator('a[href^="/item/"]');
    const itemLinkCount = await itemLinks.count();

    if (itemLinkCount > 0) {
      await expect(itemLinks.first()).toBeVisible();
    } else {
      await expect(page.getByText('紐づけ商品はありません')).toBeVisible();
    }
  });
});
