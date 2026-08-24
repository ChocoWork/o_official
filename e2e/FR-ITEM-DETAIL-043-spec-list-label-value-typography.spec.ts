import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-291: SpecList の値の文字サイズ・文字色をラベル（MATERIAL など）に合わせる

const item = {
  ...sampleItemDetail({ name: 'Short Sleeveless Vest', price: 24800 }),
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

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-043 SpecList の値をラベルの字面に揃える (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // AC-01: 各行のラベルと値で font-size / color が一致する
    test('FREQ-291: ラベルと値の font-size と color が一致する', async ({
      page,
    }) => {
      await openItemDetail(page);

      const rows = await page.getByTestId('item-spec-list').evaluate((el) => {
        const labels = [
          ...el.querySelectorAll('[data-ui-spec-list-label]'),
        ] as HTMLElement[];
        const values = [
          ...el.querySelectorAll('[data-ui-spec-list-value]'),
        ] as HTMLElement[];
        return labels.map((label, index) => {
          const labelStyle = getComputedStyle(label);
          const valueStyle = getComputedStyle(values[index]);
          return {
            label: label.textContent ?? '',
            labelFontSize: labelStyle.fontSize,
            valueFontSize: valueStyle.fontSize,
            labelColor: labelStyle.color,
            valueColor: valueStyle.color,
          };
        });
      });

      expect(rows.map((row) => row.label)).toEqual([
        'MATERIAL',
        'CARE',
        'MADE IN',
      ]);
      for (const row of rows) {
        expect(row.valueFontSize).toBe(row.labelFontSize);
        expect(row.valueColor).toBe(row.labelColor);
      }
    });
  });
}
