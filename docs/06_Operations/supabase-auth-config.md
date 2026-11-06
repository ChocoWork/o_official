# 本番の Supabase Auth の設定（captcha・パスワード変更・OTP・MFA）

> 状態: 目標の値と手順（本番への適用は未実施。2026-11-01 に MCP で試して不可。2026-11-06 にオーナーがダッシュボードで変えると決め、「ダッシュボードで変える手順（オーナー向け）」を書いた。確認メールの必須だけは本番がすでに目標の値） | 確認日: 2026-11-06 | 対象: 本番の Supabase プロジェクト `pjidrgofvaglnuuznnyj` の Auth と PostgREST の設定、手元の `supabase/config.toml` との対応 | 設計判断: [ADR-0420](../03_BasicDesign/decisions/ADR-0420-auth-supabase-captcha-with-service-role-auth-calls.md)（captcha）、[ADR-0421](../03_BasicDesign/decisions/ADR-0421-auth-password-change-by-app-window-with-emailed-code.md)（パスワード変更）

## 概要

守りの穴の波 6 で、Supabase の captcha を有効にし、アプリのパスワード変更の窓口を GoTrue の設定と組み合わせる。手元の `supabase/config.toml` は本番の前提にそろえるが、**本番の Auth の設定は `config.toml` ではなく本番の Management API かダッシュボードが正**である。この文書は、本番の目標の値、API に鍵が無い・プラン依存で手で変える項目、変える手順と戻し方、3 回試して通らなかった時のダッシュボードの手順をまとめる。

- 本番のアプリは未デプロイ（Vercel にプロジェクト無し）。本番の Auth の現在値は未読。
- 本番を変える作業は、オーナーの許可のもとで 1 項目ずつ行う。許可なしに変えない。
- 値の変更前に必ず今の値を読んで控える。秘密の値（Turnstile の秘密、`sbp_` のトークン）は、この文書・ログ・報告・コミットに書かない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 要件 | `SR-AUTH-009`・`FR-AUTH-006`（パスワード変更）、`SEC-AUTH-015`（直接の道の守り。AC-04・AC-05）、`SEC-AUTH-034`・`SEC-AUTH-035`、`SEC-AUTH-016-AC-01`・`SEC-AUTH-029`（確認メール・OTP の期限）、`SEC-AUTH-030-AC-01`（TOTP） |
| 関連コード | `src/lib/auth/service-role-auth-client.ts`（captcha を免除される呼び出し）、`src/app/api/auth/password/change/{start,confirm}/route.ts`、`src/lib/build-env-guard.ts` |
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
| パスワードの最小長 | `password_min_length` | `16` | `minimum_password_length` | アプリの最小長と同じ。`SEC-AUTH-015-AC-01` |
| パスワードの構成規則 | `password_required_characters` | **変えない** | `password_requirements = ""` | NIST SP 800-63B-4 3.1.1.2 は構成規則を課さない。本番が規則を課していれば変えずにオーナーへ知らせる |
| パスワード変更に再認証（24 時間より古い session） | `security_update_password_require_reauthentication` | `true` | `secure_password_change` | `SEC-AUTH-015-AC-02` |
| パスワード変更に現行パスワードを要求 | `security_update_password_require_current_password` | `true` | **鍵が無い**（CLI の `config.toml` では設定できない） | `SEC-AUTH-015-AC-05`。手元の E2E では再現できず、本番は GET の値で確かめる |
| メールの変更に新旧両方の確認 | `mailer_secure_email_change_enabled` | `true` | `double_confirm_changes = true` | 今の既定のまま |
| パスワード変更の通知を有効にする | `mailer_notifications_password_changed_enabled` | `true` | `[auth.email.notification.password_changed] enabled` | 直接の `PUT /user` の変更を本人に知らせる |
| 同通知の件名 | `mailer_subjects_password_changed_notification` | `パスワードの変更を受け付けました` | `subject` | アプリの通知（「パスワードを変更しました」）と件名を分けて見分ける |
| 同通知の本文 | `mailer_templates_password_changed_notification_content` | 下の「雛形」 | `content_path`（`supabase/templates/password_changed_notification.html`） | パスワードを本文に入れない |
| 確認メールの雛形 | `mailer_templates_confirmation_content`（鍵名は GET の応答で確かめる）、件名 `mailer_subjects_confirmation` | 下の「雛形」、件名 `メールアドレスの確認` | `[auth.email.template.confirmation]` | 既定の `ConfirmationURL` だとアプリの確認の窓口が `missing_token_hash` で落ちる。**`mailer_autoconfirm: false` と同じ `PATCH` か、その前に送る**（段階 A の順番）。後に回すと、確認メールが既定のまま届き、新しい会員が登録を確定できない |
| ログインの確認コードの雛形 | `mailer_templates_magic_link_content`、件名 `mailer_subjects_magic_link` | 本文に `{{ .Token }}` を含み、有効期限は「5分」。件名 `ログインの確認コード` | `[auth.email.template.magic_link]` | アプリは本文のコードを入力させる。台帳の「ログインのメールの型」。確認メールの雛形と同じ `PATCH` に入れる |
| 確認メールの戻り先（読むだけ） | `site_url`・`uri_allow_list` | **変えない。読んで、アプリの戻り先が受け付けられることを確かめる** | `site_url`・`additional_redirect_urls` | 確認メールのリンクは雛形の `{{ .RedirectTo }}`（アプリの `/api/auth/confirm`。`register/route.ts` の `emailRedirectTo`）から作る。GoTrue は戻り先が Site URL と同じホスト名か Redirect URLs（`uri_allow_list`）に当たる時だけ受け付け、外れると Site URL に置き換える。置き換わるとリンクが確認の窓口に届かず、登録を確定できない（www と apex のようにホスト名がずれるだけで起きる。本番では未確認） |
| TOTP の登録・検証 | `mfa_totp_enroll_enabled`・`mfa_totp_verify_enabled` | `true`・`true` | `[auth.mfa.totp]` | `SEC-AUTH-030-AC-01`・`FREQ-316-REQ-02-AC-01`。管理者の二要素 |
| メールでのサインインを有効にする | `external_email_enabled` | `true` | `[auth.email] enable_signup` | 変えない（アプリの `/signup` が要る） |
| 新規のサインアップを許す | `disable_signup` | `false` | `[auth] enable_signup = true` | 変えない |
| 漏洩パスワードの確認 | `password_hibp_enabled` | `true` | 手元に無い | **プラン依存**（Supabase の公式は Pro 以上。本番の組織は Free〔2026-11-06 に MCP の `get_organization` で確認〕なので今は使えない）。拒まれたら台帳へ。アプリ側の `checkPwnedPassword` は登録・再設定・変更の窓口を守るが、直接の `/signup`・`/user` には効かない |
| PostgREST の最大行数 | `max_rows`（`PATCH /v1/projects/{ref}/postgrest`） | `1000`（今の値が 1000 より大きい時だけ下げる） | `[api] max_rows` | 手元は 1000 |
| 一人一端末 | `sessions_single_per_user` | `false` のまま（キーが無い時も「オフ」として進む） | 手元に無い | `true` だと、パスワード変更の「現行パスワードの確認」の `signInWithPassword` が今の session を消し、確認コードが結んだ `session_id` が死ぬ。`true` なら段階 A に進まずオーナーに知らせる |

### 雛形

確認メール（件名 `メールアドレスの確認`。有効期限の字は `otp_expiry` に合わせて「5分」）。

```html
<h2>メールアドレスの確認</h2>
<p>会員登録を完了するには、次のリンクを開いてください。</p>
<p><a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup">メールアドレスを確認する</a></p>
<p>ログインには、最初に登録したときのパスワードをお使いください。思い出せない場合は、ログイン画面のパスワードの再設定から設定し直せます。</p>
<p>リンクの有効期限は5分です。心当たりがない場合は、このメールを破棄してください。</p>
```

「最初に登録したときのパスワード」の 1 行は、確認前の会員が別のパスワードで登録し直しても最初のパスワードは変わらない（先回りの乗っ取りの防止。THR-AUTH-016）ため。全員に同じ文を出すので、登録済みかどうかは明かさない。

パスワード変更の通知（GoTrue 側。件名 `パスワードの変更を受け付けました`）。

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
| Redirect URLs（`uri_allow_list`） | 確認メールのリンクの戻り先（アプリの `/api/auth/confirm`）を GoTrue が受け付ける条件。台帳には Site URL（1c）しか無い | ダッシュボードの Authentication → URL Configuration → Redirect URLs | `APP_ALLOWED_ORIGINS` の各オリジンの `/api/auth/confirm` が、Site URL と同じホスト名か Redirect URLs に当たること（www と apex のようにずれるなら Redirect URLs に足す）。段階 A の前提。台帳に行を足す |
| 確認メールの雛形の `{{ .Token }}` | 台帳の「ログインのメールの型」 | ダッシュボードの Authentication → Emails | ログインの確認コードのメールに `{{ .Token }}` が入っていること |
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
7. **`site_url` と `uri_allow_list`**。アプリの確認の戻り先（`APP_ALLOWED_ORIGINS` の各オリジンの `/api/auth/confirm`）が、Site URL と同じホスト名か `uri_allow_list` に当たるか。当たらなければ段階 A に進まず、オーナーに Redirect URLs を足してもらう（上の「手で変える項目」）。
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
| TOTP | `mfa_totp_enroll_enabled`、`mfa_totp_verify_enabled` |

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

### 手順 1: メールのログインの設定（パスワード・コード）

住所: `https://supabase.com/dashboard/project/pjidrgofvaglnuuznnyj/auth/providers?provider=Email`

左の **Authentication** → **Sign In / Providers** → 一覧の **Email** を開く。開いた欄で次のとおりにする。

| 欄（英語の表示） | 何のための欄か | 設定する値 | 今の値が違う時 |
| --- | --- | --- | --- |
| Enable Email provider | メールでのログイン | **オンのまま** | 触らない |
| Confirm email | 登録の時に確認メールを必須にする | **オンのまま**（本番はすでにオン） | 触らない |
| Secure email change | メールアドレスの変更で新旧両方に確認を送る | **オン** | オンにする |
| Secure password change | 古いログインのままのパスワード変更に再確認を求める | **オン** | オンにする |
| Require current password when updating | パスワード変更で今のパスワードを求める | **オン** | オンにする |
| Prevent use of leaked passwords | 漏れたパスワードを拒む | **触らない**（Pro 以上でしか使えない。本番は Free） | — |
| Minimum password length | パスワードの最低の文字数 | **16** | 16 にする |
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
<p>会員登録を完了するには、次のリンクを開いてください。</p>
<p><a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup">メールアドレスを確認する</a></p>
<p>ログインには、最初に登録したときのパスワードをお使いください。思い出せない場合は、ログイン画面のパスワードの再設定から設定し直せます。</p>
<p>リンクの有効期限は5分です。心当たりがない場合は、このメールを破棄してください。</p>
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

`{{ .RedirectTo }}`・`{{ .TokenHash }}`・`{{ .Token }}` は Supabase が送る時に中身へ置き換える印。1 字でも変えるとリンクやコードが壊れるので、そのまま貼る。

### 手順 3: パスワード変更の通知のメール

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

### 手順 4: 二段階の認証（TOTP）

住所: `https://supabase.com/dashboard/project/pjidrgofvaglnuuznnyj/auth/mfa`

左の **Authentication** → **Multi-Factor** を開く。**Authenticator App (TOTP)** が **Enabled**（登録も確認もできる）になっていることを確かめる。既定でオンなので、オンなら何もしない。オフなら Enabled にして保存する。店長の画面の二段階の認証に使う。

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
