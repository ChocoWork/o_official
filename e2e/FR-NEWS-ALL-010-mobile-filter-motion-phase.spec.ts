import { devices, expect, test } from '@playwright/test';

type MotionSample = {
  frame: number;
  headerVisible: string | undefined;
  filterTop: number | null;
  headerBottom: number | null;
};

async function collectMotionSamples(page: Parameters<typeof test>[0]['page']): Promise<MotionSample[]> {
  const samples: MotionSample[] = [];

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'auto' }));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.scrollTo({ top: 60, behavior: 'auto' }));

  for (let frame = 0; frame < 12; frame += 1) {
    await page.waitForTimeout(16);

    const sample = await page.evaluate(() => {
      const header = document.querySelector('header');
      const filterBar = document.querySelector('[data-filter-bar="floating"]');

      const rect = (element: Element | null) => {
        if (!element) {
          return null;
        }

        const { top, bottom } = element.getBoundingClientRect();
        return { top, bottom };
      };

      return {
        headerVisible: document.documentElement.dataset.headerVisible,
        filterTop: rect(filterBar)?.top ?? null,
        headerBottom: rect(header)?.bottom ?? null,
      };
    });

    samples.push({ frame, ...sample });
  }

  return samples;
}

async function collectPreHideSamples(page: Parameters<typeof test>[0]['page']): Promise<MotionSample[]> {
  const samples: MotionSample[] = [];

  for (const scrollY of [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48]) {
    await page.evaluate((value) => window.scrollTo({ top: value, behavior: 'auto' }), scrollY);
    await page.waitForTimeout(16);

    const sample = await page.evaluate(() => {
      const header = document.querySelector('header');
      const filterBar = document.querySelector('[data-filter-bar="floating"]');

      const rect = (element: Element | null) => {
        if (!element) {
          return null;
        }

        const { top, bottom } = element.getBoundingClientRect();
        return { top, bottom };
      };

      return {
        headerVisible: document.documentElement.dataset.headerVisible,
        filterTop: rect(filterBar)?.top ?? null,
        headerBottom: rect(header)?.bottom ?? null,
      };
    });

    samples.push({ frame: scrollY, ...sample });
  }

  return samples;
}

async function collectWheelSamples(page: Parameters<typeof test>[0]['page']): Promise<MotionSample[]> {
  const samples: MotionSample[] = [];

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'auto' }));
  await page.waitForTimeout(50);

  for (let frame = 0; frame < 18; frame += 1) {
    await page.mouse.wheel(0, 8);
    await page.waitForTimeout(16);

    const sample = await page.evaluate(() => {
      const header = document.querySelector('header');
      const filterBar = document.querySelector('[data-filter-bar="floating"]');

      const rect = (element: Element | null) => {
        if (!element) {
          return null;
        }

        const { top, bottom } = element.getBoundingClientRect();
        return { top, bottom };
      };

      return {
        headerVisible: document.documentElement.dataset.headerVisible,
        filterTop: rect(filterBar)?.top ?? null,
        headerBottom: rect(header)?.bottom ?? null,
      };
    });

    samples.push({ frame, ...sample });
  }

  return samples;
}

function getMaxMotionGap(samples: MotionSample[]): number {
  const deltas = samples
    .map((sample) => {
      if (typeof sample.filterTop !== 'number' || typeof sample.headerBottom !== 'number') {
        return null;
      }

      return Math.abs(sample.filterTop - sample.headerBottom);
    })
    .filter((value): value is number => value !== null);

  if (deltas.length === 0) {
    return 0;
  }

  return Math.max(...deltas);
}

function getFilterTopRange(samples: MotionSample[]): number {
  const values = samples
    .map((sample) => sample.filterTop)
    .filter((value): value is number => value !== null);

  if (values.length === 0) {
    return 0;
  }

  return Math.max(...values) - Math.min(...values);
}

test.describe('FR-NEWS-ALL-010 mobile filter motion phase', () => {
  test('390px 幅で Header の隠れアニメーション中も FILTER バーが追従する', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const samples = await collectMotionSamples(page);
    const maxGap = getMaxMotionGap(samples);

    expect(
      maxGap,
      `390px motion samples: ${JSON.stringify(samples)}`,
    ).toBeLessThanOrEqual(1);
  });

  test('390px 幅で Header が隠れる前に FILTER バーが先に動かない', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const samples = await collectPreHideSamples(page);
    const range = getFilterTopRange(samples);

    expect(
      range,
      `390px pre-hide samples: ${JSON.stringify(samples)}`,
    ).toBeLessThanOrEqual(1);
  });

  test('sm 幅で Header の隠れアニメーション中も FILTER バーが追従する', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 960 });
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const samples = await collectMotionSamples(page);
    const maxGap = getMaxMotionGap(samples);

    expect(
      maxGap,
      `sm motion samples: ${JSON.stringify(samples)}`,
    ).toBeLessThanOrEqual(1);
  });

  test('md 幅で Header の隠れアニメーション中も FILTER バーが追従する', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const samples = await collectMotionSamples(page);
    const maxGap = getMaxMotionGap(samples);

    expect(
      maxGap,
      `md motion samples: ${JSON.stringify(samples)}`,
    ).toBeLessThanOrEqual(1);
  });

  test('md 幅で Header が隠れる前に FILTER バーが先に動かない', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const samples = await collectPreHideSamples(page);
    const range = getFilterTopRange(samples);

    expect(
      range,
      `md pre-hide samples: ${JSON.stringify(samples)}`,
    ).toBeLessThanOrEqual(1);
  });

  test('390px 幅の wheel スクロールでも Header と FILTER バーが分離しない', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const samples = await collectWheelSamples(page);
    const maxGap = getMaxMotionGap(samples);

    expect(
      maxGap,
      `390px wheel samples: ${JSON.stringify(samples)}`,
    ).toBeLessThanOrEqual(1);
  });

  test('md 幅の wheel スクロールでも Header と FILTER バーが分離しない', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const samples = await collectWheelSamples(page);
    const maxGap = getMaxMotionGap(samples);

    expect(
      maxGap,
      `md wheel samples: ${JSON.stringify(samples)}`,
    ).toBeLessThanOrEqual(1);
  });

  test('iPhone 12 エミュレーションでも Header の隠れアニメーション中に FILTER バーが分離しない', async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPhone 12'] });
    const page = await context.newPage();

    try {
      await page.goto('/news');
      await page.waitForLoadState('networkidle');

      const samples = await collectMotionSamples(page);
      const maxGap = getMaxMotionGap(samples);

      expect(
        maxGap,
        `iPhone 12 motion samples: ${JSON.stringify(samples)}`,
      ).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
});

test.describe('FR-NEWS-ALL-010 tablet filter motion phase', () => {
  test('iPad エミュレーションでも Header の隠れアニメーション中に FILTER バーが分離しない', async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPad (gen 7)'] });
    const page = await context.newPage();

    try {
      await page.goto('/news');
      await page.waitForLoadState('networkidle');

      const samples = await collectMotionSamples(page);
      const maxGap = getMaxMotionGap(samples);

      expect(
        maxGap,
        `iPad motion samples: ${JSON.stringify(samples)}`,
      ).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
});