-- バリアント在庫の6本（20260919065336〜20260919065518）で出た Supabase advisor の指摘を直す（FREQ-381）。
--
-- 1. function_search_path_mutable（WARN・lint 0011）
--    トリガー関数3つに search_path が無く、呼び出した側の search_path で名前が解決されていた。
--    Supabase の推奨どおり空に固定する。本文は表も関数も参照しない（NEW の列、now()、RAISE だけ）。
--    now() と演算子は pg_catalog にあり、search_path が空でも pg_catalog は常に検索される。
-- 2. unindexed_foreign_keys（INFO・lint 0001）
--    参照先の行を消すとき（ON DELETE RESTRICT / SET NULL の確認）や結合で全件を読まないよう、
--    外部キーの参照元の列に索引を足す。表はまだ小さいので CONCURRENTLY にせず、トランザクションで包む。

BEGIN;

ALTER FUNCTION public.reject_initial_stock_quantity() SET search_path = '';
ALTER FUNCTION public.set_item_variants_updated_at() SET search_path = '';
ALTER FUNCTION public.reject_stock_movement_mutation() SET search_path = '';

CREATE INDEX item_variants_color_id_idx ON public.item_variants (color_id);
CREATE INDEX item_variants_size_id_idx ON public.item_variants (size_id);
CREATE INDEX stock_movements_order_item_id_idx ON public.stock_movements (order_item_id);

COMMIT;
