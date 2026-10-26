-- Wave 2 / Task 7: look_items read policies check the product too, looks / news_articles get NOT VALID CHECK
-- constraints, and LOOK updates become one transaction (admin_update_look)
-- (R5-3 .. R5-5: SEC-LOOK-002 / 015 / 023, SEC-NEWS-025; ADR-0162 / ADR-0163).
--
-- Why:
--   * look_items (SEC-LOOK-002): the anon / authenticated read policies only asked "is the parent look
--     published", so a published look exposed the ids of unreleased (private) items. Both policies now also
--     require the linked item to be published. The administrator branch of the authenticated policy stays
--     has_permission('admin.looks.read') (wave 5 adds aal2 to read branches).
--   * CHECK constraints (SEC-LOOK-023 / SEC-NEWS-025): lengths and the shape of image paths are checked in the
--     database as well as in the route handlers, so a direct write cannot store a 10 MB theme or a path such as
--     other/x.png or https://evil.example/x.png. The path check is written as an expression, not a helper
--     function (P7, ADR-0162): the CHECK is evaluated by whoever writes, and a helper would add EXECUTE grants
--     and one more function in the ACL checks. An image_urls array is joined with a newline and matched with
--     ONE regular expression ^(P(\nP)*)?$ (P = one path). A NULL element is refused with array_position, and an
--     element that itself contains a newline is refused by comparing the number of lines with the number of
--     elements. The expressions are the same as isOwnLookImagePath / isOwnNewsImagePath in the application.
--   * The constraints are added NOT VALID (P8): existing rows are not scanned and production rows are not
--     rewritten by this migration. NOT VALID still checks every INSERT and every UPDATE of a row, so the old
--     production rows must be read and normalised before a later VALIDATE migration. VALIDATE is NOT part of
--     this wave.
--   * admin_update_look (SEC-LOOK-015, P9): the route used to update looks, delete look_items and insert
--     look_items as three requests, so a failure in the middle left a look without its links. The function does
--     the three steps in ONE transaction and returns the image_urls from BEFORE the update (the route deletes
--     replaced images from the bucket with that list). The row is locked with SELECT ... FOR UPDATE first, so
--     two concurrent PUTs run one after the other and each one returns the list the other one left behind.
--     _image_urls NULL means "no new image": the function keeps the current image_urls itself, so a PUT without
--     images cannot overwrite what a concurrent PUT just stored. A failure in the link steps (other than a
--     foreign key violation 23503, which the route maps to 400) is re-raised as LOOK_ITEMS_WRITE_FAILED
--     (P0001) so the route keeps answering 500 "Failed to update linked items"; raising rolls back the row
--     update too. SECURITY INVOKER, search_path = '', EXECUTE for service_role only.
--
-- Order of rollout: apply this migration and deploy the PUT route change on the same day. The new route calls
-- admin_update_look; without the function every LOOK update fails with PGRST202. The sample data (seed.sql,
-- seed-storage.ts) must already use looks/e2e/... and news/e2e/... paths (Task 1), because the CHECKs refuse
-- the old e2e/... form on INSERT.
--
-- Idempotent: DROP POLICY IF EXISTS, CREATE OR REPLACE FUNCTION, REVOKE / GRANT, and every constraint is added
-- only when pg_constraint does not already have it.
--
-- ROLLBACK (Task 7; if the function is dropped, revert the PUT route of /api/admin/looks/[id] in the same
-- release, otherwise every LOOK update answers 500):
--   DROP POLICY IF EXISTS "anon reads links of published looks to published items" ON public.look_items;
--   DROP POLICY IF EXISTS "authenticated reads published links, admins read all" ON public.look_items;
--   CREATE POLICY "Anyone can view look items for published looks" ON "public"."look_items"
--     FOR SELECT
--     TO "anon"
--     USING ((EXISTS ( SELECT 1
--      FROM public.looks
--     WHERE ((looks.id = look_items.look_id) AND (looks.status = 'published'::text)))));
--   CREATE POLICY "authenticated look items read" ON "public"."look_items"
--     FOR SELECT
--     TO "authenticated"
--     USING ((public.has_permission('admin.looks.read'::text) OR (EXISTS ( SELECT 1
--      FROM public.looks
--     WHERE ((looks.id = look_items.look_id) AND (looks.status = 'published'::text))))));
--   (the two old policies are the ones in 20260901102912_remote_schema.sql lines 3499-3504 and 3528-3533;
--    no later migration changed them)
--   ALTER TABLE public.looks
--     DROP CONSTRAINT IF EXISTS looks_theme_length_check,
--     DROP CONSTRAINT IF EXISTS looks_theme_description_length_check,
--     DROP CONSTRAINT IF EXISTS looks_image_urls_path_check;
--   ALTER TABLE public.news_articles
--     DROP CONSTRAINT IF EXISTS news_articles_title_length_check,
--     DROP CONSTRAINT IF EXISTS news_articles_content_length_check,
--     DROP CONSTRAINT IF EXISTS news_articles_detailed_content_length_check,
--     DROP CONSTRAINT IF EXISTS news_articles_image_url_path_check;
--   DROP FUNCTION IF EXISTS public.admin_update_look(bigint, integer, text, text, text, text[], text, bigint[]);
BEGIN;

-- 1. look_items read policies: the parent look AND the linked item must be published
DROP POLICY IF EXISTS "Anyone can view look items for published looks" ON public.look_items;
DROP POLICY IF EXISTS "anon reads links of published looks to published items" ON public.look_items;
CREATE POLICY "anon reads links of published looks to published items" ON public.look_items
  FOR SELECT
  TO anon
  USING (
    EXISTS (SELECT 1 FROM public.looks AS l WHERE l.id = look_items.look_id AND l.status = 'published')
    AND EXISTS (SELECT 1 FROM public.items AS i WHERE i.id = look_items.item_id AND i.status = 'published')
  );

DROP POLICY IF EXISTS "authenticated look items read" ON public.look_items;
DROP POLICY IF EXISTS "authenticated reads published links, admins read all" ON public.look_items;
CREATE POLICY "authenticated reads published links, admins read all" ON public.look_items
  FOR SELECT
  TO authenticated
  USING (
    (
      EXISTS (SELECT 1 FROM public.looks AS l WHERE l.id = look_items.look_id AND l.status = 'published')
      AND EXISTS (SELECT 1 FROM public.items AS i WHERE i.id = look_items.item_id AND i.status = 'published')
    )
    OR (SELECT public.has_permission('admin.looks.read'::text))
  );

-- 2. admin_update_look: row + links in one transaction, returns the image_urls from before the update
CREATE OR REPLACE FUNCTION public.admin_update_look(
  _look_id bigint,
  _season_year integer,
  _season_type text,
  _theme text,
  _theme_description text,
  _image_urls text[],
  _status text,
  _item_ids bigint[]
)
RETURNS text[]
LANGUAGE plpgsql
SET search_path = ''
AS $admin_update_look$
DECLARE
  v_previous text[];
BEGIN
  SELECT l.image_urls INTO v_previous FROM public.looks AS l WHERE l.id = _look_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LOOK_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- _image_urls NULL = no new image = keep the current image_urls
  UPDATE public.looks
  SET season_year = _season_year,
      season_type = _season_type,
      theme = _theme,
      theme_description = _theme_description,
      image_urls = COALESCE(_image_urls, v_previous),
      status = _status
  WHERE id = _look_id;

  -- a failure in the link steps is re-marked so the route can answer 500 "Failed to update linked items";
  -- raising rolls back the update above as well
  BEGIN
    DELETE FROM public.look_items WHERE look_id = _look_id;
    INSERT INTO public.look_items (look_id, item_id)
      SELECT _look_id, d.x
      FROM (SELECT DISTINCT unnest(COALESCE(_item_ids, ARRAY[]::bigint[])) AS x) AS d;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'LOOK_ITEMS_WRITE_FAILED' USING ERRCODE = 'P0001';
  END;

  RETURN v_previous;
END
$admin_update_look$;

REVOKE ALL ON FUNCTION public.admin_update_look(bigint, integer, text, text, text, text[], text, bigint[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_look(bigint, integer, text, text, text, text[], text, bigint[])
  TO service_role;

-- 3. CHECK constraints, NOT VALID (no scan of existing rows; every new INSERT / UPDATE is checked)
--    P = looks/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*   (news: news/ instead of looks/)
DO $sec_rls_add_constraints$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('looks', 'looks_theme_length_check',
        $def$CHECK (char_length(theme) BETWEEN 1 AND 200)$def$),
      ('looks', 'looks_theme_description_length_check',
        $def$CHECK (char_length(theme_description) <= 4000)$def$),
      ('looks', 'looks_image_urls_path_check',
        $def$CHECK (
          array_position(image_urls, NULL) IS NULL
          AND cardinality(string_to_array(array_to_string(image_urls, E'\n'), E'\n')) = cardinality(image_urls)
          AND array_to_string(image_urls, E'\n') ~ '^(looks/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*(\nlooks/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*)*)?$'
        )$def$),
      ('news_articles', 'news_articles_title_length_check',
        $def$CHECK (char_length(title) <= 200)$def$),
      ('news_articles', 'news_articles_content_length_check',
        $def$CHECK (char_length(content) <= 2000)$def$),
      ('news_articles', 'news_articles_detailed_content_length_check',
        $def$CHECK (char_length(detailed_content) <= 10000)$def$),
      ('news_articles', 'news_articles_image_url_path_check',
        $def$CHECK (image_url ~ '^news/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$')$def$)
    ) AS t(tbl, name, def)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint AS c
      WHERE c.conrelid = format('public.%I', r.tbl)::regclass AND c.conname = r.name
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s NOT VALID', r.tbl, r.name, r.def);
    END IF;
  END LOOP;
END
$sec_rls_add_constraints$;

-- Self check: any failure rolls the whole migration back.
DO $sec_rls_predicates_and_constraints_assert$
DECLARE
  v_oid oid;
  v_qual text;
  v_policy text;
  v_public_grantee boolean;
  v_name text;
BEGIN
  -- (a) look_items: old policies gone, the two new ones check the item status; only the authenticated one has the admin branch
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'look_items'
      AND policyname IN ('Anyone can view look items for published looks', 'authenticated look items read')
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_rls_predicates_and_constraints:old_policy_left';
  END IF;
  FOREACH v_policy IN ARRAY ARRAY[
    'anon reads links of published looks to published items',
    'authenticated reads published links, admins read all'
  ] LOOP
    SELECT p.qual INTO v_qual FROM pg_policies AS p
    WHERE p.schemaname = 'public' AND p.tablename = 'look_items' AND p.policyname = v_policy AND p.cmd = 'SELECT';
    IF v_qual IS NULL
       OR (length(v_qual) - length(replace(v_qual, 'published', ''))) / length('published') < 2 THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_rls_predicates_and_constraints:policy_predicate:' || v_policy;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies AS p
    WHERE p.schemaname = 'public' AND p.tablename = 'look_items'
      AND p.policyname = 'authenticated reads published links, admins read all'
      AND p.roles = '{authenticated}' AND p.qual LIKE '%has_permission%admin.looks.read%'
  ) OR EXISTS (
    SELECT 1 FROM pg_policies AS p
    WHERE p.schemaname = 'public' AND p.tablename = 'look_items'
      AND p.policyname = 'anon reads links of published looks to published items'
      AND (p.roles <> '{anon}' OR p.qual LIKE '%has_permission%')
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_rls_predicates_and_constraints:policy_roles';
  END IF;

  -- (b) the 7 CHECK constraints exist and are NOT VALID
  FOREACH v_name IN ARRAY ARRAY[
    'looks.looks_theme_length_check', 'looks.looks_theme_description_length_check',
    'looks.looks_image_urls_path_check', 'news_articles.news_articles_title_length_check',
    'news_articles.news_articles_content_length_check', 'news_articles.news_articles_detailed_content_length_check',
    'news_articles.news_articles_image_url_path_check'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint AS c
      WHERE c.conrelid = format('public.%I', split_part(v_name, '.', 1))::regclass
        AND c.conname = split_part(v_name, '.', 2)
        AND c.contype = 'c' AND NOT c.convalidated
    ) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_rls_predicates_and_constraints:constraint:' || v_name;
    END IF;
  END LOOP;

  -- (c) admin_update_look: SECURITY INVOKER, search_path = '', service_role only, no PUBLIC grantee
  v_oid := to_regprocedure('public.admin_update_look(bigint,integer,text,text,text,text[],text,bigint[])');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_rls_predicates_and_constraints:function_missing';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_rls_predicates_and_constraints:function_execute';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM pg_proc AS p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
    WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_grantee;
  IF v_public_grantee THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_rls_predicates_and_constraints:function_public_grantee';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc AS p
    WHERE p.oid = v_oid AND NOT p.prosecdef AND p.proconfig = ARRAY['search_path=""']
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_rls_predicates_and_constraints:function_definition';
  END IF;
END
$sec_rls_predicates_and_constraints_assert$;

NOTIFY pgrst, 'reload schema';
COMMIT;
