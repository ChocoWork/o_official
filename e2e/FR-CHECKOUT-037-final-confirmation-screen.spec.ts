import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  expectNoHorizontalOverflow,
  fillShippingForm,
  hasPaymentElement,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';

/**
 * FR-CHECKOUT-037 最終確認画面「注文内容の最終確認」
 * 対応 FREQ: FREQ-419（AC-01 / AC-02）
 *
 * 特定商取引法 12条の6 の最終確認画面の項目（設計書 第4章）。お届けの時期は、その時点の在庫で
 * 在庫あり・受注生産のどちらかになる（判定は DB の結合テストで確かめる）。
 *
 * 前提: seedCart は色・サイズの無い行をカートに入れ、手元の種データのバリアントはどれも色・サイズを持つので、
 * どのバリアントにも当たらず受注生産になる。お届けの時期は
 * 受注生産の文言で出る。種データに、色もサイズも無く在庫を持つバリアントを足すと行が「在庫あり」になって
 * お届けの時期の確かめで落ちるので、そこで落ちたらまず種データを確かめる。
 */
test.describe('FR-CHECKOUT-037 最終確認画面', () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）表題と特定商取引法の項目が出て、割引コードは変えられず、変更で入力画面へ戻る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);

      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-final-screen-${viewport.name}@example.com`);
      await proceedToFinal(page);

      // FREQ-419-AC-01
      const terms = page.getByTestId('checkout-terms');
      await expect(terms).toContainText('クレジットカード：ご注文時にお支払いが確定します');
      await expect(terms).toContainText('PayPay：ご注文時に PayPay の画面でお支払いが確定します');
      await expect(terms).toContainText(
        'コンビニ払い：ご注文から7日以内に、発行される払込番号でお支払いください。期限までにお支払いが確認できないときは、ご注文をキャンセルします',
      );
      // お届けの時期（前提は先頭のコメント）。受注生産の文言を完全一致で見る。
      // 「在庫あり」の文言でも通る形にすると、行が在庫ありに変わっても気づけない
      await expect(terms).toContainText('受注生産・発送まで数週間〜2か月以上（目安）');
      await expect(terms).toContainText(
        'ご注文後のお客様都合による返品・交換・キャンセルはお受けできません。初期不良・誤送は、商品到着後7日以内にご連絡ください。詳しくは特定商取引法の表記をご覧ください',
      );
      await expect(terms.getByRole('link', { name: '特定商取引法の表記' })).toHaveAttribute('href', '/legal');
      await expect(page.getByText('合計（税込）')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => hasPaymentElement(page), { timeout: 30_000 }).toBe(true);
      await expectNoHorizontalOverflow(page);

      // FREQ-419-AC-02
      await expect(page.getByLabel('プロモーションコード')).toHaveCount(0);
      await page.getByRole('button', { name: 'お客様情報を変更', exact: true }).click();
      await expect(page.getByRole('button', { name: '確認へ進む' })).toBeVisible();
      await expect(page).toHaveURL(/\/checkout$/);
      await expect(page.getByLabel('プロモーションコード')).toBeVisible();
      // 入力した値が残っている（router.replace で URL を変えても、画面は作り直されない）
      await expect(page.getByLabel('氏名')).toHaveValue('山田花子');
      await expect(page.getByLabel('番地')).toHaveValue('神宮前1-2-3');
    });
  }
});
