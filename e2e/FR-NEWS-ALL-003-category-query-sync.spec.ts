import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-003 category query sync', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('カテゴリ選択が category クエリに反映される', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    await test.step('EVENT タブを選択する', async () => {
      await page.getByRole('button', { name: 'EVENT', exact: true }).click();
    });

    await test.step('URL に category=EVENT が反映される', async () => {
      await expect(page).toHaveURL(/\/news\?category=EVENT$/);
    });
  });
});
