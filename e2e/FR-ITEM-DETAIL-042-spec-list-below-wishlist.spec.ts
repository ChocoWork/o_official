import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-290: MATERIAL / CARE / MADE IN を COLOR・SIZE の仕様テーブルから切り離し、
// ADD TO WISHLIST の下に罫線区切りの SpecList として表示する

const item = {
  ...sampleItemDetail({
    name: 'Short Sleeveless Vest',
    price: 24800,
  }),
  material: 'Wool 100%',
  care: 'Dry clean',
  origin: 'JAPAN',
};

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('FR-ITEM-DETAIL-042 MATERIAL / CARE / MADE IN を WISHLIST ボタンの下に置く', () => {
  for (const viewport of VIEWPORTS) {
    // AC-01: 値の左端が全行で揃い、行間に罫線がある
    test(`${viewport.name} SpecList の値が同じ軸に揃い行間に罫線がある`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await openItemDetail(page);

      const list = page.getByTestId('item-spec-list');
      await expect(list).toBeVisible();

      const geometry = await list.evaluate((el) => {
        const values = [
          ...el.querySelectorAll('[data-ui-spec-list-value]'),
        ] as HTMLElement[];
        return values.map((value) => ({
          left: value.getBoundingClientRect().left,
          borderTopWidth: parseFloat(
            getComputedStyle(value).borderTopWidth,
          ),
        }));
      });

      expect(geometry.length).toBe(3);
      const firstLeft = geometry[0].left;
      for (const row of geometry) {
        expect(Math.abs(row.left - firstLeft)).toBeLessThanOrEqual(1);
        expect(row.borderTopWidth).toBeGreaterThan(0);
      }
    });

    // AC-02: MATERIAL 行が ADD TO WISHLIST より下にあり、仕様テーブルには残っていない
    test(`${viewport.name} MATERIAL 行が ADD TO WISHLIST の下にある`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await openItemDetail(page);

      const wishlistButton = page
        .getByTestId('item-actions-main')
        .getByRole('button', { name: 'Add to wishlist' });
      const material = page.getByTestId('item-material');
      await expect(material).toHaveText('Wool 100%');

      const buttonBox = await wishlistButton.boundingBox();
      const materialBox = await material.boundingBox();
      expect(buttonBox).not.toBeNull();
      expect(materialBox).not.toBeNull();
      if (!buttonBox || !materialBox) return;

      expect(materialBox.y).toBeGreaterThanOrEqual(
        buttonBox.y + buttonBox.height,
      );

      // 仕様テーブル側には MATERIAL / CARE / MADE IN が残っていない
      const specTable = page.getByTestId('item-spec-table');
      await expect(specTable.getByTestId('item-material')).toHaveCount(0);
      await expect(specTable.getByTestId('item-care')).toHaveCount(0);
      await expect(specTable.getByTestId('item-made-in')).toHaveCount(0);
    });
  }
});
