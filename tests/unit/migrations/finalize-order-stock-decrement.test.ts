import fs from 'node:fs';
import path from 'node:path';

const sql = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260913005917_fix_finalize_order_stock_decrement.sql',
  ),
  'utf8',
);

describe('finalize_order_from_checkout_draft の在庫減算', () => {
  it('同一商品の明細を合算してから引く', () => {
    // 集約しないと UPDATE ... FROM が対象行を1回しか更新せず、
    // 同じ商品を2明細で買ったときに片方しか引かれない
    expect(sql).toMatch(/sum\(\s*\(\s*s->>'quantity'\s*\)::integer\s*\)/i);
    expect(sql).toMatch(/group by/i);
  });

  it('引き算であって足し算ではない', () => {
    expect(sql).toMatch(/stock_quantity\s*=\s*i\.stock_quantity\s*-\s*agg\.quantity/i);
    expect(sql).not.toMatch(/stock_quantity\s*=\s*i\.stock_quantity\s*\+/i);
  });

  it('stock_quantity が NULL の商品は触らない', () => {
    expect(sql).toMatch(/stock_quantity is not null/i);
  });

  it('シグネチャと戻り値を変えない', () => {
    expect(sql).toMatch(/create or replace function public\.finalize_order_from_checkout_draft/i);
    expect(sql).toMatch(/_draft_id\s+uuid/i);
    expect(sql).toMatch(/_order_status\s+public\.order_status/i);
    expect(sql).toMatch(/returns table\s*\(\s*order_id\s+uuid\s*,\s*order_status\s+public\.order_status\s*\)/i);
  });

  it('SECURITY DEFINER と search_path を維持する', () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path/i);
  });

  it('権限行を再掲する（create のあとに revoke）', () => {
    expect(sql).toMatch(/revoke all on function[\s\S]*finalize_order_from_checkout_draft[\s\S]*from public/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*finalize_order_from_checkout_draft[\s\S]*service_role/i);
    expect(sql.search(/revoke all on function/i)).toBeGreaterThan(
      sql.search(/create or replace function/i),
    );
  });

  it('トランザクションで囲む', () => {
    expect(sql).toMatch(/^\s*begin;/im);
    expect(sql).toMatch(/commit;\s*$/im);
  });

  it('在庫検証・カート削除・draft 完了の各処理を落としていない', () => {
    expect(sql).toMatch(/INSUFFICIENT_STOCK/);
    expect(sql).toMatch(/ITEM_NOT_PUBLISHED/);
    expect(sql).toMatch(/delete from public\.carts/i);
    expect(sql).toMatch(/status\s*=\s*'completed'/i);
  });

  describe('在庫検証ループの集約化（レビュー指摘1の修正）', () => {
    // 検証ループ本体だけを抜き出す。減算側の集約 UPDATE と区別するため、
    // FOR ... LOOP ～ END LOOP; の範囲に限定して検証する。
    const loopMatch = sql.match(/FOR item_id_val,\s*item_qty\s+IN([\s\S]*?)END LOOP;/i);

    it('検証ループが見つかる（FOR item_id_val, item_qty IN ... END LOOP;）', () => {
      expect(loopMatch).not.toBeNull();
    });

    it('検証ループは jsonb_array_elements の生要素ではなく、item_id で集約したサブクエリを走査する', () => {
      const loopBody = loopMatch ? loopMatch[1] : '';
      expect(loopBody).toMatch(/sum\(\s*\(\s*s->>'quantity'\s*\)::integer\s*\)/i);
      expect(loopBody).toMatch(/group by\s*\(\s*s->>'item_id'\s*\)::integer/i);
    });

    it('明細単位のまま比較していた旧ループ（FOR item_snapshot IN）は残っていない', () => {
      expect(sql).not.toMatch(/FOR item_snapshot IN/i);
    });

    it('検証ループ内でも items 行を FOR UPDATE でロックする', () => {
      const loopBody = loopMatch ? loopMatch[1] : '';
      expect(loopBody).toMatch(/for update/i);
    });

    it('ITEM_NOT_PUBLISHED は引き続き未公開商品で発生する', () => {
      expect(sql).toMatch(/RAISE EXCEPTION 'ITEM_NOT_PUBLISHED:%',\s*item_id_val/i);
    });

    it('INSUFFICIENT_STOCK は集約後の合計注文数量（item_qty）を requested として報告する', () => {
      expect(sql).toMatch(
        /RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%',\s*item_id_val,\s*item_qty,\s*item_stock/i,
      );
    });
  });
});
