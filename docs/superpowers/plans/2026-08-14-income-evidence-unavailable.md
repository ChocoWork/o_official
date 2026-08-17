# Income Evidence Unavailable Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手動登録の収入取引で「証憑添付不可」の理由を記録し、証憑の有無と理由記録を一貫した4状態で表示・集計・出力できるようにする。

**Architecture:** 添付不可の現在値は専用テーブルに保存し、変更操作は既存監査ログへ残す。状態判定は `src/lib/finance/evidence-status.ts` の純粋関数へ集約し、API、取引管理、CSV、帳簿、税務レポートが同じ判定結果を利用する。

**Tech Stack:** Next.js 16 App Router Route Handlers、React 19.2、TypeScript、Supabase/PostgreSQL/RLS、Zod、Jest、React Testing Library、Playwright

## Global Constraints

- 対象は `source=manual` かつ `entryType=income` の取引だけとし、支出と注文データ由来取引は変更しない。
- 画面のアクション名は「証憑添付不可」、記録後の表示名は「理由記録済み」とする。
- 状態優先順位は `system_record`、`attached`、`unavailable_recorded`、`missing` の順とする。
- `bank_history_expired` と `other` は1〜500文字の補足メモを必須とする。
- 理由記録を残したまま証憑を添付し、全証憑削除後は「理由記録済み」に戻す。
- 電子帳簿保存法上の免除判定は行わず、保存義務を免除しない旨を画面に表示する。
- 既存の共通UI、CSRF、MFA、`admin.finance.manage`、監査ログの仕組みを再利用する。
- 実装前に `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` を確認する。
- Windowsでは `npm.cmd` と exact Jest path の `--runTestsByPath` を使用する。
- unrelated changes はステージ・変更・削除しない。コード・文書変更後は `graphify update .` を実行する。

---

### Task 1: 証憑状態ドメインを4状態へ拡張する

**Files:**

- Modify: `src/lib/finance/evidence-status.ts`
- Create: `tests/unit/lib/finance/evidence-status.test.ts`

**Interfaces:**

- Consumes: `{ source?, receipts?, evidenceUnavailable? }`
- Produces: `EvidenceStatus = 'attached' | 'missing' | 'system_record' | 'unavailable_recorded'` と `resolveEvidenceStatus(entry): EvidenceStatus`

- [ ] **Step 1: 失敗する状態優先順位テストを書く**

```ts
import { resolveEvidenceStatus } from '@/lib/finance/evidence-status';

describe('resolveEvidenceStatus', () => {
  test.each([
    [{ source: 'order', receipts: [], evidenceUnavailable: {} }, 'system_record'],
    [{ source: 'manual', receipts: [{}], evidenceUnavailable: {} }, 'attached'],
    [{ source: 'manual', receipts: [], evidenceUnavailable: { reason: 'not_issued' } }, 'unavailable_recorded'],
    [{ source: 'manual', receipts: [] }, 'missing'],
  ] as const)('returns the prioritized evidence state', (entry, expected) => {
    expect(resolveEvidenceStatus(entry)).toBe(expected);
  });
});
```

- [ ] **Step 2: REDを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/finance/evidence-status.test.ts`

Expected: `unavailable_recorded` が未実装のためFAIL。

- [ ] **Step 3: 最小実装を追加する**

```ts
export type EvidenceStatus = 'attached' | 'missing' | 'system_record' | 'unavailable_recorded';

export function resolveEvidenceStatus(entry: {
  source?: 'manual' | 'order';
  receipts?: readonly unknown[];
  evidenceUnavailable?: unknown | null;
}): EvidenceStatus {
  if (entry.source === 'order') return 'system_record';
  if ((entry.receipts?.length ?? 0) > 0) return 'attached';
  return entry.evidenceUnavailable ? 'unavailable_recorded' : 'missing';
}
```

- [ ] **Step 4: GREENを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/finance/evidence-status.test.ts`

Expected: PASS。

- [ ] **Step 5: コミットする**

```powershell
git add src/lib/finance/evidence-status.ts tests/unit/lib/finance/evidence-status.test.ts
git commit -m "feat(accounting): add unavailable evidence state"
```

### Task 2: 添付不可記録のDBテーブルとRLSを追加する

**Files:**

- Create: `migrations/087_finance_evidence_unavailable_records.sql`
- Create: `tests/unit/migrations/087_finance_evidence_unavailable_records.test.ts`

**Interfaces:**

- Consumes: `admin_finance_expenses(id)`、`auth.uid()`、既存admin権限関数
- Produces: `admin_finance_evidence_unavailable_records` と理由CHECK制約、RLS policies

- [ ] **Step 1: migration文字列検証を先に書く**

```ts
expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.admin_finance_evidence_unavailable_records');
expect(sql).toContain("'bank_history_expired'");
expect(sql).toContain("'external_electronic_storage'");
expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
expect(sql).toContain("'admin.finance.manage'");
expect(sql).toContain('ON DELETE CASCADE');
```

- [ ] **Step 2: REDを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/migrations/087_finance_evidence_unavailable_records.test.ts`

Expected: migrationファイルが存在せずFAIL。

- [ ] **Step 3: migrationを実装する**

`entry_id bigint PRIMARY KEY REFERENCES public.admin_finance_expenses(id) ON DELETE CASCADE`、理由CHECK、`note varchar(500)`、`recorded_at/by`、`updated_at/by` を定義する。`bank_history_expired` と `other` のとき `length(trim(note)) BETWEEN 1 AND 500` をDB制約でも保証する。既存migrationと同じadmin read/manage policy形式を使い、service role以外の無制限書込みを許可しない。

- [ ] **Step 4: migrationテストを通す**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/migrations/087_finance_evidence_unavailable_records.test.ts`

Expected: PASS。

- [ ] **Step 5: コミットする**

```powershell
git add supabase/migrations/087_finance_evidence_unavailable_records.sql tests/unit/migrations/087_finance_evidence_unavailable_records.test.ts
git commit -m "feat(accounting): persist unavailable evidence records"
```

### Task 3: cost-profit APIへ取得・登録・解除を追加する

**Files:**

- Modify: `src/app/api/admin/kpi/cost-profit/route.ts`
- Modify: `tests/unit/api/admin/cost-profit-route.test.ts`

**Interfaces:**

- Consumes: `evidenceUnavailable.upsert` / `evidenceUnavailable.delete`
- Produces: GET responseの `evidenceUnavailable: { reason, note, recordedAt, recordedBy, updatedAt, updatedBy } | null`

- [ ] **Step 1: Route Handlerの現行ガイドを読む**

Run: `Get-Content -Raw node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`

Expected: POST body処理とRoute Handlerの現行規約を確認できる。

- [ ] **Step 2: APIの失敗テストを書く**

次を個別テストにする。

```ts
expect(getBody.incomes[0].evidenceUnavailable).toEqual(expect.objectContaining({ reason: 'bank_history_expired' }));
expect(upsertResponse.status).toBe(200);
expect(requiredNoteResponse.status).toBe(400);
expect(expenseTargetResponse.status).toBe(400);
expect(deleteResponse.status).toBe(200);
```

DBモックでは対象行を `.select('entry_type, deleted_at')` で検証し、成功時のみ専用テーブルをupsert/deleteすることを観測する。

- [ ] **Step 3: REDを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/api/admin/cost-profit-route.test.ts`

Expected: 新operationがZod discriminated unionで拒否されFAIL。

- [ ] **Step 4: schema、GET join、mutationを最小実装する**

```ts
const evidenceUnavailableReasonSchema = z.enum([
  'bank_history_expired', 'not_issued', 'paper_storage',
  'external_electronic_storage', 'other',
]);
```

upsertでは理由別メモ必須条件を `.superRefine()` で検証し、DB上で `entry_type='income'` かつ `deleted_at IS NULL` を確認する。保存者は認証済みユーザーIDをサーバー側で設定する。deleteも同じ対象照合を行う。成功・失敗を既存の監査ログへoperation名とentry ID付きで残す。

- [ ] **Step 5: GREENを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/api/admin/cost-profit-route.test.ts`

Expected: PASS。既存expense、receipt、review operationもPASS。

- [ ] **Step 6: コミットする**

```powershell
git add src/app/api/admin/kpi/cost-profit/route.ts tests/unit/api/admin/cost-profit-route.test.ts
git commit -m "feat(accounting): manage unavailable evidence records"
```

### Task 4: 取引入力と証憑Drawerへ「証憑添付不可」を追加する

**Files:**

- Modify: `src/components/CostProfitSection.tsx`
- Modify: `tests/unit/components/CostProfitSection.test.tsx`

**Interfaces:**

- Consumes: Task 3のAPI operation、Task 1の状態判定
- Produces: 新規収入・既存収入の理由入力、解除、後日添付、全削除後復帰UI

- [ ] **Step 1: UIの失敗テストを書く**

React Testing Libraryで次をrole/name中心に検証する。

```ts
expect(screen.getByRole('button', { name: '証憑添付不可' })).toBeInTheDocument();
await user.click(screen.getByRole('button', { name: '証憑添付不可' }));
await user.selectOptions(screen.getByLabelText('添付できない理由'), 'bank_history_expired');
expect(screen.getByRole('button', { name: '理由を保存' })).toBeDisabled();
await user.type(screen.getByLabelText('補足メモ'), '銀行へ過去明細を照会したが取得できず');
expect(screen.getByRole('button', { name: '理由を保存' })).toBeEnabled();
```

追加で、支出にはアクションがない、後日添付で添付済み、全削除後に理由記録済み、解除後に未添付になるテストを書く。

- [ ] **Step 2: REDを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx`

Expected: 「証憑添付不可」ボタンが存在せずFAIL。

- [ ] **Step 3: 型、フォーム状態、API呼出しを実装する**

`Expense` に `evidenceUnavailable` を追加する。新規収入Drawerでは未保存の理由stateを保持し、取引作成後に `evidenceUnavailable.upsert` を呼ぶ。既存収入の証憑Drawerでは保存・更新・「未添付に戻す」を実行する。取引訂正開始時は既存記録を維持し、証憑の添付・削除時には記録を削除しない。

- [ ] **Step 4: 理由UIと注意文を実装する**

既存 `SingleSelect`、`TextAreaField`、`Button` を使い、理由選択、500文字メモ、法的注意文、保存中disabled、成功status、失敗alert/Toastを追加する。`bank_history_expired` では「確認した代替情報や再取得を試した結果を記録してください」と案内する。

- [ ] **Step 5: GREENを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx tests/unit/api/admin/cost-profit-route.test.ts`

Expected: PASS。既存の新規登録、訂正、証憑添付・削除テストもPASS。

- [ ] **Step 6: コミットする**

```powershell
git add src/components/CostProfitSection.tsx tests/unit/components/CostProfitSection.test.tsx
git commit -m "feat(accounting): record unavailable income evidence"
```

### Task 5: 一覧・ドーナツ・フィルター・CSV・帳簿を三値対応する

**Files:**

- Modify: `src/components/CostProfitSection.tsx`
- Modify: `tests/unit/components/CostProfitSection.test.tsx`

**Interfaces:**

- Consumes: `evidenceStatusOf(entry)`
- Produces: すべての取引管理表示・出力で共通の証憑状態

- [ ] **Step 1: 表示・集計の失敗テストを書く**

理由記録済み1件、未添付1件、添付済み1件、注文1件をfixtureにし、次を検証する。

```ts
expect(screen.getByText('理由記録済み')).toBeInTheDocument();
expect(screen.getByRole('tab', { name: '証憑未添付（1）' })).toBeInTheDocument();
expect(screen.getByText('理由記録済み 1件')).toBeInTheDocument();
expect(downloadedCsv).toContain('理由記録済み');
expect(downloadedCsv).toContain('銀行の閲覧期限超過');
```

- [ ] **Step 2: REDを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx`

Expected: 理由記録済みが既存の添付済みまたは未添付へ誤集計されFAIL。

- [ ] **Step 3: すべての直接receipt-length判定を共通関数へ置換する**

取引一覧、`receiptStatusCounts`、`entryTabCounts.noReceipt`、確認キュー、CSV、帳簿の証憑列・詳細、月次確認について `evidenceStatusOf` を使う。ドーナツを「添付済み」「理由記録済み」「未添付」の3区分にし、CSVへ「証憑理由」「証憑補足」を追加する。

- [ ] **Step 4: GREENを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx`

Expected: PASS。合計件数が全取引件数と一致する。

- [ ] **Step 5: コミットする**

```powershell
git add src/components/CostProfitSection.tsx tests/unit/components/CostProfitSection.test.tsx
git commit -m "feat(accounting): report unavailable evidence separately"
```

### Task 6: 税務レポートを理由記録済み独立集計へ変更する

**Files:**

- Modify: `src/components/tax/types.ts`
- Modify: `src/components/tax/FilingDocumentsView.tsx`
- Modify: `src/components/tax/TaxCalendarView.tsx`
- Modify: `src/components/tax/TaxSummaryView.tsx`
- Modify: `src/components/CostProfitSection.tsx`
- Modify: `tests/unit/components/CostProfitSection.test.tsx`
- Test existing relevant files under: `tests/unit/components/tax/`

**Interfaces:**

- Consumes: `EvidenceStatus`
- Produces: `EntryCounts` の `withReceipt`、`unavailableRecorded`、`withoutReceipt`

- [ ] **Step 1: 税務集計の失敗テストを書く**

```ts
expect(entryCounts).toEqual(expect.objectContaining({
  withReceipt: 1,
  unavailableRecorded: 1,
  withoutReceipt: 1,
}));
```

画面では「理由記録済み 1件」と「未添付 1件」を別表示し、理由記録済みが `receiptCount` に加算されないことを検証する。

- [ ] **Step 2: REDを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx`

Expected: `unavailableRecorded` が型・集計に存在せずFAIL。

- [ ] **Step 3: EntryCountsと各税務ビューを三値化する**

`taxEntryCounts` は `resolveEvidenceStatus` で分類する。提出準備完了判定は従来どおり真の `missing` が0件であることを使うが、「理由記録済み」は注意情報として独立表示し、添付済み件数には加えない。

- [ ] **Step 4: GREENを確認する**

Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx`

Expected: PASS。既存税務ビューの対象テストもPASS。

- [ ] **Step 5: コミットする**

```powershell
git add src/components/CostProfitSection.tsx src/components/tax tests/unit/components/CostProfitSection.test.tsx tests/unit/components/tax
git commit -m "feat(accounting): distinguish unavailable evidence in tax reports"
```

### Task 7: 仕様同期、E2E、セキュリティ、全体検証

**Files:**

- Modify: `docs/2_Specs/spec.md`
- Modify or Create: `e2e/FR-ADMIN-038-receipts-and-revisions.spec.ts`
- Modify: `docs/superpowers/specs/2026-08-14-income-evidence-unavailable-design.md` only if implementation reveals an approved clarification

**Interfaces:**

- Consumes: 完成したAPI/UI
- Produces: 仕様の受入条件と3 viewportの回帰証拠

- [ ] **Step 1: FREQ-249へ要件・受入条件を追加する**

手動収入に限ること、アクション名、5理由、必須メモ、4状態優先順位、後日添付・全削除復帰、三値集計、注意文をMUSTとして記載する。

- [ ] **Step 2: E2Eを先に追加してREDを確認する**

各viewportで、収入を登録し「銀行の閲覧期限超過」とメモを保存、一覧の「理由記録済み」、未添付件数からの除外、後日添付による「添付済み」を検証する。

Run: `npx.cmd playwright test e2e/FR-ADMIN-038-receipts-and-revisions.spec.ts --project=chromium --workers=1`

Expected: 実装前または未同期箇所でFAILし、失敗点が新要件を検出している。

- [ ] **Step 3: 実装を調整してE2EをGREENにする**

Run: `npx.cmd playwright test e2e/FR-ADMIN-038-receipts-and-revisions.spec.ts --project=chromium --workers=1`

Expected: mobile、tablet、desktop対象ケースがPASSし、横方向のページスクロールがない。

- [ ] **Step 4: 対象Jestをまとめて実行する**

Run:

```powershell
npm.cmd test -- --runInBand --runTestsByPath tests/unit/lib/finance/evidence-status.test.ts tests/unit/migrations/087_finance_evidence_unavailable_records.test.ts tests/unit/api/admin/cost-profit-route.test.ts tests/unit/components/CostProfitSection.test.tsx
```

Expected: 全件PASS。新規のconsole error/warningなし。

- [ ] **Step 5: lint、typecheck、docs検証を実行する**

Run: `npm.cmd run lint`

Run: `npm.cmd run typecheck`

Run: `npm.cmd run validate-docs`

Expected: PASS。生成物由来の既知エラーが出た場合はソースとの因果を切り分けて報告する。

- [ ] **Step 6: セキュリティ監査を実行する**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex/skills/security-check/scripts/audit.ps1 --files-only src/lib/finance/evidence-status.ts src/app/api/admin/kpi/cost-profit/route.ts src/components/CostProfitSection.tsx src/components/tax migrations/087_finance_evidence_unavailable_records.sql
```

Expected: Critical/Highなし、GO。入力検証、認可、RLS、監査ログ、過剰情報露出を確認する。

- [ ] **Step 7: Graphify更新と差分確認を行う**

Run: `graphify update .`

Run: `git status --short`

Run: `git diff --check`

Expected: Graphify更新完了、今回の変更だけに空白エラーなし。既存のunrelated changesは維持される。

- [ ] **Step 8: 仕様・E2E・最終調整をコミットする**

```powershell
git add docs/2_Specs/spec.md e2e/FR-ADMIN-038-receipts-and-revisions.spec.ts src/lib/finance/evidence-status.ts src/app/api/admin/kpi/cost-profit/route.ts src/components/CostProfitSection.tsx src/components/tax
git commit -m "test(accounting): verify unavailable income evidence flow"
```

コミット前に `git diff --cached` で今回対象外ファイルが含まれないことを確認する。

## Completion Criteria

- 手動収入の初期状態が未添付で、「証憑添付不可」から理由を記録できる。
- `bank_history_expired` と `other` はメモなしで保存できない。
- 後日添付は添付済み、全削除は理由記録済み、解除は未添付になる。
- 支出と注文由来収入に添付不可操作が出ない。
- 一覧、ドーナツ、フィルター、確認キュー、CSV、帳簿、税務レポートが同じ状態判定を使う。
- 理由記録済みは添付済み件数にも未添付件数にも混ぜず独立して把握できる。
- API認可、RLS、監査ログ、入力検証、対象Jest、3 viewport E2E、セキュリティ監査が完了する。
