-- Shopify と同じく商品には色・サイズの組み合わせのバリアントが必ずあるようにする。
-- カートはバリアントで持つため、在庫欄を開かずに公開した商品もすぐ入れられるようにする。
-- 適用後の確認（0件であること。組み合わせの一部が欠けた公開中の商品も見つける）:
-- 色・サイズが0件なら backfill と同じく NULL 側の1件として数えるため、各件数の下限を1にする。
-- select i.id
-- from public.items i
-- where i.status = 'published'
--   and (select count(*) from public.item_variants v where v.item_id = i.id)
--     < greatest((select count(*) from public.item_colors c where c.item_id = i.id), 1)
--       * greatest((select count(*) from public.item_sizes s where s.item_id = i.id), 1)
-- order by i.id;

BEGIN;

CREATE OR REPLACE FUNCTION private.sync_item_variants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.backfill_item_variants(NEW.id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.sync_item_variants() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS items_sync_variants ON public.items;
CREATE TRIGGER items_sync_variants
AFTER INSERT OR UPDATE OF colors, sizes ON public.items
FOR EACH ROW EXECUTE FUNCTION private.sync_item_variants();

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.items ORDER BY id LOOP
    BEGIN
      PERFORM public.backfill_item_variants(r.id);
    EXCEPTION WHEN data_exception THEN
      -- 古い商品の入力不正が1件あっても、ほかの商品を買えるようにする移行を止めない。
      RAISE WARNING 'item %: variants not synced (%)', r.id, SQLERRM;
    END;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
