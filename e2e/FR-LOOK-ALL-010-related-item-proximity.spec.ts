import { expect, test, type Page } from '@playwright/test';

// FREQ-53: 関連商品リンクの上下 padding を撤廃し、行間を .look-related-items の
// gap（φ 比率）のみで決定する。各リンクの上下 padding が 1px 以下であることを
// 検証して、近接の原則による一群化を担保する。

async function collectRelatedItemPadding(
  page: Page,
  scopeSelector: string,
): Promise<{ paddingTop: number; paddingBottom: number }[]> {
  return page.locator(scopeSelector).evaluate((scope) => {
    const parsePx = (value: string): number =>
      Number.parseFloat(value.replace('px', ''));
    const links = Array.from(
      scope.querySelectorAll<HTMLElement>('a.look-related-item-text'),
    );
    return links.map((link) => {
      const style = getComputedStyle(link);
      return {
        paddingTop: parsePx(style.paddingTop),
        paddingBottom: parsePx(style.paddingBottom),
      };
    });
  });
}

function assertNoInflatingPadding(
  rows: { paddingTop: number; paddingBottom: number }[],
  label: string,
): void {
  expect(rows.length, `${label} に関連商品リンクが見つかりませんでした`).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.paddingTop, `${label} paddingTop`).toBeLessThanOrEqual(1);
    expect(row.paddingBottom, `${label} paddingBottom`).toBeLessThanOrEqual(1);
  }
}

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-LOOK-ALL-010 関連商品の近接', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} HOME の LOOK で関連商品リンクに上下 padding が無い`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await expect(page.locator('#look')).toBeVisible();
      assertNoInflatingPadding(
        await collectRelatedItemPadding(page, '#look'),
        `HOME#look ${vp.name}`,
      );
    });

    test(`${vp.name} /look 一覧で関連商品リンクに上下 padding が無い`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();
      assertNoInflatingPadding(
        await collectRelatedItemPadding(page, 'main'),
        `/look ${vp.name}`,
      );
    });
  }
});
