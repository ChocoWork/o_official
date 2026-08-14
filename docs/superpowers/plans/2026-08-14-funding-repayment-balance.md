# Funding Repayment Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ACCOUNTING financial overview calculate funding repayment balances as lifetime received minus lifetime settled and label them 「返済残高」.

**Architecture:** Keep `buildCounterpartyBalances` as the pure aggregation boundary. Funding rows retain their lifetime credit-minus-debit result without owner-funding or official-ledger reconciliation overrides, while payable rows keep the existing official-ledger reconciliation. `CostProfitSection` changes only the funding labels.

**Tech Stack:** Next.js 16 App Router, React 19.2, TypeScript, Jest, React Testing Library.

## Global Constraints

- 返済残高 = 借入・投入累計 - 返済・引出済み。
- 「借入・事業主資金」の合計カードと明細列だけを「返済残高」へ変更する。
- 「その他の支払債務」の「残高」と元帳照合を変更しない。
- 負数と既存の要確認表示を維持する。
- 無関係な作業ツリー変更を変更・コミットしない。

---

### Task 1: Funding Balance Aggregation

**Files:**
- Modify: `tests/unit/lib/finance/counterparty-balances.test.ts`
- Modify: `src/lib/finance/counterparty-balances.ts`

**Interfaces:**
- Consumes: existing `buildCounterpartyBalances(entries, businessType, throughDate, officialBalances)` arguments.
- Produces: existing `CounterpartyBalanceSummary`; each funding row has `balance === received - settled`, and `funding.totals.balance` is the sum of those row balances.

- [ ] **Step 1: Write the failing tests**

Change the owner-funding fixture to expect its lifetime received-minus-settled balance and add an official-ledger mismatch assertion:

```ts
expect(result.funding.rows[0]).toMatchObject({
  received: 70_000,
  settled: 0,
  balance: 70_000,
  ownerFunding: true,
});
expect(result.funding.totals.balance).toBe(70_000);
expect(result.funding.rows).not.toContainEqual(
  expect.objectContaining({ unattributedOpening: true }),
);
```

Keep the payable unattributed-opening test so the non-funding behavior remains covered.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -- --runTestsByPath tests/unit/lib/finance/counterparty-balances.test.ts --runInBand`

Expected: FAIL because owner funding is still replaced with current-year balance or official-ledger reconciliation.

- [ ] **Step 3: Implement the minimal aggregation change**

Remove the owner-funding current-year balance override. Restrict official-ledger difference rows to the `payables` section so funding balances remain their accumulated `credit - debit` values. Remove now-unused `currentYearBalance` state.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm.cmd test -- --runTestsByPath tests/unit/lib/finance/counterparty-balances.test.ts --runInBand`

Expected: PASS with all aggregation cases green.

### Task 2: Funding Labels

**Files:**
- Modify: `tests/unit/components/CostProfitSection.test.tsx`
- Modify: `src/components/CostProfitSection.tsx`

**Interfaces:**
- Consumes: existing `counterpartyBalancePanel(title, section)` rendering inputs.
- Produces: two visible 「返済残高」 labels inside the funding region and existing 「残高」 labels inside the payables region.

- [ ] **Step 1: Write the failing component assertions**

Add role-scoped assertions to the existing financial-overview test:

```ts
expect(within(funding).getAllByText('返済残高')).toHaveLength(2);
expect(within(funding).queryByText('残高', { exact: true })).not.toBeInTheDocument();
expect(within(payables).getAllByText('残高', { exact: true }).length).toBeGreaterThan(0);
```

- [ ] **Step 2: Run the component test and verify RED**

Run: `npm.cmd test -- --runTestsByPath tests/unit/components/CostProfitSection.test.tsx --runInBand`

Expected: FAIL because funding still renders 「残高」.

- [ ] **Step 3: Implement the minimal label change**

Use `funding ? "返済残高" : "残高"` for both the summary-card label and table heading. Do not change the property name or payable rendering.

- [ ] **Step 4: Run the component test and verify GREEN**

Run: `npm.cmd test -- --runTestsByPath tests/unit/components/CostProfitSection.test.tsx --runInBand`

Expected: PASS.

### Task 3: Verification and Integration

**Files:**
- Modify: `graphify-out/*` through `graphify update .`

**Interfaces:**
- Consumes: completed aggregation and label changes.
- Produces: verified source state, current graph, and a scoped master commit.

- [ ] **Step 1: Run related unit suites**

Run: `npm.cmd test -- --runTestsByPath tests/unit/lib/finance/counterparty-balances.test.ts tests/unit/components/CostProfitSection.test.tsx --runInBand`

- [ ] **Step 2: Run type and lint checks**

Run the existing type-check command from `package.json`, then run ESLint only for the modified TypeScript files.

- [ ] **Step 3: Refresh Graphify and inspect changes**

Run: `graphify update .`

Inspect `git diff --check`, the scoped source/test diff, and ensure unrelated Graphify changes are not staged with the implementation.

- [ ] **Step 4: Commit the implementation**

Stage only the plan, source, and test files for this request, then commit directly to `master` with:

```text
fix(accounting): calculate funding repayment balance
```
