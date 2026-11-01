/** @jest-environment node */
import { readMigration } from '../../helpers/staged-supabase';
import { describeLocalDb } from './helpers/local-db';

/**
 * 公開スキーマの権限の一覧と、新しい表に自動で付く広い権限への歯止め（DATA-AUTH-006）。
 * 移行の形（ALTER DEFAULT PRIVILEGES を使わない・ROLLBACK の節・service_role の明示）は DB なしで読み、
 * 権限の効き方（has_*_privilege）は手元の使い捨て DB でだけ流す。読むだけで、DB は書き換えない。
 * 一覧は SEC-AUTH-033 / ADR-0414 の決まり（移行が GRANT を明示する）を守るための定数で、権限を替える移行を足したら同じ変更でここも直す。
 */

const WAVE2_MIGRATIONS = [
  'stockists_type_optional',
  'sec_grants_hardening',
  'sec_grants_admin_tables',
  'sec_search_functions',
  'sec_rls_predicates_and_constraints',
  'sec_storage_buckets',
];

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER' | 'MAINTAIN';
const ALL_PRIVILEGES: Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const SERVICE_ROLE_PRIVILEGES: Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

type TableExpectation = {
  group: string;
  tables: string[];
  anon: Privilege[];
  authenticated: Privilege[];
};

/** 表の一覧。anon・authenticated は「ちょうどこの権限だけ」、service_role は SELECT・INSERT・UPDATE・DELETE を持つこと */
const TABLE_EXPECTATIONS: TableExpectation[] = [
  { group: '公開の読み', tables: ['looks', 'look_items', 'news_articles', 'stockists'], anon: ['SELECT'], authenticated: ['SELECT'] },
  { group: '管理の読み', tables: ['item_color_presets', 'item_cost_history'], anon: [], authenticated: ['SELECT'] },
  {
    group: '閉じた表',
    tables: ['sessions', 'password_reset_tokens', 'password_change_challenges', 'rate_limit_counters', 'audit_logs', 'audit_logs_backups'],
    anon: [],
    authenticated: [],
  },
  { group: '自分の行', tables: ['profiles'], anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
];
const TABLE_CASES = TABLE_EXPECTATIONS.flatMap((expectation) => expectation.tables.map((table) => [expectation.group, table, expectation] as const));

/** 公開で読める items の 21 列。原価の 2 列は含めない（ADR-0106） */
const PUBLIC_ITEM_COLUMNS = [
  'id',
  'name',
  'description',
  'price',
  'category',
  'image_url',
  'image_urls',
  'colors',
  'sizes',
  'product_details',
  'status',
  'created_at',
  'updated_at',
  'material',
  'origin',
  'sewing_region',
  'care',
  'season',
  'product_note',
  'made_to_order_lead_days',
  'return_ineligible',
];
const COST_COLUMNS = ['pattern_cost', 'mass_production_cost'];

type FunctionExpectation = { name: string; anon: boolean; authenticated: boolean; postgres?: boolean };
const FUNCTION_EXPECTATIONS: FunctionExpectation[] = [
  { name: 'search_items', anon: true, authenticated: true },
  { name: 'search_looks', anon: true, authenticated: true },
  { name: 'search_news', anon: true, authenticated: true },
  { name: 'search_public_items', anon: false, authenticated: false, postgres: true },
  { name: 'search_public_looks', anon: false, authenticated: false, postgres: true },
  { name: 'search_public_news', anon: false, authenticated: false, postgres: true },
  { name: 'admin_update_look', anon: false, authenticated: false },
  { name: 'is_app_session_active', anon: false, authenticated: false, postgres: true },
  { name: 'issue_password_change_challenge', anon: false, authenticated: false, postgres: true },
  { name: 'consume_password_change_challenge', anon: false, authenticated: false, postgres: true },
];

const SEQUENCES = ['stockists_id_seq', 'rate_limit_counters_id_seq'];
const BUCKETS = ['look-images', 'news-images'];

/**
 * 既知の例外。他の領域・他の波の持ち物で、ここでは直さず「持っているかもしれない」上限として載せる。
 * 締まった表は落ちない（console.info に出る）。一覧にも例外にも無い表に広い権限が付いたら歯止めが落ちる。
 * G の表（注文・発送・在庫・発注）は各移行が明示の GRANT を持つ前提なので、ここには載せない。
 */
const KNOWN_EXCEPTION_PREFIXES = ['admin_finance_', 'admin_kpi_'];
const KNOWN_EXCEPTION_TABLES = [
  'admin_costing_items',
  'admin_expense_cost_allocations',
  'contact_inquiries',
  'contact_messages',
  'contact_reply_templates',
  'carts',
  'checkout_drafts',
  'orders',
  'order_items',
  'wishlist',
  'permissions',
  'roles',
  'role_permissions',
  'user_roles',
  'postal_code_cache',
  'refresh_token_history',
  'stripe_webhook_events',
];
/** 意図して書ける表（役ごと）。authenticated の profiles は本人の行を /api/profile が利用者の JWT で書く */
const INTENDED_WRITABLE: Record<string, string[]> = { authenticated: ['profiles'] };

const isKnownException = (table: string) =>
  KNOWN_EXCEPTION_TABLES.includes(table) || KNOWN_EXCEPTION_PREFIXES.some((prefix) => table.startsWith(prefix));

/** SQL からコメント行を除く（コメントの中の語を数えない） */
const codeOf = (sql: string) =>
  sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

describe('DATA-AUTH-006 波 2 の移行の形（DB なし）', () => {
  test.each(WAVE2_MIGRATIONS)('DATA-AUTH-006 移行 %s は ALTER DEFAULT PRIVILEGES を使わない（Q9 は今回やらない）', (suffix) => {
    expect(codeOf(readMigration(suffix))).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  test.each(WAVE2_MIGRATIONS)('DATA-AUTH-006 移行 %s は BEGIN の前のヘッダーに ROLLBACK の節を持つ', (suffix) => {
    const sql = readMigration(suffix);
    const rollback = sql.search(/^-- ROLLBACK/m);
    const begin = sql.search(/^BEGIN;/m);
    expect(rollback).toBeGreaterThanOrEqual(0);
    expect(begin).toBeGreaterThan(rollback);
  });

  test.each(['sec_grants_hardening', 'sec_grants_admin_tables'])(
    'DATA-AUTH-006 移行 %s は service_role の GRANT を明示する（表・連番とも）',
    (suffix) => {
      const code = codeOf(readMigration(suffix));
      expect(code).toMatch(/GRANT\s+ALL\s+ON\s+TABLE[^;]*TO\s+service_role\s*;/i);
      expect(code).toMatch(/GRANT\s+USAGE,\s*SELECT\s+ON\s+SEQUENCE[^;]*TO\s+service_role\s*;/i);
    },
  );

  test('DATA-AUTH-006 一覧の定数は、移行の GRANT SELECT と同じ組を持つ（公開の読みは anon・authenticated、管理の読みは authenticated だけ）', () => {
    const code = codeOf(readMigration('sec_grants_admin_tables'));
    expect(code).toMatch(/GRANT SELECT ON TABLE public\.looks, public\.look_items, public\.news_articles, public\.stockists TO anon, authenticated;/);
    expect(code).toMatch(/GRANT SELECT ON TABLE public\.item_color_presets TO authenticated;/);
  });
});

describeLocalDb('DATA-AUTH-006 公開スキーマの権限の一覧と歯止め', (db) => {
  const hasTable = async (role: string, table: string, privilege: Privilege): Promise<boolean> =>
    (await db().query('select has_table_privilege($1::name, $2::regclass, $3::text) as allowed', [role, `public.${table}`, privilege])).rows[0].allowed;

  const grantedOn = async (role: string, table: string): Promise<Privilege[]> => {
    const granted: Privilege[] = [];
    for (const privilege of ALL_PRIVILEGES) {
      if (await hasTable(role, table, privilege)) granted.push(privilege);
    }
    return granted;
  };

  const hasAnyColumn = async (role: string, table: string, privilege: 'INSERT' | 'UPDATE' | 'REFERENCES'): Promise<boolean> =>
    (await db().query('select has_any_column_privilege($1::name, $2::regclass, $3::text) as allowed', [role, `public.${table}`, privilege])).rows[0].allowed;

  describe('表', () => {
    test.each(TABLE_CASES)('DATA-AUTH-006 [%s] %s は anon・authenticated に一覧どおりの権限だけを持つ', async (_group, table, expectation) => {
      expect({ role: 'anon', granted: await grantedOn('anon', table) }).toEqual({ role: 'anon', granted: expectation.anon });
      expect({ role: 'authenticated', granted: await grantedOn('authenticated', table) }).toEqual({
        role: 'authenticated',
        granted: expectation.authenticated,
      });
    });

    test.each(TABLE_CASES)('DATA-AUTH-006 [%s] %s は列単位の INSERT・UPDATE・REFERENCES も、一覧に無い役へ付いていない', async (_group, table, expectation) => {
      for (const [role, allowed] of [
        ['anon', expectation.anon],
        ['authenticated', expectation.authenticated],
      ] as const) {
        for (const privilege of ['INSERT', 'UPDATE', 'REFERENCES'] as const) {
          expect({ role, privilege, held: await hasAnyColumn(role, table, privilege) }).toEqual({
            role,
            privilege,
            held: allowed.includes(privilege),
          });
        }
      }
    });

    test.each(TABLE_CASES)('DATA-AUTH-006 [%s] %s は service_role が SELECT・INSERT・UPDATE・DELETE を明示で持つ', async (_group, table) => {
      for (const privilege of SERVICE_ROLE_PRIVILEGES) {
        expect({ table, privilege, held: await hasTable('service_role', table, privilege) }).toEqual({ table, privilege, held: true });
      }
    });
  });

  describe('items（列単位）', () => {
    test.each(['anon', 'authenticated'])('DATA-AUTH-006 items は %s に表単位の権限が無い（列単位の SELECT だけ）', async (role) => {
      expect(await grantedOn(role, 'items')).toEqual([]);
      for (const privilege of ['INSERT', 'UPDATE', 'REFERENCES'] as const) {
        expect(await hasAnyColumn(role, 'items', privilege)).toBe(false);
      }
    });

    test.each(['anon', 'authenticated'])('DATA-AUTH-006 items は %s が公開の 21 列を読め、原価の 2 列を読めない', async (role) => {
      const rows = (
        await db().query(
          `select column_name, has_column_privilege($1::name, 'public.items', column_name::text, 'SELECT') as allowed
           from information_schema.columns where table_schema = 'public' and table_name = 'items'`,
          [role],
        )
      ).rows as Array<{ column_name: string; allowed: boolean }>;
      const byName = new Map(rows.map((row) => [row.column_name, row.allowed]));
      for (const column of PUBLIC_ITEM_COLUMNS) expect({ column, allowed: byName.get(column) }).toEqual({ column, allowed: true });
      for (const column of COST_COLUMNS) expect({ column, allowed: byName.get(column) }).toEqual({ column, allowed: false });
    });

    test.each(['anon', 'authenticated'])(
      'DATA-AUTH-006 items の「全列 − 原価 2 列」は %s が SELECT できる列と一致する（新しい列を足したらここで落ち、権限の判断を迫る）',
      async (role) => {
        const rows = (
          await db().query(
            `select column_name, has_column_privilege($1::name, 'public.items', column_name::text, 'SELECT') as allowed
             from information_schema.columns where table_schema = 'public' and table_name = 'items' order by column_name`,
            [role],
          )
        ).rows as Array<{ column_name: string; allowed: boolean }>;
        const readable = rows.filter((row) => row.allowed).map((row) => row.column_name);
        const expected = rows.map((row) => row.column_name).filter((name) => !COST_COLUMNS.includes(name));
        expect(readable).toEqual(expected);
      },
    );

    test('DATA-AUTH-006 items は service_role が SELECT・INSERT・UPDATE・DELETE を表単位で持つ', async () => {
      for (const privilege of SERVICE_ROLE_PRIVILEGES) {
        expect(await hasTable('service_role', 'items', privilege)).toBe(true);
      }
    });
  });

  describe('関数', () => {
    test.each(FUNCTION_EXPECTATIONS)('DATA-AUTH-006 関数 $name は anon=$anon・authenticated=$authenticated・service_role=可で、PUBLIC には許さない', async (expectation) => {
      const rows = (
        await db().query(
          `select p.oid::regprocedure::text as signature,
                  has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
                  has_function_privilege('postgres', p.oid, 'EXECUTE') as postgres,
                  exists (
                    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'
                  ) as public_execute
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = $1
           order by 1`,
          [expectation.name],
        )
      ).rows as Array<{ signature: string; anon: boolean; authenticated: boolean; service_role: boolean; postgres: boolean; public_execute: boolean }>;

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect({ signature: row.signature, anon: row.anon, authenticated: row.authenticated, service_role: row.service_role, public_execute: row.public_execute }).toEqual({
          signature: row.signature,
          anon: expectation.anon,
          authenticated: expectation.authenticated,
          service_role: true,
          public_execute: false,
        });
        if (expectation.postgres) expect({ signature: row.signature, postgres: row.postgres }).toEqual({ signature: row.signature, postgres: true });
      }
    });
  });

  describe('連番', () => {
    test.each(SEQUENCES)('DATA-AUTH-006 連番 %s は anon・authenticated に権限が無く、service_role は USAGE・SELECT を持つ', async (sequence) => {
      const held = async (role: string, privilege: string): Promise<boolean> =>
        (await db().query('select has_sequence_privilege($1::name, $2::regclass, $3::text) as allowed', [role, `public.${sequence}`, privilege])).rows[0].allowed;

      for (const role of ['anon', 'authenticated']) {
        for (const privilege of ['USAGE', 'SELECT', 'UPDATE']) {
          expect({ role, privilege, held: await held(role, privilege) }).toEqual({ role, privilege, held: false });
        }
      }
      expect(await held('service_role', 'USAGE')).toBe(true);
      expect(await held('service_role', 'SELECT')).toBe(true);
    });
  });

  describe('台帳・保管の表', () => {
    const LEDGER_TABLES = ['legal_archive_runs', 'order_revisions', 'stripe_balance_transactions', 'stripe_payouts', 'stripe_refunds'];

    test.each(LEDGER_TABLES)('DATA-AUTH-006 台帳の表 %s は anon・authenticated に書き込み系の 7 権限が無い（表・列とも）', async (table) => {
      for (const role of ['anon', 'authenticated']) {
        for (const privilege of ALL_PRIVILEGES.filter((candidate) => candidate !== 'SELECT')) {
          expect({ role, table, privilege, held: await hasTable(role, table, privilege) }).toEqual({ role, table, privilege, held: false });
        }
        for (const privilege of ['INSERT', 'UPDATE', 'REFERENCES'] as const) {
          expect({ role, table, privilege, held: await hasAnyColumn(role, table, privilege) }).toEqual({ role, table, privilege, held: false });
        }
      }
    });

    test('DATA-AUTH-006 台帳の表が持つ連番（order_revisions_id_seq）は anon・authenticated に権限が無い', async () => {
      const sequences = (
        await db().query(
          `select s.oid::regclass::text as name
           from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
           where d.classid = 'pg_class'::regclass and d.deptype in ('a', 'i')
             and d.refobjid = any (select ('public.' || t)::regclass::oid from unnest($1::text[]) as t)
           order by 1`,
          [LEDGER_TABLES],
        )
      ).rows.map((row) => row.name as string);
      expect(sequences).toContain('order_revisions_id_seq');
      for (const sequence of sequences) {
        for (const role of ['anon', 'authenticated']) {
          for (const privilege of ['USAGE', 'SELECT', 'UPDATE']) {
            const allowed = (await db().query('select has_sequence_privilege($1::name, $2::regclass, $3::text) as allowed', [role, `public.${sequence}`, privilege])).rows[0].allowed;
            expect({ sequence, role, privilege, allowed }).toEqual({ sequence, role, privilege, allowed: false });
          }
        }
      }
    });

    test('DATA-AUTH-006 /api/admin/legal-archive/status が利用者の JWT で読む legal_archive_runs は、authenticated の SELECT が残っている', async () => {
      expect(await hasTable('authenticated', 'legal_archive_runs', 'SELECT')).toBe(true);
    });
  });

  describe('置き場', () => {
    test.each(BUCKETS)('DATA-AUTH-006 置き場 %s は public = false', async (bucket) => {
      const result = await db().query('select public from storage.buckets where id = $1', [bucket]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].public).toBe(false);
    });
  });

  describe('歯止め（新しい表に自動で付く広い権限）', () => {
    /** anon・authenticated が書き込み・TRUNCATE を（表単位か列単位で）持つ public の通常の表を、役ごとに返す */
    async function writableTables(role: 'anon' | 'authenticated'): Promise<string[]> {
      const result = await db().query(
        `select c.relname as table_name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p')
           and (
             has_table_privilege($1::name, c.oid, 'INSERT') or has_table_privilege($1::name, c.oid, 'UPDATE')
             or has_table_privilege($1::name, c.oid, 'DELETE') or has_table_privilege($1::name, c.oid, 'TRUNCATE')
             or has_any_column_privilege($1::name, c.oid, 'INSERT') or has_any_column_privilege($1::name, c.oid, 'UPDATE')
           )
         order by c.relname`,
        [role],
      );
      return result.rows.map((row) => row.table_name as string);
    }

    test.each(['anon', 'authenticated'] as const)(
      'DATA-AUTH-006 %s が書き込み・TRUNCATE を持つ表は、既知の例外と意図して書ける表だけ（残りがあれば表の名前を出して落ちる）',
      async (role) => {
        const writable = await writableTables(role);
        const unexpected = writable.filter((table) => !isKnownException(table) && !(INTENDED_WRITABLE[role] ?? []).includes(table));
        expect({ role, unexpected }).toEqual({ role, unexpected: [] });
      },
    );

    test('DATA-AUTH-006 既知の例外のうち、今は広い権限を持たない表の一覧（締まった表を例外から外す目安。落ちない）', async () => {
      const anonWritable = await writableTables('anon');
      const authenticatedWritable = await writableTables('authenticated');
      const existing = (
        await db().query(
          `select c.relname as table_name from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.relname`,
        )
      ).rows.map((row) => row.table_name as string);
      const exceptions = existing.filter(isKnownException);
      const narrowed = exceptions.filter((table) => !anonWritable.includes(table) && !authenticatedWritable.includes(table));
      // eslint-disable-next-line no-console
      console.info(`DATA-AUTH-006 既知の例外のうち広い権限を持たない表 (${narrowed.length}/${exceptions.length}): ${narrowed.join(', ') || '(なし)'}`);
      expect(narrowed.length).toBeLessThanOrEqual(exceptions.length);
    });

    test.todo('DATA-AUTH-006 anon の TRUNCATE を既知の例外の表からも外す（他領域の波で直す）');
  });
});
