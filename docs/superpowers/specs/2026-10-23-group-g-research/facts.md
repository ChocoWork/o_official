# G のための現状調査（注文・在庫・発注・荷作り）

## 概要

2026-10-23、`master`、調査中に確認した HEAD は `12f968e5`。これはローカルのソースと SQL を読んだ結果であり、稼働 DB の構造・データ・適用済み migration を確認した結果ではない。DB、E2E、Jest、Docker、ネットワークは実行せず、`.env*` は読んでいない。Graphify は `query` だけを入口に使い、根拠は実ファイルで確認した。書き込み先はこのファイルだけ。

G の正は提案の7章。判断表の古い「開店前は一覧と CSV だけ」「納期を持つ」「手で仕上がりを記録する」という案に戻さない。判断表は「この章が正」、G-3 は「G の提案の7章が正」と明記している。根拠: `docs/05_Quality/reviews/code/2026-10-22-decision-sheet.md:366`、`docs/05_Quality/reviews/code/2026-10-22-decision-sheet.md:370`、`docs/05_Quality/reviews/code/2026-10-22-decision-sheet.md:375`、`docs/05_Quality/reviews/code/2026-10-22-decision-sheet.md:383`。

以下の「ある」はコード上の事実、「必要」「リスク」は確定した G とコードを照らした差。「見つからない」は検索した範囲での結果であり、外部サービスや本番 DB に無いことの証明ではない。引用は短い原文を `「…」` またはコードで示す。

## 1. 今の注文

### 表と列

| 対象 | 今あるもの・根拠 |
| --- | --- |
| `orders` の原本 | `id`、`session_id`、`user_id`、`payment_intent_id`、`checkout_session_id`、`status`。金額は `subtotal_amount`、`shipping_amount`、`discount_amount`、`total_amount`、`currency`。配送先は `shipping_email`、`shipping_full_name`、郵便番号・都道府県・市区町村・住所・建物・電話のスナップショット。`created_at`、`updated_at`、`refunded_amount`、`refunded_at`、`payment_status_updated_at`、注文全体の `shipped_at`、`shipping_carrier`、`tracking_number` もある。基礎定義: `migrations/025_create_orders.sql:15`、現在の基礎スキーマの写し: `supabase/migrations/20260901102912_remote_schema.sql:718`。 |
| 後から足した注文列 | `payment_intent_id` は NULL 可へ変更。`review_reason`、`review_marked_at`、`reviewed_at/by`、`cancel_reason`、`cancel_note`、`cancel_notify_customer`、`checkout_session_created_at`。根拠: `supabase/migrations/20260927100100_order_payment_columns.sql:6`、`supabase/migrations/20260927100100_order_payment_columns.sql:23`。`paid_amount` は実際に受け取った額: `supabase/migrations/20261011222930_order_refund_records.sql:106`。送料の DB 既定値は現在0: `supabase/migrations/20261023082632_orders_shipping_default_zero.sql:1`。 |
| `order_items` | UUID の明細 ID、`order_id`、`item_id`、商品名・価格・画像・色・サイズのスナップショット、`quantity`、`line_total`、`created_at`。引用: `「prices are snapshotted at purchase time」`。根拠: `migrations/025_create_orders.sql:44`。 |
| バリアントと受注区分 | `item_id` は bigint、`variant_id bigint` は NULL 可、`fulfillment_type` は `stock` / `backorder`。古い明細は色・サイズで埋め、合わない物は NULL のまま。引用: `「一致しない明細は NULL のまま残す」`。根拠: `supabase/migrations/20260919065442_add_order_items_variant_columns.sql:7`、`supabase/migrations/20260919065442_add_order_items_variant_columns.sql:17`。 |
| 交換の明細 | `line_kind = order / exchange`、`exchange_return_line_id`、`exchange_paid_amount`。交換は `item_price = 0 AND line_total = 0`。根拠: `supabase/migrations/20261012235910_order_return_records.sql:175`。 |

DB の `order_status` は `payment_in_progress`、`pending`、`paid`、`failed`、`abandoned`、`cancelled`、`shipped` の7つ。`delivered` や G の12状態を注文 enum に足した実装ではない。初期4値は `migrations/025_create_orders.sql:9`、`shipped` は `migrations/083_order_status_shipped.sql:5`、残り2値は `supabase/migrations/20260927100000_add_order_payment_statuses.sql:8`、TS 側の一致する一覧は `src/lib/orders/order-payment-types.ts:6`。古い表示用辞書には `processing`、`delivered` 等もあるが、enum の根拠にはしない（`src/lib/orders/order-status.ts:4`）。

### 状態を書き換える関数

`migrations/` と `supabase/migrations/` の `orders` への INSERT / UPDATE を検索し、後の再定義と削除を照合した。現行 migration 列で残る、状態を直接決める関数は次のとおり。

| 関数 | 状態の変更と根拠 |
| --- | --- |
| `public.place_order_from_checkout_draft` | 注文を `payment_in_progress` で作る。現在の最終定義: `supabase/migrations/20261023082740_item_variant_retire.sql:166`、INSERT: 同ファイル `:365`。 |
| `public.mark_order_awaiting_payment` | `payment_in_progress → pending`。`supabase/migrations/20261009095736_order_email_enqueue.sql:147`、`:181`。 |
| `public.mark_order_paid` | 比較元を `payment_in_progress / pending / failed` に限り、ロック後に `paid`、`paid_amount` を記録。在庫を取り直せないと `review_reason = stock_not_reserved`。`supabase/migrations/20261011222930_order_refund_records.sql:608`、`:631`、`:685`。 |
| `public.release_stock_for_unpaid_order` | 比較元 `payment_in_progress / pending` から `failed / abandoned / cancelled`。`abandoned` は比較元が `payment_in_progress` の時だけ。在庫を戻す。最新: `supabase/migrations/20261023061408_order_cancel_reasons.sql:63`、`:86`、`:123`、`:147`。 |
| `public.admin_cancel_failed_order` | `failed → cancelled`。最新: `supabase/migrations/20261023061408_order_cancel_reasons.sql:12`、`:47`。 |
| `public.admin_create_fulfillment` | 一部発送では注文は `paid` のまま。残りを全部送った時に `shipped` と注文の発送列を書く。最新: `supabase/migrations/20261021221140_delivery_tracking_admin.sql:223`、`:411`。 |
| `public.admin_cancel_fulfillment` | 発送を取り消し、未発送が戻ると `shipped → paid`、注文の発送列を NULL にする。最新: `supabase/migrations/20261021221140_delivery_tracking_admin.sql:438`、`:512`。 |
| `private.apply_order_refund_state` | 成功した全額返金で `cancelled`。返金失敗時などの復元で `paid / shipped` を選び直す。未発送数の変化でも `paid ↔ shipped` を調整。最新: `supabase/migrations/20261013001143_order_return_receipts.sql:922`、`:1135`、`:1150`、`:1215`。 |
| `public.admin_receive_return` | 交換の品を追加すると、元が `shipped` の注文を `paid` に戻す。最新: `supabase/migrations/20261020150415_order_return_request_reviews.sql:598`、`:914`。 |

間接の入口も残す。TS の `placeOrder`、`markOrderPaid`、`markOrderAwaitingPayment`、`releaseStock` は上記 RPC の呼び出し（`src/lib/stripe/checkout-payment-reconciler-deps.ts:125`、`:152`、`:173`、`:182`）。`reconcileCheckoutPayment` が決済結果から使い分ける（`src/lib/stripe/checkout-payment-reconciler.ts:188`、`:424`、`:461`、`:486`）。期限切れ理由の文字列は `failed: stripe_voucher_expired`、`abandoned: stripe_checkout_expired`（同ファイル `:161`）。`record_order_refund_result` と `mark_order_refund_error` は `private.apply_order_refund_state` を呼び、`record_external_order_refund` も返金結果の処理へ接続する（`supabase/migrations/20261013001143_order_return_receipts.sql:1456`、`:1544`、`supabase/migrations/20261011223453_order_refund_results.sql:973`）。

旧 `finalize_order_from_checkout_draft`、旧 `admin_ship_paid_order`、旧 `apply_order_refund_projection` は、定義が検索に出ても現行の入口ではない。削除の根拠: `supabase/migrations/20260927100800_retire_legacy_order_rpcs.sql:10`、`supabase/migrations/20261010122320_fulfillment_order_emails.sql:639`、`supabase/migrations/20261011223453_order_refund_results.sql:1286`。`admin_update_fulfillment_tracking` は注文の配送列も更新するが、注文の `status` は変更しない（`supabase/migrations/20261021221140_delivery_tracking_admin.sql:685`）。

### 一覧・検索・CSV・履歴・要対応

- 管理注文は `src/app/admin/page.tsx` の ORDER タブと `OrderSection`。1行は注文1件で、その中へ複数の商品を表示する。引用: `「進み具合」` と `「支払い」` は別列。根拠: `src/app/admin/page.tsx:1329`、`src/components/OrderSection.tsx:319`、`src/components/OrderSection.tsx:346`。管理側の独立した注文詳細頁は `src/app/admin/` のファイル一覧に見つからない。今の接続先は同頁内の各 dialog（同頁 `:1344` 以降）。
- 検索は `GET /api/admin/orders`、権限 `admin.orders.read`。日付、金額、取引先、注文・決済 ID、DB status、要確認、返品、キャンセル申請で絞る。注文日降順・ページ単位。根拠: `src/app/api/admin/orders/route.ts:317`、`:325`、`:379`、`:410`。画面は1頁20件（`src/app/admin/page.tsx:169`）。
- 管理 API の既定除外は `abandoned` だけ。`payment_in_progress` も常に隠す実装ではない（`src/app/api/admin/orders/route.ts:428`）。お客様の注文履歴と KPI 用の非表示集合は両方（`src/lib/orders/order-payment-types.ts:18`）。G 提案の「今と同じく一覧に出さない」と管理一覧の現行挙動には差がある。
- 一覧 DTO は明細の名前・色・サイズ・数量・`fulfillment_type`・`line_kind` と発送数を返すが、`variant_id`、`item_price`、`line_total` は選んでいない。注文の `user_id` と `shipping_building` もこの SELECT にない。G の品物別金額と同梱判定にはこの DTO のままでは足りない。根拠: `src/app/api/admin/orders/route.ts:379`、`:400`、`:520`。
- CSV は専用の全件取得 API ではなく、画面で取得して絞った `displayedOrders` から `orderStatus === 'paid'` だけを書き出す。見出しは11列、UTF-8 BOM 付き。商品の欄は `readyUnshipped > 0` だけで、名前と数量、交換の印を書く。色・サイズ・単価の独立列はない。根拠: `src/app/admin/page.tsx:139`、`:145`、`:495`、`:1013`、`:1036`。商品数は交換を除く購入数量で、CSV 商品欄の発送準備数量の合計とは違う（`src/app/api/admin/orders/route.ts:535`）。J-01 の置き換え対象。
- 履歴は `OrderHistoryDialog` と `GET /api/admin/orders/[id]/history`。状態、メール、発送、仕上がり、返金、返品、キャンセル申請、配送を集約する。引用: `「新しい順」`、`「再送や取消ができるかは窓口が決めた値」`。根拠: `src/components/OrderHistoryDialog.tsx:175`、`src/app/api/admin/orders/[id]/history/route.ts:208`、`src/lib/orders/email/order-history.ts:30`。
- 要対応欄は注文の例外・要確認・配送の組。API は未解決の `payment_exceptions`、未確認の注文、追跡オン時の配送要対応、メール送信の停止状況を返す（`src/app/api/admin/order-attention/route.ts:155`、`:162`、`:164`、`:250`）。画面の帯とナビ件数、操作入口は `src/app/admin/page.tsx:1138`、`:1172`、`:1180`、`:1459`。返品申請・返金待ち・キャンセル申請の件数は orders API 側にもある（`src/app/api/admin/orders/route.ts:646`、`src/app/admin/page.tsx:1193`）。

## 2. 部分発送と手動の仕上がり（E-1）、配送（E-4）

| 表・関数 | 現在の役目・根拠 |
| --- | --- |
| `order_fulfillments` | 1注文の1回の発送。`order_id`、注文内連番 `number`、一意 `request_key`、運送会社・伝票番号、`notify_customer`、`completes_order`、`shipped_at`、実行者、取消時刻・実行者、`legacy`。`supabase/migrations/20261010120303_order_fulfillments.sql:11`。 |
| `order_fulfillment_lines` | 発送 × 注文明細 × 数量。複合主キー `(fulfillment_id, order_item_id)`。同ファイル `:32`。 |
| `order_item_completions` | 受注生産の明細に対する手動の仕上がり数量。実行者・時刻・取消、`(request_key, order_item_id)` の一意制約。同ファイル `:39`。 |
| 仕上がり RPC | `admin_record_completion`、`admin_cancel_completion`。入金済みの backorder の未仕上がり数まで記録。取消で発送済み数を下回ると `COMPLETION_ALREADY_SHIPPED`。同ファイル `:354`、`:417`、`:450`、`:492`。在庫入庫ではなく completion 行を足す。 |
| 発送 RPC | 現在の最終版 `admin_create_fulfillment` / `admin_cancel_fulfillment` は E-4 migration。注文を `FOR UPDATE` で直列にし、同じ request key・同じ指紋は前の結果、違う内容は `FULFILLMENT_REQUEST_MISMATCH`。`supabase/migrations/20261021221140_delivery_tracking_admin.sql:285`。 |
| 発送の守り | 支払い済み、住所あり、支払額要確認でない、準備数以下、交換の手数料待ちでないこと。取消は返品がある発送・発送後返金済み数を下回る発送を断る。根拠: 同ファイル `:313`、`:332`、`:482`、`:491`。 |

`OrderShipDialog` は1注文を開き、準備中の全部を初期値にし、商品ごとに今回の発送数を入力する。中で仕上がりも記録できる（`src/components/OrderShipDialog.tsx:98`、`:199`、`:226`、`:246`、`src/lib/orders/fulfillment/fulfillment-types.ts:103`）。別の `OrderCompletionDialog` は受注生産中の商品へ仕上がった数を入れる（`src/components/OrderCompletionDialog.tsx:42`、`:119`）。G が取り除くのは、両方の画面の手動仕上がり入口と、それを必須にする現行の計算・書き込み経路。

数量の共通の計算は `private.order_line_fulfillment`。現在の最終定義は E-2 の `supabase/migrations/20261011222930_order_refund_records.sql:335`。`q = quantity`、`s = 取消でない発送明細の合計`、`c = stock なら q、backorder なら取消でない completion の合計`。`rb / ra` は発送前 / 発送後の返金数量で、`awaiting_response / pending / succeeded` を数え、error / failed は除く（同ファイル `:358`、`:365`、`:374`）。

| 出す数 | 現在の式 |
| --- | --- |
| 受注生産中 `in_production` | `max(q - rb - c, 0)` |
| 発送準備中 `ready_unshipped` | `max(min(c, q - rb) - s, 0)` |
| 未発送 `unshipped` | `max(q - s - rb, 0)` |

式の原文は同ファイル `:330`、`:401`。`public.list_order_line_fulfillment(uuid[])` がまとめて返し、TS の `listOrderLineFulfillment` が camelCase と数値に直す（同 SQL `:408`、`src/lib/orders/fulfillment/fulfillment-store.ts:161`）。現行の準備数は割当台帳そのものを見て決める数ではない。stock は確保を失っても `c = q` のままなので、支払い・要確認の守りも合わせて読む必要がある。

発送では `shipped_at = now()` で発送行・配送の最初の出来事を書き、必要なら outbox の `shipped` を同じ取引で作る。発送の関数内に在庫減算の台帳追記はない。根拠: `supabase/migrations/20261021221140_delivery_tracking_admin.sql:380`、`:399`、`:424`。発送取消も completion を戻さず、取消印で数を戻す（同ファイル `:502`）。従って G の発送時の在庫減算・取消時の戻しは現行処理に足すだけでは二重計上になる。

発送メールは発送行に結び付き、その発送の商品・数、残りがある案内を組み立てる（`src/lib/orders/email/order-email-compose.ts:363`、`:1702`、`:1721`、`:1729`）。今は運送会社と伝票番号が作成必須で、未入力の新規発送は不可（`supabase/migrations/20261021221140_delivery_tracking_admin.sql:264`）。G の「後からでも入力可」と差があり、追跡番号なしのメールの扱いも既存のままでは成立しない。

E-4 の主要な保存先は `order_fulfillments.delivery_status / delivery_status_at / delivered_at / tracking_version / request_fingerprint`、`order_fulfillment_events`、`order_fulfillment_tracking_changes`、`order_fulfillment_attention`、`private.fulfillment_tracking_registrations`、`private.delivery_tracking_provider_gate`。根拠: `supabase/migrations/20261021220816_delivery_tracking_records.sql:11`、`:114`、`:139`、`:158`、`:204`、`:225`。`delivery_tracking_enabled` は **migration の既定値が false**（同ファイル `:7`）。環境値・稼働設定を読んでいないので、現在の本番がオフかは未確認。

- 訂正は `admin_update_fulfillment_tracking`。版を増やし、変更記録と `shipping_update` を残す。今は1発送ずつ（`supabase/migrations/20261021221140_delivery_tracking_admin.sql:545`、`:660`、`:671`）。
- 手動配達済みは `admin_mark_fulfillment_delivered`。届いた日を発送日から今日の間で検証し、`manual` の出来事・実行者を記録する。注文 enum は変えない（同ファイル `:702`、`:774`、`:787`、`:795`）。追跡オン・オフと別の機能。
- 同じ運送会社・番号を複数の発送で持つことは既に想定され、索引は UNIQUE にしない（`supabase/migrations/20261021220816_delivery_tracking_records.sql:198`）。Webhook の合図は一致する registered 行全部へ届く（`supabase/migrations/20261021221410_delivery_tracking_sync.sql:88`）。同一番号の有効 lease を避ける守りもある（同ファイル `:266`）。ただし登録の主キーは発送 ID と版で、他の追跡行があっても次の行は `register` を選ぶ（同ファイル `:304`）。**発送票単位で登録を1回だけ行う約束は未実装**。worker も claim 行を外部の操作へ渡す（`src/lib/orders/tracking/delivery-worker.ts:77`、`:93`）。
- 配達済みメール等は `out_for_delivery / delivered / shipping_update`（`src/lib/orders/email/order-email-types.ts:40`）。返品期限は届いた日を優先し、無ければ発送日＋目安日数を使う（`supabase/migrations/20261021221140_delivery_tracking_admin.sql:1315`）。G の会計用出荷日を単にこの日時へ上書きすると、返品期限や配達日制約も変わる。

既存注文の移行例として `private.backfill_legacy_fulfillments` があり、昔の注文全体の発送から発送行・明細・必要な completion を起こす。引用: `「送った受注生産の品は作り終えている」`。根拠: `supabase/migrations/20261010120303_order_fulfillments.sql:670`、`:710`。G の旧データ移行にもこの履歴の存在を考慮する必要がある。

## 3. 在庫、確保、入荷、発注先

- `item_variants` は商品・色・サイズの組。`stock_quantity >= 0` で、初期値は0、直接の在庫書き換えを避ける作り（`supabase/migrations/20260919065336_add_variant_inventory_tables.sql:27`、`:46`、`:127`）。商品単位の旧在庫は廃止済み（`supabase/migrations/20260921121038_retire_item_stock_quantity.sql:1`、`docs/02_Requirements/requirements.md:1585`）。
- `stock_movements` は `variant_id / delta / reason / order_id / order_item_id / note / created_by / created_at`、後から `refund_id / return_id`。追記で `apply_stock_movement` が `stock_quantity += NEW.delta`、UPDATE / DELETE / TRUNCATE は拒否。引用: `「stock_movements is append-only」`。根拠: `supabase/migrations/20260919065355_add_stock_movements.sql:6`、`:26`、`:45`、`supabase/migrations/20261011222930_order_refund_records.sql:123`、`supabase/migrations/20261012235910_order_return_records.sql:214`。
- 現在の理由は7つ: `purchase`（注文への確保・販売）、`restock`（入荷）、`adjustment`（棚卸調整）、`cancel`、`refund`、`return`、`exchange`。**`purchase` は仕入発注の記録ではない**。理由の制約は `supabase/migrations/20261012235910_order_return_records.sql:218`、表示は `src/app/admin/item/ItemStockSection.tsx:59`、注文時の負の台帳は `supabase/migrations/20261023082740_item_variant_retire.sql:470`。
- 注文時は同じ variant の数量を合算し、**その合計を全部まかなえるか**で stock / backorder を決める。足りなければその variant の行は backorder。stock だけ `purchase -quantity` を書く。現行は「2点中1点をその場で stock、残り1点を backorder」に分割する作りではない。根拠: `supabase/migrations/20261023082740_item_variant_retire.sql:429`、`:460`、`:470`。支払い前の `payment_in_progress` の時点で確保される。
- 確保数 `reserved = max(0, -sum(delta))` は `purchase / cancel / refund / exchange` の台帳から計算（現在の最終版: `supabase/migrations/20261012235910_order_return_records.sql:599`）。在庫表示の引当済みは stock 行の `max(reserved - shipped, 0)`、受注生産は pending / paid の backorder の `in_production` の合計（`supabase/migrations/20261010120303_order_fulfillments.sql:581`、`:615`）。
- 現在の4数は、すぐ出せる数 `stock_quantity`、引当済み `committed`、手元の数 `stock_quantity + committed`、受注生産 `backorder`。根拠: `src/app/api/admin/items/[id]/variants/route.ts:160`、`src/app/admin/item/ItemStockSection.tsx:14`。G の「在庫」に近いのは現行の `onHandQuantity`。ただし手動仕上がりの backorder は、この stock 行の確保合計と同じものではない。
- UI は商品編集に付く `ItemStockSection`。各 variant の入荷 / 棚卸調整と理由・メモ、最新の履歴を出す。商品をまたぐ在庫一覧ではない（`src/app/admin/item/ItemStockSection.tsx:208`、`:283`、`:308`、`:368`）。API は `/api/admin/items/[id]/variants`。GET は `backfill_item_variants` を呼んで組をそろえてから数を読み、POST は `stock_movements` へ追記する（`src/app/api/admin/items/[id]/variants/route.ts:100`、`:124`、`:246`）。この GET はコード上は完全な無更新処理でもないため、今回 HTTP で呼んでいない。
- **入荷しても backorder へ自動割当する処理は見つからない。** POST は台帳追記のみ、台帳トリガーは variant 残高を更新するだけ、backorder の準備数は completion 依存。この3点からの静的な結論（同 API `:246`、`supabase/migrations/20260919065355_add_stock_movements.sql:26`、`supabase/migrations/20261011222930_order_refund_records.sql:365`）。返品で在庫へ戻した場合も G の FIFO はない。
- `src/`、`migrations/`、`supabase/migrations/` で `purchase_order / purchase_orders / supplier / suppliers / procurement` と CREATE TABLE を検索し、仕入発注・発注明細・納品受取・仕入先専用テーブルは見つからなかった。既存の取引先マスター `admin_finance_partners(id, name, created_by, created_at, updated_at)` はあるが、発注の相手や数量を結ぶ表ではない（`migrations/065_add_finance_partner_and_partners_table.sql:12`）。原価計算の予定数量 `plannedQuantity` も発注数量ではない（`src/app/api/admin/accounting/product-costs/route.ts:11`）。

## 4. 返品・キャンセル・返金（E-2 / E-3）

| 対象 | 状態・明細で持つ数・根拠 |
| --- | --- |
| `order_refunds` | `awaiting_response / error / pending / succeeded / failed`。請求元 `source`、一意 request key・指紋・Stripe 返金 ID、総額、送料、調整額、通知、実行者、受付・成功・失敗時刻、在庫を処理済みの印。`supabase/migrations/20261011222930_order_refund_records.sql:17`、`:28`、`:39`、`:55`。E-3 は `return_id` と source `return` を追加（`supabase/migrations/20261012235910_order_return_records.sql:190`）。 |
| `order_refund_lines` | `order_item_id / quantity / before_shipment / restock_type / amount`。`released_quantity`、`restocked_quantity`、`rereserved_quantity`、`rereserve_shortage` を保持。`supabase/migrations/20261011222930_order_refund_records.sql:79`。E-3 の `return` の戻し方も追加（`supabase/migrations/20261012235910_order_return_records.sql:204`）。 |
| `order_returns` | `requested / open / closed / cancelled / declined`。店作成 / 客申請、承認・お断り・取消と実行者、返送方法、返送料、交換手数料、未収額等。`supabase/migrations/20261012235910_order_return_records.sql:21`。 |
| `order_return_lines` | 発送 ID、注文明細 ID、数量、理由、返金 / 交換、交換 variant、stock / make。`supabase/migrations/20261012235910_order_return_records.sql:81`。 |
| `order_return_receipts` / `order_return_receipt_lines` | 受け取り・検品・未着終了・再開・返金不要を追記。品ごとの `restocked / not_restocked / pending_inspection / inspected_* / sent_back / missing / missing_reopened / refund_waived` と数量を持つ。`supabase/migrations/20261012235910_order_return_records.sql:111`、`:135`。現行の受け取りヘッダーは `created_at` で、会計方針10章の「届いた日」と「検品を終えた日」の別入力はまだない（同 SQL `:126`、`docs/01_Planning/revenue-recognition-policy.md:487`）。 |
| `order_cancel_requests` / `order_cancel_request_lines` | `requested / resolved / declined / closed`。申請・判断・解決者、返金 ID、明細ごとの `order_item_id / quantity`。`supabase/migrations/20261020144439_order_return_request_records.sql:65`、`:92`。未入金取消や返金本体とは別の、申請の記録。 |

返品の行ごとの共通計算は `private.order_return_line_states_core` / `private.order_return_line_states`。確認済み、在庫へ戻した数、戻さない数、検品待ち、お返し、未着、交換、返金済みの覆い、返金不要、返金待ちを追記記録から作る（`supabase/migrations/20261012235910_order_return_records.sql:618`、`:645`、`:877`）。TS の形も `progress: { restocked, notRestocked, pendingInspection, sentBack, missing, processed, unprocessed, exchanged, refundCovered, refundWaived, refundWaiting }`（`src/lib/orders/returns/return-types.ts:73`）。

注文明細ごとの `list_order_line_return_counts` は `shipped / refunded_after_shipment / requested / open_unprocessed / refund_waiting / exchanged / sent_back / returnable / refundable_after_shipment` を返す（`supabase/migrations/20261012235910_order_return_records.sql:996`）。返品可能数は、発送数から返金後数量・申請数量・未処理・返金待ち・交換・お返し・返金不要を控除（同 SQL `:942`）。発送明細ごとの返品期限・返品可能数は E-4 の `private.fulfillment_line_returnable`（`supabase/migrations/20261021221140_delivery_tracking_admin.sql:1294`）。これらの数は重なりを避けて使う必要があり、`shipped` をそのまま「返品を除いた発送済み数」とは扱えない。

表示用の返品状態は DB status と別で、`requested / in_progress / refund_waiting / returned`。注文に複数返品があると一番手前を表示する（`src/lib/orders/returns/return-types.ts:10`、`supabase/migrations/20261013000456_order_return_actions.sql:1490`）。客向けは `requested / accepted / partially_received / inspecting / awaiting_fee / refund_preparing / returned / declined`（`src/lib/orders/returns/customer-return-types.ts:19`）。

在庫の返し方も既存契約。発送前の stock の返金は、受付時に確保を外し、戻さない場合は `refund +n` と `adjustment -n`、失敗時は取り直しと不足を記録する。発送後返金は在庫を戻さず、返品受取で戻す（`tests/integration/db/order_refund_results.integration.test.ts:337`、`:367`、`:389`、`:411`、`:425`、実装 `supabase/migrations/20261013001143_order_return_receipts.sql:922`）。G の FIFO を入れると「返金失敗で確保を取り直す」相手との競合も生じる。

現在の入口は一覧上の `返金`、`キャンセル`、`返品`、`キャンセルの申し込み`。親は `OrderRefundDialog / OrderPaidCancelDialog / OrderCancelDialog / OrderReturnsDialog / OrderCancelRequestDialog` を開く（`src/components/OrderSection.tsx:416`、`:427`、`:438`、`:478`、`src/app/admin/page.tsx:633`、`:871`、`:1364`）。未入金取消は status API、支払い済み未発送の全取消は返金権限も要求する（`src/app/api/admin/orders/[id]/status/route.ts:92`、`:216`）。G はこれらを注文詳細へ移す。発送・伝票番号訂正・発送取消・手動配達済みは発送票側へ移すという Q8 が正。

## 5. 品物ごとのステータスに再利用できる計算

- `deriveOrderProgress` は **注文全体**の言葉を作る。paid / shipped では最も手前の段階 `in_production → ready → in_transit → delivered` を選び、一部発送の印を足す。`hasOpenRefund` かつ送った品も残りも0なら `cancel_pending`。キャンセル申請 `requested` と同じ意味ではない。根拠: `src/lib/orders/order-progress.ts:65`、`:72`、`:82`、`:87`。
- 全発送が配達済みで残りがない時だけ注文全体を `delivered`。各発送の配送記録と `order_fulfillment_lines` を結べば、品物の配達済み数量を数える材料はある。既存の注文全体の delivered 件数を各品の全数量へ写すのは不正確（同ファイル `:67`、`:91`、`src/lib/orders/customer-order-view.ts:49`）。
- `buildCustomerOrderPublicView` は共通の progress に加え、各明細へ `shippedQuantity / refundedQuantity / readyQuantity / inProductionQuantity` を付ける。`showStages` は paid / shipped の時だけ。G の数量分割に使える材料だが、12状態ごとの行を返す関数ではない（`src/lib/orders/customer-order-view.ts:102`、`:116`）。
- `derivePaymentStatus` は支払いの6区分 `unpaid / failed / none / paid / partially_refunded / refunded`。返金は注文合計で別表示（`src/lib/orders/payment-status.ts:8`、`:36`）。これだけで「支払い期限切れ」と通常の決済失敗を区別しない。
- 今の管理一覧の商品欄には `受注生産中 n・発送準備中 n・発送済み n` が併記される。これは品物単位の数量表示が既にある根拠（`src/components/OrderSection.tsx:223`）。ただし申請・返品・配達を排他的な12区分へまとめる関数は、`src/lib/orders/` と管理一覧の読取経路に見つからない。
- 要求の該当番号: 手動仕上がり `FREQ-440`（`docs/02_Requirements/requirements.md:1624`）、注文全体の進み具合 `FREQ-441`（`:1625`）、客向け発送ごとの表示 `FREQ-444`（`:1628`）、在庫4数 `FREQ-445`（`:1629`）、返金を含む数量 `FREQ-454`（`:1638`）、支払い列と進み具合 `FREQ-458`（`:1642`）、返品列 `FREQ-468`（`:1652`）、交換を売上集計から除く `FREQ-472`（`:1656`）、手動配達済み `FREQ-489`（`:1673`）。G では管理側を置き換えても、客向けの言葉は維持する決定（`docs/superpowers/specs/2026-10-23-group-g-proposal.md:139`）。

## 6. 添付と Storage、消さずに訂正を残す作り

### ソースに定義されている bucket

| bucket | 根拠・用途 |
| --- | --- |
| `news-images` | 非公開・画像、`migrations/013_create_news_images_bucket.sql:6`、利用 `src/lib/storage/news-images.ts:3`。 |
| `item-images` | 商品画像。作成 `migrations/016_create_items_and_item_images_bucket.sql:79`、非公開化 `migrations/044_harden_item_images_bucket_private.sql:6`。 |
| `look-images` | LOOK 画像。作成 `migrations/018_create_looks_and_look_images_bucket.sql:68`、非公開化 `migrations/030_make_look_images_bucket_private.sql:9`。 |
| `finance-receipts` | 会計証憑用・非公開。`migrations/072_finance_receipts_and_revisions.sql:148`。 |
| `legal-archive` | 注文等の法定の写し用・非公開。`migrations/081_online_order_legal_archive.sql:270`。 |
| `return-photos` | 返品申請写真用・非公開、JPEG/PNG、10 MiB。`supabase/migrations/20261020144439_order_return_request_records.sql:588`。 |

これはソース上の bucket の一覧。稼働 Storage の存在・公開設定・保持設定は未照合。

| 既存の経路 | 再利用の材料と限界 |
| --- | --- |
| 会計の証憑アップロード | `POST /api/admin/kpi/cost-profit/receipt`。`admin.finance.manage`、CSRF、20 MiB、PDF/JPEG/PNG/WebP/HEIC、`upsert: false`。親取引の存在と未削除を確認する。`GET` は登録済みの証憑だけを300秒の URL にする。根拠: `src/app/api/admin/kpi/cost-profit/receipt/route.ts:9`、`:25`、`:65`、`:93`、`:100`、`:118`。実際の URL や保存パスは本資料に転載しない。 |
| 会計の証憑メタデータ | `admin_finance_receipts` に親取引、ファイル名、形式、サイズ、実行者、時刻。取引の日・金額・取引先は親の会計取引にある。証憑表自身は親への `ON DELETE CASCADE` と manage の `FOR ALL` policy を持つ（`migrations/072_finance_receipts_and_revisions.sql:114`、`:138`）。この表をそのまま「消せない証憑」とは断定できない。 |
| 会計の訂正履歴 | 取引は論理削除 `deleted_at/by`、`admin_finance_entry_revisions` に before / after と実行者・時刻を保存。`CostProfitSection` の原文は **「訂正は削除＋再登録にしない。expense.update で履歴を1本につなぐ」**。根拠: `migrations/072_finance_receipts_and_revisions.sql:10`、`:38`、`:55`、`src/components/CostProfitSection.tsx:2233`。 |
| 注文原本の不変性 | `orders` / `order_items` の削除を止め、注文の原本列と明細の UPDATE を止める trigger。運用変更は `order_revisions` に before / after、changed_fields、理由、イベント ID、実行者を残す。根拠: `migrations/081_online_order_legal_archive.sql:80`、`:102`、`:158`、`:173`、`:242`、`supabase/migrations/20260901102912_remote_schema.sql:698`。 |
| 法定の写し | `storeArchiveAtomically` は一時保存→読戻し SHA-256 照合→manifest→確定。`manifest.retentionYears` の既定は7。Supabase の upload は `upsert: false`、確定先が存在すれば拒否する経路。根拠: `src/lib/legal-archive/storage.ts:19`、`:49`、`:55`、`src/lib/legal-archive/manifest.ts:42`、`src/lib/legal-archive/supabase-storage.ts:15`、`:23`。S3 adapter のコードは存在確認＋コピーで、Object Lock の指定はない（`src/lib/legal-archive/s3-storage.ts:20`、`:26`）。保持年数を manifest に書くことと、Storage 側で削除を禁止することは別。 |
| 返品写真 | 所有権を照合した署名アップロード、形式・実データの確認、短命の閲覧 URL は参考になる。ただしメタデータ除去のため `upsert: true` で画像を書き直す経路と、未添付1日 / 終了後90日の削除がある。引用: `「消す時期が来た」`。根拠: `src/lib/orders/returns/return-photo-storage.ts:62`、`:117`、`:129`、`:183`、`:229`、`src/lib/orders/returns/return-photo-sanitize.ts:154`。発注の見積・請求書原本の不変保存へそのまま転用はできない。 |

G には発注書に属する添付、取引日・金額・取引先による検索、原本を消さないことと訂正の跡が必要。これは Q4 の決定（`docs/superpowers/specs/2026-10-23-group-g-proposal.md:285`）。既存部品は参考になるが、**この調査では法令への適合を認定しない**。外部の法令・運用規程・実際の保存設定は調査範囲外。ファイル保存が成功して DB 登録だけ失敗する境界もある（会計の既存処理はその時にファイルを削除する: `src/app/api/admin/kpi/cost-profit/receipt/route.ts:137`）。G の消せない原本の契約との照合対象になる。

## 7. 会計の接続先と、後で出荷日を渡す場所

現在は発送イベントから売上仕訳を永続化する経路ではない。`toOrderSalesTransaction` は `paid` または返金額がある `cancelled` を対象にし、日付は `orders.created_at`、通常経路の金額は総額−成功返金額。Stripe 会計を使う場合はここで返金額を0にし、Stripe 側で返金を別に扱う。`shipped` は対象外。引用: `date: row.created_at`。根拠: `src/lib/sales/order-sales.ts:33`、`:42`、`:44`、`:53`。

| 接続先 | 今の読み方 |
| --- | --- |
| KPI `/api/admin/kpi` | 注文・明細を読み、`toOrderSalesTransaction`、注文日を JST 月に変換して集計。年候補は paid 注文。`src/app/api/admin/kpi/route.ts:194`、`:307`、`:337`、`:362`。 |
| 会計 `/api/admin/kpi/cost-profit` | 注文を作成日の年で絞り、`mapOrderIncome` で読取専用の収入に変換。Stripe の charge の投影があれば注文側の返金控除を切り替える。`src/app/api/admin/kpi/cost-profit/route.ts:540`、`:764`、`:879`。 |
| 通常仕訳・Stripe 仕訳 | `CostProfitSection` は普通の収入の仕訳と `buildStripeJournal` を統合。Stripe charge がある注文は通常経路から除外。`src/components/CostProfitSection.tsx:1901`、`:1944`、`:1957`。Stripe 売上は `stripe_created_at` の日付で `1130 / 4010`、成功返金は `succeeded_at` で `4020 / 1130`。`src/lib/finance/stripe-journal.ts:43`、`:73`、`:111`。 |
| 保存表 | 手入力取引等は `admin_finance_expenses / admin_finance_entry_revisions / admin_finance_receipts`、締めは `admin_finance_year_closings.closing_balances / closed_at`。Stripe 原始記録は `stripe_balance_transactions / stripe_refunds / stripe_payouts`。根拠: `src/app/api/admin/kpi/cost-profit/route.ts:726`、`:751`、`:780`、`migrations/089_stripe_accounting_settlement.sql:7`、`:33`。 |

G の出荷日を後で使う場所は、承認済み方針10章に従い **列挙だけ**する。ここで仕訳や按分方法を設計しない。

1. 売上変換: 支払い・部分発送・返金・返品受取の出来事、明細数量・価格・割引・端数、発送前控除後の売上額（`docs/01_Planning/revenue-recognition-policy.md:484`）。
2. 会計 API と画面: 前受金、出荷日の売上、注文年をまたぐ取得（同方針 `:485`）。
3. Stripe 仕訳: 支払い時の前受金、発送側の売上との二重計上防止、JST 日付（`:486`）。
4. 返品・返金: 届いた日、検品日、返金日、出荷前 / 後の違い、失敗時の未払金（`:487`）。
5. 発送記録: 実際の出荷日と修正履歴、部分発送ごとの日付、返品期限に使う日時との区別（`:488`）。
6. KPI: 「受注高」、発送済みも含む、取消・返品のマイナス日は返金日（`:490`）。
7. 年末在庫・原価・前受金との照合、締めた年の固定と修正記録、会計年度、帳簿保存（`:491`、`:492`、`:493`、`:494`）。

判断表も、会計は G・H の後としている（`docs/05_Quality/reviews/code/2026-10-22-decision-sheet.md:358`）。出荷日欄を増やしただけで現行会計が出荷基準になるわけではない。

## 8. 管理者の権限と監査

| 操作 | 現在の permission と根拠 |
| --- | --- |
| 注文一覧・履歴・要対応 | `admin.orders.read`。`src/app/api/admin/orders/route.ts:319`、`src/app/api/admin/orders/[id]/history/route.ts:182`、`src/app/api/admin/order-attention/route.ts:155`。 |
| 発送・仕上がり・未入金取消・配送訂正等 | `admin.orders.manage`。`src/app/api/admin/orders/[id]/fulfillments/route.ts:45`、`src/app/api/admin/orders/[id]/completions/route.ts:38`、`src/app/api/admin/orders/[id]/status/route.ts:92`。 |
| 返金・支払い済みの全取消 | `admin.orders.refund`、全取消は manage も。`src/app/api/admin/orders/[id]/refund/route.ts:53`、`src/app/api/admin/orders/[id]/status/route.ts:216`。 |
| 返品作成・承認・受取等 | `admin.orders.return`、返金額を決める操作は追加で `admin.orders.refund`。`src/app/api/admin/orders/[id]/returns/route.ts:73`、`src/lib/orders/returns/return-route-support.ts:243`。 |
| 在庫 | 読取 `admin.items.read`、増減 `admin.items.manage`。`src/app/api/admin/items/[id]/variants/route.ts:84`、`:206`。 |
| 会計証憑 | 閲覧 `admin.finance.read`、添付 `admin.finance.manage`。`src/app/api/admin/kpi/cost-profit/receipt/route.ts:27`、`:69`。 |

役割は `admin / supporter / user`。role ごとの既存マップでは admin が在庫・会計・返金を含み、supporter は注文 read/manage/return 等で、返金・在庫・会計は含まない（`src/lib/auth/admin-rbac.ts:5`、`:44`、`:69`）。ただし **実際の許可はマップだけで決めず**、`user_roles → roles → role_permissions → permissions` の DB ACL を取得し、active session と `aal2` を確認する（同ファイル `:43`、`:102`、`:174`、`:206`、`:217`）。

G 専用の発注・受取・割当入替・発送票 permission は現在の `PermissionCode` にない（`src/lib/auth/admin-rbac.ts:7`）。既存コードを新画面へ接続する時も、返金を supporter へ広げず、在庫操作や添付にどの権限を与えるかは新規の決定事項になる。画面を隠すだけでは API の許可にならない。

更新 API の既存順序は認可 → CSRF → 回数制限 → 検証 → RPC → 監査。発送は `admin.orders.fulfillment.create`、仕上がりは `admin.orders.completion.record`、在庫は `admin.items.stock.move`、証憑は `admin.finance.receipt.attach`（`src/app/api/admin/orders/[id]/fulfillments/route.ts:76`、`:81`、`:97`、`src/app/api/admin/orders/[id]/completions/route.ts:59`、`src/app/api/admin/items/[id]/variants/route.ts:286`、`src/app/api/admin/kpi/cost-profit/receipt/route.ts:143`）。

`logAudit` は実行者、対象、成否、説明、IP、user agent、metadata を保存し、機密に見えるキーやトークンをマスクする（`src/lib/audit.ts:3`、`:17`、`:45`）。業務の変更履歴は audit だけに寄せず、注文の `order_revisions`、発送・配送の追記表、返品の受取台帳もある。注文 RPC は `app.order_actor_id / app.order_change_reason` を設定して原本の変更履歴へつなぐ（`supabase/migrations/20261021221140_delivery_tracking_admin.sql:414`、`migrations/081_online_order_legal_archive.sql:173`）。G の出荷日訂正は「誰・いつ・変更前後」を業務記録として追えるものが必要で、現行の出荷日訂正専用の記録は見つからない。

## 9. 既存試験と、固定していること

すべて **試験コードを読んだ結果**。今回は実行していない。下表の「固定」は期待値の意味で、現在の GREEN、実 DB・実送信の成功を意味しない。

### 単体試験

| ファイル・位置 | 固定していること／G との関係 |
| --- | --- |
| `tests/unit/api/admin/orders-search-route.test.ts:196`、`:343` | 検索条件、住所不足の発送不可、DB status フィルタと既定の abandoned 除外。明細単位一覧への変更対象。 |
| `tests/unit/components/AdminOrderHistoryWiring.test.tsx:240`、`:290`、`:774`、`:803` | 一覧から dialog、発送後の再取得、paid だけの CSV、11列と準備数。Q8 と J-01 で書換対象。 |
| `tests/unit/components/OrderSection.actions.test.tsx:56`、`:81` | 一覧の取消・発送のボタンと不可理由。詳細頁へ移す対象。 |
| `tests/unit/components/OrderShipDialog.test.tsx:89`、`:120` | 準備数の初期値、受注生産は初期発送数に含めない、仕上がった分を送る。荷作り表へ置換対象。 |
| `tests/unit/components/OrderCompletionDialog.test.tsx:76`、`:144` | 未仕上がりの商品、数量範囲、request key で手動記録。手動仕上がり廃止に対応。 |
| `tests/unit/api/admin/order-completion-routes.test.ts:98`、`:144` | 権限・CSRF・回数制限、completion RPC、監査。手動記録はメールを送らない。 |
| `tests/unit/api/admin/order-fulfillment-routes.test.ts:129`、`:240` | 守りの順序、発送記録・監査・メール起動。部分発送の守りは残す対象。 |
| `tests/unit/api/admin/item-variants-route.test.ts:175`、`:503`、`:583` | 4つの在庫数、台帳追記、在庫不足409。在庫の意味と FIFO の追加で見直す。 |
| `tests/unit/components/ItemStockSection.test.tsx:84`、`:242` | 4つの数と履歴、読み直せない時のエラー。 |
| `tests/unit/lib/orders/order-progress.test.ts:141`、`:181`、`:233` | 全発送配達済み、未仕上がり・準備数の優先、客向け4/5段。管理と客の区別が必要。 |
| `tests/unit/lib/orders/customer-order-view.test.ts:107`、`:147` | E-5 と会員画面の共通投影。「公開の答えに個人情報のキーを持たない」、配送の旧版・取消・登録前・鍵なしを隠す。公開範囲の回帰対象。 |
| `tests/unit/components/OrderHistoryDialog.test.tsx:140`、`tests/unit/components/AdminOrderHistoryWiring.test.tsx:1227` | 履歴から再送・取消、手動配達済み後の履歴・一覧・要対応再取得。発送票へ移す対象。 |
| `tests/unit/api/admin/order-refund-route.test.ts:241`、`tests/unit/api/admin/order-return-review-routes.test.ts:254`、`tests/unit/api/admin/cancel-request-routes.test.ts:234` | 返金・返品申請審査・キャンセル申請 API の権限確認が先、CSRF、回数制限。入口を変えても守りは回帰対象。 |
| `tests/unit/lib/orders/returns/return-photo-storage.test.ts:182`、`tests/unit/api/admin/receipt-route.test.ts:77`、`tests/unit/lib/legal-archive/storage.test.ts:22` | 写真の上書き不可の署名、会計添付成功後に CSRF cookie を付けられなくても成功を保つこと、全保存先を検証してから確定すること。G の原本保持の証明をこれらだけで代替しない。 |

### DB 結合試験

| ファイル・位置 | 固定していること |
| --- | --- |
| `tests/integration/db/order_fulfillments.integration.test.ts:93`、`:202`、`:231`、`:314`、`:395`、`:472` | 読書権限・追記と取消制限、`shipped ≤ completed ≤ quantity`、手動仕上がり、在庫4数、旧発送の移行。G で消す契約と残す契約の切り分けが必要。 |
| `tests/integration/db/fulfillment_postgrest.integration.test.ts:118`、`:182`、`:226`、`:301` | RPC の公開形、再送、部分発送、複数注文の数量、取消。 |
| `tests/integration/db/fulfillment_order_emails.integration.test.ts:169`、`:198`、`:223` | 部分発送は paid、全発送は shipped、発送ごとの outbox と重複防止。 |
| `tests/integration/db/stock_movements.integration.test.ts:44`、`:84`、`:124`、`:170` | 入出庫、在庫負数拒否、UPDATE / DELETE / TRUNCATE 拒否。 |
| `tests/integration/db/order_refund_results.integration.test.ts:337`、`:367`、`:411`、`:425`、`:442` | 返金の戻す / 戻さない、backorder は台帳を動かさない、発送後は返品で戻す、一度だけ処理。 |
| `tests/integration/db/order_return_records.integration.test.ts:239`、`:286`、`:315` | 返品表・設定の権限、admin/supporter への return 権限、RPC 専用書込。 |
| `tests/integration/db/order_return_actions.integration.test.ts:659`、`:749` | 返品作成の数量、状態、outbox、同じ入力の再送。 |
| `tests/integration/db/order_return_receipts.integration.test.ts:134`、`:169`、`:188`、`:193` | 部分受取・検品・終了、二重受取防止、交換の再送、サポートから店長への返金相談。 |
| `tests/integration/db/order_return_request_reviews.integration.test.ts:256` | 複数行の承認を一括にし、一行でも無効なら全体を変えない。 |
| `tests/integration/db/refund_postgrest.integration.test.ts:201`、`tests/integration/db/return_postgrest.integration.test.ts:350`、`tests/integration/db/order_return_customer_requests.integration.test.ts:434`、`:563` | 返金の再送・行の額と戻し方、返品設定の JSON キー、顧客申請の材料のキーと5つの品物状態。 |

### E2E

| ファイル・位置 | 固定していること／移設対象 |
| --- | --- |
| `e2e/FR-ADMIN-060-order-attention-inbox.spec.ts:141` | 要対応・要確認、件数、解決、読込失敗時の表示。 |
| `e2e/FR-ADMIN-068-partial-fulfillment.spec.ts:146`、`:168`、`:291` | 発送 dialog、部分→全発送、数量超過・同キー違いの拒否・同時発送。荷作り表へ UI 書換。 |
| `e2e/FR-ADMIN-069-made-to-order-completion.spec.ts:212`、`:246`、`:278` | 手動仕上がり、発送画面内の記録、取消。廃止対象の契約。 |
| `e2e/FR-ADMIN-070-order-progress-labels.spec.ts:111`、`:152`、`:190` | 管理と客の進み具合、DB status の絞込。管理側は品物状態へ置換。 |
| `e2e/FR-ADMIN-071-fulfillment-shipping-email.spec.ts:35`、`e2e/FR-ADMIN-072-fulfillment-cancel.spec.ts:154` | 発送ごとのメール、通知オフ、履歴からの取消。Mailpit / DB を使うケースを含むが今回未実行。 |
| `e2e/FR-ADMIN-073-inventory-states.spec.ts:100`、`:152` | 在庫4数と実行者・注文・残高の履歴、DB 集計。 |
| `e2e/FR-ADMIN-088-return-exchange.spec.ts:345`、`:392`、`:478` | stock 交換の確保、make 交換の手動仕上がり、手数料待ち。FIFO 変更の回帰範囲。 |
| `e2e/FR-ADMIN-091-order-list-returns.spec.ts:154`、`:178`、`:300` | 一覧の返品列・次操作・CSV。詳細頁と新一覧への移設対象。 |
| `e2e/FR-ADMIN-097-cancel-requests.spec.ts:40`、`:103` | キャンセル申請から未入金取消 / 全取消 / 部分返金の画面を開き分ける。 |
| `e2e/FR-ADMIN-100-fulfillment-tracking-edit.spec.ts:81`、`e2e/FR-ADMIN-101-fulfillment-delivered.spec.ts:55` | 追跡オフで伝票訂正、手動配達済み・メール・返品期限。発送票へ UI 移設。 |
| `e2e/FR-ORDER-001-public-view.spec.ts:1`、`e2e/FR-ORDER-008-delivery-refund-visibility.spec.ts:1`、`e2e/FR-ORDER-010-keep-display-on-return.spec.ts:38` | E-5 の公開表示・配送返金の見せ方・戻った時の表示維持。G で客の言葉を変えないための回帰範囲。 |

既存試験があることは G の FIFO、発注数量確定、発注受取、発送票による一括発送、出荷日訂正を確認済みという意味ではない。対応する現行機能・試験は見つからない。

## 10. 現在の採番と規模の目印

| 項目 | 調査時の最大値・根拠 |
| --- | --- |
| 最新の Supabase migration | ファイル名順の最後は `supabase/migrations/20261023082752_retire_unattached_checkout_draft.sql:1`。本番適用済みかは未確認。 |
| 要求番号 | `FREQ-518`。「決済の画面を作れなかった時は、すぐに押し直して作り直せる」。`docs/02_Requirements/requirements.md:1702`。 |
| ADMIN の E2E 番号 | `FR-ADMIN-108`、`e2e/FR-ADMIN-108-select-fields.spec.ts:70`。 |
| ORDER の E2E 番号 | `FR-ORDER-010`、`e2e/FR-ORDER-010-keep-display-on-return.spec.ts:38`。 |

最大番号は対象ディレクトリを読み取って算出し、E2E はファイル名と `e2e/`・`docs/` 内の参照も照合した。既存には同じ ADMIN 番号の別ファイルもあるので、最大番号と試験本数は違う。新しい番号の予約はしていない。

未確定・未確認: 稼働 DB の旧注文件数・NULL variant の数・既存 completion と確保数の実分布、各 migration の適用状況、稼働 Storage の保持設定、17TRACK の実稼働設定、試験の成否、電子帳簿保存の実運用。すべて今回の禁止範囲か、コードだけでは判断できない内容。

## G の提案と今のコードの差

### Q1〜Q8

| 決定 | あるもの | 足す・変える・取り除くもの | 主なリスク・設計で残る確認 |
| --- | --- | --- | --- |
| Q1 品物ごとの合計・返金額。合算して合う（提案 `docs/superpowers/specs/2026-10-23-group-g-proposal.md:282`） | `order_items.item_price / line_total`、返金明細の amount、割引の累積丸め（`migrations/025_create_orders.sql:50`、`supabase/migrations/20261011222930_order_refund_records.sql:79`、`supabase/migrations/20261013001143_order_return_receipts.sql:23`） | 注文明細×状態数量の表示金額、返金額、単価を一覧 DTO / CSV に追加。注文全体の合計・返金額を行ごとに複製する今の CSV を置換。 | 送料・調整額は返金ヘッダーにあり、明細 amount の和だけでは一致しない場合がある。割引端数、手動調整、旧返金、0円交換、状態で分けた行の合計をどう整合させるかは別途必要（`supabase/migrations/20261011222930_order_refund_records.sql:39`）。 |
| Q2 手動仕上がり廃止、在庫から FIFO、自動割当、詳細で入替、全部 / 一部の受取（提案 `:283`） | completion、確保計算、台帳、注文行ロック（本資料2・3章） | 手動記録 UI / API の入口と completion 依存を置換。受取と在庫増加・割当を接続。割当入替と履歴が新規。 | 既存 stock は注文時に減算済み、backorder の仕上がりは入庫ではない。旧データをそのまま新在庫へ数えると不足・二重在庫になる。複数 variant・注文の FIFO、同時入荷・決済・返金・取消・入替で二重割当しない境界が必要。 |
| Q3 発注先とメモ、納期なし、数量は空欄開始（提案 `:284`） | 商品 variant、会計の取引先名マスターのみ（本資料3章） | 発注ヘッダー・明細・番号、複数行入力→確認→確定の画面、発注先・メモ。納期は足さない。 | 古い G-3 の納期・状態案を確定要件として実装しない。発注先マスターとの関係や発注先変更履歴はまだない。 |
| Q4 数量確定、増減、単価、残数打切りの数と理由、見積 / 請求書原本（提案 `:285`） | 会計証憑、法定の写し、訂正履歴の部品（本資料6章） | 仮数量と確定数量、数量確定操作、単価、受取累積、打切り累積、訂正履歴、発注書添付と検索項目。 | 受取済みより少なく確定する場合、確定前の受取、確定前の「発注済み」の数え方、再確定・過納の扱いは詳細設計で確認が残る。「消せない」は写真の削除機能や会計証憑の FOR ALL をそのまま持ち込めない。 |
| Q5 荷物の記録は「発送票」、発送→発送票確認→発送確定（提案 `:286`） | 注文ごとの fulfillment と行（本資料2章） | 複数注文を束ねる荷物の保存単位と画面、票番号・明細、票から各注文発送への接続。 | 現在の `order_fulfillments.order_id` は1注文。1行を複数注文に流用はできない。確認中に他操作で準備数が減った場合の再検証が必要。 |
| Q6 会員は ID、ゲストは email、さらに同じ送り先だけ（提案 `:287`） | `orders.user_id` と配送先スナップショット（本資料1章） | サーバー側で同梱候補と確定時の本人・住所を検証。一覧 DTO に足りない ID・建物等を補う。 | 4-4 の下書きには会員とゲスト混在時の email 比較があるが、最新 Q6 と依頼文から混在を自動許可できるとは断定しない。表記差の正規化、連絡先変更、別住所・同姓同名を名前だけでまとめない。 |
| Q7 出荷日は今日が初期値、過去可・未来不可、直した人と時刻、売上の日（提案 `:288`） | 発送時刻は `now()`、配送出来事・訂正履歴の仕組み（本資料2・8章） | 発送票確認の出荷日、保存契約、訂正履歴。部分発送ごとの会計入力として後へ渡す。 | 返品期限の日時・17TRACK の期限・delivered_at の制約と混同しない。締めた年への訂正は会計方針と接続。会計実装自体は後続（本資料7章）。 |
| Q8 操作は注文詳細へ。発送は荷作り、発送票の直しは票へ（提案 `:289`） | 一覧 dialog と集約した履歴、権限ごとの操作（本資料1・4・8章） | 注文詳細頁、新一覧の行リンク、返金・取消・返品・割当入替を移設。詳細から票を開く。伝票訂正・取消・配達済みは票へ。 | 履歴は残し、未解決の例外・申請の入口を失わせない。supporter に返金権限を渡さない。既存 UI 試験の多くはボタン位置に依存。 |

この表の「提案 `:nnn`」は、各行で示した `docs/superpowers/specs/2026-10-23-group-g-proposal.md` の行番号。

### 4つの表と注文詳細

| G の表 | 現在 | 変える内容・根拠 | リスク |
| --- | --- | --- | --- |
| 注文一覧表 | 1注文1行、商品はまとめた文字列。CSV は11列・paid・表示中頁の取得分。 | 品物×ステータス数量で行を分け、共通欄を全部埋める。商品名・色・サイズ、数量、単価、行金額・返金、状態を出す。提案の列と例: `docs/superpowers/specs/2026-10-23-group-g-proposal.md:36`、`:53`。現在: `src/app/admin/page.tsx:139`、`:1013`。 | 注文数と表示行数、検索・ページング、CSV 全件範囲、PII、行分割の数量・金額の総和。 |
| 在庫一覧表 | 商品別の編集画面だけ。すぐ出せる / 引当 / 手元 / 受注生産。 | 商品×色×サイズで、注文数＝受注生産中＋準備中、在庫＝割当済みを含む手元、発注済み＝未納合計、必要数＝`max(注文数−在庫−発注済み,0)`。発注開始。決定の元: `docs/superpowers/specs/2026-10-23-group-g-proposal.md:147`。現行: `src/app/api/admin/items/[id]/variants/route.ts:160`。 | 現行 backorder 集計は未入金も含み、G の2状態の合計と一致しない。既存台帳残高の意味を変える移行が大きい。 |
| 発注一覧表 | 専用の表・API・画面は見つからない。 | 発注書品物ごとに番号・商品 variant・発注数量・納品済み・未納。数量確定と打切り、全部 / 一部受取、在庫と FIFO の一括更新。`docs/superpowers/specs/2026-10-23-group-g-proposal.md:180`、`:283`、`:285`。 | 二重受取、確定数量の変更と未納、過納・打切りの整合、添付原本の保持。 |
| 荷作り表 | paid 注文の発送 dialog と、CSV に準備数だけ出す仕組み。 | 準備中の品だけを並べ、行・数量を発送票へ足す。別注文・別の日も同じお客様＋住所で束ね、確認→確定で各注文に発送とメール。`docs/superpowers/specs/2026-10-23-group-g-proposal.md:201`、`:213`、`:223`。 | 一部注文だけ成功する状態、同一行の二重選択、同梱条件、通知・追跡登録の単位、取消を票単位にそろえること。 |
| 注文詳細 | 同頁内の各 dialog。 | 情報・支払い返金・品物状態・履歴をまとめ、Q8 の操作と発送票リンク。`docs/superpowers/specs/2026-10-23-group-g-proposal.md:70`、`:289`。 | データ取得の権限と公開範囲、操作直後の再取得、履歴の欠落・誤った旧状態表示。 |

### 12ステータスとの対応

下表の状態名と意味の正は `docs/superpowers/specs/2026-10-23-group-g-proposal.md:85`。DB の注文 enum は維持し、記録から表示を作る決定（同提案 `:137`）。現在は12状態を統合した保存列・計算器はない。数量が違う状態に分かれたら同じ明細でも別表示行にする。

| G の状態 | 今の材料 | 足す・変える点／リスク |
| --- | --- | --- |
| 未払い | `pending` → `unpaid`（`src/lib/orders/order-progress.ts:53`）。 | 言葉を管理向けに変更し、品物行全部へ展開。未払いの確保と支払い後割当を混同しない。 |
| 支払い期限切れ | `failed`、`stripe_voucher_expired` の履歴（`src/lib/stripe/checkout-payment-reconciler.ts:161`）。 | failed は現在「決済失敗」。期限切れ専用の品物状態ではない。期限根拠と遅延入金、確保解放を正しく判別。 |
| 受注生産中 | backorder の `in_production`、paid の判定（`supabase/migrations/20261011222930_order_refund_records.sql:401`）。 | completion 不足から、支払い済みかつ未割当へ変更。古い未仕上がり、NULL variant、交換の make も対象。 |
| 発送準備中 | `ready_unshipped`（同 SQL `:402`）。 | 支払い済みかつ割当済みの数へ変更。棚卸減・割当入替で戻す経路が新規。手数料待ち交換を発送候補へ混ぜない。 |
| 発送済み | 取消でない発送明細合計（同 SQL `:358`）。 | 配達・返品状態に移った数量を二重表示しない。G は管理で「発送済み」、客は「配送中」のまま。 |
| 配達済み | 発送ごとの delivered_at と明細（`supabase/migrations/20261021221140_delivery_tracking_admin.sql:787`）。 | 票単位で全部へ反映し、品物ごとの配達数量へ変換。現在の注文全体 progress をそのまま使わない。 |
| キャンセル申請中 | `order_cancel_requests.requested` と行の数量（`supabase/migrations/20261020144439_order_return_request_records.sql:65`、`:92`）。 | 注文全体の cancel_pending＝全品返金の手続き中とは別。申請数量だけを元の段階から分け、却下時に割当実態へ戻す。 |
| キャンセル済み | 注文 cancelled、発送前返金数量 `rb`（`src/lib/orders/order-payment-types.ts:6`、`supabase/migrations/20261011222930_order_refund_records.sql:374`）。 | 未払い取消・品物の一部取消・返金待ち・返金失敗を区別。戻した在庫を次の注文へ再割当。全額返金が発送後の場合を一律「発送前取消」としない。 |
| 返品申請中 | `order_returns.requested`、requested 数（`supabase/migrations/20261012235910_order_return_records.sql:26`、`:962`）。 | 品物・発送単位の数量で分ける。却下時の配送状態を反映し、元の発送済みと同じ数を二重表示しない。 |
| 返品受付中 | `open` と `open_unprocessed`、検品待ち等（同 SQL `:963`、`src/lib/orders/returns/return-types.ts:78`）。 | 現在の「返品中」を G の語へ。部分受取・検品・未着終了・お返しの数量と優先順位が必要。 |
| 返金待ち | `refund_waiting`、サポートの consult（同 SQL `:964`、`tests/integration/db/order_return_receipts.integration.test.ts:193`）。 | 「店長が額を決める待ち」と Stripe pending / awaiting_response を混ぜない。返金失敗・再試行の時も他状態と重ならない数え方が必要。 |
| 返品済み | 返品の returned、交換数量・返金の覆い（`supabase/migrations/20261013000456_order_return_actions.sql:1521`、`src/lib/orders/returns/return-types.ts:78`）。 | 交換元を完了させても交換品は別行で生産 / 準備 / 発送する。返金不要・未着・手数料待ちも現行にあり、12状態との関係を欠落させない。 |

決済手続き中・放棄を管理の新一覧に出さない点も明示して変える。提案 `docs/superpowers/specs/2026-10-23-group-g-proposal.md:102` と、現在の管理 API の除外 `src/app/api/admin/orders/route.ts:428` は同じではない。

### 横断するリスク

1. **既存注文と台帳の移行**。既に差し引いた stock、手動で完成した backorder、旧発送から作った legacy completion、返金の確保解除と不足、交換行、variant が NULL / 停止済みの明細が混在できる。原本明細は不変 trigger がある。DB の分布は読んでいないため、実件数・移行差分は未確定（本資料1〜4・6章）。
2. **FIFO の同時実行**。現行は注文をロックしてから variant を ID 順でロックする処理を持つ（`supabase/migrations/20261011222930_order_refund_records.sql:617`、`:631`）。G は同一 variant から複数注文へ割り当てるので、単一注文ロックだけでは不足。既存の返金・返品・支払い・入替・発送とロック順が逆転すると待ちや二重処理の原因になる。FIFO の同時刻順、未払いの扱い、優先入替と次の自動割当の関係は詳細契約が必要。
3. **添付の電子取引保存**。原本保持、訂正前後と理由、取引日・金額・取引先の検索、DB と Storage の片方だけ成功する場合の処理、削除権限と保持期間は別々に確認する。既存の非公開 bucket・署名 URL・upsert false だけで保存要件が満たせたとはしない（本資料6章）。
4. **発送票の一括性と追跡**。各注文の fulfillment、メール outbox、在庫減算をそろえ、発送票の伝票訂正・取消・手動配達済みを全部へ反映する必要がある。同じ番号を扱う E-4 の守りはあるが、発送票を中心に1回登録する契約は未実装（本資料2章）。
5. **後続会計と状態の守り**。日付訂正と締めた年、出荷日と返品期限を混同しない。状態を制限する SQL は J-19 で「G の状態にも合わせてから」当てる決定であり、資料にある未適用 SQL を現在の DB 保証とは扱わない（`docs/05_Quality/reviews/code/2026-10-22-decision-sheet.md:394`）。

以下の size は実装量の相対的な見立て。小＝既存部品の移設中心、中＝画面・API の追加、大＝DB・複数経路・旧データの変更。工数・新規ファイル数・migration 本数の見積りではない。根拠は各章の既存経路と上の差分。

| area | existing | to build | risk | size |
| --- | --- | --- | --- | --- |
| 注文一覧・CSV | 注文単位一覧、検索、11列 CSV、3段階の明細数量 | 品物×状態の行、単価・行金額・返金、列と CSV、件数・ページング | 数量と金額の和、旧返金、交換、非表示状態 | 大 |
| 注文詳細 | 個別 dialog、統合履歴、要対応と申請の入口 | 詳細頁、操作の移設、発送票へのリンク | 権限・履歴・未解決案件の入口 | 中 |
| 在庫・割当 | variant、追記台帳、4つの数、手動 completion | 手元在庫の意味変更、FIFO、割当入替、手動仕上がり廃止 | 既存注文の移行、競合、負数・二重確保 | 大 |
| 発注・数量確定・受取 | 商品 variant と会計の取引先名 | 発注書・明細・番号、仮→確定、単価、打切り、複数回受取、一覧 | 二重受取、確定数と未納、在庫との一括性 | 大 |
| 見積・請求書添付 | 会計証憑、訂正履歴、法定の写し | 発注との関連、検索項目、原本保持、訂正と保持契約 | 電子取引保存、削除権限、DB / Storage の不一致 | 大 |
| 荷作り・発送票 | 単一注文の部分発送、メール outbox | 同梱候補、選択・確認・確定、複数注文の発送、票単位の直し | 本人・住所の一致、同時発送、全部かゼロか | 大 |
| 配送追跡 | E-4 の版・出来事・手動配達済み・同番号の守り | 発送票への操作移設、登録1回と全注文反映 | 旧版、取消、共有番号の停止、設定オフ | 中〜大 |
| 出荷日・後続会計 | now() の発送時刻、注文日 / Stripe 日時の会計 | 過去可・未来不可の出荷日、訂正履歴、後続へ渡す記録 | 返品期限、締めた年、部分発送と二重計上 | G は中、後続会計は大 |
| 権限・監査・試験 | DB ACL、MFA、CSRF、audit、単体 / DB / E2E 群 | 新操作の権限、履歴、旧 UI 試験の移設と新契約の試験 | supporter の返金権限、未実行範囲の誤認 | 中〜大 |
