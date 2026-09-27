import fs from 'node:fs';
import path from 'node:path';

const sql = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260913005807_add_release_stock_for_failed_order.sql',
  ),
  'utf8',
);

describe('release_stock_for_unpaid_order マイグレーション', () => {
  it('pending の注文だけを対象にする', () => {
    expect(sql).toMatch(/status\s*=\s*'pending'/);
  });

  it('対象行を select ... for update で確保する（コメントの for update では通らない）', () => {
    // for update が select o.id ... from public.orders の一連の文の中にあることを
    // 確認する。単にファイルのどこかに文字列があるだけでは通さない。
    expect(sql).toMatch(
      /select\s+o\.id[\s\S]*?from\s+public\.orders[\s\S]*?for update/i,
    );
  });

  it('同一商品の複数明細を合算してから戻す', () => {
    // 集約せずに order_items を直接 join すると、同じ item_id の明細が
    // 1行ぶんしか反映されない（Postgres の UPDATE ... FROM の仕様）
    expect(sql).toMatch(/sum\(\s*oi\.quantity\s*\)/i);
    expect(sql).toMatch(/group by/i);
  });

  it('stock_quantity を加算で戻す（減算に化けていたら失敗する）', () => {
    // "sum" という単語だけでなく、加算の式そのものを1つの塊として検証する。
    // + agg.quantity が - agg.quantity に変わっても他のテストは全部通ってしまうため、
    // この式単体を厳密一致でチェックする。
    expect(sql).toMatch(
      /stock_quantity\s*=\s*i\.stock_quantity\s*\+\s*agg\.quantity/,
    );
    expect(sql).not.toMatch(
      /stock_quantity\s*=\s*i\.stock_quantity\s*-\s*agg\.quantity/,
    );
  });

  it('stock_quantity が NULL の商品は触らない', () => {
    expect(sql).toMatch(/stock_quantity is not null/i);
  });

  it('引数 _next_status（既定 failed）へ注文を遷移させる', () => {
    // ハードコードされた 'failed' ではなく、引数を書き込んでいることを確認する。
    expect(sql).toMatch(/set\s+status\s*=\s*_next_status/i);
    expect(sql).not.toMatch(/set\s+status\s*=\s*'failed'/i);
  });

  it('_next_status の既定値は failed で、型は public.order_status', () => {
    expect(sql).toMatch(
      /_next_status\s+public\.order_status\s+default\s+'failed'/i,
    );
  });

  it('戻り値の型は releases boolean と order_id uuid のテーブル', () => {
    expect(sql).toMatch(
      /returns\s+table\s*\(\s*released\s+boolean\s*,\s*order_id\s+uuid\s*\)/i,
    );
  });

  it('security definer で search_path を固定する', () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path\s*=\s*public\b/i);
  });

  it('PUBLIC / anon / authenticated から実行権を剥奪し service_role にだけ与える', () => {
    // Supabase は public スキーマの関数に anon/authenticated へも既定で
    // EXECUTE を付与するため、PUBLIC だけの revoke では権限が残る。
    expect(sql).toMatch(
      /revoke all on function public\.release_stock_for_unpaid_order\(text,\s*public\.order_status\) from public\s*,\s*anon\s*,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.release_stock_for_unpaid_order\(text,\s*public\.order_status\) to service_role/i,
    );
  });

  it('revoke は create or replace function より後ろに書かれている（作成直後に PUBLIC が実行できる隙を作らない）', () => {
    const createIndex = sql.search(
      /create or replace function public\.release_stock_for_unpaid_order/i,
    );
    const revokeIndex = sql.search(
      /revoke all on function public\.release_stock_for_unpaid_order/i,
    );

    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(revokeIndex).toBeGreaterThan(createIndex);
  });

  it('search_path を固定する', () => {
    expect(sql).toMatch(/set search_path/i);
  });

  it('マイグレーション全体を BEGIN/COMMIT で囲む（autocommit の隙を作らない）', () => {
    const beginIndex = sql.search(/\bBEGIN;/);
    const createIndex = sql.search(
      /create or replace function public\.release_stock_for_unpaid_order/i,
    );
    const commitIndex = sql.search(/\bCOMMIT;/);
    const revokeIndex = sql.search(
      /revoke all on function public\.release_stock_for_unpaid_order/i,
    );

    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(revokeIndex);
    expect(beginIndex).toBeLessThan(createIndex);
    expect(sql).toMatch(/COMMIT;\s*$/i);
  });
});
