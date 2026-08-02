-- 076: Replace manual product costing with expense-backed seasonal allocations.

BEGIN;

DROP TABLE IF EXISTS public.admin_product_costs;

CREATE TABLE public.admin_costing_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_key text NOT NULL REFERENCES public.admin_finance_seasons(season_key) ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN ('TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES')),
  provisional_name text NOT NULL CHECK (char_length(provisional_name) BETWEEN 1 AND 160),
  planned_quantity integer NOT NULL DEFAULT 0 CHECK (planned_quantity BETWEEN 0 AND 1000000),
  selling_price bigint NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  fabric_meters_per_unit numeric(12, 3) NOT NULL DEFAULT 0 CHECK (fabric_meters_per_unit >= 0),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, season_key)
);

CREATE INDEX idx_admin_costing_items_season_category
  ON public.admin_costing_items(season_key, category, id);

CREATE TABLE public.admin_expense_cost_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  expense_id bigint NOT NULL REFERENCES public.admin_finance_expenses(id) ON DELETE RESTRICT,
  season_key text NOT NULL REFERENCES public.admin_finance_seasons(season_key) ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (target_type IN ('item', 'season_common')),
  item_id bigint NULL REFERENCES public.admin_costing_items(id) ON DELETE RESTRICT,
  cost_type text NOT NULL CHECK (cost_type IN (
    'material', 'sewing', 'pattern', 'planning', 'accessories', 'processing',
    'inspection_finishing', 'logistics', 'advertising', 'photography',
    'exhibition', 'other'
  )),
  other_label text NULL CHECK (other_label IS NULL OR char_length(other_label) BETWEEN 1 AND 80),
  amount bigint NOT NULL CHECK (amount > 0),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_expense_cost_allocations_target_check CHECK (
    (target_type = 'item' AND item_id IS NOT NULL)
    OR (target_type = 'season_common' AND item_id IS NULL)
  ),
  CONSTRAINT admin_expense_cost_allocations_other_cost_type_check CHECK (
    (cost_type = 'other' AND other_label IS NOT NULL)
    OR (cost_type <> 'other' AND other_label IS NULL)
  )
);

CREATE INDEX idx_admin_expense_cost_allocations_expense
  ON public.admin_expense_cost_allocations(expense_id, id);
CREATE INDEX idx_admin_expense_cost_allocations_season
  ON public.admin_expense_cost_allocations(season_key, target_type, id);
CREATE INDEX idx_admin_expense_cost_allocations_item
  ON public.admin_expense_cost_allocations(item_id, id)
  WHERE item_id IS NOT NULL;

CREATE TRIGGER trigger_admin_costing_items_updated_at
  BEFORE UPDATE ON public.admin_costing_items
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE TRIGGER trigger_admin_expense_cost_allocations_updated_at
  BEFORE UPDATE ON public.admin_expense_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

CREATE OR REPLACE FUNCTION public.validate_admin_expense_cost_allocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  expense_row public.admin_finance_expenses%ROWTYPE;
  item_season text;
BEGIN
  SELECT * INTO expense_row
  FROM public.admin_finance_expenses
  WHERE id = NEW.expense_id;

  IF NOT FOUND OR expense_row.deleted_at IS NOT NULL OR expense_row.entry_type <> 'expense' THEN
    RAISE EXCEPTION 'Allocation target must be an active expense';
  END IF;
  IF expense_row.season_key IS NULL OR expense_row.season_key <> NEW.season_key THEN
    RAISE EXCEPTION 'Allocation season must match the expense season';
  END IF;

  IF NEW.target_type = 'item' THEN
    SELECT season_key INTO item_season
    FROM public.admin_costing_items
    WHERE id = NEW.item_id;
    IF NOT FOUND OR item_season <> NEW.season_key THEN
      RAISE EXCEPTION 'Allocation item must belong to the expense season';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_validate_admin_expense_cost_allocation
  BEFORE INSERT OR UPDATE ON public.admin_expense_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION public.validate_admin_expense_cost_allocation();

CREATE OR REPLACE FUNCTION public.replace_admin_expense_cost_allocations(
  p_expense_id bigint,
  p_lines jsonb,
  p_created_by uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  expense_row public.admin_finance_expenses%ROWTYPE;
  line jsonb;
  line_amount bigint;
  total_amount bigint := 0;
  line_target text;
  line_item_id bigint;
  line_cost_type text;
  line_other_label text;
BEGIN
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one allocation line is required';
  END IF;

  SELECT * INTO expense_row
  FROM public.admin_finance_expenses
  WHERE id = p_expense_id
  FOR UPDATE;

  IF NOT FOUND OR expense_row.deleted_at IS NOT NULL OR expense_row.entry_type <> 'expense' THEN
    RAISE EXCEPTION 'Allocation target must be an active expense';
  END IF;
  IF expense_row.season_key IS NULL THEN
    RAISE EXCEPTION 'Allocation target must have a season tag';
  END IF;

  FOR line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    line_target := line->>'targetType';
    line_cost_type := line->>'costType';
    line_other_label := NULLIF(btrim(line->>'otherLabel'), '');
    line_item_id := CASE
      WHEN line_target = 'item' THEN (line->>'itemId')::bigint
      ELSE NULL
    END;
    line_amount := (line->>'amount')::bigint;

    IF line_target NOT IN ('item', 'season_common') THEN
      RAISE EXCEPTION 'Invalid allocation target type';
    END IF;
    IF line_cost_type NOT IN (
      'material', 'sewing', 'pattern', 'planning', 'accessories', 'processing',
      'inspection_finishing', 'logistics', 'advertising', 'photography',
      'exhibition', 'other'
    ) THEN
      RAISE EXCEPTION 'Invalid allocation cost type';
    END IF;
    IF line_amount <= 0 THEN
      RAISE EXCEPTION 'Allocation amount must be positive';
    END IF;
    IF line_cost_type = 'other' AND line_other_label IS NULL THEN
      RAISE EXCEPTION 'Other allocation requires a label';
    END IF;
    IF line_cost_type <> 'other' THEN
      line_other_label := NULL;
    END IF;
    IF line_target = 'item' AND NOT EXISTS (
      SELECT 1 FROM public.admin_costing_items
      WHERE id = line_item_id AND season_key = expense_row.season_key
    ) THEN
      RAISE EXCEPTION 'Allocation item must belong to the expense season';
    END IF;

    total_amount := total_amount + line_amount;
  END LOOP;

  IF total_amount <> expense_row.amount THEN
    RAISE EXCEPTION 'Allocation total must equal the expense amount';
  END IF;

  DELETE FROM public.admin_expense_cost_allocations WHERE expense_id = p_expense_id;

  FOR line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    line_target := line->>'targetType';
    line_cost_type := line->>'costType';
    line_other_label := CASE
      WHEN line_cost_type = 'other' THEN NULLIF(btrim(line->>'otherLabel'), '')
      ELSE NULL
    END;
    line_item_id := CASE
      WHEN line_target = 'item' THEN (line->>'itemId')::bigint
      ELSE NULL
    END;
    line_amount := (line->>'amount')::bigint;

    INSERT INTO public.admin_expense_cost_allocations (
      expense_id, season_key, target_type, item_id, cost_type, other_label,
      amount, created_by
    ) VALUES (
      p_expense_id, expense_row.season_key, line_target, line_item_id,
      line_cost_type, line_other_label, line_amount, p_created_by
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_admin_expense_cost_allocations(p_expense_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM public.admin_finance_expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  DELETE FROM public.admin_expense_cost_allocations WHERE expense_id = p_expense_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_allocated_expense_integrity_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.admin_expense_cost_allocations WHERE expense_id = OLD.id
  ) AND (
    NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.season_key IS DISTINCT FROM OLD.season_key
    OR NEW.entry_type IS DISTINCT FROM OLD.entry_type
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  ) THEN
    RAISE EXCEPTION 'Clear product cost allocations before changing or deleting this expense';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_prevent_allocated_expense_integrity_change
  BEFORE UPDATE ON public.admin_finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.prevent_allocated_expense_integrity_change();

ALTER TABLE public.admin_costing_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_expense_cost_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin costing items read"
  ON public.admin_costing_items FOR SELECT TO authenticated
  USING ((SELECT public.has_permission('admin.finance.read')));
CREATE POLICY "admin expense cost allocations read"
  ON public.admin_expense_cost_allocations FOR SELECT TO authenticated
  USING ((SELECT public.has_permission('admin.finance.read')));

REVOKE ALL ON public.admin_costing_items FROM anon, authenticated;
REVOKE ALL ON public.admin_expense_cost_allocations FROM anon, authenticated;
GRANT SELECT ON public.admin_costing_items TO authenticated;
GRANT SELECT ON public.admin_expense_cost_allocations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_costing_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_expense_cost_allocations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.admin_costing_items_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.admin_expense_cost_allocations_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.replace_admin_expense_cost_allocations(bigint, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_admin_expense_cost_allocations(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_admin_expense_cost_allocations(bigint, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_admin_expense_cost_allocations(bigint) TO service_role;

COMMIT;
