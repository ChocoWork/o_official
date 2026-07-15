import { expect, test, type Page } from '@playwright/test';

// FREQ-119: NEWS / ITEM / LOOK / STOCKIST の4ページで、左サイドバーのフィルター幅と
// 右側メインコンテンツまでの余白（コンテンツ列の左パディング）を統一する。
// レイアウトは lg 以上（デスクトップ）で有効。xl(1280) と 2xl(1536) で検証する。

const LIST_PAGES = [
  { name: 'ITEM', path: '/item' },
  { name: 'NEWS', path: '/news' },
  { name: 'LOOK', path: '/look' },
  { name: 'STOCKIST', path: '/stockist' },
] as const;

async function measureSidebar(
  page: Page,
  path: string,
): Promise<{ width: number; gapPaddingLeft: number }> {
  await page.goto(path);
  const aside = page.locator('aside').first();
  await expect(aside).toBeVisible();

  return aside.evaluate((el) => {
    const width = el.getBoundingClientRect().width;
    // aside の隣が右側メインコンテンツ列。その左パディング = フィルターとの余白。
    const content = el.nextElementSibling as HTMLElement;
    const gapPaddingLeft = parseFloat(getComputedStyle(content).paddingLeft);
    return { width: Math.round(width), gapPaddingLeft: Math.round(gapPaddingLeft) };
  });
}

test.describe('FR-ITEM-ALL-025 フィルター幅とメインまでの余白の統一', () => {
  for (const { label, width } of [
    { label: 'xl(1280px)', width: 1280 },
    { label: '2xl(1536px)', width: 1536 },
  ]) {
    test(`${label}: 4ページで aside 幅とメイン左余白が一致する`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });

      const results: Array<{ name: string; width: number; gapPaddingLeft: number }> = [];
      for (const p of LIST_PAGES) {
        results.push({ name: p.name, ...(await measureSidebar(page, p.path)) });
      }

      const [ref] = results;
      for (const r of results) {
        expect(r.width, `${r.name} sidebar width`).toBe(ref.width);
        expect(r.gapPaddingLeft, `${r.name} gap to main`).toBe(ref.gapPaddingLeft);
      }

      // 基準値（FREQ-119-REQ-01）: 幅 288px / 余白 xl=55px, 2xl=89px
      expect(ref.width).toBe(288);
      expect(ref.gapPaddingLeft).toBe(width >= 1536 ? 89 : 55);
    });
  }
});
