# Community 1

> 52 nodes · cohesion 0.06

## Key Concepts

- **logAudit()** (36 connections) — `lib\audit.ts`
- **DELETE()** (33 connections) — `app\api\wishlist\[id]\route.ts`
- **enforceRateLimit()** (30 connections) — `features\auth\middleware\rateLimit.ts`
- **GET()** (26 connections) — `app\api\orders\[id]\route.ts`
- **PATCH()** (22 connections) — `app\api\cart\[id]\route.ts`
- **PUT()** (21 connections) — `app\api\admin\stockists\[id]\route.ts`
- **POST()** (9 connections) — `app\api\admin\stockists\route.ts`
- **admin-security.ts** (8 connections) — `features\stockist\services\admin-security.ts`
- **POST()** (8 connections) — `app\api\auth\identify\route.ts`
- **logAdminLookAudit()** (7 connections) — `features\look\services\admin-audit.ts`
- **applyRotatedCsrfCookie()** (7 connections) — `features\stockist\services\admin-security.ts`
- **toCsrfDenyResponse()** (7 connections) — `features\stockist\services\admin-security.ts`
- **route.ts** (6 connections) — `app\api\admin\news\[id]\route.ts`
- **route.ts** (6 connections) — `app\api\orders\[id]\route.ts`
- **logNewsAudit()** (6 connections) — `app\api\admin\news\[id]\route.ts`
- **enforceAdminLookMutationRateLimit()** (6 connections) — `features\look\services\admin-rate-limit.ts`
- **enforceAdminStockistMutationRateLimit()** (6 connections) — `features\stockist\services\admin-security.ts`
- **requireAdminStockistCsrf()** (6 connections) — `features\stockist\services\admin-security.ts`
- **route.ts** (5 connections) — `app\api\admin\items\[id]\route.ts`
- **route.ts** (5 connections) — `app\api\admin\looks\[id]\route.ts`
- **route.ts** (5 connections) — `app\api\admin\stockists\[id]\route.ts`
- **getClientIp()** (5 connections) — `app\api\wishlist\[id]\route.ts`
- **parseStockistId()** (5 connections) — `app\api\admin\stockists\[id]\route.ts`
- **GET()** (5 connections) — `app\api\admin\stockists\route.ts`
- **route.ts** (4 connections) — `app\api\cart\[id]\route.ts`
- *... and 27 more nodes in this community*

## Relationships

- No strong cross-community connections detected

## Source Files

- `app\api\admin\item-color-presets\[id]\route.ts`
- `app\api\admin\items\[id]\route.ts`
- `app\api\admin\looks\[id]\route.ts`
- `app\api\admin\news\[id]\route.ts`
- `app\api\admin\stockists\[id]\route.ts`
- `app\api\admin\stockists\route.ts`
- `app\api\auth\identify\route.ts`
- `app\api\cart\[id]\route.ts`
- `app\api\checkout\payment-intent\route.ts`
- `app\api\items\[id]\route.ts`
- `app\api\orders\[id]\route.ts`
- `app\api\wishlist\[id]\route.ts`
- `features\auth\middleware\rateLimit.ts`
- `features\look\services\admin-audit.ts`
- `features\look\services\admin-rate-limit.ts`
- `features\stockist\services\admin-security.ts`
- `lib\audit.ts`

## Audit Trail

- EXTRACTED: 177 (51%)
- INFERRED: 169 (49%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*