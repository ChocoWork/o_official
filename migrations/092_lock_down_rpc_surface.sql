-- 092_lock_down_rpc_surface.sql
-- PostgREST の RPC 面から、サーバー側（service_role）しか呼ぶ必要のない
-- SECURITY DEFINER 関数と未使用拡張を落とす。
--
-- 背景（実測）:
--   POST /rest/v1/rpc/http_get に publishable key（ブラウザに載る公開値）で
--   {"uri":"http://127.0.0.1:1/"} を投げたところ、DB が実際に外向き接続を試行し
--   500 XX000 "Failed to connect to 127.0.0.1 port 1" を返した。
--   つまり誰でもインターネットから DB を踏み台に任意 URL へ HTTP を送れる状態だった
--   （OWASP A10:2021 SSRF）。かつ http 拡張はこのプロジェクトで未使用。

-- CREATE と REVOKE の間に PUBLIC EXECUTE の窓を作らないため、ファイル全体を
-- 1 トランザクションにする（psql -f は文ごとに autocommit するため明示が要る）。
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 未使用の http 拡張を落とす（SSRF の直接原因）
-- ---------------------------------------------------------------------------
-- 将来必要になったら public ではなく extensions スキーマに入れ直すこと。
-- extensions スキーマは PostgREST に露出しないため RPC 到達性が生まれない。
--   CREATE EXTENSION http WITH SCHEMA extensions;

DROP EXTENSION IF EXISTS http;

-- ---------------------------------------------------------------------------
-- 2. service_role からしか呼ばれない関数の EXECUTE を剥がす
-- ---------------------------------------------------------------------------
-- 呼び出し元を全て確認済み:
--   increment_rate_limit_counter        features/auth/ratelimit が createServiceRoleClient から呼ぶ
--                                       （_ip を引数で受けるため、anon に開いていると
--                                         任意 IP のカウンタを焼いてアカウントロックアウトできた）
--   finalize_order_from_checkout_draft  checkout/complete と webhook/stripe が
--                                       SUPABASE_SERVICE_ROLE_KEY のクライアントから呼ぶ
--                                       （決済成立を検証せず _order_status を引数で受けるため、
--                                         anon に開いていると無認証で「支払い済み注文」を作れた）
--   create_profile_for_new_auth_user    トリガ関数。RPC 直呼びする理由がない
--   record_admin_finance_entry_revision トリガ関数。同上
--   *_guest_*                           src 全走査で参照ゼロ（ゲストカートは cart API が
--                                       service_role で直接テーブルを触る実装に移行済み）

REVOKE ALL ON FUNCTION public.increment_rate_limit_counter(inet, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_rate_limit_counter(inet, text, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.increment_rate_limit_counter(inet, text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_rate_limit_counter(inet, text, timestamptz, integer) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_order_from_checkout_draft(uuid, text, text, public.order_status, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_order_from_checkout_draft(uuid, text, text, public.order_status, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.create_profile_for_new_auth_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_profile_for_new_auth_user() TO service_role;

REVOKE ALL ON FUNCTION public.record_admin_finance_entry_revision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_admin_finance_entry_revision() TO service_role;

REVOKE ALL ON FUNCTION public.add_guest_cart_item(text, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_guest_cart_item(text, integer, integer, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.add_guest_wishlist_item(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_guest_wishlist_item(text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.delete_guest_cart_item(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_guest_cart_item(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.delete_guest_wishlist_item(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_guest_wishlist_item(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.list_guest_cart(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_guest_cart(text) TO service_role;

REVOKE ALL ON FUNCTION public.list_guest_wishlist(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_guest_wishlist(text) TO service_role;

REVOKE ALL ON FUNCTION public.update_guest_cart_item_quantity(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_guest_cart_item_quantity(text, uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. 意図的に触らない関数（advisor は警告するが剥がすと壊れる）
-- ---------------------------------------------------------------------------
--   has_permission(text)
--     約85本の RLS ポリシーが USING / WITH CHECK で使う。ポリシー式は問い合わせた
--     ロールの権限で評価されるため、authenticated / anon から EXECUTE を剥がすと
--     公開サイトとアカウント画面が全滅する。引数は権限コードのみで auth.uid() ベース、
--     返すのは「呼び出し元自身がその権限を持つか」の真偽だけなので開いていて問題ない。
--   delete_cart_item_secure(uuid, text)
--   update_cart_item_quantity_secure(uuid, text, integer)
--     src/app/api/cart/[id]/route.ts が createClient(req) 経由で呼ぶため、
--     未ログインのゲストは anon ロールとして実行する。

-- ---------------------------------------------------------------------------
-- 4. ログアウト時に Auth 側セッションを1件だけ終了させる RPC
-- ---------------------------------------------------------------------------
-- 公式の auth.admin.signOut は対象ユーザーの有効な JWT を要求するため、
-- access token が期限切れ／欠落だとセッション行が生き残り、流出済みの
-- refresh token がそのまま有効になってしまう。access token の有効性に
-- 依存しない経路として、JWT の session_id クレームで直接削除する。
-- auth.refresh_tokens.session_id は ON DELETE CASCADE なので追随して消える。
CREATE OR REPLACE FUNCTION public.revoke_auth_session(p_session_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM auth.sessions WHERE id = p_session_id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_auth_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_auth_session(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. 認可根拠から外れた MFA メタデータの掃除
-- ---------------------------------------------------------------------------
-- MFA 判定は JWT の aal クレーム（セッション単位）へ移行済み。
-- app_metadata のフラグはユーザー単位で永続するため、残すと将来の誤参照を招く。
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data - 'admin_mfa_verified' - 'mfa_verified'
-- jsonb の ? 演算子はドライバがプレースホルダと誤読しうるので jsonb_exists を使う
WHERE jsonb_exists(raw_app_meta_data, 'admin_mfa_verified')
   OR jsonb_exists(raw_app_meta_data, 'mfa_verified');

-- ---------------------------------------------------------------------------
-- 6. 091 の保証範囲の補足
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.is_auth_session_active(uuid) IS
  'JWT の session_id が auth.sessions に生存しているかを返す。実質的な保証は「明示的な削除（ログアウト・強制失効）の検出」。time-box / 無操作タイムアウトに達したセッションは即座には消えず24時間かけて掃除されるため、not_after 条件はそこまで強い保証を与えない。';

COMMIT;
