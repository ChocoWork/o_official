/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * SECURITY DEFINER 関数の search_path と、has_permission の実行権限（FREQ-390）。
 *
 * PostgreSQL は search_path に pg_temp が書かれていないと、テーブル・ビュー・型の解決で
 * 一時スキーマを先に見る。SECURITY DEFINER は所有者権限で動くため、参照先が一時テーブルに
 * 置き換わると所有者権限で読み書きしてしまう。公式の勧めどおり pg_temp を最後に置く。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/security_definer_search_path
 */

const DATABASE_URL = process.env.DATABASE_URL;

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: SECURITY DEFINER の search_path', () => {
  if (!DATABASE_URL) {
    test.skip('DATABASE_URL 未設定のためスキップ', () => {});
    return;
  }

  if (!isLocalDatabase(DATABASE_URL)) {
    test('使い捨ての DB 以外では実行しない', () => {
      throw new Error('localhost 以外の DATABASE_URL では実行しない');
    });
    return;
  }

  let client: any;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  test('一時スキーマを先に見る SECURITY DEFINER 関数が残っていない', async () => {
    const res = await client.query(
      `select n.nspname || '.' || p.proname as name,
              array_to_string(p.proconfig, ',') as config
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef
          and n.nspname in ('public', 'private')
          and coalesce(array_to_string(p.proconfig, ','), '') not like '%pg_temp%'
          and coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=""'
        order by 1`,
    );

    expect(res.rows).toEqual([]);
  });

  test('anon は has_permission を実行できない', async () => {
    const res = await client.query(
      `select has_function_privilege('anon', 'public.has_permission(text)', 'EXECUTE') as allowed`,
    );

    expect(res.rows[0].allowed).toBe(false);
  });

  test('authenticated と service_role は has_permission を実行できる（RLS ポリシーが使う）', async () => {
    const res = await client.query(
      `select has_function_privilege('authenticated', 'public.has_permission(text)', 'EXECUTE') as authenticated,
              has_function_privilege('service_role', 'public.has_permission(text)', 'EXECUTE') as service_role`,
    );

    expect(res.rows[0]).toMatchObject({ authenticated: true, service_role: true });
  });

  test('public スキーマに API ロールは CREATE できない（一時スキーマ以外の入口を塞いでいる）', async () => {
    const res = await client.query(
      `select has_schema_privilege('anon', 'public', 'CREATE') as anon,
              has_schema_privilege('authenticated', 'public', 'CREATE') as authenticated,
              has_schema_privilege('service_role', 'public', 'CREATE') as service_role`,
    );

    expect(res.rows[0]).toMatchObject({ anon: false, authenticated: false, service_role: false });
  });
});
