# パスキー 最初の関門（手元の試し T1〜T7）計画

> **実行する人へ:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（推奨）か superpowers:executing-plans で、タスクごとに進める。手順は `- [ ]` で追う。

**Goal:** 設計書の 4-1「最初に手元で試す」T1〜T7 を、手元の Supabase CLI の GoTrue v2.196.0 で実測し、PASS/FAIL と設計への影響を結果の文書に残して、段1に進む前にオーナーに判断を仰ぐ。

**Architecture:** 試しは捨てる道具（Node の `.mjs` と Playwright の仮想認証器）で、ブラウザには鍵の操作（`navigator.credentials`）だけをさせ、GoTrue との通信は Node から `@supabase/supabase-js`（2.117.0 以上）の低い層の API で行う（設計 5-1 と同じ分担）。フック・RLS・引き金は、試し専用の表と関数を置いた手元の隔離スタックの DB で確かめる。本番・アプリ本体のコードは触らない。

**Tech Stack:** Supabase CLI 2.116.0（`npx.cmd supabase`。PATH には無い。既定の GoTrue は v2.196.0）、`@supabase/supabase-js` 2.117.0 以上（試しの道具の中だけに入れる）、Playwright（リポジトリの `@playwright/test`、Chromium、CDP の `WebAuthn.addVirtualAuthenticator`）、Postgres（フック・引き金・RLS）。

**Spec:** `docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（§3 決定、§4-1 T1〜T7、§5-1〜5-5、§6-2、§8、§10〜§12）。この計画は §4-1 だけ。段1〜4（§4-2）は含まない。参考: 波 6 の隔離スタックの記録 `.superpowers/sdd/2026-10-25-security-gap-fixes/wave6-task0-report.md`（`-x` の一覧、ポート、片付け、captcha のテスト用の秘密の入れ方、接続先の見張りの書き方）。

## Global Constraints

- 本番に触らない。`supabase config push`・`supabase db push`・本番の MCP・本番の鍵は使わない。
- `.env*` を読まない。鍵・トークン・JWT をログ・結果の文書・報告・コミットに書かない。鍵は `npx.cmd supabase status -o env --workdir …` の出力を環境変数に入れて使い、画面に出さない。
- `supabase` は PATH に無い。コマンドは必ず `npx.cmd supabase <サブコマンド> --workdir tmp/passkey-trials/stack` の形にする。`--workdir` を付け忘れるとリポジトリの共有スタックに当たる（I-13 の見張りで止める）。
- 手元の共有の Supabase と3000番は別のセッションと共有。共有の DB に `db reset` は流さない。共有の config を変える・再起動する前には合意が要る（Task 1）。
- 試しで `supabase/config.toml` を変えた場合（共有の分岐のみ）、試しの後で元に戻す（試しの前に写しを取る）。
- 設計の値をそのまま使う: GoTrue v2.196.0、supabase-js 2.117.0 以上、UV 必須（flags の 0x04）、始めの回数の制限は IP ごとに5分30回、窓は `session_id` に結ぶ、店員の上限は24時間。
- 同じ IP の回数の枠（5分30回）は全試しで共有。1つの試しで始め・終わりを呼ぶ回数を数え、25回を超える前に5分あける。T7（Task 9）は他の試しと並べず単独で流し、前後に5分あける。
- 「オーナーに戻る」は、実行者が**止めて、試しの出力を添えて controller に報告する**こと。実行者はオーナーに直接聞かない。controller がオーナーに伝え、返事を渡す。
- 試しの道具は捨てる。リポジトリの `package.json`・`package-lock.json`・`supabase/migrations/`・`src/`・`e2e/` を変えない。
- 試しは機能・UI の追加ではないので、`requirements.md`・E2E・`@impl` は足さない。docs で更新するのは結果の文書と、作業と指摘の台帳（Task 10）だけ。
- 日本語で書く。読みにくい漢字は使わず、ページは「ページ」と書く。

## Review Focus

設計は T1〜T7 の PASS/FAIL を決めているが、次の入力や条件は書いていない。偽の PASS・偽の FAIL につながる順に並べる。

1. 秘密の漏れ: 試しのログにトークン・鍵・パスワード・更新トークン・`hashed_token`・`email_otp`・CDP の秘密鍵が出て、結果の文書に写る。値の形だけでは伏せ切れない。→ Task 1 で値の形と鍵の名前の両方で伏せ、Task 10 で名前でも grep する。
2. フックが走ったかの確認: 通る場合は、フックが走らなくても通る。拒否の場合も、フックの記録は巻き戻って残らないことがある。→ Task 5 でパスキーのログインの道の行と、GoTrue のコンテナのログを確かめる。
3. 改ざんと2本目の登録での偽の FAIL: 登録の改ざん（attestation が none だと署名が無い）、同じ仮想認証器への2本目の登録（`excludeCredentials`）は、設計の崩れではなく試しの作りの失敗になる。→ Task 6・7 で対象を限る。
4. 回数の枠の取り合いによる偽の PASS・偽の FAIL: T7 以外の試しが同じ枠を使い、T7 の数えを狂わせ、他の試しを 429 で落とす。制限に1度も当たっていない「免除」は何も示さない。→ Task 9 で単独で流し、対照が 429 になることを先に示す。
5. 住所と接続先の食い違い: `localhost` と `127.0.0.1`・`::1`、ポートの違いで RP ID／origin が合わず設定ミスの FAIL になる。`--workdir` の付け忘れで共有のスタックに当たる。→ Task 2・3 で RP ID `localhost`・origin を固定し、最初の失敗は設定ミスから疑う。Task 1 の見張りで接続先を確かめる。

---

## 試しの場所と環境（決めたこと）

| 項目 | 決定 | 理由（1行） |
| --- | --- | --- |
| 道具の置き場 | `tmp/passkey-trials/`（`.gitignore` の `tmp/` で無視される。最後に丸ごと消す） | 追跡されないので誤ってコミットされず、リポジトリの `node_modules` を上の階層から引ける |
| supabase-js | `tmp/passkey-trials/package.json` に 2.117.0 以上を入れる（リポジトリの版は上げない） | 段1の実際の更新まで本体を汚さずに版を確かめられる。解決された版を結果に書く |
| Supabase | 既定は**試し専用の隔離スタック**（`tmp/passkey-trials/stack/supabase/config.toml`、project_id は `o_official_passkey`、ポートは波 6 と同じ API 55321・DB 55322・shadow 55320・pooler 55329・studio 55323・Mailpit 55324・analytics 55327・inspector 8084（共有の 543xx 番台と衝突しない。波 6 の隔離スタックは片付け済み）） | 共有の DB・ポートに触れず、`db reset` も不要。波 6 の隔離スタックと同じやり方（この機械で成功済み）。隔離ができない時だけ共有（Task 1 の分岐） |
| ブラウザ | 3100番の小さな静的サーバー（origin は `http://localhost:3100`）と Playwright の Chromium | 3000番は共有なので使わない。`localhost` は WebAuthn の安全な文脈として使える |
| 仮想の認証器 | CDP の `WebAuthn.addVirtualAuthenticator`（ctap2・internal・常駐鍵あり） | 設計 9 の方針と同じ |

T4 の UV 必須は、この仮想の認証器でも確かめられる。`hasUserVerification: true`・`isUserVerified: true` で UV の印が立つ応答、`hasUserVerification: false` で立たない応答を作れる。`hasUserVerification` は作った後に変えられない（変えられるのは `WebAuthn.setUserVerified` の `isUserVerified` だけ）ので、UV 無しの応答は別の認証器を作って得る。ソフトの認証器なので、確かめられるのは「サーバーが印を読んで拒否できるか」で、本物の PIN 無しの物理キーの挙動ではない。

## 作る物（すべて `tmp/passkey-trials/` の下）

| ファイル | 役割 |
| --- | --- |
| `package.json` | supabase-js（2.117.0 以上）と補助の依存だけ |
| `stack/supabase/config.toml` | 隔離スタックの config（リポジトリの `supabase/config.toml` の写しを元に、passkey・webauthn・フック・ポート・project_id だけ変える） |
| `lib/env.mjs` | スタックの URL と鍵を返す。接続先の見張りと、ログ用の `redact` |
| `lib/browser.mjs` | 3100番の静的サーバー、仮想認証器つき Chromium、ブラウザ側の `create`・`get` |
| `lib/passkey-flow.mjs` | 登録とログインの一連（始め → ブラウザ → 終わり） |
| `lib/uv.mjs` | UV の印の読み取り |
| `sql/*.sql` | 試し専用の表・フック・RLS・引き金 |
| `t1.mjs` 〜 `t7.mjs` | 各試しの実行ファイル。終了コード 0 が PASS、1 が FAIL、2 が設定ミス・判定不能（FAIL にしない） |
| `results/*.log` | 秘密を伏せた実行ログ |

---

### Task 1: 前提の確認と、試しの場所の準備

**Files:**

- Create: `tmp/passkey-trials/package.json`、`tmp/passkey-trials/lib/env.mjs`
- 確認だけ: `supabase/config.toml`、`.gitignore`

**Interfaces:**

- Produces: `env.mjs` の `getStackEnv(): {apiUrl: string, anonKey: string, serviceKey: string, dbUrl: string}`（API の URL・DB の URL のポートが、隔離スタックの 55321・55322 でなければ例外で止まる）、`assertIsolated(url: string): void`、`redact(text: string): string`。後の全タスクとすべてのスクリプトが使う。

- [ ] **Step 1: 事前の条件を確かめる（controller が済ませていること）。** 次をオーナーに伝えて承認を得た記録が controller から渡されていること。渡されていなければ、**ここで止めて controller に報告する**（実行者は聞かない）。
  - 手元の Docker に2つ目のスタックを動かす。別のセッションが長い E2E を流している間は、CPU・メモリを取り合い、あちらに環境由来の失敗を出しうる。流す時間の指定があればそれに従う。
  - 既定は隔離スタックで、共有の DB・3000番・`supabase/config.toml` には触れない。
  - 隔離ができない時だけの共有の分岐（Step 5）は、共有の config を変えて再起動し、試しのフックがパスワードのログインを拒否するので、別のセッションの E2E（会員・管理の手助けのパスワードのログイン）が落ちる。この分岐は、E2E を止める時間の合意か、フックの拒否を試しの利用者だけに限る形（`trial_staff` と専用のメールのドメインの人だけ）にする合意が出た時だけ使う。
- [ ] **Step 2: 3000番と Docker の状況を読むだけで確認する。** `Get-NetTCPConnection -LocalPort 3000 -State Listen`、`docker ps`。使う予定のポート（api・db・shadow・pooler・studio・inbucket・analytics・inspector。隔離では API 55321・DB 55322・shadow 55320・pooler 55329・studio 55323・Mailpit 55324・analytics 55327・inspector 8084 を使う）が空いていることを確かめる。期待: 衝突なし。
- [ ] **Step 3: `tmp/passkey-trials/` を作る。** `git check-ignore -v tmp/passkey-trials/x` が無視を示すこと。`package.json` に `@supabase/supabase-js` を 2.117.0 以上で入れ、`npm install` を**この階層だけ**で行う。`git status --short package.json package-lock.json` が空であること。版の確かめは **`tmp/passkey-trials/` の中で** `node -e "console.log(require('@supabase/supabase-js/package.json').version)"`（リポジトリ直下で流すと 2.103.3 を返す）が 2.117.0 以上。
- [ ] **Step 4: `lib/env.mjs` を作る。** `getStackEnv` は `npx.cmd supabase status -o env --workdir tmp/passkey-trials/stack` を子プロセスで呼び、何も標準出力に出さない。`assertIsolated` は、API の URL と DB の URL（パスワード付きなので `(?:[^@/]*@)?` を許す）のポートが隔離の API 55321・DB 55322 でなければ例外で止まり、`getStackEnv` と、DB に流すスクリプトのすべてが最初に呼ぶ。`redact` は、値の形（JWT の `eyJ…`・`sb_secret_`・`sb_publishable_`・`Bearer …`）と、鍵の名前（`access_token`・`refresh_token`・`token_hash`・`hashed_token`・`email_otp`・`password`・`privateKey`・`apikey`・`Authorization`）の値を `[REDACTED]` に置く。確認: `redact('{"refresh_token":"abc"}')` が値を伏せ、`assertIsolated('http://127.0.0.1:54321')` が例外になる。
- [ ] **Step 5（分岐。共有で行う合意が出た場合だけ）:** `supabase/config.toml` を `tmp/passkey-trials/config.toml.bak` に写す。以降の config 変更は Task 2 と同じ内容を共有の config に入れ、`db reset` は流さない。見張りの 55321・55322 は共有のポートに差し替えず、この分岐では `assertIsolated` を外さずに許可のポートを明示で足す（理由を結果に書く）。試しの終わり（Task 10）で、写しから戻す。
- [ ] **Step 6: 確認。** `git status --short` に、試しの前から在った変更以外が増えていないこと。コミットはしない。

---

### Task 2: 試し用スタックの config（passkey・webauthn）と起動

**Files:**

- Create: `tmp/passkey-trials/stack/supabase/config.toml`（リポジトリの `supabase/config.toml` を写して変更）
- Create: `tmp/passkey-trials/sql/00-base.sql`

**Interfaces:**

- Consumes: Task 1 の `getStackEnv`・`assertIsolated`。
- Produces: 動いている隔離スタック。`project_id = "o_official_passkey"`、ポートは API 55321・DB 55322・shadow 55320・pooler 55329・studio 55323・Mailpit 55324・analytics 55327・inspector 8084、`[auth.passkey] enabled = true`、`[auth.webauthn] rp_id = "localhost"`・`rp_origins = ["http://localhost:3100"]`・`rp_display_name`、`[auth.hook.custom_access_token]` は **Task 2 では `enabled = false`（Task 5 で `true` にする）**、`[auth.mfa.totp]` は触らない、`[auth.captcha]` は T1〜T6 では `enabled = false`（Task 9 で T7 のためだけに有効にする）。試し専用の表（`00-base.sql`）。

- [ ] **Step 1: config を作る。** リポジトリの `supabase/config.toml` を写し、上の項目だけ変える。`[auth.rate_limit]`・`otp_length = 8`・`otp_expiry = 300`・`jwt_expiry = 3600` は本番想定と同じまま。captcha を切る理由（T1〜T6 は captcha と別の確かめで、秘密を要さない）を config のコメントに1行書く。**起動で止まらないよう、波 6 と同じに直す**: リポジトリの `supabase/templates/` を `tmp/passkey-trials/stack/supabase/templates/` に写し（`content_path` が相対で `./supabase/templates/…` を指すため）、`[db.migrations]` と `[db.seed]` を `enabled = false` にする（写した先に `migrations/`・`seed.sql` が無いため。試し専用の表は `sql/*.sql` で入れる）。参考: 波 6 の `wave6-mkconfig.mjs` と `wave6-sandbox/`。
- [ ] **Step 2: 起動する。** `npx.cmd supabase start --workdir tmp/passkey-trials/stack -x <外す物>`。`-x` の一覧は波 6 の記録の一覧から **`postgrest` を除いた物**（T3 が `/rest/v1/` を使う）。Mailpit（inbucket）は残す。名前は `npx.cmd supabase start --help` で確認。期待: 起動し、`npx.cmd supabase status --workdir …` が隔離のポートを示す。共有の分岐では、合意済みの時だけ共有を停止・起動する。
- [ ] **Step 3: GoTrue の版を確かめる。** 起動した Auth のコンテナのイメージのタグを `docker ps --format` で読む。期待: `v2.196.0`。違えば結果の文書に実際の版を書き、判定の注に残す。
- [ ] **Step 4: passkey の有効化を確かめる。** `GET {apiUrl}/auth/v1/settings`（anon の鍵）の応答に passkey が有効であることを示す項目があるか読む（鍵名は実測で記録）。無ければ `POST /auth/v1/passkeys/authentication/options` が 404 でなく 200 か 4xx の本文を返すかで代える。期待: 404 でない。
- [ ] **Step 5: `sql/00-base.sql` を流す。** 試し専用の表だけ。`public.trial_staff(user_id uuid primary key, role text)`、`public.trial_window(user_id uuid, session_id uuid null, opened_at timestamptz, expires_at timestamptz)`、`public.trial_approved(user_id uuid, credential_id text)`（認めたパスキーの代わり）、`public.trial_hook_log(at timestamptz, event jsonb)`、`public.trial_config(key text primary key, value text)`（24時間の代わりの短い秒数を入れる）。共有の分岐でだけ使う `public.trial_users(user_id uuid primary key)`（Task 5 の書き分け用）も足す。`assertIsolated` を通してから流す。
- [ ] **Step 6: 確認。** `select count(*) from public.trial_staff` が 0 で返る。コミットしない。

---

### Task 3: T1 パスキーの登録とログイン、JWT の `aal` と `amr`

**Files:**

- Create: `tmp/passkey-trials/lib/browser.mjs`、`tmp/passkey-trials/lib/passkey-flow.mjs`、`tmp/passkey-trials/t1.mjs`

**Interfaces:**

- Consumes: `getStackEnv`、`redact`（Task 1）、動いているスタック（Task 2）。
- Produces: `startBrowser(): Promise<{page, cdp, authenticatorId: string, close(): Promise<void>, setUserVerified(verified: boolean): Promise<void>, recreateAuthenticator(opts: {hasUserVerification: boolean}): Promise<void>, addAuthenticator(opts: {hasUserVerification: boolean}): Promise<string>, removeAuthenticator(id: string): Promise<void>}>`、`registerPasskey(client, browser, opts?: {name?: string, uv?: 'required'|'preferred'}): Promise<{credentialId: string}>`、`loginWithPasskey(client, browser, opts?: {uv?: 'required'|'preferred'}): Promise<{session, claims: object}>`。Task 4〜9 が使う。`claims` は `access_token` の本文を Node でデコードした物（検証はしない）。`recreateAuthenticator` は認証器を作り直すので、常駐の鍵が消える（必要なら `WebAuthn.getCredentials` → `addCredential` で移す）。`removeAuthenticator(id)` は `WebAuthn.removeVirtualAuthenticator` で外す。ブラウザの API では認証器を選べず、`navigator.credentials.create` は利用できる認証器すべてに投げられるので、`registerPasskey` に認証器の指定の引数は持たせず、使う認証器は「足して・外す」で切り替える（1つ目の自動の在席を切る `WebAuthn.setAutomaticPresenceSimulation` でもよい）。

- [ ] **Step 1: `lib/browser.mjs` を書く。** 3100番の静的サーバー（Windows で `localhost` が `::1` に先に解決されることがあるので、`localhost` で待つか IPv4・IPv6 の両方で待つ）、Chromium、`WebAuthn.enable`、`WebAuthn.addVirtualAuthenticator`（ctap2、internal、常駐鍵あり、`hasUserVerification` と `isUserVerified` を引数で、`automaticPresenceSimulation: true`）。ブラウザ側の関数は、渡された選択肢（base64url の文字列）を ArrayBuffer に直して `navigator.credentials.create/get` を呼び、結果を base64url で返す。
- [ ] **Step 2: `lib/passkey-flow.mjs` を書く。** 設計 5-1 の分担に従い、supabase-js の低い層の API（`passkey.startRegistration`・`verifyRegistration`・`startAuthentication`・`verifyAuthentication` にあたる物）を使う。**メソッドの正確な名前・引数・戻りは、インストールした supabase-js の型定義（`.d.ts`）を読んで合わせる**。読めなければ、GoTrue の REST（`/auth/v1/passkeys/registration/options` など）を直に呼ぶ形に落とし、その旨を結果に記す。
- [ ] **Step 3: 失敗する試しを書く。** `t1.mjs`: 新しいお客さん（`admin.createUser` の確認済みのメール）の管理 API の magiclink を検証したセッションを作る → `registerPasskey` → サインアウト → `loginWithPasskey`。アサーション: ログイン後の `claims.aal === 'aal1'`、`claims.amr` の中に `method === 'passkey'` がある。`claims.amr` の中身全体（method と timestamp）を `redact` 経由でログに出す。
- [ ] **Step 4: 実行して結果を読む。** `node tmp/passkey-trials/t1.mjs`。登録の始めが失敗したら、まず RP ID／origin の食い違い（`localhost`・3100番）を疑う（Review Focus 5。設定ミスは終了コード 2）。期待: 終了コード 0。
- [ ] **Step 5: PASS の判定と FAIL の時。** PASS: 登録とログインがともに成功し、`aal1` かつ `amr` に `passkey`。FAIL: 設計 4-1 のとおり、作り方を見直す前提が崩れたので**止めて controller に報告する（オーナーに戻る）**。
- [ ] **Step 6: 結果を控える。** 実際の `amr` の形、`access_token` に `session_id` があるか、エラー文の形、GoTrue に始め・終わりを呼んだ回数を `results/t1.log` に。コミットしない。

---

### Task 4: T3 RLS の中で `auth.jwt()` の `amr` を読む

（T3 を先にするのは、フック無しで確かめられ、T1 の JWT だけで足りるため。）

**Files:**

- Create: `tmp/passkey-trials/sql/03-rls.sql`、`tmp/passkey-trials/t3.mjs`

**Interfaces:**

- Consumes: `loginWithPasskey`（Task 3）、`public.trial_config`（Task 2）。
- Produces: `public.trial_passkey_probe` 表と、(a) `amr` に `passkey` がある、(b) その `passkey` の `timestamp` が今から `trial_config('staff_max_age_sec')` 秒以内、の両方を満たす時だけ読める RLS。

- [ ] **Step 1: `sql/03-rls.sql` を書く。** `trial_passkey_probe(id int, note text)` に1行を入れ、RLS を有効にして `authenticated` への SELECT の方針を上の (a)(b) とする。(a) は `jsonb_array_elements(auth.jwt()->'amr')` で `method = 'passkey'` を探す。(b) は同じ要素の `timestamp`（秒）と `extract(epoch from now())` の差で比べる（設計 5-2 の管理の入口の2つ目の条件が頼る）。
- [ ] **Step 2: 失敗する試しを書く。** `t3.mjs`: ① パスキーでログインした JWT で PostgREST（`/rest/v1/trial_passkey_probe`）が1行を返す、② 同じ人の magiclink のセッション（`amr` に `passkey` が無い）では0行、③ `staff_max_age_sec` を小さく（例: 5）して待ち、同じパスキーの JWT（まだ期限内）で読むと0行、をアサートする。**③のあと、`trial_config` の `staff_max_age_sec` を 20 に戻す**（Task 5 が前提にする値）。
- [ ] **Step 3: 実行。** `sql/03-rls.sql` を隔離の DB に流してから `node tmp/passkey-trials/t3.mjs`。期待: ①1行 ②0行 ③0行。
- [ ] **Step 4: 判定。** PASS: RLS の中で `amr` が読め、`passkey` かの判定と時刻の比較ができる。FAIL: 設計 4-1 のとおり、フックで独自の印を JWT に足して読む形に変える。これはオーナーに戻らず、結果と影響に書く。
- [ ] **Step 5: 結果を控える。** `amr` が JSON の配列で来る実際の形（`jsonb_array_elements` が使えたか、`timestamp` の型）を `results/t3.log` に。

---

### Task 5: T2 Custom Access Token フックで店員の締め付け（ログイン時と更新時）

**Files:**

- Create: `tmp/passkey-trials/sql/02-hook.sql`、`tmp/passkey-trials/t2.mjs`
- Modify: `tmp/passkey-trials/stack/supabase/config.toml`（`[auth.hook.custom_access_token] enabled = true`、`uri = "pg-functions://postgres/public/trial_hook"`）

**Interfaces:**

- Consumes: Task 2 の `trial_staff`・`trial_config`・`trial_window`・`trial_approved`・`trial_hook_log`、Task 3 の `loginWithPasskey`。
- Produces: `public.trial_hook(event jsonb) returns jsonb`。設計 5-2 の表の分岐を最小で写す。
  - 【共有のスタックの分岐でだけ使う書き分け】フックの拒否と締め付けの対象を、`trial_users(user_id)`（試しの利用者だけを入れる表。`00-base.sql` に足す）に載っている人に限る。載っていない人は、元の入力のまま素通しにする（パスワードのログインも拒否しない）。隔離スタックでは使わず、全員を対象にする。
  - 店員（`trial_staff`）で `amr` に `passkey` があり、そのログインの時刻から `staff_max_age_sec`（試しでは 20）以内なら通す。通す時、`trial_approved` の本数が2本以上かを独自の印 `trial_approved_passkeys_ok`（bool）として JWT に足す。
  - 店員で窓が開いていて `session_id` が窓の行と同じなら通す（Task 6 が使う）。店員のそれ以外は `{"error": {...}}`。
  - お客さん（`trial_staff` に行が無い）は `password` だけ拒否し、他は通す。
  - 入力を `trial_hook_log` に残す。

- [ ] **Step 1: `sql/02-hook.sql` を書く。** 関数、`supabase_auth_admin` への権限（`grant execute`・`trial_*` 表への `select`/`insert`/`update`。`revoke execute … from public, authenticated, anon`）を含める。**先に `trial_config` の `staff_max_age_sec` を 20 に入れ直し、`select` で 20 であることを確かめる**（Task 4 の③で 5 に縮めたため）。**実際に要った権限の組み合わせを控える**（設計 11 は作り手に任せているので、段1の材料になる）。
- [ ] **Step 2: フックを有効にして Auth を再起動する。** `npx.cmd supabase stop --workdir …`（`--no-backup` を付けない。DB を残す）→ `npx.cmd supabase start --workdir … -x …`。期待: 起動し、Task 3 の `t1.mjs` がまだ PASS する（フック有りでお客さんが通る）。
- [ ] **Step 3: 店員の用意の順と、フックの入力の実形。** 店員はパスキー以外のログインが拒否されるので、先にお客さんのうちに、管理 API の magiclink で入って `registerPasskey` を2本（Task 6 と同じ「外して足す」で）済ませ、その鍵を `trial_approved` に入れてから、`trial_staff` に入れる。この順にしないと店員のセッションが作れず止まる。そのうえで、`t2.mjs` の最初に、店員のパスキーのログインを1度して `trial_hook_log` の `event` を読み、`amr`・`authentication_method`・`session_id` の位置を `results/t2.log` に書く。**そのログインの行（`authentication_method` がパスキー、`session_id` あり）が `trial_hook_log` にあること**をアサートする（フックがパスキーのログインの道で実際に走った証拠。通る場合は走らなくても通るため）。
- [ ] **Step 4: 通る場合の試し。** 次をアサートする。
  - 店員がパスキーでログイン → トークンが出る。JWT に `trial_approved_passkeys_ok` が入っている（`trial_approved` に2本入れた人）。
  - 更新の順番を決める: パスキーで入る → 約10秒で `refreshSession`（通る。印が更新後の JWT にも入っている。更新の行が `trial_hook_log` にある）→ その更新で得たトークンで約25秒時点で `refreshSession`（拒否）。こうすると、時刻の基準が最後の更新でなくログインの時刻だと示せる。24時間は待てないので上限を縮めて検証し、縮めた上限で動くこと自体が時刻の比較の確認であることを結果に書く。
  - お客さんがパスキー・メールのコードでログイン → 通る（Review Focus 2 の対照）。
- [ ] **Step 5: 拒否の場合の試し。** 次をアサートする。拒否の記録はトランザクションの巻き戻りで `trial_hook_log` に残らないことがあるので、拒否の確認は応答と、隔離スタックの GoTrue のコンテナのログ（`docker logs`）で取る。`docker logs` の出力も `redact` を通してから `results/` に置く。
  - 店員が管理 API の magiclink でログイン → 拒否。
  - 店員がメールのコードでログイン → 拒否。`admin.generateLink` の `email_otp` を `verifyOtp({type:'email'})` で使い、メールを読まずに済ませる。magiclink と `amr` が違う見込みなので別々に試す。
  - 店員がパスワードでログイン → 拒否（`admin.createUser` でパスワード付きのアカウントを作り、通常のパスワードのログインを試す）。
  - 拒否の HTTP 状態・エラーコード・メッセージの形を記録し、アプリが「店員はパスキーで」に直せる見分けができるか判定する（Review Focus 2）。
  - お客さんがパスワードでログイン → 拒否（password だけ拒否）。
- [ ] **Step 6: 直の SQL 呼び出し。** フックの関数を `psql` から直に呼ぶ。`amr` が空・`authentication_method` が欠けた入力では、店員は拒否側、お客さんは通す側に倒れること。Google（`oauth`）は手元で本物を使えないので、`oauth` の `amr` を持つ入力を関数に直に渡して拒否されることで代え、実際の Google のログインは**試していない**と結果に書く。
- [ ] **Step 7: 実行と判定。** `node tmp/passkey-trials/t2.mjs`。PASS: ログイン時と更新時の両方で店員の「パスキー以外」と「上限超え」を拒否でき、お客さんは通り、独自の印が JWT に入る。FAIL: 設計 4-1 のとおり、店員の締め付けを5-2 の予備（アプリの結び付けで店員のパスキー以外を書かず `private.app_session_is_live` で拒否）に組み替える。**ここで止めて controller に報告する（オーナーに戻る）**。独自の印だけが入らない場合は T3 の予備に響くので、結果に書く。
- [ ] **Step 8: 結果を控える。** フックの入力の形、拒否の応答の形、必要だった権限、再起動に要した時間、**拒否された更新の後、その更新トークンが使えなくなったか（回されたか）とセッションの行が残るか**（段1の材料）を `results/t2.log` に。

---

### Task 6: T6 招待のセッションでパスキー2本、`session_id` と窓の突き合わせ

**Files:**

- Create: `tmp/passkey-trials/sql/06-window.sql`（Task 5 のフックの窓の分岐を、案 A・B の分だけ直す）、`tmp/passkey-trials/t6.mjs`

**Interfaces:**

- Consumes: `trial_hook`・`trial_window`・`trial_approved`（Task 5）、`registerPasskey`・`addAuthenticator`・`removeAuthenticator`（Task 3）、`admin.generateLink`。
- Produces: 「窓の開け方」の実測結果。設計 6-2 の手順 3 は、セッションが作られる前には `session_id` が分からない。次の2案を実測して、通る方を結果に書く。
  - 案 A: 窓を `session_id` 無し（ユーザーと期限だけ）で先に開け、フックが最初のトークンの発行時にその `session_id` を窓の行に書き込む。結び方の決まり: **`session_id` が null で、期限内で、`opened_at` から60秒以内の行だけ**を、`update … where session_id is null` の1文で**1回だけ**結ぶ。2つ目のセッションは結ばない。
  - 案 B: 最初の検証だけは窓の無い状態で通るように、店員の役割を窓を開けた後に有効にする。

- [ ] **Step 1: 設計のあいまいさを確認する。** 6-2 手順 3「合言葉を確かめ、その場で GoTrue のセッションを作り、同時に窓を開ける」と 5-2「窓の行に控えた `session_id`」は、最初のトークンの発行の時点で窓の行の `session_id` が決まっていない。T6 は、このあいまいさを実測で解く試しとして書く（結果に設計の直しの提案を書く）。
- [ ] **Step 2: 案 A を試す。** `t6.mjs`: ① `admin.createUser`（パスワード無し）→ `trial_staff` に入れ窓を開ける（`session_id` が null）→ `admin.generateLink({type:'magiclink'})` の `hashed_token` を `verifyOtp({token_hash, type:'magiclink'})` で検証してセッションを得る。② 検証の時にフックへ入った `session_id` と、得たセッションの JWT の `session_id` が同じで、窓の行にも結ばれていること。③ **アプリの側の突き合わせ**: 検証の応答の JWT の `session_id` が窓の行の値と同じかを確かめる関数を `t6.mjs` に置き、違えば窓を閉じて失敗にする。④ 窓が開いて `session_id` が null の間に、同じ人のメールのコードの別のセッションを先に発行させる。その場合に、結ばれたのがどちらのセッションかを記録し、**フックの拒否か③の突き合わせのどちらかで、閉じる側に倒れること**を確かめる（先にメールのコードのセッションが結ばれると、招待の検証はフックが拒否するので③までは届かない。黙って通らないことが要点）。メールのコードのセッションが窓に結ばれて通る（店員のパスキー無しのセッションが出る）ことがあれば、それ自体を結果に危険として書く。
- [ ] **Step 3: 登録を試す。** ⑤ 招待のセッションで `registerPasskey` を2本。**2本目の前に、1つ目の認証器を `removeAuthenticator` で外してから `addAuthenticator` で別の仮想認証器を足す**（足すだけでは1つ目が残り、除外の鍵を持つ1つ目から `InvalidStateError` が先に返りうる。その失敗は設計の崩れではない）。登録の始め・終わりが通り、`auth.webauthn_credentials`（名前は実測で確認）に2行ができること。⑥ 登録の後も、**そのセッションの `amr` に `passkey` が付かない**こと（設計 6-2 手順 5 の前提。付くなら招待のセッションが店員のセッションとして通ってしまう）。⑦ 窓が開いている間の `refreshSession` が通り、窓を閉じた（行を消した）後は拒否されること。⑧ 別のセッション（同じ人のメールのコード）は、窓が結ばれた後に開いていても拒否されること（窓がセッションに結ばれている）。
- [ ] **Step 4: 案 B を試す（案 A が通らない時、または比較のため）。** 窓を開けた後に店員の役割を有効にし、最初の発行が通るか確かめる。外す・付け直す時に監査や知らせの副作用が出るかを結果に書く（今いる店員のやり直し〔6-2〕は役割を一度外すことになる）。
- [ ] **Step 5: 判定。** PASS: 招待のセッションでパスキーを2本登録でき、フックの入力の `session_id` が窓の行と突き合わせられる（案 A か B のいずれかで）。FAIL: 設計 4-1 のとおり、招待の流れ（6-2）の組み直し。設計の指示は「組み直す」だけでオーナーに戻るとは書いていないが、この計画は厳しい側に倒して**止めて controller に報告する**。
- [ ] **Step 6: 結果を控える。** 通った案、フックが書き込めたか（書き込みは拒否の時に巻き戻るので、拒否の記録は応答とコンテナのログで読む。ログは `redact` を通してから置く）、2本目の登録に制限が出たか（`aal` や `max_enrolled_factors` の影響）、`amr` に `passkey` が付かないことを `results/t6.log` に。

---

### Task 7: T4 UV を必須にでき、サーバーが UV の印を読める

**Files:**

- Create: `tmp/passkey-trials/t4.mjs`、`tmp/passkey-trials/lib/uv.mjs`

**Interfaces:**

- Consumes: `startBrowser`（`setUserVerified`・`recreateAuthenticator`・`addAuthenticator`・`removeAuthenticator`）、`registerPasskey`・`loginWithPasskey`（Task 3）。
- Produces: `readUvFlag(authenticatorDataB64url: string): boolean`（`authenticatorData` の37バイト目の flags の `0x04`）。

- [ ] **Step 1: `lib/uv.mjs` の `readUvFlag` を書く。** 入力は base64url の `authenticatorData`、戻りは UV の印の有無。
- [ ] **Step 2: 失敗する試しを書く。** `t4.mjs` は次をアサートする。UV 無しの認証器は `hasUserVerification: false` の別の認証器を作って得る（作った後に変えられないため）。
  1. 始めの選択肢の JSON の `userVerification`（ログイン）／`authenticatorSelection.userVerification`（登録）を、アプリ側で `required` に書き換えて、UV あり・`isUserVerified: true` の認証器に渡す。登録とログインが通り、届いた応答の `readUvFlag` が `true`。
  2. UV 無しの認証器で、選択肢を**書き換えない**（GoTrue の `preferred` のまま）。前提の確かめとして、**GoTrue の終わりの窓口を1回だけ呼び**、検証が通ってしまうこと（設計 5-3 の前提）と、同じ応答の `readUvFlag` が `false` であることを確かめる。これとは別に、門の関数（`readUvFlag(...) === false` なら終わりの窓口を呼ばずに拒否する判定）を `t4.mjs` の中に置き、窓口を呼ばないことを（呼び出し回数 0 で）アサートする。
  3. 書き換えて `required` にした選択肢を UV 無しの認証器に渡すと、ブラウザ自体が失敗するか（記録）。`setUserVerified(false)` で UV あり認証器が検証に失敗した時の挙動も記録。
  4. 改ざん（**ログイン（assertion）だけ**）: UV 無しの認証器のログインの応答の `authenticatorData` の flags の `0x04` を立てて GoTrue に送ると、署名の検証で拒否される（設計 5-3「書き換えれば検証で落ちる」）。登録の応答は改ざんを assertion にしない: attestation が `none` だと `authenticatorData` に署名が無く、flags を書き換えても GoTrue が通す見込みが高く、偽の FAIL になる。登録の改ざんは参考として結果を記録するだけで、PASS/FAIL に数えない。
- [ ] **Step 3: 実行。** `node tmp/passkey-trials/t4.mjs`。期待: 1 は通る。2 は GoTrue が通すが `readUvFlag` が false。4 は GoTrue が拒否。
- [ ] **Step 4: 判定。** PASS: UV を必須の選択肢にでき、サーバーが印を読め、ログインの改ざんが GoTrue で落ちる。FAIL: 設計 4-1 のとおり、UV の確かめはあきらめて危険として残す。**止めて controller に報告する（オーナーに戻る）**。
- [ ] **Step 5: 限界を書く。** ソフトの認証器での確かめであり、PIN 無しの物理キーの実機の挙動は未確認、と結果に明記する。登録の UV の確かめは参考で、本当の守りはログインの確かめだと書く。

---

### Task 8: T5 パスキーの追加・削除を DB の側で拾う

**Files:**

- Create: `tmp/passkey-trials/sql/05-trigger.sql`、`tmp/passkey-trials/t5.mjs`

**Interfaces:**

- Consumes: `registerPasskey`・`loginWithPasskey`（Task 3）。新しい表 `public.trial_passkey_events(at timestamptz, op text, credential_id text, user_id uuid)`。
- Produces: 引き金（または audit）で拾える経路と拾えない経路の一覧。

- [ ] **Step 1: 実際の表を確かめる。** `\dt auth.*` と `\d auth.webauthn_credentials` で、表の名前・列・所有者を読む（設計は `auth.webauthn_credentials` と書いている。実測で違えばその名前に直す）。
- [ ] **Step 2: 引き金を作れるかを試す。** `sql/05-trigger.sql` で `auth.webauthn_credentials` への AFTER INSERT／UPDATE／DELETE の引き金を、`postgres` で作る。権限で失敗したら失敗の文言を記録し、`supabase_admin` で作れるかも試して**記録だけする**。`supabase_admin` でだけ作れた引き金は、本番では使えないので PASS に数えない。`postgres` で作れなければ `auth.audit_log_entries` を読む案に切り替え、パスキーの追加・削除がどの `action` で記録されるかを読む。
- [ ] **Step 3: 失敗する試しを書く。** `t5.mjs`: 次の各経路で `trial_passkey_events`（または audit）に行が出るかを記録する。① アプリ相当の登録（本人のトークンで GoTrue の登録）、② 管理 API でパスキーを消す・一覧する道（あれば。無ければこの項目は外し、無いと記録する。①と本人のトークンでの直叩きは DB から見ると同じ道なので別に数えない）、③ 本人のトークンでの削除、④ 名前の変更、⑤ SQL での直の削除、⑥ ユーザーの削除による連鎖。①〜③・⑤・⑥で行が出ることをアサートし、④ は出る・出ないを記録する。
- [ ] **Step 4: 実行。** `node tmp/passkey-trials/t5.mjs`。
- [ ] **Step 5: 判定。** PASS: 追加と削除のどの道でも DB の側で、`postgres` で作れた引き金か、audit のどちらか一方で拾える（どちらを採るかを書く）。FAIL: 設計 4-1 のとおり、拾える範囲だけ知らせ、残りを危険として残す。**これはオーナーに戻らず**、結果に書く。
- [ ] **Step 6: 注意を書く。** 引き金は GoTrue の更新（移行）で消されないか、本番（Supabase の管理されたプロジェクト）で `auth` の表に引き金を作れるかは、手元の結果から言えない。audit の道を採る場合は、本番で `auth.audit_log_entries` に書かれる設定か（ダッシュボードの切り替え）も言えない。どちらも 8-2（本番の確認）に回す未確認として結果に書く。

---

### Task 9: T7 始めの回数の制限がサービスの鍵で免除されるか、captcha との関係

**Files:**

- Create: `tmp/passkey-trials/t7.mjs`
- Modify（一時）: `tmp/passkey-trials/stack/supabase/config.toml`（captcha を有効にするのは 9b の間だけ）

**Interfaces:**

- Consumes: `getStackEnv`（Task 1）。登録済みのパスキーは不要（`/passkeys/authentication/options` は未ログインで呼べる想定。呼べなければ記録する）。

- [ ] **Step 1（準備）: 単独で流す。** ほかの試しがすべて終わり、直前の GoTrue への呼び出しから5分あいていること。T7 の最中は ほかの試しを流さない（同じ IP の枠を取り合い、T7 の数えを狂わせ、ほかの試しを 429 で落とす）。
- [ ] **Step 2（9a 回数の制限）: captcha を切ったまま、** 同じ IP から、ブラウザを使わず `POST /auth/v1/passkeys/authentication/options` を直接叩く。順序: ① サービスの鍵（JWT 形の service role と、使えれば `sb_secret_`）で35回続けて呼ぶ。② 5分あける。③ 対照として匿名の鍵で35回呼ぶ。アサーション: ③ で31回目付近から 429 が返る（制限が実際に効いている）。① で1度も 429 が出なければ「免除」。
- [ ] **Step 3: 実行と判定。** `node tmp/passkey-trials/t7.mjs`。③ で 429 が出なければ、制限に当たっていないので判定不能（終了コード 2）。この場合 IP の見え方（X-Forwarded-For の扱い）を調べて直し、やり直す（Review Focus 4）。PASS（免除される）: 始めはサーバーから呼べる（5-1）。免除されない: 設計 4-1 のとおり、始めはブラウザから GoTrue を直に呼ぶ。これは設計内の分岐で、オーナーに戻らず結果に書く。
- [ ] **Step 4（9b captcha）:** 9a の後、5分あけて captcha を有効にして再起動する（波 6 と同じ Cloudflare のテスト用の秘密を**シェルの環境変数だけ**で渡す。ファイル・ログ・結果には書かない）。匿名の鍵でパスキーの始め・終わり（登録の始め・終わりを含む。登録は本人のトークンが要る）が、captcha のトークン無しで 400 `captcha_failed` になるか、サービスの鍵では免除されるか、captcha のトークン（テスト用の秘密に対するダミーのトークン）を付ければ通るかを、数回ずつ呼んで記録する（回数の枠に当たらない少数）。これで設計 6-1 の「パスキーの始めに Turnstile を付けるか」の根拠が出る。終わりの窓口は、本物の応答が無いと形の誤りで先に落ちて captcha の確かめにならないことがあるので、エラーコードで読み分け（`captcha_failed` か、応答の形の誤りか）、読み分けられなければ「判定不能」と書く。結果の読み方: 匿名で `captcha_failed` かつサービスの鍵で免除なら、サーバーから呼ぶ始めに Turnstile のトークンは要らず（鍵が免除される。設計 6-1 の「付けない」）、ブラウザから直に呼ぶなら Turnstile を付けるしかない。匿名でも `captcha_failed` にならないなら、パスキーの窓口は captcha の対象外で、Turnstile を付けても GoTrue は見ない、と書く。再起動は `--no-backup` を付けない（DB を残す）。終わったら captcha を切った config に戻す。
- [ ] **Step 5: 注意を書く。** 手元の GoTrue の回数の制限と captcha の挙動が、本番のホスト版と同じ値・同じ免除かは、ここから確定しない。8-2 で本番の応答ヘッダを確認する未確認として書く。

---

### Task 10: 結果の文書を書き、台帳を直し、後始末をして、オーナーに戻る

**Files:**

- Create: `docs/superpowers/specs/2026-11-16-passkey-local-trial-results.md`（設計書に場所の指定が無いので、設計と同じ階層に置く）
- Modify: `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（作業と指摘の台帳。パスキーの行の状態欄）
- 後始末: `tmp/passkey-trials/`、隔離スタック、（共有の場合）`supabase/config.toml` と共有の DB の `trial_*`

- [ ] **Step 1: 結果の文書を書く。** 設計書と同じ様式（冒頭に対象・関連・確認日。概要の表、本文）。含めること: GoTrue と supabase-js の実際の版、各 T1〜T7 の PASS/FAIL（または判定不能）と根拠の1〜2行、FAIL の時の設計の指示とそれによる決定への影響（設計のどの節を直すか）、Task 6 で見つけた設計のあいまいさ（窓の `session_id` の決まる順）と実測の答え・設計の直しの提案、T7 の captcha の結果、段1の材料（フックに要った権限、拒否の応答の形、`amr` の実際の形、`passkey` 関連の SDK のメソッド名と引数、拒否された更新トークンの扱い）、未確認として本番の確認（8-2）に回す物の一覧（Task 7・8・9 の注意と Google の `oauth`）。トークン・鍵は書かない。
- [ ] **Step 2: 秘密が無いか確かめる。** 結果の文書と `tmp/passkey-trials/results/` に対して、値の形（`eyJ`・`sb_secret_`・`sb_publishable_`・`Bearer` の後ろに値が続く行）に加え、鍵の名前（`access_token`・`refresh_token`・`token_hash`・`hashed_token`・`email_otp`・`password`・`privateKey`・`apikey`・`Authorization`）の後ろに値が続く行を grep する。期待: 0件（Review Focus 1）。
- [ ] **Step 3: 台帳を直す。** 台帳（34行目あたりのパスキーの行）の状態欄に、試しの結果（済み・日付・結果の文書へのリンク）を書く。
- [ ] **Step 4: 文書を確かめる。** `npm.cmd run validate-docs` が通ること。必要なら `docs/README.md` の該当の一覧から相対リンクを張る（バリデーターが要求する場合のみ）。
- [ ] **Step 5: 後始末をする。** 隔離スタックを `npx.cmd supabase stop --workdir tmp/passkey-trials/stack --no-backup`（データは使い捨て）。その project_id のコンテナ・ボリューム・ネットワークが残っていないことを `docker ps -a`・`docker volume ls`・`docker network ls` で確かめる。3100番の静的サーバーが残っていないこと。`tmp/passkey-trials/` を丸ごと消す（結果の文書に要点を写した後）。共有の分岐を使った場合は、写しから `supabase/config.toml` を戻して `git diff --stat supabase/config.toml` が空であること、共有の DB の `trial_*` の表・関数・試しの利用者を消すこと、共有のスタックが元の状態で再起動されることを、controller 経由でオーナーと確かめる。
- [ ] **Step 6: コミット（オーナーが求めた時だけ）。** 結果の文書と台帳の2ファイルだけを `git add`（未追跡の `.superpowers/` や他の変更をまとめて足さない）。
- [ ] **Step 7: オーナーに戻る。** 実行者は、T1〜T7 の表（PASS/FAIL）、決定に効く点、設計の直しの提案を短く controller に報告する。controller が、「この結果で段1の計画を作ってよいか」をオーナーに聞き、返事を待つ。返事が出るまで段1に進まない。

---

## 自己レビュー

- 設計 §4-1 の T1〜T7 は Task 3（T1）、Task 5（T2）、Task 4（T3）、Task 7（T4）、Task 8（T5）、Task 6（T6）、Task 9（T7）に1つずつ対応。FAIL の時の指示（オーナーに戻る／予備／拾える範囲だけ／設計内の分岐）を各タスクの判定の手順に入れた。「オーナーに戻る」は controller への報告と定義した。
- 順番: 準備（1）→ 起動（2）→ T1（3）→ T3（4。フック不要）→ T2（5。フック）→ T6（6。フックの窓を使う）→ T4（7）→ T5（8）→ T7（9。単独で流し、前後に5分あける）→ 結果（10）。
- 型の一貫: `getStackEnv`・`assertIsolated`・`redact`（Task 1）、`startBrowser`・`recreateAuthenticator`・`addAuthenticator`・`removeAuthenticator`・`setUserVerified`・`registerPasskey`・`loginWithPasskey`（Task 3）、`trial_staff`・`trial_window`・`trial_approved`・`trial_hook_log`・`trial_config`（Task 2・4・5・6）、`trial_hook`（Task 5・6）、`readUvFlag`（Task 7）、`trial_passkey_events`（Task 8）を後のタスクで同じ名前で使っている。
- Review Focus の5つは Task 1（見張り・redact）、Task 5・6（フックの確認）、Task 6・7（偽の FAIL）、Task 9（枠）、Task 2・3（住所）に試しとして入っている。
- 長さは設計書より短く、コードの本文は書いていない。
