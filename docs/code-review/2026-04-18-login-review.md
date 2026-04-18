# Code Review: Login / Auth
**Ready for Production**: No
**Critical Issues**: 6

## Scope
- src/app/login/page.tsx
- src/components/LoginModal.tsx
- src/contexts/LoginContext.tsx
- src/app/auth/**
- src/app/api/auth/**
- src/lib/auth/**
- related auth utilities and migrations

## Spec Basis
- docs/4_DetailDesign/14_login.md
- docs/4_DetailDesign/01_auth_seq.md

## Review Plan
- Pass 1: Frontend, token exposure, XSS, error handling
- Pass 2: API/backend, authn/authz, CSRF, rate limiting, OAuth, session management
- Pass 3: DB/RLS, audit, secrets, account-link consistency

## Priority 1 (Must Fix) ⛔

### 1. Client-side token exposure breaks the HttpOnly session model
- Files:
  - src/contexts/LoginContext.tsx
  - src/lib/supabase/client.ts
  - src/app/api/auth/otp/verify/route.ts
  - src/app/api/auth/login/route.ts
  - src/app/api/auth/register/route.ts
  - src/app/api/auth/refresh/route.ts
- Problem:
  - The app sets auth cookies on the server, but also returns tokens in JSON and stores them in localStorage on the client.
  - This exposes refresh and access tokens to any XSS payload, browser extension, or shared-device inspection.
- Why this matters:
  - docs/4_DetailDesign/14_login.md and docs/4_DetailDesign/01_auth_seq.md require HttpOnly/Secure cookie handling and explicitly avoid leaving sensitive tokens exposed in browser-visible storage.
- Suggested fix:
  - Stop returning refresh tokens in JSON responses.
  - Stop persisting auth tokens in localStorage.
  - Use server-set HttpOnly cookies as the sole refresh transport.
  - Configure the browser Supabase client with persistSession: false and detectSessionInUrl: false for this flow unless a separate hardened client strategy is approved.

### 2. OAuth implementation bypasses the server-managed state/PKCE flow defined in the design
- Files:
  - src/contexts/LoginContext.tsx
  - src/app/auth/callback/page.tsx
  - src/app/api/auth/oauth/start/route.ts
  - src/app/api/auth/oauth/callback/route.ts
- Problem:
  - The real login flow calls signInWithOAuth directly from the browser and lands on a client page that runs exchangeCodeForSession.
  - The hardened server routes that store state/PKCE in oauth_requests are not used by the actual login button.
- Why this matters:
  - This bypasses DB-backed replay protection, audit coverage, server-controlled redirect handling, and the designed account-link policy.
- Suggested fix:
  - Route the Google sign-in button to /api/auth/oauth/start.
  - Complete code exchange only in /api/auth/oauth/callback.
  - Remove client-side exchangeCodeForSession from the page flow.

### 3. Sensitive auth information is logged on both client and server paths
- Files:
  - src/app/auth/callback/page.tsx
  - src/lib/supabase/server.ts
- Problem:
  - The OAuth callback page logs whether code exists and logs an access-token prefix from localStorage.
  - The server-side Supabase helper logs cookie headers and token-related cookie prefixes.
- Why this matters:
  - Auth tokens and session cookies must not appear in logs. Even partial token disclosure materially lowers the attack cost if logs are exposed.
- Suggested fix:
  - Remove token/cookie value logging entirely.
  - Log only request IDs and high-level outcomes.

### 4. Password reset token is delivered and processed as a client-visible query parameter
- Files:
  - src/app/api/auth/password-reset/request/route.ts
  - src/app/auth/password-reset/page.tsx
- Problem:
  - The reset email includes token and email in the URL query, and the page consumes the token client-side.
  - The URL remains in browser history and can be exposed through screenshots, copied URLs, or device sharing.
- Why this matters:
  - The auth sequence design requires one-time tokens to be verified server-side immediately and removed from the URL via a clean redirect.
- Suggested fix:
  - Move password reset confirmation to a server route that consumes the token once, sets no-store/no-referrer headers, and redirects to a clean UI URL.
  - Avoid putting email addresses into reset URLs when not strictly required.

### 5. Refresh/session reuse detection required by the design is not actually enforced
- Files:
  - src/app/api/auth/refresh/route.ts
  - src/features/auth/services/session.ts
  - migrations/004_create_sessions.sql
  - migrations/006_add_session_security_fields.sql
- Problem:
  - The refresh route rotates cookies, but it does not use current_jti, previous_refresh_token_hash, or quarantine logic to detect replay.
  - The dedicated session service exists but is effectively not wired into the refresh path.
- Why this matters:
  - A stolen refresh token should trigger replay detection and forced revocation, not just best-effort row replacement.
- Suggested fix:
  - Store and validate current_jti / previous_refresh_token_hash on every refresh.
  - On mismatch or reuse, quarantine and revoke all sessions for the user and emit an audit event.

### 6. Sensitive auth tables lack visible RLS / policy hardening in migrations
- Files:
  - migrations/004_create_sessions.sql
  - migrations/005_create_rate_limit_counters.sql
  - migrations/007_create_audit_logs.sql
  - migrations/011_create_oauth_requests.sql
- Problem:
  - The reviewed migrations create sessions, rate_limit_counters, audit_logs, and oauth_requests without enabling RLS or defining restrictive policies.
  - profiles gets RLS later, but auth-sensitive operational tables do not show equivalent hardening.
- Why this matters:
  - These tables contain hashed refresh state, CSRF material, audit trails, IP data, and OAuth PKCE state. They should be deny-by-default and service-role only.
- Suggested fix:
  - Enable RLS on these tables.
  - Add explicit service-role-only policies, or place them in a restricted schema with no client access.

## Important Issues

### 7. Password reset flow still depends on deprecated public.users instead of auth.users
- Files:
  - src/app/api/auth/password-reset/request/route.ts
  - src/app/api/auth/password-reset/confirm/route.ts
  - migrations/001_create_users.sql
  - migrations/002_create_profiles.sql
- Problem:
  - The code looks up user IDs from public.users even though the migration comments define auth.users as the source of truth.
- Why this matters:
  - This creates account-consistency drift and can break reset behavior in environments where public.users is absent or stale.
- Suggested fix:
  - Resolve the user via Supabase Auth admin APIs or auth.users-backed mechanisms only.

### 8. password_reset_tokens storage is referenced in code but not found in reviewed migrations
- Files:
  - src/app/api/auth/password-reset/request/route.ts
  - src/app/api/auth/password-reset/confirm/route.ts
- Problem:
  - The routes rely on password_reset_tokens, but no corresponding migration was found in the reviewed migration set.
- Why this matters:
  - Missing schema for auth-critical tokens leads to runtime failure or environment drift.
- Suggested fix:
  - Add a migration for password_reset_tokens with expiry indexes, one-time-use enforcement, and restricted RLS/policies.

## Residual Risks
- WAF/CDN settings are documented but not verifiable from this repository.
- Supabase dashboard OTP mode and Google provider configuration remain partially operational checks outside code.