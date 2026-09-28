-- 注文の状態に「支払い手続き中」と「放棄」を加える（グループ A 設計書 4-2・4-8）。
--
-- Postgres では、追加した enum の値はそのトランザクションをコミットするまで使えない。
-- 値を使う関数とは別のファイルに分ける。enum の値は後から消せない（Supabase: Managing Enums）。

BEGIN;

ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'payment_in_progress' BEFORE 'pending';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'abandoned' AFTER 'failed';

COMMIT;
