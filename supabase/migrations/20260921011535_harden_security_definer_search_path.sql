-- SECURITY DEFINER 関数の search_path を固め、anon から has_permission を外す（FREQ-390、優先度低の指摘⑪の残り）
--
-- 1. 一時スキーマの取り違えを塞ぐ
--    PostgreSQL は search_path に pg_temp が書かれていないと、テーブル・ビュー・型の解決で
--    一時スキーマを「先頭より前」に見る。SECURITY DEFINER の関数は所有者（postgres）の権限で
--    動くので、中で参照する public.xxx が一時テーブルに置き換わると所有者権限で読み書きしてしまう
--    （PostgreSQL 公式「Writing SECURITY DEFINER Functions Safely」。公式の勧めは
--    pg_temp を最後に書いて一時スキーマを最後に探させること）。
--
--    本番の public スキーマは anon / authenticated / authenticator / service_role のいずれにも
--    CREATE を与えていない（実測: has_schema_privilege はすべて false）。PostgREST 越しに
--    CREATE TEMP TABLE を撃つ手段も無いので、いま踏める経路は無い。将来の権限変更に備えた
--    多層防御として入れる。ALTER FUNCTION ... SET なので関数本体もオーナーも権限も変えない。
--
--    search_path = '' の7本（claim_order_email / release_order_email / find_auth_user_id_by_email /
--    is_auth_session_active / revoke_auth_session / revoke_auth_sessions_for_user /
--    cleanup_password_reset_tokens）と、既に pg_temp を最後に持つ create_profile_for_new_auth_user は
--    対象外。
--
-- 2. anon から has_permission の実行権限を外す
--    Supabase のリンター（0028 anon_security_definer_function_executable）が
--    「anon が /rest/v1/rpc/has_permission から SECURITY DEFINER 関数を実行できる」と警告していた。
--    この関数を参照する RLS ポリシーは本番の実測で全部 authenticated 向けなので、
--    anon の EXECUTE を外してもポリシーは壊れない。authenticated と service_role は残す。

BEGIN;

-- private スキーマ
ALTER FUNCTION "private"."record_order_revision"()
  SET search_path = pg_catalog, public, pg_temp;

ALTER FUNCTION "private"."set_request_context"()
  SET search_path = pg_catalog, public, private, pg_temp;

-- public スキーマ（search_path = public, pg_catalog）
ALTER FUNCTION "public"."apply_stock_movement"()
  SET search_path = public, pg_catalog, pg_temp;

ALTER FUNCTION "public"."backfill_item_variants"(target_item_id bigint)
  SET search_path = public, pg_catalog, pg_temp;

ALTER FUNCTION "public"."verify_stock_integrity"()
  SET search_path = public, pg_catalog, pg_temp;

-- public スキーマ（search_path = public）
ALTER FUNCTION "public"."add_guest_cart_item"(p_session_id text, p_item_id integer, p_quantity integer, p_color text, p_size text)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."add_guest_wishlist_item"(p_session_id text, p_item_id integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."delete_cart_item_secure"(_cart_id uuid, _session_id text)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."delete_guest_cart_item"(p_session_id text, p_cart_id uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."delete_guest_wishlist_item"(p_session_id text, p_wishlist_id uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."finalize_order_from_checkout_draft"(_draft_id uuid, _payment_intent_id text, _checkout_session_id text, _order_status public.order_status, _expected_total_amount integer, _currency text)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."has_permission"(permission_code text)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."increment_rate_limit_counter"(_ip inet, _endpoint text, _bucket timestamp with time zone)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."increment_rate_limit_counter"(_ip inet, _endpoint text, _bucket timestamp with time zone, _increment integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."list_guest_cart"(p_session_id text)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."list_guest_wishlist"(p_session_id text)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."record_admin_finance_entry_revision"()
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."release_stock_for_unpaid_order"(_payment_intent_id text, _next_status public.order_status)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."update_cart_item_quantity_secure"(_cart_id uuid, _session_id text, _quantity integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION "public"."update_guest_cart_item_quantity"(p_session_id text, p_cart_id uuid, p_quantity integer)
  SET search_path = public, pg_temp;

-- anon からは呼ばせない（RLS ポリシーは authenticated 向けだけなので壊れない）
REVOKE EXECUTE ON FUNCTION "public"."has_permission"(text) FROM "anon";

COMMIT;
