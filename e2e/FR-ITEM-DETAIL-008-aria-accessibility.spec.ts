import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-DETAIL-008 ARIA アクセシビリティ', () => {
  test('カラーボタンに aria-pressed 属性が付与される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    const colorSection = page.locator('h3:has-text("COLOR")');
    if (!(await colorSection.isVisible())) {
      test.skip(true, 'カラー選択肢なし');
      return;
    }

    const colorButtons = page.locator('h3:has-text("COLOR") + div button');
    const count = await colorButtons.count();
    expect(count).toBeGreaterThan(0);

    // 最初のボタンに aria-pressed が付与されていること
    await expect(colorButtons.first()).toHaveAttribute('aria-pressed');
  });

  test('サイズボタンに aria-pressed 属性が付与される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    const sizeSection = page.locator('h3:has-text("SIZE")');
    if (!(await sizeSection.isVisible())) {
      test.skip(true, 'サイズ選択肢なし');
      return;
    }

    const sizeButtons = page.locator('h3:has-text("SIZE") + div button');
    const count = await sizeButtons.count();
    expect(count).toBeGreaterThan(0);

    await expect(sizeButtons.first()).toHaveAttribute('aria-pressed');
  });

  test('未選択エラーメッセージに role="alert" が付与される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    // サイズ未選択の状態でカート追加を試みる
    // サイズを選択しないでカート追加 -> role="alert" が出るはず
    const sizeButtons = page.locator('h3:has-text("SIZE") + div button');
    if ((await sizeButtons.count()) > 0) {
      // サイズが存在する場合は未選択のまま追加ボタンをクリック
      // ただし alert() の代わりに role="alert" が使われることが前提
      // 実装後に role="alert" を確認
      const cartBtn = page.getByText('ADD TO CART').first();
      await cartBtn.click();

      const alertEl = page.locator('[role="alert"]');
      await expect(alertEl).toBeVisible({ timeout: 3000 });
    }
  });
});
