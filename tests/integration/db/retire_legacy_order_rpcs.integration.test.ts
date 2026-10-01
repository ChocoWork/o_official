/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';

/**
 * 引数を変えた関数は古い定義を消し、同名の関数を重複させない（設計書 4-7。PGRST203 を避ける）。
 */
describeLocalDb('integration: 古い注文 RPC を消す', (db) => {
  test.each([
    ['public.finalize_order_from_checkout_draft(uuid,text,text,public.order_status,integer,text)'],
    ['public.release_stock_for_unpaid_order(text,public.order_status)'],
    ['public.admin_cancel_failed_order(uuid,uuid)'],
  ])('%s は無い', async (signature) => {
    const res = await db().query('select to_regprocedure($1) as oid', [signature]);
    expect(res.rows[0].oid).toBeNull();
  });

  test.each([
    ['release_stock_for_unpaid_order', 1],
    ['admin_cancel_failed_order', 1],
  ])('%s は1つだけ', async (name, count) => {
    const res = await db().query(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1`,
      [name],
    );
    expect(res.rows[0].n).toBe(count);
  });
});
