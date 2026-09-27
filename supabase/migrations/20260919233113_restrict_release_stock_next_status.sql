-- 在庫復元の遷移先を failed / cancelled に限る（FREQ-383、レビュー指摘⑫）
--
-- 背景: release_stock_for_unpaid_order は pending の注文を _next_status へ移してから在庫を戻す。
-- _next_status は注文状態のどの値でも通っていたため、呼び出し側を1つ間違えると次が起きた
-- （ローカル DB で実測。在庫 5 の商品を 2 個含む pending の注文）:
--   'pending' … 注文は pending のまま在庫だけ 7 に戻る。呼ぶたびに在庫と改訂履歴が増える
--   'paid'    … 未入金の注文が入金済みになり、在庫も 7 に戻る
--   'shipped' … 未入金の注文が発送済みになり、在庫も 7 に戻る
-- どれもエラーにならないので気づけない。実行できるのは service_role だけで、今の呼び出し元
-- （webhook・cron・管理画面のキャンセル）は 'failed'（既定値）と 'cancelled' しか渡さない。
--
-- 修正: 関数の先頭（行ロックの前）で遷移先を 'failed' / 'cancelled' に限り、それ以外と NULL は
-- INVALID_NEXT_STATUS（SQLSTATE 22023 invalid_parameter_value）で止める。
-- ASSERT は plpgsql.check_asserts で無効にできるため使わない（PostgreSQL 公式: 通常のエラーは RAISE）。
--
-- 検査以外（引数・戻り値・ロック順・在庫の戻し方）は 20260916034433 と同じ。
-- CREATE OR REPLACE は権限を変えないが、既存のマイグレーションに合わせて REVOKE / GRANT も書く。

BEGIN;

create or replace function public.release_stock_for_unpaid_order(
  _payment_intent_id text,
  _next_status public.order_status default 'failed'
)
returns table (released boolean, order_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_order_id uuid;
begin
  -- 未入金の注文を移せる先は failed / cancelled だけ。NULL は not in では弾けないので明示する。
  if _next_status is null or _next_status not in ('failed', 'cancelled') then
    raise exception 'INVALID_NEXT_STATUS:%', _next_status
      using errcode = 'invalid_parameter_value';
  end if;

  select o.id
  into target_order_id
  from public.orders o
  where o.payment_intent_id = _payment_intent_id
    and o.status = 'pending'
  for update;

  if target_order_id is null then
    return query select false, null::uuid;
    return;
  end if;

  update public.orders
  set status = _next_status
  where id = target_order_id;

  -- 商品行は id の昇順でまとめてロックしてから戻す（注文確定と同じ順）。
  -- 下の UPDATE は結合の都合でロック順が変わるため、順序を先に固定する。
  -- 在庫数が空の商品も含めてロックし、注文確定側と同じ集合・同じ順にする。
  perform 1
  from public.items i
  where i.id in (
    select oi.item_id
    from public.order_items oi
    where oi.order_id = target_order_id
  )
  order by i.id
  for update;

  -- 同一商品が複数明細に分かれている場合があるため、item_id で合算してから戻す
  update public.items i
  set stock_quantity = i.stock_quantity + agg.quantity
  from (
    select oi.item_id, sum(oi.quantity)::integer as quantity
    from public.order_items oi
    where oi.order_id = target_order_id
    group by oi.item_id
  ) agg
  where i.id = agg.item_id
    and i.stock_quantity is not null;

  return query select true, target_order_id;
end;
$$;

revoke all on function public.release_stock_for_unpaid_order(text, public.order_status) from public, anon, authenticated;
grant execute on function public.release_stock_for_unpaid_order(text, public.order_status) to service_role;

COMMIT;
