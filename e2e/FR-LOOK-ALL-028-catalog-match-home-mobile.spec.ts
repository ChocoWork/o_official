import { expect, test, type Page } from '@playwright/test';

// FREQ-141: /look 一覧のモバイル・タブレット（lg 未満）の見た目を
// ホーム LOOK セクションと揃える。
// ① コンテンツ列の左右 padding をホームの section-space と同値にする
//    （モバイル 13px / sm 16px / md 21px）
// ② グリッドの row-gap / column-gap をホームと一致させる
//    （タブレットの列間 32px → 24px）
// lg 以上（サイドバーレイアウト・gap）は変更しない。

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

async function readCatalogPadding(
  page: Page,
): Promise<{ left: number; right: number }> {
  const column = page.locator('[data-testid="look-content-column"]');
  await expect(column).toBeVisible();
  return column.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      left: parseFloat(style.paddingLeft),
      right: parseFloat(style.paddingRight),
    };
  });
}

async function readHomeSectionPaddingLeft(page: Page): Promise<number> {
  await page.goto('/');
  const section = page.locator('#look');
  await expect(section).toBeVisible();
  return section.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
}

const PANEL_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, padding: 13 },
  { name: 'tablet', width: 768, height: 1024, padding: 21 },
] as const;

test.describe('FR-LOOK-ALL-028 /look 一覧のモバイル・タブレットをホームと揃える', () => {
  for (const vp of PANEL_VIEWPORTS) {
    test(`${vp.name} /look の左右 padding がホーム LOOK セクションと同値`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // AC-01: ホーム section-space の padding と同値
      const homePadding = await readHomeSectionPaddingLeft(page);
      expect(homePadding).toBe(vp.padding);

      await page.goto('/look');
      const catalogPadding = await readCatalogPadding(page);
      expect(catalogPadding.left).toBe(homePadding);
      expect(catalogPadding.right).toBe(homePadding);
    });

    test(`${vp.name} /look の row-gap / column-gap がホームと一致`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await page.goto('/');
      await expect(page.locator('#look')).toBeVisible();
      const homeGaps = await readGridGaps(page, '#look');
      expect(homeGaps).not.toBeNull();

      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();
      const catalogGaps = await readGridGaps(page, 'main');
      expect(catalogGaps).not.toBeNull();

      // AC-02 / AC-03: 縦横ともホームと同値
      expect(catalogGaps!.columnGap).toBe(homeGaps!.columnGap);
      expect(catalogGaps!.rowGap).toBe(homeGaps!.rowGap);
    });
  }

  // AC-04: desktop は従来どおり（gap 24px・左 padding 34px）
  test('desktop /look の gap と左 padding が従来どおり', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();

    const gaps = await readGridGaps(page, 'main');
    expect(gaps).not.toBeNull();
    expect(gaps!.rowGap).toBe(24);
    expect(gaps!.columnGap).toBe(24);

    const padding = await readCatalogPadding(page);
    expect(padding.left).toBe(55); // xl:pl-[55px]（1280px は xl 帯域）
  });
});
