import { expect, test } from '@playwright/test';

// FREQ-194: ヘッダーナビの下線も letter-spacing の末尾字間分を差し引いて文字幅に揃える。
// FREQ-195: 候補ドロップダウンを左右 1px 広げ、背後の「ALL」のグリフが覗かないようにする。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-SEARCH-013 下線と候補リストの端揃え', () => {
  test('FREQ-194 ヘッダーナビの下線が文字幅に揃う', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.locator('nav.header-nav-position a').first()).toBeVisible();

    const alignment = await page.evaluate(() =>
      [...document.querySelectorAll('nav.header-nav-position a')].map((link) => {
        const underline = link.querySelector('.underline-animation-left2right')!;
        const textNode = [...link.childNodes].find(
          (node) => node.nodeType === 3 && node.textContent!.trim().length > 0,
        )!;
        const text = textNode.textContent!;
        const letterSpacing = parseFloat(getComputedStyle(link).letterSpacing);

        // 最後の文字の矩形には末尾の字間が含まれるので差し引く
        const lastChar = document.createRange();
        lastChar.setStart(textNode, text.length - 1);
        lastChar.setEnd(textNode, text.length);
        const glyphRight = lastChar.getBoundingClientRect().right - letterSpacing;

        const firstChar = document.createRange();
        firstChar.setStart(textNode, 0);
        firstChar.setEnd(textNode, 1);
        const glyphLeft = firstChar.getBoundingClientRect().left;

        const underlineLeft = underline.getBoundingClientRect().left;
        const underlineWidth = (underline as HTMLElement).offsetWidth;

        return {
          label: text.trim(),
          rightGap: underlineLeft + underlineWidth - glyphRight,
          leftGap: glyphLeft - underlineLeft,
        };
      }),
    );

    expect(alignment.length).toBeGreaterThan(0);
    for (const link of alignment) {
      expect(Math.abs(link.rightGap)).toBeLessThanOrEqual(1);
      expect(Math.abs(link.leftGap)).toBeLessThanOrEqual(1);
    }
  });

  for (const vp of VIEWPORTS) {
    test(`FREQ-195 ${vp.name} 候補リストが背後の「ALL」を覆う`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');

      const input = page.locator('input[type="search"]');
      await input.click();
      await input.pressSequentially('a', { delay: 60 });
      await page.waitForSelector('#search-suggestion-list');
      await expect(page.locator('[role="option"]').first()).toBeVisible();

      const measured = await page.evaluate(() => {
        const list = document.querySelector('#search-suggestion-list')!;
        const allTab = [...document.querySelectorAll('[role="tab"]')].find(
          (tab) => (tab as HTMLElement).innerText.trim() === 'ALL',
        )!;
        const labelSpan = allTab.querySelector('span')!;
        const cs = getComputedStyle(labelSpan);

        // 「A」のインクが文字ボックスより左へ出る量を実フォントから求める
        const ctx = document.createElement('canvas').getContext('2d')!;
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const inkOverflowLeft = ctx.measureText('A').actualBoundingBoxLeft;

        const textNode = [...labelSpan.childNodes].find(
          (node) => node.nodeType === 3,
        )!;
        const firstChar = document.createRange();
        firstChar.setStart(textNode, 0);
        firstChar.setEnd(textNode, 1);
        const glyphInkLeft =
          firstChar.getBoundingClientRect().left - inkOverflowLeft;

        const scroller = document.scrollingElement!;
        return {
          listLeft: list.getBoundingClientRect().left,
          glyphInkLeft,
          verticallyOverlaps:
            list.getBoundingClientRect().bottom > allTab.getBoundingClientRect().top,
          hasHorizontalScroll: scroller.scrollWidth > scroller.clientWidth,
        };
      });

      // 前提: 候補リストはタブに重なっている（重なっていなければ検証の意味がない）
      expect(measured.verticallyOverlaps).toBe(true);
      // AC-01: リスト左端がグリフのインク左端以下 = 文字が外に覗かない
      expect(measured.listLeft).toBeLessThanOrEqual(measured.glyphInkLeft);
      // AC-02
      expect(measured.hasHorizontalScroll).toBe(false);
    });
  }
});
