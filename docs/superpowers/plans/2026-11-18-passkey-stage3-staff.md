# パスキー 段3（店員）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** パスキー置き換えの段3として、店員（店長・サポーター）がパスキーだけで入れるようにする。店長が店員を招待し・やり直しを出し・お客さんから店員へ上げ・下げられるようにし、店員が招待のリンクから2本のパスキーを登録して役割を有効にし、無操作1時間で止まり、メールのコード・Google で入ろうとしたら「店員の方は、パスキーでログインしてください」と出し、管理画面でパスキーを管理できるようにする。段3は2つに分ける。**段3a（この計画の本文）= コードと画面。段3b（末尾の概要）= 店長への知らせ・死んだ知らせの点検・本番に当てる準備（手順書・ダッシュボード・8-2 の確認）。**

**Architecture:** (1) 先に1b の持ち越し（移行 F の鍵の名前空間・`passkey_approve('reauth')` の厳しくする直し）を直し、次に新しい移行2本を手元に作る。H は招待・やり直しの表、役割の有効化・降格の関数、店長の最後の手段の関数。I は無操作1時間の表と `has_permission` の4つ目の条件。(2) 店長の窓口（招待・やり直し・上げる・下げる）は、すべて「その人のパスキーを全部消し・ログインを全部終わらせ・役割を止め・合言葉を出す」の同じ関数を通す（設計 6-2。持ち越し 1j・1k もここ）。(3) 招待のリンクの受け口（GET は何もせず、ボタンの POST でだけセッションを作り窓を開ける。案 B）と、2本の登録の画面を作り、2本そろったら役割を有効にして終わらせる。(4) 無操作1時間はアプリの窓口で最後に使った時刻を書き（数分に1回に間引く）、API と RLS が読む。(5) 店員のパスキー管理・1本だけの店員の画面・拒否の画面を足し、`/admin/create-user` を消す。(6) 本番へ当てる準備は段3b。

**Tech Stack:** Next.js App Router（Route Handler・Client Component）、`@supabase/supabase-js` 2.119.0（固定）、`zod`、Postgres 17（手元の Supabase）、GoTrue v2.196.0、Jest、React Testing Library、Playwright（本番ビルド・Chromium の CDP の仮想の認証器）、`tsx`。

**Spec:** [docs/superpowers/specs/2026-11-07-passkey-auth-design.md](../specs/2026-11-07-passkey-auth-design.md)（正本。特に 4-2 の段3の行、4-3、5-2、5-4、5-5、6-2、8-1、8-2、9、10、12、12-2）。手元の試し結果は [2026-11-16-passkey-local-trial-results.md](../specs/2026-11-16-passkey-local-trial-results.md)（T2・T3・T6）。前の計画は [段2](2026-11-17-passkey-stage2-customers.md)・[段1b](2026-11-17-passkey-stage1b-server-endpoints.md)、台帳は `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（行 1a-3・1a-4・1i・1j・1k・1l と「4-2 パスキー段2から先への持ち越し」）。ブランドは `docs/01_Planning/brand.md`（CLAUDE.md が書く `docs/1_RequirementsDifinition/brand.md` は無い）。実行する人は、この計画と設計書の両方を読む。

## 分け方（段3が持つ範囲）

| 計画 | 中身 |
| --- | --- |
| 1a・1b・2（済み。push 済み） | 土台、フック、管理の入口の3つの条件、パスキーの窓口、お客さんの画面・メールのコード・知らせの送り手 |
| **段3a（この文書の本文。Task 1〜12）** | 持ち越しの直し、移行 H・I（手元だけ）、招待・やり直し・上げる・下げる、招待の受け口と2本の登録の画面、無操作1時間、店員のパスキー管理、拒否の画面、「ユーザー」の画面 |
| 段3b（末尾の概要。3a の後に別の計画として書く） | 店長への知らせ（やり直し・招待）、死んだ知らせの点検と worker の心拍、E2E のメールの待ち、本番に当てる手順書（順・突き合わせ・戻し方・pg_cron・ダッシュボード・8-2）、最初の店長（最後の手段）の手順書 |
| 段4（片付け） | パスワード・認証アプリの画面・窓口・表・試験を消す。お客さんの `password` の拒否を有効にする |

**1つの文を先に書く（本番の安全）**: 段3a は本番の DB に何も当てない。段3a が済んでも、段3b の手順書とオーナーの許可が無い間は、この master を本番に出さない。

## 作り手の判断（私が決めた物と、理由の1行）

設計書が決めていない・食い違う点。違えばオーナーが直す。

1. **役割の有効化は、新しい DB 関数 1か所だけを通す（持ち越し 1j）**: `admin_set_user_role` を作り直し、`admin`・`supporter` への変更は「今、有効な店員」でなければ `STAFF_INVITE_REQUIRED` で断る。お客さんから上げる・期限切れ・無効だった役割を戻す、のどれも招待の行を作る道に落ちる。店員同士（店長とサポーターの入れ替え）と、`user` への降格は今のまま通す。理由: 窓口を足すたびに忘れる穴を DB で塞ぐ。
2. **上げる・やり直す・最後の手段は同じ関数 `staff_invite_issue`**: 鍵（`auth.webauthn_credentials` と認めた表）を全部消し、役割を止め、古い招待を取り消し、新しい招待の行を作る。ログインを全部終わらせるのは、窓口が続けて `revokeAllSessionsForUser` を呼ぶ（持ち越し 1k。アプリに結び付いていない GoTrue のセッションも消えることを試験で確かめる）。
3. **最後の1人の店長は、やり直せない**（`LAST_ADMIN_REQUIRED`）。店長本人の最後の手段は、ダッシュボードの SQL（`postgres` だけが呼べる `private.staff_invite_issue_manual(email, role)`）。この関数は、最初の店長を本番に作る道も兼ねる（質問 2）。
4. **無操作1時間は、アプリの表 `private.staff_session_activity`**（設計 11 で作り手に任された）: `auth.sessions.refreshed_at` は GoTrue の更新で動くので使わない。`has_permission` に4つ目の条件を足す（移行 I。移行 E の本体は書き換えない）。
5. **招待とやり直しの合言葉の作りは、今の再設定の合言葉と同じ**（SHA-256 で保存・使い切り・GET は何もしない・期限24時間）。ただし表は新しく作る（再設定の表は段4で消える）。
6. **認証アプリ（TOTP）の窓口と画面は段4で消す**（4-2 の表のとおり。6-2 の「消す」は段の指定が無い）。ただし `/auth/verified` に1本だけの店員が来て回り続ける問題（1b の持ち越し）は Task 9 で直す。`/admin/create-user` と `/api/admin/create-user` は、パスワードを直に入れる物なので段3a で消す（6-2 の招待の1）。
7. **店員の画面の置き場**: 招待の受け口は `/staff/invite`、2本の登録は `/staff/register`（どちらもログインの外の画面。`isAuthPage` に足す）。パスキー管理は、管理画面の「ユーザー」の下ではなく、管理画面の右上の自分のメニューから行く `/admin/passkeys`（店員だけ。お客さんは `/account` の「ログイン方法」）。
8. **E2E のファイル名はすべて `e2e/FR-LOGIN-NNN-*.spec.ts`**（段2の判断7と同じ。追跡の範囲 AUTH が拾うため）。
9. **ADR-0471 以後は AUTH の範囲に入らない**ので、Task 2 で `scripts/trace/scope.json` に `ADR-047[1-9]*.md` を足し、`decisions/README.md` の AUTH の帯の行を「0463〜0473」にそろえる。
10. **一度も入らなかったメールのコードのアカウントの後始末は、開店前に回す**（台帳の4-2のとおり。段3には入れない）。理由: 店員の流れと関係が無く、`last_sign_in_at IS NULL` の消し方は別の定期処理になる。段3b の手順書に「開店前の残り」として1行書く。
11. **1b の M-2（`login/finish` の `endAuthSession` の失敗が静か）は Task 10 で直す**（その窓口を Task 10 が触るため）。

## Global Constraints

1a・1b・2 の決まりを引き継ぎ、段3で足す物を書く。全部のタスクの要件に含まれる。

**本番の安全（オーナー決定 2026-11-16・段3も同じ）**

- **段3a は本番の DB に何も当てない**。Supabase の MCP（`apply_migration`・`execute_sql` など）はサブエージェントから使わない。`supabase db push`（どの形でも）と `workflow_dispatch` は流さない。`.env*` は読まない・表示しない。`graphify update` は流さない（コミットのフックが後で流す）。
- 本番に当てるのは調整役だけで、オーナーの許可を得た時に、1本ずつ MCP の `apply_migration`。当てた後は `md5(statements[1])` をファイルの MD5 と突き合わせ、ファイルの名前を当てた版に合わせる（段3b の手順書）。
- パスキーの移行は今7本。**段3a で H・I を足して9本**（`docs/06_Operations/db-migrations.md` の「段3まで `db push` しない」一覧に足す。Task 2・3）。移行の版は作る時の時刻で付け、最新（`20261118044338`）より後にする。この計画の `<時刻>` は仮。
- master への push は、調整役がオーナーの許可を得て行う（実行者は push しない）。

**手元の Supabase・E2E・リポジトリ**

- E2E は本番ビルド（`next build && next start`）・390・768・1280 の3幅。dev サーバーでは流さない。`retries` を上げない。流す前に3000番のアプリを止める。**E2E の全件・push 前の確かめは調整役だけ**。手元の DB 結合は、実行者が1人ずつ `db reset` の後に流してよい。
- 落ちたら「単独の再実行 → 他の幅 → `goto` のタイムアウトかアサーションか」の順で切り分ける。全件の赤は、比べる元（段2の全体の確かめの結果。`.superpowers/sdd/2026-11-17-passkey-stage2-customers/` の JSON）と比べる。
- メールは手元の Mailpit（`MAIL_PROVIDER=local`）。待ちは **`expect.poll`**（Task 6 から使う。段3b で既存の手助けも直す）。
- 実行者は `package.json`・`.claude/CLAUDE.md`・`.superpowers/`・`.codex/`・`graphify-out`・stockist の差分に触れない・足さない。master で作業し、タスクごとに1コミット。**自分が作った物だけを名前で `git add`**（`git add -A` を使わない）。末尾に `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- モデル: 書き手は Sonnet、レビューは Opus（effort high）。

**設計の守り（段3で足す物）**

- **店員のログインの状態は、パスキーで入った時だけ作られる**。招待のセッションは窓の中だけ（窓の長さは30分。ボタンの POST の時から数える）。**窓口は、呼ばれるたびに窓の行がまだ有効かを確かめ直す**（アクセストークンは窓より長く残るため）。
- **窓の開け方は案 B**: ①お客さんの扱いのまま（役割が無い状態）でセッションを作る → ②分かった `session_id` に結んで窓を開ける → ③2本そろったら役割を有効にする。先に窓を開けてフックに結ばせる形（案 A）は作らない。
- 役割を有効にする前に必ず、その人の鍵が**すべて窓の中で登録した認めた鍵**であること・本数が `min_approved_passkeys`（2）以上であることを DB の関数で確かめる。
- **鍵を全部消す・役割を止める・古い招待を取り消す・新しい招待を作る**は1つの取引。途中で止まって「鍵は消えたが招待が無い」の状態を作らない。
- やり直しは**店長だけ**・確認の語と理由（10〜500字）が要る・自分自身にはできない・最後の1人の店長にはできない。
- 無操作1時間・最長24時間を過ぎた店員は、画面を `/login` に送る。API は 401、RLS は拒否。
- 店員向けの文は、断定せず短く、煽らない（brand.md）。丁寧語。専門語（WebAuthn・UV・認証器）を画面に出さない。「パスキー」は一度「顔認証・指紋・PIN で入る方法」と言い換える。「頁」は使わず「ページ」。絵文字・感嘆符を使わない。
- 監査（`logAudit`）に、合言葉・リンクの全文・鍵・`challenge_id` を残さない。

**追跡と文書（範囲内の領域 AUTH）**

- 要求・要件・受け入れ条件は `docs/02_Requirements/areas/auth.md`、基本設計は `docs/03_BasicDesign/areas/auth.md`、設計判断は `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md`、脅威は `docs/05_Quality/security/threats/auth.md`、処理の詳細は `docs/04_DetailDesign/sequence/auth-*.md` と `docs/04_DetailDesign/pages/14_login.md`。コードには TSDoc の `@impl`・`@design`。書式は `documentation-guide` スキル。
- **追跡の鎖**: 1つの公開した単位に IMPL を1つ。DD の親は構造設計か SEC。SEC の親は THR。ADR には構造設計の子が要る。受け入れ条件（AC）には E2E か単体の試験が要る。
- **文書と追跡は、そのタスクのコミットに入れる**。コミットの前に `npm.cmd run validate-trace`・`npm.cmd run test:trace-coverage`・`npm.cmd run validate-docs` を通す。`scripts/trace/baseline.json`（今 98）から増やさない。届かない分岐は `test-gaps.md` の節に書く。
- **番号の予約**（着手時に `grep` で空きを確かめる。2026-11-18 の実測の最大は SR-AUTH-025、FR-AUTH-033、API-AUTH-032、DD-AUTH-068、IMPL-AUTH-338、SEC-AUTH-051、THR-AUTH-050、DATA-AUTH-019、SCR-AUTH-012、ARC-AUTH-011、ADR-0470、FR-LOGIN-062）:
  `SR-AUTH-026`〜`029`、`FR-AUTH-034`〜`046`、`API-AUTH-033`〜`038`、`DD-AUTH-069`〜`082`、`IMPL-AUTH-339`〜`390`、`SEC-AUTH-052`〜`057`、`THR-AUTH-051`〜`055`、`DATA-AUTH-020`〜`022`、`SCR-AUTH-013`〜`016`、`ARC-AUTH-012`〜`013`、`ADR-0471`（店員の招待・やり直し・役割の有効化）〜`0473`、E2E は `e2e/FR-LOGIN-063`〜`074`（段3a は 063〜071、段3b は 072〜074）。
- **追跡の範囲の足し方**: Task 2 で `scope.json` の AUTH の `docs` に `ADR-047[1-9]*.md`、`src` に `src/app/staff/**/*.{ts,tsx}`・`src/app/admin/passkeys/**/*.{ts,tsx}`・`src/app/api/admin/staff/**/*.ts`・`src/features/auth/staff/**/*.{ts,tsx}`、`tests` に `tests/unit/features/auth/staff/**/*.test.{ts,tsx}`・`tests/unit/app/staff/**/*.test.{ts,tsx}`。足すたびに `validate-trace` と `test:trace-coverage` を流す。

## Review Focus

先頭ほど起きやすい。

1. **招待のセッションが窓の外・別人・別のセッションで使えないか**: 窓が閉じた後・30分を過ぎた後・別の `session_id`・別のユーザーの合言葉・使い切った合言葉・取り消した合言葉で、登録の窓口・役割の有効化が全部断られるか。GET（メールの先読み）で合言葉が使い切られず、セッションも作られないか（Task 6・7）
2. **上げる・やり直す時に古い入口が残らないか**: 鍵が全部消え、GoTrue のセッション（アプリに結び付いていない物も）が全部消え、役割が止まり、古い招待が取り消されるか。期限切れ・無効だった役割を戻す道も同じ関数を通るか。途中で失敗しても半端な状態が残らないか（Task 1・2・5）
3. **役割の有効化の門**: 鍵が1本・窓の外で足した鍵・GoTrue を直に叩いて足した鍵のとき、役割が有効にならないか。有効にした後は窓が閉じ、招待のセッションが終わるか（Task 2・7）
4. **無操作1時間と24時間**: 59分と61分、更新を拒否された後、時計のずれ、最後に使った時刻の行が無いセッション（失敗側に倒れるか）、書き込みの間引きで1時間を越えて延びないか（Task 3・8）
5. **店員が別の道で入ろうとした時**: メールのコード・Google・古いパスワードで、セッションも Cookie も作られず、お客さんには見えない文面で止まり、「登録済みかどうか」を漏らさないか。1本だけの店員が `/auth/verified` で回り続けないか（Task 9・10）

---

## ファイルの全体図

| 区分 | ファイル | タスク |
| --- | --- | --- |
| 変える | `supabase/migrations/20261117123620_passkey_server_endpoint_fns.sql`（F。名前空間・reauth の本数と承認。手元だけ） | 1 |
| 作る | `supabase/migrations/<時刻>_passkey_staff_invites.sql`（H）、`<時刻>_passkey_staff_idle.sql`（I） | 2・3 |
| 作る | `src/features/auth/staff/invite-token.ts`、`invite-mail.ts`、`staff-invite-store.ts` | 4 |
| 作る | `src/app/api/admin/staff/invites/route.ts`、`src/app/api/admin/staff/[id]/redo/route.ts`、`demote/route.ts` | 5 |
| 変える | `src/app/api/admin/users/route.ts`（PATCH。上げるは招待へ）、`src/lib/auth/role-permission-store.ts`、`revoke-user-sessions.ts`（変えない。呼ぶ） | 5 |
| 消す | `src/app/admin/create-user/`・`src/app/api/admin/create-user/` と、その試験 | 5 |
| 作る | `src/app/staff/invite/page.tsx`、`src/app/api/auth/staff/invite/{status,start}/route.ts` | 6 |
| 作る | `src/app/staff/register/page.tsx`、`src/features/auth/staff/components/StaffRegisterScreen.tsx`、`src/app/api/auth/staff/register/complete/route.ts` | 7 |
| 変える | `src/lib/auth/admin-rbac.ts`・`src/app/api/auth/passkey/login/finish/route.ts`（最後に使った時刻を書く） | 8 |
| 作る | `src/app/admin/passkeys/page.tsx`、`src/features/auth/staff/components/StaffPasskeyManager.tsx`、1本だけの店員の「もう1本」の画面 | 9 |
| 変える | `src/app/login/code`・`src/app/api/auth/email-code/verify`・`oauth/callback`・`/login` の文面、`login/finish/route.ts`（M-2） | 10 |
| 変える | `src/components/UserSection.tsx`（招待・やり直し・上げる・下げる） | 11 |
| 作る | `e2e/FR-LOGIN-063`〜`071` | 各タスク |

---

## Tasks

### Task 1: 1b からの持ち越しの直し（移行 F の鍵の名前空間・`passkey_approve('reauth')`）

**Files:**
- Modify: `supabase/migrations/20261117123620_passkey_server_endpoint_fns.sql`（F。**本番未適用なので同じファイルを直す**。大きさと MD5 を測り直す）
- Test: `tests/integration/db/auth_passkey_server_fns.integration.test.ts`（足す）
- 文書（同じコミット）: `docs/06_Operations/db-migrations.md` の移行 F の節（大きさ・MD5・手元の `md5(statements[1])`）、台帳の行 1l の持ち越しの「役割を上げる時の鍵の消去…」の状態欄、`SEC-AUTH-052`（上位 `THR-AUTH-051`）・`DD-AUTH-069`（上位 `SEC-AUTH-052`）・`IMPL-AUTH-339`

**Interfaces:**
- Consumes: 既存の `public.passkey_approve(p_user_id uuid, p_passkey_id uuid, p_via text)`（F の `reauth` の枝）。
- Produces: 同じ署名。変わるのは (1) `pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0))` を `hashtextextended('passkey_approve:' || p_user_id::text, 0)` にする（`admin_set_user_role` の固定の鍵 `190519` や他の機能の鍵と混ざらない名前空間）、(2) `p_via = 'reauth'` は、その人の認めた鍵が1本以上あり、かつ**呼ぶ側が「5分以内のパスキーでの入り直し」を確かめた**印（新しい引数ではなく、`private.passkey_staff_settings()` を使わず、関数の中で `passkey_approved_count(p_user_id) >= 1` を確かめるだけ。0本の店員が `reauth` で足すことは `window` の道でしか許さない）。確かめて外れたら `PASSKEY_REAUTH_NOT_ALLOWED`（`ERRCODE = '42501'`）。入り直しの時刻の確かめは窓口（`passkey-recent-auth.ts`）に残る。

- [ ] **Step 1: 失敗する試験を書く** — (a) `reauth` で、認めた鍵が0本の店員を承認しようとすると `PASSKEY_REAUTH_NOT_ALLOWED`。(b) 1本ある店員では通る。(c) `window`・`script` の枝は変わらない（0本でも通る）。(d) 関数の本体に `'passkey_approve:'` が入っている（`prosrc` を読む）。(e) 同じ人の2つの接続から同時に `window` で2本を承認すると、順に進み、本数が2本でちょうど止まる（既存の試験の形）
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/integration/db/auth_passkey_server_fns.integration.test.ts`（`db reset` の後）→ (a)(d) が FAIL
- [ ] **Step 3: 実装する** — F の `passkey_approve` の本体を直す。ヘッダーの ROLLBACK も合わせる。`npx.cmd supabase db reset` で適用できること
- [ ] **Step 4: 通ることを確かめる** — 上の試験と、`auth_passkey_*` の DB 結合が全部 PASS。`FR-LOGIN-051`（店員の登録）を3幅 PASS。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `fix(auth): 移行 F の承認の鍵に名前空間を付け、入り直しの承認が0本の店員を通さないようにする`

### Task 2: 移行 H（招待・やり直しの表、役割の有効化・降格、最後の手段）

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_staff_invites.sql`
- Modify: `scripts/trace/scope.json`（上の「範囲の足し方」）、`docs/03_BasicDesign/decisions/README.md`
- Test: `tests/integration/db/auth_passkey_staff_invites.integration.test.ts`
- 文書（同じコミット）: `docs/06_Operations/db-migrations.md` に「パスキー段3 移行 H」の節（大きさ・MD5・前の確かめ・末尾の確かめ・戻し方・本番へ当てない）、`SR-AUTH-026`・`FR-AUTH-034`〜`036`・`DATA-AUTH-020`・`SEC-AUTH-053`（上位 `THR-AUTH-052`）・`DD-AUTH-070`〜`072`・`IMPL-AUTH-340`〜`346`、`ADR-0471`（店員の招待・やり直し・役割の有効化。構造設計の子 `ARC-AUTH-012`）

**Interfaces（すべて `SECURITY DEFINER`・`search_path` 空・持ち主 `postgres`・`service_role` だけが `execute`。`private.staff_invite_issue_manual` は `postgres` だけ）:**
- 表 `private.staff_invites(id uuid pk default gen_random_uuid(), user_id uuid not null, role_code text check in ('admin','supporter'), kind text check in ('invite','redo','promote','last_resort'), token_hash bytea not null unique, issued_by uuid, reason text, expires_at timestamptz not null, consumed_at timestamptz, session_id uuid, activated_at timestamptz, cancelled_at timestamptz, created_at timestamptz default now())`。1人に付き「取り消されておらず・有効化されていない」行は最大1（部分の一意索引）。RLS 有効・`anon`・`authenticated` の権限なし。
- `public.staff_invite_issue(p_user_id uuid, p_role_code text, p_kind text, p_issued_by uuid, p_reason text, p_token_hash bytea, p_ttl_seconds integer default 86400) returns uuid` — 1つの取引で: 最後の1人の店長なら `LAST_ADMIN_REQUIRED`（`p_kind = 'last_resort'` は除く）、`p_issued_by = p_user_id` なら `SELF_ROLE_CHANGE_FORBIDDEN`、古い行を `cancelled_at` で閉じ、開いている窓を閉じ、`private.approved_passkeys` と `auth.webauthn_credentials` のその人の行を全部消し、`user_roles` の `active` を全部 `false` にし、`auth.users.raw_app_meta_data.role` を `user` にし、新しい行を作って `id` を返す。**期限切れ・無効だった役割を戻す道も、`admin_set_user_role` を通らずこの関数に来る**。
- `public.staff_invite_consume(p_token_hash bytea) returns table(invite_id uuid, user_id uuid, role_code text)` — 未使用・未取り消し・期限内なら `consumed_at` を入れて返す。**ここでは窓を開けない**。外れたら0行。
- `public.staff_invite_bind_window(p_invite_id uuid, p_session_id uuid) returns void` — 案 B の②。`consumed_at` 済み・`session_id` 未設定の行に `session_id` を入れ、`public.passkey_window_open(user_id, session_id)` を呼ぶ。2度目は `STAFF_INVITE_ALREADY_BOUND`。
- `public.staff_role_activate(p_invite_id uuid, p_session_id uuid) returns jsonb` — 案 B の③。行が `session_id` と一致・未有効化・未取り消し、窓がまだ開いている、認めた鍵が `min_approved_passkeys` 以上で、**認めた鍵の `approved_via` がすべて `window`**。満たせば `user_roles` と `raw_app_meta_data.role` を有効にし（`assigned_by = issued_by`）、`activated_at` を入れ、窓を閉じる。満たさなければ理由つきで例外（`STAFF_ACTIVATE_NO_WINDOW`・`STAFF_ACTIVATE_KEYS_SHORT`・`STAFF_ACTIVATE_KEYS_NOT_WINDOW`・`STAFF_ACTIVATE_INVITE_INVALID`）。
- `public.staff_demote(p_actor_id uuid, p_user_id uuid) returns void` — 最後の店長・自分自身は断る。役割を `user` にし、認めた鍵の表のその人の行を消す（鍵そのものは残す。お客さんのパスキーになる）。
- `private.admin_set_user_role` を作り直す（本体は `20261023175712` の物。署名・権限・所有者は同じ）。**変えるのは、`_role_code in ('admin','supporter')` で、その人が今「有効な店員」でない時に `STAFF_INVITE_REQUIRED`（`ERRCODE = '42501'`）を返す1点だけ**。前の確かめで、置き換える前の `md5(prosrc)` を確かめる（移行 E と同じ作り）。
- `private.staff_invite_issue_manual(p_email text, p_role_code text default 'admin') returns text` — ダッシュボードの SQL 用。ユーザーを `auth.users` から引き、`staff_invite_issue(..., 'last_resort', null, ...)` を呼び、**生の合言葉を戻り値で返す**（`gen_random_bytes(32)` の base64url。表にはハッシュだけ）。ユーザーが無ければ `STAFF_MANUAL_USER_NOT_FOUND`。
- 前の確かめ・末尾の確かめ（権限・所有者・`SECURITY DEFINER`・`search_path`・表の RLS）は、移行 F・G と同じ形で書き、外れたら `PASSKEY_MIGRATION_PRECHECK_FAILED`・`PASSKEY_MIGRATION_ASSERTION_FAILED`。

- [ ] **Step 1: 失敗する試験を書く** — 下の1つずつをテスト名にする。(1) 発行で鍵・認めた鍵・役割・古い招待が消え/止まり、行が1つだけ開いている。(2) 発行の途中で例外（呼び元が `p_user_id` を存在しない値にする）を起こすと何も変わらない。(3) 最後の1人の店長は `LAST_ADMIN_REQUIRED`、`last_resort` は通る。(4) 期限が切れて `active = false` だった `admin` の行を持つ人が `admin_set_user_role` で `admin` に戻されそうになると `STAFF_INVITE_REQUIRED`（**1j**）。(5) `user` から `supporter` も `STAFF_INVITE_REQUIRED`。(6) 有効な店長が店員同士（`admin` → `supporter`）・`user` へは今のまま通る。(7) 消費は1回だけ・期限切れ・取り消しは0行。(8) `staff_invite_bind_window` は2度目が `STAFF_INVITE_ALREADY_BOUND`、別のユーザーの `session_id` では窓が開かない。(9) 有効化は、鍵1本・`approved_via` が `reauth`・窓が閉じた後・別の `session_id` のそれぞれで例外、鍵2本が `window` の時だけ通り、窓が閉じ、役割が付く。(10) 降格は認めた鍵の行を消し鍵を残す。(11) `staff_invite_issue_manual` が戻した合言葉の SHA-256 が表のハッシュと一致し、`service_role`・`authenticated` は呼べない。(12) 全関数が `anon`・`authenticated` から呼べず、所有者・`search_path` が正しい
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/integration/db/auth_passkey_staff_invites.integration.test.ts` → FAIL（関数が無い）
- [ ] **Step 3: 実装する** — 上の署名で移行 H を書く。取引は `BEGIN`〜`COMMIT`、鍵の名前空間付きの `pg_advisory_xact_lock('staff_role:' || user)`（`190519` の固定の鍵とは別。ただし `admin_set_user_role` と同じ取引の中で両方取る時の順は「`190519` が先」に固定し、試験 (2) の近くに順の注意を書く）。ASCII だけ・LF・BOM なし
- [ ] **Step 4: 通ることを確かめる** — 上の試験 PASS。`npx.cmd supabase db reset` が通る。`auth_passkey_*`・`auth_has_permission_passkey`・`admin_set_user_role` を使う既存の DB 結合（`grep -rl admin_set_user_role tests`）が緑のまま。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): 店員の招待・やり直し・役割の有効化の移行 H を足す（手元だけ）`

### Task 3: 移行 I（無操作1時間の表と `has_permission` の4つ目の条件）

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_staff_idle.sql`
- Test: `tests/integration/db/auth_passkey_staff_idle.integration.test.ts`
- 文書（同じコミット）: `db-migrations.md` に「パスキー段3 移行 I」の節、`FR-AUTH-037`・`SEC-AUTH-054`（上位 `THR-AUTH-053`）・`DD-AUTH-073`・`DATA-AUTH-021`・`IMPL-AUTH-347`〜`349`

**Interfaces:**
- 表 `private.staff_session_activity(session_id uuid primary key, user_id uuid not null, last_seen_at timestamptz not null default now())`。RLS 有効・`anon`・`authenticated` の権限なし。1日1回古い行（`last_seen_at` が2日より前）を消す処理は作らない（`staff_session_touch` が書く時に、その人の古い行を消す）。
- `public.staff_session_touch(p_session_id uuid, p_user_id uuid, p_min_interval_seconds integer default 60) returns boolean` — 行が無ければ作り、あって `p_min_interval_seconds` 以上たっていれば更新し、書いたら真。`service_role` だけが `execute`。
- `private.staff_idle_ok(p_session_id uuid) returns boolean`（`STABLE`・`SECURITY DEFINER`） — 行が無ければ**偽**（失敗側）。`last_seen_at > now() - staff_idle_seconds` で真。`staff_idle_seconds` は `private.passkey_staff_settings()` から読む。
- `public.has_permission(text)` の本体に、`staff_passkey_count_ok` の次の4つ目の条件として `private.staff_idle_ok((auth.jwt() ->> 'session_id')::uuid)` を足す（`CREATE OR REPLACE`。署名・権限・所有者は E と同じ。前の確かめで E の本体の `md5(prosrc)` を確かめ、外れたら止める）。

- [ ] **Step 1: 失敗する試験を書く** — (1) 行が無い店員は偽（失敗側）。(2) 59分前は真・61分前は偽（`last_seen_at` を直に書き換えて確かめる）。(3) `staff_session_touch` が間引く（60秒以内の2度目は偽を返し、時刻が動かない）。(4) お客さん・anon の `has_permission` の結果は変わらない（既存の RLS の試験が緑）。(5) 24時間・認めた鍵2本の条件は今のまま（E の試験が緑）。(6) `session_id` が JWT に無い時は偽。(7) 権限（`service_role` だけ）
- [ ] **Step 2: 失敗を確かめる** — 上の DB 結合 → FAIL
- [ ] **Step 3: 実装する** — 上の署名で移行 I を書く。費用: `has_permission` を `( SELECT ... )` で包まずに呼ぶ決まりが77件ある（E の節）。条件4も店員だけが払う作りにし、`EXPLAIN` が増えないことを台帳の備考に1行書く
- [ ] **Step 4: 通ることを確かめる** — DB 結合の `auth_*`・`has_permission` を使う既存の試験が緑。`db reset`。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員の無操作1時間の条件を has_permission に足す移行 I（手元だけ）`

### Task 4: 招待の合言葉・メール・DB を呼ぶ部品

**Files:**
- Create: `src/features/auth/staff/invite-token.ts`、`invite-mail.ts`、`staff-invite-store.ts`
- Test: `tests/unit/features/auth/staff/{invite-token,invite-mail,staff-invite-store}.test.ts`
- 文書: `DD-AUTH-074`・`IMPL-AUTH-350`〜`354`（SEC は Task 2 の `SEC-AUTH-053` の子）

**Interfaces:**
- `invite-token.ts`: `createInviteToken(): { token: string; tokenHash: Uint8Array }`（32バイト乱数の base64url と、その SHA-256）、`hashInviteToken(token: string): Uint8Array`、`buildInviteUrl(origin: string, token: string): string`（`/staff/invite#<token>`。**合言葉は URL の断片（`#`）に置く**。理由: アクセスのログ・Referer に残らない。画面が断片を読み、`POST` の本文で送る）。
- `invite-mail.ts`: `composeInviteMail(input: { kind: 'invite'|'redo'|'promote'; roleLabel: '店長'|'サポーター'; url: string; expiresAtJst: string }): { subject: string; text: string; html: string }`。文面は下の付録のとおり。送るのは既存の注文のメールと同じ送り手（段2の `passkey-notification-store` が使う送り口）を使う。
- `staff-invite-store.ts`（サーバーだけ。`import 'server-only'`）: `issueStaffInvite(deps, input: { userId: string; roleCode: 'admin'|'supporter'; kind: 'invite'|'redo'|'promote'|'last_resort'; issuedBy: string | null; reason: string | null }): Promise<Result<{ inviteId: string; token: string }, 'last_admin'|'self'|'not_found'|'failed'>>`、`consumeStaffInvite(deps, token: string): Promise<Result<{ inviteId: string; userId: string; roleCode: string }, 'invalid'>>`、`bindStaffInviteWindow`・`activateStaffRole`・`demoteStaff` も同じ形（DB 関数の例外の名前を `Result` の理由に写す。例外の本文をそのまま返さない）。

- [ ] **Step 1: 失敗する試験を書く** — 合言葉は毎回違い・43字（base64url の32バイト）・ハッシュは SHA-256。`buildInviteUrl` が `#` で渡し、`?token=` を作らない。メールの本文に URL と期限と「ご自身で心当たりがない場合は、何もしないでください」が入り、**合言葉が件名・ログに出ない**（`console` を見張る）。`issueStaffInvite` が `LAST_ADMIN_REQUIRED` を `last_admin` に写す・未知のエラーが `failed` になり本文が漏れない
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/features/auth/staff` → FAIL
- [ ] **Step 3: 実装する** — 上の署名どおり。DB は `createServiceRoleClient` の RPC（`callRpc` の既存の部品があれば使う）
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS、`typecheck`・`lint`、`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員の招待の合言葉・メール・DB を呼ぶ部品を足す`

### Task 5: 店長の窓口（招待・上げる・やり直し・下げる）と、旧の作成画面の削除

**Files:**
- Create: `src/app/api/admin/staff/invites/route.ts`（`POST`）、`src/app/api/admin/staff/[id]/redo/route.ts`（`POST`）、`src/app/api/admin/staff/[id]/demote/route.ts`（`POST`）
- Modify: `src/app/api/admin/users/route.ts`（PATCH。下の規則）
- Delete: `src/app/admin/create-user/`、`src/app/api/admin/create-user/`、その単体・E2E（`FR-ADMIN-*` の中でこの画面だけを確かめる物。`grep -rln "create-user" tests e2e` で探し、1本ずつ旧画面だけの物かを確かめる。他の機能の準備に使っている物は付け替える）
- Test: `tests/unit/api/admin/staff/*.test.ts`、`tests/integration/api/admin-staff-*.test.ts`、`e2e/FR-LOGIN-063-staff-invite-redo-api.spec.ts`
- 文書: `SR-AUTH-026` の `FR-AUTH-038`〜`040`・`API-AUTH-033`〜`035`・`DD-AUTH-075`〜`076`・`IMPL-AUTH-355`〜`362`・`docs/03_BasicDesign/areas/auth.md`（画面・API・状態の遷移の表）、`ADR-0471` に追記

**Interfaces:**
- `POST /api/admin/staff/invites` 本文 `{ email: string; role: 'admin'|'supporter' }`。権限 `admin.users.manage`・CSRF・IP と店長ごとの回数の制限。アドレスにアカウントが無ければ `auth.admin.createUser({ email, email_confirm: true })`（パスワード無し）。あれば同じアカウントを使う。`issueStaffInvite(kind: 'invite')` → `revokeAllSessionsForUser` → 招待のメールを送る。応答は常に `{ success: true }`（**アカウントが在ったかを返さない**）。`issued_by = 店長の id`。
- `PATCH /api/admin/users`（`{ userId, role }`）の変更: `role` が `admin`/`supporter` で、その人が今の有効な店員でない時は、直に変えず `issueStaffInvite(kind: 'promote')` → 全ログイン終了 → メール。応答は `{ success: true, invited: true }`。有効な店員どうしの入れ替えと `user` への降格は今のまま（降格は `demoteStaff` を呼び、全ログインを終わらせる）。`STAFF_INVITE_REQUIRED` が DB から返ったら同じ道に落とす。
- `POST /api/admin/staff/[id]/redo` 本文 `{ confirm: 'やり直し'; reason: string(10..500) }`（今の MFA のやり直し `/api/admin/users/mfa/reset` の守りと同じ形。ADR-0457・0461）。自分自身は403、最後の1人の店長は409。`issueStaffInvite(kind: 'redo', roleCode: 今の役割)`。**役割を止めるので、今の役割は発行の前に読んで控える**。
- `POST /api/admin/staff/[id]/demote`: `demoteStaff` → `revokeAllSessionsForUser`。
- 監査: `admin.staff.invite`・`admin.staff.promote`・`admin.staff.redo`・`admin.staff.demote`（`resource_id` は対象の id、詳細に理由の長さだけ。理由の本文・メールの全文・合言葉は載せない）。

- [ ] **Step 1: 失敗する試験を書く** — 窓口ごとに: 権限が無ければ403、CSRF が無ければ403、回数の制限。招待: アカウントが在る・無いで応答が同じ（本文・状態）／メールが1通だけ送られ URL が `#` の形／**アカウントが在ったお客さんの既存のパスキーとログインが消える（持ち越し 1k: 失効の後、アプリに結び付いていない GoTrue のセッション〔`auth.sessions` に直に作った行〕も消えている。`revoke_auth_sessions_for_user` の結果が1以上）**。PATCH: `user` → `admin` は直に役割が付かず `invited: true`／期限切れだった店員を戻そうとしても同じ（**1j**）／店員どうしの入れ替えは今のまま。やり直し: 確認の語が違うと400、理由が9字だと400、自分自身403、最後の店長409、成功で鍵が0本・役割が `user`・古い招待が取り消し・メールが1通。`create-user` の画面と窓口が404（無いこと）
- [ ] **Step 2: 失敗を確かめる** — 単体・結合 FAIL。`FR-LOGIN-063` は未作成なので E2E は Step 3 の後
- [ ] **Step 3: 実装する** — 窓口3本と PATCH の分岐。**窓口は `staff-invite-store` の関数を呼ぶだけ**（SQL を直に書かない）。メールの送り失敗は招待の行を取り消さず `{ success: true, mailQueued: false }` ではなく、`502` と「メールを送れませんでした。もう一度お試しください」を返し、**行は残して**同じ人に再発行すると古い行が取り消される形にする（理由: 送れたか分からない状態で成功を返さない）。`FR-LOGIN-063`（3幅）: 仮想の認証器で店長として入り、招待・やり直し・上げる・下げるを窓口で叩き、Mailpit の本文を `expect.poll` で読む
- [ ] **Step 4: 通ることを確かめる** — 単体・結合・`FR-LOGIN-063` を3幅 PASS。旧 `/admin/create-user` を触っていた試験は消した/付け替えた結果が緑。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店長の招待・やり直し・上げる・下げるの窓口を足し、旧の利用者の作成を消す`

### Task 6: 招待のリンクの受け口 `/staff/invite`（案 B）

**Files:**
- Create: `src/app/staff/invite/page.tsx`、`src/features/auth/staff/components/StaffInviteScreen.tsx`、`src/app/api/auth/staff/invite/start/route.ts`（`POST`）
- Modify: `src/contexts/Providers.tsx`（`isAuthPage` に `/staff/invite`・`/staff/register`）
- Test: `tests/unit/app/staff/invite-page.test.tsx`、`tests/unit/api/auth/staff-invite-start.test.ts`、`e2e/FR-LOGIN-064-staff-invite-link.spec.ts`
- 文書: `FR-AUTH-041`・`SCR-AUTH-013`・`API-AUTH-036`・`DD-AUTH-077`・`SEC-AUTH-055`（上位 `THR-AUTH-054`）・`IMPL-AUTH-363`〜`368`・`docs/04_DetailDesign/pages/14_login.md`

**Interfaces:**
- 画面は、URL の `#` の合言葉を読み、見出し「店員のパスキーを登録します」と説明（付録）、ボタン「登録を始める」だけを出す。**GET・画面の表示では、合言葉をサーバーに送らない**（`#` はサーバーに届かないので、メールの先読みでは何も起きない）。
- `POST /api/auth/staff/invite/start` 本文 `{ token: string }`: `consumeStaffInvite` → 0行なら 400 `invite_invalid`（期限切れ・使用済み・取り消し・不明を**同じ応答**にする）→ お客さんの扱いのまま GoTrue のセッションを作る（`auth.admin.generateLink({ type: 'magiclink', email })` の `hashed_token` を、サーバーですぐ `verifyOtp({ type: 'magiclink', token_hash })`。フックは役割が無い人なので通す）→ **分かった `session_id`（JWT の claim）で `bindStaffInviteWindow`** → `persistSessionAndCookies()` でアプリの結び付けを書く → `{ redirectTo: '/staff/register' }`。途中で失敗したら、作ったセッションを終わらせ（`endAuthSession`）、招待の行は**使用済みのまま**にして 500 を返し、画面は「店長に、招待をもう一度出してもらってください」と出す（理由: 失敗後に同じ合言葉で繰り返せる形にすると、窓が開いたまま残る道ができる）。
- 回数の制限: IP ごと 20回/10分、合言葉のハッシュごと 5回/10分。応答は no-store。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 画面は `#` が無いと「リンクが正しくありません」。窓口は、使用済み・期限切れ・取り消し・不明が**同じ本文**で400。GoTrue の失敗で窓が開いたまま残らない（`bindStaffInviteWindow` が呼ばれない／呼ばれた後の失敗でセッションを終わらせる）。E2E（`FR-LOGIN-064`・3幅）: ①メールの URL を `fetch` で GET しても、合言葉が使い切られず・Cookie が付かない ②ボタンで `/staff/register` に着き、`/api/auth/me` が `role: 'user'`（役割はまだ無い） ③同じ URL をもう一度開いて押すと「このリンクは使えません」 ④取り消された招待・期限が過ぎた招待（DB で `expires_at` を過去にする）で同じ文
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 上のとおり。`isAuthPage` の単体の試験に2つの URL を足す
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS、`FR-LOGIN-064` を3幅 PASS（`expect.poll` で Mailpit）。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員の招待のリンクの受け口を足す（GET は何もしない・窓は押した時に開く）`

### Task 7: 2本の登録の画面 `/staff/register` と、役割の有効化

**Files:**
- Create: `src/app/staff/register/page.tsx`、`src/features/auth/staff/components/StaffRegisterScreen.tsx`、`src/app/api/auth/staff/register/complete/route.ts`（`POST`）
- Test: `tests/unit/features/auth/staff/staff-register-screen.test.tsx`、`tests/unit/api/auth/staff-register-complete.test.ts`、`e2e/FR-LOGIN-065-staff-register-two-keys.spec.ts`
- 文書: `FR-AUTH-042`〜`043`・`SCR-AUTH-014`・`API-AUTH-037`・`DD-AUTH-078`〜`079`・`IMPL-AUTH-369`〜`374`・`docs/04_DetailDesign/pages/14_login.md`

**Interfaces:**
- 画面（サーバーで、窓が開いているセッションかを確かめ、違えば `/login` へ送る）: 「1本目」「2本目」の2段。段2の `registerPasskey`（`src/features/auth/passkey/passkey-client.ts`）を使い、**窓口の返事で窓の内か外かを決める**（画面で数えない）。2本目の前に「別の端末か、セキュリティキーでの登録をおすすめします」（付録）。2本そろったら `POST /api/auth/staff/register/complete`。
- `POST /api/auth/staff/register/complete`（本文なし）: 現在のセッション（Cookie のアプリの結び付き → JWT の `session_id`）で `activateStaffRole(inviteId は DB が session から引く)` → 成功したら `endAuthSession`＋`revokeAllSessionsForUser` で全ログインを終わらせ、Cookie を消し、`{ redirectTo: '/login' }`。例外は理由ごとに 409 `keys_short`・403 `window_closed`・500。**応答に鍵の ID を載せない**。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 1本だけで「完了」を押すと `keys_short` の文（「あと1本、登録してください」）。窓が閉じたセッションで `complete` が403。成功後の Cookie が消える。E2E（`FR-LOGIN-065`・3幅・仮想の認証器を2つ使う）: 招待 → 押す → 1本目 → 2本目（別の認証器）→ 完了 → `/login` へ。**役割が有効になったこと**（`user_roles`）・認めた鍵が2本・`approved_via = 'window'`・招待の行の `activated_at`。直後に **その認証器で `/login` からパスキーでログインし、`/admin` に入れる**。招待のセッションのトークンで `/api/admin/*` を叩くと403（窓の中でも管理の権限は無い）。窓の外（`expires_at` を過去にする）で `passkey/register/start` が403
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 上のとおり。画面の文・失敗の読み替えは付録
- [ ] **Step 4: 通ることを確かめる** — 単体・`FR-LOGIN-065` を3幅 PASS。`FR-LOGIN-051` が緑のまま。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員の2本の登録の画面と役割の有効化を足す`

### Task 8: 無操作1時間（最後に使った時刻を書く・止める）

**Files:**
- Modify: `src/lib/auth/admin-rbac.ts`（`authorizeAdminPermission` が通ったあと `staffSessionTouch` を呼ぶ。失敗しても通す）、`src/app/api/auth/passkey/login/finish/route.ts`（店員のログインの成功の時に1回書く）
- Create: `src/lib/auth/staff-idle.ts`（`touchStaffSession(sessionId: string, userId: string): Promise<void>`。60秒の間引きは DB 側、アプリ側は新しく間引かない）
- Test: `tests/unit/lib/auth/staff-idle.test.ts`、`tests/unit/lib/auth/admin-rbac-idle.test.ts`、`e2e/FR-LOGIN-066-staff-idle-timeout.spec.ts`
- 文書: `FR-AUTH-044`・`DD-AUTH-080`・`IMPL-AUTH-375`〜`378`

**Interfaces:**
- `admin-rbac` が、条件を1つ増やす: DB の `has_permission` が偽になるのと同じ理由で API も 401 を返す。具体的には `staff_idle_ok` を RPC `staff_idle_check(p_session_id)`（移行 I に足す。`service_role` だけ）で確かめる。**RPC の失敗は断る側**（失敗側に倒す）。401 の本文は `{ error: 'session_idle' }`。画面側（管理画面のレイアウトが呼ぶ `/api/auth/me`）は `staffEntryOk: false` ではなく、新しい理由 `idle` を返し、レイアウトが `/login?reason=idle` へ送る。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 最後に使った時刻が59分前の店員は通り、61分前は401 `session_idle`。行が無い店員は401。RPC が例外を投げたら401。通った後に `staff_session_touch` が呼ばれる。E2E（`FR-LOGIN-066`・3幅）: 店員が入る → DB で `last_seen_at` を61分前に書き換える → `/admin` に着くと `/login?reason=idle` へ送られ、文「しばらく操作がなかったため、ログアウトしました」が出る。59分前なら入れ、**その操作で時刻が更新される**。24時間（`amr` の時刻）の既存の試験が緑のまま
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 移行 I に `staff_idle_check` を足す（Task 3 のファイルを**まだ未適用の間に**直す。MD5 を測り直す）。`admin-rbac` の差を小さくする
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS・`FR-LOGIN-066` 3幅 PASS。`FR-LOGIN-032`（店員の入口）が緑のまま。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員の無操作1時間で API と画面を止める`

### Task 9: 店員のパスキー管理と、1本だけの店員の「もう1本」の画面

**Files:**
- Create: `src/app/admin/passkeys/page.tsx`、`src/features/auth/staff/components/StaffPasskeyManager.tsx`、`src/features/auth/staff/components/StaffOneMoreKey.tsx`
- Modify: `src/app/auth/verified/page.tsx`（認めた鍵が1本の店員を `/admin/passkeys?more=1` へ送る。**TOTP の流れ自体は段4まで残す**）、`src/app/api/auth/passkey/[id]/route.ts`（`DELETE` の店員の下限。下の規則）
- Test: `tests/unit/features/auth/staff/{staff-passkey-manager,staff-one-more-key}.test.tsx`、`tests/unit/api/auth/passkey-delete-staff-floor.test.ts`、`e2e/FR-LOGIN-067-staff-passkey-manage.spec.ts`
- 文書: `SR-AUTH-027`・`FR-AUTH-045`・`SCR-AUTH-015`・`DD-AUTH-081`・`IMPL-AUTH-379`〜`384`

**Interfaces:**
- 一覧・名前の変更・追加は段2の `listPasskeys`・`renamePasskey`・`registerPasskey` を使う。店員の追加は「5分以内のパスキーでの入り直し」が要るので、窓口の `reauth_required` を、画面では「もう一度パスキーでログインしてから追加してください」＋ボタン「パスキーでログインし直す」に読み替える。
- **削除の下限**: `DELETE /api/auth/passkey/{id}` は、その人が店員で、**消すと認めた鍵が `min_approved_passkeys` 未満になる**なら 409 `staff_min_keys`（鍵は消さない）。画面は削除ボタンの前に同じ数え方で止め、文「パスキーは2本以上必要です。先に別のパスキーを登録してください」を出す。GoTrue を直に叩かれると止められない点は、知らせ（5-4）で気づく。
- 「もう1本」の画面（`/admin/passkeys?more=1`）: 認めた鍵が1本の店員が管理画面に入ろうとした時の行き先。説明と、ボタン「パスキーを追加」だけを出す（付録）。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 2本の店員が1本消そうとすると409・画面でも止まる。3本なら消せる。お客さんは最後の1本も消せる（段2の試験が緑）。認めた鍵が1本の店員が `/auth/verified` に来ると `/admin/passkeys?more=1` へ（**回り続けない**: `needsMfa` の無限の遷移を再現する試験を先に赤にしてから直す）。E2E（`FR-LOGIN-067`・3幅）: 一覧に名前・作成日・最後に使った日が出る／名前の変更／2本の店員が削除で止まる／3本目を追加（5分以内のパスキーでの入り直し）して1本消せる／1本だけの店員が入ると「もう1本」の画面に着き、追加すると `/admin` に入れる／GoTrue を直に叩いて足した鍵は一覧に出ず（認めていない）、店員としては入れない
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 上のとおり。管理画面の右上のメニューに「パスキー」の入口を足す（`AdminSideNav.tsx` の既存の置き方に合わせる）
- [ ] **Step 4: 通ることを確かめる** — 単体・`FR-LOGIN-067` 3幅 PASS。`FR-LOGIN-052`（一覧・名前・削除）が緑のまま。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員のパスキー管理と、1本だけの店員のもう1本の画面を足す`

### Task 10: 店員が別の道で入ろうとした時の画面と、1b の M-2

**Files:**
- Modify: `src/features/auth/passkey/components/EmailCodeEntry.tsx` と `src/app/api/auth/email-code/verify/route.ts`（既に 403 `staff_passkey_required` を返す。画面の文を確かめる）、`src/app/api/auth/oauth/callback/route.ts`（Google でフックに拒否された時、画面へ `?error=staff_passkey_required` で戻す）、`src/app/login/page.tsx` の画面部品（`error` の文）、`src/app/api/auth/passkey/login/finish/route.ts`（1b の M-2。`endAuthSession` の失敗を監査に残す）
- Test: `tests/unit/api/auth/oauth-callback-staff.test.ts`、`tests/unit/features/auth/passkey/login-screen-staff-error.test.tsx`、`tests/unit/api/auth/passkey-login-finish-end-session-audit.test.ts`、`e2e/FR-LOGIN-068-staff-other-paths-rejected.spec.ts`
- 文書: `FR-AUTH-046`・`DD-AUTH-082`・`IMPL-AUTH-385`〜`388`

**Interfaces:** 文は「店員の方は、パスキーでログインしてください」（句点つき）の1つだけ。Google・メールのコードのどちらでも同じ文。メールのコードの始めの窓口は**変えない**（登録済みかを漏らさないため。拒否は確定でフックが返す）。

- [ ] **Step 1: 失敗する試験を書く** — 単体: Google の交換が `isStaffPasskeyRequiredError` の時、`/login?error=staff_passkey_required` へ戻り Cookie・セッションが作られない。ログイン画面が `error=staff_passkey_required` を文にする（他の `error` の値は出さない）。M-2: `endAuthSession` が失敗した時、`logAudit` が呼ばれ（`action: 'auth.passkey.login.end_session_failed'`、詳細にエラーコードだけ）、応答は変えない。E2E（`FR-LOGIN-068`・3幅）: 店員（認めた鍵2本）が、メールのコードで確定すると文が出てセッションが作られない／Google は本物を使えないので、コールバックの URL に GoTrue のエラーを模した値を渡す単体で代える（実機は8-2・段3b）／古いパスワードの `/login/password` でも入れない
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 上のとおり
- [ ] **Step 4: 通ることを確かめる** — 単体・`FR-LOGIN-068` 3幅 PASS。`FR-LOGIN-040`（フックの拒否）・`FR-LOGIN-057`（ログイン画面）が緑のまま。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員が Google・メールのコードで入ろうとした時の文を出し、ログインの終わりの失敗を監査に残す`

### Task 11: 管理画面「ユーザー」の画面（招待・やり直し・上げる・下げる）

**Files:**
- Modify: `src/components/UserSection.tsx`
- Create: `src/features/auth/staff/components/{InviteStaffDialog,RedoStaffDialog}.tsx`
- Test: `tests/unit/components/user-section-staff.test.tsx`、`e2e/FR-LOGIN-069-admin-users-staff-screen.spec.ts`
- 文書: `FR-AUTH-046` の続き（受け入れ条件を足す）、`DD-AUTH-082` に追記、`docs/03_BasicDesign/ui/screen-list.md`・`docs/04_DetailDesign/pages/16-3` 系の該当（`grep -ln UserSection docs/04_DetailDesign/pages` で探す）、`SCR-AUTH-016`・`IMPL-AUTH-389`

**Interfaces:** 「ユーザー」の画面に「店員を招待」ボタン（メール・役割の選択）、各店員の行に「パスキーを全部消してやり直す」（確認の語と理由の入力）と「お客さんに戻す」、お客さんの行の役割の選択は「店員にする」に変え、押すと「招待のメールを送ります」と確認してから `PATCH /api/admin/users` を呼ぶ。自分自身の行・最後の店長の行は押せない（理由を行の下に出す）。**店員の行に、認めた鍵の本数（0・1・2）を出す**。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 確認の語が違うと送れない・理由が9字だと送れない・送信中は `disabled` と `aria-busy`・失敗は `LiveMessage` が読む・自分の行・最後の店長の行は押せない。E2E（`FR-LOGIN-069`・3幅）: 画面から招待を出し Mailpit のメールが届く・やり直しで本数が0になる・「店員にする」で役割がすぐには変わらず招待が出る
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 既存の見た目（ダイアログの部品）に合わせる。文は付録
- [ ] **Step 4: 通ることを確かめる** — 単体・`FR-LOGIN-069` 3幅 PASS。`UserSection` を使う既存の試験が緑。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 管理画面のユーザーに店員の招待・やり直し・上げる・下げるの操作を足す`

### Task 12: 段3a の全体の確かめ

**Files:**
- Modify: `docs/06_Operations/db-migrations.md`（H・I を7本の一覧の後ろに足す・9本）、台帳（行 1j・1k を「済み」にし、1a-3・1l に H・I の当て方を書き足す。「4-2 パスキー段2から先への持ち越し」の段3の表の状態欄）、`docs/06_Operations/first-admin-bootstrap.md`（店長の最初の道の予告を1行。本書は段3b）
- Test: なし（確かめだけ）
- 文書: `docs/02_Requirements/areas/auth.md` の `SR-AUTH-026`〜`028` の状態、`docs/05_Quality/reports/` の再生成（`npm.cmd run trace:report`）

- [ ] **Step 1: 確かめる（調整役だけ）** — 3000番を止め、`npx.cmd supabase db reset`。`npm.cmd run lint`・`typecheck`・`npm.cmd test`（単体全件。比べる元は段2の終わり）、DB 結合（`--runInBand`。順番の汚れの既知3件は単独で通ること）、E2E 全件（本番ビルド・3幅）。比べる元は段2の全体の確かめの JSON。新しい赤が無いこと。赤は「単独の再実行 → 他の幅 → goto かアサーションか」で切り分ける
- [ ] **Step 2: 追跡** — `validate-trace`（98 を越えない）・`test:trace-coverage`・`validate-docs`・`trace:report`
- [ ] **Step 3: 持ち越しの着地を台帳に書く** — 下の「持ち越しの着地」の表を、台帳の4-2へ写す（段3b に回した物は行き先を書く）
- [ ] **Step 4: コミット** — `docs(auth): 段3a の全体の確かめと持ち越しの着地を書く`

---

## 持ち越しの着地

| 持ち越し | 着地 |
| --- | --- |
| 1a-3 本番への当て方（A→…→E の順） | 段3b（手順書。H・I が増えて9本） |
| 1a-4 本番の `rp_id`・`postgres` の権限・GoTrue の版・最初の店長の道 | 段3b（手順書と、最後の手段の SQL の `private.staff_invite_issue_manual`＝Task 2） |
| 1i 移行 F の当て方・`Sb-Forwarded-For`・環境変数 | 段3b（手順書） |
| 1j 期限切れ・無効だった役割を戻す時にも「上げる」と同じ | Task 2（`admin_set_user_role` が `STAFF_INVITE_REQUIRED`）・Task 5 |
| 1k 失効がアプリに結び付いていない GoTrue のセッションも消す試験 | Task 5 |
| 1l 段2の持ち越し（`dead` の点検・pg_cron と G の本番登録・心拍） | 段3b |
| 役割を上げる時の鍵の消去とセッションの終了 | Task 2・5 |
| `passkey_approve('reauth')` が鍵を数えず入り直しの承認も確かめない | Task 1（0本は断る）・既存の窓口（入り直しの時刻） |
| 移行 F の `advisory lock` の名前空間 | Task 1 |
| 店員のパスキー管理の画面 | Task 9 |
| Google の拒否の画面 | Task 10 |
| 1b の M-1（昇格・入り直し） | Task 2・5・9 |
| 1b の M-2（`endAuthSession` の失敗の監査） | Task 10 |
| 店長への「やり直しを出した」の知らせ | 段3b |
| `dead` の点検・worker の心拍 | 段3b |
| E2E の `mailsTo`・`mailBodies` を `expect.poll` に | 新しい試験は Task 5 から `expect.poll`。既存の手助けの直しは段3b |
| 一度も入らなかったアカウントの後始末 | 判断10（開店前） |
| 1本だけの店員が `/auth/verified` で回る | Task 9 |
| TOTP の窓口・画面の削除 | 段4（判断6） |

## セルフレビュー

**設計書との対応**: 4-2 の段3の行（招待・2本の登録・やり直し・無操作1時間・Google の拒否・店長への知らせ・最後の手段・役割切り替えの副作用の確認）→ Task 2・5・6・7・8・10、店長への知らせと手順書は段3b。5-5（窓の中の最初の2本・認めた鍵）→ Task 2・7。6-2 の招待 1〜5 → Task 5・6・7（手順3 の案 B は Task 6・7）。上げる・下げる → Task 2・5。ふだんのログイン → 段2と Task 10。パスキーの管理（削除の下限・1本の店員の画面）→ Task 9。やり直し（確認の語・理由・自分自身不可）→ Task 5。ログインの長さ → Task 3・8。Google・TOTP → Task 10・判断6。8-1（今いる人）→ 段3b の手順書。9（E2E の方針）→ 各タスク。

**型・名前の一貫性**: `issueStaffInvite`・`consumeStaffInvite`・`bindStaffInviteWindow`・`activateStaffRole`・`demoteStaff`（Task 4）は、DB 関数 `staff_invite_issue`・`staff_invite_consume`・`staff_invite_bind_window`・`staff_role_activate`・`staff_demote`（Task 2）と1対1。`staff_session_touch`・`staff_idle_ok`・`staff_idle_check`（Task 3・8）。`/staff/invite`・`/staff/register`（Task 6・7・`isAuthPage`）。

**Review Focus**: 5行とも、Task 1・2・5・6・7・8・9・10 の試験に入れた。

**実行順**: Task 1（直し）→ 2・3（移行。画面は変わらない）→ 4（部品）→ 5（窓口。ここで旧の作成画面を消す）→ 6 → 7（登録の画面。招待の一巡が通る）→ 8 → 9 → 10 → 11 → 12。Task 3 の `staff_idle_check` は Task 8 で足すので、**Task 3 と 8 の間は移行 I を適用しない**（手元の `db reset` で毎回作り直す）。

**本番**: 段3a は本番の DB・設定に何も当てない。段3b の手順書とオーナーの許可が無い間は、この master を本番に出さない。

---

## 段3b（概要。3a の終わりに別の計画として書く）

Task 13〜18 を予定する（段3a の結果で細部を直す）。

| Task | 中身 |
| --- | --- |
| 13 | 店長への知らせ: やり直し・招待・上げる・下げるを出した時、**店長全員**に「店員のやり直しを出しました」のメール（設計 10 の最後の行・6-2 のやり直し）。段2 の送り手と同じ表・同じ worker に新しい種類 `staff_redo_issued`・`staff_invited` を足す（移行 J の手元だけの見直しが要るなら、H を直す。未適用の間は同じファイル） |
| 14 | 死んだ知らせ（`dead`）の点検と、worker の心拍（`ops_job_heartbeats` の仕組みに乗る。`src/lib/ops/ops-checks.ts`）。店への警告のメール。**移行 G の `claim` が拾う行の後ろの宛先が約4人を越える時の取りこぼし**（段2の最終レビューの持ち越し）も同じ道で扱う |
| 15 | E2E の `mailsTo`・`mailBodies` を `expect.poll` に直す。`FR-LOGIN-062` の揺れ3件が消えることを全件で確かめる |
| 16 | 本番に当てる手順書 `docs/06_Operations/passkey-production-apply-runbook.md`: 前提（本番の独自のドメイン・`rp_id`・GoTrue v2.196.0・Passkeys が無料のプランで有効にできるか・`postgres` の `TRIGGER`・`SELECT` の権限）、当てる順（A → B → D → F → G → H → I → C → ダッシュボード（Passkeys・フックの登録・TOTP を止める・RP）→ 店長の最初の招待 → アプリのデプロイ → E）、**1本ごとの手順（MCP の `apply_migration`・名前は版と同じ・`md5(statements[1])` の突き合わせ・名前の付け替え）の表**、戻し方の順（フックの登録を外す → F → … の逆順。H・I の戻しを足す）、`pg_cron`（`supabase/pending/schedule_stripe_webhook_worker.sql` を新しい版の移行にして当てる。知らせの worker は同じ毎分の入口に乗る。Vault の `cron_secret`・`app_base_url`）、環境変数、設計 8-2 の9つの確認の表と、段2が足した10〜12。**何も当てない**。当てるのは調整役がオーナーの許可を得た時 |
| 17 | 店長本人の最後の手段と、最初の店長の手順書 `docs/06_Operations/passkey-staff-recovery.md`（`private.staff_invite_issue_manual` をダッシュボードで流し、戻った合言葉で URL を作って自分に送る）と、`first-admin-bootstrap.md` の書き直し（`admin:bootstrap` の位置づけ）。「パスキーを2本以上、別々の端末に持つ」を先頭に書く |
| 18 | 段3全体の最終の確かめ（段3a と同じ形）と、オーナーに渡す開店前の残りの一覧（後始末・物理キー・本物の Google・8-2 の確認） |

---

## オーナーに聞くこと

重要な順。「おすすめ」を付けた。計画は、どれも (おすすめ) で書いてある。

1. **本番に移行を当てる時期（設計 8-2 と 4-3 の食い違いを含む）** — 設計は「本番の独自のドメイン（パスキーの住所）が決まるまで、本番のパスキーは有効にしない」と「移行を当てるとだれも管理の権限を持てない」の両方を書く。調べると、権限を失わせるのは移行 E・フックの登録・アプリのデプロイの3つで、**A・B・D・F・G・H・I は単独では権限を奪わない**（B はフックを登録しなければ動かない・E は店員が2本ずつ持つまで当たらない前の確かめがある）。C は鍵の足し・消しの引き金で、戻しにサポートが要る（段1a の節）。選ぶ: (A) **ドメインが決まるまで、9本とも当てない（おすすめ）**。本番はまだ公開しておらず、先に当てても得が無いため。 / (B) 害の無い物（A・B・D・F・G・H・I）だけ今当て、C・E・フック・デプロイはドメインの後。開店当日の作業が減るが、本番の DB が手元と違う版になる期間が長い。 / (C) 全部今当てて、ドメインまで本番の管理画面に入れなくなる。
2. **本番の最初の店長をどう作るか**（招待は店長が出す物なので、本番には最初の1人を出す道が要る） — (A) **ダッシュボードの SQL（`private.staff_invite_issue_manual`）で最初の招待の合言葉を作り、自分のメールにリンクを組んで送る（おすすめ。店長の最後の手段と同じ道なので、手順書を1本で済ませられ、手元で必ず試せる）**。 / (B) 今の `npm run admin:bootstrap`（パスワード＋認証アプリ）を残して最初の店長を作り、デプロイの後でパスキーを登録する。段4で消す物を延命することになり、デプロイの順の窓が狭い。 / (C) 移行 E を最後に当て、E の前の確かめを通す1人を、手で `approved_via = 'script'` で作る。本番の表を手で書くので勧めない。
3. **お客さんにも見える言葉ではないが、店員が読むメール・画面の文面（下の付録）** — (A) **付録のとおり進める（おすすめ）**。 / (B) 直したい所を伝える。
4. **認証アプリ（TOTP）の画面・窓口を消す段** — (A) **段4（おすすめ。計画は今これ）**。段3a ではパスキーに移れるが、旧画面が1つの段だけ余る。 / (B) 段3a で消す。段4の作業が減るが、`FR-LOGIN-0*` の TOTP の試験を段3a で一緒に消すので、範囲が広がる。
5. **招待のリンクの形** — (A) **URL の `#`（断片）に合言葉を置く（おすすめ。アクセスのログ・Referer に残らない）**。 / (B) 今の再設定と同じ `?token=`（メールの先読みの機械が GET しても使い切られないが、サーバーのログに残る）。

## 付録: 店員に見える文面の案

**招待・上げる・やり直しのメール（Task 4）**
- 件名: 「店員のアカウントの登録のご案内」。本文: 「Le Fil des Heures の{店長／サポーター}として、パスキーの登録をお願いします。／下のリンクを開き、ボタンを押して、顔認証・指紋・PIN で入る方法（パスキー）を2本登録してください。2本目は、別の端末かセキュリティキーでの登録をおすすめします。／{URL}／リンクの有効期限は {日時（日本時間）} までです。ご自身で心当たりがない場合は、何もしないでください。」
- やり直しの時は、冒頭に「これまでのパスキーはすべて削除されました。」を足す。

**招待の受け口（Task 6）**: 見出し「店員のパスキーを登録します」。説明「登録は30分以内に終えてください。このあいだ、管理画面は使えません。」。ボタン「登録を始める」。失敗「このリンクは使えません。店長に、もう一度招待を出してもらってください。」

**2本の登録（Task 7）**: 見出し「パスキーを2本登録してください」。1本目「1本目を登録」。2本目の前「別の端末か、セキュリティキーでの登録をおすすめします。」。1本だけで完了「あと1本、登録してください。」。完了「登録が終わりました。パスキーでログインしてください。」。窓が切れた「時間が過ぎました。店長に、もう一度招待を出してもらってください。」

**管理（Task 9）**: 削除の下限「パスキーは2本以上必要です。先に別のパスキーを登録してください。」。もう1本「管理画面を使うには、パスキーがあと1本必要です。」。入り直し「安全のため、もう一度パスキーでログインしてから追加してください。」

**拒否・無操作（Task 8・10）**: 「店員の方は、パスキーでログインしてください。」「しばらく操作がなかったため、ログアウトしました。」

**ユーザーの画面（Task 11）**: 「店員を招待」「パスキーを全部消してやり直す」（確認の語「やり直し」・理由10字以上）「お客さんに戻す」「店員にする（招待のメールを送ります）」。自分の行「自分自身は変更できません。」最後の店長「店長を1人以上残してください。」
