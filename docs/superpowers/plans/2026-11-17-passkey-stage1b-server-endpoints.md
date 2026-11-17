# パスキー 段1b（サーバーの窓口）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** パスキー置き換えの段1のうち、1a が作らなかった「サーバーの窓口」を作る。ログインの始め (a)・(b) と終わり、登録の始め・終わり、一覧・名前・削除を、UV の門・認めたパスキーの確かめ・登録の窓つきで作る。フックが更新を拒否したらアプリがセッションを終わらせる。店員の `aal` の判定（戻り先・行き先）をパスキーの条件に直す。画面（ログイン・登録・管理の画面）は作らず、試験はソフトの認証器で窓口を直に呼ぶ。

**Architecture:** (1) 窓口が使う DB の関数を移行 F にまとめ、1a の `passkey_approve` の黙って効かない穴を塞ぐ。(2) 窓口が共有する純粋な部品（設定の読み取り・UV の読み取り・GoTrue の呼び出し）を、窓口より先に作る。(3) 窓口を「始め (a) → ブラウザから始める (b) の部品 → `aal` の判定の置き換え → ログインの終わり → 登録 → 一覧・名前・削除 → 更新の拒否の扱い」の順に1つずつ足す。どの窓口も、1つ足した時点で今のログインと試験を壊さず緑で終わる（今の画面は新しい窓口を呼ばない）。(4) 止めていた2本の試験（FR-AUTH-005-AC-05）をパスキーのログインで作り直す。(5) 運用の文書を直す。

**Tech Stack:** Next.js App Router（Route Handler）、`@supabase/supabase-js` 2.119.0（固定）、`zod`、Postgres 17（手元の Supabase）、GoTrue v2.196.0、Jest、Playwright（本番ビルド）、`tsx`。

**Spec:** [docs/superpowers/specs/2026-11-07-passkey-auth-design.md](../specs/2026-11-07-passkey-auth-design.md)（正本。特に 4-2 の段1、5-1、5-2、5-3、5-5、6-1、6-2、8-2、12、12-2）。測った事実は [手元の試しの結果](../specs/2026-11-16-passkey-local-trial-results.md)（「段1への材料」）と [回数の制限の調べ](../specs/2026-11-16-passkey-rate-limit-research.md)。1a の計画は [2026-11-16-passkey-stage1a-foundation.md](2026-11-16-passkey-stage1a-foundation.md)。1a のレビューで直した点は `.superpowers/sdd/2026-11-16-passkey-local-trials/stage1a-plan-review.md`・`stage1a-plan-rereview.md`。実行する人は、この計画と設計書の両方を読む。

## 分け方（1b が持つ範囲）

| 計画 | 中身 |
| --- | --- |
| 1a（済み。ab2aa260 まで） | 本番への道を止める、supabase-js・config、表・フック・引き金・outbox、管理の入口の3つの条件（API と RLS）、全部の試験の道具、手元の開発の店員のスクリプト |
| **1b（この文書）** | ログインの始め (a)・(b)、ログインの終わり、登録の始め・終わり、一覧・名前・削除、UV の門、認めたパスキーの確かめ、登録の窓・入り直しの確かめ、始めの窓口の IP ごとの回数の制限、`PASSKEY_START_DEV_IP`、鍵の形の確認、更新の拒否でセッションを終わらせること、CSP の確認、`aal` の判定の置き換え、止めていた2本の試験の作り直し、`loginAsMember` の確認、1a の持ち越し（`passkey_approve` の古い行）、運用の文書（`Sb-Forwarded-For` の手順・「段1b の招待」の誤記の直し） |
| 段2（お客さん） | ログインの画面、メールのコードの流れ、パスキーを勧める画面、アカウントのパスキーの一覧の画面、知らせを送る処理。**1b の窓口を画面が呼ぶ** |
| 段3（店員） | 招待・やり直し（合言葉のメール、窓を開けて2本登録、2本そろったら窓を閉じてセッションを終わらせる）、無操作1時間、Google の拒否の画面、店長への知らせ、店長の最後の手段。**1b の窓口の「窓」の側を使う** |
| 段4（片付け） | パスワード・TOTP・`/auth/verified` を消す。お客さんの `password` の拒否を有効にする。`MFA required`・`denial.reason = 'mfa'`・`admin_requires_privileged_aal2` の名前を直す |

**招待の流れは段3**（設計 4-2・6-2）。1a の文書（`first-admin-bootstrap.md` 28・102行目、`db-migrations.md` 183行目、台帳の行 1a-4）が「段1b の招待」と書いているのは誤り。Task 11 で直す。

1b の終わりでも、**お客さん・店員が画面からパスキーで入る道は無い**（画面は段2・3）。1b の窓口は、ソフトの認証器で直に呼んで試す。本番に当てる時の順は Task 11 に書く（1b の移行 F は 1a の A〜E と同じく、段3まで本番に当てない）。

## Global Constraints

1a の決まりを引き継ぎ、1b で足す物を書く。全部のタスクの要件に含まれる。

**本番の安全（オーナー決定 2026-11-16。1b にもそのまま効く）**

- **1b は本番の DB に何も当てない**。実行者（サブエージェント）は本番に一切触れない。Supabase の MCP（`apply_migration`・`execute_sql` など）も使わない。`supabase config push` は使わない。`.env*` は読まない・表示しない・探さない
- 本番に当てるのは調整役だけ。段3、またはオーナーの許可を得た時に、1本ずつ MCP の `apply_migration`（名前はファイルの版と同じ）。当てた後は `md5(statements[1])` をファイルの MD5 と突き合わせ、ファイルの名前を当てた版に合わせて変える（1a と同じ）。**`supabase db push`（どの形でも）と GitHub の `workflow_dispatch` は動かさない**。移行 F（Task 1）も「段3まで `db push` しない」一覧に足す
- master への push は許される。push のたびに調整役がオーナーの許可を得る（実行者は push しない）
- 移行の版（ファイル名の時刻）は**作る時の時刻**で付ける。`ls supabase/migrations | tail` で最新（今は `20261117013000_passkey_staff_entry_conditions.sql`）より後にする。この計画の `<時刻>` は仮
- **`package.json` は1bでは触らない**（新しい npm のコマンドを足さない。別の作業の `dev` の変更が残っているため）。触る必要が出たら、1a の計画の `git apply --cached` の手順に従い、先に調整役へ知らせる
- 実装者が足す環境変数は、**名前だけを文書に書き、値を書かない**。`SUPABASE_SECRET_KEY`・`NEXT_PUBLIC_PASSKEY_START_MODE`・`PASSKEY_START_DEV_IP` の3つ

**手元の Supabase の扱い**

- 1a の途中で決めた取り決めを使う: **実装者は1人ずつ**、手元の `db reset` と DB 結合の試験を自分で流してよい（`DATABASE_URL` を手元に向ける。`describeLocalDb` が手元の DB だけを許す）。流す前に3000番のアプリを止める。E2E の全件・push 前の確かめは調整役だけ
- E2E は必ず本番ビルド（`next build && next start`）・390・768・1280 の3幅。dev サーバーでは流さない。`retries` を上げて通さない。落ちたら「単独の再実行 → 他の幅 → `goto` のタイムアウトかアサーションか」の順で切り分ける。全件の赤は 1a の記録と比べる。**比べる元は1つ**: `.superpowers/sdd/2026-11-16-passkey-stage1a-foundation/e2e-task11-full.json`（36 failed。再実行で全部通ると確かめ済みで、全件だけの汚れ。push 前の実行の31件はこの36件の部分集合の同じ系統）
- 手元の `supabase status -o json` を実装者が読む時は、**鍵の値を画面に出さない**（`node -e` の中で読み、必要な値の有無・名前だけを表示する）

**設計の守り（1b で足す物）**

- **ログインの終わりは必ずアプリの窓口を通す**（5-1）。ブラウザは GoTrue の終わり（`/passkeys/authentication/verify`）を直に呼ばない。CSP は変えない（`connect-src` は今も自分の Supabase の origin を許している。Task 4 で試験に固定する）
- **始め (a)**: アプリのサーバーが `sb_secret_` で始まる鍵で GoTrue の `/passkeys/authentication/options` を呼び、お客さんの IP を `Sb-Forwarded-For` に添える。IP は `getClientIp`（ADR-0416）だけから取る。IP が取れなければ GoTrue を呼ばずに断る。古い `service_role` の JWT では呼ばない（添え書きが効かない）。選択肢の `userVerification` を `required` に書き換えて返す
- **始め (b)**: ブラウザが GoTrue を直に呼ぶ部品（画面は段2）。見えない形の Turnstile のトークンを `captchaToken` で渡し、`userVerification` をブラウザの側で `required` に書き換える。**(a) か (b) かは設定 `NEXT_PUBLIC_PASSKEY_START_MODE`（`server`｜`browser`、既定 `server`）で切り替える**。(b) の時、(a) の窓口は 409 で断る
- **応答の `id` と `rawId` は同じ値だけ受ける**（zod で完全一致を求め、違えば 400・GoTrue 0回）。**認めた鍵の確かめは `rawId` を `bytea` に直した値で行う**（GoTrue が署名を確かめる鍵の引き方と、アプリが認めの表を引く鍵を同じにする。SEC-AUTH-044）
- **UV の門**: ログインの終わりは、届いた `authenticatorData` の位置 32 の flags の `0x04` が無ければ、GoTrue を呼ばずに 400 で断る（GoTrue への呼び出し0回）。登録の終わりも同じ印を見る（守りの本体はログインの門。登録の側は「使えない鍵を数に入れない」ための参考）
- **認めたパスキー**（5-5）: 店員がパスキーで入る時、届いた鍵が `private.approved_passkeys` にあるかを確かめ、無ければ拒否して、その GoTrue のセッションを終わらせる。店員がアプリの窓口で登録した鍵だけを、`passkey_approve` で認める。お客さんには認めの表を使わない
- **登録の条件**（5-5・6-2）: 店員は、(i) 自分のセッションに結んだ登録の窓が今も開いていて、**かつ認めた鍵が `min_approved_passkeys`（2）未満**（窓の免除は最初の2本まで。5-5）、または (ii) 5分以内にパスキーで入った（`amr` の `passkey` の時刻）。お客さんは10分以内にパスキーかメールのコードで入った。窓・本数・入り直しの確かめは、**始めと終わりの両方で、呼ばれるたびにやり直す**（6-2）。**店員の登録は、旗 `AUTH_REQUIRE_APP_SESSION` に関わらず、結び付いた生きたセッション（`checkAuthSessionLiveness(session_id, true)`）だけを通す**（`admin-rbac` と同じ。旗を切った間に結び付かないセッションで鍵を認めさせない。SEC-AUTH-045）
- **更新の拒否**: GoTrue が 403 で、文の頭が印 `[staff-passkey-required]`（1a の `isStaffPasskeyRequiredError`）の時だけ、アプリがそのセッションを終わらせる（ADR-0466）。ほかの失敗は今のまま
- 403 の本文 `MFA required`・`denial.reason = 'mfa'`・拒否の理由 `admin_requires_privileged_aal2`・`/api/auth/me` の `mfaVerified` の名前は**1b でも変えない**（意味だけパスキーの条件。名前は段4。1a の決めと同じ）
- すべての新しい窓口は `/api/auth` の下に置く。proxy が no-store（ADR-0415）と、状態を変える要求の Origin の確かめ（POST・PATCH・DELETE）を自動で付ける。ログインした人が使う窓口（登録・名前・削除）は `requireCsrfOrDeny()` も通す。ログインの始め・終わりは、まだログインしていないので CSRF の確かめは無い（今の `otp/verify` と同じ）
- 監査（`logAudit`）には、トークン・鍵・認証器の応答・`challenge_id`・メールを残さない。固定の符号と、行為者の ID だけを残す

**リポジトリの決まり**

- 要求管理（範囲内の領域 AUTH）: 要求・要件・受け入れ条件は `docs/02_Requirements/areas/auth.md` に `SR-AUTH-NNN`・`FR-AUTH-NNN`（`requirements.md` には書かない）。基本設計は `docs/03_BasicDesign/areas/auth.md`、設計判断は `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md`、脅威は `docs/05_Quality/security/threats/auth.md`、処理の詳細は `docs/04_DetailDesign/sequence/auth-*.md` の `DD-AUTH-NNN`。コードには TSDoc の `@impl IMPL-AUTH-NNN`・`@design DD-AUTH-NNN`。書式は `documentation-guide` スキルに従う
- **文書と追跡は、そのタスクのコミットに入れる**。各タスクの「文書」の行の ID を同じコミットで足し、`npm.cmd run validate-trace`・`npm.cmd run test:trace-coverage`・`npm.cmd run validate-docs` が通ることを、コミットの前に確かめる。`scripts/trace/baseline.json` から増やさない。新しいコードの届かない分岐は `test-gaps.md` の節に書く
- 番号の予約（着手時に `grep` で空きを確かめる。2026-11-17 の実測の最大は SR-AUTH-015、FR-AUTH-014、DD-AUTH-049、IMPL-AUTH-248、SEC-AUTH-040、DATA-AUTH-017、ADR-0465、FR-LOGIN-046）: `SR-AUTH-016`〜`020`、`FR-AUTH-015`〜`022`、`DD-AUTH-050`〜`058`、`IMPL-AUTH-249`〜`265`、`SEC-AUTH-041`〜`047`、`DATA-AUTH-018`、ADR は **0466**（更新の拒否）・**0467**（サーバーの窓口と始めの2つの道・UV の門）・**0468**（行き先の判定）、E2E は `e2e/FR-LOGIN-047`〜`054`
- 追跡の範囲（`scripts/trace/scope.json` の AUTH）に、**Task 1 で** `src/lib/auth/passkey-*.ts`・試験の `tests/unit/lib/auth/passkey-*.test.ts` を、Task 2 で `src/features/auth/passkey/**/*.ts`、`src/features/auth/schemas/passkey.ts`、`tests/unit/features/auth/passkey/**/*.test.ts`、`tests/unit/features/auth/schemas/passkey.test.ts`、`tests/unit/middleware/proxy-csp.test.ts`（CSP の1件に ID を付けるため）を、Task 6 で `e2e/passkey-app-api.ts` を足す（足すたびに `validate-trace` と `test:trace-coverage` を流す）。`src/lib/build-env-guard.ts` は ABOUT の単位（IMPL-ABOUT-102）なので、足す見張りの ID は **IMPL-ABOUT-102 の `@remarks` に書き足し**、AUTH の ID は付けない（試験は既存の `tests/unit/lib/build-env-guard.test.ts`）。`src/app/api/auth/**/*.ts` は既に入っている（新しい窓口は自動で範囲に入る）。`ADR-046[3-9]*.md` も既に入っている
- E2E のファイル名は `e2e/FR-LOGIN-NNN-<kebab>.spec.ts`。テスト名の先頭に要求の ID（`FR-AUTH-NNN-AC-NN`）。3幅（390・768・1280）でくり返す書き方は `e2e/FR-LOGIN-044-passkey-soft-authenticator-login.spec.ts` に合わせる。窓口を呼ぶ要求には、試験ごとに別の `x-real-ip` を付ける（E2E のアプリは `CLIENT_IP_HEADER=x-real-ip` で信じる。回数の制限の枠を使い切らないため）と、`origin: http://localhost:3000` を付ける（proxy の Origin の確かめ）
- DB の移行は `docs/06_Operations/db-migrations.md` に、ファイル・大きさ・MD5・戻し方・「本番未適用」を記録し、`md5(statements[1])` の突き合わせの書き方は 1a の移行 A〜E と同じにする。台帳 `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md` の状態欄を作業の進みに合わせて更新する
- 読みにくい漢字（ページを表す古い字）は使わず「ページ」と書く。文は設計書と同じやさしい日本語
- master で直接作業する。タスクごとに1コミット。末尾に `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。`graphify update .` は自分で流さない。**未追跡のファイルを `git add -A` で足さず、自分が作った物だけを名前で足す**（`.superpowers/`・`.claude/`・`.codex/`・`package.json`・stockist の差分は足さない）
- モデル: 書き手は Sonnet、レビューは Opus（effort high）

## Review Focus

設計書が暗に求めるが、試験に書きにくい入力。先頭ほど起きやすい。

1. **始めの窓口に来る、IP が取れない・`x-forwarded-for` だけを偽った・`PASSKEY_START_DEV_IP` が本番に残った・鍵が `sb_secret_` でない・設定が (b) の要求**: どれも GoTrue を**添え書き無しで・古い鍵で**呼ばない。`Sb-Forwarded-For` の値は `getClientIp` の IP だけ（Task 2・3）
2. **`id` と `rawId` が食い違う応答（認めた鍵の `id` ＋直に足した鍵の `rawId`・署名）・UV の印が無い応答・短すぎる `authenticatorData`・壊れた base64url・認めていない鍵で入った店員**: GoTrue を呼ぶ前に（UV）、または Cookie と `public.sessions` の行を作る前に（認めていない鍵）断り、認めていない鍵の GoTrue のセッションは終わらせる。お客さんは認めの表の影響を受けない（Task 5・6）
3. **登録の窓が、始めと終わりの間に閉じた／期限が来た／別のセッション・別の人の窓／窓の中で認めた鍵が既に2本／旗 `AUTH_REQUIRE_APP_SESSION` を切った間の結び付かないセッション／5分より古いパスキーのログイン／10分より古いお客さんのログイン**: 終わりで再確認して断り、GoTrue の検証を呼ばない。認めの書き込みが落ちた時は、GoTrue に作られた鍵を消して数に入れない（Task 7）
4. **更新の拒否**: 印つきの 403 だけがセッションを終わらせる。印の無い 403・401・5xx・ネットワークの誤りは今のまま（Cookie は消すが、セッションの行は終わらせない）。終わらせる処理が失敗しても Cookie は消して 401（閉じる側）（Task 9）
5. **行き先の判定**: `needsMfa` と `/admin` への行き先は、`amr`・24時間・認めた2本の判定を満たす店員だけ。1本の店員・24時間を超えた店員・`amr` が欠けた店員は `/admin`・`/admin` 向きの戻り先に着かない。お客さんは `needsMfa` にならない（Task 5）

---

## ファイルの全体図

| 区分 | ファイル | タスク |
| --- | --- | --- |
| 作る | `supabase/migrations/<時刻>_passkey_server_endpoint_fns.sql`（移行 F） | 1 |
| 作る | `src/lib/auth/passkey-approval-rpc.ts`（Task 1 の DB の関数を呼ぶ薄い部品） | 1 |
| 作る | `src/lib/auth/passkey-start-mode.ts`（依存なし。ブラウザも読む）、`passkey-start-config.ts`（`server-only`）、`passkey-uv.ts`、`passkey-gotrue.ts`、`passkey-recent-auth.ts` | 2・7 |
| 作る | `src/features/auth/schemas/passkey.ts`（zod の形） | 2 |
| 作る | `src/app/api/auth/passkey/login/start/route.ts`、`login/finish/route.ts`、`register/start/route.ts`、`register/finish/route.ts`、`route.ts`（一覧）、`[id]/route.ts`（名前・削除） | 3・6・7・8 |
| 作る | `src/features/auth/passkey/browser-start.ts`（(b) の部品。画面は持たない） | 4 |
| 作る | `e2e/passkey-app-api.ts`（窓口を直に呼ぶ試験の道具） | 6 |
| 変える | `src/lib/build-env-guard.ts`、`scripts/trace/scope.json`、`scripts/e2e/environment.ts`（手元の `sb_secret_` を E2E のアプリへ渡す） | 2・3 |
| 変える | `src/features/auth/return-intent/return-intent-service.ts`・`return-path.ts`、`src/app/api/auth/post-login/route.ts`・`oauth/callback/route.ts`・`confirm/route.ts` | 5 |
| 変える | `src/app/api/auth/refresh/route.ts` | 9 |
| 変える | `e2e/FR-LOGIN-038-login-return-to.spec.ts`（止めていた2本）、`e2e/admin-session-test-utils.ts`（窓のセッションの道具） | 7・10 |
| 変える（文書） | `docs/06_Operations/supabase-auth-config.md`・`first-admin-bootstrap.md`・`db-migrations.md`・`secrets.md`、台帳 | 11 |

---

### Task 1: 窓口が使う DB の関数（移行 F）と、`passkey_approve` の古い行の穴

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_server_endpoint_fns.sql`
- Create: `src/lib/auth/passkey-approval-rpc.ts`（下の Interfaces）
- Test: `tests/unit/lib/auth/passkey-approval-rpc.test.ts`、`tests/integration/db/auth_passkey_server_fns.integration.test.ts`（`describeLocalDb`。1a の `auth_passkey_foundation.integration.test.ts` の書き方に合わせる）、`e2e/FR-LOGIN-047-passkey-server-function-grants.spec.ts`（PostgREST で、`anon`・`authenticated` が4つの関数を呼べず `service_role` が呼べる。1a の `FR-LOGIN-045` と同じ形。3幅）
- 文書（同じコミット）: `SR-AUTH-016`（窓口が使う DB の関数。要件 `FR-AUTH-015`、受け入れ条件は下の試験の項目）、`DATA-AUTH-018`、`DD-AUTH-050`（`docs/04_DetailDesign/sequence/auth-passkey-server-endpoints.md` を**作る**。以降のタスクがここに足す。**`@design DD-AUTH-050` は `passkey-approval-rpc.ts` に付け、単体の試験で結ぶ**。SQL だけでは `validate-trace` の「DD に試験とコードの単位が要る」を満たせないため）、`IMPL-AUTH-249`（`passkey-approval-rpc.ts`）、`SEC-AUTH-041`（古い認めの行が数えに入らない・黙って効かない穴）、`docs/03_BasicDesign/areas/auth.md`、`db-migrations.md`（移行 F の節と「段3まで `db push` しない」一覧への追記）、台帳

**Interfaces:**
- Produces（Task 3・6・7・8 が使う。名前・型を変えない。どれも `SECURITY DEFINER`・`SET search_path = ''`・持ち主 `postgres`・`service_role` だけが `execute`。`public`・`anon`・`authenticated` から外す）:
  - `public.passkey_is_staff(p_user_id uuid) returns boolean`（`STABLE`）— 1a のフックと**同じ**店員の定義（`public.user_roles` の有効で期限内の行、役割の `code` が `admin` か `supporter`）。引けない・`null` は偽（例外を投げない）
  - `public.passkey_credential_is_approved(p_user_id uuid, p_credential_id bytea) returns boolean`（`STABLE`）— `p_credential_id` は、呼び手が**応答の `rawId`（base64url）を `Buffer.from(rawId, 'base64url')` で直した生の鍵の ID**（PostgREST へは `\x…` の16進の文字列で渡る）。SQL では base64 の直しをしない。`null`・長さ0は偽。真になる条件は 1a の `passkey_approved_count` と同じ突き合わせ（`private.approved_passkeys` と `auth.webauthn_credentials` を `id`・`user_id`・`credential_id` でつなぐ）。**認めた鍵だけ**が真
  - **TS の薄い部品 `src/lib/auth/passkey-approval-rpc.ts`**（`@impl IMPL-AUTH-249`・`@design DD-AUTH-050`。Task 6・7・8 は RPC を直に呼ばず、これを使う。呼び方が1か所にそろう）: `isStaff(userId)`・`isCredentialApproved(userId, rawIdBase64Url)`（base64url でない・空は RPC を呼ばず `{ ok: true, value: false }`。直した値を `\x` 16進にして渡す）・`approvedIds(userId)`・`approvedCount(userId)`・`approve(userId, passkeyId, via)`。戻りはすべて `{ ok: true; value } | { ok: false }`（RPC の誤り・例外は `{ ok: false }`。呼び手が 503 などの閉じる側に倒す）。`approve` の失敗は、`23505` の古い行を `reason: 'stale'`、`55000` の窓の上限を `reason: 'window_full'`、それ以外を `'other'` で返す。**部品が持つのは、この計画で「RPC を直に呼ばない」と言う4つの DB の関数（`passkey_is_staff`・`passkey_credential_is_approved`・`passkey_approved_ids`・`passkey_approve`）と、1a の `passkey_approved_count`・`passkey_window_is_open`（`windowIsOpen(userId, sessionId)`）。`revoke_auth_session` は既存の RPC を Task 6 が直に呼んでよい**（1a の `revoke-user-sessions.ts` と同じ形）。**base64url の確かめは `Buffer.from` に任せない**（不正な文字を黙って捨てるため）: `^[A-Za-z0-9_-]+$` の形でなければ RPC を呼ばず偽。zod の `id`・`rawId` も同じ形を求める（Task 2）。サービスの鍵のクライアント（`createServiceRoleClient`）で呼ぶ
  - `public.passkey_approved_ids(p_user_id uuid) returns uuid[]`（`STABLE`）— 数え方は同じ。認めた鍵の `passkey_id` の一覧（一覧の窓口の「認めた」の印と、削除の止めに使う）
  - `public.passkey_approve(p_user_id uuid, p_passkey_id uuid, p_via text) returns void` を `CREATE OR REPLACE`（署名・権限は1aと同じ）。**変えるのは1点**: 同じ `passkey_id` の行が、**別の `credential_id`** で残っていたら、黙って何もしないで終わらず、`RAISE EXCEPTION 'passkey_approve: stale approval for this passkey' USING ERRCODE = '23505'`。同じ `credential_id` なら今までどおり何もしない。**もう1点（窓の同時の競りを塞ぐ）**: `p_via = 'window'` の時だけ、関数の頭で `pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0))`（利用者ごとの取引の錠）を取り、**錠の中で `passkey_approved_count(p_user_id)` を数え直し**、すでに `private.passkey_staff_settings()` の `min_approved_passkeys`（2）以上なら `RAISE EXCEPTION 'passkey_approve: window limit reached' USING ERRCODE = '55000'`（認めの行を足さない）。`reauth`・`script` の道には錠も上限も掛けない。ほかの規則（他人の鍵は例外・別の `passkey_id` で同じ `credential_id` は例外）は変えない
- 前の確かめ（`DO`）: 1a の `passkey_approve`・`private.approved_passkeys`・`auth.webauthn_credentials`・`public.user_roles`・`public.roles` が在る。末尾に、権限・属性（`SECURITY DEFINER`・`search_path`・持ち主）の確かめ（1a の移行 A と同じ形）
- **戻し方**（移行の頭に書く）: 3つの新しい関数の `DROP`、`passkey_approve` は 1a の移行 A の本体に戻す（A の `passkey_approve` の本体の MD5 を移行のコメントに残す）

**作り手の判断（Task 1）:** 「古い行」の対処は、**関数を声を出して失敗させる**形にした（理由: 窓口が新しい `passkey_id` だけを認めるので、古い行が当たるのは「引き金を迂回して鍵の `credential_id` を書き換えた」異常の時だけ。その時は黙って数えに入れない（`passkey_approved_count` が突き合わせで数えない）より、窓口が 500 と監査で気づける方が安全。直し方は SQL で古い行を消す運用の手順（SEC-AUTH-041 に書く））。

- [ ] **Step 1: 失敗する試験を書く** — DB 結合: (a) `passkey_is_staff` は admin・supporter の有効な行で真、期限切れ・`active=false`・`user` 役割・行なし・存在しない利用者で偽、(a2) **`passkey_is_staff` の答えは、フック `passkey_access_token_hook` の店員の判定と、同じ入力（有効・期限切れ・`active=false`・役割違い）で必ず同じ**（店員の定義の3つ目の写しなので食い違いを防ぐ）、(b) `passkey_credential_is_approved`（`bytea`）は認めた鍵で真、**認めていない鍵・他人の `user_id`・別の `credential_id`・`credential_id` が書き換わった認め・`null`・長さ0**で偽（試験の鍵は `auth.webauthn_credentials` に直に入れる。1a の `admin-table-grants.ts` の道具に合わせる）、(c) `passkey_approved_ids` は認めた鍵だけ・鍵を消すと減る、(d) `passkey_approve`: 同じ鍵を2回で1行・他人の鍵で例外（1a のまま）・**同じ `passkey_id` で `credential_id` が違う行を直に入れてから呼ぶと `23505` と文言**・同じ `credential_id` なら例外なし、(d2) **`approve('window')` は認めた鍵が既に2本なら `55000` で、`reauth`・`script` は2本でも通る。2つの接続が同時に（錠を取り合う形で）、認めた鍵が1本の同じ利用者の別々の新しい鍵を `window` で認めると、認めた鍵はちょうど2本（片方が `55000`）**（2つの `pg` の接続と `Promise.all`。1回では競りが出ないことがあるので、20組くり返して毎回2本）、(e) 4つの関数は `anon`・`authenticated` が呼べず `service_role` が呼べる、関数の属性。E2E は (e) を PostgREST で。単体（`passkey-approval-rpc.test.ts`、RPC を差し替える）: 各関数が正しい RPC 名・引数で1回呼ぶ、`isCredentialApproved` は base64url でない・空で RPC 0回・値が偽、base64url が `\x` 16進に直る（既知の値で）、RPC の誤り・例外で `{ ok: false }`、`approve` の `23505` が `reason: 'stale'`・`55000` が `'window_full'`、`isCredentialApproved` は `!` や空白を含む文字列で RPC 0回・偽、`windowIsOpen` が正しい RPC を呼ぶ
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest --config jest.config.cjs tests/integration/db/auth_passkey_server_fns.integration.test.ts` → FAIL
- [ ] **Step 3: 移行を書く** — 1取引。関数は `CREATE OR REPLACE`。末尾に権限と属性の assert。サイズと MD5 を `db-migrations.md` に書く（LF・BOM なし・ASCII の確かめ）
- [ ] **Step 4: 通ることを確かめる** — `db reset` の後に同じ試験が PASS。1a の `auth_passkey_*` の DB 結合が全部 PASS のまま（`passkey_approve` を変えたため）。`npm.cmd run validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): パスキーの窓口が使う DB の関数を足し、認めの古い行を黙って通さない`

### Task 2: 窓口が共有する部品（設定・UV の読み取り・GoTrue の呼び出し・環境の見張り）

**Files:**
- Create: `src/lib/auth/passkey-start-mode.ts`（依存なし。ブラウザの部品も読む）、`src/lib/auth/passkey-start-config.ts`（先頭に `import 'server-only'`。鍵・開発の IP）、`src/lib/auth/passkey-uv.ts`、`src/lib/auth/passkey-gotrue.ts`、`src/features/auth/schemas/passkey.ts`
- Modify: `src/lib/build-env-guard.ts`（`PASSKEY_START_DEV_IP` の見張り）、`scripts/trace/scope.json`（上の「追跡の範囲」）
- Test: `tests/unit/lib/auth/passkey-start-mode.test.ts`、`tests/unit/lib/auth/passkey-start-config.test.ts`、`passkey-uv.test.ts`、`passkey-gotrue.test.ts`、`tests/unit/lib/build-env-guard.test.ts`（既存の試験に足す）、`tests/unit/features/auth/schemas/passkey.test.ts`
- 文書（同じコミット）: `DD-AUTH-051`（共有の部品）、`IMPL-AUTH-250`〜`254`（上の5つのファイル。`@impl`・`@design`。build-env-guard の見張りは IMPL-ABOUT-102 に書き足す）、`SEC-AUTH-042`（始めの窓口の入力・鍵・IP の信頼）、ADR-0467 を**作る**（サーバーの窓口と始めの2つの道・UV の門・GoTrue の呼び方の判断。以降のタスクで足す）。ここでは要求（SR）を足さない（受け入れ条件は Task 3・6 の窓口の E2E に付ける）

**Interfaces:**
- Produces:
  - `passkey-start-mode.ts`（**import が1つも無い**。`node:` も他のファイルも読まない。Task 4 のブラウザの部品はこのファイルだけを読む）:
    - `export type PasskeyStartMode = 'server' | 'browser'`、`export function resolvePasskeyStartMode(env?: Record<string, string | undefined>): PasskeyStartMode` — `NEXT_PUBLIC_PASSKEY_START_MODE` を前後の空白・大小を無視して読み、`browser` の時だけ `browser`。未設定・空・知らない値は `server`（既定は (a)。設計 5-1）
  - `passkey-start-config.ts`（`import 'server-only'`。鍵の関数をクライアントの束に入れない）:
    - `export function isSbSecretKey(value: string | undefined): value is string` — 前後の空白を除いた値が `sb_secret_` で始まり、`sb_secret_` だけではない
    - `export function resolveStartSecretKey(env?): { ok: true; key: string } | { ok: false; reason: 'missing' | 'bad_shape' }` — `SUPABASE_SECRET_KEY` を先に、無ければ `SUPABASE_SERVICE_ROLE_KEY` を見て、`isSbSecretKey` を満たす物だけを返す。**どちらも満たさなければ `bad_shape`（片方も無ければ `missing`）**。値は戻り値にしか出さず、ログ・例外の文に載せない
    - `export function resolvePasskeyStartDevIp(env?): string | null` — `PASSKEY_START_DEV_IP` が `isIP` の形で、かつ**手元の Supabase の住所**（`NEXT_PUBLIC_SUPABASE_URL` の host が `localhost`・`127.0.0.1`・`[::1]`）で、かつ **`VERCEL` が `1` でなく、かつ `VERCEL_ENV` が空**の時だけ返す。それ以外は `null`。IPv6（`::1` など）は `isIP` が通る形なら**値を返す**（試験の期待値は1つ）
  - `passkey-uv.ts`:
    - `export function readAuthenticatorDataFlags(authenticatorDataB64Url: unknown): { userPresent: boolean; userVerified: boolean } | null` — base64url を戻し、**37バイト未満・文字列でない・base64url でない**は `null`。位置 32 の flags の `0x01`（UP）・`0x04`（UV）を返す
    - `export function readAttestationUserVerified(attestationObjectB64Url: unknown): boolean | null` — `attestationObject` は CBOR の map（`fmt`・`attStmt`・`authData`）。**小さな CBOR の読み取りを自前で書く**（外のライブラリを足さない。1a の `passkey-soft-authenticator.ts` の CBOR の書き出しの逆。map・配列・byte string・text string・整数・真偽・null だけ読め、再帰の深さは8まで、それ以外・長さが足りない・余りがある・`authData` が無いは `null`）。`authData` の位置 32 の `0x04` を返す
  - `passkey-gotrue.ts`（`fetch` で GoTrue の REST を直に呼ぶ薄い層。すべて `{ ok: true; data } | { ok: false; status: number; message?: string }` を返し、**例外を投げず**、10秒で打ち切る。トークン・鍵を `message` に入れない）:
    - `requestAuthenticationOptionsAsServer(input: { clientIp: string; secretKey: string }): Promise<GoTrueResult<{ challenge_id: string; options: PublicKeyCredentialRequestOptionsJSON; expires_at: number }>>` — `POST {SUPABASE_URL}/auth/v1/passkeys/authentication/options`。ヘッダーは `apikey: <secretKey>`・`Sb-Forwarded-For: <clientIp>`・`Content-Type: application/json` だけ（**`Authorization` は付けない**。`sb_secret_` は JWT でなく、`apikey` だけで受けられる。手元の試し T7 の形）。本文は `{}`（利用者の入力を渡さない）
    - `registrationOptions(accessToken)`・`registrationVerify(accessToken, { challengeId, credential })`・`listPasskeys(accessToken)`・`updatePasskey(accessToken, { passkeyId, friendlyName })`・`deletePasskey(accessToken, passkeyId)` — それぞれ GoTrue の `/passkeys/registration/options`・`/registration/verify`・`GET /passkeys`・`PATCH /passkeys/{id}`・`DELETE /passkeys/{id}`。ヘッダーは `apikey: <anon キー>`・`Authorization: Bearer <accessToken>`。**どの呼び出しにも supabase-js と同じ `X-Supabase-Api-Version: 2024-01-01` を付ける**（`auth-js/dist/main/lib/fetch.js` の付け方。誤りの本文の形（`msg`・`message`・`error_code`）が supabase-js の呼び方とそろう。始めの (a) の呼び出しにも付ける。誤りの文は `msg`・`message` の順に読む）。路・本文の形は **`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js` の `passkey` の実装（2.119.0）から写す**（本文は `{ challenge_id, credential }`・`{ friendly_name }`）。戻りの型は `@supabase/auth-js` の `Passkey…Response` の型から取る
  - `schemas/passkey.ts`（`zod`）: `PasskeyCredentialSchema`（`id`・`rawId`・`type: 'public-key'`・`response` の中身は登録とログインで別。文字列は長さの上限つき。**`id` と `rawId` は、どちらも `^[A-Za-z0-9_-]+$` の形で、完全に同じでなければならない**（`superRefine`）。違えば `invalid_request`。SEC-AUTH-044）、`PasskeyLoginFinishSchema`（`challenge_id` は uuid、`credential`、`next` は任意の文字列）、`PasskeyRegisterFinishSchema`、`PasskeyRenameSchema`（`friendly_name` は前後の空白を除いて1〜64字、制御文字なし）
- `build-env-guard.ts`: `assertBuildEnv` に1項目足す。`PASSKEY_START_DEV_IP` が空でない値で、**手元の Supabase の住所でない**（`NEXT_PUBLIC_SUPABASE_URL` が手元でない・未設定）か `VERCEL`・`VERCEL_ENV` が設定されているなら**投げる**（失敗の文は変数名だけ。値は載せない）。`next.config.ts` が `next build` と `next start` の両方で `assertBuildEnv` を呼ぶので、本番では起動が止まる（設計 4-2）

**作り手の判断（Task 2）:** (1) `sb_secret_` の鍵は **新しい変数 `SUPABASE_SECRET_KEY` を先に、無ければ今の `SUPABASE_SERVICE_ROLE_KEY` が `sb_secret_` の形ならそれ**を使う（理由: 今の鍵が JWT の形か `sb_secret_` かが本番で分からず（読んでいない）、どちらでも動くようにすれば、本番の鍵の形の確認（8-2）を待たずに作れる。別の窓口の鍵は今のまま）。(2) 設定の名前を `NEXT_PUBLIC_` つきの1つにした（理由: ブラウザの部品（Task 4）とサーバーの窓口が同じ値を読むので、2つの変数の食い違いが起きない。値はビルドで埋め込まれるので、切り替えは再デプロイが要る。Vercel の環境変数の変更は再デプロイが要るので、運用は変わらない）。(3) 登録・一覧・名前・削除は supabase-js でなく `fetch` で GoTrue を呼ぶ（理由: supabase-js の passkey の関数は、更新トークンつきの session をメモリに持たないと動かない。窓口は、要求の Cookie のアクセストークンだけを持つ）。(4) 登録の終わりで UV の印を読むために、自前の小さな CBOR の読み取りを足す（理由: 設計 5-3 は登録の確かめは「参考」とするが、PIN の無い鍵を店員が2本登録しても、ログインの門で全部断られ「数だけ2本で入れない」状態になる。登録の時に断る方が親切。これは安全の門ではなく使い勝手の守り）。

- [ ] **Step 1: 失敗する試験を書く** — `passkey-start-mode.ts` に import が無いこと（ファイルの文字列を読んで `import` が0）、`PasskeyCredentialSchema`・`PasskeyLoginFinishSchema` が `id !== rawId` を断る、`resolvePasskeyStartMode`（`server`・`browser`・`BROWSER`（末尾に空白）・空・`foo`・未設定）、`isSbSecretKey`（`sb_secret_x`・` sb_secret_x `・`sb_secret_`・JWT の形・`sb_publishable_…`・`undefined`）、`resolveStartSecretKey`（新しい変数だけ・古い変数が `sb_secret_`・古い変数が JWT の形は `bad_shape`・両方無しは `missing`・新しい変数が不正で古い変数が正しい場合は**古い方に倒さず `bad_shape`**）、`resolvePasskeyStartDevIp`（手元の URL＋IP の形だけ値、本番の URL・`VERCEL=1`・`VERCEL_ENV` 設定・IP でない文字列は `null`、`::1` は値）。`passkey-gotrue` の全呼び出しに `X-Supabase-Api-Version` がある。**`server-only` は Jest で解けない**ので、`passkey-start-config.ts` を直に・間接に読む単体の試験（Task 2・3 の route、Task 6 の route など）の先頭に `jest.mock('server-only', () => ({}), { virtual: true })` を置く（`tests/unit/api/admin/accounting-journal-route.test.ts` と同じ。`package.json` に足さない）。`readAuthenticatorDataFlags`（1a の `createSoftAuthenticator` で作った UV あり・なしの `authenticatorData`、36バイト・37バイト・空・`null`・壊れた base64url）、`readAttestationUserVerified`（ソフトの認証器の `register()` の `attestationObject` を `userVerified` あり・なしで読む、途中で切れた CBOR・深さ9の入れ子・`authData` 無し・余りのバイトは `null`）。`passkey-gotrue` はグローバルの `fetch` を差し替え、**送ったヘッダーの一覧**を検証する（`requestAuthenticationOptionsAsServer` は `Authorization` が無く `Sb-Forwarded-For` がある・本文が `{}`）。タイムアウト・ネットワークの誤り・JSON でない応答は `{ ok: false }` で、`message` にトークン・鍵が入らない。`assertBuildEnv` は `PASSKEY_START_DEV_IP` が（本番の URL・`VERCEL_ENV=production`・`VERCEL=1` のどれかで）あれば投げ、手元の URL で値だけあれば通り、無ければ通る
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/lib/auth/passkey- tests/unit/lib/build-env-guard.test.ts tests/unit/features/auth/schemas/passkey.test.ts` → FAIL
- [ ] **Step 3: 実装する** — 上のとおり。`scope.json` を直し、`npm.cmd run validate-trace` が通ることを確かめる
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS。`npm.cmd run typecheck`・`lint`・`npm.cmd test`（単体全件）が変更前と同じ結果。`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): パスキーの窓口が共有する設定・UV の読み取り・GoTrue の呼び出しを足す`

### Task 3: ログインの始め (a)（サーバーから `sb_secret_` ＋ `Sb-Forwarded-For`）

**Files:**
- Create: `src/app/api/auth/passkey/login/start/route.ts`
- Modify: `scripts/e2e/environment.ts`（手元の `sb_secret_` を E2E のアプリに `SUPABASE_SECRET_KEY` として渡す。下の「手元の鍵」）
- Test: `tests/unit/api/auth/passkey-login-start-route.test.ts`、`e2e/FR-LOGIN-048-passkey-login-start.spec.ts`
- 文書（同じコミット）: `SR-AUTH-017`（ログインの始めと終わり。Task 4・6 も同じ要求に要件を足す）、`FR-AUTH-016`（始めの窓口。受け入れ条件 `FR-AUTH-016-AC-01`〜）、`DD-AUTH-052`、`IMPL-AUTH-255`、`SEC-AUTH-042` の足し、ADR-0467 の足し（(a) の決まり、IP が取れない時の扱い、回数の値）、`docs/03_BasicDesign/areas/auth.md`（窓口の一覧）、台帳

**Interfaces:**
- Produces: `POST /api/auth/passkey/login/start`（本文なし）。
  - 順番: ① 設定が `browser` なら **409** `{ error: 'passkey_start_mode_browser' }`（GoTrue も回数の表も呼ばない）② `getClientIp(request)`（無ければ `resolvePasskeyStartDevIp()`）が `null` なら **503** `{ error: 'client_ip_unavailable' }`（GoTrue を呼ばない。回数の枠にも入れない。監査に `client_ip_unavailable`）③ `enforceRateLimit({ endpoint: 'auth:passkey:login:start', limit: 20, windowSeconds: 300 })`（IP ごと。**共有の `enforceRateLimit` は IP を引数で受けず、中で `getClientIp` を呼ぶ**。共有の関数は変えない。だから本番と E2E では枠の IP と `Sb-Forwarded-For` の IP は同じ値。**開発の IP（`PASSKEY_START_DEV_IP`）の時だけ、枠の IP が `null`（手元の共有の枠）になる**。手元だけなので共有の枠でよい）④ `resolveStartSecretKey()` が失敗なら **503** `{ error: 'passkey_start_unavailable' }`（監査に `secret_key_missing`／`secret_key_bad_shape`。**アプリ全体は止めない**。ほかの窓口は今の鍵のまま動く）⑤ `requestAuthenticationOptionsAsServer({ clientIp, secretKey })` ⑥ 成功なら `options.userVerification = 'required'` に書き換えて **200** `{ challenge_id, options, expires_at }`（GoTrue の応答と同じ項目名。(b) の部品と同じ形にする）。GoTrue が **429** なら、今のログインの回数の制限と同じ本文 `{ error: 'Too many requests' }`・429・`Retry-After`（GoTrue の値、無ければ 300）。それ以外の失敗は **502** `{ error: 'passkey_start_failed' }`（GoTrue の本文を返さない）
  - ②の IP は、**`x-forwarded-for` を読まない**（`getClientIp` が見出しを信じる環境でだけ値を返す）。④の `Sb-Forwarded-For` の IP は、②で取れた値だけ
- **手元の鍵（`scripts/e2e/environment.ts`）**: 手元の `supabase status -o json` に `sb_secret_` の形の鍵が出る（試し T7 で使った）。**鍵の名前を、値を出さずに**確かめる（`node -e` で JSON の鍵の名前の一覧だけを表示する）。`LocalSupabaseStatus` に任意の `secretKey` を足し（`pick` で無い時は空）、`buildE2EOverrides` は**常に** `SUPABASE_SECRET_KEY` を上書きする（手元の鍵、無ければ空の値。`.env.local` に本番の `sb_secret_` が入っていても E2E のアプリに届かないようにする）。同じく `PASSKEY_START_DEV_IP` を空の値で上書きする（`.env.local` に残っていても、E2E の「IP 見出し無しは503」が崩れないため）。`computeServerFingerprint` の `v` を 3 から 4 に上げる（古い E2E のアプリを使い回さない）。**手元に `sb_secret_` が無ければ止まって調整役に知らせる**（その場合は `SUPABASE_SERVICE_ROLE_KEY` の JWT で通す抜け道は作らない）
- **手元の GoTrue は `Sb-Forwarded-For` を数えない**（試し T7。手元の GoTrue の設定に添え書きを有効にする項目が無い）。だから手元で確かめるのは「**ヘッダーを付けて送り、手元の GoTrue がそれを断らず 200 を返す**こと」と「単体の試験が、送ったヘッダーの値を確かめること」まで。**IP ごとに数えるか・本番で添え書きが効くかは、本番の確認（設計 8-2 の1。独自のドメインが決まってから）に回す**。手元の GoTrue が**200 以外を返す**場合（添え書きを断る400、captcha の誤り `captcha_failed` など。T7 の `sb_secret_` の captcha の免除は隔離のスタックでの実測で、いつもの手元のスタックでは測っていない）は、止まって調整役に知らせる（その時の道は、手元だけ添え書きを付けない旗を足すか、設計に戻すかを、オーナーと決める）

**作り手の判断（Task 3）:** (1) アプリ側の回数は **IP ごとに5分20回**（理由: GoTrue の制限が IP ごとに5分30回なので、その手前で止める。正当な利用者のやり直し（認証器のキャンセルなど）は数回で、20回に達しにくい。窓は `enforceRateLimit` の固定の窓）。(2) IP が取れない時は **回数の枠にも入れず、503 で断る**（理由: `enforceRateLimit` は IP が `null` だと「送り元が分からない全員が1つの枠」になり、1人で全員の始めを止められてしまうため）。(3) 設定が `browser` の時の (a) の窓口は **409**（理由: 2つの道が同時に動くと、本番で添え書きが効かず (b) に切り替えた後も古い画面が (a) を呼び続け、`sb_secret_` の確かめを通らない状態が見えにくくなる）。

- [ ] **Step 1: 失敗する試験を書く** — 単体（`fetch`・`enforceRateLimit`・`getClientIp` を差し替える）: 順番どおりの断り（(a) 設定 `browser` で409・GoTrue が0回／IP 無しで503・GoTrue が0回・回数の枠が0回／鍵の形が不正で503・GoTrue が0回／回数の上限で429）、成功で GoTrue への要求が `apikey` に鍵・`Sb-Forwarded-For` に取れた IP・`Authorization` 無しで1回、応答の `options.userVerification` が `required`（GoTrue が `preferred` を返しても）、GoTrue の 429 が今のログインと同じ本文、GoTrue の 500・ネットワークの誤りが 502 で本文に GoTrue の文が無い。**`x-forwarded-for` に偽の IP を付けても、`Sb-Forwarded-For` にも回数の枠にも使われない**。開発の IP（`PASSKEY_START_DEV_IP`）は、見出しの IP が無い時だけ使われ、見出しの IP があればそちらが勝つ。E2E（3幅）: 手元のアプリに IP 見出しつきで呼び、200・`options.userVerification` が `required`・`challenge_id` がある（手元の GoTrue が添え書きを断らない）、IP 見出し無しは503（Playwright の設定が文脈ごとに `x-real-ip` を自動で付けるので、その要求だけ **`x-real-ip: ''` で上書き**する。`getClientIp` は空を `null` にする）、同じ IP で21回目が429（IP は試験ごとに別）
- [ ] **Step 2: 失敗を確かめる** — 単体 `npx.cmd jest tests/unit/api/auth/passkey-login-start-route.test.ts` → FAIL
- [ ] **Step 3: 実装する** — 上のとおり。監査の符号（`auth.passkey.login.start`）は固定の文字列だけ
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS。調整役が E2E（`FR-LOGIN-048`）を流す。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): パスキーのログインの始めの窓口を足す（サーバーから sb_secret_ と Sb-Forwarded-For）`

### Task 4: ログインの始め (b)（ブラウザから直に）の部品と切り替え・CSP の確認

**Files:**
- Create: `src/features/auth/passkey/browser-start.ts`
- Test: `tests/unit/features/auth/passkey/browser-start.test.ts`、`e2e/FR-LOGIN-049-passkey-start-mode-csp.spec.ts`
- 文書（同じコミット）: `SR-AUTH-017` に要件 `FR-AUTH-017`（(b) の部品・切り替え・CSP）を足す、`DD-AUTH-053`、`IMPL-AUTH-256`、ADR-0467 の足し（(b) の作り・切り替えの手順・captcha・1つの設定を両方が読む理由）、`docs/03_BasicDesign/areas/auth.md`、台帳

**Interfaces:**
- Produces（画面は持たない。段2のログインの画面が呼ぶ）:
  - `export type PasskeyAuthenticationStart = { challenge_id: string; options: PublicKeyCredentialRequestOptionsJSON; expires_at: number }`
  - `export function createPasskeyAuthenticationStarter(deps: { mode: PasskeyStartMode; fetchApp?: typeof fetch; supabase?: { auth: { passkey: { startAuthentication(params?: { options?: { captchaToken?: string } }): Promise<{ data: PasskeyAuthenticationStart | null; error: { status?: number; message?: string } | null }> } } } }): (input?: { captchaToken?: string }) => Promise<{ ok: true; start: PasskeyAuthenticationStart } | { ok: false; reason: 'rate_limited' | 'unavailable' | 'captcha_required' | 'failed'; retryAfterSeconds?: number }>`
    - `mode === 'server'`: `POST /api/auth/passkey/login/start`（`credentials: 'same-origin'`）。応答の `options.userVerification` は**もう `required`**（サーバーが書き換え済み）。429・503・409・502 を `reason` に直す
    - `mode === 'browser'`: `supabase.auth.passkey.startAuthentication({ options: { captchaToken } })`（`src/lib/supabase/client.ts` の既存のブラウザの client を呼び手が渡す）。`captchaToken` が無ければ GoTrue を呼ばず `captcha_required`。**応答の `options.userVerification` を `required` に書き換えて**返す（設計 5-3）。GoTrue の 429 は `rate_limited`
  - `export function resolveBrowserStartMode(): PasskeyStartMode`（`process.env.NEXT_PUBLIC_PASSKEY_START_MODE` を `passkey-start-mode.ts` の `resolvePasskeyStartMode` で読む。ビルドで埋め込まれる）
  - **`browser-start.ts` が import してよいのは `passkey-start-mode.ts`（と型だけ）**。`passkey-start-config.ts`（`server-only`・`node:net`）・`passkey-gotrue.ts` を読まない（段2で画面が読んだ時にクライアントの束に `node:` や秘密の鍵の関数が入らないため。Task 2 の分け方の理由）
  - Cookie・トークン・`challenge_id` をログに出さない。終わり（ブラウザの WebAuthn と終わりの窓口への送信）は段2の画面が持つ
- **CSP は変えない**: `src/proxy.ts` の `connect-src` は今も `'self'` と**自分の Supabase の origin 1つ**と `https://challenges.cloudflare.com`（Turnstile）を許している。(b) が要る許可は全部入っている。ワイルドカード（`*.supabase.co`）は入れない。`Permissions-Policy` も変えない（`publickey-credentials-*` を止めていない）。ここでは**変えない代わりに、固定の試験を足す**
- **本番の確認（8-2）で効くこと**（文書に書く。Task 11）: (b) に切り替える時は、本番の GoTrue で captcha を有効にする（今は captcha の段階 B の待ち）。(a) の道で `sb_secret_` が captcha を免除されなかった時は、(a) の始めにも Turnstile のトークンが要る（設計 5-1。その時は別の計画）

**作り手の判断（Task 4）:** (1) (b) の部品は、画面を持たない関数として 1b で作り、**ブラウザの WebAuthn（`navigator.credentials.get`）の呼び出しは段2に回す**（理由: 設計 12-2 の5が求めるのは「(b) を先に作って設定で切り替えられること」。画面の部品を1b で作ると、見た目・Turnstile のウィジェット・エラーの文言を決める必要があり、段2の画面と二重になる）。(2) 試験では「ブラウザから始め、サーバーで終わる組み合わせ」を Task 6 の E2E で通す（始めの呼び手と終わりの呼び手が別でも、`challenge_id` が呼び手に結ばれず終わりが通ることを、設計 5-1 が求める）。

- [ ] **Step 1: 失敗する試験を書く** — 単体: `server` で `fetchApp` が1回呼ばれ、応答を返す（429→`rate_limited`・`retryAfterSeconds`、503・409・502→`unavailable`、ネットワークの誤り→`failed`）。`browser` で `captchaToken` 無しは GoTrue が0回・`captcha_required`、有りで `startAuthentication` が `captchaToken` つきで1回、**応答の `userVerification` が `preferred` でも戻りは `required`**、GoTrue の誤り（429・captcha の誤り・その他）の直し方。`resolveBrowserStartMode` は `NEXT_PUBLIC_PASSKEY_START_MODE` の値に従う。**`browser-start.ts` の import が `passkey-start-mode` だけで、`node:`・`passkey-start-config`・`passkey-gotrue` を含まない**（ファイルの文字列を読んで確かめる）。E2E（3幅）: (1) 手元のアプリの `/login` への要求の応答ヘッダーの `Content-Security-Policy` の `connect-src` に、手元の Supabase の origin と `https://challenges.cloudflare.com` が入り、`*.supabase.co` が入っていないこと、(2) **`page.goto('/login')` で開いたページの中から、手元の GoTrue の `/auth/v1/passkeys/authentication/options` へ `fetch`（匿名の鍵・ダミーの captcha のトークン）し、`securitypolicyviolation` が出ないこと**（`page.evaluate` で `document.addEventListener('securitypolicyviolation', …)` を張ってから呼ぶ。応答が200でなくても、CSP に止められた時の `TypeError` と見分けられればよい）。`tests/unit/middleware/proxy-csp.test.ts` に、同じ確認を1件足す
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/features/auth/passkey/browser-start.test.ts` → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS（`proxy-csp` も）。調整役が E2E（`FR-LOGIN-049`）。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): パスキーのログインの始め (b) の部品と切り替えを足し、CSP を試験で固定する`

### Task 5: 店員の `aal` の判定を、パスキーの条件に置き換える（行き先・戻り先）

**Files:**
- Modify: `src/features/auth/return-intent/return-intent-service.ts`（148・154・196・201行目あたり）、`src/features/auth/return-intent/return-path.ts`（26〜28・149行目あたり）、`src/app/api/auth/post-login/route.ts`（39行目）、`src/app/api/auth/oauth/callback/route.ts`（182行目と冒頭のコメント）、`src/app/api/auth/confirm/route.ts`（168行目）。**行番号は着手時に `grep -rn "aal" src/app src/features/auth` で数え直す**
- Test: `tests/unit/features/auth/return-intent/return-intent-service.test.ts`、`return-path.test.ts`、`tests/unit/api/auth/post-login-route.test.ts`、`oauth-callback-route.test.ts`、`confirm-route.test.ts`、`tests/integration/api/auth/return-intent-flow.test.ts`（`aal` を渡している箇所を新しい形に）、**`e2e/FR-LOGIN-054-passkey-post-login-destination.spec.ts`**（`FR-AUTH-018-AC-01`〜`03`。Task 6 の終わりの窓口は要らない。下の Step 1）
- 文書（同じコミット）: `SR-AUTH-018`（店員の行き先・戻り先をパスキーの条件で決める。要件は `FR-AUTH-018`、受け入れ条件 `FR-AUTH-018-AC-01`〜`03` の E2E は**このタスクで書く**。Task 10 の `FR-AUTH-005-AC-05` の作り直しは別に残る）、`DD-AUTH-054`、`IMPL-AUTH-257`（`return-intent-service.ts` の変えた関数の `@remarks` を直す）、**ADR-0468**（行き先の判定の置き換え）、`SEC-AUTH-043`（行き先の判定が `/admin` を開けない）、`docs/03_BasicDesign/areas/auth.md`、台帳

**Interfaces:**
- 変える（呼び手の形を新しくする）:
  - `ReturnViewer = { role: 'admin' | 'supporter' | 'user'; staffEntryOk: boolean }`（`aal: string | null` をやめる）。`staffEntryOk` が真でなければ、`/admin` を戻り先に許さない（拒否の理由は今の名前 `admin_requires_privileged_aal2` のまま。段4で直す）
  - `resolveReturnDestination(input: { cookieHeader; purpose; viewer: { id: string; role; staffEntryOk: boolean }; origin? })`、`resolveStoredDestination(input: { stored; viewer: { role; staffEntryOk: boolean }; origin? })`。店員（`admin`・`supporter`）で `staffEntryOk` が偽なら、今の `aal !== 'aal2'` と同じく `{ path: '/auth/verified', needsMfa: true, action: { kind: 'keep' } }`
  - `post-login`: `staffEntryOk = evaluateStaffEntry(claims, approvedCountHint(claims), Date.now() / 1000).ok`（`/api/auth/me` の `mfaVerified` と同じ「ヒント」の判定。行き先を決めるだけで、権限の判定ではない。権限は `admin-rbac`・RLS が DB で数える）
  - `oauth/callback`・`confirm`: `staffEntryOk: false` を渡す（Google・メールのリンクで店員は入れない（フックが拒否する）ので、店員がここへ来ることは無く、来ても必ず「2段目」の側に倒す。`aal: 'aal1'` を書いていた所の置き換え）
- **変えない**: `needsMfa` の名前・`/auth/verified` への行き先（段4で消す。**段3が「もう1本登録してください」の画面を作るまで、認めた鍵1本の店員が着く先は今のページ**。本番には段3まで出さない）、`/api/auth/me` の `mfaVerified`、403 の `MFA required`
- `oauth/callback` の拒否の扱い（小さな足し）: GoTrue の交換が `isStaffPasskeyRequiredError` の誤りで失敗した時、監査の `detail` を `token_exchange_failed` でなく `staff_passkey_required` にする（応答は今の 502 のまま。店員への文言は段3）

**作り手の判断（Task 5）:** (1) 行き先の判定に使うのは JWT の**ヒント**（`approvedCountHint`）で、DB を数えない（理由: `me` と同じ。ここは「どの画面へ送るか」の決めで、権限ではない。管理の API・RLS は DB で数えて止める）。(2) `/auth/verified` への行き先・`needsMfa`・拒否の理由の名前は1bで変えない（1a の「`MFA required` を変えない」と同じ。名前を直す段4でまとめて直す）。(3) `oauth/callback` の店員は画面の案内を足さない（段3。1b は監査の符号だけ）。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 店員（admin・supporter）× `staffEntryOk` 真／偽 の行き先（真は `/admin` か戻り先、偽は `/auth/verified`・`needsMfa: true`・控えは残す）、お客さんは `staffEntryOk` がどちらでも `needsMfa: false`、`validateReturnPath('/admin', { viewer })` は店員で `staffEntryOk` 真だけ通り、偽・お客さん・`viewer` 無しの入口の動きは今のまま。`post-login` は、`amr` が欠ける・空・文字列の時刻・未来・24時間超・`staff_passkeys_ok` が偽・文字列 `"true"` の店員で `/admin` に着かない（Review Focus 5）、パスキーで入った2本の店員の JWT で `redirectTo` が `/admin`。`oauth/callback` は店員でも必ず `/auth/verified` の側、交換の誤りがフックの印つき 403 の時に監査の `detail` が `staff_passkey_required`・応答は 502。`confirm` は店員で今までと同じ行き先。**E2E（`FR-LOGIN-054`。3幅。直す前に赤を確かめる）**: 1a の `provisionStaff`＋`loginWithPasskey` でパスキーのセッションを作り、`bindAppSession`・`placeAdminCookies`（`e2e/admin-session-test-utils.ts`）でアプリの結び付いた Cookie に載せて `POST /api/auth/post-login` を呼ぶ。**戻り先の控えの作り方（作り手の判断）**: 店員はパスワードの窓口の `next` を使えず、終わりの窓口（Task 6）もまだ無いので、**実在の `GET /api/auth/oauth/start?next=…`**（ログイン前に `next` の控えを Cookie に付ける。`maxRedirects: 0` で `Set-Cookie` の控えだけを取り、その Cookie を `request` の文脈に入れる）を使う。`signInWithOAuth` は URL を作るだけで外へ通信しないが、手元の GoTrue で Google が有効でなく 502 になる場合は、**手元だけの道具で控えの行を DB に直に入れる**（`hashReturnIntentToken` と `assertLocalDbClient` で手元の DB だけを許す。Cookie の値は呼び手が作った乱数）。理由: どちらも本物の `post-login` が読む控えと同じ物を作り、アプリのコードに試験専用の入口を足さないため。`FR-AUTH-018-AC-01`: 認めた鍵が1本の店員は `needsMfa: true`・`redirectTo: '/auth/verified'`（今のページ。段3で変わる）で戻り先の控えは使い切られない、`-AC-02`: 認めた鍵が1本の店員に `next=/admin` の控えを付けても `/admin` に着かない、`-AC-03`: お客さんは `needsMfa: false`、認めた鍵2本の店員は `/admin`（戻り先が無ければ）。`grep -rn "aal2\|'aal1'\|aal:" src/features/auth src/app/api/auth/post-login src/app/api/auth/oauth src/app/api/auth/confirm` が、**`mfa`・`password/change` の窓口（段4で消す）以外で0**になる
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/features/auth/return-intent tests/unit/api/auth/post-login-route.test.ts tests/unit/api/auth/oauth-callback-route.test.ts tests/unit/api/auth/confirm-route.test.ts` → FAIL
- [ ] **Step 3: 直す** — 上のとおり。`@remarks` の「aal2」の文を直す（拒否の理由の名前は段4で直すとコメントに書く）
- [ ] **Step 4: 通ることを確かめる** — 単体・`tests/integration/api/auth/return-intent-flow.test.ts` PASS。`npm.cmd test`（単体全件）が変更前と同じ結果。ログインの E2E（`FR-LOGIN-038` のお客さんの分と `FR-LOGIN-054`）が緑（調整役が流す）。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `refactor(auth): 店員の行き先・戻り先の判定を aal2 からパスキーの条件に置き換える`

### Task 6: ログインの終わり（UV の門・認めたパスキーの確かめ・アプリのセッション）

**Files:**
- Create: `src/app/api/auth/passkey/login/finish/route.ts`、`e2e/passkey-app-api.ts`
- Modify: `scripts/e2e/passkey-staff.ts`（認めずに鍵を足す `addUnapprovedPasskey` を足す）
- Test: `tests/unit/api/auth/passkey-login-finish-route.test.ts`、`e2e/FR-LOGIN-050-passkey-login-finish.spec.ts`
- 文書（同じコミット）: `SR-AUTH-017` に要件 `FR-AUTH-019`（終わり）を足す、`DD-AUTH-055`、`IMPL-AUTH-258`・`259`（窓口・試験の道具）、`SEC-AUTH-044`（UV の門・認めていない鍵・**`id` と `rawId` の食い違い（GoTrue は `rawId` で鍵を引くのが有力。アプリが `id` で引くと、確かめた鍵と認めを調べた鍵が別になりうる）**・ログインの Oracle）、ADR-0467 の足し（認めていない鍵のセッションを終わらせる理由）、`docs/03_BasicDesign/areas/auth.md`、台帳

**Interfaces:**
- Produces: `POST /api/auth/passkey/login/finish`、本文 `{ challenge_id: string; credential: <WebAuthn の応答>; next?: string }`（`PasskeyLoginFinishSchema`）。順番:
  1. `enforceRateLimit({ endpoint: 'auth:passkey:login:finish', limit: 30, windowSeconds: 600 })`（IP ごと。IP が取れなくても今の `otp/verify` と同じく枠に入れる。始めと違い、GoTrue の枠を守る物ではないため）
  2. 本文を `zod` で読む（外れたら **400** `{ error: 'invalid_request' }`。**`credential.id !== credential.rawId` も外れ**で、GoTrue を呼ばない）
  3. **UV の門**: `readAuthenticatorDataFlags(credential.response.authenticatorData)` が `null` か `userVerified` が偽なら **400** `{ error: 'uv_required' }`。**この時点まで GoTrue を呼ばない**
  4. GoTrue の終わり: `createPublicClient().auth.passkey.verifyAuthentication({ challengeId, credential })`（匿名の鍵。Turnstile は要らない）。失敗は、`isStaffPasskeyRequiredError` の時 **403** `{ error: 'staff_passkey_required' }`、`status` 429 は 429、ほかは **401** `{ error: 'passkey_login_failed' }`（GoTrue の文・本文を返さない。どの理由でも同じ本文にして、鍵の有無・登録の有無が分からないようにする）。監査は固定の符号だけ
  5. 店員の確かめ（Task 1 の `passkey-approval-rpc.ts` を使う）: `isStaff(user.id)` が真なら、`isCredentialApproved(user.id, credential.rawId)`（`rawId` を `bytea` に直した値で引く）が真であること。**偽なら** GoTrue のセッションを `revoke_auth_session`（RPC）で終わらせ（`session_id` は返ってきたアクセストークンから `readAuthSessionId`）、Cookie も `public.sessions` の行も作らず **403** `{ error: 'passkey_not_approved' }`（監査に `passkey_not_approved`）。RPC が落ちたら、同じくセッションを終わらせて **503**（閉じる側）
  6. `persistSessionAndCookies(res, session, user, readGuestShoppingTokens(...))`（今の `otp/verify` と同じ。失敗は 500）。成功したら `linkGuestOrdersByEmail`（今の `otp/verify` と同じ。お客さんの注文の引き継ぎ）
  7. `next` があれば `issueReturnIntent({ rawNext: next, purpose: 'login' })` の控えの Cookie を付ける（無ければ clear）。段2の画面は、この後に `POST /api/auth/post-login` で行き先をもらう（今のメールのコードの流れと同じ）
  8. **200** `{ user: { id, email, role } }`（`role` は `app_metadata.role` が `admin`・`supporter` の時だけその値、他は `user`。`otp/verify` と同じ形）
- `e2e/passkey-app-api.ts`（試験の道具。手元だけ。後のタスクも使う）: `loginViaApp(request, { authenticator, ip, next? })`（始め → 認証器の `authenticate` → 終わりの窓口。Cookie は `request` の文脈に入る。戻りに `status`・`body`・`cookies`）、`startLoginViaApp(request, { ip })`。窓口へは `origin: http://localhost:3000` と `x-real-ip` を付ける。トークン・Cookie の値を失敗の文面に出さない

**作り手の判断（Task 6）:** (1) 認めていない鍵で入った店員は、**GoTrue のセッションを終わらせてから**断る（理由: 終わらせないと、拒否した後も GoTrue のセッションが生き、Cookie は無いが、GoTrue を直に叩ける人にはトークンが渡っている。アプリの結び付けで API・RLS は通らない（5-3）が、不要な生きたセッションを残さない）。(2) ログインの失敗の本文は理由を分けず `passkey_login_failed` の1つ（理由: 「この鍵は無い」と「署名が合わない」を分けると、鍵の有無の調べに使われる）。UV の欠けだけは別の符号（理由: ブラウザが `required` を無視した異常の時で、利用者の誤りの調べにならない）。(3) `next` を終わりの窓口で受ける（理由: 今のメールのコードは「ログインを始める POST」で控えを作る。パスキーの始め (b) はブラウザから GoTrue を直に呼ぶので、アプリの窓口を通る最初の機会が終わりになる）。(4) お客さんの注文の引き継ぎ（`linkGuestOrdersByEmail`）とカート・お気に入りの引き継ぎも終わりで行う（理由: 今のログインの終わり（`otp/verify`）と同じ。パスキーで入ったお客さんだけ引き継ぎが落ちないように）。

- [ ] **Step 1: 失敗する試験を書く** — 単体（GoTrue・RPC・`persistSessionAndCookies` を差し替える）: 本文が不正で400・GoTrue 0回、**`id` と `rawId` が違う応答は400・GoTrue 0回**、**UV の印が無い応答・36バイトの `authenticatorData`・壊れた base64url で `uv_required` かつ GoTrue 0回**（Review Focus 2）、GoTrue の誤りが 401（本文が理由ごとに変わらない）、印つき403 が 403 `staff_passkey_required`、店員で認めた鍵は200・Cookie が付く、**店員で認めていない鍵は403・`revoke_auth_session` が1回・`persistSessionAndCookies` が0回・Cookie なし**、お客さんは `isCredentialApproved` を**呼ばない**、店員判定の RPC が落ちたら 503（`persistSessionAndCookies` 0回）、`next` が不正なら控えは clear・ログインは成功、`linkGuestOrdersByEmail` が呼ばれる。E2E（3幅。ソフトの認証器で本物の GoTrue に当てる）: (a) 認めた鍵2本の店員が `loginViaApp` で200・`sb-access-token` などの Cookie・`/api/auth/me` が `authenticated: true`・`mfaVerified: true`、**そのまま管理 API（例: `/api/admin/users`）が200**（Cookie のセッションが結び付いている）、(b) 認めた鍵1本の店員は200で入るが `mfaVerified: false`・管理 API は403、(c) **認めていない鍵は403・Cookie 無し・`auth.sessions` に残らない**。認めていない鍵の作り方: `provisionStaff` の道具は渡した本数を必ず認める（認めない鍵は作れない）ので、**認めた鍵2本の店員の本人のトークンで、`auth.passkey.startRegistration`→`verifyRegistration` を GoTrue に直に当てて3本目を足し、認めない**（直に足した鍵の再現。`passkey-staff.ts` に、認めずに足す小さな関数 `addUnapprovedPasskey` を足してよい）。(c2) **`id` と `rawId` の食い違い**: 認めた鍵 K1 の `id` に、直に足した（認めていない）鍵 K2 の `rawId`・署名を付けて終わりに送ると400・Cookie 無し・`auth.sessions` が増えない、(d) お客さん（認めの表に無い）が200、(e) UV の無い認証器（`authenticate(options, { userVerified: false })`）は400・`auth.sessions` が増えない、(f) **(b) の道: ブラウザの代わりに supabase-js の匿名クライアントで `startAuthentication({ options: { captchaToken: DUMMY_CAPTCHA_TOKEN } })` を呼び（別の呼び手）、`userVerification` を `required` に書き換えて認証器で署名し、アプリの終わりに送ると200**（始めと終わりの呼び手が違っても通る）、(g) `next=/admin` つきで入った認めた鍵2本の店員が `post-login` で `redirectTo: /admin`・`needsMfa: false`、1本の店員は `/auth/verified`・`needsMfa: true`
- [ ] **Step 2: 失敗を確かめる** — 単体 `npx.cmd jest tests/unit/api/auth/passkey-login-finish-route.test.ts` → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS。調整役が E2E（`FR-LOGIN-050`）を流す。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): パスキーのログインの終わりの窓口を足す（UV の門・認めた鍵の確かめ）`

### Task 7: 登録の始め・終わり（窓・入り直し・認めたパスキー）

**Files:**
- Create: `src/app/api/auth/passkey/register/start/route.ts`、`register/finish/route.ts`、`src/lib/auth/passkey-recent-auth.ts`
- Modify: `e2e/admin-session-test-utils.ts`（`createWindowSessionActor` を足す）
- Test: `tests/unit/lib/auth/passkey-recent-auth.test.ts`、`tests/unit/api/auth/passkey-register-start-route.test.ts`、`passkey-register-finish-route.test.ts`、`e2e/FR-LOGIN-051-passkey-registration.spec.ts`
- 文書（同じコミット）: `SR-AUTH-019`（登録・一覧・名前・削除の窓口）、`FR-AUTH-020`（登録）、`DD-AUTH-056`（補償の削除で、引き金が「足した」「消した」の2通の知らせを outbox に積み、店員と店長に2通届くことも書く）、`IMPL-AUTH-260`〜`262`（`passkey-recent-auth.ts`・register の2つの route）、`SEC-AUTH-045`（登録の条件・窓の再確認・**窓の免除は認めた鍵が2本未満の間だけ**（メールを読めた人が窓の残りで3本目を認めさせない。設計 5-5・10）・**旗に関わらず結び付いたセッションだけ**（旗を切った間に結び付かないセッションで鍵を認めさせない）・補償の削除。**同時の2つの終わりの競りは、移行 F の `passkey_approve('window')` が利用者ごとの錠の中で数え直して塞ぐ（Task 1）。残る隙: 窓口の再確認と認めの間は別の取引なので、競り負けた方は GoTrue に鍵ができた後に `55000` で落ちる→補償の削除で消える（鍵が一瞬だけ在る）。`reauth` の道は上限を掛けない（入り直した本人が足す物で、設計 5-5 のとおり）**）、ADR-0467 の足し、`docs/03_BasicDesign/areas/auth.md`、台帳

**Interfaces:**
- Produces:
  - `passkey-recent-auth.ts`（純粋）: `export type RegistrationMode = 'window' | 'reauth' | 'customer'`、`export function evaluateRegistrationAccess(input: { claims: { amr?: unknown } | null; isStaff: boolean; windowOpen: boolean; approvedCount: number; nowSeconds: number }): { ok: true; mode: RegistrationMode } | { ok: false; reason: 'window_closed' | 'reauth_required' }`。店員: `amr` の `passkey` の最新の時刻が `-60 <= now - ts <= 300`（`-60` は1aと同じ時計のずれ）なら `reauth`。そうでなく **`windowOpen` かつ `approvedCount < 2`（`STAFF_MIN_APPROVED_PASSKEYS`。`Number.isInteger` でない値は閉じる側＝窓を認めない）** なら `window`。どちらでもない時は、`amr` に `passkey` がある（古い）店員と、**窓が開いていても認めた鍵が2本以上ある店員**は `reauth_required`、`passkey` が無く窓が閉じている店員（窓のセッションが閉じた・メールのコードだけ）は `window_closed`。お客さん（`isStaff` 偽）: `amr` の `passkey` か `otp` の最新の時刻が `-60 <= now - ts <= 600` なら `customer`、外れたら `reauth_required`。`amr` が欠ける・配列でない・時刻が整数でない（文字列・小数）は、その要素を無いものとして扱う（1a の `evaluateStaffEntry` と同じ読み方）
  - `POST /api/auth/passkey/register/start`（本文なし）の順番: ① `enforceRateLimit`（IP ごと 20回／600秒）② `authenticateRequest`（失敗は `authFailureResponse`）③ `requireCsrfOrDeny()` ④ `enforceRateLimit`（`subject: user.id` で 10回／600秒）⑤ `isStaff(user.id)`（Task 1 の部品。`{ ok: false }` は **503**）。**店員なら `checkAuthSessionLiveness(claims.session_id, true)` を呼び、`active` でなければ 401（`unavailable` は 503）**。旗 `AUTH_REQUIRE_APP_SESSION` に関わらず、結び付いた生きたセッションだけを通す（`admin-rbac` と同じ。`authenticateRequest` は旗が切れていると結び付きを求めないため）⑥ 店員で `claims.session_id` があれば `passkey_window_is_open(user.id, session_id)` と `approvedCount(user.id)`（失敗は 503） ⑦ `evaluateRegistrationAccess`（`approvedCount` を渡す）が外れなら **403** `{ error: 'registration_not_allowed', reason }`（GoTrue を呼ばない）⑧ `registrationOptions(accessToken)` → `options.authenticatorSelection.userVerification = 'required'` に書き換えて（GoTrue の応答に `authenticatorSelection` が無ければ、空の物を作ってから入れる） **200** `{ challenge_id, options, expires_at, mode }`。GoTrue の失敗は **502** `{ error: 'passkey_register_failed' }`
  - `POST /api/auth/passkey/register/finish`、本文 `{ challenge_id, credential }`（`PasskeyRegisterFinishSchema`。**`id !== rawId` は 400**）の順番: ①〜⑦ は始めと**同じ確かめをもう一度**（結び付いた生きたセッション・窓・認めた鍵の本数・入り直しの再確認。始めからの間に窓が閉じた・期限が来た場合は 403 で、GoTrue の検証を呼ばない）⑧ `readAttestationUserVerified(credential.response.attestationObject)` が真でなければ **400** `{ error: 'uv_required' }`（GoTrue の検証を呼ばない）⑨ `registrationVerify(accessToken, { challengeId, credential })` ⑩ **店員なら** `approve(user.id, passkey.id, mode === 'window' ? 'window' : 'reauth')`（Task 1 の部品）。失敗したら（`23505` の古い行を含む）、`createServiceRoleClient().auth.admin.passkey.deletePasskey({ userId, passkeyId })` で今作られた鍵を消して（補償）、**500** `{ error: 'passkey_approve_failed' }`、補償の削除も失敗したら監査に `passkey_approve_failed:compensation_failed`（鍵は認めの表に無いので数に入らない。引き金が店員と店長に知らせる）⑪ **200** `{ passkey: { id, friendly_name, created_at }, approvedCount?: number }`（`approvedCount` は店員だけ。`approvedCount` の部品の値）。**窓は閉じない・セッションは終わらせない**（招待の「2本そろったら窓を閉じる」は段3。窓の長さ30分が上限）
  - `e2e/admin-session-test-utils.ts` に `createWindowSessionActor(db, { role: 'admin' | 'supporter' }): Promise<AdminSessionActor>` — 設計 6-2 手順3の案 B の順: 利用者を作る（役割なし）→ magiclink の session → **アプリに結び付ける**（`bindAppSession`）→ `passkey_window_open(user, session_id)` → 最後に `user_roles` を有効にする。`createAdminSessionActor` の既存の書き方・M-8（手元の DB 以外に書かない）に従う

**作り手の判断（Task 7）:** (1) 設計 5-5 は店員の登録に2つの道を認めている（窓の中、または5分以内のパスキーでの入り直し）ので、**両方**作った（「窓の中だけ」ではない。窓の外で3本目・差し替えを足せなくなるため）。(2) お客さんの登録の確かめは10分以内の**パスキーかメールのコード**（設計 5-5 の文のまま。Google（`oauth`）は含めない。**調整役の判断（設計 5-5 による）**: Google で入ったお客さんは、足す前にメールのコードで入り直す）。(2b) 窓の免除は認めた鍵が2本未満の間だけ（設計 5-5「窓の中の最初の2本」）。(3) 認めの書き込みが落ちた時は、GoTrue に作られた鍵を**消す補償**を入れた（理由: 鍵は GoTrue に作られるが認めの表に無いので、数に入らず店員は入れない。そのまま残すと「本人は登録したつもりで、実は使えない鍵」が増える）。(4) 窓を閉じる・セッションを終わらせるのは段3（理由: 招待の流れの一部で、画面の「もう1本」の案内と一体）。1b の窓は30分で自然に切れる。(5) 補償の削除は管理 API（サービスの鍵）で行い、アプリの Cookie の更新は行わない。

- [ ] **Step 1: 失敗する試験を書く** — 純粋: `evaluateRegistrationAccess` の表（店員×{窓あり／なし}×**認めた鍵 {0・1・2・`NaN`・小数}**×{`passkey` の `amr` が新しい／ちょうど300秒／301秒／未来61秒／欠け／文字列の時刻}、お客さん×{`passkey`・`otp`・`oauth` のみ}×{599秒／601秒}）。単体: ルートの順番どおりの断り（Review Focus 3）、**終わりで窓が閉じていたら GoTrue の検証が0回**、`approve` が落ちたら補償の削除が1回・500（`reason: 'window_full'` も同じ）、補償も落ちたら500・監査の符号、お客さんは `passkey_approve` を**呼ばない**、UV の無い `attestationObject` は400・検証0回、CSRF の無い要求は403、結び付かないセッションは401、**旗 `AUTH_REQUIRE_APP_SESSION` を切った状態（`process.env` を差し替える）でも、店員の結び付かないセッションは始め・終わりとも 401・GoTrue 0回**、`id !== rawId` の終わりは400・GoTrue 0回、窓の中でも認めた鍵が2本なら始め・終わりとも403 `reauth_required`、GoTrue の応答に `authenticatorSelection` が無くても `userVerification: 'required'` が入る。E2E（3幅）: (a) `createWindowSessionActor` の店員が窓の中で始め → ソフトの認証器 `register()` → 終わりで200・`approvedCount` が1、2本目で2、**3本目は窓がまだ開いていても始めで403（Review Focus 3）**、(b) **窓を `passkey_window_close` で閉じた後は始めが403**、始めの後に閉じると終わりが403・GoTrue に鍵ができない（`auth.webauthn_credentials` が増えない）、**別のセッション・別の人の窓では403**、(c) 認めた鍵2本の店員（`provisionStaff`）が `loginViaApp` で入り直した直後は `reauth` で登録でき（これが「3本目の足し方」）、認めた数が3、**窓も入り直しも無い店員（メールのコードだけのセッション）は403**、(d) 5分より古い入り直しの403は、5分を待てないので単体（時刻をずらす）で確かめ、E2E は「新しい」と「無い」の2通りだけにする、(e) お客さんがメールのコードで入った直後に登録でき、認めの表に行が増えない、(f) UV の無い認証器の登録は400、(g) 店員が登録した鍵は認めた鍵として数えられ、直に GoTrue（本人のトークンで `auth.passkey.startRegistration`→`verifyRegistration`。Task 6 の `addUnapprovedPasskey`）で足した鍵は数えられない（5-5）、(h) **`id !== rawId` の終わりは400で鍵ができない**
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/lib/auth/passkey-recent-auth.test.ts tests/unit/api/auth/passkey-register-start-route.test.ts tests/unit/api/auth/passkey-register-finish-route.test.ts` → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS。調整役が E2E（`FR-LOGIN-051`）を流す。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): パスキーの登録の窓口を足す（窓・入り直しの確かめ・認めたパスキー）`

### Task 8: 一覧・名前の変更・削除

**Files:**
- Create: `src/app/api/auth/passkey/route.ts`（`GET`）、`src/app/api/auth/passkey/[id]/route.ts`（`PATCH`・`DELETE`）
- Test: `tests/unit/api/auth/passkey-manage-routes.test.ts`、`e2e/FR-LOGIN-052-passkey-manage.spec.ts`
- 文書（同じコミット）: `SR-AUTH-019` に要件 `FR-AUTH-021`（一覧・名前・削除）を足す、`DD-AUTH-057`、`IMPL-AUTH-263`・`264`、`SEC-AUTH-046`（削除の止め・他人の鍵。**残る隙: 同時に2つの削除が来ると、確かめの時点では2本以上でも、両方が通って2本を下回りうる**。設計の「画面で止める」を越える足しなので、完全な排他は作らず、隙として書いて受け入れる。下回った店員は管理の入口で止まり、引き金の知らせが出る）、ADR-0467 の足し（店員の削除の止め）、`docs/03_BasicDesign/areas/auth.md`、台帳

**Interfaces:**
- Produces（どれも `authenticateRequest` を通す。`PATCH`・`DELETE` は `requireCsrfOrDeny()` も通す。IP ごと 60回／600秒の回数の制限）:
  - `GET /api/auth/passkey` → **200** `{ passkeys: [{ id, friendly_name, created_at, last_used_at, approved?: boolean }], isStaff: boolean, approvedCount?: number }`。GoTrue の `GET /passkeys` を本人のトークンで呼ぶ。`approved`・`approvedCount` は**店員だけ**（Task 1 の部品の `isStaff`・`approvedIds`・`approvedCount`）。GoTrue が返さない項目（公開鍵・`credential_id`）を応答に載せない（許可リスト方式で項目を写す）
  - `PATCH /api/auth/passkey/{id}`、本文 `{ friendly_name }`（`PasskeyRenameSchema`。1〜64字・前後の空白を除く・制御文字なし）→ **200** `{ passkey: { id, friendly_name } }`。`id` は uuid の形でなければ **400**（GoTrue を呼ばない）
  - `DELETE /api/auth/passkey/{id}` → **200** `{ ok: true }`。**店員**は、消した後に認めた鍵が `min_approved_passkeys`（2）未満になる時（その鍵が認めた鍵で、`passkey_approved_count - 1 < 2`）、**409** `{ error: 'staff_min_passkeys' }`（GoTrue を呼ばない。設計 6-2「削除で2本を切る時は止める」）。お客さんは最後の1本も消せる。他人の鍵・存在しない鍵は GoTrue が返す誤りを **404** `{ error: 'not_found' }` に直す（他人の鍵と存在しない鍵を区別しない）
  - 鍵が消えると、1a の引き金が認めの行を消し、outbox に積む（アプリは何もしない）
- 本人のトークンは Cookie 由来のアクセストークンで、更新トークンは使わない（`passkey-gotrue.ts`）

**作り手の判断（Task 8）:** (1) 削除の止めを**サーバーでも**かける（設計は画面で止めると書き、GoTrue を直に叩かれたら止められないので知らせで気づく、とする）。理由: 画面（段3）が無い1bの窓口が、そのまま1本に減らせる抜け道になる。窓口は管理 API でなく本人のトークンで呼ぶだけなので、サーバーの止めを足しても GoTrue を直に叩く道は塞がらないが、アプリの窓口を使う人の誤操作は止まる。(2) 名前は1〜64字（理由: 設計に長さの決めが無い。GoTrue の側の上限は未確認で、端末名の初期値より長い名前を使う理由が無い）。(3) 一覧の項目は許可リスト方式で写す（理由: GoTrue の応答に公開鍵などが入っても、窓口が漏らさない）。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 順番どおりの断り（401・503・CSRF なしの403・回数の制限）、`id` が uuid でなければ400・GoTrue 0回、`friendly_name` の境界（空・空白だけ・64字・65字・制御文字）、一覧が許可リスト方式（GoTrue のモックの応答に `public_key`・`credential_id` を入れても応答に出ない）、店員の削除の止め（認めた鍵が2本で認めた鍵を消す→409・GoTrue 0回／3本で消す→200／認めていない鍵なら2本のまま消せる）、お客さんは最後の1本を消せる、他人の鍵（GoTrue が 404 を返す）は 404 で本文が「存在しない鍵」と同じ。E2E（3幅）: 店員（`provisionStaff` の認めた2本に、Task 7 の `reauth`（`loginViaApp` の直後の登録）で3本目を足した物。`provisionStaff` は最大2本）で、一覧が3件・`approved: true`・`approvedCount: 3`、名前の変更が一覧に反映される、1本を消して2本に・もう1本を消そうとして409、お客さんは一覧に `approved`・`approvedCount` が無く、最後の1本を消せる、**別のお客さんの鍵の `id` を `DELETE` すると404で鍵が残る**、直に GoTrue で足した鍵（Task 6 の `addUnapprovedPasskey`。認めていない）の一覧の `approved` が偽
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/api/auth/passkey-manage-routes.test.ts` → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS。調整役が E2E（`FR-LOGIN-052`）。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): パスキーの一覧・名前の変更・削除の窓口を足す（店員の削除は2本未満に減らさない）`

### Task 9: フックが更新を拒否したら、アプリがそのセッションを終わらせる

**Files:**
- Modify: `src/app/api/auth/refresh/route.ts`（`!tokenRes.ok` の枝）
- Test: `tests/unit/api/auth/refresh-route.test.ts`（既存に足す）、`e2e/FR-LOGIN-053-passkey-refresh-rejection.spec.ts`
- 文書（同じコミット）: **`SR-AUTH-020`**（更新が拒否されたらセッションを終わらせる）、`FR-AUTH-022`、`DD-AUTH-058`、`IMPL-AUTH-265`（`refresh/route.ts` の `@remarks`）、**ADR-0466**（決めの理由）、`SEC-AUTH-047`（拒否の後に残るセッション）、`docs/03_BasicDesign/areas/auth.md`、台帳

**Interfaces:**
- 変える: GoTrue の `/token?grant_type=refresh_token` が `ok` でなく、**`status === 403` かつ本文の `msg`（無ければ `message`）が `isStaffPasskeyRequiredError` を満たす**時だけ、次を行う:
  1. 前の `public.sessions` の行（`session.id`）を `revoked_at = now()` にする（`persistNewSession` は呼ばない。新しい行は作らない）
  2. その行の `auth_session_id` があれば、RPC `revoke_auth_session(auth_session_id)` で GoTrue のセッションを消す（拒否された更新は GoTrue のセッションを終わらせない。試し T2）
  3. Cookie（アクセス・更新・CSRF）を消し、**401** `{ error: 'Staff passkey required', code: 'staff_passkey_required' }`（画面は `/login` に送る。文言は段3）
  4. 監査に `outcome: 'failure'`・`detail: 'staff_passkey_required_session_ended'`（1・2のどちらかが落ちたら `detail: 'staff_passkey_required_end_failed'`、`outcome: 'error'`）。**どちらが落ちても Cookie は消して 401**（閉じる側）
- 変えない: 印の無い 403・401・5xx・ネットワークの誤りの今の動き（Cookie を消して 401 `Failed to refresh token`。セッションの行は終わらせない）、旗 `AUTH_REQUIRE_APP_SESSION` の挙動、お客さんの更新
- **決めの理由（ADR-0466 に書く）**: 拒否された更新の後、アプリは Cookie を消すだけだと、GoTrue の `auth.sessions` の行と `public.sessions` の行が生きたまま残り、前のアクセストークン（最長1時間）が `/api/auth/me` や（店員の役割と無関係な）お客さんの機能で使い続けられる。管理の入口は 24時間の条件で止まる（1a）が、**期限が切れた店員のセッションそのものを終わらせる方が、残りのセッションを数えない・無操作1時間（段3）の土台になる**。印の無い失敗では終わらせない（GoTrue の一時の不調で正当な利用者を追い出さない）

**作り手の判断（Task 9）:** 終わらせると決めた（設計 5-2 は「段1で決める」）。理由は上。**代案**（終わらせずに 401 だけ返す）は、拒否後も `/api/auth/me` が1時間 `authenticated: true` を返し続け、画面の表示（`mfaVerified: false`）と「ログイン状態」の食い違いが出るため採らなかった。**印の判定は文字列の頭の一致だけ**（1a の `isStaffPasskeyRequiredError`）に頼る（試し T2 で 403・`unknown`・フックの文と確かめ済み。本番で形が違わないかは 8-2 の9で確かめる）。

- [ ] **Step 1: 失敗する試験を書く** — 単体（`fetch`・`sessionService`・`createServiceRoleClient` を差し替える。既存の `refresh-route.test.ts` の書き方に合わせる）: 印つきの403で、行の失効・`revoke_auth_session`・Cookie の消去・401と `code`・監査が出る。**印の無い403・401・500・ネットワークの誤りでは、行の失効も RPC も呼ばれない**（今の動きのまま）（Review Focus 4）。失効の更新が落ちても RPC を呼び、Cookie を消して 401。RPC が落ちても Cookie を消して 401・監査が `end_failed`。`auth_session_id` が無い行は RPC を呼ばない。E2E（3幅）: 1a の `e2e/passkey-hook-scenarios.ts` の窓の流れ（役割の無い間にメールのコードで入る → アプリに結び付ける → `passkey_window_open` → 役割を有効にする）で作った店員のセッションを Cookie に載せ、(a) 窓が開いている間の `POST /api/auth/refresh` は200（新しい Cookie）、(b) `passkey_window_close` の後は **401・`code: 'staff_passkey_required'`・Cookie が消える・`public.sessions` の行が `revoked_at` つき・`auth.sessions` の行が無い**、(c) 前のアクセストークンで `/api/auth/me` を呼ぶと `authenticated: false`（拒否の前は true）、(d) お客さん（窓の無い）の更新は今までどおり200
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/api/auth/refresh-route.test.ts` → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS（既存の refresh の試験が全部通る）。調整役が E2E（`FR-LOGIN-053`）。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): フックが更新を拒否した店員のセッションをアプリが終わらせる`

### Task 10: 止めていた2本の試験の作り直し・`loginAsMember` の確認

**Files:**
- Modify: `e2e/FR-LOGIN-038-login-return-to.spec.ts`（`FR-AUTH-005-AC-05` の2本。356行目・377行目あたり。`test.skip` を外し、パスキーのログインで書き直す）
- Test: 上の spec 自体（`FR-AUTH-018-AC-01`〜`03` は Task 5 の `FR-LOGIN-054` で済んでいる。ここでは足さない）
- 文書（同じコミット）: `FR-AUTH-005-AC-05` の文を、パスキーの流れに合わせて `docs/02_Requirements/areas/auth.md` で直す（「確認コードの後に `/auth/verified` で2段目」→「パスキーで入った後、条件を満たす店員は戻り先・`/admin` へ、満たさない店員は `/auth/verified` へ」）、台帳の「skip の一覧」から2本を外す

**Interfaces:**
- 作り直す2本（名前の先頭の `FR-AUTH-005-AC-05` は変えない）:
  - 「**店員は、パスキーで入った後に戻り先（`/item`）へ移る**」: `provisionStaff({ role: 'admin', approvedPasskeys: 2 })` → 試験の中でお客さんの流れと同じ形の戻り先の控えを作る（`POST /api/auth/login` の `next` は今のパスワードの窓口なので使わない。**`loginViaApp` に `next: '/item'` を渡し**、終わりの窓口が控えを作る）→ `POST /api/auth/post-login` が `redirectTo: '/item'`・`needsMfa: false` → `page.goto` でその先に着く
  - 「**戻り先の無い店員は `/admin` へ移る**」: 同じく `next` 無しで `redirectTo: '/admin'`、`/admin` に着く（見出しか目印の要素）
  - （`FR-AUTH-018-AC-01`〜`03`＝1本の店員・`/admin` 向きの戻り先・お客さんの行き先は、Task 5 の `FR-LOGIN-054` で済んでいる。ここでは足さない）
- 画面（`/login`・`signInOnLoginScreen`）は使わない（店員が画面からパスキーで入る道は段2・3）。窓口を `request` で直に呼び、行き先は `post-login` の応答と `page.goto` で確かめる
- **`loginAsMember` の確認（作り直しではない）**: `e2e/member-session-helpers.ts` の `loginAsMember` は、今の `login/resend` と `otp/verify` の道（お客さんのメールのコード）で動く。1b は `otp/verify` を変えない。Task 5・6 の後でも動くことを、**`loginAsMember` を使う spec 17本（2026-11-17 の実測）のうち、分野の違う6本を調整役が選んで流して確かめる**（`grep -l loginAsMember e2e/*.spec.ts` で数え直し、`FR-LOGIN-038` と、カート・決済・アカウントから各1〜2本）。落ちたら Task 5・6 のどれが原因かを `git bisect` でなく「そのタスクのコミットの前後で同じ spec を流す」で切り分ける

- [ ] **Step 1: 試験を書き直す** — `test.skip` を外し、今の `signInOnLoginScreen`・`addVerifiedTotpFactor`・`elevateCookieToAal2` の道は使わない。Task 5・6 が済んでいるので、最初から通るはず（赤を作るための戻しはしない。「直す前に赤」は Task 5 の `FR-LOGIN-054` で済んでいる）
- [ ] **Step 2: 書き直す** — 3幅（390・768・1280）で流れるよう、今の spec の `viewport` のくり返しに合わせる
- [ ] **Step 3: 通ることを確かめる** — 調整役が `FR-LOGIN-038` を本番ビルドで流す（スキップが0）。`loginAsMember` の6本が緑。`FR-AUTH-005-AC-05` が追跡で「skip でなく通っている」ことを `npm.cmd run trace:report` で確かめる
- [ ] **Step 4: 文書と追跡** — `validate-trace`・`test:trace-coverage`・`validate-docs`・`npm.cmd run trace:report`
- [ ] **Step 5: コミット** — `test(auth): 店員の行き先の試験をパスキーのログインで作り直す（FR-AUTH-005-AC-05）`

### Task 11: 運用の文書（`Sb-Forwarded-For`・本番へ当てる順・「段1b の招待」の誤記）

**Files:**（文書だけ。コードは変えない）
- Modify: `docs/06_Operations/supabase-auth-config.md`、`docs/06_Operations/first-admin-bootstrap.md`（28行目・102行目）、`docs/06_Operations/db-migrations.md`（183行目、移行 F の節、1a の「本番への当て方の順と前提」の節に F を足す）、`docs/06_Operations/secrets.md`（3つの環境変数）、台帳 `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（行 1a-4 の「段1b の招待」→「段3の招待」、1b の行を足し、状態欄を更新）
- 文書（同じコミット）: `docs/03_BasicDesign/areas/auth.md` の窓口の一覧の最終確認、`docs/05_Quality/security/threats/auth.md` の SEC-AUTH-041〜047 の突き合わせ

**内容（`supabase-auth-config.md` に新しい節「パスキーのログインの始めと `Sb-Forwarded-For`」）:**
- 前提: 設計 5-1 の (a)。GoTrue の始めの制限は IP ごとに5分30回で、上げる設定は無い（確定）。`Sb-Forwarded-For` は `sb_secret_` の鍵でだけ受け付けられ、**プロジェクトの設定で有効にする必要がある**
- 有効にする手順（**本番の独自のドメインが決まり、本番でパスキーを有効にした後**。設計 12-2 の6）: ①ダッシュボードか Management API の `GET /v1/projects/{ref}/config/auth` の応答で、`Sb-Forwarded-For` に当たる項目の鍵名を確かめる（**鍵名は未確認。推測で書かない**。見つからなければ、Supabase のサポートか文書で確かめる）②その項目を有効にする ③`SUPABASE_SECRET_KEY` に `sb_secret_` の鍵を Vercel の環境変数に入れる（古い `service_role` の JWT では添え書きが効かない）④再デプロイ ⑤確かめ（**アプリを通さず GoTrue を直に叩く**。アプリの20回の制限が先に 429 を返すため）: `apikey` に `sb_secret_`・`Sb-Forwarded-For` に IP A を付けて始めを31回呼ぶ → 最後が 429。続けて `Sb-Forwarded-For` を IP B にして1回呼ぶ → 200。これで「IP ごとに数えている」と分かる。IP B も 429 なら添え書きが効いていない（(b) に切り替える）。手順には、叩く時に鍵を手元の履歴に残さない書き方（環境変数のファイルから読む）を書く
- 効かなかった時: `NEXT_PUBLIC_PASSKEY_START_MODE=browser` に変えて再デプロイ（(b)）。(b) の前提: 本番の GoTrue で captcha を有効にする（captcha の段階 B）。(b) では始めの回数の制限は GoTrue の IP ごと5分30回だけで、アプリ側の制限（20回）は効かない
- `sb_secret_` が captcha を免除しない時（設計 8-2 の2）: (a) にも Turnstile のトークンが要る。**1b の窓口は対応しない**（別の計画）。免除されるかの確かめを先に行う
- 手元の開発: `npm run dev` は IP の見出しを信じない（`getClientIp` が `null`）ので、始めの窓口が 503 になる。**`PASSKEY_START_DEV_IP=<適当な IP>` を `.env.development.local` に置く**（`next dev` だけが読む場所。`.env.local` に置くと本番ビルドの E2E（`next start`）にも入る。E2E は Task 3 で空の値で上書きするが、置き場所を分けて事故を防ぐ。手元の Supabase の住所の時だけ効き、本番・Vercel では値があるとビルドと起動が止まる）。（このファイルを実装者が開いて読むことはしない。置き方の説明を文書に書くだけ）E2E は `CLIENT_IP_HEADER` で足りるので要らない
- 本番の確認の一覧（8-2）との対応表（1b が作った道と、本番で確かめる項目の1・2・8・9）

**`db-migrations.md`・`first-admin-bootstrap.md`・台帳:** 「段1b の招待の流れ」を「**段3の招待の流れ**」に直す（誤記）。1a の「当てる順」の節に移行 F を足す（A の後・アプリのデプロイの前。F は `passkey_approve` を置き換えるので A の後。E より先でも後でもよい）。ロールバックの順に F を足す（F → E → D → C → B → A の逆順の最初に F）。「段3まで `db push` しない」の一覧に F を足す

**持ち越し（文書に書く）**
- 1a の持ち越し (i)（古い認めの行）→ Task 1 で関数を声を出して失敗させ、SEC-AUTH-041 に「古い行を SQL で消す」運用の手順を書いた。直し方は `db-migrations.md` の移行 F の節に1行
- 1a の持ち越し (ii)（「失効が、アプリに結び付いていないセッションも消す」試験）→ **段3の招待・やり直しの流れで足す**（`revokeAllSessionsForUser` を呼ぶのは段3の窓口。1b の窓口は `revoke_auth_session` で結び付いた1つのセッションだけを終わらせ、その試験は Task 9）。段3の計画の作る試験に1行、台帳に1行を残す
- **段3への申し送り（台帳に1行）**: 段3の「上げる時はやり直しと同じ」を、`user` からの昇格だけでなく、**期限切れ・無効になっていた店員の役割を再び有効にする時**にも当てる（役割が無効の間に、認めていない鍵でアプリから入ってお客さんとして結び付いたセッションが、役割が有効に戻った後に店員の入口を満たす隙を防ぐ）

- [ ] **Step 1: 文書を直す** — 上のとおり。ID は付いた順に確認
- [ ] **Step 2: 確かめ** — `npm.cmd run validate-docs`・`validate-trace`・`test:trace-coverage`。文書のリンクが通る
- [ ] **Step 3: コミット** — `docs(auth): 段1b の運用の手順を足し、「段1b の招待」の誤記を段3に直す`

### Task 12: 1b の全体の確かめ

**Files:** なし（確かめと記録だけ。台帳の状態欄と `db-migrations.md` に結果を書く）

- [ ] **Step 1: 手元を作り直す** — 調整役が3000番を止め、1行で知らせて `npx.cmd supabase db reset`。`npm.cmd run lint`・`typecheck`・`npm.cmd test`（単体）が通る
- [ ] **Step 2: DB 結合** — `auth_passkey_*`（1a の物を含む）と、`has_permission` を使う既存の DB 結合が全部通る。落ちた物は単独で流して切り分ける（1a の記録: `group_g3_cancel`・`unit-binding-refunds` は順序の汚れで既知）
- [ ] **Step 3: E2E（本番ビルド・3幅）** — 全件。1a の比べる元（`e2e-task11-full.json`）と比べ、**新しい赤が無く、skip は2本（FR-AUTH-005-AC-05）×3幅の分だけ減る**こと。赤は単独の再実行・他の幅・エラーの種類の順で切り分ける
- [ ] **Step 4: 追跡** — `validate-trace`・`test:trace-coverage`・`validate-docs`・`trace:report`
- [ ] **Step 5: 本番の道が止まっていることを確かめる** — `db-migrations.yml` に `push:` が無い（1a の試験が通る）。1b の移行 F が「段3まで当てない」一覧にある。push は調整役がオーナーの許可を得た時だけ
- [ ] **Step 6: 記録して報告する** — 台帳と `db-migrations.md` に結果を書く（コミットは作業の区切りで1つ）。**本番に当てない**。オーナーに結果と「調整役の判断」の2点（Google のお客さんは、パスキーを足す前にメールのコードで入り直す。お客さんの登録の窓口を1b で作った）を報告してから、段2の計画に進む

---

## セルフレビュー

**1. 設計書との対応（1b が持つ範囲）**

| 設計書 | タスク |
| --- | --- |
| 4-2 段1: パスキーのサーバーの窓口（登録の始め・終わり、ログインの始め・終わり、一覧・名前・削除） | 3・6・7・8 |
| 4-2・5-1: 始め (a)（`sb_secret_`＋`Sb-Forwarded-For`、IP が取れなければ断る、鍵の形の確認、アプリ側の IP ごとの回数、GoTrue の 429 の直し方） | 2・3 |
| 4-2・5-1・12-2 の5: 始め (b)（ブラウザから直に。設定で切り替え）と CSP の `connect-src` | 4（CSP は今の設定が足りることを試験で固定） |
| 5-1: 始めと終わりで呼び手が違っても終わりが通る | 6（E2E の (f)） |
| 5-3: UV の門（ログインの終わり。登録の終わり）、始めで `required` に書き換え | 2・3・4・6・7 |
| 5-5: 認めたパスキーの確かめ・登録の窓・入り直し（5分／10分） | 6・7 |
| 6-2: 登録の窓口は呼ばれるたびに窓を確かめ直す | 7 |
| 4-2: `PASSKEY_START_DEV_IP`（手元だけ・本番で値があれば起動を止める） | 2・11 |
| 4-2: `Sb-Forwarded-For` の運用の手順 | 11 |
| 4-2・5-2: フックが更新を拒否した時にアプリがセッションを終わらせるかの決め | 9（ADR-0466） |
| 4-2: `loginAsMember` が今も動く | 10 |
| 1a の計画の 1b 行: `aal` の判定（`return-intent-service.ts`・`oauth/callback`・`post-login`・`return-path.ts`・`confirm`） | 5 |
| 1a の持ち越し: 止めていた2本の試験、`passkey_approve` の古い行、失効の試験 | 10・1・11（失効の試験は段3） |
| 1a の文書の誤記（段1b の招待 → 段3） | 11 |

1b に入れない物: お客さんのログイン画面・メールのコードの流れ（段2）、招待・やり直し・無操作1時間・Google の拒否の画面・店長への知らせ（段3）、パスワード・TOTP を消すこと（段4）。1b の窓口は画面なしで、ソフトの認証器で直に呼んで試す（設計 9。1a と同じ）。

**2. 型・名前の一貫性:** `STAFF_PASSKEY_REQUIRED_MARKER`・`isStaffPasskeyRequiredError`（1a。Task 6・9 が使う）、`evaluateStaffEntry`・`approvedCountHint`（1a。Task 5 が使う）、DB の `passkey_is_staff`・`passkey_credential_is_approved`（`bytea`）・`passkey_approved_ids`・`passkey_approve`（Task 1）、`resolvePasskeyStartMode`（`passkey-start-mode.ts`）・`resolveStartSecretKey`・`resolvePasskeyStartDevIp`・`readAuthenticatorDataFlags`・`readAttestationUserVerified`（Task 2 が作り、Task 3・4・6・7 が使う）、`requestAuthenticationOptionsAsServer`・`registrationOptions`・`registrationVerify`・`listPasskeys`・`updatePasskey`・`deletePasskey`（Task 2 が作り、Task 3・7・8 が使う）、`evaluateRegistrationAccess`（Task 7）、`loginViaApp`・`startLoginViaApp`（Task 6 が作り、Task 7〜10 が使う）、`createWindowSessionActor`（Task 7 が作り、Task 9 が使う）、`passkey-approval-rpc.ts` の `isStaff`・`isCredentialApproved`・`approvedIds`・`approvedCount`・`approve`（Task 1 が作り、Task 6・7・8 が使う。RPC を直に呼ばない）、`passkey-start-mode.ts`（Task 2 が作り、Task 3・4 が読む）。窓口の応答の `challenge_id`・`options`・`expires_at` は GoTrue と同じ項目名（Task 3・4 が同じ形）。

**3. Review Focus:** 5行とも、Task 3・5・6・7・9 の試験に入れた。

**4. 実行順:** Task 1〜9 は、今のログインと試験を壊さず緑で終わる（今の画面は新しい窓口を呼ばない。Task 5 は呼び手の形の置き換えで、お客さんの動きは変わらない）。Task 1 は TS の部品に `@design DD-AUTH-050` を付けて追跡を満たし、Task 5 は自分の E2E（`FR-LOGIN-054`）で `FR-AUTH-018` の受け入れ条件を満たすので、`validate-trace` は各コミットで増えない。Task 10 は止めていた試験を作り直すだけ。Task 11 は文書だけ。Task 12 が全体の確かめ。

---

## 調整役の判断（設計 5-5／4-2 による）

オーナーに聞かず、設計書の文で決めた点。違えばオーナーが直す（設計 12 の判断の扱いと同じ）。

1. **Google（`oauth`）で入ったお客さんがパスキーを足せるか → 足せる。ただし、パスキーかメールのコードでの入り直し（10分以内）を求める**（設計 5-5）。Google だけで入った人は、足す前にメールのコードで入り直す。オーナーへの報告に1行だけ知らせる。
2. **お客さんのパスキー登録の窓口 → 1b で作る**（設計 4-2 の段1が「登録の始め・終わり」を店員に限らず挙げている。画面だけ段2）。

## オーナーに聞くこと

なし
