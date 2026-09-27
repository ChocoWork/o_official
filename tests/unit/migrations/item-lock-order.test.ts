import fs from 'node:fs';
import path from 'node:path';

/**
 * 商品行のロック順を id の昇順に揃えるマイグレーション（FREQ-364）。
 *
 * 注文確定（finalize_order_from_checkout_draft）と在庫復元（release_stock_for_unpaid_order）が
 * 同じ商品を別々の順でロックすると、同時に走ったときデッドロックになる。
 *
 * 実際のロック順は tests/integration/db/item_lock_order.integration.test.ts が実 DB で確かめる。
 * このテストは、順序を決める記述がマイグレーションから消えないよう守る。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
const MIGRATION_SUFFIX = '_lock_items_in_id_order.sql';

// 版番号は本番へ適用したときに確定するため、ファイル名の後半で探す。
const matchedFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(MIGRATION_SUFFIX));
const sql = matchedFiles.length === 1
  ? fs.readFileSync(path.join(MIGRATIONS_DIR, matchedFiles[0]), 'utf8')
  : '';

describe('商品行のロック順（id 昇順）', () => {
  it('マイグレーションが1本だけある', () => {
    expect(matchedFiles).toHaveLength(1);
  });

  describe('注文確定（finalize_order_from_checkout_draft）', () => {
    const loopQuery = sql.match(/FOR item_id_val,\s*item_qty\s+IN([\s\S]*?)LOOP/i)?.[1] ?? '';

    it('在庫検証ループが見つかる', () => {
      expect(loopQuery).not.toBe('');
    });

    it('検証ループは item_id の昇順で回す', () => {
      expect(loopQuery).toMatch(/group by[\s\S]*order by\s+1\b/i);
    });

    it('ロック後の再確認（FREQ-363）を落としていない', () => {
      const lockIndex = sql.search(
        /FROM public\.checkout_drafts d\s+WHERE d\.id = _draft_id\s+FOR UPDATE/i,
      );
      const stockLoopIndex = sql.search(/FOR item_id_val,\s*item_qty\s+IN/i);
      const recheck = sql.slice(lockIndex, stockLoopIndex);
      expect(recheck).toMatch(
        /FROM public\.orders o\s+WHERE o\.payment_intent_id = _payment_intent_id/i,
      );
    });
  });

  describe('在庫復元（release_stock_for_unpaid_order）', () => {
    const functionBody = sql.slice(
      sql.search(/create or replace function public\.release_stock_for_unpaid_order/i),
    );
    const updateIndex = functionBody.search(/update public\.items i/i);
    const orderedLockIndex = functionBody.search(
      /from public\.items i[\s\S]*order by i\.id\s+for update/i,
    );

    it('在庫を戻す UPDATE が見つかる', () => {
      expect(updateIndex).toBeGreaterThan(-1);
    });

    it('UPDATE の前に、商品行を id の昇順でまとめてロックする', () => {
      expect(orderedLockIndex).toBeGreaterThan(-1);
      expect(orderedLockIndex).toBeLessThan(updateIndex);
    });

    it('ロック対象はその注文の明細に含まれる商品', () => {
      const orderedLock = functionBody.slice(orderedLockIndex, updateIndex);
      expect(orderedLock).toMatch(/public\.order_items oi/i);
      expect(orderedLock).toMatch(/oi\.order_id = target_order_id/i);
    });

    it('在庫を戻す処理（item_id で合算・pending のみ）を落としていない', () => {
      expect(functionBody).toMatch(/stock_quantity\s*=\s*i\.stock_quantity\s*\+\s*agg\.quantity/i);
      expect(functionBody).toMatch(/sum\(oi\.quantity\)/i);
      expect(functionBody).toMatch(/o\.status = 'pending'/i);
    });
  });

  it('2つの関数のシグネチャと戻り値を変えない', () => {
    expect(sql).toMatch(
      /returns table\s*\(\s*order_id\s+uuid\s*,\s*order_status\s+public\.order_status\s*\)/i,
    );
    expect(sql).toMatch(/returns table\s*\(\s*released\s+boolean\s*,\s*order_id\s+uuid\s*\)/i);
    expect(sql).toMatch(/security definer/i);
  });

  it('権限行を再掲する', () => {
    expect(sql).toMatch(
      /grant execute on function[\s\S]*finalize_order_from_checkout_draft[\s\S]*service_role/i,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]*release_stock_for_unpaid_order[\s\S]*service_role/i,
    );
  });

  it('トランザクションで囲む', () => {
    expect(sql).toMatch(/^\s*begin;/im);
    expect(sql).toMatch(/commit;\s*$/im);
  });
});
