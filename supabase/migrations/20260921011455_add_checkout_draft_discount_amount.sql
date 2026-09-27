-- 割引が付いた注文を確定できるようにする（FREQ-389、優先度低の指摘「100%割引の経路」を追ったときに判明）
--
-- 背景: チェックアウト画面にはプロモーションコードの入力欄があり、Stripe セッションも
-- allow_promotion_codes: true で作る。割引が付くと complete は割引後の実請求額を
-- checkout_drafts へ書き戻すが、本番の checkout_drafts には discount_amount 列が無く、
-- 更新が列ごと弾かれて合計も書き換わらなかった（結果を見ていないので静かに失敗する）。
-- 下書きは割引前の合計のまま残り、直後の注文確定は割引後の期待額と比べて
-- CHECKOUT_TOTAL_MISMATCH で落ちる。支払い済みの客に 409 が返り、注文は1件も作られない。
-- webhook 経路も同じ理由で落ち、Stripe は再送し続ける。
--
-- 修正:
--   1. checkout_drafts に discount_amount を足す（orders には既にある）
--   2. 注文確定が、下書きの割引額を注文へ引き写す（今までは 0 を直書きしていた）
--
-- 引き写しの1行以外は 20260920070833 と同じ。
-- 合計が 0 になる 100%割引は PaymentIntent が作られず別の経路になるため、アプリ側で断る。

BEGIN;

ALTER TABLE "public"."checkout_drafts"
  ADD COLUMN "discount_amount" integer NOT NULL DEFAULT 0;

ALTER TABLE "public"."checkout_drafts"
  ADD CONSTRAINT "checkout_drafts_discount_amount_check" CHECK ("discount_amount" >= 0);

COMMENT ON COLUMN "public"."checkout_drafts"."discount_amount" IS
  'Stripe のプロモーションコードで引かれた額（税込）。total_amount は割引後の実請求額。';

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
  -- order by 1（item_id の昇順）でロックの取得順を固定する。集約の出力順のままだと
  -- 組み合わせごとに順が変わり、在庫復元や別の注文確定と逆順になってデッドロックになる。
  FOR item_id_val, item_qty IN
    SELECT (s->>'item_id')::integer AS item_id,
           SUM((s->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(draft_row.items_snapshot) AS s
    GROUP BY (s->>'item_id')::integer
    ORDER BY 1
  LOOP
    SELECT i.status, i.stock_quantity
    INTO item_status, item_stock
    FROM public.items i
    WHERE i.id = item_id_val
    FOR UPDATE;

    IF NOT FOUND OR item_status IS DISTINCT FROM 'published' THEN
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
  -- 対象行は上の検証ループで既にロック済みなので、ここでのロック順は問題にならない。
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
