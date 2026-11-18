/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';

// Passkey stage 2 Task 8 (migration G): the DB functions a worker uses to claim and finish passkey notification rows.
// DB suite: needs the local Supabase (DATABASE_URL). Every case runs in a transaction that is rolled back.
// Inside one transaction now() does not move, so "later" is made by writing next_attempt_at / lease_expires_at directly.
const FUNCTIONS = [
  'public.claim_passkey_notification(integer)',
  'public.complete_passkey_notification(uuid,uuid)',
  'public.fail_passkey_notification(uuid,uuid,text,integer,boolean)',
  'public.skip_passkey_notification(uuid,uuid,text)',
  'public.passkey_notification_recipients(uuid)',
];

describeLocalDb('passkey notification sending functions', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    // Rows and admins left by other suites would change "the oldest due row" and "every admin".
    await db().query('delete from private.passkey_notification_outbox');
    await db().query(
      `update public.user_roles set active = false where role_id in (select id from public.roles where code in ('admin', 'supporter'))`,
    );
  });
  afterEach(async () => { await db().query('rollback'); });

  async function user(email?: string | null): Promise<string> {
    const r = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [email === undefined ? `passkey-notify-${randomUUID()}@example.com` : email],
    );
    return r.rows[0].id;
  }
  async function role(userId: string, code: 'admin' | 'supporter', opts: { active?: boolean; expires?: string | null } = {}): Promise<void> {
    await db().query(
      `insert into public.user_roles (user_id, role_id, active, expires_at)
       select $1, r.id, $2, $3 from public.roles r where r.code = $4`,
      [userId, opts.active ?? true, opts.expires ?? null, code],
    );
  }
  async function row(over: Record<string, unknown> = {}): Promise<string> {
    const v = {
      user_id: randomUUID(), kind: 'passkey_added', subject_is_staff: false, notify_subject: true,
      subject_email: 'subject@example.com', status: 'pending', attempts: 0, next_attempt_at: null as string | null, ...over,
    };
    const r = await db().query(
      `insert into private.passkey_notification_outbox
         (user_id, kind, subject_is_staff, notify_subject, subject_email, status, attempts, next_attempt_at,
          lease_token, lease_expires_at)
       values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now()),
               case when $6 = 'sending' then gen_random_uuid() end,
               case when $6 = 'sending' then now() + interval '5 minutes' end)
       returning id::text as id`,
      [v.user_id, v.kind, v.subject_is_staff, v.notify_subject, v.subject_email, v.status, v.attempts, v.next_attempt_at],
    );
    return r.rows[0].id;
  }
  const get = async (id: string) =>
    (await db().query('select * from private.passkey_notification_outbox where id = $1', [id])).rows[0];
  const claim = async (secs = 60) =>
    (await db().query('select * from public.claim_passkey_notification($1)', [secs])).rows;
  async function expectCode(sql: string, params: unknown[], code: string): Promise<void> {
    await db().query('savepoint e');
    await expect(db().query(sql, params)).rejects.toMatchObject({ code });
    await db().query('rollback to savepoint e');
  }
  async function asRole<T>(roleName: string, run: () => Promise<T>): Promise<T> {
    await db().query('savepoint r');
    try {
      await db().query(`set local role ${roleName}`);
      return await run();
    } finally {
      await db().query('rollback to savepoint r');
    }
  }

  test('DATA-AUTH-019 claim returns the oldest due row only, as sending with attempts + 1 and a lease', async () => {
    const future = await row({ next_attempt_at: new Date(Date.now() + 3_600_000).toISOString() });
    await row({ status: 'sent' });
    await row({ status: 'dead' });
    const first = await row();
    const second = await row();
    const got = await claim(120);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: first, attempts: 1, kind: 'passkey_added', subject_email: 'subject@example.com' });
    expect(got[0].lease_token).toEqual(expect.any(String));
    const after = await get(first);
    expect(after.status).toBe('sending');
    expect(after.lease_token).toBe(got[0].lease_token);
    const secs = (await db().query(`select extract(epoch from lease_expires_at - now())::int as s from private.passkey_notification_outbox where id = $1`, [first])).rows[0].s;
    expect(secs).toBe(120);
    expect((await get(second)).status).toBe('pending');
    expect((await get(future)).status).toBe('pending');
  });

  test('DATA-AUTH-019 claim does not return a row that is being held, and returns nothing when nothing is due', async () => {
    const id = await row();
    expect(await claim()).toHaveLength(1);
    expect(await claim()).toEqual([]);
    expect((await get(id)).attempts).toBe(1);
  });

  test('DATA-AUTH-019 claim also takes retry_wait rows once they are due', async () => {
    const id = await row({ status: 'retry_wait', attempts: 2 });
    const got = await claim();
    expect(got[0]).toMatchObject({ id, attempts: 3 });
  });

  test('DATA-AUTH-019 an expired lease goes back to retry_wait with the fail backoff, is taken again once due; at 9 attempts it is dead', async () => {
    const id = await row();
    const [first] = await claim();
    await db().query(`update private.passkey_notification_outbox set lease_expires_at = now() where id = $1`, [id]);
    expect(await claim()).toEqual([]);
    const reaped = await get(id);
    expect(reaped).toMatchObject({ status: 'retry_wait', attempts: 1, lease_token: null, lease_expires_at: null, last_error_code: 'lease_expired' });
    const wait = async () =>
      Number((await db().query(`select extract(epoch from next_attempt_at - now()) as s from private.passkey_notification_outbox where id = $1`, [id])).rows[0].s);
    expect(await wait()).toBe(60);
    await db().query(`update private.passkey_notification_outbox set next_attempt_at = now() where id = $1`, [id]);
    const [again] = await claim();
    expect(again).toMatchObject({ id, attempts: 2 });
    expect(again.lease_token).not.toBe(first.lease_token);
    await db().query(`update private.passkey_notification_outbox set lease_expires_at = now() where id = $1`, [id]);
    await claim();
    expect(await wait()).toBe(120);

    const spent = await row({ status: 'sending', attempts: 9 });
    await db().query(`update private.passkey_notification_outbox set lease_expires_at = now() where id = $1`, [spent]);
    expect(await claim()).toEqual([]);
    const dead = await get(spent);
    expect(dead).toMatchObject({ status: 'dead', lease_token: null, lease_expires_at: null, last_error_code: 'lease_expired' });
    expect(dead.finished_at).not.toBeNull();
  });

  test('DATA-AUTH-019 claim refuses a lease outside 30..900 seconds with 22023', async () => {
    await row();
    for (const secs of [0, 29, 901, -1]) {
      await expectCode('select * from public.claim_passkey_notification($1)', [secs], '22023');
    }
    await expectCode('select * from public.claim_passkey_notification(null)', [], '22023');
    expect(await claim(30)).toHaveLength(1);
    await row();
    expect(await claim(900)).toHaveLength(1);
  });

  test('DATA-AUTH-019 complete marks sent only with the matching lease token', async () => {
    const id = await row();
    const [c] = await claim();
    const wrong = await db().query('select public.complete_passkey_notification($1,$2) as ok', [id, randomUUID()]);
    expect(wrong.rows[0].ok).toBe(false);
    expect(await get(id)).toMatchObject({ status: 'sending', lease_token: c.lease_token });
    const ok = await db().query('select public.complete_passkey_notification($1,$2) as ok', [id, c.lease_token]);
    expect(ok.rows[0].ok).toBe(true);
    const done = await get(id);
    expect(done).toMatchObject({ status: 'sent', lease_token: null, lease_expires_at: null });
    expect(done.sent_at).not.toBeNull();
    expect(done.finished_at).not.toBeNull();
    const twice = await db().query('select public.complete_passkey_notification($1,$2) as ok', [id, c.lease_token]);
    expect(twice.rows[0].ok).toBe(false);
  });

  test('DATA-AUTH-019 fail waits 2^(attempts-1) minutes at least, or the longer retry-after, and writes the error code', async () => {
    const id = await row();
    const [c1] = await claim();
    const wrong = await db().query('select public.fail_passkey_notification($1,$2,$3,$4) as ok', [id, randomUUID(), 'smtp_error', 0]);
    expect(wrong.rows[0].ok).toBe(false);
    expect((await get(id)).status).toBe('sending');

    const ok = await db().query('select public.fail_passkey_notification($1,$2,$3,$4) as ok', [id, c1.lease_token, 'smtp_error', 0]);
    expect(ok.rows[0].ok).toBe(true);
    const wait = async () =>
      Number((await db().query(`select extract(epoch from next_attempt_at - now()) as s from private.passkey_notification_outbox where id = $1`, [id])).rows[0].s);
    expect(await get(id)).toMatchObject({ status: 'retry_wait', last_error_code: 'smtp_error', lease_token: null, lease_expires_at: null });
    expect(await wait()).toBe(60);

    await db().query(`update private.passkey_notification_outbox set next_attempt_at = now() where id = $1`, [id]);
    const [c2] = await claim();
    await db().query('select public.fail_passkey_notification($1,$2,$3,$4)', [id, c2.lease_token, 'smtp_error', 0]);
    expect(await wait()).toBe(120);

    await db().query(`update private.passkey_notification_outbox set next_attempt_at = now() where id = $1`, [id]);
    const [c3] = await claim();
    await db().query('select public.fail_passkey_notification($1,$2,$3,$4)', [id, c3.lease_token, 'rate_limited', 3600]);
    expect(await wait()).toBe(3600);
    expect((await get(id)).last_error_code).toBe('rate_limited');
  });

  test('DATA-AUTH-019 fail caps the backoff at 128 minutes and makes the 9th failure dead', async () => {
    const id = await row({ status: 'retry_wait', attempts: 7 });
    const [c8] = await claim();
    expect(c8.attempts).toBe(8);
    await db().query('select public.fail_passkey_notification($1,$2,$3,$4)', [id, c8.lease_token, 'smtp_error', null]);
    expect(Number((await db().query(`select extract(epoch from next_attempt_at - now()) as s from private.passkey_notification_outbox where id = $1`, [id])).rows[0].s)).toBe(7680);
    expect((await get(id)).status).toBe('retry_wait');

    await db().query(`update private.passkey_notification_outbox set next_attempt_at = now() where id = $1`, [id]);
    const [c9] = await claim();
    expect(c9.attempts).toBe(9);
    const r = await db().query('select public.fail_passkey_notification($1,$2,$3,$4) as ok', [id, c9.lease_token, 'smtp_error', 0]);
    expect(r.rows[0].ok).toBe(true);
    const dead = await get(id);
    expect(dead).toMatchObject({ status: 'dead', last_error_code: 'smtp_error', lease_token: null });
    expect(dead.finished_at).not.toBeNull();
    expect(await claim()).toEqual([]);
  });

  const pauseState = async () =>
    (await db().query('select paused, reason, next_probe_at from private.order_email_send_pause where id')).rows[0];
  // The local pause row may be left paused by other suites / E2E; start from a known state (rolled back with the test).
  const clearPause = async () => {
    await db().query(`update private.order_email_send_pause set paused = false, reason = null, paused_at = null, next_probe_at = null where id`);
  };
  const failNoCount = async (id: string, token: string, code = 'quota_monthly') =>
    db().query('select public.fail_passkey_notification($1,$2,$3,$4,false) as ok', [id, token, code, 0]);

  test('DATA-AUTH-019 fail with _count_attempt false gives the attempt back, is due after the retry seconds, never dead, and pauses order mail in the same transaction', async () => {
    await clearPause();
    const id = await row({ status: 'retry_wait', attempts: 8 });
    const [c9] = await claim();
    expect(c9.attempts).toBe(9);
    expect((await pauseState()).paused).toBe(false);
    const r = await db().query('select public.fail_passkey_notification($1,$2,$3,$4,false) as ok', [id, c9.lease_token, 'quota_daily', 300]);
    expect(r.rows[0].ok).toBe(true);
    const after = await get(id);
    expect(after).toMatchObject({ status: 'retry_wait', attempts: 8, last_error_code: 'quota_daily', lease_token: null, lease_expires_at: null, finished_at: null });
    expect(Number((await db().query(`select extract(epoch from next_attempt_at - now()) as s from private.passkey_notification_outbox where id = $1`, [id])).rows[0].s)).toBeGreaterThanOrEqual(900 - 1);
    // quota_daily waits for the pause's own next probe time (UTC midnight) like order mail
    expect((await db().query(`select o.next_attempt_at >= p.next_probe_at as ok from private.passkey_notification_outbox o, private.order_email_send_pause p where o.id = $1 and p.id`, [id])).rows[0].ok).toBe(true);
    expect(await pauseState()).toMatchObject({ paused: true, reason: 'quota_daily' });
    // not due yet: nothing to claim until the row's own backoff has passed
    expect(await claim()).toEqual([]);
    await db().query(`update private.passkey_notification_outbox set next_attempt_at = now() where id = $1`, [id]);
    const [again] = await claim();
    expect(again.attempts).toBe(9);
    // a wrong token changes nothing (and pauses nothing new)
    const wrong = await db().query('select public.fail_passkey_notification($1,$2,$3,$4,false) as ok', [id, randomUUID(), 'quota_daily', 0]);
    expect(wrong.rows[0].ok).toBe(false);
    expect((await get(id)).status).toBe('sending');
  });

  test('DATA-AUTH-019 claim while the shared pause is on: a config-failed row not yet due blocks every other row; once due only it is claimed', async () => {
    await clearPause();
    const probe = await row();
    const [c1] = await claim();
    await failNoCount(probe, c1.lease_token);
    const other1 = await row();
    const other2 = await row();
    expect((await pauseState()).paused).toBe(true);
    expect(await claim()).toEqual([]);
    await db().query(`update private.passkey_notification_outbox set next_attempt_at = now() where id = $1`, [probe]);
    const got = await claim();
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe(probe);
    expect([other1, other2]).not.toContain(got[0].id);
    // the probe row is held now (sending): the others still wait
    expect(await claim()).toEqual([]);
  });

  test('DATA-AUTH-019 claim while the shared pause is on and no row has failed on config: only one normal row (the first probe)', async () => {
    await clearPause();
    await db().query(`select private.set_order_email_pause('config_api_key')`);
    const a = await row();
    await row();
    const first = await claim();
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe(a);
  });

  test('DATA-AUTH-019 claim when the pause is off ignores the config-failed marker and claims normally', async () => {
    await clearPause();
    const id = await row({ status: 'retry_wait' });
    await db().query(`update private.passkey_notification_outbox set last_error_code = 'quota_daily', next_attempt_at = now() + interval '1 hour' where id = $1`, [id]);
    const other = await row();
    const got = await claim();
    expect(got.map((x: { id: string }) => x.id)).toEqual([other]);
  });

  test('DATA-AUTH-019 fail with _count_attempt false and a code the shared pause does not know raises 22023 and leaves the row untouched', async () => {
    const id = await row();
    const [c1] = await claim();
    await expectCode('select public.fail_passkey_notification($1,$2,$3,$4,false)', [id, c1.lease_token, 'smtp_error', 0], '22023');
    expect((await get(id)).status).toBe('sending');
  });

  test('DATA-AUTH-019 complete clears the shared order mail send pause (the passkey worker probes while it is paused)', async () => {
    await db().query(`select private.set_order_email_pause('config_api_key')`);
    expect((await pauseState()).paused).toBe(true);
    const id = await row();
    const [c1] = await claim();
    const wrong = await db().query('select public.complete_passkey_notification($1,$2) as ok', [id, randomUUID()]);
    expect(wrong.rows[0].ok).toBe(false);
    expect((await pauseState()).paused).toBe(true);
    const ok = await db().query('select public.complete_passkey_notification($1,$2) as ok', [id, c1.lease_token]);
    expect(ok.rows[0].ok).toBe(true);
    expect(await pauseState()).toMatchObject({ paused: false, reason: null, next_probe_at: null });
  });

  test('DATA-AUTH-019 fail caps a huge retry-after at 86400 seconds and treats a negative one as zero', async () => {
    const id = await row();
    const [c1] = await claim();
    await db().query('select public.fail_passkey_notification($1,$2,$3,$4)', [id, c1.lease_token, 'smtp_error', 100000000]);
    const wait = async () =>
      Number((await db().query(`select extract(epoch from next_attempt_at - now()) as s from private.passkey_notification_outbox where id = $1`, [id])).rows[0].s);
    expect(await wait()).toBe(86400);
    await db().query(`update private.passkey_notification_outbox set next_attempt_at = now() where id = $1`, [id]);
    const [c2] = await claim();
    await db().query('select public.fail_passkey_notification($1,$2,$3,$4)', [id, c2.lease_token, 'smtp_error', -500]);
    expect(await wait()).toBe(120);
  });

  test('DATA-AUTH-019 fail and skip refuse an error code that is not lower snake case with 22023', async () => {
    const id = await row();
    const [c] = await claim();
    await expectCode('select public.fail_passkey_notification($1,$2,$3,$4)', [id, c.lease_token, 'Bad Code', 0], '22023');
    await expectCode('select public.fail_passkey_notification($1,$2,$3,$4)', [id, c.lease_token, null, 0], '22023');
    await expectCode('select public.skip_passkey_notification($1,$2,$3)', [id, c.lease_token, 'a'.repeat(65)], '22023');
    expect((await get(id)).status).toBe('sending');
  });

  test('DATA-AUTH-019 skip marks skipped only with the matching lease token', async () => {
    const id = await row({ notify_subject: false, subject_email: null });
    const [c] = await claim();
    expect((await db().query('select public.skip_passkey_notification($1,$2,$3) as ok', [id, randomUUID(), 'no_recipient'])).rows[0].ok).toBe(false);
    expect((await db().query('select public.skip_passkey_notification($1,$2,$3) as ok', [id, c.lease_token, 'no_recipient'])).rows[0].ok).toBe(true);
    const s = await get(id);
    expect(s).toMatchObject({ status: 'skipped', last_error_code: 'no_recipient', lease_token: null, lease_expires_at: null });
    expect(s.finished_at).not.toBeNull();
  });

  test('DATA-AUTH-019 the lease CHECK ties lease_token and lease_expires_at to status sending', async () => {
    const id = await row();
    await expectCode(`update private.passkey_notification_outbox set status = 'sending' where id = $1`, [id], '23514');
    await expectCode(`update private.passkey_notification_outbox set lease_token = gen_random_uuid(), lease_expires_at = now() where id = $1`, [id], '23514');
    await expectCode(`update private.passkey_notification_outbox set last_error_code = 'Bad' where id = $1`, [id], '23514');
  });

  test('DATA-AUTH-019 recipients of a customer row: the subject only, as subject_customer', async () => {
    const admin = await user();
    await role(admin, 'admin');
    const id = await row({ subject_is_staff: false, subject_email: 'cust@example.com' });
    const r = await db().query('select * from public.passkey_notification_recipients($1)', [id]);
    expect(r.rows).toEqual([{ email: 'cust@example.com', audience: 'subject_customer' }]);
  });

  test('DATA-AUTH-019 recipients of a staff row: the subject as subject_staff, then every active unexpired admin', async () => {
    const a1 = await user('a1@example.com');
    const a2 = await user('a2@example.com');
    const gone = await user('expired@example.com');
    const off = await user('inactive@example.com');
    const sup = await user('supporter@example.com');
    await role(a1, 'admin');
    await role(a2, 'admin', { expires: '2999-01-01T00:00:00Z' });
    await role(gone, 'admin', { expires: '2000-01-01T00:00:00Z' });
    await role(off, 'admin', { active: false });
    await role(sup, 'supporter');
    const id = await row({ subject_is_staff: true, subject_email: 'staff@example.com' });
    const r = await db().query('select * from public.passkey_notification_recipients($1)', [id]);
    expect(r.rows).toEqual([
      { email: 'staff@example.com', audience: 'subject_staff' },
      { email: 'a1@example.com', audience: 'admin' },
      { email: 'a2@example.com', audience: 'admin' },
    ]);
  });

  test('DATA-AUTH-019 recipients: a subject who is also an admin appears once, as subject_staff (case-insensitive)', async () => {
    const a1 = await user('Boss@Example.com');
    const a2 = await user('other@example.com');
    await role(a1, 'admin');
    await role(a2, 'admin');
    const id = await row({ subject_is_staff: true, subject_email: 'boss@example.com' });
    const r = await db().query('select * from public.passkey_notification_recipients($1)', [id]);
    expect(r.rows).toEqual([
      { email: 'boss@example.com', audience: 'subject_staff' },
      { email: 'other@example.com', audience: 'admin' },
    ]);
  });

  test('DATA-AUTH-019 recipients leave out an admin whose account is deleted or banned, and keep one whose ban has ended', async () => {
    const live = await user('live@example.com');
    const deleted = await user('deleted@example.com');
    const banned = await user('banned@example.com');
    const ended = await user('ended@example.com');
    for (const u of [live, deleted, banned, ended]) await role(u, 'admin');
    await db().query(`update auth.users set deleted_at = now() where id = $1`, [deleted]);
    await db().query(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [banned]);
    await db().query(`update auth.users set banned_until = now() - interval '1 day' where id = $1`, [ended]);
    const id = await row({ subject_is_staff: true, subject_email: 'staff@example.com' });
    const r = await db().query('select * from public.passkey_notification_recipients($1)', [id]);
    expect(r.rows).toEqual([
      { email: 'staff@example.com', audience: 'subject_staff' },
      { email: 'ended@example.com', audience: 'admin' },
      { email: 'live@example.com', audience: 'admin' },
    ]);
  });

  test('DATA-AUTH-019 recipients: notify_subject false leaves out the subject, an empty address is never returned', async () => {
    const a1 = await user('boss@example.com');
    const blank = await user('');
    await role(a1, 'admin');
    await role(blank, 'admin');
    const none = await user(null);
    await role(none, 'admin');
    const id = await row({ subject_is_staff: true, notify_subject: false, subject_email: null });
    expect((await db().query('select * from public.passkey_notification_recipients($1)', [id])).rows)
      .toEqual([{ email: 'boss@example.com', audience: 'admin' }]);
    const blankRow = await row({ subject_is_staff: false, subject_email: '   ' });
    expect((await db().query('select * from public.passkey_notification_recipients($1)', [blankRow])).rows).toEqual([]);
    expect((await db().query('select * from public.passkey_notification_recipients($1)', [randomUUID()])).rows).toEqual([]);
  });

  test('DATA-AUTH-019 the five functions: anon and authenticated cannot execute, service_role can, with the safe attributes', async () => {
    for (const f of FUNCTIONS) {
      const r = await db().query(
        `select has_function_privilege('anon', $1, 'EXECUTE') as a,
                has_function_privilege('authenticated', $1, 'EXECUTE') as u,
                has_function_privilege('service_role', $1, 'EXECUTE') as s,
                (select p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig @> array['search_path=""']
                   from pg_proc p where p.oid = $1::regprocedure) as attrs,
                exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) x where p.oid = $1::regprocedure and x.grantee = 0) as pub`,
        [f],
      );
      expect(r.rows[0]).toEqual({ a: false, u: false, s: true, attrs: true, pub: false });
    }
    for (const roleName of ['anon', 'authenticated']) {
      await expect(asRole(roleName, () => db().query('select * from public.claim_passkey_notification(60)'))).rejects.toMatchObject({ code: '42501' });
      await expect(asRole(roleName, () => db().query('select * from public.passkey_notification_recipients($1)', [randomUUID()]))).rejects.toMatchObject({ code: '42501' });
    }
    await asRole('service_role', async () => {
      expect((await db().query('select * from public.claim_passkey_notification(60)')).rows).toEqual([]);
    });
  });

  test('DATA-AUTH-019 rows queued by the stage 1a triggers (INSERT and DELETE of a key) can be claimed', async () => {
    const u = await user('owner@example.com');
    const credential = async () =>
      (await db().query(
        `insert into auth.webauthn_credentials (user_id, credential_id, public_key, friendly_name)
         values ($1, gen_random_bytes(32), gen_random_bytes(32), 'Phone') returning id::text as id`, [u])).rows[0].id;
    const k = await credential();
    await db().query('delete from auth.webauthn_credentials where id = $1', [k]);
    // an added-key row is held back for 30 seconds after it was queued; the delete row is not
    await db().query(`update private.passkey_notification_outbox set occurred_at = now() - interval '31 seconds' where kind = 'passkey_added'`);
    const first = await claim();
    expect(first[0]).toMatchObject({ user_id: u, kind: 'passkey_added', passkey_id: k, friendly_name: 'Phone', subject_email: 'owner@example.com', notify_subject: true, subject_is_staff: false });
    const second = await claim();
    expect(second[0]).toMatchObject({ user_id: u, kind: 'passkey_removed', passkey_id: k });
    const rec = await db().query('select * from public.passkey_notification_recipients($1)', [first[0].id]);
    expect(rec.rows).toEqual([{ email: 'owner@example.com', audience: 'subject_customer' }]);
  });

  test("DATA-AUTH-019 claim returns the credential's current name, not the name recorded at insert", async () => {
    const u = await user('owner@example.com');
    const k = (await db().query(
      `insert into auth.webauthn_credentials (user_id, credential_id, public_key, friendly_name)
       values ($1, gen_random_bytes(32), gen_random_bytes(32), 'Passkey') returning id::text as id`, [u])).rows[0].id;
    await db().query(`update auth.webauthn_credentials set friendly_name = 'Windows' where id = $1`, [k]);
    await db().query(`update private.passkey_notification_outbox set occurred_at = now() - interval '31 seconds' where kind = 'passkey_added'`);
    const added = await claim();
    expect(added[0]).toMatchObject({ kind: 'passkey_added', passkey_id: k, friendly_name: 'Windows' });
    expect((await get(added[0].id)).friendly_name).toBe('Windows');
    // a removed key has no credential row any more: the name recorded at delete time is returned
    await db().query('delete from auth.webauthn_credentials where id = $1', [k]);
    const removed = await claim();
    expect(removed[0]).toMatchObject({ kind: 'passkey_removed', passkey_id: k, friendly_name: 'Windows' });
  });

  test('DATA-AUTH-019 an added-key row is not claimed for 30 seconds after it was queued', async () => {
    const u = await user('owner@example.com');
    await db().query(
      `insert into auth.webauthn_credentials (user_id, credential_id, public_key, friendly_name)
       values ($1, gen_random_bytes(32), gen_random_bytes(32), 'Passkey')`, [u]);
    expect(await claim()).toEqual([]);
    await db().query(`update private.passkey_notification_outbox set occurred_at = now() - interval '31 seconds' where kind = 'passkey_added'`);
    expect(await claim()).toHaveLength(1);
  });
});

// Two real connections. Rows are committed (the first suite rolls back), so this block empties the outbox itself.
describeLocalDb('passkey notification claim from two connections', () => {
  let a: PgClient;
  let b: PgClient;
  const open = async (): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      ids.push((await a.query(
        `insert into private.passkey_notification_outbox (user_id, kind, subject_is_staff, notify_subject, subject_email)
         values (gen_random_uuid(), 'passkey_added', false, true, 'c@example.com') returning id::text as id`)).rows[0].id);
    }
    return ids;
  };
  beforeEach(async () => {
    a = await connectLocalDb();
    b = await connectLocalDb();
    await a.query('delete from private.passkey_notification_outbox');
  });
  afterEach(async () => {
    await a.query('rollback').catch(() => undefined);
    await b.query('rollback').catch(() => undefined);
    await a.query('delete from private.passkey_notification_outbox');
    await a.end();
    await b.end();
  });

  test('DATA-AUTH-019 a claim held open by one connection does not block or repeat in the other (SKIP LOCKED)', async () => {
    const [first, second] = await open();
    await a.query('begin');
    const got = (await a.query('select * from public.claim_passkey_notification(60)')).rows;
    expect(got[0].id).toBe(first);
    // Without FOR UPDATE SKIP LOCKED the second claim waits for the first transaction (or takes the same row).
    const outcome = await Promise.race([
      b.query('select * from public.claim_passkey_notification(60)').then((r) => r.rows),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 4000)),
    ]);
    await a.query('commit');
    expect(outcome).not.toBe('blocked');
    expect((outcome as Array<{ id: string }>).map((r) => r.id)).toEqual([second]);
    expect((await a.query('select count(*)::int as n from private.passkey_notification_outbox where status = $1', ['sending'])).rows[0].n).toBe(2);
  }, 20000);

  test('DATA-AUTH-019 claims run at the same time never return the same row', async () => {
    for (let round = 0; round < 10; round += 1) {
      await a.query('delete from private.passkey_notification_outbox');
      await open();
      const [x, y] = await Promise.all([
        a.query('select * from public.claim_passkey_notification(60)'),
        b.query('select * from public.claim_passkey_notification(60)'),
      ]);
      const ids = [...x.rows, ...y.rows].map((r) => r.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    }
  }, 30000);
});
