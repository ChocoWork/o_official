/** @jest-environment node */
import { randomBytes, randomUUID } from 'node:crypto';
import { describeLocalDb, LOCAL_DATABASE_URL, type PgClient } from './helpers/local-db';

// Passkey stage 1b Task 1 (migration F): functions the server endpoints use, and the stale-row / window-race hardening
// of public.passkey_approve. DB suite: needs the local Supabase (DATABASE_URL). Transactional cases roll back; the race
// case commits on purpose (two connections) and cleans up.
const { Client } = require('pg');

const FNS = [
  'public.passkey_is_staff(uuid)',
  'public.passkey_credential_is_approved(uuid,bytea)',
  'public.passkey_approved_ids(uuid)',
  'public.passkey_approve(uuid,uuid,text)',
];
const STALE_MSG = 'passkey_approve: stale approval for this passkey';
const FULL_MSG = 'passkey_approve: window limit reached';

// One superuser connection: the hook can only be run as supabase_auth_admin, which only this connection may become.
describeLocalDb('passkey server endpoint functions', () => {
  let admin: PgClient;
  const db = () => admin;
  const connect = async (user?: string): Promise<PgClient> => {
    const url = new URL(LOCAL_DATABASE_URL as string);
    if (user) url.username = user;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    return c as PgClient;
  };
  beforeAll(async () => { admin = await connect('supabase_admin'); });
  afterAll(async () => { await admin.end(); });
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function user(roleCode?: string, opts: { active?: boolean; expired?: boolean } = {}, c: PgClient = db()): Promise<string> {
    const r = await c.query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [`passkey-fns-${randomUUID()}@example.com`],
    );
    const id: string = r.rows[0].id;
    if (roleCode) {
      await c.query(
        `insert into public.user_roles (user_id, role_id, active, expires_at)
         select $1, r.id, $3, case when $4 then now() - interval '1 minute' else null end from public.roles r where r.code = $2`,
        [id, roleCode, opts.active ?? true, opts.expired ?? false],
      );
    }
    return id;
  }
  async function key(userId: string, c: PgClient = db(), cred: Buffer = randomBytes(32)): Promise<{ id: string; cred: Buffer }> {
    const r = await c.query(
      `insert into auth.webauthn_credentials (user_id, credential_id, public_key)
       values ($1, $2, $3) returning id::text as id`,
      [userId, cred, randomBytes(32)],
    );
    return { id: r.rows[0].id, cred };
  }
  const approve = (userId: string, passkeyId: string, via: string, c: PgClient = db()) =>
    c.query('select public.passkey_approve($1,$2,$3)', [userId, passkeyId, via]);
  const isApproved = async (userId: string | null, cred: Buffer | null): Promise<boolean> =>
    (await db().query('select public.passkey_credential_is_approved($1,$2) as r', [userId, cred])).rows[0].r;
  async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
    await db().query('savepoint r');
    try {
      await db().query(`set local role ${role}`);
      return await run();
    } finally {
      await db().query('rollback to savepoint r');
    }
  }
  async function hookRejects(userId: string): Promise<boolean> {
    await db().query('savepoint h');
    try {
      await db().query('set local role supabase_auth_admin');
      // 'password' for a customer returns the event itself (reject_customer_password is false); for staff it is rejected.
      const r = await db().query('select public.passkey_access_token_hook($1::jsonb) as r', [
        JSON.stringify({ user_id: userId, authentication_method: 'password', claims: {} }),
      ]);
      return r.rows[0].r?.error?.http_code === 403;
    } finally {
      await db().query('rollback to savepoint h');
    }
  }

  describe('SEC-AUTH-041 passkey_is_staff', () => {
    const cases: Array<[string, string | undefined, { active?: boolean; expired?: boolean }, boolean]> = [
      ['admin active', 'admin', {}, true],
      ['supporter active', 'supporter', {}, true],
      ['admin expired', 'admin', { expired: true }, false],
      ['admin inactive', 'admin', { active: false }, false],
      ['customer role', 'user', {}, false],
      ['no role row', undefined, {}, false],
    ];
    test.each(cases)('DATA-AUTH-018 %s', async (_name, role, opts, expected) => {
      const u = await user(role, opts);
      expect((await db().query('select public.passkey_is_staff($1) as r', [u])).rows[0].r).toBe(expected);
    });

    test('DATA-AUTH-018 unknown user and null are false and do not throw', async () => {
      expect((await db().query('select public.passkey_is_staff($1) as r', [randomUUID()])).rows[0].r).toBe(false);
      expect((await db().query('select public.passkey_is_staff(null) as r')).rows[0].r).toBe(false);
    });

    test('DATA-AUTH-018 a DB error inside passkey_is_staff is not answered as false (fail closed)', async () => {
      const u = await user('admin');
      await db().query('savepoint e');
      try {
        await db().query('alter table public.user_roles rename to user_roles_renamed_by_test');
        await expect(db().query('select public.passkey_is_staff($1) as r', [u])).rejects.toMatchObject({ code: '42P01' });
      } finally {
        await db().query('rollback to savepoint e');
      }
    });

    test('DATA-AUTH-018 the answer always matches the access token hook staff decision', async () => {
      for (const [, role, opts] of cases) {
        const u = await user(role, opts);
        const staff = (await db().query('select public.passkey_is_staff($1) as r', [u])).rows[0].r;
        expect(await hookRejects(u)).toBe(staff);
      }
    });
  });

  describe('SEC-AUTH-041 passkey_credential_is_approved', () => {
    test('DATA-AUTH-018 true only for an approved key of that user with that credential id', async () => {
      const u = await user('admin');
      const k = await key(u);
      expect(await isApproved(u, k.cred)).toBe(false);
      await approve(u, k.id, 'script');
      expect(await isApproved(u, k.cred)).toBe(true);
    });

    test('DATA-AUTH-018 false for an unapproved key, another user, another credential id, null and empty', async () => {
      const u = await user('admin');
      const other = await user('admin');
      const approved = await key(u);
      const unapproved = await key(u);
      await approve(u, approved.id, 'script');
      expect(await isApproved(u, unapproved.cred)).toBe(false);
      expect(await isApproved(other, approved.cred)).toBe(false);
      expect(await isApproved(u, randomBytes(32))).toBe(false);
      expect(await isApproved(u, null)).toBe(false);
      expect(await isApproved(null, approved.cred)).toBe(false);
      expect(await isApproved(u, Buffer.alloc(0))).toBe(false);
    });

    test('DATA-AUTH-018 false when the approval row credential id was rewritten', async () => {
      const u = await user('admin');
      const k = await key(u);
      await db().query(
        `insert into private.approved_passkeys (passkey_id, user_id, credential_id, approved_via) values ($1,$2,$3,'script')`,
        [k.id, u, Buffer.concat([k.cred, Buffer.from([0])])],
      );
      expect(await isApproved(u, k.cred)).toBe(false);
      expect(await isApproved(u, Buffer.concat([k.cred, Buffer.from([0])]))).toBe(false);
    });
  });

  test('DATA-AUTH-018 passkey_approved_ids lists approved keys only and shrinks when a key is deleted', async () => {
    const u = await user('admin');
    const a = await key(u);
    const b = await key(u);
    await key(u);
    expect((await db().query('select public.passkey_approved_ids($1) as r', [u])).rows[0].r).toEqual([]);
    await approve(u, a.id, 'script');
    await approve(u, b.id, 'script');
    const ids = (await db().query('select public.passkey_approved_ids($1) as r', [u])).rows[0].r as string[];
    expect([...ids].sort()).toEqual([a.id, b.id].sort());
    await db().query('delete from auth.webauthn_credentials where id = $1', [a.id]);
    expect((await db().query('select public.passkey_approved_ids($1) as r', [u])).rows[0].r).toEqual([b.id]);
  });

  describe('SEC-AUTH-041 passkey_approve', () => {
    test('DATA-AUTH-018 approving the same key twice leaves one row; another user key is refused', async () => {
      const u = await user('admin');
      const other = await user('admin');
      const k = await key(u);
      await approve(u, k.id, 'window');
      await approve(u, k.id, 'window');
      expect((await db().query('select count(*)::int as n from private.approved_passkeys where passkey_id = $1', [k.id])).rows[0].n).toBe(1);
      await db().query('savepoint s');
      await expect(approve(other, k.id, 'script')).rejects.toMatchObject({ code: '42501' });
      await db().query('rollback to savepoint s');
    });

    test('DATA-AUTH-018 a stale row (same passkey id, other credential id) raises 23505 instead of passing silently', async () => {
      const u = await user('admin');
      const k = await key(u);
      await db().query(
        `insert into private.approved_passkeys (passkey_id, user_id, credential_id, approved_via) values ($1,$2,$3,'script')`,
        [k.id, u, randomBytes(32)],
      );
      await expect(approve(u, k.id, 'window')).rejects.toMatchObject({ code: '23505', message: STALE_MSG });
    });

    test('DATA-AUTH-018 a row with the same credential id is still a quiet no-op', async () => {
      const u = await user('admin');
      const k = await key(u);
      await approve(u, k.id, 'script');
      await expect(approve(u, k.id, 'reauth')).resolves.toBeTruthy();
      expect((await db().query('select approved_via from private.approved_passkeys where passkey_id = $1', [k.id])).rows[0].approved_via).toBe('script');
    });

    test('DATA-AUTH-018 a credential id approved under another passkey id is still refused with 23505', async () => {
      const u = await user('admin');
      const k = await key(u);
      await db().query(
        `insert into private.approved_passkeys (passkey_id, user_id, credential_id, approved_via) values ($1,$2,$3,'script')`,
        [randomUUID(), u, k.cred],
      );
      await expect(approve(u, k.id, 'script')).rejects.toMatchObject({ code: '23505' });
    });

    test('DATA-AUTH-018 window approval stops at 55000 once two keys are approved; reauth and script still pass', async () => {
      const u = await user('admin');
      const k1 = await key(u);
      const k2 = await key(u);
      const k3 = await key(u);
      const k4 = await key(u);
      const k5 = await key(u);
      await approve(u, k1.id, 'window');
      await approve(u, k2.id, 'window');
      await db().query('savepoint s');
      await expect(approve(u, k3.id, 'window')).rejects.toMatchObject({ code: '55000', message: FULL_MSG });
      await db().query('rollback to savepoint s');
      expect((await db().query('select count(*)::int as n from private.approved_passkeys where passkey_id = $1', [k3.id])).rows[0].n).toBe(0);
      await approve(u, k4.id, 'reauth');
      await approve(u, k5.id, 'script');
      expect((await db().query('select public.passkey_approved_count($1) as n', [u])).rows[0].n).toBe(4);
      // already approved key: no new row, so the limit does not turn an idempotent repeat into an error
      await expect(approve(u, k1.id, 'window')).resolves.toBeTruthy();
    });
  });

  test('DATA-AUTH-018 window approval is refused (55000) when the settings give no minimum (fail closed)', async () => {
    const u = await user('admin');
    const k = await key(u);
    await db().query(
      `create or replace function private.passkey_staff_settings() returns jsonb language sql stable as $$ select '{}'::jsonb $$`,
    );
    await db().query('savepoint m');
    await expect(approve(u, k.id, 'window')).rejects.toMatchObject({ code: '55000', message: FULL_MSG });
    await db().query('rollback to savepoint m');
    expect((await db().query('select count(*)::int as n from private.approved_passkeys where passkey_id = $1', [k.id])).rows[0].n).toBe(0);
  });

  test('DATA-AUTH-018 two connections approving different new keys by window at once end with exactly two approved keys', async () => {
    const a = await connect();
    const b = await connect();
    const setup = await connect();
    const made: string[] = [];
    try {
      for (let i = 0; i < 20; i += 1) {
        const u = await user('admin', {}, setup);
        made.push(u);
        await key(u, setup).then((k) => approve(u, k.id, 'script', setup)); // one approved key already
        const ka = await key(u, setup);
        const kb = await key(u, setup);
        const results = await Promise.allSettled([approve(u, ka.id, 'window', a), approve(u, kb.id, 'window', b)]);
        const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        expect(failed).toHaveLength(1);
        expect(failed[0].reason.code).toBe('55000');
        expect((await setup.query('select public.passkey_approved_count($1) as n', [u])).rows[0].n).toBe(2);
      }
    } finally {
      for (const u of made) {
        await setup.query('delete from auth.webauthn_credentials where user_id = $1', [u]);
        await setup.query('delete from private.approved_passkeys where user_id = $1', [u]);
        await setup.query('delete from private.passkey_notification_outbox where user_id = $1', [u]);
        await setup.query('delete from public.user_roles where user_id = $1', [u]);
        await setup.query('delete from auth.users where id = $1', [u]);
      }
      await a.end();
      await b.end();
      await setup.end();
    }
  }, 60000);

  describe('SEC-AUTH-041 grants and attributes', () => {
    test('DATA-AUTH-018 anon and authenticated cannot call the four functions; service_role can', async () => {
      for (const f of FNS) {
        const r = await db().query(
          `select has_function_privilege('anon', $1, 'EXECUTE') as a, has_function_privilege('authenticated', $1, 'EXECUTE') as u,
                  has_function_privilege('service_role', $1, 'EXECUTE') as s, has_function_privilege('public', $1, 'EXECUTE') as p`,
          [f],
        );
        expect(r.rows[0]).toEqual({ a: false, u: false, s: true, p: false });
      }
      const u = await user('admin');
      for (const role of ['anon', 'authenticated']) {
        await expect(asRole(role, () => db().query('select public.passkey_is_staff($1)', [u]))).rejects.toMatchObject({ code: '42501' });
      }
      await expect(asRole('service_role', () => db().query('select public.passkey_is_staff($1) as r', [u]))).resolves.toBeTruthy();
    });

    test('DATA-AUTH-018 the four functions are security definer, owned by postgres, with an empty search_path', async () => {
      for (const f of FNS) {
        const r = await db().query(
          `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, coalesce(p.proconfig @> array['search_path=""'], false) as sp
             from pg_proc p where p.oid = $1::regprocedure`,
          [f],
        );
        expect(r.rows[0]).toEqual({ prosecdef: true, owner: 'postgres', sp: true });
      }
    });
  });
});
