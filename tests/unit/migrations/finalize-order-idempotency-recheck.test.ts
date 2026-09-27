import fs from 'node:fs';
import path from 'node:path';

/**
 * finalize_order_from_checkout_draft の並行実行対策（FREQ-363）。
 *
 * 同じ支払いの注文確定は3経路（画面の complete、webhook の checkout.session.completed、
 * payment_intent.succeeded）から同時に呼ばれる。ロック取得後の再確認が無いと、後発は
 * 先発がコミットした後の在庫を読んで INSUFFICIENT_STOCK で失敗し、支払い済みの客に
 * 注文失敗を見せる。
 *
 * 並行実行そのものは実 DB でしか検証できない（tests/integration/db/
 * finalize_order_concurrency.integration.test.ts）。このテストは、再確認が
 * 「draft 行のロックより後、在庫確認より前」に居続けることを守る。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
const MIGRATION_SUFFIX = '_recheck_finalize_order_after_draft_lock.sql';

// 版番号は本番へ適用したときに確定するため、ファイル名の後半で探す。
const matchedFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(MIGRATION_SUFFIX));
const sql = matchedFiles.length === 1
  ? fs.readFileSync(path.join(MIGRATIONS_DIR, matchedFiles[0]), 'utf8')
  : '';

/** 「orders を payment_intent_id で引く」SQL の、fromIndex 以降で最初の位置。 */
const ORDER_LOOKUP = /FROM public\.orders o\s+WHERE o\.payment_intent_id = _payment_intent_id/i;

function indexOfOrderLookup(fromIndex: number): number {
  const found = sql.slice(fromIndex).search(ORDER_LOOKUP);
  return found === -1 ? -1 : found + fromIndex;
}

describe('finalize_order_from_checkout_draft のロック後の再確認', () => {
  it('マイグレーションが1本だけある', () => {
    expect(matchedFiles).toHaveLength(1);
  });

  describe('処理の順番', () => {
    const lockMatch = sql.match(/FROM public\.checkout_drafts d\s+WHERE d\.id = _draft_id\s+FOR UPDATE/i);
    const lockIndex = lockMatch?.index ?? -1;
    const fastPathIndex = indexOfOrderLookup(0);
    const recheckIndex = lockIndex >= 0 ? indexOfOrderLookup(lockIndex) : -1;
    const stockLoopIndex = sql.search(/FOR item_id_val,\s*item_qty\s+IN/i);

    it('draft 行を FOR UPDATE でロックする', () => {
      expect(lockIndex).toBeGreaterThan(-1);
    });

    it('ロックの前にも既存注文を確認する（再送を待たせない速い経路）', () => {
      expect(fastPathIndex).toBeGreaterThan(-1);
      expect(fastPathIndex).toBeLessThan(lockIndex);
    });

    // 一意制約違反の処理にも同じ SQL があるため、位置は「ロックの後かつ在庫確認の前」で見る。
    it('ロック取得後・在庫確認の前に、同じ支払いの注文をもう一度確認する', () => {
      expect(stockLoopIndex).toBeGreaterThan(lockIndex);
      expect(recheckIndex).toBeGreaterThan(lockIndex);
      expect(recheckIndex).toBeLessThan(stockLoopIndex);
    });

    it('再確認で見つかったら、その注文を返して終わる', () => {
      const betweenLockAndStock = sql.slice(lockIndex, stockLoopIndex);
      expect(betweenLockAndStock).toMatch(
        /INTO inserted_order_id, inserted_order_status[\s\S]*RETURN QUERY SELECT inserted_order_id, inserted_order_status;\s*RETURN;/i,
      );
    });
  });

  it('一意制約違反での既存注文返却（最後の防御）を残す', () => {
    expect(sql).toMatch(/EXCEPTION[\s\S]*WHEN unique_violation/i);
  });

  it('シグネチャと戻り値を変えない', () => {
    expect(sql).toMatch(/create or replace function public\.finalize_order_from_checkout_draft/i);
    expect(sql).toMatch(/_draft_id\s+uuid/i);
    expect(sql).toMatch(/_order_status\s+public\.order_status/i);
    expect(sql).toMatch(
      /returns table\s*\(\s*order_id\s+uuid\s*,\s*order_status\s+public\.order_status\s*\)/i,
    );
  });

  it('SECURITY DEFINER と search_path を維持する', () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path/i);
  });

  it('権限行を再掲する（create のあとに revoke）', () => {
    expect(sql).toMatch(
      /revoke all on function[\s\S]*finalize_order_from_checkout_draft[\s\S]*from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]*finalize_order_from_checkout_draft[\s\S]*service_role/i,
    );
    expect(sql.search(/revoke all on function/i)).toBeGreaterThan(
      sql.search(/create or replace function/i),
    );
  });

  it('トランザクションで囲む', () => {
    expect(sql).toMatch(/^\s*begin;/im);
    expect(sql).toMatch(/commit;\s*$/im);
  });

  it('在庫の集約・カート削除・draft 完了の処理を落としていない', () => {
    expect(sql).toMatch(/sum\(\s*\(\s*s->>'quantity'\s*\)::integer\s*\)/i);
    expect(sql).toMatch(/stock_quantity\s*=\s*i\.stock_quantity\s*-\s*agg\.quantity/i);
    expect(sql).toMatch(/INSUFFICIENT_STOCK/);
    expect(sql).toMatch(/ITEM_NOT_PUBLISHED/);
    expect(sql).toMatch(/delete from public\.carts/i);
    expect(sql).toMatch(/status\s*=\s*'completed'/i);
  });
});
