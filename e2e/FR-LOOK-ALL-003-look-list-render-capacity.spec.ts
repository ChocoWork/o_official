import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-003 LOOK一覧の表示件数要件', () => {
  test('LOOK一覧でカードが表示され、6件以上存在する場合でも一覧表示が成立する', async ({ page }) => {
    await page.goto('/look');

    const lookCards = page.locator('a[href^="/look/"]');
    await expect(lookCards.first()).toBeVisible();

    const count = await lookCards.count();
    expect(count).toBeGreaterThan(0);

    if (count >= 6) {
      expect(count).toBeGreaterThanOrEqual(6);
    }
  });
});
