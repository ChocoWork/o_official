-- 093_auth_user_lookup_and_token_hygiene.sql
-- パスワード再設定フローが必要とする2つの補助関数を置く。
--
-- auth スキーマは PostgREST に露出していないため、public 側に SECURITY DEFINER
-- 関数を置き service_role にだけ EXECUTE を与える（091 と同じ形）。
-- public の関数は /rest/v1/rpc/ に出るので、REVOKE を忘れると publishable key
-- （ブラウザに載る公開値）を持つ全員がメール→uuid のオラクルを叩けてしまう。
-- 092 が実測付きで潰したのと同種の穴を新設しないこと。

-- CREATE と REVOKE の間に PUBLIC EXECUTE の窓を作らないため、ファイル全体を
-- 1 トランザクションにする（psql -f は文ごとに autocommit するため明示が要る）。
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. メールアドレスから auth.users の id を1クエリで引く
-- ---------------------------------------------------------------------------
-- 従来は auth.admin.listUsers() で全件取ってから JS 側で線形探索していた。
-- ユーザーが増えるとページングが多段化する（perPage=200 で 200 件ごとに1往復）ため、
-- 索引を引く1クエリに置き換える。
--
-- GoTrue は email を小文字で保存するので lower(btrim()) 側だけ正規化すれば
-- users_email_partial_key（email 部分索引）に乗る。

CREATE OR REPLACE FUNCTION public.find_auth_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT u.id
  FROM auth.users u
  WHERE u.email = lower(btrim(p_email))
    AND u.deleted_at IS NULL
    -- SSO ユーザーはパスワードを持たないので再設定の対象外
    AND u.is_sso_user = false
    AND (u.banned_until IS NULL OR u.banned_until < now())
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.find_auth_user_id_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_auth_user_id_by_email(text) FROM anon;
REVOKE ALL ON FUNCTION public.find_auth_user_id_by_email(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.find_auth_user_id_by_email(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. 使い終わった再設定トークンの掃除
-- ---------------------------------------------------------------------------
-- password_reset_tokens はメールアドレスを持つため、無期限に貯めない。
-- audit_logs と同じく日次バッチから呼ぶ想定。
-- 期限切れ・使用済みのどちらも、猶予日数を過ぎたものだけ消す
-- （直近の行は調査のために残す）。
CREATE OR REPLACE FUNCTION public.cleanup_password_reset_tokens(p_retain_days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted integer;
  cutoff timestamptz := now() - make_interval(days => greatest(p_retain_days, 0));
BEGIN
  DELETE FROM public.password_reset_tokens
  WHERE created_at < cutoff
    AND (used = true OR expires_at < now());

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_password_reset_tokens(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_password_reset_tokens(integer) FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_password_reset_tokens(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_password_reset_tokens(integer) TO service_role;

-- 掃除と「同一メールの未使用トークンを一括無効化」が使う索引。
-- 046 の (email, expires_at DESC) は前者に効かない。
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email_used
  ON public.password_reset_tokens(email, used);

COMMIT;
