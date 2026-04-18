# Code Review: Cart Security
**Ready for Production**: No
**Critical Issues**: 4

## Scope
- Spec basis: docs/4_DetailDesign/12_cart.md
- Pass 1: frontend/state/XSS/storage/information exposure
- Pass 2: API/backend/authz/CSRF/rate limiting/tamper resistance
- Pass 3: DB/RLS/price-stock consistency/audit/secrets

## Priority 1 (Must Fix) ⛔

### 1. Checkout completion can trust an unrelated paid Stripe session/payment intent

**Files:**
- src/app/api/checkout/complete/route.ts
- src/app/api/checkout/create-session/route.ts

**Issue:**
The completion endpoint retrieves any Checkout Session ID supplied by the client, derives its PaymentIntent, and marks the current cart as paid after checking only the PaymentIntent status. It does not enforce that the Checkout Session belongs to the current cart session, and it does not verify that the paid amount matches the server-calculated cart total.

**Why this matters:**
An attacker can potentially reuse a different successful Checkout Session / PaymentIntent and convert a more expensive cart into a paid order without paying the correct amount.

**Suggested fix:**
- When creating the Checkout Session, write the cart session identifier into both Checkout Session metadata and PaymentIntent metadata.
- In the completion endpoint, require all of the following before creating an order:
  - Checkout Session metadata session_id matches the current cart session_id.
  - PaymentIntent metadata session_id matches the current cart session_id.
  - PaymentIntent amount equals the server-calculated total.
  - Currency matches expected currency.
- Reject the request if any binding check fails.

### 2. Inventory validation is incomplete and non-transactional

**Files:**
- src/app/api/cart/route.ts
- src/app/api/cart/[id]/route.ts
- src/app/api/checkout/create-session/route.ts
- src/app/api/checkout/complete/route.ts
- src/app/api/webhook/stripe/route.ts
- migrations/031_add_stock_quantity_to_items.sql

**Issue:**
Cart mutation and checkout flows do not validate requested quantity against available stock. The checkout session route only rejects items where stock_quantity is exactly 0. No route reserves or atomically decrements stock before order finalization.

**Why this matters:**
Clients can raise quantity beyond available stock, and concurrent checkouts can oversell the same item. This violates price/inventory integrity requirements and can lead to paid orders that cannot be fulfilled.

**Suggested fix:**
- Validate quantity <= stock_quantity on cart add and cart update.
- Re-check quantity against current stock during checkout session creation and checkout completion.
- Finalize orders and decrement stock in a single transaction or RPC at the database layer.
- Fail closed if stock is unknown or insufficient for a stock-managed item.

### 3. Public cart routes bypass database RLS with service-role credentials

**Files:**
- src/app/api/cart/route.ts
- src/app/api/cart/[id]/route.ts
- migrations/020_create_cart_table.sql

**Issue:**
The cart APIs use a service-role Supabase client for guest-facing requests. That bypasses the RLS policies defined on carts, so the database is not actually enforcing cart isolation for these code paths.

**Why this matters:**
Current isolation depends entirely on every application query remembering to filter by session_id. A future query bug becomes a full cart data exposure/modification issue because the database guardrail is disabled in production paths.

**Suggested fix:**
- Do not use service-role credentials for guest cart CRUD.
- Use a request-scoped anon/user client with DB-enforced policies.
- If guest access must remain cookie-based, bind the guest session to a signed server-issued token or use a security-definer RPC that validates the session identifier before touching data.

### 4. Cart mutation endpoints lack strong input validation and abuse controls

**Files:**
- src/app/api/cart/route.ts
- src/app/api/cart/[id]/route.ts
- src/proxy.ts

**Issue:**
The cart POST/PATCH endpoints accept cookie-authenticated state changes without schema-level validation, quantity upper bounds, or rate limiting. POST also accepts loosely typed quantity values and directly combines them with stored quantities.

**Why this matters:**
This leaves the endpoints open to abuse, high-write DB spam, and malformed quantity payloads that can trigger inconsistent behavior or error paths. SameSite=Lax reduces classic CSRF risk, but it is not a substitute for request validation and abuse throttling.

**Suggested fix:**
- Validate request bodies with Zod and enforce integer, min, and max quantity bounds.
- Add per-session and per-IP rate limiting for cart mutation and checkout endpoints.
- Consider explicit Origin/Referer checks for cookie-authenticated writes as a defense-in-depth measure.

## Pass 1 Notes
- No direct XSS sink was found in the reviewed cart UI/state files.
- No localStorage/sessionStorage usage was found in the reviewed cart UI/state files.
- session_id is stored as an HttpOnly cookie in proxy.ts, which avoids direct JavaScript access.

## Residual Risk
- Webhook processing stores raw Stripe payloads in stripe_webhook_events. Access is RLS-protected for users, but retention/redaction policy should be reviewed because payloads can contain customer metadata.