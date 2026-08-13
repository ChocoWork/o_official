# Accounting Template Resave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登録済み取引テンプレートをフォームで変更後、同名で上書きまたは重複しない別名で新規保存できるようにする。

**Architecture:** `CostProfitSection` は保存モードと確認 UI を管理し、Route Handler は新規作成と更新を別 operation として検証する。新規作成は DB の重複エラーを競合レスポンスへ変換し、更新は対象名が存在する場合だけ内容を変更する。

**Tech Stack:** Next.js App Router、React 19、TypeScript、Zod、Supabase Postgres、Jest、React Testing Library、Playwright

## Global Constraints

- 新規取引と既存取引の編集の両方で利用できること。
- 支出と収入のテンプレート別管理、削除、IME、未保存確認を維持すること。
- 別名保存で既存名を指定した場合は「同じ名前のテンプレートが存在します。」と表示し、上書きしないこと。
- 共通 `Button`、`TextField`、`Dialog`、`SingleSelect` を使用すること。
- 既存の未コミット変更を保持し、対象箇所だけを編集すること。
- E2E は `http://localhost:3000` を使用し、終了後もサーバーを稼働させること。

---

### Task 1: API の新規作成と上書きを分離する

**Files:**
- Modify: `src/app/api/admin/kpi/cost-profit/route.ts`
- Test: `tests/unit/api/admin/cost-profit-route.test.ts`

**Interfaces:**
- Consumes: 既存の `postSchema`、`admin_finance_expense_templates`、`postMutation` JSON 契約
- Produces: `template.create` は重複を拒否し、`template.update` は `{ templateName, template }` を受け取る

- [ ] **Step 1: 新規作成の重複拒否と更新成功の失敗テストを書く**

  `template.create` の insert が PostgreSQL `23505` を返した場合に HTTP 409 と指定メッセージを返すテスト、`template.update` が `.eq('name', templateName)` で既存行を更新するテスト、対象なしを 404 にするテストを追加する。

- [ ] **Step 2: API テストを実行して RED を確認する**

  Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/api/admin/cost-profit-route.test.ts`

  Expected: `template.update` が schema に存在せず失敗し、重複作成が 409 にならない。

- [ ] **Step 3: Zod schema と永続化処理を最小実装する**

  `template.create` は `upsert` ではなく `insert` に変更する。`23505` を `{ error: '同じ名前のテンプレートが存在します。' }`、status 409 に変換する。`template.update` は元の名前をキーとして update し、更新件数が 0 の場合は 404 とする。

- [ ] **Step 4: API テストを再実行して GREEN を確認する**

  Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/api/admin/cost-profit-route.test.ts`

- [ ] **Step 5: 対象差分を確認する**

  Run: `git -c safe.directory=C:/work/o_official diff --check -- src/app/api/admin/kpi/cost-profit/route.ts tests/unit/api/admin/cost-profit-route.test.ts`

### Task 2: 上書き確認と別名保存 UI を実装する

**Files:**
- Modify: `src/components/CostProfitSection.tsx`
- Test: `tests/unit/components/CostProfitSection.test.tsx`

**Interfaces:**
- Consumes: Task 1 の `template.create` と `template.update`
- Produces: 選択時に「変更を上書き」「別名で保存」「削除」を表示し、上書き確認 Dialog を管理する

- [ ] **Step 1: 上書きと別名保存の UI 失敗テストを書く**

  登録済みテンプレート選択後にフォームを変更し、「変更を上書き」が確認前に API を呼ばず、確定後に `template.update` を送ることを検証する。確認取消では入力を保持する。別名保存では名前入力を開き、異なる名前で `template.create` を送ること、既存名では API を呼ばず指定メッセージを表示することを検証する。

- [ ] **Step 2: コンポーネントテストを実行して RED を確認する**

  Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx`

  Expected: 新しいボタンと確認 Dialog が存在しないため失敗する。

- [ ] **Step 3: UI 状態と保存ハンドラを最小実装する**

  上書き確認状態を追加し、選択中のみ3操作を表示する。「別名で保存」は選択名を初期値にし、既存名との比較を保存前に行う。成功時は一覧再取得後に保存名を選択し、失敗時はフォームと入力名を保持する。

- [ ] **Step 4: コンポーネントテストを再実行して GREEN を確認する**

  Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx`

- [ ] **Step 5: API とコンポーネントの回帰テストを実行する**

  Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx tests/unit/api/admin/cost-profit-route.test.ts`

### Task 3: 仕様と3画面幅の操作を固定する

**Files:**
- Modify: `docs/2_Specs/spec.md`
- Modify: `e2e/FR-ADMIN-025-expense-templates.spec.ts`

**Interfaces:**
- Consumes: Task 2 の表示文言と操作フロー
- Produces: 上書き、別名保存、重複拒否の受入基準とE2E回帰テスト

- [ ] **Step 1: FREQ-232 に要件と受入基準を追記する**

  登録済みテンプレート適用後の同名上書き、別名保存、別名重複拒否、確認取消時の保持を要件化する。

- [ ] **Step 2: 3画面幅の E2E テストを追加する**

  390px、768px、1280pxで上書き確認後の更新、別名保存、重複メッセージ、横スクロールなしを検証する。

- [ ] **Step 3: localhost:3000 を確認し、必要なら開発サーバーを起動する**

  `test-e2e` スキルの手順に従い、既存サーバーがなければポート3000で起動して稼働状態を維持する。

- [ ] **Step 4: 対象 E2E を実行する**

  Run: `npx.cmd playwright test e2e/FR-ADMIN-025-expense-templates.spec.ts --project=chromium --workers=1`

### Task 4: 最終検証と知識グラフ更新

**Files:**
- Modify: `graphify-out/*`（`graphify update .` の生成物）

**Interfaces:**
- Consumes: Tasks 1-3 の完成差分
- Produces: 検証済み実装と更新済みコードグラフ

- [ ] **Step 1: 対象テスト、型検査、Lint を実行する**

  Run: `npm.cmd test -- --runInBand --runTestsByPath tests/unit/components/CostProfitSection.test.tsx tests/unit/api/admin/cost-profit-route.test.ts`

  Run: `npm.cmd run typecheck`

  Run: `npm.cmd run lint`

- [ ] **Step 2: セキュリティ監査を実行する**

  `security-check` スキルの Windows 用手順に従い、対象コードを機械監査する。

- [ ] **Step 3: Graphify を更新する**

  Run: `graphify update .`

- [ ] **Step 4: 最終差分をレビューする**

  対象ファイルだけの `git diff --check` と `git diff` を確認し、既存の未コミット変更を取り込んでいないことを確認する。
