import { expect, test } from '@playwright/test';

// FREQ-197: タブレットを PC と同じ2カラムにする（ブレークポイントを lg → md）。
// FREQ-198: モバイルでは「SEARCH」見出しを視覚的に隠す（DOM には残す）。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-SEARCH-014 タブレットのPC同等化とモバイル見出し', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} レイアウトと見出しの表示`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search?q=a');
      await expect(page.locator('[data-testid="search-result-row"]').first()).toBeVisible();

      const measured = await page.evaluate(() => {
        const h1 = document.querySelector('h1')!;
        const leftColumn = h1.parentElement!;
        const searchField = document.querySelector('input[type="search"]')!;
        const resultsHeader = [...document.querySelectorAll('p')].find((p) =>
          /\d+ RESULTS/.test(p.textContent ?? ''),
        )!;
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        const allTab = tabs[0].getBoundingClientRect();
        const itemTab = tabs[1].getBoundingClientRect();
        const scroller = document.scrollingElement!;

        return {
          headingHeight: h1.getBoundingClientRect().height,
          headingText: (h1.textContent ?? '').trim(),
          fieldRight:
            searchField.getBoundingClientRect().x +
            searchField.getBoundingClientRect().width,
          fieldBottom:
            searchField.getBoundingClientRect().y +
            searchField.getBoundingClientRect().height,
          headerX: resultsHeader.getBoundingClientRect().x,
          headerY: resultsHeader.getBoundingClientRect().y,
          tabsSameX: Math.abs(allTab.x - itemTab.x) <= 2,
          tabsStacked: itemTab.y > allTab.y + allTab.height - 1,
          leftColumnPosition: getComputedStyle(leftColumn).position,
          hasHorizontalScroll: scroller.scrollWidth > scroller.clientWidth,
        };
      });

      // FREQ-198-AC-02: h1 はどのビューポートでも DOM に存在しテキストを保持する
      expect(measured.headingText).toBe('SEARCH');

      if (vp.name === 'mobile') {
        // FREQ-198-AC-01: モバイルでは視覚的に表示されない
        expect(measured.headingHeight).toBeLessThanOrEqual(1);
        // FREQ-197-AC-03: 縦積み1カラム・タブは横並び
        expect(measured.headerY).toBeGreaterThan(measured.fieldBottom - 1);
        expect(measured.tabsSameX).toBe(false);
      } else {
        // FREQ-198-AC-03: tablet / desktop では見出しを表示する
        expect(measured.headingHeight).toBeGreaterThanOrEqual(20);
        // FREQ-197-AC-01: 2カラム・タブは縦並び・左カラムは sticky
        expect(measured.headerX).toBeGreaterThan(measured.fieldRight);
        expect(measured.tabsSameX).toBe(true);
        expect(measured.tabsStacked).toBe(true);
        expect(measured.leftColumnPosition).toBe('sticky');
      }

      expect(measured.hasHorizontalScroll).toBe(false);
    });
  }
});
