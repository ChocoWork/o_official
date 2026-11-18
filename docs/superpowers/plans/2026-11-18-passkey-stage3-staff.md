# パスキー 段3（店員）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** パスキー置き換えの段3として、店員（店長・サポーター）がパスキーだけで入れるようにする。店長が店員を招待し・やり直しを出し・お客さんから店員へ上げ・下げられるようにし、店員が招待のリンクから2本のパスキーを登録して役割を有効にし、無操作1時間で止まり、メールのコード・Google で入ろうとしたら「店員の方は、パスキーでログインしてください」と出し、管理画面でパスキーを管理できるようにする。段3は2つに分ける。**段3a（この計画の本文）= コードと画面。段3b（末尾の概要）= 店長への知らせ・死んだ知らせの点検・本番に当てる準備（手順書・ダッシュボード・8-2 の確認）。**

**Architecture:** (1) 先に1b の持ち越し（移行 F の鍵の名前空間・`passkey_approve('reauth')` の厳しくする直し）を直し、次に新しい移行 H を手元に作り（招待の表、役割の有効化・降格・最後の手段の関数、`admin_set_user_role` の作り直し）、未適用の移行 C（窓の中の人を店員として積む）・D（無操作1時間の表と関数）・E（`has_permission` の4つ目の条件）を同じファイルのまま直す。(2) 店長の窓口（招待・やり直し・上げる・下げる）は、すべて「その人のパスキーを全部消し・ログインを全部終わらせ・役割を止め・合言葉を出す」の同じ関数を通す（設計 6-2。持ち越し 1j・1k もここ）。(3) 招待のリンクの受け口（GET は何もせず、ボタンの POST でだけセッションを作り窓を開ける。案 B）と、2本の登録の画面を作り、2本そろったら役割を有効にして終わらせる。(4) 無操作1時間はアプリの窓口で最後に使った時刻を書き（数分に1回に間引く）、API と RLS が読む。(5) 店員のパスキー管理・1本だけの店員の画面・拒否の画面を足し、`/admin/create-user` を消す。(6) 本番へ当てる準備は段3b。

**Tech Stack:** Next.js App Router（Route Handler・Client Component）、`@supabase/supabase-js` 2.119.0（固定）、`zod`、Postgres 17（手元の Supabase）、GoTrue v2.196.0、Jest、React Testing Library、Playwright（本番ビルド・Chromium の CDP の仮想の認証器）、`tsx`。

**Spec:** [docs/superpowers/specs/2026-11-07-passkey-auth-design.md](../specs/2026-11-07-passkey-auth-design.md)（正本。特に 4-2 の段3の行、4-3、5-2、5-4、5-5、6-2、8-1、8-2、9、10、12、12-2）。手元の試し結果は [2026-11-16-passkey-local-trial-results.md](../specs/2026-11-16-passkey-local-trial-results.md)（T2・T3・T6）。前の計画は [段2](2026-11-17-passkey-stage2-customers.md)・[段1b](2026-11-17-passkey-stage1b-server-endpoints.md)、台帳は `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（行 1a-3・1a-4・1i・1j・1k・1l と「4-2 パスキー段2から先への持ち越し」）。ブランドは `docs/01_Planning/brand.md`（CLAUDE.md が書く `docs/1_RequirementsDifinition/brand.md` は無い）。実行する人は、この計画と設計書の両方を読む。

## 分け方（段3が持つ範囲）

| 計画 | 中身 |
| --- | --- |
| 1a・1b・2（済み。push 済み） | 土台、フック、管理の入口の3つの条件、パスキーの窓口、お客さんの画面・メールのコード・知らせの送り手 |
| **段3a（この文書の本文。Task 1〜12。2b・6b を含み14本）** | 持ち越しの直し、移行 H（手元だけ。C・D・E・F も直す）、招待・やり直し・上げる・下げる、招待の受け口と2本の登録の画面、無操作1時間、店員のパスキー管理、拒否の画面、「ユーザー」の画面 |
| 段3b（末尾の概要。3a の後に別の計画として書く） | 店長への知らせ（やり直し・招待）、死んだ知らせの点検と worker の心拍、E2E のメールの待ち、本番に当てる手順書（順・突き合わせ・戻し方・pg_cron・ダッシュボード・8-2）、最初の店長（最後の手段）の手順書 |
| 段4（片付け） | パスワード・認証アプリの画面・窓口・表・試験を消す。お客さんの `password` の拒否を有効にする |

**1つの文を先に書く（本番の安全）**: 段3a は本番の DB に何も当てない。段3a が済んでも、段3b の手順書とオーナーの許可が無い間は、この master を本番に出さない。

## 作り手の判断（私が決めた物と、理由の1行）

設計書が決めていない・食い違う点。違えばオーナーが直す。

1. **役割の有効化は、新しい DB 関数 1か所だけを通す（持ち越し 1j）**: `admin_set_user_role` を作り直し、`admin`・`supporter` への変更は「今、有効な店員」でなければ `STAFF_INVITE_REQUIRED` で断る。お客さんから上げる・期限切れ・無効だった役割を戻す、のどれも招待の行を作る道に落ちる。店員同士（店長とサポーターの入れ替え）と、`user` への降格は今のまま通す。理由: 窓口を足すたびに忘れる穴を DB で塞ぐ。
2. **上げる・やり直すは同じ関数 `staff_invite_issue`（中身は共通の本体 `staff_invite_issue_core`）**: 鍵（`auth.webauthn_credentials` と認めた表）と **TOTP の要素（`auth.mfa_factors`）**を全部消し、役割を止め、古い招待を取り消し、新しい招待の行を作る。ログインを全部終わらせるのは、窓口が続けて `revokeAllSessionsForUser` を呼ぶ（持ち越し 1k。アプリに結び付いていない GoTrue のセッションも消えることを試験で確かめる）。**店長の最後の手段（`last_resort`）は別の口 `private.staff_invite_issue_manual`**で、`postgres`（ダッシュボードの SQL）だけが呼べる。`service_role` が呼ぶ口（`staff_invite_issue`）は `last_resort` を断る。
3. **最後の1人の店長は、やり直せない**（対象が今の有効な店長で、ほかに有効な店長がいない時の `LAST_ADMIN_REQUIRED`）。店長本人の最後の手段は、ダッシュボードの SQL `private.staff_invite_issue_manual(email, role, ttl)`（合言葉の期限は**既定1時間**。発行を監査に残す）。この関数は、最初の店長を本番に作る道も兼ねる（質問 2）。
4. **無操作1時間は、アプリの表 `private.staff_session_activity`**（設計 11 で作り手に任された。`auth.sessions.refreshed_at` は GoTrue の更新で動くので基準にしない）。**表と関数（`staff_session_touch`・`staff_idle_ok`・`staff_idle_check`・`staff_idle_peek`）は、未適用の移行 D のファイルに足す。`has_permission` の4つ目の条件だけを、未適用の移行 E に足す**（`has_permission` の置き換えは E が持つため）。理由: アプリ（`admin-rbac` など）は `staff_idle_check` を呼ぶので、これらの関数が **E より前（権限を奪わない移行）**に在れば、デプロイから E までの間も管理 API が 503 にならない。なお手元の `db reset` は版の順に当てるので、E の前の確かめ（`to_regprocedure` が在ること）を満たすには、E より前の版（D）に置く必要がある。移行 H には置かない（H は E の後の版）。行が無い時は `auth.sessions` の時刻で始める（ログインの終わりを通らない試験・手元の開発のセッションが永久に断られない）。
5. **招待とやり直しの合言葉の作りは、今の再設定の合言葉と同じ**（SHA-256 で保存・使い切り・GET は何もしない・期限24時間）。ただし表は新しく作る（再設定の表は段4で消える）。
6. **認証アプリ（TOTP）の窓口と画面は段4で消す**（4-2 の表のとおり。6-2 の「消す」は段の指定が無い）。ただし `/auth/verified` に1本だけの店員が来て回り続ける問題（1b の持ち越し）は Task 9 で直す。`/admin/create-user` と `/api/admin/create-user` は、パスワードを直に入れる物なので段3a で消す（6-2 の招待の1）。
7. **店員の画面の置き場**: 招待の受け口は `/staff/invite`、2本の登録は `/staff/register`（どちらもログインの外の画面。`isAuthPage` に足す）。パスキー管理は、管理画面の「ユーザー」の下ではなく、管理画面の右上の自分のメニューから行く `/admin/passkeys`（店員だけ。お客さんは `/account` の「ログイン方法」）。
8. **E2E のファイル名はすべて `e2e/FR-LOGIN-NNN-*.spec.ts`**（段2の判断7と同じ。追跡の範囲 AUTH が拾うため）。
9. **ADR-0471 以後は AUTH の範囲に入らない**ので、Task 2 で `scripts/trace/scope.json` に `ADR-047[1-9]*.md` を足し、`decisions/README.md` の AUTH の帯の行を「0463〜0472」にそろえる。
10. **一度も入らなかったメールのコードのアカウントの後始末は、開店前に回す**（台帳の4-2のとおり。段3には入れない）。理由: 店員の流れと関係が無く、`last_sign_in_at IS NULL` の消し方は別の定期処理になる。段3b の手順書に「開店前の残り」として1行書く。
11. **1b の M-2（`login/finish` の `endAuthSession` の失敗が静か）は Task 10 で直す**（その窓口を Task 10 が触るため）。
12. **作り手が黙って決めた物（オーナーに見せる。末尾の質問の下の節）**: 招待・上げるを出した瞬間に、相手が今お客さんとして持つパスキーとログインが消える（設計 6-2 どおり）。メールの送りに失敗しても鍵とログインは消えたまま。発行が消した鍵の「削除」のメールは出さない（`skipped`）。店員どうしの切り替え（店長とサポーター）はやり直し無しで通す。招待の取り消しの道を足した。無操作の時刻を書くのは、管理の API・店員のパスキー窓口・ログインの終わりだけ。
13. **登録の窓口は、招待の窓の中の人を `window` として扱う**（Task 6b）。案 B では役割が③まで無いので、今の窓口は「お客さん」と見なして鍵を認めない（レビュー C-1）。
14. **`/admin/passkeys` を管理画面の右上の自分のメニューから開く形は、設計に書かれていない作り手の判断**（Task 9。`screen-list.md` と付録に書く）。

## Global Constraints

1a・1b・2 の決まりを引き継ぎ、段3で足す物を書く。全部のタスクの要件に含まれる。

**本番の安全（オーナー決定 2026-11-16・段3も同じ）**

- **段3a は本番の DB に何も当てない**。Supabase の MCP（`apply_migration`・`execute_sql` など）はサブエージェントから使わない。`supabase db push`（どの形でも）と `workflow_dispatch` は流さない。`.env*` は読まない・表示しない。`graphify update` は流さない（コミットのフックが後で流す）。
- 本番に当てるのは調整役だけで、オーナーの許可を得た時に、1本ずつ MCP の `apply_migration`。当てた後は `md5(statements[1])` をファイルの MD5 と突き合わせ、ファイルの名前を当てた版に合わせる（段3b の手順書）。
- パスキーの移行は今7本（A〜G）。**段3a で H（新しい1本）を足して8本**。H のほかに、**未適用の C・D・E・F を同じファイルのまま直す**（Task 1・2・3。MD5 が変わる）。`docs/06_Operations/db-migrations.md` の「段3まで `db push` しない」一覧に H を足す。移行の版は作る時の時刻で付け、最新（`20261118044338`）より後にする。この計画の `<時刻>` は仮。
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
  `SR-AUTH-026`〜`029`、`FR-AUTH-034`〜`046`、`API-AUTH-033`〜`038`、`DD-AUTH-069`〜`084`、`IMPL-AUTH-339`〜`396`、`SEC-AUTH-052`〜`057`、`THR-AUTH-051`〜`055`、`DATA-AUTH-020`〜`022`、`SCR-AUTH-013`〜`016`、`ARC-AUTH-012`〜`013`、`ADR-0471`（店員の招待・やり直し・役割の有効化）〜`0473`（`0472` は無操作の表の判断）、E2E は `e2e/FR-LOGIN-063`〜`074`（段3a は 063〜070、段3b は 071〜074）。
- **DD の親の決め**（構造設計か SEC。SEC の親は THR）: DD-AUTH-070〜072・075・078・080 → `SEC-AUTH-053`、DD-AUTH-073 → `SEC-AUTH-054`、DD-AUTH-074・081・082 → `SEC-AUTH-055`、DD-AUTH-076・077・084 → `SEC-AUTH-056`、DD-AUTH-079 → `SEC-AUTH-057`、DD-AUTH-083 → 既存の `SEC-AUTH-037`（フックが店員のパスキー以外を断る）。SEC の親: `SEC-AUTH-052` → `THR-AUTH-051`、`SEC-AUTH-053`・`054` → `THR-AUTH-052`、`SEC-AUTH-055` → `THR-AUTH-054`、`SEC-AUTH-056` → `THR-AUTH-055`、`SEC-AUTH-057` → `THR-AUTH-053`。
- **追跡の範囲の足し方**（足すたびに `validate-trace` と `test:trace-coverage` を流す。**足し忘れると親の無い違反でベースライン98を越える**）: Task 2 で `scope.json` の AUTH の `docs` に `ADR-047[1-9]*.md`、`src` に `src/app/staff/**/*.{ts,tsx}`・`src/app/admin/passkeys/**/*.{ts,tsx}`・`src/app/api/admin/staff/**/*.ts`・`src/features/auth/staff/**/*.{ts,tsx}`・`src/lib/auth/staff-passkey-page-guard.ts`（既存の `staff-passkey*.ts` の型に入る名前にそろえる）、`tests` に `tests/unit/features/auth/staff/**/*.test.{ts,tsx}`・`tests/unit/app/staff/**/*.test.{ts,tsx}`・`tests/unit/api/admin/staff/**/*.test.ts`・`tests/integration/api/admin-staff-*.test.ts`。`admin-rbac.ts`・`UserSection.tsx` は AUTH の外なので、**呼ぶ・差し込むだけにして `@impl` を足さない**。Task 5 で ADMIN の範囲から `create-user` を外す。

## Review Focus

先頭ほど起きやすい。

1. **招待の人の鍵が `window` で認められるか、窓の外・別人・別のセッションで使えないか**: 役割が無い間も窓の中の2本が認められ、窓が閉じた後・30分を過ぎた後・別の `session_id`・別のユーザーの合言葉・使い切った合言葉・取り消した合言葉で、登録の窓口・役割の有効化が全部断られ、お客さんの道に落ちないか。GET（メールの先読み）で合言葉が使い切られず、セッションも作られないか（Task 6・6b・7）
2. **上げる・やり直す時に古い入口が残らないか**: 鍵と **TOTP の要素**が全部消え、GoTrue のセッション（アプリに結び付いていない物も）が全部消え、役割が止まり、古い招待が取り消されるか。期限切れ・無効だった役割を戻す道も同じ関数を通るか。最後の手段がアプリの鍵で呼べないか。同時にやり直して店長が0人にならないか。途中で失敗しても半端な状態が残らないか（Task 2・2b・5）
3. **役割の有効化の門**: 鍵が1本・前の招待の窓で認めた鍵・認めていない鍵・GoTrue を直に叩いて足した鍵が混ざる時、役割が有効にならないか。有効にした後は窓が閉じ、招待のセッションが終わるか（Task 2・7）
4. **無操作1時間と24時間**: 59分と61分、時計のずれ、最後に使った時刻の行が無いセッション（`auth.sessions` の時刻で始め、永久に断られないか）、書き込み・RPC の失敗で永久に401にならないか、店員のパスキー窓口にも効くか、間引きで1時間を越えて延びないか（Task 3・8）
5. **店員が別の道で入ろうとした時**: メールのコード・Google・古いパスワードで、セッションも Cookie も作られず、お客さんには見えない文面で止まり、「登録済みかどうか」を漏らさないか。1本だけの店員が `/auth/verified` で回り続けないか（Task 9・10）

---

## ファイルの全体図

| 区分 | ファイル | タスク |
| --- | --- | --- |
| 変える（未適用の物を同じファイルで） | 移行 F `20261117123620_...`（鍵の名前空間・reauth）、移行 C `20261116232141_...`（窓の中の人を店員として積む）、移行 D `20261117001500_...`（無操作1時間の表と関数）、移行 E `20261117013000_...`（`has_permission` の4つ目の条件） | 1・2・3 |
| 作る | `supabase/migrations/<時刻>_passkey_staff_invites.sql`（H。前半 Task 2・後半 Task 2b） | 2・2b |
| 作る | `src/features/auth/staff/invite-token.ts`、`invite-mail.ts`、`staff-invite-store.ts` | 4 |
| 作る | `src/app/api/admin/staff/invites/route.ts`、`[id]/redo`・`demote`・`invite/cancel` の `route.ts` | 5 |
| 変える・消す | `src/app/api/admin/users/route.ts`（PATCH）、`src/app/admin/create-user/`・`src/app/api/admin/create-user/` を消す。ADMIN の文書と `scope.json` の廃止 | 5 |
| 作る | `src/app/staff/invite/page.tsx`、`StaffInviteScreen.tsx`、`src/app/api/auth/staff/invite/start/route.ts` | 6 |
| 変える | `src/lib/auth/passkey-registration-guard.ts`・`passkey-recent-auth.ts`・`register/{start,finish}/route.ts`（招待の窓の中の人を `window` に） | 6b |
| 作る | `src/app/staff/register/page.tsx`、`StaffRegisterScreen.tsx`、`src/app/api/auth/staff/register/complete/route.ts` | 7 |
| 作る・変える | `src/lib/auth/staff-passkey-idle.ts`、`admin-rbac.ts`・`passkey-manage-guard.ts`・`login/finish/route.ts`・`/api/auth/me`（無操作・24時間） | 8 |
| 作る・変える | `src/app/admin/passkeys/page.tsx`、`StaffPasskeyManager.tsx`、`StaffOneMoreKey.tsx`、`staff-passkey-page-guard.ts`、`auth/verified/page.tsx`、`passkey/[id]/route.ts` | 9 |
| 変える | `EmailCodeEntry.tsx`・`oauth/callback`・`/login` の文・`mfa/enroll-totp/route.ts`（410）・`login/finish/route.ts`（M-2） | 10 |
| 変える | `src/components/UserSection.tsx`（差し込むだけ）、`InviteStaffDialog.tsx`・`RedoStaffDialog.tsx`・`StaffRoleActions.tsx` | 11 |
| 作る | `e2e/FR-LOGIN-063`〜`070` | 各タスク |

---

## Tasks

### Task 1: 1b からの持ち越しの直し（移行 F の鍵の名前空間・`passkey_approve('reauth')`）

**Files:**
- Modify: `supabase/migrations/20261117123620_passkey_server_endpoint_fns.sql`（F。**本番未適用なので同じファイルを直す**。大きさと MD5 を測り直す）
- Test: `tests/integration/db/auth_passkey_server_fns.integration.test.ts`（足す）
- 文書（同じコミット）: `docs/06_Operations/db-migrations.md` の移行 F の節（大きさ・MD5・手元の `md5(statements[1])`）、台帳の行 1l の持ち越しの「役割を上げる時の鍵の消去…」の状態欄、`SEC-AUTH-052`（上位 `THR-AUTH-051`）・`DD-AUTH-069`（上位 `SEC-AUTH-052`）・`IMPL-AUTH-339`

**Interfaces:**
- Consumes: 既存の `public.passkey_approve(p_user_id uuid, p_passkey_id uuid, p_via text)`（F の `reauth` の枝）。
- Produces: 同じ署名。変わるのは (1) `pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0))` を `hashtextextended('passkey_approve:' || p_user_id::text, 0)` にする（ほかの機能が同じ `hashtextextended(uuid::text, 0)` の鍵を使う時に混ざらない名前空間。`admin_set_user_role` の `(190519, 0)` は2つの整数の別の鍵の空間なので元から混ざらない）、(2) `p_via = 'reauth'` は、その人の認めた鍵が1本以上あり、かつ**呼ぶ側が「5分以内のパスキーでの入り直し」を確かめた**印（新しい引数ではなく、`private.passkey_staff_settings()` を使わず、関数の中で `passkey_approved_count(p_user_id) >= 1` を確かめるだけ。0本の店員が `reauth` で足すことは `window` の道でしか許さない）。確かめて外れたら `PASSKEY_REAUTH_NOT_ALLOWED`（`ERRCODE = '42501'`）。入り直しの時刻の確かめは窓口（`passkey-recent-auth.ts`）に残る。

- [ ] **Step 1: 失敗する試験を書く** — (a) `reauth` で、認めた鍵が0本の店員を承認しようとすると `PASSKEY_REAUTH_NOT_ALLOWED`。(b) 1本ある店員では通る。(c) `window`・`script` の枝は変わらない（0本でも通る）。(d) 関数の本体に `'passkey_approve:'` が入っている（`prosrc` を読む）。(e) 同じ人の2つの接続から同時に `window` で2本を承認すると、順に進み、本数が2本でちょうど止まる（既存の試験の形） (f) **`passkey_approve` は、`window`・`reauth`・`script` のどの枝でも、同じ `hashtextextended('passkey_approve:' || ...)` の鍵を最初に取る**。`reauth` の承認と `staff_invite_issue` を同時に流しても、消えた鍵の承認の行が残らない（`approved_passkeys` には外部キーが無い）
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/integration/db/auth_passkey_server_fns.integration.test.ts`（`db reset` の後）→ (a)(d) が FAIL
- [ ] **Step 3: 実装する** — F の `passkey_approve` の本体を直す。ヘッダーの ROLLBACK も合わせる。`npx.cmd supabase db reset` で適用できること
- [ ] **Step 4: 通ることを確かめる** — 上の試験と、`auth_passkey_*` の DB 結合が全部 PASS。`FR-LOGIN-051`（店員の登録）を3幅 PASS。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `fix(auth): 移行 F の承認の鍵に名前空間を付け、入り直しの承認が0本の店員を通さないようにする`

### Task 2: 移行 H の前半（招待の表・発行・消費・結び・有効化・取り消し）と、移行 C の直し

**Files:**
- Create: `supabase/migrations/<時刻>_passkey_staff_invites.sql`（H。後半は Task 2b で同じファイルに足す）
- Modify: `supabase/migrations/20261116232141_passkey_credential_events.sql`（C。**本番未適用なので同じファイルを直す**。MD5 を測り直す）、`scripts/trace/scope.json`（下の「追跡の範囲の足し方」）、`docs/03_BasicDesign/decisions/README.md`
- Test: `tests/integration/db/auth_passkey_staff_invites.integration.test.ts`、`auth_passkey_credential_events.integration.test.ts`（足す）
- 文書（同じコミット）: `docs/06_Operations/db-migrations.md` に「パスキー段3 移行 H」の節（大きさ・MD5・前の確かめ・末尾の確かめ・戻し方・本番へ当てない）と、移行 C の節の MD5 の直し、`SR-AUTH-026`・`FR-AUTH-034`〜`036`・`DATA-AUTH-020`・`THR-AUTH-051`（Task 1）とは別に `THR-AUTH-052`（招待の合言葉・窓の悪用）→ `SEC-AUTH-053` → `DD-AUTH-070`〜`072`・`IMPL-AUTH-340`〜`346`、`ADR-0471`（店員の招待・やり直し・役割の有効化。構造設計の子 `ARC-AUTH-012`）

**Interfaces（すべて `SECURITY DEFINER`・`search_path` 空・持ち主 `postgres`・`service_role` だけが `execute`。例外は明記。どの関数も `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` の後に、必要な役へだけ `GRANT`する。`search_path` が空なので、拡張の関数は `extensions.gen_random_bytes`・`extensions.digest` と書く）:**
- 表 `private.staff_invites(id uuid pk default gen_random_uuid(), user_id uuid not null, role_code text check in ('admin','supporter'), kind text check in ('invite','redo','promote','last_resort'), token_hash bytea not null unique, issued_by uuid, reason text, expires_at timestamptz not null, consumed_at timestamptz, session_id uuid, bound_at timestamptz, activated_at timestamptz, cancelled_at timestamptz, created_at timestamptz default now())`。1人に付き「取り消されておらず・有効化されていない」行は最大1（部分の一意索引）。RLS 有効・`anon`・`authenticated` の権限なし。
- 共通の本体 `private.staff_invite_issue_core(p_user_id uuid, p_role_code text, p_kind text, p_issued_by uuid, p_reason text, p_token_hash bytea, p_ttl_seconds integer, p_allow_last_admin boolean) returns uuid`（**どの役にも `execute` を渡さない。呼ぶのは下の2つの口だけ**）。**1つの取引**で、順に: ①鍵の取り方 — **全体の `pg_advisory_xact_lock(190519, 0)` を先に、次にその人の `pg_advisory_xact_lock(hashtextextended('passkey_approve:' || p_user_id::text, 0))`**（`admin_set_user_role`・`passkey_approve` と同じ順。この順を破ると行き止まりになるので、本体のコメントと試験に書く）①の直後（鍵を取った後）に、**発行する人が今も有効な店長で `admin.users.manage` を持つか**を確かめる（外れたら `ROLE_PERMISSION_FORBIDDEN`。窓口の確かめと DB の書き込みの間に降格された店長の要求を通さない。最後の手段〔`p_allow_last_admin` が真〕だけは飛ばす）。②対象が**今の有効な店長で、ほかに有効な店長がいない**時は `LAST_ADMIN_REQUIRED`（`p_allow_last_admin` が真なら飛ばす）③`p_issued_by = p_user_id` は `SELF_ROLE_CHANGE_FORBIDDEN` ④古い開いた行を `cancelled_at` で閉じ、開いている窓を閉じる ⑤`private.approved_passkeys` と `auth.webauthn_credentials` のその人の行を全部消す（`auth.webauthn_credentials` は `DELETE ... RETURNING id` で、消した鍵の id を控える） ⑥**`auth.mfa_factors` のその人の行（TOTP・電話・webauthn の種類と状態を問わず全部。**TOTP だけにしない**。aal2 を求められるのは TOTP に限らないため。消すのはその人の要素だけ）を全部消す**（GoTrue が要素の残る人に、パスキーの登録・削除で aal2 を求めて止めるため。設計 6-2・8-1） ⑦`user_roles` の `active` を全部 `false`、`auth.users.raw_app_meta_data.role` を `user` ⑧⑤で控えた鍵の id について、移行 C の引き金が積んだ行（`user_id`・`kind = 'passkey_removed'`・`passkey_id` が控えた id の中）だけを、同じ取引の中で `status = 'skipped'`・`last_error_code = 'staff_invite_issue'`・`finished_at = now()` にする（`skip_passkey_notification` と同じ形。**消した鍵の数だけメールが本人と店長に届くのを避け、店長への知らせは段3b の「やり直しを出しました」1通に寄せる**） ⑨新しい行を作って `id` を返す。**期限切れ・無効だった役割を戻す道も、`admin_set_user_role` を通らずこの関数に来る**。
- `public.staff_invite_issue(p_user_id uuid, p_role_code text, p_kind text, p_issued_by uuid, p_reason text, p_token_hash bytea, p_ttl_seconds integer default 86400) returns uuid` — `p_kind` が `invite`・`redo`・`promote` 以外（`last_resort` を含む）は `STAFF_INVITE_KIND_FORBIDDEN`。対象が今の有効な店員なのに `p_kind <> 'redo'` なら `STAFF_ALREADY_STAFF`。それ以外は `staff_invite_issue_core(..., false)`。
- `public.staff_invite_consume(p_token_hash bytea) returns table(invite_id uuid, user_id uuid, role_code text)` — 未使用・未取り消し・期限内なら `consumed_at` を入れて返す。**ここでは窓を開けない**。外れたら0行。**ハッシュの入力は、base64url の合言葉の文字列の UTF-8 のバイト**（SQL は `extensions.digest(convert_to(token, 'UTF8'), 'sha256')`、アプリは `createHash('sha256').update(token, 'utf8')`。生の32バイトにはかけない）。
- `public.staff_invite_bind_window(p_invite_id uuid, p_session_id uuid) returns void` — 案 B の②。`consumed_at` 済み・`session_id` 未設定の行に `session_id`・`bound_at = now()` を入れ、`public.passkey_window_open(user_id, session_id)` を呼ぶ。2度目は `STAFF_INVITE_ALREADY_BOUND`。
- `public.staff_role_activate(p_user_id uuid, p_session_id uuid) returns jsonb` — 案 B の③。DB が `(user_id, session_id)` で行を引く（見つからない・有効化済み・取り消し済みは `STAFF_ACTIVATE_INVITE_INVALID`）。**門の規則は1つだけ**: ①窓が今も開いている（`STAFF_ACTIVATE_NO_WINDOW`）②その人の `auth.webauthn_credentials` が**全部**認めた鍵で、**全部** `approved_via = 'window'` かつ `approved_at >= bound_at`、本数が `min_approved_passkeys` 以上（外れたら `STAFF_ACTIVATE_KEYS_SHORT`／`STAFF_ACTIVATE_KEYS_NOT_WINDOW`。前の招待の窓で認めた鍵・認めていない鍵が1本でも残れば通らない）。取り方は発行と同じ順（190519 → その人の鍵）。満たせば `user_roles` と `raw_app_meta_data.role` を有効にし（`assigned_by = issued_by`）、`activated_at` を入れ、窓を閉じ、`{ "role": ... }` を返す。
- `public.staff_invite_cancel(p_user_id uuid) returns void` — 開いている招待を取り消し、窓を閉じる（鍵・役割はそのまま）。
- **前の確かめ（本番の権限。外れたら `PASSKEY_MIGRATION_PRECHECK_FAILED`、`passkey_h_precheck`）**: `postgres` が `auth.mfa_factors`・`auth.webauthn_credentials` に `DELETE`、`auth.users` に `UPDATE`、`auth.sessions` に `SELECT` を持つ（`has_table_privilege`）。同じ確かめを段3b の手順書の「前提」にも書く。
- 移行 C の直し: 引き金の関数が `subject_is_staff` を決める所を読み、**`private.passkey_registration_windows` に開いた行（`closed_at IS NULL` かつ期限内）がある人を店員として積む**（`notify_subject` は今のまま）。理由: 招待の窓の中で足した鍵は、足した時点では役割が無効だが、設計 5-4 は店員の足しを店長にも知らせると決めている。

- [ ] **Step 1: 失敗する試験を書く** — 1つずつをテスト名にする。(1) 発行で鍵・認めた鍵・**TOTP の要素（`auth.mfa_factors` に1件入れておく）**・役割・古い招待が消え/止まり、行が1つだけ開いている。(2) 発行の途中で失敗させても（存在しない `p_user_id`）何も変わらない。(3) **発行が消した鍵N本ぶんの「削除」の知らせは `skipped`（`last_error_code = 'staff_invite_issue'`）で、`pending` が0行**。(4) **窓が開いた人が鍵を足すと、`subject_is_staff = true` の行が積まれる**。(5) 対象が最後の1人の店長なら `LAST_ADMIN_REQUIRED`、対象が店長でない時は他に店長がいなくても通る。(6) `service_role` が `p_kind = 'last_resort'` を渡すと `STAFF_INVITE_KIND_FORBIDDEN`（**最後の手段はアプリの鍵では通らない**）。(7) 今の有効な店員に `invite` を渡すと `STAFF_ALREADY_STAFF`、`redo` は通る。(8) 消費は1回だけ・期限切れ・取り消しは0行。(9) `bind_window` の2度目は `STAFF_INVITE_ALREADY_BOUND`。(10) 有効化は、鍵1本・`approved_via` が `reauth`・**前の招待の窓で認めた鍵が混ざる（`approved_at < bound_at`）**・認めていない鍵が1本残る・窓が閉じた後・別の `session_id`、のそれぞれで例外。窓の中の鍵2本だけの時に通り、窓が閉じ役割が付く。(11) **同時の試験: 同じ人の `staff_invite_issue` と `staff_role_activate` を2つの接続で同時に呼んでも、行き止まりにならず、片方が終わってからもう片方が進む**。(12) `staff_invite_cancel` が行を閉じ窓を閉じ、鍵と役割は変えない。(13) 全関数が `anon`・`authenticated` から呼べず、`staff_invite_issue_core` はだれも呼べない。所有者・`search_path` が正しい
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/integration/db/auth_passkey_staff_invites.integration.test.ts` → FAIL（関数が無い）
- [ ] **Step 3: 実装する** — 上の署名で H の前半を書く。取引は `BEGIN`〜`COMMIT`。ASCII だけ・LF・BOM なし。C の直しは同じ形で関数の本体だけ。`scope.json`・ADR の README を直す
- [ ] **Step 4: 通ることを確かめる** — 上の試験 PASS。`npx.cmd supabase db reset` が通る。`auth_passkey_*`・`auth_has_permission_passkey` の既存の DB 結合が緑のまま。`validate-trace`・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): 店員の招待・役割の有効化の移行 H の前半を足し、窓の中の足しを店員の知らせにする（手元だけ）`

### Task 2b: 移行 H の後半（`admin_set_user_role` の作り直し・降格・店長の最後の手段）

**Files:**
- Modify: `supabase/migrations/<時刻>_passkey_staff_invites.sql`（Task 2 のファイル。**未適用の間に足す**。MD5 を測り直す）
- Test: `tests/integration/db/auth_passkey_staff_roles.integration.test.ts`
- 文書（同じコミット）: `db-migrations.md` の移行 H の節に足す、`FR-AUTH-037`・`SEC-AUTH-054`（親 `THR-AUTH-052`）・`DD-AUTH-073`（親 `SEC-AUTH-054`）・`IMPL-AUTH-347`〜`349`

**Interfaces:**
- `private.admin_set_user_role` を作り直す（本体は `20261023175712` の物。署名・権限・所有者は同じ）。**変えるのは1点だけ**: `_role_code in ('admin','supporter')` で、その人が今「有効な店員」でない時に `STAFF_INVITE_REQUIRED`（`ERRCODE = '42501'`）。前の確かめで、置き換える前の `md5(prosrc)` を確かめる。
- `public.staff_demote(p_actor_id uuid, p_user_id uuid) returns void`（`service_role`）— 190519 → その人の鍵の順で取り、**鍵を取った後に、`p_actor_id` が今も有効な店長で `admin.users.manage` を持つか確かめる**（`ROLE_PERMISSION_FORBIDDEN`）。最後の店長・自分自身は断る。役割を `user` にし、認めた鍵の表のその人の行を消す（鍵そのものは残す。お客さんのパスキーになる）。**開いている招待を取り消し、窓を閉じる**。
- `private.staff_invite_issue_manual(p_email text, p_role_code text default 'admin', p_ttl_seconds integer default 3600) returns text` — **ダッシュボードの SQL 専用。`postgres` だけが `execute`（`service_role`・`authenticated`・`anon` に渡さない。PostgREST の口にもしない）**。ユーザーを `auth.users` から引き（無ければ `STAFF_MANUAL_USER_NOT_FOUND`）、`staff_invite_issue_core(..., 'last_resort', null, ..., true)` を呼び、**生の合言葉を戻り値で返す**（`extensions.gen_random_bytes(32)` の base64url の文字列。表にはその**文字列の UTF-8 の SHA-256**だけ。Task 2 の消費と同じ入力）。`REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` を明記し、`postgres` にだけ `GRANT`。**期限は既定1時間**（合言葉がダッシュボードの結果の画面に出るため）。**発行を監査の表に1行残す**（`logAudit` が書く表。表名は `grep -n "from('audit" src/lib/audit.ts` で確かめる。action `staff.last_resort.issue`、詳細に対象の id だけ）。TS には `last_resort` の型を作らない（アプリから呼べない）。

- [ ] **Step 1: 失敗する試験を書く** — (1) 期限が切れて `active = false` だった `admin` の行を持つ人を `admin_set_user_role` で `admin` に戻そうとすると `STAFF_INVITE_REQUIRED`（**1j**）。(2) `user` から `supporter` も同じ。(3) 有効な店長が店員同士（`admin` → `supporter`）・`user` へは今のまま通る。(4) 降格は認めた鍵の行を消し鍵を残し、**開いている招待を取り消し窓を閉じる**。(5) **同時の試験: 店長 A・B がいる時、A が B を、B が A をやり直す2本を同時に流すと、片方は `LAST_ADMIN_REQUIRED` か先に終えた側が勝ち、有効な店長が0人にならない**。(6) `staff_invite_issue_manual` が戻した合言葉の SHA-256（文字列の UTF-8）が表のハッシュと一致し、**固定の合言葉の SQL のハッシュの値が、アプリの `hashInviteToken` と同じ**（Task 4 の単体と同じ値を試験に書く）、期限が約1時間で、`service_role`・`authenticated` が呼ぶと権限エラー、監査の行が1つ増える。(7) 最後の1人の店長に `manual` を使うと通る（`last_resort`。ほかに店長がいなくても鍵・TOTP・役割が消え招待が1つできる）。(8) 全関数の権限・所有者・`search_path`
- [ ] **Step 2: 失敗を確かめる** — 上の DB 結合 → FAIL
- [ ] **Step 3: 実装する** — 上の署名で足す。`admin_set_user_role` を使う既存の DB 結合（`grep -rl admin_set_user_role tests`）も緑にする
- [ ] **Step 4: 通ることを確かめる** — 上と既存が PASS。`db reset`。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 役割の変更を招待に寄せ、降格と店長の最後の手段を足す（移行 H の後半・手元だけ）`

### Task 3: 無操作1時間の表と関数を移行 D に、4つ目の条件を移行 E に足す

**Files:**
- Modify: `supabase/migrations/20261117001500_passkey_staff_entry_conditions_fn.sql`（D。表と関数。**本番未適用なので同じファイルを直す**）、`supabase/migrations/20261117013000_passkey_staff_entry_conditions.sql`（E。`has_permission` の4つ目の条件と前の確かめ。同じく直す）。大きさと MD5 を測り直す。新しい移行は作らない
- Test: `tests/integration/db/auth_passkey_staff_idle.integration.test.ts`、`auth_has_permission_passkey.integration.test.ts`（足す）
- 文書（同じコミット）: `db-migrations.md` の移行 D・E の節（大きさ・MD5・手元の値・無操作の条件）、**E のヘッダーの説明（「`has_permission` だけを替える」）と `ROLLBACK`（D の表と関数も、E を戻した後に落とす）、`db-migrations.md` の「戻し方の順」の D と E の行**、`FR-AUTH-044`（無操作1時間。Task 8 の受け入れ条件と同じ物）・`SEC-AUTH-055`（親 `THR-AUTH-054`）・`DD-AUTH-074`・`DATA-AUTH-021`・`IMPL-AUTH-350`〜`352`、`ADR-0472`（無操作の時刻を、アプリの表にした判断。`auth.sessions.refreshed_at` を使わない理由。構造設計の子 `ARC-AUTH-013`）

**Interfaces（D のファイルに足す。権限を奪わない物なので、デプロイより前に当てられる）:**
- 表 `private.staff_session_activity(session_id uuid primary key, user_id uuid not null, last_seen_at timestamptz not null default now())`。RLS 有効・`anon`・`authenticated` の権限なし。
- `public.staff_session_touch(p_session_id uuid, p_user_id uuid, p_min_interval_seconds integer default 60) returns boolean`（`service_role`）— 行が無ければ作り、あって間引きの秒以上たっていれば更新して真、そうでなければ偽。書く時にその人の2日より前の行を消す。
- `private.staff_idle_ok(p_session_id uuid) returns boolean`（`STABLE`・`SECURITY DEFINER`）— **行があれば `last_seen_at > now() - staff_idle_seconds`。行が無ければ、`auth.sessions` のその `session_id` の `coalesce(refreshed_at AT TIME ZONE 'UTC', created_at)` を使って同じ比べをする**（`refreshed_at` は時刻帯なしの型、`created_at` は時刻帯つきなので、型をそろえて比べる）。`auth.sessions` にも無ければ偽。理由: ログインの終わりを通らないセッション（E2E・手元の開発・DB 結合の JWT）や、書き込みの失敗した後でも、新しいセッションは1時間は通る。書き込みの失敗が永久の拒否にならない。
- `public.staff_idle_check(p_session_id uuid, p_user_id uuid) returns boolean`（`service_role`）— `staff_idle_ok` を見て、**真なら `staff_session_touch` と同じ間引きで時刻を進めて真**、偽なら偽。`admin-rbac`・`passkey-manage-guard`・ページの入口（Task 8・9）が1回の呼びで確かめと書き込みを済ませる。
- `public.staff_idle_peek(p_session_id uuid) returns boolean`（`service_role`）— `staff_idle_ok` を呼ぶだけで、**時刻を進めない**。`/api/auth/me`（画面を開き直すだけで無操作が延びないように）が使う。

**Interfaces（E のファイルに足す）:**
- `public.has_permission(text)` の本体に、`staff_passkey_count_ok` の次の4つ目の条件として `private.staff_idle_ok((auth.jwt() ->> 'session_id')::uuid)` を足す（E の既存の `CREATE OR REPLACE` の中。置き換える前の `md5(prosrc)` の確かめは変えない）。
- **前の確かめ**に、`to_regprocedure('private.staff_idle_ok(uuid)')` が null でないことを足す（外れたら `PASSKEY_MIGRATION_PRECHECK_FAILED`、`passkey_entry_idle_fn`）。

- [ ] **Step 1: 失敗する試験を書く** — (1) 行が無く `auth.sessions` の `refreshed_at` が59分前の店員は真、61分前は偽。(2) 行がある時は `last_seen_at` で59分は真・61分は偽（`last_seen_at` を直に書き換える）。(3) `auth.sessions` にも行が無い `session_id` は偽。(4) `staff_idle_check` の間引き（60秒以内の2度目は時刻が動かない）。(5) **`staff_idle_peek` は何度呼んでも時刻が動かない**。(6) お客さん・anon の `has_permission` の結果は変わらない（既存の RLS の試験が緑）。(7) 24時間・認めた鍵2本の条件は今のまま（E の既存の試験が緑）。(8) JWT に `session_id` が無い時は偽。(9) 権限（`service_role` だけ）。(10) **E の前の確かめ: D の関数が無い状態では E が `passkey_entry_idle_fn` で止まる**。(11) **`createAdminSessionActor`・`scripts/dev/passkey-dev-staff.ts` のテスト・`has_permission` を使う既存の DB 結合が、行を書かずに緑のまま**
- [ ] **Step 2: 失敗を確かめる** — 上の DB 結合 → FAIL
- [ ] **Step 3: 実装する** — D と E のファイルに足す。費用: `has_permission` を `( SELECT ... )` で包まずに呼ぶ決まりが77件ある（E の節）。条件4も店員だけが払う作りにし、`EXPLAIN` が増えないことを台帳の備考に1行書く
- [ ] **Step 4: 通ることを確かめる** — DB 結合の `auth_*`・`has_permission` を使う既存の試験が緑。`db reset`（D → … → E の版の順で当たる）。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員の無操作1時間の表と関数を移行 D に、4つ目の条件を移行 E に足す（手元だけ）`

### Task 4: 招待の合言葉・メール・DB を呼ぶ部品

**Files:**
- Create: `src/features/auth/staff/invite-token.ts`、`invite-mail.ts`、`staff-invite-store.ts`
- Test: `tests/unit/features/auth/staff/{invite-token,invite-mail,staff-invite-store}.test.ts`
- 文書: `DD-AUTH-075`・`IMPL-AUTH-353`〜`357`（親は `SEC-AUTH-053`）

**Interfaces:**
- `invite-token.ts`: `createInviteToken(): { token: string; tokenHash: Uint8Array }`（32バイト乱数の base64url と、その SHA-256）、`hashInviteToken(token: string): Uint8Array`（**base64url の文字列の UTF-8 のバイトの SHA-256**。生の32バイトにはかけない。`createInviteToken` が返す `tokenHash` と同じ入力。SQL 側の `staff_invite_issue_manual` と同じ）、`buildInviteUrl(origin: string, token: string): string`（`/staff/invite#<token>`。**合言葉は URL の断片（`#`）に置く**。アクセスのログ・Referer に残らない。画面が断片を読み、`POST` の本文で送る）。
- `invite-mail.ts`: `composeInviteMail(input: { kind: 'invite'|'redo'|'promote'; roleLabel: '店長'|'サポーター'; url: string; expiresAtJst: string; passkeysDeleted: boolean }): { subject: string; text: string; html: string }`。文面は下の付録。**`redo`・`promote`、およびパスキーを持っていた既存のお客さんへの `invite`（`passkeysDeleted` が真）は、冒頭に「これまでのパスキーはすべて削除されました。」を入れる**（削除の知らせを `skipped` にするため、本人に知らせる物がこのメールだけになる）。送るのは注文のメールと同じ送り手。**挨拶・署名・件名の頭の店名は付けない**（段2の店員向けの知らせと同じ。オーナーに見せる。質問3）。
- `staff-invite-store.ts`（サーバーだけ。`import 'server-only'`）: `issueStaffInvite(deps, input: { userId: string; roleCode: 'admin'|'supporter'; kind: 'invite'|'redo'|'promote'; issuedBy: string; reason: string | null }): Promise<Result<{ inviteId: string; token: string }, 'last_admin'|'self'|'already_staff'|'not_found'|'failed'>>`、`consumeStaffInvite(deps, token: string): Promise<Result<{ inviteId: string; userId: string; roleCode: string }, 'invalid'>>`、`bindStaffInviteWindow(deps, inviteId: string, sessionId: string): Promise<Result<void, 'already_bound'|'failed'>>`、`activateStaffRole(deps, userId: string, sessionId: string): Promise<Result<{ role: string }, 'invite_invalid'|'no_window'|'keys_short'|'keys_not_window'|'failed'>>`、`cancelStaffInvite(deps, userId: string)`、`demoteStaff(deps, actorId: string, userId: string)`（DB 関数の例外の名前を `Result` の理由に写す。例外の本文をそのまま返さない）。**`last_resort` は型に作らない**。

- [ ] **Step 1: 失敗する試験を書く** — 合言葉は毎回違い・43字・ハッシュは SHA-256。`buildInviteUrl` が `#` で渡し `?token=` を作らない。メールの本文に URL と期限と「ご自身で心当たりがない場合は、何もしないでください」が入り、**合言葉が件名・ログに出ない**（`console` を見張る）。`issueStaffInvite` が `LAST_ADMIN_REQUIRED` を `last_admin`、`STAFF_ALREADY_STAFF` を `already_staff` に写し、未知のエラーが `failed` になり本文が漏れない。`activateStaffRole` が4つの例外名を写す **ハッシュの値の固定: 固定の合言葉（例 `0123456789abcdef0123456789abcdef0123456789a`）の `hashInviteToken` の16進が、Task 2b の SQL の試験に書いた値と同じ**。`passkeysDeleted` が真のメールに削除の一文が入る
- [ ] **Step 2: 失敗を確かめる** — `npx.cmd jest tests/unit/features/auth/staff` → FAIL
- [ ] **Step 3: 実装する** — 上の署名どおり。DB は `createServiceRoleClient` の RPC（`callRpc` の既存の部品があれば使う）
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS、`typecheck`・`lint`、`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員の招待の合言葉・メール・DB を呼ぶ部品を足す`

### Task 5: 店長の窓口（招待・上げる・やり直し・下げる・招待の取り消し）と、旧の作成画面の削除

**Files:**
- Create: `src/app/api/admin/staff/invites/route.ts`（`POST`）、`src/app/api/admin/staff/[id]/redo/route.ts`・`demote/route.ts`・`invite/cancel/route.ts`（すべて `POST`）
- Modify: `src/app/api/admin/users/route.ts`（PATCH。下の規則）、`scripts/trace/scope.json`（AUTH の `src` に `src/app/api/admin/staff/**/*.ts` は Task 2 で足し済み。ADMIN から `create-user` の型を外す）
- Delete: `src/app/admin/create-user/`、`src/app/api/admin/create-user/`、その単体・E2E（`grep -rln "create-user" tests e2e` で探し、1本ずつ旧画面だけの物かを確かめる。他の機能の準備に使っている物は付け替える）
- Test: `tests/unit/api/admin/staff/*.test.ts`、`tests/integration/api/admin-staff-*.test.ts`、`e2e/FR-LOGIN-063-staff-invite-redo-api.spec.ts`（`scope.json` の AUTH の `tests` に `tests/unit/api/admin/staff/**/*.test.ts`・`tests/integration/api/admin-staff-*.test.ts` を足す）
- 文書: `SR-AUTH-026` の `FR-AUTH-038`〜`040`・`API-AUTH-033`〜`036`・`DD-AUTH-076`〜`077`・`THR-AUTH-055`（招待の窓口の悪用）・`SEC-AUTH-056`（親は `THR-AUTH-055`）・`IMPL-AUTH-358`〜`365`・`docs/03_BasicDesign/areas/auth.md`、`ADR-0471` に追記。**ADMIN の文書の廃止（追跡が98を越えない手順）**: `docs/02_Requirements/areas/admin.md`・`docs/03_BasicDesign/areas/admin.md`・`docs/04_DetailDesign` の `create-user` に結ぶ要件・IMPL・DD・AC を `documentation-guide` の廃止の書き方で閉じ（`grep -rn "create-user" docs/0[2-5]*` で見つける）、`scripts/trace/scope.json` の ADMIN の `src`・`tests`・`e2e` から消した物を外し、`validate-trace` を流して `baseline.json` より増えないことを確かめる

**Interfaces:**
- `POST /api/admin/staff/invites` 本文 `{ email: string; role: 'admin'|'supporter' }`。権限 `admin.users.manage`・CSRF・IP と店長ごとの回数の制限。アカウントが無ければ `auth.admin.createUser({ email, email_confirm: true })`（パスワード無し）、あれば同じアカウントを使う。**その人が今の有効な店員なら 409 `already_staff`（本文: 「すでに店員です。やり直しは、一覧の「パスキーを全部消してやり直す」から行ってください」）**（確認の語と理由が要るやり直しの守りを迂回させない）。そうでなければ `issueStaffInvite(kind: 'invite')` → `revokeAllSessionsForUser` → 招待のメール。応答は `{ success: true }`（**アカウントが在ったお客さんかを返さない**）。
- `PATCH /api/admin/users`（`{ userId, role }`）: `role` が `admin`/`supporter` で、その人が今の有効な店員でない時は、直に変えず `issueStaffInvite(kind: 'promote')` → 全ログイン終了 → メール。応答は `{ success: true, invited: true }`。有効な店員どうしの入れ替えは今のまま。`user` への降格は `demoteStaff` → `revokeAllSessionsForUser`（**降格は開いている招待も取り消す**）。`STAFF_INVITE_REQUIRED` が DB から返ったら同じ道に落とす。
- `POST /api/admin/staff/[id]/redo` 本文 `{ confirm: 'やり直し'; reason: string(10..500) }`（今の MFA のやり直し `/api/admin/users/mfa/reset` と同じ守り。ADR-0457・0461）。自分自身は403、最後の店長は409。`issueStaffInvite(kind: 'redo', roleCode: 今の役割)`（発行の前に今の役割を読んで控える）。
- `POST /api/admin/staff/[id]/invite/cancel`: `cancelStaffInvite` → `revokeAllSessionsForUser`（招待のセッションも終わらせる）。招待中の人（役割が無く開いた招待がある人）の行で使う。
- **メールの送りに失敗した時**: 招待・上げる・やり直しの鍵とログインは**もう消えている**ので、`502` と「メールを送れませんでした。もう一度、招待を出してください」を返し、行は残す（同じ人に再発行すると古い行が取り消される）。
- 監査: `admin.staff.invite`・`admin.staff.promote`・`admin.staff.redo`・`admin.staff.demote`・`admin.staff.invite_cancel`（`resource_id` は対象の id、詳細に理由の長さだけ。理由の本文・メールの全文・合言葉は載せない）。

- [ ] **Step 1: 失敗する試験を書く** — 窓口ごとに: 権限が無ければ403、CSRF が無ければ403、回数の制限。招待: **今の有効な店員のアドレスは409 `already_staff` で何も消えない**／お客さんのアカウントが在る・無いで応答が同じ／メールが1通だけ・URL が `#` の形／**アカウントが在ったお客さんの既存のパスキーとログインが消える（持ち越し 1k: 失効の後、アプリに結び付いていない GoTrue のセッション〔`auth.sessions` に直に作った行〕も消えている。`revoke_auth_sessions_for_user` の結果が1以上）**。PATCH: `user` → `admin` は直に役割が付かず `invited: true`／期限切れだった店員を戻そうとしても同じ（**1j**）／店員どうしの入れ替えは今のまま／`user` への降格が開いた招待を取り消す。やり直し: 確認の語が違うと400、理由が9字だと400、自分自身403、最後の店長409、成功で鍵が0本・役割が `user`・古い招待が取り消し・メールが1通。**招待の取り消しで、同じ合言葉が使えなくなる**。メール送りの失敗で502・行が残る。`create-user` の画面と窓口が404
- [ ] **Step 2: 失敗を確かめる** — 単体・結合 FAIL。`FR-LOGIN-063` は未作成なので E2E は Step 3 の後
- [ ] **Step 3: 実装する** — 窓口4本と PATCH の分岐。**窓口は `staff-invite-store` の関数を呼ぶだけ**（SQL を直に書かない）。`FR-LOGIN-063`（3幅）: 仮想の認証器で店長として入り、招待・やり直し・上げる・下げる・取り消しを窓口で叩き、Mailpit の本文を **`expect.poll`** で読む
- [ ] **Step 4: 通ることを確かめる** — 単体・結合・`FR-LOGIN-063` を3幅 PASS。旧 `/admin/create-user` を触っていた試験は消した/付け替えた結果が緑。**`validate-trace` が `baseline.json`（98）より増えない**・`test:trace-coverage`・`validate-docs`
- [ ] **Step 5: コミット** — `feat(auth): 店長の招待・上げる・やり直し・下げる・取り消しの窓口を足し、旧の利用者の作成を消す`

### Task 6: 招待のリンクの受け口 `/staff/invite`（案 B）

**Files:**
- Create: `src/app/staff/invite/page.tsx`、`src/features/auth/staff/components/StaffInviteScreen.tsx`、`src/app/api/auth/staff/invite/start/route.ts`（`POST`）
- Modify: `src/contexts/Providers.tsx`（`isAuthPage` に `/staff/invite`・`/staff/register`）
- Test: `tests/unit/app/staff/invite-page.test.tsx`、`tests/unit/api/auth/staff-invite-start.test.ts`、`e2e/FR-LOGIN-064-staff-invite-link.spec.ts`
- 文書: `FR-AUTH-041`・`SCR-AUTH-013`・`API-AUTH-037`・`DD-AUTH-078`・`IMPL-AUTH-366`〜`370`（親は `SEC-AUTH-053`）・`docs/04_DetailDesign/pages/14_login.md`

**Interfaces:**
- 画面は、URL の `#` の合言葉を読み、**読んだらすぐ `history.replaceState` で URL から消す**（履歴・拡張機能に残さない）。見出し「店員のパスキーを登録します」と説明（付録）、ボタン「登録を始める」だけを出す。**GET・画面の表示では、合言葉をサーバーに送らない**（`#` はサーバーに届かないので、メールの先読みでは何も起きない）。
- `POST /api/auth/staff/invite/start` 本文 `{ token: string }`: **Origin を確かめる**（今の認証の窓口と同じ。ログインの CSRF の対策）→ `consumeStaffInvite` → 0行なら 400 `invite_invalid`（期限切れ・使用済み・取り消し・不明を**同じ応答**にする）→ お客さんの扱いのまま GoTrue のセッションを作る（`auth.admin.generateLink({ type: 'magiclink', email })` の `hashed_token` を、サーバーですぐ `verifyOtp({ type: 'magiclink', token_hash })`。フックは役割が無い人なので通す）→ **分かった `session_id`（JWT の claim）で `bindStaffInviteWindow`** → `persistSessionAndCookies()` でアプリの結び付けを書く → `{ redirectTo: '/staff/register' }`。途中で失敗したら、作ったセッションを終わらせ（`endAuthSession`）、招待の行は**使用済みのまま**にして 500 を返し、画面は「店長に、招待をもう一度出してもらってください」と出す（失敗後に同じ合言葉で繰り返せる形にすると、窓が開いたまま残る道ができる）。
- 回数の制限: IP ごと 20回/10分、合言葉のハッシュごと 5回/10分。応答は no-store。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 画面は `#` が無いと「リンクが正しくありません」・読んだ後 `location.hash` が空になる。窓口は、使用済み・期限切れ・取り消し・不明が**同じ本文**で400。**Origin が違うと403**。GoTrue の失敗で窓が開いたまま残らない。E2E（`FR-LOGIN-064`・3幅）: ①メールの URL を `fetch` で GET しても、合言葉が使い切られず・Cookie が付かない ②ボタンで `/staff/register` に着き、`/api/auth/me` が `role: 'user'` ③同じ URL をもう一度開いて押すと「このリンクは使えません」 ④取り消された招待・期限が過ぎた招待で同じ文 ⑤**`private.staff_invite_issue_manual` が返した合言葉（DB 結合で `manual` を呼んで受け取る）で `POST /api/auth/staff/invite/start` が通り、窓が開く**（SQL のハッシュとアプリのハッシュが同じ入力であることの確かめ）
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 上のとおり。`isAuthPage` の単体の試験に2つの URL を足す
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS、`FR-LOGIN-064` を3幅 PASS（`expect.poll` で Mailpit）。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員の招待のリンクの受け口を足す（GET は何もしない・窓は押した時に開く）`

### Task 6b: 登録の窓口が、招待の窓の中の人を `window` として扱う

**Files:**
- Modify: `src/lib/auth/passkey-registration-guard.ts`、`src/lib/auth/passkey-recent-auth.ts`、`src/app/api/auth/passkey/register/start/route.ts`・`register/finish/route.ts`
- Test: `tests/unit/lib/auth/passkey-recent-auth.test.ts`（足す）、`tests/unit/lib/auth/passkey-registration-guard.test.ts`（足す）、`tests/unit/api/auth/passkey-register-invite-window.test.ts`、`e2e/FR-LOGIN-065-staff-register-window.spec.ts`（短い。窓口だけ）
- 文書: `FR-AUTH-042`・`DD-AUTH-079`・`IMPL-AUTH-371`〜`373`（親は `SEC-AUTH-057` → `THR-AUTH-052`）。**この物がなければ、案 B の招待の人は役割が無く、窓口が「お客さん」と見なして鍵を認めず、最後の有効化が必ず `KEYS_SHORT` で落ちる**（レビュー C-1）

**Interfaces:**
- `evaluateRegistrationAccess` の入力に `inviteWindowOpen: boolean` を足す。**規則: 店員でなくても、その `session_id` に結んだ招待の窓が開いていて（`passkey_window_is_open(user, session)` が真）、招待の行が有効化前・未取り消しなら、`window` として扱う（**発行・取り消し・有効化・降格のどれも窓を閉じるので、窓が開いていれば招待の行は有効だと見なす。別の確かめの関数は作らない**）。招待の窓を持つ人は `customer` の道（10分以内の `otp` か `passkey`）を使わない。窓が閉じたら `reauth_required` ではなく `window_closed`（お客さんの道に落ちない）**。窓の中でも、認めた鍵が `min_approved_passkeys`（2）以上なら `reauth_required`（最初の2本だけ免除）。
- `register/finish` は、`guard.isStaff` が偽でも `guard.mode === 'window'` なら `passkey_approve(…, 'window')` を呼ぶ。

- [ ] **Step 1: 失敗する試験を書く** — (1) 役割が無く窓が開いている人は `window`。(2) 窓が閉じた・別の `session_id` の人はお客さんの道に落ちず `window_closed`。(3) **招待の人の2本が `window` で認められ、お客さんの「10分以内」の確かめが効かない**（`amr` が `otp` で30分前でも通る）。(4) 3本目は `reauth_required`。(5) 窓の無いお客さんは今のまま（段2の試験が緑）
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 上のとおり
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS、`FR-LOGIN-051`（店員の登録）・`FR-LOGIN-060`（お客さんのアカウントのパスキー）が緑のまま。`validate-trace` ほか
- [ ] **Step 5: コミット** — `fix(auth): 招待の窓の中の人の鍵を window として認める（役割が無い間の案 B）`

### Task 7: 2本の登録の画面 `/staff/register` と、役割の有効化

**Files:**
- Create: `src/app/staff/register/page.tsx`、`src/features/auth/staff/components/StaffRegisterScreen.tsx`、`src/app/api/auth/staff/register/complete/route.ts`（`POST`）
- Test: `tests/unit/features/auth/staff/staff-register-screen.test.tsx`、`tests/unit/api/auth/staff-register-complete.test.ts`、`e2e/FR-LOGIN-066-staff-register-two-keys.spec.ts`
- 文書: `FR-AUTH-043`・`SCR-AUTH-014`・`API-AUTH-038`・`DD-AUTH-080`・`IMPL-AUTH-374`〜`378`・`docs/04_DetailDesign/pages/14_login.md`

**Interfaces:**
- 画面（サーバーで、窓が開いているセッションかを確かめ、違えば `/login` へ送る）: 「1本目」「2本目」の2段。段2の `registerPasskey` を使い、**窓口の返事で窓の内か外かを決める**（画面で数えない）。2本目の前に「別の端末か、セキュリティキーでの登録をおすすめします」（付録）。2本そろったら `POST /api/auth/staff/register/complete`。
- `POST /api/auth/staff/register/complete`（本文なし。Origin を確かめる）: 現在のセッションの `user_id` と JWT の `session_id` で `activateStaffRole(deps, userId, sessionId)` → 成功したら `endAuthSession`＋`revokeAllSessionsForUser` で全ログインを終わらせ、Cookie を消し、`{ redirectTo: '/login' }`。例外は理由ごとに 409 `keys_short`・403 `window_closed`・500。**応答に鍵の ID を載せない**。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 1本だけで「完了」を押すと `keys_short` の文。窓が閉じたセッションで `complete` が403。成功後の Cookie が消える。E2E（`FR-LOGIN-066`・3幅・仮想の認証器を2つ使う）: 招待 → 押す → 1本目 → 2本目（別の認証器）→ 完了 → `/login` へ。**役割が有効になったこと**・認めた鍵が2本・`approved_via = 'window'`・招待の行の `activated_at`。直後に **その認証器で `/login` からパスキーでログインし、`/admin` に入れる**。**TOTP の要素を持つ店長（`e2e/admin-session-test-utils.ts` の TOTP の道具を使う）をやり直して、2本の登録が通る**。招待のセッションのトークンで `/api/admin/*` を叩くと403。**招待の窓の中で足した鍵の知らせが `subject_is_staff = true` で積まれる**（Task 2 の確認を画面から）
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 上のとおり。画面の文・失敗の読み替えは付録
- [ ] **Step 4: 通ることを確かめる** — 単体・`FR-LOGIN-066` を3幅 PASS。`FR-LOGIN-051` が緑のまま。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員の2本の登録の画面と役割の有効化を足す`

### Task 8: 無操作1時間・24時間（API・画面・店員のパスキー窓口）

**Files:**
- Create: `src/lib/auth/staff-passkey-idle.ts`（`scope.json` の既存の型 `staff-passkey*.ts` に入る名前）
- Modify: `src/lib/auth/admin-rbac.ts`（呼ぶだけ。`@impl` は足さない）、`src/lib/auth/passkey-manage-guard.ts`（店員の `/api/auth/passkey/*` の一覧・名前・削除にも当てる）、`src/app/api/auth/passkey/login/finish/route.ts`（店員のログインの成功の時に1回書く。**書き込みの失敗はログインを断らない**）、`src/app/api/auth/me/route.ts`（理由 `idle` を返す）、`src/app/admin/layout.tsx` か `admin/page.tsx` の送り先
- Test: `tests/unit/lib/auth/staff-passkey-idle.test.ts`（`scope.json` の既存の `tests/unit/lib/auth/staff-passkey*.test.ts` に入る）、`tests/unit/lib/auth/passkey-manage-guard-idle.test.ts`、`e2e/FR-LOGIN-067-staff-idle-timeout.spec.ts`
- 文書: `FR-AUTH-044`・`DD-AUTH-081`・`IMPL-AUTH-379`〜`382`（親は Task 3 の `SEC-AUTH-055`）

**Interfaces:**
- `staff-passkey-idle.ts`: `checkStaffIdle(deps, sessionId: string, userId: string, mode: 'touch'|'peek' = 'touch'): Promise<'ok'|'idle'|'error'>`（`touch` は RPC `staff_idle_check`、`peek` は `staff_idle_peek`＝時刻を進めない。RPC が失敗したら `error`）。
- `admin-rbac` は、権限の判定の後に `checkStaffIdle` を呼ぶ。`idle` は 401 `{ error: 'session_idle' }` で、**そのセッションを終わらせる**（`revoke_auth_session`。24時間まで残る更新の道を閉じる）。**`error`（RPC の失敗）は 503 にし、ログアウトも401もしない**（書き込みの失敗・DB の一時の不調が、永久の拒否にならない）。画面側（`/api/auth/me`）は **`peek`（時刻を進めない）**で確かめて理由 `idle` を返し（画面を開き直すだけで無操作が延びない）、管理画面が `/login?reason=idle` へ送る。
- 店員の `/api/auth/passkey/*`（一覧・名前・削除。`passkey-manage-guard`）も同じ確かめ（無操作 + 24時間）を通す。****ゲートの関数の呼びが `error` の時は、すべての呼び元（`admin-rbac`・`passkey-manage-guard`・ページの入口・`/api/auth/me`）で同じに扱う: 失敗を閉じる側に倒し、503 と「しばらくしてからお試しください」を返す。`/login` へは送らない（回る道になる）**。お客さんには当てない**。ただし `/admin/passkeys?more=1` に来る1本だけの店員は、この確かめを通るので、無操作・24時間の中でだけ使える。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 最後に使った時刻が59分前は `ok`、61分前は `idle`、`auth.sessions` にも無ければ `idle`、RPC 失敗は `error`。`admin-rbac`: `idle` で401・セッションが終わる、`error` で503・終わらない。通った後に時刻が進む。店員の `passkey-manage-guard` が `idle` で401、お客さんは通る。E2E（`FR-LOGIN-067`・3幅）: 店員が入る → DB で `last_seen_at` を61分前にする → `/admin` に着くと `/login?reason=idle` へ送られ、文「しばらく操作がなかったため、ログアウトしました」が出る。59分前なら入れ、その操作で時刻が更新される。**`createAdminSessionActor` で作った（`login/finish` を通らない）セッションも、1時間の中は通る**。24時間の既存の試験が緑
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 上のとおり
- [ ] **Step 4: 通ることを確かめる** — 単体 PASS・`FR-LOGIN-067` 3幅 PASS。`FR-LOGIN-032`（店員の入口）・`FR-LOGIN-052`（一覧・名前・削除）が緑のまま。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員の無操作1時間で API と画面と店員のパスキー窓口を止める`

### Task 9: 店員のパスキー管理と、1本だけの店員の「もう1本」の画面

**Files:**
- Create: `src/app/admin/passkeys/page.tsx`、`src/features/auth/staff/components/StaffPasskeyManager.tsx`、`StaffOneMoreKey.tsx`、`src/lib/auth/staff-passkey-page-guard.ts`
- Modify: `src/app/auth/verified/page.tsx`（認めた鍵が1本の店員を `/admin/passkeys?more=1` へ送る。**TOTP の流れ自体は段4まで残す**）、`src/app/api/auth/passkey/[id]/route.ts`（`DELETE` の店員の下限）、`AdminSideNav.tsx`（入口。M-12）、`docs/03_BasicDesign/ui/screen-list.md`
- Test: `tests/unit/features/auth/staff/{staff-passkey-manager,staff-one-more-key}.test.tsx`、`tests/unit/lib/auth/staff-passkey-page-guard.test.ts`、`tests/unit/api/auth/passkey-delete-staff-floor.test.ts`、`e2e/FR-LOGIN-068-staff-passkey-manage.spec.ts`
- 文書: `SR-AUTH-027`・`FR-AUTH-045`・`SCR-AUTH-015`・`DD-AUTH-082`・`IMPL-AUTH-383`〜`388`

**Interfaces:**
- **`/admin/passkeys` の入口の条件**（`staff-passkey-page-guard.ts`: `requireStaffPasskeyPage(): Promise<{ ok: true; userId: string; approvedCount: number } | { ok: false; redirectTo: string } | { ok: false; unavailable: true }>`）: ①有効な店員の役割 ②`amr` に `passkey` があり24時間以内 ③無操作1時間以内（`checkStaffIdle`）を求め、**認めた鍵が2本以上かは求めない**（0本は窓の道なのでこの画面に来ない。1本の店員が入れる）。外れたら `/login`（`reason` つき）。`checkStaffIdle` が `error` の時は `unavailable`（画面は「しばらくしてからお試しください」。`/login` へは送らない）。この画面は `/auth/verified` へ送り返さない（**回り続けない**）。
- 一覧・名前の変更・追加は段2の `listPasskeys`・`renamePasskey`・`registerPasskey`。店員の追加は「5分以内のパスキーでの入り直し」が要るので、窓口の `reauth_required` を、画面では「もう一度パスキーでログインしてから追加してください」＋ボタン「パスキーでログインし直す」に読み替える。
- **削除の下限**: `DELETE /api/auth/passkey/{id}` は、店員で、消すと認めた鍵が `min_approved_passkeys` 未満になるなら 409 `staff_min_keys`（鍵は消さない）。画面も同じ数え方で止める。
- 入口: 管理画面の右上の自分のメニューの「パスキー」（設計には書かれていない作り手の判断。`screen-list.md` と付録に書く）。

- [ ] **Step 1: 失敗する試験を書く** — 単体: ガードは、役割なし・`amr` に `passkey` なし・25時間・無操作61分でそれぞれ `/login`、**認めた鍵が1本でも `ok`**。2本の店員が1本消そうとすると409・画面でも止まる。3本なら消せる。お客さんは最後の1本も消せる。**認めた鍵が1本の店員が `/auth/verified` に来ると `/admin/passkeys?more=1` へ行き、そこから `/auth/verified` へ戻らない**（`needsMfa` の無限の遷移を再現する試験を先に赤にしてから直す）。E2E（`FR-LOGIN-068`・3幅）: 一覧に名前・作成日・最後に使った日／名前の変更／2本の店員が削除で止まる／3本目を追加（入り直し）して1本消せる／1本だけの店員が入ると「もう1本」の画面に着き、追加すると `/admin` に入れる／GoTrue を直に叩いて足した鍵は一覧に出ず、店員としては入れない
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 上のとおり
- [ ] **Step 4: 通ることを確かめる** — 単体・`FR-LOGIN-068` 3幅 PASS。`FR-LOGIN-052` が緑のまま。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員のパスキー管理と、1本だけの店員のもう1本の画面を足す`

### Task 10: 店員が別の道で入ろうとした時の画面・TOTP の登録を断る・1b の M-2

**Files:**
- Modify: `src/features/auth/passkey/components/EmailCodeEntry.tsx` と `src/app/api/auth/email-code/verify/route.ts`（既に 403 `staff_passkey_required`。画面の文を確かめる）、`src/app/api/auth/oauth/callback/route.ts`（Google でフックに拒否された時、画面へ `?error=staff_passkey_required` で戻す）、`/login` の画面部品（`error` の文）、**`src/app/api/auth/mfa/enroll-totp/route.ts`（店員の役割の人には 410 `totp_retired`。窓口の削除自体は段4）**、`src/app/api/auth/passkey/login/finish/route.ts`（1b の M-2。`endAuthSession` の失敗を監査に残す）
- Test: `tests/unit/api/auth/oauth-callback-staff.test.ts`、`tests/unit/features/auth/passkey/login-screen-staff-error.test.tsx`、`tests/unit/api/auth/mfa-enroll-totp-retired.test.ts`、`tests/unit/api/auth/passkey-login-finish-end-session-audit.test.ts`、`e2e/FR-LOGIN-069-staff-other-paths-rejected.spec.ts`
- 文書: `FR-AUTH-046`・`DD-AUTH-083`（予約を `DD-AUTH-083` まで広げる）・`IMPL-AUTH-389`〜`392`

**Interfaces:** 文は「店員の方は、パスキーでログインしてください。」の1つだけ（Google・メールのコードの両方。設計 6-2 の文から「方」を足した差は、オーナーに見せる。質問3）。メールのコードの始めの窓口は**変えない**（登録済みかを漏らさないため）。TOTP の登録の拒否: `/api/auth/mfa/enroll-totp` が店員に 410 を返す（パスキーで入った店員が TOTP を登録すると、以後のパスキーの追加・削除が aal2 で止まる）。

- [ ] **Step 1: 失敗する試験を書く** — 単体: Google の交換が `isStaffPasskeyRequiredError` の時、`/login?error=staff_passkey_required` へ戻り Cookie・セッションが作られない。ログイン画面が他の `error` の値を出さない。**店員の `enroll-totp` が410・お客さんは今のまま**。M-2: `endAuthSession` が失敗した時、`logAudit` が呼ばれ（`action: 'auth.passkey.login.end_session_failed'`、詳細にエラーコードだけ）、応答は変えない。E2E（`FR-LOGIN-069`・3幅）: 店員が、メールのコードで確定すると文が出てセッションが作られない／Google はコールバックの URL に GoTrue のエラーを模した値を渡す単体で代える（実機は8-2・段3b）／古いパスワードの `/login/password` でも入れない／`enroll-totp` が410
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 上のとおり
- [ ] **Step 4: 通ることを確かめる** — 単体・`FR-LOGIN-069` 3幅 PASS。`FR-LOGIN-040`・`FR-LOGIN-057` と TOTP の既存の E2E（旧画面の物。店員でない人を使う物は今のまま）が緑のまま。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 店員が Google・メールのコードで入ろうとした時の文を出し、店員の TOTP の登録を断る`

### Task 11: 管理画面「ユーザー」の画面（招待・やり直し・上げる・下げる・取り消し）

**Files:**
- Modify: `src/components/UserSection.tsx`（**部品を差し込むだけにし、`@impl` は足さない**。ADMIN の既存の ID はそのまま）
- Create: `src/features/auth/staff/components/{InviteStaffDialog,RedoStaffDialog,StaffRoleActions}.tsx`
- Test: `tests/unit/features/auth/staff/user-section-staff.test.tsx`（`scope.json` の AUTH の `tests/unit/features/auth/staff/**` に入る）、`e2e/FR-LOGIN-070-admin-users-staff-screen.spec.ts`
- 文書: `FR-AUTH-040` の受け入れ条件に足す（**FR-AUTH-046 ではなく 038〜040**）、`DD-AUTH-084`・`SCR-AUTH-016`・`IMPL-AUTH-393`〜`396`（予約を `DD-AUTH-084`・`IMPL-AUTH-396` まで広げる）、`docs/03_BasicDesign/ui/screen-list.md`・該当の `docs/04_DetailDesign/pages/`（`grep -ln UserSection docs/04_DetailDesign/pages`）

**Interfaces:** 「ユーザー」の画面に「店員を招待」ボタン（メール・役割）、各店員の行に「パスキーを全部消してやり直す」（確認の語と理由）と「お客さんに戻す」、お客さんの行の役割の選択は「店員にする」に変え、押すと「招待のメールを送ります」と確認してから `PATCH /api/admin/users`。**招待中の人（役割が無く開いた招待がある人）の行に「招待中」と「招待を取り消す」**。自分の行・最後の店長の行は押せない。**店員の行に認めた鍵の本数（0・1・2）を出す**。メールの送りが 502 の時は付録の文を出す。

- [ ] **Step 1: 失敗する試験を書く** — 単体: 確認の語が違うと送れない・理由が9字だと送れない・送信中は `disabled` と `aria-busy`・失敗は `LiveMessage`・自分の行と最後の店長の行は押せない・招待中の行に取り消しが出る。E2E（`FR-LOGIN-070`・3幅）: 画面から招待を出し Mailpit のメールが届く（`expect.poll`）・やり直しで本数が0になる・「店員にする」で役割がすぐには変わらず招待が出る・招待を取り消すと同じ URL が使えない
- [ ] **Step 2: 失敗を確かめる** — 単体 FAIL
- [ ] **Step 3: 実装する** — 既存の見た目（ダイアログの部品）に合わせる。文は付録
- [ ] **Step 4: 通ることを確かめる** — 単体・`FR-LOGIN-070` 3幅 PASS。`UserSection` を使う既存の試験が緑。`validate-trace` ほか
- [ ] **Step 5: コミット** — `feat(auth): 管理画面のユーザーに店員の招待・やり直し・上げる・下げる・取り消しの操作を足す`

### Task 12: 段3a の全体の確かめ

**Files:**
- Modify: `docs/06_Operations/db-migrations.md`（H を一覧の後ろに足す・8本。C・E・F の MD5 の直し）、`db-migrations.md` の移行 C・D・E・F の MD5 の直しと E のヘッダー・戻し方、台帳（行 1j・1k を「済み」にし、1a-3・1l に H の当て方を書き足す。「4-2 パスキー段2から先への持ち越し」の段3の表の状態欄）、`docs/06_Operations/first-admin-bootstrap.md`（店長の最初の道の予告を1行。本書は段3b）
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
| 1a-3 本番への当て方（A→…→E の順） | 段3b（手順書。H が増えて8本） |
| 1a-4 本番の `rp_id`・`postgres` の権限・GoTrue の版・最初の店長の道 | 段3b（手順書と、最後の手段の SQL の `private.staff_invite_issue_manual`＝Task 2b） |
| 1i 移行 F の当て方・`Sb-Forwarded-For`・環境変数 | 段3b（手順書） |
| 1j 期限切れ・無効だった役割を戻す時にも「上げる」と同じ | Task 2b（`admin_set_user_role` が `STAFF_INVITE_REQUIRED`）・Task 5 |
| 1k 失効がアプリに結び付いていない GoTrue のセッションも消す試験 | Task 5 |
| 1l 段2の持ち越し（`dead` の点検・pg_cron と G の本番登録・心拍） | 段3b |
| 役割を上げる時の鍵の消去とセッションの終了 | Task 2・5 |
| `passkey_approve('reauth')` が鍵を数えず入り直しの承認も確かめない | Task 1（0本は断る）・既存の窓口（入り直しの時刻） |
| 移行 F の `advisory lock` の名前空間 | Task 1 |
| 店員のパスキー管理の画面 | Task 9 |
| Google の拒否の画面 | Task 10 |
| 1b の M-1（昇格・入り直し） | Task 2・5・6b・9 |
| 1b の M-2（`endAuthSession` の失敗の監査） | Task 10 |
| 4-2「役割を切り替える時の監査・知らせの副作用の確認」 | Task 2（発行が消した鍵の知らせは `skipped`・窓の中で足した鍵は店員として積む）・Task 7（画面から確かめる） |
| 6-2・8-1「TOTP の要素を消す」 | Task 2（発行の取引の中で消す）・Task 7（TOTP を持つ店長のやり直しの E2E）・Task 10（店員の TOTP の登録を410で断る） |
| 店長への「やり直しを出した」の知らせ | 段3b |
| `dead` の点検・worker の心拍 | 段3b |
| E2E の `mailsTo`・`mailBodies` を `expect.poll` に | 新しい試験は Task 5 から `expect.poll`。既存の手助けの直しは段3b |
| 8-2 の1行（`/otp` の IP の枠・`Sb-Forwarded-For`・`createServiceRoleAuthClient` を `sb_secret_` に替える要否） | 段3b Task 16 |
| 一度も入らなかったアカウントの後始末 | 判断10（開店前） |
| 1本だけの店員が `/auth/verified` で回る | Task 9 |
| TOTP の窓口・画面の削除 | 段4（判断6。ただし店員の登録は Task 10 で410） |

## セルフレビュー

**設計書との対応**: 4-2 の段3の行（招待・2本の登録・やり直し・無操作1時間・Google の拒否・店長への知らせ・最後の手段・役割切り替えの副作用の確認）→ Task 2・2b・5・6・6b・7・8・10、店長への知らせと手順書は段3b。5-5（窓の中の最初の2本・認めた鍵）→ Task 2・6b・7。6-2 の招待 1〜5 → Task 5・6・6b・7。上げる・下げる → Task 2b・5。ふだんのログイン → 段2と Task 10。パスキーの管理 → Task 9。やり直し → Task 5。ログインの長さ → Task 3・8。8-1（今いる人・TOTP の要素）→ Task 2・段3b。9（E2E）→ 各タスク。

**型・名前の一貫性**: `issueStaffInvite`・`consumeStaffInvite`・`bindStaffInviteWindow`・`activateStaffRole(userId, sessionId)`・`cancelStaffInvite`・`demoteStaff`（Task 4）は、DB 関数 `staff_invite_issue`・`staff_invite_consume`・`staff_invite_bind_window`・`staff_role_activate(p_user_id, p_session_id)`・`staff_invite_cancel`・`staff_demote`（Task 2・2b）と1対1。`staff_session_touch`・`staff_idle_ok`・`staff_idle_check`・`staff_idle_peek`（Task 3。D のファイル）、`checkStaffIdle`（Task 8）。`/staff/invite`・`/staff/register`（Task 6・7・`isAuthPage`）。

**Review Focus**: 5行とも、Task 2・2b・3・5・6・6b・7・8・9・10 の試験に入れた。

**実行順**: Task 1（直し）→ 2・2b（移行 H。画面は変わらない）→ 3（D に無操作の関数、E に4つ目の条件）→ 4（部品）→ 5（窓口。ここで旧の作成画面を消す）→ 6 → 6b → 7（登録の画面。招待の一巡が通る）→ 8 → 9 → 10 → 11 → 12。

**本番**: 段3a は本番の DB・設定に何も当てない。段3b の手順書とオーナーの許可が無い間は、この master を本番に出さない。

---

## 段3b（概要。3a の終わりに別の計画として書く）

Task 13〜18 を予定する（段3a の結果で細部を直す）。

| Task | 中身 |
| --- | --- |
| 13 | 店長への知らせ: やり直し・招待・上げる・下げるを出した時、**店長全員**に「店員のやり直しを出しました」のメール（設計 10 の最後の行・6-2 のやり直し）。段2 の送り手と同じ表・同じ worker に新しい種類 `staff_redo_issued`・`staff_invited` を足す。Task 2 が `skipped` にした削除の知らせの代わりの1通 |
| 14 | 死んだ知らせ（`dead`）の点検と、worker の心拍（`ops_job_heartbeats` の仕組みに乗る。`src/lib/ops/ops-checks.ts`）。店への警告のメール。**移行 G の `claim` が拾う行の後ろの宛先が約4人を越える時の取りこぼし**（段2の最終レビューの持ち越し）も同じ道で扱う |
| 15 | E2E の `mailsTo`・`mailBodies` を `expect.poll` に直す。`FR-LOGIN-062` の揺れ3件が消えることを全件で確かめる |
| 16 | 本番に当てる手順書 `docs/06_Operations/passkey-production-apply-runbook.md`。**前提**: 本番の独自のドメイン・`rp_id`・GoTrue v2.196.0・Passkeys が無料のプランで有効にできるか・`postgres` の `TRIGGER`・`SELECT` の権限、**`postgres` が `auth.mfa_factors`・`auth.webauthn_credentials` に `DELETE`、`auth.users` に `UPDATE`、`auth.sessions` に `SELECT` を持つこと**（移行 H の前の確かめと同じ）、**本番に店長にする人のアカウントがあること**（無ければダッシュボードの「Authentication」でパスワード無し・メール確認済みで作る）。**当てる順**: A → B → C → D（無操作の関数を含む）→ F → G → H（1本ずつ。E より前に当たるので、デプロイの時点で `staff_idle_check` が在る）→ ダッシュボード（Passkeys・RP・フックの登録は B の後）→ `supabase/pending/schedule_stripe_webhook_worker.sql` を新しい版の移行として当てる（**これは Stripe の webhook の worker も本番で動かし始める。開店の準備の行 3 の保留の定期処理4本と一緒に決める**。知らせの worker は同じ毎分の入口に乗る。Vault の `cron_secret`・`app_base_url`）→ アプリのデプロイ → 最初の店長（Task 17）が2本登録して役割が有効になる → **E は最後**（E の前の確かめが、認めた鍵が足りる店員を求める）→ TOTP を止める（ダッシュボード）。**E は権限を奪う側**なので、他の物と一緒に「害の無い物」に入れない。**1本ごとの手順の表**（MCP の `apply_migration`・名前は版と同じ・`md5(statements[1])` とファイルの MD5 の突き合わせ・名前の付け替え。ファイルごとに「単独で権限を奪わないか」を表の1列にする）、**戻し方の順**（フックの登録を外す → H → F → E → D → C → B → A の逆順）、環境変数、設計 8-2 の9つの確認の表と段2が足した10〜12、**台帳の「8-2 の1行」（`/otp` の IP の枠・`createServiceRoleAuthClient` を `sb_secret_` に替える要否）**。**何も当てない**。当てるのは調整役がオーナーの許可を得た時 |
| 17 | 店長本人の最後の手段と、最初の店長の手順書 `docs/06_Operations/passkey-staff-recovery.md`（`private.staff_invite_issue_manual` をダッシュボードで流し、戻った合言葉で URL を作って自分に送る。**期限は1時間**）。**アカウントが無い時の作り方**、**TOTP の要素が消えたことの確かめの SQL**（`select count(*) from auth.mfa_factors where user_id = ...` が0）、`first-admin-bootstrap.md` の書き直し（`admin:bootstrap` は `user_roles` を直に書くので H の `STAFF_INVITE_REQUIRED` が効かない。段4まで残る物として位置づける）。「パスキーを2本以上、別々の端末に持つ」を先頭に書く |
| 18 | 段3全体の最終の確かめ（段3a と同じ形）と、オーナーに渡す開店前の残りの一覧（後始末・物理キー・本物の Google・8-2 の確認） |

---

## オーナーに聞くこと

重要な順。「おすすめ」を付けた。計画は、どれも (おすすめ) で書いてある。レビュー（Opus）の意見を各行に添えた。

1. **本番に移行を当てる時期（設計 8-2 と 4-3 の食い違いを含む）** — 調べると、権限を奪うのは**移行 E・フックの登録・アプリのデプロイ**。**ファイルごとに確かめた**: A（表・関数）、B（フックの関数。登録しなければ動かない）、D（関数3本）、F（`passkey_approve` と関数3本）、G（知らせの関数）、H（招待の表と関数。`admin_set_user_role` を変えるので、今のアプリの昇格が止まるが、本番のアプリは未デプロイ）は単独では奪わない。C は鍵の足し・消しの引き金で、戻しにサポートが要る。E は奪う（`has_permission` の4つ目の条件＝無操作が入る。無操作の表と関数は D にあるので、D は奪わない）。選ぶ: (A) **ドメインが決まるまで、8本とも当てない（おすすめ。レビューも賛成）**。本番はまだ公開しておらず、先に当てても得が無いため。 / (B) 奪わない A・B・D・F・G・H だけ今当て、C・E・フック・デプロイはドメインの後。開店当日の作業は減るが、本番の DB が手元と違う版になる期間が長い。**デプロイから E までの間も、管理 API の入口（パスキーで入った店員が2本の鍵を持つ）は通るが、DB の RLS に頼る読み書き（E で替わる `has_permission`）は E まで止まる可能性がある。だから E は、最初の店長の登録の直後にすぐ当てる**。 / (C) 全部今当てて、ドメインまで本番の管理画面に入れなくなる。**なお、毎分の定期処理の SQL を当てると Stripe の webhook の worker も本番で動き始める**（開店の準備の行 3 と一緒に決める）。
2. **本番の最初の店長をどう作るか** — (A) **ダッシュボードの SQL（`private.staff_invite_issue_manual`）で最初の招待を作る（おすすめ。レビューも賛成）**。条件: ①本番に店長にする人のアカウントがある ②関数が TOTP の要素を消す（入れた） ③合言葉の期限は1時間（入れた）④発行が監査に残る（入れた）。 / (B) `admin:bootstrap` を残して使う（デプロイで入れなくなるので筋が悪い）/ (C) 認めた鍵を手で書く（勧めない）。
3. **店員が読むメール・画面の文面（下の付録）** — (A) **付録のとおり進める（おすすめ）**。次の差をご覧ください。①店員の拒否の文は、設計 6-2 の「店員はパスキーでログインしてください」から「店員の方は、パスキーでログインしてください」に変えた。②招待のメールに、挨拶・署名・件名の頭の店名（【Le Fil des Heures】）が無い（段2の店員向けの知らせと同じ）。 / (B) 直したい所を伝える。
4. **認証アプリ（TOTP）の画面・窓口を消す段** — (A) **段4（おすすめ。レビューも賛成。ただし条件付き）**。条件: TOTP の要素は発行の取引の中で消す（入れた）、店員の TOTP の登録は段3a で410にする（入れた。Task 10）。 / (B) 段3a で全部消す。
5. **招待のリンクの形** — (A) **URL の `#`（断片）に合言葉を置く（おすすめ）**。画面は読んだらすぐ `history.replaceState` で消し、POST は Origin を確かめる（入れた）。 / (B) `?token=`（サーバーのログに残る）。

## オーナーに見せる、作り手が決めたこと

設計に書かれていない・食い違う点で、私（作り手）が決めた物。違えば直す。

1. 招待・上げるを出した瞬間に、相手が今お客さんとして持つパスキーとログインが消える（相手が承諾する前。設計 6-2 どおりだが、お客さんから見ると突然の変化）。
2. メールの送りに失敗しても、鍵とログインは消えたまま。店長の画面に「メールを送れませんでした。もう一度、招待を出してください」と出す。押した後の失敗で、合言葉も使用済みのまま（店長が出し直す）。
3. 発行が消した鍵の「パスキーが削除されました」のメールは、本人にも店長にも出さない（`skipped`）。店長への知らせは段3b の「やり直しを出しました」の1通にまとめる。**本人（お客さんから上げられる人・やり直される人）には、招待のメールの冒頭に「これまでのパスキーはすべて削除されました。」を入れて知らせる**。
4. 店長とサポーターの切り替え（店員どうし）は、やり直し無しで通す。設計は `user` からの昇格だけを決めている。
5. 招待中の人の取り消しの道を足した。今の有効な店員のアドレスへの招待は 409 にして、やり直し（確認の語と理由が要る）へ案内する。
6. 無操作の時刻を書くのは、管理の API・店員のパスキー窓口・ログインの終わりだけ（店員が API を呼ばずに画面を見ているだけでは延びない）。時刻の行が無いセッションは、GoTrue のセッションの時刻から1時間は通す。
7. 文面の差（質問3）。招待のメールに挨拶・署名・件名の頭の店名を付けない。
8. 無操作の表と関数は、レビューの案（移行 H）ではなく**移行 D**に置く。理由: 手元の `db reset` は版の順に当たり、E（`20261117013000`）は H（作る時の時刻）より前なので、E の前の確かめが H の関数を見られない。D は未適用で、権限を奪わず、E より前に在る。

## 付録: 店員に見える文面の案

**招待・上げる・やり直しのメール（Task 4）**
- 件名: 「店員のアカウントの登録のご案内」。本文: 「Le Fil des Heures の{店長／サポーター}として、パスキーの登録をお願いします。／下のリンクを開き、ボタンを押して、顔認証・指紋・PIN で入る方法（パスキー）を2本登録してください。2本目は、別の端末かセキュリティキーでの登録をおすすめします。／{URL}／リンクの有効期限は {日時（日本時間）} までです。ご自身で心当たりがない場合は、何もしないでください。」（挨拶・署名・件名の頭の店名は付けない）
- やり直しの時は、冒頭に「これまでのパスキーはすべて削除されました。」を足す。

**招待の受け口（Task 6）**: 見出し「店員のパスキーを登録します」。説明「登録は30分以内に終えてください。このあいだ、管理画面は使えません。」。ボタン「登録を始める」。失敗「このリンクは使えません。店長に、もう一度招待を出してもらってください。」

**2本の登録（Task 7）**: 見出し「パスキーを2本登録してください」。1本目「1本目を登録」。2本目の前「別の端末か、セキュリティキーでの登録をおすすめします。」。1本だけで完了「あと1本、登録してください。」。完了「登録が終わりました。パスキーでログインしてください。」。窓が切れた「時間が過ぎました。店長に、もう一度招待を出してもらってください。」

**管理（Task 9）**: 入口「パスキー」（管理画面の右上の自分のメニュー）。削除の下限「パスキーは2本以上必要です。先に別のパスキーを登録してください。」。もう1本「管理画面を使うには、パスキーがあと1本必要です。」。入り直し「安全のため、もう一度パスキーでログインしてから追加してください。」

**拒否・無操作（Task 8・10）**: 「店員の方は、パスキーでログインしてください。」「しばらく操作がなかったため、ログアウトしました。」

**ユーザーの画面（Task 5・11）**: 「店員を招待」「パスキーを全部消してやり直す」（確認の語「やり直し」・理由10字以上）「お客さんに戻す」「店員にする（招待のメールを送ります）」「招待中」「招待を取り消す」。自分の行「自分自身は変更できません。」最後の店長「店長を1人以上残してください。」すでに店員「すでに店員です。やり直しは、一覧の「パスキーを全部消してやり直す」から行ってください。」メール送りの失敗「メールを送れませんでした。もう一度、招待を出してください。」
