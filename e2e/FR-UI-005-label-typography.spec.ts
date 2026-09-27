import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
];

/** コントロール上部に置く項目名ラベル。共通トークンを参照するもの全て。 */
const LABEL_SELECTORS = [
  ".text-field__label",
  ".text-area-field__label",
  ".single-select__label",
  "[data-ui-radio-group-label]",
  "[data-ui-search-field-label]",
  "[data-ui-slider-label]",
  ".color-picker__label",
  ".stepper__label",
];

/** 字間は 0.15em 固定。em なので font-size との比で検証する。 */
const TRACKING_EM = 0.15;

type LabelStyle = {
  selector: string;
  text: string;
  fontSize: number;
  letterSpacing: number;
};

function readLabels(page: Page, selectors: string[]): Promise<LabelStyle[]> {
  return page.evaluate((list) => {
    const result: {
      selector: string;
      text: string;
      fontSize: number;
      letterSpacing: number;
    }[] = [];
    for (const selector of list) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const style = getComputedStyle(element);
        result.push({
          selector,
          text: (element.textContent ?? "").trim().slice(0, 20),
          fontSize: parseFloat(style.fontSize),
          letterSpacing: parseFloat(style.letterSpacing),
        });
      }
    }
    return result;
  }, selectors);
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）UI コンポーネントの項目名ラベルは字間 0.15em で揃う`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await page.goto("/ui");
    await expect(page.locator(".text-field__label").first()).toBeVisible();

    const labels = await readLabels(page, LABEL_SELECTORS);
    expect(labels.length).toBeGreaterThan(0);

    for (const label of labels) {
      expect(
        label.letterSpacing / label.fontSize,
        `${label.selector}（${label.text}）の字間`,
      ).toBeCloseTo(TRACKING_EM, 2);
    }
  });

  test(`${viewport.name}（${viewport.width}px）同じサイズのラベルはフォントサイズが一致する`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await page.goto("/ui");
    await expect(page.locator(".text-field__label").first()).toBeVisible();

    // /ui の TextField・TextAreaField・SingleSelect・Stepper は同じ md サイズで並ぶ
    const labels = await readLabels(page, [
      ".text-field__label",
      ".text-area-field__label",
      ".single-select__label",
      ".stepper__label",
    ]);
    const sizes = await page.evaluate((list) => {
      const out: number[] = [];
      for (const selector of list) {
        for (const element of Array.from(
          document.querySelectorAll(selector),
        )) {
          const host = element.closest("[data-ui-size]");
          out.push(host?.getAttribute("data-ui-size") === "md" ? 1 : 0);
        }
      }
      return out;
    }, [
      ".text-field__label",
      ".text-area-field__label",
      ".single-select__label",
      ".stepper__label",
    ]);

    const mdSizes = labels
      .filter((_, index) => sizes[index] === 1)
      .map((label) => label.fontSize);
    expect(mdSizes.length).toBeGreaterThan(1);
    for (const size of mdSizes) {
      expect(size).toBeCloseTo(mdSizes[0], 1);
    }
  });
}
