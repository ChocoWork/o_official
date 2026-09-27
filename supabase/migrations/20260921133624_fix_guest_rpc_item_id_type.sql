-- ゲスト用 RPC の item_id の型を実際の列にそろえる（FREQ-403）
--
-- carts.item_id と wishlist.item_id は bigint だが、5本の関数が RETURNS TABLE で
-- item_id integer と宣言していた。本番で実測したところ、行を返す文の種類で結果が分かれる。
--
--   add_guest_cart_item              … INSERT/UPDATE ... RETURNING → 42804 で失敗
--   update_guest_cart_item_quantity  … UPDATE ... RETURNING       → 42804 で失敗
--   add_guest_wishlist_item          … INSERT ... RETURNING       → 42804 で失敗
--   list_guest_cart                  … 素の SELECT                → 通る（宣言は誤り）
--   list_guest_wishlist              … 素の SELECT                → 通る（宣言は誤り）
--
-- アプリからは1本も呼ばれていない（参照はマイグレーションのテストだけ）ため実害は出ていないが、
-- 使えば必ず落ちる。通る2本も宣言は同じ誤りなので、5本まとめてそろえる。
--
-- 商品 id を受け取る引数も bigint にする（items.id が bigint）。戻り値と引数の型が変わるので
-- CREATE OR REPLACE では差し替えられず、DROP してから作り直す。
--
-- 作り直した関数の実行権限は既定で PUBLIC に付くため、REVOKE を忘れると匿名から呼べてしまう。
-- 作成のたびに REVOKE / GRANT を書く（20260901 以降の規約と同じ）。
--
-- 本体の処理は変えない。search_path も pg_temp を最後に置いたまま。

BEGIN;

DROP FUNCTION IF EXISTS public.add_guest_cart_item(text, integer, integer, text, text);
DROP FUNCTION IF EXISTS public.update_guest_cart_item_quantity(text, uuid, integer);
DROP FUNCTION IF EXISTS public.add_guest_wishlist_item(text, integer);
DROP FUNCTION IF EXISTS public.list_guest_cart(text);
DROP FUNCTION IF EXISTS public.list_guest_wishlist(text);

CREATE FUNCTION public.add_guest_cart_item(
  p_session_id text,
  p_item_id bigint,
  p_quantity integer,
  p_color text DEFAULT NULL::text,
  p_size text DEFAULT NULL::text
)
 RETURNS TABLE(id uuid, item_id bigint, quantity integer, color text, size text, added_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing public.carts%ROWTYPE;
  v_next_quantity integer;
  v_item_id bigint;
BEGIN
  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'session_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 20 THEN
    RAISE EXCEPTION 'quantity must be between 1 and 20' USING ERRCODE = '22023';
  END IF;

  -- 在庫は見ない（受注生産として受けるため。FREQ-401）。公開されているかだけ確かめる。
  SELECT i.id
    INTO v_item_id
  FROM public.items AS i
  WHERE i.id = p_item_id
    AND i.status = 'published';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_existing
  FROM public.carts AS c
  WHERE c.user_id IS NULL
    AND c.session_id = p_session_id
    AND c.item_id = p_item_id
    AND COALESCE(c.color, '') = COALESCE(p_color, '')
    AND COALESCE(c.size, '') = COALESCE(p_size, '')
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_next_quantity := v_existing.quantity + p_quantity;

    RETURN QUERY
    UPDATE public.carts AS c
      SET quantity = v_next_quantity,
          updated_at = now()
    WHERE c.id = v_existing.id
    RETURNING c.id, c.item_id, c.quantity, c.color, c.size, c.added_at, c.updated_at;
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.carts (session_id, item_id, quantity, color, size)
  VALUES (p_session_id, p_item_id, p_quantity, NULLIF(btrim(COALESCE(p_color, '')), ''), NULLIF(btrim(COALESCE(p_size, '')), ''))
  RETURNING carts.id, carts.item_id, carts.quantity, carts.color, carts.size, carts.added_at, carts.updated_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.add_guest_cart_item(text, bigint, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_guest_cart_item(text, bigint, integer, text, text) TO service_role;

CREATE FUNCTION public.update_guest_cart_item_quantity(
  p_session_id text,
  p_cart_id uuid,
  p_quantity integer
)
 RETURNS TABLE(id uuid, item_id bigint, quantity integer, color text, size text, added_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cart public.carts%ROWTYPE;
  v_item_id bigint;
BEGIN
  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'session_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 20 THEN
    RAISE EXCEPTION 'quantity must be between 1 and 20' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_cart
  FROM public.carts AS c
  WHERE c.id = p_cart_id
    AND c.user_id IS NULL
    AND c.session_id = p_session_id
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cart item not found' USING ERRCODE = 'P0002';
  END IF;

  -- 在庫は見ない。公開されているかだけ確かめる。
  SELECT i.id
    INTO v_item_id
  FROM public.items AS i
  WHERE i.id = v_cart.item_id
    AND i.status = 'published';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  UPDATE public.carts AS c
    SET quantity = p_quantity,
        updated_at = now()
  WHERE c.id = v_cart.id
  RETURNING c.id, c.item_id, c.quantity, c.color, c.size, c.added_at, c.updated_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_guest_cart_item_quantity(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_guest_cart_item_quantity(text, uuid, integer) TO service_role;

CREATE FUNCTION public.add_guest_wishlist_item(p_session_id text, p_item_id bigint)
 RETURNS TABLE(id uuid, item_id bigint, added_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'session_id is required' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.items AS i
    WHERE i.id = p_item_id
      AND i.status = 'published'
  ) THEN
    RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  INSERT INTO public.wishlist (session_id, item_id)
  VALUES (p_session_id, p_item_id)
  RETURNING wishlist.id, wishlist.item_id, wishlist.added_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.add_guest_wishlist_item(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_guest_wishlist_item(text, bigint) TO service_role;

CREATE FUNCTION public.list_guest_cart(p_session_id text)
 RETURNS TABLE(id uuid, item_id bigint, quantity integer, color text, size text, added_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.id, c.item_id, c.quantity, c.color, c.size, c.added_at, c.updated_at
  FROM public.carts AS c
  WHERE c.user_id IS NULL
    AND c.session_id = p_session_id
  ORDER BY c.added_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.list_guest_cart(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_guest_cart(text) TO service_role;

CREATE FUNCTION public.list_guest_wishlist(p_session_id text)
 RETURNS TABLE(id uuid, item_id bigint, added_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT w.id, w.item_id, w.added_at
  FROM public.wishlist AS w
  WHERE w.user_id IS NULL
    AND w.session_id = p_session_id
  ORDER BY w.added_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.list_guest_wishlist(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_guest_wishlist(text) TO service_role;

COMMIT;
