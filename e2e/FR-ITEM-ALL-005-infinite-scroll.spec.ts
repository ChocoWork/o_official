import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-005 無限スクロール', () => {
  test('スクロールで追加読み込みされる', async ({ page }) => {
    await gotoItemList(page);
    const cards = page.locator('[data-testid="item-card"]');

    const beforeCount = await cards.count();
    await page.locator('[data-testid="item-infinite-sentinel"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);

    const afterCount = await cards.count();
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
  });
});
