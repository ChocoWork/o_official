# POST()

> 51 nodes · cohesion 0.07

## Key Concepts

- **POST()** (12 connections) — `app\api\checkout\create-session\route.ts`
- **logWebhookAudit()** (12 connections) — `app\api\webhook\stripe\route.ts`
- **route.ts** (11 connections) — `app\api\webhook\stripe\route.ts`
- **POST()** (10 connections) — `app\api\checkout\complete\route.ts`
- **POST()** (10 connections) — `app\api\webhook\stripe\route.ts`
- **checkout-draft.service.ts** (9 connections) — `features\checkout\services\checkout-draft.service.ts`
- **POST()** (7 connections) — `app\api\cart\route.ts`
- **createOrderFromDraft()** (7 connections) — `app\api\webhook\stripe\route.ts`
- **route.ts** (6 connections) — `app\api\admin\orders\route.ts`
- **getStripeServerClient()** (6 connections) — `lib\stripe\server.ts`
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
- **getClientIp()** (3 connections) — `app\api\checkout\create-session\route.ts`
- **checkout-pricing.service.ts** (3 connections) — `features\checkout\services\checkout-pricing.service.ts`
- **fetchPaymentIntentMap()** (3 connections) — `app\api\admin\orders\route.ts`
- *... and 26 more nodes in this community*

## Relationships

- [[createClient()]] (142 shared connections)
- [[page.tsx]] (29 shared connections)
- [[clientFetch()]] (21 shared connections)
- [[DELETE()]] (9 shared connections)

## Source Files

- `app\api\admin\orders\route.ts`
- `app\api\cart\route.ts`
- `app\api\checkout\complete\route.ts`
- `app\api\checkout\create-session\route.ts`
- `app\api\webhook\stripe\route.ts`
- `features\cart\services\cart-stock.ts`
- `features\checkout\services\checkout-draft.service.ts`
- `features\checkout\services\checkout-pricing.service.ts`
- `lib\stripe\server.ts`

## Audit Trail

- EXTRACTED: 144 (72%)
- INFERRED: 57 (28%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*