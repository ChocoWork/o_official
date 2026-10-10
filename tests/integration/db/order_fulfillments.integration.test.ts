/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 発送と仕上がりの記録（グループ E-1 設計書 3・5・10・11 章、移行 A）。
 * 1件ごとに取引の中で動かし、終わったら戻す。発送の行は移行 B の関数がまだ無いので、試験では postgres で直接書く。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

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

/** 移行 B の発送の関数の代わりに、発送の記録を直接書く */
async function insertFulfillment(
  db: PgClient,
  orderId: string,
  lines: Array<{ orderItemId: string; quantity: number }>,
  number = 1,
  createdBy: string | null = null,
): Promise<string> {
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
}

async function lineCounts(db: PgClient, orderId: string): Promise<Record<string, Row>> {
  const res = await db.query('select * from private.order_line_fulfillment($1)', [orderId]);
  return Object.fromEntries(res.rows.map((row) => [row.order_item_id as string, row]));
}

function recordCompletion(db: PgClient, orderId: string, actorId: string, requestKey: string, lines: unknown) {
  return db.query('select * from public.admin_record_completion($1, $2, $3, $4::jsonb)', [
    orderId, actorId, requestKey, JSON.stringify(lines),
  ]);
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
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
    });

    test('発送の商品は追記だけ。発送と仕上がりは消せず、取消の2つの列だけ一度だけ変えられる', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const fulfillmentId = await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 1 }]);

      await expectRejected(db(), 'update public.order_fulfillment_lines set quantity = 2 where fulfillment_id = $1', [fulfillmentId], { code: '55000' });
      await expectRejected(db(), 'delete from public.order_fulfillment_lines where fulfillment_id = $1', [fulfillmentId], { code: '55000' });
      await expectRejected(db(), 'delete from public.order_fulfillments where id = $1', [fulfillmentId], { code: '55000' });
      await expectRejected(db(), "update public.order_fulfillments set tracking_number = '9999' where id = $1", [fulfillmentId], { code: '55000' });

      await db().query('update public.order_fulfillments set cancelled_at = now(), cancelled_by = $2 where id = $1', [fulfillmentId, actor.id]);
      await expectRejected(db(), 'update public.order_fulfillments set cancelled_at = now() where id = $1', [fulfillmentId], { code: '55000' });

      await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);
      await expectRejected(db(), 'delete from public.order_item_completions where order_id = $1', [orderId], { code: '55000' });
    });

    test('ほかの注文の商品は発送の商品にできず、在庫の品は仕上がりにできない', async () => {
      const first = await createMixedOrder(db());
      const second = await createMixedOrder(db());
      const fulfillmentId = await insertFulfillment(db(), first.orderId, []);

      await expectRejected(
        db(),
        'insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, 1)',
        [fulfillmentId, second.stockItemId],
        { code: '23514', message: 'FULFILLMENT_LINE_ORDER_MISMATCH' },
      );
      await expectRejected(
        db(),
        `insert into public.order_item_completions (order_id, order_item_id, quantity, request_key)
         values ($1, $2, 1, gen_random_uuid())`,
        [first.orderId, first.stockItemId],
        { code: '23514', message: 'COMPLETION_LINE_INVALID' },
      );
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

    test('仕上がりと発送で数が動き、取り消した記録は数えない', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 2 }]);
      const shippedId = await insertFulfillment(db(), orderId, [
        { orderItemId: stockItemId, quantity: 2 },
        { orderItemId: madeItemId, quantity: 1 },
      ]);
      const cancelledId = await insertFulfillment(db(), orderId, [{ orderItemId: madeItemId, quantity: 1 }], 2);
      await db().query('update public.order_fulfillments set cancelled_at = now() where id = $1', [cancelledId]);

      const counts = await lineCounts(db(), orderId);
      expect(counts[stockItemId]).toMatchObject({ shipped: 2, completed: 2, ready_unshipped: 0, unshipped: 0 });
      expect(counts[madeItemId]).toMatchObject({ shipped: 1, completed: 2, in_production: 1, ready_unshipped: 1, unshipped: 2 });
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

    test('数の関係（発送した数 ≤ 仕上がった数 ≤ 注文の数）は、直接書いてもトリガーが断る', async () => {
      const { orderId, stockItemId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const fulfillmentId = await insertFulfillment(db(), orderId, []);
      const insertLine = 'insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, $3)';

      // 仕上がっていない受注生産の品は送れない。在庫の品も注文の数を超えては送れない
      await expectRejected(db(), insertLine, [fulfillmentId, madeItemId, 1], { code: '23514', message: 'FULFILLMENT_BOUNDS_VIOLATED' });
      await expectRejected(db(), insertLine, [fulfillmentId, stockItemId, 3], { code: '23514', message: 'FULFILLMENT_BOUNDS_VIOLATED' });
      // 注文の数を超える仕上がりは書けない
      await expectRejected(
        db(),
        'insert into public.order_item_completions (order_id, order_item_id, quantity, request_key) values ($1, $2, 4, gen_random_uuid())',
        [orderId, madeItemId],
        { code: '23514', message: 'FULFILLMENT_BOUNDS_VIOLATED' },
      );
      // 送った数を下回る仕上がりの取消は、直接変えても通らない
      const done = await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);
      await db().query(insertLine, [fulfillmentId, madeItemId, 1]);
      await expectRejected(
        db(),
        'update public.order_item_completions set cancelled_at = now() where id = $1',
        [done.rows[0].completion_id],
        { code: '23514', message: 'FULFILLMENT_BOUNDS_VIOLATED' },
      );
    });
  });

  describe('仕上がりの記録', () => {
    test('受注生産中の数を発送準備中に移し、同じ番号の送り直しは前の結果を返す', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const key = newKey();

      const first = await recordCompletion(db(), orderId, actor.id, key, [{ order_item_id: madeItemId, quantity: 2 }]);
      expect(first.rows).toEqual([
        expect.objectContaining({ order_item_id: madeItemId, quantity: 2, replayed: false }),
      ]);

      const again = await recordCompletion(db(), orderId, actor.id, key, [{ order_item_id: madeItemId, quantity: 2 }]);
      expect(again.rows).toEqual([
        expect.objectContaining({ completion_id: first.rows[0].completion_id, quantity: 2, replayed: true }),
      ]);

      const counts = await lineCounts(db(), orderId);
      expect(counts[madeItemId]).toMatchObject({ completed: 2, in_production: 1, ready_unshipped: 2 });
      const rows = await db().query('select created_by, legacy from public.order_item_completions where order_id = $1', [orderId]);
      expect(rows.rows).toEqual([{ created_by: actor.id, legacy: false }]);
    });

    test('同じ番号で中身が違えば断る', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const key = newKey();
      await recordCompletion(db(), orderId, actor.id, key, [{ order_item_id: madeItemId, quantity: 1 }]);

      await expectRejected(
        db(),
        'select * from public.admin_record_completion($1, $2, $3, $4::jsonb)',
        [orderId, actor.id, key, JSON.stringify([{ order_item_id: madeItemId, quantity: 2 }])],
        { code: '22023', message: 'COMPLETION_REQUEST_MISMATCH' },
      );
    });

    test('入金済みでない注文・在庫の品・受注生産中を超える数は断る', async () => {
      const unpaid = await createMixedOrder(db(), 'pending');
      const paid = await createMixedOrder(db());
      const actor = await createActor(db());
      const sql = 'select * from public.admin_record_completion($1, $2, $3, $4::jsonb)';

      await expectRejected(db(), sql, [unpaid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: unpaid.madeItemId, quantity: 1 }])], {
        code: '22023', message: 'ORDER_NOT_IN_PRODUCTION',
      });
      await expectRejected(db(), sql, [paid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: paid.stockItemId, quantity: 1 }])], {
        code: '22023', message: 'LINE_NOT_IN_PRODUCTION',
      });
      await expectRejected(db(), sql, [paid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: unpaid.madeItemId, quantity: 1 }])], {
        code: '22023', message: 'LINE_NOT_IN_PRODUCTION',
      });
      await expectRejected(db(), sql, [paid.orderId, actor.id, newKey(), JSON.stringify([{ order_item_id: paid.madeItemId, quantity: 4 }])], {
        code: '22023', message: 'QUANTITY_EXCEEDS_IN_PRODUCTION',
      });
      await expectRejected(db(), sql, [crypto.randomUUID(), actor.id, newKey(), JSON.stringify([{ order_item_id: paid.madeItemId, quantity: 1 }])], {
        code: 'P0002', message: 'ORDER_NOT_FOUND',
      });
    });

    test('行の形が違えば断る', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const sql = 'select * from public.admin_record_completion($1, $2, $3, $4::jsonb)';
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
        await expectRejected(db(), sql, [orderId, actor.id, newKey(), JSON.stringify(lines)], {
          code: '22023', message: 'COMPLETION_ARGUMENT_INVALID',
        });
      }
      await expectRejected(db(), sql, [orderId, null, newKey(), JSON.stringify([{ order_item_id: madeItemId, quantity: 1 }])], {
        code: '22023', message: 'COMPLETION_ARGUMENT_INVALID',
      });
    });

    test('取消: 受注生産中に戻る。2回目は already_cancelled。送った数を下回る取消は断る', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      const first = await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);
      const second = await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);
      await insertFulfillment(db(), orderId, [{ orderItemId: madeItemId, quantity: 1 }]);

      const cancelled = await db().query('select * from public.admin_cancel_completion($1, $2, $3)', [
        orderId, first.rows[0].completion_id, actor.id,
      ]);
      expect(cancelled.rows).toEqual([{ outcome: 'cancelled' }]);
      const again = await db().query('select * from public.admin_cancel_completion($1, $2, $3)', [
        orderId, first.rows[0].completion_id, actor.id,
      ]);
      expect(again.rows).toEqual([{ outcome: 'already_cancelled' }]);

      // 残りの仕上がりは1つ、送ったのも1つ。これを取り消すと送った数を下回る
      await expectRejected(db(), 'select * from public.admin_cancel_completion($1, $2, $3)', [orderId, second.rows[0].completion_id, actor.id], {
        code: '22023', message: 'COMPLETION_ALREADY_SHIPPED',
      });

      const row = await db().query('select cancelled_by from public.order_item_completions where id = $1', [first.rows[0].completion_id]);
      expect(row.rows[0].cancelled_by).toBe(actor.id);
      const counts = await lineCounts(db(), orderId);
      expect(counts[madeItemId]).toMatchObject({ completed: 1, shipped: 1, in_production: 2, ready_unshipped: 0 });
    });

    test('取消: ほかの注文の仕上がり・入金済みでない注文は断る', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const other = await createMixedOrder(db());
      const actor = await createActor(db());
      const done = await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);

      await expectRejected(db(), 'select * from public.admin_cancel_completion($1, $2, $3)', [other.orderId, done.rows[0].completion_id, actor.id], {
        code: 'P0002', message: 'COMPLETION_NOT_FOUND',
      });
      // 保留中の守り（order_state_transition_hardening の試験が手元の DB に当てる）が効いていても通る形にする:
      // 理由を付け、入金済みからの取消は全額返金と同じ更新で行う
      await db().query("select set_config('app.order_change_reason', 'integration_test', true)");
      await db().query(
        "update public.orders set status = 'cancelled', refunded_amount = total_amount, refunded_at = now() where id = $1",
        [orderId],
      );
      await expectRejected(db(), 'select * from public.admin_cancel_completion($1, $2, $3)', [orderId, done.rows[0].completion_id, actor.id], {
        code: '22023', message: 'ORDER_NOT_IN_PRODUCTION',
      });
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

    test('仕上がりの一覧は新しい順で、記録した人のメールを返す', async () => {
      const { orderId, madeItemId } = await createMixedOrder(db());
      const actor = await createActor(db());
      await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);

      const res = await db().query('select * from public.list_order_completions($1)', [orderId]);
      expect(res.rows).toEqual([
        expect.objectContaining({ order_item_id: madeItemId, quantity: 1, created_by_email: actor.email, cancelled_at: null, legacy: false }),
      ]);
    });
  });

  describe('在庫の数', () => {
    test('引き当て済みは確保して送っていない数、受注生産は未入金と入金済みのまだ仕上がっていない数', async () => {
      const { orderId, stockItemId, madeItemId, stockFx, madeFx } = await createMixedOrder(db());
      const actor = await createActor(db());

      let states = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [[stockFx.variantId, madeFx.variantId]]);
      const byVariant = (rows: Row[]) => Object.fromEntries(rows.map((row) => [Number(row.variant_id), row]));
      expect(byVariant(states.rows)[stockFx.variantId]).toMatchObject({ committed: 2, backorder: 0 });
      expect(byVariant(states.rows)[madeFx.variantId]).toMatchObject({ committed: 0, backorder: 3 });

      await recordCompletion(db(), orderId, actor.id, newKey(), [{ order_item_id: madeItemId, quantity: 1 }]);
      await insertFulfillment(db(), orderId, [{ orderItemId: stockItemId, quantity: 2 }]);
      states = await db().query('select * from public.list_variant_stock_states($1::bigint[])', [[stockFx.variantId, madeFx.variantId]]);
      expect(byVariant(states.rows)[stockFx.variantId]).toMatchObject({ committed: 0 });
      expect(byVariant(states.rows)[madeFx.variantId]).toMatchObject({ backorder: 2 });
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

  describe('前からの写し', () => {
    test('発送済みの注文に、全部の商品を1回で送った記録と、受注生産の品の仕上がりを作る。2回目は何もしない', async () => {
      const stockFx = await createCatalogFixture(db(), { stock: 5 });
      const madeFx = await createCatalogFixture(db(), { stock: 0 });
      const { orderId, orderItemIds } = await insertOrderWithLines(db(), {
        status: 'shipped',
        shipped: { carrier: 'sagawa', trackingNumber: 'SG-1' },
        lines: [
          { itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 2, fulfillmentType: 'stock' },
          { itemId: madeFx.itemId, variantId: madeFx.variantId, quantity: 1, fulfillmentType: 'backorder' },
        ],
      });
      // 移行 B の後は、発送のメールの行に発送の番号が要る。移行の前の行を再現するため、この取引の中だけ決まりを外す
      await db().query('alter table private.order_email_outbox drop constraint order_email_outbox_fulfillment_check');
      await db().query(
        "insert into private.order_email_outbox (order_id, kind, origin, status) values ($1, 'shipped', 'auto', 'sent')",
        [orderId],
      );

      const created = await db().query('select private.backfill_legacy_fulfillments() as created');
      expect(Number(created.rows[0].created)).toBeGreaterThanOrEqual(1);

      const fulfillments = await db().query('select * from public.order_fulfillments where order_id = $1', [orderId]);
      expect(fulfillments.rows).toEqual([
        expect.objectContaining({
          number: 1, shipping_carrier: 'sagawa', tracking_number: 'SG-1', notify_customer: true,
          completes_order: true, legacy: true, cancelled_at: null,
        }),
      ]);
      const lines = await db().query(
        'select order_item_id, quantity from public.order_fulfillment_lines where fulfillment_id = $1 order by quantity desc',
        [fulfillments.rows[0].id],
      );
      expect(lines.rows).toEqual([
        { order_item_id: orderItemIds[0], quantity: 2 },
        { order_item_id: orderItemIds[1], quantity: 1 },
      ]);
      const counts = await lineCounts(db(), orderId);
      expect(counts[orderItemIds[1]]).toMatchObject({ shipped: 1, completed: 1, in_production: 0, unshipped: 0 });

      await db().query('select private.backfill_legacy_fulfillments()');
      const again = await db().query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [orderId]);
      expect(again.rows[0].n).toBe(1);
      const completions = await db().query('select count(*)::int as n from public.order_item_completions where order_id = $1', [orderId]);
      expect(completions.rows[0].n).toBe(1);
    });

    test('発送のメールの行が無い注文は、メールを送らなかった記録になる', async () => {
      const stockFx = await createCatalogFixture(db(), { stock: 5 });
      const { orderId } = await insertOrderWithLines(db(), {
        status: 'shipped',
        shipped: { carrier: 'yamato', trackingNumber: 'YM-1' },
        lines: [{ itemId: stockFx.itemId, variantId: stockFx.variantId, quantity: 1, fulfillmentType: 'stock' }],
      });
      await db().query('select private.backfill_legacy_fulfillments()');
      const res = await db().query('select notify_customer from public.order_fulfillments where order_id = $1', [orderId]);
      expect(res.rows).toEqual([{ notify_customer: false }]);
    });
  });

  describe('権限', () => {
    test('関数を実行できるのは service_role だけ', async () => {
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
        'private.backfill_legacy_fulfillments()',
        'private.parse_fulfillment_lines(jsonb, text)',
        'private.check_order_line_fulfillment_bounds()',
      ]) {
        const res = await db().query("select has_function_privilege('service_role', $1, 'execute') as service", [fn]);
        expect(res.rows[0].service).toBe(false);
      }
    });
  });
});
