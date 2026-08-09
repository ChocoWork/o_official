# Stripe Order Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supabaseの注文を取引管理とKPIの共通売上正本にし、Stripe Webhookの失敗再送と返金を安全に同期する。

**Architecture:** Stripeは決済・返金事実の外部原本、Supabase `orders`はアプリ内の注文・売上正本とする。共通の売上変換サービスをKPI APIと取引管理APIから利用し、Webhookイベントは処理状態を持つ冪等レコードとして再試行可能にする。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、Supabase/PostgreSQL、Stripe Node SDK 20、Jest

## Global Constraints

- Stripe APIへの書き込みはテストモードと本番モードを明示的に分離する。
- Stripe署名検証前にDBを書き換えない。
- `orders.total_amount`と`orders.refunded_amount`から純売上を算出する。
- 取引管理とKPIは同じ`toOrderSalesTransaction`関数を使う。
- 手動収入は注文売上と区別して保持する。
- 既存の未コミット変更を上書きしない。
- 新規・変更したビジネスロジックにはJestテストを追加する。

---

## File Structure

| File | Responsibility |
|---|---|
| `migrations/080_stripe_order_reconciliation.sql` | 注文返金列とWebhook処理状態列、索引、制約を追加 |
| `src/lib/sales/order-sales.ts` | 注文から共通売上取引へ変換し、純売上を計算 |
| `src/lib/stripe/order-refund-sync.ts` | Stripeの成功済み返金累計を注文へ同期 |
| `src/app/api/webhook/stripe/route.ts` | 再試行可能なイベント処理と返金イベントのルーティング |
| `src/app/api/admin/orders/[id]/refund/route.ts` | 返金作成後の状態を共通同期処理へ委譲 |
| `src/app/api/admin/kpi/route.ts` | 共通売上変換結果から売上KPIを集計 |
| `src/app/api/admin/kpi/cost-profit/route.ts` | 支払済み注文を取引管理の読み取り専用収入へ統合 |
| `src/components/CostProfitSection.tsx` | 注文由来収入の出所と読み取り専用状態を表示 |
| `src/app/api/cron/stripe-reconcile/route.ts` | Stripeと注文の定期照合API |
| `src/lib/stripe/reconcile-orders.ts` | 照合差分を算出し返金差分を修復 |

---

### Task 1: Database invariants for refunds and retryable webhook events

**Files:**
- Create: `migrations/080_stripe_order_reconciliation.sql`
- Create: `tests/unit/migrations/080_stripe_order_reconciliation.test.ts`

**Interfaces:**
- Produces: `orders.refunded_amount`, `orders.refunded_at`, `orders.payment_status_updated_at`
- Produces: `stripe_webhook_events.processing_status`, `attempt_count`, `completed_at`, `last_error`

- [ ] **Step 1: Write the failing migration contract test**

```ts
expect(sql).toContain('ADD COLUMN IF NOT EXISTS refunded_amount');
expect(sql).toContain("CHECK (processing_status IN ('processing', 'completed', 'failed'))");
expect(sql).toContain('refunded_amount <= total_amount');
```

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
npx jest tests/unit/migrations/080_stripe_order_reconciliation.test.ts --runInBand
```

Expected: migration file cannot be read.

- [ ] **Step 3: Implement the idempotent migration**

```sql
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS refunded_amount integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_status_updated_at timestamptz;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_refunded_amount_range
  CHECK (refunded_amount >= 0 AND refunded_amount <= total_amount);

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;
```

Use a guarded `DO $$` block for named constraints so rerunning the migration is safe. Existing webhook rows become `completed`; new application inserts explicitly use `processing`.

- [ ] **Step 4: Run the migration test**

```powershell
npx jest tests/unit/migrations/080_stripe_order_reconciliation.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit the database contract**

```powershell
git add migrations/080_stripe_order_reconciliation.sql tests/unit/migrations/080_stripe_order_reconciliation.test.ts
git commit -m "feat(finance): add Stripe reconciliation state"
```

---

### Task 2: Shared order sales model

**Files:**
- Create: `src/lib/sales/order-sales.ts`
- Create: `tests/unit/lib/sales/order-sales.test.ts`
- Modify: `src/app/api/admin/kpi/route.ts`
- Modify: `src/app/api/admin/kpi/cost-profit/route.ts`
- Modify: `tests/unit/api/admin/cost-profit-route.test.ts`

**Interfaces:**
- Produces: `OrderSalesRow`
- Produces: `OrderSalesTransaction`
- Produces: `toOrderSalesTransaction(row: OrderSalesRow): OrderSalesTransaction | null`
- Consumes: `orders` rows containing `id`, `payment_intent_id`, `status`, `total_amount`, `refunded_amount`, `currency`, `created_at`

- [ ] **Step 1: Write failing unit tests for paid, partial-refund, and canceled orders**

```ts
expect(toOrderSalesTransaction(paidOrder)?.netAmount).toBe(10000);
expect(toOrderSalesTransaction({ ...paidOrder, refunded_amount: 2500 })?.netAmount).toBe(7500);
expect(toOrderSalesTransaction({ ...paidOrder, status: 'pending' })).toBeNull();
```

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
npx jest tests/unit/lib/sales/order-sales.test.ts --runInBand
```

Expected: module not found.

- [ ] **Step 3: Implement the shared transformer**

```ts
export function toOrderSalesTransaction(row: OrderSalesRow): OrderSalesTransaction | null {
  const refundedAmount = Math.min(Math.max(row.refunded_amount ?? 0, 0), row.total_amount);
  if (row.status !== 'paid' && refundedAmount === 0) return null;
  return {
    source: 'order',
    sourceId: row.id,
    paymentIntentId: row.payment_intent_id,
    date: row.created_at,
    grossAmount: row.total_amount,
    refundedAmount,
    netAmount: row.total_amount - refundedAmount,
    currency: row.currency,
    readOnly: true,
  };
}
```

- [ ] **Step 4: Change KPI sales accumulation to use `netAmount`**

Select `refunded_amount` with each order, transform once, and add `transaction.netAmount` instead of `order.total_amount`. Keep order count, customer count, and product metrics based on paid orders.

- [ ] **Step 5: Merge order transactions into finance API incomes**

Map each order transaction to the existing income response shape with `source: 'order'`, `sourceId`, `readOnly: true`, category `売上高`, item `オンライン注文`, and payment method `Stripe`. Preserve manually entered incomes with `source: 'manual'` and `readOnly: false`.

- [ ] **Step 6: Run focused tests**

```powershell
npx jest tests/unit/lib/sales/order-sales.test.ts tests/unit/api/admin/cost-profit-route.test.ts --runInBand
```

Expected: PASS, including 13 order-derived incomes when the mock returns 13 paid orders.

- [ ] **Step 7: Commit shared sales behavior**

```powershell
git add src/lib/sales/order-sales.ts src/app/api/admin/kpi/route.ts src/app/api/admin/kpi/cost-profit/route.ts tests/unit/lib/sales/order-sales.test.ts tests/unit/api/admin/cost-profit-route.test.ts
git commit -m "feat(finance): share order sales across transactions and KPI"
```

---

### Task 3: Retryable webhook event lifecycle

**Files:**
- Create: `src/lib/stripe/webhook-events.ts`
- Create: `tests/unit/lib/stripe/webhook-events.test.ts`
- Modify: `src/app/api/webhook/stripe/route.ts`
- Modify: `tests/unit/api/webhook/stripe-route.test.ts`

**Interfaces:**
- Produces: `beginWebhookEvent(event): Promise<'process' | 'duplicate'>`
- Produces: `completeWebhookEvent(eventId): Promise<void>`
- Produces: `failWebhookEvent(eventId, error): Promise<void>`

- [ ] **Step 1: Write a failing regression test for failed-event retry**

```ts
it('failed event is processed again and completed event is skipped', async () => {
  existingStatus = 'failed';
  expect(await POST(makeRequest(event))).toMatchObject({ status: 200 });
  expect(eventUpdate).toHaveBeenCalledWith(expect.objectContaining({ processing_status: 'completed' }));
});
```

- [ ] **Step 2: Run the webhook tests and verify the regression test fails**

```powershell
npx jest tests/unit/api/webhook/stripe-route.test.ts --runInBand
```

Expected: current route returns duplicate for the failed row.

- [ ] **Step 3: Implement lifecycle helpers**

```ts
if (existing?.processing_status === 'completed') return 'duplicate';
await table.upsert({
  id: event.id,
  event_type: event.type,
  raw_payload: event,
  processing_status: 'processing',
  attempt_count: (existing?.attempt_count ?? 0) + 1,
  last_error: null,
}, { onConflict: 'id' });
return 'process';
```

On success set `completed`, `completed_at`, and clear `last_error`. On failure set `failed`, store a bounded non-secret error string, and keep the HTTP 500 response.

- [ ] **Step 4: Route all event processing through lifecycle helpers**

Signature verification remains first. Only `completed` events are acknowledged as duplicates.

- [ ] **Step 5: Run webhook lifecycle tests**

```powershell
npx jest tests/unit/lib/stripe/webhook-events.test.ts tests/unit/api/webhook/stripe-route.test.ts --runInBand
```

Expected: PASS for completed duplicate, failed retry, initial failure, and retry success.

- [ ] **Step 6: Commit retry behavior**

```powershell
git add src/lib/stripe/webhook-events.ts src/app/api/webhook/stripe/route.ts tests/unit/lib/stripe/webhook-events.test.ts tests/unit/api/webhook/stripe-route.test.ts
git commit -m "fix(stripe): retry failed webhook events"
```

---

### Task 4: Stripe refund synchronization

**Files:**
- Create: `src/lib/stripe/order-refund-sync.ts`
- Create: `tests/unit/lib/stripe/order-refund-sync.test.ts`
- Modify: `src/app/api/webhook/stripe/route.ts`
- Modify: `src/app/api/admin/orders/[id]/refund/route.ts`
- Modify: `tests/unit/api/webhook/stripe-route.test.ts`

**Interfaces:**
- Produces: `syncOrderRefunds(paymentIntentId: string): Promise<OrderRefundSyncResult>`
- Consumes: Stripe `refunds.list({ payment_intent })`
- Updates: `orders.refunded_amount`, `refunded_at`, `payment_status_updated_at`, and full-refund status

- [ ] **Step 1: Write failing tests for succeeded and requires-action refunds**

```ts
expect(calculateSucceededRefundTotal([{ status: 'succeeded', amount: 3000 }])).toBe(3000);
expect(calculateSucceededRefundTotal([{ status: 'requires_action', amount: 3000 }])).toBe(0);
```

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
npx jest tests/unit/lib/stripe/order-refund-sync.test.ts --runInBand
```

- [ ] **Step 3: Implement cumulative succeeded-refund synchronization**

List all refunds for the Payment Intent, sum only `status === 'succeeded'`, clamp to the order total, and update the order. Set `status = 'cancelled'` only when the succeeded refund total equals the order total.

```ts
const refundedAmount = refunds
  .filter((refund) => refund.status === 'succeeded')
  .reduce((sum, refund) => sum + refund.amount, 0);
```

- [ ] **Step 4: Handle refund webhook events**

Route `refund.created`, `refund.updated`, and `charge.refunded` to `syncOrderRefunds`. Resolve the Payment Intent ID from either the Refund or Charge object and reject missing identifiers as invalid events.

- [ ] **Step 5: Delegate admin-created refund state changes**

Remove the direct full-refund cancellation based solely on requested amount. Call `syncOrderRefunds` after Stripe returns so Konbini `requires_action` does not prematurely reduce revenue.

- [ ] **Step 6: Run refund and webhook tests**

```powershell
npx jest tests/unit/lib/stripe/order-refund-sync.test.ts tests/unit/api/webhook/stripe-route.test.ts --runInBand
```

Expected: PASS for card success, Konbini `requires_action`, partial refund, and full refund.

- [ ] **Step 7: Commit refund synchronization**

```powershell
git add src/lib/stripe/order-refund-sync.ts src/app/api/webhook/stripe/route.ts src/app/api/admin/orders/[id]/refund/route.ts tests/unit/lib/stripe/order-refund-sync.test.ts tests/unit/api/webhook/stripe-route.test.ts
git commit -m "fix(stripe): synchronize confirmed refunds to orders"
```

---

### Task 5: Transaction management presentation

**Files:**
- Modify: `src/components/CostProfitSection.tsx`
- Modify: `tests/unit/components/CostProfitSection.test.tsx`

**Interfaces:**
- Consumes: finance income fields `source`, `sourceId`, `readOnly`, `grossAmount`, `refundedAmount`
- Produces: read-only order income rows with source and refund labels

- [ ] **Step 1: Write failing component tests**

```tsx
expect(screen.getByText('Stripe注文')).toBeInTheDocument();
expect(screen.getByText('返金 2,500円')).toBeInTheDocument();
expect(screen.queryByRole('button', { name: 'この注文売上を訂正' })).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
npx jest tests/unit/components/CostProfitSection.test.tsx --runInBand
```

- [ ] **Step 3: Extend the income type and row rendering**

Order rows show `Stripe注文`, order reference, gross amount, refund amount, and net amount. Disable edit/delete actions for `readOnly` rows while keeping receipt and navigation behavior available where supported.

- [ ] **Step 4: Run component tests**

```powershell
npx jest tests/unit/components/CostProfitSection.test.tsx --runInBand
```

Expected: PASS and manual income remains editable.

- [ ] **Step 5: Commit transaction presentation**

```powershell
git add src/components/CostProfitSection.tsx tests/unit/components/CostProfitSection.test.tsx
git commit -m "feat(finance): show Stripe orders in transaction management"
```

---

### Task 6: Reconciliation and operational readiness

**Files:**
- Create: `src/lib/stripe/reconcile-orders.ts`
- Create: `src/app/api/cron/stripe-reconcile/route.ts`
- Create: `tests/unit/lib/stripe/reconcile-orders.test.ts`
- Create: `tests/unit/api/cron/stripe-reconcile-route.test.ts`
- Modify: `.env.example`
- Modify: `docs/ops/secrets.md`

**Interfaces:**
- Produces: `reconcileStripeOrders(): Promise<StripeOrderReconciliationReport>`
- Produces: authenticated `GET /api/cron/stripe-reconcile`
- Consumes: `CRON_SECRET`, Stripe Payment Intents/refunds, Supabase orders

- [ ] **Step 1: Write failing reconciliation tests**

```ts
expect(report.unmatchedActivePayments).toEqual(['pi_unmatched']);
expect(report.refundMismatches).toEqual([{ paymentIntentId: 'pi_partial', stripe: 2000, database: 0 }]);
expect(report.refundedTestPayments).not.toContain('pi_fully_refunded');
```

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
npx jest tests/unit/lib/stripe/reconcile-orders.test.ts tests/unit/api/cron/stripe-reconcile-route.test.ts --runInBand
```

- [ ] **Step 3: Implement read-mostly reconciliation**

Compare Stripe and orders by Payment Intent ID. Exclude fully succeeded-refunded Stripe-only payments from active mismatches. Repair only refund amount differences for an existing order by calling `syncOrderRefunds`; never create an order from an unmatched payment.

- [ ] **Step 4: Protect the Cron route**

```ts
if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

- [ ] **Step 5: Document required environment and Stripe Dashboard events**

Add `CRON_SECRET` and `APP_BASE_URL` names without values. Document the endpoint `${APP_BASE_URL}/api/webhook/stripe` and required events: Checkout completion/failure/expiry, Payment Intent success/failure, Refund creation/update, and Charge refund.

- [ ] **Step 6: Run reconciliation tests**

```powershell
npx jest tests/unit/lib/stripe/reconcile-orders.test.ts tests/unit/api/cron/stripe-reconcile-route.test.ts --runInBand
```

Expected: PASS for authorization, unmatched filtering, and refund repair.

- [ ] **Step 7: Commit reconciliation**

```powershell
git add src/lib/stripe/reconcile-orders.ts src/app/api/cron/stripe-reconcile/route.ts tests/unit/lib/stripe/reconcile-orders.test.ts tests/unit/api/cron/stripe-reconcile-route.test.ts .env.example docs/ops/secrets.md
git commit -m "feat(stripe): add order reconciliation job"
```

---

### Task 7: Full verification and live-data audit

**Files:**
- Modify: `docs/superpowers/plans/2026-08-09-stripe-order-reconciliation.md` (checkboxes only)
- Generated: `graphify-out/graph.json`

**Interfaces:**
- Consumes: all earlier tasks
- Produces: evidence that transaction management, KPI, Stripe, and Supabase agree

- [ ] **Step 1: Run focused unit tests**

```powershell
npx jest tests/unit/migrations/080_stripe_order_reconciliation.test.ts tests/unit/lib/sales/order-sales.test.ts tests/unit/lib/stripe/webhook-events.test.ts tests/unit/lib/stripe/order-refund-sync.test.ts tests/unit/lib/stripe/reconcile-orders.test.ts tests/unit/api/webhook/stripe-route.test.ts tests/unit/api/admin/cost-profit-route.test.ts --runInBand
```

- [ ] **Step 2: Run repository validation**

```powershell
npm run typecheck
npm run lint
npm test -- --runInBand
npm run build
```

- [ ] **Step 3: Run security audit**

```powershell
bash .claude/skills/security-check/scripts/audit.sh
```

- [ ] **Step 4: Apply migration to the configured Supabase environment**

Apply `migrations/080_stripe_order_reconciliation.sql` through the repository's configured migration path, then query schema metadata to verify all new columns and constraints exist.

- [ ] **Step 5: Verify data invariants without exposing PII**

Assert that the 13 paid Supabase orders appear as 13 order-derived income transactions and that the sum of their net amounts equals the KPI sales amount for the same period. Assert that Stripe-only active, non-refunded payments equal zero after the Konbini refund succeeds.

- [ ] **Step 6: Update the graph**

```powershell
graphify update .
```

- [ ] **Step 7: Commit verification metadata if tracked files changed intentionally**

```powershell
git add graphify-out/graph.json graphify-out/manifest.json
git commit -m "chore(graph): update Stripe reconciliation graph"
```

