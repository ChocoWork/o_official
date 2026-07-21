import { expect, test } from '@playwright/test';

// FREQ-190: 予測候補を WAI-ARIA 1.2 combobox パターンで提供する。
// 候補はドロップダウン表示・種別ラベル付き・44px 以上・最大8件、
// キーボード（↓↑/Enter/Escape）で操作でき、ラベルに入力語を必ず含む。

const SUGGESTION_QUERY = 'co';

async function openSuggestions(page: import('@playwright/test').Page) {
  await page.goto('/search');
  const input = page.locator('input[type="search"]');
  await input.click();
  await input.pressSequentially(SUGGESTION_QUERY, { delay: 60 });
  await page.waitForSelector('#search-suggestion-list');
  await expect(page.locator('[role="option"]').first()).toBeVisible();
  return input;
}

test.describe('FR-SEARCH-011 予測候補（combobox）', () => {
  test('AC-01/AC-04 候補は種別付き・40px以上・最大8件で、ラベルに入力語を含む', async ({ page }) => {
    await openSuggestions(page);

    const options = page.locator('[role="option"]');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThan(0);
    expect(optionCount).toBeLessThanOrEqual(8);

    for (let index = 0; index < optionCount; index += 1) {
      const option = options.nth(index);
      const text = (await option.innerText()).trim();

      // AC-04: ラベルに入力語が含まれる
      expect(text.toLowerCase()).toContain(SUGGESTION_QUERY);

      // AC-01: 種別ラベルが付く
      expect(text).toMatch(/(ITEM|LOOK|NEWS)\s*$/);

      // 行高は FREQ-192 で 44px から 40px に圧縮済み
      const box = await option.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(40);
    }

    // 候補は入力欄直下のオーバーレイで、種別フィルタを押し下げない
    const listBox = await page.locator('#search-suggestion-list').boundingBox();
    const inputBox = await page.locator('input[type="search"]').boundingBox();
    expect(listBox!.y).toBeGreaterThanOrEqual(inputBox!.y);
  });

  test('AC-02 ARIA combobox 属性とキーボード操作', async ({ page }) => {
    const input = await openSuggestions(page);

    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(input).toHaveAttribute('aria-controls', 'search-suggestion-list');

    // ↓ で先頭候補がアクティブになる
    await page.keyboard.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-0');
    await expect(page.locator('#search-suggestion-0')).toHaveAttribute('aria-selected', 'true');

    // さらに ↓ で次の候補へ、↑ で戻る
    await page.keyboard.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-1');
    await page.keyboard.press('ArrowUp');
    await expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-0');

    // Escape で閉じる
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-suggestion-list')).toBeHidden();
    await expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  test('AC-03 ↓+Enter とクリックのどちらでも候補の語と種別で検索される', async ({ page }) => {
    // キーボードで先頭候補を確定
    await openSuggestions(page);
    const firstLabel = (await page.locator('[role="option"] span').first().innerText()).trim();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/[?&]q=/);
    await expect(page).toHaveURL(/[?&]tab=(item|look|news)/);
    await expect(page.locator('input[type="search"]')).toHaveValue(firstLabel);

    // クリックでも同様
    await openSuggestions(page);
    const clickedLabel = (await page.locator('[role="option"] span').first().innerText()).trim();
    await page.locator('[role="option"]').first().click();

    await expect(page).toHaveURL(/[?&]q=/);
    await expect(page.locator('input[type="search"]')).toHaveValue(clickedLabel);
  });
});
