/** @jest-environment node */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describeLocalDb, LOCAL_DATABASE_URL, type PgClient } from './helpers/local-db';

// Passkey stage 3a Task 2b (migration H, second half): admin_set_user_role rebuilt (STAFF_INVITE_REQUIRED), staff_demote,
// the dashboard-only last resort (private.staff_invite_issue_manual) and passkey_delete_with_floor.
// DB suite: needs the local Supabase (DATABASE_URL). Most cases run in a transaction that is rolled back; the race cases
// commit on purpose (two or three connections) and clean up after themselves.
const { Client } = require('pg');

const DEMOTE_FN = 'public.staff_demote(uuid,uuid)';
const FLOOR_FN = 'public.passkey_delete_with_floor(uuid,uuid)';
const MANUAL_FN = 'private.staff_invite_issue_manual(text,text,integer)';
const hashOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

describeLocalDb('passkey staff roles (migration H second half)', () => {
  let admin: PgClient;
  const db = () => admin;
  const connect = async (): Promise<PgClient> => {
    const url = new URL(LOCAL_DATABASE_URL as string);
    url.username = 'supabase_admin';
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    return c as PgClient;
  };
  beforeAll(async () => { admin = await connect(); });
  afterAll(async () => { await admin.end(); });
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  const emails = new Map<string, string>();
  async function user(roleCode?: string, c: PgClient = db()): Promise<string> {
    const email = `staff-roles-${randomUUID()}@example.com`;
    const r = await c.query(
      `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, $2::jsonb, now(), now()) returning id::text as id`,
      [email, JSON.stringify({ role: roleCode ?? 'user' })],
    );
    const id: string = r.rows[0].id;
    emails.set(id, email);
    if (roleCode) {
      await c.query(
        `insert into public.user_roles (user_id, role_id, active) select $1, r.id, true from public.roles r where r.code = $2`,
        [id, roleCode],
      );
    }
    return id;
  }
  /** Makes `keep` the only active admin of this transaction (other committed admins are switched off, then rolled back). */
  async function soleAdmin(keep: string): Promise<void> {
    await db().query(
      `update public.user_roles set active = false
        where user_id <> $1 and role_id = (select id from public.roles where code = 'admin')`,
      [keep],
    );
  }
  async function key(userId: string, c: PgClient = db()): Promise<string> {
    const r = await c.query(
      `insert into auth.webauthn_credentials (user_id, credential_id, public_key, friendly_name)
       values ($1, $2, $3, 'k') returning id::text as id`,
      [userId, randomBytes(32), randomBytes(32)],
    );
    return r.rows[0].id;
  }
  const approve = (userId: string, passkeyId: string, via: string, c: PgClient = db()) =>
    c.query('select public.passkey_approve($1,$2,$3)', [userId, passkeyId, via]);
  async function session(userId: string, c: PgClient = db()): Promise<string> {
    const id = randomUUID();
    await c.query('insert into auth.sessions (id, user_id, created_at) values ($1, $2, now())', [id, userId]);
    return id;
  }
  async function factor(userId: string, type: 'totp' | 'webauthn', c: PgClient = db()): Promise<void> {
    await c.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3::auth.factor_type, 'verified', now(), now())`,
      [userId, `f-${randomUUID()}`, type],
    );
  }
  const setRole = (actor: string, target: string, role: string, c: PgClient = db()) =>
    c.query('select public.admin_set_user_role($1,$2,$3) as r', [actor, target, role]);
  const demote = (actor: string, target: string, c: PgClient = db()) =>
    c.query('select public.staff_demote($1,$2)', [actor, target]);
  const deleteKey = (userId: string, passkeyId: string, c: PgClient = db()) =>
    c.query('select public.passkey_delete_with_floor($1,$2)', [userId, passkeyId]);
  const issue = (target: string, role: string, kind: string, actor: string | null, token: string, c: PgClient = db()) =>
    c.query('select public.staff_invite_issue($1,$2,$3,$4,$5,$6,$7) as id', [target, role, kind, actor, 'reason', hashOf(token), 86400]);
  async function fails(run: () => Promise<unknown>): Promise<{ code?: string; message?: string } | null> {
    await db().query('savepoint f');
    try {
      await run();
      await db().query('release savepoint f');
      return null;
    } catch (e) {
      await db().query('rollback to savepoint f');
      return e as { code?: string; message?: string };
    }
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
  const count = async (sql: string, params: unknown[], c: PgClient = db()): Promise<number> => (await c.query(sql, params)).rows[0].n;
  const keyCount = (u: string, c?: PgClient) => count('select count(*)::int as n from auth.webauthn_credentials where user_id = $1', [u], c);
  const approvalCount = (u: string) => count('select count(*)::int as n from private.approved_passkeys where user_id = $1', [u]);
  const openInvites = (u: string) => count(
    'select count(*)::int as n from private.staff_invites where user_id = $1 and cancelled_at is null and activated_at is null', [u]);
  const activeRoles = async (u: string): Promise<string[]> =>
    (await db().query(
      `select r.code from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1 and ur.active order by r.code`,
      [u],
    )).rows.map((x) => x.code);
  const appRole = async (u: string): Promise<string | null> =>
    (await db().query(`select raw_app_meta_data ->> 'role' as r from auth.users where id = $1`, [u])).rows[0].r;
  /** A staff member with `n` keys, of which the first `approved` are approved. */
  async function staffWithKeys(n: number, approved: number, role = 'supporter'): Promise<{ id: string; keys: string[] }> {
    const id = await user(role);
    const keys: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const k = await key(id);
      keys.push(k);
      if (i < approved) await approve(id, k, 'script');
    }
    return { id, keys };
  }

  describe('DATA-AUTH-020 admin_set_user_role needs an invite to make someone staff', () => {
    test('DATA-AUTH-020 a person whose admin row is inactive or expired cannot be put back by admin_set_user_role (1j)', async () => {
      const actor = await user('admin');
      const inactive = await user('admin');
      await db().query('update public.user_roles set active = false where user_id = $1', [inactive]);
      const e1 = await fails(() => setRole(actor, inactive, 'admin'));
      expect(e1).toMatchObject({ code: '42501', message: 'STAFF_INVITE_REQUIRED' });
      const expired = await user('admin');
      await db().query(`update public.user_roles set expires_at = now() - interval '1 second' where user_id = $1`, [expired]);
      const e2 = await fails(() => setRole(actor, expired, 'admin'));
      expect(e2).toMatchObject({ code: '42501', message: 'STAFF_INVITE_REQUIRED' });
      const e3 = await fails(() => setRole(actor, expired, 'supporter'));
      expect(e3).toMatchObject({ code: '42501', message: 'STAFF_INVITE_REQUIRED' });
      expect(await activeRoles(inactive)).toEqual([]);
    });

    test('DATA-AUTH-020 a customer cannot be made supporter or admin directly; an unknown user is still USER_NOT_FOUND', async () => {
      const actor = await user('admin');
      const customer = await user();
      for (const role of ['supporter', 'admin']) {
        const e = await fails(() => setRole(actor, customer, role));
        expect(e).toMatchObject({ code: '42501', message: 'STAFF_INVITE_REQUIRED' });
      }
      expect(await activeRoles(customer)).toEqual([]);
      expect(await appRole(customer)).toBe('user');
      const unknown = await fails(() => setRole(actor, randomUUID(), 'admin'));
      expect(unknown).toMatchObject({ code: 'P0002', message: 'USER_NOT_FOUND' });
    });

    test('DATA-AUTH-020 an active admin still moves between staff roles and to user as before', async () => {
      const actor = await user('admin');
      const second = await user('admin');
      const target = await user('admin');
      expect((await setRole(actor, target, 'supporter')).rows[0].r).toEqual({ previousRole: 'admin', role: 'supporter' });
      expect(await activeRoles(target)).toEqual(['supporter']);
      expect((await setRole(actor, target, 'admin')).rows[0].r).toEqual({ previousRole: 'supporter', role: 'admin' });
      expect((await setRole(actor, second, 'user')).rows[0].r).toEqual({ previousRole: 'admin', role: 'user' });
      expect(await activeRoles(second)).toEqual(['user']);
      expect(await appRole(second)).toBe('user');
    });

    test('DATA-AUTH-020 the public wrapper and the private body keep service_role-only execute and owner postgres', async () => {
      for (const f of ['public.admin_set_user_role(uuid,uuid,text)', 'private.admin_set_user_role(uuid,uuid,text)']) {
        const r = (await db().query(
          `select has_function_privilege('anon', $1, 'EXECUTE') as anon, has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
                  has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                  (select proowner = 'postgres'::regrole and prosecdef = (schema_name = 'private')
                     from (select p.*, n.nspname as schema_name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where p.oid = $1::regprocedure) x) as attrs`,
          [f],
        )).rows[0];
        expect(r).toEqual({ anon: false, auth: false, svc: true, attrs: true });
      }
    });
  });

  describe('DATA-AUTH-020 staff_demote', () => {
    test('DATA-AUTH-020 demote sets the role to user, deletes the approval rows, keeps the keys, cancels the open invite and closes the window', async () => {
      const actor = await user('admin');
      const target = await user('admin');
      const k1 = await key(target);
      const k2 = await key(target);
      await approve(target, k1, 'script');
      await approve(target, k2, 'script');
      const sessionId = await session(target);
      await db().query('select public.passkey_window_open($1,$2)', [target, sessionId]);
      await db().query(
        `insert into private.staff_invites (user_id, role_code, kind, token_hash, issued_by, expires_at)
         values ($1, 'admin', 'redo', $2, $3, now() + interval '1 day')`,
        [target, hashOf(`demote-${randomUUID()}`), actor],
      );
      expect(await openInvites(target)).toBe(1);
      await demote(actor, target);
      expect(await activeRoles(target)).toEqual(['user']);
      expect(await appRole(target)).toBe('user');
      expect(await approvalCount(target)).toBe(0);
      expect(await keyCount(target)).toBe(2);
      expect(await openInvites(target)).toBe(0);
      expect(await count('select count(*)::int as n from private.passkey_registration_windows where user_id = $1 and closed_at is null', [target])).toBe(0);
      expect((await db().query(
        'select assigned_by::text as by from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1 and r.code = $2 and ur.active',
        [target, 'user'])).rows[0].by).toBe(actor);
    });

    test('DATA-AUTH-020 demote refuses the last admin, the actor himself, a non-admin actor, an inactive admin and an unknown user', async () => {
      const actor = await user('admin');
      await soleAdmin(actor);
      expect(await fails(() => demote(actor, actor))).toMatchObject({ code: 'P0001', message: 'LAST_ADMIN_REQUIRED' });
      const other = await user('admin');
      expect(await fails(() => demote(actor, actor))).toMatchObject({ code: '42501', message: 'SELF_ROLE_CHANGE_FORBIDDEN' });
      const supporter = await user('supporter');
      expect(await fails(() => demote(supporter, other))).toMatchObject({ code: '42501', message: 'ROLE_PERMISSION_FORBIDDEN' });
      const inactive = await user('admin');
      await db().query('update public.user_roles set active = false where user_id = $1', [inactive]);
      expect(await fails(() => demote(inactive, other))).toMatchObject({ code: '42501', message: 'ROLE_PERMISSION_FORBIDDEN' });
      expect(await fails(() => demote(actor, randomUUID()))).toMatchObject({ code: 'P0002', message: 'USER_NOT_FOUND' });
      expect(await activeRoles(other)).toEqual(['admin']);
    });

    test('DATA-AUTH-020 demote takes the global lock 190519 first and the per-user lock second, and checks the actor after the locks', async () => {
      const src = (await db().query(`select prosrc from pg_proc where oid = $1::regprocedure`, [DEMOTE_FN])).rows[0].prosrc as string;
      const global = src.indexOf('pg_advisory_xact_lock(190519, 0)');
      const perUser = src.indexOf("hashtextextended('passkey_approve:'");
      const check = src.indexOf("'admin.users.manage'");
      expect(global).toBeGreaterThanOrEqual(0);
      expect(perUser).toBeGreaterThan(global);
      expect(check).toBeGreaterThan(perUser);
    });
  });

  describe('DATA-AUTH-020 the last resort (private.staff_invite_issue_manual)', () => {
    test('DATA-AUTH-020 the fixed token hashes to the value Task 4 also holds', async () => {
      const r = (await db().query(
        `select encode(extensions.digest(convert_to($1, 'UTF8'), 'sha256'), 'hex') as h`, ['0123456789abcdef0123456789abcdef0123456789a'])).rows[0].h;
      expect(r).toBe('263b9741bfc84598b8f5688c5481887c8493d40b0b557de2f2f9b0329139c5db');
    });

    test('DATA-AUTH-020 manual returns a 43-character token, stores its UTF-8 SHA-256, expires in about one hour and writes one audit row', async () => {
      const target = await user();
      const email = emails.get(target) as string;
      const before = await count(`select count(*)::int as n from public.audit_logs where action = 'staff.last_resort.issue'`, []);
      const token: string = (await db().query('select private.staff_invite_issue_manual($1) as t', [email.toUpperCase()])).rows[0].t;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const row = (await db().query(
        `select role_code, kind, issued_by, token_hash, extract(epoch from (expires_at - now()))::int as ttl
           from private.staff_invites where user_id = $1`, [target])).rows[0];
      expect(row).toMatchObject({ role_code: 'admin', kind: 'last_resort', issued_by: null });
      expect(row.token_hash.equals(hashOf(token))).toBe(true);
      expect(row.ttl).toBeGreaterThan(3590);
      expect(row.ttl).toBeLessThanOrEqual(3600);
      const audit = (await db().query(
        `select actor_id, resource, resource_id, outcome, detail, metadata from public.audit_logs
          where action = 'staff.last_resort.issue' order by created_at desc limit 1`)).rows[0];
      expect(await count(`select count(*)::int as n from public.audit_logs where action = 'staff.last_resort.issue'`, [])).toBe(before + 1);
      expect(audit).toMatchObject({ actor_id: null, resource: 'user', resource_id: target, outcome: 'success' });
      expect(JSON.stringify(audit)).not.toContain(token);
      expect(JSON.stringify(audit)).not.toContain(email);
    });

    test('DATA-AUTH-020 manual takes a role and a ttl, and an unknown address is STAFF_MANUAL_USER_NOT_FOUND', async () => {
      const target = await user();
      await db().query('select private.staff_invite_issue_manual($1, $2, $3)', [emails.get(target), 'supporter', 120]);
      const row = (await db().query(
        `select role_code, extract(epoch from (expires_at - now()))::int as ttl from private.staff_invites where user_id = $1`, [target])).rows[0];
      expect(row.role_code).toBe('supporter');
      expect(row.ttl).toBeLessThanOrEqual(120);
      const e = await fails(() => db().query('select private.staff_invite_issue_manual($1)', [`nobody-${randomUUID()}@example.com`]));
      expect(e).toMatchObject({ code: 'P0002', message: 'STAFF_MANUAL_USER_NOT_FOUND' });
    });

    test('DATA-AUTH-020 the last admin can use manual: keys, TOTP and role go and one last_resort invite is made', async () => {
      const target = await user('admin');
      await soleAdmin(target);
      await key(target);
      await key(target);
      await factor(target, 'totp');
      await db().query('select private.staff_invite_issue_manual($1)', [emails.get(target)]);
      expect(await keyCount(target)).toBe(0);
      expect(await count('select count(*)::int as n from auth.mfa_factors where user_id = $1', [target])).toBe(0);
      expect(await activeRoles(target)).toEqual([]);
      expect(await appRole(target)).toBe('user');
      expect(await openInvites(target)).toBe(1);
      expect((await db().query('select kind from private.staff_invites where user_id = $1 and cancelled_at is null', [target])).rows[0].kind).toBe('last_resort');
    });

    test('DATA-AUTH-020 only postgres can execute manual; service_role, authenticated and anon get a permission error', async () => {
      const target = await user();
      for (const role of ['service_role', 'authenticated', 'anon']) {
        const e = await asRole(role, () => fails(() => db().query('select private.staff_invite_issue_manual($1)', [emails.get(target)])));
        expect(e).toMatchObject({ code: '42501' });
      }
      expect(await openInvites(target)).toBe(0);
      const r = (await db().query(
        `select has_function_privilege('postgres', $1, 'EXECUTE') as pg, has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as auth, has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0) as pub`,
        [MANUAL_FN])).rows[0];
      expect(r).toEqual({ pg: true, anon: false, auth: false, svc: false, pub: false });
      const asPostgres = await asRole('postgres', () => db().query('select private.staff_invite_issue_manual($1) as t', [emails.get(target)]));
      expect(asPostgres.rows[0].t).toHaveLength(43);
    });
  });

  describe('DATA-AUTH-020 passkey_delete_with_floor', () => {
    test('DATA-AUTH-020 a staff member with the minimum approved keys cannot delete one; with one more key can', async () => {
      const two = await staffWithKeys(2, 2);
      expect(await fails(() => deleteKey(two.id, two.keys[0]))).toMatchObject({ code: 'P0001', message: 'STAFF_MIN_KEYS' });
      expect(await keyCount(two.id)).toBe(2);
      const three = await staffWithKeys(3, 3, 'admin');
      await deleteKey(three.id, three.keys[0]);
      expect(await keyCount(three.id)).toBe(2);
      expect(await approvalCount(three.id)).toBe(2);
      expect(await fails(() => deleteKey(three.id, three.keys[1]))).toMatchObject({ message: 'STAFF_MIN_KEYS' });
    });

    test('DATA-AUTH-020 an unapproved key can be deleted while the approved count stays at the minimum', async () => {
      const staff = await staffWithKeys(3, 2);
      await deleteKey(staff.id, staff.keys[2]);
      expect(await keyCount(staff.id)).toBe(2);
      expect(await approvalCount(staff.id)).toBe(2);
    });

    test('DATA-AUTH-020 a staff member below the minimum can delete an unapproved key but not the only approved key', async () => {
      const staff = await staffWithKeys(2, 1);
      await deleteKey(staff.id, staff.keys[1]);
      expect(await keyCount(staff.id)).toBe(1);
      expect(await approvalCount(staff.id)).toBe(1);
      expect(await fails(() => deleteKey(staff.id, staff.keys[0]))).toMatchObject({ code: 'P0001', message: 'STAFF_MIN_KEYS' });
      expect(await keyCount(staff.id)).toBe(1);
    });

    test('DATA-AUTH-020 a customer can delete even the last key; a key of another user is PASSKEY_NOT_FOUND', async () => {
      const customer = await user();
      const k = await key(customer);
      const other = await user();
      const ko = await key(other);
      expect(await fails(() => deleteKey(customer, ko))).toMatchObject({ code: 'P0002', message: 'PASSKEY_NOT_FOUND' });
      await deleteKey(customer, k);
      expect(await keyCount(customer)).toBe(0);
      expect(await keyCount(other)).toBe(1);
    });

    test('DATA-AUTH-020 only service_role can execute it, and the function is definer, owned by postgres with an empty search_path', async () => {
      for (const f of [DEMOTE_FN, FLOOR_FN]) {
        const r = (await db().query(
          `select has_function_privilege('anon', $1, 'EXECUTE') as anon, has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
                  has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                  exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0) as pub`,
          [f])).rows[0];
        expect(r).toEqual({ anon: false, auth: false, svc: true, pub: false });
      }
      for (const f of [DEMOTE_FN, FLOOR_FN, MANUAL_FN, 'private.admin_set_user_role(uuid,uuid,text)']) {
        const p = (await db().query(
          `select prosecdef, proowner = 'postgres'::regrole as owner, proconfig @> array['search_path=""'] as sp from pg_proc where oid = $1::regprocedure`,
          [f])).rows[0];
        expect(p).toEqual({ prosecdef: true, owner: true, sp: true });
      }
      for (const role of ['anon', 'authenticated']) {
        const e = await asRole(role, () => fails(() => deleteKey(randomUUID(), randomUUID())));
        expect(e).toMatchObject({ code: '42501' });
      }
    });
  });

  describe('DATA-AUTH-020 a manager who stops being an admin takes the invites they issued with them', () => {
    const issueTo = async (target: string, issuer: string | null, kind = 'invite', role = 'supporter') => {
      const token = `cascade-${randomUUID()}`;
      const id: string = (await issue(target, role, kind, issuer, token)).rows[0].id;
      return { id, token };
    };
    /** A customer whose invite (issued by `issuer`) was consumed and bound: the registration window is open. */
    async function bound(issuer: string) {
      const target = await user();
      const { id, token } = await issueTo(target, issuer);
      await db().query('select * from public.staff_invite_consume($1)', [hashOf(token)]);
      const sessionId = await session(target);
      await db().query('select public.staff_invite_bind_window($1,$2)', [id, sessionId]);
      return { target, id, token, sessionId };
    }
    const inviteState = async (id: string) =>
      (await db().query('select cancelled_at is not null as cancelled, activated_at is not null as activated from private.staff_invites where id = $1', [id])).rows[0] as {
        cancelled: boolean; activated: boolean;
      };
    const openWindows = (u: string) => count('select count(*)::int as n from private.passkey_registration_windows where user_id = $1 and closed_at is null', [u]);

    test('DATA-AUTH-020 demote cancels the unused invite and the consumed invite the manager issued, and closes their windows', async () => {
      const other = await user('admin');
      const a = await user('admin');
      const unused = await user();
      const unusedInvite = await issueTo(unused, a);
      const used = await bound(a);
      expect(await openWindows(used.target)).toBe(1);
      await demote(other, a);
      expect((await inviteState(unusedInvite.id)).cancelled).toBe(true);
      expect((await inviteState(used.id)).cancelled).toBe(true);
      expect(await openInvites(unused)).toBe(0);
      expect(await openWindows(used.target)).toBe(0);
    });

    test('DATA-AUTH-020 demote leaves an activated staff member, another manager\'s invite and a last_resort invite alone, and cancels a redo the manager issued', async () => {
      const other = await user('admin');
      const a = await user('admin');
      const activated = await bound(a);
      await approve(activated.target, await key(activated.target), 'window');
      await approve(activated.target, await key(activated.target), 'window');
      await db().query('select public.staff_role_activate($1,$2)', [activated.target, activated.sessionId]);
      const byOther = await user();
      const otherInvite = await issueTo(byOther, other);
      const lastResortTarget = await user();
      await db().query('select private.staff_invite_issue_manual($1)', [emails.get(lastResortTarget)]);
      const redoTarget = (await staffWithKeys(2, 2)).id;
      const redo = await issueTo(redoTarget, a, 'redo');

      await demote(other, a);

      expect(await activeRoles(activated.target)).toEqual(['supporter']);
      expect(await inviteState(activated.id)).toEqual({ cancelled: false, activated: true });
      expect((await inviteState(otherInvite.id)).cancelled).toBe(false);
      expect(await openInvites(lastResortTarget)).toBe(1);
      expect((await inviteState(redo.id)).cancelled).toBe(true);
    });

    test('DATA-AUTH-020 a demote that fails (last admin) cancels nothing', async () => {
      const a = await user('admin');
      await soleAdmin(a);
      const target = await user();
      const invite = await issueTo(target, a);
      expect(await fails(() => demote(a, a))).toMatchObject({ code: 'P0001', message: 'LAST_ADMIN_REQUIRED' });
      expect((await inviteState(invite.id)).cancelled).toBe(false);
    });

    test('DATA-AUTH-020 admin to supporter, and admin to user, cancel the invites the manager issued (same transaction)', async () => {
      for (const role of ['supporter', 'user']) {
        const other = await user('admin');
        const a = await user('admin');
        const used = await bound(a);
        const unused = await user();
        const invite = await issueTo(unused, a);
        await setRole(other, a, role);
        expect((await inviteState(used.id)).cancelled).toBe(true);
        expect((await inviteState(invite.id)).cancelled).toBe(true);
        expect(await openWindows(used.target)).toBe(0);
        expect(await activeRoles(a)).toEqual([role]);
      }
    });

    test('DATA-AUTH-020 supporter to admin and admin to admin cancel nothing', async () => {
      const other = await user('admin');
      const a = await user('admin');
      const invite = await issueTo(await user(), a);
      await setRole(other, a, 'admin');
      expect((await inviteState(invite.id)).cancelled).toBe(false);
      const supporter = await user('supporter');
      const stray = await user();
      const strayId: string = (await db().query(
        `insert into private.staff_invites (user_id, role_code, kind, token_hash, issued_by, expires_at)
         values ($1, 'supporter', 'invite', $2, $3, now() + interval '1 day') returning id::text as id`,
        [stray, hashOf(`stray-${randomUUID()}`), supporter])).rows[0].id;
      await setRole(other, supporter, 'admin');
      expect((await inviteState(strayId)).cancelled).toBe(false);
    });

    test('DATA-AUTH-020 a redo for a current manager cancels the invites that manager issued and closes their windows', async () => {
      const other = await user('admin');
      const a = await user('admin');
      const used = await bound(a);
      const invite = await issueTo(await user(), a);
      await issueTo(a, other, 'redo', 'admin');
      expect((await inviteState(used.id)).cancelled).toBe(true);
      expect((await inviteState(invite.id)).cancelled).toBe(true);
      expect(await openWindows(used.target)).toBe(0);
      expect(await openInvites(a)).toBe(1);
    });

    test('DATA-AUTH-020 issuing to a customer (invite, promote) cancels nothing, even when the customer once issued an invite', async () => {
      const other = await user('admin');
      const customer = await user();
      const stray = await user();
      const strayId: string = (await db().query(
        `insert into private.staff_invites (user_id, role_code, kind, token_hash, issued_by, expires_at)
         values ($1, 'supporter', 'invite', $2, $3, now() + interval '1 day') returning id::text as id`,
        [stray, hashOf(`stray-${randomUUID()}`), customer])).rows[0].id;
      await issueTo(customer, other, 'invite');
      expect((await inviteState(strayId)).cancelled).toBe(false);
      await issueTo(customer, other, 'promote');
      expect((await inviteState(strayId)).cancelled).toBe(false);
    });

    test('DATA-AUTH-020 the last resort for a current manager cancels the invites that manager issued; for a supporter or a customer it cancels nothing', async () => {
      const a = await user('admin');
      const byA = await issueTo(await user(), a);
      await db().query('select private.staff_invite_issue_manual($1)', [emails.get(a)]);
      expect((await inviteState(byA.id)).cancelled).toBe(true);
      expect((await db().query('select kind from private.staff_invites where user_id = $1 and cancelled_at is null', [a])).rows[0].kind).toBe('last_resort');

      for (const roleCode of ['supporter', undefined]) {
        const person = await user(roleCode);
        const stray = await user();
        const strayId: string = (await db().query(
          `insert into private.staff_invites (user_id, role_code, kind, token_hash, issued_by, expires_at)
           values ($1, 'supporter', 'invite', $2, $3, now() + interval '1 day') returning id::text as id`,
          [stray, hashOf(`stray-${randomUUID()}`), person])).rows[0].id;
        await db().query('select private.staff_invite_issue_manual($1)', [emails.get(person)]);
        expect((await inviteState(strayId)).cancelled).toBe(false);
      }
    });

    test('DATA-AUTH-020 the cascade function has no execute for anyone and is called under the global lock first', async () => {
      const f = 'private.staff_cancel_invites_issued_by(uuid)';
      const r = (await db().query(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon, has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
                has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0) as pub,
                (select proowner = 'postgres'::regrole and prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = $1::regprocedure) as attrs`,
        [f])).rows[0];
      expect(r).toEqual({ anon: false, auth: false, svc: false, pub: false, attrs: true });
      const src = (await db().query(`select prosrc from pg_proc where oid = $1::regprocedure`, [DEMOTE_FN])).rows[0].prosrc as string;
      expect(src.indexOf('staff_cancel_invites_issued_by')).toBeGreaterThan(src.indexOf('pg_advisory_xact_lock(190519, 0)'));
    });
  });

  describe('DATA-AUTH-020 races (committed, cleaned up)', () => {
    async function cleanup(c: PgClient, ids: string[]): Promise<void> {
      for (const u of ids) {
        await c.query('delete from private.passkey_notification_outbox where user_id = $1', [u]);
        await c.query('delete from private.approved_passkeys where user_id = $1', [u]);
        await c.query('delete from private.passkey_registration_windows where user_id = $1', [u]);
        await c.query('delete from private.staff_invites where user_id = $1', [u]);
        await c.query('delete from public.user_roles where user_id = $1', [u]);
        await c.query('delete from auth.users where id = $1', [u]);
      }
    }
    const settle = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.message ?? e.code ?? 'err');

    test('DATA-AUTH-020 two admins redoing each other at the same moment: one wins, the other is refused, and an admin is left', async () => {
      const setup = await connect();
      const a = await connect();
      const b = await connect();
      const holder = await connect();
      const made: string[] = [];
      try {
        const adminA = await user('admin', setup);
        const adminB = await user('admin', setup);
        made.push(adminA, adminB);
        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock(190519, 0)');
        const first = settle(issue(adminB, 'admin', 'redo', adminA, 'tok-redo-a', a));
        const second = settle(issue(adminA, 'admin', 'redo', adminB, 'tok-redo-b', b));
        await new Promise((r) => setTimeout(r, 400));
        await holder.query('commit');
        const outcomes = await Promise.all([first, second]);
        for (const o of outcomes) expect(o).not.toMatch(/deadlock/i);
        expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
        expect(['LAST_ADMIN_REQUIRED', 'ROLE_PERMISSION_FORBIDDEN']).toContain(outcomes.find((o) => o !== 'ok'));
        const left = (await setup.query(
          `select count(*)::int as n from public.user_roles ur join public.roles r on r.id = ur.role_id
            where ur.user_id = any($1::uuid[]) and r.code = 'admin' and ur.active`, [made])).rows[0].n;
        expect(left).toBe(1);
      } finally {
        await holder.query('rollback').catch(() => undefined);
        await cleanup(setup, made);
        for (const c of [setup, a, b, holder]) await c.end();
      }
    });

    test('DATA-AUTH-020 two connections deleting different keys of a staff member with three approved keys: one is refused and two keys stay', async () => {
      for (let round = 0; round < 3; round += 1) {
        const setup = await connect();
        const a = await connect();
        const b = await connect();
        const holder = await connect();
        const made: string[] = [];
        try {
          const staff = await user('supporter', setup);
          made.push(staff);
          const keys: string[] = [];
          for (let i = 0; i < 3; i += 1) {
            const k = await key(staff, setup);
            keys.push(k);
            await approve(staff, k, 'script', setup);
          }
          await holder.query('begin');
          await holder.query(`select pg_advisory_xact_lock(hashtextextended('passkey_approve:' || $1::text, 0))`, [staff]);
          const first = settle(deleteKey(staff, keys[0], a));
          const second = settle(deleteKey(staff, keys[1], b));
          await new Promise((r) => setTimeout(r, 300));
          await holder.query('commit');
          const outcomes = await Promise.all([first, second]);
          expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
          expect(outcomes.find((o) => o !== 'ok')).toBe('STAFF_MIN_KEYS');
          expect(await keyCount(staff, setup)).toBe(2);
          expect((await setup.query('select count(*)::int as n from private.approved_passkeys where user_id = $1', [staff])).rows[0].n).toBe(2);
        } finally {
          await holder.query('rollback').catch(() => undefined);
          await cleanup(setup, made);
          for (const c of [setup, a, b, holder]) await c.end();
        }
      }
    });

    test('DATA-AUTH-020 a demote and the activation of an invite that manager issued, at the same moment: one finishes first and the result is consistent', async () => {
      for (const demoteFirst of [true, false]) {
        const setup = await connect();
        const a = await connect();
        const b = await connect();
        const holder = await connect();
        const made: string[] = [];
        try {
          const other = await user('admin', setup);
          const manager = await user('admin', setup);
          const invitee = await user(undefined, setup);
          made.push(other, manager, invitee);
          const token = `tok-cascade-race-${randomUUID()}`;
          const inviteId: string = (await issue(invitee, 'supporter', 'invite', manager, token, setup)).rows[0].id;
          await setup.query('select * from public.staff_invite_consume($1)', [hashOf(token)]);
          const sessionId = await session(invitee, setup);
          await setup.query('select public.staff_invite_bind_window($1,$2)', [inviteId, sessionId]);
          await approve(invitee, await key(invitee, setup), 'window', setup);
          await approve(invitee, await key(invitee, setup), 'window', setup);

          await holder.query('begin');
          await holder.query('select pg_advisory_xact_lock(190519, 0)');
          const run = {
            demoting: () => settle(demote(other, manager, a)),
            activating: () => settle(b.query("select public.staff_role_activate($1,$2)", [invitee, sessionId])),
          };
          let demoting: Promise<string>;
          let activating: Promise<string>;
          if (demoteFirst) {
            demoting = run.demoting();
            await new Promise((r) => setTimeout(r, 200));
            activating = run.activating();
          } else {
            activating = run.activating();
            await new Promise((r) => setTimeout(r, 200));
            demoting = run.demoting();
          }
          await new Promise((r) => setTimeout(r, 300));
          await holder.query('commit');
          const [demoted, activated] = await Promise.all([demoting, activating]);
          for (const o of [demoted, activated]) expect(o).not.toMatch(/deadlock/i);
          expect(demoted).toBe('ok');
          const roles = (await setup.query(
            `select r.code from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1 and ur.active`, [invitee])).rows;
          const invite = (await setup.query('select cancelled_at is not null as c, activated_at is not null as a from private.staff_invites where id = $1', [inviteId])).rows[0];
          // The lock queue is first come, first served: whoever asked first finishes first.
          expect(activated).toBe(demoteFirst ? 'STAFF_ACTIVATE_INVITE_INVALID' : 'ok');
          if (activated === 'ok') {
            expect(roles).toEqual([{ code: 'supporter' }]);
            expect(invite).toEqual({ c: false, a: true });
          } else {
            expect(activated).toBe('STAFF_ACTIVATE_INVITE_INVALID');
            expect(roles).toEqual([]);
            expect(invite).toEqual({ c: true, a: false });
          }
        } finally {
          await holder.query('rollback').catch(() => undefined);
          await cleanup(setup, made);
          for (const c of [setup, a, b, holder]) await c.end();
        }
      }
    });
  });
});
