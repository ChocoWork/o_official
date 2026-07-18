import { expect, test, type Page } from '@playwright/test';

// FREQ-140: lg 未満のみ LOOK カード間の縦の間隔（row-gap）を
// カード内最大余白（画像↔パネル 13px/21px）の φ² 倍のフィボナッチ値
// （mobile 34px / tablet 55px）に広げる。column-gap は従来値のまま。
// desktop（lg 以上）は従来どおり縦横同値 24px（FREQ-137）。

async function readGridGaps(
  page: Page,
  scopeSelector: string,
): Promise<{ rowGap: number; columnGap: number } | null> {
  return page.locator(scopeSelector).evaluate((scope) => {
    const link = scope.querySelector<HTMLElement>('a[href^="/look/"]');
    const grid = link?.parentElement?.parentElement;
    if (!grid) return null;
    const style = getComputedStyle(grid);
    if (style.display !== 'grid') return null;
    return {
      rowGap: parseFloat(style.rowGap),
      columnGap: parseFloat(style.columnGap),
    };
  });
}

// FREQ-141: /look 一覧のタブレット column-gap はホームと同じ 24px に統一
const TARGETS = [
  { name: 'HOME LOOK セクション', path: '/', scope: '#look', tabletColumnGap: 24 },
  { name: '/look 一覧', path: '/look', scope: 'main', tabletColumnGap: 24 },
] as const;

test.describe('FR-LOOK-ALL-027 lg 未満の LOOK カード行間拡大', () => {
  for (const target of TARGETS) {
    test(`mobile ${target.name} row-gap 34px / column-gap 16px`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const gaps = await readGridGaps(page, target.scope);
      expect(gaps, `${target.name} に LOOK グリッドが見つかりませんでした`).not.toBeNull();
      // AC-01
      expect(gaps!.rowGap).toBe(34);
      expect(gaps!.columnGap).toBe(16);
      // AC-03
      expect(gaps!.rowGap).toBeGreaterThan(gaps!.columnGap);
    });

    test(`tablet ${target.name} row-gap 55px / column-gap 従来値`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const gaps = await readGridGaps(page, target.scope);
      expect(gaps, `${target.name} に LOOK グリッドが見つかりませんでした`).not.toBeNull();
      // AC-02
      expect(gaps!.rowGap).toBe(55);
      expect(gaps!.columnGap).toBe(target.tabletColumnGap);
      // AC-03
      expect(gaps!.rowGap).toBeGreaterThan(gaps!.columnGap);
    });

    test(`desktop ${target.name} は従来どおり縦横同値 24px`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const gaps = await readGridGaps(page, target.scope);
      expect(gaps, `${target.name} に LOOK グリッドが見つかりませんでした`).not.toBeNull();
      // AC-04
      expect(gaps!.rowGap).toBe(24);
      expect(gaps!.columnGap).toBe(24);
    });
  }
});
