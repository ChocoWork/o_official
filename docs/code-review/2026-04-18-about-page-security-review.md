# Code Review: about page and related flow

**Ready for Production**: No
**Critical Issues**: 4

## Scope

- src/app/about/page.tsx
- src/app/layout.tsx
- src/contexts/Providers.tsx
- src/components/Header.tsx
- src/components/Footer.tsx
- src/contexts/LoginContext.tsx
- src/app/api/auth/identify/route.ts
- src/features/auth/middleware/rateLimit.ts
- src/features/auth/ratelimit/index.ts
- src/lib/supabase/server.ts
- src/lib/audit.ts
- migrations/005_create_rate_limit_counters.sql
- migrations/007_create_audit_logs.sql

## Review Basis

- docs/4_DetailDesign/08_about.md

## Priority 1 (Must Fix)

1. Sensitive auth material is written to server logs in src/lib/supabase/server.ts.
   - Cookie header prefixes and token-related cookie fragments are logged.
   - This can expose session or bearer material via log access.
   - Fix: remove token and cookie value logging and keep only non-sensitive diagnostics.

2. The unauthenticated identify endpoint creates confirmed users before email ownership is proven in src/app/api/auth/identify/route.ts.
   - The route calls serviceRole.auth.admin.createUser with email_confirm: true for arbitrary submitted email addresses.
   - This lets an unauthenticated caller create confirmed auth records for third-party emails.
   - Fix: do not pre-create confirmed users. Use OTP sign-in or sign-up flow that only marks email as confirmed after successful proof of control.

3. Rate limiting fails open on backend errors in src/features/auth/middleware/rateLimit.ts and src/features/auth/ratelimit/index.ts.
   - DB or middleware errors allow the request to continue.
   - This weakens brute-force and abuse protection for the about-page login entry flow.
   - Fix: fail closed for sensitive auth endpoints or use a reliable fallback limiter.

4. Rate limit counter updates are not atomic in src/features/auth/ratelimit/index.ts.
   - The implementation performs select then update/insert, which can undercount concurrent requests.
   - This allows effective rate limit bypass under concurrency.
   - Fix: replace with a single atomic upsert or DB function.

## Recommended Changes

- Load third-party assets only on pages that need them instead of globally in src/app/layout.tsx.
- Prefer self-hosted or pinned-integrity static assets for icon fonts.