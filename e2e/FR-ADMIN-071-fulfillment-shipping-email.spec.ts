/**
 * FR-ADMIN-071 発送ごとの発送のお知らせ
 * 対応 FREQ: FREQ-442（AC-01〜AC-04）
 *
 * 管理画面の発送の操作の代わりに、手元の DB の発送の関数を直に呼び、worker の定期処理の入口を叩き、
 * 手元のメール受け（Mailpit）に届いたメールを数えて確かめる（実装計画 P11。FR-ADMIN-066 と同じやり方）。
 */
import { expect, test } from '@playwright/test';
import {
  createActor,
  createFulfillment,
  createOrderWithLines,
  mailBodies,
  mailsTo,
  outboxRows,
  recordCompletion,
  runWorkerOnce,
  runWorkerUntil,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import { orderNumberOf, viewports } from './order-fulfillment-test-utils';

const SHIPPED_SUBJECT = '商品を発送いたしました';
const REMAINING = '残りの商品は、準備ができ次第お送りします。';

/** 送信済みになった発送のメールの数。メールが着いてから行が送信済みになるまでの、わずかな差を待つために使う */
async function sentShipped(orderId: string): Promise<number> {
  const rows = await withLocalDb((db) => outboxRows(db, orderId));
  return rows.filter((row) => row.status === 'sent').length;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-071 fulfillment shipping email (${viewport.name})`, () => {
    test('発送ごとに発送のメールが1通届き、その発送の商品と数だけが書いてあり、残りの案内は最初の発送のメールにだけ入る（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-442-AC-01, FREQ-442-AC-02, FREQ-442-AC-03
      // worker の入口は Stripe の知らせの処理と注文のメールの送信を続けて動かすので、既定の30秒では足りないことがある
      test.setTimeout(180_000);
      const email = uniqueEmail(`ship-split-${viewport.name}`);
      const context = await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(db, email, [
          { name: 'E2E在庫のシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2E受注生産のコート', quantity: 1, fulfillmentType: 'backorder' },
        ]);
        const [shirt, coat] = order.orderItemIds;
        await recordCompletion(db, order.orderId, actorId, [{ orderItemId: coat, quantity: 1 }]);
        // 1回目: 在庫のシャツだけ。コートが残る
        const first = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-SPLIT-1',
          carrier: 'yamato',
          lines: [{ orderItemId: shirt, quantity: 2 }],
        });
        expect(first).toMatchObject({ number: 1, completesOrder: false, orderStatus: 'paid' });
        return { actorId, orderId: order.orderId, coat, first };
      });
      await runWorkerUntil(request, async () => (await sentShipped(context.orderId)) >= 1, '1回目の発送のメールが送信済みになること');

      // 2回目: 仕上がったコート。全部送り終わる
      const second = await withLocalDb((db) =>
        createFulfillment(db, context.orderId, context.actorId, {
          trackingNumber: 'E2E-SPLIT-2',
          carrier: 'sagawa',
          lines: [{ orderItemId: context.coat, quantity: 1 }],
        }));
      expect(second).toMatchObject({ number: 2, completesOrder: true, orderStatus: 'shipped' });
      await runWorkerUntil(request, async () => (await sentShipped(context.orderId)) >= 2, '2回目の発送のメールが送信済みになること');

      // 発送ごとに1通（注文で1通ではない）。件名は決まった文と注文番号だけ
      const mails = await mailBodies(request, email, SHIPPED_SUBJECT);
      expect(mails).toHaveLength(2);
      for (const mail of mails) {
        expect(mail.Subject).toBe(`【Le Fil des Heures】${SHIPPED_SUBJECT}（${orderNumberOf(context.orderId)}）`);
      }
      const firstMail = mails.filter((mail) => mail.Text.includes('E2E-SPLIT-1'));
      const secondMail = mails.filter((mail) => mail.Text.includes('E2E-SPLIT-2'));
      expect(firstMail).toHaveLength(1);
      expect(secondMail).toHaveLength(1);

      // 1回目: 送った商品と数・配送業者・残りの案内。まだ送っていないコートと、値段は書かない
      expect(firstMail[0].Text).toMatch(/E2E在庫のシャツ[^\n]*x2/);
      expect(firstMail[0].Text).toContain('ヤマト運輸');
      expect(firstMail[0].Text).toContain(REMAINING);
      expect(firstMail[0].Text).not.toContain('E2E受注生産のコート');
      expect(firstMail[0].Text).not.toMatch(/[¥￥]/);
      // 2回目: コートだけ。全部送ったので、残りの案内は無い
      expect(secondMail[0].Text).toMatch(/E2E受注生産のコート[^\n]*x1/);
      expect(secondMail[0].Text).toContain('佐川急便');
      expect(secondMail[0].Text).not.toContain(REMAINING);
      expect(secondMail[0].Text).not.toContain('E2E在庫のシャツ');
      expect(secondMail[0].Text).not.toMatch(/[¥￥]/);

      // 注文のメールの表には、発送ごとに1行（自動）。履歴は何回目かを返す
      expect(await withLocalDb((db) => outboxRows(db, context.orderId))).toEqual([
        { fulfillment_id: context.first.fulfillmentId, origin: 'auto', status: 'sent', last_error_code: null },
        { fulfillment_id: second.fulfillmentId, origin: 'auto', status: 'sent', last_error_code: null },
      ]);
      const history = await withLocalDb(async (db) =>
        (await db.query(
          "select fulfillment_number from public.list_order_email_history($1::uuid) where kind = 'shipped' order by fulfillment_number",
          [context.orderId],
        )).rows);
      expect(history).toEqual([{ fulfillment_number: 1 }, { fulfillment_number: 2 }]);
    });

    test('知らせない発送にはメールが届かず、知らせる発送の分だけ1通届く（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-442-AC-04
      test.setTimeout(180_000);
      const email = uniqueEmail(`ship-mixed-${viewport.name}`);
      const { orderId, notified } = await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(db, email, [
          { name: 'E2E在庫のシャツ', quantity: 1, fulfillmentType: 'stock' },
          { name: 'E2E在庫のスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const [shirt, skirt] = order.orderItemIds;
        const silent = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-SILENT-1',
          notify: false,
          lines: [{ orderItemId: shirt, quantity: 1 }],
        });
        const notifiedShipment = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-NOTIFIED-2',
          carrier: 'japanpost',
          notify: true,
          lines: [{ orderItemId: skirt, quantity: 1 }],
        });
        expect(silent).toMatchObject({ number: 1, completesOrder: false });
        expect(notifiedShipment).toMatchObject({ number: 2, completesOrder: true });
        return { orderId: order.orderId, notified: notifiedShipment };
      });

      await runWorkerUntil(request, async () => (await sentShipped(orderId)) >= 1, '知らせる発送のメールが送信済みになること');
      // 知らせない発送の行は書かれず、知らせる発送の行だけがある
      expect(await withLocalDb((db) => outboxRows(db, orderId))).toEqual([
        { fulfillment_id: notified.fulfillmentId, origin: 'auto', status: 'sent', last_error_code: null },
      ]);
      // もう一度動かしても、メールは増えない
      await runWorkerOnce(request);
      const mails = await mailBodies(request, email, SHIPPED_SUBJECT);
      expect(mails).toHaveLength(1);
      expect(mails[0].Text).toContain('E2E-NOTIFIED-2');
      expect(mails[0].Text).toContain('日本郵便');
      expect(mails[0].Text).toContain('E2E在庫のスカート');
      expect(mails[0].Text).not.toContain('E2E-SILENT-1');
      expect(mails[0].Text).not.toContain('E2E在庫のシャツ');
      expect(mails[0].Text).not.toContain(REMAINING);
      expect(await mailsTo(request, email)).toHaveLength(1);
    });
  });
}
