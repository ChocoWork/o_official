/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { seedGroupG3Slip } from './helpers/group-g3-fixtures';
import { seedUnitOrder } from './helpers/accounting-orders-fixtures';

// Accounting plan 2 S14 (FREQ-574 AC-01..AC-04): the year-end shipment check list (6-d), the check marks, the shipping options and the carrier
// receipt-date check (6-d2). Every test runs inside a transaction that is rolled back. The dates are far in the future (2097 / 2098) so that
// slips other suites committed never fall into the ranges. The slips are put straight into the group G tables (the reads here do not depend on
// the cutover day and the G functions refuse such dates).
type Failure = { code?: string; message: string };
type Slip = { slip_id: string; number: string; shipment_date: string; confirmed_at: string | null; stage: string; shipping_carrier: string | null;
  tracking_number: string | null; checked_at: string | null; checked_by: string | null };
type Page = { slips: Slip[]; next_after_date: string | null; next_after_slip: string | null };
type Mark = { slip_id: string; checked_by: string; checked_at: string; note: string | null; created: boolean };
type Options = { carrier_date_check_enabled: boolean; changed_at: string | null; changed_by: string | null; version: string };
const CHECKS = 'public.accounting_shipment_checks';
const OPTIONS = 'public.accounting_shipping_options';
const FUNCTIONS = [
  'public.list_year_end_shipments(date,date,integer,date,uuid)',
  'public.admin_check_year_end_shipment(uuid,uuid,text,uuid)',
  'public.get_shipping_options()',
  'public.admin_set_shipping_options(uuid,boolean,bigint,uuid)',
  'public.list_carrier_date_gaps(date,date,integer)',
];

describeLocalDb('S14 year-end shipments and the carrier receipt-date check (rollback)', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    // The fixtures put rows into the group G tables: the common advisory first (as the G functions do).
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521, 1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  /** Run one statement inside a savepoint as `role`; return the error or null. The role and the writes are undone. */
  async function attempt(sql: string, params: unknown[] = [], role = 'postgres'): Promise<Failure | null> {
    await db().query('savepoint acc_s14_try');
    try {
      await db().query(`set local role ${role}`);
      await db().query(sql, params);
      return null;
    } catch (caught) {
      const e = caught as { code?: string; message: string };
      return { code: e.code, message: e.message };
    } finally {
      await db().query('rollback to savepoint acc_s14_try');
      await db().query('release savepoint acc_s14_try');
    }
  }
  /** Run as service_role and return the rows; the role goes back to postgres afterwards (the writes stay for the rest of the test). */
  async function asService<T = Record<string, unknown>>(client: PgClient, sql: string, params: unknown[] = []): Promise<T[]> {
    await client.query('set local role service_role');
    try { return (await client.query(sql, params)).rows as T[]; } finally { await client.query('reset role'); }
  }
  const list = async (from: string, to: string, limit = 100, afterDate: string | null = null, afterSlip: string | null = null) =>
    (await asService<{ r: Page }>(db(), 'select public.list_year_end_shipments($1::date, $2::date, $3::integer, $4::date, $5::uuid) as r',
      [from, to, limit, afterDate, afterSlip]))[0].r;
  const check = async (actor: string, slipId: string, note: string | null, key = randomUUID()) =>
    (await asService<{ r: Mark }>(db(), 'select public.admin_check_year_end_shipment($1::uuid, $2::uuid, $3::text, $4::uuid) as r', [actor, slipId, note, key]))[0].r;
  const getOptions = async () => (await asService<{ r: Options }>(db(), 'select public.get_shipping_options() as r'))[0].r;
  const setOptions = async (actor: string, enabled: boolean, expected: number, key = randomUUID()) =>
    (await asService<{ r: Options }>(db(), 'select public.admin_set_shipping_options($1::uuid, $2::boolean, $3::bigint, $4::uuid) as r', [actor, enabled, expected, key]))[0].r;
  const gaps = async (from: string, to: string, limit = 100) =>
    (await asService<{ r: { enabled: boolean; slips: Array<Record<string, unknown>> } }>(db(),
      'select public.list_carrier_date_gaps($1::date, $2::date, $3::integer) as r', [from, to, limit]))[0].r;

  const slip = (date: string, input: { stage?: 'confirmed' | 'cancelled' | 'draft'; carrier?: 'yamato' | 'sagawa' | 'japanpost'; tracking?: string } = {}) =>
    seedGroupG3Slip(db(), { stage: input.stage ?? 'confirmed', shipmentDate: date, shippingCarrier: input.carrier, trackingNumber: input.tracking });
  /** A fulfillment of the slip (one order) with tracking events: [status, source, happened_at, tracking_version]. */
  async function track(slipId: string, events: ReadonlyArray<readonly [string, string, string, number?]>): Promise<void> {
    const order = await seedUnitOrder(db(), [[1000]]);
    const fulfillmentId = (await db().query(`insert into public.order_fulfillments
      (order_id, number, request_key, notify_customer, completes_order, shipped_at, created_by, legacy, shipment_date, delivery_status, delivery_status_at)
      values ($1, 1, gen_random_uuid(), false, false, now(), gen_random_uuid(), true, current_date, 'confirmed', now()) returning id`, [order.orderId])).rows[0].id as string;
    await db().query('insert into public.shipment_slip_fulfillments(slip_id, order_id, fulfillment_id) values($1, $2, $3)', [slipId, order.orderId, fulfillmentId]);
    for (const [status, source, at, version] of events) {
      await db().query(`insert into public.order_fulfillment_events(fulfillment_id, tracking_version, status, happened_at, source)
        values($1, $2, $3, $4::timestamptz, $5)`, [fulfillmentId, version ?? 1, status, at, source]);
    }
  }
  const numbersOf = async (page: Page) => page.slips.map((s) => s.number);
  const numberOf = async (slipId: string) => (await db().query('select number from public.shipment_slips where id = $1', [slipId])).rows[0].number as string;

  test('FREQ-574-AC-01: 12月25日から1月10日の発送票が運送会社・追跡番号・出荷した日つきで、出荷した日の順に出る', async () => {
    await slip('2097-12-24', { carrier: 'yamato', tracking: 'OUT-BEFORE' });
    const a = await slip('2097-12-31', { carrier: 'sagawa', tracking: 'SG-0002' });
    const b = await slip('2097-12-25', { carrier: 'yamato', tracking: 'YM-0001' });
    const c = await slip('2098-01-10', { stage: 'cancelled', carrier: 'japanpost', tracking: 'JP-0003' });
    const d = await slip('2097-12-31', { carrier: 'yamato', tracking: 'YM-0004' });
    await slip('2098-01-11', { carrier: 'yamato', tracking: 'OUT-AFTER' });
    await slip('2097-12-28', { stage: 'draft' });
    const page = await list('2097-12-25', '2098-01-10');
    // The day first, then the slip number (the two of 12-31 are in the order they were made).
    expect(page.slips.map((s) => s.slip_id)).toEqual([b, a, d, c]);
    expect(page.slips.map((s) => [s.shipment_date, s.stage, s.shipping_carrier, s.tracking_number])).toEqual([
      ['2097-12-25', 'confirmed', 'yamato', 'YM-0001'],
      ['2097-12-31', 'confirmed', 'sagawa', 'SG-0002'],
      ['2097-12-31', 'confirmed', 'yamato', 'YM-0004'],
      ['2098-01-10', 'cancelled', 'japanpost', 'JP-0003'],
    ]);
    const numbers = await numbersOf(page);
    expect(numbers[1] < numbers[2]).toBe(true);
    for (const row of page.slips) {
      expect(Object.keys(row).sort()).toEqual(['checked_at', 'checked_by', 'confirmed_at', 'number', 'shipment_date', 'shipping_carrier', 'slip_id', 'stage', 'tracking_number']);
      expect(row.confirmed_at).toEqual(expect.any(String));
      expect([row.checked_at, row.checked_by]).toEqual([null, null]);
    }
    // No customer data: not the name, the mail address or the address.
    expect(JSON.stringify(page)).not.toMatch(/Fixture|example\.invalid|0000000/);
    expect([page.next_after_date, page.next_after_slip]).toEqual([null, null]);
  });

  test('FREQ-574-AC-01: 続きの目印で最後まで読め、範囲の外の日の票は出ない', async () => {
    const inside: string[] = [];
    for (const date of ['2097-12-25', '2097-12-25', '2097-12-26', '2097-12-27', '2097-12-27']) inside.push(await slip(date, { carrier: 'yamato', tracking: 'T' + inside.length }));
    const before = await slip('2097-12-24');
    const after = await slip('2097-12-28');
    const seen: string[] = [];
    let cursor: { date: string | null; slip: string | null } = { date: null, slip: null };
    let pages = 0;
    do {
      const page: Page = await list('2097-12-25', '2097-12-27', 2, cursor.date, cursor.slip);
      seen.push(...page.slips.map((s) => s.slip_id));
      expect(page.slips.length).toBeLessThanOrEqual(2);
      cursor = { date: page.next_after_date, slip: page.next_after_slip };
      expect(cursor.date === null).toBe(cursor.slip === null);
      pages += 1;
    } while (cursor.slip !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(inside);
    expect(seen).not.toContain(before);
    expect(seen).not.toContain(after);
    // A page that ends exactly on the last slip has no cursor.
    expect((await list('2097-12-25', '2097-12-27', 5)).next_after_slip).toBeNull();
    expect((await list('2097-12-25', '2097-12-27', 4)).next_after_slip).not.toBeNull();
    // The mark of the cursor is checked: a slip that is not in the day, or an unknown one, is refused.
    expect((await attempt("select public.list_year_end_shipments('2097-12-25', '2097-12-27', 2, '2097-12-26', $1::uuid)", [inside[0]], 'service_role'))?.message)
      .toBe('ACCOUNTING_ARGUMENT_INVALID');
    expect((await attempt("select public.list_year_end_shipments('2097-12-25', '2097-12-27', 2, '2097-12-26', $1::uuid)", [randomUUID()], 'service_role'))?.message)
      .toBe('ACCOUNTING_ARGUMENT_INVALID');
  });

  test('FREQ-574-AC-01: 60日を超える範囲と200件を超える上限は断り、権限のない役割は呼べない', async () => {
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    const call = (from: string | null, to: string | null, limit: number | null, afterDate: string | null = null, afterSlip: string | null = null, role = 'service_role') =>
      attempt('select public.list_year_end_shipments($1::date, $2::date, $3::integer, $4::date, $5::uuid)', [from, to, limit, afterDate, afterSlip], role);
    // 60 days (both ends in) pass; 61 do not.
    expect(await call('2097-11-01', '2097-12-30', 100)).toBeNull();
    expect(await call('2097-11-01', '2097-12-31', 100)).toEqual(invalid);
    expect(await call('2097-12-31', '2097-12-30', 100)).toEqual(invalid);
    expect(await call('2097-12-25', '2097-12-25', 100)).toBeNull();
    expect(await call('2097-12-25', '2098-01-10', 200)).toBeNull();
    expect(await call('2097-12-25', '2098-01-10', 201)).toEqual(invalid);
    expect(await call('2097-12-25', '2098-01-10', 0)).toEqual(invalid);
    expect(await call('2097-12-25', '2098-01-10', null)).toEqual(invalid);
    expect(await call(null, '2098-01-10', 10)).toEqual(invalid);
    expect(await call('2097-12-25', null, 10)).toEqual(invalid);
    // The two halves of the cursor come together.
    expect(await call('2097-12-25', '2098-01-10', 10, '2097-12-26', null)).toEqual(invalid);
    expect(await call('2097-12-25', '2098-01-10', 10, null, randomUUID())).toEqual(invalid);
    for (const role of ['anon', 'authenticated']) {
      expect([role, (await call('2097-12-25', '2098-01-10', 10, null, null, role))?.code]).toEqual([role, '42501']);
    }
  });

  test('FREQ-574-AC-02: 確かめた印は人と時刻つきで入り、同じ票への2回目は二重に付かない', async () => {
    const admin = await insertAccountingAdmin(db());
    const other = await insertAccountingAdmin(db());
    const target = await slip('2097-12-26', { carrier: 'yamato', tracking: 'YM-1' });
    const cancelled = await slip('2097-12-27', { stage: 'cancelled', carrier: 'sagawa', tracking: 'SG-1' });
    const key = randomUUID();
    const first = await check(admin, target, 'seen in the year-end check', key);
    expect(first).toMatchObject({ slip_id: target, checked_by: admin, note: 'seen in the year-end check', created: true });
    expect(Date.parse(first.checked_at)).not.toBeNaN();
    // The list shows the mark (who and when) and nothing else changes.
    const marked = (await list('2097-12-25', '2097-12-28')).slips.find((s) => s.slip_id === target) as Slip;
    expect([marked.checked_by, Date.parse(marked.checked_at as string)]).toEqual([admin, Date.parse(first.checked_at)]);
    expect((await list('2097-12-25', '2097-12-28')).slips.find((s) => s.slip_id === cancelled)?.checked_at).toBeNull();
    // The second call (another key, another person, another note) returns the first mark as it is.
    const second = await check(other, target, 'again', randomUUID());
    expect(second).toEqual({ ...first, created: false });
    // The same key with the same content returns the same mark again.
    expect(await check(admin, target, 'seen in the year-end check', key)).toEqual({ ...first, created: false });
    expect(Number((await db().query(`select count(*) as n from ${CHECKS} where slip_id = $1`, [target])).rows[0].n)).toBe(1);
    // A cancelled slip can be checked too; an empty note is stored as no note.
    const third = await check(admin, cancelled, '   ');
    expect(third).toMatchObject({ slip_id: cancelled, note: null, created: true });
    // The same key with other content is a conflict, whichever part differs.
    const conflict = { code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' };
    const again = (actor: string, slipId: string, note: string | null) =>
      attempt('select public.admin_check_year_end_shipment($1::uuid, $2::uuid, $3::text, $4::uuid)', [actor, slipId, note, key], 'service_role');
    expect(await again(admin, cancelled, 'seen in the year-end check')).toEqual(conflict);
    expect(await again(admin, target, 'another note')).toEqual(conflict);
    expect(await again(other, target, 'seen in the year-end check')).toEqual(conflict);
  });

  test('FREQ-574-AC-02: 確かめる対象は確定または取り消し済みの票だけで、メモは200字まで', async () => {
    const admin = await insertAccountingAdmin(db());
    const draft = await slip('2097-12-26', { stage: 'draft' });
    const call = (slipId: string | null, note: string | null, key: string | null = randomUUID()) =>
      attempt('select public.admin_check_year_end_shipment($1::uuid, $2::uuid, $3::text, $4::uuid)', [admin, slipId, note, key], 'service_role');
    expect(await call(draft, 'x')).toEqual({ code: 'P0002', message: 'ACCOUNTING_NOT_FOUND' });
    expect(await call(randomUUID(), 'x')).toEqual({ code: 'P0002', message: 'ACCOUNTING_NOT_FOUND' });
    const target = await slip('2097-12-26');
    expect(await call(target, 'x'.repeat(200))).toBeNull();
    expect(await call(target, 'x'.repeat(201))).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    expect(await call(null, 'x')).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    expect(await call(target, 'x', null)).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
  });

  test('FREQ-574-AC-02: 確かめた印は権限なしを42501で断り、追記専用でUPDATEとDELETEとTRUNCATEを断る', async () => {
    const admin = await insertAccountingAdmin(db());
    const nobody = randomUUID();
    const target = await slip('2097-12-26');
    const call = (actor: string | null, role = 'service_role') =>
      attempt('select public.admin_check_year_end_shipment($1::uuid, $2::uuid, $3::text, $4::uuid)', [actor, target, 'x', randomUUID()], role);
    expect(await call(admin)).toBeNull();
    for (const actor of [nobody, null]) expect([actor, await call(actor)]).toEqual([actor, { code: '42501', message: 'ACCOUNTING_FORBIDDEN' }]);
    // The permission is checked before the shape of the other arguments.
    expect((await attempt('select public.admin_check_year_end_shipment($1::uuid, null, null, null)', [nobody], 'service_role'))?.code).toBe('42501');
    for (const role of ['anon', 'authenticated']) expect([role, (await call(admin, role))?.code]).toEqual([role, '42501']);
    await check(admin, target, 'mark');
    const immutable = { code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' };
    expect(await attempt(`update ${CHECKS} set note = 'changed'`)).toEqual(immutable);
    expect(await attempt(`update ${CHECKS} set checked_by = $1`, [nobody])).toEqual(immutable);
    expect(await attempt(`delete from ${CHECKS}`)).toEqual(immutable);
    expect(await attempt(`truncate ${CHECKS}`)).toEqual(immutable);
    // The slip that carries a mark cannot be deleted (RESTRICT), and a direct insert as service_role is refused.
    expect(await attempt('delete from public.shipment_slips where id = $1', [target])).not.toBeNull();
    expect((await attempt(`insert into ${CHECKS}(slip_id, checked_by, request_key, request_hash) values($1, $2, gen_random_uuid(), 'h')`, [target, admin], 'service_role'))?.code).toBe('42501');
    expect((await attempt(`select 1 from ${CHECKS}`, [], 'authenticated'))?.code).toBe('42501');
  });

  test('FREQ-574-AC-02: 確かめた印の表の形は、1枚の票に印は1つ・メモは200字まで・要求番号は1つだけ', async () => {
    const admin = await insertAccountingAdmin(db());
    const a = await slip('2097-12-26');
    const b = await slip('2097-12-26');
    const insert = (slipId: string, note: string | null, key: string) =>
      attempt(`insert into ${CHECKS}(slip_id, checked_by, note, request_key, request_hash) values($1, $2, $3, $4, 'h')`, [slipId, admin, note, key]);
    const key = randomUUID();
    // An attempt is rolled back, so the first mark is put in for real.
    await db().query(`insert into ${CHECKS}(slip_id, checked_by, note, request_key, request_hash) values($1, $2, 'ok', $3, 'h')`, [a, admin, key]);
    expect((await insert(a, 'ok', randomUUID()))?.code).toBe('23505');
    expect((await insert(b, 'x'.repeat(201), randomUUID()))?.code).toBe('23514');
    expect(await insert(b, 'x'.repeat(200), randomUUID())).toBeNull();
    expect(await insert(b, null, randomUUID())).toBeNull();
    // The request key is used by one mark only; a slip that is not there is refused (foreign key).
    expect((await insert(b, 'ok', key))?.code).toBe('23505');
    expect((await insert(randomUUID(), 'ok', randomUUID()))?.code).toBe('23503');
  });

  test('FREQ-574-AC-03: 設定の既定はオフで、切り替えると切り替えた日時と人が残り、版違いはVERSION_CONFLICT', async () => {
    const admin = await insertAccountingAdmin(db());
    expect(await getOptions()).toEqual({ carrier_date_check_enabled: false, changed_at: null, changed_by: null, version: '1' });
    const key = randomUUID();
    const on = await setOptions(admin, true, 1, key);
    expect(on).toMatchObject({ carrier_date_check_enabled: true, changed_by: admin, version: '2' });
    expect(Date.parse(on.changed_at as string)).not.toBeNaN();
    expect(await getOptions()).toEqual(on);
    // A stale version is refused and nothing changes; the right one goes through.
    const conflict = { code: '40001', message: 'ACCOUNTING_VERSION_CONFLICT' };
    const call = (enabled: boolean | null, expected: number | null, requestKey: string | null = randomUUID(), actor: string | null = admin) =>
      attempt('select public.admin_set_shipping_options($1::uuid, $2::boolean, $3::bigint, $4::uuid)', [actor, enabled, expected, requestKey], 'service_role');
    expect(await call(false, 1)).toEqual(conflict);
    expect(await call(false, 3)).toEqual(conflict);
    expect((await getOptions()).version).toBe('2');
    const off = await setOptions(admin, false, 2);
    expect(off).toMatchObject({ carrier_date_check_enabled: false, changed_by: admin, version: '3' });
    // The same request key with the same content returns the first answer and changes nothing; other content is a conflict.
    expect(await setOptions(admin, true, 1, key)).toEqual(on);
    expect((await getOptions()).version).toBe('3');
    expect(await call(false, 1, key)).toEqual({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
    expect(await call(true, 1, key, (await insertAccountingAdmin(db())))).toEqual({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
    // The shape of the arguments.
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    expect(await call(null, 3)).toEqual(invalid);
    expect(await call(true, null)).toEqual(invalid);
    expect(await call(true, 0)).toEqual(invalid);
    expect(await call(true, 3, null)).toEqual(invalid);
    // One row only, whatever happens.
    expect(Number((await db().query(`select count(*) as n from ${OPTIONS}`)).rows[0].n)).toBe(1);
  });

  test('FREQ-574-AC-03: 設定の切り替えは権限なしを42501で断り、表は1行だけで消せず、service_roleは読むだけ', async () => {
    const admin = await insertAccountingAdmin(db());
    const nobody = randomUUID();
    const call = (actor: string | null, role = 'service_role') =>
      attempt('select public.admin_set_shipping_options($1::uuid, true, 1, $2::uuid)', [actor, randomUUID()], role);
    expect(await call(admin)).toBeNull();
    for (const actor of [nobody, null]) expect([actor, await call(actor)]).toEqual([actor, { code: '42501', message: 'ACCOUNTING_FORBIDDEN' }]);
    for (const role of ['anon', 'authenticated']) {
      expect([role, (await call(admin, role))?.code]).toEqual([role, '42501']);
      expect([role, (await attempt('select public.get_shipping_options()', [], role))?.code]).toEqual([role, '42501']);
    }
    expect((await getOptions()).carrier_date_check_enabled).toBe(false);
    // The table: owner postgres, RLS on and no policy, service_role SELECT only, nothing for anon / authenticated.
    for (const table of [CHECKS, OPTIONS]) {
      const row = (await db().query(
        `select c.relkind, c.relowner::regrole::text as owner, c.relrowsecurity as rls, (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
         from pg_class c where c.oid = to_regclass($1)`, [table])).rows[0];
      expect([table, row]).toEqual([table, { relkind: 'r', owner: 'postgres', rls: true, policies: 0 }]);
      for (const role of ['anon', 'authenticated', 'service_role', 'public']) {
        for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', ...(role === 'service_role' ? [] : ['SELECT'])]) {
          expect([table, role, privilege, (await db().query('select has_table_privilege($1, $2, $3) as ok', [role, table, privilege])).rows[0].ok])
            .toEqual([table, role, privilege, false]);
        }
      }
      expect((await db().query('select has_table_privilege($1, $2, $3) as ok', ['service_role', table, 'SELECT'])).rows[0].ok).toBe(true);
    }
    expect((await attempt(`update ${OPTIONS} set carrier_date_check_enabled = true`, [], 'service_role'))?.code).toBe('42501');
    // The one row cannot be deleted or emptied, and no second row can be made.
    expect(await attempt(`delete from ${OPTIONS}`)).toEqual({ code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' });
    expect(await attempt(`truncate ${OPTIONS}`)).toEqual({ code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' });
    expect((await attempt(`insert into ${OPTIONS}(id) values (2)`))?.code).toBe('23514');
    expect((await attempt(`insert into ${OPTIONS}(id) values (1)`))?.code).toBe('23505');
  });

  test('FREQ-574-AC-04: オフの間は受付の日とのずれの一覧が空で、オンの時だけ1日以上ずれた票が出る', async () => {
    const admin = await insertAccountingAdmin(db());
    // Accepted a day after the day recorded; accepted on the same day; accepted two days before.
    const later = await slip('2097-12-26', { carrier: 'yamato', tracking: 'L1' });
    await track(later, [['in_transit', 'tracking', '2097-12-27T03:00:00Z']]);
    const same = await slip('2097-12-26', { carrier: 'yamato', tracking: 'S1' });
    await track(same, [['in_transit', 'tracking', '2097-12-26T02:00:00Z']]);
    const earlier = await slip('2097-12-30', { carrier: 'sagawa', tracking: 'E1' });
    await track(earlier, [['in_transit', 'tracking', '2097-12-28T03:00:00Z']]);
    // Off (the default): nothing, however big the gaps are.
    expect(await gaps('2097-12-25', '2098-01-10')).toEqual({ enabled: false, slips: [] });
    await setOptions(admin, true, 1);
    const on = await gaps('2097-12-25', '2098-01-10');
    expect(on.enabled).toBe(true);
    const numberLater = await numberOf(later);
    const numberEarlier = await numberOf(earlier);
    expect(on.slips).toEqual([
      { slip_id: later, number: numberLater, shipment_date: '2097-12-26', carrier_accepted_date: '2097-12-27', gap_days: 1 },
      { slip_id: earlier, number: numberEarlier, shipment_date: '2097-12-30', carrier_accepted_date: '2097-12-28', gap_days: -2 },
    ]);
    // Off again: empty again.
    await setOptions(admin, false, 2);
    expect(await gaps('2097-12-25', '2098-01-10')).toEqual({ enabled: false, slips: [] });
  });

  test('FREQ-574-AC-04: 受付の日は日本時間の日で、最初の在途だけを数え、追跡以外・別の版・別の状態の出来事は数えない', async () => {
    const admin = await insertAccountingAdmin(db());
    await setOptions(admin, true, 1);
    // 15:30 UTC on the 26th is 00:30 on the 27th in Japan: one day after the 26th (not zero).
    const edge = await slip('2097-12-26', { carrier: 'yamato', tracking: 'EDGE' });
    await track(edge, [['in_transit', 'tracking', '2097-12-26T15:30:00Z']]);
    // The first in-transit counts, not the later ones; the earlier events of other kinds do not count.
    const first = await slip('2097-12-26', { carrier: 'yamato', tracking: 'FIRST' });
    await track(first, [['delivered', 'tracking', '2097-12-20T03:00:00Z'], ['in_transit', 'tracking', '2097-12-29T03:00:00Z'],
      ['in_transit', 'tracking', '2097-12-27T03:00:00Z'], ['confirmed', 'shipment', '2097-12-21T03:00:00Z']]);
    // An event of another tracking version (an older tracking number) does not count.
    const otherVersion = await slip('2097-12-26', { carrier: 'yamato', tracking: 'VER' });
    await track(otherVersion, [['in_transit', 'tracking', '2097-12-31T03:00:00Z', 2]]);
    const shipmentSourceOnly = await slip('2097-12-26', { carrier: 'yamato', tracking: 'SRC' });
    await track(shipmentSourceOnly, [['in_transit', 'shipment', '2097-12-31T03:00:00Z']]);
    const result = await gaps('2097-12-25', '2098-01-10');
    expect(result.slips.map((s) => [s.slip_id, s.carrier_accepted_date, s.gap_days])).toEqual([
      [edge, '2097-12-27', 1],
      [first, '2097-12-27', 1],
    ]);
  });

  test('FREQ-574-AC-04: 追跡が動いていない票（受付の日が取れない票）と取り消した票と範囲の外の票はずれの一覧に出ない', async () => {
    const admin = await insertAccountingAdmin(db());
    await setOptions(admin, true, 1);
    const noEvents = await slip('2097-12-26', { carrier: 'yamato', tracking: 'NOEV' });
    await track(noEvents, []);
    await slip('2097-12-26', { carrier: 'yamato', tracking: 'NOFUL' });
    const cancelled = await slip('2097-12-26', { stage: 'cancelled', carrier: 'yamato', tracking: 'CANC' });
    await track(cancelled, [['in_transit', 'tracking', '2097-12-29T03:00:00Z']]);
    const outside = await slip('2098-01-20', { carrier: 'yamato', tracking: 'OUT' });
    await track(outside, [['in_transit', 'tracking', '2098-01-25T03:00:00Z']]);
    expect(await gaps('2097-12-25', '2098-01-10')).toEqual({ enabled: true, slips: [] });
    // The range and the limit are checked like the year-end list; the limit cuts the answer.
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    const call = (from: string, to: string, limit: number, role = 'service_role') =>
      attempt('select public.list_carrier_date_gaps($1::date, $2::date, $3::integer)', [from, to, limit], role);
    expect(await call('2097-11-01', '2097-12-31', 10)).toEqual(invalid);
    expect(await call('2097-12-25', '2098-01-10', 201)).toEqual(invalid);
    expect(await call('2097-12-25', '2098-01-10', 0)).toEqual(invalid);
    expect(await call('2098-01-10', '2097-12-25', 10)).toEqual(invalid);
    for (const role of ['anon', 'authenticated']) expect([role, (await call('2097-12-25', '2098-01-10', 10, role))?.code]).toEqual([role, '42501']);
    for (const day of ['2097-12-26', '2097-12-27', '2097-12-28']) {
      const target = await slip(day, { carrier: 'yamato', tracking: 'G' + day });
      await track(target, [['in_transit', 'tracking', '2098-01-02T03:00:00Z']]);
    }
    expect((await gaps('2097-12-25', '2098-01-10', 2)).slips).toHaveLength(2);
    expect((await gaps('2097-12-25', '2098-01-10', 200)).slips).toHaveLength(3);
  });

  test('FREQ-574-AC-04: 新しい関数は service_role だけが呼べる（private と public の両方）', async () => {
    for (const signature of FUNCTIONS) {
      const name = signature.replace(/^public\./, '').replace(/\(.*/, '');
      const rows = (await db().query(
        `select p.oid::regprocedure::text as signature,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role, has_function_privilege('public', p.oid, 'EXECUTE') as public,
           p.proowner::regrole::text as owner, p.prosecdef as definer
         from pg_proc p where p.proname = $1 and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) order by p.pronamespace::regnamespace::text desc`, [name])).rows;
      expect([name, rows.length]).toEqual([name, 2]);
      for (const entry of rows) {
        expect([entry.signature, entry.anon, entry.authenticated, entry.service_role, entry.public, entry.owner])
          .toEqual([entry.signature, false, false, true, false, 'postgres']);
      }
      expect(rows.map((r) => r.definer)).toEqual([false, true]);
    }
  });

  test('FREQ-574-AC-02: 年末の一覧と確かめた印は、G の表を書き換えない', async () => {
    const admin = await insertAccountingAdmin(db());
    const target = await slip('2097-12-26', { carrier: 'yamato', tracking: 'YM-1' });
    const before = (await db().query('select md5(s::text) as h from public.shipment_slips s where s.id = $1', [target])).rows[0].h;
    await list('2097-12-25', '2098-01-10');
    await check(admin, target, 'x');
    await gaps('2097-12-25', '2098-01-10');
    expect((await db().query('select md5(s::text) as h from public.shipment_slips s where s.id = $1', [target])).rows[0].h).toBe(before);
  });
});
