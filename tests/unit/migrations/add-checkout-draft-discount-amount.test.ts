import fs from 'node:fs';
import path from 'node:path';

/**
 * プロモーションコードで割引が付いた注文を確定できるようにする（FREQ-389）。
 *
 * チェックアウト画面にはプロモーションコードの入力欄があり、Stripe セッションも
 * allow_promotion_codes: true で作る。ところが本番の checkout_drafts には
 * discount_amount 列が無く、割引後の合計を下書きへ書き戻す更新がまるごと弾かれていた。
 * 下書きは割引前の合計のまま残り、finalize_order_from_checkout_draft は割引後の
 * 期待額と比べて CHECKOUT_TOTAL_MISMATCH で落ちる。支払い済みの客に 409 を返す。
 *
 * 注文側の discount_amount も 0 を直書きしていたため、直しても注文に割引額が残らない。
 * 列の追加と、注文への引き写しをこのマイグレーションでまとめて入れる。
 *
 * 実際の通り方は tests/integration/db/checkout_draft_discount.integration.test.ts が実 DB で確かめる。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
// 版番号は本番へ適用したときに確定するため、ファイル名の後半で探す。
const MIGRATION_SUFFIX = '_add_checkout_draft_discount_amount.sql';
// 直前の注文確定の定義（削除済み商品を止めたもの）
const PREVIOUS_SUFFIX = '_reject_missing_item_on_finalize.sql';

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

describe('下書きに割引額を持たせるマイグレーション', () => {
  it('checkout_drafts に discount_amount を足す', () => {
    const sql = readMigration(MIGRATION_SUFFIX);
    expect(sql).toMatch(
      /alter table\s+(?:"?public"?\.)?"?checkout_drafts"?\s+add column\s+"?discount_amount"?\s+integer\s+not null\s+default 0/i,
    );
  });

  it('負の割引額は入れさせない', () => {
    expect(readMigration(MIGRATION_SUFFIX)).toMatch(/check\s*\(\s*"?discount_amount"?\s*>=\s*0\s*\)/i);
  });

  it('注文へ下書きの割引額を引き写す', () => {
    expect(finalizeDefinition(readMigration(MIGRATION_SUFFIX))).toMatch(
      /COALESCE\(draft_row\.discount_amount,\s*0\)/i,
    );
  });

  it('割引額を 0 と直書きする書き方は残っていない', () => {
    const definition = finalizeDefinition(readMigration(MIGRATION_SUFFIX));
    // INSERT の値の並びで、shipping_amount の次が 0 のままになっていないこと
    expect(definition).not.toMatch(/draft_row\.shipping_amount,\s*0,/i);
  });

  it('引き写しの1行以外は、直前の定義と同じ', () => {
    const current = finalizeDefinition(readMigration(MIGRATION_SUFFIX)).replace(
      /COALESCE\(draft_row\.discount_amount,\s*0\)/i,
      '0',
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

  it('全体をトランザクションで包む（規約: docs/ops/db-migrations.md）', () => {
    const sql = readMigration(MIGRATION_SUFFIX);
    expect(sql).toMatch(/^BEGIN;$/im);
    expect(sql).toMatch(/^COMMIT;$/im);
  });
});
