/** @jest-environment node */
import { randomBytes, randomUUID } from 'node:crypto';
import { LOCAL_DATABASE_URL, describeLocalDb, type PgClient } from './helpers/local-db';

const { Client } = require('pg');

// Passkey stage 1a Task 5 (migration B): public.passkey_access_token_hook(event jsonb).
// DB suite: needs the local Supabase (DATABASE_URL). Every case runs in a transaction that is rolled back.
// The hook is always called as supabase_auth_admin (the role GoTrue uses), never as the owner.
const HOOK = 'public.passkey_access_token_hook(jsonb)';
const MARKER = '[staff-passkey-required]';

// The shared test user (postgres) is not a member of supabase_auth_admin and cannot become one, so this suite opens its
// own connection as supabase_admin (a local-only superuser) and switches to supabase_auth_admin with SET LOCAL ROLE.
describeLocalDb('passkey access token hook function', () => {
  let admin: PgClient;
  const db = () => admin;
  beforeAll(async () => {
    const url = new URL(LOCAL_DATABASE_URL as string);
    url.username = 'supabase_admin';
    admin = new Client({ connectionString: url.toString() }) as PgClient;
    await (admin as unknown as { connect: () => Promise<void> }).connect();
  });
  afterAll(async () => { await admin.end(); });
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function user(roleCode?: string, opts: { active?: boolean; expired?: boolean } = {}): Promise<string> {
    const r = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [`passkey-hook-${randomUUID()}@example.com`],
    );
    const id: string = r.rows[0].id;
    if (roleCode) {
      await db().query(
        `insert into public.user_roles (user_id, role_id, active, expires_at)
         select $1, r.id, $3, case when $4 then now() - interval '1 minute' else null end from public.roles r where r.code = $2`,
        [id, roleCode, opts.active ?? true, opts.expired ?? false],
      );
    }
    return id;
  }
  async function approvedKeys(userId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const k = await db().query(
        `insert into auth.webauthn_credentials (user_id, credential_id, public_key)
         values ($1, $2, $3) returning id::text as id`,
        [userId, randomBytes(32), randomBytes(32)],
      );
      await db().query('select public.passkey_approve($1,$2,$3)', [userId, k.rows[0].id, 'script']);
    }
  }
  async function session(userId: string): Promise<string> {
    const id = randomUUID();
    await db().query('insert into auth.sessions (id, user_id, created_at) values ($1, $2, now())', [id, userId]);
    return id;
  }
  const nowEpoch = async (): Promise<number> =>
    Number((await db().query('select floor(extract(epoch from now()))::bigint as n')).rows[0].n);

  async function hook(event: unknown): Promise<any> {
    await db().query('savepoint h');
    try {
      await db().query('set local role supabase_auth_admin');
      const r = await db().query('select public.passkey_access_token_hook($1::jsonb) as r', [JSON.stringify(event)]);
      return r.rows[0].r;
    } finally {
      await db().query('rollback to savepoint h');
    }
  }
  const ev = (userId: string, method: string, claims: Record<string, unknown> | undefined) => ({
    user_id: userId,
    authentication_method: method,
    ...(claims === undefined ? {} : { claims }),
  });
  const passkeyAmr = (ts: unknown) => [{ method: 'passkey', timestamp: ts }];
  const CUSTOMER_MARKER = '[customer-password-disabled]';
  const isCustomerReject = (r: any) => {
    expect(r?.error?.http_code).toBe(403);
    expect(String(r.error.message).startsWith(CUSTOMER_MARKER)).toBe(true);
    expect(String(r.error.message)).not.toContain(MARKER);
  };
  const isReject = (r: any) => {
    expect(r?.error?.http_code).toBe(403);
    expect(String(r.error.message).startsWith(MARKER)).toBe(true);
  };

  describe('staff with a passkey or a refresh', () => {
    test.each(['passkey', 'token_refresh'])('DATA-AUTH-013 %s with a fresh passkey amr passes and gets staff_passkeys_ok', async (method) => {
      const u = await user('admin');
      await approvedKeys(u, 2);
      const claims = { aal: 'aal1', amr: passkeyAmr((await nowEpoch()) - 10), session_id: randomUUID() };
      const out = await hook(ev(u, method, claims));
      expect(out.claims.staff_passkeys_ok).toBe(true);
      expect(out.claims.amr).toEqual(claims.amr);
      expect(out.error).toBeUndefined();
    });

    test('DATA-AUTH-013 a supporter passes as well', async () => {
      const u = await user('supporter');
      const out = await hook(ev(u, 'passkey', { amr: passkeyAmr(await nowEpoch()) }));
      expect(out.claims.staff_passkeys_ok).toBe(false);
    });

    test('DATA-AUTH-013 exactly 86400 seconds passes, 86401 is rejected, a future timestamp is rejected', async () => {
      const u = await user('admin');
      const n = await nowEpoch();
      expect((await hook(ev(u, 'passkey', { amr: passkeyAmr(n - 86400) }))).claims).toBeDefined();
      isReject(await hook(ev(u, 'passkey', { amr: passkeyAmr(n - 86401) })));
      isReject(await hook(ev(u, 'passkey', { amr: passkeyAmr(n + 5) })));
      isReject(await hook(ev(u, 'token_refresh', { amr: passkeyAmr(n - 90000) })));
    });

    test('DATA-AUTH-013 a timestamp that is a string, missing, null, negative, fractional or not a number is rejected', async () => {
      const u = await user('admin');
      const n = await nowEpoch();
      for (const ts of [String(n), '', null, -5, n - 0.5, { a: 1 }, [n], true]) {
        isReject(await hook(ev(u, 'passkey', { amr: passkeyAmr(ts) })));
      }
      isReject(await hook(ev(u, 'passkey', { amr: [{ method: 'passkey' }] })));
      isReject(await hook(ev(u, 'passkey', { amr: [{ method: 'otp', timestamp: n }] })));
    });

    test('DATA-AUTH-013 staff_passkeys_ok is true with 2 approved keys and false with 1 or 0', async () => {
      for (const [keys, expected] of [[2, true], [1, false], [0, false]] as const) {
        const u = await user('admin');
        await approvedKeys(u, keys);
        const out = await hook(ev(u, 'passkey', { amr: passkeyAmr(await nowEpoch()) }));
        expect(out.claims.staff_passkeys_ok).toBe(expected);
      }
    });

    test('DATA-AUTH-013 a key removed straight in auth stops counting at once (same count as passkey_approved_count)', async () => {
      const u = await user('admin');
      await approvedKeys(u, 2);
      await db().query(
        'delete from auth.webauthn_credentials where id = (select id from auth.webauthn_credentials where user_id = $1 limit 1)',
        [u],
      );
      const count = (await db().query('select public.passkey_approved_count($1) as n', [u])).rows[0].n;
      expect(count).toBe(1);
      const out = await hook(ev(u, 'passkey', { amr: passkeyAmr(await nowEpoch()) }));
      expect(out.claims.staff_passkeys_ok).toBe(false);
    });
  });

  describe('staff with another method or a registration window', () => {
    test.each(['otp', 'oauth', 'password', 'sso/saml', 'mfa/totp', ''])('DATA-AUTH-013 %p without a window is rejected for staff', async (method) => {
      const u = await user('admin');
      isReject(await hook(ev(u, method, { amr: passkeyAmr(await nowEpoch()), session_id: randomUUID() })));
    });

    test('DATA-AUTH-013 a missing or null authentication_method is rejected for staff', async () => {
      const u = await user('admin');
      isReject(await hook({ user_id: u, claims: { amr: passkeyAmr(await nowEpoch()) } }));
      isReject(await hook({ user_id: u, authentication_method: null, claims: {} }));
    });

    test('DATA-AUTH-013 an otp session with an open window for the same session and user passes without staff_passkeys_ok', async () => {
      const u = await user('admin');
      const s = await session(u);
      await db().query('select public.passkey_window_open($1,$2)', [u, s]);
      const out = await hook(ev(u, 'otp', { amr: [{ method: 'otp', timestamp: await nowEpoch() }], session_id: s }));
      expect(out.error).toBeUndefined();
      expect(out.claims.staff_passkeys_ok).toBe(false);
      const refreshed = await hook(ev(u, 'token_refresh', { amr: [{ method: 'otp', timestamp: 1 }], session_id: s }));
      expect(refreshed.claims.staff_passkeys_ok).toBe(false);
    });

    // Reads the window rows INSIDE the savepoint, before the rollback, so a row the hook inserted or changed is seen.
    async function hookAndWindows(event: unknown, userId: string): Promise<{ out: any; windows: any[] }> {
      await db().query('savepoint hw');
      try {
        await db().query('set local role supabase_auth_admin');
        const r = await db().query('select public.passkey_access_token_hook($1::jsonb) as r', [JSON.stringify(event)]);
        await db().query('reset role');
        const w = await db().query(
          'select * from private.passkey_registration_windows where user_id = $1 order by id', [userId]);
        return { out: r.rows[0].r, windows: w.rows };
      } finally {
        await db().query('rollback to savepoint hw');
      }
    }

    test('DATA-AUTH-013 the hook does not write the window table (rows read inside the savepoint)', async () => {
      const u = await user('admin');
      const s = await session(u);
      const noWindow = await session(u);
      await db().query('select public.passkey_window_open($1,$2)', [u, s]);
      const before = (await db().query('select * from private.passkey_registration_windows where user_id = $1 order by id', [u])).rows;
      expect(before).toHaveLength(1);
      const passed = await hookAndWindows(ev(u, 'otp', { amr: [], session_id: s }), u);
      expect(passed.out.error).toBeUndefined();
      expect(passed.windows).toEqual(before);
      const rejected = await hookAndWindows(ev(u, 'otp', { amr: [], session_id: noWindow }), u);
      isReject(rejected.out);
      expect(rejected.windows).toEqual(before);
    });

    test('DATA-AUTH-013 the window probe sees a write (a hook that inserted a window would fail the test above)', async () => {
      const u = await user('admin');
      const s = await session(u);
      await db().query(
        `create or replace function public.passkey_access_token_hook(event jsonb) returns jsonb language plpgsql security definer set search_path = ''
         as $$ begin insert into private.passkey_registration_windows (user_id, session_id, expires_at)
           values ((event->>'user_id')::uuid, (event->'claims'->>'session_id')::uuid, now() + interval '1 minute'); return event; end $$`,
      );
      const r = await hookAndWindows(ev(u, 'otp', { amr: [], session_id: s }), u);
      expect(r.windows).toHaveLength(1);
    });

    test('DATA-AUTH-013 a closed window, an expired window, another session and another user window are rejected', async () => {
      const u = await user('admin');
      const other = await user('admin');
      const s = await session(u);
      const closed = await session(u);
      const expired = await session(u);
      const otherSession = await session(other);
      await db().query('select public.passkey_window_open($1,$2)', [u, s]);
      await db().query('select public.passkey_window_open($1,$2)', [other, otherSession]);
      await db().query('select public.passkey_window_open($1,$2)', [u, closed]);
      await db().query('select public.passkey_window_close($1)', [closed]);
      await db().query(
        `insert into private.passkey_registration_windows (user_id, session_id, opened_at, expires_at)
         values ($1, $2, now() - interval '1 hour', now() - interval '30 minutes')`,
        [u, expired],
      );
      const claims = (sid: unknown) => ({ amr: [{ method: 'otp', timestamp: 1 }], session_id: sid });
      isReject(await hook(ev(u, 'otp', claims(closed))));
      isReject(await hook(ev(u, 'otp', claims(expired))));
      isReject(await hook(ev(u, 'otp', claims(randomUUID()))));
      isReject(await hook(ev(u, 'otp', claims(otherSession))));
      isReject(await hook(ev(other, 'otp', claims(s))));
      isReject(await hook(ev(u, 'otp', { amr: [] })));
      isReject(await hook(ev(u, 'otp', claims('not-a-uuid'))));
      isReject(await hook(ev(u, 'otp', claims(5))));
    });

    test('DATA-AUTH-013 a window does not let oauth, password or an unknown method through', async () => {
      const u = await user('admin');
      const s = await session(u);
      await db().query('select public.passkey_window_open($1,$2)', [u, s]);
      for (const m of ['oauth', 'password', 'something_new']) {
        isReject(await hook(ev(u, m, { amr: [], session_id: s })));
      }
    });
  });

  describe('the count is only a hint', () => {
    test('DATA-AUTH-013 when counting approved passkeys raises, a fresh passkey still passes with staff_passkeys_ok false', async () => {
      const u = await user('admin');
      await approvedKeys(u, 2);
      await db().query(
        `create or replace function public.passkey_approved_count(p_user_id uuid) returns integer language plpgsql
         as $$ begin raise exception 'forced count failure'; end $$`,
      );
      const out = await hook(ev(u, 'passkey', { amr: passkeyAmr(await nowEpoch()) }));
      expect(out.error).toBeUndefined();
      expect(out.claims.staff_passkeys_ok).toBe(false);
    });
  });

  describe('who counts as staff', () => {
    test('DATA-AUTH-013 an inactive, expired or role-less user is not staff', async () => {
      const notActive = await user('admin', { active: false });
      const expired = await user('admin', { expired: true });
      const plain = await user();
      for (const u of [notActive, expired, plain]) {
        const input = ev(u, 'otp', { amr: [{ method: 'otp', timestamp: 1 }] });
        expect(await hook(input)).toEqual(input);
      }
    });
  });

  describe('customers', () => {
    test.each(['passkey', 'otp', 'token_refresh', 'oauth'])('DATA-AUTH-013 a customer with %s gets the event back unchanged', async (method) => {
      const u = await user();
      const input = ev(u, method, { aal: 'aal1', amr: [{ method, timestamp: 1 }], session_id: randomUUID() });
      expect(await hook(input)).toEqual(input);
    });

    test('DATA-AUTH-013 a customer password login passes while the flag is false and is rejected when the flag is true', async () => {
      const u = await user();
      const input = ev(u, 'password', { aal: 'aal1', amr: [{ method: 'password', timestamp: 1 }] });
      expect(await hook(input)).toEqual(input);
      await db().query('update private.passkey_staff_config set reject_customer_password = true');
      isCustomerReject(await hook(input));
      const otp = ev(u, 'otp', { amr: [] });
      expect(await hook(otp)).toEqual(otp);
    });

    test('DATA-AUTH-013 the reject_customer_password flag does not change the staff result', async () => {
      await db().query('update private.passkey_staff_config set reject_customer_password = true');
      const u = await user('admin');
      expect((await hook(ev(u, 'passkey', { amr: passkeyAmr(await nowEpoch()) }))).claims).toBeDefined();
      isReject(await hook(ev(u, 'password', { amr: [] })));
    });
  });

  describe('broken input never throws and staff never pass by accident', () => {
    test('DATA-AUTH-013 claims missing, null, a string, an array or a number: staff rejected, customer unchanged', async () => {
      const staff = await user('admin');
      const customer = await user();
      for (const claims of [undefined, null, 'x', [], 5] as const) {
        const broken = (u: string, m: string) => ({
          user_id: u, authentication_method: m, ...(claims === undefined ? {} : { claims }),
        });
        isReject(await hook(broken(staff, 'passkey')));
        isReject(await hook(broken(staff, 'otp')));
        const c = broken(customer, 'passkey');
        expect(await hook(c)).toEqual(c);
      }
    });

    test('DATA-AUTH-013 amr null, an object, a string, a number or an array of junk: staff rejected', async () => {
      const staff = await user('admin');
      const n = await nowEpoch();
      for (const amr of [null, {}, { method: 'passkey', timestamp: n }, 'passkey', 5, [null, 5, 'passkey', [], { method: 5 }]]) {
        isReject(await hook(ev(staff, 'passkey', { amr })));
        isReject(await hook(ev(staff, 'token_refresh', { amr })));
      }
      const customer = await user();
      const c = ev(customer, 'passkey', { amr: null });
      expect(await hook(c)).toEqual(c);
    });

    test('DATA-AUTH-013 a user_id that is missing, null, not a uuid, a number or an object is rejected, never an error', async () => {
      for (const user_id of [undefined, null, 'not-a-uuid', '', 5, {}, []] as const) {
        const input = {
          ...(user_id === undefined ? {} : { user_id }),
          authentication_method: 'passkey',
          claims: { amr: passkeyAmr(await nowEpoch()) },
        };
        isReject(await hook(input));
      }
    });

    test('DATA-AUTH-013 an event that is null, a string, an array, an empty object or a number is rejected, never an error', async () => {
      for (const input of [null, 'x', [], {}, 5, true]) {
        isReject(await hook(input));
      }
    });

    test('DATA-AUTH-013 an unknown authentication_method: staff rejected, customer unchanged', async () => {
      const staff = await user('admin');
      isReject(await hook(ev(staff, 'brand_new_method', { amr: passkeyAmr(await nowEpoch()) })));
      const customer = await user();
      const c = ev(customer, 'brand_new_method', {});
      expect(await hook(c)).toEqual(c);
    });

    test('DATA-AUTH-013 an authentication_method that is not a string: staff rejected', async () => {
      const staff = await user('admin');
      isReject(await hook({ user_id: staff, authentication_method: 5, claims: { amr: passkeyAmr(await nowEpoch()) } }));
      isReject(await hook({ user_id: staff, authentication_method: { a: 1 }, claims: {} }));
    });

    test('DATA-AUTH-013 when the settings row is gone a staff user with a passkey is rejected, a customer passes, and an open window still passes', async () => {
      const staff = await user('admin');
      const customer = await user();
      const s = await session(staff);
      await db().query('select public.passkey_window_open($1,$2)', [staff, s]);
      await db().query('delete from private.passkey_staff_config');
      isReject(await hook(ev(staff, 'passkey', { amr: passkeyAmr(await nowEpoch()) })));
      expect((await hook(ev(staff, 'otp', { amr: [], session_id: s }))).claims.staff_passkeys_ok).toBe(false);
      const c = ev(customer, 'passkey', { amr: [] });
      expect(await hook(c)).toEqual(c);
    });
  });

  describe('grants', () => {
    test('DATA-AUTH-013 supabase_auth_admin can execute; public, anon, authenticated and service_role cannot', async () => {
      const r = await db().query(
        `select has_function_privilege('supabase_auth_admin', $1, 'EXECUTE') as hook_role,
                has_function_privilege('anon', $1, 'EXECUTE') as a,
                has_function_privilege('authenticated', $1, 'EXECUTE') as u,
                has_function_privilege('service_role', $1, 'EXECUTE') as s,
                exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                         where p.oid = $1::regprocedure and x.grantee = 0) as pub`,
        [HOOK],
      );
      expect(r.rows[0]).toEqual({ hook_role: true, a: false, u: false, s: false, pub: false });
      for (const role of ['authenticated', 'anon']) {
        await db().query('savepoint g');
        await db().query(`set local role ${role}`);
        await expect(db().query(`select public.passkey_access_token_hook('{}'::jsonb)`)).rejects.toMatchObject({ code: '42501' });
        await db().query('rollback to savepoint g');
      }
    });

    test('DATA-AUTH-013 the function is SECURITY DEFINER, owned by postgres, with an empty search_path', async () => {
      const r = await db().query(
        'select p.prosecdef, p.proowner::regrole::text as owner, p.proconfig from pg_proc p where p.oid = $1::regprocedure',
        [HOOK],
      );
      expect(r.rows[0].prosecdef).toBe(true);
      expect(r.rows[0].owner).toBe('postgres');
      expect(r.rows[0].proconfig).toEqual(expect.arrayContaining(['search_path=""']));
    });

    test('DATA-AUTH-013 supabase_auth_admin cannot select the private passkey tables directly', async () => {
      for (const t of ['passkey_staff_config', 'approved_passkeys', 'passkey_registration_windows', 'passkey_notification_outbox']) {
        await db().query('savepoint t');
        await db().query('set local role supabase_auth_admin');
        await expect(db().query(`select * from private.${t}`)).rejects.toMatchObject({ code: '42501' });
        await db().query('rollback to savepoint t');
      }
    });
  });
});
