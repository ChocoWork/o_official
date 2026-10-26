/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readMigration } from '../../../helpers/staged-supabase';
import { describeLocalDb } from '../helpers/local-db';

/**
 * items の列単位の SELECT、item_cost_history の管理者の読みの方針、認証の 5 表・連番・profiles の権限（DATA-HOME-001）。
 * 移行 sec_grants_hardening（Task 4）の形は DB なしで読み、権限の効き方は手元の使い捨て DB でだけ流す。
 * DB の試験は 1 つを 1 つの取引にして最後に巻き戻すので、足した利用者・行は残らない。
 */

/** 公開のまま読める 21 列。原価の 2 列は含めない（ADR-0106） */
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
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const ALL_PRIVILEGES = ['SELECT', ...WRITE_PRIVILEGES];
const AUTH_TABLES = ['sessions', 'password_reset_tokens', 'rate_limit_counters', 'audit_logs', 'audit_logs_backups'];
const SERVICE_TABLES = ['items', 'item_cost_history', 'profiles', ...AUTH_TABLES];

describe('integration: items の列権限の移行の形（DB なし）', () => {
  let sql: string;
  beforeAll(() => {
    sql = readMigration('sec_grants_hardening');
  });

  test('DATA-HOME-001 公開側の items の読み（一覧・詳細・カート・在庫）が選ぶ列は、どれも公開の 21 列に入り、原価の 2 列を選ぶ所が無い', () => {
    const sources: Array<[string, RegExp]> = [
      ['src/lib/items/public.ts', /const ITEM_SELECT_COLUMNS =\s*'([^']+)'/],
      ['src/app/api/items/[id]/route.ts', /\.from\('items'\)\s*\.select\('([^']+)'/],
      ['src/features/checkout/services/checkout-cart.service.ts', /\.from\('items'\)\s*\.select\('([^']+)'/],
      ['src/features/cart/services/cart-view.ts', /items\(([^)]+)\)/],
    ];
    const problems: string[] = [];
    for (const [file, pattern] of sources) {
      const text = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      const match = text.match(pattern);
      if (!match) {
        problems.push(`${file}: 選ぶ列を読めない`);
        continue;
      }
      for (const column of match[1].split(',').map((entry) => entry.trim())) {
        if (!PUBLIC_ITEM_COLUMNS.includes(column)) problems.push(`${file}: ${column}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('DATA-HOME-001 移行の GRANT SELECT の列の一覧は、公開の 21 列と一致し、原価の 2 列を含まない', () => {
    const match = sql.match(/^GRANT SELECT \(([^)]*)\)\s+ON TABLE public\.items TO anon, authenticated;/m);
    expect(match).not.toBeNull();
    const columns = match![1].split(',').map((column) => column.trim());

    expect([...columns].sort()).toEqual([...PUBLIC_ITEM_COLUMNS].sort());
    for (const cost of COST_COLUMNS) {
      expect(columns).not.toContain(cost);
    }
  });

  test('DATA-HOME-001 移行は ALTER DEFAULT PRIVILEGES を使わず、対の戻しの SQL（ROLLBACK の節）を持つ', () => {
    expect(sql).not.toMatch(/^\s*ALTER DEFAULT PRIVILEGES/m);
    expect(sql).toMatch(/^-- ROLLBACK/m);
    const rollback = sql.slice(sql.indexOf('-- ROLLBACK'), sql.indexOf('\nBEGIN;'));
    for (const column of PUBLIC_ITEM_COLUMNS) {
      expect(rollback).toContain(column);
    }
  });

  test('DATA-HOME-001 移行は items から全部の権限を外してから service_role に明示で付け、書き込みを anon・authenticated に付け直さない', () => {
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.items FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT ALL ON TABLE public\.items TO service_role;/);
    expect(sql).not.toMatch(/GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)[^;]*ON TABLE public\.items TO[^;]*(?:anon|authenticated)/i);
  });

  test('DATA-HOME-001 移行は item_cost_history の誰でも許す方針を消し、admin.finance.read の SELECT 方針だけを authenticated に付ける', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "Allow all" ON public\.item_cost_history;/);
    expect(sql).toMatch(/CREATE POLICY "admin item_cost_history read by finance permission" ON public\.item_cost_history\s+FOR SELECT TO authenticated\s+USING \(\(SELECT public\.has_permission\('admin\.finance\.read'::text\)\)\);/);
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.item_cost_history TO authenticated;/);
  });

  test('DATA-HOME-001 移行は末尾に権限の自己検査を持ち、失敗の時の符号を決まった形で返す', () => {
    expect(sql).toContain("RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'");
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});

describeLocalDb('integration: items の列権限・原価の履歴・認証の表・profiles の権限', (db) => {
  type Outcome = { rows: any[]; rowCount: number } | { code: string };
  type Role = 'anon' | 'authenticated' | 'service_role';

  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  /** PostgREST が取引ごとに入れる役と JWT のクレームを再現する。権限の誤りで取引を壊さないよう savepoint で包む */
  async function attempt(role: Role, claims: Record<string, unknown> | null, sql: string, params: unknown[] = []): Promise<Outcome> {
    await db().query('savepoint grants_attempt');
    try {
      await db().query(`set local role ${role}`);
      await db().query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : '']);
      const result = await db().query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (caught) {
      return { code: (caught as { code?: string }).code ?? 'unknown' };
    } finally {
      await db().query('rollback to savepoint grants_attempt');
      await db().query('release savepoint grants_attempt');
    }
  }

  async function errorCode(role: Role, claims: Record<string, unknown> | null, sql: string, params: unknown[] = []) {
    const outcome = await attempt(role, claims, sql, params);
    return 'code' in outcome ? outcome.code : undefined;
  }

  async function rowsOf(role: Role, claims: Record<string, unknown> | null, sql: string, params: unknown[] = []) {
    const outcome = await attempt(role, claims, sql, params);
    if ('code' in outcome) throw new Error(`unexpected database error ${outcome.code}`);
    return outcome.rows;
  }

  async function insertUser(role: string | null): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, jsonb_build_object('role', $2::text), '{}', now(), now())`,
      [id, role ?? 'user'],
    );
    if (role) {
      await db().query(
        `insert into public.user_roles (user_id, role_id, active)
         select $1, id, true from public.roles where code = $2
         on conflict (user_id, role_id) do update set active = true, expires_at = null`,
        [id, role],
      );
    }
    return id;
  }

  const claimsOf = (id: string) => ({ sub: id, role: 'authenticated', aal: 'aal2' });

  async function privileges(role: string, relation: string, list: string[]): Promise<string[]> {
    const result = await db().query(
      `select privilege from unnest($3::text[]) as privilege
       where has_table_privilege($1::name, $2::regclass, privilege) order by privilege`,
      [role, `public.${relation}`, list],
    );
    return result.rows.map((row) => row.privilege as string);
  }

  async function seedItemId(): Promise<number> {
    const result = await db().query(`select id from public.items where status = 'published' order by id limit 1`);
    expect(result.rows).toHaveLength(1);
    return Number(result.rows[0].id);
  }

  describe('items', () => {
    test.each(['anon', 'authenticated'])('DATA-HOME-001 %s は原価の 2 列を読めない（列の権限が偽）', async (role) => {
      for (const column of COST_COLUMNS) {
        const result = await db().query(`select has_column_privilege($1::name, 'public.items', $2::text, 'SELECT') as allowed`, [role, column]);
        expect(result.rows[0].allowed).toBe(false);
      }
    });

    test.each(['anon', 'authenticated'].flatMap((role) => PUBLIC_ITEM_COLUMNS.map((column) => [role, column])))(
      'DATA-HOME-001 %s は公開の列 %s を読める',
      async (role, column) => {
        const result = await db().query(`select has_column_privilege($1::name, 'public.items', $2::text, 'SELECT') as allowed`, [role, column]);
        expect(result.rows[0].allowed).toBe(true);
      },
    );

    test.each(['anon', 'authenticated'])('DATA-HOME-001 %s の表単位の SELECT は偽で、列単位の SELECT だけ真', async (role) => {
      const result = await db().query(
        `select has_table_privilege($1::name, 'public.items', 'SELECT') as table_select,
                has_any_column_privilege($1::name, 'public.items', 'SELECT') as any_column_select`,
        [role],
      );
      expect(result.rows[0]).toEqual({ table_select: false, any_column_select: true });
    });

    test.each(['anon', 'authenticated'])('DATA-HOME-001 %s は items への書き込み系の 7 権限を表単位でも列単位でも持たない', async (role) => {
      expect(await privileges(role, 'items', WRITE_PRIVILEGES)).toEqual([]);
      const result = await db().query(
        `select has_any_column_privilege($1::name, 'public.items', 'INSERT') as column_insert,
                has_any_column_privilege($1::name, 'public.items', 'UPDATE') as column_update,
                has_any_column_privilege($1::name, 'public.items', 'REFERENCES') as column_references`,
        [role],
      );
      expect(result.rows[0]).toEqual({ column_insert: false, column_update: false, column_references: false });
    });

    test.each(['anon', 'authenticated'] as Role[])('DATA-HOME-001 %s の select pattern_cost と select * は権限の誤り（42501）で、公開の列だけの select は通る', async (role) => {
      const claims = role === 'authenticated' ? claimsOf(await insertUser(null)) : null;

      expect(await errorCode(role, claims, 'select pattern_cost from public.items limit 1')).toBe('42501');
      expect(await errorCode(role, claims, 'select mass_production_cost from public.items limit 1')).toBe('42501');
      expect(await errorCode(role, claims, 'select * from public.items limit 1')).toBe('42501');
      const rows = await rowsOf(
        role,
        claims,
        `select id, name, product_note, status from public.items where status = 'published' limit 1`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('published');
    });

    test.each(['anon', 'authenticated'] as Role[])('DATA-HOME-001 %s の items への insert・update・delete・truncate は権限の誤り（42501）', async (role) => {
      const claims = role === 'authenticated' ? claimsOf(await insertUser(null)) : null;
      const id = await seedItemId();

      expect(
        await errorCode(
          role,
          claims,
          `insert into public.items (name, description, price, category, image_url, status)
           values ('x', 'x', 1, 'TOPS', 'items/e2e/x.png', 'private')`,
        ),
      ).toBe('42501');
      expect(await errorCode(role, claims, `update public.items set name = 'tampered' where id = $1`, [id])).toBe('42501');
      expect(await errorCode(role, claims, 'delete from public.items where id = $1', [id])).toBe('42501');
      expect(await errorCode(role, claims, 'truncate public.items')).toBe('42501');
    });

    test('DATA-HOME-001 service_role は items の 4 つの行の操作を持ち、原価の列も読める', async () => {
      expect(await privileges('service_role', 'items', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])).toEqual([
        'DELETE',
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
      const rows = await rowsOf('service_role', null, 'select pattern_cost, mass_production_cost from public.items limit 1');
      expect(rows).toHaveLength(1);
    });

    test('DATA-HOME-001 items の列のうち、公開の 21 列と原価の 2 列に入らない列は無い（取りこぼしの検査）', async () => {
      const result = await db().query(
        `select attname from pg_attribute
         where attrelid = 'public.items'::regclass and attnum > 0 and not attisdropped and attname <> all($1::text[])
         order by attname`,
        [[...PUBLIC_ITEM_COLUMNS, ...COST_COLUMNS]],
      );
      expect(result.rows).toEqual([]);
    });

    test('DATA-HOME-001 items を読む注文の窓口（place_order_from_checkout_draft）は service_role だけが呼べ、列の権限の締めに左右されない', async () => {
      // 旧 finalize_order_from_checkout_draft は 20260927100800 で消えた。後継は SECURITY INVOKER なので、
      // 実行できる役が items の全列を持つことが条件になる（service_role は ALL）。
      const legacy = await db().query(
        `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'finalize_order_from_checkout_draft'`,
      );
      expect(legacy.rows).toEqual([]);

      const result = await db().query(
        `select r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') as can_execute
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
         where n.nspname = 'public' and p.proname = 'place_order_from_checkout_draft'
         order by r.role`,
      );
      expect(result.rows).toEqual([
        { role: 'anon', can_execute: false },
        { role: 'authenticated', can_execute: false },
        { role: 'service_role', can_execute: true },
      ]);
    });
  });

  describe('item_cost_history', () => {
    async function insertHistory(): Promise<number> {
      const itemId = await seedItemId();
      const result = await db().query(
        `insert into public.item_cost_history (item_id, season_key, pattern_cost, mass_production_cost, pdf_url)
         values ($1, $2, 1357911, 2468102, 'https://example.com/cost.pdf') returning id`,
        [itemId, `integration-${randomUUID()}`],
      );
      return Number(result.rows[0].id);
    }

    test('DATA-HOME-001 誰でも許す方針 "Allow all" は無く、SELECT の方針は admin.finance.read の 1 本だけ', async () => {
      const result = await db().query(
        `select policyname, array_to_string(roles, ',') as roles, cmd, qual from pg_policies
         where schemaname = 'public' and tablename = 'item_cost_history' order by policyname`,
      );
      expect(result.rows.map((row) => row.policyname)).not.toContain('Allow all');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        policyname: 'admin item_cost_history read by finance permission',
        roles: 'authenticated',
        cmd: 'SELECT',
      });
      expect(result.rows[0].qual).toContain('admin.finance.read');
    });

    test('DATA-HOME-001 anon には item_cost_history の権限が 1 つも無く、select は権限の誤り（42501）', async () => {
      await insertHistory();

      expect(await privileges('anon', 'item_cost_history', ALL_PRIVILEGES)).toEqual([]);
      expect(await errorCode('anon', null, 'select id from public.item_cost_history')).toBe('42501');
    });

    test('DATA-HOME-001 authenticated は SELECT だけを持ち、書き込み系の 7 権限を持たない', async () => {
      expect(await privileges('authenticated', 'item_cost_history', ALL_PRIVILEGES)).toEqual(['SELECT']);
    });

    test('DATA-HOME-001 権限の無い一般会員の select は 0 行で、admin.finance.read を持つ管理者は入れた行が見える', async () => {
      const id = await insertHistory();
      const member = claimsOf(await insertUser(null));
      const admin = claimsOf(await insertUser('admin'));

      const permission = await rowsOf('authenticated', admin, `select public.has_permission('admin.finance.read') as allowed`);
      expect(permission[0].allowed).toBe(true);

      expect(await rowsOf('authenticated', member, 'select id from public.item_cost_history where id = $1', [id])).toEqual([]);
      expect(await rowsOf('authenticated', admin, 'select id from public.item_cost_history where id = $1', [id])).toHaveLength(1);
    });

    test.each(['anon', 'authenticated'] as Role[])('DATA-HOME-001 %s の item_cost_history への insert・update・delete・truncate は管理者でも権限の誤り（42501）', async (role) => {
      const id = await insertHistory();
      const itemId = await seedItemId();
      const claims = role === 'authenticated' ? claimsOf(await insertUser('admin')) : null;

      expect(
        await errorCode(
          role,
          claims,
          `insert into public.item_cost_history (item_id, season_key, pattern_cost, mass_production_cost) values ($1, 'x', 1, 2)`,
          [itemId],
        ),
      ).toBe('42501');
      expect(await errorCode(role, claims, 'update public.item_cost_history set pattern_cost = 999 where id = $1', [id])).toBe('42501');
      expect(await errorCode(role, claims, 'delete from public.item_cost_history where id = $1', [id])).toBe('42501');
      expect(await errorCode(role, claims, 'truncate public.item_cost_history')).toBe('42501');
    });

    test('DATA-HOME-001 service_role は item_cost_history を読み・書き・消せる', async () => {
      const id = await insertHistory();

      expect(await rowsOf('service_role', null, 'select id from public.item_cost_history where id = $1', [id])).toHaveLength(1);
      expect(await errorCode('service_role', null, 'update public.item_cost_history set pattern_cost = 1 where id = $1', [id])).toBeUndefined();
      expect(await errorCode('service_role', null, 'delete from public.item_cost_history where id = $1', [id])).toBeUndefined();
    });
  });

  describe('認証の 5 表と連番', () => {
    test.each(AUTH_TABLES.flatMap((table) => ['anon', 'authenticated'].map((role) => [role, table])))(
      'DATA-HOME-001 %s には %s の権限が 1 つも無い',
      async (role, table) => {
        expect(await privileges(role, table, ALL_PRIVILEGES)).toEqual([]);
      },
    );

    test.each(AUTH_TABLES.flatMap((table) => (['anon', 'authenticated'] as Role[]).map((role) => [role, table] as const)))(
      'DATA-HOME-001 %s の %s への select は 0 行でなく権限の誤り（42501）',
      async (role, table) => {
        const claims = role === 'authenticated' ? claimsOf(await insertUser(null)) : null;

        expect(await errorCode(role, claims, `select count(*)::int as count from public.${table}`)).toBe('42501');
      },
    );

    test('DATA-HOME-001 service_role は認証の 5 表を読める', async () => {
      for (const table of AUTH_TABLES) {
        expect(await errorCode('service_role', null, `select count(*)::int as count from public.${table}`)).toBeUndefined();
      }
    });

    test('DATA-HOME-001 連番 rate_limit_counters_id_seq は anon・authenticated が USAGE・SELECT・UPDATE を持たず、service_role は USAGE・SELECT を持つ', async () => {
      const result = await db().query(
        `select has_sequence_privilege('anon', 'public.rate_limit_counters_id_seq', 'USAGE') as anon_usage,
                has_sequence_privilege('anon', 'public.rate_limit_counters_id_seq', 'SELECT') as anon_select,
                has_sequence_privilege('anon', 'public.rate_limit_counters_id_seq', 'UPDATE') as anon_update,
                has_sequence_privilege('authenticated', 'public.rate_limit_counters_id_seq', 'USAGE') as authenticated_usage,
                has_sequence_privilege('authenticated', 'public.rate_limit_counters_id_seq', 'SELECT') as authenticated_select,
                has_sequence_privilege('authenticated', 'public.rate_limit_counters_id_seq', 'UPDATE') as authenticated_update,
                has_sequence_privilege('service_role', 'public.rate_limit_counters_id_seq', 'USAGE') as service_usage,
                has_sequence_privilege('service_role', 'public.rate_limit_counters_id_seq', 'SELECT') as service_select`,
      );
      expect(result.rows[0]).toEqual({
        anon_usage: false,
        anon_select: false,
        anon_update: false,
        authenticated_usage: false,
        authenticated_select: false,
        authenticated_update: false,
        service_usage: true,
        service_select: true,
      });
    });

    test('DATA-HOME-001 回数の制限の関数（SECURITY DEFINER）は、表の権限を外した後も service_role から呼べて数えられる', async () => {
      const endpoint = `/integration/${randomUUID()}`;
      const bucket = new Date().toISOString();

      const rows = await rowsOf(
        'service_role',
        null,
        'select public.increment_rate_limit_counter($1::inet, $2, $3::timestamptz) as count',
        ['203.0.113.77', endpoint, bucket],
      );

      expect(Number(rows[0].count)).toBe(1);
    });
  });

  describe('profiles', () => {
    test('DATA-HOME-001 anon には profiles の権限が 1 つも無く、select は権限の誤り（42501）', async () => {
      expect(await privileges('anon', 'profiles', ALL_PRIVILEGES)).toEqual([]);
      expect(await errorCode('anon', null, 'select user_id from public.profiles')).toBe('42501');
    });

    test('DATA-HOME-001 authenticated は profiles の SELECT・INSERT・UPDATE・DELETE だけを持つ', async () => {
      expect(await privileges('authenticated', 'profiles', ALL_PRIVILEGES)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });

    test('DATA-HOME-001 authenticated は自分の profiles の行を select・update・delete でき、truncate は権限の誤り（42501）', async () => {
      const userId = await insertUser(null);
      const claims = claimsOf(userId);

      const own = await rowsOf('authenticated', claims, 'select user_id::text as user_id from public.profiles where user_id = $1', [userId]);
      expect(own).toEqual([{ user_id: userId }]);
      expect(await errorCode('authenticated', claims, `update public.profiles set display_name = 'self' where user_id = $1`, [userId])).toBeUndefined();
      expect(await errorCode('authenticated', claims, 'delete from public.profiles where user_id = $1', [userId])).toBeUndefined();
      expect(await errorCode('authenticated', claims, 'truncate public.profiles')).toBe('42501');
    });

    test('DATA-HOME-001 authenticated は自分の profiles の行を upsert でき、他人の行は見えず書き換えもできない', async () => {
      const userId = await insertUser(null);
      const otherId = await insertUser(null);
      const claims = claimsOf(userId);

      expect(
        await errorCode(
          'authenticated',
          claims,
          `insert into public.profiles (user_id, display_name) values ($1, 'self')
           on conflict (user_id) do update set display_name = excluded.display_name`,
          [userId],
        ),
      ).toBeUndefined();
      expect(await rowsOf('authenticated', claims, 'select user_id from public.profiles where user_id = $1', [otherId])).toEqual([]);
      const updated = await attempt('authenticated', claims, `update public.profiles set display_name = 'x' where user_id = $1`, [otherId]);
      expect('code' in updated ? updated.code : updated.rowCount).toBe(0);
    });

    test.each(SERVICE_TABLES)('DATA-HOME-001 service_role には %s の SELECT・INSERT・UPDATE・DELETE が明示で付いている', async (table) => {
      expect(await privileges('service_role', table, ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });
  });
});
