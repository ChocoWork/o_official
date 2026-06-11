import { test } from '@playwright/test';

test('Slider with input hidden - isolate visual source', async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await page.goto('/ui');
  await page.waitForLoadState('networkidle');

  // Set to MD
  const mdBtn = page.locator('button').filter({ hasText: /^md$/i }).first();
  await mdBtn.click();
  await page.getByText('SINGLE VALUE').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  // Normal screenshot (baseline)
  const section = page.locator('section').filter({ has: page.getByText('SINGLE VALUE') });
  await section.screenshot({ path: 'e2e/screenshots/debug-normal.png' });

  // Hide single slider input
  await page.evaluate(() => {
    const input = document.querySelector('[data-ui-slider-input]') as HTMLElement;
    if (input) input.style.display = 'none';
  });
  await page.waitForTimeout(100);
  await section.screenshot({ path: 'e2e/screenshots/debug-input-hidden.png' });

  // Restore input, then check webkit runnable track with red background
  await page.evaluate(() => {
    const input = document.querySelector('[data-ui-slider-input]') as HTMLElement;
    if (input) input.style.display = '';
  });

  // Add a style to show the webkit runnable track as semi-transparent
  await page.addStyleTag({ content: `
    [data-ui-slider-input]::-webkit-slider-runnable-track {
      background: rgba(255,0,0,0.3) !important;
    }
  `});
  await page.waitForTimeout(100);
  await section.screenshot({ path: 'e2e/screenshots/debug-track-red.png' });
});
