/** @jest-environment node */
import { randomBytes, randomUUID } from 'node:crypto';
import { LOCAL_DATABASE_URL, describeLocalDb, type PgClient } from './helpers/local-db';

const { Client } = require('pg');

// Passkey stage 1a Task 6 (migration C): the trigger on auth.webauthn_credentials that queues the outbox and removes
// approval rows. DB suite: needs the local Supabase (DATABASE_URL). Every case runs in a transaction that is rolled back.
// The suite uses its own supabase_admin connection (local-only superuser) so that DISABLE TRIGGER on the GoTrue-owned
// table can be run inside a rolled-back transaction.
describeLocalDb('passkey credential trigger and notification outbox', () => {
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

  async function user(roleCode?: string): Promise<string> {
    const r = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [`passkey-events-${randomUUID()}@example.com`],
    );
    const id: string = r.rows[0].id;
    if (roleCode) {
      await db().query(
        `insert into public.user_roles (user_id, role_id, active)
         select $1, r.id, true from public.roles r where r.code = $2`,
        [id, roleCode],
      );
    }
    return id;
  }
  async function key(userId: string, approve = false): Promise<string> {
    const r = await db().query(
      `insert into auth.webauthn_credentials (user_id, credential_id, public_key, friendly_name)
       values ($1, $2, $3, 'k') returning id::text as id`,
      [userId, randomBytes(32), randomBytes(32)],
    );
    if (approve) await db().query('select public.passkey_approve($1,$2,$3)', [userId, r.rows[0].id, 'script']);
    return r.rows[0].id;
  }
  const outbox = async (userId: string) =>
    (await db().query(
      'select kind, passkey_id::text as passkey_id, subject_is_staff, notify_subject, subject_email from private.passkey_notification_outbox where user_id = $1 order by seq',
      [userId],
    )).rows;
  const approvalRows = async (passkeyId: string): Promise<number> =>
    (await db().query('select 1 from private.approved_passkeys where passkey_id = $1', [passkeyId])).rowCount;
  const count = async (userId: string): Promise<number> =>
    (await db().query('select public.passkey_approved_count($1) as n', [userId])).rows[0].n;

  test('DATA-AUTH-014 an insert queues passkey_added and a delete queues passkey_removed and removes the approval', async () => {
    const u = await user();
    const k = await key(u, true);
    expect((await outbox(u)).map((r) => r.kind)).toEqual(['passkey_added']);
    expect(await approvalRows(k)).toBe(1);
    await db().query('delete from auth.webauthn_credentials where id = $1', [k]);
    const rows = await outbox(u);
    expect(rows.map((r) => r.kind)).toEqual(['passkey_added', 'passkey_removed']);
    expect(rows[1]).toMatchObject({ passkey_id: k, subject_is_staff: true, notify_subject: true });
    expect(rows[1].subject_email).toMatch(/^passkey-events-/);
    expect(await approvalRows(k)).toBe(0);
  });

  test('DATA-AUTH-014 a customer key that was never approved is queued with subject_is_staff false', async () => {
    const u = await user();
    const k = await key(u);
    await db().query('delete from auth.webauthn_credentials where id = $1', [k]);
    expect((await outbox(u)).map((r) => [r.kind, r.subject_is_staff])).toEqual([['passkey_added', false], ['passkey_removed', false]]);
  });

  test('DATA-AUTH-014 updating only the name, sign_count or last_used_at queues nothing', async () => {
    const u = await user();
    const k = await key(u, true);
    await db().query(`update auth.webauthn_credentials set friendly_name = 'renamed' where id = $1`, [k]);
    await db().query('update auth.webauthn_credentials set sign_count = sign_count + 1, last_used_at = now() where id = $1', [k]);
    expect((await outbox(u)).map((r) => r.kind)).toEqual(['passkey_added']);
    expect(await approvalRows(k)).toBe(1);
  });

  test('DATA-AUTH-014 changing public_key (or credential_id) queues passkey_key_replaced once and removes the approval', async () => {
    const u = await user();
    const k = await key(u, true);
    await db().query('update auth.webauthn_credentials set public_key = $2 where id = $1', [k, randomBytes(32)]);
    const rows = await outbox(u);
    expect(rows.map((r) => r.kind)).toEqual(['passkey_added', 'passkey_key_replaced']);
    expect(rows[1]).toMatchObject({ subject_is_staff: true, notify_subject: true });
    expect(await approvalRows(k)).toBe(0);
    expect(await count(u)).toBe(0);
    const k2 = await key(u, true);
    await db().query('update auth.webauthn_credentials set credential_id = $2 where id = $1', [k2, randomBytes(32)]);
    expect((await outbox(u)).filter((r) => r.kind === 'passkey_key_replaced')).toHaveLength(2);
    expect(await approvalRows(k2)).toBe(0);
  });

  test('DATA-AUTH-014 deleting a customer by cascade succeeds and queues nothing for the removed keys', async () => {
    const u = await user();
    await key(u);
    await key(u);
    await db().query('delete from auth.users where id = $1', [u]);
    expect((await outbox(u)).map((r) => r.kind)).toEqual(['passkey_added', 'passkey_added']);
  });

  async function staffWithTwoKeys(): Promise<{ u: string; keys: string[] }> {
    const u = await user('admin');
    const keys = [await key(u, true), await key(u, true)];
    return { u, keys };
  }

  test('DATA-AUTH-014 deleting staff with user_roles still present queues one row per key: staff, not notified', async () => {
    const { u, keys } = await staffWithTwoKeys();
    await db().query('delete from auth.users where id = $1', [u]);
    const removed = (await outbox(u)).filter((r) => r.kind === 'passkey_removed');
    expect(removed).toHaveLength(2);
    for (const r of removed) expect(r).toMatchObject({ subject_is_staff: true, notify_subject: false, subject_email: null });
    for (const k of keys) expect(await approvalRows(k)).toBe(0);
  });

  test('DATA-AUTH-014 deleting staff after user_roles was removed first still reads as staff (the approval row is the clue)', async () => {
    const { u } = await staffWithTwoKeys();
    await db().query('delete from public.user_roles where user_id = $1', [u]);
    await db().query('delete from auth.users where id = $1', [u]);
    const removed = (await outbox(u)).filter((r) => r.kind === 'passkey_removed');
    expect(removed).toHaveLength(2);
    for (const r of removed) expect(r).toMatchObject({ subject_is_staff: true, notify_subject: false });
  });

  test('DATA-AUTH-014 a failing outbox write never blocks deleting a key, and the approval row is still removed', async () => {
    const u = await user('admin');
    const k = await key(u, true);
    await key(u, true);
    expect(await count(u)).toBe(2);
    await db().query('alter table private.passkey_notification_outbox add constraint outbox_fail check (false) not valid');
    await db().query('delete from auth.webauthn_credentials where id = $1', [k]);
    expect(await approvalRows(k)).toBe(0);
    expect(await count(u)).toBe(1);
    expect((await outbox(u)).filter((r) => r.kind === 'passkey_removed')).toHaveLength(0);
  });

  test('DATA-AUTH-014 a failing outbox write does not block a key replacement and the approval row is still removed', async () => {
    const u = await user('admin');
    const k = await key(u, true);
    await db().query('alter table private.passkey_notification_outbox add constraint outbox_fail check (false) not valid');
    await db().query('update auth.webauthn_credentials set public_key = $2 where id = $1', [k, randomBytes(32)]);
    expect(await approvalRows(k)).toBe(0);
    expect(await count(u)).toBe(0);
  });

  test('DATA-AUTH-014 with the trigger disabled the approved count still drops when a key is deleted', async () => {
    const u = await user('admin');
    const k1 = await key(u, true);
    await key(u, true);
    await db().query('alter table auth.webauthn_credentials disable trigger passkey_credentials_notify');
    await db().query('delete from auth.webauthn_credentials where id = $1', [k1]);
    expect(await approvalRows(k1)).toBe(1);
    expect(await count(u)).toBe(1);
    expect((await outbox(u)).filter((r) => r.kind === 'passkey_removed')).toHaveLength(0);
  });

  test('DATA-AUTH-014 with the trigger disabled a key whose credential_id changed is no longer counted (a public_key-only change still is: known residual)', async () => {
    const u = await user('admin');
    const k1 = await key(u, true);
    const k2 = await key(u, true);
    const k3 = await key(u, true);
    expect(await count(u)).toBe(3);
    await db().query('alter table auth.webauthn_credentials disable trigger passkey_credentials_notify');
    await db().query('update auth.webauthn_credentials set credential_id = $2, public_key = $3 where id = $1', [k1, randomBytes(32), randomBytes(32)]);
    await db().query('update auth.webauthn_credentials set public_key = $2 where id = $1', [k2, randomBytes(32)]);
    expect(await approvalRows(k1)).toBe(1);
    expect(await approvalRows(k3)).toBe(1);
    // k1 (credential_id changed) is not counted; k2 (public_key only) and k3 still are
    expect(await count(u)).toBe(2);
  });

  test('DATA-AUTH-014 the trigger function is owned by postgres, SECURITY DEFINER, and anon / authenticated / service_role cannot run it', async () => {
    const r = await db().query(
      `select p.prosecdef, p.proowner::regrole::text as owner, p.proconfig,
              has_function_privilege('anon', p.oid, 'EXECUTE') as a,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as u,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as s,
              (select t.tgenabled from pg_trigger t where t.tgname = 'passkey_credentials_notify' and not t.tgisinternal) as enabled
         from pg_proc p where p.oid = 'private.passkey_credentials_notify()'::regprocedure`,
    );
    expect(r.rows[0]).toMatchObject({ prosecdef: true, owner: 'postgres', a: false, u: false, s: false, enabled: 'O' });
    expect(r.rows[0].proconfig).toContain('search_path=""');
  });

  test('DATA-AUTH-014 a key the staff user added straight in GoTrue is not counted as approved', async () => {
    const u = await user('admin');
    await key(u, true);
    await key(u);
    expect(await count(u)).toBe(1);
    const added = await outbox(u);
    expect(added.map((r) => [r.kind, r.subject_is_staff, r.notify_subject])).toEqual([
      ['passkey_added', true, true],
      ['passkey_added', true, true],
    ]);
  });

  test('DATA-AUTH-014 deleting a staff key that was never approved is staff through user_roles alone', async () => {
    const u = await user('admin');
    const k = await key(u);
    await db().query('delete from auth.webauthn_credentials where id = $1', [k]);
    const rows = await outbox(u);
    expect(rows.map((r) => [r.kind, r.subject_is_staff, r.notify_subject])).toEqual([
      ['passkey_added', true, true],
      ['passkey_removed', true, true],
    ]);
  });

  test('DATA-AUTH-014 a demoted staff user whose approval survives is still staff when the key is deleted (approval is the clue)', async () => {
    const u = await user('admin');
    const k = await key(u, true);
    await db().query('delete from public.user_roles where user_id = $1', [u]);
    await db().query('delete from auth.webauthn_credentials where id = $1', [k]);
    const removed = (await outbox(u)).filter((r) => r.kind === 'passkey_removed');
    expect(removed).toEqual([expect.objectContaining({ subject_is_staff: true, notify_subject: true })]);
    expect(await approvalRows(k)).toBe(0);
  });
});
