-- 091_auth_session_revocation.sql
-- 管理 API の認可でセッション失効を確認できるようにする。
--
-- access token は ES256 でローカル検証できるが、署名が正しいことと
-- セッションがまだ生きていることは別問題。ログアウト済み・強制失効済みの
-- トークンを exp まで通してしまわないよう、auth.sessions を照合する。
--   https://supabase.com/docs/guides/auth/sessions
--     "You can check that the session_id claim in the JWT corresponds to a row
--      in the auth.sessions table."
--
-- auth スキーマは PostgREST に露出していないため、public 側に SECURITY DEFINER
-- 関数を置き、service_role にだけ EXECUTE を与える。

-- JWT の session_id クレームに対応するセッションが有効かを返す。
-- not_after は time-box セッションの期限。NULL なら無期限。
CREATE OR REPLACE FUNCTION public.is_auth_session_active(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.sessions s
    WHERE s.id = p_session_id
      AND (s.not_after IS NULL OR s.not_after > now())
  );
$$;

REVOKE ALL ON FUNCTION public.is_auth_session_active(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_auth_session_active(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.is_auth_session_active(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.is_auth_session_active(uuid) TO service_role;

-- 管理者による他ユーザーの強制ログアウト用。
-- GoTrue の auth.admin.signOut は対象ユーザーの JWT を要求するため、
-- 管理者側からは呼べない。auth.sessions の行削除が唯一の経路。
-- auth.refresh_tokens.session_id は ON DELETE CASCADE なので追随して消える。
CREATE OR REPLACE FUNCTION public.revoke_auth_sessions_for_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_auth_sessions_for_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_auth_sessions_for_user(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.revoke_auth_sessions_for_user(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_auth_sessions_for_user(uuid) TO service_role;
