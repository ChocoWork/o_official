-- 注文のメールを確実に送る（グループ D 設計書 2026-10-09 の 3・4・6・7 章。R-34・R-14）
--
-- 注文の状態を変える DB の関数が同じ取引で1行書く「注文のメール」の表と、worker・管理画面・配達の知らせが使う関数。
-- 表は private に置き、読み書きは public の SECURITY DEFINER の関数だけにする（実行は service_role だけ）。
-- 失敗した試行の回数 n に対し、次の試行は 2^(n-1) 分後（1・2・4…128分）に前後2割の揺らぎを足す。
-- 最初の試行と合わせて9回試し、9回目も失敗したら dead（送れなかった）にする（グループ B のキューと同じ表）。
-- 同じ注文のメールは、足した順の番号（seq）の順に送る。
BEGIN;

-- 1. 注文のメール。自動の行は1注文1種類1行、手の再送は送信待ちの間1行（設計書 3-2・7-1）
CREATE TABLE IF NOT EXISTS private.order_email_outbox (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  order_id uuid NOT NULL REFERENCES public.orders (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped')),
  variant text,
  origin text NOT NULL CHECK (origin IN ('auto', 'manual')),
  requested_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'retry_wait', 'sent', 'skipped', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  subject text CHECK (subject IS NULL OR pg_catalog.char_length(subject) BETWEEN 1 AND 300),
  body_text text CHECK (body_text IS NULL OR pg_catalog.char_length(body_text) BETWEEN 1 AND 20000),
  provider_message_id text
    CHECK (provider_message_id IS NULL OR pg_catalog.char_length(provider_message_id) BETWEEN 1 AND 200),
  delivery_status text CHECK (
    delivery_status IS NULL
    OR delivery_status IN ('delivered', 'delayed', 'bounced', 'complained', 'suppressed', 'failed')
  ),
  delivery_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  sent_at timestamptz,
  finished_at timestamptz,
  body_erased_at timestamptz,
  dead_notified_at timestamptz,
  delivery_alert_notified_at timestamptz,
  CONSTRAINT order_email_outbox_seq_key UNIQUE (seq),
  -- CHECK は NULL を通すので、書き分けが要る種類は IS NOT NULL も確かめる
  CONSTRAINT order_email_outbox_variant_check CHECK (
    (kind = 'paid' AND variant IS NOT NULL
      AND variant IN ('order_confirmed', 'payment_received', 'payment_received_after_expiry'))
    OR (kind = 'canceled' AND variant IS NOT NULL AND variant IN ('payment_in_progress', 'pending'))
    OR (kind IN ('awaiting_payment', 'payment_expired', 'shipped') AND variant IS NULL)
  ),
  CONSTRAINT order_email_outbox_requester_check CHECK (origin = 'manual' OR requested_by IS NULL),
  CONSTRAINT order_email_outbox_lease_check CHECK (
    (status = 'sending') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT order_email_outbox_body_pair_check CHECK ((subject IS NULL) = (body_text IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS order_email_outbox_auto_once_idx
  ON private.order_email_outbox (order_id, kind)
  WHERE origin = 'auto';

CREATE UNIQUE INDEX IF NOT EXISTS order_email_outbox_manual_open_idx
  ON private.order_email_outbox (order_id, kind)
  WHERE origin = 'manual' AND status IN ('pending', 'sending', 'retry_wait');

CREATE UNIQUE INDEX IF NOT EXISTS order_email_outbox_provider_message_idx
  ON private.order_email_outbox (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- 取り出し（送信待ち・やり直し待ち・期限の切れた担当）
CREATE INDEX IF NOT EXISTS order_email_outbox_due_idx
  ON private.order_email_outbox (next_attempt_at)
  WHERE status IN ('pending', 'sending', 'retry_wait');

-- 同じ注文の順番と管理画面の履歴
CREATE INDEX IF NOT EXISTS order_email_outbox_order_idx
  ON private.order_email_outbox (order_id, seq);

CREATE INDEX IF NOT EXISTS order_email_outbox_dead_unnotified_idx
  ON private.order_email_outbox (finished_at)
  WHERE status = 'dead' AND dead_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS order_email_outbox_delivery_problem_idx
  ON private.order_email_outbox (delivery_event_at)
  WHERE delivery_status IN ('bounced', 'complained', 'suppressed', 'failed') AND delivery_alert_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS order_email_outbox_delivery_check_idx
  ON private.order_email_outbox (sent_at)
  WHERE status = 'sent' AND provider_message_id IS NOT NULL
    AND (delivery_status IS NULL OR delivery_status = 'delayed');

-- 2. 送信の一時停止（1行だけ。設計書 4-5）
CREATE TABLE IF NOT EXISTS private.order_email_send_pause (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused boolean NOT NULL DEFAULT false,
  reason text CHECK (
    reason IS NULL
    OR reason IN ('config_api_key', 'config_sender_domain', 'config_provider', 'quota_daily', 'quota_monthly')
  ),
  paused_at timestamptz,
  next_probe_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_email_send_pause_state_check CHECK (
    (paused AND reason IS NOT NULL AND paused_at IS NOT NULL AND next_probe_at IS NOT NULL)
    OR (NOT paused AND reason IS NULL AND paused_at IS NULL AND next_probe_at IS NULL)
  )
);

INSERT INTO private.order_email_send_pause (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- 3. Resend の知らせの受付済みの番号（設計書 6-2。Svix の送り直しは約28時間なので3日持つ）
CREATE TABLE IF NOT EXISTS private.resend_webhook_receipts (
  svix_id text PRIMARY KEY CHECK (pg_catalog.char_length(svix_id) BETWEEN 1 AND 200),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS resend_webhook_receipts_received_idx
  ON private.resend_webhook_receipts (received_at);

-- private は Data API から見えないが、念のため RLS を有効にして方針を置かず、表の権限も外す（関数だけで触る）
ALTER TABLE private.order_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.order_email_send_pause ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.resend_webhook_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.order_email_outbox FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.order_email_send_pause FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.resend_webhook_receipts FROM PUBLIC, anon, authenticated, service_role;

-- 4. 回数と待つ時間（設計書 4-3）
CREATE OR REPLACE FUNCTION private.order_email_max_attempts()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 9
$$;

-- 失敗した試行が _failed_attempts 回の後に待つ時間（1・2・4…128分）。前後2割の揺らぎを足す
CREATE OR REPLACE FUNCTION private.order_email_retry_delay(_failed_attempts integer)
RETURNS interval
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT pg_catalog.make_interval(
    secs => 60 * (2 ^ LEAST(GREATEST(COALESCE(_failed_attempts, 1) - 1, 0), 7)) * (0.8 + 0.4 * pg_catalog.random())
  )
$$;

-- 5. 行を書く（設計書 3-1）。状態を変える関数が同じ取引で呼ぶ。自動の行は1注文1種類1行なので、2回目は何もしない
CREATE OR REPLACE FUNCTION private.enqueue_order_email(_order_id uuid, _kind text, _variant text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO private.order_email_outbox (order_id, kind, variant, origin)
  VALUES (_order_id, _kind, _variant, 'auto')
  ON CONFLICT (order_id, kind) WHERE origin = 'auto' DO NOTHING;
  RETURN FOUND;
END;
$$;

-- 6. 送信全体を止める（設計書 4-5）。止めた時刻は最初に止めた時のまま、次に1件試す時刻を決め直す
CREATE OR REPLACE FUNCTION private.set_order_email_pause(_reason text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_was_paused boolean;
BEGIN
  IF _reason IS NULL
     OR _reason NOT IN ('config_api_key', 'config_sender_domain', 'config_provider', 'quota_daily', 'quota_monthly') THEN
    RAISE EXCEPTION 'INVALID_PAUSE_REASON' USING ERRCODE = '22023';
  END IF;

  SELECT p.paused INTO v_was_paused FROM private.order_email_send_pause AS p WHERE p.id FOR UPDATE;

  UPDATE private.order_email_send_pause AS p
  SET paused = true,
      reason = _reason,
      paused_at = CASE WHEN p.paused THEN p.paused_at ELSE pg_catalog.now() END,
      -- 1日の上限は UTC 0時（日本時間 9時）に戻る。それまで試さない
      next_probe_at = CASE
        WHEN _reason = 'quota_daily'
          THEN (pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
        ELSE pg_catalog.now() + interval '15 minutes'
      END,
      updated_at = pg_catalog.now()
  WHERE p.id;

  RETURN NOT COALESCE(v_was_paused, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.pause_order_email_sending(_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN private.set_order_email_pause(_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_order_email_send_state()
RETURNS TABLE (paused boolean, reason text, paused_at timestamptz, next_probe_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.paused, p.reason, p.paused_at, p.next_probe_at
  FROM private.order_email_send_pause AS p
  WHERE p.id
$$;

-- 7. 送る行を1つ取り出す（設計書 4-1・4-3・4-5）
--   1) 担当の期限が切れた試行は1回の失敗として数える（9回目なら送れなかった）。控えた中身は残す（同じ鍵で送り直す）
--   2) 止めている間は次に試す時刻まで何も返さない。時刻を過ぎていたら1件だけ返し、次に試す時刻を先へ進める
--   3) 同じ注文の前の行が片付くまで、後の行は取り出さない
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
  payment_expired_sent boolean
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
    RETURNING e.id, e.order_id, e.kind, e.variant, e.origin, e.attempts, e.lease_token, e.subject, e.body_text
  )
  SELECT c.id, c.order_id, c.kind, c.variant, c.origin, c.attempts, c.lease_token, c.subject, c.body_text,
         EXISTS (
           SELECT 1
           FROM private.order_email_outbox AS x
           WHERE x.order_id = c.order_id
             AND x.kind = 'payment_expired'
             AND x.status = 'sent'
         )
  FROM claimed AS c;
END;
$$;

-- 8. 最初に送る前に中身を控える（設計書 4-2）。控えは一度だけ
CREATE OR REPLACE FUNCTION public.save_order_email_content(
  _email_id uuid,
  _lease_token uuid,
  _subject text,
  _body_text text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _subject IS NULL OR _body_text IS NULL THEN
    RAISE EXCEPTION 'CONTENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  UPDATE private.order_email_outbox AS e
  SET subject = _subject,
      body_text = _body_text
  WHERE e.id = _email_id
    AND e.status = 'sending'
    AND e.lease_token = _lease_token
    AND e.subject IS NULL;
  RETURN FOUND;
END;
$$;

-- 9. 送信済みにする。送れたので、止めていた送信を同じ取引で再開する（設計書 4-5。half-open から closed）
CREATE OR REPLACE FUNCTION public.complete_order_email(
  _email_id uuid,
  _lease_token uuid,
  _provider_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE private.order_email_outbox AS e
  SET status = 'sent',
      sent_at = pg_catalog.now(),
      finished_at = pg_catalog.now(),
      provider_message_id = NULLIF(pg_catalog.btrim(_provider_message_id), ''),
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = NULL
  WHERE e.id = _email_id
    AND e.status = 'sending'
    AND e.lease_token = _lease_token;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE private.order_email_send_pause AS p
  SET paused = false,
      reason = NULL,
      paused_at = NULL,
      next_probe_at = NULL,
      updated_at = pg_catalog.now()
  WHERE p.id
    AND p.paused;

  RETURN true;
END;
$$;

-- 10. 失敗を記録する（設計書 4-3・4-4）。結果の状態を返し、担当の印が合わなければ NULL
--   transient: やり直し待ち（9回目の失敗なら送れなかった）。待つ時間の指示が長ければそちら（最大1日）
--   permanent: すぐ送れなかった
--   config: このメールの失敗として数えず、すぐ取り出せる状態に戻して送信全体を止める
CREATE OR REPLACE FUNCTION public.fail_order_email(
  _email_id uuid,
  _lease_token uuid,
  _error_code text,
  _category text,
  _retry_after_seconds integer DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF _category IS NULL OR _category NOT IN ('transient', 'permanent', 'config') THEN
    RAISE EXCEPTION 'INVALID_FAILURE_CATEGORY' USING ERRCODE = '22023';
  END IF;
  IF _error_code IS NULL OR _error_code !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_ERROR_CODE' USING ERRCODE = '22023';
  END IF;

  IF _category = 'config' THEN
    UPDATE private.order_email_outbox AS e
    SET status = 'retry_wait',
        attempts = GREATEST(e.attempts - 1, 0),
        next_attempt_at = pg_catalog.now(),
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = _error_code
    WHERE e.id = _email_id
      AND e.status = 'sending'
      AND e.lease_token = _lease_token
    RETURNING e.status INTO v_status;

    IF v_status IS NOT NULL THEN
      PERFORM private.set_order_email_pause(_error_code);
    END IF;
    RETURN v_status;
  END IF;

  UPDATE private.order_email_outbox AS e
  SET status = CASE
        WHEN _category = 'permanent' OR e.attempts >= private.order_email_max_attempts() THEN 'dead'
        ELSE 'retry_wait'
      END,
      finished_at = CASE
        WHEN _category = 'permanent' OR e.attempts >= private.order_email_max_attempts() THEN pg_catalog.now()
      END,
      subject = CASE
        WHEN _category = 'permanent' OR e.attempts >= private.order_email_max_attempts() THEN NULL
        ELSE e.subject
      END,
      body_text = CASE
        WHEN _category = 'permanent' OR e.attempts >= private.order_email_max_attempts() THEN NULL
        ELSE e.body_text
      END,
      body_erased_at = CASE
        WHEN (_category = 'permanent' OR e.attempts >= private.order_email_max_attempts()) AND e.subject IS NOT NULL
          THEN pg_catalog.now()
        ELSE e.body_erased_at
      END,
      next_attempt_at = pg_catalog.now() + GREATEST(
        private.order_email_retry_delay(e.attempts),
        pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(_retry_after_seconds, 0), 0), 86400))
      ),
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = _error_code
  WHERE e.id = _email_id
    AND e.status = 'sending'
    AND e.lease_token = _lease_token
  RETURNING e.status INTO v_status;

  RETURN v_status;
END;
$$;

-- 11. 取りやめ（設計書 4-1）。理由を残し、控えた本文を消す
CREATE OR REPLACE FUNCTION public.skip_order_email(_email_id uuid, _lease_token uuid, _reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _reason IS NULL OR _reason NOT IN ('superseded', 'no_recipient') THEN
    RAISE EXCEPTION 'INVALID_SKIP_REASON' USING ERRCODE = '22023';
  END IF;

  -- 取りやめ（superseded）は入金待ちと支払い期限切れだけ（設計書 4-1）。入金済み・取消・発送はその時の事実を伝えるので取りやめない
  IF _reason = 'superseded' AND EXISTS (
    SELECT 1
    FROM private.order_email_outbox AS e
    WHERE e.id = _email_id
      AND e.kind NOT IN ('awaiting_payment', 'payment_expired')
  ) THEN
    RAISE EXCEPTION 'SUPERSEDE_NOT_ALLOWED' USING ERRCODE = '22023';
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

-- 12. 管理画面の再送（設計書 5-3）。今の注文の状態で意味のある種類で、送信済みか送れなかった行があるときだけ。
--     書き分けはその種類の最後の行から写す。同じ種類の手の再送が送信待ちなら断る
CREATE OR REPLACE FUNCTION public.request_order_email_resend(_order_id uuid, _kind text, _actor_id uuid)
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

  SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    (_kind = 'paid' AND v_status IN ('paid', 'shipped'))
    OR (_kind = 'awaiting_payment' AND v_status = 'pending')
    OR (_kind = 'payment_expired' AND v_status = 'failed')
    OR (_kind = 'canceled' AND v_status = 'cancelled')
    OR (_kind = 'shipped' AND v_status = 'shipped')
  ) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  SELECT e.variant, true INTO v_variant, v_found
  FROM private.order_email_outbox AS e
  WHERE e.order_id = _order_id
    AND e.kind = _kind
    AND e.status IN ('sent', 'dead')
  ORDER BY e.seq DESC
  LIMIT 1;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'RESEND_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, requested_by)
    VALUES (_order_id, _kind, v_variant, 'manual', _actor_id)
    RETURNING id INTO v_email_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'RESEND_ALREADY_QUEUED' USING ERRCODE = '23505';
  END;

  RETURN v_email_id;
END;
$$;

-- 13. 管理画面の履歴（設計書 5-1）。本文は返さない
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
  body_erased boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.kind, e.variant, e.origin, u.email::text, e.status, e.attempts, e.last_error_code,
         e.delivery_status, e.delivery_event_at, e.created_at, e.sent_at, e.finished_at,
         e.body_text IS NOT NULL, e.body_erased_at IS NOT NULL
  FROM private.order_email_outbox AS e
  LEFT JOIN auth.users AS u ON u.id = e.requested_by
  WHERE e.order_id = _order_id
  ORDER BY e.seq DESC
$$;

-- 注文の状態の変化（order_revisions から）。前後の値はそのまま返さず、決めた項目だけ取り出す（住所などを出さない）
-- 返金の同期で状態が変わった行は operation が refund_update になるので、operation ではなく変わった列で見る
CREATE OR REPLACE FUNCTION public.list_order_status_history(_order_id uuid)
RETURNS TABLE (
  changed_at timestamptz,
  from_status text,
  to_status text,
  change_reason text,
  actor_email text,
  shipping_carrier text,
  tracking_number text,
  cancel_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.changed_at,
         r.before_data ->> 'status',
         r.after_data ->> 'status',
         r.reason,
         u.email::text,
         CASE WHEN r.after_data ->> 'status' = 'shipped' THEN r.after_data ->> 'shipping_carrier' END,
         CASE WHEN r.after_data ->> 'status' = 'shipped' THEN r.after_data ->> 'tracking_number' END,
         CASE WHEN r.after_data ->> 'status' = 'cancelled' THEN r.after_data ->> 'cancel_reason' END
  FROM public.order_revisions AS r
  LEFT JOIN auth.users AS u ON u.id = r.changed_by
  WHERE r.order_id = _order_id
    AND 'status' = ANY (r.changed_fields)
  ORDER BY r.changed_at DESC, r.id DESC
$$;

-- 14. 送ったメールの中身（設計書 5-2）。送信済みの行だけ
CREATE OR REPLACE FUNCTION public.get_order_email_content(_order_id uuid, _email_id uuid)
RETURNS TABLE (subject text, body_text text, sent_at timestamptz, body_erased boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.subject, e.body_text, e.sent_at, e.body_erased_at IS NOT NULL
  FROM private.order_email_outbox AS e
  WHERE e.id = _email_id
    AND e.order_id = _order_id
    AND e.status = 'sent'
$$;

-- 15. 配達の状態（設計書 6-2〜6-4）。受け口は知らせの番号つき、見回りは番号なしで呼ぶ。
--     同じ知らせは1回だけ、記録より新しい知らせだけ書き換える。届かなかった知らせは店へ知らせ直す
CREATE OR REPLACE FUNCTION public.record_order_email_delivery(
  _svix_id text,
  _provider_message_id text,
  _delivery_status text,
  _event_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated uuid;
BEGIN
  IF _provider_message_id IS NULL
     OR pg_catalog.char_length(_provider_message_id) NOT BETWEEN 1 AND 200
     OR _event_at IS NULL
     OR _delivery_status IS NULL
     OR _delivery_status NOT IN ('delivered', 'delayed', 'bounced', 'complained', 'suppressed', 'failed') THEN
    RAISE EXCEPTION 'INVALID_DELIVERY_EVENT' USING ERRCODE = '22023';
  END IF;

  IF _svix_id IS NOT NULL THEN
    INSERT INTO private.resend_webhook_receipts (svix_id) VALUES (_svix_id)
    ON CONFLICT (svix_id) DO NOTHING;
    IF NOT FOUND THEN
      RETURN 'duplicate';
    END IF;
  END IF;

  UPDATE private.order_email_outbox AS e
  SET delivery_status = _delivery_status,
      delivery_event_at = _event_at,
      delivery_alert_notified_at = CASE
        WHEN _delivery_status IN ('bounced', 'complained', 'suppressed', 'failed') THEN NULL
        ELSE e.delivery_alert_notified_at
      END
  WHERE e.provider_message_id = _provider_message_id
    AND (e.delivery_event_at IS NULL OR e.delivery_event_at < _event_at)
  RETURNING e.id INTO v_updated;

  IF v_updated IS NOT NULL THEN
    RETURN 'updated';
  END IF;
  IF EXISTS (SELECT 1 FROM private.order_email_outbox AS e WHERE e.provider_message_id = _provider_message_id) THEN
    RETURN 'stale';
  END IF;
  RETURN 'unknown_email';
END;
$$;

-- 1時間ごとの見回りの対象（設計書 6-4）。送ってから3日以内で、配達の状態が無いか遅れのメール
CREATE OR REPLACE FUNCTION public.list_order_emails_awaiting_delivery(_limit integer)
RETURNS TABLE (email_id uuid, provider_message_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.provider_message_id
  FROM private.order_email_outbox AS e
  WHERE e.status = 'sent'
    AND e.provider_message_id IS NOT NULL
    AND (e.delivery_status IS NULL OR e.delivery_status = 'delayed')
    AND e.sent_at > pg_catalog.now() - interval '3 days'
  ORDER BY e.sent_at, e.seq
  LIMIT LEAST(GREATEST(COALESCE(_limit, 0), 0), 100)
$$;

-- 16. 点検（設計書 4-6・4-8）。中身は返さず、原因の記号だけ返す
CREATE OR REPLACE FUNCTION public.get_order_email_backlog(_older_than_seconds integer)
RETURNS TABLE (status text, email_count integer, oldest_created_at timestamptz, last_errors text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.status,
         pg_catalog.count(*)::integer,
         pg_catalog.min(e.created_at),
         pg_catalog.array_remove(pg_catalog.array_agg(DISTINCT e.last_error_code), NULL)
  FROM private.order_email_outbox AS e
  WHERE e.status IN ('pending', 'sending', 'retry_wait')
    AND e.created_at <= pg_catalog.now() - pg_catalog.make_interval(secs => _older_than_seconds)
  GROUP BY e.status
  ORDER BY e.status
$$;

CREATE OR REPLACE FUNCTION public.list_unnotified_dead_order_emails(_limit integer)
RETURNS TABLE (
  email_id uuid,
  order_id uuid,
  kind text,
  last_error_code text,
  attempts integer,
  finished_at timestamptz,
  total_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.order_id, e.kind, e.last_error_code, e.attempts, e.finished_at,
         (pg_catalog.count(*) OVER ())::integer
  FROM private.order_email_outbox AS e
  WHERE e.status = 'dead'
    AND e.dead_notified_at IS NULL
  ORDER BY e.finished_at, e.seq
  LIMIT LEAST(GREATEST(COALESCE(_limit, 0), 0), 100)
$$;

CREATE OR REPLACE FUNCTION public.mark_order_emails_dead_notified(_email_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE private.order_email_outbox AS e
  SET dead_notified_at = pg_catalog.now()
  WHERE e.id = ANY(_email_ids)
    AND e.status = 'dead'
    AND e.dead_notified_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_unnotified_order_email_delivery_problems(_limit integer)
RETURNS TABLE (
  email_id uuid,
  order_id uuid,
  kind text,
  delivery_status text,
  delivery_event_at timestamptz,
  total_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.order_id, e.kind, e.delivery_status, e.delivery_event_at,
         (pg_catalog.count(*) OVER ())::integer
  FROM private.order_email_outbox AS e
  WHERE e.delivery_status IN ('bounced', 'complained', 'suppressed', 'failed')
    AND e.delivery_alert_notified_at IS NULL
  ORDER BY e.delivery_event_at, e.seq
  LIMIT LEAST(GREATEST(COALESCE(_limit, 0), 0), 100)
$$;

CREATE OR REPLACE FUNCTION public.mark_order_email_delivery_problems_notified(_email_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE private.order_email_outbox AS e
  SET delivery_alert_notified_at = pg_catalog.now()
  WHERE e.id = ANY(_email_ids)
    AND e.delivery_status IN ('bounced', 'complained', 'suppressed', 'failed')
    AND e.delivery_alert_notified_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 17. 毎日の片付け（設計書 7-5）。送信済みの本文は送ってから45日、取りやめ・送れなかったの本文は残っていれば消す。
--     Resend の知らせの受付済みの番号は3日
CREATE OR REPLACE FUNCTION private.purge_order_email_data()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE private.order_email_outbox AS e
  SET subject = NULL,
      body_text = NULL,
      body_erased_at = pg_catalog.now()
  WHERE e.subject IS NOT NULL
    AND (
      (e.status = 'sent' AND e.sent_at < pg_catalog.now() - interval '45 days')
      OR e.status IN ('skipped', 'dead')
    );

  DELETE FROM private.resend_webhook_receipts AS r
  WHERE r.received_at < pg_catalog.now() - interval '3 days';
END;
$$;

-- 18. 定期処理の最後の成功に、注文のメールの worker と配達の見回りを足す
ALTER TABLE public.ops_job_heartbeats
  DROP CONSTRAINT IF EXISTS ops_job_heartbeats_job_check,
  ADD CONSTRAINT ops_job_heartbeats_job_check CHECK (
    job IN ('webhook_worker', 'order_sweep', 'stripe_reconcile', 'order_email_worker', 'order_email_delivery_check')
  );

-- 19. 権限。private の関数は PUBLIC から外すだけ（状態を変える関数と定期処理だけが呼ぶ）
REVOKE ALL ON FUNCTION private.order_email_max_attempts() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_email_retry_delay(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_order_email(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.set_order_email_pause(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.purge_order_email_data() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.claim_order_email(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_order_email_content(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_order_email(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_order_email(uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skip_order_email(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pause_order_email_sending(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_email_send_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_order_email_resend(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_email_history(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_status_history(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_email_content(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_order_email_delivery(text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_order_emails_awaiting_delivery(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_email_backlog(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_unnotified_dead_order_emails(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_emails_dead_notified(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_unnotified_order_email_delivery_problems(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_email_delivery_problems_notified(uuid[]) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_order_email(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_order_email_content(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_email(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_order_email(uuid, uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.skip_order_email(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pause_order_email_sending(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_email_send_state() TO service_role;
GRANT EXECUTE ON FUNCTION public.request_order_email_resend(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_email_history(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_status_history(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_email_content(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_order_email_delivery(text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_order_emails_awaiting_delivery(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_email_backlog(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_unnotified_dead_order_emails(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_emails_dead_notified(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_unnotified_order_email_delivery_problems(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_email_delivery_problems_notified(uuid[]) TO service_role;

-- 20. 毎日の片付け（日本時間 4:40。実行の記録の掃除の後）。同名のジョブは置き換わる
SELECT cron.schedule(
  'order-email-retention',
  '40 19 * * *',
  $$ SELECT private.purge_order_email_data() $$
);

NOTIFY pgrst, 'reload schema';

COMMIT;
