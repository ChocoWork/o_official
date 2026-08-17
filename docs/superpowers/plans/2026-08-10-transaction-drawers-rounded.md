# 取引入力・確認画面の角丸統一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取引入力 Drawer と取引確認 Drawer の外枠、入力欄、選択欄、カード、ボタンを既存 UI コンポーネントの props で中程度の角丸へ統一する。

**Architecture:** `CostProfitSection` の対象 Drawer で `Drawer`、`Button`、`SingleSelect`、`TextField`、`TextAreaField`、`Panel` の公開 props を使用する。画面固有の内部 CSS 上書きや新しい角丸ユーティリティは追加せず、既存コンポーネント API で不足が判明した場合だけ型付き shape/radius props を UI 層へ追加する。

**Tech Stack:** Next.js 16、React 19、TypeScript、既存 UI コンポーネント、Jest、Playwright

## Global Constraints

- 配色、余白、文言、データ処理、操作フローを変更しない。
- 角丸は Drawer と主要要素を 8px 相当、入れ子の小カードを 6px 相当とする。
- 既存 UI コンポーネントの props を優先し、不足する場合のみ UI コンポーネントへ再利用可能な props を追加する。
- ピル型バッジとラジオボタンの完全な丸形は維持する。
- 既存の未コミット変更を上書きまたはコミットしない。

---

### Task 1: 角丸要件を回帰テストとして固定する

**Files:**

- Modify: `e2e/FR-ADMIN-043-transaction-workbench.spec.ts`
- Modify: `e2e/FR-ADMIN-049-entry-review-acknowledgement.spec.ts`

**Interfaces:**

- Consumes: `Drawer` の `data-ui-drawer-shape`、各 UI コンポーネントの `data-ui-*` 属性
- Produces: 取引入力・確認画面の角丸契約を検証する Playwright テスト

- [ ] **Step 1: 取引入力 Drawer の失敗するテストを書く**

  `新規取引フォームは既存UIコンポーネントの角丸を使う` を追加し、対象 Drawer の `data-ui-drawer-shape="rounded"`、事業形態のトリガーの `data-ui-single-select-shape="rounded"`、日付入力の `data-ui-text-field-shape="rounded"`、取消・保存ボタンの `data-ui-button-shape="rounded"` を検証する。

- [ ] **Step 2: 取引確認 Drawer の失敗するテストを書く**

  `取引確認画面は既存UIコンポーネントの角丸を使う` を追加し、対象 Drawer、取引概要 Panel、要確認理由 Panel、確認メモ TextAreaField、確認ボタンの shape/radius 属性を検証する。

- [ ] **Step 3: RED を確認する**

  Run: `npx playwright test e2e/FR-ADMIN-043-transaction-workbench.spec.ts e2e/FR-ADMIN-049-entry-review-acknowledgement.spec.ts --project=chromium --workers=1 --grep "既存UIコンポーネントの角丸"`

  Expected: 対象要素が現在 `square` または UI コンポーネント未使用のため FAIL。

### Task 2: 既存 UI コンポーネントで角丸を実装する

**Files:**

- Modify: `src/components/CostProfitSection.tsx`
- Modify only if existing API is insufficient: `src/components/ui/*/*_type.ts`, matching component and CSS
- Test only if a UI prop is added: `tests/unit/components/<Component>.test.tsx`

**Interfaces:**

- Consumes: `Drawer shape="rounded"`、`Button shape="rounded"`、`SingleSelect shape="rounded"`、`TextField shape="rounded"`、`TextAreaField shape="rounded"`、`Panel radius="rounded"`
- Produces: 既存 UI API のみで角丸が統一された2つの Drawer

- [ ] **Step 1: 取引入力 Drawer を最小変更する**

  `entryDrawer` の Drawer、全 SingleSelect、種別・閉じる・保存・取消などの Button に `rounded` を指定する。直接描画している `input` と `textarea` は、外部ラベルと ARIA を維持したまま `TextField` と `TextAreaField` に置き換え、`shape="rounded"` を指定する。

- [ ] **Step 2: 取引確認 Drawer を最小変更する**

  `reviewDrawer` を `shape="rounded"` にし、取引概要と理由カードを `Panel radius="rounded"` で表現する。重複候補の小カードも既存 Panel を使い、確認メモは `TextAreaField shape="rounded"`、操作は `Button shape="rounded"` にする。

- [ ] **Step 3: 新しい UI prop が必要な場合だけ単体テストを先に追加する**

  公開属性 `data-ui-<component>-shape="rounded"` または `data-ui-<component>-radius="rounded"` を期待する Jest テストを書き、対象テストが FAIL することを確認してから型、コンポーネント、CSS を最小実装する。既存 props で足りる場合はこの手順を省略する。

- [ ] **Step 4: GREEN を確認する**

  Run: `npx playwright test e2e/FR-ADMIN-043-transaction-workbench.spec.ts e2e/FR-ADMIN-049-entry-review-acknowledgement.spec.ts --project=chromium --workers=1 --grep "既存UIコンポーネントの角丸"`

  Expected: PASS。

- [ ] **Step 5: 関連回帰と静的検証を実行する**

  Run: `npm test -- --runInBand tests/unit/components/Drawer.test.tsx tests/unit/components/Button.test.tsx`

  Run: `npm run typecheck`

  Run: `npm run lint`

  Run: `npm run build`

  Expected: すべて exit code 0。

- [ ] **Step 6: Graphify を更新し差分を確認する**

  Run: `graphify update .`

  Run: `git -c safe.directory=C:/work/o_official diff --check`

  Expected: Graphify 更新成功、空白エラーなし。既存の未コミット変更は保持されている。

- [ ] **Step 7: 対象ファイルだけをコミットする**

  Run: `git add src/components/CostProfitSection.tsx e2e/FR-ADMIN-043-transaction-workbench.spec.ts e2e/FR-ADMIN-049-entry-review-acknowledgement.spec.ts docs/superpowers/plans/2026-08-10-transaction-drawers-rounded.md`

  UI コンポーネントを変更した場合だけ、その実装と単体テストも明示的に追加する。

  Run: `git commit -m "feat(finance): 取引画面の角丸を統一"`
