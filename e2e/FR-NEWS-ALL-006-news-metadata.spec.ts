import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-006 news metadata', () => {
  test('ニュース一覧ページの title / description が設定されている', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('domcontentloaded');

    await expect(page).toHaveTitle('NEWS | Le Fil des Heures');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      'Le Fil des Heuresの最新ニュース一覧。コレクション、イベント、コラボレーション、サステナビリティ、ストア情報を掲載。',
    );
  });
});
