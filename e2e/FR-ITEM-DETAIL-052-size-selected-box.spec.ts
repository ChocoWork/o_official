import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-303: SIZE は選択したものだけ黒枠で囲む。2文字までは正方形、3文字以上は長方形

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const BLACK = 'rgb(17, 17, 17)';

async function openItemDetail(page: Page, sizes: string[]): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, sampleItemDetail({ sizes }), []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

function sizeButtons(page: Page) {
  return page.getByTestId('item-size-select').locator('button');
}

function styles(page: Page, index: number) {
  return sizeButtons(page)
    .nth(index)
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        color: s.color,
        border: s.borderTopColor,
      };
    });
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-052 SIZE の選択枠 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-303-AC-01/AC-02: 選択中だけ黒枠、未選択は枠なし、面は塗らない', async ({
      page,
    }) => {
      await openItemDetail(page, ['XS', 'S', 'M', 'L', 'XL']);

      const buttons = sizeButtons(page);
      await buttons.nth(2).click();

      await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'true');

      await expect.poll(() => styles(page, 2)).toEqual({
        background: TRANSPARENT,
        color: BLACK,
        border: BLACK,
      });
      await expect.poll(() => styles(page, 4)).toEqual({
        background: TRANSPARENT,
        color: BLACK,
        border: TRANSPARENT,
      });
    });

    test('FREQ-303-AC-03: 2文字までは正方形になる', async ({ page }) => {
      await openItemDetail(page, ['XS', 'S', 'M', 'L', 'XL']);

      const buttons = sizeButtons(page);
      const count = await buttons.count();
      for (let index = 0; index < count; index += 1) {
        const box = await buttons.nth(index).boundingBox();
        expect(box).not.toBeNull();
        expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(1);
      }
    });

    test('FREQ-303-AC-03: 3文字以上は長方形になる', async ({ page }) => {
      await openItemDetail(page, ['FREE']);

      const box = await sizeButtons(page).first().boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(box!.height);
    });
  });
}
