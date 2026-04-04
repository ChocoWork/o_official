import { test, expect } from '@playwright/test';

/**
 * Home page ABOUT section typography verification
 * Checks that the PHILOSOPHY text does not wrap across all viewports.
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('Home ABOUT section – typography', () => {
  for (const vp of viewports) {
    test(`ABOUT section renders correctly on ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      // Scroll to ABOUT section
      await page.locator('#about').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);

      // PHILOSOPHY text must be visible
      const philosophyText = page.locator('#about').getByText('時代を超えた普遂的な美しさ');
      await expect(philosophyText).toBeVisible();

      // Verify PHILOSOPHY text is single-line (not wrapped)
      // clientHeight should be roughly equal to line-height (≤ 32px for text-xs)
      const lineCount = await philosophyText.evaluate((el) => {
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
        return Math.round(el.getBoundingClientRect().height / lineHeight);
      });
      expect(lineCount).toBe(1);

      // Body text paragraphs should be visible
      const bodyParagraph = page.locator('#about').locator('p').first();
      await expect(bodyParagraph).toBeVisible();

      // Take full-page screenshot for visual inspection
      await page.screenshot({
        path: `test-results/about-section-${vp.name}-${vp.width}w.png`,
        fullPage: true,
      });
    });
  }
});
