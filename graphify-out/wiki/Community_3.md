# Community 3

> 48 nodes · cohesion 0.06

## Key Concepts

- **createClient()** (32 connections) — `lib\supabase\server.ts`
- **route.ts** (13 connections) — `app\api\profile\route.ts`
- **requireCsrfOrDeny()** (10 connections) — `lib\csrfMiddleware.ts`
- **POST()** (10 connections) — `app\api\profile\route.ts`
- **server.ts** (9 connections) — `lib\supabase\server.ts`
- **resolveRequestUser()** (9 connections) — `lib\supabase\server.ts`
- **DELETE()** (8 connections) — `app\api\profile\route.ts`
- **GET()** (7 connections) — `app\api\orders\route.ts`
- **route.ts** (6 connections) — `app\api\admin\orders\route.ts`
- **GET()** (6 connections) — `app\api\profile\route.ts`
- **POST()** (6 connections) — `app\api\admin\orders\[id]\refund\route.ts`
- **getStripeServerClient()** (6 connections) — `lib\stripe\server.ts`
- **route.ts** (5 connections) — `app\api\orders\route.ts`
- **GET()** (5 connections) — `app\api\auth\me\route.ts`
- **upsertProfileRow()** (5 connections) — `app\api\profile\route.ts`
- **extractAccessTokenFromCookie()** (5 connections) — `lib\supabase\server.ts`
- **extractBearerToken()** (5 connections) — `lib\supabase\server.ts`
- **isMissingOptionalProfileColumnError()** (4 connections) — `app\api\profile\route.ts`
- **getPublicStockists()** (4 connections) — `features\stockist\services\public.ts`
- **extractAuthToken()** (4 connections) — `lib\supabase\server.ts`
- **extractCookieValue()** (4 connections) — `lib\supabase\server.ts`
- **extractSessionIdFromCookie()** (4 connections) — `lib\supabase\server.ts`
- **route.ts** (3 connections) — `app\api\auth\me\route.ts`
- **public.ts** (3 connections) — `features\stockist\services\public.ts`
- **fetchPaymentIntentMap()** (3 connections) — `app\api\admin\orders\route.ts`
- *... and 23 more nodes in this community*

## Relationships

- No strong cross-community connections detected

## Source Files

- `app\api\admin\orders\[id]\refund\route.ts`
- `app\api\admin\orders\route.ts`
- `app\api\auth\me\route.ts`
- `app\api\orders\route.ts`
- `app\api\profile\route.ts`
- `features\stockist\services\public.ts`
- `lib\csrfMiddleware.ts`
- `lib\stripe\server.ts`
- `lib\supabase\server.ts`

## Audit Trail

- EXTRACTED: 142 (65%)
- INFERRED: 77 (35%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*