import { test, expect, Page } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

// FREQ-162: 参考サイト同様に画像を上端基準で配置し、最低ファーストビュー高を確保する

async function gotoFirstItemDetail(page: Page): Promise<boolean> {
  const item = await fetchFirstItemViaApi(page);
  if (!item) return false;
  await page.goto(`/item/${item.id}`);
  await page.waitForLoadState('networkidle');
  return true;
}

/** ファーストビューラッパー内の上余白・下余白（px）を計測する */
async function measureFirstViewGaps(
  page: Page,
): Promise<{ topGap: number; bottomGap: number } | null> {
  return page.evaluate(() => {
    const wrapper = document.querySelector(
      '[data-testid="item-detail-first-view"]',
    );
    if (!wrapper) return null;
    const children = [...wrapper.children].filter(
      (el) => el.getBoundingClientRect().height > 0,
    );
    if (children.length === 0) return null;
    const wrapperRect = wrapper.getBoundingClientRect();
    const firstRect = children[0].getBoundingClientRect();
    const lastRect = children[children.length - 1].getBoundingClientRect();
    return {
      topGap: firstRect.top - wrapperRect.top,
      bottomGap: wrapperRect.bottom - lastRect.bottom,
    };
  });
}

test.describe('FR-ITEM-DETAIL-018 上端基準配置 (4K相当 2552x1267)', () => {
  test.use({ viewport: { width: 2552, height: 1267 } });

  test('FREQ-162: コンテンツがファーストビュー領域の上端から表示される', async ({
    page,
  }) => {
    const ok = await gotoFirstItemDetail(page);
    test.skip(!ok, '公開商品データがないためスキップ');

    const gaps = await measureFirstViewGaps(page);
    expect(gaps).not.toBeNull();
    expect(Math.abs(gaps!.topGap)).toBeLessThanOrEqual(1);
    expect(gaps!.bottomGap).toBeGreaterThanOrEqual(0);
  });
});

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-018 上端基準配置 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-156-AC-02: レイアウトが崩れず横スクロールも発生しない', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      const gaps = await measureFirstViewGaps(page);
      expect(gaps).not.toBeNull();
      expect(Math.abs(gaps!.topGap)).toBeLessThanOrEqual(1);
      expect(gaps!.bottomGap).toBeGreaterThanOrEqual(0);

      const { scrollW, clientW } = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(scrollW).toBeLessThanOrEqual(clientW);
    });
  });
}
