import { test } from '@playwright/test';

test('Slider visual track pixel comparison at 2x DPR', async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await page.goto('/ui');
  await page.waitForLoadState('networkidle');
  await page.getByText('SINGLE VALUE').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  for (const size of ['xs', 'sm', 'md', 'lg', 'xl'] as const) {
    const sizeBtn = page.locator('button').filter({ hasText: new RegExp(`^${size}$`, 'i') }).first();
    await sizeBtn.click();
    await page.waitForTimeout(300);

    // Screenshot the slider section
    const section = page.locator('section').filter({ has: page.getByText('SINGLE VALUE') });
    await section.screenshot({ path: `e2e/screenshots/slider-2x-${size}.png` });

    // Measure the track pixel heights using canvas
    const pixelData = await page.evaluate(() => {
      const tracks = document.querySelectorAll('[data-ui-slider-track]');
      const results = [];
      for (const track of tracks) {
        const rect = track.getBoundingClientRect();
        const slider = track.closest('[data-ui-slider]');
        const isRange = !!slider?.querySelector('[data-ui-slider-range-input]');
        results.push({
          isRange,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
      }
      return results;
    });

    console.log(`\n[${size.toUpperCase()}] @ 2x DPR:`);
    for (const d of pixelData) {
      const type = d.isRange ? 'RANGE ' : 'SINGLE';
      // At 2x DPR, device pixels = CSS pixels × 2
      const deviceH = d.rect.height * 2;
      console.log(`  ${type}: CSS height=${d.rect.height.toFixed(4)}px  device pixels=${deviceH.toFixed(2)}dp`);
    }
  }
  await context.close();
});
