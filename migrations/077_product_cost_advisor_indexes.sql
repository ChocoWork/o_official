-- 077: Cover product costing audit foreign keys reported by Supabase Advisor.

BEGIN;

CREATE INDEX idx_admin_costing_items_created_by
  ON public.admin_costing_items(created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX idx_admin_expense_cost_allocations_created_by
  ON public.admin_expense_cost_allocations(created_by)
  WHERE created_by IS NOT NULL;

COMMIT;
