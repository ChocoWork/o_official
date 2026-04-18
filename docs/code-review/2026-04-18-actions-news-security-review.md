# Code Review: actions news and related flow

**Ready for Production**: No
**Critical Issues**: 3

## Scope

- src/app/actions/news.ts
- Related public news read flow
- Related admin news API, RBAC, Supabase, RLS, audit design

## Review Basis

- docs/4_DetailDesign/02_news_list.md
- docs/4_DetailDesign/03_news_detail.md
- docs/4_DetailDesign/16_admin.md
- docs/3_ArchitectureDesign/hybrid-rbac.md

## Priority 1 (Must Fix)

1. Sensitive session data is written to server logs in src/lib/supabase/server.ts.
   - Cookie header prefixes and decoded token fragments are logged.
   - This can expose bearer or session material through log access.
   - Fix: remove token and cookie value logging entirely, keep only non-sensitive structured diagnostics.

2. Admin news DB access bypasses RLS by using the service role in src/app/api/admin/news/route.ts and src/app/api/admin/news/[id]/route.ts.
   - The code uses createServiceRoleClient() for reads and writes to news_articles.
   - This bypasses the permission-based RLS policies defined for authenticated users in migrations/023_add_acl_rbac_tables_and_policies.sql.
   - Fix: use a request-scoped authenticated client for news_articles queries so DB policies remain active; reserve service role only for operations that truly require it.

3. Privileged news mutations have no audit trail in src/app/api/admin/news/route.ts and src/app/api/admin/news/[id]/route.ts.
   - Create, update, status change, and delete do not call the existing audit utility.
   - This conflicts with the admin audit design in docs/4_DetailDesign/16_admin.md and weakens incident investigation.
   - Fix: log success and failure for every privileged news operation with actor, action, resource, resource_id, and outcome.

## Additional Risk

- Public news API accepts a user-controlled limit without an upper bound in src/app/api/news/route.ts and src/features/news/services/public.ts.
  - Fix: clamp limit to a small maximum and require pagination for larger result sets.