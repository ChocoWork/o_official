import { test, expect } from '@playwright/test';

const SIZES = ['xs', 'sm', 'md', 'lg', 'xl'] as const;

test('Slider track height: single vs range must match for all sizes', async ({ page }) => {
  await page.goto('/ui');
  await page.waitForLoadState('networkidle');

  // Scroll to Slider section
  await page.getByText('SINGLE VALUE').first().scrollIntoViewIfNeeded();

  const results: Record<string, { single: number; range: number }> = {};

  for (const size of SIZES) {
    // Click the size button
    const sizeBtn = page.locator(`button`).filter({ hasText: new RegExp(`^${size}$`, 'i') }).first();
    await sizeBtn.click();
    await page.waitForTimeout(200);

    // Measure all [data-ui-slider-track] elements in the Slider section
    const tracks = page.locator('[data-ui-slider-track]');
    const count = await tracks.count();

    let singleH = 0;
    let rangeH = 0;

    for (let i = 0; i < count; i++) {
      const track = tracks.nth(i);
      const box = await track.boundingBox();
      if (!box) continue;

      // Determine single vs range by checking the parent structure
      const isRange = await track.locator('..').locator('[data-ui-slider-range-input]').count() > 0;
      if (isRange) {
        rangeH = box.height;
      } else {
        singleH = box.height;
      }
    }

    results[size] = { single: singleH, range: rangeH };
    console.log(`[${size.toUpperCase()}] single: ${singleH.toFixed(3)}px  range: ${rangeH.toFixed(3)}px  diff: ${Math.abs(singleH - rangeH).toFixed(3)}px`);
  }

  // Assert: all sizes must have the same track height for single and range
  for (const size of SIZES) {
    const { single, range } = results[size];
    expect(
      Math.abs(single - range),
      `[${size}] single(${single.toFixed(3)}) vs range(${range.toFixed(3)}) differ by more than 0.5px`
    ).toBeLessThanOrEqual(0.5);
  }
});
