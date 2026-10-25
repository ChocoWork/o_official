import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-002 category filter options', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('FR-NEWS-ALL-002-AC-01 ALLを含むカテゴリ絞り込みUIが提供される', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const expectedCategories = [
      'ALL',
      'COLLECTION',
      'EVENT',
      'COLLABORATION',
      'SUSTAINABILITY',
      'STORE',
      'BLOG',
    ];

    for (const category of expectedCategories) {
      await expect(page.locator('aside').getByRole('checkbox', { name: category, exact: true })).toBeVisible();
    }
  });
});
