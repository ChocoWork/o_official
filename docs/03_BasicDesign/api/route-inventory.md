# APIルート一覧

> 状態: ソースから作成した入口一覧 | 確認日: 2026-10-02 | 対象: `src/app/api/**/route.ts`

## 概要

現行リポジトリの Route Handler に定義されたパスと HTTP メソッドを示す。認証要否、入力スキーマ、レスポンス、外部公開可否はこの一覧だけでは判断できない。[APIの主要契約](api-spec.md)と各 Handler を確認する。

| パス | メソッド | 根拠 |
| --- | --- | --- |
| `/api/admin/accounting/product-costs` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/accounting/product-costs/route.ts) |
| `/api/admin/accounting/stripe-backfill` | `POST` | [route.ts](../../../src/app/api/admin/accounting/stripe-backfill/route.ts) |
| `/api/admin/accounting/stripe-payouts/[id]/confirm` | `POST` | [route.ts](../../../src/app/api/admin/accounting/stripe-payouts/%5Bid%5D/confirm/route.ts) |
| `/api/admin/audit-logs` | `GET` | [route.ts](../../../src/app/api/admin/audit-logs/route.ts) |
| `/api/admin/contact/[id]/reply` | `POST` | [route.ts](../../../src/app/api/admin/contact/%5Bid%5D/reply/route.ts) |
| `/api/admin/contact/[id]` | `GET`, `PATCH` | [route.ts](../../../src/app/api/admin/contact/%5Bid%5D/route.ts) |
| `/api/admin/contact` | `GET` | [route.ts](../../../src/app/api/admin/contact/route.ts) |
| `/api/admin/contact/templates/[id]` | `DELETE`, `PUT` | [route.ts](../../../src/app/api/admin/contact/templates/%5Bid%5D/route.ts) |
| `/api/admin/contact/templates` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/contact/templates/route.ts) |
| `/api/admin/create-user` | `POST` | [route.ts](../../../src/app/api/admin/create-user/route.ts) |
| `/api/admin/item-color-presets/[id]` | `DELETE` | [route.ts](../../../src/app/api/admin/item-color-presets/%5Bid%5D/route.ts) |
| `/api/admin/item-color-presets` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/item-color-presets/route.ts) |
| `/api/admin/items/[id]` | `DELETE`, `GET`, `PATCH`, `PUT` | [route.ts](../../../src/app/api/admin/items/%5Bid%5D/route.ts) |
| `/api/admin/items/[id]/variants` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/items/%5Bid%5D/variants/route.ts) |
| `/api/admin/items` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/items/route.ts) |
| `/api/admin/kpi/cost-profit/receipt` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/kpi/cost-profit/receipt/route.ts) |
| `/api/admin/kpi/cost-profit` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/kpi/cost-profit/route.ts) |
| `/api/admin/kpi/meta/callback` | `GET` | [route.ts](../../../src/app/api/admin/kpi/meta/callback/route.ts) |
| `/api/admin/kpi/meta/connect` | `GET` | [route.ts](../../../src/app/api/admin/kpi/meta/connect/route.ts) |
| `/api/admin/kpi/meta` | `DELETE`, `GET` | [route.ts](../../../src/app/api/admin/kpi/meta/route.ts) |
| `/api/admin/kpi/meta/sync` | `POST` | [route.ts](../../../src/app/api/admin/kpi/meta/sync/route.ts) |
| `/api/admin/kpi/migration-status` | `GET` | [route.ts](../../../src/app/api/admin/kpi/migration-status/route.ts) |
| `/api/admin/kpi/monthly-record` | `GET`, `PUT` | [route.ts](../../../src/app/api/admin/kpi/monthly-record/route.ts) |
| `/api/admin/kpi` | `GET` | [route.ts](../../../src/app/api/admin/kpi/route.ts) |
| `/api/admin/kpi/targets` | `GET`, `PUT` | [route.ts](../../../src/app/api/admin/kpi/targets/route.ts) |
| `/api/admin/legal-archive/status` | `GET` | [route.ts](../../../src/app/api/admin/legal-archive/status/route.ts) |
| `/api/admin/looks/[id]` | `DELETE`, `GET`, `PATCH`, `PUT` | [route.ts](../../../src/app/api/admin/looks/%5Bid%5D/route.ts) |
| `/api/admin/looks` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/looks/route.ts) |
| `/api/admin/news/[id]` | `DELETE`, `GET`, `PATCH`, `PUT` | [route.ts](../../../src/app/api/admin/news/%5Bid%5D/route.ts) |
| `/api/admin/news` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/news/route.ts) |
| `/api/admin/order-attention` | `GET` | [route.ts](../../../src/app/api/admin/order-attention/route.ts) |
| `/api/admin/orders/[id]/refund` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/refund/route.ts) |
| `/api/admin/orders/[id]/review` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/review/route.ts) |
| `/api/admin/orders/[id]/status` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
| `/api/admin/orders` | `GET` | [route.ts](../../../src/app/api/admin/orders/route.ts) |
| `/api/admin/payment-exceptions/[id]/resolve` | `POST` | [route.ts](../../../src/app/api/admin/payment-exceptions/%5Bid%5D/resolve/route.ts) |
| `/api/admin/revoke-user-sessions` | `POST` | [route.ts](../../../src/app/api/admin/revoke-user-sessions/route.ts) |
| `/api/admin/stockists/[id]` | `DELETE`, `GET`, `PATCH`, `PUT` | [route.ts](../../../src/app/api/admin/stockists/%5Bid%5D/route.ts) |
| `/api/admin/stockists` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/stockists/route.ts) |
| `/api/admin/users/mfa/reset` | `POST` | [route.ts](../../../src/app/api/admin/users/mfa/reset/route.ts) |
| `/api/admin/users` | `GET`, `PATCH` | [route.ts](../../../src/app/api/admin/users/route.ts) |
| `/api/auth/confirm` | `GET` | [route.ts](../../../src/app/api/auth/confirm/route.ts) |
| `/api/auth/login/cancel` | `POST` | [route.ts](../../../src/app/api/auth/login/cancel/route.ts) |
| `/api/auth/login/resend` | `POST` | [route.ts](../../../src/app/api/auth/login/resend/route.ts) |
| `/api/auth/login` | `POST` | [route.ts](../../../src/app/api/auth/login/route.ts) |
| `/api/auth/logout` | `POST` | [route.ts](../../../src/app/api/auth/logout/route.ts) |
| `/api/auth/me` | `GET` | [route.ts](../../../src/app/api/auth/me/route.ts) |
| `/api/auth/mfa/enroll-totp` | `POST` | [route.ts](../../../src/app/api/auth/mfa/enroll-totp/route.ts) |
| `/api/auth/mfa/status` | `GET` | [route.ts](../../../src/app/api/auth/mfa/status/route.ts) |
| `/api/auth/mfa/verify` | `POST` | [route.ts](../../../src/app/api/auth/mfa/verify/route.ts) |
| `/api/auth/oauth/callback` | `GET` | [route.ts](../../../src/app/api/auth/oauth/callback/route.ts) |
| `/api/auth/oauth/start` | `GET` | [route.ts](../../../src/app/api/auth/oauth/start/route.ts) |
| `/api/auth/otp/verify` | `POST` | [route.ts](../../../src/app/api/auth/otp/verify/route.ts) |
| `/api/auth/password-reset/confirm` | `POST` | [route.ts](../../../src/app/api/auth/password-reset/confirm/route.ts) |
| `/api/auth/password-reset/link` | `GET`, `POST` | [route.ts](../../../src/app/api/auth/password-reset/link/route.ts) |
| `/api/auth/password-reset/request` | `POST` | [route.ts](../../../src/app/api/auth/password-reset/request/route.ts) |
| `/api/auth/password-reset/session` | `GET` | [route.ts](../../../src/app/api/auth/password-reset/session/route.ts) |
| `/api/auth/refresh` | `POST` | [route.ts](../../../src/app/api/auth/refresh/route.ts) |
| `/api/auth/register` | `POST` | [route.ts](../../../src/app/api/auth/register/route.ts) |
| `/api/cart/[id]` | `DELETE`, `PATCH` | [route.ts](../../../src/app/api/cart/%5Bid%5D/route.ts) |
| `/api/cart` | `GET`, `POST` | [route.ts](../../../src/app/api/cart/route.ts) |
| `/api/checkout/complete` | `POST` | [route.ts](../../../src/app/api/checkout/complete/route.ts) |
| `/api/checkout/create-session` | `POST` | [route.ts](../../../src/app/api/checkout/create-session/route.ts) |
| `/api/checkout/payment-intent` | `POST` | [route.ts](../../../src/app/api/checkout/payment-intent/route.ts) |
| `/api/checkout/postal-code` | `GET` | [route.ts](../../../src/app/api/checkout/postal-code/route.ts) |
| `/api/checkout/update-shipping` | `POST` | [route.ts](../../../src/app/api/checkout/update-shipping/route.ts) |
| `/api/contact/inbound` | `POST` | [route.ts](../../../src/app/api/contact/inbound/route.ts) |
| `/api/contact` | `POST` | [route.ts](../../../src/app/api/contact/route.ts) |
| `/api/contact/threads/[id]/reply` | `POST` | [route.ts](../../../src/app/api/contact/threads/%5Bid%5D/reply/route.ts) |
| `/api/contact/threads/[id]` | `GET` | [route.ts](../../../src/app/api/contact/threads/%5Bid%5D/route.ts) |
| `/api/contact/threads` | `GET` | [route.ts](../../../src/app/api/contact/threads/route.ts) |
| `/api/cron/expire-pending-orders` | `POST` | [route.ts](../../../src/app/api/cron/expire-pending-orders/route.ts) |
| `/api/cron/legal-archive/export` | `GET` | [route.ts](../../../src/app/api/cron/legal-archive/export/route.ts) |
| `/api/cron/legal-archive/status` | `POST` | [route.ts](../../../src/app/api/cron/legal-archive/status/route.ts) |
| `/api/cron/meta-kpi-sync` | `POST` | [route.ts](../../../src/app/api/cron/meta-kpi-sync/route.ts) |
| `/api/cron/process-stripe-webhooks` | `POST` | [route.ts](../../../src/app/api/cron/process-stripe-webhooks/route.ts) |
| `/api/cron/stripe-reconcile` | `POST` | [route.ts](../../../src/app/api/cron/stripe-reconcile/route.ts) |
| `/api/items/[id]` | `GET` | [route.ts](../../../src/app/api/items/%5Bid%5D/route.ts) |
| `/api/items` | `GET` | [route.ts](../../../src/app/api/items/route.ts) |
| `/api/news` | `GET` | [route.ts](../../../src/app/api/news/route.ts) |
| `/api/orders/[id]` | `GET` | [route.ts](../../../src/app/api/orders/%5Bid%5D/route.ts) |
| `/api/orders` | `GET` | [route.ts](../../../src/app/api/orders/route.ts) |
| `/api/profile/addresses` | `GET`, `PUT` | [route.ts](../../../src/app/api/profile/addresses/route.ts) |
| `/api/profile` | `DELETE`, `GET`, `POST` | [route.ts](../../../src/app/api/profile/route.ts) |
| `/api/search` | `GET` | [route.ts](../../../src/app/api/search/route.ts) |
| `/api/suggest` | `GET` | [route.ts](../../../src/app/api/suggest/route.ts) |
| `/api/webhook/stripe` | `POST` | [route.ts](../../../src/app/api/webhook/stripe/route.ts) |
| `/api/wishlist/[id]` | `DELETE` | [route.ts](../../../src/app/api/wishlist/%5Bid%5D/route.ts) |
| `/api/wishlist` | `GET`, `POST` | [route.ts](../../../src/app/api/wishlist/route.ts) |
## 更新と検証

ルートを追加・削除した場合はこの一覧を再生成し、API の主要契約と関連テストを更新する。動的セグメント（`[id]` 等）は Next.js のファイル名のまま表記した。ここに列挙したことは、実行時にその API が成功することを意味しない。