import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-304: SIZE は左寄せ・内容なりの幅で、選択肢間は個数によらず一定

async function openItemDetail(page: Page, sizes: string[]): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, sampleItemDetail({ sizes }), []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

function sizeButtons(page: Page) {
  return page.getByTestId('item-size-select').locator('button');
}

function addToCartButton(page: Page) {
  return page
    .getByTestId('item-actions-main')
    .getByRole('button', { name: /ADD TO CART|SOLD OUT/ })
    .first();
}

/** 隣接する選択肢の間隔をすべて返す */
async function gaps(page: Page): Promise<number[]> {
  return sizeButtons(page).evaluateAll((els) => {
    const rects = els.map((el) => el.getBoundingClientRect());
    return rects
      .slice(1)
      .map((rect, index) => rect.left - (rects[index].left + rects[index].width));
  });
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-053 SIZE の左寄せ (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-304-AC-01/AC-03: 左端が ADD TO CART と揃い、右端は内側に収まる', async ({
      page,
    }) => {
      await openItemDetail(page, ['XS', 'S', 'M', 'L', 'XL']);

      const cart = await addToCartButton(page).boundingBox();
      const first = await sizeButtons(page).first().boundingBox();
      const last = await sizeButtons(page).last().boundingBox();
      expect(cart).not.toBeNull();
      expect(first).not.toBeNull();
      expect(last).not.toBeNull();

      expect(first!.x).toBeCloseTo(cart!.x, 0);
      expect(last!.x + last!.width).toBeLessThan(cart!.x + cart!.width);
    });

    test('FREQ-304-AC-02: 間隔が一定で、選択肢の数が変わっても同じ', async ({
      page,
    }) => {
      await openItemDetail(page, ['XS', 'S', 'M', 'L', 'XL']);

      const fiveGaps = await gaps(page);
      expect(fiveGaps).toHaveLength(4);
      for (const gap of fiveGaps) {
        expect(Math.abs(gap - fiveGaps[0])).toBeLessThanOrEqual(1);
      }

      await openItemDetail(page, ['S', 'M']);
      const twoGaps = await gaps(page);
      expect(twoGaps).toHaveLength(1);
      expect(Math.abs(twoGaps[0] - fiveGaps[0])).toBeLessThanOrEqual(1);
    });
  });
}
