# Code Review: Account

**Ready for Production**: No
**Critical Issues**: 4

## Review Scope

- Specs: docs/4_DetailDesign/15_account.md, docs/4_DetailDesign/14_login.md, docs/3_ArchitectureDesign/hybrid-rbac.md
- App: src/app/account/page.tsx, src/app/account/orders/[id]/page.tsx
- API: src/app/api/profile/route.ts, src/app/api/orders/route.ts, src/app/api/orders/[id]/route.ts, src/app/api/auth/logout/route.ts
- Auth/Supabase: src/contexts/LoginContext.tsx, src/lib/client-fetch.ts, src/lib/supabase/server.ts, src/lib/cookie.ts, src/lib/csrfMiddleware.ts
- DB/RLS: migrations/002_create_profiles.sql, migrations/004_create_sessions.sql, migrations/007_create_audit_logs.sql, migrations/022_add_optional_profile_fields.sql, migrations/025_create_orders.sql

## Priority 1 (Must Fix) ⛔

### 1. Sensitive auth data is written to application logs

- File: src/lib/supabase/server.ts
- Evidence: lines 93, 151, 152, 163
- Issue: Cookie header and token fragments are logged, including raw and decoded cookie values for auth-related cookies.
- Impact: Access token or session cookie leakage into logs expands blast radius for any log access compromise.
- Fix:
  - Remove cookie header and token value logging entirely.
  - If request correlation is needed, log only boolean presence flags and request IDs.

### 2. OTP session tokens are persisted in localStorage

- File: src/contexts/LoginContext.tsx
- Related flow: src/lib/client-fetch.ts, src/app/account/page.tsx, src/app/account/orders/[id]/page.tsx
- Evidence: lines 128-138, 208
- Issue: Access token and refresh token are stored in localStorage under supabase.auth.token and reused for authenticated account API calls.
- Impact: Any XSS in the origin can exfiltrate long-lived session material and fully impersonate the user.
- Fix:
  - Stop persisting access and refresh tokens in localStorage.
  - Use HttpOnly secure cookies only, or keep bearer tokens strictly in memory if unavoidable.
  - Update clientFetch to rely on same-origin cookies instead of localStorage token extraction.

### 3. Profile mutation endpoints do not enforce CSRF protection

- File: src/app/api/profile/route.ts
- Evidence: POST at line 205 and DELETE at line 252 resolve the user but do not call csrf middleware; compare with src/app/api/auth/logout/route.ts lines 42-44.
- Issue: State-changing profile endpoints accept cookie-authenticated requests without double-submit verification.
- Impact: Personal profile data can be modified or cleared without the CSRF controls already used elsewhere in the auth stack.
- Fix:
  - Require csrf validation on POST and DELETE before processing.
  - Apply the same requireCsrfOrDeny pattern already used by logout.

### 4. Sensitive service-role tables lack explicit RLS hardening in migrations

- Files: migrations/004_create_sessions.sql, migrations/007_create_audit_logs.sql
- Evidence: sessions and audit_logs table creation is present, but the reviewed migrations do not enable RLS or define deny-by-default policies for these tables.
- Issue: Database-side protection for session and audit data is not explicitly enforced in the schema reviewed for account/auth flows.
- Impact: Protection depends on external privilege assumptions instead of an explicit DB security boundary.
- Fix:
  - Enable RLS on public.sessions and public.audit_logs.
  - Add no-access policies for anon/authenticated users and keep writes/reads restricted to vetted server-side paths.

## Additional Observations

- Profiles RLS is present in migrations/022_add_optional_profile_fields.sql.
- Orders and order_items RLS is present in migrations/025_create_orders.sql.
- No use of dangerouslySetInnerHTML was found in the reviewed account UI paths.
- No audit logging was found in src/app/api/profile/route.ts or src/app/api/orders/*. This reduces traceability for PII access and mutation, but the four issues above are the immediate blockers.