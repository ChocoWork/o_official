-- 注文明細にバリアント参照と受注区分を持たせる。
-- item_name / item_price / color / size のスナップショットはそのまま残す
-- （バリアントが変わっても注文履歴が壊れないため）。

BEGIN;

ALTER TABLE public.order_items
  ALTER COLUMN item_id TYPE bigint;

ALTER TABLE public.order_items
  ADD COLUMN variant_id bigint REFERENCES public.item_variants(id) ON DELETE RESTRICT,
  ADD COLUMN fulfillment_type text NOT NULL DEFAULT 'stock'
    CHECK (fulfillment_type IN ('stock','backorder'));

CREATE INDEX order_items_variant_id_idx ON public.order_items (variant_id);

-- 既存明細の variant_id を color / size の一致で後埋めする。
-- 一致しない明細は NULL のまま残す（スナップショットで履歴は読める）。
--
-- order_items には法令対応の不変性トリガーがあり、あらゆる UPDATE を拒否する。
-- ここで入れるのは行自身のスナップショットから導出した参照であって法的記録の改変ではないため、
-- 後埋めの間だけ無効化する。ALTER TABLE ... DISABLE TRIGGER はトランザクショナルなので、
-- このマイグレーションがロールバックすればトリガーの状態も戻る。
ALTER TABLE public.order_items DISABLE TRIGGER protect_legal_order_item_immutable_fields;

UPDATE public.order_items oi
SET variant_id = v.id
FROM public.item_variants v
LEFT JOIN public.item_colors c ON c.id = v.color_id
LEFT JOIN public.item_sizes  s ON s.id = v.size_id
WHERE oi.variant_id IS NULL
  AND v.item_id = oi.item_id
  AND coalesce(c.name, '')  = coalesce(oi.color, '')
  AND coalesce(s.label, '') = coalesce(oi.size, '');

ALTER TABLE public.order_items ENABLE TRIGGER protect_legal_order_item_immutable_fields;

COMMIT;
