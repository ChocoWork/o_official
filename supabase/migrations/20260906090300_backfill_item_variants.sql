-- 既存の items.colors / items.sizes / items.stock_quantity からバリアントを生成する。
-- 在庫は色 × サイズへ機械的に按分できないため、position が最小の組み合わせへ全量を寄せる。
-- 正しい配分は管理画面で入力し直す前提。

BEGIN;

CREATE OR REPLACE FUNCTION public.backfill_item_variants(target_item_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  legacy_stock  integer;
  head_variant  bigint;
BEGIN
  SELECT stock_quantity INTO legacy_stock FROM public.items WHERE id = target_item_id;

  -- 色。jsonb 配列の並び順を position にする。
  INSERT INTO public.item_colors (item_id, name, hex, position)
  SELECT target_item_id,
         elem->>'name',
         elem->>'hex',
         (ord - 1)::integer
  FROM public.items i,
       LATERAL jsonb_array_elements(i.colors) WITH ORDINALITY AS t(elem, ord)
  WHERE i.id = target_item_id
    AND jsonb_typeof(i.colors) = 'array'
    AND elem->>'name' IS NOT NULL
    AND elem->>'hex' ~ '^#[0-9a-fA-F]{6}$'
  ON CONFLICT (item_id, name) DO NOTHING;

  -- サイズ。text[] の並び順を position にする。
  INSERT INTO public.item_sizes (item_id, label, position)
  SELECT target_item_id, label, (ord - 1)::integer
  FROM public.items i,
       LATERAL unnest(i.sizes) WITH ORDINALITY AS t(label, ord)
  WHERE i.id = target_item_id
  ON CONFLICT (item_id, label) DO NOTHING;

  -- 色 × サイズの直積。片方が無い場合は NULL 側で 1 行になる。
  INSERT INTO public.item_variants (item_id, color_id, size_id)
  SELECT target_item_id, c.id, s.id
  FROM (SELECT id, position FROM public.item_colors WHERE item_id = target_item_id
        UNION ALL SELECT NULL::bigint, NULL::integer
        WHERE NOT EXISTS (SELECT 1 FROM public.item_colors WHERE item_id = target_item_id)) AS c(id, position)
  CROSS JOIN (SELECT id, position FROM public.item_sizes WHERE item_id = target_item_id
              UNION ALL SELECT NULL::bigint, NULL::integer
              WHERE NOT EXISTS (SELECT 1 FROM public.item_sizes WHERE item_id = target_item_id)) AS s(id, position)
  ON CONFLICT DO NOTHING;

  -- 在庫を position 最小のバリアントへ寄せる。既に台帳があるなら何もしない（再実行時の二重計上を防ぐ）。
  IF coalesce(legacy_stock, 0) > 0 THEN
    SELECT v.id INTO head_variant
    FROM public.item_variants v
    LEFT JOIN public.item_colors c ON c.id = v.color_id
    LEFT JOIN public.item_sizes  s ON s.id = v.size_id
    WHERE v.item_id = target_item_id
    ORDER BY coalesce(c.position, -1), coalesce(s.position, -1), v.id
    LIMIT 1;

    IF head_variant IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.stock_movements WHERE variant_id = head_variant) THEN
      INSERT INTO public.stock_movements (variant_id, delta, reason, note)
      VALUES (head_variant, legacy_stock, 'adjustment', 'items.stock_quantity からの移行');
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_item_variants(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_item_variants(bigint) TO service_role;

-- 既存の全商品に対して 1 回実行する。
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.items LOOP
    PERFORM public.backfill_item_variants(r.id);
  END LOOP;
END;
$$;

COMMIT;
