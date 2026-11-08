import { expect, Locator, Page, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-288-AC-04: タブレット帯（768〜1023px）で、LOOK 詳細の画像と情報の列の間、情報の列の右端から
// 画面の右端までを、ITEM 詳細（FREQ-286-AC-02）と同じ 32px にする。

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

const TABLET_VIEWPORTS = [
  { name: 'tablet 768x1024', width: 768, height: 1024 },
  { name: 'tablet 1023x768', width: 1023, height: 768 },
];

for (const viewport of TABLET_VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-288-AC-04 画像と情報の列の間と、情報の列の右端から画面の右端までがどちらも 32px', async ({
      page,
    }) => {
      await gotoFirstLookDetail(page);

      const slide = await box(page.getByTestId('look-detail-tablet-carousel-slide').first());
      const info = await box(page.getByTestId('look-detail-layout').locator(':scope > div').nth(1));
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);

      expect(info.x - (slide.x + slide.width)).toBeCloseTo(32, 0);
      expect(clientWidth - (info.x + info.width)).toBeCloseTo(32, 0);
      expect(await hasHorizontalOverflow(page)).toBe(false);
    });
  });
}

const OTHER_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of OTHER_VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-288-AC-04 タブレット帯の外では横スクロールが出ない', async ({ page }) => {
      await gotoFirstLookDetail(page);
      await expect(page.getByTestId('look-detail-layout')).toBeVisible();
      expect(await hasHorizontalOverflow(page)).toBe(false);
    });
  });
}
