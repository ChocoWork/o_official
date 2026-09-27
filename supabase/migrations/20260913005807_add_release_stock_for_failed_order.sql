-- 未入金のまま終わった注文の在庫を戻す（FREQ-356）
--
-- 背景: finalize_order_from_checkout_draft は注文作成時に無条件で在庫を減らす。
-- コンビニ払い・銀行振込のような時間差決済では、入金されないまま終わる注文が
-- 発生するため、その分を戻す経路が要る。
--
-- 対称性の注意: 減算側（finalize_order_from_checkout_draft）は items.stock_quantity
-- だけを触り、バリアント在庫にも stock_movements にも関与しない。将来バリアント
-- 在庫を本番へ入れるときは、減算とこの復元の両方を同時に更新すること。片側だけ
-- 変更すると在庫が壊れる。
--
-- 冪等性: pending の注文だけを対象にし、処理すると _next_status（既定 'failed'）へ
-- 遷移する。Stripe は同じイベントを再送するため、2回目以降は released=false を
-- 返して何もしない。
--
-- 汎用化（レビュー指摘 C2）: 管理画面から pending 注文をキャンセルする経路も同じ
-- 在庫復元処理を必要とするため、遷移先ステータスを引数化した。webhook / 掃除
-- ジョブは既定値の 'failed' を使い続け、管理画面は 'cancelled' を明示的に渡す。

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
