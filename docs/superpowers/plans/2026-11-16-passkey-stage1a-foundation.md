# パスキー 段1a（土台）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** パスキー置き換えの段1のうち「土台」を作る。手元の Supabase で、店員のログインの状態をフック1か所で締め、管理の入口（API と RLS）の3つの条件を判定し、試験と手元の開発が店員として入れる状態にする。

**Architecture:** (1) 先に本番へ流れる道を止める（CI の push の引き金）。(2) supabase-js を 2.119.0 に固定し、手元の config でパスキーを有効にする。(3) 移行で、窓・認めたパスキー・設定の表、送る予定の表（outbox）、フック、`auth.webauthn_credentials` の引き金を作る。ここまでは今のログインを壊さない（フックは有効にしない）。(4) 管理の入口の3つの条件を、TS と SQL で「まだつながない」形で作り、緑で確かめる。(5) 切り替えを**1つのコミット**にする（フックの有効化、`has_permission` の置き換え、`admin-rbac`、全部の試験の道具・偽装・skip）。(6) 手元の開発で店員として入るスクリプトを作る。

**Tech Stack:** Next.js App Router、`@supabase/supabase-js` 2.119.0（固定）、`@supabase/ssr`、Postgres 17（Supabase CLI 2.116 の手元）、GoTrue v2.196.0、Jest、Playwright（本番ビルド）、`tsx`。

**Spec:** [docs/superpowers/specs/2026-11-07-passkey-auth-design.md](../specs/2026-11-07-passkey-auth-design.md)（コミット 81e48bdf 時点が正本）。測った事実は [手元の試しの結果](../specs/2026-11-16-passkey-local-trial-results.md)（特に「段1への材料」）と [回数の制限の調べ](../specs/2026-11-16-passkey-rate-limit-research.md)。レビューの指摘は `.superpowers/sdd/2026-11-16-passkey-local-trials/stage1a-plan-review.md`。実行する人は、この計画と設計書の両方を読む。

## 分け方（段1は1a・1bに分ける）

段1は1つの計画には大きい。この文書は **1a だけ**を書く。

| 計画 | 中身 |
| --- | --- |
| **1a（この文書）** | 本番への道を止める、supabase-js・config、3つの表・フック・引き金・outbox、管理の入口の3つの条件（API と RLS）、設定の表を読む関数、全部の試験の道具の作り直し、手元の開発の店員のスクリプト |
| 1b（次の計画。ここでは作らない） | パスキーのサーバーの窓口（登録の始め・終わり、ログインの始め (a)・(b)・終わり、一覧・名前・削除）、UV の門（5-3）、始めの窓口の IP ごとの回数の制限、`PASSKEY_START_DEV_IP`、鍵の形の確認、`Sb-Forwarded-For` の運用の手順、フックの拒否を見たら更新の窓口がセッションを終わらせること、CSP の `connect-src`、`loginAsMember` の確認、**`return-intent-service.ts`（154行目の `viewer.aal !== 'aal2'`）・`oauth/callback/route.ts`（182行目）・`post-login`・`return-path.ts`・`confirm` の `aal` の判定をパスキーの条件に直すこと**（店員がアプリのログインの窓口から入る道が1bで初めてできるため）、ADR-0466 以降（1a は ADR を 0463〜0465 だけ使う） |

1a と 1b の接続: `src/lib/auth/staff-passkey-reject.ts`、DB の関数 `public.passkey_approve`・`passkey_window_open`・`passkey_window_close`・`passkey_approved_count`、JWT の印 `staff_passkeys_ok`。

## Global Constraints

設計書とリポジトリの決まりから、1行ずつ。全部のタスクの要件に含まれる。

**本番の安全（オーナー決定 2026-11-16）**

- **1a は本番の DB に何も当てない**。実行者（サブエージェント）は、本番に一切触れない。Supabase の MCP（`apply_migration`・`execute_sql` など、本番を指す物）も使わない。`supabase config push` は使わない。`.env*` は読まない・表示しない
- **本番に当てるのは調整役だけ。段3、またはオーナーの許可を得た時に、1本ずつ**: Supabase の MCP の `apply_migration` を、名前をファイルの版（`version_name`）と同じにして1本ずつ呼ぶ。当てた後、`schema_migrations` の `md5(statements[1])` を読み、ファイルと突き合わせる（これまでの当て方と同じ）。`apply_migration` は当てた時刻で版を付け直すので、当てた後に、ファイルの名前を当てた版に合わせて変える（これまでの「改名」のコミットと同じ。1a の後の手順で、1a の作業は止めない）。**`supabase db push`（どの形でも）と、GitHub の `workflow_dispatch` は動かさない**（未適用の移行が全部流れるため）。1a の移行（`passkey` を含む5本。Task 4・5・6・8・9）は、1b と段3が済むまで本番に当てない（本番に当てると、パスキーを有効にするまでだれも管理の権限を持てない）
- master への push は許される。ただし、この計画の間は、push のたびに調整役がオーナーの許可を得る（実行者は push しない）
- 本番に当てるのは、開発を手元の Supabase に切り替えた後（設計 4-3）。`docs/06_Operations/accounting-p1-journal-foundation.md` の記録では 2026-11-08 に切り替え済み。この計画は本番に当てないので、実行の前にその記録の確認日を読み直すだけでよい
- 移行の版（ファイル名の時刻）は、**作る時の時刻**で付ける（`ls supabase/migrations | tail` で前後を確かめる）。この計画の `2026111700…` は仮の名前。別の作業の移行が先に本番に当たっても、版の順が崩れないよう、作る時に最新より後の時刻にする
- **`package.json` には別の作業のコミットしていない変更（`"dev": "next dev --webpack"`）がある。対話の命令（`git add -p`）は使えない**。`package.json` を足す時は、①`git diff package.json > own.patch`（作業用の場所に書く）、②`own.patch` から `"dev"` の行の塊を消す（自分の変更の塊だけにする）、③`git apply --cached own.patch`、④`git diff --cached package.json` の出力に `next dev --webpack` が含まれず、自分の変更（Task 2 なら `supabase-js` の版、Task 10 なら `dev:staff`）が含まれることを確かめる、の順で行う。塊を手で直した時は `git apply --cached --recount` を使う。`package.json` を足す全てのタスク（2・10）がこの手順に従う

**手元の Supabase の扱い**

- 手元の Supabase は、同じ機械の最初の店長の流れ（admin-bootstrap のセッション）と共有している。そのセッションは手元の DB を使っておらず、DB は空（2026-11-16 に確認）。`supabase stop`・`start`・`db reset` の前に待たない。調整役が1行で知らせるだけにする
- DB 結合の試験と E2E の実行は、手元の同じ Supabase を触るので、調整役だけが流す。実装者は書いて、単体の試験を流し、流し方を報告に書く。DB 結合は `npx.cmd jest --config jest.config.cjs tests/integration/db/<ファイル>`（`DATABASE_URL` が要る。`describeLocalDb` が手元の DB だけを許す）。`jest.integration.config.cjs` は無い
- E2E は必ず本番ビルド（`next build && next start`）で、390・768・1280 の3幅。dev サーバーでは流さない。流す前に 3000 番のアプリを止める（`Get-NetTCPConnection -LocalPort 3000 -State Listen`）。`retries` を上げて通さない。落ちたら単独の再実行・他の幅・エラーの種類（`goto` か アサーションか）の順で切り分ける

**設計の守り**

- パスキーはベータ版。supabase-js は **2.119.0 に固定**（`^` を付けない）
- フックの関数は `SECURITY DEFINER`・持ち主 `postgres`・`SET search_path = ''`。`supabase_auth_admin` には**関数の `execute` だけ**を渡し、表の `select` は渡さない（表の権限は持ち主の `postgres` で効く）。`public`・`authenticated`・`anon` から `execute` を外す。試験は `set role supabase_auth_admin` で流し、店員が拒否されること（静かにお客さん扱いで素通しにならないこと）まで確かめる
- 管理の入口の3条件: (1) `amr` に `passkey` がある、(2) その `timestamp` から 86400 秒以内（`<= 86400`。未来の時刻は不可）、(3) **認めたパスキーが2本以上であることを、DB でその場で数える**（API は RPC `passkey_approved_count`、RLS は `has_permission` の中）。JWT の `staff_passkeys_ok` は**ヒントとして残すが、判定には使わない**。これは設計 5-2 の3つ目の条件の変更（オーナー決定 2026-11-16）。同じコミットで設計書の 5-2・12（18番を足す）を直す
- 24時間の基準は、`amr` の `passkey` の `timestamp`（ログインの時刻。更新しても変わらない）。`public.sessions` の行の時刻は使わない。TS の定数 `STAFF_MAX_SESSION_SECONDS = 86400` と DB の設定の行の値は、同じ値にする。変える時は両方を同じコミットで変える（ADR に書く。試験が一致を確かめる）
- JWT の `aal` は、パスキーでは `aal1` のまま。管理の入口の判定に `aal2` を使わない
- お客さんの `password` を拒否する規則は、設定の旗 `reject_customer_password`（既定は偽）に置き、段4まで偽。お客さんのログインと `loginAsMember` の経路を壊さない
- 拒否の応答は HTTP 403・`code` は `unknown`・`message` にフックの文。文の頭に決まった印 `[staff-passkey-required]` を付ける
- **403 の本文の文言 `MFA required` と `denial.reason = 'mfa'` は1aでは変えない**（意味だけパスキーの条件に変わる。画面の判定が6ファイル・試験が76ファイルで使っているため）。名前の変更は MFA を消す段4。ADR に書く
- パスワードを変える窓口（`password/change/start`・`confirm`）は触らない。店員は `aal2` を求められたまま閉じる側に倒れるだけ。段4で消す
- 最初の店長のコマンド `npm run admin:bootstrap`（パスワード＋TOTP）は変えない。本番用に残す。手元は Task 10 のスクリプトを使う

**リポジトリの決まり**

- 要求管理（範囲内の領域 AUTH）: 要求・要件・受け入れ条件は `docs/02_Requirements/areas/auth.md` に `SR-AUTH-NNN`（`requirements.md` には書かない）。基本設計は `docs/03_BasicDesign/areas/auth.md`、設計判断は `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md`、脅威は `docs/05_Quality/security/threats/auth.md`、処理の詳細は `docs/04_DetailDesign/sequence/auth-*.md` の `DD-AUTH-NNN`。コードには TSDoc の `@impl IMPL-AUTH-NNN`・`@design DD-AUTH-NNN`。書式は `documentation-guide` スキルに従う
- **文書と追跡は、そのタスクのコミットに入れる**（最後にまとめない）。各タスクの「文書」の行の ID を同じコミットで足し、`npm.cmd run validate-trace`・`npm.cmd run test:trace-coverage`・`npm.cmd run validate-docs` が通ることを、そのコミットの前に確かめる。`scripts/trace/baseline.json` から増やさない
- 番号の予約（着手時に `grep` で空きを確かめる）: `SR-AUTH-010` から、`DD-AUTH-043` から、`IMPL-AUTH-240` から、`SEC-AUTH-036` から。ADR は 0463（管理の入口の条件）・0464（フック1か所・窓・認めたパスキー。Task 4 で作り、Task 5 で足す）・0465（引き金と outbox）。1b は 0466 から。CI を止めたことは ADR にせず、運用の文書（`db-migrations.md`）だけに書く
- E2E のファイル名は `e2e/FR-LOGIN-NNN-<kebab>.spec.ts`（既存の最大は 038。039 から）。テスト名の先頭に要求の ID。DB 結合の試験の名前は `tests/integration/db/auth_passkey_*.integration.test.ts`、単体は `tests/unit/lib/auth/staff-passkey*.test.ts`（追跡の範囲に入る名前。Task 4 で範囲を直す）
- DB の移行は `docs/06_Operations/db-migrations.md` に、ファイル・MD5・戻し方・「本番未適用」を記録する。台帳 `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md` の状態欄を、作業の進みに合わせて更新する
- 読みにくい漢字（ページを表す古い字）は使わず「ページ」と書く。文は設計書と同じやさしい日本語
- master で直接作業する。タスクごとに1コミット。末尾に `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。`graphify update .` は自分で流さない。**未追跡のファイルを `git add -A` で足さず、自分が作った物だけを名前で足す。`package.json` は上の `apply --cached` の手順で、自分の塊だけを足す**
- モデル: 書き手は Sonnet、レビューは Opus（effort high）

## 影響の棚卸し（Task 9 の範囲。2026-11-16 の実測。着手時に同じ式で数え直す）

フックを有効にし、管理の入口を置き換えると、次が赤になる。Task 9 が全部直す。

| 区分 | 探す式 | 件数（実測） |
| --- | --- | --- |
| E2E: `createAdminSessionActor` を直に呼ぶ | `grep -l createAdminSessionActor e2e/*.ts` | 22ファイル（spec 17本＋道具5本） |
| E2E: 道具を通して呼ぶ spec | `grep -l "accounting-test-utils\|discount-test-utils\|home-test-utils\|look-admin-test-utils" e2e/*.spec.ts` | accounting 41、discount 19、home 4、look-admin 3 |
| E2E: パスワード＋TOTP で店員を作る道具・spec | `grep -lE "mfa_amr_claims\|totp\|TOTP\|enroll-totp" e2e` | 17ファイル。道具: `news-test-utils`・`stockist-admin-test-utils`・`order-email-test-utils`（作り直す）。spec: FR-LOGIN-030〜034・038、FR-ADMIN-MISC-002・003・008、FR-NEWS-SEC-005、FR-STOCKIST-014（**店員を古い道で作っているだけの試験は書き直す。skip は、確かめている中身が段4で消す機能の時だけ**。下の決まり） |
| 単体・結合: claims に `aal2` を入れて通している | `grep -rlE "aal2" tests` | 97ファイル。共有の元: `tests/unit/api/admin/accounting-route-harness.ts`、`tests/integration/db/helpers/app-session.ts`（既定が aal2）、`tests/integration/db/helpers/admin-table-grants.ts`、`tests/integration/api/*-admin-*.test.ts`（約40本）、`tests/integration/db/auth_has_permission_aal2.integration.test.ts`、`tests/unit/e2e/admin-session-test-utils.test.ts` |

**skip と書き直しの決まり**: **skip にしてよいのは、その試験が確かめている中身が、段4で消す機能（TOTP の画面と窓口、パスワードのログイン、`create-user`、MFA のやり直し、最初の店長のコマンド）の時だけ**。古い道（パスワード＋TOTP）で店員を作っているだけで、確かめている中身が今も効いている守り（監査の行、CSRF、直接の呼び出しの拒否、戻り先、置き場の消し忘れなど）の試験は、`createAdminSessionActor` か `provisionStaff` に書き直して通す。**書き直す**: FR-NEWS-SEC-005（`createAdminSessionActor('admin','aal2')` を使っているだけ。手助けを読み替えれば通る）、FR-STOCKIST-014、FR-LOGIN-030・031・034・038 のうち店員の作り方だけが古い `test(...)`。**skip にして台帳に残す（候補）**: FR-LOGIN-032（管理者の TOTP と aal2）、FR-LOGIN-033（verify 画面・管理者の refresh の偽装）、FR-ADMIN-MISC-002（`create-user`）、FR-ADMIN-MISC-003 の MFA のやり直しの部分、FR-ADMIN-MISC-008（最初の店長のコマンド）。実際の一覧は Task 9 Step 1 の棚卸しで、1つの `test(...)` ごとに確かめた中身を見て確定する。skip は `test.skip(true, '段4で消す機能: <理由>')` の形で、理由と戻す段（段4）を書き、台帳と `test-gaps.md`（`docs/05_Quality/` 配下の既存の置き場。無ければ台帳の節）に一覧にする。**最初の店長のコマンドは本番用に残す**ので、コードは変えず、試験だけ skip

## Review Focus

設計書が暗に求めるが、試験に書きにくい入力。先頭ほど起きやすい。

1. **`amr` が欠ける・空・配列でない・`timestamp` が文字列・欠落・未来・ちょうど86400秒・86401秒の店員**: 欠ける・空・配列でない・文字列・未来・86401秒は拒否、86400秒は通す（Task 8 の TS と SQL）
2. **認めたパスキーが1本・0本・認めた鍵が GoTrue の直叩きで消された直後の店員**: 次の更新を待たず、その場で管理の権限なし。JWT の `staff_passkeys_ok` が真のままでも断る（Task 8・9）
3. **フックに壊れた入力（`claims` 無し・`amr` が null・`user_id` が不正・未知の `authentication_method`）**: 例外を投げない。お客さんは素通し、店員は拒否。`supabase_auth_admin` の権限で流しても店員が拒否される（Task 5）
4. **ユーザー削除の連鎖でパスキーが消える時**: 削除は止まらない。お客さんなら通知を積まない。店員なら削除された本人には積まず、店長に知らせる行を積む。outbox への書き込みが落ちても、鍵とユーザーの削除は成功する（Task 6）
5. **店員が GoTrue を直に叩いて足したパスキー**: 認めたパスキーに入らず、数に入らない（Task 4・6・8）

---

## ファイルの全体図

| 区分 | ファイル | タスク |
| --- | --- | --- |
| 変える | `.github/workflows/db-migrations.yml` | 1 |
| 変える | `package.json`・`package-lock.json`、`supabase/config.toml`、`scripts/trace/scope.json`、`.gitignore` | 2・3・4・10 |
| 作る | `supabase/migrations/2026111700NNNN_passkey_*.sql` の5本（A 表・B フック・C 引き金・Task 8 の判定の関数だけ・D `has_permission` の置き換え。時刻は作る時） | 4・5・6・8・9 |
| 作る | `src/lib/auth/staff-passkey-reject.ts`、`src/lib/auth/staff-passkey.ts` | 5・8 |
| 作る | `e2e/passkey-soft-authenticator.ts`、`scripts/e2e/passkey-staff.ts`、`scripts/dev/passkey-dev-staff.ts` | 7・10 |
| 作る | `tests/unit/helpers/staff-claims.ts`（偽装の claims の共有の元） | 8 |
| 変える | `src/lib/auth/admin-rbac.ts`、`src/app/api/auth/me/route.ts`、`e2e/admin-session-test-utils.ts`、棚卸しの全ファイル | 9 |

---

### Task 1: 本番へ流れる道を止める（CI の push の引き金）

**Files:**
- Modify: `.github/workflows/db-migrations.yml`（`on:` から `push:` のブロックを消す。`pull_request`（dry-run だけ）と `workflow_dispatch` は残す。コメントに「`supabase db push` は未適用の移行を全部流すので、段3まで動かさない。本番へは調整役が MCP の `apply_migration` で1本ずつ当てる」を書く。`deploy` の job は手動の入口を残すが、使わない決まり）
- Test: `tests/unit/ci/db-migrations-workflow.test.ts`
- Modify（文書）: `docs/06_Operations/db-migrations.md`（CI の引き金を止めた日・理由・戻す時（段3の後）、本番へは調整役が MCP の `apply_migration` で1本ずつ当て `md5(statements[1])` を突き合わせる決まり、`db push` と `workflow_dispatch` は動かさないこと）。**ADR は作らない**（一時の運用の手当てで、ログインの設計の判断ではないため。運用の文書だけに書く）

**Interfaces:** なし。

- [ ] **Step 1: 失敗する試験を書く** — ワークフローのファイルを文字列で読み、(a) `on:` の中に `push:` が無い、(b) `workflow_dispatch` がある、(c) `pull_request` の job は `db push --dry-run` で、`db push` の実適用の job（`deploy`）の `if` が `workflow_dispatch` の時だけ真になる（`github.event_name == 'workflow_dispatch'` を含む）、を確かめる
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/ci/db-migrations-workflow.test.ts` → FAIL
- [ ] **Step 3: 直す** — 上のとおり。`deploy` の `if` は `github.event_name == 'workflow_dispatch'`（今は `!= 'pull_request'`）
- [ ] **Step 4: 通ることを確かめる** — 試験 PASS。`npm.cmd run validate-docs` が通る（運用文書はこのタスクの範囲）
- [ ] **Step 5: コミット** — `.github/workflows/db-migrations.yml`・試験・文書を名前で足す → `ci(db): 移行の本番適用を push で動かさず手動だけにする`。調整役がオーナーの許可を得てから push する（GitHub は push した先頭のコミットのワークフローで判断するので、後のコミットと一緒に push しても、別に先に push しなくても安全）

### Task 2: supabase-js・@supabase/ssr を上げて固定し、E2E の新しい比べる元を作る

**Files:**
- Modify: `package.json`（`@supabase/supabase-js` を `"2.119.0"` に固定。`@supabase/ssr` は、`npm view @supabase/ssr versions` と各版の `peerDependencies` を見て 2.119.0 を許す最新の版に固定）、`package-lock.json`
- Create: `tests/unit/config/supabase-js-pin.test.ts`

**Interfaces:**
- Produces: 全タスクが `auth.passkey.startRegistration / verifyRegistration / startAuthentication / verifyAuthentication / list / update / delete` と `auth.admin.passkey.listPasskeys / deletePasskey` を型付きで呼べる。**E2E の比べる元**: `.superpowers/sdd/2026-11-16-passkey-stage1a/e2e-baseline-after-deps.json`（調整役が作る。コミットしない）

- [ ] **Step 1: 失敗する試験を書く** — (a) `package.json` の `dependencies['@supabase/supabase-js']` が文字列 `'2.119.0'`、(b) `createClient('http://localhost:54321','k').auth.passkey.startRegistration` と `.auth.admin.passkey.listPasskeys` が `'function'`
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/config/supabase-js-pin.test.ts` → FAIL
- [ ] **Step 3: 上げる** — `npm.cmd install --save-exact @supabase/supabase-js@2.119.0` と選んだ `@supabase/ssr` を入れる。選んだ版と理由（peer の範囲）をコミットの本文に書く。`package.json` の別の作業の塊（`dev` の行）を足さない（Global Constraints の `apply --cached` の手順）
- [ ] **Step 4: 通ることを確かめる** — 試験 PASS。`npm.cmd run typecheck`・`npm.cmd run lint`・`npm.cmd test`（単体全件）が上げる前と同じ結果。**調整役が E2E を全件、本番ビルド・3幅で流し**（設計 10「上げる時は E2E を全部流す」）、結果の JSON を比べる元として保存する。2026-11-07 の `e2e-full4.json` は古い（88件の赤のうち85件は会計の作業の途中だった）ので、1a の比べる元にはこの新しい結果を使う。赤があれば、上げる前の `package.json` に戻して流した結果と見比べ、上げたことが原因の赤かを切り分ける
- [ ] **Step 5: コミット** — `chore(auth): supabase-js を 2.119.0 に固定しパスキーの型を使えるようにする`

### Task 3: 手元の config でパスキーを有効にする

**Files:**
- Modify: `supabase/config.toml`（`[auth.passkey] enabled = true`、`[auth.webauthn] rp_display_name`・`rp_id = "localhost"`・`rp_origins`（`http://localhost:3000` と `http://127.0.0.1:3000`））、`tests/unit/supabase/config-wave6.test.ts`

**Interfaces:**
- Produces: 手元の GoTrue の `/auth/v1/settings` に `passkeys_enabled: true`。フックの項目はまだ書かない（Task 9 で書く。関数が在る前にフックを指すとログインが落ちるため）。TOTP の項目は触らない（止めるのは段4）。

- [ ] **Step 1: 失敗する試験を足す** — 既存の config 試験の読み方に合わせ、`auth.passkey.enabled === true`、`auth.webauthn.rp_id === 'localhost'`、`rp_origins` が上の2つを含む、`auth.hook.custom_access_token` はまだ有効でない
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/supabase/config-wave6.test.ts` → FAIL
- [ ] **Step 3: config を変える** — コメントを外して値を入れる
- [ ] **Step 4: 通ることを確かめる** — 試験 PASS。調整役が1行で知らせてから `npx.cmd supabase stop` → `start`。確かめは秘密を出さない形で行う（`supabase status -o json` を `node -e` の中で読み、公開の鍵で `/auth/v1/settings` を呼び、`passkeys_enabled` の値だけを表示する。`supabase status` の出力そのものは表示しない）
- [ ] **Step 5: コミット** — `feat(auth): 手元の Supabase でパスキーを有効にする`

### Task 4: 表・設定・窓と認めたパスキーの関数（移行 A）と、追跡の範囲の修正

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_foundation_tables.sql`
- Modify: `scripts/trace/scope.json`（下の「範囲の直し」）
- Test: `tests/integration/db/auth_passkey_foundation.integration.test.ts`（`tests/integration/db/helpers/local-db.ts` の `describeLocalDb` と `accounting_p1_grants.integration.test.ts` の書き方に合わせる）
- 文書（同じコミット）: `SR-AUTH-010`（店員のパスキーの表・窓・認めたパスキー、受け入れ条件は下の試験の項目）、`DD-AUTH-043`（`docs/04_DetailDesign/sequence/auth-staff-passkey-entry.md` を作る）、`ADR-0464-access-token-hook-single-gate.md`（**このタスクで作る**。表・窓・認めたパスキーの判断を書く。Task 5 でフックの判断を足す）、`SEC-AUTH-036`（表の権限・窓の取り違え）、`docs/03_BasicDesign/areas/auth.md`（表・関数の一覧）、`db-migrations.md`、台帳

**範囲の直し（`scripts/trace/scope.json`）:** AUTH の `docs` に `docs/03_BasicDesign/decisions/ADR-046[3-9]*.md` を足す。ADMIN の `docs/03_BasicDesign/decisions/ADR-04[5-9]*.md` を `ADR-045*.md` と `ADR-046[0-2]*.md` の2行に狭め、重ならないようにする。AUTH の `src` に足すのは **`src/lib/auth/staff-passkey*.ts` と、単体の試験がある `scripts/dev/passkey-dev-staff.ts` だけ**。`src/lib/auth/admin-rbac.ts` と `scripts/e2e/passkey-staff.ts` は足さない（`test:trace-coverage` は範囲の中の通っていない分岐を全部 `test-gaps.md` に書くことを求めるが、`admin-rbac.ts` の試験は範囲の外で、`passkey-staff.ts` は DB 結合でしか通らず `DATABASE_URL` が無い時は skip になるため、足すと落ちる）。AUTH の `src` に足した後、`npm.cmd run test:trace-coverage` を流し、単体で届かない分岐（`--open` のブラウザを開く所など）は `test-gaps.md` の節に書く。ADMIN の ADR の glob を狭めた後は、これから足す ADR-047x がどの範囲にも入らないので、その時に範囲を足すことを `docs/03_BasicDesign/decisions/README.md` に1行書く。AUTH の `tests` に `tests/unit/lib/auth/staff-passkey*.test.ts`・`tests/unit/ci/db-migrations-workflow.test.ts`・`tests/unit/config/supabase-js-pin.test.ts`・`tests/unit/scripts/passkey-dev-staff.test.ts`・`tests/unit/e2e/passkey-*.test.ts`・`tests/integration/db/auth_passkey_*.integration.test.ts`（既存の `auth_*` に当たるので足さなくてよいかを確かめる）。直した後に `npm.cmd run validate-trace` が通り、新しい ADR・src・試験が AUTH に数えられることを確かめる。

**Interfaces:**
- Produces（Task 5・6・8・9 と 1b が使う。名前・型を変えない）:
  - 表 `private.passkey_staff_config`（1行。`id boolean primary key default true check (id)`、`staff_max_session_seconds integer not null default 86400`、`staff_idle_seconds integer not null default 3600`、`window_minutes integer not null default 30`、`min_approved_passkeys integer not null default 2`、`reject_customer_password boolean not null default false`）と `private.passkey_staff_settings() returns jsonb`（`SECURITY DEFINER`・`STABLE`。`public`・`anon`・`authenticated` から `execute` を外す。`has_permission` が使う）
  - 表 `private.approved_passkeys`（`passkey_id uuid primary key`、`user_id uuid not null`（**外部キーは張らない**。ユーザー削除の連鎖で行が先に消えると、引き金が店員かを判定できなくなるため。認めの行を消すのは Task 6 の引き金だけ。ほかのユーザー削除の後始末は認めの行を消さない）、`credential_id` は手元の `auth.webauthn_credentials` の列の型に合わせ（`\d` で実測して移行のコメントに書く）`not null unique`、`approved_via text check in ('window','reauth','script')`、`approved_at`。`user_id` に索引）
  - 表 `private.passkey_registration_windows`（`id`、`user_id uuid not null`、`session_id uuid not null`、`opened_at`、`expires_at`、`closed_at`。案 B）
  - 表 `private.passkey_notification_outbox`（`id`、`seq bigint generated always as identity`、`user_id uuid not null`（外部キー無し）、`kind text check in ('passkey_added','passkey_removed','passkey_key_replaced')`、`passkey_id uuid`、`friendly_name text`、`subject_is_staff boolean not null`、`notify_subject boolean not null`（本人にも送るか。ユーザー削除の連鎖では偽）、`subject_email text`（`notify_subject` が真の行には、積んだ時の本人のメールを写す。送る時に引き直すと、乗っ取った人が積んだ後にメールを変えた場合、知らせが乗っ取った人の宛先に届くため。店長の宛先は送る時に引く。送る処理は段2・段3）、`occurred_at`、`status text not null default 'pending' check in ('pending','sending','retry_wait','sent','skipped','dead')`、`attempts integer not null default 0`、`next_attempt_at`）。メールを送る処理は段2・段3
  - `public.passkey_approve(p_user_id uuid, p_passkey_id uuid, p_via text) returns void`（`SECURITY DEFINER`。`auth.webauthn_credentials` から `credential_id` を写す。その鍵の持ち主が `p_user_id` でなければ例外）
  - `public.passkey_window_open(p_user_id uuid, p_session_id uuid) returns timestamptz`（`auth.sessions` で、その `session_id` が `p_user_id` の物であることを確かめ、違えば例外。`window_minutes` 後の `expires_at` を返す。同じ `session_id` の開いた窓があれば作らず既存の期限を返す）、`public.passkey_window_close(p_session_id uuid) returns void`、`public.passkey_window_is_open(p_user_id uuid, p_session_id uuid) returns boolean`（`user_id` と `session_id` の両方を合わせる）、`public.passkey_approved_count(p_user_id uuid) returns integer`（**数え方: `private.approved_passkeys ap` と `auth.webauthn_credentials c` をつなぎ、`c.id = ap.passkey_id and c.user_id = ap.user_id` の行だけを数える**。鍵が実際に在る認めだけが数に入るので、引き金が動かなかった時（`TRUNCATE`・`DISABLE TRIGGER`・Task 6 の例外の囲み）でも、消えた鍵は数えられない）。**上の `public.passkey_*` は全部、`service_role` だけが `execute` できる**
- 前の確かめ（`DO`）: `auth.webauthn_credentials`・`private` スキーマが在る（`private.app_session_is_live` は Task 9 で要る物。ここでは見ない）

- [ ] **Step 1: 失敗する試験を書く** — (a) 設定の1行の既定値、(b) 4つの表は `anon`・`authenticated` に権限が無い、`public.passkey_*` は `authenticated` が `execute` できず `service_role` はできる、`private.passkey_staff_settings()` は `authenticated` が呼べない、(c) `passkey_approve` は他人の鍵で例外・自分の鍵で1行・2回呼んでも1行、(d) `passkey_window_open` は同じ `session_id` で2回呼んで行が1つ・期限が +30分、別の人の `session_id` で例外、`passkey_window_close` の後に `passkey_window_is_open` が偽、期限切れで偽、`user_id` が違うと偽、(e) 認めていない鍵は `passkey_approved_count` に数えられない、(f) 認めの行が残っていても、対応する `auth.webauthn_credentials` の行が無ければ（`ALTER TABLE ... DISABLE TRIGGER` した取引の中で鍵を消す。持ち主でなく流せない時は、鍵の無い認めの行を直に入れる。認めの `passkey_id` が別の人の鍵）数えられない。`approved_passkeys` の行を直に入れる試験の道具は、先に `auth.webauthn_credentials` に行を直に入れる（列は `\d` で実測。引き金で outbox に行が積まれるのは構わない）
- [ ] **Step 2: 失敗を確かめる** — 調整役が流して FAIL
- [ ] **Step 3: 移行を書く** — 1取引。関数は `CREATE OR REPLACE`・`SET search_path = ''`。末尾に権限と本体の `DO` の assert。先頭に戻し方（逆順の `DROP`）と、本番に当てる前に読む確認。`scope.json` と文書を直す
- [ ] **Step 4: 通ることを確かめる** — 調整役が1行で知らせて `db reset`、同じ試験が PASS。`npm.cmd run validate-trace`・`test:trace-coverage`・`validate-docs` が通る
- [ ] **Step 5: コミット** — `feat(auth): パスキーの窓・認めたパスキー・設定・通知の表と関数を足す`

### Task 5: Custom Access Token フックの関数（移行 B。有効にはしない）

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_access_token_hook.sql`、`src/lib/auth/staff-passkey-reject.ts`
- Test: `tests/integration/db/auth_passkey_access_token_hook.integration.test.ts`、`tests/unit/lib/auth/staff-passkey-reject.test.ts`
- 文書（同じコミット）: `SR-AUTH-011`、`DD-AUTH-044`、ADR-0464 に追記（フックは1か所・窓は案 B でフックは窓を書かない・お客さんの `password` の拒否は旗で段4・拒否の印）、`SEC-AUTH-037`（フックが壊れると全員が止まる）、`db-migrations.md`、台帳、`@impl`

**Interfaces:**
- Produces:
  - SQL `public.passkey_access_token_hook(event jsonb) returns jsonb`（`SECURITY DEFINER`・持ち主 `postgres`・`search_path` 空）。結果（設計 5-2）:
    - 店員（`user_roles` で有効な `admin`・`supporter`。期限切れは店員でない）が `passkey` か `token_refresh` で、`amr` の `passkey` の `timestamp` から `staff_max_session_seconds` 以内 → 通す。最上位に `staff_passkeys_ok`（認めたパスキーが `min_approved_passkeys` 以上か。**数え方は Task 4 の `passkey_approved_count` と同じ、`approved_passkeys` と `auth.webauthn_credentials` をつなぐ数え方**。**ヒントであり、判定には使わない**）を足す
    - 店員で、`claims.session_id` と `user_id` の両方が同じ開いた窓がある → 通す（`staff_passkeys_ok` は偽。`amr` に `passkey` が付かないため管理の入口で止まる）
    - 店員のそれ以外（`otp`・`oauth`・`password`、24時間を超えた `passkey` や更新、閉じた窓、未知の方法）→ 拒否 `{"error":{"http_code":403,"message":"[staff-passkey-required] ..."}}`
    - お客さん: `authentication_method = 'password'` かつ `reject_customer_password` が真の時だけ拒否。それ以外は入力をそのまま返す
    - どんな入力でも例外を投げない（`EXCEPTION WHEN OTHERS` で、店員を判定できなければ拒否、お客さんなら素通し）。**判定できない時に店員を素通しにしない**
  - 権限: `supabase_auth_admin` に `execute` だけ。表の `select` は渡さない。`public`・`authenticated`・`anon` から外す
  - TS `export const STAFF_PASSKEY_REQUIRED_MARKER = '[staff-passkey-required]'`、`export function isStaffPasskeyRequiredError(error: { status?: number; message?: string } | null | undefined): boolean`（`status === 403` かつ `message` が印で始まる）
- Consumes: Task 4 の表。

- [ ] **Step 1: 失敗する試験を書く** — DB 結合は **`set role supabase_auth_admin` で関数を呼ぶ**（持ち主でなく呼び手の権限）。店員×（`passkey` 新しい／ちょうど86400秒／86401秒／未来／`timestamp` が文字列・欠落、`token_refresh` で新しい／古い、`otp`・`oauth`・`password`、窓が開いている `otp`／閉じた／別の `session_id`／別の `user_id` の窓、認めた鍵 2／1／0 本で `staff_passkeys_ok` が 真／偽／偽）、お客さん×（`passkey`・`otp`・`password`（旗が偽で通る／旗を真にして拒否））。Review Focus 3 の壊れた入力。`supabase_auth_admin` で実行でき、`authenticated`・`anon` で実行できない。`supabase_auth_admin` が `private` の表を直に `select` できない。TS: 印で始まる403は真、印の無い403・印で始まる401・`null` は偽
- [ ] **Step 2: 失敗を確かめる** — 調整役が流して FAIL（単体は `npx.cmd jest tests/unit/lib/auth/staff-passkey-reject`）
- [ ] **Step 3: 実装する** — 移行（前の確かめで Task 4 の表・関数が在ること、末尾に権限と本体の assert）と TS。`amr` の読みは `jsonb_typeof(claims->'amr') = 'array'` を確かめてから要素を見る。`timestamp` は `^[0-9]+$` の時だけ数にする
- [ ] **Step 4: 通ることを確かめる** — 調整役が `db reset` の後に PASS。`validate-trace`・`test:trace-coverage`・`validate-docs` が通る
- [ ] **Step 5: コミット** — `feat(auth): 店員をパスキーでだけ入れるフックの関数を足す（まだ有効にしない）`

### Task 6: パスキーの足し・消しの引き金と送る予定の積み込み（移行 C）

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_credential_events.sql`
- Test: `tests/integration/db/auth_passkey_credential_events.integration.test.ts`
- 文書（同じコミット）: `SR-AUTH-012`、`DD-AUTH-045`、`ADR-0465-passkey-credential-trigger-outbox.md`、`SEC-AUTH-038`（拾えない道: `TRUNCATE`・`DISABLE TRIGGER`・`session_replication_role = replica`・outbox の書き込みの失敗を握りつぶす・GoTrue の複製の検知なし。**残る危険として受け入れること: 認めた鍵が1本も無い店員を削除した時、連鎖で `user_roles` が先に消えると店員かどうかが分からず、店長への知らせが出ないことがある**（認めた鍵が無い店員は管理の権限を持てず、ユーザー削除は別に記録が残る）。`subject_email` の写し）、`db-migrations.md`、台帳

**Interfaces:**
- Produces: `private.passkey_credentials_notify() returns trigger`（`SECURITY DEFINER`・持ち主 `postgres`・`search_path` 空・`execute` は誰にも渡さない）と、`auth.webauthn_credentials` への `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW` の引き金 `passkey_credentials_notify`。規則:
  - `INSERT` → outbox に `passkey_added`。`DELETE` → `passkey_removed` を積み、同じ `passkey_id` の `approved_passkeys` の行を消す
  - `UPDATE` は `credential_id` か `public_key` が変わった時だけ → `passkey_key_replaced` を積み、その鍵の認めを消す。名前・回数・最後に使った時刻だけの更新は何もしない
  - `subject_is_staff` は、積む時点で、有効な店員（`user_roles`）か、**その鍵の認めの行を今回消したか**、のどちらか。認めの行は `DELETE FROM private.approved_passkeys WHERE passkey_id = OLD.id`（`RETURNING` は付けない）で消し、**その直後の次の文で `v_was_approved := FOUND`** として控える（間に別の文を挟まない。`FOUND` は直前の文の結果で、挟むと上書きされる）。②の `subject_is_staff` はこの変数で決める。削除を先にしても「認めた鍵だった」という手がかりが消えない。`INSERT` では認めの削除は無く、`user_roles` だけで決める
  - `notify_subject`: その `user_id` の `auth.users` の行がまだ在れば真。無い（ユーザー削除の連鎖の途中）なら偽。店員が削除された時は、行を積んで店長に知らせ、削除された本人には送らない。お客さんが削除された時（`subject_is_staff` が偽で `notify_subject` が偽）は積まない
  - **引き金の中の順番: ①認めの行の削除（`DELETE`・鍵の差し替え）を先に、例外の囲みの外で行う。②その後、outbox への書き込みだけを `BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE WARNING ... END` の囲みに入れる**。囲みの中に認めの削除を入れない（例外で取り消されると、消した鍵の認めが残るため）。outbox への書き込みが落ちても、パスキーの削除・ユーザーの削除を止めない。知らせの取りこぼしは `SEC-AUTH-038` に書いて受け入れる。念のため、本数の数え方も `auth.webauthn_credentials` と突き合わせる（Task 4。引き金が動かない道でも消えた鍵は数えられない）
  - `notify_subject` が真の行には、`subject_email` に積んだ時の本人のメール（`auth.users.email`）を写す
- 前の確かめ（`DO`）: `auth.webauthn_credentials` が在り、現在の役割が引き金を作れる（`has_table_privilege(current_user,'auth.webauthn_credentials','TRIGGER')`）。末尾に、引き金の存在と有効（`tgenabled = 'O'`）の確かめ。**本番で引き金を作れるか・GoTrue の更新で消えないかは未確認（設計 8-2 の3）**とコメントに書く

- [ ] **Step 1: 失敗する試験を書く** — `postgres` で行を入れる・消す・更新して outbox を数える。(a) 追加で1行、削除で1行で認めた鍵なら認めも消える、(b) 名前だけ・回数と最後に使った時刻だけの更新で増えない、(c) `public_key` の変更で `passkey_key_replaced` が1行・認めが消える、(d) Review Focus 4: お客さんを `delete from auth.users` で削除（連鎖）→ 削除は成功し outbox は増えない、(e0) **連鎖の順に左右されない確かめ**: 店員（`user_roles` と認めた鍵2本）で、①`user_roles` の行を先に消し、その後 `auth.users` を消す（連鎖で鍵が消える）、②ユーザーごと消す（`user_roles` を先に消さない）、の両方で、`subject_is_staff` が真・`notify_subject` が偽の行が積まれる（認めの削除を先にしても、`RETURNING` で控えた値で店員と分かる）。(e) **店員（`user_roles` と認めた鍵2本）を削除 → 削除は成功し、`subject_is_staff` が真・`notify_subject` が偽の行が鍵の本数だけ積まれる**、(f) outbox に `CHECK (false) NOT VALID` の制約を足した取引の中で認めた鍵を消しても、**削除は成功し、かつ `approved_passkeys` の行が消えていて、`passkey_approved_count` が減っている**（元に戻す）。鍵の差し替えでも同じ。(f2) `ALTER TABLE ... DISABLE TRIGGER` した取引の中で鍵を消しても、`passkey_approved_count` は減る（Task 4 の突き合わせ）。表の持ち主（`supabase_auth_admin`）でなく `DISABLE TRIGGER` が流せない時は、対応する `auth.webauthn_credentials` の行が無い認めの行を `approved_passkeys` に直に入れる形で、数えられないことを確かめる、(g) 引き金の関数の `execute` を `anon`・`authenticated`・`service_role` が持たない、(h) 店員が `INSERT` した認めていない鍵は `passkey_approved_count` に数えられない
- [ ] **Step 2: 失敗を確かめる** — 調整役が流して FAIL
- [ ] **Step 3: 実装する** — 移行
- [ ] **Step 4: 通ることを確かめる** — 調整役が `db reset` の後に PASS。Task 4・5 の試験も PASS のまま。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): パスキーの足し・消しを DB の引き金で拾い送る予定の表に積む`

### Task 7: ソフトの認証器と、店員の用意・ログインの共有の道具

**Files:**
- Create: `e2e/passkey-soft-authenticator.ts`、`scripts/e2e/passkey-staff.ts`
- Test: `tests/unit/e2e/passkey-soft-authenticator.test.ts`（`tests/unit/e2e/` は既に在り、jest の対象）、`tests/integration/db/auth_passkey_staff_provisioning.integration.test.ts`
- 文書（同じコミット）: `SR-AUTH-013`（手元の試験の道具。本番に試験専用の入口を作らない）、`DD-AUTH-046`、`@impl`、台帳

**Interfaces:**
- Produces（`e2e/passkey-soft-authenticator.ts`）:
  - `export type SoftAuthenticator = { credentialId: Buffer; signCount: number; register(options: PublicKeyCredentialCreationOptionsJSON, opts?: { userVerified?: boolean }): RegistrationResponseJSON; authenticate(options: PublicKeyCredentialRequestOptionsJSON, opts?: { userVerified?: boolean }): AuthenticationResponseJSON }`
  - `export function createSoftAuthenticator(config: { origin: string; rpId: string }): SoftAuthenticator`（ES256 の鍵の対を `node:crypto` で作る。attestation は `none`。`authenticatorData` の flags は `userVerified` が既定で真なら登録 `0x45`・ログイン `0x05`、偽なら UV の `0x04` を落とす（位置 32）。署名は `authenticatorData || SHA-256(clientDataJSON)`。CBOR はこの形だけを書く小さな関数。外のライブラリを足さない）。型は supabase-js 2.119.0 の `auth.passkey` の戻りの型から取り、公開されていなければ必要な項目だけをこのファイルに置く
- Produces（`scripts/e2e/passkey-staff.ts`）:
  - `export async function provisionStaff(db: PgClient, input: { role: 'admin' | 'supporter'; approvedPasskeys: 0 | 1 | 2; email?: string }): Promise<{ userId: string; email: string; authenticators: SoftAuthenticator[] }>` — 管理 API でパスワード無しの利用者を作り（`app_metadata.role`）、**役割が無い間に** magiclink の session（`admin.generateLink` → `verifyOtp`）で `approvedPasskeys` 本を登録し、`passkey_approve(..., 'script')` で認め、最後に `user_roles` を有効にする（案 B の順）。**既にいる店員は再利用しない**（有効な店員の magiclink はフックに拒否され、TOTP の要素が残ると GoTrue がパスキーの登録に aal2 を求めるため）。同じメールが既にあれば投げる
  - `export async function loginWithPasskey(input: { email: string; authenticator: SoftAuthenticator }): Promise<{ session: Session }>` — `auth.passkey.startAuthentication`（captcha は `e2e/captcha-test-utils.ts` の手元のテスト用トークンを `options.captchaToken` で渡す）→ `authenticate` → `verifyAuthentication`
  - 手元の Supabase の住所でなければ投げる（`scripts/e2e/environment` の `isLocalUrl`）。失敗の文面に JWT・鍵を出さない。接続情報は、呼び手が環境変数で渡すか、手元の `supabase status -o json` をプロセスの中で読む（`.env*` は読まない）
- Consumes: Task 3（config）、Task 4（`passkey_approve`）。この時点でフックは有効でない。

- [ ] **Step 1: 失敗する試験を書く** — 単体: `register()` の `attestationObject` を読み戻し、`authData` の位置 32 の flags が `0x45`、`userVerified:false` で `0x41`。`authenticate()` の署名が登録した公開鍵で検証でき、`signCount` が増える。結合: `provisionStaff(db,{role:'admin',approvedPasskeys:2})` の後、`approved_passkeys` が2行・`user_roles` が有効。`loginWithPasskey` が session を返し、JWT の `amr` に `passkey`・`aal` が `aal1`・`session_id` がある。同じメールで2回呼ぶと投げる
- [ ] **Step 2: 失敗を確かめる** — 単体 `npx.cmd jest tests/unit/e2e/passkey-soft-authenticator`、結合は調整役。FAIL
- [ ] **Step 3: 実装する** — 上のとおり。1本ずつ別の `createSoftAuthenticator`
- [ ] **Step 4: 通ることを確かめる** — 単体・結合 PASS。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `test(auth): ソフトの認証器と店員の用意・ログインの道具を足す`

### Task 8: 管理の入口の3つの条件を「まだつながない」形で作る（7'）

**Files:**
- Create: `src/lib/auth/staff-passkey.ts`、`tests/unit/helpers/staff-claims.ts`、`supabase/migrations/<時刻>_passkey_staff_entry_conditions_fn.sql`（関数だけ。`has_permission` は変えない）
- Test: `tests/unit/lib/auth/staff-passkey.test.ts`、`tests/integration/db/auth_passkey_staff_entry_conditions.integration.test.ts`
- 文書（同じコミット）: `SR-AUTH-014`（店員の入口は、パスキー・24時間以内・認めたパスキー2本以上を、その場で数えて判定する）、`DD-AUTH-047`、`ADR-0463-staff-entry-by-passkey-conditions.md`（`aal2` を使わない理由、置き換えの範囲、DB でその場で数える理由、定数と設定の行を同時に変える決まり、`MFA required` の文言を保つ決め）、`SEC-AUTH-039`（JWT の印を信じない）、`docs/03_BasicDesign/areas/auth.md`、**設計書 `docs/superpowers/specs/2026-11-07-passkey-auth-design.md` の 5-2（3つ目の条件を「その場で DB で数える。印はヒント」に直す）・5-2 の説明の「JWT に入れる」の言い回し・12-2 に「8. 認めた鍵が消えた後は、DB でその場で数えてすぐ止める（オーナー決定 2026-11-16）」・12 の18番**、ADR-0409・0418 の `aal2` の部分に「置き換え済み（ADR-0463）」（有効になるのは Task 9 だが、置き換えの決めはここで記録する）、`db-migrations.md`、台帳

**Interfaces:**
- Produces:
  - TS `export const STAFF_MAX_SESSION_SECONDS = 86400`、`export const STAFF_MIN_APPROVED_PASSKEYS = 2`、`export type StaffEntryResult = { ok: true } | { ok: false; reason: 'no_passkey' | 'passkey_expired' | 'passkeys_insufficient' }`、`export function evaluateStaffEntry(claims: { amr?: unknown } | null | undefined, approvedCount: number, nowSeconds: number): StaffEntryResult`。順: `amr` に `passkey` があり数の `timestamp` がある（無ければ `no_passkey`）→ `0 <= now - timestamp <= 86400`（外れたら `passkey_expired`）→ `approvedCount >= 2`（外れたら `passkeys_insufficient`）。`passkey` の要素が複数なら最も新しい時刻。`approvedCount` は DB で数えた値（JWT の印ではない）
  - SQL（どれも `STABLE`・`SECURITY DEFINER`・`search_path` 空。`execute` は `public`・`anon`・`authenticated` から外す。24時間と本数は `private.passkey_staff_settings()` から読む）:
    - `private.staff_passkey_amr_ok(claims jsonb) returns boolean` — 条件1・2（`amr` の `passkey` と、`0 <= now - timestamp <= 86400`）。安い確かめ
    - `private.staff_passkey_count_ok(p_user_id uuid) returns boolean` — 条件3。Task 4 の `passkey_approved_count` と同じ突き合わせの数え方で、`min_approved_passkeys` 以上
    - `private.staff_passkey_entry_ok(p_user_id uuid, claims jsonb) returns boolean` — 上の2つの両方。（`has_permission` は2つを別々の位置で呼ぶ。Task 9）
  - `tests/unit/helpers/staff-claims.ts`: `export function staffEntryClaims(overrides?: Record<string, unknown>): JwtPayload`（`aal1`・`amr` に今の時刻の `passkey`・`staff_passkeys_ok: true`・`session_id`・`sub`・`email`）と `export function mockApprovedCount(rpcMock, count: number)`（`passkey_approved_count` の RPC の戻りを差す）。Task 9 が偽装の元として使う
- Consumes: Task 4 の `passkey_approved_count`・設定の関数。

- [ ] **Step 1: 失敗する試験を書く** — 単体: Review Focus 1（`amr` 無し・空配列・配列でない・文字列の `timestamp`・未来・ちょうど86400秒は ok・86401秒は `passkey_expired`・`oauth`/`otp` だけは `no_passkey`）、`approvedCount` が 0・1 は `passkeys_insufficient`、2 は ok。DB 結合: 関数を `set local request.jwt.claims` 相当の claims で直に呼び、同じ表（TS と同じ値の組）。TS の定数と設定の既定値の一致。認めた鍵を `auth.webauthn_credentials` から消した直後に本数が減り、関数が偽になる（Review Focus 2・5）。`staff_passkeys_ok` の印が真でも、認めた鍵が1本なら偽
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/lib/auth/staff-passkey` と調整役の DB 結合。FAIL
- [ ] **Step 3: 実装する** — 上の署名のとおり。`admin-rbac.ts`・`has_permission` は**まだ変えない**
- [ ] **Step 4: 通ることを確かめる** — 単体・DB 結合 PASS。今の E2E・単体・結合は何も変わらず緑のまま（調整役が `npm.cmd test` を流して確かめる）。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): 管理の入口の3つの条件の判定を作る（まだ管理の入口につながない）`

### Task 9: 切り替え（8'）。フック・`has_permission`・`admin-rbac`・全部の試験の道具を1コミットで

**1つのコミットにする。作業の途中は赤になる。コミットの前に、下の確かめが全部緑であること。レビューはこのコミット全体を1つとして見る。**

**Files:**
- Modify: `supabase/config.toml`（`[auth.hook.custom_access_token] enabled = true`・`uri = "pg-functions://postgres/public/passkey_access_token_hook"`）、`tests/unit/supabase/config-wave6.test.ts`
- Create: `supabase/migrations/<時刻>_passkey_staff_entry_conditions.sql`（`public.has_permission(text)` を `CREATE OR REPLACE`。`aal2` の枝を、**今の位置（ACL の前）に `private.staff_passkey_amr_ok(claims)` で置き換え、本数の確かめ `private.staff_passkey_count_ok(uid)` は ACL が真になった後、`app_session_is_live` の呼び出しの前に置く**（`has_permission` は約100の決まり（RLS）から行ごとに呼ばれることがあり、お客さんの呼び出しが `approved_passkeys` まで届かないようにするため）。それ以外の本体・`app_session_is_live` の呼び出し・権限・`SET search_path` は `20261029120100_sec_has_permission_aal2_member_rls.sql` と同じ。置き換える前の本体の md5 を移行のコメントに残す。前の確かめに `private.app_session_is_live(uuid)` と Task 8 の関数の存在）
- Modify: `src/lib/auth/admin-rbac.ts`（289行目の `claims.aal !== 'aal2'` の枝を `evaluateStaffEntry(claims, approvedCount, now)` に置き換える。`approvedCount` は `checkAuthSessionLiveness`・`resolveAclPermissions` と並べて RPC `passkey_approved_count` を `Promise.all` で呼ぶ。RPC が誤りを返したら 503 `Retry-After: 30`（liveness の `unavailable` と同じ扱い）。RPC が数でない値・`null` を返したら 0本として扱い、403（閉じる側に倒す）。応答は 403 `{ error: 'Forbidden', reason: 'MFA required', ... }`・`denial.reason = 'mfa'` のまま）、`src/app/api/auth/me/route.ts`（54行目の `mfaVerified` を `evaluateStaffEntry` に。ここは**表示のヒント**で、`approvedCount` は JWT の `staff_passkeys_ok` が真なら2、そうでなければ0とする。権限の判定は `admin-rbac` が行う。ADR-0463 に1行書く: 認めた鍵が消えた後、最長1時間（次の更新まで）は管理画面の枠が見えるが、API は DB で数えて 403 になる）
- Modify（試験の道具。棚卸しの全部）: `e2e/admin-session-test-utils.ts`（下の意味。TSDoc に読み替えを書く）、`e2e/news-test-utils.ts`・`e2e/stockist-admin-test-utils.ts`・`e2e/order-email-test-utils.ts`（パスワード＋TOTP の店員の作り方を `provisionStaff`／`createAdminSessionActor` に）、`tests/unit/api/admin/accounting-route-harness.ts`・`tests/integration/db/helpers/app-session.ts`・`tests/integration/db/helpers/admin-table-grants.ts`（既定の claims を `staffEntryClaims` の形に。DB 結合の側は、`passkey` の `amr` を持つ claims と、**先に `auth.webauthn_credentials` に行を直に入れ（列は `\d` で実測。引き金で outbox に行が積まれるのは構わない）、`passkey_approve` で `approved_passkeys` に認めの行を用意する**。数え方が両方の表の突き合わせのため）、`tests/integration/db/auth_has_permission_aal2.integration.test.ts`（`auth_has_permission_passkey.integration.test.ts` に名前を変えて書き直す）、`tests/unit/e2e/admin-session-test-utils.test.ts`、棚卸しの `aal2` を含む残りの単体・結合（97ファイル。`grep -rlE "aal2" tests` が、意味の確かめ以外で0になるまで）
- Create: `e2e/FR-LOGIN-039-staff-passkey-entry-conditions.spec.ts`、`e2e/FR-LOGIN-040-staff-hook-gotrue-rejections.spec.ts`
- Modify（skip と台帳）: 棚卸しの「段4で消す機能」の試験を `test.skip(true, '段4で消す機能: <理由>')` にし、台帳（状態欄と「skip の一覧」の節）と `test-gaps.md` に、ファイル・`test` 名・理由・戻す段（段4）を書く。最初の店長のコマンド（FR-ADMIN-MISC-008）はコードを変えず試験だけ skip
- 文書（同じコミット）: `SR-AUTH-014` の受け入れ条件の確定、`DD-AUTH-047` の更新、`SEC-AUTH-040`（手元で店員がアプリの画面から入れない期間・管理の入口の抜け道が無いこと）、`docs/06_Operations/db-migrations.md`、`docs/06_Operations/first-admin-bootstrap.md` の「前提」を「**本番用。手元は段1a の新しい手順（dev の店員のスクリプト。[Task 10]）**」に直しリンクを張る（1a の後は手元で `npm run db:reset` の後に動かない）

**Interfaces:**
- Produces: `createAdminSessionActor(db, role: 'admin'|'supporter'|'user', aal: 'aal1'|'aal2', options?: { bindApp?: boolean }): Promise<AdminSessionActor>` 等、既存の公開の形を保つ。意味: 店員で `aal2` → 認めたパスキー2本の店員がパスキーで入った JWT。店員で `aal1` → 認めたパスキー1本の店員の JWT（入口の条件を満たさない店員）。`role: 'user'` は今のパスワードの道。JWT の確かめは `claims.aal` でなく `amr` の `passkey` と DB の認めた本数で行う。`elevateAdminSessionToAal2` は、同じ session の token で2本目を登録して認め、refresh して `session_id` を変えずに2本にそろえる。`raiseSessionToAal2` は使わなくなったら消す
- Consumes: Task 5・7・8。`public.sessions` の結び付けは今の `bindAppSession` のまま

**FR-LOGIN-040 の中身（設計 5-2 の「段1の試験に入れること」。I6・I7）:** GoTrue に直に当てる。(a) 店員がパスキーで入ると 200 で JWT の `staff_passkeys_ok` が真（2本）／偽（1本）、(b) 店員がメールのコードで 403・`message` が印で始まり `isStaffPasskeyRequiredError` が真、パスワードで 403、(c) お客さんのパスキー・メールのコード・パスワードは入れる（旗が偽）、(d) **お客さんの本物の更新（`token_refresh`）が通る**、(e) **拒否された更新**: 24時間は待てないので設定を縮めず、窓で作る。案 B の順: ①役割の無い間にメールのコードで入る（`session_id` が分かる）→ ②`passkey_window_open(user, session)` で窓を開ける → ③役割を有効にする → ④更新が通る → ⑤`passkey_window_close` で窓を閉じる → ⑥更新が拒否される。同じ更新トークンを送っても同じ拒否が返り、`auth.sessions` の行は残る。(f) 拒否の後、前のアクセストークンで `/auth/v1/user`（200 のまま）と `/rest/v1`（管理の表は、`has_permission` が窓の JWT（`passkey` の `amr` 無し）を断るので0行）を呼んだ結果、(g) `auth.sessions.not_after` の値を記録（試験の出力に出す）、(h) 独自の印が偽になる側（認めた鍵1本）。**FR-LOGIN-039**: 手助けで作った店員（2本）が管理 API で 200、1本の店員が 403 で `reason` が `MFA required`、お客さんが 403、認めた鍵を GoTrue の `auth.passkey.delete` で消した直後に、更新を待たず 403（Review Focus 2）。

- [ ] **Step 1: 影響を数え直し、失敗を確かめる** — 棚卸しの式で数え直し、件数を `.superpowers/sdd/2026-11-16-passkey-stage1a/impact-inventory.md`（コミットしない）に書く。単体は `staff-claims` の共有の元から差し替えて、まず `FR-LOGIN-039`・`040`・`auth_has_permission_passkey` を書いて FAIL を確かめる
- [ ] **Step 2: 共有の元を直す** — `accounting-route-harness.ts`、`app-session.ts`、`admin-table-grants.ts`、`admin-session-test-utils.ts`、3つのパスワード＋TOTP の道具。その後に `grep -rlE "aal2" tests` の残りを、`staffEntryClaims` と `mockApprovedCount` に置き換えて0にする。`create-user`・`mfa/reset` の `aal2` の文言の試験は、`authorizeAdminPermissions` を通っていることだけを確かめる形にする
- [ ] **Step 3: 切り替える** — config のフック、移行 D、`admin-rbac.ts`、`me/route.ts`。skip と台帳。調整役が1行で知らせて `supabase stop`・`start`（フックの取り込みは再起動が要る）の後 `db reset`
- [ ] **Step 4: 単体を通す** — `npm.cmd test`（単体全件）・`npm.cmd run typecheck`・`npm.cmd run lint`。棚卸しの単体・結合が全部緑
- [ ] **Step 5: DB 結合と E2E を通す（調整役）** — `tests/integration/db` と `tests/integration/api` の全件。E2E は本番ビルド・3幅で、影響の棚卸しの全部（直接22ファイル、道具経由の spec、パスワード＋TOTP の spec）と `FR-LOGIN-039`・`040`。さらに E2E を全件流し、Task 2 の比べる元と比べて、新しい赤が無く、skip にした物だけが減っていること。赤は単独の再実行・他の幅・エラーの種類の順で切り分ける
- [ ] **Step 6: 文書と追跡** — 上の文書を直し、`npm.cmd run validate-trace`・`test:trace-coverage`・`validate-docs`・`npm.cmd run trace:report`（`docs/05_Quality/reports/` を作り直す）
- [ ] **Step 7: コミット（1つ）** — 自分が変えた物を名前で足す（`package.json` は触らない）→ `feat(auth): 管理の入口をパスキーの条件に切り替え、フックを手元で有効にする`

### Task 10: 手元の開発で店員として入るスクリプト（専用のブラウザ）

**Files:**
- Create: `scripts/dev/passkey-dev-staff.ts`、`tests/unit/scripts/passkey-dev-staff.test.ts`
- Modify: `package.json`（script `"dev:staff": "tsx scripts/dev/passkey-dev-staff.ts"` の1行だけ。**`scripts` の最後の項目に置き、`"dev"` の行から4行以上離す**（別の作業の `dev` の変更と同じ塊にならないため）。Global Constraints の `apply --cached` の手順に、④の確かめとして「`git diff --cached package.json` に `dev:staff` が含まれる」を足す。塊を手で直した時は `git apply --cached --recount`）、`.gitignore`（`/.tmp-dev-staff/` を足す）
- 文書（同じコミット）: `SR-AUTH-015`、`DD-AUTH-048`、`docs/06_Operations/first-admin-bootstrap.md`（「前提」を「本番用。手元は段1a の新しい手順（`npm run dev:staff`）」にし、手順を足す: 毎日（24時間で切れる）流し直す、`db reset` の後は流し直す、既にいる店員は再利用せず新しいメールを使う）、台帳

**Interfaces:**
- Produces: `export async function main(argv: string[]): Promise<{ profileDir: string }>`。引数 `--email <メール>`（既定は `dev-staff-<乱数>@example.com`）・`--role admin|supporter`（既定 `admin`）・`--open`。`provisionStaff`（Task 7。**新しい利用者だけ**。同じメールが在れば投げる）で2本を認め、`loginWithPasskey` で入り、`src/features/auth/services/session.ts` の `persistNewSession` と**同じ作り**で、CSRF の値を作り、その hash を `public.sessions` の行の `csrf_token_hash` に入れ、同じ値を Cookie `sb-csrf-token`（名前・属性は `src/lib/cookie.ts` が正本）に載せる（管理の書き込み（POST・PATCH）が CSRF の確かめで落ちないように）。`--open` で、専用のプロファイルの Chromium（見える形）を Playwright で開き、Cookie を入れて `http://localhost:3000/admin` を開く。プロファイルは `.tmp-dev-staff/profile/`（git が無視する）。Cookie・トークンをファイルに書かない（`.tmp-dev-staff/` にはブラウザのプロファイルだけ）。標準出力にも出さない。手元の Supabase の住所でなければ、何も書かずに投げる。接続情報は、手元の `supabase status -o json` をプロセスの中で読む（`.env*` は読まない・表示しない）
- Consumes: Task 7・9。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 本番の住所（`https://x.supabase.co`）を環境に入れて `main` を呼ぶと、DB にも GoTrue にも触れずに投げる（モックが0回）。`--role owner` で投げる。出力（標準出力・書いたファイル）に JWT・Cookie の値が含まれない。`.gitignore` に `/.tmp-dev-staff/` がある。作る行の `csrf_token_hash` が、Cookie に載せる値の SHA-256 と一致する
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/scripts/passkey-dev-staff` → FAIL
- [ ] **Step 3: 実装する** — 上のとおり
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS。調整役が実際に流し（`npm.cmd run build && npm.cmd run start` の手元のアプリ、または手元の dev）、`--open` のブラウザで `/admin` に入れること、管理の書き込み（例: 1件の PATCH）が CSRF で落ちないことを確かめて報告する。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): 手元の開発で店員としてパスキーで入る専用のブラウザのスクリプトを足す`

### Task 11: 1a の全体の確かめ

**Files:** なし（確かめと記録だけ。台帳の状態欄と `db-migrations.md` に結果を書く）

- [ ] **Step 1: 手元を作り直す** — 調整役が3000番を止め、1行で知らせて `npx.cmd supabase db reset`。`npm.cmd run lint`・`typecheck`・`npm.cmd test`（単体）が通る
- [ ] **Step 2: DB 結合** — `auth_passkey_*` と、`has_permission` を使う既存の DB 結合の全部が通る。落ちた物は単独で流して切り分ける
- [ ] **Step 3: E2E（本番ビルド・3幅）** — 全件。Task 2 の比べる元と比べ、新しい赤が無いこと。skip は棚卸しの一覧と同じ数
- [ ] **Step 4: 追跡** — `validate-trace`・`test:trace-coverage`・`validate-docs`・`trace:report`
- [ ] **Step 5: 本番の道が止まっていることを確かめる** — `db-migrations.yml` に `push:` が無い（Task 1 の試験が通る）。`git log origin/master..master` に1aの移行が入っていても、push は調整役がオーナーの許可を得た時だけ
- [ ] **Step 6: 記録して報告する** — 台帳と `db-migrations.md` に結果を書く（コミットは作業の区切りで1つ）。**本番に当てない**。オーナーに結果を報告してから、1b の計画に進む

---

## セルフレビュー

**1. 設計書との対応（1aが持つ範囲）**

| 設計書 | タスク |
| --- | --- |
| 4-2 段1: supabase-js・ssr、手元の config | 2・3 |
| 5-2・4-2: フック（印付きの拒否、24時間、窓・案 B、お客さんの `password` は旗で段4） | 4・5・9 |
| 4-2・5-5: 窓の表・認めたパスキーの表（本数を表で数える） | 4・6 |
| 4-2・5-4: 引き金と outbox への積み込み（店員の削除は店長に知らせる） | 6 |
| 4-2・5-2: 管理の入口の3条件を API と RLS の両方に（3つ目は DB でその場で数える。設計書の直しを Task 8 で入れる） | 8・9 |
| 4-2: 設定の表を `security definer` の関数で読む | 4 |
| 4-2: `createAdminSessionActor` の作り直し、手元の開発の店員の手順 | 7・9・10 |
| 5-2「段1の試験に入れること」 | 5・9（`FR-LOGIN-040`）・11 |
| 4-3・本番の安全 | 1・Global Constraints |
| 7: ADR の「置き換え済み」（0409・0418 の `aal2` の部分） | 8 |

1b に回す物: 上の「分け方」の表のとおり（`return-intent-service.ts`・`oauth/callback`・`post-login`・`return-path`・`confirm` の `aal` の判定を含む）。

**2. 型・名前の一貫性:** `staff_passkeys_ok`（ヒント）、`STAFF_PASSKEY_REQUIRED_MARKER`、`passkey_approve`、`passkey_approved_count`（API と DB の判定の元）、`evaluateStaffEntry(claims, approvedCount, nowSeconds)`（Task 8 が作り、Task 9 が使う）、`private.staff_passkey_entry_ok(p_user_id, claims)`、`provisionStaff`・`loginWithPasskey`（Task 7 が作り、Task 9・10 が使う）、`STAFF_MAX_SESSION_SECONDS = 86400` と設定の既定値。

**3. Review Focus:** 5行とも、Task 5・6・8・9 の試験に入れた。

**4. 実行順:** Task 1〜8 は、今のログインと試験を壊さず緑で終わる（フックは有効にしていない。`has_permission` は変えていない）。Task 9 だけが切り替えで、1コミット。
