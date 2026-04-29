# DELETE()

> 57 nodes · cohesion 0.08

## Key Concepts

- **DELETE()** (33 connections) — `app\api\wishlist\[id]\route.ts`
- **GET()** (26 connections) — `app\api\orders\[id]\route.ts`
- **PATCH()** (22 connections) — `app\api\cart\[id]\route.ts`
- **PUT()** (21 connections) — `app\api\admin\stockists\[id]\route.ts`
- **POST()** (10 connections) — `app\api\admin\looks\route.ts`
- **POST()** (9 connections) — `app\api\admin\stockists\route.ts`
- **admin-security.ts** (8 connections) — `features\stockist\services\admin-security.ts`
- **logAdminLookAudit()** (7 connections) — `features\look\services\admin-audit.ts`
- **applyRotatedCsrfCookie()** (7 connections) — `features\stockist\services\admin-security.ts`
- **toCsrfDenyResponse()** (7 connections) — `features\stockist\services\admin-security.ts`
- **route.ts** (6 connections) — `app\api\admin\news\[id]\route.ts`
- **route.ts** (6 connections) — `app\api\orders\[id]\route.ts`
- **logNewsAudit()** (6 connections) — `app\api\admin\news\[id]\route.ts`
- **consumeAdminLookUploadQuota()** (6 connections) — `features\look\services\admin-rate-limit.ts`
- **enforceAdminLookMutationRateLimit()** (6 connections) — `features\look\services\admin-rate-limit.ts`
- **enforceAdminStockistMutationRateLimit()** (6 connections) — `features\stockist\services\admin-security.ts`
- **requireAdminStockistCsrf()** (6 connections) — `features\stockist\services\admin-security.ts`
- **route.ts** (5 connections) — `app\api\admin\items\[id]\route.ts`
- **route.ts** (5 connections) — `app\api\admin\looks\[id]\route.ts`
- **route.ts** (5 connections) — `app\api\admin\stockists\[id]\route.ts`
- **admin-rate-limit.ts** (5 connections) — `features\look\services\admin-rate-limit.ts`
- **getClientIp()** (5 connections) — `app\api\wishlist\[id]\route.ts`
- **parseStockistId()** (5 connections) — `app\api\admin\stockists\[id]\route.ts`
- **incrementCounter()** (5 connections) — `features\auth\ratelimit\index.ts`
- **incrementCounterBy()** (5 connections) — `features\auth\ratelimit\index.ts`
- *... and 32 more nodes in this community*

## Relationships

- [[SearchPageClient.tsx]] (50 shared connections)
- [[createServiceRoleClient()]] (13 shared connections)
- [[authorizeAdminPermission()]] (8 shared connections)
- [[clientFetch()]] (8 shared connections)
- [[page.tsx]] (6 shared connections)
- [[getPublishedItemsPage()]] (1 shared connections)
- [[LoginModal.tsx]] (1 shared connections)
- [[hash.ts]] (1 shared connections)
- [[client.tsx]] (1 shared connections)
- [[PublicNewsGrid.tsx]] (1 shared connections)
- [[look-images.ts]] (1 shared connections)
- [[createPublicClient()]] (1 shared connections)

## Source Files

- `app\api\admin\item-color-presets\[id]\route.ts`
- `app\api\admin\items\[id]\route.ts`
- `app\api\admin\looks\[id]\route.ts`
- `app\api\admin\looks\route.ts`
- `app\api\admin\news\[id]\route.ts`
- `app\api\admin\stockists\[id]\route.ts`
- `app\api\admin\stockists\route.ts`
- `app\api\cart\[id]\route.ts`
- `app\api\items\[id]\route.ts`
- `app\api\orders\[id]\route.ts`
- `app\api\wishlist\[id]\route.ts`
- `features\auth\ratelimit\index.ts`
- `features\look\services\admin-audit.ts`
- `features\look\services\admin-rate-limit.ts`
- `features\stockist\services\admin-security.ts`
- `lib\auditCleanup.ts`

## Audit Trail

- EXTRACTED: 200 (63%)
- INFERRED: 118 (37%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*