import { expect, test } from '@playwright/test';

// FREQ-133: PC（lg: 1024px 以上）はホバーでオーバーレイに関連アイテムを表示するため、
// カード下の関連アイテム名・価格リスト（.look-related-items）を表示しない。
// モバイル・タブレットでは従来どおり表示する。

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

test.describe('FR-LOOK-ALL-020 PC ではカード下の関連アイテムを非表示', () => {
  for (const target of PAGES) {
    test(`desktop ${target.label} でカード下の関連アイテムリストが表示されない`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const relatedLists = page.locator(`${target.scope} .look-related-items`);
      // AC-01: リストは DOM に存在しても表示されない
      await expect(
        relatedLists.first(),
        `${target.label} に関連アイテム付きカードが見つかりませんでした`,
      ).toBeAttached();
      const count = await relatedLists.count();
      for (let i = 0; i < count; i += 1) {
        await expect(relatedLists.nth(i)).toBeHidden();
      }
    });
  }

  for (const vp of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ] as const) {
    test(`${vp.name} /look ではカード下に関連アイテムリストが表示される`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();

      // AC-02: 関連アイテムを持つカードではリストが表示される
      const firstList = page.locator('main .look-related-items').first();
      await firstList.scrollIntoViewIfNeeded();
      await expect(firstList).toBeVisible();
    });
  }
});
