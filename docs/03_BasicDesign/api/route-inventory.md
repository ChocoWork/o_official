# APIルート一覧

> 状態: ソースから作成した入口一覧 | 確認日: 2026-10-02（checkout の入口の変更は 2026-10-07、カートの入口の変更は 2026-10-08、発送・仕上がりの入口の変更は 2026-10-10、返金・ショップの設定の入口の変更は 2026-10-11 に、返品の入口の変更は 2026-10-13 に反映、配送の入口・表は E-4 の変更を 2026-10-21 に反映、注文の状況の入口・表は E-5 の変更を 2026-10-22 に反映） | 対象: `src/app/api/**/route.ts`

## 概要

現行リポジトリの Route Handler に定義されたパスと HTTP メソッドを示す。認証要否、入力スキーマ、レスポンス、外部公開可否はこの一覧だけでは判断できない。[APIの主要契約](api-spec.md)と各 Handler を確認する。E-5 を含め、Route Handler は130ファイル・169メソッド（自動の HEAD・OPTIONS は数えない）。この一覧は E2E 用の `/api/e2e/server-info`（GET）を載せないため、表は129行・168メソッド。

| パス | メソッド | 根拠 |
| --- | --- | --- |
| `/api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/%5BfulfillmentId%5D/tracking/route.ts) |
| `/api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/%5BfulfillmentId%5D/delivered/route.ts) |
| `/api/admin/order-attention/deliveries/[attentionId]/resolve` | `POST` | [route.ts](../../../src/app/api/admin/order-attention/deliveries/%5BattentionId%5D/resolve/route.ts) |
| `/api/webhook/17track` | `POST` | [route.ts](../../../src/app/api/webhook/17track/route.ts) |
| `/api/orders/[id]/return-request` | `GET`, `POST` | [route.ts](../../../src/app/api/orders/%5Bid%5D/return-request/route.ts) |
| `/api/orders/[id]/return-request/photos` | `POST` | [route.ts](../../../src/app/api/orders/%5Bid%5D/return-request/photos/route.ts) |
| `/api/orders/[id]/cancel-request` | `POST` | [route.ts](../../../src/app/api/orders/%5Bid%5D/cancel-request/route.ts) |
| `/api/admin/returns/[returnId]/approve` | `POST` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/approve/route.ts) |
| `/api/admin/returns/[returnId]/decline` | `POST` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/decline/route.ts) |
| `/api/admin/returns/[returnId]/photos` | `GET` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/photos/route.ts) |
| `/api/admin/orders/[id]/cancel-requests` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/cancel-requests/route.ts) |
| `/api/admin/cancel-requests/[cancelRequestId]/decline` | `POST` | [route.ts](../../../src/app/api/admin/cancel-requests/%5BcancelRequestId%5D/decline/route.ts) |
| `/api/admin/cancel-requests/[cancelRequestId]/close` | `POST` | [route.ts](../../../src/app/api/admin/cancel-requests/%5BcancelRequestId%5D/close/route.ts) |
| `/api/admin/cancel-requests/[cancelRequestId]/resolve` | `POST` | [route.ts](../../../src/app/api/admin/cancel-requests/%5BcancelRequestId%5D/resolve/route.ts) |
| `/api/cron/purge-return-photos` | `POST` | [route.ts](../../../src/app/api/cron/purge-return-photos/route.ts) |
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
| `/api/admin/orders/[id]/completions/[completionId]/cancel` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/completions/%5BcompletionId%5D/cancel/route.ts) |
| `/api/admin/orders/[id]/completions` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/completions/route.ts) |
| `/api/admin/orders/[id]/emails/[emailId]` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/emails/%5BemailId%5D/route.ts) |
| `/api/admin/orders/[id]/emails/resend` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/emails/resend/route.ts) |
| `/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/%5BfulfillmentId%5D/cancel/route.ts) |
| `/api/admin/orders/[id]/fulfillments` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/route.ts) |
| `/api/admin/orders/[id]/history` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/history/route.ts) |
| `/api/admin/orders/[id]/refund/confirm` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/refund/confirm/route.ts) |
| `/api/admin/orders/[id]/refund` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/refund/route.ts) |
| `/api/admin/orders/[id]/returns/materials` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/returns/materials/route.ts) |
| `/api/admin/orders/[id]/returns` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/returns/route.ts) |
| `/api/admin/orders/[id]/review` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/review/route.ts) |
| `/api/admin/orders/[id]/status` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
| `/api/admin/orders` | `GET` | [route.ts](../../../src/app/api/admin/orders/route.ts) |
| `/api/admin/payment-exceptions/[id]/resolve` | `POST` | [route.ts](../../../src/app/api/admin/payment-exceptions/%5Bid%5D/resolve/route.ts) |
| `/api/admin/returns/[returnId]/cancel` | `POST` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/cancel/route.ts) |
| `/api/admin/returns/[returnId]/close-missing` | `POST` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/close-missing/route.ts) |
| `/api/admin/returns/[returnId]/fee-payment` | `POST` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/fee-payment/route.ts) |
| `/api/admin/returns/[returnId]/inspect` | `POST` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/inspect/route.ts) |
| `/api/admin/returns/[returnId]/receive` | `POST` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/receive/route.ts) |
| `/api/admin/returns/[returnId]/refund` | `POST` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/refund/route.ts) |
| `/api/admin/returns/[returnId]/release-exchange` | `POST` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/release-exchange/route.ts) |
| `/api/admin/returns/[returnId]/reopen` | `POST` | [route.ts](../../../src/app/api/admin/returns/%5BreturnId%5D/reopen/route.ts) |
| `/api/admin/revoke-user-sessions` | `POST` | [route.ts](../../../src/app/api/admin/revoke-user-sessions/route.ts) |
| `/api/admin/settings/shop` | `GET`, `PUT` | [route.ts](../../../src/app/api/admin/settings/shop/route.ts) |
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
| `/api/cart/add` | `POST` | [route.ts](../../../src/app/api/cart/add/route.ts) |
| `/api/cart/change` | `POST` | [route.ts](../../../src/app/api/cart/change/route.ts) |
| `/api/cart` | `GET` | [route.ts](../../../src/app/api/cart/route.ts) |
| `/api/checkout/complete` | `POST` | [route.ts](../../../src/app/api/checkout/complete/route.ts) |
| `/api/checkout/create-session` | `POST` | [route.ts](../../../src/app/api/checkout/create-session/route.ts) |
| `/api/checkout/payment-intent` | `POST` | [route.ts](../../../src/app/api/checkout/payment-intent/route.ts) |
| `/api/checkout/place-order` | `POST` | [route.ts](../../../src/app/api/checkout/place-order/route.ts) |
| `/api/checkout/postal-code` | `GET` | [route.ts](../../../src/app/api/checkout/postal-code/route.ts) |
| `/api/checkout/promotion-code` | `POST` | [route.ts](../../../src/app/api/checkout/promotion-code/route.ts) |
| `/api/checkout/resume` | `POST` | [route.ts](../../../src/app/api/checkout/resume/route.ts) |
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
| `/api/order-status/[token]/private` | `GET` | [route.ts](../../../src/app/api/order-status/%5Btoken%5D/private/route.ts) |
| `/api/order-status/[token]/verify` | `POST` | [route.ts](../../../src/app/api/order-status/%5Btoken%5D/verify/route.ts) |
| `/api/orders/[id]` | `GET` | [route.ts](../../../src/app/api/orders/%5Bid%5D/route.ts) |
| `/api/orders` | `GET` | [route.ts](../../../src/app/api/orders/route.ts) |
| `/api/profile/addresses` | `GET`, `PUT` | [route.ts](../../../src/app/api/profile/addresses/route.ts) |
| `/api/profile` | `DELETE`, `GET`, `POST` | [route.ts](../../../src/app/api/profile/route.ts) |
| `/api/search` | `GET` | [route.ts](../../../src/app/api/search/route.ts) |
| `/api/suggest` | `GET` | [route.ts](../../../src/app/api/suggest/route.ts) |
| `/api/webhook/resend-delivery` | `POST` | [route.ts](../../../src/app/api/webhook/resend-delivery/route.ts) |
| `/api/webhook/stripe` | `POST` | [route.ts](../../../src/app/api/webhook/stripe/route.ts) |
| `/api/wishlist/[id]` | `DELETE` | [route.ts](../../../src/app/api/wishlist/%5Bid%5D/route.ts) |
| `/api/wishlist` | `GET`, `POST` | [route.ts](../../../src/app/api/wishlist/route.ts) |

## 注文のメール・発送・返金・ショップの設定

履歴・中身は `admin.orders.read`、再送は `admin.orders.manage`・CSRF・送信元と管理者ごと10分に30回。配達の受け口は公開で Svix 署名を確かめる。発送・発送の取消・仕上がり・仕上がりの取消は `admin.orders.manage`・CSRF・回数の制限（発送と仕上がりの記録は10分に60回、取消は30回）で、発送は `POST /api/admin/orders/[id]/fulfillments` の本文 `notifyCustomer`（真偽、既定 true）で知らせるかを選ぶ（グループ E-1。発送ごとに発送のメールを1通送る）。返金の材料の読み込み（`GET …/refund`）は `admin.orders.refund` だけ（読むだけなので CSRF と回数の制限は通さない）、返金（`POST …/refund`）と返事待ちの確かめ直し（`POST …/refund/confirm`）は `admin.orders.refund`・CSRF・回数の制限（10分に30回。確かめ直しも返金と同じ数に数える）、支払い済みの注文のキャンセル（`POST …/status` の支払い済みの道）は `admin.orders.manage` と `admin.orders.refund` の両方・CSRF・回数の制限（10分に30回）、ショップの設定（`GET`・`PUT /api/admin/settings/shop`）は `admin.settings.manage`（`PUT` は CSRF と回数の制限、10分に30回）で守る（グループ E-2。返金は返金ごとに返金のお知らせを1通、支払い済みのキャンセルはキャンセルのお知らせを1通送る）。返品の入口（グループ E-3）は、読む `GET …/returns`・`GET …/returns/materials` が `admin.orders.return`（読むだけなので CSRF と回数の制限は通さない）、書く `POST …/returns` と `POST /api/admin/returns/[returnId]/…` が `admin.orders.return`・CSRF・回数の制限（作る・受け取る・額を決めて返金するは10分に30回、取消・開き直し・届かないで終える・検品・手数料の受け取りの記録・支払いを待たずに送るは10分に60回）で守る。受け取りの今返金（お客様の申し込みで返送不要でない返品の計算どおりの場合を除く）・額の指定・送料・交換の選び直しと、額を決めて返金・手数料の受け取りの記録・支払いを待たずに送るは、`admin.orders.refund` も要る（店長だけ）。詳しい入力と応答は [APIの主要契約](api-spec.md)の「管理:注文・要対応」「管理:ショップの設定」「Webhook・Cron」に記す。段2の承認・お断り・写真・キャンセルの申し込みの4操作は admin.orders.return、商品の返品不可は admin.items.manage、設定は admin.settings.manage。お客様の書く窓口はログイン・CSRF・送信元とお客様ごとの制限で守る。

## 更新と検証

ルートを追加・削除した場合はこの一覧を再生成し、API の主要契約と関連テストを更新する。動的セグメント（`[id]` 等）は Next.js のファイル名のまま表記した。ここに列挙したことは、実行時にその API が成功することを意味しない。

## 配送の状況（E-4 / FREQ-488〜497）

[配送の詳細設計](../../superpowers/specs/2026-10-21-delivery-status-design.md)・[実装計画](../../superpowers/plans/2026-10-21-delivery-status.md)を参照。以下は実装後の契約であり、既存の決定の本文は履歴として残す。

管理POST 3本と17TRACKのPOST 1本の計4パス・4メソッドを追加。ソースの静的集計は128ファイル・167メソッド、E2E用の1本を除いた表は127行・166メソッド。新しいページURLは0。詳細はAPI仕様の配送の節と計画 C-3。

## 注文の状況の入口（E-5 / FREQ-498〜505）

[詳細設計](../../superpowers/specs/2026-10-22-order-status-page-design.md)・[実装計画](../../superpowers/plans/2026-10-22-order-status-page.md)・[APIの契約](api-spec.md)を参照。

個人情報GETと確認POSTの2ファイル・2メソッドを追加。実ソースを数え直した全体は130ファイル・169メソッド、E2E専用1本を除く一覧表は129行・168メソッド。公開APIは作らず、公開ページがサーバーから読む。認可・Origin・CSRF・全エラーはAPI仕様のE-5節に記録する。
