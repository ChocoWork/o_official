/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * FREQ-540-AC-09: 認証・会計の公開関数11本は anon / authenticated が EXECUTE できず、service_role と postgres は保つ。
 * ベースの移行は PUBLIC を外して postgres + service_role に付けただけで、Supabase の既定権限が付けた anon / authenticated の
 * 直接の EXECUTE が残り、移行から作った DB では anon が他の利用者のセッションを消せた。G-2 の最初の移行が外す。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻す。
 */
const FUNCTIONS = [
  'public.cleanup_password_reset_tokens(integer)',
  'public.clear_admin_expense_cost_allocations(bigint)',
  'public.create_profile_for_new_auth_user()',
  'public.find_auth_user_id_by_email(text)',
  'public.increment_rate_limit_counter(inet,text,timestamp with time zone,integer)',
  'public.increment_rate_limit_counter(inet,text,timestamp with time zone)',
  'public.is_auth_session_active(uuid)',
  'public.record_admin_finance_entry_revision()',
  'public.replace_admin_expense_cost_allocations(bigint,jsonb,uuid)',
  'public.revoke_auth_session(uuid)',
  'public.revoke_auth_sessions_for_user(uuid)',
];

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const FOUNDATION_FILE = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g2_purchasing_foundation.sql'));
const FOUNDATION_SQL = fs.readFileSync(path.join(MIGRATION_DIRECTORY, FOUNDATION_FILE[0]), 'utf8');

/** 移行の最後の確かめ（G2A_FINAL_ASSERT の DO 文）を取り出す */
function finalAssertBlock(tag: string): string {
  const section = FOUNDATION_SQL.slice(FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_BEGIN'), FOUNDATION_SQL.indexOf('-- G2A_FINAL_ASSERT_END'));
  const start = section.indexOf(`DO ${tag}`);
  const end = section.indexOf(`${tag};`, start + tag.length + 3);
  if (start < 0 || end < 0) throw new Error(`missing ${tag}`);
  return section.slice(start, end + tag.length + 1);
}

describe('G-2 foundation migration の形（DB なし）', () => {
  test('FREQ-540-AC-09: 11本の REVOKE を1文で書き、11本への GRANT と private schema の USAGE の変更は書かない', () => {
    expect(FOUNDATION_FILE).toHaveLength(1);
    // コメントを除いた SQL の文だけを見る
    const code = FOUNDATION_SQL.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    const revokes = (code.match(/REVOKE EXECUTE ON FUNCTION[\s\S]*?;/g) ?? []).filter((statement) => statement.includes('cleanup_password_reset_tokens'));
    expect(revokes).toHaveLength(1);
    const names = [...revokes[0].matchAll(/public\.[a-z_]+\([^)]*\)/g)].map((m) => m[0].replace(/\s+/g, ''));
    expect(names.sort()).toEqual(FUNCTIONS.map((sig) => sig.replace(/timestamp with time zone/g, 'timestampwithtimezone')).sort());
    expect(revokes[0]).toMatch(/FROM PUBLIC, anon, authenticated;$/);
    const grants = code.match(/\bGRANT\b[\s\S]*?;/gi) ?? [];
    for (const statement of grants) {
      for (const signature of FUNCTIONS) expect(statement).not.toContain(signature.split('(')[0].replace('public.', ''));
    }
    expect(code).not.toMatch(/ON SCHEMA\s+private/i);
  });

  test('FREQ-540-AC-09: 最後の確かめは有効な ACL（NULL の proacl は既定の ACL）で PUBLIC を見る', () => {
    const block = finalAssertBlock('$g2a_final_public_function_acl$');
    expect(block).toContain("RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'public_function_acl'");
    expect(block).toContain("COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))");
    expect(block).toContain('aclexplode');
  });
});

describeLocalDb('G-2 Task 1: public function EXECUTE for anon / authenticated', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  const oidOf = async (signature: string) =>
    (await db().query('select p.oid::int as oid from pg_proc p where p.oid = to_regprocedure($1)', [signature])).rows[0]?.oid as number | undefined;

  test.each(FUNCTIONS)('FREQ-540-AC-09: reset 直後の DB で、%s は anon / authenticated が EXECUTE できず、proacl にも PUBLIC が無い', async (signature) => {
    const row = (await db().query(`select p.oid is not null as present,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute
      from (select to_regprocedure($1) as oid) f left join pg_proc p on p.oid = f.oid`, [signature])).rows[0];

    expect(row).toEqual({ present: true, anon: false, authenticated: false, public_can_execute: false });
  });

  test('FREQ-540-AC-09: increment_rate_limit_counter の2つの overload は別々の関数として両方が対象', async () => {
    const overloads = (await db().query(`select pg_get_function_identity_arguments(p.oid) as args from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = 'increment_rate_limit_counter' order by 1`)).rows;

    expect(overloads).toHaveLength(2);
    expect(new Set(await Promise.all(FUNCTIONS.filter((sig) => sig.includes('increment_rate_limit_counter')).map(oidOf))).size).toBe(2);
  });

  test.each(FUNCTIONS)('FREQ-540-AC-09: %s は service_role と postgres が EXECUTE を保つ', async (signature) => {
    const row = (await db().query(`select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role,
        has_function_privilege('postgres', $1::regprocedure, 'EXECUTE') as postgres`, [signature])).rows[0];

    expect(row).toEqual({ service_role: true, postgres: true });
  });

  describe('anon / authenticated の役で呼ぶ', () => {
    async function insertUser(): Promise<string> {
      return (await db().query(`insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
        values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [`g2-acl-${randomUUID()}@example.com`])).rows[0].id;
    }
    async function insertAuthSession(userId: string): Promise<string> {
      return (await db().query(`insert into auth.sessions (id, user_id, created_at, updated_at)
        values (gen_random_uuid(), $1, now(), now()) returning id::text as id`, [userId])).rows[0].id;
    }
    async function sessionIds(userId: string): Promise<string[]> {
      return (await db().query('select id::text as id from auth.sessions where user_id = $1 order by id', [userId])).rows.map((row: { id: string }) => row.id);
    }
    /** 指定した役のまま流して SQLSTATE を返す。savepoint まで戻すので、断られても取引は続けられる */
    async function failureAs(role: string, sql: string, params: unknown[]): Promise<string | undefined> {
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
        await db().query('release savepoint expected_failure');
      }
    }

    test.each(['anon', 'authenticated'])(
      'FREQ-540-AC-09: %s が revoke_auth_sessions_for_user / revoke_auth_session / is_auth_session_active / find_auth_user_id_by_email を呼ぶと SQLSTATE 42501 で、何も消えない',
      async (role) => {
        const userId = await insertUser();
        const sessionId = await insertAuthSession(userId);

        expect(await failureAs(role, 'select public.revoke_auth_sessions_for_user($1::uuid)', [userId])).toBe('42501');
        expect(await failureAs(role, 'select public.revoke_auth_session($1::uuid)', [sessionId])).toBe('42501');
        expect(await failureAs(role, 'select public.is_auth_session_active($1::uuid)', [sessionId])).toBe('42501');
        expect(await failureAs(role, 'select public.find_auth_user_id_by_email($1::text)', ['someone@example.com'])).toBe('42501');

        expect(await sessionIds(userId)).toEqual([sessionId]);
      },
    );

    test('FREQ-540-AC-09: service_role の役では is_auth_session_active と revoke_auth_session が引き続き動く', async () => {
      const userId = await insertUser();
      const sessionId = await insertAuthSession(userId);
      const keep = await insertAuthSession(userId);

      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query('set local role service_role');
      const active = (await db().query('select public.is_auth_session_active($1::uuid) as active', [sessionId])).rows[0].active;
      const deleted = (await db().query('select public.revoke_auth_session($1::uuid) as deleted', [sessionId])).rows[0].deleted;
      await db().query('reset role');

      expect(active).toBe(true);
      expect(deleted).toBe(1);
      expect(await sessionIds(userId)).toEqual([keep]);
    });
  });

  describe('移行の最後の確かめ', () => {
    const ASSERT = finalAssertBlock('$g2a_final_public_function_acl$');
    const FAILED = { code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail: 'public_function_acl' };

    async function runAssertion() {
      await db().query('savepoint acl_assert');
      try {
        await db().query(ASSERT);
        await db().query('release savepoint acl_assert');
        return null;
      } catch (error) {
        await db().query('rollback to savepoint acl_assert');
        const e = error as { code?: string; message?: string; detail?: string };
        return { code: e.code, message: e.message, detail: e.detail };
      }
    }

    test('FREQ-540-AC-09: 今の DB で通る', async () => {
      expect(await runAssertion()).toBeNull();
    });

    test.each([
      ['anon に EXECUTE を付ける', 'grant execute on function public.revoke_auth_session(uuid) to anon'],
      ['authenticated に EXECUTE を付ける', 'grant execute on function public.increment_rate_limit_counter(inet,text,timestamptz) to authenticated'],
      ['PUBLIC に EXECUTE を付ける', 'grant execute on function public.cleanup_password_reset_tokens(integer) to public'],
      ['service_role の EXECUTE を外す', 'revoke execute on function public.find_auth_user_id_by_email(text) from service_role'],
    ])('FREQ-540-AC-09: %s と止まる', async (_name, sql) => {
      await db().query(sql);
      expect(await runAssertion()).toEqual(FAILED);
    });

    test('FREQ-540-AC-09: 関数が無ければ止まる', async () => {
      await db().query('drop function public.cleanup_password_reset_tokens(integer)');
      expect(await runAssertion()).toEqual(FAILED);
    });

    test('FREQ-540-AC-09: proacl が NULL の関数の既定の ACL は PUBLIC の EXECUTE を含む（確かめの式が COALESCE で既定へ読み替える理由）', async () => {
      const row = (await db().query(`select exists (
          select 1 from aclexplode(coalesce(null::aclitem[], acldefault('f', 'postgres'::regrole::oid))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute`)).rows[0];

      expect(row).toEqual({ public_can_execute: true });
    });
  });
});
