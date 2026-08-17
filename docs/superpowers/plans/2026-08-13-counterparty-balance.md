# Counterparty Balance Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cumulative lender and payable-counterparty balance tables to ADMIN > ACCOUNTING > 財務概要.

**Architecture:** Extend the existing cumulative transaction payload with the fields needed to rebuild journal lines through the selected year-end. Put account classification and counterparty aggregation in a pure finance module, then render its result inside the existing client-side financial summary using semantic tables.

**Tech Stack:** Next.js 16 App Router, React 19.2, TypeScript, Jest, React Testing Library, Tailwind CSS.

## Global Constraints

- Aggregate from the first recorded transaction through December 31 of the selected year.
- Group by counterparty and account; do not infer missing counterparties.
- Keep principal/owner funding separate from ordinary payables.
- Preserve zero and negative balances and reconcile table totals with ledger balances.
- Do not add a database table or a new endpoint.
- Preserve all unrelated uncommitted work in the shared worktree.

---

### Task 1: Pure Counterparty Balance Aggregation

**Files:**

- Create: `src/lib/finance/counterparty-balances.ts`
- Create: `tests/unit/lib/finance/counterparty-balances.test.ts`

**Interfaces:**

- Consumes: `FinanceEntry`, `BusinessType`, and `ReadonlyMap<string, number>` opening balances.
- Produces: `buildCounterpartyBalances(entries, businessType, throughDate, officialBalances): CounterpartyBalanceSummary`.

- [ ] **Step 1: Write failing aggregation tests**

Cover literal fixtures for multiple lenders, partial repayment, private payment mapping, payable separation, zero balance, negative balance, missing counterparty, and unattributed opening balance.

```ts
expect(result.funding.rows).toContainEqual({
  counterparty: "山田太郎",
  accountCode: "2120",
  accountName: "役員借入金",
  received: 1_000_000,
  settled: 300_000,
  openingBalance: 0,
  balance: 700_000,
  lastActivityDate: "2026-08-01",
  ownerFunding: false,
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx.cmd jest tests/unit/lib/finance/counterparty-balances.test.ts --runInBand`

Expected: FAIL because `counterparty-balances.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure aggregator**

Build journal entries with `buildJournal`, inspect only the specified account-code sets, add credit to `received`, and debit to `settled`. Reconcile per-account counterparty balances to the selected-year general-ledger closing balance and add only an unattributed difference as `繰越・相手先未設定`. For `事業主借`, retain lifetime received/settled totals but derive the current balance from selected-year activity because year-end closing transfers prior balances to `元入金`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx.cmd jest tests/unit/lib/finance/counterparty-balances.test.ts --runInBand`

Expected: PASS.

### Task 2: Extend the Existing Cumulative API Payload

**Files:**

- Modify: `src/app/api/admin/kpi/cost-profit/route.ts`
- Modify: `tests/unit/api/admin/cost-profit-route.test.ts`

**Interfaces:**

- Consumes: existing `admin_finance_expenses` rows up to selected year-end.
- Produces: `cumulativeEntries` containing `id`, `entryType`, `date`, `category`, `item`, `partner`, `amount`, and `paymentMethod`.

- [ ] **Step 1: Write a failing route assertion**

Assert that the cumulative query selects the full minimal journal fields and that the JSON mapping retains counterparty and payment method.

- [ ] **Step 2: Run the focused route test and verify RED**

Run: `npx.cmd jest tests/unit/api/admin/cost-profit-route.test.ts --runInBand`

Expected: FAIL because the current cumulative payload omits partner and payment method.

- [ ] **Step 3: Extend the query and mapping**

Select and map `id, entry_type, expense_date, category, item_name, partner, amount, payment_method` without changing authorization or cache behavior.

- [ ] **Step 4: Run the focused route test and verify GREEN**

Run: `npx.cmd jest tests/unit/api/admin/cost-profit-route.test.ts --runInBand`

Expected: PASS.

### Task 3: Render Both Tables in the Financial Summary

**Files:**

- Modify: `src/components/CostProfitSection.tsx`
- Modify: `tests/unit/components/CostProfitSection.test.tsx`

**Interfaces:**

- Consumes: extended cumulative entries and `buildCounterpartyBalances`.
- Produces: accessible panels named `借入・事業主資金` and `その他の支払債務`.

- [ ] **Step 1: Write failing component tests**

Use role/name queries to verify both tables, columns, lender values, owner-funding note, empty state, and panel-contained horizontal overflow.

- [ ] **Step 2: Run the focused component test and verify RED**

Run: `npx.cmd jest tests/unit/components/CostProfitSection.test.tsx --runInBand`

Expected: FAIL because the panels are absent.

- [ ] **Step 3: Add client-side derivation and semantic tables**

Derive the summary with `useMemo`, show totals and rows, render `table`/`thead`/`tbody`, use `overflow-x-auto` inside each panel, and show the specified notes and empty states.

- [ ] **Step 4: Run the focused component test and verify GREEN**

Run: `npx.cmd jest tests/unit/components/CostProfitSection.test.tsx --runInBand`

Expected: PASS.

### Task 4: Verification and Repository Integration

**Files:**

- Modify: `graphify-out/*` through `graphify update .`

**Interfaces:**

- Consumes: completed feature and tests.
- Produces: verified build state and refreshed knowledge graph.

- [ ] **Step 1: Run related unit suites**

Run: `npx.cmd jest tests/unit/lib/finance/counterparty-balances.test.ts tests/unit/lib/finance/journal.test.ts tests/unit/api/admin/cost-profit-route.test.ts tests/unit/components/CostProfitSection.test.tsx --runInBand`

- [ ] **Step 2: Run type and lint validation**

Run the repository's existing type-check and lint scripts discovered from `package.json`.

- [ ] **Step 3: Run component validation and security audit**

Run: `bash .codex/skills/implement-component/scripts/validate.sh`

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex/skills/security-check/scripts/audit.ps1 --files-only src/lib/finance/counterparty-balances.ts src/app/api/admin/kpi/cost-profit/route.ts src/components/CostProfitSection.tsx`

- [ ] **Step 4: Refresh Graphify and inspect the scoped diff**

Run: `graphify update .`

Review only the files in this plan and preserve unrelated changes.
