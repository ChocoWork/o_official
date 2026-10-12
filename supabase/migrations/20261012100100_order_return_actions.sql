-- 返品と交換（グループ E-3 設計書 3・4・5・7・9・11 章）の移行 B
--
-- お店が作る返品の操作（作る・取消（まだ送っていない受付のお知らせを取りやめる）・届かないで終える・開き直し・検品を終える・
-- 手数料の受け取りの記録（「いただかないで終える」を含む）・支払いを待たずに送る）の関数、
-- 返品の画面・一覧・要約・数・絞り込みのための読み出しの関数、ショップの返品の設定を書く関数、
-- 返品のメールの予定を書く関数を作り、発送の取消に「返品が指す発送は取り消せない」守りを足す。
-- 受け取り（admin_receive_return）と額を決めて返金（admin_refund_return）は、E-2 の返金の関数を作り直す移行 C で作る。
-- 移行 A（20261012100000_order_return_records.sql）の後に当てる。
BEGIN;

-- 1. 返品の商品の行（JSON）の形を確かめて分ける。形が違えば RETURN_ARGUMENT_INVALID で止める
--    （理由が「その他」でメモが無い時は RETURN_REASON_NOTE_REQUIRED、交換なのに色・サイズが無い時は RETURN_EXCHANGE_VARIANT_INVALID）。
--    1〜100行。同じ発送の同じ商品を、返金と交換に分けて2行にしてもよい（数の上限は呼ぶ側が合計で確かめる）。数は1〜999の整数
CREATE OR REPLACE FUNCTION private.parse_return_lines(_lines jsonb)
RETURNS TABLE (
  fulfillment_id uuid,
  order_item_id uuid,
  quantity integer,
  reason text,
  reason_note text,
  resolution text,
  exchange_variant_id bigint,
  exchange_method text
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_item jsonb;
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
       OR pg_catalog.jsonb_typeof(v_item -> 'resolution') IS DISTINCT FROM 'string'
       OR COALESCE(pg_catalog.jsonb_typeof(v_item -> 'reason_note'), 'null') NOT IN ('string', 'null')
       OR COALESCE(pg_catalog.jsonb_typeof(v_item -> 'exchange_variant_id'), 'null') NOT IN ('number', 'null')
       OR COALESCE(pg_catalog.jsonb_typeof(v_item -> 'exchange_method'), 'null') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;

    BEGIN
      fulfillment_id := (v_item ->> 'fulfillment_id')::uuid;
      order_item_id := (v_item ->> 'order_item_id')::uuid;
      -- 1.5 のような小数は整数に直せずに失敗する（黙って丸めない）
      quantity := (v_item ->> 'quantity')::integer;
      exchange_variant_id := (v_item ->> 'exchange_variant_id')::bigint;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END;
    reason := v_item ->> 'reason';
    resolution := v_item ->> 'resolution';
    exchange_method := v_item ->> 'exchange_method';
    -- 空白だけのメモは持たない
    reason_note := NULLIF(pg_catalog.btrim(v_item ->> 'reason_note'), '');

    IF quantity < 1
       OR quantity > 999
       OR reason NOT IN (
         'defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style',
         'not_as_described', 'unwanted', 'other', 'unknown'
       )
       OR resolution NOT IN ('refund', 'exchange')
       OR (exchange_method IS NOT NULL AND exchange_method NOT IN ('stock', 'make'))
       OR (reason_note IS NOT NULL AND pg_catalog.char_length(reason_note) > 255) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF reason = 'other' AND reason_note IS NULL THEN
      RAISE EXCEPTION 'RETURN_REASON_NOTE_REQUIRED' USING ERRCODE = '22023';
    END IF;
    IF resolution = 'refund' AND (exchange_variant_id IS NOT NULL OR exchange_method IS NOT NULL) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF resolution = 'exchange' THEN
      IF exchange_method IS NULL THEN
        RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      IF exchange_variant_id IS NULL THEN
        RAISE EXCEPTION 'RETURN_EXCHANGE_VARIANT_INVALID' USING ERRCODE = '22023';
      END IF;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;

-- 2. 検品を終える関数の行（JSON）の形を確かめて分ける。1〜100行。同じ返品の行は1回だけ。数は0〜999で、1行で合わせて1以上
CREATE OR REPLACE FUNCTION private.parse_return_inspect_lines(_lines jsonb)
RETURNS TABLE (return_line_id uuid, restocked integer, not_restocked integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_item jsonb;
  v_seen uuid[] := ARRAY[]::uuid[];
BEGIN
  IF _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) < 1 OR pg_catalog.jsonb_array_length(_lines) > 100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT e.value FROM pg_catalog.jsonb_array_elements(_lines) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object'
       OR pg_catalog.jsonb_typeof(v_item -> 'return_line_id') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_item -> 'restocked') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_item -> 'not_restocked') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    BEGIN
      return_line_id := (v_item ->> 'return_line_id')::uuid;
      restocked := (v_item ->> 'restocked')::integer;
      not_restocked := (v_item ->> 'not_restocked')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END;
    IF restocked < 0
       OR restocked > 999
       OR not_restocked < 0
       OR not_restocked > 999
       OR restocked + not_restocked < 1
       OR return_line_id = ANY (v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || return_line_id;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- 3. 返品の操作の共通の部品

-- 3-1. 返品を鍵の順（注文 → 返品）で取って返す。返品が無ければ RETURN_NOT_FOUND。
--      注文の鍵は、発送の取消・返金・ほかの返品の操作と同じ鍵なので、同じ注文の操作は1つずつ進む
CREATE OR REPLACE FUNCTION private.lock_order_return(_return_id uuid)
RETURNS public.order_returns
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_order_id uuid;
  v_return public.order_returns;
BEGIN
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE;
  SELECT r.* INTO v_return FROM public.order_returns AS r WHERE r.id = _return_id FOR UPDATE;
  RETURN v_return;
END;
$$;

-- 3-2. 同じ二重防止の番号の受け取りの記録（届かない・開き直し・検品・受け取り）を探す。
--      同じ返品・同じ指紋なら前の記録の番号を返し、違えば RETURN_REQUEST_MISMATCH。無ければ空
CREATE OR REPLACE FUNCTION private.find_return_receipt(_request_key uuid, _return_id uuid, _fingerprint text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_existing public.order_return_receipts;
BEGIN
  SELECT c.* INTO v_existing FROM public.order_return_receipts AS c WHERE c.request_key = _request_key;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_existing.return_id <> _return_id OR v_existing.request_fingerprint IS DISTINCT FROM _fingerprint THEN
    RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
  END IF;
  RETURN v_existing.id;
END;
$$;

-- 3-3. 返金を伴わない受け取りの記録（届かない・開き直し・検品）を1行書いて番号を返す。
--      ほかの返品が同じ番号を同時に使った時（一意の制約）は RETURN_REQUEST_MISMATCH
CREATE OR REPLACE FUNCTION private.insert_return_receipt(
  _return_id uuid,
  _request_key uuid,
  _fingerprint text,
  _kind text,
  _actor_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_receipt_id uuid;
  v_constraint text;
BEGIN
  BEGIN
    INSERT INTO public.order_return_receipts AS c
      (return_id, request_key, request_fingerprint, kind, notify_customer, actor_id)
    VALUES
      (_return_id, _request_key, _fingerprint, _kind, false, _actor_id)
    RETURNING c.id INTO v_receipt_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_return_receipts_request_key_key' THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;
  RETURN v_receipt_id;
END;
$$;

-- 3-4. 返品のメールの予定を書く（return_accepted・return_received・return_sent_back・return_refund_pending_shop）。
--      返品の番号は4つとも入れ、受け取りの番号は受け取りの3つだけに入れる。
--      一意の索引（返品の受付は返品ごと、ほかは受け取りと種類ごと）に当たれば何も書かず、書いたかを返す。
--      返金のお知らせ（refund の return）は E-2 の private.enqueue_order_email が書くので、ここでは扱わない
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
     OR _kind NOT IN ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop')
     OR (_kind = 'return_accepted') <> (_return_receipt_id IS NULL) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, return_id, return_receipt_id)
  VALUES (_order_id, _kind, NULL, 'auto', _return_id, _return_receipt_id)
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;

-- 3-5. 返金の商品の額（設計書 4-8・6-3）。前に already 点を返した後に units 点を返す額。
--      注文の商品は E-2 の割り振り（単価 × 点数 − 割引の差）、交換の品の行は exchange_paid_amount を数で累積に割り振る。
--      注文の数を超える点数は、注文の数で頭打ちにする（先にふつうの返金で返した品が重なっても、額が壊れない）。
--      画面の見込み（refund_amounts_by_count）の式。受け取り・額を決めて返金の関数（移行 C の private.return_units_amount）も
--      同じ式で同じ額を出す（同じ値になることは移行 C の結合試験が確かめる）
CREATE OR REPLACE FUNCTION private.return_refund_amount(
  _line_kind text,
  _item_price integer,
  _ordered integer,
  _line_discount integer,
  _exchange_paid integer,
  _already integer,
  _units integer
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN _units <= 0 THEN 0
    WHEN _line_kind = 'exchange' THEN
      private.refund_units_discount(_exchange_paid, _ordered, LEAST(_already + _units, _ordered))
      - private.refund_units_discount(_exchange_paid, _ordered, LEAST(_already, _ordered))
    ELSE
      _item_price * (LEAST(_already + _units, _ordered) - LEAST(_already, _ordered))
      - (private.refund_units_discount(_line_discount, _ordered, LEAST(_already + _units, _ordered))
         - private.refund_units_discount(_line_discount, _ordered, LEAST(_already, _ordered)))
  END
$$;

-- 3-6. ショップの返送先が入っているか（名前・郵便番号・住所・電話番号の4つとも空でない）
CREATE OR REPLACE FUNCTION private.shop_return_address_set()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT COALESCE(pg_catalog.btrim(s.return_address_name), '') <> ''
       AND COALESCE(pg_catalog.btrim(s.return_address_postal_code), '') <> ''
       AND COALESCE(pg_catalog.btrim(s.return_address_line), '') <> ''
       AND COALESCE(pg_catalog.btrim(s.return_address_phone), '') <> ''
    FROM public.shop_return_settings AS s
    WHERE s.id = 1
  ), false)
$$;

-- 3-7. 返品の画面での状態（設計書 3-2）と、返品中の小さな印、未処理の数、返金待ちの数。
--      返金待ち = 受付中で、全部の品が処理され、検品待ちが無く、返金待ちの数 rw が1以上。
--      完了した返品でも rw が1以上なら返金待ち（返品の返金が失敗して、覆いが外れた後。本計画 P21）。
--      小さな印は返品中の時だけ: 受け取り待ち（何も届いていないで、未処理がある）・一部受け取り（届いた品があり、未処理も残る）・
--      検品待ち・お支払い待ち（手数料が未払い。支払いを待たずに送るを押しても残る）。取消・お断りの返品の状態は空
CREATE OR REPLACE FUNCTION private.return_display_state(_return_id uuid)
RETURNS TABLE (display_status text, marks text[], unprocessed integer, refund_waiting integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT t.display_status,
         CASE
           WHEN t.display_status = 'in_progress' THEN ARRAY(
             SELECT m.mark
             FROM (VALUES
               (1, 'awaiting_items', t.received = 0 AND t.unprocessed_units > 0),
               (2, 'partially_received', t.received > 0 AND t.unprocessed_units > 0),
               (3, 'pending_inspection', t.pending > 0),
               (4, 'awaiting_fee', t.fee_waiting)
             ) AS m(ord, mark, applies)
             WHERE m.applies
             ORDER BY m.ord
           )
           ELSE ARRAY[]::text[]
         END,
         t.unprocessed_units,
         t.waiting_units
  FROM (
    SELECT CASE
             WHEN r.status = 'requested' THEN 'requested'
             WHEN r.status = 'closed' AND p.waiting_units > 0 THEN 'refund_waiting'
             WHEN r.status = 'closed' THEN 'returned'
             WHEN r.status = 'open' AND p.unprocessed_units = 0 AND p.pending = 0 AND p.waiting_units > 0 THEN 'refund_waiting'
             WHEN r.status = 'open' THEN 'in_progress'
           END AS display_status,
           p.received,
           p.unprocessed_units,
           p.pending,
           p.waiting_units,
           (r.fee_due_amount > 0 AND r.fee_received_at IS NULL) AS fee_waiting
    FROM public.order_returns AS r
    CROSS JOIN LATERAL (
      SELECT COALESCE(pg_catalog.sum(g.restocked + g.not_restocked + g.pending_inspection + g.sent_back), 0)::integer AS received,
             COALESCE(pg_catalog.sum(g.unprocessed), 0)::integer AS unprocessed_units,
             COALESCE(pg_catalog.sum(g.pending_inspection), 0)::integer AS pending,
             COALESCE(pg_catalog.sum(g.refund_waiting), 0)::integer AS waiting_units
      FROM private.order_return_line_progress(r.id) AS g
    ) AS p
    WHERE r.id = _return_id
  ) AS t
$$;

-- 4. 返品1件の中身（設計書 4・6 章。管理画面の返品の画面が使う）。キーは共通の約束 C-2 の OrderReturnDetail の snake_case
--    （label は DB が作らず、TS が番号から付ける）。
--    refund_amounts_by_count は、今から k 点を返金した時の、その注文の商品の額（添字 k−1、長さはこの返品でその注文の商品を指す行の
--    未処理の数の合計。同じ注文の商品の行は同じ列。受付中の返品だけ。交換の予定の行にも入れる — 受け取りで「返金に変える」を選んだ時の
--    見込みに使う）。受け取り（移行 C）は注文の商品ごとに今回の数を足してから1回で額を出すので、見込みも注文の商品ごとに1つの列にする
--    （行ごとに作ると割引の端数で1円ずれる）。先にふつうの返金で返した数は前に返した数として足し、注文の数で頭打ちにする。
--    refund_waiting_amount は返金待ちの品の商品の額（受け取りの行に残した実際の解決で数えた rw）で、同じ注文の商品を指す
--    前の行の返金待ちの数を前に返した数として足す（額を決めて返金する時に商品ごとに1行にまとまる額と、行ごとの額の合計が一致する）
CREATE OR REPLACE FUNCTION private.return_detail_json(_return_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_display_status text;
  v_marks text[];
  v_created_by_email text;
  v_lines jsonb;
  v_refunds jsonb;
  v_receipts jsonb;
  v_exchange_items jsonb;
  v_first_receipt boolean;
  v_first_exchange boolean;
BEGIN
  SELECT r.* INTO v_return FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT s.display_status, s.marks INTO v_display_status, v_marks
  FROM private.return_display_state(_return_id) AS s;

  SELECT u.email::text INTO v_created_by_email FROM auth.users AS u WHERE u.id = v_return.created_by;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', y.id,
               'fulfillment_id', y.fulfillment_id,
               'fulfillment_number', y.fulfillment_number,
               'order_item_id', y.order_item_id,
               'item_name', y.item_name,
               'color', y.color,
               'size', y.size,
               'quantity', y.quantity,
               'reason', y.reason,
               'reason_note', y.reason_note,
               'resolution', y.resolution,
               'exchange', CASE
                 WHEN y.resolution = 'exchange' THEN pg_catalog.jsonb_build_object(
                   'variant_id', y.exchange_variant_id,
                   'color', y.exchange_color,
                   'size', y.exchange_size,
                   'method', y.exchange_method,
                   'stock_quantity', y.exchange_stock,
                   'made_to_order_lead_days', y.exchange_lead_days,
                   'out_of_stock_exchange', y.out_of_stock_exchange
                 )
               END,
               'progress', pg_catalog.jsonb_build_object(
                 'restocked', y.restocked,
                 'not_restocked', y.not_restocked,
                 'pending_inspection', y.pending_inspection,
                 'sent_back', y.sent_back,
                 'missing', y.missing,
                 'processed', y.processed,
                 'unprocessed', y.unprocessed,
                 'exchanged', y.exchanged,
                 'refund_covered', y.refund_covered,
                 'refund_waived', y.refund_waived,
                 'refund_waiting', y.refund_waiting
               ),
               'refund_amounts_by_count', CASE
                 WHEN v_return.status = 'open' THEN ARRAY(
                   SELECT private.return_refund_amount(
                            y.line_kind, y.item_price, y.ordered, y.line_discount, y.exchange_paid_amount,
                            y.already_refunded, g.k
                          )
                   FROM pg_catalog.generate_series(1, y.item_unprocessed) AS g(k)
                   ORDER BY g.k
                 )
                 ELSE ARRAY[]::integer[]
               END,
               'refund_waiting_amount', private.return_refund_amount(
                 y.line_kind, y.item_price, y.ordered, y.line_discount, y.exchange_paid_amount,
                 y.already_refunded + y.earlier_waiting, y.refund_waiting
               )
             )
             ORDER BY y.fulfillment_number, y.item_created_at, y.order_item_id, y.resolution, y.id
           ),
           '[]'::jsonb
         )
  INTO v_lines
  FROM (
    SELECT l.id,
           l.fulfillment_id,
           l.order_item_id,
           l.quantity,
           l.reason,
           l.reason_note,
           l.resolution,
           l.exchange_variant_id,
           l.exchange_method,
           f.number AS fulfillment_number,
           oi.item_name,
           oi.color,
           oi.size,
           oi.line_kind,
           oi.item_price,
           oi.exchange_paid_amount,
           oi.quantity AS ordered,
           oi.created_at AS item_created_at,
           COALESCE(d.line_discount, 0) AS line_discount,
           COALESCE(lf.refunded_before_shipment, 0) + COALESCE(lf.refunded_after_shipment, 0) AS already_refunded,
           p.restocked,
           p.not_restocked,
           p.pending_inspection,
           p.sent_back,
           p.missing,
           p.processed,
           p.unprocessed,
           p.exchanged,
           p.refund_covered,
           p.refund_waived,
           p.refund_waiting,
           COALESCE(
             pg_catalog.sum(p.refund_waiting) OVER (
               PARTITION BY l.order_item_id
               ORDER BY l.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ),
             0
           )::integer AS earlier_waiting,
           -- この返品で同じ注文の商品を指す行の未処理の合計（refund_amounts_by_count の長さ。同じ商品の行は同じ列。共通の約束 C-2）
           (pg_catalog.sum(p.unprocessed) OVER (PARTITION BY l.order_item_id))::integer AS item_unprocessed,
           ec.name AS exchange_color,
           es.label AS exchange_size,
           ev.stock_quantity AS exchange_stock,
           ei.made_to_order_lead_days AS exchange_lead_days,
           rs.out_of_stock_exchange
    FROM public.order_return_lines AS l
    JOIN public.order_fulfillments AS f ON f.id = l.fulfillment_id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id
    JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id = l.id
    LEFT JOIN private.order_line_discounts(v_return.order_id) AS d ON d.order_item_id = l.order_item_id
    LEFT JOIN private.order_line_fulfillment(v_return.order_id) AS lf ON lf.order_item_id = l.order_item_id
    LEFT JOIN public.item_variants AS ev ON ev.id = l.exchange_variant_id
    LEFT JOIN public.item_colors AS ec ON ec.id = ev.color_id
    LEFT JOIN public.item_sizes AS es ON es.id = ev.size_id
    LEFT JOIN public.items AS ei ON ei.id = ev.item_id
    LEFT JOIN public.shop_return_reason_settings AS rs ON rs.reason = l.reason
    WHERE l.return_id = _return_id
  ) AS y;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', rf.id,
               'amount', rf.amount,
               'status', rf.status,
               'created_at', rf.created_at
             )
             ORDER BY rf.created_at DESC, rf.id DESC
           ),
           '[]'::jsonb
         )
  INTO v_refunds
  FROM public.order_refunds AS rf
  WHERE rf.return_id = _return_id;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', c.id,
               'kind', c.kind,
               'refund_choice', c.refund_choice,
               'created_at', c.created_at,
               'actor_email', u.email::text
             )
             ORDER BY c.created_at DESC, c.id DESC
           ),
           '[]'::jsonb
         )
  INTO v_receipts
  FROM public.order_return_receipts AS c
  LEFT JOIN auth.users AS u ON u.id = c.actor_id
  WHERE c.return_id = _return_id;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'order_item_id', oi.id,
               'item_name', oi.item_name,
               'color', oi.color,
               'size', oi.size,
               'quantity', oi.quantity,
               'fulfillment_type', oi.fulfillment_type,
               'shipped', lf.shipped
             )
             ORDER BY oi.created_at, oi.id
           ),
           '[]'::jsonb
         )
  INTO v_exchange_items
  FROM public.order_items AS oi
  JOIN public.order_return_lines AS l ON l.id = oi.exchange_return_line_id AND l.return_id = _return_id
  JOIN private.order_line_fulfillment(v_return.order_id) AS lf ON lf.order_item_id = oi.id;

  -- 返送料は「返金の品か交換の品を受け取った最初の受け取り」で1回、交換の手数料と送料は「交換の品を受け取った最初の受け取り」で1回付く。
  -- 受け取り（receive）で検品待ち・戻した・戻さないにした品が1点でもあれば、その最初の受け取りは済んでいる（お返しだけの受け取りは数えない）。
  -- 交換かどうかは、返品の行の予定ではなく、受け取りの行に残した実際の解決（resolution）で見る（返品の行は作った後に変えない）
  SELECT EXISTS (
           SELECT 1
           FROM public.order_return_receipts AS c
           JOIN public.order_return_receipt_lines AS rl ON rl.receipt_id = c.id
           WHERE c.return_id = _return_id
             AND c.kind = 'receive'
             AND rl.disposition IN ('restocked', 'not_restocked', 'pending_inspection')
         ),
         EXISTS (
           SELECT 1
           FROM public.order_return_receipts AS c
           JOIN public.order_return_receipt_lines AS rl ON rl.receipt_id = c.id
           WHERE c.return_id = _return_id
             AND c.kind = 'receive'
             AND rl.disposition IN ('restocked', 'not_restocked', 'pending_inspection')
             AND rl.resolution = 'exchange'
         )
  INTO v_first_receipt, v_first_exchange;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_return.id,
    'number', v_return.number,
    'status', v_return.status,
    'source', v_return.source,
    'display_status', v_display_status,
    'marks', pg_catalog.to_jsonb(COALESCE(v_marks, ARRAY[]::text[])),
    'return_method', v_return.return_method,
    'return_shipping_payer', v_return.return_shipping_payer,
    'return_carrier', v_return.return_carrier,
    'return_tracking_number', v_return.return_tracking_number,
    'fees', pg_catalog.jsonb_build_object(
      'return_shipping_fee', v_return.return_shipping_fee,
      'restocking_fee_percent', v_return.restocking_fee_percent,
      'exchange_fee', v_return.exchange_fee,
      'exchange_shipping_fee', v_return.exchange_shipping_fee,
      'fee_due_amount', v_return.fee_due_amount,
      'fee_pending_deduction', v_return.fee_pending_deduction,
      'fee_received_at', v_return.fee_received_at,
      'exchange_released_at', v_return.exchange_released_at
    ),
    'first_receipt_done', v_first_receipt,
    'first_exchange_receipt_done', v_first_exchange,
    'shop_note', v_return.shop_note,
    'notify_customer', v_return.notify_customer,
    'created_at', v_return.created_at,
    'created_by_email', v_created_by_email,
    'closed_at', v_return.closed_at,
    'cancelled_at', v_return.cancelled_at,
    'lines', v_lines,
    'refunds', v_refunds,
    'receipts', v_receipts,
    'exchange_items', v_exchange_items
  );
END;
$$;

-- 5. 返品を作る（設計書 5-3）。申し込みが無い時にお店が作る入口で、すぐ受付中になる。
--    断る順番は、最初に当たった物で止める: 引数 → 手数料 → 行の形（指紋を作る時）→ 注文 → 二重防止の番号 → 返品できる注文か
--    → 返送先 → 返送不要の設定 → 行の発送 → 返品できる数（発送の行ごと → 注文の商品ごと）→ 交換の色・サイズ
CREATE OR REPLACE FUNCTION public.admin_create_return(
  _order_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _lines jsonb,
  _return_method text,
  _return_shipping_payer text,
  _return_carrier text,
  _return_tracking_number text,
  _return_shipping_fee integer,
  _restocking_fee_percent integer,
  _exchange_fee integer,
  _exchange_shipping_fee integer,
  _shop_note text,
  _notify_customer boolean
)
RETURNS TABLE (return_id uuid, number integer, status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_fingerprint text;
  v_note text;
  v_order public.orders;
  v_existing public.order_returns;
  v_settings public.shop_return_settings;
  v_shipping_fee integer;
  v_restocking_percent integer;
  v_exchange_fee integer;
  v_exchange_shipping_fee integer;
  v_number integer;
  v_return_id uuid;
  v_constraint text;
BEGIN
  -- 1. 引数
  IF _order_id IS NULL
     OR _actor_id IS NULL
     OR _request_key IS NULL
     OR _notify_customer IS NULL
     OR _return_method IS NULL
     OR _return_method NOT IN ('customer_ships', 'shop_label', 'not_required')
     OR _return_shipping_payer IS NULL
     OR _return_shipping_payer NOT IN ('shop', 'customer')
     OR (_return_carrier IS NOT NULL AND _return_carrier NOT IN ('yamato', 'sagawa', 'japanpost', 'other'))
     OR (_return_tracking_number IS NOT NULL AND _return_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
     OR (_return_method = 'not_required' AND (_return_carrier IS NOT NULL OR _return_tracking_number IS NOT NULL))
     OR (_shop_note IS NOT NULL AND pg_catalog.char_length(_shop_note) > 500) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 2. 手数料。引数が空なら設定の値を使うので、ここでは渡された値だけを確かめる（円は0〜1,000,000＝計画の冒頭の Global Constraints の金額の入力の上限、返品の手数料は0〜100%）
  IF (_return_shipping_fee IS NOT NULL AND (_return_shipping_fee < 0 OR _return_shipping_fee > 1000000))
     OR (_exchange_fee IS NOT NULL AND (_exchange_fee < 0 OR _exchange_fee > 1000000))
     OR (_exchange_shipping_fee IS NOT NULL AND (_exchange_shipping_fee < 0 OR _exchange_shipping_fee > 1000000))
     OR (_restocking_fee_percent IS NOT NULL AND (_restocking_fee_percent < 0 OR _restocking_fee_percent > 100)) THEN
    RAISE EXCEPTION 'RETURN_FEE_INVALID' USING ERRCODE = '22023';
  END IF;

  v_note := NULLIF(pg_catalog.btrim(_shop_note), '');

  -- 3. 二重防止の指紋: 呼ぶ側が渡した入力を、渡されたままの値で決まった順に並べた JSON の md5。
  --    行は発送・商品・解決・理由…の順に並べ替えるので、並びだけが違う送り直しは同じ中身。
  --    設定から入る手数料は、渡された空のまま入れる（設定が後で変わっても、同じ送り直しとして見分ける）。実行した人は入れない
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
                   'reason_note', p.reason_note,
                   'resolution', p.resolution,
                   'exchange_variant_id', p.exchange_variant_id,
                   'exchange_method', p.exchange_method
                 )
                 ORDER BY p.fulfillment_id, p.order_item_id, p.resolution, p.reason,
                          p.exchange_variant_id NULLS FIRST, p.exchange_method NULLS FIRST, p.quantity,
                          p.reason_note NULLS FIRST
               )
        FROM private.parse_return_lines(_lines) AS p
      ), '[]'::jsonb),
      'return_method', _return_method,
      'return_shipping_payer', _return_shipping_payer,
      'return_carrier', _return_carrier,
      'return_tracking_number', _return_tracking_number,
      'return_shipping_fee', _return_shipping_fee,
      'restocking_fee_percent', _restocking_fee_percent,
      'exchange_fee', _exchange_fee,
      'exchange_shipping_fee', _exchange_shipping_fee,
      'shop_note', _shop_note,
      'notify_customer', _notify_customer
    )::text
  );

  -- 4. 注文の行の鍵。返金・発送・発送の取消・ほかの返品の操作は、この鍵で1つずつ進む
  --    （同時に押されても、後の方は前の操作の後の数で確かめる）
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 5. 同じ二重防止の番号の送り直し（通信が切れた後の「もう一度確かめる」）。同じ中身なら前の記録を返し、
  --    注文の状態や数が変わっていても確かめ直さない。受付のお知らせも二度は書かない。中身が違えば断る
  SELECT r.* INTO v_existing FROM public.order_returns AS r WHERE r.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.number, v_existing.status, true;
    RETURN;
  END IF;

  -- 6. 返品を作れる注文は、支払い済みか発送済みだけ
  IF v_order.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status) THEN
    RAISE EXCEPTION 'ORDER_NOT_RETURNABLE' USING ERRCODE = '22023';
  END IF;

  -- 7. 返送先が空の間は、返送不要の返品も含めて作れない（設計書 8-3）
  IF NOT private.shop_return_address_set() THEN
    RAISE EXCEPTION 'RETURN_ADDRESS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT s.* INTO v_settings FROM public.shop_return_settings AS s WHERE s.id = 1;

  -- 8. 返送不要は、設定で出している時だけ選べる
  IF _return_method = 'not_required' AND NOT v_settings.no_return_needed_enabled THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 9. 行の発送。この注文の発送の行でなければ引数の誤り。取り消した発送の品は、返品できる数が無い物として扱う
  IF EXISTS (
    SELECT 1
    FROM private.parse_return_lines(_lines) AS p
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_fulfillment_lines AS fl
      JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id
      WHERE fl.fulfillment_id = p.fulfillment_id
        AND fl.order_item_id = p.order_item_id
        AND f.order_id = _order_id
    )
  ) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_return_lines(_lines) AS p
    JOIN public.order_fulfillments AS f ON f.id = p.fulfillment_id
    WHERE f.cancelled_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- 10. 返品できる数。画面の数を信じず、二つの段を数え直す。発送の行ごと（その行の数 − 返品が指す数 + 届かなかった数）と、
  --     注文の商品ごと（発送した数 − 返金した数 − 申し込み・受付中・返金待ち・交換・お返しの数）。同じ商品を返金と交換の2行に分けた時は合計で確かめる
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT p.fulfillment_id, p.order_item_id, pg_catalog.sum(p.quantity)::integer AS requested
      FROM private.parse_return_lines(_lines) AS p
      GROUP BY p.fulfillment_id, p.order_item_id
    ) AS g
    LEFT JOIN private.fulfillment_line_returnable(_order_id) AS fr
      ON fr.fulfillment_id = g.fulfillment_id AND fr.order_item_id = g.order_item_id
    WHERE g.requested > COALESCE(fr.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT p.order_item_id, pg_catalog.sum(p.quantity)::integer AS requested
      FROM private.parse_return_lines(_lines) AS p
      GROUP BY p.order_item_id
    ) AS g
    LEFT JOIN private.order_line_return_counts(_order_id) AS c ON c.order_item_id = g.order_item_id
    WHERE g.requested > COALESCE(c.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- 11. 交換の色・サイズは、同じ商品の使える（有効な）物だけ
  IF EXISTS (
    SELECT 1
    FROM private.parse_return_lines(_lines) AS p
    JOIN public.order_items AS oi ON oi.id = p.order_item_id
    WHERE p.resolution = 'exchange'
      AND NOT EXISTS (
        SELECT 1
        FROM public.item_variants AS v
        WHERE v.id = p.exchange_variant_id
          AND v.item_id = oi.item_id
          AND v.is_active
      )
  ) THEN
    RAISE EXCEPTION 'RETURN_EXCHANGE_VARIANT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 12. 手数料。引数が空なら設定の値、設定で使わない手数料は0。
  --     返送料の定額は、お客様の負担でお店の送り状（shop_label）の時だけ付く。shop_label でない返品と、返送料の負担がお店の返品は、
  --     渡された値があっても0にする（受付のお知らせは、負担がお店なら送り方にかかわらず「当店が負担」と書く。共通の約束 C-6）
  v_shipping_fee := CASE
    WHEN _return_method <> 'shop_label' OR _return_shipping_payer = 'shop' THEN 0
    WHEN _return_shipping_fee IS NOT NULL THEN _return_shipping_fee
    ELSE v_settings.shop_label_fee
  END;
  v_restocking_percent := COALESCE(
    _restocking_fee_percent,
    CASE WHEN v_settings.restocking_fee_enabled THEN v_settings.restocking_fee_percent ELSE 0 END
  );
  v_exchange_fee := COALESCE(
    _exchange_fee,
    CASE WHEN v_settings.exchange_fees_enabled THEN v_settings.exchange_fee ELSE 0 END
  );
  v_exchange_shipping_fee := COALESCE(
    _exchange_shipping_fee,
    CASE WHEN v_settings.exchange_fees_enabled THEN v_settings.exchange_shipping_fee ELSE 0 END
  );

  -- 13. 記録。番号は注文の鍵の中で「その注文の返品の数 + 1」（お断り・取消の返品も数える。番号が飛ばない）
  SELECT pg_catalog.count(*)::integer + 1 INTO v_number FROM public.order_returns AS r WHERE r.order_id = _order_id;

  BEGIN
    INSERT INTO public.order_returns AS r
      (order_id, number, source, status, request_key, request_fingerprint, approved_at, approved_by,
       return_method, return_shipping_payer, return_carrier, return_tracking_number,
       return_shipping_fee, restocking_fee_percent, exchange_fee, exchange_shipping_fee,
       notify_customer, shop_note, created_by)
    VALUES
      (_order_id, v_number, 'shop', 'open', _request_key, v_fingerprint, pg_catalog.now(), _actor_id,
       _return_method, _return_shipping_payer, _return_carrier, _return_tracking_number,
       v_shipping_fee, v_restocking_percent, v_exchange_fee, v_exchange_shipping_fee,
       _notify_customer, v_note, _actor_id)
    RETURNING r.id INTO v_return_id;
  EXCEPTION WHEN unique_violation THEN
    -- 同じ番号をほかの注文の返品が同時に使った（同じ注文の送り直しは、鍵の後の確かめで前の記録を返している）
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_returns_request_key_key' THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  INSERT INTO public.order_return_lines
    (return_id, fulfillment_id, order_item_id, quantity, reason, reason_note, resolution, exchange_variant_id, exchange_method)
  SELECT v_return_id, p.fulfillment_id, p.order_item_id, p.quantity, p.reason, p.reason_note, p.resolution,
         p.exchange_variant_id, p.exchange_method
  FROM private.parse_return_lines(_lines) AS p;

  -- 14. 受付のお知らせの予定（「お客様に知らせる」の時だけ）
  IF _notify_customer THEN
    PERFORM private.enqueue_return_email(_order_id, 'return_accepted', v_return_id, NULL::uuid);
  END IF;

  RETURN QUERY SELECT v_return_id, v_number, 'open'::text, false;
END;
$$;

-- 6. 返品を取り消す（設計書 7-3）。受付中で、まだ何も処理していない（受け取り・お返し・届かないが1点も無い）時だけ。
--    品はまた返品できるようになる。お客様に取消のメールは送らず、作った時に入れた受付のお知らせがまだ送られていなければ取りやめる
--    （取り消した返品の受付を知らせない）。状態に合わない操作は RETURN_STATE_CONFLICT
CREATE OR REPLACE FUNCTION public.admin_cancel_return(_return_id uuid, _actor_id uuid)
RETURNS TABLE (return_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_return := private.lock_order_return(_return_id);

  IF v_return.status <> 'open'
     OR EXISTS (
       SELECT 1
       FROM private.order_return_line_progress(_return_id) AS p
       WHERE p.processed > 0
     ) THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  UPDATE public.order_returns AS r
  SET status = 'cancelled',
      cancelled_at = pg_catalog.now(),
      cancelled_by = _actor_id
  WHERE r.id = _return_id;

  -- まだ送っていない受付のお知らせ（送る前・やり直し待ち）は取りやめる（取り消した返品の受付を知らせない。設計書 7-3）。
  -- 送っている途中の行と送り済みの行は触らない（途中の行を止めるかは、メールの worker 側の仕事）
  UPDATE private.order_email_outbox AS e
  SET status = 'skipped',
      finished_at = pg_catalog.now(),
      subject = NULL,
      body_text = NULL,
      body_erased_at = CASE WHEN e.subject IS NOT NULL THEN pg_catalog.now() ELSE e.body_erased_at END,
      last_error_code = 'return_cancelled'
  WHERE e.return_id = _return_id
    AND e.kind = 'return_accepted'
    AND e.status IN ('pending', 'retry_wait');

  RETURN QUERY SELECT _return_id, 'cancelled'::text;
END;
$$;

-- 7. 残りを届かないものとして返品を終える（設計書 6-1）。未処理の数を、返品の行ごとに missing で受け取りの記録に書く。
--    返金待ち・検品待ち・お支払い待ちが残る時は、受付中のまま（その後に返金などで自動で完了になる）。
--    受付中で未処理が1点以上ある時だけ。同じ二重防止の番号の送り直しは前の結果を返す
CREATE OR REPLACE FUNCTION public.admin_close_return_missing(_return_id uuid, _actor_id uuid, _request_key uuid)
RETURNS TABLE (receipt_id uuid, return_status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_fingerprint text;
  v_receipt_id uuid;
  v_units jsonb;
  v_status text;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object('return_id', _return_id, 'kind', 'close_missing')::text
  );

  v_return := private.lock_order_return(_return_id);

  v_receipt_id := private.find_return_receipt(_request_key, _return_id, v_fingerprint);
  IF v_receipt_id IS NOT NULL THEN
    RETURN QUERY SELECT v_receipt_id, v_return.status, true;
    RETURN;
  END IF;

  -- 未処理の数を先に読む（書く表を、書きながら読まない）
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('return_line_id', p.return_line_id, 'quantity', p.unprocessed)
           ),
           '[]'::jsonb
         )
  INTO v_units
  FROM private.order_return_line_progress(_return_id) AS p
  WHERE p.unprocessed > 0;

  IF v_return.status <> 'open' OR pg_catalog.jsonb_array_length(v_units) = 0 THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  v_receipt_id := private.insert_return_receipt(_return_id, _request_key, v_fingerprint, 'close_missing', _actor_id);

  INSERT INTO public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity)
  SELECT v_receipt_id, x.return_line_id, 'missing', x.quantity
  FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid, quantity integer);

  v_status := private.refresh_order_return_status(_return_id);

  RETURN QUERY SELECT v_receipt_id, v_status, false;
END;
$$;

-- 8. 返品を開き直す（設計書 7-4）。完了した返品に、届かないで閉じた品が残っている時だけ。
--    届かないを打ち消す記録（missing_reopened）を書いて、受付中に戻す。受け取り済みの品は変わらない。
--    ほかの返品が同じ発送の品をもう指している時は、数を超えるので開き直せない。
--    ふつうの返金で先に返した品でも開き直せる（受け取っても返金しない。それは受け取りの関数が覆われた数として数える）
CREATE OR REPLACE FUNCTION public.admin_reopen_return(_return_id uuid, _actor_id uuid, _request_key uuid)
RETURNS TABLE (receipt_id uuid, return_status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_fingerprint text;
  v_receipt_id uuid;
  v_units jsonb;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object('return_id', _return_id, 'kind', 'reopen')::text
  );

  v_return := private.lock_order_return(_return_id);

  v_receipt_id := private.find_return_receipt(_request_key, _return_id, v_fingerprint);
  IF v_receipt_id IS NOT NULL THEN
    RETURN QUERY SELECT v_receipt_id, v_return.status, true;
    RETURN;
  END IF;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('return_line_id', p.return_line_id, 'quantity', p.missing)
           ),
           '[]'::jsonb
         )
  INTO v_units
  FROM private.order_return_line_progress(_return_id) AS p
  WHERE p.missing > 0;

  IF v_return.status <> 'closed' OR pg_catalog.jsonb_array_length(v_units) = 0 THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  -- 開き直す数は、その発送の行が今空けている数（行の数 − 返品が指す数 + 届かなかった数）を超えられない
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT l.fulfillment_id, l.order_item_id, pg_catalog.sum(x.quantity)::integer AS reopening
      FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid, quantity integer)
      JOIN public.order_return_lines AS l ON l.id = x.return_line_id
      GROUP BY l.fulfillment_id, l.order_item_id
    ) AS g
    LEFT JOIN private.fulfillment_line_returnable(v_return.order_id) AS fr
      ON fr.fulfillment_id = g.fulfillment_id AND fr.order_item_id = g.order_item_id
    WHERE g.reopening > COALESCE(fr.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  v_receipt_id := private.insert_return_receipt(_return_id, _request_key, v_fingerprint, 'reopen', _actor_id);

  INSERT INTO public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity)
  SELECT v_receipt_id, x.return_line_id, 'missing_reopened', x.quantity
  FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid, quantity integer);

  UPDATE public.order_returns AS r
  SET status = 'open',
      reopened_at = pg_catalog.now(),
      reopened_by = _actor_id
  WHERE r.id = _return_id;

  RETURN QUERY SELECT v_receipt_id, 'open'::text, false;
END;
$$;

-- 9. 検品待ちを決める（設計書 6-1・6-2）。検品待ち（pending_inspection）の品を、戻す（inspected_restocked）か
--    戻さない（inspected_not_restocked）に決める。決めた数だけ検品待ちを打ち消す。戻す品は在庫の台帳に理由 return で +n を書く。
--    返金は受け取りの時に決めた選び方のまま（ここでは返金しない）。検品待ちの数を超えると RETURN_RECEIPT_EXCEEDS。
--    色・サイズの無い古い商品は在庫に戻せない（戻す数が1以上なら RETURN_ARGUMENT_INVALID。受け取りと同じ）。
--    一部の行だけ・一部の数だけ決めてもよい。決め終わって返金待ちなども無ければ、返品は自動で完了になる
CREATE OR REPLACE FUNCTION public.admin_inspect_return(
  _return_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _lines jsonb
)
RETURNS TABLE (receipt_id uuid, return_status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_fingerprint text;
  v_receipt_id uuid;
  v_status text;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'return_id', _return_id,
      'kind', 'inspect',
      'lines', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'return_line_id', p.return_line_id,
                   'restocked', p.restocked,
                   'not_restocked', p.not_restocked
                 )
                 ORDER BY p.return_line_id
               )
        FROM private.parse_return_inspect_lines(_lines) AS p
      ), '[]'::jsonb)
    )::text
  );

  v_return := private.lock_order_return(_return_id);

  v_receipt_id := private.find_return_receipt(_request_key, _return_id, v_fingerprint);
  IF v_receipt_id IS NOT NULL THEN
    RETURN QUERY SELECT v_receipt_id, v_return.status, true;
    RETURN;
  END IF;

  IF v_return.status <> 'open' THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_return_inspect_lines(_lines) AS p
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_return_lines AS l
      WHERE l.id = p.return_line_id
        AND l.return_id = _return_id
    )
  ) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_return_inspect_lines(_lines) AS p
    LEFT JOIN private.order_return_line_progress(_return_id) AS g ON g.return_line_id = p.return_line_id
    WHERE p.restocked + p.not_restocked > COALESCE(g.pending_inspection, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_RECEIPT_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- 色・サイズの無い古い商品は在庫に戻せない（受け取りの「在庫に戻す」と同じ断り）。戻さない検品なら決められる
  IF EXISTS (
    SELECT 1
    FROM private.parse_return_inspect_lines(_lines) AS p
    JOIN public.order_return_lines AS l ON l.id = p.return_line_id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id
    WHERE p.restocked > 0
      AND oi.variant_id IS NULL
  ) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_receipt_id := private.insert_return_receipt(_return_id, _request_key, v_fingerprint, 'inspect', _actor_id);

  INSERT INTO public.order_return_receipt_lines (receipt_id, return_line_id, disposition, quantity)
  SELECT v_receipt_id, p.return_line_id, 'inspected_restocked', p.restocked
  FROM private.parse_return_inspect_lines(_lines) AS p
  WHERE p.restocked > 0
  UNION ALL
  SELECT v_receipt_id, p.return_line_id, 'inspected_not_restocked', p.not_restocked
  FROM private.parse_return_inspect_lines(_lines) AS p
  WHERE p.not_restocked > 0;

  -- 戻す品を在庫に戻す。鍵の順は 注文 → 返品 → 色・サイズ（番号の昇順）。色・サイズが無い古い商品は上で断っているので、ここには来ない
  -- （下の IS NOT NULL は念のため）
  PERFORM 1
  FROM public.item_variants AS v
  WHERE v.id IN (
    SELECT oi.variant_id
    FROM private.parse_return_inspect_lines(_lines) AS p
    JOIN public.order_return_lines AS l ON l.id = p.return_line_id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id
    WHERE p.restocked > 0
      AND oi.variant_id IS NOT NULL
  )
  ORDER BY v.id
  FOR UPDATE;

  -- 台帳のメモ（note）は書かない（NULL。受け取りの台帳と同じ。在庫の履歴の画面は理由の言葉だけを出す。英字の記号を入れると画面にそのまま出る）
  INSERT INTO public.stock_movements
    (variant_id, delta, reason, order_id, order_item_id, note, created_by, return_id)
  SELECT oi.variant_id, p.restocked, 'return', v_return.order_id, l.order_item_id,
         NULL, _actor_id, _return_id
  FROM private.parse_return_inspect_lines(_lines) AS p
  JOIN public.order_return_lines AS l ON l.id = p.return_line_id
  JOIN public.order_items AS oi ON oi.id = l.order_item_id
  WHERE p.restocked > 0
    AND oi.variant_id IS NOT NULL
  ORDER BY oi.variant_id, l.order_item_id;

  v_status := private.refresh_order_return_status(_return_id);

  RETURN QUERY SELECT v_receipt_id, v_status, false;
END;
$$;

-- 10. 手数料の受け取りの記録（設計書 6-4。店長だけ。権限は窓口が確かめる）。受付中で、お支払い待ち
--     （fee_due_amount が1以上で、受け取りがまだ）の時だけ。メモは500字まで。記録した後、ほかに待つ物が無ければ自動で完了になる。
--     _waive が真なら「いただかないで終える」（設計書 6-4 の「額を0に直す」。本計画 P27）: 条件も書く列（受け取りの時刻・人・メモ）も
--     受け取りの記録と同じで、さらに fee_waived を真にする。fee_due_amount は履歴に出すため変えない。
--     お支払い待ちの決まり（fee_due_amount ≥ 1 で fee_received_at が空）は変えないので、いただかないで終えると待ち物ではなくなる
CREATE OR REPLACE FUNCTION public.admin_record_return_fee_payment(_return_id uuid, _actor_id uuid, _note text, _waive boolean)
RETURNS TABLE (return_id uuid, return_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_status text;
BEGIN
  IF _return_id IS NULL
     OR _actor_id IS NULL
     OR _waive IS NULL
     OR (_note IS NOT NULL AND pg_catalog.char_length(_note) > 500) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_return := private.lock_order_return(_return_id);

  IF v_return.status <> 'open' OR v_return.fee_due_amount < 1 OR v_return.fee_received_at IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  UPDATE public.order_returns AS r
  SET fee_received_at = pg_catalog.now(),
      fee_received_by = _actor_id,
      fee_received_note = NULLIF(pg_catalog.btrim(_note), ''),
      fee_waived = _waive
  WHERE r.id = _return_id;

  v_status := private.refresh_order_return_status(_return_id);

  RETURN QUERY SELECT _return_id, v_status;
END;
$$;

-- 11. 支払いを待たずに送る（設計書 6-4。店長だけ。権限は窓口が確かめる）。受付中で、お支払い待ちで、まだ押していない時だけ。
--     手数料はお支払い待ちのまま残る（返品は、受け取りを記録するまで完了にならない）
CREATE OR REPLACE FUNCTION public.admin_release_return_exchange(_return_id uuid, _actor_id uuid)
RETURNS TABLE (return_id uuid, return_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_return := private.lock_order_return(_return_id);

  IF v_return.status <> 'open'
     OR v_return.fee_due_amount < 1
     OR v_return.fee_received_at IS NOT NULL
     OR v_return.exchange_released_at IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  UPDATE public.order_returns AS r
  SET exchange_released_at = pg_catalog.now(),
      exchange_released_by = _actor_id
  WHERE r.id = _return_id;

  RETURN QUERY SELECT _return_id, v_return.status;
END;
$$;

-- 12. 返品を作る画面の材料（設計書 5-3・8-3）。キーは共通の約束 C-2 の ReturnCreateMaterials の snake_case。
--     発送ごと（取り消していない発送）に品と返品できる数と期限を並べる。返品できる数は、発送の行ごとの数と
--     注文の商品ごとの数の小さい方。期限は日本時間の日付で、無制限は空（過ぎているかは past_deadline）。
--     交換の色・サイズは、発送した品と同じ商品の全部の色・サイズ（使えない物は is_active が偽）。注文が無ければ空を返す
CREATE OR REPLACE FUNCTION public.get_order_return_materials(_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH shipped AS (
    SELECT fr.fulfillment_id,
           fr.fulfillment_number,
           fr.shipped_at,
           fr.deadline_date,
           fr.order_item_id,
           fr.quantity,
           LEAST(fr.returnable, COALESCE(c.returnable, 0)) AS returnable,
           oi.item_id,
           oi.variant_id,
           oi.item_name,
           oi.color,
           oi.size,
           oi.line_kind,
           oi.created_at AS item_created_at
    FROM private.fulfillment_line_returnable(_order_id) AS fr
    JOIN public.order_fulfillments AS f ON f.id = fr.fulfillment_id AND f.cancelled_at IS NULL
    JOIN public.order_items AS oi ON oi.id = fr.order_item_id
    LEFT JOIN private.order_line_return_counts(_order_id) AS c ON c.order_item_id = fr.order_item_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'order', pg_catalog.jsonb_build_object(
      'id', o.id,
      'status', o.status,
      'has_awaiting_refund', EXISTS (
        SELECT 1
        FROM public.order_refunds AS rf
        WHERE rf.order_id = o.id
          AND rf.status = 'awaiting_response'
      )
    ),
    'shipments', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'fulfillment_id', g.fulfillment_id,
                 'number', g.fulfillment_number,
                 'shipped_at', g.shipped_at,
                 'deadline_date', g.deadline_date,
                 'past_deadline', g.deadline_date IS NOT NULL
                   AND g.deadline_date < (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date,
                 'lines', (
                   SELECT pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                              'order_item_id', s.order_item_id,
                              'item_id', s.item_id,
                              'variant_id', s.variant_id,
                              'item_name', s.item_name,
                              'color', s.color,
                              'size', s.size,
                              'line_kind', s.line_kind,
                              'quantity', s.quantity,
                              'returnable', s.returnable
                            )
                            ORDER BY s.item_created_at, s.order_item_id
                          )
                   FROM shipped AS s
                   WHERE s.fulfillment_id = g.fulfillment_id
                 )
               )
               ORDER BY g.fulfillment_number
             )
      FROM (
        SELECT s.fulfillment_id,
               s.fulfillment_number,
               s.shipped_at,
               pg_catalog.max(s.deadline_date) AS deadline_date
        FROM shipped AS s
        GROUP BY s.fulfillment_id, s.fulfillment_number, s.shipped_at
      ) AS g
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
                                'is_active', v.is_active,
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
                 )
               )
               ORDER BY i.item_id
             )
      FROM (SELECT DISTINCT s.item_id FROM shipped AS s) AS i
    ), '[]'::jsonb),
    'settings', (
      SELECT pg_catalog.jsonb_build_object(
               'return_address_set', private.shop_return_address_set(),
               'no_return_needed_enabled', st.no_return_needed_enabled,
               'customer_paid_method', st.customer_paid_method,
               'shop_label_fee', st.shop_label_fee,
               'restocking_fee_enabled', st.restocking_fee_enabled,
               'restocking_fee_percent', st.restocking_fee_percent,
               'exchange_fees_enabled', st.exchange_fees_enabled,
               'exchange_fee', st.exchange_fee,
               'exchange_shipping_fee', st.exchange_shipping_fee,
               'reason_shipping_payers', (
                 SELECT pg_catalog.jsonb_object_agg(rs.reason, rs.shipping_payer)
                 FROM public.shop_return_reason_settings AS rs
               ),
               'reason_out_of_stock_exchange', (
                 SELECT pg_catalog.jsonb_object_agg(rs.reason, rs.out_of_stock_exchange)
                 FROM public.shop_return_reason_settings AS rs
               )
             )
      FROM public.shop_return_settings AS st
      WHERE st.id = 1
    )
  )
  FROM public.orders AS o
  WHERE o.id = _order_id
$$;

-- 13. 注文の返品の中身（設計書 4・6・8 章）。取消・お断りの返品も返す（画面が状態で出し分ける）。新しい返品（番号の大きい順）から
CREATE OR REPLACE FUNCTION public.list_order_returns(_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
           pg_catalog.jsonb_agg(private.return_detail_json(r.id) ORDER BY r.number DESC),
           '[]'::jsonb
         )
  FROM public.order_returns AS r
  WHERE r.order_id = _order_id
$$;

-- 14. 注文の一覧の1ページ分の返品の要約（設計書 3-2・8-1）。渡した注文ごとに1行（存在しない注文の行は返さない）。
--     display_status は、取消・お断りを除いた返品のうち、いちばん手前（返品の申し込み → 返品中 → 返金待ち → 返品済み）。
--     marks は、その状態が返品中の時の小さな印の和（返品の複数の分を、受け取り待ち・一部受け取り・検品待ち・お支払い待ちの順に）。
--     next_action は、申し込みがあれば review_request、返金待ちの品（rw）がある返品があれば refund（店長だけに出すのは画面。
--     完了した返品の返金が失敗して rw が戻った時も含む。本計画 P21）、受付中で未処理があれば receive、無ければ none。
--     requested_returns・refund_waiting_returns は、画面の状態がその状態の返品の数。has_returnable は、返品できる品があるか
CREATE OR REPLACE FUNCTION public.list_order_return_summaries(_order_ids uuid[])
RETURNS TABLE (
  order_id uuid,
  display_status text,
  marks text[],
  next_action text,
  has_returnable boolean,
  refund_waiting_returns integer,
  requested_returns integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF _order_ids IS NULL OR pg_catalog.cardinality(_order_ids) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(_order_ids) > 200 THEN
    RAISE EXCEPTION 'TOO_MANY_ORDERS' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH states AS (
    SELECT r.order_id AS state_order_id,
           r.status AS return_status,
           st.display_status AS state_display_status,
           st.marks AS state_marks,
           st.unprocessed AS state_unprocessed,
           st.refund_waiting AS state_refund_waiting
    FROM public.order_returns AS r
    CROSS JOIN LATERAL private.return_display_state(r.id) AS st
    WHERE r.order_id = ANY (_order_ids)
      AND r.status IN ('requested', 'open', 'closed')
  ),
  per_order AS (
    SELECT s.state_order_id AS order_key,
           pg_catalog.min(
             CASE s.state_display_status
               WHEN 'requested' THEN 1
               WHEN 'in_progress' THEN 2
               WHEN 'refund_waiting' THEN 3
               ELSE 4
             END
           ) AS front_rank,
           pg_catalog.count(*) FILTER (WHERE s.state_display_status = 'requested')::integer AS requested_count,
           pg_catalog.count(*) FILTER (WHERE s.state_display_status = 'refund_waiting')::integer AS waiting_count,
           pg_catalog.bool_or(s.return_status = 'requested') AS any_requested,
           pg_catalog.bool_or(s.return_status IN ('open', 'closed') AND s.state_refund_waiting > 0) AS any_refund,
           pg_catalog.bool_or(s.return_status = 'open' AND s.state_unprocessed > 0) AS any_receive
    FROM states AS s
    GROUP BY s.state_order_id
  )
  SELECT o.id,
         CASE a.front_rank
           WHEN 1 THEN 'requested'
           WHEN 2 THEN 'in_progress'
           WHEN 3 THEN 'refund_waiting'
           WHEN 4 THEN 'returned'
         END,
         CASE
           WHEN a.front_rank = 2 THEN ARRAY(
             SELECT m.mark
             FROM (VALUES (1, 'awaiting_items'), (2, 'partially_received'), (3, 'pending_inspection'), (4, 'awaiting_fee'))
               AS m(ord, mark)
             WHERE EXISTS (
               SELECT 1
               FROM states AS s
               WHERE s.state_order_id = o.id
                 AND s.state_display_status = 'in_progress'
                 AND m.mark = ANY (s.state_marks)
             )
             ORDER BY m.ord
           )
           ELSE ARRAY[]::text[]
         END,
         CASE
           WHEN COALESCE(a.any_requested, false) THEN 'review_request'
           WHEN COALESCE(a.any_refund, false) THEN 'refund'
           WHEN COALESCE(a.any_receive, false) THEN 'receive'
           ELSE 'none'
         END,
         (
           o.status IN ('paid'::public.order_status, 'shipped'::public.order_status)
           AND EXISTS (
             SELECT 1
             FROM private.fulfillment_line_returnable(o.id) AS fr
             JOIN private.order_line_return_counts(o.id) AS c ON c.order_item_id = fr.order_item_id
             WHERE LEAST(fr.returnable, c.returnable) > 0
           )
         ),
         COALESCE(a.waiting_count, 0),
         COALESCE(a.requested_count, 0)
  FROM public.orders AS o
  LEFT JOIN per_order AS a ON a.order_key = o.id
  WHERE o.id = ANY (_order_ids)
  ORDER BY o.id;
END;
$$;

-- 15. 一覧の上の一行の数（設計書 8-1）。返品の申し込みがある注文の数と、返金待ちの返品がある注文の数
--     （返金待ちは、完了した返品の返金が失敗して戻った物も含む）。
--     押すと絞り込みに移るので、絞り込みで出る注文の数と同じになるよう、返品ではなく注文を数える
CREATE OR REPLACE FUNCTION public.count_order_return_attention()
RETURNS TABLE (requested integer, refund_waiting integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.count(DISTINCT s.order_id) FILTER (WHERE s.display_status = 'requested')::integer,
         pg_catalog.count(DISTINCT s.order_id) FILTER (WHERE s.display_status = 'refund_waiting')::integer
  FROM (
    SELECT r.order_id, st.display_status
    FROM public.order_returns AS r
    CROSS JOIN LATERAL private.return_display_state(r.id) AS st
    WHERE r.status IN ('requested', 'open', 'closed')
  ) AS s
$$;

-- 16. 一覧の絞り込み（設計書 3-2・8-1）。渡した画面の状態の返品がどれか1つでもある注文を、新しい注文から500件まで。
--     記録の状態で先に絞ってから、画面の状態を確かめる（返金待ちは受付中と完了の両方にある）
CREATE OR REPLACE FUNCTION public.list_order_ids_by_return_status(_display_status text)
RETURNS TABLE (order_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF _display_status IS NULL
     OR _display_status NOT IN ('requested', 'in_progress', 'refund_waiting', 'returned') THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT o.id
  FROM public.orders AS o
  WHERE EXISTS (
    SELECT 1
    FROM public.order_returns AS r
    CROSS JOIN LATERAL private.return_display_state(r.id) AS st
    WHERE r.order_id = o.id
      AND CASE _display_status
        WHEN 'requested' THEN r.status = 'requested'
        WHEN 'in_progress' THEN r.status = 'open'
        WHEN 'refund_waiting' THEN r.status IN ('open', 'closed')
        ELSE r.status = 'closed'
      END
      AND st.display_status = _display_status
  )
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT 500;
END;
$$;

-- 17. 返品の設定を書く読み取りの部品（設計書 8-3・11-2）。キーが無ければ今の値のまま、あれば形と範囲を確かめて返す。
--     形や範囲が違えば SETTINGS_ARGUMENT_INVALID（E-2 の設定の関数と同じ記号）。
--     キーがあるかは、jsonb のキー存在の演算子でなく pg_catalog.jsonb_exists で見る（演算子の記号をドライバがプレースホルダと
--     誤読しうる。前例: supabase/migrations/092_lock_down_rpc_surface.sql）
CREATE OR REPLACE FUNCTION private.settings_bool(_source jsonb, _key text, _current boolean)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF NOT pg_catalog.jsonb_exists(_source, _key) THEN
    RETURN _current;
  END IF;
  IF pg_catalog.jsonb_typeof(_source -> _key) <> 'boolean' THEN
    RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN (_source ->> _key)::boolean;
END;
$$;

-- 整数。_nullable が真の時だけ、JSON の null（無制限など）を空として受ける
CREATE OR REPLACE FUNCTION private.settings_int(
  _source jsonb,
  _key text,
  _current integer,
  _min integer,
  _max integer,
  _nullable boolean
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_value integer;
BEGIN
  IF NOT pg_catalog.jsonb_exists(_source, _key) THEN
    RETURN _current;
  END IF;
  IF pg_catalog.jsonb_typeof(_source -> _key) = 'null' AND _nullable THEN
    RETURN NULL;
  END IF;
  IF pg_catalog.jsonb_typeof(_source -> _key) <> 'number' THEN
    RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  BEGIN
    -- 1.5 のような小数は整数に直せずに失敗する（黙って丸めない）
    v_value := (_source ->> _key)::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END;
  IF v_value < _min OR v_value > _max THEN
    RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN v_value;
END;
$$;

-- 決まった値のどれか
CREATE OR REPLACE FUNCTION private.settings_enum(_source jsonb, _key text, _current text, _allowed text[])
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF NOT pg_catalog.jsonb_exists(_source, _key) THEN
    RETURN _current;
  END IF;
  IF pg_catalog.jsonb_typeof(_source -> _key) <> 'string' OR NOT ((_source ->> _key) = ANY (_allowed)) THEN
    RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN _source ->> _key;
END;
$$;

-- 文字。_max 字まで
CREATE OR REPLACE FUNCTION private.settings_text(_source jsonb, _key text, _current text, _max integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF NOT pg_catalog.jsonb_exists(_source, _key) THEN
    RETURN _current;
  END IF;
  IF pg_catalog.jsonb_typeof(_source -> _key) <> 'string' OR pg_catalog.char_length(_source ->> _key) > _max THEN
    RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN _source ->> _key;
END;
$$;

-- 18. ショップの返品の設定を書く（設計書 8-3・11-2。店長だけ。権限は窓口が確かめる）。
--     _settings は get_shop_return_settings の答えと同じキー（snake_case）の一部。キーが無い欄は変えない。
--     段2で画面に出す欄（申し込み・種類・注意書き・理由ごとの出す／ご希望／写真）も受けて保存する。
--     最後に変えた人と時刻は、まとまり（requests・window・shipping・reasons・fees・receiving）ごとに、
--     そのまとまりの値が実際に変わった時だけ書く。答えは get_shop_return_settings と同じ
CREATE OR REPLACE FUNCTION public.admin_update_shop_return_settings(_settings jsonb, _actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_old public.shop_return_settings;
  v_new public.shop_return_settings;
  v_key text;
  v_address jsonb;
  v_reason jsonb;
  v_reason_code text;
  v_reason_old public.shop_return_reason_settings;
  v_reason_new public.shop_return_reason_settings;
  v_seen text[] := ARRAY[]::text[];
  v_requests_changed boolean;
  v_window_changed boolean;
  v_shipping_changed boolean;
  v_reasons_changed boolean := false;
  v_fees_changed boolean;
  v_receiving_changed boolean;
BEGIN
  IF _settings IS NULL OR pg_catalog.jsonb_typeof(_settings) <> 'object' OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 知らないキーは断る（綴りの間違いを黙って捨てない）
  FOR v_key IN SELECT k.setting_key FROM pg_catalog.jsonb_object_keys(_settings) AS k(setting_key) LOOP
    IF v_key <> ALL (ARRAY[
         'requests_enabled', 'request_types', 'notice_text', 'window_days', 'window_start', 'delivery_buffer_days',
         'return_address', 'customer_paid_method', 'shop_label_fee', 'no_return_needed_enabled',
         'restocking_fee_enabled', 'restocking_fee_percent', 'exchange_fees_enabled', 'exchange_fee',
         'exchange_shipping_fee', 'inspection_enabled', 'reasons'
       ]) THEN
      RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- 設定の行（1行）の鍵。同時に2人が直しても、後の人は前の人の値を見てから書く
  SELECT s.* INTO v_old FROM public.shop_return_settings AS s WHERE s.id = 1 FOR UPDATE;
  v_new := v_old;

  v_new.requests_enabled := private.settings_bool(_settings, 'requests_enabled', v_old.requests_enabled);
  v_new.request_types := private.settings_enum(
    _settings, 'request_types', v_old.request_types,
    ARRAY['returns_and_cancellations', 'returns_only', 'cancellations_only']
  );
  v_new.notice_text := private.settings_text(_settings, 'notice_text', v_old.notice_text, 2000);

  v_new.window_days := private.settings_int(_settings, 'window_days', v_old.window_days, 1, 365, true);
  v_new.window_start := private.settings_enum(_settings, 'window_start', v_old.window_start, ARRAY['each_item', 'last_item']);
  v_new.delivery_buffer_days := private.settings_int(
    _settings, 'delivery_buffer_days', v_old.delivery_buffer_days, 0, 14, false
  );

  v_new.customer_paid_method := private.settings_enum(
    _settings, 'customer_paid_method', v_old.customer_paid_method, ARRAY['customer_ships', 'shop_label']
  );
  v_new.shop_label_fee := private.settings_int(_settings, 'shop_label_fee', v_old.shop_label_fee, 0, 1000000, false);
  v_new.no_return_needed_enabled := private.settings_bool(
    _settings, 'no_return_needed_enabled', v_old.no_return_needed_enabled
  );

  -- 返送先: 4つとも入れる（名前・郵便番号・住所・電話番号）か、null で4つとも空にする
  IF pg_catalog.jsonb_exists(_settings, 'return_address') THEN
    v_address := _settings -> 'return_address';
    IF pg_catalog.jsonb_typeof(v_address) = 'null' THEN
      v_new.return_address_name := NULL;
      v_new.return_address_postal_code := NULL;
      v_new.return_address_line := NULL;
      v_new.return_address_phone := NULL;
    ELSIF pg_catalog.jsonb_typeof(v_address) = 'object' THEN
      FOR v_key IN SELECT k.setting_key FROM pg_catalog.jsonb_object_keys(v_address) AS k(setting_key) LOOP
        IF v_key NOT IN ('name', 'postal_code', 'address', 'phone') THEN
          RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
        END IF;
      END LOOP;
      v_new.return_address_name := NULLIF(pg_catalog.btrim(private.settings_text(v_address, 'name', NULL, 200)), '');
      v_new.return_address_postal_code := NULLIF(
        pg_catalog.btrim(private.settings_text(v_address, 'postal_code', NULL, 8)), ''
      );
      v_new.return_address_line := NULLIF(pg_catalog.btrim(private.settings_text(v_address, 'address', NULL, 200)), '');
      v_new.return_address_phone := NULLIF(pg_catalog.btrim(private.settings_text(v_address, 'phone', NULL, 20)), '');
      IF v_new.return_address_name IS NULL
         OR v_new.return_address_postal_code IS NULL
         OR v_new.return_address_line IS NULL
         OR v_new.return_address_phone IS NULL
         OR v_new.return_address_postal_code !~ '^[0-9]{3}-?[0-9]{4}$'
         OR v_new.return_address_phone !~ '^[0-9+-]{6,20}$' THEN
        RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new.restocking_fee_enabled := private.settings_bool(_settings, 'restocking_fee_enabled', v_old.restocking_fee_enabled);
  v_new.restocking_fee_percent := private.settings_int(
    _settings, 'restocking_fee_percent', v_old.restocking_fee_percent, 0, 100, false
  );
  v_new.exchange_fees_enabled := private.settings_bool(_settings, 'exchange_fees_enabled', v_old.exchange_fees_enabled);
  v_new.exchange_fee := private.settings_int(_settings, 'exchange_fee', v_old.exchange_fee, 0, 1000000, false);
  v_new.exchange_shipping_fee := private.settings_int(
    _settings, 'exchange_shipping_fee', v_old.exchange_shipping_fee, 0, 1000000, false
  );

  v_new.inspection_enabled := private.settings_bool(_settings, 'inspection_enabled', v_old.inspection_enabled);

  -- 理由ごとの設定: 理由の記号と、変えたい欄だけを持つ行の配列。同じ理由は1回だけ。「不明」はお客様に出さない
  IF pg_catalog.jsonb_exists(_settings, 'reasons') THEN
    IF pg_catalog.jsonb_typeof(_settings -> 'reasons') <> 'array' THEN
      RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    FOR v_reason IN SELECT e.value FROM pg_catalog.jsonb_array_elements(_settings -> 'reasons') AS e(value) LOOP
      IF pg_catalog.jsonb_typeof(v_reason) <> 'object'
         OR pg_catalog.jsonb_typeof(v_reason -> 'reason') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      FOR v_key IN SELECT k.setting_key FROM pg_catalog.jsonb_object_keys(v_reason) AS k(setting_key) LOOP
        IF v_key <> ALL (ARRAY[
             'reason', 'shown', 'resolutions', 'out_of_stock_exchange', 'photo', 'photo_instructions', 'shipping_payer'
           ]) THEN
          RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
        END IF;
      END LOOP;

      v_reason_code := v_reason ->> 'reason';
      IF v_reason_code = ANY (v_seen) THEN
        RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      v_seen := v_seen || v_reason_code;

      SELECT rs.* INTO v_reason_old
      FROM public.shop_return_reason_settings AS rs
      WHERE rs.reason = v_reason_code
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;

      v_reason_new := v_reason_old;
      v_reason_new.shown := private.settings_bool(v_reason, 'shown', v_reason_old.shown);
      v_reason_new.resolutions := private.settings_enum(
        v_reason, 'resolutions', v_reason_old.resolutions, ARRAY['refund_and_exchange', 'exchange_only', 'refund_only']
      );
      v_reason_new.out_of_stock_exchange := private.settings_enum(
        v_reason, 'out_of_stock_exchange', v_reason_old.out_of_stock_exchange, ARRAY['make', 'decline']
      );
      v_reason_new.photo := private.settings_enum(v_reason, 'photo', v_reason_old.photo, ARRAY['none', 'optional', 'required']);
      v_reason_new.photo_instructions := private.settings_text(
        v_reason, 'photo_instructions', v_reason_old.photo_instructions, 500
      );
      v_reason_new.shipping_payer := private.settings_enum(
        v_reason, 'shipping_payer', v_reason_old.shipping_payer, ARRAY['shop', 'customer']
      );
      IF v_reason_code = 'unknown' AND v_reason_new.shown THEN
        RAISE EXCEPTION 'SETTINGS_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;

      IF v_reason_new IS DISTINCT FROM v_reason_old THEN
        UPDATE public.shop_return_reason_settings AS rs
        SET shown = v_reason_new.shown,
            resolutions = v_reason_new.resolutions,
            out_of_stock_exchange = v_reason_new.out_of_stock_exchange,
            photo = v_reason_new.photo,
            photo_instructions = v_reason_new.photo_instructions,
            shipping_payer = v_reason_new.shipping_payer
        WHERE rs.reason = v_reason_code;
        v_reasons_changed := true;
      END IF;
    END LOOP;
  END IF;

  v_requests_changed := (v_new.requests_enabled, v_new.request_types, v_new.notice_text)
    IS DISTINCT FROM (v_old.requests_enabled, v_old.request_types, v_old.notice_text);
  v_window_changed := (v_new.window_days, v_new.window_start, v_new.delivery_buffer_days)
    IS DISTINCT FROM (v_old.window_days, v_old.window_start, v_old.delivery_buffer_days);
  v_shipping_changed := (
      v_new.return_address_name, v_new.return_address_postal_code, v_new.return_address_line, v_new.return_address_phone,
      v_new.customer_paid_method, v_new.shop_label_fee, v_new.no_return_needed_enabled
    ) IS DISTINCT FROM (
      v_old.return_address_name, v_old.return_address_postal_code, v_old.return_address_line, v_old.return_address_phone,
      v_old.customer_paid_method, v_old.shop_label_fee, v_old.no_return_needed_enabled
    );
  v_fees_changed := (
      v_new.restocking_fee_enabled, v_new.restocking_fee_percent, v_new.exchange_fees_enabled,
      v_new.exchange_fee, v_new.exchange_shipping_fee
    ) IS DISTINCT FROM (
      v_old.restocking_fee_enabled, v_old.restocking_fee_percent, v_old.exchange_fees_enabled,
      v_old.exchange_fee, v_old.exchange_shipping_fee
    );
  v_receiving_changed := v_new.inspection_enabled IS DISTINCT FROM v_old.inspection_enabled;

  UPDATE public.shop_return_settings AS s
  SET requests_enabled = v_new.requests_enabled,
      request_types = v_new.request_types,
      notice_text = v_new.notice_text,
      window_days = v_new.window_days,
      window_start = v_new.window_start,
      delivery_buffer_days = v_new.delivery_buffer_days,
      return_address_name = v_new.return_address_name,
      return_address_postal_code = v_new.return_address_postal_code,
      return_address_line = v_new.return_address_line,
      return_address_phone = v_new.return_address_phone,
      customer_paid_method = v_new.customer_paid_method,
      shop_label_fee = v_new.shop_label_fee,
      no_return_needed_enabled = v_new.no_return_needed_enabled,
      restocking_fee_enabled = v_new.restocking_fee_enabled,
      restocking_fee_percent = v_new.restocking_fee_percent,
      exchange_fees_enabled = v_new.exchange_fees_enabled,
      exchange_fee = v_new.exchange_fee,
      exchange_shipping_fee = v_new.exchange_shipping_fee,
      inspection_enabled = v_new.inspection_enabled,
      requests_updated_at = CASE WHEN v_requests_changed THEN pg_catalog.now() ELSE s.requests_updated_at END,
      requests_updated_by = CASE WHEN v_requests_changed THEN _actor_id ELSE s.requests_updated_by END,
      window_updated_at = CASE WHEN v_window_changed THEN pg_catalog.now() ELSE s.window_updated_at END,
      window_updated_by = CASE WHEN v_window_changed THEN _actor_id ELSE s.window_updated_by END,
      shipping_updated_at = CASE WHEN v_shipping_changed THEN pg_catalog.now() ELSE s.shipping_updated_at END,
      shipping_updated_by = CASE WHEN v_shipping_changed THEN _actor_id ELSE s.shipping_updated_by END,
      reasons_updated_at = CASE WHEN v_reasons_changed THEN pg_catalog.now() ELSE s.reasons_updated_at END,
      reasons_updated_by = CASE WHEN v_reasons_changed THEN _actor_id ELSE s.reasons_updated_by END,
      fees_updated_at = CASE WHEN v_fees_changed THEN pg_catalog.now() ELSE s.fees_updated_at END,
      fees_updated_by = CASE WHEN v_fees_changed THEN _actor_id ELSE s.fees_updated_by END,
      receiving_updated_at = CASE WHEN v_receiving_changed THEN pg_catalog.now() ELSE s.receiving_updated_at END,
      receiving_updated_by = CASE WHEN v_receiving_changed THEN _actor_id ELSE s.receiving_updated_by END
  WHERE s.id = 1;

  RETURN public.get_shop_return_settings();
END;
$$;

-- 19. 発送の取消（設計書 7-3・7-5）。今の本文（E-2 の移行 B 20261011223147_order_refund_requests.sql の 10.）のまま、
--     取り消す前に「申し込み・受付中・完了の返品が指している発送」を断る守りを足す（FULFILLMENT_HAS_RETURN）。
--     取消・お断りの返品しか指していない発送は、今と同じく取り消せる。返品を作る関数も同じ注文の行の鍵を取るので、
--     同時に押された時は、先に確定した方だけが進む
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

  -- 取り消した注文（返金で取り消した注文を含む）の発送は戻さない
  IF v_status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status) THEN
    RAISE EXCEPTION 'FULFILLMENT_CANCEL_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  -- 返品が指している発送は取り消せない（期限と返品できる数が崩れる）。取消・お断りの返品は数えない
  IF EXISTS (
    SELECT 1
    FROM public.order_return_lines AS rl
    JOIN public.order_returns AS r ON r.id = rl.return_id
    WHERE rl.fulfillment_id = _fulfillment_id
      AND r.status IN ('requested', 'open', 'closed')
  ) THEN
    RAISE EXCEPTION 'FULFILLMENT_HAS_RETURN' USING ERRCODE = '22023';
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

-- 20. 権限。新しい public の関数は service_role だけ。private の関数は PUBLIC から外すだけ
REVOKE ALL ON FUNCTION private.parse_return_lines(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.parse_return_inspect_lines(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.lock_order_return(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.find_return_receipt(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.insert_return_receipt(uuid, uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_return_email(uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.return_refund_amount(text, integer, integer, integer, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.shop_return_address_set() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.return_display_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.return_detail_json(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.settings_bool(jsonb, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.settings_int(jsonb, text, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.settings_enum(jsonb, text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.settings_text(jsonb, text, text, integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.admin_create_return(
  uuid, uuid, uuid, jsonb, text, text, text, text, integer, integer, integer, integer, text, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_cancel_return(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_close_return_missing(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_reopen_return(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_inspect_return(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_record_return_fee_payment(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_release_return_exchange(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_return_materials(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_returns(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_return_summaries(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.count_order_return_attention() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_ids_by_return_status(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_update_shop_return_settings(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_cancel_fulfillment(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_create_return(
  uuid, uuid, uuid, jsonb, text, text, text, text, integer, integer, integer, integer, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_return(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_close_return_missing(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_reopen_return(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_inspect_return(uuid, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_record_return_fee_payment(uuid, uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_release_return_exchange(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_return_materials(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_returns(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_return_summaries(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.count_order_return_attention() TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_ids_by_return_status(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_shop_return_settings(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_fulfillment(uuid, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
