/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb, LOCAL_DATABASE_URL, type PgClient } from './helpers/local-db';

// Passkey stage 3b Task 14 (migrations A, G, H): three new notice kinds for the managers (staff_redo_issued, staff_invited,
// staff_demoted), the actor_email column, the recipient rule and the enqueue helper that the issue core and staff_demote call.
// DB suite: needs the local Supabase (DATABASE_URL). Every case runs in a transaction that is rolled back.
const { Client } = require('pg');

const ENQUEUE_FN = 'private.passkey_enqueue_staff_notice(text,uuid,uuid)';
const hashOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();
const NEW_KINDS = ['staff_redo_issued', 'staff_invited', 'staff_demoted'];

describeLocalDb('passkey staff manager notices (migrations A, G, H)', () => {
  let admin: PgClient;
  const db = () => admin;
  beforeAll(async () => {
    const url = new URL(LOCAL_DATABASE_URL as string);
    url.username = 'supabase_admin';
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    admin = c as PgClient;
  });
  afterAll(async () => { await admin.end(); });
  beforeEach(async () => {
    await db().query('begin');
    await db().query('delete from private.passkey_notification_outbox');
    // only the admins this case creates are active admins
    await db().query(
      `update public.user_roles set active = false where role_id in (select id from public.roles where code in ('admin', 'supporter'))`,
    );
  });
  afterEach(async () => { await db().query('rollback'); });

  async function user(email: string, roleCode?: string, opts: { banned?: boolean; deleted?: boolean; expired?: boolean } = {}): Promise<string> {
    const r = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, banned_until, deleted_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, $2::jsonb, now(), now(),
               case when $3::boolean then now() + interval '1 day' end, case when $4::boolean then now() end)
       returning id::text as id`,
      [email, JSON.stringify({ role: roleCode ?? 'user' }), opts.banned ?? false, opts.deleted ?? false],
    );
    const id: string = r.rows[0].id;
    if (roleCode) {
      await db().query(
        `insert into public.user_roles (user_id, role_id, active, expires_at)
         select $1, r.id, true, case when $3::boolean then now() - interval '1 day' end from public.roles r where r.code = $2`,
        [id, roleCode, opts.expired ?? false],
      );
    }
    return id;
  }
  const mail = (tag: string) => `${tag}-${randomUUID()}@example.com`;
  const issue = (target: string, role: string, kind: string, actor: string | null) =>
    db().query('select public.staff_invite_issue($1,$2,$3,$4,$5,$6,$7) as id', [target, role, kind, actor, 'reason', hashOf(randomUUID()), 86400]);
  const demote = (actor: string, target: string) => db().query('select public.staff_demote($1,$2)', [actor, target]);
  const notices = async (userId?: string) =>
    (await db().query(
      `select kind, user_id::text as user_id, subject_email, actor_email, passkey_id, friendly_name, subject_is_staff, notify_subject, status
         from private.passkey_notification_outbox where kind = any($1::text[]) and ($2::uuid is null or user_id = $2)
        order by seq`,
      [NEW_KINDS, userId ?? null],
    )).rows;
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
  async function newRow(kind: string, userId: string, extra: { notify?: boolean; staff?: boolean } = {}): Promise<string> {
    const r = await db().query(
      `insert into private.passkey_notification_outbox (user_id, kind, subject_is_staff, notify_subject, subject_email, actor_email)
       values ($1, $2, $3, $4, 'subject@example.com', 'actor@example.com') returning id::text as id`,
      [userId, kind, extra.staff ?? false, extra.notify ?? false],
    );
    return r.rows[0].id;
  }
  const recipients = async (id: string) =>
    (await db().query('select lower(email) as email, audience from public.passkey_notification_recipients($1) order by 1', [id])).rows;

  test('DATA-AUTH-022 the private enqueue helper has no EXECUTE for anon, authenticated, service_role or PUBLIC', async () => {
    const r = await db().query(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon, has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
              has_function_privilege('service_role', $1, 'EXECUTE') as svc,
              exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where p.oid = $1::regprocedure and a.grantee = 0) as pub,
              (select p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig @> array['search_path=""']
                 from pg_proc p where p.oid = $1::regprocedure) as attrs`,
      [ENQUEUE_FN],
    );
    expect(r.rows[0]).toEqual({ anon: false, auth: false, svc: false, pub: false, attrs: true });
  });

  test('DATA-AUTH-022 the helper refuses a kind other than the three manager notices', async () => {
    const actor = await user(mail('actor'), 'admin');
    const target = await user(mail('target'), 'admin');
    for (const kind of ['passkey_added', 'last_resort', 'staff_unknown']) {
      const e = await fails(() => db().query('select private.passkey_enqueue_staff_notice($1,$2,$3)', [kind, target, actor]));
      expect(e).not.toBeNull();
    }
    expect(await notices()).toHaveLength(0);
  });

  test('DATA-AUTH-022 redo queues staff_redo_issued with the actor and target addresses, subject_is_staff true, notify_subject false', async () => {
    const actorMail = mail('actor');
    const targetMail = mail('target');
    const actor = await user(actorMail, 'admin');
    const target = await user(targetMail, 'supporter');
    await issue(target, 'admin', 'redo', actor);
    const rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'staff_redo_issued', user_id: target, subject_email: targetMail, actor_email: actorMail,
      passkey_id: null, friendly_name: null, subject_is_staff: true, notify_subject: false, status: 'pending',
    });
  });

  test('DATA-AUTH-022 invite and promote queue staff_invited (subject_is_staff false)', async () => {
    const actorMail = mail('actor');
    const actor = await user(actorMail, 'admin');
    for (const kind of ['invite', 'promote']) {
      const targetMail = mail(kind);
      const target = await user(targetMail);
      await issue(target, 'supporter', kind, actor);
      const rows = await notices(target);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'staff_invited', subject_email: targetMail, actor_email: actorMail,
        passkey_id: null, friendly_name: null, subject_is_staff: false, notify_subject: false,
      });
    }
  });

  test('DATA-AUTH-022 staff_demote queues staff_demoted (subject_is_staff true), after the role is switched off', async () => {
    const actorMail = mail('actor');
    const targetMail = mail('target');
    const actor = await user(actorMail, 'admin');
    const target = await user(targetMail, 'admin');
    await demote(actor, target);
    const rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'staff_demoted', user_id: target, subject_email: targetMail, actor_email: actorMail,
      passkey_id: null, friendly_name: null, subject_is_staff: true, notify_subject: false,
    });
  });

  test('DATA-AUTH-022 the last resort (staff_invite_issue_manual) queues no manager notice', async () => {
    const targetMail = mail('lr');
    await user(targetMail, 'admin');
    await db().query('select private.staff_invite_issue_manual($1)', [targetMail]);
    expect(await notices()).toHaveLength(0);
  });

  test('DATA-AUTH-022 a refused issue or demote leaves no manager notice behind', async () => {
    const lone = await user(mail('lone'), 'admin');
    const last = await fails(() => issue(lone, 'admin', 'redo', lone));
    expect(last).toMatchObject({ message: 'LAST_ADMIN_REQUIRED' });
    const other = await user(mail('other'), 'admin');
    const self = await fails(() => issue(other, 'admin', 'redo', other));
    expect(self).toMatchObject({ message: 'SELF_ROLE_CHANGE_FORBIDDEN' });
    const selfDemote = await fails(() => demote(other, other));
    expect(selfDemote).toMatchObject({ message: 'SELF_ROLE_CHANGE_FORBIDDEN' });
    const notAdmin = await fails(async () => demote(await user(mail('c')), other));
    expect(notAdmin).toMatchObject({ message: 'ROLE_PERMISSION_FORBIDDEN' });
    expect(await notices()).toHaveLength(0);
  });

  // 正の対照: 上の試験は「何も積まれない」だけを見るので、積む処理が壊れていても通ってしまう。
  // 同じ準備から断りの原因だけを除いた操作は、必ず1行積むことを確かめる（これが通る限り、上の「0行」に意味がある）
  test('DATA-AUTH-022 positive control: the same setups without the refusal do queue a manager notice', async () => {
    const actor = await user(mail('actor'), 'admin');
    const lone = await user(mail('lone'), 'admin');
    await issue(lone, 'admin', 'redo', actor); // 上の LAST_ADMIN_REQUIRED と SELF_ROLE_CHANGE_FORBIDDEN の redo から、断りの原因だけを除く
    expect((await notices(lone)).map((row: { kind: string }) => row.kind)).toEqual(['staff_redo_issued']);
    const target = await user(mail('target'), 'admin');
    await demote(actor, target); // 上の降格の断り（本人・店長でない操作者）から、断りの原因だけを除く
    expect((await notices(target)).map((row: { kind: string }) => row.kind)).toEqual(['staff_demoted']);
    expect(await notices()).toHaveLength(2);
  });

  test('DATA-AUTH-022 the kind CHECK allows the three new kinds and actor_email is nullable text', async () => {
    const target = await user(mail('t'));
    for (const kind of NEW_KINDS) {
      await db().query(`insert into private.passkey_notification_outbox (user_id, kind, subject_is_staff, notify_subject) values ($1, $2, false, false)`, [target, kind]);
    }
    const bogus = await fails(() => db().query(`insert into private.passkey_notification_outbox (user_id, kind, subject_is_staff, notify_subject) values ($1, 'nope', false, false)`, [target]));
    expect(bogus).toMatchObject({ code: '23514' });
    const col = (await db().query(
      `select data_type, is_nullable from information_schema.columns
        where table_schema = 'private' and table_name = 'passkey_notification_outbox' and column_name = 'actor_email'`,
    )).rows[0];
    expect(col).toEqual({ data_type: 'text', is_nullable: 'YES' });
  });

  test('DATA-AUTH-022 recipients of a manager notice: active admins except the target, even when notify_subject is true; the actor is included', async () => {
    const target = await user('target@example.com', 'admin');
    await user('actor@example.com', 'admin');
    await user('second@example.com', 'admin');
    await user('Second@Example.com', 'admin');
    await user('supporter@example.com', 'supporter');
    await user('stopped@example.com', 'admin', { banned: true });
    await user('deleted@example.com', 'admin', { deleted: true });
    await user('expired@example.com', 'admin', { expired: true });
    await user('', 'admin');
    for (const kind of NEW_KINDS) {
      const id = await newRow(kind, target, { notify: true, staff: kind !== 'staff_invited' });
      expect(await recipients(id)).toEqual([
        { email: 'actor@example.com', audience: 'admin' },
        { email: 'second@example.com', audience: 'admin' },
      ]);
    }
  });

  test('DATA-AUTH-022 recipients of a manager notice about a customer target (staff_invited): still every active admin', async () => {
    const target = await user('invitee@example.com');
    await user('a@example.com', 'admin');
    const id = await newRow('staff_invited', target);
    expect(await recipients(id)).toEqual([{ email: 'a@example.com', audience: 'admin' }]);
  });

  test('DATA-AUTH-019 the recipient rule of the old kinds is unchanged (subject first, then every admin, subject once)', async () => {
    const boss = await user('Boss@Example.com', 'admin');
    await user('other@example.com', 'admin');
    const id = (await db().query(
      `insert into private.passkey_notification_outbox (user_id, kind, subject_is_staff, notify_subject, subject_email)
       values ($1, 'passkey_added', true, true, 'boss@example.com') returning id::text as id`, [boss])).rows[0].id;
    expect(await recipients(id)).toEqual([
      { email: 'boss@example.com', audience: 'subject_staff' },
      { email: 'other@example.com', audience: 'admin' },
    ]);
  });

  test('DATA-AUTH-022 claim_passkey_notification returns actor_email as its last column', async () => {
    const target = await user(mail('t'), 'admin');
    const id = await newRow('staff_demoted', target, { staff: true });
    const r = await db().query('select * from public.claim_passkey_notification(60)');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ id, kind: 'staff_demoted', subject_email: 'subject@example.com', actor_email: 'actor@example.com' });
    expect(Object.keys(r.rows[0]).pop()).toBe('actor_email');
  });
});
