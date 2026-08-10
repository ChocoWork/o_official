-- ============================================================
-- 082: 取引の「要確認」を確認済みにする記録
--
-- 取引管理の状態（登録済み／要確認／訂正あり）は検知ルールから毎回導出しており、
-- 担当者が中身を確認して問題なしと判断しても「要確認」のまま残っていた。
-- 判断の記録をここに置き、理由ごとに1件ずつ解消できるようにする。
--
-- 取引 id ではなく entry_ref（文字列）で参照する理由:
--   オンライン注文の売上取引は admin_finance_expenses に行を持たず、
--   orders から毎回合成される（id は負の連番で永続しない）。
--   手入力の取引は 'entry:<id>'、注文由来は 'order:<注文ID>' で一意に指す。
--
-- 取引の内容は変えないので、訂正削除履歴（真実性の要件）とは別テーブルにする。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_finance_entry_review_acks (
  id bigserial PRIMARY KEY,
  -- 'entry:<admin_finance_expenses.id>' または 'order:<orders.id>'
  entry_ref text NOT NULL CHECK (entry_ref ~ '^(entry|order):.{1,120}$'),
  -- 要確認の理由。UI 側の EntryReviewReasonId と対応させる。
  reason text NOT NULL CHECK (reason IN ('duplicate', 'unknownAccount', 'unlinkedAsset')),
  -- 確認結果のメモ（任意）。後から根拠をたどれるようにする。
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (entry_ref, reason)
);

COMMENT ON TABLE public.admin_finance_entry_review_acks IS
  '取引の要確認理由を確認済みにした記録。全理由が確認済みになると状態が登録済みへ戻る。';

CREATE INDEX IF NOT EXISTS idx_admin_finance_entry_review_acks_ref
  ON public.admin_finance_entry_review_acks(entry_ref);

ALTER TABLE public.admin_finance_entry_review_acks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin finance entry review acks read"
  ON public.admin_finance_entry_review_acks;
CREATE POLICY "admin finance entry review acks read"
  ON public.admin_finance_entry_review_acks
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance entry review acks manage"
  ON public.admin_finance_entry_review_acks;
CREATE POLICY "admin finance entry review acks manage"
  ON public.admin_finance_entry_review_acks
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

COMMIT;
