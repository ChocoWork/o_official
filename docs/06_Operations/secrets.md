---
title: シークレット管理方針
---

# シークレット管理方針（暫定: 手動運用）

> 状態: 既存の運用方針 | 本番設定・手順の適用状況は未確認 | 確認日: 2026-10-02（`ADMIN_API_KEY` の廃止の節は 2026-10-26、ビルドの前に要る環境変数の節と `CLIENT_IP_HEADER` の節は 2026-10-28（E2E の行は 2026-11-07）、`AUTH_REQUIRE_APP_SESSION` の節は 2026-10-29、`APP_ALLOWED_ORIGINS` の必須化と captcha 関連の節は 2026-11-01 に追記）

この文書中の `docs/seq/supabase-service-role-key-rotation-diagrams.md` は現行リポジトリに存在しない旧計画への参照である。自動ローテーションを実施済みとは扱わず、実施前に現在の秘密値の保管場所、権限、手順を確認する。
## 概要

このドキュメントは `SUPABASE_SERVICE_ROLE_KEY` 等の運用上重要なシークレットの**初期運用手順（手動）**を定めます。事業成長に合わせて自動ローテーション（`docs/seq/supabase-service-role-key-rotation-diagrams.md`）へ移行する計画です。

## 適用範囲

- SUPABASE_SERVICE_ROLE_KEY
- JWT_SECRET（アプリの共通鍵）
- AWS_SES_* 等送信に必要なシークレット

## 初期（手動）運用プロセス

1. 発行・変更
   - シークレットの発行は運用担当（Ops）または認可された管理者が行う。
   - 新しいキーを発行したら、Secrets Manager（または Vercel/環境に応じた安全なストア）に手動で登録する。
2. 公開手順
   - 登録後、デプロイ手順（CI）を通じてアプリに反映する。手順書を `docs/06_Operations/secrets-rotation.md` に記載する。
3. 承認と記録
   - すべてのローテーション操作は PR ではなく運用チケット（Ops のチケットトラッカー）で記録し、少なくとも 1 名の別人による承認を得ること。
   - 変更時には監査ログを記録（who/when/why）する。`src/lib/audit.ts` に該当イベントを吐くことを推奨。
4. 検証
   - 新キー適用後は影響範囲の smoke tests（簡単なヘルスチェック）を実行し、問題がないことを確認する。
5. ロールバック
   - 問題発生時は直ちに旧キーへロールバックする手順を実行し、影響を最小化する。詳細は `docs/06_Operations/secrets-rotation.md` に記載。

## セキュリティ注意点

- シークレットは平文で保存しない。コミット禁止（`.gitignore` 有効）。
- 誰がアクセスできるかは最小権限の原則に従い、必要な人のみアクセスを許可する。
- 漏洩疑いがある場合は即座に暫定値を投入し、緊急ローテーションフローを開始する（`docs/seq/supabase-service-role-key-rotation-diagrams.md` を参照）。

## 将来的な自動化（移行計画）

- 事業拡大に伴い、`docs/seq/supabase-service-role-key-rotation-diagrams.md` に記載された自動ローテーションフローを採用する予定です。
- 自動化のための TODO:
  - CI/CD の secret rotation playbook の用意（`.github/workflows/rotate-secrets.yml`）
  - 確認テスト自動化（デプロイ直後の smoke tests）
  - 監査・アラートの自動化（CloudTrail / SNS 通知）

---
*作成: SDD Agent (追記) — 現行は手動運用、将来的に自動運用へ移行予定*

## Stripe注文同期

Stripe Webhookは `${APP_BASE_URL}/api/webhook/stripe` に設定し、署名シークレットを
`STRIPE_WEBHOOK_SECRET` としてサーバー環境だけに保存します。受け取り口が保存する次の13種（`src/lib/stripe/handled-webhook-events.ts`）を購読します。ほかの種類は保存しません。本番の鍵のアプリには本番の宛先、テストの鍵のアプリにはテストの宛先をつなぎます（食い違うと処理せず、店へ知らせます）。

| イベント | 用途 |
| --- | --- |
| `checkout.session.completed` | Checkout Session の現在値を照合し、注文・決済状態へ反映する |
| `checkout.session.async_payment_succeeded` | 時間差決済の現在値を照合し、注文・決済状態へ反映する |
| `checkout.session.async_payment_failed` | 時間差決済の現在値を照合し、注文・在庫へ反映する |
| `checkout.session.expired` | 期限切れ Session を照合し、注文・在庫へ反映する |
| `payment_intent.succeeded` | PaymentIntent を照合し、注文・決済状態と会計記録へ反映する |
| `payment_intent.payment_failed` | PaymentIntent の現在値を照合し、注文・在庫へ反映する |
| `refund.created` | 合図にして、その支払いの返金を Stripe から全部読み直し、1件ずつ返金の記録に合わせる（記録・在庫・メールの予定・注文の返金済みの額と状態を1回で書く）。返金の会計記録も同期する。支払いの番号の無い返金と、支払い手続き中・未入金・失敗・放棄の注文の返金は、監査に残して終える。注文が無い場合は監査に残し、失敗・取消なら要対応にして店へ知らせる |
| `refund.updated` | 同じ読み直しで、返金の状態の変わり（保留から成功・失敗など）を返金の記録に反映し、返金の会計記録を同期する。注文が無い失敗・取消は要対応にして店へ知らせる |
| `refund.failed` | 同じ読み直しで、失敗した返金を返金の記録に反映する（外した在庫を確保し直し、要対応「返金の失敗」にして店へ知らせる）。返金の会計記録も同期する。注文が無ければ要対応にして店へ知らせる |
| `charge.refunded` | Charge の返金を、同じ読み直しで返金の記録に合わせる。注文が無い場合は監査に残して処理を続ける |
| `payout.paid` | Stripe の Payout を会計記録へ同期する |
| `payout.failed` | Payout の失敗を会計記録へ同期する |
| `payout.reconciliation_completed` | Payout の照合結果を会計記録へ同期する |

返金の `refund.*` 購読が無いと、注文の無い失敗・取消返金が要対応として記録されず、店への通知も行われません。また、受け口に返金の4つの知らせ（`refund.created`・`refund.updated`・`refund.failed`・`charge.refunded`）を入れていないと、Stripe の画面で直接返した返金が返金の記録に入らず（毎晩の照合が前の48時間の分を拾うまで）、在庫もお客様へのメールも動きません。本番の受け口には、開店前に4つとも入れます（グループ E の開店前の設定）。

定期照合は毎日 18:00 UTC（日本時間 3:00）に pg_cron＋pg_net が `POST /api/cron/stripe-reconcile` を呼び出し、`Authorization: Bearer
${CRON_SECRET}` を付与します。Stripeだけに存在する未返金の成功決済は報告対象になり、照合では注文を作りません
（注文の無い支払いのうち、直近24時間に作られた Checkout Session のものだけを、毎時の見回りが拾います。それより古いものは見回りでは拾いません。照合は、直近7日の注文の無い成功の支払い（全額返金済みを除く）と、支払い・入金ごとの失敗を、見つかった夜だけ、1回の実行につき1通のメール（宛先は `SHOP_ALERT_EMAIL`）で店へ知らせます。7日より古い支払いは、照合の結果の `unmatchedPayments` の件数にだけ入ります）。返金は、前の48時間に Stripe で作られた返金の支払いと、こちらの保留の返金の支払いを集め、返金の知らせと同じ取り込みで1件ずつ返金の記録に合わせます（グループ E-2。成功した返金の合計を全部の支払いで比べる同期はやめました）。

## Stripe 側の返金のメール（グループ E-2）

Stripe 自身が返金のたびにお客様へ送る返金のメールは、こちらの返金のお知らせと二重になるので、開店前に本番の Stripe の設定「顧客に返金のメールを送信する」を切ります（テストの設定と本番の設定は別です。本番で切ります）。コンビニ払いの口座の入力のお願いのメールは、Stripe が返金先をお客様に聞くためのメールなので、切りません。手順は[注文のメールの手順書](order-email-operations.md)の 8-1 に従います。

## RESEND_DELIVERY_WEBHOOK_SECRET

Resend の配達の状態の知らせ（`POST /api/webhook/resend-delivery`）の Svix 署名の鍵です（`whsec_` で始まる）。お問い合わせの返信の `RESEND_WEBHOOK_SECRET` とは別の宛先・別の鍵にします。Vercel の環境変数にだけ置きます。入れ替えは[注文のメールの手順書](order-email-operations.md)の4に従います。

本番の注文のメールは `MAIL_PROVIDER` に `resend`（小文字）を入れた時だけ送ります（ほかの送り手では送信を止めます）。`resend` は送り手を選ぶ値で秘密ではありません。`resolveMailProvider` は大文字小文字まで完全一致で見るため、`Resend` と入れると全部止まり、店への知らせも届きません。`RESEND_API_KEY` は Full access にします（送信専用の鍵だと、1時間ごとの配達の見回りが動きません）。

## CRON_SECRET

定期処理の入口（worker・見回り・照合・Meta の同期）の合言葉です。32文字以上のランダムな値にします。短いと全部の入口が設定の誤りとして断ります。Vercel の環境変数と、本番 DB の Vault（`cron_secret`）にだけ置きます。入れ替えは[手順書](webhook-queue-operations.md)の2に従います。

## ビルドの前に要る環境変数（NEXT_PUBLIC_SITE_URL・NEXT_PUBLIC_SUPABASE_URL・APP_ALLOWED_ORIGINS）

`NEXT_PUBLIC_*` はビルドの時にコードへ埋め込まれます。本番（Vercel の Production。`VERCEL_ENV=production`）では、次の 3 つが**ビルドの前**に設定されていないと、ビルドが落ちます（`next.config.ts` の先頭の `assertBuildEnv`。2026-10-28、SEC-ABOUT-007、`ADR-0206`。`APP_ALLOWED_ORIGINS` は 2026-11-01、SEC-ABOUT-007-AC-02）。落ちる文には変数名だけが出て、値は出ません。

| 変数 | 値 | 使われ方 |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | 本番の https のサイト（末尾に `/` を付けない。例 `https://www.example.com`） | 共有のカードの画像（`og:image`）の基点、注文メールの状況ページのリンクの元、CSRF の許可オリジンの既定（`getSiteUrl`）。未設定だと `http://localhost:3000` に落ちる |
| `NEXT_PUBLIC_SUPABASE_URL` | 本番の Supabase のプロジェクトの URL（`https://<ref>.supabase.co`） | ブラウザの接続先、CSP の `img-src`・`connect-src` と画像の中継 `remotePatterns` の許す host（自分のプロジェクト 1 つだけ） |
| `APP_ALLOWED_ORIGINS` | 状態変更 API の `Origin` / `Referer` を照合する許可オリジンの一覧（カンマ区切り。www と apex など複数可）。詳しくは下の `APP_ALLOWED_ORIGINS` の節 | CSRF の確かめ（`src/proxy.ts`）とリダイレクト先の検証（`src/lib/redirect.ts`）。無いと、設定漏れで許可の一覧が曖昧なまま本番に出るのを防ぐため、ビルドを止める |

- `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_URL`（サーバー側の接続先。署名つき URL はこちらを優先して作る）が**別の origin を指す設定も、ビルドが落ちます**（`VERCEL_ENV` に依らず手元でも）。署名が通っても、画像が CSP と `/_next/image` で止まるためです。2 つとも同じプロジェクトの URL にします。末尾の `/` やパスの違いは無視されます
- 環境変数をビルドの後に足しても、できたビルドには入りません。設定してから再ビルド・再デプロイします（[注文のメールの手順書](order-email-operations.md)の 5 と同じ）
- 落ちる条件は `VERCEL_ENV` が `production` のときだけです。手元・Vercel の Preview・E2E の本番ビルド（`NODE_ENV=production` だけ）は、3 つが無くても落ちません
- 本番のアプリは未デプロイで、Vercel に 3 変数が入っているかは未確認です。初回の配備の前に入れます

## CLIENT_IP_HEADER（送り元の IP を読む旗。秘密ではない）

> 確認日: 2026-10-28 | 対象: `src/lib/request-ip.ts` の `getClientIp` | 設計判断: [ADR-0416](../03_BasicDesign/decisions/ADR-0416-auth-client-ip-vercel-headers-only.md)

回数の制限の鍵と監査の IP に使う「送り元の IP」を、アプリは `x-vercel-forwarded-for`、`x-real-ip` の順に読む。ただし読むのは `VERCEL=1` か `CLIENT_IP_HEADER` が空でない時だけで、`x-forwarded-for` は読まない。`CLIENT_IP_HEADER` は「この環境では見出しを信じてよい」という旗で、値は見ない。

| 環境 | 扱い |
| --- | --- |
| 本番（Vercel） | 置かない。Vercel が `VERCEL=1` を自動で入れ、見出しを上書きして付けるので足りる |
| E2E（手元の Supabase） | `scripts/e2e/environment.ts` の `E2E_FIXED_ENV` が `CLIENT_IP_HEADER=x-real-ip` を入れる。E2E の送り元の分け方は `x-real-ip` で行う。`playwright.config.ts` は文脈（browser context・request fixture）ごとに `198.19.0.0/16` の別の `x-real-ip` を付ける（2026-11-07。付けないと全部の試験が ip が NULL の1つの枠を分け合い、全件の時だけ回数の制限で落ちる）。要求ごとに見出しを渡す試験はそちらが勝つ。`.env.local` や `.env` には書かない |
| 手元の開発・単体の試験 | 置かない。見出しの無い要求は送り元が null になり、回数の制限は 1 つの枠を共有し、監査の IP は null で残る。単体の試験は `tests/setupClientIp.js` が立てる |
| Vercel 以外の置き場 | 前段の中継（リバースプロキシ）が利用者の付けた `x-real-ip` を捨てて自分の見る接続元の IP で上書きすると確かめてから、`CLIENT_IP_HEADER` に空でない値（例 `x-real-ip`）を置く。確かめずに置くと、利用者が送り元を偽って回数の制限を越え、監査の IP を偽れる |

- E2E では、旗は `buildE2EOverrides` の中だけで混ざる。その環境は手元の Supabase の状態を読んだ後に作り、`findUnsafeE2ESettings` が Supabase の住所を条件なしで検査する（手元でなければ止める）。旗の専用の見張りは足していない
- `TRUST_PROXY_HEADERS` は別の意味（`x-forwarded-host`・`x-forwarded-proto` からオリジンを作ってよいか。`src/lib/redirect.ts`）で、この旗に使い回さない
- 前段に Cloudflare などの中継を置く時は、段数を決める `TRUSTED_PROXY_HOPS` の設計を足す（今回は作らない）。詳しくは[配置構成](deployment-topology.md)

## AUTH_REQUIRE_APP_SESSION（アプリのログインに結び付いた session だけを受ける旗。秘密ではない）

> 確認日: 2026-10-29 | 対象: `src/lib/auth/app-session.ts` の `isAppSessionRequired` | 設計判断: [ADR-0419](../03_BasicDesign/decisions/ADR-0419-auth-require-app-session-flag-default-on.md)

公開の anon キーだけで取れるパスワードだけ・メール OTP だけの通行証を、会員の窓口が受けないための旗。アプリのログイン（パスワード → メール OTP → 必要なら TOTP）を通ると、自前の `sessions` に GoTrue の `session_id` を残した行ができる。旗が有効な間、窓口と `refresh` はその行に結び付いた session だけを通す。値が `off`・`0`・`false`（大小文字を区別せず、前後の空白は無視）の時だけ無効で、未設定・空・その他は有効（既定）。

| 環境 | 扱い |
| --- | --- |
| 本番 | 設定しない（既定で有効）。`off` は段階の切替えと緊急の時だけ。外すと、結び付いていない session の通行証が窓口を通る |
| E2E（手元の Supabase） | `scripts/e2e/environment.ts` の `E2E_FIXED_ENV` が `AUTH_REQUIRE_APP_SESSION=on` に固定する。手元の `.env.local` に `off` が残っていても上書きする。固定の鍵はサーバーの印（`computeServerFingerprint`）に入るので、旗が違う古い 3000 番のアプリは使い回されない。E2E の通行証は `e2e/admin-session-test-utils.ts` の `bindAppSession` が結び付ける |
| 手元の開発・単体の試験 | 置かない（既定で有効）。単体も実際の結び付けの道を通す。無効の分岐は、その試験の中で値を明示して確かめる |

- 旗が切り替えるのは読む側（生存の確認と `refresh` の強制）だけ。書く側（ログイン・更新・昇格が `auth_session_id` を残すこと）は旗に関係なく常に書く。DB 側の守り（`has_permission` と会員の表の方針）に旗は無い
- 有効にした時（または初めて配備した時）、`auth_session_id` を持たない既存の session は使えなくなり、全員が再ログインになる
- 移行 M1（`sessions.auth_session_id` 列と生存の関数）が当たっていないと、書く側が全ログインを落とし、読む側が全要求を 503 にする

## APP_ALLOWED_ORIGINS

状態変更 API（`/api/auth` `/api/admin` `/api/cart` `/api/checkout/*` `/api/wishlist`）の
CSRF 対策で、`Origin` / `Referer` を照合する許可オリジンの一覧。カンマ区切り。

```
APP_ALLOWED_ORIGINS=https://www.example.com,https://example.com
```

未設定でも `NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_BASE_URL` / `BASE_URL` /
`NEXT_PUBLIC_VERCEL_URL` のいずれかがあればそれを使う。どれも無い場合は
リクエスト由来のオリジンとの一致で判定し、警告を出す（設定漏れだけで全 API が
403 になるのを避けるため）。これは手元・Preview・テストでの動きで、
**本番（Vercel の Production。`VERCEL_ENV=production`）では `APP_ALLOWED_ORIGINS` が
ビルドの前に必須**（無いとビルドが落ちる。2026-11-01、SEC-ABOUT-007-AC-02）。
Vercel の Production の環境変数に、ビルドの前に入れること。**書式も見る**（2026-11-01）:
カンマで分けた各項目が `https://host[:port]` の形（空の項目・`http:`・scheme 無し・
末尾の `/`・パスは、ビルドが落ちる）。`example.com` や `https://example.com/` のような
書き間違いを、実行時に黙って許可から捨てさせないため。`proxy.ts` と
`redirect.ts` の読み方（上の退避の動き）は変えていない。

同じ一覧を `getRequestOrigin`（リダイレクト先の検証）も使う。片方だけ設定する、
という状態は作らないこと。

## TURNSTILE_SECRET_KEY（アプリの Turnstile の検証の秘密。Supabase の captcha にも同じ値）

> 確認日: 2026-11-01 | 対象: `src/lib/turnstile.ts`、Supabase の captcha | 設計判断: [ADR-0420](../03_BasicDesign/decisions/ADR-0420-auth-supabase-captcha-with-service-role-auth-calls.md) | 手順: [本番の Supabase Auth の設定](supabase-auth-config.md)

登録・ログイン・パスワード再設定の申請・お問い合わせで、アプリが Cloudflare の Turnstile を検証する秘密（`NEXT_PUBLIC_TURNSTILE_SITE_KEY` は公開の対）。本番で値が無いと、検証は失敗に倒れる。Vercel の環境変数にだけ置く。

- **同じ Cloudflare のウィジェットの秘密を、Supabase の captcha（本番の `security_captcha_secret`）にも入れる。** 理由: アプリの検証（`TURNSTILE_SECRET_KEY`）と Supabase の検証（直接の `/signup`・`/token` を塞ぐ）が、同じウィジェットが発行したトークンだけを通すようにするため。別の秘密を入れると、片方の検証でトークンが拒まれる。値はこの文書にもチャットにもコミットにも書かない。
- **本番の Supabase の captcha に、Cloudflare のテスト用の秘密（`1x0000000000000000000000000000000AA`。常に通る）を入れない。** 入れると、ダミーのトークンで誰でも直接 `/signup`・`/token` を叩け、captcha が無いのと同じになる。手元の隔離スタックだけがこの値を使う。段階 B の確かめで、anon にダミーのトークンを付けた `/token` が 400 になることを測る。
- 手元の `.env.local` と `.env.example` の値は、Cloudflare の公開のテスト用（常に通る）で、本番の秘密ではない。
- アプリのサーバーが GoTrue を呼ぶ 5 か所（ログイン 2 回・ログイン再送・会員登録・パスワード変更の現行パスワードの確認）は service role の鍵で呼び、GoTrue 側の captcha は免除される。アプリはそこへトークンを転送しない（Turnstile のトークンは 1 回しか使えない）。
- 本番の Turnstile のウィジェットは未作成の可能性が高い。無ければ、ウィジェットを作ってから、Vercel の `TURNSTILE_SECRET_KEY` と Supabase の captcha に同じ秘密を入れる（Supabase 側は段階 B。先にアプリの検証を有効にする）。

## SUPABASE_AUTH_CAPTCHA_SECRET（手元の Supabase の captcha の秘密。手元だけ）

手元の `supabase/config.toml` の `[auth.captcha] secret = "env(SUPABASE_AUTH_CAPTCHA_SECRET)"` が読む。値は Cloudflare の公開のテスト用 `1x0000000000000000000000000000000AA`（常に通る）。`supabase/.env.example` を `supabase/.env`（`.env*` は未追跡）に写すか、`npm run db:start` の前にシェルで同じ変数を設定する。CLI が `supabase/.env` を読むかは未検証なので、起動後に auth のコンテナの `GOTRUE_SECURITY_CAPTCHA_SECRET` がこの値になっていることを確かめる。**本番の秘密を `config.toml` にも `supabase/.env` にも書かない**（`supabase config push` が本番へ押し出す危険があるため、`config push` は流さない）。

## SUPABASE_ACCESS_TOKEN（Management API 用の個人用トークン。作業者のシェルだけ）

本番の Supabase Auth の設定を `PATCH /v1/projects/{ref}/config/auth` で読み書きする時だけ使う、ダッシュボード（Account → Access Tokens）で作る `sbp_...` のトークン（`auth:write` を含む）。作業者のシェルの環境変数にだけ入れ、ファイル・文書・ログ・報告・コミットに書かない。作業が終わったらダッシュボードで消す。手順は[本番の Supabase Auth の設定](supabase-auth-config.md)。

## ADMIN_API_KEY（廃止。もう読まない）

以前は `POST /api/auth/register` が `x-admin-token`（又は `Authorization: Bearer`）を `ADMIN_API_KEY` と照合し、一致すると管理の作成の枝（確認なしで会員を作る）に切り替えていた。波 1-B（2026-10-26）でこの枝を削除した（SEC-AUTH-017）。今は `src` のどこにも `ADMIN_API_KEY` を読む所が無く、`/api/auth/register` はいつも公開の会員登録として扱う。E2E の固定の環境（`scripts/e2e/environment.ts` の `E2E_FIXED_ENV`）からも外した。

運用の作業: 本番（Vercel）の環境変数に `ADMIN_API_KEY` があれば削除する。残っていても動きは変わらないが、読まれない鍵を置き続けない。管理者が会員を作るときは、管理画面の `POST /api/admin/create-user`（権限 `admin.users.manage`）を使う。
