import { expect, test } from '@playwright/test';

// FREQ-131: PC オーバーレイをホバーするとシーズン・テーマが消え、
// 関連アイテム名と価格が表示される（opacity で入れ替え）。

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

test.describe('FR-LOOK-ALL-018 ホバーで関連アイテムと価格に入れ替え', () => {
  for (const target of PAGES) {
    test(`desktop ${target.label} でホバーするとタイトルが消え関連アイテムが出る`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      // 関連アイテムを持つ最初のカード（overlay-items は linkedItems がある場合のみ描画）
      const overlay = page
        .locator(
          `${target.scope} [data-testid="look-card-overlay"]:has([data-testid="look-card-overlay-items"])`,
        )
        .first();
      await expect(
        overlay,
        `${target.label} に関連アイテム付きカードが見つかりませんでした`,
      ).toBeAttached();

      const title = overlay.locator('[data-testid="look-card-overlay-title"]');
      const items = overlay.locator('[data-testid="look-card-overlay-items"]');

      // AC-03: 非ホバー時はタイトル表示・関連アイテム非表示
      await expect(title).toHaveCSS('opacity', '1');
      await expect(items).toHaveCSS('opacity', '0');

      // ホバー
      await overlay.hover();

      // AC-01: タイトルが消える / AC-02: 関連アイテム（商品名・価格）が出る
      await expect(title).toHaveCSS('opacity', '0');
      await expect(items).toHaveCSS('opacity', '1');
      await expect(items.locator('span').first()).not.toBeEmpty();
      await expect(items).toContainText('￥');
    });
  }

  // mobile / tablet はオーバーレイ自体が非表示（FREQ-128 AC-03）
  for (const vp of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ] as const) {
    test(`${vp.name} ではオーバーレイが表示されない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();
      await expect(
        page.locator('[data-testid="look-card-overlay"]').first(),
      ).toBeHidden();
    });
  }
});
