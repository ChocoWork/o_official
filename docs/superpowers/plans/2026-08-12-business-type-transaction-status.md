# Business-Type Transaction Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 法人では訂正確認が完了するまで取引を「要確認」とし、個人事業主では訂正以外の問題がなければ「登録済み」とする。

**Architecture:** ステータス判定を `src/lib/finance/transaction-status.ts` の純粋関数へ分離し、画面の一覧・集計・CSVが同じ結果を使う。法人の訂正確認は既存の理由別確認記録へ `revisedEntry` を追加し、migration 085 でDB制約を拡張する。

**Tech Stack:** Next.js 16 App Router、React、TypeScript、Zod、Supabase/Postgres、Jest、React Testing Library

## Global Constraints

- ステータスは「登録済み」「要確認」の2状態とし、「訂正あり」は履歴フィルターとして残す。
- 法人だけ、訂正履歴のある取引へ「訂正内容の確認」を追加する。
- 個人事業主では訂正履歴だけを理由に「要確認」にしない。
- 未確認理由が1件でもあれば「要確認」、なければ「登録済み」とする。
- 既存の訂正履歴と確認済み記録を削除・上書きしない。

---

### Task 1: 純粋なステータス判定と確認理由

**Files:**
- Create: `src/lib/finance/transaction-status.ts`
- Create: `tests/unit/lib/finance/transaction-status.test.ts`
- Modify: `src/lib/finance/entry-review.ts`

**Interfaces:**
- Consumes: `BusinessType`、訂正履歴の有無、未確認理由の有無
- Produces: `resolveTransactionStatus({ businessType, revised, openReviewReasons }): 'registered' | 'review'` と `EntryReviewReasonId` の `revisedEntry`

- [ ] **Step 1: Write the failing status matrix test**

```ts
expect(resolveTransactionStatus({ businessType: 'corporation', revised: true, openReviewReasons: ['revisedEntry'] })).toBe('review');
expect(resolveTransactionStatus({ businessType: 'corporation', revised: true, openReviewReasons: [] })).toBe('registered');
expect(resolveTransactionStatus({ businessType: 'soleProprietor', revised: true, openReviewReasons: [] })).toBe('registered');
expect(resolveTransactionStatus({ businessType: 'soleProprietor', revised: true, openReviewReasons: ['duplicate'] })).toBe('review');
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx.cmd jest tests/unit/lib/finance/transaction-status.test.ts --runInBand`
Expected: FAIL because `transaction-status.ts` does not exist.

- [ ] **Step 3: Add the minimal pure function and correction reason definition**

```ts
export type TransactionStatus = 'registered' | 'review';

export function resolveTransactionStatus(input: {
  businessType: BusinessType;
  revised: boolean;
  openReviewReasons: readonly EntryReviewReasonId[];
}): TransactionStatus {
  return input.openReviewReasons.length > 0 ? 'review' : 'registered';
}
```

Add `revisedEntry` to `EntryReviewReasonId` and `ENTRY_REVIEW_REASONS` with label `訂正内容の確認`, explaining that a法人 must compare the before/after history and supporting evidence.

- [ ] **Step 4: Run the unit test and verify GREEN**

Run: `npx.cmd jest tests/unit/lib/finance/transaction-status.test.ts --runInBand`
Expected: PASS for all four business/status cases.

### Task 2: API and database acceptance of correction acknowledgement

**Files:**
- Create: `migrations/085_finance_revised_entry_review_ack.sql`
- Create: `tests/unit/migrations/085_finance_revised_entry_review_ack.test.ts`
- Modify: `src/app/api/admin/kpi/cost-profit/route.ts`
- Modify: `tests/unit/api/admin/cost-profit-route.test.ts`

**Interfaces:**
- Consumes: `entry.reviewAck` mutation with `reason: 'revisedEntry'`
- Produces: an upsert/delete in `admin_finance_entry_review_acks` accepted by both Zod and the database check constraint

- [ ] **Step 1: Write failing migration and route tests**

Assert that migration 085 replaces the `reason` constraint with the four literal values and that `POST` accepts `reason: 'revisedEntry'` for `entry.reviewAck`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx.cmd jest tests/unit/migrations/085_finance_revised_entry_review_ack.test.ts tests/unit/api/admin/cost-profit-route.test.ts --runInBand`
Expected: FAIL because migration 085 is absent and the Zod enum rejects `revisedEntry`.

- [ ] **Step 3: Implement schema compatibility**

Migration SQL must drop the existing reason check constraint discovered by its table/column definition and add a named constraint allowing `duplicate`, `unknownAccount`, `unlinkedAsset`, and `revisedEntry`. Update `entryReviewReasonSchema` with the same literals.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx.cmd jest tests/unit/migrations/085_finance_revised_entry_review_ack.test.ts tests/unit/api/admin/cost-profit-route.test.ts --runInBand`
Expected: PASS.

### Task 3: Apply business-specific status consistently in the UI

**Files:**
- Modify: `src/components/CostProfitSection.tsx`
- Modify: `tests/unit/components/CostProfitSection.test.tsx`
- Modify: `docs/2_Specs/spec.md`

**Interfaces:**
- Consumes: `resolveTransactionStatus`, `businessType`, `revisedEntryIds`, and existing `reviewAckByKey`
- Produces: consistent list badge, review drawer, donut counts, tabs, and CSV status

- [ ] **Step 1: Write failing component tests**

Create fixtures for corporation and sole proprietor with an update revision. Assert corporation shows `要確認` and `訂正内容の確認`; acknowledging it changes the badge to `登録済み`. Assert sole proprietor shows `登録済み` unless a duplicate or other review reason remains. Assert `訂正あり` filter still includes revised transactions.

- [ ] **Step 2: Run component tests and verify RED**

Run: `npx.cmd jest tests/unit/components/CostProfitSection.test.tsx --runInBand`
Expected: FAIL because the component currently gives every revised transaction the `revised` state.

- [ ] **Step 3: Replace the three-state calculation**

In `entryReviewItemsOf`, add `revisedEntry` only when `businessType === 'corporation' && revisedEntryIds.has(entry.id)`. Change `EntryState` to the exported two-state type, call `resolveTransactionStatus` with unacknowledged reason IDs, remove `revised` from donut/status legends, and retain the `revised` list tab using `revisedEntryIds` directly.

- [ ] **Step 4: Update specification wording**

Revise FREQ-257 status rules so corporation and sole proprietor behavior matches the approved design, while documenting that the correction-history filter remains available.

- [ ] **Step 5: Run tests, typecheck, security audit, and graph update**

Run:

```powershell
npx.cmd jest tests/unit/lib/finance/transaction-status.test.ts tests/unit/migrations/085_finance_revised_entry_review_ack.test.ts tests/unit/api/admin/cost-profit-route.test.ts tests/unit/components/CostProfitSection.test.tsx --runInBand
npm.cmd run typecheck
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex/skills/security-check/scripts/audit.ps1 --files-only src/lib/finance/transaction-status.ts src/lib/finance/entry-review.ts src/app/api/admin/kpi/cost-profit/route.ts src/components/CostProfitSection.tsx
graphify update .
```

Expected: all focused tests pass, TypeScript exits 0, audit reports no Critical/High findings, and Graphify completes.
