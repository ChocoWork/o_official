# Community 0

> 62 nodes · cohesion 0.08

## Key Concepts

- **createServiceRoleClient()** (52 connections) — `lib\supabase\server.ts`
- **POST()** (15 connections) — `app\api\auth\refresh\route.ts`
- **POST()** (14 connections) — `app\api\auth\register\route.ts`
- **persistSessionAndCookies()** (14 connections) — `features\auth\services\register.ts`
- **POST()** (13 connections) — `app\api\auth\login\route.ts`
- **tokenHashSha256()** (11 connections) — `lib\hash.ts`
- **POST()** (11 connections) — `app\api\auth\password-reset\request\route.ts`
- **cookieOptionsForCsrf()** (10 connections) — `lib\cookie.ts`
- **POST()** (9 connections) — `app\api\auth\logout\route.ts`
- **cookie.ts** (8 connections) — `lib\cookie.ts`
- **GET()** (8 connections) — `app\api\auth\password-reset\link\route.ts`
- **POST()** (7 connections) — `app\api\auth\password-reset\confirm\route.ts`
- **getBaseCookieOptions()** (7 connections) — `lib\cookie.ts`
- **formatZodError()** (7 connections) — `features\auth\schemas\common.ts`
- **POST()** (7 connections) — `app\api\auth\otp\verify\route.ts`
- **cookieOptionsForAccess()** (6 connections) — `lib\cookie.ts`
- **cookieOptionsForRefresh()** (6 connections) — `lib\cookie.ts`
- **refreshSession()** (6 connections) — `features\auth\services\refresh.ts`
- **cookieOptionsForPasswordReset()** (5 connections) — `lib\cookie.ts`
- **cookieOptionsForSession()** (5 connections) — `lib\cookie.ts`
- **generateCsrfToken()** (5 connections) — `lib\csrf.ts`
- **hash.ts** (5 connections) — `lib\hash.ts`
- **findSessionByRefreshHash()** (5 connections) — `features\auth\services\session.ts`
- **session.ts** (4 connections) — `features\auth\services\session.ts`
- **clearCookieOptions()** (4 connections) — `lib\cookie.ts`
- *... and 37 more nodes in this community*

## Relationships

- No strong cross-community connections detected

## Source Files

- `app\api\auth\login\route.ts`
- `app\api\auth\logout\route.ts`
- `app\api\auth\otp\verify\route.ts`
- `app\api\auth\password-reset\confirm\route.ts`
- `app\api\auth\password-reset\link\route.ts`
- `app\api\auth\password-reset\request\route.ts`
- `app\api\auth\password-reset\session\route.ts`
- `app\api\auth\refresh\route.ts`
- `app\api\auth\register\route.ts`
- `features\auth\schemas\common.ts`
- `features\auth\services\auth-admin-user.ts`
- `features\auth\services\refresh.ts`
- `features\auth\services\register.ts`
- `features\auth\services\session.ts`
- `lib\auditCleanup.ts`
- `lib\cookie.ts`
- `lib\csrf.ts`
- `lib\hash.ts`
- `lib\supabase\server.ts`
- `lib\turnstile.ts`

## Audit Trail

- EXTRACTED: 119 (36%)
- INFERRED: 208 (64%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*