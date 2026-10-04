import fs from 'node:fs';
import path from 'node:path';

/**
 * 在庫の単位をバリアントへ寄せる第1段（FREQ-398）。
 *
 * 客に見える変化は無い段。注文明細に variant_id と引当区分を記録し、在庫で賄える分だけ
 * 台帳（stock_movements）へ追記して引き当てる。在庫が無い組み合わせは受注生産（backorder）
 * として受ける（ブランドの前提。docs/01_Planning/brand.md）。
 *
 * ここは旧マイグレーションの形だけを見る。旧 finalize RPC は
 * 20260927100800_retire_legacy_order_rpcs.sql で削除した。現行のバリアント明細と在庫確保は
 * tests/integration/db/place_order_from_checkout_draft.integration.test.ts が実 DB で確かめる。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
// 版番号は本番へ適用したときに確定するため、ファイル名の後半で探す。
const MIGRATION_SUFFIX = '_wire_variant_stock_on_order.sql';

function readMigration(): string {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(MIGRATION_SUFFIX));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), 'utf8');
}

/** コメントを外した本文。 */
function statements(): string {
  return readMigration().replace(/--.*$/gm, '');
}

describe('バリアント在庫の引き当てマイグレーション', () => {
  it('全体をトランザクションで包む（規約: docs/06_Operations/db-migrations.md）', () => {
    const sql = readMigration();
    expect(sql).toMatch(/^BEGIN;$/im);
    expect(sql).toMatch(/^COMMIT;$/im);
  });

  it('注文明細に variant_id と引当区分を書く', () => {
    const sql = statements();
    const insertBlock = sql.match(/INSERT INTO public\.order_items[\s\S]*?RETURNING/i)?.[0] ?? '';

    expect(insertBlock).toMatch(/\bvariant_id\b/);
    expect(insertBlock).toMatch(/\bfulfillment_type\b/);
  });

  it('在庫で賄えるバリアントだけ台帳へ purchase を追記する', () => {
    const sql = statements();

    expect(sql).toMatch(/INSERT INTO public\.stock_movements[\s\S]*?'purchase'/i);
    expect(sql).toMatch(/fulfillment_type\s*=\s*'stock'/i);
  });

  it('在庫が足りない・対応しない・停止中は backorder にする', () => {
    const sql = statements();

    expect(sql).toMatch(/v\.is_active/);
    expect(sql).toMatch(/v\.stock_quantity\s*>=\s*n\.quantity/i);
    expect(sql).toMatch(/ELSE\s+'backorder'/i);
  });

  it('引き当ての判定はバリアント単位で合算する（同じバリアントが複数明細に分かれる）', () => {
    expect(statements()).toMatch(/SUM\(r\.quantity\)[\s\S]*?GROUP BY r\.variant_id/i);
  });

  it('未入金の取り消しで、引き当てた分を cancel として戻す', () => {
    const sql = statements();

    expect(sql).toMatch(/insert into public\.stock_movements[\s\S]*?'cancel'/i);
    expect(sql).toMatch(/fulfillment_type\s*=\s*'stock'/i);
  });

  it('items の在庫の増減は従来どおり残す（表示側を切り替える段までは2系統が併存する）', () => {
    const sql = statements();

    expect(sql).toMatch(/UPDATE public\.items i\s+SET stock_quantity = i\.stock_quantity - agg\.quantity/i);
    expect(sql).toMatch(/update public\.items i\s+set stock_quantity = i\.stock_quantity \+ agg\.quantity/i);
  });

  /**
   * ロックは items（id 昇順）→ item_variants（id 昇順）。注文確定と在庫戻しで順序をそろえる。
   * 逆順で取る経路があるとデッドロックになる。
   */
  it('注文確定も在庫戻しも、items の次に item_variants を id 昇順でロックする', () => {
    const sql = statements();

    for (const body of splitFunctionBodies(sql)) {
      if (!/item_variants/i.test(body)) continue;
      const itemsLock = body.search(/from public\.items i\b/i);
      const variantsLock = body.search(/from public\.item_variants v\b/i);
      if (itemsLock === -1 || variantsLock === -1) continue;
      expect(itemsLock).toBeLessThan(variantsLock);
    }

    // item_variants のロックは必ず id 昇順。文ごとに切って見る
    // （関数をまたいで正規表現を伸ばすと、別の FOR UPDATE を拾う）。
    const variantLocks = sql
      .split(';')
      .filter((stmt) => /\bfor update\b/i.test(stmt) && /public\.item_variants v\b/i.test(stmt));

    expect(variantLocks).toHaveLength(2);
    for (const stmt of variantLocks) {
      expect(stmt).toMatch(/order by v\.id\s+for update/i);
    }
  });

  it('0 個の明細は台帳に書かない（delta <> 0 の CHECK で注文を落とさない）', () => {
    const sql = statements();
    const movementInserts = [...sql.matchAll(/INSERT INTO public\.stock_movements[\s\S]*?ORDER BY/gi)];

    expect(movementInserts.length).toBe(2);
    for (const match of movementInserts) {
      expect(match[0]).toMatch(/quantity\s*>\s*0/i);
    }
  });
});

/** `AS $...$ ... $...$;` で囲まれた関数本体を取り出す。 */
function splitFunctionBodies(sql: string): string[] {
  return [...sql.matchAll(/\bas\s+(\$[a-z_]*\$)([\s\S]*?)\1/gi)].map((match) => match[2]);
}
