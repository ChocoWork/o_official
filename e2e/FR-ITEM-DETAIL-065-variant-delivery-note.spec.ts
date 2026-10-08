import { test, expect, Page } from '@playwright/test';
import { mockCartApis, mockItemDetailApis, sampleItemDetail } from './shop-test-utils';

// FREQ-400: 在庫の単位を色 × サイズにし、在庫の有無を「買えるか」ではなく「納期」として見せる。
// ブランドの前提は受注生産なので、在庫が無い組み合わせも買える（法令ページと同じ日数の区分）。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/** Black/M は在庫あり、Black/L は在庫なし。 */
function itemWithMixedStock() {
  return sampleItemDetail({
    colors: [{ hex: '#000000', name: 'Black' }],
    sizes: ['M', 'L'],
    madeToOrder: false,
    variantAvailability: [
      { colorName: 'Black', sizeLabel: 'M', inStock: true, variantId: 1012 },
      { colorName: 'Black', sizeLabel: 'L', inStock: false, variantId: 1013 },
    ],
  });
}

/**
 * サイズを選ぶ。モバイルは選択 UI が畳まれていて、固定・本体どちらの CTA からも
 * 選択シートを開いてから選ぶ作り（FREQ-347）。
 */
async function selectSize(page: Page, label: string, isMobile: boolean) {
  if (!isMobile) {
    await page.getByRole('button', { name: label, exact: true }).first().click();
    return;
  }

  const sheet = page.getByTestId('item-option-sheet');
  // 一度開けば選び直しはシートの中で完結する。開いていないときだけ開く。
  if (!(await sheet.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'SELECT OPTIONS' }).first().click();
    await expect(sheet).toBeVisible();
  }
  await sheet.getByRole('button', { name: label, exact: true }).click();
}

/** 納期の表示。モバイルはシートの中、それ以外は商品名の近くに出る。 */
function deliveryNote(page: Page, isMobile: boolean) {
  const all = page.getByTestId('delivery-note');
  return isMobile ? page.getByTestId('item-option-sheet').getByTestId('delivery-note') : all.first();
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}（${viewport.width}px）`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    const isMobile = viewport.name === 'mobile';

    test('FREQ-400-AC-02: 選んだ組み合わせに応じて納期が変わる', async ({ page }) => {
      await mockCartApis(page, []);
      await mockItemDetailApis(page, itemWithMixedStock(), []);

      await page.goto('/item/101');

      // サイズが複数ある間は納期を出さない（組み合わせが決まる前に断定しない）
      await expect(page.getByTestId('delivery-note')).toHaveCount(0);

      await selectSize(page, 'M', isMobile);
      await expect(deliveryNote(page, isMobile)).toHaveText('在庫あり・3〜7営業日で発送');

      await selectSize(page, 'L', isMobile);
      await expect(deliveryNote(page, isMobile)).toHaveText('受注生産・数週間〜2ヶ月');
    });

    test('FREQ-400-AC-03: 全部の在庫が 0 でもカートに追加できる', async ({ page }) => {
      const item = sampleItemDetail({
        colors: [{ hex: '#000000', name: 'Black' }],
        sizes: ['M'],
        madeToOrder: true,
        variantAvailability: [{ colorName: 'Black', sizeLabel: 'M', inStock: false, variantId: 1012 }],
      });
      await mockCartApis(page, []);
      await mockItemDetailApis(page, item, []);

      await page.goto('/item/101');

      await expect(page.getByTestId('delivery-note')).toHaveText('受注生産・数週間〜2ヶ月');
      await expect(page.getByRole('button', { name: 'SOLD OUT' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'ADD TO CART' }).first()).toBeEnabled();
    });

    test('FREQ-400-AC-05: 横スクロールが出ない', async ({ page }) => {
      await mockCartApis(page, []);
      await mockItemDetailApis(page, itemWithMixedStock(), []);

      await page.goto('/item/101');
      await selectSize(page, 'M', isMobile);
      await expect(deliveryNote(page, isMobile)).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
