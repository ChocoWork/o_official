-- 返品と交換 段2（グループ E-3 設計書 5-1・5-4・8-2・9・11 章）の移行 E：お客様の側
--
-- お客様が自分で申し込む入口の DB の関数を作る。
--   ・申し込みの画面の材料（品の状態・期限・理由の設定・交換の色・サイズ・手数料）と、写真の送り先の発行
--   ・返品の申し込み（状態 requested の返品と返品の行の仮の値・写真・送り先の使用済みの印・申し込みのメールの予定 2 つ）
--   ・キャンセルの申し込み（申し込みと行・メールの予定 2 つ）
--   ・お客様の注文の画面の「返品・交換」の欄とキャンセルの申し込みの欄
--   ・返品のメールの予定を書く private.enqueue_return_email に新しい 3 つの種類を足し（段 1 の移行 B から作り直す）、
--     キャンセルの申し込みのメールの予定を書く private.enqueue_cancel_request_email を作る
-- お客様の側の関数は、窓口が JWT の sub から取ったお客様の番号を _customer_id として受け、注文の持ち主を DB が確かめる
-- （service_role で動くので auth.uid() は使えない。今の会計の関数 place_order_from_checkout_draft の _buyer_user_id と同じ形）。
-- 期限・返品できる数・理由の設定・返品不可・写真の持ち主は、画面の値を信じず DB が数え直す。
-- 書くのは SECURITY DEFINER の関数だけ。表・守り・メールの種類と一意の索引・写真の置き場・返品不可の列は移行 D で作ってある。
-- 移行 D（20261013100000_order_return_request_records.sql）の後に当てる。
BEGIN;

-- 1. 申し込みの入口で注文を読む。注文が無い・持ち主でない・お客様に隠す状態（支払い手続き中・放棄）の注文は、
--    どれも ORDER_NOT_FOUND にする（持ち主でない注文があるかどうかを漏らさない。窓口は 404 Order not found にする）。
--    持ち主を条件に入れて読むので、_lock が真でも、持ち主でない注文の行の鍵は取らない（他人の注文を待たせる入口にしない）。
--    _lock が真の時は注文の行の鍵（FOR UPDATE）を取る: 返品の申し込みとお店の返品の作成・発送の取消・ふつうの返金は、
--    この鍵で 1 つずつ進み、後の方は前の操作の後の数で確かめる（Review Focus 4）
CREATE OR REPLACE FUNCTION private.customer_order_for_request(_order_id uuid, _customer_id uuid, _lock boolean)
RETURNS public.orders
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
BEGIN
  IF _order_id IS NULL OR _customer_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(_lock, false) THEN
    SELECT o.* INTO v_order
    FROM public.orders AS o
    WHERE o.id = _order_id
      AND o.user_id = _customer_id
    FOR UPDATE;
  ELSE
    SELECT o.* INTO v_order
    FROM public.orders AS o
    WHERE o.id = _order_id
      AND o.user_id = _customer_id;
  END IF;

  IF NOT FOUND
     OR v_order.status IN ('payment_in_progress'::public.order_status, 'abandoned'::public.order_status) THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_order;
END;
$$;

-- 2. 発送の行ごとの、お客様に見せる品の状態（設計書 5-1）。取り消していない発送の行だけ。
--    返品できる数 = 発送の行ごとの数（段 1 の fulfillment_line_returnable）と注文の商品ごとの数（order_line_return_counts）の小さい方。
--    期限の判定は日本時間の日付で行う: deadline_date >= 日本時間の今日 の間は申し込める（期限の日の 23:59:59 まで）。
--    now() は取引の中で動かないので、1 回の呼び出しの中で状態が食い違わない。接続の時間帯（TimeZone）には左右されない
--    state: selectable（返品できる数が 1 以上で期限内。selectable に数）・past_deadline（返品できる数が 1 以上で期限切れ）・
--           requested（その発送の行を指す申し込み中の返品の行か、未処理が残る受付中の返品の行がある）・
--           sent_back（お返しした数が 1 以上）・unavailable（ほか）。selectable 以外の行の selectable は 0
CREATE OR REPLACE FUNCTION private.customer_return_line_states(_order_id uuid)
RETURNS TABLE (
  fulfillment_id uuid,
  fulfillment_number integer,
  shipped_at timestamptz,
  deadline_date date,
  past_deadline boolean,
  order_item_id uuid,
  quantity integer,
  selectable integer,
  state text
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH base AS (
    SELECT fr.fulfillment_id,
           fr.fulfillment_number,
           fr.shipped_at,
           fr.deadline_date,
           (fr.deadline_date IS NOT NULL
             AND fr.deadline_date < (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date) AS past_deadline,
           fr.order_item_id,
           fr.quantity,
           LEAST(fr.returnable, COALESCE(c.returnable, 0)) AS returnable,
           COALESCE(c.sent_back, 0) AS sent_back,
           oi.created_at AS item_created_at
    FROM private.fulfillment_line_returnable(_order_id) AS fr
    JOIN public.order_items AS oi ON oi.id = fr.order_item_id
    LEFT JOIN private.order_line_return_counts(_order_id) AS c ON c.order_item_id = fr.order_item_id
  ),
  in_flight AS (
    SELECT DISTINCT s.fulfillment_id, s.order_item_id
    FROM private.order_return_line_states(_order_id) AS s
    WHERE s.return_status = 'requested'
       OR (s.return_status = 'open' AND s.unprocessed > 0)
  )
  SELECT b.fulfillment_id,
         b.fulfillment_number,
         b.shipped_at,
         b.deadline_date,
         b.past_deadline,
         b.order_item_id,
         b.quantity,
         CASE WHEN b.returnable > 0 AND NOT b.past_deadline THEN b.returnable ELSE 0 END,
         CASE
           WHEN b.returnable > 0 AND NOT b.past_deadline THEN 'selectable'
           WHEN b.returnable > 0 THEN 'past_deadline'
           WHEN EXISTS (
             SELECT 1
             FROM in_flight AS f
             WHERE f.fulfillment_id = b.fulfillment_id
               AND f.order_item_id = b.order_item_id
           ) THEN 'requested'
           WHEN b.sent_back > 0 THEN 'sent_back'
           ELSE 'unavailable'
         END
  FROM base AS b
  ORDER BY b.fulfillment_number, b.item_created_at, b.order_item_id
$$;

-- 3. 申し込みの受付の有無（設計書 5-1・5-4・8-2）と、キャンセルを申し込めるか。
--    returns: closed（設定が受け付けない・種類がキャンセルだけ）→ none（注文が支払い済みでも発送済みでもない）→
--             available（選べる品がある）→ ended（選べる品が無く、期限切れの品がある。ended_on = その行の期限の最大）→ none
--    ended_on は returns が ended の時だけ入れる（available の時は、期限切れの品があっても空）
--    cancel: 設定が受け付け、種類にキャンセルが入り、注文が未入金か支払い済みで、未発送の数（E-1 の unshipped）の合計が 1 以上で、
--            開いているキャンセルの申し込みが無い
CREATE OR REPLACE FUNCTION private.customer_return_availability(_order public.orders)
RETURNS TABLE (returns text, ended_on date, cancel boolean)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH st AS (
    SELECT s.requests_enabled, s.request_types
    FROM public.shop_return_settings AS s
    WHERE s.id = 1
  ),
  lines AS (
    SELECT l.state, l.deadline_date
    FROM private.customer_return_line_states(_order.id) AS l
  )
  SELECT CASE
           WHEN NOT st.requests_enabled OR st.request_types = 'cancellations_only' THEN 'closed'
           WHEN _order.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status) THEN 'none'
           WHEN EXISTS (SELECT 1 FROM lines WHERE lines.state = 'selectable') THEN 'available'
           WHEN EXISTS (SELECT 1 FROM lines WHERE lines.state = 'past_deadline') THEN 'ended'
           ELSE 'none'
         END,
         CASE
           WHEN st.requests_enabled
                AND st.request_types <> 'cancellations_only'
                AND _order.status IN ('paid'::public.order_status, 'shipped'::public.order_status)
                AND NOT EXISTS (SELECT 1 FROM lines WHERE lines.state = 'selectable')
           THEN (SELECT pg_catalog.max(lines.deadline_date) FROM lines WHERE lines.state = 'past_deadline')
         END,
         (st.requests_enabled
           AND st.request_types IN ('returns_and_cancellations', 'cancellations_only')
           AND _order.status IN ('pending'::public.order_status, 'paid'::public.order_status)
           AND COALESCE((SELECT pg_catalog.sum(f.unshipped) FROM private.order_line_fulfillment(_order.id) AS f), 0) > 0
           AND NOT EXISTS (
             SELECT 1
             FROM public.order_cancel_requests AS cr
             WHERE cr.order_id = _order.id
               AND cr.status = 'requested'
           ))
  FROM st
$$;

-- 4. お客様の返品の申し込みの行（JSON）の形を確かめて分ける。段 1 の private.parse_return_lines と同じ作り。
--    形（配列でない・1〜100 行でない・キーが無い・型が違う・数が 1〜999 の整数でない・理由が 10 種類のどれでもない・
--    ご希望が refund か exchange でない・詳しい内容が 300 字を超える・返金なのに色・サイズがある・写真の中身の型・
--    同じ発送の同じ商品が 2 回）が違えば RETURN_ARGUMENT_INVALID。交換なのに色・サイズが無い時は RETURN_EXCHANGE_VARIANT_INVALID
--    （段 1 の parse_return_lines と同じ）。
--    写真の値の誤り（1 つの行に 5 枚を超える・種類が image/jpeg か image/png でない・大きさが 1〜10485760 でない・
--    同じ送り先を全部の行を通して 2 回使う）は RETURN_PHOTO_INVALID（仕様書 4-10 の「写真の数・合わない写真」。
--    お客様の言葉も「1 つの商品に 5 枚まで」と写真の誤りとして書く）。
--    詳しい内容は前後の空白を外し、空なら null。ご希望は商品の行ごとに 1 つ（P7）
CREATE OR REPLACE FUNCTION private.parse_customer_return_lines(_lines jsonb)
RETURNS TABLE (
  fulfillment_id uuid,
  order_item_id uuid,
  quantity integer,
  reason text,
  customer_note text,
  requested_resolution text,
  requested_exchange_variant_id bigint,
  photos jsonb
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_item jsonb;
  v_photo jsonb;
  v_photo_list jsonb;
  v_seen_lines text[] := ARRAY[]::text[];
  v_seen_uploads uuid[] := ARRAY[]::uuid[];
  v_upload_id uuid;
  v_size bigint;
BEGIN
  IF _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) < 1 OR pg_catalog.jsonb_array_length(_lines) > 100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT e.value FROM pg_catalog.jsonb_array_elements(_lines) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object'
       OR pg_catalog.jsonb_typeof(v_item -> 'fulfillment_id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_item -> 'order_item_id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_item -> 'quantity') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_item -> 'reason') IS DISTINCT FROM 'string'
       OR COALESCE(pg_catalog.jsonb_typeof(v_item -> 'customer_note'), 'null') NOT IN ('string', 'null')
       OR pg_catalog.jsonb_typeof(v_item -> 'requested_resolution') IS DISTINCT FROM 'string'
       OR COALESCE(pg_catalog.jsonb_typeof(v_item -> 'requested_exchange_variant_id'), 'null') NOT IN ('number', 'null')
       OR pg_catalog.jsonb_typeof(v_item -> 'photos') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;

    BEGIN
      fulfillment_id := (v_item ->> 'fulfillment_id')::uuid;
      order_item_id := (v_item ->> 'order_item_id')::uuid;
      -- 1.5 のような小数は整数に直せずに失敗する（黙って丸めない）
      quantity := (v_item ->> 'quantity')::integer;
      requested_exchange_variant_id := (v_item ->> 'requested_exchange_variant_id')::bigint;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END;
    reason := v_item ->> 'reason';
    requested_resolution := v_item ->> 'requested_resolution';
    -- 空白だけの文は持たない（外す空白は 半角のスペース・タブ・改行・全角の空白 U+3000。窓口の JS の trim() に近づける）
    customer_note := NULLIF(pg_catalog.btrim(v_item ->> 'customer_note', E' \t\r\n\u3000'), '');

    IF quantity < 1
       OR quantity > 999
       OR reason NOT IN (
         'defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style',
         'not_as_described', 'unwanted', 'other', 'unknown'
       )
       OR requested_resolution NOT IN ('refund', 'exchange')
       OR (customer_note IS NOT NULL AND pg_catalog.char_length(customer_note) > 300)
       OR (requested_resolution = 'refund' AND requested_exchange_variant_id IS NOT NULL) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF requested_resolution = 'exchange' AND requested_exchange_variant_id IS NULL THEN
      RAISE EXCEPTION 'RETURN_EXCHANGE_VARIANT_INVALID' USING ERRCODE = '22023';
    END IF;

    -- 同じ発送の同じ商品は 1 行にまとめて送る（ご希望は商品の行ごとに 1 つ。P7）
    IF (fulfillment_id::text || ':' || order_item_id::text) = ANY (v_seen_lines) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_seen_lines := v_seen_lines || (fulfillment_id::text || ':' || order_item_id::text);

    v_photo_list := v_item -> 'photos';
    IF pg_catalog.jsonb_array_length(v_photo_list) > 5 THEN
      RAISE EXCEPTION 'RETURN_PHOTO_INVALID' USING ERRCODE = '22023';
    END IF;
    photos := '[]'::jsonb;
    FOR v_photo IN SELECT e.value FROM pg_catalog.jsonb_array_elements(v_photo_list) AS e(value) LOOP
      IF pg_catalog.jsonb_typeof(v_photo) <> 'object'
         OR pg_catalog.jsonb_typeof(v_photo -> 'upload_id') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(v_photo -> 'content_type') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(v_photo -> 'size_bytes') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_upload_id := (v_photo ->> 'upload_id')::uuid;
        v_size := (v_photo ->> 'size_bytes')::bigint;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END;
      IF (v_photo ->> 'content_type') NOT IN ('image/jpeg', 'image/png')
         OR v_size < 1
         OR v_size > 10485760
         OR v_upload_id = ANY (v_seen_uploads) THEN
        RAISE EXCEPTION 'RETURN_PHOTO_INVALID' USING ERRCODE = '22023';
      END IF;
      v_seen_uploads := v_seen_uploads || v_upload_id;
      photos := photos || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'upload_id', v_upload_id,
          'content_type', v_photo ->> 'content_type',
          'size_bytes', v_size
        )
      );
    END LOOP;

    RETURN NEXT;
  END LOOP;
END;
$$;

-- 5. 返品のメールの予定を書く（return_accepted・return_requested・return_declined・return_request_shop・
--    return_received・return_sent_back・return_refund_pending_shop）。段 1 の移行 B の本文のまま、受ける種類に
--    return_requested（申し込みの受付。お客様）・return_declined（お断り。お客様）・return_request_shop（店への知らせ）を足した。
--    返品の番号は 7 つとも入れる。受け取りの番号は、受け取りの 3 つだけに入れる（return_accepted と新しい 3 つは空）。
--    一意の索引（移行 D: 返品の 4 つの種類は返品ごと・種類ごとに 1 行、受け取りの 3 つは受け取りと種類ごとに 1 行）に
--    当たれば何も書かず、書いたかを返す。
--    返金のお知らせ（refund の return）は E-2 の private.enqueue_order_email が書くので、ここでは扱わない
CREATE OR REPLACE FUNCTION private.enqueue_return_email(
  _order_id uuid,
  _kind text,
  _return_id uuid,
  _return_receipt_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF _order_id IS NULL
     OR _return_id IS NULL
     OR _kind IS NULL
     OR _kind NOT IN (
       'return_accepted', 'return_requested', 'return_declined', 'return_request_shop',
       'return_received', 'return_sent_back', 'return_refund_pending_shop'
     )
     OR (_kind IN ('return_accepted', 'return_requested', 'return_declined', 'return_request_shop'))
        <> (_return_receipt_id IS NULL) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, return_id, return_receipt_id)
  VALUES (_order_id, _kind, NULL, 'auto', _return_id, _return_receipt_id)
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;

-- 6. キャンセルの申し込みのメールの予定を書く（cancel_request_received・cancel_request_declined・cancel_request_shop）。
--    申し込みの番号を持ち、書き分け（variant）は空。一意の索引（移行 D: 申し込みごと・種類ごとに 1 行）に当たれば
--    何も書かず、書いたかを返す
CREATE OR REPLACE FUNCTION private.enqueue_cancel_request_email(
  _order_id uuid,
  _kind text,
  _cancel_request_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF _order_id IS NULL
     OR _cancel_request_id IS NULL
     OR _kind IS NULL
     OR _kind NOT IN ('cancel_request_received', 'cancel_request_declined', 'cancel_request_shop') THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, cancel_request_id)
  VALUES (_order_id, _kind, NULL, 'auto', _cancel_request_id)
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;

-- 7. 返品・交換の申し込みの画面の材料（設計書 5-1）。キーは共通の約束 C-2 の CustomerReturnRequestMaterials の snake_case。
--    発送ごとに品の状態を並べる。出す理由は設定で「出す」にした物（unknown はいつも出さない）を決まった順に。
--    交換の色・サイズは発送した品と同じ商品の使える（is_active）物だけ。手数料は設定の値で、使わない手数料は 0
--    （返送料の定額は、お客様の負担の送り方がお店の送り状の時だけ値を持つ）。
--    持ち主でない・無い・隠す状態の注文は ORDER_NOT_FOUND。鍵は取らない（読むだけ）
CREATE OR REPLACE FUNCTION public.get_customer_return_request_materials(_order_id uuid, _customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_returns text;
  v_ended_on date;
BEGIN
  v_order := private.customer_order_for_request(_order_id, _customer_id, false);

  SELECT a.returns, a.ended_on
  INTO v_returns, v_ended_on
  FROM private.customer_return_availability(v_order) AS a;

  RETURN (
    WITH st AS (
      SELECT s.*
      FROM public.shop_return_settings AS s
      WHERE s.id = 1
    ),
    lines AS (
      SELECT l.fulfillment_id,
             l.fulfillment_number,
             l.shipped_at,
             l.deadline_date,
             l.past_deadline,
             l.order_item_id,
             l.quantity,
             l.selectable,
             l.state,
             oi.item_id,
             oi.item_name,
             oi.color,
             oi.size,
             oi.line_kind,
             oi.created_at AS item_created_at,
             COALESCE(it.return_ineligible, false) AS return_ineligible
      FROM private.customer_return_line_states(v_order.id) AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id
      LEFT JOIN public.items AS it ON it.id = oi.item_id
    )
    SELECT pg_catalog.jsonb_build_object(
      'order', pg_catalog.jsonb_build_object('id', v_order.id, 'status', v_order.status),
      'availability', pg_catalog.jsonb_build_object('returns', v_returns, 'ended_on', v_ended_on),
      'notice_text', (SELECT st.notice_text FROM st),
      'shipments', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'fulfillment_id', g.fulfillment_id,
                   'number', g.fulfillment_number,
                   'shipped_at', g.shipped_at,
                   'deadline_date', g.deadline_date,
                   'past_deadline', g.past_deadline,
                   'lines', (
                     SELECT pg_catalog.jsonb_agg(
                              pg_catalog.jsonb_build_object(
                                'order_item_id', x.order_item_id,
                                'item_id', x.item_id,
                                'item_name', x.item_name,
                                'color', x.color,
                                'size', x.size,
                                'line_kind', x.line_kind,
                                'quantity', x.quantity,
                                'selectable', x.selectable,
                                'state', x.state,
                                'return_ineligible', x.return_ineligible
                              )
                              ORDER BY x.item_created_at, x.order_item_id
                            )
                     FROM lines AS x
                     WHERE x.fulfillment_id = g.fulfillment_id
                   )
                 )
                 ORDER BY g.fulfillment_number
               )
        FROM (
          SELECT y.fulfillment_id,
                 y.fulfillment_number,
                 y.shipped_at,
                 pg_catalog.max(y.deadline_date) AS deadline_date,
                 pg_catalog.bool_or(y.past_deadline) AS past_deadline
          FROM lines AS y
          GROUP BY y.fulfillment_id, y.fulfillment_number, y.shipped_at
        ) AS g
      ), '[]'::jsonb),
      'reasons', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'reason', rs.reason,
                   'resolutions', rs.resolutions,
                   'out_of_stock_exchange', rs.out_of_stock_exchange,
                   'photo', rs.photo,
                   'photo_instructions', rs.photo_instructions,
                   'shipping_payer', rs.shipping_payer
                 )
                 ORDER BY pg_catalog.array_position(
                   ARRAY['defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style',
                         'not_as_described', 'unwanted', 'other', 'unknown']::text[],
                   rs.reason
                 )
               )
        FROM public.shop_return_reason_settings AS rs
        WHERE rs.shown
          AND rs.reason <> 'unknown'
      ), '[]'::jsonb),
      'exchange_options', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'item_id', i.item_id,
                   'variants', (
                     SELECT COALESCE(
                              pg_catalog.jsonb_agg(
                                pg_catalog.jsonb_build_object(
                                  'variant_id', v.id,
                                  'color', col.name,
                                  'size', sz.label,
                                  'stock_quantity', v.stock_quantity,
                                  'made_to_order_lead_days', it.made_to_order_lead_days
                                )
                                ORDER BY col.position NULLS FIRST, sz.position NULLS FIRST, v.id
                              ),
                              '[]'::jsonb
                            )
                     FROM public.item_variants AS v
                     JOIN public.items AS it ON it.id = v.item_id
                     LEFT JOIN public.item_colors AS col ON col.id = v.color_id
                     LEFT JOIN public.item_sizes AS sz ON sz.id = v.size_id
                     WHERE v.item_id = i.item_id
                       AND v.is_active
                   )
                 )
                 ORDER BY i.item_id
               )
        FROM (SELECT DISTINCT z.item_id FROM lines AS z WHERE z.item_id IS NOT NULL) AS i
      ), '[]'::jsonb),
      'fees', (
        SELECT pg_catalog.jsonb_build_object(
                 'customer_paid_method', st.customer_paid_method,
                 'shop_label_fee', CASE WHEN st.customer_paid_method = 'shop_label' THEN st.shop_label_fee ELSE 0 END,
                 'restocking_fee_percent', CASE WHEN st.restocking_fee_enabled THEN st.restocking_fee_percent ELSE 0 END,
                 'exchange_fee', CASE WHEN st.exchange_fees_enabled THEN st.exchange_fee ELSE 0 END,
                 'exchange_shipping_fee', CASE WHEN st.exchange_fees_enabled THEN st.exchange_shipping_fee ELSE 0 END
               )
        FROM st
      )
    )
  );
END;
$$;

-- 8. 写真の送り先を発行する（設計書 4-5）。サーバーが署名つきの送り先を出す前に、この関数が送り先の行（持ち主・注文・場所）を書く。
--    持ち主の確かめ（鍵なし）→ 受付が available でなければ断る（closed は RETURN_REQUESTS_CLOSED、ほかは RETURN_NOT_ELIGIBLE）→
--    その注文とお客様の、使っていない・消していない・1 日以内の送り先が 60 以上なら RETURN_PHOTO_INVALID（置き場を埋める使い方を止める）→
--    場所 requests/{注文の番号}/{送り先の番号} で 1 行を足す
CREATE OR REPLACE FUNCTION public.customer_create_return_photo_upload(_order_id uuid, _customer_id uuid)
RETURNS TABLE (upload_id uuid, storage_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order public.orders;
  v_returns text;
  v_upload_id uuid;
  v_path text;
BEGIN
  v_order := private.customer_order_for_request(_order_id, _customer_id, false);

  SELECT a.returns INTO v_returns FROM private.customer_return_availability(v_order) AS a;
  IF v_returns = 'closed' THEN
    RAISE EXCEPTION 'RETURN_REQUESTS_CLOSED' USING ERRCODE = '22023';
  ELSIF v_returns <> 'available' THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM public.order_return_photo_uploads AS u
    WHERE u.order_id = _order_id
      AND u.customer_id = _customer_id
      AND u.attached_at IS NULL
      AND u.purged_at IS NULL
      AND u.created_at > pg_catalog.now() - interval '1 day'
  ) >= 60 THEN
    RAISE EXCEPTION 'RETURN_PHOTO_INVALID' USING ERRCODE = '22023';
  END IF;

  v_upload_id := pg_catalog.gen_random_uuid();
  v_path := 'requests/' || _order_id::text || '/' || v_upload_id::text;
  INSERT INTO public.order_return_photo_uploads (id, order_id, customer_id, storage_path)
  VALUES (v_upload_id, _order_id, _customer_id, v_path);

  RETURN QUERY SELECT v_upload_id, v_path;
END;
$$;

-- 9. 返品を申し込む（設計書 5-1）。お客様の申し込みは、状態 requested の返品として段 1 と同じ表に書く（返品の行の数は、
--    申し込みの時から段 1 の数え方の rq に入る）。断る順番は最初に当たった物で止める（P4）:
--    引数 → 行の形（指紋を作る時）→ 注文と持ち主（注文の行の鍵）→ 二重防止の番号 → 設定の受付 → 注文の状態 → 発送の行 → 期限 →
--    返品できる数（発送の行ごと → 注文の商品ごと）→ 理由 → 詳しい内容 → ご希望 → 交換の色・サイズ → 写真
--    返品の行の resolution・exchange_variant_id・exchange_method には仮の値を入れる（P2）。承認の時だけ、この 3 つを直せる
--    （移行 D の守り）。返送の方法・負担・手数料も仮の値（P5）で、お店が承認で全部直せる。
--    答えの status は、申し込みを受けた返品の状態として、いつも requested を返す（同じ番号の送り直しの時に、
--    承認・お断りが先に進んでいても。TS の型 CustomerRequestedReturn.status が requested だけのため）
CREATE OR REPLACE FUNCTION public.customer_request_return(
  _order_id uuid,
  _customer_id uuid,
  _request_key uuid,
  _lines jsonb
)
RETURNS TABLE (return_id uuid, number integer, status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  -- 期限の比べは日本時間の日付（接続の時間帯に左右されない）。now() は取引の中で動かない
  v_today date := (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_fingerprint text;
  v_order public.orders;
  v_existing public.order_returns;
  v_settings public.shop_return_settings;
  v_payer text;
  v_method text;
  v_shipping_fee integer;
  v_restocking_percent integer;
  v_exchange_fee integer;
  v_exchange_shipping_fee integer;
  v_number integer;
  v_return_id uuid;
  v_constraint text;
  v_line record;
  v_line_id uuid;
  v_photo record;
BEGIN
  -- 1. 引数
  IF _order_id IS NULL OR _customer_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 2. 二重防止の指紋: 注文と、行を発送・商品の順に並べた JSON の md5（画面の入力を決まった順に並べた物。写真は送り先の番号を昇順にし、
  --    種類と大きさは入れない。お客様の番号は入れない）。行の形が違えばここで RETURN_ARGUMENT_INVALID 等で止まる
  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'order_id', _order_id,
      'lines', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'fulfillment_id', p.fulfillment_id,
                   'order_item_id', p.order_item_id,
                   'quantity', p.quantity,
                   'reason', p.reason,
                   'customer_note', p.customer_note,
                   'requested_resolution', p.requested_resolution,
                   'requested_exchange_variant_id', p.requested_exchange_variant_id,
                   'photo_upload_ids', COALESCE((
                     SELECT pg_catalog.jsonb_agg(x.upload_id ORDER BY x.upload_id)
                     FROM pg_catalog.jsonb_to_recordset(p.photos) AS x(upload_id uuid)
                   ), '[]'::jsonb)
                 )
                 ORDER BY p.fulfillment_id, p.order_item_id
               )
        FROM private.parse_customer_return_lines(_lines) AS p
      ), '[]'::jsonb)
    )::text
  );

  -- 3. 注文と持ち主。注文の行の鍵を取る: お店の返品の作成・発送の取消・ふつうの返金・ほかの申し込みは、この鍵で 1 つずつ進む
  --    （同時に押されても、後の方は前の操作の後の数で確かめる。Review Focus 4）
  v_order := private.customer_order_for_request(_order_id, _customer_id, true);

  -- 4. 同じ二重防止の番号の送り直し（通信が切れた後の「もう一度確かめる」。Review Focus 1）。持ち主を確かめた後に、
  --    同じ中身なら前の返品を返す: 写真の送り先が使い済みでも、設定や注文の状態が変わっていても確かめ直さず、
  --    返品・写真・メールの予定を増やさない。中身が違えば断る
  SELECT r.* INTO v_existing FROM public.order_returns AS r WHERE r.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.number, 'requested'::text, true;
    RETURN;
  END IF;

  -- 5. 設定の受付: 受け付けていて、種類に返品が入っている時だけ
  SELECT s.* INTO v_settings FROM public.shop_return_settings AS s WHERE s.id = 1;
  IF NOT v_settings.requests_enabled
     OR v_settings.request_types NOT IN ('returns_and_cancellations', 'returns_only') THEN
    RAISE EXCEPTION 'RETURN_REQUESTS_CLOSED' USING ERRCODE = '22023';
  END IF;

  -- 6. 申し込める注文は、支払い済みか発送済みだけ
  IF v_order.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status) THEN
    RAISE EXCEPTION 'ORDER_NOT_RETURNABLE' USING ERRCODE = '22023';
  END IF;

  -- 7. 発送の行: この注文の、取り消していない発送の行でなければ引数の誤り（取り消した発送はお客様の画面に出ない）
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_fulfillment_lines AS fl
      JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id
      WHERE fl.fulfillment_id = p.fulfillment_id
        AND fl.order_item_id = p.order_item_id
        AND f.order_id = _order_id
        AND f.cancelled_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 8. 期限: 日本時間の今日が期限の日より後の品は申し込めない（期限の日の 23:59:59 までは申し込める）
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN private.fulfillment_line_returnable(_order_id) AS fr
      ON fr.fulfillment_id = p.fulfillment_id AND fr.order_item_id = p.order_item_id
    WHERE fr.deadline_date IS NOT NULL
      AND fr.deadline_date < v_today
  ) THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  -- 9. 返品できる数。画面の数を信じず、二つの段を数え直す。発送の行ごと（その行の数 − 返品が指す数 + 届かなかった数）と、
  --    注文の商品ごと（発送した数 − 返金した数 − 申し込み・受付中・返金待ち・交換・お返しの数）。別の発送の同じ商品は合計で確かめる
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    LEFT JOIN private.fulfillment_line_returnable(_order_id) AS fr
      ON fr.fulfillment_id = p.fulfillment_id AND fr.order_item_id = p.order_item_id
    WHERE p.quantity > COALESCE(fr.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT p.order_item_id, pg_catalog.sum(p.quantity)::integer AS requested
      FROM private.parse_customer_return_lines(_lines) AS p
      GROUP BY p.order_item_id
    ) AS g
    LEFT JOIN private.order_line_return_counts(_order_id) AS c ON c.order_item_id = g.order_item_id
    WHERE g.requested > COALESCE(c.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- 10. 理由: 設定で「出す」にした理由だけ（unknown はいつも出さない）。返品不可の商品は破損・不良と注文と違う品だけ
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.order_items AS oi ON oi.id = p.order_item_id
    LEFT JOIN public.items AS it ON it.id = oi.item_id
    LEFT JOIN public.shop_return_reason_settings AS rs ON rs.reason = p.reason
    WHERE p.reason = 'unknown'
       OR rs.shown IS NOT TRUE
       OR (COALESCE(it.return_ineligible, false) AND p.reason NOT IN ('defective', 'wrong_item'))
  ) THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  -- 11. 詳しい内容: 破損・不良とその他は必須（前後の空白を外して 1〜300 字。300 字の上限は行の形の確かめで済んでいる）
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    WHERE p.reason IN ('defective', 'other')
      AND p.customer_note IS NULL
  ) THEN
    RAISE EXCEPTION 'RETURN_CUSTOMER_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- 12. ご希望: 理由の設定の「ご希望」に無い物は受けない（交換だけの理由に返金、返金だけの理由に交換）
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.shop_return_reason_settings AS rs ON rs.reason = p.reason
    WHERE (rs.resolutions = 'exchange_only' AND p.requested_resolution <> 'exchange')
       OR (rs.resolutions = 'refund_only' AND p.requested_resolution <> 'refund')
  ) THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  -- 13. 交換の色・サイズ: 同じ商品の使える（is_active）物だけ。在庫が申し込む数より少ない物は、
  --     理由の設定の在庫の無い交換が make（作って送る）の時だけ選べる（decline なら受けない）
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.order_items AS oi ON oi.id = p.order_item_id
    WHERE p.requested_resolution = 'exchange'
      AND NOT EXISTS (
        SELECT 1
        FROM public.item_variants AS v
        WHERE v.id = p.requested_exchange_variant_id
          AND v.item_id = oi.item_id
          AND v.is_active
      )
  ) THEN
    RAISE EXCEPTION 'RETURN_EXCHANGE_VARIANT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.shop_return_reason_settings AS rs ON rs.reason = p.reason
    JOIN public.item_variants AS v ON v.id = p.requested_exchange_variant_id
    WHERE p.requested_resolution = 'exchange'
      AND v.stock_quantity < p.quantity
      AND rs.out_of_stock_exchange = 'decline'
  ) THEN
    RAISE EXCEPTION 'RETURN_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  -- 14. 写真: 理由の設定の「写真」に合う枚数（なしは 0 枚、必須は 1 枚以上、任意は 5 枚まで）で、
  --     全部の送り先がこの注文とこのお客様の、まだ使っていない・消していない物であること。
  --     作ってから 23 時間以内であること（消す処理の「1 日を過ぎた使っていない送り先」と重ならないよう 1 時間あける。P6）。
  --     写真の値（種類・大きさ・5 枚まで・同じ送り先の重複）は行の形の確かめで済んでいる
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.shop_return_reason_settings AS rs ON rs.reason = p.reason
    WHERE (rs.photo = 'none' AND pg_catalog.jsonb_array_length(p.photos) > 0)
       OR (rs.photo = 'required' AND pg_catalog.jsonb_array_length(p.photos) = 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_PHOTO_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(p.photos) AS e(photo)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_return_photo_uploads AS u
      WHERE u.id = (e.photo ->> 'upload_id')::uuid
        AND u.order_id = _order_id
        AND u.customer_id = _customer_id
        AND u.attached_at IS NULL
        AND u.purged_at IS NULL
        AND u.created_at > pg_catalog.now() - interval '23 hours'
    )
  ) THEN
    RAISE EXCEPTION 'RETURN_PHOTO_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 15. 返送の方法と負担、手数料の仮の値（P5）。負担は、申し込んだ行の理由のどれかがお店の負担ならお店、ほかはお客様。
  --     方法は、お店の負担なら customer_ships（着払い）、お客様の負担なら設定のお客様負担の時の送り方。
  --     返送料の定額は、お客様の負担でお店の送り状（shop_label）の時だけ付く。返品の手数料・交換の手数料と送料は、
  --     設定で使う時だけ設定の値を入れる（段 1 の作ると同じ）。お店は承認で全部直せる
  IF EXISTS (
    SELECT 1
    FROM private.parse_customer_return_lines(_lines) AS p
    JOIN public.shop_return_reason_settings AS rs ON rs.reason = p.reason
    WHERE rs.shipping_payer = 'shop'
  ) THEN
    v_payer := 'shop';
  ELSE
    v_payer := 'customer';
  END IF;
  v_method := CASE WHEN v_payer = 'shop' THEN 'customer_ships' ELSE v_settings.customer_paid_method END;
  v_shipping_fee := CASE WHEN v_method = 'shop_label' AND v_payer = 'customer' THEN v_settings.shop_label_fee ELSE 0 END;
  v_restocking_percent := CASE WHEN v_settings.restocking_fee_enabled THEN v_settings.restocking_fee_percent ELSE 0 END;
  v_exchange_fee := CASE WHEN v_settings.exchange_fees_enabled THEN v_settings.exchange_fee ELSE 0 END;
  v_exchange_shipping_fee := CASE WHEN v_settings.exchange_fees_enabled THEN v_settings.exchange_shipping_fee ELSE 0 END;

  -- 16. 記録。番号は注文の鍵の中で「その注文の返品の数 + 1」（お断り・取消の返品も数える。番号が飛ばない）。
  --     お客様の申し込みは承認の前なので、approved_*・shop_note・created_by は空のまま。知らせる印は常に真
  SELECT pg_catalog.count(*)::integer + 1 INTO v_number FROM public.order_returns AS r WHERE r.order_id = _order_id;

  BEGIN
    INSERT INTO public.order_returns AS r
      (order_id, number, source, status, request_key, request_fingerprint, requested_at, requested_by,
       return_method, return_shipping_payer, return_shipping_fee, restocking_fee_percent,
       exchange_fee, exchange_shipping_fee, notify_customer)
    VALUES
      (_order_id, v_number, 'customer_request', 'requested', _request_key, v_fingerprint, pg_catalog.now(), _customer_id,
       v_method, v_payer, v_shipping_fee, v_restocking_percent,
       v_exchange_fee, v_exchange_shipping_fee, true)
    RETURNING r.id INTO v_return_id;
  EXCEPTION WHEN unique_violation THEN
    -- 同じ番号をほかの注文の申し込みが同時に使った（同じ注文の送り直しは、鍵の後の確かめで前の記録を返している）
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_returns_request_key_key' THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  -- 17. 返品の行。解決の仮の値はご希望と同じ。交換は、その色・サイズの在庫が申し込む数以上なら stock、足りなければ make
  --     （足りない時に選べるのは、理由の設定が make の時だけ。上の 13 で確かめ済み）。
  --     写真は返品の行ごとに写真の行を書き、送り先に使った時刻（attached_at）を書く
  FOR v_line IN
    SELECT p.fulfillment_id,
           p.order_item_id,
           p.quantity,
           p.reason,
           p.customer_note,
           p.requested_resolution,
           p.requested_exchange_variant_id,
           p.photos,
           (SELECT v.stock_quantity FROM public.item_variants AS v WHERE v.id = p.requested_exchange_variant_id) AS exchange_stock
    FROM private.parse_customer_return_lines(_lines) AS p
    ORDER BY p.fulfillment_id, p.order_item_id
  LOOP
    INSERT INTO public.order_return_lines AS l
      (return_id, fulfillment_id, order_item_id, quantity, reason, customer_note,
       requested_resolution, requested_exchange_variant_id, resolution, exchange_variant_id, exchange_method)
    VALUES
      (v_return_id, v_line.fulfillment_id, v_line.order_item_id, v_line.quantity, v_line.reason, v_line.customer_note,
       v_line.requested_resolution, v_line.requested_exchange_variant_id, v_line.requested_resolution,
       v_line.requested_exchange_variant_id,
       CASE
         WHEN v_line.requested_resolution = 'exchange' THEN
           CASE WHEN v_line.exchange_stock >= v_line.quantity THEN 'stock' ELSE 'make' END
       END)
    RETURNING l.id INTO v_line_id;

    FOR v_photo IN
      SELECT x.upload_id, x.content_type, x.size_bytes
      FROM pg_catalog.jsonb_to_recordset(v_line.photos) AS x(upload_id uuid, content_type text, size_bytes integer)
    LOOP
      INSERT INTO public.order_return_photos (return_line_id, upload_id, storage_path, content_type, size_bytes)
      SELECT v_line_id, u.id, u.storage_path, v_photo.content_type, v_photo.size_bytes
      FROM public.order_return_photo_uploads AS u
      WHERE u.id = v_photo.upload_id;

      UPDATE public.order_return_photo_uploads AS u
      SET attached_at = pg_catalog.now()
      WHERE u.id = v_photo.upload_id;
    END LOOP;
  END LOOP;

  -- 18. 申し込みのメールの予定: お客様への受付と、店への知らせ（それぞれ返品ごとに 1 行）
  PERFORM private.enqueue_return_email(_order_id, 'return_requested', v_return_id, NULL::uuid);
  PERFORM private.enqueue_return_email(_order_id, 'return_request_shop', v_return_id, NULL::uuid);

  RETURN QUERY SELECT v_return_id, v_number, 'requested'::text, false;
END;
$$;

-- 10. キャンセルを申し込む（設計書 5-4）。まだ発送していない品と数・ご連絡事項（300 字まで）で申し込む。注文はまだ変わらない。
--     断る順番: 引数（行は 1〜100 で、各 { order_item_id: 文字, quantity: 1〜999 }、同じ品は 1 回、ご連絡事項は前後の空白を外して
--     空なら null・300 字まで）→ 持ち主（注文の行の鍵）→ 二重防止の番号 → 設定の受付と種類（RETURN_REQUESTS_CLOSED）→
--     注文の状態（未入金か支払い済み。CANCEL_REQUEST_NOT_ELIGIBLE）→ 開いている申し込み（CANCEL_REQUEST_EXISTS）→
--     品がこの注文の品で、数が未発送の数まで（CANCEL_REQUEST_QUANTITY_EXCEEDS）。
--     答えの status は、返品の申し込みと同じく、いつも requested を返す
CREATE OR REPLACE FUNCTION public.customer_request_cancel(
  _order_id uuid,
  _customer_id uuid,
  _request_key uuid,
  _lines jsonb,
  _customer_note text
)
RETURNS TABLE (cancel_request_id uuid, status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  -- 外す空白は 半角のスペース・タブ・改行・全角の空白 U+3000（parse_customer_return_lines の詳しい内容と同じ）
  v_note text := NULLIF(pg_catalog.btrim(_customer_note, E' \t\r\n\u3000'), '');
  v_item jsonb;
  v_item_id uuid;
  v_quantity integer;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_fingerprint text;
  v_order public.orders;
  v_existing public.order_cancel_requests;
  v_settings public.shop_return_settings;
  v_cancel_id uuid;
  v_constraint text;
BEGIN
  -- 1. 引数
  IF _order_id IS NULL OR _customer_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND pg_catalog.char_length(v_note) > 300 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) < 1 OR pg_catalog.jsonb_array_length(_lines) > 100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT e.value FROM pg_catalog.jsonb_array_elements(_lines) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object'
       OR pg_catalog.jsonb_typeof(v_item -> 'order_item_id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_item -> 'quantity') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_item_id := (v_item ->> 'order_item_id')::uuid;
      v_quantity := (v_item ->> 'quantity')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END;
    IF v_quantity < 1 OR v_quantity > 999 OR v_item_id = ANY (v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_item_id;
  END LOOP;

  -- 2. 二重防止の指紋: 注文と、行を品の順に並べた JSON とご連絡事項の md5
  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'order_id', _order_id,
      'lines', (
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object('order_item_id', x.order_item_id, 'quantity', x.quantity)
                 ORDER BY x.order_item_id
               )
        FROM pg_catalog.jsonb_to_recordset(_lines) AS x(order_item_id uuid, quantity integer)
      ),
      'customer_note', v_note
    )::text
  );

  -- 3. 持ち主（注文の行の鍵）
  v_order := private.customer_order_for_request(_order_id, _customer_id, true);

  -- 4. 同じ二重防止の番号の送り直し: 持ち主を確かめた後に、同じ中身なら前の申し込みを返す（記録もメールの予定も増やさない）
  SELECT c.* INTO v_existing FROM public.order_cancel_requests AS c WHERE c.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_existing.id, 'requested'::text, true;
    RETURN;
  END IF;

  -- 5. 設定の受付: 受け付けていて、種類にキャンセルが入っている時だけ
  SELECT s.* INTO v_settings FROM public.shop_return_settings AS s WHERE s.id = 1;
  IF NOT v_settings.requests_enabled
     OR v_settings.request_types NOT IN ('returns_and_cancellations', 'cancellations_only') THEN
    RAISE EXCEPTION 'RETURN_REQUESTS_CLOSED' USING ERRCODE = '22023';
  END IF;

  -- 6. 申し込める注文は、未入金か支払い済み
  IF v_order.status NOT IN ('pending'::public.order_status, 'paid'::public.order_status) THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_NOT_ELIGIBLE' USING ERRCODE = '22023';
  END IF;

  -- 7. 開いている申し込みは注文に 1 つだけ（移行 D の一意の索引も守る）
  IF EXISTS (
    SELECT 1
    FROM public.order_cancel_requests AS c
    WHERE c.order_id = _order_id
      AND c.status = 'requested'
  ) THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_EXISTS' USING ERRCODE = '22023';
  END IF;

  -- 8. 品がこの注文の品で、数が未発送の数まで（この注文の品でない時も同じ断り）
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(_lines) AS x(order_item_id uuid, quantity integer)
    LEFT JOIN private.order_line_fulfillment(_order_id) AS f ON f.order_item_id = x.order_item_id
    WHERE f.order_item_id IS NULL
       OR x.quantity > f.unshipped
  ) THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- 9. 記録
  BEGIN
    INSERT INTO public.order_cancel_requests AS c
      (order_id, status, request_key, request_fingerprint, customer_note, requested_by)
    VALUES
      (_order_id, 'requested', _request_key, v_fingerprint, v_note, _customer_id)
    RETURNING c.id INTO v_cancel_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_cancel_requests_request_key_key' THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  INSERT INTO public.order_cancel_request_lines (cancel_request_id, order_item_id, quantity)
  SELECT v_cancel_id, x.order_item_id, x.quantity
  FROM pg_catalog.jsonb_to_recordset(_lines) AS x(order_item_id uuid, quantity integer);

  -- 10. 申し込みのメールの予定: お客様への受付と、店への知らせ（それぞれ申し込みごとに 1 行）
  PERFORM private.enqueue_cancel_request_email(_order_id, 'cancel_request_received', v_cancel_id);
  PERFORM private.enqueue_cancel_request_email(_order_id, 'cancel_request_shop', v_cancel_id);

  RETURN QUERY SELECT v_cancel_id, 'requested'::text, false;
END;
$$;

-- 11. お客様の注文の画面の「返品・交換」の欄とキャンセルの申し込み（設計書 8-2）。キーは共通の約束 C-2 の CustomerOrderReturns の
--     snake_case（label は DB が作らず、TS が番号から付ける）。取消の返品は入れない。返品と申し込みは新しい順。
--     customer_status は P10 の決め方（上から先に当たった物）:
--       お断り → declined、申し込み → requested、画面の状態が返金待ち → refund_preparing、完了 → returned、
--       受付中でお支払い待ちの印 → awaiting_fee、受け取った品があり未処理が残る → partially_received、
--       未処理が無く検品待ちがある → inspecting、ほか → accepted
--     返送先は受付中（open）の間だけ出す。refund_amount はその返品の返金（返事待ち・保留・成功）の額の合計で、無ければ null。
--     お店のメモ・お断りの理由の記号・した人のメール・返金の失敗の中身・手数料の受け取りの記録は入れない（P19）。
--     exchange_shipping: 交換の品が無ければ none、1 つでも送りきっていなければ pending、全部送っていれば shipped。
--     持ち主でない・無い・隠す状態の注文は ORDER_NOT_FOUND。鍵は取らない（読むだけ）
CREATE OR REPLACE FUNCTION public.get_customer_order_returns(_order_id uuid, _customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_returns text;
  v_ended_on date;
  v_cancel boolean;
BEGIN
  v_order := private.customer_order_for_request(_order_id, _customer_id, false);

  SELECT a.returns, a.ended_on, a.cancel
  INTO v_returns, v_ended_on, v_cancel
  FROM private.customer_return_availability(v_order) AS a;

  RETURN pg_catalog.jsonb_build_object(
    'returns', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'id', r.id,
                 'number', r.number,
                 'status', r.status,
                 'customer_status', CASE
                   WHEN r.status = 'declined' THEN 'declined'
                   WHEN r.status = 'requested' THEN 'requested'
                   WHEN ds.display_status = 'refund_waiting' THEN 'refund_preparing'
                   WHEN ds.display_status = 'returned' THEN 'returned'
                   WHEN 'awaiting_fee' = ANY (ds.marks) THEN 'awaiting_fee'
                   WHEN 'partially_received' = ANY (ds.marks) THEN 'partially_received'
                   WHEN ds.unprocessed = 0 AND 'pending_inspection' = ANY (ds.marks) THEN 'inspecting'
                   ELSE 'accepted'
                 END,
                 'return_method', r.return_method,
                 'return_shipping_payer', r.return_shipping_payer,
                 'return_shipping_fee', r.return_shipping_fee,
                 'return_address', CASE
                   WHEN r.status = 'open' AND private.shop_return_address_set() THEN (
                     SELECT pg_catalog.jsonb_build_object(
                              'name', st.return_address_name,
                              'postal_code', st.return_address_postal_code,
                              'address', st.return_address_line,
                              'phone', st.return_address_phone
                            )
                     FROM public.shop_return_settings AS st
                     WHERE st.id = 1
                   )
                 END,
                 'requested_at', r.requested_at,
                 'closed_at', r.closed_at,
                 'lines', COALESCE((
                   SELECT pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                              'item_name', oi.item_name,
                              'color', oi.color,
                              'size', oi.size,
                              'quantity', l.quantity,
                              'requested_resolution', l.requested_resolution,
                              'requested_exchange', CASE
                                WHEN l.requested_exchange_variant_id IS NOT NULL THEN pg_catalog.jsonb_build_object(
                                  'color', rc.name,
                                  'size', rz.label
                                )
                              END,
                              'resolution', l.resolution,
                              'exchange', CASE
                                WHEN l.exchange_variant_id IS NOT NULL THEN pg_catalog.jsonb_build_object(
                                  'color', ec.name,
                                  'size', ez.label
                                )
                              END
                            )
                            ORDER BY f.number, oi.created_at, l.created_at, l.id
                          )
                   FROM public.order_return_lines AS l
                   JOIN public.order_fulfillments AS f ON f.id = l.fulfillment_id
                   JOIN public.order_items AS oi ON oi.id = l.order_item_id
                   LEFT JOIN public.item_variants AS rv ON rv.id = l.requested_exchange_variant_id
                   LEFT JOIN public.item_colors AS rc ON rc.id = rv.color_id
                   LEFT JOIN public.item_sizes AS rz ON rz.id = rv.size_id
                   LEFT JOIN public.item_variants AS ev ON ev.id = l.exchange_variant_id
                   LEFT JOIN public.item_colors AS ec ON ec.id = ev.color_id
                   LEFT JOIN public.item_sizes AS ez ON ez.id = ev.size_id
                   WHERE l.return_id = r.id
                 ), '[]'::jsonb),
                 'refund_amount', (
                   SELECT pg_catalog.sum(rf.amount)::integer
                   FROM public.order_refunds AS rf
                   WHERE rf.return_id = r.id
                     AND rf.status IN ('awaiting_response', 'pending', 'succeeded')
                 ),
                 'sent_back', COALESCE((
                   SELECT pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                              'item_name', oi.item_name,
                              'color', oi.color,
                              'size', oi.size,
                              'quantity', rl.quantity,
                              'message', rc.sent_back_message,
                              'carrier', rc.sent_back_carrier,
                              'tracking_number', rc.sent_back_tracking_number
                            )
                            ORDER BY rc.created_at, rc.id, l.created_at, l.id
                          )
                   FROM public.order_return_receipts AS rc
                   JOIN public.order_return_receipt_lines AS rl ON rl.receipt_id = rc.id AND rl.disposition = 'sent_back'
                   JOIN public.order_return_lines AS l ON l.id = rl.return_line_id
                   JOIN public.order_items AS oi ON oi.id = l.order_item_id
                   WHERE rc.return_id = r.id
                 ), '[]'::jsonb),
                 'decline_message', CASE WHEN r.status = 'declined' THEN r.decline_message END,
                 'exchange_shipping', CASE
                   WHEN NOT EXISTS (
                     SELECT 1
                     FROM public.order_items AS xi
                     JOIN public.order_return_lines AS xl ON xl.id = xi.exchange_return_line_id
                     WHERE xl.return_id = r.id
                   ) THEN 'none'
                   WHEN EXISTS (
                     SELECT 1
                     FROM public.order_items AS xi
                     JOIN public.order_return_lines AS xl ON xl.id = xi.exchange_return_line_id
                     JOIN private.order_line_fulfillment(_order_id) AS lf ON lf.order_item_id = xi.id
                     WHERE xl.return_id = r.id
                       AND lf.shipped < xi.quantity
                   ) THEN 'pending'
                   ELSE 'shipped'
                 END
               )
               ORDER BY r.number DESC
             )
      FROM public.order_returns AS r
      CROSS JOIN LATERAL private.return_display_state(r.id) AS ds
      WHERE r.order_id = _order_id
        AND r.status <> 'cancelled'
    ), '[]'::jsonb),
    'cancel_requests', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'id', c.id,
                 'status', c.status,
                 'requested_at', c.requested_at,
                 'lines', COALESCE((
                   SELECT pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                              'item_name', oi.item_name,
                              'color', oi.color,
                              'size', oi.size,
                              'quantity', cl.quantity
                            )
                            ORDER BY oi.created_at, oi.id
                          )
                   FROM public.order_cancel_request_lines AS cl
                   JOIN public.order_items AS oi ON oi.id = cl.order_item_id
                   WHERE cl.cancel_request_id = c.id
                 ), '[]'::jsonb),
                 'decline_message', CASE WHEN c.status = 'declined' THEN c.decline_message END
               )
               ORDER BY c.requested_at DESC, c.id DESC
             )
      FROM public.order_cancel_requests AS c
      WHERE c.order_id = _order_id
    ), '[]'::jsonb),
    'availability', pg_catalog.jsonb_build_object(
      'returns', v_returns,
      'ended_on', v_ended_on,
      'cancel', v_cancel
    )
  );
END;
$$;

-- 12. 権限。新しい public の関数は service_role だけ。private の関数は PUBLIC から外すだけ
--     （作り直した private.enqueue_return_email も付け直す）
REVOKE ALL ON FUNCTION private.customer_order_for_request(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.customer_return_line_states(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.customer_return_availability(public.orders) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.parse_customer_return_lines(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_return_email(uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_cancel_request_email(uuid, text, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.get_customer_return_request_materials(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_create_return_photo_upload(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_request_return(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_request_cancel(uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_customer_order_returns(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_customer_return_request_materials(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_create_return_photo_upload(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_request_return(uuid, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_request_cancel(uuid, uuid, uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_customer_order_returns(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
