# 本番の Supabase Auth の設定（captcha・パスワード変更・OTP・MFA）

> 状態: 目標の値と手順（本番への適用は未実施。2026-11-01 に MCP で試して不可。2026-11-06 にオーナーがダッシュボードで変えると決め、「ダッシュボードで変える手順（オーナー向け）」を書いた。確認メールの必須だけは本番がすでに目標の値） | 確認日: 2026-11-22 | 対象: 本番の Supabase プロジェクト `pjidrgofvaglnuuznnyj` の Auth と PostgREST の設定、手元の `supabase/config.toml` との対応 | 設計判断: [ADR-0420](../03_BasicDesign/decisions/ADR-0420-auth-supabase-captcha-with-service-role-auth-calls.md)（captcha）、[ADR-0421](../03_BasicDesign/decisions/ADR-0421-auth-password-change-by-app-window-with-emailed-code.md)（パスワード変更。段4で廃止）

## 概要

守りの穴の波 6 で、Supabase の captcha を有効にし、アプリのパスワード変更の窓口を GoTrue の設定と組み合わせる。手元の `supabase/config.toml` は本番の前提にそろえるが、**本番の Auth の設定は `config.toml` ではなく本番の Management API かダッシュボードが正**である。この文書は、本番の目標の値、API に鍵が無い・プラン依存で手で変える項目、変える手順と戻し方、3 回試して通らなかった時のダッシュボードの手順をまとめる。

- 本番のアプリは未デプロイ（Vercel にプロジェクト無し）。本番の Auth の現在値は未読。
- 本番を変える作業は、オーナーの許可のもとで 1 項目ずつ行う。許可なしに変えない。
- 値の変更前に必ず今の値を読んで控える。秘密の値（Turnstile の秘密、`sbp_` のトークン）は、この文書・ログ・報告・コミットに書かない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 要件 | `SR-AUTH-030`・`FR-AUTH-053`・`FR-AUTH-055`・`SEC-AUTH-060`（パスワードと認証アプリのログインの廃止。旗は移行 J。パスワード変更・再設定の要求と、TOTP の監査の要求は段4で廃止した）、`SEC-AUTH-015`（直接の道の守り。AC-01・AC-04・AC-05。パスワード変更の窓口は段4で消えたので、GoTrue の設定の確かめだけが残る）、`SEC-AUTH-035`（captcha を免除される呼び出し）、`SEC-AUTH-029`（OTP の期限） |
| 関連コード | `src/lib/auth/service-role-auth-client.ts`（captcha を免除される呼び出し。今はメールのコードの始めと再送だけが使う）、`src/lib/build-env-guard.ts`（パスワード変更の窓口 `src/app/api/auth/password/change/{start,confirm}/route.ts` は段4で消した） |
| 関連文書 | [シークレット管理方針](secrets.md)、[配置構成](deployment-topology.md)、[DB マイグレーション](db-migrations.md) |
| 根拠 | GoTrue のソース読み（`middleware.go` の管理者免除）、手元の隔離スタックでの実測（2026-11-01）、Management API の公式 OpenAPI（`https://api.supabase.com/api/v1-json`、2026-11-01 取得、`UpdateAuthConfigBody` 235 項目） |
| 未確認 | 本番の Auth の現在値、本番の `sb_secret_` が captcha を免除されるか、本番の Turnstile のウィジェットの有無、本番の自前 SMTP の設定 |

手元の実測（隔離した別の Supabase、全項目 PASS）で分かったこと。

| 実測 | 結果 | 運用への含意 |
| --- | --- | --- |
| anon の鍵で `/signup`・`/token`（password）・`/otp`・`/recover`・`/resend` をトークン無し | 400 `captcha_failed` | captcha をオンにすると、アプリを通らない直接の呼び出しが塞がる |
| 管理者資格（JWT の service role と `sb_secret_`）で同じ窓口をトークン無し | 200 | アプリのサーバーは service role の鍵で呼ぶと captcha を気にせず通る |
| `refresh_token` の grant をトークン無し | 200 | 免除。更新は止まらない |
| 作ったばかりの session で nonce 無しの `PUT /user` | 200 | `secure_password_change` の窓は 24 時間で、設定では変えられない。アプリの窓口（現行パスワード＋コード）が本人確認の主体 |
| 25 時間前の session で nonce 無しの `PUT /user` | 400 `reauthentication_needed` | 古い session は再認証が要る |
| 管理 API の `updateUserById` でパスワード更新 | 200。他の session は全部消える。GoTrue の変更通知は**送られない** | アプリの変更・再設定の通知はアプリが自前で送る（二重にならない）。直接の `PUT /user` の変更だけ GoTrue の通知が届く |
| `admin.updateUserById` に 15 文字 | 422 `weak_password` | 最小長 16 を強制する |
| `admin.createUser` に 15 文字 | 200 | 作成側は強制しない。アプリの登録・パスワード変更は 16 文字をアプリ側でも検査する |
| 正しいパスワードの未確認の会員のログイン | 400 `email_not_confirmed` | 確認メール必須にすると、確認前の会員は入れない |

## 目標の値

「Management API の鍵」は `PATCH /v1/projects/{ref}/config/auth` の本文の鍵名。実行前に `GET` の応答に在る鍵だけを送る（無い鍵を送ると 400 になる）。手元の `config.toml` の鍵は `supabase/config.toml`（波 6 の切り替え〔2026-11-01〕までは `supabase/pending-wave6/config.toml` に目標の写しを置いていた）。

| 項目 | Management API の鍵 | 目標 | 手元の `config.toml` の鍵 | 出どころ |
| --- | --- | --- | --- | --- |
| captcha を有効にする | `security_captcha_enabled` | `true` | `[auth.captcha] enabled` | ADR-0420。**段階 B**。アプリが service role で呼ぶ版が動いてから |
| captcha の提供元 | `security_captcha_provider` | `turnstile` | `[auth.captcha] provider` | 同上 |
| captcha の秘密 | `security_captcha_secret` | アプリの `TURNSTILE_SECRET_KEY` と**同じ** Cloudflare のウィジェットの秘密 | `secret = "env(SUPABASE_AUTH_CAPTCHA_SECRET)"`（手元は公開のテスト用の値） | 値は文書に書かない。Cloudflare のウィジェットが無ければ作ってから。**Cloudflare のテスト用の秘密（`1x0000…AA`、常に通る）を本番に入れない**（入れるとダミーのトークンで誰でも直接 `/signup`・`/token` を叩け、captcha が無いのと同じ。段階 B の確かめ 5 で測る） |
| 確認メールを必須にする | `mailer_autoconfirm` | `false` | `[auth.email] enable_confirmations = true` | `SEC-AUTH-016-AC-01`・`FREQ-320-AC-03`。**本番はすでに目標の値**（2026-11-01 に公開の `GET /auth/v1/settings` で `mailer_autoconfirm=false` を確認。変更不要） |
| メール OTP の期限（秒） | `mailer_otp_exp` | `300` | `otp_expiry` | `SEC-AUTH-029`。アプリの保留の Cookie も 5 分 |
| メール OTP の桁数 | `mailer_otp_length` | `8` | `otp_length` | アプリの入力が 8 桁を求める |
| パスワードの最小長 | `password_min_length` | `16` | `minimum_password_length` | `SEC-AUTH-015-AC-01`。**段4で、アプリのパスワードの窓口は無い**ので「アプリの最小長と同じ」は要らなくなった。GoTrue を直に叩く道の守りとして残す（お客さんの `password` は J のフックが拒否する） |
| パスワードの構成規則 | `password_required_characters` | **変えない** | `password_requirements = ""` | NIST SP 800-63B-4 3.1.1.2 は構成規則を課さない。本番が規則を課していれば変えずにオーナーへ知らせる |
| パスワード変更に再認証（24 時間より古い session） | `security_update_password_require_reauthentication` | `true` | `secure_password_change` | `SEC-AUTH-015-AC-02`。**段4で要らなくなった**（アプリのパスワード変更が無い）。直の `PUT /user` の守りとして残すだけ |
| パスワード変更に現行パスワードを要求 | `security_update_password_require_current_password` | `true` | **鍵が無い**（CLI の `config.toml` では設定できない） | **段4で要らなくなった**（アプリのパスワード変更が無い）。`SEC-AUTH-015-AC-05`。手元の E2E では再現できず、本番は GET の値で確かめる |
| メールの変更に新旧両方の確認 | `mailer_secure_email_change_enabled` | `true` | `double_confirm_changes = true` | 今の既定のまま |
| パスワード変更の通知を有効にする | `mailer_notifications_password_changed_enabled` | `true` | `[auth.email.notification.password_changed] enabled` | 直接の `PUT /user` の変更を本人に知らせる。**アプリのパスワードの再設定・変更が消えたので（段4）、GoTrue の `/recover`・直の `PUT /user` の通知だけが残る** |
| 同通知の件名 | `mailer_subjects_password_changed_notification` | `パスワードの変更を受け付けました` | `subject` | アプリの通知（「パスワードを変更しました」）と件名を分けて見分ける |
| 同通知の本文 | `mailer_templates_password_changed_notification_content` | 下の「雛形」 | `content_path`（`supabase/templates/password_changed_notification.html`） | パスワードを本文に入れない。**本文の「パスワードを再設定のうえ」は段4の方針と合わない**（お客さんの `password` は J で拒否されるので、再設定しても入れない）。雛形は段4では変えない。見直しは開店前（[手順書の節7・9](./passkey-production-apply-runbook.md)） |
| 確認メールの雛形 | `mailer_templates_confirmation_content`（鍵名は GET の応答で確かめる）、件名 `mailer_subjects_confirmation` | 下の「雛形」、件名 `メールアドレスの確認` | `[auth.email.template.confirmation]` | **段4（2026-11-22）で、確認のリンクの窓口 `/api/auth/confirm` を消した**ので、雛形はリンクを出さず、`{{ .Token }}`（8桁）を入れる（オーナーの答え5は A）。確認前のアカウントも、ログインの画面にメールの8桁の数字を入れて入る。古い雛形（リンク）のままだと、確認前の人は入れない。**`mailer_autoconfirm: false` と同じ `PATCH` か、その前に送る**（段階 A の順番）。後に回すと、確認メールが古い雛形のまま届く。本番の貼り替えは[手順書の節2の3 の 2b](./passkey-production-apply-runbook.md) |
| ログインの確認コードの雛形 | `mailer_templates_magic_link_content`、件名 `mailer_subjects_magic_link` | 本文に `{{ .Token }}` を含み、有効期限は「5分」。件名 `ログインの確認コード` | `[auth.email.template.magic_link]` | アプリは本文のコードを入力させる。台帳の「ログインのメールの型」。確認メールの雛形と同じ `PATCH` に入れる |
| 確認メールの戻り先（読むだけ。**段4で要らなくなった**） | `site_url`・`uri_allow_list` | **変えない。段4で確認のリンクの窓口を消したので、戻り先の確かめは要らない**（Site URL は、Supabase 自身が送るメールの住所として別に決める） | `site_url`・`additional_redirect_urls` | 段4まで（記録）: 確認メールのリンクは雛形の `{{ .RedirectTo }}`（アプリの `/api/auth/confirm`）から作っていた。GoTrue は戻り先が Site URL と同じホスト名か Redirect URLs（`uri_allow_list`）に当たる時だけ受け付け、外れると Site URL に置き換える。置き換わるとリンクが確認の窓口に届かず、登録を確定できなかった。段4で窓口とリンクを消したので、この確かめは要らない |
| TOTP の登録・検証 | `mfa_totp_enroll_enabled`・`mfa_totp_verify_enabled` | **`false`・`false`（段4で止める。手順 4）**。段4のコードは TOTP を使わない | `[auth.mfa.totp]` | 段4まで `true`・`true`（管理者の二要素）。段4で店員はパスキーだけで入る。止める手順と残った要素は[手順書の節2の7](./passkey-production-apply-runbook.md) |
| パスキーの有効化・RP | パスキーの有効化と WebAuthn の RP（`rp_id`・`rp_origins`。鍵名は Management API の GET の応答で確かめる） | **段3の前に決める**: `rp_id` は本番のドメイン、`rp_origins` は本番のアプリの出所（https）。手元の `localhost` を本番に持ち込まない | `[auth.passkey] enabled`・`[auth.webauthn] rp_id`・`rp_origins`（手元は `localhost`・`http://localhost:3000`） | パスキー設計・[本番への当て方の順と前提](./db-migrations.md)。`supabase config push` は流さない（手元の RP と、本番に無いフックの関数が入るため） |
| Custom Access Token のフック | ダッシュボードの Auth の Hooks | `public.passkey_access_token_hook` を登録（**移行 B を当てた後**。段3で、E の直前） | `[auth.hook.custom_access_token]` | B より先に登録すると全員のログインが止まる。順は[本番への当て方の順と前提](./db-migrations.md) |
| メールでのサインインを有効にする | `external_email_enabled` | `true` | `[auth.email] enable_signup` | 変えない（アプリの `/signup` が要る） |
| 新規のサインアップを許す | `disable_signup` | `false` | `[auth] enable_signup = true` | 変えない |
| 漏洩パスワードの確認 | `password_hibp_enabled` | `true` | 手元に無い | **プラン依存**（Supabase の公式は Pro 以上。本番の組織は Free〔2026-11-06 に MCP の `get_organization` で確認〕なので今は使えない）。拒まれたら台帳へ。アプリ側の `checkPwnedPassword` は登録・再設定・変更の窓口を守るが、直接の `/signup`・`/user` には効かない |
| PostgREST の最大行数 | `max_rows`（`PATCH /v1/projects/{ref}/postgrest`） | `1000`（今の値が 1000 より大きい時だけ下げる） | `[api] max_rows` | 手元は 1000 |
| 一人一端末 | `sessions_single_per_user` | `false` のまま（キーが無い時も「オフ」として進む） | 手元に無い | `true` だと、パスワード変更の「現行パスワードの確認」の `signInWithPassword` が今の session を消し、確認コードが結んだ `session_id` が死ぬ。`true` なら段階 A に進まずオーナーに知らせる |

### 雛形

確認メール（件名 `メールアドレスの確認`。有効期限の字は `otp_expiry` に合わせて「5分」）。段4（2026-11-22）で、確認のリンクの窓口を消したので、リンクとパスワードの案内は無く、8桁の数字だけを出す（オーナーが承認した文。手元の `supabase/templates/confirmation.html` と同じ。一字一句そのまま使う）。

```html
<h2>メールアドレスの確認</h2>
<p>ログインの確認コード: {{ .Token }}</p>
<p>ログインの画面にこの8桁の数字を入れると、会員登録が終わります。</p>
<p>有効期限は5分です。心当たりがない場合は、このメールを破棄してください。</p>
```

（段4まで: リンク `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup` と、「最初に登録したときのパスワード」の案内があった。パスワードの登録・ログインの窓口を消したので、どちらも要らなくなった。）

パスワード変更の通知（GoTrue 側。件名 `パスワードの変更を受け付けました`）。段4の Task 29（2026-11-22）で、アプリのパスワードの再設定・変更（`/auth/password-reset`・`/account/password`）は消えた。この雛形は GoTrue 自身の通知なので残す（GoTrue の `/recover` と直の `PUT /user` は、アプリの外に残る。フックがお客さんの `password` での入室を拒むので、再設定してもパスワードでは入れない）。

```html
<h2>パスワードの変更を受け付けました</h2>
<p>{{ .Email }} のアカウントのパスワードが変更されました。</p>
<p>心当たりがない場合は、ただちにパスワードを再設定のうえ、お問い合わせください。</p>
```

ログインの確認コード（件名 `ログインの確認コード`）の本文の 2 行目は「有効期限は5分です。期限が切れた場合は再送してください。」にする。

## 手で変える項目（API に鍵が無い・プラン依存・外部の設定）

| 項目 | 理由 | 変え方 | 目標・確かめ |
| --- | --- | --- | --- |
| サインイン・サインアップの IP ごとの枠 | Management API のスキーマに該当する鍵が無い（`config.toml` の `sign_in_sign_ups`） | ダッシュボードの Authentication → Rate Limits | **アプリの全員が Vercel の出口の少数の IP から GoTrue を呼ぶので、既定の 30 回／5 分を店の全員で分け合う**。開店前に上げる値を決める。サーバーから GoTrue へ利用者の IP を渡す方法は未検証で、開店前の確かめに残す |
| メール送信の枠（`rate_limit_email_sent`） | 自前の SMTP が有効でないと変えられない | 先に自前の SMTP を設定する | Supabase 既定のメール送信は時間あたりの上限が小さく、宛先も制限されるので、**本番は自前の SMTP（Resend）を設定しないと、一般の会員にログインの確認コードが届かない**。`GET` の `smtp_host` が空でないことを確かめる |
| 漏洩パスワードの確認 | プラン依存 | ダッシュボードの Authentication → Attack Protection | プランを確認してから。拒まれたら台帳へ |
| Site URL | 台帳の 1c の別件 | ダッシュボードの Authentication → URL Configuration | 台帳に従う。本番のアプリの正規のホスト名（`APP_ALLOWED_ORIGINS` の先頭）と同じホスト名にする |
| Redirect URLs（`uri_allow_list`。**段4で、確認のリンクの窓口を消したので要らなくなった**） | （段4まで）確認メールのリンクの戻り先（アプリの `/api/auth/confirm`）を GoTrue が受け付ける条件。台帳には Site URL（1c）しか無い | ダッシュボードの Authentication → URL Configuration → Redirect URLs | `APP_ALLOWED_ORIGINS` の各オリジンの `/api/auth/confirm` が、Site URL と同じホスト名か Redirect URLs に当たること（www と apex のようにずれるなら Redirect URLs に足す）。段階 A の前提。台帳に行を足す |
| 確認メールの雛形の `{{ .Token }}` | 台帳の「ログインのメールの型」。段4で、確認メールにも `{{ .Token }}` を入れる（答え5は A） | ダッシュボードの Authentication → Emails | ログインの確認コードのメールと、確認メール（Confirm sign up）の両方に `{{ .Token }}` が入っていること |
| Cloudflare の Turnstile のウィジェット | 本番のウィジェットは未作成の可能性が高い | Cloudflare のダッシュボードで作る | 同じ秘密を Vercel の `TURNSTILE_SECRET_KEY` と Supabase の captcha の両方に入れる。無ければ段階 B は保留し、台帳の項目にする |
| Vercel の `APP_ALLOWED_ORIGINS` | `VERCEL_ENV=production` で未設定だとビルドが落ちる（SEC-ABOUT-007-AC-02） | Vercel の Production の環境変数（ビルドの前） | [シークレット管理方針](secrets.md)の `APP_ALLOWED_ORIGINS` |

## 手順

controller（作業者）が、オーナーの許可のもとで行う。`supabase config push` は**絶対に流さない**（手元の `config.toml` の全体を本番へ押し出し、`site_url` や captcha の秘密などを上書きする）。

### 前提

1. アプリのコード（auth の呼び出しが service role の鍵に変わった版）が `master` にあり、普段の開発がそれで動いている。
2. 手元の切り替え（`config.toml` の差し替えと E2E）が済み、アプリのログイン・登録が captcha 有効でも通る（`SEC-AUTH-035-AC-01`）。
3. オーナーの許可がある（本番の Auth の設定の変更）。
4. 個人用のアクセストークン `sbp_...`（ダッシュボードの Account → Access Tokens で作る。`auth:write` を含む）が、**作業者のシェルの環境変数 `SUPABASE_ACCESS_TOKEN` にだけ**ある。ファイル・文書・ログに書かない。
5. 段階 B のために、本番の Turnstile の秘密が環境変数 `TURNSTILE_PROD_SECRET` にだけある（無ければ段階 B は保留）。

### 1. 読んで控える

`GET https://api.supabase.com/v1/projects/pjidrgofvaglnuuznnyj/config/auth` と `.../postgrest` を読み、次の 2 つを保存する。

- 控え（`before`）: 全項目。ただし名前の末尾が `_secret`・`_secrets`・`_pass`・`_key`・`_auth_token` の鍵の値だけを `[REDACTED]` に伏せる。`pass`・`token` の部分一致で伏せると `password_min_length` や `rate_limit_token_refresh` など、変える値と読む値が消えるので使わない。
- 戻し用（`rollback`）: 段階 A・B で**変える鍵だけ**の今の値（`restore`。確認メール・ログインのコードの雛形と件名の 4 鍵を含む）、変えないが読んで報告する鍵（`readOnly`。`site_url`・`uri_allow_list` を含む）、`max_rows`。**戻す時は `restore` の鍵だけを送る**。`readOnly`（`site_url`・`uri_allow_list`・`smtp_host`・`rate_limit_email_sent` など）を送ると、変えていない鍵が 4xx になって戻せなくなる。

読んだ後に次を確かめて報告する。

1. `security_captcha_enabled` が今 `false` であること。
2. `sessions_single_per_user` が `true` でないこと（`true` なら段階 A に進まず、オーナーに知らせる）。
3. `mailer_autoconfirm`・`mailer_otp_exp`・`mailer_otp_length`・`password_min_length`・`external_email_enabled`・`disable_signup`・`smtp_host` の今の値。
4. サインインの IP の枠に当たる鍵が応答にあるか（スキーマに無い見込み）。
5. `password_required_characters` が空でないか（空でなければオーナーに知らせる。変えるかは別の判断）。
6. **今の確認メールの雛形と件名**（`mailer_templates_confirmation_content`・`mailer_subjects_confirmation`）と**ログインのコードの雛形と件名**（`mailer_templates_magic_link_content`・`mailer_subjects_magic_link`）。既定のまま（`ConfirmationURL` を含む）か、すでに変えてあるかを報告する。
7. **`site_url` と `uri_allow_list`**（段4で確認のリンクの窓口を消したので、この確かめは要らなくなった。記録として残す）。アプリの確認の戻り先（`APP_ALLOWED_ORIGINS` の各オリジンの `/api/auth/confirm`）が、Site URL と同じホスト名か `uri_allow_list` に当たるか。当たらなければ段階 A に進まず、オーナーに Redirect URLs を足してもらう（上の「手で変える項目」）。
8. **確認前の利用者の数**。本番の DB で `select count(*) from auth.users where email_confirmed_at is null and deleted_at is null` を流して報告する（読むだけ）。0 でなければ、`mailer_autoconfirm: false` にした後その人たちは確認が済むまでログインできない（店長が作った会員・試し用の 4 人を含みうる）ので、段階 A に進まずオーナーに知らせ、確認を済ませるか確認済みにするかを決めてもらう。店長が新しく作る会員は、コードが `email_confirm: true` で作るので増えない（DD-ADMIN-002）。

### 2. 段階 A（captcha 以外）

前提: 手順 1 の 6・7・8（雛形の今の姿、`site_url` と `uri_allow_list` に戻り先が当たること、確認前の利用者の数）を報告し、オーナーが進めてよいと言ってから。

1 回の `PATCH /config/auth` で送る鍵は次の 16 個（`GET` の応答に在る鍵だけ）。

| 区分 | 鍵 |
| --- | --- |
| 確認メール・ログインのコードの雛形（**必ず同じ `PATCH` に入れる。別に送るなら `mailer_autoconfirm` より前**） | `mailer_templates_confirmation_content`、`mailer_subjects_confirmation`、`mailer_templates_magic_link_content`、`mailer_subjects_magic_link` |
| 確認メールを必須にする | `mailer_autoconfirm`（`false`） |
| OTP・メール変更 | `mailer_otp_exp`、`mailer_otp_length`、`mailer_secure_email_change_enabled` |
| パスワード | `password_min_length`、`security_update_password_require_reauthentication`、`security_update_password_require_current_password` |
| パスワード変更の通知 | `mailer_notifications_password_changed_enabled`、`mailer_subjects_password_changed_notification`、`mailer_templates_password_changed_notification_content` |
| TOTP（**段4で止める側の値は `false`・`false`**。手順 4。下の PATCH に入れるなら、段4の目標の値で送る） | `mfa_totp_enroll_enabled`、`mfa_totp_verify_enabled` |

**この `PATCH` に入れないもの**: 表で「変えない」とした鍵（`password_required_characters`・`external_email_enabled`・`disable_signup`）、読むだけの鍵（`site_url`・`uri_allow_list`・`sessions_single_per_user`・`smtp_host` など）、captcha の 3 鍵（段階 B）、`password_hibp_enabled`（別に 1 回。プラン依存のため）、`max_rows`（別の窓口）。

送った後に `GET` で読み戻し、目標と食い違う鍵が無いことを確かめる。`max_rows` は `PATCH /postgrest` で、今の値が 1000 より大きい時だけ 1000 にする。

通らなければ最大 3 回まで試す（429 と 5xx だけ間を空けて再試行。4xx は同じ結果なので 1 回で止める）。3 回で通らない項目は止め、下の「ダッシュボードの手順」でオーナーに変えてもらう。

### 3. 段階 B（captcha）

1. アプリが service role の版で動いていることを再確認する。
2. 戻しの用意をする（別のターミナルで `security_captcha_enabled` を `false` に戻す呼び出しをすぐ打てる状態にする）。
3. `security_captcha_enabled: true`・`security_captcha_provider: turnstile`・`security_captcha_secret` を送る。
4. **すぐ確かめる**（読むだけ。本番の利用者を作らない。存在しないメールを使う）。
   1. anon（`sb_publishable_`）で `/auth/v1/signup` をトークン無し → 400（`captcha`）。
   2. anon で `/auth/v1/token?grant_type=password` をトークン無し → 400（`captcha`）。
   3. **`sb_secret_` を `apikey` と `Authorization: Bearer` に付けて** `/auth/v1/token?grant_type=password` をトークン無しで、存在しないメール → captcha の誤りでなく 400 `invalid_credentials`（captcha を免除された印）。
   4. 同じく `/auth/v1/otp`（`create_user: false`）→ captcha の誤りでなく、利用者が無い系の誤り。
   5. anon で `/auth/v1/token?grant_type=password` を、ダミーのトークン（`gotrue_meta_security.captcha_token` に `XXXX.DUMMY.TOKEN.XXXX`）付きで → 400（`captcha`）。通るなら、本番の captcha の秘密が Cloudflare のテスト用（`1x0000…AA`。常に通る）になっている。**直ちに本物の秘密へ差し替える**（誰でもダミーのトークンで直接 `/signup`・`/token` を叩けるので、captcha が無いのと同じ）。
   6. 3・4 が `captcha` の誤りなら**崩れた**（本番の `sb_secret_` が管理者として扱われていない）。**その場で `security_captcha_enabled: false` に戻す**。
5. 普段の開発でアプリのログインを 1 回通す（試し用の会員。本番の DB に書く操作なので、オーナーの確認を先に取る）。通らなければ戻す。

崩れた時の次の手: `createServiceRoleAuthClient` にだけ、旧方式の `service_role` の JWT を使う環境変数を足す案がある（controller の裁定が要る）。それも通らなければ ADR-0420 の見直す条件に従う。

### 戻し方

| 戻すもの | 方法 |
| --- | --- |
| 段階 B だけ | `security_captcha_enabled` を控えの値（`false`）に戻して `PATCH`。秘密は残るので、再度オンにするだけで戻る |
| 段階 A 全部 | 控えの `restore` の値を `PATCH`。元が `null` の鍵は送れない（4xx）ので、ダッシュボードで手で戻す。`max_rows` は控えの値で `PATCH /postgrest` |
| 移行 M3（パスワード変更の確認コードの表） | 移行ファイルのヘッダーの ROLLBACK に従う。先にアプリの画面を戻してから |

## ダッシュボードで変える手順（オーナー向け）

2026-11-06 にオーナーがダッシュボードで変えると決めた。下の順に 1 ページずつ進める。各ページの住所は、ブラウザでそのまま開ける（Supabase にログインした状態で）。

- **画面の名前の確かめ:** 英語の欄の名前は Supabase の公式文書（2026-11-06 に読んだ）と過去の画面に基づく。Supabase が画面を変えると名前や置き場所がずれるので、見つからない欄は**飛ばして、どの欄が見つからなかったかを作業者に伝える**。探し回って別の欄を変えない。
- **変えない欄:** この手順に無い欄は触らない。
- **保存:** 各ページの「Save」を押してから次へ進む。
- **控え:** 変える前の値を控える（スクリーンショットでよい）。戻す時に使う。

### 手順 1: メールのログインの設定（パスワードの欄は段4で要らなくなった・コード）

段4（2026-11-22）で、アプリのパスワードのログイン・登録・再設定・変更を消した。下の表のパスワードの欄（Secure password change・Require current password when updating・Minimum password length）は、アプリには要らなくなった。GoTrue を直に叩く道の守りとして、設定は残す（お客さんの `password` は移行 J のフックが拒否する）。**メールのコード（Email OTP の期限・桁数）の欄は、新しい流れの前提なので残す**。

住所: `https://supabase.com/dashboard/project/pjidrgofvaglnuuznnyj/auth/providers?provider=Email`

左の **Authentication** → **Sign In / Providers** → 一覧の **Email** を開く。開いた欄で次のとおりにする。

| 欄（英語の表示） | 何のための欄か | 設定する値 | 今の値が違う時 |
| --- | --- | --- | --- |
| Enable Email provider | メールでのログイン | **オンのまま** | 触らない |
| Confirm email | 登録の時に確認メールを必須にする | **オンのまま**（本番はすでにオン） | 触らない |
| Secure email change | メールアドレスの変更で新旧両方に確認を送る | **オン** | オンにする |
| Secure password change | 古いログインのままのパスワード変更に再確認を求める | **オン**（段4で、アプリのパスワード変更は無い。直の `PUT /user` の守りとして残す） | オンにする |
| Require current password when updating | パスワード変更で今のパスワードを求める | **オン**（段4で、アプリのパスワード変更は無い。直の `PUT /user` の守りとして残す） | オンにする |
| Prevent use of leaked passwords | 漏れたパスワードを拒む | **触らない**（Pro 以上でしか使えない。本番は Free） | — |
| Minimum password length | パスワードの最低の文字数 | **16**（段4で、アプリのパスワードの窓口は無い。GoTrue を直に叩く道の守りとして残す） | 16 にする |
| Password Requirements | 記号・大文字などの必須 | **触らない**（既定は必須なし） | 何か必須になっていたら変えずに作業者へ伝える |
| Email OTP Expiration | ログインの確認コードの期限（秒） | **300** | 300 にする |
| Email OTP Length | ログインの確認コードの桁数 | **8** | 8 にする |

「Secure password change」「Require current password when updating」「Minimum password length」が Email の欄に無ければ、左の **Authentication** → **Attack Protection** を見る。

### 手順 2: メールの文面（確認メール・ログインの確認コード）

住所: `https://supabase.com/dashboard/project/pjidrgofvaglnuuznnyj/auth/templates`

左の **Authentication** → **Emails**（または **Email Templates**）を開く。上の **Templates** の中から 2 つを直す。どちらも「Subject（件名）」と「Body（本文）」の欄があり、本文は **Source**（HTML をそのまま書く表示）に切り替えて、中身を全部消してから下の文を貼る。

**2-1. Confirm sign up（登録の確認メール）**

件名:

```text
メールアドレスの確認
```

本文:

```html
<h2>メールアドレスの確認</h2>
<p>ログインの確認コード: {{ .Token }}</p>
<p>ログインの画面にこの8桁の数字を入れると、会員登録が終わります。</p>
<p>有効期限は5分です。心当たりがない場合は、このメールを破棄してください。</p>
```

**2-2. Magic link or OTP（ログインの確認コード）**

件名:

```text
ログインの確認コード
```

本文:

```html
<p>ログインの確認コード: {{ .Token }}</p>
<p>有効期限は5分です。期限が切れた場合は再送してください。</p>
```

`{{ .Token }}` は Supabase が送る時に8桁の数字へ置き換える印。1 字でも変えるとコードが壊れるので、そのまま貼る（確認メールの雛形のリンク `{{ .RedirectTo }}`・`{{ .TokenHash }}` は、段4で無くした）。

### 手順 3: パスワード変更の通知のメール

段4で、アプリのパスワードの再設定・変更の窓口を消した（2026-11-22）。この通知は GoTrue 側の物で、アプリの外（GoTrue の `/recover`・直の `PUT /user`）で変えた時のために残す。

住所は手順 2 と同じ。**Security notifications**（または「Notifications」）の中の **Password changed** を開く。

| 欄 | 設定する値 |
| --- | --- |
| 有効にするスイッチ（Enable など） | **オン** |
| Subject | `パスワードの変更を受け付けました` |
| Body（Source） | 下の文 |

```html
<h2>パスワードの変更を受け付けました</h2>
<p>{{ .Email }} のアカウントのパスワードが変更されました。</p>
<p>心当たりがない場合は、ただちにパスワードを再設定のうえ、お問い合わせください。</p>
```

Security notifications が見当たらない時は、右上の自分のアイコン → **Feature previews** → **Security notification templates** をオンにすると出る（Supabase の 2026 年の変更履歴による）。それでも有効にするスイッチが無ければ、件名と本文だけ直して保存し、作業者に「スイッチが無い」と伝える（有効にするのは Management API でしかできない可能性がある。公式文書は API の手順しか書いていない）。

### 手順 4: 二段階の認証（TOTP）を止める（段4）

段4（2026-11-22）で、アプリは TOTP を使わなくなった（登録も確認もしない）。店員はパスキーだけで入る。**本番では、TOTP の登録と確認を止める**（**調整役がオーナーの許可を得てから**。止める位置は[手順書の節2の7](./passkey-production-apply-runbook.md)）。

住所: `https://supabase.com/dashboard/project/pjidrgofvaglnuuznnyj/auth/mfa`

1. 左の **Authentication** → **Multi-Factor** を開く。今の状態（**Authenticator App (TOTP)** の Enroll・Verify がオンか）を控える（戻す時に使う）。
2. **Authenticator App (TOTP)** の **Enroll**（登録）と **Verify**（確認）を、**両方オフ**にして保存する。画面で1つの切り替えなら、**Disabled** にする。鍵名は `mfa_totp_enroll_enabled`・`mfa_totp_verify_enabled`（`false`・`false`）。
3. 保存後に、画面を開き直して、両方オフであることを確かめる。見つからない欄は飛ばして、作業者に伝える。
4. 店員の TOTP の要素の残りは、H の招待・やり直しの取引が消す。残りの数は[手順書の節2の7](./passkey-production-apply-runbook.md)の SQL で読む。
5. 戻す時（古いアプリへ戻す時だけ）: 両方オンに戻す（[手順書の節4の (2b)](./passkey-production-apply-runbook.md)）。

### 手順 5: 一度に返す行の上限（読むだけ）

住所: `https://supabase.com/dashboard/project/pjidrgofvaglnuuznnyj/settings/api`

左下の **Project Settings** → **Data API**（または **API**）を開き、下の方の **Max rows** の値を見る。**1000 以下なら何もしない**。1000 より大きい時だけ 1000 にして保存する。

### 手順 6: メールの送り元（読むだけ）

住所は手順 2 と同じ。**SMTP Settings**（自前のメールの送り元）がオンか、送り元が `mail.lefildesheures.com` などの店のドメインかを見て、作業者に伝える。変えない。Supabase の既定の送り元は 1 時間に 2 通までなので、自前の送り元が無いと開店後に会員へ確認コードがほぼ届かない（開店前に設定する。下の「今は変えないもの」）。

### 今は変えないもの

| 項目 | 変える時期 | 理由 |
| --- | --- | --- |
| captcha（Attack Protection の Enable Captcha protection） | 本番の URL と Turnstile ができてから | オーナーの決定（段階 B）。今オンにするとアプリが無いまま全部の登録が止まる |
| Site URL・Redirect URLs（URL Configuration） | 本番の URL ができてから | アプリの確認の戻り先の住所が決まっていない |
| Rate Limits（サインイン・サインアップの回数） | 開店前 | 全員が Vercel の出口から呼ぶので、上げる値を開店前に決める |
| SMTP Settings | 開店前 | 手順 6 で今の姿を見るだけ |
| Prevent use of leaked passwords | Pro に上げた時 | Free では使えない。アプリの登録・再設定・変更の画面は、アプリが自分で漏れたパスワードを拒んでいる |

### 終わったら

作業者に「終わった」と、手順 1〜6 で見つからなかった欄・違っていた値・手順 6 の SMTP の姿を伝える。作業者が公開の `GET /auth/v1/settings` で読める値を確かめ、この文書の「実際に変えた日・値・戻した物」に日付と前後の値を足す。

手順に従って変えられなかった項目は、いつ・どの項目・どうなったか・誰がどう変えるかを、台帳の「開店の準備」に行として足す。

## 秘密の扱い

| 値 | 置き場 | 禁止 |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN`（`sbp_...`） | 作業者のシェルの環境変数だけ。使い終わったらダッシュボードで消す | ファイル・文書・ログ・報告・コミット |
| `TURNSTILE_PROD_SECRET` | 作業者のシェルの環境変数だけ。本番の秘密は Vercel の `TURNSTILE_SECRET_KEY` と Supabase の captcha にだけ置く | 同上。`config.toml` に書かない |
| `SUPABASE_AUTH_CAPTCHA_SECRET`（手元の `supabase/.env`） | Cloudflare の公開のテスト用の値（常に通る）。`supabase/.env.example` を写す。`.env*` は未追跡 | 本番の秘密を入れない |
| 控えのファイル | 作業者の手元に置き、コミットしない（秘密の鍵は伏せてある） | コミット |

確認する点: 手元の `supabase/.env` を CLI が読むかは未検証なので、`npm run db:start` の前にシェルにも同じ変数を設定する。起動後に auth のコンテナの `GOTRUE_SECURITY_CAPTCHA_SECRET` が公開のテスト用の値になっていること。

## パスキーのログインの始めと `Sb-Forwarded-For`（段1b）

> 確認日: 2026-11-17 | 設計: [パスキー設計](../superpowers/specs/2026-11-07-passkey-auth-design.md)（5-1 の (a)・8-2）| 環境変数の名前: [secrets.md](./secrets.md)

### 前提

- 始め (a): アプリのサーバーが `sb_secret_` の鍵で GoTrue の `/passkeys/authentication/options` を呼び、お客さんの IP を `Sb-Forwarded-For` に添える。GoTrue の始めの制限は IP ごとに5分30回で、上げる設定は無い（確定）。
- `Sb-Forwarded-For` は `sb_secret_` の鍵でだけ受け付けられ、**プロジェクトの設定で有効にする必要がある**。古い `service_role` の JWT では添え書きが効かない。
- 手元の GoTrue は `sb_secret_` と `Sb-Forwarded-For` の呼び出しを 200 で通した（段1b Task 3）。IP ごとの回数は手元では数えられないので、本番の確かめに回す。

### 有効にする手順

**本番の独自のドメインが決まり、本番でパスキーを有効にした後に行う**（設計 12-2 の6。仮の住所では有効にしない）。

1. ダッシュボード、または Management API の `GET /v1/projects/{ref}/config/auth` の応答で、`Sb-Forwarded-For` に当たる項目の鍵名を確かめる。**鍵名は未確認。推測で書かない**。見つからなければ、Supabase のサポートか文書で確かめる。
2. その項目を有効にする。
3. Vercel の環境変数 `SUPABASE_SECRET_KEY` に `sb_secret_` の鍵を入れる（古い `service_role` の JWT では添え書きが効かない）。
4. 再デプロイする。
5. 確かめる。**アプリを通さず GoTrue を直に叩く**（アプリの20回の制限が先に 429 を返すため）。
   - 呼ぶ道: `POST https://<本番のプロジェクトの住所>/auth/v1/passkeys/authentication/options`。見出しは `apikey`（`sb_secret_` の鍵）と `Sb-Forwarded-For`（IP A）。
   - IP A・B には、実在の人の IP でなく文書用の IP を使う（IP A は `192.0.2.10`、IP B は `198.51.100.20`。実在の人を5分締め出さない）。
   - IP A で始めを31回呼ぶ。最後が 429 になる。
   - 続けて `Sb-Forwarded-For` を IP B にして1回呼ぶ。200 になれば、IP ごとに数えている。
   - 読み方: IP B も 429 なら添え書きが効いていない。下の (b) に切り替える。31回目も 200 なら、`sb_secret_` が回数の制限そのものを免除されている（設計 8-2 の1が問う点）。記録して、(a) のまま（アプリの20回だけが効く）でよいかオーナーに諮る。
   - 鍵を履歴に残さない: 鍵はリポジトリの外の一時ファイル（例: ユーザーの一時フォルダーの `sb-secret.tmp`。`.env.local` などリポジトリの中には置かない）に1行だけ書き、シェルで読んで変数に入れて使う。コマンドの行に値を直に書かず、画面に出さない（`curl -v` は見出しを画面に出すので使わない）。使い終わったら、そのファイルを消す（[first-admin-bootstrap.md](./first-admin-bootstrap.md) の「鍵とパスワードの扱い」と同じ）。

### 効かなかった時（(b) への切り替え）

- `NEXT_PUBLIC_PASSKEY_START_MODE=browser` に変えて再ビルド・再デプロイする。ブラウザに入る値なので、再ビルドが要る。
- (b) の前提: 本番の GoTrue で captcha を有効にする（上の「段階 B」）。(b) では始めの回数の制限は GoTrue の IP ごと5分30回だけで、アプリ側の制限（20回）は効かない。
- (b) の時、(a) の窓口は 409 で断る。

### `sb_secret_` が captcha を免除しない時（設計 8-2 の2）

(a) にも Turnstile のトークンが要る。**段1b の窓口は対応しない**（別の計画）。免除されるかの確かめを先に行う。

### 手元の開発

`npm run dev` は IP の見出しを信じない（`getClientIp` が `null`）ので、始めの窓口が 503 になる。`PASSKEY_START_DEV_IP=<適当な IP>` を `.env.development.local` に置く。`next dev` だけが読む場所で、`.env.local` に置くと本番ビルドの E2E（`next start`）にも入るので、置き場所を分けて事故を防ぐ。手元の Supabase の住所の時だけ効き、本番・Vercel では値があるとビルドと起動が止まる。E2E は `CLIENT_IP_HEADER` で足りるので要らない。

### 本番の確認の一覧（設計 8-2）との対応

| 8-2 の項目 | 段1b が作った道 | 本番での確かめ |
| --- | --- | --- |
| 1. 始めの制限と `Sb-Forwarded-For` の IP ごとの数え方 | 始め (a)（`login/start`）と (b)（`browser-start.ts`）、`NEXT_PUBLIC_PASSKEY_START_MODE` で切り替え | 上の「有効にする手順」の5。効かなければ (b) |
| 2. `sb_secret_` が captcha を免除するか | (a) は `sb_secret_` で呼ぶ | 免除されなければ別の計画（上の節） |
| 8. 古い `service_role` の鍵が captcha を免除するか | (a) は古い鍵で呼ばない | 本番で確かめるだけ（アプリは使わない） |
| 9. フックの拒否の応答の形 | 更新の拒否を印 `[staff-passkey-required]` で見分け、セッションを終わらせる（`refresh`） | フックの登録後に、拒否の応答（403・`unknown`・フックの文）が手元と同じか確かめる |
| 10. 今の `createUser` → `signInWithOtp` の組み合わせ（段2） | 始めの窓口は確認済みで作ってからコードを送る（手元は Confirm email オンで動く） | 本番の Confirm email オンのまま、未登録のアドレスにコードが届き、確定でログインできること。下の「お客さんのメールのコードのログイン（段2）」 |
| 11. メールのコードの型（`magic_link`）の雛形（段2） | 雛形の本文に `{{ .Token }}`・8桁・5分に頼る | 本番の `magic_link` の雛形に `{{ .Token }}` が在り、`otp_length` が8・`otp_expiry` が300であること |
| 12. 始めの `(b)` の切り替えの実機の確認と、`/otp` の IP の枠（段2） | `NEXT_PUBLIC_PASSKEY_START_MODE`。サインイン・サインアップの IP ごとの枠（5分30回）が、お客さんの新規と予備の主な道になる | `(b)` の切り替えを実機で確かめる。`/otp` にも `Sb-Forwarded-For` を添えられるか、`createServiceRoleAuthClient` を `sb_secret_` に替える要否を確かめる |

段3b（2026-11-20）: パスキーの移行は A〜I の9本になった（段4で J・K が増えて11本。J はお客さんの `password` を拒否する旗、K はパスワード用の表と関数を消す）（H が店員の招待の表と関数、I が死んだ知らせの点検と worker の心拍）。**当てる順・1本ごとの前の確かめ・戻し方の順・上の表の確認の本番での手順は [パスキーの移行を本番に当てる手順書](./passkey-production-apply-runbook.md)**（節6が設計 8-2 の1〜12と段3b が足した確認）。ダッシュボードの設定（Passkeys・RP・フック）は B を当てた後、E は最後。

## お客さんのメールのコードのログイン（段2）

確認日: 2026-11-18（パスキー段2 Task 11）。設計は [ADR-0469](../03_BasicDesign/decisions/ADR-0469-passkey-customer-email-code-login.md)。コードは `src/app/api/auth/email-code/start/route.ts`・`resend/route.ts`。

- **頼っている設定**: 始めの窓口は、`admin.createUser`（確認済み・パスワード無し・印 `email_code_signup_pending`）を呼んだ後、全員に同じく `signInWithOtp({ shouldCreateUser: false })` を呼ぶ。コードを送るメールは、上の表の「ログインの確認コードの雛形」（`mailer_templates_magic_link_content`）をそのまま使う。**この雛形の本文に `{{ .Token }}` が在り、コードが8桁・有効期限が5分（`otp_length`・`otp_expiry`）であること**が、新しい流れの前提になる。雛形から `{{ .Token }}` が消える、または桁数・期限が変わると、お客さんはコードを受け取れない・入れられない。変える時は、画面の文（8桁・5分）とあわせて直す
- **「Confirm email はオンのまま」で動く理由**: `createUser` は `email_confirm: true` で作るので、新しい利用者は最初から確認済み。確認メール（`confirmation` の雛形）は送られず、`signInWithOtp` は `magic_link` の雛形でコードのメールを1通だけ送る。このため、確認メールの必須（Confirm email）をオンのままにしておいてよい（触らない）
- **手元の確認（2026-11-18）**: 手元の `supabase/config.toml` は `enable_confirmations = true`、`otp_length = 8`、`otp_expiry = 300`。この設定のまま、`createUser` → `signInWithOtp` の組み合わせで、未登録のアドレスにコードのメールが届き、確定でログインできる（E2E `FR-LOGIN-055`: FR-AUTH-023-AC-01）。登録済みのアドレスでも、応答は同じ（AC-02）
- **本番で試す物（段3の確認の一覧に足した）**: (1) 今の `createUser` → `signInWithOtp` の組み合わせが、本番の Confirm email オンのまま動くこと、(2) 本番の `magic_link` の雛形に `{{ .Token }}` が在り、8桁・5分であること、(3) 始めの `(b)`（`NEXT_PUBLIC_PASSKEY_START_MODE`）の切り替えの実機の確認、(4) 次の IP の枠。台帳の「パスキー段2から先への持ち越し」に書いた
- **サインイン・サインアップの IP ごとの枠（5分30回）は、段2から、お客さんの新規と予備の主な道になる**: 上の「手で変える項目」の「サインイン・サインアップの IP ごとの枠」にあるとおり、アプリの全員が Vercel の出口の少数の IP から GoTrue を呼ぶので、この枠は店の全員で分け合う。今、お客さんの新規と予備の主な道は `signInWithOtp`（`/otp`）になるので、`/otp` にも `Sb-Forwarded-For` を添えられるか、および `createServiceRoleAuthClient`（今は `SUPABASE_SERVICE_ROLE_KEY` を使う）を `sb_secret_` に替える要否は、本番で確かめる（段3）

## 一度も入らなかったメールのコードのアカウントの後始末（開店前。選ぶ SQL）

確認日: 2026-11-18（段2 Task 11 の直し）。**消す処理そのものは開店前の作業で、段2では作っていない。下の SQL は選ぶだけ（読むだけ）の候補。** 本番へ流す前に、手元の DB で流して、行数と中身を確かめる。

始めの窓口は、コードを送る前に、印つきでアカウントを作る（`app_metadata.email_code_signup_pending = true`。`src/app/api/auth/email-code/start/route.ts`）。確定でコードが通った時だけ印が外れる（`verify/route.ts`。外す失敗は続行する）。このため、コードを入れなかったアドレスのアカウントが残る。印の付いた人が後で Google で入ると、印が付いたまま残るので、`last_sign_in_at IS NULL` が無いと本当のお客さんを選んでしまう。

```sql
select u.id, u.email, u.created_at
  from auth.users u
 where (u.raw_app_meta_data ->> 'email_code_signup_pending') = 'true'
   and u.created_at < now() - interval '24 hours'
   and u.last_sign_in_at is null
   and not exists (select 1 from public.orders o where o.user_id = u.id)
   and not exists (select 1 from public.orders o where lower(btrim(o.shipping_email)) = lower(btrim(u.email)))
   and not exists (select 1 from public.user_roles r where r.user_id = u.id)
 order by u.created_at;
```

- 条件: 印が真、作って24時間を過ぎ、一度もログインしていない、`public.orders.user_id` の注文が無い、同じアドレスのゲストの注文（`shipping_email`）が無い、`public.user_roles` に行が無い（店員でない）
- 消す時は、選んだ行を目で確かめてから、管理 API（`auth.admin.deleteUser`）で1人ずつ消す。SQL で `auth.users` を直に消さない。消した後に、同じアドレスの始めが来れば、作り直される

## 確かめ

確かめの実行手順（読み・送り・読み戻し・戻しの作業用スクリプト）は未追跡の作業ディレクトリに置く。この文書には手順と期待値だけを書く。

| 確かめ | 期待 |
| --- | --- |
| 段階 A の読み戻し | 目標の値と食い違いなし |
| 段階 B の 5 点 | anon は 400（captcha。トークン無しとダミーのトークン付きの両方）、`sb_secret_` は captcha の誤りでない |
| 現行パスワードの要求 | `GET` の `security_update_password_require_current_password` が `true`（`SEC-AUTH-015-AC-05`。使い捨ての会員を本番に作る試験はオーナーの許可が要る本番の書き込みなので、既定は値の確認だけ） |
| 本番のアプリのログイン | 1 回通る（段階 B の後） |

## 実際に変えた日・値・戻した物

本番の Auth の設定の変更は未実施。本番の変更を行ったら、日付・変えた項目の前後の値（秘密を除く）・戻した物・手で変えた項目を、この節に足す。

### 2026-11-01 の実施記録（MCP から変えようとして、変えられなかった）

確認日: 2026-11-01。オーナーの依頼は「Supabase の MCP で本番の Auth の設定を変える」。本番の設定は**1 つも変えていない**（書き込みなし）。

| 試み | 結果 |
| --- | --- |
| 1. つながっている Supabase の MCP サーバーの道具の一覧 | Auth の設定を読む・変える道具が無い |
| 2. Supabase 公式の MCP の文書（`https://supabase.com/docs/guides/ai-tools/mcp` の「Available tools」） | データベース・デバッグ・開発・Edge Functions・アカウント・文書・ブランチ・ストレージの道具だけ。設定の更新があるのはストレージだけで、Auth は無い |
| 3. DB の `auth` スキーマに設定の表があるか | 無い（GoTrue の設定は DB に入っていない） |

読んで分かったこと（読むだけ。書き込みなし）:

- 公開の `GET /auth/v1/settings`（本番）: `disable_signup=false`、`mailer_autoconfirm=false`（**Confirm email はすでにオン**）、`phone_autoconfirm=false`、外部のプロバイダーは `google` と `email` がオン。
- SQL: `auth.users` は生きている利用者 8 人、うち未確認が 2 人。2 人とも `@example.com` の試験用の会員で、ログインしたことがなく、確認メールも送っていない。実在の客ではないので手当ては要らない（手順 1 の項目 8 の「確認前の利用者の数」の報告はこれ）。

まだ確かめられていない・変えていない項目:

- `password_min_length` 16、`security_update_password_require_reauthentication`・`security_update_password_require_current_password`、`mailer_otp_exp` 300、OTP の桁数 8。
- パスワード変更の通知と雛形（確認・マジックリンク・パスワード変更）、`secure email change`、TOTP の Enroll・Verify。
- 漏洩パスワードの確認（security advisors は「無効」と出している）、`sessions_single_per_user`。
- 段階 B（captcha）: 本番の URL とその Turnstile のウィジェットができるまで見送り（オーナーの決定）。

次の一手: 2026-11-06 にオーナーが (b) ダッシュボードで変えると決めた（(a) の個人アクセストークンは使わない）。上の「ダッシュボードで変える手順（オーナー向け）」が、変える時に使う手順。 どちらでも、変える前に雛形を変え、確認メールの必須は本番がすでにオンなので触らない。変えた後は、ここに日付と前後の値を足す。

## 未確認事項

- 本番の Auth の現在値（確認メール必須・新規登録の許可・外部のプロバイダーだけは 2026-11-01 に公開の `GET /auth/v1/settings` で確認済み。残りは未確認）、`sessions_single_per_user` の値、自前 SMTP の設定（料金プランは Free と 2026-11-06 に確認）、確認メールの雛形が今どうなっているか。
- 本番の `site_url`・`uri_allow_list` と、アプリの確認の戻り先（`/api/auth/confirm`）が受け付けられるか（GoTrue の `isRedirectURLValid` のソース読みに基づく。本番では未確認）。
- 本番の `sb_secret_` が captcha を免除するか。手元の隔離スタックでは `sb_secret_` も免除された。本番の段階 B の確かめで初めて分かる。
- `GET` の応答の鍵名（確認メールの雛形の鍵など）。実際の応答で最終確認する。
- 本番の Turnstile のウィジェットの有無。
- ダッシュボードの画面の名前（上の表は作業の時に確かめて直す）。
- `Sb-Forwarded-For` を有効にする項目の鍵名（上の「パスキーのログインの始めと `Sb-Forwarded-For`」の手順 1。未確認）と、本番で IP ごとに数えるか。
