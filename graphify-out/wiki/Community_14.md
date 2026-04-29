# Community 14

> 14 nodes · cohesion 0.02

## Key Concepts

- **POST()** (10 connections) — `app\api\admin\looks\route.ts`
- **consumeAdminLookUploadQuota()** (6 connections) — `features\look\services\admin-rate-limit.ts`
- **admin-rate-limit.ts** (5 connections) — `features\look\services\admin-rate-limit.ts`
- **incrementCounter()** (5 connections) — `features\auth\ratelimit\index.ts`
- **incrementCounterBy()** (5 connections) — `features\auth\ratelimit\index.ts`
- **index.ts** (4 connections) — `features\auth\ratelimit\index.ts`
- **GET()** (4 connections) — `app\api\admin\looks\route.ts`
- **route.ts** (3 connections) — `app\api\admin\looks\route.ts`
- **extractCounterResult()** (3 connections) — `features\auth\ratelimit\index.ts`
- **normalizeCounterTarget()** (3 connections) — `features\auth\ratelimit\index.ts`
- **validateLookImageBatch()** (3 connections) — `features\look\services\admin-rate-limit.ts`
- **parseJsonField()** (2 connections) — `app\api\admin\looks\route.ts`
- **buildHourlyBucketIso()** (2 connections) — `features\look\services\admin-rate-limit.ts`
- **buildRateLimitErrorResponse()** (2 connections) — `features\look\services\admin-rate-limit.ts`

## Relationships

- No strong cross-community connections detected

## Source Files

- `app\api\admin\looks\route.ts`
- `features\auth\ratelimit\index.ts`
- `features\look\services\admin-rate-limit.ts`

## Audit Trail

- EXTRACTED: 39 (68%)
- INFERRED: 18 (32%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*