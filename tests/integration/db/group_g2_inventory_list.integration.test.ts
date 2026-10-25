/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import {
  createCatalogFixture, createShippedOrderFixture, insertCancelRequest, insertOrderWithLines, insertRestockMovement,
  insertReturnRecord,
} from './helpers/order-fixtures';
import { seedGroupG1Allocation } from './helpers/group-g1-fixtures';

/**
 * G-2 Task 3（FREQ-525・FREQ-540-AC-07）: 在庫一覧表の読取 private.list_admin_inventory(_actor_id) と public 入口。
 * 注文数（受注生産中と発送準備中）・在庫（空き + 入金済みの割当 + 支払い前の仮確保）・発注済み（数量確定済みの未納）・
 * 発注必要数 max(0, 注文数 − 在庫 − 発注済み) を variant ごとに1つの snapshot で返す。何も書かず、variant を作らない。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包む。
 * 発注書は Task 6 の関数が無い間、直接 INSERT/UPDATE の材料で作る（遅延の確かめは取引を終えないので発火しない）。
 */
jest.setTimeout(60000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const FOUNDATION_FILE = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g2_purchasing_foundation.sql'));
const FOUNDATION_SQL = FOUNDATION_FILE.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, FOUNDATION_FILE[0]), 'utf8') : '';

const COLUMNS = [
  'variant_id', 'item_id', 'item_name', 'color_name', 'size_label', 'is_active', 'free', 'paid_allocated', 'payment_held',
  'on_hand', 'order_quantity', 'on_order', 'required',
];
const PRIVATE_SIGNATURE = 'private.list_admin_inventory(uuid)';
const PUBLIC_SIGNATURE = 'public.list_admin_inventory(uuid)';
const FORBIDDEN = { message: 'GROUP_G_FORBIDDEN', code: '42501' };

describe('G-2 foundation migration の在庫一覧の節（DB なし）', () => {
  const code = FOUNDATION_SQL.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const body = code.slice(code.indexOf('CREATE FUNCTION private.list_admin_inventory'), code.indexOf('ALTER FUNCTION private.list_admin_inventory'));

  test('FREQ-525-AC-02: 本体は STABLE の SECURITY DEFINER で、実行者の確かめを最初に置き、何も書かず、variant を作らない', () => {
    expect(FOUNDATION_FILE).toHaveLength(1);
    expect(body).toContain('LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = \'\'');
    expect(body.indexOf("private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.stock.read'])"))
      .toBeGreaterThan(0);
    expect(body.indexOf('group_g_actor_has_permissions')).toBeLessThan(body.indexOf('RETURN QUERY'));
    expect(body).toContain("RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501'");
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i);
    expect(body).not.toMatch(/backfill|pg_advisory|FOR UPDATE|FOR SHARE/i);
    expect(body).toContain("private.group_g_item_state_ranges(private.group_g_open_work_order_ids(NULL::bigint[]))");
    expect(body).toContain("s.status IN ('in_production', 'ready')");
  });

  test('FREQ-540-AC-07: private 本体と public 入口は service_role だけに EXECUTE を渡し、PUBLIC / anon / authenticated を個別に外す', () => {
    for (const signature of ['private', 'public']) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION ${signature}.list_admin_inventory(uuid) FROM PUBLIC, anon, authenticated, service_role;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION ${signature}.list_admin_inventory(uuid) TO service_role;`);
      expect(code).toContain(`ALTER FUNCTION ${signature}.list_admin_inventory(uuid) OWNER TO postgres;`);
    }
    expect(code).toContain('LANGUAGE sql STABLE SECURITY INVOKER SET search_path = \'\'');
    expect(code).not.toMatch(/ON SCHEMA\s+private/i);
  });

  test('FREQ-540-AC-07: 最後の確かめに $g2a_final_inventory_list$ を足し、他の確かめと同じ DETAIL の形で止める', () => {
    const section = FOUNDATION_SQL.slice(FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_BEGIN'), FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_END'));
    const start = section.indexOf('DO $g2a_final_inventory_list$');
    const end = section.indexOf('$g2a_final_inventory_list$;', start + 20);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = section.slice(start, end);
    expect(block).toContain("RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'inventory_list_functions'");
    expect(block).toContain(PRIVATE_SIGNATURE);
    expect(block).toContain(PUBLIC_SIGNATURE);
    // 既存の確かめ（Task 1・2）は残る
    for (const tag of ['$g2a_final_public_function_acl$', '$g2a_final_objects$', '$g2a_final_table_acl$']) {
      expect(section).toContain(`DO ${tag}`);
    }
  });
});

describeLocalDb('integration: G-2 在庫一覧表の読取', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  // ---- 共通の道具 ----

  /** 実行者を作り、役割を付ける。inactive / expired は役割の code */
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
    const result = await db().query(`insert into public.role_permissions(role_id,permission_id)
      select r.id,p.id from public.roles r cross join public.permissions p where r.code=$1 and p.code=any($2::text[])
      on conflict do nothing`, [role, codes]);
    expect(result.rowCount).toBe(codes.length);
  }

  async function revoke(role: string, codes: string[]) {
    await db().query(`delete from public.role_permissions where role_id=(select id from public.roles where code=$1)
      and permission_id in (select id from public.permissions where code=any($2::text[]))`, [role, codes]);
  }

  /** 店長（admin）は初期のまま admin.stock.read を持つ */
  const reader = () => createActor(['admin']);

  async function rejected(run: () => Promise<unknown>) {
    await db().query('savepoint expected_failure');
    try { await run(); return {}; } catch (e) {
      const error = e as { code: string; message: string };
      return { code: error.code, message: error.message };
    } finally {
      await db().query('rollback to savepoint expected_failure');
      await db().query('release savepoint expected_failure');
    }
  }

  async function inventory(actor: string, schema: 'public' | 'private' = 'public') {
    return (await db().query(`select * from ${schema}.list_admin_inventory($1)`, [actor])).rows as Array<Record<string, unknown>>;
  }

  /** 全 variant の中から、この試験が作った variant の行を取る（ローカル DB に他の商品があっても影響されない） */
  async function rowOf(actor: string, variantId: number) {
    return (await inventory(actor)).find((row) => row.variant_id === String(variantId));
  }

  const numbers = (row: Record<string, unknown> | undefined) => row && ({
    free: row.free, paid_allocated: row.paid_allocated, payment_held: row.payment_held, on_hand: row.on_hand,
    order_quantity: row.order_quantity, on_order: row.on_order, required: row.required,
  });

  async function paidOrder(itemId: number, variantId: number, quantity: number, status = 'paid') {
    return insertOrderWithLines(db(), { status, lines: [{ itemId, variantId, quantity, fulfillmentType: 'backorder', reserved: false }] });
  }

  let sequence = 2000 + Math.floor(Math.random() * 7000);
  async function purchaseOrder(): Promise<string> {
    const number = `PO-20261025-${String(sequence++ % 10000).padStart(4, '0')}`;
    return (await db().query(
      "insert into public.purchase_orders (number, supplier_name, created_by) values ($1, 'Supplier A', $2) returning id",
      [number, randomUUID()])).rows[0].id as string;
  }

  /** 発注書の明細。confirmed を省くと「数量未確定」（仮数量だけ） */
  async function purchaseLine(orderId: string, variantId: number, values: { provisional?: number; confirmed?: number | null; received?: number; lineNo?: number } = {}) {
    return (await db().query(
      `insert into public.purchase_order_lines (purchase_order_id, line_no, variant_id, item_name, provisional_quantity, confirmed_quantity, received_quantity)
       values ($1, $2, $3, 'Item', $4, $5, $6) returning id`,
      [orderId, values.lineNo ?? 1, variantId, values.provisional ?? 10, values.confirmed ?? null, values.received ?? 0])).rows[0].id as string;
  }

  /** 発注書の明細を更新する（共通の押さえを持つ接続・版 +1。納品数は受取の関数（Task 7）が入るまでの材料。確定・打切りの材料は Task 6 の関数を通す試験もある） */
  async function updateLine(lineId: string, set: string) {
    await db().query(`update public.purchase_order_lines set ${set}, version = version + 1 where id = $1`, [lineId]);
  }

  async function createItem(): Promise<number> {
    const res = await db().query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ('fx-order-' || gen_random_uuid()::text, '並びの試験', 5000, 'TOPS', 'https://example.com/item.png', 'published') returning id`);
    return Number(res.rows[0].id);
  }

  async function addColor(itemId: number, name: string, position: number): Promise<number> {
    return Number((await db().query("insert into public.item_colors (item_id, name, hex, position) values ($1, $2, '#000000', $3) returning id", [itemId, name, position])).rows[0].id);
  }

  async function addSize(itemId: number, label: string, position: number): Promise<number> {
    return Number((await db().query('insert into public.item_sizes (item_id, label, position) values ($1, $2, $3) returning id', [itemId, label, position])).rows[0].id);
  }

  async function addVariant(itemId: number, colorId: number | null, sizeId: number | null, isActive = true): Promise<number> {
    return Number((await db().query('insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, $4) returning id',
      [itemId, colorId, sizeId, isActive])).rows[0].id);
  }

  // ---- FREQ-525-AC-01: 7列と式 ----

  test('FREQ-525-AC-01: 注文数5・在庫2・発注済み1 の variant は発注必要数2（支払い済み5点のうち2点が割当済み(ready)、3点が受注生産中、確定済み発注の未納1）', async () => {
    const actor = await reader();
    const c = await createCatalogFixture(db(), { stock: 2 });
    const order = await paidOrder(c.itemId, c.variantId, 5);
    await seedGroupG1Allocation(db(), { orderItemId: order.orderItemIds[0], quantity: 2, kind: 'paid' });
    await purchaseLine(await purchaseOrder(), c.variantId, { provisional: 4, confirmed: 1 });

    const row = await rowOf(actor, c.variantId);
    expect(row).toMatchObject({
      variant_id: String(c.variantId), item_id: String(c.itemId), color_name: c.colorName, size_label: c.sizeLabel, is_active: true,
    });
    expect(numbers(row)).toEqual({ free: 0, paid_allocated: 2, payment_held: 0, on_hand: 2, order_quantity: 5, on_order: 1, required: 2 });
    expect(Object.keys(row as object)).toEqual(COLUMNS);
    // 注文数の内訳は G-1 の投影と同じ: 受注生産中 3 + 発送準備中 2
    const states = (await db().query('select status, sum(quantity)::int as quantity from public.list_admin_order_item_states($1) group by status order by status', [[order.orderId]])).rows;
    expect(states).toEqual([{ status: 'in_production', quantity: 3 }, { status: 'ready', quantity: 2 }]);
  });

  test('FREQ-525-AC-01: 在庫を超える発注済みでも発注必要数は0未満にならない', async () => {
    const actor = await reader();
    const c = await createCatalogFixture(db(), { stock: 2 });
    await paidOrder(c.itemId, c.variantId, 3);
    await purchaseLine(await purchaseOrder(), c.variantId, { provisional: 9, confirmed: 4 });

    // 注文数 3 − 在庫 2 − 発注済み 4 = −3 → 0
    expect(numbers(await rowOf(actor, c.variantId))).toEqual({ free: 2, paid_allocated: 0, payment_held: 0, on_hand: 2, order_quantity: 3, on_order: 4, required: 0 });
  });

  test('FREQ-525-AC-01: 注文も発注も無い variant は全部 0 で出る（販売中の variant は消えない）', async () => {
    const actor = await reader();
    const c = await createCatalogFixture(db(), { stock: 0 });
    expect(numbers(await rowOf(actor, c.variantId))).toEqual({ free: 0, paid_allocated: 0, payment_held: 0, on_hand: 0, order_quantity: 0, on_order: 0, required: 0 });
  });

  test('FREQ-525-AC-01: 複数の発注書の確定済み未納は variant ごとに合計する', async () => {
    const actor = await reader();
    const c = await createCatalogFixture(db(), { stock: 0 });
    await paidOrder(c.itemId, c.variantId, 10);
    await purchaseLine(await purchaseOrder(), c.variantId, { provisional: 2, confirmed: 2 });
    await purchaseLine(await purchaseOrder(), c.variantId, { provisional: 3, confirmed: 3, received: 0 });

    expect(numbers(await rowOf(actor, c.variantId))).toMatchObject({ order_quantity: 10, on_order: 5, required: 5 });
  });

  test('FREQ-525-AC-01: 戻り列は list_group_g_variant_inventory と同じ free / paid_allocated / payment_held / on_hand を返す', async () => {
    const actor = await reader();
    const c = await createCatalogFixture(db(), { stock: 7 });
    const paid = await paidOrder(c.itemId, c.variantId, 5);
    const pending = await paidOrder(c.itemId, c.variantId, 3, 'pending');
    await seedGroupG1Allocation(db(), { orderItemId: paid.orderItemIds[0], quantity: 3, kind: 'paid' });
    await seedGroupG1Allocation(db(), { orderItemId: pending.orderItemIds[0], quantity: 2, kind: 'payment_hold' });

    const g1 = (await db().query('select * from public.list_group_g_variant_inventory($1)', [[c.variantId]])).rows[0];
    const row = await rowOf(actor, c.variantId);
    expect(g1).toMatchObject({ free: 2, paid_allocated: 3, payment_held: 2, on_hand: 7 });
    expect({ free: row?.free, paid_allocated: row?.paid_allocated, payment_held: row?.payment_held, on_hand: row?.on_hand })
      .toEqual({ free: g1.free, paid_allocated: g1.paid_allocated, payment_held: g1.payment_held, on_hand: g1.on_hand });
    expect(row?.on_hand).toBe((row?.free as number) + (row?.paid_allocated as number) + (row?.payment_held as number));
    // 入金済み 5 点（割当 3 + 受注生産中 2）が注文数。仮確保の 2 点は在庫に入り、注文数には入らない
    expect(row).toMatchObject({ order_quantity: 5, on_order: 0, required: 0 });
  });

  test('FREQ-525-AC-03: 一覧の order_quantity は、先絞りをしない投影（その variant を持つ全注文の in_production + ready）と variant ごとに同じ', async () => {
    const actor = await reader();
    const a = await createCatalogFixture(db(), { stock: 6 });
    const b = await createCatalogFixture(db(), { stock: 0 });
    const order = (c: { itemId: number; variantId: number }, status: string, quantity: number, paidAmount?: number) =>
      insertOrderWithLines(db(), {
        status, lines: [{ itemId: c.itemId, variantId: c.variantId, quantity, fulfillmentType: 'backorder', reserved: false }],
        ...(paidAmount === undefined ? {} : { paidAmount }),
        ...(status === 'shipped' ? { shipped: { carrier: 'yamato' as const, trackingNumber: '123456789012' } } : {}),
      });

    // variant a: 入金済み（一部は割当済み）・未払い（仮確保）・入金の記録がある pending／failed・取消申請・発送の記録が無い発送済み・取消・放棄・支払い手続き中
    const paid = await order(a, 'paid', 4);
    await seedGroupG1Allocation(db(), { orderItemId: paid.orderItemIds[0], quantity: 1, kind: 'paid' });
    const pending = await order(a, 'pending', 2);
    await seedGroupG1Allocation(db(), { orderItemId: pending.orderItemIds[0], quantity: 2, kind: 'payment_hold' });
    await order(a, 'pending', 3, 15000);
    await order(a, 'failed', 2, 10000);
    const withRequest = await order(a, 'paid', 3);
    await insertCancelRequest(db(), { orderId: withRequest.orderId, lines: [{ orderItemId: withRequest.orderItemIds[0], quantity: 1 }] });
    await order(a, 'shipped', 2);
    await order(a, 'cancelled', 2, 10000);
    await order(a, 'abandoned', 1, 5000);
    await order(a, 'payment_in_progress', 1, 5000);
    // variant b: 入金済みと、入金の記録が無い failed・取消
    await order(b, 'paid', 5);
    await order(b, 'failed', 2);
    await order(b, 'cancelled', 1, 5000);
    // 一部だけ発送した注文（残りは割当済み）と、全部発送して返品の申請がある注文
    const partial = await createShippedOrderFixture(db(), { lines: [{ quantity: 3 }], shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }] }] });
    const returned = await createShippedOrderFixture(db(), { lines: [{ quantity: 1 }] });
    await insertReturnRecord(db(), {
      orderId: returned.orderId, status: 'requested',
      lines: [{ orderItemId: returned.orderItemIds[0], fulfillmentId: returned.fulfillments[0].id, quantity: 1 }],
    });

    /** 先絞りをしない投影: その variant を持つ全注文を投影に渡し、受注生産中と発送準備中の数を足す */
    const unfiltered = async (variantId: number) => (await db().query(
      `select coalesce(sum(s.unit_to - s.unit_from), 0)::int as quantity
       from private.group_g_item_state_ranges(array(select distinct oi2.order_id from public.order_items oi2 where oi2.variant_id = $1)) s
       join public.order_items oi on oi.id = s.order_item_id
       where s.status in ('in_production', 'ready') and oi.variant_id = $1`, [variantId])).rows[0].quantity as number;

    const rows = await inventory(actor);
    const variants = [a.variantId, b.variantId, ...partial.variantIds, ...returned.variantIds];
    for (const variantId of variants) {
      const row = rows.find((candidate) => candidate.variant_id === String(variantId));
      expect({ variantId, orderQuantity: row?.order_quantity }).toEqual({ variantId, orderQuantity: await unfiltered(variantId) });
    }
    // 比べる材料が空でないこと（全部 0 で一致したのではない）
    expect(await unfiltered(a.variantId)).toBeGreaterThanOrEqual(10);
    expect(await unfiltered(b.variantId)).toBe(5);
    expect(await unfiltered(partial.variantIds[0])).toBe(2);
    expect(await unfiltered(returned.variantIds[0])).toBe(0);
  });

  // ---- FREQ-525-AC-02: 仮確保・取消申請・返品申請・発注済み ----

  test('FREQ-525-AC-02: 未払いの仮確保は在庫(onHand)に入り注文数に入らない。未払い・取消申請中・返品申請中の数量は注文数に加えない', async () => {
    const actor = await reader();
    // 未払い（pending）の注文 3 点のうち 2 点を仮確保。注文数は 0、在庫には仮確保の 2 点が入る
    const hold = await createCatalogFixture(db(), { stock: 5 });
    const pending = await paidOrder(hold.itemId, hold.variantId, 3, 'pending');
    await seedGroupG1Allocation(db(), { orderItemId: pending.orderItemIds[0], quantity: 2, kind: 'payment_hold' });
    expect(numbers(await rowOf(actor, hold.variantId))).toEqual({ free: 3, paid_allocated: 0, payment_held: 2, on_hand: 5, order_quantity: 0, on_order: 0, required: 0 });

    // 支払い済み 4 点のうち 2 点に取消の申請: 申請中の 2 点は注文数に加えない
    const cancel = await createCatalogFixture(db(), { stock: 0 });
    const paid = await paidOrder(cancel.itemId, cancel.variantId, 4);
    await insertCancelRequest(db(), { orderId: paid.orderId, lines: [{ orderItemId: paid.orderItemIds[0], quantity: 2 }] });
    const cancelStates = (await db().query('select status, sum(quantity)::int as quantity from public.list_admin_order_item_states($1) group by status order by status', [[paid.orderId]])).rows;
    expect(cancelStates).toEqual([{ status: 'cancel_requested', quantity: 2 }, { status: 'in_production', quantity: 2 }]);
    expect(numbers(await rowOf(actor, cancel.variantId))).toEqual({ free: 0, paid_allocated: 0, payment_held: 0, on_hand: 0, order_quantity: 2, on_order: 0, required: 2 });

    // 発送済みの品に返品の申請: 返品申請中の数量は注文数に加えない
    const shipped = await createShippedOrderFixture(db(), { lines: [{ quantity: 1 }] });
    await insertReturnRecord(db(), {
      orderId: shipped.orderId, status: 'requested',
      lines: [{ orderItemId: shipped.orderItemIds[0], fulfillmentId: shipped.fulfillments[0].id, quantity: 1 }],
    });
    const returnStates = (await db().query('select status from public.list_admin_order_item_states($1)', [[shipped.orderId]])).rows.map((row) => row.status);
    expect(returnStates).toContain('return_requested');
    expect(numbers(await rowOf(actor, shipped.variantIds[0]))).toMatchObject({ order_quantity: 0, required: 0 });
  });

  test('FREQ-525-AC-02: 発注済みは数量確定済みの行の未納だけで、仮数量は数えない。打切り後は未納0で発注必要数が戻って増える', async () => {
    const actor = await reader();
    const c = await createCatalogFixture(db(), { stock: 0 });
    await paidOrder(c.itemId, c.variantId, 5);
    // 発注書・数量の確定・打切りは Task 4・6 の関数で作る（受け取りの関数は Task 7 なので、受取だけが材料）
    const created = (await db().query('select public.admin_create_purchase_order($1, null, $2::jsonb, $3, $4) as r',
      ['Supplier A', JSON.stringify([{ variantId: c.variantId, quantity: 10 }]), actor, randomUUID()])).rows[0].r as { id: string; version: number };
    const lineId = (await db().query('select id from public.purchase_order_lines where purchase_order_id = $1', [created.id])).rows[0].id as string;

    // 数量が未確定の行は仮数量 10 があっても数えない
    expect(numbers(await rowOf(actor, c.variantId))).toMatchObject({ order_quantity: 5, on_order: 0, required: 5 });

    // 数量を確定する: 未納 6 が発注済み。注文数 5 を超えるので発注必要数は 0
    const confirmed = (await db().query('select public.admin_confirm_purchase_order_quantities($1::uuid, $2::integer, $3::jsonb, null, $4::uuid, $5::uuid) as r',
      [created.id, created.version, JSON.stringify([{ lineId, quantity: 6, unitPriceYen: null }]), actor, randomUUID()])).rows[0].r as { version: number };
    expect(numbers(await rowOf(actor, c.variantId))).toMatchObject({ on_order: 6, required: 0 });

    // 2 点を受け取る（台帳の入荷 + 納品数）: 在庫 2、未納 4。5 − 2 − 4 → 0
    await insertRestockMovement(db(), c.variantId, 2);
    await updateLine(lineId, 'received_quantity = 2');
    expect(numbers(await rowOf(actor, c.variantId))).toMatchObject({ free: 2, on_hand: 2, order_quantity: 5, on_order: 4, required: 0 });

    // 打切り: 確定数量を納品数まで下げる。未納は 0 になり、発注必要数は 5 − 2 − 0 = 3 に戻って増える
    const closed = (await db().query('select public.admin_short_close_purchase_order($1::uuid, $2::integer, $3::uuid[], $4::text, $5::uuid, $6::uuid) as r',
      [created.id, confirmed.version, [lineId], '残りを打ち切る', actor, randomUUID()])).rows[0].r as { closedQuantity: number };
    expect(closed.closedQuantity).toBe(4);
    expect(numbers(await rowOf(actor, c.variantId))).toMatchObject({ on_hand: 2, order_quantity: 5, on_order: 0, required: 3 });
  });

  test('FREQ-525-AC-02: 停止variantは在庫・未納・未完了注文のどれかがある間だけ出る（通常の販売候補へ戻さない）', async () => {
    const actor = await reader();
    const idle = await createCatalogFixture(db(), { stock: 0, isActive: false });
    const stocked = await createCatalogFixture(db(), { stock: 3, isActive: false });
    const purchased = await createCatalogFixture(db(), { stock: 0, isActive: false });
    const ordered = await createCatalogFixture(db(), { stock: 0, isActive: false });
    const closed = await createCatalogFixture(db(), { stock: 0, isActive: false });
    const live = await createCatalogFixture(db(), { stock: 0 });
    const purchasedLine = await purchaseLine(await purchaseOrder(), purchased.variantId, { provisional: 4, confirmed: 2 });
    await paidOrder(ordered.itemId, ordered.variantId, 1);
    const closedLine = await purchaseLine(await purchaseOrder(), closed.variantId, { provisional: 4, confirmed: 3 });

    // 何も無い停止 variant は出ない。販売中の variant は何も無くても出る
    expect(await rowOf(actor, idle.variantId)).toBeUndefined();
    expect(await rowOf(actor, live.variantId)).toBeDefined();
    // 在庫・未納・未完了の注文のどれかがあれば、停止のまま出る（is_active は false のまま）
    expect(numbers(await rowOf(actor, stocked.variantId))).toMatchObject({ on_hand: 3 });
    expect(await rowOf(actor, stocked.variantId)).toMatchObject({ is_active: false });
    expect(numbers(await rowOf(actor, purchased.variantId))).toMatchObject({ on_hand: 0, on_order: 2, order_quantity: 0 });
    expect(await rowOf(actor, purchased.variantId)).toMatchObject({ is_active: false });
    expect(numbers(await rowOf(actor, ordered.variantId))).toMatchObject({ on_hand: 0, on_order: 0, order_quantity: 1, required: 1 });
    expect(await rowOf(actor, ordered.variantId)).toMatchObject({ is_active: false });

    // 未納が無くなれば（確定数量 0 まで打切り）出なくなる。出し入れで is_active は変わらない
    expect(await rowOf(actor, closed.variantId)).toBeDefined();
    await updateLine(closedLine, 'confirmed_quantity = 0');
    expect(await rowOf(actor, closed.variantId)).toBeUndefined();
    await updateLine(purchasedLine, 'confirmed_quantity = 0');
    expect(await rowOf(actor, purchased.variantId)).toBeUndefined();
    expect((await db().query('select count(*)::int as n from public.item_variants where id = any($1::bigint[]) and is_active', [[idle.variantId, stocked.variantId, purchased.variantId, ordered.variantId, closed.variantId]])).rows[0].n).toBe(0);
  });

  test('FREQ-525-AC-02: 並びは item_id、色の position、サイズの position、variant_id の昇順', async () => {
    const actor = await reader();
    // 後から作る商品（item_id が大きい）の variant を先に作り、variant_id の順が item の順に勝たないことを見る
    const earlierItem = await createItem();
    const laterItem = await createItem();
    expect(earlierItem).toBeLessThan(laterItem);
    const laterColor = await addColor(laterItem, 'A', 0);
    const laterVariant = await addVariant(laterItem, laterColor, null);

    const colorA = await addColor(earlierItem, 'A', 0);
    const colorB = await addColor(earlierItem, 'B', 1);
    const sizeS = await addSize(earlierItem, 'S', 0);
    const sizeL = await addSize(earlierItem, 'L', 1);
    const colorBLarge = await addVariant(earlierItem, colorB, sizeL);
    const colorALarge = await addVariant(earlierItem, colorA, sizeL);
    const colorBSmall = await addVariant(earlierItem, colorB, sizeS);
    const colorASmall = await addVariant(earlierItem, colorA, sizeS);
    // 商品を作ると、色もサイズも無い variant が自動で1つできる（items の同期のトリガー）。それも並びに入る
    const autoVariantOf = async (itemId: number) =>
      Number((await db().query('select id from public.item_variants where item_id = $1 and color_id is null and size_id is null', [itemId])).rows[0].id);
    const bare = await autoVariantOf(earlierItem);
    const laterBare = await autoVariantOf(laterItem);

    const mine = new Set([laterVariant, laterBare, colorBLarge, colorALarge, colorBSmall, colorASmall, bare].map(String));
    const order = (await inventory(actor)).filter((row) => mine.has(row.variant_id as string)).map((row) => row.variant_id);
    // 小さい item_id の組が先。その中は 色A(位置0): S,L → 色B(位置1): S,L の順。色もサイズも無い variant は最後
    expect(order).toEqual([colorASmall, colorALarge, colorBSmall, colorBLarge, bare, laterVariant, laterBare].map(String));
  });

  test('FREQ-525-AC-02: GET の読取で item_variants・台帳・割当・状態の履歴・操作の受付・発注の表の行数が変わらず、色とサイズだけの商品に variant を作らない', async () => {
    const actor = await reader();
    const c = await createCatalogFixture(db(), { stock: 4 });
    const order = await paidOrder(c.itemId, c.variantId, 3);
    await seedGroupG1Allocation(db(), { orderItemId: order.orderItemIds[0], quantity: 2, kind: 'paid' });
    await purchaseLine(await purchaseOrder(), c.variantId, { provisional: 3, confirmed: 3 });
    // items.colors / items.sizes はあるが variant の無い商品（backfill_item_variants が作る対象）
    const bare = await db().query(
      `insert into public.items (name, description, price, category, image_url, status, colors, sizes)
       values ('fx-bare-' || gen_random_uuid()::text, '行数の試験', 5000, 'TOPS', 'https://example.com/item.png', 'published',
               '[{"name":"RED","hex":"#ff0000"}]'::jsonb, ARRAY['S']) returning id`);
    const bareId = Number(bare.rows[0].id);
    // 商品を作ると同期のトリガーが variant を作るので、読取が作らないことを見るために消しておく（参照は無い）
    await db().query('delete from public.item_variants where item_id = $1', [bareId]);
    expect((await db().query('select count(*)::int as n from public.item_variants where item_id = $1', [bareId])).rows[0].n).toBe(0);

    const counts = async () => (await db().query(`select
      (select count(*) from public.item_variants)::int as variants, (select count(*) from public.item_colors)::int as colors,
      (select count(*) from public.item_sizes)::int as sizes, (select count(*) from public.stock_movements)::int as movements,
      (select count(*) from public.order_item_allocations)::int as allocations,
      (select count(*) from public.order_item_allocation_events)::int as allocation_events,
      (select count(*) from public.order_item_state_events)::int as state_events,
      (select count(*) from private.group_g_operations)::int as operations,
      (select count(*) from public.purchase_orders)::int as purchase_orders, (select count(*) from public.purchase_order_lines)::int as purchase_lines,
      (select count(*) from public.purchase_order_revisions)::int as revisions, (select count(*) from public.purchase_order_receipts)::int as receipts,
      (select coalesce(sum(stock_quantity), 0) from public.item_variants)::int as stock`)).rows[0];
    const before = await counts();

    const publicRows = await inventory(actor);
    const privateRows = await inventory(actor, 'private');
    await inventory(actor);

    expect(await counts()).toEqual(before);
    expect(privateRows).toEqual(publicRows);
    expect((await db().query('select count(*)::int as n from public.item_variants where item_id = $1', [bareId])).rows[0].n).toBe(0);
    expect(publicRows.some((row) => row.item_id === String(bareId))).toBe(false);
  });

  // ---- FREQ-540-AC-07: 権限と ACL ----

  test.each([
    ['無効にした役割', { roles: ['admin'], options: { inactive: ['admin'] } }],
    ['期限切れの役割', { roles: ['admin'], options: { expired: ['admin'] } }],
    ['役割が無い', { roles: [] as string[], options: {} }],
  ])('FREQ-540-AC-07: %sの実行者は GROUP_G_FORBIDDEN / 42501 で、行を返さない', async (_name, scenario) => {
    const actor = await createActor(scenario.roles, scenario.options);
    expect(await rejected(() => inventory(actor))).toEqual(FORBIDDEN);
    expect(await rejected(() => inventory(actor, 'private'))).toEqual(FORBIDDEN);
  });

  test('FREQ-540-AC-07: admin.items.read / admin.items.manage だけ、admin.stock.manage だけ、存在しない実行者・NULL は断られ、admin.stock.read があれば読める（役割をまたいだ和集合も）', async () => {
    await grant('supporter', ['admin.items.read', 'admin.items.manage']);
    const itemsOnly = await createActor(['supporter']);
    expect(await rejected(() => inventory(itemsOnly))).toEqual(FORBIDDEN);

    await revoke('supporter', ['admin.items.read', 'admin.items.manage']);
    await grant('supporter', ['admin.stock.manage']);
    const manageOnly = await createActor(['supporter']);
    expect(await rejected(() => inventory(manageOnly))).toEqual(FORBIDDEN);

    expect(await rejected(() => inventory(randomUUID()))).toEqual(FORBIDDEN);
    expect(await rejected(async () => db().query('select * from public.list_admin_inventory($1::uuid)', [null]))).toEqual(FORBIDDEN);

    await grant('user', ['admin.stock.read']);
    const readOnly = await createActor(['user']);
    expect(Array.isArray(await inventory(readOnly))).toBe(true);
    // stock.read が別の役割にあっても、有効な役割の和集合で足りる
    const union = await createActor(['supporter', 'user']);
    expect(Array.isArray(await inventory(union))).toBe(true);
  });

  test('FREQ-540-AC-07: 実行者の現在の権限を毎回確かめる。admin.stock.read を外すとその場から断られる', async () => {
    const actor = await reader();
    expect(Array.isArray(await inventory(actor))).toBe(true);
    await revoke('admin', ['admin.stock.read']);
    expect(await rejected(() => inventory(actor))).toEqual(FORBIDDEN);
  });

  test('FREQ-540-AC-07: private 本体と public 入口は所有者 postgres・search_path 空・STABLE の戻り列 13 つで、PUBLIC / anon / authenticated に EXECUTE が無く service_role だけが持つ。public 入口は SQL の INVOKER', async () => {
    const read = async (signature: string) => (await db().query(`select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
        l.lanname as language, p.proconfig as config, p.provolatile as volatility, p.proretset as set_returning,
        (select count(*)::int from unnest(p.proargmodes) m where m = 't') as result_columns,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`, [signature])).rows[0];
    const common = { owner: 'postgres', config: ['search_path=""'], volatility: 's', set_returning: true, result_columns: 13,
      service_role: true, anon: false, authenticated: false, public_can_execute: false };

    expect(await read(PRIVATE_SIGNATURE)).toEqual({ ...common, definer: true, language: 'plpgsql' });
    expect(await read(PUBLIC_SIGNATURE)).toEqual({ ...common, definer: false, language: 'sql' });
  });

  test('FREQ-540-AC-07: anon / authenticated は public 入口も private 本体も呼べず（42501）、service_role は public 入口から読める', async () => {
    const actor = await reader();
    const c = await createCatalogFixture(db(), { stock: 1 });
    const attempt = async (role: string, sql: string) => {
      await db().query('savepoint role_attempt');
      try {
        await db().query(`set local role ${role}`);
        if (role === 'authenticated') await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: randomUUID(), role })]);
        const res = await db().query(sql, [actor]);
        return { rows: res.rows as Array<Record<string, unknown>> };
      } catch (caught) {
        return { code: (caught as { code?: string }).code ?? 'unknown' };
      } finally {
        await db().query('rollback to savepoint role_attempt');
        await db().query('release savepoint role_attempt');
      }
    };

    for (const role of ['anon', 'authenticated']) {
      expect(await attempt(role, 'select * from public.list_admin_inventory($1)')).toEqual({ code: '42501' });
      expect(await attempt(role, 'select * from private.list_admin_inventory($1)')).toEqual({ code: '42501' });
    }
    const viaService = await attempt('service_role', 'select * from public.list_admin_inventory($1)');
    expect('rows' in viaService).toBe(true);
    expect((viaService as { rows: Array<Record<string, unknown>> }).rows.some((row) => row.variant_id === String(c.variantId))).toBe(true);
  });
});
