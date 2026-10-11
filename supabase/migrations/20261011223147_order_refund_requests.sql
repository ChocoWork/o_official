-- 返金とキャンセル（グループ E-2 設計書 3・4・5・7・9・11 章）の移行 B
--
-- 返金を始める関数（記録を「返事待ち」で作るだけ。Stripe には頼まない）、返金の画面・履歴・見回りのための読み出しの関数、
-- ショップの設定の関数、取り消した注文に入金が届いた時の受け取った額を書く関数を作り、
-- 発送の取消に「返金した商品の発送は取り消せない」守りを足す。
-- 返金の結果を書く関数（在庫・メールの予定・要対応・注文の額と状態）は、注文のメールの表と要対応の理由を変える移行 C で作る。
-- 移行 A（20261011120000_order_refund_records.sql）の後に当てる。
BEGIN;

-- 1. 返金の商品の行（JSON）の形を確かめて分ける。形が違えば REFUND_ARGUMENT_INVALID で止める。
--    0〜100行。同じ（商品, 発送前か）は1行だけ。数は1〜999の整数（小数は黙って丸めずに断る）
CREATE OR REPLACE FUNCTION private.parse_refund_lines(_lines jsonb)
RETURNS TABLE (order_item_id uuid, before_shipment boolean, quantity integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_item jsonb;
  v_seen text[] := ARRAY[]::text[];
  v_key text;
BEGIN
  IF _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) > 100 THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT e.value FROM pg_catalog.jsonb_array_elements(_lines) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object'
       OR pg_catalog.jsonb_typeof(v_item -> 'order_item_id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_item -> 'quantity') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_item -> 'before_shipment') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    BEGIN
      order_item_id := (v_item ->> 'order_item_id')::uuid;
      -- 1.5 のような小数は整数に直せずに失敗する（黙って丸めない）
      quantity := (v_item ->> 'quantity')::integer;
      before_shipment := (v_item ->> 'before_shipment')::boolean;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END;
    v_key := order_item_id::text || ':' || before_shipment::text;
    IF quantity < 1 OR quantity > 999 OR v_key = ANY (v_seen) THEN
      RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_key;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- 2. 返金を始める（設計書 3-2・4-5・4-6・7-4）。記録を「返事待ち」で作るだけで、在庫・注文・メールには触れない
--    （動かすのは、Stripe が受け付けた後に結果を書く移行 C の関数）。
--    道は4つ: admin（管理画面の返金）、order_cancel（支払い済みの注文のキャンセル）、
--    auto_cancelled_order_payment（取り消した注文に入金が届いた自動の返金）、auto_amount_mismatch（支払額の違いの自動の取消）。
--    断る順番は、最初に当たった物で止める: 引数 → 注文 → 二重防止の番号 → 返金できる状態 → 返事待ち → キャンセルできる状態
--    → 返せる額 → 商品の行 → 送料と額の上限 → 全額の時の決まり
CREATE OR REPLACE FUNCTION public.begin_order_refund(
  _order_id uuid,
  _source text,
  _request_key uuid,
  _lines jsonb,
  _restock boolean,
  _shipping_amount integer,
  _amount integer,
  _note text,
  _stripe_reason text,
  _cancel_reason text,
  _notify_customer boolean,
  _actor_id uuid,
  _received_amount integer DEFAULT NULL
)
RETURNS TABLE (refund_id uuid, amount integer, status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_is_admin boolean;
  v_is_auto boolean;
  v_is_cancel boolean;
  v_restock boolean;
  v_notify boolean;
  v_note text;
  v_stripe_reason text;
  v_cancel_reason text;
  v_actor uuid;
  v_fingerprint text;
  v_order public.orders;
  v_existing public.order_refunds;
  v_refundable integer;
  v_refundable_shipping integer;
  v_shipped_total integer;
  v_unshipped_total integer;
  v_resolved jsonb;
  v_included integer;
  v_shipping integer;
  v_amount integer;
  v_priced jsonb;
  v_lines_amount integer;
  v_refund_id uuid;
  v_constraint text;
BEGIN
  -- 1. 引数
  IF _order_id IS NULL
     OR _source IS NULL
     OR _source NOT IN ('admin', 'order_cancel', 'auto_cancelled_order_payment', 'auto_amount_mismatch')
     OR _lines IS NULL
     OR _restock IS NULL
     OR _notify_customer IS NULL THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_is_admin := _source = 'admin';
  v_is_auto := _source IN ('auto_cancelled_order_payment', 'auto_amount_mismatch');
  v_is_cancel := _source IN ('order_cancel', 'auto_amount_mismatch');

  -- 商品の行を渡してよいのはアだけ（イ・オは DB が残りの未発送を全部入れ、エは行なし）。ア・イには二重防止の番号と実行した人が要る
  IF (NOT v_is_admin AND pg_catalog.jsonb_array_length(_lines) > 0)
     OR (NOT v_is_auto AND (_request_key IS NULL OR _actor_id IS NULL))
     OR (_note IS NOT NULL AND pg_catalog.char_length(_note) > 500)
     OR (_stripe_reason IS NOT NULL AND _stripe_reason NOT IN ('requested_by_customer', 'duplicate', 'fraudulent')) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- アの送料と額は呼ぶ側が決める。「うち送料」が額を超える返金は作らない
  IF v_is_admin AND (
       _shipping_amount IS NULL OR _shipping_amount < 0
       OR _amount IS NULL OR _amount < 1
       OR _shipping_amount > _amount
       OR _cancel_reason IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- イの取消の理由は今の4つ。「その他」はメモも要る（未入金の取消の CANCEL_NOTE_REQUIRED と同じ決まり）
  IF _source = 'order_cancel' AND (
       _cancel_reason IS NULL
       OR _cancel_reason NOT IN ('stock_unavailable', 'customer_request', 'suspected_fraud', 'other')
       OR (_cancel_reason = 'other' AND NULLIF(pg_catalog.btrim(_note), '') IS NULL)
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 自動の返金（エ・オ）は、呼ぶ側の値を使わず DB が決める。知らせる・Stripe に理由を伝えない。
  -- オは在庫に戻し、取消の理由は other、メモは決まった文。実行した人は空
  v_restock := CASE WHEN _source = 'auto_amount_mismatch' THEN true ELSE _restock END;
  v_notify := CASE WHEN v_is_auto THEN true ELSE _notify_customer END;
  v_note := CASE _source
    WHEN 'auto_amount_mismatch' THEN '支払額の違いの自動の取消'
    WHEN 'auto_cancelled_order_payment' THEN NULL
    ELSE _note
  END;
  v_stripe_reason := CASE WHEN v_is_auto THEN NULL ELSE _stripe_reason END;
  v_cancel_reason := CASE _source
    WHEN 'order_cancel' THEN _cancel_reason
    WHEN 'auto_amount_mismatch' THEN 'other'
    ELSE NULL
  END;
  v_actor := CASE WHEN v_is_auto THEN NULL ELSE _actor_id END;

  -- 二重防止の指紋（本計画 P2）: 呼ぶ側が渡した入力を、渡されたままの値で決まった順に並べた JSON の md5。
  -- 行は商品の番号・発送前かの順に並べ替えるので、並びだけが違う送り直しは同じ中身。
  -- DB が決める値（イ・オの行、DB が使わない送料と額）は入れない。イ・オの行は渡された '[]' のまま
  IF _request_key IS NOT NULL THEN
    v_fingerprint := pg_catalog.md5(
      pg_catalog.jsonb_build_object(
        'order_id', _order_id,
        'source', _source,
        'lines', COALESCE((
          SELECT pg_catalog.jsonb_agg(
                   pg_catalog.jsonb_build_object(
                     'order_item_id', p.order_item_id,
                     'before_shipment', p.before_shipment,
                     'quantity', p.quantity
                   )
                   ORDER BY p.order_item_id, p.before_shipment
                 )
          FROM private.parse_refund_lines(_lines) AS p
        ), '[]'::jsonb),
        'restock', _restock,
        'shipping_amount', _shipping_amount,
        'amount', _amount,
        'note', _note,
        'stripe_reason', _stripe_reason,
        'cancel_reason', _cancel_reason,
        'notify_customer', _notify_customer,
        'received_amount', _received_amount
      )::text
    );
  END IF;

  -- 2. 注文の行の鍵。返金・発送・仕上がり・発送の取消は、この鍵で1つずつ進む
  --    （同時に押されても、後の方は前の操作の後の数で確かめる。設計書 11-2）
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 3. 同じ二重防止の番号の送り直し（通信が切れた後の「もう一度確かめる」）。同じ中身なら前の記録を返し、
  --    注文の状態や数が変わっていても確かめ直さない。中身が違えば断る
  IF _request_key IS NOT NULL THEN
    SELECT r.* INTO v_existing FROM public.order_refunds AS r WHERE r.request_key = _request_key;
    IF FOUND THEN
      IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'REFUND_REQUEST_MISMATCH' USING ERRCODE = '22023';
      END IF;
      RETURN QUERY SELECT v_existing.id, v_existing.amount, v_existing.status, true;
      RETURN;
    END IF;
  END IF;

  -- 4. エは取り消した注文だけ。受け取った額が空なら、入金を見つけた額を注文に書く（空の時だけ。書いた額が全額になる）
  IF _source = 'auto_cancelled_order_payment' THEN
    IF v_order.status <> 'cancelled'::public.order_status THEN
      RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE = '22023';
    END IF;
    IF v_order.paid_amount IS NULL THEN
      IF _received_amount IS NULL OR _received_amount < 1 THEN
        RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      -- 前の取引の値が残らないように、操作した人と元の知らせの番号は空にする
      PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
      PERFORM pg_catalog.set_config('app.order_change_reason', 'record_cancelled_order_payment', true);
      PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);
      UPDATE public.orders AS o SET paid_amount = _received_amount WHERE o.id = _order_id;
      v_order.paid_amount := _received_amount;
    END IF;
  END IF;

  -- 5. 返金できる状態: 支払い済み・発送済み・取り消した注文で、受け取った額がある
  IF v_order.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status, 'cancelled'::public.order_status)
     OR v_order.paid_amount IS NULL
     OR v_order.paid_amount < 1 THEN
    RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- 6. 返事待ちの返金がある注文には、新しい返金を作れない（確かめ直しだけ。毎時の見回りが片付ける）
  IF EXISTS (
    SELECT 1
    FROM public.order_refunds AS r
    WHERE r.order_id = _order_id
      AND r.status = 'awaiting_response'
  ) THEN
    RAISE EXCEPTION 'AWAITING_REFUND_EXISTS' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.sum(l.shipped), 0)::integer, COALESCE(pg_catalog.sum(l.unshipped), 0)::integer
  INTO v_shipped_total, v_unshipped_total
  FROM private.order_line_fulfillment(_order_id) AS l;

  -- 7. キャンセルは、支払い済みで1つも発送していない注文だけ（Shopify も一部を発送した後はできない）
  IF v_is_cancel AND (v_order.status <> 'paid'::public.order_status OR v_shipped_total > 0) THEN
    RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE' USING ERRCODE = '22023';
  END IF;

  -- 8. 返せる額 = 受け取った額 − 返事待ち・保留・成功の返金。0なら何も返せない
  SELECT a.refundable_amount, a.refundable_shipping INTO v_refundable, v_refundable_shipping
  FROM private.order_refund_amounts(_order_id) AS a;
  IF v_refundable IS NULL OR v_refundable < 1 THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- 9. 商品の行。イ・オは残りの未発送を全部、発送前の行に入れる。エは行なし
  IF v_is_admin THEN
    v_resolved := _lines;
  ELSIF v_is_cancel THEN
    SELECT COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('order_item_id', l.order_item_id, 'before_shipment', true, 'quantity', l.unshipped)
               ORDER BY l.order_item_id
             ),
             '[]'::jsonb
           )
    INTO v_resolved
    FROM private.order_line_fulfillment(_order_id) AS l
    WHERE l.unshipped > 0;
  ELSE
    v_resolved := '[]'::jsonb;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_refund_lines(v_resolved) AS p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.order_items AS oi WHERE oi.id = p.order_item_id AND oi.order_id = _order_id
    )
  ) THEN
    RAISE EXCEPTION 'REFUND_LINE_NOT_IN_ORDER' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_refund_lines(v_resolved) AS p
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = p.order_item_id
    WHERE p.before_shipment
      AND p.quantity > l.unshipped
  ) THEN
    RAISE EXCEPTION 'REFUND_QUANTITY_EXCEEDS_UNSHIPPED' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_refund_lines(v_resolved) AS p
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = p.order_item_id
    WHERE NOT p.before_shipment
      AND p.quantity > l.shipped - l.refunded_after_shipment
  ) THEN
    RAISE EXCEPTION 'REFUND_QUANTITY_EXCEEDS_SHIPPED' USING ERRCODE = '22023';
  END IF;

  -- 10. 送料と額。アは呼ぶ側の値。イ・エ・オは返せる額の全部で、送料はイ・オだけ返せる送料の全部
  --     （手で額を減らした返金が前にあっても、「うち送料」が額を超えないようにする）
  IF v_is_admin THEN
    v_shipping := _shipping_amount;
    v_amount := _amount;
  ELSE
    v_amount := v_refundable;
    v_shipping := CASE
      WHEN _source = 'auto_cancelled_order_payment' THEN 0
      ELSE LEAST(v_refundable_shipping, v_refundable)
    END;
  END IF;
  IF v_shipping > v_refundable_shipping THEN
    RAISE EXCEPTION 'REFUND_SHIPPING_EXCEEDS' USING ERRCODE = '22023';
  END IF;
  IF v_amount > v_refundable THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- 11. 全額の時の決まり（アだけ。イ・オは上で残りを全部入れ、エは取り消した注文で確保が戻し済み）。
  --     全額になるのに未発送が残ると、取り消した注文に確保が残り続ける（R-16）ので断る。
  --     1つも発送していない注文で残りを全部返すのに、送料か額が全部でなければ、全額に届かずキャンセルにならない注文が残るので断る。
  --     全部の送料は min(返せる送料, 返せる額): 前の返金で額を手で増やして、返せる額が返せる送料より小さい注文でも、
  --     「送料 ≤ 額」を守ったまま残りを返せる（イ・オと同じ）。取り消した注文（取消の後の入金）でも同じ決まり（本計画 P28）
  IF v_is_admin THEN
    SELECT COALESCE(pg_catalog.sum(p.quantity) FILTER (WHERE p.before_shipment), 0)::integer INTO v_included
    FROM private.parse_refund_lines(v_resolved) AS p;

    IF v_amount = v_refundable AND v_unshipped_total - v_included > 0 THEN
      RAISE EXCEPTION 'REFUND_MUST_INCLUDE_UNSHIPPED' USING ERRCODE = '22023';
    END IF;
    IF v_shipped_total = 0
       AND v_included > 0
       AND v_unshipped_total - v_included = 0
       AND (v_shipping <> LEAST(v_refundable_shipping, v_refundable) OR v_amount <> v_refundable) THEN
      RAISE EXCEPTION 'REFUND_MUST_BE_FULL' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 12. 商品ごとの額（設計書 4-5）。今回の k 個の額 = 単価 × k − (disc(b + k) − disc(b))。b は前に返した数
  --     （その商品の発送前と発送後を合わせた、返事待ち・保留・成功の数）。同じ返金に同じ商品の発送前と発送後の行がある時は、
  --     発送前の行を先に数える: 発送前の行の b = 前に返した数、発送後の行の b = 前に返した数 + 発送前の行の数
  --     （窓関数の PARTITION BY 商品 ORDER BY before_shipment DESC。入力の並びには依らない）。商品どうしの割り振りは独立。
  --     在庫に戻すのは、発送前・在庫の品・チェックありの行だけ
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'order_item_id', q.order_item_id,
               'before_shipment', q.before_shipment,
               'quantity', q.quantity,
               'restock_type', CASE
                 WHEN q.before_shipment AND q.fulfillment_type = 'stock' AND v_restock THEN 'cancel'::text
                 ELSE 'no_restock'::text
               END,
               'amount', q.item_price * q.quantity
                 - (private.refund_units_discount(q.line_discount, q.ordered, q.already_refunded + q.earlier_in_refund + q.quantity)
                    - private.refund_units_discount(q.line_discount, q.ordered, q.already_refunded + q.earlier_in_refund))
             )
             ORDER BY q.order_item_id, q.before_shipment DESC
           ),
           '[]'::jsonb
         )
  INTO v_priced
  FROM (
    SELECT p.order_item_id,
           p.before_shipment,
           p.quantity,
           l.fulfillment_type,
           oi.item_price,
           oi.quantity AS ordered,
           d.line_discount,
           l.refunded_before_shipment + l.refunded_after_shipment AS already_refunded,
           COALESCE(pg_catalog.sum(p.quantity) OVER (
             PARTITION BY p.order_item_id
             ORDER BY p.before_shipment DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0)::integer AS earlier_in_refund
    FROM private.parse_refund_lines(v_resolved) AS p
    JOIN public.order_items AS oi ON oi.id = p.order_item_id
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = p.order_item_id
    JOIN private.order_line_discounts(_order_id) AS d ON d.order_item_id = p.order_item_id
  ) AS q;

  SELECT COALESCE(pg_catalog.sum(x.amount), 0)::integer INTO v_lines_amount
  FROM pg_catalog.jsonb_to_recordset(v_priced)
    AS x(order_item_id uuid, before_shipment boolean, quantity integer, restock_type text, amount integer);

  -- 13. 記録。計算との差 = 返金額 − （行の額の合計 + 送料）。行の無い返金では返金額そのもの
  BEGIN
    INSERT INTO public.order_refunds AS r
      (order_id, source, request_key, request_fingerprint, status, amount, shipping_amount, adjustment_amount,
       note, stripe_reason, cancel_reason, notify_customer, actor_id)
    VALUES
      (_order_id, _source, _request_key, v_fingerprint, 'awaiting_response', v_amount, v_shipping,
       v_amount - (v_lines_amount + v_shipping), v_note, v_stripe_reason, v_cancel_reason, v_notify, v_actor)
    RETURNING r.id INTO v_refund_id;
  EXCEPTION WHEN unique_violation THEN
    -- 同じ番号をほかの注文の返金が同時に使った（同じ注文の送り直しは、鍵の後の確かめで前の記録を返している）
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_refunds_request_key_key' THEN
      RAISE EXCEPTION 'REFUND_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  INSERT INTO public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
  SELECT v_refund_id, x.order_item_id, x.quantity, x.before_shipment, x.restock_type, x.amount
  FROM pg_catalog.jsonb_to_recordset(v_priced)
    AS x(order_item_id uuid, before_shipment boolean, quantity integer, restock_type text, amount integer);

  RETURN QUERY SELECT v_refund_id, v_amount, 'awaiting_response'::text, false;
END;
$$;

-- 3. 返金を1件読む（見回りと取り込みが、記録の状態・注文の支払いの番号・Stripe に頼み直す時の理由と実行した人・
--    エラーにした理由を知るため）
CREATE OR REPLACE FUNCTION public.get_order_refund(_refund_id uuid)
RETURNS TABLE (
  refund_id uuid,
  order_id uuid,
  source text,
  status text,
  stripe_refund_id text,
  amount integer,
  payment_intent_id text,
  created_at timestamptz,
  stripe_reason text,
  actor_id uuid,
  stripe_failure_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.id, r.order_id, r.source, r.status, r.stripe_refund_id, r.amount, o.payment_intent_id, r.created_at,
         r.stripe_reason, r.actor_id, r.stripe_failure_reason
  FROM public.order_refunds AS r
  JOIN public.orders AS o ON o.id = r.order_id
  WHERE r.id = _refund_id
$$;

-- 4. 返金の画面の材料（設計書 5-2）。注文の金額・返せる額・返事待ちの返金・商品ごとの数と割り振った割引を、1回で返す。
--    商品の名前・色・サイズと支払い方法は、アプリが別に読む。商品は注文の登録順（created_at、同じ時刻は id）
CREATE OR REPLACE FUNCTION public.load_order_refund_materials(_order_id uuid)
RETURNS TABLE (
  order_id uuid,
  order_status public.order_status,
  total_amount integer,
  shipping_amount integer,
  discount_amount integer,
  paid_amount integer,
  succeeded_amount integer,
  open_amount integer,
  refundable_amount integer,
  refunded_shipping integer,
  refundable_shipping integer,
  shipped_total integer,
  unshipped_total integer,
  awaiting_refund_id uuid,
  awaiting_refund_amount integer,
  awaiting_refund_created_at timestamptz,
  lines jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.id,
         o.status,
         o.total_amount,
         o.shipping_amount,
         o.discount_amount,
         a.paid_amount,
         a.succeeded_amount,
         a.open_amount,
         a.refundable_amount,
         a.refunded_shipping,
         a.refundable_shipping,
         c.shipped_total,
         c.unshipped_total,
         w.id,
         w.amount,
         w.created_at,
         c.lines
  FROM public.orders AS o
  CROSS JOIN LATERAL private.order_refund_amounts(o.id) AS a
  CROSS JOIN LATERAL (
    SELECT COALESCE(pg_catalog.sum(f.shipped), 0)::integer AS shipped_total,
           COALESCE(pg_catalog.sum(f.unshipped), 0)::integer AS unshipped_total,
           COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'order_item_id', f.order_item_id,
                 'fulfillment_type', f.fulfillment_type,
                 'item_price', oi.item_price,
                 'quantity', f.quantity,
                 'line_total', oi.line_total,
                 'shipped', f.shipped,
                 'unshipped', f.unshipped,
                 'refunded_before_shipment', f.refunded_before_shipment,
                 'refunded_after_shipment', f.refunded_after_shipment,
                 'shipped_refundable', f.shipped - f.refunded_after_shipment,
                 -- 在庫に戻せる数は、確保している数まで。確保の記録が無い古い商品（R-41）と受注生産は0
                 'restockable', CASE
                   WHEN f.fulfillment_type = 'stock' THEN LEAST(f.unshipped, GREATEST(r.reserved - f.shipped, 0))
                   ELSE 0
                 END,
                 'line_discount', d.line_discount,
                 'refunded_units', f.refunded_before_shipment + f.refunded_after_shipment
               )
               ORDER BY oi.created_at, oi.id
             ),
             '[]'::jsonb
           ) AS lines
    FROM private.order_line_fulfillment(o.id) AS f
    JOIN public.order_items AS oi ON oi.id = f.order_item_id
    JOIN private.order_line_reservations(o.id) AS r ON r.order_item_id = f.order_item_id
    JOIN private.order_line_discounts(o.id) AS d ON d.order_item_id = f.order_item_id
  ) AS c
  LEFT JOIN LATERAL (
    SELECT ar.id, ar.amount, ar.created_at
    FROM public.order_refunds AS ar
    WHERE ar.order_id = o.id
      AND ar.status = 'awaiting_response'
    ORDER BY ar.created_at DESC, ar.id DESC
    LIMIT 1
  ) AS w ON true
  WHERE o.id = _order_id
$$;

-- 5. 注文の返金を新しい順に（管理画面の履歴とお客様の画面が使う）。商品の行は商品の番号の昇順、同じ商品は発送前が先
CREATE OR REPLACE FUNCTION public.list_order_refunds(_order_id uuid)
RETURNS TABLE (
  refund_id uuid,
  source text,
  status text,
  stripe_status text,
  stripe_pending_reason text,
  stripe_failure_reason text,
  customer_action_expires_at timestamptz,
  payment_method_type text,
  amount integer,
  shipping_amount integer,
  adjustment_amount integer,
  note text,
  stripe_reason text,
  cancel_reason text,
  notify_customer boolean,
  actor_email text,
  reference_number text,
  reference_type text,
  created_at timestamptz,
  accepted_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  errored_at timestamptz,
  lines jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.id,
         r.source,
         r.status,
         r.stripe_status,
         r.stripe_pending_reason,
         r.stripe_failure_reason,
         r.customer_action_expires_at,
         r.payment_method_type,
         r.amount,
         r.shipping_amount,
         r.adjustment_amount,
         r.note,
         r.stripe_reason,
         r.cancel_reason,
         r.notify_customer,
         u.email::text,
         r.reference_number,
         r.reference_type,
         r.created_at,
         r.accepted_at,
         r.succeeded_at,
         r.failed_at,
         r.errored_at,
         COALESCE((
           SELECT pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                      'order_item_id', l.order_item_id,
                      'quantity', l.quantity,
                      'before_shipment', l.before_shipment,
                      'restock_type', l.restock_type,
                      'amount', l.amount,
                      'released_quantity', l.released_quantity,
                      'restocked_quantity', l.restocked_quantity,
                      'rereserved_quantity', l.rereserved_quantity,
                      'rereserve_shortage', l.rereserve_shortage
                    )
                    ORDER BY l.order_item_id, l.before_shipment DESC
                  )
           FROM public.order_refund_lines AS l
           WHERE l.refund_id = r.id
         ), '[]'::jsonb)
  FROM public.order_refunds AS r
  LEFT JOIN auth.users AS u ON u.id = r.actor_id
  WHERE r.order_id = _order_id
  ORDER BY r.created_at DESC, r.id DESC
$$;

-- 6. 毎時の見回りが確かめる、返事待ちの返金（古い順。件数は1〜200に丸める）
CREATE OR REPLACE FUNCTION public.list_awaiting_order_refunds(_older_than timestamptz, _limit integer)
RETURNS TABLE (refund_id uuid, order_id uuid, payment_intent_id text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.id, r.order_id, o.payment_intent_id, r.created_at
  FROM public.order_refunds AS r
  JOIN public.orders AS o ON o.id = r.order_id
  WHERE r.status = 'awaiting_response'
    AND r.created_at < _older_than
  ORDER BY r.created_at, r.id
  LIMIT LEAST(GREATEST(COALESCE(_limit, 50), 1), 200)
$$;

-- 7. 毎晩の照合が合わせる、保留の返金がある注文の支払いの番号（重複なし。古い保留から。件数は1〜500に丸める）
CREATE OR REPLACE FUNCTION public.list_pending_refund_payment_intents(_limit integer)
RETURNS TABLE (payment_intent_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.payment_intent_id
  FROM public.order_refunds AS r
  JOIN public.orders AS o ON o.id = r.order_id
  WHERE r.status = 'pending'
    AND o.payment_intent_id IS NOT NULL
  GROUP BY o.payment_intent_id
  ORDER BY pg_catalog.min(r.created_at), o.payment_intent_id
  LIMIT LEAST(GREATEST(COALESCE(_limit, 50), 1), 500)
$$;

-- 8. ショップの設定（設計書 9-6）。最後に変えた人のメールは auth.users から読む
CREATE OR REPLACE FUNCTION public.get_shop_settings()
RETURNS TABLE (
  auto_refund_cancelled_order_payment boolean,
  auto_refund_cancelled_order_payment_updated_by_email text,
  auto_refund_cancelled_order_payment_updated_at timestamptz,
  auto_cancel_amount_mismatch boolean,
  auto_cancel_amount_mismatch_updated_by_email text,
  auto_cancel_amount_mismatch_updated_at timestamptz,
  refund_ledger_started_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.auto_refund_cancelled_order_payment,
         u1.email::text,
         s.auto_refund_cancelled_order_payment_updated_at,
         s.auto_cancel_amount_mismatch,
         u2.email::text,
         s.auto_cancel_amount_mismatch_updated_at,
         l.started_at
  FROM public.shop_settings AS s
  CROSS JOIN private.refund_ledger_state AS l
  LEFT JOIN auth.users AS u1 ON u1.id = s.auto_refund_cancelled_order_payment_updated_by
  LEFT JOIN auth.users AS u2 ON u2.id = s.auto_cancel_amount_mismatch_updated_by
  WHERE s.id = 1
    AND l.id = 1
$$;

-- 変わったトグルだけ、その更新者と時刻を書く（変わらない方は書き換えない）。答えは get_shop_settings と同じ
CREATE OR REPLACE FUNCTION public.admin_update_shop_settings(
  _auto_refund_cancelled_order_payment boolean,
  _auto_cancel_amount_mismatch boolean,
  _actor_id uuid
)
RETURNS TABLE (
  auto_refund_cancelled_order_payment boolean,
  auto_refund_cancelled_order_payment_updated_by_email text,
  auto_refund_cancelled_order_payment_updated_at timestamptz,
  auto_cancel_amount_mismatch boolean,
  auto_cancel_amount_mismatch_updated_by_email text,
  auto_cancel_amount_mismatch_updated_at timestamptz,
  refund_ledger_started_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF _auto_refund_cancelled_order_payment IS NULL
     OR _auto_cancel_amount_mismatch IS NULL
     OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE public.shop_settings AS s
  SET auto_refund_cancelled_order_payment = _auto_refund_cancelled_order_payment,
      auto_refund_cancelled_order_payment_updated_by = CASE
        WHEN s.auto_refund_cancelled_order_payment IS DISTINCT FROM _auto_refund_cancelled_order_payment THEN _actor_id
        ELSE s.auto_refund_cancelled_order_payment_updated_by
      END,
      auto_refund_cancelled_order_payment_updated_at = CASE
        WHEN s.auto_refund_cancelled_order_payment IS DISTINCT FROM _auto_refund_cancelled_order_payment THEN pg_catalog.now()
        ELSE s.auto_refund_cancelled_order_payment_updated_at
      END,
      auto_cancel_amount_mismatch = _auto_cancel_amount_mismatch,
      auto_cancel_amount_mismatch_updated_by = CASE
        WHEN s.auto_cancel_amount_mismatch IS DISTINCT FROM _auto_cancel_amount_mismatch THEN _actor_id
        ELSE s.auto_cancel_amount_mismatch_updated_by
      END,
      auto_cancel_amount_mismatch_updated_at = CASE
        WHEN s.auto_cancel_amount_mismatch IS DISTINCT FROM _auto_cancel_amount_mismatch THEN pg_catalog.now()
        ELSE s.auto_cancel_amount_mismatch_updated_at
      END
  WHERE s.id = 1;

  RETURN QUERY SELECT g.* FROM public.get_shop_settings() AS g;
END;
$$;

-- 9. 取り消した注文に入金が届いた時の、受け取った額と支払いの番号を注文に書く（設計書 4-3、本計画 P27）。
--    照合が要対応「取り消した注文への入金」を記録するたびに、自動の返金①より先に呼ぶ（①のオン・オフに依らない）。
--    これが無いと、①がオフの時や、①が始める前に断られた時（注文に支払いの番号が無い）に受け取った額が空のまま残り、
--    管理画面の返金（ア）が ORDER_NOT_REFUNDABLE になって、店への知らせが言う操作ができない。
--    取り消した注文で受け取った額が空の時だけ書き、書いたかを返す。何度呼んでも同じ。
--    支払いの番号は空の時だけ書く（法定の不変条件 protect_legal_order_immutable_fields は、支払いの番号の空から値への
--    1回だけを許し、ほかの列と配送先・状態の守りには触れない）。注文に別の支払いの番号があれば、別の支払いの入金かもしれないので何も書かない。
--    別の注文が同じ支払いの番号を持っていれば、一意制約の誤り（23505）をそのまま返す（握りつぶさない）
CREATE OR REPLACE FUNCTION public.record_cancelled_order_paid_amount(
  _order_id uuid,
  _payment_intent_id text,
  _received_amount integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
BEGIN
  IF _order_id IS NULL
     OR _received_amount IS NULL
     OR _received_amount < 1
     OR _payment_intent_id IS NULL
     OR _payment_intent_id !~ '^pi_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 取り消していない注文・書き済みの注文・別の支払いの番号がある注文には、何も書かない
  IF v_order.status <> 'cancelled'::public.order_status
     OR v_order.paid_amount IS NOT NULL
     OR (v_order.payment_intent_id IS NOT NULL AND v_order.payment_intent_id <> _payment_intent_id) THEN
    RETURN false;
  END IF;

  -- 前の取引の値が残らないように、操作した人と元の知らせの番号は空にする
  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'record_cancelled_order_payment', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  UPDATE public.orders AS o
  SET paid_amount = _received_amount,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id)
  WHERE o.id = _order_id;

  RETURN true;
END;
$$;

-- 10. 発送の取消（設計書 7-3・7-5）。今の本文（E-1 の移行 B 20261010122320_fulfillment_order_emails.sql の 10.）のまま、取り消す前に
--    「取り消した後の発送した数が、発送後に返金した数を下回る商品」を断る守りを足す（FULFILLMENT_REFUNDED）。
--    発送済みから決済完了に戻す判定は、返金を入れた未発送の数（private.order_line_fulfillment の unshipped）で行う今の式のまま
CREATE OR REPLACE FUNCTION public.admin_cancel_fulfillment(_order_id uuid, _fulfillment_id uuid, _actor_id uuid)
RETURNS TABLE (outcome text, order_status public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_status public.order_status;
  v_cancelled_at timestamptz;
  v_unshipped integer;
BEGIN
  IF _order_id IS NULL OR _fulfillment_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'FULFILLMENT_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT f.cancelled_at INTO v_cancelled_at
  FROM public.order_fulfillments AS f
  WHERE f.id = _fulfillment_id
    AND f.order_id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FULFILLMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_cancelled_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_cancelled'::text, v_status;
    RETURN;
  END IF;

  -- 取り消した注文（返金で取り消した注文を含む）の発送は戻さない（E-3 で、返品に使われた発送を拒む条件を足す）
  IF v_status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status) THEN
    RAISE EXCEPTION 'FULFILLMENT_CANCEL_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  -- 発送後に返金した商品の発送は取り消せない。取り消すと、返金した数を発送した数が下回ってしまう（返事待ちの返金も数える）
  IF EXISTS (
    SELECT 1
    FROM public.order_fulfillment_lines AS fl
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = fl.order_item_id
    WHERE fl.fulfillment_id = _fulfillment_id
      AND l.shipped - fl.quantity < l.refunded_after_shipment
  ) THEN
    RAISE EXCEPTION 'FULFILLMENT_REFUNDED' USING ERRCODE = '22023';
  END IF;

  UPDATE public.order_fulfillments AS f
  SET cancelled_at = pg_catalog.now(),
      cancelled_by = _actor_id
  WHERE f.id = _fulfillment_id;

  SELECT COALESCE(pg_catalog.sum(l.unshipped), 0)::integer INTO v_unshipped
  FROM private.order_line_fulfillment(_order_id) AS l;

  -- 未発送の品が戻ったら、注文を決済完了に戻す（発送の列は「全部を送った時の値」なので空にする）
  IF v_status = 'shipped'::public.order_status AND v_unshipped > 0 THEN
    PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
    PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_cancel_fulfillment', true);
    UPDATE public.orders AS o
    SET status = 'paid'::public.order_status,
        shipped_at = NULL,
        shipping_carrier = NULL,
        tracking_number = NULL
    WHERE o.id = _order_id;
    v_status := 'paid'::public.order_status;
  END IF;

  -- まだ送っていない発送のメール（送る前・やり直し待ち）は取りやめる。
  -- 送っている途中の行は、worker が中身を作る時に取消を見て取りやめる
  UPDATE private.order_email_outbox AS e
  SET status = 'skipped',
      finished_at = pg_catalog.now(),
      subject = NULL,
      body_text = NULL,
      body_erased_at = CASE WHEN e.subject IS NOT NULL THEN pg_catalog.now() ELSE e.body_erased_at END,
      last_error_code = 'fulfillment_cancelled'
  WHERE e.fulfillment_id = _fulfillment_id
    AND e.status IN ('pending', 'retry_wait');

  RETURN QUERY SELECT 'cancelled'::text, v_status;
END;
$$;

-- 11. 権限。新しい関数は service_role だけ。private の関数は PUBLIC から外すだけ
REVOKE ALL ON FUNCTION private.parse_refund_lines(jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.begin_order_refund(uuid, text, uuid, jsonb, boolean, integer, integer, text, text, text, boolean, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_refund(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_order_refund_materials(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_refunds(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_awaiting_order_refunds(timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_pending_refund_payment_intents(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_shop_settings() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_update_shop_settings(boolean, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_cancelled_order_paid_amount(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_cancel_fulfillment(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_order_refund(uuid, text, uuid, jsonb, boolean, integer, integer, text, text, text, boolean, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_refund(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_order_refund_materials(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_refunds(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_awaiting_order_refunds(timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_pending_refund_payment_intents(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_shop_settings() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_shop_settings(boolean, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_cancelled_order_paid_amount(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_fulfillment(uuid, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
