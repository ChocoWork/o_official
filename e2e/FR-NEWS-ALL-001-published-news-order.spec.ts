import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-001 published news order', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('公開済みニュースが公開日降順で表示される', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible();

    const dates = await cards.evaluateAll((nodes) =>
      nodes
        .map((node) => node.querySelector('span')?.textContent?.trim() ?? '')
        .filter((value) => /^\d{4}\.\d{2}\.\d{2}$/.test(value)),
    );

    expect(dates.length).toBeGreaterThan(1);

    const timestamps = dates.map((value) => Date.parse(value.replace(/\./g, '-')));
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(timestamps[index - 1]).toBeGreaterThanOrEqual(timestamps[index]);
    }
  });
});
