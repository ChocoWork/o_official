import { test, expect } from '@playwright/test';

test.describe('NFR-HOME-001 home page performance', () => {
  test('initial load completes within 2 seconds', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();

    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (!nav) return null;
      return {
        loadEventEnd: nav.loadEventEnd,
        startTime: nav.startTime,
        domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
        responseEnd: nav.responseEnd,
      };
    });

    expect(metrics).not.toBeNull();
    if (!metrics) return;

    const pageLoadMs = metrics.loadEventEnd - metrics.startTime;
    console.log(`Home page load time: ${pageLoadMs.toFixed(1)}ms`);

    expect(pageLoadMs).toBeLessThanOrEqual(2000);
  });
});
