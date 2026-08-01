-- ============================================================
-- 073: 固定資産台帳と購入取引の連携
--
-- 取得仕訳は取引（admin_finance_expenses）からしか生まれず、
-- 減価償却仕訳は台帳（admin_finance_fixed_assets）からしか生まれない。
-- 両者に紐付けがないと次の事故が起きる:
--   ・取引だけ登録 … 資産科目に計上されたまま永久に償却されない
--   ・台帳だけ登録 … 償却の貸方だけ立ち、元帳の資産残高がマイナスになる
--   ・両方登録して金額が違う … 取得価額と資産科目残高が食い違い BS が合わない
--
-- そこで取引を単一の入口にする。台帳は償却条件（耐用年数・償却方法・
-- 事業専用割合・使用開始日）を足す場所であり、金額・取得日は取引が持つ。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) 固定資産 → 購入取引 の連携
-- ------------------------------------------------------------
ALTER TABLE public.admin_finance_fixed_assets
  ADD COLUMN IF NOT EXISTS entry_id bigint NULL
    REFERENCES public.admin_finance_expenses(id) ON DELETE SET NULL;

-- 事業供用日。償却は取得日ではなくこの日から始まる（国税庁 No.2100）。
-- NULL は取得日と同じ扱い。既存行の償却結果を変えないための既定値。
ALTER TABLE public.admin_finance_fixed_assets
  ADD COLUMN IF NOT EXISTS service_started_on date NULL;

COMMENT ON COLUMN public.admin_finance_fixed_assets.entry_id IS
  '取得の元になった購入取引。NULL は直接登録（期首残高の移行・過去資産・現物発見）。';
COMMENT ON COLUMN public.admin_finance_fixed_assets.service_started_on IS
  '事業供用日。NULL は取得日と同じ。減価償却の月割の起点。';

-- 1つの取引から2つの資産を作らせない（二重計上の物理的な防止）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_finance_fixed_assets_entry
  ON public.admin_finance_fixed_assets(entry_id)
  WHERE entry_id IS NOT NULL;

-- 供用日は取得日以降。ADD CONSTRAINT に IF NOT EXISTS がないため存在確認する。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.admin_finance_fixed_assets'::regclass
      AND conname = 'admin_finance_fixed_assets_service_after_acquisition'
  ) THEN
    ALTER TABLE public.admin_finance_fixed_assets
      ADD CONSTRAINT admin_finance_fixed_assets_service_after_acquisition
      CHECK (service_started_on IS NULL OR service_started_on >= acquired_on);
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2) 固定資産候補から明示的に除外した取引
-- ------------------------------------------------------------
-- 10万円以上の消耗品費などを「このまま費用として処理」と判断した印。
-- 取引内容ではなく確認作業の状態なので、訂正履歴には残さない（3 を参照）。
ALTER TABLE public.admin_finance_expenses
  ADD COLUMN IF NOT EXISTS fixed_asset_exempt boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.admin_finance_expenses.fixed_asset_exempt IS
  '固定資産候補の確認を済ませ、費用として処理すると判断した取引。確認キューから外れる。';

-- ------------------------------------------------------------
-- 3) 訂正履歴トリガーの調整
-- ------------------------------------------------------------
-- 072 の判定は updated_at 以外に差分があれば update（＝訂正）として記録する。
-- fixed_asset_exempt は取引の内容ではなく作業マーカーなので、これを訂正として
-- 記録すると一覧に偽の「訂正あり」バッジが立つ。無変更判定から除外する。
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

    -- 実質的な変更がない更新（updated_at・固定資産候補の確認状態のみ）は履歴に残さない。
    IF to_jsonb(OLD) - 'updated_at' - 'fixed_asset_exempt'
       = to_jsonb(NEW) - 'updated_at' - 'fixed_asset_exempt' THEN
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

COMMIT;
