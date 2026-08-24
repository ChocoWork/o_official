import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-166: 商品仕様テーブルのラベル列を max-content の単一グリッドで全行共有し、
// ラベルと値の重なり（MATERIAL）・ラベルの折り返し（MADE IN）を解消する

const item = {
  ...sampleItemDetail({
    name: 'Short Sleeveless Vest',
    price: 24800,
  }),
  material: 'リネン100%',
  origin: 'Japan',
};

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function specTableGeometry(page: Page, testId: string) {
  return page.evaluate((id) => {
    const table = document.querySelector(`[data-testid="${id}"]`);
    if (!table) return null;
    const cells = [...table.children] as HTMLElement[];
    const rows: Array<{
      label: string;
      labelTextRight: number;
      labelLineCount: number;
      valueLeft: number;
    }> = [];
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const label = cells[i];
      const value = cells[i + 1];
      const range = document.createRange();
      range.selectNodeContents(label);
      const rects = range.getClientRects();
      const textRect = range.getBoundingClientRect();
      rows.push({
        label: label.textContent ?? '',
        labelTextRight: textRect.right,
        labelLineCount: rects.length,
        valueLeft: value.getBoundingClientRect().left,
      });
    }
    return rows;
  }, testId);
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-028 spec table label alignment (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-166: labels never overlap values, never wrap, and values align', async ({
      page,
    }) => {
      await openItemDetail(page);

      // FREQ-290: MATERIAL / MADE IN は SpecList へ移動した
      // FREQ-292: 仕様テーブルの COLOR / SIZE ラベルは廃止したため SpecList のみ検証
      const listRows = await specTableGeometry(page, 'item-spec-list');
      expect(listRows).not.toBeNull();
      expect(listRows!.map((row) => row.label)).toEqual([
        'MATERIAL',
        'MADE IN',
      ]);

      for (const row of listRows!) {
        // AC-01: ラベルテキストが値セルへ食い込まない
        expect(row.labelTextRight).toBeLessThanOrEqual(row.valueLeft);
        // AC-02: ラベルは1行（MADE IN が折り返されない）
        expect(row.labelLineCount).toBe(1);
      }

      // AC-03: 各コンテナ内で値セルの左端が一致（整列）
      for (const group of [listRows!]) {
        const valueLefts = group.map((row) => row.valueLeft);
        for (const left of valueLefts) {
          expect(left).toBeCloseTo(valueLefts[0], 1);
        }
      }
    });
  });
}
