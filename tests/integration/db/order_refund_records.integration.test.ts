/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  PRICE,
  createCatalogFixture,
  insertOrderWithLines,
  insertRefundRecord,
  uniqueSuffix,
  variantStock,
  type RefundFixtureStatus,
} from './helpers/order-fixtures';

/**
 * 返金の記録と数え方（グループ E-2 設計書 4・7・10・11 章、移行 A）。
 * 1件ごとに取引の中で動かし、終わったら戻す。返金を始める関数（移行 B）はまだ無いので、返金の記録は postgres で直接書く。
 * 割引の割り振りの値 A・B・C は、TS の額の見込み（Task 4 の refund-allocation の試験）と同じ値を使う。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

const IMMUTABLE = { code: '23514', message: 'ORDER_REFUND_IMMUTABLE' };
const INVALID_TRANSITION = { code: '23514', message: 'ORDER_REFUND_INVALID_TRANSITION' };
const APPEND_ONLY = { code: '23514', message: 'ORDER_REFUND_APPEND_ONLY' };
const BOUNDS = { code: '23514', message: 'FULFILLMENT_BOUNDS_VIOLATED' };
const OUT_OF_RANGE = { code: '23514', constraint: 'orders_refunded_amount_range' };

// 状態の移り方（Global Constraints）。同じ状態のままの更新は、細目を書き直すだけなので通す
const ALLOWED_TRANSITIONS: Array<[RefundFixtureStatus, RefundFixtureStatus]> = [
  ['awaiting_response', 'pending'],
  ['awaiting_response', 'succeeded'],
  ['awaiting_response', 'error'],
  ['awaiting_response', 'failed'],
  ['error', 'pending'],
  ['error', 'succeeded'],
  ['error', 'failed'],
  ['pending', 'succeeded'],
  ['pending', 'failed'],
  ['succeeded', 'failed'],
  ['pending', 'pending'],
];

const REFUSED_TRANSITIONS: Array<[RefundFixtureStatus, RefundFixtureStatus]> = [
  ['pending', 'awaiting_response'],
  ['pending', 'error'],
  ['succeeded', 'awaiting_response'],
  ['succeeded', 'error'],
  ['succeeded', 'pending'],
  ['error', 'awaiting_response'],
  ['failed', 'awaiting_response'],
  ['failed', 'error'],
  ['failed', 'pending'],
  ['failed', 'succeeded'],
];

/** 入金済みの注文: 在庫の品2点と受注生産の品3点（どちらも単価 5000）。受け取った額は合計と同じ */
async function createPaidOrder(db: PgClient, options: { shippingAmount?: number } = {}) {
  const stockFx = await createCatalogFixture(db, { stock: 5 });
  const madeFx = await createCatalogFixture(db, { stock: 0 });
  const shippingAmount = options.shippingAmount ?? 0;
  const { orderId, orderItemIds } = await insertOrderWithLines(db, {
    status: 'paid',
    shippingAmount,
    paidAmount: PRICE * 5 + shippingAmount,
    paymentIntentId: `pi_${uniqueSuffix()}`,
    lines: [
      { itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 2, fulfillmentType: 'stock' },
      { itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 3, fulfillmentType: 'backorder' },
    ],
  });
  return { orderId, stockItemId: orderItemIds[0], madeItemId: orderItemIds[1], stockFx, madeFx };
}

async function lineCounts(db: PgClient, orderId: string): Promise<Record<string, Row>> {
  const res = await db.query('select * from private.order_line_fulfillment($1)', [orderId]);
  return Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row]));
}

/** 発送の記録を直接書く（発送の関数を通さずに、発送した数だけを作る） */
async function insertFulfillment(
  db: PgClient,
  orderId: string,
  lines: Array<{ orderItemId: string; quantity: number }>,
): Promise<void> {
  const res = await db.query(
    `insert into public.order_fulfillments
       (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order)
     values ($1, 1, gen_random_uuid(), 'yamato', '1234-5678-9012', true, false)
     returning id`,
    [orderId],
  );
  for (const line of lines) {
    await db.query(
      'insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, $3)',
      [res.rows[0].id, line.orderItemId, line.quantity],
    );
  }
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

function updateRefund(db: PgClient, set: string, refundId: string) {
  return db.query(`update public.order_refunds set ${set} where id = $1`, [refundId]);
}

/** 返金の記録を、列ごとに SQL の書き方を決めて直接書く。道ごとの必須の列（CHECK）の試験が使う */
function insertRefundRow(db: PgClient, orderId: string, extra: Record<string, string>) {
  const columns: Record<string, string> = {
    order_id: '$1',
    status: "'awaiting_response'",
    amount: '1000',
    notify_customer: 'false',
    ...extra,
  };
  return db.query(
    `insert into public.order_refunds (${Object.keys(columns).join(', ')}) values (${Object.values(columns).join(', ')})`,
    [orderId],
  );
}

describeLocalDb('integration: 返金の記録と数え方（移行 A）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('表の守り', () => {
    test('お客様とログインした人は読めず、アプリは読むだけ（返金の2つの表とショップの設定）', async () => {
      for (const table of ['order_refunds', 'order_refund_lines', 'shop_settings']) {
        for (const role of ['anon', 'authenticated']) {
          await db().query('savepoint role_check');
          await db().query(`set local role ${role}`);
          await expect(db().query(`select * from public.${table} limit 1`)).rejects.toMatchObject({ code: '42501' });
          await db().query('rollback to savepoint role_check');
        }
        await db().query('savepoint role_check');
        await db().query('set local role service_role');
        await expect(db().query(`select count(*) from public.${table}`)).resolves.toBeDefined();
        await expect(db().query(`delete from public.${table}`)).rejects.toMatchObject({ code: '42501' });
        await db().query('rollback to savepoint role_check');

        const privileges = await db().query(
          `select has_table_privilege('service_role', $1::text, 'select') as can_select,
                  has_table_privilege('service_role', $1::text, 'insert') as can_insert,
                  has_table_privilege('service_role', $1::text, 'update') as can_update`,
          [`public.${table}`],
        );
        expect(privileges.rows[0]).toEqual({ can_select: true, can_insert: false, can_update: false });
      }
    });

    test('切り替えの時刻の表は、アプリからも読めない（関数だけが読む）', async () => {
      const res = await db().query(
        `select has_table_privilege('anon', 'private.refund_ledger_state', 'select') as anon_select,
                has_table_privilege('authenticated', 'private.refund_ledger_state', 'select') as authed_select,
                has_table_privilege('service_role', 'private.refund_ledger_state', 'select') as service_select`,
      );
      expect(res.rows[0]).toEqual({ anon_select: false, authed_select: false, service_select: false });
    });

    test('返金の記録は消せず、直せるのは状態とその細目・時刻・印だけ', async () => {
      const { orderId } = await createPaidOrder(db());
      const other = await createPaidOrder(db());
      const { refundId } = await insertRefundRecord(db(), { orderId });

      // 中身は直せない
      for (const set of [
        'amount = 2000',
        'shipping_amount = 100',
        'adjustment_amount = 5',
        "note = 'あとから書き換え'",
        "stripe_reason = 'duplicate'",
        'notify_customer = true',
        "request_fingerprint = 'other'",
        'request_key = gen_random_uuid()',
        'actor_id = gen_random_uuid()',
        "created_at = now() - interval '1 day'",
      ]) {
        await expectRejected(db(), `update public.order_refunds set ${set} where id = $1`, [refundId], IMMUTABLE);
      }
      await expectRejected(db(), 'update public.order_refunds set order_id = $2 where id = $1', [refundId, other.orderId], IMMUTABLE);

      // Stripe の細目は何度でも上書きできる
      await updateRefund(
        db(),
        "stripe_status = 'pending', stripe_pending_reason = 'processing', reference_number = 'ARN-1', reference_type = 'acquirer_reference_number', customer_action_expires_at = now()",
        refundId,
      );
      await updateRefund(
        db(),
        "stripe_status = 'requires_action', stripe_pending_reason = 'charge_pending', stripe_failure_reason = 'declined', reference_number = 'ARN-2'",
        refundId,
      );

      // 空から値へ1回だけ書く列は、書いた後は変えられない。同じ値の書き直しは通る（知らせの取り込みは何度でも同じ値を書く）。
      // Stripe の返金の番号は表全体で一意なので、手元の DB にほかの試験が確定した番号があっても当たらないよう、毎回作る
      const stripeRefundId = `re_abc${uniqueSuffix()}`;
      const onceTimes = ['accepted_at', 'succeeded_at', 'failed_at', 'errored_at', 'stock_applied_at', 'email_enqueued_at', 'failure_applied_at'];
      await updateRefund(
        db(),
        `stripe_refund_id = '${stripeRefundId}', payment_method_type = 'card', ${onceTimes.map((column) => `${column} = now()`).join(', ')}`,
        refundId,
      );
      await updateRefund(db(), `stripe_refund_id = '${stripeRefundId}', payment_method_type = 'card'`, refundId);
      for (const column of onceTimes) {
        await updateRefund(db(), `${column} = now()`, refundId);
        await expectRejected(db(), `update public.order_refunds set ${column} = now() + interval '1 minute' where id = $1`, [refundId], IMMUTABLE);
        await expectRejected(db(), `update public.order_refunds set ${column} = null where id = $1`, [refundId], IMMUTABLE);
      }
      await expectRejected(db(), `update public.order_refunds set stripe_refund_id = 're_other${uniqueSuffix()}' where id = $1`, [refundId], IMMUTABLE);
      await expectRejected(db(), 'update public.order_refunds set stripe_refund_id = null where id = $1', [refundId], IMMUTABLE);
      await expectRejected(db(), "update public.order_refunds set payment_method_type = 'konbini' where id = $1", [refundId], IMMUTABLE);

      await expectRejected(db(), 'delete from public.order_refunds where id = $1', [refundId], APPEND_ONLY);
    });

    test.each(ALLOWED_TRANSITIONS)('状態 %s から %s へ進める', async (from, to) => {
      const { orderId } = await createPaidOrder(db());
      const { refundId } = await insertRefundRecord(db(), { orderId, status: from });

      await updateRefund(db(), `status = '${to}'`, refundId);

      const res = await db().query('select status from public.order_refunds where id = $1', [refundId]);
      expect(res.rows[0].status).toBe(to);
    });

    test.each(REFUSED_TRANSITIONS)('状態 %s から %s へは進めない', async (from, to) => {
      const { orderId } = await createPaidOrder(db());
      const { refundId } = await insertRefundRecord(db(), { orderId, status: from });

      await expectRejected(db(), `update public.order_refunds set status = '${to}' where id = $1`, [refundId], INVALID_TRANSITION);
    });

    test('道ごとの必須の列: 二重防止の番号と指紋・Stripe の返金の番号・取消の理由・写しは在庫とメールを動かさない', async () => {
      const { orderId } = await createPaidOrder(db());
      const uuid = 'gen_random_uuid()';
      // Stripe の返金の番号は表全体で一意なので、毎回作る（SQL に書く形。引用符つき）
      const stripeId = () => `'re_x${uniqueSuffix()}'`;
      const refused: Array<[string, Record<string, string>]> = [
        // 管理画面・注文のキャンセルは、二重防止の番号と指紋が両方要る（片方だけも断る）
        ['order_refunds_request_check', { source: "'admin'" }],
        ['order_refunds_request_check', { source: "'admin'", request_key: uuid }],
        ['order_refunds_request_check', { source: "'stripe_dashboard'", stripe_refund_id: stripeId(), request_fingerprint: "'f'" }],
        // Stripe の画面・写しは、Stripe の返金の番号が要り、二重防止の番号は持たない
        ['order_refunds_external_check', { source: "'stripe_dashboard'" }],
        ['order_refunds_external_check', { source: "'legacy'" }],
        ['order_refunds_external_check', { source: "'legacy'", stripe_refund_id: stripeId(), request_key: uuid, request_fingerprint: "'f'" }],
        // 取消の理由は、注文のキャンセルと自動の取消（支払額の違い）だけが持つ
        ['order_refunds_cancel_reason_check', { source: "'order_cancel'", request_key: uuid, request_fingerprint: "'f'" }],
        ['order_refunds_cancel_reason_check', { source: "'auto_amount_mismatch'" }],
        ['order_refunds_cancel_reason_check', { source: "'admin'", request_key: uuid, request_fingerprint: "'f'", cancel_reason: "'other'" }],
        // 写しは、在庫もメールも動かさない
        ['order_refunds_legacy_check', { source: "'legacy'", stripe_refund_id: stripeId(), notify_customer: 'true' }],
        ['order_refunds_legacy_check', { source: "'legacy'", stripe_refund_id: stripeId(), stock_applied_at: 'now()' }],
        ['order_refunds_legacy_check', { source: "'legacy'", stripe_refund_id: stripeId(), email_enqueued_at: 'now()' }],
      ];
      for (const [constraint, extra] of refused) {
        await db().query('savepoint check_case');
        await expect(insertRefundRow(db(), orderId, extra)).rejects.toMatchObject({ code: '23514', constraint });
        await db().query('rollback to savepoint check_case');
      }

      const accepted: Array<Record<string, string>> = [
        { source: "'admin'", request_key: uuid, request_fingerprint: "'f'" },
        { source: "'order_cancel'", request_key: uuid, request_fingerprint: "'f'", cancel_reason: "'stock_unavailable'" },
        { source: "'stripe_dashboard'", stripe_refund_id: stripeId() },
        { source: "'auto_cancelled_order_payment'" },
        { source: "'auto_amount_mismatch'", cancel_reason: "'other'" },
        { source: "'legacy'", stripe_refund_id: stripeId() },
      ];
      for (const extra of accepted) {
        await insertRefundRow(db(), orderId, extra);
      }
      const count = await db().query('select count(*)::int as n from public.order_refunds where order_id = $1', [orderId]);
      expect(count.rows[0].n).toBe(accepted.length);
    });

    test('Stripe の返金の番号の形: 2〜4字の小文字・下線・英数字だけ。re_ のほか、カード以外の支払いの返金の番号（pyr_ など）も通す（P29）', async () => {
      const { orderId } = await createPaidOrder(db());
      const insertStripeId = (value: string) =>
        db().query(
          `insert into public.order_refunds (order_id, source, status, amount, notify_customer, stripe_refund_id)
           values ($1, 'stripe_dashboard', 'pending', 1000, true, $2)`,
          [orderId, value],
        );

      for (const value of ['not a refund', 're_', 'r_abc123', 'abcde_abc123', 're_abc-123', 're_abc 123', 'RE_abc123']) {
        await db().query('savepoint format_case');
        await expect(insertStripeId(value)).rejects.toMatchObject({
          code: '23514',
          constraint: 'order_refunds_stripe_refund_id_check',
        });
        await db().query('rollback to savepoint format_case');
      }

      for (const prefix of ['re', 'py', 'pyr', 'abcd']) {
        await insertStripeId(`${prefix}_abc${uniqueSuffix()}`);
      }
      const count = await db().query('select count(*)::int as n from public.order_refunds where order_id = $1', [orderId]);
      expect(count.rows[0].n).toBe(4);
    });

    test('二重防止の番号と Stripe の返金の番号は、表全体で一意。制約の名前は Task 2 が見分けに使う', async () => {
      const first = await createPaidOrder(db());
      const second = await createPaidOrder(db());
      const requestKey = crypto.randomUUID();
      const stripeRefundId = `re_uniq${uniqueSuffix()}`;
      await db().query(
        `insert into public.order_refunds
           (order_id, source, request_key, request_fingerprint, status, amount, notify_customer, stripe_refund_id)
         values ($1, 'admin', $2, 'f', 'pending', 1000, false, $3)`,
        [first.orderId, requestKey, stripeRefundId],
      );

      // ほかの注文でも、同じ番号は使えない
      await expectRejected(
        db(),
        `insert into public.order_refunds (order_id, source, request_key, request_fingerprint, status, amount, notify_customer)
         values ($1, 'admin', $2, 'f', 'awaiting_response', 1000, false)`,
        [second.orderId, requestKey],
        { code: '23505', constraint: 'order_refunds_request_key_key' },
      );
      await expectRejected(
        db(),
        `insert into public.order_refunds (order_id, source, status, amount, notify_customer, stripe_refund_id)
         values ($1, 'stripe_dashboard', 'pending', 1000, true, $2)`,
        [second.orderId, stripeRefundId],
        { code: '23505', constraint: 'order_refunds_stripe_refund_id_key' },
      );
    });

    test('TRUNCATE を止める文のトリガーが、返金の2つの表にある', async () => {
      const res = await db().query(
        `select c.relname || ':' || t.tgname as trigger_name
         from pg_trigger as t
         join pg_class as c on c.oid = t.tgrelid
         where c.relnamespace = 'public'::regnamespace
           and c.relname in ('order_refunds', 'order_refund_lines')
           and not t.tgisinternal
           and (t.tgtype & 32) = 32`,
      );
      expect(res.rows.map((row) => row.trigger_name as string).sort()).toEqual([
        'order_refund_lines:order_refund_lines_no_truncate',
        'order_refunds:order_refunds_no_truncate',
      ]);
    });
  });

  describe('返金の商品の行', () => {
    const insertLine = `insert into public.order_refund_lines
        (refund_id, order_item_id, quantity, before_shipment, restock_type, amount, released_quantity, restocked_quantity)
      values ($1, $2, $3, $4, $5, 0, $6, $7)`;

    test('ほかの注文の商品は、返金の商品にできない', async () => {
      const first = await createPaidOrder(db());
      const second = await createPaidOrder(db());
      const { refundId } = await insertRefundRecord(db(), { orderId: first.orderId });

      await expectRejected(db(), insertLine, [refundId, second.stockItemId, 1, true, 'cancel', 0, 0], {
        code: '22023',
        message: 'REFUND_LINE_NOT_IN_ORDER',
      });
    });

    test('数が合わない行は書けない: 未発送を超える・発送した数と合わせて注文の数を超える・発送後の返金が発送した数を超える。失敗した返金の行は数えない', async () => {
      const { orderId, stockItemId } = await createPaidOrder(db()); // 在庫の品は2点
      const first = await insertRefundRecord(db(), { orderId });

      // 未発送は2点。3点は書けない
      await expectRejected(db(), insertLine, [first.refundId, stockItemId, 3, true, 'cancel', 0, 0], BOUNDS);
      // 1点送ると、発送前に返せるのは残りの1点まで
      await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 1 }]);
      await expectRejected(db(), insertLine, [first.refundId, stockItemId, 2, true, 'cancel', 0, 0], BOUNDS);
      await db().query(insertLine, [first.refundId, stockItemId, 1, true, 'cancel', 0, 0]);
      // 発送後の返金は、送った1点まで
      const second = await insertRefundRecord(db(), { orderId });
      await expectRejected(db(), insertLine, [second.refundId, stockItemId, 2, false, 'no_restock', 0, 0], BOUNDS);
      await db().query(insertLine, [second.refundId, stockItemId, 1, false, 'no_restock', 0, 0]);
      // 失敗した返金の行は数えないので、同じ商品をもう一度書ける
      const failed = await insertRefundRecord(db(), { orderId, status: 'failed' });
      await db().query(insertLine, [failed.refundId, stockItemId, 1, true, 'cancel', 0, 0]);
      // 返事待ちの返金の行は数える
      const awaiting = await insertRefundRecord(db(), { orderId, status: 'awaiting_response' });
      await expectRejected(db(), insertLine, [awaiting.refundId, stockItemId, 1, true, 'cancel', 0, 0], BOUNDS);
    });

    test('行の決まり: 同じ商品の発送前・発送後は1行ずつ、発送後の行は在庫に戻せない、確保を外した数は返金する数まで、数は 1 から 999', async () => {
      const { orderId, stockItemId } = await createPaidOrder(db());
      await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 2 }]);
      const first = await insertRefundRecord(db(), { orderId });
      const second = await insertRefundRecord(db(), { orderId });

      await db().query(insertLine, [first.refundId, stockItemId, 1, false, 'no_restock', 0, 0]);
      await expectRejected(db(), insertLine, [first.refundId, stockItemId, 1, false, 'no_restock', 0, 0], {
        code: '23505',
        constraint: 'order_refund_lines_refund_item_key',
      });
      await expectRejected(db(), insertLine, [second.refundId, stockItemId, 1, false, 'cancel', 0, 0], {
        code: '23514',
        constraint: 'order_refund_lines_restock_check',
      });
      await expectRejected(db(), insertLine, [second.refundId, stockItemId, 1, false, 'no_restock', 2, 0], {
        code: '23514',
        constraint: 'order_refund_lines_release_check',
      });
      await expectRejected(db(), insertLine, [second.refundId, stockItemId, 1, false, 'no_restock', 0, 1], {
        code: '23514',
        constraint: 'order_refund_lines_release_check',
      });
      await expectRejected(db(), insertLine, [second.refundId, stockItemId, 0, false, 'no_restock', 0, 0], {
        code: '23514',
        constraint: 'order_refund_lines_quantity_check',
      });
    });

    test('返金で減った数を超える発送の行は、直接書いてもトリガーが断る（s + rb ≤ q）', async () => {
      const { orderId, stockItemId } = await createPaidOrder(db()); // 在庫の品は2点
      await insertRefundRecord(db(), { orderId, lines: [{ orderItemId: stockItemId, quantity: 1 }] });

      // 2点のうち1点を返金したので、発送の行に書けるのは1点まで
      await db().query('savepoint ship_over');
      await expect(insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 2 }])).rejects.toMatchObject(BOUNDS);
      await db().query('rollback to savepoint ship_over');
      await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 1 }]);

      expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 1, refunded_before_shipment: 1, unshipped: 0 });
    });

    test('確保を外した数など4つの数は 0 から1回だけ書ける。ほかの列は直せず、行は消せない', async () => {
      const { orderId, stockItemId } = await createPaidOrder(db());
      const { refundId } = await insertRefundRecord(db(), { orderId, lines: [{ orderItemId: stockItemId, quantity: 2 }] });
      const line = (await db().query('select id from public.order_refund_lines where refund_id = $1', [refundId])).rows[0];
      const updateLine = (set: string) => db().query(`update public.order_refund_lines set ${set} where id = $1`, [line.id]);

      await updateLine('released_quantity = 2, restocked_quantity = 1');
      await updateLine('rereserved_quantity = 1, rereserve_shortage = 1');
      await updateLine('released_quantity = 2'); // 同じ値の書き直しは通る
      for (const set of [
        'released_quantity = 1',
        'restocked_quantity = 0',
        'rereserved_quantity = 2',
        'rereserve_shortage = 0',
        'quantity = 1',
        'amount = 100',
        'before_shipment = false',
        "restock_type = 'no_restock'",
      ]) {
        await expectRejected(db(), `update public.order_refund_lines set ${set} where id = $1`, [line.id], IMMUTABLE);
      }
      await expectRejected(db(), 'delete from public.order_refund_lines where id = $1', [line.id], APPEND_ONLY);
    });
  });

  describe('商品ごとの数', () => {
    test.each<[RefundFixtureStatus, number]>([
      ['awaiting_response', 1],
      ['pending', 1],
      ['succeeded', 1],
      ['error', 0],
      ['failed', 0],
    ])('%s の返金の発送前の行は、数に %i 点入る', async (status, counted) => {
      const { orderId, stockItemId } = await createPaidOrder(db());
      await insertRefundRecord(db(), { orderId, status, lines: [{ orderItemId: stockItemId, quantity: 1 }] });

      const counts = await lineCounts(db(), orderId);

      expect(counts[stockItemId]).toMatchObject({
        quantity: 2,
        shipped: 0,
        refunded_before_shipment: counted,
        refunded_after_shipment: 0,
        unshipped: 2 - counted,
        ready_unshipped: 2 - counted,
      });
    });

    test.each<[number, number, number, number]>([
      // 発送前の返金の点数, まだ作っていない数, 発送準備中, 未発送
      [0, 2, 1, 3],
      [1, 1, 1, 2],
      [2, 0, 1, 1],
      [3, 0, 0, 0],
    ])('受注生産の品（3点注文・1点仕上がり・発送なし）の発送前の返金 %i 点: まだ作っていない %i・発送準備中 %i・未発送 %i', async (refunded, inProduction, ready, unshipped) => {
      const { orderId, madeItemId } = await createPaidOrder(db());
      await db().query(
        'insert into public.order_item_completions (order_id, order_item_id, quantity, request_key) values ($1, $2, 1, gen_random_uuid())',
        [orderId, madeItemId],
      );
      if (refunded > 0) {
        await insertRefundRecord(db(), { orderId, status: 'succeeded', lines: [{ orderItemId: madeItemId, quantity: refunded }] });
      }

      const counts = await lineCounts(db(), orderId);

      // まだ作っていない数から先に減り、作った品は 3 点全部を返す時にだけ注文から外れる
      expect(counts[madeItemId]).toMatchObject({
        quantity: 3,
        completed: 1,
        shipped: 0,
        refunded_before_shipment: refunded,
        in_production: inProduction,
        ready_unshipped: ready,
        unshipped,
      });
    });

    test('発送後の返金は未発送を変えない（発送後に返せる数だけが減る）', async () => {
      const { orderId, stockItemId } = await createPaidOrder(db());
      await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 2 }]);
      await insertRefundRecord(db(), {
        orderId,
        status: 'succeeded',
        lines: [{ orderItemId: stockItemId, quantity: 1, beforeShipment: false }],
      });

      const counts = await lineCounts(db(), orderId);

      expect(counts[stockItemId]).toMatchObject({
        shipped: 2,
        refunded_before_shipment: 0,
        refunded_after_shipment: 1,
        unshipped: 0,
        ready_unshipped: 0,
      });
    });

    test('注文の番号の配列で読む関数も、返金した数の2つの列を、決めた並びで返す', async () => {
      const first = await createPaidOrder(db());
      const second = await createPaidOrder(db());
      await insertRefundRecord(db(), {
        orderId: first.orderId,
        status: 'pending',
        lines: [{ orderItemId: first.stockItemId, quantity: 1 }],
      });

      const res = await db().query('select * from public.list_order_line_fulfillment($1::uuid[])', [[first.orderId, second.orderId]]);

      expect(Object.keys(res.rows[0])).toEqual([
        'order_id',
        'order_item_id',
        'variant_id',
        'fulfillment_type',
        'quantity',
        'shipped',
        'completed',
        'refunded_before_shipment',
        'refunded_after_shipment',
        'in_production',
        'ready_unshipped',
        'unshipped',
      ]);
      const byItem = Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row]));
      expect(byItem[first.stockItemId]).toMatchObject({
        order_id: first.orderId,
        refunded_before_shipment: 1,
        refunded_after_shipment: 0,
        unshipped: 1,
      });
      expect(byItem[second.stockItemId]).toMatchObject({ refunded_before_shipment: 0, unshipped: 2 });
    });

    test('返金で数が減った商品は、発送も仕上がりの記録も、減った後の数までしかできない', async () => {
      const { orderId, stockItemId, madeItemId } = await createPaidOrder(db());
      await insertRefundRecord(db(), {
        orderId,
        lines: [
          { orderItemId: stockItemId, quantity: 1 },
          { orderItemId: madeItemId, quantity: 2 },
        ],
      });
      const actorId = crypto.randomUUID();
      const shipSql = `select * from public.admin_create_fulfillment($1, $2, $3, 'yamato', '1234-5678-9012', false, $4::jsonb)`;
      const shipParams = (quantity: number) => [
        orderId,
        actorId,
        crypto.randomUUID(),
        JSON.stringify([{ order_item_id: stockItemId, quantity }]),
      ];
      const completeSql = 'select * from public.admin_record_completion($1, $2, $3, $4::jsonb)';
      const completeParams = (quantity: number) => [
        orderId,
        actorId,
        crypto.randomUUID(),
        JSON.stringify([{ order_item_id: madeItemId, quantity }]),
      ];

      // 在庫の品: 2点のうち1点を返金したので、送れるのは1点まで
      await expectRejected(db(), shipSql, shipParams(2), { code: '22023', message: 'QUANTITY_EXCEEDS_READY' });
      const shipped = await db().query(shipSql, shipParams(1));
      expect(shipped.rows[0]).toMatchObject({ completes_order: false, replayed: false });

      // 受注生産の品: 3点のうち2点を返金したので、作るのは1点まで
      await expectRejected(db(), completeSql, completeParams(2), { code: '22023', message: 'QUANTITY_EXCEEDS_IN_PRODUCTION' });
      await db().query(completeSql, completeParams(1));

      const counts = await lineCounts(db(), orderId);
      expect(counts[stockItemId]).toMatchObject({ shipped: 1, refunded_before_shipment: 1, unshipped: 0, ready_unshipped: 0 });
      expect(counts[madeItemId]).toMatchObject({ completed: 1, refunded_before_shipment: 2, in_production: 0, ready_unshipped: 1, unshipped: 1 });
    });

    test('引き当て済みと受注生産の数: 返事待ちの間は受注生産だけが減り、台帳に返金の行が入ると引き当て済みも減る', async () => {
      const { orderId, stockItemId, madeItemId, stockFx, madeFx } = await createPaidOrder(db());
      const states = async () => {
        const res = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [
          [stockFx.variantId, madeFx.variantId],
        ]);
        return Object.fromEntries(res.rows.map((row) => [Number(row.variant_id), row])) as Record<number, Row>;
      };
      expect((await states())[stockFx.variantId]).toMatchObject({ committed: 2 });
      expect((await states())[madeFx.variantId]).toMatchObject({ backorder: 3 });

      const { refundId } = await insertRefundRecord(db(), {
        orderId,
        lines: [
          { orderItemId: stockItemId, quantity: 1 },
          { orderItemId: madeItemId, quantity: 2 },
        ],
      });
      // 返事待ちの間は、在庫の確保はまだ外れていない。受注生産のまだ作っていない数は、返金した分だけすぐ減る
      expect((await states())[stockFx.variantId]).toMatchObject({ committed: 2 });
      expect((await states())[madeFx.variantId]).toMatchObject({ backorder: 1 });

      // Stripe が受け付けた時は、結果を書く関数（移行 C）が台帳に返金の行を書く。ここでは同じ行を直接書く
      await db().query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id, refund_id)
         values ($1, 1, 'refund', $2, $3, $4)`,
        [stockFx.variantId, orderId, stockItemId, refundId],
      );
      expect((await states())[stockFx.variantId]).toMatchObject({ committed: 1 });
    });
  });

  describe('確保中の数', () => {
    test('台帳の返金の行も、確保中の数から引く。棚卸調整の行は引かない', async () => {
      const { orderId, stockItemId, stockFx } = await createPaidOrder(db());
      const reserved = async () =>
        (
          await db().query('select reserved from private.order_line_reservations($1) where order_item_id = $2', [
            orderId,
            stockItemId,
          ])
        ).rows[0].reserved as number;
      expect(await reserved()).toBe(2);

      // 「戻さない」返金は、返金の行 +1 と棚卸調整の行 −1 を同時に書く（手元の数は変わらず、確保だけが外れる）
      const { refundId } = await insertRefundRecord(db(), {
        orderId,
        lines: [{ orderItemId: stockItemId, quantity: 1, restockType: 'no_restock' }],
      });
      await db().query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id, refund_id)
         values ($1, 1, 'refund', $2, $3, $4), ($1, -1, 'adjustment', $2, $3, $4)`,
        [stockFx.variantId, orderId, stockItemId, refundId],
      );

      expect(await reserved()).toBe(1);
      expect(await variantStock(db(), stockFx.variantId)).toBe(3); // 5 − 2（確保）+ 1 − 1
    });
  });

  describe('割引の割り振りと返金の額', () => {
    /** 値 A の注文: 商品 X（単価 3000 × 2点）を先に、Y（単価 1000 × 3点）を後に登録した。小計の合計は 9000 */
    async function createDiscountedOrder(discountAmount: number) {
      const x = await createCatalogFixture(db(), { stock: 5 });
      const y = await createCatalogFixture(db(), { stock: 5 });
      const { orderId, orderItemIds } = await insertOrderWithLines(db(), {
        status: 'paid',
        discountAmount,
        lines: [
          { itemId: x.itemId, variantId: x.variantId, quantity: 2, fulfillmentType: 'stock', itemPrice: 3000, createdAt: '2026-10-11T00:00:01Z' },
          { itemId: y.itemId, variantId: y.variantId, quantity: 3, fulfillmentType: 'stock', itemPrice: 1000, createdAt: '2026-10-11T00:00:02Z' },
        ],
      });
      return { orderId, xId: orderItemIds[0], yId: orderItemIds[1] };
    }

    async function lineDiscounts(orderId: string): Promise<Record<string, number>> {
      const res = await db().query('select order_item_id, line_discount from private.order_line_discounts($1)', [orderId]);
      return Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row.line_discount as number]));
    }

    async function unitsDiscount(lineDiscount: number, quantity: number, units: number): Promise<number> {
      const res = await db().query('select private.refund_units_discount($1, $2, $3) as discount', [lineDiscount, quantity, units]);
      return res.rows[0].discount as number;
    }

    /** units 点を返す時の額 = 単価 × units − (disc(前に返した数 + units) − disc(前に返した数)) */
    async function returnAmount(itemPrice: number, lineDiscount: number, quantity: number, before: number, units: number): Promise<number> {
      const after = await unitsDiscount(lineDiscount, quantity, before + units);
      const prior = await unitsDiscount(lineDiscount, quantity, before);
      return itemPrice * units - (after - prior);
    }

    test('値 A: 割引 1000 は商品の小計を足していった和で丸めて割る（X 667・Y 333。商品が2つの注文は、最初の商品を四捨五入し最後の商品を残りにした値と同じ）', async () => {
      const { orderId, xId, yId } = await createDiscountedOrder(1000);

      expect(await lineDiscounts(orderId)).toEqual({ [xId]: 667, [yId]: 333 });
    });

    test('値 A: n 点分の割引 disc(n) と、複数回に分けて返した額の合計が「小計 − 商品の割引」とぴったり合う', async () => {
      const xDiscounts: number[] = [];
      for (const units of [0, 1, 2]) xDiscounts.push(await unitsDiscount(667, 2, units));
      expect(xDiscounts).toEqual([0, 334, 667]);
      const yDiscounts: number[] = [];
      for (const units of [0, 1, 2, 3]) yDiscounts.push(await unitsDiscount(333, 3, units));
      expect(yDiscounts).toEqual([0, 111, 222, 333]);

      // X を1点ずつ2回返す: 2666 と 2667（合計 5333 = 6000 − 667）
      const x1 = await returnAmount(3000, 667, 2, 0, 1);
      const x2 = await returnAmount(3000, 667, 2, 1, 1);
      expect([x1, x2]).toEqual([2666, 2667]);
      expect(x1 + x2).toBe(6000 - 667);
      // Y を2点、次に1点返す: 1778 と 889（合計 2667 = 3000 − 333）
      const y1 = await returnAmount(1000, 333, 3, 0, 2);
      const y2 = await returnAmount(1000, 333, 3, 2, 1);
      expect([y1, y2]).toEqual([1778, 889]);
      expect(y1 + y2).toBe(3000 - 333);
    });

    test('値 B: 割引が 0 なら、どの商品の割引もいつも 0', async () => {
      const { orderId, xId, yId } = await createDiscountedOrder(0);

      expect(await lineDiscounts(orderId)).toEqual({ [xId]: 0, [yId]: 0 });
      for (const [quantity, units] of [[2, 1], [2, 2], [3, 1], [3, 2], [3, 3]] as const) {
        expect(await unitsDiscount(0, quantity, units)).toBe(0);
      }
    });

    test('値 C: 1つの商品（3点）で割引が 1 円なら、1点・2点・3点分の割引は 0・1・1 円', async () => {
      const fx = await createCatalogFixture(db(), { stock: 3 });
      const { orderId, orderItemIds } = await insertOrderWithLines(db(), {
        status: 'paid',
        discountAmount: 1,
        lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 3, fulfillmentType: 'stock' }],
      });

      expect(await lineDiscounts(orderId)).toEqual({ [orderItemIds[0]]: 1 });
      const discounts: number[] = [];
      for (const units of [0, 1, 2, 3]) discounts.push(await unitsDiscount(1, 3, units));
      expect(discounts).toEqual([0, 0, 1, 1]);
    });

    test('同じ時刻に登録した商品は id の順に並べる（先の商品が 1 円、後の商品が 0 円）', async () => {
      // 小計が同じ2つの商品に割引 1 円: 足していった和 1000・2000 の R は 1・1 なので、割引は 1 − 0 = 1 円と 1 − 1 = 0 円
      const first = await createCatalogFixture(db(), { stock: 1 });
      const second = await createCatalogFixture(db(), { stock: 1 });
      const { orderId, orderItemIds } = await insertOrderWithLines(db(), {
        status: 'paid',
        discountAmount: 1,
        lines: [
          { itemId: first.itemId, variantId: first.variantId, quantity: 1, fulfillmentType: 'stock', itemPrice: 1000 },
          { itemId: second.itemId, variantId: second.variantId, quantity: 1, fulfillmentType: 'stock', itemPrice: 1000 },
        ],
      });

      // 明細は同じ取引で登録されるので登録時刻は同じ。uuid の並びは、小文字の16進の文字列の並びと同じ
      const [firstById, lastById] = [...orderItemIds].sort();
      expect(await lineDiscounts(orderId)).toEqual({ [firstById]: 1, [lastById]: 0 });
    });

    /** 単価が prices の商品（1点ずつ）を、この順に登録した注文。登録時刻を1秒ずつずらして、並びを決める */
    async function createOrderWithPrices(prices: number[], discountAmount: number) {
      const fx = await createCatalogFixture(db(), { stock: prices.length });
      const { orderId, orderItemIds } = await insertOrderWithLines(db(), {
        status: 'paid',
        discountAmount,
        lines: prices.map((price, index) => ({
          itemId: fx.itemId,
          variantId: fx.variantId,
          quantity: 1,
          fulfillmentType: 'stock' as const,
          itemPrice: price,
          createdAt: new Date(Date.UTC(2026, 9, 11, 0, 0, index + 1)).toISOString(),
        })),
      });
      return { orderId, orderItemIds };
    }

    /** 登録順の割引の並び */
    async function orderedDiscounts(orderId: string, orderItemIds: string[]): Promise<number[]> {
      const byItem = await lineDiscounts(orderId);
      return orderItemIds.map((id) => byItem[id]);
    }

    test('累積で丸める: 小計が同じ4つの商品に割引 2 円なら 1・0・1・0（どれも 0 以上で、和は 2）', async () => {
      // 足していった和 1000・2000・3000・4000 の R は 1・1・2・2。商品ごとに四捨五入して最後を残りにすると 1・1・1・−1 になる
      const { orderId, orderItemIds } = await createOrderWithPrices([1000, 1000, 1000, 1000], 2);

      const discounts = await orderedDiscounts(orderId, orderItemIds);

      expect(discounts).toEqual([1, 0, 1, 0]);
      expect(discounts.every((discount) => discount >= 0)).toBe(true);
      expect(discounts.reduce((sum, discount) => sum + discount, 0)).toBe(2);
    });

    test('累積で丸める: 小計が違う3つの商品（3000・1000・500）に割引 7 円なら 5・1・1', async () => {
      // 足していった和 3000・4000・4500（ΣL = 4500）の R は 5・6・7。商品ごとに四捨五入して最後を残りにすると 5・2・0 になる
      const { orderId, orderItemIds } = await createOrderWithPrices([3000, 1000, 500], 7);

      expect(await orderedDiscounts(orderId, orderItemIds)).toEqual([5, 1, 1]);
    });

    test('どの商品の割引も 0 以上で、和は必ず注文の割引（小計が同じ4つの商品、割引 0〜8 円）', async () => {
      for (const discountAmount of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        const { orderId, orderItemIds } = await createOrderWithPrices([1000, 1000, 1000, 1000], discountAmount);

        const discounts = await orderedDiscounts(orderId, orderItemIds);

        expect({ discountAmount, allNonNegative: discounts.every((discount) => discount >= 0) }).toEqual({
          discountAmount,
          allNonNegative: true,
        });
        expect({ discountAmount, sum: discounts.reduce((sum, discount) => sum + discount, 0) }).toEqual({
          discountAmount,
          sum: discountAmount,
        });
      }
    });

    test('返金の額の数え方: 受け取った額・成功・手続き中・返せる額・送料・返金した送料・返せる送料', async () => {
      const fx = await createCatalogFixture(db(), { stock: 2 });
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'paid',
        shippingAmount: 800,
        paidAmount: PRICE * 2 + 800,
        lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 2, fulfillmentType: 'stock' }],
      });
      // 数えるのは返事待ち・保留・成功だけ。失敗とエラーは数えない
      for (const [status, amount, shippingAmount] of [
        ['succeeded', 3000, 300],
        ['pending', 2000, 0],
        ['awaiting_response', 1000, 100],
        ['failed', 4000, 400],
        ['error', 500, 50],
      ] as const) {
        await insertRefundRecord(db(), { orderId, status, amount, shippingAmount });
      }

      const res = await db().query('select * from private.order_refund_amounts($1)', [orderId]);

      expect(res.rows).toEqual([
        {
          paid_amount: 10800,
          succeeded_amount: 3000,
          open_amount: 3000,
          refundable_amount: 4800,
          shipping_amount: 800,
          refunded_shipping: 400,
          refundable_shipping: 400,
        },
      ]);
    });

    test('受け取った額が空の注文は返せる額が 0、注文が無ければ 0 行', async () => {
      const fx = await createCatalogFixture(db(), { stock: 1 });
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'pending',
        shippingAmount: 500,
        lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 1, fulfillmentType: 'stock' }],
      });

      const res = await db().query('select * from private.order_refund_amounts($1)', [orderId]);

      expect(res.rows).toEqual([
        {
          paid_amount: null,
          succeeded_amount: 0,
          open_amount: 0,
          refundable_amount: 0,
          shipping_amount: 500,
          refunded_shipping: 0,
          refundable_shipping: 500,
        },
      ]);
      const none = await db().query('select * from private.order_refund_amounts($1)', [crypto.randomUUID()]);
      expect(none.rows).toEqual([]);
    });
  });

  describe('受け取った額', () => {
    const stockLine = (fx: { itemId: number; variantId: number }) => ({
      itemId: fx.itemId,
      variantId: fx.variantId,
      quantity: 1,
      fulfillmentType: 'stock' as const,
    });

    test('受け取った額が合計より多い注文は、返金済みの額を受け取った額まで書ける。超えると断る', async () => {
      const fx = await createCatalogFixture(db(), { stock: 1 });
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'paid',
        paidAmount: PRICE + 1000, // 合計は PRICE。支払額が違う注文
        lines: [stockLine(fx)],
      });

      await db().query('update public.orders set refunded_amount = $2 where id = $1', [orderId, PRICE + 1000]);
      await expectRejected(db(), 'update public.orders set refunded_amount = $2 where id = $1', [orderId, PRICE + 1001], OUT_OF_RANGE);
    });

    test('受け取った額が空か合計以下の注文は、今までどおり返金済みの額を合計まで', async () => {
      const fx = await createCatalogFixture(db(), { stock: 2 });
      const unknown = await insertOrderWithLines(db(), { status: 'paid', lines: [stockLine(fx)] });
      const less = await insertOrderWithLines(db(), { status: 'paid', paidAmount: PRICE - 1000, lines: [stockLine(fx)] });

      for (const { orderId } of [unknown, less]) {
        await db().query('update public.orders set refunded_amount = $2 where id = $1', [orderId, PRICE]);
        await expectRejected(db(), 'update public.orders set refunded_amount = $2 where id = $1', [orderId, PRICE + 1], OUT_OF_RANGE);
      }
    });

    test.each<[string, number, boolean]>([
      ['額が合う時', PRICE, true],
      ['額が合わない時', PRICE - 1, false],
    ])('入金済みにする関数は、%s も受け取った額を書く', async (_label, received, matches) => {
      const fx = await createCatalogFixture(db(), { stock: 1 });
      const { orderId } = await insertOrderWithLines(db(), { status: 'payment_in_progress', lines: [stockLine(fx)] });

      const res = await db().query(
        `select updated, amount_matches
         from public.mark_order_paid($1::uuid, 'payment_in_progress', $2::text, $3::integer, 'jpy', false, 'order_confirmed', null)`,
        [orderId, `pi_${uniqueSuffix()}`, received],
      );

      expect(res.rows[0]).toEqual({ updated: true, amount_matches: matches });
      const order = await db().query('select status::text as status, paid_amount from public.orders where id = $1', [orderId]);
      expect(order.rows[0]).toEqual({ status: 'paid', paid_amount: received });
    });
  });

  describe('在庫の履歴', () => {
    test('返金の番号が列 refund_id で返る（グループ E-3 で最後に return_id が付いたので、最後の2列は refund_id・return_id）', async () => {
      const { orderId, stockItemId, stockFx } = await createPaidOrder(db());
      const { refundId } = await insertRefundRecord(db(), { orderId });
      await db().query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id, refund_id)
         values ($1, 1, 'refund', $2, $3, $4)`,
        [stockFx.variantId, orderId, stockItemId, refundId],
      );

      const res = await db().query('select * from public.list_item_stock_history($1, 50)', [stockFx.itemId]);

      expect(res.rows.map((row) => [row.reason, row.refund_id])).toEqual([
        ['refund', refundId],
        ['purchase', null],
        ['restock', null],
      ]);
      expect(Object.keys(res.rows[0]).slice(-2)).toEqual(['refund_id', 'return_id']);
    });
  });

  describe('前からの写し', () => {
    test('会計の Stripe の返金の行から、状態を対応どおりに直した写しを作る。商品の行は無く、2回目は何もしない', async () => {
      const { orderId } = await createPaidOrder(db());
      // 作った額の大きい順。Stripe の状態の対応: pending・requires_action → 保留、succeeded → 成功、failed・canceled → 失敗。
      // 最後の1件は、カード以外の支払いの返金の番号（pyr_）。表の CHECK が re_ 以外も通すので、写せる（P29）
      const stripeRefunds = [
        { idPrefix: 're', status: 'succeeded', amount: 3000, reason: 'requested_by_customer', expected: 'succeeded' },
        { idPrefix: 're', status: 'requires_action', amount: 2000, reason: 'duplicate', expected: 'pending' },
        { idPrefix: 're', status: 'pending', amount: 1000, reason: null, expected: 'pending' },
        { idPrefix: 're', status: 'failed', amount: 500, reason: 'expired_uncaptured_charge', expected: 'failed' },
        { idPrefix: 'pyr', status: 'canceled', amount: 400, reason: null, expected: 'failed' },
      ];
      const suffix = uniqueSuffix();
      for (const [index, refund] of stripeRefunds.entries()) {
        await db().query(
          `insert into public.stripe_refunds
             (id, payment_intent_id, order_id, amount, currency, status, reason, stripe_created_at, succeeded_at, raw_payload)
           values ($1, 'pi_legacy', $2, $3, 'jpy', $4, $5, '2026-09-01T00:00:00Z', $6, '{}'::jsonb)`,
          [
            `${refund.idPrefix}_${suffix}${index}`,
            orderId,
            refund.amount,
            refund.status,
            refund.reason,
            refund.status === 'succeeded' ? '2026-09-02T00:00:00Z' : null,
          ],
        );
      }

      const created = await db().query('select private.backfill_legacy_order_refunds() as created');
      expect(Number(created.rows[0].created)).toBeGreaterThanOrEqual(stripeRefunds.length);

      const copies = await db().query(
        `select stripe_refund_id, amount, status, stripe_status, source, notify_customer, request_key, actor_id, adjustment_amount,
                shipping_amount, stripe_reason, stock_applied_at, email_enqueued_at, failure_applied_at is not null as failure_applied
         from public.order_refunds where order_id = $1 order by amount desc`,
        [orderId],
      );
      expect(copies.rows).toEqual(
        stripeRefunds.map((refund, index) => ({
          stripe_refund_id: `${refund.idPrefix}_${suffix}${index}`,
          amount: refund.amount,
          status: refund.expected,
          stripe_status: refund.status,
          source: 'legacy',
          notify_customer: false,
          request_key: null,
          actor_id: null,
          adjustment_amount: refund.amount,
          shipping_amount: 0,
          stripe_reason: refund.reason === 'expired_uncaptured_charge' ? null : refund.reason,
          stock_applied_at: null,
          email_enqueued_at: null,
          failure_applied: refund.expected === 'failed',
        })),
      );
      const lines = await db().query(
        'select count(*)::int as n from public.order_refund_lines where refund_id in (select id from public.order_refunds where order_id = $1)',
        [orderId],
      );
      expect(lines.rows[0].n).toBe(0);

      const again = await db().query('select private.backfill_legacy_order_refunds() as created');
      expect(Number(again.rows[0].created)).toBe(0);
      const total = await db().query('select count(*)::int as n from public.order_refunds where order_id = $1', [orderId]);
      expect(total.rows[0].n).toBe(stripeRefunds.length);
    });

    test('受け取った額は、支払いの番号がある入金済み・発送済みと、返金済みの額があるキャンセルの注文にだけ、合計と同じ額で書く', async () => {
      const fx = await createCatalogFixture(db(), { stock: 10 });
      const lines = [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 1, fulfillmentType: 'stock' as const }];
      const shipped = { carrier: 'yamato' as const, trackingNumber: 'YM-1' };
      const pi = () => `pi_${uniqueSuffix()}`;
      const cases: Array<[string, Awaited<ReturnType<typeof insertOrderWithLines>>, number | null]> = [
        ['入金済み', await insertOrderWithLines(db(), { status: 'paid', paymentIntentId: pi(), lines }), PRICE],
        ['発送済み', await insertOrderWithLines(db(), { status: 'shipped', shipped, paymentIntentId: pi(), lines }), PRICE],
        ['返金済みの額があるキャンセル', await insertOrderWithLines(db(), { status: 'cancelled', paymentIntentId: pi(), refundedAmount: PRICE, lines }), PRICE],
        ['返金の無いキャンセル', await insertOrderWithLines(db(), { status: 'cancelled', paymentIntentId: pi(), lines }), null],
        ['未入金', await insertOrderWithLines(db(), { status: 'pending', paymentIntentId: pi(), lines }), null],
        ['支払いの番号が無い入金済み', await insertOrderWithLines(db(), { status: 'paid', lines }), null],
        ['すでに額がある入金済みは書き換えない', await insertOrderWithLines(db(), { status: 'paid', paymentIntentId: pi(), paidAmount: PRICE - 1000, lines }), PRICE - 1000],
      ];
      const readPaidAmounts = async () => {
        const res = await db().query('select id, paid_amount from public.orders where id = any($1::uuid[])', [
          cases.map(([, order]) => order.orderId),
        ]);
        return Object.fromEntries(res.rows.map((row) => [row.id as string, row.paid_amount as number | null]));
      };

      await db().query('select private.backfill_legacy_order_refunds()');
      const first = await readPaidAmounts();
      for (const [label, order, expected] of cases) {
        expect({ label, paid: first[order.orderId] }).toEqual({ label, paid: expected });
      }

      // 2回目は何も変えない
      await db().query('select private.backfill_legacy_order_refunds()');
      expect(await readPaidAmounts()).toEqual(first);
    });
  });

  describe('ショップの設定・切り替えの時刻・権限の行', () => {
    test('ショップの設定は1行だけで、最初は ①取り消した注文への入金の自動の返金がオン・②支払額の違いの自動の取消がオフ', async () => {
      const res = await db().query('select * from public.shop_settings');

      expect(res.rows).toEqual([
        {
          id: 1,
          auto_refund_cancelled_order_payment: true,
          auto_refund_cancelled_order_payment_updated_by: null,
          auto_refund_cancelled_order_payment_updated_at: null,
          auto_cancel_amount_mismatch: false,
          auto_cancel_amount_mismatch_updated_by: null,
          auto_cancel_amount_mismatch_updated_at: null,
          delivery_tracking_enabled: false,
          delivery_tracking_updated_at: null,
          delivery_tracking_updated_by: null,
        },
      ]);
      await expectRejected(db(), 'insert into public.shop_settings (id) values (2)', [], { code: '23514' });
      await expectRejected(db(), 'insert into public.shop_settings (id) values (1)', [], { code: '23505' });
    });

    test('切り替えの時刻の行が1行あり、移行を当てた時刻が入っている（Review Focus 5）', async () => {
      const res = await db().query('select id, started_at, started_at <= now() as in_past from private.refund_ledger_state');

      expect(res.rows).toEqual([{ id: 1, started_at: expect.any(Date), in_past: true }]);
      await expectRejected(db(), 'insert into private.refund_ledger_state (id, started_at) values (2, now())', [], { code: '23514' });
    });

    test('権限の行 admin.orders.refund・admin.settings.manage がある。移行の「店長に付ける文」は、店長の役割だけに付け、何度流しても同じ', async () => {
      const permissions = await db().query(
        "select code, name from public.permissions where code in ('admin.orders.refund', 'admin.settings.manage') order by code",
      );
      expect(permissions.rows).toEqual([
        { code: 'admin.orders.refund', name: '注文の返金' },
        { code: 'admin.settings.manage', name: 'ショップの設定' },
      ]);

      // 手元の DB には店長の役割の行が無い（本番にはある）ので、役割をこの取引の中だけ作ってから、移行の中の文をそのまま流す。
      // 版の頭の数字は本番に当てる時に付け替わるので、移行のファイルは名前の後ろで探す
      await db().query("insert into public.roles (code, name) values ('admin', '店長') on conflict (code) do nothing");
      const directory = path.join(process.cwd(), 'supabase/migrations');
      const files = fs.readdirSync(directory).filter((name) => name.endsWith('_order_refund_records.sql'));
      expect(files).toHaveLength(1);
      const migration = fs.readFileSync(path.join(directory, files[0]), 'utf8');
      const linkStatement = migration.match(/INSERT INTO public\.role_permissions[\s\S]*?ON CONFLICT DO NOTHING;/)?.[0];
      expect(linkStatement).toBeDefined();
      await db().query(linkStatement as string);
      await db().query(linkStatement as string);

      const linked = await db().query(
        `select r.code as role_code, p.code as permission_code
         from public.role_permissions as rp
         join public.roles as r on r.id = rp.role_id
         join public.permissions as p on p.id = rp.permission_id
         where p.code in ('admin.orders.refund', 'admin.settings.manage')
         order by r.code, p.code`,
      );
      expect(linked.rows).toEqual([
        { role_code: 'admin', permission_code: 'admin.orders.refund' },
        { role_code: 'admin', permission_code: 'admin.settings.manage' },
      ]);
    });
  });

  describe('権限', () => {
    test('作り直した public の関数を実行できるのは service_role だけ。private の関数は service_role も実行できない', async () => {
      for (const fn of [
        'public.list_order_line_fulfillment(uuid[])',
        'public.list_item_stock_history(bigint, integer)',
        'public.mark_order_paid(uuid, public.order_status, text, integer, text, boolean, text, text)',
      ]) {
        const res = await db().query(
          `select has_function_privilege('anon', $1, 'execute') as anon,
                  has_function_privilege('authenticated', $1, 'execute') as authed,
                  has_function_privilege('service_role', $1, 'execute') as service`,
          [fn],
        );
        expect(res.rows[0]).toEqual({ anon: false, authed: false, service: true });
      }
      for (const fn of [
        'private.guard_order_refund_change()',
        'private.guard_order_refund_line_change()',
        'private.check_refund_line_order()',
        'private.check_order_line_fulfillment_bounds()',
        'private.order_line_fulfillment(uuid)',
        'private.order_line_reservations(uuid)',
        'private.order_line_discounts(uuid)',
        'private.refund_units_discount(integer, integer, integer)',
        'private.order_refund_amounts(uuid)',
        'private.backfill_legacy_order_refunds()',
      ]) {
        const res = await db().query("select has_function_privilege('service_role', $1, 'execute') as service", [fn]);
        expect({ fn, service: res.rows[0].service }).toEqual({ fn, service: false });
      }
    });
  });
});

describeLocalDb('E-3: 交換の行の割引と人気と返金の支払額',db=>{
  beforeEach(async()=>{await db().query('begin');});
  afterEach(async()=>{await db().query('rollback');});
  test('交換のゼロ円の行を割引と人気から外し、元の支払額14999を5000・4999・5000に割る',async()=>{
    const cat=await createCatalogFixture(db(),{stock:10});
    const order=await insertOrderWithLines(db(),{status:'paid',discountAmount:1,paidAmount:14999,
      lines:[{itemId:cat.itemId,variantId:cat.variantId,quantity:3,fulfillmentType:'stock'}]});
    const ship=(await db().query(`insert into public.order_fulfillments(order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order)
      values($1,1,gen_random_uuid(),'yamato','TEST-4',false,true) returning id`,[order.orderId])).rows[0].id;
    await db().query('insert into public.order_fulfillment_lines(fulfillment_id,order_item_id,quantity) values($1,$2,3)',[ship,order.orderItemIds[0]]);
    const ret=(await db().query(`insert into public.order_returns(order_id,number,source,status,request_key,request_fingerprint,return_method,return_shipping_payer,notify_customer)
      values($1,1,'shop','open',gen_random_uuid(),'fixture','customer_ships','customer',false) returning id`,[order.orderId])).rows[0].id;
    const rl=(await db().query(`insert into public.order_return_lines(return_id,fulfillment_id,order_item_id,quantity,reason,resolution,exchange_variant_id,exchange_method)
      values($1,$2,$3,3,'unknown','exchange',$4,'make') returning id`,[ret,ship,order.orderItemIds[0],cat.variantId])).rows[0].id;
    const ex=(await db().query(`insert into public.order_items(order_id,item_id,variant_id,item_name,item_price,quantity,line_total,fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
      values($1,$2,$3,'交換の品',0,3,0,'backorder','exchange',$4,14999) returning id`,[order.orderId,cat.itemId,cat.variantId,rl])).rows[0].id;
    const discount=await db().query('select * from private.order_line_discounts($1) order by order_item_id',[order.orderId]);
    expect(discount.rows).toEqual(expect.arrayContaining([{order_item_id:order.orderItemIds[0],line_discount:1},{order_item_id:ex,line_discount:0}]));
    expect(discount.rows).toHaveLength(2);
    const materials=(await db().query('select * from public.load_order_refund_materials($1)',[order.orderId])).rows[0];
    expect(materials.lines.find((line:Row)=>line.order_item_id===ex).exchange_paid_amount).toBe(14999);
    expect(materials.lines.find((line:Row)=>line.order_item_id===order.orderItemIds[0]).exchange_paid_amount).toBeNull();
    const popular=await db().query('select purchase_count from public.get_popular_items(100000) where id=$1',[cat.itemId]);
    expect(Number(popular.rows[0].purchase_count)).toBe(3);
    expect((await db().query('select private.return_units_amount($1,1,0) amount',[ex])).rows[0].amount).toBe(5000);
    expect((await db().query('select private.return_units_amount($1,1,1) amount',[ex])).rows[0].amount).toBe(4999);
    expect((await db().query('select private.return_units_amount($1,1,2) amount',[ex])).rows[0].amount).toBe(5000);
    expect((await db().query('select private.return_units_amount($1,3,0) amount',[ex])).rows[0].amount).toBe(14999);
  });
});
