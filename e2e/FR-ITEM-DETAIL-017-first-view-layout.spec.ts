import { test, expect, Page } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

// FREQ-155（2026-11-07 改定）: tablet / desktop のファーストビューでは関連商品（YOU MAY ALSO LIKE）を見せない。
// mobile は選択 UI がシートに移って本文が短くなったため、最初の画面の中に関連商品の見出しが見える。

async function gotoFirstItemDetail(page: Page): Promise<boolean> {
  const item = await fetchFirstItemViaApi(page);
  if (!item) return false;
  await page.goto(`/item/${item.id}`);
  await page.waitForLoadState('networkidle');
  return true;
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-017 ファーストビューレイアウト (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-155-AC-01: 初期表示で YOU MAY ALSO LIKE が、mobile では見え、tablet / desktop では見えない', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      const relatedTop = await page.evaluate(() => {
        const el = [...document.querySelectorAll('*')].find(
          (e) => e.textContent?.trim() === 'YOU MAY ALSO LIKE',
        );
        return el ? Math.round(el.getBoundingClientRect().top) : null;
      });
      // 関連商品が無い商品ではセクション自体が無い（null）。見える／見えないの比べは、あるときだけ行う
      if (relatedTop !== null) {
        if (viewport.name === 'mobile') {
          // mobile: 見出しの上端が最初の画面（高さ 844px）の中にある
          expect(relatedTop).toBeLessThan(viewport.height);
        } else {
          expect(relatedTop).toBeGreaterThan(viewport.height);
        }
      }
    });

    test('FREQ-155-AC-02: 横スクロールが発生しない', async ({ page }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      const { scrollW, clientW } = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(scrollW).toBeLessThanOrEqual(clientW);
    });
  });
}
