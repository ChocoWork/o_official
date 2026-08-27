import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-301: SIZE は面を塗らず黒文字のまま、枠線で選択を示す
// FREQ-303 で未選択のグレー枠は撤回し、未選択は枠なしになった

const SURFACE = 'rgba(0, 0, 0, 0)';
const BLACK_TEXT = 'rgb(17, 17, 17)';
const BORDER_UNSELECTED = 'rgba(0, 0, 0, 0)';
const BORDER_SELECTED = 'rgb(17, 17, 17)';

const item = sampleItemDetail({ sizes: ['XS', 'S', 'M', 'L', 'XL'] });

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
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
  test.describe(`FR-ITEM-DETAIL-051 SIZE の枠線選択 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-301-AC-01/AC-02: 面は塗らず黒文字で、未選択は枠なし・選択中は黒枠', async ({
      page,
    }) => {
      await openItemDetail(page);

      const buttons = sizeButtons(page);
      await buttons.nth(1).click();
      // hover 色を拾わないようポインタを外す
      await page.mouse.move(0, 0);

      await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');

      await expect.poll(() => styles(page, 1)).toEqual({
        background: SURFACE,
        color: BLACK_TEXT,
        border: BORDER_SELECTED,
      });
      await expect.poll(() => styles(page, 3)).toEqual({
        background: SURFACE,
        color: BLACK_TEXT,
        border: BORDER_UNSELECTED,
      });
    });

    test('FREQ-301-AC-03: 選択を移すと黒枠も移動する', async ({ page }) => {
      await openItemDetail(page);

      const buttons = sizeButtons(page);
      await buttons.nth(1).click();
      await buttons.nth(4).click();
      await page.mouse.move(0, 0);

      await expect(buttons.nth(4)).toHaveAttribute('aria-pressed', 'true');
      await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'false');

      await expect
        .poll(async () => (await styles(page, 4)).border)
        .toBe(BORDER_SELECTED);
      expect((await styles(page, 1)).border).toBe(BORDER_UNSELECTED);
    });
  });
}
