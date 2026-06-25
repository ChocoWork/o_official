import { expect, Locator, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

// FREQ-46: 並び替えプルダウンと FILTER ボタンの文字サイズ・字間をフィルター見出しに揃える。
// AC-01: デスクトップで並び替えプルダウンの font-size / letter-spacing がフィルター見出しと一致。
// AC-02: モバイル・タブレットで FILTER ボタンの font-size が並び替えプルダウンと一致。

async function typography(locator: Locator) {
  await expect(locator).toBeVisible();
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fontSize: cs.fontSize, letterSpacing: cs.letterSpacing };
  });
}

test.describe('FR-ITEM-ALL-023 並び替え/FILTER タイポグラフィ統一', () => {
  test('desktop: プルダウンの文字サイズ・字間がフィルター見出しと一致', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoItemList(page);

    const sortTrigger = page.locator('.single-select__trigger:visible').first();
    const filterHeading = page.locator('aside [data-ui-accordion-trigger]').first();

    const sort = await typography(sortTrigger);
    const heading = await typography(filterHeading);

    expect(sort.fontSize).toBe(heading.fontSize);
    expect(sort.letterSpacing).toBe(heading.letterSpacing);
  });

  for (const vp of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ] as const) {
    test(`${vp.name}: FILTER ボタンの文字サイズがプルダウンと一致`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoItemList(page);

      const filterButton = page.locator('[data-filter-button="floating"]');
      const sortTrigger = page.locator('.single-select__trigger:visible').first();

      const button = await typography(filterButton);
      const sort = await typography(sortTrigger);

      expect(button.fontSize).toBe(sort.fontSize);
    });
  }
});
