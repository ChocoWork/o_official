# 波 6 設定・運用の守り（captcha・パスワード変更・手元と本番の Supabase 設定・許可オリジン）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 守りの穴の設計（`design-final.md` R17・§6）の波 6 を直す。(1) **captcha（案 b'）**: Supabase の captcha（Turnstile）をオンにする。アプリのサーバーが GoTrue の「captcha が掛かる窓口」（`/signup`・`/token`（password）・`/otp`・`/recover`・`/resend`・`/magiclink`）を呼ぶ 4 か所（ログイン 2 回・ログイン再送・会員登録）は service role の鍵で呼び、GoTrue の管理者免除で通す。アプリ側の Turnstile の検証・順番・枠はそのまま。アプリを通らない（anon の鍵で直に叩く）呼び出しは、トークン無しなら 400 になる。(2) **パスワード変更**: ログイン中の会員が自分でパスワードを変える窓口と画面を作る（現行パスワード＋新パスワード 16 文字以上＋アプリが送るメールの 8 桁のコード）。変更後はこの端末を含む全 session を失効し、通知のメール、本人ごと 10 分 5 回、監査。(3) **手元の `supabase/config.toml` を本番の前提にそろえる**（確認メール必須・OTP 300 秒・TOTP 有効・最小長 16・`secure_password_change`・変更通知・captcha）。(4) **`APP_ALLOWED_ORIGINS`** が無い本番のビルドを落とす。(5) **本番の Supabase Auth の設定**を Management API で読んで控え、同じ前提に変える（controller の最後の作業。戻し方つき。3 回試して無理なら手順を文書に残す）。

**Architecture:** 4 層で進める。**(a) 測る**: Task 0（controller）が、G-1／H の手元の Supabase を止めない**隔離した別の Supabase**（別の project_id・別のポート）で、目標の設定の GoTrue に対し「anon はトークン無しで 400／service role はトークン無しで通る／`sb_secret_` も通る」ほかを実測する。1 つでも崩れたら止めて controller に戻す。**(b) アプリ**: captcha を免除される窓口を呼ぶ専用の「auth だけを持つ」クライアント（Task 2）→ E2E・DB 結合の補助にダミーの `captcha_token` を足す（Task 3。captcha が切れていても害が無いので先に入れてよい）→ パスワード変更の移行 M3（Task 4。`supabase/pending-wave6/`）→ サーバー（Task 5）→ 画面（Task 6）→ E2E と要件（Task 7）。**(c) 設定の切り替え**: `config.toml` の目標の版を `supabase/pending-wave6/config.toml` に作り（Task 8）、E2E の `test.fail` の印の外しと要件の書き換えを同じ変更で用意する。**手元の Supabase の再起動が要るので、動かすのは controller（Task 10）**。**(d) 本番**: Task 11（controller）が M3 の適用、Management API による読み・段階 A（captcha 以外）・段階 B（captcha）・確かめ・戻し、台帳。Task 9 は運用の文書。`APP_ALLOWED_ORIGINS`（Task 1）は独立で、最初に入れる。

**Tech Stack:** Next.js `^16.3.6`（Route Handler・Server Component／Client Component）、TypeScript、`@supabase/supabase-js` 2.103.3、Supabase CLI 2.116.0、GoTrue（captcha・`secure_password_change`・管理 API）、Jest（単体・結合）、Playwright（書くだけ。流すのは controller）、Resend（`sendMail`）。依存は増やさない。

**Spec:** [`.superpowers/sdd/2026-10-25-security-gap-fixes/wave6-decisions.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/wave6-decisions.md)（**この文書が拘束する**。2026-11-01 のユーザーの答え: Q28 は案 (b')・パスワード変更は提案どおり・本番の設定は「できる限り変える。3 回試して無理なら手順を残す」・`APP_ALLOWED_ORIGINS` は本番のビルドを止める）、調査 [`wave6-research.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/wave6-research.md)（GoTrue のソース読みと一次資料の引用）。背景: 同ディレクトリの [`design-final.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md) の R17（`:518-532`）・§6（`:743,751`）・波 6 の行（`:572`）、`AUTH.md` の SEC-AUTH-015・016・029。前の波の計画（書式の見本）: [`2026-10-29-wave5-session-binding-aal2-db.md`](./2026-10-29-wave5-session-binding-aal2-db.md)。

---

## 概要

| 項目 | 内容 |
| --- | --- |
| 作成日 | 2026-11-01。コード・DB・設定・テストは 1 行も変えていない（この計画の作成だけ。読んだのは `src/`・`tests/`・`e2e/`・`supabase/`・`docs/`・Supabase CLI の実行ファイルの文字列・Management API の公式 OpenAPI（`https://api.supabase.com/api/v1-json`）。別セッション H が 5 時間の E2E で手元の DB と 3000 番を使っているので、DB・サーバー・E2E・Supabase の再起動には触っていない） |
| 直す項目 | R17（SEC-AUTH-015 の AC-01・AC-02・captcha、SEC-AUTH-016-AC-01・FREQ-320-AC-03・SEC-AUTH-029 の AC-01・AC-02、FREQ-316-REQ-02-AC-01、SEC-AUTH-030-AC-01 の ENV の印）、SEC-LOOK-018 の本番の設定（`APP_ALLOWED_ORIGINS`）、本番の Supabase の設定（漏洩パスワードの確認・IP の枠・`max_rows`）。ASVS 4.0.3 V2.1.5・V2.1.6・V2.2.3・V3.3.3 のパスワード変更の部分 |
| タスク | 12 つ（許可オリジン Task 1・auth だけのクライアントと 4 か所の切り替え Task 2・補助のダミー captcha Task 3・移行 M3 Task 4・パスワード変更のサーバー Task 5・画面 Task 6・E2E と要件 Task 7・手元の設定の用意 Task 8・運用の文書 Task 9・**手元の切り替え Task 10（controller）**・**本番 Task 11（controller）**・**測る Task 0（controller）**）。**実行の順は Task 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11**（Task 1 は Task 0 と並べてよい） |
| 新しいコード | `src/lib/auth/service-role-auth-client.ts`、`src/features/auth/services/password-change.ts`、`src/features/auth/schemas/password-change.ts`、`src/app/api/auth/password/change/{start,confirm}/route.ts`、`src/app/account/password/{page.tsx,PasswordChangeForm.tsx}`、`supabase/pending-wave6/20261101120000_sec_password_change_challenges.sql`、`supabase/pending-wave6/config.toml`、`supabase/templates/password_changed_notification.html`、`supabase/.env.example`、`e2e/captcha-test-utils.ts`、`e2e/FR-ACCOUNT-046-password-change.spec.ts`、`docs/06_Operations/supabase-auth-config.md` |
| 新しい ADR | `ADR-0420`（AUTH・Supabase の captcha を有効にし、アプリのサーバーの認証の呼び出しは管理者資格で行う）、`ADR-0421`（AUTH・パスワード変更はアプリの窓口で、現行パスワード＋アプリが送るコード＋全 session 失効）。番号は書く直前に `ls docs/03_BasicDesign/decisions \| grep ADR-04` で再確認する（AUTH の帯の今の最大 `0419`。`scope.json` の AUTH の ADR の型は `ADR-04[0-4]*.md`） |
| 外す／直す `test.fail` | 現在の行番号で 9 か所（下の表）。**手元の設定を切り替える Task 10 と同じコミット**で外す（先に外すと赤になる）。**生きている `e2e/` には Task 10 まで書かない**: 他のセッション（H）の E2E の全件実行と pre-push は共有の作業ツリーの `e2e/` を流すので、外した版・書き換えた版・`FR-ACCOUNT-046` が先に入ると H の実行が赤になる。印の外し・AC の書き換え・注の直しは**パッチ**（`supabase/pending-wave6/e2e-wave6.patch`）に、新しい spec は `supabase/pending-wave6/e2e/FR-ACCOUNT-046-password-change.spec.ts.pending` に用意し、Task 10 Step 2 で当てる／移す |
| 触らない共有文書 | `requirements.md`・`test-spec.md`・作業と指摘の台帳・`api-spec.md`・`route-inventory.md`・`er.md`・`screen-list.md`・`screen-flow.md`・`docs/06_Operations/README.md`（H が編集中）・`docs/06_Operations/db-migrations.md`・`tests/unit/docs/*-traceability.test.ts`。controller が Task 10・11 で書く。必要な変更は各タスクの報告の「共有文書の変更案」に書く |
| 流さないもの | E2E・サーバー・3000 番・DB 結合試験・`db reset`・`supabase start/stop`・全体の `jest`・`trace:report`・`test:trace-coverage`・`validate-trace --update-baseline`・`next build`・本番の変更。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。**`supabase config push` は絶対に流さない**（手元の `config.toml` の全体を本番へ押し出し、`site_url` や captcha の秘密などを上書きする。Task 11 は Management API の PATCH で項目を指定する）。**実装者に対する決まり**。controller の手順（Task 0・10・11）だけが、合意した窓とオーナーの許可のもとで行う |
| 本番 | 本番の事実: project ref `pjidrgofvaglnuuznnyj`（`supabase/.temp/project-ref`）。`.env.local` の `NEXT_PUBLIC_SUPABASE_URL` は本番を指し、`SUPABASE_SERVICE_ROLE_KEY` は新方式の `sb_secret_...`、anon は `sb_publishable_...`。**普段の開発（`npm run dev`）は本番の Supabase につながる**ので、本番の captcha をオンにすると、アプリのコードが service role で呼ぶ版に変わっていない開発のログインが止まる。本番のアプリは未デプロイ（Vercel にプロジェクト無し）。本番の Turnstile の秘密の値（Cloudflare のウィジェット）は、まだリポジトリにも `.env.local` にも無い（`.env.local` は常に通るテスト用の値）。本番の Auth の設定の現在値は未読（Task 11 が読む） |

### 設計書の印と今の印（確かめた結果）

`grep -rnE "test\.fail" e2e` で現在の行を確かめた（設計書の `FR-LOGIN-024:104`・`FR-SIGNUP-002:181,245`・`FR-SIGNUP-003:256`・`FR-LOGIN-034:281`・`FR-LOGIN-032:488`・`FR-LOGIN-031:397,428` は動いた）。

| 設計書 | 今 | 要件 ID | 手元のどの設定で外れるか | 扱い |
| --- | --- | --- | --- | --- |
| `FR-LOGIN-024:104` | `FR-LOGIN-024:104`（試験名は `FREQ-320-AC-03`。SEC-AUTH-016-AC-01 ではない。`auth.md:3169`） | FREQ-320-AC-03 | `enable_confirmations = true`（応答が 202 に揃う） | 印を外す。ファイル冒頭の `:13` の注（201 になる）も直す |
| `FR-SIGNUP-002:181,245` | `FR-SIGNUP-002:184`（SEC-AUTH-016-AC-01）・`:246`（SEC-AUTH-029-AC-01） | 同左 | `enable_confirmations = true` | 印を外す。`:157` の「201 でも 202 でもよい」の注を 202 に直す |
| `FR-SIGNUP-003:256` | `FR-SIGNUP-003:262`（FR-LOGIN-004-AC-01） | FR-LOGIN-004-AC-01 | `enable_confirmations = true`（`mailer_autoconfirm` が false） | 印を外す |
| `FR-LOGIN-034:281` | `FR-LOGIN-034:281`（SEC-AUTH-029-AC-02） | SEC-AUTH-029-AC-02 | `otp_expiry = 300` | 印を外す |
| `FR-LOGIN-032:402,488` | `FR-LOGIN-032:402`（SEC-AUTH-030-AC-01）・`:488`（FREQ-316-REQ-02-AC-01） | 同左 | `[auth.mfa.totp] enroll_enabled・verify_enabled = true` | 印を外す。冒頭 `:10` の注と `stockist-admin-test-utils.ts:8` の注を直す（amr の補助は残す） |
| `FR-LOGIN-031:397` | `FR-LOGIN-031:601`（SEC-AUTH-015-AC-01） | SEC-AUTH-015-AC-01 | `minimum_password_length = 16`＋captcha | 試験を**書き換える**（ダミートークン付き＋15 文字→弱いパスワードの誤り）。印を外す。トークン無しは新しい AC-04 |
| `FR-LOGIN-031:428` | `FR-LOGIN-031:632`（SEC-AUTH-015-AC-02） | SEC-AUTH-015-AC-02 | `secure_password_change = true` | 試験を**書き換える**（Task 8 Step 4。古い session は nonce 無しで 400／現行パスワード無しは 400） |

## 前提の読み（読んで確かめた事実と、解釈。controller の確認を求める点を含む）

実装者はこの節を変えない。食い違いに気付いたら止めて報告する。

| # | 読み | 根拠・影響 |
| --- | --- | --- |
| P1 | **captcha が掛かる窓口へのアプリの呼び出しは 4 か所だけ**。ログイン 1 段目 `signInWithPassword`（`src/app/api/auth/login/route.ts:52`）と `signInWithOtp`（`:60`）、ログイン再送 `signInWithOtp`（`src/app/api/auth/login/resend/route.ts:59`）、会員登録 `signUp`（`src/app/api/auth/register/route.ts:140`。`:139` が Cookie 付きの `createClient()`）。`grep -rnE "auth\.signUp\|signInWithPassword\|signInWithOtp\|resetPasswordForEmail\|auth\.resend\|signInWithOAuth\|signInAnonymously\|reauthenticate\|updateUser\(" src` で `src` 全体を洗った（G／H のコードに無い）。`resetPasswordForEmail`・`resend`・`magiclink` は使っていない（再設定は自前の `password_reset_tokens`＋`sendMail`） | 切り替えは 4 か所。ほかの `src` の呼び出しは captcha が掛からない窓口 |
| P2 | **captcha が掛からない呼び出し**（GoTrue のソース `api.go`・`middleware.go` の読み。調査 §1-4）: `verifyOtp`（`otp/verify/route.ts:78`・`confirm/route.ts:96` ＝ `/verify`）、`exchangeCodeForSession`（`oauth/callback/route.ts:113` ＝ `/token?grant_type=pkce`）、`refresh`（`refresh/route.ts` ＝ `grant_type=refresh_token`）、`signInWithOAuth`（`oauth/start/route.ts:105`。URL を作るだけで GoTrue を呼ばない）、`mfa.*`・`admin.*`・`getUser`。これらは**触らない**（`createPublicClient` のまま） | 公式の文書にない挙動。Task 0 で実測 |
| P3 | **`createPublicClient`**（`src/lib/supabase/server.ts:117-129`）は anon の鍵・`persistSession: false`。**`createServiceRoleClient`**（`:137-152`）は service role の鍵。コメント `:133-136` のとおり「persistSession: false でも認証結果はメモリに保持される」。`tests/unit/lib/supabase-client-isolation.test.ts:36-58` が、**セッションを持った後のクライアントが DB へ使うキーを利用者のものに差し替えうる**ことを前提にしている。→ 本命の罠: service role のクライアントで `signInWithPassword` した後にそのクライアントで `.from()`／`.rpc()` を呼ぶと、利用者の権限で動く（または service role の権限が混ざる）。**使い回さない・`.from()` を持たせない**（Review Focus 1） | 専用の「auth だけ」の型を作る（Task 2） |
| P4 | **supabase-js 2.103.3 の auth の呼び出しは `Authorization: Bearer <サービスの鍵>` と `apikey` を付ける**（クライアント作成時の `Authorization`／`apikey` ヘッダーを `GoTrueClient` の `headers` に渡す。`options.jwt` を指定した時だけ利用者のトークンに替わる）。本番の鍵は `sb_secret_`（JWT でない）で、Supabase の API の入口が短命の `service_role` の JWT に替えて上流（GoTrue）へ渡すはず。**手元の CLI が `sb_secret_` を出すかは未確認**（E2E の環境は `supabase status -o json` の `SERVICE_ROLE_KEY` を読む。`scripts/e2e/environment.ts:139`） | Task 0 は手元の JWT の鍵と、出せるなら `sb_secret_` の両方を測る。出せなければ本番での確かめ（Task 11 段階 B）に残し、**すぐ戻せる順で当てる** |
| P5 | **`signInWithPassword` を service role で呼ぶと、GoTrue 側に session が 1 本できる**（ログインは今も同じで、`login/route.ts:52` の session は Cookie に渡さず捨てる。`otp/verify` で作る session だけが結び付く。波 5 の P19）。結び付かない session なので無害（`checkAuthSessionLiveness` が `is_app_session_active` で断る）。ただし**パスワード変更の「現行パスワードの確認」**は 1 回ごとに session を作るので、確かめた直後に `revoke_auth_session`（`remote_schema.sql`。service role だけが呼べる RPC。`logout/route.ts:50` が使う）で消す | Task 5 |
| P6 | **ログインの回数の制限はすでにある**: `login/route.ts:25`（IP・50 回／10 分）、`:46`（メール単位・5 回／10 分。Turnstile の後）。再送 `login/resend/route.ts:41-56` は IP と宛先の二段（`auth:login` と共有）で、署名つきの保留の Cookie が前提。**ウィジェットを足さない**（再送のたびの検査は UX を壊す。決定は (b')＝GoTrue 側の免除で足りる）。再送の呼び出しだけ service role にする | Task 2 |
| P7 | **アプリ側の Turnstile**: `src/lib/turnstile.ts:8-45`（secret が無い本番は失敗に倒す `:10-12`、非本番で secret が無ければ飛ばす `:13`）。登録 `register/route.ts:73-79`（最初）、ログイン `login/route.ts:35-41`、再設定の申請 `password-reset/request/route.ts:40-46`、お問い合わせ。**残す**（決定）。トークンは 1 回しか使えないので、GoTrue へ転送しない | 変えない |
| P8 | **`config.toml` の今**: `[auth.captcha]` はコメントアウト（`:213-216`）。`minimum_password_length = 6`（`:181`）、`password_requirements = ""`（`:184`。**変えない**＝NIST 800-63B-4 3.1.1.2「他の構成規則を課さない」）、`enable_signup = true`（`:175,220`。アプリの `/signup` が要る）、`enable_confirmations = false`（`:225`）、`secure_password_change = false`（`:227`）、`otp_expiry = 3600`（`:234`）、`otp_length = 8`（`:232`）、`double_confirm_changes = true`（`:223`。そのまま）、`[auth.email.notification.password_changed]` はコメントアウト（`:257-260`）、`[auth.mfa.totp] enroll_enabled = verify_enabled = false`（`:308-309`）、`[auth.rate_limit] email_sent = 2`（`:198`。コメントのとおり自前の SMTP が有効な時だけ効く）、`sign_in_sign_ups = 30`（`:206`）。メールは `[local_smtp]`（ポート 54324）。`supabase/templates/` には `magic_link.html` だけ | Task 8 が目標の版を作る |
| P9 | **Supabase CLI の `config.toml` は「現行パスワードを要求」を設定できない**。CLI の実行ファイル（`node_modules/@supabase/cli-windows-x64/bin/supabase.exe`）の文字列を読んだ: `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION`（＝ `secure_password_change`）はあるが、`GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` は**無い**。GoTrue 本体にはこの別の設定がある（調査 §2-3 `user.go:173-186`）。**手元では設定できないので、SEC-AUTH-015-AC-02 の「現行パスワード無しは 400」は手元の E2E では再現できない**（ENV の印のまま。本番は Management API の GET で確かめる。ruling 6） | 調査の §2-9 の問い 2 への答え |
| P10 | **Management API の公式 OpenAPI（`https://api.supabase.com/api/v1-json`、2026-11-01 取得）の `PATCH /v1/projects/{ref}/config/auth`（`UpdateAuthConfigBody`、235 項目）の鍵名**: `security_captcha_enabled`・`security_captcha_provider`（`turnstile`／`hcaptcha`）・`security_captcha_secret`、`mailer_autoconfirm`、`mailer_otp_exp`・`mailer_otp_length`、`password_min_length`・`password_required_characters`・`password_hibp_enabled`、`security_update_password_require_reauthentication`・**`security_update_password_require_current_password`**（説明「Require the user's current password when updating their password.」）、`mailer_secure_email_change_enabled`、`mailer_notifications_password_changed_enabled`・`mailer_subjects_password_changed_notification`・`mailer_templates_password_changed_notification_content`、`mfa_totp_enroll_enabled`・`mfa_totp_verify_enabled`、`external_email_enabled`、`disable_signup`、`rate_limit_anonymous_users`・`rate_limit_email_sent`・`rate_limit_sms_sent`・`rate_limit_verify`・`rate_limit_token_refresh`・`rate_limit_otp`・`rate_limit_web3`、`sessions_timebox`・`sessions_inactivity_timeout`、`site_url`・`uri_allow_list`、`smtp_*`。**「サインイン・サインアップの IP ごとの枠」（`config.toml` の `sign_in_sign_ups`）に当たる鍵はスキーマに無い**。認証は `bearer`（スコープ `auth:write`）。`GET` の応答は `AuthConfigResponse`。`max_rows` は別の窓口 `PATCH /v1/projects/{ref}/postgrest`（`V1UpdatePostgrestConfigBody.max_rows`）。**鍵名は実際の GET の応答で最終確認する** | Task 11 |
| P11 | **アクセストークン**: Management API には、ダッシュボード（Account → Access Tokens）で作る個人用のトークン `sbp_...`（`auth:write` を含む）を `Authorization: Bearer` で渡す。この機械でのログイン済みの Supabase CLI の資格情報は OS の資格情報の保管庫（Windows の資格情報マネージャー）にある可能性が高いが、**中を探らない**（資格情報の探索になる）。controller が新しいトークンを作り、そのシェルの環境変数 `SUPABASE_ACCESS_TOKEN` にだけ入れる（ファイル・文書・ログに書かない）。使い終わったらダッシュボードで消す | Task 11 |
| P12 | **本番の Turnstile の秘密**は、アプリの `TURNSTILE_SECRET_KEY`（Vercel の Production に入れる値）と**同じ Cloudflare のウィジェットの秘密**。`.env.local` の値は常に通るテスト用（`.env.example:41-42`）。本番のウィジェットは未作成の可能性が高い（アプリが未デプロイ）。無ければ Task 11 の段階 B（captcha）は、ウィジェットの作成（ユーザー）の後に回す。秘密は controller のシェルの環境変数 `TURNSTILE_PROD_SECRET` にだけ入れる | ruling 11 |
| P13 | **パスワード再設定の確定**（`password-reset/confirm/route.ts`）が先例: 漏洩確認 `:106`（`checkPwnedPassword`。外部の障害では通して監査に残す）、`admin.updateUserById(userId, { password })` `:142`、全 session 失効 `:159`（ファイル内の局所関数 `revokeAllSessions`。共通の `src/lib/auth/revoke-user-sessions.ts:8` の `revokeAllSessionsForUser(userId)` が同じ 2 段〔自前 `sessions` の `revoked_at`＋RPC `revoke_auth_sessions_for_user`〕で、失敗時に固定の文で throw する）、認証 Cookie の削除 `:169-171`、通知メール `:173-186`（`after()`。パスワードは本文に入れない）。パスワード変更はこの形に寄せる | Task 5 |
| P14 | **会員の認証済みの POST の型**（`src/app/api/profile/route.ts:226-243`）: `authenticateRequest(request)`（`src/lib/auth/authenticate.ts:183`。波 5 で「アプリの session に結び付いた生きた session」だけが `ok`）→ `requireCsrfOrDeny()`（`src/lib/csrfMiddleware.ts:12`。`Response` が返れば拒否）→ 本文を検証。`claims.sub`＝利用者の id、`claims.email`、`claims.aal`、`claims.session_id`、`claims.app_metadata.role`。`/api/auth` 配下の応答には proxy が `Cache-Control: no-store` を付ける（`src/lib/auth-no-store-policy.ts:19`、ADR-0415）ので、**新しい窓口に no-store を自分で足す必要が無い**（波 3 の学び: 本文を読まない呼び手が `networkidle` を止める。**クライアントは本文を必ず読み切る**。`src/lib/client-fetch.ts` の `clientFetch` は CSRF ヘッダーを自動で付ける） | Task 5・6 |
| P15 | **回数の制限**: `enforceRateLimit({ request, endpoint, limit, windowSeconds, subject })`（`src/features/auth/middleware/rateLimit.ts:26`）。`subject` を渡すと**送り元の IP を数えず**、`endpoint\|acct:<sha512(subject)>` を鍵にする（`src/features/auth/ratelimit/index.ts:18-32`）ので、利用者の id を `subject` にすると**全 IP を合わせた本人ごとの枠**になる。枠は固定の窓（窓の開始で切り捨て）。超えると 429＋`Retry-After`、DB の障害は 503（fail-closed） | 本人ごと 10 分 5 回＝ `subject: userId, limit: 5, windowSeconds: 600` |
| P16 | **GoTrue 側の「パスワードを変えた時」の挙動**（調査 §2-3。実測は Task 0 の F）: `secure_password_change` は session の作成から 24 時間より古い時だけ nonce を求める。`LogoutAllExceptMe` は利用者本人の更新（`PUT /user`）で働く。**管理 API（`admin.updateUserById`）で変えた時に他の session が消えるか、GoTrue の変更通知が送られるか**は未確認（Task 0 の F で測る）。アプリは明示的に全 session を失効する（P13）ので、どちらでも正しいが、通知が二重になるかは決める（ruling 9） | Task 0 の結果で ruling 9 |
| P17 | **E2E の GoTrue への直接の呼び出し**（captcha が掛かる窓口＝ anon の鍵で叩く物）を `grep -nE "auth/v1/(token\|otp\|signup\|recover\|resend\|magiclink)\|signInWithPassword\|signInWithOtp\|auth\.signUp" e2e/*.ts` で洗った。**直す 12 ファイル**: `e2e/admin-session-test-utils.ts:78`（`requestToken`。password の時だけ）、`e2e/FR-LOGIN-031-supabase-direct-bypass.spec.ts:114`（`requestToken`）・`:182`（`/otp`）・`:607`（`/signup`＝ AC-01 は書き換え）、`e2e/FR-LOGIN-032-admin-totp-aal2.spec.ts:437`、`e2e/FR-LOOK-SEC-002-postgrest-policies.spec.ts:191`、`e2e/FR-NEWS-SEC-002-direct-db-access.spec.ts:195`、`e2e/FR-PRIVACY-007-settings-postgrest-access.spec.ts:64`、`e2e/FR-SEARCH-020-search-db-function-grants.spec.ts:90`、`e2e/FR-STOCKIST-012-public-screens-with-seeded-rows.spec.ts:47`、`e2e/FR-STOCKIST-014-admin-api-authn-authz-csrf.spec.ts:183`、`e2e/FR-STOCKIST-016-direct-db-access-and-session.spec.ts:154`、`e2e/home-grant-test-utils.ts:130`、`e2e/news-test-utils.ts:169`。**直さない**（`FR-NEWS-SEC-004` は `news-test-utils` の補助を通る。`FR-LOGIN-030:196` は `grant_type=refresh_token` ＝免除）。`/auth/v1/verify`・`/auth/v1/admin/*`・`/auth/v1/logout` も免除。**DB 結合の 3 ファイル**: `tests/integration/db/group_g3_postgrest_paths.integration.test.ts:72`、`group_g4_postgrest_paths…:58`、`order_status_postgrest…:185`（anon の鍵で `signInWithPassword`）。調査の「14 ファイル」は `FR-LOGIN-030`・`FR-NEWS-SEC-004` を含む数で、実際に直すのは 12＋3。supabase-js なら `options: { captchaToken }`、生の fetch なら本文に `gotrue_meta_security: { captcha_token }` | Task 3 |
| P18 | **ユニット／結合のモック**: `createPublicClient` を差し替えている試験のうち、**4 か所の切り替えで落ちる物**: `tests/unit/api/auth/{login-route,login-resend-route}.test.ts`、`tests/integration/api/auth/{cookieFlags,login-resend,login}.test.ts`、`tests/integration/api/{auth-architecture,auth-bot-rate-limit,auth-cookie-data,auth-login-api,auth-login-pending-state,auth-login-resend-api,auth-login-two-step,auth}.test.ts`、`tests/integration/auth-flow.test.ts`（`signInWithPassword`／`signInWithOtp` のモックを `createServiceRoleAuthClient` に替える）。登録の `signUp`（`createClient` のモック）: `tests/unit/api/auth/register-route.test.ts`、`tests/integration/api/auth/{register,register-enumeration,site-url-guard}.test.ts`、`tests/integration/api/{auth-password-rule,auth}.test.ts`、`tests/integration/auth-flow.test.ts`、`tests/integration/ui/auth-register-flow.test.tsx`。`verifyOtp` の側（`otp-verify`・`confirm`）は `createPublicClient` のままなので**変えない** | Task 2 |
| P19 | **`minimum_password_length = 16` の影響**: アプリの最小長は 16（`src/features/auth/schemas/common.ts:33`）で、E2E の会員は `E2e-${randomBytes(12).toString('hex')}!`（29 文字）か `TestPassword123!`（`e2e/helpers.ts:23`＝ちょうど 16 文字）。GoTrue の管理 API（`admin.createUser`・`updateUserById`）が最小長を強制するかは未確認（Task 0 の G）。強制するなら 16 文字未満の固定値を使う試験が落ちる（`FR-PWRESET-002:116` の `'NewPassword123!'` は 15 文字の否定の試験）。Task 8 Step 3 で全部洗う | Task 0 の G／Task 8 |
| P20 | **ビルドの許可オリジンの検査**: `src/lib/build-env-guard.ts:7` の `REQUIRED_IN_PRODUCTION = ['NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_SUPABASE_URL']`、`assertBuildEnv`（`:30-44`、`VERCEL_ENV === 'production'` で判定。`NODE_ENV` は E2E の本番ビルドも `production` なので使わない）。`next.config.ts:2,5` が先頭で呼ぶ。単体 `tests/unit/lib/build-env-guard.test.ts`（先頭 `DD-ABOUT-002`）。`APP_ALLOWED_ORIGINS` の読み手は `src/lib/redirect.ts:16`（`parseAllowedOrigins`）、`hasExplicitOriginConfig`（`:127`。ほかに `NEXT_PUBLIC_SITE_URL` などがあれば「設定あり」）と `src/proxy.ts:164-200`（未設定なら要求由来の origin で比べて警告）。`NEXT_PUBLIC_SITE_URL` は既に必須なので、実効の設定漏れは起きにくいが、決定は「`APP_ALLOWED_ORIGINS` 自体が無い本番のビルドを止める」。**`proxy.ts`・`redirect.ts` は変えない**（共有）。`docs/06_Operations/secrets.md:140-153` に項目がある | Task 1 |

## Global Constraints

- 並行作業: 別セッション（G-1／H）が同じ作業ツリーの別ファイルを編集し、コミットの時に全体の `tsc` を通す。**`git add`・`git commit`・`git stash`・`git checkout`・`git reset`・`git restore` は実行しない**（controller がタスクごとにコミットする）。`git status --short` に出ている `.claude/CLAUDE.md`・`package.json`・`docs/06_Operations/README.md`・H の E2E の補助（`e2e/account-test-utils.ts`・`e2e/shop-test-utils.ts` ほか）は他者の変更なので触らない。
- **E2E・サーバー・3000 番・DB 結合試験・`db reset`・`supabase start/stop`・全体の `jest`・`next build`・`npm run test:trace-coverage`・`npm run trace:report`・`validate-trace --update-baseline` は実行しない**。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。E2E・DB 結合試験は書くだけ。DB・Supabase・Cloudflare・Management API には触らない（Task 0・10・11 は controller）。
- **実装者は移行ファイルを `supabase/pending-wave6/` にだけ書く。`supabase/migrations/` に置かない。`supabase/config.toml` を直接編集しない**（`supabase/pending-wave6/config.toml` に目標の版を作る。H の `db reset` や再起動が拾う）。動かすのは controller（Task 10）。この間、移行・設定を読む単体試験（`tests/unit/migrations/…`・`tests/unit/supabase/…`）は `supabase/{pending-wave6,migrations}/` のどちらにあっても読める書き方にする。
- **切り替えと対の E2E の変更は、生きている `e2e/` に書かない**（他のセッションの E2E の全件実行・pre-push が赤になるため）。対象: 9 つの `test.fail` の印の外しと注の直し、`FR-LOGIN-031` の AC-01・02 の書き換えと新しい AC-04、新しい `FR-ACCOUNT-046`。実装者は `.superpowers/sdd/2026-10-25-security-gap-fixes/wave6-staging/{a,b}/<リポジトリ相対パス>` に**元の写し（a）と直した写し（b）**を置き、`git diff --no-index` で `supabase/pending-wave6/e2e-wave6.patch`（`a/`・`b/` の接頭辞の剥がし方を `BASE.txt` に書く）を作る。`BASE.txt` には a の各ファイルの `git hash-object` を書く。`FR-ACCOUNT-046` は `supabase/pending-wave6/e2e/FR-ACCOUNT-046-password-change.spec.ts.pending`（拡張子 `.pending` で `tsc`・Playwright の対象外）。Task 10 Step 2 が当てる。Task 3 の補助へのダミーの `captcha_token`（切り替え前でも害が無い）だけは生きている `e2e/` に入れる。**パッチの元（a）は Task 3 の後の生きているファイル**。他者の変更が `e2e/` の同じファイルに入っていても、Task 10 が `git apply --check` で確かめ、当たらない所だけを表（印の表）から手で当てる。
- **着手の条件**: Task 3（補助のダミー captcha）は captcha が切れていても害が無い（GoTrue は余分な `gotrue_meta_security` を無視する）ので、手元の設定の切り替えの前に入れてよい。Task 2（アプリの 4 か所の切り替え）も captcha が切れている間は同じ挙動（管理者資格で呼ぶだけ）。**危ないのは設定の切り替えだけ**で、Task 3 の 12＋3 ファイルと Task 2 が入った後に Task 10 で行う。Task 5 は M3（Task 4）が手元と本番に当たるまで手元・本番の DB の画面は動かない（単体は動く）。
- `.ts` / `.tsx` を 1 つ編集するたびに `npx tsc --noEmit` を流し、自分の誤りをその場で直す。他者の誤りは触らず報告に書く。
- 着手前に `git status --short` を見て、他セッションが変更中のファイルを確かめ、**重ならないようにする**。この波が触る共有ファイル: `src/app/api/auth/{login,login/resend,register}/route.ts`、`src/lib/supabase/server.ts`（Task 2 のコメントだけ）、`src/app/account/page.tsx`（Task 6 でリンクを 1 つ足すだけ。H の `FR-ACCOUNT-*` が使う大きな画面）、`src/lib/build-env-guard.ts`、`scripts/trace/scope.json`、`tests/integration/db/auth_grants_inventory.integration.test.ts`、E2E の補助 12 ファイル、`.env.example`、`docs/06_Operations/{secrets,deployment-topology}.md`。他者の変更が在れば止めて報告する。
- 触らない: `src/proxy.ts`・`next.config.ts`・`src/lib/redirect.ts`、`playwright.config.ts`、`scripts/e2e/environment.ts`（G-1 の了承が要る。この波は要らない）、`supabase/migrations/**`（既存の移行は書き換えない）、`supabase/config.toml`（上のとおり）、`src/lib/orders/**`・G／H の窓口と画面、`otp/verify`・`confirm`・`oauth/*`・`refresh`（P2）、`private.*`・`public.is_app_session_active` ほか波 5 の関数。
- 共有文書は**編集しない**: `requirements.md`、`test-spec.md`、作業と指摘の台帳、`api-spec.md`、`route-inventory.md`、`er.md`、`screen-list.md`、`screen-flow.md`、`docs/06_Operations/{README,db-migrations}.md`、`tests/unit/docs/*-traceability.test.ts`。必要な変更は各タスクの報告に「共有文書の変更案」として書く。`docs/06_Operations/{secrets,deployment-topology}.md`・`.env.example`・新しい `docs/06_Operations/supabase-auth-config.md` は Task 9 で編集してよい。
- 文書: 日本語。`documentation-guide` スキルの項目の形（見出し直後の属性表）・ID の体系・TSDoc（`@packageDocumentation`・`@impl`・`@design`・`@remarks` に「なぜ」だけ）・テスト名の先頭に ID を守る。文書の冒頭の確認日は 2026-11-01。絵文字は使わない。範囲内の領域は新しい `FREQ-` を振らず `SR-AUTH-NNN`（要件は `docs/02_Requirements/areas/auth.md`）。脅威は `docs/05_Quality/security/threats/auth.md`、構造設計は `docs/03_BasicDesign/areas/auth.md`、設計判断は `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md`、処理の詳細は `docs/04_DetailDesign/pages/14_login.md` の `DD-`。「今のコードは満たさない」は**直した項目だけ**外す。新しい受け入れ条件を起こしたら、`auth.md` の冒頭の「E2E ファイルと受け入れ条件の対応表」にも足す。**会員の 2 段（パスワード＋メール OTP）は NIST SP 800-63B-4 の AAL2 ではない**（メールは out-of-band に使えない。3.1.3.1）と書き、AAL2 を名乗らない。
- コードのコメント: 範囲内の新しい単位に TSDoc で `@impl IMPL-AUTH-NNN`・`@design DD-AUTH-NNN`・`@remarks`（「なぜ」だけ）を付け、`scripts/trace/scope.json` の AUTH の `src`・`tests`・`e2e` に足す（Task 2・5・6・7）。番号は書く直前に `grep -rhoE "IMPL-AUTH-[0-9]+" src tests | sort -u | tail`（今の最大 `227`）、`DD-AUTH-` は `14_login.md`（今の最大 `039`）、`DATA-AUTH-` は `docs/03_BasicDesign/areas/auth.md`（今の最大 `008`）、`SEC-AUTH-` は `auth.md`（今の最大 `033`）、`THR-AUTH-`（今の最大 `033`）、`SR-AUTH-`（今の最大 `008`）、`FR-AUTH-`（今の最大 `005`）で確かめる。変えた単位（`login/route.ts` の `@remarks`、`resend/route.ts`、`register/route.ts`、`build-env-guard.ts`）は `@remarks` が今の動きと食い違わないよう直す。
- 入力は信用しない: 監査・ログ・応答に、パスワード（現行・新）、確認コード、トークン、`session_id` の値、Supabase の誤りの本文を残さない。残してよいのは固定の符号だけ（`current_password_invalid`・`code_invalid`・`code_locked`・`pwned_password`・`supabase_captcha_rejected` など）。応答の文は「現行パスワードが違う」と「コードが違う」を、どちらの検証で落ちたか分かる範囲に留める（現行パスワードの検証は Task 5 の 1 段目だけで行い、2 段目で再び現行パスワードの当否を明かさない）。
- **サーバーの Supabase クライアントの使い方**: captcha が掛かる窓口の呼び出しは**必ず `createServiceRoleAuthClient()`（毎回新しく作る・使い回さない・`.from()`／`.rpc()` を持たない型）**を使う。DB・RPC・管理 API は従来の `createServiceRoleClient()`。両者を 1 つの変数に混ぜない。この service role の経路で得た session を Cookie に渡さない（`signInWithPassword` の session は捨てる／`signUp` の session は Confirm email が ON なら無い）。
- 実装は最小。決定にない設定項目・追加の窓口・画面は作らない（Turnstile のウィジェットを再送に足さない。`AUTH_REQUIRE_APP_SESSION` のような旗を作らない）。作業ツリーに CRLF のファイルがある。編集は Edit で行い、`sed -i` は使わない。`graphify update` は自分で流さない。
- コミットは controller が種類ごとに分ける（pre-commit の lint のコマンドの長さの上限。`src`／単体・結合の試験／E2E と scripts／文書／移行・設定。波 4・5 のとおり）。

### ID の割当

番号は**書く直前に再確認**する。違えば割当表をずらして一貫させる。

| 種類 | ID | 題 | タスク |
| --- | --- | --- | --- |
| ADR | `ADR-0420` | Supabase の captcha を有効にし、アプリのサーバーの認証の呼び出しは管理者資格（service role）で行う。アプリの Turnstile の検証は残す。再送にウィジェットを足さない | 2 |
| ADR | `ADR-0421` | パスワード変更はアプリの窓口で、現行パスワード＋アプリが送るコード（表に保存）＋全 session 失効＋通知。GoTrue は `secure_password_change`＋「現行パスワードを要求」＋変更通知＋最小長 16 | 5 |
| 実装 | `IMPL-AUTH-228`（`@design DD-AUTH-040`） | `src/lib/auth/service-role-auth-client.ts`（`createServiceRoleAuthClient`・`isCaptchaRejection`） | 2 |
| 実装 | `IMPL-AUTH-229`（`@design DD-AUTH-041`） | `src/features/auth/services/password-change.ts` | 5 |
| 実装 | `IMPL-AUTH-230`／`231`（`@design DD-AUTH-041`） | `password/change/start/route.ts`／`confirm/route.ts` | 5 |
| 実装 | `IMPL-AUTH-232`（`@design DD-AUTH-042`） | `src/app/account/password/PasswordChangeForm.tsx`（`page.tsx` は同じ `@impl` の薄い入口でよい） | 6 |
| 詳細設計 | `DD-AUTH-040` | captcha の免除と auth だけのクライアント。**項目は Task 2 が `14_login.md` に作る** | 2 |
| 詳細設計 | `DD-AUTH-041`・`DD-AUTH-042` | パスワード変更の処理（開始・確認・失効・通知・回数）／画面。Task 5・6 が作る | 5・6 |
| データ | `DATA-AUTH-009`・`010` | `public.password_change_challenges`／関数 `issue_password_change_challenge`・`consume_password_change_challenge` | 4 |
| 要求 | `SR-AUTH-009` | ログイン中の会員が自分でパスワードを変えられる。変更は本人の確かめ（現行パスワードとメールのコード）を求め、変更後は全 session を失効し通知する（推定。ASVS 4.0.3 V2.1.5・V2.1.6・V2.2.3・V3.3.3） | 7 |
| 要件 | `FR-AUTH-006` | `/account/password` の画面と `/api/auth/password/change/{start,confirm}` | 7 |
| 受け入れ条件 | `FR-AUTH-006-AC-01`〜`07` | 画面（3 幅）／正しい手順で変わる／現行パスワードが違う／コードが違う・5 回で使えなくなる／新パスワードの決まり／未ログイン・管理者は aal2／パスワードを持たない会員（Google だけで登録）への再設定の案内 | 6・7 |
| セキュリティ要件 | `SEC-AUTH-034`（上位 `THR-AUTH-034`） | パスワード変更は現行パスワード＋コードを求め、全 session を失効し、通知し、回数を制限し、監査する | 7 |
| 受け入れ条件 | `SEC-AUTH-034-AC-01`〜`04` | 全 session 失効（この端末を含む）／通知のメール（パスワードを含まない）／本人ごと 10 分 5 回／監査に固定の符号だけ | 7 |
| セキュリティ要件 | `SEC-AUTH-035`（上位 `THR-AUTH-035`） | アプリのサーバーの認証の呼び出しは captcha を免除される管理者資格で行い、Supabase の captcha の拒否を利用者の誤りに丸めない | 2・7 |
| 受け入れ条件 | `SEC-AUTH-035-AC-01`・`02` | captcha が有効でもアプリのログイン・登録が通る（E2E は既存の `FR-LOGIN-008` ほかが担う）／ captcha の拒否はログインで 5xx＋監査（単体） | 2・7 |
| 受け入れ条件 | `SEC-AUTH-015-AC-04`・`05` | 直接の `/signup`・`/token`・`/otp` がトークン無しで 400（E2E）／本番の「現行パスワードを要求」が ON（レビュー） | 7・8 |
| 受け入れ条件 | `SEC-ABOUT-007-AC-02` | `VERCEL_ENV=production` で `APP_ALLOWED_ORIGINS` が無いビルドは落ちる（単体） | 1 |

### 共有ファイルの並べ方（shared files）

| ファイル | 触るタスク | 並べ方 |
| --- | --- | --- |
| `src/app/api/auth/{login,login/resend,register}/route.ts` | 2 | 1 回だけ（3 窓口を同じ編集で） |
| `src/lib/supabase/server.ts` | 2 | 1 回だけ（コメントの直しだけ。ほかのセッションが `createClient` 系を編集していないか `git status` で確かめる） |
| `src/app/account/page.tsx` | 6 | 1 回だけ（プロフィールの欄にリンクを 1 つ） |
| `e2e/` の補助 12 ファイル＋`tests/integration/db` の 3 ファイル | 3 | 1 回だけ（`e2e/captcha-test-utils.ts` を作り、全部がそれを使う） |
| `e2e/FR-LOGIN-031-supabase-direct-bypass.spec.ts` | 3（呼び出しのトークン）・8（AC-01・02 の書き換えと印）・7（新しい AC-04） | Task 3 だけが生きている `e2e/` を直す（ダミーのトークン。切り替え前でも害が無い）。**Task 7・8 は `wave6-staging/b/` の写しを 1 つ順に直して `e2e-wave6.patch` にまとめる**（生きている `e2e/` に書かない）。当てるのは Task 10 Step 2 |
| `scripts/trace/scope.json` | 2・5・6・7 | AUTH の `src`／`tests`／`e2e` に足す。タスクごとに 1 回（同じ配列の別の行を足すだけ） |
| `docs/*/areas/auth.md` 系 | 2・5・7・8 | 順 |
| `supabase/pending-wave6/*` | 4・8 | M3 は Task 4。Task 8 が `config.toml`（写し）・`config.patch`（今の `supabase/config.toml` への差分）・`e2e-wave6.patch`・`e2e/FR-ACCOUNT-046-…spec.ts.pending`（Task 7 が作る）・`BASE.txt`（パッチの元にした各ファイルの `git hash-object`）を置く。Task 10 で M3 は `supabase/migrations/` へ移し、`config.patch`・`e2e-wave6.patch` は**その時点の**ファイルに当てる（写しで上書きしない） |

---

## Review Focus（最も踏みやすい失敗 10 つ）

レビュアーと実装者は、各タスクの前後でこの 10 つを具体的な入力で確かめる。

1. **service role のクライアントが漏れる。** `signInWithPassword` の後、同じクライアントで `.from()`／`.rpc()`、または別の要求で使い回すと、メモリに残った利用者の session の鍵で DB を叩く／service role が広がる（P3）。確かめる入力（単体、`supabase-client-isolation.test.ts` の型）: `createServiceRoleAuthClient()` の返り値に `from`・`rpc` が**無い**（型と実体）、2 回呼ぶと別のオブジェクト、`signInWithPassword` の後に `signInWithOtp` を呼んでも `/otp` の `Authorization` が service role の鍵のまま、`/token` の `Authorization` も同じ。呼び手（4 か所＋パスワード変更）が戻り値の session を `NextResponse` の Cookie へ渡していない（`grep`）。
2. **captcha の免除が効かない時に、利用者の誤りに見える。** 本番の `sb_secret_` が管理者として扱われないと、GoTrue は 400（`captcha_failed`）を返し、今の `login/route.ts:54-57` は `error` を全部 401「メールアドレスまたはパスワードが正しくありません」にする。**全員がログインできないのに監視に上がらない**。確かめる入力（単体）: `signInWithPassword` が `{ code: 'captcha_failed', status: 400 }` を返すと、ログインは 500（`Internal server error`）＋監査 `outcome: 'error'`・`detail: 'supabase_captcha_rejected'`、401 にしない。`signInWithOtp`（ログイン・再送）と `signUp`（登録）も同じ。
3. **現行パスワードの確認が総当たりの窓口になる。** 盗んだ session の持ち主が `start` で現行パスワードを何度でも試せる。確かめる入力: 本人ごと 10 分 5 回（6 回目は 429）、IP ごと 20 回／10 分、誤りの応答は「現行パスワードが違う」だけで残りの回数を言わない、成功も失敗も監査、確認に作った GoTrue の session をすぐ消す（P5。消えないと `auth.sessions` が溜まる）。
4. **確認コードの強さ。** 8 桁（`crypto.randomInt`）、10 分、使い捨て、**利用者と GoTrue の `session_id`（今の session）に結ぶ**、間違いは 5 回で使えなくなる、新しい `start` は前のコードを無効にする。確かめる入力（DB 結合・書くだけ）: 別の session のコードは `invalid`、5 回間違えた後は正しいコードでも `locked`、期限切れは `none`、`consume` は成功で `used_at` を立てて 2 回目は `none`、平文のコードがどの列にも無い。`attempts` の増加は 1 つの文の中（並列の推測で 5 回を超えない）。
5. **変更の順番と部分的な失敗。** 順番は「書式の検査→ 漏洩確認→ コードを使い切る（`consume`）→ パスワードの更新→ 全 session 失効→ Cookie の削除→ 通知」（`confirm` の⑥⑦⑧⑨⑩⑪⑫）。`consume` を先にすると、弱いパスワードで弾かれた人のコードを焼く。**書式の検査と漏洩確認はコードの消費より前**（再設定の確定と逆の順＝コードは本人確認なので焼かない方が親切）。「現行と同じ」の確かめは置かない（`confirm` が現行パスワードの当否を明かす窓口になるため。`confirm` は GoTrue の `signInWithPassword` を一度も呼ばない）。パスワードの更新が済んだ後の全 session 失効の失敗は 200 のまま監査に `revoke_failed`（再設定の確定と同じ。ただし**この端末の Cookie は必ず消す**）。パスワードの更新の失敗は 500・監査 `update_failed`・コードは焼けたまま（再度 `start`）。
6. **全 session 失効の範囲。** 「この端末の session を含む全部」。`revokeAllSessionsForUser(userId)` は自前 `sessions`（`revoked_at`）と GoTrue（`revoke_auth_sessions_for_user`）の両方。確かめる入力（E2E）: 変更後に古い access token で `/api/auth/me` が `authenticated: false`、古い refresh token で `/api/auth/refresh` が 401、新しいパスワードで入り直せて、古いパスワードは 401。Cookie（アクセス・リフレッシュ・CSRF）が応答で消える。
7. **TOTP の管理者・サポーター。** GoTrue は MFA 済みの利用者に aal2 を求める（`user.go:108-112`）。アプリの窓口は `claims.aal !== 'aal2'` かつ役割が admin／supporter なら 403 で断る（直接の道と同じ強さ）。確かめる入力: aal1 の管理者の `start` が 403・監査 `denied`・コードを送らない。一般会員は aal1 で通る。
8. **手元の設定の切り替えで赤が一斉に出る。** `enable_confirmations = true` で、アプリの登録で作った会員がメールの確認まで入れない／ `test.fail` の印を外し忘れると「予想外の成功」で赤になる（逆に早く外すと現行の設定で赤になる）／ captcha を入れたのに補助が 1 つでもダミーを付け忘れると 400／`minimum_password_length = 16` が 16 文字未満の固定値を落とす／ TOTP を有効にした影響が `stockist-admin-test-utils` ほかの amr の補助に出る。確かめる入力: Task 8 の表（12＋3 ファイル・9 つの印）の全件が分類済み、Task 10 の最初に対象の spec を `--grep` で 1 本ずつ通す。
9. **本番の順序（先に captcha をオンにすると今の開発が止まる）。** 順: ①アプリのコード（Task 2）が入り、普段の開発が service role の呼び出しに変わっていること→ ②段階 A（captcha 以外）→ ③段階 B（captcha）→ ④すぐ確かめ、崩れたら**その場で `security_captcha_enabled: false`**。本番の鍵 `sb_secret_` が免除されるかは、段階 B の確かめで初めて分かる（P4）。
10. **設定の押し出しと秘密の混入。** `supabase config push` を流さない。`config.toml` に本番の秘密を入れない（captcha の秘密は `env(...)` で、手元は公開のテスト用の値）。Management API の GET の控えは、本物の秘密の鍵（名前の末尾が `_secret`・`_secrets`・`_pass`・`_key`・`_auth_token`）の値を伏せてから保存する（`pass`・`token` の部分一致で伏せると `password_min_length` など変える値が消える）。トークン（`sbp_`）・Turnstile の秘密を文書・ログ・報告に書かない。

---

## ファイルの全体像

| 区分 | ファイル | 操作 | タスク |
| --- | --- | --- | --- |
| ビルドの検査 | `src/lib/build-env-guard.ts`、`tests/unit/lib/build-env-guard.test.ts`、`.env.example`、`docs/06_Operations/secrets.md` | 変更 | 1・9 |
| AUTH の `src` | `src/lib/auth/service-role-auth-client.ts`（新規）、`src/lib/supabase/server.ts`（コメントのみ）、`src/app/api/auth/{login,login/resend,register}/route.ts`、`src/features/auth/services/password-change.ts`・`schemas/password-change.ts`（新規）、`src/app/api/auth/password/change/{start,confirm}/route.ts`（新規）、`src/app/account/password/{page.tsx,PasswordChangeForm.tsx}`（新規）、`src/app/account/page.tsx` | 新規・変更 | 2・5・6 |
| 移行・設定 | `supabase/pending-wave6/20261101120000_sec_password_change_challenges.sql`、`supabase/pending-wave6/config.toml`（目標の写し）、`supabase/pending-wave6/config.patch`、`supabase/pending-wave6/BASE.txt`、`supabase/templates/password_changed_notification.html`、`supabase/.env.example` | 新規 | 4・8 |
| 試験（単体・結合） | `tests/unit/lib/auth/service-role-auth-client.test.ts`、`tests/unit/lib/supabase-client-isolation.test.ts`、P18 の約 22 ファイル、`tests/unit/features/auth/password-change*.test.ts`、`tests/unit/api/auth/password-change-{start,confirm}-route.test.ts`、`tests/integration/ui/auth-password-change.test.tsx`、`tests/unit/migrations/sec-password-change-challenges.test.ts`、`tests/unit/supabase/config-wave6.test.ts`、`tests/integration/db/auth_password_change_challenges.integration.test.ts`、`auth_grants_inventory`、DB 結合の補助 3 ファイル | 追加・変更 | 1〜8 |
| E2E 補助 | `e2e/captcha-test-utils.ts`（新規）と P17 の 12 ファイル | 新規・変更 | 3 |
| E2E（Task 10 まで `supabase/pending-wave6/` に用意。生きている `e2e/` には書かない） | `e2e/FR-ACCOUNT-046-password-change.spec.ts`（新規。`supabase/pending-wave6/e2e/…spec.ts.pending`）、`FR-LOGIN-031`（AC-01・02 の書き換え・AC-04 を足す・印）、`FR-LOGIN-024`・`FR-SIGNUP-002`・`FR-SIGNUP-003`・`FR-LOGIN-034`・`FR-LOGIN-032`（印と注）＝`e2e-wave6.patch` | 新規・変更 | 7・8（当てるのは 10） |
| 文書 | `docs/02_Requirements/areas/{auth,about}.md`、`docs/05_Quality/security/threats/auth.md`、`docs/03_BasicDesign/areas/auth.md`、`docs/03_BasicDesign/decisions/ADR-0420・0421`（新規）、`docs/04_DetailDesign/pages/14_login.md`、`docs/06_Operations/{secrets,deployment-topology}.md`、`docs/06_Operations/supabase-auth-config.md`（新規）、`scripts/trace/scope.json` | 追記・更新 | 1〜9 |

### 目標の `config.toml`（Task 0 の隔離スタックと Task 8 の `pending-wave6/config.toml` で同じ内容）

今の `supabase/config.toml` との差分はこれだけ（行は今の行番号）。ほかは変えない。

```toml
# :181  minimum_password_length = 6      ->  minimum_password_length = 16       # アプリの 16 と同じ。password_requirements は "" のまま（構成規則を課さない）
# :213-216  [auth.captcha] のコメントを外して
[auth.captcha]
enabled = true
provider = "turnstile"
secret = "env(SUPABASE_AUTH_CAPTCHA_SECRET)"   # 手元は Cloudflare の公開のテスト用 1x0000000000000000000000000000000AA を supabase/.env に置く。本番の秘密を書かない
# :225  enable_confirmations = false     ->  true     # 本番の前提。登録は 202＋確認メール
# :227  secure_password_change = false   ->  true     # 24 時間より古い session は nonce が要る
# :234  otp_expiry = 3600                ->  300      # 本番の前提。アプリの保留の Cookie も 5 分
# :257-260  コメントを外して
[auth.email.notification.password_changed]
enabled = true
subject = "パスワードの変更を受け付けました"   # GoTrue 側の通知。アプリの通知「パスワードを変更しました」と件名を変えて見分ける（ruling 9）。Task 11 段階 A の mailer_subjects_password_changed_notification も同じ
content_path = "./supabase/templates/password_changed_notification.html"
# :308-309  [auth.mfa.totp] enroll_enabled = true / verify_enabled = true
# （Task 8 のレビューで足した。ruling 21）確認メールの雛形。:241 の magic_link の節の次に
[auth.email.template.confirmation]
subject = "メールアドレスの確認"
content_path = "./supabase/templates/confirmation.html"   # {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup。GoTrue の既定の ConfirmationURL だと確認の窓口が missing_token_hash で落ちる
```

あわせて `supabase/templates/magic_link.html` の本文「有効期限は1時間です」を「有効期限は5分です」に直す（`otp_expiry = 300` と同時。`config.patch` に入る。ruling 22）。

---

## Task 0: 測る（controller。コードは書かない。**この結果が出るまで Task 2 以降を dispatch しない**）

**範囲:** 調査 §1-7・§2-9 の実測。(b') が成り立つか（GATE）と、設定の影響（確認メール・最小長・TOTP・変更通知・24 時間の窓）を、**G-1／H が使っている手元の Supabase を止めずに**、別の project_id・別のポートで立てた隔離スタックで測る。隔離スタックが立たない（Docker の容量など）時だけ、G-1／H と窓を合意して主のスタックで同じ測定をする（測定の後に `config.toml` を元に戻して再起動する）。

**前提:** Docker が動いていること。隔離スタックは `postgres`・`gotrue`・`kong`・`mailpit` だけで足りる。H の 5 時間の E2E が終わっていなくても流せる（別のポート・別のコンテナ名。DB のボリュームも別）。

**やること:**

- [ ] **Step 1: 隔離スタックを作る。** 作業用の置き場 `.superpowers/sdd/2026-10-25-security-gap-fixes/wave6-sandbox/`（`supabase/config.toml` を 1 つ置く）。元は今の `supabase/config.toml` で、上の「目標の `config.toml`」の差分を当て、さらに次を変える: `project_id = "o_official_w6"`、`[api] port = 55321`、`[db] port = 55322`・`shadow_port = 55320`、`[db.pooler] port = 55329`、`[studio] port = 55323`、`[local_smtp] port = 55324`、`[analytics] port = 55327`、`[edge_runtime] inspector_port = 8084`、`[db.migrations] enabled = false`、`[db.seed] enabled = false`。**テンプレートの置き場も作る**（`content_path` は workdir からの相対で、置き場に無いと `supabase start` が落ちるか、F3 の変更通知が何も測らない）: `wave6-sandbox/supabase/templates/` に今の `supabase/templates/*`（`magic_link.html`）を写し、目標の `[auth.email.notification.password_changed] content_path = "./supabase/templates/password_changed_notification.html"` が指す `password_changed_notification.html` を**同じ置き場に仮の本文で作る**（Task 8 の本文と同じ文「アカウントのパスワードが変更されました。心当たりがない場合は、ただちにパスワードを再設定のうえお問い合わせください。」でよい。Task 8 の本物はまだ無い）。起動の前に `[auth.email.template.magic_link]` と `[auth.email.notification.password_changed]` の `content_path` の両方が置き場に実在することを確かめる。環境変数 `SUPABASE_AUTH_CAPTCHA_SECRET=1x0000000000000000000000000000000AA` を付けて（このシェルの中だけ）`npx supabase start --workdir .superpowers/sdd/2026-10-25-security-gap-fixes/wave6-sandbox -x studio,realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta,postgrest`。立ったら `npx supabase status --workdir … -o json` から URL・anon・service_role（と、出ていれば `SECRET_KEY`＝`sb_secret_...`）・DB の URL・メール（mailpit）の URL を読む。**主のスタック（`o_official`、ポート 54321 台）に触らない**。起動の途中で `config.toml` の `env(...)` が解決されない／CLI が `supabase/.env` を読むかは、このとき確かめて Task 8 Step 1 の `supabase/.env.example` の書き方に反映する。
- [ ] **Step 2: 測定のスクリプトを置いて流す。** 次を `.superpowers/sdd/2026-10-25-security-gap-fixes/wave6-task0-captcha-admin-exempt.mjs` に置き、隔離スタックの値を環境に入れて `node` で流す（`pg` は既存の依存）。結果の JSON を `wave6-task0-report.md` に貼る。

```js
// node wave6-task0-captcha-admin-exempt.mjs
// 環境: SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY [SUPABASE_SECRET_KEY] DATABASE_URL MAIL_LOCAL_URL （全部、隔離スタックの値。手元以外には流さない）
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_SECRET_KEY: SECRET, DATABASE_URL, MAIL_LOCAL_URL } = process.env;
for (const [k, v] of Object.entries({ URL_, ANON, SERVICE, DATABASE_URL, MAIL_LOCAL_URL })) if (!v) throw new Error(`${k} が無い`);
for (const u of [URL_, DATABASE_URL, MAIL_LOCAL_URL]) if (!/\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u)) throw new Error('手元以外には流さない');
if (/:54321\b|:54322\b|:54324\b/.test(`${URL_} ${DATABASE_URL} ${MAIL_LOCAL_URL}`)) throw new Error('主のスタック（54321 台）には流さない');
const DUMMY = 'XXXX.DUMMY.TOKEN.XXXX';
const ip = () => `10.${[...randomBytes(3)].join('.')}`;
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
const pw = () => `W6-${randomBytes(12).toString('hex')}!`; // 27 文字
const em = (l) => `w6-${l}-${randomUUID().slice(0, 8)}@example.com`;
const out = { results: {} };
const rec = (name, ok, extra = {}) => { out.results[name] = { ok, ...extra }; };
// key: apikey ヘッダー。bearer: Authorization（無ければ key と同じ）。supabase-js と同じく、サービスの鍵は両方に付ける
async function call(method, path, { key = ANON, bearer, body } = {}) {
  const res = await fetch(`${URL_}${path}`, { method, headers: { apikey: key, authorization: `Bearer ${bearer ?? key}`, 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, code: json.error_code ?? json.code, msg: String(json.msg ?? json.message ?? '').slice(0, 80), json };
}
const isCaptcha = (r) => r.status === 400 && /captcha/i.test(`${r.code} ${r.msg}`);
// 手元の config.toml:229 は [auth.email] max_frequency = "1s"。同じ宛先に 1 秒以内にメールを出す呼び出し（/otp・/recover・/signup・/resend・signInWithOtp）を続けると
// captcha が通っていても GoTrue が 429（over_email_send_rate_limit）を返し、GATE を誤って止める（FR-LOGIN-030:150 に同じ記録）。
// メールを出す呼び出しは必ず mailCall を通す: 同じ宛先への前回から 1.1 秒以上あける（宛先ごとに数える。別の宛先は待たない）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastMail = new Map();
async function mailCall(email, fn) {
  const wait = 1100 - (Date.now() - (lastMail.get(email) ?? 0)); if (wait > 0) await sleep(wait);
  try { return await fn(); } finally { lastMail.set(email, Date.now()); }
}
const db = new pg.Client({ connectionString: DATABASE_URL }); await db.connect();
const created = [];
const mkUser = async (label, password = pw()) => { const email = em(label); const r = await call('POST', '/auth/v1/admin/users', { key: SERVICE, body: { email, password, email_confirm: true } }); if (r.status >= 300) throw new Error(`user ${label} ${r.status}`); created.push(r.json.id); return { id: r.json.id, email, password }; };
const mails = async (email) => (await (await fetch(`${MAIL_LOCAL_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json()).messages ?? [];
try {
  const u1 = await mkUser('a');
  // A. anon（アプリを通らない直接の呼び出し）
  const a1 = await call('POST', '/auth/v1/signup', { body: { email: em('s0'), password: pw() } }); rec('A1 anon /signup トークン無し -> 400 captcha', isCaptcha(a1), a1);
  const a2 = await call('POST', '/auth/v1/signup', { body: { email: em('s15'), password: 'Abcdefgh1234!xy', gotrue_meta_security: { captcha_token: DUMMY } } }); rec('A2 anon /signup ダミー＋15 文字 -> 422 weak_password', a2.status === 422 && /weak/i.test(`${a2.code} ${a2.msg}`), a2);
  const e3 = em('s16'); const a3 = await call('POST', '/auth/v1/signup', { body: { email: e3, password: pw(), gotrue_meta_security: { captcha_token: DUMMY } } }); created.push(a3.json.id ?? a3.json.user?.id); rec('A3 anon /signup ダミー＋16 文字以上 -> 200・session 無し（確認待ち）', a3.status === 200 && !a3.json.access_token, { status: a3.status });
  const a4 = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: u1.email, password: u1.password } }); rec('A4 anon /token(password) トークン無し -> 400 captcha', isCaptcha(a4), a4);
  const a5 = await call('POST', '/auth/v1/otp', { body: { email: u1.email, create_user: false } }); rec('A5 anon /otp トークン無し -> 400 captcha', isCaptcha(a5), a5);
  const a6 = await call('POST', '/auth/v1/recover', { body: { email: u1.email } }); rec('A6 anon /recover トークン無し -> 400 captcha', isCaptcha(a6), a6);
  const a7 = await call('POST', '/auth/v1/resend', { body: { email: e3, type: 'signup' } }); rec('A7 anon /resend トークン無し -> 400 captcha', isCaptcha(a7), a7);
  const a8 = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: u1.email, password: u1.password, gotrue_meta_security: { captcha_token: DUMMY } } }); rec('A8 anon /token ダミー付き -> 200（E2E の補助が通る）', a8.status === 200, { status: a8.status });
  const a9 = await call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: a8.json.refresh_token } }); rec('A9 anon refresh_token トークン無し -> 200（免除）', a9.status === 200, { status: a9.status });
  // B/C. サービスの鍵（JWT）と sb_secret_（出ていれば）。トークン無しで通ること
  for (const [tag, key] of [['B', SERVICE], ...(SECRET ? [['C', SECRET]] : [])]) {
    const b1 = await call('POST', '/auth/v1/token?grant_type=password', { key, body: { email: u1.email, password: u1.password } });
    rec(`${tag}1 管理者資格 /token(password) トークン無し -> 200 かつ role=authenticated`, b1.status === 200 && decode(b1.json.access_token).role === 'authenticated', { status: b1.status, role: b1.json.access_token && decode(b1.json.access_token).role, aal: b1.json.access_token && decode(b1.json.access_token).aal });
    const b2 = await mailCall(u1.email, () => call('POST', '/auth/v1/otp', { key, body: { email: u1.email, create_user: false } })); rec(`${tag}2 管理者資格 /otp -> 200`, b2.status === 200, b2);
    const es = em(`${tag}s`); const b3 = await mailCall(es, () => call('POST', '/auth/v1/signup', { key, body: { email: es, password: pw() } })); created.push(b3.json.id ?? b3.json.user?.id); rec(`${tag}3 管理者資格 /signup トークン無し -> 200`, b3.status === 200, { status: b3.status, hasSession: Boolean(b3.json.access_token) });
    const b4 = await mailCall(u1.email, () => call('POST', '/auth/v1/recover', { key, body: { email: u1.email } })); rec(`${tag}4 管理者資格 /recover -> 200`, b4.status === 200, b4);
    const b5 = await mailCall(es, () => call('POST', '/auth/v1/resend', { key, body: { email: es, type: 'signup' } })); rec(`${tag}5 管理者資格 /resend -> 200`, b5.status === 200, b5);
  }
  // D. supabase-js が実際に付けるヘッダー（アプリの書き方そのまま）
  const seen = []; const spy = async (input, init) => { seen.push({ path: new globalThis.URL(String(input)).pathname, auth: new Headers(init?.headers).get('authorization'), apikey: new Headers(init?.headers).get('apikey') }); return fetch(input, init); };
  const sj = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: spy } });
  const d1 = await sj.auth.signInWithPassword({ email: u1.email, password: u1.password }); const d2 = await mailCall(u1.email, () => sj.auth.signInWithOtp({ email: u1.email, options: { shouldCreateUser: false } }));
  rec('D supabase-js: signInWithPassword と、その後の signInWithOtp が管理者資格のまま通る', !d1.error && !d2.error && seen.every((s) => s.auth === `Bearer ${SERVICE}`), { d1: d1.error?.code, d2: d2.error?.code, paths: seen.map((s) => s.path), sameAuth: seen.every((s) => s.auth === `Bearer ${SERVICE}`) });
  // E. secure_password_change（24 時間の窓）
  const u2 = await mkUser('e'); const s1 = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: u2.email, password: u2.password, gotrue_meta_security: { captcha_token: DUMMY } } });
  await db.query(`update auth.sessions set created_at = now() - interval '25 hours' where id = $1`, [decode(s1.json.access_token).session_id]);
  const e1 = await call('PUT', '/auth/v1/user', { bearer: s1.json.access_token, body: { password: pw() } }); rec('E1 25 時間前の session・nonce 無し -> 400 reauthentication_needed', e1.status === 400 && /reauth/i.test(`${e1.code} ${e1.msg}`), e1);
  const s2 = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: u2.email, password: u2.password, gotrue_meta_security: { captcha_token: DUMMY } } });
  const e2 = await call('PUT', '/auth/v1/user', { bearer: s2.json.access_token, body: { password: pw() } }); rec('E2 作ったばかりの session・nonce 無し -> 200（24 時間の窓。設定では変えられない）', e2.status === 200, { status: e2.status });
  // F. 管理 API でパスワードを変えた時（アプリの変更・再設定と同じ道）
  const u3 = await mkUser('f'); const f0 = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: u3.email, password: u3.password, gotrue_meta_security: { captcha_token: DUMMY } } });
  const f0b = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: u3.email, password: u3.password, gotrue_meta_security: { captcha_token: DUMMY } } });
  const before = (await db.query('select count(*)::int n from auth.sessions where user_id = $1', [u3.id])).rows[0].n; const mb = (await mails(u3.email)).length;
  const f1 = await call('PUT', `/auth/v1/admin/users/${u3.id}`, { key: SERVICE, body: { password: pw() } }); await new Promise((r) => setTimeout(r, 1500));
  const after = (await db.query('select count(*)::int n from auth.sessions where user_id = $1', [u3.id])).rows[0].n; const ma = (await mails(u3.email)).length;
  rec('F1 admin.updateUserById(password 16+) -> 200', f1.status === 200, { status: f1.status });
  rec('F2 他の session が消えるか（記録）', true, { sessionsBefore: before, sessionsAfter: after });
  rec('F3 GoTrue の変更通知が管理 API の変更でも送られるか（記録。ruling 9）', true, { mailsBefore: mb, mailsAfter: ma, subjects: (await mails(u3.email)).map((m) => m.Subject).slice(0, 5) });
  // G. 管理 API が最小長 16 を強制するか
  const g1 = await call('PUT', `/auth/v1/admin/users/${u3.id}`, { key: SERVICE, body: { password: 'Abcdefgh1234!xy' } }); rec('G1 admin.updateUserById(15 文字)（記録。強制なら 422）', true, { status: g1.status, code: g1.code });
  const g2 = await call('POST', '/auth/v1/admin/users', { key: SERVICE, body: { email: em('g'), password: 'Abcdefgh1234!xy', email_confirm: true } }); if (g2.json.id) created.push(g2.json.id); rec('G2 admin.createUser(15 文字)（記録。強制なら 422）', true, { status: g2.status, code: g2.code });
  // H. 確認メール必須・TOTP・設定の公開値
  const h1 = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: e3, password: 'x', gotrue_meta_security: { captcha_token: DUMMY } } }); rec('H1 未確認の会員のログイン -> 400（email_not_confirmed か invalid）（記録）', true, { status: h1.status, code: h1.code });
  const i1 = await call('POST', '/auth/v1/factors', { bearer: a8.json.access_token, body: { factor_type: 'totp', friendly_name: 'w6' } }); rec('I TOTP の登録 -> 200（enroll_enabled）', i1.status === 200, { status: i1.status, code: i1.code });
  const st = await (await fetch(`${URL_}/auth/v1/settings`, { headers: { apikey: ANON } })).json(); rec('J /settings: mailer_autoconfirm=false', st.mailer_autoconfirm === false, { autoconfirm: st.mailer_autoconfirm });
  out.gate = ['A1', 'A4', 'A5', 'A8', 'A9', 'B1', 'B2', 'B3', 'D'].map((p) => Object.entries(out.results).find(([k]) => k.startsWith(`${p} `) || k.startsWith(`${p}1`) )).filter(Boolean).every(([, v]) => v.ok);
  out.failed = Object.entries(out.results).filter(([, v]) => !v.ok).map(([k]) => k);
  console.log(JSON.stringify(out, null, 2)); process.exitCode = out.failed.length ? 1 : 0;
} finally {
  for (const id of created.filter(Boolean)) await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } }).catch(() => undefined);
  await db.end();
}
```

- [ ] **Step 3: 判定。** **GATE（崩れたら止めて controller に戻す。コードは書かない）**: A1・A4・A5（anon はトークン無しで 400）、A8・A9（ダミー付き・refresh は通る）、B1・B2・B3（JWT の service role はトークン無しで通る。B1 の `role` が `authenticated`）、D（supabase-js が管理者資格のまま `signInWithPassword` と `signInWithOtp` を通す）。`out.failed` が空であること。**GoTrue が 429（`over_email_send_rate_limit`）を返した項目は captcha の失敗ではなく間隔の不足**なので、`mailCall` の抜け（メールを出す呼び出しを通していない）を直して流し直す（STOP にしない）。**C（`sb_secret_`）は手元の CLI が出さなければ「手元では測れない」と記録して通す**（本番での確かめは Task 11 段階 B の直後。ruling 10 の代案を控えておく）。出るなら必ず通ること。**記録して後続に渡す物**: F2（管理 API の変更で他の session が消えるか）、F3（変更通知が送られるか→ ruling 9）、G1・G2（最小長を管理 API が強制するか→ Task 8 Step 3）、E1・E2（`secure_password_change` の挙動が調査どおりか）、H1（未確認の会員のログインの誤りの符号）、I（TOTP が有効になったこと）。
- [ ] **Step 4: 片付け。** `npx supabase stop --workdir .superpowers/sdd/2026-10-25-security-gap-fixes/wave6-sandbox --no-backup`。置き場はコミットしない（`.superpowers/` は未追跡）。結果を `wave6-task0-report.md` に書く。G-1 に「隔離スタックは止めた。主のスタックには触っていない」と知らせる。

---

## Task 1: `APP_ALLOWED_ORIGINS` が無い本番のビルドを落とす（独立・最初に入れる）

**範囲:** `src/lib/build-env-guard.ts` の必須の一覧に `APP_ALLOWED_ORIGINS` を足す。`proxy.ts`・`redirect.ts` は変えない（P20）。

**Files:**

- Modify: `src/lib/build-env-guard.ts`（`:7` の `REQUIRED_IN_PRODUCTION` に `'APP_ALLOWED_ORIGINS'`。TSDoc の `@remarks` に「許可オリジンが無いと proxy が要求由来の値で比べる退避に倒れる。本番で退避は使わせない」と、変数名だけを出す理由を足す）、`tests/unit/lib/build-env-guard.test.ts`、`.env.example`（`APP_ALLOWED_ORIGINS=` の行と、本番で必須の注記）
- Docs: `docs/02_Requirements/areas/about.md`（`SEC-ABOUT-007-AC-02` を足す。`:59` の文の「環境変数を外してビルドし直した状態」に `APP_ALLOWED_ORIGINS` も含むと直す）、`docs/04_DetailDesign/pages/08_about.md`（`DD-ABOUT-002` の説明）、`docs/05_Quality/security/threats/about.md` の関連行。`SEC-LOOK-018`（`look.md:4426`）の本文の「本番の設定」に `SEC-ABOUT-007-AC-02` を指す一文を足す（`look.md` は NEWS 同様 LOOK の持ち物なので、足すのは 1 文だけ）。`docs/06_Operations/secrets.md:140-153` は Task 9 で書く

**Interfaces:**

```ts
// build-env-guard.ts（シグネチャは変えない）
const REQUIRED_IN_PRODUCTION = ['NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'APP_ALLOWED_ORIGINS'] as const;
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P20 を目で確かめる。`tests/unit/next-config.test.ts`（`next.config.ts` が `assertBuildEnv(process.env)` を先頭で呼ぶことの確かめ）が必須の一覧を固定していないか読む。`PRODUCTION` の定数（`build-env-guard.test.ts:9-13`）に `APP_ALLOWED_ORIGINS` を足さないと、既存の「通る」の試験が落ちる。
- [ ] **Step 2（RED）: 単体を書く**（先頭 `DD-ABOUT-002`）。①`PRODUCTION` に `APP_ALLOWED_ORIGINS: "https://shop.example.com"` を足して「通る」、②無い／空白だけで変数名を名指しして落ちる、③落とす時の文に値を載せない（値は短い別のドメイン文字列で確かめる）、④`VERCEL_ENV` が `preview`・未設定・空なら 3 つとも無くても通る、⑤`NODE_ENV=production` だけでは落とさない（既存）。
- [ ] **Step 3（GREEN）:** 実装する。`tsc`。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/lib/build-env-guard.test.ts tests/unit/next-config.test.ts`。
- [ ] **Step 5: 文書・報告。** `SEC-ABOUT-007-AC-02`。`validate-docs`・`validate-trace -- ABOUT`。共有文書の変更案: 台帳の開店の準備（1 行の「Vercel に `APP_ALLOWED_ORIGINS` も入れる。無いとビルドが落ちる」を順 1 に足す）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 2: captcha を免除される「auth だけ」のクライアントと、4 か所の切り替え

**範囲:** `createServiceRoleAuthClient`（Task 0 の GATE が通ってから dispatch）と、`login`（2 回）・`login/resend`・`register` の 4 呼び出しの切り替え、captcha の拒否を 5xx＋監査にする部品。アプリの Turnstile・順番・枠は**変えない**。`otp/verify`・`confirm`・`oauth/*`・`refresh` は変えない（P2）。

**Files:**

- Create: `src/lib/auth/service-role-auth-client.ts`、`tests/unit/lib/auth/service-role-auth-client.test.ts`
- Modify: `src/app/api/auth/login/route.ts`（`:14` の import、`:50` を `createServiceRoleAuthClient()`、`:52`・`:60` は同じクライアント。`:54-57` の前に captcha の拒否の枝）、`src/app/api/auth/login/resend/route.ts`（`:58-59`）、`src/app/api/auth/register/route.ts`（`:139-140`。`createClient` の import が不要になれば消す）、`src/lib/supabase/server.ts`（コメントだけ。`createPublicClient` の用途〔verifyOtp など免除される窓口〕と、`createServiceRoleClient` の「ユーザー認証には `createPublicClient` を使う」旨のコメント〔`:133-136` 付近〕を、captcha が掛かる窓口は `createServiceRoleAuthClient` を使う、に直す。コードは変えない）、`tests/unit/lib/supabase-client-isolation.test.ts`（auth だけのクライアントの確かめを足す）、P18 の試験（`createPublicClient` を差し替えている 13 ファイルと、登録の `signUp` を差し替えている 8 ファイル）、`scripts/trace/scope.json`
- Docs: `docs/03_BasicDesign/decisions/ADR-0420-auth-supabase-captcha-with-service-role-auth-calls.md`（新規。背景: anon の鍵が公開で、アプリを通らない直接の呼び出しでアプリの Turnstile・回数・漏洩確認が飛ばされる／決定: 案 (b')／退けた案: (a) 先送り（直接の総当たり・メール枠の使い切りが残る）・(b) トークン転送（2 回呼び・再送・順番が崩れる）・(c) 公開サインアップ停止＋`generateLink`（ログイン側が残る・Google の新規が止まる）・(d) `before_user_created` フック（見分ける材料が無い）／結果: 直接の呼び出しはトークン無しなら 400、アプリは管理者資格／見直す条件: GoTrue が管理者の免除をやめたら（Task 11 の確かめが崩れたら）(c) に倒す。**公式の文書に無い挙動に頼る**ので、E2E が毎回確かめる〔`SEC-AUTH-015-AC-04`〕）、`docs/04_DetailDesign/pages/14_login.md` に `DD-AUTH-040`、`docs/02_Requirements/areas/auth.md` に `SEC-AUTH-035`・AC-01／02

**Interfaces:**

```ts
// src/lib/auth/service-role-auth-client.ts（@impl IMPL-AUTH-228・@design DD-AUTH-040）
import type { SupabaseClient } from '@supabase/supabase-js';

/** auth だけを持つ。`.from()`・`.rpc()`・`.storage` を型にも実体にも持たない（P3）。 */
export type ServiceRoleAuthClient = Pick<SupabaseClient, 'auth'>;

/**
 * 毎回新しく作る。SUPABASE_URL（無ければ NEXT_PUBLIC_SUPABASE_URL）と SUPABASE_SERVICE_ROLE_KEY が無ければ throw（createServiceRoleClient と同じ文）。
 * createClient の auth オプションは `{ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }` に固定する
 * （サーバーで更新のタイマーを起こさない・URL を読まない・session を保存しない。`createServiceRoleClient` の既存の固定と同じ）。
 */
export async function createServiceRoleAuthClient(): Promise<ServiceRoleAuthClient>;

/** Supabase の captcha が断った誤りか。code === 'captcha_failed'、または status === 400 かつ message に captcha を含む。 */
export function isCaptchaRejection(error: { code?: string; status?: number; message?: string } | null | undefined): boolean;
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P1・P2・P3・P5・P6・P18 を `server.ts:117-152`・各 route の行・`supabase-client-isolation.test.ts` で確かめる。P18 の各試験が `createPublicClient`／`createClient` のモックで何を固定しているかを `grep -n "createPublicClient\|createClient\|toHaveBeenCalledWith" <file>` で表にして報告の冒頭に置く（`signInWithPassword` の引数が `{ email, password }` で変わらないこと。`signUp` の引数が変わらないこと）。
- [ ] **Step 2（RED）: 単体を書く**（先頭 `DD-AUTH-040`）。`service-role-auth-client.test.ts`: ①返り値に `from`・`rpc`・`storage` が無い（`'from' in client === false`）、②2 回呼ぶと別のオブジェクト、③URL か鍵が無いと throw（鍵の値を文に載せない）、③b `@supabase/supabase-js` の `createClient` をモックし、渡された `options.auth` が `persistSession === false`・`autoRefreshToken === false`・`detectSessionInUrl === false` の 3 つとも（更新のタイマーを起こさない）、④`fetch` を差し替えて `auth.signInWithPassword` → `auth.signInWithOtp` を続けて呼ぶと、**両方の要求**の `authorization` が `Bearer <サービスの鍵>`・`apikey` が同じ（Review Focus 1）、⑤`isCaptchaRejection` の表（`{code:'captcha_failed'}` 真、`{status:400, message:'captcha protection: request disallowed (no captcha_token found)'}` 真、`{status:400, message:'Invalid login credentials'}` 偽、`null` 偽）。`supabase-client-isolation.test.ts` に、`createServiceRoleAuthClient` の後で `createServiceRoleClient` の DB 要求が引き続き `Bearer fake-service-key` であること（混ざらない）を足す。route の単体（`login-route`・`login-resend-route`・`register-route`）: ⑥`signInWithPassword` が `captcha_failed` なら**500**・本文 `Internal server error`・監査 `outcome: 'error'`・`detail: 'supabase_captcha_rejected'`（email は監査の `actor_email` に出すが、誤りの本文は残さない）で、401 にならない。⑦ログインの `signInWithOtp`・再送の `signInWithOtp` も同じ。⑧登録の `signUp` が `captcha_failed` なら 500 `Failed to create user`（`already`／`duplicate` の枝に入らない）・監査 `supabase_captcha_rejected`。⑨通常の誤りは今までどおり（`Invalid login credentials` は 401 など）。⑩どの route も `createPublicClient` を呼ばない（login・resend）。
- [ ] **Step 3（GREEN）:** 実装する。`login/route.ts` は `const supabase = await createServiceRoleAuthClient();` に替えるだけで、Turnstile・枠・順番のコードに触らない。captcha の拒否の枝は `signInWithPassword` の直後・`signInWithOtp` の直後に置く。`register/route.ts` は `:139` の `createClient()` を `createServiceRoleAuthClient()` に替え、`data.session` の分岐（Confirm email が OFF の時だけ）は変えない（`createClient` の import が他に使われていなければ消す＝自分が作った孤児）。3 つの route と `server.ts` の `createPublicClient` のコメントの `@remarks` を今の動きに直す（`login/route.ts` の「匿名クライアントでパスワード検証のみ」のコメント `:49`、`createPublicClient` の用途〔verifyOtp など免除される窓口〕）。`tsc`。
- [ ] **Step 4: 試験の追従。** P18 の 21 ファイルのモックを、`jest.mock('@/lib/auth/service-role-auth-client', …)`（`createServiceRoleAuthClient`）に替える。`otp-verify`・`confirm`・`wishlist`・`look`・`news`・`stockist` 系の `createPublicClient` のモックは**そのまま**。
- [ ] **Step 5: 対象の `jest`。** `npx jest tests/unit/lib/auth tests/unit/lib/supabase-client-isolation.test.ts tests/unit/api/auth tests/integration/api/auth tests/integration/api/auth-architecture.test.ts tests/integration/api/auth-bot-rate-limit.test.ts tests/integration/api/auth-cookie-data.test.ts tests/integration/api/auth-login-api.test.ts tests/integration/api/auth-login-pending-state.test.ts tests/integration/api/auth-login-resend-api.test.ts tests/integration/api/auth-login-two-step.test.ts tests/integration/api/auth-password-rule.test.ts tests/integration/api/auth.test.ts tests/integration/auth-flow.test.ts tests/integration/ui/auth-register-flow.test.tsx`。
- [ ] **Step 6: 文書・報告。** ADR-0420、`14_login.md` の `DD-AUTH-040`、`scope.json`（AUTH の `src` に `src/lib/auth/service-role-auth-client.ts`、`tests` に `tests/unit/lib/auth/service-role-auth-client.test.ts` は `tests/unit/lib/auth/app-session.test.ts` の隣）。`validate-docs`・`validate-trace -- AUTH`。共有文書の変更案: なし（`api-spec.md` の窓口の仕様は変わらない）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 3: E2E・DB 結合の補助にダミーの `captcha_token` を足す（captcha が切れていても害が無い）

**範囲:** P17 の 12 ファイル＋ DB 結合 3 ファイル。**`FR-LOGIN-031:607`（`/signup`）は Task 8 で書き換えるのでここでは触らない**。

**Files:**

- Create: `e2e/captcha-test-utils.ts`
- Modify（E2E 12）: `e2e/admin-session-test-utils.ts:78`、`e2e/FR-LOGIN-031-supabase-direct-bypass.spec.ts:114,182`、`e2e/FR-LOGIN-032-admin-totp-aal2.spec.ts:437`、`e2e/FR-LOOK-SEC-002-postgrest-policies.spec.ts:191`、`e2e/FR-NEWS-SEC-002-direct-db-access.spec.ts:195`、`e2e/FR-PRIVACY-007-settings-postgrest-access.spec.ts:64`、`e2e/FR-SEARCH-020-search-db-function-grants.spec.ts:90`、`e2e/FR-STOCKIST-012-public-screens-with-seeded-rows.spec.ts:47`、`e2e/FR-STOCKIST-014-admin-api-authn-authz-csrf.spec.ts:183`、`e2e/FR-STOCKIST-016-direct-db-access-and-session.spec.ts:154`、`e2e/home-grant-test-utils.ts:130`、`e2e/news-test-utils.ts:169`
- Modify（DB 結合 3）: `tests/integration/db/group_g3_postgrest_paths.integration.test.ts:72`、`group_g4_postgrest_paths.integration.test.ts:58`、`order_status_postgrest.integration.test.ts:185`
- Test: `tests/unit/e2e/captcha-test-utils.test.ts`（補助の単体。`tests/unit/` に `e2e` のディレクトリが既にあれば合わせる）

**Interfaces:**

```ts
// e2e/captcha-test-utils.ts
/** Cloudflare の公開のテスト用トークン。テスト用の secret（1x…AA）の検証を常に通る。本番の secret は拒む */
export const DUMMY_CAPTCHA_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
/** 生の fetch の本文に足す。supabase-js なら options: { captchaToken: DUMMY_CAPTCHA_TOKEN } */
export function withDummyCaptcha<T extends Record<string, unknown>>(body: T): T & { gotrue_meta_security: { captcha_token: string } };
```

- [ ] **Step 1: 現状の確認（読むだけ）。** P17 の行を 1 つずつ開き、`grant_type=password`／`/otp` の呼び出しだけを対象にする（`refresh_token`・`/verify`・`/logout`・`admin` は付けない）。`admin-session-test-utils.ts:78` の `requestToken(env, grantType, body)` は `grantType === 'password'` の時だけ本文に足す。`createClient(url, anon, …).auth.signInWithPassword({ email, password })` は `{ email, password, options: { captchaToken: DUMMY_CAPTCHA_TOKEN } }` に。
- [ ] **Step 2（RED）: 補助の単体を書く**（先頭 `DD-AUTH-040`）: `withDummyCaptcha` が元の本文を保ち `gotrue_meta_security.captcha_token` を足す、元のオブジェクトを書き換えない。
- [ ] **Step 3（GREEN）:** 補助を作り、15 ファイルを直す。一括置換（`sed -i`）は使わず Edit で。`tsc`。
- [ ] **Step 4: 洗い出し。** `grep -rnE "auth/v1/(token\?grant_type=password|otp|signup|recover|resend|magiclink)|signInWithPassword|signInWithOtp|auth\.signUp" e2e tests/integration/db` を流し、全件が（a）今回直した、（b）免除（refresh・verify・admin）、（c）Task 8 が書き換える `FR-LOGIN-031:607`、のどれかに分類できること。分類の表を報告に置く。Task 2 で移した `createPublicClient` を使う route のモック（Jest）は E2E ではないのでここでは数えない。
- [ ] **Step 5: 対象の `jest`。** `npx jest tests/unit/e2e`（補助の単体）と `npx tsc --noEmit`。E2E と DB 結合は流さない。
- [ ] **Step 6: 報告。** 直したファイルの表。controller が最後に流す候補（Task 10）: 12 ファイルの spec を `--grep` で 1 本ずつ。

**検証コマンド:** `npx tsc --noEmit`、`npx jest tests/unit/e2e`。

---

## Task 4: 移行 M3（パスワード変更の確認コードの表と関数）

**範囲:** `supabase/pending-wave6/20261101120000_sec_password_change_challenges.sql`。アプリは呼ばない（Task 5 が呼ぶ）。**実装者は `pending-wave6/` に書くところまで**。`supabase/migrations/` へ動かして当てるのは Task 10（手元）・Task 11（本番）。

**Files:**

- Create: `supabase/pending-wave6/20261101120000_sec_password_change_challenges.sql`、`tests/unit/migrations/sec-password-change-challenges.test.ts`、`tests/integration/db/auth_password_change_challenges.integration.test.ts`（書くだけ）
- Modify: `tests/integration/db/auth_grants_inventory.integration.test.ts`（`FUNCTION_EXPECTATIONS` に 2 関数。`anon: false, authenticated: false, postgres: true`、service_role 可。表の一覧が別にあれば表も足す）
- Docs: `docs/03_BasicDesign/areas/auth.md`（`DATA-AUTH-009`・`010`）、`docs/03_BasicDesign/decisions/ADR-0421` の背景の「表に保存する理由」（Task 5 の ADR と同じファイル。ここでは下書きの節だけ）

**Interfaces（SQL）:**

```sql
-- BEGIN/COMMIT 各 1 組。末尾の自己検査は SEC_WAVE6_MIGRATION_ASSERTION_FAILED（55000）。NOTIFY pgrst, 'reload schema' 1 回。ヘッダーに ROLLBACK と本番の事前の読み取り
CREATE TABLE public.password_change_challenges (                                  -- 表は冪等にしない
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  auth_session_id uuid NOT NULL,                                                   -- 要求した時の GoTrue の session。別の session では使えない
  code_hash text NOT NULL,                                                         -- HMAC-SHA256(JWT_SECRET, 'password_change:' || user_id || ':' || auth_session_id || ':' || code) の hex 64 桁（アプリが作る）。平文のコードを置かない。鍵無しの sha256 は 10^8 通りで逆算できるので使わない
  attempts smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_change_challenges_open_idx ON public.password_change_challenges (user_id) WHERE used_at IS NULL;
ALTER TABLE public.password_change_challenges ENABLE ROW LEVEL SECURITY;
-- anon・authenticated の全拒否の方針（password_reset_tokens と同じ形）と、REVOKE ALL FROM PUBLIC, anon, authenticated。GRANT SELECT, INSERT, UPDATE, DELETE TO service_role

CREATE OR REPLACE FUNCTION public.issue_password_change_challenge(p_user_id uuid, p_auth_session_id uuid, p_code_hash text, p_ttl_seconds integer)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ ... $$;
  -- 同じ利用者の未使用の行を全部 used_at = now() にし、1 日より古い行を消し、新しい行を入れて id を返す（1 つの取引）。p_ttl_seconds は 60..900 に制限
CREATE OR REPLACE FUNCTION public.consume_password_change_challenge(p_user_id uuid, p_auth_session_id uuid, p_code_hash text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ ... $$;
  -- 返り値: 'ok'（used_at を立てた）／'invalid'（コードが違う。attempts + 1 を同じ文で行う）／'locked'（attempts >= 5）／'none'（未使用の有効な行が無い・期限切れ・別の session）
  -- 行の取得は SELECT … FOR UPDATE（または UPDATE … RETURNING の 1 文）で、並列の推測でも 5 回を超えない
-- 関数: REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `password_reset_tokens` の定義（`remote_schema.sql:759-770,2707,2860-2864,3661-3667`）と全拒否の方針の書き方、`sec_grants_hardening.sql` の GRANT の書式、`db-migrations.md` の「以後の移行は GRANT を明示する」「冪等にする／しない」を読む。`ls supabase/migrations | tail -3`（今の最後は `20261029130600`。M3 の時刻は暫定で、Task 10 で動かす時に最後の移行より後に付け直す）。本番の事前の読み取り（controller が Task 11 で再取得する手順としてヘッダーに書く）: `schema_migrations` の最後、`select to_regclass('public.password_change_challenges')` が null。
- [ ] **Step 2（RED）: 試験を書く。** 単体 `sec-password-change-challenges.test.ts`（先頭 `DATA-AUTH-009`）: ファイルが `supabase/{pending-wave6,migrations}` のどちらかに在る、`BEGIN`/`COMMIT` が各 1 組、`CREATE TABLE`（`IF NOT EXISTS` なし）、`user_id` が `auth.users` を指す外部キー（`ON DELETE CASCADE`）、`ENABLE ROW LEVEL SECURITY`、2 関数が `CREATE OR REPLACE FUNCTION` かつ `SECURITY DEFINER` かつ `SET search_path = ''` かつ `REVOKE ALL … FROM PUBLIC`、`GRANT EXECUTE … TO service_role`、`anon`・`authenticated` に GRANT しない、`ALTER DEFAULT PRIVILEGES` を使わない、`ROLLBACK` のコメントを持つ。DB 結合 `auth_password_change_challenges.integration.test.ts`（`describeLocalDb`・`begin`/`rollback` で包む。`auth.users` の行は先に入れる）: Review Focus 4 の入力を全部。①`issue` が id を返し、2 回目の `issue` で 1 回目が無効（`consume` が `none`）、②正しいコードで `ok`、2 回目は `none`、③違うコードで `invalid`、5 回違うと次は正しいコードでも `locked`、④別の `p_auth_session_id` は `none`（`attempts` も増えない）、⑤期限切れ（`expires_at` を過去にする）は `none`、⑥`p_ttl_seconds` が範囲外なら例外、⑦anon・authenticated は表も関数も `42501`、service_role は呼べる、⑧列に平文のコードが無い（`code_hash` が 64 桁の hex の形で、入れた平文の 8 桁を含まない）、⑨`auth.users` の削除で行が消える。
- [ ] **Step 3（GREEN）:** 移行を書く。末尾の自己検査（`DETAIL` に項目名）: 列の型と NOT NULL、部分索引、RLS が有効、2 関数の `prosecdef`・`proconfig`（`search_path=""`）・`has_function_privilege`（anon・authenticated は偽、service_role は真）。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/migrations/sec-password-change-challenges.test.ts`。`security-definer-search-path-guard.test.ts` は `pending-wave6/` を見ないので Task 10 で動かした後に通ること（報告に書く）。DB 結合は流さない。
- [ ] **Step 5: 文書・報告。** `DATA-AUTH-009`・`010`。`validate-docs`・`validate-trace -- AUTH`。共有文書の変更案（`db-migrations.md` の節の素案: 表・関数・自己検査・適用の順序〔本番は Task 5 の画面を動かす前〕・ロールバック）を報告に。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 5: パスワード変更のサーバー（開始・確認・失効・通知・回数・監査）

**範囲:** 2 つの窓口と、それを支える部品。M3（Task 4）が手元と本番に当たるまで、実 DB の動作は確かめられない（単体・結合のモックで進める）。

**Files:**

- Create: `src/features/auth/schemas/password-change.ts`、`src/features/auth/services/password-change.ts`、`src/app/api/auth/password/change/start/route.ts`、`src/app/api/auth/password/change/confirm/route.ts`、`tests/unit/features/auth/password-change-schema.test.ts`、`tests/unit/features/auth/password-change-service.test.ts`、`tests/unit/api/auth/password-change-start-route.test.ts`、`tests/unit/api/auth/password-change-confirm-route.test.ts`
- Modify: `scripts/trace/scope.json`
- Docs: `docs/03_BasicDesign/decisions/ADR-0421-auth-password-change-app-route-with-emailed-code.md`（新規。背景: GoTrue の `secure_password_change` は 24 時間以内の session を再認証なしで許し、窓は設定で変えられない／決定: アプリの窓口〔現行パスワード＋アプリが送るコード＋全 session 失効＋通知＋回数〕＋ GoTrue の「現行パスワードを要求」＋変更通知＋最小長 16／退けた案: GoTrue の `reauthenticate()`〔nonce が 24 時間以内の session では検証されず毎回必須にできない〕・コードを署名つき Cookie にだけ持つ案〔単回使用・試行回数・「最新のコードだけ有効」が保てない〕・DB のトリガーで `encrypted_password` の直接の変更を拒む案〔GoTrue がログイン時にハッシュを書き換えるとログインを壊す〕／結果: 残る危険は「現行パスワードを知る人が GoTrue を直に叩いて変える」だけで、ログインにメールのコードが要るので実害は小さい〔調査 §2-7〕／ NIST 5.2・ASVS V3.3.3〔全 session を止める〕・V2.2.3〔通知〕）、`docs/04_DetailDesign/pages/14_login.md` に `DD-AUTH-041`、`docs/03_BasicDesign/areas/auth.md`（API の 2 本・認証の流れ）

**Interfaces:**

```ts
// schemas/password-change.ts
export const PasswordChangeStartSchema = z.object({ current_password: z.string().min(1).max(128) });
export const PasswordChangeConfirmSchema = z.object({ code: z.string().regex(/^\d{8}$/), new_password: passwordSchema });  // passwordSchema は common.ts（16..128 文字）

// services/password-change.ts（@impl IMPL-AUTH-229・@design DD-AUTH-041）
export const PASSWORD_CHANGE_CODE_TTL_SECONDS = 600;
export const PASSWORD_CHANGE_MAX_ATTEMPTS = 5; // DB の consume と同じ値。変えるなら移行も
/** 8 桁（crypto.randomInt(0, 1e8) を左 0 埋め）。 */
export function generatePasswordChangeCode(): string;
/**
 * HMAC-SHA256 の hex。鍵はサーバーの秘密 `JWT_SECRET`（`login-2fa-session`・`password-reset-session` と同じ。新しい環境変数は作らない。無ければ throw）、
 * 入力は 'password_change:' + userId + ':' + authSessionId + ':' + code。
 * 鍵無しの sha256 にしない: コードは 10^8 通りしかなく、行が漏れると数秒で逆算できる。
 */
export function hashPasswordChangeCode(input: { userId: string; authSessionId: string; code: string }): string;
/**
 * `start` の⑨（メールが送れなかった）で、発行したコードを無効にする。service role の `createServiceRoleClient()` で
 * `.from('password_change_challenges').update({ used_at: new Date().toISOString() }).eq('id', challengeId).is('used_at', null)`（M3 の表の GRANT UPDATE TO service_role を使う。新しい関数は作らない）。
 * 失敗しても例外にせず（メールの失敗の 500 を隠さない）、監査 `mail_failed` の detail に `challenge_void_failed` を足す。
 */
export function voidPasswordChangeChallenge(challengeId: string): Promise<boolean>;
export type CurrentPasswordResult = { ok: true } | { ok: false; reason: 'invalid' | 'captcha_rejected' | 'unavailable' };
/** createServiceRoleAuthClient で signInWithPassword し、成功したら作られた GoTrue の session を revoke_auth_session で消す（P5）。失敗の本文は返さない。 */
export function verifyCurrentPassword(email: string, password: string): Promise<CurrentPasswordResult>;
/** コードのメール。本文はコードと有効期限（10 分）と「心当たりがなければパスワードを変えず、すぐにお問い合わせ」。パスワードは入れない。 */
export function sendPasswordChangeCodeMail(to: string, code: string): Promise<void>;
export function sendPasswordChangedNotice(to: string): Promise<void>; // 再設定の確定と同じ文面を共通にしてよい（件名「パスワードを変更しました」）
```

窓口の順序（どちらも `export async function POST(request: Request)`。`/api/auth` なので proxy が `no-store` を付ける＝自分で足さない。P14）:

- **start**: ①IP の枠（`auth:password_change_start`・20 回／10 分）→ ②`authenticateRequest(request)`（失敗は `authFailureResponse`）→ ③`requireCsrfOrDeny()`（`profile/route.ts` と同じく、監査の行を書く前に置く。別のサイトからの要求が拒否の監査の行を増やせないように）→ ④役割が admin／supporter で `claims.aal !== 'aal2'` なら 403・監査 `denied`・`aal2_required`（Review Focus 7）→ ⑤本人ごとの枠（`subject: claims.sub`・5 回／10 分）→ ⑥本文の検証（400）→ ⑦`verifyCurrentPassword(claims.email, current_password)`: `invalid` は 401 `{ error: '現行のパスワードが正しくありません。' }`・監査 `failure`・`current_password_invalid`／`captcha_rejected` は 500・監査 `supabase_captcha_rejected`／`unavailable` は 503 → ⑧コードを作り `issue_password_change_challenge`（`claims.session_id` がなければ 401。波 5 により必ずある）→ ⑨`sendPasswordChangeCodeMail`（`await`。失敗は 500・監査 `mail_failed`。送れていないのにコードを有効にしない＝失敗したら `voidPasswordChangeChallenge(challengeId)` で `used_at` を立てる）→ ⑩200 `{ ok: true }`・監査 `success`・`code_sent`。
- **confirm**: ①IP の枠（`auth:password_change_confirm`・20 回／10 分）→ ②`authenticateRequest` → ③`requireCsrfOrDeny()` → ④aal2 の確かめ → ⑤本人ごとの枠（5 回／10 分）→ ⑥本文の検証（`code` は 8 桁の数字、`new_password` は 16〜128 文字）→ ⑦**コードを使う前に**漏洩確認 `checkPwnedPassword`（`pwned` は 400 `PWNED_PASSWORD_MESSAGE`・監査 `pwned_password`。`unavailable` は通して監査 `pwned_check_unavailable:<reason>`）。**「新パスワードが現行と同じ」の確かめは置かない**（ハッシュは GoTrue の中なので比べるには `verifyCurrentPassword(email, new_password)` を呼ぶしかなく、コードも先の `start` も要らない `confirm` が現行パスワードの当否を明かす総当たりの窓口になる〔`same_password` の 400 が「今のパスワードだ」と教える。盗んだ session の持ち主の試行が `start` の 5 回に `confirm` の 5 回を足して倍になり、先頭の「2 段目で現行パスワードの当否を明かさない」にも反する〕。ASVS 4.0.3・NIST 800-63B-4 は「現行と同じ」の拒否を要求しない）→ ⑧`consume_password_change_challenge`: `ok` 以外は `invalid` 401 `code_invalid`・`locked`／`none` 401 `code_locked`（文は「確認コードが正しくないか、期限が切れています。もう一度コードを送ってください。」で `invalid`・`locked`・`none` を同じ文にする）→ ⑨`admin.updateUserById(claims.sub, { password: new_password })`（失敗は 500・監査 `update_failed`）→ ⑩`revokeAllSessionsForUser(claims.sub)`（throw は握って 200 のまま監査 `revoke_failed`）→ ⑪応答で認証 Cookie（アクセス・リフレッシュ・CSRF）を消す（`password-reset/confirm/route.ts:164-171` と同じ）→ ⑫`after()` で通知のメール → ⑬監査 `success` → 200 `{ ok: true }`。

- [ ] **Step 1: 現状の確認（読むだけ）。** P5・P13・P14・P15 を `password-reset/confirm/route.ts`・`profile/route.ts:226-243`・`revoke-user-sessions.ts`・`rateLimit.ts`・`logout/route.ts:50` で確かめる。`claims.email` が `JwtPayload` に在ること、役割の読み方（`enroll-totp/route.ts:62-70` の `isUserRole`）、`PWNED_PASSWORD_MESSAGE` の場所（`@/lib/pwned-password`）、`logAudit` の `action` の形（他の `action` と重ならない `password_change`）を読む。
- [ ] **Step 2（RED）: 単体を書く**（先頭 `DD-AUTH-041`）。スキーマ: コードが 7 桁・9 桁・英字入りで断る、15 文字の新パスワードで断る、128 文字で通り 129 文字で断る。サービス: ①コードは 8 桁の数字で、1000 回作って全部 8 桁（先頭 0 を保つ）、②ハッシュは用途で変わる（別の `authSessionId`・別の `userId` で別の値）かつ**鍵つき**（`JWT_SECRET` を替えると別の値・同じ入力の素の sha256 と一致しない・`JWT_SECRET` が無いと throw）、②b `voidPasswordChangeChallenge` が `used_at` を立てる更新を `.is('used_at', null)` つきで 1 回呼び、更新の失敗でも throw しない、③`verifyCurrentPassword`: `signInWithPassword` が成功すると `revoke_auth_session` を session の id（`readAuthSessionId`）で呼ぶ、`invalid_credentials` → `invalid`、`captcha_failed` → `captcha_rejected`、ネットワークの失敗 → `unavailable`、誤りの本文を返さない、④メールの本文にコードと「10 分」があり、パスワードを含まない。窓口 start/confirm（`authenticateRequest`・`createServiceRoleClient`・`createServiceRoleAuthClient`・`enforceRateLimit`・`sendMail`・`logAudit` をモック）: 上の順序の各段の失敗の応答と**呼ばれない物**（例: 枠が 429 なら `verifyCurrentPassword` を呼ばない／ **`confirm` は `verifyCurrentPassword`・`createServiceRoleAuthClient` を一度も呼ばない**〔現行パスワードの当否を明かさない〕／ **CSRF が拒否なら `logAudit` を呼ばない**〔aal1 の管理者への要求でも〕／ aal1 の管理者は `verifyCurrentPassword` を呼ばない／現行パスワードが違うと `issue` を呼ばない・メールを送らない／コードが違うと `updateUserById` を呼ばない／弱い新パスワードで `consume` を呼ばない）、成功で `updateUserById`→`revokeAllSessionsForUser`→Cookie 削除の 3 つの `Set-Cookie`（Max-Age=0）→通知メールの順、監査の `detail` が固定の符号だけでパスワード・コード・トークン・`session_id` の値を含まない（JSON 化した監査の引数を文字列にして、入力した値が現れないことを確かめる）。
- [ ] **Step 3（GREEN）:** 実装する。`tsc`。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/unit/features/auth tests/unit/api/auth/password-change-start-route.test.ts tests/unit/api/auth/password-change-confirm-route.test.ts`。
- [ ] **Step 5: 文書・報告。** ADR-0421、`DD-AUTH-041`、`scope.json`（AUTH の `src` は `src/app/api/auth/**/*.ts`・`src/features/auth/…` の個別追加が要るか確かめる。`src/features/auth/services/password-change.ts` と `schemas/password-change.ts` を足す。`tests` に `tests/unit/features/auth/password-change*.test.ts`〔既存の `tests/unit/api/auth/**` は届く〕）。`validate-docs`・`validate-trace -- AUTH`。共有文書の変更案: `api-spec.md`／`route-inventory.md`（2 窓口。Route Handler は今 166 ファイル・210 メソッド、表は 165 行・209 メソッド→ 168／212、167／211 になる見込み。controller が最後に数え直す）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 6: パスワード変更の画面

**範囲:** `/account/password` の画面とプロフィールからのリンク。見た目は既存の会員ページの部品（`TextField`・`Button`・`LiveMessage`）を使い、新しい意匠を作らない。

**Files:**

- Create: `src/app/account/password/page.tsx`、`src/app/account/password/PasswordChangeForm.tsx`、`tests/integration/ui/auth-password-change.test.tsx`
- Modify: `src/app/account/page.tsx`（プロフィールの欄に「パスワードを変更」のリンクを 1 つ。`Link href="/account/password"`。**他は触らない**）、`scripts/trace/scope.json`（AUTH の `src` に `src/app/account/password/**/*.{ts,tsx}`、`tests` は `tests/integration/ui/auth-*.test.{ts,tsx}` で届く）
- Docs: `docs/04_DetailDesign/pages/14_login.md` に `DD-AUTH-042`、`docs/03_BasicDesign/areas/auth.md`（画面 `SCR-AUTH-0xx`・遷移 `FLOW-AUTH-0xx` の項目）

**Interfaces:**

```tsx
// PasswordChangeForm.tsx（@impl IMPL-AUTH-232・@design DD-AUTH-042）。'use client'
// 段階 1「現行のパスワード」: current_password の入力と「確認コードをメールに送る」。POST /api/auth/password/change/start（clientFetch）
//   入力欄の下に固定の案内（誰にでも出す。会員がパスワードを持つかを明かさない）: 「Google でログインしていてパスワードを設定していない場合は、先にパスワードの再設定からパスワードを設定してください。」＋ Link href="/auth/password-reset"（FR-AUTH-006-AC-07。Google だけで登録した会員はパスワードを持たず、start は必ず 401 になるため、行き止まりにしない）
// 段階 2「確認コードと新しいパスワード」: 8 桁のコード（inputMode=numeric・autocomplete=one-time-code）、新しいパスワード、確認の入力。16 文字以上・一致をクライアントで先に確かめ、POST /api/auth/password/change/confirm
// 成功: 「パスワードを変更しました。全ての端末からログアウトしました。新しいパスワードでログインしてください。」を LiveMessage で出し、/login へ（router.replace('/login')）
// 401（未ログイン）: useLoginHref の形で /login?next=/account/password へ。429: 「しばらくしてからお試しください」。本文は必ず読み切る（clientFetch の結果の json を読む）
// 戻る／コードの再送: 段階 2 に「コードを送り直す」（段階 1 へ戻る。start を再度叩くのは現行パスワードを入れ直した時だけ）
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `src/app/account/page.tsx` のプロフィールの欄の構造と、ログイン確認の方式（`/api/auth/me` か `useLogin`）、`TextField`（`type="password"`・`autoComplete`・エラー表示の props）、`LiveMessage` の使い方、`clientFetch` の戻り値、`useLoginHref` を読む。`src/app/account/account.css` に新しい意匠を足さず、既存のクラスを使う。`git status` で `account/page.tsx` に他者の変更が無いことを確かめる（あれば止めて報告）。
- [ ] **Step 2（RED）: 結合（RTL）を書く**（先頭 `DD-AUTH-042`・`FR-AUTH-006-AC-01`）。①段階 1 が最初に出る（現行パスワードの欄と送るボタン。コード・新パスワードの欄は無い）、②`start` が 200 で段階 2 に変わりコードと新パスワードの欄が出る、③`start` が 401 で「現行のパスワードが正しくありません」が出て段階 1 に留まる、④新パスワードが 15 文字だと送らずに画面で断る（`confirm` を呼ばない）、⑤確認の欄が違うと送らない、⑥`confirm` が 200 で成功の文と `/login` への遷移、⑦`confirm` が 401 でコードの誤りの文（残りの回数を言わない）、⑧429 の文、⑨どの応答も本文が読み切られる（`json()` が呼ばれる）、⑩パスワードの欄が `type=password` で、`autoComplete` が `current-password`／`new-password`／コードが `one-time-code`、⑪ラベルが入力に結ばれている（アクセシブルな名前で取れる）、⑫（`FR-AUTH-006-AC-07`）段階 1 に Google だけで登録した会員向けの案内と `/auth/password-reset` へのリンクが出て、段階 2 では出ない。
- [ ] **Step 3（GREEN）:** 実装する。プロフィールにリンクを足す。`tsc`。
- [ ] **Step 4: 対象の `jest`。** `npx jest tests/integration/ui/auth-password-change.test.tsx` と、`account/page.tsx` を読む既存の試験（`grep -rln "account/page\|AccountPage" tests`）。
- [ ] **Step 5: 文書・報告。** `DD-AUTH-042`。`validate-docs`・`validate-trace -- AUTH`。共有文書の変更案: `screen-list.md`・`screen-flow.md`（新しい画面 `/account/password` と、プロフィール→パスワード変更→ログインの遷移）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 7: パスワード変更の E2E と要件（SR-AUTH-009・FR-AUTH-006・SEC-AUTH-034・035・015 の追加）

**範囲:** 3 幅の E2E（書くだけ）と、領域の要件・脅威の書き足し。`SEC-AUTH-015` の AC-01・02 の書き換えは Task 8（設定と同じ変更）。

**Files:**

- Create: `supabase/pending-wave6/e2e/FR-ACCOUNT-046-password-change.spec.ts.pending`（**生きている `e2e/` に置かない**。M3 と新しい窓口が手元に当たる Task 10 まで動かず、他のセッションの E2E の全件実行・pre-push を赤にするため。Task 10 Step 2 が `e2e/FR-ACCOUNT-046-password-change.spec.ts` へ移す。拡張子 `.pending` は `tsc`・Playwright・`validate-trace` の対象外）
- Modify: `wave6-staging/b/e2e/FR-LOGIN-031-supabase-direct-bypass.spec.ts`（Global Constraints の「切り替えと対の E2E」の b の写し。新しい `SEC-AUTH-015-AC-04` を足す。AC-01・02 は Task 8。パッチ `e2e-wave6.patch` の元になる）。**`scripts/trace/scope.json` の `e2e` への追加（`e2e/FR-ACCOUNT-046-*.spec.ts`）は Task 10 Step 2 で、spec を移すのと同じ変更で行う**（先に足すと、無いファイルを指す）
- Docs: `docs/02_Requirements/areas/auth.md`（冒頭の対応表、`SR-AUTH-009`、`FR-AUTH-006`＋AC-01〜07、`SEC-AUTH-034`＋AC-01〜04、`SEC-AUTH-035`＋AC-01〜02〔Task 2 で足した物を完成〕、`SEC-AUTH-015-AC-04`・`05`）、`docs/05_Quality/security/threats/auth.md`（`THR-AUTH-034`〔乗っ取った session でパスワードを変える〕・`THR-AUTH-035`〔直接の呼び出しの偽登録・総当たり・メール枠の使い切り〕、残る危険: 現行パスワードを知る人が GoTrue を直に叩く〔メールのコードがログインに要る〕）

**Interfaces:**

```ts
// e2e/FR-ACCOUNT-046-password-change.spec.ts（先頭の ID は受け入れ条件。3 幅 390／768／1280 で。本番ビルドに対して流す）
// 補助は既存を使う: 会員を admin API で作り（既知のパスワード）、アプリのログイン（/api/auth/login → mailpit の 8 桁 → /api/auth/otp/verify）で入る補助（FR-LOGIN-034 の createMemberWithPassword・sendRealLoginCode、または stockist-admin-test-utils の loginAsMember）。メールは mailpit（readLatestCode 系）で読む。送り元は uniqueSourceIp で試験ごとに分ける
```

テスト（各 3 幅）:

- `FR-AUTH-006-AC-01` 会員が `/account/password` を開くと、現行パスワードの欄と送るボタンが出る（コード・新パスワードの欄は無い）。プロフィールからのリンクで着く。
- `FR-AUTH-006-AC-02` 正しい現行パスワード→メールの 8 桁のコード→新しいパスワードで 200。古いパスワードのログインは 401、新しいパスワードで入り直せる（UI で通す 1 本と、API で通す 1 本）。
- `FR-AUTH-006-AC-03` 現行パスワードが違うと 401・コードのメールが届かない・監査に `password_change`・`failure`・`current_password_invalid`。
- `FR-AUTH-006-AC-04` コードが違うと 401。同じコードを 5 回間違えた後は正しいコードでも 401。コードを送り直すと前のコードは使えない。別の session で取ったコードは使えない（`auth_session_id` の違い。2 つ目の session は 2 回ログインして作る）。
- `FR-AUTH-006-AC-05` 新パスワードが 15 文字／漏洩済み（`FR-SIGNUP-002` の `LEAKED_PASSWORD_B` と同じ値を使うか、`checkPwnedPassword` の外部呼び出しが使えない環境ではこの 1 本を `test.skip` にせず 15 文字だけにする）は 400 で、コードが焼けない（その後に正しい新パスワードで同じコードが通る）。
- `FR-AUTH-006-AC-06` 未ログインの `start`・`confirm` は 401。aal1 の管理者は 403 でコードのメールが届かない。
- `FR-AUTH-006-AC-07` Google だけで登録した会員（パスワードを持たない。`admin.createUser` に `app_metadata: { provider: 'google', providers: ['google'] }` を付け、パスワード無しで作る）が `/account/password` を開くと、段階 1 に「Google でログインしていてパスワードを設定していない場合は、先にパスワードの再設定からパスワードを設定してください」の案内と `/auth/password-reset` へのリンクが出る（案内は誰にでも出る固定の文で、会員がパスワードを持つかを明かさない）。リンクを押すと再設定の申請の画面に着く。この会員が `start` に任意の現行パスワードを送ると、パスワードを持つ会員の誤りと同じ 401（区別がつかない）で、コードのメールは届かない。
- `SEC-AUTH-034-AC-01` 変更の後、古い access token で `/api/auth/me` が `authenticated: false`、古い refresh token の `/api/auth/refresh` が 401、応答で 3 つの認証 Cookie が消える、`public.sessions` の `revoked_at` が全部入る（`auth.sessions` の行も 0）。**この端末の session も失効している**。
- `SEC-AUTH-034-AC-02` 変更の後に、アプリの通知のメール（件名「パスワードを変更しました」）がちょうど 1 通届き、本文にパスワード・コードを含まない。GoTrue の変更通知（件名「パスワードの変更を受け付けました」。Task 0 の F3 で管理 API の変更でも送られると分かれば別に 1 通届く）は件名で分けて数え、この AC の通数に含めない。
- `SEC-AUTH-034-AC-03` 同じ会員の `start` を 6 回送ると 6 回目が 429（本人ごと 10 分 5 回）。送り元の IP を変えても 429（`x-real-ip` を毎回変える）。
- `SEC-AUTH-034-AC-04` 監査の行（`password_change`・`success`／`failure`／`denied`）の `detail` に、送ったパスワード・コード・トークン・`session_id` が現れない（行を文字列にして比べる）。
- `SEC-AUTH-015-AC-04`（`FR-LOGIN-031` に足す。ENV を要る物＝captcha 有効の手元で通る。切り替えの前は赤になるので、**生きている `e2e/` には入れず**、`wave6-staging/b/` の写し（`e2e-wave6.patch` に入り、Task 10 Step 2 で当てる）にだけ書く。印は付けない＝切り替えと同時に入るので外す手間も無い）: anon の鍵で `/auth/v1/signup`・`/auth/v1/token?grant_type=password`・`/auth/v1/otp` をトークン無しで叩くと 400 で、本文に `captcha` を含み、利用者ができず、メールが出ない。

- [ ] **Step 1: 現状の確認（読むだけ）。** `FR-LOGIN-034`・`FR-LOGIN-038`・`stockist-admin-test-utils.ts` のログインの補助の署名を読み、使い回せる物を表にする（新しい補助を作る前に）。`e2e/` の次の番号（今の `FR-ACCOUNT-045` の次＝ `046`）を再確認する。要求 ID の番号を再確認する（先頭の「ID の割当」の注）。
- [ ] **Step 2: E2E を書く**（3 幅・本番ビルド想定。流さない）。会員は afterAll で消す。メールの待ちは `expect.poll` で。送り元の IP は試験ごとに別（`FR-LOGIN-031` の `uniqueSourceIp`）。`test.fail` は付けない（`FR-ACCOUNT-046` は `.pending` のまま Task 10 で入り、`FR-LOGIN-031` の `SEC-AUTH-015-AC-04` は `e2e-wave6.patch` に入る＝どちらも切り替えと同時）。`tsc` は `.pending` を見ないので、import する補助の署名を目で確かめる（型の確かめは Task 10 Step 2 の移した直後）。
- [ ] **Step 3: 要件・脅威を書く。** `auth.md` に上の ID を属性表つきで。`SEC-AUTH-034` の本文に「会員の 2 段〔パスワード＋メール〕は NIST の AAL2 でなく、アプリ独自の方針」を書く。`SEC-AUTH-015` の本文（`:4749-4760`）は Task 8 で全体を直す。冒頭の対応表に `FR-ACCOUNT-046-password-change`→ 新しい AC を足す。
- [ ] **Step 4: 対象の確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。E2E は流さない。spec が `.pending` で `e2e/` に無い間は、新しい `FR-AUTH-006-AC-*`・`SEC-AUTH-034-AC-*`・`SEC-AUTH-015-AC-04` が試験に届かないと `validate-trace` が増えた違反として報告しうる。その場合は**増えた物がこの AC だけであること**を報告に書き（`baseline.json` は増やさない）、Task 10 Step 2 で spec を移した後に 0 になることを確かめる。
- [ ] **Step 5: 報告。** 共有文書の変更案: `requirements.md`（なし。範囲内の領域）、`test-spec.md`（新しい spec と AC の一覧）、台帳（パスワード変更の ASVS V2.1.5・V2.1.6 が満たされたこと）。controller が最後に流す候補: `npx playwright test e2e/FR-ACCOUNT-046`。

**検証コマンド:** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 8: 手元の設定を本番の前提にそろえる（用意だけ。動かすのは Task 10）と、印・要件・試験の書き換え

**範囲:** 目標の `config.toml`（本計画の「目標の config.toml」）を `supabase/pending-wave6/config.toml`（写し）と `supabase/pending-wave6/config.patch`（今の `supabase/config.toml` への差分）に作る。9 つの印、`SEC-AUTH-015` の試験と要件の書き換え、管理 API の最小長の影響の洗い出し。**手元の Supabase の設定そのものは変えない**。

**Files:**

- Create: `supabase/pending-wave6/config.toml`（今の `supabase/config.toml` の全体の写しに目標の差分だけを当てた物。**Task 0 の隔離スタックと `config-wave6.test.ts` が読む写し。Task 10 では `supabase/config.toml` へ上書きしない**）、`supabase/pending-wave6/config.patch`（`git diff --no-index` で作った、今の `supabase/config.toml` → 写しの差分。目標の項目だけが入る）、`supabase/pending-wave6/BASE.txt`（パッチの元にした `supabase/config.toml` と各 E2E の `git hash-object`、`e2e-wave6.patch` の当て方）、`supabase/pending-wave6/e2e-wave6.patch`（下の Modify の E2E の変更と、Task 7 の `SEC-AUTH-015-AC-04`。元の写し a と直した写し b は `wave6-staging/`）、`supabase/templates/confirmation.html`（会員登録の確認メール。ruling 21。`config.patch` には `magic_link.html` の「5分」への 1 行も入る。ruling 22）、`supabase/templates/password_changed_notification.html`（日本語の短い本文。「アカウントのパスワードが変更されました。心当たりがない場合は、ただちにパスワードを再設定のうえお問い合わせください。」。パスワードを含まない。`{{ .Email }}` だけ使ってよい）、`supabase/.env.example`（`SUPABASE_AUTH_CAPTCHA_SECRET=1x0000000000000000000000000000000AA` と注記: Cloudflare の公開のテスト用。本番の秘密を書かない。`supabase/.env` にコピーして使う〔`.env*` は未追跡〕。Task 0 Step 1 で CLI が `supabase/.env` を読むと確かめた場合の書き方に合わせる。読まないなら、`npm run db:start` の前にシェルで設定する、と書く）、`tests/unit/supabase/config-wave6.test.ts`
- Modify（**生きている `e2e/` は直さず、`wave6-staging/b/` の写しを直して `e2e-wave6.patch` にする**。Task 10 の切り替えと同時に当たるので、それまで他のセッションの E2E は赤にならない。controller が Task 10 の窓で一括して確かめる）: `e2e/FR-LOGIN-024-register-no-account-enumeration.spec.ts`（`:104` の印と、冒頭 `:13` の「201 になる」の注）、`e2e/FR-SIGNUP-002-register-api-and-password-policy.spec.ts`（`:184`・`:246` の印、`:157` の注）、`e2e/FR-SIGNUP-003-signup-confirm-link.spec.ts:262`、`e2e/FR-LOGIN-034-otp-verify-screen-entry-and-expiry.spec.ts:281`、`e2e/FR-LOGIN-032-admin-totp-aal2.spec.ts`（`:402`・`:488` の印と冒頭 `:10` の注）、`e2e/stockist-admin-test-utils.ts:8` の注、`e2e/FR-LOGIN-031-supabase-direct-bypass.spec.ts`（AC-01・AC-02 の書き換え。`SEC-AUTH-015-AC-04` の印を外す）
- Docs: `docs/02_Requirements/areas/auth.md`（`SEC-AUTH-015` の本文と AC-01・AC-02 を書き換え、AC-05 を足す。`SEC-AUTH-016-AC-01`・`FREQ-320-AC-03`（`FR-LOGIN-024:104` の試験。見出し `auth.md:3169`）・`SEC-AUTH-029` の「手元の設定は満たさない」を、切り替えた後の文に直す〔「手元の設定は 2026-11-0x に本番の前提にそろえた」。**切り替えの日は Task 10 が埋める**〕）、`docs/03_BasicDesign/areas/auth.md`（設定の表）、`docs/05_Quality/security/threats/auth.md`

**Interfaces（試験の書き換え）:**

- `SEC-AUTH-015-AC-01`（`FR-LOGIN-031:597-624`）を書き換える: anon の鍵で `/auth/v1/signup` を**ダミーの captcha_token 付き**で 15 文字のパスワードで呼ぶと、422（`weak_password`）で、利用者ができない。本文は `withDummyCaptcha`。「トークン無し」は `SEC-AUTH-015-AC-04` が受け持つ（理由を分けて確かめる）。`test.fail` を外す。
- `SEC-AUTH-015-AC-02`（`FR-LOGIN-031:627-652`）を 2 本にする。(i)「**現行パスワード無しの変更は 400**」: 作ったばかりの会員の access token で `PUT /auth/v1/user { password }` を送ると 400（`current_password_required`）で、ハッシュが変わらない。**手元の CLI は設定できない**（P9）ので、`test.fail(true, 'ENV security_update_password_require_current_password は CLI の config.toml に鍵が無く手元で設定できない（本番は Management API の GET で確かめる。SEC-AUTH-015-AC-05）')` を付けたままにする。(ii)「**古い session は nonce 無しで 400**」: 会員を作ってログインし、DB で `auth.sessions.created_at` を 25 時間前にしてから `PUT /auth/v1/user { password }` を送ると 400（`reauthentication_needed`）で、ハッシュが変わらない。`test.fail` なし。
- 要件の言い方: `SEC-AUTH-015` の本文を「最小の長さ 16（`minimum_password_length`）、captcha、パスワード変更に再認証（`secure_password_change`）と**現行パスワードの要求**（`security_update_password_require_current_password`。本番のダッシュボード／Management API）、メールの差し替えに新旧両方の確認」に直す。AC-02 の文を「24 時間より古い session は再認証なしで変えられない。現行パスワード無しの変更は誤りになる」に。**24 時間以内の session の窓は設定で変えられない**と明記し、残る危険（現行パスワードを知る人が直に変える）と守り（ログインにメールのコード・管理者は aal2・変更通知）を書く。`SEC-AUTH-015-AC-05`（新規）: 本番の `security_update_password_require_current_password` が true（確かめ方: レビュー〔Management API の GET〕）。

- [ ] **Step 1: 現状の確認（読むだけ）。** 「設計書の印と今の印」の表を `grep -rnE "test\.fail" e2e` で再確認し、行番号が動いていれば表を直す（他者が編集していないか `git status`）。`stockist-admin-test-utils.ts:8` と `FR-LOGIN-032:10` の注を読む。
- [ ] **Step 2（RED）: 設定の単体を書く**（先頭 `DD-AUTH-040` か、設定の単位として `DATA-AUTH-0xx`〔設定の表を `DATA-AUTH-011` として起こす〕）。`tests/unit/supabase/config-wave6.test.ts`: `supabase/{pending-wave6,.}/config.toml` のどちらかを読み（Task 10 の後は `supabase/config.toml`）、①`minimum_password_length = 16` と `password_requirements = ""`、②`[auth.captcha]` が `enabled = true`・`provider = "turnstile"`・`secret = "env(SUPABASE_AUTH_CAPTCHA_SECRET)"` で、**`secret` に平文の値が無い**（`1x0000…` を含まない）、③`enable_confirmations = true`・`secure_password_change = true`・`otp_expiry = 300`・`otp_length = 8`・`double_confirm_changes = true`・`enable_signup = true`、④`[auth.mfa.totp]` が両方 true、⑤`[auth.email.notification.password_changed]` が enabled で `content_path` のファイルが在る、⑥`[auth.email]` の `enable_signup` と SMTP の設定を変えていない、⑦ほか（`[auth.rate_limit]`・`[api]`・`[db]` のポート）は今の `supabase/config.toml` と同じ（`pending-wave6/config.toml` と `supabase/config.toml` の比較は Task 10 の後は同一になるので、比較は「目標の項目以外の行が元と同じ」ではなく「ポートの 6 項目が元の値」で）。
- [ ] **Step 3: 最小長の影響の洗い出し（読むだけ）。** Task 0 の G1・G2 の結果を読み、管理 API が最小長を強制するなら `grep -rnE "password:\s*['\"\`][^'\"\`$]{1,40}['\"\`]" e2e tests/integration scripts supabase/seed.sql` と `createUser(`・`updateUserById(` の全件で、16 文字未満の固定値を表にして直す（今分かっている固定値は `e2e/helpers.ts:23` の `'TestPassword123!'`＝ちょうど 16 で OK、`FR-PWRESET-002:116` の `'NewPassword123!'`＝ 15 文字は否定の試験で OK、`FR-LOGIN-030:291` の `'Wrong-pass-1234!'`＝誤りを送る試験で OK）。強制しないなら「影響なし」と報告する。
- [ ] **Step 4: 印・試験・要件を直す。** 9 つの印（上の表）、`FR-LOGIN-031` の AC-01・02・04、注は、**`wave6-staging/{a,b}/` の写しで直し、`git diff --no-index` で `supabase/pending-wave6/e2e-wave6.patch` にする**（a は作る時点の生きているファイルの写し。b を直す。Task 7 が b に足した `FR-LOGIN-031` の AC-04 を含める）。`config.patch` も同じ方法で作る（a ＝今の `supabase/config.toml`、b ＝ `pending-wave6/config.toml`）。`BASE.txt` に a の `git hash-object` を書く。パッチが当たることを、**別の置き場へ写した a** に `git apply --check` して確かめる（生きている `e2e/`・`supabase/config.toml` に当てない）。要件。`SEC-AUTH-016-AC-01`（`FR-SIGNUP-002:184`）・`FREQ-320-AC-03`（`FR-LOGIN-024:104`）・`SEC-AUTH-029-AC-01`・`-AC-02`・`FREQ-316-REQ-02-AC-01`・`SEC-AUTH-030-AC-01` の本文の「今のコードは満たさない」（`FREQ-320-AC-03` の本文に当てはまる語が無ければ、`auth.md` の冒頭の対応表と試験名の ENV の注だけを直す）を、Task 10 の後の文に直す下書きを `auth.md` に（日付は空欄で、controller が埋める）。
- [ ] **Step 5: 対象の確かめ。** `npx jest tests/unit/supabase/config-wave6.test.ts`、`npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。E2E は流さない。
- [ ] **Step 6: 報告。** 直したファイルと行の表、最小長の洗い出しの結果、controller が Task 10 で流す spec の一覧（次の節）。共有文書の変更案: 台帳（`W-08` の ENV の項目が閉じること）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`。

---

## Task 9: 運用の文書（本番の Supabase の設定・秘密・環境変数）

**範囲:** `docs/06_Operations` の 3 文書と、本番の設定の目標値の表・手順・戻し方・手で変える項目。コードは変えない。台帳と `README.md`・`db-migrations.md` は controller（Task 10・11）。

**Files:**

- Create: `docs/06_Operations/supabase-auth-config.md`
- Modify: `docs/06_Operations/secrets.md`（`APP_ALLOWED_ORIGINS` を「本番のビルドに必須」に直す。`TURNSTILE_SECRET_KEY` の節に「同じ秘密を Supabase の captcha にも入れる」「手元は常に通るテスト用」。`SUPABASE_AUTH_CAPTCHA_SECRET`〔手元の `supabase/.env`〕。`SUPABASE_ACCESS_TOKEN`〔Management API 用の個人用トークン。controller のシェルだけ〕）、`docs/06_Operations/deployment-topology.md`（Supabase Auth の設定は `config.toml` ではなく本番のダッシュボード／Management API が正であることと、`supabase config push` を流さない理由）

**`supabase-auth-config.md` の中身（書式は `docs/README.md` の共通フォーマット。冒頭の確認日 2026-11-01）:**

1. 目標の値の表（項目・Management API の鍵・目標・手元の `config.toml` の鍵・出どころ）: `security_captcha_enabled`=true・`security_captcha_provider`=`turnstile`・`security_captcha_secret`（アプリの `TURNSTILE_SECRET_KEY` と同じ値）、`mailer_autoconfirm`=false、`mailer_otp_exp`=300、`mailer_otp_length`=8、`password_min_length`=16、`password_required_characters`=（変えない。NIST は構成規則を課さない）、`security_update_password_require_reauthentication`=true、`security_update_password_require_current_password`=true、`mailer_secure_email_change_enabled`=true、`mailer_notifications_password_changed_enabled`=true（件名・本文の日本語）、`mfa_totp_enroll_enabled`・`mfa_totp_verify_enabled`=true、`external_email_enabled`=true、`disable_signup`=false、`password_hibp_enabled`=true（**プラン依存**: Supabase の公式は Pro 以上。拒まれたら台帳へ）、`max_rows`（`PATCH /v1/projects/{ref}/postgrest`。手元は 1000）。
2. 手で変える項目（API に鍵が無い・プラン依存）: 「サインイン・サインアップの IP ごとの枠」（スキーマに鍵が無い。ダッシュボードの Authentication → Rate Limits。**アプリの全員が Vercel の出口の少数の IP から GoTrue を呼ぶので、30 回／5 分を店の全員で分け合う**。開店前に上げる値を決める）、`rate_limit_email_sent`（自前の SMTP が有効でないと変えられない。**Supabase 既定のメール送信は時間あたりの上限が小さく、宛先も制限されるので、本番は自前の SMTP〔Resend〕を設定しないと一般の会員にログインの確認コードが届かない**。`smtp_host` を GET で確かめる）、漏洩パスワードの確認（プランを確認）、Site URL（台帳の 1c）、確認メールの雛形の `{{ .Token }}`（台帳の「ログインのメールの型」）。
3. 手順（Task 11 の要約）: 読む→控える→段階 A→確かめる→段階 B→確かめる→戻し方。秘密の扱い（`SUPABASE_ACCESS_TOKEN`・`TURNSTILE_PROD_SECRET` は controller のシェルの環境変数だけ。控えのファイルは末尾が `_secret`・`_secrets`・`_pass`・`_key`・`_auth_token` の鍵だけ伏せる）。**3 回試して通らない時の手順**: 各項目をダッシュボードのどの画面のどの欄で変えるか（Authentication → Sign In / Providers → Email〔Confirm email、OTP expiry、OTP length〕、Attack Protection〔Captcha、Leaked password protection、Minimum password length、Require current password when updating〕、Multi-Factor〔TOTP〕、Rate Limits、Emails〔Notifications〕、Settings → API〔Max rows〕）。画面の名前は実際のダッシュボードで確かめて直す。
4. 確かめのスクリプトの使い方（Task 11 が置く `wave6-prod-auth-config.mjs` は `.superpowers` にあり未追跡なので、この文書には手順と期待値だけを書く）。

- [ ] **Step 1: 書く。** 上の内容。Task 11 の結果で controller が「実際に変えた日・値・戻した物」の節を後から足す（空の見出しだけ置く）。
- [ ] **Step 2: 確かめ。** `npm run validate-docs`（既知の 2 件のリンク切れ以外が増えない）。
- [ ] **Step 3: 報告。** 共有文書の変更案: `docs/06_Operations/README.md`（H が編集中）に新しい文書へのリンク 1 行、`db-migrations.md` に M3 の節、台帳の「開店の準備」に行を足す案（下の Task 11 Step 6）。

**検証コマンド:** `npm run validate-docs`。

---

## Task 10: 手元の切り替え（controller。合意した窓の中で）

**範囲:** M3 と目標の `config.toml` を動かし、手元の Supabase を再起動し、`db reset`・DB 結合・E2E を流して、9 つの印を外した版で緑にする。コードは変えない。

**前提:** Task 0 の GATE が通っている。Task 1〜9 が作業ツリーに入っている。G-1／H の 5 時間の E2E が終わっている（再起動と `db reset` で止まるため）。

- [ ] **Step 0: 窓の合意。** G-1／H に知らせる:「手元の `supabase/config.toml` を本番の前提（確認メール必須・captcha・最小長 16・TOTP 有効・OTP 300 秒）に替え、`supabase stop && start` と `db reset` をする。移行 1 本（`password_change_challenges`）を `supabase/migrations/` に足す。E2E の GoTrue 直叩きの補助はダミーの captcha を付ける版に替えてある。H の E2E の補助が anon で GoTrue を直接叩いていれば captcha のトークンが要る」。約 120 分。`supabase/.env`（`SUPABASE_AUTH_CAPTCHA_SECRET=1x0000000000000000000000000000000AA`）を作る。
- [ ] **Step 1: 木の確認。** `npx tsc --noEmit`、非 DB の `jest`（全体 1 回。落ち 0。他者の落ちは別に記録）、`npm run validate-docs`（既知の 2 件以外が増えない）、`npm run validate-trace`（増えた違反 0。ただし `FR-ACCOUNT-046` の spec を Step 2 で移す前なので、`FR-AUTH-006`・`SEC-AUTH-034`・`SEC-AUTH-015-AC-04` の AC だけが増えた違反なら許し、Step 2 の後に 0 を確かめる）、`npm run test:trace-coverage`（増やさない）、`npm run trace:report`。
- [ ] **Step 2: 動かす。** ①`ls supabase/migrations | tail -3` で M3 の時刻が全部の既存の移行より後であることを確かめ、付け直すなら M3 のファイル名・ヘッダー・単体試験・ADR・文書を一貫させる。`supabase/pending-wave6/20261101120000_….sql` を `supabase/migrations/` へ**移す**（`git mv` ではなくファイルを移す）。
  ②**`supabase/config.toml` は写しで上書きしない**（Task 8 から今までの間に他者が入れた変更を消すため）。`git diff --stat -- supabase/config.toml` と `git hash-object supabase/config.toml` を `BASE.txt` と比べ、違えば他者の変更を見てから、`git apply --check supabase/pending-wave6/config.patch` → `git apply supabase/pending-wave6/config.patch` で**目標の差分だけ**を今のファイルに当てる（当たらなければ、「目標の config.toml」の表の項目を今のファイルに手で当てる）。当てた後に `diff` で目標の項目だけが変わったこと（他者の変更が残っていること）を確かめる。
  ③E2E: `BASE.txt` の各ファイルの `git hash-object` を今と比べ、`git apply --check supabase/pending-wave6/e2e-wave6.patch`（`BASE.txt` の接頭辞の剥がし方で）。通れば当てる。当たらないファイルは、「設計書の印と今の印」の表（印の外し・AC の書き換え・注の直し）から**そのファイルだけ**手で当てる。`supabase/pending-wave6/e2e/FR-ACCOUNT-046-password-change.spec.ts.pending` を `e2e/FR-ACCOUNT-046-password-change.spec.ts` へ移し、`scripts/trace/scope.json` の AUTH の `e2e` に `e2e/FR-ACCOUNT-046-*.spec.ts` を足す。`npx tsc --noEmit`（移した spec の型）。
  ④`supabase/pending-wave6/` と `wave6-staging/` を消す。`security-definer-search-path-guard.test.ts`・`sec-*.test.ts`・`config-wave6.test.ts` を流す。`npm run validate-trace`（増えた違反 0）・`npm run test:trace-coverage`。
- [ ] **Step 3: 再起動と DB。** 3000 番の残りを止める（`Get-NetTCPConnection -LocalPort 3000 -State Listen`）。`npm run db:stop`→ `npm run db:start`（`SUPABASE_AUTH_CAPTCHA_SECRET` が環境に入っていること）→ `npm run db:reset`。末尾の自己検査（`SEC_WAVE6_MIGRATION_ASSERTION_FAILED` が出ない）。`DATABASE_URL=… npx jest tests/integration/db --runInBand`（`auth_password_change_challenges`・`auth_grants_inventory`・`security_definer_search_path`・Task 3 の 3 ファイルが通る。波 5 は 4377 件通過・0 失敗）。
- [ ] **Step 4: E2E。** 先に対象を `--grep` で 1 本ずつ（Review Focus 8）: `FR-LOGIN-031`（AC-01・02・04 ほか）、`FR-LOGIN-024`・`FR-SIGNUP-002`・`FR-SIGNUP-003`・`FR-LOGIN-034`・`FR-LOGIN-032`、`FR-LOGIN-008`・`FR-LOGIN-035`・`FR-LOGIN-038`（アプリのログインが captcha 有効でも通る＝ `SEC-AUTH-035-AC-01`）、Task 3 の 12 ファイルの spec、`FR-ACCOUNT-046`、`FR-PWRESET-*`。次に全件を流して `e2e-results-wave5-full.json`（203 failed）と比べる（`flattenPlaywrightJson` で直して渡す）。`E2E_FIXED_ENV` は変えていないが、設定が変わったので古い 3000 番のアプリは必ず止める。**新しい赤の見立て**: ①400 `captcha`（補助のダミーの付け忘れ）、②登録した会員が入れない（確認メール必須。アプリの登録で作った会員をログインに使う試験）、③「予想外の成功」（印の外し忘れ。`test.fail` の行）、④422 `weak_password`（16 文字未満の固定値）、⑤TOTP の補助（amr の行）が実 TOTP と食い違う、⑥`networkidle` が止まる（新しい `no-store` は足していない）、⑦ GoTrue が Cloudflare に出られず captcha が 500（オフライン）。
- [ ] **Step 5: 印の棚卸し。** `grep -rnE "test\.fail" e2e | grep -E "ENV"` の残りが、`FR-LOGIN-031` の `SEC-AUTH-015-AC-02`(i) の 1 件だけ（P9）であること。外した 8 か所（表の 9 のうち AC-01 は書き換え済み）と数が合うこと。
- [ ] **Step 6: 共有文書の反映・日付を埋める。** `db-migrations.md`（M3 の節）、`route-inventory.md`・`api-spec.md`・`screen-list.md`・`screen-flow.md`（Task 5・6 の変更案）、`test-spec.md`、`docs/06_Operations/README.md`、台帳（W-08 の ENV と波 6 の状態）。`auth.md` の「切り替えの日」を `SEC-AUTH-016-AC-01`・`FREQ-320-AC-03`・`SEC-AUTH-029-AC-01`／`-AC-02`・`FREQ-316-REQ-02-AC-01`・`SEC-AUTH-030-AC-01` の全部に埋める（`FREQ-320-AC-03` は `FR-LOGIN-024:104` の印の外し）。
- [ ] **Step 7: コミット。** 種類ごとに分ける（src／試験／E2E と scripts／文書／移行と設定）。`git add` の後で `git status` に他者のファイルが混ざっていないことを確かめる。G-1 に「入れた。手元の Supabase は新しい設定で動いている」と知らせ、`supabase/.env` の作り方を渡す。

---

## Task 11: 本番（controller。オーナーの許可と順序が命）

**範囲:** M3 の本番適用、本番の Supabase Auth の設定の読み・段階 A・段階 B・確かめ・戻し、台帳。Management API の呼び出しは一つずつ許可のもとで行う（これは本番の変更）。

**前提:** ①Task 2 のコード（アプリが service role で呼ぶ版）が master にあり、普段の開発がそれを使っている。②Task 10 が済み、E2E で `SEC-AUTH-035-AC-01` が確かめられている。③オーナーの許可（M3 の本番適用と、Auth の設定の変更。波 5 の「M1／M2 は許可つき」と同じ扱い）。④`SUPABASE_ACCESS_TOKEN`（ダッシュボードで作る個人用トークン `sbp_…`。P11）がこのシェルの環境変数にある。⑤段階 B のために本番の Turnstile の秘密が `TURNSTILE_PROD_SECRET` にある（無ければ段階 B を保留。P12・ruling 11）。

- [ ] **Step 1: M3 を本番へ。** 波 5 の Task 1B の Step 3 と同じ手順: 適用前に `get_advisors`（security）を保存、`schema_migrations` の最後を読む、`supabase migration list --linked` で本番に無い移行が M3 の 1 本だけであることを確かめる。**既定は「H の移行（`20261029130000` 以降）が本番に届いてから M3 を当てる」**。H の移行が未適用のまま M3（`20261101120000`）だけを当てると、本番の履歴が時刻の順にならず、後の `supabase db push --linked` が、M3 より前の時刻の H の移行を `--include-all` 無しでは拒む（波 5 の約束: H の移行は H の Task 12 とオーナーの確認まで当てない）。M3 に依存するのはパスワード変更の画面だけで（本番のアプリは未デプロイ）、段階 A・B（Step 2 以降）は M3 に依存しないので、**H の移行が届くまで Step 1 を保留して Step 2 以降へ進んでよい**。どうしても先に当てる時（オーナーの決定）は、M3 だけを MCP の `apply_migration` で当て、名前を台帳に合わせ（当てた文は `schema_migrations` の `md5(statements[1])` でファイルと突き合わせる）、台帳に「H の移行を後で当てる時は `supabase db push --linked --include-all`（または MCP で 1 本ずつ名前を台帳に合わせて）当てる」手順を書く。事後: 表と 2 関数と権限、`get_advisors` の増えた WARN が無い。
- [ ] **Step 2: 現在値を読んで控える。** 次のスクリプトを `.superpowers/sdd/2026-10-25-security-gap-fixes/wave6-prod-auth-config.mjs` に置く。`get` は `GET https://api.supabase.com/v1/projects/pjidrgofvaglnuuznnyj/config/auth` と `…/postgrest` を呼び、**名前の末尾が `_secret`・`_secrets`・`_pass`・`_key`・`_auth_token` の鍵の値だけを `[REDACTED]` にして**保存する（`wave6-prod-auth-config-before.json`。`password_min_length`・`security_update_password_require_*`・`mailer_notifications_password_changed_enabled`・`rate_limit_token_refresh` など**変える値・読む値は伏せない**＝伏せると控えが役に立たない）。戻し用に、別の `wave6-prod-auth-config-rollback.json` を `{ restore, readOnly, postgrestMaxRows }` の形で作る。`restore` ＝段階 A・B で**変える鍵だけ**（A の鍵＋`security_captcha_enabled`・`security_captcha_provider`＋`password_hibp_enabled`）の今の値、`readOnly` ＝変えないが読んで報告する鍵（`site_url`・`smtp_host`・`rate_limit_email_sent`・`sessions_*`・`password_required_characters` ほか）。**`rollback` は `restore` の鍵だけを PATCH する**（`readOnly` を送ると、変えていない鍵、とくに自前の SMTP が無い時の `rate_limit_email_sent` が 4xx になり、戻したい時に戻せない）。秘密の鍵はどちらにも入れない。

```js
// node wave6-prod-auth-config.mjs get | patch-a | patch-b | verify | rollback
// 環境: SUPABASE_ACCESS_TOKEN（sbp_…）、patch-b だけ TURNSTILE_PROD_SECRET。値を標準出力・ファイルに出さない
import { readFileSync, writeFileSync } from 'node:fs';
const REF = 'pjidrgofvaglnuuznnyj';
const BASE = `https://api.supabase.com/v1/projects/${REF}`;
const token = process.env.SUPABASE_ACCESS_TOKEN; if (!token) throw new Error('SUPABASE_ACCESS_TOKEN が無い');
const A = { // 段階 A: captcha 以外。鍵名は get の応答で最終確認してから流す（無い鍵は 400 になるので、get の応答に在る鍵だけを送る）
  password_min_length: 16,
  security_update_password_require_reauthentication: true,
  security_update_password_require_current_password: true,
  mailer_notifications_password_changed_enabled: true,
  mailer_subjects_password_changed_notification: 'パスワードの変更を受け付けました', // アプリの通知（「パスワードを変更しました」）と件名を変える。config.toml・ruling 9 と同じ
  mailer_templates_password_changed_notification_content: '<p>アカウントのパスワードが変更されました。心当たりがない場合は、ただちにパスワードを再設定のうえお問い合わせください。</p>',
  mailer_autoconfirm: false, mailer_otp_exp: 300, mailer_otp_length: 8, mailer_secure_email_change_enabled: true,
  mfa_totp_enroll_enabled: true, mfa_totp_verify_enabled: true,
  // password_hibp_enabled は別に試す（プラン依存。拒まれたら台帳へ）
};
// 伏せるのは本物の秘密の鍵名だけ（末尾が _secret／_secrets／_pass／_key／_auth_token）。`pass`・`token` を部分一致で伏せると、
// password_min_length・security_update_password_require_*・mailer_notifications_password_changed_enabled・rate_limit_token_refresh など、
// 変える値そのものが before.json から消える。
const SECRET_KEY = /(_secrets?|_pass|_key|_auth_token)$/i;
const redact = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SECRET_KEY.test(k) && v ? '[REDACTED]' : v]));
// 戻す対象は「今回変える鍵」だけ。ほかの鍵は読み取りのための控え（READ_ONLY）で、rollback は送らない
// （変えていない site_url・smtp_host・rate_limit_email_sent・sessions_*・password_required_characters を PATCH すると、
//  自前の SMTP が無い時の rate_limit_email_sent などが 4xx になり、戻す操作が必要な時に失敗する）。
const CAPTCHA_KEYS = ['security_captcha_enabled', 'security_captcha_provider'];
const RESTORE_KEYS = [...Object.keys(A), ...CAPTCHA_KEYS, 'password_hibp_enabled'];
const READ_ONLY_KEYS = ['disable_signup', 'external_email_enabled', 'smtp_host', 'rate_limit_email_sent', 'rate_limit_otp', 'rate_limit_verify', 'rate_limit_token_refresh', 'password_required_characters', 'sessions_timebox', 'sessions_inactivity_timeout', 'sessions_single_per_user', 'site_url'];
async function api(method, path, body, tries = 3) {
  for (let i = 1; i <= tries; i += 1) {
    const res = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : {};
    console.error(`試行 ${i}/${tries}: ${method} ${path} -> ${res.status} ${text.slice(0, 200).replace(/sbp_\w+/g, '[token]')}`);
    if (res.status < 500 && res.status !== 429) break; // 4xx（429 以外）は再試行しても同じ
    await new Promise((r) => setTimeout(r, 1000 * i));
  }
  throw new Error(`${method} ${path} が通らない（手動の手順へ: docs/06_Operations/supabase-auth-config.md）`);
}
const cmd = process.argv[2];
if (cmd === 'get') {
  const auth = await api('GET', '/config/auth'); const pg = await api('GET', '/postgrest');
  writeFileSync('wave6-prod-auth-config-before.json', JSON.stringify({ auth: redact(auth), postgrest: pg }, null, 2));
  const pick = (keys) => Object.fromEntries(keys.filter((k) => k in auth).map((k) => [k, auth[k]]));
  writeFileSync('wave6-prod-auth-config-rollback.json', JSON.stringify({ restore: pick(RESTORE_KEYS), readOnly: pick(READ_ONLY_KEYS), postgrestMaxRows: pg.max_rows ?? null }, null, 2)); // restore＝rollback が送る鍵。readOnly＝読むだけ。秘密の鍵は入れない
  console.log('保存した。鍵の不足（API に無い）:', [...RESTORE_KEYS, ...READ_ONLY_KEYS].filter((k) => !(k in auth)));
  // 一人一端末（sessions_single_per_user）が ON だと、パスワード変更の「現行パスワードの確認」の signInWithPassword が今の session を消し、
  // start → confirm が必ず失敗する（コードは消えた session_id に結んである）。ON なら段階 A の前に止める。
  console.log('sessions_single_per_user:', auth.sessions_single_per_user);
  if (auth.sessions_single_per_user !== false) { console.error('STOP: sessions_single_per_user が false でない（キーが無い場合は GET の応答で確かめ直す）。パスワード変更が成り立たない。オーナーに知らせる'); process.exitCode = 1; }
  console.log('サインインの枠に当たる鍵:', Object.keys(auth).filter((k) => /sign/i.test(k) && /rate|limit/i.test(k)));
} else if (cmd === 'patch-a') {
  const cur = await api('GET', '/config/auth');
  await api('PATCH', '/config/auth', Object.fromEntries(Object.entries(A).filter(([k]) => k in cur)));
  console.log('段階 A を送った。verify で読み戻す');
} else if (cmd === 'patch-b') {
  if (!process.env.TURNSTILE_PROD_SECRET) throw new Error('TURNSTILE_PROD_SECRET が無い（段階 B は保留）');
  await api('PATCH', '/config/auth', { security_captcha_enabled: true, security_captcha_provider: 'turnstile', security_captcha_secret: process.env.TURNSTILE_PROD_SECRET });
  console.log('段階 B（captcha）を送った。すぐ verify');
} else if (cmd === 'verify') {
  const cur = await api('GET', '/config/auth'); const want = { ...A, security_captcha_enabled: process.argv[3] === 'with-captcha' ? true : undefined };
  const diff = Object.entries(want).filter(([k, v]) => v !== undefined && k in cur && cur[k] !== v).map(([k, v]) => `${k}: 今 ${JSON.stringify(cur[k])} / 目標 ${JSON.stringify(v)}`);
  console.log(diff.length ? `食い違い:\n${diff.join('\n')}` : '目標どおり');
} else if (cmd === 'rollback') {
  const { restore } = JSON.parse(readFileSync('wave6-prod-auth-config-rollback.json', 'utf8')); // readOnly は送らない
  const keys = process.argv.slice(3); // 例: security_captcha_enabled だけ戻す。引数なしなら restore（今回変えた鍵＋captcha の鍵）の全部
  const unknown = keys.filter((k) => !(k in restore)); if (unknown.length) throw new Error(`restore に無い鍵: ${unknown.join(',')}`);
  const picked = keys.length ? Object.fromEntries(keys.map((k) => [k, restore[k]])) : restore;
  const body = Object.fromEntries(Object.entries(picked).filter(([, v]) => v !== null && v !== undefined)); // 元が null の鍵は送れない（4xx）。手動の手順へ
  const skipped = Object.keys(picked).filter((k) => !(k in body));
  await api('PATCH', '/config/auth', body); console.log('戻した:', Object.keys(body), '元が null で送れず手動で戻す:', skipped);
}
```

  控えを読み、①`security_captcha_enabled` が今 false であること、①b **`sessions_single_per_user` が false であること**（スクリプトが true／キー無しなら `STOP` を出して終了コード 1。ON だとパスワード変更の「現行パスワードの確認」の `signInWithPassword` が今の session を消し、コードが結んだ `session_id` が死ぬので `start → confirm` が必ず失敗する。ON ならオーナーに知らせ、段階 A に進まない）、②`mailer_autoconfirm`・`mailer_otp_exp`・`mailer_otp_length`・`password_min_length`・`external_email_enabled`・`disable_signup`・`smtp_host` の今の値、③「サインインの枠に当たる鍵」の出力（P10 によりスキーマに無い見込み）を報告に書く。`password_required_characters` が空でなければ（構成規則を課していれば）オーナーに知らせる（NIST 3.1.1.2。変えるかは別の判断）。
- [ ] **Step 3: 段階 A（captcha 以外）。** `node wave6-prod-auth-config.mjs patch-a`（3 回まで自動で試す）→ `node wave6-prod-auth-config.mjs verify` が「目標どおり」。`password_hibp_enabled: true` を別に 1 回送る（プラン依存。`4xx` なら理由を記録して台帳へ）。`max_rows` は `PATCH /v1/projects/pjidrgofvaglnuuznnyj/postgrest` で、今の値が 1000 より大きければ 1000 に（`GET` の値を先に控える）。**3 回試して通らない項目は止めて、`supabase-auth-config.md` の手動の手順で、オーナーにダッシュボードで変えてもらう**（その項目と画面を報告に）。
- [ ] **Step 4: 段階 B（captcha）。** ①アプリが service role の版で動いていることを再確認（Task 2 が master にあり、普段の開発がそれ）。②**戻しの用意**: 別のターミナルで `node wave6-prod-auth-config.mjs rollback security_captcha_enabled` をすぐ打てる状態にする。③`node wave6-prod-auth-config.mjs patch-b`。④**すぐ確かめる**（読むだけ・本番の利用者を作らない）: 次の 4 点を、本番の URL・anon（`sb_publishable_`）・service（`sb_secret_`）で、存在しないメールを使って測る。(i) anon で `/auth/v1/signup` をトークン無し→ 400（`captcha`）。(ii) anon で `/auth/v1/token?grant_type=password` をトークン無し→ 400（`captcha`）。(iii) **`sb_secret_` を `apikey` と `Authorization: Bearer` に付けて** `/auth/v1/token?grant_type=password` をトークン無しで、存在しないメール→ **captcha の誤りでなく** 400 `invalid_credentials`（captcha を免除された印）。(iv) 同じく `/auth/v1/otp`（`create_user: false`）→ captcha の誤りでなく 422／400 の「利用者が無い」系。(iii)・(iv) が `captcha` の誤りなら**崩れた**＝その場で rollback、ruling 10 へ。⑤普段の開発で 1 回アプリのログイン（試し用の会員。本番の DB に書く操作なので、オーナーの確認を先に取る）が通ること。通らなければ rollback。
- [ ] **Step 5: 3 回試して無理だった物の手順。** `docs/06_Operations/supabase-auth-config.md` の「手で変える項目」に、変えられなかった項目・ダッシュボードの画面・目標の値・いつ誰が確かめるかを書く。台帳（4 章「開店の準備」）に行を足す（案: 「Supabase のダッシュボード／Management API の設定の確認と変更〔上の表〕」「漏洩パスワードの確認〔プラン〕」「IP ごとのサインインの枠を上げる〔店の全員が Vercel の出口で分け合う〕」「自前の SMTP〔Resend〕の設定と `smtp_host`」「`max_rows`」「Vercel の `APP_ALLOWED_ORIGINS`」「本番の Turnstile のウィジェットの秘密を Vercel と Supabase の両方へ」「`SUPABASE_ACCESS_TOKEN` を消す」）。
- [ ] **Step 6: 片付けと報告。** ダッシュボードで個人用トークンを消す。`wave6-prod-auth-config-*.json` は未追跡のまま（秘密は伏せてあるが、コミットしない）。`supabase-auth-config.md` に「実際に変えた日・値・戻した物」を足す。報告に、変えた項目の前後の値（秘密を除く）・戻した物・手で変える項目・`sb_secret_` の確かめの結果を書く。
- **戻す:** 段階 B だけ: `node wave6-prod-auth-config.mjs rollback security_captcha_enabled`（秘密は残る＝再度オンにするだけで戻る）。段階 A 全部: `rollback`（`rollback.json` の `restore` の値へ。変えていない鍵は送らない。`max_rows` は `postgrestMaxRows` の値で `PATCH …/postgrest` を手で）。M3: ヘッダーの ROLLBACK（アプリの画面を戻してから）。

---

## ruling（controller への確認。実装者は広げず、理由を書いて進める）

1. **Task 0 は隔離スタック（別の project_id・ポート）で測る。** G-1／H の 5 時間の E2E を止めずに済む。立たない時だけ主のスタックを窓で再起動する。隔離スタックは `postgres`・`gotrue`・`kong`・`mailpit` だけ（`-x` で他を外す）。Docker の容量が足りなければ controller の裁定で主のスタックに切り替える。
2. **手元の captcha の秘密は `env(SUPABASE_AUTH_CAPTCHA_SECRET)` で、値は未追跡の `supabase/.env` に置く。** 平文の公開のテスト用の値を `config.toml` に書く案は、`supabase config push` が本番へ「常に通る」秘密を押し出し、captcha を空にする危険がある（Review Focus 10）。代償: 新しい作業ツリーでは `supabase/.env.example` を写す手間が 1 つ増える。
3. **確認コードは DB の表（M3）に置く。** 署名つき Cookie だけの案（移行不要）は、単回使用・試行回数・「新しいコードで前を無効にする」が保てず、並列の推測を数えられない。代償: 移行 1 本・本番適用（オーナーの許可）。
4. **2 段（`start` で現行パスワード→ `confirm` でコードと新パスワード）にする。** 決定の「現行＋新しい＋コード」を 1 回の送信にまとめる案は、コードを送る前に新パスワードの検査ができる反面、`start` が現行パスワード無しでも呼べてしまい、盗んだ session の持ち主が本人のメールへコードを撒ける（メール枠の使い切り）。2 段なら `start` に現行パスワードが要る。
5. **現行パスワードの確認は service role の `signInWithPassword` で行い、作られた GoTrue の session をすぐ消す。** ハッシュを自前で比べる道は無い（ハッシュは GoTrue の中）。ログインの `signInWithPassword`（捨てるだけで消さない。回す物）と違い、変更は呼び出しの数が多くなりうるので消す。
6. **「現行パスワードを要求」は手元で設定できない**（P9。CLI の実行ファイルに環境変数の鍵が無い）。`SEC-AUTH-015-AC-02`(i) は ENV の印のまま、`SEC-AUTH-015-AC-05` として本番の Management API の GET で確かめる。隔離スタックで GoTrue を直接 `docker run` して測る案は、費用に見合わないので採らない。本番で実際に 400 になるかの試験（使い捨ての会員を本番に作る）はオーナーの許可が要る本番の書き込みなので、既定は GET の値の確認だけ。
7. **E2E の新しい spec は `FR-ACCOUNT-046`（決定のとおり）で、`scope.json` の AUTH の `e2e` に足す。** 要求は AUTH の持ち物（`documentation-guide` の「範囲の e2e の型に合わせる」ため）。代案の `FR-LOGIN-0NN` なら `scope.json` の変更は要らないが、画面が会員ページにあるので ACCOUNT を採る。
8. **再送にウィジェットを足さない。** 署名つき Cookie・IP と宛先の二段の枠（`login/resend/route.ts:41-56`）があり、(b') で直接の呼び出しは captcha で塞がる。再送のたびの検査は UX を壊す。
9. **GoTrue の変更通知とアプリの通知の二重**（P16）: Task 0 の F3 で、管理 API の変更でも GoTrue の通知が送られるなら、再設定の確定とパスワード変更で同じ件名が 2 通届く。**既定は両方送る**（直接の `/user` の変更を本人に知らせるために GoTrue 側は残す。件名を同じにしない＝アプリは「パスワードを変更しました」、GoTrue 側の件名は「パスワードの変更を受け付けました」にして区別する）。2 通が煩わしいとオーナーが言えば、アプリ側の通知を外す。
10. **`sb_secret_` が免除されない場合**: ①手元で測れなければ、本番の段階 B の確かめで初めて分かる（すぐ戻せる順で当てる）。②崩れたら、captcha 用の呼び出しにだけ旧方式の `service_role` の JWT を使う環境変数（案: `SUPABASE_AUTH_SERVICE_KEY`）を `createServiceRoleAuthClient` に足す。controller の裁定が要るので、実装者は作らない。③それも通らなければ ADR-0420 の見直す条件どおり (c) へ。
11. **本番の Turnstile の秘密**: ウィジェットが未作成なら、段階 A までを先に当て、段階 B は「ウィジェットの作成→ Vercel の `TURNSTILE_SECRET_KEY` と Supabase の captcha に同じ秘密」を台帳の項目にして保留する。本番の captcha がオフの間は、直接の呼び出しの穴は開いたまま（本番のアプリは未デプロイ・会員 8 人の今は許容。開店前に閉じる）。
12. **漏洩パスワードの確認（`password_hibp_enabled`）はプラン依存**（Supabase の公式: Pro 以上）。拒まれたら、アプリ側の `checkPwnedPassword`（登録・再設定・変更）が窓口を通る道を守り、直接の `/signup`・`/user` では効かないことを文書に残す（調査 §2-6 B）。
13. **`password_required_characters` は変えない**（NIST 800-63B-4 3.1.1.2: 構成規則を課さない）。本番が構成規則を課していれば、オーナーに知らせるだけ。
14. **`APP_ALLOWED_ORIGINS` の fail-closed は本番のビルドで止めるだけ**（決定）。`proxy.ts` の退避（未設定なら要求由来の origin）は共有ファイルなので変えない（`SEC-LOOK-018` の残り）。
15. **Supabase の「サインイン・サインアップの IP ごとの枠」は Management API に鍵が無い**（P10）。手で上げる（台帳）。サーバーから GoTrue へ利用者の IP を渡す方法は未検証で、開店前の確かめ（設計 `:269`）に残す。
16. **M3 の時刻は暫定**（`20261101120000`）。H の移行（`20261029130000` 以降）が本番未適用の可能性が高い。M3 だけを先に当てると本番の履歴が時刻の順を外れ、後の `db push --linked` が H の移行を `--include-all` 無しでは拒む。**M3 は H の移行が本番に届いた後に当てるのを既定にする**（波 5 の約束: H の移行は H の Task 12 とオーナーの確認まで当てない。Task 11 の Step 1 は保留して Step 2 以降へ進める）。先に当てる時は Task 11 Step 1 の `--include-all`／MCP の手順を台帳に残す。
17. **管理者・サポーターの変更は aal2 を必須にする。** GoTrue も MFA 済みの利用者に aal2 を求める（直接の道と同じ強さ）。一般会員は aal1。
18. **この端末の session も失効させる**（決定）。変更後は新しいパスワードで入り直す。
19. **漏洩確認の外部障害では通す**（再設定の確定と同じ。監査に残す）。
20. **回数**: 本人ごと 10 分 5 回（`start`・`confirm` それぞれ）、IP ごと 20 回／10 分。コードは 10 分・8 桁・5 回の誤りで使えなくなる。
21. **確認メールの雛形を目標の設定に足す（Task 8 のレビュー、2026-11-01。計画の範囲の追加）。** 手元の確認メールは GoTrue の既定の `ConfirmationURL`（`/auth/v1/verify`）のままだと、リンクを開いた時に GoTrue が印を使い切り、fragment を付けて `/api/auth/confirm` へ送る。確認の窓口（`src/app/api/auth/confirm/route.ts`）は query の `token_hash` を読むので `missing_token_hash` で落ち、session の Cookie が書かれず、会員登録の確定ができない（`enable_confirmations = true` に切り替えると、手元で本物の利用者が締め出されるのはここだけ）。そのため `[auth.email.template.confirmation]`（`supabase/templates/confirmation.html`＝`{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup`）を `pending-wave6/config.toml`・`config.patch`・`config-wave6.test.ts` に足した。`FR-SIGNUP-003` の `FR-LOGIN-004-AC-01` の印は外したまま（Task 10 Step 5 の残る ENV の印は 1 件のまま）。本番の確認メールの雛形も同じ前提なので、Task 9 の `supabase-auth-config.md` に同じ本文を載せる（ADR-0420 にも追記）。
22. **`magic_link.html` の「有効期限は5分です」は `config.patch` に入れる**（Task 8 のレビュー）。`otp_expiry = 300` に切り替えると、1時間のままでは利用者に嘘を言う。今の設定は 3600 なので、今ファイルを直すと逆に嘘になる。パッチに入れれば切り替えと同時に直る。確認メールの雛形（21）の「5分」も同じ `otp_expiry` に従う。
23. **`SEC-AUTH-015-AC-02` の (i) の試験名の先頭は `SEC-AUTH-015-AC-05`**（Task 8 での計画との差。ruling 6 の裁定を直す）。(i)「現行パスワード無しは 400（`current_password_required`）」の判定は AC-05 の文そのもので、AC-02 の文は (ii)「古い session は nonce 無しで 400（`reauthentication_needed`）」だけを言う。`scripts/trace/parse-tests.ts` は試験名の先頭の ID を読み、describe の名前を読まないので、AC-02 の describe の下にあっても AC-05 に結ばれる。AC-05 の e2e が `e2e-wave6.patch` の中にあるため、`validate-trace` の `missing-child` が 1 件増える（パッチを当てると 0）。
24. **Task 10 への申し送り（Task 8 のレビュー）。** ①`supabase/.env` を CLI が読むかは未確認。`db:start` の前に `SUPABASE_AUTH_CAPTCHA_SECRET` をシェルにも入れる。②起動の後に auth のコンテナの `GOTRUE_SECURITY_CAPTCHA_SECRET` が `1x0000000000000000000000000000000AA` であることを確かめる（`docker inspect` か `docker exec … env`）。空や `env(...)` の字のままでも、アプリの経路は管理者免除で通るので気付きにくい（補助のダミーを付けた直の呼び出しは全部 400 か 500 になり、E2E の赤が一斉に出る）。③`FR-SIGNUP-003` の `FR-LOGIN-004-AC-01` を最初に `--grep` で流し、確認メールの雛形（ruling 21）が効いて session の Cookie が書かれることを確かめる。④切り替えで `config.patch` が `magic_link.html` も変える（ruling 22）。

## 回す物（この波で直さない。理由つき）

- **ログインの `signInWithPassword` が GoTrue に残す session の後始末**（波 5 の P19）。結び付かないので無害。パスワード変更の確認の session は消す（上）が、ログインは別件。
- **`confirm`・`otp/verify` の `verifyOtp` を `createPublicClient` のままにすること**。`/verify` は captcha が掛からない（P2）。将来 GoTrue が掛けたら E2E で分かる。
- **Shopify 型のパスワードレスへの全面移行**（パスワード変更の問題自体が消える）。作りの変更が大きい（設計 §6）。
- **`has_permission` の `private` への移動・`public.sessions` の掃除・Custom Access Token Hook**（波 5 の回す物のまま）。
- **`password_change_challenges` の古い行の掃除**: `issue` が 1 日より古い行を消す。定期処理は不要。
- **Google ログインの新規登録**（`oauth/*`）: captcha は掛からない。別の穴は無い。
