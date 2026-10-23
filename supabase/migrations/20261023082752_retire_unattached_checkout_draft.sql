-- K-5（開店前の直し 波2）: Stripe が決済の画面を作れなかった時、画面の番号の無い下書きを片付ける。
-- 下書きを failed にすると、押し直しの claim_checkout_draft は新しい下書き（新しい番号）を作るので、
-- 新しい重複防止キーで決済の画面をすぐ作り直せる（約15秒待たずに済む）。
-- 画面の番号の入った下書き（作った後）・別の見分けの値・別の session の下書きは変えない。
-- 列の型と権限の形は retire_expired_checkout_draft（20260925000132）と claim_checkout_draft（20261008220944）に合わせる。
BEGIN;

CREATE OR REPLACE FUNCTION public.retire_unattached_checkout_draft(
  _draft_id uuid,
  _session_id text,
  _request_version smallint,
  _request_fingerprint text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  changed boolean;
BEGIN
  IF _draft_id IS NULL
     OR _session_id IS NULL
     OR _request_version IS NULL
     OR _request_fingerprint IS NULL THEN
    RAISE EXCEPTION 'INVALID_UNATTACHED_DRAFT_RETIREMENT'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.checkout_drafts AS d
  SET status = 'failed'
  WHERE d.id = _draft_id
    AND d.session_id = _session_id
    AND d.checkout_session_id IS NULL
    AND d.status = 'created'
    AND d.checkout_request_version = _request_version
    AND d.checkout_request_fingerprint = _request_fingerprint;

  changed := FOUND;
  RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION public.retire_unattached_checkout_draft(
  uuid, text, smallint, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.retire_unattached_checkout_draft(
  uuid, text, smallint, text
) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
