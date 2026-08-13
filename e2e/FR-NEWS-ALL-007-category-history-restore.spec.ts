import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-007 category history restore', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('ブラウザ戻るでカテゴリ絞り込み状態が復元される', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    // カテゴリは複数選択。押すたびに選択が累積し、クエリはカンマ区切りになる。
    await page.getByRole('checkbox', { name: 'EVENT', exact: true }).click();
    await expect(page).toHaveURL(/\/news\?category=EVENT$/);

    await page.getByRole('checkbox', { name: 'COLLECTION', exact: true }).click();
    await expect(page).toHaveURL(/\/news\?category=EVENT(%2C|,)COLLECTION$/);

    await page.goBack();

    await expect(page).toHaveURL(/\/news\?category=EVENT$/);
    await expect(page.getByRole('checkbox', { name: 'EVENT', exact: true })).toBeChecked();
  });
});
