/**
 * FR-CHECKOUT-051 取り消した注文に届いた入金の自動の返金（①）
 * 対応 FREQ: FREQ-451（AC-01〜AC-04）・FREQ-455（AC-01〜AC-03）・FREQ-457（AC-03）
 *
 * お店の決済の流れ（seedCart → テスト用カード）で、Stripe のテストモードで本当に支払う。支払いが済むと画面は決済の完了の窓口
 * （POST /api/checkout/complete）を呼ぶので、試験がその要求を預かり、まず注文を DB の関数で未入金のまま取り消す（実装計画 E2-2。
 * FR-CHECKOUT-046 が完了の窓口を預かる書き方と同じ）。注文には支払いの番号を書かない（card の注文は照合が書くまで番号を持たない。
 * 照合が取り消した注文への入金を見つけた時に、受け取った額と番号を書く。本計画 P27）。要求を止めたまま、署名した
 * checkout.session.completed を送ると、worker の照合が「取り消した注文への入金」を初めて見つけ、受け取った額と番号を書いて、
 * ショップの設定①（既定でオン）に従い、その番号で全額を自動で返金する。
 * そのあと、預かった要求を通し、署名した知らせをもう一度送って、同じ照合が画面の道からも知らせの道からも動き直しても、
 * 返金も要対応もメールも増えないことを確かめる。署名の合言葉は E2E の固定の値（scripts/e2e/environment.ts）で、本番の値ではない。
 * Stripe に届かない・テスト用の鍵が Stripe に断られる時と、見本の商品が無い時は、理由を出して skip する
 * （鍵が無い・テスト用でない時は、E2E の見張りが起動の前に止める）。
 */
import type Stripe from 'stripe';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  fillShippingForm,
  placeOrderWithTestCard,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';
import {
  createActor,
  mailBodies,
  paymentExceptionsOf,
  refundOutboxRows,
  refundRows,
  runWorkerOnce,
  runWorkerUntil,
  sentOutboxCount,
  stockLedger,
  withLocalDb,
} from './order-email-test-utils';
import { orderNumberOf } from './order-fulfillment-test-utils';
import {
  MAIL_TEXT,
  formatYen,
  listStripeRefunds,
  sendSignedStripeEvent,
  stripeForE2e,
  waitForCheckoutSessionComplete,
  waitForStripeEvent,
} from './refund-test-utils';

const REFUND_SUBJECT = 'ご返金のお知らせ';
const SHOP_ALERT_TO = process.env.SHOP_ALERT_EMAIL ?? 'shop-alert@e2e.test';

type CancelledOrder = {
  orderId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  amountReceived: number;
};

/**
 * 支払いが済んだ後、照合が動く前に、注文を未入金のまま取り消す。
 * 注文には支払いの番号を書かない。card の注文は、入金済みにする照合が書くまで番号を持たない（今の place_order_from_checkout_draft）。
 * 取り消した注文への入金を見つけた照合が、受け取った額と支払いの番号を書き（本計画 P27）、自動の返金①はその番号で Stripe に頼む。
 * 番号を先に持つ形（コンビニ払いの払込票）は、DB 結合（record_cancelled_order_paid_amount）と単体（照合）が確かめる。
 * 取消のお知らせは送らない（この試験が確かめるのは返金のお知らせ）
 */
async function cancelAfterPayment(stripe: Stripe, email: string): Promise<CancelledOrder> {
  const order = await withLocalDb(async (db) =>
    (await db.query(
      'select id, status::text as status, checkout_session_id, payment_intent_id from public.orders where shipping_email = $1',
      [email],
    )).rows[0] as { id: string; status: string; checkout_session_id: string; payment_intent_id: string | null } | undefined);
  if (!order) throw new Error('注文の受け付けが作った注文が見つからない');
  // P27 の道（照合が支払いの番号を書く）を通す前提を確かめる。Stripe が決済の画面を作る時に PaymentIntent も作る環境では、この確かめを外す
  if (order.payment_intent_id !== null) throw new Error('card の注文が、照合の前に支払いの番号を持っている');

  const session = await waitForCheckoutSessionComplete(stripe, order.checkout_session_id);
  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (!paymentIntentId) throw new Error('完了した決済の画面に支払いの番号が無い');
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

  await withLocalDb(async (db) => {
    const actorId = await createActor(db);
    const released = await db.query(
      `select released from public.release_stock_for_unpaid_order(
         $1::uuid, $2::public.order_status, 'cancelled'::public.order_status, 'admin_cancel', $3::uuid, null,
         'customer_request', null, false)`,
      [order.id, order.status, actorId],
    );
    if (released.rows[0]?.released !== true) throw new Error('注文を未入金のまま取り消せなかった');
  });
  return {
    orderId: order.id,
    checkoutSessionId: order.checkout_session_id,
    paymentIntentId,
    amountReceived: intent.amount_received,
  };
}

/** 署名した知らせの中身。処理が使うのは決済の画面の番号だけで、支払いの状態は Stripe から読み直す */
function completedSession(order: CancelledOrder) {
  return {
    id: order.checkoutSessionId,
    object: 'checkout.session',
    payment_intent: order.paymentIntentId,
    payment_status: 'paid',
    status: 'complete',
  };
}

/** 店への要対応メール（宛先は E2E の固定の値）のうち、その注文の物。同じ宛先を他の試験も使うので、注文番号で絞る */
async function shopAlertsFor(request: APIRequestContext, orderNumber: string) {
  return (await mailBodies(request, SHOP_ALERT_TO, '【要対応】')).filter((mail) => mail.Text.includes(`注文番号: ${orderNumber}`));
}

test.describe('FR-CHECKOUT-051 取り消した注文に届いた入金の自動の返金', () => {
  test.describe.configure({ timeout: 300_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）取り消した注文に入金が届くと、自動で全額が返金され、お客様に①の文の返金のお知らせ、店に「自動で全額を返金しました」の知らせが届く。同じ入金の知らせを送り直しても増えない`, async ({ page, request }) => {
      // FREQ-451-AC-01, FREQ-451-AC-02, FREQ-451-AC-03, FREQ-451-AC-04, FREQ-455-AC-01, FREQ-455-AC-02, FREQ-455-AC-03, FREQ-457-AC-03（Review Focus 5）
      const runtime = await stripeForE2e();
      test.skip(!runtime.ok, runtime.ok ? '' : runtime.reason);
      if (!runtime.ok) return;
      const { stripe } = runtime;

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      const email = `e2e-auto-refund-${viewport.name}-${Date.now()}@example.com`;

      // 決済の完了の窓口を預かる。呼ばれた時点で Stripe の決済の画面は完了している。最初の1回だけ、注文を取り消す。
      // 署名した知らせの照合が先に動くよう、画面の要求は試験が release() するまで止める（お客様が戻り先のページに戻るのが遅れた場面）。
      // 取り消しの誤りは預かった窓口の中では握りつぶされるので、取り消しの約束（Promise）を試験の本体で待って確かめる
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hold: { cancelled: Promise<CancelledOrder> | null; completeStatus: number | null } = {
        cancelled: null,
        completeStatus: null,
      };
      await page.route('**/api/checkout/complete', async (route) => {
        hold.cancelled ??= cancelAfterPayment(stripe, email);
        await hold.cancelled.catch(() => undefined);
        await released;
        const response = await route.fetch({ timeout: 120_000 });
        hold.completeStatus = response.status();
        await route.fulfill({ response });
      });

      await page.goto('/checkout');
      await fillShippingForm(page, email);
      await proceedToFinal(page);
      await placeOrderWithTestCard(page);

      await expect.poll(() => hold.cancelled !== null, { timeout: 120_000, message: '支払いが済み、完了の窓口が呼ばれること' }).toBe(true);
      const cancelled = await (hold.cancelled as Promise<CancelledOrder>);
      const orderNumber = orderNumberOf(cancelled.orderId);

      // 取り消した注文に入金が届いた知らせを、署名をつけて送る。worker の照合が、全額の自動の返金を Stripe が受け付けたところまで進める
      const firstEventId = await sendSignedStripeEvent(
        request,
        'checkout.session.completed',
        completedSession(cancelled),
        `auto-refund-${viewport.name}`,
      );
      await waitForStripeEvent(request, firstEventId);
      await expect
        .poll(async () => (await withLocalDb((db) => refundRows(db, cancelled.orderId))).map((row) => row.status), {
          timeout: 120_000,
          message: '自動の返金が成功になること',
        })
        .toEqual(['succeeded']);
      await runWorkerUntil(request, async () => (await sentOutboxCount(cancelled.orderId, 'refund')) >= 1, '返金のお知らせが送信済みになること');
      await expect
        .poll(async () => (await shopAlertsFor(request, orderNumber)).length, { timeout: 60_000, message: '店への知らせが届くこと' })
        .toBe(1);

      // Stripe の返金は1件だけ。受け取った額の全額で、こちらの印（注文の番号・返金の記録の番号）が付き、理由は伝えない（FREQ-451-AC-01）
      const stripeRefunds = await listStripeRefunds(stripe, cancelled.paymentIntentId);
      expect(stripeRefunds).toHaveLength(1);
      const [stripeRefund] = stripeRefunds;
      expect(stripeRefund).toMatchObject({ amount: cancelled.amountReceived, status: 'succeeded', reason: null });

      const after = await withLocalDb(async (db) => ({
        refunds: await refundRows(db, cancelled.orderId),
        order: (
          await db.query(
            'select status::text as status, total_amount, paid_amount, refunded_amount, payment_intent_id from public.orders where id = $1',
            [cancelled.orderId],
          )
        ).rows[0],
        ledger: await stockLedger(db, cancelled.orderId),
        outbox: await refundOutboxRows(db, cancelled.orderId, 'refund'),
        exceptions: await paymentExceptionsOf(db, cancelled.orderId),
      }));
      expect(after.refunds).toHaveLength(1);
      const [record] = after.refunds;
      // 道は「取り消した注文への入金の自動の返金」。人が始めた物ではないので、二重防止の番号と実行した人は空。お客様に知らせる
      expect(record).toMatchObject({
        source: 'auto_cancelled_order_payment',
        status: 'succeeded',
        amount: cancelled.amountReceived,
        shipping_amount: 0,
        stripe_refund_id: stripeRefund.id,
        payment_method_type: 'card',
        notify_customer: true,
        request_key: null,
        actor_id: null,
      });
      expect(stripeRefund.metadata).toEqual({ order_id: cancelled.orderId, refund_id: record.id });
      // 照合が、取り消した注文に受け取った額と支払いの番号を書き（P27。注文は番号を持っていなかった）、注文は取消のまま全額返金済みになる
      expect(after.order).toMatchObject({
        status: 'cancelled',
        total_amount: cancelled.amountReceived,
        paid_amount: cancelled.amountReceived,
        refunded_amount: cancelled.amountReceived,
        payment_intent_id: cancelled.paymentIntentId,
      });
      // 商品の行を持たない返金なので、在庫の台帳に返金の行は書かれない（在庫は、未入金の取消の時に戻っている）。
      // 見本の商品が在庫の品か受注生産かは環境で変わるので、取消の行の有無は確かめない
      expect(after.ledger.filter((row) => row.reason === 'refund' || row.refund_id !== null)).toEqual([]);

      // お客様には、返金のお知らせが1通だけ（FREQ-451-AC-02）。「支払いの前に取り消し済み」の文で、返金した商品の欄は無い。
      // 取消のお知らせも注文確認も届かない（取消は知らせない設定で行い、注文は入金済みにならなかった）
      expect(after.outbox).toEqual([{ variant: 'after_cancel', refund_id: record.id, origin: 'auto', status: 'sent', last_error_code: null }]);
      const customerMails = await mailBodies(request, email, REFUND_SUBJECT);
      expect(customerMails).toHaveLength(1);
      expect(customerMails[0].Subject).toBe(`【Le Fil des Heures】${REFUND_SUBJECT}（${orderNumber}）`);
      expect(customerMails[0].Text).toContain(
        `返金額: ${formatYen(cancelled.amountReceived)}\n${MAIL_TEXT.afterCancel}\n\n${MAIL_TEXT.cardTiming}`,
      );
      expect(customerMails[0].Text).not.toContain('返金した商品:');
      expect(customerMails[0].Text).not.toContain(MAIL_TEXT.stillShipping);
      expect(await mailBodies(request, email)).toHaveLength(1);

      // 店には、自動で全額を返金した知らせが1通。対応は要らないので、Stripe ダッシュボードでの返金は案内しない（FREQ-451-AC-03）。
      // 要対応はシステムが閉じる（解決した人は空）
      const alerts = await shopAlertsFor(request, orderNumber);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].Subject).toBe('【要対応】取り消した注文への入金');
      expect(alerts[0].Text).toContain('次にやること: 自動で全額を返金しました。対応は要りません。');
      expect(alerts[0].Text).not.toContain('Stripe ダッシュボード');
      expect(after.exceptions).toHaveLength(1);
      expect(after.exceptions[0]).toMatchObject({
        reason: 'cancelled_order_paid',
        resolved_by: null,
        resolution_note: 'システムが自動で返金した',
      });
      expect(after.exceptions[0].resolved_at).not.toBeNull();

      // 二度目の照合を、2つの道で動かす。預かっていた画面の要求を通し（画面の道）、同じ入金の知らせをもう一度届ける
      // （知らせの道。Stripe の知らせの再送・毎晩の照合と同じ）。どちらも、取り消した注文への入金を全額返金済みと読むので、
      // 返金も要対応も、お客様と店へのメールも増えない（自動の返金は、要対応を初めて記録した一回だけ。本計画 P7）
      release();
      const secondEventId = await sendSignedStripeEvent(
        request,
        'checkout.session.completed',
        completedSession(cancelled),
        `auto-refund-again-${viewport.name}`,
      );
      await waitForStripeEvent(request, secondEventId);
      await expect.poll(() => hold.completeStatus, { timeout: 120_000, message: '預かっていた完了の窓口が答えること' }).not.toBeNull();
      await runWorkerOnce(request);

      // 取り消した注文は、画面に完了として返さない（今の窓口の動き。お客様には返金のお知らせのメールが届いている）
      expect(hold.completeStatus).toBe(409);
      expect(await listStripeRefunds(stripe, cancelled.paymentIntentId)).toHaveLength(1);
      const replayed = await withLocalDb(async (db) => ({
        refunds: await refundRows(db, cancelled.orderId),
        exceptions: await paymentExceptionsOf(db, cancelled.orderId),
      }));
      expect(replayed.refunds).toHaveLength(1);
      expect(replayed.exceptions).toHaveLength(1);
      expect(await sentOutboxCount(cancelled.orderId, 'refund')).toBe(1);
      expect(await mailBodies(request, email, REFUND_SUBJECT)).toHaveLength(1);
      expect(await shopAlertsFor(request, orderNumber)).toHaveLength(1);
    });
  }
});
