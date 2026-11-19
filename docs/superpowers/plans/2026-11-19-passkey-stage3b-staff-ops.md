# パスキー 段3b（店員の運用と本番に当てる準備）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 段3a が作った店員の流れを運用できる形にする。店長に「やり直し・招待・降格」の知らせを出し、死んだ知らせと worker の止まりを店へ知らせ、宛先が多い行の取りこぼしを直し、降格した店長が出した招待も止め、3a の持ち越し（画面・試験・文書）を片付け、**本番に当てる手順書と最初の店長の手順書**を書く。**本番には何も当てない。**

**Architecture:** (1) 未適用の移行 A・D・F・G・H は、段3a と同じく同じファイルのまま直す（MD5 が変わる）。(2) 新しい移行は1本だけ（I。`ops_job_heartbeats` の job の CHECK と、死んだ知らせの点検の関数）。パスキーの移行は **9本（A〜I）** になる。(3) 店長への知らせは、段2の送り手（同じ表・同じ worker）に新しい3種類 `staff_redo_issued`・`staff_invited`・`staff_demoted` を足す。(4) 3a の最終レビューの持ち越し（3b 行）は、領域ごとに4つの掃き出しタスク（18・19・20・22）に束ねる。(5) 手順書と最初の店長の手順書は、実際に当てる調整役が1本ずつ追える形で書く。

**Tech Stack:** Next.js App Router、`@supabase/supabase-js` 2.119.0（固定）、Postgres 17（手元の Supabase）、Jest、Playwright（本番ビルド・3幅）、`tsx`。

**Spec:** [docs/superpowers/specs/2026-11-07-passkey-auth-design.md](../specs/2026-11-07-passkey-auth-design.md)（4-2 の段3の行、6-2、8-1、8-2、10 の最後の行、3 と 12-2 のオーナーの決定）。前の計画は [段3a](2026-11-18-passkey-stage3-staff.md)（本書は、その末尾の「段3b（概要）」を、3a が実際に作った物に合わせて直した完全版）。3a の SDD の台帳 `.superpowers/sdd/2026-11-18-passkey-stage3-staff/progress.md`（「Final review」以降）、最終レビュー `final-review.md`（「Deferred-Minor triage」）、再レビュー `final-rereview.md`（F-3・F-4・nit）。作業と指摘の台帳 `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md` の 4-2「段3a の持ち越しの着地」。ブランドは `docs/01_Planning/brand.md`（CLAUDE.md の `docs/1_RequirementsDifinition/brand.md` は無い）。

## 分け方と番号

3a の Task 1〜12 の続きとして **Task 13〜25**（条件付きの 22b を含め14本）。3a の概要は Task 13〜18 を予定していたが、次の対応で組み直した。

| 3a の概要 | 本書 | 変えた理由 |
| --- | --- | --- |
| 13 店長への知らせ | 14（DB）・15（アプリ）・13（H の直し） | 種類を足すには A の CHECK と G の宛先の関数も直す。3a の概要はこれを見落としていた |
| 14 `dead` の点検・心拍・4人の取りこぼし | 16（取りこぼし）・17（点検と心拍。新しい移行 I） | 心拍は本番の既存の表の CHECK を変えるので、移行が要る |
| 15 E2E の `expect.poll` | 21 | そのまま |
| 16 手順書 | 23 | 移行 I を足し、戻し方の順に G・H・I を足した |
| 17 最後の手段の手順書 | 24 | そのまま |
| 18 最終の確かめ | 25 | baseline の扱いを足した |
| （無し） | 18・19・20・22 | 3a の最終レビューの 3b 行（約40）の掃き出し |

**番号が増えるので、実行者は最初に1つの文を読む**: 段3b も、本番の DB・設定・ダッシュボードに何も当てない。当てるのは調整役がオーナーの許可を得た時だけで、その手順を書くのが Task 23。

## 作り手の判断（違えばオーナーが直す。末尾の「オーナーに聞くこと」に重要な物を再掲）

1. **降格した店長の出した招待は、降格と同じ取引で取り消す**（オーナー決定 2026-11-19）。取り消す物は「その店長が出した、まだ使われていない招待（`cancelled_at`・`activated_at` が空）」。有効化済みの店員は触らない。種類（`invite`・`promote`・`redo`）では分けない（出した人の降格を単位にする）。`last_resort` は出した人がいない（`issued_by` が NULL）ので変わらない。招待の持ち主の登録の窓も閉じる。**対象は、アプリの中で店長の役割が止まる3つの道**: お客さんへの降格（`staff_demote`）、店長からサポーターへの変更（`admin_set_user_role`。サポーターは `admin.users.manage` を失うため）、店長へのやり直し（`staff_invite_issue_core`。やり直された店長は、登録し直すまで店長でなくなるため）。後ろの2つを含める読み方は、オーナーに確認する（質問2）。**対象外**: Supabase のダッシュボードでの利用者の削除・停止（アプリの外。`issued_by` に外部キーが無い）。手順書の残る危険に、手で取り消す SQL を書く（Task 23）。
2. **店長への知らせは3種類で、店長全員に出す**（設計 6-2 のやり直し＋招待・降格）。対象本人は宛先に入れない（本人には招待のメールが行く）。出した店長自身は入れる。
3. **宛先が多い行の取りこぼしの原因は `claim` ではなく `deliverRow` の期限**（3a の持ち越しの言い方は「claim が拾う行の後ろの宛先」）。実測では、worker の1回の予算（3秒）を1行の宛先の送りが共有するため、宛先が約4人を越えると行が毎回 `budget_exceeded` になり、後ろの宛先に届かないまま `dead` へ進む。直し方は Task 16。
4. **新しい移行 I は、`ops_job_heartbeats_job_check`（本番にある表。CHECK だけ）を変える**。パスキーの移行は9本になる（同じ文を G に入れて8本のままにもできる。質問3）。I は H の後・アプリのデプロイの前に当てる。無くても、点検は失敗を握って続けるので、アプリは止まらない。
5. **GoTrue を直に叩いた鍵の削除（2本の下限を越える）は、拒否の引き金を作らない**（おすすめ。オーナーの答えで変わる。Task 22b）。
6. **`scripts/trace/baseline.json` を、Task 25 の実測が baseline より小さい時だけ、その値に下げる**（今の実測は97。Task 25。調整役が、オーナーの許可で `validate-trace` の更新の道を流す）。
7. **実行する人は、新しい文面を最小にする**。新しい文は付録の物だけ。付録に無い文を足す時は、実行者が報告に書き、調整役がオーナーの確認の一覧に足す。
8. **黙って決めた物（受け入れる）**: カスケードは招待ごとの監査を書かず、招待の持ち主のログインも終わらせない（持ち主はお客さんの権限しか持たない）。止まりの閾値は30分。死んだ知らせのメールは店の既存の知らせの宛先へ。`actor_email` は outbox に持つ。1行の期限を延ばすので、点検が最大約20秒遅れることがある。店長とサポーターの入れ替えに知らせは出さない。

## Global Constraints

3a の決まりを全部引き継ぐ。全タスクの要件に含まれる。

**本番の安全（オーナー決定 2026-11-16・2026-11-19）**

- **段3b は本番の DB・設定・ダッシュボードに何も当てない**。Supabase の MCP（`apply_migration`・`execute_sql` ほか）はサブエージェントから使わない。`supabase db push`（どの形でも）と `workflow_dispatch` は流さない。`.env*` は読まない・表示しない。`graphify update` は流さない（コミットのフックが後で流す）。graphify を使う時は、起動が止められていれば `.venv/Scripts/python.exe -m graphify query "<質問>"`。
- パスキーの移行（今8本。段3b で移行 I を足して9本）は、**本番の独自のドメインが決まるまで当てない**（オーナー決定 2026-11-19）。当てるのは調整役だけで、オーナーの許可を得た時に、1本ずつ MCP の `apply_migration`。当てた後は `md5(statements[1])` をファイルの MD5 と突き合わせ、名前を当てた版に合わせる（Task 23 の手順書）。
- 未適用の A・D・F・G・H は、**同じファイルを直す**（大きさと MD5 を `md5sum`・`wc -c` で測り直し、`docs/06_Operations/db-migrations.md` を同じコミットで直す）。新しい移行は I だけ。移行の版は作る時の時刻で付け、最新（`20261118130000`）より後にする。
- master への push は調整役がオーナーの許可を得て行う（実行者は push しない）。

**リポジトリ・E2E**

- master で作業し、タスクごとに1コミット。**自分が作った物だけを名前で `git add`**（`git add -A` を使わない）。`.claude/CLAUDE.md`・`package.json`・`.superpowers/`・`.codex/`・`graphify-out`・stockist の差分（`PublicStockistGrid.tsx` ほか）は足さない・触れない。末尾に `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- E2E は本番ビルド（`next build && next start`）・390・768・1280 の3幅。dev サーバーでは流さない。`retries` を上げない。流す前に3000番のアプリを止める（`Get-NetTCPConnection -LocalPort 3000 -State Listen`）。**E2E の全件・push 前の確かめは調整役だけ**。手元の DB 結合は、実行者が1人ずつ `npx.cmd supabase db reset` の後に流してよい。
- E2E と DB 結合は手元の Supabase（`npm run db:start`・`npm run db:reset`）に対して流す（本番の住所・鍵・外へのメールは見張りが止める）。
- 試験を足す・名前を変えるタスクは `npm.cmd run trace:report` を流し、台帳の状態欄をそのタスクのコミットで直す。
- **段3b の後に `ops_job_heartbeats_job_check` を変える移行は、`passkey_notification_worker` を一覧に残す**（移行 I の前の確かめが、ずれで止まるため）。
- 落ちたら「単独の再実行 → 他の幅 → `goto` のタイムアウトかアサーションか」の順で切り分ける。全件の赤は、比べる元（3a の全体の確かめ `.superpowers/sdd/2026-11-18-passkey-stage3-staff/e2e-task12-full.json`。5745 passed。3a の最終の直しの後の push 前の実行は 5747 passed / 47 skipped なので、控えが残っていればそちらを使う）と比べる。
- モデル: 書き手は Sonnet、レビューは Opus（effort high）。

**追跡と文書（範囲内の領域 AUTH）**

- 要求・要件・受け入れ条件は `docs/02_Requirements/areas/auth.md`、基本設計は `docs/03_BasicDesign/areas/auth.md`、設計判断は `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md`、脅威は `docs/05_Quality/security/threats/auth.md`、処理の詳細は `docs/04_DetailDesign/sequence/auth-*.md`。コードには TSDoc の `@impl`・`@design`。書式は `documentation-guide` スキル。
- **追跡の鎖**: 公開した単位ごとに IMPL を1つ。DD の親は構造設計か SEC。SEC の親は THR。ADR には構造設計の子が要る。AC には E2E か単体の試験が要る。
- **文書と追跡は、そのタスクのコミットに入れる**。コミットの前に `npm.cmd run validate-trace`・`npm.cmd run test:trace-coverage`・`npm.cmd run validate-docs`。`validate-trace` は `scripts/trace/baseline.json`（今98）から増やさない（実測は97）。届かない分岐は `test-gaps.md` の節に書く。
- **番号の予約**（着手時に `grep` で空きを確かめる。2026-11-19 の実測の最大は SR-AUTH-028、FR-AUTH-046、API-AUTH-038、DD-AUTH-084、IMPL-AUTH-402、SEC-AUTH-057、THR-AUTH-055、DATA-AUTH-021、SCR-AUTH-016、ARC-AUTH-013、ADR-0472、FR-LOGIN-076。FR-LOGIN-071〜074 は空き。3a が予約して使わなかった IMPL-AUTH-343〜346 は使わない）:
  `SR-AUTH-029`、`FR-AUTH-047`〜`052`、`DD-AUTH-085`〜`092`（092 は予備）、`IMPL-AUTH-403`〜`430`、`SEC-AUTH-058`〜`059`、`THR-AUTH-056`〜`057`、`DATA-AUTH-022`、`ARC-AUTH-014`、`ADR-0473`〜`0474`、E2E は `e2e/FR-LOGIN-071`〜`074`（074 は予備。`075`・`076` は3a の関数の権限の試験で使用済み）。
- **親の決め**: `SR-AUTH-029`（店長への知らせ・死んだ知らせの点検・worker の心拍・宛先の取りこぼし）← `FR-AUTH-047`〜`049`。`FR-AUTH-050`（降格で出した招待を取り消す）・`FR-AUTH-051`（招待の取り消しの空振り）・`FR-AUTH-052`（店長の画面の直し）の親は既存の `SR-AUTH-026`。`THR-AUTH-056`（降格した店長の招待が残る）→ `SEC-AUTH-059` → `DD-AUTH-085`・`091`。`THR-AUTH-057`（知らせの欠落と worker の止まりに気づけない）→ `SEC-AUTH-058` → `DD-AUTH-086`・`087`・`088`・`089`。`DD-AUTH-090`（画面）の親は既存の `SCR-AUTH-016`。`ARC-AUTH-014`（知らせの点検の構成）← `ADR-0474`。`ADR-0473`（店長への知らせの種類と宛先）の構造設計の子は既存の `ARC-AUTH-012`（`ARC-AUTH-012` の「上位」に `ADR-0473` を足す）。
- 追跡の範囲: `scripts/trace/scope.json` の AUTH は `src/lib/auth/passkey-*.ts`・`staff-passkey*.ts` を拾う。新しい名前が外れる時は足し、足すたびに `validate-trace` と `test:trace-coverage` を流す。

**文面（店員・店長に見える物）**

- 丁寧語で短く、断定せず、煽らない。「頁」は使わず「ページ」。絵文字・感嘆符を使わない。専門語（WebAuthn・UV・認証器）を画面とメールに出さない。「パスキー」は一度「顔認証・指紋・PIN で入る方法」と言い換える。ブランドは `docs/01_Planning/brand.md`。
- **3a で作り手が決めた文面（下の「オーナーに聞くこと」の5）は、オーナーが答えるまで変えない**。直す必要がある時は実行者が止まって調整役に聞く。
- 監査・ログ・メールに、合言葉・リンクの全文・鍵・宛先のアドレスの列を残さない。

## Review Focus

先頭ほど起きやすい。

1. **降格した店長の招待が残らないか**: 降格と同じ取引で、その店長が出した未使用の招待が取り消され、窓が閉じ、有効化済みの店員・他の店長の招待・やり直しの招待は変わらないか。店長からサポーターへの変更・店長へのやり直しでも同じか。同時に「降格」と「招待の有効化」が競っても、有効化が先に取れたら店員は残り、後なら失敗するか（Task 13）
2. **店長への知らせが、本人・止まった人・消えた人に出ないか**: 宛先が有効な店長だけ（本人を除く・削除済み・停止中を除く・同じアドレスは1通）か。取引が失敗した時に知らせの行だけが残らないか。最後の手段（`last_resort`）に知らせを積まないか（Task 14・15）
3. **宛先が多い行が、予算を越えても取りこぼされないか**: 宛先6人以上の行が1回の実行で全員に送られ、予算を越える時は次の行を取らずに行が終わるか。再試行で同じ宛先に2通出ないか（Task 16）
4. **止まりに気づけるか**: `dead` の行が1時間に1回・まとめて1通で店に届き、同じ行が2度届かないか。worker が30分成功しない時に1通出るか。点検の失敗が worker 自体を止めないか。メールにアドレス・本文を入れないか（Task 17）
5. **手順書の順で当てたとき、途中で止まらずに戻せるか**: H は G の列に依存する（G が無いと実行時に落ちる）。戻し方は「cron とアプリを止める → フックの登録を外す → E → I → H → G → F → D → C → B → A」の1つの順で、I の心拍の行を先に消すか。E は最後で、E の前の確かめに必要な「認めた鍵が2本の店員」が最初の店長の登録で先に出来るか（Task 13・23・24）

---

## ファイルの全体図

| 区分 | ファイル | タスク |
| --- | --- | --- |
| 変える（未適用の移行を同じファイルで） | A `20261116215034_passkey_foundation_tables.sql`、D `20261117001500_...`、F `20261117123620_...`、G `20261118044338_...`、H `20261118130000_passkey_staff_invites.sql` | 13・14・19 |
| 作る | 移行 I `supabase/migrations/<時刻>_passkey_notification_ops.sql` | 17 |
| 変える | `src/lib/auth/passkey-notification-store.ts`・`passkey-notification-compose.ts`・`passkey-notification-worker.ts`、`src/lib/stripe/webhook-worker.ts` | 15・16・17 |
| 作る | `src/lib/auth/passkey-notification-ops.ts`、`ops-store.ts`・`ops-alert-mail.ts` の足し | 17 |
| 変える | `src/app/api/admin/staff/[id]/invite/cancel/route.ts`、`src/features/auth/staff/staff-invite-store.ts`、`UserSection.tsx` と `StaffRoleActions.tsx`・`RedoStaffDialog.tsx`、`StaffPasskeyManager.tsx`、`passkey-client.ts`、`StaffInviteScreen.tsx` | 13・18・19 |
| 作る・直す | `e2e/FR-LOGIN-071`〜`073`（074 は予備）、`e2e/order-email-test-utils.ts` の `mailsTo`・`mailBodies` | 13・15・18・21 |
| 作る | `docs/06_Operations/passkey-production-apply-runbook.md`、`passkey-staff-recovery.md` | 23・24 |
| 直す | `db-migrations.md`、`first-admin-bootstrap.md`、`supabase-auth-config.md`、台帳、`scripts/trace/baseline.json` | 各タスク・25 |

---

## Tasks

### Task 13: 移行 H の直し（降格が出した招待を取り消す・G の列の前の確かめ・取り消しの空振り）

**Files:**
- Modify: `supabase/migrations/20261118130000_passkey_staff_invites.sql`（H。未適用。大きさと MD5 を測り直す）
- Modify: `src/features/auth/staff/staff-invite-store.ts`（`cancelStaffInvite`）、`src/app/api/admin/staff/[id]/invite/cancel/route.ts`
- Create: `e2e/FR-LOGIN-073-staff-demote-cancels-issued-invites.spec.ts`
- Test: `tests/integration/db/auth_passkey_staff_roles.integration.test.ts`（降格・役割の変更）、`auth_passkey_staff_invites.integration.test.ts`（取り消し・前の確かめ）、`tests/unit/api/admin/staff/`（取り消しの窓口）
- 文書（同じコミット）: `db-migrations.md` の H の節（大きさ・MD5・前の確かめ・降格の説明・手元の `md5(statements[1])`）、`FR-AUTH-050`・`FR-AUTH-051`（親 `SR-AUTH-026`）、`THR-AUTH-056`→`SEC-AUTH-059`→`DD-AUTH-085`（降格）・`DD-AUTH-091`（取り消し）、既存の `API-AUTH-035`（降格が出した招待も取り消すことを足す）・`API-AUTH-036`（取り消しの応答 `{ success: true, cancelled }`）、`IMPL-AUTH-403`〜`405`

**Interfaces:**
- Consumes: 既存の `public.staff_demote(p_actor_id uuid, p_user_id uuid) returns void`、`private.admin_set_user_role(_actor_id uuid, _user_id uuid, _role_code text) returns jsonb`、`private.staff_invite_issue_core(...)`（`kind = 'redo'` を含む）、`public.staff_invite_cancel(p_actor_id uuid, p_user_id uuid)`、表 `private.staff_invites`（`issued_by`・`cancelled_at`・`activated_at`・`consumed_at`）、`private.passkey_registration_windows`（`closed_at`）。
- Produces:
  - **カスケード（共通の中身）**: `staff_demote` の本体の最後と、`private.admin_set_user_role` の本体で「対象が今、有効で期限内の `admin` の役割を持ち（`user_roles` を `active = false` にする前に読む）、新しい役割が `admin` でない」時（店長からサポーターへ）と、`staff_invite_issue_core` が店長の役割を止める時（`redo`。新しい招待の行を入れる前）に、`issued_by = p_user_id` で `cancelled_at IS NULL AND activated_at IS NULL` の招待をすべて `cancelled_at = now()` にし、その招待の持ち主（`user_id`）の `closed_at IS NULL` の窓を閉じる。新しい錠は取らない（`190519` を先に持っているので、`staff_role_activate`・`staff_invite_cancel` などと直列になる）。署名・戻りは変えない。**`admin_set_user_role` の置き換え前の `md5(prosrc)` の確かめ（`0cb9f532…`）は変えない**。店長→店長・サポーター→店長・お客さんの発行（持ち主が店長でない）は何も取り消さない。カスケードは招待ごとの監査を書かず、招待の持ち主のログインも終わらせない（DD-AUTH-085 に書く）。
  - `public.staff_invite_cancel(p_actor_id uuid, p_user_id uuid) returns boolean`（今は `void`）。**開いた招待を取り消したら `true`、取り消す物が無ければ `false`**。署名の引数・権限は変えない。
  - `cancelStaffInvite(deps, actorId, userId): Promise<StaffInviteResult<{ cancelled: boolean }, StaffInviteCancelReason>>`。
  - 取り消しの窓口と `StaffRoleActions`: `cancelled: false` の時は、ログインを終わらせず、監査は `outcome: 'noop'`、応答は `200 { success: true, cancelled: false }`（画面は通知なしで一覧を読み直す）。`true` の時だけ今までどおり `revokeAllSessionsForUser` を呼ぶ。
  - H の最初の確かめ（`DO` ブロック）に、`information_schema.columns` で `private.passkey_notification_outbox` の G が足した `lease_token`・`last_error_code`・`finished_at` の3列（`status` は A の列なので数えない）が在ることを足す。外れたら `PASSKEY_MIGRATION_PRECHECK_FAILED`、`DETAIL = 'passkey_h_g_columns'`。H のヘッダーの「BEFORE applying」に、`select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox' and column_name in ('lease_token','last_error_code','finished_at'); -- expect 3` と「H は G（`20261118044338`）の後」と書く。

- [ ] **Step 1: 失敗する試験を書く（DB 結合）** — (1) 店長 A が出した未使用の招待（`invite`）の持ち主 X の招待が、A の降格で `cancelled_at` を持ち、X の窓が閉じる。(2) A が出した、すでに使った（`consumed_at` あり・窓が開いている）招待も取り消され、窓が閉じる。(3) A が出した、有効化済み（`activated_at` あり）の店員 Y は役割も招待も変わらない。(4) 別の店長 B が出した招待は変わらない。(5) A が出した `redo` の相手 Z の招待も、A の降格で取り消される（種類で分けない）。 (6) `last_resort`（`issued_by` が NULL）は変わらない。(7) 降格が `LAST_ADMIN_REQUIRED` で失敗した時、何も取り消されない。(8) 降格と、A が出した招待の `staff_role_activate` を2つの接続で同時に流すと、一方が先に終わる: 有効化が先なら Y は店員のまま・後なら `STAFF_ACTIVATE_INVITE_INVALID`。(9) G の列の前の確かめ（列の名前を変えた取引で H の最初の `DO` ブロックを流すと `PASSKEY_MIGRATION_PRECHECK_FAILED` / `passkey_h_g_columns`。終わりに `ROLLBACK`）。(10) `staff_invite_cancel` は、開いた招待があれば `true`、無ければ `false`。(11) 店長 A を `admin_set_user_role` でサポーターに変えると、A が出した未使用の招待が取り消され、窓が閉じる。(12) サポーター→店長・店長→店長では何も取り消されない。(13) A に `redo` を出すと、A が出した未使用の招待が取り消され、窓が閉じる（A は登録し直すまで店長でない）。(14) お客さんへの `invite`・`promote` の発行では、何も取り消されない。
- [ ] **Step 2: 失敗する窓口の単体試験を書く** — `cancelled: false` の時、`revokeAllSessionsForUser` が呼ばれず、200 `{ success: true, cancelled: false }`、監査が `noop`。`true` の時は今までどおり。
- [ ] **Step 3: 失敗を確かめる** — `npx.cmd supabase db reset` の後、`npx.cmd jest --runInBand tests/integration/db/auth_passkey_staff_roles.integration.test.ts tests/integration/db/auth_passkey_staff_invites.integration.test.ts`（(1)(2)(5)(8)(9)(10)(11)(13) が FAIL）と単体（FAIL）。
- [ ] **Step 4: 実装する** — H の `staff_demote`・`admin_set_user_role`（ヘッダーの「ONE change」の要約に2つ目の変更を足す）・`staff_invite_issue_core`・`staff_invite_cancel`・最初の確かめ・ヘッダー（要約・`ROLLBACK`・`BEFORE applying`）を直す。`api-spec.md` の `PATCH /api/admin/users` の行（店長をサポーターに変えると、その人が出した招待も取り消す）と `auth-staff-invite.md` も直す。ストアと窓口を直す。`@impl`・`@design` を付ける。`db reset` で適用できること。
- [ ] **Step 5: 通ることを確かめる** — 上の試験が PASS。`FR-LOGIN-063`（店長の窓口）・`FR-LOGIN-070`（ユーザーの画面）を3幅 PASS。新しい E2E `FR-LOGIN-073`（3幅。FR-AUTH-050 の AC）: 店長 A が招待を出し、店長 B が A を降格すると、招待のリンクの POST が既存の「このリンクは使えません…」で断られる。**2つ目の場面**: B が A を `PATCH /api/admin/users` でサポーターに変えても同じ。**3つ目**: B が A にやり直しを出しても同じ。`wc -c`・`md5sum` で H を測り直し、`db-migrations.md` へ。`validate-trace`・`test:trace-coverage`・`validate-docs`。
- [ ] **Step 6: コミット** — `fix(auth): 店長でなくなる時（降格・サポーターへの変更・やり直し）に出した招待を同じ取引で取り消し、移行 H に G の列の前の確かめを足す`

### Task 14: 店長への知らせ（DB）— 種類・宛先・積み込み

**Files:**
- Modify: A `20261116215034_passkey_foundation_tables.sql`（`kind` の CHECK に3種を足す・列 `actor_email text`）、G `20261118044338_passkey_notification_sending.sql`（`claim` の戻りに `actor_email`・`passkey_notification_recipients` の宛先の規則）、H（`staff_invite_issue_core`・`staff_demote` が行を積む）。3本とも大きさと MD5 を測り直す
- Test: `tests/integration/db/auth_passkey_staff_manager_notices.integration.test.ts`（新規）、`auth_passkey_notification_worker.integration.test.ts`（足す）
- 文書: `db-migrations.md` の A・G・H、`DATA-AUTH-022`（列 `actor_email`・種類3つ）、`ADR-0473`（店長への知らせの種類と宛先。子 `ARC-AUTH-012`）、`DD-AUTH-086`（親 `SEC-AUTH-058`）、`SEC-AUTH-058`（親 `THR-AUTH-057`。このタスクで作る）、`THR-AUTH-057`、`IMPL-AUTH-406`〜`407`、`FR-AUTH-047`・`SR-AUTH-029`（このタスクで作る）

**Interfaces:**
- Consumes: `private.passkey_notification_outbox`（A）、`claim_passkey_notification`・`passkey_notification_recipients`（G）、`staff_invite_issue_core`・`staff_demote`（H）。
- Produces:
  - `kind` に `'staff_redo_issued'`・`'staff_invited'`・`'staff_demoted'` を許す。列 `actor_email text`（NULL 可）を足す。
  - `claim_passkey_notification` の `RETURNS TABLE` の最後に `actor_email text` を足す（`subject_email` の次ではなく**末尾**）。
  - `passkey_notification_recipients(_id)`: 新しい3種類の行は、**本人（`user_id`）を除く、有効・期限内・削除と停止の無い `admin` 全員**（アドレスの小文字の重複は1通）。`notify_subject` は常に偽として扱い、本人は入れない。古い3種類の規則は今のまま。戻りの列は変えない。
  - 積み込み（同じ取引の中）: `staff_invite_issue_core` が、`p_kind = 'redo'` なら `staff_redo_issued`、`'invite'`・`'promote'` なら `staff_invited` を1行入れる。**`last_resort` は積まない**。`staff_demote` が `staff_demoted` を1行入れる。値は `user_id = 対象`、`subject_email = 対象のアドレス`、`actor_email = 操作した店長のアドレス`、`passkey_id`・`friendly_name` は NULL、`subject_is_staff` は redo・demoted が `true`・invited が `false`、`notify_subject = false`。取引が失敗すれば行も残らない。

- [ ] **Step 1: 失敗する試験を書く** — (1) `redo` で `staff_redo_issued` が1行できる（`actor_email` が発行した店長のアドレス・`subject_email` が対象）。`invite`・`promote` は `staff_invited`、降格は `staff_demoted`。(2) `staff_invite_issue_manual`（`last_resort`）は行を積まない。(3) 発行が `LAST_ADMIN_REQUIRED`・`SELF_ROLE_CHANGE_FORBIDDEN` で失敗した時、新しい種類の行が残らない。(4) `passkey_notification_recipients` は、本人を除く有効な店長を返す。停止中（`banned_until` が将来）・削除済み・期限切れの役割・メールが空・同じアドレスの大文字違いの2人目は返さない。(5) `claim` の戻りに `actor_email` がある。(6) 古い種類の宛先の規則が変わらない（既存の試験が緑）。(7) 発行が消した鍵の `passkey_removed` が `skipped` になる既存の挙動（`staff_invite_issue`）が変わらない。
- [ ] **Step 2: 失敗を確かめる** — `db reset` の後、上の DB 結合 → FAIL。
- [ ] **Step 3: 実装する** — A・G・H を直す（各ファイルのヘッダーの要約・`ROLLBACK`・末尾の確かめに足す）。G の `PASSKEY_G_FINAL_ASSERT` に `actor_email` の列と新しい種類の CHECK を足す。`db reset` で適用できること。
- [ ] **Step 4: 通ることを確かめる** — 上の試験と `auth_passkey_*` の DB 結合が全部 PASS。A・G・H を測り直して `db-migrations.md` へ（A・G・H の節）。`validate-trace` ほか。
- [ ] **Step 5: コミット** — `feat(auth): 店長への知らせ（やり直し・招待・降格）の種類と宛先と積み込みを移行 A・G・H に足す（手元だけ）`

### Task 15: 店長への知らせ（アプリ）— 文面・worker・E2E

**Files:**
- Modify: `src/lib/auth/passkey-notification-store.ts`（`KINDS`・`ClaimedPasskeyNotification.kind`・`actorEmail`・`parseClaimed`）、`passkey-notification-compose.ts`、`passkey-notification-worker.ts`（`actorEmail` を文面へ渡す）
- Create: `e2e/FR-LOGIN-071-staff-manager-notice-mail.spec.ts`
- Test: `tests/unit/lib/auth/passkey-notification-{store,compose,worker}.test.ts`（足す）、`tests/integration/db/auth_passkey_notification_worker.integration.test.ts`
- 文書: `FR-AUTH-047` の AC、`DD-AUTH-087`（親 `SEC-AUTH-058`）、`docs/04_DetailDesign/sequence/auth-passkey-notifications.md`、`IMPL-AUTH-408`〜`411`

**Interfaces:**
- Consumes: Task 14 の `kind` 3種・`actor_email`。
- Produces:
  - `ClaimedPasskeyNotification` の `kind` は `'passkey_added' | 'passkey_removed' | 'passkey_key_replaced' | 'staff_redo_issued' | 'staff_invited' | 'staff_demoted'`。`actorEmail: string | null` を足す。**知らない種類の行は、`parseClaimed` が `{ id: string; leaseToken: string; kind: null }` を返す形（型 `UnknownKindClaim`）で渡し、worker が `skip`（`unknown_kind`）する**。（`parseClaimed` は文字列か `null` だけを通し、それ以外は `undefined`）。
  - `composePasskeyNotification(input)` の `input` に `actorEmail: string | null` を足す。新しい3種類は **`admin` の宛先だけ**（他の宛先なら例外 → worker が `compose_error`）。文面は付録のとおり。`名前:` の行は出さず、`日時:`（日本時間）と `操作した店長:`（`actorEmail`）を出す。アドレスは本文にだけ入れ、件名と監査には入れない。
  - 冪等の鍵・再試行・`dead` は段2の規則のまま。

- [ ] **Step 1: 失敗する試験を書く** — 単体: (a) 新しい3種類を `parseClaimed` が通す。**知らない種類は、`id` と `leaseToken` だけ読み、worker が行を `skip`（`unknown_kind`）する**（アプリと DB の版がずれても、行が担当の期限まで列を止めない）。(b) 3種類の件名・本文が付録と同じで、`admin` 以外の宛先は例外。(c) `actorEmail` が `null` の時も文面が作れる（`操作した店長:` の行を出さない）。(d) 件名に対象のアドレスが入らない。E2E `FR-LOGIN-071`（3幅。`FR-LOGIN-063` と同じ API の形）: 店長2人（A・B）を `provisionStaff` で作り、A が店員 X へ `redo` を出すと、**B に件名「店員のパスキーのやり直しが出されました」のメールが1通届き、X には届かない（X への招待のメールは別の件名で届く）**。`staff_invited`（招待）の場面も1つ足す。降格の E2E は、B に「店員がお客さんに戻されました」が届く。待ちは `expect.poll`。
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/lib/auth/passkey-notification-*.test.ts` → FAIL。E2E は実装の後に流す。
- [ ] **Step 3: 実装する** — 上の型と文面。worker は、行の `kind` が新しい種類の時、宛先ごとの `audience` が `admin` であることを確かめて渡す（`composePasskeyNotification` の例外を `compose_error` に任せる）。
- [ ] **Step 4: 通ることを確かめる** — 単体と DB 結合 PASS。3000番を止め、`npx.cmd playwright test e2e/FR-LOGIN-071 e2e/FR-LOGIN-062` を3幅 PASS（062 は既存の知らせの回帰）。`validate-trace` ほか。
- [ ] **Step 5: コミット** — `feat(auth): 店長に、店員のやり直し・招待・降格の知らせを出す`

### Task 16: 宛先が多い行の取りこぼしを直す（worker の1行の期限）

**Files:**
- Modify: `src/lib/auth/passkey-notification-worker.ts`、`src/lib/stripe/webhook-worker.ts`（渡す期限）
- Test: `tests/unit/lib/auth/passkey-notification-worker.test.ts`、`tests/unit/lib/stripe/webhook-worker.test.ts`
- 文書: `FR-AUTH-048`（親 `SR-AUTH-029`）、`DD-AUTH-088`（親 `SEC-AUTH-058`）、`auth-passkey-notifications.md`、`IMPL-AUTH-412`

**Interfaces:**
- Consumes: 既存の `runPasskeyNotificationWorker(options: { budgetMs?: number; maxRows?: number; deps?: Partial<PasskeyNotificationWorkerDeps> })`。
- Produces: `options.rowBudgetMs?: number`（既定は `PASSKEY_NOTIFICATION_ROW_BUDGET_MS = 20_000`）を足す。**新しい行を取る時刻の上限は今までの `budgetMs`（3秒）のまま**、取った行の宛先の送りは `min(行を取った時刻 + rowBudgetMs, hardDeadlineMs)` までを許す。`options.hardDeadlineMs?: number`（絶対の時刻）を足し、`webhook-worker.ts` は `startedAt + 45_000` を渡す（60秒の入口に15秒の余裕を残す。相対の上限だと遅く取った行が余裕を食う）。1行の延長の分、点検（`runOpsChecks`）が最大約20秒遅れることがある。担当の期限（`PASSKEY_NOTIFICATION_LEASE_SECONDS = 300`）より小さい。

- [ ] **Step 1: 失敗する試験を書く（偽の時計）** — (1) 宛先6人・1通が1000msかかる行（予算3000ms）が、1回の実行で `sent`、`send` が6回、`claimed` が1。(2) その実行で、3秒を過ぎた後に次の行は取らない（`stopped: 'budget'`、`claimed` が1）。(3) 1通が10秒かかり宛先が3人（20秒を越える）の行は `retried`（`budget_exceeded`）で、後ろの宛先へは送らない。(4) 再試行の時の冪等の鍵が、1回目と同じ（`passkeyNotificationIdempotencyKey` が変わらない）。(5) `webhook-worker` が `hardDeadlineMs = startedAt + 45_000` を渡し、遅く取った行は `hardDeadlineMs` で止まる（`budget_exceeded`）。
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/lib/auth/passkey-notification-worker.test.ts tests/unit/lib/stripe/webhook-worker.test.ts` → (1)(5) が FAIL。
- [ ] **Step 3: 実装する** — `deliverRow` の `deadline` を、行ごとの期限（`min(rowStartedAt + rowBudgetMs, hardDeadlineMs)`）に替える。実行全体の `deadline` は、行を取る前の判定だけに使う。定数 `PASSKEY_NOTIFICATION_ROW_BUDGET_MS` を公開する。
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS・`FR-LOGIN-062` を3幅 PASS。`validate-trace` ほか。
- [ ] **Step 5: コミット** — `fix(auth): 宛先が多い知らせの行が、worker の予算で後ろの宛先を取りこぼさないようにする`

### Task 17: 死んだ知らせの点検と worker の心拍（新しい移行 I）

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_notification_ops.sql`（I）、`src/lib/auth/passkey-notification-ops.ts`
- Modify: `src/lib/ops/ops-store.ts`（`OpsJob`・`OpsAlertKey`・`OpsRpcName`）、`src/lib/ops/ops-alert-mail.ts`（`staleJobMail` の名前の対応・死んだ知らせのメール）、`src/lib/stripe/webhook-worker.ts`
- Test: `tests/integration/db/auth_passkey_notification_ops.integration.test.ts`、`tests/unit/lib/auth/passkey-notification-ops.test.ts`、`tests/unit/lib/ops/ops-alert-mail.test.ts`、`tests/unit/lib/stripe/webhook-worker.test.ts`
- 文書: `db-migrations.md`（I の節と、「9本」への直し）、`ADR-0474`（子 `ARC-AUTH-014`）、`ARC-AUTH-014`・`DD-AUTH-089`（親 `SEC-AUTH-058`）、`db-migrations.md` の I の節に「この後 `ops_job_heartbeats_job_check` を変える移行は `passkey_notification_worker` を残す」と書く、`FR-AUTH-049`、`DATA-AUTH-022` に列 `dead_notified_at` を足す、`IMPL-AUTH-413`〜`420`

**Interfaces:**
- Consumes: 既存の `OpsCheckDeps`・`sendOnce`（`ops-checks.ts`）、`staleJobMail`、`recordHeartbeat`・`readHeartbeats`（`ops-store.ts`）、注文のメールの点検（`src/lib/orders/email/order-email-ops.ts` の形に合わせる）、`public.get_ops_heartbeats`・`record_ops_heartbeat`。
- Produces:
  - 移行 I（`BEGIN`/`COMMIT`・前の確かめ・末尾の確かめ・ヘッダーに `ROLLBACK`。`SECURITY DEFINER`・`search_path` 空・持ち主 `postgres`・`service_role` だけ）:
    1. 前の確かめ: `public.ops_job_heartbeats`・`private.passkey_notification_outbox`（`status`・`finished_at`・`last_error_code`）が在ること、`ops_job_heartbeats_job_check` の job の**集合**（定義の文字列ではなく、`regexp_matches` で取り出した名前を並べ替えた配列）が、(a) 既知の8つ（`accounting_post` まで）で `passkey_notification_worker` を含まない、または (b) すでに `passkey_notification_worker` を含む、のどちらかであること。(b) は CHECK を触らず NOTICE（3. と 4. は続ける）。それ以外（本番が別の job を足した等）は `PASSKEY_MIGRATION_PRECHECK_FAILED`、`DETAIL = 'passkey_i_job_check_drift'`。
    2. (a) の時だけ、`ops_job_heartbeats_job_check` を、既存の8つに `'passkey_notification_worker'` を足した形で作り直す。
    - **ROLLBACK（ヘッダーに書く。1つの取引）**: 先に `DELETE FROM public.ops_job_heartbeats WHERE job = 'passkey_notification_worker';`（消さずに戻すと失敗する）→ CHECK を、**I の前にあった job の一覧（I が足した `passkey_notification_worker` を除いた今の一覧）に戻す**（固定の8つにしない）→ 関数2本・索引・列 `dead_notified_at` を落とす。
    - 試験: 前の確かめの (a)・(b)（(b) で止まらない）・ずれ（別の job が入っている。ここだけ止まる）の3つ。
    3. 列 `dead_notified_at timestamptz`（NULL 可）と、部分索引（`status = 'dead' AND dead_notified_at IS NULL`）。
    4. `public.list_unnotified_dead_passkey_notifications(_limit integer) returns table (id uuid, kind text, attempts integer, last_error_code text, finished_at timestamptz, total bigint)`（`finished_at` の古い順。`total` は点検待ちの全件）。`public.mark_passkey_notification_dead_notified(_ids uuid[]) returns integer`（`status = 'dead'` の行だけ。2度目は0）。アドレス・本文の列を返さない。
  - アプリ: `OpsJob` に `'passkey_notification_worker'`。`OpsAlertKey` に `'passkey_notification_dead'`・`'job_stale_passkey_notification_worker'`。`runPasskeyNotificationOpsChecks(deps: OpsCheckDeps): Promise<{ deadNotified: number; staleAlerted: boolean; failedChecks: Array<'dead' | 'stale'> }>`: (1) `dead` を50件まで読み、`sendOnce(deps, 'passkey_notification_dead', mail)` が送れたら `mark…` を呼ぶ（印付けの失敗は次の点検で再送。at-least-once）。(2) `readHeartbeats` の `passkey_notification_worker.lastSucceededAt` が**30分**以上前なら `sendOnce(deps, 'job_stale_passkey_notification_worker', staleJobMail(...))`。一度も成功していなければ対象にしない。一方が失敗しても他方を続ける。
  - `webhook-worker.ts`: `options.passkeyNotifications` の時だけ、worker の結果で心拍を書く。`stopped` が `'idle'`・`'budget'` なら成功、`'claim_error'` か例外なら失敗（`db_unavailable`・`worker_error`）、`'disabled'`・`'config'` は書かない。`runOrderEmailOpsChecks` の次に `runPasskeyNotificationOpsChecks` を呼び、結果に `passkeyChecks` を足す。心拍・点検の例外は握って、worker を止めない。
  - メール（付録）: 宛先は既存の店の知らせの宛先（`sendOpsAlertMail`）。件数・種類・失敗コード・時刻だけで、アドレスと本文を入れない。

- [ ] **Step 1: 失敗する試験を書く** — DB 結合: 新しい job の心拍が書ける（CHECK を通る）。`list` は `dead` で `dead_notified_at IS NULL` の行だけを古い順に返し、`total` が全件。`mark` は2度目に0を返す。`pending` の行は `mark` で変わらない。権限は `service_role` だけ（`anon`・`authenticated` は不可）。前の確かめの偽の試験（CHECK の定義が違えば止まる）。単体: (a) `dead` が0件なら送らない・1件以上でまとめて1通・送れたら `mark`。(b) 送れなかった時は `mark` を呼ばない。(c) `mark` が失敗しても例外を出さず `failedChecks` に `'dead'`。(d) 心拍が30分以内なら送らない・31分前なら1通・一度も成功が無ければ送らない。(e) 同じ点検が1時間に2回通っても1通（`sendOnce` の冷却）。(f) メールの本文にアドレスの形（`@`）が入らない。(g) `webhook-worker`: `stopped: 'idle'` で成功の心拍・`'claim_error'` で失敗・`'config'` で書かない・心拍の書き込みが例外でも worker が結果を返す・`passkeyNotifications` が偽の時は心拍も点検も無い。
- [ ] **Step 2: 失敗を確かめる** — `db reset` の後、DB 結合と単体 → FAIL。
- [ ] **Step 3: 実装する** — I と上のアプリ。I の前の確かめ・末尾の確かめを他の移行と同じ形（`DETAIL` が項目名）で書く。
- [ ] **Step 4: 通ることを確かめる** — 上の試験 PASS。`webhook-worker` を呼ぶ既存の単体・`tests/unit/api/cron/process-stripe-webhooks-route.test.ts` が緑。I の大きさと MD5 を測り、`db-migrations.md` へ。`validate-trace` ほか。
- [ ] **Step 5: コミット** — `feat(auth): 死んだ知らせの点検と知らせの worker の心拍を足す（移行 I。手元だけ）`

### Task 18: 店長・店員の画面の直し（持ち越し: F-3・F-4・Task 11 の UX）

**Files:**
- Modify: `src/features/auth/staff/components/RedoStaffDialog.tsx`・`StaffRoleActions.tsx`・`InviteStaffDialog.tsx`、`src/components/UserSection.tsx`（差し込むだけ。`@impl` を足さない）、`src/features/auth/staff/components/StaffPasskeyManager.tsx`、`src/lib/auth/passkey-client.ts`
- Create: `e2e/FR-LOGIN-072-admin-users-staff-recovery.spec.ts`
- Test: 既存の単体（`tests/unit/features/auth/staff/`・`auth-staff-passkey-manage-screen.test.tsx`・`passkey-client` の試験）を足す
- 文書: `FR-AUTH-052`（親 `SR-AUTH-026`）、`DD-AUTH-090`（親 `SCR-AUTH-016`）、`SCR-AUTH-016` の直し、`auth-staff-users-screen.md`・`auth-staff-passkey-manage.md`、`IMPL-AUTH-421`〜`424`

**Interfaces:**
- Consumes: 既存の `passkey-client.ts` の `manageFailure`（409・500・投げた fetch が `'failed'`）。
- Produces: 閉じる行は次の表で、**行ごとに1つの試験**を足す（「閉じる行」を終わりに列挙する）。

| 行 | 直し |
| --- | --- |
| F-3（再レビュー） | やり直しのメールが送れなかった（`mail_failed`）時、ダイアログを**閉じて一覧を読み直す**。その行は「招待中」と役割の欄になる。ページの通知に、既存の文「メールを送れませんでした。もう一度、招待を出してください。」を出す（新しい文は作らない） |
| F-4（再レビュー） | `passkey-client.ts` の管理の失敗の理由に `'min_keys'`（409 `staff_min_keys`）を足し、`'failed'`（500・投げた fetch）と分ける。管理の画面は `'min_keys'` に今の下限の文、`'failed'` に付録の「削除できませんでした。もう一度お試しください。」を出す |
| T11 M-2 | 「招待しました」の通知は、サーバーの応答（`invited: true`）に従う。クライアントの旗に従わない |
| T11 M-3 | 上げる時の確認の文に、上げる先の役割の名前（店長／サポーター）を入れる |
| T11 M-5 | やり直し・降格が成功した後、フォーカスを一覧の見出し（`tabIndex={-1}`）へ戻す（`body` に落とさない） |
| T11 M-6 | 一覧が「0本」を表示する試験を足す（表示の試験だけ） |
| T11 M-7 | エラーが出た時に、前の成功の通知を消す。「招待を取り消す」に確認を足す（付録の文） |

- [ ] **Step 1: 失敗する試験を書く** — 上の表の各行を1つずつ。F-4 は、500 の削除で下限の文が出ず付録の文が出る・409 `staff_min_keys` で下限の文が出る。F-3 は、`mail_failed` でダイアログが閉じ、一覧が読み直され、通知が出る。E2E `FR-LOGIN-072`（3幅）: 店長が店員にやり直しを出し、`page.route` の中で `await route.fetch()` で本物の窓口に送り（発行は本当に起き、メールは Mailpit に届く）、応答だけを `route.fulfill` で `mail_failed` の形（`src/features/auth/staff/staff-invite-http.ts` の本物の本文の形を写す。状態は502）に替える。そして、ダイアログが閉じ・行が「招待中」になり・役割の欄が見え・通知に既存の文が出ることを確かめる。取り消しに確認が出て、取り消すと行が戻る。
- [ ] **Step 2: 失敗を確かめる** — 単体 → FAIL。
- [ ] **Step 3: 実装する** — 上の表のとおり。
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS。`FR-LOGIN-068`・`FR-LOGIN-070`・`FR-ADMIN-108`・`FR-LOGIN-072` を3幅 PASS。`validate-trace` ほか。**閉じる行**: 3a の最終レビューの T11 M-2・M-3・M-5・M-6・M-7、再レビューの F-3・F-4。
- [ ] **Step 5: コミット** — `fix(auth): 店長の画面と店員のパスキーの画面の持ち越しの直し（やり直しのメールの失敗・削除の失敗の文・確認・フォーカス）`

### Task 19: サーバー・DB の小さい直しの掃き出し

**Files:**
- Modify: `src/app/api/admin/staff/invites/route.ts`、`src/app/api/auth/staff/invite/start/route.ts`、`src/app/api/auth/oauth/callback/route.ts`、`src/lib/auth/staff-passkey-idle-rpc.ts`、`src/features/auth/staff/components/StaffInviteScreen.tsx`、移行 D `20261117001500_...`、移行 F `20261117123620_...`（どちらも未適用。大きさと MD5 を測り直す）
- Test: 該当する単体・DB 結合（下の表の行ごと）
- 文書: `db-migrations.md` の D・F、`IMPL-AUTH-425`〜`426`

**Interfaces（行ごと。閉じる行を左に書く）:**

| 行 | 直し |
| --- | --- |
| T5 M-1 | 招待の窓口で、メールの設定の確かめ（`checkSiteUrlForEmail`・送り元）を `createUser` より前に移す。壊れていれば 503 で、アカウントを作らない（試験: `createUser` が呼ばれない） |
| T6 M-6 | `invite/start` で、失敗した失効（`revokeAllSessionsForUser`）を監査に残す（`detail: 'session_revoke_failed'`。合言葉・トークンを入れない） |
| T10 M-4 | `oauth/callback` の、戻りの URL の `error_description` から見分けた拒否（:89 付近。偽装できる）は `detail: 'staff_passkey_required_url'` を書き、交換の失敗で見分けた本物の拒否（:136 付近）は今の `staff_passkey_required` のまま。単体の試験で2つの値が違うことを固定する（`/login` の画面は監査を書かない） |
| T3 M-1 | D の `staff_session_touch`（の core）は、`auth.sessions` にその `session_id` の行があり、その `user_id` が `p_user_id` と違うなら何も書かず偽を返す（行が無い時は今までどおり書く）。DB 結合の試験 |
| T1 M-5 | F の最後の確かめに、`passkey_approve` の本体が `'passkey_approve:'` を含み `PASSKEY_REAUTH_NOT_ALLOWED` を含むことを足す |
| T1 M-4 | F のヘッダーに「GoTrue を直に叩く削除は、この関数の錠を取らない」と書く（本番の残る危険として手順書にも書く。Task 23） |
| 再レビュー N-1 | `staff-passkey-idle-rpc.ts:3` の型の注釈を、呼び手は 503 か「しばらくしてから」を返す、に直す |
| 再レビュー N-2 | `StaffInviteScreen.tsx` の `redirectTo` の確かめを、`new URL(to, location.origin).origin === location.origin` で比べる形にする（`"/\t/evil"` も断る試験） |

- [ ] **Step 1: 失敗する試験を書く** — 上の表の試験を1行ずつ（T1 M-4・N-1 は文だけなので試験なし）。
- [ ] **Step 2: 失敗を確かめる** — 単体と DB 結合 → FAIL。
- [ ] **Step 3: 実装する** — 上の表のとおり。D・F は同じファイルを直し、`db reset` で適用できること。
- [ ] **Step 4: 通ることを確かめる** — 各試験 PASS。`auth_passkey_staff_idle*`・`auth_passkey_server_fns` の DB 結合が緑。`FR-LOGIN-064`・`FR-LOGIN-069`・`FR-LOGIN-067` を3幅 PASS。D・F を測り直して `db-migrations.md`。`validate-trace` ほか。
- [ ] **Step 5: コミット** — `fix(auth): 招待の窓口・失効の監査・無操作の書き込みの持ち主・移行 D と F の小さい直し`

### Task 20: 試験の掃き出し（試験だけを足す・直す）

**Files:** 既存の試験の足し・直し（コードは触らない。触る必要が出たら止まって調整役へ）。
**Interfaces（閉じる行と足す試験。行ごとに1つ）:**

| 行 | 足す・直す試験 |
| --- | --- |
| T1 M-1 | F の `reauth` の試験(a)に「鍵の行が増えていない」の確かめ |
| T1 M-2 | `script` の枝が0本の店員でも通る試験 |
| T1 M-3 | 錠の試験が「待たされた」ことを確かめる（別の接続が錠を持っている間、承認が完了しない） |
| T2 M-1 | 移行 C の静的な試験に `window` の枝 |
| T2b M-4 | `passkey_delete_with_floor` が、消した鍵の `passkey_removed` の知らせを積む試験 |
| T5 M-6 | 使っていない pwned-password のモックを消す |
| T6 M-4 | `FR-LOGIN-064` に、招待の POST で結ばれた `session_id` がそのブラウザの物であることの確かめ |
| T6b M-3 | `FR-LOGIN-065` AC-02 に別のセッションの場合 |
| T6b m-2 | お客さんの試験に否定の確かめ（窓が無い人は `window` で認められない） |
| T7 M-2 | `FR-LOGIN-066` AC-08 を「ちょうど1行」に |
| T7 N-1 | `FR-LOGIN-066` の使わない `totp` の選択肢と古いヘッダーを消す |
| T8 N-7 | 無操作が、後から来る session-expired の後も残る単体の試験 |
| T9 M-6 | 無限の回りの単体の試験が、2回目の遷移が起きないことまで確かめる |
| T10 M-5 | `FR-LOGIN-032` が 410 を期待する形に戻す（広げた状態の集合をやめる） |
| T12 M-6 | `FR-ADMIN-MISC-001` の create-user の残り（ヘッダー・使われなくなった `createEmail`・`created_users`）を消す |

- [ ] **Step 1: 各行の試験を足す・直す** — 上の表の順。足した試験は、実装を一時的に壊して赤くなることを1回確かめてから戻す（意味のある試験にするため）。
- [ ] **Step 2: 流す** — 触った単体・DB 結合は `db reset` の後に、触った E2E（FR-LOGIN-032・064・065・066・FR-ADMIN-MISC-001）は3幅で PASS。
- [ ] **Step 3: 追跡** — `validate-trace`・`test:trace-coverage`・`validate-docs`。試験名の先頭の ID が変わる行は `npm.cmd run trace:report`。
- [ ] **Step 4: コミット** — `test(auth): 段3a の最終レビューの持ち越しの試験を足す・直す`

### Task 21: E2E のメールの待ちを `expect.poll` に直す

**Files:**
- Modify: `e2e/order-email-test-utils.ts`（`mailsTo`・`mailBodies`）、`e2e/FR-LOGIN-067-staff-idle-timeout.spec.ts`（T8 N-6）、`e2e/FR-LOGIN-062-passkey-notification-mail.spec.ts`
- Test: 同じ E2E

**Interfaces:**
- Consumes: 既存の `mailsTo(request, email)`・`mailBodies(request, email, subjectIncludes = '')`。
- Produces: 呼ぶ側が書いている手書きの待ち（`waitForTimeout`・ループ）を、`expect.poll(() => ..., { timeout: 15_000 }).toBeGreaterThan(0)` の形の共通の手助け `waitForMail(request, email, subjectIncludes): Promise<MailBody[]>` に集める。`FR-LOGIN-067` の `networkidle` の待ちは、待つ応答（`kpi`・`order-attention`）を名指しする待ち（`page.waitForResponse`）に替える。

- [ ] **Step 1: 失敗の再現を確かめる** — 3a の全体の確かめの JSON（`e2e-task12-full.json`）で、`FR-LOGIN-062` の揺れ3件・`FR-LOGIN-067` の揺れを控える。
- [ ] **Step 2: 実装する** — 手助けを足し、`FR-LOGIN-062`・`063`・`067`・`071` の手書きの待ちを置き換える。
- [ ] **Step 3: 流す** — 3000番を止め、`npx.cmd playwright test e2e/FR-LOGIN-062 e2e/FR-LOGIN-063 e2e/FR-LOGIN-067 e2e/FR-LOGIN-071` を**3回続けて**3幅 PASS（`retries` は上げない）。
- [ ] **Step 4: コミット** — `test(auth): E2E のメールの待ちを expect.poll にそろえ、無操作の試験の待ちを名指しにする`

### Task 22: 文書・追跡の文の掃き出し

**Files:** 下の表の文書とコードの注釈（コードの動きは変えない）。
**Interfaces（閉じる行と直す文。行ごと）:**

| 行 | 直す文 |
| --- | --- |
| T1 M-6 | 「reauth は0本を断る」を、2つの文書（`auth-passkey-server-endpoints.md` と `auth.md` の該当の AC）に |
| T2 M-4 | `db-migrations.md` の先頭の確認日の行を、段3a・3b の確認日に |
| T2 M-5・T2b M-3 | 3a の計画の番号の予約の行に `FR-LOGIN-075`・`076` を足す（実測の使用済み） |
| T3 M-3 | D・E のヘッダー・文書の古い行（3a の最終の直しに合わせる） |
| T6 M-7 | `auth-staff-invite.md` の先頭のヘッダー |
| T6b M-1 | 登録の窓口の docblock と `@design DD-AUTH-079` に、招待の道を書く |
| T7 N-2 | `endAuthSession` の呼び手の一覧を直す |
| T8 N-4 | `client-fetch.ts` の位置のずれたコメントを直す |
| T8 N-5 | `DD-AUTH-081` に、再生した応答の時の無操作の扱いを書く |
| T9 M-1 | `DD-AUTH-082` の GoTrue の路を `DELETE /auth/v1/passkeys/{id}` に |
| T9 M-2 | 古い削除の設計の文（`auth-passkey-server-endpoints.md` の該当・`auth.md` の FR-AUTH-021）を、削除は下限を DB の関数で守る形に |
| T9 M-3 | `auth/verified/page.tsx` の `@design` に `DD-AUTH-082` |
| T9 M-7 | AC-05 の注の試験名 |
| T9 M-8 | `docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md` に `/staff/invite`・`/staff/register` の行 |
| T10 M-1 | 変えた窓口・画面の `@design` に `DD-AUTH-083` |
| T12 M-5 | README の「段3a の6本」・`SR-AUTH-026`〜`028` の「推定」の理由の文 |

- [ ] **Step 1: 各行を直す** — 上の表。文書とコードの食い違いは推測で決めず、どちらが正しいか実測（コード・試験）で確かめてから直す。決められない時は止まって調整役へ。
- [ ] **Step 2: 追跡** — `validate-trace`（97 を越えない）・`test:trace-coverage`・`validate-docs`・`trace:report`。
- [ ] **Step 3: コミット** — `docs(auth): 段3a の最終レビューの文書・追跡の持ち越しを直す`

### Task 22b（条件付き。オーナーが「質問1」で B を選んだ時だけ行う）: 鍵の直接の削除を DB で断る引き金

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_delete_floor_trigger.sql`（移行 J。パスキーの移行は10本）
- Test: `tests/integration/db/auth_passkey_delete_floor_trigger.integration.test.ts`
- 文書: `db-migrations.md`・`THR-AUTH-0xx`（実測の次の番号）・手順書（Task 23）の残る危険の節を直す

**Interfaces:**
- Produces: `auth.webauthn_credentials` への `BEFORE DELETE ... FOR EACH ROW` の引き金。拒否する条件は「その鍵の持ち主が今の有効な店員で、その鍵が認めた鍵で、消すと認めた鍵が `min_approved_passkeys` 未満になる」時だけで、`STAFF_MIN_KEYS`（`P0001`）。**通す物**: 同じ取引で `set_config('private.passkey_floor_bypass', '1', true)` が立っている時（発行・降格・`passkey_delete_with_floor` が立てる）、持ち主の `auth.users` の行がもう無い時（利用者の削除の連鎖）、お客さん・認めていない鍵。
- 引き金は、C の通知の引き金（AFTER・例外を握る）と違い、**例外を出す**。これが GoTrue の削除（お客さんのパスキーの削除・アカウントの削除）を壊さないことを試験で固定する。

- [ ] **Step 1: 失敗する試験を書く** — 店員（認めた鍵2本）が GoTrue の `DELETE /auth/v1/passkeys/{id}` を自分のトークンで叩くと 5xx で消えない。お客さんの削除・認めていない鍵の削除・アカウントの削除・発行・降格・`passkey_delete_with_floor` は通る。
- [ ] **Step 2〜5:** 失敗を確かめ・実装し（本番の `supabase_auth_admin` の所有の確認を手順書の前提に足す）・通し・コミット（`feat(auth): 店員の鍵を2本未満に直接消せないようにする引き金を足す（移行 J。手元だけ）`）。

### Task 23: 本番に当てる手順書

**Files:**
- Create: `docs/06_Operations/passkey-production-apply-runbook.md`
- Modify: `docs/06_Operations/db-migrations.md`（当てる順・戻し方の順・「パスキーの8本」の文を9本に）、`docs/06_Operations/README.md`、`docs/06_Operations/supabase-auth-config.md`（8-2 の一覧に H・I と手順書へのリンク）、台帳 4-2 の「本番で確かめること（設計 8-2）に足す物」の行（T12 M-2 の着地）
- Test: なし（文書。下の突き合わせを実測で確かめる）

**Interfaces（手順書が持つ節。全部を書く）:**
1. **前提（全部そろうまで1本も当てない）**: 本番の独自のドメイン・`rp_id`・`rp_origins` が決まっていること、本番の GoTrue が v2.196.0、Passkeys が無料のプランで有効にできること、`postgres` が `auth.webauthn_credentials` に `TRIGGER`・`SELECT`・`DELETE`、`auth.mfa_factors` に `DELETE`、`auth.users` に `UPDATE`、`auth.sessions` に `SELECT` を持つこと（読むだけの SQL を節に書く）、**店長にする人のアカウントが本番にあること**（無ければダッシュボードの Authentication で、パスワード無し・メール確認済みで作る）、`Sb-Forwarded-For` の運用（`supabase-auth-config.md`）。
2. **当てる順**: A → B → C → D → F → G → H → **I** を1本ずつ（H は G の列に依存するので、**G の前に H を当てない**。H の前の確かめが G の3列を見る）。→ ダッシュボード（Passkeys・RP・フックの登録は B の後）→ `supabase/pending/schedule_stripe_webhook_worker.sql` を新しい版の移行として当てる（**これは Stripe の webhook の worker も本番で動かし始める。開店の準備の行 3 の保留の定期処理4本と一緒に決める**。Vault の `cron_secret`・`app_base_url`）→（**D はデプロイの前**: アプリの `admin-rbac` が `staff_idle_check` を呼ぶため）アプリのデプロイ → 最初の店長（Task 24）が2本登録して役割が有効になる → **E は最後**（E の前の確かめは、認めた鍵が足りる店員を求める）→ TOTP を止める（ダッシュボード）。**E は権限を奪う側**なので、他の物と一緒に「害の無い物」に入れない。
3. **1本ごとの手順の表**（ファイル名・大きさ・MD5・単独で権限を奪わないか・前の確かめの SQL・当て方）: `apply_migration` の `name` は、ファイル名から版を除いた部分（例 `passkey_foundation_tables`）。当てた後に `select version, name, md5(statements[1]) from supabase_migrations.schema_migrations where name = '<name>'` で版と MD5 を読み、ファイルの MD5 と突き合わせ、ファイルの名前を当てた版に付け替える（`db-migrations.md` の各節と同じ）。付け替えると手元の順は当てた順（A→…→I→E）になるので、間に作った移行が passkey の物に依存していないかを、付け替えの後の `db reset` で確かめる。**I の前の確かめが `passkey_i_job_check_drift` で止まったら、本番の今の job の一覧を読み、I の一覧に足してから MD5 を測り直す（調整役）**。前の確かめで途中で止まったら、止めて、すでに当てた物は戻さない（単独で権限を奪わない物だけを先に当てる順にしてあるため）。表の値は Task 25 で実測と突き合わせる。**当てるのは調整役がオーナーの許可を得た時だけ**。
4. **戻し方の順（全部の箇所でこの1つ）**: (1) 毎分の定期処理（`process-stripe-webhooks`）を止め（再開しない。本番は今この定期処理が無いので、止めたままが当てる前の状態）、アプリのデプロイを戻す → (2) ダッシュボードのフックの登録を外す → (3) E → (4) I（先に `ops_job_heartbeats` の `passkey_notification_worker` の行を消す）→ (5) H → (6) G → (7) F → (8) D → (9) C（引き金の削除はサポートに依頼）→ (10) B → (11) A。H は G の列を使うので G より先に落とす。各移行の戻しはファイルのヘッダーの `ROLLBACK`。アプリを戻す時、outbox に新しい種類の行が残っていたら `skipped` にする。
5. **環境変数・Vault**（名前だけ）。
6. **設計 8-2 の確認の表**（1〜9 と段2が足した10〜12。各行に「いつ・どの画面・期待する結果・外れた時」）。**項目5（本物の Google ログインの拒否の形）と項目9（フックの拒否の応答の形）は、3a の Task 10 で本物の形を確かめられなかった**ので、本番の独自のドメインでパスキーを有効にした後に、本物の Google で店員を入れてみて、アプリが `/login?error=staff_passkey_required` に戻すことを確かめる（外れた時の直し先: `oauth/callback` の拒否の見分け。`src/app/api/auth/oauth/callback/route.ts`）。**本物の Google の確認が要るので、実装タスクにはしない**。台帳の「8-2 の1行」（`/otp` の IP の枠・`createServiceRoleAuthClient` を `sb_secret_` に替える要否）もここに。
7. **残る危険の一覧**: GoTrue を直に叩いた鍵の削除は2本の下限を越えられる（店員自身のログインを失うだけ。店長のやり直しで戻る。5-4 の知らせが出る。オーナーが Task 22b を選んだ時はこの行を消す）／引き金で拾えない道（`TRUNCATE` ほか）／複製された鍵の検知／降格した店長が出した招待は降格で取り消される（Task 13）／最初の店長を `admin:bootstrap` で作ると H の `STAFF_INVITE_REQUIRED` が効かない（段4まで）。
8. **（残る危険に足す）アプリの外で店長を消す・止めた時**: Supabase のダッシュボードで店長の利用者を消す・止める前に、アプリで降格する。やむを得ず消した時は、その店長が出した招待を手で取り消す: `update private.staff_invites set cancelled_at = now() where issued_by = '<消した店長の id>' and cancelled_at is null and activated_at is null;` と、`update private.passkey_registration_windows set closed_at = now() where user_id in (select user_id from private.staff_invites where issued_by = '<id>') and closed_at is null;`（ダッシュボードの SQL エディタ。流す前にオーナーの許可）。
8. **開店前の残り**: 設計 8-1 のとおり、本番の試し用の4人はパスワードが使えなくなる（店員がいれば招待かやり直しで入り直す）。一度も入らなかったメールのコードのアカウントの後始末、物理キー（PIN 無し）の確認、本物の Google の確認、上の8-2。

- [ ] **Step 1: 実測する** — A〜I（と、あれば J）の `wc -c`・`md5sum` を測り、`db-migrations.md` の各節の値と一致することを確かめる（一致しなければ、先にその節を直す）。
- [ ] **Step 2: 書く** — 上の節の順。各 SQL は読むだけの物（`select`）で、本番へ向けて流す物には「調整役がオーナーの許可を得てから」と明記する。
- [ ] **Step 3: `db-migrations.md` を直す** — 「当てる順」の文に、H が G に依存することと I を足す。「戻し方の順」を上の1つの順（cron・アプリ → フック → E → I → H → G → F → D → C → B → A）に書き直す（今の「F → E → D …」の並びも直す）。「パスキーの8本」の文を、見つけた全部（`grep -n "8本"`）9本（Task 22b をした時は10本）に。
- [ ] **Step 4: 確かめる** — 手順書の表のファイル名の一覧が `ls supabase/migrations | grep passkey` と同じ本数・同じ順（版の昇順を保つが、E は最後の欄に分けて書く）であること。`validate-docs`。
- [ ] **Step 5: コミット** — `docs(auth): パスキーの移行を本番に当てる手順書を書く（何も当てない）`

### Task 24: 最初の店長と、店長本人の最後の手段の手順書

**Files:**
- Create: `docs/06_Operations/passkey-staff-recovery.md`
- Modify: `docs/06_Operations/first-admin-bootstrap.md`（書き直し）、`docs/06_Operations/README.md`

**Interfaces（手順書の内容。全部を書く）:**
- 先頭に「**パスキーを2本以上、別々の端末に持つ**」。
- **最初の店長**（オーナー決定 2026-11-18）: ダッシュボードの SQL エディタ（`postgres`）で `select private.staff_invite_issue_manual('<メール>', 'admin', 3600);`。戻った43字の合言葉で `https://<本番のドメイン>/staff/invite#<合言葉>` を作り、**自分に送って**開く（期限は既定1時間。画面の結果に生の合言葉が出るので、画面を共有しない）。アカウントが無い時の作り方（Authentication）。**同じアドレスのアカウントが1つだけであること**を事前に確かめる SQL（`select count(*) from auth.users where lower(email) = lower('<メール>');` が1）。**TOTP の要素が消えたことの確かめの SQL**（`select count(*) from auth.mfa_factors where user_id = '<id>';` が0）。2本登録して役割が有効になったことの確かめ（`public.passkey_is_staff`・`approved_passkeys` が2行）。
- **店長本人の最後の手段**: ほかに店長がいない時で、店長がパスキーを全部なくした時だけ。同じ関数。監査 `staff.last_resort.issue` が1行残ることの確かめ。ほかの店長がいる時は、その店長が「やり直し」を出す（この手順を使わない）。
- `first-admin-bootstrap.md` の書き直し: `admin:bootstrap` は `user_roles` を直に書くので H の `STAFF_INVITE_REQUIRED` が効かない。段4まで残る物として位置づけ、本番の最初の店長には使わないと明記する。

- [ ] **Step 1: 書く** — 上の節のとおり。SQL の文は、手元の `db reset` の DB で流して通ることを確かめた物だけを書く（`npx.cmd supabase db reset` の後、`psql` か DB 結合の道具で。本番へは流さない）。
- [ ] **Step 2: 確かめる** — 手元で「関数を呼ぶ → URL を作る → `/staff/invite` で2本登録 → 役割が有効」を、既存の `FR-LOGIN-065`・`066` の流れで確かめる（新しい E2E は作らない）。`validate-docs`。
- [ ] **Step 3: コミット** — `docs(auth): 最初の店長と店長本人の最後の手段の手順書を書く`

### Task 25: 段3全体の最終の確かめと、オーナーに渡す一覧

**Files:**
- Modify: `scripts/trace/baseline.json`（オーナーが質問6に「下げる」と答えた時だけ。調整役が流す）、台帳 4-2（3b 行を「済み」に）、`docs/06_Operations/db-migrations.md`（9本の大きさ・MD5 の最終）、`docs/02_Requirements/areas/auth.md` の `SR-AUTH-029` の状態
- Test: なし（確かめだけ）

- [ ] **Step 1（調整役。実行者は行わない）: 全件を確かめる** — 3000番を止め、`npx.cmd supabase db reset`。`npm.cmd run lint`・`typecheck`・`npm.cmd test`（比べる元は3a の終わり: 1083 suites・24152 passed）、DB 結合（`--runInBand`。順番の汚れの既知（`unit-binding-refunds`・`group_g3_cancel`）は単独で通ること）、E2E 全件（本番ビルド・3幅。比べる元は `e2e-task12-full.json` の 5745 passed / 37 failed / 47 skipped。3a の最終の直しの後の push 前の実行（5747 passed / 47 skipped）の控えがあればそちらを優先）。新しい赤が無いこと。赤は「単独 → 他の幅 → goto かアサーションか」で切り分ける。
- [ ] **Step 2: 追跡と文書** — `validate-trace`（その時の実測。baseline より小さい時だけ、オーナーの許可で `npm.cmd run validate-trace -- --update-baseline` を調整役が流し、実測の値への差分だけがコミットに入ること）・`test:trace-coverage`・`validate-docs`・`trace:report`。
- [ ] **Step 3: 突き合わせる** — パスキーの移行（A〜I。Task 22b をしたら J）の大きさ・MD5 が、`db-migrations.md` と手順書の表と同じ（`md5sum` で測る）。`grep -rn "8本" docs/06_Operations docs/superpowers/plans/2026-11-19-*.md` に古い本数が残っていない。
- [ ] **Step 4: 台帳と一覧** — 下の「持ち越しの着地」を台帳の 4-2 へ写し、オーナーに渡す開店前の残り（後始末・物理キー・本物の Google・8-2・保留の定期処理4本の判断）を台帳に1表で書く。
- [ ] **Step 5: コミット** — `docs(auth): パスキー段3全体の確かめと開店前の残りを書く`

---

## 持ち越しの着地（3a の最終レビューの 3b 行・再レビュー・台帳の段3b 行。1つも落としていない）

| 持ち越し | 着地 |
| --- | --- |
| 降格した店長が出した招待（m-1。オーナー決定）・店長からサポーターへの変更 | Task 13（質問2） |
| H は G に依存（T12 M-3）・当て方と戻し方の文 | Task 13（H の前の確かめ）・23（文） |
| 取り消しの空振り（T5 M-2） | Task 13 |
| 店長への「やり直しを出した」の知らせ（台帳）・招待・降格 | Task 14・15 |
| 宛先が約4人を越える時の取りこぼし（段2の持ち越し） | Task 16（原因は `deliverRow` の期限。判断3） |
| `dead` の点検・worker の心拍（台帳 1l） | Task 17（移行 I） |
| F-3・F-4・T11 M-2・M-3・M-5・M-6・M-7 | Task 18 |
| T5 M-1・T6 M-6・T10 M-4・T3 M-1・T1 M-4・T1 M-5・N-1・N-2 | Task 19 |
| T1 M-1・M-2・M-3、T2 M-1、T2b M-4、T5 M-6、T6 M-4、T6b M-3・m-2、T7 M-2・N-1、T8 N-7、T9 M-6、T10 M-5、T12 M-6 | Task 20 |
| E2E の `mailsTo`・`mailBodies`、T8 N-6 | Task 21 |
| T1 M-6、T2 M-4、T2 M-5・T2b M-3、T3 M-3、T6 M-7、T6b M-1、T7 N-2、T8 N-4・N-5、T9 M-1・M-2・M-3・M-7・M-8、T10 M-1、T12 M-5 | Task 22 |
| 鍵の直接の削除（3a Task 9 の懸念2） | 質問1。A なら Task 23 の残る危険、B なら Task 22b |
| 本物の Google の拒否の形（3a Task 10） | Task 23 の8-2 の項目5・9（本番が必要。実装タスクにしない） |
| 1a-3 当て方の順・1a-4 本番の `rp_id` ほか・1i `Sb-Forwarded-For`・環境変数・T12 M-2（8-2 に足す物）・8-2 の1行 | Task 23 |
| 最初の店長・店長本人の最後の手段・`first-admin-bootstrap.md` | Task 24 |
| `baseline.json` の98と実測97 | Task 25（質問6） |
| 一度も入らなかったアカウントの後始末 | 開店前（Task 23 の8、Task 25 の一覧） |
| 3a で accept にした行（T2 M-2・T3 M-2・M-4・M-6・T4 全部・T5 M-4・M-7・M-8・M-9・T6 M-2・T6b M-2・m-1・T7 M-5・T8 M-4・M-7・T9 M-5・M-9・T10 M-3・T12 M-1・M-4・M-7。T2b M-2 は手順書の「同じアドレスのアカウントが1つ」の確かめ＝Task 24） | 3a のとおり対応しない（理由は最終レビューの表）。T9 M-5（「認めた鍵」）は質問5 |

## セルフレビュー

**設計書との対応**: 4-2 の段3の行の残り（店長への知らせ・最後の手段の手順書・役割切り替えの副作用）→ Task 14・15・24。6-2 のやり直しの「店長と本人に知らせる」（10 の最後の行）→ Task 14・15。6-2 の最後の手段・「パスキーを2本以上、別々の端末に持つ」→ Task 24。8-1（今いる人・TOTP の要素）→ Task 24（確かめの SQL）・23。8-2 の1〜12 → Task 23。10 の「直に叩かれて足し・消される」→ Task 22b／23 の残る危険。12-2 の6（`Sb-Forwarded-For` は本番のドメインが決まってから）→ Task 23。

**型・名前の一貫性**: `cancelStaffInvite` の戻り `{ cancelled: boolean }`（Task 13）は DB の `staff_invite_cancel(...) returns boolean`（Task 13）と対。`ClaimedPasskeyNotification.actorEmail`（Task 15）は G の `claim` の末尾の列 `actor_email`（Task 14）と対。`runPasskeyNotificationOpsChecks`・`OpsJob 'passkey_notification_worker'`・`OpsAlertKey 'passkey_notification_dead'`・`'job_stale_passkey_notification_worker'`（Task 17）は、移行 I の job の CHECK と関数名と対。`PASSKEY_NOTIFICATION_ROW_BUDGET_MS`・`rowBudgetMs`（Task 16）。

**Review Focus**: 5行とも、Task 13（1・5）・14・15（2）・16（3）・17（4）・23（5）の試験か手順に入れた。

**実行順**: 13 → 14 → 15 → 16 → 17（17 は 13・14 の後。G・H・I の版の順）→ 18 → 19 → 20 → 21（21 は 15 の E2E の後）→ 22 → 22b（条件付き）→ 23 → 24 → 25。13・14・19 は同じ移行ファイルを直すので、並べて実行しない。

**本番**: 段3b は何も当てない。本書の手順書（Task 23）とオーナーの許可が無い間は、この master を本番に出さない。

---

## オーナーに聞くこと

重要な順。おすすめを付けた。計画は、どれも（おすすめ）で書いてある。

1. **GoTrue を直に叩いた鍵の削除（2本の下限を越えられる穴）をどうするか** — 店員が自分のトークンで `DELETE /auth/v1/passkeys/{id}` を叩くと、2本の下限を越えて消せる。今は「店員自身が入れなくなる」だけで、権限は増えない。移行 C の引き金は「知らせを積む AFTER の引き金で、例外を握る」作りなので、今の仕組みでは止められない。 (A) **受け入れて手順書に残る危険として書く（おすすめ）**。設計 6-2 も「GoTrue を直に叩かれると止められないので、知らせで気づけるようにする」と決めている。消された鍵は 5-4 の知らせで店長に届く。店長のやり直しで戻せる。 / (B) 新しい移行 J で、拒否する引き金（`BEFORE DELETE`）を `auth.webauthn_credentials` に足す。止められるが、本番の `auth` の表に例外を出す引き金を置くことになり、GoTrue のお客さんの削除・アカウントの削除を壊す危険が増え、戻すにはサポートが要る。パスキーの移行が10本になる（Task 22b）。
2. **「店長でなくなった人が出した招待を取り消す」を、店長からサポーターへの変更と、店長へのやり直しにも広げるか** — 決定は「下げた時」。店長からサポーターへの変更も「下げる」で、サポーターは招待を出す権限を失う。やり直された店長も、登録し直すまで店長でない。どちらも、前に出した「店長」の招待が有効なまま残り、受けた人が店長になれてしまう（降格と同じ抜け道）。 (A) **お客さんへの降格・店長→サポーター・店長へのやり直しの3つで、同じ取引の中で取り消す（おすすめ）**。 / (B) お客さんへの降格だけ。なお、ダッシュボードで利用者を消す・止める場合はアプリの外なので対象外で、手順書に手で取り消す SQL を書く。
3. **新しい移行 I（心拍と死んだ知らせの点検）の置き場** — 本番にある表 `ops_job_heartbeats` の job の CHECK を1つ変える必要がある（権限は変えない。戻す時は、先に `passkey_notification_worker` の心拍の行を消す）。 (A) **別のファイル I にする（おすすめ。パスキーの移行が9本になる）**。本番の既存の表に触るのはこの1本だけで、G の戻し方が単純なまま。 / (B) 同じ文を未適用の G に入れる（8本のまま）。ファイルは増えないが、G の戻しが本番の既存の表の CHECK まで含むことになる。
4. **店長への知らせの範囲** — (A) **やり直し・招待・降格の3種類を、本人を除く店長全員に出す（おすすめ）**。出した店長自身にも1通届く（確認になる）。 / (B) 設計の最小の「やり直し」だけ。
5. **3a で作り手が決めた文面を、このまま使うか（1回で見てください）** — 招待の登録の画面（Task 7）の、取り消した・すでに登録済み・使えない・回数の制限・つながらない・失敗・完全な失敗の文と「ログインへ」のボタン、「店員ではありません。」、店長の削除の失敗の文（503・429、404、401）、招待の画面の追加の1文「「パスキー」を2本登録します」、「認めた鍵」という言い方、無操作の通知の追加の1文「もう一度ログインしてください。」、招待の画面の3行目「別の端末か、セキュリティキーでの登録をおすすめします。」、「GoTrue を直に足した鍵は、隠さず警告つきで一覧に出す」という動き。 (A) **全部このまま（おすすめ）**。 / (B) 直したい所を伝える。**3b で新しく足す文**（付録）は、これとは別に同じ確認に含める: 店長への知らせの3通・死んだ知らせのメール・止まりのメール・削除の失敗の1文・取り消しの確認。
6. **`scripts/trace/baseline.json` を下げるか** — (A) **Task 25 の実測が baseline より小さい時、その値に下げる（おすすめ）**。今の実測は97で、古い1件が残っているだけ。調整役が許可を得て更新の道を流す（実行者は流さない。許可の判定で止められるため）。 / (B) 98のまま。
7. **やり直しのメールが送れなかった時の画面（再レビュー F-3）** — (A) **ダイアログを閉じて一覧を読み直し、既存の文を通知に出す（おすすめ。新しい文なし）**。 / (B) 文を足して、役割の欄で選び直すと招待を送り直せると案内する（新しい文が要る）。

## 付録: 3b で新しく足す文面（オーナーの確認が要る）

**店長への知らせ（Task 15。件名と本文。宛先は店長）**
- やり直し: 件名「店員のパスキーのやり直しが出されました」。本文「{対象のメール} のパスキーのやり直しが出されました。／日時: {日本時間}／操作した店長: {店長のメール}／心当たりがない場合は、店長の権限を確認してください。」
- 招待: 件名「店員の招待が出されました」。本文「{対象のメール} への店員の招待が出されました。」＋日時・操作した店長・上と同じ最後の1文。
- 降格: 件名「店員がお客さんに戻されました」。本文「{対象のメール} が、店員からお客さんに戻されました。」＋同上。

**止まりの知らせ（Task 17。店の知らせの宛先）**
- 死んだ知らせ: 件名「パスキーの知らせが届きませんでした」。本文「{件数}件の知らせが、再試行の上限を越えて届きませんでした。種類・失敗の理由・時刻は次のとおりです。」＋行ごとに「{種類}／{失敗コード}／{時刻}」。
- worker の止まり: 件名「パスキーの知らせの送りが止まっています」。本文「最後に成功したのは {時刻} です。送りの設定とログを確認してください。」（既存の `staleJobMail` の形に合わせる）。

**画面（Task 18）**
- 削除の失敗（下限以外）: 「削除できませんでした。もう一度お試しください。」
- 招待の取り消しの確認: 「この招待を取り消します。よろしいですか。」
