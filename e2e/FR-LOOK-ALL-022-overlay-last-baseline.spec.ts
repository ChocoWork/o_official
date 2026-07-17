import { expect, test, type Page } from '@playwright/test';

// FREQ-135: シーズンタイトル（テーマ名）の文字の下のラインと、
// 一番下の関連アイテム行の文字の下のラインが揃う（last baseline 揃え）。
// ブロックのボックス下端ではなく、Range で文字矩形を取得して比較する。

async function readTextBottomDiff(
  page: Page,
  scopeSelector: string,
): Promise<number | null> {
  return page.locator(scopeSelector).evaluate((scope) => {
    const overlay = scope.querySelector<HTMLElement>(
      '[data-testid="look-card-overlay"]:has([data-testid="look-card-overlay-items"])',
    );
    if (!overlay) return null;
    const theme = overlay.querySelector<HTMLElement>(
      '[data-testid="look-card-overlay-title"] h3',
    );
    const itemRows = overlay.querySelectorAll<HTMLElement>(
      '[data-testid="look-card-overlay-items"] > div',
    );
    const lastRow = itemRows[itemRows.length - 1];
    // 行 div ではなく span（商品名）の文字矩形で比較する
    // （行 div の Range 矩形は子要素のボーダーボックスを含むため）
    const lastRowText = lastRow?.querySelector<HTMLElement>('span');
    if (!theme || !lastRowText) return null;

    const textRect = (el: HTMLElement): DOMRect => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect();
    };

    return Number(
      Math.abs(textRect(theme).bottom - textRect(lastRowText).bottom).toFixed(2),
    );
  });
}

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

test.describe('FR-LOOK-ALL-022 タイトルと最終関連アイテム行の文字ライン揃え', () => {
  for (const target of PAGES) {
    test(`desktop ${target.label} で文字の下のラインが揃う`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const diff = await readTextBottomDiff(page, target.scope);
      expect(
        diff,
        `${target.label} に関連アイテム付きカードが見つかりませんでした`,
      ).not.toBeNull();

      // AC-01: フォントの descent 差を考慮し誤差 3px 以内
      expect(diff!).toBeLessThanOrEqual(3);
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
