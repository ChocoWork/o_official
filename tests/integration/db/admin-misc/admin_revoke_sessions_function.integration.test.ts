/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb } from '../helpers/local-db';

/**
 * ADMIN の強制失効の DB の関数 revoke_auth_sessions_for_user と、自前の sessions の表（DATA-ADMIN-004）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
describeLocalDb('integration: ADMIN の強制失効の関数と sessions の表', (db) => {
  const FUNCTION = 'public.revoke_auth_sessions_for_user(uuid)';
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
      [`integration-admin-revoke-${randomUUID()}@example.com`],
    );
    return result.rows[0].id;
  }

  async function insertAuthSession(userId: string): Promise<string> {
    const result = await db().query(
      `insert into auth.sessions (id, user_id, created_at, updated_at)
       values (gen_random_uuid(), $1, now(), now()) returning id::text as id`,
      [userId],
    );
    return result.rows[0].id;
  }

  async function insertOwnSession(userId: string): Promise<string> {
    const result = await db().query(
      `insert into public.sessions (user_id, refresh_token_hash, expires_at)
       values ($1, $2, now() + interval '30 days') returning id::text as id`,
      [userId, sha256(randomUUID())],
    );
    return result.rows[0].id;
  }

  async function authSessionIds(userId: string): Promise<string[]> {
    const result = await db().query('select id::text as id from auth.sessions where user_id = $1', [userId]);
    return result.rows.map((row: { id: string }) => row.id).sort();
  }

  async function ownSessionIds(userId: string): Promise<string[]> {
    const result = await db().query('select id::text as id from public.sessions where user_id = $1', [userId]);
    return result.rows.map((row: { id: string }) => row.id).sort();
  }

  /**
   * 指定した役のまま関数を呼び、消した数か SQLSTATE を返す。
   * 成功した時は変更を残して役だけ戻す。断られた時は savepoint まで戻す。
   */
  async function callAs(role: string, userId: string): Promise<{ deleted?: number; code?: string }> {
    await db().query('savepoint as_role');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query(`set local role ${role}`);
      const result = await db().query('select public.revoke_auth_sessions_for_user($1) as deleted', [userId]);
      await db().query('reset role');
      return { deleted: result.rows[0].deleted };
    } catch (caught) {
      await db().query('rollback to savepoint as_role');
      return { code: (caught as { code?: string }).code };
    }
  }

  /** 失敗が取引全体を壊さないよう、savepoint の中で役を替えて流し、SQLSTATE を返す。 */
  async function failureAs(role: string, sql: string, params: unknown[] = []): Promise<string | undefined> {
    await db().query('savepoint expected_failure');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query(`set local role ${role}`);
      await db().query(sql, params);
      return undefined;
    } catch (caught) {
      return (caught as { code?: string }).code;
    } finally {
      await db().query('rollback to savepoint expected_failure');
    }
  }

  /** 指定した役のまま流した文の行の数を返す。RLS が行を隠す・断るかを確かめる。 */
  async function rowCountAs(role: string, sql: string, params: unknown[] = []): Promise<number> {
    await db().query('savepoint as_role_count');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query(`set local role ${role}`);
      const result = await db().query(sql, params);
      return result.rowCount;
    } finally {
      await db().query('rollback to savepoint as_role_count');
    }
  }

  describe('関数 revoke_auth_sessions_for_user', () => {
    test('DATA-ADMIN-004 uuid を受けて integer を返す関数が1本だけある', async () => {
      const result = await db().query(
        `select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'revoke_auth_sessions_for_user'`,
      );

      expect(result.rows).toEqual([{ args: 'p_user_id uuid', result: 'integer' }]);
    });

    test('DATA-ADMIN-004 SECURITY DEFINER で、search_path は空', async () => {
      const result = await db().query(
        `select p.prosecdef, array_to_string(p.proconfig, ',') as config from pg_proc p where p.oid = $1::regprocedure`,
        [FUNCTION],
      );

      expect(result.rows[0].prosecdef).toBe(true);
      expect(result.rows[0].config).toBe('search_path=""');
    });

    test('DATA-ADMIN-004 実行できるのは postgres と service_role だけで、PUBLIC・anon・authenticated には許さない', async () => {
      const result = await db().query(
        `select has_function_privilege('postgres', $1::regprocedure, 'EXECUTE') as postgres,
                has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role,
                has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authenticated,
                (p.proacl is null or exists (
                   select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'
                 )) as public_can_execute
           from pg_proc p where p.oid = $1::regprocedure`,
        [FUNCTION],
      );

      expect(result.rows[0]).toEqual({
        postgres: true,
        service_role: true,
        anon: false,
        authenticated: false,
        public_can_execute: false,
      });
    });

    test.each(['anon', 'authenticated'])(
      'DATA-ADMIN-004 %s が呼ぶと権限不足で断られ、他人の session は消えない',
      async (role) => {
        const userId = await insertUser();
        const sessionId = await insertAuthSession(userId);

        const result = await callAs(role, userId);

        expect(result).toEqual({ code: '42501' });
        expect(await authSessionIds(userId)).toEqual([sessionId]);
      },
    );

    test('DATA-ADMIN-004 service_role が呼ぶと、その利用者の Auth の session を全部消して消した数を返す', async () => {
      const userId = await insertUser();
      await insertAuthSession(userId);
      await insertAuthSession(userId);
      await insertAuthSession(userId);

      const result = await callAs('service_role', userId);

      expect(result).toEqual({ deleted: 3 });
      expect(await authSessionIds(userId)).toEqual([]);
    });

    test('DATA-ADMIN-004 別の利用者の Auth の session は残す', async () => {
      const userId = await insertUser();
      const otherUserId = await insertUser();
      await insertAuthSession(userId);
      const kept = await insertAuthSession(otherUserId);

      const result = await db().query('select public.revoke_auth_sessions_for_user($1) as deleted', [userId]);

      expect(result.rows[0].deleted).toBe(1);
      expect(await authSessionIds(userId)).toEqual([]);
      expect(await authSessionIds(otherUserId)).toEqual([kept]);
    });

    test('DATA-ADMIN-004 session の無い利用者と存在しない利用者の id は0を返し、何も消さない', async () => {
      const userId = await insertUser();
      const otherUserId = await insertUser();
      const kept = await insertAuthSession(otherUserId);

      const none = await db().query('select public.revoke_auth_sessions_for_user($1) as deleted', [userId]);
      const missing = await db().query('select public.revoke_auth_sessions_for_user($1) as deleted', [randomUUID()]);

      expect(none.rows[0].deleted).toBe(0);
      expect(missing.rows[0].deleted).toBe(0);
      expect(await authSessionIds(otherUserId)).toEqual([kept]);
    });

    test('DATA-ADMIN-004 自前の sessions の行は触らず、Auth 側だけを消す', async () => {
      const userId = await insertUser();
      await insertAuthSession(userId);
      const own = await insertOwnSession(userId);

      await db().query('select public.revoke_auth_sessions_for_user($1)', [userId]);

      expect(await authSessionIds(userId)).toEqual([]);
      expect(await ownSessionIds(userId)).toEqual([own]);
    });
  });

  describe('自前の sessions の表', () => {
    test('DATA-ADMIN-004 利用者と refresh の印のハッシュだけで作ると、失効の時刻は空で、隔離の印は偽', async () => {
      const userId = await insertUser();

      const result = await db().query(
        `insert into public.sessions (user_id, refresh_token_hash) values ($1, $2)
         returning revoked_at, quarantined, csrf_token_hash, expires_at, created_at is not null as has_created_at`,
        [userId, sha256('only-required')],
      );

      expect(result.rows[0]).toEqual({
        revoked_at: null,
        quarantined: false,
        csrf_token_hash: null,
        expires_at: null,
        has_created_at: true,
      });
    });

    test('DATA-ADMIN-004 失効の時刻を入れると、その行に残り、同じ利用者のほかの行は空のまま', async () => {
      const userId = await insertUser();
      const target = await insertOwnSession(userId);
      const other = await insertOwnSession(userId);

      await db().query('update public.sessions set revoked_at = now() where user_id = $1 and id = $2', [userId, target]);

      const result = await db().query(
        'select id::text as id, revoked_at is not null as revoked from public.sessions where user_id = $1',
        [userId],
      );
      const byId = Object.fromEntries(result.rows.map((row: { id: string; revoked: boolean }) => [row.id, row.revoked]));
      expect(byId).toEqual({ [target]: true, [other]: false });
    });

    test('DATA-ADMIN-004 存在しない利用者の行は外部キーの違反で落ち、利用者の無い作成は NOT NULL の違反で落ちる', async () => {
      const foreignKey = await failureAs(
        'service_role',
        'insert into public.sessions (user_id, refresh_token_hash) values ($1, $2)',
        [randomUUID(), sha256('orphan')],
      );
      const notNull = await failureAs('service_role', `insert into public.sessions (refresh_token_hash) values ('hash')`);

      expect(foreignKey).toBe('23503');
      expect(notNull).toBe('23502');
    });

    test('DATA-ADMIN-004 利用者を消すと、その人の自前の sessions も一緒に消える', async () => {
      const userId = await insertUser();
      const otherUserId = await insertUser();
      await insertOwnSession(userId);
      await insertOwnSession(userId);
      const kept = await insertOwnSession(otherUserId);

      await db().query('delete from auth.users where id = $1', [userId]);

      expect(await ownSessionIds(userId)).toEqual([]);
      expect(await ownSessionIds(otherUserId)).toEqual([kept]);
    });

    test('DATA-ADMIN-004 行の保護（RLS）が有効になっている', async () => {
      const result = await db().query(`select relrowsecurity from pg_class where oid = 'public.sessions'::regclass`);

      expect(result.rows[0].relrowsecurity).toBe(true);
    });

    test.each(['anon', 'authenticated'])('DATA-ADMIN-004 %s には sessions の表の権限が無く、行を1件も読めない（権限の誤り 42501）', async (role) => {
      const userId = await insertUser();
      await insertOwnSession(userId);

      const code = await failureAs(role, 'select id from public.sessions where user_id = $1', [userId]);

      expect(code).toBe('42501');
    });

    test.each(['anon', 'authenticated'])('DATA-ADMIN-004 %s は sessions に行を足せず、権限の誤り（42501）で落ちる', async (role) => {
      const userId = await insertUser();

      const code = await failureAs(role, 'insert into public.sessions (user_id, refresh_token_hash) values ($1, $2)', [
        userId,
        sha256('denied'),
      ]);

      expect(code).toBe('42501');
    });

    test.each(['anon', 'authenticated'])('DATA-ADMIN-004 %s は sessions の行を書き換えられず消せない', async (role) => {
      const userId = await insertUser();
      const sessionId = await insertOwnSession(userId);

      const updated = await failureAs(role, 'update public.sessions set revoked_at = now() where id = $1', [sessionId]);
      const deleted = await failureAs(role, 'delete from public.sessions where id = $1', [sessionId]);

      expect(updated).toBe('42501');
      expect(deleted).toBe('42501');
      expect(await ownSessionIds(userId)).toEqual([sessionId]);
    });

    test('DATA-ADMIN-004 service_role は sessions の行を読め、失効の時刻を書き込める', async () => {
      const userId = await insertUser();
      const sessionId = await insertOwnSession(userId);

      const readable = await rowCountAs('service_role', 'select id from public.sessions where id = $1', [sessionId]);
      const updated = await rowCountAs('service_role', 'update public.sessions set revoked_at = now() where id = $1', [sessionId]);

      expect(readable).toBe(1);
      expect(updated).toBe(1);
    });
  });
});
