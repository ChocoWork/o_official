/** @jest-environment node */
import { cancelDeliveryFixture } from './helpers/delivery-tracking-fixtures';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, shipFixtureOrder, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 発送の関数と発送ごとの発送のメール（グループ E-1 設計書 6・7・8 章、移行 B）。
 * G-1 Task 14: 旧の発送・発送取消の関数（admin_create_fulfillment・admin_cancel_fulfillment）と手動の仕上がりは止まった。
 * 旧の関数は引数・lock・参照・再送の判定より先に LEGACY_FULFILLMENT_DISABLED / 55000（仕上がりは
 * MANUAL_COMPLETION_DISABLED / 55000）で断り、発送・メール・割当・履歴を何も変えない。発送の業務は G-3 の新しい発送票で再開する。
 * 発送のメールの試験（予定・取り出し・履歴・再送・取りやめ）は、G-1 の割当を消費する合成の発送（shipFixtureOrder・
 * cancelDeliveryFixture）を材料にして、今の契約を確かめる。
 * 注文のメールの取り出しは表全体から古い順に選ぶので、1件ごとに取引の中で注文のメールの表を空にし、終わったら戻す。
 * 同時の呼出しだけは2つの接続が要るので、別の describe で確定した行を使う（消せない注文が手元の DB に残る）。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

const LEGACY_DISABLED = { code: '55000', message: 'LEGACY_FULFILLMENT_DISABLED' };
const COMPLETION_DISABLED = { code: '55000', message: 'MANUAL_COMPLETION_DISABLED' };

async function createActor(db: PgClient): Promise<{ id: string; email: string }> {
  const email = `fulfillment-email-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

/** 在庫の品（2つ確保済み）と受注生産の品（3つ）の注文 */
async function createMixedOrder(db: PgClient, status = 'paid') {
  const stockFx = await createCatalogFixture(db, { stock: 5 });
  const madeFx = await createCatalogFixture(db, { stock: 0 });
  const { orderId, orderItemIds } = await insertOrderWithLines(db, {
    status,
    lines: [
      { itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 2, fulfillmentType: 'stock' },
      { itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 3, fulfillmentType: 'backorder' },
    ],
  });
  return { orderId, stockItemId: orderItemIds[0], madeItemId: orderItemIds[1] };
}

/** 住所が空の、在庫の品1つの入金済みの注文（配送先は後から直せないので、作る時に欠かす） */
async function createOrderWithoutAddress(db: PgClient): Promise<{ orderId: string; orderItemId: string }> {
  const fx = await createCatalogFixture(db, { stock: 1 });
  const suffix = uniqueSuffix();
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, payment_intent_id, status, subtotal_amount, shipping_amount, total_amount, currency,
        shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address,
        shipping_phone)
     values ($1, $2, null, 'paid', 5000, 0, 5000, 'jpy',
             'fixture@example.com', '山田 花子', '1500001', '東京都', '渋谷区', null, '0311112222')
     returning id`,
    [`fx-order-${suffix}`, `cs_fx_${suffix}`],
  );
  const orderId = order.rows[0].id as string;
  const line = await db.query(
    `insert into public.order_items
       (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type)
     values ($1, $2, '照合テスト', 5000, 'BLACK', 'M', 1, 5000, $3, 'stock')
     returning id`,
    [orderId, fx.itemId, fx.variantId],
  );
  return { orderId, orderItemId: line.rows[0].id as string };
}

type ShipInput = {
  requestKey?: string;
  carrier?: string | null;
  tracking?: string | null;
  notify?: boolean | null;
  lines: unknown;
};

const SHIP_SQL = 'select * from public.admin_create_fulfillment($1, $2, $3, $4, $5, $6, $7::jsonb)';
const CANCEL_SQL = 'select * from public.admin_cancel_fulfillment($1, $2, $3)';
const COMPLETION_SQL = 'select * from public.admin_record_completion($1, $2, $3, $4::jsonb)';

function shipParams(orderId: string | null, actorId: string | null, input: ShipInput): unknown[] {
  return [
    orderId,
    actorId,
    input.requestKey === undefined ? crypto.randomUUID() : input.requestKey,
    input.carrier === undefined ? 'yamato' : input.carrier,
    input.tracking === undefined ? '1234-5678-9012' : input.tracking,
    input.notify === undefined ? true : input.notify,
    JSON.stringify(input.lines),
  ];
}

/** 発送の材料（G-1 の割当を消費する合成の発送）。旧の関数の既定どおり通知はオン。戻り値の形は旧の関数と同じ */
async function ship(db: PgClient, orderId: string, actorId: string, input: ShipInput) {
  const row = await shipFixtureOrder(db, {
    orderId,
    actorId,
    requestKey: input.requestKey,
    carrier: (input.carrier ?? 'yamato') as 'yamato' | 'sagawa' | 'japanpost',
    trackingNumber: input.tracking ?? '1234-5678-9012',
    notifyCustomer: input.notify ?? true,
    lines: input.lines as Array<{ order_item_id: string; quantity: number }>,
  });
  return { rows: [row] };
}

/** 発送の取消の材料（合成）。旧の admin_cancel_fulfillment は止まっている */
function cancelFulfillment(db: PgClient, orderId: string, fulfillmentId: string, actorId: string) {
  return cancelDeliveryFixture(db, { orderId, fulfillmentId, actorId });
}

async function orderShipping(db: PgClient, orderId: string): Promise<Row> {
  const res = await db.query(
    'select status::text as status, shipped_at, shipping_carrier, tracking_number from public.orders where id = $1',
    [orderId],
  );
  return res.rows[0];
}

async function shippedEmails(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query(
    `select fulfillment_id, origin, status, last_error_code from private.order_email_outbox
     where order_id = $1 and kind = 'shipped' order by seq`,
    [orderId],
  );
  return res.rows;
}

async function lineCounts(db: PgClient, orderId: string): Promise<Record<string, Row>> {
  const res = await db.query('select * from private.order_line_fulfillment($1)', [orderId]);
  return Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row]));
}

async function markOrderEmailsSent(db: PgClient, orderId: string): Promise<void> {
  await db.query(
    "update private.order_email_outbox set status = 'sent', sent_at = now(), finished_at = now() where order_id = $1",
    [orderId],
  );
}

/**
 * 止めた関数が何も変えないことを見るための写し: 注文・発送・発送の明細・メール・割当・割当の履歴・品物の状態の履歴・
 * 操作の受付・注文の改訂・仕上がり・台帳。
 */
async function orderSnapshot(db: PgClient, orderId: string): Promise<Row> {
  const res = await db.query(
    `select
       (select row_to_json(o) from (select status, shipped_at, shipping_carrier, tracking_number from public.orders where id = $1) o) as orders,
       (select coalesce(json_agg(row_to_json(f) order by f.id), '[]') from public.order_fulfillments f where f.order_id = $1) as fulfillments,
       (select count(*)::int from public.order_fulfillment_lines l join public.order_fulfillments f on f.id = l.fulfillment_id
         where f.order_id = $1) as fulfillment_lines,
       (select coalesce(json_agg(row_to_json(e) order by e.seq), '[]') from (select seq, kind, status, fulfillment_id
         from private.order_email_outbox where order_id = $1) e) as emails,
       (select coalesce(json_agg(row_to_json(a) order by a.id), '[]') from (select a.id, a.remaining_quantity, a.kind, a.version
         from public.order_item_allocations a join public.order_items i on i.id = a.order_item_id where i.order_id = $1) a) as allocations,
       (select count(*)::int from public.order_item_allocation_events e join public.order_item_allocations a on a.id = e.allocation_id
         join public.order_items i on i.id = a.order_item_id where i.order_id = $1) as allocation_events,
       (select count(*)::int from public.order_item_state_events e join public.order_items i on i.id = e.order_item_id
         where i.order_id = $1) as state_events,
       (select count(*)::int from private.group_g_operations) as operations,
       (select count(*)::int from public.order_revisions where order_id = $1) as revisions,
       (select count(*)::int from public.order_item_completions where order_id = $1) as completions,
       (select count(*)::int from public.stock_movements where order_id = $1) as movements`,
    [orderId],
  );
  return res.rows[0];
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

/** 止めた関数を呼び、固定の拒否と、注文の何も変わらないことを確かめる */
async function expectStopped(db: PgClient, orderId: string, sql: string, params: unknown[], match = LEGACY_DISABLED) {
  const before = await orderSnapshot(db, orderId);
  await expectRejected(db, sql, params, match);
  expect(await orderSnapshot(db, orderId)).toEqual(before);
}

describeLocalDb('integration: 発送の関数と発送ごとのメール（移行 B）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('delete from private.order_email_outbox');
    await db().query('update private.order_email_send_pause set paused = false, reason = null, paused_at = null, next_probe_at = null');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('発送する（G-1 で停止）', () => {
    test('旧の発送の関数は止まり（LEGACY_FULFILLMENT_DISABLED）、発送もメールも作らず、数も割当も変わらない', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const countsBefore = await lineCounts(db(), orderId);

      await expectStopped(db(), orderId, SHIP_SQL, shipParams(orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] }));

      expect(await orderShipping(db(), orderId)).toEqual({
        status: 'paid', shipped_at: null, shipping_carrier: null, tracking_number: null,
      });
      expect(await lineCounts(db(), orderId)).toEqual(countsBefore);
      expect(countsBefore[stockItemId]).toMatchObject({ shipped: 0, ready_unshipped: 2, unshipped: 2 });
      expect(countsBefore[madeItemId]).toMatchObject({ shipped: 0, in_production: 3, unshipped: 3 });
      expect(await shippedEmails(db(), orderId)).toEqual([]);
    });

    test('仕上がりの記録も発送も止まり、注文は決済完了のまま。注文の改訂も増えない', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());

      await expectStopped(db(), orderId, COMPLETION_SQL,
        [orderId, actor.id, crypto.randomUUID(), JSON.stringify([{ order_item_id: madeItemId, quantity: 3 }])], COMPLETION_DISABLED);
      await expectStopped(db(), orderId, SHIP_SQL, shipParams(orderId, actor.id, {
        carrier: 'sagawa', tracking: 'SG-2', notify: false,
        lines: [{ order_item_id: stockItemId, quantity: 2 }, { order_item_id: madeItemId, quantity: 3 }],
      }));

      expect((await orderShipping(db(), orderId)).status).toBe('paid');
      const revision = await db().query("select count(*)::int as n from public.order_revisions where order_id = $1", [orderId]);
      expect(revision.rows[0].n).toBe(0);
    });

    test('同じ番号の送り直しも、再送の判定より先に断る（発送もメールも増えない）', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const input = { requestKey: crypto.randomUUID(), lines: [{ order_item_id: stockItemId, quantity: 2 }] };

      await expectStopped(db(), orderId, SHIP_SQL, shipParams(orderId, actor.id, input));
      await expectStopped(db(), orderId, SHIP_SQL, shipParams(orderId, actor.id, input));

      const count = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [orderId]);
      expect(count.rows[0].n).toBe(0);
      expect(await shippedEmails(db(), orderId)).toHaveLength(0);
    });

    test('前に合成で送った番号でも、中身が違っても、固定の拒否だけを返す（FULFILLMENT_REQUEST_MISMATCH に落ちない）', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const requestKey = crypto.randomUUID();
      const line = [{ order_item_id: stockItemId, quantity: 1 }];
      await ship(db(), orderId, actor.id, { requestKey, lines: line });

      const changed: Array<[string, ShipInput]> = [
        [orderId, { requestKey, lines: line }],
        [orderId, { requestKey, tracking: '9999-0000', lines: line }],
        [orderId, { requestKey, carrier: 'sagawa', lines: line }],
        [orderId, { requestKey, notify: false, lines: line }],
        [orderId, { requestKey, lines: [{ order_item_id: stockItemId, quantity: 2 }] }],
        [other.orderId, { requestKey, lines: [{ order_item_id: other.stockItemId, quantity: 1 }] }],
      ];
      for (const [target, input] of changed) {
        await expectStopped(db(), target, SHIP_SQL, shipParams(target, actor.id, input));
      }
    });

    test('発送準備中を超える数・注文に無い商品も、固定の拒否だけを返し、数は変わらない', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());

      for (const lines of [
        [{ order_item_id: madeItemId, quantity: 1 }],
        [{ order_item_id: stockItemId, quantity: 3 }],
        [{ order_item_id: other.stockItemId, quantity: 1 }],
      ]) {
        await expectStopped(db(), orderId, SHIP_SQL, shipParams(orderId, actor.id, { lines }));
      }
      expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 0, ready_unshipped: 2 });
    });

    test('決済完了でない・配送先が足りない・支払額の確かめが残る・無い注文も、固定の拒否だけを返す', async () => {
      const actor = await createActor(db());
      const pending = await createMixedOrder(db(), 'pending');
      await expectStopped(db(), pending.orderId, SHIP_SQL,
        shipParams(pending.orderId, actor.id, { lines: [{ order_item_id: pending.stockItemId, quantity: 1 }] }));

      const noAddress = await createOrderWithoutAddress(db());
      await expectStopped(db(), noAddress.orderId, SHIP_SQL,
        shipParams(noAddress.orderId, actor.id, { lines: [{ order_item_id: noAddress.orderItemId, quantity: 1 }] }));

      const review = await createMixedOrder(db());
      await db().query(
        "select exception_id from public.record_payment_exception($1::text, 'paid_amount_mismatch', null::text, $1::text, null, null, $2::uuid)",
        [`cs_review_${uniqueSuffix()}`, review.orderId],
      );
      await expectStopped(db(), review.orderId, SHIP_SQL,
        shipParams(review.orderId, actor.id, { lines: [{ order_item_id: review.stockItemId, quantity: 1 }] }));

      await expectRejected(db(), SHIP_SQL,
        shipParams(crypto.randomUUID(), actor.id, { lines: [{ order_item_id: review.stockItemId, quantity: 1 }] }), LEGACY_DISABLED);
    });

    test('引数の誤り・空の値も、検証より先に固定の拒否を返す', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const line = [{ order_item_id: stockItemId, quantity: 1 }];
      const bad: Array<[string | null, string | null, ShipInput]> = [
        [null, actor.id, { lines: line }],
        [orderId, null, { lines: line }],
        [orderId, actor.id, { carrier: 'fedex', lines: line }],
        [orderId, actor.id, { carrier: null, lines: line }],
        [orderId, actor.id, { tracking: '12 34', lines: line }],
        [orderId, actor.id, { tracking: 'x'.repeat(65), lines: line }],
        [orderId, actor.id, { tracking: null, lines: line }],
        [orderId, actor.id, { notify: null, lines: line }],
        [orderId, actor.id, { lines: [] }],
        [orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 0 }] }],
        [orderId, actor.id, { requestKey: null as unknown as string, lines: line }],
      ];
      for (const [target, actorId, input] of bad) {
        await expectStopped(db(), orderId, SHIP_SQL, shipParams(target, actorId, input));
      }
      await expectRejected(db(), SHIP_SQL, [null, null, null, null, null, null, null], LEGACY_DISABLED);
    });
  });

  describe('発送の取消（G-1 で停止）', () => {
    test('全部を送った注文でも旧の取消は止まり、発送・注文の状態・メールはそのまま', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });
      await ship(db(), orderId, actor.id, { notify: false, lines: [{ order_item_id: madeItemId, quantity: 3 }] });
      const firstId = first.rows[0].fulfillment_id as string;
      expect((await orderShipping(db(), orderId)).status).toBe('shipped');

      await expectStopped(db(), orderId, CANCEL_SQL, [orderId, firstId, actor.id]);
      await expectStopped(db(), orderId, CANCEL_SQL, [orderId, firstId, actor.id]);

      expect((await orderShipping(db(), orderId)).status).toBe('shipped');
      const row = await db().query('select cancelled_at, cancelled_by from public.order_fulfillments where id = $1', [firstId]);
      expect(row.rows).toEqual([{ cancelled_at: null, cancelled_by: null }]);
      expect(await shippedEmails(db(), orderId)).toEqual([
        expect.objectContaining({ fulfillment_id: firstId, status: 'pending', last_error_code: null }),
      ]);
    });

    test('一部の発送の取消も止まり、送ったメールも、やり直し待ちのメールもそのまま', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const second = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const firstId = first.rows[0].fulfillment_id as string;
      const secondId = second.rows[0].fulfillment_id as string;
      await db().query(
        "update private.order_email_outbox set status = 'sent', sent_at = now(), finished_at = now() where fulfillment_id = $1",
        [firstId],
      );
      await db().query(
        `update private.order_email_outbox
         set status = 'retry_wait', attempts = 1, next_attempt_at = now() + interval '1 minute'
         where fulfillment_id = $1`,
        [secondId],
      );

      await expectStopped(db(), orderId, CANCEL_SQL, [orderId, firstId, actor.id]);
      await expectStopped(db(), orderId, CANCEL_SQL, [orderId, secondId, actor.id]);

      expect(await shippedEmails(db(), orderId)).toEqual([
        expect.objectContaining({ fulfillment_id: firstId, status: 'sent', last_error_code: null }),
        expect.objectContaining({ fulfillment_id: secondId, status: 'retry_wait', last_error_code: null }),
      ]);
      expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 2, ready_unshipped: 0 });
    });

    test('送っている途中の発送のメールは残し、取り消した発送なら worker が取消を見て取りやめる（Review Focus 3）', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const shipped = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });
      const fulfillmentId = shipped.rows[0].fulfillment_id as string;
      const claimed = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      expect(claimed).toMatchObject({ order_id: orderId, kind: 'shipped', fulfillment_id: fulfillmentId });

      // 旧の取消は止まっているので、メールは送っている途中のまま
      await expectStopped(db(), orderId, CANCEL_SQL, [orderId, fulfillmentId, actor.id]);
      expect(await shippedEmails(db(), orderId)).toEqual([expect.objectContaining({ status: 'sending' })]);

      // 取消（合成の材料）の後は、worker が取消を見て取りやめる
      await cancelFulfillment(db(), orderId, fulfillmentId, actor.id);
      expect(await shippedEmails(db(), orderId)).toEqual([expect.objectContaining({ status: 'sending' })]);
      const skipped = await db().query('select public.skip_order_email($1, $2, $3) as skipped', [
        claimed.email_id, claimed.lease_token, 'fulfillment_cancelled',
      ]);
      expect(skipped.rows[0].skipped).toBe(true);
      expect(await shippedEmails(db(), orderId)).toEqual([
        expect.objectContaining({ status: 'skipped', last_error_code: 'fulfillment_cancelled' }),
      ]);
    });

    test('ほかの注文の発送・無い注文・空の実行者・取り消せない注文も、固定の拒否だけを返す', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const shipped = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const fulfillmentId = shipped.rows[0].fulfillment_id as string;

      await expectStopped(db(), other.orderId, CANCEL_SQL, [other.orderId, fulfillmentId, actor.id]);
      await expectRejected(db(), CANCEL_SQL, [crypto.randomUUID(), fulfillmentId, actor.id], LEGACY_DISABLED);
      await expectStopped(db(), orderId, CANCEL_SQL, [orderId, fulfillmentId, null]);
      await expectRejected(db(), CANCEL_SQL, [null, null, null], LEGACY_DISABLED);
    });
  });

  describe('発送のメール', () => {
    test('予定を書く関数: 発送のメールは発送の番号が要り、ほかの種類は持たない。同じ発送の自動の行は1行', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const shipped = await ship(db(), orderId, actor.id, { notify: false, lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const fulfillmentId = shipped.rows[0].fulfillment_id as string;
      const sql = 'select private.enqueue_order_email($1, $2, $3, $4) as inserted';

      await expectRejected(db(), sql, [orderId, 'shipped', null, null], {
        code: '23514', constraint: 'order_email_outbox_fulfillment_check',
      });
      await expectRejected(db(), sql, [orderId, 'paid', 'order_confirmed', fulfillmentId], {
        code: '23514', constraint: 'order_email_outbox_fulfillment_check',
      });
      expect((await db().query(sql, [orderId, 'shipped', null, fulfillmentId])).rows[0].inserted).toBe(true);
      expect((await db().query(sql, [orderId, 'shipped', null, fulfillmentId])).rows[0].inserted).toBe(false);
      // ほかの種類は今のまま1注文1種類1行。3つの引数の呼び方（グループ D の関数が使う）もそのまま使える
      const legacyCall = 'select private.enqueue_order_email($1, $2, $3) as inserted';
      expect((await db().query(legacyCall, [orderId, 'paid', 'order_confirmed'])).rows[0].inserted).toBe(true);
      expect((await db().query(legacyCall, [orderId, 'paid', 'payment_received'])).rows[0].inserted).toBe(false);
    });

    test('取り出しと履歴は、発送の番号と何回目かを返す', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const second = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });

      const claimed = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      expect(claimed).toMatchObject({ order_id: orderId, kind: 'shipped', fulfillment_id: first.rows[0].fulfillment_id });

      const history = await db().query(
        'select kind, fulfillment_id, fulfillment_number from public.list_order_email_history($1)',
        [orderId],
      );
      expect(history.rows).toEqual([
        { kind: 'shipped', fulfillment_id: second.rows[0].fulfillment_id, fulfillment_number: 2 },
        { kind: 'shipped', fulfillment_id: first.rows[0].fulfillment_id, fulfillment_number: 1 },
      ]);
    });
  });

  describe('再送', () => {
    test('発送のメールの再送は発送ごと。一部だけ送った決済完了の注文でもでき、同じ発送の送信待ちは1行', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const second = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      await markOrderEmailsSent(db(), orderId);
      const sql = 'select public.request_order_email_resend($1, $2, $3, $4) as email_id';

      const resent = await db().query(sql, [orderId, 'shipped', actor.id, first.rows[0].fulfillment_id]);

      const row = await db().query(
        'select kind, origin, status, fulfillment_id, requested_by from private.order_email_outbox where id = $1',
        [resent.rows[0].email_id],
      );
      expect(row.rows).toEqual([{
        kind: 'shipped', origin: 'manual', status: 'pending', fulfillment_id: first.rows[0].fulfillment_id, requested_by: actor.id,
      }]);
      // 別の発送の再送は同時に待てる。同じ発送の2回目は断る
      await expect(db().query(sql, [orderId, 'shipped', actor.id, second.rows[0].fulfillment_id])).resolves.toBeTruthy();
      await expectRejected(db(), sql, [orderId, 'shipped', actor.id, first.rows[0].fulfillment_id], {
        code: '23505', message: 'RESEND_ALREADY_QUEUED',
      });
    });

    test('発送の番号が無い・ほかの注文の発送・取り消した発送・発送のメール以外への番号は断る', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const kept = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const dropped = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const foreign = await ship(db(), other.orderId, actor.id, { lines: [{ order_item_id: other.stockItemId, quantity: 1 }] });
      await db().query('select private.enqueue_order_email($1, $2, $3)', [orderId, 'paid', 'order_confirmed']);
      await markOrderEmailsSent(db(), orderId);
      await markOrderEmailsSent(db(), other.orderId);
      await cancelFulfillment(db(), orderId, dropped.rows[0].fulfillment_id, actor.id);
      const sql = 'select public.request_order_email_resend($1, $2, $3, $4)';

      await expectRejected(db(), sql, [orderId, 'shipped', actor.id, null], { code: '22023', message: 'RESEND_FULFILLMENT_REQUIRED' });
      await expectRejected(db(), sql, [orderId, 'shipped', actor.id, foreign.rows[0].fulfillment_id], {
        code: '22023', message: 'RESEND_NOT_ALLOWED',
      });
      await expectRejected(db(), sql, [orderId, 'shipped', actor.id, dropped.rows[0].fulfillment_id], {
        code: '22023', message: 'RESEND_NOT_ALLOWED',
      });
      await expectRejected(db(), sql, [orderId, 'paid', actor.id, kept.rows[0].fulfillment_id], {
        code: '22023', message: 'RESEND_NOT_ALLOWED',
      });
      await expect(db().query(sql, [orderId, 'paid', actor.id, null])).resolves.toBeTruthy();
    });
  });

  describe('取りやめ', () => {
    test('発送の取消による取りやめは、取り消した発送の発送のメールだけ', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });
      const claimed = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      const sql = 'select public.skip_order_email($1, $2, $3)';

      // 取り消していない発送のメールは、この理由で取りやめない
      await expectRejected(db(), sql, [claimed.email_id, claimed.lease_token, 'fulfillment_cancelled'], {
        code: '22023', message: 'SKIP_REASON_NOT_ALLOWED',
      });
      await expectRejected(db(), sql, [claimed.email_id, claimed.lease_token, 'other'], { code: '22023', message: 'INVALID_SKIP_REASON' });

      // 発送のメール以外も、この理由で取りやめない
      await db().query('select public.complete_order_email($1, $2, null)', [claimed.email_id, claimed.lease_token]);
      await db().query('select private.enqueue_order_email($1, $2, $3)', [orderId, 'paid', 'order_confirmed']);
      const paid = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      expect(paid).toMatchObject({ order_id: orderId, kind: 'paid', fulfillment_id: null });
      await expectRejected(db(), sql, [paid.email_id, paid.lease_token, 'fulfillment_cancelled'], {
        code: '22023', message: 'SKIP_REASON_NOT_ALLOWED',
      });
    });
  });

  describe('前からのデータ（G-1 で消した写しの関数）', () => {
    test('前の発送の写しと発送のメールを結ぶ関数は無く、発送の番号の無い発送のメールの行は今も書けない', async () => {
      const res = await db().query(
        `select to_regprocedure('private.backfill_legacy_fulfillments()') as backfill,
                to_regprocedure('private.link_legacy_shipped_emails()') as link`,
      );
      expect(res.rows[0]).toEqual({ backfill: null, link: null });

      const stockFx = await createCatalogFixture(db(), { stock: 5 });
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'shipped',
        shipped: { carrier: 'yamato', trackingNumber: 'YM-9' },
        lines: [{ itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 1, fulfillmentType: 'stock' }],
      });
      await expectRejected(
        db(),
        "insert into private.order_email_outbox (order_id, kind, origin, status) values ($1, 'shipped', 'auto', 'sent')",
        [orderId],
        { code: '23514', constraint: 'order_email_outbox_fulfillment_check' },
      );
    });
  });

  describe('消した物と権限', () => {
    test('前の発送の関数・受注の集計の view・前の形の関数は無く、同じ名前の関数は1つだけ', async () => {
      const res = await db().query(
        `select to_regprocedure('public.admin_ship_paid_order(uuid,uuid,text,text,boolean)') as ship,
                to_regclass('public.variant_backorder_summary') as backorder_view,
                to_regprocedure('private.enqueue_order_email(uuid,text,text)') as old_enqueue,
                to_regprocedure('private.enqueue_order_email(uuid,text,text,uuid)') as old_enqueue_with_fulfillment,
                to_regprocedure('public.request_order_email_resend(uuid,text,uuid)') as old_resend`,
      );
      expect(res.rows[0]).toEqual({
        ship: null, backorder_view: null, old_enqueue: null, old_enqueue_with_fulfillment: null, old_resend: null,
      });

      // 同じ名前の関数が2つあると、Data API が呼び分けられない（PGRST203）
      for (const [schema, name] of [
        ['private', 'enqueue_order_email'],
        ['public', 'request_order_email_resend'],
        ['public', 'claim_order_email'],
        ['public', 'list_order_email_history'],
        ['public', 'admin_create_fulfillment'],
        ['public', 'admin_cancel_fulfillment'],
      ]) {
        const count = await db().query(
          `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = $1 and p.proname = $2`,
          [schema, name],
        );
        expect({ name, n: count.rows[0].n }).toEqual({ name, n: 1 });
      }
    });

    test('止めた発送の関数は service_role だけが呼べ（固定の拒否の入口）、結ぶ関数は無い', async () => {
      for (const signature of [
        'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
        'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
      ]) {
        const res = await db().query(
          `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                  has_function_privilege('service_role', $1, 'EXECUTE') as service_role,
                  (select prosecdef from pg_proc where oid = $1::regprocedure) as definer`,
          [signature],
        );
        expect(res.rows[0]).toEqual({ anon: false, authenticated: false, service_role: true, definer: false });
      }
      const link = await db().query("select to_regprocedure('private.link_legacy_shipped_emails()') as link");
      expect(link.rows[0].link).toBeNull();
    });
  });
});

describeLocalDb('integration: 同時の発送（Review Focus 1、G-1 で停止）', (db) => {
  let other: PgClient;

  beforeAll(async () => {
    other = await connectLocalDb();
  });

  afterAll(async () => {
    await other.end();
  });

  test('2つの画面から同時に送っても、どちらも鍵を取らずに固定の拒否で終わり、発送は作られない', async () => {
    const actor = await createActor(db());
    const { orderId, stockItemId } = await createMixedOrder(db());
    const lines = [{ order_item_id: stockItemId, quantity: 2 }];

    await db().query('begin');
    try {
      // 先の画面は取引を開いたまま断られる（注文の行の鍵を取らない）
      await expectRejected(db(), SHIP_SQL, shipParams(orderId, actor.id, { notify: false, lines }), LEGACY_DISABLED);
      // 後の画面も待たずに断られる
      await expect(other.query(SHIP_SQL, shipParams(orderId, actor.id, { notify: false, lines }))).rejects.toMatchObject(LEGACY_DISABLED);
      await db().query('commit');
    } catch (error) {
      await db().query('rollback');
      throw error;
    }

    const count = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [orderId]);
    expect(count.rows[0].n).toBe(0);
  });
});

/** 受け取った額を注文の合計と同じにする（返金の関数は、受け取った額が無い注文を断る）。変更の理由を付ける（本計画 P17） */
async function markReceived(db: PgClient, orderId: string): Promise<void> {
  await db.query("select set_config('app.order_change_reason', 'integration_test', true)");
  await db.query('update public.orders set paid_amount = total_amount where id = $1', [orderId]);
}

/** 管理画面の返金（ア）を返事待ちで始める。額は商品1点分（5000）で、全額にならない。Stripe の返事を書く関数は移行 C なので、返事待ちのまま数える */
function startRefund(db: PgClient, orderId: string, actorId: string, lines: unknown) {
  return db.query(
    'select * from public.begin_order_refund($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
    [orderId, 'admin', crypto.randomUUID(), JSON.stringify(lines), false, 0, 5000, null, null, null, false, actorId, null],
  );
}

describeLocalDb('integration: 発送の取消と返金の守り（グループ E-2 の移行 B、G-1 で取消は停止）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  test('発送後に返金した注文でも、旧の取消は返金の確かめより先に固定の拒否を返し、発送した数は変わらない', async () => {
    const { orderId, stockItemId } = await createMixedOrder(db());
    const actor = await createActor(db());
    await markReceived(db(), orderId);
    const first = await ship(db(), orderId, actor.id, { notify: false, lines: [{ order_item_id: stockItemId, quantity: 1 }] });
    const second = await ship(db(), orderId, actor.id, { notify: false, lines: [{ order_item_id: stockItemId, quantity: 1 }] });
    // 発送した2点のうち1点を返金する（発送後の行）
    await startRefund(db(), orderId, actor.id, [{ order_item_id: stockItemId, quantity: 1, before_shipment: false }]);

    // 返金で守る前の契約（取り消した後の発送した数が返金した数を下回れば FULFILLMENT_REFUNDED）は G-3 の新しい発送票で扱う
    await expectStopped(db(), orderId, CANCEL_SQL, [orderId, first.rows[0].fulfillment_id, actor.id]);
    await expectStopped(db(), orderId, CANCEL_SQL, [orderId, second.rows[0].fulfillment_id, actor.id]);
    const rows = await db().query('select cancelled_at from public.order_fulfillments where order_id = $1', [orderId]);
    expect(rows.rows).toEqual([{ cancelled_at: null }, { cancelled_at: null }]);
    expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 2, refunded_after_shipment: 1 });
  });

  test('発送前の返金がある発送済みの注文でも、旧の取消は止まり、注文は発送済みのまま', async () => {
    const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
    const actor = await createActor(db());
    await markReceived(db(), orderId);
    // 在庫の品1点を発送前に返金する → 発送できるのは残りの1点。受注生産の3点も入荷で割り当て、残りを全部送ると注文は発送済みになる
    await startRefund(db(), orderId, actor.id, [{ order_item_id: stockItemId, quantity: 1, before_shipment: true }]);
    const shipped = await ship(db(), orderId, actor.id, {
      notify: false,
      lines: [{ order_item_id: stockItemId, quantity: 1 }, { order_item_id: madeItemId, quantity: 3 }],
    });
    expect(shipped.rows[0]).toMatchObject({ completes_order: true, order_status: 'shipped' });

    await expectStopped(db(), orderId, CANCEL_SQL, [orderId, shipped.rows[0].fulfillment_id, actor.id]);

    expect((await orderShipping(db(), orderId)).status).toBe('shipped');
    expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 1, refunded_before_shipment: 1, unshipped: 0 });
  });
});
