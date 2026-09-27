import fs from 'node:fs';
import path from 'node:path';

// FREQ-381: バリアント在庫の6本で出た Supabase advisor の指摘を直すマイグレーション。
// version は本番に当てた時刻で決まる（MCP apply_migration）ため、名前の後半で探す。
const SUFFIX = '_harden_variant_trigger_functions_and_fk_indexes.sql';

function readMigration(): string {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(SUFFIX));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(dir, files[0]), 'utf8');
}

describe('バリアント在庫の advisor 指摘の修正マイグレーション', () => {
  it.each([
    'reject_initial_stock_quantity',
    'set_item_variants_updated_at',
    'reject_stock_movement_mutation',
  ])('トリガー関数 %s の search_path を空に固定する（lint 0011）', (name) => {
    expect(readMigration()).toMatch(
      new RegExp(`ALTER FUNCTION public\\.${name}\\(\\)\\s+SET search_path = ''`, 'i'),
    );
  });

  it.each([
    ['item_variants', 'color_id'],
    ['item_variants', 'size_id'],
    ['stock_movements', 'order_item_id'],
  ])('外部キー %s.%s に索引を作る（lint 0001）', (table, column) => {
    expect(readMigration()).toMatch(
      new RegExp(`CREATE INDEX \\w+\\s+ON public\\.${table}\\s*\\(${column}\\)`, 'i'),
    );
  });

  it('全体をトランザクションで包む（規約: docs/ops/db-migrations.md）', () => {
    const sql = readMigration();
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
  });
});
