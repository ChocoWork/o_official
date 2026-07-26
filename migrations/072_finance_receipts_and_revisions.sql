-- ============================================================
-- 072: 証憑（電子取引データ）の保存と、訂正削除履歴
--
-- 電子帳簿保存法（2024/1〜 電子取引データの保存義務）への対応:
--   ・真実性の要件 … 訂正削除の履歴を残す（append-only の履歴テーブル＋トリガー）
--   ・可視性の要件 … 日付・金額・取引先で検索できる（FREQ-243 の複合フィルタ）
--   ・受領した電子データ（PDF請求書・領収書）は紙に出力して保存できないため、
--     ファイル自体を Storage に保持して取引行へ紐付ける
--
-- 取引の削除は物理削除ではなく論理削除（deleted_at）にする。
-- 物理削除すると履歴と証憑の紐付けが失われ、真実性の要件を満たせない。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) 取引の論理削除
-- ------------------------------------------------------------
ALTER TABLE public.admin_finance_expenses
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;
ALTER TABLE public.admin_finance_expenses
  ADD COLUMN IF NOT EXISTS deleted_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;
-- 訂正・削除を行った操作者。履歴トリガーがこの値を記録する。
ALTER TABLE public.admin_finance_expenses
  ADD COLUMN IF NOT EXISTS updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.admin_finance_expenses.deleted_at IS
  '論理削除日時。電子帳簿保存法の真実性の要件のため物理削除しない。';

-- 有効な取引の検索用（論理削除を除外した年度フィルタ）。
CREATE INDEX IF NOT EXISTS idx_admin_finance_expenses_active_year
  ON public.admin_finance_expenses(fiscal_year, expense_date DESC, id DESC)
  WHERE deleted_at IS NULL;

-- ------------------------------------------------------------
-- 2) 訂正削除履歴（append-only）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_finance_entry_revisions (
  id bigserial PRIMARY KEY,
  entry_id bigint NOT NULL,
  operation text NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  -- 変更前・変更後のスナップショット。insert は before が NULL。
  before_data jsonb NULL,
  after_data jsonb NULL,
  changed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_finance_entry_revisions_entry
  ON public.admin_finance_entry_revisions(entry_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_finance_entry_revisions_changed_at
  ON public.admin_finance_entry_revisions(changed_at DESC);

-- 履歴はアプリから直接書き換えさせない。トリガーだけが書き込む。
CREATE OR REPLACE FUNCTION public.record_admin_finance_entry_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
    VALUES (NEW.id, 'insert', NULL, to_jsonb(NEW), NEW.created_by);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- 論理削除は delete として記録する。
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      actor := COALESCE(NEW.deleted_by, NEW.updated_by);
      INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
      VALUES (NEW.id, 'delete', to_jsonb(OLD), to_jsonb(NEW), actor);
      RETURN NEW;
    END IF;

    -- 実質的な変更がない更新（updated_at のみ）は履歴に残さない。
    IF to_jsonb(OLD) - 'updated_at' = to_jsonb(NEW) - 'updated_at' THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
    VALUES (NEW.id, 'update', to_jsonb(OLD), to_jsonb(NEW), NEW.updated_by);
    RETURN NEW;
  END IF;

  -- 物理削除は運用上禁止だが、実行された場合も履歴には残す。
  INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
  VALUES (OLD.id, 'delete', to_jsonb(OLD), NULL, OLD.updated_by);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trigger_admin_finance_entry_revisions ON public.admin_finance_expenses;
CREATE TRIGGER trigger_admin_finance_entry_revisions
  AFTER INSERT OR UPDATE OR DELETE ON public.admin_finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.record_admin_finance_entry_revision();

ALTER TABLE public.admin_finance_entry_revisions ENABLE ROW LEVEL SECURITY;

-- 履歴は読み取り専用。書き込みポリシーを作らないことで改ざんを防ぐ
-- （トリガーは SECURITY DEFINER なので RLS を通らずに書き込める）。
DROP POLICY IF EXISTS "admin finance entry revisions read" ON public.admin_finance_entry_revisions;
CREATE POLICY "admin finance entry revisions read"
  ON public.admin_finance_entry_revisions
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

-- ------------------------------------------------------------
-- 3) 証憑ファイルのメタデータ
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_finance_receipts (
  id bigserial PRIMARY KEY,
  entry_id bigint NOT NULL
    REFERENCES public.admin_finance_expenses(id) ON DELETE CASCADE,
  -- Storage の finance-receipts バケット内のパス。
  storage_path text NOT NULL UNIQUE CHECK (char_length(storage_path) BETWEEN 1 AND 500),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 120),
  file_size integer NOT NULL CHECK (file_size > 0),
  uploaded_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_finance_receipts_entry
  ON public.admin_finance_receipts(entry_id, created_at DESC);

ALTER TABLE public.admin_finance_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin finance receipts read" ON public.admin_finance_receipts;
CREATE POLICY "admin finance receipts read"
  ON public.admin_finance_receipts
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance receipts manage" ON public.admin_finance_receipts;
CREATE POLICY "admin finance receipts manage"
  ON public.admin_finance_receipts
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

-- ------------------------------------------------------------
-- 4) 証憑用の非公開ストレージバケット
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('finance-receipts', 'finance-receipts', false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
