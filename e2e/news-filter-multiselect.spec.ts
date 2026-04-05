import { expect, test } from '@playwright/test';

/**
 * NEWS フィルター MultiSelect 動作確認テスト（モバイル 375px）
 * - ALL 選択中に他カテゴリを選択すると ALL が外れて他のみになる
 * - 複数カテゴリを選択できる
 * - ALL を選択するとすべてリセットされる
 * - 全解除したら ALL に戻る
 */
test.describe('NEWS filter MultiSelect behavior', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');
  });

  test('初期状態: ALL が選択されドロップダウントリガーに ALL が表示される', async ({ page }) => {
    const trigger = page.locator('button[aria-haspopup="listbox"]');
    await expect(trigger).toBeVisible();
    // トリガー内テキストに ALL が含まれる
    await expect(trigger).toContainText('ALL');

    await page.screenshot({
      path: 'playwright-report/filter-initial.png',
      fullPage: false,
    });
  });

  test('ALL 選択中に他カテゴリを選ぶと、ALL が外れてそのカテゴリのみになる', async ({ page }) => {
    const trigger = page.locator('button[aria-haspopup="listbox"]');
    await trigger.click();
    await page.waitForTimeout(200);

    // ALL 以外の最初のカテゴリラベルを取得してクリック
    const dropdownItems = page.locator('[aria-haspopup="listbox"] ~ div label');
    const firstNonAll = dropdownItems.filter({ hasNot: page.locator('span', { hasText: /^ALL$/ }) }).first();
    // labelテキストを取得
    const labelText = await dropdownItems.nth(1).locator('span').last().textContent();

    await dropdownItems.nth(1).click();
    await page.waitForTimeout(200);

    await page.screenshot({
      path: 'playwright-report/filter-non-all-selected.png',
      fullPage: false,
    });

    // トリガーに ALL が含まれない（他カテゴリのみ）
    if (labelText) {
      await expect(trigger).toContainText(labelText.trim());
    }
    await expect(trigger).not.toContainText('ALL');
  });

  test('複数カテゴリを選択できる', async ({ page }) => {
    const trigger = page.locator('button[aria-haspopup="listbox"]');
    await trigger.click();
    await page.waitForTimeout(200);

    const dropdownItems = page.locator('[aria-haspopup="listbox"] ~ div label');
    // 2番目のカテゴリを選択（ALL を外す）
    await dropdownItems.nth(1).click();
    await page.waitForTimeout(100);

    // 3番目のカテゴリを追加選択
    await dropdownItems.nth(2).click();
    await page.waitForTimeout(200);

    await page.screenshot({
      path: 'playwright-report/filter-multi-selected.png',
      fullPage: false,
    });

    // トリガーに複数カテゴリが表示されている（ALL は含まれない）
    await expect(trigger).not.toContainText('ALL');
  });

  test('複数選択中に ALL を選ぶと ALL のみにリセットされる', async ({ page }) => {
    const trigger = page.locator('button[aria-haspopup="listbox"]');
    // まず2つ選択
    await trigger.click();
    await page.waitForTimeout(200);

    const dropdownItems = page.locator('[aria-haspopup="listbox"] ~ div label');
    await dropdownItems.nth(1).click();
    await page.waitForTimeout(100);
    await dropdownItems.nth(2).click();
    await page.waitForTimeout(100);

    // 次に ALL をクリック
    await dropdownItems.nth(0).click();
    await page.waitForTimeout(200);

    await page.screenshot({
      path: 'playwright-report/filter-reset-to-all.png',
      fullPage: false,
    });

    // トリガーが ALL のみ
    await expect(trigger).toContainText('ALL');
  });

  test('選択したカテゴリを全解除すると ALL に戻る', async ({ page }) => {
    const trigger = page.locator('button[aria-haspopup="listbox"]');
    await trigger.click();
    await page.waitForTimeout(200);

    const dropdownItems = page.locator('[aria-haspopup="listbox"] ~ div label');
    // 1つ選択
    await dropdownItems.nth(1).click();
    await page.waitForTimeout(100);

    // 同じカテゴリを再クリックして解除
    await dropdownItems.nth(1).click();
    await page.waitForTimeout(200);

    await page.screenshot({
      path: 'playwright-report/filter-deselect-back-to-all.png',
      fullPage: false,
    });

    // ALL に戻る
    await expect(trigger).toContainText('ALL');
  });
});
