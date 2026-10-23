-- K-4: 商品から外した色・サイズの組み合わせを止め、戻すと有効に戻す（FREQ-517）。
-- 止める所は DB の同期1か所（items のトリガー items_sync_variants → backfill_item_variants）。
-- 読み手（カート・決済・在庫の判定・お気に入り・交換）は既に item_variants.is_active を見ている。
-- 色・サイズの行と組み合わせは消さない（在庫・番号・履歴を残す）。戻した色の並び（position・hex）は更新しない。
-- 「注文する」の経路（_shown_in_stock_variant_ids がある）だけ、止めた・引けない明細を item_unavailable で断る。
-- 関数は supabase/migrations で最後に定義された版を写し、決めた行だけ足した:
--   backfill_item_variants           … 20260921121038_retire_item_stock_quantity.sql の末尾に is_active の突き合わせを足す
--   place_order_from_checkout_draft  … 20261008220944_cart_checkout_rpcs.sql の「注文する」の経路に組み合わせの確かめを足す
-- 適用前の確認（止まる組み合わせの数と、そのうち在庫が残る物）:
-- select count(*) as to_retire, count(*) filter (where v.stock_quantity > 0) as with_stock
-- from public.item_variants v
-- join public.items i on i.id = v.item_id
-- left join public.item_colors c on c.id = v.color_id
-- left join public.item_sizes z on z.id = v.size_id
-- where v.is_active
--   and not (
--     (case when v.color_id is null then jsonb_array_length(i.colors) = 0
--           else exists (select 1 from jsonb_array_elements(i.colors) e where e->>'name' = c.name) end)
--     and (case when v.size_id is null then cardinality(i.sizes) = 0 else z.label = any (i.sizes) end)
--   );

BEGIN;

-- 1. 色・サイズの同期: 今の色・サイズに無い組み合わせを止め、ある物を戻す。
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

  -- 商品から外した色・サイズの組み合わせを止め、戻した物を有効に戻す（FREQ-517）。
  -- 色は items.colors の name、サイズは items.sizes の名前で、上の色・サイズの行と同じ形で突き合わせる。
  -- 今の色が0件なら色の空いた組み合わせだけが有効（サイズも同じ）。色・サイズの行と組み合わせは消さない
  -- （在庫・番号・履歴を残し、戻した時に同じ組み合わせが有効に戻る）。値が変わる行だけ更新する。
  UPDATE public.item_variants AS v
  SET is_active = want.active
  FROM (
    SELECT v2.id,
           (CASE
              WHEN v2.color_id IS NULL THEN jsonb_array_length(i.colors) = 0
              ELSE EXISTS (
                SELECT 1
                FROM jsonb_array_elements(i.colors) AS elem
                WHERE elem->>'name' = c.name
              )
            END)
           AND
           (CASE
              WHEN v2.size_id IS NULL THEN cardinality(i.sizes) = 0
              ELSE z.label = ANY (i.sizes)
            END) AS active
    FROM public.item_variants v2
    JOIN public.items i ON i.id = v2.item_id
    LEFT JOIN public.item_colors c ON c.id = v2.color_id
    LEFT JOIN public.item_sizes z ON z.id = v2.size_id
    WHERE v2.item_id = target_item_id
  ) AS want
  WHERE v.id = want.id
    AND v.is_active IS DISTINCT FROM want.active;
END;
$function$;

REVOKE ALL ON FUNCTION public.backfill_item_variants(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_item_variants(bigint) TO service_role;

-- 2. 「注文する」: 止めた・引けない組み合わせの明細を item_unavailable で断る。
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
  -- 下書きが無い時や Session・カートが合わない時は、下の読み直しで既存注文の持ち主と比べる。
  IF _shown_in_stock_variant_ids IS NOT NULL
     AND draft_row.id IS NOT NULL
     AND draft_row.checkout_session_id IS NOT DISTINCT FROM _checkout_session_id
     AND draft_row.session_id IS NOT DISTINCT FROM _cart_session_id
     AND draft_row.buyer_user_id IS DISTINCT FROM _buyer_user_id THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
    RETURN;
  END IF;

  -- ロックを待つ間に、並行した受付が同じ Session の注文を作っていれば、それを返す。
  -- 持ち主も同じ文で読み、比べた持ち主と返す注文 ID がずれないようにする。
  SELECT o.id, o.status, o.user_id
  INTO existing_id, existing_status, existing_owner
  FROM public.orders AS o
  WHERE o.checkout_session_id = _checkout_session_id;

  IF existing_id IS NOT NULL THEN
    -- 下書きが無い時や Session・カートが合わない時は、ロックした下書きではこの Session の受付と順番がそろわないので、
    -- 既存注文の持ち主を基準にする（グループ C 設計書 5-3）。
    IF _shown_in_stock_variant_ids IS NOT NULL
       AND (draft_row.id IS NULL
            OR draft_row.checkout_session_id IS DISTINCT FROM _checkout_session_id
            OR draft_row.session_id IS DISTINCT FROM _cart_session_id)
       AND existing_owner IS DISTINCT FROM _buyer_user_id THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
      RETURN;
    END IF;
    -- 別の画面の支払いでカートが空になった後、先に受け付けた画面で押し直して二重に払わせない。
    IF _shown_in_stock_variant_ids IS NOT NULL
       AND existing_status = 'payment_in_progress'::public.order_status
       AND private.checkout_cart_lines_gone(draft_row.cart_id, draft_row.items_snapshot) THEN
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
    -- 商品から外した色・サイズの組み合わせ（止めた、または引けない明細）は、お金が動く前なので断る（FREQ-517）。
    -- 照合の経路（引数が無い時）はお金が動いた後なので、ここを通らずに今までどおり注文を作る。
    IF EXISTS (
      SELECT 1
      FROM public.resolve_checkout_item_variants(draft_row.items_snapshot) AS r
      LEFT JOIN public.item_variants AS v ON v.id = r.variant_id
      WHERE v.id IS NULL OR NOT v.is_active
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'item_unavailable'::text;
      RETURN;
    END IF;

    -- 別の注文がカートを空にした後の下書きでは、同じ商品への二重の申し込みを受け付けない。
    IF private.checkout_cart_lines_gone(draft_row.cart_id, draft_row.items_snapshot) THEN
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
      SELECT o.id, o.status, o.user_id
      INTO existing_id, existing_status, existing_owner
      FROM public.orders AS o
      WHERE o.checkout_session_id = _checkout_session_id;
      IF existing_id IS NOT NULL THEN
        IF _shown_in_stock_variant_ids IS NOT NULL
           AND existing_owner IS DISTINCT FROM _buyer_user_id THEN
          RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
          RETURN;
        END IF;
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

-- 当てた時に今の全商品へ1回効かせる（トリガーと同じ関数を呼ぶ。20261008220958 の後埋めと同じ形）。
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.items ORDER BY id LOOP
    BEGIN
      PERFORM public.backfill_item_variants(r.id);
    EXCEPTION WHEN data_exception THEN
      -- 古い商品の入力不正が1件あっても、ほかの商品の組み合わせをそろえる移行を止めない。
      RAISE WARNING 'item %: variants not synced (%)', r.id, SQLERRM;
    END;
  END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
