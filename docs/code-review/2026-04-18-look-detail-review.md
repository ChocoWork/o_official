# Code Review: look/[id]
**Ready for Production**: No
**Critical Issues**: 3

## Scope
- Pass 1: Frontend, ID parameter, XSS, information exposure
- Pass 2: API/backend, input validation, authorization, rate limiting
- Pass 3: DB, RLS, publication conditions, related item exposure, storage, audit

## Reviewed Files
- src/app/look/[id]/page.tsx
- src/features/look/components/LookImageGallery.tsx
- src/components/ui/List.tsx
- src/lib/look/public.ts
- src/lib/supabase/server.ts
- src/app/api/admin/looks/route.ts
- src/app/api/admin/looks/[id]/route.ts
- src/app/api/admin/items/route.ts
- src/app/api/admin/items/[id]/route.ts
- migrations/016_create_items_and_item_images_bucket.sql
- migrations/018_create_looks_and_look_images_bucket.sql
- migrations/019_add_public_select_policy_to_look_items.sql
- migrations/023_add_acl_rbac_tables_and_policies.sql
- docs/4_DetailDesign/07_look_detail.md

## Priority 1 (Must Fix) ⛔

### 1. Private item IDs can be exposed through look_items
- File: migrations/019_add_public_select_policy_to_look_items.sql
- Issue: The public SELECT policy on public.look_items only checks that the parent look is published. If a published look is linked to a private item, anonymous clients can still read the item_id values directly from look_items, which leaks unpublished product identifiers and link structure.
- Fix: Restrict public SELECT to rows where both the look and the linked item are published, or replace direct table access with a security-filtered view/RPC that returns only publishable item associations.

### 2. Private look/item images are publicly accessible once uploaded
- Files: migrations/016_create_items_and_item_images_bucket.sql, migrations/018_create_looks_and_look_images_bucket.sql, src/app/api/admin/items/route.ts, src/app/api/admin/items/[id]/route.ts, src/app/api/admin/looks/route.ts, src/app/api/admin/looks/[id]/route.ts
- Issue: Both storage buckets are created as public, and admin APIs store public URLs immediately at upload time. That means assets for private looks/items remain internet-accessible by URL even when the database row is still private.
- Fix: Use private buckets plus signed URLs for published delivery, or move files from a private staging bucket to a public bucket only at publish time. Also add storage object policies aligned with item/look publication state.

### 3. Published looks can be linked to private items
- Files: src/app/api/admin/looks/route.ts, src/app/api/admin/looks/[id]/route.ts
- Issue: The create/update validation only checks linked item existence, not whether linked items are publishable when the look status is published. This allows creating a published look that references private items, which is the precondition for the ID-leak issue above and creates inconsistent public behavior.
- Fix: When status is published, require every linked item to be published before insert/update. Reject mixed-visibility combinations or automatically downgrade the look to private until all linked items are published.

## Residual Risks
- src/lib/look/public.ts currently relies on RLS rather than explicit item status filtering. It is safe with the current anon/request-scoped client, but future refactors using service-role access here would widen exposure unless publication filters remain explicit.
- src/lib/supabase/server.ts contains verbose auth/cookie logging. This was not the primary target of the review, but it increases secret leakage risk if logs are retained centrally.