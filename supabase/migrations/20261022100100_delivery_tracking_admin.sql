-- 配送の直しと手の配達済みの関数（グループ E-4、移行 B）。
-- 発送の作成と取消に配送の記録を足し、伝票番号の直し・手で配達済み・追跡の切り替え・要対応の解決・読み出し・
-- 配送メールの補助・返品の期限（届いた日）を加える。17TRACK への呼び出しは移行 C 以降で、ここでは行わない。
-- 鍵の順番は 設定（FOR SHARE。切り替えだけ FOR UPDATE）→ 注文 → 発送。
BEGIN;

-- 1. 作成の指紋。作成・再送・番号の直し・旧行の補完が同じ計算を使い、actor は含めない。
CREATE OR REPLACE FUNCTION private.fulfillment_lines_json(_fulfillment_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('order_item_id', l.order_item_id, 'quantity', l.quantity)
      ORDER BY l.order_item_id
    ),
    '[]'::jsonb
  )
  FROM public.order_fulfillment_lines AS l
  WHERE l.fulfillment_id = _fulfillment_id
$$;

CREATE OR REPLACE FUNCTION private.fulfillment_create_fingerprint(
  _order_id uuid,
  _shipping_carrier text,
  _tracking_number text,
  _notify_customer boolean,
  _lines jsonb
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'order_id', _order_id,
      'shipping_carrier', _shipping_carrier,
      'tracking_number', _tracking_number,
      'notify_customer', _notify_customer,
      'lines', _lines
    )::text
  )
$$;

-- 2. 既存の発送の指紋を、今の値と商品行から補う。移行 A と同じく、同じ取引の間だけ旧ガードを外す。
ALTER TABLE public.order_fulfillments DISABLE TRIGGER order_fulfillments_cancel_only;
UPDATE public.order_fulfillments AS f
SET request_fingerprint = private.fulfillment_create_fingerprint(
  f.order_id, f.shipping_carrier, f.tracking_number, f.notify_customer, private.fulfillment_lines_json(f.id)
)
WHERE f.request_fingerprint IS NULL;
ALTER TABLE public.order_fulfillments ENABLE TRIGGER order_fulfillments_cancel_only;

-- 3. 発送の開いた要対応を自動で閉じる（直し・配達済み・取消が使う）。
CREATE OR REPLACE FUNCTION private.close_delivery_attention(_fulfillment_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.order_fulfillment_attention AS a
  SET resolved_at = pg_catalog.now(),
      resolution = 'auto'
  WHERE a.fulfillment_id = _fulfillment_id
    AND a.resolved_at IS NULL
$$;

-- 3b. 直し・取消でその発送の登録を止める。止まっていない行（state <> 'stopped'）だけを replaced / cancelled にし、
--     すでに止まっている行（delivered・expired・disabled・provider_stopped・前の replaced）の理由と時刻は変えない。
--     新しく止めた行のうち、一度でも登録できた（ever_registered）行で、同じ（配送業者, 番号）の止めていない行がほかの発送に
--     無いものだけ、外への停止の印（provider_stop_pending）を立てて今すぐ処理できる時刻にする。
--     delivered・expired・disabled で止める時はこの関数を使わないので、印は付かない。実際の停止は移行 C の借りる関数が
--     同じ組をもう一度確かめてから行う。呼ぶ側が注文 → 発送の鍵を持っている。組の鍵は P9 の順（配送業者, 番号）で取る。
--     登録の番号は CHECK で大文字にそろっているので、組の比べは等しいかどうかでよい（大文字小文字の違う入力も同じ組になる）。
CREATE OR REPLACE FUNCTION private.stop_fulfillment_registrations(_fulfillment_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_pair record;
BEGIN
  IF _reason IS NULL OR _reason NOT IN ('replaced', 'cancelled') THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  FOR v_pair IN
    SELECT DISTINCT r.carrier, r.tracking_number
    FROM private.fulfillment_tracking_registrations AS r
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.state <> 'stopped'
      AND r.ever_registered
    ORDER BY r.carrier, r.tracking_number
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_pair.carrier || ':' || v_pair.tracking_number, 0));
  END LOOP;

  -- この発送の止めていない行は全部ここで止まるので、「ほかに止めていない行」はほかの発送の行だけを見る
  WITH stopping AS (
    SELECT r.tracking_version,
           r.ever_registered AND NOT EXISTS (
             SELECT 1
             FROM private.fulfillment_tracking_registrations AS o
             WHERE o.carrier = r.carrier
               AND o.tracking_number = r.tracking_number
               AND o.fulfillment_id <> _fulfillment_id
               AND o.state <> 'stopped'
           ) AS stop_at_provider
    FROM private.fulfillment_tracking_registrations AS r
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.state <> 'stopped'
  )
  UPDATE private.fulfillment_tracking_registrations AS r
  SET state = 'stopped',
      stop_reason = _reason,
      stopped_at = pg_catalog.now(),
      failure_kind = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      provider_stop_pending = s.stop_at_provider,
      next_run_at = CASE WHEN s.stop_at_provider THEN pg_catalog.now() ELSE r.next_run_at END
  FROM stopping AS s
  WHERE r.fulfillment_id = _fulfillment_id
    AND r.tracking_version = s.tracking_version;
END;
$$;

-- 4. 追跡をオンにした時の取り込み対象。設定の件数とオンの取り込みが同じ SELECT を使う。
--    登録が無い現版と、期限内でオフにして止めた（disabled）現版が対象。期限は、行があればその値、無ければ始点＋30日。
--    始点は版1が発送した時刻、版2以上は直した時刻。
CREATE OR REPLACE FUNCTION private.delivery_tracking_backfill_targets()
RETURNS TABLE (fulfillment_id uuid, tracking_version integer, expires_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT f.id,
         f.tracking_version,
         COALESCE(r.expires_at, s.started_at + interval '30 days')
  FROM public.order_fulfillments AS f
  LEFT JOIN public.order_fulfillment_tracking_changes AS c
    ON c.fulfillment_id = f.id AND c.tracking_version = f.tracking_version
  LEFT JOIN private.fulfillment_tracking_registrations AS r
    ON r.fulfillment_id = f.id AND r.tracking_version = f.tracking_version
  CROSS JOIN LATERAL (
    SELECT CASE WHEN f.tracking_version = 1 THEN f.shipped_at ELSE c.changed_at END AS started_at
  ) AS s
  WHERE f.cancelled_at IS NULL
    AND f.delivered_at IS NULL
    AND f.shipping_carrier IN ('yamato', 'sagawa', 'japanpost')
    AND f.tracking_number IS NOT NULL
    AND (r.fulfillment_id IS NULL OR (r.state = 'stopped' AND r.stop_reason = 'disabled'))
    AND COALESCE(r.expires_at, s.started_at + interval '30 days') > pg_catalog.now()
$$;

-- 5. 配送メールを予定に入れる。呼ぶ側が注文・発送の鍵を持っている。条件に合わない時は何もせず false。
--    out_for_delivery は追跡オンで配達済みでない時、delivered は呼ぶ側が入力で決めた通知（発送の通知もオンの時だけ）、
--    shipping_update は直しの記録の通知の選択に従う。
CREATE OR REPLACE FUNCTION private.enqueue_delivery_email(
  _fulfillment_id uuid,
  _tracking_version integer,
  _kind text,
  _tracking_change_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_fulfillment public.order_fulfillments;
  v_change public.order_fulfillment_tracking_changes;
  v_enabled boolean;
BEGIN
  IF _fulfillment_id IS NULL
     OR _tracking_version IS NULL
     OR _kind IS NULL
     OR _kind NOT IN ('out_for_delivery', 'delivered', 'shipping_update')
     OR (_kind = 'shipping_update') <> (_tracking_change_id IS NOT NULL) THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT f.* INTO v_fulfillment FROM public.order_fulfillments AS f WHERE f.id = _fulfillment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FULFILLMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF _kind = 'shipping_update' THEN
    SELECT c.* INTO v_change FROM public.order_fulfillment_tracking_changes AS c WHERE c.id = _tracking_change_id;
    IF NOT FOUND OR v_change.fulfillment_id <> _fulfillment_id OR v_change.tracking_version <> _tracking_version THEN
      RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF NOT v_change.notify_customer THEN
      RETURN false;
    END IF;
  ELSIF NOT v_fulfillment.notify_customer THEN
    RETURN false;
  END IF;

  IF v_fulfillment.cancelled_at IS NOT NULL OR _tracking_version <> v_fulfillment.tracking_version THEN
    RETURN false;
  END IF;

  IF _kind = 'out_for_delivery' THEN
    SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1;
    IF NOT COALESCE(v_enabled, false) OR v_fulfillment.delivery_status = 'delivered' THEN
      RETURN false;
    END IF;
  END IF;

  INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, tracking_version, tracking_change_id)
  VALUES (v_fulfillment.order_id, _kind, NULL, 'auto', _fulfillment_id, _tracking_version, _tracking_change_id)
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;

-- 6. 発送の作成。最新（20261013001143_order_return_receipts.sql）の本文から次の差だけを入れる。
--    ・設定の行を FOR SHARE で先に取る（切り替えと同時に通さない）
--    ・発送の行に作成の指紋・状況の時刻（発送した時刻）を入れ、再送は指紋で比べる（番号を直した後も同じ発送を返す）
--    ・confirmed の最初の出来事を書き、追跡オンなら pending の登録（発送から30日）を同じ取引で書く
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
  v_enabled boolean;
  v_lines jsonb;
  v_fingerprint text;
  v_shipped_at timestamptz;
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

  v_lines := (
    SELECT pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('order_item_id', r.order_item_id, 'quantity', r.quantity)
             ORDER BY r.order_item_id
           )
    FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_quantities)) AS r(order_item_id, quantity)
  );
  v_fingerprint := private.fulfillment_create_fingerprint(_order_id, _shipping_carrier, _tracking_number, _notify_customer, v_lines);

  -- 追跡の切り替えと同時に通さない。鍵は 設定 → 注文 → 発送
  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;

  -- 同じ注文の操作（発送・取消・仕上がり）を1つずつ進める。同時に2つの発送が来ても、後の方は前の発送の後の数で確かめる
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 同じ重複防止キーの送り直し（通信が切れた後の「もう一度確かめる」）は、同じ中身なら前の結果を返す。
  -- 番号を直した後でも比べられるよう、作った時の指紋で比べる（指紋が無い古い行は、今の値と商品行から計算する）
  SELECT f.* INTO v_existing FROM public.order_fulfillments AS f WHERE f.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.order_id <> _order_id
       OR COALESCE(
            v_existing.request_fingerprint,
            private.fulfillment_create_fingerprint(
              v_existing.order_id, v_existing.shipping_carrier, v_existing.tracking_number,
              v_existing.notify_customer, private.fulfillment_lines_json(v_existing.id)
            )
          ) <> v_fingerprint THEN
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

  -- 発送した時刻と状況の時刻・最初の出来事の時刻を同じ値にそろえる
  v_shipped_at := pg_catalog.now();

  BEGIN
    INSERT INTO public.order_fulfillments AS f
      (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order, created_by,
       shipped_at, delivery_status_at, request_fingerprint)
    VALUES (_order_id, v_number, _request_key, _shipping_carrier, _tracking_number, _notify_customer, v_completes, _actor_id,
            v_shipped_at, v_shipped_at, v_fingerprint)
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

  INSERT INTO public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source)
  VALUES (v_fulfillment_id, 1, 'confirmed', v_shipped_at, 'shipment');

  IF COALESCE(v_enabled, false) THEN
    INSERT INTO private.fulfillment_tracking_registrations (fulfillment_id, tracking_version, carrier, tracking_number, expires_at)
    VALUES (v_fulfillment_id, 1, _shipping_carrier, pg_catalog.upper(_tracking_number), v_shipped_at + interval '30 days');
  END IF;

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

-- 7. 発送の取消。最新（20261013000456_order_return_actions.sql）の本文から次の差だけを入れる。
--    ・設定の行を FOR SHARE で先に取り、発送の行を FOR UPDATE にする
--    ・止めていない登録を cancelled で止め（外への停止の印は 3b の決まり）、開いた要対応を自動で閉じる
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

  PERFORM 1 FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;

  SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT f.cancelled_at INTO v_cancelled_at
  FROM public.order_fulfillments AS f
  WHERE f.id = _fulfillment_id
    AND f.order_id = _order_id
  FOR UPDATE;
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

  -- 止めていない登録だけを cancelled で止める（借りの印も無効にして、途中の結果を書かせない。
  -- すでに止まっている行の理由は変えない）。外への停止の印は 3b の決まりで付ける
  PERFORM private.stop_fulfillment_registrations(_fulfillment_id, 'cancelled');
  PERFORM private.close_delivery_attention(_fulfillment_id);

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

  -- まだ送っていない発送のメール（送る前・やり直し待ち）は取りやめる。配送の3種類も同じ行（発送の番号を持つ）。
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

-- 8. 伝票番号を直す。取り消した発送・同じ値は断り、配達済みの発送も直せる（新しい版の受付済みへ戻る）。
CREATE OR REPLACE FUNCTION public.admin_update_fulfillment_tracking(
  _order_id uuid,
  _fulfillment_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _shipping_carrier text,
  _tracking_number text,
  _notify_customer boolean
)
RETURNS TABLE (tracking_change_id uuid, tracking_version integer, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_enabled boolean;
  v_fulfillment public.order_fulfillments;
  v_change public.order_fulfillment_tracking_changes;
  v_change_id uuid;
  v_fingerprint text;
  v_create_fingerprint text;
  v_version integer;
  v_now timestamptz := pg_catalog.now();
  v_previous text;
  v_constraint text;
BEGIN
  IF _order_id IS NULL
     OR _fulfillment_id IS NULL
     OR _actor_id IS NULL
     OR _request_key IS NULL
     OR _notify_customer IS NULL
     OR _shipping_carrier IS NULL
     OR _shipping_carrier NOT IN ('yamato', 'sagawa', 'japanpost')
     OR _tracking_number IS NULL
     OR _tracking_number !~ '^[0-9A-Za-z-]{1,64}$' THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'order_id', _order_id,
      'fulfillment_id', _fulfillment_id,
      'shipping_carrier', _shipping_carrier,
      'tracking_number', _tracking_number,
      'notify_customer', _notify_customer
    )::text
  );

  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;

  PERFORM 1 FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT f.* INTO v_fulfillment
  FROM public.order_fulfillments AS f
  WHERE f.id = _fulfillment_id
    AND f.order_id = _order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FULFILLMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 同じキーの再送は、今の値や状態が変わっていても前の結果を返す（actor は比べない）
  SELECT c.* INTO v_change FROM public.order_fulfillment_tracking_changes AS c WHERE c.request_key = _request_key;
  IF FOUND THEN
    IF v_change.fulfillment_id <> _fulfillment_id OR v_change.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'DELIVERY_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_change.id, v_change.tracking_version, true;
    RETURN;
  END IF;

  IF v_fulfillment.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_FULFILLMENT_CANCELLED' USING ERRCODE = '22023';
  END IF;
  -- 通知のチェックだけの変更は断る（届いた記録と期限を、番号が同じまま消す操作にしない）
  IF v_fulfillment.shipping_carrier IS NOT DISTINCT FROM _shipping_carrier
     AND pg_catalog.upper(v_fulfillment.tracking_number) IS NOT DISTINCT FROM pg_catalog.upper(_tracking_number) THEN
    RAISE EXCEPTION 'DELIVERY_TRACKING_UNCHANGED' USING ERRCODE = '22023';
  END IF;

  v_version := v_fulfillment.tracking_version + 1;

  BEGIN
    INSERT INTO public.order_fulfillment_tracking_changes
      (fulfillment_id, from_carrier, to_carrier, from_tracking_number, to_tracking_number, tracking_version,
       notify_customer, request_key, request_fingerprint, changed_by, changed_at)
    VALUES (_fulfillment_id, v_fulfillment.shipping_carrier, _shipping_carrier, v_fulfillment.tracking_number,
            _tracking_number, v_version, _notify_customer, _request_key, v_fingerprint, _actor_id, v_now)
    RETURNING id INTO v_change_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_fulfillment_tracking_changes_request_key_key' THEN
      RAISE EXCEPTION 'DELIVERY_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  -- 作成の指紋が無い古い行は、直す前の値と商品行から作って、この更新で一度だけ保存する
  IF v_fulfillment.request_fingerprint IS NULL THEN
    v_create_fingerprint := private.fulfillment_create_fingerprint(
      v_fulfillment.order_id, v_fulfillment.shipping_carrier, v_fulfillment.tracking_number,
      v_fulfillment.notify_customer, private.fulfillment_lines_json(v_fulfillment.id)
    );
  END IF;

  v_previous := pg_catalog.current_setting('app.fulfillment_change', true);
  PERFORM pg_catalog.set_config('app.fulfillment_change', 'tracking_edit', true);
  UPDATE public.order_fulfillments AS f
  SET shipping_carrier = _shipping_carrier,
      tracking_number = _tracking_number,
      notify_customer = _notify_customer,
      delivery_status = 'confirmed',
      delivery_status_at = v_now,
      delivered_at = NULL,
      tracking_version = v_version,
      request_fingerprint = COALESCE(f.request_fingerprint, v_create_fingerprint)
  WHERE f.id = _fulfillment_id;
  PERFORM pg_catalog.set_config('app.fulfillment_change', COALESCE(v_previous, ''), true);

  INSERT INTO public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source)
  VALUES (_fulfillment_id, v_version, 'confirmed', v_now, 'tracking_edit');

  -- 前の版の止めていない登録だけを replaced にする（配達済みなどですでに止まっている行の理由は変えない）。
  -- 外への停止の印は 3b の決まりで付ける。新しい版の登録は、この後に作る
  PERFORM private.stop_fulfillment_registrations(_fulfillment_id, 'replaced');

  IF COALESCE(v_enabled, false) THEN
    INSERT INTO private.fulfillment_tracking_registrations (fulfillment_id, tracking_version, carrier, tracking_number, expires_at)
    VALUES (_fulfillment_id, v_version, _shipping_carrier, pg_catalog.upper(_tracking_number), v_now + interval '30 days');
  END IF;

  PERFORM private.close_delivery_attention(_fulfillment_id);

  -- 全部を送り終えた発送なら、注文の古い発送の列の写しも直す（部分発送は直さない）
  IF v_fulfillment.completes_order THEN
    PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
    PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_update_fulfillment_tracking', true);
    UPDATE public.orders AS o
    SET shipping_carrier = _shipping_carrier,
        tracking_number = _tracking_number
    WHERE o.id = _order_id
      AND o.status = 'shipped'::public.order_status;
  END IF;

  IF _notify_customer THEN
    PERFORM private.enqueue_delivery_email(_fulfillment_id, v_version, 'shipping_update', v_change_id);
  END IF;

  RETURN QUERY SELECT v_change_id, v_version, false;
END;
$$;

-- 9. 手で配達済みにする。届いた日の日本時間の正午を、発送した時刻と今で挟んだ時刻にする。
CREATE OR REPLACE FUNCTION public.admin_mark_fulfillment_delivered(
  _order_id uuid,
  _fulfillment_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _delivered_on date,
  _notify_customer boolean
)
RETURNS TABLE (event_id uuid, delivered_at timestamptz, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_fulfillment public.order_fulfillments;
  v_event public.order_fulfillment_events;
  v_event_id uuid;
  v_fingerprint text;
  v_delivered_at timestamptz;
  v_previous text;
  v_constraint text;
BEGIN
  IF _order_id IS NULL
     OR _fulfillment_id IS NULL
     OR _actor_id IS NULL
     OR _request_key IS NULL
     OR _delivered_on IS NULL
     OR _notify_customer IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'order_id', _order_id,
      'fulfillment_id', _fulfillment_id,
      'delivered_on', _delivered_on,
      'notify_customer', _notify_customer
    )::text
  );

  PERFORM 1 FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;

  PERFORM 1 FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT f.* INTO v_fulfillment
  FROM public.order_fulfillments AS f
  WHERE f.id = _fulfillment_id
    AND f.order_id = _order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FULFILLMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT e.* INTO v_event FROM public.order_fulfillment_events AS e WHERE e.request_key = _request_key;
  IF FOUND THEN
    IF v_event.fulfillment_id <> _fulfillment_id OR v_event.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'DELIVERY_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_event.id, v_event.happened_at, true;
    RETURN;
  END IF;

  IF v_fulfillment.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_FULFILLMENT_CANCELLED' USING ERRCODE = '22023';
  END IF;
  IF v_fulfillment.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_ALREADY_DELIVERED' USING ERRCODE = '22023';
  END IF;
  -- 発送の日から今日まで（どちらも日本時間の日付）
  IF _delivered_on < (v_fulfillment.shipped_at AT TIME ZONE 'Asia/Tokyo')::date
     OR _delivered_on > (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date THEN
    RAISE EXCEPTION 'DELIVERY_DATE_INVALID' USING ERRCODE = '22023';
  END IF;

  v_delivered_at := GREATEST(
    v_fulfillment.shipped_at,
    LEAST((_delivered_on + TIME '12:00') AT TIME ZONE 'Asia/Tokyo', pg_catalog.now())
  );

  v_previous := pg_catalog.current_setting('app.fulfillment_change', true);
  PERFORM pg_catalog.set_config('app.fulfillment_change', 'manual', true);
  UPDATE public.order_fulfillments AS f
  SET delivery_status = 'delivered',
      delivery_status_at = v_delivered_at,
      delivered_at = v_delivered_at
  WHERE f.id = _fulfillment_id;
  PERFORM pg_catalog.set_config('app.fulfillment_change', COALESCE(v_previous, ''), true);

  BEGIN
    INSERT INTO public.order_fulfillment_events
      (fulfillment_id, tracking_version, status, happened_at, source, created_by, request_key, request_fingerprint)
    VALUES (_fulfillment_id, v_fulfillment.tracking_version, 'delivered', v_delivered_at, 'manual', _actor_id,
            _request_key, v_fingerprint)
    RETURNING id INTO v_event_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_fulfillment_events_manual_request_idx' THEN
      RAISE EXCEPTION 'DELIVERY_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  UPDATE private.fulfillment_tracking_registrations AS r
  SET state = 'stopped',
      stop_reason = 'delivered',
      stopped_at = pg_catalog.now(),
      failure_kind = NULL,
      lease_token = NULL,
      lease_expires_at = NULL
  WHERE r.fulfillment_id = _fulfillment_id
    AND r.tracking_version = v_fulfillment.tracking_version
    AND r.state <> 'stopped';

  PERFORM private.close_delivery_attention(_fulfillment_id);

  -- 発送の通知もオンで、入力でもオンの時だけ（発送の通知の列は変えない）
  IF v_fulfillment.notify_customer AND _notify_customer THEN
    PERFORM private.enqueue_delivery_email(_fulfillment_id, v_fulfillment.tracking_version, 'delivered');
  END IF;

  RETURN QUERY SELECT v_event_id, v_delivered_at, false;
END;
$$;

-- 10. 追跡を切り替える。鍵は 設定（FOR UPDATE）→ 対象の注文（id 順）→ 発送（id 順）。
--     オンは取り込み対象（4.）に pending を作り、期限内の disabled の行は同じ行を pending に戻す（ever_registered・registered_at・期限は保つ）。
--     オフは止めていない登録を disabled にし、全登録の借りの印と外への停止の印を消し、開いた要対応を全部 auto で閉じる。
--     記録した出来事と届いた時刻は消さない。変えた時だけ更新者と時刻を書く。
CREATE OR REPLACE FUNCTION public.admin_set_delivery_tracking(_enabled boolean, _actor_id uuid)
RETURNS TABLE (enabled boolean, updated_at timestamptz, updated_by uuid, backfilled_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_ids uuid[];
  v_count integer := 0;
  v_rows integer;
BEGIN
  IF _enabled IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.shop_settings AS s WHERE s.id = 1 FOR UPDATE;

  PERFORM pg_catalog.set_config('app.delivery_tracking_setting', 'toggle', true);
  UPDATE public.shop_settings AS s
  SET delivery_tracking_enabled = _enabled,
      delivery_tracking_updated_at = CASE
        WHEN s.delivery_tracking_enabled IS DISTINCT FROM _enabled THEN pg_catalog.now()
        ELSE s.delivery_tracking_updated_at
      END,
      delivery_tracking_updated_by = CASE
        WHEN s.delivery_tracking_enabled IS DISTINCT FROM _enabled THEN _actor_id
        ELSE s.delivery_tracking_updated_by
      END
  WHERE s.id = 1;
  PERFORM pg_catalog.set_config('app.delivery_tracking_setting', '', true);

  IF _enabled THEN
    SELECT pg_catalog.array_agg(t.fulfillment_id) INTO v_ids FROM private.delivery_tracking_backfill_targets() AS t;
  ELSE
    SELECT pg_catalog.array_agg(x.fulfillment_id) INTO v_ids
    FROM (
      SELECT r.fulfillment_id
      FROM private.fulfillment_tracking_registrations AS r
      WHERE r.state <> 'stopped' OR r.lease_token IS NOT NULL OR r.provider_stop_pending
      UNION
      SELECT a.fulfillment_id
      FROM public.order_fulfillment_attention AS a
      WHERE a.resolved_at IS NULL
    ) AS x;
  END IF;

  PERFORM 1
  FROM public.orders AS o
  WHERE o.id IN (SELECT f.order_id FROM public.order_fulfillments AS f WHERE f.id = ANY (v_ids))
  ORDER BY o.id
  FOR UPDATE;
  PERFORM 1
  FROM public.order_fulfillments AS f
  WHERE f.id = ANY (v_ids)
  ORDER BY f.id
  FOR UPDATE;

  IF _enabled THEN
    -- 期限内の disabled の行は同じ行を戻す。対象の選び方は設定の件数と同じ SELECT
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'pending',
        failure_kind = NULL,
        stop_reason = NULL,
        stopped_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        attempts = 0,
        read_attempts = 0,
        retry_allowed = true,
        last_error_code = NULL,
        claimed_signal_revision = NULL,
        stop_signaled = false,
        provider_stop_pending = false,
        next_run_at = pg_catalog.now()
    FROM private.delivery_tracking_backfill_targets() AS t
    WHERE r.fulfillment_id = t.fulfillment_id
      AND r.tracking_version = t.tracking_version
      AND r.state = 'stopped'
      AND r.stop_reason = 'disabled';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_rows;

    -- 戻した行は対象から外れているので、ここに残るのは登録の無い現版だけ
    INSERT INTO private.fulfillment_tracking_registrations (fulfillment_id, tracking_version, carrier, tracking_number, expires_at)
    SELECT f.id, t.tracking_version, f.shipping_carrier, pg_catalog.upper(f.tracking_number), t.expires_at
    FROM private.delivery_tracking_backfill_targets() AS t
    JOIN public.order_fulfillments AS f ON f.id = t.fulfillment_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  ELSE
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'stopped',
        stop_reason = 'disabled',
        stopped_at = pg_catalog.now(),
        failure_kind = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        provider_stop_pending = false
    WHERE r.state <> 'stopped';

    UPDATE private.fulfillment_tracking_registrations AS r
    SET lease_token = NULL,
        lease_expires_at = NULL,
        provider_stop_pending = false
    WHERE r.lease_token IS NOT NULL OR r.provider_stop_pending;

    UPDATE public.order_fulfillment_attention AS a
    SET resolved_at = pg_catalog.now(),
        resolution = 'auto'
    WHERE a.resolved_at IS NULL;
  END IF;

  RETURN QUERY
  SELECT s.delivery_tracking_enabled, s.delivery_tracking_updated_at, s.delivery_tracking_updated_by, v_count
  FROM public.shop_settings AS s
  WHERE s.id = 1;
END;
$$;

-- 11. 配送の要対応を手で閉じる。閉じた行へ重ねて押された時は already_resolved（別の新しい行は閉じない）
CREATE OR REPLACE FUNCTION public.admin_resolve_delivery_attention(_attention_id uuid, _actor_id uuid)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF _attention_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE public.order_fulfillment_attention AS a
  SET resolved_at = pg_catalog.now(),
      resolved_by = _actor_id,
      resolution = 'manual'
  WHERE a.id = _attention_id
    AND a.resolved_at IS NULL;
  IF FOUND THEN
    RETURN QUERY SELECT 'resolved'::text;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.order_fulfillment_attention AS a WHERE a.id = _attention_id) THEN
    RAISE EXCEPTION 'DELIVERY_ATTENTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT 'already_resolved'::text;
END;
$$;

-- 12. 読み出し。service_role 専用で、呼ぶ側が本人・権限を確かめている前提。
--     最後に変えた人のメールは auth.users から読む。取り込みの件数は 4. と同じ SELECT。
CREATE OR REPLACE FUNCTION public.get_delivery_tracking_settings()
RETURNS TABLE (enabled boolean, updated_at timestamptz, updated_by_email text, backfill_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.delivery_tracking_enabled,
         s.delivery_tracking_updated_at,
         u.email::text,
         (SELECT pg_catalog.count(*)::integer FROM private.delivery_tracking_backfill_targets())
  FROM public.shop_settings AS s
  LEFT JOIN auth.users AS u ON u.id = s.delivery_tracking_updated_by
  WHERE s.id = 1
$$;

-- 注文一覧の1ページ分（200注文まで）。取消でない発送の数・配達済みの数・開いた要対応の印（問題あり → 不在 → 追跡できない）を
-- 1回で数える。注文のあるものは発送が無くても0で返し、数え間違いを空にしない。
CREATE OR REPLACE FUNCTION public.list_order_delivery_summaries(_order_ids uuid[])
RETURNS TABLE (order_id uuid, active_count integer, delivered_count integer, attention_kind text)
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
  SELECT o.id, c.active_count, c.delivered_count, a.kind
  FROM public.orders AS o
  CROSS JOIN LATERAL (
    SELECT (pg_catalog.count(*) FILTER (WHERE f.cancelled_at IS NULL))::integer AS active_count,
           (pg_catalog.count(*) FILTER (WHERE f.cancelled_at IS NULL AND f.delivered_at IS NOT NULL))::integer AS delivered_count
    FROM public.order_fulfillments AS f
    WHERE f.order_id = o.id
  ) AS c
  LEFT JOIN LATERAL (
    SELECT x.kind
    FROM public.order_fulfillment_attention AS x
    JOIN public.order_fulfillments AS xf ON xf.id = x.fulfillment_id
    WHERE xf.order_id = o.id
      AND x.resolved_at IS NULL
    ORDER BY CASE x.kind
               WHEN 'delivery_failure' THEN 1
               WHEN 'attempted_delivery' THEN 2
               WHEN 'tracking_not_found' THEN 3
               WHEN 'tracking_registration_failed' THEN 4
               ELSE 5
             END,
             x.kind
    LIMIT 1
  ) AS a ON true
  WHERE o.id = ANY (_order_ids)
  ORDER BY o.id;
END;
$$;

-- 注文1件の配送の全部（管理用）。出来事の実行者・細かい状況・旧版・登録の状態を含むので、お客様へそのまま返さない。
-- 取り消した発送も cancelled_at つきで返し、配列の組み立てはこの中で行う。
CREATE OR REPLACE FUNCTION public.get_order_delivery_detail(_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  IF _order_id IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = _order_id) THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1;

  RETURN pg_catalog.jsonb_build_object(
    'enabled', COALESCE(v_enabled, false),
    'fulfillments', COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'fulfillment_id', f.id,
          'number', f.number,
          'carrier', f.shipping_carrier,
          'tracking_number', f.tracking_number,
          'notify_customer', f.notify_customer,
          'shipped_at', f.shipped_at,
          'cancelled_at', f.cancelled_at,
          'tracking_version', f.tracking_version,
          'delivery_status', f.delivery_status,
          'delivery_status_at', f.delivery_status_at,
          'delivered_at', f.delivered_at,
          'delivered_source', CASE
            WHEN f.delivered_at IS NULL THEN NULL
            WHEN EXISTS (
              SELECT 1
              FROM public.order_fulfillment_events AS m
              WHERE m.fulfillment_id = f.id
                AND m.tracking_version = f.tracking_version
                AND m.source = 'manual'
                AND m.status = 'delivered'
            ) THEN 'manual'
            ELSE 'tracking'
          END,
          'registration', (
            SELECT pg_catalog.jsonb_build_object(
                     'state', r.state,
                     'failure_kind', r.failure_kind,
                     'stop_reason', r.stop_reason,
                     'expires_at', r.expires_at,
                     'ever_registered', r.ever_registered
                   )
            FROM private.fulfillment_tracking_registrations AS r
            WHERE r.fulfillment_id = f.id
              AND r.tracking_version = f.tracking_version
          ),
          'events', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'id', e.id,
                       'tracking_version', e.tracking_version,
                       'status', e.status,
                       'happened_at', e.happened_at,
                       'recorded_at', e.recorded_at,
                       'source', e.source,
                       'provider_sub_status', e.provider_sub_status,
                       'actor_email', eu.email::text
                     )
                     ORDER BY e.tracking_version DESC, e.happened_at DESC, e.recorded_at DESC, e.id
                   )
            FROM public.order_fulfillment_events AS e
            LEFT JOIN auth.users AS eu ON eu.id = e.created_by
            WHERE e.fulfillment_id = f.id
          ), '[]'::jsonb),
          'tracking_changes', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'id', c.id,
                       'from_carrier', c.from_carrier,
                       'from_tracking_number', c.from_tracking_number,
                       'to_carrier', c.to_carrier,
                       'to_tracking_number', c.to_tracking_number,
                       'tracking_version', c.tracking_version,
                       'notify_customer', c.notify_customer,
                       'changed_at', c.changed_at,
                       'actor_email', cu.email::text,
                       'email_status', (
                         SELECT m.status
                         FROM private.order_email_outbox AS m
                         WHERE m.tracking_change_id = c.id
                           AND m.kind = 'shipping_update'
                           AND m.origin = 'auto'
                         ORDER BY m.seq DESC
                         LIMIT 1
                       )
                     )
                     ORDER BY c.changed_at DESC, c.id
                   )
            FROM public.order_fulfillment_tracking_changes AS c
            LEFT JOIN auth.users AS cu ON cu.id = c.changed_by
            WHERE c.fulfillment_id = f.id
          ), '[]'::jsonb)
        )
        ORDER BY f.number
      )
      FROM public.order_fulfillments AS f
      WHERE f.order_id = _order_id
    ), '[]'::jsonb)
  );
END;
$$;

-- 開いている配送の要対応（古い順）。total は limit の前の件数。注文番号は画面の ORD-XXXXXXXX と同じ作り方。
CREATE OR REPLACE FUNCTION public.list_delivery_attention(_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total integer;
  v_items jsonb;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 100 THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_total
  FROM public.order_fulfillment_attention AS a
  WHERE a.resolved_at IS NULL;

  SELECT COALESCE(pg_catalog.jsonb_agg(x.item ORDER BY x.opened_at, x.id), '[]'::jsonb) INTO v_items
  FROM (
    SELECT a.id,
           a.opened_at,
           pg_catalog.jsonb_build_object(
             'id', a.id,
             'order_id', o.id,
             'order_number', 'ORD-' || pg_catalog.upper(pg_catalog.left(o.id::text, 8)),
             'fulfillment_id', f.id,
             'fulfillment_number', f.number,
             'kind', a.kind,
             'opened_at', a.opened_at,
             'status', f.delivery_status
           ) AS item
    FROM public.order_fulfillment_attention AS a
    JOIN public.order_fulfillments AS f ON f.id = a.fulfillment_id
    JOIN public.orders AS o ON o.id = f.order_id
    WHERE a.resolved_at IS NULL
    ORDER BY a.opened_at, a.id
    LIMIT _limit
  ) AS x;

  RETURN pg_catalog.jsonb_build_object('items', v_items, 'total', v_total);
END;
$$;

-- 13. 取りやめ。最新（20261013001143_order_return_receipts.sql）の本文から、配送メールの条件だけを足す。
--     ・fulfillment_cancelled: 取り消した発送の、発送と配送3種類のメール
--     ・superseded: 旧版の配達中・配達済みと、配達済みの後の配達中だけ（発送の更新は取りやめない）
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

  -- 取りやめ（superseded）は入金待ちと支払い期限切れ、返金が失敗・エラーになった返金の行、返金待ちが0の店への知らせ、
  -- 古くなった配達中・配達済みだけ。入金済み・取消・発送、返金が失敗・エラーでない返金の行は、その時の事実を伝えるので取りやめない
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
      AND NOT (
        e.kind IN ('out_for_delivery', 'delivered')
        AND EXISTS (
          SELECT 1
          FROM public.order_fulfillments AS f
          WHERE f.id = e.fulfillment_id
            AND (
              e.tracking_version < f.tracking_version
              OR (e.kind = 'out_for_delivery' AND f.delivery_status = 'delivered')
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'SUPERSEDE_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  -- 発送の取消による取りやめは、取り消した発送の発送・配送のメールだけ（worker の思い違いで、送るべきメールを落とさない）
  IF _reason = 'fulfillment_cancelled' AND EXISTS (
    SELECT 1
    FROM private.order_email_outbox AS e
    LEFT JOIN public.order_fulfillments AS f ON f.id = e.fulfillment_id
    WHERE e.id = _email_id
      AND (e.kind NOT IN ('shipped', 'out_for_delivery', 'delivered', 'shipping_update') OR f.cancelled_at IS NULL)
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

-- 14. 返品の期限。最新（20261012235910_order_return_records.sql）の本文から、届いた日の決め方だけを変える。
--     届いた日 = delivered_at があればその日本時間の日付（目安は足さない）、無ければ発送の日（日本時間）+ 目安の日数。
--     そのほか（品ごと／最後の品・日数・日の終わり・無制限・取消した発送を除く）は変えない。
CREATE OR REPLACE FUNCTION private.fulfillment_line_returnable(_order_id uuid)
RETURNS TABLE (
  fulfillment_id uuid,
  fulfillment_number integer,
  shipped_at timestamptz,
  order_item_id uuid,
  quantity integer,
  in_returns integer,
  missing integer,
  returnable integer,
  deadline_date date
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH settings AS (
    SELECT s.window_days, s.window_start, s.delivery_buffer_days
    FROM public.shop_return_settings AS s
    WHERE s.id = 1
  ),
  shipments AS (
    SELECT f.id,
           f.number,
           f.shipped_at,
           CASE
             WHEN f.delivered_at IS NOT NULL THEN (f.delivered_at AT TIME ZONE 'Asia/Tokyo')::date
             ELSE (f.shipped_at AT TIME ZONE 'Asia/Tokyo')::date + s.delivery_buffer_days
           END AS arrival_date
    FROM public.order_fulfillments AS f
    CROSS JOIN settings AS s
    WHERE f.order_id = _order_id
      AND f.cancelled_at IS NULL
  ),
  per_line AS (
    -- 状態の扱いを変える時は、ここ・order_return_line_states_core の item_totals と line_waiting の reopened_waiting の CASE・order_line_return_counts の totals の4か所をそろえる。
    SELECT st.fulfillment_id,
           st.order_item_id,
           pg_catalog.sum(st.quantity)::integer AS in_returns,
           pg_catalog.sum(st.missing)::integer AS missing
    FROM private.order_return_line_states(_order_id) AS st
    WHERE st.return_status IN ('requested', 'open', 'closed')
    GROUP BY st.fulfillment_id, st.order_item_id
  )
  SELECT sh.id,
         sh.number,
         sh.shipped_at,
         fl.order_item_id,
         fl.quantity,
         COALESCE(p.in_returns, 0),
         COALESCE(p.missing, 0),
         GREATEST(fl.quantity - COALESCE(p.in_returns, 0) + COALESCE(p.missing, 0), 0),
         CASE
           WHEN s.window_days IS NULL THEN NULL
           WHEN s.window_start = 'last_item' THEN (SELECT pg_catalog.max(x.arrival_date) FROM shipments AS x) + s.window_days
           ELSE sh.arrival_date + s.window_days
         END
  FROM shipments AS sh
  JOIN public.order_fulfillment_lines AS fl ON fl.fulfillment_id = sh.id
  CROSS JOIN settings AS s
  LEFT JOIN per_line AS p ON p.fulfillment_id = sh.id AND p.order_item_id = fl.order_item_id
  ORDER BY sh.number, fl.order_item_id
$$;

-- 15. 権限。public の関数は service_role だけ。private の補助は誰も直接呼べない（SECURITY DEFINER の関数の中だけで使う）
REVOKE ALL ON FUNCTION private.fulfillment_lines_json(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.fulfillment_create_fingerprint(uuid, text, text, boolean, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.close_delivery_attention(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.stop_fulfillment_registrations(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.delivery_tracking_backfill_targets() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.enqueue_delivery_email(uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.fulfillment_line_returnable(uuid) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_create_fulfillment(uuid, uuid, uuid, text, text, boolean, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_cancel_fulfillment(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_update_fulfillment_tracking(uuid, uuid, uuid, uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_mark_fulfillment_delivered(uuid, uuid, uuid, uuid, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_delivery_tracking(boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_resolve_delivery_attention(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_delivery_tracking_settings() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_delivery_summaries(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_delivery_detail(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_delivery_attention(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skip_order_email(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_create_fulfillment(uuid, uuid, uuid, text, text, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_fulfillment(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_fulfillment_tracking(uuid, uuid, uuid, uuid, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_mark_fulfillment_delivered(uuid, uuid, uuid, uuid, date, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_delivery_tracking(boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_delivery_attention(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_delivery_tracking_settings() TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_delivery_summaries(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_delivery_detail(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_delivery_attention(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.skip_order_email(uuid, uuid, text) TO service_role;

-- 移行 A を当ててからこの移行を当てるまでの間に、古い作成の関数で作られた発送にも最初の出来事を補う（何度流しても同じ）。
SELECT private.backfill_delivery_events();

NOTIFY pgrst, 'reload schema';

COMMIT;
