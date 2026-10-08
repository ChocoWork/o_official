-- Shopify と同じく商品には色・サイズの組み合わせのバリアントが必ずあるようにする。
-- カートはバリアントで持つため、在庫欄を開かずに公開した商品もすぐ入れられるようにする。
-- 適用後の確認（0件であること。警告で同期を止めた古い商品を見つける）:
-- select i.id from public.items i where i.status = 'published' and not exists (select 1 from public.item_variants v where v.item_id = i.id);

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
