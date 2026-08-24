import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-293: PRODUCT NOTE 行の追加
// FREQ-294: ラベル列をコンテナ幅の 40% にして値の左端を揃える

const noteText =
  '素材の特性上、摩擦により毛羽立ちが生じる場合があります。引っかけにご注意ください。';

const itemWithNote = {
  ...sampleItemDetail({ name: 'Short Sleeveless Vest', price: 24800 }),
  material: 'Wool 100%',
  care: 'Dry clean',
  origin: 'JAPAN',
  product_note: noteText,
};

const itemWithoutNote = {
  ...sampleItemDetail({ name: 'Short Sleeveless Vest', price: 24800 }),
  material: 'Wool 100%',
  origin: 'JAPAN',
};

async function openItemDetail(
  page: Page,
  item: typeof itemWithNote | typeof itemWithoutNote,
): Promise<void> {
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
  test.describe(`FR-ITEM-DETAIL-045 PRODUCT NOTE と仕様リストの間隔 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-293-AC-01: product_note がある商品は PRODUCT NOTE 行が出る', async ({
      page,
    }) => {
      await openItemDetail(page, itemWithNote);

      const list = page.getByTestId('item-spec-list');
      await expect(list.getByText('PRODUCT NOTE', { exact: true })).toBeVisible();
      await expect(page.getByTestId('item-product-note')).toHaveText(noteText);
    });

    test('FREQ-293-AC-01: product_note が無い商品は PRODUCT NOTE 行が出ない', async ({
      page,
    }) => {
      await openItemDetail(page, itemWithoutNote);

      const list = page.getByTestId('item-spec-list');
      await expect(list).toBeVisible();
      await expect(list.getByText('PRODUCT NOTE', { exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByTestId('item-product-note')).toHaveCount(0);
    });

    test('FREQ-294-AC-01: 値の左端がコンテナ幅の約40%に揃い、ラベルは1行', async ({
      page,
    }) => {
      await openItemDetail(page, itemWithNote);

      const geometry = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="item-spec-list"]');
        if (!list) return null;
        const listRect = list.getBoundingClientRect();
        const cells = [...list.children] as HTMLElement[];
        const rows: Array<{
          label: string;
          labelLineCount: number;
          valueOffsetRatio: number;
        }> = [];
        for (let i = 0; i + 1 < cells.length; i += 2) {
          const range = document.createRange();
          range.selectNodeContents(cells[i]);
          rows.push({
            label: cells[i].textContent ?? '',
            labelLineCount: range.getClientRects().length,
            valueOffsetRatio:
              (cells[i + 1].getBoundingClientRect().left - listRect.left) /
              listRect.width,
          });
        }
        return rows;
      });

      expect(geometry).not.toBeNull();
      expect(geometry!.map((row) => row.label)).toEqual([
        'MATERIAL',
        'CARE',
        'MADE IN',
        'PRODUCT NOTE',
      ]);

      for (const row of geometry!) {
        // AC-01: ラベルは折り返さない
        expect(row.labelLineCount).toBe(1);
        // AC-01: 値の左端がコンテナ幅の約 40%
        expect(row.valueOffsetRatio).toBeCloseTo(0.4, 2);
      }
    });
  });
}
