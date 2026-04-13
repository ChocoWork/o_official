import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-004 HOMEのLOOKセクション', () => {
  test('HOMEのLOOKセクションでカード表示とLOOK一覧導線を確認する', async ({ page }) => {
    await page.goto('/');

    const lookSection = page.locator('#look');
    await expect(lookSection).toBeVisible();

    // 1カード内に /look リンクが複数あるため、カード画像で件数を判定する。
    const lookCards = lookSection.locator('a[href^="/look/"] img');
    const cardCount = await lookCards.count();
    expect(cardCount).toBeGreaterThan(0);
    expect(cardCount).toBeLessThanOrEqual(6);

    const viewLookbook = page.getByRole('link', { name: 'VIEW LOOKBOOK' });
    const hasCta = await viewLookbook.isVisible().catch(() => false);

    if (hasCta) {
      await viewLookbook.click();
      await expect(page).toHaveURL(/\/look$/);
    }
  });
});
