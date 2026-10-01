-- 古い注文 RPC を消す（グループ A 設計書 4-7）。
--
-- 呼び出し元はすべて新しい RPC へ切り替えた（Webhook・完了 API・見回り・管理画面の取消）。
-- 同名の関数を並べると PostgREST が呼び分けられないこともある（PGRST203）ので、重複させない。
-- 本番アプリは未公開なので古い定義を残す必要が無い（2026-09-27 承認）。公開後に同じ変更をするときは
-- 広げる → 移す → 縮めるの3段階（Parallel Change）で行う。

BEGIN;

DROP FUNCTION IF EXISTS public.finalize_order_from_checkout_draft(
  uuid, text, text, public.order_status, integer, text
);
DROP FUNCTION IF EXISTS public.release_stock_for_unpaid_order(text, public.order_status);
DROP FUNCTION IF EXISTS public.admin_cancel_failed_order(uuid, uuid);

COMMIT;
