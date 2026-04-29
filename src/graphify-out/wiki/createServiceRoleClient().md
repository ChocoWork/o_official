# createServiceRoleClient()

> 100 nodes · cohesion 0.05

## Key Concepts

- **createServiceRoleClient()** (52 connections) — `lib\supabase\server.ts`
- **GET()** (44 connections) — `app\api\wishlist\route.ts`
- **logAudit()** (36 connections) — `lib\audit.ts`
- **enforceRateLimit()** (30 connections) — `features\auth\middleware\rateLimit.ts`
- **POST()** (15 connections) — `app\api\auth\refresh\route.ts`
- **getRequestOrigin()** (14 connections) — `lib\redirect.ts`
- **POST()** (14 connections) — `app\api\auth\register\route.ts`
- **persistSessionAndCookies()** (14 connections) — `features\auth\services\register.ts`
- **POST()** (13 connections) — `app\api\auth\login\route.ts`
- **tokenHashSha256()** (11 connections) — `lib\hash.ts`
- **POST()** (11 connections) — `app\api\auth\password-reset\request\route.ts`
- **cookieOptionsForCsrf()** (10 connections) — `lib\cookie.ts`
- **requireCsrfOrDeny()** (10 connections) — `lib\csrfMiddleware.ts`
- **GET()** (9 connections) — `app\api\auth\confirm\route.ts`
- **POST()** (9 connections) — `app\api\contact\route.ts`
- **POST()** (9 connections) — `app\api\auth\logout\route.ts`
- **POST()** (8 connections) — `app\api\auth\identify\route.ts`
- **cookie.ts** (8 connections) — `lib\cookie.ts`
- **GET()** (8 connections) — `app\api\auth\password-reset\link\route.ts`
- **GET()** (8 connections) — `app\api\auth\oauth\start\route.ts`
- **GET()** (7 connections) — `app\api\auth\oauth\callback\route.ts`
- **POST()** (7 connections) — `app\api\auth\password-reset\confirm\route.ts`
- **getBaseCookieOptions()** (7 connections) — `lib\cookie.ts`
- **redirect.ts** (7 connections) — `lib\redirect.ts`
- **formatZodError()** (7 connections) — `features\auth\schemas\common.ts`
- *... and 75 more nodes in this community*

## Relationships

- [[PublicItemGrid.tsx]] (84 shared connections)
- [[DELETE()]] (80 shared connections)
- [[page.tsx]] (76 shared connections)
- [[clientFetch()]] (26 shared connections)
- [[authorizeAdminPermission()]] (25 shared connections)
- [[createClient()]] (11 shared connections)
- [[createPublicClient()]] (6 shared connections)
- [[SearchPageClient.tsx]] (5 shared connections)
- [[ItemDetailClient.tsx]] (2 shared connections)
- [[route.ts]] (2 shared connections)
- [[getPublishedItemsPage()]] (2 shared connections)
- [[NewsForm.tsx]] (2 shared connections)

## Source Files

- `app\api\admin\create-user\route.ts`
- `app\api\admin\orders\[id]\refund\route.ts`
- `app\api\admin\revoke-user-sessions\route.ts`
- `app\api\auth\confirm\route.ts`
- `app\api\auth\identify\route.ts`
- `app\api\auth\login\route.ts`
- `app\api\auth\logout\route.ts`
- `app\api\auth\oauth\callback\route.ts`
- `app\api\auth\oauth\start\route.ts`
- `app\api\auth\otp\verify\route.ts`
- `app\api\auth\password-reset\confirm\route.ts`
- `app\api\auth\password-reset\link\route.ts`
- `app\api\auth\password-reset\request\route.ts`
- `app\api\auth\refresh\route.ts`
- `app\api\auth\register\route.ts`
- `app\api\checkout\payment-intent\route.ts`
- `app\api\contact\route.ts`
- `app\api\wishlist\route.ts`
- `features\auth\middleware\rateLimit.ts`
- `features\auth\schemas\common.ts`

## Audit Trail

- EXTRACTED: 205 (35%)
- INFERRED: 381 (65%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*