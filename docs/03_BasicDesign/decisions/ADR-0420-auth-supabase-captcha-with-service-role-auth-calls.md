# ADR-0420 Supabase の captcha を有効にし、アプリのサーバーの認証の呼び出しは管理者資格で行う

> 状態: 現行（アプリ側の切り替えまで入った。Supabase の captcha の有効化は手元の設定の切り替えと本番の段階 B で行う） | 確認日: 2026-11-01 | 対象: Supabase Auth の captcha（Turnstile）、`src/lib/auth/service-role-auth-client.ts`、`src/app/api/auth/login/route.ts`・`login/resend/route.ts`・`register/route.ts`、`src/features/auth/services/password-change.ts` | 基準コミット: `60a92dbb`（作業ツリー）

## 概要

anon の鍵は公開なので、アプリを通らずに Supabase Auth の窓口（`/signup`・`/token`（password）・`/otp`・`/recover`・`/resend`・`/magiclink`）を直に叩ける。この呼び出しは、アプリの Turnstile・回数の制限・漏洩の確かめを全部飛ばす。Supabase の captcha（Turnstile）をオンにして、トークン無しの直の呼び出しを 400 にする。アプリのサーバーが同じ窓口を呼ぶ 6 か所（ログイン 2 回・ログインの再送・会員登録・未確認の会員の確認メールの再送・パスワード変更の現行パスワードの確認）は、サービスの鍵で呼び、GoTrue の管理者免除で通す。アプリ側の Turnstile の検証・順番・枠は変えない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SEC-AUTH-015、SEC-AUTH-035 |
| 対象のコード | `src/lib/auth/service-role-auth-client.ts`（`createServiceRoleAuthClient`・`isCaptchaRejection`）、`src/app/api/auth/login/route.ts`、`src/app/api/auth/login/resend/route.ts`、`src/app/api/auth/register/route.ts`、`src/features/auth/services/password-change.ts` |
| 関連文書 | [AUTH の要件](../../02_Requirements/areas/auth.md)、[ログインと認証の詳細設計](../../04_DetailDesign/pages/14_login.md)（DD-AUTH-040）、`docs/superpowers/plans/2026-11-01-wave6-captcha-password-change-config.md`（P1〜P7・ruling 8・10）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave6-decisions.md`、`wave6-task0-report.md`、`wave6-research.md` |
| 試験 | `tests/unit/lib/auth/service-role-auth-client.test.ts`、`tests/unit/lib/supabase-client-isolation.test.ts`、`tests/unit/api/auth/login-route.test.ts`・`login-resend-route.test.ts`・`register-route.test.ts`。直の呼び出しが 400 になること（`SEC-AUTH-015-AC-04`）は E2E（波 6 の Task 7・10） |
| 調べた時点 | 2026-11-01（単体の試験は流した。隔離した Supabase での実測は Task 0 で済み） |

## 判断

### ADR-0420 Supabase の captcha を有効にし、アプリのサーバーの認証の呼び出しは管理者資格で行う

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-015、SEC-AUTH-035 |
| 根拠 | 直の呼び出しを塞がないと、アプリの Turnstile・回数の制限・漏洩の確かめは回避できる飾りになる（総当たり・メール枠の使い切り・弱いパスワードの登録）。Supabase の captcha を有効にすれば GoTrue が窓口で塞ぐ。アプリのサーバーは管理者資格で呼べば免除される（Task 0 の実測で、旧方式の `service_role` の JWT と `sb_secret_` の両方が、トークン無しで通った） |
| 状態 | 現行 |
| 出どころ | ユーザーの決定（2026-11-01「Q28 は案 (b')」）、`wave6-decisions.md`、計画の P1〜P7・ruling 8・10 |

#### 背景

| 観点 | 今の私たち（直す前） | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 公開の認証の窓口の bot 対策 | アプリの窓口に Turnstile があるが、Supabase の窓口は anon の鍵だけで直に叩ける | 確かめていない（公式資料で読んでいない） | 認証の提供元の captcha を有効にし、サーバー間の呼び出しは免除する（Supabase の公式は CAPTCHA protection でウィジェットのトークンを `captchaToken` で渡す方式） | 提供元の captcha をオンにし、アプリのサーバーは管理者資格で免除させる |
| トークンの扱い | Turnstile のトークンは 1 回しか使えない | - | トークンは 1 回の検証で消費される（Cloudflare の仕様） | アプリの検証の後で GoTrue へ転送しない（転送すると 2 回目の検証で落ちる） |

#### 決定

- Supabase の captcha（Turnstile）を有効にする。有効にするのは手元の設定の切り替え（波 6 の Task 10。2026-11-01 に済み）と本番の段階 B（Task 11。未実施）で、アプリのコードは先に入れる。captcha が切れている間は、管理者資格で呼ぶだけで挙動は同じ
- captcha が掛かる窓口をアプリのサーバーが呼ぶのは 6 か所だけ（ログインの `signInWithPassword` と `signInWithOtp`、再送の `signInWithOtp`、登録の `signUp`、未確認の会員が同じメールで登録し直した時の確認メールの再送 `auth.resend({ type: 'signup' })`〔SEC-AUTH-016-AC-04。確認のリンクの期限 5 分を過ぎた会員が締め出されないため〕、パスワード変更の現行パスワードの確認の `signInWithPassword`〔`src/features/auth/services/password-change.ts`〕）。この 6 か所は `createServiceRoleAuthClient()` で呼ぶ。`verifyOtp`・`exchangeCodeForSession`・`refresh`・`mfa.*`・`admin.*` は captcha が掛からないので触らない
- `createServiceRoleAuthClient()` は `{ auth }` だけを返し、毎回新しく作る。`auth` は 4 つの関数（`signInWithPassword`・`signInWithOtp`・`signUp`・`resend`。`bind` した物）だけで、`auth.admin`・`auth.mfa`・`getSession` などは型にも実体にも持たせない（最終レビュー指摘 4、2026-11-01。サービスの鍵の見出しで動く管理 API が、利用者の入力を扱う呼び手から届かないように）。`signInWithPassword` の後、クライアントは利用者の session をメモリに保持する。そのクライアントで DB や RPC を呼ぶと権限が混ざるため、`.from()`・`.rpc()` も型にも実体にも持たせない。DB・RPC・管理 API は従来の `createServiceRoleClient` を別の変数で使う
- 手元の設定を切り替える時（波 6 の Task 10。2026-11-01 に済み）は、確認メールの雛形も足す（`[auth.email.template.confirmation]`、`supabase/templates/confirmation.html`）。本文のリンクは `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup`。`enable_confirmations = true` で GoTrue の既定の `ConfirmationURL`（`/auth/v1/verify`）のままだと、リンクを開いた時に GoTrue が印を使い切り、fragment を付けて確認の窓口 `/api/auth/confirm` へ送る。窓口は query の `token_hash` を読むので `missing_token_hash` で落ち、会員登録の確定ができない。本番の確認メールの雛形も同じ前提にする（`docs/06_Operations/supabase-auth-config.md` に同じ本文を載せる）。あわせて `magic_link.html` の有効期限の文言を `otp_expiry = 300` に合わせて「5分」に直す（Task 8 のレビュー、2026-11-01。計画の ruling 21・22）
- アプリの Turnstile の検証・順番・回数の制限は変えない。再送にウィジェットを足さない（署名つきの保留の Cookie と IP・宛先の二段の枠が前提。再送のたびの検査は UX を壊す）
- 確認メールの雛形には「ログインには、最初に登録したときのパスワードをお使いください。思い出せない場合は、ログイン画面のパスワードの再設定から設定し直せます。」の 1 行を入れる（最終レビュー指摘 6、2026-11-01）。確認前の会員が別のパスワードで登録し直しても、最初のパスワードは変わらない（先回りの乗っ取りの防止。THR-AUTH-016）ので、最初のパスワードを覚えていない人が確定の後に入れなくなるのを案内で補う。全員に同じ文を出すので、登録済みかどうかは明かさない
- ログインの `signInWithPassword` で GoTrue が 429（IP ごとの回数の制限）や 5xx・通信の失敗を返した時も、同じ理由で 401 に丸めない（最終レビュー指摘 2）。429 は 429＋`Retry-After`・監査 `supabase_rate_limited`、5xx・通信の失敗は 503・監査 `supabase_unavailable` にする。資格情報の誤り・未確認のメール（400 `email_not_confirmed`）だけが同じ本文の 401 のまま（見分けを作らない）。パスワード変更の `verifyCurrentPassword` と同じ分け方にそろえる
- 管理者免除が効かない時に Supabase は 400 `captcha_failed` を返す。これを資格情報の誤り（401）や重複に丸めると、全員が入れない・登録できない故障が監視に上がらない。`isCaptchaRejection` で見分け、5xx と監査 `supabase_captcha_rejected` にする（誤りの本文は残さない）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| (a) 先送り（captcha を入れない） | 直接の総当たり・メール枠の使い切りが残る |
| (b) アプリが Turnstile のトークンを GoTrue へ転送する | トークンは 1 回しか使えない。ログインの 2 回呼び（パスワード→ OTP）・再送・アプリ側の検証の順番が崩れる |
| (c) 公開サインアップ停止＋`generateLink` | ログイン側（`/token`・`/otp`）が残る。Google の新規登録が止まる |
| (d) `before_user_created` フック | 直接の呼び出しとアプリの呼び出しを見分ける材料がフックに無い |

#### 結果

- 良くなること: アプリを通らない直の `/signup`・`/token`・`/otp` がトークン無しで 400 になり、アプリ側の Turnstile・枠・漏洩の確かめを回避できなくなる。captcha の拒否が利用者の誤りに紛れず、故障として見える
- 悪くなること: 公式の文書に無い GoTrue の挙動（管理者資格が captcha を免除する）に頼る。サービスの鍵で呼ぶので、`signInWithPassword` のたびに GoTrue 側へ結び付かない session が 1 本残る（`is_app_session_active` が偽にするので無害。後始末は回す物）。普段の開発（`npm run dev`）は本番の Supabase につながるため、本番の captcha をオンにする前にこのコードが入っている必要がある
- 前提: Supabase の captcha の秘密は手元では環境変数 `SUPABASE_AUTH_CAPTCHA_SECRET`（Cloudflare の公開のテスト用の値）、本番はアプリの `TURNSTILE_SECRET_KEY` と同じウィジェットの秘密
- 見直す条件: GoTrue が管理者の免除をやめたら、または本番で `sb_secret_` が免除されない時は、captcha 用の呼び出しにだけ旧方式の `service_role` の JWT を使う環境変数を足す（controller の裁定）。それも通らなければ (c) に倒す。この挙動は公式の文書に無いので、E2E（`SEC-AUTH-015-AC-04`）が毎回確かめる

## 未確認事項

- 本番の鍵 `sb_secret_` が、本番の GoTrue で管理者として免除されるか。手元の CLI が出す `sb_secret_` では通った（Task 0）が、本番は段階 B の確かめで初めて分かる。崩れたらその場で `security_captcha_enabled: false` に戻す
- captcha がオフの段階（本番の段階 B の前、切り替え前の手元）で、本番の `/token`・`/otp`・`/signup`（と未確認の再送の `/resend`）が `sb_secret_` を Bearer に受けるか。アプリのコードを先に入れるので、captcha を入れる前でも `sb_secret_` で呼ぶ窓口が通ることを確かめる必要がある（Task 11 で確かめる）
- 本番の Turnstile のウィジェットが未作成の可能性が高い。無ければ段階 B は、ウィジェットの作成の後に回す
