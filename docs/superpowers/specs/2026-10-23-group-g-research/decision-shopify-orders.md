# Shopify / Stripe 突き合わせ調査（注文まわりの未決事項 10 件）

調査日: 2026-10-22
対象: 自前の EC（Next.js + Supabase + Stripe）。Shopify の動きを手本にしたい論点。

## 読み方の注意

- 英語の画面ラベル・項目名は公式のまま引用符で残した。
- 「出典が見つからない」は、公式ヘルプ・公式 API 文書・Stripe 文書を探して書いてなかったという意味。推測では埋めていない。
- 第三者（アプリ会社やブログ）の記述は「第三者」と明記した。公式ではないので裏取りが要る。
- 「提案」と書いた部分は調査者の意見で、出典はない。決める材料としてだけ使うこと。
- Shopify の管理画面は頻繁に変わる。ヘルプの古い記事と新しい記事で名前が食い違う箇所がある（話題 8 に例）。

---

## 話題 1: 注文 CSV の数量と明細の持ち方（返金・削除・一部発送・交換）

### Shopify の動き

- 注文エクスポート CSV は「明細 1 行 = 1 行」。2 行目以降の明細は、注文の共通項目の多くが空欄になる（同じ注文に属するという目印）。
  - 引用: orders with multiple line items display their additional line items on separate lines / Many of the fields are left blank
- 明細の列（公式）: "Lineitem quantity"（数量）、"Lineitem name"（名前）、"Lineitem price"、"Lineitem compare-at price"、"Lineitem SKU"、"Lineitem requires shipping"、"Lineitem taxable"、"Lineitem fulfillment status"（その明細が発送済みか）、"Lineitem discount"。
- 注文単位の列（公式）: "Refunded Amount"（注文に適用された返金額＝金額だけ）、"Financial Status"、"Fulfillment Status"、"Canceled at"、"Payment References"。
- 返金・削除された「数量」を入れる列は公式の列一覧にない（Refunded Amount は金額のみ、Lineitem quantity は返金・削除に触れていない）。
- 公式文書は、編集・返金で明細が減った場合の CSV の見え方を書いていない。エクスポートは「注文を作った時点の履歴データ」を出す、という説明があるだけ（商品情報について）。
- 第三者（アプリ会社 Highview Apps）の記述: 注文編集で商品を消したり数量を減らしたりしても、Shopify の標準 CSV には元の数量が残る。合計額（total_price）も直らない。裏側では「返金扱い」で処理されるが、お金が動かないので支払い状況は「一部返金」にならない。API でも「編集による削除」と「本当の返金」は区別できない、と主張している。公式で確認できていない。
- API（公式）では 2 つの数量が分かれている:
  - `quantity`: "The number of units ordered, including refunded and removed units."（返金・削除分を含む）
  - `currentQuantity`: "The number of units ordered, excluding refunded and removed units."（含まない）
  - `unfulfilledQuantity`: "The number of units not yet fulfilled."
  - `nonFulfillableQuantity`: "The total number of units that can't be fulfilled."
- 一部発送: 明細ごとに "Lineitem fulfillment status"、注文ごとに "Fulfillment Status"（表示は "Partially fulfilled" など。話題 8）で持つ。
- 交換: CSV でどう出るかは出典が見つからない。API 側は、返品を作るときの `exchangeLineItems`（variantId と quantity）で交換品を渡す。交換品の売上記録が作られ、交換品の発送指示は `ON_HOLD`（理由 `AWAITING_RETURN_ITEMS`）で止まる。返品を取り消しても交換品の売上・発送は取り消されない。交換品が元の注文の明細に入るか別注文になるかは、文書に明記なし（出典が見つからない）。
- 分析（Analytics）の数量の定義（ShopifyQL の公式スキーマ）:
  - `quantity_ordered`: "The number of items ordered before returned or reversed quantities are taken out."（返品・取り消し前の数量）
  - `net_items_sold`: "The number of items sold after returned or reversed quantities are factored in."（返品・取り消し後の数量）
  - `quantity_returned`: "Number of items removed from orders." ただし 2026-10 から非推奨で、`reversed_quantity` に置き換わる。

### Stripe

該当なし（Stripe は注文明細を持たない）。

### 業界の定番（Shopify に無い部分）

出典が見つからない。Shopify 自身が「元の数量」と「今の数量」を別フィールドで持つ作り（上記 API）なので、これが事実上の手本。

### 出典

- https://help.shopify.com/en/manual/orders/manage-orders/exporting-orders
- https://help.shopify.com/en/manual/orders/export-orders
- https://shopify.dev/docs/api/admin-graphql/latest/objects/LineItem
- https://shopify.dev/docs/api/shopifyql/latest/schemas/sales_revenue/sales
- https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/build-return-management
- https://shopify.dev/docs/api/admin-graphql/latest/enums/FulfillmentHoldReason
- 第三者: https://www.highviewapps.com/kb/why-is-the-exported-data-still-showing-the-original-values-after-editing-an-order-and-removing-a-line-item-or-decreasing-the-quantity/
- 第三者: https://www.highviewapps.com/kb/how-can-i-export-the-line-items-that-were-removed-or-fully-refunded-from-a-shopify-order/

---

## 話題 2: 保留（hold）の解除・発送の取り消しができないとき、ボタンは隠すか、無効にして理由を出すか

### Shopify の動き

- 保留の操作（公式ヘルプ）:
  - 保留する: 注文の "Unfulfilled" または "In progress" 欄のメニューから "Mark as on hold"、"Hold reason" を選び、もう一度 "Mark as on hold"。
  - 追加: "On hold" 欄の "Add hold"（1 つの発送に手動保留は最大 10 件）。
  - 解除: "On hold" 欄の "Release hold"。保留が複数あるときは解除するものを選んで "Release"。保留がなくなると "Unfulfilled" か "In progress" に戻る。
- アプリ・サービスが付ける「システム保留」がある。上書きできるが、そのアプリとの契約に反する恐れがあると警告している。例: "Awaiting return items"（交換品に付く。返品を検品してから手で解除）、"Pending upsell offer"（1 時間または顧客が答えるまで）、"Unknown delivery date"。
- 「解除できない条件」は、ヘルプにも API 文書にも書いていない（出典が見つからない）。API の解除エラーコードは `FULFILLMENT_ORDER_NOT_FOUND`（見つからない）と `INVALID_ACCESS`（アプリに権限がない）の 2 つだけ。
- 発送の取り消し: 注文の "Fulfilled" 欄のメニューから "Cancel fulfillment"。止まる条件（公式）:
  - 配送ラベルを買っていたら、先にラベルを無効（void）にしないと取り消せない。
  - 発送サービス（fulfillment service）の処理がもう始まっていたら、管理画面で取り消しても止まらない。サービス側に連絡が要る。
  - Managed Markets の注文: "You can't cancel fulfillment for a Managed Markets order."
- 「隠す」か「無効で表示」かは、公式に明記がない（出典が見つからない）。手がかりが 1 つだけある。注文キャンセルについて、ヘルプは次のように書く: "If you don't have the Cancel order option, then you can't cancel the order."（「Cancel order の選択肢がなければ、その注文はキャンセルできない」）。つまり出せない時は選択肢そのものが出ない書き方で、理由は「注文の Timeline を見て」と案内している。部分発送済みの注文は "After an order is partially fulfilled, you can't cancel it." とだけ書く。
- 参考: Shopify の部品（App Home の Button）は `disabled` を持ち、「押せず、フォーカスも受けない」状態を作れる。使いどころは公式に「アプリの状態・権限・依存関係で一時的に使えない時」とある（POS 拡張の文書）。

### Stripe

該当なし。

### 業界の定番

- Smashing Magazine の整理: "As a rule of thumb, disable if you want the user to know a feature exists but is unavailable." / "Hide if the value shown is currently irrelevant and can't be used." 無効にするなら "explain why a feature is disabled and also how to re-enable it."（理由と、再び使えるようにする方法を示す）。これは業界記事で、公式の規格ではない。

### 出典

- https://help.shopify.com/en/manual/orders/fulfillment/fulfilling-orders/holds
- https://help.shopify.com/en/manual/fulfillment/fulfilling-orders/single-fulfillment
- https://help.shopify.com/en/manual/international/managed-markets/fulfillment
- https://help.shopify.com/en/manual/fulfillment/managing-orders/canceling-orders
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentOrderReleaseHold
- https://shopify.dev/docs/api/admin-graphql/latest/enums/FulfillmentOrderReleaseHoldUserErrorCode
- https://shopify.dev/docs/api/app-home/web-components/actions/button
- 業界記事: https://www.smashingmagazine.com/2024/05/hidden-vs-disabled-ux

---

## 話題 3: 失敗・保留中の返金の扱い、メモは必須か、注文タイムラインのメモ

### Shopify の動き

- 調べる場所（公式）: 注文を開き "Timeline" の返金の記録を見る。返金の状態・支払い方法・金額・エラー文が出る。あわせて Shopify Payments の残高と "Orders" ページの通知も確認する。
- 状態: Shopify Payments の返金は処理中 "Pending" と表示され、最長 2 営業日。顧客の銀行から入金されるまでは最長 10 営業日。"Failed" という別の状態ラベルは書かれていない。失敗は「返金しようとした時点のエラー」として出て、Timeline にエラー文が残る。
- 即時に失敗する原因（公式）: 返金額が元の金額を超える／返金できる期間を過ぎている／チャージバック（異議申し立て）が開いている／顧客の支払い手段や口座が受け取れない／決済会社がエラーを返した／OXXO 払い。
- Pending が続く原因（公式）: Shopify Payments の残高がマイナスのしきい値を超えている。解消後に作成順で処理される。
- 解決の手順（公式）:
  1. Timeline の返金詳細とエラー文を確認。
  2. 残高と通知を確認。
  3. 顧客の支払い手段が原因なら、顧客に銀行へ連絡してもらってからやり直す。
  4. Shopify の外で返金した場合: 注文の "Refund" を押し、金額を入れ、返金理由に「Shopify の外で処理した」と書き、支払いの返金のチェックを外す。
  5. 元の手段に戻せない場合は別の解決（ストアクレジットやギフトカード）を行い、注文の Timeline に記録する。
- メモは必須か: 失敗・保留の返金にメモの必須はない。「Shopify の外で返金した記録」のときだけ、"Reason for refund" に書くよう求めている。
- "Reason for refund" は店側とスタッフだけの内部メモ。顧客には見えず、「返品理由」にもならない。
- Shopify に 1 度出した返金は取り消せない（"You can't cancel or reverse it once initiated."）。
- 注文の Timeline のコメント（公式）: 注文・下書き注文・顧客・移動伝票で使える。"Leave a comment..." 欄に書いて "Post"。@ で名前を付けるとその人にメール。コメントはすべて内部用で顧客に見えない。編集は投稿後 5 分間だけ。削除は元に戻せない。
- API には、返金が「まだ決済会社に送られていない」状態 `DEFERRED` があり、"Displayed as Refund pending. Means that the refund has not yet been submitted to the payments processor." と説明されている（unstable 版の文書。安定版では確認できなかった）。
- 連絡先: 通常期間を過ぎても Pending で残高もマイナスでない／Timeline に説明のないエラー／処理済みなのに管理画面に出ない場合は Shopify サポートへ。その際に注文番号・金額・支払い方法・状態・エラー文を添える。

### Stripe

- 返金（Refund）の `status`: `pending` / `requires_action` / `succeeded` / `failed` / `canceled`。
- `pending_reason`: `processing` / `insufficient_funds` / `charge_pending`。
- `failure_reason`: `lost_or_stolen_card` / `expired_or_canceled_card` / `charge_for_pending_refund_disputed` / `insufficient_funds` / `declined` / `merchant_request` / `unknown`。
- 失敗したとき: 銀行がお金を Stripe に戻し、Stripe がそれを加盟店の Stripe 残高に戻す。この処理に最長 30 日かかることがある。`refund.failed` イベントで知らせる。文書は「別の方法で顧客に返金を手配する必要がある」と書く。
- 残高が足りないとき: カードの返金は保留（pending）で待ち、他の決済手段の返金は失敗する。
- コンビニ・銀行振込など返金を直接受けられない手段: 返金は `requires_action` になり、Stripe が顧客にメールして口座情報を集める。期限までに答えがなければ `failed`。
- Stripe ダッシュボードの返金では、理由を選ぶ欄があり、"その他" を選ぶとメモが必須。
- 返金のキャンセルは一部のカードの短い期間と、`requires_action` の間だけ可能。

### 業界の定番

出典が見つからない（Shopify と Stripe の文書でほぼ足りる）。

### 出典

- https://help.shopify.com/en/manual/payments/shopify-payments/refunds-troubleshooting
- https://help.shopify.com/en/manual/fulfillment/managing-orders/refunding-orders
- https://help.shopify.com/en/manual/shopify-admin/timeline
- https://help.shopify.com/en/manual/payments/shopify-payments/payouts/refunds
- https://shopify.dev/docs/api/admin-graphql/unstable/enums/orderdisplayrefundstatus
- https://docs.stripe.com/refunds
- https://docs.stripe.com/api/refunds/object

---

## 話題 4: 在庫の調整履歴（Inventory adjustment history）に何が出るか

### Shopify の動き

- 表の列（公式ヘルプ）: "Date"、"Activity"、"Created by"、"Unavailable"、"Committed"、"Available"、"On hand"、"Incoming"。
  - "Created by"（作った人）は "The staff member, app, or sales channel that made the adjustment."。列名は "Adjusted by" ではない。
  - 各数量のセルは「変化量が先、新しい合計が後」。ハイフンは「その状態に影響なし」。
- 保存期間: 商品・バリエーションごとに直近 180 日（2024-11 に 90 日から延長）。それより古い分は "Inventory adjustment changes" レポートで、SKU・場所・スタッフ・アプリ・理由で絞って見る。
- "Activity" の文字（公式）:
  - 手動・"Set to" 方式の理由と表示: Correction → "Inventory correction" / Count → "Inventory manually counted" / Received → "Inventory received" / Return restock → "Items restocked" / Damaged → "Damaged" / Theft or loss → "Theft or loss" / Promotion or donation → "Promotion or donation" / 理由なし → "Manually adjusted"。
  - 手動・"Adjust by" 方式: 動きを書く。例 "Moved to Safety stock"、"Moved from Quality control"。
  - システムが自動で作る: "Data correction" / "Transfer created" / "Removed from location" / "Reservation created" / "Reservation updated" / "Reservation deleted"。
  - 顧客が注文したとき、履歴は "Reservation created" のような自動の項目を出す、と書かれている。
- "Order edited"、"Returned" という文字の項目は、公式の一覧に見つからない（出典が見つからない）。返品の戻し入れは "Items restocked"。
- 注文・返金・返品への「リンク」: ヘルプは書いていない（出典が見つからない）。API では、在庫を変える側が `referenceDocumentUri`（"freeform URI that represents why the inventory change happened"）を付けられる。`gid://...` 形式で渡すと、調整履歴のポップアップに読みやすい題名で出る。それ以外の形式（URL など）は受け付けるが題名は付かない。
- API の理由（`reason`）の値: `correction` / `cycle_count_available` / `damaged` / `movement_created` / `movement_updated` / `movement_received` / `movement_canceled` / `other` / `promotion` / `quality_control` / `received` / `reservation_created` / `reservation_deleted` / `reservation_updated` / `restock` / `safety_stock` / `shrinkage`。

### Stripe

該当なし。

### 業界の定番

出典が見つからない。

### 出典

- https://help.shopify.com/en/manual/products/inventory/adjusting-inventory/adjustment-history
- https://help.shopify.com/en/manual/products/inventory/managing-inventory-quantities/adjustment-history
- https://changelog.shopify.com/posts/increase-inventory-adjustment-history-from-90-days-to-180-days
- https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps/manage-quantities-states

---

## 話題 5: キャンセル理由と Stripe の返金理由（reason）の対応

### Shopify の動き

- キャンセル画面: 注文の "More actions" → "Cancel order"。入力項目は "Refund payment"（"Original payment method" / "Store credit" / "Later"）、"Reason for cancellation"（ドロップダウン）、"Staff note"（任意の内部メモ）、"Restock inventory"（初期で選択済み）、"Send a notification to the customer"（初期で選択済み）、ボタン "Cancel order"。
- 理由の選択肢（Liquid 公式文書の値と表示名。ヘルプ本文は選択肢の一覧を載せていない）:
  - `customer`: "Customer changed/cancelled order"
  - `declined`: "Payment declined"
  - `fraud`: "Fraudulent order"
  - `inventory`: "Items unavailable"
  - `staff`: "Staff error"
  - `other`: "Other"
  - API の列挙型 `OrderCancelReason` の説明: CUSTOMER "The customer wanted to cancel the order." / DECLINED "Payment was declined." / FRAUD "The order was fraudulent." / INVENTORY "There was insufficient inventory." / OTHER "The order was canceled for an unlisted reason." / STAFF "Staff made an error."
  - Shopify Flow の "Cancel order" 操作では理由が必須で、初期値は "Customer changed/canceled order"。（つづりが文書により "canceled" と "cancelled" で揺れている。）
- 理由は必須（API で `reason` は必須）。"Staff note" は顧客に見えない（最大 255 文字）。
- 理由が顧客に見えるか: Liquid の `cancel_reason_label` は "A localized version of the cancellation reason, for display on the storefront." と説明されていて、店のメール・画面の雛形から表示できる作りになっている。標準の雛形が出すかは出典が見つからない。
- Shopify の理由が Stripe（Shopify Payments の裏側）の返金理由に渡されるか: 出典が見つからない。公式に書かれていない。
- 部分発送済みの注文はキャンセルできない（"After an order is partially fulfilled, you can't cancel it."）。先に発送を取り消すか、返金・返品で扱う。

### Stripe

- 返金作成の `reason`（任意）: `duplicate` / `fraudulent` / `requested_by_customer`。Stripe が自動で付ける `expired_uncaptured_charge` もある。省略すると `null`（API の応答例が `"reason": null`）。
- `fraudulent` を指定した影響（公式）: その決済に関連するカードのフィンガープリントとメールアドレスが、Radar の既定のブロックリストに入る。Stripe の不正検知の学習にも使われる。
- 公式の案内: 不正の疑いで返金するときは、必ず理由を指定する。理由は AI モデルが将来同じ例を見分けるために使われる。ダッシュボードなら返金時に「理由」で「不正」を選ぶ。
- `duplicate` と `requested_by_customer` について、ブロックリスト等の副作用は文書に書かれていない。「いつ指定し、いつ空にするか」を示す公式の文章は見つからない。公式から言えるのは「任意」「不正のときだけ明確な効果と推奨がある」までである。
- ダッシュボードの返金には理由を選ぶ欄があり、"その他" を選ぶとメモが必須。
- 自分用の理由コード（Shopify の 6 種類など）は、返金の `metadata`（任意のキーと値）に入れて残せる。

### 業界の定番

出典が見つからない（Shopify→Stripe の対応表は公式にない）。

### 提案（出典なし。決める材料）

| Shopify のキャンセル理由 | Stripe の `reason` 案 | 理由 |
| --- | --- | --- |
| Customer changed/canceled order | `requested_by_customer` | 意味が一致 |
| Fraudulent order | `fraudulent` | カードとメールがブロックリストに入る。実際に不正と確信したときだけ |
| Payment declined | なし | 払われていないので返金自体が無い |
| Items unavailable | 空（`null`） | Stripe の 3 値に合うものがない。誤った値を入れない |
| Staff error | 空（`null`） | 同上。二重請求の取り消しなら `duplicate` |
| Other | 空（`null`） | 同上 |

自分の理由は `metadata` と自前 DB に残す。`fraudulent` は取り消しにくい副作用（ブロック）があるため、間違って付けないよう画面で別扱いにするのが安全、というのが提案。

### 出典

- https://help.shopify.com/en/manual/fulfillment/managing-orders/canceling-orders
- https://shopify.dev/docs/api/liquid/objects/order
- https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderCancelReason
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCancel
- https://help.shopify.com/en/manual/shopify-flow/reference/actions/cancel-order
- https://docs.stripe.com/api/refunds/create
- https://docs.stripe.com/api/refunds/object
- https://docs.stripe.com/refunds
- https://docs.stripe.com/radar/lists
- https://docs.stripe.com/radar/transaction-risk-prevention

---

## 話題 6: 保留中（pending）の返金を顧客にどう見せるか

### Shopify の動き

- 顧客向け画面で「返金保留（Refund pending）」のような表示が出るかは、公式文書に書いていない（出典が見つからない）。
- 書いてあること:
  - 管理画面（店側）では返金が "Pending" と表示され最長 2 営業日。顧客の銀行から入金されるまで最長 10 営業日。
  - 顧客への通知は、返金が処理された時点で送る趣旨の記述がある（"the customer is notified only when the refund has processed"。返金回数の上限を超えた後の返金についての記述）。返金メールは通知名 "Order refund"（"Sent when an order is refunded"）。メール本文の文言は公式ヘルプに載っていない。
  - 注文状況ページ（Order status page）が顧客に出す配送状況は "Confirmed" / "On its way" / "Out for delivery" / "Delivered" / "Attempted delivery"。返金・キャンセル・返品の表示には触れていない。ログインしていない人には、買った商品・合計・割引・注文状況だけが出て、名前・住所・支払い手段などは隠れる。
  - 管理画面のラベル "Refunded"（全額返金）/ "Partially refunded"（一部返金）が顧客にそのまま見えるかも書かれていない。
- 第三者の事例: 店主向けの掲示板では、返金が Pending のとき注文ページに返金保留の表示がなく、Timeline の 1 行だけ、返金メールが送られないことがある、との報告がある。Shopify サポートの説明が人や時期でぶれている（即時に返る／次の入金で相殺／24〜48 時間）。顧客には「銀行に確認して」と案内するしかない、という運用になっている。

### Stripe

- 返金依頼は顧客の銀行・カード会社に送られ、顧客の明細に出るまで銀行により約 5〜10 営業日。
- 条件を満たすと Stripe が顧客に返金のお知らせメールを送る（元の支払いが顧客オブジェクトで作成／メールが保存済み／ダッシュボードの「顧客に返金のメールを送信する」が有効）。
- 顧客が問い合わせる時に渡せる番号: カードなら ARN・STAN・RRN。返金を始めてから ARN が取れるまで最長 7 営業日かかることがある。
- 返金の状態が pending のままでも、最終的に `failed` になる場合がある（話題 3）。その場合は顧客に別の方法で返す必要がある。

### 業界の定番

出典が見つからない（信頼できる一次情報なし）。提案: Shopify と Stripe の両方が「5〜10 営業日」と書いているので、顧客向けには「返金手続き中・反映まで目安 5〜10 営業日」と日数を添える表示が、少なくとも根拠のある言い方。

### 出典

- https://help.shopify.com/en/manual/payments/shopify-payments/payouts/refunds
- https://help.shopify.com/en/manual/payments/shopify-payments/refunds-troubleshooting
- https://help.shopify.com/en/manual/fulfillment/setup/notifications/customer-notifications
- https://help.shopify.com/en/manual/fulfillment/setup/order-status-page/understanding-order-status-pages
- https://docs.stripe.com/refunds
- 第三者（店主の掲示板）: https://community.shopify.com/t/why-is-my-issued-refund-still-showing-as-pending/14105

---

## 話題 7: 売上レポートで「入金後に全額返金したキャンセル注文」と「発送済み注文」はどう数えるか

### Shopify の動き（Sales レポート、公式ヘルプ）

- 売上が立つ日: "A sale is made when a customer places an order."（注文した日）。発送状況には触れていない。つまり発送前でも発送後でも、売上は注文日に立つ。
- 売上は「受け取ったお金」ではなく「売った商品の価値」で出す。
- キャンセル・保留・未払いも含まれる: "Pending, canceled, and unpaid orders are included."。含まれないのはテスト注文と削除された注文。
- 返金・返品・キャンセル・編集は、マイナスの値として「処理した日」に出る（注文日にさかのぼらない）。
- 定義（原文）:
  - "Gross sales": "Equates to product price x quantity (before taxes, shipping, discounts, and sales reversals) for a collection of sales."
  - "Discounts": "Equates to line item discount + order level discount share for a collection of sales."
  - "Sales reversals": "All order adjustments that result in negative monetary value."（返品された商品に加え、注文のキャンセル、編集、送料・税・手数料・割引の調整を含む）
  - "Returns": "The value of goods returned by a customer." 旧名で、"Sales reversals" に置き換え中。ShopifyQL でも `returns` は 2026-10 から非推奨、`sales_reversals` が後継。
  - "Net sales": "Equates to gross sales - discounts - sales reversals."
  - "Total sales": "Equates to gross sales - discounts - sales reversals + taxes + duties + shipping charges + fees."
- 入金後に全額返金したキャンセル注文の見え方: 注文日に "Gross sales" が立ち、返金の処理日に同額が "Sales reversals"（旧 "Returns"）としてマイナスで出る。期間を通せば "Net sales" は 0 に近づく。ただし注文日と返金日が別の期間なら、その期間ごとには売上とマイナスが別々に見える。返品された商品がない返金（お詫び返金など）もマイナスで出る、と明記されている。
- 送料は "Shipping" = 送料 − 送料割引 − 返金した送料。

### Stripe

該当なし（この話題で Stripe 文書は調べていない）。

### 業界の定番

出典が見つからない。

### 出典

- https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/sales-report
- https://shopify.dev/docs/api/shopifyql/latest/schemas/sales_revenue/sales

---

## 話題 8: 注文一覧の列名と、支払い状況・発送状況の言葉

### Shopify の動き

- 状況は 3 系統が別々の列・別々の言葉で並ぶ: 注文の状態（Order status）、支払い状況（Payment status）、発送状況（Fulfillment status）。返品があれば返品状況（Return status）も別。
- 注文の状態（公式 "Order status"）: "Open"（注文が入った）／"Archived"（手動または自動で保管）／"Canceled"（注文が取り消された。全額返金でなければ作業が残る場合あり）。
- 支払い状況 "Payment status"（公式の表。表中では "Payment pending" 状態を "Pending" と表記）:
  - "Pending": 注文はできたが入金が確定していない（カード以外で処理中、後払い条件、代引きなど）。
  - "Authorized": カード会社が支払い情報を確認し金額を押さえている。手動で回収する設定のときだけ出る。
  - "Due": "Pending" の注文が支払い期限までに回収されていない（今日期限と期限切れを含む）。
  - "Expiring": 状態ではなく、"Authorized" の回収期限の 2 日前に付く印。
  - "Expired": "Authorized" の注文が期限までに回収されなかった（代替決済会社が処理できなかった場合にも使う）。
  - "Paid": 回収済み、または支払い済みとして記録された。
  - "Partially paid": 注文額より少ない額を手動で回収した。
  - "Refunded": 払った全額を顧客に返した。
  - "Partially refunded": 払った額より少なく返した。
  - "Voided": 回収前に、押さえていた枠を解除した。キャンセルとは別で、注文が "Open" のまま支払いだけ "Voided" になり得る。
  - "Unpaid": "Authorized" / "Pending" / "Expired" / "Partially paid" をまとめた絞り込み用の束ね名。
- 発送状況 "Fulfillment status": "Unfulfilled"（新規）／"In progress"（準備中）／"On hold"（保留。在庫は確保されたまま発送不可）／"Scheduled"（定期購入の発送日待ち）／"Partially fulfilled"（一部だけ発送）／"Fulfilled"（全部発送）／"Fulfillment not required"（発送するものがない。キャンセル、発送前の全額返金、残りの商品を全部削除した場合）。
  - 注文一覧の札は "Not required"、注文詳細の状態は "Fulfillment not required" と表記が違う。
  - 保留と他の発送が混ざる場合: 保留 1 件＋未発送 1 件 → "Unfulfilled"／保留 1 件＋発送済み 1 件 → "On hold"／保留・発送済み・未発送が各 1 件 → "Partially fulfilled"。保留の注文は "Unfulfilled" の一覧に出ない。
- 返品状況 "Return status": "Return requested" / "Return in progress" / "Returned" / "Inspection complete"。返品がない注文は空。
- 注文一覧の列名（ヘルプの既定ビューの表）: "Order number"、"Order date"、"Customer name"、"Total price"、"Financial status"、"Fulfillment status"、"Fulfill by"、"Return status"、"Item count"、"Delivery method"、"Order tags"。
  - 注意: この表は支払いの列を "Financial status" と書き、新しい "Order status" 記事は "Payment status" と書く。同じものを指す（API の `displayFinancialStatus`＝"financial status for display in the Shopify admin"）。どちらの名前もヘルプに現れ、管理画面の現在の列見出しはヘルプからは断定できない。
  - 列は表示・非表示・並べ替えができる（"Order" 列だけ位置固定）。
- API の絞り込み値（参考）: 支払い `paid` `pending` `authorized` `partially_paid` `partially_refunded` `refunded` `voided` `expired`／発送 `unshipped` `shipped` `fulfilled` `partial` `scheduled` `on_hold` `unfulfilled` `request_declined`。
- 店の画面（Liquid）向けの発送ラベル値: `complete` `fulfilled` `partial` `restocked` `unfulfilled`。

### Stripe

該当なし（支払いの状態は `PaymentIntent` 等で別体系）。

### 業界の定番

出典が見つからない。Shopify の作りから言えるのは、支払い・発送・返品が別の語彙で別々の列になっていて、同じ語が両方に出ることは少ない（"Partially" という接頭辞だけ共通）、という点。

### 出典

- https://help.shopify.com/en/manual/fulfillment/managing-orders/order-status
- https://help.shopify.com/en/manual/fulfillment/managing-orders/viewing-orders/searching-orders
- https://help.shopify.com/en/manual/orders/fulfillment/fulfilling-orders/holds
- https://shopify.dev/docs/api/admin-graphql/latest/objects/Order
- https://shopify.dev/docs/api/liquid/objects/order
- https://changelog.shopify.com/posts/customize-your-orders-list-and-get-to-work-faster

---

## 話題 9: 返金画面のボタンの言葉（"Cancel" か "Back" か）、注文番号・顧客名の表示、モバイルの閉じるボタン

### Shopify の動き

- 返金の画面（公式ヘルプ）。デスクトップは注文を開いて "Refund"、モバイルはメニューのアイコンから "Refund"。
  - 項目: 明細ごとの数量、"Restock items"（在庫を追跡する商品のみ・初期で選択済み）、"Refund shipping"（"Shipping"）、"Reason for refund"（内部メモ）、"Refund method"、"Refund amount"（編集可）、"Send a notification to the customer"（初期で選択済み）。
  - 決定ボタンは "Refund"（押すと取り消せない）。値引きは "Save"、過剰返金の承認は "Apply"、在庫だけ戻すときは "Restock" → "Restock items"。
  - 一部返金のあと、注文は "Partially refunded" になる。
- 閉じる／戻る側のボタンの文言（"Cancel" か "Back" か）、画面の上部に注文番号や顧客名が出るか、モバイルの閉じるボタンの形: 公式ヘルプに書いていない（出典が見つからない）。管理画面を見ないと確認できない。
- 手がかり: Shopify アプリ用の Modal 部品（App Home）の公式例は、"Cancel" を `secondary-actions`（目立たない側）に置く。別の例では "Close" という目立たないボタンで閉じる。「破壊的な操作では、結果を本文で説明する」「ボタンの文言は "Delete" "Save" "Continue" のような具体的な動詞に」と書かれている。ただし "Cancel" と "Back" の使い分けの明文は無い。
- 旧 Polaris の内容ガイドのページは移転・削除され、確認できなかった。

### Stripe

- ダッシュボードの返金: 「支払いの返金」→ 金額（初期は全額）→ 理由を選ぶ → "返金"。

### 業界の定番

- 実務家の意見（公式規格ではない。信頼度は低い）: 「Cancel は取り消し・破棄」「Back は前の画面へ戻るだけ（入力は消えない）」と使い分ける。多段階の操作では Back が操作の取り消しにならないので Cancel が別に要る、という主張。モーダルの「×」だけの閉じるは何を意味するか曖昧、という指摘もある。KDE のガイドラインを引いた意見では、確認ダイアログの中の "Cancel" は何を取り消すのか紛らわしいので、動詞で選択肢を明示する。
- Apple の HIG と Material Design の該当ページは、読み込めず確認できなかった（出典が見つからない）。

### 出典

- https://help.shopify.com/en/manual/fulfillment/managing-orders/refunding-orders
- https://help.shopify.com/manual/orders/refund-cancel-order
- https://shopify.dev/docs/api/app-home/web-components/overlays/modal
- https://docs.stripe.com/refunds
- 実務家の意見: https://ar.linkedin.com/in/santiagoisra
- 実務家の意見（KDE ガイドの引用）: https://invent.kde.org/pim/kmail/-/merge_requests/48

---

## 話題 10: 決済手段の並び（Stripe の `paymentMethodOrder`、Shopify チェックアウト）

### Shopify の動き

- チェックアウトの冒頭に "Express Checkout" 欄があり、そこにアクセラレーテッドチェックアウトのボタン（Shop Pay、Apple Pay、Google Pay、PayPal）が出る。並びは顧客にとって最速のものが出るよう動的に入れ替わる。
  - 原文: "Accelerated checkout buttons display in an Express Checkout section at the beginning of your customer's checkout experience" / "are ordered dynamically to display the fastest checkout method for your customer"
- 日本（Shopify Payments の日本向け文書）:
  - カード: American Express、JCB、Mastercard、Visa。有効化すれば自動で使える。JCB は円建てのみ。
  - アクセラレーテッドチェックアウト: Apple Pay、Google Pay、Shop Pay（Shopify Payments で自動有効）。
  - 日本向けの現地決済の一覧にコンビニ決済は載っていない（載っているのは Bancontact、iDEAL | Wero、MB WAY、Przelewy24。顧客の所在地に合わせて表示）。
  - Shopify Payments は日本ではオンライン販売のみ。
- 通常の決済手段の欄で「カードが先頭か」は出典が見つからない。標準の並び順（デフォルト）を書いた公式文書は見つからなかった。
- 並べ替え機能: 「決済手段のカスタマイズ」で sort（並べ替え）・reorder・hide・rename ができる。Basic プラン以上が条件。米国・カナダでは Plus 未満だとカード以外の手段に限られる。Shopify Functions の支払いカスタマイズも「非表示・名前変更・表示順の変更」を持つ。

### Stripe

- `paymentMethodOrder`（Payment Element の `elements.create('payment', {...})` のオプション）:
  - 既定: "By default, the Payment Element will use a dynamic ordering that optimizes payment method display for each user."（利用者ごとに最適化する動的な並び）
  - 指定した決済手段が先に並び、残りは Stripe の動的な並びで続く。PaymentIntent にあるのに `paymentMethodOrder` に書かなかった種類は、書いた物の後ろに出る。PaymentIntent に無い種類を書いても無視される。
  - ウォレットも並べ替えに含められる。例（公式）: `paymentMethodOrder: ['apple_pay', 'google_pay', 'card', 'klarna']`
  - フィンランドとスウェーデンは、口座引き落としをクレジットより先に出す法規制があり、そこでは既定が優先される。
- 動的な並びの根拠（Payment Element の文書）: 「所在地、通貨、取引金額などの要素に基づいて最も関連性の高い支払いオプションを動的に表示」。例: ドイツの顧客が EUR で払うなら、ドイツで普及している順。端末（デバイス）や言語（ロケール）が並びに使われるとは文書に書かれていない（出典が見つからない）。
- アコーディオン配置では既定で最大 5 つを表示し、残りは「その他」ボタンの後ろ（`layout.visibleAccordionItemsCount`、0 で全部表示）。
- Payment Element と Express Checkout Element を併用すると、Apple Pay・Google Pay などのウォレットは重複を避けるため Express Checkout Element 側だけに出る。
- 注意: `paymentMethodOrder` はどの手段が「使える」かを決めない。使える手段は、PaymentIntent に有効な種類（ダッシュボードの設定か `payment_method_types`）で決まる。

### 業界の定番

出典が見つからない。

### 出典

- https://docs.stripe.com/payments/customize-payment-methods
- https://docs.stripe.com/js/elements_object/create_payment_element
- https://docs.stripe.com/payments/payment-element
- https://help.shopify.com/ja/manual/payments/accelerated-checkouts
- https://help.shopify.com/en/manual/payments/shopify-payments/supported-countries/japan/payment-methods
- https://help.shopify.com/en/manual/checkout-settings/checkout-customization
- https://shopify.dev/docs/api/functions/latest/payment-customization

---

## 出典が見つからなかった点の一覧（まとめ）

| 話題 | 見つからなかったこと |
| --- | --- |
| 1 | 交換品が CSV でどう出るか／交換品が元の注文の明細か別注文か |
| 1 | 編集・返金後の CSV の見え方の公式説明（第三者の記述のみ） |
| 2 | 保留の解除・発送取り消しができない条件の全体／ボタンを隠すか無効にするかの明記 |
| 4 | "Order edited"・"Returned" という文字の項目／注文・返品へのリンクの有無 |
| 5 | Shopify の理由が Stripe の `reason` に渡るか／Stripe の `reason` を空にしてよい場面の公式な指針 |
| 6 | 顧客向け画面での返金保留の表示 |
| 8 | 現在の管理画面の列見出しの断定（"Financial status" と "Payment status" の併存） |
| 9 | 返金画面の閉じる側のボタン文言、注文番号・顧客名の表示、モバイルの閉じるボタン |
| 10 | 日本のチェックアウトで通常欄の先頭がカードか／Shopify の既定の並び順／Stripe の並びに端末・言語が使われるか |
