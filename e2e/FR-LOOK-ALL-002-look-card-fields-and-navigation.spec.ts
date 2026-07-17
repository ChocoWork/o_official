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

    // FREQ-127: シーズンラベルは「2026AW」形式（年とシーズンの間に空白なし）
    const hasSeasonThemeText = await page
      .locator('p')
      .filter({ hasText: /\d{4}(SS|AW)/ })
      .first()
      .isVisible()
      .catch(() => false);
    expect(hasSeasonThemeText).toBeTruthy();

    // FREQ-133: PC ではカード下の関連アイテムリストは非表示になり、
    // 紐づけ商品名はホバー時のオーバーレイ（overlay-items）に表示される。
    const overlayItems = page
      .locator('[data-testid="look-card-overlay-items"]')
      .first();
    const hasLinkedItems = (await overlayItems.count()) > 0;
    if (hasLinkedItems) {
      const cardWithItems = page
        .locator('a[href^="/look/"]:has([data-testid="look-card-overlay-items"])')
        .first();
      await cardWithItems.hover();
      await expect(overlayItems).toBeVisible();
      await expect(overlayItems.locator('span').first()).not.toBeEmpty();
    }

    const detailHref = await firstLookImageLink.getAttribute('href');
    expect(detailHref).toMatch(/^\/look\/[\w-]+$/);

    await page.goto(detailHref!);
    await expect(page).toHaveURL(/\/look\/\d+/);
  });
});
