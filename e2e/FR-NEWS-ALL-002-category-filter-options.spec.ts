import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-002 category filter options', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('ALLを含むカテゴリ絞り込みUIが提供される', async ({ page }) => {
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
      await expect(page.getByRole('button', { name: category, exact: true })).toBeVisible();
    }
  });
});
