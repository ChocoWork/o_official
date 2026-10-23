/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import {
  addItemVariant, createCatalogFixture, createDraft, createShippedOrderFixture, insertCancelRequest,
  insertOrderWithLines, insertRefundRecord, insertReturnPhoto, insertReturnReceipt, insertReturnRecord,
  PRICE, uniqueSuffix,
} from './helpers/order-fixtures';
import { insertDeliveryAttention, insertDeliveryRegistration } from './helpers/delivery-tracking-fixtures';
import { createOrderStatusEmail } from './helpers/order-status-fixtures';

/**
 * G-1 Task 1: 清掃節の原子性と、本番相当の材料での結果。
 * 実行は controller の使い捨てローカル DB（G-0 の版へ seed なしで reset した直後）に限る。
 * SQL 原文（自身の BEGIN/COMMIT を含む）を専用の接続で流し、外側の BEGIN で包んで成功扱いにしない。
 *
 * 流し方（必ずこの順で、このファイルだけを単独で流す。合図 G1_CLEANUP_SUITE=1 が無ければ DB の試験は飛ばす）:
 *   npx.cmd supabase db reset --version 20261023175712 --no-seed
 *   $env:G1_CLEANUP_SUITE='1'; npx.cmd jest tests/integration/db/group_g1_cleanup.integration.test.ts --runInBand
 * 成功版は全注文・台帳を消して commit する。G-1 を当てた DB（ふつうの reset の後）では本体の CREATE が 42P07 で落ちるので、
 * ふつうの DB 結合の全件では飛ばし、合図がある時は beforeAll で G-0 までの版だけの DB かを確かめ、違えば材料を作る前に止める。
 */

type Row = Record<string, unknown>;

const G0_VERSION = '20261023175712';
const G1_VERSION = '20261023211425';

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const MIGRATION_FILES = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g1_allocation.sql'));
const MIGRATION_SQL = MIGRATION_FILES.length === 1
  ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, MIGRATION_FILES[0]), 'utf8')
  : '';

const CLEANUP_HEAD = `BEGIN;
-- G1_CLEANUP_BEGIN
SET LOCAL lock_timeout = '15s';
SELECT pg_catalog.pg_advisory_xact_lock(190521,1);
LOCK TABLE
  private.fulfillment_tracking_registrations,
  private.order_email_outbox,
  private.order_status_links,
  public.checkout_drafts,
  public.contact_inquiries,
  public.item_variants,
  public.order_cancel_request_lines,
  public.order_cancel_requests,
  public.order_fulfillment_attention,
  public.order_fulfillment_events,
  public.order_fulfillment_lines,
  public.order_fulfillment_tracking_changes,
  public.order_fulfillments,
  public.order_item_completions,
  public.order_items,
  public.order_refund_lines,
  public.order_refunds,
  public.order_return_lines,
  public.order_return_photo_uploads,
  public.order_return_photos,
  public.order_return_receipt_lines,
  public.order_return_receipts,
  public.order_returns,
  public.order_revisions,
  public.orders,
  public.payment_exceptions,
  public.stock_movements,
  public.stripe_balance_transactions,
  public.stripe_payouts,
  public.stripe_refunds,
  public.stripe_webhook_events
IN ACCESS EXCLUSIVE MODE;`;

const ORDER_IDS = 'group_g_cleanup_order_ids';
const LINKED = `order_id IN (SELECT id FROM ${ORDER_IDS})`;

/** 未完了の知らせの対象 W の唯一の条件（本番前の読取では CTE、清掃 SQL では pg_temp の表を参照する） */
function webhookCondition(orderIds: string): string {
  return `e.processing_status IN ('queued','processing','failed')
AND e.next_attempt_at IS NOT NULL
AND (
  EXISTS (
    SELECT 1 FROM ${orderIds} o
    WHERE e.raw_payload #>> '{data,object,metadata,order_id}' = o.id::text
       OR e.raw_payload #>> '{data,object,order_id}' = o.id::text
       OR (o.checkout_session_id IS NOT NULL
           AND e.raw_payload #>> '{data,object,id}' = o.checkout_session_id)
       OR (o.payment_intent_id IS NOT NULL AND (
            e.raw_payload #>> '{data,object,id}' = o.payment_intent_id
         OR e.raw_payload #>> '{data,object,payment_intent}' = o.payment_intent_id
         OR e.raw_payload #>> '{data,object,payment_intent,id}' = o.payment_intent_id
       ))
  )
  OR EXISTS (
    SELECT 1 FROM public.order_revisions r
    JOIN ${orderIds} o ON o.id=r.order_id
    WHERE r.source_event_id=e.id
  )
)`;
}

/** 清掃の 31 表と操作。件数読取と、清掃 SQL の唯一の対象一覧（WHERE は pg_temp. を外した同じ条件） */
const CLEANUP_TARGETS: Array<[table: string, action: string, where: string]> = [
  ['private.order_email_outbox', 'delete_all', 'TRUE'],
  ['private.order_status_links', 'delete_all', 'TRUE'],
  ['private.fulfillment_tracking_registrations', 'delete_all', 'TRUE'],
  ['public.order_fulfillment_attention', 'delete_all', 'TRUE'],
  ['public.order_fulfillment_events', 'delete_all', 'TRUE'],
  ['public.order_fulfillment_tracking_changes', 'delete_all', 'TRUE'],
  ['public.order_return_photos', 'delete_all', 'TRUE'],
  ['public.order_return_photo_uploads', 'delete_all', 'TRUE'],
  ['public.order_cancel_request_lines', 'delete_all', 'TRUE'],
  ['public.order_cancel_requests', 'delete_all', 'TRUE'],
  ['public.order_return_receipt_lines', 'delete_all', 'TRUE'],
  ['public.order_return_receipts', 'delete_all', 'TRUE'],
  ['public.order_refund_lines', 'delete_all', 'TRUE'],
  ['public.stock_movements', 'delete_all', 'TRUE'],
  ['public.order_refunds', 'delete_all', 'TRUE'],
  ['public.order_return_lines', 'delete_all', 'TRUE'],
  ['public.order_fulfillment_lines', 'delete_all', 'TRUE'],
  ['public.order_item_completions', 'delete_all', 'TRUE'],
  ['public.order_items', 'delete_all', 'TRUE'],
  ['public.order_fulfillments', 'delete_all', 'TRUE'],
  ['public.order_returns', 'delete_all', 'TRUE'],
  ['public.order_revisions', 'delete_all', 'TRUE'],
  ['public.payment_exceptions', 'delete_all', 'TRUE'],
  ['public.checkout_drafts', 'delete_all', 'TRUE'],
  ['public.orders', 'delete_all', 'TRUE'],
  ['public.stripe_refunds', 'delete_linked', LINKED],
  ['public.stripe_balance_transactions', 'delete_linked', LINKED],
  ['public.contact_inquiries', 'unlink', LINKED],
  ['public.item_variants', 'reset', 'stock_quantity<>0'],
  ['public.stripe_payouts', 'recompute', 'id IN (SELECT id FROM group_g_cleanup_payout_ids)'],
  ['public.stripe_webhook_events', 'terminalize_webhook', 'id IN (SELECT id FROM group_g_cleanup_webhook_ids)'],
];

const CLEANUP_TABLES = CLEANUP_TARGETS.map(([table]) => table);
const DELETE_TABLES = CLEANUP_TARGETS.filter(([, action]) => action.startsWith('delete_')).map(([table]) => table);

/** 本番の清掃前に owner へ見せる件数の読取（ID・秘密値を出さない）。temp 表を作らず、読取 CTE だけを使う */
const CLEANUP_COUNT_SQL = `WITH group_g_cleanup_order_ids AS (SELECT id,checkout_session_id,payment_intent_id FROM public.orders),
group_g_cleanup_payout_ids AS (SELECT DISTINCT payout_id AS id FROM public.stripe_balance_transactions WHERE order_id IN (SELECT id FROM group_g_cleanup_order_ids) AND payout_id IS NOT NULL),
group_g_cleanup_webhook_ids AS (SELECT e.id FROM public.stripe_webhook_events e WHERE ${webhookCondition(ORDER_IDS)})
SELECT x.table_name, x.action, x.affected_count, x.total_count, x.quantity_sum
FROM (
${[
  ...CLEANUP_TARGETS.map(([table, action, where]) => `  SELECT '${table}'::text AS table_name, '${action}'::text AS action,
    (SELECT pg_catalog.count(*) FROM ${table} WHERE ${where})::text AS affected_count,
    ${table === 'public.item_variants' ? '(SELECT pg_catalog.count(*) FROM public.item_variants)::text' : 'NULL::text'} AS total_count,
    ${table === 'public.item_variants' ? '(SELECT COALESCE(pg_catalog.sum(stock_quantity),0) FROM public.item_variants)::text' : 'NULL::text'} AS quantity_sum`),
  `  SELECT 'public.stripe_balance_transactions'::text, 'balance_without_payout'::text,
    (SELECT pg_catalog.count(*) FROM public.stripe_balance_transactions b
     WHERE b.order_id IN (SELECT id FROM group_g_cleanup_order_ids)
       AND (b.payout_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.stripe_payouts p WHERE p.id=b.payout_id)))::text,
    NULL::text, NULL::text`,
].join('\n  UNION ALL\n')}
) x
ORDER BY x.table_name COLLATE "C", x.action COLLATE "C"`;

const WEBHOOK_IDS_SQL = `WITH group_g_cleanup_order_ids AS (SELECT id,checkout_session_id,payment_intent_id FROM public.orders)
SELECT e.id FROM public.stripe_webhook_events e WHERE ${webhookCondition(ORDER_IDS)} ORDER BY e.id`;

/** 清掃で変えない対照の表（内容の md5 で丸ごと比べる） */
const PRESERVED_TABLES = [
  'public.items', 'public.item_colors', 'public.item_sizes', 'public.contact_messages', 'public.carts', 'public.cart_lines',
  'public.profiles', 'public.audit_logs', 'public.legal_archive_runs', 'public.role_permission_events', 'public.shop_settings',
  'private.resend_webhook_receipts', 'private.refund_ledger_state', 'private.order_email_send_pause',
  'private.delivery_tracking_provider_gate',
];

const WEBHOOK_COLUMNS = `id,event_type,raw_payload,processing_status,attempt_count,processed_at,received_at,next_attempt_at,
  claim_token,lease_expires_at,completed_at,last_error,dead_at,dead_notified_at`;

function omit(row: Row, keys: string[]): Row {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

function sectionBetween(sql: string, begin: string, end: string): string {
  const start = sql.indexOf(begin);
  const finish = sql.indexOf(end);
  if (start < 0 || finish < start) throw new Error(`marker missing: ${begin}`);
  return sql.slice(start + begin.length, finish);
}

function replaceBetween(sql: string, begin: string, end: string, replacement: string): string {
  const start = sql.indexOf(begin);
  const finish = sql.indexOf(end);
  if (start < 0 || finish < start) throw new Error(`marker missing: ${begin}`);
  return `${sql.slice(0, start + begin.length)}\n${replacement}\n${sql.slice(finish)}`;
}

/** 故障注入版: 本体の末尾に試験用の表を作り、最後の確かめを必ず失敗する DO に差し替える */
function injectedFailureSql(): string {
  const body = sectionBetween(MIGRATION_SQL, '-- G1_BODY_BEGIN', '-- G1_BODY_END');
  const withProbe = replaceBetween(
    MIGRATION_SQL, '-- G1_BODY_BEGIN', '-- G1_BODY_END',
    `${body.trim()}\nCREATE TABLE private.group_g1_atomicity_probe(id integer);`,
  );
  return replaceBetween(
    withProbe, '-- G1_FINAL_ASSERT_BEGIN', '-- G1_FINAL_ASSERT_END',
    "DO $g1_fail$ BEGIN RAISE EXCEPTION 'GROUP_G_TEST_INJECTED_FAILURE' USING ERRCODE='55000'; END $g1_fail$;",
  );
}

/** 原文の本体節の末尾に 1 文を足す（最後の確かめが本当に止めるかを試すための違反の注入） */
function injectedBodySql(statement: string): string {
  const body = sectionBetween(MIGRATION_SQL, '-- G1_BODY_BEGIN', '-- G1_BODY_END');
  return replaceBetween(MIGRATION_SQL, '-- G1_BODY_BEGIN', '-- G1_BODY_END', `${body.trim()}\n${statement}`);
}

/**
 * G-0 までの版だけの DB で流していることを確かめる（単独で流す合図 G1_CLEANUP_SUITE=1 がある時だけ動く）。
 */
async function assertIsolatedG0Database(db: PgClient): Promise<void> {
  const versions = await db.query(
    `select pg_catalog.count(*) filter (where version = $1)::int as g0,
            pg_catalog.count(*) filter (where version = $2)::int as g1,
            pg_catalog.count(*) filter (where version > $1)::int as later
     from supabase_migrations.schema_migrations`,
    [G0_VERSION, G1_VERSION],
  );
  const row = versions.rows[0];
  if (row.g0 !== 1 || row.g1 !== 0 || row.later !== 0) {
    throw new Error(
      `DB が G-0（${G0_VERSION}）までの版ではない（G-1 ${G1_VERSION} を当てた DB では本体が 42P07 で落ちる）。`
      + `npx.cmd supabase db reset --version ${G0_VERSION} --no-seed の直後に、このファイルだけを流すこと`,
    );
  }
}

/** SQL 全文を専用の接続で流す。失敗した時は中断した取引を戻して、SQLSTATE と記号と確かめの名前（DETAIL）だけを返す */
async function runFullSql(sql: string): Promise<{ code?: string; message?: string; detail?: string; elapsedMs: number } | null> {
  const client = await connectLocalDb();
  const started = Date.now();
  try {
    await client.query("set statement_timeout = '120s'");
    try {
      await client.query(sql);
      return null;
    } catch (error) {
      const failure = error as { code?: string; message?: string; detail?: string };
      await client.query('rollback');
      return { code: failure.code, message: failure.message, detail: failure.detail, elapsedMs: Date.now() - started };
    }
  } finally {
    await client.end();
  }
}

async function tableDigest(db: PgClient, table: string): Promise<{ count: string; digest: string }> {
  const result = await db.query(
    `select pg_catalog.count(*)::text as count,
            pg_catalog.md5(coalesce(pg_catalog.string_agg(t::text, '|' order by t::text), '')) as digest
     from ${table} t`,
  );
  return { count: result.rows[0].count as string, digest: result.rows[0].digest as string };
}

async function tableDigests(db: PgClient, tables: string[]): Promise<Record<string, { count: string; digest: string }>> {
  const digests: Record<string, { count: string; digest: string }> = {};
  for (const table of tables) digests[table] = await tableDigest(db, table);
  return digests;
}

/** 定義の写し: public・private の関数（定義の md5・ACL）、表・索引など（ACL）、制約、USER トリガー（有効の状態） */
async function catalogSnapshot(db: PgClient) {
  const functions = await db.query(
    `select p.oid::regprocedure::text as signature, pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) as definition,
            coalesce(p.proacl::text, '') as acl
     from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
     order by 1`,
  );
  const relations = await db.query(
    `select n.nspname || '.' || c.relname as name, c.relkind::text as kind, coalesce(c.relacl::text, '') as acl,
            c.relrowsecurity as rls
     from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'private')
     order by 1`,
  );
  const constraints = await db.query(
    `select c.conrelid::regclass::text as relation, c.conname as name, pg_catalog.pg_get_constraintdef(c.oid) as definition
     from pg_catalog.pg_constraint c join pg_catalog.pg_namespace n on n.oid = c.connamespace
     where n.nspname in ('public', 'private')
     order by 1, 2`,
  );
  const triggers = await db.query(
    `select t.tgrelid::regclass::text as relation, t.tgname as name, t.tgenabled::text as enabled,
            pg_catalog.md5(pg_catalog.pg_get_triggerdef(t.oid)) as definition
     from pg_catalog.pg_trigger t
     join pg_catalog.pg_class c on c.oid = t.tgrelid
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'private') and not t.tgisinternal
     order by 1, 2`,
  );
  return { functions: functions.rows, relations: relations.rows, constraints: constraints.rows, triggers: triggers.rows };
}

async function webhookRows(db: PgClient, ids: string[]): Promise<Record<string, Row>> {
  const result = await db.query(`select ${WEBHOOK_COLUMNS} from public.stripe_webhook_events where id = any($1::text[])`, [ids]);
  return Object.fromEntries(result.rows.map((row) => [row.id as string, row]));
}

async function variantRows(db: PgClient): Promise<Row[]> {
  return (await db.query(
    'select id, item_id, color_id, size_id, sku, stock_quantity, is_active, created_at, updated_at from public.item_variants order by id',
  )).rows;
}

type WebhookSpec = {
  id: string;
  type: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'dead';
  payload: unknown;
  attemptCount?: number;
  nextAttemptOffset?: string;
  claimToken?: string | null;
  lastError?: string | null;
};

async function insertWebhook(db: PgClient, spec: WebhookSpec): Promise<void> {
  await db.query(
    `insert into public.stripe_webhook_events
       (id, event_type, raw_payload, processing_status, attempt_count, processed_at, received_at, next_attempt_at,
        claim_token, lease_expires_at, completed_at, last_error, dead_at, dead_notified_at)
     values ($1, $2, $3::jsonb, $4::text, $5::integer, now() - interval '10 minutes', now() - interval '20 minutes',
             now() + $6::interval,
             $7::uuid, case when $7::uuid is null then null else now() + interval '5 minutes' end,
             case when $4::text = 'completed' then now() - interval '5 minutes' end, $8::text,
             case when $4::text = 'dead' then now() - interval '1 hour' end, null)`,
    [spec.id, spec.type, spec.payload === null ? null : JSON.stringify(spec.payload), spec.status, spec.attemptCount ?? 1,
      spec.nextAttemptOffset ?? '-1 minute', spec.claimToken ?? null, spec.lastError ?? null],
  );
}

type Fixture = {
  orderIds: string[];
  paidOrderId: string;
  shippedOrderId: string;
  w: string[];
  controls: { completed: string; dead: string; queuedUnrelated: string; failedUnrelated: string; nullPayload: string };
  processingToken: string;
  processingId: string;
  payouts: { mixed: string; other: string };
  balances: { kept: string[]; removed: string[] };
  inquiries: { linked: string; unlinked: string };
};

/** 本番相当の材料: 31 表すべてに対象の行、保持する表に対照の行を作り、commit する */
async function buildFixture(db: PgClient): Promise<Fixture> {
  const s = uniqueSuffix();
  const catalog = await createCatalogFixture(db, { stock: 10 });
  await createCatalogFixture(db, { stock: 4, isActive: false });
  await createCatalogFixture(db, { stock: 0 });

  // 未入金・入金（在庫と受注生産、仕上がり・部分返金・取消の申し込み）・期限切れ
  const pending = await insertOrderWithLines(db, {
    status: 'pending',
    lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, fulfillmentType: 'stock' }],
  });
  const paidPi = `pi_g1paid${s}`;
  const paid = await insertOrderWithLines(db, {
    status: 'paid', paidAmount: PRICE * 3, paymentIntentId: paidPi,
    lines: [
      { itemId: catalog.itemId, variantId: catalog.variantId, quantity: 2, fulfillmentType: 'stock' },
      { itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, fulfillmentType: 'backorder' },
    ],
  });
  const expired = await insertOrderWithLines(db, {
    status: 'abandoned',
    lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false }],
  });
  await db.query(
    `insert into public.order_item_completions (order_id, order_item_id, quantity, request_key)
     values ($1, $2, 1, gen_random_uuid())`,
    [paid.orderId, paid.orderItemIds[1]],
  );
  const { refundId } = await insertRefundRecord(db, {
    orderId: paid.orderId, amount: PRICE, lines: [{ orderItemId: paid.orderItemIds[0], quantity: 1, amount: PRICE }],
  });
  await db.query(
    `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id, refund_id)
     values ($1, 1, 'cancel', $2, $3, $4)`,
    [catalog.variantId, paid.orderId, paid.orderItemIds[0], refundId],
  );
  await insertCancelRequest(db, { orderId: paid.orderId, lines: [{ orderItemId: paid.orderItemIds[0], quantity: 1 }] });

  // 発送・追跡・返品・写真・受け取り・交換の品（循環する外部キー）
  const shipped = await createShippedOrderFixture(db, { lines: [{ quantity: 3 }, { quantity: 1, fulfillmentType: 'backorder' }] });
  const fulfillmentId = shipped.fulfillments[0].id;
  const exchange = await addItemVariant(db, { itemId: shipped.itemIds[0], colorName: 'NAVY', sizeLabel: 'L', stock: 2 });
  const ret = await insertReturnRecord(db, {
    orderId: shipped.orderId,
    lines: [{
      fulfillmentId, orderItemId: shipped.orderItemIds[0], quantity: 1, resolution: 'exchange', exchangeVariantId: exchange.variantId,
    }],
  });
  await insertReturnPhoto(db, { returnLineId: ret.lineIds[0], orderId: shipped.orderId });
  await insertReturnReceipt(db, { returnId: ret.returnId, lines: [{ returnLineId: ret.lineIds[0], disposition: 'restocked', quantity: 1 }] });
  const exchangeItem = await db.query(
    `insert into public.order_items
       (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type,
        line_kind, exchange_return_line_id, exchange_paid_amount)
     values ($1, $2, '交換テスト', 0, 'NAVY', 'L', 1, 0, $3, 'stock', 'exchange', $4, $5)
     returning id`,
    [shipped.orderId, shipped.itemIds[0], exchange.variantId, ret.lineIds[0], PRICE],
  );
  await db.query(
    `insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id, return_id)
     values ($1, -1, 'exchange', $2, $3, $4), ($5, 1, 'return', $2, $6, $4)`,
    [exchange.variantId, shipped.orderId, exchangeItem.rows[0].id, ret.returnId, shipped.variantIds[0], shipped.orderItemIds[0]],
  );
  await insertDeliveryRegistration(db, fulfillmentId, { state: 'registered', everRegistered: true });
  await insertDeliveryAttention(db, fulfillmentId);
  await db.query(
    `insert into public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source)
     values ($1, 1, 'confirmed', now(), 'shipment')`,
    [fulfillmentId],
  );
  // 伝票訂正のメール（発送 2・訂正の記録も作る）と、入金のメール
  await createOrderStatusEmail(db, shipped.orderId, 'shipping_update');
  await createOrderStatusEmail(db, paid.orderId, 'paid');
  for (const orderId of [paid.orderId, shipped.orderId]) {
    await db.query('insert into private.order_status_links (order_id, token) values ($1, $2)', [
      orderId, randomBytes(32).toString('base64url'),
    ]);
  }

  // 下書きと要対応（注文の無い要対応も含む）
  const draft = await createDraft(db, { itemId: catalog.itemId });
  await db.query(
    `insert into public.payment_exceptions (payment_ref, payment_intent_id, order_id, reason)
     values ($1, $2, $3, 'state_conflict')`,
    [`ref_g1paid${s}`, paidPi, paid.orderId],
  );
  await db.query(
    `insert into public.payment_exceptions (payment_ref, checkout_session_id, draft_id, order_id, reason)
     values ($1, $2, $3, null, 'order_not_creatable')`,
    [`ref_g1draft${s}`, draft.checkoutSessionId, draft.draftId],
  );

  // Stripe の写し: payout P1 は注文の内と外の balance が混ざる。P2 は注文の外だけ
  const payouts = { mixed: `po_g1mixed${s}`, other: `po_g1other${s}` };
  const balance = {
    b1: `txn_g1b1${s}`, b2: `txn_g1b2${s}`, b3: `txn_g1b3${s}`, b4: `txn_g1b4${s}`, b5: `txn_g1b5${s}`, b6: `txn_g1b6${s}`,
  };
  await db.query(
    `insert into public.stripe_payouts
       (id, amount, currency, status, automatic, arrival_date, stripe_created_at, paid_at, reconciliation_status, reconciled_net, raw_payload)
     values ($1, 9660, 'jpy', 'paid', true, current_date, now(), now(), 'matched', 9660, '{"object":"payout"}'::jsonb),
            ($2, 300, 'jpy', 'paid', true, current_date, now(), now(), 'matched', 300, '{"object":"payout"}'::jsonb)`,
    [payouts.mixed, payouts.other],
  );
  const insertBalance = (id: string, orderId: string | null, payoutId: string | null, type: string, amount: number, fee: number) =>
    db.query(
      `insert into public.stripe_balance_transactions
         (id, source_id, payment_intent_id, order_id, payout_id, type, reporting_category, amount, fee, net, currency, status,
          available_on, stripe_created_at, raw_payload)
       values ($1, $2, $3, $4::uuid, $5, $6::text, $6::text, $7::integer, $8::integer, $7::integer - $8::integer, 'jpy', 'available',
               now(), now(), '{"object":"balance_transaction"}'::jsonb)`,
      [id, `src_${id}`, orderId ? paidPi : null, orderId, payoutId, type, amount, fee],
    );
  await insertBalance(balance.b1, paid.orderId, payouts.mixed, 'charge', 15000, 540);
  await insertBalance(balance.b2, null, payouts.mixed, 'adjustment', 200, 0);
  await insertBalance(balance.b3, shipped.orderId, null, 'charge', 5000, 180);
  await insertBalance(balance.b4, paid.orderId, `po_g1missing${s}`, 'charge', 100, 0);
  await insertBalance(balance.b5, null, payouts.other, 'adjustment', 300, 0);
  await insertBalance(balance.b6, paid.orderId, payouts.mixed, 'refund', -5000, 0);
  await db.query(
    `insert into public.stripe_refunds
       (id, payment_intent_id, order_id, amount, currency, status, balance_transaction_id, stripe_created_at, succeeded_at, raw_payload)
     values ($1, $2, $3, 5000, 'jpy', 'succeeded', $4, now(), now(), '{"object":"refund"}'::jsonb)`,
    [`re_g1${s}`, paidPi, paid.orderId, balance.b6],
  );

  // 問い合わせ: 注文に結び付く物と結び付かない物。どちらも子のメッセージを持つ
  const inquiries = { linked: '', unlinked: '' };
  for (const key of ['linked', 'unlinked'] as const) {
    const inquiry = await db.query(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message, order_id)
       values ('試験', 'g1-contact@example.com', 'order', '件名', '本文', $1) returning id`,
      [key === 'linked' ? paid.orderId : null],
    );
    inquiries[key] = inquiry.rows[0].id as string;
    await db.query(
      "insert into public.contact_messages (inquiry_id, sender_role, body) values ($1, 'user', '子のメッセージ')",
      [inquiries[key]],
    );
  }

  // Resend の受付済みの番号（全件そのまま残す対照）
  await db.query('insert into private.resend_webhook_receipts (svix_id) values ($1)', [`msg_g1${s}`]);

  // Stripe の知らせ: W（O 直結・PaymentIntent の文字列と展開・Checkout Session・revision だけ）と対照
  const paidSession = (await db.query('select checkout_session_id from public.orders where id = $1', [paid.orderId])).rows[0]
    .checkout_session_id as string;
  const id = (name: string) => `evt_g1${name}${s}`;
  const processingToken = randomUUID();
  const wSpecs: WebhookSpec[] = [
    { id: id('meta'), type: 'checkout.session.completed', status: 'queued',
      payload: { data: { object: { id: `cs_other${s}`, metadata: { order_id: pending.orderId } } } } },
    { id: id('orderid'), type: 'charge.updated', status: 'failed', attemptCount: 2, nextAttemptOffset: '1 hour', lastError: 'boom',
      payload: { data: { object: { id: `obj_${s}`, order_id: expired.orderId } } } },
    { id: id('session'), type: 'checkout.session.completed', status: 'queued', nextAttemptOffset: '2 hours',
      payload: { data: { object: { id: paidSession } } } },
    { id: id('piid'), type: 'payment_intent.succeeded', status: 'processing', claimToken: processingToken,
      payload: { data: { object: { id: paidPi } } } },
    { id: id('pistring'), type: 'charge.refunded', status: 'failed', attemptCount: 3, lastError: 'boom',
      payload: { data: { object: { id: `ch_a${s}`, payment_intent: paidPi } } } },
    { id: id('piexpanded'), type: 'charge.refunded', status: 'queued',
      payload: { data: { object: { id: `ch_b${s}`, payment_intent: { id: paidPi } } } } },
    { id: id('revision'), type: 'charge.dispute.created', status: 'failed', attemptCount: 4, lastError: 'boom',
      payload: { data: { object: { id: `dp_${s}` } } } },
  ];
  const controls = {
    completed: id('ctlcompleted'), dead: id('ctldead'), queuedUnrelated: id('ctlqueued'),
    failedUnrelated: id('ctlfailed'), nullPayload: id('ctlnull'),
  };
  const controlSpecs: WebhookSpec[] = [
    { id: controls.completed, type: 'checkout.session.completed', status: 'completed',
      payload: { data: { object: { id: `cs_done${s}`, metadata: { order_id: pending.orderId } } } } },
    { id: controls.dead, type: 'payment_intent.succeeded', status: 'dead', attemptCount: 9, lastError: 'boom',
      payload: { data: { object: { id: paidPi } } } },
    { id: controls.queuedUnrelated, type: 'checkout.session.completed', status: 'queued',
      payload: { data: { object: { id: `cs_unrelated${s}`, metadata: { order_id: randomUUID() } } } } },
    { id: controls.failedUnrelated, type: 'charge.refunded', status: 'failed', attemptCount: 2, lastError: 'boom',
      payload: { data: { object: { id: `ch_c${s}`, payment_intent: `pi_unrelated${s}` } } } },
    { id: controls.nullPayload, type: 'charge.refunded', status: 'queued', payload: null },
  ];
  for (const spec of [...wSpecs, ...controlSpecs]) await insertWebhook(db, spec);

  // revision: 1 つは W の知らせを原因に持つ（payload では結び付かない）
  await db.query(
    `insert into public.order_revisions (order_id, operation, before_data, after_data, changed_fields, reason, source_event_id)
     values ($1, 'status_update', '{}'::jsonb, '{}'::jsonb, array['status'], 'fixture', $2),
            ($3, 'operational_update', '{}'::jsonb, '{}'::jsonb, array['review_reason'], 'fixture', null)`,
    [paid.orderId, id('revision'), pending.orderId],
  );

  return {
    orderIds: [pending.orderId, paid.orderId, expired.orderId, shipped.orderId],
    paidOrderId: paid.orderId,
    shippedOrderId: shipped.orderId,
    w: wSpecs.map((spec) => spec.id).sort(),
    controls,
    processingToken,
    processingId: id('piid'),
    payouts,
    balances: { kept: [balance.b2, balance.b5], removed: [balance.b1, balance.b3, balance.b4, balance.b6] },
    inquiries,
  };
}

describe('G-1 の移行の形（DB なしで読む）', () => {
  test('移行は 1 本で、先頭の取引・印・最後の COMMIT が決まった並び', () => {
    expect(MIGRATION_FILES).toHaveLength(1);
    expect(MIGRATION_SQL).toContain(CLEANUP_HEAD);
    const markers = [
      '-- G1_CLEANUP_BEGIN', '-- G1_CLEANUP_END', '-- G1_BODY_BEGIN', '-- G1_BODY_END',
      '-- G1_FINAL_ASSERT_BEGIN', '-- G1_FINAL_ASSERT_END',
    ];
    const positions = markers.map((marker) => MIGRATION_SQL.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const marker of markers) expect(MIGRATION_SQL.split(marker)).toHaveLength(2);
    expect(MIGRATION_SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION_SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIGRATION_SQL.indexOf('BEGIN;\n-- G1_CLEANUP_BEGIN')).toBeLessThan(positions[0]);
    expect(MIGRATION_SQL.trimEnd().endsWith("-- G1_FINAL_ASSERT_END\n\nNOTIFY pgrst, 'reload schema';\nCOMMIT;")).toBe(true);
  });

  test('全角の空白・NBSP・BOM・CR を含まない', () => {
    expect(MIGRATION_SQL).not.toMatch(/[　 ﻿\r]/);
  });

  test('private の USAGE を触らず、清掃は TRUNCATE・複製の役割・RLS の変更・IF EXISTS を使わない', () => {
    expect(MIGRATION_SQL).not.toMatch(/USAGE\s+ON\s+SCHEMA\s+private/i);
    const cleanup = sectionBetween(MIGRATION_SQL, '-- G1_CLEANUP_BEGIN', '-- G1_CLEANUP_END');
    expect(cleanup).not.toMatch(/\bTRUNCATE\b/i);
    expect(cleanup).not.toMatch(/session_replication_role/i);
    expect(cleanup).not.toMatch(/ROW\s+LEVEL\s+SECURITY/i);
    expect(cleanup).not.toMatch(/\b(TABLE|CONSTRAINT|TRIGGER|FUNCTION)\s+IF\s+(NOT\s+)?EXISTS\b/i);
    expect(cleanup).not.toMatch(/\bCASCADE\b/i);
  });

  test('清掃は 31 表の決まった操作だけで、USER トリガーは削除する 27 表だけを止めて戻す', () => {
    const cleanup = sectionBetween(MIGRATION_SQL, '-- G1_CLEANUP_BEGIN', '-- G1_CLEANUP_END');
    const deleted = [...cleanup.matchAll(/^DELETE FROM (\S+)/gm)].map((match) => match[1]);
    expect([...deleted].sort()).toEqual([...DELETE_TABLES].sort());
    for (const [table, action, where] of CLEANUP_TARGETS.filter(([, a]) => a === 'delete_all')) {
      expect(cleanup).toContain(`DELETE FROM ${table} WHERE ${where};`);
      expect(action).toBe('delete_all');
    }
    for (const table of ['public.stripe_refunds', 'public.stripe_balance_transactions']) {
      expect(stripWhitespace(cleanup)).toContain(
        stripWhitespace(`DELETE FROM ${table} WHERE order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids);`),
      );
    }
    const updated = [...cleanup.matchAll(/^UPDATE (\S+)/gm)].map((match) => match[1]).sort();
    expect(updated).toEqual([
      'public.contact_inquiries', 'public.item_variants', 'public.stripe_payouts', 'public.stripe_webhook_events',
    ]);
    const disabled = [...cleanup.matchAll(/^ALTER TABLE (\S+) DISABLE TRIGGER USER;$/gm)].map((match) => match[1]).sort();
    const enabled = [...cleanup.matchAll(/^ALTER TABLE (\S+) ENABLE TRIGGER USER;$/gm)].map((match) => match[1]).sort();
    expect(disabled).toEqual([...DELETE_TABLES].sort());
    expect(enabled).toEqual([...DELETE_TABLES].sort());
    expect(cleanup.lastIndexOf('DISABLE TRIGGER USER')).toBeLessThan(cleanup.indexOf('ENABLE TRIGGER USER'));
    expect(cleanup.lastIndexOf('DELETE FROM')).toBeLessThan(cleanup.indexOf('ENABLE TRIGGER USER'));
    // W は件数読取と同じ条件（pg_temp. の修飾だけが違う）で、最初のデータの変更は W の UPDATE
    expect(stripWhitespace(cleanup)).toContain(stripWhitespace(webhookCondition('pg_temp.group_g_cleanup_order_ids')));
    expect(cleanup.indexOf('UPDATE public.stripe_webhook_events')).toBeLessThan(cleanup.indexOf('DELETE FROM'));
    expect(cleanup.indexOf('UPDATE public.stripe_webhook_events')).toBeLessThan(cleanup.indexOf('DISABLE TRIGGER USER'));
  });
});

const describeCleanupDb: typeof describeLocalDb = process.env.G1_CLEANUP_SUITE === '1'
  ? describeLocalDb
  : (name) => describe(name, () => {
    test.skip('G1_CLEANUP_SUITE=1 で単独に流す時だけ動かす（全注文を消して commit するため）', () => {});
  });

describeCleanupDb('integration: G-1 の清掃節（本番相当の材料・全文の実行・故障注入）', (db) => {
  jest.setTimeout(180_000);

  let fixture: Fixture;
  let before: {
    cleanup: Record<string, { count: string; digest: string }>;
    preserved: Record<string, { count: string; digest: string }>;
    catalog: Awaited<ReturnType<typeof catalogSnapshot>>;
    counts: Row[];
    webhooks: Record<string, Row>;
    webhookTotal: string;
    variants: Row[];
    payouts: Record<string, Row>;
    balances: Record<string, Row>;
    inquiries: Record<string, Row>;
  };

  async function readBalances(ids: string[]): Promise<Record<string, Row>> {
    const result = await db().query('select * from public.stripe_balance_transactions where id = any($1::text[])', [ids]);
    return Object.fromEntries(result.rows.map((row) => [row.id as string, row]));
  }

  async function readPayouts(ids: string[]): Promise<Record<string, Row>> {
    const result = await db().query('select * from public.stripe_payouts where id = any($1::text[])', [ids]);
    return Object.fromEntries(result.rows.map((row) => [row.id as string, row]));
  }

  async function readInquiries(ids: string[]): Promise<Record<string, Row>> {
    const result = await db().query('select * from public.contact_inquiries where id = any($1::uuid[])', [ids]);
    return Object.fromEntries(result.rows.map((row) => [row.id as string, row]));
  }

  async function expectUnchangedSinceFixture(): Promise<void> {
    expect(await tableDigests(db(), CLEANUP_TABLES)).toEqual(before.cleanup);
    expect(await tableDigests(db(), PRESERVED_TABLES)).toEqual(before.preserved);
    expect(await catalogSnapshot(db())).toEqual(before.catalog);
    expect((await db().query(CLEANUP_COUNT_SQL)).rows).toEqual(before.counts);
    expect(await variantRows(db())).toEqual(before.variants);
    expect((await db().query("select to_regclass('private.group_g1_atomicity_probe') as probe")).rows[0].probe).toBeNull();
  }

  beforeAll(async () => {
    await assertIsolatedG0Database(db());
    fixture = await buildFixture(db());
    const allWebhookIds = [...fixture.w, ...Object.values(fixture.controls)];
    before = {
      cleanup: await tableDigests(db(), CLEANUP_TABLES),
      preserved: await tableDigests(db(), PRESERVED_TABLES),
      catalog: await catalogSnapshot(db()),
      counts: (await db().query(CLEANUP_COUNT_SQL)).rows,
      webhooks: await webhookRows(db(), allWebhookIds),
      webhookTotal: (await db().query('select count(*)::text as total from public.stripe_webhook_events')).rows[0].total as string,
      variants: await variantRows(db()),
      payouts: await readPayouts(Object.values(fixture.payouts)),
      balances: await readBalances([...fixture.balances.kept, ...fixture.balances.removed]),
      inquiries: await readInquiries(Object.values(fixture.inquiries)),
    };
  });

  test('清掃前の件数読取: 31 表すべてに対象があり、5 列・table_name 順で ID を出さない', async () => {
    const rows = before.counts;
    const expectedKeys = [
      ...CLEANUP_TARGETS.map(([table, action]) => `${table}|${action}`),
      'public.stripe_balance_transactions|balance_without_payout',
    ].sort();
    expect(rows.map((row) => `${row.table_name}|${row.action}`)).toEqual(expectedKeys);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(['table_name', 'action', 'affected_count', 'total_count', 'quantity_sum']);
      expect(row.affected_count).toMatch(/^[0-9]+$/);
      expect(Number(row.affected_count)).toBeGreaterThanOrEqual(1);
      if (row.table_name === 'public.item_variants') {
        expect(row.total_count).toMatch(/^[0-9]+$/);
        expect(row.quantity_sum).toMatch(/^[0-9]+$/);
      } else {
        expect(row.total_count).toBeNull();
        expect(row.quantity_sum).toBeNull();
      }
    }
    const variantTotals = (await db().query(
      'select count(*)::text as total, coalesce(sum(stock_quantity), 0)::text as quantity from public.item_variants',
    )).rows[0];
    const variantRow = rows.find((row) => row.table_name === 'public.item_variants');
    expect(variantRow).toMatchObject({ total_count: variantTotals.total, quantity_sum: variantTotals.quantity });
    // 止めている商品の在庫も対象に入る
    expect(Number((await db().query(
      'select count(*) as n from public.item_variants where not is_active and stock_quantity <> 0',
    )).rows[0].n)).toBeGreaterThanOrEqual(1);

    // W は O 直結・PaymentIntent の文字列と展開・Checkout Session・revision の 7 件を全部含み、対照を含まない
    const w = (await db().query(WEBHOOK_IDS_SQL)).rows.map((row) => row.id as string);
    expect(w).toEqual(expect.arrayContaining(fixture.w));
    for (const control of Object.values(fixture.controls)) expect(w).not.toContain(control);

    // 影響する payout は実在する P1 だけ。P2（注文の外だけ）は入らない。payout に結び付かない balance は 2 行
    const payoutIds = (await db().query(
      `select distinct payout_id as id from public.stripe_balance_transactions
       where order_id in (select id from public.orders) and payout_id is not null`,
    )).rows.map((row) => row.id as string);
    expect(payoutIds).toContain(fixture.payouts.mixed);
    expect(payoutIds).not.toContain(fixture.payouts.other);
    expect(Number(rows.find((row) => row.action === 'balance_without_payout')?.affected_count)).toBeGreaterThanOrEqual(2);
  });

  test('故障注入: 最後の確かめで止めると、清掃も本体の新しい表も全部戻る', async () => {
    const failure = await runFullSql(injectedFailureSql());
    expect(failure).toMatchObject({ code: '55000', message: 'GROUP_G_TEST_INJECTED_FAILURE' });

    await expectUnchangedSinceFixture();
    expect(await webhookRows(db(), Object.keys(before.webhooks))).toEqual(before.webhooks);
  });

  test.each([
    {
      name: '在庫が 0 でない variant',
      statement: 'UPDATE public.item_variants SET stock_quantity = 1 WHERE id = (SELECT pg_catalog.min(id) FROM public.item_variants);',
      detail: 'item_variants_stock',
    },
    {
      name: 'queued に戻した W',
      statement: `UPDATE public.stripe_webhook_events SET processing_status = 'queued'
WHERE id = (SELECT pg_catalog.min(id) FROM pg_temp.group_g_cleanup_webhook_ids);`,
      detail: 'webhook_terminalized',
    },
  ])('最後の確かめは本体節で入れた違反（$name）を $detail で止め、全部戻す', async ({ statement, detail }) => {
    const failure = await runFullSql(injectedBodySql(statement));
    expect(failure).toMatchObject({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail });

    await expectUnchangedSinceFixture();
    expect(await webhookRows(db(), Object.keys(before.webhooks))).toEqual(before.webhooks);
  });

  test('別の接続が清掃する表の行を握っていると、15 秒で 55P03 になり何も変わらない', async () => {
    const blocker = await connectLocalDb();
    try {
      await blocker.query('begin');
      await blocker.query('select id from public.orders where id = $1 for update', [fixture.paidOrderId]);
      const failure = await runFullSql(MIGRATION_SQL);
      expect(failure?.code).toBe('55P03');
      expect(failure?.elapsedMs).toBeGreaterThanOrEqual(14_000);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      await blocker.end();
    }

    await expectUnchangedSinceFixture();
    expect(await webhookRows(db(), Object.keys(before.webhooks))).toEqual(before.webhooks);
  });

  test('原文の成功版: 31 表を清掃し、保持する物は変えず、定義も戻す', async () => {
    const started = (await db().query('select clock_timestamp() as at')).rows[0].at as Date;
    const failure = await runFullSql(MIGRATION_SQL);
    const finished = (await db().query('select clock_timestamp() as at')).rows[0].at as Date;
    expect(failure).toBeNull();

    // 件数読取: 対象は全部 0。variant は全件数を返し、在庫の合計は 0
    const counts = (await db().query(CLEANUP_COUNT_SQL)).rows;
    for (const row of counts) expect(row.affected_count).toBe('0');
    expect(counts.find((row) => row.table_name === 'public.item_variants')).toMatchObject({
      total_count: before.counts.find((row) => row.table_name === 'public.item_variants')?.total_count,
      quantity_sum: '0',
    });
    for (const table of DELETE_TABLES.filter((name) => !name.startsWith('public.stripe_'))) {
      expect((await tableDigest(db(), table)).count).toBe('0');
    }

    // 保持する表・問い合わせの子・Resend の番号などは丸ごと同じ
    expect(await tableDigests(db(), PRESERVED_TABLES)).toEqual(before.preserved);

    // 在庫は止めている商品も含め全部 0。ほかの列は変えない
    const variants = await variantRows(db());
    expect(variants).toHaveLength(before.variants.length);
    for (const [index, variant] of variants.entries()) {
      expect(variant.stock_quantity).toBe(0);
      expect(variant.updated_at).toBeInstanceOf(Date);
      expect(omit(variant, ['stock_quantity', 'updated_at'])).toEqual(omit(before.variants[index], ['stock_quantity', 'updated_at']));
    }

    // payout: P1 は残った balance（注文の外）の net だけで pending。ほかの列と P2 は変えない
    const payouts = await readPayouts(Object.values(fixture.payouts));
    const recomputed = ['reconciled_net', 'reconciliation_status'];
    expect(payouts[fixture.payouts.mixed]).toMatchObject({ reconciled_net: 200, reconciliation_status: 'pending' });
    expect(omit(payouts[fixture.payouts.mixed], recomputed)).toEqual(omit(before.payouts[fixture.payouts.mixed], recomputed));
    expect(payouts[fixture.payouts.other]).toEqual(before.payouts[fixture.payouts.other]);

    // balance: 注文の外の行は同じ、注文に結び付く行（payout 無し・実在しない payout も）は消える。返金の写しも消える
    const balances = await readBalances([...fixture.balances.kept, ...fixture.balances.removed]);
    expect(Object.keys(balances).sort()).toEqual([...fixture.balances.kept].sort());
    for (const id of fixture.balances.kept) expect(balances[id]).toEqual(before.balances[id]);
    expect((await tableDigest(db(), 'public.stripe_refunds')).count).toBe('0');

    // 問い合わせ: 本文は同じまま order_id だけ空。結び付いていない問い合わせは同じ
    const inquiries = await readInquiries(Object.values(fixture.inquiries));
    expect(inquiries[fixture.inquiries.linked]).toEqual({ ...before.inquiries[fixture.inquiries.linked], order_id: null });
    expect(inquiries[fixture.inquiries.unlinked]).toEqual(before.inquiries[fixture.inquiries.unlinked]);

    // 知らせ: 行数は同じ。W だけ dead・決まった理由・借りなし・知らせ済み（清掃の取引の中の時刻）、ほかの列は同じ
    expect((await db().query('select count(*)::text as total from public.stripe_webhook_events')).rows[0].total)
      .toBe(before.webhookTotal);
    const webhooks = await webhookRows(db(), Object.keys(before.webhooks));
    for (const id of fixture.w) {
      const row = webhooks[id];
      const previous = before.webhooks[id];
      expect(row).toMatchObject({
        processing_status: 'dead', last_error: 'group_g1_test_data_cleanup',
        claim_token: null, lease_expires_at: null, completed_at: null,
      });
      for (const column of ['dead_at', 'dead_notified_at'] as const) {
        const at = row[column] as Date;
        expect(at).toBeInstanceOf(Date);
        expect(at.getTime()).toBeGreaterThanOrEqual(started.getTime());
        expect(at.getTime()).toBeLessThanOrEqual(finished.getTime());
      }
      for (const column of ['id', 'event_type', 'raw_payload', 'attempt_count', 'received_at', 'processed_at', 'next_attempt_at']) {
        expect(row[column]).toEqual(previous[column]);
      }
    }
    for (const control of Object.values(fixture.controls)) expect(webhooks[control]).toEqual(before.webhooks[control]);

    // 定義: 新しい表・関数は作らず（本体は空）、前からあるトリガー・制約・関数・ACL はそのまま
    const catalog = await catalogSnapshot(db());
    // Task 1 の本体は空なので、新しい object は 1 つも無く、定義の集合は清掃の前と完全に同じ。
    // 本体が埋まったら、Task 14 がここを最終 SQL の完全な期待集合（新 4 表・関数など）との比較に置き換える
    expect(catalog.triggers).toEqual(before.catalog.triggers);
    expect(catalog.constraints).toEqual(before.catalog.constraints);
    expect(catalog.functions).toEqual(before.catalog.functions);
    expect(catalog.relations).toEqual(before.catalog.relations);
    const userTriggersOnCleanup = catalog.triggers.filter((trigger) => CLEANUP_TABLES.includes(trigger.relation as string)
      || CLEANUP_TABLES.includes(`public.${trigger.relation as string}`));
    for (const trigger of userTriggersOnCleanup) expect(trigger.enabled).toBe('O');
    expect((await db().query("select to_regclass('private.group_g1_atomicity_probe') as probe")).rows[0].probe).toBeNull();
  });

  test('成功の後: W は店への知らせの一覧に出ず、取り出しも古い借りの完了・失敗もできない', async () => {
    const deadTotal = Number((await db().query(
      "select count(*) as n from public.stripe_webhook_events where processing_status = 'dead'",
    )).rows[0].n);
    expect(deadTotal).toBeLessThanOrEqual(200);
    const unnotifiedW = await db().query(
      'select count(*)::int as n from public.list_unnotified_dead_stripe_webhook_events(200) n where n.event_id = any($1::text[])',
      [fixture.w],
    );
    expect(unnotifiedW.rows[0].n).toBe(0);
    const unnotifiedControl = await db().query(
      'select count(*)::int as n from public.list_unnotified_dead_stripe_webhook_events(200) n where n.event_id = $1',
      [fixture.controls.dead],
    );
    expect(unnotifiedControl.rows[0].n).toBe(1);

    await db().query('begin');
    try {
      const claimed: string[] = [];
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const row = (await db().query('select event_id from public.claim_stripe_webhook_event()')).rows[0];
        if (!row) break;
        claimed.push(row.event_id as string);
      }
      for (const id of fixture.w) expect(claimed).not.toContain(id);
      const completed = await db().query('select public.complete_stripe_webhook_event($1, $2) as ok', [
        fixture.processingId, fixture.processingToken,
      ]);
      expect(completed.rows[0].ok).toBe(false);
      const failed = await db().query('select public.fail_stripe_webhook_event($1, $2, $3) as ok', [
        fixture.processingId, fixture.processingToken, 'late_worker',
      ]);
      expect(failed.rows[0].ok).toBe(false);
    } finally {
      await db().query('rollback');
    }
  });
});
