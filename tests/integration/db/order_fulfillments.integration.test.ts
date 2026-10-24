/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, uniqueSuffix, withFixtureConsumption } from './helpers/order-fixtures';

/**
 * 発送と仕上がりの記録（グループ E-1 設計書 3・5・10・11 章、移行 A）。
 * G-1 Task 14: 手動の仕上がり（admin_record_completion・admin_cancel_completion）は MANUAL_COMPLETION_DISABLED / 55000 で
 * 即座に断り、仕上がりの表への新しい INSERT・UPDATE もトリガー（order_item_completions_disabled）が同じ拒否で断る。
 * 発送の準備ができた数は G-1 の入金済みの割当（A）から導く（品物は入荷から FIFO で自動に割り当てる）。
 * 前からの写しの関数（private.backfill_legacy_fulfillments）は消した。
 * 1件ごとに取引の中で動かし、終わったら戻す。発送の行は旧の関数が止まっているので、試験では postgres で直接書く。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

const COMPLETION_DISABLED = { code: '55000', message: 'MANUAL_COMPLETION_DISABLED' };

async function createActor(db: PgClient): Promise<{ id: string; email: string }> {
  const email = `fulfillment-admin-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

/** 在庫の品（在庫数 stock から2つ確保）と受注生産の品（3つ）の注文 */
async function createMixedOrder(db: PgClient, status = 'paid', stock = 5) {
  const stockFx = await createCatalogFixture(db, { stock });
  const madeFx = await createCatalogFixture(db, { stock: 0 });
  const { orderId, orderItemIds } = await insertOrderWithLines(db, {
    status,
    lines: [
      { itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 2, fulfillmentType: 'stock' },
      { itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 3, fulfillmentType: 'backorder' },
    ],
  });
  return { orderId, stockItemId: orderItemIds[0], madeItemId: orderItemIds[1], stockFx, madeFx };
}

/** 旧の発送の関数の代わりに、発送の記録を直接書く */
async function insertFulfillment(
  db: PgClient,
  orderId: string,
  lines: Array<{ orderItemId: string; quantity: number }>,
  number = 1,
  createdBy: string | null = null,
): Promise<string> {
  // 発送した数の割当を G-1 で消費してから、発送の行を SQL で作る
  return withFixtureConsumption(db, {
    orderId, lines: lines.map((line) => ({ order_item_id: line.orderItemId, quantity: line.quantity })),
  }, async () => {
    const res = await db.query(
      `insert into public.order_fulfillments
         (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order, created_by)
       values ($1, $2, gen_random_uuid(), 'yamato', '1234-5678-9012', true, false, $3) returning id`,
      [orderId, number, createdBy],
    );
    const fulfillmentId = res.rows[0].id as string;
    for (const line of lines) {
      await db.query(
        'insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, $3)',
        [fulfillmentId, line.orderItemId, line.quantity],
      );
    }
    return fulfillmentId;
  });
}

async function lineCounts(db: PgClient, orderId: string): Promise<Record<string, Row>> {
  const res = await db.query('select * from private.order_line_fulfillment($1)', [orderId]);
  return Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row]));
}

const RECORD_SQL = 'select * from public.admin_record_completion($1, $2, $3, $4::jsonb)';
const CANCEL_SQL = 'select * from public.admin_cancel_completion($1, $2, $3)';
const INSERT_COMPLETION_SQL = `insert into public.order_item_completions (order_id, order_item_id, quantity, request_key)
  values ($1, $2, $3, gen_random_uuid())`;

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

/** 止めた仕上がりの関数が、注文の数・仕上がりの行・割当を何も変えないこと */
async function expectCompletionStopped(db: PgClient, orderId: string, sql: string, params: unknown[]) {
  const before = {
    counts: await lineCounts(db, orderId),
    completions: (await db.query('select count(*)::int as n from public.order_item_completions where order_id = $1', [orderId])).rows[0].n,
    allocations: (await db.query(`select coalesce(json_agg(a.remaining_quantity order by a.id), '[]') as a
      from public.order_item_allocations a join public.order_items i on i.id = a.order_item_id where i.order_id = $1`, [orderId])).rows[0].a,
  };
  await expectRejected(db, sql, params, COMPLETION_DISABLED);
  expect({
    counts: await lineCounts(db, orderId),
    completions: (await db.query('select count(*)::int as n from public.order_item_completions where order_id = $1', [orderId])).rows[0].n,
    allocations: (await db.query(`select coalesce(json_agg(a.remaining_quantity order by a.id), '[]') as a
      from public.order_item_allocations a join public.order_items i on i.id = a.order_item_id where i.order_id = $1`, [orderId])).rows[0].a,
  }).toEqual(before);
}

function newKey(): string {
  return crypto.randomUUID();
}

describeLocalDb('integration: 発送と仕上がりの記録（移行 A）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('表の守り', () => {
    test('お客様とログインした人は読めず、アプリは読むだけ', async () => {
      for (const table of ['order_fulfillments', 'order_fulfillment_lines', 'order_item_completions']) {
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
      }
      // 仕上がりの表は service_role も書けない（G-1 Task 14）
      const writable = await db().query(
        `select has_table_privilege('service_role', 'public.order_item_completions', 'INSERT') as ins,
                has_table_privilege('service_role', 'public.order_item_completions', 'UPDATE') as upd`,
      );
      expect(writable.rows[0]).toEqual({ ins: false, upd: false });
    });

    test('発送の商品は追記だけ。発送は消せず、取消の2つの列だけ一度だけ変えられる。仕上がりは新しく書けない', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const fulfillmentId = await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 1 }]);

      const delivery = await db().query(
        'select delivery_status, delivered_at, tracking_version, request_fingerprint from public.order_fulfillments where id = $1',
        [fulfillmentId],
      );
      expect(delivery.rows).toEqual([{
        delivery_status: 'confirmed', delivered_at: null, tracking_version: 1, request_fingerprint: null,
      }]);

      await expectRejected(db(), 'update public.order_fulfillment_lines set quantity = 2 where fulfillment_id = $1', [fulfillmentId], { code: '55000' });
      await expectRejected(db(), 'delete from public.order_fulfillment_lines where fulfillment_id = $1', [fulfillmentId], { code: '55000' });
      await expectRejected(db(), 'delete from public.order_fulfillments where id = $1', [fulfillmentId], { code: '55000' });
      await expectRejected(db(), "update public.order_fulfillments set tracking_number = '9999' where id = $1", [fulfillmentId], { code: '55000' });

      await db().query('update public.order_fulfillments set cancelled_at = now(), cancelled_by = $2 where id = $1', [fulfillmentId, actor.id]);
      await expectRejected(db(), 'update public.order_fulfillments set cancelled_at = now() where id = $1', [fulfillmentId], { code: '55000' });

      // 仕上がりは関数でも所有者の直接の SQL でも新しく書けない
      await expectCompletionStopped(db(), orderId, RECORD_SQL,
        [orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: madeItemId, quantity: 1 }])]);
      await expectRejected(db(), INSERT_COMPLETION_SQL, [orderId, madeItemId, 1], COMPLETION_DISABLED);
    });

    test('ほかの注文の商品は発送の商品にできず、仕上がりはどの商品にも書けない', async () => {
      const first = await createMixedOrder(db());
      const second = await createMixedOrder(db());
      const fulfillmentId = await insertFulfillment(db(), first.orderId, []);

      await expectRejected(
        db(),
        'insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, 1)',
        [fulfillmentId, second.stockItemId],
        { code: '23514', message: 'FULFILLMENT_LINE_ORDER_MISMATCH' },
      );
      // 在庫の品（前は COMPLETION_LINE_INVALID）も受注生産の品も、停止の拒否が先に当たる
      await expectRejected(db(), INSERT_COMPLETION_SQL, [first.orderId, first.stockItemId, 1], COMPLETION_DISABLED);
      await expectRejected(db(), INSERT_COMPLETION_SQL, [first.orderId, first.madeItemId, 1], COMPLETION_DISABLED);
    });
  });

  describe('商品ごとの数', () => {
    test('入金済みの注文: 在庫の品は発送準備中、受注生産の品は受注生産中', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const counts = await lineCounts(db(), orderId);

      expect(counts[stockItemId]).toMatchObject({
        fulfillment_type: 'stock', quantity: 2, shipped: 0, completed: 2, in_production: 0, ready_unshipped: 2, unshipped: 2,
      });
      expect(counts[madeItemId]).toMatchObject({
        fulfillment_type: 'backorder', quantity: 3, shipped: 0, completed: 0, in_production: 3, ready_unshipped: 0, unshipped: 3,
      });
    });

    test('仕上がりの記録は止まり、入荷で割り当てた数の発送で数が動き、取り消した発送は数えない', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await expectCompletionStopped(db(), orderId, RECORD_SQL,
        [orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: madeItemId, quantity: 2 }])]);
      // 受注生産の品は、入荷した1点を割り当ててから送る（材料が A を作って消費する）
      const shippedId = await insertFulfillment(db(), orderId, [
        { orderItemId: stockItemId, quantity: 2 },
        { orderItemId: madeItemId, quantity: 1 },
      ]);
      const cancelledId = await insertFulfillment(db(), orderId, [{ orderItemId: madeItemId, quantity: 1 }], 2);
      await db().query('update public.order_fulfillments set cancelled_at = now() where id = $1', [cancelledId]);

      const counts = await lineCounts(db(), orderId);
      expect(counts[stockItemId]).toMatchObject({ shipped: 2, completed: 2, ready_unshipped: 0, unshipped: 0 });
      expect(counts[madeItemId]).toMatchObject({ shipped: 1, completed: 1, in_production: 2, ready_unshipped: 0, unshipped: 2 });
      expect(shippedId).toBeTruthy();
    });

    test('注文の番号の配列で数を返す。空なら0行、201件以上は断る', async () => {
      const first = await createMixedOrder(db());
      const second = await createMixedOrder(db());

      const res = await db().query('select * from public.list_order_line_fulfillment($1::uuid[])', [[first.orderId, second.orderId]]);
      expect(res.rows).toHaveLength(4);
      expect(new Set(res.rows.map((row) => row.order_id))).toEqual(new Set([first.orderId, second.orderId]));

      const empty = await db().query("select * from public.list_order_line_fulfillment('{}'::uuid[])");
      expect(empty.rows).toHaveLength(0);

      const tooMany = Array.from({ length: 201 }, () => crypto.randomUUID());
      await expectRejected(db(), 'select * from public.list_order_line_fulfillment($1::uuid[])', [tooMany], {
        code: '22023', message: 'TOO_MANY_ORDERS',
      });
    });

    test('数の関係（発送した数 ≤ 注文の数）は直接書いてもトリガーが断り、仕上がりは直接も書けない', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const fulfillmentId = await insertFulfillment(db(), orderId, []);
      const insertLine = 'insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, $3)';

      // 在庫の品は注文の数を超えては送れない
      await expectRejected(db(), insertLine, [fulfillmentId, stockItemId, 3], { code: '23514', message: 'FULFILLMENT_BOUNDS_VIOLATED' });
      // 受注生産の品の「仕上がっていない数は送れない」は、G-1 では入金済みの割当（A）の消費として発送と同じ取引で守る
      // （G-3 の新しい発送票）。旧の仕上がりの数は書けない（注文の数を超える仕上がりも、停止の拒否が先に当たる）
      await expectRejected(db(), INSERT_COMPLETION_SQL, [orderId, madeItemId, 4], COMPLETION_DISABLED);
      await expectRejected(db(), INSERT_COMPLETION_SQL, [orderId, madeItemId, 1], COMPLETION_DISABLED);
      expect((await lineCounts(db(), orderId))[madeItemId]).toMatchObject({ shipped: 0, completed: 0, in_production: 3 });
    });
  });

  describe('仕上がりの記録（G-1 で停止）', () => {
    test('受注生産中の数を移す記録も、同じ番号の送り直しも、MANUAL_COMPLETION_DISABLED で断り何も残さない', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const key = newKey();

      await expectCompletionStopped(db(), orderId, RECORD_SQL,
        [orderId, actor.id, key, JSON.stringify([{ order_item_id: madeItemId, quantity: 2 }])]);
      await expectCompletionStopped(db(), orderId, RECORD_SQL,
        [orderId, actor.id, key, JSON.stringify([{ order_item_id: madeItemId, quantity: 2 }])]);

      const counts = await lineCounts(db(), orderId);
      expect(counts[madeItemId]).toMatchObject({ completed: 0, in_production: 3, ready_unshipped: 0 });
      const rows = await db().query('select count(*)::int as n from public.order_item_completions where order_id = $1', [orderId]);
      expect(rows.rows[0].n).toBe(0);
    });

    test('同じ番号で中身が違っても、COMPLETION_REQUEST_MISMATCH に落ちず固定の拒否を返す', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const key = newKey();
      for (const quantity of [1, 2]) {
        await expectCompletionStopped(db(), orderId, RECORD_SQL,
          [orderId, actor.id, key, JSON.stringify([{ order_item_id: madeItemId, quantity }])]);
      }
    });

    test('入金済みでない注文・在庫の品・受注生産中を超える数・無い注文も、固定の拒否だけを返す', async () => {
      const unpaid = await createMixedOrder(db(), 'pending');
      const paid = await createMixedOrder(db());
      const actor = await createActor(db());

      await expectCompletionStopped(db(), unpaid.orderId, RECORD_SQL,
        [unpaid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: unpaid.madeItemId, quantity: 1 }])]);
      await expectCompletionStopped(db(), paid.orderId, RECORD_SQL,
        [paid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: paid.stockItemId, quantity: 1 }])]);
      await expectCompletionStopped(db(), paid.orderId, RECORD_SQL,
        [paid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: unpaid.madeItemId, quantity: 1 }])]);
      await expectCompletionStopped(db(), paid.orderId, RECORD_SQL,
        [paid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: paid.madeItemId, quantity: 4 }])]);
      await expectRejected(db(), RECORD_SQL,
        [crypto.randomUUID(), actor.id, newKey(), JSON.stringify([{ order_item_id: paid.madeItemId, quantity: 1 }])], COMPLETION_DISABLED);
    });

    test('行の形の誤り・空の値も、検証より先に固定の拒否を返す', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const bad: unknown[] = [
        [],
        {},
        Array.from({ length: 101 }, () => ({ order_item_id: madeItemId, quantity: 1 })),
        [{ order_item_id: madeItemId, quantity: 1 }, { order_item_id: madeItemId, quantity: 1 }],
        [{ order_item_id: madeItemId, quantity: 0 }],
        [{ order_item_id: madeItemId, quantity: 1000 }],
        [{ order_item_id: madeItemId, quantity: 1.5 }],
        [{ order_item_id: 'not-a-uuid', quantity: 1 }],
        [{ order_item_id: madeItemId, quantity: '1' }],
      ];
      for (const lines of bad) {
        await expectCompletionStopped(db(), orderId, RECORD_SQL, [orderId, actor.id, newKey(), JSON.stringify(lines)]);
      }
      await expectCompletionStopped(db(), orderId, RECORD_SQL,
        [orderId, null, newKey(), JSON.stringify([{ order_item_id: madeItemId, quantity: 1 }])]);
      await expectRejected(db(), RECORD_SQL, [null, null, null, null], COMPLETION_DISABLED);
    });

    test('取消も MANUAL_COMPLETION_DISABLED で断り、発送した数・受注生産中の数は変わらない', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await insertFulfillment(db(), orderId, [{ orderItemId: madeItemId, quantity: 1 }]);
      const before = await lineCounts(db(), orderId);

      for (const completionId of [crypto.randomUUID(), crypto.randomUUID()]) {
        await expectCompletionStopped(db(), orderId, CANCEL_SQL, [orderId, completionId, actor.id]);
      }

      expect(await lineCounts(db(), orderId)).toEqual(before);
      expect(before[madeItemId]).toMatchObject({ shipped: 1, completed: 1, in_production: 2, ready_unshipped: 0 });
    });

    test('取消: ほかの注文・入金済みでない注文・空の値も固定の拒否だけを返す', async () => {
      const { orderId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const completionId = crypto.randomUUID();

      await expectCompletionStopped(db(), other.orderId, CANCEL_SQL, [other.orderId, completionId, actor.id]);
      // 保留中の守り（order_state_transition_hardening の試験が手元の DB に当てる）が効いていても通る形にする:
      // 理由を付け、入金済みからの取消は全額返金と同じ更新で行う
      await db().query("select set_config('app.order_change_reason', 'integration_test', true)");
      await db().query(
        "update public.orders set status = 'cancelled', refunded_amount = total_amount, refunded_at = now() where id = $1",
        [orderId],
      );
      await expectCompletionStopped(db(), orderId, CANCEL_SQL, [orderId, completionId, actor.id]);
      await expectRejected(db(), CANCEL_SQL, [null, null, null], COMPLETION_DISABLED);
    });
  });

  describe('読み出し', () => {
    test('発送の一覧は新しい順で、商品と数・実行した人と取り消した人のメールを返す', async () => {
      const { orderId, stockItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const firstId = await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 1 }], 1, actor.id);
      const secondId = await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 1 }], 2);
      await db().query('update public.order_fulfillments set cancelled_at = now(), cancelled_by = $2 where id = $1', [secondId, actor.id]);

      const res = await db().query('select * from public.list_order_fulfillments($1)', [orderId]);
      expect(res.rows.map((row) => row.number)).toEqual([2, 1]);
      expect(res.rows[0]).toMatchObject({
        fulfillment_id: secondId, shipping_carrier: 'yamato', tracking_number: '1234-5678-9012',
        created_by_email: null, cancelled_by_email: actor.email, legacy: false,
        lines: [{ order_item_id: stockItemId, quantity: 1 }],
      });
      expect(res.rows[0].cancelled_at).not.toBeNull();
      expect(res.rows[1]).toMatchObject({ fulfillment_id: firstId, created_by_email: actor.email, cancelled_at: null });
    });

    test('仕上がりの一覧は、記録が止まったので新しい注文では空', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await expectCompletionStopped(db(), orderId, RECORD_SQL,
        [orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: madeItemId, quantity: 1 }])]);

      const res = await db().query('select * from public.list_order_completions($1)', [orderId]);
      expect(res.rows).toEqual([]);
    });
  });

  describe('在庫の数', () => {
    test('引き当て済みは確保して送っていない数、受注生産は入金済みの割り当てていない数（仕上がりの記録では動かない）', async () => {
      const { orderId, stockItemId, madeItemId, stockFx, madeFx } = await createMixedOrder(db());
      const actor = await createActor(db());

      let states = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [[stockFx.variantId, madeFx.variantId]]);
      const byVariant = (rows: Row[]) => Object.fromEntries(rows.map((row) => [Number(row.variant_id), row]));
      expect(byVariant(states.rows)[stockFx.variantId]).toMatchObject({ committed: 2, backorder: 0 });
      expect(byVariant(states.rows)[madeFx.variantId]).toMatchObject({ committed: 0, backorder: 3 });

      await expectCompletionStopped(db(), orderId, RECORD_SQL,
        [orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: madeItemId, quantity: 1 }])]);
      await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 2 }]);
      states = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [[stockFx.variantId, madeFx.variantId]]);
      expect(byVariant(states.rows)[stockFx.variantId]).toMatchObject({ committed: 0 });
      expect(byVariant(states.rows)[madeFx.variantId]).toMatchObject({ committed: 0, backorder: 3 });
    });

    test('受注生産の数は、支払い手続き中・失敗・放棄・キャンセル・発送済みの注文を数えない', async () => {
      const madeFx = await createCatalogFixture(db(), { stock: 0 });
      for (const status of ['payment_in_progress', 'failed', 'abandoned', 'cancelled', 'pending', 'paid']) {
        await insertOrderWithLines(db(), {
          status,
          lines: [{ itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 1, fulfillmentType: 'backorder' }],
        });
      }
      await insertOrderWithLines(db(), {
        status: 'shipped',
        shipped: { carrier: 'yamato', trackingNumber: 'YM-STATE' },
        lines: [{ itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 1, fulfillmentType: 'backorder' }],
      });
      const res = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [[madeFx.variantId]]);
      expect(res.rows).toEqual([{ variant_id: String(madeFx.variantId), committed: 0, backorder: 2 }]);
    });

    test('支払い手続き中の注文の確保は引き当て済みに入る', async () => {
      const stockFx = await createCatalogFixture(db(), { stock: 3 });
      await insertOrderWithLines(db(), {
        status: 'payment_in_progress',
        lines: [{ itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 1, fulfillmentType: 'stock' }],
      });
      const res = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [[stockFx.variantId]]);
      expect(res.rows[0]).toMatchObject({ committed: 1 });
    });

    test('501件以上の番号は断る', async () => {
      const ids = Array.from({ length: 501 }, (_, i) => i + 1);
      await expectRejected(db(), 'select * from public.list_variant_stock_states($1::bigint[])', [ids], {
        code: '22023', message: 'TOO_MANY_VARIANTS',
      });
    });

    test('在庫の履歴は新しい順で、変わった後の数・実行した人・注文を返す', async () => {
      const stockFx = await createCatalogFixture(db(), { stock: 5 });
      const actor = await createActor(db());
      // 台帳は共通の押さえ（G-1）の下でだけ在庫を動かせる
      await db().query('select pg_catalog.pg_advisory_xact_lock(190521, 1)');
      await db().query(
        `insert into public.stock_movements (variant_id, delta, reason, note, created_by) values ($1, -1, 'adjustment', '棚卸', $2)`,
        [stockFx.variantId, actor.id],
      );
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'paid',
        lines: [{ itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 2, fulfillmentType: 'stock' }],
      });

      const res = await db().query('select * from public.list_item_stock_history($1, 50)', [stockFx.itemId]);
      expect(res.rows.map((row) => [row.reason, row.delta, row.balance_after])).toEqual([
        ['purchase', -2, 2],
        ['adjustment', -1, 4],
        ['restock', 5, 5],
      ]);
      expect(res.rows[0]).toMatchObject({ order_id: orderId, actor_email: null });
      expect(res.rows[1]).toMatchObject({ actor_email: actor.email, note: '棚卸', order_id: null });

      const limited = await db().query('select * from public.list_item_stock_history($1, 0)', [stockFx.itemId]);
      expect(limited.rows).toHaveLength(1);
    });
  });

  describe('前からの写し（G-1 で消した）', () => {
    test('写しの関数は無く、発送の記録の無い発送済みの注文に発送や仕上がりを作らない', async () => {
      const res = await db().query(
        "select to_regprocedure('private.backfill_legacy_fulfillments()') as backfill",
      );
      expect(res.rows[0].backfill).toBeNull();

      const stockFx = await createCatalogFixture(db(), { stock: 5 });
      const madeFx = await createCatalogFixture(db(), { stock: 0 });
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'shipped',
        shipped: { carrier: 'sagawa', trackingNumber: 'SG-1' },
        lines: [
          { itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 2, fulfillmentType: 'stock' },
          { itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 1, fulfillmentType: 'backorder' },
        ],
      });
      const counts = await db().query(
        `select (select count(*)::int from public.order_fulfillments where order_id = $1) as fulfillments,
                (select count(*)::int from public.order_item_completions where order_id = $1) as completions`,
        [orderId],
      );
      expect(counts.rows[0]).toEqual({ fulfillments: 0, completions: 0 });
    });
  });

  describe('権限', () => {
    test('関数を実行できるのは service_role だけ（止めた仕上がりの関数は固定の拒否の入口）', async () => {
      const functions = [
        'public.list_order_line_fulfillment(uuid[])',
        'public.admin_record_completion(uuid, uuid, uuid, jsonb)',
        'public.admin_cancel_completion(uuid, uuid, uuid)',
        'public.list_order_fulfillments(uuid)',
        'public.list_order_completions(uuid)',
        'public.list_variant_stock_states(bigint[])',
        'public.list_item_stock_history(bigint, integer)',
      ];
      for (const fn of functions) {
        const res = await db().query(
          `select has_function_privilege('anon', $1, 'execute') as anon,
                  has_function_privilege('authenticated', $1, 'execute') as authed,
                  has_function_privilege('service_role', $1, 'execute') as service`,
          [fn],
        );
        expect(res.rows[0]).toEqual({ anon: false, authed: false, service: true });
      }
      for (const fn of [
        'private.order_line_fulfillment(uuid)',
        'private.parse_fulfillment_lines(jsonb, text)',
        'private.check_order_line_fulfillment_bounds()',
        'private.reject_group_g_manual_completion()',
      ]) {
        const res = await db().query("select has_function_privilege('service_role', $1, 'execute') as service", [fn]);
        expect(res.rows[0].service).toBe(false);
      }
      const dropped = await db().query("select to_regprocedure('private.backfill_legacy_fulfillments()') as fn");
      expect(dropped.rows[0].fn).toBeNull();
    });
  });
});
