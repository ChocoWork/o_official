/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  addItemVariant,
  createShippedOrderFixture,
  insertRefundRecord,
  insertReturnReceipt,
  insertReturnRecord,
  insertReturnRefund,
  uniqueSuffix,
  variantStock,
  type RefundFixtureStatus,
  type ReturnFixtureStatus,
} from './helpers/order-fixtures';

/**
 * 返品の記録と数え方（グループ E-3 設計書 4・6・8・11 章、移行 A）。
 * 1件ごとに取引の中で動かし、終わったら戻す。返品を作る・受け取る関数（移行 B・C）はまだ無いので、返品・受け取りの記録・
 * 返品の返金は postgres で直接書く（order-fixtures.ts の insertReturnRecord・insertReturnReceipt・insertReturnRefund）。
 * 数の場面は、設計書 4-8 の式を手で計算した値（3 点注文して 3 点発送した注文に、2 点の返品を作る形が基本）と比べる。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

const APPEND_ONLY = { code: '23514', message: 'ORDER_RETURN_APPEND_ONLY' };
const IMMUTABLE = { code: '23514', message: 'ORDER_RETURN_IMMUTABLE' };
const INVALID_TRANSITION = { code: '23514', message: 'ORDER_RETURN_INVALID_TRANSITION' };

/** 新しい 6 つの表（返品の 4 つと設定の 2 つ） */
const NEW_TABLES = [
  'order_returns',
  'order_return_lines',
  'order_return_receipts',
  'order_return_receipt_lines',
  'shop_return_settings',
  'shop_return_reason_settings',
];

/** 設計書 8-3 の最初の値。理由は決まった順（TS の RETURN_REASONS と同じ） */
const INITIAL_REASON_SETTINGS = [
  { reason: 'defective', shown: true, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'make', photo: 'required', photo_instructions: '傷や不具合の場所がわかる写真をお送りください', shipping_payer: 'shop' },
  { reason: 'wrong_item', shown: true, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'make', photo: 'required', photo_instructions: '傷や不具合の場所がわかる写真をお送りください', shipping_payer: 'shop' },
  { reason: 'size_too_small', shown: true, resolutions: 'exchange_only', out_of_stock_exchange: 'decline', photo: 'optional', photo_instructions: 'タグの付いた状態がわかる写真をお送りください', shipping_payer: 'customer' },
  { reason: 'size_too_large', shown: true, resolutions: 'exchange_only', out_of_stock_exchange: 'decline', photo: 'optional', photo_instructions: 'タグの付いた状態がわかる写真をお送りください', shipping_payer: 'customer' },
  { reason: 'color', shown: false, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'decline', photo: 'optional', photo_instructions: '', shipping_payer: 'customer' },
  { reason: 'style', shown: false, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'decline', photo: 'optional', photo_instructions: '', shipping_payer: 'customer' },
  { reason: 'not_as_described', shown: false, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'decline', photo: 'optional', photo_instructions: '', shipping_payer: 'customer' },
  { reason: 'unwanted', shown: false, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'decline', photo: 'optional', photo_instructions: '', shipping_payer: 'customer' },
  { reason: 'other', shown: true, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'decline', photo: 'optional', photo_instructions: '', shipping_payer: 'customer' },
  { reason: 'unknown', shown: false, resolutions: 'refund_and_exchange', out_of_stock_exchange: 'decline', photo: 'none', photo_instructions: '', shipping_payer: 'customer' },
];

async function createActor(db: PgClient): Promise<{ id: string; email: string }> {
  const email = `order-return-records-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

/** 毎回新しく作る注文: 在庫の品（単価 5000）を quantity 点注文し、全部を 1 回で発送した */
async function createShipped(db: PgClient, quantity = 3) {
  const fx = await createShippedOrderFixture(db, { lines: [{ quantity }] });
  return {
    orderId: fx.orderId,
    orderItemId: fx.orderItemIds[0],
    itemId: fx.itemIds[0],
    variantId: fx.variantIds[0],
    fulfillmentId: fx.fulfillments[0].id,
  };
}

type ShippedOrder = Awaited<ReturnType<typeof createShipped>>;

/** 1 行だけの返品を直接書く。resolution が exchange の時の交換の色・サイズは、省くと元の品と同じ色・サイズ */
async function returnOf(
  db: PgClient,
  order: ShippedOrder,
  quantity: number,
  options: { status?: ReturnFixtureStatus; resolution?: 'refund' | 'exchange'; exchangeVariantId?: number; feeDueAmount?: number } = {},
) {
  const created = await insertReturnRecord(db, {
    orderId: order.orderId,
    status: options.status,
    feeDueAmount: options.feeDueAmount,
    lines: [
      {
        fulfillmentId: order.fulfillmentId,
        orderItemId: order.orderItemId,
        quantity,
        resolution: options.resolution,
        exchangeVariantId: options.resolution === 'exchange' ? options.exchangeVariantId ?? order.variantId : undefined,
      },
    ],
  });
  return { returnId: created.returnId, lineId: created.lineIds[0] };
}

async function countsOf(db: PgClient, orderId: string, orderItemId: string): Promise<Row> {
  const res = await db.query('select * from private.order_line_return_counts($1) where order_item_id = $2', [orderId, orderItemId]);
  return res.rows[0];
}

async function progressOf(db: PgClient, returnId: string): Promise<Row[]> {
  const res = await db.query('select * from private.order_return_line_progress($1)', [returnId]);
  return res.rows;
}

/** 発送の行ごとの返品できる数。期限の日付は、文字の日付（YYYY-MM-DD）で読む */
async function shipmentLinesOf(db: PgClient, orderId: string): Promise<Row[]> {
  const res = await db.query(
    `select fulfillment_number, order_item_id, quantity, in_returns, missing, returnable, deadline_date::text as deadline_date
     from private.fulfillment_line_returnable($1)
     order by fulfillment_number, order_item_id`,
    [orderId],
  );
  return res.rows;
}

function insertReturnRow(db: PgClient, orderId: string, extra: Record<string, string> = {}) {
  const columns: Record<string, string> = {
    order_id: '$1',
    number: '1',
    source: "'shop'",
    status: "'open'",
    request_key: 'gen_random_uuid()',
    request_fingerprint: "'f'",
    return_method: "'customer_ships'",
    return_shipping_payer: "'shop'",
    notify_customer: 'false',
    ...extra,
  };
  return db.query(
    `insert into public.order_returns (${Object.keys(columns).join(', ')}) values (${Object.values(columns).join(', ')})`,
    [orderId],
  );
}

function insertLineRow(db: PgClient, ids: { returnId: string; fulfillmentId: string; orderItemId: string }, extra: Record<string, string> = {}) {
  const columns: Record<string, string> = {
    return_id: '$1',
    fulfillment_id: '$2',
    order_item_id: '$3',
    quantity: '1',
    reason: "'defective'",
    resolution: "'refund'",
    ...extra,
  };
  return db.query(
    `insert into public.order_return_lines (${Object.keys(columns).join(', ')}) values (${Object.values(columns).join(', ')})`,
    [ids.returnId, ids.fulfillmentId, ids.orderItemId],
  );
}

function insertReceiptRow(db: PgClient, returnId: string, extra: Record<string, string> = {}) {
  const columns: Record<string, string> = {
    return_id: '$1',
    request_key: 'gen_random_uuid()',
    request_fingerprint: "'f'",
    kind: "'receive'",
    refund_choice: "'none'",
    ...extra,
  };
  return db.query(
    `insert into public.order_return_receipts (${Object.keys(columns).join(', ')}) values (${Object.values(columns).join(', ')})`,
    [returnId],
  );
}

function insertReceiptLineRow(db: PgClient, ids: { receiptId: string; returnLineId: string }, extra: Record<string, string> = {}) {
  const columns: Record<string, string> = {
    receipt_id: '$1',
    return_line_id: '$2',
    disposition: "'sent_back'",
    quantity: '1',
    ...extra,
  };
  return db.query(
    `insert into public.order_return_receipt_lines (${Object.keys(columns).join(', ')}) values (${Object.values(columns).join(', ')})`,
    [ids.receiptId, ids.returnLineId],
  );
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

/** メールの予定を直接書く（返品のお知らせの列と一意の決まりの試験用）。origin の既定は auto */
function insertEmailRow(
  db: PgClient,
  orderId: string,
  kind: string,
  extra: { variant?: string | null; origin?: string; returnId?: string | null; receiptId?: string | null; refundId?: string | null } = {},
) {
  return db.query(
    `insert into private.order_email_outbox (order_id, kind, variant, origin, return_id, return_receipt_id, refund_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [orderId, kind, extra.variant ?? null, extra.origin ?? 'auto', extra.returnId ?? null, extra.receiptId ?? null, extra.refundId ?? null],
  );
}

describeLocalDb('integration: 返品の記録と数え方（移行 A）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('表・関数・権限の守り', () => {
    test('お客様とログインした人は読めず、アプリは読むだけ（返品の4つの表と設定の2つの表）', async () => {
      for (const table of NEW_TABLES) {
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
                  has_table_privilege('service_role', $1::text, 'update') as can_update,
                  has_table_privilege('service_role', $1::text, 'delete') as can_delete`,
          [`public.${table}`],
        );
        expect(privileges.rows[0]).toEqual({ can_select: true, can_insert: false, can_update: false, can_delete: false });
      }
    });

    test('行の守りが 6 つの表で有効で、anon・authenticated を RESTRICTIVE の方針で全部断る', async () => {
      const enabled = await db().query(
        `select c.relname, c.relrowsecurity
         from pg_class as c
         where c.relnamespace = 'public'::regnamespace and c.relname = any($1::text[])
         order by c.relname`,
        [NEW_TABLES],
      );
      expect(enabled.rows).toEqual([...NEW_TABLES].sort().map((relname) => ({ relname, relrowsecurity: true })));

      const policies = await db().query(
        `select tablename, permissive, (select string_agg(r, ',' order by r) from unnest(roles) as r) as roles
         from pg_policies
         where schemaname = 'public' and tablename = any($1::text[]) and policyname = 'deny direct client access'
         order by tablename`,
        [NEW_TABLES],
      );
      expect(policies.rows).toEqual(
        [...NEW_TABLES].sort().map((tablename) => ({ tablename, permissive: 'RESTRICTIVE', roles: 'anon,authenticated' })),
      );
    });

    test('権限の行 admin.orders.return がある。移行の「役割に付ける文」は、店長とサポートの役割だけに付け、何度流しても同じ', async () => {
      const permission = await db().query("select code, name from public.permissions where code = 'admin.orders.return'");
      expect(permission.rows).toEqual([{ code: 'admin.orders.return', name: '注文の返品' }]);

      // 手元の DB には役割の行が無い（本番にはある）ので、役割をこの取引の中だけ作ってから、移行の中の文をそのまま流す。
      // 版の頭の数字は本番に当てる時に付け替わるので、移行のファイルは名前の後ろで探す
      await db().query(
        "insert into public.roles (code, name) values ('admin', '店長'), ('supporter', 'サポート'), ('user', 'お客様') on conflict (code) do nothing",
      );
      const directory = path.join(process.cwd(), 'supabase/migrations');
      const files = fs.readdirSync(directory).filter((name) => name.endsWith('_order_return_records.sql'));
      expect(files).toHaveLength(1);
      const migration = fs.readFileSync(path.join(directory, files[0]), 'utf8');
      const linkStatement = migration.match(/INSERT INTO public\.role_permissions[\s\S]*?ON CONFLICT DO NOTHING;/)?.[0];
      expect(linkStatement).toBeDefined();
      await db().query(linkStatement as string);
      await db().query(linkStatement as string);

      const linked = await db().query(
        `select r.code as role_code
         from public.role_permissions as rp
         join public.roles as r on r.id = rp.role_id
         join public.permissions as p on p.id = rp.permission_id
         where p.code = 'admin.orders.return'
         order by r.code`,
      );
      expect(linked.rows).toEqual([{ role_code: 'admin' }, { role_code: 'supporter' }]);
    });

    test('作った public の関数を実行できるのは service_role だけ。private の関数は service_role も実行できない', async () => {
      for (const fn of [
        'public.list_order_line_return_counts(uuid[])',
        'public.get_shop_return_settings()',
        'public.list_item_stock_history(bigint, integer)',
      ]) {
        const res = await db().query(
          `select has_function_privilege('anon', $1, 'execute') as anon,
                  has_function_privilege('authenticated', $1, 'execute') as authed,
                  has_function_privilege('service_role', $1, 'execute') as service`,
          [fn],
        );
        expect({ fn, ...res.rows[0] }).toEqual({ fn, anon: false, authed: false, service: true });
      }
      for (const fn of [
        'private.guard_order_return_change()',
        'private.reject_order_return_record_change()',
        'private.check_return_line_order()',
        'private.check_receipt_line_return()',
        'private.enqueue_order_email(uuid, text, text, uuid, uuid)',
        'private.order_line_reservations(uuid)',
        'private.order_return_line_states(uuid)',
        'private.order_return_line_states_core(uuid,jsonb)',
        'private.order_return_line_progress(uuid)',
        'private.order_line_return_counts(uuid)',
        'private.fulfillment_line_returnable(uuid)',
        'private.refresh_order_return_status(uuid)',
      ]) {
        const res = await db().query("select has_function_privilege('service_role', $1, 'execute') as service", [fn]);
        expect({ fn, service: res.rows[0].service }).toEqual({ fn, service: false });
      }
    });
  });

  describe('返品の表の決まり', () => {
    test('手数料をいただかない時は、受け取りの時刻と人の両方が要る', async () => {
      const order = await createShipped(db(), 1);
      const created = await returnOf(db(), order, 1);
      const actor = await createActor(db());
      for (const set of [
        'fee_waived = true',
        'fee_waived = true, fee_received_at = now()',
        'fee_waived = true, fee_received_by = $2',
      ]) {
        await expectRejected(db(), `update public.order_returns set ${set} where id = $1`,
          set.includes('$2') ? [created.returnId, actor.id] : [created.returnId],
          { code: '23514', constraint: 'order_returns_fee_waived_check' });
      }
      await db().query('update public.order_returns set fee_waived = true, fee_received_at = now(), fee_received_by = $2 where id = $1',
        [created.returnId, actor.id]);
      const saved = await db().query('select fee_waived from public.order_returns where id = $1', [created.returnId]);
      expect(saved.rows[0].fee_waived).toBe(true);
    });

    test('値の決まり: 道・状態・返送の方法と負担・配送業者・伝票番号の形・手数料の範囲・文の長さ', async () => {
      const order = await createShipped(db(), 1);
      const refused: Array<[Record<string, string>, string]> = [
        // 道・状態・番号
        [{ source: "'x'" }, 'order_returns_source_check'],
        [{ status: "'x'" }, 'order_returns_status_check'],
        [{ number: '0' }, 'order_returns_number_check'],
        // 返送の方法・返送料の負担・配送業者・伝票番号の形
        [{ return_method: "'x'" }, 'order_returns_return_method_check'],
        [{ return_shipping_payer: "'x'" }, 'order_returns_return_shipping_payer_check'],
        [{ return_carrier: "'fedex'" }, 'order_returns_return_carrier_check'],
        [{ return_tracking_number: "'bad number'" }, 'order_returns_return_tracking_number_check'],
        // お断り（段 2）の理由とメッセージは 1000 字まで
        [{ decline_reason: "'x'" }, 'order_returns_decline_reason_check'],
        [{ decline_message: "repeat('あ', 1001)" }, 'order_returns_decline_message_check'],
        // 手数料の額は 0 以上、返品の手数料の % は 0〜100
        [{ return_shipping_fee: '-1' }, 'order_returns_return_shipping_fee_check'],
        [{ exchange_fee: '-1' }, 'order_returns_exchange_fee_check'],
        [{ exchange_shipping_fee: '-1' }, 'order_returns_exchange_shipping_fee_check'],
        [{ fee_due_amount: '-1' }, 'order_returns_fee_due_amount_check'],
        [{ fee_settled_amount: '-1' }, 'order_returns_fee_settled_amount_check'],
        [{ fee_pending_deduction: '-1' }, 'order_returns_fee_pending_deduction_check'],
        [{ restocking_fee_percent: '101' }, 'order_returns_restocking_fee_percent_check'],
        [{ restocking_fee_percent: '-1' }, 'order_returns_restocking_fee_percent_check'],
        // 手数料の受け取りのメモと店のメモは 500 字まで
        [{ fee_received_note: "repeat('あ', 501)" }, 'order_returns_fee_received_note_check'],
        [{ shop_note: "repeat('あ', 501)" }, 'order_returns_shop_note_check'],
      ];
      for (const [extra, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(insertReturnRow(db(), order.orderId, extra)).rejects.toMatchObject({ code: '23514', constraint });
        await db().query('rollback to savepoint check_case');
      }

      // 範囲の端は通る
      await insertReturnRow(db(), order.orderId, {
        number: '1',
        restocking_fee_percent: '100',
        decline_message: "repeat('あ', 1000)",
        fee_received_note: "repeat('あ', 500)",
        shop_note: "repeat('あ', 500)",
        return_carrier: "'other'",
        return_tracking_number: "'1234-5678-9012'",
      });
      await insertReturnRow(db(), order.orderId, { number: '2', restocking_fee_percent: '0', status: "'requested'", source: "'customer_request'" });
      const count = await db().query('select count(*)::int as n from public.order_returns where order_id = $1', [order.orderId]);
      expect(count.rows[0].n).toBe(2);
    });

    test('番号は注文の中で一意。二重防止の番号は表全体で一意（制約の名前は移行 B が見分けに使う）', async () => {
      const first = await createShipped(db(), 1);
      const second = await createShipped(db(), 1);
      const requestKey = crypto.randomUUID();
      await insertReturnRow(db(), first.orderId, { number: '1', request_key: `'${requestKey}'` });

      await expectRejected(db(), `insert into public.order_returns
          (order_id, number, source, status, request_key, request_fingerprint, return_method, return_shipping_payer, notify_customer)
        values ($1, 1, 'shop', 'open', gen_random_uuid(), 'f', 'customer_ships', 'shop', false)`, [first.orderId], {
        code: '23505',
        constraint: 'order_returns_order_id_number_key',
      });
      // ほかの注文でも、同じ二重防止の番号は使えない
      await expectRejected(db(), `insert into public.order_returns
          (order_id, number, source, status, request_key, request_fingerprint, return_method, return_shipping_payer, notify_customer)
        values ($1, 1, 'shop', 'open', $2, 'f', 'customer_ships', 'shop', false)`, [second.orderId, requestKey], {
        code: '23505',
        constraint: 'order_returns_request_key_key',
      });
      // ほかの注文なら、同じ番号 1 は使える
      await insertReturnRow(db(), second.orderId, { number: '1' });
    });

    test('直せるのは、状態・時刻・する人・手数料の受け取り（いただかない印 fee_waived を含む）・支払いを待たずに送る・手数料の額（決着した合計 fee_settled_amount を含む）の列だけ。ほかの列は直せない', async () => {
      const order = await createShipped(db(), 3);
      const other = await createShipped(db(), 1);
      const actor = await createActor(db());
      const created = await returnOf(db(), order, 1);

      for (const set of [
        'number = 99',
        "source = 'customer_request'",
        'request_key = gen_random_uuid()',
        "request_fingerprint = 'other'",
        "return_method = 'not_required'",
        "return_shipping_payer = 'customer'",
        "return_carrier = 'yamato'",
        "return_tracking_number = 'ABC-123'",
        'return_shipping_fee = 100',
        'exchange_fee = 100',
        'exchange_shipping_fee = 100',
        'restocking_fee_percent = 10',
        'notify_customer = true',
        "shop_note = 'あとから書き換え'",
        "created_at = now() - interval '1 day'",
        'created_by = gen_random_uuid()',
        'requested_at = now()',
        'requested_by = gen_random_uuid()',
      ]) {
        await expectRejected(db(), `update public.order_returns set ${set} where id = $1`, [created.returnId], IMMUTABLE);
      }
      await expectRejected(db(), 'update public.order_returns set order_id = $2 where id = $1', [created.returnId, other.orderId], IMMUTABLE);

      // 直せる列は、1 つずつ書ける（$2 を使う文にだけ、した人の番号を渡す）
      for (const set of [
        'approved_at = now()',
        'approved_by = $2',
        'declined_at = now()',
        'declined_by = $2',
        "decline_reason = 'final_sale'",
        "decline_message = 'お断りの文'",
        'closed_at = now()',
        'cancelled_at = now()',
        'cancelled_by = $2',
        'reopened_at = now()',
        'reopened_by = $2',
        'fee_due_amount = 300',
        'fee_settled_amount = 100',
        'fee_pending_deduction = 200',
        'fee_received_at = now()',
        'fee_received_by = $2',
        "fee_received_note = '現金で受け取り'",
        'fee_waived = true',
        'exchange_released_at = now()',
        'exchange_released_by = $2',
      ]) {
        await db().query(
          `update public.order_returns set ${set} where id = $1`,
          set.includes('$2') ? [created.returnId, actor.id] : [created.returnId],
        );
      }
      const saved = await db().query(
        'select fee_due_amount, fee_settled_amount, fee_pending_deduction, fee_received_note, fee_waived, status from public.order_returns where id = $1',
        [created.returnId],
      );
      expect(saved.rows[0]).toEqual({
        fee_due_amount: 300,
        fee_settled_amount: 100,
        fee_pending_deduction: 200,
        fee_received_note: '現金で受け取り',
        fee_waived: true,
        status: 'open',
      });
    });

    test('決着した手数料の合計 fee_settled_amount は最初は0で、空にも負にもできない', async () => {
      const order = await createShipped(db(), 1);
      const created = await returnOf(db(), order, 1);
      const settledOf = async () =>
        (await db().query('select fee_settled_amount from public.order_returns where id = $1', [created.returnId])).rows[0].fee_settled_amount as number;
      expect(await settledOf()).toBe(0);
      await expectRejected(db(), 'update public.order_returns set fee_settled_amount = null where id = $1', [created.returnId], { code: '23502' });
      await expectRejected(db(), 'update public.order_returns set fee_settled_amount = -1 where id = $1', [created.returnId],
        { code: '23514', constraint: 'order_returns_fee_settled_amount_check' });
      expect(await settledOf()).toBe(0);
    });

    test('手数料をいただかないことにした印 fee_waived は、返品を作った時の値が偽で、空にはできない', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 1);
      const waivedOf = async () =>
        (await db().query('select fee_waived from public.order_returns where id = $1', [created.returnId])).rows[0].fee_waived as boolean;

      expect(await waivedOf()).toBe(false);

      // 守りは fee_waived の更新を通すので、空にしようとすると列の NOT NULL が断る
      await expectRejected(db(), 'update public.order_returns set fee_waived = null where id = $1', [created.returnId], { code: '23502' });
      expect(await waivedOf()).toBe(false);
    });

    test.each<[ReturnFixtureStatus, ReturnFixtureStatus]>([
      ['requested', 'open'],
      ['requested', 'declined'],
      ['open', 'closed'],
      ['open', 'cancelled'],
      ['closed', 'open'],
      ['open', 'open'],
    ])('状態 %s から %s へ進める', async (from, to) => {
      const order = await createShipped(db(), 3);
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        status: from,
        lines: [{ fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId, quantity: 1 }],
      });

      await db().query('update public.order_returns set status = $2 where id = $1', [created.returnId, to]);

      const res = await db().query('select status from public.order_returns where id = $1', [created.returnId]);
      expect(res.rows[0].status).toBe(to);
    });

    test.each<[ReturnFixtureStatus, ReturnFixtureStatus]>([
      ['requested', 'closed'],
      ['requested', 'cancelled'],
      ['open', 'requested'],
      ['open', 'declined'],
      ['closed', 'requested'],
      ['closed', 'cancelled'],
      ['closed', 'declined'],
      ['cancelled', 'open'],
      ['cancelled', 'closed'],
      ['declined', 'open'],
      ['declined', 'requested'],
    ])('状態 %s から %s へは進めない', async (from, to) => {
      const order = await createShipped(db(), 3);
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        status: from,
        lines: [{ fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId, quantity: 1 }],
      });

      await expectRejected(db(), 'update public.order_returns set status = $2 where id = $1', [created.returnId, to], INVALID_TRANSITION);
    });

    test('返品は消せない。TRUNCATE を止める文のトリガーが、返品の4つの表にある', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 1);

      await expectRejected(db(), 'delete from public.order_returns where id = $1', [created.returnId], APPEND_ONLY);

      const res = await db().query(
        `select c.relname || ':' || t.tgname as trigger_name
         from pg_trigger as t
         join pg_class as c on c.oid = t.tgrelid
         where c.relnamespace = 'public'::regnamespace
           and c.relname in ('order_returns', 'order_return_lines', 'order_return_receipts', 'order_return_receipt_lines')
           and not t.tgisinternal
           and (t.tgtype & 32) = 32`,
      );
      expect(res.rows.map((row) => row.trigger_name as string).sort()).toEqual([
        'order_return_lines:order_return_lines_no_truncate',
        'order_return_receipt_lines:order_return_receipt_lines_no_truncate',
        'order_return_receipts:order_return_receipts_no_truncate',
        'order_returns:order_returns_no_truncate',
      ]);
    });
  });

  describe('返品の行の決まり', () => {
    test('返金の行に交換の色・サイズだけ、または送り方だけを付ける形も断る', async () => {
      const order = await createShipped(db(), 1);
      const created = await returnOf(db(), order, 1);
      const ids = { returnId: created.returnId, fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId };
      const refused: Array<Record<string, string>> = [{ exchange_variant_id: String(order.variantId) }, { exchange_method: "'stock'" }];
      for (const extra of refused) {
        await db().query('savepoint check_case');
        await expect(insertLineRow(db(), ids, extra)).rejects.toMatchObject({
          code: '23514', constraint: 'order_return_lines_exchange_check',
        });
        await db().query('rollback to savepoint check_case');
      }
    });

    test('交換の色・サイズの外部キー2つには、空でない行だけの索引がある', async () => {
      const indexes = await db().query(
        `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'order_return_lines'
         and indexname in ('order_return_lines_requested_exchange_variant_idx', 'order_return_lines_exchange_variant_idx')`,
      );
      expect(indexes.rows).toHaveLength(2);
      for (const column of ['requested_exchange_variant_id', 'exchange_variant_id']) {
        const name = column === 'requested_exchange_variant_id'
          ? 'order_return_lines_requested_exchange_variant_idx' : 'order_return_lines_exchange_variant_idx';
        expect(indexes.rows.find((row) => row.indexname === name)?.indexdef).toContain(`(${column}) WHERE (${column} IS NOT NULL)`);
      }
    });

    test('解決が交換なら交換の色・サイズと送り方が両方要り、返金なら両方付けられない', async () => {
      const order = await createShipped(db(), 3);
      const other = await addItemVariant(db(), { itemId: order.itemId, colorName: 'BLUE', sizeLabel: 'L', stock: 2 });
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        lines: [{ fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId, quantity: 1 }],
      });
      const ids = { returnId: created.returnId, fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId };
      const variant = String(order.variantId);

      const refused: Array<Record<string, string>> = [
        { exchange_variant_id: variant, exchange_method: "'stock'" },
        { resolution: "'exchange'", exchange_method: "'stock'" },
        { resolution: "'exchange'", exchange_variant_id: variant },
        { resolution: "'exchange'" },
      ];
      for (const extra of refused) {
        await db().query('savepoint check_case');
        await expect(insertLineRow(db(), ids, extra)).rejects.toMatchObject({
          code: '23514',
          constraint: 'order_return_lines_exchange_check',
        });
        await db().query('rollback to savepoint check_case');
      }

      // 返金（交換の列は空）、交換（同じ色・サイズで在庫から）、交換（色違いで作って送る）は通る。
      // 同じ発送の行から、同じ返品に何行でも書ける（1 点は返金、1 点は交換にする時は行を分ける）
      await insertLineRow(db(), ids, {});
      await insertLineRow(db(), ids, { resolution: "'exchange'", exchange_variant_id: variant, exchange_method: "'stock'" });
      await insertLineRow(db(), ids, { resolution: "'exchange'", exchange_variant_id: String(other.variantId), exchange_method: "'make'" });
      const lines = await db().query(
        'select resolution, exchange_variant_id, exchange_method from public.order_return_lines where return_id = $1 order by resolution, exchange_method nulls first',
        [created.returnId],
      );
      expect(lines.rows).toHaveLength(4);
    });

    test('値の決まり: 数・理由・メモの長さ・ご希望・解決・送り方。交換の色・サイズは実在するバリアントだけ', async () => {
      const order = await createShipped(db(), 3);
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        lines: [{ fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId, quantity: 1 }],
      });
      const ids = { returnId: created.returnId, fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId };
      const refused: Array<[Record<string, string>, string, string]> = [
        [{ quantity: '0' }, '23514', 'order_return_lines_quantity_check'],
        [{ reason: "'x'" }, '23514', 'order_return_lines_reason_check'],
        [{ reason_note: "repeat('あ', 256)" }, '23514', 'order_return_lines_reason_note_check'],
        [{ customer_note: "repeat('あ', 301)" }, '23514', 'order_return_lines_customer_note_check'],
        [{ requested_resolution: "'x'" }, '23514', 'order_return_lines_requested_resolution_check'],
        [{ resolution: "'x'" }, '23514', 'order_return_lines_resolution_check'],
        [{ resolution: "'exchange'", exchange_variant_id: String(order.variantId), exchange_method: "'x'" }, '23514', 'order_return_lines_exchange_method_check'],
        [{ resolution: "'exchange'", exchange_variant_id: '999999999', exchange_method: "'stock'" }, '23503', 'order_return_lines_exchange_variant_id_fkey'],
        [{ requested_exchange_variant_id: '999999999' }, '23503', 'order_return_lines_requested_exchange_variant_id_fkey'],
      ];
      for (const [extra, code, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(insertLineRow(db(), ids, extra)).rejects.toMatchObject({ code, constraint });
        await db().query('rollback to savepoint check_case');
      }

      // 理由は 10 個すべて、メモは上限の長さまで通る
      for (const reason of ['defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style', 'not_as_described', 'unwanted', 'other', 'unknown']) {
        await insertLineRow(db(), ids, { reason: `'${reason}'` });
      }
      await insertLineRow(db(), ids, { reason_note: "repeat('あ', 255)", customer_note: "repeat('あ', 300)", requested_resolution: "'exchange'" });
    });

    test('返品の行は、その返品の注文の発送の行だけを指せる', async () => {
      const order = await createShipped(db(), 3);
      const other = await createShipped(db(), 2);
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        lines: [{ fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId, quantity: 1 }],
      });

      // ほかの注文の発送を指す: 返品の注文と違うので、トリガーが断る
      await expectRejected(
        db(),
        `insert into public.order_return_lines (return_id, fulfillment_id, order_item_id, quantity, reason, resolution)
         values ($1, $2, $3, 1, 'defective', 'refund')`,
        [created.returnId, other.fulfillmentId, other.orderItemId],
        { code: '22023', message: 'RETURN_LINE_NOT_IN_ORDER' },
      );
      // 発送の行に無い組（同じ発送に、ほかの注文の商品）: 外部キーが断る
      await expectRejected(
        db(),
        `insert into public.order_return_lines (return_id, fulfillment_id, order_item_id, quantity, reason, resolution)
         values ($1, $2, $3, 1, 'defective', 'refund')`,
        [created.returnId, order.fulfillmentId, other.orderItemId],
        { code: '23503', constraint: 'order_return_lines_fulfillment_line_fkey' },
      );
    });

    test('受付中（open）の返品の行は、作った後に一切変えられず、消せない（申し込み中の返品の行は、承認で決める 3 列だけ移行 D の守りが開ける）', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);

      for (const set of ['quantity = 1', "reason = 'other'", "resolution = 'exchange'", "reason_note = '書き換え'", 'created_at = now()']) {
        await expectRejected(db(), `update public.order_return_lines set ${set} where id = $1`, [created.lineId], APPEND_ONLY);
      }
      await expectRejected(db(), 'delete from public.order_return_lines where id = $1', [created.lineId], APPEND_ONLY);
    });
  });

  describe('受け取りの記録の決まり', () => {
    test('種類が receive の時だけ返金の選び方が要る。種類と返金の選び方の値の決まり', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);

      const mismatched: Array<Record<string, string>> = [
        { refund_choice: 'null' },
        { kind: "'inspect'", refund_choice: "'none'" },
        { kind: "'close_missing'", refund_choice: "'consult'" },
        { kind: "'reopen'", refund_choice: "'now'" },
        { kind: "'waive_refund'", refund_choice: "'none'" },
      ];
      for (const extra of mismatched) {
        await db().query('savepoint check_case');
        await expect(insertReceiptRow(db(), created.returnId, extra)).rejects.toMatchObject({
          code: '23514',
          constraint: 'order_return_receipts_kind_choice_check',
        });
        await db().query('rollback to savepoint check_case');
      }
      const refused: Array<[Record<string, string>, string]> = [
        [{ kind: "'x'", refund_choice: 'null' }, 'order_return_receipts_kind_check'],
        [{ refund_choice: "'x'" }, 'order_return_receipts_refund_choice_check'],
        [{ sent_back_carrier: "'fedex'" }, 'order_return_receipts_sent_back_carrier_check'],
        [{ sent_back_tracking_number: "'bad number'" }, 'order_return_receipts_sent_back_tracking_number_check'],
        [{ sent_back_message: "repeat('あ', 1001)" }, 'order_return_receipts_sent_back_message_check'],
        [{ note: "repeat('あ', 501)" }, 'order_return_receipts_note_check'],
      ];
      for (const [extra, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(insertReceiptRow(db(), created.returnId, extra)).rejects.toMatchObject({ code: '23514', constraint });
        await db().query('rollback to savepoint check_case');
      }

      const accepted: Array<Record<string, string>> = [
        { refund_choice: "'now'" },
        { refund_choice: "'consult'" },
        { refund_choice: "'none'", sent_back_message: "repeat('あ', 1000)", sent_back_carrier: "'japanpost'", sent_back_tracking_number: "'1234-5678'" },
        { kind: "'inspect'", refund_choice: 'null' },
        { kind: "'close_missing'", refund_choice: 'null' },
        { kind: "'reopen'", refund_choice: 'null', note: "repeat('あ', 500)" },
        { kind: "'waive_refund'", refund_choice: 'null' },
      ];
      for (const extra of accepted) {
        await insertReceiptRow(db(), created.returnId, extra);
      }
      const count = await db().query('select count(*)::int as n from public.order_return_receipts where return_id = $1', [created.returnId]);
      expect(count.rows[0].n).toBe(7);
    });

    test('二重防止の番号は表全体で一意。制約の名前は移行 B・C が見分けに使う', async () => {
      const first = await createShipped(db(), 3);
      const second = await createShipped(db(), 3);
      const firstReturn = await returnOf(db(), first, 1);
      const secondReturn = await returnOf(db(), second, 1);
      const requestKey = crypto.randomUUID();
      await insertReceiptRow(db(), firstReturn.returnId, { request_key: `'${requestKey}'` });

      await expectRejected(
        db(),
        `insert into public.order_return_receipts (return_id, request_key, request_fingerprint, kind, refund_choice)
         values ($1, $2, 'f', 'receive', 'none')`,
        [secondReturn.returnId, requestKey],
        { code: '23505', constraint: 'order_return_receipts_request_key_key' },
      );
    });

    test('受け取りの記録と商品の扱いは追記だけ（直せず、消せない）。TRUNCATE を止めるトリガーは別の試験が確かめる', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);
      const receipt = await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 1 }],
      });

      await expectRejected(db(), "update public.order_return_receipts set note = '書き換え' where id = $1", [receipt.receiptId], APPEND_ONLY);
      await expectRejected(db(), 'delete from public.order_return_receipts where id = $1', [receipt.receiptId], APPEND_ONLY);
      await expectRejected(db(), 'update public.order_return_receipt_lines set quantity = 2 where receipt_id = $1', [receipt.receiptId], APPEND_ONLY);
      await expectRejected(db(), 'delete from public.order_return_receipt_lines where receipt_id = $1', [receipt.receiptId], APPEND_ONLY);
    });
  });

  describe('受け取りの商品の扱いの決まり', () => {
    async function createReceipt(client: PgClient) {
      const order = await createShipped(client, 5);
      const created = await returnOf(client, order, 3);
      const receipt = await client.query(
        `insert into public.order_return_receipts (return_id, request_key, request_fingerprint, kind, refund_choice)
         values ($1, gen_random_uuid(), 'f', 'receive', 'consult') returning id`,
        [created.returnId],
      );
      return { order, created, ids: { receiptId: receipt.rows[0].id as string, returnLineId: created.lineId } };
    }

    test('扱いの値は 9 つ。数は 1 以上。知らない扱いと 0 点は断る', async () => {
      const { ids } = await createReceipt(db());
      await db().query('savepoint check_case');
      await expect(insertReceiptLineRow(db(), ids, { disposition: "'x'" })).rejects.toMatchObject({
        code: '23514',
        constraint: 'order_return_receipt_lines_disposition_check',
      });
      await db().query('rollback to savepoint check_case');
      await db().query('savepoint check_case');
      await expect(insertReceiptLineRow(db(), ids, { quantity: '0' })).rejects.toMatchObject({
        code: '23514',
        constraint: 'order_return_receipt_lines_quantity_check',
      });
      await db().query('rollback to savepoint check_case');

      // 受け取った品の 3 つは解決が要る。ほかの 6 つは解決を持たない
      for (const disposition of ['restocked', 'not_restocked', 'pending_inspection']) {
        await insertReceiptLineRow(db(), ids, { disposition: `'${disposition}'`, resolution: "'refund'" });
      }
      for (const disposition of ['inspected_restocked', 'inspected_not_restocked', 'sent_back', 'missing', 'missing_reopened', 'refund_waived']) {
        await insertReceiptLineRow(db(), ids, { disposition: `'${disposition}'` });
      }
      const count = await db().query('select count(*)::int as n from public.order_return_receipt_lines where receipt_id = $1', [ids.receiptId]);
      expect(count.rows[0].n).toBe(9);
    });

    test('受け取った品の行は実際の解決が要り、交換の時だけ送り方が付く。ほかの扱いは解決も送り方も持たない', async () => {
      const { ids } = await createReceipt(db());
      const refused: Array<[Record<string, string>, string]> = [
        // 受け取った品に解決が無い
        [{ disposition: "'restocked'" }, 'order_return_receipt_lines_received_check'],
        // お返しに解決が付く
        [{ disposition: "'sent_back'", resolution: "'refund'" }, 'order_return_receipt_lines_received_check'],
        // 返金しないことにした数に解決が付く
        [{ disposition: "'refund_waived'", resolution: "'refund'" }, 'order_return_receipt_lines_received_check'],
        // 交換なのに送り方が無い
        [{ disposition: "'restocked'", resolution: "'exchange'" }, 'order_return_receipt_lines_exchange_check'],
        // 返金なのに送り方がある
        [{ disposition: "'restocked'", resolution: "'refund'", exchange_method: "'stock'" }, 'order_return_receipt_lines_exchange_check'],
        // 解決が無いのに送り方だけある（上の 2 つの CHECK は、解決が空だと結果が空になって通すので、3 つめの CHECK が断つ）
        [{ disposition: "'sent_back'", exchange_method: "'stock'" }, 'order_return_receipt_lines_method_check'],
        // 解決・送り方の値
        [{ disposition: "'restocked'", resolution: "'x'" }, 'order_return_receipt_lines_resolution_check'],
        [{ disposition: "'restocked'", resolution: "'exchange'", exchange_method: "'x'" }, 'order_return_receipt_lines_exchange_method_check'],
      ];
      for (const [extra, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(insertReceiptLineRow(db(), ids, extra)).rejects.toMatchObject({ code: '23514', constraint });
        await db().query('rollback to savepoint check_case');
      }
      await insertReceiptLineRow(db(), ids, { disposition: "'restocked'", resolution: "'exchange'", exchange_method: "'stock'" });
      await insertReceiptLineRow(db(), ids, { disposition: "'restocked'", resolution: "'exchange'", exchange_method: "'make'" });
      await insertReceiptLineRow(db(), ids, { disposition: "'restocked'", resolution: "'refund'" });
    });

    test('同じ受け取りで、同じ返品の行・扱い・解決・送り方は 2 回書けない（空も同じ値とみなす）', async () => {
      const { ids } = await createReceipt(db());
      await insertReceiptLineRow(db(), ids, { disposition: "'sent_back'" });
      await insertReceiptLineRow(db(), ids, { disposition: "'restocked'", resolution: "'exchange'", exchange_method: "'stock'" });

      await expectRejected(db(), `insert into public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity)
        values ($1, $2, 'sent_back', 1)`, [ids.receiptId, ids.returnLineId], {
        code: '23505',
        constraint: 'order_return_receipt_lines_line_key',
      });
      await expectRejected(db(), `insert into public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity, resolution, exchange_method)
        values ($1, $2, 'restocked', 1, 'exchange', 'stock')`, [ids.receiptId, ids.returnLineId], {
        code: '23505',
        constraint: 'order_return_receipt_lines_line_key',
      });
      // 送り方が違えば別の行
      await insertReceiptLineRow(db(), ids, { disposition: "'restocked'", resolution: "'exchange'", exchange_method: "'make'" });
    });

    test('受け取りの商品の扱いは、その受け取りの返品の行だけを指せる', async () => {
      const order = await createShipped(db(), 5);
      const first = await returnOf(db(), order, 1);
      const second = await returnOf(db(), order, 1);
      const receipt = await insertReturnReceipt(db(), { returnId: first.returnId, lines: [] });

      await expectRejected(
        db(),
        `insert into public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity)
         values ($1, $2, 'sent_back', 1)`,
        [receipt.receiptId, second.lineId],
        { code: '22023', message: 'RECEIPT_LINE_NOT_IN_RETURN' },
      );
    });
  });

  describe('今の表の変更', () => {
    test('交換の品の行: 種類 exchange は返品の行と元の支払額が要り、値段は 0。ふつうの行は交換の列を持たない。今の行は全部 order', async () => {
      const order = await createShipped(db(), 2);
      const created = await returnOf(db(), order, 1, { resolution: 'exchange' });
      const insertItem = (extra: Record<string, string>) => {
        const columns: Record<string, string> = {
          order_id: '$1',
          item_id: '$2',
          item_name: "'照合テスト'",
          item_price: '0',
          color: "'BLACK'",
          size: "'M'",
          quantity: '1',
          line_total: '0',
          variant_id: '$3',
          fulfillment_type: "'stock'",
          line_kind: "'exchange'",
          exchange_return_line_id: '$4',
          exchange_paid_amount: '5000',
          ...extra,
        };
        const sql = `insert into public.order_items (${Object.keys(columns).join(', ')}) values (${Object.values(columns).join(', ')})`;
        // 返品の行の番号（$4）を空に書き換えた文は、$4 を使わないので渡さない
        const params = [order.orderId, order.itemId, order.variantId, created.lineId];
        return db().query(sql, sql.includes('$4') ? params : params.slice(0, 3));
      };

      const refused: Array<[Record<string, string>, string]> = [
        // 交換の品に返品の行が無い・元の支払額が無い・値段が付いている
        [{ exchange_return_line_id: 'null' }, 'order_items_exchange_check'],
        [{ exchange_paid_amount: 'null' }, 'order_items_exchange_check'],
        [{ item_price: '5000' }, 'order_items_exchange_check'],
        [{ line_total: '5000' }, 'order_items_exchange_check'],
        // ふつうの行に交換の列が付いている
        [{ line_kind: "'order'" }, 'order_items_exchange_check'],
        [{ line_kind: "'order'", exchange_paid_amount: 'null' }, 'order_items_exchange_check'],
        [{ line_kind: "'order'", exchange_return_line_id: 'null' }, 'order_items_exchange_check'],
        // 元の支払額は 0 以上（知らない種類は、種類と交換の列の組の CHECK が先に断る）
        [{ exchange_paid_amount: '-1' }, 'order_items_exchange_paid_amount_check'],
        [{ line_kind: "'x'" }, 'order_items_exchange_check'],
      ];
      for (const [extra, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(insertItem(extra)).rejects.toMatchObject({ code: '23514', constraint });
        await db().query('rollback to savepoint check_case');
      }

      // 交換の品の行（在庫から・作って送る）と、交換の列の無いふつうの行は通る
      await insertItem({});
      await insertItem({ fulfillment_type: "'backorder'", exchange_paid_amount: '0' });
      await insertItem({ line_kind: "'order'", exchange_return_line_id: 'null', exchange_paid_amount: 'null', item_price: '5000', line_total: '5000' });

      const kinds = await db().query(
        'select line_kind, count(*)::int as n from public.order_items where order_id = $1 group by line_kind order by line_kind',
        [order.orderId],
      );
      // 発送した元の品 1 行 + 足した 3 行（交換 2・ふつう 1）
      expect(kinds.rows).toEqual([
        { line_kind: 'exchange', n: 2 },
        { line_kind: 'order', n: 2 },
      ]);
    });

    test('返金の道 return には返品の番号が要り、ほかの道には付けられない。今の道は今までどおり通る', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 1);
      const requestPair = { request_key: 'gen_random_uuid()', request_fingerprint: "'f'" };
      const stripeId = () => `'re_x${uniqueSuffix()}'`;
      const returnId = `'${created.returnId}'`;

      const refused: Array<[Record<string, string>, string]> = [
        // 道が return なのに返品の番号が無い
        [{ source: "'return'", ...requestPair }, 'order_refunds_return_check'],
        // 返品の番号が付いているのに道が return でない
        [{ source: "'admin'", return_id: returnId, ...requestPair }, 'order_refunds_return_check'],
        [{ source: "'stripe_dashboard'", return_id: returnId, stripe_refund_id: stripeId() }, 'order_refunds_return_check'],
        // 知らない道
        [{ source: "'x'" }, 'order_refunds_source_check'],
      ];
      for (const [extra, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(insertRefundRow(db(), order.orderId, extra)).rejects.toMatchObject({ code: '23514', constraint });
        await db().query('rollback to savepoint check_case');
      }
      await db().query('savepoint check_case');
      await expect(
        insertRefundRow(db(), order.orderId, { source: "'return'", return_id: "'00000000-0000-0000-0000-000000000000'", ...requestPair }),
      ).rejects.toMatchObject({ code: '23503', constraint: 'order_refunds_return_id_fkey' });
      await db().query('rollback to savepoint check_case');

      await insertRefundRow(db(), order.orderId, { source: "'return'", return_id: returnId, ...requestPair });
      await insertRefundRow(db(), order.orderId, { source: "'admin'", ...requestPair });
      await insertRefundRow(db(), order.orderId, { source: "'stripe_dashboard'", stripe_refund_id: stripeId() });
      const saved = await db().query('select source, return_id from public.order_refunds where order_id = $1 order by source', [order.orderId]);
      expect(saved.rows).toEqual([
        { source: 'admin', return_id: null },
        { source: 'return', return_id: created.returnId },
        { source: 'stripe_dashboard', return_id: null },
      ]);
    });

    test('返金の商品の行の在庫の戻し方 return は発送後の行だけ（発送前は cancel か no_restock、発送後は no_restock か return）', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 3);
      const insertLine = `insert into public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
        values ($1, $2, $3, $4, $5, 0)`;
      const first = await insertRefundRecord(db(), { orderId: order.orderId });
      const second = await insertRefundRecord(db(), { orderId: order.orderId });

      // 発送前の行（この注文は全部発送済みなので、数の守りの前に CHECK で止まる）に return は付けられない
      await expectRejected(db(), insertLine, [first.refundId, order.orderItemId, 1, true, 'return'], {
        code: '23514',
        constraint: 'order_refund_lines_restock_check',
      });
      // 発送後の行に cancel は付けられない（今までどおり）
      await expectRejected(db(), insertLine, [first.refundId, order.orderItemId, 1, false, 'cancel'], {
        code: '23514',
        constraint: 'order_refund_lines_restock_check',
      });
      // 発送後の行は no_restock と return が通る
      await db().query(insertLine, [first.refundId, order.orderItemId, 1, false, 'no_restock']);
      await db().query(insertLine, [second.refundId, order.orderItemId, 1, false, 'return']);
      await insertReturnRefund(db(), {
        orderId: order.orderId,
        returnId: created.returnId,
        lines: [{ orderItemId: order.orderItemId, quantity: 1 }],
      });
      const saved = await db().query(
        `select rl.restock_type, count(*)::int as n
         from public.order_refund_lines as rl
         join public.order_refunds as r on r.id = rl.refund_id
         where r.order_id = $1
         group by rl.restock_type
         order by rl.restock_type`,
        [order.orderId],
      );
      expect(saved.rows).toEqual([
        { restock_type: 'no_restock', n: 1 },
        { restock_type: 'return', n: 2 },
      ]);
    });

    test('在庫の台帳に、理由 return（+n）・exchange（−n）と返品の番号を書ける。知らない理由・知らない返品は断る', async () => {
      const fx = await createShippedOrderFixture(db(), { lines: [{ quantity: 2, extraStock: 2 }] });
      const variantId = fx.variantIds[0];
      const created = await insertReturnRecord(db(), {
        orderId: fx.orderId,
        lines: [{ fulfillmentId: fx.fulfillments[0].id, orderItemId: fx.orderItemIds[0], quantity: 1 }],
      });
      const insertMovement = `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id, return_id)
        values ($1, $2, $3, $4, $5, $6)`;
      const args = (delta: number, reason: string, returnId: string | null) => [variantId, delta, reason, fx.orderId, fx.orderItemIds[0], returnId];

      // 在庫は 4（入庫）− 2（確保）= 2
      expect(await variantStock(db(), variantId)).toBe(2);
      await db().query(insertMovement, args(1, 'return', created.returnId));
      await db().query(insertMovement, args(-1, 'exchange', created.returnId));
      expect(await variantStock(db(), variantId)).toBe(2);

      await expectRejected(db(), insertMovement, args(1, 'x', null), { code: '23514', constraint: 'stock_movements_reason_check' });
      await expectRejected(db(), insertMovement, args(1, 'return', '00000000-0000-0000-0000-000000000000'), {
        code: '23503',
        constraint: 'stock_movements_return_id_fkey',
      });
    });

    test('確保中の数に交換の品の確保（exchange）が入る。返品の受け取り（return）は入らない', async () => {
      const fx = await createShippedOrderFixture(db(), { lines: [{ quantity: 2, extraStock: 2 }] });
      const originalItemId = fx.orderItemIds[0];
      const variantId = fx.variantIds[0];
      const created = await insertReturnRecord(db(), {
        orderId: fx.orderId,
        lines: [
          { fulfillmentId: fx.fulfillments[0].id, orderItemId: originalItemId, quantity: 1, resolution: 'exchange', exchangeVariantId: variantId },
        ],
      });
      const exchange = await db().query(
        `insert into public.order_items
           (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type,
            line_kind, exchange_return_line_id, exchange_paid_amount)
         values ($1, $2, '照合テスト', 0, 'BLACK', 'M', 1, 0, $3, 'stock', 'exchange', $4, 5000)
         returning id`,
        [fx.orderId, fx.itemIds[0], variantId, created.lineIds[0]],
      );
      const exchangeItemId = exchange.rows[0].id as string;
      await db().query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id, return_id)
         values ($1, -1, 'exchange', $2, $3, $4)`,
        [variantId, fx.orderId, exchangeItemId, created.returnId],
      );
      // 返品の受け取り（+1）を元の品に付けても、確保中の数は変わらない
      await db().query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id, return_id)
         values ($1, 1, 'return', $2, $3, $4)`,
        [variantId, fx.orderId, originalItemId, created.returnId],
      );

      const reserved = await db().query('select order_item_id, reserved from private.order_line_reservations($1)', [fx.orderId]);
      const byItem = Object.fromEntries(reserved.rows.map((row) => [row.order_item_id as string, row.reserved as number]));
      expect(byItem[exchangeItemId]).toBe(1);
      expect(byItem[originalItemId]).toBe(2);
    });

    test('在庫の履歴は返品の番号を最後の列 return_id で返す（その前の列は refund_id）', async () => {
      const fx = await createShippedOrderFixture(db(), { lines: [{ quantity: 2, extraStock: 1 }] });
      const created = await insertReturnRecord(db(), {
        orderId: fx.orderId,
        lines: [{ fulfillmentId: fx.fulfillments[0].id, orderItemId: fx.orderItemIds[0], quantity: 1 }],
      });
      await db().query(
        `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id, return_id)
         values ($1, 1, 'return', $2, $3, $4)`,
        [fx.variantIds[0], fx.orderId, fx.orderItemIds[0], created.returnId],
      );

      const res = await db().query('select * from public.list_item_stock_history($1, 50)', [fx.itemIds[0]]);

      expect(res.rows.map((row) => [row.reason, row.delta, row.balance_after, row.refund_id, row.return_id])).toEqual([
        ['return', 1, 2, null, created.returnId],
        ['purchase', -2, 1, null, null],
        ['restock', 3, 3, null, null],
      ]);
      expect(Object.keys(res.rows[0]).slice(-2)).toEqual(['refund_id', 'return_id']);
    });
  });

  describe('注文のメールの予定（返品のお知らせ）', () => {
    test('返金のお知らせは書き分け return と返品の番号の有無が一致しなければ断る', async () => {
      const order = await createShipped(db(), 1);
      const created = await returnOf(db(), order, 1);
      const refund = await insertRefundRecord(db(), { orderId: order.orderId });
      const refused: Array<Parameters<typeof insertEmailRow>[3]> = [
        { variant: 'return', refundId: refund.refundId },
        { variant: 'standard', refundId: refund.refundId, returnId: created.returnId },
        { variant: 'after_cancel', refundId: refund.refundId, returnId: created.returnId },
      ];
      for (const extra of refused) {
        await db().query('savepoint check_case');
        await expect(insertEmailRow(db(), order.orderId, 'refund', extra)).rejects.toMatchObject({
          code: '23514', constraint: 'order_email_outbox_return_check',
        });
        await db().query('rollback to savepoint check_case');
      }
    });

    async function createOrderWithTwoReturns() {
      const order = await createShipped(db(), 5);
      const first = await returnOf(db(), order, 1);
      const second = await returnOf(db(), order, 1);
      const firstReceipt = await insertReturnReceipt(db(), { returnId: first.returnId, lines: [] });
      const secondReceipt = await insertReturnReceipt(db(), { returnId: second.returnId, lines: [] });
      return { order, first, second, firstReceipt, secondReceipt };
    }

    test('返品のお知らせの 4 つの種類は返品の番号を必ず持ち（受け取りの 3 つは受け取りの番号も）、書き分けを持たない。返金のお知らせは書き分け return と返品の番号を持てる', async () => {
      const { order, first, second, firstReceipt } = await createOrderWithTwoReturns();
      const refund = await insertRefundRecord(db(), { orderId: order.orderId });

      const refused: Array<[string, Parameters<typeof insertEmailRow>[3], string]> = [
        // 返品の受付のお知らせは返品の番号が要り、受け取りの番号は持たない
        ['return_accepted', {}, 'order_email_outbox_return_check'],
        ['return_accepted', { returnId: first.returnId, receiptId: firstReceipt.receiptId }, 'order_email_outbox_return_check'],
        // ほかの 3 つは返品の番号と受け取りの番号の両方が要る
        ['return_received', { returnId: first.returnId }, 'order_email_outbox_return_check'],
        ['return_received', { receiptId: firstReceipt.receiptId }, 'order_email_outbox_return_check'],
        ['return_sent_back', {}, 'order_email_outbox_return_check'],
        ['return_refund_pending_shop', { receiptId: firstReceipt.receiptId }, 'order_email_outbox_return_check'],
        // 返品でない種類は返品の番号も受け取りの番号も持たない。返金のお知らせも、受け取りの番号だけを持つ形は断る
        ['paid', { variant: 'order_confirmed', returnId: first.returnId }, 'order_email_outbox_return_check'],
        ['awaiting_payment', { receiptId: firstReceipt.receiptId }, 'order_email_outbox_return_check'],
        ['refund', { variant: 'return', refundId: refund.refundId, receiptId: firstReceipt.receiptId }, 'order_email_outbox_return_check'],
        // 返品のお知らせは書き分けを持たない（番号の組は正しくして、書き分けの CHECK だけに当てる）
        ['return_accepted', { returnId: first.returnId, variant: 'standard' }, 'order_email_outbox_variant_check'],
        ['return_received', { returnId: first.returnId, receiptId: firstReceipt.receiptId, variant: 'standard' }, 'order_email_outbox_variant_check'],
        // 返金のお知らせの書き分けは standard・after_cancel・return だけ
        ['refund', { variant: 'x', refundId: refund.refundId }, 'order_email_outbox_variant_check'],
        // 知らない種類
        ['return_unknown', { returnId: first.returnId }, 'order_email_outbox_kind_check'],
      ];
      for (const [kind, extra, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(insertEmailRow(db(), order.orderId, kind, extra)).rejects.toMatchObject({ code: '23514', constraint });
        await db().query('rollback to savepoint check_case');
      }

      await insertEmailRow(db(), order.orderId, 'return_accepted', { returnId: first.returnId });
      await insertEmailRow(db(), order.orderId, 'return_received', { returnId: first.returnId, receiptId: firstReceipt.receiptId });
      await insertEmailRow(db(), order.orderId, 'return_sent_back', { returnId: first.returnId, receiptId: firstReceipt.receiptId });
      await insertEmailRow(db(), order.orderId, 'return_refund_pending_shop', { returnId: first.returnId, receiptId: firstReceipt.receiptId });
      // 返品の返金のお知らせは、返品の番号（受け取りと一緒に返した時は受け取りの番号も）を持てる。ふつうの返金のお知らせは持たない
      await insertEmailRow(db(), order.orderId, 'refund', {
        variant: 'return',
        refundId: refund.refundId,
        returnId: first.returnId,
        receiptId: firstReceipt.receiptId,
      });
      const alone = await insertRefundRecord(db(), { orderId: order.orderId, status: 'succeeded' });
      await insertEmailRow(db(), order.orderId, 'refund', { variant: 'return', refundId: alone.refundId, returnId: second.returnId });
      const plain = await insertRefundRecord(db(), { orderId: order.orderId, status: 'succeeded' });
      await insertEmailRow(db(), order.orderId, 'refund', { variant: 'standard', refundId: plain.refundId });
      const saved = await db().query('select kind, variant from private.order_email_outbox where order_id = $1 order by seq', [order.orderId]);
      expect(saved.rows).toEqual([
        { kind: 'return_accepted', variant: null },
        { kind: 'return_received', variant: null },
        { kind: 'return_sent_back', variant: null },
        { kind: 'return_refund_pending_shop', variant: null },
        { kind: 'refund', variant: 'return' },
        { kind: 'refund', variant: 'return' },
        { kind: 'refund', variant: 'standard' },
      ]);
    });

    test('自動の行は、返品の受付のお知らせが返品ごとに 1 行、ほかの 3 つが受け取りごと・種類ごとに 1 行。1 つの注文に返品が何回あってもよい', async () => {
      const { order, first, second, firstReceipt, secondReceipt } = await createOrderWithTwoReturns();
      const orderId = order.orderId;

      await insertEmailRow(db(), orderId, 'return_accepted', { returnId: first.returnId });
      await expectRejected(db(), `insert into private.order_email_outbox (order_id, kind, origin, return_id) values ($1, 'return_accepted', 'auto', $2)`, [orderId, first.returnId], {
        code: '23505',
        constraint: 'order_email_outbox_auto_return_idx',
      });
      // 同じ注文の 2 つ目の返品は、別の行にできる
      await insertEmailRow(db(), orderId, 'return_accepted', { returnId: second.returnId });

      await insertEmailRow(db(), orderId, 'return_received', { returnId: first.returnId, receiptId: firstReceipt.receiptId });
      await expectRejected(
        db(),
        `insert into private.order_email_outbox (order_id, kind, origin, return_id, return_receipt_id) values ($1, 'return_received', 'auto', $2, $3)`,
        [orderId, first.returnId, firstReceipt.receiptId],
        { code: '23505', constraint: 'order_email_outbox_auto_return_receipt_idx' },
      );
      // 同じ受け取りでも種類が違えば別の行。ほかの受け取りなら同じ種類も書ける
      await insertEmailRow(db(), orderId, 'return_refund_pending_shop', { returnId: first.returnId, receiptId: firstReceipt.receiptId });
      await insertEmailRow(db(), orderId, 'return_received', { returnId: second.returnId, receiptId: secondReceipt.receiptId });

      const count = await db().query('select count(*)::int as n from private.order_email_outbox where order_id = $1', [orderId]);
      expect(count.rows[0].n).toBe(5);
    });

    test('1 注文 1 種類 1 行の索引は返品の 4 つの種類を数えない。予定を書く関数は今までの種類を今までどおり 1 行だけ書き、返品の種類は書けない', async () => {
      const { order, first, firstReceipt } = await createOrderWithTwoReturns();
      const orderId = order.orderId;
      await insertEmailRow(db(), orderId, 'return_accepted', { returnId: first.returnId });
      await insertEmailRow(db(), orderId, 'return_received', { returnId: first.returnId, receiptId: firstReceipt.receiptId });

      const enqueue = async (kind: string, variant: string | null) =>
        (await db().query('select private.enqueue_order_email($1::uuid, $2::text, $3::text) as inserted', [orderId, kind, variant])).rows[0]
          .inserted as boolean;
      expect(await enqueue('paid', 'order_confirmed')).toBe(true);
      expect(await enqueue('paid', 'payment_received')).toBe(false);
      expect(await enqueue('awaiting_payment', null)).toBe(true);
      expect(await enqueue('awaiting_payment', null)).toBe(false);

      // 返品のお知らせは返品の番号を持つ関数（移行 B の private.enqueue_return_email）で書く。この関数では書けない
      await expectRejected(db(), 'select private.enqueue_order_email($1::uuid, $2::text, $3::text)', [orderId, 'return_accepted', null], {
        code: '23514',
        constraint: 'order_email_outbox_return_check',
      });

      // 索引の条件に 4 つの種類を除く決まりが入っている（作り直した索引）
      const index = await db().query(
        `select indexdef from pg_indexes where schemaname = 'private' and indexname = 'order_email_outbox_auto_once_idx'`,
      );
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0].indexdef).toContain('return_refund_pending_shop');
    });
  });

  describe('ショップの返品の設定', () => {
    test('全体の設定は 1 行だけで、最初の値は設計書 8-3 のとおり（返送先は空、最後に変えた人もまだ無い）', async () => {
      const res = await db().query('select * from public.shop_return_settings');

      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toEqual({
        id: 1,
        requests_enabled: true,
        request_types: 'returns_only',
        notice_text: '',
        window_days: 7,
        window_start: 'each_item',
        delivery_buffer_days: 3,
        return_address_name: null,
        return_address_postal_code: null,
        return_address_line: null,
        return_address_phone: null,
        customer_paid_method: 'customer_ships',
        shop_label_fee: 0,
        no_return_needed_enabled: false,
        restocking_fee_enabled: false,
        restocking_fee_percent: 0,
        exchange_fees_enabled: false,
        exchange_fee: 0,
        exchange_shipping_fee: 0,
        inspection_enabled: false,
        requests_updated_at: null,
        requests_updated_by: null,
        window_updated_at: null,
        window_updated_by: null,
        shipping_updated_at: null,
        shipping_updated_by: null,
        reasons_updated_at: null,
        reasons_updated_by: null,
        fees_updated_at: null,
        fees_updated_by: null,
        receiving_updated_at: null,
        receiving_updated_by: null,
      });
    });

    test('理由ごとの設定は 10 行で、最初の値は設計書 8-3 の表のとおり', async () => {
      const res = await db().query(
        `select reason, shown, resolutions, out_of_stock_exchange, photo, photo_instructions, shipping_payer
         from public.shop_return_reason_settings`,
      );

      // 並びは DB の照合順序に頼らず、理由の文字の順にそろえて比べる
      const byReason = <T extends { reason: string }>(rows: T[]) => [...rows].sort((a, b) => (a.reason < b.reason ? -1 : 1));
      expect(byReason(res.rows)).toEqual(byReason(INITIAL_REASON_SETTINGS));
    });

    test('全体の設定の値の決まり: 1 行だけ・日数と目安の範囲（日数は空で無制限）・手数料と額・返送先は 4 つとも空か 4 つとも入っている', async () => {
      const refused: Array<[string, string]> = [
        ['id = 2', 'shop_return_settings_id_check'],
        ['window_days = 0', 'shop_return_settings_window_days_check'],
        ['window_days = 366', 'shop_return_settings_window_days_check'],
        ['delivery_buffer_days = -1', 'shop_return_settings_delivery_buffer_days_check'],
        ['delivery_buffer_days = 15', 'shop_return_settings_delivery_buffer_days_check'],
        ["request_types = 'x'", 'shop_return_settings_request_types_check'],
        ["window_start = 'x'", 'shop_return_settings_window_start_check'],
        ["customer_paid_method = 'x'", 'shop_return_settings_customer_paid_method_check'],
        ['shop_label_fee = -1', 'shop_return_settings_shop_label_fee_check'],
        ['restocking_fee_percent = 101', 'shop_return_settings_restocking_fee_percent_check'],
        ['exchange_fee = -1', 'shop_return_settings_exchange_fee_check'],
        ['exchange_shipping_fee = -1', 'shop_return_settings_exchange_shipping_fee_check'],
        ["notice_text = repeat('あ', 2001)", 'shop_return_settings_notice_text_check'],
        // 返送先: 一部だけ入っている
        ["return_address_name = '返品係'", 'shop_return_settings_address_check'],
      ];
      for (const [set, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(db().query(`update public.shop_return_settings set ${set} where id = 1`)).rejects.toMatchObject({
          code: '23514',
          constraint,
        });
        await db().query('rollback to savepoint check_case');
      }

      // 日数は 1〜365 と空（無制限）、目安は 0〜14 が通る
      for (const set of ['window_days = 1', 'window_days = 365', 'window_days = null', 'delivery_buffer_days = 0', 'delivery_buffer_days = 14']) {
        await db().query(`update public.shop_return_settings set ${set} where id = 1`);
      }

      // 返送先は、4 つ揃っていて形が合えば通る。形が合わない 1 つがあれば、その列の CHECK が断る
      const address = (name: string, postal: string, line: string, phone: string) =>
        `return_address_name = '${name}', return_address_postal_code = '${postal}', return_address_line = '${line}', return_address_phone = '${phone}'`;
      const badAddresses: Array<[string, string]> = [
        [address('返品係', 'abc', '東京都渋谷区神宮前1-1-1', '03-1111-2222'), 'shop_return_settings_return_address_postal_code_check'],
        [address('返品係', '150-0001', '東京都渋谷区神宮前1-1-1', 'abc'), 'shop_return_settings_return_address_phone_check'],
        [address('', '150-0001', '東京都渋谷区神宮前1-1-1', '03-1111-2222'), 'shop_return_settings_return_address_name_check'],
        [address('あ'.repeat(201), '150-0001', '東京都渋谷区神宮前1-1-1', '03-1111-2222'), 'shop_return_settings_return_address_name_check'],
        [address('返品係', '150-0001', '', '03-1111-2222'), 'shop_return_settings_return_address_line_check'],
      ];
      for (const [set, constraint] of badAddresses) {
        await db().query('savepoint check_case');
        await expect(db().query(`update public.shop_return_settings set ${set} where id = 1`)).rejects.toMatchObject({
          code: '23514',
          constraint,
        });
        await db().query('rollback to savepoint check_case');
      }
      await db().query(`update public.shop_return_settings set ${address('返品係', '1500001', '東京都渋谷区神宮前1-1-1', '+81-3-1111-2222')} where id = 1`);
      await db().query(
        'update public.shop_return_settings set return_address_name = null, return_address_postal_code = null, return_address_line = null, return_address_phone = null where id = 1',
      );

      // 2 行目は作れない
      await expectRejected(db(), 'insert into public.shop_return_settings (id) values (1)', [], { code: '23505', constraint: 'shop_return_settings_pkey' });
    });

    test('理由ごとの設定の値の決まり: 理由・ご希望・在庫の無い交換・写真・案内の文の長さ・返送料の負担', async () => {
      const refused: Array<[string, string]> = [
        ["resolutions = 'x'", 'shop_return_reason_settings_resolutions_check'],
        ["out_of_stock_exchange = 'x'", 'shop_return_reason_settings_out_of_stock_exchange_check'],
        ["photo = 'x'", 'shop_return_reason_settings_photo_check'],
        ["shipping_payer = 'x'", 'shop_return_reason_settings_shipping_payer_check'],
        ["photo_instructions = repeat('あ', 501)", 'shop_return_reason_settings_photo_instructions_check'],
      ];
      for (const [set, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(db().query(`update public.shop_return_reason_settings set ${set} where reason = 'other'`)).rejects.toMatchObject({
          code: '23514',
          constraint,
        });
        await db().query('rollback to savepoint check_case');
      }
      await expectRejected(
        db(),
        `insert into public.shop_return_reason_settings (reason, shown, resolutions, out_of_stock_exchange, photo, shipping_payer)
         values ('x', true, 'refund_only', 'make', 'none', 'shop')`,
        [],
        { code: '23514', constraint: 'shop_return_reason_settings_reason_check' },
      );

      for (const set of ["resolutions = 'refund_only'", "out_of_stock_exchange = 'make'", "photo = 'required'", "shipping_payer = 'shop'", "photo_instructions = repeat('あ', 500)"]) {
        await db().query(`update public.shop_return_reason_settings set ${set} where reason = 'other'`);
      }
    });

    test('返品の設定を読む関数は、TS の ShopReturnSettings（C-2）のキーを snake_case にした形で最初の値を返す。理由は決まった順', async () => {
      const res = await db().query('select public.get_shop_return_settings() as settings');

      const never = { at: null, by_email: null };
      expect(res.rows[0].settings).toEqual({
        requests_enabled: true,
        request_types: 'returns_only',
        notice_text: '',
        window_days: 7,
        window_start: 'each_item',
        delivery_buffer_days: 3,
        return_address: null,
        customer_paid_method: 'customer_ships',
        shop_label_fee: 0,
        no_return_needed_enabled: false,
        restocking_fee_enabled: false,
        restocking_fee_percent: 0,
        exchange_fees_enabled: false,
        exchange_fee: 0,
        exchange_shipping_fee: 0,
        inspection_enabled: false,
        reasons: INITIAL_REASON_SETTINGS,
        updated: { requests: never, window: never, shipping: never, reasons: never, fees: never, receiving: never },
      });
    });

    test('返送先を入れると return_address の形で返り、無制限の日数は null、最後に変えた人はメールで返る', async () => {
      const actor = await createActor(db());
      await db().query(
        `update public.shop_return_settings
         set return_address_name = '返品係', return_address_postal_code = '150-0001',
             return_address_line = '東京都渋谷区神宮前1-1-1', return_address_phone = '03-1111-2222',
             shipping_updated_at = '2026-10-12T00:00:00Z', shipping_updated_by = $1,
             window_days = null
         where id = 1`,
        [actor.id],
      );

      const settings = (await db().query('select public.get_shop_return_settings() as settings')).rows[0].settings;

      expect(settings.return_address).toEqual({
        name: '返品係',
        postal_code: '150-0001',
        address: '東京都渋谷区神宮前1-1-1',
        phone: '03-1111-2222',
      });
      expect(settings.window_days).toBeNull();
      expect(settings.updated.shipping.by_email).toBe(actor.email);
      expect(new Date(settings.updated.shipping.at as string).toISOString()).toBe('2026-10-12T00:00:00.000Z');
      expect(settings.updated.requests).toEqual({ at: null, by_email: null });
    });
  });

  describe('商品ごとの返品の数（private.order_line_return_counts）', () => {
    async function reopenAndReceive(created: { returnId: string; lineId: string }) {
      await db().query("update public.order_returns set status = 'open', reopened_at = now() where id = $1", [created.returnId]);
      await insertReturnReceipt(db(), {
        returnId: created.returnId, kind: 'reopen',
        lines: [{ returnLineId: created.lineId, disposition: 'missing_reopened', quantity: 1 }],
      });
      await insertReturnReceipt(db(), {
        returnId: created.returnId, refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 1 }],
      });
    }

    test('本体は列の名前と並び、返品番号・行の作成順・行の番号の順を保ち、取消の行も未処理で返す', async () => {
      const order = await createShipped(db(), 5);
      const first = await insertReturnRecord(db(), {
        orderId: order.orderId, lines: [],
      });
      // 作った順と時刻の順を逆にし、同時刻の行は UUID の順で比べる。
      const lines = await db().query(
        `insert into public.order_return_lines (return_id, fulfillment_id, order_item_id, quantity, reason, resolution, created_at)
         values ($1, $2, $3, 1, 'defective', 'refund', now() + interval '2 days'),
                ($1, $2, $3, 1, 'defective', 'refund', now() + interval '2 days'),
                ($1, $2, $3, 1, 'defective', 'refund', now() + interval '1 day') returning id`,
        [first.returnId, order.fulfillmentId, order.orderItemId],
      );
      const second = await returnOf(db(), order, 1);
      const cancelled = await returnOf(db(), order, 1, { status: 'cancelled' });
      const tied = [lines.rows[0].id as string, lines.rows[1].id as string].sort();
      await insertReturnReceipt(db(), {
        returnId: second.returnId, refundChoice: 'consult',
        lines: [{ returnLineId: second.lineId, disposition: 'restocked', quantity: 1 }],
      });
      const states = await db().query('select * from private.order_return_line_states($1)', [order.orderId]);
      expect(Object.keys(states.rows[0])).toEqual([
        'return_id', 'return_line_id', 'return_number', 'return_status', 'fulfillment_id', 'order_item_id', 'quantity',
        'restocked', 'not_restocked', 'pending_inspection', 'sent_back', 'missing', 'processed', 'unprocessed',
        'exchanged', 'refund_covered', 'refund_waived', 'refund_waiting',
      ]);
      expect(states.rows.map((row) => row.return_line_id)).toEqual([lines.rows[2].id, ...tied, second.lineId, cancelled.lineId]);
      expect(states.rows.map((row) => [row.return_number, row.return_status, row.processed, row.unprocessed])).toEqual([
        [1, 'open', 0, 1], [1, 'open', 0, 1], [1, 'open', 0, 1], [2, 'open', 1, 0], [3, 'cancelled', 0, 1],
      ]);
    });

    test('返品が無い注文は、発送した数がそのまま返品できる数と、ふつうの返金で選べる数になる。列は C-1 の並び', async () => {
      const order = await createShipped(db(), 3);

      const columns = await db().query('select * from private.order_line_return_counts($1)', [order.orderId]);
      expect(Object.keys(columns.rows[0])).toEqual([
        'order_item_id',
        'shipped',
        'refunded_after_shipment',
        'requested',
        'open_unprocessed',
        'refund_waiting',
        'exchanged',
        'sent_back',
        'returnable',
        'refundable_after_shipment',
      ]);
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toEqual({
        order_item_id: order.orderItemId,
        shipped: 3,
        refunded_after_shipment: 0,
        requested: 0,
        open_unprocessed: 0,
        refund_waiting: 0,
        exchanged: 0,
        sent_back: 0,
        returnable: 3,
        refundable_after_shipment: 3,
      });
    });

    test.each<[ReturnFixtureStatus, Record<string, number>]>([
      ['requested', { requested: 2, open_unprocessed: 0, returnable: 1, refundable_after_shipment: 1 }],
      ['open', { requested: 0, open_unprocessed: 2, returnable: 1, refundable_after_shipment: 1 }],
      ['cancelled', { requested: 0, open_unprocessed: 0, returnable: 3, refundable_after_shipment: 3 }],
      ['declined', { requested: 0, open_unprocessed: 0, returnable: 3, refundable_after_shipment: 3 }],
    ])('状態 %s の返品 2 点: 数に入るのは申し込みと受付中だけ。取消・お断りは数えない', async (status, expected) => {
      const order = await createShipped(db(), 3);
      await returnOf(db(), order, 2, { status });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject(expected);
    });

    test('2 点のうち 1 点を受け取って相談すると、未処理 1・返金待ち 1。その 1 点を返金（保留）すると、返金待ちは 0 で覆われた数 1', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 1 }],
      });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refunded_after_shipment: 0,
        open_unprocessed: 1,
        refund_waiting: 1,
        returnable: 1,
        refundable_after_shipment: 1,
      });
      expect(Object.keys((await progressOf(db(), created.returnId))[0])).toEqual([
        'return_line_id',
        'quantity',
        'restocked',
        'not_restocked',
        'pending_inspection',
        'sent_back',
        'missing',
        'processed',
        'unprocessed',
        'exchanged',
        'refund_covered',
        'refund_waived',
        'refund_waiting',
      ]);
      expect(await progressOf(db(), created.returnId)).toEqual([
        {
          return_line_id: created.lineId,
          quantity: 2,
          restocked: 1,
          not_restocked: 0,
          pending_inspection: 0,
          sent_back: 0,
          missing: 0,
          processed: 1,
          unprocessed: 1,
          exchanged: 0,
          refund_covered: 0,
          refund_waived: 0,
          refund_waiting: 1,
        },
      ]);

      await insertReturnRefund(db(), {
        orderId: order.orderId,
        returnId: created.returnId,
        lines: [{ orderItemId: order.orderItemId, quantity: 1 }],
      });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refunded_after_shipment: 1,
        open_unprocessed: 1,
        refund_waiting: 0,
        returnable: 1,
        refundable_after_shipment: 1,
      });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({ refund_covered: 1, refund_waived: 0, refund_waiting: 0 });
    });

    test.each<[RefundFixtureStatus, number]>([
      ['awaiting_response', 1],
      ['pending', 1],
      ['succeeded', 1],
      ['error', 0],
      ['failed', 0],
    ])('返品の返金が %s なら、受け取った返金の品 2 点のうち覆われるのは %i 点（エラーと失敗は覆わない）', async (status, covered) => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 2 }],
      });
      await insertReturnRefund(db(), {
        orderId: order.orderId,
        returnId: created.returnId,
        status,
        lines: [{ orderItemId: order.orderItemId, quantity: 1 }],
      });

      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({ refund_covered: covered, refund_waiting: 2 - covered });
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refunded_after_shipment: covered,
        refund_waiting: 2 - covered,
      });
    });

    test('2 点とも受け取って相談: 未処理 0・返金待ち 2。戻さない品も受け取った品として返金待ちに数える', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'not_restocked', quantity: 2 }],
      });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        open_unprocessed: 0,
        refund_waiting: 2,
        returnable: 1,
        refundable_after_shipment: 1,
      });
    });

    test('交換: 受け取った交換の数（検品待ちも含む）が exchanged。返金待ちには入らない', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2, { resolution: 'exchange' });
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        lines: [
          { returnLineId: created.lineId, disposition: 'restocked', quantity: 1 },
          { returnLineId: created.lineId, disposition: 'pending_inspection', quantity: 1 },
        ],
      });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        exchanged: 2,
        open_unprocessed: 0,
        refund_waiting: 0,
        returnable: 1,
        refundable_after_shipment: 1,
      });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({
        restocked: 1,
        pending_inspection: 1,
        processed: 2,
        exchanged: 2,
        refund_waiting: 0,
      });
    });

    test('数える解決は受け取りの商品の扱いの値で、返品の行の予定ではない（予定が交換の品を、店長が返金に変えた・一部を作って送るに変えた）', async () => {
      const order = await createShipped(db(), 5);
      const created = await returnOf(db(), order, 3, { resolution: 'exchange' });
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        lines: [
          { returnLineId: created.lineId, disposition: 'restocked', quantity: 1, resolution: 'exchange', exchangeMethod: 'stock' },
          { returnLineId: created.lineId, disposition: 'restocked', quantity: 1, resolution: 'exchange', exchangeMethod: 'make' },
          { returnLineId: created.lineId, disposition: 'restocked', quantity: 1, resolution: 'refund' },
        ],
      });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        exchanged: 2,
        refund_waiting: 1,
        open_unprocessed: 0,
        returnable: 2,
        refundable_after_shipment: 2,
      });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({ restocked: 3, exchanged: 2, refund_waiting: 1 });
    });

    test('お返し: お返しした数は返品できる数から引くが、ふつうの返金で選べる数からは引かない（お店の判断で返金できる）', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        sentBackMessage: '使用の跡があるためお返しします',
        lines: [{ returnLineId: created.lineId, disposition: 'sent_back', quantity: 1 }],
      });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        sent_back: 1,
        open_unprocessed: 1,
        refund_waiting: 0,
        returnable: 1,
        refundable_after_shipment: 2,
      });
    });

    test('検品待ちは受け取った品として数える。検品で決めると、戻した・戻さないに移る（返金の対象の数は変わらない）', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'pending_inspection', quantity: 2 }],
      });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({
        restocked: 0,
        not_restocked: 0,
        pending_inspection: 2,
        processed: 2,
        unprocessed: 0,
        refund_waiting: 2,
      });

      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind: 'inspect',
        lines: [
          { returnLineId: created.lineId, disposition: 'inspected_restocked', quantity: 1 },
          { returnLineId: created.lineId, disposition: 'inspected_not_restocked', quantity: 1 },
        ],
      });

      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({
        restocked: 1,
        not_restocked: 1,
        pending_inspection: 0,
        processed: 2,
        unprocessed: 0,
        refund_waiting: 2,
      });
    });

    test('届かないで終えた品は数に入らず、また返品できる。開き直して打ち消すと、受付中の未処理に戻る', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind: 'close_missing',
        lines: [{ returnLineId: created.lineId, disposition: 'missing', quantity: 2 }],
      });
      await db().query("update public.order_returns set status = 'closed', closed_at = now() where id = $1", [created.returnId]);

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        open_unprocessed: 0,
        refund_waiting: 0,
        returnable: 3,
        refundable_after_shipment: 3,
      });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({ missing: 2, processed: 2, unprocessed: 0 });

      await db().query("update public.order_returns set status = 'open', reopened_at = now() where id = $1", [created.returnId]);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind: 'reopen',
        lines: [{ returnLineId: created.lineId, disposition: 'missing_reopened', quantity: 2 }],
      });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({ open_unprocessed: 2, returnable: 1 });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({ missing: 0, processed: 0, unprocessed: 2 });
    });

    test('Review Focus 3: 届かないで閉じた後にふつうの返金で返した品が届いても、返金の数は覆われているので返金待ちにならず、返品は完了になる', async () => {
      const order = await createShipped(db(), 1);
      const created = await returnOf(db(), order, 1, { status: 'closed' });
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind: 'close_missing',
        lines: [{ returnLineId: created.lineId, disposition: 'missing', quantity: 1 }],
      });
      // ふつうの返金の画面で、発送した 1 点を返金した
      await insertRefundRecord(db(), {
        orderId: order.orderId,
        status: 'succeeded',
        lines: [{ orderItemId: order.orderItemId, quantity: 1, beforeShipment: false }],
      });
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refunded_after_shipment: 1,
        returnable: 0,
        refundable_after_shipment: 0,
        open_unprocessed: 0,
        refund_waiting: 0,
      });

      // 開き直して、届いた品を受け取る（戻す）
      await db().query("update public.order_returns set status = 'open', reopened_at = now() where id = $1", [created.returnId]);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind: 'reopen',
        lines: [{ returnLineId: created.lineId, disposition: 'missing_reopened', quantity: 1 }],
      });
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({ open_unprocessed: 1, returnable: 0, refund_waiting: 0 });
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 1 }],
      });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        open_unprocessed: 0,
        refund_waiting: 0,
        returnable: 0,
        refundable_after_shipment: 0,
      });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({
        restocked: 1,
        processed: 1,
        unprocessed: 0,
        refund_covered: 1,
        refund_waiting: 0,
      });
      const status = await db().query('select private.refresh_order_return_status($1) as status', [created.returnId]);
      expect(status.rows[0].status).toBe('closed');
    });

    test.each<[RefundFixtureStatus, number]>([
      ['awaiting_response', 0], ['pending', 0], ['succeeded', 0], ['failed', 1], ['error', 1],
    ])('Review Focus 3: 2点注文・返品1点で届かないを経て届いた品を、ふつうの返金（%s）の覆いに先にする', async (status, waiting) => {
      const order = await createShipped(db(), 2);
      const created = await returnOf(db(), order, 1, { status: 'closed' });
      await insertReturnReceipt(db(), {
        returnId: created.returnId, kind: 'close_missing',
        lines: [{ returnLineId: created.lineId, disposition: 'missing', quantity: 1 }],
      });
      await insertRefundRecord(db(), {
        orderId: order.orderId, status,
        lines: [{ orderItemId: order.orderItemId, quantity: 1, beforeShipment: false }],
      });
      await reopenAndReceive(created);
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refund_waiting: waiting, refundable_after_shipment: 1,
      });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({ refund_covered: 1 - waiting, refund_waiting: waiting });
      const refreshed = await db().query('select private.refresh_order_return_status($1) as status', [created.returnId]);
      expect(refreshed.rows[0].status).toBe(waiting === 0 ? 'closed' : 'open');
    });

    test('届かないを通らない返品の品は、ふつうの返金が手元の品の分なら返金待ちに残る', async () => {
      const order = await createShipped(db(), 2);
      const created = await returnOf(db(), order, 1);
      await insertRefundRecord(db(), {
        orderId: order.orderId, status: 'succeeded',
        lines: [{ orderItemId: order.orderItemId, quantity: 1, beforeShipment: false }],
      });
      await insertReturnReceipt(db(), {
        returnId: created.returnId, refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 1 }],
      });
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({ refund_waiting: 1, refundable_after_shipment: 0 });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({ refund_covered: 0, refund_waiting: 1 });
      expect((await db().query('select private.refresh_order_return_status($1) as status', [created.returnId])).rows[0].status).toBe('open');
      // 開き直した品を先に覆う方では選べる数が1点増えるため、手元の品の返金をここから補える。
    });

    test('ふつうの返金1点を開き直した2つの返品へ重ねて当てず、番号の小さい返品から覆う', async () => {
      const order = await createShipped(db(), 4);
      const returns = [];
      for (let i = 0; i < 2; i += 1) {
        const created = await returnOf(db(), order, 1, { status: 'closed' });
        await insertReturnReceipt(db(), {
          returnId: created.returnId, kind: 'close_missing',
          lines: [{ returnLineId: created.lineId, disposition: 'missing', quantity: 1 }],
        });
        returns.push(created);
      }
      await insertRefundRecord(db(), {
        orderId: order.orderId, status: 'succeeded',
        lines: [{ orderItemId: order.orderItemId, quantity: 1, beforeShipment: false }],
      });
      for (const created of returns) await reopenAndReceive(created);
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({ refund_waiting: 1, refundable_after_shipment: 2 });
      expect((await progressOf(db(), returns[0].returnId))[0]).toMatchObject({ refund_covered: 1, refund_waiting: 0 });
      expect((await progressOf(db(), returns[1].returnId))[0]).toMatchObject({ refund_covered: 0, refund_waiting: 1 });
    });

    test('開き直した品を通常の受け取りより先に覆い、上限の超過と同じ返金の覆いを二度足さない', async () => {
      const order = await createShipped(db(), 3);
      const first = await returnOf(db(), order, 1);
      await insertReturnReceipt(db(), {
        returnId: first.returnId, refundChoice: 'consult',
        lines: [{ returnLineId: first.lineId, disposition: 'restocked', quantity: 1 }],
      });
      const second = await returnOf(db(), order, 1, { status: 'closed' });
      await insertReturnReceipt(db(), {
        returnId: second.returnId, kind: 'close_missing',
        lines: [{ returnLineId: second.lineId, disposition: 'missing', quantity: 1 }],
      });
      await insertRefundRecord(db(), {
        orderId: order.orderId, status: 'succeeded',
        lines: [{ orderItemId: order.orderItemId, quantity: 1, beforeShipment: false }],
      });
      await reopenAndReceive(second);
      expect((await progressOf(db(), first.returnId))[0]).toMatchObject({ refund_covered: 0, refund_waiting: 1 });
      expect((await progressOf(db(), second.returnId))[0]).toMatchObject({ refund_covered: 1, refund_waiting: 0 });
      await insertRefundRecord(db(), {
        orderId: order.orderId, status: 'succeeded',
        lines: [{ orderItemId: order.orderItemId, quantity: 1, beforeShipment: false }],
      });
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({ refund_waiting: 1, refundable_after_shipment: 0 });
      // 超過が優先分より大きくなった時は、残りだけを通常の受け取りへ当てる。
      await insertRefundRecord(db(), {
        orderId: order.orderId, status: 'succeeded',
        lines: [{ orderItemId: order.orderItemId, quantity: 1, beforeShipment: false }],
      });
      expect((await progressOf(db(), first.returnId))[0]).toMatchObject({ refund_covered: 1, refund_waiting: 0 });
      expect((await progressOf(db(), second.returnId))[0]).toMatchObject({ refund_covered: 1, refund_waiting: 0 });
    });

    test('別の返品の返金を、開き直した品を覆うふつうの返金として数えない', async () => {
      const order = await createShipped(db(), 3);
      const first = await returnOf(db(), order, 1);
      await insertReturnReceipt(db(), {
        returnId: first.returnId, refundChoice: 'now',
        lines: [{ returnLineId: first.lineId, disposition: 'restocked', quantity: 1 }],
      });
      await insertReturnRefund(db(), {
        orderId: order.orderId, returnId: first.returnId, status: 'succeeded',
        lines: [{ orderItemId: order.orderItemId, quantity: 1 }],
      });
      const second = await returnOf(db(), order, 1, { status: 'closed' });
      await insertReturnReceipt(db(), {
        returnId: second.returnId, kind: 'close_missing',
        lines: [{ returnLineId: second.lineId, disposition: 'missing', quantity: 1 }],
      });
      await reopenAndReceive(second);
      expect((await progressOf(db(), second.returnId))[0]).toMatchObject({ refund_covered: 0, refund_waiting: 1 });
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({ refund_waiting: 1, refundable_after_shipment: 1 });
    });

    test('返金しないことにした数（refund_waived）は返金待ちから引く。返品できる数からも引く（返ってきた品が、また返品できる数に戻らない）', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 2 }],
      });
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refund_waiting: 2,
        returnable: 1,
        refundable_after_shipment: 1,
      });

      // 額を決めて返金する時に 0 円にした（受け取りの記録の種類 waive_refund）
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind: 'waive_refund',
        lines: [{ returnLineId: created.lineId, disposition: 'refund_waived', quantity: 2 }],
      });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refund_waiting: 0,
        returnable: 1,
        refundable_after_shipment: 3,
      });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({
        restocked: 2,
        processed: 2,
        unprocessed: 0,
        refund_covered: 0,
        refund_waived: 2,
        refund_waiting: 0,
      });
    });

    test('完了した返品の返金が失敗すると、覆いが外れて返金待ちが戻る。返品の状態は完了のまま', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2, { status: 'closed' });
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'now',
        lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 2 }],
      });
      const refund = await insertReturnRefund(db(), {
        orderId: order.orderId,
        returnId: created.returnId,
        status: 'succeeded',
        lines: [{ orderItemId: order.orderItemId, quantity: 2 }],
      });
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refunded_after_shipment: 2,
        refund_waiting: 0,
        returnable: 1,
      });

      await db().query("update public.order_refunds set status = 'failed' where id = $1", [refund.refundId]);

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refunded_after_shipment: 0,
        refund_waiting: 2,
        returnable: 1,
      });
      const status = await db().query('select private.refresh_order_return_status($1) as status', [created.returnId]);
      expect(status.rows[0].status).toBe('closed');
    });

    test('返品が 2 つ: 申し込みと受付中の数が足される。同じ商品の返金待ちが 2 つの返品にある時、ふつうの返金で先に返した数は番号の小さい返品から覆う', async () => {
      const order = await createShipped(db(), 3);
      await returnOf(db(), order, 1, { status: 'requested' });
      await returnOf(db(), order, 1);
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({ requested: 1, open_unprocessed: 1, returnable: 1 });

      const other = await createShipped(db(), 3);
      const first = await returnOf(db(), other, 1);
      const second = await returnOf(db(), other, 1);
      for (const created of [first, second]) {
        await insertReturnReceipt(db(), {
          returnId: created.returnId,
          refundChoice: 'consult',
          lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 1 }],
        });
      }
      // ふつうの返金の画面で 1 点返した。受け取った返金の品は 2 点、上限は 3 − 1 = 2 点なので、超過は無い
      await insertRefundRecord(db(), {
        orderId: other.orderId,
        status: 'succeeded',
        lines: [{ orderItemId: other.orderItemId, quantity: 1, beforeShipment: false }],
      });
      expect(await countsOf(db(), other.orderId, other.orderItemId)).toMatchObject({ refunded_after_shipment: 1, refund_waiting: 2, returnable: 0 });
      // もう 1 点返すと、上限は 1 点。超過の 1 点は、番号の小さい返品（1 つ目）が覆われたことにする
      await insertRefundRecord(db(), {
        orderId: other.orderId,
        status: 'succeeded',
        lines: [{ orderItemId: other.orderItemId, quantity: 1, beforeShipment: false }],
      });

      expect(await countsOf(db(), other.orderId, other.orderItemId)).toMatchObject({ refunded_after_shipment: 2, refund_waiting: 1 });
      expect((await progressOf(db(), first.returnId))[0]).toMatchObject({ refund_covered: 1, refund_waiting: 0 });
      expect((await progressOf(db(), second.returnId))[0]).toMatchObject({ refund_covered: 0, refund_waiting: 1 });
    });

    test('上限の式の性質: お返し・返金しないことにした品をふつうの返金で後から返すと、同じ商品の返金待ちは覆われたことになる（二重の返金を避ける側に当てる）', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 3);
      // 1点はお返し、2点は相談で受け取り、うち1点は返金しないで終えた
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        sentBackMessage: '使用の跡があるためお返しします',
        lines: [
          { returnLineId: created.lineId, disposition: 'sent_back', quantity: 1 },
          { returnLineId: created.lineId, disposition: 'restocked', quantity: 2 },
        ],
      });
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind: 'waive_refund',
        lines: [{ returnLineId: created.lineId, disposition: 'refund_waived', quantity: 1 }],
      });
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refund_waiting: 1,
        refundable_after_shipment: 2,
        returnable: 0,
      });

      // お店の判断で、ふつうの返金の画面から1点返した（画面が出すのはお返しと返金しないの品の2点）
      await insertRefundRecord(db(), {
        orderId: order.orderId,
        status: 'succeeded',
        lines: [{ orderItemId: order.orderItemId, quantity: 1, beforeShipment: false }],
      });

      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({
        refunded_after_shipment: 1,
        refund_waiting: 0,
        refundable_after_shipment: 2,
      });
      expect((await progressOf(db(), created.returnId))[0]).toMatchObject({ refund_covered: 1, refund_waived: 1, refund_waiting: 0 });
    });
  });

  describe('一覧の 1 ページ分の数（public.list_order_line_return_counts）', () => {
    test('注文の番号の配列で、注文ごと・商品ごとの数を order_id を先頭の列にして返す', async () => {
      const first = await createShipped(db(), 3);
      const second = await createShipped(db(), 2);
      await returnOf(db(), first, 1);

      const res = await db().query('select * from public.list_order_line_return_counts($1::uuid[])', [[first.orderId, second.orderId]]);

      expect(Object.keys(res.rows[0])).toEqual([
        'order_id',
        'order_item_id',
        'shipped',
        'refunded_after_shipment',
        'requested',
        'open_unprocessed',
        'refund_waiting',
        'exchanged',
        'sent_back',
        'returnable',
        'refundable_after_shipment',
      ]);
      const byOrder = Object.fromEntries(res.rows.map((row) => [row.order_id as string, row]));
      expect(byOrder[first.orderId]).toMatchObject({ order_item_id: first.orderItemId, shipped: 3, open_unprocessed: 1, returnable: 2 });
      expect(byOrder[second.orderId]).toMatchObject({ order_item_id: second.orderItemId, shipped: 2, open_unprocessed: 0, returnable: 2 });
      expect(res.rows).toHaveLength(2);
    });

    test('空と null は何も返さず、201 件以上は TOO_MANY_ORDERS で断る', async () => {
      const empty = await db().query('select * from public.list_order_line_return_counts($1::uuid[])', [[]]);
      expect(empty.rows).toEqual([]);
      const none = await db().query('select * from public.list_order_line_return_counts(null::uuid[])');
      expect(none.rows).toEqual([]);

      const ids = Array.from({ length: 201 }, () => crypto.randomUUID());
      await expectRejected(db(), 'select * from public.list_order_line_return_counts($1::uuid[])', [ids], {
        code: '22023',
        message: 'TOO_MANY_ORDERS',
      });
      const limit = await db().query('select * from public.list_order_line_return_counts($1::uuid[])', [ids.slice(0, 200)]);
      expect(limit.rows).toEqual([]);
    });
  });

  describe('発送の行ごとの返品できる数と期限（private.fulfillment_line_returnable）', () => {
    /** 5 点を 2 回に分けて送った注文: 1 回目 2 点・2 回目 3 点（発送の日時は期限の試験が決める） */
    async function createTwoShipments(shipments: Array<{ shippedAt?: string; cancelled?: boolean }> = [{}, {}]) {
      const fx = await createShippedOrderFixture(db(), {
        lines: [{ quantity: 5 }],
        shipments: [
          { lines: [{ lineIndex: 0, quantity: 2 }], ...shipments[0] },
          { lines: [{ lineIndex: 0, quantity: 3 }], ...shipments[1] },
        ],
      });
      return { orderId: fx.orderId, orderItemId: fx.orderItemIds[0], first: fx.fulfillments[0].id, second: fx.fulfillments[1].id };
    }

    test('発送の行ごとに、返品の行の数を引いた数が返品できる数になる。商品ごとの数とは別に数える', async () => {
      const order = await createTwoShipments();
      // 1 回目の発送から 2 点、2 回目の発送から 1 点を返す返品
      await insertReturnRecord(db(), {
        orderId: order.orderId,
        lines: [
          { fulfillmentId: order.first, orderItemId: order.orderItemId, quantity: 2 },
          { fulfillmentId: order.second, orderItemId: order.orderItemId, quantity: 1 },
        ],
      });

      expect(await shipmentLinesOf(db(), order.orderId)).toMatchObject([
        { fulfillment_number: 1, quantity: 2, in_returns: 2, missing: 0, returnable: 0 },
        { fulfillment_number: 2, quantity: 3, in_returns: 1, missing: 0, returnable: 2 },
      ]);
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({ shipped: 5, open_unprocessed: 3, returnable: 2 });

      // 列は C-1 の並び
      const columns = await db().query('select * from private.fulfillment_line_returnable($1)', [order.orderId]);
      expect(Object.keys(columns.rows[0])).toEqual([
        'fulfillment_id',
        'fulfillment_number',
        'shipped_at',
        'order_item_id',
        'quantity',
        'in_returns',
        'missing',
        'returnable',
        'deadline_date',
      ]);
    });

    test('届かない数は返品できる数に戻る。お返しした数・取消でない返品の数は戻らない。取消・お断りの返品は数えない', async () => {
      const order = await createTwoShipments();
      const created = await insertReturnRecord(db(), {
        orderId: order.orderId,
        lines: [
          { fulfillmentId: order.first, orderItemId: order.orderItemId, quantity: 2 },
          { fulfillmentId: order.second, orderItemId: order.orderItemId, quantity: 1 },
        ],
      });
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        sentBackMessage: '使用の跡があるためお返しします',
        lines: [{ returnLineId: created.lineIds[1], disposition: 'sent_back', quantity: 1 }],
      });
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind: 'close_missing',
        lines: [{ returnLineId: created.lineIds[0], disposition: 'missing', quantity: 1 }],
      });
      // 取消とお断りの返品は、発送の行を占めない
      await insertReturnRecord(db(), {
        orderId: order.orderId,
        status: 'cancelled',
        lines: [{ fulfillmentId: order.second, orderItemId: order.orderItemId, quantity: 2 }],
      });
      await insertReturnRecord(db(), {
        orderId: order.orderId,
        status: 'declined',
        lines: [{ fulfillmentId: order.second, orderItemId: order.orderItemId, quantity: 2 }],
      });

      expect(await shipmentLinesOf(db(), order.orderId)).toMatchObject([
        { fulfillment_number: 1, quantity: 2, in_returns: 2, missing: 1, returnable: 1 },
        { fulfillment_number: 2, quantity: 3, in_returns: 1, missing: 0, returnable: 2 },
      ]);
    });

    test('取り消した発送の行は出さない', async () => {
      const order = await createTwoShipments([{}, { cancelled: true }]);

      const lines = await shipmentLinesOf(db(), order.orderId);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ fulfillment_number: 1, quantity: 2, returnable: 2 });
    });

    test.each<[string, string, string]>([
      // 発送した時刻（UTC）, 期待する期限（日本時間の発送日 + 目安 3 日 + 7 日）, 説明
      ['2026-10-10T03:00:00Z', '2026-10-20', '日本時間 10 月 10 日 12 時 → 10 日 + 3 + 7 = 10 月 20 日（設計書 4-9 の例）'],
      ['2026-10-10T14:59:59Z', '2026-10-20', '日本時間 10 月 10 日 23 時 59 分 59 秒はまだ 10 日'],
      ['2026-10-10T15:00:00Z', '2026-10-21', '日本時間 10 月 11 日 0 時 0 分 0 秒から 11 日（UTC の日付ではない）'],
      ['2026-10-28T03:00:00Z', '2026-11-07', '月をまたぐ'],
    ])('期限は日本時間の発送日 + 目安 + 日数: 発送 %s → %s（%s）', async (shippedAt, deadline) => {
      const fx = await createShippedOrderFixture(db(), { lines: [{ quantity: 1 }], shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }], shippedAt }] });

      const lines = await shipmentLinesOf(db(), fx.orderId);

      expect(lines.map((line) => line.deadline_date)).toEqual([deadline]);
    });

    test('設定の日数と目安を変えると期限も変わり、日数が空（無制限）なら期限は空', async () => {
      const fx = await createShippedOrderFixture(db(), {
        lines: [{ quantity: 1 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }], shippedAt: '2026-10-10T03:00:00Z' }],
      });
      const deadlineOf = async () => (await shipmentLinesOf(db(), fx.orderId))[0].deadline_date as string | null;

      await db().query('update public.shop_return_settings set window_days = 14, delivery_buffer_days = 0 where id = 1');
      expect(await deadlineOf()).toBe('2026-10-24');

      await db().query('update public.shop_return_settings set window_days = null where id = 1');
      expect(await deadlineOf()).toBeNull();
    });

    test('数え始めが「最後の品」なら、取り消していない発送のうち最も遅い届いた日から数える。取り消した発送は含めない', async () => {
      const order = await createTwoShipments([{ shippedAt: '2026-10-01T03:00:00Z' }, { shippedAt: '2026-10-10T03:00:00Z' }]);
      const deadlines = async () => (await shipmentLinesOf(db(), order.orderId)).map((line) => line.deadline_date);

      // 品ごとの届いた日: 10 月 1 日 + 3 + 7 = 11 日、10 月 10 日 + 3 + 7 = 20 日
      expect(await deadlines()).toEqual(['2026-10-11', '2026-10-20']);

      await db().query("update public.shop_return_settings set window_start = 'last_item' where id = 1");
      expect(await deadlines()).toEqual(['2026-10-20', '2026-10-20']);

      // 最後の発送を取り消すと、残った発送の日から数える
      await db().query('update public.order_fulfillments set cancelled_at = now() where id = $1', [order.second]);
      expect(await deadlines()).toEqual(['2026-10-11']);
    });
  });

  describe('返品の状態の確かめ直し（private.refresh_order_return_status）', () => {
    const refreshOf = async (returnId: string) =>
      (await db().query('select private.refresh_order_return_status($1) as status', [returnId])).rows[0].status as string | null;
    const stateOf = async (returnId: string) =>
      (await db().query('select status, closed_at is not null as has_closed_at from public.order_returns where id = $1', [returnId])).rows[0];

    test('全部の品が処理され、返金待ち・検品待ち・お支払い待ちが無ければ closed にする。返金待ちが残る間は受付中のまま', async () => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 2 }],
      });
      expect(await refreshOf(created.returnId)).toBe('open');
      expect(await stateOf(created.returnId)).toEqual({ status: 'open', has_closed_at: false });

      await insertReturnRefund(db(), {
        orderId: order.orderId,
        returnId: created.returnId,
        lines: [{ orderItemId: order.orderItemId, quantity: 2 }],
      });

      expect(await refreshOf(created.returnId)).toBe('closed');
      expect(await stateOf(created.returnId)).toEqual({ status: 'closed', has_closed_at: true });
      // もう一度呼んでも同じ
      expect(await refreshOf(created.returnId)).toBe('closed');
    });

    test('開き直した返品は closed_at が残ったまま受付中に戻り、条件を満たしてまた閉じる時に closed_at が今の時刻に書き直される', async () => {
      const closedAtIsNow = async (returnId: string) =>
        (await db().query('select closed_at = pg_catalog.now() as is_now from public.order_returns where id = $1', [returnId])).rows[0]
          .is_now as boolean;
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2, { resolution: 'exchange' });
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind: 'close_missing',
        lines: [{ returnLineId: created.lineId, disposition: 'missing', quantity: 2 }],
      });
      expect(await refreshOf(created.returnId)).toBe('closed');
      expect(await closedAtIsNow(created.returnId)).toBe(true);

      // 取引の中では now() が止まっているので、前の完了の時刻を 2 日前へずらしてから開き直す。開き直しは closed_at を消さない
      await db().query("update public.order_returns set closed_at = now() - interval '2 days' where id = $1", [created.returnId]);
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind: 'reopen',
        lines: [{ returnLineId: created.lineId, disposition: 'missing_reopened', quantity: 2 }],
      });
      await db().query("update public.order_returns set status = 'open', reopened_at = now() where id = $1", [created.returnId]);
      expect(await stateOf(created.returnId)).toEqual({ status: 'open', has_closed_at: true });

      // 届かなかった 2 点が未処理に戻ったので、受け取るまでは受付中のまま。closed_at も前のまま
      expect(await refreshOf(created.returnId)).toBe('open');
      expect(await closedAtIsNow(created.returnId)).toBe(false);

      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        refundChoice: 'consult',
        lines: [{ returnLineId: created.lineId, disposition: 'restocked', quantity: 2 }],
      });
      expect(await refreshOf(created.returnId)).toBe('closed');
      expect(await closedAtIsNow(created.returnId)).toBe(true);
    });

    type Unit ={ disposition: 'restocked' | 'sent_back' | 'missing' | 'refund_waived'; quantity: number };

    test.each<[string, 'receive' | 'close_missing', Unit[], 'refund' | 'exchange']>([
      ['全部を交換にした（返金の品が無い）', 'receive', [{ disposition: 'restocked', quantity: 2 }], 'exchange'],
      ['全部をお返しした', 'receive', [{ disposition: 'sent_back', quantity: 2 }], 'refund'],
      ['全部を届かないとして終えた', 'close_missing', [{ disposition: 'missing', quantity: 2 }], 'refund'],
      [
        '戻した品の返金を 0 円で終えた（返金しないことにした）',
        'receive',
        [{ disposition: 'restocked', quantity: 2 }, { disposition: 'refund_waived', quantity: 2 }],
        'refund',
      ],
    ])('返金待ちが無い返品は closed になる: %s', async (_label, kind, units, resolution) => {
      const order = await createShipped(db(), 3);
      const created = await returnOf(db(), order, 2, { resolution });
      await insertReturnReceipt(db(), {
        returnId: created.returnId,
        kind,
        refundChoice: 'consult',
        sentBackMessage: units.some((unit) => unit.disposition === 'sent_back') ? 'お返しします' : null,
        lines: units.map((unit) => ({ returnLineId: created.lineId, ...unit })),
      });

      expect(await refreshOf(created.returnId)).toBe('closed');
    });

    test('未処理の品・検品待ち・お支払い待ちが残る間は受付中のまま。決まれば closed になる', async () => {
      const order = await createShipped(db(), 3);
      // 未処理: 2 点のうち 1 点だけ受け取って返金した
      const partial = await returnOf(db(), order, 2);
      await insertReturnReceipt(db(), {
        returnId: partial.returnId,
        refundChoice: 'now',
        lines: [{ returnLineId: partial.lineId, disposition: 'restocked', quantity: 1 }],
      });
      await insertReturnRefund(db(), { orderId: order.orderId, returnId: partial.returnId, lines: [{ orderItemId: order.orderItemId, quantity: 1 }] });
      expect(await refreshOf(partial.returnId)).toBe('open');

      // 検品待ち: 受け取って返金したが、検品待ちが残っている。検品で決めると closed
      const inspected = await returnOf(db(), order, 1);
      await insertReturnReceipt(db(), {
        returnId: inspected.returnId,
        refundChoice: 'now',
        lines: [{ returnLineId: inspected.lineId, disposition: 'pending_inspection', quantity: 1 }],
      });
      await insertReturnRefund(db(), { orderId: order.orderId, returnId: inspected.returnId, lines: [{ orderItemId: order.orderItemId, quantity: 1 }] });
      expect(await refreshOf(inspected.returnId)).toBe('open');
      await insertReturnReceipt(db(), {
        returnId: inspected.returnId,
        kind: 'inspect',
        lines: [{ returnLineId: inspected.lineId, disposition: 'inspected_restocked', quantity: 1 }],
      });
      expect(await refreshOf(inspected.returnId)).toBe('closed');

      // お支払い待ち: 手数料を受け取るまで closed にならない
      const other = await createShipped(db(), 3);
      const fee = await returnOf(db(), other, 2, { resolution: 'exchange', feeDueAmount: 500 });
      await insertReturnReceipt(db(), {
        returnId: fee.returnId,
        lines: [{ returnLineId: fee.lineId, disposition: 'restocked', quantity: 2 }],
      });
      expect(await refreshOf(fee.returnId)).toBe('open');
      await db().query('update public.order_returns set fee_received_at = now() where id = $1', [fee.returnId]);
      expect(await refreshOf(fee.returnId)).toBe('closed');
    });

    test('受付中でない返品はそのまま（完了を受付中に戻さない。完了した返品の返金待ちが戻っても、完了のまま）。返品が無ければ null', async () => {
      const order = await createShipped(db(), 3);
      for (const status of ['requested', 'cancelled', 'declined'] as const) {
        const created = await returnOf(db(), order, 1, { status });
        expect(await refreshOf(created.returnId)).toBe(status);
      }

      const closed = await returnOf(db(), order, 1, { status: 'closed' });
      await insertReturnReceipt(db(), {
        returnId: closed.returnId,
        refundChoice: 'consult',
        lines: [{ returnLineId: closed.lineId, disposition: 'restocked', quantity: 1 }],
      });
      // 返金待ちが残っているのに closed の返品（返金が失敗した後と同じ形）
      expect(await countsOf(db(), order.orderId, order.orderItemId)).toMatchObject({ refund_waiting: 1 });
      expect(await refreshOf(closed.returnId)).toBe('closed');
      expect(await stateOf(closed.returnId)).toMatchObject({ status: 'closed' });

      expect(await refreshOf(crypto.randomUUID())).toBeNull();
    });
  });
});
