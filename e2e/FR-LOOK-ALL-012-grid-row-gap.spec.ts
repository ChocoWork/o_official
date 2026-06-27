import { expect, test, type Page } from '@playwright/test';

// FREQ-55: LOOK 一覧（catalog）グリッドの縦方向 gap を横方向 gap より広げ、
// カード行どうしを明確に分離する。モバイルでは従来値（16px）より広げる。

async function readGridGap(
  page: Page,
): Promise<{ rowGap: number; columnGap: number }> {
  const grid = page
    .locator('[data-testid="look-content-column"] .grid')
    .first();
  await expect(grid).toBeVisible();

  return grid.evaluate((el) => {
    const style = getComputedStyle(el);
    const parsePx = (value: string): number =>
      Number.parseFloat(value.replace('px', '')) || 0;
    return {
      rowGap: parsePx(style.rowGap),
      columnGap: parsePx(style.columnGap),
    };
  });
}

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-LOOK-ALL-012 LOOK グリッドの行間', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} で row-gap が column-gap より広い`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await page.waitForLoadState('networkidle');

      const { rowGap, columnGap } = await readGridGap(page);
      expect(rowGap).toBeGreaterThan(columnGap);
    });
  }

  test('mobile で row-gap が従来値（16px）より広い', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/look');
    await page.waitForLoadState('networkidle');

    const { rowGap } = await readGridGap(page);
    expect(rowGap).toBeGreaterThan(16);
  });
});
