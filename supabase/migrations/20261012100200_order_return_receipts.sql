BEGIN;
-- 受け取りの行は追記専用なので、返金番号を INSERT 時に確定する。
-- 同じ取引に入る返金の番号を先に書き、確定時に参照先の実在を検査する。
DO $$
DECLARE v_name text;
BEGIN
  SELECT c.conname INTO STRICT v_name FROM pg_catalog.pg_constraint AS c
  JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.conrelid AND a.attname='refund_id'
  WHERE c.conrelid='public.order_return_receipts'::regclass AND c.contype='f'
    AND c.confrelid='public.order_refunds'::regclass AND c.conkey=ARRAY[a.attnum];
  EXECUTE pg_catalog.format('ALTER TABLE public.order_return_receipts ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',v_name);
END;
$$;

-- 返品の返金で引いた手数料（P26）。受け取りの今返金は min(付いた手数料, 商品の額)、額を決めて返金は
-- min(fee_pending_deduction, 商品の額)。返金がエラー・失敗になった時に、返品の fee_pending_deduction へ戻す。
-- 引いた手数料は0以上。ほかの道の記録は0。列を省いた直接 INSERT も既定の0になる。道と結ぶ CHECK は作らない。
-- 作った後は変えない（E-2 の守りが、ほかの列と同じに止める）
ALTER TABLE public.order_refunds
  ADD COLUMN return_fee_deduction integer NOT NULL DEFAULT 0 CHECK (return_fee_deduction >= 0);

-- 交換の行を割引の分母と最後の行の判定から外す。JOIN する既存の読出しのため、交換の行にも割引0の1行を返す。
CREATE OR REPLACE FUNCTION private.order_line_discounts(_order_id uuid)
RETURNS TABLE (order_item_id uuid, line_discount integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH lines AS (
    SELECT oi.id,
           pg_catalog.row_number() OVER (ORDER BY oi.created_at, oi.id) AS line_no,
           pg_catalog.count(*) OVER () AS line_count,
           (pg_catalog.sum(oi.line_total) OVER (
             ORDER BY oi.created_at, oi.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ))::bigint AS running_total,
           (pg_catalog.sum(oi.line_total) OVER ())::bigint AS lines_total
    FROM public.order_items AS oi
    WHERE oi.order_id = _order_id AND oi.line_kind = 'order'
  ),
  rounded AS (
    SELECT l.id,
           l.line_no,
           CASE
             WHEN l.lines_total = 0 THEN
               CASE WHEN l.line_no = l.line_count THEN o.discount_amount::bigint ELSE 0::bigint END
             ELSE (2 * o.discount_amount::bigint * l.running_total + l.lines_total) / (2 * l.lines_total)
           END AS cumulative_discount
    FROM lines AS l
    CROSS JOIN public.orders AS o
    WHERE o.id = _order_id
  )
  SELECT r.id,
         (r.cumulative_discount - pg_catalog.lag(r.cumulative_discount, 1, 0::bigint) OVER (ORDER BY r.line_no))::integer
  FROM rounded AS r
  UNION ALL
  SELECT oi.id, 0 FROM public.order_items AS oi
  WHERE oi.order_id = _order_id AND oi.line_kind = 'exchange'
$$;

-- 返金の数と割引、交換の元の支払額の額。式は Task 2 の private.return_refund_amount（画面の見込み refund_amounts_by_count と
-- 同じ式。P8）を使い、ここは注文の商品の値と、前に返した数（返事待ち・保留・成功）に呼ぶ側の数を足した数を渡すだけ
CREATE OR REPLACE FUNCTION private.return_units_amount(_order_item_id uuid,_quantity integer,_offset integer DEFAULT 0)
RETURNS integer LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT private.return_refund_amount(oi.line_kind, oi.item_price, oi.quantity, d.line_discount, oi.exchange_paid_amount,
           f.refunded_before_shipment + f.refunded_after_shipment + _offset, _quantity)
  FROM public.order_items AS oi
  JOIN private.order_line_fulfillment(oi.order_id) AS f ON f.order_item_id=oi.id
  JOIN private.order_line_discounts(oi.order_id) AS d ON d.order_item_id=oi.id
  WHERE oi.id=_order_item_id
$$;

-- E-2 の public の引数・戻り値を保ったまま、検証と INSERT を1か所に集める。
CREATE OR REPLACE FUNCTION private.begin_order_refund_core(
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
  _received_amount integer,
  _return_id uuid,
  _return_fee_deduction integer
)
RETURNS TABLE (refund_id uuid, amount integer, status text, replayed boolean)
LANGUAGE plpgsql
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
     OR _source NOT IN ('admin', 'order_cancel', 'auto_cancelled_order_payment', 'auto_amount_mismatch', 'return')
     OR ((_source = 'return') IS DISTINCT FROM (_return_id IS NOT NULL))
     OR (_source = 'return' AND (_return_fee_deduction IS NULL OR _return_fee_deduction < 0))
     OR (_source <> 'return' AND _return_fee_deduction IS NOT NULL)
     OR _lines IS NULL
     OR _restock IS NULL
     OR _notify_customer IS NULL THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_is_admin := _source IN ('admin', 'return');
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

  -- 返品の入力の指紋は、受け取りは追記済みの受け取り、単独の返金は入力そのものを使う。
  -- _received_amount は return の内部呼出しだけ、計算前の任意の額（NULLも含む）を保持する。
  IF _source = 'return' THEN
    PERFORM 1 FROM public.order_returns AS r WHERE r.id=_return_id AND r.order_id=_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    SELECT rr.request_fingerprint INTO v_fingerprint FROM public.order_return_receipts AS rr
    WHERE rr.request_key=_request_key AND rr.return_id=_return_id AND rr.kind='receive';
    IF NOT FOUND THEN
      v_fingerprint:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'amount',_received_amount,
        'shipping_amount',_shipping_amount,'note',_note,'notify_customer',_notify_customer)::text);
    END IF;
  END IF;

  -- 3. 同じ二重防止の番号の送り直し（通信が切れた後の「もう一度確かめる」）。同じ中身なら前の記録を返し、
  --    注文の状態や数が変わっていても確かめ直さない。中身が違えば断る
  IF _request_key IS NOT NULL THEN
    SELECT r.* INTO v_existing FROM public.order_refunds AS r WHERE r.request_key = _request_key;
    IF FOUND THEN
      IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION USING MESSAGE=CASE WHEN _source='return' THEN 'RETURN_REQUEST_MISMATCH' ELSE 'REFUND_REQUEST_MISMATCH' END, ERRCODE='22023';
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
    JOIN private.order_line_return_counts(_order_id) AS l ON l.order_item_id = p.order_item_id
    WHERE NOT p.before_shipment AND _source <> 'return'
      AND p.quantity > l.refundable_after_shipment
  ) THEN
    RAISE EXCEPTION 'REFUND_QUANTITY_EXCEEDS_SHIPPED' USING ERRCODE = '22023';
  END IF;

  -- 返品の返金は、受け取った返金の品で覆われていない数まで。発送前には使わせない。
  IF _source='return' AND EXISTS (
    SELECT 1 FROM private.parse_refund_lines(v_resolved) AS p
    WHERE p.before_shipment OR p.quantity > COALESCE((
      SELECT pg_catalog.sum(g.refund_waiting)::integer
      FROM private.order_return_line_progress(_return_id) AS g
      JOIN public.order_return_lines AS rl ON rl.id=g.return_line_id
      WHERE rl.order_item_id=p.order_item_id
    ),0)
  ) THEN RAISE EXCEPTION 'RETURN_RECEIPT_EXCEEDS' USING ERRCODE='22023'; END IF;

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
                 WHEN _source='return' THEN 'return'::text
                 WHEN q.before_shipment AND q.fulfillment_type = 'stock' AND v_restock THEN 'cancel'::text
                 ELSE 'no_restock'::text
               END,
               'amount', private.return_units_amount(q.order_item_id,q.quantity,q.earlier_in_refund)
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
      (id, return_id, order_id, source, request_key, request_fingerprint, status, amount, shipping_amount, adjustment_amount,
       note, stripe_reason, cancel_reason, notify_customer, actor_id, return_fee_deduction)
    VALUES
      (COALESCE((SELECT rr.refund_id FROM public.order_return_receipts AS rr WHERE rr.return_id=_return_id AND rr.request_key=_request_key),pg_catalog.gen_random_uuid()),
       _return_id, _order_id, _source, _request_key, v_fingerprint, 'awaiting_response', v_amount, v_shipping,
       v_amount - (v_lines_amount + v_shipping), v_note, v_stripe_reason, v_cancel_reason, v_notify, v_actor, COALESCE(_return_fee_deduction, 0))
    RETURNING r.id INTO v_refund_id;
  EXCEPTION WHEN unique_violation THEN
    -- 同じ番号をほかの注文の返金が同時に使った（同じ注文の送り直しは、鍵の後の確かめで前の記録を返している）
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_refunds_request_key_key' THEN
      RAISE EXCEPTION USING MESSAGE=CASE WHEN _source='return' THEN 'RETURN_REQUEST_MISMATCH' ELSE 'REFUND_REQUEST_MISMATCH' END, ERRCODE='22023';
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

CREATE OR REPLACE FUNCTION public.begin_order_refund(
  _order_id uuid, _source text, _request_key uuid, _lines jsonb, _restock boolean,
  _shipping_amount integer, _amount integer, _note text, _stripe_reason text, _cancel_reason text,
  _notify_customer boolean, _actor_id uuid, _received_amount integer DEFAULT NULL
) RETURNS TABLE (refund_id uuid, amount integer, status text, replayed boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT * FROM private.begin_order_refund_core(_order_id,_source,_request_key,_lines,_restock,_shipping_amount,
    _amount,_note,_stripe_reason,_cancel_reason,_notify_customer,_actor_id,_received_amount,NULL::uuid,NULL::integer)
$$;


-- 画面に渡す数と core の上限が同じになるよう、返品の数の関数を使う。
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
                 'exchange_paid_amount', oi.exchange_paid_amount,
                 'shipped', f.shipped,
                 'unshipped', f.unshipped,
                 'refunded_before_shipment', f.refunded_before_shipment,
                 'refunded_after_shipment', f.refunded_after_shipment,
                 'shipped_refundable', rc.refundable_after_shipment,
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
    JOIN private.order_line_return_counts(o.id) AS rc ON rc.order_item_id=f.order_item_id
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

-- 引数は E-2 の5つのまま。返品番号と同時受け取りの番号は返金から引く。
CREATE OR REPLACE FUNCTION private.enqueue_order_email(
  _order_id uuid,
  _kind text,
  _variant text DEFAULT NULL,
  _fulfillment_id uuid DEFAULT NULL,
  _refund_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_return uuid; v_receipt uuid;
BEGIN
  SELECT r.return_id INTO v_return FROM public.order_refunds AS r WHERE r.id=_refund_id;
  SELECT rr.id INTO v_receipt FROM public.order_return_receipts AS rr WHERE rr.refund_id=_refund_id;
  IF _kind = 'shipped' THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id, return_id, return_receipt_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id, v_return, v_receipt)
    ON CONFLICT (fulfillment_id) WHERE origin = 'auto' AND kind = 'shipped' DO NOTHING;
  ELSIF _refund_id IS NOT NULL THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id, return_id, return_receipt_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id, v_return, v_receipt)
    ON CONFLICT (refund_id, kind) WHERE origin = 'auto' AND refund_id IS NOT NULL DO NOTHING;
  ELSE
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id, return_id, return_receipt_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id, v_return, v_receipt)
    ON CONFLICT (order_id, kind)
      WHERE origin = 'auto' AND kind <> 'shipped' AND refund_id IS NULL
        AND kind NOT IN ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop')
      DO NOTHING;
  END IF;
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.claim_order_email(integer);
CREATE OR REPLACE FUNCTION public.claim_order_email(_lease_seconds integer)
RETURNS TABLE (
  email_id uuid,
  order_id uuid,
  kind text,
  variant text,
  origin text,
  attempts integer,
  lease_token uuid,
  subject text,
  body_text text,
  payment_expired_sent boolean,
  fulfillment_id uuid,
  refund_id uuid,
  return_id uuid,
  return_receipt_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_paused boolean;
  v_next_probe_at timestamptz;
BEGIN
  IF _lease_seconds IS NULL OR _lease_seconds < 30 OR _lease_seconds > 900 THEN
    RAISE EXCEPTION 'INVALID_LEASE_SECONDS' USING ERRCODE = '22023';
  END IF;

  UPDATE private.order_email_outbox AS e
  SET status = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN 'dead' ELSE 'retry_wait' END,
      finished_at = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN pg_catalog.now() END,
      subject = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN NULL ELSE e.subject END,
      body_text = CASE WHEN e.attempts >= private.order_email_max_attempts() THEN NULL ELSE e.body_text END,
      body_erased_at = CASE
        WHEN e.attempts >= private.order_email_max_attempts() AND e.subject IS NOT NULL THEN pg_catalog.now()
        ELSE e.body_erased_at
      END,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = 'lease_expired',
      next_attempt_at = pg_catalog.now() + private.order_email_retry_delay(e.attempts)
  WHERE e.status = 'sending'
    AND e.lease_expires_at <= pg_catalog.now();

  -- 止めていない間は一時停止の行をロックしない（同時に動く worker の取り出しを待たせない）
  SELECT p.paused INTO v_paused FROM private.order_email_send_pause AS p WHERE p.id;
  IF v_paused THEN
    SELECT p.paused, p.next_probe_at INTO v_paused, v_next_probe_at
    FROM private.order_email_send_pause AS p
    WHERE p.id
    FOR UPDATE;

    IF v_paused THEN
      IF v_next_probe_at > pg_catalog.now() THEN
        RETURN;
      END IF;
      UPDATE private.order_email_send_pause AS p
      SET next_probe_at = pg_catalog.now() + interval '15 minutes',
          updated_at = pg_catalog.now()
      WHERE p.id;
    END IF;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
    FROM private.order_email_outbox AS e
    WHERE e.status IN ('pending', 'retry_wait')
      AND e.next_attempt_at <= pg_catalog.now()
      AND NOT EXISTS (
        SELECT 1
        FROM private.order_email_outbox AS earlier
        WHERE earlier.order_id = e.order_id
          AND earlier.seq < e.seq
          AND earlier.status IN ('pending', 'sending', 'retry_wait')
      )
    ORDER BY e.next_attempt_at, e.seq
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ),
  claimed AS (
    UPDATE private.order_email_outbox AS e
    SET status = 'sending',
        attempts = e.attempts + 1,
        lease_token = pg_catalog.gen_random_uuid(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => _lease_seconds),
        last_error_code = NULL
    FROM candidate AS c
    WHERE e.id = c.id
    RETURNING e.id, e.order_id, e.kind, e.variant, e.origin, e.attempts, e.lease_token, e.subject, e.body_text,
              e.fulfillment_id, e.refund_id, e.return_id, e.return_receipt_id
  )
  SELECT c.id, c.order_id, c.kind, c.variant, c.origin, c.attempts, c.lease_token, c.subject, c.body_text,
         EXISTS (
           SELECT 1
           FROM private.order_email_outbox AS x
           WHERE x.order_id = c.order_id
             AND x.kind = 'payment_expired'
             AND x.status = 'sent'
         ),
         c.fulfillment_id,
         c.refund_id, c.return_id, c.return_receipt_id
  FROM claimed AS c;
END;
$$;

DROP FUNCTION IF EXISTS public.list_order_email_history(uuid);
CREATE OR REPLACE FUNCTION public.list_order_email_history(_order_id uuid)
RETURNS TABLE (
  email_id uuid,
  kind text,
  variant text,
  origin text,
  requested_by_email text,
  status text,
  attempts integer,
  last_error_code text,
  delivery_status text,
  delivery_event_at timestamptz,
  created_at timestamptz,
  sent_at timestamptz,
  finished_at timestamptz,
  has_body boolean,
  body_erased boolean,
  fulfillment_id uuid,
  fulfillment_number integer,
  refund_id uuid,
  return_id uuid,
  return_receipt_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.kind, e.variant, e.origin, u.email::text, e.status, e.attempts, e.last_error_code,
         e.delivery_status, e.delivery_event_at, e.created_at, e.sent_at, e.finished_at,
         e.body_text IS NOT NULL, e.body_erased_at IS NOT NULL,
         e.fulfillment_id, f.number, e.refund_id, e.return_id, e.return_receipt_id
  FROM private.order_email_outbox AS e
  LEFT JOIN auth.users AS u ON u.id = e.requested_by
  LEFT JOIN public.order_fulfillments AS f ON f.id = e.fulfillment_id
  WHERE e.order_id = _order_id
  ORDER BY e.seq DESC
$$;

-- 新しい種類は入力として受けるが、既存の許可状態の表には入れず RESEND_NOT_ALLOWED で断る。
CREATE OR REPLACE FUNCTION public.request_order_email_resend(
  _order_id uuid,
  _kind text,
  _actor_id uuid,
  _fulfillment_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status public.order_status;
  v_variant text;
  v_refund_id uuid;
  v_found boolean;
  v_email_id uuid;
BEGIN
  IF _order_id IS NULL OR _kind IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RESEND_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF _kind NOT IN ('paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped', 'refund','return_accepted','return_received','return_sent_back','return_refund_pending_shop') THEN
    RAISE EXCEPTION 'INVALID_EMAIL_KIND' USING ERRCODE = '22023';
  END IF;
  -- 発送のメールは発送ごとに送るので、どの発送かが要る
  IF _kind = 'shipped' AND _fulfillment_id IS NULL THEN
    RAISE EXCEPTION 'RESEND_FULFILLMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 発送のメールは、一部だけ送った決済完了の注文でも再送できる。返金のお知らせはどの状態でも再送できない
  IF NOT (
    (_kind = 'paid' AND v_status IN ('paid', 'shipped'))
    OR (_kind = 'awaiting_payment' AND v_status = 'pending')
    OR (_kind = 'payment_expired' AND v_status = 'failed')
    OR (_kind = 'canceled' AND v_status = 'cancelled')
    OR (_kind = 'shipped' AND v_status IN ('paid', 'shipped'))
  ) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  -- 発送の番号は発送のメールだけに付く。その注文の、取り消していない発送だけ
  IF (_kind <> 'shipped' AND _fulfillment_id IS NOT NULL)
     OR (_kind = 'shipped' AND NOT EXISTS (
       SELECT 1
       FROM public.order_fulfillments AS f
       WHERE f.id = _fulfillment_id
         AND f.order_id = _order_id
         AND f.cancelled_at IS NULL
     )) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  -- 失敗・エラーになった返金の行から写すと、お金が戻らない文のメールが届く。そういう行は写す元にしない（設計書 8-2）
  SELECT e.variant, e.refund_id, true INTO v_variant, v_refund_id, v_found
  FROM private.order_email_outbox AS e
  WHERE e.order_id = _order_id
    AND e.kind = _kind
    AND e.fulfillment_id IS NOT DISTINCT FROM _fulfillment_id
    AND e.status IN ('sent', 'dead')
    AND (e.refund_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.order_refunds AS r
      WHERE r.id = e.refund_id
        AND r.status IN ('failed', 'error')
    ))
  ORDER BY e.seq DESC
  LIMIT 1;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, requested_by, fulfillment_id, refund_id)
    VALUES (_order_id, _kind, v_variant, 'manual', _actor_id, _fulfillment_id, v_refund_id)
    RETURNING id INTO v_email_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'RESEND_ALREADY_QUEUED' USING ERRCODE = '23505';
  END;

  RETURN v_email_id;
END;
$$;

-- 返品の種類は取りやめない。ただし店への返金待ちの知らせは、その返品の返金待ちが0なら superseded にできる。
CREATE OR REPLACE FUNCTION public.skip_order_email(_email_id uuid, _lease_token uuid, _reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _reason IS NULL OR _reason NOT IN ('superseded', 'no_recipient', 'fulfillment_cancelled') THEN
    RAISE EXCEPTION 'INVALID_SKIP_REASON' USING ERRCODE = '22023';
  END IF;

  -- 取りやめ（superseded）は入金待ちと支払い期限切れ、返金が失敗・エラーになった返金の行、または返金待ちが0の店への知らせだけ。
  -- 入金済み・取消・発送、返金が失敗・エラーでない返金の行は、その時の事実を伝えるので取りやめない
  IF _reason = 'superseded' AND EXISTS (
    SELECT 1
    FROM private.order_email_outbox AS e
    WHERE e.id = _email_id
      AND e.kind NOT IN ('awaiting_payment', 'payment_expired')
      AND NOT (
        e.kind = 'return_refund_pending_shop'
        AND e.return_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM private.order_return_line_progress(e.return_id) AS g WHERE g.refund_waiting > 0
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_refunds AS r
        WHERE r.id = e.refund_id
          AND r.status IN ('failed', 'error')
      )
  ) THEN
    RAISE EXCEPTION 'SUPERSEDE_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  -- 発送の取消による取りやめは、取り消した発送の発送のメールだけ（worker の思い違いで、送るべきメールを落とさない）
  IF _reason = 'fulfillment_cancelled' AND EXISTS (
    SELECT 1
    FROM private.order_email_outbox AS e
    LEFT JOIN public.order_fulfillments AS f ON f.id = e.fulfillment_id
    WHERE e.id = _email_id
      AND (e.kind <> 'shipped' OR f.cancelled_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'SKIP_REASON_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  UPDATE private.order_email_outbox AS e
  SET status = 'skipped',
      finished_at = pg_catalog.now(),
      subject = NULL,
      body_text = NULL,
      body_erased_at = CASE WHEN e.subject IS NOT NULL THEN pg_catalog.now() ELSE e.body_erased_at END,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = _reason
  WHERE e.id = _email_id
    AND e.status = 'sending'
    AND e.lease_token = _lease_token;
  RETURN FOUND;
END;
$$;

-- 返品の在庫は受け取りで動かす。既存の before_shipment の条件を保ち、返金結果では二度動かさない。
CREATE OR REPLACE FUNCTION private.apply_order_refund_state(_refund_id uuid)
RETURNS TABLE (
  newly_accepted boolean,
  newly_failed boolean,
  order_status public.order_status,
  refunded_amount integer,
  rereserve_shortage integer,
  email_enqueued boolean,
  exception_id uuid
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_refund public.order_refunds%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_line record;
  v_accepted boolean := false;
  v_failed boolean := false;
  v_email boolean := false;
  v_exception uuid;
  v_available integer;
  v_take integer;
  v_shortage integer := 0;
  v_kind text;
  v_variant text;
  v_succeeded integer;
  v_succeeded_at timestamptz;
  v_full integer;
  v_refunded integer;
  v_unshipped integer;
  v_shipped integer;
  v_target public.order_status;
  v_reason text := 'refund_projection';
  v_mark_review boolean := false;
  v_cancel_reason text;
  v_cancel_note text;
  v_cancel_notify boolean;
  v_shipped_at timestamptz;
  v_carrier text;
  v_tracking text;
  v_last_shipped_at timestamptz;
  v_last_carrier text;
  v_last_tracking text;
BEGIN
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- 呼ぶ側が取った鍵と同じ行（自分の鍵は取り直しても待たない）
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = v_refund.order_id FOR UPDATE;
  v_target := v_order.status;
  v_refunded := v_order.refunded_amount;

  -- 2. Stripe が受け付けた時（保留か成功に初めてなった時）の1回だけ、在庫を動かす（設計書 7-1）。写しは動かさない
  IF v_refund.source <> 'legacy'
     AND v_refund.stock_applied_at IS NULL
     AND v_refund.status IN ('pending', 'succeeded') THEN
    PERFORM 1
    FROM public.item_variants AS v
    WHERE v.id IN (
      SELECT oi.variant_id
      FROM public.order_refund_lines AS rl
      JOIN public.order_items AS oi ON oi.id = rl.order_item_id
      WHERE rl.refund_id = v_refund.id
        AND rl.before_shipment
        AND oi.fulfillment_type = 'stock'
        AND oi.variant_id IS NOT NULL
    )
    ORDER BY v.id
    FOR UPDATE;

    -- 外せる数 = min(返金する数, max(確保中の数 − 発送した数, 0))。確保の記録が無い古い商品（R-41）は 0 になり、在庫が湧かない
    FOR v_line IN
      SELECT rl.id AS line_id,
             rl.order_item_id,
             rl.restock_type,
             oi.variant_id,
             LEAST(rl.quantity, GREATEST(res.reserved - f.shipped, 0)) AS release_quantity
      FROM public.order_refund_lines AS rl
      JOIN public.order_items AS oi ON oi.id = rl.order_item_id
      JOIN private.order_line_reservations(v_order.id) AS res ON res.order_item_id = rl.order_item_id
      JOIN private.order_line_fulfillment(v_order.id) AS f ON f.order_item_id = rl.order_item_id
      WHERE rl.refund_id = v_refund.id
        AND rl.before_shipment
        AND oi.fulfillment_type = 'stock'
        AND oi.variant_id IS NOT NULL
      ORDER BY oi.variant_id, rl.order_item_id
    LOOP
      IF v_line.release_quantity > 0 THEN
        -- 先に +n を書く（戻さない時の −n で、すぐ出せる数が負にならないように）
        INSERT INTO public.stock_movements
          (variant_id, delta, reason, order_id, order_item_id, note, created_by, refund_id)
        VALUES
          (v_line.variant_id, v_line.release_quantity, 'refund', v_order.id, v_line.order_item_id,
           CASE WHEN v_line.restock_type = 'cancel' THEN 'refund_restock' ELSE 'refund_release' END,
           v_refund.actor_id, v_refund.id);
        IF v_line.restock_type = 'no_restock' THEN
          INSERT INTO public.stock_movements
            (variant_id, delta, reason, order_id, order_item_id, note, created_by, refund_id)
          VALUES
            (v_line.variant_id, -v_line.release_quantity, 'adjustment', v_order.id, v_line.order_item_id,
             'refund_no_restock', v_refund.actor_id, v_refund.id);
        END IF;
        UPDATE public.order_refund_lines AS l
        SET released_quantity = v_line.release_quantity,
            restocked_quantity = CASE WHEN v_line.restock_type = 'cancel' THEN v_line.release_quantity ELSE 0 END
        WHERE l.id = v_line.line_id;
      END IF;
    END LOOP;

    UPDATE public.order_refunds AS r SET stock_applied_at = pg_catalog.now() WHERE r.id = v_refund.id;
    v_accepted := true;
  END IF;

  -- 3. お客様へのメールの予定（1回だけ。設計書 8-1・8-2）。残高不足の保留は、お金が動く成功まで待つ。写しは書かない
  IF v_refund.source <> 'legacy'
     AND v_refund.notify_customer
     AND v_refund.email_enqueued_at IS NULL
     AND (v_refund.status = 'succeeded'
          OR (v_refund.status = 'pending' AND v_refund.stripe_pending_reason IS DISTINCT FROM 'insufficient_funds')) THEN
    IF v_refund.source IN ('order_cancel', 'auto_amount_mismatch') THEN
      v_kind := 'canceled';
      v_variant := 'paid';
    ELSIF v_refund.source = 'auto_cancelled_order_payment' THEN
      v_kind := 'refund';
      v_variant := 'after_cancel';
    ELSIF v_refund.source = 'return' THEN
      v_kind := 'refund';
      v_variant := 'return';
    ELSE
      v_kind := 'refund';
      v_variant := 'standard';
    END IF;
    PERFORM private.enqueue_order_email(v_order.id, v_kind, v_variant, NULL::uuid, v_refund.id);
    UPDATE public.order_refunds AS r SET email_enqueued_at = pg_catalog.now() WHERE r.id = v_refund.id;
    v_email := true;
  END IF;

  -- 4. 初めて失敗になった時の後始末（1回だけ。設計書 6-3・7-3）。写しは店へ知らせない
  IF v_refund.source <> 'legacy'
     AND v_refund.status = 'failed'
     AND v_refund.failure_applied_at IS NULL THEN
    -- 在庫を動かしていれば、外した数を確保し直す。ある分だけ確保し、足りない数は行に残す
    IF v_refund.stock_applied_at IS NOT NULL THEN
      PERFORM 1
      FROM public.item_variants AS v
      WHERE v.id IN (
        SELECT oi.variant_id
        FROM public.order_refund_lines AS rl
        JOIN public.order_items AS oi ON oi.id = rl.order_item_id
        WHERE rl.refund_id = v_refund.id
          AND rl.released_quantity > 0
          AND oi.variant_id IS NOT NULL
      )
      ORDER BY v.id
      FOR UPDATE;

      FOR v_line IN
        SELECT rl.id AS line_id, rl.order_item_id, rl.released_quantity, oi.variant_id
        FROM public.order_refund_lines AS rl
        JOIN public.order_items AS oi ON oi.id = rl.order_item_id
        WHERE rl.refund_id = v_refund.id
          AND rl.released_quantity > 0
          AND oi.variant_id IS NOT NULL
        ORDER BY oi.variant_id, rl.order_item_id
      LOOP
        SELECT GREATEST(v.stock_quantity, 0) INTO v_available
        FROM public.item_variants AS v
        WHERE v.id = v_line.variant_id;
        v_take := LEAST(v_line.released_quantity, v_available);
        IF v_take > 0 THEN
          INSERT INTO public.stock_movements
            (variant_id, delta, reason, order_id, order_item_id, note, created_by, refund_id)
          VALUES
            (v_line.variant_id, -v_take, 'purchase', v_order.id, v_line.order_item_id,
             'refund_failed_rereserve', v_refund.actor_id, v_refund.id);
        END IF;
        UPDATE public.order_refund_lines AS l
        SET rereserved_quantity = v_take,
            rereserve_shortage = v_line.released_quantity - v_take
        WHERE l.id = v_line.line_id;
        v_shortage := v_shortage + (v_line.released_quantity - v_take);
      END LOOP;
    END IF;

    -- 要対応の支払いの印は Stripe の返金の番号。ただし、エラーにした後に受け付けられないまま失敗した記録
    -- （errored_at があり accepted_at が空）は、エラーの時の要対応と同じ行になるよう記録の番号にする
    -- （P23。同じ支払い・同じ理由は1行なので、2件目を作らず店への知らせも1通）。
    -- エラーの後に保留・成功になった記録は、エラーの時の要対応をシステムが閉じている。その後の失敗
    -- （例: コンビニ払いの期限切れ）は、Stripe の返金の番号で新しい要対応にして、店へ知らせる
    SELECT x.exception_id INTO v_exception
    FROM public.record_payment_exception(
      CASE
        WHEN v_refund.errored_at IS NOT NULL AND v_refund.accepted_at IS NULL THEN v_refund.id::text
        ELSE COALESCE(v_refund.stripe_refund_id, v_refund.id::text)
      END,
      'refund_failed',
      COALESCE(v_refund.stripe_failure_reason, 'unknown'),
      NULL::text,
      v_order.payment_intent_id,
      NULL::uuid,
      v_order.id
    ) AS x;

    UPDATE public.order_refunds AS r SET failure_applied_at = pg_catalog.now() WHERE r.id = v_refund.id;
    v_failed := true;
    -- 要確認は、理由が空か確認済みの時に付ける（確認済みの注文も、また確認が要る）。別の理由が開いていれば上書きしない
    v_mark_review := v_shortage > 0 AND (v_order.review_reason IS NULL OR v_order.reviewed_at IS NOT NULL);
  END IF;

  -- 5. 注文の返金済みの額と状態（設計書 4-7）。支払い手続き中・未入金・失敗・放棄の注文は触らない
  IF v_order.status IN ('paid', 'shipped', 'cancelled') THEN
    SELECT COALESCE(pg_catalog.sum(r.amount), 0)::integer, pg_catalog.max(r.succeeded_at)
    INTO v_succeeded, v_succeeded_at
    FROM public.order_refunds AS r
    WHERE r.order_id = v_order.id
      AND r.status = 'succeeded';

    -- 全額 = 受け取った額（空なら注文の合計）。Stripe が重なった返金を返しても、注文の額は上限で頭打ちにして取り込みを止めない
    v_full := COALESCE(NULLIF(v_order.paid_amount, 0), v_order.total_amount);
    v_refunded := LEAST(v_succeeded, GREATEST(v_order.total_amount, COALESCE(v_order.paid_amount, 0)));

    SELECT COALESCE(pg_catalog.sum(l.unshipped), 0)::integer, COALESCE(pg_catalog.sum(l.shipped), 0)::integer
    INTO v_unshipped, v_shipped
    FROM private.order_line_fulfillment(v_order.id) AS l;

    IF v_order.status IN ('paid', 'shipped') AND v_succeeded >= v_full THEN
      v_target := 'cancelled'::public.order_status;
    ELSIF v_order.status = 'cancelled'
          AND v_succeeded < v_full
          AND private.order_cancelled_by_refund(v_order.id) THEN
      -- 返金で取消になった注文だけ戻す。未入金で取り消した注文は戻さない（P5）
      v_target := CASE
        WHEN v_unshipped = 0 AND v_shipped > 0 THEN 'shipped'::public.order_status
        ELSE 'paid'::public.order_status
      END;
    ELSIF v_order.status = 'paid' AND v_unshipped = 0 AND v_shipped > 0 THEN
      v_target := 'shipped'::public.order_status;
      v_reason := 'refund_completed_order';
    ELSIF v_order.status = 'shipped' AND v_unshipped > 0 THEN
      v_target := 'paid'::public.order_status;
      v_reason := 'refund_failed_reopened';
    END IF;

    -- 取消の列: 取消の理由を持つ返金（イ・オ）が取消にした時だけ写す。戻す時は空にする
    v_cancel_reason := v_order.cancel_reason;
    v_cancel_note := v_order.cancel_note;
    v_cancel_notify := v_order.cancel_notify_customer;
    IF v_target = 'cancelled'::public.order_status AND v_order.status <> 'cancelled'::public.order_status THEN
      v_cancel_reason := v_refund.cancel_reason;
      v_cancel_note := CASE
        WHEN v_refund.cancel_reason IS NOT NULL THEN NULLIF(pg_catalog.btrim(v_refund.note), '')
      END;
      v_cancel_notify := CASE WHEN v_refund.cancel_reason IS NOT NULL THEN v_refund.notify_customer END;
    ELSIF v_target <> 'cancelled'::public.order_status AND v_order.status = 'cancelled'::public.order_status THEN
      v_cancel_reason := NULL;
      v_cancel_note := NULL;
      v_cancel_notify := NULL;
    END IF;

    -- 発送の列（3つそろって入る・空になる）: 発送済みに動く時は、取り消していない最後の発送の値。支払い済みに戻る時は空
    v_shipped_at := v_order.shipped_at;
    v_carrier := v_order.shipping_carrier;
    v_tracking := v_order.tracking_number;
    IF v_target = 'shipped'::public.order_status AND v_order.status <> 'shipped'::public.order_status THEN
      SELECT f.shipped_at, f.shipping_carrier, f.tracking_number
      INTO v_last_shipped_at, v_last_carrier, v_last_tracking
      FROM public.order_fulfillments AS f
      WHERE f.order_id = v_order.id
        AND f.cancelled_at IS NULL
      ORDER BY f.number DESC
      LIMIT 1;
      IF FOUND THEN
        v_shipped_at := v_last_shipped_at;
        v_carrier := v_last_carrier;
        v_tracking := v_last_tracking;
      END IF;
    ELSIF v_target = 'paid'::public.order_status AND v_order.status <> 'paid'::public.order_status THEN
      v_shipped_at := NULL;
      v_carrier := NULL;
      v_tracking := NULL;
    END IF;

    IF v_target <> v_order.status
       OR v_refunded <> v_order.refunded_amount
       OR v_succeeded_at IS DISTINCT FROM v_order.refunded_at
       OR v_mark_review THEN
      PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(v_refund.actor_id::text, ''), true);
      PERFORM pg_catalog.set_config('app.order_change_reason', v_reason, true);
      PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

      UPDATE public.orders AS o
      SET status = v_target,
          refunded_amount = v_refunded,
          refunded_at = v_succeeded_at,
          payment_status_updated_at = CASE
            WHEN v_refunded <> o.refunded_amount THEN pg_catalog.now()
            ELSE o.payment_status_updated_at
          END,
          cancel_reason = v_cancel_reason,
          cancel_note = v_cancel_note,
          cancel_notify_customer = v_cancel_notify,
          shipped_at = v_shipped_at,
          shipping_carrier = v_carrier,
          tracking_number = v_tracking,
          review_reason = CASE WHEN v_mark_review THEN 'stock_not_reserved' ELSE o.review_reason END,
          review_marked_at = CASE WHEN v_mark_review THEN pg_catalog.now() ELSE o.review_marked_at END,
          reviewed_at = CASE WHEN v_mark_review THEN NULL ELSE o.reviewed_at END,
          reviewed_by = CASE WHEN v_mark_review THEN NULL ELSE o.reviewed_by END
      WHERE o.id = v_order.id;
    END IF;
  END IF;

  RETURN QUERY
  SELECT v_accepted,
         v_failed,
         v_target,
         v_refunded,
         COALESCE((
           SELECT pg_catalog.sum(rl.rereserve_shortage)
           FROM public.order_refund_lines AS rl
           WHERE rl.refund_id = v_refund.id
         ), 0)::integer,
         v_email,
         v_exception;
END;
$$;

-- 返品の返金の状態が変わった後の、返品の後始末（P25・P26）。呼ぶ側（record_order_refund_result・mark_order_refund_error）が
-- 注文 → 返品 → 返金の鍵を持ち、返金の記録の状態を書いた後に、前の状態を渡して呼ぶ。答えはメールの予定を新しく書いたか。
--  ・品を覆う状態（返事待ち・保留・成功）から覆わない状態（エラー・失敗）へ: その返金で引いた手数料を fee_pending_deduction に
--    戻す。返し直し（額を決めて返金）の計算どおりで、もう一度引く（P26）
--  ・エラーから保留・成功へ（エラーにした後に Stripe で見つかった）: 戻した手数料を引き直す。返し直しで先に使っていれば
--    0 より小さくしない（二重の返金は E-2 の要対応で店が扱う）
--  ・受け取りと一緒の返金が、受け付けられないまま（accepted_at も返金のお知らせの予定も無いまま）覆わない状態へ: 受け取りで
--    「お客様に知らせる」だった時だけ、その受け取りの return_received を予定する（P25。本文の一文は Task 6）。
--    受け付けられた後の失敗は、受け付けの時の返金のお知らせ（お返しの節つき）で伝わっているので足さない
--  ・返品の状態は戻さない（P19）。返金待ちの表示は数え方から出る。見つかった返金で返金待ちが無くなった受付中の返品を
--    完了にするため、最後に確かめ直す
CREATE OR REPLACE FUNCTION private.apply_return_refund_outcome(_refund_id uuid, _from_status text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_refund public.order_refunds%ROWTYPE;
  v_receipt public.order_return_receipts%ROWTYPE;
  v_from_covers boolean;
  v_to_covers boolean;
  v_enqueued boolean := false;
BEGIN
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND OR v_refund.source <> 'return' OR v_refund.return_id IS NULL THEN
    RETURN false;
  END IF;
  v_from_covers := _from_status IN ('awaiting_response', 'pending', 'succeeded');
  v_to_covers := v_refund.status IN ('awaiting_response', 'pending', 'succeeded');

  IF v_refund.return_fee_deduction > 0 AND v_from_covers AND NOT v_to_covers THEN
    UPDATE public.order_returns AS rt
    SET fee_pending_deduction = rt.fee_pending_deduction + v_refund.return_fee_deduction
    WHERE rt.id = v_refund.return_id;
  ELSIF v_refund.return_fee_deduction > 0 AND NOT v_from_covers AND v_to_covers THEN
    UPDATE public.order_returns AS rt
    SET fee_pending_deduction = GREATEST(rt.fee_pending_deduction - v_refund.return_fee_deduction, 0)
    WHERE rt.id = v_refund.return_id;
  END IF;

  IF v_from_covers AND NOT v_to_covers
     AND v_refund.accepted_at IS NULL
     AND v_refund.email_enqueued_at IS NULL THEN
    SELECT rr.* INTO v_receipt
    FROM public.order_return_receipts AS rr
    WHERE rr.refund_id = _refund_id
      AND rr.kind = 'receive';
    IF FOUND AND v_receipt.notify_customer THEN
      v_enqueued := private.enqueue_return_email(v_refund.order_id, 'return_received', v_refund.return_id, v_receipt.id);
    END IF;
  END IF;

  PERFORM private.refresh_order_return_status(v_refund.return_id);
  RETURN v_enqueued;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_order_refund_result(
  _refund_id uuid,
  _stripe_refund_id text,
  _stripe_status text,
  _stripe_pending_reason text,
  _stripe_failure_reason text,
  _customer_action_expires_at timestamptz,
  _payment_method_type text,
  _reference_number text,
  _reference_type text
)
RETURNS TABLE (
  refund_id uuid,
  order_id uuid,
  status text,
  newly_accepted boolean,
  newly_failed boolean,
  order_status public.order_status,
  refunded_amount integer,
  rereserve_shortage integer,
  email_enqueued boolean,
  exception_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order_id uuid;
  v_current public.order_refunds%ROWTYPE;
  v_next text;
  v_error_exception uuid;
  v_applied record;
  v_return_email boolean := false;
BEGIN
  IF _refund_id IS NULL
     OR NOT private.refund_stripe_fields_valid(
       _stripe_refund_id, _stripe_status, _stripe_pending_reason, _stripe_failure_reason,
       _payment_method_type, _reference_number, _reference_type
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT r.order_id INTO v_order_id FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 鍵は注文 → 返品 → 返金の順（返品の返金だけ返品の鍵を足す）
  PERFORM 1 FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE;
  PERFORM 1 FROM public.order_returns AS rt
  WHERE rt.id=(SELECT r.return_id FROM public.order_refunds AS r WHERE r.id=_refund_id) FOR UPDATE;
  SELECT r.* INTO v_current FROM public.order_refunds AS r WHERE r.id = _refund_id FOR UPDATE;

  -- Stripe の返金の番号は、記録に1つだけ。別の記録がもう使っている番号も断る
  IF (v_current.stripe_refund_id IS NOT NULL AND v_current.stripe_refund_id <> _stripe_refund_id)
     OR (v_current.stripe_refund_id IS NULL AND EXISTS (
       SELECT 1
       FROM public.order_refunds AS x
       WHERE x.stripe_refund_id = _stripe_refund_id
         AND x.id <> _refund_id
     )) THEN
    RAISE EXCEPTION 'REFUND_STRIPE_ID_MISMATCH' USING ERRCODE = '22023';
  END IF;

  v_next := CASE
    WHEN _stripe_status IN ('pending', 'requires_action') THEN 'pending'
    WHEN _stripe_status = 'succeeded' THEN 'succeeded'
    ELSE 'failed'
  END;

  -- 許す移り方（Global Constraints）。同じ状態のままの細目の更新も許す
  IF v_next <> v_current.status AND NOT (
       (v_current.status = 'awaiting_response' AND v_next IN ('pending', 'succeeded', 'failed'))
    OR (v_current.status = 'error' AND v_next IN ('pending', 'succeeded', 'failed'))
    OR (v_current.status = 'pending' AND v_next IN ('succeeded', 'failed'))
    OR (v_current.status = 'succeeded' AND v_next = 'failed')
  ) THEN
    RETURN QUERY
    SELECT v_current.id,
           v_current.order_id,
           v_current.status,
           false,
           false,
           o.status,
           o.refunded_amount,
           COALESCE((
             SELECT pg_catalog.sum(rl.rereserve_shortage)
             FROM public.order_refund_lines AS rl
             WHERE rl.refund_id = v_current.id
           ), 0)::integer,
           false,
           NULL::uuid
    FROM public.orders AS o
    WHERE o.id = v_current.order_id;
    RETURN;
  END IF;

  -- 番号・支払いの種類・時刻は、空から値へ1回だけ書く。細目は新しい値で上書きする（照会番号と期限は、空の知らせで消さない）
  UPDATE public.order_refunds AS r
  SET status = v_next,
      stripe_refund_id = COALESCE(r.stripe_refund_id, _stripe_refund_id),
      stripe_status = _stripe_status,
      stripe_pending_reason = _stripe_pending_reason,
      stripe_failure_reason = _stripe_failure_reason,
      customer_action_expires_at = COALESCE(_customer_action_expires_at, r.customer_action_expires_at),
      payment_method_type = COALESCE(r.payment_method_type, _payment_method_type),
      reference_number = COALESCE(NULLIF(pg_catalog.btrim(_reference_number), ''), r.reference_number),
      reference_type = COALESCE(_reference_type, r.reference_type),
      accepted_at = CASE
        WHEN v_next IN ('pending', 'succeeded') THEN COALESCE(r.accepted_at, pg_catalog.now())
        ELSE r.accepted_at
      END,
      succeeded_at = CASE WHEN v_next = 'succeeded' THEN COALESCE(r.succeeded_at, pg_catalog.now()) ELSE r.succeeded_at END,
      failed_at = CASE WHEN v_next = 'failed' THEN COALESCE(r.failed_at, pg_catalog.now()) ELSE r.failed_at END
  WHERE r.id = _refund_id;

  -- エラーにした記録が Stripe で見つかって保留・成功になった時は、エラーの時の要対応（payment_ref は記録の番号）を
  -- システムが閉じる（P23）。受け付けられないまま失敗で見つかった時は、失敗の後始末が同じ行に記録するので、ここでは閉じない
  -- 発送前の行の商品が全部 s + rb ≤ q を保つ時だけ、自動で解決する（controller ruling）。
  -- エラーの間に発送し、お客様に品と返金の両方が届いた状態を、店に知らせずに閉じない
  IF v_current.status = 'error'
     AND v_next IN ('pending', 'succeeded')
     AND NOT EXISTS (
       SELECT 1
       FROM public.order_refund_lines AS rl
       JOIN private.order_line_fulfillment(v_order_id) AS l ON l.order_item_id = rl.order_item_id
       WHERE rl.refund_id = _refund_id
         AND rl.before_shipment
         AND l.shipped + l.refunded_before_shipment > l.quantity
     ) THEN
    SELECT e.id INTO v_error_exception
    FROM public.payment_exceptions AS e
    WHERE e.payment_ref = _refund_id::text
      AND e.reason = 'refund_failed'
      AND e.resolved_at IS NULL;
    IF FOUND THEN
      PERFORM public.resolve_payment_exception_by_system(v_error_exception, 'Stripe で返金が見つかったため自動で解決');
    END IF;
  END IF;

  SELECT a.* INTO v_applied FROM private.apply_order_refund_state(_refund_id) AS a;
  -- 返品の返金は、返品の後始末（引いた手数料の戻しと引き直し P26・受け付けられなかった受け取りの return_received P25）と
  -- 完了の確かめ直し（P19。閉じた返品は戻さない）。return_received を予定した時は、メールの予定を書いたと答える（窓口が送る処理を動かす）
  IF v_current.return_id IS NOT NULL THEN
    v_return_email := private.apply_return_refund_outcome(_refund_id, v_current.status);
  END IF;

  RETURN QUERY
  SELECT _refund_id,
         v_order_id,
         v_next,
         v_applied.newly_accepted,
         v_applied.newly_failed,
         v_applied.order_status,
         v_applied.refunded_amount,
         v_applied.rereserve_shortage,
         v_applied.email_enqueued OR v_return_email,
         v_applied.exception_id;
END;
$$;

-- 返事待ちだけをエラーにする（E-2 の本文のまま。Stripe の断り・見回りが Stripe に見つけられなかった時）。返品の返金なら、
-- 鍵を注文 → 返品 → 返金の順に取り、エラーにした後に返品の後始末（引いた手数料を戻す P26・受け取りの return_received P25）をする
CREATE OR REPLACE FUNCTION public.mark_order_refund_error(_refund_id uuid, _reason text, _raise_exception boolean)
RETURNS TABLE (outcome text, order_id uuid, exception_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order_id uuid;
  v_return_id uuid;
  v_order public.orders%ROWTYPE;
  v_refund public.order_refunds%ROWTYPE;
  v_exception uuid;
BEGIN
  IF _refund_id IS NULL
     OR _raise_exception IS NULL
     OR _reason IS NULL
     OR _reason !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT r.order_id, r.return_id INTO v_order_id, v_return_id FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 鍵は注文 → 返品 → 返金の順（受け取り・額を決めて返金・結果を書く関数と同じ）。要対応の行が注文を指すので、注文の鍵を先に取る
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE;
  IF v_return_id IS NOT NULL THEN
    PERFORM 1 FROM public.order_returns AS rt WHERE rt.id = v_return_id FOR UPDATE;
  END IF;
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id FOR UPDATE;

  IF v_refund.status <> 'awaiting_response' THEN
    RETURN QUERY SELECT 'not_awaiting'::text, v_order_id, NULL::uuid;
    RETURN;
  END IF;

  UPDATE public.order_refunds AS r
  SET status = 'error',
      stripe_failure_reason = _reason,
      errored_at = pg_catalog.now()
  WHERE r.id = _refund_id;

  IF _raise_exception THEN
    SELECT x.exception_id INTO v_exception
    FROM public.record_payment_exception(
      _refund_id::text,
      'refund_failed',
      _reason,
      NULL::text,
      v_order.payment_intent_id,
      NULL::uuid,
      v_order_id
    ) AS x;
  END IF;

  -- エラーの記録では、在庫・メールの予定・失敗の後始末は動かず、注文の状態だけが動く（E-2 のまま）
  PERFORM 1 FROM private.apply_order_refund_state(_refund_id);

  IF v_return_id IS NOT NULL THEN
    PERFORM private.apply_return_refund_outcome(_refund_id, 'awaiting_response');
  END IF;

  RETURN QUERY SELECT 'errored'::text, v_order_id, v_exception;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_fulfillment(
  _order_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _shipping_carrier text,
  _tracking_number text,
  _notify_customer boolean,
  _lines jsonb
)
RETURNS TABLE (
  fulfillment_id uuid,
  number integer,
  completes_order boolean,
  order_status public.order_status,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_ids uuid[];
  v_quantities integer[];
  v_order public.orders;
  v_existing public.order_fulfillments;
  v_unshipped integer;
  v_requested integer;
  v_number integer;
  v_fulfillment_id uuid;
  v_completes boolean;
  v_constraint text;
BEGIN
  IF _order_id IS NULL
     OR _actor_id IS NULL
     OR _request_key IS NULL
     OR _notify_customer IS NULL
     OR _shipping_carrier IS NULL
     OR _shipping_carrier NOT IN ('yamato', 'sagawa', 'japanpost')
     OR _tracking_number IS NULL
     OR _tracking_number !~ '^[0-9A-Za-z-]{1,64}$' THEN
    RAISE EXCEPTION 'FULFILLMENT_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(p.order_item_id ORDER BY p.order_item_id),
         pg_catalog.array_agg(p.quantity ORDER BY p.order_item_id)
  INTO v_ids, v_quantities
  FROM private.parse_fulfillment_lines(_lines, 'FULFILLMENT_ARGUMENT_INVALID') AS p;

  -- 同じ注文の操作（発送・取消・仕上がり）を1つずつ進める。同時に2つの発送が来ても、後の方は前の発送の後の数で確かめる
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 同じ重複防止キーの送り直し（通信が切れた後の「もう一度確かめる」）は、同じ中身なら前の結果を返す
  SELECT f.* INTO v_existing FROM public.order_fulfillments AS f WHERE f.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.order_id <> _order_id
       OR v_existing.shipping_carrier IS DISTINCT FROM _shipping_carrier
       OR v_existing.tracking_number IS DISTINCT FROM _tracking_number
       OR v_existing.notify_customer <> _notify_customer
       OR (
         SELECT pg_catalog.count(*)
         FROM public.order_fulfillment_lines AS l
         WHERE l.fulfillment_id = v_existing.id
       ) <> pg_catalog.cardinality(v_ids)
       OR EXISTS (
         SELECT 1
         FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_quantities)) AS r(order_item_id, quantity)
         WHERE NOT EXISTS (
           SELECT 1
           FROM public.order_fulfillment_lines AS l
           WHERE l.fulfillment_id = v_existing.id
             AND l.order_item_id = r.order_item_id
             AND l.quantity = r.quantity
         )
       ) THEN
      RAISE EXCEPTION 'FULFILLMENT_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT v_existing.id, v_existing.number, v_existing.completes_order, v_order.status, true;
    RETURN;
  END IF;

  IF v_order.status <> 'paid'::public.order_status THEN
    RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE' USING ERRCODE = '22023';
  END IF;

  -- 一部の発送でも毎回確かめる（配送先は後から直せないので、足りない注文は1つも送らない）
  IF NOT private.order_has_required_shipping_fields(v_order) THEN
    RAISE EXCEPTION 'SHIPPING_ADDRESS_INCOMPLETE' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.payment_exceptions AS e
    WHERE e.order_id = _order_id
      AND e.reason = 'paid_amount_mismatch'
      AND e.resolved_at IS NULL
  ) THEN
    RAISE EXCEPTION 'PAYMENT_REVIEW_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.sum(l.unshipped), 0)::integer INTO v_unshipped
  FROM private.order_line_fulfillment(_order_id) AS l;
  IF v_unshipped = 0 THEN
    RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_ids) AS r(order_item_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_items AS oi
      WHERE oi.id = r.order_item_id
        AND oi.order_id = _order_id
    )
  ) THEN
    RAISE EXCEPTION 'LINE_NOT_IN_ORDER' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_quantities)) AS r(order_item_id, quantity)
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = r.order_item_id
    WHERE r.quantity > l.ready_unshipped
  ) THEN
    RAISE EXCEPTION 'QUANTITY_EXCEEDS_READY' USING ERRCODE = '22023';
  END IF;

  -- 支払いを待たずに送るという明示的な解除だけを例外にする。
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_ids) AS x(id)
    JOIN public.order_items AS oi ON oi.id=x.id
    JOIN public.order_return_lines AS rl ON rl.id=oi.exchange_return_line_id
    JOIN public.order_returns AS rt ON rt.id=rl.return_id
    WHERE oi.line_kind='exchange' AND rt.fee_due_amount>0
      AND rt.fee_received_at IS NULL AND rt.exchange_released_at IS NULL
  ) THEN RAISE EXCEPTION 'FULFILLMENT_EXCHANGE_ON_HOLD' USING ERRCODE='22023'; END IF;

  -- 本計画 P13: 行を書く前に「未発送の合計 − 今回送る数の合計 = 0」で決める（送る数は発送準備中の数以下なので負にならない）
  SELECT pg_catalog.sum(r.quantity)::integer INTO v_requested
  FROM pg_catalog.unnest(v_quantities) AS r(quantity);
  v_completes := v_unshipped - v_requested = 0;

  -- 何回目かは取り消した発送も数える（履歴の「発送（n回目）」が変わらない）
  SELECT COALESCE(pg_catalog.max(f.number), 0) + 1 INTO v_number
  FROM public.order_fulfillments AS f
  WHERE f.order_id = _order_id;

  BEGIN
    INSERT INTO public.order_fulfillments AS f
      (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order, created_by)
    VALUES (_order_id, v_number, _request_key, _shipping_carrier, _tracking_number, _notify_customer, v_completes, _actor_id)
    RETURNING f.id INTO v_fulfillment_id;
  EXCEPTION WHEN unique_violation THEN
    -- 同じキーをほかの注文の発送が同時に使った（同じ注文の送り直しは、鍵の後の確かめで前の結果を返している）
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_fulfillments_request_key_key' THEN
      RAISE EXCEPTION 'FULFILLMENT_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  INSERT INTO public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity)
  SELECT v_fulfillment_id, r.order_item_id, r.quantity
  FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_quantities)) AS r(order_item_id, quantity);

  -- 全部を送った時だけ、注文を発送済みにする（今の発送の列の意味＝全部を送った時の値を守る。
  -- 全額返金の取り消しの戻し先と、配送先を確かめるトリガーがそのまま使える）
  IF v_completes THEN
    PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
    PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_create_fulfillment', true);
    UPDATE public.orders AS o
    SET status = 'shipped'::public.order_status,
        shipped_at = pg_catalog.now(),
        shipping_carrier = _shipping_carrier,
        tracking_number = _tracking_number
    WHERE o.id = _order_id;
  END IF;

  IF _notify_customer THEN
    PERFORM private.enqueue_order_email(_order_id, 'shipped', NULL, v_fulfillment_id);
  END IF;

  RETURN QUERY
  SELECT v_fulfillment_id, v_number, v_completes, o.status, false
  FROM public.orders AS o
  WHERE o.id = _order_id;
END;
$$;

-- 人気の購入数は元の注文の行だけ。既存の「paid の注文」の対象範囲は変えない。
CREATE OR REPLACE FUNCTION public.get_popular_items(limit_count integer DEFAULT 4)
RETURNS TABLE(id bigint,name text,description text,category text,image_url text,price integer,purchase_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT i.id::bigint,i.name::text,i.description::text,i.category::text,i.image_url::text,i.price::integer,
        COALESCE(p.purchase_count,0)::bigint
 FROM public.items AS i LEFT JOIN (
   SELECT oi.item_id,pg_catalog.sum(oi.quantity) AS purchase_count
   FROM public.order_items AS oi JOIN public.orders AS o ON o.id=oi.order_id
   WHERE o.status='paid' AND oi.line_kind='order' GROUP BY oi.item_id
 ) AS p ON p.item_id=i.id
 WHERE i.status='published'
 ORDER BY COALESCE(p.purchase_count,0) DESC,i.created_at DESC LIMIT limit_count
$$;


-- 受け取りの入力は確定した順に並べ、配列の並び替えを同じ操作として扱う。
-- 交換の品の行の番号。受け取り・返品の行・送り方から同じ番号を作り、送り直しで同じ行を引き直す。
-- md5 の16進をそのまま uuid にすると版（13字目）と変種（17字目）が乱数になり、窓口の z.string().uuid()（RFC 9562）を
-- 約7/8で通らない（発送・仕上がり・返金・返品を作る窓口が、その品の番号を 400 で断る）ので、版4・変種8の印を立てる
CREATE OR REPLACE FUNCTION private.return_exchange_item_id(_receipt_id uuid, _return_line_id uuid, _method text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT (pg_catalog.substr(s.h, 1, 12) || '4' || pg_catalog.substr(s.h, 14, 3) || '8' || pg_catalog.substr(s.h, 18, 15))::uuid
  FROM (SELECT pg_catalog.md5(_receipt_id::text || ':' || _return_line_id::text || ':' || _method) AS h) AS s
$$;

CREATE OR REPLACE FUNCTION public.admin_receive_return(
  _return_id uuid, _actor_id uuid, _actor_can_refund boolean, _request_key uuid,
  _units jsonb, _exchange_overrides jsonb, _refund_choice text, _refund_amount integer,
  _refund_shipping_amount integer, _note text, _notify_customer boolean,
  _sent_back_message text, _sent_back_carrier text, _sent_back_tracking_number text
) RETURNS TABLE(receipt_id uuid,return_status text,refund_id uuid,refund_amount integer,
  refund_status text,exchange_order_item_ids uuid[],fee_due_amount integer,shop_notice_enqueued boolean,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_order uuid; v_return public.order_returns%ROWTYPE; v_old public.order_return_receipts%ROWTYPE;
  v_units jsonb; v_effective jsonb; v_overrides jsonb; v_fp text; v_j jsonb; v_id uuid; v_n integer; v_seen text[]:=ARRAY[]::text[];
  v_receipt uuid:=pg_catalog.gen_random_uuid(); v_refund uuid; v_amount integer; v_status text;
  v_lines jsonb:='[]'::jsonb; v_goods integer:=0; v_exchange integer:=0; v_sent integer:=0;
  v_fees integer:=0; v_due integer:=0; v_pending integer:=0; v_shop boolean:=false;
  v_first_goods boolean; v_first_exchange boolean; v_line record; v_action text; v_available integer;
  v_exchange_ids uuid[]:=ARRAY[]::uuid[]; v_item uuid; v_offset integer; v_paid integer; v_waived boolean:=false;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _actor_can_refund IS NULL OR _request_key IS NULL
    OR _notify_customer IS NULL OR _refund_choice IS NULL OR _refund_choice NOT IN ('now','consult','none')
    OR _refund_shipping_amount IS NULL OR _refund_shipping_amount<0
    OR (_refund_amount IS NOT NULL AND _refund_amount<0) OR pg_catalog.char_length(_note)>500
    OR pg_catalog.char_length(_sent_back_message)>1000
    OR (_sent_back_carrier IS NOT NULL AND _sent_back_carrier NOT IN ('yamato','sagawa','japanpost','other'))
    OR (_sent_back_tracking_number IS NOT NULL AND _sent_back_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
    OR pg_catalog.jsonb_typeof(_units) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(_exchange_overrides) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_units) NOT BETWEEN 1 AND 100
    OR pg_catalog.jsonb_array_length(_exchange_overrides)>100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF NOT _actor_can_refund AND (_refund_choice='now' OR _refund_amount IS NOT NULL
      OR _refund_shipping_amount<>0 OR pg_catalog.jsonb_array_length(_exchange_overrides)>0) THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN' USING ERRCODE='22023';
  END IF;
  IF _refund_choice<>'now' AND (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_units) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_j->'quantity') IS DISTINCT FROM 'number'
      OR (v_j->>'quantity') !~ '^[1-9][0-9]{0,2}$'
      OR COALESCE(v_j->>'disposition','') NOT IN ('restocked','not_restocked','pending_inspection','sent_back') THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
    END IF;
    BEGIN v_id:=(v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END;
    IF (v_id::text||':'||(v_j->>'disposition'))=ANY(v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_seen:=v_seen||(v_id::text||':'||(v_j->>'disposition'));
  END LOOP;
  v_seen:=ARRAY[]::text[];
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_exchange_overrides) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR COALESCE(v_j->>'action','') NOT IN ('make','refund') THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    BEGIN v_id:=(v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END;
    IF v_id::text=ANY(v_seen) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_seen:=v_seen||v_id::text;
  END LOOP;
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'disposition',x.disposition,'quantity',x.quantity)
    ORDER BY x.return_line_id,x.disposition) INTO v_units
  FROM pg_catalog.jsonb_to_recordset(_units) AS x(return_line_id uuid,disposition text,quantity integer);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'action',x.action)
    ORDER BY x.return_line_id),'[]'::jsonb) INTO v_overrides
  FROM pg_catalog.jsonb_to_recordset(_exchange_overrides) AS x(return_line_id uuid,action text);
  v_fp:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'units',v_units,'exchange_overrides',v_overrides,
    'refund_choice',_refund_choice,'refund_amount',_refund_amount,'refund_shipping_amount',_refund_shipping_amount,
    'note',_note,'notify_customer',_notify_customer,'sent_back_message',_sent_back_message,
    'sent_back_carrier',_sent_back_carrier,'sent_back_tracking_number',_sent_back_tracking_number,
    'actor_can_refund',_actor_can_refund)::text);
  -- 鍵は注文 → 返品（Task 2 の部品。返品が無ければ RETURN_NOT_FOUND）
  v_return:=private.lock_order_return(_return_id);
  v_order:=v_return.order_id;
  SELECT rr.* INTO v_old FROM public.order_return_receipts AS rr WHERE rr.request_key=_request_key;
  IF FOUND THEN
    IF v_old.return_id<>_return_id OR v_old.kind<>'receive' OR v_old.request_fingerprint<>v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    -- 交換の行の番号は受け取りと返品の行から決まるので、再送で新しい行を作る必要がない。
    RETURN QUERY SELECT v_old.id,v_return.status,r.id,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_return_receipt_lines AS w WHERE w.receipt_id=v_old.id AND w.disposition='refund_waived') THEN 0 ELSE r.amount END,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_return_receipt_lines AS w WHERE w.receipt_id=v_old.id AND w.disposition='refund_waived') THEN 'waived' ELSE r.status END,
      COALESCE((SELECT pg_catalog.array_agg(DISTINCT oi.id ORDER BY oi.id) FROM public.order_return_receipt_lines AS u
        JOIN public.order_items AS oi ON oi.id=private.return_exchange_item_id(v_old.id,u.return_line_id,u.exchange_method)
        WHERE u.receipt_id=v_old.id),ARRAY[]::uuid[]),v_return.fee_due_amount,
      EXISTS(SELECT 1 FROM private.order_email_outbox AS e WHERE e.return_receipt_id=v_old.id AND e.kind='return_refund_pending_shop'),true
    FROM (SELECT 1) AS singleton LEFT JOIN public.order_refunds AS r ON r.id=v_old.refund_id;
    RETURN;
  END IF;
  IF v_return.status<>'open' THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,quantity integer)
    WHERE NOT EXISTS(SELECT 1 FROM public.order_return_lines AS l WHERE l.id=x.return_line_id AND l.return_id=_return_id)) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,quantity integer)
    JOIN private.order_return_line_progress(_return_id) AS g ON g.return_line_id=x.return_line_id
    GROUP BY x.return_line_id,g.unprocessed HAVING pg_catalog.sum(x.quantity)>g.unprocessed) THEN
    RAISE EXCEPTION 'RETURN_RECEIPT_EXCEEDS' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(pg_catalog.sum(x.quantity),0)::integer INTO v_sent
  FROM pg_catalog.jsonb_to_recordset(v_units) AS x(disposition text,quantity integer) WHERE x.disposition='sent_back';
  IF v_sent>0 AND NULLIF(pg_catalog.btrim(_sent_back_message),'') IS NULL THEN
    RAISE EXCEPTION 'RETURN_SENT_BACK_MESSAGE_REQUIRED' USING ERRCODE='22023'; END IF;
  -- お返しのメッセージは必ず届ける（仕様書 6-1・9-1）
  IF v_sent>0 AND NOT _notify_customer THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;

  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(disposition text) WHERE x.disposition='pending_inspection')
    AND NOT (SELECT s.inspection_enabled FROM public.shop_return_settings AS s WHERE s.id=1) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- 既存の返金の鍵を先に取り、在庫の鍵を取ってから返金の鍵を待つ逆順を作らない。
  PERFORM 1 FROM public.order_refunds AS r WHERE r.order_id=v_order ORDER BY r.id FOR UPDATE;
  PERFORM 1 FROM public.item_variants AS v WHERE v.id IN (
    SELECT oi.variant_id FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id JOIN public.order_items AS oi ON oi.id=l.order_item_id
    UNION SELECT l.exchange_variant_id FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
  ) ORDER BY v.id FOR UPDATE;
  -- 上書きの形（C-1）: この返品の、交換（在庫から）の予定の行で、今回受け取る点（お返しでない）がある行だけ。
  -- 理由の設定が decline の行は make・refund、make の行は refund だけ（何も送らなければ自動で作って送る。仕様書 6-5）。
  -- 在庫不足の行かどうかは、下の割り当ての中で確かめる（在庫が足りる行への上書きは RETURN_ARGUMENT_INVALID）
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text)
    LEFT JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    LEFT JOIN public.shop_return_reason_settings AS rs ON rs.reason=l.reason
    WHERE l.return_id IS DISTINCT FROM _return_id OR l.resolution IS DISTINCT FROM 'exchange'
      OR l.exchange_method IS DISTINCT FROM 'stock' OR rs.out_of_stock_exchange IS NULL
      OR (rs.out_of_stock_exchange='make' AND x.action<>'refund')
      OR NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer)
        WHERE u.return_line_id=l.id AND u.disposition<>'sent_back')) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- 返品行の予定は不変。上書きは今回受け取る数だけの実際の解決方法として保持する。
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',u.return_line_id,
      'disposition',u.disposition,'quantity',u.quantity,
      'resolution',CASE WHEN u.disposition='sent_back' THEN NULL WHEN x.action='refund' THEN 'refund' ELSE l.resolution END,
      'exchange_method',CASE WHEN u.disposition='sent_back' OR l.resolution='refund' OR x.action='refund' THEN NULL
        WHEN x.action='make' THEN 'make' ELSE l.exchange_method END) ORDER BY u.return_line_id,u.disposition)
    INTO v_effective
  FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer)
  JOIN public.order_return_lines AS l ON l.id=u.return_line_id
  LEFT JOIN pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text) ON x.return_line_id=l.id;
  -- 交換の品の割り当て（Global Constraints の交換の品の行）。返品の行の並び（list_order_returns の lines と同じ: 発送の番号 →
  -- 注文の商品の登録順 → 注文の商品の番号 → 返品の行の番号）で、この受け取りで在庫に戻す前の在庫を前から割り当て、
  -- 足りなくなった行を在庫不足として扱う（画面も、開いた時の在庫を同じ並びで数える）。前の行の −n は台帳のトリガーがすぐ
  -- 在庫に足すので、行ごとに読み直す在庫が残りの在庫になる。在庫に戻す品はこの後に書く（足りる行は戻す前の在庫の内なので、
  -- 負の在庫を経由しない）
  FOR v_line IN SELECT l.*,pg_catalog.sum(x.quantity)::integer AS picked,ov.action AS override_action
    FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text,quantity integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    JOIN public.order_fulfillments AS f ON f.id=l.fulfillment_id
    JOIN public.order_items AS oi ON oi.id=l.order_item_id
    LEFT JOIN pg_catalog.jsonb_to_recordset(v_overrides) AS ov(return_line_id uuid,action text) ON ov.return_line_id=l.id
    WHERE l.resolution='exchange' AND x.disposition<>'sent_back'
    GROUP BY l.id,f.number,oi.created_at,ov.action
    ORDER BY f.number,oi.created_at,l.order_item_id,l.id
  LOOP
    IF v_line.exchange_method='make' THEN
      v_action:='make';
    ELSE
      SELECT v.stock_quantity INTO v_available FROM public.item_variants AS v WHERE v.id=v_line.exchange_variant_id;
      IF v_available>=v_line.picked THEN
        -- 在庫が足りる行は在庫から。上書きは在庫不足の行だけ（C-1）
        IF v_line.override_action IS NOT NULL THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
        v_action:='stock';
      ELSIF v_line.override_action IS NOT NULL THEN
        v_action:=v_line.override_action;
      ELSIF (SELECT rs.out_of_stock_exchange FROM public.shop_return_reason_settings AS rs WHERE rs.reason=v_line.reason)='make' THEN
        v_action:='make';
      ELSE
        RAISE EXCEPTION 'RETURN_EXCHANGE_OUT_OF_STOCK' USING ERRCODE='22023';
      END IF;
    END IF;
    -- 返金に変えた行は交換の品を作らない（上の v_effective で返金の品になっていて、下の返金の数に入る）
    CONTINUE WHEN v_action='refund';
    SELECT COALESCE(pg_catalog.sum(e.quantity),0)::integer INTO v_offset FROM public.order_items AS e
    JOIN public.order_return_lines AS old ON old.id=e.exchange_return_line_id WHERE old.order_item_id=v_line.order_item_id;
    v_paid:=private.return_units_amount(v_line.order_item_id,v_line.picked,v_offset);
    -- 自動の make と店長の選択を含む実際の送り方だけを、受け取り明細へ保存する。
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',u.return_line_id,'disposition',u.disposition,
        'quantity',u.quantity,'resolution',u.resolution,'exchange_method',CASE WHEN u.return_line_id=v_line.id
          AND u.resolution='exchange' THEN v_action ELSE u.exchange_method END) ORDER BY u.return_line_id,u.disposition)
      INTO v_effective
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS u(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text);
    v_item:=private.return_exchange_item_id(v_receipt,v_line.id,v_action);
    INSERT INTO public.order_items(id,order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,
      fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
    SELECT v_item,v_order,v.item_id,v.id,i.name,0,c.name,z.label,v_line.picked,0,
      CASE WHEN v_action='stock' THEN 'stock' ELSE 'backorder' END,'exchange',v_line.id,v_paid
    FROM public.item_variants AS v JOIN public.items AS i ON i.id=v.item_id
    LEFT JOIN public.item_colors AS c ON c.id=v.color_id LEFT JOIN public.item_sizes AS z ON z.id=v.size_id
    WHERE v.id=v_line.exchange_variant_id;
    IF v_action='stock' THEN
      INSERT INTO public.stock_movements(variant_id,delta,reason,order_id,order_item_id,created_by,return_id)
      VALUES(v_line.exchange_variant_id,-v_line.picked,'exchange',v_order,v_item,_actor_id,_return_id);
    END IF;
    v_exchange_ids:=v_exchange_ids||v_item;v_exchange:=v_exchange+v_line.picked;
  END LOOP;
  -- 戻る品を在庫へ足す（交換の割り当ての後。在庫不足の判定には入れない）
  FOR v_line IN SELECT l.order_item_id,oi.variant_id,pg_catalog.sum(x.quantity)::integer AS quantity
    FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text,quantity integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id JOIN public.order_items AS oi ON oi.id=l.order_item_id
    WHERE x.disposition='restocked' GROUP BY l.order_item_id,oi.variant_id ORDER BY oi.variant_id,l.order_item_id
  LOOP
    IF v_line.variant_id IS NULL THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    INSERT INTO public.stock_movements(variant_id,delta,reason,order_id,order_item_id,created_by,return_id)
    VALUES(v_line.variant_id,v_line.quantity,'return',v_order,v_line.order_item_id,_actor_id,_return_id);
  END LOOP;
  -- 普通の返金で先に返した数を、この受け取りの返金に入れない（Review Focus 3）。
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',t.order_item_id,'before_shipment',false,'quantity',t.quantity)
      ORDER BY t.order_item_id) FILTER(WHERE t.quantity>0),'[]'::jsonb),
    COALESCE(pg_catalog.sum(private.return_units_amount(t.order_item_id,t.quantity)) FILTER(WHERE t.quantity>0),0)::integer
    INTO v_lines,v_goods FROM (
      SELECT l.order_item_id,LEAST(pg_catalog.sum(x.quantity)::integer,
        GREATEST(rc.shipped-rc.refunded_after_shipment-rc.requested-rc.open_unprocessed-rc.refund_waiting-rc.exchanged-rc.sent_back
          +pg_catalog.sum(x.quantity)::integer,0)) AS quantity
      FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text)
      JOIN public.order_return_lines AS l ON l.id=x.return_line_id
      JOIN private.order_line_return_counts(v_order) AS rc ON rc.order_item_id=l.order_item_id
      WHERE x.resolution='refund'
      GROUP BY l.order_item_id,rc.shipped,rc.refunded_after_shipment,rc.requested,rc.open_unprocessed,rc.refund_waiting,rc.exchanged,rc.sent_back
    ) AS t;
  IF _refund_choice='none' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  v_first_goods:=NOT EXISTS(SELECT 1 FROM public.order_return_receipts AS rr
    JOIN public.order_return_receipt_lines AS u ON u.receipt_id=rr.id
    WHERE rr.return_id=_return_id AND rr.kind='receive' AND u.resolution IN ('refund','exchange'));
  v_first_exchange:=NOT EXISTS(SELECT 1 FROM public.order_items AS e
    JOIN public.order_return_lines AS l ON l.id=e.exchange_return_line_id
    WHERE l.return_id=_return_id AND NOT (e.id=ANY(v_exchange_ids)));
  v_fees:=(v_goods::bigint*v_return.restocking_fee_percent/100)::integer
    +CASE WHEN v_first_goods AND (pg_catalog.jsonb_array_length(v_lines)>0 OR v_exchange>0) AND v_return.return_method='shop_label'
      THEN v_return.return_shipping_fee ELSE 0 END
    +CASE WHEN v_first_exchange AND v_exchange>0 THEN v_return.exchange_fee+v_return.exchange_shipping_fee ELSE 0 END;
  IF _refund_choice='consult' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN v_pending:=v_fees;
  ELSIF _refund_choice='now' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN
    v_amount:=GREATEST(v_goods-v_fees,0)+_refund_shipping_amount;
    -- 店長が直した額の上限は返せる額（E-2 の値。仕様書 6-3・P8）。計算との差は core が adjustment_amount に残す
    IF _refund_amount IS NOT NULL THEN
      IF _refund_amount<_refund_shipping_amount
        OR _refund_amount>(SELECT a.refundable_amount FROM private.order_refund_amounts(v_order) AS a) THEN
        RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
      v_amount:=_refund_amount;
    END IF;
    v_due:=GREATEST(v_fees-v_goods,0);
    IF v_amount=0 THEN v_waived:=true;v_status:='waived';
    ELSE v_refund:=pg_catalog.gen_random_uuid(); END IF;
  ELSE v_due:=v_fees;
  END IF;
  -- 非0円の返金を頼めない注文には受け取りを残さない。0円と受け取りだけの道は Stripe を必要としない。
  IF v_refund IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.orders AS o WHERE o.id=v_order AND o.status IN ('paid','shipped','cancelled')
      AND o.paid_amount IS NOT NULL AND o.paid_amount>0
      AND pg_catalog.left(o.payment_intent_id,3)='pi_' AND pg_catalog.char_length(o.payment_intent_id)>3
  ) THEN RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE='22023'; END IF;
  BEGIN
    INSERT INTO public.order_return_receipts(id,return_id,request_key,request_fingerprint,kind,refund_choice,refund_id,
      notify_customer,sent_back_message,sent_back_carrier,sent_back_tracking_number,note,actor_id,actor_can_refund)
    VALUES(v_receipt,_return_id,_request_key,v_fp,'receive',_refund_choice,v_refund,_notify_customer,
      _sent_back_message,_sent_back_carrier,_sent_back_tracking_number,_note,_actor_id,_actor_can_refund);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END;
  INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
  SELECT v_receipt,x.return_line_id,x.disposition,x.quantity,x.resolution,x.exchange_method
  FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text);
  IF v_waived THEN
    -- 0円で終える数は、今回の実際の返金の数だけ。普通の返金で既に覆われた数は再び覆わない。
    INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
    SELECT v_receipt,w.return_line_id,'refund_waived',w.waived,NULL,NULL FROM (
      SELECT u.return_line_id,LEAST(u.quantity,GREATEST(c.quantity-COALESCE(pg_catalog.sum(u.quantity) OVER(
          PARTITION BY u.order_item_id ORDER BY u.return_line_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::integer,0)) AS waived
      FROM (
        SELECT x.return_line_id,l.order_item_id,pg_catalog.sum(x.quantity)::integer AS quantity
        FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,resolution text,quantity integer)
        JOIN public.order_return_lines AS l ON l.id=x.return_line_id
        WHERE x.resolution='refund' GROUP BY x.return_line_id,l.order_item_id
      ) AS u JOIN pg_catalog.jsonb_to_recordset(v_lines) AS c(order_item_id uuid,quantity integer) ON c.order_item_id=u.order_item_id
    ) AS w WHERE w.waived>0;
  END IF;
  IF v_refund IS NOT NULL THEN
    SELECT r.refund_id,r.amount,r.status INTO v_refund,v_amount,v_status
    FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,_refund_shipping_amount,v_amount,
      _note,'requested_by_customer',NULL,_notify_customer,_actor_id,_refund_amount,_return_id,LEAST(v_fees,v_goods)) AS r;
  END IF;
  -- 新たに付く未収手数料は前の免除に含まれないため、受領を戻す時は免除の印も外す。
  UPDATE public.order_returns AS rt SET fee_due_amount=rt.fee_due_amount+v_due,
    fee_pending_deduction=rt.fee_pending_deduction+v_pending,
    fee_waived=CASE WHEN v_due>0 THEN false ELSE rt.fee_waived END,
    fee_received_at=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_at END,
    fee_received_by=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_by END,
    fee_received_note=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_note END WHERE rt.id=_return_id;
  IF v_exchange>0 THEN
    PERFORM pg_catalog.set_config('app.order_actor_id',_actor_id::text,true);
    PERFORM pg_catalog.set_config('app.order_change_reason','return_exchange_added',true);
    PERFORM pg_catalog.set_config('app.order_source_event_id','',true);
    UPDATE public.orders AS o SET status='paid',shipped_at=NULL,shipping_carrier=NULL,tracking_number=NULL
    WHERE o.id=v_order AND o.status='shipped';
  END IF;
  IF NOT _actor_can_refund AND pg_catalog.jsonb_array_length(v_lines)>0 THEN
    v_shop:=private.enqueue_return_email(v_order,'return_refund_pending_shop',_return_id,v_receipt);
  END IF;
  IF _notify_customer AND v_refund IS NULL THEN
    PERFORM private.enqueue_return_email(v_order,CASE WHEN v_sent=(SELECT pg_catalog.sum(x.quantity)
      FROM pg_catalog.jsonb_to_recordset(v_units) AS x(quantity integer)) THEN 'return_sent_back' ELSE 'return_received' END,_return_id,v_receipt);
  END IF;
  return_status:=private.refresh_order_return_status(_return_id);
  SELECT rt.fee_due_amount INTO fee_due_amount FROM public.order_returns AS rt WHERE rt.id=_return_id;
  RETURN QUERY SELECT v_receipt,return_status,v_refund,v_amount,v_status,
    ARRAY(SELECT x FROM pg_catalog.unnest(v_exchange_ids) AS x ORDER BY x),fee_due_amount,v_shop,false;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_refund_return(
  _return_id uuid,_actor_id uuid,_request_key uuid,_amount integer,
  _shipping_amount integer,_note text,_notify_customer boolean
) RETURNS TABLE(refund_id uuid,amount integer,status text,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns%ROWTYPE;v_order uuid;v_fp text;v_old public.order_refunds%ROWTYPE;
  v_lines jsonb;v_goods integer;v_cap integer;v_amount integer;v_result record;v_receipt public.order_return_receipts%ROWTYPE;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL OR _notify_customer IS NULL
    OR _shipping_amount IS NULL OR _shipping_amount<0 OR (_amount IS NOT NULL AND _amount<0)
    OR pg_catalog.char_length(_note)>500 THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  v_fp:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'amount',_amount,
    'shipping_amount',_shipping_amount,'note',_note,'notify_customer',_notify_customer)::text);
  -- 鍵は注文 → 返品（Task 2 の部品。返品が無ければ RETURN_NOT_FOUND）
  v_return:=private.lock_order_return(_return_id);
  v_order:=v_return.order_id;
  SELECT r.* INTO v_old FROM public.order_refunds AS r WHERE r.request_key=_request_key;
  IF FOUND THEN
    IF v_old.return_id IS DISTINCT FROM _return_id OR v_old.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT v_old.id,v_old.amount,v_old.status,true;RETURN;
  END IF;
  SELECT rr.* INTO v_receipt FROM public.order_return_receipts AS rr WHERE rr.request_key=_request_key;
  IF FOUND THEN
    IF v_receipt.return_id IS DISTINCT FROM _return_id OR v_receipt.kind<>'waive_refund'
      OR v_receipt.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT NULL::uuid,0,'waived'::text,true;RETURN;
  END IF;
  -- closed の失敗した返金も受け直せる。P19 の保存した状態を巻き戻す必要はない。
  IF v_return.status NOT IN ('open','closed') THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.order_refunds AS r WHERE r.order_id=v_order ORDER BY r.id FOR UPDATE;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',t.order_item_id,
      'before_shipment',false,'quantity',t.quantity) ORDER BY t.order_item_id),'[]'::jsonb),
    COALESCE(pg_catalog.sum(private.return_units_amount(t.order_item_id,t.quantity)),0)::integer
    INTO v_lines,v_goods FROM (
      SELECT l.order_item_id,pg_catalog.sum(g.refund_waiting)::integer AS quantity
      FROM private.order_return_line_progress(_return_id) AS g JOIN public.order_return_lines AS l ON l.id=g.return_line_id
      WHERE g.refund_waiting>0 GROUP BY l.order_item_id
    ) AS t;
  IF pg_catalog.jsonb_array_length(v_lines)=0 THEN RAISE EXCEPTION 'RETURN_NOTHING_TO_REFUND' USING ERRCODE='22023'; END IF;
  -- 計算どおり（相談の手数料を引いた額）が既定。店長が直した額の上限は返せる額（E-2 の値。仕様書 6-3・P8）で、
  -- 計算との差は core が adjustment_amount に残す
  v_cap:=GREATEST(v_goods-v_return.fee_pending_deduction,0)+_shipping_amount;
  v_amount:=COALESCE(_amount,v_cap);
  IF v_amount<_shipping_amount
    OR (_amount IS NOT NULL AND _amount>(SELECT a.refundable_amount FROM private.order_refund_amounts(v_order) AS a)) THEN
    RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  IF v_amount=0 THEN
    -- 返金の記録もメールも作らず、支払いの移動を伴わない処理済みの数を追記する。
    BEGIN
      INSERT INTO public.order_return_receipts(return_id,request_key,request_fingerprint,kind,refund_choice,refund_id,
        notify_customer,note,actor_id,actor_can_refund)
      VALUES(_return_id,_request_key,v_fp,'waive_refund',NULL,NULL,_notify_customer,_note,_actor_id,true)
      RETURNING * INTO v_receipt;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END;
    INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
    SELECT v_receipt.id,g.return_line_id,'refund_waived',g.refund_waiting,NULL,NULL
    FROM private.order_return_line_progress(_return_id) AS g WHERE g.refund_waiting>0;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.orders AS o WHERE o.id=v_order AND o.status IN ('paid','shipped','cancelled')
      AND o.paid_amount IS NOT NULL AND o.paid_amount>0 AND pg_catalog.left(o.payment_intent_id,3)='pi_'
      AND pg_catalog.char_length(o.payment_intent_id)>3) THEN
      RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE='22023'; END IF;
  SELECT r.* INTO v_result FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,
    _shipping_amount,v_amount,_note,'requested_by_customer',NULL,_notify_customer,_actor_id,_amount,_return_id,
    LEAST(v_return.fee_pending_deduction,v_goods)) AS r;
  END IF;
  -- 新たに付く未収手数料は前の免除に含まれないため、受領を戻す時は免除の印も外す。
  UPDATE public.order_returns AS rt SET fee_pending_deduction=0,
    fee_due_amount=rt.fee_due_amount+GREATEST(v_return.fee_pending_deduction-v_goods,0),
    fee_waived=CASE WHEN v_return.fee_pending_deduction>v_goods THEN false ELSE rt.fee_waived END,
    fee_received_at=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_at END,
    fee_received_by=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_by END,
    fee_received_note=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_note END
  WHERE rt.id=_return_id;
  PERFORM private.refresh_order_return_status(_return_id);
  IF v_amount=0 THEN RETURN QUERY SELECT NULL::uuid,0,'waived'::text,false;
  ELSE RETURN QUERY SELECT v_result.refund_id,v_result.amount,v_result.status,v_result.replayed; END IF;
END;
$$;

-- public の既存関数の署名と実行権限を保持し、新しい関数も Data API の利用者だけが呼べるようにする。
REVOKE ALL ON FUNCTION private.return_units_amount(uuid,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.return_exchange_item_id(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_line_discounts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_order_email(uuid,text,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.apply_order_refund_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.apply_return_refund_outcome(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.load_order_refund_materials(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_order_refund_materials(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.claim_order_email(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_email(integer) TO service_role;
REVOKE ALL ON FUNCTION public.list_order_email_history(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_order_email_history(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.skip_order_email(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.skip_order_email(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.request_order_email_resend(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_order_email_resend(uuid,text,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.mark_order_refund_error(uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_refund_error(uuid,text,boolean) TO service_role;

REVOKE ALL ON FUNCTION public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.get_popular_items(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_popular_items(integer) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
