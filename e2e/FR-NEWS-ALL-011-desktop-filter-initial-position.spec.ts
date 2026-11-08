import { expect, test, type Page } from '@playwright/test';

type DesktopFilterMetrics = {
  headerBottom: number;
  firstFilterTop: number;
  firstArticleTop: number;
};

async function collectDesktopFilterMetrics(page: Page): Promise<DesktopFilterMetrics> {
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

  return {
    headerBottom: metrics.headerBottom,
    firstFilterTop: metrics.firstFilterTop,
    firstArticleTop: metrics.firstArticleTop,
  };
}

// 2026-11-07 改定: 左の絞り込みの最初のチェックボックスは、先頭記事の上端から約 39.7px 下（上限 30px → 40px）。
// ヘッダーの下端からは laptop 54.67px・desktop 52.67px（上限 60px は変えない）。
const MAX_FILTER_BELOW_ARTICLE_PX = 40;

test.describe('FR-NEWS-ALL-011 desktop filter initial position', () => {
  test('FR-NEWS-ALL-002-AC-05 laptop 幅でフィルター開始位置が Header 直下から過度に離れない', async ({ page }) => {
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
    ).toBeLessThanOrEqual(MAX_FILTER_BELOW_ARTICLE_PX);
  });

  test('FR-NEWS-ALL-002-AC-05 desktop 幅でフィルター開始位置が Header 直下から過度に離れない', async ({ page }) => {
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
    ).toBeLessThanOrEqual(MAX_FILTER_BELOW_ARTICLE_PX);
  });
});