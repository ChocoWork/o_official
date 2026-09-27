-- 在庫減算を集約形に直す（コントローラ裁定による追加タスク、FREQ-356 関連）
--
-- 背景: finalize_order_from_checkout_draft の在庫減算は次の形になっていた。
--
--   UPDATE public.items i
--   SET stock_quantity = i.stock_quantity - (s->>'quantity')::integer
--   FROM jsonb_array_elements(draft_row.items_snapshot) AS s
--   WHERE i.id = (s->>'item_id')::integer
--     AND i.stock_quantity IS NOT NULL;
--
-- Postgres の UPDATE ... FROM は、FROM 側に同じ対象行とマッチする行が複数あっても
-- 対象行を1回しか更新しない（どのソース行が使われるかは不定）。items_snapshot は
-- カート行ごとの配列なので、同じ商品を色違い・サイズ違いで2行買うと片方の数量しか
-- 引かれず、売り越しの原因になる既存バグだった。
--
-- 復元側 release_stock_for_failed_order（20260913005807）は item_id で合算してから
-- 戻すため、このままでは減算より復元の方が多くなり、失敗注文のたびに在庫が水増し
-- される。減算側も同じ集約形に直し、両者を対称にする。
--
-- レビュー指摘（task-1b-review.md 指摘1、Important）: 在庫検証ループも明細単位の
-- ままだと、同一商品を2明細に分けて合計数量が在庫を超える注文が検証を素通りし、
-- 集約後の UPDATE が stock_quantity をマイナスにしてしまう。検証ループも item_id で
-- 集約したサブクエリを走査する形に直し、INSUFFICIENT_STOCK の requested 値は
-- その商品の合計注文数量を報告するようにした。
--
-- 変更点は "-- Decrement stock" 直後の UPDATE 文と、在庫検証ループ、および
-- それぞれのコメントのみ。シグネチャ・戻り値・注文/明細の挿入・カート削除・
-- draft の completed 化・例外メッセージのプレフィックスは一切変更しない。

BEGIN;

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
  SET search_path TO 'public'
  AS $function$
DECLARE
  draft_row public.checkout_drafts%ROWTYPE;
  item_snapshot jsonb;
  item_id_val integer;
  item_qty integer;
  item_stock integer;
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

  -- Verify total amount matches
  IF _expected_total_amount IS NOT NULL AND draft_row.total_amount <> _expected_total_amount THEN
    RAISE EXCEPTION 'CHECKOUT_TOTAL_MISMATCH:%:%', draft_row.total_amount, _expected_total_amount;
  END IF;

  IF _currency IS NOT NULL AND lower(draft_row.currency) <> lower(_currency) THEN
    RAISE EXCEPTION 'CHECKOUT_CURRENCY_MISMATCH:%:%', draft_row.currency, _currency;
  END IF;

  -- Lock items and verify stock from items_snapshot
  -- 同一商品が複数明細に分かれている場合があるため item_id で合算してから検証する。
  -- 明細単位のまま検証すると、各行が減算前の同じ stock_quantity と比較されてしまい、
  -- 合計数量が在庫を超えていても INSUFFICIENT_STOCK が発生しない（下の集約 UPDATE が
  -- 在庫をマイナスにしてしまう）。
  FOR item_id_val, item_qty IN
    SELECT (s->>'item_id')::integer AS item_id,
           SUM((s->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(draft_row.items_snapshot) AS s
    GROUP BY (s->>'item_id')::integer
  LOOP
    SELECT i.status, i.stock_quantity
    INTO item_status, item_stock
    FROM public.items i
    WHERE i.id = item_id_val
    FOR UPDATE;

    IF item_status <> 'published' THEN
      RAISE EXCEPTION 'ITEM_NOT_PUBLISHED:%', item_id_val;
    END IF;

    IF item_stock IS NOT NULL AND item_qty > item_stock THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%', item_id_val, item_qty, item_stock;
    END IF;
  END LOOP;

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
      shipping_phone
    ) VALUES (
      draft_row.session_id,
      _checkout_session_id,
      _payment_intent_id,
      _order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      0,
      draft_row.total_amount,
      draft_row.currency,
      draft_row.shipping_snapshot->>'email',
      draft_row.shipping_snapshot->>'fullName',
      draft_row.shipping_snapshot->>'postalCode',
      draft_row.shipping_snapshot->>'prefecture',
      draft_row.shipping_snapshot->>'city',
      draft_row.shipping_snapshot->>'address',
      draft_row.shipping_snapshot->>'building',
      draft_row.shipping_snapshot->>'phone'
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

  -- Insert order_items from items_snapshot
  INSERT INTO public.order_items (
    order_id,
    item_id,
    item_name,
    item_price,
    item_image_url,
    color,
    size,
    quantity,
    line_total
  )
  SELECT
    inserted_order_id,
    (s->>'item_id')::integer,
    s->>'item_name',
    (s->>'item_price')::integer,
    s->>'item_image_url',
    s->>'color',
    s->>'size',
    (s->>'quantity')::integer,
    (s->>'line_total')::integer
  FROM jsonb_array_elements(draft_row.items_snapshot) AS s;

  -- Decrement stock
  -- 同一商品が複数明細に分かれている場合があるため item_id で合算してから引く。
  -- 集約しないと UPDATE ... FROM が対象行を1度しか更新せず、引き漏らしが出る。
  UPDATE public.items i
  SET stock_quantity = i.stock_quantity - agg.quantity
  FROM (
    SELECT (s->>'item_id')::integer AS item_id,
           SUM((s->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(draft_row.items_snapshot) AS s
    GROUP BY (s->>'item_id')::integer
  ) agg
  WHERE i.id = agg.item_id
    AND i.stock_quantity IS NOT NULL;

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

COMMIT;
