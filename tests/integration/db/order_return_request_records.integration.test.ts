/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  addItemVariant,
  createCatalogFixture,
  createShippedOrderFixture,
  insertCancelRequest,
  insertRefundRecord,
  insertReturnPhoto,
  insertReturnPhotoUpload,
  insertReturnReceipt,
  insertReturnRecord,
  insertReturnRefund,
  type ReturnFixtureStatus,
} from './helpers/order-fixtures';

/**
 * 返品の申し込みの記録と守り（グループ E-3 段 2 設計書 4-5・4-6・4-7・10-3、移行 D）。
 * 1件ごとに取引の中で動かし、終わったら戻す。申し込み・承認・お断りの関数（移行 E・F）はまだ無いので、
 * 返品・写真の送り先・写真・キャンセルの申し込みは postgres で直接書く
 * （order-fixtures.ts の insertReturnRecord・insertReturnPhotoUpload・insertReturnPhoto・insertCancelRequest）。
 * 守りの試験は「直せない」だけでなく、直せる側（空から値への 1 回・承認の 1 回の更新）も必ず通して確かめる。
 */
jest.setTimeout(30000);

const APPEND_ONLY = { code: '23514', message: 'ORDER_RETURN_APPEND_ONLY' };
const IMMUTABLE = { code: '23514', message: 'ORDER_RETURN_IMMUTABLE' };
const CANCEL_APPEND_ONLY = { code: '23514', message: 'ORDER_CANCEL_REQUEST_APPEND_ONLY' };
const CANCEL_IMMUTABLE = { code: '23514', message: 'ORDER_CANCEL_REQUEST_IMMUTABLE' };
const CANCEL_INVALID_TRANSITION = { code: '23514', message: 'ORDER_CANCEL_REQUEST_INVALID_TRANSITION' };

/** 新しい 4 つの表（写真の送り先・写真・キャンセルの申し込みとその行） */
const NEW_TABLES = [
  'order_return_photo_uploads',
  'order_return_photos',
  'order_cancel_requests',
  'order_cancel_request_lines',
];

/** この移行で作った・作り直した private の関数。実行の権限は PUBLIC にも service_role にも無い */
const PRIVATE_FUNCTIONS = [
  'private.guard_order_return_change()',
  'private.guard_order_return_line_change()',
  'private.guard_return_photo_upload_change()',
  'private.guard_return_photo_change()',
  'private.guard_order_cancel_request_change()',
  'private.reject_order_cancel_request_line_change()',
  'private.check_cancel_request_line_order()',
  'private.enqueue_order_email(uuid, text, text, uuid, uuid)',
];

/** 注文のメールの予定の新しい種類。返品の 3 つは返品の番号を、キャンセルの申し込みの 3 つは申し込みの番号を持つ */
const RETURN_KINDS = ['return_requested', 'return_declined', 'return_request_shop'];
const CANCEL_KINDS = ['cancel_request_received', 'cancel_request_declined', 'cancel_request_shop'];

/** 承認で決める 10 列を、今の値に関わらず必ず別の値に変える書き方 */
const CHANGE_APPROVAL_COLUMNS = [
  "return_method = case return_method when 'not_required' then 'customer_ships' else 'not_required' end",
  "return_shipping_payer = case return_shipping_payer when 'shop' then 'customer' else 'shop' end",
  "return_carrier = case return_carrier when 'sagawa' then 'yamato' else 'sagawa' end",
  "return_tracking_number = coalesce(return_tracking_number, '') || 'x'",
  'return_shipping_fee = return_shipping_fee + 1',
  'restocking_fee_percent = restocking_fee_percent + 1',
  'exchange_fee = exchange_fee + 1',
  'exchange_shipping_fee = exchange_shipping_fee + 1',
  'notify_customer = not notify_customer',
  "shop_note = coalesce(shop_note, '') || 'x'",
];

/** 承認（requested → open）の 1 回の更新。承認で決める 10 列をまとめて決める（$1 は返品、$2 は承認した人） */
const APPROVE_SQL = `update public.order_returns
  set status = 'open', approved_at = now(), approved_by = $2,
      return_method = 'shop_label', return_shipping_payer = 'customer', return_carrier = 'yamato', return_tracking_number = 'ABC-123',
      return_shipping_fee = 700, restocking_fee_percent = 10, exchange_fee = 200, exchange_shipping_fee = 300,
      notify_customer = true, shop_note = '承認のメモ'
  where id = $1`;

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

/** 1 行だけの返品を、状態を決めて直接書く */
async function returnOf(db: PgClient, order: ShippedOrder, quantity: number, status: ReturnFixtureStatus) {
  const created = await insertReturnRecord(db, {
    orderId: order.orderId,
    status,
    lines: [{ fulfillmentId: order.fulfillmentId, orderItemId: order.orderItemId, quantity }],
  });
  return { returnId: created.returnId, lineId: created.lineIds[0] };
}

/** キャンセルの申し込みの行を、列ごとに SQL の書き方を決めて直接書く。状態ごとの CHECK の試験が使う */
function insertCancelRequestRow(db: PgClient, orderId: string, extra: Record<string, string> = {}) {
  const columns: Record<string, string> = {
    order_id: '$1',
    status: "'requested'",
    request_key: 'gen_random_uuid()',
    request_fingerprint: "'f'",
    requested_by: 'gen_random_uuid()',
    ...extra,
  };
  return db.query(
    `insert into public.order_cancel_requests (${Object.keys(columns).join(', ')}) values (${Object.values(columns).join(', ')})`,
    [orderId],
  );
}

/** 写真の行を、列ごとに SQL の書き方を決めて直接書く。値の決まりの試験が使う（$1 は返品の行、$2 は送り先） */
function insertPhotoRow(db: PgClient, ids: { returnLineId: string; uploadId: string }, extra: Record<string, string> = {}) {
  const columns: Record<string, string> = {
    return_line_id: '$1',
    upload_id: '$2',
    storage_path: "'requests/x'",
    content_type: "'image/jpeg'",
    size_bytes: '1000',
    ...extra,
  };
  return db.query(
    `insert into public.order_return_photos (${Object.keys(columns).join(', ')}) values (${Object.values(columns).join(', ')})`,
    [ids.returnLineId, ids.uploadId],
  );
}

/** メールの予定を直接書く（番号の組と一意の決まりの試験用）。origin の既定は auto */
function insertEmailRow(
  db: PgClient,
  orderId: string,
  kind: string,
  extra: {
    variant?: string | null;
    origin?: string;
    returnId?: string | null;
    receiptId?: string | null;
    refundId?: string | null;
    cancelRequestId?: string | null;
  } = {},
) {
  return db.query(
    `insert into private.order_email_outbox (order_id, kind, variant, origin, return_id, return_receipt_id, refund_id, cancel_request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orderId,
      kind,
      extra.variant ?? null,
      extra.origin ?? 'auto',
      extra.returnId ?? null,
      extra.receiptId ?? null,
      extra.refundId ?? null,
      extra.cancelRequestId ?? null,
    ],
  );
}

describeLocalDb('integration: 返品の申し込みの記録と守り（移行 D）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('表・関数・権限の守り', () => {
    test('お客様とログインした人は読めず、アプリは読むだけ（写真の送り先・写真・キャンセルの申し込みとその行）', async () => {
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

    test('行の守りが 4 つの表で有効で、anon・authenticated を RESTRICTIVE の方針で全部断る', async () => {
      // 並びは DB の照合順序に頼らず、表の名前を鍵にした形で比べる
      const enabled = await db().query(
        `select c.relname, c.relrowsecurity
         from pg_class as c
         where c.relnamespace = 'public'::regnamespace and c.relname = any($1::text[])`,
        [NEW_TABLES],
      );
      expect(Object.fromEntries(enabled.rows.map((row) => [row.relname as string, row.relrowsecurity as boolean]))).toEqual(
        Object.fromEntries(NEW_TABLES.map((table) => [table, true])),
      );

      const policies = await db().query(
        `select tablename, permissive, (select string_agg(r, ',' order by r) from unnest(roles) as r) as roles
         from pg_policies
         where schemaname = 'public' and tablename = any($1::text[]) and policyname = 'deny direct client access'`,
        [NEW_TABLES],
      );
      expect(Object.fromEntries(policies.rows.map((row) => [row.tablename as string, `${row.permissive}:${row.roles}`]))).toEqual(
        Object.fromEntries(NEW_TABLES.map((table) => [table, 'RESTRICTIVE:anon,authenticated'])),
      );
    });

    test('メールを取り出す関数を実行できるのは service_role だけ。作った private の関数は service_role も実行できない', async () => {
      const claim = await db().query(
        `select has_function_privilege('anon', 'public.claim_order_email(integer)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.claim_order_email(integer)', 'execute') as authed,
                has_function_privilege('service_role', 'public.claim_order_email(integer)', 'execute') as service`,
      );
      expect(claim.rows[0]).toEqual({ anon: false, authed: false, service: true });

      for (const fn of PRIVATE_FUNCTIONS) {
        const res = await db().query("select has_function_privilege('service_role', $1, 'execute') as service", [fn]);
        expect({ fn, service: res.rows[0].service }).toEqual({ fn, service: false });
      }
    });

    test('作った・作り直した関数は、どれも search_path を空に固定している', async () => {
      const names = [
        'guard_order_return_change',
        'guard_order_return_line_change',
        'guard_return_photo_upload_change',
        'guard_return_photo_change',
        'guard_order_cancel_request_change',
        'reject_order_cancel_request_line_change',
        'check_cancel_request_line_order',
        'enqueue_order_email',
      ];
      const res = await db().query(
        `select n.nspname || '.' || p.proname as name, array_to_string(p.proconfig, ',') as config
         from pg_proc as p
         join pg_namespace as n on n.oid = p.pronamespace
         where (n.nspname = 'private' and p.proname = any($1::text[]))
            or (n.nspname = 'public' and p.proname = 'claim_order_email')`,
        [names],
      );
      expect(res.rows.map((row) => row.name as string).sort()).toEqual(
        [...names.map((name) => `private.${name}`), 'public.claim_order_email'].sort(),
      );
      for (const row of res.rows) expect({ name: row.name, config: row.config }).toEqual({ name: row.name, config: 'search_path=""' });
    });

    test('写真の置き場 return-photos は非公開で、1 つの物は 10MiB まで、種類は JPEG と PNG だけ。storage.objects の方針は作らない', async () => {
      const res = await db().query(
        `select id, name, public, file_size_limit::integer as file_size_limit, allowed_mime_types
         from storage.buckets
         where id = 'return-photos'`,
      );
      expect(res.rows).toHaveLength(1);
      expect({ ...res.rows[0], allowed_mime_types: [...res.rows[0].allowed_mime_types].sort() }).toEqual({
        id: 'return-photos',
        name: 'return-photos',
        public: false,
        file_size_limit: 10485760,
        allowed_mime_types: ['image/jpeg', 'image/png'],
      });

      // 置き場の窓口と署名つきの送り先・リンクだけで読み書きする。storage.objects にこの入れ物の方針は作らない
      const policies = await db().query(
        `select count(*)::int as n
         from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and (coalesce(qual, '') like '%return-photos%' or coalesce(with_check, '') like '%return-photos%')`,
      );
      expect(policies.rows[0].n).toBe(0);
    });

    test('定期処理の最後の成功の印に return_photo_purge を足した。ほかの 5 つは今までどおり、知らない名前は断る', async () => {
      for (const job of [
        'webhook_worker',
        'order_sweep',
        'stripe_reconcile',
        'order_email_worker',
        'order_email_delivery_check',
        'return_photo_purge',
      ]) {
        await db().query('select public.record_ops_heartbeat($1::text, true)', [job]);
      }
      await db().query("select public.record_ops_heartbeat('return_photo_purge', false, 'storage_unavailable')");
      const res = await db().query(
        `select job, last_succeeded_at is not null as succeeded, last_failed_at is not null as failed, last_error_code
         from public.get_ops_heartbeats()
         where job = 'return_photo_purge'`,
      );
      expect(res.rows).toEqual([{ job: 'return_photo_purge', succeeded: true, failed: true, last_error_code: 'storage_unavailable' }]);

      await expectRejected(db(), "select public.record_ops_heartbeat('unknown_job', true)", [], {
        code: '23514',
        constraint: 'ops_job_heartbeats_job_check',
      });
    });
  });

  describe('商品の返品不可の列', () => {
    test('return_ineligible は最初は偽で、空にはできない。真にすると読める', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const read = async () =>
        (await db().query('select return_ineligible from public.items where id = $1', [fx.itemId])).rows[0].return_ineligible as boolean;

      expect(await read()).toBe(false);
      await db().query('update public.items set return_ineligible = true where id = $1', [fx.itemId]);
      expect(await read()).toBe(true);
      await expectRejected(db(), 'update public.items set return_ineligible = null where id = $1', [fx.itemId], { code: '23502' });

      const column = await db().query(
        `select is_nullable, data_type, column_default
         from information_schema.columns
         where table_schema = 'public' and table_name = 'items' and column_name = 'return_ineligible'`,
      );
      expect(column.rows[0]).toEqual({ is_nullable: 'NO', data_type: 'boolean', column_default: 'false' });
    });
  });

  describe('写真の送り先（order_return_photo_uploads）', () => {
    test('場所の形・場所の一意・注文の外部キー・最初の値', async () => {
      const order = await createShipped(db(), 1);
      const uploadId = crypto.randomUUID();
      const insertUpload = (orderId: string, storagePath: string) =>
        db().query(
          'insert into public.order_return_photo_uploads (order_id, customer_id, storage_path) values ($1, gen_random_uuid(), $2) returning *',
          [orderId, storagePath],
        );

      // 場所は requests/{注文の番号}/{送り先の番号}（小文字の 16 進と - の 36 字ずつ）だけ
      const malformed = [
        `photos/${order.orderId}/${uploadId}`,
        `requests/${order.orderId}`,
        `requests/${order.orderId}/${uploadId}/extra`,
        `requests/${order.orderId}/${uploadId.slice(1)}`,
        `requests/${order.orderId}/${uploadId}0`,
        `requests/${order.orderId}/ABCDEF01-2345-6789-ABCD-EF0123456789`,
        `/requests/${order.orderId}/${uploadId}`,
      ];
      for (const storagePath of malformed) {
        await db().query('savepoint check_case');
        await expect(insertUpload(order.orderId, storagePath)).rejects.toMatchObject({
          code: '23514',
          constraint: 'order_return_photo_uploads_storage_path_check',
        });
        await db().query('rollback to savepoint check_case');
      }

      const saved = await insertUpload(order.orderId, `requests/${order.orderId}/${uploadId}`);
      expect(saved.rows[0]).toMatchObject({ order_id: order.orderId, attached_at: null, purged_at: null });
      expect(saved.rows[0].created_at).toBeInstanceOf(Date);

      // 同じ場所は 2 度使えない
      await expectRejected(
        db(),
        'insert into public.order_return_photo_uploads (order_id, customer_id, storage_path) values ($1, gen_random_uuid(), $2)',
        [order.orderId, `requests/${order.orderId}/${uploadId}`],
        { code: '23505', constraint: 'order_return_photo_uploads_storage_path_key' },
      );
      // 注文が無ければ断る
      const missingOrder = crypto.randomUUID();
      await expectRejected(
        db(),
        'insert into public.order_return_photo_uploads (order_id, customer_id, storage_path) values ($1, gen_random_uuid(), $2)',
        [missingOrder, `requests/${missingOrder}/${crypto.randomUUID()}`],
        { code: '23503', constraint: 'order_return_photo_uploads_order_id_fkey' },
      );
    });

    test('索引: 注文ごとの引きと、まだ使っていない・消していない送り先の索引（1 日で消す処理が使う）', async () => {
      const res = await db().query(
        `select indexname, indexdef
         from pg_indexes
         where schemaname = 'public' and tablename = 'order_return_photo_uploads'`,
      );
      const defs = Object.fromEntries(res.rows.map((row) => [row.indexname as string, row.indexdef as string]));
      expect(Object.keys(defs).sort()).toEqual([
        'order_return_photo_uploads_order_idx',
        'order_return_photo_uploads_pkey',
        'order_return_photo_uploads_storage_path_key',
        'order_return_photo_uploads_unattached_idx',
      ]);
      expect(defs.order_return_photo_uploads_order_idx).toContain('(order_id, created_at)');
      expect(defs.order_return_photo_uploads_unattached_idx).toContain('(created_at)');
      expect(defs.order_return_photo_uploads_unattached_idx).toContain('attached_at IS NULL');
      expect(defs.order_return_photo_uploads_unattached_idx).toContain('purged_at IS NULL');
    });

    test('使った時刻 attached_at と消した時刻 purged_at は、空から値へ 1 回だけ進む。値から別の値・値から空へは戻せない', async () => {
      const order = await createShipped(db(), 1);
      const upload = await insertReturnPhotoUpload(db(), { orderId: order.orderId });
      const read = async () =>
        (
          await db().query(
            `select attached_at is not null as attached, purged_at is not null as purged
             from public.order_return_photo_uploads
             where id = $1`,
            [upload.uploadId],
          )
        ).rows[0];
      expect(await read()).toEqual({ attached: false, purged: false });

      await db().query('update public.order_return_photo_uploads set attached_at = now() where id = $1', [upload.uploadId]);
      expect(await read()).toEqual({ attached: true, purged: false });
      await db().query('update public.order_return_photo_uploads set purged_at = now() where id = $1', [upload.uploadId]);
      expect(await read()).toEqual({ attached: true, purged: true });

      for (const set of [
        "attached_at = now() + interval '1 second'",
        'attached_at = null',
        "purged_at = now() + interval '1 second'",
        'purged_at = null',
      ]) {
        await expectRejected(db(), `update public.order_return_photo_uploads set ${set} where id = $1`, [upload.uploadId], IMMUTABLE);
      }
    });

    test('時刻のほかの列は直せず、送り先は消せない', async () => {
      const order = await createShipped(db(), 1);
      const other = await createShipped(db(), 1);
      const upload = await insertReturnPhotoUpload(db(), { orderId: order.orderId });

      for (const set of [
        'customer_id = gen_random_uuid()',
        "storage_path = 'requests/' || order_id::text || '/' || gen_random_uuid()::text",
        "created_at = now() - interval '1 day'",
        'id = gen_random_uuid()',
      ]) {
        await expectRejected(db(), `update public.order_return_photo_uploads set ${set} where id = $1`, [upload.uploadId], IMMUTABLE);
      }
      await expectRejected(
        db(),
        'update public.order_return_photo_uploads set order_id = $2 where id = $1',
        [upload.uploadId, other.orderId],
        IMMUTABLE,
      );
      await expectRejected(db(), 'delete from public.order_return_photo_uploads where id = $1', [upload.uploadId], APPEND_ONLY);
    });
  });

  describe('写真（order_return_photos）', () => {
    async function createPhotoFixture() {
      const order = await createShipped(db(), 2);
      const created = await returnOf(db(), order, 1, 'requested');
      const photo = await insertReturnPhoto(db(), { returnLineId: created.lineId, orderId: order.orderId });
      return { order, lineId: created.lineId, photo };
    }

    test('値の決まり: 種類は JPEG と PNG だけ、大きさは 1〜10485760。送り先 1 つに写真は 1 枚、返品の行と送り先は実在する物だけ', async () => {
      const { order, lineId, photo } = await createPhotoFixture();
      const fresh = async () => (await insertReturnPhotoUpload(db(), { orderId: order.orderId })).uploadId;

      const refused: Array<[Record<string, string>, string]> = [
        [{ content_type: "'image/gif'" }, 'order_return_photos_content_type_check'],
        [{ size_bytes: '0' }, 'order_return_photos_size_bytes_check'],
        [{ size_bytes: '-1' }, 'order_return_photos_size_bytes_check'],
        [{ size_bytes: '10485761' }, 'order_return_photos_size_bytes_check'],
      ];
      for (const [extra, constraint] of refused) {
        const uploadId = await fresh();
        await db().query('savepoint check_case');
        await expect(insertPhotoRow(db(), { returnLineId: lineId, uploadId }, extra)).rejects.toMatchObject({ code: '23514', constraint });
        await db().query('rollback to savepoint check_case');
      }

      // 範囲の端と、PNG は通る
      await insertPhotoRow(db(), { returnLineId: lineId, uploadId: await fresh() }, { size_bytes: '1' });
      await insertPhotoRow(db(), { returnLineId: lineId, uploadId: await fresh() }, { size_bytes: '10485760', content_type: "'image/png'" });

      // 同じ送り先の写真は 2 枚目を書けない
      await db().query('savepoint check_case');
      await expect(insertPhotoRow(db(), { returnLineId: lineId, uploadId: photo.uploadId })).rejects.toMatchObject({
        code: '23505',
        constraint: 'order_return_photos_upload_id_key',
      });
      await db().query('rollback to savepoint check_case');

      // 実在しない送り先・返品の行は断る
      await db().query('savepoint check_case');
      await expect(insertPhotoRow(db(), { returnLineId: lineId, uploadId: crypto.randomUUID() })).rejects.toMatchObject({
        code: '23503',
        constraint: 'order_return_photos_upload_id_fkey',
      });
      await db().query('rollback to savepoint check_case');
      const freshUploadId = await fresh();
      await db().query('savepoint check_case');
      await expect(insertPhotoRow(db(), { returnLineId: crypto.randomUUID(), uploadId: freshUploadId })).rejects.toMatchObject({
        code: '23503',
        constraint: 'order_return_photos_return_line_id_fkey',
      });
      await db().query('rollback to savepoint check_case');
    });

    test('消した時刻 purged_at だけが、空から値へ 1 回進む。ほかの列は直せず、写真は消せない', async () => {
      const { order, lineId, photo } = await createPhotoFixture();

      await db().query('update public.order_return_photos set purged_at = now() where id = $1', [photo.photoId]);
      for (const set of ["purged_at = now() + interval '1 second'", 'purged_at = null']) {
        await expectRejected(db(), `update public.order_return_photos set ${set} where id = $1`, [photo.photoId], IMMUTABLE);
      }

      const second = await insertReturnPhoto(db(), { returnLineId: lineId, orderId: order.orderId });
      for (const set of [
        'size_bytes = size_bytes + 1',
        "content_type = case content_type when 'image/png' then 'image/jpeg' else 'image/png' end",
        "storage_path = storage_path || 'x'",
        "created_at = now() - interval '1 day'",
        'upload_id = gen_random_uuid()',
        'return_line_id = gen_random_uuid()',
        'id = gen_random_uuid()',
      ]) {
        await expectRejected(db(), `update public.order_return_photos set ${set} where id = $1`, [second.photoId], IMMUTABLE);
      }
      await expectRejected(db(), 'delete from public.order_return_photos where id = $1', [second.photoId], APPEND_ONLY);
    });

    test('索引: 返品の行ごとの引き', async () => {
      const res = await db().query(
        `select indexname, indexdef
         from pg_indexes
         where schemaname = 'public' and tablename = 'order_return_photos'`,
      );
      const defs = Object.fromEntries(res.rows.map((row) => [row.indexname as string, row.indexdef as string]));
      expect(Object.keys(defs).sort()).toEqual([
        'order_return_photos_line_idx',
        'order_return_photos_pkey',
        'order_return_photos_upload_id_key',
      ]);
      expect(defs.order_return_photos_line_idx).toContain('(return_line_id)');
    });
  });

  describe('キャンセルの申し込み（order_cancel_requests・order_cancel_request_lines）', () => {
    test('値の決まり: ご連絡事項は 300 字まで・お断りのメッセージは 1000 字まで・お断りの理由は 3 つだけ。二重防止の番号は表全体で一意', async () => {
      const order = await createShipped(db(), 1);
      const other = await createShipped(db(), 1);
      const refused: Array<[Record<string, string>, string]> = [
        [{ customer_note: "repeat('あ', 301)" }, 'order_cancel_requests_customer_note_check'],
        [{ decline_reason: "'x'" }, 'order_cancel_requests_decline_reason_check'],
        [{ decline_message: "repeat('あ', 1001)" }, 'order_cancel_requests_decline_message_check'],
      ];
      for (const [extra, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(insertCancelRequestRow(db(), order.orderId, extra)).rejects.toMatchObject({ code: '23514', constraint });
        await db().query('rollback to savepoint check_case');
      }

      // 範囲の端は通る（お断りの行で書く。申し込み中は注文に 1 つだけなので）
      const declined = {
        status: "'declined'",
        declined_at: 'now()',
        decline_reason: "'window_passed'",
        decline_message: "repeat('あ', 1000)",
        customer_note: "repeat('あ', 300)",
      };
      await insertCancelRequestRow(db(), order.orderId, declined);
      for (const reason of ['window_passed', 'final_sale', 'other']) {
        await insertCancelRequestRow(db(), order.orderId, { ...declined, decline_reason: `'${reason}'` });
      }

      // 二重防止の番号は表全体で一意（ほかの注文でも 2 度は使えない）
      const requestKey = crypto.randomUUID();
      await insertCancelRequestRow(db(), order.orderId, { ...declined, request_key: `'${requestKey}'` });
      await db().query('savepoint check_case');
      await expect(insertCancelRequestRow(db(), other.orderId, { ...declined, request_key: `'${requestKey}'` })).rejects.toMatchObject({
        code: '23505',
        constraint: 'order_cancel_requests_request_key_key',
      });
      await db().query('rollback to savepoint check_case');

      // 注文が無ければ断る
      await db().query('savepoint check_case');
      await expect(insertCancelRequestRow(db(), crypto.randomUUID(), declined)).rejects.toMatchObject({
        code: '23503',
        constraint: 'order_cancel_requests_order_id_fkey',
      });
      await db().query('rollback to savepoint check_case');
    });

    test('状態ごとの決まり: 申し込み中は終わりの時刻を持たず、お断りは時刻・理由・メッセージが、解決は返金か取消のどちらか 1 つが、解決済みは時刻が要る', async () => {
      const order = await createShipped(db(), 1);
      const refund = await insertRefundRecord(db(), { orderId: order.orderId });
      const refundId = `'${refund.refundId}'`;
      const refused: Array<Record<string, string>> = [
        // 申し込み中が、終わりの時刻を持つ
        { declined_at: 'now()' },
        { resolved_at: 'now()' },
        { closed_at: 'now()' },
        // お断りに、時刻・理由・メッセージのどれかが無い
        { status: "'declined'", decline_reason: "'other'", decline_message: "'文'" },
        { status: "'declined'", declined_at: 'now()', decline_message: "'文'" },
        { status: "'declined'", declined_at: 'now()', decline_reason: "'other'" },
        // 解決に、時刻が無い／返金も取消も無い／返金も取消もある
        { status: "'resolved'", resolved_by_cancel_at: 'now()' },
        { status: "'resolved'", resolved_at: 'now()' },
        { status: "'resolved'", resolved_at: 'now()', resolved_refund_id: refundId, resolved_by_cancel_at: 'now()' },
        // 解決済みに、時刻が無い
        { status: "'closed'" },
        // 知らない状態（状態の CHECK より先に、表の CHECK が断る）
        { status: "'x'" },
      ];
      for (const extra of refused) {
        await db().query('savepoint check_case');
        await expect(insertCancelRequestRow(db(), order.orderId, extra)).rejects.toMatchObject({
          code: '23514',
          constraint: 'order_cancel_requests_state_check',
        });
        await db().query('rollback to savepoint check_case');
      }

      // 通る形: お断り・解決（返金だけ）・解決（キャンセルだけ）・解決済み・申し込み中
      await insertCancelRequestRow(db(), order.orderId, {
        status: "'declined'", declined_at: 'now()', decline_reason: "'other'", decline_message: "'文'",
      });
      await insertCancelRequestRow(db(), order.orderId, { status: "'resolved'", resolved_at: 'now()', resolved_refund_id: refundId });
      await insertCancelRequestRow(db(), order.orderId, { status: "'resolved'", resolved_at: 'now()', resolved_by_cancel_at: 'now()' });
      await insertCancelRequestRow(db(), order.orderId, { status: "'closed'", closed_at: 'now()' });
      await insertCancelRequestRow(db(), order.orderId);

      // 返金は実在する物だけ
      await db().query('savepoint check_case');
      await expect(
        insertCancelRequestRow(db(), order.orderId, {
          status: "'resolved'", resolved_at: 'now()', resolved_refund_id: 'gen_random_uuid()',
        }),
      ).rejects.toMatchObject({ code: '23503', constraint: 'order_cancel_requests_resolved_refund_id_fkey' });
      await db().query('rollback to savepoint check_case');
    });

    test('開いている（申し込み中の）申し込みは注文に 1 つだけ。終わった申し込みは何件でもよく、ほかの注文には別に 1 つ書ける', async () => {
      const order = await createShipped(db(), 2);
      const other = await createShipped(db(), 1);
      const lines = [{ orderItemId: order.orderItemId, quantity: 1 }];

      await insertCancelRequest(db(), { orderId: order.orderId, lines });
      await expectRejected(db(), `insert into public.order_cancel_requests
          (order_id, status, request_key, request_fingerprint, requested_by)
        values ($1, 'requested', gen_random_uuid(), 'f', gen_random_uuid())`, [order.orderId], {
        code: '23505',
        constraint: 'order_cancel_requests_open_idx',
      });
      for (const status of ['declined', 'closed', 'resolved', 'declined'] as const) {
        await insertCancelRequest(db(), { orderId: order.orderId, lines, status });
      }
      await insertCancelRequest(db(), { orderId: other.orderId, lines: [{ orderItemId: other.orderItemId, quantity: 1 }] });

      const open = await db().query(
        "select count(*)::int as n from public.order_cancel_requests where order_id = $1 and status = 'requested'",
        [order.orderId],
      );
      expect(open.rows[0].n).toBe(1);
    });

    test('申し込み中から、お断り・解決（返金）・解決（取消）・解決済みへ進める。直せるのは状態・時刻・する人・お断り・解決の列だけ', async () => {
      const order = await createShipped(db(), 3);
      const actor = crypto.randomUUID();
      const other = await createShipped(db(), 1);
      const refund = await insertRefundRecord(db(), { orderId: order.orderId });
      const lines = [{ orderItemId: order.orderItemId, quantity: 1 }];
      const stateOf = async (id: string) =>
        (
          await db().query(
            `select status, decline_reason, resolved_refund_id, resolved_by_cancel_at is not null as by_cancel
             from public.order_cancel_requests
             where id = $1`,
            [id],
          )
        ).rows[0];

      const toDeclined = await insertCancelRequest(db(), { orderId: order.orderId, lines });
      await db().query(
        `update public.order_cancel_requests
         set status = 'declined', declined_at = now(), declined_by = $2, decline_reason = 'other', decline_message = 'お断りの文'
         where id = $1`,
        [toDeclined.cancelRequestId, actor],
      );
      expect(await stateOf(toDeclined.cancelRequestId)).toEqual({
        status: 'declined', decline_reason: 'other', resolved_refund_id: null, by_cancel: false,
      });

      const toRefund = await insertCancelRequest(db(), { orderId: order.orderId, lines });
      await db().query(
        `update public.order_cancel_requests
         set status = 'resolved', resolved_at = now(), resolved_by = $2, resolved_refund_id = $3
         where id = $1`,
        [toRefund.cancelRequestId, actor, refund.refundId],
      );
      expect(await stateOf(toRefund.cancelRequestId)).toEqual({
        status: 'resolved', decline_reason: null, resolved_refund_id: refund.refundId, by_cancel: false,
      });

      const toCancel = await insertCancelRequest(db(), { orderId: order.orderId, lines });
      await db().query(
        `update public.order_cancel_requests
         set status = 'resolved', resolved_at = now(), resolved_by = $2, resolved_by_cancel_at = now()
         where id = $1`,
        [toCancel.cancelRequestId, actor],
      );
      expect(await stateOf(toCancel.cancelRequestId)).toEqual({
        status: 'resolved', decline_reason: null, resolved_refund_id: null, by_cancel: true,
      });

      const toClosed = await insertCancelRequest(db(), { orderId: order.orderId, lines });
      await db().query(
        `update public.order_cancel_requests set status = 'closed', closed_at = now(), closed_by = $2 where id = $1`,
        [toClosed.cancelRequestId, actor],
      );
      expect(await stateOf(toClosed.cancelRequestId)).toMatchObject({ status: 'closed' });

      // 申し込んだ内容と持ち主は、申し込み中でも直せない
      const open = await insertCancelRequest(db(), { orderId: order.orderId, lines });
      for (const set of [
        'request_key = gen_random_uuid()',
        "request_fingerprint = 'other'",
        "customer_note = 'あとから書き換え'",
        "requested_at = now() - interval '1 day'",
        'requested_by = gen_random_uuid()',
        'id = gen_random_uuid()',
      ]) {
        await expectRejected(db(), `update public.order_cancel_requests set ${set} where id = $1`, [open.cancelRequestId], CANCEL_IMMUTABLE);
      }
      await expectRejected(
        db(),
        'update public.order_cancel_requests set order_id = $2 where id = $1',
        [open.cancelRequestId, other.orderId],
        CANCEL_IMMUTABLE,
      );

      // 状態を変えない書き直しは、直せる列でも断る
      await expectRejected(
        db(),
        "update public.order_cancel_requests set decline_message = '書き換え' where id = $1",
        [open.cancelRequestId],
        CANCEL_INVALID_TRANSITION,
      );
    });

    test('終わった申し込み（お断り・解決・解決済み）は何も変えられない。申し込み中に戻すことも、別の終わりに変えることも、消すこともできない', async () => {
      const order = await createShipped(db(), 3);
      const refund = await insertRefundRecord(db(), { orderId: order.orderId });
      const lines = [{ orderItemId: order.orderItemId, quantity: 1 }];
      const declined = await insertCancelRequest(db(), { orderId: order.orderId, lines, status: 'declined' });
      const resolved = await insertCancelRequest(db(), { orderId: order.orderId, lines, status: 'resolved', resolvedRefundId: refund.refundId });
      const closed = await insertCancelRequest(db(), { orderId: order.orderId, lines, status: 'closed' });

      for (const request of [declined, resolved, closed]) {
        for (const status of ['requested', 'declined', 'resolved', 'closed']) {
          await expectRejected(
            db(),
            'update public.order_cancel_requests set status = $2 where id = $1',
            [request.cancelRequestId, status],
            CANCEL_INVALID_TRANSITION,
          );
        }
      }
      // 同じ状態のまま中身を書き換えることも断る
      await expectRejected(
        db(),
        "update public.order_cancel_requests set decline_message = '書き換え' where id = $1",
        [declined.cancelRequestId],
        CANCEL_INVALID_TRANSITION,
      );
      await expectRejected(db(), 'delete from public.order_cancel_requests where id = $1', [declined.cancelRequestId], CANCEL_APPEND_ONLY);
    });

    test('行: 同じ品は 1 回だけ・数は 1 以上・その申し込みの注文の品だけ。足した後は直せず消せない', async () => {
      const order = await createShippedOrderFixture(db(), { lines: [{ quantity: 2 }, { quantity: 1 }] });
      const other = await createShipped(db(), 1);
      const request = await insertCancelRequest(db(), {
        orderId: order.orderId,
        lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }],
      });
      const insertLine = 'insert into public.order_cancel_request_lines (cancel_request_id, order_item_id, quantity) values ($1, $2, $3)';

      await expectRejected(db(), insertLine, [request.cancelRequestId, order.orderItemIds[0], 1], {
        code: '23505',
        constraint: 'order_cancel_request_lines_request_item_key',
      });
      await expectRejected(db(), insertLine, [request.cancelRequestId, order.orderItemIds[1], 0], {
        code: '23514',
        constraint: 'order_cancel_request_lines_quantity_check',
      });
      await expectRejected(db(), insertLine, [request.cancelRequestId, other.orderItemId, 1], {
        code: '22023',
        message: 'CANCEL_REQUEST_LINE_NOT_IN_ORDER',
      });
      // その注文の別の品は足せる
      const added = await db().query(`${insertLine} returning id`, [request.cancelRequestId, order.orderItemIds[1], 1]);
      const lineId = added.rows[0].id as string;

      await expectRejected(db(), 'update public.order_cancel_request_lines set quantity = quantity + 1 where id = $1', [lineId], CANCEL_APPEND_ONLY);
      await expectRejected(db(), 'delete from public.order_cancel_request_lines where id = $1', [lineId], CANCEL_APPEND_ONLY);
    });

    test('TRUNCATE を断る文のトリガーが、新しい 4 つの表にある', async () => {
      const res = await db().query(
        `select c.relname || ':' || t.tgname as trigger_name
         from pg_trigger as t
         join pg_class as c on c.oid = t.tgrelid
         where c.relnamespace = 'public'::regnamespace
           and c.relname = any($1::text[])
           and not t.tgisinternal
           and (t.tgtype & 32) = 32`,
        [NEW_TABLES],
      );
      expect(res.rows.map((row) => row.trigger_name as string).sort()).toEqual([
        'order_cancel_request_lines:order_cancel_request_lines_no_truncate',
        'order_cancel_requests:order_cancel_requests_no_truncate',
        'order_return_photo_uploads:order_return_photo_uploads_no_truncate',
        'order_return_photos:order_return_photos_no_truncate',
      ]);
    });
  });

  describe('返品の表の守り（承認で直せる列）', () => {
    test('申し込み中（requested）から受付中（open）へ進める 1 回の更新でだけ、返送・手数料・知らせ・メモの 10 列を直せる', async () => {
      const order = await createShipped(db(), 3);
      const actor = crypto.randomUUID();
      const requested = await returnOf(db(), order, 1, 'requested');
      const open = await returnOf(db(), order, 1, 'open');

      // 申し込み中のまま、受付中のままの更新では、10 列のどれも直せない
      for (const returnId of [requested.returnId, open.returnId]) {
        for (const set of CHANGE_APPROVAL_COLUMNS) {
          await expectRejected(db(), `update public.order_returns set ${set} where id = $1`, [returnId], IMMUTABLE);
        }
      }

      // 承認の更新では、10 列をまとめて直せる
      await db().query(APPROVE_SQL, [requested.returnId, actor]);
      const saved = await db().query(
        `select status, approved_by, return_method, return_shipping_payer, return_carrier, return_tracking_number,
                return_shipping_fee, restocking_fee_percent, exchange_fee, exchange_shipping_fee, notify_customer, shop_note
         from public.order_returns
         where id = $1`,
        [requested.returnId],
      );
      expect(saved.rows[0]).toEqual({
        status: 'open',
        approved_by: actor,
        return_method: 'shop_label',
        return_shipping_payer: 'customer',
        return_carrier: 'yamato',
        return_tracking_number: 'ABC-123',
        return_shipping_fee: 700,
        restocking_fee_percent: 10,
        exchange_fee: 200,
        exchange_shipping_fee: 300,
        notify_customer: true,
        shop_note: '承認のメモ',
      });

      // 承認の後（open）は、10 列はもう直せない
      for (const set of CHANGE_APPROVAL_COLUMNS) {
        await expectRejected(db(), `update public.order_returns set ${set} where id = $1`, [requested.returnId], IMMUTABLE);
      }
    });

    test('承認の更新でも、10 列と時刻・する人・お断りの列のほかは直せない。お断り（requested → declined）では 10 列は直せない', async () => {
      const order = await createShipped(db(), 3);
      const other = await createShipped(db(), 1);
      const actor = crypto.randomUUID();
      const requested = await returnOf(db(), order, 1, 'requested');

      // 承認と同時に、直せない列を直そうとする
      for (const extra of [
        'number = 99',
        "source = 'shop'",
        'request_key = gen_random_uuid()',
        "request_fingerprint = 'other'",
        "created_at = now() - interval '1 day'",
        'created_by = gen_random_uuid()',
        "requested_at = now() - interval '1 day'",
        'requested_by = gen_random_uuid()',
      ]) {
        await expectRejected(
          db(),
          `update public.order_returns set status = 'open', approved_at = now(), notify_customer = true, ${extra} where id = $1`,
          [requested.returnId],
          IMMUTABLE,
        );
      }
      await expectRejected(
        db(),
        "update public.order_returns set status = 'open', approved_at = now(), order_id = $2 where id = $1",
        [requested.returnId, other.orderId],
        IMMUTABLE,
      );

      // お断りと同時に、10 列を直そうとする
      for (const set of CHANGE_APPROVAL_COLUMNS) {
        await expectRejected(
          db(),
          `update public.order_returns set status = 'declined', declined_at = now(), decline_reason = 'other', ${set} where id = $1`,
          [requested.returnId],
          IMMUTABLE,
        );
      }

      // お断りそのもの（時刻・する人・理由・メッセージ）は、今までどおり通る
      const declined = await returnOf(db(), order, 1, 'requested');
      await db().query(
        `update public.order_returns
         set status = 'declined', declined_at = now(), declined_by = $2, decline_reason = 'final_sale', decline_message = 'お断りの文'
         where id = $1`,
        [declined.returnId, actor],
      );
      const saved = await db().query('select status, decline_reason from public.order_returns where id = $1', [declined.returnId]);
      expect(saved.rows[0]).toEqual({ status: 'declined', decline_reason: 'final_sale' });

      // 承認は通る（上の失敗は、どれも何も書き換えていない）
      await db().query(APPROVE_SQL, [requested.returnId, actor]);
      const approved = await db().query('select status, number from public.order_returns where id = $1', [requested.returnId]);
      expect(approved.rows[0]).toEqual({ status: 'open', number: 1 });
    });
  });

  describe('返品の行の守り（承認で決める 3 列）', () => {
    test('親の返品が申し込み中（requested）の間だけ、解決・交換の色・サイズ・送り方を直せる。ほかの列は直せず、行は消せない', async () => {
      const order = await createShipped(db(), 3);
      const blue = await addItemVariant(db(), { itemId: order.itemId, colorName: 'BLUE', sizeLabel: 'L', stock: 2 });
      const requested = await returnOf(db(), order, 1, 'requested');
      const lineOf = async () =>
        (
          await db().query(
            'select resolution, exchange_variant_id, exchange_method from public.order_return_lines where id = $1',
            [requested.lineId],
          )
        ).rows[0];

      // 返金 → 交換（色違い・作って送る）→ 返金に戻す。どれも承認の前なら直せる
      await db().query(
        "update public.order_return_lines set resolution = 'exchange', exchange_variant_id = $2, exchange_method = 'make' where id = $1",
        [requested.lineId, blue.variantId],
      );
      expect(await lineOf()).toEqual({ resolution: 'exchange', exchange_variant_id: String(blue.variantId), exchange_method: 'make' });
      await db().query(
        "update public.order_return_lines set resolution = 'refund', exchange_variant_id = null, exchange_method = null where id = $1",
        [requested.lineId],
      );
      expect(await lineOf()).toEqual({ resolution: 'refund', exchange_variant_id: null, exchange_method: null });

      // 3 列のほかは、申し込み中でも直せない
      for (const set of [
        'quantity = quantity + 1',
        "reason = 'other'",
        "reason_note = '書き換え'",
        "customer_note = '書き換え'",
        "requested_resolution = 'refund'",
        "created_at = now() - interval '1 day'",
        'return_id = gen_random_uuid()',
        'fulfillment_id = gen_random_uuid()',
        'order_item_id = gen_random_uuid()',
      ]) {
        await expectRejected(db(), `update public.order_return_lines set ${set} where id = $1`, [requested.lineId], APPEND_ONLY);
      }

      // 消せない
      await expectRejected(db(), 'delete from public.order_return_lines where id = $1', [requested.lineId], APPEND_ONLY);
    });

    test('親の返品が申し込み中でなければ（受付中・完了・取消・お断り）、3 列も直せない。同じ注文の申し込み中の返品の行は直せる', async () => {
      const order = await createShipped(db(), 5);
      const requested = await returnOf(db(), order, 1, 'requested');

      // 比べるための先: 申し込み中の返品の行は直せる（同じ値への書き直しも、親が申し込み中なら通る）
      await db().query("update public.order_return_lines set resolution = 'refund' where id = $1", [requested.lineId]);

      for (const status of ['open', 'closed', 'cancelled', 'declined'] as ReturnFixtureStatus[]) {
        const created = await returnOf(db(), order, 1, status);
        await expectRejected(
          db(),
          "update public.order_return_lines set resolution = 'refund' where id = $1",
          [created.lineId],
          APPEND_ONLY,
        );
        await expectRejected(
          db(),
          "update public.order_return_lines set resolution = 'exchange', exchange_variant_id = $2, exchange_method = 'stock' where id = $1",
          [created.lineId, order.variantId],
          APPEND_ONLY,
        );
        await expectRejected(db(), 'delete from public.order_return_lines where id = $1', [created.lineId], APPEND_ONLY);
      }
    });

    test('トリガー: 削除だけを断る order_return_lines_no_delete と更新を守る order_return_lines_review_guard に分かれ、TRUNCATE を断る物は段 1 のまま', async () => {
      const res = await db().query(
        `select t.tgname, pg_get_triggerdef(t.oid) as def
         from pg_trigger as t
         where t.tgrelid = 'public.order_return_lines'::regclass and not t.tgisinternal`,
      );
      const defs = Object.fromEntries(res.rows.map((row) => [row.tgname as string, row.def as string]));
      expect(Object.keys(defs).sort()).toEqual([
        'order_return_lines_no_delete',
        'order_return_lines_no_truncate',
        'order_return_lines_order_check',
        'order_return_lines_review_guard',
      ]);
      expect(defs.order_return_lines_no_delete).toBe(
        'CREATE TRIGGER order_return_lines_no_delete BEFORE DELETE ON public.order_return_lines FOR EACH ROW EXECUTE FUNCTION private.reject_order_return_record_change()',
      );
      expect(defs.order_return_lines_review_guard).toBe(
        'CREATE TRIGGER order_return_lines_review_guard BEFORE UPDATE ON public.order_return_lines FOR EACH ROW EXECUTE FUNCTION private.guard_order_return_line_change()',
      );
    });
  });

  describe('注文のメールの予定（新しい 6 つの種類）', () => {
    async function createOrderWithTwoReturns() {
      const order = await createShipped(db(), 5);
      const first = await returnOf(db(), order, 1, 'requested');
      const second = await returnOf(db(), order, 1, 'requested');
      return { order, first, second };
    }

    test('返品の 3 つの種類（申し込み・お断り・店への知らせ）は返品の番号だけを持ち、書き分けを持たない', async () => {
      const { order, first } = await createOrderWithTwoReturns();
      for (const kind of RETURN_KINDS) await insertEmailRow(db(), order.orderId, kind, { returnId: first.returnId });

      const saved = await db().query(
        `select kind, variant, return_id, return_receipt_id, cancel_request_id
         from private.order_email_outbox
         where order_id = $1
         order by seq`,
        [order.orderId],
      );
      expect(saved.rows).toEqual(
        RETURN_KINDS.map((kind) => ({ kind, variant: null, return_id: first.returnId, return_receipt_id: null, cancel_request_id: null })),
      );
    });

    test('キャンセルの申し込みの 3 つの種類は申し込みの番号だけを持ち、書き分けを持たない', async () => {
      const order = await createShipped(db(), 2);
      const request = await insertCancelRequest(db(), {
        orderId: order.orderId,
        lines: [{ orderItemId: order.orderItemId, quantity: 1 }],
      });
      for (const kind of CANCEL_KINDS) await insertEmailRow(db(), order.orderId, kind, { cancelRequestId: request.cancelRequestId });

      const saved = await db().query(
        `select kind, variant, return_id, return_receipt_id, cancel_request_id
         from private.order_email_outbox
         where order_id = $1
         order by seq`,
        [order.orderId],
      );
      expect(saved.rows).toEqual(
        CANCEL_KINDS.map((kind) => ({
          kind, variant: null, return_id: null, return_receipt_id: null, cancel_request_id: request.cancelRequestId,
        })),
      );
    });

    test('番号の組が違う行・書き分けのある行・知らない種類は断る（返品の番号・受け取りの番号・申し込みの番号・書き分けの CHECK）', async () => {
      const { order, first } = await createOrderWithTwoReturns();
      const receipt = await insertReturnReceipt(db(), { returnId: first.returnId, lines: [] });
      const request = await insertCancelRequest(db(), {
        orderId: order.orderId,
        lines: [{ orderItemId: order.orderItemId, quantity: 1 }],
      });
      const refund = await insertRefundRecord(db(), { orderId: order.orderId });
      const returnId = first.returnId;
      const receiptId = receipt.receiptId;
      const cancelRequestId = request.cancelRequestId;

      const refused: Array<[string, Parameters<typeof insertEmailRow>[3], string]> = [
        // 返品の 3 つは返品の番号が要り、受け取りの番号は持たない
        ['return_requested', {}, 'order_email_outbox_return_check'],
        ['return_declined', { returnId, receiptId }, 'order_email_outbox_return_check'],
        ['return_request_shop', { receiptId }, 'order_email_outbox_return_check'],
        // 返品のお知らせは書き分けを持たない（番号の組は正しくして、書き分けの CHECK だけに当てる）
        ['return_requested', { returnId, variant: 'standard' }, 'order_email_outbox_variant_check'],
        // キャンセルの申し込みの 3 つは申し込みの番号が要り、返品の番号は持たない
        ['cancel_request_received', {}, 'order_email_outbox_cancel_request_check'],
        ['cancel_request_declined', { cancelRequestId, returnId }, 'order_email_outbox_return_check'],
        ['cancel_request_shop', { cancelRequestId, variant: 'standard' }, 'order_email_outbox_variant_check'],
        // 申し込みの番号は、キャンセルの申し込みの 3 つ以外は持てない
        ['return_declined', { returnId, cancelRequestId }, 'order_email_outbox_cancel_request_check'],
        ['paid', { variant: 'order_confirmed', cancelRequestId }, 'order_email_outbox_cancel_request_check'],
        ['refund', { variant: 'standard', refundId: refund.refundId, cancelRequestId }, 'order_email_outbox_cancel_request_check'],
        // 知らない種類
        ['cancel_request_unknown', {}, 'order_email_outbox_kind_check'],
      ];
      for (const [kind, extra, constraint] of refused) {
        await db().query('savepoint check_case');
        await expect(insertEmailRow(db(), order.orderId, kind, extra)).rejects.toMatchObject({ code: '23514', constraint });
        await db().query('rollback to savepoint check_case');
      }
    });

    test('返品の 4 つの種類は、返品ごと・種類ごとに自動の行を 1 行だけ書ける。同じ注文の別の返品なら、同じ種類をもう 1 行書ける', async () => {
      const { order, first, second } = await createOrderWithTwoReturns();
      const orderId = order.orderId;

      for (const kind of ['return_accepted', ...RETURN_KINDS]) {
        await insertEmailRow(db(), orderId, kind, { returnId: first.returnId });
        // 同じ返品の同じ種類の 2 行目は、一意の索引が断る
        await expectRejected(
          db(),
          "insert into private.order_email_outbox (order_id, kind, origin, return_id) values ($1, $2, 'auto', $3)",
          [orderId, kind, first.returnId],
          { code: '23505', constraint: 'order_email_outbox_auto_return_idx' },
        );
        // ON CONFLICT DO NOTHING なら、何も書かない
        const again = await db().query(
          "insert into private.order_email_outbox (order_id, kind, origin, return_id) values ($1, $2, 'auto', $3) on conflict do nothing",
          [orderId, kind, first.returnId],
        );
        expect(again.rowCount).toBe(0);
        // 同じ注文の別の返品なら、同じ種類を書ける
        await insertEmailRow(db(), orderId, kind, { returnId: second.returnId });
      }

      const count = await db().query('select count(*)::int as n from private.order_email_outbox where order_id = $1', [orderId]);
      expect(count.rows[0].n).toBe(8);
    });

    test('キャンセルの申し込みの 3 つの種類は、申し込みごと・種類ごとに自動の行を 1 行だけ書ける。同じ注文の別の申し込みなら、同じ種類をもう 1 行書ける', async () => {
      const order = await createShipped(db(), 2);
      const lines = [{ orderItemId: order.orderItemId, quantity: 1 }];
      const first = await insertCancelRequest(db(), { orderId: order.orderId, lines, status: 'declined' });
      const second = await insertCancelRequest(db(), { orderId: order.orderId, lines });

      for (const kind of CANCEL_KINDS) {
        await insertEmailRow(db(), order.orderId, kind, { cancelRequestId: first.cancelRequestId });
        await expectRejected(
          db(),
          "insert into private.order_email_outbox (order_id, kind, origin, cancel_request_id) values ($1, $2, 'auto', $3)",
          [order.orderId, kind, first.cancelRequestId],
          { code: '23505', constraint: 'order_email_outbox_auto_cancel_request_idx' },
        );
        const again = await db().query(
          "insert into private.order_email_outbox (order_id, kind, origin, cancel_request_id) values ($1, $2, 'auto', $3) on conflict do nothing",
          [order.orderId, kind, first.cancelRequestId],
        );
        expect(again.rowCount).toBe(0);
        await insertEmailRow(db(), order.orderId, kind, { cancelRequestId: second.cancelRequestId });
      }

      const count = await db().query('select count(*)::int as n from private.order_email_outbox where order_id = $1', [order.orderId]);
      expect(count.rows[0].n).toBe(6);
    });

    test('索引の形: 1 注文 1 種類 1 行の索引は新しい 6 つの種類も数えず、返品ごとの索引は種類ごと、申し込みごとの索引は新しい', async () => {
      const res = await db().query(
        `select indexname, indexdef
         from pg_indexes
         where schemaname = 'private' and tablename = 'order_email_outbox'
           and indexname in ('order_email_outbox_auto_once_idx', 'order_email_outbox_auto_return_idx', 'order_email_outbox_auto_cancel_request_idx')`,
      );
      const defs = Object.fromEntries(res.rows.map((row) => [row.indexname as string, row.indexdef as string]));
      expect(Object.keys(defs).sort()).toEqual([
        'order_email_outbox_auto_cancel_request_idx',
        'order_email_outbox_auto_once_idx',
        'order_email_outbox_auto_return_idx',
      ]);

      for (const kind of [
        'return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop',
        'return_requested', 'return_declined', 'return_request_shop',
        'cancel_request_received', 'cancel_request_declined', 'cancel_request_shop',
      ]) {
        expect(defs.order_email_outbox_auto_once_idx).toContain(`'${kind}'::text`);
      }
      expect(defs.order_email_outbox_auto_once_idx).toContain('(order_id, kind)');

      expect(defs.order_email_outbox_auto_return_idx).toContain('(return_id, kind)');
      for (const kind of ['return_accepted', ...RETURN_KINDS]) {
        expect(defs.order_email_outbox_auto_return_idx).toContain(`'${kind}'::text`);
      }
      expect(defs.order_email_outbox_auto_cancel_request_idx).toContain('(cancel_request_id, kind)');
      expect(defs.order_email_outbox_auto_cancel_request_idx).toContain('cancel_request_id IS NOT NULL');
    });

    test('予定を書く関数 private.enqueue_order_email は段 1 と同じに動く（発送ごと・返金ごと・注文ごとに 1 行、返品の返金は番号を写す）。新しい種類はこの関数では書けない', async () => {
      const fx = await createShippedOrderFixture(db(), {
        lines: [{ quantity: 2 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }] }, { lines: [{ lineIndex: 0, quantity: 1 }] }],
      });
      const orderId = fx.orderId;
      const enqueue = async (kind: string, variant: string | null, fulfillmentId: string | null = null, refundId: string | null = null) =>
        (
          await db().query('select private.enqueue_order_email($1::uuid, $2::text, $3::text, $4::uuid, $5::uuid) as inserted', [
            orderId, kind, variant, fulfillmentId, refundId,
          ])
        ).rows[0].inserted as boolean;

      // 注文ごと・種類ごとに 1 行（最後の枝。ON CONFLICT の条件が作り直した索引と合っていること）
      expect(await enqueue('paid', 'order_confirmed')).toBe(true);
      expect(await enqueue('paid', 'payment_received')).toBe(false);
      expect(await enqueue('awaiting_payment', null)).toBe(true);
      expect(await enqueue('awaiting_payment', null)).toBe(false);

      // 発送ごとに 1 行
      const [firstShipment, secondShipment] = fx.fulfillments;
      expect(await enqueue('shipped', null, firstShipment.id)).toBe(true);
      expect(await enqueue('shipped', null, firstShipment.id)).toBe(false);
      expect(await enqueue('shipped', null, secondShipment.id)).toBe(true);

      // 返金ごと・種類ごとに 1 行
      const refund = await insertRefundRecord(db(), { orderId });
      const otherRefund = await insertRefundRecord(db(), { orderId, status: 'succeeded' });
      expect(await enqueue('refund', 'standard', null, refund.refundId)).toBe(true);
      expect(await enqueue('refund', 'standard', null, refund.refundId)).toBe(false);
      expect(await enqueue('refund', 'standard', null, otherRefund.refundId)).toBe(true);

      // 返品の返金のお知らせは、返金の行から返品の番号と受け取りの番号を写す
      const created = await insertReturnRecord(db(), {
        orderId,
        status: 'open',
        lines: [{ fulfillmentId: firstShipment.id, orderItemId: fx.orderItemIds[0], quantity: 1 }],
      });
      const returnRefund = await insertReturnRefund(db(), { orderId, returnId: created.returnId, lines: [] });
      const receipt = await insertReturnReceipt(db(), { returnId: created.returnId, refundId: returnRefund.refundId, lines: [] });
      expect(await enqueue('refund', 'return', null, returnRefund.refundId)).toBe(true);
      const copied = await db().query(
        'select return_id, return_receipt_id from private.order_email_outbox where refund_id = $1',
        [returnRefund.refundId],
      );
      expect(copied.rows).toEqual([{ return_id: created.returnId, return_receipt_id: receipt.receiptId }]);

      // 返品・キャンセルの申し込みのお知らせは番号を持つ移行 E の関数で書く。この関数では CHECK が断る
      // （述語が合わなければ、CHECK より先に「合う制約が無い」の 42P10 で落ちる）
      await expectRejected(
        db(),
        'select private.enqueue_order_email($1::uuid, $2::text, $3::text)',
        [orderId, 'return_requested', null],
        { code: '23514', constraint: 'order_email_outbox_return_check' },
      );
      await expectRejected(
        db(),
        'select private.enqueue_order_email($1::uuid, $2::text, $3::text)',
        [orderId, 'cancel_request_received', null],
        { code: '23514', constraint: 'order_email_outbox_cancel_request_check' },
      );
    });

    test('メールを取り出す関数 public.claim_order_email は、答えの最後の列に cancel_request_id を返す（ほかの列は段 1 のまま）', async () => {
      await db().query('delete from private.order_email_outbox');
      const withRequest = await createShipped(db(), 2);
      const request = await insertCancelRequest(db(), {
        orderId: withRequest.orderId,
        lines: [{ orderItemId: withRequest.orderItemId, quantity: 1 }],
      });
      const withReturn = await createShipped(db(), 2);
      const created = await returnOf(db(), withReturn, 1, 'requested');
      await insertEmailRow(db(), withRequest.orderId, 'cancel_request_received', { cancelRequestId: request.cancelRequestId });
      await insertEmailRow(db(), withReturn.orderId, 'return_requested', { returnId: created.returnId });

      const first = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      expect(first).toMatchObject({
        order_id: withRequest.orderId,
        kind: 'cancel_request_received',
        variant: null,
        origin: 'auto',
        attempts: 1,
        payment_expired_sent: false,
        fulfillment_id: null,
        refund_id: null,
        return_id: null,
        return_receipt_id: null,
        cancel_request_id: request.cancelRequestId,
      });
      expect(Object.keys(first)).toEqual([
        'email_id', 'order_id', 'kind', 'variant', 'origin', 'attempts', 'lease_token', 'subject', 'body_text',
        'payment_expired_sent', 'fulfillment_id', 'refund_id', 'return_id', 'return_receipt_id', 'cancel_request_id',
      ]);

      const second = (await db().query('select * from public.claim_order_email(300)')).rows[0];
      expect(second).toMatchObject({
        order_id: withReturn.orderId,
        kind: 'return_requested',
        return_id: created.returnId,
        return_receipt_id: null,
        cancel_request_id: null,
      });
    });
  });
});
