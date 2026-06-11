import { test } from '@playwright/test';

test('Slider fill vs track height comparison', async ({ page }) => {
  await page.goto('/ui');
  await page.waitForLoadState('networkidle');
  await page.getByText('SINGLE VALUE').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  for (const size of ['xs', 'sm', 'md', 'lg', 'xl'] as const) {
    const sizeBtn = page.locator('button').filter({ hasText: new RegExp(`^${size}$`, 'i') }).first();
    await sizeBtn.click();
    await page.waitForTimeout(300);

    const data = await page.evaluate(() => {
      const sliders = document.querySelectorAll('[data-ui-slider]');
      return Array.from(sliders).map((slider) => {
        const isRange = !!slider.querySelector('[data-ui-slider-range-input]');
        const track = slider.querySelector('[data-ui-slider-track]') as HTMLElement;
        const fill = slider.querySelector('[data-ui-slider-fill]') as HTMLElement;
        const trackWrap = slider.querySelector('[data-ui-slider-track-wrap]') as HTMLElement;

        const trackRect = track?.getBoundingClientRect();
        const fillRect = fill?.getBoundingClientRect();
        const wrapRect = trackWrap?.getBoundingClientRect();

        const fillCs = fill ? window.getComputedStyle(fill) : null;

        return {
          isRange,
          trackH: trackRect?.height,
          fillH: fillRect?.height,
          fillTop: fillCs?.top,
          fillBottom: fillCs?.bottom,
          fillInsetBlock: fillCs?.insetBlock,
          fillBorderRadius: fillCs?.borderRadius,
          wrapH: wrapRect?.height,
        };
      });
    });

    console.log(`\n[${size.toUpperCase()}]`);
    for (const d of data) {
      const type = d.isRange ? 'RANGE' : 'SINGLE';
      console.log(`  ${type}: trackH=${d.trackH?.toFixed(4)}  fillH=${d.fillH?.toFixed(4)}  wrapH=${d.wrapH?.toFixed(4)}`);
      console.log(`         fillInsetBlock="${d.fillInsetBlock}"  fillBorderRadius="${d.fillBorderRadius}"`);
    }
  }
});
