import { expect, test, type Page } from '@playwright/test';

// FREQ-137: HOME の LOOK セクションと /look 一覧のグリッドは、
// カード間の縦の空間（row-gap）と横の空間（column-gap）を同じにする。
// xl 以上で横 gap だけ広がり縦横が不揃いに見えていた問題の回帰防止。

async function readGridGaps(
  page: Page,
  scopeSelector: string,
): Promise<{ rowGap: number; columnGap: number } | null> {
  return page.locator(scopeSelector).evaluate((scope) => {
    // LookCard の画像リンク → カード div → グリッドコンテナ
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

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

// FREQ-140 により lg 未満は row-gap を column-gap より広げるため、
// 縦横同値の検証は desktop（lg 以上）のみを対象とする
// （mobile/tablet の gap は FR-LOOK-ALL-027 で検証）。
const VIEWPORTS = [{ name: 'desktop', width: 1280, height: 800 }] as const;

test.describe('FR-LOOK-ALL-024 LOOK グリッドの縦横 gap が等しい', () => {
  for (const target of PAGES) {
    for (const vp of VIEWPORTS) {
      test(`${vp.name} ${target.label} で row-gap と column-gap が等しい`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(target.path);
        await expect(page.locator(target.scope)).toBeVisible();

        const gaps = await readGridGaps(page, target.scope);
        expect(
          gaps,
          `${target.label} に LOOK グリッドが見つかりませんでした`,
        ).not.toBeNull();

        // AC-01（FREQ-140 により lg 以上のみ）: 縦横の gap が同値
        expect(gaps!.rowGap).toBe(gaps!.columnGap);

        // AC-02: デスクトップ（1280px）では縦横とも 24px（gap-6）
        expect(gaps!.rowGap).toBe(24);
      });
    }
  }
});
