import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-002 ルックカード表示と遷移', () => {
  test('カードにシーズン・テーマ・画像・紐づけ商品名を表示し詳細へ遷移できる', async ({ page }) => {
    await page.goto('/look');

    const firstLookLink = page.locator('a[href^="/look/"]').first();
    await expect(firstLookLink).toBeVisible();

    const firstCard = firstLookLink.locator('xpath=ancestor::div[1]');
    const firstImage = firstLookLink.locator('img').first();
    await expect(firstImage).toBeVisible();

    const imageAlt = await firstImage.getAttribute('alt');
    expect((imageAlt ?? '').length).toBeGreaterThan(0);

    const hasSeasonThemeText = await page
      .locator('p')
      .filter({ hasText: /\b(SS|AW)\b/ })
      .first()
      .isVisible()
      .catch(() => false);
    expect(hasSeasonThemeText).toBeTruthy();

    const linkedItemOrEmpty = page.getByText('紐づけ商品なし').first();
    const linkedItemLink = page.locator('a[href^="/item/"]').first();
    const linkedItemVisible = await linkedItemLink.isVisible().catch(() => false);
    const emptyVisible = await linkedItemOrEmpty.isVisible().catch(() => false);
    expect(linkedItemVisible || emptyVisible).toBeTruthy();

    await firstLookLink.click();
    await expect(page).toHaveURL(/\/look\/\d+/);
  });
});
