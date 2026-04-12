import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-007 ソート機能', () => {
  test('新着順・価格順を切り替えできる', async ({ page }) => {
    await gotoItemList(page);

    await page.getByLabel('Open sort menu').click();
    await page.getByRole('button', { name: 'PRICE: LOW TO HIGH' }).click();
    await expect(page).toHaveURL(/sort=price_asc/i);

    await page.getByLabel('Open sort menu').click();
    await page.getByRole('button', { name: 'PRICE: HIGH TO LOW' }).click();
    await expect(page).toHaveURL(/sort=price_desc/i);

    await page.getByLabel('Open sort menu').click();
    await page.getByRole('button', { name: 'NEWEST' }).click();
    await expect(page).toHaveURL(/sort=newest/i);
  });
});
