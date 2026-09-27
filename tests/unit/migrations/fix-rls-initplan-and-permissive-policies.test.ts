import fs from 'node:fs';
import path from 'node:path';

// FREQ-382: Supabase advisor の性能 WARN 2種（auth_rls_initplan 15件・multiple_permissive_policies 3件）を直すマイグレーション。
// version は本番に当てた時刻で決まる（MCP apply_migration）ため、名前の後半で探す。
const SUFFIX = '_fix_rls_initplan_and_permissive_policies.sql';

function readMigration(): string {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(SUFFIX));
  expect(files).toHaveLength(1);
  // 説明コメントにも関数名が出てくるので、判定から外す
  return fs.readFileSync(path.join(dir, files[0]), 'utf8').replace(/--.*$/gm, '');
}

function alterPolicyBody(sql: string, table: string, name: string): string {
  const match = sql.match(new RegExp(`ALTER POLICY "${name}" ON public\\.${table}\\b([\\s\\S]*?);`, 'i'));
  expect(match).not.toBeNull();
  return match![1];
}

// select で包んでいない（行ごとに評価される）呼び出し。lint 0003 が拾うもの
function unwrappedCalls(sql: string): string[] {
  return [...sql.matchAll(/(\bselect\s+)?(auth\.uid\(\)|current_setting\()/gi)]
    .filter((match) => !match[1])
    .map((match) => match[2]);
}

describe('RLS の性能 WARN を直すマイグレーション', () => {
  it.each([
    ['wishlist', 'Users can view their own wishlist', ['USING']],
    ['wishlist', 'Users can insert items to their wishlist', ['WITH CHECK']],
    ['wishlist', 'Users can delete from their wishlist', ['USING']],
    ['carts', 'Users can view their own cart', ['USING']],
    ['carts', 'Users can insert their own cart items', ['WITH CHECK']],
    ['carts', 'Users can update their own cart items', ['USING', 'WITH CHECK']],
    ['carts', 'Users can delete their own cart items', ['USING']],
    ['profiles', 'Users can view own profile', ['USING']],
    ['profiles', 'Users can insert own profile', ['WITH CHECK']],
    ['profiles', 'Users can update own profile', ['USING', 'WITH CHECK']],
    ['profiles', 'Users can delete own profile', ['USING']],
    ['orders', 'Users can view their own orders', ['USING']],
    ['orders', 'authenticated orders read', ['USING']],
    ['order_items', 'Users can view their own order items', ['USING']],
    ['order_items', 'authenticated order items read', ['USING']],
  ])('%s の「%s」は auth.uid() と current_setting() を select で包む（lint 0003）', (table, name, clauses) => {
    const body = alterPolicyBody(readMigration(), table, name);
    for (const clause of clauses) {
      expect(body).toMatch(new RegExp(`\\b${clause}\\s*\\(`, 'i'));
    }
    // 対象ロールは変えない（ALTER POLICY ... TO を使わない）
    expect(body).not.toMatch(/^\s*TO\s/i);
    expect(body).toMatch(/select\s+(auth\.uid\(\)|current_setting\()/i);
    expect(unwrappedCalls(body)).toEqual([]);
  });

  it('行ごとに評価される auth.uid() / current_setting() がファイルに残っていない', () => {
    expect(unwrappedCalls(readMigration())).toEqual([]);
  });

  it.each([
    ['admin_finance_entry_review_acks', 'admin finance entry review acks'],
    ['admin_finance_evidence_unavailable_records', 'admin finance evidence unavailable'],
    ['admin_finance_summary_options', 'admin finance summary options'],
  ])('%s の FOR ALL の manage を INSERT / UPDATE / DELETE に分け、read は変えない（lint 0006）', (table, prefix) => {
    const sql = readMigration();
    const manage = "public\\.has_permission\\('admin\\.finance\\.manage'\\)";
    const on = `ON public\\.${table}\\s+`;
    expect(sql).toMatch(new RegExp(`DROP POLICY "${prefix} manage" ON public\\.${table};`));
    expect(sql).toMatch(
      new RegExp(`CREATE POLICY "${prefix} manage insert" ${on}FOR INSERT TO authenticated\\s+WITH CHECK \\(${manage}\\);`),
    );
    expect(sql).toMatch(
      new RegExp(
        `CREATE POLICY "${prefix} manage update" ${on}FOR UPDATE TO authenticated\\s+USING \\(${manage}\\)\\s+WITH CHECK \\(${manage}\\);`,
      ),
    );
    expect(sql).toMatch(
      new RegExp(`CREATE POLICY "${prefix} manage delete" ${on}FOR DELETE TO authenticated\\s+USING \\(${manage}\\);`),
    );
    expect(sql).not.toContain(`"${prefix} read"`);
  });

  it('SELECT に重なる FOR ALL の方針を作らない', () => {
    expect(readMigration()).not.toMatch(/FOR ALL/i);
  });

  it('全体をトランザクションで包む（規約: docs/ops/db-migrations.md）', () => {
    const sql = readMigration();
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
  });
});
