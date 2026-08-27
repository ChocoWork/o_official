import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-298: SIZE 選択を角の四角い枠付きボタンにし、幅を ADD TO CART に合わせる

async function openItemDetail(page: Page, sizes: string[]): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, sampleItemDetail({ sizes }), []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

function sizeButtons(page: Page) {
  return page.getByTestId('item-size-select').locator('button');
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-048 SIZE 選択 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // FREQ-298-AC-01（行幅＝ADD TO CART）と AC-02（1つなら1/3幅）は
    // FREQ-304 の左寄せ化で撤回。配置は FR-ITEM-DETAIL-053 で検証する

    // FREQ-301 / FREQ-303 で配色は変更。枠線の出方は FR-ITEM-DETAIL-052 で検証する
    test('FREQ-298-AC-03: 選択中だけ aria-pressed=true で角丸なし', async ({
      page,
    }) => {
      await openItemDetail(page, ['XS', 'S', 'M', 'L', 'XL']);

      const buttons = sizeButtons(page);
      await buttons.nth(2).click();

      await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'true');
      await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'false');

      const radius = await buttons
        .nth(2)
        .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
      expect(radius).toBe('0px');
    });
  });
}
