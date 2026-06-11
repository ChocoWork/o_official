import { test } from '@playwright/test';

const SIZES = ['xs', 'sm', 'md', 'lg', 'xl'] as const;

test('Slider screenshot comparison', async ({ page }) => {
  await page.goto('/ui');
  await page.waitForLoadState('networkidle');

  // Scroll to Slider section
  await page.getByText('SINGLE VALUE').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  for (const size of SIZES) {
    const sizeBtn = page.locator(`button`).filter({ hasText: new RegExp(`^${size}$`, 'i') }).first();
    await sizeBtn.click();
    await page.waitForTimeout(300);

    // Get bounding box of the slider section
    const sliderSection = page.locator('section').filter({ has: page.getByText('SINGLE VALUE') });

    await sliderSection.screenshot({
      path: `e2e/screenshots/slider-${size}.png`,
    });

    // Also log computed style
    const trackHeight = await page.evaluate(() => {
      const tracks = document.querySelectorAll('[data-ui-slider-track]');
      return Array.from(tracks).map((el, i) => {
        const rect = el.getBoundingClientRect();
        const computed = window.getComputedStyle(el);
        return {
          index: i,
          isRange: !!el.closest('[data-ui-slider]')?.querySelector('[data-ui-slider-range-input]'),
          boundingHeight: rect.height,
          computedHeight: computed.height,
        };
      });
    });

    console.log(`[${size.toUpperCase()}]`, JSON.stringify(trackHeight, null, 2));
  }
});
