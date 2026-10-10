/**
 * FR-CHECKOUT-050 注文の確認のメールの、分けて送る案内
 * 対応 FREQ: FREQ-446（AC-01・AC-02）
 *
 * 手元の DB に注文を作り、確認のメールの予定を書き、worker の定期処理の入口を叩いて、Mailpit に届いた本文を読む
 * （FR-CHECKOUT-049 と同じやり方。実際の決済は使わない）。
 */
import { expect, test } from '@playwright/test';
import {
  createOrderWithLines,
  mailBodies,
  mailsTo,
  runWorkerUntil,
  uniqueEmail,
  withLocalDb,
  type E2eOrderLine,
} from './order-email-test-utils';

const viewports = [
  { name: 'mobile', width: 390, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const SPLIT_NOTICE = '在庫の品を先にお送りし、受注生産の品は仕上がり次第お送りします。';
const PAID_SUBJECT = 'ご注文ありがとうございます';
const AWAITING_SUBJECT = '承りました';

const STOCK_LINE: E2eOrderLine = { name: 'E2E在庫のシャツ', quantity: 1, fulfillmentType: 'stock' };
const BACKORDER_LINE: E2eOrderLine = { name: 'E2E受注生産のコート', quantity: 1, fulfillmentType: 'backorder' };

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

for (const viewport of viewports) {
  test.describe(`FR-CHECKOUT-050 split shipment notice (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('在庫の品と受注生産の品が両方ある注文の確認のメール（入金済み・入金待ち）に、分けて送る案内が1行入る', async ({ request }) => {
      // FREQ-446-AC-01
      test.setTimeout(180_000);
      const paidEmail = uniqueEmail(`split-paid-${viewport.name}`);
      const awaitingEmail = uniqueEmail(`split-awaiting-${viewport.name}`);
      await withLocalDb(async (db) => {
        const paid = await createOrderWithLines(db, paidEmail, [STOCK_LINE, BACKORDER_LINE]);
        await db.query("select private.enqueue_order_email($1::uuid, 'paid', 'order_confirmed')", [paid.orderId]);
        const awaiting = await createOrderWithLines(db, awaitingEmail, [STOCK_LINE, BACKORDER_LINE], { status: 'pending' });
        await db.query("select private.enqueue_order_email($1::uuid, 'awaiting_payment')", [awaiting.orderId]);
      });
      const arrived = async (email: string, subject: string) =>
        (await mailsTo(request, email)).filter((message) => message.Subject.includes(subject)).length;
      await runWorkerUntil(
        request,
        async () => (await arrived(paidEmail, PAID_SUBJECT)) >= 1 && (await arrived(awaitingEmail, AWAITING_SUBJECT)) >= 1,
        '入金済みと入金待ちの確認のメールが届くこと',
      );

      const [paidMail] = await mailBodies(request, paidEmail, PAID_SUBJECT);
      const [awaitingMail] = await mailBodies(request, awaitingEmail, AWAITING_SUBJECT);
      for (const mail of [paidMail, awaitingMail]) {
        expect(mail.Text).toContain('E2E在庫のシャツ');
        expect(mail.Text).toContain('E2E受注生産のコート');
        expect(occurrences(mail.Text, SPLIT_NOTICE)).toBe(1);
      }
    });

    test('片方の品だけの注文と、在庫を確保し直せなかった注文の確認のメールには、分けて送る案内が入らない', async ({ request }) => {
      // FREQ-446-AC-02
      test.setTimeout(180_000);
      const stockOnly = uniqueEmail(`split-stock-${viewport.name}`);
      const backorderOnly = uniqueEmail(`split-backorder-${viewport.name}`);
      const notReserved = uniqueEmail(`split-notreserved-${viewport.name}`);
      await withLocalDb(async (db) => {
        const orders = [
          await createOrderWithLines(db, stockOnly, [STOCK_LINE]),
          await createOrderWithLines(db, backorderOnly, [BACKORDER_LINE]),
          // 在庫を確保し直せなかった注文は、引き渡しの時期を書かない今の決まりに合わせて、この1行も書かない
          await createOrderWithLines(db, notReserved, [STOCK_LINE, BACKORDER_LINE], { reviewReason: 'stock_not_reserved' }),
        ];
        for (const order of orders) {
          await db.query("select private.enqueue_order_email($1::uuid, 'paid', 'order_confirmed')", [order.orderId]);
        }
      });
      const arrived = async (email: string) =>
        (await mailsTo(request, email)).filter((message) => message.Subject.includes(PAID_SUBJECT)).length;
      await runWorkerUntil(
        request,
        async () => (await arrived(stockOnly)) >= 1 && (await arrived(backorderOnly)) >= 1 && (await arrived(notReserved)) >= 1,
        '3つの確認のメールが届くこと',
      );

      for (const email of [stockOnly, backorderOnly, notReserved]) {
        const [mail] = await mailBodies(request, email, PAID_SUBJECT);
        expect(mail.Text).not.toContain(SPLIT_NOTICE);
      }
      // 品の欄は今までどおり出ている
      expect((await mailBodies(request, stockOnly, PAID_SUBJECT))[0].Text).toContain('E2E在庫のシャツ');
      expect((await mailBodies(request, backorderOnly, PAID_SUBJECT))[0].Text).toContain('E2E受注生産のコート');
    });
  });
}
