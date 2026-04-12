import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-008 メタデータ', () => {
  test('ITEMページにtitle/descriptionが設定される', async ({ page }) => {
    await gotoItemList(page);

    await expect(page).toHaveTitle(/ITEM|Le Fil des Heures/i);
    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute('content', /.+/);
  });
});
