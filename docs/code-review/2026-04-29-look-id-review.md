# Code Review: look/[id]
**Ready for Production**: No
**Critical Issues**: 0

## Scope
- Security pass focused on OWASP Top 10 (A01, A05, A09)
- Target: look detail route rendering path and related services
- Reviewed paths: src/app/look/[id]/**, src/lib/look/public.ts, src/lib/storage/look-images.ts, src/lib/auth/admin-rbac.ts, src/app/api/admin/looks/**

## Priority 1 (Must Fix) ⛔
- No new Priority 1 issue found in this additional pass.

## Recommended Changes

### 1. Medium - Internal error detail leakage in admin authorization path
- File: src/lib/auth/admin-rbac.ts
- Issue:
  - authorizeAdminPermission() returns err.message to clients on 500 responses.
  - This can expose internals of authz/DB/runtime behavior.
- Why this matters:
  - Violates least-information and can help attackers refine probing.
- Suggested fix:
  - Return a generic error body to clients.
  - Keep raw error details only in server logs.

### 2. Medium - Fail-open signed URL fallback for look images
- File: src/lib/storage/look-images.ts
- Issue:
  - signLookImageUrl() returns rawUrl when path extraction/signing fails.
  - If stored data is polluted, untrusted URL/path can be served as-is.
- Why this matters:
  - Weakens storage trust boundary and can cause unintended content delivery.
- Suggested fix:
  - Change fallback to fail-safe (null or placeholder image).
  - Add strict allowlist validation for object paths (e.g. looks/ prefix).

### 3. Low - Overly verbose RBAC decision logs
- File: src/lib/auth/admin-rbac.ts
- Issue:
  - Logs include user id, role, and full permission list in normal flow.
- Why this matters:
  - Increases sensitive operational metadata exposure in centralized logs.
- Suggested fix:
  - Log only minimum decision metadata (allow/deny, request id, permission key).

### 4. Low - Missing explicit route-param validation in admin look APIs
- Files: src/app/api/admin/looks/route.ts, src/app/api/admin/looks/[id]/route.ts
- Issue:
  - id is consumed as a raw string and passed to DB filters without a unified numeric schema validation.
- Why this matters:
  - Not a direct injection path with Supabase query builder, but it weakens fail-fast consistency.
- Suggested fix:
  - Validate route params with z.coerce.number().int().positive() at API boundary.

## Residual Risk
- src/app/api/looks/[id]/route.ts is currently absent; public detail logic is served via RSC + service modules. When adding this endpoint in the future, include input validation, explicit cache policy, and rate limiting from day one.