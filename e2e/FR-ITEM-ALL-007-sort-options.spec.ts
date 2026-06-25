import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-007 ソート機能', () => {
  test('新着順・価格順を切り替えできる', async ({ page }) => {
    await gotoItemList(page);

    const sortTrigger = page.locator('.single-select__trigger:visible').first();

    await sortTrigger.click();
    await page.getByRole('option', { name: 'PRICE LOW TO HIGH' }).click();
    await expect(page).toHaveURL(/sort=price_asc/i);

    await sortTrigger.click();
    await page.getByRole('option', { name: 'PRICE HIGH TO LOW' }).click();
    await expect(page).toHaveURL(/sort=price_desc/i);

    await sortTrigger.click();
    await page.getByRole('option', { name: 'NEWEST' }).click();
    await expect(page).toHaveURL(/sort=newest/i);
  });
});
