/**
 * FR-TERMS-007 利用規約に割引の扱いの文を出す
 * 対応 FREQ: FREQ-642（AC-22）。設計: docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md 6-1
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
  test.describe(`FR-TERMS-007 ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-642-AC-22: /terms に割引の扱いの文が出て、横にはみ出さない', async ({ page }) => {
      await page.goto('/terms');
      const note = page.getByTestId('terms-discount-return-note');
      await expect(note).toBeVisible();
      for (const part of NOTE_PARTS) await expect(note).toContainText(part);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(overflow).toBe(false);
    });
  });
}
