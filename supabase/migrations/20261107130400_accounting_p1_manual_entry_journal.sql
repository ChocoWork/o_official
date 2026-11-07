BEGIN;
-- Accounting plan 1 S4 (FREQ-556 AC-01..AC-06): a manual transaction (public.admin_finance_expenses, written by the
-- existing route src/app/api/admin/kpi/cost-profit/route.ts through service_role; its write shape does not change)
-- becomes a saved journal entry through triggers, and the transaction rows and their revision history can no longer
-- be removed or rewritten.
--
-- Objects (all owned by postgres):
--   public.accounting_manual_category_map  account name -> account code (append only; rows below)
--   public.accounting_manual_method_map    payment method x direction x business type -> funds account code (append
--                                          only; rows below)
--   private.accounting_manual_entry_after_write()  AFTER INSERT OR UPDATE on admin_finance_expenses (ordinary, so a
--     replica-mode data-only restore does not post entries again)
--   private.accounting_guard_entry_revision()      BEFORE UPDATE OR DELETE on admin_finance_entry_revisions (ALWAYS)
--   reject triggers (private.reject_accounting_mutation, ALWAYS): DELETE and TRUNCATE of admin_finance_expenses,
--     TRUNCATE of admin_finance_entry_revisions, UPDATE / DELETE / TRUNCATE of the two map tables.
-- The rows between ACC_MANUAL_MAP_BEGIN/END are the output of scripts/accounting/emit-manual-account-map.ts.
--
-- What the journal trigger does (the same lines as toLines in src/lib/finance/journal.ts):
--   accounts: the counter account is the category map row of category, else 9999; the funds account is the method map
--     row of (payment_method, entry_type, business type of the chosen period), else the category map row of
--     payment_method (paymentMethodAccountName returns an unknown method unchanged), else 9999. A 9999 line keeps the
--     original text (category or payment_method, at most 80 characters by the table CHECK) in its memo.
--   expense: debit counter / credit funds; income: debit funds / credit counter; amount, partner as counterparty (NULL
--     when empty) on both lines, item_name as the description, the date expense_date.
--   period: private.accounting_period_for_event(expense_date, actor) (S3, the only rule). PERIOD_MISSING and the other
--     refusals propagate, so the transaction row is not written either.
--   INSERT: kind manual_entry, parts [id, n], recorded_by created_by (nothing for a row inserted with deleted_at set).
--   UPDATE: runs only when expense_date, category, item_name, partner, amount, payment_method, entry_type or deleted_at
--     changes (created_by / updated_by / deleted_by alone, as from ON DELETE SET NULL, do nothing and take no lock).
--     The open entry of the row (source admin_finance_expenses / id, not a reversal, not reversed) is reversed by
--     private.accounting_reverse_journal_core on its own day: reason delete with actor coalesce(deleted_by, created_by)
--     when NEW.deleted_at is set (then no new entry is added, also when the row was deleted before), otherwise reason
--     edit with actor coalesce(updated_by, created_by) followed by the correct entry, parts [id, n], recorded_by
--     coalesce(updated_by, created_by). A row with no entry yet is posted as an INSERT would be.
--   n is the number of manual_entry entries of the row (reversal and migrated_entry are not counted), so the first
--     entry is 0 and the first edit after the A8 migration (S5) is also 0.
--   locks: (190521,1) -> (190525,0) first, then (190525, hashtext(period)) once the period is known
--     (private.accounting_lock_all). The trigger runs after the row write, so it takes them after the row lock; no
--     function holding the group G lock writes admin_finance_expenses (FREQ-556-AC-04 test).
--   history: the existing trigger trigger_admin_finance_entry_revisions is not changed; reversals write nothing to
--     admin_finance_entry_revisions.
-- admin_finance_entry_revisions accepts one UPDATE only: changed_by from a value to NULL with every other column
-- unchanged (auth.users deletion, ON DELETE SET NULL).
-- public.record_admin_finance_entry_revision() (remote_schema.sql:1958-1996) is replaced with the same body plus one
-- rule (FREQ-556-AC-06): an UPDATE that only clears actor columns (created_by / updated_by / deleted_by set to NULL,
-- which is what ON DELETE SET NULL does when a user is deleted) adds no revision. Before, that update inserted a
-- revision with changed_by = updated_by, so deleting a user who created and last edited a transaction failed on the
-- revisions foreign key (23503, measured 2026-11-07). No revision instead of a changed_by NULL revision, because a
-- revision records a content change made by someone (the trigger already skips updates that change only updated_at
-- or the fixed-asset review columns), and the legacy revision counts (A8, the journal read) must not grow when a
-- user is removed. Any other change, including an actor column set to another user, writes a revision as before.
-- The function stays SECURITY DEFINER, owner postgres, with its ACL; its search_path becomes '' (fully qualified).
--
-- ROLLBACK of the history function: CREATE OR REPLACE it with the remote_schema.sql body and
--   ALTER FUNCTION public.record_admin_finance_entry_revision() SET search_path = public, pg_temp;
--
-- ROLLBACK (only while no manual entry exists; journal entries cannot be removed once written):
--   DROP TRIGGER accounting_manual_entry_journal, accounting_manual_entry_no_delete, accounting_manual_entry_no_truncate
--     ON public.admin_finance_expenses;
--   DROP TRIGGER accounting_entry_revisions_guard, accounting_entry_revisions_no_truncate
--     ON public.admin_finance_entry_revisions;
--   DROP FUNCTION private.accounting_manual_entry_after_write(), private.accounting_guard_entry_revision();
--   DROP TABLE public.accounting_manual_method_map, public.accounting_manual_category_map;

-- ACC_S4_BODY_BEGIN

-- 0. The baseline the final assert compares with: the existing triggers of the two tables and their functions as they
--    are before this migration (the body and settings of the history function, which section 6 replaces, are left
--    out and checked on their own). A replay of the assert (tests) runs the same statement on the current state first.
-- ACC_S4_BASELINE_BEGIN
CREATE TEMP TABLE accounting_s4_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s4_baseline(payload)
SELECT pg_catalog.jsonb_build_object('legacy', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'table', c.relname::text, 'name', t.tgname::text, 'type', t.tgtype, 'enabled', t.tgenabled::text,
    'function', n.nspname::text || '.' || f.proname::text, 'args', pg_catalog.encode(t.tgargs, 'hex'),
    'attr', t.tgattr::text, 'when', t.tgqual IS NOT NULL, 'constraint', t.tgconstraint <> 0,
    'body_md5', CASE WHEN f.proname = 'record_admin_finance_entry_revision' THEN NULL
      ELSE pg_catalog.md5(pg_catalog.replace(f.prosrc, E'\r', '')) END, 'definer', f.prosecdef,
    'config', CASE WHEN f.proname = 'record_admin_finance_entry_revision' THEN NULL ELSE f.proconfig END,
    'owner', f.proowner::regrole::text) ORDER BY c.relname::text COLLATE "C", t.tgname::text COLLATE "C")
  FROM pg_catalog.pg_trigger AS t
  JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_proc AS f ON f.oid = t.tgfoid
  JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
  WHERE c.oid IN (pg_catalog.to_regclass('public.admin_finance_expenses'),
      pg_catalog.to_regclass('public.admin_finance_entry_revisions'))
    AND NOT t.tgisinternal AND t.tgname !~ '^accounting_'), '[]'::jsonb));
-- ACC_S4_BASELINE_END

-- 1. The two map tables (FREQ-556-AC-01, AC-03). Append only; service_role reads only.
CREATE TABLE public.accounting_manual_category_map (
  source_text text NOT NULL,
  account_code text NOT NULL,
  CONSTRAINT accounting_manual_category_map_pkey PRIMARY KEY (source_text),
  CONSTRAINT accounting_manual_category_map_account_code_fkey FOREIGN KEY (account_code)
    REFERENCES public.accounting_accounts (code) ON DELETE RESTRICT
);
CREATE TABLE public.accounting_manual_method_map (
  source_text text NOT NULL,
  direction text NOT NULL,
  business_type text NOT NULL,
  account_code text NOT NULL,
  CONSTRAINT accounting_manual_method_map_pkey PRIMARY KEY (source_text, direction, business_type),
  CONSTRAINT accounting_manual_method_map_direction_check CHECK (direction IN ('expense', 'income')),
  CONSTRAINT accounting_manual_method_map_business_type_check CHECK (business_type IN ('soleProprietor', 'corporation')),
  CONSTRAINT accounting_manual_method_map_account_code_fkey FOREIGN KEY (account_code)
    REFERENCES public.accounting_accounts (code) ON DELETE RESTRICT
);
ALTER TABLE public.accounting_manual_category_map OWNER TO postgres;
ALTER TABLE public.accounting_manual_method_map OWNER TO postgres;
ALTER TABLE public.accounting_manual_category_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_manual_method_map ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_manual_category_map, public.accounting_manual_method_map
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.accounting_manual_category_map, public.accounting_manual_method_map TO service_role;

-- ACC_MANUAL_MAP_BEGIN
INSERT INTO public.accounting_manual_category_map (source_text,account_code) VALUES
  (U&'\73FE\91D1','1010'),
  (U&'\5C0F\53E3\73FE\91D1','1020'),
  (U&'\5F53\5EA7\9810\91D1','1030'),
  (U&'\666E\901A\9810\91D1','1040'),
  (U&'\5B9A\671F\9810\91D1','1050'),
  (U&'\5B9A\671F\7A4D\91D1','1060'),
  (U&'\305D\306E\4ED6\306E\9810\91D1','1070'),
  (U&'\96FB\5B50\30DE\30CD\30FC','1080'),
  (U&'\53D7\53D6\624B\5F62','1110'),
  (U&'\58F2\639B\91D1','1120'),
  (U&'\30AF\30EC\30B8\30C3\30C8\58F2\639B\91D1','1130'),
  (U&'\96FB\5B50\8A18\9332\50B5\6A29','1140'),
  (U&'Stripe\5165\91D1\9014\4E0A','1150'),
  (U&'Stripe\672A\53CE\91D1','1160'),
  (U&'\6709\4FA1\8A3C\5238','1210'),
  (U&'\5546\54C1','1310'),
  (U&'\88FD\54C1','1320'),
  (U&'\6750\6599','1330'),
  (U&'\4ED5\639B\54C1','1340'),
  (U&'\8CAF\8535\54C1','1350'),
  (U&'\524D\6255\91D1','1410'),
  (U&'\524D\6255\8CBB\7528','1420'),
  (U&'\672A\53CE\91D1','1430'),
  (U&'\672A\53CE\8CC3\8CB8\6599','1440'),
  (U&'\8CB8\4ED8\91D1','1450'),
  (U&'\7ACB\66FF\91D1','1460'),
  (U&'\4EEE\6255\91D1','1470'),
  (U&'\4EEE\6255\6D88\8CBB\7A0E','1480'),
  (U&'\672A\53CE\9084\4ED8\6CD5\4EBA\7A0E\7B49','1490'),
  (U&'\5EFA\7269','1510'),
  (U&'\9644\5C5E\8A2D\5099','1515'),
  (U&'\69CB\7BC9\7269','1520'),
  (U&'\6A5F\68B0\88C5\7F6E','1525'),
  (U&'\8ECA\4E21\904B\642C\5177','1530'),
  (U&'\5DE5\5177\5668\5177\5099\54C1','1535'),
  (U&'\8239\8236','1540'),
  (U&'\822A\7A7A\6A5F','1545'),
  (U&'\4E00\62EC\511F\5374\8CC7\7523','1550'),
  (U&'\5C11\984D\6E1B\4FA1\511F\5374\8CC7\7523','1555'),
  (U&'\571F\5730','1560'),
  (U&'\5EFA\8A2D\4EEE\52D8\5B9A','1570'),
  (U&'\6E1B\4FA1\511F\5374\7D2F\8A08\984D','1590'),
  (U&'\30BD\30D5\30C8\30A6\30A7\30A2','1610'),
  (U&'\30BD\30D5\30C8\30A6\30A7\30A2\4EEE\52D8\5B9A','1615'),
  (U&'\5546\6A19\6A29','1620'),
  (U&'\610F\5320\6A29','1625'),
  (U&'\7279\8A31\6A29','1630'),
  (U&'\5B9F\7528\65B0\6848\6A29','1635'),
  (U&'\306E\308C\3093','1640'),
  (U&'\96FB\8A71\52A0\5165\6A29','1650'),
  (U&'\501F\5730\6A29','1660'),
  (U&'\516C\5171\65BD\8A2D\8CA0\62C5\91D1','1670'),
  (U&'\65BD\8A2D\5229\7528\6A29','1680'),
  (U&'\5DEE\5165\4FDD\8A3C\91D1','1710'),
  (U&'\6577\91D1','1715'),
  (U&'\9810\8A17\91D1','1720'),
  (U&'\51FA\8CC7\91D1','1730'),
  (U&'\4FDD\967A\7A4D\7ACB\91D1','1740'),
  (U&'\9577\671F\8CB8\4ED8\91D1','1750'),
  (U&'\9577\671F\524D\6255\8CBB\7528','1760'),
  (U&'\6295\8CC7\6709\4FA1\8A3C\5238','1770'),
  (U&'\958B\696D\8CBB','1810'),
  (U&'\5275\7ACB\8CBB','1820'),
  (U&'\958B\767A\8CBB','1830'),
  (U&'\682A\5F0F\4EA4\4ED8\8CBB','1840'),
  (U&'\4E8B\696D\4E3B\8CB8','1910'),
  (U&'\8CC7\7523\8B72\6E21\640D','1920'),
  (U&'\672A\78BA\5B9A\52D8\5B9A','1990'),
  (U&'\652F\6255\624B\5F62','2010'),
  (U&'\8CB7\639B\91D1','2020'),
  (U&'\96FB\5B50\8A18\9332\50B5\52D9','2030'),
  (U&'\77ED\671F\501F\5165\91D1','2110'),
  (U&'\5F79\54E1\501F\5165\91D1','2120'),
  (U&'\672A\6255\91D1','2130'),
  (U&'\672A\6255\8CBB\7528','2140'),
  (U&'\524D\53D7\91D1','2150'),
  (U&'\9810\308A\91D1','2160'),
  (U&'\4EEE\53D7\91D1','2170'),
  (U&'\4EEE\53D7\6D88\8CBB\7A0E','2180'),
  (U&'\672A\6255\6D88\8CBB\7A0E','2190'),
  (U&'\672A\6255\6CD5\4EBA\7A0E\7B49','2200'),
  (U&'\672A\6255\914D\5F53\91D1','2210'),
  (U&'\53D7\5165\4FDD\8A3C\91D1\30FB\6577\91D1','2220'),
  (U&'\5546\54C1\5238','2230'),
  (U&'\524D\53D7\53CE\76CA','2240'),
  (U&'\8CDE\4E0E\5F15\5F53\91D1','2250'),
  (U&'\8CB8\5012\5F15\5F53\91D1','2260'),
  (U&'\9577\671F\501F\5165\91D1','2510'),
  (U&'\793E\50B5','2520'),
  (U&'\9000\8077\7D66\4ED8\5F15\5F53\91D1','2530'),
  (U&'\9577\671F\672A\6255\91D1','2540'),
  (U&'\5143\5165\91D1','2910'),
  (U&'\4E8B\696D\4E3B\501F','2920'),
  (U&'\8CC7\672C\91D1','3010'),
  (U&'\8CC7\672C\6E96\5099\91D1','3020'),
  (U&'\5229\76CA\6E96\5099\91D1','3030'),
  (U&'\7E70\8D8A\5229\76CA\5270\4F59\91D1','3040'),
  (U&'\81EA\5DF1\682A\5F0F','3050'),
  (U&'\58F2\4E0A\9AD8','4010'),
  (U&'\58F2\4E0A\5024\5F15\30FB\8FD4\54C1','4020'),
  (U&'\5BB6\4E8B\6D88\8CBB\7B49','4030'),
  (U&'\96D1\53CE\5165','4040'),
  (U&'\8FD4\54C1\306E\624B\6570\6599','4050'),
  (U&'\671F\9996\5546\54C1\68DA\5378\9AD8','5010'),
  (U&'\671F\9996\6750\6599\68DA\5378\9AD8','5015'),
  (U&'\4ED5\5165\9AD8','5020'),
  (U&'\4ED5\5165\5024\5F15\30FB\8FD4\54C1','5030'),
  (U&'\671F\672B\5546\54C1\68DA\5378\9AD8','5040'),
  (U&'\671F\672B\6750\6599\68DA\5378\9AD8','5045'),
  (U&'\5916\6CE8\52A0\5DE5\8CBB','5050'),
  (U&'\79DF\7A0E\516C\8AB2','6010'),
  (U&'\8377\9020\904B\8CC3','6020'),
  (U&'\6C34\9053\5149\71B1\8CBB','6030'),
  (U&'\65C5\8CBB\4EA4\901A\8CBB','6040'),
  (U&'\901A\4FE1\8CBB','6050'),
  (U&'\5E83\544A\5BA3\4F1D\8CBB','6060'),
  (U&'\8CA9\58F2\4FC3\9032\8CBB','6070'),
  (U&'\63A5\5F85\4EA4\969B\8CBB','6080'),
  (U&'\4F1A\8B70\8CBB','6090'),
  (U&'\640D\5BB3\4FDD\967A\6599','6100'),
  (U&'\4FEE\7E55\8CBB','6110'),
  (U&'\6D88\8017\54C1\8CBB','6120'),
  (U&'\4E8B\52D9\7528\54C1\8CBB','6130'),
  (U&'\6E1B\4FA1\511F\5374\8CBB','6140'),
  (U&'\7E70\5EF6\8CC7\7523\511F\5374','6150'),
  (U&'\798F\5229\539A\751F\8CBB','6160'),
  (U&'\6CD5\5B9A\798F\5229\8CBB','6170'),
  (U&'\7D66\6599\8CC3\91D1','6180'),
  (U&'\5F79\54E1\5831\916C','6190'),
  (U&'\8CDE\4E0E','6200'),
  (U&'\9000\8077\7D66\4E0E','6210'),
  (U&'\5916\6CE8\5DE5\8CC3','6220'),
  (U&'\652F\6255\5831\916C','6230'),
  (U&'\5229\5B50\5272\5F15\6599','6240'),
  (U&'\5730\4EE3\5BB6\8CC3','6250'),
  (U&'\30EA\30FC\30B9\6599','6260'),
  (U&'\8ECA\4E21\8CBB','6270'),
  (U&'\652F\6255\624B\6570\6599','6280'),
  (U&'\7814\4FEE\63A1\7528\8CBB','6290'),
  (U&'\65B0\805E\56F3\66F8\8CBB','6300'),
  (U&'\8AF8\4F1A\8CBB','6310'),
  (U&'\5BC4\9644\91D1','6320'),
  (U&'\8CB8\5012\91D1\FF08\640D\5931\FF09','6330'),
  (U&'\96D1\8CBB','6340'),
  (U&'\53D7\53D6\5229\606F','7010'),
  (U&'\53D7\53D6\914D\5F53\91D1','7020'),
  (U&'\70BA\66FF\5DEE\76CA','7030'),
  (U&'\88DC\52A9\91D1\30FB\52A9\6210\91D1','7040'),
  (U&'\53D7\53D6\5BB6\8CC3','7050'),
  (U&'\8CB8\5012\5F15\5F53\91D1\623B\5165','7060'),
  (U&'\652F\6255\5229\606F','7510'),
  (U&'\70BA\66FF\5DEE\640D','7520'),
  (U&'\96D1\640D\5931','7530'),
  (U&'\56FA\5B9A\8CC7\7523\58F2\5374\76CA','8010'),
  (U&'\56FA\5B9A\8CC7\7523\58F2\5374\640D','8020'),
  (U&'\56FA\5B9A\8CC7\7523\9664\5374\640D','8030'),
  (U&'\707D\5BB3\640D\5931','8040'),
  (U&'\5C02\5F93\8005\7D66\4E0E','9010'),
  (U&'\8CB8\5012\5F15\5F53\91D1\7E70\5165','9020'),
  (U&'\305D\306E\4ED6\5F15\5F53\91D1\7E70\5165','9030'),
  (U&'\9752\8272\7533\544A\7279\5225\63A7\9664','9040'),
  (U&'\6CD5\4EBA\7A0E\30FB\4F4F\6C11\7A0E\53CA\3073\4E8B\696D\7A0E','9510');
INSERT INTO public.accounting_manual_method_map (source_text,direction,business_type,account_code) VALUES
  (U&'\73FE\91D1','expense','soleProprietor','1010'),
  (U&'\73FE\91D1','expense','corporation','1010'),
  (U&'\73FE\91D1','income','soleProprietor','1010'),
  (U&'\73FE\91D1','income','corporation','1010'),
  (U&'\30D7\30E9\30A4\30D9\30FC\30C8','expense','soleProprietor','2920'),
  (U&'\30D7\30E9\30A4\30D9\30FC\30C8','expense','corporation','2120'),
  (U&'\30D7\30E9\30A4\30D9\30FC\30C8','income','soleProprietor','1910'),
  (U&'\30D7\30E9\30A4\30D9\30FC\30C8','income','corporation','2120'),
  (U&'\30AF\30EC\30B8\30C3\30C8\30AB\30FC\30C9','expense','soleProprietor','2130'),
  (U&'\30AF\30EC\30B8\30C3\30C8\30AB\30FC\30C9','expense','corporation','2130'),
  (U&'\30AF\30EC\30B8\30C3\30C8\30AB\30FC\30C9','income','soleProprietor','2130'),
  (U&'\30AF\30EC\30B8\30C3\30C8\30AB\30FC\30C9','income','corporation','2130'),
  (U&'\9280\884C','expense','soleProprietor','1040'),
  (U&'\9280\884C','expense','corporation','1040'),
  (U&'\9280\884C','income','soleProprietor','1040'),
  (U&'\9280\884C','income','corporation','1040'),
  (U&'\652F\6255\624B\5F62','expense','soleProprietor','2010'),
  (U&'\652F\6255\624B\5F62','expense','corporation','2010'),
  (U&'\652F\6255\624B\5F62','income','soleProprietor','2010'),
  (U&'\652F\6255\624B\5F62','income','corporation','2010'),
  (U&'\8CB7\639B\91D1','expense','soleProprietor','2020'),
  (U&'\8CB7\639B\91D1','expense','corporation','2020'),
  (U&'\8CB7\639B\91D1','income','soleProprietor','2020'),
  (U&'\8CB7\639B\91D1','income','corporation','2020'),
  (U&'\501F\5165\91D1','expense','soleProprietor','2110'),
  (U&'\501F\5165\91D1','expense','corporation','2110'),
  (U&'\501F\5165\91D1','income','soleProprietor','2110'),
  (U&'\501F\5165\91D1','income','corporation','2110'),
  (U&'\672A\6255\91D1','expense','soleProprietor','2130'),
  (U&'\672A\6255\91D1','expense','corporation','2130'),
  (U&'\672A\6255\91D1','income','soleProprietor','2130'),
  (U&'\672A\6255\91D1','income','corporation','2130'),
  (U&'\524D\53D7\91D1','expense','soleProprietor','2150'),
  (U&'\524D\53D7\91D1','expense','corporation','2150'),
  (U&'\524D\53D7\91D1','income','soleProprietor','2150'),
  (U&'\524D\53D7\91D1','income','corporation','2150'),
  (U&'\9810\308A\91D1','expense','soleProprietor','2160'),
  (U&'\9810\308A\91D1','expense','corporation','2160'),
  (U&'\9810\308A\91D1','income','soleProprietor','2160'),
  (U&'\9810\308A\91D1','income','corporation','2160'),
  (U&'\8CC3\5012\5F15\5F53\91D1','expense','soleProprietor','2260'),
  (U&'\8CC3\5012\5F15\5F53\91D1','expense','corporation','2260'),
  (U&'\8CC3\5012\5F15\5F53\91D1','income','soleProprietor','2260'),
  (U&'\8CC3\5012\5F15\5F53\91D1','income','corporation','2260'),
  (U&'\501F\53D7\91D1','expense','soleProprietor','2170'),
  (U&'\501F\53D7\91D1','expense','corporation','2170'),
  (U&'\501F\53D7\91D1','income','soleProprietor','2170'),
  (U&'\501F\53D7\91D1','income','corporation','2170'),
  (U&'\672A\6255\6D88\8CBB\7A0E','expense','soleProprietor','2190'),
  (U&'\672A\6255\6D88\8CBB\7A0E','expense','corporation','2190'),
  (U&'\672A\6255\6D88\8CBB\7A0E','income','soleProprietor','2190'),
  (U&'\672A\6255\6D88\8CBB\7A0E','income','corporation','2190'),
  (U&'\4FDD\8A3C\91D1\30FB\6577\91D1','expense','soleProprietor','2220'),
  (U&'\4FDD\8A3C\91D1\30FB\6577\91D1','expense','corporation','2220'),
  (U&'\4FDD\8A3C\91D1\30FB\6577\91D1','income','soleProprietor','2220'),
  (U&'\4FDD\8A3C\91D1\30FB\6577\91D1','income','corporation','2220'),
  (U&'\5546\54C1\5238','expense','soleProprietor','2230'),
  (U&'\5546\54C1\5238','expense','corporation','2230'),
  (U&'\5546\54C1\5238','income','soleProprietor','2230'),
  (U&'\5546\54C1\5238','income','corporation','2230'),
  (U&'\4EEE\53D7\6D88\8CBB\7A0E','expense','soleProprietor','2180'),
  (U&'\4EEE\53D7\6D88\8CBB\7A0E','expense','corporation','2180'),
  (U&'\4EEE\53D7\6D88\8CBB\7A0E','income','soleProprietor','2180'),
  (U&'\4EEE\53D7\6D88\8CBB\7A0E','income','corporation','2180'),
  (U&'\524D\6255\91D1','expense','soleProprietor','1410'),
  (U&'\524D\6255\91D1','expense','corporation','1410'),
  (U&'\524D\6255\91D1','income','soleProprietor','1410'),
  (U&'\524D\6255\91D1','income','corporation','1410'),
  (U&'\58F2\639B\91D1','expense','soleProprietor','1120'),
  (U&'\58F2\639B\91D1','expense','corporation','1120'),
  (U&'\58F2\639B\91D1','income','soleProprietor','1120'),
  (U&'\58F2\639B\91D1','income','corporation','1120'),
  (U&'\53D7\53D6\624B\5F62','expense','soleProprietor','1110'),
  (U&'\53D7\53D6\624B\5F62','expense','corporation','1110'),
  (U&'\53D7\53D6\624B\5F62','income','soleProprietor','1110'),
  (U&'\53D7\53D6\624B\5F62','income','corporation','1110'),
  (U&'\672A\53CE\8CC3\8CB8\6599','expense','soleProprietor','1440'),
  (U&'\672A\53CE\8CC3\8CB8\6599','expense','corporation','1440'),
  (U&'\672A\53CE\8CC3\8CB8\6599','income','soleProprietor','1440'),
  (U&'\672A\53CE\8CC3\8CB8\6599','income','corporation','1440'),
  (U&'\8CB8\4ED8\91D1','expense','soleProprietor','1450'),
  (U&'\8CB8\4ED8\91D1','expense','corporation','1450'),
  (U&'\8CB8\4ED8\91D1','income','soleProprietor','1450'),
  (U&'\8CB8\4ED8\91D1','income','corporation','1450'),
  (U&'\7ACB\66FF\91D1','expense','soleProprietor','1460'),
  (U&'\7ACB\66FF\91D1','expense','corporation','1460'),
  (U&'\7ACB\66FF\91D1','income','soleProprietor','1460'),
  (U&'\7ACB\66FF\91D1','income','corporation','1460'),
  (U&'\672A\53CE\91D1','expense','soleProprietor','1430'),
  (U&'\672A\53CE\91D1','expense','corporation','1430'),
  (U&'\672A\53CE\91D1','income','soleProprietor','1430'),
  (U&'\672A\53CE\91D1','income','corporation','1430'),
  (U&'\4EEE\6255\91D1','expense','soleProprietor','1470'),
  (U&'\4EEE\6255\91D1','expense','corporation','1470'),
  (U&'\4EEE\6255\91D1','income','soleProprietor','1470'),
  (U&'\4EEE\6255\91D1','income','corporation','1470'),
  (U&'\4EEE\6255\6D88\8CBB\7A0E','expense','soleProprietor','1480'),
  (U&'\4EEE\6255\6D88\8CBB\7A0E','expense','corporation','1480'),
  (U&'\4EEE\6255\6D88\8CBB\7A0E','income','soleProprietor','1480'),
  (U&'\4EEE\6255\6D88\8CBB\7A0E','income','corporation','1480'),
  ('Stripe','expense','soleProprietor','1130'),
  ('Stripe','expense','corporation','1130'),
  ('Stripe','income','soleProprietor','1130'),
  ('Stripe','income','corporation','1130');
-- ACC_MANUAL_MAP_END

CREATE TRIGGER accounting_manual_category_map_no_update_delete BEFORE UPDATE OR DELETE
  ON public.accounting_manual_category_map FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_manual_category_map_no_truncate BEFORE TRUNCATE
  ON public.accounting_manual_category_map FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_manual_method_map_no_update_delete BEFORE UPDATE OR DELETE
  ON public.accounting_manual_method_map FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_manual_method_map_no_truncate BEFORE TRUNCATE
  ON public.accounting_manual_method_map FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
ALTER TABLE public.accounting_manual_category_map ENABLE ALWAYS TRIGGER accounting_manual_category_map_no_update_delete;
ALTER TABLE public.accounting_manual_category_map ENABLE ALWAYS TRIGGER accounting_manual_category_map_no_truncate;
ALTER TABLE public.accounting_manual_method_map ENABLE ALWAYS TRIGGER accounting_manual_method_map_no_update_delete;
ALTER TABLE public.accounting_manual_method_map ENABLE ALWAYS TRIGGER accounting_manual_method_map_no_truncate;

-- 2. The journal trigger (FREQ-556-AC-01..AC-03). See the header for the rules.
CREATE FUNCTION private.accounting_manual_entry_after_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_open_id uuid;
  v_actor uuid;
  v_period_id uuid;
  v_business_type text;
  v_counter text;
  v_funds text;
  v_counter_line jsonb;
  v_funds_line jsonb;
  v_lines jsonb;
  v_revision bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.expense_date, OLD.category, OLD.item_name, OLD.partner, OLD.amount, OLD.payment_method,
      OLD.entry_type, OLD.deleted_at) IS NOT DISTINCT FROM (NEW.expense_date, NEW.category, NEW.item_name, NEW.partner,
      NEW.amount, NEW.payment_method, NEW.entry_type, NEW.deleted_at) THEN
    RETURN NULL;
  END IF;
  -- A row written as already deleted (service_role only; the route never does) is not posted, as rule (1) below.
  IF TG_OP = 'INSERT' AND NEW.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  -- (1) and (2) now; (3) once the period is known. The row lock is already held (this runs after the write).
  PERFORM private.accounting_lock_all(NULL);

  IF TG_OP = 'UPDATE' THEN
    SELECT e.id INTO v_open_id FROM public.accounting_journal_entries AS e
    WHERE e.source_table = 'admin_finance_expenses' AND e.source_id = NEW.id::text AND e.event_kind <> 'reversal'
      AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)
    ORDER BY e.recorded_at DESC, e.entry_no DESC
    LIMIT 1;
    IF NEW.deleted_at IS NOT NULL THEN
      IF v_open_id IS NOT NULL THEN
        PERFORM private.accounting_reverse_journal_core(COALESCE(NEW.deleted_by, NEW.created_by), v_open_id, 'delete',
          NULL, NULL);
      END IF;
      RETURN NULL;
    END IF;
    IF v_open_id IS NOT NULL THEN
      PERFORM private.accounting_reverse_journal_core(COALESCE(NEW.updated_by, NEW.created_by), v_open_id, 'edit',
        NULL, NULL);
    END IF;
    v_actor := COALESCE(NEW.updated_by, NEW.created_by);
  ELSE
    v_actor := NEW.created_by;
  END IF;

  v_period_id := private.accounting_period_for_event(NEW.expense_date, v_actor);
  PERFORM private.accounting_lock_all(v_period_id);
  SELECT p.business_type INTO v_business_type FROM public.accounting_periods AS p WHERE p.id = v_period_id;

  v_counter := COALESCE((SELECT m.account_code FROM public.accounting_manual_category_map AS m
    WHERE m.source_text = NEW.category), '9999');
  v_funds := COALESCE((SELECT m.account_code FROM public.accounting_manual_method_map AS m
      WHERE m.source_text = NEW.payment_method AND m.direction = NEW.entry_type AND m.business_type = v_business_type),
    (SELECT m.account_code FROM public.accounting_manual_category_map AS m WHERE m.source_text = NEW.payment_method),
    '9999');
  v_counter_line := pg_catalog.jsonb_build_object('account_code', v_counter,
    'debit', CASE WHEN NEW.entry_type = 'expense' THEN NEW.amount ELSE 0 END,
    'credit', CASE WHEN NEW.entry_type = 'expense' THEN 0 ELSE NEW.amount END,
    'sub_account', NULL, 'counterparty', NULLIF(NEW.partner, ''), 'order_id', NULL,
    'memo', CASE WHEN v_counter = '9999' THEN NEW.category END);
  v_funds_line := pg_catalog.jsonb_build_object('account_code', v_funds,
    'debit', CASE WHEN NEW.entry_type = 'expense' THEN 0 ELSE NEW.amount END,
    'credit', CASE WHEN NEW.entry_type = 'expense' THEN NEW.amount ELSE 0 END,
    'sub_account', NULL, 'counterparty', NULLIF(NEW.partner, ''), 'order_id', NULL,
    'memo', CASE WHEN v_funds = '9999' THEN NEW.payment_method END);
  v_lines := CASE WHEN NEW.entry_type = 'expense' THEN pg_catalog.jsonb_build_array(v_counter_line, v_funds_line)
    ELSE pg_catalog.jsonb_build_array(v_funds_line, v_counter_line) END;

  SELECT pg_catalog.count(*) INTO v_revision FROM public.accounting_journal_entries AS e
  WHERE e.source_table = 'admin_finance_expenses' AND e.source_id = NEW.id::text AND e.event_kind = 'manual_entry';
  PERFORM private.accounting_post_journal_core(v_actor, v_period_id, NEW.expense_date, 'manual_entry',
    ARRAY[NEW.id::text, v_revision::text], NEW.item_name, v_lines, NULL, NULL, 'admin_finance_expenses', NEW.id::text,
    NULL, NULL, NULL);
  RETURN NULL;
END;
$$;
CREATE TRIGGER accounting_manual_entry_journal AFTER INSERT OR UPDATE ON public.admin_finance_expenses
  FOR EACH ROW EXECUTE FUNCTION private.accounting_manual_entry_after_write();

-- 3. The transaction rows are removed only logically (FREQ-556-AC-05).
CREATE TRIGGER accounting_manual_entry_no_delete BEFORE DELETE ON public.admin_finance_expenses
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_manual_entry_no_truncate BEFORE TRUNCATE ON public.admin_finance_expenses
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
ALTER TABLE public.admin_finance_expenses ENABLE ALWAYS TRIGGER accounting_manual_entry_no_delete;
ALTER TABLE public.admin_finance_expenses ENABLE ALWAYS TRIGGER accounting_manual_entry_no_truncate;

-- 4. The revision history is append only (FREQ-556-AC-05, AC-06). INSERT stays with the existing trigger. The one
--    UPDATE allowed is changed_by from a value to NULL with every other column unchanged (ON DELETE SET NULL).
CREATE FUNCTION private.accounting_guard_entry_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.changed_by IS NOT NULL AND NEW.changed_by IS NULL
    AND (pg_catalog.to_jsonb(NEW) - 'changed_by') = (pg_catalog.to_jsonb(OLD) - 'changed_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER accounting_entry_revisions_guard BEFORE UPDATE OR DELETE ON public.admin_finance_entry_revisions
  FOR EACH ROW EXECUTE FUNCTION private.accounting_guard_entry_revision();
CREATE TRIGGER accounting_entry_revisions_no_truncate BEFORE TRUNCATE ON public.admin_finance_entry_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
ALTER TABLE public.admin_finance_entry_revisions ENABLE ALWAYS TRIGGER accounting_entry_revisions_guard;
ALTER TABLE public.admin_finance_entry_revisions ENABLE ALWAYS TRIGGER accounting_entry_revisions_no_truncate;

-- 5. Owners and EXECUTE: both functions are owner only (a trigger needs no EXECUTE to fire).
ALTER FUNCTION private.accounting_manual_entry_after_write() OWNER TO postgres;
ALTER FUNCTION private.accounting_guard_entry_revision() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.accounting_manual_entry_after_write(), private.accounting_guard_entry_revision()
FROM PUBLIC, anon, authenticated, service_role;

-- 6. The history function (FREQ-556-AC-06; see the header). CREATE OR REPLACE keeps the owner, the ACL (G2: no
--    EXECUTE for PUBLIC / anon / authenticated, service_role keeps it) and the trigger that calls it.
CREATE OR REPLACE FUNCTION public.record_admin_finance_entry_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  actor uuid;
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
    VALUES (NEW.id, 'insert', NULL, pg_catalog.to_jsonb(NEW), NEW.created_by);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      actor := COALESCE(NEW.deleted_by, NEW.updated_by);
      INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
      VALUES (NEW.id, 'delete', pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW), actor);
      RETURN NEW;
    END IF;

    v_old := pg_catalog.to_jsonb(OLD) - 'updated_at' - 'fixed_asset_exempt' - 'fixed_asset_exempt_reason'
      - 'fixed_asset_reviewed_at' - 'fixed_asset_reviewed_by';
    v_new := pg_catalog.to_jsonb(NEW) - 'updated_at' - 'fixed_asset_exempt' - 'fixed_asset_exempt_reason'
      - 'fixed_asset_reviewed_at' - 'fixed_asset_reviewed_by';
    IF v_old = v_new THEN
      RETURN NEW;
    END IF;

    -- Only actor columns cleared to NULL (ON DELETE SET NULL when a user is deleted): no content change, no revision.
    IF (v_old - 'created_by' - 'updated_by' - 'deleted_by') = (v_new - 'created_by' - 'updated_by' - 'deleted_by')
      AND (NEW.created_by IS NULL OR NEW.created_by IS NOT DISTINCT FROM OLD.created_by)
      AND (NEW.updated_by IS NULL OR NEW.updated_by IS NOT DISTINCT FROM OLD.updated_by)
      AND (NEW.deleted_by IS NULL OR NEW.deleted_by IS NOT DISTINCT FROM OLD.deleted_by) THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
    VALUES (NEW.id, 'update', pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW), NEW.updated_by);
    RETURN NEW;
  END IF;

  INSERT INTO public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data, changed_by)
  VALUES (OLD.id, 'delete', pg_catalog.to_jsonb(OLD), NULL, OLD.updated_by);
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.record_admin_finance_entry_revision() OWNER TO postgres;
-- ACC_S4_BODY_END

-- ACC_S4_FINAL_ASSERT_BEGIN
-- Compare catalog meaning (columns, constraint definitions, triggers, ACL entries, has_*_privilege, function
-- attributes), never ACL text serialization.
DO $acc_s4_final$
DECLARE
  v_failed text;
  v_stage text;
  v_baseline jsonb;
  v_now jsonb;
  v_search_path text;
BEGIN
  -- Catalog text (pg_get_expr, pg_get_constraintdef, format_type) depends on the caller's search_path: with
  -- extensions ahead of pg_catalog (the Supabase default) a built-in such as gen_random_uuid() prints as
  -- pg_catalog.gen_random_uuid(). Pin an empty search_path for this block (transaction local); it is put back below,
  -- and an error rolls it back with the block.
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s4_map_table';
  -- acc_s4_map_table: the two tables (owner, columns, exactly these constraints), RLS on and no policy, nothing for
  -- PUBLIC / anon / authenticated, SELECT only for service_role, the rows of the generator (count and md5) and the
  -- four append-only triggers (ALWAYS).
  IF EXISTS (SELECT 1 FROM (VALUES
      ('accounting_manual_category_map', 'source_text text not null, account_code text not null'),
      ('accounting_manual_method_map', 'source_text text not null, direction text not null, business_type text not null, account_code text not null')
    ) AS t(name, columns)
    LEFT JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
    WHERE c.oid IS NULL OR c.relkind <> 'r' OR c.relowner <> 'postgres'::regrole OR NOT c.relrowsecurity
      OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
            || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
            || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
          FROM pg_catalog.pg_attribute AS a
          LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM t.columns
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pol WHERE pol.polrelid = c.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
        WHERE acl.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
          OR (acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type <> 'SELECT'))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
        CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS q(privilege)
        WHERE pg_catalog.has_table_privilege(r.role, c.oid, q.privilege))
      OR pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')) THEN
    v_failed := 'acc_s4_map_table';
  END IF;
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid IN (pg_catalog.to_regclass('public.accounting_manual_category_map'),
        pg_catalog.to_regclass('public.accounting_manual_method_map')) AND c.contype IN ('c', 'p', 'u', 'f', 'x')) <> 6
    OR EXISTS (SELECT 1 FROM (VALUES
      ('accounting_manual_category_map', 'accounting_manual_category_map_pkey', 'p', 'source_text'),
      ('accounting_manual_category_map', 'accounting_manual_category_map_account_code_fkey', 'f', 'account_code>public.accounting_accounts(code)ras'),
      ('accounting_manual_method_map', 'accounting_manual_method_map_pkey', 'p', 'source_text,direction,business_type'),
      ('accounting_manual_method_map', 'accounting_manual_method_map_direction_check', 'c', 'CHECK ((direction = ANY (ARRAY[''expense''::text, ''income''::text])))'),
      ('accounting_manual_method_map', 'accounting_manual_method_map_business_type_check', 'c', 'CHECK ((business_type = ANY (ARRAY[''soleProprietor''::text, ''corporation''::text])))'),
      ('accounting_manual_method_map', 'accounting_manual_method_map_account_code_fkey', 'f', 'account_code>public.accounting_accounts(code)ras')
      ) AS x(table_name, name, kind, definition)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
        WHERE c.conrelid = pg_catalog.to_regclass('public.' || x.table_name) AND c.conname = x.name
          AND c.contype = x.kind::"char" AND c.convalidated AND NOT c.condeferrable
          AND CASE WHEN c.contype = 'c' THEN pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g')
            ELSE (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
                FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
                JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.num)
              || CASE WHEN c.contype = 'f' THEN '>' || (SELECT n.nspname::text || '.' || r.relname::text
                  FROM pg_catalog.pg_class AS r JOIN pg_catalog.pg_namespace AS n ON n.oid = r.relnamespace
                  WHERE r.oid = c.confrelid) || '(' || (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
                  FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY AS k(num, ord)
                  JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.confrelid AND a.attnum = k.num) || ')'
                  || c.confdeltype::text || c.confupdtype::text || c.confmatchtype::text
                ELSE '' END
            END = x.definition))) THEN
    v_failed := 'acc_s4_map_table';
  END IF;
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_manual_category_map) <> 162
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(m.source_text || '=' || m.account_code, ';'
        ORDER BY m.source_text COLLATE "C")) FROM public.accounting_manual_category_map AS m) <> '0b3bedaa649b25e3a75fec6ab3e6609b'
    OR (SELECT pg_catalog.count(*) FROM public.accounting_manual_method_map) <> 104
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(m.source_text || '/' || m.direction || '/' || m.business_type || '='
        || m.account_code, ';' ORDER BY m.source_text COLLATE "C", m.direction COLLATE "C", m.business_type COLLATE "C"))
      FROM public.accounting_manual_method_map AS m) <> '2453cfd5f9585dbd1cf9be7b552c4269') THEN
    v_failed := 'acc_s4_map_table';
  END IF;
  IF v_failed IS NULL AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid IN (pg_catalog.to_regclass('public.accounting_manual_category_map'),
        pg_catalog.to_regclass('public.accounting_manual_method_map')) AND NOT t.tgisinternal) <> 4
    OR v_failed IS NULL AND (SELECT pg_catalog.count(*) FROM (VALUES
        ('accounting_manual_category_map', 'accounting_manual_category_map_no_update_delete', 27),
        ('accounting_manual_category_map', 'accounting_manual_category_map_no_truncate', 34),
        ('accounting_manual_method_map', 'accounting_manual_method_map_no_update_delete', 27),
        ('accounting_manual_method_map', 'accounting_manual_method_map_no_truncate', 34)
      ) AS x(table_name, name, type)
      JOIN pg_catalog.pg_trigger AS t ON t.tgrelid = pg_catalog.to_regclass('public.' || x.table_name) AND t.tgname = x.name
      WHERE t.tgtype = x.type AND t.tgenabled = 'A' AND t.tgnargs = 0 AND t.tgqual IS NULL AND t.tgconstraint = 0
        AND t.tgfoid = 'private.reject_accounting_mutation()'::regprocedure) <> 4 THEN
    v_failed := 'acc_s4_map_table';
  END IF;

  v_stage := 'acc_s4_trigger';
  -- acc_s4_trigger: exactly these five accounting triggers on the two finance tables (event bits, timing, row or
  -- statement, enabled mode, function, no column list, no WHEN, no constraint trigger).
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid IN ('public.admin_finance_expenses'::regclass, 'public.admin_finance_entry_revisions'::regclass)
        AND NOT t.tgisinternal AND t.tgname ~ '^accounting_') <> 5
    OR (SELECT pg_catalog.count(*) FROM (VALUES
        ('admin_finance_expenses', 'accounting_manual_entry_journal', 21, 'O', 'private.accounting_manual_entry_after_write()'),
        ('admin_finance_expenses', 'accounting_manual_entry_no_delete', 11, 'A', 'private.reject_accounting_mutation()'),
        ('admin_finance_expenses', 'accounting_manual_entry_no_truncate', 34, 'A', 'private.reject_accounting_mutation()'),
        ('admin_finance_entry_revisions', 'accounting_entry_revisions_guard', 27, 'A', 'private.accounting_guard_entry_revision()'),
        ('admin_finance_entry_revisions', 'accounting_entry_revisions_no_truncate', 34, 'A', 'private.reject_accounting_mutation()')
      ) AS x(table_name, name, type, enabled, fn)
      JOIN pg_catalog.pg_trigger AS t ON t.tgrelid = pg_catalog.to_regclass('public.' || x.table_name) AND t.tgname = x.name
      WHERE t.tgtype = x.type AND t.tgenabled = x.enabled::"char" AND t.tgnargs = 0 AND t.tgattr::text = ''
        AND t.tgqual IS NULL AND t.tgconstraint = 0 AND t.tgfoid = pg_catalog.to_regprocedure(x.fn)) <> 5) THEN
    v_failed := 'acc_s4_trigger';
  END IF;

  v_stage := 'acc_s4_functions';
  -- acc_s4_functions: the two trigger functions (owner, SECURITY DEFINER, VOLATILE plpgsql trigger, empty search_path,
  -- one function per name, no EXECUTE for PUBLIC / anon / authenticated / service_role, the bodies fingerprinted) and
  -- nothing named accounting_* in public.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM (VALUES
        ('private.accounting_manual_entry_after_write()', 'dfb9ca19449f951b9d4399779c276936'),
        ('private.accounting_guard_entry_revision()', '59fa13adf30933325dbb33171f419a67')
      ) AS x(fn, body_md5)
      JOIN pg_catalog.pg_proc AS f ON f.oid = pg_catalog.to_regprocedure(x.fn)
      JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.proowner = 'postgres'::regrole AND f.prosecdef AND f.provolatile = 'v' AND l.lanname = 'plpgsql'
        AND f.prorettype = 'trigger'::regtype AND f.pronargs = 0 AND f.prokind = 'f'
        AND f.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
        AND pg_catalog.md5(pg_catalog.replace(f.prosrc, E'\r', '')) = x.body_md5
        AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = f.pronamespace AND o.proname = f.proname) = 1
        AND NOT pg_catalog.has_function_privilege('anon', f.oid, 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('authenticated', f.oid, 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.pronamespace = 'public'::regnamespace AND f.proname LIKE 'accounting\_%')) THEN
    v_failed := 'acc_s4_functions';
  END IF;

  v_stage := 'acc_s4_legacy_trigger_untouched';
  -- acc_s4_legacy_trigger_untouched: the existing triggers of the two tables (definition and enabled mode) and their
  -- other functions are as before this migration (the baseline), the history trigger is still there and enabled, and
  -- the history function is the S4 one: body fingerprint, SECURITY DEFINER, owner postgres, empty search_path, no
  -- EXECUTE for PUBLIC / anon / authenticated and EXECUTE for service_role (as G2 fixed it).
  IF v_failed IS NULL THEN
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s4_baseline AS b;
    SELECT pg_catalog.jsonb_build_object('legacy', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'table', c.relname::text, 'name', t.tgname::text, 'type', t.tgtype, 'enabled', t.tgenabled::text,
        'function', n.nspname::text || '.' || f.proname::text, 'args', pg_catalog.encode(t.tgargs, 'hex'),
        'attr', t.tgattr::text, 'when', t.tgqual IS NOT NULL, 'constraint', t.tgconstraint <> 0,
        'body_md5', CASE WHEN f.proname = 'record_admin_finance_entry_revision' THEN NULL
          ELSE pg_catalog.md5(pg_catalog.replace(f.prosrc, E'\r', '')) END, 'definer', f.prosecdef,
        'config', CASE WHEN f.proname = 'record_admin_finance_entry_revision' THEN NULL ELSE f.proconfig END,
        'owner', f.proowner::regrole::text) ORDER BY c.relname::text COLLATE "C", t.tgname::text COLLATE "C")
      FROM pg_catalog.pg_trigger AS t
      JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_proc AS f ON f.oid = t.tgfoid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
      WHERE c.oid IN (pg_catalog.to_regclass('public.admin_finance_expenses'),
          pg_catalog.to_regclass('public.admin_finance_entry_revisions'))
        AND NOT t.tgisinternal AND t.tgname !~ '^accounting_'), '[]'::jsonb)) INTO v_now;
    IF (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s4_baseline) <> 1 OR v_baseline IS DISTINCT FROM v_now
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
        JOIN pg_catalog.pg_proc AS f ON f.oid = t.tgfoid
        WHERE t.tgrelid = 'public.admin_finance_expenses'::regclass AND t.tgname = 'trigger_admin_finance_entry_revisions'
          AND t.tgtype = 29 AND t.tgenabled = 'O'
          AND f.oid = 'public.record_admin_finance_entry_revision()'::regprocedure AND f.prosecdef
          AND f.proowner = 'postgres'::regrole AND f.provolatile = 'v'
          AND f.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
          AND pg_catalog.md5(pg_catalog.replace(f.prosrc, E'\r', '')) = 'a0704b3e8144f7a7141ee2279a4515a9'
          AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
            WHERE o.pronamespace = f.pronamespace AND o.proname = f.proname) = 1
          AND NOT pg_catalog.has_function_privilege('anon', f.oid, 'EXECUTE')
          AND NOT pg_catalog.has_function_privilege('authenticated', f.oid, 'EXECUTE')
          AND pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE')
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) THEN
      v_failed := 'acc_s4_legacy_trigger_untouched';
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the
  -- SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s4_map_table'), HINT = SQLSTATE;
END;
$acc_s4_final$;
-- ACC_S4_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
