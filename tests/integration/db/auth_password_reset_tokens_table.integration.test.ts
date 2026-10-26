/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * AUTH の password_reset_tokens の表（DATA-AUTH-002）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
describeLocalDb('integration: AUTH の password_reset_tokens の表', (db) => {
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  let marker: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-auth-reset-${randomUUID()}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertUser(): Promise<string> {
    const result = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [`${marker}-${randomUUID()}@example.com`],
    );
    return result.rows[0].id;
  }

  async function insertToken(
    token: string,
    options: { userId?: string | null; email?: string; expiresInMinutes?: number } = {},
  ): Promise<string> {
    const result = await db().query(
      `insert into public.password_reset_tokens (user_id, email, token_hash, expires_at)
       values ($1, $2, $3, now() + make_interval(mins => $4)) returning id::text as id`,
      [options.userId ?? null, options.email ?? `${marker}@example.com`, sha256(token), options.expiresInMinutes ?? 10],
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

  /** 指定した役のまま印の行を数える。RLS が行を隠すかを確かめる。 */
  async function countAs(role: string): Promise<number> {
    await db().query('savepoint as_role');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query(`set local role ${role}`);
      const result = await db().query('select count(*)::int as count from public.password_reset_tokens');
      return result.rows[0].count;
    } finally {
      await db().query('rollback to savepoint as_role');
    }
  }

  test('DATA-AUTH-002 列は7本で、型と NOT NULL が設計どおり', async () => {
    const result = await db().query(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'password_reset_tokens'`,
    );

    const actual = Object.fromEntries(
      result.rows.map((row: { column_name: string; data_type: string; is_nullable: string }) => [
        row.column_name,
        `${row.data_type} ${row.is_nullable === 'NO' ? 'not null' : 'null'}`,
      ]),
    );
    expect(actual).toEqual({
      id: 'uuid not null',
      user_id: 'uuid null',
      email: 'text not null',
      token_hash: 'text not null',
      expires_at: 'timestamp with time zone not null',
      used: 'boolean not null',
      created_at: 'timestamp with time zone not null',
    });
  });

  test('DATA-AUTH-002 印を作ると id と作成時刻が付き、使用の印は未使用(false)から始まる', async () => {
    const tokenHash = sha256(`${marker}-defaults`);

    const result = await db().query(
      `insert into public.password_reset_tokens (email, token_hash, expires_at)
       values ($1, $2, now() + interval '10 minutes')
       returning id::text as id, used, created_at is not null as has_created_at, user_id`,
      [`${marker}@example.com`, tokenHash],
    );

    expect(result.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.rows[0]).toMatchObject({ used: false, has_created_at: true, user_id: null });
  });

  test.each([
    ['email', `insert into public.password_reset_tokens (token_hash, expires_at) values ('h', now())`],
    ['token_hash', `insert into public.password_reset_tokens (email, expires_at) values ('a@example.com', now())`],
    ['expires_at', `insert into public.password_reset_tokens (email, token_hash) values ('a@example.com', 'h')`],
  ])('DATA-AUTH-002 %s の無い作成は NOT NULL の違反で落ちる', async (_column, sql) => {
    const result = await failure(sql);

    expect(result.code).toBe('23502');
  });

  test('DATA-AUTH-002 印のハッシュは一意で、同じハッシュの2本目は落ちる', async () => {
    await insertToken('same-token');

    const result = await failure(
      `insert into public.password_reset_tokens (email, token_hash, expires_at)
       values ($1, $2, now() + interval '10 minutes')`,
      [`${marker}-other@example.com`, sha256('same-token')],
    );

    expect(result).toEqual({ code: '23505', constraint: 'idx_password_reset_tokens_token_hash' });
  });

  test('DATA-AUTH-002 同じ宛先に別のハッシュの印を何本でも持てる', async () => {
    await insertToken('first', { email: `${marker}@example.com` });
    await insertToken('second', { email: `${marker}@example.com` });

    const result = await db().query('select count(*)::int as count from public.password_reset_tokens where email = $1', [
      `${marker}@example.com`,
    ]);

    expect(result.rows[0].count).toBe(2);
  });

  test('DATA-AUTH-002 利用者の指定は任意で、存在しない利用者は外部キーの違反で落ちる', async () => {
    const userId = await insertUser();

    const withUser = await insertToken('with-user', { userId });
    const withoutUser = await insertToken('without-user', { userId: null });

    const rows = await db().query('select id::text as id, user_id::text as user_id from public.password_reset_tokens where id in ($1, $2)', [
      withUser,
      withoutUser,
    ]);
    expect(Object.fromEntries(rows.rows.map((row: { id: string; user_id: string | null }) => [row.id, row.user_id]))).toEqual({
      [withUser]: userId,
      [withoutUser]: null,
    });
    const orphan = await failure(
      `insert into public.password_reset_tokens (user_id, email, token_hash, expires_at)
       values ($1, 'a@example.com', 'orphan', now())`,
      [randomUUID()],
    );
    expect(orphan).toEqual({ code: '23503', constraint: 'password_reset_tokens_user_id_fkey' });
  });

  test('DATA-AUTH-002 利用者を消すと、その人の印だけが一緒に消える', async () => {
    const userId = await insertUser();
    const otherUserId = await insertUser();
    await insertToken('owner-1', { userId });
    await insertToken('owner-2', { userId });
    const kept = await insertToken('other-owner', { userId: otherUserId });
    const guest = await insertToken('no-owner', { userId: null });

    await db().query('delete from auth.users where id = $1', [userId]);

    const remaining = await db().query(
      'select id::text as id from public.password_reset_tokens where email = $1 order by id',
      [`${marker}@example.com`],
    );
    expect(remaining.rows.map((row: { id: string }) => row.id).sort()).toEqual([kept, guest].sort());
  });

  test('DATA-AUTH-002 宛先と期限・宛先と使用の印・ハッシュで引く索引がある', async () => {
    const result = await db().query(
      `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'password_reset_tokens'`,
    );

    const byName = Object.fromEntries(result.rows.map((row: { indexname: string; indexdef: string }) => [row.indexname, row.indexdef]));
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining([
        'password_reset_tokens_pkey',
        'idx_password_reset_tokens_email_expires_at',
        'idx_password_reset_tokens_email_used',
        'idx_password_reset_tokens_token_hash',
      ]),
    );
    expect(byName.idx_password_reset_tokens_token_hash).toContain('CREATE UNIQUE INDEX');
    expect(byName.idx_password_reset_tokens_email_expires_at).toContain('(email, expires_at DESC)');
    expect(byName.idx_password_reset_tokens_email_used).toContain('(email, used)');
  });

  test('DATA-AUTH-002 RLS は有効で、anon・authenticated を拒み service_role だけを通す方針が3本ある', async () => {
    const enabled = await db().query(
      `select relrowsecurity from pg_class where oid = 'public.password_reset_tokens'::regclass`,
    );
    expect(enabled.rows[0].relrowsecurity).toBe(true);

    const policies = await db().query(
      `select policyname, array_to_string(roles, ',') as roles, cmd, qual, with_check from pg_policies
       where schemaname = 'public' and tablename = 'password_reset_tokens' order by policyname`,
    );
    expect(policies.rows).toEqual([
      {
        policyname: 'password_reset_tokens_deny_anon_all',
        roles: 'anon',
        cmd: 'ALL',
        qual: 'false',
        with_check: 'false',
      },
      {
        policyname: 'password_reset_tokens_deny_authenticated_all',
        roles: 'authenticated',
        cmd: 'ALL',
        qual: 'false',
        with_check: 'false',
      },
      {
        policyname: 'password_reset_tokens_service_role_all',
        roles: 'service_role',
        cmd: 'ALL',
        qual: 'true',
        with_check: 'true',
      },
    ]);
  });

  test.each(['anon', 'authenticated'])('DATA-AUTH-002 %s には表の権限が無く、読みも作成も権限の誤り（42501）で断られる', async (role) => {
    await insertToken('hidden');

    const read = await failure('select count(*)::int as count from public.password_reset_tokens', [], role);
    expect(read.code).toBe('42501');
    const result = await failure(
      `insert into public.password_reset_tokens (email, token_hash, expires_at)
       values ('a@example.com', 'rls-denied', now() + interval '10 minutes')`,
      [],
      role,
    );
    expect(result.code).toBe('42501');
  });

  test('DATA-AUTH-002 service_role からは印が見え、作成・使用の印の更新ができる', async () => {
    const existing = await insertToken('service-role-visible');

    expect(await countAs('service_role')).toBeGreaterThanOrEqual(1);
    await db().query('savepoint as_service');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query('set local role service_role');
      const inserted = await db().query(
        `insert into public.password_reset_tokens (email, token_hash, expires_at)
         values ($1, $2, now() + interval '10 minutes') returning id::text as id`,
        [`${marker}@example.com`, sha256('by-service-role')],
      );
      const consumed = await db().query('update public.password_reset_tokens set used = true where id = $1', [existing]);

      expect(inserted.rowCount).toBe(1);
      expect(consumed.rowCount).toBe(1);
    } finally {
      await db().query('rollback to savepoint as_service');
    }
  });
});
