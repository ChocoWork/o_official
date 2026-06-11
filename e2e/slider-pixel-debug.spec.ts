import { test } from '@playwright/test';

test('Slider pixel-level debug', async ({ browser }) => {
  // Use 2x DPR to simulate retina
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await context.newPage();

  await page.goto('/ui');
  await page.waitForLoadState('networkidle');
  await page.getByText('SINGLE VALUE').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  for (const size of ['xs', 'sm', 'md', 'lg', 'xl'] as const) {
    const sizeBtn = page.locator('button').filter({ hasText: new RegExp(`^${size}$`, 'i') }).first();
    await sizeBtn.click();
    await page.waitForTimeout(300);

    // Measure all CSS custom properties on the slider element
    const cssVars = await page.evaluate((sz) => {
      const sliders = document.querySelectorAll('[data-ui-slider]');
      return Array.from(sliders).map((el, i) => {
        const cs = window.getComputedStyle(el);
        const isRange = !!el.querySelector('[data-ui-slider-range-input]');
        const track = el.querySelector('[data-ui-slider-track]') as HTMLElement;
        const trackCs = track ? window.getComputedStyle(track) : null;
        const trackRect = track ? track.getBoundingClientRect() : null;
        const input = el.querySelector('[data-ui-slider-input], [data-ui-slider-range-input]') as HTMLInputElement;
        const inputCs = input ? window.getComputedStyle(input) : null;
        const inputRect = input ? input.getBoundingClientRect() : null;
        return {
          index: i,
          isRange,
          size: sz,
          trackHeight: trackRect?.height,
          trackComputedHeight: trackCs?.height,
          trackBorderRadius: trackCs?.borderRadius,
          inputHeight: inputRect?.height,
          inputBackground: inputCs?.background,
          inputZIndex: inputCs?.zIndex,
        };
      });
    }, size);

    console.log(`\n=== ${size.toUpperCase()} ===`);
    for (const v of cssVars) {
      console.log(JSON.stringify(v, null, 2));
    }
  }

  await context.close();
});
