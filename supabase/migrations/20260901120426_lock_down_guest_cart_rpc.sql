-- ゲストカートの SECURITY DEFINER 関数を PostgREST の RPC 面から外す。
--
-- 背景:
--   delete_cart_item_secure / update_cart_item_quantity_secure は所有権の判定を
--   「引数 _session_id と carts.session_id の一致」だけで行う。session_id は
--   128bit ランダムの httpOnly Cookie なので推測は非現実的であり IDOR ではない。
--
--   問題は到達経路。anon に EXECUTE が開いていると /rest/v1/rpc/ から直接叩けるため、
--   src/app/api/cart/[id]/route.ts が持つ次の制御をすべて素通りできる。
--     - レート制限（enforceRateLimit。IP 単位とセッション単位の2段）
--     - 監査ログ（logAudit）
--     - proxy.ts の Origin 検査
--   強制点がアプリの外にも存在する状態そのものを畳む。
--
--   092 は「ゲストは anon ロールとして実行するため」剥がせないと判断していたが、
--   カート API を service role 経由に切り替えたのでその前提が消えた。
--
-- 関数側の session_id 一致チェックは残す（多層防御）。service role で呼んでも
-- 他人のカート行は触れない。

BEGIN;

REVOKE ALL ON FUNCTION public.delete_cart_item_secure(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_cart_item_secure(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.update_cart_item_quantity_secure(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_cart_item_quantity_secure(uuid, text, integer) TO service_role;

-- has_permission(text) は意図的に触らない。
-- 139 本の RLS ポリシーが USING / WITH CHECK で使い、ポリシー式は問い合わせたロールの
-- 権限で評価されるため、anon / authenticated から剥がすと公開サイトが全滅する。
-- 引数は権限コードのみ、判定は auth.uid() ベース、返すのは「呼び出し元自身がその権限を
-- 持つか」の真偽だけなので開いていて問題ない（092 の判断を維持）。

COMMIT;
