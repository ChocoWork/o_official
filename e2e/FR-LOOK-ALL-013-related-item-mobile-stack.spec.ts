import { expect, test, type Page } from '@playwright/test';

// FREQ-56: 関連アイテムの商品名と価格を、モバイルでは縦積み（折り返し回避）、
// タブレット・PC では同一行で表示する。

type ItemLayout = {
  nameBottom: number;
  priceTop: number;
  sameRow: boolean;
};

async function readFirstRelatedItemLayout(page: Page): Promise<ItemLayout | null> {
  return page.locator('main').evaluate((scope) => {
    const link = scope.querySelector<HTMLElement>('a.look-related-item-text');
    if (!link) return null;
    const spans = link.querySelectorAll<HTMLElement>('span');
    if (spans.length < 2) return null;

    const nameRect = spans[0].getBoundingClientRect();
    const priceRect = spans[1].getBoundingClientRect();
    // 同一行 = 縦方向に重なる（行ボックスが交差する）
    const sameRow =
      priceRect.top < nameRect.bottom && nameRect.top < priceRect.bottom;

    return {
      nameBottom: Number(nameRect.bottom.toFixed(2)),
      priceTop: Number(priceRect.top.toFixed(2)),
      sameRow,
    };
  });
}

test.describe('FR-LOOK-ALL-013 関連アイテムのモバイル縦積み', () => {
  test('mobile では商品名と価格が縦積みになる', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 }); // iPhone SE
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();

    const layout = await readFirstRelatedItemLayout(page);
    expect(layout, 'mobile に関連アイテムが見つかりませんでした').not.toBeNull();
    expect(layout!.sameRow, 'mobile では同一行であってはならない').toBe(false);
    expect(layout!.priceTop).toBeGreaterThanOrEqual(layout!.nameBottom);
  });

  test('tablet では商品名と価格が同一行に並ぶ', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();

    const layout = await readFirstRelatedItemLayout(page);
    expect(layout, 'tablet に関連アイテムが見つかりませんでした').not.toBeNull();
    expect(layout!.sameRow, 'tablet では同一行であるべき').toBe(true);
  });

  // FREQ-133: desktop はカード下の関連アイテムリスト自体を表示しない
  test('desktop ではカード下の関連アイテムが表示されない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/look');
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('main a.look-related-item-text').first()).toBeHidden();
  });
});
