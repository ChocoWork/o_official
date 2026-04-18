import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-003 カテゴリURL同期', () => {
  test('カテゴリ選択がURLに反映され、戻るで復元される', async ({ page }) => {
    await gotoItemList(page);

    await page.getByLabel('Open filter drawer').click();
    await page.locator('label:has(input[aria-label="CATEGORY TOPS"])').click();
    await page.getByLabel('Close filter drawer').click();

    await expect(page).toHaveURL(/category=TOPS/i, { timeout: 15000 });

    const firstDetailHref = await page.locator('[data-testid="item-card-link"]').first().getAttribute('href');
    expect(firstDetailHref).toBeTruthy();

    await page.goto(firstDetailHref!);
    await page.goBack();

    await expect(page).toHaveURL(/category=TOPS/i, { timeout: 15000 });
    await page.getByLabel('Open filter drawer').click();
    await expect(page.getByLabel('CATEGORY TOPS')).toBeChecked();
  });
});
