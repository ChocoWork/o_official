# Community 5

> 36 nodes · cohesion 0.04

## Key Concepts

- **logWebhookAudit()** (12 connections) — `app\api\webhook\stripe\route.ts`
- **route.ts** (11 connections) — `app\api\webhook\stripe\route.ts`
- **POST()** (10 connections) — `app\api\checkout\complete\route.ts`
- **POST()** (10 connections) — `app\api\webhook\stripe\route.ts`
- **checkout-draft.service.ts** (9 connections) — `features\checkout\services\checkout-draft.service.ts`
- **POST()** (7 connections) — `app\api\cart\route.ts`
- **createOrderFromDraft()** (7 connections) — `app\api\webhook\stripe\route.ts`
- **cart-stock.ts** (5 connections) — `features\cart\services\cart-stock.ts`
- **normalizeOptionalText()** (5 connections) — `features\checkout\services\checkout-draft.service.ts`
- **handleCheckoutSessionCompleted()** (5 connections) — `app\api\webhook\stripe\route.ts`
- **handlePaymentIntentSucceeded()** (5 connections) — `app\api\webhook\stripe\route.ts`
- **resolvePaymentMethod()** (4 connections) — `app\api\checkout\complete\route.ts`
- **buildInventoryConflictBody()** (4 connections) — `features\cart\services\cart-stock.ts`
- **getDraftIdFromStripeMetadata()** (4 connections) — `features\checkout\services\checkout-draft.service.ts`
- **route.ts** (3 connections) — `app\api\cart\route.ts`
- **route.ts** (3 connections) — `app\api\checkout\complete\route.ts`
- **GET()** (3 connections) — `app\api\cart\route.ts`
- **getClientIp()** (3 connections) — `app\api\cart\route.ts`
- **getClientIp()** (3 connections) — `app\api\checkout\complete\route.ts`
- **collectInventoryIssues()** (3 connections) — `features\cart\services\cart-stock.ts`
- **mapFinalizeOrderRpcError()** (3 connections) — `features\cart\services\cart-stock.ts`
- **parseFinalizeOrderRpcResult()** (3 connections) — `features\cart\services\cart-stock.ts`
- **getClientIp()** (3 connections) — `app\api\webhook\stripe\route.ts`
- **handleCheckoutSessionAsyncPaymentFailed()** (3 connections) — `app\api\webhook\stripe\route.ts`
- **handleCheckoutSessionAsyncPaymentSucceeded()** (3 connections) — `app\api\webhook\stripe\route.ts`
- *... and 11 more nodes in this community*

## Relationships

- No strong cross-community connections detected

## Source Files

- `app\api\cart\route.ts`
- `app\api\checkout\complete\route.ts`
- `app\api\webhook\stripe\route.ts`
- `features\cart\services\cart-stock.ts`
- `features\checkout\services\checkout-draft.service.ts`

## Audit Trail

- EXTRACTED: 116 (75%)
- INFERRED: 38 (25%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*