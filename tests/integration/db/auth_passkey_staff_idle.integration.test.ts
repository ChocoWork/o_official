/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LOCAL_DATABASE_URL, describeLocalDb, type PgClient } from './helpers/local-db';

const { Client } = require('pg');

/**
 * SR-AUTH-028 / FR-AUTH-044 / DATA-AUTH-021 / SEC-AUTH-055 / ADR-0472（段3a Task 3、移行 D・E）:
 * 店員の無操作1時間の表 private.staff_session_activity と、private.staff_idle_ok・public.staff_session_touch・
 * public.staff_idle_check・public.staff_idle_peek。has_permission の4つ目の条件は auth_has_permission_passkey 側で確かめる。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻す（取引の中の now() は固定）。
 */
describeLocalDb('passkey staff idle functions (migration D)', () => {
  let admin: PgClient;
  const db = (): PgClient => admin;
  beforeAll(async () => {
    const url = new URL(LOCAL_DATABASE_URL as string);
    url.username = 'supabase_admin';
    admin = new Client({ connectionString: url.toString() }) as PgClient;
    await (admin as unknown as { connect: () => Promise<void> }).connect();
  });
  afterAll(async () => {
    await admin.end();
  });
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function user(): Promise<string> {
    const r = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [`passkey-idle-${randomUUID()}@example.com`],
    );
    return r.rows[0].id;
  }
  /** refreshedMinutesAgo が null なら refreshed_at は NULL（created_at の分だけ前に作る）。 */
  async function authSession(userId: string, opts: { refreshedMinutesAgo: number | null; createdMinutesAgo?: number }): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal, refreshed_at)
       values ($1, $2, now() - make_interval(mins => $3::int), now(), 'aal1',
               case when $4::int is null then null else (now() - make_interval(mins => $4::int)) at time zone 'UTC' end)`,
      [id, userId, opts.createdMinutesAgo ?? opts.refreshedMinutesAgo ?? 0, opts.refreshedMinutesAgo],
    );
    return id;
  }
  async function setSeen(sessionId: string, userId: string, minutesAgo: number): Promise<void> {
    await db().query(
      `insert into private.staff_session_activity (session_id, user_id, last_seen_at)
       values ($1, $2, now() - make_interval(mins => $3::int))
       on conflict (session_id) do update set last_seen_at = excluded.last_seen_at`,
      [sessionId, userId, minutesAgo],
    );
  }
  const idleOk = async (sessionId: string | null): Promise<boolean> =>
    (await db().query('select private.staff_idle_ok($1::uuid) as ok', [sessionId])).rows[0].ok;
  const seenSecondsAgo = async (sessionId: string): Promise<number | null> => {
    const r = await db().query(
      'select extract(epoch from now() - last_seen_at)::float8 as s from private.staff_session_activity where session_id = $1',
      [sessionId],
    );
    return r.rows.length ? Number(r.rows[0].s) : null;
  };

  test('DATA-AUTH-021 活動の行が無い時は auth.sessions の created_at だけで見る（59分前は真・61分前は偽。refreshed_at は見ない）', async () => {
    const u = await user();
    expect(await idleOk(await authSession(u, { refreshedMinutesAgo: null, createdMinutesAgo: 59 }))).toBe(true);
    expect(await idleOk(await authSession(u, { refreshedMinutesAgo: null, createdMinutesAgo: 61 }))).toBe(false);
    // 作られて2時間たち、直近に更新（バックグラウンドのトークン更新）された session は、更新が新しくても偽
    expect(await idleOk(await authSession(u, { refreshedMinutesAgo: 1, createdMinutesAgo: 120 }))).toBe(false);
    expect(await idleOk(await authSession(u, { refreshedMinutesAgo: 59, createdMinutesAgo: 61 }))).toBe(false);
  });

  test('DATA-AUTH-021 活動の行がある時は last_seen_at が決める（59分前は真・61分前は偽。auth.sessions は見ない）', async () => {
    const u = await user();
    const s = await authSession(u, { refreshedMinutesAgo: 600 });
    await setSeen(s, u, 59);
    expect(await idleOk(s)).toBe(true);
    await setSeen(s, u, 61);
    expect(await idleOk(s)).toBe(false);
    const fresh = await authSession(u, { refreshedMinutesAgo: 1 });
    await setSeen(fresh, u, 61);
    expect(await idleOk(fresh)).toBe(false);
  });

  test('DATA-AUTH-021 auth.sessions にも行が無い session_id と NULL は偽（例外にしない）', async () => {
    expect(await idleOk(randomUUID())).toBe(false);
    expect(await idleOk(null)).toBe(false);
  });

  test('DATA-AUTH-021 staff_session_touch は行が無ければ作り、間引きの秒より前なら動かさず偽、過ぎていれば更新して真', async () => {
    const u = await user();
    const s = await authSession(u, { refreshedMinutesAgo: 1 });
    const touch = async (secs?: number): Promise<boolean> =>
      secs === undefined
        ? (await db().query('select public.staff_session_touch($1, $2) as ok', [s, u])).rows[0].ok
        : (await db().query('select public.staff_session_touch($1, $2, $3) as ok', [s, u, secs])).rows[0].ok;

    expect(await seenSecondsAgo(s)).toBeNull();
    expect(await touch()).toBe(true);
    expect(await seenSecondsAgo(s)).toBe(0);

    await setSeen(s, u, 0);
    await db().query("update private.staff_session_activity set last_seen_at = now() - interval '30 seconds' where session_id = $1", [s]);
    expect(await touch()).toBe(false);
    expect(await seenSecondsAgo(s)).toBe(30);

    await db().query("update private.staff_session_activity set last_seen_at = now() - interval '2 minutes' where session_id = $1", [s]);
    expect(await touch()).toBe(true);
    expect(await seenSecondsAgo(s)).toBe(0);

    await db().query("update private.staff_session_activity set last_seen_at = now() - interval '30 seconds' where session_id = $1", [s]);
    expect(await touch(10)).toBe(true);
    expect(await seenSecondsAgo(s)).toBe(0);
  });

  test('DATA-AUTH-021 staff_session_touch は別の利用者の行を上書きせず、NULL の引数は偽', async () => {
    const owner = await user();
    const other = await user();
    const s = await authSession(owner, { refreshedMinutesAgo: 1 });
    await setSeen(s, owner, 10);
    const r = await db().query('select public.staff_session_touch($1, $2) as ok', [s, other]);
    expect(r.rows[0].ok).toBe(false);
    expect(Math.round((await seenSecondsAgo(s)) as number)).toBe(600);
    expect((await db().query('select public.staff_session_touch(null, $1) as ok', [owner])).rows[0].ok).toBe(false);
    expect((await db().query('select public.staff_session_touch($1, null) as ok', [s])).rows[0].ok).toBe(false);
  });

  test('DATA-AUTH-021 書いた時に、その人の2日より前の行だけを消す（他の人の古い行・新しい行は残す）', async () => {
    const u = await user();
    const v = await user();
    const old = await authSession(u, { refreshedMinutesAgo: 1 });
    const recent = await authSession(u, { refreshedMinutesAgo: 1 });
    const others = await authSession(v, { refreshedMinutesAgo: 1 });
    const now = await authSession(u, { refreshedMinutesAgo: 1 });
    await db().query("insert into private.staff_session_activity values ($1, $2, now() - interval '3 days')", [old, u]);
    await db().query("insert into private.staff_session_activity values ($1, $2, now() - interval '1 day')", [recent, u]);
    await db().query("insert into private.staff_session_activity values ($1, $2, now() - interval '3 days')", [others, v]);

    expect((await db().query('select public.staff_session_touch($1, $2) as ok', [now, u])).rows[0].ok).toBe(true);

    expect(await seenSecondsAgo(old)).toBeNull();
    expect(await seenSecondsAgo(recent)).not.toBeNull();
    expect(await seenSecondsAgo(others)).not.toBeNull();
  });

  test('DATA-AUTH-021 staff_idle_check は通る時だけ真を返して時刻を進め、60秒以内の2度目は動かさない。通らなければ偽で書かない', async () => {
    const u = await user();
    const s = await authSession(u, { refreshedMinutesAgo: 5 });
    const check = async (): Promise<boolean> =>
      (await db().query('select public.staff_idle_check($1, $2) as ok', [s, u])).rows[0].ok;

    // 行が無い（auth.sessions の時刻で通る）: 真で行ができる
    expect(await check()).toBe(true);
    expect(await seenSecondsAgo(s)).toBe(0);

    await db().query("update private.staff_session_activity set last_seen_at = now() - interval '30 seconds' where session_id = $1", [s]);
    expect(await check()).toBe(true);
    expect(await seenSecondsAgo(s)).toBe(30);

    await db().query("update private.staff_session_activity set last_seen_at = now() - interval '5 minutes' where session_id = $1", [s]);
    expect(await check()).toBe(true);
    expect(await seenSecondsAgo(s)).toBe(0);

    // 無操作が1時間を過ぎた session は偽で、時刻を進めない
    await db().query("update private.staff_session_activity set last_seen_at = now() - interval '61 minutes' where session_id = $1", [s]);
    expect(await check()).toBe(false);
    expect(Math.round((await seenSecondsAgo(s)) as number)).toBe(3660);

    // auth.sessions にも無ければ偽で行を作らない
    const ghost = randomUUID();
    expect((await db().query('select public.staff_idle_check($1, $2) as ok', [ghost, u])).rows[0].ok).toBe(false);
    expect(await seenSecondsAgo(ghost)).toBeNull();
  });

  test('DATA-AUTH-021 staff_idle_check は、時刻の書き込みが失敗したら真を返さず例外を投げる（呼び手が 503 の閉じる側に倒す）', async () => {
    const u = await user();
    const s = await authSession(u, { refreshedMinutesAgo: null, createdMinutesAgo: 5 });
    await db().query('alter table private.staff_session_activity add constraint staff_idle_test_fail check (user_id is null) not valid');
    await db().query('savepoint idle_fail');
    let code = '';
    try {
      await db().query('select public.staff_idle_check($1, $2) as ok', [s, u]);
    } catch (caught) {
      code = (caught as { code?: string }).code ?? 'unknown';
    }
    await db().query('rollback to savepoint idle_fail');
    expect(code).toBe('23514');
    // 見るだけの呼びは書かないので、同じ状態でも通る
    expect((await db().query('select public.staff_idle_peek($1) as ok', [s])).rows[0].ok).toBe(true);
  });

  test('DATA-AUTH-021 DB の誤りは、staff_idle_peek・staff_idle_check では例外になり（呼び手が 503）、has_permission 用の staff_idle_ok では偽になる', async () => {
    const u = await user();
    const s = await authSession(u, { refreshedMinutesAgo: null, createdMinutesAgo: 5 });
    await db().query(
      `create or replace function private.passkey_staff_settings() returns jsonb language plpgsql as $$ begin raise exception 'idle_boom'; end $$`,
    );
    for (const sql of ['select public.staff_idle_peek($1) as ok', 'select public.staff_idle_check($1, $2) as ok']) {
      await db().query('savepoint idle_err');
      let message = '';
      try {
        await db().query(sql, sql.includes('$2') ? [s, u] : [s]);
      } catch (caught) {
        message = (caught as { message?: string }).message ?? 'unknown';
      }
      await db().query('rollback to savepoint idle_err');
      expect(message).toBe('idle_boom');
    }
    expect((await db().query('select private.staff_idle_ok($1) as ok', [s])).rows[0].ok).toBe(false);
  });

  test('DATA-AUTH-021 staff_idle_peek は何度呼んでも時刻を進めず、行も作らない', async () => {
    const u = await user();
    const s = await authSession(u, { refreshedMinutesAgo: 5 });
    const peek = async (id: string): Promise<boolean> =>
      (await db().query('select public.staff_idle_peek($1) as ok', [id])).rows[0].ok;

    expect(await peek(s)).toBe(true);
    expect(await seenSecondsAgo(s)).toBeNull();

    await setSeen(s, u, 30);
    for (let i = 0; i < 3; i += 1) expect(await peek(s)).toBe(true);
    expect(Math.round((await seenSecondsAgo(s)) as number)).toBe(1800);

    await setSeen(s, u, 61);
    expect(await peek(s)).toBe(false);
    expect(Math.round((await seenSecondsAgo(s)) as number)).toBe(3660);
  });

  test('DATA-AUTH-021 権限: public の3関数は service_role だけが実行でき、private.staff_idle_ok は service_role にも渡さない。表は anon・authenticated・service_role に権限が無く RLS が有効', async () => {
    const fns = ['public.staff_session_touch(uuid,uuid,integer)', 'public.staff_idle_check(uuid,uuid)', 'public.staff_idle_peek(uuid)'];
    for (const f of fns) {
      const r = await db().query(
        `select has_function_privilege('service_role', $1, 'EXECUTE') as service_role,
                has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                has_function_privilege('anon', $1, 'EXECUTE') as anon,
                exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.oid = $1::regprocedure and a.grantee = 0) as public_grant`,
        [f],
      );
      expect({ f, ...r.rows[0] }).toEqual({ f, service_role: true, authenticated: false, anon: false, public_grant: false });
    }
    const p = await db().query(
      `select has_function_privilege('service_role', 'private.staff_idle_ok(uuid)', 'EXECUTE') as service_role,
              has_function_privilege('authenticated', 'private.staff_idle_ok(uuid)', 'EXECUTE') as authenticated,
              has_function_privilege('anon', 'private.staff_idle_ok(uuid)', 'EXECUTE') as anon,
              (select prosecdef and provolatile = 's' from pg_proc where oid = 'private.staff_idle_ok(uuid)'::regprocedure) as stable_definer`,
    );
    expect(p.rows[0]).toEqual({ service_role: false, authenticated: false, anon: false, stable_definer: true });
    const strict = await db().query(
      `select has_function_privilege('service_role', 'private.staff_idle_ok_strict(uuid)', 'EXECUTE') as service_role,
              has_function_privilege('authenticated', 'private.staff_idle_ok_strict(uuid)', 'EXECUTE') as authenticated,
              has_function_privilege('anon', 'private.staff_idle_ok_strict(uuid)', 'EXECUTE') as anon,
              (select prosecdef and provolatile = 's' from pg_proc where oid = 'private.staff_idle_ok_strict(uuid)'::regprocedure) as stable_definer`,
    );
    expect(strict.rows[0]).toEqual({ service_role: false, authenticated: false, anon: false, stable_definer: true });
    const t = await db().query(
      `select relrowsecurity,
              has_table_privilege('anon', 'private.staff_session_activity', 'SELECT') as anon_select,
              has_table_privilege('authenticated', 'private.staff_session_activity', 'SELECT,INSERT,UPDATE,DELETE') as authenticated_any,
              has_table_privilege('service_role', 'private.staff_session_activity', 'SELECT,INSERT,UPDATE,DELETE') as service_role_any
         from pg_class where oid = 'private.staff_session_activity'::regclass`,
    );
    expect(t.rows[0]).toEqual({ relrowsecurity: true, anon_select: false, authenticated_any: false, service_role_any: false });
  });

  test('DATA-AUTH-021 service_role の役で3関数を呼べる。anon・authenticated の役では permission denied（42501）', async () => {
    const u = await user();
    const s = await authSession(u, { refreshedMinutesAgo: 1 });
    await db().query('savepoint idle_role');
    await db().query('set local role service_role');
    const ok = await db().query('select public.staff_idle_check($1, $2) as a, public.staff_idle_peek($1) as b', [s, u]);
    expect(ok.rows[0]).toEqual({ a: true, b: true });
    await db().query('rollback to savepoint idle_role');
    for (const role of ['anon', 'authenticated']) {
      await db().query('savepoint idle_denied');
      await db().query(`set local role ${role}`);
      let code = '';
      try {
        await db().query('select public.staff_idle_peek($1)', [s]);
      } catch (caught) {
        code = (caught as { code?: string }).code ?? 'unknown';
      }
      await db().query('rollback to savepoint idle_denied');
      expect({ role, code }).toEqual({ role, code: '42501' });
    }
  });

  describe('移行 E の前の確かめ（D の関数が無い状態）', () => {
    const migration = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261117013000_passkey_staff_entry_conditions.sql'), 'utf8');
    const precheck = /DO \$passkey_entry_precheck\$[\s\S]*?\$passkey_entry_precheck\$;/.exec(migration)?.[0];

    async function run(sql: string): Promise<{ message: string; detail: string } | null> {
      await db().query('savepoint e_pre');
      try {
        await db().query(sql);
        return null;
      } catch (caught) {
        const e = caught as { message?: string; detail?: string };
        return { message: e.message ?? '', detail: e.detail ?? '' };
      } finally {
        await db().query('rollback to savepoint e_pre');
      }
    }

    test('DATA-AUTH-021 D の関数が揃っていれば通る', async () => {
      if (!precheck) throw new Error('E に前の確かめの DO ブロックが無い');
      expect(await run(precheck)).toBeNull();
    });

    test('DATA-AUTH-021 private.staff_idle_ok が無いと PASSKEY_MIGRATION_PRECHECK_FAILED（passkey_entry_idle_fn）で止まる', async () => {
      if (!precheck) throw new Error('E に前の確かめの DO ブロックが無い');
      await db().query('savepoint drop_idle');
      await db().query('drop function private.staff_idle_ok(uuid)');
      const outcome = await run(precheck);
      await db().query('rollback to savepoint drop_idle');
      expect(outcome).toEqual({ message: 'PASSKEY_MIGRATION_PRECHECK_FAILED', detail: 'passkey_entry_idle_fn' });
    });
  });
});
