import { expect, Locator, test } from '@playwright/test';
import { expandItemFilterSection, gotoItemList, openItemFilters } from './item-list-test-utils';

// FREQ-44: STOCK / SEASON を COLOR・SIZE と同じマルチセレクトに統一する。
// ALL は他を外して ALL のみ、それ以外は独立トグル（複数選択可）。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, drawer: true },
  { name: 'tablet', width: 768, height: 1024, drawer: true },
  { name: 'desktop', width: 1280, height: 900, drawer: false },
] as const;

// 表示中のセクションに範囲を限定し、表示ラベルでチェックボックスを取る。
function box(section: Locator, label: string): Locator {
  return section.getByRole('checkbox', { name: label, exact: true });
}

async function clickOption(section: Locator, label: string): Promise<void> {
  await box(section, label).check();
}

test.describe('FR-ITEM-ALL-021 STOCK / SEASON マルチセレクト', () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.name} (${viewport.width}px)`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      // FREQ-44-AC-01 / AC-03
      test('STOCK: OUT 選択中に IN を押すと両方選択、ALL で解除', async ({ page }) => {
        await gotoItemList(page);
        const filters = await openItemFilters(page);
        const stock = await expandItemFilterSection(filters, 'STOCK');

        await clickOption(stock, 'MADE TO ORDER');
        await expect(box(stock, 'MADE TO ORDER')).toBeChecked();
        await expect(box(stock, 'ALL')).not.toBeChecked();

        await clickOption(stock, 'IN STOCK');
        await expect(box(stock, 'IN STOCK')).toBeChecked();
        await expect(box(stock, 'MADE TO ORDER')).toBeChecked();

        await clickOption(stock, 'ALL');
        await expect(box(stock, 'ALL')).toBeChecked();
        await expect(box(stock, 'IN STOCK')).not.toBeChecked();
        await expect(box(stock, 'MADE TO ORDER')).not.toBeChecked();
      });

      // FREQ-44-AC-02 / AC-03
      test('SEASON: AW 選択中に SS を押すと両方選択、ALL で解除', async ({ page }) => {
        await gotoItemList(page);
        const filters = await openItemFilters(page);
        const season = await expandItemFilterSection(filters, 'SEASON');

        await clickOption(season, 'AW');
        await expect(box(season, 'AW')).toBeChecked();
        await expect(box(season, 'ALL')).not.toBeChecked();

        await clickOption(season, 'SS');
        await expect(box(season, 'SS')).toBeChecked();
        await expect(box(season, 'AW')).toBeChecked();

        await clickOption(season, 'ALL');
        await expect(box(season, 'ALL')).toBeChecked();
        await expect(box(season, 'AW')).not.toBeChecked();
        await expect(box(season, 'SS')).not.toBeChecked();
      });
    });
  }
});
