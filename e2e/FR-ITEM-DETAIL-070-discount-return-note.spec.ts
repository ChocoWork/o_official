/**
 * FR-ITEM-DETAIL-070 商品ページに割引の扱いの文を出す
 * 対応 FREQ: FREQ-642（AC-22）。設計: docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md 6-1
 *
 * 文の中身は実装の定数を import せず、試験が自分で持つ（文を直す時は設計・規約と一緒に直す）。
 */
import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const NOTE_PARTS = [
  '割引（2着目割引・セット割引・割引コードなど）が付いたご注文で一部の商品を返品され',
  'お手元に残る商品の割引後の価格を差し引いて返金いたします',
  '初期不良・誤送は、同じ商品の交換でお応えします',
  '返金額がマイナスになることはありません',
];

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe(`FR-ITEM-DETAIL-070 ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-642-AC-22: 商品ページに割引の扱いの文が出て、横にはみ出さない', async ({ page }) => {
      await page.goto('/item/1');
      await expect(page.getByTestId('item-detail-identity')).toBeVisible();
      await page.getByText('詳しく', { exact: true }).click();
      const note = page.getByTestId('item-discount-return-note');
      await expect(note).toBeVisible();
      for (const part of NOTE_PARTS) await expect(note).toContainText(part);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(overflow).toBe(false);
    });
  });
}
