import { expect, test } from '@playwright/test';
import { mockCartApis } from './shop-test-utils';

const PX_TOLERANCE = 0.75;

type EmptyPageMetrics = {
  rootDisplay: string;
  rootAlignItems: string;
  rootJustifyContent: string;
  innerDisplay: string;
  innerFlexDirection: string;
  innerAlignItems: string;
  iconFontSizePx: number;
  labelFontSizePx: number;
  figureGapPx: number;
  stackGapPx: number;
  rootPaddingTopPx: number;
  rootPaddingRightPx: number;
  rootPaddingBottomPx: number;
  rootPaddingLeftPx: number;
  expectedFigureGapPx: number;
  expectedStackGapPx: number;
  expectedPaddingPx: number;
};

function assertClose(actual: number, expected: number, label: string): void {
  expect(
    Math.abs(actual - expected),
    `${label}: expected ${expected.toFixed(2)}px, got ${actual.toFixed(2)}px`,
  ).toBeLessThanOrEqual(PX_TOLERANCE);
}

test.describe('FR-CART-011 empty page phi spacing', () => {
  test('cart 空状態の EmptyPage が黄金比トークンに基づく spacing を適用する', async ({ page }) => {
    await mockCartApis(page, []);
    await page.goto('/cart');

    const emptyPage = page.locator('.empty-page');
    await expect(emptyPage).toBeVisible();

    const metrics = await emptyPage.evaluate<EmptyPageMetrics>((root) => {
      const parsePx = (value: string): number => Number.parseFloat(value.replace('px', ''));
      const inner = root.querySelector<HTMLElement>('.empty-page__inner');
      const figure = root.querySelector<HTMLElement>('.empty-page__figure');
      const icon = root.querySelector<HTMLElement>('.empty-page__icon');
      const label = root.querySelector<HTMLElement>('.empty-page__label');

      if (!inner || !figure || !icon || !label) {
        throw new Error('EmptyPage required elements are missing');
      }

      const rootStyle = window.getComputedStyle(root);
      const innerStyle = window.getComputedStyle(inner);
      const figureStyle = window.getComputedStyle(figure);
      const iconStyle = window.getComputedStyle(icon);
      const labelStyle = window.getComputedStyle(label);

      const iconFontSizePx = parsePx(iconStyle.fontSize);
      const expectedFigureGapPx = iconFontSizePx * 0.618;
      const expectedStackGapPx = iconFontSizePx * 0.272;
      const expectedPaddingPx = iconFontSizePx * 0.062;

      return {
        rootDisplay: rootStyle.display,
        rootAlignItems: rootStyle.alignItems,
        rootJustifyContent: rootStyle.justifyContent,
        innerDisplay: innerStyle.display,
        innerFlexDirection: innerStyle.flexDirection,
        innerAlignItems: innerStyle.alignItems,
        iconFontSizePx,
        labelFontSizePx: parsePx(labelStyle.fontSize),
        figureGapPx: parsePx(figureStyle.gap),
        stackGapPx: parsePx(innerStyle.gap),
        rootPaddingTopPx: parsePx(rootStyle.paddingTop),
        rootPaddingRightPx: parsePx(rootStyle.paddingRight),
        rootPaddingBottomPx: parsePx(rootStyle.paddingBottom),
        rootPaddingLeftPx: parsePx(rootStyle.paddingLeft),
        expectedFigureGapPx,
        expectedStackGapPx,
        expectedPaddingPx,
      };
    });

    expect(metrics.rootDisplay).toBe('flex');
    expect(metrics.rootAlignItems).toBe('center');
    expect(metrics.rootJustifyContent).toBe('center');
    expect(metrics.innerDisplay).toBe('flex');
    expect(metrics.innerFlexDirection).toBe('column');
    expect(metrics.innerAlignItems).toBe('center');

    assertClose(metrics.labelFontSizePx, metrics.iconFontSizePx, 'icon/label font-size parity');
    assertClose(metrics.figureGapPx, metrics.expectedFigureGapPx, 'figure gap');
    assertClose(metrics.stackGapPx, metrics.expectedStackGapPx, 'stack gap');
    assertClose(metrics.rootPaddingTopPx, metrics.expectedPaddingPx, 'root padding top');
    assertClose(metrics.rootPaddingRightPx, metrics.expectedPaddingPx, 'root padding right');
    assertClose(metrics.rootPaddingBottomPx, metrics.expectedPaddingPx, 'root padding bottom');
    assertClose(metrics.rootPaddingLeftPx, metrics.expectedPaddingPx, 'root padding left');
  });
});
