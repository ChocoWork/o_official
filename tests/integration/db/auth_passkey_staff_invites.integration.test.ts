/** @jest-environment node */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describeLocalDb, LOCAL_DATABASE_URL, type PgClient } from './helpers/local-db';

// Passkey stage 3a Task 2 (migration H, first half): the staff invite table and the issue / consume / bind / activate /
// cancel / open functions. DB suite: needs the local Supabase (DATABASE_URL). Most cases run in a transaction that is
// rolled back; the race cases commit on purpose (two or three connections) and clean up after themselves.
const { Client } = require('pg');

const PUBLIC_FNS = [
  'public.staff_invite_issue(uuid,text,text,uuid,text,bytea,integer)',
  'public.staff_invite_consume(bytea)',
  'public.staff_invite_bind_window(uuid,uuid)',
  'public.staff_role_activate(uuid,uuid)',
  'public.staff_invite_cancel(uuid,uuid)',
  'public.staff_invite_open(uuid)',
];
const CORE_FN = 'private.staff_invite_issue_core(uuid,text,text,uuid,text,bytea,integer,boolean)';
const hashOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

describeLocalDb('passkey staff invites (migration H first half)', () => {
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

  async function user(roleCode?: string, c: PgClient = db()): Promise<string> {
    const r = await c.query(
      `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, $2::jsonb, now(), now()) returning id::text as id`,
      [`staff-invite-${randomUUID()}@example.com`, JSON.stringify({ role: roleCode ?? 'user' })],
    );
    const id: string = r.rows[0].id;
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
  const issue = (
    target: string, role: string, kind: string, actor: string | null, token: string, ttl?: number, c: PgClient = db(),
  ) =>
    c.query('select public.staff_invite_issue($1,$2,$3,$4,$5,$6,$7) as id', [
      target, role, kind, actor, 'reason', hashOf(token), ttl ?? 86400,
    ]);
  const consume = (token: string) => db().query('select * from public.staff_invite_consume($1)', [hashOf(token)]);
  const bind = (inviteId: string, sessionId: string) => db().query('select public.staff_invite_bind_window($1,$2)', [inviteId, sessionId]);
  const activate = (userId: string, sessionId: string, c: PgClient = db()) =>
    c.query('select public.staff_role_activate($1,$2) as r', [userId, sessionId]);
  const isOpen = async (userId: string): Promise<boolean> =>
    (await db().query('select public.staff_invite_open($1) as r', [userId])).rows[0].r;
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
  const count = async (sql: string, params: unknown[]): Promise<number> => (await db().query(sql, params)).rows[0].n;
  const keyCount = (u: string) => count('select count(*)::int as n from auth.webauthn_credentials where user_id = $1', [u]);
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

  /** A customer with an invite that was consumed and bound to a session; the window is open. */
  async function boundInvite(role = 'admin') {
    const actor = await user('admin');
    const target = await user();
    const token = `tok-${randomUUID()}`;
    const inviteId: string = (await issue(target, role, 'invite', actor, token)).rows[0].id;
    expect((await consume(token)).rowCount).toBe(1);
    const sessionId = await session(target);
    await bind(inviteId, sessionId);
    return { actor, target, token, inviteId, sessionId };
  }

  describe('DATA-AUTH-020 issue', () => {
    test('DATA-AUTH-020 issue deletes keys, approvals, every MFA factor and the role, closes the old invite and window, and leaves one open invite', async () => {
      const actor = await user('admin');
      const target = await user('supporter');
      const other = await user();
      const k1 = await key(target);
      await key(target);
      await approve(target, k1, 'script');
      await factor(target, 'totp');
      await factor(target, 'webauthn');
      await factor(other, 'totp');
      const sessionId = await session(target);
      await db().query('select public.passkey_window_open($1,$2)', [target, sessionId]);
      const first: string = (await issue(target, 'admin', 'redo', actor, 'first-token')).rows[0].id;
      expect(await openInvites(target)).toBe(1);
      // the first redo removed the role, so the person is no longer staff: the second issue is a plain invite
      const second: string = (await issue(target, 'admin', 'invite', actor, 'second-token')).rows[0].id;
      expect(second).not.toBe(first);
      expect(await keyCount(target)).toBe(0);
      expect(await approvalCount(target)).toBe(0);
      expect(await count('select count(*)::int as n from auth.mfa_factors where user_id = $1', [target])).toBe(0);
      expect(await count('select count(*)::int as n from auth.mfa_factors where user_id = $1', [other])).toBe(1);
      expect(await activeRoles(target)).toEqual([]);
      expect(await appRole(target)).toBe('user');
      expect(await openInvites(target)).toBe(1);
      expect((await db().query('select cancelled_at from private.staff_invites where id = $1', [first])).rows[0].cancelled_at).not.toBeNull();
      expect(await count('select count(*)::int as n from private.passkey_registration_windows where user_id = $1 and closed_at is null', [target])).toBe(0);
      const row = (await db().query('select role_code, kind, issued_by::text as issued_by, token_hash, consumed_at from private.staff_invites where id = $1', [second])).rows[0];
      expect(row).toMatchObject({ role_code: 'admin', kind: 'invite', issued_by: actor, consumed_at: null });
      expect(row.token_hash.equals(hashOf('second-token'))).toBe(true);
    });

    test('DATA-AUTH-020 a failure in the middle changes nothing (unknown user, and a duplicate token hash after the deletes)', async () => {
      const actor = await user('admin');
      const unknown = await fails(() => issue(randomUUID(), 'admin', 'invite', actor, 'tok-unknown'));
      expect(unknown).toMatchObject({ code: 'P0002', message: 'USER_NOT_FOUND' });
      const target = await user('supporter');
      await key(target);
      await factor(target, 'totp');
      await issue(target, 'supporter', 'redo', actor, 'tok-dup');
      const victim = await user('supporter');
      await key(victim);
      await factor(victim, 'totp');
      const dup = await fails(() => issue(victim, 'supporter', 'redo', actor, 'tok-dup'));
      expect(dup).toMatchObject({ code: '23505' });
      expect(await keyCount(victim)).toBe(1);
      expect(await activeRoles(victim)).toEqual(['supporter']);
      expect(await count('select count(*)::int as n from auth.mfa_factors where user_id = $1', [victim])).toBe(1);
      expect(await openInvites(victim)).toBe(0);
    });

    test('DATA-AUTH-020 the removal notices of the keys that issue deleted are skipped (staff_invite_issue), and none stay pending', async () => {
      const actor = await user('admin');
      const target = await user('supporter');
      const ids = [await key(target), await key(target), await key(target)];
      await approve(target, ids[0], 'script');
      await approve(target, ids[1], 'script');
      await issue(target, 'admin', 'redo', actor, 'tok-skip');
      const rows = (await db().query(
        `select status, last_error_code, finished_at is not null as finished, passkey_id::text as passkey_id
           from private.passkey_notification_outbox where user_id = $1 and kind = 'passkey_removed'`,
        [target],
      )).rows;
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.passkey_id).sort()).toEqual([...ids].sort());
      for (const r of rows) expect(r).toMatchObject({ status: 'skipped', last_error_code: 'staff_invite_issue', finished: true });
      expect(await count(`select count(*)::int as n from private.passkey_notification_outbox where user_id = $1 and kind = 'passkey_removed' and status = 'pending'`, [target])).toBe(0);
    });

    test('DATA-AUTH-020 the last admin cannot be sent through issue, a non-admin target passes, and an issuer who is not an admin is refused', async () => {
      const lone = await user('admin');
      await soleAdmin(lone);
      const lastAdmin = await fails(() => issue(lone, 'admin', 'redo', lone, 'tok-last'));
      expect(lastAdmin).toMatchObject({ code: 'P0001', message: 'LAST_ADMIN_REQUIRED' });
      const supporter = await user('supporter');
      await issue(supporter, 'supporter', 'redo', lone, 'tok-supporter');
      expect(await openInvites(supporter)).toBe(1);
      const second = await user('admin');
      await issue(second, 'admin', 'redo', lone, 'tok-admin-with-other');
      expect(await openInvites(second)).toBe(1);
      const third = await user('admin');
      const self = await fails(() => issue(third, 'admin', 'redo', third, 'tok-self'));
      expect(self).toMatchObject({ code: '42501', message: 'SELF_ROLE_CHANGE_FORBIDDEN' });
      const customer = await user();
      const forbidden = await fails(async () => issue(await user(), 'admin', 'invite', customer, 'tok-forbidden'));
      expect(forbidden).toMatchObject({ code: '42501', message: 'ROLE_PERMISSION_FORBIDDEN' });
      const nobody = await fails(async () => issue(await user('supporter'), 'admin', 'redo', null, 'tok-null'));
      expect(nobody).toMatchObject({ message: 'ROLE_PERMISSION_FORBIDDEN' });
    });

    test('DATA-AUTH-020 last_resort is refused for service_role (the app key), and promote / invite / redo are accepted', async () => {
      const actor = await user('admin');
      const target = await user();
      const refused = await asRole('service_role', () => fails(() => issue(target, 'admin', 'last_resort', actor, 'tok-lr')));
      expect(refused).toMatchObject({ message: 'STAFF_INVITE_KIND_FORBIDDEN' });
      const bogus = await fails(() => issue(target, 'admin', 'whatever', actor, 'tok-bogus'));
      expect(bogus).toMatchObject({ message: 'STAFF_INVITE_KIND_FORBIDDEN' });
      for (const kind of ['promote', 'invite']) {
        const t = await user();
        await issue(t, 'supporter', kind, actor, `tok-${kind}`);
        expect(await openInvites(t)).toBe(1);
      }
    });

    test('DATA-AUTH-020 a current staff member gets STAFF_ALREADY_STAFF for invite and promote, and redo passes', async () => {
      const actor = await user('admin');
      const staff = await user('supporter');
      expect(await fails(() => issue(staff, 'admin', 'invite', actor, 'tok-a'))).toMatchObject({ message: 'STAFF_ALREADY_STAFF' });
      expect(await fails(() => issue(staff, 'admin', 'promote', actor, 'tok-b'))).toMatchObject({ message: 'STAFF_ALREADY_STAFF' });
      await issue(staff, 'admin', 'redo', actor, 'tok-c');
      expect(await openInvites(staff)).toBe(1);
    });

    test('DATA-AUTH-020 redo for a person who is not staff (for example just demoted) raises STAFF_NOT_STAFF and deletes no key', async () => {
      const actor = await user('admin');
      const demoted = await user();
      await key(demoted);
      await key(demoted);
      await factor(demoted, 'totp');
      expect(await fails(() => issue(demoted, 'admin', 'redo', actor, 'tok-not-staff'))).toMatchObject({ code: 'P0001', message: 'STAFF_NOT_STAFF' });
      expect(await keyCount(demoted)).toBe(2);
      expect(await count('select count(*)::int as n from auth.mfa_factors where user_id = $1', [demoted])).toBe(1);
      expect(await openInvites(demoted)).toBe(0);
    });

    test('DATA-AUTH-020 bad arguments are refused with 22023 before any change', async () => {
      const actor = await user('admin');
      const target = await user('supporter');
      await key(target);
      expect(await fails(() => issue(target, 'user', 'redo', actor, 'tok-x'))).toMatchObject({ code: '22023' });
      expect(await fails(() => issue(target, 'admin', 'redo', actor, 'tok-y', 0))).toMatchObject({ code: '22023' });
      expect(await fails(() => db().query('select public.staff_invite_issue($1,$2,$3,$4,$5,$6,$7)', [target, 'admin', 'redo', actor, 'r', Buffer.from('short'), 60]))).toMatchObject({ code: '22023' });
      expect(await keyCount(target)).toBe(1);
    });

    test('DATA-AUTH-020 the core takes the global lock 190519 first and then the per-user lock, and checks the issuer after the locks', async () => {
      const body: string = (await db().query(`select prosrc from pg_proc where oid = '${CORE_FN}'::regprocedure`)).rows[0].prosrc;
      const global = body.indexOf('pg_advisory_xact_lock(190519, 0)');
      const perUser = body.indexOf("pg_advisory_xact_lock(hashtextextended('passkey_approve:' || p_user_id::text, 0))");
      const issuer = body.indexOf('ROLE_PERMISSION_FORBIDDEN');
      expect(global).toBeGreaterThan(-1);
      expect(perUser).toBeGreaterThan(global);
      expect(issuer).toBeGreaterThan(perUser);
    });
  });

  describe('DATA-AUTH-020 consume and bind', () => {
    test('DATA-AUTH-020 consume returns the row once, then nothing; expired, cancelled and unknown hashes return nothing', async () => {
      const actor = await user('admin');
      const target = await user();
      const id: string = (await issue(target, 'supporter', 'invite', actor, 'tok-once')).rows[0].id;
      const first = await consume('tok-once');
      expect(first.rows).toEqual([{ invite_id: id, user_id: target, role_code: 'supporter' }]);
      expect((await consume('tok-once')).rowCount).toBe(0);
      expect((await consume('tok-unknown')).rowCount).toBe(0);
      const t2 = await user();
      const id2: string = (await issue(t2, 'admin', 'invite', actor, 'tok-expired')).rows[0].id;
      await db().query(`update private.staff_invites set expires_at = now() - interval '1 second' where id = $1`, [id2]);
      expect((await consume('tok-expired')).rowCount).toBe(0);
      const t3 = await user();
      await issue(t3, 'admin', 'invite', actor, 'tok-cancelled');
      await db().query('select public.staff_invite_cancel($1,$2)', [actor, t3]);
      expect((await consume('tok-cancelled')).rowCount).toBe(0);
    });

    test('DATA-AUTH-020 consume does not open a window; bind opens it for the session and a second bind is STAFF_INVITE_ALREADY_BOUND', async () => {
      const actor = await user('admin');
      const target = await user();
      const id: string = (await issue(target, 'admin', 'invite', actor, 'tok-bind')).rows[0].id;
      await consume('tok-bind');
      expect(await count('select count(*)::int as n from private.passkey_registration_windows where user_id = $1', [target])).toBe(0);
      const sessionId = await session(target);
      await bind(id, sessionId);
      const row = (await db().query('select session_id::text as s, bound_at is not null as bound from private.staff_invites where id = $1', [id])).rows[0];
      expect(row).toEqual({ s: sessionId, bound: true });
      expect((await db().query('select public.passkey_window_is_open($1,$2) as r', [target, sessionId])).rows[0].r).toBe(true);
      expect(await fails(async () => bind(id, await session(target)))).toMatchObject({ message: 'STAFF_INVITE_ALREADY_BOUND' });
    });

    test('DATA-AUTH-020 bind refuses an unknown, unconsumed, cancelled or expired invite, and a session of another user', async () => {
      const actor = await user('admin');
      const target = await user();
      expect(await fails(() => bind(randomUUID(), randomUUID()))).toMatchObject({ message: 'STAFF_INVITE_INVALID' });
      const id: string = (await issue(target, 'admin', 'invite', actor, 'tok-bind2')).rows[0].id;
      expect(await fails(async () => bind(id, await session(target)))).toMatchObject({ message: 'STAFF_INVITE_INVALID' });
      await consume('tok-bind2');
      const stranger = await user();
      expect(await fails(async () => bind(id, await session(stranger)))).toMatchObject({ code: '42501' });
      await db().query(`update private.staff_invites set expires_at = now() - interval '1 second' where id = $1`, [id]);
      expect(await fails(async () => bind(id, await session(target)))).toMatchObject({ message: 'STAFF_INVITE_INVALID' });
      await db().query(`update private.staff_invites set expires_at = now() + interval '1 day', cancelled_at = now() where id = $1`, [id]);
      expect(await fails(async () => bind(id, await session(target)))).toMatchObject({ message: 'STAFF_INVITE_INVALID' });
    });
  });

  describe('DATA-AUTH-020 activate', () => {
    test('DATA-AUTH-020 activate refuses one key, a reauth key, a key from before the bind, and an unapproved key left over', async () => {
      const a = await boundInvite();
      const k1 = await key(a.target);
      await approve(a.target, k1, 'window');
      expect(await fails(() => activate(a.target, a.sessionId))).toMatchObject({ message: 'STAFF_ACTIVATE_KEYS_SHORT' });

      const b = await boundInvite();
      const b1 = await key(b.target);
      const b2 = await key(b.target);
      await approve(b.target, b1, 'window');
      await approve(b.target, b2, 'reauth');
      expect(await fails(() => activate(b.target, b.sessionId))).toMatchObject({ message: 'STAFF_ACTIVATE_KEYS_NOT_WINDOW' });

      const c = await boundInvite();
      const c1 = await key(c.target);
      const c2 = await key(c.target);
      await approve(c.target, c1, 'window');
      await approve(c.target, c2, 'window');
      await db().query(`update private.approved_passkeys set approved_at = now() - interval '1 hour' where passkey_id = $1`, [c2]);
      await db().query(`update private.staff_invites set bound_at = now() where id = $1`, [c.inviteId]);
      expect(await fails(() => activate(c.target, c.sessionId))).toMatchObject({ message: 'STAFF_ACTIVATE_KEYS_NOT_WINDOW' });

      const d = await boundInvite();
      const d1 = await key(d.target);
      const d2 = await key(d.target);
      await key(d.target);
      await approve(d.target, d1, 'window');
      await approve(d.target, d2, 'window');
      expect(await fails(() => activate(d.target, d.sessionId))).toMatchObject({ message: 'STAFF_ACTIVATE_KEYS_NOT_WINDOW' });
      expect(await activeRoles(d.target)).toEqual([]);
    });

    test('DATA-AUTH-020 activate refuses a closed window and a session that has no invite', async () => {
      const a = await boundInvite();
      await approve(a.target, await key(a.target), 'window');
      await approve(a.target, await key(a.target), 'window');
      await db().query('select public.passkey_window_close($1)', [a.sessionId]);
      expect(await fails(() => activate(a.target, a.sessionId))).toMatchObject({ message: 'STAFF_ACTIVATE_NO_WINDOW' });
      expect(await fails(() => activate(a.target, randomUUID()))).toMatchObject({ message: 'STAFF_ACTIVATE_INVITE_INVALID' });
      expect(await fails(() => activate(randomUUID(), a.sessionId))).toMatchObject({ message: 'STAFF_ACTIVATE_INVITE_INVALID' });
      expect(await activeRoles(a.target)).toEqual([]);
    });

    test('ARC-AUTH-012 two keys approved inside the window activate the role, close the window, and cannot be activated again', async () => {
      const a = await boundInvite('supporter');
      await approve(a.target, await key(a.target), 'window');
      await approve(a.target, await key(a.target), 'window');
      const result = await activate(a.target, a.sessionId);
      expect(result.rows[0].r).toEqual({ role: 'supporter' });
      expect(await activeRoles(a.target)).toEqual(['supporter']);
      expect(await appRole(a.target)).toBe('supporter');
      const assigned = (await db().query(
        `select ur.assigned_by::text as by from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1 and r.code = 'supporter'`,
        [a.target],
      )).rows[0].by;
      expect(assigned).toBe(a.actor);
      expect((await db().query('select activated_at is not null as ok from private.staff_invites where id = $1', [a.inviteId])).rows[0].ok).toBe(true);
      expect((await db().query('select public.passkey_window_is_open($1,$2) as r', [a.target, a.sessionId])).rows[0].r).toBe(false);
      expect(await isOpen(a.target)).toBe(false);
      expect(await fails(() => activate(a.target, a.sessionId))).toMatchObject({ message: 'STAFF_ACTIVATE_INVITE_INVALID' });
    });

    test('DATA-AUTH-020 a cancelled invite cannot be activated', async () => {
      const a = await boundInvite();
      await approve(a.target, await key(a.target), 'window');
      await approve(a.target, await key(a.target), 'window');
      await db().query('select public.staff_invite_cancel($1,$2)', [a.actor, a.target]);
      expect(await fails(() => activate(a.target, a.sessionId))).toMatchObject({ message: 'STAFF_ACTIVATE_INVITE_INVALID' });
    });
  });

  describe('DATA-AUTH-020 cancel and open', () => {
    test('DATA-AUTH-020 cancel closes the invite and the window and leaves the keys and the role alone', async () => {
      const a = await boundInvite();
      const k = await key(a.target);
      expect(await isOpen(a.target)).toBe(true);
      await db().query('select public.staff_invite_cancel($1,$2)', [a.actor, a.target]);
      expect(await isOpen(a.target)).toBe(false);
      expect((await db().query('select cancelled_at is not null as c from private.staff_invites where id = $1', [a.inviteId])).rows[0].c).toBe(true);
      expect((await db().query('select public.passkey_window_is_open($1,$2) as r', [a.target, a.sessionId])).rows[0].r).toBe(false);
      expect(await keyCount(a.target)).toBe(1);
      expect((await db().query('select id::text as id from auth.webauthn_credentials where user_id = $1', [a.target])).rows[0].id).toBe(k);
      expect(await activeRoles(a.target)).toEqual([]);
    });

    test('DATA-AUTH-020 cancel is refused when the actor is not a current admin (customer, supporter, inactive admin)', async () => {
      const a = await boundInvite();
      const customer = await user();
      const supporter = await user('supporter');
      const inactive = await user('admin');
      await db().query(`update public.user_roles set active = false where user_id = $1`, [inactive]);
      for (const who of [customer, supporter, inactive]) {
        expect(await fails(() => db().query('select public.staff_invite_cancel($1,$2)', [who, a.target]))).toMatchObject({ code: '42501', message: 'ROLE_PERMISSION_FORBIDDEN' });
      }
      expect(await isOpen(a.target)).toBe(true);
    });

    test('DATA-AUTH-020 open is false with no row, cancelled, activated or expired, and true for an open invite', async () => {
      const actor = await user('admin');
      const target = await user();
      expect(await isOpen(target)).toBe(false);
      const id: string = (await issue(target, 'admin', 'invite', actor, 'tok-open')).rows[0].id;
      expect(await isOpen(target)).toBe(true);
      await db().query(`update private.staff_invites set expires_at = now() - interval '1 second' where id = $1`, [id]);
      expect(await isOpen(target)).toBe(false);
      await db().query(`update private.staff_invites set expires_at = now() + interval '1 day', cancelled_at = now() where id = $1`, [id]);
      expect(await isOpen(target)).toBe(false);
      await db().query(`update private.staff_invites set cancelled_at = null, activated_at = now() where id = $1`, [id]);
      expect(await isOpen(target)).toBe(false);
      expect(await isOpen(randomUUID())).toBe(false);
    });

    test('DATA-AUTH-020 only one not-cancelled, not-activated invite can exist for a user', async () => {
      const actor = await user('admin');
      const target = await user();
      await issue(target, 'admin', 'invite', actor, 'tok-uniq-1');
      const dup = await fails(() => db().query(
        `insert into private.staff_invites (user_id, role_code, kind, token_hash, expires_at) values ($1, 'admin', 'invite', $2, now() + interval '1 day')`,
        [target, hashOf('tok-uniq-2')],
      ));
      expect(dup).toMatchObject({ code: '23505' });
    });
  });

  describe('DATA-AUTH-020 grants and attributes', () => {
    test('DATA-AUTH-020 the six public functions are service_role only; the core has no execute for anyone; owner postgres, definer, empty search_path', async () => {
      for (const f of PUBLIC_FNS) {
        const r = (await db().query(
          `select has_function_privilege('anon', $1, 'EXECUTE') as anon, has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
                  has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                  exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0) as pub`,
          [f],
        )).rows[0];
        expect(r).toEqual({ anon: false, auth: false, svc: true, pub: false });
      }
      const core = (await db().query(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon, has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
                has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0) as pub`,
        [CORE_FN],
      )).rows[0];
      expect(core).toEqual({ anon: false, auth: false, svc: false, pub: false });
      for (const f of [...PUBLIC_FNS, CORE_FN]) {
        const p = (await db().query(
          `select prosecdef, proowner = 'postgres'::regrole as owner, proconfig @> array['search_path=""'] as sp from pg_proc where oid = $1::regprocedure`,
          [f],
        )).rows[0];
        expect(p).toEqual({ prosecdef: true, owner: true, sp: true });
      }
    });

    test('DATA-AUTH-020 anon and authenticated get a permission error when they call a function, and service_role cannot call the core', async () => {
      for (const role of ['anon', 'authenticated']) {
        const e = await asRole(role, () => fails(() => db().query('select public.staff_invite_open($1)', [randomUUID()])));
        expect(e).toMatchObject({ code: '42501' });
      }
      const core = await asRole('service_role', () => fails(() => db().query(
        'select private.staff_invite_issue_core($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), 'admin', 'redo', null, null, hashOf('x'), 60, true])));
      expect(core).toMatchObject({ code: '42501' });
    });

    test('DATA-AUTH-020 the table has RLS, owner postgres and no privilege for anon, authenticated or service_role', async () => {
      const r = (await db().query(
        `select relrowsecurity as rls, relowner = 'postgres'::regrole as owner,
                has_table_privilege('anon', 'private.staff_invites', 'SELECT,INSERT,UPDATE,DELETE') as anon,
                has_table_privilege('authenticated', 'private.staff_invites', 'SELECT,INSERT,UPDATE,DELETE') as auth,
                has_table_privilege('service_role', 'private.staff_invites', 'SELECT,INSERT,UPDATE,DELETE') as svc
           from pg_class where oid = 'private.staff_invites'::regclass`,
      )).rows[0];
      expect(r).toEqual({ rls: true, owner: true, anon: false, auth: false, svc: false });
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

    test('DATA-AUTH-020 issue and activate for the same user at the same moment do not deadlock; one finishes, then the other', async () => {
      const setup = await connect();
      const a = await connect();
      const b = await connect();
      const holder = await connect();
      const made: string[] = [];
      try {
        const actor = await user('admin', setup);
        const target = await user(undefined, setup);
        made.push(actor, target);
        await issue(target, 'supporter', 'invite', actor, 'tok-race-1', undefined, setup);
        const inviteId: string = (await setup.query('select id::text as id from private.staff_invites where user_id = $1', [target])).rows[0].id;
        await setup.query('select * from public.staff_invite_consume($1)', [hashOf('tok-race-1')]);
        const sessionId = await session(target, setup);
        await setup.query('select public.staff_invite_bind_window($1,$2)', [inviteId, sessionId]);
        await approve(target, await key(target, setup), 'window', setup);
        await approve(target, await key(target, setup), 'window', setup);

        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock(190519, 0)');
        await holder.query(`select pg_advisory_xact_lock(hashtextextended('passkey_approve:' || $1::text, 0))`, [target]);
        const issuing = settle(issue(target, 'supporter', 'redo', actor, 'tok-race-2', undefined, a));
        const activating = settle(activate(target, sessionId, b));
        await new Promise((r) => setTimeout(r, 400));
        await holder.query('commit');
        const [issued, activated] = await Promise.all([issuing, activating]);
        for (const outcome of [issued, activated]) expect(outcome).not.toMatch(/deadlock/i);
        const roles = (await setup.query(
          `select r.code from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1 and ur.active`, [target])).rows;
        const keys = (await setup.query('select count(*)::int as n from auth.webauthn_credentials where user_id = $1', [target])).rows[0].n;
        const open = (await setup.query(
          'select count(*)::int as n from private.staff_invites where user_id = $1 and cancelled_at is null and activated_at is null', [target])).rows[0].n;
        expect(activated).toBe('ok');
        if (issued === 'ok') {
          // activate went first: the user was activated, then redo wiped everything and left one new invite.
          expect(roles).toEqual([]);
          expect(keys).toBe(0);
          expect(open).toBe(1);
        } else {
          // redo went first: the user was not staff yet, so redo was refused and activate went through untouched.
          expect(issued).toBe('STAFF_NOT_STAFF');
          expect(roles).toEqual([{ code: 'supporter' }]);
          expect(keys).toBe(2);
          expect(open).toBe(0);
        }
      } finally {
        await holder.query('rollback').catch(() => undefined);
        await cleanup(setup, made);
        for (const c of [setup, a, b, holder]) await c.end();
      }
    });

    test('DATA-AUTH-020 a demote that commits while a redo waits for the lock is not overturned by the redo', async () => {
      const setup = await connect();
      const a = await connect();
      const holder = await connect();
      const made: string[] = [];
      try {
        const actor = await user('admin', setup);
        const target = await user('supporter', setup);
        made.push(actor, target);
        await key(target, setup);
        await key(target, setup);
        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock(190519, 0)');
        await holder.query(`select pg_advisory_xact_lock(hashtextextended('passkey_approve:' || $1::text, 0))`, [target]);
        const issuing = settle(issue(target, 'supporter', 'redo', actor, 'tok-demote-race', undefined, a));
        await new Promise((r) => setTimeout(r, 300));
        await holder.query(`update public.user_roles set active = false where user_id = $1`, [target]);
        await holder.query('commit');
        expect(await issuing).toBe('STAFF_NOT_STAFF');
        expect((await setup.query('select count(*)::int as n from auth.webauthn_credentials where user_id = $1', [target])).rows[0].n).toBe(2);
        expect((await setup.query('select count(*)::int as n from private.staff_invites where user_id = $1', [target])).rows[0].n).toBe(0);
      } finally {
        await holder.query('rollback').catch(() => undefined);
        await cleanup(setup, made);
        for (const c of [setup, a, holder]) await c.end();
      }
    });

    test('DATA-AUTH-020 passkey_approve(reauth) and issue at the same moment never leave an approval row for a deleted key', async () => {
      for (let round = 0; round < 3; round += 1) {
        const setup = await connect();
        const a = await connect();
        const b = await connect();
        const holder = await connect();
        const made: string[] = [];
        try {
          const actor = await user('admin', setup);
          const target = await user('supporter', setup);
          made.push(actor, target);
          await approve(target, await key(target, setup), 'script', setup);
          const third = await key(target, setup);
          await holder.query('begin');
          await holder.query(`select pg_advisory_xact_lock(hashtextextended('passkey_approve:' || $1::text, 0))`, [target]);
          const issuing = settle(issue(target, 'admin', 'redo', actor, `tok-approve-race-${round}`, undefined, a));
          const approving = settle(approve(target, third, 'reauth', b));
          await new Promise((r) => setTimeout(r, 300));
          await holder.query('commit');
          await Promise.all([issuing, approving]);
          expect((await setup.query('select count(*)::int as n from private.approved_passkeys where user_id = $1', [target])).rows[0].n).toBe(0);
          expect((await setup.query('select count(*)::int as n from auth.webauthn_credentials where user_id = $1', [target])).rows[0].n).toBe(0);
        } finally {
          await holder.query('rollback').catch(() => undefined);
          await cleanup(setup, made);
          for (const c of [setup, a, b, holder]) await c.end();
        }
      }
    });
  });
});
