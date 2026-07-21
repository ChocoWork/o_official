import { expect, test } from '@playwright/test';

// FREQ-200: 種別フィルタ（ALL / ITEM / LOOK / NEWS）のモバイル横並びで先頭/末尾タブを
// タブ列端から内側に離し、各タブの字間を tracking-[0.2em] → tracking-[0.1em] に縮小する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-SEARCH-016 タブの左右余白と字間', () => {
  test('AC-01 モバイルで先頭/末尾タブがタブ列端より内側に入る', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/search');
    await expect(page.locator('[role="tab"]').first()).toBeVisible();

    const measured = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      const tablist = document.querySelector('[role="tablist"]')!;
      const scroller = document.scrollingElement!;
      return {
        firstTabLeft: tabs[0].getBoundingClientRect().left,
        lastTabRight: tabs[tabs.length - 1].getBoundingClientRect().right,
        tablistLeft: tablist.getBoundingClientRect().left,
        tablistRight: tablist.getBoundingClientRect().right,
        hasHorizontalScroll: scroller.scrollWidth > scroller.clientWidth,
      };
    });

    expect(measured.firstTabLeft - measured.tablistLeft).toBeGreaterThanOrEqual(8);
    expect(measured.tablistRight - measured.lastTabRight).toBeGreaterThanOrEqual(8);
    expect(measured.hasHorizontalScroll).toBe(false);
  });

  for (const vp of VIEWPORTS) {
    test(`AC-02/AC-03 ${vp.name} 字間 0.1em と下線の端揃え`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');
      await expect(page.locator('[role="tab"]').first()).toBeVisible();

      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('[role="tab"]')].map((tab) => {
          const labelSpan = tab.querySelector('span')!;
          const cs = getComputedStyle(labelSpan);
          const fontSize = parseFloat(cs.fontSize);
          const letterSpacing = parseFloat(cs.letterSpacing);

          const underline = labelSpan.querySelector(
            '.underline-animation-left2right',
          )!;
          const textNode = [...labelSpan.childNodes].find(
            (node) => node.nodeType === 3 && node.textContent!.trim().length > 0,
          )!;
          const text = textNode.textContent!;

          // 最後の文字の矩形には末尾の字間が含まれるので差し引く
          const lastChar = document.createRange();
          lastChar.setStart(textNode, text.length - 1);
          lastChar.setEnd(textNode, text.length);
          const glyphRight =
            lastChar.getBoundingClientRect().right - letterSpacing;

          const firstChar = document.createRange();
          firstChar.setStart(textNode, 0);
          firstChar.setEnd(textNode, 1);
          const glyphLeft = firstChar.getBoundingClientRect().left;

          const underlineLeft = underline.getBoundingClientRect().left;
          const underlineWidth = (underline as HTMLElement).offsetWidth;

          return {
            label: text.trim(),
            letterSpacing,
            expectedSpacing: fontSize * 0.1,
            rightGap: underlineLeft + underlineWidth - glyphRight,
            leftGap: glyphLeft - underlineLeft,
          };
        }),
      );

      expect(tabs.length).toBe(4);
      for (const tab of tabs) {
        // AC-02: 字間が font-size の 0.1 倍
        expect(Math.abs(tab.letterSpacing - tab.expectedSpacing)).toBeLessThanOrEqual(
          0.5,
        );
        // AC-03: 下線が文字幅に揃う
        expect(Math.abs(tab.rightGap)).toBeLessThanOrEqual(1);
        expect(Math.abs(tab.leftGap)).toBeLessThanOrEqual(1);
      }
    });
  }
});
