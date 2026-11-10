/**
 * FR-CHECKOUT-061 注文の最終確認画面に割引の扱いの文を出す
 * 対応 FREQ: FREQ-642（AC-22）。設計: docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md 6-1
 * 最終確認画面への進み方は FR-CHECKOUT-037 と同じ。
 */
import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  expectNoHorizontalOverflow,
  fillShippingForm,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';

const NOTE_PARTS = [
  '割引（2着目割引・セット割引・割引コードなど）が付いたご注文で一部の商品を返品され',
  'お手元に残る商品の割引後の価格を差し引いて返金いたします',
  '初期不良・誤送は、同じ商品の交換でお応えします',
  '返金額がマイナスになることはありません',
];

test.use({ trace: 'off' });
test.describe('FR-CHECKOUT-061 最終確認画面の割引の扱い', () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`FREQ-642-AC-22: ${viewport.name}（${viewport.width}px）最終確認画面に割引の扱いの文が出る`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);
      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-final-note-${viewport.name}@example.com`);
      await proceedToFinal(page);
      const note = page.getByTestId('checkout-discount-return-note');
      await expect(note).toBeVisible();
      for (const part of NOTE_PARTS) await expect(note).toContainText(part);
      await expectNoHorizontalOverflow(page);
    });
  }
});
