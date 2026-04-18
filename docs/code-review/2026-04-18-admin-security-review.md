# Code Review: Admin Security Surface
**Ready for Production**: No
**Critical Issues**: 7

## Scope
- src/app/admin/**
- src/components/AdminTabs.tsx
- src/app/api/admin/**
- src/lib/auth/**
- related DB/RLS migrations
- specs: docs/4_DetailDesign/16_admin.md, docs/3_ArchitectureDesign/hybrid-rbac.md

## Review Plan
1. Pass 1: Frontend/page rendering, role-based UI, information exposure
2. Pass 2: API/backend/authz/CSRF/rate limiting/IDOR
3. Pass 3: DB/RLS/audit/secrets/permission-model consistency

## Priority 1 (Must Fix) ⛔

### 1. Unauthenticated admin user creation endpoint
- File: src/app/api/admin/create-user/route.ts
- Issue: The route calls Service Role `auth.admin.createUser()` with no authentication or authorization check.
- Impact: Anyone who can reach the endpoint can create privileged or operational accounts through a Service Role path.
- Fix: Require `authorizeAdminPermission('admin.users.manage', request)` and log actor identity.

### 2. Refund authorization is broader than the spec
- File: src/app/api/admin/orders/[id]/refund/route.ts
- Issue: The route authorizes `admin.orders.manage`, which is granted to `supporter` by `legacyPermissionMap`, while the spec requires refunds to be `admin` only.
- Impact: A supporter can issue Stripe refunds.
- Fix: Require an explicit admin-only check after permission validation, or introduce a dedicated `admin.orders.refund` permission.

### 3. Static shared secret used instead of user-bound admin auth
- Files: src/app/api/admin/audit-logs/route.ts, src/app/api/admin/revoke-user-sessions/route.ts
- Issue: Both routes trust `x-admin-token === ADMIN_API_KEY` and bypass session-bound user auth, RBAC, 2FA state, and actor attribution.
- Impact: Possession of one shared secret is sufficient to read audit logs or revoke any user's sessions.
- Fix: Replace shared-secret auth with `authorizeAdminPermission(...)` and user-bound audit logging. Keep machine-to-machine access on a separate internal route if needed.

### 4. Hybrid RBAC implementation treats token role as an authorization source, not just a hint
- File: src/lib/auth/admin-rbac.ts
- Issue: `authorizeAdminPermission()` grants access when either DB ACL or `legacyPermissionMap[tokenRole]` allows it.
- Impact: Stale `app_metadata.role` can preserve access after DB revocation or expiry, which breaks the documented “DB ACL as authority” model.
- Fix: Use DB ACL as the final authorization source for protected operations. Token role can remain a UI hint or short-lived optimization only when cryptographically trusted and synchronized.

## Important Issues

### 5. Admin 2FA enforcement described in the spec is not enforced in admin auth gates
- Files: src/app/admin/page.tsx, src/lib/auth/admin-rbac.ts
- Issue: The admin page and API authz check only login state and role/permission; there is no verified 2FA/MFA state check before allowing admin access.
- Impact: Admin access is not blocked when 2FA is absent, contrary to the documented onboarding and access policy.
- Fix: Add a mandatory MFA state check in the admin page guard and in `authorizeAdminPermission()` for admin-capable roles.

### 6. Critical role changes are not audit logged
- File: src/app/api/admin/users/route.ts
- Issue: `PATCH` updates both `app_metadata.role` and `user_roles` but does not emit an audit log.
- Impact: Privilege escalation/reduction is not traceable, despite the spec marking role changes as important audit events.
- Fix: Log success/failure with actor, target user, previous role, next role, IP, and user-agent.

### 7. Audit log table lacks the documented DB-side integrity and access-control protections
- Files: migrations/007_create_audit_logs.sql, src/lib/audit.ts
- Issue: The migration creates `audit_logs` without RLS policies, append-only constraints, or integrity/hash mechanisms described in the admin design.
- Impact: The DB layer does not enforce admin-only access or tamper-evident storage for audit data.
- Fix: Enable RLS, add admin-only read policies, deny direct mutation except controlled insert path, and add integrity controls or immutable archival.

## Residual Risk
- Admin order and KPI routes rely on Service Role reads/writes rather than DB-enforced admin RLS, so defense-in-depth is weaker than the documented model for those datasets.