import { expect, test } from '@playwright/test';

// FREQ-188: 検索画面をファーストビューいっぱいに表示する。
// lg 以上は左カラムをヘッダー下にビューポート高で sticky し、内容を縦中央に置く。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-SEARCH-010 検索画面の全画面表示', () => {
  for (const vp of VIEWPORTS) {
    test(`AC-01/AC-03 ${vp.name} フッターがファーストビューに出ず横スクロールもしない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');

      // POPULAR ITEMS の描画完了を待ってから計測する
      await expect(page.locator('[data-testid="search-result-row"]').first()).toBeVisible();

      const metrics = await page.evaluate(() => {
        const root = document.querySelector('main > div') as HTMLElement;
        const footer = document.querySelector('footer');
        const scroller = document.scrollingElement!;
        return {
          rootHeight: root.getBoundingClientRect().height,
          viewportHeight: window.innerHeight,
          footerTop: footer ? footer.getBoundingClientRect().top : Number.POSITIVE_INFINITY,
          hasHorizontalScroll: scroller.scrollWidth > scroller.clientWidth,
        };
      });

      // AC-01: フッターはファーストビューの外
      expect(metrics.footerTop).toBeGreaterThanOrEqual(metrics.viewportHeight);
      // コンテナ自体がビューポートに見合う高さを持つ（main の余白分だけ差し引かれる）
      expect(metrics.rootHeight).toBeGreaterThanOrEqual(metrics.viewportHeight - 150);
      // AC-03
      expect(metrics.hasHorizontalScroll).toBe(false);
    });
  }

  // FREQ-197: tablet も desktop と同じ2カラムなので、縦中央寄せの検証も両方で行う
  for (const vp of [
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 800 },
  ] as const) {
    test(`AC-02 ${vp.name} で左カラムが縦中央寄りに配置される`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');
      await expect(page.locator('[data-testid="search-result-row"]').first()).toBeVisible();

      const heading = page.getByRole('heading', { level: 1, name: /search/i });
      const lastTab = page.getByRole('tab', { name: 'NEWS' });

      const headingBox = await heading.boundingBox();
      const lastTabBox = await lastTab.boundingBox();
      expect(headingBox).toBeTruthy();
      expect(lastTabBox).toBeTruthy();

      // 見出しの上にも、最後のフィルタの下にも余白がある = 上寄せではなく中央寄り
      expect(headingBox!.y).toBeGreaterThan(vp.height * 0.1);
      expect(lastTabBox!.y + lastTabBox!.height).toBeLessThan(vp.height * 0.95);
    });
  }
});
