/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { createCatalogFixture, insertOrderWithLines } from './helpers/order-fixtures';
import { seedGroupG1Shipment } from './helpers/group-g1-fixtures';
import { G3C_ALLOWLIST, replaceAllowlistSql } from './helpers/group-g-allowlist';
import { seedGroupG3ReadyOrder, seedGroupG3Slip, seedGroupG3MissingVariantAllocation, withRolePermissions } from './helpers/group-g3-fixtures';
import { bundleVerdict, type BundleOrder, type BundleVerdict } from '@/lib/orders/shipment-slips/bundling';

/**
 * G-3 Task 4（FREQ-531-AC-03・FREQ-532・FREQ-533-AC-01・FREQ-540-AC-10・AC-11）: 発送票の下書きの保存・入替・破棄と押さえの道具。
 * private.admin_save_shipment_slip_draft / admin_discard_shipment_slip_draft とそれぞれの公開入口（service_role のみ）、
 * private.lock_group_g_shipment_slips（誰も EXECUTE できない）。処理順は「引数検証 → 押さえ → 権限 → 指紋と再送 → 存在 → 段階 → 版 →
 * 業務規則（未払い → 阻害理由 → 同梱 → 数量）→ 書込み → 操作の記録（最後）」。在庫・割当・台帳・注文・発送は一切変えない。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包む。
 */
jest.setTimeout(60000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const SLIPS_FILES = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g3_shipping_slips.sql'));
const SLIPS_SQL = SLIPS_FILES.length === 1 ? fs.readFileSync(path.join(MIGRATION_DIRECTORY, SLIPS_FILES[0]), 'utf8') : '';
const READS_FILES = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g3_shipping_reads.sql'));

function sectionOf(sql: string, begin: string, end: string): string {
  const from = sql.indexOf(begin);
  const to = from < 0 ? -1 : sql.indexOf(end, from + begin.length);
  if (from < 0 || to < 0) throw new Error(`missing ${begin}`);
  return sql.slice(from + begin.length, to);
}

const failure = (message: string, code = '22023') => ({ code, message });
const INVALID = failure('GROUP_G_ARGUMENT_INVALID');
const EMPTY = failure('GROUP_G_SLIP_EMPTY');
const FORBIDDEN = failure('GROUP_G_FORBIDDEN', '42501');
const CONFLICT = failure('GROUP_G_REQUEST_KEY_CONFLICT', '23505');
const NOT_FOUND = failure('GROUP_G_SLIP_NOT_FOUND', 'P0002');
const VERSION_CONFLICT = failure('GROUP_G_SLIP_VERSION_CONFLICT', '55000');
const NOT_DRAFT = failure('GROUP_G_SLIP_NOT_DRAFT', '55000');
const NOT_SHIPPABLE = failure('GROUP_G_SLIP_ORDER_NOT_SHIPPABLE');
const PAYMENT_REVIEW = failure('GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED');
const EXCHANGE_ON_HOLD = failure('GROUP_G_SLIP_EXCHANGE_ON_HOLD');
const ADDRESS_INCOMPLETE = failure('GROUP_G_SLIP_ADDRESS_INCOMPLETE');
const CUSTOMER_MISMATCH = failure('GROUP_G_SLIP_CUSTOMER_MISMATCH');
const ADDRESS_MISMATCH = failure('GROUP_G_SLIP_ADDRESS_MISMATCH');
const EXCEEDS_READY = failure('GROUP_G_SLIP_QUANTITY_EXCEEDS_READY');
const VERDICT_FAILURES: Record<Exclude<BundleVerdict, null>, { code: string; message: string }> = {
  customer_mismatch: CUSTOMER_MISMATCH, address_mismatch: ADDRESS_MISMATCH, address_incomplete: ADDRESS_INCOMPLETE,
};

type Line = { orderItemId: string; quantity: number };
type Saved = { id: string; number: string; version: number; replayed: boolean };

describe('G-3 発送票の下書きの移行ファイルの形（DB なし）', () => {
  test('FREQ-540-AC-11: 移行は1本で時刻は reads より後。BOM・CR・全角空白・NBSP・非 ASCII が無く、BEGIN・NOTIFY・COMMIT が1つ、節の印が1組', () => {
    expect(SLIPS_FILES).toHaveLength(1);
    expect(READS_FILES).toHaveLength(1);
    expect(SLIPS_FILES[0].slice(0, SLIPS_FILES[0].indexOf('_')) > READS_FILES[0].slice(0, READS_FILES[0].indexOf('_'))).toBe(true);
    expect(SLIPS_SQL.charCodeAt(0)).not.toBe(0xfeff);
    expect(SLIPS_SQL).not.toMatch(/[\r　 ﻿​-‍]/);
    expect(SLIPS_SQL).not.toMatch(/[^\x00-\x7f]/);
    const lines = SLIPS_SQL.split('\n');
    expect(lines.filter((line) => /^\s*BEGIN\s*;/i.test(line))).toEqual(['BEGIN;']);
    expect(lines.filter((line) => /^\s*COMMIT\s*;/i.test(line))).toEqual(['COMMIT;']);
    expect(SLIPS_SQL.match(/NOTIFY pgrst/g)).toHaveLength(1);
    const markers = ['-- G3C_BODY_BEGIN', '-- G3C_BODY_END', '-- G3C_FINAL_ASSERT_BEGIN', '-- G3C_FINAL_ASSERT_END'];
    const positions = markers.map((marker) => {
      expect({ marker, count: SLIPS_SQL.split(`\n${marker}\n`).length - 1 }).toEqual({ marker, count: 1 });
      return SLIPS_SQL.indexOf(marker);
    });
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(SLIPS_SQL.indexOf("NOTIFY pgrst, 'reload schema';")).toBeGreaterThan(positions[3]);
    expect(SLIPS_SQL.split('\n').filter((line) => line.trim() !== '').at(-1)).toBe('COMMIT;');
  });

  test('FREQ-540-AC-11: private schema の USAGE を変える文が無く、PUBLIC への GRANT も無い。末尾の確かめの失敗は GROUP_G_MIGRATION_ASSERTION_FAILED / 55000 で DETAIL は項目名だけ', () => {
    const code = SLIPS_SQL.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bON\s+SCHEMA\s+private\b/i);
    expect(code).not.toMatch(/\bGRANT\b[^;]*\bTO\b[^;]*\b(?:PUBLIC|anon|authenticated)\b/i);
    expect(code).not.toMatch(/relacl::text|proacl::text/);
    const assertSection = sectionOf(SLIPS_SQL, '-- G3C_FINAL_ASSERT_BEGIN', '-- G3C_FINAL_ASSERT_END');
    const raises = assertSection.match(/RAISE EXCEPTION [^;]*;/g) ?? [];
    expect(raises).toHaveLength(1);
    expect(raises[0]).toMatch(/^RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;$/);
    for (const [, name] of assertSection.matchAll(/v_failed := '([^']*)'/g)) expect(name).toMatch(/^[a-z_]+$/);
  });
});

describeLocalDb('G-3 発送票の下書き（保存・入替・破棄）', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string;
  let jst: string;

  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = await flow.createActor(['supporter']);
    jst = (await db().query("select to_char(now() at time zone 'Asia/Tokyo', 'YYYYMMDD') as d")).rows[0].d;
  });
  afterEach(async () => { await db().query('rollback'); });

  const ready = (input: Parameters<typeof seedGroupG3ReadyOrder>[1] = {}) => seedGroupG3ReadyOrder(db(), input);
  const line = (f: { orderItemId: string }, quantity = 1): Line => ({ orderItemId: f.orderItemId, quantity });
  const save = async (slipId: string | null, version: number | null, lines: unknown, options: {
    key?: string | null; by?: string | null; schema?: 'public' | 'private';
  } = {}): Promise<Saved> => (await db().query(
    `select ${options.schema ?? 'public'}.admin_save_shipment_slip_draft($1, $2, $3::jsonb, $4, $5) as r`,
    [slipId, version, JSON.stringify(lines), options.by === undefined ? actor : options.by, options.key === undefined ? randomUUID() : options.key],
  )).rows[0].r;
  const create = (lines: unknown, options: { key?: string | null; by?: string | null } = {}) => save(null, null, lines, options);
  const discard = async (slipId: string | null, version: number | null, options: { key?: string | null; by?: string | null; schema?: 'public' | 'private' } = {}): Promise<Saved> => (await db().query(
    `select ${options.schema ?? 'public'}.admin_discard_shipment_slip_draft($1, $2, $3, $4) as r`,
    [slipId, version, options.by === undefined ? actor : options.by, options.key === undefined ? randomUUID() : options.key],
  )).rows[0].r;
  const slipRow = async (id: string) => (await db().query('select * from public.shipment_slips where id = $1', [id])).rows[0];
  /** 有効期限は最後の保存の時刻（この取引の now()）から7日。マイクロ秒まで SQL の中で比べる */
  const expiresInSevenDays = async (id: string) => (await db().query(
    "select (expires_at = now() + interval '7 days') as ok from public.shipment_slips where id = $1", [id])).rows[0].ok as boolean;
  /** 荷作り表の1行（頁を送って探す） */
  const packingRow = async (orderItemId: string) => {
    for (let offset = 0; ; offset += 100) {
      const rows = (await db().query('select * from public.list_admin_packing(null, 100, $1, $2)', [offset, actor])).rows;
      const found = rows.find((row) => row.order_item_id === orderItemId);
      if (found) return found;
      if (rows.length < 100) return undefined;
    }
  };
  const operationRows = async (key: string) => (await db().query('select * from private.group_g_operations where request_key = $1', [key])).rows;
  const counts = async () => (await db().query(`select
      (select count(*) from public.shipment_slips)::int as slips,
      (select count(*) from private.group_g_operations where operation like 'shipment_slip_%')::int as operations`)).rows[0] as { slips: number; operations: number };
  const untouched = async () => (await db().query(`select
      (select count(*) from public.stock_movements)::text as movements,
      (select coalesce(sum(stock_quantity), 0) from public.item_variants)::text as stock,
      (select count(*) from public.order_item_allocations)::text as allocations,
      (select coalesce(sum(remaining_quantity), 0) from public.order_item_allocations)::text as remaining,
      (select count(*) from public.order_item_allocation_events)::text as events,
      (select count(*) from public.order_item_state_events)::text as states,
      (select count(*) from public.orders)::text as orders,
      (select coalesce(sum(total_amount + coalesce(paid_amount, 0)), 0) from public.orders)::text as order_amounts,
      (select count(*) from public.order_items)::text as items,
      (select count(*) from public.order_fulfillments)::text as fulfillments,
      (select count(*) from public.order_fulfillment_lines)::text as fulfillment_lines`)).rows[0];
  const nextNumber = async (offset = 0) => {
    const row = (await db().query(`select coalesce(max(right(number, 4)::integer), 0) + 1 as n from public.shipment_slips where number like $1`, [`SL-${jst}-%`])).rows[0];
    return `SL-${jst}-${String(Number(row.n) + offset).padStart(4, '0')}`;
  };
  /** 失敗を取引ごと止めずに受け取り、票と操作の記録が増えないことも確かめる */
  const refused = async (run: () => Promise<unknown>) => {
    const before = await counts();
    const result = await flow.rejected(run);
    expect(await counts()).toEqual(before);
    return result;
  };

  test('FREQ-531-AC-03: 作成で票1件・番号 SL-<JSTの日付>-0001 から・stage draft・version 1・draft_lines・顧客と送り先の写し・expires_at(7日)・操作の記録が一度に保存される。同日の2件目は次の番号、別の日の番号は数えない', async () => {
    await seedGroupG3Slip(db(), { number: 'SL-20000101-0999' });
    const f = await ready({ email: '  Guest@Example.COM ', shipping: { fullName: '  山田 花子  ', building: '   ', phone: ' 0311112222 ' } });
    const g = await ready();
    const first = await nextNumber();
    const before = await counts();
    const key = randomUUID();
    const result = await create([line(f, 3)], { key });
    expect(result).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), number: first, version: 1, replayed: false });
    expect(first).toBe(`SL-${jst}-${first.slice(-4)}`);
    expect(await counts()).toEqual({ slips: before.slips + 1, operations: before.operations + 1 });
    const row = await slipRow(result.id);
    expect(row).toMatchObject({
      number: first, stage: 'draft', version: 1, customer_kind: 'guest', customer_user_id: null, customer_email: 'guest@example.com',
      ship_to_full_name: '山田 花子', ship_to_postal_code: '1500001', ship_to_prefecture: '東京都', ship_to_city: '渋谷区',
      ship_to_address: '神宮前1-1-1', ship_to_phone: '0311112222', ship_to_building: null, created_by: actor,
      shipping_carrier: null, tracking_number: null, notify_customer: null, shipment_date: null, confirmed_at: null,
      cancelled_at: null, discarded_at: null,
    });
    expect(row.draft_lines).toEqual([{ orderItemId: f.orderItemId, quantity: 3 }]);
    expect(await expiresInSevenDays(result.id)).toBe(true);
    const operations = await operationRows(key);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ operation: 'shipment_slip_save', cause_type: 'shipment_slip', cause_id: result.id, actor_id: actor });
    expect(operations[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(operations[0].result).toEqual({ id: result.id, number: first, version: 1, replayed: false });
    const second = await create([line(g, 1)]);
    expect(second.number).toBe(await nextNumber(-1));
    expect(Number(second.number.slice(-4))).toBe(Number(first.slice(-4)) + 1);
  });

  test('FREQ-531-AC-03: 会員の注文は member + customer_user_id で写し、メールを持たない。会員の複数の注文も同梱できる', async () => {
    const member = await flow.createActor([]);
    const a = await ready(); const b = await ready({ email: 'other@example.com' });
    for (const f of [a, b]) await db().query('update public.orders set user_id = $2 where id = $1', [f.orderId, member]);
    const slip = await create([line(a), line(b)]);
    expect(await slipRow(slip.id)).toMatchObject({ customer_kind: 'member', customer_user_id: member, customer_email: null });
  });

  test('FREQ-531-AC-03: その日の番号が 9999 まで使われていれば GROUP_G_SLIP_NUMBER_EXHAUSTED / 55000 で断り、票も操作の記録も増えない。別の日の 9999 は数えない', async () => {
    const f = await ready();
    await seedGroupG3Slip(db(), { number: 'SL-20000101-9999' });
    const created = await create([line(f, 1)]);
    expect(created.number).toBe(await nextNumber(-1));
    await seedGroupG3Slip(db(), { number: `SL-${jst}-9999` });
    expect(await refused(() => create([line(f, 1)]))).toEqual(failure('GROUP_G_SLIP_NUMBER_EXHAUSTED', '55000'));
    // 更新は番号を採らないので通る
    expect((await save(created.id, 1, [line(f, 2)])).version).toBe(2);
  });

  test('FREQ-531-AC-03: 一部の数量で作れる。更新で選択が丸ごと入れ替わり、顧客と送り先の写しが先頭の明細の注文から取り直され、version が増える', async () => {
    const f = await ready({ allocated: 4 });
    const g = await ready({ email: 'second@example.com', shipping: { fullName: '佐藤 次郎', postalCode: '5300001', prefecture: '大阪府', city: '大阪市', address: '梅田2-2-2', building: 'ビル3F', phone: '0699998888' } });
    const created = await create([line(f, 2)]);
    expect((await slipRow(created.id)).draft_lines).toEqual([{ orderItemId: f.orderItemId, quantity: 2 }]);
    const replaced = await save(created.id, 1, [line(g, 4)]);
    expect(replaced).toMatchObject({ id: created.id, number: created.number, version: 2, replayed: false });
    expect(await slipRow(created.id)).toMatchObject({
      version: 2, stage: 'draft', customer_kind: 'guest', customer_email: 'second@example.com', ship_to_full_name: '佐藤 次郎',
      ship_to_postal_code: '5300001', ship_to_prefecture: '大阪府', ship_to_city: '大阪市', ship_to_address: '梅田2-2-2',
      ship_to_building: 'ビル3F', ship_to_phone: '0699998888',
    });
    expect((await slipRow(created.id)).draft_lines).toEqual([{ orderItemId: g.orderItemId, quantity: 4 }]);
    expect((await db().query('select count(*)::int as n from public.shipment_slips where number = $1', [created.number])).rows[0].n).toBe(1);
    // 明細の並びは orderItemId の昇順（入力の順に依らない）
    const h1 = await ready(); const h2 = await ready();
    const sorted = [h1.orderItemId, h2.orderItemId].sort();
    const two = await save(created.id, 2, [line(h2), line(h1)]);
    expect(two.version).toBe(3);
    expect((await slipRow(created.id)).draft_lines.map((l: Line) => l.orderItemId)).toEqual(sorted);
  }, 90000);

  test('FREQ-533-AC-03: 同じ request_key・同内容の再送は同じ票・replayed:true・行数増加0。同キー異内容は GROUP_G_REQUEST_KEY_CONFLICT。版違いは GROUP_G_SLIP_VERSION_CONFLICT', async () => {
    const f = await ready(); const g = await ready();
    const stranger = await flow.createActor(['supporter']);
    const key = randomUUID();
    const created = await create([line(f, 2)], { key });
    const before = await counts();
    const replay = await create([line(f, 2)], { key });
    expect(replay).toEqual({ ...created, replayed: true });
    expect(await counts()).toEqual(before);
    expect(await refused(() => create([line(f, 3)], { key }))).toEqual(CONFLICT);
    expect(await refused(() => create([line(f, 2)], { key, by: stranger }))).toEqual(CONFLICT);
    // 更新: 同じキーの再送は、票がその後に進んでいても保存した結果を返す
    const updateKey = randomUUID();
    const updated = await save(created.id, 1, [line(g, 1)], { key: updateKey });
    expect(updated.version).toBe(2);
    await save(created.id, 2, [line(f, 1)]);
    expect(await save(created.id, 1, [line(g, 1)], { key: updateKey })).toEqual({ ...updated, replayed: true });
    expect(await refused(() => save(created.id, 1, [line(g, 1), line(f, 1)], { key: updateKey }))).toEqual(CONFLICT);
    // 別のキーで古い版を送れば版の衝突
    expect(await refused(() => save(created.id, 1, [line(g, 1)]))).toEqual(VERSION_CONFLICT);
    expect((await slipRow(created.id)).version).toBe(3);
    // 同じキーでも保存と破棄は別の操作（operation が違えば衝突しない）
    expect(await discard(created.id, 3, { key: updateKey })).toMatchObject({ version: 4, replayed: false });
  });

  const addressFields = ['shipping_full_name', 'shipping_postal_code', 'shipping_prefecture', 'shipping_city', 'shipping_address', 'shipping_building', 'shipping_phone'] as const;
  const addressKeys = { shipping_full_name: 'fullName', shipping_postal_code: 'postalCode', shipping_prefecture: 'prefecture', shipping_city: 'city',
    shipping_address: 'address', shipping_building: 'building', shipping_phone: 'phone' } as const;
  const shippingFor = (field: string, value: string) => ({ [addressKeys[field as keyof typeof addressKeys]]: value });
  const bundleCases: Array<[string, string, string, string, BundleVerdict]> = [
    ['same member different email', 'member', 'member', 'different', null],
    ['different member same email', 'member', 'otherMember', 'same', 'customer_mismatch'],
    ['guest case and whitespace', 'guest', 'guest', 'normalized', null],
    ['guest different email', 'guest', 'guest', 'different', 'customer_mismatch'],
    ['mixed member and guest', 'member', 'guest', 'same', 'customer_mismatch'],
    ['mixed guest and member', 'guest', 'member', 'same', 'customer_mismatch'],
    ...addressFields.map((field): [string, string, string, string, BundleVerdict] => [field, 'guest', 'guest', field, 'address_mismatch']),
    ['both buildings empty', 'guest', 'guest', 'emptyBuildings', null],
    ['one building only', 'guest', 'guest', 'oneBuilding', 'address_mismatch'],
    ['incomplete beats customer mismatch', 'member', 'otherMember', 'incomplete', 'address_incomplete'],
    ['empty guest email', 'guest', 'guest', 'emptyEmail', 'address_incomplete'],
    ['required field empty', 'guest', 'guest', 'emptyCity', 'address_incomplete'],
  ];
  /** 2つの注文を作り、会員・ゲストの組と配送先の違いを付ける。判定の期待と、TS 側に渡す注文の形も返す */
  async function bundlePair(kindA: string, kindB: string, mode: string) {
    const a = await ready({ email: mode === 'emptyEmail' ? ' ' : undefined, shipping: mode === 'incomplete' ? { phone: ' ' } : undefined });
    const b = await ready({
      email: mode === 'different' ? 'different@example.com' : mode === 'normalized' ? '  FIXTURE@EXAMPLE.COM  ' : undefined,
      shipping: (addressFields as readonly string[]).includes(mode) ? shippingFor(mode, mode === 'shipping_building' ? 'Building' : 'different')
        : mode === 'emptyBuildings' ? { building: '  ' } : mode === 'oneBuilding' ? { building: 'Building' } : mode === 'emptyCity' ? { city: ' ' } : undefined,
    });
    const member = await flow.createActor([]); const other = await flow.createActor([]);
    await db().query('update public.orders set user_id = $2 where id = $1', [a.orderId, kindA === 'member' ? member : null]);
    await db().query('update public.orders set user_id = $2 where id = $1', [b.orderId, kindB === 'member' ? member : kindB === 'otherMember' ? other : null]);
    return { a, b };
  }
  async function bundleOrder(orderId: string): Promise<BundleOrder> {
    const r = (await db().query('select * from public.orders where id = $1', [orderId])).rows[0];
    return { userId: r.user_id, email: r.shipping_email, shipTo: {
      fullName: r.shipping_full_name, postalCode: r.shipping_postal_code, prefecture: r.shipping_prefecture, city: r.shipping_city,
      address: r.shipping_address, building: r.shipping_building, phone: r.shipping_phone } };
  }

  test.each(bundleCases)('FREQ-532-AC-01〜04: 保存でも同梱判定をサーバーが断る（拒否のとき票も操作の記録も増えない）: %s', async (_label, kindA, kindB, mode, expected) => {
    const { a, b } = await bundlePair(kindA, kindB, mode);
    if (expected === null) {
      const saved = await create([line(a), line(b)]);
      expect((await slipRow(saved.id)).draft_lines).toHaveLength(2);
      return;
    }
    expect(await refused(() => create([line(a), line(b)]))).toEqual(VERDICT_FAILURES[expected]);
    // 更新でも同じ（既存の下書きを別の組へ入れ替えるとき。a 自体が不足の組は更新の下準備ができない）
    if (mode === 'incomplete' || mode === 'emptyEmail') return;
    const ok = await create([line(a)]);
    expect(await refused(() => save(ok.id, 1, [line(a), line(b)]))).toEqual(VERDICT_FAILURES[expected]);
    expect((await slipRow(ok.id)).version).toBe(1);
  });

  test('FREQ-532-AC-03: 同じメールの別会員を介して会員とゲストを連鎖しない（3件の選択を断る）', async () => {
    const orders = [await ready(), await ready(), await ready()];
    const u = await flow.createActor([]); const v = await flow.createActor([]);
    await db().query('update public.orders set user_id = $2 where id = $1', [orders[0].orderId, u]);
    await db().query('update public.orders set user_id = $2 where id = $1', [orders[1].orderId, v]);
    expect(await refused(() => create(orders.map((f) => line(f))))).toEqual(CUSTOMER_MISMATCH);
    expect(await refused(() => create([line(orders[0]), line(orders[2])]))).toEqual(CUSTOMER_MISMATCH);
  });

  test.each(bundleCases)('FREQ-532-AC-05: TS の bundleVerdict と DB の結果が同じ組合せ表で一致する: %s', async (_label, kindA, kindB, mode, expected) => {
    const { a, b } = await bundlePair(kindA, kindB, mode);
    const db_ = (await db().query('select private.group_g_bundle_verdict($1) as v', [[a.orderId, b.orderId]])).rows[0].v as BundleVerdict;
    const ts = bundleVerdict([await bundleOrder(a.orderId), await bundleOrder(b.orderId)]);
    expect(ts).toBe(db_);
    expect(db_).toBe(expected);
  });

  /** 同じ選択に複数の違反があるとき、最初のものだけを返す。priority の順は 未払い → 阻害理由 → 同梱 → 数量 */
  test('FREQ-531-AC-03: 拒否の優先順は 未払い → 阻害理由 → 同梱 → 数量（複数の違反があれば最初のものを返す）', async () => {
    const pending = await createCatalogFixture(db(), { stock: 9 });
    const unpaid = await insertOrderWithLines(db(), { status: 'pending', lines: [{ itemId: pending.itemId, variantId: pending.variantId, quantity: 4, fulfillmentType: 'stock' }] });
    // 1. 未払い + 支払確認 + 顧客の違い + 数量超過 → 未払い
    const held = await ready({ email: 'held@example.com' });
    await db().query("select private.ensure_group_g_payment_review_hold($1, 'g3-draft', null, null, null)", [held.orderId]);
    expect(await refused(() => create([{ orderItemId: unpaid.orderItemIds[0], quantity: 9 }, line(held, 9)]))).toEqual(NOT_SHIPPABLE);
    // 2. 支払確認 + 配送先の不足 + 顧客の違い + 数量超過 → 支払確認
    const incomplete = await ready({ shipping: { phone: ' ' }, email: 'incomplete@example.com' });
    expect(await refused(() => create([line(held, 9), line(incomplete, 9)]))).toEqual(PAYMENT_REVIEW);
    // 3. 入金日時なし（阻害理由）+ 顧客の違い + 数量超過 → 阻害理由（同梱ではない）
    const noPaidAt = await ready({ paidAt: null });
    const other = await ready({ email: 'other@example.com' });
    expect(await refused(() => create([line(noPaidAt, 9), line(other, 9)]))).toEqual(NOT_SHIPPABLE);
    // 4. 顧客の違い + 数量超過 → 同梱（数量ではない）
    const a = await ready(); const b = await ready({ email: 'b@example.com' });
    expect(await refused(() => create([line(a, 9), line(b, 9)]))).toEqual(CUSTOMER_MISMATCH);
    // 5. 配送先の違い + 数量超過 → 配送先の違い
    const c = await ready({ shipping: { city: '別の市' } });
    expect(await refused(() => create([line(a, 9), line(c, 9)]))).toEqual(ADDRESS_MISMATCH);
    // 6. 数量超過だけ → 数量
    expect(await refused(() => create([line(a, 5)]))).toEqual(EXCEEDS_READY);
    expect((await create([line(a, 4)])).version).toBe(1);
  });

  test.each([
    ['5（準備中の数 4 を超える）', 5, EXCEEDS_READY],
    ['0', 0, INVALID], ['-1', -1, INVALID], ['1.5', 1.5, INVALID], ['"2"（文字）', '2', INVALID], ['100000', 100000, INVALID], ['null', null, INVALID],
  ])('FREQ-531-AC-03: 数量 %s は拒否する（票も操作の記録も増えない）', async (_label, quantity, expected) => {
    const f = await ready();
    expect(await refused(() => create([{ orderItemId: f.orderItemId, quantity }]))).toEqual(expected);
  });

  test('FREQ-531-AC-03: 数量 4（準備中の数ちょうど）と 99999 の形は通る形。重複・100件超・空・形の崩れは拒否する', async () => {
    const f = await ready();
    expect((await create([line(f, 4)])).version).toBe(1);
    expect(await refused(() => create([line(f, 1), line(f, 2)]))).toEqual(INVALID);
    expect(await refused(() => create(Array.from({ length: 101 }, () => ({ orderItemId: randomUUID(), quantity: 1 }))))).toEqual(INVALID);
    expect(await refused(() => create([]))).toEqual(EMPTY);
    for (const bad of [
      null, {}, 'x', 1, [1], [null], [{}], [{ orderItemId: f.orderItemId }], [{ quantity: 1 }], [{ orderItemId: f.orderItemId, quantity: 1, extra: true }],
      [{ orderItemId: 'not-a-uuid', quantity: 1 }], [{ orderItemId: 5, quantity: 1 }], [{ orderItemId: f.orderItemId, quantity: 1, orderItem: 1 }],
      [[f.orderItemId, 1]],
    ]) expect({ bad, result: await refused(() => create(bad)) }).toEqual({ bad, result: INVALID });
    // 実在しない明細は拒否する（権限・再送の確認より後）
    expect(await refused(() => create([{ orderItemId: randomUUID(), quantity: 1 }]))).toEqual(INVALID);
    // 引数: 作成は版なし、更新は版あり
    const slip = await create([line(f, 1)]);
    expect(await refused(() => save(null, 1, [line(f, 1)]))).toEqual(INVALID);
    expect(await refused(() => save(slip.id, null, [line(f, 1)]))).toEqual(INVALID);
    expect(await refused(() => save(slip.id, 0, [line(f, 1)]))).toEqual(INVALID);
    expect(await refused(() => create([line(f, 1)], { by: null }))).toEqual(INVALID);
    expect(await refused(() => create([line(f, 1)], { key: null }))).toEqual(INVALID);
    expect(await refused(() => save(randomUUID(), 1, [line(f, 1)]))).toEqual(NOT_FOUND);
  });

  test('FREQ-531-AC-02: 阻害理由のある行は保存できない（理由ごとの拒否コード）', async () => {
    const addressless = await ready({ shipping: { phone: ' ' } });
    expect(await refused(() => create([line(addressless)]))).toEqual(ADDRESS_INCOMPLETE);
    const noPaidAt = await ready({ paidAt: null });
    expect(await refused(() => create([line(noPaidAt)]))).toEqual(NOT_SHIPPABLE);
    const held = await ready();
    await db().query("select private.ensure_group_g_payment_review_hold($1, 'g3-draft', null, null, null)", [held.orderId]);
    expect(await refused(() => create([line(held)]))).toEqual(PAYMENT_REVIEW);
    // 色・サイズ未確定（割当と明細の色違いは取引の中だけの材料。コミットされない）
    const missing = await ready({ variantMissing: true });
    expect(await refused(() => create([line(missing)]))).toEqual(NOT_SHIPPABLE);
    expect(await flow.rejected(() => db().query('set constraints group_g_allocation_bounds immediate')))
      .toMatchObject({ code: '23514', message: 'GROUP_G_ALLOCATION_BOUNDS', detail: 'variant_mismatch' });
  });

  test('FREQ-531-AC-02: 交換手数料のお支払い待ちの行は保存できない（交換手数料待ちが色・サイズ未確定より先）', async () => {
    const f = await ready({ paidAt: null, shipping: { phone: ' ' } });
    const shipment = await seedGroupG1Shipment(db(), { orderId: f.orderId, lines: [{ orderItemId: f.orderItemId, quantity: 1 }], shippedAt: '2026-10-21T00:00:00Z' });
    const returnId = (await db().query(`insert into public.order_returns
      (order_id, number, source, status, request_key, request_fingerprint, return_method, return_shipping_payer, notify_customer)
      values ($1, 1, 'customer_request', 'open', $2, 'fixture', 'customer_ships', 'customer', false) returning id`, [f.orderId, randomUUID()])).rows[0].id;
    const returnLine = (await db().query(`insert into public.order_return_lines
      (return_id, fulfillment_id, order_item_id, quantity, reason, resolution, exchange_variant_id, exchange_method)
      values ($1, $2, $3, 1, 'unknown', 'exchange', (select variant_id from public.order_items where id = $3), 'make') returning id`,
    [returnId, shipment, f.orderItemId])).rows[0].id;
    await db().query('update public.order_returns set fee_due_amount = 100 where id = $1', [returnId]);
    const exchange = (await db().query(`insert into public.order_items
      (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type, line_kind, exchange_return_line_id, exchange_paid_amount)
      values ($1, $2, null, 'exchange', 0, 1, 0, 'backorder', 'exchange', $3, 5000) returning id`, [f.orderId, f.itemId, returnLine])).rows[0].id;
    await seedGroupG3MissingVariantAllocation(db(), { orderItemId: exchange, variantId: f.variantId, quantity: 1 });
    expect(await refused(() => create([{ orderItemId: exchange, quantity: 1 }]))).toEqual(EXCHANGE_ON_HOLD);
    expect(await flow.rejected(() => db().query('set constraints group_g_allocation_bounds immediate')))
      .toMatchObject({ code: '23514', message: 'GROUP_G_ALLOCATION_BOUNDS', detail: 'variant_mismatch' });
  });

  test('FREQ-531-AC-03: 2つの下書きが同じ明細を選べる（取り置かない）。準備数・在庫・割当は変わらない', async () => {
    const f = await ready();
    const first = await create([line(f, 4)]);
    const second = await create([line(f, 4)]);
    expect(second.id).not.toBe(first.id);
    expect(second.number).not.toBe(first.number);
    const packing = await packingRow(f.orderItemId);
    expect(packing).toMatchObject({ ready_quantity: 4, shippable_quantity: 4, other_slip_numbers: [first.number, second.number].sort() });
  });

  test('FREQ-531-AC-03: 破棄で draft → discarded・版+1・discarded_at/by・expires_at NULL・操作の記録。再送は同じ結果。破棄済み・確定済みの破棄と保存は GROUP_G_SLIP_NOT_DRAFT', async () => {
    const f = await ready();
    const stranger = await flow.createActor(['supporter']);
    const created = await create([line(f, 2)]);
    const key = randomUUID();
    expect(await refused(() => discard(created.id, 5))).toEqual(VERSION_CONFLICT);
    const result = await discard(created.id, 1, { key });
    expect(result).toEqual({ id: created.id, number: created.number, version: 2, replayed: false });
    expect(await slipRow(created.id)).toMatchObject({ stage: 'discarded', version: 2, discarded_by: actor, expires_at: null });
    expect((await slipRow(created.id)).discarded_at).not.toBeNull();
    expect((await slipRow(created.id)).draft_lines).toEqual([{ orderItemId: f.orderItemId, quantity: 2 }]);
    const operations = await operationRows(key);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ operation: 'shipment_slip_discard', cause_type: 'shipment_slip', cause_id: created.id, actor_id: actor });
    const before = await counts();
    expect(await discard(created.id, 1, { key })).toEqual({ ...result, replayed: true });
    expect(await counts()).toEqual(before);
    expect(await refused(() => discard(created.id, 1, { key, by: stranger }))).toEqual(CONFLICT);
    expect(await refused(() => discard(created.id, 2))).toEqual(NOT_DRAFT);
    expect(await refused(() => save(created.id, 2, [line(f, 1)]))).toEqual(NOT_DRAFT);
    for (const stage of ['confirmed', 'cancelled'] as const) {
      const slip = await seedGroupG3Slip(db(), { stage, actorId: actor });
      expect(await refused(() => discard(slip, 1))).toEqual(NOT_DRAFT);
      expect(await refused(() => save(slip, 1, [line(f, 1)]))).toEqual(NOT_DRAFT);
    }
    expect(await refused(() => discard(randomUUID(), 1))).toEqual(NOT_FOUND);
    expect(await refused(() => discard(null, 1))).toEqual(INVALID);
    expect(await refused(() => discard(created.id, null))).toEqual(INVALID);
    expect(await refused(() => discard(created.id, 1, { by: null }))).toEqual(INVALID);
  });

  test('FREQ-531-AC-03: 期限切れの下書きも保存し直せて expires_at が延びる。破棄もできる', async () => {
    const f = await ready();
    const expired = await seedGroupG3Slip(db(), { actorId: actor, draftLines: [{ orderItemId: f.orderItemId, quantity: 1 }], expired: true });
    expect((await db().query('select (expires_at < now()) as past from public.shipment_slips where id = $1', [expired])).rows[0].past).toBe(true);
    const saved = await save(expired, 1, [line(f, 2)]);
    expect(saved).toMatchObject({ id: expired, version: 2 });
    const row = await slipRow(expired);
    expect(await expiresInSevenDays(expired)).toBe(true);
    expect(row.draft_lines).toEqual([{ orderItemId: f.orderItemId, quantity: 2 }]);
    const other = await seedGroupG3Slip(db(), { actorId: actor, draftLines: [], expired: true });
    expect(await discard(other, 1)).toMatchObject({ id: other, version: 2 });
    expect(await slipRow(other)).toMatchObject({ stage: 'discarded', expires_at: null });
  });

  test('FREQ-540-AC-10: 権限は shipping.manage + shipping.read + orders.manage + orders.read の4つが揃った時だけ（manage だけ・read だけ・orders の片方が無い・無効/期限切れの役割・役割なしは GROUP_G_FORBIDDEN）', async () => {
    const f = await ready();
    const slip = await create([line(f, 1)]);
    expect((await save(slip.id, 1, [line(f, 2)])).version).toBe(2);
    for (const permission of ['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read']) {
      await withRolePermissions(db(), 'supporter', [], [permission], async () => {
        expect({ permission, create: await refused(() => create([line(f, 1)])) }).toEqual({ permission, create: FORBIDDEN });
        expect({ permission, save: await refused(() => save(slip.id, 2, [line(f, 1)])) }).toEqual({ permission, save: FORBIDDEN });
        expect({ permission, discard: await refused(() => discard(slip.id, 2)) }).toEqual({ permission, discard: FORBIDDEN });
      });
    }
    const unknown = randomUUID();
    const noRole = await flow.createActor([]);
    const inactive = await flow.createActor(['supporter'], { inactive: ['supporter'] });
    const expired = await flow.createActor(['supporter'], { expired: ['supporter'] });
    for (const [label, who] of [['unknown', unknown], ['noRole', noRole], ['inactive', inactive], ['expired', expired]] as const) {
      expect({ label, create: await refused(() => create([line(f, 1)], { by: who })) }).toEqual({ label, create: FORBIDDEN });
    }
    // 権限の確認は存在の確認・再送より先（存在しない票でも FORBIDDEN）
    expect(await refused(() => save(randomUUID(), 1, [line(f, 1)], { by: unknown }))).toEqual(FORBIDDEN);
    expect(await refused(() => discard(randomUUID(), 1, { by: unknown }))).toEqual(FORBIDDEN);
    // 有効な全役割の和集合で判定する: 店長は初期のまま全部持つ
    const admin = await flow.createActor(['admin']);
    expect((await create([line(f, 1)], { by: admin })).version).toBe(1);
    // 役割が複数ある人: 片方の役割から取り上げても、もう一方が持てば通る（和集合）
    const both = await flow.createActor(['admin', 'supporter']);
    await withRolePermissions(db(), 'admin', [], ['admin.orders.manage'], async () => {
      expect((await create([line(f, 1)], { by: both })).version).toBe(1);
    });
  });

  test('FREQ-531-AC-03: 在庫・割当・台帳・注文・発送の行数と stock_quantity は保存・入替・破棄・再送・拒否のどれでも変わらない', async () => {
    const f = await ready(); const g = await ready();
    const before = await untouched();
    const slip = await create([line(f, 2), line(g, 1)]);
    await save(slip.id, 1, [line(f, 4)]);
    await refused(() => save(slip.id, 2, [line(f, 5)]));
    await discard(slip.id, 2);
    await create([line(g, 4)]);
    expect(await untouched()).toEqual(before);
  });

  test('FREQ-531-AC-03: 途中で失敗したら票も操作の記録も全部残らない（票の INSERT／UPDATE／操作の記録の INSERT に故障を注入）', async () => {
    const f = await ready();
    const slip = await create([line(f, 1)]);
    await db().query(`create function public.g3_draft_fault() returns trigger language plpgsql as $$
      begin raise exception 'G3_DRAFT_FAULT' using errcode = 'P0001'; end; $$`);
    const fault = async (table: string, event: string, when: string, run: () => Promise<unknown>) => {
      await db().query('savepoint fault_probe');
      await db().query(`create trigger g3_draft_fault before ${event} on ${table} for each row ${when} execute function public.g3_draft_fault()`);
      try {
        const before = await counts();
        const row = await slipRow(slip.id);
        const result = await flow.rejected(run);
        expect(result).toMatchObject({ code: 'P0001', message: 'G3_DRAFT_FAULT' });
        expect(await counts()).toEqual(before);
        expect(await slipRow(slip.id)).toEqual(row);
      } finally {
        await db().query('rollback to savepoint fault_probe');
        await db().query('release savepoint fault_probe');
      }
    };
    await fault('public.shipment_slips', 'insert', '', () => create([line(f, 1)]));
    await fault('public.shipment_slips', 'update', '', () => save(slip.id, 1, [line(f, 2)]));
    await fault('public.shipment_slips', 'update', '', () => discard(slip.id, 1));
    await fault('private.group_g_operations', 'insert', "when (new.operation like 'shipment_slip_%')", () => create([line(f, 1)]));
    await fault('private.group_g_operations', 'insert', "when (new.operation like 'shipment_slip_%')", () => save(slip.id, 1, [line(f, 2)]));
    await fault('private.group_g_operations', 'insert', "when (new.operation like 'shipment_slip_%')", () => discard(slip.id, 1));
    // 故障を外せば同じ呼び出しが通る
    expect((await save(slip.id, 1, [line(f, 2)])).version).toBe(2);
  });

  test('FREQ-540-AC-11: 公開入口は SQL INVOKER の委譲で service_role だけが EXECUTE できる。private 本体は service_role だけ、押さえの道具は誰も EXECUTE できない。anon・authenticated は 42501', async () => {
    const read = async (signature: string) => (await db().query(`select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer, l.lanname as language,
        p.proconfig as config, p.provolatile as volatility, p.proretset as set_returning, pg_get_function_result(p.oid) as result, p.proargnames as names,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`, [signature])).rows[0];
    const common = { owner: 'postgres', config: ['search_path=""'], volatility: 'v', set_returning: false, anon: false, authenticated: false, public_can_execute: false };
    const save_ = 'admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)';
    const discard_ = 'admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)';
    const names: Record<string, string[]> = { [save_]: ['_slip_id', '_expected_version', '_lines', '_actor_id', '_request_key'], [discard_]: ['_slip_id', '_expected_version', '_actor_id', '_request_key'] };
    for (const signature of [save_, discard_]) {
      expect(await read(`private.${signature}`)).toEqual({ ...common, definer: true, language: 'plpgsql', result: 'jsonb', service_role: true, names: names[signature] });
      expect(await read(`public.${signature}`)).toEqual({ ...common, definer: false, language: 'sql', result: 'jsonb', service_role: true, names: names[signature] });
    }
    expect(await read('private.lock_group_g_shipment_slips(uuid[],uuid[],boolean)'))
      .toEqual({ ...common, definer: true, language: 'plpgsql', result: 'uuid[]', service_role: false, names: ['_slip_ids', '_order_item_ids', '_with_settings'] });
    const body = (await db().query("select prosrc from pg_proc where oid = 'private.lock_group_g_shipment_slips(uuid[],uuid[],boolean)'::regprocedure")).rows[0].prosrc as string;
    expect(body).toMatch(/BEGIN\s+PERFORM pg_catalog\.pg_advisory_xact_lock\(190521,1\);/);
    expect(body.indexOf('pg_advisory_xact_lock(190521,1)')).toBeLessThan(body.indexOf('FOR SHARE'));
    expect(body.indexOf('FOR SHARE')).toBeLessThan(body.indexOf('private.lock_group_g_inventory('));
    expect(body.indexOf('private.lock_group_g_inventory(')).toBeLessThan(body.indexOf('FOR UPDATE'));

    const f = await ready();
    const slip = await create([line(f, 1)]);
    const attempt = async (role: string, sql: string, params: unknown[]) => {
      await db().query('savepoint role_attempt');
      try {
        await db().query(`set local role ${role}`);
        if (role === 'authenticated') await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: randomUUID(), role })]);
        return { rows: (await db().query(sql, params)).rows };
      } catch (caught) {
        return { code: (caught as { code?: string }).code ?? 'unknown' };
      } finally {
        await db().query('rollback to savepoint role_attempt');
        await db().query('release savepoint role_attempt');
      }
    };
    const calls = (schema: 'public' | 'private'): Array<[string, unknown[]]> => [
      [`select ${schema}.admin_save_shipment_slip_draft($1::uuid, $2::integer, $3::jsonb, $4::uuid, $5::uuid) as r`, [slip.id, 1, JSON.stringify([line(f, 2)]), actor, randomUUID()]],
      [`select ${schema}.admin_discard_shipment_slip_draft($1::uuid, $2::integer, $3::uuid, $4::uuid) as r`, [slip.id, 1, actor, randomUUID()]],
    ];
    for (const role of ['anon', 'authenticated']) {
      for (const schema of ['public', 'private'] as const) {
        for (const [sql, params] of calls(schema)) expect(await attempt(role, sql, params)).toEqual({ code: '42501' });
      }
    }
    // service_role は public 入口から保存・破棄できる。private 本体も呼べる。押さえの道具は呼べない
    expect((await attempt('service_role', ...calls('public')[0])).rows?.[0]).toMatchObject({ r: { version: 2, replayed: false } });
    expect((await attempt('service_role', ...calls('private')[1])).rows?.[0]).toMatchObject({ r: { version: 2, replayed: false } });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await attempt(role, 'select private.lock_group_g_shipment_slips($1::uuid[], $2::uuid[], false)', [[slip.id], []])).toEqual({ code: '42501' });
    }
  });

  describe('移行の最後の確かめ（$g3c_final_objects$）', () => {
    const ASSERT = sectionOf(SLIPS_SQL, '-- G3C_FINAL_ASSERT_BEGIN', '-- G3C_FINAL_ASSERT_END');
    const SAVE = 'private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)';
    const SAVE_ENTRY = 'public.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)';
    const LOCK = 'private.lock_group_g_shipment_slips(uuid[],uuid[],boolean)';
    const failed = (detail: string) => ({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail });
    async function run(): Promise<{ code?: string; message?: string; detail?: string } | null> {
      await db().query('savepoint assert_section');
      try {
        await db().query(ASSERT);
        return null;
      } catch (error) {
        const e = error as { code: string; message: string; detail: string };
        return { code: e.code, message: e.message, detail: e.detail };
      } finally {
        await db().query('rollback to savepoint assert_section');
        await db().query('release savepoint assert_section');
      }
    }
    async function runAfter(change: string) {
      await db().query('savepoint tamper');
      try {
        await db().query(change);
        return await run();
      } finally {
        await db().query('rollback to savepoint tamper');
        await db().query('release savepoint tamper');
      }
    }
    test('FREQ-540-AC-11: 今の DB で末尾の確かめが通る（書き手の一覧は固定の一覧と同じ。G3C の確かめは今の一覧そのもので流し、入れ替えない）', async () => {
      expect(ASSERT).not.toBe('');
      expect(G3C_ALLOWLIST).toHaveLength(70);
      expect(await run()).toBeNull();
    });

    test.each([
      ['公開の入口を1つ落とす', `drop function ${SAVE_ENTRY}`, 'shipment_slip_functions'],
      ['書込みの本体に anon の EXECUTE を付ける', `grant execute on function ${SAVE} to anon`, 'shipment_slip_functions'],
      ['公開の入口に PUBLIC の EXECUTE を付ける', `grant execute on function ${SAVE_ENTRY} to public`, 'shipment_slip_functions'],
      ['押さえの道具に service_role の EXECUTE を付ける', `grant execute on function ${LOCK} to service_role`, 'shipment_slip_functions'],
      ['書込みの本体から service_role の EXECUTE を外す', `revoke execute on function ${SAVE} from service_role`, 'shipment_slip_functions'],
      ['公開の入口を DEFINER にする', `alter function ${SAVE_ENTRY} security definer`, 'shipment_slip_functions'],
      ['書込みの本体の search_path を変える', `alter function ${SAVE} set search_path = public`, 'shipment_slip_functions'],
      ['押さえの道具の順（共通の押さえが最初）を崩す', `create or replace function ${LOCK.replace('(uuid[],uuid[],boolean)', '(_slip_ids uuid[], _order_item_ids uuid[], _with_settings boolean)')}
        returns uuid[] language plpgsql security definer set search_path = '' as $$
        begin
          perform s.id from public.shipment_slips as s where s.id = any(_slip_ids) order by s.id for update;
          perform pg_catalog.pg_advisory_xact_lock(190521,1);
          return array[]::uuid[];
        end; $$`, 'shipment_slip_lock_order'],
      ['書込みの本体が押さえの前に表を読む', `create or replace function ${SAVE.replace('(uuid,integer,jsonb,uuid,uuid)', '(_slip_id uuid, _expected_version integer, _lines jsonb, _actor_id uuid, _request_key uuid)')}
        returns jsonb language plpgsql security definer set search_path = '' as $$
        begin
          perform 1 from public.orders limit 1;
          perform private.lock_group_g_shipment_slips(array[_slip_id], array[]::uuid[], false);
          return null;
        end; $$`, 'shipment_slip_lock_order'],
      // 書き方を変えても押さえの前の表の参照は見つかる（大文字小文字・空白の数・引用符・UPDATE・破棄の本体）
      ['書込みの本体が押さえの前に表を読む（大文字・空白を多く）', `create or replace function ${SAVE.replace('(uuid,integer,jsonb,uuid,uuid)', '(_slip_id uuid, _expected_version integer, _lines jsonb, _actor_id uuid, _request_key uuid)')}
        returns jsonb language plpgsql security definer set search_path = '' as $$
        begin
          PERFORM 1 FROM   public.orders LIMIT 1;
          perform private.lock_group_g_shipment_slips(array[_slip_id], array[]::uuid[], false);
          return null;
        end; $$`, 'shipment_slip_lock_order'],
      ['書込みの本体が押さえの前に表を読む（スキーマ名を引用符で書く）', `create or replace function ${SAVE.replace('(uuid,integer,jsonb,uuid,uuid)', '(_slip_id uuid, _expected_version integer, _lines jsonb, _actor_id uuid, _request_key uuid)')}
        returns jsonb language plpgsql security definer set search_path = '' as $$
        begin
          perform 1 from "public"."orders" limit 1;
          perform private.lock_group_g_shipment_slips(array[_slip_id], array[]::uuid[], false);
          return null;
        end; $$`, 'shipment_slip_lock_order'],
      ['書込みの本体が押さえの前に表を書く（UPDATE）', `create or replace function ${SAVE.replace('(uuid,integer,jsonb,uuid,uuid)', '(_slip_id uuid, _expected_version integer, _lines jsonb, _actor_id uuid, _request_key uuid)')}
        returns jsonb language plpgsql security definer set search_path = '' as $$
        begin
          update public.orders set updated_at = updated_at where false;
          perform private.lock_group_g_shipment_slips(array[_slip_id], array[]::uuid[], false);
          return null;
        end; $$`, 'shipment_slip_lock_order'],
      ['破棄の本体が押さえの前に表を読む', `create or replace function private.admin_discard_shipment_slip_draft(_slip_id uuid, _expected_version integer, _actor_id uuid, _request_key uuid)
        returns jsonb language plpgsql security definer set search_path = '' as $$
        begin
          perform 1 from public.shipment_slips limit 1;
          perform private.lock_group_g_shipment_slips(array[_slip_id], array[]::uuid[], false);
          return null;
        end; $$`, 'shipment_slip_lock_order'],
      // 表を読む関数の呼び出しを押さえの前へ移しても見つかる（権限の確かめは押さえの後）
      ['書込みの本体が権限の確かめを押さえの前に移す', `create or replace function ${SAVE.replace('(uuid,integer,jsonb,uuid,uuid)', '(_slip_id uuid, _expected_version integer, _lines jsonb, _actor_id uuid, _request_key uuid)')}
        returns jsonb language plpgsql security definer set search_path = '' as $$
        begin
          if not private.group_g_actor_has_permissions(_actor_id, array['admin.shipping.manage']) then
            raise exception 'GROUP_G_FORBIDDEN' using errcode = '42501';
          end if;
          perform private.lock_group_g_shipment_slips(array[_slip_id], array[]::uuid[], false);
          return null;
        end; $$`, 'shipment_slip_lock_order'],
      ['書込みの本体が押さえの前に FROM ONLY で表を読む', `create or replace function ${SAVE.replace('(uuid,integer,jsonb,uuid,uuid)', '(_slip_id uuid, _expected_version integer, _lines jsonb, _actor_id uuid, _request_key uuid)')}
        returns jsonb language plpgsql security definer set search_path = '' as $$
        begin
          perform 1 from only public.orders limit 1;
          perform private.lock_group_g_shipment_slips(array[_slip_id], array[]::uuid[], false);
          return null;
        end; $$`, 'shipment_slip_lock_order'],
      ['書込みの本体が押さえの前に TABLE で表を読む', `create or replace function ${SAVE.replace('(uuid,integer,jsonb,uuid,uuid)', '(_slip_id uuid, _expected_version integer, _lines jsonb, _actor_id uuid, _request_key uuid)')}
        returns jsonb language plpgsql security definer set search_path = '' as $$
        begin
          perform 1 from (table public.orders) as t limit 1;
          perform private.lock_group_g_shipment_slips(array[_slip_id], array[]::uuid[], false);
          return null;
        end; $$`, 'shipment_slip_lock_order'],
      ['破棄の本体が権限の確かめを押さえの前に移す', `create or replace function private.admin_discard_shipment_slip_draft(_slip_id uuid, _expected_version integer, _actor_id uuid, _request_key uuid)
        returns jsonb language plpgsql security definer set search_path = '' as $$
        begin
          perform private.group_g_actor_has_permissions(_actor_id, array['admin.shipping.manage']);
          perform private.lock_group_g_shipment_slips(array[_slip_id], array[]::uuid[], false);
          return null;
        end; $$`, 'shipment_slip_lock_order'],
      // 押さえの道具の中の順: 票の行を取る前に追跡の登録の行を取る
      ['押さえの道具が票より先に追跡の登録の行を取る', `create or replace function ${LOCK.replace('(uuid[],uuid[],boolean)', '(_slip_ids uuid[], _order_item_ids uuid[], _with_settings boolean)')}
        returns uuid[] language plpgsql security definer set search_path = '' as $$
        declare v_locked uuid[];
        begin
          perform pg_catalog.pg_advisory_xact_lock(190521,1);
          if _with_settings is true then
            perform s.id from public.shop_settings as s where s.id = 1 for share;
          end if;
          v_locked := private.lock_group_g_inventory(array[]::bigint[], array[]::uuid[], null);
          perform r.fulfillment_id from private.fulfillment_tracking_registrations as r where r.fulfillment_id = any(array[]::uuid[]) for update;
          perform s.id from public.shipment_slips as s where s.id = any(_slip_ids) order by s.id for update;
          return v_locked;
        end; $$`, 'shipment_slip_lock_order'],
      ['押さえの道具が在庫の閉包を取る前に票の行を取る', `create or replace function ${LOCK.replace('(uuid[],uuid[],boolean)', '(_slip_ids uuid[], _order_item_ids uuid[], _with_settings boolean)')}
        returns uuid[] language plpgsql security definer set search_path = '' as $$
        declare v_locked uuid[];
        begin
          perform pg_catalog.pg_advisory_xact_lock(190521,1);
          if _with_settings is true then
            perform s.id from public.shop_settings as s where s.id = 1 for share;
          end if;
          perform s.id from public.shipment_slips as s where s.id = any(_slip_ids) order by s.id for update;
          v_locked := private.lock_group_g_inventory(array[]::bigint[], array[]::uuid[], null);
          perform r.fulfillment_id from private.fulfillment_tracking_registrations as r where r.fulfillment_id = any(array[]::uuid[]) for update;
          return v_locked;
        end; $$`, 'shipment_slip_lock_order'],
      ['書込みの本体が押さえを呼ばない', `create or replace function ${SAVE.replace('(uuid,integer,jsonb,uuid,uuid)', '(_slip_id uuid, _expected_version integer, _lines jsonb, _actor_id uuid, _request_key uuid)')}
        returns jsonb language plpgsql security definer set search_path = '' as $$
        begin
          return null;
        end; $$`, 'shipment_slip_lock_order'],
      ['書き手の一覧から1本外す', '__without_last__', 'shipment_slip_writer_allowlist_missing'],
      ['書き手の一覧に1本足す', '__with_extra__', 'shipment_slip_writer_allowlist_missing'],
      ['書き手の一覧の1本を別の関数に替える', '__swapped__', 'shipment_slip_writer_allowlist'],
      ['同名の別の overload を足す', 'create function private.admin_save_shipment_slip_draft(uuid) returns integer language sql as $$ select 1 $$', 'shipment_slip_function_set'],
    ])('FREQ-540-AC-11: %s と GROUP_G_MIGRATION_ASSERTION_FAILED で止まり DETAIL は項目名（%#）', async (_name, change, detail) => {
      const list = [...G3C_ALLOWLIST];
      const sql = change === '__without_last__' ? replaceAllowlistSql(list.slice(0, -1))
        : change === '__with_extra__' ? replaceAllowlistSql([...list, LOCK])
          : change === '__swapped__' ? replaceAllowlistSql([LOCK, ...list.slice(1)])
            : change;
      expect(await runAfter(sql)).toEqual(failed(detail));
    });
  });
});
