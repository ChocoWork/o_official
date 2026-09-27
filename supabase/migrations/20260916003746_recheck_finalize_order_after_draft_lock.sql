-- 注文確定を並行呼び出しに耐えるようにする（FREQ-363、レビュー指摘④）
--
-- 背景: 同じ支払いの注文確定は3経路から同時に呼ばれる。
--   1. 画面の POST /api/checkout/complete
--   2. webhook の checkout.session.completed
--   3. webhook の payment_intent.succeeded
-- どれも Checkout Session / PaymentIntent の metadata から同じ draft_id を渡すので、
-- 同じ draft 行を取り合う。
--
-- 問題: 既存注文の確認が draft 行のロックより前にしかなかった。後から来た呼び出しは
--   (1) 既存注文の確認では何も見つけられず（先発がまだコミットしていない）
--   (2) draft 行のロックで待ち、その間に先発がコミットし
--   (3) 在庫確認で、先発が減らした後の在庫を読む
-- ため、最後の1点を買うと INSUFFICIENT_STOCK で失敗する。呼び出し元は画面なら 409 を
-- 返し、支払い済みの客に「注文確定に失敗しました」と表示する。
-- （Read Committed では文ごとに最新のコミット済みデータを読み、FOR UPDATE は待機後に
--   最新の行を返すため。PostgreSQL 17 文書 13.2.1）
--
-- 修正: draft 行のロックを取った直後に、同じ支払いの注文をもう一度確認する。
-- ロック前の確認は残す（再送の大半をロック待ちなしで返せる）。注文 INSERT の
-- 一意制約違反で既存注文を返す処理も、最後の防御として残す。
--
-- シグネチャ・戻り値・権限・在庫の集約・カート削除・draft の完了処理は変更しない。
-- Stripe の注文確定ガイドも「同じ決済に対して確定処理が複数回・同時に呼ばれうるので、
-- 同時に走っても安全にすること」を求めている。

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

  -- Idempotency (after lock): 並行した確定処理がロック待ちの間にコミットしていれば、その注文を返す。
  -- Read Committed では、この SELECT はロックを待ち終わった時点の最新のコミット済みデータを読む。
  -- ここで返さないと、後発は先発が減らした後の在庫を見て INSUFFICIENT_STOCK で失敗し、
  -- 支払い済みの客に注文失敗を返すことになる。
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
