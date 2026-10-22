/**
 * FR-ADMIN-083 支払い済みの注文のキャンセルのお知らせ
 * 対応 FREQ: FREQ-456（AC-01〜AC-04）
 *
 * 管理画面の「注文をキャンセルして返金する」の代わりに、窓口が呼ぶ手元の DB の関数（begin_order_refund の道 order_cancel と
 * record_order_refund_result）を直に呼び、worker の定期処理の入口を叩いて、手元のメール受け（Mailpit）に届いたメールを確かめる
 * （実装計画 P16。FR-ADMIN-071 と同じやり方）。Stripe には頼まず、カードで成功した結果をこちらで書く。
 * Stripe への頼み方そのものは、FR-ADMIN-080・FR-CHECKOUT-051 が本物の Stripe で通す。
 */
import { expect, test } from '@playwright/test';
import { PRICE } from '../tests/integration/db/helpers/order-fixtures';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import {
  beginRefund,
  createActor,
  createOrderWithLines,
  mailBodies,
  recordRefundResult,
  refundOutboxRows,
  runWorkerOnce,
  runWorkerUntil,
  sentOutboxCount,
  uniqueEmail,
  withLocalDb,
  type E2eCancelReason,
} from './order-email-test-utils';
import { orderNumberOf, viewports } from './order-fulfillment-test-utils';
import { MAIL_TEXT, formatYen } from './refund-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const CANCEL_SUBJECT = 'ご注文取消のお知らせ';
const REFUND_SUBJECT = 'ご返金のお知らせ';
const STOCK_LEAD = '商品をご用意できなくなったため、ご注文を取り消しました。';
const REQUEST_LEAD = 'ご依頼により、ご注文を取り消しました。';

/** 取消の理由ごとの書き出しの文（Global Constraints）。不正の疑い・その他は、お客様に理由を書かない。メモは店内だけ（その他は必須） */
const CASES: Array<{ reason: E2eCancelReason; note?: string; lead: string }> = [
  { reason: 'stock_unavailable', lead: STOCK_LEAD },
  { reason: 'customer_request', lead: REQUEST_LEAD },
  { reason: 'suspected_fraud', lead: 'ご注文を取り消しました。' },
  { reason: 'other', note: '店の都合で取り消し', lead: 'ご注文を取り消しました。' },
];

/** 支払い済みで未発送の注文（在庫の品1つ。受け取った額は注文の合計と同じ）を、その宛先で作る */
function createPaidOrderFor(db: PgClient, email: string) {
  return createOrderWithLines(db, email, [{ name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' }], { paidAmount: 'total' });
}

/**
 * 支払い済みのキャンセル（全額の返金）を、窓口と同じ順で DB に書く: 返金を始め（返事待ち）、カードで成功した結果を書く。
 * 注文の取消・在庫・取消のお知らせの予定は、結果を書く関数が1回の取引で行う
 */
async function cancelPaidOrder(
  db: PgClient,
  orderId: string,
  actorId: string,
  reason: E2eCancelReason,
  options: { note?: string; notifyCustomer?: boolean } = {},
) {
  const began = await beginRefund(db, orderId, {
    source: 'order_cancel',
    cancelReason: reason,
    note: options.note ?? null,
    notifyCustomer: options.notifyCustomer ?? true,
    actorId,
  });
  const result = await recordRefundResult(db, began.refundId);
  return { began, result };
}

/**
 * 支払い済みのキャンセルのお知らせの本文（Global Constraints）。宛名は createOrderWithLines の配送先の氏名。
 * 商品の行は、名前（色 / サイズ）、半角の x と数、全角の空白、金額。戻る時期の文はカード払いの物
 */
function cancelMailBody(orderId: string, lead: string): string {
  const orderNumber = orderNumberOf(orderId);
  return [
    '山田 花子 様',
    '',
    lead,
    `お支払いいただいた ${formatYen(PRICE)}（全額）を返金いたします。`,
    '',
    MAIL_TEXT.cardTiming,
    '',
    `注文番号: ${orderNumber}`,
    '',
    'ご注文内容:',
    `・E2Eシャツ（ホワイト / M） x1　${formatYen(PRICE)}`,
    '',
    `合計: ${formatYen(PRICE)}`,
    '',
    'ご注文の状況はこちら: http://localhost:3000/order-status/[ORDER_STATUS_LINK]',
    `お問い合わせの際は、注文番号（${orderNumber}）をお問い合わせフォームにご入力ください。`,
    '',
    'Le Fil des Heures',
  ].join('\n');
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-083 paid order cancel email (${viewport.name})`, () => {
    for (const { reason, note, lead } of CASES) {
      test(`取消の理由が ${reason} の時、取消のお知らせが1通だけ届き、返金のお知らせは届かない。本文は理由・全額の返金・戻る時期・注文の内容の順で、「お支払いは発生していません。」は入らない`, async ({ request }) => {
        // FREQ-456-AC-01, FREQ-456-AC-02, FREQ-456-AC-03
        // worker の入口は Stripe の知らせの処理と注文のメールの送信を続けて動かすので、既定の30秒では足りないことがある
        test.setTimeout(180_000);
        const email = uniqueEmail(`paid-cancel-${reason.replace(/_/g, '-')}-${viewport.name}`);
        const { orderId, refundId, replayed } = await withLocalDb(async (db) => {
          const actorId = await createActor(db);
          const order = await createPaidOrderFor(db, email);
          const { began, result } = await cancelPaidOrder(db, order.orderId, actorId, reason, { note });
          expect(result).toMatchObject({ status: 'succeeded', newlyAccepted: true, orderStatus: 'cancelled', emailEnqueued: true });
          // 同じ結果をもう一度書いても（Stripe の知らせの再送と同じ）、お知らせの予定は増えない
          const replayed = await recordRefundResult(db, began.refundId, { stripeRefundId: result.stripeRefundId });
          return { orderId: order.orderId, refundId: began.refundId, replayed };
        });
        expect(replayed).toMatchObject({ status: 'succeeded', newlyAccepted: false, emailEnqueued: false });

        await runWorkerUntil(request, async () => (await sentOutboxCount(orderId, 'canceled')) >= 1, '取消のお知らせが送信済みになること');

        // 取消のお知らせの行は、返金の記録に結び付いた1行だけ（書き分けは paid）。返金のお知らせの行は無い
        const rows = await withLocalDb(async (db) => ({
          canceled: await refundOutboxRows(db, orderId, 'canceled'),
          refund: await refundOutboxRows(db, orderId, 'refund'),
        }));
        expect(rows.canceled).toEqual([{ variant: 'paid', refund_id: refundId, origin: 'auto', status: 'sent', last_error_code: null }]);
        expect(rows.refund).toEqual([]);

        const mails = await mailBodies(request, email, CANCEL_SUBJECT);
        expect(mails.length).toBe(1);
        expect(mails[0].Subject).toBe(`【Le Fil des Heures】${CANCEL_SUBJECT}（${orderNumberOf(orderId)}）`);
        expect(mails[0].Text.includes(cancelMailBody(orderId, lead)), '取消のお知らせの指定本文が一致する').toBe(true);
        // 未入金の取消のお知らせだけに残る文は、お支払いが発生している支払い済みのキャンセルには入らない
        expect(mails[0].Text.includes(MAIL_TEXT.unpaidCancel)).toBe(false);
        // 不正の疑い・その他でも、お客様に理由は書かない。店内のメモも書かない
        expect(mails[0].Text.includes('不正')).toBe(false);
        if (note) expect(mails[0].Text.includes(note)).toBe(false);
        expect((await mailBodies(request, email, REFUND_SUBJECT)).length).toBe(0);
      });
    }

    test('お客様に知らせない設定でキャンセルすると、取消のお知らせの予定は書かれず、メールは1通も届かない', async ({ request }) => {
      // FREQ-456-AC-01
      test.setTimeout(180_000);
      const email = uniqueEmail(`paid-cancel-quiet-${viewport.name}`);
      await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createPaidOrderFor(db, email);
        const { result } = await cancelPaidOrder(db, order.orderId, actorId, 'customer_request', { notifyCustomer: false });
        expect(result).toMatchObject({ status: 'succeeded', orderStatus: 'cancelled', emailEnqueued: false });
        expect(await refundOutboxRows(db, order.orderId, 'canceled')).toEqual([]);
        expect(await refundOutboxRows(db, order.orderId, 'refund')).toEqual([]);
      });

      // 送る予定が無いので、worker を動かしても届かない
      await runWorkerOnce(request);
      expect(await mailBodies(request, email)).toEqual([]);
    });

    test('取消の返金が後から失敗して支払い済みに戻った注文を、もう一度キャンセルすると、2通目の取消のお知らせが届き、2通は別の返金の記録に結び付く', async ({ request }) => {
      // FREQ-456-AC-04
      test.setTimeout(240_000);
      const email = uniqueEmail(`paid-cancel-again-${viewport.name}`);
      const first = await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createPaidOrderFor(db, email);
        const { began, result } = await cancelPaidOrder(db, order.orderId, actorId, 'stock_unavailable');
        return { actorId, orderId: order.orderId, refundId: began.refundId, stripeRefundId: result.stripeRefundId };
      });
      await runWorkerUntil(request, async () => (await sentOutboxCount(first.orderId, 'canceled')) === 1, '1通目の取消のお知らせが送信済みになること');

      // 返金が後から失敗した（コンビニ払いの期限切れなど）。注文は支払い済みに戻り、1通目の返金の記録は失敗になる
      await withLocalDb(async (db) => {
        const failed = await recordRefundResult(db, first.refundId, {
          stripeRefundId: first.stripeRefundId,
          stripeStatus: 'failed',
          failureReason: 'declined',
        });
        expect(failed).toMatchObject({ status: 'failed', newlyFailed: true, orderStatus: 'paid' });
      });

      // 店がもう一度キャンセルする。お客様の依頼として、別の返金の記録を作る
      const secondRefundId = await withLocalDb(async (db) => {
        const { began, result } = await cancelPaidOrder(db, first.orderId, first.actorId, 'customer_request');
        expect(result).toMatchObject({ status: 'succeeded', newlyAccepted: true, orderStatus: 'cancelled', emailEnqueued: true });
        return began.refundId;
      });
      expect(secondRefundId).not.toBe(first.refundId);
      await runWorkerUntil(request, async () => (await sentOutboxCount(first.orderId, 'canceled')) === 2, '2通目の取消のお知らせが送信済みになること');

      // 2通届く。1通目は在庫切れの文、2通目はお客様の依頼の文
      const mails = await mailBodies(request, email, CANCEL_SUBJECT);
      expect(mails.length).toBe(2);
      expect(mails.filter((mail) => mail.Text.includes(STOCK_LEAD)).length).toBe(1);
      expect(mails.filter((mail) => mail.Text.includes(REQUEST_LEAD)).length).toBe(1);
      const rows = await withLocalDb((db) => refundOutboxRows(db, first.orderId, 'canceled'));
      expect(rows.map((row) => row.refund_id).sort()).toEqual([first.refundId, secondRefundId].sort());
      for (const row of rows) {
        expect(row).toMatchObject({ variant: 'paid', origin: 'auto', status: 'sent' });
      }
      // 失敗した1通目の返金には、返金のお知らせを出さない
      expect(await mailBodies(request, email, REFUND_SUBJECT)).toEqual([]);
    });
  });
}
