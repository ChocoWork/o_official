import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-004 HOMEのLOOKセクション', () => {
  test('HOMEのLOOKセクションでカード表示とLOOK一覧導線を確認する', async ({ page }) => {
    await page.goto('/');

    const lookSection = page.locator('#look');
    await expect(lookSection).toBeVisible();

    // 1カード内に /look リンクが複数あるため、カード画像で件数を判定する。
    // FREQ-132 のホバー用 2 枚目画像はカード数に含めない。
    const lookCards = lookSection.locator(
      'a[href^="/look/"] img:not([data-testid="look-card-image-hover"])',
    );
    // FREQ-148: DOM には最大8件描画される（xl 未満は先頭6件のみ表示）
    const cardCount = await lookCards.count();
    expect(cardCount).toBeGreaterThan(0);
    expect(cardCount).toBeLessThanOrEqual(8);

    const viewLookbook = page.getByRole('link', { name: 'VIEW LOOKBOOK' });
    const hasCta = await viewLookbook.isVisible().catch(() => false);

    if (hasCta) {
      await viewLookbook.click();
      await expect(page).toHaveURL(/\/look$/);
    }
  });
});
