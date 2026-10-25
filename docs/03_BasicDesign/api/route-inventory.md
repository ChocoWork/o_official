# APIルート一覧

> 状態: ソースから作成した入口一覧 | 確認日: 2026-10-02（checkout の入口の変更は 2026-10-07、カートの入口の変更は 2026-10-08、発送・仕上がりの入口の変更は 2026-10-10、返金・ショップの設定の入口の変更は 2026-10-11 に、返品の入口の変更は 2026-10-13 に反映、配送の入口・表は E-4 の変更を 2026-10-21 に反映、注文の状況の入口・表は E-5 の変更を 2026-10-22 に、在庫一覧表の入口は G-2 Task 3 の変更を、発注の作成の入口は G-2 Task 4 の変更を、発注一覧表・発注書の詳細の入口は G-2 Task 5 の変更を、発注書の数量の確定・訂正・打切り・発注先の訂正の入口は G-2 Task 6 の変更を、発注書の受け取りと受け取りの取消の入口は G-2 Task 7 の変更を、取引書類の原本の入口は G-2 Task 8 の変更を、荷作り表と発送票の読取の入口は G-3 Task 3 の変更を、発送票の下書きの入口は G-3 Task 4 の変更を、発送確定の入口は G-3 Task 5 の変更を、発送の取消の入口は G-3 Task 6 の変更を、伝票番号の入力・訂正と手動の配達済みの入口は G-3 Task 7 の変更を、Google ログイン開始の POST とログインの後の行き先の POST は波1-A の変更を 2026-10-25 に反映） | 対象: `src/app/api/**/route.ts`

## 概要

現行リポジトリの Route Handler に定義されたパスと HTTP メソッドを示す。認証要否、入力スキーマ、レスポンス、外部公開可否はこの一覧だけでは判断できない。[APIの主要契約](api-spec.md)と各 Handler を確認する。G-0 の2入口と G-2 Task 3 の在庫一覧表の入口と Task 4 の発注の作成の入口と Task 5 の発注一覧表・発注書の詳細の入口（`GET /api/admin/purchase-orders`・`GET /api/admin/purchase-orders/[id]`）と Task 6 の発注先・メモの訂正・数量の確定と訂正・残りの打切りの入口（`PATCH /api/admin/purchase-orders/[id]`・`POST /api/admin/purchase-orders/[id]/quantities`・`POST /api/admin/purchase-orders/[id]/short-closures`）と Task 7 の受け取り・受け取りの取消の入口（`POST /api/admin/purchase-orders/[id]/receipts`・`POST /api/admin/purchase-orders/[id]/receipts/[receiptId]/reversals`）と Task 8 の取引書類の原本の6入口（予約・署名つき送り先の出し直し・確定・訂正と無効化の `POST` 4本、閲覧リンクと書類検索の `GET` 2本）と G-3 Task 3 の荷作り表・発送票の読取の3入口（`GET /api/admin/packing`・`GET /api/admin/shipment-slips`・`GET /api/admin/shipment-slips/[id]`）と G-3 Task 4 の発送票の下書きの3入口（`POST /api/admin/shipment-slips`・`POST /api/admin/shipment-slips/[id]/draft`・`POST /api/admin/shipment-slips/[id]/discard`）と G-3 Task 5 の発送確定（`POST /api/admin/shipment-slips/[id]/confirm`）と G-3 Task 6 の発送の取消（`POST /api/admin/shipment-slips/[id]/cancel`）と G-3 Task 7 の伝票番号の入力・訂正（`POST /api/admin/shipment-slips/[id]/tracking`）と手動の配達済み（`POST /api/admin/shipment-slips/[id]/delivered`）と 波1-A の Google ログイン開始の POST（`POST /api/auth/oauth/start`）とログインの後の行き先の POST（`POST /api/auth/post-login`）を含め、Route Handler は155ファイル・198メソッド（自動の HEAD・OPTIONS は数えない。2026-10-25 静的集計）。この一覧は E2E 用の `/api/e2e/server-info`（GET）を載せないため、表は154行・197メソッド。

| パス | メソッド | 根拠 |
| --- | --- | --- |
| `/api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/%5BfulfillmentId%5D/tracking/route.ts) （G-3移行: 認可・CSRF・回数制限の後に 410 `LEGACY_FULFILLMENT_DISABLED`。発送は荷作り表の発送票で行う） |
| `/api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/%5BfulfillmentId%5D/delivered/route.ts) （G-3移行: 認可・CSRF・回数制限の後に 410 `LEGACY_FULFILLMENT_DISABLED`。発送は荷作り表の発送票で行う） |
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
| `/api/admin/inventory` | `GET` | [route.ts](../../../src/app/api/admin/inventory/route.ts) （G-2: `admin.stock.read`。在庫一覧表。読むだけで `backfill_item_variants` は呼ばない） |
| `/api/admin/purchase-orders` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/purchase-orders/route.ts) （G-2 Task 4: `POST` は `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read`。発注書の作成。CSRF・回数制限 `admin.purchase_orders.create` の30回/600秒・監査 `admin.purchase_orders.confirm`。在庫は動かさない。G-2 Task 5: `GET` は `admin.purchase_orders.read`。発注一覧表。明細ごとの行を読むだけで、CSRF・回数制限・監査は無い） |
| `/api/admin/purchase-orders/[id]` | `GET`, `PATCH` | [route.ts](../../../src/app/api/admin/purchase-orders/%5Bid%5D/route.ts) （G-2 Task 5: `GET` は `admin.purchase_orders.read`。発注書1件の詳細。読むだけ。id が uuid でなければ400、無ければ404。G-2 Task 6: `PATCH` は `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read`。発注先・メモの訂正。理由が必須。CSRF・回数制限 `admin.purchase_orders.header.update` の30回/600秒・監査 `admin.purchase_orders.header.update`。版が古ければ409） |
| `/api/admin/purchase-orders/[id]/quantities` | `POST` | [route.ts](../../../src/app/api/admin/purchase-orders/%5Bid%5D/quantities/route.ts) （G-2 Task 6: `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read`。数量の確定（最初の確定）と訂正。全行を一度に送る。CSRF・回数制限 `admin.purchase_orders.quantity.confirm` の60回/600秒・監査 `admin.purchase_orders.quantity.confirm`。在庫は動かさない） |
| `/api/admin/purchase-orders/[id]/short-closures` | `POST` | [route.ts](../../../src/app/api/admin/purchase-orders/%5Bid%5D/short-closures/route.ts) （G-2 Task 6: `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read`。残りの打切りと、数量確定前の発注の取消（全行を渡す）。理由が必須。CSRF・回数制限 `admin.purchase_orders.short_close` の30回/600秒・監査 `admin.purchase_orders.short_close`。入庫は起こさない） |
| `/api/admin/purchase-orders/[id]/receipts` | `POST` | [route.ts](../../../src/app/api/admin/purchase-orders/%5Bid%5D/receipts/route.ts) （G-2 Task 7: `admin.receiving.manage` ＋ `admin.purchase_orders.read`。発注書の受け取り（全部・一部・後日）。台帳の入庫（無タグ）・受取・納品済み・未納を保存し、続けて FIFO で割り当てる。CSRF・回数制限 `admin.purchase_orders.receive` の60回/600秒・監査 `admin.purchase_orders.receive`。成功は201） |
| `/api/admin/purchase-orders/[id]/receipts/[receiptId]/reversals` | `POST` | [route.ts](../../../src/app/api/admin/purchase-orders/%5Bid%5D/receipts/%5BreceiptId%5D/reversals/route.ts) （G-2 Task 7: `admin.receiving.manage` ＋ `admin.purchase_orders.read`。受け取りの取消・数量訂正（同じ操作）。相殺の受取を追記し、在庫は G-1 の減らし方で減らす。外す割当があり確認の数が無い・違う時は409 `GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED` と `releasedQuantity`（書込み0件）。理由が必須。CSRF・回数制限 `admin.purchase_orders.receipt.reverse` の30回/600秒・監査 `admin.purchase_orders.receipt.reverse`。成功は201） |
| `/api/admin/purchase-orders/[id]/attachments/reservations` | `POST` | [route.ts](../../../src/app/api/admin/purchase-orders/%5Bid%5D/attachments/reservations/route.ts) （G-2 Task 8: `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read`。取引書類の置き場の予約（24時間。差し替えなら差し替える添付も予約に残す）と署名つきの送り先（上書きできない形）。CSRF・回数制限 `admin.purchase_orders.attachment.reserve` の30回/600秒。成功は201。送り先を作れなければ503で予約は残る） |
| `/api/admin/purchase-orders/[id]/attachments/reservations/[reservationId]/upload-url` | `POST` | [route.ts](../../../src/app/api/admin/purchase-orders/%5Bid%5D/attachments/reservations/%5BreservationId%5D/upload-url/route.ts) （G-2 Task 8: `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read`、DB でも `get_admin_purchase_order` で読取権限を確かめる。署名つき送り先の出し直し（再開）。本文なし。保存済みなら `{ uploaded: true }`、無ければ新しい送り先。予約の不一致・添付済みは409。CSRF・回数制限 `admin.purchase_orders.attachment.upload_url` の30回/600秒） |
| `/api/admin/purchase-orders/[id]/attachments` | `POST` | [route.ts](../../../src/app/api/admin/purchase-orders/%5Bid%5D/attachments/route.ts) （G-2 Task 8: `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read`。取引書類の確定。置き場のファイルを読み戻して検査し、予約を添付（版1。差し替え元は予約から写し、本文では受けない）に結ぶ。置き場に無ければ409、種類・大きさ・ハッシュの不一致は422、置き場の不調は503。同じ `requestKey` の再送は同じ結果。CSRF・回数制限 `admin.purchase_orders.attachment.attach` の30回/600秒・監査 `admin.purchase_orders.attachment.attach`。成功は201） |
| `/api/admin/purchase-orders/[id]/attachments/[attachmentId]/revisions` | `POST` | [route.ts](../../../src/app/api/admin/purchase-orders/%5Bid%5D/attachments/%5BattachmentId%5D/revisions/route.ts) （G-2 Task 8: `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read`。取引書類の情報の訂正と無効化。次の版を足し前の版は残る。理由が必須。CSRF・回数制限 `admin.purchase_orders.attachment.revise` の30回/600秒・監査 `admin.purchase_orders.attachment.revise`。成功は201） |
| `/api/admin/purchase-orders/[id]/attachments/[attachmentId]/url` | `GET` | [route.ts](../../../src/app/api/admin/purchase-orders/%5Bid%5D/attachments/%5BattachmentId%5D/url/route.ts) （G-2 Task 8: `admin.purchase_orders.read`、DB でも確かめる。原本を見る・保存する60秒の署名つきリンク。`?download=1` は原ファイル名つきの保存用。回数制限 `admin.purchase_orders.attachment.view` の120回/600秒。リンクは記録しない。置き場に無ければ404） |
| `/api/admin/purchase-order-documents` | `GET` | [route.ts](../../../src/app/api/admin/purchase-order-documents/route.ts) （G-2 Task 8: `admin.purchase_orders.read`、DB でも確かめる。取引書類の検索。1頁50件。読むだけで、回数制限・監査は無い。保存先の鍵は返さない） |
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
| `/api/admin/orders/[id]/completions/[completionId]/cancel` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/completions/%5BcompletionId%5D/cancel/route.ts) （G-1停止: 認可・CSRF・回数制限の後に 410 `MANUAL_COMPLETION_DISABLED`。仕上がりの手動記録・取消は終了） |
| `/api/admin/orders/[id]/completions` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/completions/route.ts) （G-1停止: 認可・CSRF・回数制限の後に 410 `MANUAL_COMPLETION_DISABLED`。仕上がりの手動記録・取消は終了） |
| `/api/admin/orders/[id]/emails/[emailId]` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/emails/%5BemailId%5D/route.ts) |
| `/api/admin/orders/[id]/emails/resend` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/emails/resend/route.ts) |
| `/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/%5BfulfillmentId%5D/cancel/route.ts) （G-3移行: 認可・CSRF・回数制限の後に 410 `LEGACY_FULFILLMENT_DISABLED`。発送は荷作り表の発送票で行う） |
| `/api/admin/orders/[id]/fulfillments` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/fulfillments/route.ts) （G-3移行: GET は認可の後、POST は認可・CSRF・回数制限の後に 410 `LEGACY_FULFILLMENT_DISABLED`。発送は荷作り表の発送票で行う） |
| `/api/admin/orders/[id]/history` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/history/route.ts) |
| `/api/admin/orders/[id]/refund/confirm` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/refund/confirm/route.ts) |
| `/api/admin/orders/[id]/refund` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/refund/route.ts) |
| `/api/admin/orders/[id]/returns/materials` | `GET` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/returns/materials/route.ts) |
| `/api/admin/orders/[id]/returns` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/returns/route.ts) |
| `/api/admin/orders/[id]/review` | `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/review/route.ts) |
| `/api/admin/orders/[id]/status` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
| `/api/admin/orders` | `GET` | [route.ts](../../../src/app/api/admin/orders/route.ts) |
| `/api/admin/packing` | `GET` | [route.ts](../../../src/app/api/admin/packing/route.ts) （G-3 Task 3: `admin.shipping.read` ＋ `admin.orders.read`。荷作り表。発送準備中の品物の行を古い注文から返す。読むだけ。CSRF・回数制限なし） |
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
| `/api/admin/shipment-slips/[id]` | `GET` | [route.ts](../../../src/app/api/admin/shipment-slips/%5Bid%5D/route.ts) （G-3 Task 3: `admin.shipping.read` ＋ `admin.orders.read`。発送票1件の詳細。読むだけ。id が uuid でなければ400、無ければ404） |
| `/api/admin/shipment-slips` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/shipment-slips/route.ts) （G-3 Task 3: `GET` は `admin.shipping.read` ＋ `admin.orders.read`。発送票の一覧。読むだけ。stage で絞れる。G-3 Task 4: `POST` は `admin.shipping.manage` ＋ `admin.shipping.read` ＋ `admin.orders.manage` ＋ `admin.orders.read`。発送票の下書きの作成。CSRF・回数制限 `admin.shipment_slips.draft` の120回/600秒・監査 `admin.shipment_slips.draft.save`。成功は201） |
| `/api/admin/shipment-slips/[id]/draft` | `POST` | [route.ts](../../../src/app/api/admin/shipment-slips/%5Bid%5D/draft/route.ts) （G-3 Task 4: 上と同じ4権限。下書きの品物を丸ごと入れ替える（外す・追加）。`expectedVersion` が必須。CSRF・回数制限 `admin.shipment_slips.draft` の120回/600秒・監査 `admin.shipment_slips.draft.save`。成功は200） |
| `/api/admin/shipment-slips/[id]/discard` | `POST` | [route.ts](../../../src/app/api/admin/shipment-slips/%5Bid%5D/discard/route.ts) （G-3 Task 4: 上と同じ4権限。下書きの破棄。`expectedVersion` が必須。CSRF・回数制限 `admin.shipment_slips.discard` の60回/600秒・監査 `admin.shipment_slips.draft.discard`。成功は200） |
| `/api/admin/shipment-slips/[id]/confirm` | `POST` | [route.ts](../../../src/app/api/admin/shipment-slips/%5Bid%5D/confirm/route.ts) |
| `/api/admin/shipment-slips/[id]/cancel` | `POST` | [route.ts](../../../src/app/api/admin/shipment-slips/%5Bid%5D/cancel/route.ts) （G-3 Task 6: 上と同じ4権限。確定済みの票の全体の取消。`expectedVersion` が必須。CSRF・回数制限 `admin.shipment_slips.cancel` の30回/600秒・監査 `admin.shipment_slips.cancel`。成功は200） |
| `/api/admin/shipment-slips/[id]/tracking` | `POST` | [route.ts](../../../src/app/api/admin/shipment-slips/%5Bid%5D/tracking/route.ts) （G-3 Task 7: 上と同じ4権限。確定済みの票の伝票番号の入力・訂正。運送会社と番号は両方必須。`expectedVersion` が必須。CSRF・回数制限 `admin.shipment_slips.tracking` の60回/600秒・監査 `admin.shipment_slips.tracking.update`。成功は200） |
| `/api/admin/shipment-slips/[id]/delivered` | `POST` | [route.ts](../../../src/app/api/admin/shipment-slips/%5Bid%5D/delivered/route.ts) （G-3 Task 7: 上と同じ4権限。確定済みの票の手動の配達済み。`expectedVersion` と `deliveredOn` が必須。CSRF・回数制限 `admin.shipment_slips.delivered` の60回/600秒・監査 `admin.shipment_slips.delivered`。成功は200） |
| `/api/admin/settings/shop` | `GET`, `PUT` | [route.ts](../../../src/app/api/admin/settings/shop/route.ts) |
| `/api/admin/stockists/[id]` | `DELETE`, `GET`, `PATCH`, `PUT` | [route.ts](../../../src/app/api/admin/stockists/%5Bid%5D/route.ts) |
| `/api/admin/stockists` | `GET`, `POST` | [route.ts](../../../src/app/api/admin/stockists/route.ts) |
| `/api/admin/users/mfa/reset` | `POST` | [route.ts](../../../src/app/api/admin/users/mfa/reset/route.ts) |
| `/api/admin/users` | `GET`, `PATCH` | [route.ts](../../../src/app/api/admin/users/route.ts) |
| `/api/admin/permissions` | `GET` | [route.ts](../../../src/app/api/admin/permissions/route.ts) |
| `/api/admin/role-permissions` | `POST` | [route.ts](../../../src/app/api/admin/role-permissions/route.ts) |
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
| `/api/auth/oauth/start` | `GET`, `POST` | [route.ts](../../../src/app/api/auth/oauth/start/route.ts) （波1-A: `POST` は会員認証不要。Google ログインの開始。本文の `next` だけを確かめて戻り先の控え（サーバー側）を作り、番号は Cookie だけで渡す。回数制限 `auth:oauth:start` の50回/600秒・監査 `auth.oauth.start`。成功は200 `{url}` で 303 にしない。`GET` は 302 のままで控えを作らず古い控えの Cookie を消す） |
| `/api/auth/otp/verify` | `POST` | [route.ts](../../../src/app/api/auth/otp/verify/route.ts) |
| `/api/auth/post-login` | `POST` | [route.ts](../../../src/app/api/auth/post-login/route.ts) （波1-A: `authenticateRequest`〔セッションCookie/JWT〕。認証の失敗は `authFailureResponse`〔401/403〕。役割とaalはトークンのclaimsだけから読む。回数制限 `auth:post-login` の60回/600秒〔IPごと〕。本文なしで HttpOnly の `sb-return-intent` Cookie を読み、ログインの確定の後の行き先を答える〔戻り先の控えを1回で使い切る。管理者・サポーターは2段目の後〕。成功は200 `{redirectTo, needsMfa}`〔`Cache-Control: no-store`・`Referrer-Policy: no-referrer`〕、失敗は500 `{error:'Internal server error'}`。控えは1回限りで Cookie を消すか残し、外れた控えは監査に残す） |
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

G-3移行: 旧発送・発送取消・伝票訂正・手動配達済みはG-3の発送票へ移行しました。旧入口は認可後410を返します。以下のE-4記述は移行前の契約として保持します。上の6パス・7メソッド（発送の材料の GET・発送・発送の取消・伝票番号の訂正・手動の配達済み・仕上がりの記録と取消）は route ファイルとメソッドを残したまま、POST は既存の認可（MFA）・CSRF・回数制限の後、GET は認可の後に、入力を読まずに 410 の固定の本文（発送の5メソッドは `LEGACY_FULFILLMENT_DISABLED`、仕上がりの2メソッドは `MANUAL_COMPLETION_DISABLED`）と `Cache-Control: no-store` を返す。数は132ファイル・171メソッドのまま（G-1 Task 14）。仕上がりの手動記録と取消の2メソッドは終了のまま再開しない（G-1停止）。

G-3 Task 3: 荷作り表と発送票の読取の3入口（`GET /api/admin/packing`・`GET /api/admin/shipment-slips`・`GET /api/admin/shipment-slips/[id]`）を追加。いずれも `admin.shipping.read` ＋ `admin.orders.read` を窓口と DB の関数の両方で確かめ、読むだけなので CSRF と回数制限は通さない。応答は `Cache-Control: no-store`。数は148ファイル・189メソッド（表は147行・188メソッド）。詳しい入力と応答は [APIの主要契約](api-spec.md)の「管理:荷作り表・発送票」に記す。

G-3 Task 4: 発送票の下書きの3入口（`POST /api/admin/shipment-slips`・`POST /api/admin/shipment-slips/[id]/draft`・`POST /api/admin/shipment-slips/[id]/discard`）を追加。いずれも `admin.shipping.manage` ＋ `admin.shipping.read` ＋ `admin.orders.manage` ＋ `admin.orders.read` を窓口と DB の関数の両方で確かめ、認可 → CSRF → IP の回数制限 → actor の回数制限 → 検証 → DB → 監査の順に通す。応答は `Cache-Control: no-store`。数は150ファイル・192メソッド（表は149行・191メソッド）。詳しい入力と応答は [APIの主要契約](api-spec.md)の「管理:荷作り表・発送票」に記す。

G-3 Task 5: 発送確定の入口（`POST /api/admin/shipment-slips/[id]/confirm`）を追加。認可→CSRF→IPとactorの制限→検証→DB→監査の順序とno-store応答はTask 4と共通。現在の総数は上の概要を参照。

G-3 Task 6: 発送の取消の入口（`POST /api/admin/shipment-slips/[id]/cancel`）を追加（151ファイル→152ファイル、193メソッド→194メソッド。表は150行・192メソッド→151行・193メソッド）。順序とno-store応答はTask 4・5と共通で、回数制限は30回/600秒。現在の総数は上の概要を参照。

波1-A: Google ログイン開始の `POST /api/auth/oauth/start` を追加（152ファイル→152ファイル、194メソッド→195メソッド。表は151行・193メソッド→151行・194メソッド）。既存の `GET` と同じファイルに2本目の export を足したため、ファイル数と表の行数は変わらない。詳しい入力と応答は [APIの主要契約](api-spec.md)の `POST /api/auth/oauth/start` に記す。現在の総数は上の概要を参照。

G-3 Task 7: 伝票番号の入力・訂正の入口（`POST /api/admin/shipment-slips/[id]/tracking`）と手動の配達済みの入口（`POST /api/admin/shipment-slips/[id]/delivered`）を追加（152ファイル→154ファイル、195メソッド→197メソッド。表は151行・194メソッド→153行・196メソッド）。順序とno-store応答はTask 4・5・6と共通で、回数制限はどちらも60回/600秒。現在の総数は上の概要を参照。

波1-A: ログインの後の行き先の窓口（`POST /api/auth/post-login`）を追加（154ファイル→155ファイル、197メソッド→198メソッド）。表は153行・196メソッド→154行・197メソッド。詳しい入力と応答は [APIの主要契約](api-spec.md)の `POST /api/auth/post-login` に記す。現在の総数は上の概要を参照。

## 権限設定の入口（G-0 / FREQ-519・FREQ-540 の G-0 部分）

| パス | 契約・認可 |
| --- | --- |
| `GET /api/admin/permissions` | 毎回 `authorizeAdminPermission('admin.permissions.manage', request)` で DB ACL・active session・aal2 を確認。`{ data: PermissionsMatrix }`（管理対象30コードと admin/supporter の2役割、各文字列の版・許可一覧）。読取は `clientFetch` の `cache: 'no-store'` |
| `POST /api/admin/role-permissions` | 同じ認可→CSRF→IP/actor各10分30回→strict本文検証→RPC→操作監査。`RolePermissionChange` の4欄で1役割の30コード内許可一覧全体を期待版/UUID要求キー付きで保存。応答 `{ data: RolePermissionChangeResult }` の role/版を採用。同キー同入力は同じ結果、同キー異入力・版競合は409。固定2コードの解除/他役割付与は403。差分とイベントの同時保存はDB担当 |

新2入口は拒否応答も `Cache-Control: no-store`。`PUT` 互換入口は作らない（今回の裁定は POST。承認済み設計の旧 PUT 案は変更しない）。型・catalog は [共有型](../../../src/lib/auth/role-permission-types.ts)・[catalog](../../../src/lib/auth/role-permission-catalog.ts)、画面・再送・表示優先は [管理画面詳細](../../04_DetailDesign/pages/16_admin.md#権限画面g-0--freq-519freq-540-の-g-0-部分)。既存 `PATCH /api/admin/users` は `admin.users.manage`・CSRF・同じ制限と1 RPCで自己役割変更/最後の有効店長/昇格を保護する（Task 2）。業務窓口のAND条件と旧発送/在庫APIの切替は後続 G-1〜G-3。

API単体 [GET](../../../tests/unit/api/admin/permissions-route.test.ts)・[POST](../../../tests/unit/api/admin/role-permissions-route.test.ts)・[PATCH](../../../tests/unit/api/admin/users-route.test.ts) は Task 2、DB結合は Task 1、画面単体は Task 3、実routeの拒否とUI→実DB bridgeのE2Eは Task 4（未実行）。一覧に追加したことは実DB/本番動作の証明ではない。

## 更新と検証

ルートを追加・削除した場合はこの一覧を再生成し、API の主要契約と関連テストを更新する。動的セグメント（`[id]` 等）は Next.js のファイル名のまま表記した。ここに列挙したことは、実行時にその API が成功することを意味しない。

## 配送の状況（E-4 / FREQ-488〜497）

[配送の詳細設計](../../superpowers/specs/2026-10-21-delivery-status-design.md)・[実装計画](../../superpowers/plans/2026-10-21-delivery-status.md)を参照。以下は実装後の契約であり、既存の決定の本文は履歴として残す。

G-3移行: 旧発送・発送取消・伝票訂正・手動配達済みはG-3の発送票へ移行しました。旧入口は認可後410を返します。以下のE-4記述は移行前の契約として保持します。伝票番号の訂正（tracking）と手動の配達済み（delivered）の2本は今は 410 `LEGACY_FULFILLMENT_DISABLED` を返す。要対応の解決と17TRACKの受け口は今のまま。

管理POST 3本と17TRACKのPOST 1本の計4パス・4メソッドを追加。ソースの静的集計は128ファイル・167メソッド、E2E用の1本を除いた表は127行・166メソッド。新しいページURLは0。詳細はAPI仕様の配送の節と計画 C-3。

## 注文の状況の入口（E-5 / FREQ-498〜505）

[詳細設計](../../superpowers/specs/2026-10-22-order-status-page-design.md)・[実装計画](../../superpowers/plans/2026-10-22-order-status-page.md)・[APIの契約](api-spec.md)を参照。

個人情報GETと確認POSTの2ファイル・2メソッドを追加。実ソースを数え直した全体は130ファイル・169メソッド、E2E専用1本を除く一覧表は129行・168メソッド。公開APIは作らず、公開ページがサーバーから読む。認可・Origin・CSRF・全エラーはAPI仕様のE-5節に記録する。
