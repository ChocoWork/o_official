/** @jest-environment node */
import { randomBytes, randomUUID } from 'node:crypto';
import { LOCAL_DATABASE_URL, describeLocalDb, type PgClient } from './helpers/local-db';
import { amrCases } from '../../unit/helpers/staff-claims';
import { defaultStaffPasskeySettings } from '@/lib/auth/staff-passkey-defaults';

const { Client } = require('pg');

// Passkey stage 1a Task 8 (migration D): private.staff_passkey_amr_ok / staff_passkey_count_ok / staff_passkey_entry_ok.
// DB suite: needs the local Supabase (DATABASE_URL). Every case runs in a transaction that is rolled back.
// now() is frozen inside a transaction, so the 86400 / 86401 boundary is exact.
// The suite uses its own supabase_admin connection (local-only superuser) so that DISABLE TRIGGER on the GoTrue-owned table works.
describeLocalDb('passkey staff entry condition functions', () => {
  let admin: PgClient;
  const db = (): PgClient => admin;
  beforeAll(async () => {
    const url = new URL(LOCAL_DATABASE_URL as string);
    url.username = 'supabase_admin';
    admin = new Client({ connectionString: url.toString() }) as PgClient;
    await (admin as unknown as { connect: () => Promise<void> }).connect();
  });
  afterAll(async () => { await admin.end(); });
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  const nowEpoch = async (): Promise<number> =>
    Number((await db().query('select floor(extract(epoch from now()))::bigint as n')).rows[0].n);
  const amrOk = async (claims: unknown): Promise<boolean> =>
    (await db().query('select private.staff_passkey_amr_ok($1::jsonb) as ok', [JSON.stringify(claims)])).rows[0].ok;
  const entryOk = async (userId: string, claims: unknown): Promise<boolean> =>
    (await db().query('select private.staff_passkey_entry_ok($1::uuid, $2::jsonb) as ok', [userId, JSON.stringify(claims)])).rows[0].ok;
  const countOk = async (userId: string | null): Promise<boolean> =>
    (await db().query('select private.staff_passkey_count_ok($1::uuid) as ok', [userId])).rows[0].ok;

  async function user(): Promise<string> {
    const r = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [`passkey-entry-${randomUUID()}@example.com`],
    );
    return r.rows[0].id;
  }
  async function key(userId: string, approve = true): Promise<string> {
    const r = await db().query(
      `insert into auth.webauthn_credentials (user_id, credential_id, public_key, friendly_name)
       values ($1, $2, $3, 'k') returning id::text as id`,
      [userId, randomBytes(32), randomBytes(32)],
    );
    if (approve) await db().query('select public.passkey_approve($1,$2,$3)', [userId, r.rows[0].id, 'script']);
    return r.rows[0].id;
  }

  test('DATA-AUTH-016 条件1・2は TS と同じ値の表のとおりに判定する', async () => {
    const now = await nowEpoch();
    for (const c of amrCases(now)) {
      expect({ name: c.name, ok: await amrOk(c.dbClaims ?? c.claims) }).toEqual({ name: c.name, ok: c.amrOk });
    }
  });

  test('DATA-AUTH-016 claims が SQL の NULL でも例外を投げず偽を返す', async () => {
    const r = await db().query('select private.staff_passkey_amr_ok(null) as a, private.staff_passkey_entry_ok(null, null) as e');
    expect(r.rows[0]).toEqual({ a: false, e: false });
  });

  test('DATA-AUTH-016 条件3は認めた鍵が2本以上の時だけ真（0本・1本・2本）', async () => {
    const u = await user();
    expect(await countOk(u)).toBe(false);
    await key(u);
    expect(await countOk(u)).toBe(false);
    await key(u);
    expect(await countOk(u)).toBe(true);
    expect(await countOk(null)).toBe(false);
  });

  test('DATA-AUTH-016 認めていない鍵（GoTrue の直叩きで足した鍵）は数に入らない', async () => {
    const u = await user();
    await key(u);
    await key(u, false);
    expect(await countOk(u)).toBe(false);
  });

  test('DATA-AUTH-016 認めた鍵を auth.webauthn_credentials から消すと、その場で数が減って偽になる', async () => {
    const u = await user();
    await key(u);
    const second = await key(u);
    const now = await nowEpoch();
    const claims = { amr: [{ method: 'passkey', timestamp: now }], staff_passkeys_ok: true };
    expect(await entryOk(u, claims)).toBe(true);
    await db().query('delete from auth.webauthn_credentials where id = $1', [second]);
    expect(await entryOk(u, claims)).toBe(false);
    expect(await countOk(u)).toBe(false);
  });

  test('DATA-AUTH-016 引き金が働かなくても（認めの行が残っても）実在しない鍵は数えない', async () => {
    const u = await user();
    await key(u);
    const second = await key(u);
    await db().query('alter table auth.webauthn_credentials disable trigger passkey_credentials_notify');
    await db().query('delete from auth.webauthn_credentials where id = $1', [second]);
    expect((await db().query('select 1 from private.approved_passkeys where passkey_id = $1', [second])).rowCount).toBe(1);
    expect(await countOk(u)).toBe(false);
  });

  test('DATA-AUTH-016 JWT の印 staff_passkeys_ok が真でも、認めた鍵が1本なら偽', async () => {
    const u = await user();
    await key(u);
    const now = await nowEpoch();
    expect(await entryOk(u, { amr: [{ method: 'passkey', timestamp: now }], staff_passkeys_ok: true })).toBe(false);
  });

  test('DATA-AUTH-016 entry_ok は2つの両方が要る（鍵が2本でも amr が期限切れなら偽、amr が良くても鍵が足りなければ偽）', async () => {
    const u = await user();
    await key(u);
    await key(u);
    const now = await nowEpoch();
    expect(await entryOk(u, { amr: [{ method: 'passkey', timestamp: now }] })).toBe(true);
    expect(await entryOk(u, { amr: [{ method: 'passkey', timestamp: now - 86401 }] })).toBe(false);
    expect(await entryOk(u, { amr: [{ method: 'otp', timestamp: now }] })).toBe(false);
    expect(await entryOk(await user(), { amr: [{ method: 'passkey', timestamp: now }] })).toBe(false);
  });

  test('DATA-AUTH-016 設定の行は TS の初めの値（defaultStaffPasskeySettings）と同じ（API は TS の定数、DB は行を使うので、ずれると3か所の判定が割れる）', async () => {
    const d = defaultStaffPasskeySettings();
    const r = await db().query('select private.passkey_staff_settings() as s');
    expect(r.rows[0].s).toMatchObject({
      staff_max_session_seconds: d.staffMaxSessionSeconds,
      staff_idle_seconds: d.staffIdleSeconds,
      window_minutes: d.windowMinutes,
      min_approved_passkeys: d.minApprovedPasskeys,
      // defaultStaffPasskeySettings.rejectCustomerPassword is the column default (false); the real row is true after migration J
      reject_customer_password: true,
    });
    const column = await db().query(
      `select column_default from information_schema.columns
        where table_schema = 'private' and table_name = 'passkey_staff_config' and column_name = 'reject_customer_password'`,
    );
    expect(column.rows[0].column_default).toBe(String(d.rejectCustomerPassword));
  });

  test('DATA-AUTH-016 24時間と本数は設定の表から読む（表を変えると判定が変わる）', async () => {
    const u = await user();
    await key(u);
    const now = await nowEpoch();
    await db().query('update private.passkey_staff_config set min_approved_passkeys = 1, staff_max_session_seconds = 100 where id');
    expect(await countOk(u)).toBe(true);
    expect(await amrOk({ amr: [{ method: 'passkey', timestamp: now - 100 }] })).toBe(true);
    expect(await amrOk({ amr: [{ method: 'passkey', timestamp: now - 101 }] })).toBe(false);
  });

  test('DATA-AUTH-016 3つの関数は持ち主 postgres・SECURITY DEFINER・STABLE・search_path 空で、anon・authenticated・service_role は呼べない', async () => {
    const fns = ['private.staff_passkey_amr_ok(jsonb)', 'private.staff_passkey_count_ok(uuid)',
      'private.staff_passkey_entry_ok(uuid,jsonb)'];
    for (const f of fns) {
      const r = await db().query(
        `select p.prosecdef, p.provolatile, p.proowner::regrole::text as owner, p.proconfig,
                has_function_privilege('anon', $1, 'EXECUTE') as a,
                has_function_privilege('authenticated', $1, 'EXECUTE') as au,
                has_function_privilege('service_role', $1, 'EXECUTE') as s,
                has_function_privilege('public', $1, 'EXECUTE') as pub
           from pg_proc p where p.oid = $1::regprocedure`,
        [f],
      );
      const row = r.rows[0];
      expect({ f, secdef: row.prosecdef, vol: row.provolatile, owner: row.owner, cfg: row.proconfig }).toEqual(
        { f, secdef: true, vol: 's', owner: 'postgres', cfg: ['search_path=""'] });
      expect({ f, a: row.a, au: row.au, s: row.s, pub: row.pub }).toEqual({ f, a: false, au: false, s: false, pub: false });
    }
  });

  test('DATA-AUTH-016 authenticated・anon・service_role の役割では関数を直に呼べない', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db().query('savepoint s');
      await db().query(`set local role ${role}`);
      await expect(db().query('select private.staff_passkey_amr_ok(\'{}\'::jsonb)')).rejects.toThrow(/permission denied/);
      await db().query('rollback to savepoint s');
    }
  });
});
