import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

test.describe('FR-ITEM-ALL-014 一覧の見出し・パンくず・終端表示を非表示', () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.name} (${viewport.width}px)`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      // FREQ-34-AC-01: 見出し「ITEM」(h1) が表示されない
      test('ページ見出し「ITEM」が表示されない', async ({ page }) => {
        await gotoItemList(page);
        await expect(page.getByRole('heading', { name: 'ITEM', exact: true })).toHaveCount(0);
      });

      // FREQ-35-AC-01: パンくずナビゲーションが表示されない
      test('パンくずリストが表示されない', async ({ page }) => {
        await gotoItemList(page);
        await expect(page.locator('nav[aria-label="Breadcrumb"]')).toHaveCount(0);
      });

      // FREQ-36-AC-01: 終端表示「ALL ITEMS SHOWN」が表示されない
      test('終端表示「ALL ITEMS SHOWN」が表示されない', async ({ page }) => {
        await gotoItemList(page);
        await expect(page.getByText('ALL ITEMS SHOWN')).toHaveCount(0);
      });

      // FREQ-37-AC-01: 件数表示「〇〇件」が表示されない
      test('件数表示「〇〇件」が表示されない', async ({ page }) => {
        await gotoItemList(page);
        await expect(page.getByText(/^\d+件\+?$/)).toHaveCount(0);
      });
    });
  }
});
