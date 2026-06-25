import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

// FREQ-38-AC-01: デスクトップで下方向にスクロールしてもフィルターサイドバーの上端が動かない。
// （ヘッダー自動非表示に連動する --site-header-offset ではなく定数の高さに固定したため）
test.describe('FR-ITEM-ALL-015 デスクトップのフィルターがスクロールで動かない', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('右側スクロール後もフィルターサイドバーの上端Y座標が変わらない', async ({ page }) => {
    await gotoItemList(page);

    const sidebar = page.locator('aside').first();
    await expect(sidebar).toBeVisible();

    const before = await sidebar.boundingBox();
    expect(before).not.toBeNull();

    // ヘッダーが自動非表示になる閾値（50px）を超えてスクロールする。
    await page.mouse.move(960, 450);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(400); // 旧実装のtransition(300ms)分の猶予

    const after = await sidebar.boundingBox();
    expect(after).not.toBeNull();

    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
  });
});
