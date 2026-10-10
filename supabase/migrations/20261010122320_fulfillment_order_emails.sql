-- 部分発送と注文の進み具合（グループ E-1 設計書 6・7・8 章）の移行 B
--
-- 注文のメールの表（グループ D の outbox）に発送の番号の列を足し、発送のメールを発送ごとに1行にする。
-- 発送の関数と発送の取消の関数を作り、前の発送の関数（admin_ship_paid_order。発送は注文に1回だけだった）と、
-- 受注の集計の view（variant_backorder_summary。在庫の画面は移行 A の list_variant_stock_states に替える）を消す。
-- 移行 A（20261010120000_order_fulfillments.sql）の後に当てる。
BEGIN;

-- 1. 発送の番号の列（設計書 8-1）。発送の記録は消せない（移行 A の守り）ので、消す時の決まりは RESTRICT
ALTER TABLE private.order_email_outbox
  ADD COLUMN IF NOT EXISTS fulfillment_id uuid REFERENCES public.order_fulfillments (id) ON DELETE RESTRICT;

-- 2. 前の発送のメールの行を、移行 A が写した前からの発送（注文ごとに1つ）に結ぶ（設計書 8-4）。
--    何度呼んでも同じ結果。結んだ行の数を返す
CREATE OR REPLACE FUNCTION private.link_legacy_shipped_emails()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_linked integer;
BEGIN
  UPDATE private.order_email_outbox AS e
  SET fulfillment_id = f.id
  FROM public.order_fulfillments AS f
  WHERE e.kind = 'shipped'
    AND e.fulfillment_id IS NULL
    AND f.order_id = e.order_id
    AND f.legacy;
  GET DIAGNOSTICS v_linked = ROW_COUNT;
  RETURN v_linked;
END;
$$;

-- 移行 A の後に前の関数で発送した注文も写してから結ぶ（写しは何度呼んでも同じ結果）
SELECT private.backfill_legacy_fulfillments();

SELECT private.link_legacy_shipped_emails();

-- 発送のメールは必ず発送を持ち、ほかの種類は持たない。結べなかった行が残れば、ここで移行全体が止まる
ALTER TABLE private.order_email_outbox DROP CONSTRAINT IF EXISTS order_email_outbox_fulfillment_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_fulfillment_check CHECK ((kind = 'shipped') = (fulfillment_id IS NOT NULL));

-- 3. 一意の決まり（設計書 8-1）
--    自動の行: 発送のメールは発送ごとに1行、ほかの種類は今のまま1注文1種類1行
--    手の再送: 送信待ちの間、発送のメールは発送ごとに1行、ほかの種類は1注文1種類1行（発送の番号の空を同じ値とみなす）
DROP INDEX IF EXISTS private.order_email_outbox_auto_once_idx;
CREATE UNIQUE INDEX order_email_outbox_auto_once_idx
  ON private.order_email_outbox (order_id, kind)
  WHERE origin = 'auto' AND kind <> 'shipped';

CREATE UNIQUE INDEX IF NOT EXISTS order_email_outbox_auto_shipped_idx
  ON private.order_email_outbox (fulfillment_id)
  WHERE origin = 'auto' AND kind = 'shipped';

DROP INDEX IF EXISTS private.order_email_outbox_manual_open_idx;
CREATE UNIQUE INDEX order_email_outbox_manual_open_idx
  ON private.order_email_outbox (order_id, kind, fulfillment_id) NULLS NOT DISTINCT
  WHERE origin = 'manual' AND status IN ('pending', 'sending', 'retry_wait');

-- 発送の取消と再送で、その発送のメールを探す
CREATE INDEX IF NOT EXISTS order_email_outbox_fulfillment_idx
  ON private.order_email_outbox (fulfillment_id)
  WHERE fulfillment_id IS NOT NULL;

-- 4. 予定を書く（設計書 8-1）。発送のメールは発送の番号を必ず渡す（無ければ表の CHECK で止まる）。
--    引数を足すので作り直す。3つの引数の呼び方（入金済み・入金待ち・期限切れ・取消）は、そのまま新しい関数に当たる
DROP FUNCTION IF EXISTS private.enqueue_order_email(uuid, text, text);

CREATE OR REPLACE FUNCTION private.enqueue_order_email(
  _order_id uuid,
  _kind text,
  _variant text DEFAULT NULL,
  _fulfillment_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF _kind = 'shipped' THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id)
    ON CONFLICT (fulfillment_id) WHERE origin = 'auto' AND kind = 'shipped' DO NOTHING;
  ELSE
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id)
    ON CONFLICT (order_id, kind) WHERE origin = 'auto' AND kind <> 'shipped' DO NOTHING;
  END IF;
  RETURN FOUND;
END;
$$;

-- 5. 送る行を1つ取り出す（グループ D 設計書 4-1・4-3・4-5）。worker が発送の材料を読めるよう、最後の列に発送の番号を足す。
--    返す列を変えるので作り直す。ほかの中身は前と同じ
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
  fulfillment_id uuid
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
              e.fulfillment_id
  )
  SELECT c.id, c.order_id, c.kind, c.variant, c.origin, c.attempts, c.lease_token, c.subject, c.body_text,
         EXISTS (
           SELECT 1
           FROM private.order_email_outbox AS x
           WHERE x.order_id = c.order_id
             AND x.kind = 'payment_expired'
             AND x.status = 'sent'
         ),
         c.fulfillment_id
  FROM claimed AS c;
END;
$$;

-- 6. 取りやめ（グループ D 設計書 4-1）。発送の取消の理由を足す（設計書 7-3）
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

  -- 取りやめ（superseded）は入金待ちと支払い期限切れだけ（グループ D 設計書 4-1）。入金済み・取消・発送はその時の事実を伝えるので取りやめない
  IF _reason = 'superseded' AND EXISTS (
    SELECT 1
    FROM private.order_email_outbox AS e
    WHERE e.id = _email_id
      AND e.kind NOT IN ('awaiting_payment', 'payment_expired')
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

-- 7. 管理画面の再送（グループ D 設計書 5-3、E-1 設計書 8-2）。発送のメールは発送ごとに再送する。
--    発送の番号を足すので作り直す
DROP FUNCTION IF EXISTS public.request_order_email_resend(uuid, text, uuid);

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
  v_found boolean;
  v_email_id uuid;
BEGIN
  IF _order_id IS NULL OR _kind IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RESEND_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF _kind NOT IN ('paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped') THEN
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

  -- 発送のメールは、一部だけ送った決済完了の注文でも再送できる
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

  SELECT e.variant, true INTO v_variant, v_found
  FROM private.order_email_outbox AS e
  WHERE e.order_id = _order_id
    AND e.kind = _kind
    AND e.fulfillment_id IS NOT DISTINCT FROM _fulfillment_id
    AND e.status IN ('sent', 'dead')
  ORDER BY e.seq DESC
  LIMIT 1;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, requested_by, fulfillment_id)
    VALUES (_order_id, _kind, v_variant, 'manual', _actor_id, _fulfillment_id)
    RETURNING id INTO v_email_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'RESEND_ALREADY_QUEUED' USING ERRCODE = '23505';
  END;

  RETURN v_email_id;
END;
$$;

-- 8. 管理画面の履歴（グループ D 設計書 5-1）。発送のメールの発送の番号と何回目かを足す（E-1 設計書 9-2）。本文は返さない。
--    返す列を変えるので作り直す
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
  fulfillment_number integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.kind, e.variant, e.origin, u.email::text, e.status, e.attempts, e.last_error_code,
         e.delivery_status, e.delivery_event_at, e.created_at, e.sent_at, e.finished_at,
         e.body_text IS NOT NULL, e.body_erased_at IS NOT NULL,
         e.fulfillment_id, f.number
  FROM private.order_email_outbox AS e
  LEFT JOIN auth.users AS u ON u.id = e.requested_by
  LEFT JOIN public.order_fulfillments AS f ON f.id = e.fulfillment_id
  WHERE e.order_id = _order_id
  ORDER BY e.seq DESC
$$;

-- 9. 発送する（設計書 6-3）。在庫は注文の時に確保済みなので動かさず、色・サイズの在庫に鍵はかけない
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

-- 10. 発送の取消（設計書 7-3）。何度押しても同じ結果
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

  -- 取り消した注文（返金で取り消した注文を含む）の発送は戻さない（E-2・E-3 で、返品や発送後の返金に使われた発送を拒む条件を足す）
  IF v_status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status) THEN
    RAISE EXCEPTION 'FULFILLMENT_CANCEL_NOT_ALLOWED' USING ERRCODE = '22023';
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

-- 11. 前の発送の関数（発送は注文に1回だけだった）と、受注の集計の view（在庫の画面は list_variant_stock_states に替える）を消す
DROP FUNCTION IF EXISTS public.admin_ship_paid_order(uuid, uuid, text, text, boolean);
DROP VIEW IF EXISTS public.variant_backorder_summary;

-- 12. 権限。private の関数は PUBLIC から外すだけ
REVOKE ALL ON FUNCTION private.link_legacy_shipped_emails() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_order_email(uuid, text, text, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.claim_order_email(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skip_order_email(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_order_email_resend(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_email_history(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_create_fulfillment(uuid, uuid, uuid, text, text, boolean, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_cancel_fulfillment(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_order_email(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.skip_order_email(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_order_email_resend(uuid, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_email_history(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_fulfillment(uuid, uuid, uuid, text, text, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_fulfillment(uuid, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
