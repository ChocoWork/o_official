-- 本番に存在するが、マイグレーションが 1 本も作っていないオブジェクト。
-- 手動で作られたものを本番のカタログから採取した。
--
-- これが無いと 075（audit_logs_backups を参照）と
-- 092（*_guest_* 関数の権限を剥奪）が再生できない。

-- audit_logs の退避先。全列 NULL 許容・既定値なし・制約なしで、
-- CREATE TABLE AS SELECT で作られたと見られる。
CREATE TABLE IF NOT EXISTS public.audit_logs_backups (
  id uuid,
  actor_id uuid,
  actor_email text,
  action text,
  resource text,
  resource_id text,
  outcome text,
  detail text,
  ip text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz
);

ALTER TABLE public.audit_logs_backups ENABLE ROW LEVEL SECURITY;

-- ゲスト用のカート／ウィッシュリスト操作。092 が権限を service_role 限定に絞る対象。
CREATE OR REPLACE FUNCTION public.add_guest_cart_item(p_session_id text, p_item_id integer, p_quantity integer, p_color text DEFAULT NULL::text, p_size text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, item_id integer, quantity integer, color text, size text, added_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.carts%ROWTYPE;
  v_stock_quantity integer;
  v_next_quantity integer;
BEGIN
  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'session_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 20 THEN
    RAISE EXCEPTION 'quantity must be between 1 and 20' USING ERRCODE = '22023';
  END IF;

  SELECT i.stock_quantity
    INTO v_stock_quantity
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
  ELSE
    v_next_quantity := p_quantity;
  END IF;

  IF v_stock_quantity IS NOT NULL AND v_next_quantity > v_stock_quantity THEN
    RAISE EXCEPTION 'requested quantity exceeds available stock' USING ERRCODE = '23514';
  END IF;

  IF FOUND THEN
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

CREATE OR REPLACE FUNCTION public.add_guest_wishlist_item(p_session_id text, p_item_id integer)
 RETURNS TABLE(id uuid, item_id integer, added_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

CREATE OR REPLACE FUNCTION public.delete_guest_cart_item(p_session_id text, p_cart_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted_count integer;
BEGIN
  DELETE FROM public.carts AS c
  WHERE c.id = p_cart_id
    AND c.user_id IS NULL
    AND c.session_id = p_session_id;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_guest_wishlist_item(p_session_id text, p_wishlist_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted_count integer;
BEGIN
  DELETE FROM public.wishlist AS w
  WHERE w.id = p_wishlist_id
    AND w.user_id IS NULL
    AND w.session_id = p_session_id;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_guest_cart(p_session_id text)
 RETURNS TABLE(id uuid, item_id integer, quantity integer, color text, size text, added_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT c.id, c.item_id, c.quantity, c.color, c.size, c.added_at, c.updated_at
  FROM public.carts AS c
  WHERE c.user_id IS NULL
    AND c.session_id = p_session_id
  ORDER BY c.added_at DESC;
$function$;

CREATE OR REPLACE FUNCTION public.list_guest_wishlist(p_session_id text)
 RETURNS TABLE(id uuid, item_id integer, added_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT w.id, w.item_id, w.added_at
  FROM public.wishlist AS w
  WHERE w.user_id IS NULL
    AND w.session_id = p_session_id
  ORDER BY w.added_at DESC;
$function$;

CREATE OR REPLACE FUNCTION public.update_guest_cart_item_quantity(p_session_id text, p_cart_id uuid, p_quantity integer)
 RETURNS TABLE(id uuid, item_id integer, quantity integer, color text, size text, added_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cart public.carts%ROWTYPE;
  v_stock_quantity integer;
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

  SELECT i.stock_quantity
    INTO v_stock_quantity
  FROM public.items AS i
  WHERE i.id = v_cart.item_id
    AND i.status = 'published';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_stock_quantity IS NOT NULL AND p_quantity > v_stock_quantity THEN
    RAISE EXCEPTION 'requested quantity exceeds available stock' USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  UPDATE public.carts AS c
    SET quantity = p_quantity,
        updated_at = now()
  WHERE c.id = v_cart.id
  RETURNING c.id, c.item_id, c.quantity, c.color, c.size, c.added_at, c.updated_at;
END;
$function$;
