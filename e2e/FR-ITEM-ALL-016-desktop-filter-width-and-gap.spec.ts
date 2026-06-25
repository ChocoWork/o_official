import { expect, test } from '@playwright/test';
import { gotoItemList, itemCards } from './item-list-test-utils';

// FREQ-39-AC-01: デスクトップでフィルター列を広げ、ITEMグリッドとの間に余白を設ける。
test.describe('FR-ITEM-ALL-016 デスクトップのフィルター列幅とITEMとの余白', () => {
  test('フィルターサイドバーが233px以上、ITEMグリッドとの間隔が21px以上', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoItemList(page);

    const sidebar = page.locator('aside').first();
    await expect(sidebar).toBeVisible();

    const firstCard = itemCards(page).first();
    await expect(firstCard).toBeVisible();

    const sidebarBox = await sidebar.boundingBox();
    const cardBox = await firstCard.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(cardBox).not.toBeNull();

    // フィルター列幅が拡張されている
    expect(sidebarBox!.width).toBeGreaterThanOrEqual(233);

    // サイドバー右端とITEMグリッド先頭カード左端の間に余白がある
    const gap = cardBox!.x - (sidebarBox!.x + sidebarBox!.width);
    expect(gap).toBeGreaterThanOrEqual(21);
  });
});
