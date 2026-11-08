import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-303（2026-11-07 改定）: SIZE は選択中だけ黒枠（#000000）、未選択は薄い枠（#f1f0ed）。
// 面は塗らず文字は黒（#111111）。2文字までは正方形、3文字以上は長方形

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const BLACK = 'rgb(17, 17, 17)'; // 文字色 #111111
const BORDER_SELECTED = 'rgb(0, 0, 0)'; // 選択中の枠 #000000
const BORDER_UNSELECTED = 'rgb(241, 240, 237)'; // 未選択の枠 #f1f0ed

async function openItemDetail(page: Page, sizes: string[]): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, sampleItemDetail({ sizes }), []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  if (page.viewportSize()?.width === 390) {
    await page.getByTestId('item-actions-fixed').getByRole('button', {
      name: /SELECT OPTIONS/,
    }).click();
    await expect(page.getByTestId('item-option-sheet')).toBeVisible();
  }
}

function sizeButtons(page: Page) {
  return page.getByTestId(
    page.viewportSize()?.width === 390 ? 'item-sheet-size-select' : 'item-size-select',
  ).locator('button');
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

    test('FREQ-303-AC-01/AC-02: 選択中は黒枠、未選択は薄い枠、面は塗らない', async ({
      page,
    }) => {
      await openItemDetail(page, ['XS', 'S', 'M', 'L', 'XL']);

      const buttons = sizeButtons(page);
      await buttons.nth(2).click();

      await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'true');

      await expect.poll(() => styles(page, 2)).toEqual({
        background: TRANSPARENT,
        color: BLACK,
        border: BORDER_SELECTED,
      });
      await expect.poll(() => styles(page, 4)).toEqual({
        background: TRANSPARENT,
        color: BLACK,
        border: BORDER_UNSELECTED,
      });
    });

    test('FREQ-303-AC-03: 2文字までは正方形になる', async ({ page }) => {
      await openItemDetail(page, ['XS', 'S', 'M', 'L', 'XL']);

      const buttons = sizeButtons(page);
      await expect(buttons).toHaveCount(5);
      const count = await buttons.count();
      for (let index = 0; index < count; index += 1) {
        await buttons.nth(index).click();
        await expect(buttons.nth(index)).toHaveAttribute('aria-pressed', 'true');
        const box = await buttons.nth(index).boundingBox();
        expect(box).not.toBeNull();
        expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(1);
      }
    });

    test('FREQ-303-AC-03: 3文字以上は長方形になる', async ({ page }) => {
      await openItemDetail(page, ['FREE']);

      const button = sizeButtons(page).first();
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(box!.height);
    });
  });
}
