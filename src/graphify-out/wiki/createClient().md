# createClient()

> 36 nodes · cohesion 0.11

## Key Concepts

- **createClient()** (32 connections) — `lib\supabase\server.ts`
- **route.ts** (13 connections) — `app\api\profile\route.ts`
- **POST()** (10 connections) — `app\api\profile\route.ts`
- **server.ts** (9 connections) — `lib\supabase\server.ts`
- **resolveRequestUser()** (9 connections) — `lib\supabase\server.ts`
- **DELETE()** (8 connections) — `app\api\profile\route.ts`
- **GET()** (7 connections) — `app\api\orders\route.ts`
- **GET()** (6 connections) — `app\api\profile\route.ts`
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
- **buildLegacyProfileUpsertPayload()** (3 connections) — `app\api\profile\route.ts`
- **buildProfileUpsertPayload()** (3 connections) — `app\api\profile\route.ts`
- **clearProfileRow()** (3 connections) — `app\api\profile\route.ts`
- **fetchProfileRow()** (3 connections) — `app\api\profile\route.ts`
- **hasAddressValue()** (3 connections) — `app\api\profile\route.ts`
- *... and 11 more nodes in this community*

## Relationships

- [[clientFetch()]] (147 shared connections)
- [[DELETE()]] (8 shared connections)
- [[createServiceRoleClient()]] (6 shared connections)
- [[authorizeAdminPermission()]] (6 shared connections)
- [[route.ts]] (5 shared connections)
- [[page.tsx]] (4 shared connections)
- [[createPublicClient()]] (2 shared connections)
- [[NewsForm.tsx]] (2 shared connections)
- [[Auth Detailed Design Stub]] (1 shared connections)

## Source Files

- `app\api\auth\me\route.ts`
- `app\api\orders\route.ts`
- `app\api\profile\route.ts`
- `features\stockist\services\public.ts`
- `lib\supabase\server.ts`

## Audit Trail

- EXTRACTED: 124 (69%)
- INFERRED: 57 (31%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*