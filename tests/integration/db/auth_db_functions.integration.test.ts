/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * AUTH の DB の関数 6 本（DATA-AUTH-003）。
 * アカウントの照会・セッションの失効・回数の数え・再設定の印の掃除。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
describeLocalDb('integration: AUTH の DB の関数', (db) => {
  let marker: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-auth-fn-${randomUUID()}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertUser(
    email: string,
    options: { sso?: boolean; bannedUntilSql?: string; deleted?: boolean } = {},
  ): Promise<string> {
    const result = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at, is_sso_user, banned_until, deleted_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now(), $2::boolean, ${options.bannedUntilSql ?? 'null'}, ${
         options.deleted ? 'now()' : 'null'
       }) returning id::text as id`,
      [email, options.sso ?? false],
    );
    return result.rows[0].id;
  }

  async function findByEmail(email: string | null): Promise<string | null> {
    const result = await db().query('select public.find_auth_user_id_by_email($1)::text as id', [email]);
    return result.rows[0].id;
  }

  async function insertAuthSession(userId: string, notAfterSql = 'null'): Promise<string> {
    const result = await db().query(
      `insert into auth.sessions (id, user_id, created_at, updated_at, not_after)
       values (gen_random_uuid(), $1, now(), now(), ${notAfterSql}) returning id::text as id`,
      [userId],
    );
    return result.rows[0].id;
  }

  async function sessionActive(sessionId: string): Promise<boolean> {
    const result = await db().query('select public.is_auth_session_active($1) as active', [sessionId]);
    return result.rows[0].active;
  }

  async function authSessionIds(userId: string): Promise<string[]> {
    const result = await db().query('select id::text as id from auth.sessions where user_id = $1', [userId]);
    return result.rows.map((row: { id: string }) => row.id).sort();
  }

  async function increment(ip: string | null, endpoint: string, bucket: string, by?: number | null): Promise<number> {
    const result =
      by === undefined
        ? await db().query('select public.increment_rate_limit_counter($1::inet, $2::text, $3::timestamptz) as count', [
            ip,
            endpoint,
            bucket,
          ])
        : await db().query(
            'select public.increment_rate_limit_counter($1::inet, $2::text, $3::timestamptz, $4::integer) as count',
            [ip, endpoint, bucket, by],
          );
    return Number(result.rows[0].count);
  }

  async function insertResetToken(label: string, options: { createdDaysAgo: number; used?: boolean; expired?: boolean }): Promise<string> {
    const result = await db().query(
      `insert into public.password_reset_tokens (email, token_hash, expires_at, used, created_at)
       values ($1, $2, now() + make_interval(mins => $3), $4, now() - make_interval(days => $5)) returning id::text as id`,
      [`${marker}@example.com`, `${marker}-${label}`, options.expired ? -30 : 30, options.used ?? false, options.createdDaysAgo],
    );
    return result.rows[0].id;
  }

  async function resetTokenIds(): Promise<string[]> {
    const result = await db().query('select id::text as id from public.password_reset_tokens where email = $1', [
      `${marker}@example.com`,
    ]);
    return result.rows.map((row: { id: string }) => row.id).sort();
  }

  async function sweepableCount(retainDays: number): Promise<number> {
    const result = await db().query(
      `select count(*)::int as count from public.password_reset_tokens
       where created_at < now() - make_interval(days => greatest($1::integer, 0)) and (used = true or expires_at < now())`,
      [retainDays],
    );
    return result.rows[0].count;
  }

  const SIGNATURES = [
    'public.find_auth_user_id_by_email(text)',
    'public.revoke_auth_session(uuid)',
    'public.revoke_auth_sessions_for_user(uuid)',
    'public.is_auth_session_active(uuid)',
    'public.increment_rate_limit_counter(inet, text, timestamp with time zone)',
    'public.increment_rate_limit_counter(inet, text, timestamp with time zone, integer)',
    'public.cleanup_password_reset_tokens(integer)',
  ];

  describe('関数の定義と実行の権限', () => {
    test.each(SIGNATURES)('DATA-AUTH-003 %s は SECURITY DEFINER で、一時スキーマを先に見ない search_path を持つ', async (signature) => {
      const result = await db().query(
        `select p.prosecdef, array_to_string(p.proconfig, ',') as config from pg_proc p where p.oid = $1::regprocedure`,
        [signature],
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].prosecdef).toBe(true);
      expect(result.rows[0].config).toMatch(/^search_path=(""|.*pg_temp)$/);
    });

    test.each(SIGNATURES)('DATA-AUTH-003 %s は service_role が実行でき、PUBLIC には許さない', async (signature) => {
      const result = await db().query(
        `select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role,
                (p.proacl is null or exists (
                   select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'
                 )) as public_can_execute
           from pg_proc p where p.oid = $1::regprocedure`,
        [signature],
      );

      expect(result.rows[0]).toEqual({ service_role: true, public_can_execute: false });
    });

    test('DATA-AUTH-003 service_role の役のままでもアカウントの照会の関数を呼べる', async () => {
      const email = `${marker}@example.com`;
      const userId = await insertUser(email);

      await db().query('savepoint as_service');
      try {
        await db().query("select set_config('request.jwt.claims', '', true)");
        await db().query('set local role service_role');
        const result = await db().query('select public.find_auth_user_id_by_email($1)::text as id', [email]);

        expect(result.rows[0].id).toBe(userId);
      } finally {
        await db().query('rollback to savepoint as_service');
      }
    });
  });

  describe('find_auth_user_id_by_email', () => {
    test('DATA-AUTH-003 登録済みのメールからその利用者の id を1回で引く', async () => {
      const email = `${marker}@example.com`;
      const userId = await insertUser(email);

      expect(await findByEmail(email)).toBe(userId);
    });

    test('DATA-AUTH-003 入力の前後の空白と大文字小文字をそろえてから引く', async () => {
      const email = `${marker}@example.com`;
      const userId = await insertUser(email);

      expect(await findByEmail(`  ${email.toUpperCase()}\t`)).toBe(userId);
    });

    test('DATA-AUTH-003 登録の無いメールと空の入力は null を返す', async () => {
      expect(await findByEmail(`${marker}-unknown@example.com`)).toBeNull();
      expect(await findByEmail('')).toBeNull();
      expect(await findByEmail(null)).toBeNull();
    });

    test('DATA-AUTH-003 SSO の利用者は外して引く', async () => {
      const email = `${marker}@example.com`;
      await insertUser(email, { sso: true });

      expect(await findByEmail(email)).toBeNull();
    });

    test('DATA-AUTH-003 論理削除した利用者は外して引く', async () => {
      const email = `${marker}@example.com`;
      await insertUser(email, { deleted: true });

      expect(await findByEmail(email)).toBeNull();
    });

    test('DATA-AUTH-003 停止の期限がこれからの利用者は外し、期限が過ぎた利用者は引く', async () => {
      const banned = `${marker}-banned@example.com`;
      const expired = `${marker}-expired@example.com`;
      await insertUser(banned, { bannedUntilSql: "now() + interval '1 hour'" });
      const expiredId = await insertUser(expired, { bannedUntilSql: "now() - interval '1 hour'" });

      expect(await findByEmail(banned)).toBeNull();
      expect(await findByEmail(expired)).toBe(expiredId);
    });

    test('DATA-AUTH-003 利用者が100人を超えても、先頭の100件に入らない人を引ける', async () => {
      await db().query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         select gen_random_uuid(), $1::text || g::text || '@example.com', '{}'::jsonb, now(), now()
           from generate_series(1, 150) g`,
        [`${marker}-bulk-`],
      );

      const last = await findByEmail(`${marker}-bulk-150@example.com`);

      expect(last).not.toBeNull();
      const stored = await db().query('select email from auth.users where id = $1', [last]);
      expect(stored.rows[0].email).toBe(`${marker}-bulk-150@example.com`);
    }, 30000);
  });

  describe('is_auth_session_active・revoke_auth_session・revoke_auth_sessions_for_user', () => {
    test('DATA-AUTH-003 期限の無いセッションと期限がこれからのセッションは生きている', async () => {
      const userId = await insertUser(`${marker}@example.com`);
      const noLimit = await insertAuthSession(userId);
      const future = await insertAuthSession(userId, "now() + interval '1 hour'");

      expect(await sessionActive(noLimit)).toBe(true);
      expect(await sessionActive(future)).toBe(true);
    });

    test('DATA-AUTH-003 期限が過ぎたセッションと存在しないセッションは生きていない', async () => {
      const userId = await insertUser(`${marker}@example.com`);
      const past = await insertAuthSession(userId, "now() - interval '1 minute'");

      expect(await sessionActive(past)).toBe(false);
      expect(await sessionActive(randomUUID())).toBe(false);
    });

    test('DATA-AUTH-003 セッションを1本失効すると1を返し、ほかのセッションは残る', async () => {
      const userId = await insertUser(`${marker}@example.com`);
      const target = await insertAuthSession(userId);
      const other = await insertAuthSession(userId);

      const result = await db().query('select public.revoke_auth_session($1) as deleted', [target]);

      expect(result.rows[0].deleted).toBe(1);
      expect(await sessionActive(target)).toBe(false);
      expect(await sessionActive(other)).toBe(true);
      expect(await authSessionIds(userId)).toEqual([other]);
    });

    test('DATA-AUTH-003 存在しないセッションの失効は0を返し、何も消さない', async () => {
      const userId = await insertUser(`${marker}@example.com`);
      const kept = await insertAuthSession(userId);

      const result = await db().query('select public.revoke_auth_session($1) as deleted', [randomUUID()]);

      expect(result.rows[0].deleted).toBe(0);
      expect(await authSessionIds(userId)).toEqual([kept]);
    });

    test('DATA-AUTH-003 利用者単位の失効はその人のセッションを全部消して本数を返し、別の人の分は残す', async () => {
      const userId = await insertUser(`${marker}-a@example.com`);
      const otherUserId = await insertUser(`${marker}-b@example.com`);
      const mine = [await insertAuthSession(userId), await insertAuthSession(userId), await insertAuthSession(userId)];
      const theirs = await insertAuthSession(otherUserId);

      const result = await db().query('select public.revoke_auth_sessions_for_user($1) as deleted', [userId]);

      expect(result.rows[0].deleted).toBe(3);
      for (const sessionId of mine) expect(await sessionActive(sessionId)).toBe(false);
      expect(await authSessionIds(otherUserId)).toEqual([theirs]);
    });

    test('DATA-AUTH-003 セッションの無い利用者の失効は0を返す', async () => {
      const userId = await insertUser(`${marker}@example.com`);

      const result = await db().query('select public.revoke_auth_sessions_for_user($1) as deleted', [userId]);

      expect(result.rows[0].deleted).toBe(0);
    });
  });

  describe('increment_rate_limit_counter', () => {
    const bucket = '2026-10-24T00:00:00.000Z';

    test('DATA-AUTH-003 同じ IP・窓口・時間枠は呼ぶたびに 1、2、3 と数える', async () => {
      const endpoint = `/api/auth/${marker}`;

      expect(await increment('203.0.113.9', endpoint, bucket)).toBe(1);
      expect(await increment('203.0.113.9', endpoint, bucket)).toBe(2);
      expect(await increment('203.0.113.9', endpoint, bucket)).toBe(3);
    });

    test('DATA-AUTH-003 IP・窓口・時間枠のどれかが違えば別に数える', async () => {
      const endpoint = `/api/auth/${marker}`;
      await increment('203.0.113.9', endpoint, bucket);

      expect(await increment('203.0.113.10', endpoint, bucket)).toBe(1);
      expect(await increment('203.0.113.9', `${endpoint}-other`, bucket)).toBe(1);
      expect(await increment('203.0.113.9', endpoint, '2026-10-24T00:01:00.000Z')).toBe(1);
    });

    test('DATA-AUTH-003 IP の無い数え(宛先やアカウント単位)は1行にまとまって増える', async () => {
      const endpoint = `auth:login|acct:${marker}`;

      expect(await increment(null, endpoint, bucket)).toBe(1);
      expect(await increment(null, endpoint, bucket)).toBe(2);
      const stored = await db().query(
        'select count(*)::int as rows, max(count) as count from public.rate_limit_counters where ip is null and endpoint = $1',
        [endpoint],
      );
      expect(stored.rows[0]).toEqual({ rows: 1, count: 2 });
    });

    test('DATA-AUTH-003 加算の大きさを渡すとその分だけ増え、足し合わせた値を返す', async () => {
      const endpoint = `admin:upload-bytes|acct:${marker}`;

      expect(await increment(null, endpoint, bucket, 100)).toBe(100);
      expect(await increment(null, endpoint, bucket, 50)).toBe(150);
    });

    test.each([0, -5, null])('DATA-AUTH-003 加算の大きさが %s なら 1 に直して数える', async (by) => {
      const endpoint = `auth:normalize|acct:${marker}`;

      expect(await increment(null, endpoint, bucket, by)).toBe(1);
      expect(await increment(null, endpoint, bucket, by)).toBe(2);
    });
  });

  describe('cleanup_password_reset_tokens', () => {
    test('DATA-AUTH-003 既定の7日より古い、使用済みか期限切れの印だけを消して件数を返す', async () => {
      const oldUsed = await insertResetToken('old-used', { createdDaysAgo: 10, used: true });
      const oldExpired = await insertResetToken('old-expired', { createdDaysAgo: 10, expired: true });
      const oldLive = await insertResetToken('old-live', { createdDaysAgo: 10 });
      const recentUsed = await insertResetToken('recent-used', { createdDaysAgo: 1, used: true });
      const recentExpired = await insertResetToken('recent-expired', { createdDaysAgo: 1, expired: true });
      const sweepable = await sweepableCount(7);

      const result = await db().query('select public.cleanup_password_reset_tokens() as deleted');

      expect(sweepable).toBeGreaterThanOrEqual(2);
      expect(result.rows[0].deleted).toBe(sweepable);
      const remaining = await resetTokenIds();
      expect(remaining).toEqual([oldLive, recentUsed, recentExpired].sort());
      expect(remaining).not.toContain(oldUsed);
      expect(remaining).not.toContain(oldExpired);
    });

    test('DATA-AUTH-003 保持の日数を渡すと、その日数より古い分だけを消す', async () => {
      const twoDaysUsed = await insertResetToken('two-days-used', { createdDaysAgo: 2, used: true });
      const halfDayUsed = await db().query(
        `insert into public.password_reset_tokens (email, token_hash, expires_at, used, created_at)
         values ($1, $2, now() + interval '30 minutes', true, now() - interval '12 hours') returning id::text as id`,
        [`${marker}@example.com`, `${marker}-half-day`],
      );

      await db().query('select public.cleanup_password_reset_tokens(1)');

      expect(await resetTokenIds()).toEqual([halfDayUsed.rows[0].id]);
      expect(await resetTokenIds()).not.toContain(twoDaysUsed);
    });

    test.each([0, -3])('DATA-AUTH-003 保持の日数が %s なら 0 日として扱い、いま以前の使用済み・期限切れを全部消す', async (days) => {
      const recentUsed = await insertResetToken('recent-used', { createdDaysAgo: 1, used: true });
      const recentExpired = await insertResetToken('recent-expired', { createdDaysAgo: 1, expired: true });
      const live = await insertResetToken('live', { createdDaysAgo: 1 });

      await db().query('select public.cleanup_password_reset_tokens($1)', [days]);

      const remaining = await resetTokenIds();
      expect(remaining).toEqual([live]);
      expect(remaining).not.toContain(recentUsed);
      expect(remaining).not.toContain(recentExpired);
    });

    test('DATA-AUTH-003 消す物が無ければ、自分の行は触らず件数は対象の数と一致する', async () => {
      const live = await insertResetToken('live', { createdDaysAgo: 10 });
      const sweepable = await sweepableCount(7);

      const result = await db().query('select public.cleanup_password_reset_tokens(7) as deleted');

      expect(result.rows[0].deleted).toBe(sweepable);
      expect(await resetTokenIds()).toEqual([live]);
    });
  });
});
