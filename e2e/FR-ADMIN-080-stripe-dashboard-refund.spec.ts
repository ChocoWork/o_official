/**
 * FR-ADMIN-080 Stripe の画面からの返金の取り込み
 * 対応 FREQ: FREQ-450（AC-01〜AC-04）・FREQ-453（AC-01）・FREQ-455（AC-01〜AC-04）
 *
 * Stripe のテストモードで本当に支払い（API で pm_card_visa の支払いを作って確定し、その支払いの入金済みの注文を手元の DB に作る。
 * 実装計画 E2-1）、Stripe の API で、こちらの印の無い返金（店が Stripe の画面から行うのと同じ返金）を作り、署名した refund.created を
 * 手元の窓口へ送って、記録・在庫・メール（Mailpit）を確かめる（FR-CHECKOUT-049 と同じやり方）。
 * Stripe に届かない・鍵が使えない時は、理由を出して skip する。切り替えの時刻より前の返金は写しになり、在庫もメールも動かさないこと
 * （Review Focus 5）と、返金のお知らせの出し分け（FREQ-455）は、Stripe を使わず手元の DB の関数を直に呼んで確かめる。
 */
import { expect, test } from '@playwright/test';
import { PRICE, uniqueSuffix } from '../tests/integration/db/helpers/order-fixtures';
import {
  beginRefund,
  createActor,
  createFulfillment,
  createOrderWithLines,
  mailBodies,
  mailsTo,
  orderState,
  recordExternalRefund,
  recordRefundResult,
  refundLineRows,
  refundOutboxRows,
  refundRows,
  runWorkerOnce,
  runWorkerUntil,
  sentOutboxCount,
  stockLedger,
  uniqueEmail,
  variantStockState,
  withLocalDb,
} from './order-email-test-utils';
import { orderNumberOf, viewports } from './order-fulfillment-test-utils';
import {
  MAIL_TEXT,
  createDashboardRefund,
  createPaidPaymentIntent,
  formatYen,
  listStripeRefunds,
  sendSignedStripeEvent,
  stripeForE2e,
  waitForStripeEvent,
} from './refund-test-utils';

const REFUND_SUBJECT = 'ご返金のお知らせ';
const { notShipping: NOT_SHIPPING, stillShipping: STILL_SHIPPING, cardTiming: CARD_TIMING } = MAIL_TEXT;

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-080 stripe dashboard refund (${viewport.name})`, () => {
    test.describe.configure({ timeout: 240_000 });

    test('一部を発送した注文を Stripe の画面で全額返金すると、未発送の商品が全部その返金に入って在庫に戻り、注文はキャンセルになり、お客様に返金のお知らせが1通届く', async ({ request }) => {
      // FREQ-450-AC-01, FREQ-450-AC-02, FREQ-450-AC-03, FREQ-453-AC-01, FREQ-455-AC-01〜AC-03（Review Focus 4）
      const runtime = await stripeForE2e();
      test.skip(!runtime.ok, runtime.ok ? '' : runtime.reason);
      if (!runtime.ok) return;
      const { stripe } = runtime;
      const email = uniqueEmail(`dash-refund-${viewport.name}`);
      const total = PRICE * 3;

      // Stripe のテストモードで本当に支払い、その支払いの入金済みの注文を作る（シャツ2つとスカート1つ）。シャツ1つだけ発送済み
      const intent = await createPaidPaymentIntent(stripe, total);
      const setup = await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(
          db,
          email,
          [
            { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
            { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
          ],
          { paymentIntentId: intent.id, paidAmount: 'total' },
        );
        const [shirt, skirt] = order.orderItemIds;
        // この試験はメールを確かめるので、発送のお知らせを送らない発送にする
        await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-DASH-1',
          notify: false,
          lines: [{ orderItemId: shirt, quantity: 1 }],
        });
        // 引き当て済みは、シャツの未発送1つ + スカート1つ。すぐ出せる数は 0
        expect(await variantStockState(db, order.variantId)).toMatchObject({ stock: 0, committed: 2 });
        return { orderId: order.orderId, variantId: order.variantId, shirt, skirt };
      });

      // 店が Stripe の画面で全額を返金した。こちらの印（metadata）は付いていない
      const refund = await createDashboardRefund(stripe, intent.id);
      expect(refund).toMatchObject({ amount: total, status: 'succeeded' });
      expect(refund.metadata).toEqual({});
      const eventId = await sendSignedStripeEvent(request, 'refund.created', refund, `dash-${viewport.name}`);
      await waitForStripeEvent(request, eventId);
      await runWorkerUntil(request, async () => (await sentOutboxCount(setup.orderId, 'refund')) >= 1, '返金のお知らせが送信済みになること');

      const after = await withLocalDb(async (db) => {
        const refunds = await refundRows(db, setup.orderId);
        return {
          refunds,
          lines: refunds[0] ? await refundLineRows(db, refunds[0].id) : [],
          ledger: await stockLedger(db, setup.orderId),
          stock: await variantStockState(db, setup.variantId),
          order: await orderState(db, setup.orderId),
          refunded: Number((await db.query('select refunded_amount from public.orders where id = $1', [setup.orderId])).rows[0].refunded_amount),
          outbox: await refundOutboxRows(db, setup.orderId, 'refund'),
        };
      });

      // 「Stripe の画面からの返金」として1件だけ記録される。全額なので注文はキャンセルになる
      expect(after.refunds).toHaveLength(1);
      const [record] = after.refunds;
      expect(record).toMatchObject({
        source: 'stripe_dashboard',
        status: 'succeeded',
        amount: total,
        shipping_amount: 0,
        // 計算との差は、発送済みのシャツ1つの分（行に入らないので差に残る）
        adjustment_amount: PRICE,
        stripe_refund_id: refund.id,
        payment_method_type: 'card',
        notify_customer: true,
        request_key: null,
        actor_id: null,
      });
      expect(record.stock_applied_at).not.toBeNull();
      expect(record.email_enqueued_at).not.toBeNull();
      expect(after.order.status).toBe('cancelled');
      expect(after.refunded).toBe(total);

      // 未発送だった商品（シャツ1つ・スカート1つ）が全部、この返金の発送前の行に入り、在庫に戻る。発送済みのシャツは入らない
      expect(after.lines).toHaveLength(2);
      expect(after.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            order_item_id: setup.shirt, quantity: 1, before_shipment: true, restock_type: 'cancel',
            released_quantity: 1, restocked_quantity: 1,
          }),
          expect.objectContaining({
            order_item_id: setup.skirt, quantity: 1, before_shipment: true, restock_type: 'cancel',
            released_quantity: 1, restocked_quantity: 1,
          }),
        ]),
      );
      const refundMoves = after.ledger.filter((row) => row.reason === 'refund');
      expect(refundMoves).toHaveLength(2);
      for (const move of refundMoves) {
        expect(move.delta).toBe(1);
        expect(move.refund_id).toBe(record.id);
      }
      expect(after.ledger.filter((row) => row.reason !== 'refund').map((row) => row.reason)).toEqual(['purchase', 'purchase']);
      // すぐ出せる数が増え（0 → 2）、引き当て済みが減る（2 → 0）
      expect(after.stock).toEqual({ stock: 2, committed: 0, backorder: 0 });

      // お客様に返金のお知らせが1通。未発送だった商品が並び、送らない旨の文（NOT_SHIPPING）を書く。送る商品はもう無いので、残りを送る旨の文（STILL_SHIPPING）は無い
      expect(after.outbox).toEqual([
        { variant: 'standard', refund_id: record.id, origin: 'auto', status: 'sent', last_error_code: null },
      ]);
      const mails = await mailBodies(request, email, REFUND_SUBJECT);
      expect(mails).toHaveLength(1);
      expect(mails[0].Subject).toBe(`【Le Fil des Heures】${REFUND_SUBJECT}（${orderNumberOf(setup.orderId)}）`);
      expect(mails[0].Text).toContain(`返金額: ${formatYen(total)}\n返金した商品:`);
      expect(mails[0].Text).toContain('・E2Eシャツ（ホワイト / M） × 1');
      expect(mails[0].Text).toContain('・E2Eスカート（ホワイト / M） × 1');
      expect(mails[0].Text).toContain(NOT_SHIPPING);
      expect(mails[0].Text).not.toContain(STILL_SHIPPING);
      expect(mails[0].Text).toContain(CARD_TIMING);
      expect(await mailsTo(request, email)).toHaveLength(1);

      // 同じ返金の知らせがもう一度（別の知らせの種類で）届いても、記録・台帳・メール・Stripe の返金は増えない
      const replayId = await sendSignedStripeEvent(request, 'refund.updated', refund, `dash-replay-${viewport.name}`);
      await waitForStripeEvent(request, replayId);
      await runWorkerOnce(request);
      const replayed = await withLocalDb(async (db) => ({
        refunds: await refundRows(db, setup.orderId),
        ledger: await stockLedger(db, setup.orderId),
        outbox: await refundOutboxRows(db, setup.orderId, 'refund'),
      }));
      expect(replayed.refunds).toHaveLength(1);
      expect(replayed.ledger).toHaveLength(after.ledger.length);
      expect(replayed.outbox).toHaveLength(1);
      expect(await mailBodies(request, email, REFUND_SUBJECT)).toHaveLength(1);
      expect(await listStripeRefunds(stripe, intent.id)).toHaveLength(1);
    });

    test('切り替えの時刻より前に Stripe で作られた返金は写しとして記録され、在庫もメールも動かさない。切り替えの後の返金は、同じ注文でも Stripe の画面からの返金になる（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-450-AC-04（Review Focus 5）, FREQ-455-AC-02
      test.setTimeout(180_000);
      const email = uniqueEmail(`dash-legacy-${viewport.name}`);
      const stripeRefundId = `re_e2elegacy${uniqueSuffix()}`;
      const setup = await withLocalDb(async (db) => {
        const order = await createOrderWithLines(db, email, [{ name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' }], {
          paidAmount: 'total',
        });
        const ledgerBefore = await stockLedger(db, order.orderId);

        const legacy = await recordExternalRefund(db, order.orderId, { stripeRefundId, amount: 3_000, createdBeforeSwitch: true });
        expect(legacy).toMatchObject({
          created: true, source: 'legacy', status: 'succeeded', newlyAccepted: false, newlyFailed: false,
          orderStatus: 'paid', refundedAmount: 3_000, emailEnqueued: false, exceptionId: null,
        });
        const [row] = await refundRows(db, order.orderId);
        expect(row).toMatchObject({ source: 'legacy', stripe_refund_id: stripeRefundId, amount: 3_000, notify_customer: false });
        expect(row.stock_applied_at).toBeNull();
        expect(row.email_enqueued_at).toBeNull();
        expect(await refundLineRows(db, row.id)).toEqual([]);
        expect(await stockLedger(db, order.orderId)).toEqual(ledgerBefore);
        expect(await refundOutboxRows(db, order.orderId, 'refund')).toEqual([]);

        // 同じ返金をもう一度受けても、写しのまま1行
        const again = await recordExternalRefund(db, order.orderId, { stripeRefundId, amount: 3_000, createdBeforeSwitch: true });
        expect(again).toMatchObject({ created: false, source: 'legacy', refundId: legacy.refundId });
        expect(await refundRows(db, order.orderId)).toHaveLength(1);
        return { orderId: order.orderId };
      });
      // 写しのお知らせは作られないので、worker を動かしても何も届かない
      await runWorkerOnce(request);
      expect(await mailsTo(request, email)).toHaveLength(0);

      // 切り替えの後に作られた額だけの返金は、Stripe の画面からの返金になり、お客様に返金のお知らせが届く
      const dashboard = await withLocalDb((db) => recordExternalRefund(db, setup.orderId, { amount: 2_000 }));
      expect(dashboard).toMatchObject({
        created: true, source: 'stripe_dashboard', status: 'succeeded', newlyAccepted: true,
        orderStatus: 'paid', refundedAmount: 5_000, emailEnqueued: true,
      });
      await runWorkerUntil(request, async () => (await sentOutboxCount(setup.orderId, 'refund')) >= 1, '返金のお知らせが送信済みになること');
      const mails = await mailBodies(request, email, REFUND_SUBJECT);
      expect(mails).toHaveLength(1);
      // 額だけの返金は、返金額の1行だけで、商品の行も送らない旨の文（NOT_SHIPPING）も書かない。まだ送る商品があるので、残りを送る旨の文は書く
      expect(mails[0].Text).toContain(`返金額: ${formatYen(2_000)}\n${STILL_SHIPPING}\n\n${CARD_TIMING}`);
      expect(mails[0].Text).not.toContain('返金した商品');
      expect(mails[0].Text).not.toContain('（うち送料');
      expect(mails[0].Text).not.toContain(NOT_SHIPPING);
    });

    test('返金のお知らせは返金ごとに1通で、お知らせを外した返金と、残高不足で保留の返金は、届かない。保留の返金は成功すると届く（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-455-AC-01, FREQ-455-AC-02, FREQ-455-AC-03, FREQ-455-AC-04
      test.setTimeout(180_000);
      const email = uniqueEmail(`refund-mail-${viewport.name}`);
      const setup = await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        // 送料つきの注文。1件目の返金に送料を入れて、「（うち送料 …）」が書かれる側も確かめる（返せる送料は1件目で 0 になる）
        const order = await createOrderWithLines(db, email, [{ name: 'E2Eシャツ', quantity: 4, fulfillmentType: 'stock' }], {
          paidAmount: 'total',
          shippingAmount: 800,
        });
        const [shirt] = order.orderItemIds;
        const refundOneShirt = (notifyCustomer: boolean, shippingAmount = 0) =>
          beginRefund(db, order.orderId, {
            actorId,
            lines: [{ orderItemId: shirt, quantity: 1, beforeShipment: true }],
            shippingAmount,
            amount: PRICE + shippingAmount,
            notifyCustomer,
          });

        // 1件目: お知らせを送る。成功したのでお知らせの予定が1行
        const first = await refundOneShirt(true, 800);
        expect((await recordRefundResult(db, first.refundId)).emailEnqueued).toBe(true);
        // 2件目: お知らせを外す。成功してもお知らせの予定は書かない
        const second = await refundOneShirt(false);
        expect((await recordRefundResult(db, second.refundId)).emailEnqueued).toBe(false);
        // 3件目: お知らせを送るが、残高不足で保留。お金が動くまで書かない
        const third = await refundOneShirt(true);
        const held = await recordRefundResult(db, third.refundId, { stripeStatus: 'pending', pendingReason: 'insufficient_funds' });
        expect(held).toMatchObject({ status: 'pending', emailEnqueued: false });
        expect(await refundOutboxRows(db, order.orderId, 'refund')).toHaveLength(1);
        // 成功したら書く
        const settled = await recordRefundResult(db, third.refundId, { stripeRefundId: held.stripeRefundId });
        expect(settled).toMatchObject({ status: 'succeeded', emailEnqueued: true });
        return { orderId: order.orderId, firstId: first.refundId, thirdId: third.refundId };
      });

      await runWorkerUntil(request, async () => (await sentOutboxCount(setup.orderId, 'refund')) >= 2, '返金のお知らせ2通が送信済みになること');
      const rows = await withLocalDb((db) => refundOutboxRows(db, setup.orderId, 'refund'));
      expect(rows.map((row) => row.refund_id).sort()).toEqual([setup.firstId, setup.thirdId].sort());
      const mails = await mailBodies(request, email, REFUND_SUBJECT);
      expect(mails).toHaveLength(2);
      // 送料を入れた1件目は「（うち送料 …）」つき、3件目は商品の額だけ
      expect(
        mails.filter((mail) => mail.Text.includes(`返金額: ${formatYen(PRICE + 800)}（うち送料 ${formatYen(800)}）\n返金した商品:`)),
      ).toHaveLength(1);
      expect(mails.filter((mail) => mail.Text.includes(`返金額: ${formatYen(PRICE)}\n返金した商品:`))).toHaveLength(1);
      for (const mail of mails) {
        expect(mail.Text).toContain('・E2Eシャツ（ホワイト / M） × 1');
        expect(mail.Text).toContain(NOT_SHIPPING);
        // シャツがまだ1つ残っているので、「ほかの商品は…」の文が付く
        expect(mail.Text).toContain(STILL_SHIPPING);
      }
      // もう一度動かしても、メールは増えない
      await runWorkerOnce(request);
      expect(await mailsTo(request, email)).toHaveLength(2);
    });
  });
}
