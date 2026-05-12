import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-008 mobile filter initial offset', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('初期表示でフィルターバーがヘッダー直下に収まり、先頭記事と重ならない', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const filterButton = page.getByRole('button', { name: 'FILTER', exact: true });
    const firstArticle = page.locator('main article').first();

    await expect(filterButton).toBeVisible();
    await expect(firstArticle).toBeVisible();

    const metrics = await page.evaluate(() => {
      const header = document.querySelector('header');
      const filterButton = Array.from(document.querySelectorAll('button')).find(
        (element) => element.textContent?.trim() === 'FILTER',
      );
      const filterBar = filterButton?.closest('div[class*="border-b"]');
      const firstArticle = document.querySelector('main article');

      const rect = (element: Element | null) => {
        if (!element) {
          return null;
        }

        const { top, bottom, height } = element.getBoundingClientRect();
        return { top, bottom, height };
      };

      return {
        header: rect(header),
        filterBar: rect(filterBar),
        filterButton: rect(filterButton),
        firstArticle: rect(firstArticle),
      };
    });

    if (!metrics.header || !metrics.filterBar || !metrics.filterButton || !metrics.firstArticle) {
      throw new Error('Failed to collect mobile news layout metrics');
    }

    expect(metrics.filterBar.top - metrics.header.bottom).toBeLessThanOrEqual(2);
    expect(metrics.filterButton.top - metrics.header.bottom).toBeLessThanOrEqual(24);
    expect(metrics.firstArticle.top).toBeGreaterThanOrEqual(metrics.filterBar.bottom - 1);
  });
});