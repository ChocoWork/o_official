# 波 5 共有の守り（アプリの session への結び付けと、DB の aal2・生きた session）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 守りの穴の設計（`design-final.md`）の波 5 を直す。(1) アプリのログインの流れ（パスワード → メール OTP → 必要なら TOTP）を通って作られた session だけを受ける。`persistSessionAndCookies`（ログインの最後）が自前の `sessions` に GoTrue の `session_id` を `auth_session_id` として残し、更新（refresh）と TOTP の昇格は「結び付いた行の続き」にだけ引き継ぐ。`authenticateRequest`・`admin-rbac`（`checkAuthSessionLiveness`）・`enroll-totp` は「自前の `sessions` に失効していない行があり、GoTrue の `auth.sessions` にも生きている」時だけ通す。環境変数の旗 `AUTH_REQUIRE_APP_SESSION` で段階的に有効化する（R2、Q30 案 (a)、SEC-AUTH-005・031・030 の 2 段目の部分）。(2) DB でも同じことを求める。`public.has_permission` の本体に「`aal` が `aal2`」と「結び付いた生きた session」の検査を足し（R3 の案 B、SEC-AUTH-010・SEC-ADMIN-002・SEC-LOOK-003・SEC-NEWS-002・SEC-STOCKIST-003・SEC-HOME-003）、会員の本人の行を返す表 3 つ（`profiles`・`orders`・`order_items`）に `AS RESTRICTIVE` の方針を足す（SEC-AUTH-005-AC-02。Q2 は案 B「全部の表を一度に」）。パスワードだけ・メール OTP だけ・anon キーで作った任意の session の通行証は、API では 401、PostgREST では 0 行になる。

**Architecture:** 3 層で進める。**(a) 移行 2 本**（`supabase/pending-wave5/` に書く。別セッション G-4／H が `db reset` を頻繁に流すので、controller が合意した時間にだけ `supabase/migrations/` へ動かす。`progress.md` の波 2 の手順）。M1 `sec_app_session_binding`（列・索引・関数。**既存の挙動を変えない追加だけ**）と、M2 `sec_has_permission_aal2_member_rls`（`has_permission` の置き換えと会員の表の方針。**こちらが効く**）に分け、M1 → アプリのコード → M2 の順に当てる。**M1 は Task 1 の直後の controller の手順（Task 1B）で `supabase/migrations/` に動かし、手元の DB と本番（オーナーの許可つき）に当ててから Task 2 に着手する**（書く側のコードは作業ツリーに入った瞬間から G-4／H・本番の DB につながる普段の開発に効くので、列が無いとログインが全部落ちる。ruling 12）。M2 だけが Task 10 まで `pending-wave5/` に残る。**(b) アプリ**は書く側（Task 2: ログイン・refresh・MFA 昇格が行を作る／引き継ぐ）を先に、読む側（Task 3: 生存の確認を新しい RPC に替える）を後に入れる。旗は読む側だけを切り替え、書く側は常に書く。**(c) 試験の補助**（E2E は Task 4、DB 結合の `helpers/app-session.ts` は Task 1 で作って Task 7 が使う）が、パスワードの通行証を直に Cookie・Bearer に入れる E2E の補助と、claims に `aal`・`session_id` を持たない DB 結合試験に「生きた結び付いた session」を作る道具を足す。**Task 0 は計測だけ**（controller が手元の Supabase で流し、refresh・TOTP の昇格の前後で `session_id` が変わらないことを確かめる。変わるなら止めて controller に戻す。`wave5-decisions.md`）。`private.group_g_actor_has_permissions(_actor_id, …)` は `auth.uid()` に依らず service_role から呼ぶので **G-2／G-3／G-4 の書き手は変わらない**。

**Tech Stack:** Next.js `^16.3.6`（Route Handler）、TypeScript、Supabase（GoTrue の `auth.sessions`・JWT の `session_id`／`aal`／`amr`、PostgREST の RLS、SECURITY DEFINER 関数）、Jest（単体・結合）、Playwright（書くだけ。流すのは controller）。依存は増やさない。

**Spec:** [`.superpowers/sdd/2026-10-25-security-gap-fixes/wave5-decisions.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/wave5-decisions.md)（ユーザー答え Q2 案 B・Q3 Google は 2 段目済み・Q30 案 (a)。**この文書が拘束する**）、調査 [`wave5-q30-research.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/wave5-q30-research.md)。背景: 同ディレクトリの [`design-final.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md) の R2・R3・§3-2 波 5 の行・§3-4（移行の手順）、領域別の `AUTH.md`（SEC-AUTH-005・010・030・031）・`ADMIN.md`（SEC-ADMIN-002）・`LOOK.md`（SEC-LOOK-003・X-1）・`NEWS.md`（SEC-NEWS-002）・`STOCKIST.md`（SEC-STOCKIST-003）・`HOME.md`（§3.1）。前の波の計画（書式の見本）: [`2026-10-28-wave4-client-ip-audit-admin-ui.md`](./2026-10-28-wave4-client-ip-audit-admin-ui.md)、[`2026-10-26-wave2-local-fixes.md`](./2026-10-26-wave2-local-fixes.md)（移行の書式）。

---

## 概要

| 項目 | 内容 |
| --- | --- |
| 作成日 | 2026-10-29。コード・DB・テストは 1 行も変えていない（この計画の作成だけ。読んだのは `src/`・`tests/`・`e2e/`・`supabase/migrations/`・`docs/` と、本番の `pg_policies`・`pg_proc`・`sessions` の件数を Supabase MCP の読むだけの `execute_sql` で） |
| 直す項目 | R2（SEC-AUTH-005 AC-01・AC-02、SEC-AUTH-031 の OTP だけの道、SEC-AUTH-030 の拒否の監査）、R3（SEC-AUTH-010、SEC-ADMIN-002、SEC-LOOK-003、SEC-NEWS-002、SEC-STOCKIST-003、SEC-HOME-003 AC-01）。Q2 案 B・Q3・Q30 案 (a) |
| タスク | 12 つ（計測 Task 0・移行 M1 Task 1・**M1 を動かして当てる controller の手順 Task 1B**・書く側 Task 2・読む側 Task 3・E2E の補助と固定の環境 Task 4・アプリ側の E2E Task 5・移行 M2 Task 6・DB 結合試験の補助と書き換え Task 7・DB 側の E2E の反転 Task 8・文書 Task 9・controller の最終 Task 10）。**実行の順は Task 0 → 1 → 1B → 2 → 3＋4（同じ窓で続けて。下の「着手の条件」）→ 5 → 6 → 7 → 8 → 9 → 10** |
| 新しいコード | `src/lib/auth/app-session.ts`、`supabase/pending-wave5/20261029120000_sec_app_session_binding.sql`、`…120100_sec_has_permission_aal2_member_rls.sql`、`tests/integration/db/helpers/app-session.ts`（Task 1 で作る。Task 7 は使うだけ）、`tests/integration/db/auth_app_session_binding.integration.test.ts`、`tests/integration/db/auth_has_permission_aal2.integration.test.ts` |
| 新しい ADR | `ADR-0417`（AUTH・アプリの session に結び付ける。会員の 2 段は NIST の AAL2 でなくアプリ独自の方針）、`ADR-0418`（AUTH・DB の `has_permission` に aal2 と結び付いた生きた session を求める。会員の表は RESTRICTIVE）、`ADR-0419`（AUTH・旗 `AUTH_REQUIRE_APP_SESSION` は既定で有効）。番号は書く直前に `ls docs/03_BasicDesign/decisions` で再確認する（AUTH の帯の今の最大 `0416`、ADMIN は `0462`） |
| 外す `test.fail` | 現在の行番号で 9 か所（「設計書の印と今の印」の表）。`FR-LOGIN-032:402,488`（ENV）は残す |
| 触らない共有文書 | `requirements.md`・`test-spec.md`・作業と指摘の台帳・`api-spec.md`・`route-inventory.md`・`tests/unit/docs/*-traceability.test.ts`・`er.md`・`screen-list.md`・`screen-flow.md`・`16_admin.md`（G-4／H が触る）。**`docs/06_Operations/db-migrations.md` は controller が Task 10 で書く**（共有。他の波も同じ）。必要な変更は各タスクの報告の「共有文書の変更案」に書く |
| 流さないもの | E2E・サーバー・3000 番・DB 結合試験・`db reset`・全体の `jest`・`trace:report`・`test:trace-coverage`・`validate-trace --update-baseline`・`next build`・本番の変更。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。DB は本番の**読むだけ**（Supabase MCP）以外は触らない。**実装者に対する決まり**。controller の手順（Task 0・1B・10）だけが、合意した窓とオーナーの許可のもとで、移行の移動・`db reset`・本番への M1 の適用を行う |
| 本番 | 本番の事実（2026-10-29 に読んだ）: 移行は `20261026130600` まで全部適用済み。`auth.users` 8 人、自前の `sessions` 48 行のうち失効していない行 3 本。`public.has_permission` の本体は `20261023175712` の物と一致（md5 `418b949c1ec79dfa89ea6454bf81f66a` の定義。`aal` を見ない）。方針 180 本のうち 83 本が `has_permission` を使う。`auth.uid()` を使う方針は `profiles`（4 本・`public` 向け）・`orders`・`order_items`（`authenticated` の読み）だけ。本番のアプリは未デプロイ（memory）で、普段の開発は本番の DB につながる |

### 設計書の印と今の印（確かめた結果）

設計書の行番号は波 2・4 の後で動いた。`grep -rnE "test\.fail" e2e` で現在の行を確かめた。

| 設計書 | 今 | 状態 | 外すタスク |
| --- | --- | --- | --- |
| R2 `FR-LOGIN-031:238`（SEC-AUTH-005-AC-01、アプリ側） | `FR-LOGIN-031:235` | 残っている | 5 |
| R2 `FR-LOGIN-031:262`（SEC-AUTH-005-AC-02、PostgREST） | `FR-LOGIN-031:259` | 残っている | 8 |
| R3 `FR-LOGIN-031:286`（SEC-AUTH-010-AC-01） | `FR-LOGIN-031:283` | 残っている | 8 |
| R3 `FR-ADMIN-MISC-005:158,202`（SEC-ADMIN-002） | `FR-ADMIN-MISC-005:219`（AC-02 の 1 本。AC-01 は波 2 で外れた） | 残っている | 8 |
| R3 `FR-LOOK-SEC-002:269,295` | `FR-LOOK-SEC-002:270`（SEC-LOOK-003-AC-01） | 残っている（AC-02 は波 2 で外れた） | 8 |
| R3 `FR-NEWS-SEC-002:261,305,362` | `FR-NEWS-SEC-002:264`（AC-01）・`:364`（AC-03） | 残っている（AC-02 は波 2 で外れた） | 8 |
| R3 `FR-STOCKIST-016:214,253,310` | `FR-STOCKIST-016:225`（SEC-STOCKIST-003-AC-01） | 残っている（AC-02・AC-03 は波 2 で外れた） | 8 |
| R3 `FR-HOME-024:96,134` | `FR-HOME-024:98`（SEC-HOME-003-AC-01） | 残っている（AC-02 は波 2 で外れた） | 8 |
| R2 `FR-LOGIN-032:402`（SEC-AUTH-030-AC-01）・`:419`（SEC-AUTH-031-AC-01） | `:402,488` は ENV（TOTP の設定）の印だけ。031 は波 1-B で外れた | **残す**（`config.toml` の TOTP が手元で無効のため。別件） | - |

## 前提の読み（読んで確かめた事実と、解釈。controller の確認を求める点を含む）

実装者はこの節を変えない。食い違いに気付いたら止めて報告する。

| # | 読み | 根拠・影響 |
| --- | --- | --- |
| P1 | **今の `has_permission` の本体**は `supabase/migrations/20261023175712_group_g0_permissions.sql:186-217`（`LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''`。`auth.uid()` が空なら false → `user_roles`・`roles`・`role_permissions`・`permissions` の EXISTS）。これが最新（その後の移行で `has_permission` を `CREATE` するのは無い。`grep -ln "FUNCTION public.has_permission" supabase/migrations/*.sql` は `20260901102912`・`20261023175712` の 2 本）。本番の定義も同じ。EXECUTE は `anon` なし・`authenticated`・`service_role`・`postgres`（`remote_schema.sql:3964-3966`。`CREATE OR REPLACE` は所有者と権限を保つ） | M2 は G-0 の本体を**そのまま写し**、2 つの検査を足す。写し間違いは退行（Review Focus 4） |
| P2 | **`has_permission` の呼び手は方針だけ**。`remote_schema.sql` の 105 行（関数の定義 1・GRANT 2 を除く約 100 行が方針）、`20260919141000_fix_rls_initplan…sql` の 14 行、`20261026130200_sec_grants_hardening.sql:82`、`20261026130500_sec_rls_predicates_and_constraints.sql` の 3 行。関数の中から呼ぶ物は無い（`grep -rn "has_permission(" supabase/migrations` で確認。`src/` と `scripts/` からの直の呼びは無く、`tests/` と `e2e/FR-ADMIN-123` にある）。本番の方針 180 本のうち 83 本が使う | 方針は書き換えない（本体 1 本で全部に効く）。安い検査を先に置いて性能を抑える |
| P3 | **`is_auth_session_active`**（`remote_schema.sql:1861-1875`）は `auth.sessions` に `id = p_session_id` の行があり `not_after` が空か未来、を返す SQL 関数（SECURITY DEFINER・search_path 空）。EXECUTE は `postgres`・`service_role` だけ（`:3976-3978`）。呼び手は `checkAuthSessionLiveness`（`src/lib/auth/authenticate.ts:129-152`）の 1 か所と、G-2 の ACL 一覧（`group_g2_foundation.sql:268,1214`・`group_g2_public_function_acl.integration.test.ts:20,139,153`）。**この関数は変えない**（G-2 の確かめが ACL を固定している） | 新しい関数 `public.is_app_session_active(uuid)` を足し、旗が有効な時だけアプリがそちらを呼ぶ |
| P4 | **`public.sessions`**（`remote_schema.sql:866-882`。本番も同じ列）: `id uuid pk`・`user_id`・`refresh_token_hash`・`current_jti`・`ip`・`user_agent`・`device_name`・`created_at`・`expires_at`（**NULL 可**）・`revoked_at`・`last_seen_at`・`previous_refresh_token_hash`・`quarantined`・`csrf_token_hash`・`csrf_prev_token_hash`。`auth_session_id` 用の列は無い（`id` は GoTrue のものと別）。索引は `user_id`・`expires_at`・`last_seen_at` ほか。RLS は anon・authenticated を全部拒み（`sessions_deny_*`）、波 2 で anon・authenticated の権限も外した（`sec_grants_hardening.sql:85-87`）。書く所は service role だけ | M1 が `auth_session_id uuid`（NULL 可）と、`WHERE revoked_at IS NULL AND auth_session_id IS NOT NULL` の**一意でない**部分索引を足す（P6） |
| P5 | **`sessions` の書き手・読み手（全部）**: ①`persistSessionAndCookies`（`src/features/auth/services/register.ts:104-112`。insert。`expires_at` は `session.expires_at`＝**access token の期限**（`:101`）で 7 日ではない）。呼び手 4 つ: `otp/verify:108`（パスワード → メール OTP の最後）、`oauth/callback:167`（Google）、`confirm:140`（登録の確認のリンク。`consumeSignupBinding` が通った時だけ。`verifyOtp` の session を渡す）、`register:178`（Confirm email が OFF の時だけ）。②`persistNewSession`（`session.ts:67-126`。insert を先、旧行の `revoked_at` を後。`expires_at` は 7 日）。呼び手 2 つ: `refresh:114`・`mfa/verify:134`。③`logout:115`（`refresh_token_hash` 一致の行に `revoked_at`）、`password-reset/confirm:43`・`revoke-user-sessions.ts:11`（`user_id` 全部に `revoked_at`）。④読み: `findSessionByRefreshHash`（`session.ts:20-43`。`refresh:41`・`mfa/verify:127`）、`csrfMiddleware.ts:36`（`refresh_token_hash` で `csrf_token_hash`）。**調査（`wave5-q30-research.md:115`）にあった「`api/auth/confirm` は session を捨てる作り」は誤り**で、確認のリンクで入った session は `persistSessionAndCookies` で行が作られる（`UNBOUND_REDIRECT_PATH` の枝だけが捨てる） | 書き手 7 か所が全部 `auth_session_id` の扱いを決められる。`expires_at` の意味が 2 通りあるので、生存の判定に `expires_at` を**使わない**（P7） |
| P6 | **insert を先・旧行の revoke を後**（`session.ts:93-125`）なので、更新・昇格の間は同じ `auth_session_id` を持つ生きた行が 2 本並ぶ。一意索引にすると新しい行の insert が落ちる。**一意でない部分索引にする**。判定は「`auth_session_id` が一致する失効していない行が 1 本以上」 | **ruling 2** |
| P7 | **生存の定義**（M1 の `private.app_session_is_live(uuid)`）: `auth.sessions` に `id = sid` の行があり `not_after` が空か未来 **かつ** `public.sessions` に `auth_session_id = sid` ・`user_id` が `auth.sessions.user_id` と一致・`revoked_at IS NULL` の行がある。`expires_at` は見ない。理由: 列の意味が書き手でずれる（P5 ①は access token の期限＝約 1 時間、②は 7 日）。期限の権威は GoTrue（`auth.sessions.not_after`・JWT の `exp`）。ログアウト・強制失効は `revoked_at` と `auth.sessions` の削除の両方を行う（`logout:115` と `terminateSupabaseSession`、`revoke-user-sessions.ts:11-22`） | 本番の `expires_at` は NULL の行が 0（読んだ）。NULL でも通る書き方にする |
| P8 | **GoTrue の session_id の出どころ**: 本番の `auth.sessions` に `refresh_token_hmac_key`・`refresh_token_counter` 列がある（新しい GoTrue）。つまり refresh token は session に属する回数で数える作りで、**更新で `session_id` は変わらない見込み**。ただし公式文書には一文で書かれていない（`wave5-q30-research.md:68`）。`verifyOtp`（`otp/verify:78`）・`signInWithPassword`・`exchangeCodeForSession`（`oauth/callback:113`）・確認のリンクの `verifyOtp`（`confirm:96`）は**新しい session** を作る。`mfa.verify`（`mfa/verify:101`）は同じ session を aal2 に上げた新しい token 対を返す見込み。ローカルは TOTP が無効（`config.toml` の `[auth.mfa.totp]`）なので、本物の `mfa.verify` は流せず、E2E の補助は `auth.mfa_amr_claims` に `totp` の行を足して refresh で aal2 にしている（`admin-session-test-utils.ts:83-91`） | **Task 0 で実測する**。不変でなければ止めて controller に戻す（`wave5-decisions.md`） |
| P9 | **`authenticateRequest` の流れ**（`authenticate.ts:163-175`）: `verifyAccessToken`（署名・exp・iss・aud。`amr` は見ない）→ `checkAuthSessionLiveness(claims.session_id)`（`:129`。`cache()`。`session_id` が無ければ `revoked`、RPC の失敗は `unavailable`）→ 失敗は `revoked`／`unavailable`。`authFailureResponse` が 401／503（`:184-196`）。`admin-rbac.ts:229` は `verifyAccessToken` の後で `checkAuthSessionLiveness` と ACL の照会を並列に投げる。呼び手の数: `authenticateRequest` を使う route 等が 17 ファイル、`admin-rbac` が管理の窓口全部。**`checkAuthSessionLiveness` の名前・引数・戻り値は変えない**（`tests/` で 44 ファイルがモックする）。中で呼ぶ RPC だけを旗で替える | 旗が有効なら `is_app_session_active`、無効なら従来の `is_auth_session_active`。単体で RPC の名前を固定している試験は `tests/unit/lib/auth/authenticate.test.ts:138` の 1 本 |
| P10 | **refresh は自前の行を門番にしていない**（`refresh/route.ts:43-52`。「行が無くても拒否しない。実際の門番は Supabase の token 交換」）。このままだと、パスワードだけの session の refresh token を `sb-refresh-token` Cookie に入れて `POST /api/auth/refresh` を叩くと、GoTrue が新しい token 対を出し、`persistNewSession` が行を作る → **結び付いていない session が結び付いた session に洗われる**（最大の穴。Review Focus 1）。直し方: 旗が有効な時、前の行が無い・`auth_session_id` が空・失効済みなら、GoTrue を呼ぶ前に 401（Cookie を消す）。`persistNewSession` は、呼び手が「前の行は結び付いている」と確かめた時だけ新しい行に `auth_session_id` を入れる（P11） | 「取りこぼしで正当な利用者を締め出さない」の方針を、結び付けの強制に限って**意図して**変える（ruling 4）。旗が無効の間は従来どおり |
| P11 | **`persistNewSession` の `auth_session_id`**: `IssuedSession` に任意の `trustedAuthSessionId?: string \| null` を足す。値がある時だけ、新しい行の `auth_session_id` を `readAuthSessionId(issued.accessToken) ?? trustedAuthSessionId`（新しい token の `session_id`。不変なら同じ）にする。無い時は NULL（結び付けない）。呼び手: `refresh` は前の行の `auth_session_id`、`mfa/verify` は `authenticateRequest` を通った `auth.claims.session_id`（検証済み・結び付き済み）。**新しい token の `session_id` を前の行の確認なしに読んで保存することは、どこでもしない**（洗濯になる） | `readAuthSessionId` は GoTrue から直に受けた token の署名なしデコード。外から来た token には使わない（TSDoc に書く） |
| P12 | **旗**: `AUTH_REQUIRE_APP_SESSION`。**値が `off`・`0`・`false`（大小文字を区別しない）の時だけ無効、それ以外（未設定を含む）は有効**。`src/lib/auth/app-session.ts` の `isAppSessionRequired()` が 1 か所で読む。**既定で有効**にする理由: ①本番アプリは未デプロイで会員がほぼいない（再ログインの費用が最小）、②設定し忘れで穴が開いたままになるのを避ける、③手元・E2E・単体で実際の道を毎回通す。書く側（行を作る）は旗に関係なく常に書く。DB 側（M2）に旗は無く、当てた時に効く。`scripts/e2e/environment.ts` の `E2E_FIXED_ENV` に `AUTH_REQUIRE_APP_SESSION: 'on'` を入れて固定する（手元の `.env.local` の `off` で E2E が通ってしまうのを防ぐ。固定の鍵の一覧は `computeServerFingerprint` に入る（`environment.ts:202`）ので、足すと古い 3000 番のアプリは使い回されない） | 決定文は「環境変数の旗で段階的に有効化」。既定を有効にするのは**決定文の字面からの変更**なので ruling 1 で確認を求める |
| P13 | **DB の部品**（M1）: ①`private.app_session_is_live(p_session_id uuid) RETURNS boolean`（STABLE・SECURITY DEFINER・`SET search_path = ''`。P7 の定義。EXECUTE は所有者だけ＝`REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`。`private.group_g_actor_has_permissions`（`group_g2_purchasing_foundation.sql:13-31`）と同じ流儀）。②`public.is_app_session_active(p_session_id uuid) RETURNS boolean`（SECURITY DEFINER。①を呼ぶだけ。EXECUTE は `postgres`・`service_role` だけ）。③`private.is_app_bound_live_session() RETURNS boolean`（STABLE・SECURITY DEFINER。`auth.jwt() ->> 'session_id'` を **uuid の形を正規表現で確かめてから**キャストし（形が悪い・空なら false。例外を出さない）、①を呼ぶ。EXECUTE は `authenticated` と `service_role` だけ。`private` スキーマの USAGE は anon・authenticated に既にある（`remote_schema.sql:4052`、`role_permissions.integration.test.ts` の「PostgREST の事前フックを呼べる」）。方針から `(SELECT private.is_app_bound_live_session())` の形で呼ぶ） | 権限は GRANT を明示する決まり（`db-migrations.md`「以後の移行は GRANT を明示する」）。`SET search_path = ''` は `security-definer-search-path-guard.test.ts` が許す |
| P14 | **`has_permission` の新しい本体の順**（安い検査を先に）: ①`auth.uid()` が空 → false（今のまま）→ ②`(SELECT auth.jwt()) ->> 'aal'` が `aal2` でない（`aal` が無ければ `aal1` 扱い）→ false → ③ACL の EXISTS（今のまま）→ false なら false → ④ACL が真の時だけ `private.app_session_is_live(session_id)`（形が悪ければ false）。会員（aal1）と anon は ACL の表を引く前に false を返すので、今より軽くなる。**公開の読み方針は `AS RESTRICTIVE` にしない**（`status = 'published' OR has_permission(…)` の OR の枝が使うだけ。公開の商品・記事を読む一般会員（aal1）を止めない） | 設計 R3「読み出し方針は `AS RESTRICTIVE` を表全体に付けてはいけない」 |
| P15 | **会員の表の RESTRICTIVE の対象**（本番の `pg_policies` の読み取りと移行ファイルで確定。`auth.uid()`・`auth.jwt()` を使う方針は他に無く、`auth.uid()`／`auth.jwt()` を本体で読む関数は `has_permission`・`current_app_role`（権限の文字を返すだけ）・`private.record_order_revision`（トリガー）だけ）: **`profiles`**（`Users can view/insert/update/delete own profile`・`public` 向け・`auth.uid() = user_id`）、**`orders`**（`authenticated orders read`：`has_permission('admin.orders.read') OR auth.uid() = user_id OR session_id = current_setting('app.session_id')`）、**`order_items`**（同様）。`carts`・`wishlists`・`checkout_drafts`・`contact_*`・`refresh_token_history`・`postal_code_cache` は `deny direct client access`（RESTRICTIVE・常に false）か全拒否で、会員の行を PostgREST から返さない。`user_roles` は `has_permission('admin.users.read')`。**追加する方針は 3 本**: `CREATE POLICY "require app bound live session" ON public.<表> AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT private.is_app_bound_live_session())) WITH CHECK ((SELECT private.is_app_bound_live_session()))`。`anon` には付けない（ゲストの注文は `app.session_id` で読む。anon の道は変えない）。`DROP POLICY IF EXISTS` を先に | 設計の「`profiles` `orders` `order_items` `carts` 住所・お気に入り系」のうち、`carts`・住所（`profiles` の列）・お気に入りは既に閉じているか `profiles` に含まれる。**G-4／H が新しく会員の行を返す表を足したら、同じ方針を足す**（Task 10 で G-1 に知らせる） |
| P16 | **DB 結合試験の影響**（`tests/integration/db` 152 ファイル）: `request.jwt.claim(s)` を set する試験は 35 ファイル。うち **G の 9 ファイル**（`group_g2_inventory_list`・`group_g2_purchase_{create,documents,model,quantities,reads,receipts,receipt_reversals}`・`group_g3_draft`）は `{ sub: randomUUID(), role }` で「拒否の確認」だけなので**変わらない**（設計 R3 の「HOME の見立て（G の試験が落ちる）」は当たらない。`AUTH.md` の見立てが正しい）。**G の「一字も変えずに通る」物の正本は 1 つの一覧**: ①`tests/integration/db/group_g*.integration.test.ts` の**全部**（今 54 ファイル。G-4 が増やす）が Task 1〜10 の間に 1 字も変わらない（Task 10 Step 3 が `git diff --stat -- 'tests/integration/db/group_g*'` で空であることを確かめる）、②そのうち claims を set する 10 ファイル（上の 9 と、claims を `''` に戻すだけの `group_g2_public_function_acl`）は、`has_permission` の新しい本体の下でも拒否・ACL の確かめが同じに通る（fail しない）ことが肝。「16 ファイル」という数は使わない。claims を `''` に戻すだけ・`has_permission` を呼ばない試験が **11 ファイル**（`admin_audit_logs_table`・`admin_revoke_sessions_function`・`auth_db_functions`・`auth_password_reset_tokens_table`・`auth_return_intents`・`group_g2_public_function_acl`・`look_status_state`・`news_status_state`・`stockist_status_state`・`look_images_bucket`・`news_images_bucket`）で、変わらない見込み（Task 7 Step 1 で実測）。**この一覧から外した 2 つ**: `auth_sessions_table` は `public.sessions` の列の集合を `toEqual` で固定している（`:73-100`、`DATA-AUTH-001`）ので M1 の新しい列で落ちる → **Task 1 で直す**。`search-functions`（`:154-158`・`:445-449`）は `adminClaims = { sub: admin, role: 'authenticated' }`（`aal`・`session_id` 無し）で管理者が RLS で非公開の行を読む（`toHaveLength(1)`）ことを確かめており、`has_permission` に依るので M2 の後は 0 行になる → **Task 7 で直す**。**書き換える物は 13 ファイル＋補助 1＋補助を使う 4**（Task 7）: `search-functions`、`admin-misc/admin_item_color_presets_table`・`admin-misc/admin_permission_seed`・`admin-misc/admin_rls_policy`・`home/home_items_grants`・`look_permissions`・`look_rls`・`news_articles_rls`・`news_permissions`・`stockist_permissions`・`stockist_rls`・`role_permissions`（`request.jwt.claim.sub` だけを入れる。`auth.jwt()` が空になる）・`order_internal_columns`（会員が自分の注文を読む → 新しい方針で結び付きが要る）、補助 `helpers/admin-table-grants.ts`、それを使う `look_grants_admin_tables`・`news_grants_admin_tables`・`stockist_grants_admin_tables`・`admin-misc/admin_item_color_presets_grants` | 書き換えは「claims に `aal`・`session_id` を足し、`auth.sessions` と `public.sessions` に生きた行を作る」。補助は **Task 1 で作る** `tests/integration/db/helpers/app-session.ts` の `createLiveAppSession`（Task 1 の DB 結合試験が先に使うので、行を作る処理の写しを作らない） |
| P17 | **E2E の補助の影響**（`grant_type=password`・`signInWithPassword`・`mfa_amr_claims` を使う物は 13 の spec と 4 の補助。`admin-session-test-utils.ts` を使う spec は 21 ファイル）。分類: **(A) 中央の 1 か所で直す**: `admin-session-test-utils.ts` の `createAdminSessionActor`（`:97-`）と `elevateAdminSessionToAal2`（`:123-`）が、通行証を作った直後に `bindAppSession`（Task 4。同じファイルの `seedAppSession`（`:156`。結び付けない行を 1 件足すだけ）の隣に足す）で `public.sessions` の行を作る（既定で結び付ける。`{ bindApp: false }` で結び付けない通行証も作れる）。これで `look-admin-test-utils`（Cookie）・`home-test-utils`・`stockist-test-utils`・ADMIN-MISC 001〜007・LOOK-SEC 002〜005・NEWS-SEC 002・005・HOME-024・SEARCH-020・STOCKIST 015・016 が通る。**(B) 別の補助**: `news-test-utils.ts:156-190` の `signInWithPassword`（`elevateWith` の有無で aal1／aal2）、`home-grant-test-utils.ts:127-150` の `createMemberActor`（一般会員の aal1。**結び付けない**＝公開の読みだけに使う）、`stockist-admin-test-utils.ts:72-100`（本物のログイン `loginAsMember` ＋ `mfa_amr_claims` ＋ `/api/auth/refresh`。**本物の流れなので結び付く**。refresh が前の行から引き継ぐことを毎回確かめる道になる）。**(C) 攻撃側のつもりの通行証（結び付けない）**: `FR-LOGIN-031` の `createSignedInActor`（`:119-`）、`FR-LOGIN-032:437`（031-AC-01）、`FR-PRIVACY-007:62`、`FR-ADMIN-MISC-002:91` の一般の利用者の対照、`FR-STOCKIST-012:47`・`FR-SEARCH-020:90` の一般会員（公開の読みだけ）。**(D) 本物のログイン＋amr の補助**: `FR-LOGIN-038:260`・`FR-LOGIN-032` の `elevateCookieToAal2`・`FR-ADMIN-MISC-003:76`（本物のログインで行ができるので変更なし。refresh が引き継ぐ） | 設計の「12 ファイル」より広いので、全件の表を Task 4 の Step 1 に置く |
| P18 | **`enroll-totp`**（`mfa/enroll-totp/route.ts:59-84`）は `authenticateRequest` → 役割の確認 → `hasSecondFactorAmr`（波 1-B）→ `listFactors`…。結び付きの確認は `authenticateRequest` に入るので、パスワードだけ・OTP だけの通行証はここで 401 になる（OTP だけの道が塞がる。SEC-AUTH-031 の残り）。ただし `FR-LOGIN-032:421-461`（031-AC-01）は**断りの監査の行（`action ~ enroll`・`outcome <> 'success'`）を求める**ので、`authenticateRequest` が `revoked` を返した時にも監査が要る。`VerifiedAccessToken` の失敗の形に任意の `claims`（`revoked` の時だけ。検証済み）を足し、`enroll-totp` が `logAudit({ action: 'mfa_enroll', actor_id: claims.sub, outcome: 'denied', detail: 'app_session_required' })` を書いてから 401 を返す。`hasSecondFactorAmr` の確かめは**残す**（二重の守り） | 型は追加のみ。`authFailureResponse` の引数の型は変わらない |
| P19 | **ログイン後の流れの確認**（結び付く道）: パスワード → OTP: `login/route.ts:52` の `signInWithPassword` は session を捨てる（Cookie に渡さない。GoTrue 側に放置された password の session が残る＝結び付かないので無害。後始末は回す物）→ `otp/verify:78` の `verifyOtp` の新しい session → `persistSessionAndCookies:108`。Google: `oauth/callback:113` → `:167`。登録の確認: `confirm:96` → `:140`。更新: `refresh` → `persistNewSession`。TOTP: `mfa/verify:101-139` → `persistNewSession`。ほかに session を Cookie に渡す道は無い（`grep -rn "signInWith\|verifyOtp\|exchangeCodeForSession\|setSession\|refreshSession" src`）。`logout` は `verifyAccessToken(allowExpired)` を直に使う（`authenticateRequest` でない）ので旗の影響を受けない | 取りこぼした道は無い |
| P20 | **jest**: `tests/setupClientIp.js` が全体の環境に `CLIENT_IP_HEADER` を入れる前例（`jest.config.cjs` の `setupFiles`）。旗は**単体でも既定の有効のまま**にして実際の道を通す（`AUTH_REQUIRE_APP_SESSION` を jest の環境で `off` にしない）。`checkAuthSessionLiveness` をモックする 44 ファイルは影響なし。service role の `rpc` を名前で固定するのは `authenticate.test.ts:138` だけ。`createServiceRoleClient` を共通の作り物で差し替え、`rpc` が何を呼んでも `{ data: true }` を返す試験は、新しい RPC 名でも通る。落ちる物は Task 3 Step 5 の全体の単体で洗う | 旗を jest で切ると、結び付きの強制がどの単体でも通らなくなる |
| P21 | **`pending` の置き場**: `supabase/pending/`（既存。`harden_*`・`schedule_*` の手で当てる SQL）とは別に、波 2 と同じ `supabase/pending-wave5/` を新しく作る。G-1／H は `supabase/migrations`・`seed.sql` に作業中の物を置かないでほしいと頼んでいる（`progress.md`）。M1／M2 の時刻は暫定 `20261029120000`・`20261029120100`。動かす時（M1 は Task 1B、M2 は Task 10）に `ls supabase/migrations \| tail` を見て、**全部の既存の移行より後**にする（G-4／H が足していれば付け直す。`db push` は古い時刻を断る）。M1 を付け直したら M2 の時刻も M1 より後にそろえる。M1 だけが先に `supabase/migrations/` に入る（Task 1B）ので、M2 の自己検査は M1 の存在を前提にしてよい | 本番の最後の移行は `20261026130600`（読んだ） |

### 認証の流れと、旗・結び付きの読み方（controller が最後に見る）

| 場面 | 結び付く／引き継ぐ | 旗が有効な時の扱い |
| --- | --- | --- |
| パスワード → メール OTP（`otp/verify`）／Google（`oauth/callback`）／登録の確認のリンク（`confirm`）／登録 201（`register`） | `persistSessionAndCookies` が `auth_session_id` を新しい行に入れる（アプリが作った session。新しい行は結び付く） | 通る |
| 更新（`refresh`） | 前の行が結び付いていれば `persistNewSession` が引き継ぐ。前の行が無い・結び付いていない・失効 → GoTrue を呼ぶ前に 401 | 結び付いた物だけ更新できる |
| TOTP の昇格（`mfa/verify`） | `authenticateRequest` を通った `claims.session_id` を `trustedAuthSessionId` に渡して引き継ぐ | 通る |
| `/auth/v1/token?grant_type=password`・`/auth/v1/otp`→`/auth/v1/verify`（anon キー。アプリを通らない） | 行ができない | 窓口 401・DB 0 行 |
| ログアウト・強制失効・パスワード再設定 | `revoked_at` を立て、`auth.sessions` を消す（今のまま） | 次の要求から 401・DB 0 行 |

## Global Constraints

- 並行作業: 別セッション（G-4／H）が同じ作業ツリーの別ファイルを編集し、コミットの時に全体の `tsc` を通す。**`git add`・`git commit`・`git stash`・`git checkout`・`git reset`・`git restore` は実行しない**（controller がタスクごとにコミットする）。`git status --short` に出ている `.claude/CLAUDE.md`・`package.json` は他者の変更なので触らない。
- **E2E・サーバー・3000 番・DB 結合試験・`db reset`・`supabase` の起動・全体の `jest`・`next build`・`npm run test:trace-coverage`・`npm run trace:report`・`validate-trace --update-baseline` は実行しない**（Task 0 は controller が流す。Task 10 は controller）。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。E2E・DB 結合試験は書くだけ。DB は本番も手元も触らない（本番は Supabase MCP の読むだけの `execute_sql` を除く）。
- **実装者は移行ファイルを `supabase/pending-wave5/` にだけ書く。`supabase/migrations/` に置かない**（G-1／H の `db reset` が拾う）。動かすのは controller だけ: **M1 は Task 1B**（Task 2 に着手する前。手元と本番に当てる）、**M2 は Task 10**。この間、移行を読む単体試験（`tests/unit/migrations/…`）は `supabase/{pending-wave5,migrations}/*_<名前>.sql` のどちらにあっても読める書き方にする（動かした後も同じ試験が通る）。
- **着手の条件（作業ツリーは共有で、コードは入った瞬間から G-4／H の手元・本番の DB につながる普段の開発に効く。ruling 12）。** ①**Task 2 は Task 1B が済む（M1 が `supabase/migrations/` にあり、手元の DB と本番に当たっている）まで dispatch しない**。書く側は常に `auth_session_id` を insert するので、列が無いと `persistSessionAndCookies` が `ok:false` を返し、`otp/verify:108-115` がログインを落とす（OTP・Google・確認のリンクの全部）。②**Task 3 と Task 4 は G-1／H と合意した 1 つの窓の中で続けて入れ、同じ窓でコミットする**。Task 3 を入れると旗が既定で有効なので、`auth_session_id` を持たない既存の session と、E2E の補助が作る password grant の通行証が全部 401 になる（Task 4 の `bindAppSession` が入るまで E2E の通行証は結び付かない）。窓を取る時に G-1／H へ「全員が再ログインになる。E2E の通行証は Task 4 が入るまで落ちる」と知らせる。③Task 3 は Task 1B で `public.is_app_session_active` が当たっていること（無ければ全要求が 503 `unavailable`。`authenticate.ts:139-144`）を dispatch 前に確かめる。
- `.ts` / `.tsx` を 1 つ編集するたびに `npx tsc --noEmit` を流し、自分の誤りをその場で直す。他者の誤りは触らず報告に書く。
- 着手前に `git status --short` を見て、他セッションが変更中のファイルを確かめ、**重ならないようにする**。この波は共有ファイルを触る: `src/lib/auth/authenticate.ts`・`src/lib/auth/admin-rbac.ts`（読むだけ。旗は `authenticate.ts` の中で切り替える）・`src/features/auth/services/{register,session}.ts`・`scripts/e2e/environment.ts`（**G-1 の了承が要る**。`scripts/e2e/**`）・`e2e/admin-session-test-utils.ts` ほか多数の E2E の補助・`tests/integration/db/helpers/`。他者の変更が在れば止めて報告する。
- 触らない: `src/lib/orders/**`・G-4／H の注文・返品・発送・購買・決済・カート・割引の窓口と画面、`src/proxy.ts`・`next.config.ts`・`src/lib/redirect.ts`、`playwright.config.ts`、`supabase/migrations/**`（既存の移行は書き換えない）、`private.group_g_actor_has_permissions` ほか G の関数。`public.is_auth_session_active` は変えない（P3）。
- 共有文書は**編集しない**: `requirements.md`、`test-spec.md`、作業と指摘の台帳、`api-spec.md`、`route-inventory.md`、`er.md`、`screen-list.md`、`screen-flow.md`、`16_admin.md`、`tests/unit/docs/*-traceability.test.ts`、**`docs/06_Operations/db-migrations.md`**（controller が Task 10 で書く）。必要な変更は各タスクの報告に「共有文書の変更案」として書く。`docs/06_Operations/{secrets,deployment-topology}.md`・`.env.example` は Task 4 で編集してよい。
- 文書: 日本語。`documentation-guide` スキルの項目の形（見出し直後の属性表）・ID の体系・TSDoc（`@packageDocumentation`・`@impl`・`@design`・`@remarks` に「なぜ」だけ）・テスト名の先頭に ID を守る。文書の冒頭の確認日は 2026-10-29。絵文字は使わない。要件は `docs/02_Requirements/areas/<area>.md`（`requirements.md` には書かない）、脅威は `docs/05_Quality/security/threats/<area>.md`、構造設計は `docs/03_BasicDesign/areas/<area>.md`、設計判断は `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md`、処理の詳細は `docs/04_DetailDesign/pages/` の頁の `DD-`。「今のコードは満たさない」は**直した項目だけ**外す。新しい受け入れ条件を起こしたら、領域の要件のファイルの冒頭の「E2E ファイルと受け入れ条件の対応表」にも足す。**会員の 2 段（パスワード＋メール OTP）は NIST SP 800-63B-4 の AAL2 ではない**（メールは out-of-band に使えない。3.1.3.1）。要件・ADR には「アプリ独自の方針としての 2 段」と書き、AAL2 を名乗らない。管理者の TOTP が AAL2 側。
- コードのコメント: 範囲内の新しい単位（`src/lib/auth/app-session.ts`）に TSDoc で `@impl IMPL-AUTH-226`・`@design DD-AUTH-039`・`@remarks`（「なぜ」だけ）を付け、`scripts/trace/scope.json` の AUTH の `src` に足す（`tests/unit/lib/auth/app-session.test.ts` は `tests` に）。変えた単位は `@remarks` が今の動きと食い違わないよう直す（`refresh/route.ts:7`・`:43-52` の「自前テーブルは監査用。行が無いことは拒否しない」、`session.ts:56-66` の「sessions テーブルは監査用であり、認可の権威ではない」、`mfa/verify/route.ts:122-125` の「認可はトークンを見るので sessions 行が無くても正しく動く」、`authenticate.ts:115-126`、`enroll-totp/route.ts` 冒頭）。`@impl` の番号は書く直前に `grep -rhoE "IMPL-AUTH-[0-9]+" src | sort -u | tail`（今の最大 `225`）、`DD-AUTH-` は `14_login.md`（今の最大 `038`）で確かめる。
- 入力は信用しない: 記録・監査に、トークン・Cookie の値・`session_id` の値・Supabase の誤りの文を残さない。残してよいのは固定の符号（`app_session_required`・`unbound_session` など）だけ。`readAuthSessionId` が返す値は uuid の形を確かめた物だけ。
- **新しい `Cache-Control: no-store` の応答は足さない**（波 3 の学び: 本文を読まない呼び手が要求を開いたまま残し `networkidle` が止まる）。`refresh` の 401 は今の `NextResponse.json` のまま（`clientFetch` の `performRefresh` は本文を読み切る）。
- コミットは controller が種類ごとに分ける（pre-commit の lint のコマンドの長さの上限。`src`／単体・結合の試験／E2E と scripts／文書／移行。波 4 のとおり）。実装者は分け方を意識して、1 タスクの変更を種類ごとにファイルで分けられる形にする。
- 実装は最小。決定にない設定項目・追加の窓口・画面は作らない（Custom Access Token Hook は採らない＝決定。`AUTH_REQUIRE_APP_SESSION` 以外の旗を作らない）。作業ツリーに CRLF のファイルがある。編集は Edit で行い、`sed -i` は使わない。`graphify update` は自分で流さない。

### ID の割当

番号は**書く直前に再確認**する。違えば割当表をずらして一貫させる。

| 種類 | ID | 題 | タスク |
| --- | --- | --- | --- |
| ADR | `ADR-0417` | アプリの session に結び付ける（自前の `sessions` に GoTrue の `session_id` を残す）。会員の 2 段は NIST の AAL2 でなくアプリ独自の方針。Custom Access Token Hook は採らない | 1 |
| ADR | `ADR-0418` | `has_permission` に aal2 と結び付いた生きた session を求め、会員の本人の行の表（`profiles`・`orders`・`order_items`）は RESTRICTIVE にする | 6 |
| ADR | `ADR-0419` | 旗 `AUTH_REQUIRE_APP_SESSION` は既定で有効（`off`・`0`・`false` だけ無効）。書く側は常に書く。DB に旗は置かない | 2 |
| 実装 | `IMPL-AUTH-226`（`@design DD-AUTH-039`） | `src/lib/auth/app-session.ts`（`isAppSessionRequired`・`readAuthSessionId`） | 2 |
| 詳細設計 | `DD-AUTH-039` | 結び付けの書く側・読む側・refresh の引き継ぎ・旗。**項目は Task 2 が `14_login.md` に作る**（試験の先頭の ID が先に在るように）。Task 3 が節を足す | 2（作る）・3（足す） |
| データ | `DATA-AUTH-0xx` | `sessions.auth_session_id`・`private.app_session_is_live`・`public.is_app_session_active`・`private.is_app_bound_live_session`・`has_permission` の新しい本体・会員の表の方針 3 本。番号は `docs/03_BasicDesign/areas/auth.md` のデータ節の最大の次 | 1・6 |
| 受け入れ条件 | `SEC-AUTH-005-AC-03` | OTP だけで取った通行証（パスワード無し）でも会員の窓口は 401、PostgREST の `profiles`・`orders` は 0 行 | 5・8 |
| 受け入れ条件 | `SEC-AUTH-005-AC-04` | アプリのログイン・refresh・ログアウトの前後で、結び付いた session は通り、ログアウト後は 401・0 行 | 5 |
| 受け入れ条件 | `SEC-AUTH-005-AC-05` | 結び付いていない session の refresh token では `POST /api/auth/refresh` が 401（洗えない） | 2・5 |
| 受け入れ条件 | `SEC-AUTH-010-AC-03` | `has_permission` は aal1・`aal` 無し・`session_id` 無し・形が悪い・結び付いていない・失効後・`auth.sessions` 無しで false、aal2＋結び付き＋生存で true（DB 結合） | 6・7 |
| 受け入れ条件 | `SEC-AUTH-031-AC-02` | メール OTP だけ（アプリを通らない）で取った通行証では、初めての TOTP の登録が 401 で、断りが監査に残る | 3・5 |
| 受け入れ条件 | `SEC-AUTH-030-AC-02` | 結び付けの拒否（`app_session_required`・`unbound_session`）の符号が監査に残り、トークンと `session_id` の値を含まない | 2・3 |

### 共有ファイルの並べ方（shared files）

| ファイル | 触るタスク | 並べ方 |
| --- | --- | --- |
| `src/features/auth/services/register.ts`・`session.ts` | 2 | 1 回だけ（書く側を同じ編集で） |
| `src/app/api/auth/{refresh,mfa/verify}/route.ts` | 2 | 1 回だけ |
| `src/lib/auth/authenticate.ts` | 3 | 1 回だけ（旗・RPC の切り替え・失敗の形）。`admin-rbac.ts` は `checkAuthSessionLiveness` を呼ぶだけなので**触らない** |
| `src/app/api/auth/mfa/enroll-totp/route.ts` | 3 | 1 回だけ |
| `e2e/admin-session-test-utils.ts`（`bindAppSession` もここ）・`news-test-utils.ts`・`home-grant-test-utils.ts` | 4 | 1 回だけ |
| `scripts/e2e/environment.ts`・`tests/unit/scripts/e2e/environment.test.ts` | 4 | **G-1 の了承**（`scripts/e2e/**`）。1 回だけ |
| `supabase/pending-wave5/*` | 1・6 | M1 は Task 1 で書き、Task 1B で `supabase/migrations/` へ動かす。M2 は Task 6、Task 10 で動かす |
| `tests/integration/db/helpers/app-session.ts` | 1（作る） | Task 7 は使うだけ（行を作る処理の写しを作らない） |
| `tests/integration/db/helpers/` のほか | 7 | 1 回だけ |
| `docs/*/areas/auth.md` 系 | 1・2・3・5・6・9 | 順 |
| `docs/*/areas/{admin,look,news,stockist,home}.md` 系 | 9 | 1 回（各領域の要件に「DB でも aal2 と生きた結び付き」を足す） |

---

## Review Focus（最も踏みやすい失敗 9 つ）

レビュアーと実装者は、各タスクの前後でこの 9 つを具体的な入力で確かめる。

1. **洗濯: 結び付いていない session が refresh で結び付く。** `persistNewSession` が新しい token の `session_id` を前の行の確認なしに保存すると、パスワードだけの通行証の refresh token で `POST /api/auth/refresh` を叩くだけで、結び付いた session になる（P10・P11）。確かめる入力（単体）: 前の行が無い／`auth_session_id` が NULL／`revoked_at` あり、の 3 通りで `refresh` が GoTrue を呼ばず 401 と Cookie の削除を返す。`persistNewSession` を `trustedAuthSessionId` なしで呼ぶと `auth_session_id: null` で insert。E2E: password grant の refresh token を Cookie に入れた `POST /api/auth/refresh` が 401（`SEC-AUTH-005-AC-05`）。
2. **OTP だけの通行証が通る。** `amr` に `otp` が入るので、`amr` を見る設計は断れない（`wave5-q30-research.md:9`）。確かめる入力（E2E・実測）: anon キーで `/auth/v1/otp`→`/auth/v1/verify` で取った通行証が `/api/profile` で 401、PostgREST の `profiles` で 0 行、`enroll-totp` で 401＋監査（`SEC-AUTH-005-AC-03`・`SEC-AUTH-031-AC-02`）。
3. **insert を先・revoke を後の間（行が 2 本並ぶ）で落ちる／通らなくなる。** 一意索引にしない（P6）。確かめる入力（DB 結合）: 同じ `auth_session_id` で失効していない行を 2 本入れても `app_session_is_live` が true。旧行だけ失効しても新行が生きていれば true。両方失効で false。
4. **`has_permission` の写し間違いと順番。** G-0 の本体の `SELECT EXISTS (…)` を一字も変えず、`aal` の検査を ACL の前、session の検査を ACL が真の時だけ後に置く。`CREATE OR REPLACE` は `SET search_path = ''` を書き直す必要がある（書かないと設定ごと消える。`db-migrations.md`）。確かめる入力（DB 結合）: 6 通り（aal1・`aal` 無し・`session_id` 無し・形が悪い（uuid でない文字）・結び付いていない・失効後）で false、aal2＋結び付き＋生存で true、ACL の無い人は常に false。移行の自己検査が `pg_get_functiondef` に `'aal2'` と `app_session_is_live` と `user_roles` の三つを含むことを確かめる。`EXECUTE` が `authenticated` に有り `anon` に無いこと（`security_definer_search_path.integration.test.ts` が見る）。
5. **G の書き手・読み手が壊れる。** G は `private.group_g_actor_has_permissions(_actor_id, …)` を使い `auth.uid()`・`has_permission` に依らない（`group_g2_purchasing_foundation.sql:13-31`）。M2 は G の関数を触らない。確かめる入力: `tests/integration/db/group_g*` の**全部**（P16 の一覧。今 54 ファイル。うち claims を set する 10 ファイルが肝）が**一字も変えずに**通る（Task 10 Step 3 の controller が `group_g*` を全部流し、`git diff --stat` で変更 0 を確かめる）。H の新しい方針が `has_permission` を使うなら、H の DB 試験の claims も同じ補助が要る（Task 10 で G-1 に知らせる）。
6. **会員の本人の行の RESTRICTIVE が、正しい利用者を止める。** 方針は `TO authenticated` だけ。ゲスト（anon）は `app.session_id` の道のまま。確かめる入力（DB 結合）: 結び付いた authenticated は自分の `profiles`・`orders`・`order_items` を今までどおり読み書きでき、結び付いていない authenticated は 0 行（書き込みは `42501` か 0 行）、anon の `app.session_id` の注文は今までどおり。アプリの経路: `/api/profile`・`/api/profile/addresses`・`/api/orders`・`/api/orders/[id]` が利用者の JWT で読む（`createClient(request)`）ので、結び付いた通行証で 200（E2E の `FR-ACCOUNT-009`・`010`）。
7. **旗の既定と単体の落ち。** 旗の既定は有効（P12）。確かめる入力（単体）: 未設定・`on`・`1`・空文字で有効、`off`・`OFF`・`0`・`false` で無効。有効な時だけ `is_app_session_active`、無効なら `is_auth_session_active`。Task 3 Step 5 で全体の単体を 1 回流し、新しい RPC 名で落ちる試験を洗う（P20）。
8. **E2E が互いに壊れる／偽の赤。** 結び付けは `bindAppSession` の中央の 1 か所（P17 (A)）。「攻撃側」の通行証は結び付けない（(C)）。直した後の確かめ: `grep -rnE "grant_type=password|signInWithPassword" e2e` の全件が、(A)(B)(C)(D) のどれかに分類済みで、(B) と (A) の外で**会員・管理者の窓口を叩く通行証**に `bindAppSession` が付いていること。refresh の流れを通る E2E（`stockist-admin-test-utils`・`FR-LOGIN-038`・`FR-LOGIN-032`）は、Task 0 の結果（不変）が前提。
9. **適用順と再ログイン（本番だけでなく共有の作業ツリーと手元の DB も）。** M2 を M1・アプリのコードより先に当てると、本番の既存の session 3 本・開発者が全員 401／0 行になる。M1 → アプリ（書く側）→ 読む側＋E2E の補助（同じ窓）→ ログインし直し → M2 の順。**書く側（Task 2）は常に `auth_session_id` を insert する**ので、M1 を当てる前にコードが作業ツリーに入ると手元の DB（`supabase/migrations` から作る）と本番（普段の開発がつながる）で OTP・Google・確認のリンクのログインが全部落ちる。**読む側（Task 3）は旗が既定で有効なので `public.is_app_session_active` が無いと全要求が 503**。だから M1 は Task 1B で Task 2 の前に手元と本番へ当てる。Task 3 と 4 は同じ窓（Global Constraints の「着手の条件」）。旗を `off` にしても M2 の DB 側は効く（旗は DB に無い）。戻すのは M2 のヘッダーの ROLLBACK。

---

## ファイルの全体像

| 区分 | ファイル | 操作 | タスク |
| --- | --- | --- | --- |
| 移行（pending） | `supabase/pending-wave5/20261029120000_sec_app_session_binding.sql`（Task 1B で `supabase/migrations/` へ動かす）、`…120100_sec_has_permission_aal2_member_rls.sql`（Task 10 で動かす） | 新規 | 1・1B・6・10 |
| AUTH の `src` | `src/lib/auth/app-session.ts`（新規）、`src/features/auth/services/{register,session}.ts`、`src/app/api/auth/{refresh,mfa/verify,mfa/enroll-totp}/route.ts`、`src/lib/auth/authenticate.ts` | 新規・変更 | 2・3 |
| 試験（単体・結合） | `tests/unit/lib/auth/app-session.test.ts`（新規）、`tests/unit/lib/auth/authenticate.test.ts`、`tests/unit/features/auth/services/session.test.ts`・`tests/unit/services/register.test.ts`、`tests/unit/api/auth/{refresh,mfa-verify,otp-verify,oauth-callback,confirm,register}-route.test.ts`、`tests/integration/api/auth/{refresh,mfa-verify}.test.ts`、`tests/unit/migrations/sec-app-session-binding.test.ts`・`sec-has-permission-aal2.test.ts`（新規）、`tests/unit/scripts/e2e/environment.test.ts` | 追加・変更 | 2・3・4・1・6 |
| DB 結合試験 | `tests/integration/db/helpers/app-session.ts`（新規）、`auth_app_session_binding.integration.test.ts`（新規）、`auth_has_permission_aal2.integration.test.ts`（新規）、`auth_sessions_table`（Task 1。列の集合）、P16 の 13 ファイルと補助 1・補助を使う 4（Task 7）、`auth_grants_inventory`（Task 1。`public.is_app_session_active` を足す） | 追加・変更 | 1・6・7 |
| E2E 補助・環境 | `e2e/admin-session-test-utils.ts`（既存の `seedAppSession` の隣に `bindAppSession`・`rebindRefreshToken` を足す。新しいファイルは作らない）、`e2e/news-test-utils.ts`、`e2e/stockist-admin-test-utils.ts`（読むだけ）、`scripts/e2e/environment.ts`、`.env.example`、`docs/06_Operations/{secrets,deployment-topology}.md` | 新規・変更 | 4 |
| E2E | `FR-LOGIN-031`・`FR-LOGIN-032`（新しい AC の追加）・`FR-ADMIN-MISC-005`・`FR-HOME-024`・`FR-LOOK-SEC-002`・`FR-NEWS-SEC-002`・`FR-STOCKIST-016`（`test.fail` の削除） | 追加・変更 | 5・8 |
| 文書 | `docs/02_Requirements/areas/{auth,admin,look,news,stockist,home}.md`、`docs/05_Quality/security/threats/{同}.md`、`docs/03_BasicDesign/areas/{同}.md`、`docs/03_BasicDesign/decisions/ADR-0417・0418・0419`（新規）、`docs/04_DetailDesign/pages/14_login.md`、`scripts/trace/scope.json` | 追記・更新 | 1〜9 |

---

## Task 0: 計測（controller が手元の Supabase で流す。コードは書かない）

**範囲:** `wave5-q30-research.md` 5 章の実測。結果が出るまで Task 2 以降に着手しない（Task 1 の移行の下書きは進めてよいが、コミットしない）。

**前提:** 手元の Supabase が起動していること（G-1 の DB の窓。progress の「窓」の合意が要る）。流すのは controller（実装者は流さない）。

**やること:** 次のスクリプトを `.superpowers/sdd/2026-10-25-security-gap-fixes/wave5-task0-session-id-invariance.mjs` に置き、`npx supabase status -o env` の値を環境に入れて流す。作った利用者はスクリプトが消す。出力の JSON を `wave5-task0-report.md` に貼る。

```js
// node wave5-task0-session-id-invariance.mjs  （SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / DATABASE_URL / MAIL_LOCAL_URL を環境に入れる）
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, MAIL_LOCAL_URL } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, MAIL_LOCAL_URL })) {
  if (!v) throw new Error(`${k} が無い`);
}
for (const u of [SUPABASE_URL, DATABASE_URL, MAIL_LOCAL_URL]) {
  if (!/\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u)) throw new Error('手元以外には流さない');
}
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
const ip = () => `10.${[...randomBytes(3)].join('.')}`; // GoTrue の送り元の枠を分ける
const post = async (path, key, body) => {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-forwarded-for': ip() },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return json;
};
const pick = (t) => { const c = decode(t); return { session_id: c.session_id, aal: c.aal, amr: (c.amr ?? []).map((a) => a.method ?? a) }; };
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const out = { steps: [] };
const email = `e2e-wave5-task0-${randomUUID().slice(0, 8)}@example.com`;
const password = `E2e-${randomBytes(12).toString('hex')}!`;
let userId;
try {
  const created = await post('/auth/v1/admin/users', SUPABASE_SERVICE_ROLE_KEY, { email, password, email_confirm: true });
  userId = created.id;

  const a = await post('/auth/v1/token?grant_type=password', SUPABASE_ANON_KEY, { email, password });
  out.steps.push({ step: 'password grant', ...pick(a.access_token) });
  const b = await post('/auth/v1/token?grant_type=refresh_token', SUPABASE_ANON_KEY, { refresh_token: a.refresh_token });
  out.steps.push({ step: 'refresh 1', ...pick(b.access_token) });
  const c = await post('/auth/v1/token?grant_type=refresh_token', SUPABASE_ANON_KEY, { refresh_token: b.refresh_token });
  out.steps.push({ step: 'refresh 2', ...pick(c.access_token) });

  // TOTP の昇格の代わり（ローカルは TOTP が無効。E2E の補助と同じ: amr に totp の行を足して refresh）
  const sid = decode(c.access_token).session_id;
  const before = (await db.query('select id, aal, refreshed_at, refresh_token_counter from auth.sessions where id = $1', [sid])).rows[0];
  await db.query(`insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values (gen_random_uuid(), $1, now(), now(), 'totp')`, [sid]);
  const d = await post('/auth/v1/token?grant_type=refresh_token', SUPABASE_ANON_KEY, { refresh_token: c.refresh_token });
  out.steps.push({ step: 'refresh after totp amr', ...pick(d.access_token) });
  const after = (await db.query('select id, aal, refreshed_at, refresh_token_counter from auth.sessions where id = $1', [sid])).rows[0];
  out.authSessionsRow = { before, after, count: (await db.query('select count(*)::int n from auth.sessions where user_id = $1', [userId])).rows[0].n };

  // OTP だけ（パスワード無し）の通行証。アプリを通らない道
  await post('/auth/v1/otp', SUPABASE_ANON_KEY, { email, create_user: false });
  let code;
  for (let i = 0; i < 30 && !code; i += 1) {
    const s = await (await fetch(`${MAIL_LOCAL_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    const id = s.messages?.[0]?.ID;
    if (id) {
      const m = await (await fetch(`${MAIL_LOCAL_URL}/api/v1/message/${id}`)).json();
      code = `${m.Text ?? ''}\n${m.HTML ?? ''}`.replace(/https?:\/\/\S+/g, ' ').match(/\b(\d{8})\b/)?.[1];
    }
    if (!code) await new Promise((r) => setTimeout(r, 500));
  }
  if (!code) throw new Error('OTP のメールが届かない');
  const e = await post('/auth/v1/verify', SUPABASE_ANON_KEY, { type: 'email', email, token: code });
  out.steps.push({ step: 'otp verify (no password)', ...pick(e.access_token) });

  // アプリが結び付ける session の型: アプリの session は password grant でなく verifyOtp（otp/verify:78）と
  // exchangeCodeForSession から来る。その refresh token で更新しても session_id が変わらないことを測る
  const f = await post('/auth/v1/token?grant_type=refresh_token', SUPABASE_ANON_KEY, { refresh_token: e.refresh_token });
  out.steps.push({ step: 'refresh after otp verify (app-bound session type)', ...pick(f.access_token) });

  const ids = out.steps.slice(0, 4).map((s) => s.session_id);
  out.passwordChainInvariant = ids.every((x) => x === ids[0]);
  out.otpRefreshKeepsSessionId = out.steps[5].session_id === out.steps[4].session_id;
  out.invariant = out.passwordChainInvariant && out.otpRefreshKeepsSessionId;
  out.otpIsNewSession = out.steps[4].session_id !== ids[0];
  out.aalAfterTotpAmr = out.steps[3].aal;
  out.notInAppSessions = (await db.query('select count(*)::int n from public.sessions where user_id = $1', [userId])).rows[0].n === 0;
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.invariant && out.aalAfterTotpAmr === 'aal2' ? 0 : 1;
} finally {
  if (userId) await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }).catch(() => undefined);
  await db.end();
}
```

- [ ] **Step 1: 流す。** 期待: `invariant: true`（`passwordChainInvariant`＝password grant・refresh 2 回・昇格の refresh の 4 本が同じ `session_id`、**かつ** `otpRefreshKeepsSessionId`＝アプリが結び付ける型の session である `/auth/v1/verify` の OTP の session を `grant_type=refresh_token` で更新しても `session_id` が同じ。`refresh/route.ts` が更新する session は password grant でなくこの型）、`aalAfterTotpAmr: "aal2"`、`authSessionsRow.count: 1`（`auth.sessions` の行が増えない）、`otpIsNewSession: true`、`notInAppSessions: true`（アプリを通らないので自前の行が無い）。`amr` の方法名（`otp` か `magiclink` か、refresh 後に `token_refresh` が足されるか）を `wave5-task0-report.md` に書き、`src/lib/auth/amr.ts` の注（「`otp` と `magiclink` のどちらで記録するか未実測」）を直す材料にする（Task 9）。
- [ ] **Step 2: 判定。** `invariant: true` なら Task 1 へ進む。**`false` なら止めて controller に戻す**（`wave5-decisions.md`）。戻す時の材料: どの段で変わったか、変わった後の `auth.sessions` の古い行が残るか、`refresh_token_counter` の動き。その場合の候補は「refresh のたびに新しい `session_id` を前の行の続きとして登録する（P11 の `readAuthSessionId(新しい token) ?? 前の値` がすでにこの形）＋ 古い access token は更新の直後から 401 になる」だが、**自分で選ばない**。
- [ ] **Step 3: 本物の TOTP の確認は本番寄りの環境で。** ローカルでは `mfa.verify` が流せない（P8）。`mfa/verify` の引き継ぎは単体（Task 2）と、`stockist-admin-test-utils` の `/api/auth/refresh`（Task 4）で確かめ、本物の TOTP の昇格は配備前の preview で 1 回確かめる（Task 10「本番の前の確認」）。

---

## Task 1: 移行 M1（列・索引・関数。既存の挙動を変えない）と ADR-0417

**範囲:** `supabase/pending-wave5/20261029120000_sec_app_session_binding.sql` と、それが壊す DB 結合試験（`auth_sessions_table`・`auth_grants_inventory`）、Task 7 も使う補助 `tests/integration/db/helpers/app-session.ts`。アプリは呼ばない。M1 を動かしても何も変わらない（`has_permission` も方針も触らない）。**実装者は `pending-wave5/` に書くところまで。`supabase/migrations/` への移動と当てるのは次の Task 1B（controller）**。

**Files:**

- Create: `supabase/pending-wave5/20261029120000_sec_app_session_binding.sql`、`tests/unit/migrations/sec-app-session-binding.test.ts`、`tests/integration/db/auth_app_session_binding.integration.test.ts`（書くだけ。流すのは controller）、`tests/integration/db/helpers/app-session.ts`（`createLiveAppSession`・`jwtClaims`。下の Interfaces。**Task 7 ではなくここで作る**。Task 7 は使うだけ）
- Modify（M1 の新しい列・関数で落ちるのを同じ変更で直す）: `tests/integration/db/auth_sessions_table.integration.test.ts`（`:73-100` の `DATA-AUTH-001` は `public.sessions` の列を 15 本の `toEqual` で固定している。`auth_session_id: 'uuid null'` を足して 16 本にし、テスト名の「15本」も直す。P16 は「変わらない」としていたが誤り）、`tests/integration/db/auth_grants_inventory.integration.test.ts`（`FUNCTION_EXPECTATIONS`（`:73`）に `{ name: 'is_app_session_active', anon: false, authenticated: false, postgres: true }` を足す。`db-migrations.md`「以後の移行は GRANT を明示する」の「権限を替える移行を足したら、同じ変更で一覧も直す」による。**`private.app_session_is_live`・`private.is_app_bound_live_session` は足さない**: この一覧は `n.nspname = 'public'` だけを引き、全件で `service_role = 可` を求めるが、①は `service_role` からも REVOKE する閉じた関数で、③は `private` スキーマ。この 2 本の権限は M1 の自己検査と `auth_app_session_binding` の ⑧⑨ で守る）
- Docs: `docs/03_BasicDesign/decisions/ADR-0417-auth-bind-app-session-to-gotrue-session-id.md`（新規。背景: 公開の anon キーで password／OTP の通行証が取れる、`amr` では OTP だけを断れない／決定: 案 (a)／退けた案: (b) `amr` だけ・(c) Custom Access Token Hook（最初の通行証に付かない・障害面が増える・失効が遅れる）・(d) 標準 MFA に会員を移す（メールは要素でない）／結果: アプリを通らない通行証は 401・0 行、再ログインが要る／見直す条件: RLS の検索が重いと実測で分かったら (c) を上乗せ／**会員の 2 段は NIST の AAL2 ではなくアプリ独自の方針（NIST 3.1.3.1）**）、`docs/03_BasicDesign/areas/auth.md` のデータ節に `DATA-AUTH-0xx`（列・索引・関数 3 本）

**Interfaces（SQL）:**

```sql
-- 末尾の自己検査は SEC_WAVE5_MIGRATION_ASSERTION_FAILED（55000）。BEGIN/COMMIT 各 1 組。NOTIFY pgrst, 'reload schema' 1 回。
ALTER TABLE public.sessions ADD COLUMN auth_session_id uuid;          -- 冪等にしない（想定外なら落ちる）
CREATE INDEX sessions_auth_session_id_live_idx ON public.sessions (auth_session_id)
  WHERE revoked_at IS NULL AND auth_session_id IS NOT NULL;           -- 一意にしない（P6）

CREATE OR REPLACE FUNCTION private.app_session_is_live(p_session_id uuid) RETURNS boolean  -- 関数は全部 OR REPLACE（db-migrations.md「冪等にする — 関数」）
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_session_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM auth.sessions s
    JOIN public.sessions ps ON ps.auth_session_id = s.id AND ps.user_id = s.user_id AND ps.revoked_at IS NULL
    WHERE s.id = p_session_id AND (s.not_after IS NULL OR s.not_after > pg_catalog.now())) $$;
CREATE OR REPLACE FUNCTION public.is_app_session_active(p_session_id uuid) RETURNS boolean … SELECT private.app_session_is_live(p_session_id) …;
CREATE OR REPLACE FUNCTION private.is_app_bound_live_session() RETURNS boolean … -- JWT の session_id を形で確かめてからキャスト。形が悪い・空は false
-- GRANT: ①は全員 REVOKE（所有者だけ）。②は REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role。③は REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO authenticated, service_role。
```

```ts
// tests/integration/db/helpers/app-session.ts（Task 1 で作る。Task 7 と M2 の試験も使う）
/** auth.sessions と public.sessions に、結び付いた生きた session の行を作る（呼ぶ側の begin/rollback の中。auth.users の行が先に要る）。 */
export async function createLiveAppSession(db: PgClient, userId: string, options?: { aal?: 'aal1' | 'aal2'; bind?: boolean; revoked?: boolean }): Promise<{ sessionId: string }>;
/** PostgREST が入れる JWT の claims（role authenticated・aal・session_id）。set_config('request.jwt.claims') に渡す */
export function jwtClaims(userId: string, session: { sessionId: string }, aal?: 'aal1' | 'aal2'): Record<string, unknown>;
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P3〜P7・P13 を `remote_schema.sql:866-882,1861-1875`・`group_g2_purchasing_foundation.sql:13-31`・`sec_grants_hardening.sql` の書式で目で確かめる。ヘッダーに書く本番の読み取り（`schema_migrations` の最後が `20261026130600`、`sessions` の列、`pg_get_functiondef('public.has_permission(text)')` の md5）を、controller が適用前に再取得する手順として書く。
- [ ] **Step 2（RED）: 試験を書く。** 単体 `sec-app-session-binding.test.ts`（先頭 `DATA-AUTH-0xx`）: ファイルが `supabase/{pending-wave5,migrations}` のどちらかにあること、`BEGIN`/`COMMIT` が各 1 組、`ALTER TABLE public.sessions ADD COLUMN auth_session_id uuid`（`IF NOT EXISTS` なし）、索引が**一意でなく**部分、3 つの関数が `CREATE OR REPLACE FUNCTION`（`OR REPLACE` なしの `CREATE FUNCTION` が無い）かつ `SECURITY DEFINER` かつ `SET search_path = ''`、`REVOKE ALL … FROM PUBLIC` を各関数に持つ、`ROLLBACK` のコメントを持つ、`ALTER DEFAULT PRIVILEGES` を使わない。DB 結合 `auth_app_session_binding.integration.test.ts`（`describeLocalDb`・`begin`/`rollback` で包む。行は**このタスクで作る補助 `helpers/app-session.ts` の `createLiveAppSession`** で作る。テスト内に写しの関数を作らない。`auth.users` の行はテスト側で先に入れる）: ①結び付いた生きた session → `app_session_is_live` true、②`public.sessions` の行が無い（アプリを通らない）→ false、③`revoked_at` あり → false、④同じ `auth_session_id` の 2 行のうち旧行だけ失効 → true、両方失効 → false、⑤`auth.sessions` の行を消す → false、⑥`auth.sessions.not_after` が過去 → false、⑦`auth.sessions.user_id` と `sessions.user_id` が食い違う → false、⑧`is_app_session_active` は anon・authenticated が `42501`、service_role が呼べる、⑨`is_app_bound_live_session` は claims の `session_id` が無い・空・`'not-a-uuid'` で例外を出さず false、結び付いた session で true、anon が `42501`、⑩`auth_session_id` の既存行が全部 NULL（本番の 48 行は NULL のまま）。既存の 2 本も同じ変更で直す: `auth_sessions_table` の `DATA-AUTH-001` を 16 列（`auth_session_id: 'uuid null'` を足す）に、`auth_grants_inventory` の `FUNCTION_EXPECTATIONS` に `is_app_session_active` を足す（上の Files）。
- [ ] **Step 3（GREEN）: 移行と補助を書く。** 上の Interfaces。**`helpers/app-session.ts` を作る**（`createLiveAppSession`・`jwtClaims`。`auth.sessions` は `(id, user_id, created_at, updated_at, aal, not_after)`。`aal` は `$::auth.aal_level`。手元の GoTrue に列があること。`group_g2_public_function_acl.integration.test.ts:109` の insert を参考にする。`public.sessions` は `(user_id, refresh_token_hash = 'test-' || gen_random_uuid(), auth_session_id, expires_at = now() + interval '7 days', last_seen_at)`。`bind: false` は `public.sessions` を作らない。`revoked: true` は `revoked_at = now()`）。Task 7 はこの補助を使うだけで、写しを作らない。ヘッダーに ROLLBACK（`DROP FUNCTION IF EXISTS public.is_app_session_active(uuid); DROP FUNCTION IF EXISTS private.is_app_bound_live_session(); DROP FUNCTION IF EXISTS private.app_session_is_live(uuid); DROP INDEX IF EXISTS public.sessions_auth_session_id_live_idx; ALTER TABLE public.sessions DROP COLUMN auth_session_id;`。M2 を先に戻してから）、前提（本番の読み取り）、適用の境界（アプリの書く側が出る前に当てても害は無い）を書く。末尾の自己検査: 列が `uuid`・NULL 可、索引が部分で一意でない、3 関数の `prosecdef`・`proconfig`・`has_function_privilege` が上の GRANT と一致、`anon`・`authenticated` に `public.sessions` の権限が無いまま（波 2 から変わらない）。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/migrations/sec-app-session-binding.test.ts tests/unit/migrations/security-definer-search-path-guard.test.ts`。**`supabase/migrations/` に置かないので、後者はまだこの移行を見ない**（Task 1B で動かした後に通ること）。DB 結合（`auth_app_session_binding`・`auth_sessions_table`・`auth_grants_inventory`）は Task 1B で controller が流す。
- [ ] **Step 5: 文書・報告。** ADR-0417。`validate-docs`・`validate-trace -- AUTH`。共有文書の変更案（`db-migrations.md` の節は controller）を報告に。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 1B: M1 を `supabase/migrations/` へ動かし、手元と本番に当てる（controller。Task 2 の dispatch の前。ruling 12）

**範囲:** コードは書かない。M1 は追加だけ（列・索引・関数。既存の挙動を変えない）なので、先に当てても害は無い。Task 2 以降のコードは作業ツリーに入った瞬間から G-4／H の手元と、本番の DB につながる普段の開発に効く（本番のアプリは未デプロイ。memory）。列が無いと `persistSessionAndCookies`（`register.ts:104-119`）の insert が落ちて `ok:false` を返し、`otp/verify:108-115` がログインを落とす。`is_app_session_active` が無いと Task 3 で全要求が 503。だから **M1 が手元と本番に当たるまで Task 2 を dispatch しない**。

- [ ] **Step 0: 窓の合意。** G-1／H に「`supabase/migrations/` に M1 を 1 本足す。手元の DB は `npx supabase migration up`（または `db reset`）で当てる。追加だけで挙動は変わらない」と知らせ、置き換え・手元の DB への適用の窓（短い）を取る。本番へ当てることは、オーナーの許可を取る（「直し → 送料 → 守り → G → H → …」の順の中で許可済みの push・本番適用とは別の、M1 だけを先に当てる追加の本番変更なので、毎回の確認が要らない扱いにしない）。
- [ ] **Step 1: 動かす。** `ls supabase/migrations | tail -3` で最後の時刻を見て、M1 の時刻が**全部の既存の移行より後**であることを確かめる（G-4／H が足していれば付け直す。付け直すなら M1 の名前・ヘッダー・単体試験・ADR-0417・文書と、M2 の名前・参照を一貫させ、M2 は M1 より後にする）。ファイルを `supabase/pending-wave5/` から `supabase/migrations/` へ移す（`git add`／`git commit` は実装者でなく controller が、種類ごとの分け方で行う）。
- [ ] **Step 2: 手元。** `npx jest tests/unit/migrations/sec-app-session-binding.test.ts tests/unit/migrations/security-definer-search-path-guard.test.ts`（M1 の 3 関数をここで初めて守る）。手元の DB に当て（`db reset` または `migration up`）、自己検査（`SEC_WAVE5_MIGRATION_ASSERTION_FAILED` が出ない）。`DATABASE_URL=… npx jest tests/integration/db/auth_app_session_binding.integration.test.ts tests/integration/db/auth_sessions_table.integration.test.ts tests/integration/db/auth_grants_inventory.integration.test.ts tests/integration/db/group_g2_public_function_acl.integration.test.ts tests/integration/db/security_definer_search_path.integration.test.ts --runInBand`。通ること。
- [ ] **Step 3: 本番（オーナーの許可の後）。** ①適用前に `get_advisors`（security）を保存し、`schema_migrations` の最後（G-1 以降の最新）と、`select md5(pg_get_functiondef('public.has_permission(text)'::regprocedure))` が `418b949c1ec79dfa89ea6454bf81f66a` の定義であることを読む。②`supabase migration list --linked` で、本番に無い移行が **M1 の 1 本だけ**であることを確かめてから `db push --linked`（G-4／H の未適用の移行が混ざっているなら、M1 だけを MCP の `apply_migration` で当て、名前を台帳に合わせる。当てた文は `schema_migrations` の `md5(statements[1])` でファイルと突き合わせる）。③事後: `public.sessions.auth_session_id` が有り全行 NULL、3 関数と権限（`anon`・`authenticated` は `public.is_app_session_active` を呼べない）、`get_advisors` の security に増えた WARN が無い。既存の session・方針・`has_permission` は変わらない（挙動の変化なし）。
- [ ] **Step 4: 記録と通知。** 手元と本番に当てたことを `wave5-task0-report.md` に追記し、G-1／H に「M1 は入った。Task 3＋4 の窓では全員が再ログインになる（まだ。窓の合意の時に知らせる）」と伝える。この後に Task 2 を dispatch する。
- **戻す:** M1 のヘッダーの ROLLBACK（M2 はまだ無いのでそのまま）。Task 2 のコードが入った後は、先にコードを戻す。

---

## Task 2: 書く側（ログイン・refresh・MFA 昇格が `auth_session_id` を作る／引き継ぐ）と旗

**範囲:** 読む側（Task 3）より先に入れる。旗は読む側だけを切り替えるので、このタスクだけでは挙動が変わらない（行に列が増え、refresh の強制だけが旗で有効になる）。**refresh の強制（P10）は旗が有効な時だけ**。**dispatch の前提: Task 1B が済んでいる（M1 が手元と本番に当たっている）こと。** 書く側は旗に関係なく常に `auth_session_id` を insert するので、列が無いと全ログインが落ちる。refresh の強制は旗が既定で有効のため、このタスクが入った時点から、`auth_session_id` を持たない既存の session の更新も 401 になる（窓の前に入れてよい。影響は、開発者の手元の古い session が `/api/auth/refresh` で 401 になり再ログインになることだけの見込み。E2E の通行証は本物のログインで作る物以外 `/api/auth/refresh` を通らない。通る E2E で落ちたら Task 4 の表で確かめる）。

**Files:**

- Create: `src/lib/auth/app-session.ts`、`tests/unit/lib/auth/app-session.test.ts`
- Modify: `src/features/auth/services/register.ts`（`:104-112` の insert に `auth_session_id: readAuthSessionId(accessToken)` を足す。旗が有効で `null` なら `{ ok: false, error: 'auth_session_id_missing' }` を insert の前に返す）、`src/features/auth/services/session.ts`（`Session` に `auth_session_id?: string \| null`、`findSessionByRefreshHash` の select に `auth_session_id`、`IssuedSession` に `trustedAuthSessionId?`、`persistNewSession` の insert に P11 の値）、`src/app/api/auth/refresh/route.ts`（P10）、`src/app/api/auth/mfa/verify/route.ts`（`trustedAuthSessionId: auth.claims.session_id`）、`scripts/trace/scope.json`
- Test: `tests/unit/features/auth/services/session.test.ts`、`tests/unit/services/register.test.ts`、`tests/unit/api/auth/{refresh-route,mfa-verify-route,otp-verify-route,oauth-callback-route,confirm-route,register-route}.test.ts`、`tests/integration/api/auth/{refresh,mfa-verify}.test.ts`、`tests/integration/api/auth-mfa-verify-api.test.ts`（insert の中身を固定している物があれば `auth_session_id` を足す）
- Docs: `docs/04_DetailDesign/pages/14_login.md` に `DD-AUTH-039` の項目だけ作る、`docs/02_Requirements/areas/auth.md` に `SEC-AUTH-005-AC-05`（refresh は洗えない）を足し、`docs/03_BasicDesign/decisions/ADR-0419-auth-require-app-session-flag-default-on.md`（新規）

**Interfaces:**

```ts
// src/lib/auth/app-session.ts（@impl IMPL-AUTH-226・@design DD-AUTH-039）
/** AUTH_REQUIRE_APP_SESSION が off・0・false（大小文字を区別しない）の時だけ偽。未設定・空・その他は真（既定で有効） */
export function isAppSessionRequired(): boolean;
/** GoTrue から直に受けた access token の session_id（uuid の形の時だけ）。署名は見ない。外から来た token に使わない */
export function readAuthSessionId(accessToken: string | null | undefined): string | null;

// session.ts
export type IssuedSession = { /* 既存 */ trustedAuthSessionId?: string | null };
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P5・P10・P11・P19 を目で確かめる。`session.test.ts`・`register.test.ts`・各 route の単体で、`sessions` の insert を `toHaveBeenCalledWith` で固定している箇所を `grep -n "refresh_token_hash" tests/unit` で洗い出して報告の冒頭に表にする。
- [ ] **Step 2（RED）: 単体を書く**（先頭 `DD-AUTH-039`）。`app-session.test.ts`: 旗の表（未設定・空・`on`・`1`・`true`・`yes` で真、`off`・`OFF`・`0`・`false`・` False ` で偽）。`readAuthSessionId`: uuid の `session_id` を返す、無い・空・uuid でない・`aud` だけ・壊れた base64・ドット無しは null。`session.test.ts`: `persistNewSession` が `trustedAuthSessionId` 無しで `auth_session_id: null`、有りで新しい token の `session_id`（無ければ `trustedAuthSessionId`）を入れる、insert が先・revoke が後は変わらない。`register.test.ts`: `persistSessionAndCookies` が `auth_session_id` を入れる、旗が有効で `session_id` の無い token は insert せず `ok: false`、旗が無効なら `null` で insert。`refresh-route.test.ts`: 旗が有効で、前の行が無い／`auth_session_id` が NULL／`revoked_at` あり、の 3 通りで **GoTrue（`fetch`）を呼ばず** 401＋Cookie の削除＋監査（`detail: 'unbound_session'`。トークン・`session_id` を含まない）、結び付いた行なら今までどおり更新して `persistNewSession` に `trustedAuthSessionId` が渡る、旗が無効なら 3 通りとも今までどおり通る。`mfa-verify-route.test.ts`: `persistNewSession` に `trustedAuthSessionId: claims.session_id` が渡る。
- [ ] **Step 3（GREEN）: 実装する。** 上の Interfaces と P10・P11。`register.ts`・`session.ts`・両 route の TSDoc の `@remarks` を今の動きに直す（Global Constraints）。`mfa/verify` の「sessions 行が無くても正しく動く」は、`trustedAuthSessionId` を渡すので**新しい行が引き継ぐ**、と直す。`tsc`。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/lib/auth/app-session.test.ts tests/unit/features/auth/services tests/unit/services/register.test.ts tests/unit/api/auth tests/integration/api/auth tests/integration/api/auth-mfa-verify-api.test.ts`。
- [ ] **Step 5: 文書・報告。** ADR-0419、`14_login.md` の `DD-AUTH-039`、`scope.json`（AUTH の `src` に `src/lib/auth/app-session.ts`、`tests` に `tests/unit/lib/auth/app-session.test.ts`）。`validate-docs`・`validate-trace -- AUTH`。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 3: 読む側（生存の確認を結び付き込みに替える）と `enroll-totp` の断りの監査

**範囲:** `checkAuthSessionLiveness` の中で呼ぶ RPC を旗で替える。名前・引数・戻り値は変えない（44 ファイルのモックが前提）。`admin-rbac.ts` は触らない（`checkAuthSessionLiveness` を呼ぶので自動で効く）。

**dispatch の前提（Global Constraints の「着手の条件」）:** ①Task 1B が済み、`public.is_app_session_active` が手元と本番に有る（無いと全要求が 503）。②**Task 4 と同じ窓**。G-1／H と合意した 1 つの窓の中で Task 3 → Task 4 を続けて入れ、同じ窓でコミットする。Task 3 だけが入った間は、`auth_session_id` を持たない既存の session と、password grant で作る E2E の通行証（Task 4 の `bindAppSession` 前）が全部 401 になる。窓の合意の時に G-1／H へ「全員が再ログインになる」と知らせる（controller。ruling 12）。

**Files:**

- Modify: `src/lib/auth/authenticate.ts`（`:129-152` の RPC 名を `isAppSessionRequired() ? 'is_app_session_active' : 'is_auth_session_active'` に。`VerifiedAccessToken` の失敗の形に `revoked` の時だけ任意の `claims`。`authenticateRequest` が `revoked` に claims を付けて返す。`:115-126` の TSDoc を直す）、`src/app/api/auth/mfa/enroll-totp/route.ts`（`!auth.ok` の枝で、`auth.reason === 'revoked' && auth.claims` なら `logAudit({ action: 'mfa_enroll', actor_id: auth.claims.sub, outcome: 'denied', detail: 'app_session_required' })` の後で `authFailureResponse`。`hasSecondFactorAmr` は残す）
- Test: `tests/unit/lib/auth/authenticate.test.ts`、`tests/unit/lib/auth/admin-rbac.test.ts`、`tests/unit/api/auth/enroll-totp-route.test.ts`（無ければ既存の enroll の単体）、`tests/integration/api/auth-admin-totp-flow.test.ts`
- Docs: `14_login.md` の `DD-AUTH-039` に読む側の節、`docs/02_Requirements/areas/auth.md`（`SEC-AUTH-005-AC-03`・`SEC-AUTH-031-AC-02`・`SEC-AUTH-030-AC-02`）、`docs/05_Quality/security/threats/auth.md`、`docs/03_BasicDesign/areas/auth.md`

**Interfaces:**

```ts
export type VerifiedAccessToken =
  | { ok: true; claims: JwtPayload }
  | { ok: false; reason: 'missing' | 'invalid' | 'unavailable' }
  | { ok: false; reason: 'revoked'; claims?: JwtPayload }; // revoked のときだけ、署名検証済みの claims（監査の行為者のため）
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P9・P18。`grep -rn "reason === 'revoked'\|\.reason" src` で、失敗の `reason` を読む呼び手が型の変更で壊れないことを確かめる。
- [ ] **Step 2（RED）: 単体を書く**（先頭 `DD-AUTH-039`）。`authenticate.test.ts`: 旗が有効（既定）で RPC 名が `is_app_session_active`（`p_session_id` を渡す）、旗が `off` で `is_auth_session_active`、`false` → `revoked`（`claims` が付く）、RPC の error → `unavailable`（`claims` 無し）、`session_id` 無し → `revoked`。`admin-rbac.test.ts`: 結び付いていない session（RPC が false）で 401＋`denial.reason: 'session'`、`checkAuthSessionLiveness` が ACL の照会と並列に呼ばれる（今のまま）。`enroll-totp` の単体: `authenticateRequest` が `revoked` を返すと 401 を返し `mfa_enroll`/`denied`/`app_session_required` を 1 行だけ書く（`claims` が無いと書かない）、行為者以外（トークン・`session_id`・メール）を含まない。
- [ ] **Step 3（GREEN）: 実装する。** `tsc`。`authFailureResponse` の引数の型が変わらないことを確かめる。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/lib/auth tests/unit/api/auth tests/integration/api/auth-admin-totp-flow.test.ts`。
- [ ] **Step 5: 全体の単体を 1 回。** 旗の既定が有効（P12・P20）なので、新しい RPC 名・結び付きで落ちる物があるかを洗う。**流してよい全体の `jest` は、この Step の 1 回だけ**（`npx jest tests/unit tests/integration/api tests/integration/ui`。DB 結合は `DATABASE_URL` が無ければ skip）。落ちた物は「旗の既定の有効で RPC の作り物が名前で固定している」かを見て直す。他者（G-4／H）の落ちは触らず報告に書く。
- [ ] **Step 6: 文書・報告。** `validate-docs`・`validate-trace -- AUTH`。共有文書の変更案は無い。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 4: E2E の補助（結び付けた通行証を作る）と固定の環境

**範囲:** E2E の道具だけ。**spec の `test.fail` は触らない**（Task 5・8）。`scripts/e2e/**` は着手前に controller が G-1 に了承を取る（Task 4 の冒頭に「前提」）。**Task 3 と同じ窓で続けて入れる**（Task 3 だけが入った間は E2E の通行証が結び付かず全部 401。Global Constraints の「着手の条件」）。

**Files:**

- Modify: `e2e/admin-session-test-utils.ts`（**新しいファイルは作らない**。`:156` に既存の `seedAppSession`（`public.sessions` に `user_id` と `refresh_token_hash` だけの失効していない行を 1 件足し、`FR-ADMIN-MISC-001` が強制失効の数えに使う。結び付けない）があり、同じ表に行を作る補助なので、`bindAppSession`・`rebindRefreshToken` はこのファイルの `seedAppSession` の隣に足す。`seedAppSession` の署名と挙動は変えない（`FR-ADMIN-MISC-001:80` が使う）。`createAdminSessionActor` と `elevateAdminSessionToAal2` に `bindApp`（既定 `true`）。結び付けた時は昇格後の `refreshToken` で行の `refresh_token_hash` も更新）、`e2e/news-test-utils.ts`（`signInWithPassword` に `bindApp`（既定 `true`）。`admin-session-test-utils` の `bindAppSession` を import して自分の `withLocalDb` の DB に使う。行を作る処理を写さない）、`scripts/e2e/environment.ts`（`E2E_FIXED_ENV` に `AUTH_REQUIRE_APP_SESSION: 'on'`。注の文に追記）、`tests/unit/scripts/e2e/environment.test.ts`、`.env.example`、`docs/06_Operations/{secrets,deployment-topology}.md`
- 読むだけ（変えない）: `e2e/stockist-admin-test-utils.ts`・`e2e/home-grant-test-utils.ts`・`e2e/member-session-helpers.ts`

**Interfaces:**

```ts
// e2e/admin-session-test-utils.ts（既存の seedAppSession の隣）
/** アプリが作る sessions の行と同じ形の行を作り、通行証の session_id に結び付ける。手元の DB だけ。refresh_token_hash は src/lib/hash.ts の tokenHashSha256 で作る */
export async function bindAppSession(db: PgClient, input: { userId: string; accessToken: string; refreshToken: string }): Promise<{ authSessionId: string }>;
/** 昇格などで refresh token が変わった時に行の refresh_token_hash を合わせる */
export async function rebindRefreshToken(db: PgClient, input: { authSessionId: string; refreshToken: string }): Promise<void>;
```

- [ ] **Step 1: 全件の表を作る**（読むだけ）。`grep -rnE "grant_type=password|signInWithPassword|mfa_amr_claims|createAdminSessionActor|signInAsLookAdmin|accessCookieName" e2e` の全件を、P17 の (A)〜(D) に分けた表を報告の冒頭に置く（ファイル・行・分類・変更の要否）。(A) で足りない物（`createAdminSessionActor` を使わずに管理の窓口を叩く通行証）を見つけたら (B) に足す。
- [ ] **Step 2（RED）: 試験。** `tests/unit/scripts/e2e/environment.test.ts`: `E2E_FIXED_ENV` に `AUTH_REQUIRE_APP_SESSION: 'on'` があり、`buildE2EOverrides` の結果に混ざり、`computeServerFingerprint` の `fixed` に入る（鍵の一覧が変わるので古い 3000 番のアプリは使い回されない）。`bindAppSession` は手元の DB だけ（`isLocalUrl`）で、手元以外なら投げる（既存の補助と同じ見張り）。
- [ ] **Step 3（GREEN）: 実装する。** `bindAppSession` は `readClaims(accessToken)` の `session_id`・`sub` を取り、`insert into public.sessions (user_id, refresh_token_hash, auth_session_id, expires_at, last_seen_at, csrf_token_hash) values (…, now() + interval '7 days', now(), …)`。**`sub` と `userId` が合わなければ投げる**。`createAdminSessionActor` は通行証ができて `aal` を確かめた**後**に呼ぶ（昇格後の `refresh_token` を使う）。`bindApp: false` では何もしない。攻撃側の対照（P17 (C)）はこの option か、そもそも補助を使わない。`.env.example` と `secrets.md`・`deployment-topology.md` に `AUTH_REQUIRE_APP_SESSION`（既定で有効・`off` は段階の切替えと緊急用・本番では設定しない）を書く。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/scripts/e2e/environment.test.ts`。E2E は書くだけ。`npx tsc --noEmit`。
- [ ] **Step 5: 報告。** 表、(B)(C)(D) の判断、共有文書の変更案（無し）。controller は Task 4 を G-1 の了承の後でコミットする。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 5: アプリ側の E2E（反転と新しい受け入れ条件）

**範囲:** 書くだけ（流すのは controller）。M2 の要らないアプリ側の AC だけ。PostgREST 側（`FR-LOGIN-031:259,283`）は Task 8。

**Files:**

- Modify: `e2e/FR-LOGIN-031-supabase-direct-bypass.spec.ts`（`:235` の `test.fail` を外す＝SEC-AUTH-005-AC-01。冒頭の注と表を直す。**新しい AC を足す**: `SEC-AUTH-005-AC-03`（OTP だけの通行証。`/auth/v1/otp`→Mailpit→`/auth/v1/verify`。`/api/auth/me` が `authenticated: false`、`/api/profile`・`/api/orders` が 401）、`SEC-AUTH-005-AC-05`（password grant の refresh token を `sb-refresh-token` Cookie に入れた `POST /api/auth/refresh` が 401。Origin と CSRF の Cookie は付ける）、`SEC-AUTH-031-AC-02`（OTP だけで取った admin の通行証で `enroll-totp` が 401、`audit_logs` に `mfa_enroll`/`denied` が 1 行））、`e2e/FR-ACCOUNT-009-authenticated-profile-fetch.spec.ts` または `FR-LOGIN-030-session-cookies-and-responses.spec.ts`（`SEC-AUTH-005-AC-04`：本物のログイン（`loginAsMember`）→ `/api/profile` 200 → `POST /api/auth/refresh` 200 → 再び 200 → ログアウト → 401。既存の spec に足す）
- Docs: `docs/02_Requirements/areas/auth.md` の対応表、`docs/05_Quality/security/threats/auth.md`

- [ ] **Step 1: 現状の確認（読むだけ）。** `FR-LOGIN-031` の `createSignedInActor`（`:119-`）・`requestToken`（`:84-`）・`bearer`・`ensureOwnedRows`。OTP だけの通行証を作る補助は `member-session-helpers.ts` の `readLatestCode`（8 桁）を使えるが、`loginAsMember` は**使わない**（アプリを通さない道を作るのが目的）。`/auth/v1/otp` の GoTrue の送り元の枠は `x-forwarded-for` をテストごとに変えて避ける（P5 の流儀）。
- [ ] **Step 2: 書く。** 新しい AC は 3 つの幅のうち 1 つでよい（HTTP だけの試験。既存の流儀）。`SEC-AUTH-005-AC-03` は Mailpit を `readLatestCode` で読む。Cookie の値・JWT・コードを失敗の文面に出さない。試験の最上位に `test.use({ trace: 'off' })`。`test.fail` は付けない（Task 2・3 が済んでいる前提）。
- [ ] **Step 3: 外す印。** `FR-LOGIN-031:235`（SEC-AUTH-005-AC-01）。**`:259`・`:283` は残す**（Task 8）。冒頭の注の「波 5 まで赤」を直す。
- [ ] **Step 4: 報告。** 流す順（controller が最後に流す E2E の候補: `e2e/FR-LOGIN-031 e2e/FR-LOGIN-030 e2e/FR-ACCOUNT-009 e2e/FR-LOGIN-032 e2e/FR-LOGIN-038`）。

**検証コマンド:** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 6: 移行 M2（`has_permission` の置き換えと会員の表の方針）と ADR-0418

**範囲:** `supabase/pending-wave5/20261029120100_sec_has_permission_aal2_member_rls.sql` だけ。**これが効く移行**。

**Files:**

- Create: `supabase/pending-wave5/20261029120100_sec_has_permission_aal2_member_rls.sql`、`tests/unit/migrations/sec-has-permission-aal2.test.ts`、`tests/integration/db/auth_has_permission_aal2.integration.test.ts`（書くだけ）
- Docs: `docs/03_BasicDesign/decisions/ADR-0418-auth-has-permission-requires-aal2-and-bound-session.md`（新規。背景: `has_permission` は ACL だけを見る／決定: P14 の本体・P15 の方針／退けた案: 案 A（6 表だけに RESTRICTIVE。残りの約 100 の方針が開いたまま）・Custom Access Token Hook・方針を表ごとに書き換える（112 か所）／結果・見直す条件）、`docs/03_BasicDesign/areas/auth.md`、`docs/02_Requirements/areas/auth.md`（`SEC-AUTH-010-AC-03`）

**Interfaces（SQL）:**

```sql
-- 直前の本体 = 20261023175712_group_g0_permissions.sql:186-217 をそのまま写し、2 つの検査を足す
CREATE OR REPLACE FUNCTION public.has_permission (permission_code text) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE uid uuid; acl_allowed boolean; claims jsonb;
BEGIN
  uid := auth.uid();
  IF uid IS NULL THEN RETURN false; END IF;
  claims := (SELECT auth.jwt());
  IF COALESCE(claims ->> 'aal', 'aal1') <> 'aal2' THEN RETURN false; END IF;          -- 追加 1（安い検査）
  SELECT EXISTS ( …G-0 の本体と同じ… ) INTO acl_allowed;
  IF NOT COALESCE(acl_allowed, false) THEN RETURN false; END IF;
  RETURN private.app_session_is_live(CASE WHEN claims ->> 'session_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                          THEN (claims ->> 'session_id')::uuid END);  -- 追加 2（ACL が真の時だけ）
END; $function$;
-- 会員の表（P15）
DROP POLICY IF EXISTS "require app bound live session" ON public.profiles;  -- orders・order_items も同じ
CREATE POLICY "require app bound live session" ON public.profiles AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT private.is_app_bound_live_session())) WITH CHECK ((SELECT private.is_app_bound_live_session()));
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P1・P2・P14・P15。`git diff` 相当で G-0 の本体と新しい本体の差が**追加の 2 つだけ**であることを目で確かめる。本番の `pg_policies`（`profiles`・`orders`・`order_items`、`auth.uid()` を使う方針）を再取得して P15 の表と食い違わないことを確かめる（G-4／H が新しい会員の表を足していないか。`grep -n "auth\.uid()" supabase/migrations/2026102[6-9]*.sql`）。
- [ ] **Step 2（RED）: 試験を書く。** 単体 `sec-has-permission-aal2.test.ts`: ファイルが `supabase/{pending-wave5,migrations}` のどちらかに在る、`CREATE OR REPLACE FUNCTION public.has_permission` が 1 つ、`SET search_path = ''`、本体に `'aal2'`・`app_session_is_live`・`user_roles`・`role_permissions`・`permissions` を含む、`aal` の検査が ACL の `SELECT EXISTS` より**前**、`app_session_is_live` が ACL の後、方針 3 本が `AS RESTRICTIVE`・`TO authenticated`・`FOR ALL`・`DROP POLICY IF EXISTS` 付き、`anon` を含まない、ROLLBACK に G-0 の本体の全文と `DROP POLICY` 3 本、`GRANT`／`REVOKE` を `has_permission` に書かない（`CREATE OR REPLACE` は権限を保つ）。DB 結合 `auth_has_permission_aal2.integration.test.ts`（先頭 `SEC-AUTH-010-AC-03`。Task 1 で作った補助 `helpers/app-session.ts`）: 管理者（admin の役割・ACL あり）で ①aal2＋結び付き＋生存 → true、②aal1、③`aal` 無し、④`session_id` 無し、⑤形が悪い、⑥結び付いていない（`auth.sessions` だけ）、⑦失効後（`public.sessions.revoked_at` あり）、⑧`auth.sessions` を消した後、⑨ACL の無い人は①でも false、⑩`has_permission` の EXECUTE（authenticated 可・anon 不可）、⑪**公開の読み方針は一般会員（aal1）で止まらない**（`items` の公開行、`news_articles` の `status = 'published'`）、⑫会員の本人の行（P15 の 3 表）: 結び付いた authenticated は読み書きできる、結び付いていない authenticated は 0 行、**anon の `app.session_id` の注文は今までどおり**、⑬aal1 の会員は `auth.sessions`・`public.sessions` を引く前に false を返す（`EXPLAIN` でなく、`public.sessions` と `auth.sessions` の行が無くても aal1 の呼びが例外を出さず false になること）。
- [ ] **Step 3（GREEN）: 移行を書く。** 上の Interfaces。末尾の自己検査（`SEC_WAVE5_MIGRATION_ASSERTION_FAILED`、`DETAIL` に項目名）: ①`pg_get_functiondef` が `'aal2'`・`app_session_is_live`・`user_roles` を含む、②`proconfig` が `search_path=""`、③`has_function_privilege`（authenticated は真、anon は偽、service_role は真）、④3 表に `polpermissive = false`・`polroles = {authenticated}`・`polcmd = '*'` の方針が各 1 本、⑤`private.app_session_is_live` が M1 で存在する（無ければ「M1 を先に」の符号で止める）、⑥`public.sessions` に `auth_session_id` がある。ヘッダー: ROLLBACK（G-0 の本体の全文＋`DROP POLICY IF EXISTS … ×3`）、本番の事前の読み取り、**適用の境界**（M1 が済み、アプリの書く側・読む側が出て、ログインし直した後に当てる。当てると**その瞬間に既存の全 session が DB で 0 行・has_permission false になる**）、旗では戻せないこと。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/migrations/sec-has-permission-aal2.test.ts`。
- [ ] **Step 5: 文書・報告。** ADR-0418。共有文書の変更案（`db-migrations.md` の節の素案: 表・自己検査・適用の順序・ロールバック・本番の事前の確認。波 2 の節の書式）を報告に。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 7: 既存の DB 結合試験の書き換え（補助 `helpers/app-session.ts` は Task 1 で作った物を使う）

**範囲:** `tests/integration/db` だけ。`group_g*` の全部と、`''` に戻すだけの 11 ファイルは**変えない**（P16 の一覧）。書くだけ（流すのは controller）。

**Files:**

- 使う（作らない）: `tests/integration/db/helpers/app-session.ts`（Task 1 で作成済み。行を作る処理の写しをテスト内に作らない。足りない option があれば、この補助に足す）
- Modify（P16 の 13 ファイル＋補助 1＋補助を使う 4）: `search-functions`（`:154-158`・`:445-449` の `adminClaims = { sub: admin, role: 'authenticated' }` に `aal: 'aal2'`・`session_id` が無く、管理者が `has_permission` の RLS で非公開の行を読むのを `toHaveLength(1)` で確かめている。M2 の後は 0 行。`adminUser()` で作った管理者に `createLiveAppSession(…, { aal: 'aal2' })` を作り、`jwtClaims` で claims を作る）、`admin-misc/admin_item_color_presets_table`・`admin-misc/admin_permission_seed`・`admin-misc/admin_rls_policy`・`home/home_items_grants`・`look_permissions`・`look_rls`・`news_articles_rls`・`news_permissions`・`stockist_permissions`・`stockist_rls`・`role_permissions`・`order_internal_columns`、`helpers/admin-table-grants.ts`、`look_grants_admin_tables`・`news_grants_admin_tables`・`stockist_grants_admin_tables`・`admin-misc/admin_item_color_presets_grants`

**Interfaces:**

```ts
// tests/integration/db/helpers/app-session.ts
/** auth.sessions と public.sessions に、結び付いた生きた session の行を作る（呼ぶ側の begin/rollback の中。auth.users の行が先に要る）。 */
export async function createLiveAppSession(db: PgClient, userId: string, options?: { aal?: 'aal1' | 'aal2'; bind?: boolean; revoked?: boolean }): Promise<{ sessionId: string }>;
/** PostgREST が入れる JWT の claims（role authenticated・aal・session_id）。set_config('request.jwt.claims') に渡す */
export function jwtClaims(userId: string, session: { sessionId: string }, aal?: 'aal1' | 'aal2'): Record<string, unknown>;
```

- [ ] **Step 1: 実測の表を作る**（読むだけ。流さない）。P16 の「変わらない」`''` に戻すだけの 11 ファイルと、claims を set する 35 ファイルのうち書き換え対象でない物が本当に変わらないかを、次の 3 種類の見方で確かめ、表にする。①文字の grep: `grep -n "has_permission\|from public.orders\|from public.profiles\|public\.sessions" <file>`。②**`has_permission` の文字が無くても RLS の方針経由で効く**物を拾う grep（`search-functions` がこの形で、①だけでは落とした）: `grep -nE "request\.jwt\.claim|adminUser\(|assignRole|insert into public\.user_roles|from public\.(news_articles|look|stockist|items|admin_|home_)|public\.\$\{" <file>`。③**claims の `sub` が「役割・権限を持つ利用者」か**。`randomUUID()` の拒否専用の `sub` だけを探さず、`adminUser()`・`assignRole`・`user_roles` の insert・`auth.users` の `app_metadata.role` で ACL を持たせた利用者の id を claims の `sub` に入れ、`authenticated` で RLS 越しに読み書きして**行が見えることを期待する**箇所を全部拾う（期待が `toHaveLength(1)`・`rowCount > 0`・成功、の物。M2 の後は aal2 と結び付いた生きた session が無いと 0 行／拒否になる）。変わると分かった物はこのタスクの対象に足す。表には「ファイル・行・claims の `sub` の出どころ・期待（行が見える／拒否）・変更の要否」を持たせる。
- [ ] **Step 2: 補助は Task 1 で作成済み。** `tests/integration/db/helpers/app-session.ts` の `createLiveAppSession`・`jwtClaims` を読んで使い方を確かめる（署名は Task 1 の Interfaces）。足りない option（たとえば `notAfter`）があれば、この補助に足す。テスト内に行を作る処理を書かない。
- [ ] **Step 3: 既存の試験を直す。** 各ファイルの `enter()`／`attempt()`／`claims` を組み立てる所に、`createLiveAppSession` で作った `sessionId` を入れた claims（`aal` は元の `aal2` を保つ。`aal1` を試す箇所はそのまま `aal1`）に替える。**拒否を確かめる箇所（結び付いていない）は意図して残す**。`role_permissions.integration.test.ts:381,402` は `request.jwt.claim.sub` だけを入れているので、`request.jwt.claims` に `{ sub, role, aal: 'aal2', session_id }` を入れる形に替える（`auth.jwt()` が空だと `aal` が無く false になる）。`order_internal_columns.integration.test.ts:163` は会員の claims に `session_id` を入れ、結び付いた行を作る。`helpers/admin-table-grants.ts` は `claims` をそのまま通すので変更不要か、`session_id` を持つ claims を作る小さな関数を足すだけ。
- [ ] **Step 4: 対象の `jest`（作成だけ）。** `npx tsc --noEmit`（DB 結合は流さない）。`npx jest tests/unit/migrations` は流してよい。
- [ ] **Step 5: 報告。** 直したファイルの表、変えなかった理由、controller が流す DB 結合の候補（`npx jest tests/integration/db --runInBand` を `DATABASE_URL` 付きで。`db reset` の後）。

**検証コマンド:** `npx tsc --noEmit`。

---

## Task 8: DB 側の E2E の反転（9 か所のうち 8 か所）

**範囲:** M2 が入って初めて赤が外れる印。書くだけ。**「aal1 の管理者の通行証」は結び付けて作る**（`createAdminSessionActor(db, role, 'aal1')` の既定。拒否の理由が「結び付いていない」でなく「aal1」であることを試験が示す。P17 (A)）。

**Files:**

- Modify: `e2e/FR-LOGIN-031-supabase-direct-bypass.spec.ts`（`:259` SEC-AUTH-005-AC-02、`:283` SEC-AUTH-010-AC-01 の `test.fail` を外す。**`SEC-AUTH-005-AC-03` の PostgREST 側**（OTP だけの通行証で `profiles`・`orders` が 0 行）を Task 5 の試験に足す。aal1 の**結び付いた**管理者で `orders` が読めない対照を足す）、`e2e/FR-ADMIN-MISC-005-item-color-presets-and-direct-db-access.spec.ts:219`（SEC-ADMIN-002-AC-02）、`e2e/FR-HOME-024-home-table-grants.spec.ts:98`（SEC-HOME-003-AC-01）、`e2e/FR-LOOK-SEC-002-postgrest-policies.spec.ts:270`（SEC-LOOK-003-AC-01）、`e2e/FR-NEWS-SEC-002-direct-db-access.spec.ts:264,364`（SEC-NEWS-002-AC-01・AC-03）、`e2e/FR-STOCKIST-016-direct-db-access-and-session.spec.ts:225`（SEC-STOCKIST-003-AC-01）
- Docs: 各領域の `docs/02_Requirements/areas/{auth,admin,look,news,stockist,home}.md`（「今のコードは満たさない」を外し、「DB でも aal2 と結び付いた生きた session を求める」を満たす、と書く）、`docs/05_Quality/security/threats/{同}.md`、`docs/03_BasicDesign/areas/{同}.md`（データ節に `has_permission` の新しい契約）

- [ ] **Step 1: 現状の確認（読むだけ）。** 各 `test.fail` の本体を読み、対照（「aal2 では読める」「JWT 自体は通る」）が結び付いた通行証で組まれていることを確かめる。`FR-NEWS-SEC-002:364`（ログアウトの後）は `/auth/v1/logout` が `auth.sessions` を消すので、結び付きの有無に関わらず false になるが、**ログアウトの前に「読める」対照**が `newActor('aal2')`（結び付き）で成り立つことを確かめる。
- [ ] **Step 2: 外す。** 8 つの印（`FR-LOGIN-031:259,283`・`FR-ADMIN-MISC-005:219`・`FR-HOME-024:98`・`FR-LOOK-SEC-002:270`・`FR-NEWS-SEC-002:264,364`・`FR-STOCKIST-016:225` の 8 か所。表の「外すタスク」と数が合うこと）。冒頭の「波 5 まで赤の見込み」の注を直す。`FR-STOCKIST-016` の冒頭の「003-AC-01 は波 5 まで赤の見込みで serial にしない」の注も直す。
- [ ] **Step 3: 報告。** 外した行の一覧、controller が最後に流す E2E の候補: `e2e/FR-LOGIN-031 e2e/FR-ADMIN-MISC-005 e2e/FR-HOME-024 e2e/FR-LOOK-SEC-002 e2e/FR-NEWS-SEC-002 e2e/FR-STOCKIST-016 e2e/FR-ADMIN-123`。

**検証コマンド:** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace`。

---

## Task 9: 文書（要件・脅威・設計・ADR・DD・注の訂正）

**範囲:** 領域の文書と注。コードは変えない（`amr.ts` の注だけ）。

**Files:** `docs/02_Requirements/areas/{auth,admin,look,news,stockist,home}.md`、`docs/05_Quality/security/threats/{同}.md`、`docs/03_BasicDesign/areas/{同}.md`、`docs/03_BasicDesign/decisions/ADR-0417・0418・0419` の最終版と、更新する既存 ADR（`ADR-0414`〜）の状態、`docs/04_DetailDesign/pages/14_login.md`（`DD-AUTH-039` の完成）、`src/lib/auth/amr.ts` の注（Task 0 の `amr` の実測で書き直す）、`docs/02_Requirements/areas/auth.md` の末尾の「判断待ち」（`:5423,5430`）、`scripts/trace/scope.json`

- [ ] **Step 1: 要件。** `SEC-AUTH-005`（本文を「アプリを通らない通行証」の言い方に直す。**会員の 2 段はアプリ独自の方針で NIST AAL2 でない**。AC-01〜05）、`SEC-AUTH-010`（AC-03）、`SEC-AUTH-030`（AC-02）、`SEC-AUTH-031`（AC-02）、`SEC-ADMIN-002`・`SEC-LOOK-003`・`SEC-NEWS-002`・`SEC-STOCKIST-003`・`SEC-HOME-003`（DB でも満たす、に直す）。「E2E ファイルと受け入れ条件の対応表」を更新。
- [ ] **Step 2: 設計。** 領域別 `docs/03_BasicDesign/areas/auth.md`: 認証の流れの表（このファイルの「認証の流れと、旗・結び付きの読み方」）、データ節（列・索引・関数・`has_permission`・方針 3 本）、旗 `AUTH_REQUIRE_APP_SESSION`。`14_login.md`: `DD-AUTH-039` の処理の流れ（書く側・読む側・refresh の引き継ぎと洗濯の防止）。
- [ ] **Step 3: 脅威。** `docs/05_Quality/security/threats/auth.md` に「アプリを通らない通行証（password／OTP／任意の session）」「洗濯（refresh）」「DB の直叩き」を対策つきで。残る危険: パスワードとメールの受信箱の**両方**を盗まれる（正規の 2 段を踏める）。管理者は TOTP が上乗せ。
- [ ] **Step 4: 確かめ。** `npm run validate-docs`、`npm run validate-trace -- AUTH`・`-- ADMIN`・`-- LOOK`・`-- NEWS`・`-- STOCKIST`・`-- HOME`（範囲内の領域）。共有文書の変更案をまとめる: `requirements.md`（AC の文が変わる物）、`test-spec.md`（足した・書き換えた試験）、作業と指摘の台帳（W-08・波 5 の状態、解決した指摘 ID）、`db-migrations.md`（M1・M2 の節）、`screen-*` は無し。

**検証コマンド:** `npm run validate-docs`、`npm run validate-trace`。

---

## Task 10: 最終確認と controller への報告（controller が行う）

**範囲:** 合意した窓の中で、移行を動かして試験を流す。コードは変えない。

- [ ] **Step 0: 窓の合意。** G-1／H に「`has_permission` の契約が変わる（aal2＋結び付いた生きた session）。H の新しい方針・DB 試験の claims に `createLiveAppSession` が要る。会員の行を返す新しい表は `profiles`・`orders`・`order_items` と同じ RESTRICTIVE が要る」と知らせ、`supabase/migrations` の置き換え・`db reset`・DB 結合・E2E の窓（波 2 は約 90 分）を取る。`scripts/e2e/environment.ts` の了承（Task 4）。
- [ ] **Step 1: 木の確認。** `npx tsc --noEmit`、非 DB の `jest`（全体 1 回。落ち 0。他者の落ちは別に記録）、`npm run validate-docs`（既知の 2 件のリンク切れ以外が増えていないこと）、`npm run validate-trace`（増えた違反が 0）、`npm run test:trace-coverage`（増やさない）、`npm run trace:report`。
- [ ] **Step 2: M2 を動かす。** **M1 は Task 1B で動かして当て済み**（`supabase/pending-wave5/` には M2 だけが残っている。M1 が `supabase/migrations/` に無い・本番に未適用なら、ここで止めて Task 1B に戻る）。`ls supabase/migrations | tail -3` で最後の時刻を見て、M2 の時刻が**M1 と全部の既存の移行より後**であることを確かめ（付け直すなら M2 のファイル名・ヘッダー・試験の参照・ADR・文書を一貫させる）、`git mv` ではなく**ファイルを移して** `supabase/pending-wave5/` を消す。`security-definer-search-path-guard.test.ts` と `sec-*.test.ts` を流す。`npm run db:reset` が通り、末尾の自己検査（`SEC_WAVE5_MIGRATION_ASSERTION_FAILED` が出ない）。
- [ ] **Step 3: DB 結合。** `DATABASE_URL=… npx jest tests/integration/db --runInBand`。**`tests/integration/db/group_g*` の全部（今 54 ファイル。P16 の一覧）が一字も変えずに通る**（Review Focus 5）。`git diff --stat -- 'tests/integration/db/group_g*'` が空であることも確かめる。「16 ファイル」という数は使わない。`auth_app_session_binding`・`auth_sessions_table`・`auth_has_permission_aal2`・Task 7 の 18 ファイル（13＋補助 1＋補助を使う 4）・`group_g2_public_function_acl`・`group_g2_migration_asserts`・`security_definer_search_path`・`auth_grants_inventory` が通る。波 2 は 4339 件通過・0 失敗。
- [ ] **Step 4: E2E。** 3000 番の残りを止め、`db reset` の後で（memory: DB 結合の直後の E2E は決済が全部落ちる）。まず対象: `npx playwright test e2e/FR-LOGIN-031 e2e/FR-LOGIN-030 e2e/FR-LOGIN-032 e2e/FR-LOGIN-038 e2e/FR-ACCOUNT-009 e2e/FR-ACCOUNT-010 e2e/FR-ADMIN-MISC e2e/FR-HOME-024 e2e/FR-LOOK-SEC e2e/FR-NEWS-SEC e2e/FR-STOCKIST e2e/FR-ADMIN-123 e2e/FR-SEARCH-020 e2e/FR-PRIVACY-007`。次に全件を流して `e2e-results-wave4-full.json`（185 failed）と比べる（`flattenPlaywrightJson` で直して渡す）。`E2E_FIXED_ENV` が変わるので古い 3000 番のアプリは使い回されない。**新しい赤の見立て**: ①401（結び付けの付け忘れ。Review Focus 8。`grep -rnE "grant_type=password|signInWithPassword" e2e` の分類を再確認）、②0 行・`42501`（`app_session_is_live` が false。`auth.sessions` の行が無い・`user_id` 不一致）、③refresh が 401（Task 0 の不変が成り立たない／引き継ぎの漏れ）、④`networkidle` が止まる（新しい `no-store` は足していない）、⑤G／H の E2E の通行証（`order-status-test-utils` など）が管理者の password grant を直に使っている。
- [ ] **Step 5: 印の棚卸し。** `grep -rnE "test\.fail" e2e | grep -E "SEC-(AUTH-005|AUTH-010|ADMIN-002|LOOK-003|NEWS-002|STOCKIST-003|HOME-003)"` が 0 件。外した 9 か所（`FR-LOGIN-031:235,259,283`・`FR-ADMIN-MISC-005:219`・`FR-HOME-024:98`・`FR-LOOK-SEC-002:270`・`FR-NEWS-SEC-002:264,364`・`FR-STOCKIST-016:225`）と数が合うこと。`FR-LOGIN-032:402,488`（ENV）は**残る**。
- [ ] **Step 6: 共有文書の反映。** `db-migrations.md`（M1・M2 の節。波 2 の書式: 表・本番の事前の確認・適用の順序・ロールバック・自己検査。**M1 は Task 1B で先に当てた**ので、節に当てた日と順序の例外（M1 が M2 とアプリの前に単独で入った理由）を書く。関数は `CREATE OR REPLACE`、GRANT の一覧（`auth_grants_inventory`）に `is_app_session_active` を足した、と書く）、作業と指摘の台帳（W-08・波 5）、`requirements.md`・`test-spec.md`（Task 9 の変更案）。
- [ ] **Step 7: コミット。** 種類ごとに分ける（src／試験／E2E と scripts／文書／移行。pre-commit の lint のコマンドの長さの上限）。`git add` の後で `git status` に他者のファイルが混ざっていないことを確かめる。G-1 に「入れた」と知らせる。
- [ ] **Step 8: 報告。** 下の「本番の適用」「本番の前の確認」「ruling」「回す物」を、結果と共に返す。

### 本番の適用（G-1 の次の `db push --linked` と一緒に。順序が命）

本番のアプリは未デプロイで、会員はほぼいない（`auth.users` 8 人・失効していない自前の session 3 本）。開店前が一番安い。**M1 は Task 1B で、Task 2 の前に本番へ当て済み**（オーナーの許可つき。普段の開発が本番の DB につながるので、書く側のコードが入る前に列が要る）。ここでは M2 だけを G-1 の次の `db push --linked` と一緒に当てる。**順序**: ①適用前に `get_advisors`（security）を保存し、`select md5(pg_get_functiondef('public.has_permission(text)'::regprocedure))` が `418b949c1ec79dfa89ea6454bf81f66a` の定義であることと、`schema_migrations` の最後が G-1 の最新であることを読む。②**M1 が当たっていることを確かめる**（Task 1B で当て済み。追加だけで挙動は変わらない。無ければ先に当てる）。③アプリの書く側・読む側を配備（本番のアプリが無い間は、開発者の手元のコードがその役。Task 2・3 の窓で済んでいる）。旗は設定しない（既定で有効）。段階が要る時は先に `AUTH_REQUIRE_APP_SESSION=off` で配備し、会員が再ログインして行ができたのを `select count(*) from public.sessions where auth_session_id is not null and revoked_at is null` で確かめてから外す。④**ログインし直す**（開発者・試し用の 4 人・管理者。管理者は TOTP の再登録は不要で、メール OTP → TOTP の通常の流れ）。⑤**M2 を当てる**。⑥事後: 当てた文を `schema_migrations` の `md5(statements[1])` でファイルと突き合わせる、`has_permission` の定義に `aal2` と `app_session_is_live`、`pg_policies` に方針 3 本、`get_advisors` の security に増えた WARN が無い、未ログインの anon・パスワードだけの通行証の `profiles` が 0 行。戻すのは各ファイルのヘッダーの ROLLBACK（M2 → M1 の順）と、アプリは旗 `off`。

### 本番の前の確認（コードでは確かめられない）

1. 本物の TOTP の `mfa.verify`（ローカルは TOTP が無効）の前後で `session_id` が変わらないこと。配備前の preview で管理者 1 人が TOTP を通し、`mfa/verify` の応答の access token の `session_id` が直前と同じか、自前の `sessions` の行が引き継がれたかを読む（Task 0 は補助の amr で代用した）。
2. Google ログイン（`oauth/callback`）の session が結び付くこと（`persistSessionAndCookies` を通る。単体で確かめるが、本物の Google は preview）。
3. 本番の GoTrue の `auth.sessions` の `not_after`（time-box）の設定。`app_session_is_live` は `auth.sessions` の生存も見るので、設定が短いと再ログインが増える。
4. `auth.sessions` の主キー引きの性能。`has_permission` が方針の中で行ごとに呼ばれても、aal1 は表を引かずに false、aal2 の管理者だけが 2 回の主キー引き。`get_advisors`（performance）と、管理画面の一覧（注文・会計）の応答時間を適用の前後で比べる。重いと分かったら Custom Access Token Hook を上乗せする（決定文）。

### ruling（controller への確認。実装者は広げず、理由を書いて進める）

1. **旗 `AUTH_REQUIRE_APP_SESSION` の既定は「有効」**（P12）。決定文は「環境変数の旗で段階的に有効化」で、既定を無効とも読める。既定を有効にする理由: 設定し忘れで穴が開いたままにならない、本番は未デプロイ、手元と E2E で実際の道を通す。段階が要る時は `off` を明示する。無効を既定にする案なら、`isAppSessionRequired` の判定を反転し、E2E の固定の環境と本番の設定に `on` を入れる（1 行）。
2. **索引は一意にしない**（P6）。`persistNewSession` が insert を先、revoke を後にするため、一意だと更新・昇格の insert が落ちる。順番を逆にする案は、insert が落ちた時に旧行を失うので採らない。
3. **DB 側（M2）に旗を置かない**。DB は環境変数を読めない。設定表を置く案は、旗の改ざんの面が増える。戻すのは M2 の ROLLBACK（G-0 の本体＋`DROP POLICY`）。
4. **refresh の強制は旗が有効な時だけ、前の行が結び付いていない refresh token を断つ**（P10）。`refresh/route.ts:43-52` の「取りこぼしで正当な利用者を締め出さない」を、結び付けの強制に限って変える。理由: 断たないと refresh で洗える。副作用: 行の書き込みに失敗して refresh token と行の hash がずれた利用者は再ログインになる（今は GoTrue が通していた）。
5. **生存の判定に `sessions.expires_at` を使わない**（P7）。書き手で意味が違う（access token の期限と 7 日）。`persistSessionAndCookies` の `expires_at` を 7 日に揃える案は、列の意味を揃える別件として回す。
6. **`enroll-totp` の `hasSecondFactorAmr` は残す**（P18）。結び付きで OTP だけの道は塞がるが、二重の守りとして外さない。断りの監査は `claims` つきの `revoked` で書く。
7. **会員の RESTRICTIVE は `profiles`・`orders`・`order_items` の 3 表**（P15。本番の `pg_policies` で確定）。`carts`・`wishlists`・`checkout_drafts`・`contact_*` は既に全拒否。新しい会員の表が出たら同じ方針が要る（G-4／H に知らせる）。
8. **会員の 2 段は NIST の AAL2 ではなくアプリ独自の方針**と要件・ADR に書く（3.1.3.1: メールは out-of-band に使えない）。管理者の TOTP が AAL2。
9. **`scripts/e2e/environment.ts` の固定の環境に `AUTH_REQUIRE_APP_SESSION: 'on'` を入れる**（Task 4。G-1 の了承が要る）。入れない案: 手元の `.env.local` の `off` で E2E が偽の緑になりうる。
10. **移行の時刻は暫定**（P21）。動かす時に最後の既存の移行より後に付け直す。M1 は Task 1B で単独で先に当てる（ruling 12）。M2 は G-1 の次の `db push --linked` と一緒（順序は「本番の適用」）。
11. **ローカルで本物の TOTP を流せない**（P8）。`mfa/verify` の引き継ぎは単体＋E2E の補助（amr の行＋ `/api/auth/refresh`）で確かめ、本物は preview（本番の前の確認 1）。
12. **M1 を Task 1 の直後（Task 2 の前）に `supabase/migrations/` へ動かし、手元と本番に当てる。Task 3 と Task 4 は G-1／H と合意した 1 つの窓で続けて入れる。** 理由: 作業ツリーは共有で、コードは入った瞬間から G-4／H の手元の DB（`supabase/migrations` から作る）と、本番の DB につながる普段の開発に効く。Task 2 の書く側は旗に関係なく常に `auth_session_id` を insert するので、列が無いと `persistSessionAndCookies`（`register.ts:104-119`）が `ok:false` を返し、`otp/verify:108-115` が OTP・Google・確認のリンクのログインを全部落とす。Task 3 は旗が既定で有効なので `public.is_app_session_active` が無いと全要求が 503（`authenticate.ts:139-144`）、あっても `auth_session_id` を持たない既存の session と、Task 4 の前の E2E の通行証が全部 401 になる。M1 は追加だけで挙動が変わらない（`has_permission` も方針も触らない）ので先に入れても害が無い。代償: M1 の本番適用が「M2 と一緒」から前倒しになる（オーナーの許可が要る）ことと、G-1／H に Task 3＋4 の窓で全員が再ログインになることを知らせる手間。M2 は従来どおり Task 10 まで `pending-wave5/` に置く。代案（M1 を `pending-wave5/` に置いたまま、書く側が列の無い時に insert を諦めてログインを通す）は、書く側が「常に書く」で結び付きの強制を担保する設計（P12）を弱めるので採らない。
13. **`auth_sessions_table` と `search-functions` は P16 の「変わらない」ではなく書き換え対象**。前者は `public.sessions` の列の集合を `toEqual` で固定している（M1 の新しい列で落ちる。Task 1 で直す）。後者は claims に `aal`・`session_id` が無い管理者が `has_permission` 経由で RLS を通る（M2 の後は 0 行。Task 7 で直す）。`auth_grants_inventory` には `public.is_app_session_active` だけ足し、`private` の 2 関数は足さない（Task 1 の理由）。

## 回す物（この波で直さない。理由つき）

- **`/api/auth/login` が捨てた password の session が GoTrue に残る**（P19）。結び付かないので無害。`signOut({ scope: 'local' })` で消す後始末は別件（`confirm/route.ts:51-64` の `revokeLocalSession` が同じ形の前例）。
- **`persistSessionAndCookies` の `expires_at` が access token の期限**（P5）。意味を 7 日に揃える整理は別件。
- **Custom Access Token Hook**（案 (c)）。RLS の検索が重いと実測で分かった時の上乗せ（決定）。
- **メールの provider を切って direct grant を止める案・公開 `/auth/v1/*` を塞ぐ案**。調べた範囲では設定が見つからず、塞げない前提でサーバー側の受け入れ条件で守る（調査）。
- **会員の Google ログインの 2 段目の扱いの再検討**（Q3 は「2 段目済みとする」。変えない）。
- **`public.sessions` の掃除（古い行の削除・保存期間）**。法令対応の後回し（memory）。
- **`FR-LOOK-SEC-004:299`（画像の量）**・波 4 の範囲外の印。
