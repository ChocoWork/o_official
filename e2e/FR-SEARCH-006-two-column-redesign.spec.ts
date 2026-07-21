import { expect, test, type Locator } from '@playwright/test';
import { fetchSearchSeed } from './search-test-utils';

type Box = { x: number; y: number; width: number; height: number };

// dev の再レンダー（ローディング⇄結果の切替）で boundingBox が一時的に
// null になることがあるため、非 null になるまでリトライして取得する。
async function stableBox(locator: Locator): Promise<Box> {
  let box: Box | null = null;
  await expect
    .poll(async () => {
      box = await locator.boundingBox();
      return box !== null;
    })
    .toBe(true);
  return box!;
}

// FREQ-184: searchページを参考デザインの2カラム構成
// （左=SEARCH見出し・下線検索フィールド・縦並びフィルタ、右=サムネイル付き結果リスト）にする。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-SEARCH-006 2カラムリデザイン', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} レイアウト・結果ヘッダー・結果行・LOAD MORE`, async ({ page }) => {
      const seed = await fetchSearchSeed(page);

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`/search?q=${encodeURIComponent(seed.query)}`);

      // 見出しは FREQ-198 によりモバイルでは視覚的に隠れる（sr-only）が、
      // 文書構造としては常に存在する
      const heading = page.getByRole('heading', { level: 1, name: /search/i });
      await expect(heading).toHaveCount(1);

      // AC-02: 結果ヘッダー（N RESULTS）。
      // SORT BY ラベルは FREQ-191 で削除、RELEVANCE 表示は FREQ-196 で非表示化済み。
      const resultsHeader = page.getByText(/\d+ RESULTS/);
      await expect(resultsHeader).toBeVisible();
      await expect(page.getByText('RELEVANCE', { exact: true })).toBeHidden();

      // 結果行の表示（＝ローディング完了）を待ってからレイアウトを計測する
      const rows = page.locator('[data-testid="search-result-row"]');
      await expect(rows.first()).toBeVisible();

      // AC-01: FREQ-197 により tablet も desktop と同じ2カラム
      //        （検索フィールドと結果ヘッダーが横並び・タブが縦並び）。
      //        mobile のみ縦積み1カラム（結果は検索フィールドより下・タブが横並び）。
      //        見出しはモバイルで sr-only のため、基準には検索フィールドを使う。
      const searchField = page.locator('input[type="search"]');
      const fieldBox = await stableBox(searchField);
      const headerBox = await stableBox(resultsHeader);
      const allTabBox = await stableBox(page.getByRole('tab', { name: 'ALL' }));
      const itemTabBox = await stableBox(page.getByRole('tab', { name: 'ITEM' }));

      if (vp.name === 'mobile') {
        expect(headerBox.y).toBeGreaterThan(fieldBox.y + fieldBox.height - 1);
        // 横並びタブ: y が揃い x が異なる
        expect(Math.abs(allTabBox.y - itemTabBox.y)).toBeLessThanOrEqual(2);
        expect(itemTabBox.x).toBeGreaterThan(allTabBox.x + allTabBox.width - 1);
      } else {
        expect(headerBox.x).toBeGreaterThan(fieldBox.x + fieldBox.width);
        // 縦並びタブ: x が揃い y が異なる
        expect(Math.abs(allTabBox.x - itemTabBox.x)).toBeLessThanOrEqual(2);
        expect(itemTabBox.y).toBeGreaterThan(allTabBox.y + allTabBox.height - 1);
      }

      // 横スクロールが発生しない
      const hasHorizontalScroll = await page.evaluate(() => {
        const el = document.scrollingElement!;
        return el.scrollWidth > el.clientWidth;
      });
      expect(hasHorizontalScroll).toBe(false);

      // AC-03: 各結果行にサムネイル枠・種別ラベル・矢印 SVG・1px 区切り線
      const rowCount = await rows.count();
      expect(rowCount).toBeGreaterThan(0);

      const firstRow = rows.first();
      await expect(firstRow.getByText(/^(ITEM|LOOK|NEWS)$/).first()).toBeVisible();
      await expect(firstRow.locator('svg')).toBeVisible();
      expect(await firstRow.locator('div.aspect-\\[3\\/4\\]').count()).toBe(1);
      const borderBottom = await firstRow.evaluate((el) => getComputedStyle(el).borderBottomWidth);
      expect(borderBottom).toBe('1px');

      // AC-04: 結果が 8 件を超える場合のみ LOAD MORE を表示し、クリックで行が増える
      const totalCount = Number((await resultsHeader.innerText()).match(/(\d+) RESULTS/)?.[1] ?? '0');
      const loadMore = page.getByRole('button', { name: 'LOAD MORE' });
      if (totalCount > 8) {
        expect(rowCount).toBe(8);
        await expect(loadMore).toBeVisible();
        await loadMore.click();
        await expect(rows.nth(8)).toBeVisible();
      } else {
        await expect(loadMore).toBeHidden();
        expect(rowCount).toBe(totalCount);
      }
    });
  }
});
