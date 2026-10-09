/**
 * FR-CHECKOUT-049 注文確認のメールは、決済の完了と Webhook の両方が動いても1通だけ届く
 * 対応 FREQ: FREQ-434（AC-01）
 *
 * テスト用カードで注文し（決済の完了の窓口が照合する）、同じ決済の Stripe の知らせを受け取り口へ署名つきで送る
 * （worker が同じ照合をもう一度動かす）。署名の合言葉は E2E の固定の値（scripts/e2e/environment.ts）で、本番の値ではない。
 */
import Stripe from 'stripe';
import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  fillShippingForm,
  placeOrderWithTestCard,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';
import { mailsTo, runWorkerOnce, withLocalDb } from './order-email-test-utils';

const CONFIRMATION_SUBJECT = 'ご注文ありがとうございます';

test.describe('FR-CHECKOUT-049 注文確認のメールは1通だけ届く', () => {
  test.describe.configure({ timeout: 240_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）決済の完了と Webhook の両方が動いても、注文確認のメールは1通`, async ({ page, request }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);
      const email = `e2e-email-once-${viewport.name}-${Date.now()}@example.com`;
      const confirmations = async () =>
        (await mailsTo(request, email)).filter((message) => message.Subject.includes(CONFIRMATION_SUBJECT)).length;

      await page.goto('/checkout');
      await fillShippingForm(page, email);
      await proceedToFinal(page);
      await placeOrderWithTestCard(page);
      await expect(page.getByRole('heading', { name: 'Thank you for your order' })).toBeVisible({ timeout: 90_000 });

      // 決済の完了の窓口が書いた送る予定を、返事の後の worker が送る（FREQ-434-AC-01）
      await expect.poll(confirmations, { timeout: 60_000, message: `${email} へ注文確認のメールが届くこと` }).toBe(1);

      const order = await withLocalDb(async (db) =>
        (await db.query('select id, checkout_session_id, payment_intent_id from public.orders where shipping_email = $1', [email])).rows[0]);
      expect(order?.checkout_session_id).toEqual(expect.any(String));

      const eventId = `evt_e2e_once_${viewport.name}_${Date.now()}`;
      const payload = JSON.stringify({
        id: eventId,
        object: 'event',
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: order.checkout_session_id,
            object: 'checkout.session',
            payment_intent: order.payment_intent_id,
            payment_status: 'paid',
            status: 'complete',
          },
        },
      });
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET が無い（E2E の固定の値）');
      const webhook = await request.post('/api/webhook/stripe', {
        data: payload,
        headers: { 'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }) },
      });
      expect(webhook.status()).toBe(200);

      await expect.poll(
        async () => withLocalDb(async (db) =>
          (await db.query('select processing_status from public.stripe_webhook_events where id = $1', [eventId])).rows[0]?.processing_status),
        { timeout: 90_000, message: 'Stripe の知らせの処理が終わること' },
      ).toBe('completed');
      await runWorkerOnce(request);

      // 自動の行は1注文1種類1行。Webhook の照合が2行目を足さず、1行が送信済みのままであること
      const rows = await withLocalDb(async (db) =>
        (await db.query("select origin, status from private.order_email_outbox where order_id = $1 and kind = 'paid'", [order.id])).rows);
      expect(rows).toEqual([{ origin: 'auto', status: 'sent' }]);
      // 2通目が届くとしたら worker が行を送る時。worker の1回は送る行が無くなるまで続き、行は送ってから送信済みになる。
      // 送信済みの1行だけなので、固定の時間を待たずに数えてよい
      expect(await confirmations()).toBe(1);
    });
  }
});
