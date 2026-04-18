# Code Review: look
**Ready for Production**: No
**Critical Issues**: 3

## Scope
- Spec: docs/4_DetailDesign/06_look_list.md
- Pass 1: Frontend, rendered data, XSS
- Pass 2: API/backend, input validation, authorization, rate limiting
- Pass 3: DB, RLS, publication conditions, storage exposure, audit

## Reviewed Files
- src/app/look/page.tsx
- src/features/look/components/PublicLookGrid.tsx
- src/features/look/components/LookImageGallery.tsx
- src/lib/look/public.ts
- src/app/api/admin/looks/route.ts
- src/app/api/admin/looks/[id]/route.ts
- src/lib/auth/admin-rbac.ts
- src/lib/supabase/server.ts
- migrations/018_create_looks_and_look_images_bucket.sql
- migrations/019_add_public_select_policy_to_look_items.sql
- migrations/023_add_acl_rbac_tables_and_policies.sql
- migrations/016_create_items_and_item_images_bucket.sql
- migrations/007_create_audit_logs.sql

## Pass 1 Findings
- React escaping prevents straightforward reflected/stored XSS in theme, description, and item names.
- No dangerouslySetInnerHTML usage was found in the reviewed look list rendering path.
- Risk remains around externally reachable image URLs because rendered pages trust stored storage URLs as-is.

## Pass 2 Findings

### Priority 1 (Must Fix) ⛔
- Sensitive auth material is partially logged in src/lib/supabase/server.ts. Cookie header prefixes and decoded token fragments are written to logs during look page requests.
- Admin look APIs do not emit audit log entries for create/update/publish/delete operations, leaving no durable trail for privileged content changes.

### Recommended Changes
- Remove token and cookie value logging entirely, or replace with fixed metadata-only logging.
- Add audit logging around successful and failed admin look mutations.
- Add explicit abuse controls for admin image upload endpoints if the admin surface is internet-reachable.

## Pass 3 Findings

### Priority 1 (Must Fix) ⛔
- look-images bucket is public, so private/unpublished look images are directly retrievable by URL and are not governed by look publication status.

### Recommended Changes
- Make look-images a private bucket and serve images through signed URLs or an application proxy that verifies look status.
- If public delivery must remain, separate published and draft assets into different buckets and move assets only at publish time.

## Residual Risks
- Admin look APIs are authorization-protected, but no route-local rate limiting was found in the reviewed handlers.
- Public look pages use request-scoped auth when a user is signed in, so result shape can differ by viewer permissions unless item publication is filtered explicitly in the query.