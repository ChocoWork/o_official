-- 配送の記録と守り（グループ E-4、移行 A）。
-- 追跡は最初オフにし、既存の発送へ出来事だけを補う。登録と配送メールの予定は作らない。
BEGIN;

-- 古い作成RPCも移行Bまで動くよう、状況の時刻に取引の現在時刻を既定として持たせる。
ALTER TABLE public.shop_settings
  ADD COLUMN delivery_tracking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN delivery_tracking_updated_at timestamptz,
  ADD COLUMN delivery_tracking_updated_by uuid;

ALTER TABLE public.order_fulfillments
  ADD COLUMN delivery_status text NOT NULL DEFAULT 'confirmed'
    CHECK (delivery_status IN ('confirmed','in_transit','out_for_delivery','attempted_delivery','ready_for_pickup','delivered','delayed','failure')),
  ADD COLUMN delivery_status_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN tracking_version integer NOT NULL DEFAULT 1 CHECK (tracking_version >= 1),
  ADD COLUMN request_fingerprint text,
  ADD CONSTRAINT order_fulfillments_delivery_check CHECK (
    (delivery_status = 'delivered') = (delivered_at IS NOT NULL)
    AND (delivered_at IS NULL OR delivered_at >= shipped_at)
  );

-- ALTER TABLEの鍵を取引の終わりまで保ち、取消済みも含めて発送した時刻へ揃える間だけ旧ガードを外す。
ALTER TABLE public.order_fulfillments DISABLE TRIGGER order_fulfillments_cancel_only;
UPDATE public.order_fulfillments
SET delivery_status_at = shipped_at
WHERE delivery_status_at IS DISTINCT FROM shipped_at;

-- 既存の取消分岐は残し、RPCのownerと操作印が揃った配送更新だけを追加で許す。
CREATE OR REPLACE FUNCTION private.restrict_fulfillment_record_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_change text;
  v_allowed text[];
BEGIN
  -- 仕上がりの取消でもこの関数を使うので、配送の例外は発送の表だけに限る。
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'order_fulfillments' THEN
    IF (pg_catalog.to_jsonb(NEW) - 'cancelled_at' - 'cancelled_by')
         IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'cancelled_at' - 'cancelled_by') THEN
      v_change := pg_catalog.current_setting('app.fulfillment_change', true);
      IF v_change IS NULL OR v_change NOT IN ('tracking_edit', 'manual', 'tracking')
         OR CURRENT_USER IS DISTINCT FROM (
           SELECT pg_catalog.pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc AS p
           WHERE p.oid = 'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)'::pg_catalog.regprocedure
         )
         OR OLD.cancelled_at IS NOT NULL THEN
        RAISE EXCEPTION 'DELIVERY_RECORD_IMMUTABLE' USING ERRCODE = '55000';
      END IF;

      v_allowed := ARRAY[
        'shipping_carrier', 'tracking_number', 'notify_customer',
        'delivery_status', 'delivery_status_at', 'delivered_at', 'tracking_version'
      ];
      -- 作成時の指紋は番号の直しで既存のNULLを一度補う場合だけ、同じ更新に含められる。
      IF OLD.request_fingerprint IS NULL AND NEW.request_fingerprint IS NOT NULL
         AND v_change = 'tracking_edit' THEN
        v_allowed := pg_catalog.array_append(v_allowed, 'request_fingerprint');
      END IF;
      IF (pg_catalog.to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_allowed)
         OR (v_change = 'tracking_edit' AND NEW.tracking_version <> OLD.tracking_version + 1)
         OR (v_change <> 'tracking_edit' AND NEW.tracking_version <> OLD.tracking_version)
         OR (v_change = 'tracking' AND OLD.delivery_status = 'delivered' AND NEW.delivery_status <> 'delivered') THEN
        RAISE EXCEPTION 'DELIVERY_RECORD_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF (pg_catalog.to_jsonb(NEW) - 'cancelled_at' - 'cancelled_by')
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'cancelled_at' - 'cancelled_by')
     OR OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION '% allows only one cancellation', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.order_fulfillments ENABLE TRIGGER order_fulfillments_cancel_only;

-- 配送列が変わらない既存トグルの更新は通し、配送を変える場合だけownerと操作印を確認する。
CREATE OR REPLACE FUNCTION private.guard_delivery_settings_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF ROW(NEW.delivery_tracking_enabled, NEW.delivery_tracking_updated_at, NEW.delivery_tracking_updated_by)
       IS DISTINCT FROM ROW(OLD.delivery_tracking_enabled, OLD.delivery_tracking_updated_at, OLD.delivery_tracking_updated_by) THEN
    IF pg_catalog.current_setting('app.delivery_tracking_setting', true) IS DISTINCT FROM 'toggle'
       OR CURRENT_USER IS DISTINCT FROM (
         SELECT pg_catalog.pg_get_userbyid(p.proowner)
         FROM pg_catalog.pg_proc AS p
         WHERE p.oid = 'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)'::pg_catalog.regprocedure
       )
       OR (pg_catalog.to_jsonb(NEW) - ARRAY['delivery_tracking_enabled', 'delivery_tracking_updated_at', 'delivery_tracking_updated_by'])
            IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['delivery_tracking_enabled', 'delivery_tracking_updated_at', 'delivery_tracking_updated_by']) THEN
      RAISE EXCEPTION 'DELIVERY_RECORD_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shop_settings_delivery_update_guard ON public.shop_settings;
CREATE TRIGGER shop_settings_delivery_update_guard
  BEFORE UPDATE ON public.shop_settings
  FOR EACH ROW EXECUTE FUNCTION private.guard_delivery_settings_update();

-- 実行者のuuidにはFKを付けず、利用者の削除が追記のUPDATEを起こさないようにする。
CREATE TABLE IF NOT EXISTS public.order_fulfillment_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  fulfillment_id uuid NOT NULL REFERENCES public.order_fulfillments(id) ON DELETE RESTRICT,
  tracking_version integer NOT NULL CHECK (tracking_version >= 1),
  status text NOT NULL CONSTRAINT order_fulfillment_events_status_check
    CHECK (status IN ('confirmed','in_transit','out_for_delivery','attempted_delivery','ready_for_pickup','delivered','delayed','failure')),
  happened_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  source text NOT NULL CHECK (source IN ('shipment','tracking','manual','tracking_edit')),
  provider_sub_status text CHECK (provider_sub_status IS NULL OR pg_catalog.char_length(provider_sub_status) BETWEEN 1 AND 100),
  created_by uuid,
  request_key uuid,
  request_fingerprint text,
  CONSTRAINT order_fulfillment_events_once_key UNIQUE (fulfillment_id,tracking_version,status,happened_at),
  CONSTRAINT order_fulfillment_events_request_check CHECK (
    (source='manual' AND request_key IS NOT NULL AND request_fingerprint IS NOT NULL AND created_by IS NOT NULL)
    OR (source<>'manual' AND request_key IS NULL AND request_fingerprint IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS order_fulfillment_events_manual_request_idx
  ON public.order_fulfillment_events (request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_fulfillment_events_history_idx
  ON public.order_fulfillment_events (fulfillment_id,tracking_version,happened_at DESC,recorded_at DESC,id);

CREATE TABLE IF NOT EXISTS public.order_fulfillment_tracking_changes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  fulfillment_id uuid NOT NULL REFERENCES public.order_fulfillments(id) ON DELETE RESTRICT,
  from_carrier text CHECK (from_carrier IS NULL OR from_carrier IN ('yamato','sagawa','japanpost')),
  to_carrier text NOT NULL CHECK (to_carrier IN ('yamato','sagawa','japanpost')),
  from_tracking_number text CHECK (from_tracking_number IS NULL OR from_tracking_number ~ '^[0-9A-Za-z-]{1,64}$'),
  to_tracking_number text NOT NULL CHECK (to_tracking_number ~ '^[0-9A-Za-z-]{1,64}$'),
  tracking_version integer NOT NULL CHECK (tracking_version >= 2),
  notify_customer boolean NOT NULL,
  request_key uuid NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_fulfillment_tracking_changes_version_key UNIQUE(fulfillment_id,tracking_version)
);

CREATE INDEX IF NOT EXISTS order_fulfillment_tracking_changes_history_idx
  ON public.order_fulfillment_tracking_changes (fulfillment_id,changed_at DESC);

CREATE TABLE IF NOT EXISTS private.fulfillment_tracking_registrations (
  fulfillment_id uuid NOT NULL REFERENCES public.order_fulfillments(id) ON DELETE RESTRICT,
  tracking_version integer NOT NULL CHECK (tracking_version >= 1),
  carrier text NOT NULL CHECK (carrier IN ('yamato','sagawa','japanpost')),
  tracking_number text NOT NULL CHECK (tracking_number ~ '^[0-9A-Z-]{1,64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','registered','stopped','failed')),
  failure_kind text CHECK (failure_kind IN ('invalid_number','repeated_error')),
  expires_at timestamptz NOT NULL,
  ever_registered boolean NOT NULL DEFAULT false,
  retry_allowed boolean NOT NULL DEFAULT true,
  -- 列の値とstateとの整合を別々に守るため、列CHECKは複合CHECKと別名にする。
  stop_reason text CONSTRAINT fulfillment_tracking_registrations_stop_reason_value_check
    CHECK (stop_reason IN ('delivered','expired','replaced','cancelled','provider_stopped','disabled')),
  next_run_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  read_attempts integer NOT NULL DEFAULT 0 CHECK (read_attempts >= 0),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_-]{1,64}$'),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_status text CHECK (provider_status IS NULL OR pg_catalog.char_length(provider_status) BETWEEN 1 AND 100),
  provider_sub_status text CHECK (provider_sub_status IS NULL OR pg_catalog.char_length(provider_sub_status) BETWEEN 1 AND 100),
  last_read_at timestamptz,
  registered_at timestamptz,
  stopped_at timestamptz,
  signal_revision bigint NOT NULL DEFAULT 0 CHECK (signal_revision >= 0),
  claimed_signal_revision bigint,
  stop_signaled boolean NOT NULL DEFAULT false,
  provider_stop_pending boolean NOT NULL DEFAULT false,
  provider_stop_attempted_at timestamptz,
  retrack_attempted_at timestamptz,
  PRIMARY KEY (fulfillment_id,tracking_version),
  CONSTRAINT fulfillment_tracking_registrations_failure_check CHECK ((state='failed') = (failure_kind IS NOT NULL)),
  CONSTRAINT fulfillment_tracking_registrations_stop_reason_check CHECK ((state='stopped') = (stop_reason IS NOT NULL)),
  CONSTRAINT fulfillment_tracking_registrations_stopped_at_check CHECK ((state='stopped') = (stopped_at IS NOT NULL)),
  CONSTRAINT fulfillment_tracking_registrations_lease_check CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT fulfillment_tracking_registrations_registered_check CHECK (NOT ever_registered OR registered_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fulfillment_tracking_due_idx
  ON private.fulfillment_tracking_registrations (next_run_at) WHERE state<>'stopped';
-- 同じ組を使う別の発送も追跡するので、この索引をUNIQUEにしない。
CREATE INDEX IF NOT EXISTS fulfillment_tracking_pair_idx
  ON private.fulfillment_tracking_registrations (carrier,tracking_number);
CREATE INDEX IF NOT EXISTS fulfillment_tracking_stop_idx
  ON private.fulfillment_tracking_registrations (next_run_at) WHERE provider_stop_pending;

CREATE TABLE IF NOT EXISTS public.order_fulfillment_attention (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  fulfillment_id uuid NOT NULL REFERENCES public.order_fulfillments(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('delivery_failure','attempted_delivery','tracking_not_found','tracking_registration_failed','tracking_stalled')),
  opened_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  resolved_at timestamptz,
  resolved_by uuid,
  -- 列CHECKの自動名が下の複合CHECKと重なるため、列側だけ別名にする。
  resolution text CONSTRAINT order_fulfillment_attention_resolution_value_check CHECK (resolution IN ('auto','manual')),
  CONSTRAINT order_fulfillment_attention_resolution_check CHECK (
    (resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL)
    OR (resolved_at IS NOT NULL AND resolution IS NOT NULL
      AND ((resolution='auto' AND resolved_by IS NULL) OR (resolution='manual' AND resolved_by IS NOT NULL)))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS order_fulfillment_attention_open_idx
  ON public.order_fulfillment_attention (fulfillment_id,kind) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS order_fulfillment_attention_queue_idx
  ON public.order_fulfillment_attention (opened_at,id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS private.delivery_tracking_provider_gate (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  next_call_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

INSERT INTO private.delivery_tracking_provider_gate (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- postgresの試験接続でも、追記の書き換えや記録の削除を拒むためトリガーで守る。
CREATE OR REPLACE FUNCTION private.reject_delivery_record_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'DELIVERY_RECORD_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_delivery_attention_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['resolved_at', 'resolved_by', 'resolution'])
          IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['resolved_at', 'resolved_by', 'resolution']) THEN
    RAISE EXCEPTION 'DELIVERY_RECORD_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_fulfillment_events_no_update ON public.order_fulfillment_events;
CREATE TRIGGER order_fulfillment_events_no_update
  BEFORE UPDATE OR DELETE ON public.order_fulfillment_events
  FOR EACH ROW EXECUTE FUNCTION private.reject_delivery_record_change();
DROP TRIGGER IF EXISTS order_fulfillment_events_no_truncate ON public.order_fulfillment_events;
CREATE TRIGGER order_fulfillment_events_no_truncate
  BEFORE TRUNCATE ON public.order_fulfillment_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_delivery_record_change();

DROP TRIGGER IF EXISTS order_fulfillment_tracking_changes_no_update ON public.order_fulfillment_tracking_changes;
CREATE TRIGGER order_fulfillment_tracking_changes_no_update
  BEFORE UPDATE OR DELETE ON public.order_fulfillment_tracking_changes
  FOR EACH ROW EXECUTE FUNCTION private.reject_delivery_record_change();
DROP TRIGGER IF EXISTS order_fulfillment_tracking_changes_no_truncate ON public.order_fulfillment_tracking_changes;
CREATE TRIGGER order_fulfillment_tracking_changes_no_truncate
  BEFORE TRUNCATE ON public.order_fulfillment_tracking_changes
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_delivery_record_change();

DROP TRIGGER IF EXISTS order_fulfillment_attention_update_guard ON public.order_fulfillment_attention;
CREATE TRIGGER order_fulfillment_attention_update_guard
  BEFORE UPDATE ON public.order_fulfillment_attention
  FOR EACH ROW EXECUTE FUNCTION private.guard_delivery_attention_update();
DROP TRIGGER IF EXISTS order_fulfillment_attention_no_delete ON public.order_fulfillment_attention;
CREATE TRIGGER order_fulfillment_attention_no_delete
  BEFORE DELETE ON public.order_fulfillment_attention
  FOR EACH ROW EXECUTE FUNCTION private.reject_delivery_record_change();
DROP TRIGGER IF EXISTS order_fulfillment_attention_no_truncate ON public.order_fulfillment_attention;
CREATE TRIGGER order_fulfillment_attention_no_truncate
  BEFORE TRUNCATE ON public.order_fulfillment_attention
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_delivery_record_change();

DROP TRIGGER IF EXISTS fulfillment_tracking_registrations_no_delete ON private.fulfillment_tracking_registrations;
CREATE TRIGGER fulfillment_tracking_registrations_no_delete
  BEFORE DELETE ON private.fulfillment_tracking_registrations
  FOR EACH ROW EXECUTE FUNCTION private.reject_delivery_record_change();
DROP TRIGGER IF EXISTS fulfillment_tracking_registrations_no_truncate ON private.fulfillment_tracking_registrations;
CREATE TRIGGER fulfillment_tracking_registrations_no_truncate
  BEFORE TRUNCATE ON private.fulfillment_tracking_registrations
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_delivery_record_change();

DROP TRIGGER IF EXISTS delivery_tracking_provider_gate_no_delete ON private.delivery_tracking_provider_gate;
CREATE TRIGGER delivery_tracking_provider_gate_no_delete
  BEFORE DELETE ON private.delivery_tracking_provider_gate
  FOR EACH ROW EXECUTE FUNCTION private.reject_delivery_record_change();
DROP TRIGGER IF EXISTS delivery_tracking_provider_gate_no_truncate ON private.delivery_tracking_provider_gate;
CREATE TRIGGER delivery_tracking_provider_gate_no_truncate
  BEFORE TRUNCATE ON private.delivery_tracking_provider_gate
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_delivery_record_change();

-- 移行と試験が同じ道を使い、取消済みを除いてlegacy番号無しも一度だけ補う。
CREATE OR REPLACE FUNCTION private.backfill_delivery_events()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO public.order_fulfillment_events (fulfillment_id,tracking_version,status,happened_at,source)
  SELECT f.id, 1, 'confirmed', f.shipped_at, 'shipment'
  FROM public.order_fulfillments AS f
  WHERE f.cancelled_at IS NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

SELECT private.backfill_delivery_events();

ALTER TABLE private.order_email_outbox
  ADD COLUMN tracking_version integer CHECK (tracking_version >= 1),
  ADD COLUMN tracking_change_id uuid REFERENCES public.order_fulfillment_tracking_changes(id) ON DELETE RESTRICT;

-- 最新の段2 DのCHECKから配送3種類だけを足し、返品・返金・キャンセルの既存の条件は保つ。
ALTER TABLE private.order_email_outbox DROP CONSTRAINT order_email_outbox_kind_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_kind_check
  CHECK (kind IN (
    'paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped', 'refund',
    'return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop',
    'return_requested', 'return_declined', 'return_request_shop',
    'cancel_request_received', 'cancel_request_declined', 'cancel_request_shop',
    'out_for_delivery', 'delivered', 'shipping_update'
  ));

ALTER TABLE private.order_email_outbox DROP CONSTRAINT order_email_outbox_variant_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_variant_check CHECK (
    (kind = 'paid' AND variant IS NOT NULL
      AND variant IN ('order_confirmed', 'payment_received', 'payment_received_after_expiry'))
    OR (kind = 'canceled' AND variant IS NOT NULL AND variant IN ('payment_in_progress', 'pending', 'paid'))
    OR (kind = 'refund' AND variant IS NOT NULL AND variant IN ('standard', 'after_cancel', 'return'))
    OR (kind IN (
      'awaiting_payment', 'payment_expired', 'shipped',
      'return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop',
      'return_requested', 'return_declined', 'return_request_shop',
      'cancel_request_received', 'cancel_request_declined', 'cancel_request_shop',
      'out_for_delivery', 'delivered', 'shipping_update'
    ) AND variant IS NULL)
  );

ALTER TABLE private.order_email_outbox DROP CONSTRAINT order_email_outbox_fulfillment_check;
ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_fulfillment_check
  CHECK ((kind IN ('shipped','out_for_delivery','delivered','shipping_update')) = (fulfillment_id IS NOT NULL));

ALTER TABLE private.order_email_outbox
  ADD CONSTRAINT order_email_outbox_tracking_check CHECK (
    ((kind IN ('out_for_delivery','delivered','shipping_update')) = (tracking_version IS NOT NULL))
    AND ((kind='shipping_update') = (tracking_change_id IS NOT NULL))
  );

CREATE UNIQUE INDEX order_email_outbox_auto_delivery_idx
  ON private.order_email_outbox (fulfillment_id,tracking_version,kind)
  WHERE origin='auto' AND kind IN ('out_for_delivery','delivered');
CREATE UNIQUE INDEX order_email_outbox_auto_tracking_change_idx
  ON private.order_email_outbox (tracking_change_id)
  WHERE origin='auto' AND kind='shipping_update';

-- 注文単位の一意索引から配送3種類を外す。enqueueの最終分岐も同じ述語へ揃える。
DROP INDEX private.order_email_outbox_auto_once_idx;
CREATE UNIQUE INDEX order_email_outbox_auto_once_idx
  ON private.order_email_outbox (order_id, kind)
  WHERE origin = 'auto' AND kind <> 'shipped' AND refund_id IS NULL
    AND kind NOT IN ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop', 'return_requested', 'return_declined', 'return_request_shop', 'cancel_request_received', 'cancel_request_declined', 'cancel_request_shop', 'out_for_delivery', 'delivered', 'shipping_update');

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
        AND kind NOT IN ('return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop', 'return_requested', 'return_declined', 'return_request_shop', 'cancel_request_received', 'cancel_request_declined', 'cancel_request_shop', 'out_for_delivery', 'delivered', 'shipping_update')
      DO NOTHING;
  END IF;
  RETURN FOUND;
END;
$$;

-- 答えの列数が変わるのでDROPしてから、宣言・RETURNING・SELECTの3か所だけを増やす。
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
  return_receipt_id uuid,
  cancel_request_id uuid,
  tracking_version integer,
  tracking_change_id uuid
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
              e.fulfillment_id, e.refund_id, e.return_id, e.return_receipt_id, e.cancel_request_id, e.tracking_version, e.tracking_change_id
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
         c.refund_id, c.return_id, c.return_receipt_id, c.cancel_request_id, c.tracking_version, c.tracking_change_id
  FROM claimed AS c;
END;
$$;

ALTER TABLE public.ops_job_heartbeats
  DROP CONSTRAINT ops_job_heartbeats_job_check,
  ADD CONSTRAINT ops_job_heartbeats_job_check CHECK (
    job IN ('webhook_worker', 'order_sweep', 'stripe_reconcile', 'order_email_worker', 'order_email_delivery_check', 'return_photo_purge', 'delivery_tracking')
  );

-- RLSと権限を重ね、アプリから新しい記録を直接書く道を作らない。
ALTER TABLE public.order_fulfillment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_fulfillment_tracking_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_fulfillment_attention ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.fulfillment_tracking_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.delivery_tracking_provider_gate ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny direct client access" ON public.order_fulfillment_events;
CREATE POLICY "deny direct client access" ON public.order_fulfillment_events
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_fulfillment_tracking_changes;
CREATE POLICY "deny direct client access" ON public.order_fulfillment_tracking_changes
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_fulfillment_attention;
CREATE POLICY "deny direct client access" ON public.order_fulfillment_attention
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON private.fulfillment_tracking_registrations;
CREATE POLICY "deny direct client access" ON private.fulfillment_tracking_registrations
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON private.delivery_tracking_provider_gate;
CREATE POLICY "deny direct client access" ON private.delivery_tracking_provider_gate
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON public.order_fulfillment_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_fulfillment_tracking_changes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_fulfillment_attention FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON private.fulfillment_tracking_registrations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON private.delivery_tracking_provider_gate FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.order_fulfillment_events TO service_role;
GRANT SELECT ON public.order_fulfillment_tracking_changes TO service_role;
GRANT SELECT ON public.order_fulfillment_attention TO service_role;
GRANT SELECT ON private.fulfillment_tracking_registrations TO service_role;
GRANT SELECT ON private.delivery_tracking_provider_gate TO service_role;

REVOKE ALL ON FUNCTION private.restrict_fulfillment_record_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.guard_delivery_settings_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.reject_delivery_record_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.guard_delivery_attention_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.backfill_delivery_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_order_email(uuid, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_order_email(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_email(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
