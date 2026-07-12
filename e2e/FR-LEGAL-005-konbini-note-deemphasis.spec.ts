import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * FREQ-108: /legal「支払方法・支払時期」のコンビニ決済の未入金時キャンセル注記（※）を、
 * 本文より小さいフォント・淡色（#767676）のフットノートとして de-emphasize する。
 */
for (const vp of viewports) {
  test.describe(`FR-LEGAL-005 コンビニ注記の de-emphasis (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/legal');
    });

    test('※注記が本文より小さく淡色（#767676）で表示される', async ({ page }) => {
      const dd = page
        .locator('dt', { hasText: /^支払方法・支払時期$/ })
        .locator('xpath=following-sibling::dd[1]');
      const note = dd.locator('span', { hasText: 'キャンセル' });
      await expect(note).toBeVisible();

      const noteSize = await note.evaluate(
        (el) => parseFloat(getComputedStyle(el).fontSize)
      );
      const bodySize = await dd.evaluate(
        (el) => parseFloat(getComputedStyle(el).fontSize)
      );
      expect(noteSize).toBeLessThan(bodySize);

      const color = await note.evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe('rgb(118, 118, 118)');
    });
  });
}
