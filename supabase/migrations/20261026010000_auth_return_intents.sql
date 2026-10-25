-- 波 1-A ログインの戻り先の控え（SEC-AUTH-026 / SEC-AUTH-032、DATA-AUTH-005、ADR-0412）。
-- 表は private（PostgREST から見えない）。サーバー（service_role）は public の SECURITY DEFINER 関数 2 本だけで触る。
-- 関数を public に置く理由: supabase-js の rpc（PostgREST）で呼ぶため。公開の schema の SECURITY DEFINER 関数は
-- PUBLIC / anon / authenticated から EXECUTE を外し、service_role にだけ付ける（Database Advisor の lint 0028・0029）。
BEGIN;

-- 戻り先の控え。番号そのものは持たず sha256 のハッシュだけを持つ。
CREATE TABLE private.auth_return_intents (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  return_path text NOT NULL,
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  -- 消費時に記録。auth.users への外部キーは付けない（利用者を消しても履歴を消さない）。
  user_id uuid,
  CONSTRAINT auth_return_intents_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_return_intents_purpose_check CHECK (purpose IN ('login', 'signup')),
  CONSTRAINT auth_return_intents_return_path_check CHECK (
    pg_catalog.char_length(return_path) BETWEEN 1 AND 512
    AND return_path ~ '^/'
    AND return_path !~ '^//'
    AND return_path !~ '[\\[:space:][:cntrl:]]'
  ),
  CONSTRAINT auth_return_intents_expires_check CHECK (expires_at > created_at),
  CONSTRAINT auth_return_intents_consumed_check CHECK ((consumed_at IS NULL) = (user_id IS NULL))
);

ALTER TABLE private.auth_return_intents OWNER TO postgres;
CREATE INDEX auth_return_intents_expires_idx ON private.auth_return_intents (expires_at);
ALTER TABLE private.auth_return_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.auth_return_intents FROM PUBLIC, anon, authenticated, service_role;

-- 作る。期限は用途で決め、戻り値は Cookie の Max-Age にそのまま使う秒数。
-- 用途が login / signup 以外なら表の CHECK が 23514 で止める。
CREATE OR REPLACE FUNCTION public.create_auth_return_intent(_token_hash text, _return_path text, _purpose text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seconds integer;
BEGIN
  v_seconds := CASE _purpose WHEN 'login' THEN 900 ELSE 3600 END;
  INSERT INTO private.auth_return_intents (token_hash, return_path, purpose, expires_at)
  VALUES (_token_hash, _return_path, _purpose, pg_catalog.now() + pg_catalog.make_interval(secs => v_seconds));
  RETURN v_seconds;
END;
$$;

-- 1 回で使い切る。戻り値は return_path。使えなければ NULL（期限切れ・使用済み・別の用途・存在しない）。
-- STRICT: 引数のどれかが NULL なら本文を流さず NULL を返す（_user_id が NULL のまま consumed_at だけ入る 23514 を起こさない）。
CREATE OR REPLACE FUNCTION public.consume_auth_return_intent(_token_hash text, _purpose text, _user_id uuid)
RETURNS text
LANGUAGE sql
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE private.auth_return_intents
     SET consumed_at = pg_catalog.now(), user_id = _user_id
   WHERE token_hash = _token_hash AND purpose = _purpose
     AND consumed_at IS NULL AND expires_at > pg_catalog.now()
  RETURNING return_path
$$;

ALTER FUNCTION public.create_auth_return_intent(text, text, text) OWNER TO postgres;
ALTER FUNCTION public.consume_auth_return_intent(text, text, uuid) OWNER TO postgres;

-- 先例 20261022084844_order_status_links と同じく service_role からも一度外してから EXECUTE だけを付け直す。
REVOKE ALL ON FUNCTION public.create_auth_return_intent(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.consume_auth_return_intent(text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_auth_return_intent(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_auth_return_intent(text, text, uuid) TO service_role;

-- 掃除（毎日 03:20 UTC）。期限の 1 日後を過ぎた行を消す。pg_cron は 20260911235714 で入れ済み。
-- 同名のジョブは置き換わる（cron.schedule はジョブ名で upsert する）。cron スキーマへの grant は書かない。
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

SELECT cron.schedule(
  'auth-return-intents-cleanup',
  '20 3 * * *',
  $$ DELETE FROM private.auth_return_intents WHERE expires_at < pg_catalog.now() - interval '1 day' $$
);

-- AUTH_RETURN_INTENT_ASSERT_BEGIN
-- 末尾の確かめ。失敗は AUTH_RETURN_INTENT_ASSERTION_FAILED / 55000 で、DETAIL は項目名だけ。
DO $auth_return_intents_final$
DECLARE
  v_failed text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'private'
      AND c.relname = 'auth_return_intents'
      AND c.relkind = 'r'
      AND c.relowner = 'postgres'::regrole
      AND c.relrowsecurity
      AND (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attnum)
           FROM pg_catalog.pg_attribute AS a
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)
          = ARRAY['id', 'token_hash', 'return_path', 'purpose', 'created_at', 'expires_at', 'consumed_at', 'user_id']
      AND NOT pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS x
                      WHERE x.grantee = 0)
  ) THEN
    v_failed := 'auth_return_intents_table';
  ELSIF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.create_auth_return_intent(text,text,text)', false, 'plpgsql', 'integer'),
      ('public.consume_auth_return_intent(text,text,uuid)', true, 'sql', 'text')
    ) AS e(sig, strict, lang, ret)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(e.sig)
    WHERE p.oid IS NULL
       OR p.proowner <> 'postgres'::regrole
       OR NOT p.prosecdef
       OR p.proisstrict <> e.strict
       OR p.proretset
       OR p.prolang <> (SELECT l.oid FROM pg_catalog.pg_language AS l WHERE l.lanname = e.lang)
       OR p.prorettype <> e.ret::regtype::oid
       OR NOT ('search_path=""' = ANY (COALESCE(p.proconfig, ARRAY[]::text[])))
       OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS x
                  WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
  ) OR (
    -- この名前の関数は 2 本だけ（オーバーロードを残さない）
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private')
      AND p.proname IN ('create_auth_return_intent', 'consume_auth_return_intent')
  ) <> 2 THEN
    v_failed := 'auth_return_intents_functions';
  ELSIF NOT EXISTS (
    SELECT 1 FROM cron.job AS j
    WHERE j.jobname = 'auth-return-intents-cleanup'
      AND j.schedule = '20 3 * * *'
      AND j.command LIKE '%private.auth_return_intents%'
  ) THEN
    v_failed := 'auth_return_intents_cleanup_job';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'AUTH_RETURN_INTENT_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$auth_return_intents_final$;
-- AUTH_RETURN_INTENT_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
