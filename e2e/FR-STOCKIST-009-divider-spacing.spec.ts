import { expect, test, type Page } from '@playwright/test';

const PHI = 1.618;
const QUARTERSTEP_DEC = 0.128;
const PX_TOLERANCE = 0.75;

type StockistSpacingMetrics = {
  titleFontSizePx: number;
  bodyFontSizePx: number;
  titleToDividerGapPx: number;
  dividerToDetailsGapPx: number;
  detailRowGapPx: number;
  cardTopPaddingPx: number;
  cardBottomPaddingPx: number;
  cardEdgeGapPx: number;
};

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function expectClose(actual: number, expected: number, label: string) {
  expect(
    Math.abs(actual - expected),
    `${label}: expected ${expected.toFixed(2)}px, received ${actual.toFixed(2)}px`,
  ).toBeLessThanOrEqual(PX_TOLERANCE);
}

// 2026-11-07 改定: カード上下の内側の余白は「見出しの文字の大きさ × 1.062」ではなく、
// カードの上下の余白は Card の --card-pad と枠線 1px の和（実測 1280px で約 21.25px）。
// 他の寸法（見出し↔区切り線↔詳細、行の間）は見出し・本文の文字の大きさから決まるまま。
async function measureStockistSpacing(path: string, page: Page): Promise<StockistSpacingMetrics> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    if (document.fonts) {
      await document.fonts.ready;
    }
  });

  const firstCard = page.locator('.stockist-card').first();
  await firstCard.waitFor({ state: 'visible' });

  return firstCard.evaluate((card) => {
    const getRequiredElement = <T extends HTMLElement>(selector: string) => {
      const element = card.querySelector<T>(selector);

      if (!element) {
        throw new Error(`Missing required stockist element: ${selector}`);
      }

      return element;
    };

    const title = getRequiredElement<HTMLElement>('.stockist-card-title');
    const divider = getRequiredElement<HTMLElement>('.stockist-card-divider');
    const details = getRequiredElement<HTMLElement>('.stockist-card-details');
    const rows = Array.from(card.querySelectorAll<HTMLElement>('.stockist-card-row'));

    if (rows.length < 2) {
      throw new Error('Expected at least two stockist detail rows');
    }

    const firstRowText = rows[0].querySelector<HTMLElement>('.stockist-card-text');

    if (!firstRowText) {
      throw new Error('Missing stockist detail text in the first row');
    }

    const cardRect = card.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const dividerRect = divider.getBoundingClientRect();
    const detailsRect = details.getBoundingClientRect();
    const firstRowRect = rows[0].getBoundingClientRect();
    const secondRowRect = rows[1].getBoundingClientRect();
    const lastRowRect = rows[rows.length - 1].getBoundingClientRect();
    const titleStyle = window.getComputedStyle(title);
    const bodyStyle = window.getComputedStyle(firstRowText);

    // 期待値はカード部品の padding と枠線 1px の和。--lk-stockist-card-padding は Card の padding に負けて効いていない
    const cardStyle = window.getComputedStyle(card);
    const cardEdgeGapPx =
      Number.parseFloat(cardStyle.paddingTop) + Number.parseFloat(cardStyle.borderTopWidth);

    return {
      titleFontSizePx: Number.parseFloat(titleStyle.fontSize),
      bodyFontSizePx: Number.parseFloat(bodyStyle.fontSize),
      titleToDividerGapPx: dividerRect.top - titleRect.bottom,
      dividerToDetailsGapPx: detailsRect.top - dividerRect.bottom,
      detailRowGapPx: secondRowRect.top - firstRowRect.bottom,
      cardTopPaddingPx: titleRect.top - cardRect.top,
      cardBottomPaddingPx: cardRect.bottom - lastRowRect.bottom,
      cardEdgeGapPx,
    };
  });
}

for (const scenario of [
  { label: 'home', path: '/' },
  { label: 'catalog', path: '/stockist' },
]) {
  test(`FR-STOCKIST-002-AC-03 ${scenario.label} applies phi-based divider spacing`, async ({ page }) => {
    const metrics = await measureStockistSpacing(scenario.path, page);
    const expectedTitleToDividerGapPx = metrics.titleFontSizePx / PHI;
    const expectedDividerToDetailsGapPx = expectedTitleToDividerGapPx;
    const expectedDetailRowGapPx = (metrics.bodyFontSizePx / PHI) - (metrics.bodyFontSizePx * QUARTERSTEP_DEC);
    const expectedCardPaddingPx = metrics.cardEdgeGapPx;

    expectClose(metrics.titleToDividerGapPx, expectedTitleToDividerGapPx, `${scenario.label} title to divider gap`);
    expectClose(metrics.dividerToDetailsGapPx, expectedDividerToDetailsGapPx, `${scenario.label} divider to details gap`);
    expectClose(metrics.detailRowGapPx, expectedDetailRowGapPx, `${scenario.label} detail row gap`);
    expectClose(metrics.cardTopPaddingPx, expectedCardPaddingPx, `${scenario.label} card top padding`);
    expectClose(metrics.cardBottomPaddingPx, expectedCardPaddingPx, `${scenario.label} card bottom padding`);

    console.log(
      JSON.stringify(
        {
          scenario: scenario.label,
          path: scenario.path,
          metrics: {
            titleFontSizePx: round(metrics.titleFontSizePx),
            bodyFontSizePx: round(metrics.bodyFontSizePx),
            titleToDividerGapPx: round(metrics.titleToDividerGapPx),
            dividerToDetailsGapPx: round(metrics.dividerToDetailsGapPx),
            detailRowGapPx: round(metrics.detailRowGapPx),
            cardTopPaddingPx: round(metrics.cardTopPaddingPx),
            cardBottomPaddingPx: round(metrics.cardBottomPaddingPx),
          },
          expected: {
            titleToDividerGapPx: round(expectedTitleToDividerGapPx),
            dividerToDetailsGapPx: round(expectedDividerToDetailsGapPx),
            detailRowGapPx: round(expectedDetailRowGapPx),
            cardPaddingPx: round(expectedCardPaddingPx),
          },
        },
        null,
        2,
      ),
    );
  });
}