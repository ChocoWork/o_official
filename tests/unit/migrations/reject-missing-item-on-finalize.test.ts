import fs from 'node:fs';
import path from 'node:path';

/**
 * 商品が消えている注文確定を、明示的に止める（FREQ-387、優先度低の指摘「削除済み商品の素通り」）。
 *
 * 注文確定は商品行を1件ずつ引いて公開状態を見るが、商品が削除されていると SELECT INTO は
 * NULL を入れる（PostgreSQL 公式: 行が返らなければ target は NULL、FOUND は false）。
 * `item_status <> 'published'` は NULL との比較で NULL になり、条件が成立せず素通りしていた。
 * そのまま進むと注文明細の外部キー違反で落ち、支払い済みの客に 500 を返すことになる。
 *
 * 現行の受付 RPC での拒否は tests/integration/db/place_order_from_checkout_draft.integration.test.ts が実 DB で確かめる。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
// 版番号は本番へ適用したときに確定するため、ファイル名の後半で探す。
const MIGRATION_SUFFIX = '_reject_missing_item_on_finalize.sql';
// 直前の注文確定の定義（フリガナを足したもの）
const PREVIOUS_SUFFIX = '_add_order_shipping_kana.sql';

function readMigration(suffix: string): string {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(suffix));
  expect(files).toHaveLength(1);
  // 説明コメントにも同じ語が出てくるので、判定から外す
  return fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), 'utf8').replace(/--.*$/gm, '');
}

function finalizeDefinition(sql: string): string {
  const match = sql.match(
    /create or replace function\s+public\.finalize_order_from_checkout_draft\b[\s\S]*?\$function\$[\s\S]*?\$function\$;/i,
  );
  expect(match).not.toBeNull();
  return match![0];
}

// 空白と大文字小文字の違いは比べない
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('削除済み商品での注文確定を止めるマイグレーション', () => {
  it('行が無いときも公開でないときも同じように止める', () => {
    const definition = finalizeDefinition(readMigration(MIGRATION_SUFFIX));
    expect(definition).toMatch(
      /IF NOT FOUND OR item_status IS DISTINCT FROM 'published' THEN\s*RAISE EXCEPTION 'ITEM_NOT_PUBLISHED:%', item_id_val;/i,
    );
  });

  it('NULL と比べて素通りする書き方は残っていない', () => {
    expect(finalizeDefinition(readMigration(MIGRATION_SUFFIX))).not.toMatch(
      /IF item_status <> 'published' THEN/i,
    );
  });

  it('判定の1行以外は、直前の定義と同じ', () => {
    const current = finalizeDefinition(readMigration(MIGRATION_SUFFIX)).replace(
      /IF NOT FOUND OR item_status IS DISTINCT FROM 'published' THEN/i,
      "IF item_status <> 'published' THEN",
    );
    expect(normalize(current)).toBe(normalize(finalizeDefinition(readMigration(PREVIOUS_SUFFIX))));
  });

  it('ほかの関数は定義し直さない', () => {
    expect(readMigration(MIGRATION_SUFFIX).match(/create\s+or\s+replace\s+function/gi)).toHaveLength(1);
  });

  it('実行権限は postgres と service_role のまま', () => {
    const sql = readMigration(MIGRATION_SUFFIX);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION "public"\."finalize_order_from_checkout_draft"[\s\S]*?FROM PUBLIC;/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION "public"\."finalize_order_from_checkout_draft"[\s\S]*?TO "postgres", "service_role";/i);
  });

  it('全体をトランザクションで包む（規約: docs/06_Operations/db-migrations.md）', () => {
    const sql = readMigration(MIGRATION_SUFFIX);
    expect(sql).toMatch(/^BEGIN;$/im);
    expect(sql).toMatch(/^COMMIT;$/im);
  });
});
