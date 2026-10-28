import { expect, test, type Page } from '@playwright/test';

// SEARCH の種別フィルタ（ALL / ITEM / LOOK / NEWS）の下線・候補ドロップダウン・結果行について、
// FREQ-192 / 193 / 195 / 199 / 200 / 201 の受け入れ基準を 3 つの幅で確かめる（匿名）。
// 見出しの無い要求が集まる送り元 null の枠（search:public 120 回/600 秒）を他の検索の試験と取り合わないよう、このファイルだけの
// x-real-ip を付ける（E2E の固定の環境 CLIENT_IP_HEADER=x-real-ip が信頼する見出し。x-forwarded-for は読まれない）。
test.use({ extraHTTPHeaders: { 'x-real-ip': '198.18.24.24' } });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

type UnderlineGap = { label: string; leftGap: number; rightGap: number };

// 各タブの下線の左右端と、最初/最後の文字のグリフ端との差を測る
async function measureUnderlineGaps(page: Page): Promise<UnderlineGap[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')].map((tab) => {
      const underline = tab.querySelector('.underline-animation-left2right')!;
      const labelSpan = underline.parentElement!;
      const textNode = [...labelSpan.childNodes].find(
        (node) => node.nodeType === 3 && node.textContent!.trim().length > 0,
      )!;
      const text = textNode.textContent!;
      const letterSpacing = parseFloat(getComputedStyle(labelSpan).letterSpacing);

      // 最後の文字の矩形には末尾の字間が含まれるので差し引いてグリフ右端を得る
      const lastChar = document.createRange();
      lastChar.setStart(textNode, text.length - 1);
      lastChar.setEnd(textNode, text.length);
      const glyphRight = lastChar.getBoundingClientRect().right - letterSpacing;

      const firstChar = document.createRange();
      firstChar.setStart(textNode, 0);
      firstChar.setEnd(textNode, 1);
      const glyphLeft = firstChar.getBoundingClientRect().left;

      // 非選択タブの下線は scale-x-0 で潰れるため、実寸は offsetWidth で測る
      const underlineLeft = underline.getBoundingClientRect().left;
      const underlineWidth = (underline as HTMLElement).offsetWidth;

      return {
        label: text.trim(),
        leftGap: glyphLeft - underlineLeft,
        rightGap: underlineLeft + underlineWidth - glyphRight,
      };
    }),
  );
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const scroller = document.scrollingElement!;
    return scroller.scrollWidth > scroller.clientWidth;
  });
}

test.describe('FR-SEARCH-024 タブの下線・候補・結果行の幅ごとの詳細', () => {
  for (const vp of VIEWPORTS) {
    test(`FREQ-192-AC-03 ${vp.name} 選択中タブの下線は 1・非選択は 0・ホバーで 1`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');
      await expect(page.getByRole('tab', { name: 'ALL' })).toBeVisible();

      const selectedTab = page.getByRole('tab', { name: 'ALL' });
      await expect(selectedTab).toHaveAttribute('aria-selected', 'true');

      // Tailwind v4 は scale-x-* を個別プロパティ scale で出力する（伸び切りは "1"、未表示は "0 1"）
      const scaleOf = async (tab: typeof selectedTab) =>
        await tab
          .locator('.underline-animation-left2right')
          .evaluate((el) => getComputedStyle(el).scale);

      expect(await scaleOf(selectedTab)).toBe('1');

      // 選択されていない ITEM・LOOK・NEWS のどれも、下線は 0
      const idleTabs = ['ITEM', 'LOOK', 'NEWS'].map((label) => page.getByRole('tab', { name: label }));
      for (const idleTab of idleTabs) {
        await expect(idleTab).toHaveAttribute('aria-selected', 'false');
        expect(await scaleOf(idleTab)).toBe('0 1');
      }

      // ホバーで 1（ホバーしたタブだけが伸びる）
      await idleTabs[1].hover();
      await expect.poll(async () => await scaleOf(idleTabs[1])).toBe('1');
      expect(await scaleOf(idleTabs[0])).toBe('0 1');
    });

    test(`FREQ-193-AC-02 ${vp.name} 各タブの下線の左端が最初の文字の左端と 1px 以内`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');
      await expect(page.getByRole('tab', { name: 'ALL' })).toBeVisible();

      const gaps = await measureUnderlineGaps(page);
      expect(gaps.map((gap) => gap.label)).toEqual(['ALL', 'ITEM', 'LOOK', 'NEWS']);
      for (const gap of gaps) {
        expect(Math.abs(gap.leftGap), `${gap.label} の左端の差`).toBeLessThanOrEqual(1);
      }
    });

    test(`FREQ-195-AC-02 ${vp.name} 候補を開いても横スクロールが発生しない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');

      const input = page.locator('input[type="search"]');
      await input.click();
      await input.pressSequentially('a', { delay: 60 });
      await expect(page.getByRole('listbox', { name: '検索候補' })).toBeVisible();
      await expect(page.locator('[role="option"]').first()).toBeVisible();

      expect(await hasHorizontalScroll(page)).toBe(false);
    });

    test(`FREQ-200-AC-03 ${vp.name} 各タブの下線の両端が文字の両端と 1px 以内`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search');
      await expect(page.getByRole('tab', { name: 'ALL' })).toBeVisible();

      const gaps = await measureUnderlineGaps(page);
      expect(gaps.map((gap) => gap.label)).toEqual(['ALL', 'ITEM', 'LOOK', 'NEWS']);
      for (const gap of gaps) {
        expect(Math.abs(gap.rightGap), `${gap.label} の右端の差`).toBeLessThanOrEqual(1);
        expect(Math.abs(gap.leftGap), `${gap.label} の左端の差`).toBeLessThanOrEqual(1);
      }
    });

    test(`FREQ-201-AC-02 ${vp.name} LOOK の行はシーズン・NEWS の行は公開日のメタ`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search?q=a');
      await expect(page.locator('[data-testid="search-result-row"]').first()).toBeVisible();

      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="search-result-row"]')].map((row) => {
          const paragraphs = row.querySelectorAll('p');
          return {
            label: paragraphs[0]?.textContent?.trim() ?? '',
            meta: paragraphs[2]?.textContent?.trim() ?? '',
          };
        }),
      );

      const looks = rows.filter((row) => row.label === 'LOOK');
      const news = rows.filter((row) => row.label === 'NEWS');
      // 前提: LOOK と NEWS の行が存在する（無ければ検証対象が無い）
      expect(looks.length).toBeGreaterThan(0);
      expect(news.length).toBeGreaterThan(0);

      for (const look of looks) {
        expect(look.meta).toMatch(/^\d{4}\s(SS|AW)$/);
      }
      for (const article of news) {
        expect(article.meta).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
      }
    });
  }

  test('FREQ-199-AC-03 390px の結果行は 768・1280px より低く、どの幅も横スクロールが発生しない', async ({ page }) => {
    const heights: Record<string, number> = {};
    const scrolls: Record<string, boolean> = {};

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/search?q=a');
      const firstRow = page.locator('[data-testid="search-result-row"]').first();
      await expect(firstRow).toBeVisible();

      heights[vp.name] = await firstRow
        .locator('a')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height);
      scrolls[vp.name] = await hasHorizontalScroll(page);
    }

    expect(heights.mobile).toBeLessThan(heights.tablet);
    expect(heights.mobile).toBeLessThan(heights.desktop);
    expect(scrolls).toEqual({ mobile: false, tablet: false, desktop: false });
  });
});
