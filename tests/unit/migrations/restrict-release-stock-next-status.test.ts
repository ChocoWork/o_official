import fs from 'node:fs';
import path from 'node:path';

/**
 * 在庫復元の遷移先を failed / cancelled に限るマイグレーション（FREQ-383、レビュー指摘⑫）。
 *
 * 許可しない値でエラーになり、注文・在庫・改訂履歴が変わらないことは
 * tests/integration/db/release_stock_next_status.integration.test.ts が実 DB で確かめる。
 * このテストは、検査が行ロックより前にあることと、検査以外の定義を変えていないことを守る。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
// 版番号は本番へ適用したときに確定するため、ファイル名の後半で探す。
const MIGRATION_SUFFIX = '_restrict_release_stock_next_status.sql';
// 直前の定義（FREQ-364 でロック順を揃えたもの）
const PREVIOUS_SUFFIX = '_lock_items_in_id_order.sql';

const GUARD =
  /if\s+_next_status\s+is\s+null\s+or\s+_next_status\s+not\s+in\s*\(\s*'failed'\s*,\s*'cancelled'\s*\)\s+then\s+raise\s+exception\s+'INVALID_NEXT_STATUS:%'\s*,\s*_next_status\s+using\s+errcode\s*=\s*'invalid_parameter_value'\s*;\s*end\s+if\s*;/i;

function readMigration(suffix: string): string {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(suffix));
  expect(files).toHaveLength(1);
  // 説明コメントにも関数名や値が出てくるので、判定から外す
  return fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), 'utf8').replace(/--.*$/gm, '');
}

function releaseStockDefinition(sql: string): string {
  const match = sql.match(/create or replace function public\.release_stock_for_unpaid_order\b[\s\S]*?\$\$[\s\S]*?\$\$;/i);
  expect(match).not.toBeNull();
  return match![0];
}

// 空白と大文字小文字の違いは比べない
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('在庫復元の遷移先を failed / cancelled に限るマイグレーション', () => {
  it('遷移先が NULL か failed / cancelled 以外なら INVALID_NEXT_STATUS で止める', () => {
    expect(releaseStockDefinition(readMigration(MIGRATION_SUFFIX))).toMatch(GUARD);
  });

  it('検査は注文と商品の行ロックより前にある', () => {
    const definition = releaseStockDefinition(readMigration(MIGRATION_SUFFIX));
    const guardAt = definition.search(GUARD);
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(definition.search(/\bfor\s+update\b/i));
    expect(guardAt).toBeLessThan(definition.search(/\bupdate\s+public\.orders\b/i));
  });

  it('検査を除けば、直前の定義（引数・戻り値・ロック順・在庫の戻し方）と同じ', () => {
    const current = releaseStockDefinition(readMigration(MIGRATION_SUFFIX)).replace(GUARD, '');
    const previous = releaseStockDefinition(readMigration(PREVIOUS_SUFFIX));
    expect(normalize(current)).toBe(normalize(previous));
  });

  it('ほかの関数は定義し直さない', () => {
    expect(readMigration(MIGRATION_SUFFIX).match(/create\s+or\s+replace\s+function/gi)).toHaveLength(1);
  });

  it('実行権限は service_role だけのまま（anon / authenticated / public からは取り上げる）', () => {
    const sql = readMigration(MIGRATION_SUFFIX);
    expect(sql).toMatch(
      /revoke all on function public\.release_stock_for_unpaid_order\(text,\s*public\.order_status\) from public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.release_stock_for_unpaid_order\(text,\s*public\.order_status\) to service_role\s*;/i,
    );
  });

  it('全体をトランザクションで包む（規約: docs/ops/db-migrations.md）', () => {
    const sql = readMigration(MIGRATION_SUFFIX);
    expect(sql).toMatch(/^BEGIN;$/im);
    expect(sql).toMatch(/^COMMIT;$/im);
  });
});
