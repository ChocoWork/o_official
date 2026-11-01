/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * 波 6 の M3（DATA-AUTH-009・010）: パスワード変更の確認コードの表 `public.password_change_challenges` と、
 * 関数 `issue_password_change_challenge`・`consume_password_change_challenge`。
 * 手元の使い捨て DB でだけ流す（M3 を当てた後。当てる前は表が無く落ちる）。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 * 計画: docs/superpowers/plans/2026-11-01-wave6-captcha-password-change-config.md（Task 4）
 */
describeLocalDb('integration: パスワード変更の確認コード（M3）', (db) => {
  /** アプリが作る HMAC の代わりに、同じ形（hex 64 桁）の値を作る */
  const hashOf = (code: string) => createHash('sha256').update(`test:${code}`).digest('hex');

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
      [`integration-password-change-${randomUUID()}@example.com`],
    );
    return result.rows[0].id;
  }

  async function issue(userId: string, sessionId: string, code: string, ttlSeconds = 600): Promise<string> {
    const result = await db().query('select public.issue_password_change_challenge($1::uuid, $2::uuid, $3, $4) as id', [
      userId,
      sessionId,
      hashOf(code),
      ttlSeconds,
    ]);
    return result.rows[0].id;
  }

  async function consume(userId: string, sessionId: string, code: string): Promise<string> {
    const result = await db().query('select public.consume_password_change_challenge($1::uuid, $2::uuid, $3) as result', [
      userId,
      sessionId,
      hashOf(code),
    ]);
    return result.rows[0].result;
  }

  /** 指定した役のまま流す。savepoint まで戻すので、断られても取引は続けられる。 */
  async function runAs(role: string, sql: string, params: unknown[] = []): Promise<{ code?: string }> {
    await db().query('savepoint run_as');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query(`set local role ${role}`);
      await db().query(sql, params);
      return {};
    } catch (caught) {
      return { code: (caught as { code?: string }).code };
    } finally {
      await db().query('rollback to savepoint run_as');
      await db().query('release savepoint run_as');
    }
  }

  test('DATA-AUTH-010 ①issue は id を返し、2 回目の issue で 1 回目のコードは無効（consume が none）', async () => {
    const userId = await insertUser();
    const sessionId = randomUUID();

    const first = await issue(userId, sessionId, '11111111');
    const second = await issue(userId, sessionId, '22222222');

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(await consume(userId, sessionId, '11111111')).toBe('invalid');
    expect(await consume(userId, sessionId, '22222222')).toBe('ok');
    const open = await db().query(
      'select count(*)::int as count from public.password_change_challenges where user_id = $1::uuid and used_at is null',
      [userId],
    );
    expect(open.rows[0].count).toBe(0);
  });

  test('DATA-AUTH-010 ①の補足 別の session で issue し直すと、前の session のコードは none（開いた行が無い）', async () => {
    const userId = await insertUser();
    const firstSession = randomUUID();

    await issue(userId, firstSession, '11111111');
    await issue(userId, randomUUID(), '22222222');

    expect(await consume(userId, firstSession, '11111111')).toBe('none');
  });

  test('DATA-AUTH-010 ①の補足 前のコードは issue のあと使えない（used_at が立つ）', async () => {
    const userId = await insertUser();
    const sessionId = randomUUID();

    const first = await issue(userId, sessionId, '11111111');
    await issue(userId, sessionId, '22222222');

    const row = await db().query('select used_at is not null as used from public.password_change_challenges where id = $1::uuid', [first]);
    expect(row.rows[0].used).toBe(true);
  });

  test('DATA-AUTH-010 ②正しいコードで ok、2 回目は none', async () => {
    const userId = await insertUser();
    const sessionId = randomUUID();
    await issue(userId, sessionId, '12345678');

    expect(await consume(userId, sessionId, '12345678')).toBe('ok');
    expect(await consume(userId, sessionId, '12345678')).toBe('none');
  });

  test('DATA-AUTH-010 ③違うコードは invalid。5 回違うと次は正しいコードでも locked', async () => {
    const userId = await insertUser();
    const sessionId = randomUUID();
    await issue(userId, sessionId, '12345678');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await consume(userId, sessionId, '00000000')).toBe('invalid');
    }
    expect(await consume(userId, sessionId, '12345678')).toBe('locked');
    expect(await consume(userId, sessionId, '00000000')).toBe('locked');
    const row = await db().query(
      'select attempts, used_at is null as open from public.password_change_challenges where user_id = $1::uuid',
      [userId],
    );
    expect(row.rows[0]).toEqual({ attempts: 5, open: true });
  });

  test('DATA-AUTH-010 ④別の auth_session_id は none で、attempts も増えない', async () => {
    const userId = await insertUser();
    const sessionId = randomUUID();
    await issue(userId, sessionId, '12345678');

    expect(await consume(userId, randomUUID(), '12345678')).toBe('none');
    expect(await consume(userId, randomUUID(), '00000000')).toBe('none');
    const row = await db().query('select attempts from public.password_change_challenges where user_id = $1::uuid', [userId]);
    expect(row.rows[0].attempts).toBe(0);
    expect(await consume(userId, sessionId, '12345678')).toBe('ok');
  });

  test('DATA-AUTH-010 ④の補足 別の利用者のコードは none', async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const sessionId = randomUUID();
    await issue(owner, sessionId, '12345678');

    expect(await consume(other, sessionId, '12345678')).toBe('none');
  });

  test('DATA-AUTH-010 ⑤期限切れ（expires_at を過去にする）は none', async () => {
    const userId = await insertUser();
    const sessionId = randomUUID();
    await issue(userId, sessionId, '12345678');
    await db().query("update public.password_change_challenges set expires_at = now() - interval '1 second' where user_id = $1::uuid", [userId]);

    expect(await consume(userId, sessionId, '12345678')).toBe('none');
  });

  test.each([0, 59, 901, 100000])('DATA-AUTH-010 ⑥p_ttl_seconds が %s（範囲 60..900 の外）なら例外 22023', async (ttl) => {
    const userId = await insertUser();
    await db().query('savepoint expected_failure');
    let code: string | undefined;
    try {
      await issue(userId, randomUUID(), '12345678', ttl);
    } catch (caught) {
      code = (caught as { code?: string }).code;
    } finally {
      await db().query('rollback to savepoint expected_failure');
    }
    expect(code).toBe('22023');
  });

  test.each([60, 600, 900])('DATA-AUTH-010 ⑥の補足 p_ttl_seconds が %s なら通る', async (ttl) => {
    const userId = await insertUser();
    const sessionId = randomUUID();
    await issue(userId, sessionId, '12345678', ttl);

    const row = await db().query(
      `select extract(epoch from (expires_at - created_at))::int as ttl from public.password_change_challenges where user_id = $1::uuid`,
      [userId],
    );
    expect(Math.abs(row.rows[0].ttl - ttl)).toBeLessThanOrEqual(1);
  });

  test('DATA-AUTH-010 ⑥の補足 hex 64 桁でない code_hash（平文のコードなど）は例外 22023', async () => {
    const userId = await insertUser();
    await db().query('savepoint expected_failure');
    let code: string | undefined;
    try {
      await db().query('select public.issue_password_change_challenge($1::uuid, $2::uuid, $3, 600)', [userId, randomUUID(), '12345678']);
    } catch (caught) {
      code = (caught as { code?: string }).code;
    } finally {
      await db().query('rollback to savepoint expected_failure');
    }
    expect(code).toBe('22023');
  });

  test('DATA-AUTH-010 issue は 1 日より古い行を消す', async () => {
    const userId = await insertUser();
    const sessionId = randomUUID();
    const old = await issue(userId, sessionId, '11111111');
    await db().query("update public.password_change_challenges set created_at = now() - interval '25 hours' where id = $1::uuid", [old]);

    await issue(userId, sessionId, '22222222');

    const row = await db().query('select count(*)::int as count from public.password_change_challenges where id = $1::uuid', [old]);
    expect(row.rows[0].count).toBe(0);
  });

  test('DATA-AUTH-009 ⑦anon・authenticated は表も 2 関数も 42501、service_role は呼べる', async () => {
    const userId = await insertUser();
    const sessionId = randomUUID();

    for (const role of ['anon', 'authenticated']) {
      expect(await runAs(role, 'select count(*) from public.password_change_challenges')).toEqual({ code: '42501' });
      expect(
        await runAs(role, 'select public.issue_password_change_challenge($1::uuid, $2::uuid, $3, 600)', [userId, sessionId, hashOf('12345678')]),
      ).toEqual({ code: '42501' });
      expect(
        await runAs(role, 'select public.consume_password_change_challenge($1::uuid, $2::uuid, $3)', [userId, sessionId, hashOf('12345678')]),
      ).toEqual({ code: '42501' });
    }
    expect(await runAs('service_role', 'select count(*) from public.password_change_challenges')).toEqual({});
    expect(
      await runAs('service_role', 'select public.issue_password_change_challenge($1::uuid, $2::uuid, $3, 600)', [userId, sessionId, hashOf('12345678')]),
    ).toEqual({});
  });

  test('DATA-AUTH-009 ⑧列に平文のコードが無い（code_hash は hex 64 桁で、入れた 8 桁を含まない）', async () => {
    const userId = await insertUser();
    const sessionId = randomUUID();
    await issue(userId, sessionId, '12345678');

    const columns = await db().query(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'password_change_challenges' order by column_name`,
    );
    expect(columns.rows.map((row: { column_name: string }) => row.column_name)).toEqual([
      'attempts',
      'auth_session_id',
      'code_hash',
      'created_at',
      'expires_at',
      'id',
      'used_at',
      'user_id',
    ]);
    const row = await db().query('select code_hash from public.password_change_challenges where user_id = $1::uuid', [userId]);
    expect(row.rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0].code_hash).not.toContain('12345678');
  });

  test('DATA-AUTH-009 ⑨auth.users の削除で行が消える', async () => {
    const userId = await insertUser();
    await issue(userId, randomUUID(), '12345678');

    await db().query('delete from auth.users where id = $1::uuid', [userId]);

    const row = await db().query('select count(*)::int as count from public.password_change_challenges where user_id = $1::uuid', [userId]);
    expect(row.rows[0].count).toBe(0);
  });
});
