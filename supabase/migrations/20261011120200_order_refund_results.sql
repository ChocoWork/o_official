-- 返金の結果を書く関数と、注文のメールの表の変更（グループ E-2 設計書 4・6〜8・11 章）の移行 C
--
-- Stripe が返金を受け付けた・成功した・失敗した結果を、返金の記録・在庫・お客様へのメールの予定・要対応・
-- 注文の返金済みの額と状態へ、1回の処理で書く。Stripe の画面からの返金（こちらの印の無い返金）の記録と、
-- 返事待ちのエラーも、同じ道を通る。
-- 注文のメールの表に返金の番号の列を足し、返金のお知らせと支払い済みのキャンセルのお知らせを返金ごとの行にする。
-- 要対応の理由に「返金の失敗」を足し、前の返金の関数（apply_order_refund_projection。注文の額と状態だけを書いた）を消す。
-- 移行 A（20261011120000_order_refund_records.sql）・移行 B（20261011120100_order_refund_requests.sql）の後に当てる。
BEGIN;

-- 1. 注文のメールの表: 返金の番号の列と、種類・書き分け・返金の番号の CHECK（設計書 8-6）。
--    返金の記録は消せない（移行 A の守り）ので、消す時の決まりは RESTRICT
ALTER TABLE private.order_email_outbox
  ADD COLUMN IF NOT EXISTS refund_id uuid REFERENCES public.order_refunds (id) ON DELETE RESTRICT;

-- 種類の CHECK と要対応の理由の CHECK は、列に直接書いたので名前が付いていない。
-- 名前を付けて作り直すため、その列だけを見る CHECK を表から探して消す
DO $$
DECLARE
  v_target record;
  v_name text;
BEGIN
  FOR v_target IN
    SELECT t.rel, t.col
    FROM (VALUES
      ('private.order_email_outbox'::regclass, 'kind'::text),
      ('public.payment_exceptions'::regclass, 'reason'::text)
    ) AS t(rel, col)
  LOOP
    FOR v_name IN
      SELECT c.conname
      FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = v_target.rel
        AND c.contype = 'c'
        AND c.conkey = ARRAY[(
          SELECT a.attnum
          FROM pg_catalog.pg_attribute AS a
          WHERE a.attrelid = v_target.rel
            AND a.attname = v_target.col
        )]
    LOOP
      EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT %I', v_target.rel, v_name);
    END LOOP;
  END LOOP;
END
$$;

ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_kind_check
  CHECK (kind IN ('paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped', 'refund'));

ALTER TABLE public.payment_exceptions
  ADD CONSTRAINT payment_exceptions_reason_check
  CHECK (reason IN (
    'order_not_creatable', 'paid_amount_mismatch', 'cancelled_order_paid',
    'state_conflict', 'unexpected_state', 'stripe_object_missing', 'refund_failed'
  ));

-- 書き分け: 取消に paid（支払い済みのキャンセル）、返金に standard・after_cancel を足す。
-- CHECK は NULL を通すので、書き分けが要る種類は IS NOT NULL も確かめる
ALTER TABLE private.order_email_outbox DROP CONSTRAINT IF EXISTS order_email_outbox_variant_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_variant_check CHECK (
    (kind = 'paid' AND variant IS NOT NULL
      AND variant IN ('order_confirmed', 'payment_received', 'payment_received_after_expiry'))
    OR (kind = 'canceled' AND variant IS NOT NULL AND variant IN ('payment_in_progress', 'pending', 'paid'))
    OR (kind = 'refund' AND variant IS NOT NULL AND variant IN ('standard', 'after_cancel'))
    OR (kind IN ('awaiting_payment', 'payment_expired', 'shipped') AND variant IS NULL)
  );

-- 返金の番号は、返金のお知らせと、支払い済みのキャンセルのお知らせだけが持つ
ALTER TABLE private.order_email_outbox DROP CONSTRAINT IF EXISTS order_email_outbox_refund_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_refund_check CHECK (
    (refund_id IS NOT NULL) = (kind = 'refund' OR (kind = 'canceled' AND variant = 'paid'))
  );

-- 2. 一意の決まり（設計書 8-6）
--    自動の行: 返金に結び付く行（返金のお知らせ・支払い済みのキャンセルのお知らせ）は返金ごとに1行、
--    発送のメールは発送ごとに1行（E-1 の移行 B の索引のまま）、ほかの種類は今のまま1注文1種類1行
--    手の再送: 送信待ちの間、同じ注文・種類・発送・返金は1行（空を同じ値とみなす）
DROP INDEX IF EXISTS private.order_email_outbox_auto_once_idx;
CREATE UNIQUE INDEX order_email_outbox_auto_once_idx
  ON private.order_email_outbox (order_id, kind)
  WHERE origin = 'auto' AND kind <> 'shipped' AND refund_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS order_email_outbox_auto_refund_idx
  ON private.order_email_outbox (refund_id, kind)
  WHERE origin = 'auto' AND refund_id IS NOT NULL;

DROP INDEX IF EXISTS private.order_email_outbox_manual_open_idx;
CREATE UNIQUE INDEX order_email_outbox_manual_open_idx
  ON private.order_email_outbox (order_id, kind, fulfillment_id, refund_id) NULLS NOT DISTINCT
  WHERE origin = 'manual' AND status IN ('pending', 'sending', 'retry_wait');

-- 3. 予定を書く（設計書 8-6）。返金のお知らせと、支払い済みのキャンセルのお知らせは、返金の番号を必ず渡す
--    （無ければ表の CHECK で止まる）。引数を足すので、4つの引数の形は消して作り直す。
--    4つ以下の引数の呼び方（入金済み・入金待ち・期限切れ・取消・発送）は、そのまま新しい関数に当たる
DROP FUNCTION IF EXISTS private.enqueue_order_email(uuid, text, text, uuid);

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
BEGIN
  IF _kind = 'shipped' THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id)
    ON CONFLICT (fulfillment_id) WHERE origin = 'auto' AND kind = 'shipped' DO NOTHING;
  ELSIF _refund_id IS NOT NULL THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id)
    ON CONFLICT (refund_id, kind) WHERE origin = 'auto' AND refund_id IS NOT NULL DO NOTHING;
  ELSE
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, fulfillment_id, refund_id)
    VALUES (_order_id, _kind, _variant, 'auto', _fulfillment_id, _refund_id)
    ON CONFLICT (order_id, kind) WHERE origin = 'auto' AND kind <> 'shipped' AND refund_id IS NULL DO NOTHING;
  END IF;
  RETURN FOUND;
END;
$$;

-- 4. 送る行を1つ取り出す（グループ D 設計書 4-1・4-3・4-5）。worker が返金の材料を読めるよう、最後の列に返金の番号を足す。
--    返す列を変えるので作り直す。ほかの中身は前（E-1 の移行 B）と同じ
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
  refund_id uuid
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
              e.fulfillment_id, e.refund_id
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
         c.refund_id
  FROM claimed AS c;
END;
$$;

-- 5. 管理画面の再送（グループ D 設計書 5-3、E-1 設計書 8-2、E-2 設計書 8-1・8-2）。
--    返金のお知らせは再送しない（種類は受けるが、状態の表に無いので RESEND_NOT_ALLOWED）。
--    取消のお知らせは、注文が取消の間だけ再送でき、最後に送った取消の行のうち、返金が失敗・エラーでない行
--    （返金の番号が空の行を含む）の書き分けと返金の番号を写す。写せる行が無ければ RESEND_NOT_ALLOWED
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
  IF _kind NOT IN ('paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped', 'refund') THEN
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

-- 6. 管理画面の履歴（グループ D 設計書 5-1）。最後の列に返金の番号を足す（E-2 設計書 9-2）。本文は返さない。
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
  fulfillment_number integer,
  refund_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.kind, e.variant, e.origin, u.email::text, e.status, e.attempts, e.last_error_code,
         e.delivery_status, e.delivery_event_at, e.created_at, e.sent_at, e.finished_at,
         e.body_text IS NOT NULL, e.body_erased_at IS NOT NULL,
         e.fulfillment_id, f.number, e.refund_id
  FROM private.order_email_outbox AS e
  LEFT JOIN auth.users AS u ON u.id = e.requested_by
  LEFT JOIN public.order_fulfillments AS f ON f.id = e.fulfillment_id
  WHERE e.order_id = _order_id
  ORDER BY e.seq DESC
$$;

-- 7. Stripe の値の形の確かめ。結果を書く関数と、外からの返金を記録する関数が同じ確かめを使う。
--    返金の番号の形は表の CHECK と同じ ^[a-z]{2,4}_[A-Za-z0-9]+$（本計画 P29。re_ 以外の接頭辞も受ける）
CREATE OR REPLACE FUNCTION private.refund_stripe_fields_valid(
  _stripe_refund_id text,
  _stripe_status text,
  _stripe_pending_reason text,
  _stripe_failure_reason text,
  _payment_method_type text,
  _reference_number text,
  _reference_type text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    _stripe_refund_id ~ '^[a-z]{2,4}_[A-Za-z0-9]+$'
    AND _stripe_status IN ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')
    AND (_stripe_pending_reason IS NULL OR _stripe_pending_reason IN ('processing', 'insufficient_funds', 'charge_pending'))
    AND (_stripe_failure_reason IS NULL OR _stripe_failure_reason ~ '^[a-z0-9_]{1,64}$')
    AND (_payment_method_type IS NULL OR _payment_method_type ~ '^[a-z0-9_]{1,32}$')
    AND (_reference_number IS NULL OR pg_catalog.char_length(_reference_number) BETWEEN 1 AND 64)
    AND (_reference_type IS NULL OR _reference_type ~ '^[a-z0-9_]{1,32}$'),
    false
  )
$$;

-- 8. 注文が返金で取消になったか（本計画 P5）。最後に cancelled になった時の改訂の理由で見分ける。
--    未入金で取り消した注文（自動の返金①の注文を含む）は、返金が失敗しても支払い済みに戻さない
CREATE OR REPLACE FUNCTION private.order_cancelled_by_refund(_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT r.reason IN ('refund_projection', 'stripe_refund_projection')
    FROM public.order_revisions AS r
    WHERE r.order_id = _order_id
      AND 'status' = ANY (r.changed_fields)
      AND r.after_data ->> 'status' = 'cancelled'
    ORDER BY r.changed_at DESC, r.id DESC
    LIMIT 1
  ), false)
$$;

-- 9. 返金の記録の状態が決まった後に、在庫・メールの予定・要対応・注文の額と状態を書く（設計書 4-7・6-3・7・8）。
--    結果を書く関数と、外からの返金を記録する関数が使う。返事待ちをエラーにする関数も、エラーにした後に呼ぶ
--    （エラーの記録では在庫・メールの予定・失敗の後始末は動かず、注文の状態だけが動く）。
--    呼ぶ側が先に注文の行と返金の行の鍵を取る（鍵の順は 注文 → 返金 → 色・サイズの番号の昇順）。何度呼んでも、書くのは足りない分だけ
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

-- 10. 返金の結果を書く（設計書 3-2・4-1・6-3）。Stripe の返金の値で記録の状態を進め、在庫・メールの予定・要対応・
--     注文の額と状態を1回の取引で書く。同じ値を何度書いても、書くのは足りない分だけ。
--     許さない移り方の知らせ（成功の後の保留など）は、誤りにせず、何も書かずに今の値を返す（P22）
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

  -- 鍵は注文 → 返金の順（返金を始める関数・発送の関数と同じ）
  PERFORM 1 FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE;
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

  RETURN QUERY
  SELECT _refund_id,
         v_order_id,
         v_next,
         v_applied.newly_accepted,
         v_applied.newly_failed,
         v_applied.order_status,
         v_applied.refunded_amount,
         v_applied.rereserve_shortage,
         v_applied.email_enqueued,
         v_applied.exception_id;
END;
$$;

-- 11. 印の無い返金（Stripe の画面からの返金・前からの写し）を記録する（設計書 6-1。同じ Stripe の返金の番号で何度呼んでも1行）。
--     切り替えの時刻より前に Stripe で作られた返金は写し（legacy）にして、在庫もメールも動かさない（P8）。
--     全額になる時は、残りの未発送を全部発送前の行に入れて、結果を書く関数に渡す（設計書 7-4）。返せる額の上限は確かめない（お金はもう動いた）
CREATE OR REPLACE FUNCTION public.record_external_order_refund(
  _order_id uuid,
  _stripe_refund_id text,
  _amount integer,
  _stripe_status text,
  _stripe_pending_reason text,
  _stripe_failure_reason text,
  _customer_action_expires_at timestamptz,
  _payment_method_type text,
  _reference_number text,
  _reference_type text,
  _stripe_reason text,
  _stripe_created_at timestamptz
)
RETURNS TABLE (
  refund_id uuid,
  created boolean,
  source text,
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
  v_order public.orders%ROWTYPE;
  v_existing public.order_refunds%ROWTYPE;
  v_refund_id uuid;
  v_created boolean := false;
  v_source text;
  v_started timestamptz;
  v_open integer := 0;
  v_open_shipping integer := 0;
  v_lines jsonb := '[]'::jsonb;
  v_lines_amount integer := 0;
  v_shipping integer := 0;
  v_applied record;
BEGIN
  IF _order_id IS NULL
     OR _amount IS NULL
     OR _amount < 1
     OR _stripe_created_at IS NULL
     OR NOT private.refund_stripe_fields_valid(
       _stripe_refund_id, _stripe_status, _stripe_pending_reason, _stripe_failure_reason,
       _payment_method_type, _reference_number, _reference_type
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT r.* INTO v_existing FROM public.order_refunds AS r WHERE r.stripe_refund_id = _stripe_refund_id;
  IF FOUND THEN
    -- 同じ Stripe の返金は、ほかの注文の記録にならない
    IF v_existing.order_id <> _order_id THEN
      RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_refund_id := v_existing.id;
    v_source := v_existing.source;
  ELSE
    SELECT s.started_at INTO v_started FROM private.refund_ledger_state AS s WHERE s.id = 1;
    v_source := CASE WHEN _stripe_created_at < v_started THEN 'legacy' ELSE 'stripe_dashboard' END;

    -- 返事待ち・保留・成功の合計にこの額を足すと全額に届く時は、残りの未発送を全部発送前の行にする。
    -- 失敗・取消の返金は、お金が動かないので行を入れない。全額になる時の送料は、返せる送料の全部（その返金の額まで）
    IF v_source = 'stripe_dashboard'
       AND _stripe_status IN ('pending', 'requires_action', 'succeeded')
       AND v_order.status IN ('paid', 'shipped') THEN
      SELECT COALESCE(pg_catalog.sum(r.amount), 0)::integer, COALESCE(pg_catalog.sum(r.shipping_amount), 0)::integer
      INTO v_open, v_open_shipping
      FROM public.order_refunds AS r
      WHERE r.order_id = _order_id
        AND r.status IN ('awaiting_response', 'pending', 'succeeded');

      IF v_open + _amount >= COALESCE(NULLIF(v_order.paid_amount, 0), v_order.total_amount) THEN
        -- 今回の k 個の額 = 単価 × k − (disc(b + k) − disc(b))。b は前に返した数（返事待ち・保留・成功の発送前と発送後）
        SELECT COALESCE(pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'order_item_id', x.order_item_id,
                   'quantity', x.unshipped,
                   'restock_type', x.restock_type,
                   'amount', x.line_amount
                 ) ORDER BY x.created_at, x.order_item_id
               ), '[]'::jsonb)
        INTO v_lines
        FROM (
          SELECT l.order_item_id,
                 l.unshipped,
                 CASE WHEN l.fulfillment_type = 'stock' THEN 'cancel' ELSE 'no_restock' END AS restock_type,
                 oi.item_price * l.unshipped
                   - (private.refund_units_discount(
                        COALESCE(d.line_discount, 0), oi.quantity,
                        l.refunded_before_shipment + l.refunded_after_shipment + l.unshipped
                      )
                      - private.refund_units_discount(
                        COALESCE(d.line_discount, 0), oi.quantity,
                        l.refunded_before_shipment + l.refunded_after_shipment
                      )) AS line_amount,
                 oi.created_at
          FROM private.order_line_fulfillment(_order_id) AS l
          JOIN public.order_items AS oi ON oi.id = l.order_item_id
          LEFT JOIN private.order_line_discounts(_order_id) AS d ON d.order_item_id = l.order_item_id
          WHERE l.unshipped > 0
        ) AS x;

        -- 送料は返せる送料の全部（C-1）。行の有無（全部を発送した注文は行が無い）に依らない。
        -- ただし、その返金の額を超えない（「うち送料」が返金額を超えないように。移行 B のイ・オと同じ）
        v_shipping := LEAST(GREATEST(v_order.shipping_amount - v_open_shipping, 0), _amount);
      END IF;
    END IF;

    SELECT COALESCE(pg_catalog.sum((e.value ->> 'amount')::integer), 0)::integer
    INTO v_lines_amount
    FROM pg_catalog.jsonb_array_elements(v_lines) AS e(value);

    -- 記録の作った時刻は Stripe の返金の作った時刻。Stripe の理由は、こちらが持つ3つ以外を空にする
    INSERT INTO public.order_refunds
      (order_id, source, stripe_refund_id, status, amount, shipping_amount, adjustment_amount,
       stripe_reason, notify_customer, created_at)
    VALUES
      (_order_id, v_source, _stripe_refund_id, 'awaiting_response', _amount, v_shipping,
       _amount - v_lines_amount - v_shipping,
       CASE WHEN _stripe_reason IN ('requested_by_customer', 'duplicate', 'fraudulent') THEN _stripe_reason END,
       v_source <> 'legacy', _stripe_created_at)
    RETURNING id INTO v_refund_id;

    INSERT INTO public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
    SELECT v_refund_id,
           (e.value ->> 'order_item_id')::uuid,
           (e.value ->> 'quantity')::integer,
           true,
           e.value ->> 'restock_type',
           (e.value ->> 'amount')::integer
    FROM pg_catalog.jsonb_array_elements(v_lines) AS e(value);

    v_created := true;
  END IF;

  SELECT x.* INTO v_applied
  FROM public.record_order_refund_result(
    v_refund_id, _stripe_refund_id, _stripe_status, _stripe_pending_reason, _stripe_failure_reason,
    _customer_action_expires_at, _payment_method_type, _reference_number, _reference_type
  ) AS x;

  RETURN QUERY
  SELECT v_refund_id,
         v_created,
         v_source,
         v_applied.status,
         v_applied.newly_accepted,
         v_applied.newly_failed,
         v_applied.order_status,
         v_applied.refunded_amount,
         v_applied.rereserve_shortage,
         v_applied.email_enqueued,
         v_applied.exception_id;
END;
$$;

-- 12. 返事待ちだけをエラーにする（Stripe の断り・見回りが Stripe に見つけられなかった時）。エラーの記録は数えない。
--     要対応を作る時は、その番号を返す（理由は detail に、支払いの印 payment_ref は記録の番号にする。P23）。
--     エラーの記録は発送前の行を数えなくなり、未発送が戻るので、注文の状態も合わせる
CREATE OR REPLACE FUNCTION public.mark_order_refund_error(_refund_id uuid, _reason text, _raise_exception boolean)
RETURNS TABLE (outcome text, order_id uuid, exception_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order_id uuid;
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

  SELECT r.order_id INTO v_order_id FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 鍵は注文 → 返金の順。要対応の行が注文を指すので、注文の鍵を先に取らないと、結果を書く関数と鍵を待ち合う
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE;
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

  -- エラーにした返金の発送前の行は数えなくなり、未発送が戻る。返事待ちの品は送れないので、残りの発送や別の返金の結果で
  -- 発送済みになっていれば、支払い済みに戻す（Global Constraints の「shipped で未発送が戻ったら paid」）。
  -- エラーの記録では、在庫・メールの予定・失敗の後始末は動かず、注文の状態だけが動く
  PERFORM 1 FROM private.apply_order_refund_state(_refund_id);

  RETURN QUERY SELECT 'errored'::text, v_order_id, v_exception;
END;
$$;

-- 13. 注文の一覧の1ページ分の返金の要約（設計書 9-1）。渡した注文ごとに1行（存在しない注文の行は返さない）
CREATE OR REPLACE FUNCTION public.list_order_refund_summaries(_order_ids uuid[])
RETURNS TABLE (
  order_id uuid,
  paid_amount integer,
  succeeded_amount integer,
  open_amount integer,
  refundable_amount integer,
  has_open_refund boolean,
  has_unresolved_refund_failure boolean
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
  SELECT o.id,
         a.paid_amount,
         COALESCE(a.succeeded_amount, 0),
         COALESCE(a.open_amount, 0),
         COALESCE(a.refundable_amount, 0),
         EXISTS (
           SELECT 1
           FROM public.order_refunds AS r
           WHERE r.order_id = o.id
             AND r.status IN ('awaiting_response', 'pending')
         ),
         EXISTS (
           SELECT 1
           FROM public.payment_exceptions AS e
           WHERE e.order_id = o.id
             AND e.reason = 'refund_failed'
             AND e.resolved_at IS NULL
         )
  FROM public.orders AS o
  LEFT JOIN LATERAL private.order_refund_amounts(o.id) AS a ON true
  WHERE o.id = ANY (_order_ids)
  ORDER BY o.id;
END;
$$;

-- 14. 自動の返金①②の後に、要対応を「システムが自動で返金した／解決した」と記録して閉じる（設計書 6-4）。解決した人は空
CREATE OR REPLACE FUNCTION public.resolve_payment_exception_by_system(_exception_id uuid, _note text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _exception_id IS NULL THEN
    RAISE EXCEPTION 'RESOLVE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'RESOLUTION_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payment_exceptions AS e
  SET resolved_at = pg_catalog.now(),
      resolved_by = NULL,
      resolution_note = NULLIF(pg_catalog.btrim(_note), '')
  WHERE e.id = _exception_id
    AND e.resolved_at IS NULL;

  RETURN FOUND;
END;
$$;

-- 15. 前の返金の関数（注文の額と状態だけを書いた）を消す。使う TS は Task 5・6・9 で置き換える（本計画 P18）
DROP FUNCTION IF EXISTS public.apply_order_refund_projection(
  uuid, public.order_status, integer, timestamptz, integer, timestamptz, timestamptz, uuid
);

-- 16. 権限。private の関数は PUBLIC から外すだけ
REVOKE ALL ON FUNCTION private.enqueue_order_email(uuid, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refund_stripe_fields_valid(text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_cancelled_by_refund(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.apply_order_refund_state(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.claim_order_email(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_order_email_resend(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_email_history(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_order_refund_result(uuid, text, text, text, text, timestamptz, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_external_order_refund(
  uuid, text, integer, text, text, text, timestamptz, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_refund_error(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_refund_summaries(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_payment_exception_by_system(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_order_email(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_order_email_resend(uuid, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_email_history(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_order_refund_result(uuid, text, text, text, text, timestamptz, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_external_order_refund(
  uuid, text, integer, text, text, text, timestamptz, text, text, text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_refund_error(uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_refund_summaries(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment_exception_by_system(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
