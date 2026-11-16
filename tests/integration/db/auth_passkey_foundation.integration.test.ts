/** @jest-environment node */
import { randomBytes, randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

// Passkey stage 1a Task 4 (migration A): config row, four private tables, approval / window functions.
// DB suite: needs the local Supabase (DATABASE_URL). Every case runs in a transaction that is rolled back.
const TABLES = ['passkey_staff_config', 'approved_passkeys', 'passkey_registration_windows', 'passkey_notification_outbox'];
const PUBLIC_FUNCTIONS = [
  'public.passkey_approve(uuid,uuid,text)',
  'public.passkey_window_open(uuid,uuid)',
  'public.passkey_window_close(uuid)',
  'public.passkey_window_is_open(uuid,uuid)',
  'public.passkey_approved_count(uuid)',
];

describeLocalDb('passkey foundation tables and functions', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function user(): Promise<string> {
    const r = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [`passkey-foundation-${randomUUID()}@example.com`],
    );
    return r.rows[0].id;
  }
  async function session(userId: string): Promise<string> {
    const id = randomUUID();
    await db().query('insert into auth.sessions (id, user_id, created_at) values ($1, $2, now())', [id, userId]);
    return id;
  }
  async function key(userId: string): Promise<string> {
    const r = await db().query(
      `insert into auth.webauthn_credentials (user_id, credential_id, public_key)
       values ($1, $2, $3) returning id::text as id`,
      [userId, randomBytes(32), randomBytes(32)],
    );
    return r.rows[0].id;
  }
  async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
    await db().query('savepoint r');
    try {
      await db().query(`set local role ${role}`);
      return await run();
    } finally {
      await db().query('rollback to savepoint r');
    }
  }
  const count = async (userId: string): Promise<number> =>
    (await db().query('select public.passkey_approved_count($1) as n', [userId])).rows[0].n;

  test('DATA-AUTH-011 config has one row with the default values', async () => {
    const r = await db().query('select * from private.passkey_staff_config');
    expect(r.rows).toEqual([{
      id: true, staff_max_session_seconds: 86400, staff_idle_seconds: 3600, window_minutes: 30,
      min_approved_passkeys: 2, reject_customer_password: false,
    }]);
    await expect(db().query('insert into private.passkey_staff_config (id) values (false)')).rejects.toBeTruthy();
  });

  test('DATA-AUTH-011 settings function returns the row as jsonb and authenticated cannot call it', async () => {
    const r = await db().query('select private.passkey_staff_settings() as s');
    expect(r.rows[0].s).toEqual({
      staff_max_session_seconds: 86400, staff_idle_seconds: 3600, window_minutes: 30,
      min_approved_passkeys: 2, reject_customer_password: false,
    });
    const f = await db().query(
      `select has_function_privilege('authenticated','private.passkey_staff_settings()','EXECUTE') as a,
              has_function_privilege('anon','private.passkey_staff_settings()','EXECUTE') as n`,
    );
    expect(f.rows[0]).toEqual({ a: false, n: false });
  });

  test('DATA-AUTH-011 the four tables give anon and authenticated nothing and keep RLS on', async () => {
    for (const t of TABLES) {
      const r = await db().query(
        `select has_table_privilege('anon', $1, 'SELECT,INSERT,UPDATE,DELETE') as a,
                has_table_privilege('authenticated', $1, 'SELECT,INSERT,UPDATE,DELETE') as u,
                (select relrowsecurity from pg_class where oid = $1::regclass) as rls`,
        [`private.${t}`],
      );
      expect(r.rows[0]).toEqual({ a: false, u: false, rls: true });
    }
  });

  test('DATA-AUTH-012 public passkey functions: authenticated cannot execute, service_role can', async () => {
    for (const f of PUBLIC_FUNCTIONS) {
      const r = await db().query(
        `select has_function_privilege('authenticated', $1, 'EXECUTE') as u,
                has_function_privilege('anon', $1, 'EXECUTE') as a,
                has_function_privilege('service_role', $1, 'EXECUTE') as s`,
        [f],
      );
      expect(r.rows[0]).toEqual({ u: false, a: false, s: true });
    }
    const u = await user();
    await expect(asRole('authenticated', () => db().query('select public.passkey_approved_count($1)', [u]))).rejects.toMatchObject({ code: '42501' });
    await asRole('service_role', async () => { expect(await count(u)).toBe(0); });
  });

  test('DATA-AUTH-012 approve rejects another user key, takes the own key once and is idempotent', async () => {
    const owner = await user();
    const other = await user();
    const k = await key(owner);
    await db().query('savepoint a');
    await expect(db().query('select public.passkey_approve($1,$2,$3)', [other, k, 'script'])).rejects.toMatchObject({ code: '42501' });
    await db().query('rollback to savepoint a');
    await db().query('savepoint a');
    await expect(db().query('select public.passkey_approve($1,$2,$3)', [owner, randomUUID(), 'script'])).rejects.toMatchObject({ code: '42501' });
    await db().query('rollback to savepoint a');
    await db().query('select public.passkey_approve($1,$2,$3)', [owner, k, 'window']);
    await db().query('select public.passkey_approve($1,$2,$3)', [owner, k, 'window']);
    const rows = await db().query(
      `select ap.user_id::text as user_id, ap.approved_via, ap.credential_id = c.credential_id as same
         from private.approved_passkeys ap join auth.webauthn_credentials c on c.id = ap.passkey_id where ap.passkey_id = $1`,
      [k],
    );
    expect(rows.rows).toEqual([{ user_id: owner, approved_via: 'window', same: true }]);
    await db().query('savepoint b');
    await expect(db().query('select public.passkey_approve($1,$2,$3)', [owner, k, 'bogus'])).rejects.toBeTruthy();
    await db().query('rollback to savepoint b');
  });

  test('DATA-AUTH-012 window open keeps one open row per session and expires in 30 minutes', async () => {
    const u = await user();
    const s = await session(u);
    const first = await db().query(`select public.passkey_window_open($1,$2) = now() + interval '30 minutes' as ok`, [u, s]);
    expect(first.rows[0].ok).toBe(true);
    const second = await db().query('select public.passkey_window_open($1,$2) as e', [u, s]);
    expect(second.rows[0].e).toEqual(expect.any(Date));
    const rows = await db().query('select count(*)::int as n from private.passkey_registration_windows where session_id = $1', [s]);
    expect(rows.rows[0].n).toBe(1);
    const open = await db().query('select public.passkey_window_is_open($1,$2) as o', [u, s]);
    expect(open.rows[0].o).toBe(true);
  });

  test('DATA-AUTH-012 window open raises for a session of another user', async () => {
    const u = await user();
    const other = await user();
    const s = await session(other);
    await expect(db().query('select public.passkey_window_open($1,$2)', [u, s])).rejects.toMatchObject({ code: '42501' });
    await db().query('rollback');
    await db().query('begin');
  });

  test('DATA-AUTH-012 window is closed after close, after expiry and for a different user', async () => {
    const u = await user();
    const other = await user();
    const s = await session(u);
    await db().query('select public.passkey_window_open($1,$2)', [u, s]);
    const isOpen = async (who: string) => (await db().query('select public.passkey_window_is_open($1,$2) as o', [who, s])).rows[0].o;
    expect(await isOpen(other)).toBe(false);
    expect(await isOpen(u)).toBe(true);
    await db().query(`update private.passkey_registration_windows set expires_at = now() - interval '1 second' where session_id = $1`, [s]);
    expect(await isOpen(u)).toBe(false);
    // an expired open row is closed and replaced by a fresh one
    const again = await db().query(`select public.passkey_window_open($1,$2) = now() + interval '30 minutes' as ok`, [u, s]);
    expect(again.rows[0].ok).toBe(true);
    expect(await isOpen(u)).toBe(true);
    await db().query('select public.passkey_window_close($1)', [s]);
    expect(await isOpen(u)).toBe(false);
  });

  test('DATA-AUTH-012 approved count ignores keys that were never approved', async () => {
    const u = await user();
    const approved = await key(u);
    await key(u);
    expect(await count(u)).toBe(0);
    await db().query('select public.passkey_approve($1,$2,$3)', [u, approved, 'script']);
    expect(await count(u)).toBe(1);
  });

  test('DATA-AUTH-012 approved count ignores approvals whose key is gone or belongs to someone else', async () => {
    const u = await user();
    const other = await user();
    const k1 = await key(u);
    const k2 = await key(u);
    await db().query('select public.passkey_approve($1,$2,$3)', [u, k1, 'script']);
    await db().query('select public.passkey_approve($1,$2,$3)', [u, k2, 'script']);
    expect(await count(u)).toBe(2);
    // the key row vanishes while the approval row stays (trigger did not run)
    await db().query('delete from auth.webauthn_credentials where id = $1', [k1]);
    expect(await count(u)).toBe(1);
    // an approval row with no key at all
    await db().query(
      `insert into private.approved_passkeys (passkey_id, user_id, credential_id, approved_via) values ($1,$2,$3,'script')`,
      [randomUUID(), u, randomBytes(32)],
    );
    expect(await count(u)).toBe(1);
    // an approval row for u that points at another user's key
    const foreign = await key(other);
    await db().query(
      `insert into private.approved_passkeys (passkey_id, user_id, credential_id, approved_via)
       select id, $2, credential_id || '\\x00'::bytea, 'script' from auth.webauthn_credentials where id = $1`,
      [foreign, u],
    );
    expect(await count(u)).toBe(1);
    expect(await count(other)).toBe(0);
  });
});
