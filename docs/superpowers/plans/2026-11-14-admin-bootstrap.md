# 最初の店長を作るコマンド Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新しい環境で、鍵を持つ人だけが `npm run admin:bootstrap -- --email <メール>` を流して最初の店長を作れるようにする。

**Architecture:** 判断の筋道は `scripts/admin/bootstrap-core.ts` の1つの関数に置き、DB・Auth・監査・漏洩の照合は引数の `deps` で受ける（単体テストで差し替えるため）。`scripts/admin/bootstrap.ts` は引数・環境変数・字を出さないパスワードの入力を受け持ち、service role のクライアントで本物の `deps` を作って関数を呼ぶ。

**Tech Stack:** TypeScript、tsx、@supabase/supabase-js（service role）、zod（既存の `emailSchema`・`passwordSchema`）、Jest、Playwright

**Spec:** `docs/superpowers/specs/2026-11-14-admin-bootstrap-design.md`

## Global Constraints

- 断る条件: 有効な店長（`user_roles` の `admin`、`active = true`、`expires_at` が null か未来）が1人でもいれば、何も書かずに止まる
- パスワード: `passwordSchema`（16〜128 文字・UTF-8 で 72 バイト以内）と `checkPwnedPassword`。照合先が使えない（`unavailable`）時は通し、警告を出して監査に `outcome: 'error'`・`detail: 'pwned_check_unavailable:<reason>'` を残す
- アカウント: `auth.admin.createUser` に `email_confirm: true`・`app_metadata: { role: 'admin' }`・`user_metadata: { display_name }`
- 役割: その利用者の `user_roles` を全部 `active = false` にしてから、`admin` を `active = true`・`expires_at = null`・`assigned_by = null`・`assigned_at = now()` で入れる（`admin_set_user_role` と同じ形）
- 役割の書き込みが失敗したら、作った利用者を消す
- 監査の成功の行: `action: 'admin_bootstrap'`、`actor_id: null`、`actor_email: null`、`resource: 'users'`、`resource_id: <作った id>`、`outcome: 'success'`。パスワードを監査にも画面にも出さない
- Auth の誤りの文（メールを含みうる）は画面に出さず、`status` と `code` だけを出す
- コマンド自体は `.env` を読まない。環境変数は `SUPABASE_URL`（無ければ `NEXT_PUBLIC_SUPABASE_URL`）と `SUPABASE_SERVICE_ROLE_KEY`
- TOTP はコマンドで作らない
- `package.json` には別の作業の未コミットの変更がある。コミットには自分の `admin:bootstrap` の1行の hunk だけを入れる（`git diff package.json` で確かめ、その hunk だけを patch にして `git apply --cached`）。ほかの未追跡のファイルも add しない
- E2E は本番ビルドで流す（`npx playwright test e2e/FR-ADMIN-MISC-008`）。3000番に E2E 用でないアプリがあれば止めてから流す

## Review Focus

- メールの前後の空白・大文字: `emailSchema` が小文字にそろえる。作るのはそろえた後のメール → Task 1 のテスト `normalizes email before creating`
- 72 バイトを超える全角のパスワード（例: 全角 25 文字）: 16 文字以上でも断る → Task 1 のテスト `rejects password over 72 bytes`
- 期限切れの店長だけがいる DB: 店長はいないとみなして作る → Task 2 の結合テスト `counts only active unexpired admins`
- 端末でない入力（パイプ・CI）: 字を出さない入力ができないので、聞かずに止まる → Task 2 の単体テスト `refuses when stdin is not a TTY`
- 作った後に役割の書き込みが失敗: 利用者を消し、流し直せる → Task 1 のテスト `deletes created user when granting fails`

---

### Task 1: 判断の筋道（bootstrap-core）

**Files:**
- Create: `scripts/admin/bootstrap-core.ts`
- Test: `tests/unit/scripts/admin/bootstrap-core.test.ts`

**Interfaces:**
- Consumes: `emailSchema`・`passwordSchema`（`@/features/auth/schemas/common`）、`PwnedCheckResult`（`@/lib/pwned-password`）、`AuditEvent`（`@/lib/audit`）
- Produces:

```ts
export type BootstrapInput = { email: string; password: string; passwordConfirmation: string; displayName?: string };
export type CreateUserResult = { kind: 'created'; id: string } | { kind: 'exists' } | { kind: 'failed'; status?: number; code?: string };
export type BootstrapDeps = {
  countActiveAdmins(): Promise<number>;
  checkPwned(password: string): Promise<PwnedCheckResult>;
  createUser(args: { email: string; password: string; displayName?: string }): Promise<CreateUserResult>;
  grantAdminRole(userId: string): Promise<void>; // 失敗は throw
  deleteUser(userId: string): Promise<void>;
  audit(event: AuditEvent): Promise<void>;
};
export type BootstrapFailureReason =
  | 'invalid_email' | 'password_mismatch' | 'invalid_password' | 'admin_exists'
  | 'pwned_password' | 'email_taken' | 'create_failed' | 'grant_failed';
export type BootstrapResult =
  | { ok: true; userId: string; email: string; pwnedCheck: 'ok' | 'unavailable' }
  | { ok: false; reason: BootstrapFailureReason; message: string };
export async function bootstrapFirstAdmin(input: BootstrapInput, deps: BootstrapDeps): Promise<BootstrapResult>;
```

確かめる順（先に断れる物から）: メールの形 → 2回の一致 → `passwordSchema` → `countActiveAdmins() > 0` → 漏洩 → 作成 → 役割 → 成功の監査。`message` は日本語。`invalid_password` の `message` は zod の最初の文をそのまま使う。

- [ ] **Step 1: 失敗するテストを書く**

`deps` は呼ばれた順と引数を記録する偽物で作る。テスト名と確かめる事:

- `creates admin when no admin exists`: `countActiveAdmins → 0`、`checkPwned → ok`、`createUser → created 'u1'`。結果が `{ ok: true, userId: 'u1', email: 'owner@example.com', pwnedCheck: 'ok' }`。`grantAdminRole('u1')` が呼ばれ、`audit` が `{ action: 'admin_bootstrap', actor_id: null, actor_email: null, resource: 'users', resource_id: 'u1', outcome: 'success' }` で1回呼ばれる
- `normalizes email before creating`: 入力 `'  Owner@Example.COM '` → `createUser` の `email` が `'owner@example.com'`
- `refuses when an admin exists`: `countActiveAdmins → 1` → `reason: 'admin_exists'`。`checkPwned`・`createUser`・`audit` は呼ばれない
- `rejects mismatched confirmation`: `reason: 'password_mismatch'`。`countActiveAdmins` も呼ばれない
- `rejects short password`: 15 文字 → `reason: 'invalid_password'`、`message` が `'パスワードは16文字以上で入力してください'`
- `rejects password over 72 bytes`: `'あ'.repeat(25)` → `reason: 'invalid_password'`
- `rejects pwned password`: `checkPwned → { status: 'pwned', count: 3 }` → `reason: 'pwned_password'`。`createUser` は呼ばれない
- `continues when pwned check is unavailable`: `checkPwned → { status: 'unavailable', reason: 'timeout' }` → `ok: true`、`pwnedCheck: 'unavailable'`。`audit` に `{ outcome: 'error', detail: 'pwned_check_unavailable:timeout' }` の行と成功の行の2回
- `refuses existing email`: `createUser → exists` → `reason: 'email_taken'`。`grantAdminRole` は呼ばれない
- `reports create failure without auth message`: `createUser → { kind: 'failed', status: 500, code: 'unexpected_failure' }` → `reason: 'create_failed'`、`message` に `500` と `unexpected_failure` を含む
- `deletes created user when granting fails`: `grantAdminRole` が throw → `reason: 'grant_failed'`、`deleteUser('u1')` が呼ばれ、`audit` に `{ outcome: 'failure', detail: 'grant_failed', resource_id: 'u1' }`
- `never passes password to audit`: どの場合も、`audit` に渡した全部の値を `JSON.stringify` した文字列にパスワードが含まれない

- [ ] **Step 2: 失敗を確かめる**

Run: `npx jest tests/unit/scripts/admin/bootstrap-core.test.ts`
Expected: FAIL（`bootstrap-core` が無い）

- [ ] **Step 3: `bootstrapFirstAdmin` を `scripts/admin/bootstrap-core.ts` に書く**

ファイルの頭の TSDoc に `@impl`・`@design` を付ける（ID は Task 3 で取る番号。`documentation-guide` に従う）。

- [ ] **Step 4: 通るのを確かめる**

Run: `npx jest tests/unit/scripts/admin/bootstrap-core.test.ts`
Expected: PASS（12 件）

- [ ] **Step 5: コミット**

```bash
git add scripts/admin/bootstrap-core.ts tests/unit/scripts/admin/bootstrap-core.test.ts
git commit -m "feat(admin): 最初の店長を作る判断の筋道を足す"
```

### Task 2: コマンドと本物の deps

**Files:**
- Create: `scripts/admin/bootstrap.ts`
- Create: `scripts/admin/bootstrap-deps.ts`
- Modify: `package.json`（`scripts` に `"admin:bootstrap": "tsx scripts/admin/bootstrap.ts"` の1行だけ）
- Test: `tests/unit/scripts/admin/bootstrap-cli.test.ts`
- Test: `tests/integration/db/admin-misc/admin_bootstrap.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 の `bootstrapFirstAdmin`・`BootstrapDeps`・`BootstrapResult`、`checkPwnedPassword`、`logAudit`
- Produces:

```ts
// scripts/admin/bootstrap-deps.ts
export function createBootstrapDeps(client: SupabaseClient): BootstrapDeps;
// scripts/admin/bootstrap.ts
export type CliIo = {
  env: NodeJS.ProcessEnv;
  argv: string[];
  isTTY: boolean;
  readHidden(prompt: string): Promise<string>;
  print(line: string): void;
};
export async function runBootstrapCli(io: CliIo, makeDeps?: (url: string, key: string) => BootstrapDeps): Promise<number>; // 終了コード 0 / 1
```

`bootstrap.ts` は、直接流された時だけ本物の `CliIo`（`process.stdin` を読み、打った字を出さない）で `runBootstrapCli` を呼び、`process.exitCode` に入れる。`runBootstrapCli` の流れ: 引数（`node:util` の `parseArgs`、`--email` 必須・`--name` 任意）→ 環境変数 → `向ける先: <ホスト名>` を出す → `isTTY` でなければ止まる → `countActiveAdmins()` が 0 より大きければパスワードを聞かずに止まる → `readHidden` を2回 → `bootstrapFirstAdmin` → 結果を出す。成功の時は、id とメールと「最初のログインで TOTP を登録する」案内を出す。

`createBootstrapDeps` の中身:
- `countActiveAdmins`: `user_roles` を `roles!inner(code)` で結び、`roles.code = 'admin'`・`active = true`・`expires_at` が null か今より後で、`count: 'exact', head: true`
- `createUser`: Auth の誤りが「already registered」系（`code === 'email_exists'`、または `message` に `already` を含む）なら `exists`。ほかの誤りは `failed`（`status`・`code` だけを持つ）
- `grantAdminRole`: `roles` から `code = 'admin'` の id を引き、`user_roles` を更新して入れる（Global Constraints の形）。どこかで誤りがあれば throw
- `deleteUser`: `auth.admin.deleteUser`
- `audit`: `logAudit`（`@/lib/audit`）。tsx で `src/lib/supabase/server.ts` の読み込みが失敗する時は、`maskAuditEvent` を通した行を同じ `client` で `audit_logs` に入れる形に替え、その理由をコミットの本文に書く

- [ ] **Step 1: 失敗する CLI の単体テストを書く**

`tests/unit/scripts/admin/bootstrap-cli.test.ts`。`makeDeps` は偽物を返す。

- `refuses without email argument`: `argv: []` → 1 を返す。`readHidden` は呼ばれない
- `refuses without service role env`: `SUPABASE_SERVICE_ROLE_KEY` が無い → 1
- `prints target host`: `SUPABASE_URL = 'http://127.0.0.1:54321'` → 出た行に `向ける先: 127.0.0.1` がある
- `refuses when stdin is not a TTY`: `isTTY: false` → 1。`readHidden` は呼ばれない
- `does not prompt when an admin exists`: `countActiveAdmins → 1` → 1。`readHidden` は呼ばれない
- `creates admin and prints next step`: 2回とも同じ強いパスワード → 0。出た行に作った id と `TOTP` がある。どの行にもパスワードが無い

- [ ] **Step 2: 失敗を確かめる**

Run: `npx jest tests/unit/scripts/admin/bootstrap-cli.test.ts`
Expected: FAIL（`bootstrap` が無い）

- [ ] **Step 3: `runBootstrapCli` と `createBootstrapDeps` を書き、`package.json` に1行足す**

- [ ] **Step 4: 単体テストが通るのを確かめる**

Run: `npx jest tests/unit/scripts/admin/bootstrap-cli.test.ts tests/unit/scripts/admin/bootstrap-core.test.ts`
Expected: PASS

- [ ] **Step 5: 結合テストを書く（手元の Supabase）**

`describeLocalDb` で包む。手元の DB には E2E の店長が残っているので、作る側の試験は `countActiveAdmins` だけを 0 を返す物に替えた `deps` で流し、ほかは本物を使う。作った利用者は `afterAll` で消す。

- `counts only active unexpired admins`: 試し用の利用者を3人作り、`admin` を `active = true`・`active = false`・`expires_at = now() - interval '1 day'` で1人ずつ付ける。本物の `countActiveAdmins` の値が、付ける前より 1 だけ増える
- `creates confirmed admin with role and audit`: `e2e-bootstrap-<乱数>@example.com` で作る。DB で `auth.users.email_confirmed_at` が null でない、`raw_app_meta_data->>'role' = 'admin'`、`user_roles` の有効な行が `admin` の1行だけ、`audit_logs` に `action = 'admin_bootstrap'`・`outcome = 'success'`・`resource_id = <id>` の行が1行
- `refuses with real admin count`: 本物の `deps` のまま流す → `reason: 'admin_exists'`（手元の DB に店長がいるので）。新しい `auth.users` の行が増えない

- [ ] **Step 6: 結合テストが通るのを確かめる**

Run: `npm run db:start` の後、`npx jest tests/integration/db/admin-misc/admin_bootstrap.integration.test.ts`
Expected: PASS（3 件。DATABASE_URL が無くて skip なら失敗とみなす）

- [ ] **Step 7: コミット**

`package.json` は自分の hunk だけを index に入れる（Global Constraints）。

```bash
git add scripts/admin/bootstrap.ts scripts/admin/bootstrap-deps.ts tests/unit/scripts/admin/bootstrap-cli.test.ts tests/integration/db/admin-misc/admin_bootstrap.integration.test.ts
git commit -m "feat(admin): 最初の店長を作るコマンドを足す"
```

### Task 3: E2E と文書

**Files:**
- Create: `e2e/FR-ADMIN-MISC-008-first-admin-bootstrap.spec.ts`
- Create: `docs/06_Operations/first-admin-bootstrap.md`
- Modify: `docs/06_Operations/README.md`（新しい文書への相対リンク）
- Modify: `docs/02_Requirements/areas/admin.md`（要件と受け入れ条件。ID は `documentation-guide` に従い次の番号）
- Modify: `docs/03_BasicDesign/areas/admin.md`（構成に、コマンドと deps の分け方を1節）
- Modify: `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（状態欄）
- Modify: `scripts/admin/bootstrap-core.ts`・`scripts/admin/bootstrap.ts`（`@impl`・`@design` の ID を取った番号に合わせる）

**Interfaces:**
- Consumes: Task 1 の `bootstrapFirstAdmin`、Task 2 の `createBootstrapDeps`、`loginAsMember`（`e2e/member-session-helpers.ts`）、`viewports`（`e2e/order-fulfillment-test-utils.ts`）

- [ ] **Step 1: E2E を書く**

390 / 768 / 1280px の3つで、テスト名の頭に受け入れ条件の ID を付ける。各幅で: `countActiveAdmins` だけを 0 に替えた `deps` で `e2e-bootstrap-<乱数>@example.com` の店長を作る → `loginAsMember` → `/auth/verified` を開く → `管理画面利用のために2要素認証（TOTP）を登録してください。` の文と `2要素認証（TOTP）を登録` のボタンが見える。作った利用者は後で消す。trace は切る（`test.use({ trace: 'off' })`）。

- [ ] **Step 2: E2E が通るのを確かめる**

Run: `npx playwright test e2e/FR-ADMIN-MISC-008`
Expected: 3 passed

- [ ] **Step 3: 文書を書く**

`first-admin-bootstrap.md` に書く事: いつ使うか（新しい環境だけ）、前提（`db:reset` の後、または新しい Supabase に移行を当てた後）、流し方の例（手元は `npx tsx --env-file=.env.development.local scripts/admin/bootstrap.ts --email <メール>`、ほかの環境は端末で環境変数を置いてから `npm run admin:bootstrap -- --email <メール>`）、止まる場合と次の手、最初のログインで TOTP を登録すること、鍵を端末の履歴に残さない注意、目指さないこと（締め出された時の立て直しは別）。

- [ ] **Step 4: 確かめる**

Run: `npm run validate-trace`、`npm run test:trace-coverage`、`npm run trace:report`、`npm.cmd run validate-docs`
Expected: 4つとも通る（validate-trace は baseline より増えない）

- [ ] **Step 5: コミット**

```bash
git add e2e/FR-ADMIN-MISC-008-first-admin-bootstrap.spec.ts docs/06_Operations/first-admin-bootstrap.md docs/06_Operations/README.md docs/02_Requirements/areas/admin.md docs/03_BasicDesign/areas/admin.md docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md docs/05_Quality/reports scripts/admin
git commit -m "test(admin): 最初の店長のコマンドの E2E と手順書を足す"
```
