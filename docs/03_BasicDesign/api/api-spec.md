# API 一覧と主要契約（現行実装）

## 概要

Next.js Route Handler の現行配置は `src/app/api/**/route.ts`。この文書はルート群と主要フローの契約を示す。全 89 ハンドラの全リクエスト・レスポンス形式を網羅する OpenAPI 定義ではない。個別の入力制約とエラーは各 Route Handler と参照スキーマを正とする。

全 Route Handler のパスとメソッドは [APIルート一覧](route-inventory.md) に記録する。個別の入出力契約はリンク先の実装と検証スキーマで確認する。`route-inventory.md` はソースから生成した所在表であり、公開API契約ではない。

## ルート群

| 接頭辞 | ファイル数 | 主な用途 |
|---|---:|---|
| `/api/admin` | 41 | 商品・注文・KPI・会計・監査などの管理操作 |
| `/api/auth` | 18 | 登録、ログイン、OTP、MFA、OAuth、セッション |
| `/api/cron` | 6 | 決済照合、Webhook 処理、期限切れ注文、Meta、法定保存 |
| `/api/checkout` | 5 | Checkout Session、配送、完了処理 |
| `/api/contact` | 5 | 問い合わせ・返信・受信 Webhook |
| `/api/cart`、`/api/items`、`/api/orders`、`/api/profile`、`/api/wishlist` | 各 2 | 購入者向けデータ |
| `/api/news`、`/api/search`、`/api/suggest`、`/api/webhook` | 各 1 | 公開情報・Stripe Webhook |

正確な全ファイル一覧はリポジトリで `rg --files src/app/api -g route.ts`、各 HTTP メソッドは `rg -n 'export async function (GET|POST|PUT|PATCH|DELETE)' src/app/api -g route.ts` で確認する。ファイル名から HTTP メソッドや公開範囲を推測しない。

## 主要エンドポイント

| メソッド・パス | 確認できる契約 | 実装 |
|---|---|---|
| `POST /api/auth/login` | `email`、`password`、`turnstileToken` を検証し、パスワード成功時にメール OTP を送る。成功は `{step:"otp", message}` と一時 Cookie。ここでは正式セッションを確定しない | `src/app/api/auth/login/route.ts` |
| `POST /api/auth/otp/verify` | `code` と一時 Cookie を照合。Supabase の email OTP が成功したら正式セッションを保存し、一時 Cookie を消す | `src/app/api/auth/otp/verify/route.ts` |
| `GET /api/auth/me` | セッションを検証して `{authenticated, user}` を返す。認証できない場合は `authenticated:false`、セッション確認不能時は 503 | `src/app/api/auth/me/route.ts` |
| `POST /api/auth/mfa/verify` | 認証済みの管理者・サポーターについて `factorId` と `code` で TOTP を検証し、AAL2 のトークンを Cookie に反映する | `src/app/api/auth/mfa/verify/route.ts` |
| `POST /api/checkout/create-session` | カートと配送などを検証して Checkout draft と Stripe Checkout Session を扱う。再利用・回復処理も持つ | `src/app/api/checkout/create-session/route.ts` |
| `POST /api/checkout/complete` | Stripe Session を取得し、注文・決済を照合する | `src/app/api/checkout/complete/route.ts` |
| `POST /api/webhook/stripe` | raw body と `stripe-signature` を検証してイベントを永続キューへ登録。成功は `{received:true, duplicate}` | `src/app/api/webhook/stripe/route.ts` |
| `POST /api/cron/process-stripe-webhooks` | `CRON_SECRET` の Bearer 認証後、キューのイベントを claim・処理する | `src/app/api/cron/process-stripe-webhooks/route.ts` |
| `POST /api/cron/expire-pending-orders` | `CRON_SECRET` の Bearer 認証後、未確定注文を照合する | `src/app/api/cron/expire-pending-orders/route.ts` |
| `POST /api/contact/inbound` | Resend/Svix の署名付き受信メール Webhook | `src/app/api/contact/inbound/route.ts` |

## 共通境界

管理 API は必要な権限を `authorizeAdminPermission` で指定し、JWT、セッション有効性、DB の ACL、AAL2 を確認する。状態変更 API は `src/proxy.ts` の Origin 検査対象だが、署名付き Webhook と Bearer 認証の Cron は除外される。一部の管理更新 API はさらに `requireCsrfOrDeny` を呼ぶ。認可、CSRF、入力検証、成功・失敗の形式はルートごとに確認する。

関連: [システム構成](../architecture/system-overview.md)、[認証シーケンス](../../04_DetailDesign/sequence/auth-login-mfa.md)、[決済状態](../../04_DetailDesign/states/order-payment.md)。
