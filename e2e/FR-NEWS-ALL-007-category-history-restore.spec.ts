import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-007 category history restore', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('ブラウザ戻るでカテゴリ絞り込み状態が復元される', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'EVENT', exact: true }).click();
    await expect(page).toHaveURL(/\/news\?category=EVENT$/);

    await page.getByRole('button', { name: 'COLLECTION', exact: true }).click();
    await expect(page).toHaveURL(/\/news\?category=COLLECTION$/);

    await page.goBack();

    await expect(page).toHaveURL(/\/news\?category=EVENT$/);
    await expect(page.getByRole('button', { name: 'EVENT', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
