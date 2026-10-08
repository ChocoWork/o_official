-- グループ C: ログイン客の注文の持ち主を確かめて保存する
-- （docs/superpowers/specs/2026-10-08-order-owner-binding-design.md 第5章）
BEGIN;

ALTER TABLE public.checkout_drafts
  ADD COLUMN IF NOT EXISTS buyer_user_id uuid;

COMMENT ON COLUMN public.checkout_drafts.buyer_user_id IS
  '「確認へ進む」でサーバーが確かめた会員の ID。空はゲスト。後から変えられない。外部キーは付けない（会員を消した後も誰とも一致せず、「注文する」が断られる側に倒すため。設計書 5-4）。';

CREATE OR REPLACE FUNCTION public.guard_checkout_draft_buyer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.buyer_user_id IS DISTINCT FROM OLD.buyer_user_id THEN
    RAISE EXCEPTION 'CHECKOUT_DRAFT_BUYER_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS checkout_drafts_buyer_immutable ON public.checkout_drafts;
CREATE TRIGGER checkout_drafts_buyer_immutable
  BEFORE UPDATE OF buyer_user_id ON public.checkout_drafts
  FOR EACH ROW EXECUTE FUNCTION public.guard_checkout_draft_buyer();

-- 注文の持ち主は空から値へだけ書ける。別の会員への付け替えは断る。
-- 空へ戻すのは、会員を消して外部キー（ON DELETE SET NULL）が空にする時だけ通す（設計書 5-5）。
-- RLS に左右されずに profiles を見るため SECURITY DEFINER にする。
CREATE OR REPLACE FUNCTION public.guard_order_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.user_id IS NULL OR NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles AS p WHERE p.user_id = OLD.user_id
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ORDER_OWNER_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_order_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_owner_immutable ON public.orders;
CREATE TRIGGER orders_owner_immutable
  BEFORE UPDATE OF user_id ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_owner();

DROP FUNCTION IF EXISTS public.claim_checkout_draft(
  text, smallint, text, text, text, text, text, integer, integer, integer, integer, jsonb, jsonb
);

CREATE OR REPLACE FUNCTION public.claim_checkout_draft(
  _session_id text,
  _request_version smallint,
  _request_fingerprint text,
  _checkout_ui_mode text,
  _checkout_origin text,
  _payment_method text,
  _currency text,
  _subtotal_amount integer,
  _tax_amount integer,
  _shipping_amount integer,
  _total_amount integer,
  _shipping_snapshot jsonb,
  _items_snapshot jsonb,
  _buyer_user_id uuid
)
RETURNS TABLE (
  id uuid,
  session_id text,
  checkout_session_id text,
  payment_method text,
  currency text,
  subtotal_amount integer,
  tax_amount integer,
  shipping_amount integer,
  total_amount integer,
  shipping_snapshot jsonb,
  items_snapshot jsonb,
  shipping_revision bigint,
  checkout_request_version smallint,
  checkout_request_fingerprint text,
  checkout_ui_mode text,
  checkout_origin text,
  claim_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  claimed public.checkout_drafts%ROWTYPE;
  inserted boolean := false;
BEGIN
  IF _session_id IS NULL
     OR pg_catalog.char_length(_session_id) NOT BETWEEN 1 AND 512
     OR _request_version IS NULL
     OR _request_version <= 0
     OR _request_fingerprint IS NULL
     OR _request_fingerprint !~ ('^v' || _request_version::text || ':[0-9a-f]{64}$')
     OR _checkout_ui_mode IS NULL
     OR NOT (_checkout_ui_mode = ANY (ARRAY['custom'::text, 'hosted'::text]))
     OR _checkout_origin IS NULL
     OR _checkout_origin !~ '^https?://[^/]+$'
     OR _payment_method IS NULL
     OR NOT (_payment_method = ANY (ARRAY['stripe_card'::text, 'stripe_paypay'::text, 'stripe_konbini'::text]))
     OR _currency <> 'jpy'
     OR _subtotal_amount < 0
     OR _tax_amount < 0
     OR _shipping_amount < 0
     OR _total_amount <= 0
     OR _total_amount <> _subtotal_amount + _tax_amount + _shipping_amount
     OR _items_snapshot IS NULL
     OR pg_catalog.jsonb_typeof(_items_snapshot) <> 'array'
     OR pg_catalog.jsonb_array_length(_items_snapshot) = 0 THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_DRAFT_CLAIM'
      USING ERRCODE = '22023';
  END IF;

  FOR attempt IN 1..3 LOOP
    claimed := NULL;
    inserted := false;

    INSERT INTO public.checkout_drafts AS d (
      session_id,
      payment_method,
      currency,
      subtotal_amount,
      tax_amount,
      shipping_amount,
      total_amount,
      shipping_snapshot,
      items_snapshot,
      checkout_request_version,
      checkout_request_fingerprint,
      checkout_ui_mode,
      checkout_origin,
      buyer_user_id
    ) VALUES (
      _session_id,
      _payment_method,
      _currency,
      _subtotal_amount,
      _tax_amount,
      _shipping_amount,
      _total_amount,
      _shipping_snapshot,
      _items_snapshot,
      _request_version,
      _request_fingerprint,
      _checkout_ui_mode,
      _checkout_origin,
      _buyer_user_id
    )
    ON CONFLICT (
      session_id,
      checkout_request_version,
      checkout_request_fingerprint
    ) WHERE status = 'created'
      AND checkout_request_fingerprint IS NOT NULL
    DO NOTHING
    RETURNING d.* INTO claimed;

    IF FOUND THEN
      inserted := true;
      EXIT;
    END IF;

    SELECT d.*
    INTO claimed
    FROM public.checkout_drafts AS d
    WHERE d.session_id = _session_id
      AND d.checkout_request_version = _request_version
      AND d.checkout_request_fingerprint = _request_fingerprint
      AND d.status = 'created'
    LIMIT 1;

    IF FOUND THEN
      EXIT;
    END IF;
  END LOOP;

  IF claimed.id IS NULL THEN
    RAISE EXCEPTION 'CHECKOUT_DRAFT_CLAIM_CONFLICT'
      USING ERRCODE = '40001';
  END IF;

  IF claimed.currency IS DISTINCT FROM _currency
     OR claimed.subtotal_amount IS DISTINCT FROM _subtotal_amount
     OR claimed.tax_amount IS DISTINCT FROM _tax_amount
     OR claimed.shipping_amount IS DISTINCT FROM _shipping_amount
     OR claimed.total_amount IS DISTINCT FROM _total_amount
     OR claimed.items_snapshot IS DISTINCT FROM _items_snapshot
     OR claimed.checkout_ui_mode IS DISTINCT FROM _checkout_ui_mode
     OR claimed.checkout_origin IS DISTINCT FROM _checkout_origin THEN
    RAISE EXCEPTION 'CHECKOUT_FINGERPRINT_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  -- 見分けの値に買い手を含めるので起きない想定。起きたら同じ下書きを別の人に渡さない（設計書 5-2）
  IF claimed.buyer_user_id IS DISTINCT FROM _buyer_user_id THEN
    RAISE EXCEPTION 'CHECKOUT_DRAFT_BUYER_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  SELECT
    claimed.id,
    claimed.session_id,
    claimed.checkout_session_id,
    claimed.payment_method,
    claimed.currency,
    claimed.subtotal_amount,
    claimed.tax_amount,
    claimed.shipping_amount,
    claimed.total_amount,
    claimed.shipping_snapshot,
    claimed.items_snapshot,
    claimed.shipping_revision,
    claimed.checkout_request_version,
    claimed.checkout_request_fingerprint,
    claimed.checkout_ui_mode,
    claimed.checkout_origin,
    inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_checkout_draft(
  text, smallint, text, text, text, text, text, integer, integer, integer, integer, jsonb, jsonb, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_checkout_draft(
  text, smallint, text, text, text, text, text, integer, integer, integer, integer, jsonb, jsonb, uuid
) TO service_role;

DROP FUNCTION IF EXISTS public.place_order_from_checkout_draft(
  uuid, text, text, integer, integer, text, timestamptz, text, bigint[]
);

CREATE OR REPLACE FUNCTION public.place_order_from_checkout_draft(
  _draft_id uuid,
  _checkout_session_id text,
  _cart_session_id text,
  _stripe_amount_total integer,
  _stripe_amount_discount integer,
  _stripe_currency text,
  _checkout_session_created_at timestamptz,
  _payment_intent_id text DEFAULT NULL,
  _shown_in_stock_variant_ids bigint[] DEFAULT NULL,
  _buyer_user_id uuid DEFAULT NULL
)
RETURNS TABLE (order_id uuid, order_status public.order_status, created boolean, rejection text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  draft_row public.checkout_drafts%ROWTYPE;
  existing_id uuid;
  existing_status public.order_status;
  existing_owner uuid;
  inserted_id uuid;
BEGIN
  IF _draft_id IS NULL
     OR NULLIF(pg_catalog.btrim(_checkout_session_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(_cart_session_id), '') IS NULL
     OR _stripe_amount_total IS NULL
     OR _stripe_amount_discount IS NULL
     OR _stripe_amount_discount < 0
     OR NULLIF(pg_catalog.btrim(_stripe_currency), '') IS NULL
     OR _checkout_session_created_at IS NULL
     OR (_buyer_user_id IS NOT NULL AND _shown_in_stock_variant_ids IS NULL) THEN
    RAISE EXCEPTION 'PLACE_ORDER_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- 照合器は同じ Session の既存注文をそのまま返す。画面からの押し直しは下書きをロックしてカートも確かめる。
  SELECT o.id, o.status
  INTO existing_id, existing_status
  FROM public.orders AS o
  WHERE o.checkout_session_id = _checkout_session_id;

  IF existing_id IS NOT NULL AND _shown_in_stock_variant_ids IS NULL THEN
    RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
    RETURN;
  END IF;

  SELECT d.*
  INTO draft_row
  FROM public.checkout_drafts AS d
  WHERE d.id = _draft_id
  FOR UPDATE;

  -- 「注文する」の経路では、「確認へ進む」の時の買い手と今の買い手が同じ時だけ進む（グループ C 設計書 5-3）。
  -- 既にある注文を返すより前に比べ、違う人に注文の ID を返さない。
  IF _shown_in_stock_variant_ids IS NOT NULL THEN
    -- 下書きが無い時や Session・カートが合わない時は、既存注文の持ち主を基準にする。
    IF draft_row.id IS NULL
       OR draft_row.checkout_session_id IS DISTINCT FROM _checkout_session_id
       OR draft_row.session_id IS DISTINCT FROM _cart_session_id THEN
      SELECT o.user_id
      INTO existing_owner
      FROM public.orders AS o
      WHERE o.checkout_session_id = _checkout_session_id;
      IF FOUND AND existing_owner IS DISTINCT FROM _buyer_user_id THEN
        RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
        RETURN;
      END IF;
    ELSE
      IF draft_row.buyer_user_id IS DISTINCT FROM _buyer_user_id THEN
        RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
        RETURN;
      END IF;
    END IF;
  END IF;

  -- ロックを待つ間に、並行した受付が同じ Session の注文を作っていれば、それを返す。
  SELECT o.id, o.status
  INTO existing_id, existing_status
  FROM public.orders AS o
  WHERE o.checkout_session_id = _checkout_session_id;

  IF existing_id IS NOT NULL THEN
    -- 別の画面の支払いでカートが空になった後、先に受け付けた画面で押し直して二重に払わせない。
    IF _shown_in_stock_variant_ids IS NOT NULL
       AND existing_status = 'payment_in_progress'::public.order_status
       AND EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
         WHERE e.value->>'source_cart_id' IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM public.carts AS c
             WHERE c.id = (e.value->>'source_cart_id')::uuid
               AND c.session_id = draft_row.session_id
           )
       ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'cart_changed'::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
    RETURN;
  END IF;

  IF draft_row.id IS NULL
     OR draft_row.session_id IS DISTINCT FROM _cart_session_id
     OR draft_row.checkout_session_id IS DISTINCT FROM _checkout_session_id
     OR draft_row.status IS DISTINCT FROM 'created' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'draft_not_found'::text;
    RETURN;
  END IF;

  -- 0円の注文は受け付けない（FREQ-389）。
  IF _stripe_amount_total <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'zero_amount'::text;
    RETURN;
  END IF;

  IF pg_catalog.lower(draft_row.currency) <> pg_catalog.lower(_stripe_currency) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'currency_mismatch'::text;
    RETURN;
  END IF;

  -- 割引前どうしで比べる。今の下書きは割引前の合計を持ち、古い下書きは割引後の合計と割引額の組を
  -- 持つ。どちらも「合計 + 割引額」は割引前の額になる。
  IF draft_row.total_amount + COALESCE(draft_row.discount_amount, 0)
     <> _stripe_amount_total + _stripe_amount_discount THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'amount_mismatch'::text;
    RETURN;
  END IF;

  -- 商品行を id の昇順で FOR KEY SHARE でロックする（R-42）。
  -- FOR KEY SHARE と衝突するのは FOR UPDATE（削除など）だけ。カートの数量変更（FOR SHARE）とも
  -- 商品の非公開（キー以外の UPDATE）とも衝突しないので、ロック順が逆でもデッドロックしない。
  PERFORM 1
  FROM public.items AS i
  WHERE i.id IN (
    SELECT DISTINCT (e.value->>'item_id')::bigint
    FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
  )
  ORDER BY i.id
  FOR KEY SHARE;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
    LEFT JOIN public.items AS i ON i.id = (e.value->>'item_id')::bigint
    WHERE i.id IS NULL OR i.status IS DISTINCT FROM 'published'
  ) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'item_unavailable'::text;
    RETURN;
  END IF;

  -- バリアントを id の昇順でロックする（商品の次。在庫を戻す処理・入金済みにする処理と同じ順）。
  PERFORM 1
  FROM public.item_variants AS v
  WHERE v.id IN (
    SELECT r.variant_id
    FROM public.resolve_checkout_item_variants(draft_row.items_snapshot) AS r
    WHERE r.variant_id IS NOT NULL
  )
  ORDER BY v.id
  FOR UPDATE;

  -- 受け付けの窓口から呼ばれたとき（最終確認画面で見せた内容がある）だけ、見せた後の変化を確かめる。
  -- お金はまだ動いていないので、変わっていれば注文を作らずに画面で知らせる（設計書 5-3・6-3）。
  -- 引数が無いとき（照合の見回りの予備処理）はお金が動いた後なので、今までどおり注文を作る。
  IF _shown_in_stock_variant_ids IS NOT NULL THEN
    -- 別の注文がカートを空にした後の下書きでは、同じ商品への二重の申し込みを受け付けない。
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
      WHERE e.value->>'source_cart_id' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.carts AS c
          WHERE c.id = (e.value->>'source_cart_id')::uuid
            AND c.session_id = draft_row.session_id
        )
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'cart_changed'::text;
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
      JOIN public.items AS i ON i.id = (e.value->>'item_id')::bigint
      WHERE i.price IS DISTINCT FROM (e.value->>'item_price')::integer
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'price_changed'::text;
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.preview_checkout_fulfillment(draft_row.items_snapshot) AS p
      WHERE p.variant_id = ANY (_shown_in_stock_variant_ids)
        AND p.fulfillment = 'backorder'
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'stock_changed'::text;
      RETURN;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.orders (
      session_id,
      user_id,
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
      shipping_kana,
      checkout_session_created_at
    ) VALUES (
      draft_row.session_id,
      -- 照合の経路（「注文する」を通らない支払い）では、払った時のログインを確かめていないので持ち主を付けない
      CASE WHEN _shown_in_stock_variant_ids IS NOT NULL THEN draft_row.buyer_user_id ELSE NULL END,
      _checkout_session_id,
      _payment_intent_id,
      'payment_in_progress'::public.order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      _stripe_amount_discount,
      _stripe_amount_total,
      draft_row.currency,
      draft_row.shipping_snapshot->>'email',
      draft_row.shipping_snapshot->>'fullName',
      draft_row.shipping_snapshot->>'postalCode',
      draft_row.shipping_snapshot->>'prefecture',
      draft_row.shipping_snapshot->>'city',
      draft_row.shipping_snapshot->>'address',
      draft_row.shipping_snapshot->>'building',
      draft_row.shipping_snapshot->>'phone',
      draft_row.shipping_snapshot->>'kanaName',
      _checkout_session_created_at
    )
    RETURNING id INTO inserted_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT o.id, o.status
      INTO existing_id, existing_status
      FROM public.orders AS o
      WHERE o.checkout_session_id = _checkout_session_id;
      IF existing_id IS NOT NULL THEN
        RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
        RETURN;
      END IF;
      RAISE;
  END;

  -- 明細を写しから作り、在庫で賄える明細だけ確保する（今の確定 RPC と同じ規則）。
  WITH resolved AS (
    SELECT * FROM public.resolve_checkout_item_variants(draft_row.items_snapshot)
  ),
  needed AS (
    SELECT r.variant_id, pg_catalog.sum(r.quantity)::integer AS quantity
    FROM resolved AS r
    WHERE r.variant_id IS NOT NULL
    GROUP BY r.variant_id
  ),
  covered AS (
    SELECT n.variant_id
    FROM needed AS n
    JOIN public.item_variants AS v ON v.id = n.variant_id
    WHERE v.is_active
      AND v.stock_quantity >= n.quantity
  ),
  inserted_items AS (
    INSERT INTO public.order_items (
      order_id, item_id, item_name, item_price, item_image_url, color, size,
      quantity, line_total, variant_id, fulfillment_type
    )
    SELECT inserted_id,
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
              AND EXISTS (SELECT 1 FROM covered AS c WHERE c.variant_id = r.variant_id)
             THEN 'stock'
             ELSE 'backorder'
           END
    FROM resolved AS r
    ORDER BY r.line_no
    RETURNING id, variant_id, quantity, fulfillment_type
  )
  INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id)
  SELECT i.variant_id, -i.quantity, 'purchase', inserted_id, i.id
  FROM inserted_items AS i
  WHERE i.fulfillment_type = 'stock'
    AND i.quantity > 0
  ORDER BY i.variant_id, i.id;

  -- 下書きは受付済みにする。割引額だけを書き戻し、合計は割引前のまま残す（R-26）。
  -- カートは消さない。支払いが済んだ時点で入金済み・入金待ちにする RPC が消す。
  UPDATE public.checkout_drafts AS d
  SET status = 'completed',
      discount_amount = _stripe_amount_discount,
      payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE d.id = _draft_id;

  RETURN QUERY SELECT inserted_id, 'payment_in_progress'::public.order_status, true, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.place_order_from_checkout_draft(
  uuid, text, text, integer, integer, text, timestamptz, text, bigint[], uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_order_from_checkout_draft(
  uuid, text, text, integer, integer, text, timestamptz, text, bigint[], uuid
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
