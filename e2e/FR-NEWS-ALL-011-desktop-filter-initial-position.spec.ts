import { expect, test } from '@playwright/test';

type DesktopFilterMetrics = {
  headerBottom: number;
  firstFilterTop: number;
  firstArticleTop: number;
};

async function collectDesktopFilterMetrics(page: Parameters<typeof test>[0]['page']): Promise<DesktopFilterMetrics> {
  const metrics = await page.evaluate(() => {
    const header = document.querySelector('header');
    const firstFilter = document.querySelector('aside input[type="checkbox"]');
    const firstArticle = document.querySelector('main article');

    const headerBottom = header?.getBoundingClientRect().bottom ?? null;
    const firstFilterTop = firstFilter?.getBoundingClientRect().top ?? null;
    const firstArticleTop = firstArticle?.getBoundingClientRect().top ?? null;

    return { headerBottom, firstFilterTop, firstArticleTop };
  });

  if (
    typeof metrics.headerBottom !== 'number' ||
    typeof metrics.firstFilterTop !== 'number' ||
    typeof metrics.firstArticleTop !== 'number'
  ) {
    throw new Error(`Failed to collect desktop filter metrics: ${JSON.stringify(metrics)}`);
  }

  return metrics;
}

test.describe('FR-NEWS-ALL-011 desktop filter initial position', () => {
  test('laptop 幅でフィルター開始位置が Header 直下から過度に離れない', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 900 });
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const metrics = await collectDesktopFilterMetrics(page);

    expect(
      metrics.firstFilterTop - metrics.headerBottom,
      `laptop metrics: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(60);
    expect(
      metrics.firstFilterTop - metrics.firstArticleTop,
      `laptop metrics: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(30);
  });

  test('desktop 幅でフィルター開始位置が Header 直下から過度に離れない', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const metrics = await collectDesktopFilterMetrics(page);

    expect(
      metrics.firstFilterTop - metrics.headerBottom,
      `desktop metrics: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(60);
    expect(
      metrics.firstFilterTop - metrics.firstArticleTop,
      `desktop metrics: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(30);
  });
});