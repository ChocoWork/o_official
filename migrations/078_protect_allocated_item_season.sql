-- 078: Keep item/expense season integrity after allocations are finalized.

BEGIN;

CREATE OR REPLACE FUNCTION public.prevent_allocated_item_season_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.season_key IS DISTINCT FROM OLD.season_key
     AND EXISTS (
       SELECT 1
       FROM public.admin_expense_cost_allocations allocation
       WHERE allocation.item_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'Clear the item allocations before changing its season';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_prevent_allocated_item_season_change
BEFORE UPDATE OF season_key ON public.admin_costing_items
FOR EACH ROW EXECUTE FUNCTION public.prevent_allocated_item_season_change();

COMMIT;
