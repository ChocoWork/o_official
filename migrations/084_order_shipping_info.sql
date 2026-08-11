-- ============================================================
-- 084: 発送情報と、ゲスト注文の紐付け用インデックス
--
-- ここで追加する列は migration 081 の不変列リストに入っていないので更新できる。
-- 変更は record_order_revision トリガーが order_revisions へ記録する。
-- ============================================================

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS shipping_carrier text NULL
    CHECK (shipping_carrier IS NULL OR shipping_carrier IN ('yamato', 'sagawa', 'japanpost')),
  ADD COLUMN IF NOT EXISTS tracking_number text NULL
    CHECK (tracking_number IS NULL OR tracking_number ~ '^[0-9A-Za-z-]{1,64}$');

-- ADD CONSTRAINT に IF NOT EXISTS は無いので、DROP してから足して再実行可能にする。
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_shipping_info_requires_shipped_at;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_shipping_info_requires_shipped_at
  CHECK (shipped_at IS NOT NULL OR (shipping_carrier IS NULL AND tracking_number IS NULL));

COMMENT ON COLUMN public.orders.shipped_at IS
  '発送日時。NULL は未発送。発送の二重実行を防ぐ条件にも使う。';
COMMENT ON COLUMN public.orders.shipping_carrier IS
  '配送業者。追跡URLの形式は src/lib/orders/shipping-carriers.ts が持つ。';

-- 紐付け用のインデックスは作らない。
-- 紐付けは PostgREST の ilike（大文字小文字を無視した等値比較）で引くが、
-- ILIKE は btree インデックスを使えないため lower(shipping_email) の
-- 式インデックスを作っても効かない。orders は現在16行で、全表走査でも問題ない。
-- 件数が数万に育ったら pg_trgm の GIN か、メールを保存時に正規化する方針へ切り替える。

COMMIT;
