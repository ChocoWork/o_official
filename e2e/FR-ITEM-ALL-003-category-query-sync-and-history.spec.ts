import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-003 カテゴリURL同期', () => {
  test('カテゴリ選択がURLに反映され、戻るで復元される', async ({ page }) => {
    await gotoItemList(page);

    await page.getByRole('button', { name: 'TOPS' }).click();
    await expect(page).toHaveURL(/category=TOPS/i, { timeout: 15000 });

    const firstDetailHref = await page.locator('[data-testid="item-card-link"]').first().getAttribute('href');
    expect(firstDetailHref).toBeTruthy();

    await page.goto(firstDetailHref!);
    await page.goBack();

    await expect(page).toHaveURL(/category=TOPS/i, { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'TOPS' })).toHaveAttribute('aria-pressed', 'true');
  });
});
