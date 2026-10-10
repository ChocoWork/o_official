/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 発送の関数と発送ごとの発送のメール（グループ E-1 設計書 6・7・8 章、移行 B）。
 * 注文のメールの取り出しは表全体から古い順に選ぶので、1件ごとに取引の中で注文のメールの表を空にし、終わったら戻す。
 * 同時の発送だけは2つの接続が要るので、別の describe で確定した行を使う（消せない注文が手元の DB に残る）。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

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

function shipParams(orderId: string | null, actorId: string | null, input: ShipInput): unknown[] {
  return [
    orderId,
    actorId,
    input.requestKey ?? crypto.randomUUID(),
    input.carrier === undefined ? 'yamato' : input.carrier,
    input.tracking === undefined ? '1234-5678-9012' : input.tracking,
    input.notify === undefined ? true : input.notify,
    JSON.stringify(input.lines),
  ];
}

function ship(db: PgClient, orderId: string, actorId: string, input: ShipInput) {
  return db.query(SHIP_SQL, shipParams(orderId, actorId, input));
}

function cancelFulfillment(db: PgClient, orderId: string, fulfillmentId: string, actorId: string) {
  return db.query('select * from public.admin_cancel_fulfillment($1, $2, $3)', [orderId, fulfillmentId, actorId]);
}

function recordCompletion(db: PgClient, orderId: string, actorId: string, lines: unknown) {
  return db.query('select * from public.admin_record_completion($1, $2, $3, $4::jsonb)', [
    orderId, actorId, crypto.randomUUID(), JSON.stringify(lines),
  ]);
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
 * 保留中の守り（order_state_transition_hardening の試験が手元の DB に当てる）が効いていても通る形で取り消す:
 * 理由を付け、入金済みからの取消は全額返金と同じ更新で行う（本計画 P15）
 */
async function cancelByFullRefund(db: PgClient, orderId: string): Promise<void> {
  await db.query("select set_config('app.order_change_reason', 'integration_test', true)");
  await db.query(
    "update public.orders set status = 'cancelled', refunded_amount = total_amount, refunded_at = now() where id = $1",
    [orderId],
  );
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

/** 別の接続が鍵を待つまで待つ（最大5秒）。pg_blocking_pids は取引の写しではなく今の鍵を見る */
async function waitUntilBlocked(db: PgClient, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await db.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [pid]);
    if (res.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('別の接続が注文の行の鍵を待たなかった');
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

  describe('発送する', () => {
    test('在庫の品だけ先に送ると、注文は決済完了のまま。発送のメールの行はその発送に付く', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());

      const res = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });

      expect(res.rows).toEqual([
        expect.objectContaining({ number: 1, completes_order: false, order_status: 'paid', replayed: false }),
      ]);
      const fulfillmentId = res.rows[0].fulfillment_id as string;
      expect(await orderShipping(db(), orderId)).toEqual({
        status: 'paid', shipped_at: null, shipping_carrier: null, tracking_number: null,
      });
      const counts = await lineCounts(db(), orderId);
      expect(counts[stockItemId]).toMatchObject({ shipped: 2, ready_unshipped: 0, unshipped: 0 });
      expect(counts[madeItemId]).toMatchObject({ shipped: 0, in_production: 3, unshipped: 3 });
      expect(await shippedEmails(db(), orderId)).toEqual([
        expect.objectContaining({ fulfillment_id: fulfillmentId, origin: 'auto', status: 'pending' }),
      ]);
      const fulfillment = await db().query(
        'select created_by, notify_customer, legacy from public.order_fulfillments where id = $1',
        [fulfillmentId],
      );
      expect(fulfillment.rows).toEqual([{ created_by: actor.id, notify_customer: true, legacy: false }]);
      // 状態は変わらないので、注文の改訂は増えない
      const revisions = await db().query('select count(*)::int as n from public.order_revisions where order_id = $1', [orderId]);
      expect(revisions.rows[0].n).toBe(0);
    });

    test('残りを仕上げて送ると、注文は発送済みになり、発送の列にその発送の値が入る', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });
      await recordCompletion(db(), orderId, actor.id, [{ order_item_id: madeItemId, quantity: 3 }]);

      const res = await ship(db(), orderId, actor.id, {
        carrier: 'sagawa', tracking: 'SG-2', notify: false, lines: [{ order_item_id: madeItemId, quantity: 3 }],
      });

      expect(res.rows).toEqual([
        expect.objectContaining({ number: 2, completes_order: true, order_status: 'shipped', replayed: false }),
      ]);
      const shipping = await orderShipping(db(), orderId);
      expect(shipping).toMatchObject({ status: 'shipped', shipping_carrier: 'sagawa', tracking_number: 'SG-2' });
      expect(shipping.shipped_at).not.toBeNull();
      const revision = await db().query(
        "select reason, changed_by from public.order_revisions where order_id = $1 and after_data ->> 'status' = 'shipped'",
        [orderId],
      );
      expect(revision.rows).toEqual([{ reason: 'admin_create_fulfillment', changed_by: actor.id }]);
      // メールを送らない発送は、発送のメールの行を書かない（1回目の行だけ）
      expect(await shippedEmails(db(), orderId)).toHaveLength(1);
    });

    test('同じ番号の送り直しは前の結果を返し、発送もメールも増えない（Review Focus 2）', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const input = { requestKey: crypto.randomUUID(), lines: [{ order_item_id: stockItemId, quantity: 2 }] };

      const first = await ship(db(), orderId, actor.id, input);
      const again = await ship(db(), orderId, actor.id, input);

      expect(again.rows).toEqual([{ ...first.rows[0], replayed: true }]);
      const count = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [orderId]);
      expect(count.rows[0].n).toBe(1);
      expect(await shippedEmails(db(), orderId)).toHaveLength(1);
    });

    test('同じ番号で中身が違えば断る', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const requestKey = crypto.randomUUID();
      const line = [{ order_item_id: stockItemId, quantity: 1 }];
      await ship(db(), orderId, actor.id, { requestKey, lines: line });

      const changed: Array<[string, ShipInput]> = [
        [orderId, { requestKey, tracking: '9999-0000', lines: line }],
        [orderId, { requestKey, carrier: 'sagawa', lines: line }],
        [orderId, { requestKey, notify: false, lines: line }],
        [orderId, { requestKey, lines: [{ order_item_id: stockItemId, quantity: 2 }] }],
        [other.orderId, { requestKey, lines: [{ order_item_id: other.stockItemId, quantity: 1 }] }],
      ];
      for (const [target, input] of changed) {
        await expectRejected(db(), SHIP_SQL, shipParams(target, actor.id, input), {
          code: '22023', message: 'FULFILLMENT_REQUEST_MISMATCH',
        });
      }
    });

    test('発送準備中を超える数・注文に無い商品は断り、数は変わらない', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());

      // 受注生産の品は、仕上がりを記録するまで送れない
      await expectRejected(db(), SHIP_SQL, shipParams(orderId, actor.id, { lines: [{ order_item_id: madeItemId, quantity: 1 }] }), {
        code: '22023', message: 'QUANTITY_EXCEEDS_READY',
      });
      await expectRejected(db(), SHIP_SQL, shipParams(orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 3 }] }), {
        code: '22023', message: 'QUANTITY_EXCEEDS_READY',
      });
      await expectRejected(db(), SHIP_SQL, shipParams(orderId, actor.id, { lines: [{ order_item_id: other.stockItemId, quantity: 1 }] }), {
        code: '22023', message: 'LINE_NOT_IN_ORDER',
      });
      expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 0, ready_unshipped: 2 });
    });

    test('決済完了でない・配送先が足りない・支払額の確かめが残る・無い注文は送れない', async () => {
      const actor = await createActor(db());
      const pending = await createMixedOrder(db(), 'pending');
      await expectRejected(db(), SHIP_SQL, shipParams(pending.orderId, actor.id, { lines: [{ order_item_id: pending.stockItemId, quantity: 1 }] }), {
        code: '22023', message: 'ORDER_NOT_SHIPPABLE',
      });

      const noAddress = await createOrderWithoutAddress(db());
      await expectRejected(db(), SHIP_SQL, shipParams(noAddress.orderId, actor.id, { lines: [{ order_item_id: noAddress.orderItemId, quantity: 1 }] }), {
        code: '22023', message: 'SHIPPING_ADDRESS_INCOMPLETE',
      });

      const review = await createMixedOrder(db());
      await db().query(
        "select exception_id from public.record_payment_exception($1::text, 'paid_amount_mismatch', null::text, $1::text, null, null, $2::uuid)",
        [`cs_review_${uniqueSuffix()}`, review.orderId],
      );
      await expectRejected(db(), SHIP_SQL, shipParams(review.orderId, actor.id, { lines: [{ order_item_id: review.stockItemId, quantity: 1 }] }), {
        code: '22023', message: 'PAYMENT_REVIEW_REQUIRED',
      });

      await expectRejected(db(), SHIP_SQL, shipParams(crypto.randomUUID(), actor.id, { lines: [{ order_item_id: review.stockItemId, quantity: 1 }] }), {
        code: 'P0002', message: 'ORDER_NOT_FOUND',
      });
    });

    test('引数の誤りは FULFILLMENT_ARGUMENT_INVALID', async () => {
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
      ];
      for (const [target, actorId, input] of bad) {
        await expectRejected(db(), SHIP_SQL, shipParams(target, actorId, input), {
          code: '22023', message: 'FULFILLMENT_ARGUMENT_INVALID',
        });
      }
      const nullKey = shipParams(orderId, actor.id, { lines: line });
      nullKey[2] = null;
      await expectRejected(db(), SHIP_SQL, nullKey, { code: '22023', message: 'FULFILLMENT_ARGUMENT_INVALID' });
    });
  });

  describe('発送の取消', () => {
    test('全部を送った注文の発送を取り消すと決済完了に戻り、発送の列が空になる。2回目は already_cancelled', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });
      await recordCompletion(db(), orderId, actor.id, [{ order_item_id: madeItemId, quantity: 3 }]);
      await ship(db(), orderId, actor.id, { notify: false, lines: [{ order_item_id: madeItemId, quantity: 3 }] });
      const firstId = first.rows[0].fulfillment_id as string;

      const cancelled = await cancelFulfillment(db(), orderId, firstId, actor.id);

      expect(cancelled.rows).toEqual([{ outcome: 'cancelled', order_status: 'paid' }]);
      expect(await orderShipping(db(), orderId)).toEqual({
        status: 'paid', shipped_at: null, shipping_carrier: null, tracking_number: null,
      });
      expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 0, ready_unshipped: 2, unshipped: 2 });
      const row = await db().query('select cancelled_by from public.order_fulfillments where id = $1', [firstId]);
      expect(row.rows[0].cancelled_by).toBe(actor.id);
      const revision = await db().query(
        `select reason, changed_by from public.order_revisions
         where order_id = $1 and before_data ->> 'status' = 'shipped' and after_data ->> 'status' = 'paid'`,
        [orderId],
      );
      expect(revision.rows).toEqual([{ reason: 'admin_cancel_fulfillment', changed_by: actor.id }]);
      // 送る前だった発送のメールは取りやめる
      expect(await shippedEmails(db(), orderId)).toEqual([
        expect.objectContaining({ fulfillment_id: firstId, status: 'skipped', last_error_code: 'fulfillment_cancelled' }),
      ]);

      const again = await cancelFulfillment(db(), orderId, firstId, actor.id);
      expect(again.rows).toEqual([{ outcome: 'already_cancelled', order_status: 'paid' }]);
    });

    test('一部の発送の取消は状態を変えず、やり直し待ちのメールは取りやめ、送ったメールはそのまま（Review Focus 3）', async () => {
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

      expect((await cancelFulfillment(db(), orderId, firstId, actor.id)).rows).toEqual([{ outcome: 'cancelled', order_status: 'paid' }]);
      expect((await cancelFulfillment(db(), orderId, secondId, actor.id)).rows).toEqual([{ outcome: 'cancelled', order_status: 'paid' }]);

      expect(await shippedEmails(db(), orderId)).toEqual([
        expect.objectContaining({ fulfillment_id: firstId, status: 'sent', last_error_code: null }),
        expect.objectContaining({ fulfillment_id: secondId, status: 'skipped', last_error_code: 'fulfillment_cancelled' }),
      ]);
      expect((await lineCounts(db(), orderId))[stockItemId]).toMatchObject({ shipped: 0, ready_unshipped: 2 });
    });

    test('送っている途中の発送のメールは残し、worker が取消を見て取りやめる（Review Focus 3）', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const shipped = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 2 }] });
      const fulfillmentId = shipped.rows[0].fulfillment_id as string;
      const claimed = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      expect(claimed).toMatchObject({ order_id: orderId, kind: 'shipped', fulfillment_id: fulfillmentId });

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

    test('ほかの注文の発送・無い注文・取り消せない注文は断る', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const shipped = await ship(db(), orderId, actor.id, { lines: [{ order_item_id: stockItemId, quantity: 1 }] });
      const fulfillmentId = shipped.rows[0].fulfillment_id as string;
      const sql = 'select * from public.admin_cancel_fulfillment($1, $2, $3)';

      await expectRejected(db(), sql, [other.orderId, fulfillmentId, actor.id], { code: 'P0002', message: 'FULFILLMENT_NOT_FOUND' });
      await expectRejected(db(), sql, [crypto.randomUUID(), fulfillmentId, actor.id], { code: 'P0002', message: 'ORDER_NOT_FOUND' });
      await expectRejected(db(), sql, [orderId, fulfillmentId, null], { code: '22023', message: 'FULFILLMENT_ARGUMENT_INVALID' });

      await cancelByFullRefund(db(), orderId);
      await expectRejected(db(), sql, [orderId, fulfillmentId, actor.id], { code: '22023', message: 'FULFILLMENT_CANCEL_NOT_ALLOWED' });
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

  describe('前からのデータ', () => {
    test('前の発送のメールの行を、前からの発送に結ぶ。2回目は何もしない（Review Focus 5）', async () => {
      // 移行の前を再現する: 発送の番号の無い発送のメールの行は、この取引の中だけ決まりを外して書く
      await db().query('alter table private.order_email_outbox drop constraint order_email_outbox_fulfillment_check');
      const stockFx = await createCatalogFixture(db(), { stock: 5 });
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'shipped',
        shipped: { carrier: 'yamato', trackingNumber: 'YM-9' },
        lines: [{ itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 1, fulfillmentType: 'stock' }],
      });
      const email = await db().query(
        "insert into private.order_email_outbox (order_id, kind, origin, status) values ($1, 'shipped', 'auto', 'sent') returning id",
        [orderId],
      );
      await db().query('select private.backfill_legacy_fulfillments()');

      const linked = await db().query('select private.link_legacy_shipped_emails() as linked');
      expect(linked.rows[0].linked).toBeGreaterThanOrEqual(1);

      const legacy = await db().query('select id from public.order_fulfillments where order_id = $1 and legacy', [orderId]);
      const row = await db().query('select fulfillment_id from private.order_email_outbox where id = $1', [email.rows[0].id]);
      expect(row.rows[0].fulfillment_id).toBe(legacy.rows[0].id);
      expect((await db().query('select private.link_legacy_shipped_emails() as linked')).rows[0].linked).toBe(0);
    });
  });

  describe('消した物と権限', () => {
    test('前の発送の関数・受注の集計の view・前の形の関数は無く、同じ名前の関数は1つだけ', async () => {
      const res = await db().query(
        `select to_regprocedure('public.admin_ship_paid_order(uuid,uuid,text,text,boolean)') as ship,
                to_regclass('public.variant_backorder_summary') as backorder_view,
                to_regprocedure('private.enqueue_order_email(uuid,text,text)') as old_enqueue,
                to_regprocedure('public.request_order_email_resend(uuid,text,uuid)') as old_resend`,
      );
      expect(res.rows[0]).toEqual({ ship: null, backorder_view: null, old_enqueue: null, old_resend: null });

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

    test('発送の関数は service_role だけが呼べ、結ぶ関数はだれも呼べない', async () => {
      for (const signature of [
        'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
        'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
      ]) {
        const res = await db().query(
          `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                  has_function_privilege('service_role', $1, 'EXECUTE') as service_role`,
          [signature],
        );
        expect(res.rows[0]).toEqual({ anon: false, authenticated: false, service_role: true });
      }
      const link = await db().query(
        "select has_function_privilege('service_role', 'private.link_legacy_shipped_emails()', 'EXECUTE') as allowed",
      );
      expect(link.rows[0].allowed).toBe(false);
    });
  });
});

describeLocalDb('integration: 同時の発送（Review Focus 1）', (db) => {
  let other: PgClient;

  beforeAll(async () => {
    other = await connectLocalDb();
  });

  afterAll(async () => {
    await other.end();
  });

  test('同じ品を2つの画面から同時に送ると、後の方は発送準備中の数を超えて断られ、発送は1つだけ', async () => {
    const actor = await createActor(db());
    const { orderId, stockItemId } = await createMixedOrder(db());
    const lines = [{ order_item_id: stockItemId, quantity: 2 }];
    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;

    await db().query('begin');
    try {
      await ship(db(), orderId, actor.id, { notify: false, lines });
      // 後の発送は注文の行の鍵を待つ。待っている間に前の発送を確定させる
      const second = ship(other, orderId, actor.id, { notify: false, lines }).then(() => null, (error: unknown) => error);
      await waitUntilBlocked(db(), otherPid);
      await db().query('commit');
      expect(await second).toMatchObject({ code: '22023', message: 'QUANTITY_EXCEEDS_READY' });
    } catch (error) {
      await db().query('rollback');
      throw error;
    }

    const count = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [orderId]);
    expect(count.rows[0].n).toBe(1);
  });
});
