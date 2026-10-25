/** @jest-environment node */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { connectLocalDb, describeLocalDb, isLocalDatabase, type PgClient } from './helpers/local-db';

/**
 * 戻り先の控え（private.auth_return_intents と public の 2 本の関数。DATA-AUTH-005、SEC-AUTH-032）。
 * 手元の使い捨て DB でだけ流す。DATABASE_URL が無ければ skip。
 * 各試験は取引の中で動かして巻き戻す。例外は並行の試験と PostgREST の試験（実コミットし、接頭辞で後始末する）。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
const MIGRATION_FILE = fs.readdirSync(MIGRATIONS_DIR).find((name) => name.endsWith('_auth_return_intents.sql'));
// 作業ツリーが CRLF（core.autocrlf）でも同じ結果になるよう、改行は LF に揃えて読む。
const MIGRATION_SQL = MIGRATION_FILE
  ? fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE), 'utf8').replace(/\r\n/g, '\n')
  : '';

const TABLE = 'private.auth_return_intents';
const CREATE = 'public.create_auth_return_intent(text,text,text)';
const CONSUME = 'public.consume_auth_return_intent(text,text,uuid)';
const TABLE_PRIVILEGES = 'select,insert,update,delete,truncate,references,trigger';
/** 実コミットする試験が作る行を見分ける接頭辞（16 進）。後始末はこの接頭辞で消す。 */
const COMMITTED_PREFIX = 'a11c0de0';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const committedHash = () => `${COMMITTED_PREFIX}${randomBytes(28).toString('hex')}`;

function sectionOf(sql: string, begin: string, end: string): string {
  const from = sql.indexOf(begin);
  const to = from < 0 ? -1 : sql.indexOf(end, from + begin.length);
  return from < 0 || to < 0 ? '' : sql.slice(from, to);
}

describe('DATA-AUTH-005 戻り先の控えの移行ファイル（DB なし）', () => {
  test('DATA-AUTH-005 移行ファイルがあり、末尾の確かめの区間を取り出せる', () => {
    expect(MIGRATION_FILE).toBeDefined();
    expect(sectionOf(MIGRATION_SQL, '-- AUTH_RETURN_INTENT_ASSERT_BEGIN', '-- AUTH_RETURN_INTENT_ASSERT_END')).toContain(
      'AUTH_RETURN_INTENT_ASSERTION_FAILED',
    );
  });
});

describeLocalDb('DATA-AUTH-005 戻り先の控えの表と関数', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

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
      await db().query('release savepoint expected_failure');
    }
  }

  async function create(hash: string, returnPath: string, purpose: string): Promise<number> {
    const result = await db().query('select public.create_auth_return_intent($1, $2, $3) as seconds', [hash, returnPath, purpose]);
    return result.rows[0].seconds;
  }

  async function consume(hash: string, purpose: string, userId: string | null): Promise<string | null> {
    const result = await db().query('select public.consume_auth_return_intent($1, $2, $3::uuid) as path', [hash, purpose, userId]);
    return result.rows[0].path;
  }

  async function rowOf(hash: string) {
    const result = await db().query(`select * from ${TABLE} where token_hash = $1`, [hash]);
    return result.rows[0];
  }

  async function insertRaw(hash: string, returnPath: string, purpose = 'login') {
    return db().query(
      `insert into ${TABLE} (token_hash, return_path, purpose, expires_at)
       values ($1, $2, $3, now() + interval '15 minutes')`,
      [hash, returnPath, purpose],
    );
  }

  describe('権限', () => {
    test('DATA-AUTH-005 表は anon・authenticated・service_role のどの表の権限も持たず、RLS が有効で、所有者は postgres', async () => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const result = await db().query(
          `select (select array_agg(p) from unnest(string_to_array($2, ',')) as p
                    where has_table_privilege($1, 'private.auth_return_intents', p)) as held`,
          [role, TABLE_PRIVILEGES],
        );
        expect({ role, held: result.rows[0].held }).toEqual({ role, held: null });
      }
      const table = await db().query(
        `select c.relrowsecurity, c.relowner::regrole::text as owner,
                exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as x where x.grantee = 0) as public_grant
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'private' and c.relname = 'auth_return_intents'`,
      );
      expect(table.rows[0]).toEqual({ relrowsecurity: true, owner: 'postgres', public_grant: false });
    });

    test('DATA-AUTH-005 anon・authenticated・service_role は表を直接読み書きできない（42501）', async () => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect({ role, ...(await failure(`select 1 from ${TABLE}`, [], role)) }).toEqual({ role, code: '42501' });
        expect({ role, ...(await failure(`delete from ${TABLE}`, [], role)) }).toEqual({ role, code: '42501' });
      }
    });

    test('DATA-AUTH-005 2 本の関数は service_role だけが EXECUTE でき、DEFINER で search_path は空', async () => {
      for (const signature of [CREATE, CONSUME]) {
        const result = await db().query(
          `select has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
                  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as x
                          where x.grantee = 0 and x.privilege_type = 'EXECUTE') as public_execute,
                  p.prosecdef, p.proowner::regrole::text as owner, p.proconfig
           from pg_proc p where p.oid = to_regprocedure($1)`,
          [signature],
        );
        expect({ signature, ...result.rows[0] }).toEqual({
          signature,
          anon: false,
          authenticated: false,
          service_role: true,
          public_execute: false,
          prosecdef: true,
          owner: 'postgres',
          proconfig: ['search_path=""'],
        });
      }
    });

    test('DATA-AUTH-005 consume だけが STRICT で、戻り値の型は create が integer、consume が text', async () => {
      const result = await db().query(
        `select p.proname, p.proisstrict, p.prorettype::regtype::text as ret
         from pg_proc p where p.oid in (to_regprocedure($1), to_regprocedure($2)) order by p.proname`,
        [CREATE, CONSUME],
      );
      expect(result.rows).toEqual([
        { proname: 'consume_auth_return_intent', proisstrict: true, ret: 'text' },
        { proname: 'create_auth_return_intent', proisstrict: false, ret: 'integer' },
      ]);
    });

    test('DATA-AUTH-005 anon・authenticated は 2 本の関数を呼べず（42501）、service_role は呼べる', async () => {
      for (const role of ['anon', 'authenticated']) {
        expect({
          role,
          ...(await failure('select public.create_auth_return_intent($1, $2, $3)', [sha256(`acl-${role}`), '/account', 'login'], role)),
        }).toEqual({ role, code: '42501' });
        expect({
          role,
          ...(await failure('select public.consume_auth_return_intent($1, $2, $3::uuid)', [sha256(`acl-${role}`), 'login', randomUUID()], role)),
        }).toEqual({ role, code: '42501' });
      }
      // service_role は DEFINER の関数を通して表を触れる（表の権限が無くても）
      await db().query('savepoint as_service');
      try {
        await db().query("select set_config('request.jwt.claims', '', true)");
        await db().query('set local role service_role');
        const hash = sha256('acl-service');
        const seconds = await db().query('select public.create_auth_return_intent($1, $2, $3) as seconds', [hash, '/account', 'login']);
        expect(seconds.rows[0].seconds).toBe(900);
        const path = await db().query('select public.consume_auth_return_intent($1, $2, $3::uuid) as path', [hash, 'login', randomUUID()]);
        expect(path.rows[0].path).toBe('/account');
      } finally {
        await db().query('rollback to savepoint as_service');
        await db().query('release savepoint as_service');
      }
    });
  });

  describe('構造', () => {
    test('DATA-AUTH-005 列は 8 本で、番号の平文の列が無い（token_hash だけ）', async () => {
      const result = await db().query(
        `select column_name, data_type, is_nullable from information_schema.columns
         where table_schema = 'private' and table_name = 'auth_return_intents' order by ordinal_position`,
      );
      expect(result.rows).toEqual([
        { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'token_hash', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'return_path', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'purpose', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
        { column_name: 'expires_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
        { column_name: 'consumed_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
        { column_name: 'user_id', data_type: 'uuid', is_nullable: 'YES' },
      ]);
    });

    test('DATA-AUTH-005 token_hash は一意で、auth.users への外部キーが無い', async () => {
      const unique = await db().query(
        `select count(*)::int as count from pg_constraint
         where conrelid = 'private.auth_return_intents'::regclass and contype = 'u'`,
      );
      expect(unique.rows[0].count).toBe(1);
      const foreignKeys = await db().query(
        `select count(*)::int as count from pg_constraint
         where conrelid = 'private.auth_return_intents'::regclass and contype = 'f'`,
      );
      expect(foreignKeys.rows[0].count).toBe(0);
    });
  });

  describe('作る', () => {
    test.each([
      ['login', 900],
      ['signup', 3600],
    ])('DATA-AUTH-005 %s の控えを作ると %i 秒を返し、行の期限と作成の差も同じ秒数で、保存されるのはハッシュだけ', async (purpose, seconds) => {
      const hash = sha256(`create-${purpose}-${randomUUID()}`);
      expect(await create(hash, '/account?tab=orders', purpose)).toBe(seconds);
      const row = await db().query(
        `select token_hash, return_path, purpose, consumed_at, user_id,
                extract(epoch from expires_at - created_at)::int as seconds
         from ${TABLE} where token_hash = $1`,
        [hash],
      );
      expect(row.rows).toEqual([
        { token_hash: hash, return_path: '/account?tab=orders', purpose, consumed_at: null, user_id: null, seconds },
      ]);
    });

    test('DATA-AUTH-005 不正な用途は 23514（表の CHECK）で止まり、行は残らない', async () => {
      const hash = sha256(`create-bad-purpose-${randomUUID()}`);
      expect(await failure('select public.create_auth_return_intent($1, $2, $3)', [hash, '/account', 'admin'])).toMatchObject({
        code: '23514',
        constraint: 'auth_return_intents_purpose_check',
      });
      expect(await rowOf(hash)).toBeUndefined();
    });

    test('DATA-AUTH-005 同じハッシュの 2 回目は 23505', async () => {
      const hash = sha256(`create-duplicate-${randomUUID()}`);
      await create(hash, '/account', 'login');
      expect(await failure('select public.create_auth_return_intent($1, $2, $3)', [hash, '/cart', 'login'])).toMatchObject({
        code: '23505',
      });
    });
  });

  describe('使い切る', () => {
    test('DATA-AUTH-005 1 回目は return_path を返して consumed_at・user_id が入り、2 回目は NULL', async () => {
      const hash = sha256(`consume-${randomUUID()}`);
      const userId = randomUUID();
      await create(hash, '/item/abc?color=black', 'login');
      expect(await consume(hash, 'login', userId)).toBe('/item/abc?color=black');
      const row = await rowOf(hash);
      expect(row.consumed_at).not.toBeNull();
      expect(row.user_id).toBe(userId);
      expect(await consume(hash, 'login', randomUUID())).toBeNull();
      expect((await rowOf(hash)).user_id).toBe(userId);
    });

    test('DATA-AUTH-005 期限切れの控えは NULL で、行は未使用のまま', async () => {
      const hash = sha256(`consume-expired-${randomUUID()}`);
      await db().query(
        `insert into ${TABLE} (token_hash, return_path, purpose, created_at, expires_at)
         values ($1, '/account', 'login', now() - interval '2 hours', now() - interval '1 hour')`,
        [hash],
      );
      expect(await consume(hash, 'login', randomUUID())).toBeNull();
      expect((await rowOf(hash)).consumed_at).toBeNull();
    });

    test.each([
      ['signup', 'login'],
      ['login', 'signup'],
    ])('DATA-AUTH-005 %s の控えを %s の用途で使うと NULL で、行は未使用のまま', async (created, used) => {
      const hash = sha256(`consume-purpose-${created}-${randomUUID()}`);
      await create(hash, '/account', created);
      expect(await consume(hash, used, randomUUID())).toBeNull();
      expect((await rowOf(hash)).consumed_at).toBeNull();
      // 正しい用途ではまだ使える
      expect(await consume(hash, created, randomUUID())).toBe('/account');
    });

    test('DATA-AUTH-005 存在しないハッシュは NULL', async () => {
      expect(await consume(sha256(`consume-missing-${randomUUID()}`), 'login', randomUUID())).toBeNull();
    });

    test('DATA-AUTH-005 引数のどれかが NULL なら NULL（STRICT）で、行は未使用のまま', async () => {
      const hash = sha256(`consume-strict-${randomUUID()}`);
      await create(hash, '/account', 'login');
      expect(await consume(hash, 'login', null)).toBeNull();
      expect((await rowOf(hash)).consumed_at).toBeNull();
      const noHash = await db().query('select public.consume_auth_return_intent(null, $1, $2::uuid) as path', ['login', randomUUID()]);
      expect(noHash.rows[0].path).toBeNull();
      const noPurpose = await db().query('select public.consume_auth_return_intent($1, null, $2::uuid) as path', [hash, randomUUID()]);
      expect(noPurpose.rows[0].path).toBeNull();
      expect((await rowOf(hash)).consumed_at).toBeNull();
    });
  });

  describe('CHECK', () => {
    const goodHash = () => sha256(`check-${randomUUID()}`);

    test.each([
      ['//evil（先頭が二重の /）', '//evil.example'],
      ['/\\evil（バックスラッシュ）', '/\\evil.example'],
      ['空白入り', '/a b'],
      ['タブ入り', '/a\tb'],
      ['改行入り', '/a\nb'],
      ['/ で始まらない', 'evil'],
      ['513 文字', `/${'a'.repeat(512)}`],
      ['空', ''],
    ])('DATA-AUTH-005 戻り先が %s だと 23514（return_path の CHECK）', async (_name, returnPath) => {
      expect(await failure(`insert into ${TABLE} (token_hash, return_path, purpose, expires_at)
        values ($1, $2, 'login', now() + interval '15 minutes')`, [goodHash(), returnPath])).toMatchObject({
        code: '23514',
        constraint: 'auth_return_intents_return_path_check',
      });
    });

    test('DATA-AUTH-005 512 文字ちょうどの戻り先は入る', async () => {
      await insertRaw(goodHash(), `/${'a'.repeat(511)}`);
    });

    test.each([
      ['16 進でない', 'z'.repeat(64)],
      ['63 桁', 'a'.repeat(63)],
      ['65 桁', 'a'.repeat(65)],
      ['大文字の 16 進', 'A'.repeat(64)],
    ])('DATA-AUTH-005 token_hash が %s だと 23514', async (_name, hash) => {
      expect(await failure(`insert into ${TABLE} (token_hash, return_path, purpose, expires_at)
        values ($1, '/account', 'login', now() + interval '15 minutes')`, [hash])).toMatchObject({
        code: '23514',
        constraint: 'auth_return_intents_token_hash_check',
      });
    });

    test('DATA-AUTH-005 不正な purpose は 23514', async () => {
      expect(await failure(`insert into ${TABLE} (token_hash, return_path, purpose, expires_at)
        values ($1, '/account', 'admin', now() + interval '15 minutes')`, [goodHash()])).toMatchObject({
        code: '23514',
        constraint: 'auth_return_intents_purpose_check',
      });
    });

    test('DATA-AUTH-005 同じ token_hash の 2 回目は 23505', async () => {
      const hash = goodHash();
      await insertRaw(hash, '/account');
      expect(await failure(`insert into ${TABLE} (token_hash, return_path, purpose, expires_at)
        values ($1, '/cart', 'login', now() + interval '15 minutes')`, [hash])).toMatchObject({ code: '23505' });
    });

    test('DATA-AUTH-005 consumed_at だけ入って user_id が NULL は 23514', async () => {
      expect(await failure(`insert into ${TABLE} (token_hash, return_path, purpose, expires_at, consumed_at)
        values ($1, '/account', 'login', now() + interval '15 minutes', now())`, [goodHash()])).toMatchObject({
        code: '23514',
        constraint: 'auth_return_intents_consumed_check',
      });
    });

    test('DATA-AUTH-005 user_id だけ入って consumed_at が NULL も 23514', async () => {
      expect(await failure(`insert into ${TABLE} (token_hash, return_path, purpose, expires_at, user_id)
        values ($1, '/account', 'login', now() + interval '15 minutes', gen_random_uuid())`, [goodHash()])).toMatchObject({
        code: '23514',
        constraint: 'auth_return_intents_consumed_check',
      });
    });

    test('DATA-AUTH-005 期限が作成より前（expires_at <= created_at）は 23514', async () => {
      expect(await failure(`insert into ${TABLE} (token_hash, return_path, purpose, created_at, expires_at)
        values ($1, '/account', 'login', now(), now() - interval '1 minute')`, [goodHash()])).toMatchObject({
        code: '23514',
        constraint: 'auth_return_intents_expires_check',
      });
    });
  });

  describe('掃除', () => {
    test('DATA-AUTH-005 cron に auth-return-intents-cleanup が毎日 03:20 で登録されている', async () => {
      const job = await db().query("select schedule, active, command from cron.job where jobname = 'auth-return-intents-cleanup'");
      expect(job.rows).toHaveLength(1);
      expect(job.rows[0].schedule).toBe('20 3 * * *');
      expect(job.rows[0].active).toBe(true);
      expect(job.rows[0].command).toContain('private.auth_return_intents');
    });

    test('DATA-AUTH-005 期限の 1 日後を過ぎた行だけを消し、新しい行・期限直後の行は残す', async () => {
      const job = await db().query("select command from cron.job where jobname = 'auth-return-intents-cleanup'");
      const old = sha256(`cleanup-old-${randomUUID()}`);
      const justExpired = sha256(`cleanup-just-expired-${randomUUID()}`);
      const fresh = sha256(`cleanup-fresh-${randomUUID()}`);
      await db().query(
        `insert into ${TABLE} (token_hash, return_path, purpose, created_at, expires_at)
         values ($1, '/account', 'login', now() - interval '4 days', now() - interval '2 days'),
                ($2, '/account', 'login', now() - interval '5 hours', now() - interval '4 hours')`,
        [old, justExpired],
      );
      await create(fresh, '/account', 'login');

      await db().query(job.rows[0].command);

      expect(await rowOf(old)).toBeUndefined();
      expect(await rowOf(justExpired)).toBeDefined();
      expect(await rowOf(fresh)).toBeDefined();
    });
  });

  describe('移行の最後の確かめ（$auth_return_intents_final$）', () => {
    const ASSERT = sectionOf(MIGRATION_SQL, '-- AUTH_RETURN_INTENT_ASSERT_BEGIN', '-- AUTH_RETURN_INTENT_ASSERT_END');
    const failed = (detail: string) => ({ code: '55000', message: 'AUTH_RETURN_INTENT_ASSERTION_FAILED', detail });

    async function run(): Promise<{ code?: string; message?: string; detail?: string } | null> {
      await db().query('savepoint assert_section');
      try {
        await db().query(ASSERT);
        return null;
      } catch (error) {
        const e = error as { code: string; message: string; detail: string };
        return { code: e.code, message: e.message, detail: e.detail };
      } finally {
        await db().query('rollback to savepoint assert_section');
        await db().query('release savepoint assert_section');
      }
    }

    async function runAfter(change: string) {
      await db().query('savepoint tamper');
      try {
        await db().query(change);
        return await run();
      } finally {
        await db().query('rollback to savepoint tamper');
        await db().query('release savepoint tamper');
      }
    }

    test('DATA-AUTH-005 今の DB で末尾の確かめが通る', async () => {
      expect(ASSERT).not.toBe('');
      expect(await run()).toBeNull();
    });

    test.each([
      ['create に anon の EXECUTE を付ける', `grant execute on function ${CREATE} to anon`, 'auth_return_intents_functions'],
      ['consume に authenticated の EXECUTE を付ける', `grant execute on function ${CONSUME} to authenticated`, 'auth_return_intents_functions'],
      ['consume に PUBLIC の EXECUTE を付ける', `grant execute on function ${CONSUME} to public`, 'auth_return_intents_functions'],
      ['create から service_role の EXECUTE を外す', `revoke execute on function ${CREATE} from service_role`, 'auth_return_intents_functions'],
      ['consume を INVOKER にする', `alter function ${CONSUME} security invoker`, 'auth_return_intents_functions'],
      ['create の search_path を変える', `alter function ${CREATE} set search_path = public`, 'auth_return_intents_functions'],
      ['consume を STRICT でなくす', `alter function ${CONSUME} called on null input`, 'auth_return_intents_functions'],
      ['create の別のオーバーロードを足す', 'create function public.create_auth_return_intent(text) returns void language sql as $$ select 1 $$', 'auth_return_intents_functions'],
      ['consume を落とす', `drop function ${CONSUME}`, 'auth_return_intents_functions'],
      ['表の RLS を無効にする', `alter table ${TABLE} disable row level security`, 'auth_return_intents_table'],
      ['表に anon の SELECT を付ける', `grant select on ${TABLE} to anon`, 'auth_return_intents_table'],
      ['表に service_role の INSERT を付ける', `grant insert on ${TABLE} to service_role`, 'auth_return_intents_table'],
      ['表に PUBLIC の SELECT を付ける', `grant select on ${TABLE} to public`, 'auth_return_intents_table'],
      ['表に平文の番号の列を足す', `alter table ${TABLE} add column token text`, 'auth_return_intents_table'],
      ['掃除のジョブを消す', "select cron.unschedule('auth-return-intents-cleanup')", 'auth_return_intents_cleanup_job'],
      [
        '掃除のジョブの時刻を変える',
        "select cron.schedule('auth-return-intents-cleanup', '0 0 * * *', $$ delete from private.auth_return_intents $$)",
        'auth_return_intents_cleanup_job',
      ],
    ])('DATA-AUTH-005 %s と AUTH_RETURN_INTENT_ASSERTION_FAILED / 55000 で止まり DETAIL は項目名（%#）', async (_name, change, detail) => {
      expect(await runAfter(change)).toEqual(failed(detail));
    });
  });
});

describeLocalDb('DATA-AUTH-005 戻り先の控えの並行（実コミット）', (db) => {
  let other: PgClient;

  beforeAll(async () => {
    other = await connectLocalDb();
  });
  afterEach(async () => {
    await other.query(`delete from ${TABLE} where token_hash like $1`, [`${COMMITTED_PREFIX}%`]);
  });
  afterAll(async () => {
    // describeLocalDb 自身の afterAll が db() を閉じる。ここで開いた接続だけを閉じる。
    if (other) await other.end();
  });

  test('DATA-AUTH-005 同じ番号を 2 つの接続から同時に使い切ると、1 つが return_path を受け取り、もう 1 つは NULL', async () => {
    const hash = committedHash();
    await db().query('select public.create_auth_return_intent($1, $2, $3)', [hash, '/wishlist', 'login']);

    const results = await Promise.all(
      [db(), other].map(async (client) => {
        const result = await client.query('select public.consume_auth_return_intent($1, $2, $3::uuid) as path', [
          hash,
          'login',
          randomUUID(),
        ]);
        return result.rows[0].path as string | null;
      }),
    );

    expect(results.filter((value) => value === '/wishlist')).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
    const row = await db().query(`select consumed_at, user_id from ${TABLE} where token_hash = $1`, [hash]);
    expect(row.rows[0].consumed_at).not.toBeNull();
    expect(row.rows[0].user_id).not.toBeNull();
  });
});

// 任意（鍵が要る）: 本物の supabase-js -> PostgREST の道。service_role は呼べて、anon は呼べない（authenticated は鍵だけでは作れないので見ない。権限は ACL の試験が見る）。
const apiUrl = process.env.LOCAL_SUPABASE_URL;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;

if (apiUrl && serviceKey && anonKey && isLocalDatabase(apiUrl)) {
  describeLocalDb('DATA-AUTH-005 戻り先の控えの PostgREST の道（実コミット）', () => {
    const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
    const service = createClient(apiUrl, serviceKey, options);
    const anon = createClient(apiUrl, anonKey, options);
    let cleanup: PgClient;

    beforeAll(async () => {
      cleanup = await connectLocalDb();
    });
    afterEach(async () => {
      await cleanup.query(`delete from ${TABLE} where token_hash like $1`, [`${COMMITTED_PREFIX}%`]);
    });
    afterAll(async () => {
      if (cleanup) await cleanup.end();
    });

    test('DATA-AUTH-005 service_role は rpc で作って使い切れる（2 回目は null）', async () => {
      const hash = committedHash();
      const created = await service.rpc('create_auth_return_intent', { _token_hash: hash, _return_path: '/cart', _purpose: 'login' });
      expect(created.error).toBeNull();
      expect(created.data).toBe(900);
      const used = await service.rpc('consume_auth_return_intent', { _token_hash: hash, _purpose: 'login', _user_id: randomUUID() });
      expect(used.error).toBeNull();
      expect(used.data).toBe('/cart');
      const again = await service.rpc('consume_auth_return_intent', { _token_hash: hash, _purpose: 'login', _user_id: randomUUID() });
      expect(again.error).toBeNull();
      expect(again.data).toBeNull();
    });

    test('DATA-AUTH-005 anon は rpc で作れず・使い切れない（権限の不足）', async () => {
      const hash = committedHash();
      const created = await anon.rpc('create_auth_return_intent', { _token_hash: hash, _return_path: '/cart', _purpose: 'login' });
      expect(created.error).not.toBeNull();
      expect([401, 403, 404]).toContain(created.status);
      expect(created.data).toBeNull();
      const used = await anon.rpc('consume_auth_return_intent', { _token_hash: hash, _purpose: 'login', _user_id: randomUUID() });
      expect(used.error).not.toBeNull();
      expect([401, 403, 404]).toContain(used.status);
      const rows = await cleanup.query(`select 1 from ${TABLE} where token_hash = $1`, [hash]);
      expect(rows.rowCount).toBe(0);
    });
  });
}
