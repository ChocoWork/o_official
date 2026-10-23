# Shopify 突き合わせ調査（グループ G・H ほか）

調査日: 2026-10-22
対象: 受注生産が多い小さな日本の服ブランドの EC（自前の Next.js + Supabase + Stripe。Shopify ではない）
読み方:
- 各項目の末尾の [n] は、その節の最後の「出典」の番号。
- 信頼度の目印: 「公式」= Shopify・Stripe・17TRACK・消費者庁の公式ページを直接読んだ。「二次」= コミュニティ・他社ブログ・検索結果の要約だけ（要確認）。「出典なし」= 探したが見つからない。
- 「提案」と書いた部分は私の考えで、出典はない。事実とは分けてある。
- Shopify の画面の英語名（"Available" など）は公式のままで引用してある。

---

## 1. 在庫と発注の管理（グループ G）

### Shopify の動き

在庫の状態（公式 [1-1]）
- "Available": 売れる在庫。注文に取られておらず、"Unavailable" でもなく、"Incoming" も含まない。
- "Committed": 取り置かれて売れない数。出荷前の注文、下書き注文（draft order）の確保分、"ready to ship" にした移動（transfer）の分が入る。
- "Unavailable": 現場にあるが売らない数。例は "Damaged"、"Quality control"、"Safety stock"。そのほか「別の理由で保留」。
- "Incoming": 移動・発注（purchase order）・アプリから向かっている数。受け取る（receive）までは売れない。受け取ると、ふつう "Available" になる。
- "On hand": その場所にある全部。式は On hand = Committed + Unavailable + Available。"Incoming" は On hand に入らない。
- 開発者向け説明でも同じ。"incoming" は「その場所に物として無い」唯一の状態。API で "committed" の数は直接いじれない [1-2]。

場所ごと・バリエーション（variant）ごと
- 在庫は「場所（location）」ごとに別々に持つ。複数の場所があると、注文はルーティングの設定と在庫で割り振られる [1-3]。
- 商品ページの在庫は、サイズ×色のバリエーションごとに持てる（商品概要ページの記載）[1-4]。
- 「バリエーション×場所」の組み合わせを明記したページは、取得できた範囲では見つからなかった。ただし 1-2 の説明は「ある場所の商品の数量」で、1 つの場所に在庫が 1 つという前提。

発注書（purchase order）
- ステータスは "Draft" と "Ordered" の 2 つだけ（API の列挙値も DRAFT / ORDERED のみ）[1-5][1-6]。
- "Ordered" にできるのは、行き先の場所を入れたあと。"Ordered" は取り消せない（"Marking a purchase order as ordered can't be reversed."）[1-6]。
- 受け取り・一部の受け取り・完了・クローズは、発注書ではなく、つながった「在庫移動（inventory transfer）」側で管理する [1-6]。
- 2026-06-22 の更新: 発注書の受け取りで移動が作られる。1 つの移動に複数回の入荷を持てる。各移動は発注書と結びついたまま。発注書の行を CSV で取り込める [1-7]。
- 移動のステータス表記は "in transit"（輸送中）、"ready to ship"、"transferred"。受け取りは全部でも一部でも可 [1-8]。
- 発注書を "Ordered" にしたあとの "Incoming" の増え方の細かい説明は、直接読めたページには無かった。"Incoming" が発注書から来る点は 1-1 に書いてある。

「在庫発注（inventory to order）」のレポートは Shopify 本体に無い
- 在庫レポートは 9 種: Month-end inventory snapshot / Month-end inventory value / Inventory sold daily by product / Products by percentage sold / ABC product analysis / Products by sell-through rate / Inventory remaining per product / Inventory adjustment changes / Inventory adjustments by count。発注点・低在庫のレポートは無い。近いのは "Inventory remaining per product"（あと何日分か）と "ABC product analysis"（優先順位づけ）[1-9]。
- 以前は Stocky（Shopify の在庫・発注アプリ）に低在庫レポートがあった。Low stock の "Variants" 表には、列 ROP（発注点）・Lead time・Need（リードタイムを乗り切るのに要る数）・Depletion（なくなるまでの日数）。ROP は「1 日の販売数 × リードタイム」。例: 1 日 5 個・リードタイム 10 日なら 50 個で警告 [1-10]。
- Stocky は "The Stocky app will no longer be available after August 31st, 2026." と公式に告知されている。今日（2026-10-22）はもう終了後 [1-10][1-11]。
- Stocky 本体の発注書ステータス名（"Draft / Ordered / Received" などか）は、公式ページから確認できなかった（出典なし）。他社アプリ（Stockie）の説明に Received / Partially received / Closed があるが、Stocky のものではない [1-12]。

受注生産・予約の需要の持ち方
- 商品設定 "Continue selling when out of stock": 在庫を追跡している（"Inventory tracked" をオン）ときだけ選べる。標準では在庫が 0 以下だと買えない。オンにすると 0 以下でも買える。公式の説明は、使う場面として「予約（preorder）商品」「もうすぐ入荷する在庫」「材料を発注する前に売る」を挙げている [1-13]。
- 在庫の数はマイナスになりうる。公式の例: 1 枚しか無い場所で 3 枚の注文が入ると -2 [1-3]。
- 「予約の上限数」を別に決める機能は標準に無い（コミュニティの回答。二次）[1-14]。
- Shopify の「予約（Pre-orders）」は購入オプションの 1 つで、App Store の予約アプリが必要。支払いは全額・一部・なしを選べる。制限: Online Store と Custom Storefront のみ。Shop Pay / Apple Pay / Google Pay は使えない。1 回の購入で購入オプションを混ぜられない [1-15][1-16]。
- Shopify の予約ページには、出荷日を示さないなら「30 日以内に出荷できると合理的に信じる」必要があり、遅れたら新しい出荷日と「キャンセル・返金の権利」を伝える、と書かれている [1-16]。どの国の法律が根拠かはページに書かれていない。

小さなブランドの最小の発注の流れ（Shopify が示す形）
- 発注書: 仕入れ先を選ぶ → 品目・数量・原価・行き先の場所を入れる → 下書きを PDF にして仕入れ先に確認 → 仕入れ先が確認したら "Ordered" → 入荷は移動で受け取る [1-6]。
- 発注点: ROP = (1 日の販売数 × リードタイム) + 安全在庫。例: 1 日 5 個、リードタイム 35 日、安全在庫 15 個なら (5×35)+15 = 190 個。安全在庫を省いて「ROP = 1 日の販売数 × リードタイム」で運用してもよい（欠品を許容する場合）[1-17]。
- 受注生産向けの発注（生地・副資材、工場の枠の押さえ）の具体的な流れを書いた Shopify の公式ページは見つからなかった（出典なし）。

### Stripe
- 該当なし。

### 業界の定番・法令
- 受注生産や予約の「引渡時期」は、特定商取引法の通信販売で「期間または期限」で書く必要がある。「できるだけ早急に」は不可。Q&A では「入荷次第」も時期を示したことにならない（消費者庁）[1-18][1-19]。「ご注文から約○週間」のような書き方が要る。
- 提案（出典なし）: 最小の形は次の 3 つ。(a) バリエーションごとに Available / Committed / Incoming の 3 つの数を持つ。(b) 受注生産は「受注数の合計」を締めの日に集計して発注書 1 枚にする。ステータスは Shopify と同じ Draft → Ordered と、入荷側の Received（一部入荷あり）の 3 段階で足りる。(c) 発注点の式（上の ROP）でバリエーションごとに「いつ発注するか」を出す。

### 出典
- [1-1] https://help.shopify.com/en/manual/products/inventory/managing-inventory-quantities/inventory-states （公式）
- [1-2] https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps （公式）
- [1-3] https://help.shopify.com/en/manual/inventory-and-locations/locations/fulfillment および https://help.shopify.com/en/manual/products/inventory/setup/selling-when-out-of-stock （公式。-2 の例は検索結果の要約にあった公式例で、ページ本文での再確認はしていない）
- [1-4] https://help.shopify.com/en/manual/products/purchase-orders （取得すると商品の概要ページの内容だった。サイズ×色ごとの在庫の記載）
- [1-5] https://shopify.dev/docs/api/admin-graphql/latest/enums/InventoryPurchaseOrderStatus （公式）
- [1-6] https://help.shopify.com/en/manual/products/inventory/purchase-orders/creating-purchase-orders （公式）
- [1-7] https://changelog.shopify.com/posts/purchase-orders-now-create-transfers-to-move-inventory （公式の更新履歴）
- [1-8] https://help.shopify.com/en/manual/products/inventory/transfers （公式）
- [1-9] https://help.shopify.com/manual/reports-and-analytics/shopify-reports/report-types/inventory-reports （公式。レポート名は取得時の表記で、検索結果の要約では別名（Average inventory sold per day など）の表記もあった）
- [1-10] https://help.shopify.com/en/manual/sell-in-person/shopify-pos/inventory-management/stocky/inventory-management/low-stock （公式）
- [1-11] https://help.shopify.com/en/manual/sell-in-person/shopify-pos/inventory-management/stocky/reporting/report-types （公式。Stocky の Purchase Orders レポートは「到着先・配送状況・支払い状況」を出すとある）
- [1-12] https://stockie.helpscoutdocs.com/article/132-deleting-closing-and-reopening-purchase-orders （他社アプリ。二次）
- [1-13] https://help.shopify.com/en/manual/products/inventory/setup/selling-when-out-of-stock （公式）
- [1-14] https://community.shopify.com/t/continue-selling-when-out-of-stock-but-limiting-the-pre-order-quantity/88478 （コミュニティ。二次）
- [1-15] https://help.shopify.com/en/manual/products/purchase-options/pre-orders （公式）
- [1-16] https://help.shopify.com/en/manual/products/purchase-options/pre-orders/setup （公式）
- [1-17] https://www.shopify.com/blog/reorder-point （Shopify 公式ブログ）
- [1-18] https://www.no-trouble.caa.go.jp/what/mailorder/advertising.html （消費者庁 特定商取引法ガイド）
- [1-19] https://www.no-trouble.caa.go.jp/qa/advertising.html （消費者庁 通信販売広告Q&A の Q10）

---

## 2. 割引・プロモーションコード（グループ H）

### Shopify の動き（公式）

種類と対象
- 割引コード（discount code）の種類: 割合（"Percentage"）、定額（"Fixed amount"）、無料配送（free shipping）、買い物の組み合わせ（buy X get Y）[2-1][2-2][2-3]。
- 割合・定額は商品に効く。送料には効かない。全商品対象なら、カート内の商品に比例配分される [2-2]。
- 無料配送のコード: 国を選べる。"Exclude shipping rates over a certain amount"（一定額を超える配送方法は対象外）の指定ができる [2-3]。

条件
- 最低条件: 最低購入額（"Minimum purchase amount"）か最低個数（"Minimum quantity of items"）。最低購入額に数えるのは商品の価格だけで、送料と税は入らない [2-2][2-3]。
- 利用できる人（"Eligibility"）: "All customers" / "Specific customers" / "Customer segments" / "Markets" [2-2]。「指定できる顧客・商品・バリエーションは 100 まで」[2-1]。
- 使用回数（"Maximum discount uses"）: "Limit number of times this discount can be used in total"（全体で N 回まで）と、"Limit to one per customer"（1 人 1 回）[2-2]。ヘルプの表記は "Limit to one per customer" で、"one use per customer" ではない。
- 1 人 1 回の見分け方: ヘルプに「お客さまのメールアドレスまたは電話番号を追跡して 1 人 1 回に限る」とある（"by tracking a customer's email address or phone number"）[2-2]。アカウントの有無には触れていないので、ゲスト購入もこの方式で数える、と読める。ただし別のメールアドレスなら別人として数えられる（コミュニティの指摘。二次）[2-5]。
- 「1 人 1 回」の記録は、その割引ごと。割引を消して同じ条件で作り直すと、前に使った人がもう 1 回使える [2-1]。
- 有効期間（"Active dates"）: 開始は店のタイムゾーンの 0 時。終了日は任意。同じ日を開始と終了にすれば 1 日限り [2-1][2-2]。
- 併用（"Combinations"）: 割引は「商品・注文・配送」の 3 種類（class）。自動では併用されず、割引ごとに併用できる種類を選ぶ。1 つの注文に「商品または注文の割引コード 5 つ + 配送の割引コード 1 つ」まで。自動割引は同時に有効にできるのが 25 個まで。配送の割引は 2 つ同時に使えない [2-4]。
- 割引は、税を足す前の注文の小計に対してかかる [2-6]。

「初回注文だけ」
- 公式ヘルプにその専用の設定は見つからなかった。コミュニティでは、顧客セグメントの条件 `number_of_orders = 0`（注文数 0 の人）を作り、そのセグメントを割引の対象にする方法が多く言われている（二次）[2-7]。また Shopify の担当者が「初回限定は標準では無い」と答えたという書き込みもある（二次）[2-7]。
- セグメントの条件 `number_of_orders` は「その顧客の全期間の注文数」の整数（セグメント言語の説明）[2-8]。ゲスト購入の人が顧客として数えられるかは、公式に見つからなかった（出典なし）。

### Stripe（公式）

プロモーションコード（promotion code）の機能 [2-9][2-10][2-11]
- `expires_at`: 期限。コード側の期限は元の coupon の `redeem_by` より後にできない。
- `max_redemptions`: 全体の使用回数の上限（元の coupon の上限を超えられない）。
- `restrictions.minimum_amount` と `minimum_amount_currency`: 最低金額（円なら JPY を指定）。制限は使う時点で確認される。
- `restrictions.first_time_transaction`: API の説明は「成功した支払いや請求書が 1 つも無い顧客（Customers）だけが使える」。
- `customer` または `customer_account`: 特定の顧客だけに限る。指定しなければ誰でも使える。
- 期限か使用上限に達したコードは永久に無効になり、再度有効にできない。コードの文字列は有効なコードの中で一意（大文字小文字は区別しない）。
- 属性の一覧（`active` `code` `customer` `expires_at` `max_redemptions` `restrictions` `times_redeemed`）に、Shopify の「1 人 1 回」に当たる項目は無い。
- Checkout（Stripe の決済画面）では `allow_promotion_codes: true` で入力欄が出る。Checkout Session は「最大 1 つの coupon または promotion code」まで [2-10]。

Stripe の Customer（顧客）オブジェクトが必要になる場面
- `customer` で特定の顧客に限るコード: 作る時に Customer の ID が要る [2-9][2-10]。
- `first_time_transaction`: 判定は Customer ごとの支払い履歴で行う（上の API 説明）。公式の説明文は次のとおり: セッションに顧客が定義されていない場合、または定義された顧客に過去の支払い・無効でない請求書が無い場合は、初回取引とみなす [2-10]。
- 顧客を作らない Checkout はダッシュボードで「ゲスト顧客」に分類される。ドキュメントは「初回顧客限定のコードは、これらのセッションでも引き続き適用されます」と書く [2-10]。これは「ゲストでも使える」とも「ゲストにも制限がかかる」とも読め、はっきりしない。
- ゲスト顧客のまとめ方は、カード番号・メールアドレス・電話番号のどれか 1 つが合えば同じゲストとして扱う、と書かれている（ダッシュボード上の見え方の話）[2-12][2-13]。この仕組みが promotion code の初回判定に使われるかは、公式に見つからなかった（出典なし）。
- つまり、ゲスト購入のまま「本当に初回だけ」を守らせたい場合、Stripe 側の判定に頼るのは危ない。毎回 Customer を作る（またはメールアドレスで既存の Customer を使い回す）か、自前の注文テーブルをメールアドレスで調べる必要が出る。これは提案（出典なし）。実際の動きはテストモードで確かめるのが確実。

### 業界の定番・法令
- Shopify と Stripe とも「全体回数」「期限」「最低金額」は標準で持つ。「1 人 1 回」は Shopify は標準、Stripe は標準では無い（Stripe は `max_redemptions` が全体の回数）。
- 景品表示法や割引表示の法令の整理は、今回の調べでは行っていない（出典なし）。

### 出典
- [2-1] https://help.shopify.com/en/manual/discounts/discount-codes （公式）
- [2-2] https://help.shopify.com/en/manual/discounts/discount-types/percentage-fixed-amount （公式）
- [2-3] https://help.shopify.com/en/manual/discounts/discount-types/free-shipping （公式）
- [2-4] https://help.shopify.com/en/manual/discounts/discount-combinations （公式）
- [2-5] https://community.shopify.com/t/guest-checkout-and-one-time-discount-codes/35513 （コミュニティ。二次）
- [2-6] https://help.shopify.com/en/manual/discounts/combining-discounts （公式。「割引は税の前の小計に適用」）
- [2-7] https://community.shopify.com/t/how-to-limit-discount-codes-to-first-orders-only/193756 ほか（コミュニティ。二次）
- [2-8] https://shopify.dev/docs/apps/build/shopifyql/segment-query-language-reference （検索結果の要約で確認。ページ本文は直接取得していない）
- [2-9] https://docs.stripe.com/api/promotion_codes/create.md?query=restrictions および https://docs.stripe.com/api/promotion_codes/object （公式）
- [2-10] https://docs.stripe.com/payments/checkout/discounts.md?payment-ui=checkout-form （公式。日本語版）
- [2-11] https://docs.stripe.com/billing/subscriptions/coupons.md （公式。日本語版。クーポンとプロモーションコードの比較表と制限の説明）
- [2-12] https://docs.stripe.com/payments/checkout/guest-customers.md （公式）
- [2-13] https://support.stripe.com/questions/guest-customer-faq （公式サポート）

---

## 3. 送料（法的表示と請求額のずれの直し方）

### Shopify の動き（公式）
- 送料の設定画面（Settings > Shipping and delivery > 配送プロファイル > ゾーン > "Add shipping option"）で、"Rate type" は "Flat"（定額）/ "Order amount"（注文金額の範囲）/ "Weight"（重さの範囲）から選ぶ [3-1]。
- "Name" に入れた名前が、チェックアウトでお客さまに見える [3-1]。"Price" を空か 0 にすると無料の配送方法になる [3-1]。
- 「○円以上で無料」: 配送方法で "Offer free shipping" を選び、最低注文額を入れる。範囲を決める配送方法では、その範囲に当たる注文だけが無料 [3-1]。
- 範囲に穴があると、その注文はチェックアウトで配送エラーになる。いちばん上の範囲の "Maximum" は空にして穴を防ぐ [3-1]。
- 「無料配送の割引コード」とは別の機能（無料配送は割引の種類でもある。節 2 参照）[2-3]。
- 無料配送のしきい値を画面に出す標準の部品は、ヘルプには見つからない。テーマのコードやアプリ（進捗バーのアプリが多数）で出すのが実際のやり方（コミュニティ・アプリ一覧。二次）[3-2]。

### Stripe
- 該当なし（送料は自前の画面と金額の計算で決める部分）。ただしコンビニ決済の登録審査で、「ウェブサイトに送料や手数料などの追加料金が明記されていない」ことは却下理由の 1 つ [4-1]。

### 業界の定番・法令

特定商取引法（通信販売）の決まり（消費者庁）
- 広告（このサイトでは「特定商取引法に基づく表記」ページが当たる）には、販売価格と送料を書く。「販売価格（送料についても表示が必要）」[3-3]。
- 販売価格だけが書かれていれば、送料はその価格に含まれていると推定される。送料を別に取るなら、その旨を書く [3-4]。
- 送料は金額で示す。「送料実費」は不可 [3-4]。
- 申込みの最終確認画面（法第 12 条の 6）では、ガイドラインが次のように書く: 複数商品なら支払総額も併せて表示し、「送料は実際に消費者が支払うこととなる金額を表示する必要がある」。例外は、申込み段階で送料を確定できない特別な事情があるときだけ [3-5]。
- ガイドラインの画面例にある書き方: 「注文した商品の合計額に送料（税込500円・全国一律）が加算されます。」[3-5]
- 誤認させる表示は禁止。表示した文言自体が嘘でなくても、位置・大きさ・他の表示との組み合わせで誤認させるなら該当しうる [3-5]。誤認して申し込んだ消費者は、申込みを取り消せる（法第 15 条の 4）[3-5]。
- 違反時の行政の「指示」の対象になるという説明は解説記事のもので、二次 [3-6]。罰則の金額は今回確かめていない（出典なし）。

今回のずれへの意味
- 表記ページ（広告）が「送料無料」で、決済が 500 円を請求するのは、上の「広告の送料」と「最終確認画面の送料」が食い違う形。どちらを直しても、2 つが同じになれば解消する。
- 直し方は 2 通り。(A) 表記ページを実際の請求に合わせる（例: 「送料 500 円（税込・全国一律）」、しきい値があるなら「○円以上は無料」と金額で書く）。(B) 決済側を無料にする。どちらを選ぶかは出典のない経営判断。すでに受けた注文への対応は別途の判断（出典なし）。
- 送料を最初から見せる意味: Baymard の調べ（米国の購入者）では、カゴ落ちの理由の第 1 位が「追加費用（送料・税・手数料）が高すぎる」の 40%。「総額を前もって見られなかった」も 12% [3-7]。

### 出典
- [3-1] https://help.shopify.com/manual/fulfillment/setup/shipping-rates/flat-shipping-rate （公式）
- [3-2] https://community.shopify.com/t/free-shipping-bar-progress/665869 など（コミュニティ・アプリ一覧。二次）
- [3-3] https://www.no-trouble.caa.go.jp/what/mailorder/ （消費者庁 特定商取引法ガイド 通信販売）
- [3-4] https://www.no-trouble.caa.go.jp/what/mailorder/advertising.html （消費者庁。送料の推定・金額表示）
- [3-5] 通信販売の申込み段階における表示についてのガイドライン https://www.no-trouble.caa.go.jp/pdf/20220601la02_07.pdf （消費者庁。読んだのは 2022-06-01 版。最新は 2024-11-19 版 https://www.no-trouble.caa.go.jp/pdf/20241119la02_09.pdf で、一覧は https://www.no-trouble.caa.go.jp/what/mailorder/guidelines.html 。2024 版で変わった点の報告は「いま操作中の画面が最終確認画面だと分かる記載が望ましい」旨の追加。送料の記載が変わったかは未確認）
- [3-6] https://www.businesslawyers.jp/articles/1133 （弁護士解説。二次）
- [3-7] https://baymard.com/lists/cart-abandonment-rate （Baymard。米国調査）

---

## 4. コンビニ払い

### Shopify の動き
- Shopify Payments（日本）の決済手段は、クレジットカード（Visa / Mastercard / American Express / JCB / Diners Club / Discover）、Apple Pay、Google Pay、Shop Pay。コンビニ払いは Shopify Payments に入っておらず、KOMOJU・SBペイメントサービス・GMOペイメントゲートウェイ・GMOイプシロン・ウェルネットなどの外部サービスを連携して使う（Shopify 日本の公式ブログ）[4-6]。
- 外部の決済サービスを使うと、Shopify Payments を使わない分の取引手数料（0.2%〜2.0%）がプランに応じてかかる [4-6]。
- コンビニ払いの手数料の例（KOMOJU 2.75%）は、コミュニティの投稿。二次 [4-7]。

### Stripe（公式）
- 対応: 日本のファミリーマート・ローソン・ミニストップ・セイコーマート。通貨は JPY。金額は 120 円以上 300,000 円以下 [4-1]。
- 支払いの流れ: お客さまが支払いコードと確認番号を受け取り、店頭で現金で払う。確認は客が払ったとき。売上は 4 営業日後に入金できる [4-1]。
- 期限: Checkout では `payment_method_options[konbini][expires_after_days]`。有効値は 1〜60 日、標準は 3 日。期限は指定日の 23:59:59 [4-2]。
- 非同期（あとから届く）支払いなので、フルフィルメントは Webhook で待つ。`checkout.session.completed` の時点では未払い。払われたら `checkout.session.async_payment_succeeded`。期限切れなどで失敗なら `checkout.session.async_payment_failed` [4-2]。
- 手動キャプチャー（与信だけ取って後で確定）は非対応。サブスクリプションモード・セットアップモードの Checkout は非対応。Express Checkout Element も非対応 [4-1][4-2]。
- Checkout で選ぶと、お客さまは `success_url` ではなく Stripe の払込票ページ（`hosted_voucher_url`）に移る。払込票を失くした客向けに、メールで `hosted_voucher_url` を送る使い方が書かれている [4-2]。
- 返金: ダッシュボードか API でできるが、お客さまが返金先の銀行口座を入力する必要がある。Stripe が登録メールアドレスに依頼を送る。45 日たっても口座が届かないと返金は `failed` になり、Stripe の外で返す必要がある。返金 1 件ごとに手数料がかかる場合があり、詳細は担当者に確認とある [4-2]。
- 手数料: 公式の料金ページに、コンビニ決済は「3.6%」「最低手数料 ￥120」とある。同じ表に「10% + ￥250」「返金時の消費税」という記載もあるが、何の料金か読み取れなかった [4-3]。
- 不審請求（チャージバック）: 現金払いなので通常は起きない [4-1]。
- 登録の審査: ウェブサイトに特定商取引法の完全な表記があること、送料・手数料などの追加料金が明記されていること、キャンセル条件があること、などが条件。満たさないと却下されうる [4-1]。創業 3 年未満の個人事業主は対象外の業種区分に入る [4-1]。

### 業界の定番・利用の割合
- ネット通販の支払いで、クレジットカードが 68%、コード決済が 27%（インフキュリオン「決済動向2025年調査」、2025 年 4 月、16〜69 歳 2 万人）。コンビニ払いの数字は載っていない [4-4]。
- アパレルのネット通販に限ったコンビニ払いの利用割合: 出典が見つからない。
- 別の調査として、検索結果の要約に、普段使う支払い方法がクレジットカード 67.4%・代金引換 13.8%・後払い 11.4%（ネットプロテクションズ、調査時期が不明）、使いたい支払い方法がなくて購入をやめた人が 31.4%（あるるモール、2026 年 1 月、350 人）とあった。原ページは取得できず未確認（二次）[4-5]。

### 受注生産のブランドにとっての良い点と悪い点（出典付きの事実 + 提案）
- 良い点（事実）: カードを持たない・使いたくない人が買える。手数料はカードと同じ 3.6% [4-3]。払ったあとに生産を始める流れと相性がよい（提案）。チャージバックの心配が小さい [4-1]。
- 悪い点（事実）: 払われるまで注文が確定しない非同期の支払い [4-2]。期限は標準 3 日、最大 60 日 [4-2]。期限が切れれば失敗 [4-2]。返金はお客さまの口座入力待ちで、45 日で失敗 [4-2]。金額の上限 30 万円 [4-1]。手動キャプチャー不可で、「与信だけ取っておき、生産開始時に確定」はできない [4-1]。
- 提案（出典なし）: 受注生産は在庫の確保と生産の枠があるので、期限を短め（例: 3〜7 日）にして、期限切れで注文を自動で取り消し、取り置きを解除する。返金が起きやすい受注生産では、返金時にお客さまの口座入力が要る点を案内文に書く。

### 出典
- [4-1] https://docs.stripe.com/payments/konbini.md （公式。日本語版）
- [4-2] https://docs.stripe.com/payments/konbini/accept-a-payment.md?payment-ui=checkout （公式。日本語版）
- [4-3] https://stripe.com/jp/pricing （公式。表の見え方が読み取りにくい部分あり）
- [4-4] https://netshop.impress.co.jp/node/14267 （ネットショップ担当者フォーラム、2025-06-19。インフキュリオンの調査）
- [4-5] https://ecnomikata.com/ecnews/marketing/49485/ など（検索結果の要約のみ。保守のお知らせが出て原ページは読めなかった。二次）
- [4-6] https://www.shopify.com/jp/blog/payments-list （Shopify 日本の公式ブログ）
- [4-7] https://community.shopify.com/t/topic/293864 など（コミュニティ。二次）

---

## 5. 返品不可・セール品（final sale）

### Shopify の動き（公式）
- 設定の場所: Settings > Policies > 返品・キャンセルのルール（"Return and cancellation rules"）> "Final sale items"。"Specific collections" か "Specific products" を選んで追加する。商品とコレクションは混ぜられない。バンドルは final sale にできない [5-1]。
- final sale の品は「まったく返品できない」。返品期間の個別設定（override）に入っていても final sale のまま [5-1]。
- お客さまは final sale の品について、返品・キャンセルの申請を出せない（"Your customers can't submit return or cancellation requests for final sale items."）[5-1][5-2]。
- 返品期間の選択肢: 14 / 30 / 90 / "Unlimited" 日か任意の日数。起点は商品の配達日。手数料（restocking fee）は割合で設定でき、自動では返金から引かれない [5-1]。
- お客さまが注文ステータスページで見る文言の原文は、公式ページに無かった（出典なし）。注文の状況で、できる操作だけ（"Cancel items" / "Return items" / "Cancel or return"）が出る、という説明はある [5-3]。店頭用（POS）では、返品できない理由として "Final sale" が出る [5-2]。
- API の列挙値 `FINAL_SALE`（返品できない理由）は、「注文が入った時点で返品ルールがあった場合のみ」当てはまる [5-4]。
- 不良品: 返品ルールのページに、不良品の扱いの記載は無い（出典なし）。ただし Shopify の担当者が開発者フォーラムで「管理画面では、権限のあるスタッフなら final sale の商品でも返品を作れる」と答えている（"any authorized staff can create returns, even for final sale products"）[5-5]。つまりシステム上は店側の判断で作れる。
- 自動で作られる返品ポリシーの文章には、設定した返品ルールが反映されない。ポリシーの文章は自分で直す必要があり、公開した方針を守る責任は店側 [5-1]。

### Stripe
- 該当なし。

### 業界の定番・法令（消費者庁）
- 返品の特約（返品特約）を広告に表示していれば、特約が優先される。表示していなければ、商品を受け取った日から 8 日以内は、消費者の送料負担で返品できる（法第 15 条の 3）[5-6][5-7]。
- 返品特約の「可否・条件・返品の送料負担」は、他の事項より分かりやすく表示する。商品の価格の近くに、同じ大きさの文字で、色や太字を使うなど [5-8]。
- 全商品共通の「ご利用ガイド」のようなページにまとめて書く方法も認められうる。ただし、どの商品がどの特約の対象か分かること [5-8]。
- インターネット通販では最終確認画面にも表示する [5-6]。
- 「その都度ご相談」という書き方は、事前に返品の可否を伝えたことにならない（Q13）[5-9]。
- 不良品: 返品特約のガイドラインは、契約に合った商品を返品するときの決まりと、契約に合わない商品の責任に関する特約を分ける。後者を特約にする場合は別に表示が必要（施行規則第 23 条第 5 号）。両者の区別がつかない書き方は、「合った商品の返品特約だけを定めた」と解釈され、合わない商品の責任は民法・商法の一般原則になる [5-8]。例文: 「商品に欠陥がある場合を除き、返品には応じません。」（Q14）[5-9]。
- 受注生産品に限って返品不可にしてよい、と明記した出典は見つからなかった（出典なし）。一般原則どおり、返品特約を所定の方法で表示すれば特約が優先される、というところまでが出典のある範囲。

### 出典
- [5-1] https://help.shopify.com/en/manual/orders/self-serve-returns/return-rules （公式）
- [5-2] https://help.shopify.com/en/manual/sell-in-person/shopify-pos/order-management/return-rules （公式。POS。検索結果の要約）
- [5-3] https://help.shopify.com/en/manual/fulfillment/managing-orders/returns/self-serve-returns/setup （公式）
- [5-4] https://shopify.dev/docs/api/customer/2026-10/enums/NonReturnableReason （公式）
- [5-5] https://community.shopify.dev/t/item-shows-in-returnable-fulfillments-despite-final-sale/20188 （Shopify 担当者の回答）
- [5-6] https://www.no-trouble.caa.go.jp/what/mailorder/ （消費者庁）
- [5-7] https://www.no-trouble.caa.go.jp/what/mailorder/guidelines.html （消費者庁。ガイドラインの一覧）
- [5-8] 通信販売における返品特約の表示についてのガイドライン https://www.no-trouble.caa.go.jp/pdf/20230421la02_07.pdf （消費者庁、2023-04-21）
- [5-9] https://www.no-trouble.caa.go.jp/qa/advertising.html （消費者庁 通信販売広告Q&A の Q13・Q14）

---

## 6. 荷物の追跡

### Shopify の動き（公式）
- 追跡番号がリンクになる条件（優先順）: (1) `url` に追跡 URL を入れた (2) `company` が Shopify の知っている運送会社名 (3) 番号の形式を Shopify が推測（外れると無効なリンクになりうる）。公式は「運送会社名と追跡 URL の両方を送ることを強く勧める」[6-1]。
- 運送会社の一覧に "Japan Post (EN)"、"Japan Post (JA)"、"Sagawa (EN)"、"Sagawa (JA)"、"Yamato (EN)"、"Yamato (JA)" がある（全世界向けの一覧）。日本の店用の一覧は別で、エコ配・西濃運輸・西濃スーパーエキスプレス・福山通運・日本通運・名鉄運輸・第一貨物の 7 社 [6-1]。
- 注文ステータスページの表示は 2 通り [6-2][6-3]:
  - 対応している運送会社: ステータスが自動で更新され、荷物の場所が地図に出る。
  - 対応していない運送会社: 追跡番号が運送会社のサイトへのリンクとして出るだけで、ステータスは更新されない。
- 表示されるステータス名: "Confirmed" / "On its way" / "Out for delivery" / "Delivered" / "Attempted delivery" [6-3]。
- 追跡番号が無い場合: "On its way" のまま。店が注文詳細から手で配達済みにするまで変わらない [6-2]。
- ヤマト・佐川・日本郵便が「ステータス自動更新の対象」かは、Shopify の公式ページに見つからなかった（出典なし）。一覧に名前があることと、自動更新の対象であることは別。

### Stripe
- 該当なし。

### 17TRACK（公式の API 文書）
- 17TRACK の運送会社コード: ヤマト運輸 = 100062、佐川急便 = 100040、Japan Post = 10021（運送会社の一覧 JSON。日本郵便の表記ゆれや「ゆうパック」は途中までしか読めず未確認）[6-5]。
- API: `https://api.17track.net/track/v2.4`、POST の JSON、ヘッダー `17token` に鍵 [6-4]。
- 登録（`/register`）: 1 回で 40 件まで。1 時間に約 40 万件。応答は通常数秒（運送会社の都合で 5 分超もある）。制限は 3 リクエスト/秒で、超えると 429 [6-4]。
- Webhook（push）: ダッシュボードに URL を登録して試験する。イベントは `TRACKING_UPDATED`（状態が変わった）と `TRACKING_STOPPED`（もう更新しない）。HTTP 200 以外は失敗として扱い、600 秒後・1800 秒後・3600 秒後に再送（同じ状態に対して 3 回）。次の状態になるとまた最初から。署名: ヘッダー `sign` は「受け取った本文 + "/" + API キー」の SHA-256。照合で偽の送信元を弾く。push は順番待ちに入るので、受け側もキューで処理することが勧められている [6-4]。
- 料金・無料枠: 公式の文書に、「月 100 件の無料枠は終了」「2026-01-07 以降に登録したアカウントには、1 回だけ 200 件の無料枠」とある。1 つの追跡番号の登録が 1 件分。削除した番号を登録し直すと、また 1 件分かかる [6-4]。
- 単価・プランの価格: 公式の価格表は読めなかった（ページが 403 や管理画面へのリダイレクト）。公式の「API のページ」には「各プランの有効期間は 12 か月」と「Custom は問い合わせ」とあるだけ [6-6]。競合他社のブログによる表では、5,000 件 119 ドル/年、25,000 件 569 ドル、150,000 件 2,869 ドル（以下略）、未使用分の繰り越し無し、リアルタイム更新は 1 回 10 件分。競合のブログなので参考値にとどめる（二次）[6-7]。

### 業界の定番
- 日本の運送会社の追跡を自前で出すなら、各社の追跡ページへのリンク（番号入りの URL）が最低線で、ステータスを画面に出すなら 17TRACK のような集約 API を使う、という整理。これは提案（出典なし）。

### 出典
- [6-1] https://shopify.dev/api/admin-graphql/latest/objects/FulfillmentTrackingInfo （公式）
- [6-2] https://help.shopify.com/en/manual/fulfillment/setup/order-status-page/order-tracking （公式）
- [6-3] https://help.shopify.com/en/manual/fulfillment/setup/order-status-page/understanding-order-status-pages （公式）
- [6-4] https://api.17track.net/en/doc?version=v2.2 （17TRACK 公式の API 文書。取得すると v2.4 の内容が出た。本文が長く、最後の部分は読んでいない）
- [6-5] https://res.17track.net/asset/carrier/info/apicarrier.all.json （17TRACK 公式の運送会社一覧）
- [6-6] https://www.17track.net/en/api （17TRACK 公式）
- [6-7] https://www.track123.com/blog/track123-vs-17track （競合のブログ。二次）

---

## 7. ゲストが見る注文ステータスページ

### Shopify の動き（公式）

ログインなしで見えるもの [7-1]
- メール・SMS・Shop アプリの注文確認にあるリンクから開く。リンクを開いた同じブラウザは 3 週間、ログインなしで見られる。別のブラウザなら 2 週間、最大 5 ブラウザまで。
- その期間が過ぎたあとにログインなしで見えるのは限られた情報だけ: 買った品目、合計、適用された割引、注文のステータス。お客さまの名前・住所（配送先・請求先）・支払い方法・配送方法・追跡番号は出ない。
- 全部の情報を見るには "Log in"。アカウントが無い場合は、注文番号と、購入時のメールアドレスか電話番号で入る。
- リンクをだれかに共有しても、他人に見えるのは限られた情報だけ（共有された側の画面）。ヘルプは、リンクが公開に見えても情報は安全で他人には見えない、と説明する。

返品の案内の出方 [7-2][7-3][7-4]
- 返品の申請は注文ステータスページから（"Cancel items" / "Return items" / "Cancel or return"。対象の品だけ）。ログインは、メールアドレスに届く 6 桁のコードで行う（パスワード不要）。電話番号だけで買った人は SMS のリンクで入り、申請にメールアドレスの入力が必要。
- 返品が承認され、送り返しが要る場合は、「発送の案内と返品ラベル」がメールで届く。
- 管理画面で返品を作るときの "Return shipping" の選択肢は "Create a return label in Shopify"（出荷元と配送先が米国のときだけ）、"Upload a return label"、"No shipping required"（返品の送り返し情報なし）[7-4]。
- 注文ステータスページ上に、返品の送り返しの案内（"No shipping required" の文言など）がログイン前後でどう出るかは、公式ページに記載が見つからなかった（出典なし）。ヘルプが述べるのは、メールで届くことと、サンプル文を返金ポリシーのページに載せられることまで。

URL の扱い
- 注文ステータスページの URL は、共有されうる前提になっている（共有されても限られた情報だけ）[7-1]。
- Shopify の管理 API の `statusPageUrl`（注文ステータスページの URL）は、2024 年 3 月から「保護された顧客データのレベル 2」の承認がないアプリは読めない、という更新があった（検索結果の要約。更新履歴のページは取得できず未確認。二次）[7-5]。
- 分析ツールにこの URL を渡さないようにという Shopify の公式の指針: 見つからなかった（出典なし）。
- セキュリティ会社 Fox-IT の指摘（検索結果の要約。原ページは取得できず）では、注文ステータスページ用のスクリプトのサンプルが、ログインなしのページのソースに注文番号やメールアドレスを出す場合がある。結論として、お客さまにリンクを公開で共有しないよう案内するのがよい、としている（二次）[7-6]。
- Shopify の Web Pixels の `checkout_completed` では、2025-12-10 から、個人情報の項目は、アプリの承認範囲に応じて絞られる（カスタムピクセルは対象外）（検索結果の要約）[7-7]。

### Stripe
- 該当なし。

### 業界の定番
- Google アナリティクスの規約は、URL（パスとクエリ）にメールアドレスなどの個人情報を入れて送ってはいけない、としている [7-8]。URL 自体が「本人確認のかぎ」になっているページ（注文ステータスの URL など）を分析ツールに渡す危うさの根拠として使える。これは公式の規約の趣旨からの当てはめで、提案（出典なし）。

### 出典
- [7-1] https://help.shopify.com/en/manual/fulfillment/setup/order-status-page/understanding-order-status-pages （公式）
- [7-2] https://help.shopify.com/en/manual/fulfillment/managing-orders/returns/self-serve-returns/setup （公式）
- [7-3] https://help.shopify.com/en/manual/orders/self-serve-returns/return-rules （公式）
- [7-4] https://help.shopify.com/en/manual/fulfillment/managing-orders/returns/creating-returns （公式）
- [7-5] https://shopify.dev/changelog/level-2-protected-customer-data-requirements-are-now-needed-to-access-the-order-statuspageurl-field （検索結果にあった URL。取得すると 404 で未確認）
- [7-6] https://www.fox-it.com/nl-en/order-details-screens-and-pii/ （取得すると 403 で未確認。検索結果の要約）
- [7-7] https://shopify.dev/changelog/protected-customer-data-scopes-required （検索結果の要約。原ページは未取得）
- [7-8] https://support.google.com/analytics/answer/6366371 （Google アナリティクス ヘルプ）

---

## 8. メールのリンクの基準 URL（間違っていたら送らない方がよいか）

### Shopify の動き
- 「通知メールのリンクは必ず店のプライマリドメインを使う」という公式の記述は、見つからなかった（出典なし）。確認できたことだけ書く:
  - Liquid の `shop.domain` は "The primary domain of the store."、`shop.url` は "The full URL of the store."（プライマリドメインとは書かれていない）[8-1]。
  - 通知の標準テンプレートには、注文ステータスページへのリンクが自動で入る。カスタムしたテンプレートでは `{{ order_status_url }}` を自分で入れる [8-2]。
  - 「実際の注文では、メールのリンクが myshopify.com になる」という店主の書き込みが 1 件ある（解決は書かれていない。二次）[8-3]。
- よって「Shopify は常にプライマリドメイン」という前提は、このまま使わない方がよい。

### Stripe
- 該当なし。

### 業界の定番（セキュリティの標準資料）
- OWASP のパスワード忘れの手引き: 「リセット URL を作るときに Host ヘッダーに頼らない」「URL は固定（ハードコード）にするか、信頼するドメインの一覧と照合する」「HTTPS であること」[8-4]。
- パスワードリセットの汚染攻撃（password reset poisoning）: 攻撃者が Host ヘッダーを自分のドメインにして再設定を要求すると、サイトが Host からリンクを作る場合、被害者に届く本物のメールのリンクが攻撃者のサーバーを指し、トークンが盗まれる [8-5]。
- Supabase Auth の場合: 「Site URL」は標準で localhost:3000 になっており、本番の URL に変える必要がある。メールの確認とパスワード再設定にとって重要。リダイレクト先は「Redirect URLs」の許可リストに入っている URL だけ [8-6]。
- 設定の誤りを起動時に止める（fail fast）考え方: 必要な環境変数が足りないと、実行時にずっと奥でわかりにくいエラーになる。起動時の検査なら、リクエストを受ける前に気づける（Vercel Academy）[8-7]。
- 「間違った基準 URL ならメールを送らない」ことを名指しで勧める出典は見つからなかった（出典なし）。上の資料から言えるのは「基準 URL は設定から固定で取り、Host ヘッダーなど外から変えられる値は使わない」「起動時に検査する」までで、送信直前に止めるかどうかは出典のない判断。

### 提案（出典なし）
- 本番では、基準 URL が空・localhost・http・許可リスト外なら、起動時に止める（fail fast）。加えて、送信の直前にも同じ検査をして、パスワード再設定・ワンタイムコード・注文の照会のように「リンクが鍵になる」メールだけは、不正なら送らずに記録と通知を出す。開発とテストでは localhost を許す。

### 出典
- [8-1] https://shopify.dev/docs/api/liquid/objects/shop （公式）
- [8-2] https://help.shopify.com/manual/orders/status-tracking/order-status-email （公式。検索結果の要約）
- [8-3] https://community.shopify.com/t/my-mobile-text-receipts-has-link-to-my-home-page-instead-of-the-link-to-customers-order-detail/127180 （コミュニティ。二次）
- [8-4] https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html （OWASP）
- [8-5] https://portswigger.net/web-security/host-header/exploiting/password-reset-poisoning （PortSwigger）
- [8-6] https://supabase.com/docs/guides/auth/redirect-urls （Supabase 公式。検索結果の要約）
- [8-7] https://vercel.com/academy/slack-agents/boot-checks-and-health （Vercel Academy。検索結果の要約）

---

## 付録: 出典が見つからなかったことの一覧
1. Stocky 本体の発注書ステータス名。
2. 受注生産ブランド向けの発注（材料の手配など）の公式な手順。
3. Shopify の「初回注文だけ」割引の公式設定。ゲスト購入が顧客セグメントで数えられるか。
4. Stripe の `first_time_transaction` がゲストの Checkout で何を基準に判定するか。
5. アパレルのネット通販に限ったコンビニ払いの利用割合。
6. final sale の品を注文ステータスページでお客さまが見る文言の原文。final sale と不良品の関係の Shopify 公式の記載。
7. ヤマト・佐川・日本郵便が Shopify の注文ステータスページで自動更新の対象か。
8. 17TRACK の公式の単価表。
9. 注文ステータスページ上の返品の送り返し案内の出方（ログイン前後）。注文ステータス URL を分析ツールに出さないための Shopify の公式の指針。
10. 「Shopify の通知メールのリンクは常にプライマリドメイン」の公式の記述。
11. 受注生産品を返品不可にできると明記した消費者庁の記述。
