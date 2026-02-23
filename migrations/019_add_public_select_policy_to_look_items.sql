-- migrations/019_add_public_select_policy_to_look_items.sql
-- Allow public lookup of items linked to published looks

BEGIN;

DROP POLICY IF EXISTS "Anyone can view look items for published looks" ON public.look_items;
CREATE POLICY "Anyone can view look items for published looks"
ON public.look_items
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.looks
    WHERE looks.id = look_items.look_id
      AND looks.status = 'published'
  )
);

COMMIT;
