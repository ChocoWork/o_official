/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * AUTH の sessions の表（DATA-AUTH-001）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
describeLocalDb('integration: AUTH の sessions の表', (db) => {
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

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
      [`integration-auth-sessions-${randomUUID()}@example.com`],
    );
    return result.rows[0].id;
  }

  async function insertSession(userId: string, refreshToken: string = randomUUID()):Promise<string> {
    const result = await db().query(
      `insert into public.sessions (user_id, refresh_token_hash, current_jti, ip, user_agent, device_name, expires_at)
       values ($1, $2, gen_random_uuid()::text, '203.0.113.5', 'jest', 'integration-device', now() + interval '30 days')
       returning id::text as id`,
      [userId, sha256(refreshToken)],
    );
    return result.rows[0].id;
  }

  /** 失敗が取引全体を壊さないよう、savepoint の中で流して SQLSTATE と制約名を返す。 */
  async function failure(
    sql: string,
    params: unknown[] = [],
    role?: string,
  ): Promise<{ code?: string; constraint?: string }> {
    await db().query('savepoint expected_failure');
    try {
      if (role) {
        await db().query("select set_config('request.jwt.claims', '', true)");
        await db().query(`set local role ${role}`);
      }
      await db().query(sql, params);
      return {};
    } catch (caught) {
      const error = caught as { code?: string; constraint?: string };
      return { code: error.code, constraint: error.constraint };
    } finally {
      await db().query('rollback to savepoint expected_failure');
    }
  }

  /** 指定した役のまま sessions を数える。RLS が行を隠すかを確かめる。 */
  async function countAs(role: string): Promise<number> {
    await db().query('savepoint as_role');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query(`set local role ${role}`);
      const result = await db().query('select count(*)::int as count from public.sessions');
      return result.rows[0].count;
    } finally {
      await db().query('rollback to savepoint as_role');
    }
  }

  test('DATA-AUTH-001 列は控えの15本で、型と NOT NULL が設計どおり', async () => {
    const result = await db().query(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'sessions' order by column_name`,
    );

    const actual = Object.fromEntries(
      result.rows.map((row: { column_name: string; data_type: string; is_nullable: string }) => [
        row.column_name,
        `${row.data_type} ${row.is_nullable === 'NO' ? 'not null' : 'null'}`,
      ]),
    );
    expect(actual).toEqual({
      id: 'uuid not null',
      user_id: 'uuid not null',
      refresh_token_hash: 'text not null',
      previous_refresh_token_hash: 'text null',
      csrf_token_hash: 'text null',
      csrf_prev_token_hash: 'text null',
      revoked_at: 'timestamp with time zone null',
      quarantined: 'boolean null',
      current_jti: 'text null',
      ip: 'inet null',
      user_agent: 'text null',
      device_name: 'text null',
      created_at: 'timestamp with time zone not null',
      expires_at: 'timestamp with time zone null',
      last_seen_at: 'timestamp with time zone null',
    });
  });

  test('DATA-AUTH-001 利用者と refresh token のハッシュだけで作ると、id・作成時刻・隔離の印に初めの値が入り、失効の印は空', async () => {
    const userId = await insertUser();
    const hash = sha256('only-required');

    const result = await db().query(
      `insert into public.sessions (user_id, refresh_token_hash) values ($1, $2)
       returning id::text as id, created_at is not null as has_created_at, quarantined, revoked_at,
                 previous_refresh_token_hash, csrf_token_hash, csrf_prev_token_hash, expires_at, last_seen_at`,
      [userId, hash],
    );

    expect(result.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.rows[0]).toMatchObject({
      has_created_at: true,
      quarantined: false,
      revoked_at: null,
      previous_refresh_token_hash: null,
      csrf_token_hash: null,
      csrf_prev_token_hash: null,
      expires_at: null,
      last_seen_at: null,
    });
  });

  test('DATA-AUTH-001 利用者の無い作成は NOT NULL の違反で落ちる', async () => {
    const result = await failure(`insert into public.sessions (refresh_token_hash) values ('hash')`);

    expect(result.code).toBe('23502');
  });

  test('DATA-AUTH-001 refresh token のハッシュの無い作成は NOT NULL の違反で落ちる', async () => {
    const userId = await insertUser();

    const result = await failure('insert into public.sessions (user_id) values ($1)', [userId]);

    expect(result.code).toBe('23502');
  });

  test('DATA-AUTH-001 refresh token は生でなくハッシュの文字で控え、今の値と前の値を別の列に持てる', async () => {
    const userId = await insertUser();
    const sessionId = await insertSession(userId, 'refresh-token-1');
    const first = sha256('refresh-token-1');
    const second = sha256('refresh-token-2');

    await db().query(
      `update public.sessions set previous_refresh_token_hash = refresh_token_hash, refresh_token_hash = $2,
              csrf_prev_token_hash = csrf_token_hash, csrf_token_hash = $3 where id = $1`,
      [sessionId, second, sha256('csrf-1')],
    );

    const row = (await db().query('select * from public.sessions where id = $1', [sessionId])).rows[0];
    expect(row.refresh_token_hash).toBe(second);
    expect(row.previous_refresh_token_hash).toBe(first);
    expect(row.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.csrf_token_hash).toBe(sha256('csrf-1'));
    expect(row.csrf_prev_token_hash).toBeNull();
  });

  test('DATA-AUTH-001 ログアウトは revoked_at を付けるだけで行を消さず、ほかのセッションの印は変わらない', async () => {
    const userId = await insertUser();
    const target = await insertSession(userId);
    const other = await insertSession(userId);

    const updated = await db().query('update public.sessions set revoked_at = now() where id = $1', [target]);

    expect(updated.rowCount).toBe(1);
    const rows = (
      await db().query(
        'select id::text as id, revoked_at is not null as revoked from public.sessions where user_id = $1',
        [userId],
      )
    ).rows;
    expect(Object.fromEntries(rows.map((row: { id: string; revoked: boolean }) => [row.id, row.revoked]))).toEqual({
      [target]: true,
      [other]: false,
    });
  });

  test('DATA-AUTH-001 存在しない利用者の控えは外部キーの違反で落ちる', async () => {
    const result = await failure(`insert into public.sessions (user_id, refresh_token_hash) values ($1, $2)`, [
      randomUUID(),
      sha256('orphan'),
    ]);

    expect(result).toEqual({ code: '23503', constraint: 'sessions_user_id_fkey' });
  });

  test('DATA-AUTH-001 利用者を消すと、その人の控えだけが一緒に消える', async () => {
    const userId = await insertUser();
    const otherUserId = await insertUser();
    await insertSession(userId);
    await insertSession(userId);
    await insertSession(otherUserId);

    await db().query('delete from auth.users where id = $1', [userId]);

    const remaining = await db().query(
      'select user_id::text as user_id from public.sessions where user_id in ($1, $2)',
      [userId, otherUserId],
    );
    expect(remaining.rows).toEqual([{ user_id: otherUserId }]);
  });

  test('DATA-AUTH-001 接続元は inet、端末の情報は文字として控えられる', async () => {
    const userId = await insertUser();
    const sessionId = await insertSession(userId);

    const row = (
      await db().query('select host(ip) as ip, user_agent, device_name from public.sessions where id = $1', [sessionId])
    ).rows[0];

    expect(row).toEqual({ ip: '203.0.113.5', user_agent: 'jest', device_name: 'integration-device' });
    const invalid = await failure(
      `insert into public.sessions (user_id, refresh_token_hash, ip) values ($1, 'h', 'not-an-ip')`,
      [userId],
    );
    expect(invalid.code).toBe('22P02');
  });

  test('DATA-AUTH-001 利用者・期限・最後に見た時刻・CSRF の前の印・前の refresh token で引く索引がある', async () => {
    const result = await db().query(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'sessions'`,
    );

    expect(result.rows.map((row: { indexname: string }) => row.indexname)).toEqual(
      expect.arrayContaining([
        'sessions_pkey',
        'idx_sessions_user_id',
        'idx_sessions_expires_at',
        'idx_sessions_last_seen_at',
        'idx_sessions_csrf_prev_token_hash',
        'sessions_previous_refresh_token_hash_idx',
      ]),
    );
  });

  test('DATA-AUTH-001 RLS は有効で、anon・authenticated を拒み service_role だけを通す方針が3本ある', async () => {
    const enabled = await db().query(`select relrowsecurity from pg_class where oid = 'public.sessions'::regclass`);
    expect(enabled.rows[0].relrowsecurity).toBe(true);

    const policies = await db().query(
      `select policyname, array_to_string(roles, ',') as roles, cmd, qual, with_check from pg_policies
       where schemaname = 'public' and tablename = 'sessions' order by policyname`,
    );
    expect(policies.rows).toEqual([
      { policyname: 'sessions_deny_anon_all', roles: 'anon', cmd: 'ALL', qual: 'false', with_check: 'false' },
      {
        policyname: 'sessions_deny_authenticated_all',
        roles: 'authenticated',
        cmd: 'ALL',
        qual: 'false',
        with_check: 'false',
      },
      { policyname: 'sessions_service_role_all', roles: 'service_role', cmd: 'ALL', qual: 'true', with_check: 'true' },
    ]);
  });

  test.each(['anon', 'authenticated'])(
    'DATA-AUTH-001 %s には表の権限が無く、読みも作成も権限の誤り（42501）で断られる',
    async (role) => {
      const userId = await insertUser();
      await insertSession(userId);

      const read = await failure('select count(*)::int as count from public.sessions', [], role);
      expect(read.code).toBe('42501');
      const result = await failure(
        `insert into public.sessions (user_id, refresh_token_hash) values ($1, 'rls-denied')`,
        [userId],
        role,
      );
      expect(result.code).toBe('42501');
    },
  );

  test('DATA-AUTH-001 service_role からは行が見え、作成・失効の印の更新ができる', async () => {
    const userId = await insertUser();
    const existing = await insertSession(userId);

    expect(await countAs('service_role')).toBeGreaterThanOrEqual(1);
    await db().query('savepoint as_service');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query('set local role service_role');
      const inserted = await db().query(
        `insert into public.sessions (user_id, refresh_token_hash) values ($1, $2) returning id::text as id`,
        [userId, sha256('by-service-role')],
      );
      const revoked = await db().query('update public.sessions set revoked_at = now() where id = $1', [existing]);

      expect(inserted.rowCount).toBe(1);
      expect(revoked.rowCount).toBe(1);
    } finally {
      await db().query('rollback to savepoint as_service');
    }
  });
});
