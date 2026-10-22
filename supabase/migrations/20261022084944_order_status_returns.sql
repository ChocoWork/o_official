-- 注文状況の返品の読み出しの共通化（E-5、移行 B）。
-- お客様の注文の画面の「返品・交換」の欄とキャンセルの申し込みの欄の JSON を作る部分を、private の芯へ移す。
--   ・private.build_customer_order_returns : JSON を組む芯。直接は誰も呼べない。
--   ・public.get_customer_order_returns     : 既存の持ち主用。入口の確かめと誤りはそのまま、JSON は芯（真）に任せる。
--   ・public.get_order_status_returns       : 注文番号で読む新しい入口。持ち主の条件は無く、公開（偽・省略時）と個人情報つき（真）を分ける。
-- 移行 A（20261023100000_order_status_links.sql）の後に当てる。適用済みの移行は書き換えない。
BEGIN;

-- 1. JSON を組む芯。20261020144842_order_return_customer_requests.sql の 11 の本体を、_order_id を _order.id に替えて移した。
--    真の時は元の持ち主用の関数と同じ JSON を返す（キー・null・並び・期限・受付の可否を含めて同じ）。
--    偽の時は、返送先（return_address）と送り返しの業者・伝票番号（sent_back の carrier・tracking_number）の
--    キーを作らず、その値を読む SELECT も走らせない（取得してから消すのではなく、最初から読まない）。
--    お店のメモ・お断りの理由の記号・した人のメールなど内部の情報は、元から JSON に入れない。
--    呼ぶ側は注文の id と status を詰めた public.orders 型の値を渡す（受付の可否は id と status だけを使う）。
CREATE OR REPLACE FUNCTION private.build_customer_order_returns(_order public.orders, _include_private boolean)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_returns text;
  v_ended_on date;
  v_cancel boolean;
BEGIN
  SELECT a.returns, a.ended_on, a.cancel
  INTO v_returns, v_ended_on, v_cancel
  FROM private.customer_return_availability(_order) AS a;

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
                              'message', rc.sent_back_message
                            ) || CASE
                              WHEN _include_private THEN pg_catalog.jsonb_build_object(
                                'carrier', rc.sent_back_carrier,
                                'tracking_number', rc.sent_back_tracking_number
                              )
                              ELSE '{}'::jsonb
                            END
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
                     JOIN private.order_line_fulfillment(_order.id) AS lf ON lf.order_item_id = xi.id
                     WHERE xl.return_id = r.id
                       AND lf.shipped < xi.quantity
                   ) THEN 'pending'
                   ELSE 'shipped'
                 END
               ) || CASE
                 WHEN _include_private THEN pg_catalog.jsonb_build_object(
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
                   END
                 )
                 ELSE '{}'::jsonb
               END
               ORDER BY r.number DESC
             )
      FROM public.order_returns AS r
      CROSS JOIN LATERAL private.return_display_state(r.id) AS ds
      WHERE r.order_id = _order.id
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
      WHERE c.order_id = _order.id
    ), '[]'::jsonb),
    'availability', pg_catalog.jsonb_build_object(
      'returns', v_returns,
      'ended_on', v_ended_on,
      'cancel', v_cancel
    )
  );
END;
$$;

-- 2. 既存の持ち主用。入口で持ち主と隠す状態を確かめる部分（ORDER_NOT_FOUND / P0002）はそのまま、
--    JSON は芯へ真で任せる。NULL を返す形には変えない。属性（STABLE・SECURITY DEFINER・search_path）も元のまま。
CREATE OR REPLACE FUNCTION public.get_customer_order_returns(_order_id uuid, _customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
BEGIN
  v_order := private.customer_order_for_request(_order_id, _customer_id, false);

  RETURN private.build_customer_order_returns(v_order, true);
END;
$$;

-- 3. 注文番号で読む新しい入口。持ち主の条件は無い（ゲストの注文も読める）。
--    NULL・無い注文・お客様に隠す状態（支払い手続き中・放棄）は SQL の NULL を返す。
--    _include_private が NULL なら ORDER_STATUS_ARGUMENT_INVALID / 22023。偽（省略時も）は公開の JSON、真は持ち主用と同じ JSON。
--    注文からは id と status だけを読む（芯の受付の可否が使うのはこの 2 つだけ）。電話や住所は読まない。
CREATE OR REPLACE FUNCTION public.get_order_status_returns(_order_id uuid, _include_private boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
BEGIN
  IF _include_private IS NULL THEN
    RAISE EXCEPTION 'ORDER_STATUS_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT o.id, o.status
  INTO v_order.id, v_order.status
  FROM public.orders AS o
  WHERE o.id = _order_id
    AND o.status NOT IN ('payment_in_progress'::public.order_status, 'abandoned'::public.order_status);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN private.build_customer_order_returns(v_order, _include_private);
END;
$$;

-- 4. 権限。public の 2 つは service_role だけ。芯は誰にも与えない（所有者の内部の呼び出しだけで使う）。
ALTER FUNCTION private.build_customer_order_returns(public.orders, boolean) OWNER TO postgres;
ALTER FUNCTION public.get_customer_order_returns(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.get_order_status_returns(uuid, boolean) OWNER TO postgres;

REVOKE ALL ON FUNCTION private.build_customer_order_returns(public.orders, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_customer_order_returns(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_order_status_returns(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_customer_order_returns(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_status_returns(uuid, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
