import fs from 'node:fs';
import path from 'node:path';

/**
 * 注文にフリガナの列を足すマイグレーション（FREQ-384、レビュー指摘⑬）。
 *
 * 実際に注文へ書かれること・後から書き換えられないことは
 * tests/integration/db/order_shipping_kana.integration.test.ts が実 DB で確かめる。
 * このテストは、注文確定の関数が配送先の写しからフリガナを写すことと、
 * それ以外の処理を変えていないことを守る。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
// 版番号は本番へ適用したときに確定するため、ファイル名の後半で探す。
const MIGRATION_SUFFIX = '_add_order_shipping_kana.sql';
// 直前の注文確定の定義（FREQ-364 でロック順を揃えたもの）
const PREVIOUS_SUFFIX = '_lock_items_in_id_order.sql';

function readMigration(suffix: string): string {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(suffix));
  expect(files).toHaveLength(1);
  // 説明コメントにも列名が出てくるので、判定から外す
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

describe('注文のフリガナを足すマイグレーション', () => {
  it('orders に shipping_kana 列を足す', () => {
    expect(readMigration(MIGRATION_SUFFIX)).toMatch(
      /alter table public\.orders\s+add column shipping_kana text\s*;/i,
    );
  });

  it('注文確定は配送先の写しの kanaName を shipping_kana に入れる', () => {
    const definition = finalizeDefinition(readMigration(MIGRATION_SUFFIX));
    expect(definition).toMatch(/shipping_phone,\s*shipping_kana\s*\)\s*VALUES/i);
    expect(definition).toMatch(
      /draft_row\.shipping_snapshot->>'phone',\s*draft_row\.shipping_snapshot->>'kanaName'/i,
    );
  });

  it('フリガナの2行を除けば、注文確定は直前の定義と同じ', () => {
    const current = finalizeDefinition(readMigration(MIGRATION_SUFFIX))
      .replace(/shipping_phone,(\s*)shipping_kana/i, 'shipping_phone')
      .replace(
        /draft_row\.shipping_snapshot->>'phone',(\s*)draft_row\.shipping_snapshot->>'kanaName'/i,
        "draft_row.shipping_snapshot->>'phone'",
      );
    expect(normalize(current)).toBe(normalize(finalizeDefinition(readMigration(PREVIOUS_SUFFIX))));
  });

  it('フリガナも法定の変更禁止の対象にする', () => {
    const sql = readMigration(MIGRATION_SUFFIX);
    expect(sql).toMatch(/create or replace function private\.protect_legal_order_immutable_fields\(\)/i);
    expect(sql).toMatch(/OLD\.shipping_phone,\s*OLD\.shipping_kana,\s*OLD\.created_at/);
    expect(sql).toMatch(/NEW\.shipping_phone,\s*NEW\.shipping_kana,\s*NEW\.created_at/);
    expect(sql).toMatch(/USING ERRCODE = 'restrict_violation'/i);
  });

  it('ほかの関数は定義し直さない', () => {
    expect(readMigration(MIGRATION_SUFFIX).match(/create\s+or\s+replace\s+function/gi)).toHaveLength(2);
  });

  it('全体をトランザクションで包む（規約: docs/06_Operations/db-migrations.md）', () => {
    const sql = readMigration(MIGRATION_SUFFIX);
    expect(sql).toMatch(/^BEGIN;$/im);
    expect(sql).toMatch(/^COMMIT;$/im);
  });
});
