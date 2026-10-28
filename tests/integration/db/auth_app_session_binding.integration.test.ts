/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createLiveAppSession, jwtClaims } from './helpers/app-session';

/**
 * 波 5 の M1（DATA-AUTH-007）: sessions.auth_session_id と、結び付いた生きた session の判定の関数 3 本。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 * 計画: docs/superpowers/plans/2026-10-29-wave5-session-binding-aal2-db.md（Task 1）
 */
describeLocalDb('integration: アプリの session への結び付け（M1）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertUser(): Promise<string> {
    const result = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [`integration-app-session-${randomUUID()}@example.com`],
    );
    return result.rows[0].id;
  }

  async function isLive(sessionId: string | null): Promise<boolean> {
    const result = await db().query('select private.app_session_is_live($1::uuid) as live', [sessionId]);
    return result.rows[0].live;
  }

  /**
   * 指定した役・claims のまま流す。savepoint まで戻すので、断られても取引は続けられる。
   * 成功したら { value }、失敗したら { code } を返す。
   */
  async function runAs(
    role: string,
    claims: Record<string, unknown> | string,
    sql: string,
    params: unknown[] = [],
  ): Promise<{ value?: unknown; code?: string }> {
    await db().query('savepoint run_as');
    try {
      await db().query("select set_config('request.jwt.claims', $1, true)", [
        typeof claims === 'string' ? claims : JSON.stringify(claims),
      ]);
      await db().query(`set local role ${role}`);
      const result = await db().query(sql, params);
      return { value: result.rows[0]?.value };
    } catch (caught) {
      return { code: (caught as { code?: string }).code };
    } finally {
      await db().query('rollback to savepoint run_as');
      await db().query('release savepoint run_as');
    }
  }

  test('DATA-AUTH-007 ①結び付いた生きた session は app_session_is_live が true', async () => {
    const userId = await insertUser();
    const { sessionId } = await createLiveAppSession(db(), userId);

    expect(await isLive(sessionId)).toBe(true);
  });

  test('DATA-AUTH-007 ②public.sessions の行が無い（アプリを通らない）session は false', async () => {
    const userId = await insertUser();
    const { sessionId } = await createLiveAppSession(db(), userId, { bind: false });

    expect(await isLive(sessionId)).toBe(false);
  });

  test('DATA-AUTH-007 ③revoked_at が立った行だけなら false', async () => {
    const userId = await insertUser();
    const { sessionId } = await createLiveAppSession(db(), userId, { revoked: true });

    expect(await isLive(sessionId)).toBe(false);
  });

  test('DATA-AUTH-007 ④同じ auth_session_id の行が 2 本並んでも true。旧行だけ失効しても true、両方失効で false', async () => {
    const userId = await insertUser();
    const { sessionId } = await createLiveAppSession(db(), userId);
    // insert を先・revoke を後にする更新の途中の形（旧行・新行が同じ auth_session_id で並ぶ）
    await db().query(
      `insert into public.sessions (user_id, refresh_token_hash, auth_session_id, expires_at, last_seen_at)
       values ($1, 'test-' || gen_random_uuid()::text, $2, now() + interval '7 days', now())`,
      [userId, sessionId],
    );
    expect(await isLive(sessionId)).toBe(true);

    await db().query(
      `update public.sessions set revoked_at = now()
       where id = (select id from public.sessions where auth_session_id = $1 order by created_at, id limit 1)`,
      [sessionId],
    );
    expect(await isLive(sessionId)).toBe(true);

    await db().query('update public.sessions set revoked_at = now() where auth_session_id = $1', [sessionId]);
    expect(await isLive(sessionId)).toBe(false);
  });

  test('DATA-AUTH-007 ⑤auth.sessions の行が無ければ false', async () => {
    const userId = await insertUser();
    const { sessionId } = await createLiveAppSession(db(), userId);
    await db().query('delete from auth.sessions where id = $1', [sessionId]);

    expect(await isLive(sessionId)).toBe(false);
  });

  test('DATA-AUTH-007 ⑥auth.sessions.not_after が過去なら false、未来なら true', async () => {
    const userId = await insertUser();
    const { sessionId } = await createLiveAppSession(db(), userId);

    await db().query("update auth.sessions set not_after = now() - interval '1 minute' where id = $1", [sessionId]);
    expect(await isLive(sessionId)).toBe(false);

    await db().query("update auth.sessions set not_after = now() + interval '1 hour' where id = $1", [sessionId]);
    expect(await isLive(sessionId)).toBe(true);
  });

  test('DATA-AUTH-007 ⑦auth.sessions.user_id と sessions.user_id が食い違えば false', async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const { sessionId } = await createLiveAppSession(db(), owner);
    await db().query('update public.sessions set user_id = $2 where auth_session_id = $1', [sessionId, other]);

    expect(await isLive(sessionId)).toBe(false);
  });

  test('DATA-AUTH-007 NULL を渡すと false', async () => {
    expect(await isLive(null)).toBe(false);
  });

  test('DATA-AUTH-007 ⑧public.is_app_session_active は anon・authenticated が 42501、service_role が呼べる', async () => {
    const userId = await insertUser();
    const { sessionId } = await createLiveAppSession(db(), userId);
    const sql = 'select public.is_app_session_active($1::uuid) as value';

    expect((await runAs('anon', '', sql, [sessionId])).code).toBe('42501');
    expect((await runAs('authenticated', jwtClaims(userId, { sessionId }), sql, [sessionId])).code).toBe('42501');
    expect(await runAs('service_role', '', sql, [sessionId])).toEqual({ value: true });
    expect(await runAs('service_role', '', sql, [randomUUID()])).toEqual({ value: false });
  });

  test('DATA-AUTH-007 ⑧private.app_session_is_live は anon・authenticated・service_role のどれも直接は呼べない', async () => {
    const userId = await insertUser();
    const { sessionId } = await createLiveAppSession(db(), userId);
    const sql = 'select private.app_session_is_live($1::uuid) as value';

    expect((await runAs('anon', '', sql, [sessionId])).code).toBe('42501');
    expect((await runAs('authenticated', jwtClaims(userId, { sessionId }), sql, [sessionId])).code).toBe('42501');
    expect((await runAs('service_role', '', sql, [sessionId])).code).toBe('42501');
  });

  test('DATA-AUTH-007 ⑨private.is_app_bound_live_session は claims の session_id が無い・空・uuid でない時も例外を出さず false', async () => {
    const userId = await insertUser();
    const sql = 'select private.is_app_bound_live_session() as value';

    for (const claims of [
      '',
      { sub: userId, role: 'authenticated' },
      { sub: userId, role: 'authenticated', session_id: '' },
      { sub: userId, role: 'authenticated', session_id: 'not-a-uuid' },
      { sub: userId, role: 'authenticated', session_id: `${randomUUID()}; select 1` },
      { sub: userId, role: 'authenticated', session_id: randomUUID() },
    ]) {
      expect(await runAs('authenticated', claims, sql)).toEqual({ value: false });
    }
  });

  test('DATA-AUTH-007 ⑨結び付いた生きた session の claims では true。結び付いていない・失効後は false。anon は 42501', async () => {
    const userId = await insertUser();
    const bound = await createLiveAppSession(db(), userId);
    const unbound = await createLiveAppSession(db(), userId, { bind: false });
    const revoked = await createLiveAppSession(db(), userId, { revoked: true });
    const sql = 'select private.is_app_bound_live_session() as value';

    expect(await runAs('authenticated', jwtClaims(userId, bound), sql)).toEqual({ value: true });
    expect(await runAs('service_role', jwtClaims(userId, bound), sql)).toEqual({ value: true });
    expect(await runAs('authenticated', jwtClaims(userId, unbound), sql)).toEqual({ value: false });
    expect(await runAs('authenticated', jwtClaims(userId, revoked), sql)).toEqual({ value: false });
    expect((await runAs('anon', jwtClaims(userId, bound), sql)).code).toBe('42501');
  });

  test('DATA-AUTH-007 ⑩auth_session_id を指定せずに作った行（これまでの書き方）は NULL のままで、結び付いた session にならない', async () => {
    const userId = await insertUser();
    const row = (
      await db().query(
        `insert into public.sessions (user_id, refresh_token_hash) values ($1, 'test-' || gen_random_uuid()::text)
         returning auth_session_id`,
        [userId],
      )
    ).rows[0];

    expect(row.auth_session_id).toBeNull();
    expect(await isLive(randomUUID())).toBe(false);
  });

  test('DATA-AUTH-007 anon・authenticated は public.sessions の auth_session_id を読めも書けもしない', async () => {
    const userId = await insertUser();
    const { sessionId } = await createLiveAppSession(db(), userId);

    expect((await runAs('anon', '', 'select auth_session_id as value from public.sessions limit 1')).code).toBe('42501');
    expect(
      (await runAs('authenticated', jwtClaims(userId, { sessionId }), 'select auth_session_id as value from public.sessions limit 1')).code,
    ).toBe('42501');
  });

  test('DATA-AUTH-007 索引は部分索引で一意ではない', async () => {
    const result = await db().query(
      `select i.indisunique as is_unique, i.indpred is not null as is_partial
       from pg_index i join pg_class c on c.oid = i.indexrelid
       where i.indrelid = 'public.sessions'::regclass and c.relname = 'sessions_auth_session_id_live_idx'`,
    );

    expect(result.rows).toEqual([{ is_unique: false, is_partial: true }]);
  });
});
