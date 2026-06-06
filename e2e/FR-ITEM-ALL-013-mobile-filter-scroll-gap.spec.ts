import { expect, test, type Page } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

type LayoutSample = {
  label: string;
  headerVisible: string | undefined;
  gap: number | null;
  headerBottom: number | null;
  stickyTop: number | null;
  filterBarTop: number | null;
  contentTop: number | null;
  mainTop: number | null;
};

async function collectScrollGapSamples(page: Page): Promise<LayoutSample[]> {
  const samples: LayoutSample[] = [];

  const capture = async (label: string) => {
    const metrics = await page.evaluate(() => {
      const header = document.querySelector('header');
      const filterButton = Array.from(document.querySelectorAll('button')).find(
        (element) => element.textContent?.trim() === 'FILTER',
      );
      const filterBar = filterButton?.closest('div[class*="border-b"]');
      const stickyContainer = filterBar?.parentElement;
      const contentContainer = stickyContainer?.parentElement;
      const main = document.querySelector('main');

      const rect = (element: Element | null | undefined) => {
        if (!element) {
          return null;
        }

        const { top, bottom } = element.getBoundingClientRect();
        return { top, bottom };
      };

      const headerRect = rect(header);
      const filterBarRect = rect(filterBar);

      return {
        headerVisible: document.documentElement.dataset.headerVisible,
        headerBottom: headerRect?.bottom ?? null,
        stickyTop: rect(stickyContainer)?.top ?? null,
        filterBarTop: filterBarRect?.top ?? null,
        contentTop: rect(contentContainer)?.top ?? null,
        mainTop: rect(main)?.top ?? null,
        gap:
          headerRect && filterBarRect
            ? Number((filterBarRect.top - headerRect.bottom).toFixed(2))
            : null,
      };
    });

    samples.push({
      label,
      headerVisible: metrics.headerVisible,
      gap: metrics.gap,
      headerBottom: metrics.headerBottom,
      stickyTop: metrics.stickyTop,
      filterBarTop: metrics.filterBarTop,
      contentTop: metrics.contentTop,
      mainTop: metrics.mainTop,
    });
  };

  await capture('initial');
  await page.evaluate(() => window.scrollTo({ top: 180, behavior: 'auto' }));

  for (let index = 0; index < 8; index += 1) {
    await page.waitForTimeout(50);
    await capture(`down-${index}`);
  }

  return samples;
}

test.describe('FR-ITEM-ALL-013 mobile filter scroll gap', () => {
  test('390px 幅で Header と FILTER バーの間に隙間が出ない', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoItemList(page);
    await page.waitForLoadState('networkidle');

    const filterButton = page.getByRole('button', { name: 'FILTER', exact: true });
    await expect(filterButton).toBeVisible();

    const samples = await collectScrollGapSamples(page);
    const positiveGapSamples = samples.filter((sample) => sample.gap !== null && sample.gap > 1);

    expect(
      positiveGapSamples,
      `Header/FILTER gap samples: ${JSON.stringify(samples)}`,
    ).toHaveLength(0);
  });

  test('md 幅で Header と FILTER バーの間に隙間が出ない', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await gotoItemList(page);
    await page.waitForLoadState('networkidle');

    const filterButton = page.getByRole('button', { name: 'FILTER', exact: true });
    await expect(filterButton).toBeVisible();

    const samples = await collectScrollGapSamples(page);
    const positiveGapSamples = samples.filter((sample) => sample.gap !== null && sample.gap > 1);

    expect(
      positiveGapSamples,
      `Header/FILTER gap samples: ${JSON.stringify(samples)}`,
    ).toHaveLength(0);
  });
});