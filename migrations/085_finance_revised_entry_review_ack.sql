-- 法人の訂正後確認を、既存の理由別確認記録へ保存できるようにする。
BEGIN;

ALTER TABLE public.admin_finance_entry_review_acks
  DROP CONSTRAINT IF EXISTS admin_finance_entry_review_acks_reason_check;

ALTER TABLE public.admin_finance_entry_review_acks
  ADD CONSTRAINT admin_finance_entry_review_acks_reason_check
  CHECK (reason IN ('duplicate', 'unknownAccount', 'unlinkedAsset', 'revisedEntry'));

COMMIT;
