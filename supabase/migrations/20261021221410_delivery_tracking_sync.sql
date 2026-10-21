-- 配送の追跡の関数（グループ E-4、移行 C）。
-- 登録の借り出し・登録の結果・読み直しの結果・17TRACK の知らせの合図・期限切れ・外への停止の結果・provider の枠を加える。
-- 17TRACK への HTTP 呼び出しは worker（TS）が行う。ここでは DB の取引の中だけで状態・出来事・メール・要対応を書く。
-- 鍵の順番は 設定（FOR SHARE）→ 注文 → 発送 →（借り出しだけ 組の advisory lock）→ 登録。借り出し・期限切れは SKIP LOCKED で待たない。
BEGIN;

-- 1. 配送の要対応を開く・自動で閉じる。P19: 呼ぶ側が「新しい条件」の時だけ開く。開いた行が既にあれば何もしない。
CREATE OR REPLACE FUNCTION private.set_delivery_attention(_fulfillment_id uuid, _kind text, _open boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF _fulfillment_id IS NULL OR _kind IS NULL OR _open IS NULL
     OR _kind NOT IN ('delivery_failure', 'attempted_delivery', 'tracking_not_found', 'tracking_registration_failed', 'tracking_stalled') THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF _open THEN
    INSERT INTO public.order_fulfillment_attention (fulfillment_id, kind)
    VALUES (_fulfillment_id, _kind)
    ON CONFLICT (fulfillment_id, kind) WHERE resolved_at IS NULL DO NOTHING;
  ELSE
    UPDATE public.order_fulfillment_attention AS a
    SET resolved_at = pg_catalog.now(),
        resolution = 'auto'
    WHERE a.fulfillment_id = _fulfillment_id
      AND a.kind = _kind
      AND a.resolved_at IS NULL;
  END IF;
END;
$$;

-- 2. 追跡で配送の状況を書く。配送業者・番号・版・通知の列には触れない（守りのトリガーは操作印 tracking で状況の3列だけ許す）。
CREATE OR REPLACE FUNCTION private.apply_tracking_status(
  _fulfillment_id uuid,
  _status text,
  _status_at timestamptz,
  _delivered_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_previous text;
BEGIN
  v_previous := pg_catalog.current_setting('app.fulfillment_change', true);
  PERFORM pg_catalog.set_config('app.fulfillment_change', 'tracking', true);
  UPDATE public.order_fulfillments AS f
  SET delivery_status = _status,
      delivery_status_at = _status_at,
      delivered_at = _delivered_at
  WHERE f.id = _fulfillment_id;
  PERFORM pg_catalog.set_config('app.fulfillment_change', COALESCE(v_previous, ''), true);
END;
$$;

-- 3. provider の枠。1行の鍵で次の開始を334ms後へ予約し、待つ ms を返す（0 は今呼べる）。1秒に最大3開始。
--    鍵を待った後の時刻で比べる（待っている間に取引の now() が古くなるため clock_timestamp を使う）。
CREATE OR REPLACE FUNCTION public.take_delivery_provider_slot()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_next timestamptz;
  v_now timestamptz;
  v_start timestamptz;
BEGIN
  SELECT g.next_call_at INTO v_next
  FROM private.delivery_tracking_provider_gate AS g
  WHERE g.id
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();
  v_start := GREATEST(v_now, COALESCE(v_next, v_now));

  UPDATE private.delivery_tracking_provider_gate AS g
  SET next_call_at = v_start + interval '334 milliseconds'
  WHERE g.id;

  RETURN pg_catalog.ceil(EXTRACT(EPOCH FROM (v_start - v_now)) * 1000)::integer;
END;
$$;

-- 4. 17TRACK の知らせを読み直しの合図にする。(配送業者, 大文字の番号) で合う registered の行を全部、今すぐ読む行にする。
--    借りている間の合図も数えられるよう signal_revision を進める（結果を書く時に比べる）。TRACKING_STOPPED は stop_signaled も立てる。
--    知らない組・止めた行・まだ登録していない行は何も変えない。追跡がオフなら何もしない。
CREATE OR REPLACE FUNCTION public.signal_delivery_tracking(_signals jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enabled boolean;
  v_target record;
  v_count integer := 0;
BEGIN
  IF _signals IS NULL OR pg_catalog.jsonb_typeof(_signals) <> 'array' THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN 0;
  END IF;

  -- 同じ組が何回来ても、1回の呼び出しで合図の番号は1つだけ進める。
  -- 行の鍵は決まった順（配送業者, 番号, 発送, 版）で取ってから更新する。同じ組を含む知らせが2つ同時に来ても、逆順に取り合って落ちない
  FOR v_target IN
  WITH parsed AS (
    SELECT CASE t.e ->> 'carrier'
             WHEN '100062' THEN 'yamato'
             WHEN '100040' THEN 'sagawa'
             WHEN '10021' THEN 'japanpost'
           END AS carrier,
           pg_catalog.upper(t.e ->> 'number') AS tracking_number,
           (t.e ->> 'event') = 'TRACKING_STOPPED' AS is_stop
    FROM pg_catalog.jsonb_array_elements(_signals) AS t(e)
    WHERE pg_catalog.jsonb_typeof(t.e -> 'number') = 'string'
      AND (t.e ->> 'event') IN ('TRACKING_UPDATED', 'TRACKING_STOPPED')
  ), wanted AS (
    SELECT p.carrier, p.tracking_number, pg_catalog.bool_or(p.is_stop) AS stopped
    FROM parsed AS p
    WHERE p.carrier IS NOT NULL
    GROUP BY p.carrier, p.tracking_number
  )
  SELECT r.fulfillment_id AS target_fulfillment_id,
         r.tracking_version AS target_version,
         w.stopped AS target_stopped
  FROM private.fulfillment_tracking_registrations AS r
  JOIN wanted AS w ON w.carrier = r.carrier AND w.tracking_number = r.tracking_number
  WHERE r.state = 'registered'
  ORDER BY r.carrier, r.tracking_number, r.fulfillment_id, r.tracking_version
  FOR UPDATE OF r
  LOOP
    UPDATE private.fulfillment_tracking_registrations AS r
    SET signal_revision = r.signal_revision + 1,
        next_run_at = pg_catalog.now(),
        stop_signaled = r.stop_signaled OR v_target.target_stopped
    WHERE r.fulfillment_id = v_target.target_fulfillment_id
      AND r.tracking_version = v_target.target_version
      AND r.state = 'registered';
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 5. 登録・読み直し・外への停止を借りる。追跡がオンの時だけ。
--    候補（時刻が来た行・失効した借りだけ）を読む → 注文・発送を SKIP LOCKED → 組の advisory lock（try）→ 登録を SKIP LOCKED →
--    別の SQL 文で同じ組の有効な借りを再確認 → 借りの印を書く、の順。同じ回の中の共有番号も、この再確認が自分の直前の書き込みを見るので同時に借りない。
--    候補の一覧は最初に1回だけ（時刻順に上限つき）読み、1行ごとに鍵を取った後の値で確かめ直す。一覧を読み直さないのは、
--    取引の途中で行が増減しても確かめ直しで足りるため。上限で届かなかった行は、次の借り出しで時刻順に先頭になる。
--    action: pending/failed は register（止まった組を再び追う行は retrack）、registered は read、外への停止の印がある止めた行は stop。
CREATE OR REPLACE FUNCTION public.claim_delivery_tracking(_limit integer, _lease_seconds integer)
RETURNS TABLE (
  fulfillment_id uuid,
  tracking_version integer,
  carrier text,
  tracking_number text,
  action text,
  lease_token uuid,
  signal_revision bigint,
  attempts integer,
  read_attempts integer,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_enabled boolean;
  v_candidate record;
  v_row private.fulfillment_tracking_registrations;
  v_claimed integer := 0;
  v_action text;
  v_busy boolean;
  v_others boolean;
  v_history boolean;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 40
     OR _lease_seconds IS NULL OR _lease_seconds < 30 OR _lease_seconds > 300 THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN;
  END IF;

  FOR v_candidate IN
    SELECT r.fulfillment_id AS candidate_fulfillment_id,
           r.tracking_version AS candidate_version,
           r.carrier AS candidate_carrier,
           r.tracking_number AS candidate_number,
           f.order_id AS candidate_order_id
    FROM private.fulfillment_tracking_registrations AS r
    JOIN public.order_fulfillments AS f ON f.id = r.fulfillment_id
    WHERE r.next_run_at <= pg_catalog.now()
      AND (r.lease_token IS NULL OR r.lease_expires_at <= pg_catalog.now())
      AND (
        (r.state = 'stopped' AND r.provider_stop_pending)
        OR (
          f.cancelled_at IS NULL
          AND r.expires_at > pg_catalog.now()
          AND (
            r.state IN ('pending', 'registered')
            OR (r.state = 'failed' AND r.failure_kind = 'repeated_error' AND r.retry_allowed)
          )
        )
      )
    ORDER BY r.next_run_at, r.fulfillment_id, r.tracking_version
    LIMIT GREATEST(_limit * 5, 200)
  LOOP
    EXIT WHEN v_claimed >= _limit;

    PERFORM 1 FROM public.orders AS o WHERE o.id = v_candidate.candidate_order_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    PERFORM 1 FROM public.order_fulfillments AS f WHERE f.id = v_candidate.candidate_fulfillment_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- 同じ組（配送業者, 大文字の番号）を同時に扱わない。取れなければほかの接続が扱っている
    IF NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(v_candidate.candidate_carrier || ':' || pg_catalog.upper(v_candidate.candidate_number), 0)
    ) THEN
      CONTINUE;
    END IF;

    SELECT r.* INTO v_row
    FROM private.fulfillment_tracking_registrations AS r
    WHERE r.fulfillment_id = v_candidate.candidate_fulfillment_id
      AND r.tracking_version = v_candidate.candidate_version
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- 候補を読んでから変わっていないかを、鍵を取った後の値で確かめる
    IF v_row.next_run_at > pg_catalog.now()
       OR (v_row.lease_token IS NOT NULL AND v_row.lease_expires_at > pg_catalog.now()) THEN
      CONTINUE;
    END IF;
    IF v_row.state = 'stopped' THEN
      IF NOT v_row.provider_stop_pending THEN
        CONTINUE;
      END IF;
    ELSIF v_row.expires_at <= pg_catalog.now()
          OR NOT (
            v_row.state IN ('pending', 'registered')
            OR (v_row.state = 'failed' AND v_row.failure_kind = 'repeated_error' AND v_row.retry_allowed)
          ) THEN
      CONTINUE;
    END IF;

    -- 別のSQL文で、同じ組の有効な借り（この行以外。外への停止の借りも含む）を再確認する
    SELECT EXISTS (
      SELECT 1
      FROM private.fulfillment_tracking_registrations AS o
      WHERE o.carrier = v_row.carrier
        AND o.tracking_number = v_row.tracking_number
        AND NOT (o.fulfillment_id = v_row.fulfillment_id AND o.tracking_version = v_row.tracking_version)
        AND o.lease_token IS NOT NULL
        AND o.lease_expires_at > pg_catalog.now()
    ) INTO v_busy;
    IF v_busy THEN
      CONTINUE;
    END IF;

    -- 同じ組の「この行以外で止まっていない行」。同じ発送の新しい版も数える
    SELECT EXISTS (
      SELECT 1
      FROM private.fulfillment_tracking_registrations AS o
      WHERE o.carrier = v_row.carrier
        AND o.tracking_number = v_row.tracking_number
        AND NOT (o.fulfillment_id = v_row.fulfillment_id AND o.tracking_version = v_row.tracking_version)
        AND o.state <> 'stopped'
    ) INTO v_others;

    IF v_row.state = 'stopped' THEN
      -- 外への停止は、直し・取消で止めた（一度は登録できた）行だけ。配達済み・期限切れ・オフ・17TRACK が止めた物には送らない。
      -- 同じ組で止まっていない行が1つでもあれば（移行 B が印を立てた後に増えた場合も）、印を外して渡さない
      IF v_row.stop_reason NOT IN ('replaced', 'cancelled') OR NOT v_row.ever_registered OR v_others THEN
        UPDATE private.fulfillment_tracking_registrations AS r
        SET provider_stop_pending = false
        WHERE r.fulfillment_id = v_row.fulfillment_id
          AND r.tracking_version = v_row.tracking_version;
        CONTINUE;
      END IF;
      v_action := 'stop';
    ELSIF v_row.state = 'registered' THEN
      v_action := 'read';
    ELSE
      -- 止まった組を再び追う時は retrack（自動停止の delivered・expired も含む）。別の追跡中の行があれば register（既登録の成功で共有）。
      -- オフで止めた（disabled）行は 17TRACK へ止める呼び方を送っていないので、履歴に数えない
      SELECT EXISTS (
        SELECT 1
        FROM private.fulfillment_tracking_registrations AS o
        WHERE o.carrier = v_row.carrier
          AND o.tracking_number = v_row.tracking_number
          AND NOT (o.fulfillment_id = v_row.fulfillment_id AND o.tracking_version = v_row.tracking_version)
          AND o.state = 'stopped'
          AND o.ever_registered
          AND o.stop_reason <> 'disabled'
      ) INTO v_history;
      v_action := CASE WHEN v_history AND NOT v_others THEN 'retrack' ELSE 'register' END;
    END IF;

    UPDATE private.fulfillment_tracking_registrations AS r
    SET lease_token = pg_catalog.gen_random_uuid(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => _lease_seconds),
        claimed_signal_revision = r.signal_revision,
        retrack_attempted_at = CASE WHEN v_action = 'retrack' THEN pg_catalog.now() ELSE r.retrack_attempted_at END
    WHERE r.fulfillment_id = v_row.fulfillment_id
      AND r.tracking_version = v_row.tracking_version
    RETURNING r.* INTO v_row;

    v_claimed := v_claimed + 1;
    RETURN QUERY SELECT v_row.fulfillment_id, v_row.tracking_version, v_row.carrier, v_row.tracking_number, v_action,
                        v_row.lease_token, v_row.signal_revision, v_row.attempts, v_row.read_attempts, v_row.expires_at;
  END LOOP;
END;
$$;

-- 6. 登録の結果を書く。借りの印・版・状態が合う時だけ。合わなければ何も書かず applied=false。
--    registered: 登録済み（初回成功の registered_at、今すぐ1回読む）と、登録失敗・番号が見つからない要対応を自動で閉じる。
--    invalid_number: failed/invalid_number（試し直さない）＋ tracking_not_found。
--    transient: attempts+1。5回目未満は pending のまま 5分/15分/1時間/6時間、5回目以上は failed/repeated_error＋要対応で24時間後。
--    account: 口座ぜんたいの失敗。状態も失敗の数も変えず、6時間後。要対応は開かない。
--    retrack_exhausted: failed/repeated_error・試し直さない＋ tracking_registration_failed。
CREATE OR REPLACE FUNCTION public.record_delivery_registration_result(
  _fulfillment_id uuid,
  _tracking_version integer,
  _lease_token uuid,
  _outcome text,
  _error_code text
)
RETURNS TABLE (applied boolean, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_enabled boolean;
  v_order_id uuid;
  v_f public.order_fulfillments;
  v_r private.fulfillment_tracking_registrations;
  v_attempts integer;
BEGIN
  IF _fulfillment_id IS NULL OR _tracking_version IS NULL OR _tracking_version < 1 OR _lease_token IS NULL
     OR _outcome IS NULL OR _outcome NOT IN ('registered', 'invalid_number', 'transient', 'account', 'retrack_exhausted')
     OR (_error_code IS NOT NULL AND _error_code !~ '^[a-z0-9_-]{1,64}$') THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN QUERY SELECT false, NULL::text;
    RETURN;
  END IF;

  SELECT f.order_id INTO v_order_id FROM public.order_fulfillments AS f WHERE f.id = _fulfillment_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text;
    RETURN;
  END IF;
  PERFORM 1 FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE;
  SELECT f.* INTO v_f FROM public.order_fulfillments AS f WHERE f.id = _fulfillment_id FOR UPDATE;

  SELECT r.* INTO v_r
  FROM private.fulfillment_tracking_registrations AS r
  WHERE r.fulfillment_id = _fulfillment_id
    AND r.tracking_version = _tracking_version
  FOR UPDATE;
  IF NOT FOUND
     OR v_r.lease_token IS DISTINCT FROM _lease_token
     OR v_r.lease_expires_at IS NULL
     OR v_r.lease_expires_at <= pg_catalog.now()
     OR v_r.state NOT IN ('pending', 'failed')
     OR v_f.cancelled_at IS NOT NULL
     OR v_f.tracking_version <> _tracking_version THEN
    RETURN QUERY SELECT false, v_r.state;
    RETURN;
  END IF;

  IF _outcome = 'registered' THEN
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'registered',
        failure_kind = NULL,
        attempts = 0,
        read_attempts = 0,
        ever_registered = true,
        registered_at = COALESCE(r.registered_at, pg_catalog.now()),
        retry_allowed = true,
        last_error_code = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        stop_signaled = false,
        next_run_at = pg_catalog.now()
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_registration_failed', false);
    PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', false);
    RETURN QUERY SELECT true, 'registered'::text;
  ELSIF _outcome = 'invalid_number' THEN
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'failed',
        failure_kind = 'invalid_number',
        retry_allowed = false,
        last_error_code = _error_code,
        lease_token = NULL,
        lease_expires_at = NULL
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', true);
    RETURN QUERY SELECT true, 'failed'::text;
  ELSIF _outcome = 'transient' THEN
    v_attempts := v_r.attempts + 1;
    IF v_attempts >= 5 THEN
      UPDATE private.fulfillment_tracking_registrations AS r
      SET state = 'failed',
          failure_kind = 'repeated_error',
          attempts = v_attempts,
          last_error_code = _error_code,
          lease_token = NULL,
          lease_expires_at = NULL,
          next_run_at = pg_catalog.now() + interval '24 hours'
      WHERE r.fulfillment_id = _fulfillment_id
        AND r.tracking_version = _tracking_version;
      -- 開くのは failed に変わった時（5回目の失敗）だけ（P19）。1日1回の試し直しの失敗では、店が閉じた後に開き直さない
      IF v_r.state <> 'failed' THEN
        PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_registration_failed', true);
      END IF;
      RETURN QUERY SELECT true, 'failed'::text;
    ELSE
      UPDATE private.fulfillment_tracking_registrations AS r
      SET attempts = v_attempts,
          last_error_code = _error_code,
          lease_token = NULL,
          lease_expires_at = NULL,
          next_run_at = pg_catalog.now() + CASE v_attempts
            WHEN 1 THEN interval '5 minutes'
            WHEN 2 THEN interval '15 minutes'
            WHEN 3 THEN interval '1 hour'
            ELSE interval '6 hours'
          END
      WHERE r.fulfillment_id = _fulfillment_id
        AND r.tracking_version = _tracking_version;
      RETURN QUERY SELECT true, v_r.state;
    END IF;
  ELSIF _outcome = 'account' THEN
    UPDATE private.fulfillment_tracking_registrations AS r
    SET last_error_code = _error_code,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_run_at = pg_catalog.now() + interval '6 hours'
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    RETURN QUERY SELECT true, v_r.state;
  ELSE
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'failed',
        failure_kind = 'repeated_error',
        retry_allowed = false,
        last_error_code = _error_code,
        lease_token = NULL,
        lease_expires_at = NULL
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    -- すでに failed（毎日の試し直しの途中）だった行は、要対応が出ている（閉じた）ので開き直さない
    IF v_r.state <> 'failed' THEN
      PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_registration_failed', true);
    END IF;
    RETURN QUERY SELECT true, 'failed'::text;
  END IF;
END;
$$;

-- 7. 読み直しの結果を書く（設計書 3-3 の決定表）。借りの印・版・状態が合う時だけ。
--    出来事・状況・メール・要対応・登録を同じ取引で書く。配送業者・番号・版・通知の列は変えない。
--    _result は DeliveryReadResult の snake_case（outcome, status, provider_status, provider_sub_status, happened_at, delivered_at, read_at, error_code）。
CREATE OR REPLACE FUNCTION public.record_delivery_read_result(
  _fulfillment_id uuid,
  _tracking_version integer,
  _lease_token uuid,
  _result jsonb
)
RETURNS TABLE (applied boolean, changed boolean, stopped boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_enabled boolean;
  v_order_id uuid;
  v_f public.order_fulfillments;
  v_r private.fulfillment_tracking_registrations;
  v_outcome text;
  v_status text;
  v_provider_status text;
  v_provider_sub text;
  v_error text;
  v_happened timestamptz;
  v_delivered timestamptz;
  v_read_at timestamptz;
  v_event_at timestamptz;
  v_newest timestamptz;
  v_delivered_at timestamptz;
  v_attempts integer;
  v_advanced boolean;
  v_next timestamptz;
  v_old boolean := false;
  v_changed boolean := false;
  v_stop boolean := false;
BEGIN
  IF _fulfillment_id IS NULL OR _tracking_version IS NULL OR _tracking_version < 1 OR _lease_token IS NULL
     OR _result IS NULL OR pg_catalog.jsonb_typeof(_result) <> 'object' THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_outcome := _result ->> 'outcome';
  IF v_outcome IS NULL OR v_outcome NOT IN ('ok', 'not_found', 'not_registered', 'invalid_number', 'transient', 'account') THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_status := NULLIF(_result ->> 'status', '');
  IF v_status IS NOT NULL
     AND v_status NOT IN ('confirmed', 'in_transit', 'out_for_delivery', 'attempted_delivery', 'ready_for_pickup', 'delivered', 'delayed', 'failure') THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_outcome <> 'ok' THEN
    v_status := NULL;
  END IF;

  BEGIN
    v_read_at := (_result ->> 'read_at')::timestamptz;
    v_happened := (_result ->> 'happened_at')::timestamptz;
    v_delivered := (_result ->> 'delivered_at')::timestamptz;
  EXCEPTION WHEN SQLSTATE '22007' OR SQLSTATE '22008' THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END;
  IF v_read_at IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- provider の時刻は読んだ時刻より後にしない（時差の読み違いで未来の出来事ができ、その後の読み直しが全部「古い」扱いになるのを防ぐ）。
  -- 時刻が無い（NULL）物は NULL のまま（LEAST は NULL を飛ばすので、そのままだと読んだ時刻に変わってしまう）
  IF v_happened IS NOT NULL THEN
    v_happened := LEAST(v_happened, v_read_at);
  END IF;
  IF v_delivered IS NOT NULL THEN
    v_delivered := LEAST(v_delivered, v_read_at);
  END IF;
  v_event_at := COALESCE(v_happened, v_read_at);
  v_provider_status := NULLIF(pg_catalog.left(_result ->> 'provider_status', 100), '');
  v_provider_sub := NULLIF(pg_catalog.left(_result ->> 'provider_sub_status', 100), '');
  -- 形の正しくない error_code は、登録の結果・停止の結果のように断らず空にする。
  -- error_code は診断のための記号で、17TRACK 側の癖で状況の記録まで止めないため
  v_error := _result ->> 'error_code';
  IF v_error IS NOT NULL AND v_error !~ '^[a-z0-9_-]{1,64}$' THEN
    v_error := NULL;
  END IF;

  -- 行1: 設定OFF・版違い・取消・token違い・lease失効 は何も書かない
  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN QUERY SELECT false, false, false;
    RETURN;
  END IF;

  SELECT f.order_id INTO v_order_id FROM public.order_fulfillments AS f WHERE f.id = _fulfillment_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, false;
    RETURN;
  END IF;
  PERFORM 1 FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE;
  SELECT f.* INTO v_f FROM public.order_fulfillments AS f WHERE f.id = _fulfillment_id FOR UPDATE;

  SELECT r.* INTO v_r
  FROM private.fulfillment_tracking_registrations AS r
  WHERE r.fulfillment_id = _fulfillment_id
    AND r.tracking_version = _tracking_version
  FOR UPDATE;
  IF NOT FOUND
     OR v_r.lease_token IS DISTINCT FROM _lease_token
     OR v_r.lease_expires_at IS NULL
     OR v_r.lease_expires_at <= pg_catalog.now()
     OR v_r.state <> 'registered'
     OR v_f.cancelled_at IS NOT NULL
     OR v_f.tracking_version <> _tracking_version THEN
    RETURN QUERY SELECT false, false, false;
    RETURN;
  END IF;

  -- 行2: すでに配達済み。状況は動かさず、登録だけ delivered で止める
  IF v_f.delivered_at IS NOT NULL THEN
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'stopped',
        stop_reason = 'delivered',
        stopped_at = pg_catalog.now(),
        failure_kind = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        stop_signaled = false,
        provider_stop_pending = false
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    PERFORM private.close_delivery_attention(_fulfillment_id);
    RETURN QUERY SELECT true, false, true;
    RETURN;
  END IF;

  -- 行3: 17TRACK がまだ登録を持っていない。登録待ちへ戻し、今すぐ登録し直す（ever_registered・registered_at は保つ）
  IF v_outcome = 'not_registered' THEN
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'pending',
        last_read_at = v_read_at,
        last_error_code = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_run_at = pg_catalog.now()
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    RETURN QUERY SELECT true, false, false;
    RETURN;
  END IF;

  -- 行3a: 番号が正しくない。登録時と同じ分類で、直ちに tracking_not_found を開く
  IF v_outcome = 'invalid_number' THEN
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'failed',
        failure_kind = 'invalid_number',
        retry_allowed = false,
        last_read_at = v_read_at,
        last_error_code = v_error,
        lease_token = NULL,
        lease_expires_at = NULL
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', true);
    RETURN QUERY SELECT true, false, false;
    RETURN;
  END IF;

  -- 行4: 一時の失敗・口座の失敗。前の状況を保つ。read_attempts は一時の失敗だけ加算（5分/15分/1時間/6時間）。口座は6時間
  IF v_outcome IN ('transient', 'account') THEN
    v_attempts := CASE WHEN v_outcome = 'transient' THEN v_r.read_attempts + 1 ELSE v_r.read_attempts END;
    UPDATE private.fulfillment_tracking_registrations AS r
    SET read_attempts = v_attempts,
        last_error_code = v_error,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_run_at = pg_catalog.now() + CASE
          WHEN v_outcome = 'account' THEN interval '6 hours'
          WHEN v_attempts <= 1 THEN interval '5 minutes'
          WHEN v_attempts = 2 THEN interval '15 minutes'
          WHEN v_attempts = 3 THEN interval '1 hour'
          ELSE interval '6 hours'
        END
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    RETURN QUERY SELECT true, false, false;
    RETURN;
  END IF;

  -- ここから成功した読み直し（ok・not_found）。借りている間に合図が進んでいたら次は今、そうでなければ6時間後
  v_advanced := v_r.signal_revision > COALESCE(v_r.claimed_signal_revision, 0);
  v_next := pg_catalog.now() + CASE WHEN v_advanced THEN interval '0 seconds' ELSE interval '6 hours' END;

  IF v_outcome = 'ok' THEN
    -- 行7: 同じ版の tracking の出来事のうち一番新しい時刻より前なら、状況もイベントも変えない（発送・直しの時刻とは比べない）。
    -- 状況の無い ok（行6）も同じ比べ方で、古い読み直しの記号で新しい記号を上書きしない
    SELECT pg_catalog.max(e.happened_at) INTO v_newest
    FROM public.order_fulfillment_events AS e
    WHERE e.fulfillment_id = _fulfillment_id
      AND e.tracking_version = _tracking_version
      AND e.source = 'tracking';
    v_old := v_newest IS NOT NULL AND v_event_at < v_newest;

    IF v_status IS NULL THEN
      -- 行6: 未知の状態。17TRACK は情報を持っているので、荷物が見つからない要対応は閉じる。
      -- 状況・出来事・メールは変えず、provider の記号と読んだ時刻だけを下で書く
      PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', false);
    ELSIF NOT v_old THEN
      IF v_status = v_f.delivery_status THEN
        -- 行8: 同じ状況。出来事は足さず、情報が出たので荷物が見つからない要対応だけ閉じる
        PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', false);
      ELSE
        -- 行9/10: 違う状況。出来事を1行（同じ版・状況・時刻は UNIQUE で増えない）。状況は借りた順の結果を受ける
        INSERT INTO public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source, provider_sub_status)
        VALUES (_fulfillment_id, _tracking_version, v_status, v_event_at, 'tracking', v_provider_sub)
        ON CONFLICT ON CONSTRAINT order_fulfillment_events_once_key DO NOTHING;
        PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', false);

        IF v_status = 'delivered' THEN
          -- 行10: 届いた時刻は発送した時刻より前にしない。登録は delivered で止め、要対応は全部閉じ、通知オンなら配達済みを1通
          v_delivered_at := GREATEST(COALESCE(v_delivered, v_event_at), v_f.shipped_at);
          PERFORM private.apply_tracking_status(_fulfillment_id, 'delivered', v_delivered_at, v_delivered_at);
          UPDATE private.fulfillment_tracking_registrations AS r
          SET state = 'stopped',
              stop_reason = 'delivered',
              stopped_at = pg_catalog.now(),
              failure_kind = NULL,
              provider_status = v_provider_status,
              provider_sub_status = v_provider_sub,
              last_read_at = v_read_at,
              read_attempts = 0,
              last_error_code = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              stop_signaled = false,
              provider_stop_pending = false
          WHERE r.fulfillment_id = _fulfillment_id
            AND r.tracking_version = _tracking_version;
          PERFORM private.close_delivery_attention(_fulfillment_id);
          PERFORM private.enqueue_delivery_email(_fulfillment_id, _tracking_version, 'delivered');
          RETURN QUERY SELECT true, true, true;
          RETURN;
        END IF;

        PERFORM private.apply_tracking_status(_fulfillment_id, v_status, v_event_at, NULL);
        v_changed := true;

        -- P19: 状況が変わった時だけ、その状況の要対応を開き、ほかの状況の要対応を閉じる
        IF v_status = 'failure' THEN
          PERFORM private.set_delivery_attention(_fulfillment_id, 'delivery_failure', true);
        ELSE
          PERFORM private.set_delivery_attention(_fulfillment_id, 'delivery_failure', false);
        END IF;
        IF v_status = 'attempted_delivery' THEN
          PERFORM private.set_delivery_attention(_fulfillment_id, 'attempted_delivery', true);
        ELSE
          PERFORM private.set_delivery_attention(_fulfillment_id, 'attempted_delivery', false);
        END IF;

        -- 行11: 配達中は、通知オンでまだ配達済みでない時だけ1通（補助が条件を確かめる）
        IF v_status = 'out_for_delivery' THEN
          PERFORM private.enqueue_delivery_email(_fulfillment_id, _tracking_version, 'out_for_delivery');
        END IF;
      END IF;
    END IF;
  ELSIF v_outcome = 'not_found' THEN
    -- 行5: 前の状況を保つ。登録から72時間たっても情報が無ければ要対応（登録前の作成時刻からは数えない）。
    -- 開くのは「新しい条件」の時だけ（P19）。次のどちらかの時:
    --   ・前の読み直しで情報があった（provider_status が残っている）＝情報あり→なしに変わった
    --   ・この登録の期間に、開いたまま、または店が手で閉じた「荷物が見つからない」が無い＝72時間を初めて越えた
    -- 店が手で閉じた後に、同じ not_found を6時間ごとに読んでも開き直さない
    IF v_r.registered_at IS NOT NULL AND pg_catalog.now() >= v_r.registered_at + interval '72 hours' THEN
      IF v_r.provider_status IS NOT NULL
         OR NOT EXISTS (
           SELECT 1
           FROM public.order_fulfillment_attention AS a
           WHERE a.fulfillment_id = _fulfillment_id
             AND a.kind = 'tracking_not_found'
             AND a.opened_at >= v_r.registered_at
             AND (a.resolved_at IS NULL OR a.resolution = 'manual')
         ) THEN
        PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', true);
      END IF;
    END IF;
  END IF;

  -- 行12: STOPPED の合図を持つ成功した読み直しの後で未配達なら、provider_stopped で止めて tracking_stalled。
  -- 合図の消費は読み直しを借りた時の番号まで（借りている間に新しい合図が来ていたら、次の読み直しで止める）
  IF NOT v_old AND v_r.stop_signaled AND NOT v_advanced THEN
    v_stop := true;
  END IF;

  UPDATE private.fulfillment_tracking_registrations AS r
  -- provider の記号は「17TRACK に情報があるか」の目印にもなる。ok は（古くなければ）書き、not_found は空にする
  SET provider_status = CASE
        WHEN v_outcome = 'ok' AND NOT v_old THEN v_provider_status
        WHEN v_outcome = 'not_found' THEN NULL
        ELSE r.provider_status
      END,
      provider_sub_status = CASE
        WHEN v_outcome = 'ok' AND NOT v_old THEN v_provider_sub
        WHEN v_outcome = 'not_found' THEN NULL
        ELSE r.provider_sub_status
      END,
      last_read_at = v_read_at,
      read_attempts = 0,
      last_error_code = NULL,
      next_run_at = CASE WHEN v_stop THEN r.next_run_at ELSE v_next END,
      lease_token = NULL,
      lease_expires_at = NULL,
      state = CASE WHEN v_stop THEN 'stopped' ELSE r.state END,
      stop_reason = CASE WHEN v_stop THEN 'provider_stopped' ELSE r.stop_reason END,
      stopped_at = CASE WHEN v_stop THEN pg_catalog.now() ELSE r.stopped_at END,
      stop_signaled = CASE WHEN v_stop THEN false ELSE r.stop_signaled END,
      provider_stop_pending = CASE WHEN v_stop THEN false ELSE r.provider_stop_pending END
  WHERE r.fulfillment_id = _fulfillment_id
    AND r.tracking_version = _tracking_version;

  IF v_stop THEN
    PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_stalled', true);
  END IF;

  RETURN QUERY SELECT true, v_changed, v_stop;
END;
$$;

-- 8. 期限切れ。追跡がオンの時、期限（expires_at）を迎えた止まっていない行を、注文 → 発送 → 登録の順に取って expired で止める。
--    一度でも登録できた行だけ tracking_stalled を開く（一度も登録できない行は止めるだけ）。借りている行は借りが終わるまで待つ。
CREATE OR REPLACE FUNCTION public.expire_delivery_tracking(_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_enabled boolean;
  v_candidate record;
  v_row private.fulfillment_tracking_registrations;
  v_count integer := 0;
  v_open boolean;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 1000 THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN 0;
  END IF;

  FOR v_candidate IN
    SELECT r.fulfillment_id AS candidate_fulfillment_id,
           r.tracking_version AS candidate_version,
           f.order_id AS candidate_order_id
    FROM private.fulfillment_tracking_registrations AS r
    JOIN public.order_fulfillments AS f ON f.id = r.fulfillment_id
    WHERE r.state <> 'stopped'
      AND r.expires_at <= pg_catalog.now()
      AND (r.lease_token IS NULL OR r.lease_expires_at <= pg_catalog.now())
    ORDER BY f.order_id, r.fulfillment_id, r.tracking_version
    LIMIT _limit
  LOOP
    PERFORM 1 FROM public.orders AS o WHERE o.id = v_candidate.candidate_order_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    PERFORM 1 FROM public.order_fulfillments AS f WHERE f.id = v_candidate.candidate_fulfillment_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT r.* INTO v_row
    FROM private.fulfillment_tracking_registrations AS r
    WHERE r.fulfillment_id = v_candidate.candidate_fulfillment_id
      AND r.tracking_version = v_candidate.candidate_version
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND
       OR v_row.state = 'stopped'
       OR v_row.expires_at > pg_catalog.now()
       OR (v_row.lease_token IS NOT NULL AND v_row.lease_expires_at > pg_catalog.now()) THEN
      CONTINUE;
    END IF;

    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'stopped',
        stop_reason = 'expired',
        stopped_at = pg_catalog.now(),
        failure_kind = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        stop_signaled = false,
        provider_stop_pending = false
    WHERE r.fulfillment_id = v_row.fulfillment_id
      AND r.tracking_version = v_row.tracking_version;
    v_count := v_count + 1;

    -- 配達済み・取消の発送には開かない（その場合は別の道で閉じている）
    IF v_row.ever_registered THEN
      SELECT f.delivered_at IS NULL AND f.cancelled_at IS NULL INTO v_open
      FROM public.order_fulfillments AS f
      WHERE f.id = v_row.fulfillment_id;
      IF COALESCE(v_open, false) THEN
        PERFORM private.set_delivery_attention(v_row.fulfillment_id, 'tracking_stalled', true);
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 9. 外への停止（stoptrack）の結果。成功でも失敗でも1回で pending を外し、借りを返す。失敗で管理操作は巻き戻さない。
--    借りの印・止めた行・印が合う時だけ true。
CREATE OR REPLACE FUNCTION public.record_delivery_stop_result(
  _fulfillment_id uuid,
  _tracking_version integer,
  _lease_token uuid,
  _succeeded boolean,
  _error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order_id uuid;
  v_r private.fulfillment_tracking_registrations;
BEGIN
  IF _fulfillment_id IS NULL OR _tracking_version IS NULL OR _tracking_version < 1 OR _lease_token IS NULL OR _succeeded IS NULL
     OR (_error_code IS NOT NULL AND _error_code !~ '^[a-z0-9_-]{1,64}$') THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;

  SELECT f.order_id INTO v_order_id FROM public.order_fulfillments AS f WHERE f.id = _fulfillment_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE;
  PERFORM 1 FROM public.order_fulfillments AS f WHERE f.id = _fulfillment_id FOR UPDATE;

  SELECT r.* INTO v_r
  FROM private.fulfillment_tracking_registrations AS r
  WHERE r.fulfillment_id = _fulfillment_id
    AND r.tracking_version = _tracking_version
  FOR UPDATE;
  IF NOT FOUND
     OR v_r.state <> 'stopped'
     OR NOT v_r.provider_stop_pending
     OR v_r.lease_token IS DISTINCT FROM _lease_token
     OR v_r.lease_expires_at IS NULL
     OR v_r.lease_expires_at <= pg_catalog.now() THEN
    RETURN false;
  END IF;

  UPDATE private.fulfillment_tracking_registrations AS r
  SET provider_stop_pending = false,
      provider_stop_attempted_at = pg_catalog.now(),
      last_error_code = CASE WHEN _succeeded THEN NULL ELSE _error_code END,
      lease_token = NULL,
      lease_expires_at = NULL
  WHERE r.fulfillment_id = _fulfillment_id
    AND r.tracking_version = _tracking_version;
  RETURN true;
END;
$$;

-- 10. 権限。public の関数は service_role だけ。private の補助は誰も直接呼べない（SECURITY DEFINER の関数の中だけで使う）
REVOKE ALL ON FUNCTION private.set_delivery_attention(uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.apply_tracking_status(uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.take_delivery_provider_slot() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.signal_delivery_tracking(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_delivery_tracking(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_delivery_registration_result(uuid, integer, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_delivery_read_result(uuid, integer, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_delivery_tracking(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_delivery_stop_result(uuid, integer, uuid, boolean, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.take_delivery_provider_slot() TO service_role;
GRANT EXECUTE ON FUNCTION public.signal_delivery_tracking(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_delivery_tracking(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_delivery_registration_result(uuid, integer, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_delivery_read_result(uuid, integer, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_delivery_tracking(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_delivery_stop_result(uuid, integer, uuid, boolean, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
