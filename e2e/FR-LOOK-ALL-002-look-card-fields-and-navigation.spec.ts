import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-002 ルックカード表示と遷移', () => {
  test('カードにシーズン・テーマ・画像・紐づけ商品名を表示し詳細へ遷移できる', async ({ page }) => {
    await page.goto('/look');

    const firstLookImageLink = page.locator('a[href^="/look/"]').first();
    await expect(firstLookImageLink).toBeVisible();

    const firstImage = firstLookImageLink.locator('img').first();
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

    const detailHref = await firstLookImageLink.getAttribute('href');
    expect(detailHref).toMatch(/^\/look\/[\w-]+$/);

    await page.goto(detailHref!);
    await expect(page).toHaveURL(/\/look\/\d+/);
  });
});
