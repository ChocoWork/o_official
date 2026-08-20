# Transaction Status Label Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取引管理テーブルの「要確認」と「登録済み」を同一幅で縦に揃え、要確認ラベルと矢印の間の件数表示を削除する。

**Architecture:** 既存の `StatusBadge` の `className` 拡張を利用し、状態列だけに固定幅と中央揃えを適用する。要確認ボタンの操作とアクセシブル名称は維持し、視覚表示用の件数要素だけを削除する。

**Tech Stack:** Next.js 16、React 19.2、TypeScript、Tailwind CSS、Playwright

## Global Constraints

- 既存の `StatusBadge` を継続利用し、新しい props は追加しない。
- 未確認件数は画面上からのみ削除し、アクセシブル名称には残す。
- 要確認行の操作と登録済み行の操作不可を維持する。
- 既存の未コミット変更を上書き、破棄、コミットしない。

---

### Task 1: 状態ラベルの幅統一と件数非表示

**Files:**

- Modify: `src/components/CostProfitSection.tsx:3760-3810`
- Test: `e2e/FR-ADMIN-043-transaction-workbench.spec.ts`

**Interfaces:**

- Consumes: `StatusBadge.className`、`entryReviewItemsOf(entry)`、`openReviewDrawer(entry)`
- Produces: 同一幅の状態ラベル、視覚的な件数を含まない要確認ボタン

- [ ] **Step 1: 失敗するE2Eテストを書く**

既存テストに、最初の「要確認」と「登録済み」の幅が等しいこと、要確認ボタンの表示テキストに数字がないこと、アクセシブル名称に未確認件数が残ることを追加する。

```ts
const reviewButton = table
  .getByRole("button", { name: /の要確認の理由を開く（未確認\d+件）/ })
  .first();
const reviewBadge = reviewButton.getByText("要確認", { exact: true });
const registeredBadge = table.getByText("登録済み", { exact: true }).first();

await expect(reviewButton).toHaveText(/^要確認$/);
const reviewBox = await reviewBadge.boundingBox();
const registeredBox = await registeredBadge.boundingBox();
expect(reviewBox?.width).toBe(registeredBox?.width);
```

- [ ] **Step 2: テストが失敗することを確認する**

Run:

```powershell
npx.cmd playwright test e2e/FR-ADMIN-043-transaction-workbench.spec.ts --project=chromium --workers=1 --grep "状態が訂正あり・要確認・登録済みで色分けされる"
```

Expected: 件数 `1` が表示されているか、バッジ幅が異なるため FAIL。

- [ ] **Step 3: 最小限の実装を行う**

`StatusBadge` に `w-16 justify-center` を渡し、`open > 0` の件数 `span` を削除する。確認済みアイコンは維持する。

```tsx
<StatusBadge
  variant="text"
  shape="pill"
  size="3xs"
  tone={ENTRY_STATE_TONES[state]}
  accent
  className="w-16 justify-center font-acumin"
>
  {ENTRY_STATE_LABELS[state]}
</StatusBadge>
```

```tsx
{
  open === 0 ? (
    <i
      className="ri-checkbox-circle-fill text-2.75 text-[#16844b]"
      aria-hidden="true"
    />
  ) : null;
}
```

- [ ] **Step 4: 対象E2Eテストを再実行する**

同じ Playwright コマンドを実行し、mobile、tablet、desktop の3件が PASS することを確認する。

- [ ] **Step 5: 静的検証とセキュリティ監査を実行する**

```powershell
npx.cmd eslint src/components/CostProfitSection.tsx e2e/FR-ADMIN-043-transaction-workbench.spec.ts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex/skills/security-check/scripts/audit.ps1 --files-only src/components/CostProfitSection.tsx e2e/FR-ADMIN-043-transaction-workbench.spec.ts
git -c safe.directory=C:/work/o_official diff --check -- src/components/CostProfitSection.tsx e2e/FR-ADMIN-043-transaction-workbench.spec.ts
```

Expected: エラーなし、監査結果 GO。

- [ ] **Step 6: コードグラフを更新する**

```powershell
graphify update .
```

Expected: Graphify の出力が正常に更新される。

- [ ] **Step 7: 対象ファイルだけをコミットする**

既存変更が同じファイルに混在する場合はコミットせず報告する。混在しない場合のみ対象2ファイルを `fix(accounting): align transaction status labels` でコミットする。
