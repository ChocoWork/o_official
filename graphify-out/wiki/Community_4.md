# Community 4

> 37 nodes · cohesion 0.05

## Key Concepts

- **GET()** (44 connections) — `app\api\wishlist\route.ts`
- **POST()** (12 connections) — `app\api\checkout\create-session\route.ts`
- **POST()** (9 connections) — `app\api\contact\route.ts`
- **proxy()** (8 connections) — `proxy.ts`
- **postal-code.service.ts** (7 connections) — `features\checkout\services\postal-code.service.ts`
- **proxy.ts** (6 connections) — `proxy.ts`
- **POST()** (6 connections) — `app\api\wishlist\route.ts`
- **POST()** (5 connections) — `app\api\admin\revoke-user-sessions\route.ts`
- **fetchAddressByPostalCode()** (5 connections) — `features\checkout\services\postal-code.service.ts`
- **route.ts** (4 connections) — `app\api\contact\route.ts`
- **isSameOriginRequest()** (4 connections) — `app\api\contact\route.ts`
- **getCachedAddress()** (4 connections) — `features\checkout\services\postal-code.service.ts`
- **getServiceRoleClient()** (4 connections) — `features\checkout\services\postal-code.service.ts`
- **isSameOriginRequest()** (4 connections) — `proxy.ts`
- **sendMail()** (3 connections) — `lib\mail\adapters\ses.ts`
- **route.ts** (3 connections) — `app\api\wishlist\route.ts`
- **getClientIp()** (3 connections) — `app\api\contact\route.ts`
- **getClientIp()** (3 connections) — `app\api\checkout\create-session\route.ts`
- **checkout-pricing.service.ts** (3 connections) — `features\checkout\services\checkout-pricing.service.ts`
- **GET()** (3 connections) — `app\api\checkout\postal-code\route.ts`
- **calculateCheckoutAmountsFromCartRows()** (3 connections) — `features\checkout\services\checkout-pricing.service.ts`
- **getDbCachedAddress()** (3 connections) — `features\checkout\services\postal-code.service.ts`
- **resolveRequestOrigin()** (3 connections) — `proxy.ts`
- **getClientIp()** (3 connections) — `app\api\wishlist\route.ts`
- **route.ts** (2 connections) — `app\api\checkout\create-session\route.ts`
- *... and 12 more nodes in this community*

## Relationships

- No strong cross-community connections detected

## Source Files

- `app\api\admin\revoke-user-sessions\route.ts`
- `app\api\checkout\create-session\route.ts`
- `app\api\checkout\postal-code\route.ts`
- `app\api\contact\route.ts`
- `app\api\wishlist\route.ts`
- `features\checkout\services\checkout-pricing.service.ts`
- `features\checkout\services\postal-code.service.ts`
- `lib\mail\adapters\ses.ts`
- `proxy.ts`

## Audit Trail

- EXTRACTED: 90 (52%)
- INFERRED: 84 (48%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*