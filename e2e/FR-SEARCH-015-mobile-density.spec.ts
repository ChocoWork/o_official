import { expect, test } from '@playwright/test';

// FREQ-199: モバイルの文字サイズと余白を参考デザインに合わせて詰める。
// 要素の増減はせず、md 以上は従来の値を維持する。

type Measured = {
  label: number;
  title: number;
  meta: number;
  rowHeight: number;
  tabsHorizontal: boolean;
  firstTabLeft: number;
  lastTabRight: number;
  tablistLeft: number;
  tablistRight: number;
  hasHorizontalScroll: boolean;
};

async function measure(page: import('@playwright/test').Page): Promise<Measured> {
  await page.goto('/search?q=a');
  await expect(page.locator('[data-testid="search-result-row"]').first()).toBeVisible();

  return await page.evaluate(() => {
    const fontSize = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
    const row = document.querySelector('[data-testid="search-result-row"]')!;
    const paragraphs = row.querySelectorAll('p');
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const tablist = document.querySelector('[role="tablist"]')!;
    const scroller = document.scrollingElement!;

    return {
      label: fontSize(paragraphs[0]),
      title: fontSize(paragraphs[1]),
      meta: fontSize(paragraphs[2]),
      rowHeight: row.querySelector('a')!.getBoundingClientRect().height,
      tabsHorizontal:
        Math.abs(
          tabs[0].getBoundingClientRect().y - tabs[1].getBoundingClientRect().y,
        ) <= 2,
      firstTabLeft: tabs[0].getBoundingClientRect().left,
      lastTabRight: tabs[tabs.length - 1].getBoundingClientRect().right,
      tablistLeft: tablist.getBoundingClientRect().left,
      tablistRight: tablist.getBoundingClientRect().right,
      hasHorizontalScroll: scroller.scrollWidth > scroller.clientWidth,
    };
  });
}

test.describe('FR-SEARCH-015 モバイルの文字サイズと余白', () => {
  test('AC-01 モバイルのタブが全幅に均等配置される', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await measure(page);

    expect(mobile.tabsHorizontal).toBe(true);
    // FREQ-200 でタブ列に左右パディングを追加したため、先頭/末尾タブは
    // タブ列端より内側に入る（全幅一致は FREQ-200-AC-01 で置換）。
    expect(mobile.firstTabLeft).toBeGreaterThan(mobile.tablistLeft);
    expect(mobile.lastTabRight).toBeLessThan(mobile.tablistRight);
  });

  test('AC-02/AC-03 モバイルは文字も行も tablet / desktop より小さい', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await measure(page);

    await page.setViewportSize({ width: 768, height: 1024 });
    const tablet = await measure(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    const desktop = await measure(page);

    for (const larger of [tablet, desktop]) {
      expect(mobile.title).toBeLessThan(larger.title);
      expect(mobile.meta).toBeLessThan(larger.meta);
      expect(mobile.label).toBeLessThan(larger.label);
      expect(mobile.rowHeight).toBeLessThan(larger.rowHeight);
    }

    // 段の大小関係: タイトル > メタ ≧ 種別ラベル
    expect(mobile.title).toBeGreaterThan(mobile.meta);
    expect(mobile.meta).toBeGreaterThanOrEqual(mobile.label);

    for (const measured of [mobile, tablet, desktop]) {
      expect(measured.hasHorizontalScroll).toBe(false);
    }
  });
});
