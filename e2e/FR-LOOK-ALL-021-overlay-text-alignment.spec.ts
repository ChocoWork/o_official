import { expect, test, type Page } from '@playwright/test';

// FREQ-134: ホバー前のシーズン・タイトルとホバー後の関連アイテム・価格の
// 文字位置を揃える（同一グリッドセルで下端揃え・左端揃え）。

type BlockAlignment = {
  bottomDiff: number;
  leftDiff: number;
};

async function readOverlayAlignment(
  page: Page,
  scopeSelector: string,
): Promise<BlockAlignment | null> {
  return page.locator(scopeSelector).evaluate((scope) => {
    const overlay = scope.querySelector<HTMLElement>(
      '[data-testid="look-card-overlay"]:has([data-testid="look-card-overlay-items"])',
    );
    if (!overlay) return null;
    const title = overlay.querySelector<HTMLElement>('[data-testid="look-card-overlay-title"]');
    const items = overlay.querySelector<HTMLElement>('[data-testid="look-card-overlay-items"]');
    if (!title || !items) return null;

    const titleRect = title.getBoundingClientRect();
    const itemsRect = items.getBoundingClientRect();
    return {
      bottomDiff: Number(Math.abs(titleRect.bottom - itemsRect.bottom).toFixed(2)),
      leftDiff: Number(Math.abs(titleRect.left - itemsRect.left).toFixed(2)),
    };
  });
}

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

test.describe('FR-LOOK-ALL-021 オーバーレイのホバー前後の文字位置揃え', () => {
  for (const target of PAGES) {
    test(`desktop ${target.label} でタイトルと関連アイテムの下端・左端が揃う`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const alignment = await readOverlayAlignment(page, target.scope);
      expect(
        alignment,
        `${target.label} に関連アイテム付きカードが見つかりませんでした`,
      ).not.toBeNull();

      // AC-01: 下端が概ね揃う（last baseline 揃えによる数 px のずれを許容。
      // 文字ラインの厳密な揃えは FR-LOOK-ALL-022 / FREQ-135 で検証）
      // AC-02: 左端揃え（誤差 1px 以内）
      expect(alignment!.bottomDiff).toBeLessThanOrEqual(5);
      expect(alignment!.leftDiff).toBeLessThanOrEqual(1);
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
