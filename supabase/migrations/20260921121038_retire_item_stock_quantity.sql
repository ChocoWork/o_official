-- 在庫の単位を色 × サイズだけにする 第3段の残り（FREQ-401）
--
-- items.stock_quantity（商品単位の在庫数）を廃止する。在庫の正は item_variants と
-- 在庫台帳（stock_movements）に一本化し、2系統が併存する状態を終わらせる。
--
-- ブランドの前提は受注生産。在庫の有無は「買えるか」ではなく「納期」を分ける
-- （FREQ-400）。したがって在庫を理由に注文もカートも止めない。この段で落とすのは
-- 「在庫が足りなければ断る」という商品単位の判定そのもの。
--
-- 本番の実測: items 9件すべて stock_quantity が NULL。判定は最初から効いておらず、
-- 落としても今の動きは変わらない。値が入っている行も無いので移すデータも無い。
--
-- 触る関数（いずれも items.stock_quantity を読んでいた）:
--   add_guest_cart_item              … カート追加の在庫上限を外す
--   update_guest_cart_item_quantity  … 数量変更の在庫上限を外す
--   update_cart_item_quantity_secure … 同上（ログイン時）
--   finalize_order_from_checkout_draft … 注文確定の在庫検査と減算を外す
--   release_stock_for_unpaid_order   … 取り消し時の在庫復元を外す
--   backfill_item_variants           … 旧在庫の移し替えを外す
--
-- 商品が公開されているかの検査は残す。在庫とは別の話で、非公開の商品は買えない。
-- 数量の上限はアプリ側（MAX_CART_ITEM_QUANTITY）とゲスト用関数の 1..20 で担保する。
--
-- search_path は関数定義の中で pg_temp を最後に置く（CREATE OR REPLACE は proconfig を
-- 丸ごと置き換えるため、書かないと 20260921011535 の対策が巻き戻る）。

BEGIN;

-- 1. カート追加（ゲスト）: 在庫上限を外す。公開商品かどうかの確認は残す。
CREATE OR REPLACE FUNCTION public.add_guest_cart_item(
  p_session_id text,
  p_item_id integer,
  p_quantity integer,
  p_color text DEFAULT NULL::text,
  p_size text DEFAULT NULL::text
)
 RETURNS TABLE(id uuid, item_id integer, quantity integer, color text, size text, added_at timestamp with time zone, updated_at timestamp with time zone)
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

  -- 在庫は見ない（受注生産として受けるため）。公開されているかだけ確かめる。
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

-- 2. 数量変更（ゲスト）: 在庫上限を外す。
CREATE OR REPLACE FUNCTION public.update_guest_cart_item_quantity(
  p_session_id text,
  p_cart_id uuid,
  p_quantity integer
)
 RETURNS TABLE(id uuid, item_id integer, quantity integer, color text, size text, added_at timestamp with time zone, updated_at timestamp with time zone)
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

-- 3. 数量変更（ログイン時）: 在庫上限と、そのためだけの合算を外す。
CREATE OR REPLACE FUNCTION public.update_cart_item_quantity_secure(
  _cart_id uuid,
  _session_id text,
  _quantity integer
)
 RETURNS TABLE(id uuid, user_id uuid, session_id text, item_id bigint, quantity integer, color text, size text, added_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  target_cart_item public.carts%ROWTYPE;
  item_row RECORD;
BEGIN
  IF _cart_id IS NULL OR _session_id IS NULL OR btrim(_session_id) = '' THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  IF _quantity IS NULL OR _quantity < 1 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;

  SELECT c.*
  INTO target_cart_item
  FROM public.carts AS c
  WHERE c.id = _cart_id
    AND c.session_id = _session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CART_ITEM_NOT_FOUND';
  END IF;

  -- 在庫は見ない。公開されているかだけ確かめる。
  SELECT i.id, i.name, i.status
  INTO item_row
  FROM public.items AS i
  WHERE i.id = target_cart_item.item_id
  FOR SHARE;

  IF NOT FOUND OR item_row.status <> 'published' THEN
    RAISE EXCEPTION 'ITEM_NOT_FOUND';
  END IF;

  RETURN QUERY
  UPDATE public.carts AS c
  SET quantity = _quantity,
      updated_at = now()
  WHERE c.id = _cart_id
    AND c.session_id = _session_id
  RETURNING
    c.id,
    c.user_id,
    c.session_id,
    c.item_id,
    c.quantity,
    c.color,
    c.size,
    c.added_at,
    c.updated_at;
END;
$function$;

-- 4. バリアント生成: 旧在庫の移し替えを外す。色・サイズ・組み合わせの生成だけ残す。
CREATE OR REPLACE FUNCTION public.backfill_item_variants(target_item_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $function$
DECLARE
  bad_color       jsonb;
  bad_color_name  text;
  bad_size_label  text;
BEGIN
  -- colors / sizes の形が壊れている商品は、機械的な変換を諦めて止まる。
  IF EXISTS (
    SELECT 1 FROM public.items
    WHERE id = target_item_id AND jsonb_typeof(colors) <> 'array'
  ) THEN
    RAISE EXCEPTION 'item %: colors is not a jsonb array', target_item_id
      USING ERRCODE = 'data_exception';
  END IF;

  SELECT elem INTO bad_color
  FROM public.items i, LATERAL jsonb_array_elements(i.colors) AS elem
  WHERE i.id = target_item_id
    AND (
      jsonb_typeof(elem) <> 'object'
      OR elem->>'name' IS NULL
      OR elem->>'hex' IS NULL
      OR elem->>'hex' !~ '^#[0-9a-fA-F]{6}$'
    )
  LIMIT 1;

  IF bad_color IS NOT NULL THEN
    RAISE EXCEPTION 'item %: colors has an invalid element %; expected an object like {"name": "...", "hex": "#rrggbb"}',
      target_item_id, bad_color
      USING ERRCODE = 'data_exception';
  END IF;

  SELECT elem->>'name' INTO bad_color_name
  FROM public.items i, LATERAL jsonb_array_elements(i.colors) AS elem
  WHERE i.id = target_item_id
  GROUP BY elem->>'name'
  HAVING count(*) > 1
  LIMIT 1;

  IF bad_color_name IS NOT NULL THEN
    RAISE EXCEPTION 'item %: colors has a duplicate name %', target_item_id, bad_color_name
      USING ERRCODE = 'data_exception';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.items i, LATERAL unnest(i.sizes) AS label
    WHERE i.id = target_item_id AND label IS NULL
  ) THEN
    RAISE EXCEPTION 'item %: sizes contains a NULL element', target_item_id
      USING ERRCODE = 'data_exception';
  END IF;

  SELECT label INTO bad_size_label
  FROM public.items i, LATERAL unnest(i.sizes) AS label
  WHERE i.id = target_item_id
  GROUP BY label
  HAVING count(*) > 1
  LIMIT 1;

  IF bad_size_label IS NOT NULL THEN
    RAISE EXCEPTION 'item %: sizes has a duplicate label %', target_item_id, bad_size_label
      USING ERRCODE = 'data_exception';
  END IF;

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

  -- 旧 items.stock_quantity からの移し替えは廃止（FREQ-401）。
  -- 在庫は台帳（stock_movements）への追記でだけ動かす。
END;
$function$;

-- 5. 注文確定: 商品単位の在庫検査と減算を外す。引き当てはバリアントの台帳だけで行う。
CREATE OR REPLACE FUNCTION public.finalize_order_from_checkout_draft (
  _draft_id              uuid,
  _payment_intent_id     text,
  _checkout_session_id   text,
  _order_status          public.order_status,
  _expected_total_amount integer,
  _currency              text
)
  RETURNS TABLE (
    order_id     uuid,
    order_status public.order_status
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $function$
DECLARE
  draft_row public.checkout_drafts%ROWTYPE;
  item_id_val integer;
  item_status text;
  inserted_order_id uuid;
  inserted_order_status public.order_status;
BEGIN
  IF _draft_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_DRAFT';
  END IF;

  IF _payment_intent_id IS NULL OR btrim(_payment_intent_id) = '' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_REFERENCE';
  END IF;

  -- Idempotency: return existing order if already finalized
  SELECT o.id, o.status
  INTO inserted_order_id, inserted_order_status
  FROM public.orders o
  WHERE o.payment_intent_id = _payment_intent_id
  LIMIT 1;

  IF inserted_order_id IS NOT NULL THEN
    RETURN QUERY SELECT inserted_order_id, inserted_order_status;
    RETURN;
  END IF;

  -- Lock draft row
  SELECT *
  INTO draft_row
  FROM public.checkout_drafts d
  WHERE d.id = _draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_DRAFT';
  END IF;

  -- Idempotency (after lock): 並行した確定処理がロック待ちの間にコミットしていれば、その注文を返す。
  SELECT o.id, o.status
  INTO inserted_order_id, inserted_order_status
  FROM public.orders o
  WHERE o.payment_intent_id = _payment_intent_id
  LIMIT 1;

  IF inserted_order_id IS NOT NULL THEN
    RETURN QUERY SELECT inserted_order_id, inserted_order_status;
    RETURN;
  END IF;

  -- Verify total amount matches
  IF _expected_total_amount IS NOT NULL AND draft_row.total_amount <> _expected_total_amount THEN
    RAISE EXCEPTION 'CHECKOUT_TOTAL_MISMATCH:%:%', draft_row.total_amount, _expected_total_amount;
  END IF;

  IF _currency IS NOT NULL AND lower(draft_row.currency) <> lower(_currency) THEN
    RAISE EXCEPTION 'CHECKOUT_CURRENCY_MISMATCH:%:%', draft_row.currency, _currency;
  END IF;

  -- 商品が公開されているかだけ確かめる（在庫は見ない。受注生産として受けるため）。
  -- ロックは id の昇順で取る。バリアントより先に取る順序は在庫戻しとそろえる。
  FOR item_id_val IN
    SELECT DISTINCT (s->>'item_id')::integer AS item_id
    FROM jsonb_array_elements(draft_row.items_snapshot) AS s
    ORDER BY 1
  LOOP
    SELECT i.status
    INTO item_status
    FROM public.items i
    WHERE i.id = item_id_val
    FOR UPDATE;

    IF NOT FOUND OR item_status IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'ITEM_NOT_PUBLISHED:%', item_id_val;
    END IF;
  END LOOP;

  -- バリアントを id 昇順でロックする（items の次。在庫戻しと同じ順）。
  PERFORM 1
  FROM public.item_variants v
  WHERE v.id IN (
    SELECT r.variant_id
    FROM public.resolve_checkout_item_variants(draft_row.items_snapshot) r
    WHERE r.variant_id IS NOT NULL
  )
  ORDER BY v.id
  FOR UPDATE;

  -- Insert order
  BEGIN
    INSERT INTO public.orders (
      session_id,
      checkout_session_id,
      payment_intent_id,
      status,
      subtotal_amount,
      shipping_amount,
      discount_amount,
      total_amount,
      currency,
      shipping_email,
      shipping_full_name,
      shipping_postal_code,
      shipping_prefecture,
      shipping_city,
      shipping_address,
      shipping_building,
      shipping_phone,
      shipping_kana
    ) VALUES (
      draft_row.session_id,
      _checkout_session_id,
      _payment_intent_id,
      _order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      COALESCE(draft_row.discount_amount, 0),
      draft_row.total_amount,
      draft_row.currency,
      draft_row.shipping_snapshot->>'email',
      draft_row.shipping_snapshot->>'fullName',
      draft_row.shipping_snapshot->>'postalCode',
      draft_row.shipping_snapshot->>'prefecture',
      draft_row.shipping_snapshot->>'city',
      draft_row.shipping_snapshot->>'address',
      draft_row.shipping_snapshot->>'building',
      draft_row.shipping_snapshot->>'phone',
      draft_row.shipping_snapshot->>'kanaName'
    )
    RETURNING id, status
    INTO inserted_order_id, inserted_order_status;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT o.id, o.status
      INTO inserted_order_id, inserted_order_status
      FROM public.orders o
      WHERE o.payment_intent_id = _payment_intent_id
      LIMIT 1;
      IF inserted_order_id IS NOT NULL THEN
        RETURN QUERY SELECT inserted_order_id, inserted_order_status;
        RETURN;
      END IF;
      RAISE;
  END;

  -- Insert order_items from items_snapshot, and reserve stock for the covered variants.
  WITH resolved AS (
    SELECT * FROM public.resolve_checkout_item_variants(draft_row.items_snapshot)
  ),
  needed AS (
    SELECT r.variant_id, SUM(r.quantity)::integer AS quantity
    FROM resolved r
    WHERE r.variant_id IS NOT NULL
    GROUP BY r.variant_id
  ),
  covered AS (
    SELECT n.variant_id
    FROM needed n
    JOIN public.item_variants v ON v.id = n.variant_id
    WHERE v.is_active
      AND v.stock_quantity >= n.quantity
  ),
  inserted_items AS (
    INSERT INTO public.order_items (
      order_id,
      item_id,
      item_name,
      item_price,
      item_image_url,
      color,
      size,
      quantity,
      line_total,
      variant_id,
      fulfillment_type
    )
    SELECT inserted_order_id,
           r.item_id,
           r.item_name,
           r.item_price,
           r.item_image_url,
           r.color,
           r.size,
           r.quantity,
           r.line_total,
           r.variant_id,
           CASE
             WHEN r.variant_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM covered c WHERE c.variant_id = r.variant_id)
             THEN 'stock'
             ELSE 'backorder'
           END
    FROM resolved r
    ORDER BY r.line_no
    RETURNING id, variant_id, quantity, fulfillment_type
  )
  INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
  SELECT i.variant_id, -i.quantity, 'purchase', inserted_order_id, i.id
  FROM inserted_items i
  WHERE i.fulfillment_type = 'stock'
    AND i.quantity > 0
  ORDER BY i.variant_id, i.id;

  -- Remove cart items
  DELETE FROM public.carts c
  USING jsonb_array_elements(draft_row.items_snapshot) AS s
  WHERE (s->>'source_cart_id') IS NOT NULL
    AND c.id = (s->>'source_cart_id')::uuid
    AND c.session_id = draft_row.session_id;

  -- Mark draft completed
  UPDATE public.checkout_drafts
  SET status = 'completed',
      checkout_session_id = COALESCE(checkout_session_id, _checkout_session_id),
      payment_intent_id   = COALESCE(payment_intent_id, _payment_intent_id)
  WHERE id = _draft_id;

  RETURN QUERY SELECT inserted_order_id, inserted_order_status;
END;
$function$;

REVOKE ALL ON FUNCTION "public"."finalize_order_from_checkout_draft"(uuid, text, text, public.order_status, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."finalize_order_from_checkout_draft"(uuid, text, text, public.order_status, integer, text) TO "postgres", "service_role";

-- 6. 在庫戻し: 商品単位の在庫復元を外す。戻すのはバリアントの台帳だけ。
--    items は書かなくなったのでロックも要らない。
create or replace function public.release_stock_for_unpaid_order(
  _payment_intent_id text,
  _next_status public.order_status default 'failed'
)
returns table (released boolean, order_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
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

  -- バリアントを id 昇順でロックする（注文確定と同じ順）。
  perform 1
  from public.item_variants v
  where v.id in (
    select oi.variant_id
    from public.order_items oi
    where oi.order_id = target_order_id
      and oi.variant_id is not null
      and oi.fulfillment_type = 'stock'
  )
  order by v.id
  for update;

  -- 引き当てた分を台帳へ戻す。追記でしか在庫を動かさない。
  -- この関数は pending の注文だけを対象に状態を進めるため、同じ注文で二度は走らない。
  insert into public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
  select oi.variant_id, oi.quantity, 'cancel', target_order_id, oi.id
  from public.order_items oi
  where oi.order_id = target_order_id
    and oi.variant_id is not null
    and oi.fulfillment_type = 'stock'
    and oi.quantity > 0
  order by oi.variant_id, oi.id;

  return query select true, target_order_id;
end;
$$;

revoke all on function public.release_stock_for_unpaid_order(text, public.order_status) from public, anon, authenticated;
grant execute on function public.release_stock_for_unpaid_order(text, public.order_status) to service_role;

-- 7. 列を落とす。ここまでで参照は残っていない。
ALTER TABLE public.items DROP COLUMN stock_quantity;

COMMIT;
