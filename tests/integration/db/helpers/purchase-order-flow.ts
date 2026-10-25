import { randomUUID } from 'node:crypto';
import type { PgClient } from './local-db';
import { createCatalogFixture, insertOrderWithLines } from './order-fixtures';

/**
 * G-2 Task 7（FREQ-529）: 発注書の受け取りと、その取消・数量訂正の DB 試験が共通で使う道具。
 * 発注書の作成・数量の確定・受け取り・取消は、本物の公開入口（service_role 用の public.admin_*）を呼ぶ。
 * 試験は BEGIN … ROLLBACK で包み、共通の押さえ pg_advisory_xact_lock(190521,1) を取った後で使う。
 * 呼び出しのたびに遅延の確かめ（操作の受付への外部キー・納品数の整合・台帳の整合）を発火させる（flush）。
 */

export const FORBIDDEN = { code: '42501', message: 'GROUP_G_FORBIDDEN' };
export const INVALID = { code: '22023', message: 'GROUP_G_ARGUMENT_INVALID' };
export const CONFLICT = { code: '23505', message: 'GROUP_G_REQUEST_KEY_CONFLICT' };
export const NOT_FOUND = { code: 'P0002', message: 'GROUP_G_PO_NOT_FOUND' };
export const VERSION_CONFLICT = { code: '55000', message: 'GROUP_G_PO_VERSION_CONFLICT' };
export const NOT_CONFIRMED = { code: '55000', message: 'GROUP_G_PO_NOT_CONFIRMED' };
export const EXCEEDS_REMAINING = { code: '23514', message: 'GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING' };
export const RECEIVED_ON_INVALID = { code: '22023', message: 'GROUP_G_PO_RECEIVED_ON_INVALID' };
export const REASON_REQUIRED = { code: '22023', message: 'GROUP_G_PO_REASON_REQUIRED' };
export const EXCEEDS_RECEIVED = { code: '23514', message: 'GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED' };
export const STOCK_INSUFFICIENT = { code: '23514', message: 'GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT' };
export const CONFIRMATION_REQUIRED = { code: '55000', message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED' };

export type Schema = 'public' | 'private';
export type Created = { id: string; number: string; version: number; replayed: boolean };
export type LineRow = {
  id: string; line_no: number; variant_id: number; provisional_quantity: number; confirmed_quantity: number | null;
  received_quantity: number; unit_price_yen: number | null; outstanding_quantity: number | null; version: number;
};
export type ReceiveResult = { receiptId: string; version: number; allocatedQuantity: number; replayed: boolean };
export type ReverseResult = { receiptId: string; version: number; releasedQuantity: number; replayed: boolean };

export type ReceiveArgs = {
  actor?: string | null; orderId?: string | null; version?: number | null; receivedOn?: string | null; memo?: string | null;
  lines?: unknown; key?: string | null; schema?: Schema;
};
export type ReverseArgs = {
  actor?: string | null; orderId?: string | null; version?: number | null; receiptId?: string | null; lines?: unknown;
  reason?: string | null; expected?: number | null; key?: string | null; schema?: Schema;
};

export function createPurchaseFlow(db: () => PgClient) {
  async function createActor(roleCodes: readonly string[], options: { inactive?: readonly string[]; expired?: readonly string[] } = {}): Promise<string> {
    const actor = randomUUID();
    await db().query("insert into auth.users(id,raw_app_meta_data,raw_user_meta_data) values($1,'{}','{}')", [actor]);
    for (const roleCode of roleCodes) {
      await db().query(`insert into public.user_roles(user_id,role_id,active,expires_at)
        select $1::uuid,id,$3::boolean,case when $4::boolean then now() - interval '1 second' else null end
        from public.roles where code=$2::text`,
      [actor, roleCode, !(options.inactive ?? []).includes(roleCode), (options.expired ?? []).includes(roleCode)]);
    }
    return actor;
  }

  async function grant(role: string, codes: string[]) {
    await db().query(`insert into public.role_permissions(role_id,permission_id)
      select r.id,p.id from public.roles r cross join public.permissions p where r.code=$1 and p.code=any($2::text[])
      on conflict do nothing`, [role, codes]);
  }

  async function revoke(role: string, codes: string[]) {
    await db().query(`delete from public.role_permissions where role_id=(select id from public.roles where code=$1)
      and permission_id in (select id from public.permissions where code=any($2::text[]))`, [role, codes]);
  }

  /** 店長（admin）は初期のまま発注・受け取り・在庫の権限を全部持つ */
  const manager = () => createActor(['admin']);

  /** 失敗を取引ごと止めずに受け取る（savepoint）。detail は DB の DETAIL */
  async function rejected(run: () => Promise<unknown>): Promise<{ code?: string; message?: string; detail?: string }> {
    await db().query('savepoint expected_failure');
    try { await run(); return {}; } catch (e) {
      const error = e as { code: string; message: string; detail?: string };
      return error.detail === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, detail: error.detail };
    } finally {
      await db().query('rollback to savepoint expected_failure');
      await db().query('release savepoint expected_failure');
    }
  }

  /** 遅延の確かめを取引の中で発火させる */
  async function flush() {
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency, order_item_allocations_operation_id_fkey, order_item_allocation_events_operation_id_fkey, order_item_state_events_operation_id_fkey, stock_movements_allocation_operation_id_fkey, group_g_po_line_received, purchase_order_revisions_operation_id_fkey, purchase_order_receipts_operation_id_fkey, purchase_order_attachment_reservations_operation_id_fkey, purchase_order_attachments_operation_id_fkey, purchase_order_attachment_revisions_operation_id_fkey immediate');
    await db().query('set constraints all deferred');
  }

  /** 日本時間の今日（YYYY-MM-DD）。n 日ずらせる */
  async function today(offsetDays = 0): Promise<string> {
    return (await db().query("select ((now() at time zone 'Asia/Tokyo')::date + $1::integer)::text as d", [offsetDays])).rows[0].d as string;
  }

  const lineOf = (variantId: number, quantity: number) => ({ variantId, quantity });

  async function create(actor: string, lines: Array<{ variantId: number; quantity: number }>): Promise<Created> {
    const result = await db().query('select public.admin_create_purchase_order($1, $2, $3::jsonb, $4, $5) as r',
      ['工場A', null, JSON.stringify(lines), actor, randomUUID()]);
    return result.rows[0].r as Created;
  }

  async function linesOf(orderId: string): Promise<LineRow[]> {
    return (await db().query(`select id, line_no, variant_id::int as variant_id, provisional_quantity, confirmed_quantity, received_quantity,
        unit_price_yen, outstanding_quantity, version
      from public.purchase_order_lines where purchase_order_id = $1 order by line_no`, [orderId])).rows as LineRow[];
  }

  async function orderRow(orderId: string) {
    return (await db().query('select stage, version, supplier_name, memo from public.purchase_orders where id = $1', [orderId])).rows[0] as
      { stage: string; version: number; supplier_name: string; memo: string | null };
  }

  /** 数量を確定する（最初の確定）。確定後の版を返す */
  async function confirmQuantities(actor: string, orderId: string, lines: LineRow[], quantities: number[]): Promise<number> {
    const result = await db().query(
      'select public.admin_confirm_purchase_order_quantities($1::uuid, 1, $2::jsonb, null, $3::uuid, $4::uuid) as r',
      [orderId, JSON.stringify(lines.map((line, index) => ({ lineId: line.id, quantity: quantities[index], unitPriceYen: null }))), actor, randomUUID()]);
    await flush();
    return (result.rows[0].r as { version: number }).version;
  }

  async function shortClose(actor: string, orderId: string, version: number, lineIds: string[]): Promise<number> {
    const result = await db().query(
      "select public.admin_short_close_purchase_order($1::uuid, $2::integer, $3::uuid[], '打切り', $4::uuid, $5::uuid) as r",
      [orderId, version, lineIds, actor, randomUUID()]);
    await flush();
    return (result.rows[0].r as { version: number }).version;
  }

  async function receive(args: ReceiveArgs): Promise<ReceiveResult> {
    const receivedOn = args.receivedOn === undefined ? await today() : args.receivedOn;
    const result = await db().query(
      `select ${args.schema ?? 'public'}.admin_receive_purchase_order($1::uuid, $2::integer, $3::date, $4::text, $5::jsonb, $6::uuid, $7::uuid) as r`,
      [args.orderId ?? null, args.version ?? null, receivedOn, args.memo ?? null, args.lines === undefined ? null : JSON.stringify(args.lines),
        args.actor ?? null, args.key === undefined ? randomUUID() : args.key]);
    await flush();
    return result.rows[0].r as ReceiveResult;
  }

  async function reverse(args: ReverseArgs): Promise<ReverseResult> {
    const result = await db().query(
      `select ${args.schema ?? 'public'}.admin_reverse_purchase_order_receipt($1::uuid, $2::integer, $3::uuid, $4::jsonb, $5::text, $6::integer, $7::uuid, $8::uuid) as r`,
      [args.orderId ?? null, args.version ?? null, args.receiptId ?? null, args.lines === undefined ? null : JSON.stringify(args.lines),
        args.reason ?? null, args.expected ?? null, args.actor ?? null, args.key === undefined ? randomUUID() : args.key]);
    await flush();
    return result.rows[0].r as ReverseResult;
  }

  /** 受け取りの行を { lineId, quantity } にする（lines の並びと quantities の並びが対応） */
  const receiveLines = (lines: LineRow[], quantities: number[]) =>
    lines.flatMap((line, index) => (quantities[index] > 0 ? [{ lineId: line.id, quantity: quantities[index] }] : []));

  /**
   * 数量確定済みの発注書を作る（行ごとに別の商品・variant、仮数量 = 確定数量 = quantities）。
   * 在庫は既定で 0。stocks で行ごとの初めの在庫を渡せる。confirm: false なら数量確定前（stage ordered）のまま返す
   */
  async function setup(quantities: number[], options: { confirm?: boolean; stocks?: number[] } = {}) {
    const actor = await manager();
    const fixtures: Array<Awaited<ReturnType<typeof createCatalogFixture>>> = [];
    for (let index = 0; index < quantities.length; index += 1) {
      fixtures.push(await createCatalogFixture(db(), { stock: options.stocks?.[index] ?? 0 }));
    }
    const order = await create(actor, fixtures.map((fixture, index) => lineOf(fixture.variantId, quantities[index])));
    let lines = await linesOf(order.id);
    let version = order.version;
    if (options.confirm !== false) {
      version = await confirmQuantities(actor, order.id, lines, quantities);
      lines = await linesOf(order.id);
    }
    return { actor, order, lines, fixtures, version };
  }

  /** 同じ variant を待つ支払い済みの注文（在庫の割当なし。受注生産中）。注文日 createdAt が古いほど先に割り当たる */
  async function waitingOrder(fixture: { itemId: number; variantId: number }, quantity: number, createdAt: string, status = 'paid') {
    const order = await insertOrderWithLines(db(), {
      status, createdAt,
      lines: [{ itemId: fixture.itemId, variantId: fixture.variantId, quantity, fulfillmentType: 'stock', reserved: false }],
    });
    return { orderId: order.orderId, line: order.orderItemIds[0] };
  }

  /** variant の空き在庫 F・支払い済みの割当 A・仮確保 H */
  async function totals(variantId: number) {
    const row = (await db().query(`select v.stock_quantity::int as f,
      coalesce(sum(a.remaining_quantity) filter (where a.kind = 'paid'), 0)::int as a,
      coalesce(sum(a.remaining_quantity) filter (where a.kind = 'payment_hold'), 0)::int as h
      from public.item_variants v left join public.order_item_allocations a on a.variant_id = v.id
      where v.id = $1 group by v.id`, [variantId])).rows[0] as { f: number; a: number; h: number };
    return row;
  }

  /** 注文の明細ごとの割当の残り（種類を問わず合計） */
  async function allocated(orderItemId: string): Promise<number> {
    return (await db().query(`select coalesce(sum(remaining_quantity), 0)::int as n
      from public.order_item_allocations where order_item_id = $1`, [orderItemId])).rows[0].n as number;
  }

  /** 在庫・台帳・割当・履歴・受取・発注書の行数と状態（失敗や再送で動いてはならない物） */
  const snapshot = async () => (await db().query(`select
    (select count(*) from public.purchase_orders)::int as orders,
    (select count(*) from public.purchase_order_lines)::int as lines,
    (select count(*) from public.purchase_order_revisions)::int as revisions,
    (select count(*) from public.purchase_order_short_closures)::int as short_closures,
    (select count(*) from public.purchase_order_receipts)::int as receipts,
    (select count(*) from public.purchase_order_receipt_lines)::int as receipt_lines,
    (select count(*) from private.group_g_operations)::int as operations,
    (select md5(coalesce(string_agg(id::text || ':' || stage || ':' || version::text, ',' order by id), '')) from public.purchase_orders) as order_state,
    (select md5(coalesce(string_agg(id::text || ':' || coalesce(confirmed_quantity::text, '~') || ':' || received_quantity::text || ':' || version::text, ',' order by id), ''))
       from public.purchase_order_lines) as line_state,
    (select count(*) from public.stock_movements)::int as movements,
    (select count(*) from public.order_item_allocations)::int as allocations,
    (select count(*) from public.order_item_allocation_events)::int as allocation_events,
    (select count(*) from public.order_item_state_events)::int as state_events,
    (select md5(coalesce(string_agg(id::text || ':' || stock_quantity::text, ',' order by id), '')) from public.item_variants) as stock_by_variant,
    (select md5(coalesce(string_agg(id::text || ':' || remaining_quantity::text || ':' || version::text, ',' order by id), '')) from public.order_item_allocations) as allocation_state`)).rows[0];

  async function operationOf(operation: string, key: string) {
    return (await db().query(`select id, operation, cause_type, cause_id, actor_id, result, fingerprint
      from private.group_g_operations where operation = $1 and request_key = $2`, [operation, key])).rows;
  }

  async function receiptsOf(orderId: string) {
    return (await db().query(`select r.id, r.kind, r.received_on::text as received_on, r.memo, r.reason, r.actor_id, r.operation_id
      from public.purchase_order_receipts r where r.purchase_order_id = $1
      order by (select min(rl.stock_movement_id) from public.purchase_order_receipt_lines rl where rl.receipt_id = r.id)`, [orderId])).rows;
  }

  async function receiptLinesOf(receiptId: string) {
    return (await db().query(`select rl.id, rl.line_id, rl.quantity, rl.reverses_receipt_line_id, rl.stock_movement_id::text as stock_movement_id
      from public.purchase_order_receipt_lines rl join public.purchase_order_lines l on l.id = rl.line_id
      where rl.receipt_id = $1 order by l.line_no`, [receiptId])).rows;
  }

  async function movement(id: string) {
    return (await db().query(`select id::text as id, variant_id::int as variant_id, delta, reason, note, order_id, order_item_id,
        allocation_operation_id, created_by from public.stock_movements where id = $1::bigint`, [id])).rows[0];
  }

  async function stageOf(actor: string, orderId: string): Promise<string> {
    return (await db().query('select public.get_admin_purchase_order($1::uuid, $2::uuid) as r', [orderId, actor])).rows[0].r.displayStage as string;
  }

  return {
    createActor, grant, revoke, manager, rejected, flush, today, lineOf, create, linesOf, orderRow, confirmQuantities, shortClose, receive,
    reverse, receiveLines, setup, waitingOrder, totals, allocated, snapshot, operationOf, receiptsOf, receiptLinesOf, movement, stageOf,
  };
}

export type PurchaseFlow = ReturnType<typeof createPurchaseFlow>;
export type PurchaseSetup = Awaited<ReturnType<PurchaseFlow['setup']>>;
