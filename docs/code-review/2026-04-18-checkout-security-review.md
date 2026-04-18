# Code Review: Checkout
**Ready for Production**: No
**Critical Issues**: 4

## Review Scope
- src/app/checkout/page.tsx
- src/features/checkout/services/postal-code.service.ts
- src/features/checkout/utils/postal-code.util.ts
- src/app/api/checkout/create-session/route.ts
- src/app/api/checkout/complete/route.ts
- src/app/api/checkout/payment-intent/route.ts
- src/app/api/checkout/postal-code/route.ts
- src/app/api/webhook/stripe/route.ts
- src/lib/stripe/server.ts
- src/lib/mail/adapters/ses.ts
- migrations/020_create_cart_table.sql
- migrations/024_create_postal_code_cache.sql
- migrations/025_create_orders.sql
- migrations/004_create_sessions.sql
- migrations/007_create_audit_logs.sql
- docs/4_DetailDesign/13_checkout.md
- docs/4_DetailDesign/01_auth_seq.md
- docs/3_ArchitectureDesign/auth-structure.md

## Pass Plan
1. Frontend/input/PCI/XSS
2. API/backend/authn-authz/CSRF/rate limit/idempotency/webhook verification
3. DB/RLS/order integrity/audit/secrets

## Priority 1 (Must Fix) ⛔

### 1. Paid amount is not cryptographically bound to the ordered cart snapshot
- Files:
  - src/app/api/checkout/complete/route.ts
  - src/app/api/webhook/stripe/route.ts
  - src/app/api/checkout/create-session/route.ts
- Issue:
  - Both completion paths rebuild order items from the mutable current cart instead of an immutable server-side snapshot captured at payment session creation.
  - complete/route.ts only checks PaymentIntent status, then inserts order rows from the current carts table and does not compare the paid Stripe amount with the recomputed order amount.
  - webhook/stripe/route.ts also reads the live cart after payment_intent.succeeded and builds order_items from that mutable state.
- Impact:
  - A user can pay for a cheaper cart, mutate the cart before complete/webhook finalization, and receive a more expensive order for the lower paid amount.
- Fix:
  - Persist a checkout draft/order snapshot server-side before redirecting to Stripe.
  - Bind Stripe session/payment metadata to that immutable draft identifier.
  - Finalize orders only from the stored snapshot and verify Stripe amount/currency against the snapshot before inserting the order.

### 2. Public complete endpoint accepts non-Stripe offline methods without proof of payment or auth gates
- File:
  - src/app/api/checkout/complete/route.ts
- Issue:
  - The request schema still accepts bank/cod and the route creates pending orders when no Stripe confirmation is present.
  - The current checkout UI only exposes Stripe methods, so this public route expands the attack surface beyond the documented flow.
- Impact:
  - Anyone with a valid session_id cookie can submit arbitrary unpaid orders, pollute the order table, and clear carts without completing the documented Stripe flow.
- Fix:
  - Remove bank/cod from the public schema unless they are intentionally supported.
  - If offline methods are required, move them behind an explicit allowlisted flow with server-side authorization, anti-automation controls, and dedicated operational handling.

### 3. State-changing checkout endpoints do not enforce the project CSRF design
- Files:
  - src/app/api/checkout/create-session/route.ts
  - src/app/api/checkout/complete/route.ts
  - src/app/api/checkout/payment-intent/route.ts
- Issue:
  - These endpoints rely on session cookies and mutate payment/order state, but they do not call the shared CSRF middleware required by the auth design.
  - The checkout page uses plain fetch for these POSTs, so there is no X-CSRF-Token submission path either.
- Impact:
  - Defense-in-depth is weaker than the documented double-submit model, and cookie-bound checkout actions are exposed to same-site request forgery and browser-policy edge cases.
- Fix:
  - Apply requireCsrfOrDeny() to cookie-authenticated, state-changing checkout routes.
  - Send X-CSRF-Token from the client via the existing CSRF cookie pattern.

### 4. Public checkout endpoints and postal-code proxy have no abuse throttling
- Files:
  - src/app/api/checkout/create-session/route.ts
  - src/app/api/checkout/complete/route.ts
  - src/app/api/checkout/payment-intent/route.ts
  - src/app/api/checkout/postal-code/route.ts
  - src/features/checkout/services/postal-code.service.ts
  - migrations/024_create_postal_code_cache.sql
- Issue:
  - There is no rate limiting on expensive Stripe object creation or on the public postal-code lookup proxy.
  - The postal-code implementation uses only process-local memory cache and does not use the intended shared postal_code_cache table, so multi-instance deployments do not dampen repeated abuse.
- Impact:
  - Attackers can create Stripe sessions/payment intents at scale and can abuse the postal-code proxy to amplify requests toward the upstream API.
- Fix:
  - Add IP/session-based rate limiting to all public checkout routes.
  - Use the shared postal_code_cache table as designed, with TTL/eviction semantics and fail-closed handling for upstream abuse.

## Recommended Changes

### 5. Checkout and webhook flows lack durable security audit events
- Files:
  - src/app/api/checkout/create-session/route.ts
  - src/app/api/checkout/complete/route.ts
  - src/app/api/webhook/stripe/route.ts
  - migrations/007_create_audit_logs.sql
- Issue:
  - Payment session creation, order finalization, webhook verification failures, and duplicate-event handling are only console-logged.
- Impact:
  - Incident response, fraud analysis, and operational forensics are weakened for the most payment-sensitive flow in the system.
- Fix:
  - Emit structured audit events for checkout session creation, order finalization success/failure, webhook signature failures, duplicate event skips, and unusual completion attempts.

## Residual Notes
- PCI scope is reduced correctly on the frontend because card entry is delegated to Stripe Elements/PaymentElement; no direct card field handling was found in the reviewed checkout UI.
- Webhook signature verification is present and correctly uses the raw request body.