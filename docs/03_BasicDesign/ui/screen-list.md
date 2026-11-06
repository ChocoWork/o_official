# 画面一覧

> 返品の品ごとの返金 Task 3 確認日: 2026-11-06。画面ルートの数は変えない（51件）。注文の詳細の返品の欄から開く受け取りの画面（`OrderReturnReceiveDialog`）を、品ごとに「今すぐ返金 / 額を相談」を選ぶ形（見本 A）にした。末尾の「返品の受け取りの品ごとの返金（FREQ-641 / DD-ADMIN-019）」に記載。単体・画面結合と3幅の E2E（`FR-ADMIN-164`、18/18通過）は実測済み。調整役の手元の実行と結果は[テスト仕様](../../05_Quality/tests/test-spec.md)に記録。
>
> 波 6 確認日: 2026-11-01。パスワード変更の画面 `/account/password` の1ルートを追加し、`src/app/**/page.tsx` は51件になった（顧客向け18・認証・アカウント9・管理・開発補助24）。`/account` のお客様情報のタブに「パスワードを変更」のリンクを足した。本文の「47件」は50件の時点から数え直していなかったので、この行で51件に直した。実測（390/768/1280px）は E2E（`FR-ACCOUNT-046`）が3幅で確かめる。
>
> H Task 5 確認日: 2026-10-29。割引の管理画面で3ルート（`/admin/discounts/new`・`/admin/discounts/[id]`・`/admin/discounts/[id]/edit`）を追加し、`src/app/**/page.tsx` は50件になった（顧客向け18・認証・アカウント8・管理・開発補助24）。`/admin` に DISCOUNT タブを CONTACT の直後に足した（adminは13タブ、supporterは5タブ）。実測（390/768/1280px・E2E）はcontroller担当で未実行。

> 波 4 確認日: 2026-10-28。画面ルートの数は変えない（47件）。`/admin` に CONTACT タブを足し（adminは12タブ、supporterは4タブ）、LOOK の「新規作成」を役でなく権限（`meta.canManage`）で一覧が出す形にした。`/admin/stockist/create` は開いた時に `GET /api/admin/stockists/access` で権限を確かめてからフォームを出す。実測（390/768/1280px・E2E）は controller の本番ビルドの実行待ち。

> G-4 Task 8 確認日: 2026-10-27。画面ルートの数は変えない（47件）。荷作り表（`/admin/packing`）の注文IDと発送票の頁（`/admin/shipment-slips/[id]`）の注文番号を、注文の詳細（`/admin/orders/[id]`）への Link にした。荷作り表から注文の履歴を dialog で開く入口は撤去した。実測（390/768/1280px・E2E）はcontroller担当で未実行。

> G-4 Task 7 確認日: 2026-10-26。注文一覧表（`/admin/orders`）の1ルートを追加し、`src/app/**/page.tsx` は47件になった（顧客向け18・認証・アカウント8・管理・開発補助21）。ORDER タブは注文一覧表への入口だけになり、旧い一覧・各 dialog・旧CSVは撤去した。実測（390/768/1280px・E2E）はcontroller担当で未実行。

> G-4 Task 6 確認日: 2026-10-26。注文の詳細（`/admin/orders/[id]`）の1ルートを追加し、`src/app/**/page.tsx` は46件になった。注文一覧表（`/admin/orders`）は G-4 Task 7 で追加するので、この時点では戻るリンクの移動先がない（旧 `/admin?tab=ORDER` の一覧・dialog・handler は Task 7 まで残る）。本文の「45件」「16ルート」は Task 7 の後に数え直す。実測（390/768/1280px・E2E）はcontroller担当で未実行。

> 状態: 全画面ルートと導線・表示条件をレビュー | 確認日: 2026-10-26（波1-Aで未使用の `/auth/callback` ページを削除。以下の日付は各項の反映日）、2026-10-03（購入の行は2026-10-07、E-5は2026-10-22、G-1 の旧配送の入口の撤去は2026-10-24に、G-2 Task 3 の在庫一覧表と Task 4 の発注の入力・確認・確定と Task 5 の発注一覧表・発注書の頁と Task 6 の発注書の頁の操作と Task 7 の受け取りとその取消・数量訂正と Task 8 の取引書類の節と書類検索と G-3 Task 3 の荷作り表と Task 4 の発送票の頁（下書き）と Task 6 の発送の取消と Task 7 の伝票番号の入力・訂正と手動の配達済みは2026-10-25に反映） | 根拠: `src/app/**/page.tsx` 47件（顧客向け18・認証・アカウント8・管理・開発補助21。2026-10-26 に数え直し、G-0 の権限画面と G-2 の発注一覧表・発注書の頁・取引書類の検索と G-3 の荷作り表・発送票の頁と G-4 の注文一覧表・注文の詳細を足した） | G-3 Task 9 確認: 2026-10-26（修正前はfresh reset・12 suite・639/639成功、Fix round 1は再検証対象）

## 概要

`page.tsx` が定義する画面ルートを1ルート1行で示す。[画面遷移図](screen-flow.md)と対応し、リンクの入口・出口、同じルート内の状態、現在の表示条件を記録する。角括弧の `[id]` は実行時の識別子に置き換わる。ルートの存在と、画面表示・API操作の許可はそれぞれの実装で確認する。

## 顧客向け画面（18ルート）

| パス | 画面・役割 | 導線・同一画面内の状態 | 実装 |
| --- | --- | --- | --- |
| `/` | ホーム | ITEM・LOOK・NEWSの一覧と詳細、ABOUT、検索へ移動。検索プレビューと取扱店カードも表示 | [page.tsx](../../../src/app/page.tsx) |
| `/about` | ブランド紹介 | ITEM、LOOK一覧へのリンク | [page.tsx](../../../src/app/about/page.tsx) |
| `/news` | NEWS一覧 | `category` の複数選択で同じルートを更新。詳細へ選択カテゴリを引き継ぐ | [page.tsx](../../../src/app/news/page.tsx) |
| `/news/[id]` | NEWS詳細 | 一覧、カテゴリ絞り込み、前後の記事へ移動。対象記事がなければ `notFound()` | [[id]/page.tsx](../../../src/app/news/%5Bid%5D/page.tsx) |
| `/item` | 商品一覧 | カテゴリ・サイズ・色・在庫・コレクション・価格等の絞り込み、並び替え、追加読込。商品カードから詳細へ移動 | [page.tsx](../../../src/app/item/page.tsx) |
| `/item/[id]` | 商品詳細 | 色・サイズを選択しカート追加・保存後も同画面。関連商品へ移動。取得エラー時は商品一覧へ戻るリンク | [[id]/page.tsx](../../../src/app/item/%5Bid%5D/page.tsx) |
| `/look` | LOOK一覧 | `season` で絞り込み。LOOK詳細、関連商品詳細へ移動 | [page.tsx](../../../src/app/look/page.tsx) |
| `/look/[id]` | LOOK詳細 | 一覧、関連商品、前後のLOOKへ移動。対象LOOKがない場合は同じルートに未存在表示 | [[id]/page.tsx](../../../src/app/look/%5Bid%5D/page.tsx) |
| `/stockist` | 取扱店 | `pref` の都道府県複数選択で絞り込み。住所のGoogle Maps、電話の `tel:` リンク | [page.tsx](../../../src/app/stockist/page.tsx) |
| `/contact` | お問い合わせ | 入力・送信エラー、送信完了メッセージと通知モーダルを同画面に表示 | [page.tsx](../../../src/app/contact/page.tsx) |
| `/order-status/[token]` | ご注文の状況 | メールから公開情報を表示。認可後だけ個人情報。登録・問い合わせ・会員の注文へ案内 | [page.tsx](../../../src/app/order-status/%5Btoken%5D/page.tsx)、[ページ仕様](../../04_DetailDesign/pages/20_order_status.md) |
| `/search` | サイト内検索 | `q`・`tab` を更新し同じルートで検索。結果から商品・LOOK・NEWS詳細へ移動。LOAD MOREは同画面の追加表示 | [page.tsx](../../../src/app/search/page.tsx) |
| `/wishlist` | ウィッシュリスト | 商品詳細へ移動。保存解除・カート追加は同画面。空状態から商品一覧へ移動 | [page.tsx](../../../src/app/wishlist/page.tsx) |
| `/cart` | カート | 数量変更・削除は同画面。商品詳細、商品一覧、購入手続きへ移動。空状態からも商品一覧へ移動 | [page.tsx](../../../src/app/cart/page.tsx) |
| `/checkout` | 注文・決済 | ゲスト購入。入力画面の「確認へ進む」でSessionを作り、Stripeの部品を置く最終確認画面へ進む。「注文する」で受付・支払い・完了を行い、外部認証からの復帰も同ルートで扱う。最終確認・完了後もURLに`session_id`を残す（D9）。完了から商品一覧・アカウント・ゲスト登録へ移動。空カートは同画面に案内 | [page.tsx](../../../src/app/checkout/page.tsx)、[FinalConfirmationStep](../../../src/app/checkout/_components/FinalConfirmationStep.tsx) |
| `/privacy` | プライバシーポリシー | お問い合わせへのリンク | [page.tsx](../../../src/app/privacy/page.tsx) |
| `/terms` | 利用規約 | 規約本文を表示。ページ固有のルートリンクなし | [page.tsx](../../../src/app/terms/page.tsx) |
| `/legal` | 法定表記 | お問い合わせへのリンク | [page.tsx](../../../src/app/legal/page.tsx) |

## 認証・アカウント画面（9ルート）

| パス | 画面・役割 | 導線・同一画面内の状態 | 実装 |
| --- | --- | --- | --- |
| `/login` | ログイン・会員登録 | メール・パスワードとGoogleログイン。`tab=register`・`email` は登録フォーム初期値。有効な検証待ちCookieがある場合とメールログイン成功時はOTP確認へ。登録受付完了は同画面 | [page.tsx](../../../src/app/login/page.tsx) |
| `/login/verify` | ログインメールOTP確認 | 8桁OTP、再送、エラーを表示。成功後の認証再確認で一般利用者はアカウント、admin/supporterは認証確認へ。再確認が未認証ならログイン、通信例外ならアカウントへ。検証セッションなし・再送401・やり直す操作もログインへ | [page.tsx](../../../src/app/login/verify/page.tsx) |
| `/auth/verified` | 認証確認・特権ユーザーのTOTP | 一般利用者はアカウントへ自動遷移。admin/supporterはMFA確認済みなら直ちに管理へ、未確認ならTOTP登録・確認後に管理へ。未認証はログイン案内リンク | [page.tsx](../../../src/app/auth/verified/page.tsx) |
| `/auth/password-reset` | パスワード再設定 | メール送信、リンクエラー、新パスワード入力、更新完了を同画面に表示。送信・更新完了からログインへ。errorクエリは案内後に除去 | [page.tsx](../../../src/app/auth/password-reset/page.tsx) |
| `/auth/password-reset/verify` | 再設定リンク確認 | `token` をPOSTで確認し再設定画面へ。token不在・確認失敗もエラー付き再設定URLへ。通信例外では同画面の再試行とログイン案内 | [page.tsx](../../../src/app/auth/password-reset/verify/page.tsx) |
| `/account` | アカウント情報 | プロフィール・配送先・注文・問い合わせの4タブ。注文詳細へ移動。未ログインは案内リンク、ログアウト成功はホームへ。各編集・返信は同画面 | [page.tsx](../../../src/app/account/page.tsx) |
| `/account/password` | パスワード変更（波 6 / SEC-AUTH-034） | `/account` のお客様情報のタブのリンクから開く2段（1 現行パスワード → 確認コードをメールに送る、2 8桁のコードと新しいパスワード〔16文字以上・UTF-8で72バイト以内〕）。成功すると全端末の session が失効するので、ログインの状態を引き直して `/login` へ。段1に Google だけの会員向けの案内と `/auth/password-reset` へのリンクを固定で出す。未ログインは案内だけを出し、戻り先つきの `/login` へ。`robots: noindex` | [page.tsx](../../../src/app/account/password/page.tsx)、[フォーム](../../../src/app/account/password/PasswordChangeForm.tsx) |
| `/account/orders/[id]` | 注文詳細 | 自分の注文を取得し、`/account?tab=orders` に戻る。お問い合わせ、条件付き外部配送追跡へ。再度購入はカート追加後も同画面。商品行の予約注文分岐は下の補足を参照。未ログインは案内リンク | [[id]/page.tsx](../../../src/app/account/orders/%5Bid%5D/page.tsx) |
| `/account/orders/[id]/return` | 返品・交換のお申し込み | 注文詳細の「返品・交換を申し込む」から開く3段（商品を選ぶ・内容を確かめる・お申し込みの受付）。受付の状態が closed・ended・none の注文は文と「注文の画面に戻る」だけ。未ログインは案内リンク。受け付けた段から注文詳細へ戻れる | [return/page.tsx](../../../src/app/account/orders/%5Bid%5D/return/page.tsx) |

[注文商品の共通表示](../../../src/features/account/components/OrderItemRow.tsx)には、`itemId` があり `stockStatus=sold_out` の商品から `/contact?subject=予約注文：{商品名}` へ進む分岐がある。ただし現行の注文詳細APIは `stockStatus` を返さないため、注文詳細での表示条件は成立しない。contactはこのクエリから件名を初期入力しない。

## 管理・開発補助画面（24ルート）

個別フォームの画面表示と操作APIの認可は[表示条件の表](#画面表示と操作権限)を参照する。

| パス | 画面・役割 | 導線・同一画面内の状態 | 実装 |
| --- | --- | --- | --- |
| `/admin` | 管理タブ | adminはKPI・ACCOUNTING・NEWS・ITEM・LOOK・STOCKIST・USER・ORDER・INVENTORY・PACKING・CONTACT・DISCOUNT・SETTINGS（13タブ。H Task 5 で DISCOUNT を CONTACT の直後に足した）、supporterはORDER・INVENTORY・PACKING・CONTACT・DISCOUNT（5タブ）。DISCOUNTタブは割引の一覧（`DiscountSection`）を店長とsupporterの両方に開く（権限の無い人には一覧が「割引を見る権限がありません。」を出す）。CONTACTタブは管理のお問い合わせ（`ContactSection`）を店長とsupporterの両方に同じ中身で開く（波4・2026-10-28。PACKINGの次、SETTINGSの前）。LOOKタブの右上の「新規作成」ボタンは外し、一覧が権限（`meta.canManage`）で出す（下の `/admin/look/create`）。`tab` は初期選択、タブ操作は同画面の状態変更。INVENTORYタブは店長とsupporterの両方に同じ中身（`nav` 「在庫・発注メニュー」の「在庫一覧表」「発注一覧表」リンク）。PACKINGタブも店長とsupporterの両方に同じ中身（`nav` 「荷作りメニュー」の「荷作り表」リンク）。ORDERタブも店長とsupporterの両方に同じ中身で、`nav` 「注文メニュー」の「注文一覧表」リンク（`/admin/orders`）だけ（G-4 Task 7。旧い一覧・各 dialog・旧CSVは無い。サイドナビのORDERのバッジ〔要対応の件数〕とKPIの「（ORDER で確認）」の帯は残る）。KPIからMeta OAuthへ。ACCOUNTING・固定資産の添付証憑は閲覧API経由で別タブに開く。権限なし・MFA未確認も同画面に案内 | [page.tsx](../../../src/app/admin/page.tsx) |
| `/admin/create-user` | ユーザー作成フォーム | 専用入口リンクは未確認。成功時は入力を初期化し同画面に留まる。専用の戻るリンクなし | [page.tsx](../../../src/app/admin/create-user/page.tsx) |
| `/admin/inventory` | 在庫一覧表（G-2 / FREQ-525） | `/admin` のINVENTORYタブの「在庫一覧表」から移動。「管理画面に戻る」は `/admin`。同画面で「在庫の内訳」を行ごとに開閉。読込中・権限なし（403）・2要素認証が必要・ログインし直し（401）・読込失敗・空は同じURLの表示で、権限なしと失敗では表とボタンを出さない。同画面で「発注」から発注モード（各行に「発注数量」）→「発注書確認」→「発注書の確認」（発注先・メモ）→「発注確定」の3段（G-2 Task 4 / FREQ-526。通信は確定の1回だけで、成功すると `/admin/purchase-orders/[id]?created=1` へ移り、通知は移動先の頁が出す）。移動先の発注書の頁と、タブの「発注一覧表」のリンク先 `/admin/purchase-orders` は G-2 Task 5 の行に記す | [page.tsx](../../../src/app/admin/inventory/page.tsx)、[AdminInventorySection](../../../src/components/AdminInventorySection.tsx) |
| `/admin/purchase-orders` | 発注一覧表（G-2 Task 5 / FREQ-526） | `/admin` のINVENTORYタブの「発注一覧表」から移動。リンク「取引書類を検索」（`/admin/purchase-orders/documents`。G-2 Task 8 の行に記す）・「在庫一覧表」（`/admin/inventory`）・「管理画面に戻る」（`/admin`）。明細ごとの行を 発注書番号（発注書の頁へのリンク）・商品名・色・サイズ・発注数量・納品済み・未納 の7列で見る（「打切り」の列は無い）。数量確定前の行は発注数量と未納が「数量未確定」。20行ごとの頁送り（「前へ」「次へ」と「1〜20 / 45」の形の範囲）は同じURLの状態。読込中・権限なし（403）・2要素認証が必要・ログインし直し（401）・読込失敗・空（「発注書はまだありません。」）は同じURLの表示で、権限なしと失敗では表と頁送りを出さない | [page.tsx](../../../src/app/admin/purchase-orders/page.tsx)、[PurchaseOrderListSection](../../../src/components/PurchaseOrderListSection.tsx) |
| `/admin/purchase-orders/[id]` | 発注書の詳細（G-2 Task 5 / FREQ-526） | 発注一覧表の発注書番号、または在庫一覧表の発注確定（`?created=1` つき）から移動。「発注一覧表に戻る」は `/admin/purchase-orders`。h1「発注書 ○○」・発注先・メモ・発注日・段階、明細の表、数量確定後だけ「単価未登録」「証憑未添付」のバッジと「発注見込額 ¥…」（「税の扱いは書類に従います」を添える）、数量の履歴・受け取りの履歴・取引書類の節。`?created=1` がある時は、読み込んだ発注書の番号で作成の通知を出す。読込中・権限なし（403）・2要素認証が必要・ログインし直し（401）・見つからない（404）・読込失敗は同じURLの表示。操作（G-2 Task 6 / FREQ-527・528）: 数量確定待ちは「数量確定」（ダイアログ「数量の確定」）と「発注を取り消す」（ダイアログ「発注の取消」）、数量確定後は「数量を訂正」（ダイアログ「数量の訂正」）、どの段階でも「発注先・メモを訂正」（ダイアログ「発注先・メモの訂正」）。数量確定後は未納のある行のチェック欄と「未納のある行をすべて選ぶ」で行を選び、選んだ時だけ「残りを打ち切る」（ダイアログ）。成功すると通知を出して発注書を読み直し、版の競合は本文を出して読み直す。受け取りと取消（G-2 Task 7 / FREQ-529）: 数量確定後で未納のある行がある時だけ「全部受け取る」（ダイアログ「全部を受け取る」）と「一部を受け取る」（ダイアログ「一部を受け取る」）。受け取りの履歴の、取り消せる数が残る受取には「この受け取りを取り消す」（ダイアログ「受け取りの取消」）と「数量を訂正」（ダイアログ「受け取り数量の訂正」）。外す割当があると取消・訂正のダイアログは確認の段（本文「割り当て済みの品を○点外し、受注生産中に戻します。」）に移り、確認の後に送り直す。取引書類（G-2 Task 8 / FREQ-530）: 節の見出し「取引書類」の下に「書類を追加」（ダイアログ「書類を追加」。種類・取引日・金額（円）・取引先・ファイル）、書類の一覧（種類・ファイル名・取引日・金額・取引先、無効はバッジ「無効」と理由）、各書類の「表示」「ダウンロード」「印刷」（60秒の署名つきリンクを新しいタブ／保存で開く）「情報を訂正」「差し替える」「無効にする」（理由必須。無効の書類に「無効にする」は無い）、保存が終わっていないファイルは見出し「保存が終わっていないファイル」に「続きから保存」（期限を過ぎた予約は「期限を過ぎています。内容を確認してください。」）。保存・訂正・無効化の後は通知を出して発注書を読み直す | [[id]/page.tsx](../../../src/app/admin/purchase-orders/%5Bid%5D/page.tsx)、[PurchaseOrderDetailSection](../../../src/components/PurchaseOrderDetailSection.tsx)、[PurchaseOrderDocumentsSection](../../../src/components/PurchaseOrderDocumentsSection.tsx) |
| `/admin/purchase-orders/documents` | 取引書類の検索（G-2 Task 8 / FREQ-530） | 発注一覧表のリンク「取引書類を検索」から移動。「発注一覧表に戻る」は `/admin/purchase-orders`。h1「取引書類の検索」。条件は 取引日（から・まで）・金額（円）（から・まで）・取引先・発注書番号・種類・「訂正前の情報も探す」で、ボタンは「検索」「条件をクリア」「印刷」（結果の表を `window.print()` で印刷し、条件欄・ボタン・頁送りは印刷しない）。結果の列は 発注書番号（発注書の頁へのリンク）・種類・ファイル名・取引日・金額（円）・取引先・状態（有効／無効／訂正前）・原本（各行の「原本を見る」。60秒の署名つきリンクを新しいタブで開く。印刷しない）。50件ごとの頁送り（「前へ」「次へ」と「1〜50 / 120」の形の範囲）は同じURLの状態。読込中・権限なし（403。「取引書類を見る権限がありません。」）・2要素認証が必要・ログインし直し（401）・読込失敗・空（「該当する書類はありません。」）は同じURLの表示 | [page.tsx](../../../src/app/admin/purchase-orders/documents/page.tsx)、[PurchaseOrderDocumentSearchSection](../../../src/components/PurchaseOrderDocumentSearchSection.tsx) |
| `/admin/packing` | 荷作り表（G-3 Task 3 / FREQ-531） | `/admin` のPACKINGタブの「荷作り表」から移動（`nav` 「荷作りメニュー」。店長とsupporterの両方）。「管理画面に戻る」は `/admin?tab=PACKING`。h1「荷作り表」。発送準備中の品物を古い注文から 選択欄（見出しは視覚的に隠す「選択」）・注文ID・注文日・顧客名・メールアドレス・商品名・色・サイズ・数量・単価 で見る（G-3 Task 4 で選択欄・「今回送る数」・「発送」を足した）。行を選ぶと、数量の下に「今回送る数」の入力（初期値は準備中の数）が出る。1行目を選ぶと、同じお客様・同じ配送先でない行（`bundleKey` が違う行・無い行）の選択欄が無効になり、行の下に「同じお客様・同じ配送先の注文だけ同梱できます」を出す（全部外すと戻る）。選べない行（阻害理由のある行）も選択欄は無効。「発送」は選択が1行以上で送る数が有効な時だけ押せ、押すと発送票の下書きを作って `/admin/shipment-slips/[id]` へ移る。操作（manage）の権限が無い人は、荷作り表の答えの `canManage` が false なので、最初の描画から選択欄と「発送」が無く「発送票を作る権限がありません。」が1回出る（表は見える）。答えの後で権限が外れた人は、「発送」の返事が権限の不足の 403 だった時に同じ形になる。CSRF の失敗・2要素認証が必要な 403 は権限が無いことにせず、その文（再読み込みを促す文など）を出して操作を残す。注文IDは注文番号の Link（`/admin/orders/[id]`。G-4 Task 8。以前の履歴のダイアログを開くボタンは撤去した）。交換の品は「交換の品」、選べない行は理由の文、別の下書きにも選ばれている行は「別の発送票（番号）にも選ばれています」を行の下に出す。50行ごとの頁送り（「前の頁」「次の頁」と「1〜50 / 120」の形の範囲）は同じURLの状態（選んだ行は頁をまたいで残る）。下に「発送票の下書き」「確定済みの発送票」（各最新20件。「開く」は `/admin/shipment-slips/[id]`）。読込中・権限なし（403）・2要素認証が必要・ログインし直し（401）・読込失敗・空（「発送準備中の品物はありません。」）は同じURLの表示で、権限なしでは表も下の一覧も出さない | [page.tsx](../../../src/app/admin/packing/page.tsx)、[PackingSection](../../../src/components/PackingSection.tsx) |
| `/admin/shipment-slips/[id]` | 発送票（G-3 Task 4 / FREQ-531〜533。下書きの表示と編集） | 荷作り表の「発送」（成功で移動。「下書きを保存しました。」を1回出す）、または荷作り表の下の「開く」から移動。「荷作り表に戻る」は `/admin/packing`。h1「発送票 SL-…」、状態の文字（下書き／発送済み／取消済み／破棄済み。期限切れの下書きは「期限切れ」を足す）。下書きは「同梱する品物」の表（注文ID・顧客名・商品名・色・サイズ・送る数・今の準備中の数・「この行を外す」。行ごとの問題の文は行の下、票全体の問題は表の上）、「品物を追加」（同梱できる候補だけの表。選んで「追加」）、「送り先」、「下書きを破棄」（確かめのダイアログ「この下書きを破棄しますか。」の「破棄する」「戻る」）。外す・追加は選択を丸ごと入れ替えて通知「下書きを保存しました。」を出し、版が違えば表の文を出して入力を保ったまま読み直す。通信の結果が分からない時は「もう一度確かめる」で同じ要求を送り直す。確定済みの伝票番号・配達済み・出荷日の訂正は後続Task。取消済み・破棄済みの票は品物の表と送り先だけを出す。発送済みは下記Task 5の発送の記録と、Task 6の「発送を取り消す」も出す。読込中・権限なし（403）・見つからない（404）・読込失敗は同じURLの表示 | [page.tsx](../../../src/app/admin/shipment-slips/%5Bid%5D/page.tsx)、[ShipmentSlipSection](../../../src/components/ShipmentSlipSection.tsx) |
| `/admin/orders` | 注文一覧表（G-4 Task 7 / FREQ-536・538・539-AC-05） | `/admin` のORDERタブの「注文一覧表」から移動（`nav` 「注文メニュー」。店長とsupporterの両方）。「管理画面に戻る」は `/admin?tab=ORDER`。h1「注文一覧表」と説明。上に、メール停止の帯・要対応の欄（`id="attention"`。「もう一度返金する」は `/admin/orders/[id]?open=refund`、返品の返金のそれは `?open=returns`、配送の「履歴を開く」は `/admin/orders/[id]#order-history`。「もう一度返金する」は店長だけ、配送の「対応済みにする」は店長とsupporter）と要対応の一行（返品の申し込み N件・返金待ち N件・キャンセルの申し込み N件。0件は出さず、押すとその状態の1つだけに絞り込み、もう一度押すと外す）を置く。絞り込みのフォーム「注文の絞り込み」（注文日〔から・まで。初めて開いた時は空＝全期間〕・注文ID〔ORD-… または pi_…〕・顧客名・メールアドレス・商品名・色・サイズ・ステータス（12の状態のトグル）・要対応のみ）は「絞り込む」を押すまで読み直さず、「条件をクリア」で全部消す。日付が逆なら「期間指定が不正です。開始日は終了日以前にしてください。」を出して読まない。「CSV出力」（説明「現在の絞り込みに合う全行を出力します。」）は絞り込みに合う全行を窓口から取る。品物ごとの12列の表（見出しを保つスクロール領域）を20行ずつ出し、件数の行（「N行（M件の注文）」。新しい5000件の注文で切った時は「N行（新しいM件の注文の中で）」と上限の注記）と「前の頁」「次の頁」を置く（読み直しの間は前の頁の表・件数・注記・頁送りを出したままにし、`aria-busy`）。行の押下・Enter/Space・注文IDの Link で `/admin/orders/[id]` へ移る。適用した条件と頁は URL に載せず、このタブの sessionStorage に持ち、詳細から戻ると復元する。読込中・権限なし（403）・読込失敗・空（「条件に一致する品物はありません。」）は同じURLの表示 | [page.tsx](../../../src/app/admin/orders/page.tsx)、[AdminOrderItemListSection](../../../src/components/AdminOrderItemListSection.tsx)、[AdminOrderItemTable](../../../src/components/AdminOrderItemTable.tsx)、[useOrderAttention](../../../src/hooks/useOrderAttention.ts) |
| `/admin/orders/[id]` | 注文の詳細（G-4 Task 6 / FREQ-539・FREQ-523-AC-05） | 戻る Button「注文一覧表へ戻る」は `/admin/orders`。注文一覧表（行の押下・Enter/Space・注文IDの Link と、要対応の欄の「もう一度返金する」〔`?open=refund`・`?open=returns`〕・「履歴を開く」〔`#order-history`〕）からこの頁へ進む（G-4 Task 7）。荷作り表の注文IDと発送票の注文番号の Link からもこの頁へ進む（G-4 Task 8）。h1「注文 ORD-…」。h2 を `注文情報`・`支払いと返金`・`品物`・`発送`・`返品とキャンセルの申し込み`・`要対応`・`変更履歴`（`id="order-history"`）の順に並べ、各欄は名前が見出しの文字の region。操作は返事の `permissions` と `summary` の旗だけで出す: `返金`・`キャンセル`（支払いと返金の欄。未入金は manage、支払い済みは refund）、返品のボタン（`申し込みを確かめる`・`額を決めて返金する`〔refund が無い人には出さない〕・`受け取る`・`返品`）と `キャンセルの申し込み`（返品とキャンセルの申し込みの欄）、`確認済みにする`（要対応の欄。manage）、`割り当てを入れ替える`（品物の表。allocate、受注生産中で補足が在庫の入荷待ちだけの行）。それぞれ今の dialog（返金・支払い済みのキャンセル・取消・返品・キャンセルの申し込み）と入替 dialog を同じ画面の上に開く。発送の欄は注文別の発送と発送票 Link（`/admin/shipment-slips/[id]`）、`荷作り表を開く`（`/admin/packing`。shippingRead）だけで、発送の操作は置かない。要対応の欄の支払い・配送の要対応は Link「要対応の一覧で対応する」（`/admin/orders#attention`）。変更履歴の欄は従来の履歴を埋め込み、先頭に「品物の状態の変化」を出す（ボタンで開く dialog ではない）。`?open=refund`・`returns`・`cancel-request` は最初の読込の後に、その操作を出せる注文の時だけ対応する dialog を開いて query を消す（出せない注文・知らない値は何もしない）。操作の成功・結果不明・dialog を閉じた時は詳細と履歴を読み直し、読み直しに失敗すると前の詳細を残して「最新の状態を読み込めませんでした。」「この画面の内容は最新ではありません。」「読み込み直す」を出す。読込中・権限なし（403）・見つからない（404）・読込失敗は同じURLの表示 | [page.tsx](../../../src/app/admin/orders/%5Bid%5D/page.tsx)、[AdminOrderDetailSection](../../../src/components/AdminOrderDetailSection.tsx)、[AdminOrderItemsTable](../../../src/components/AdminOrderItemsTable.tsx)、[AllocationSwapDialog](../../../src/components/AllocationSwapDialog.tsx)、[OrderHistoryPanel](../../../src/components/OrderHistoryPanel.tsx) |
| `/admin/discounts/[id]` | 割引の詳細（H Task 5 / FREQ-547） | DISCOUNTタブの一覧の割引名から移動。「一覧に戻る」は `/admin?tab=DISCOUNT`。設定の要約、manage権限の人だけ「止める」「再開する」「複製」（成功で停止中の新しい詳細へ）「編集」「割り当てを足す」（会員を選ぶ窓。390pxは全画面で右上の×）「確認済みにする」（計算の要対応）を出す。割り当ての表（コード・割り当てた人・状態・使った日・注文）は20行ずつで、未使用の行だけ「外す」。注文は `/admin/orders/[id]` へのLink。読込中・権限なし・見つからない・取得失敗（読み直す）は同じURLの表示 | [[id]/page.tsx](../../../src/app/admin/discounts/%5Bid%5D/page.tsx)、[DiscountDetail](../../../src/features/discounts/components/DiscountDetail.tsx)、[DiscountAssignments](../../../src/features/discounts/components/DiscountAssignments.tsx)、[DiscountMemberPicker](../../../src/features/discounts/components/DiscountMemberPicker.tsx) |
| `/admin/discounts/new` | 割引の作成（H Task 5 / FREQ-547） | DISCOUNTタブの「割引を作る」から移動。種類（5つ）に合わせて欄を出し分け、保存成功で作った割引の詳細へ。使い捨ての束はコードの先頭の文字と個数（会員を選ぶと人数）まで同じ画面で行う | [new/page.tsx](../../../src/app/admin/discounts/new/page.tsx)、[DiscountForm](../../../src/features/discounts/components/DiscountForm.tsx)、[DiscountFormScreen](../../../src/features/discounts/components/DiscountFormScreen.tsx) |
| `/admin/discounts/[id]/edit` | 割引の編集（H Task 5 / FREQ-547） | 詳細の「編集」から移動。詳細を読んでからフォームを出し、manage権限が無ければ権限の文だけ。使用後は名前・期間・回数の上限・前もって知らせる・案内文だけ編集でき、ほかはdisabledと説明。保存成功で詳細へ | [edit/page.tsx](../../../src/app/admin/discounts/%5Bid%5D/edit/page.tsx)、[DiscountForm](../../../src/features/discounts/components/DiscountForm.tsx) |
| `/admin/item/create` | 商品作成 | ITEMタブから移動。保存成功・キャンセルで `/admin?tab=ITEM` へ | [page.tsx](../../../src/app/admin/item/create/page.tsx) |
| `/admin/item/edit/[id]` | 商品編集 | ITEM一覧の編集から移動。保存成功・キャンセルで `/admin?tab=ITEM` へ。取得失敗は同画面に表示 | [[id]/page.tsx](../../../src/app/admin/item/edit/%5Bid%5D/page.tsx) |
| `/admin/look/create` | LOOK作成 | LOOKタブの一覧の上の「新規作成」から移動（`GET /api/admin/looks` の `meta.canManage` が true の時だけ出す。0件の表示の上にも出す。権限は役でなく `admin.looks.manage` で決まる。波4・2026-10-28、ADR-0166）。保存成功・キャンセルで `/admin?tab=LOOK` へ | [page.tsx](../../../src/app/admin/look/create/page.tsx) |
| `/admin/look/edit/[id]` | LOOK編集 | LOOK一覧の編集から移動。保存成功・キャンセルで `/admin?tab=LOOK` へ。取得失敗は同画面に表示 | [[id]/page.tsx](../../../src/app/admin/look/edit/%5Bid%5D/page.tsx) |
| `/admin/news/create` | NEWS作成 | NEWSタブから移動。保存成功・キャンセルで `/admin?tab=NEWS` へ | [page.tsx](../../../src/app/admin/news/create/page.tsx) |
| `/admin/news/edit/[id]` | NEWS編集 | NEWS一覧の編集から移動。保存成功・キャンセルで `/admin?tab=NEWS` へ。取得失敗は同画面に表示 | [[id]/page.tsx](../../../src/app/admin/news/edit/%5Bid%5D/page.tsx) |
| `/admin/settings/permissions` | 権限（G-0 / FREQ-519） | `/admin` のSETTINGSタブの「権限」から移動。「管理画面に戻る」は `/admin?tab=SETTINGS`。`GET /api/admin/permissions` の成功後だけ表を表示（直URLでも同じ） | [page.tsx](../../../src/app/admin/settings/permissions/page.tsx)、[RolePermissionsSection](../../../src/components/RolePermissionsSection.tsx) |
| `/admin/stockist/create` | 取扱店作成 | STOCKISTタブから移動。開いた時に `GET /api/admin/stockists/access` で権限を確かめ（波4・2026-10-28、ADR-0269）、通るまで「読み込み中...」、204でフォーム、401は「ログインが必要です」、403は「STOCKISTを作成する権限がありません」、それ以外と通信の失敗は「権限の確認に失敗しました」を1行出す。保存成功で `/admin?tab=STOCKIST` へ。キャンセル・戻るボタンなし | [page.tsx](../../../src/app/admin/stockist/create/page.tsx) |
| `/admin/stockist/edit/[id]` | 取扱店編集 | STOCKIST一覧の編集から移動。保存成功で `/admin?tab=STOCKIST` へ。取得失敗は同画面に表示。キャンセル・戻るボタンなし | [[id]/page.tsx](../../../src/app/admin/stockist/edit/%5Bid%5D/page.tsx) |
| `/ui` | UIコンポーネントギャラリー | 共通ヘッダーのUIメニューから移動。デモの選択・開閉は同画面。描画済みデモに専用のルートリンクなし | [page.tsx](../../../src/app/ui/page.tsx) |
| `/loading` | LOADINGデザインギャラリー | 共通ヘッダーのadmin向けメニューから移動。コピー・開閉・再生は同画面。専用のルートリンクなし | [page.tsx](../../../src/app/loading/page.tsx) |

## 画面表示と操作権限

| 対象 | 現在のページ側の表示条件 | データ・操作との区別 |
| --- | --- | --- |
| 顧客向け18ルート、`/ui` | ログインを必須にするページ表示ガードなし。カート・購入はゲストにも提供 | データ取得・入力検証・決済可否は各APIで判断する。空カートのcheckoutは同じURLに案内を表示 |
| `/login`・`/login/verify` | 検証待ちCookieの有無・有効性でOTP確認への移動／ログインへの戻りを判断 | メール・パスワードの検証とOTPの検証はAPIで実行する |
| `/auth/verified` | 未認証は同じURLの案内、一般利用者はアカウントへ、特権ロールはTOTP確認へ | MFA済みの特権ロールは管理へ直行する。未認証案内のリンクは利用者が押して移動する |
| `/account`・注文詳細・`/account/password` | 認証確認中は読込、未ログインは同じURLのログイン案内（`/account/password` は戻り先つきの `/login` へ送る案内）。ロール限定なし | [注文詳細API](../../../src/app/api/orders/%5Bid%5D/route.ts)は認証と注文所有者の一致を確認する |
| `/admin` | 認証確認中は読込。未ログイン・admin/supporter以外は権限なし。MFA未確認は2要素認証案内。いずれも同じURLに留まる | ロールで表示タブ・操作候補が変わり、操作APIでも認可を確認する |
| 管理の8作成・編集ルート、`/admin/create-user` | ページ・フォーム固有のログイン／ロール／MFA表示ガードなし。編集ページの取得失敗は同じURLのエラー表示 | フォーム表示は操作許可を意味しない。[管理API認可](../../../src/lib/auth/admin-rbac.ts)で認証、セッション、DBのACL権限、AAL2を確認する |
| `/admin/inventory` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/inventory` の返事（200で表、403で「在庫一覧を見る権限がありません。」、MFAなしの403で「2要素認証が必要です」、401で「ログインし直してください。」、その他は読込失敗）で決める | 窓口が `admin.stock.read` を、DBの関数も実行者の権限を確かめる。表の読込は読むだけ。発注の確定（`POST /api/admin/purchase-orders`）は `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read` を窓口とDBの関数の両方が確かめ、ボタン「発注」は役割では隠さない（権限が無い人は確定で「発注を扱う権限がありません。」） |
| `/admin/purchase-orders`・`/admin/purchase-orders/[id]` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/purchase-orders`・`GET /api/admin/purchase-orders/[id]` の返事（200で表示、403で「発注一覧を見る権限がありません。」／「発注書を見る権限がありません。」、MFAなしの403で「2要素認証が必要です」、401で「ログインし直してください。」、発注書の頁の404で「発注書が見つかりません。」、その他は読込失敗）で決める | 窓口が `admin.purchase_orders.read` だけを、DBの関数も実行者の権限を確かめる（`manage` は要らない）。読むだけで、CSRF・回数制限・監査は無い。`admin.items.*` や在庫の権限だけの人は403。発注書の頁の操作（数量の確定・訂正、打切り、取消、発注先・メモの訂正。G-2 Task 6）は窓口 `PATCH /api/admin/purchase-orders/[id]`・`POST …/quantities`・`POST …/short-closures` が `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read` を要し、足りない人には 403 の文「発注を扱う権限がありません。」を操作の画面に出す（ボタンは権限で出し分けない）。CSRF・回数制限・監査あり |
| `/admin/purchase-orders/documents` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/purchase-order-documents` の返事（200で表示、403で「取引書類を見る権限がありません。」、MFAなしの403で「2要素認証が必要です」、401で「ログインし直してください。」、その他は読込失敗）で決める | 窓口が `admin.purchase_orders.read` だけを、DBの関数も実行者の権限を確かめる（`manage` は要らない）。読むだけで、CSRF・回数制限・監査は無い。取引書類の原本を見る・保存するリンク（`GET …/attachments/[attachmentId]/url`）も `admin.purchase_orders.read` で、回数制限あり（リンクは60秒で、記録しない）。書類の追加・訂正・差し替え・無効化・続きから保存（G-2 Task 8）は `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read` を要し、足りない人には 403 の文「発注を扱う権限がありません。」を操作の画面に出す（ボタンは権限で出し分けない）。CSRF・回数制限・監査あり |
| `/admin/packing` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/packing` の返事（200で表、403で「荷作り表を見る権限がありません。」、MFAなしの403で「2要素認証が必要です」、401で「ログインし直してください。」、その他は読込失敗）で決める | 窓口が `admin.shipping.read` ＋ `admin.orders.read` の両方を、DBの関数も実行者の権限を確かめる（表を読むだけなら `manage` は要らない）。読むだけの窓口に、CSRF・回数制限・監査は無い。下の発送票の一覧（`GET /api/admin/shipment-slips`）も同じ組。注文IDの Link で開く注文の詳細（履歴の欄を含む）は `admin.orders.read` で、票へのリンクは発送の権限があるときだけ付く。「発送」（`POST /api/admin/shipment-slips`）は `admin.shipping.manage` ＋ `read` ＋ `admin.orders.manage` ＋ `read` の4つすべてを窓口とDBで確かめ、CSRF・回数制限・監査を通す。権限の無い返事（403）では選択欄と「発送」を片付ける |
| `/admin/shipment-slips/[id]` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/shipment-slips/[id]` の返事（200で票、403で「発送票を見る権限がありません。」、MFAなしの403で「2要素認証が必要です」、401で「ログインし直してください。」、404で「発送票が見つかりません。」、その他は読込失敗）で決める | 読取は荷作り表と同じ `shipping.read` ＋ `orders.read`。外す・追加（`POST …/draft`）と破棄（`POST …/discard`）は4権限すべてを窓口とDBで確かめ、CSRF・回数制限・監査を通す。足りない時の返事は表の固定の文（「発送を扱う権限がありません。」）で、画面は読み直さず文だけを出す |
| `/admin/orders` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/order-items` の返事（200で表、403で「注文一覧を見る権限がありません。」、その他は「注文一覧を読み込めませんでした。」）で決める | 読取（一覧・CSV）は `admin.orders.read` を窓口とDBで確かめる。CSV（`GET /api/admin/order-items/export`）は回数制限あり。要対応の欄の操作は従来の窓口の認可（`admin.orders.manage` など）・CSRF・回数制限のまま。「もう一度返金する」の入口は店長だけに渡し、押した先の詳細頁が `permissions` の旗で改めて出し分ける（入口を隠すだけにしない） |
| `/admin/orders/[id]` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/orders/[id]` の返事（200で詳細、403で「注文を見る権限がありません。」、404で「注文が見つかりません。」、その他は「注文を読み込めませんでした。」）で決める | 読取は `admin.orders.read` を窓口とDBで確かめる。操作の入口は返事の `permissions`（read・manage・refund・return・allocate・shippingRead）と `summary` の旗で決め、役割名では決めない。サポーターは返金・支払い済みのキャンセル・割当の入替の入口が出ない。各操作は従来の窓口の認可・CSRF・回数制限のまま（入口を隠すだけにしない）。発送票の Link は `slips` が null の人には出さず「発送票を見る権限がありません。」を出す |
| `/admin/discounts/[id]`・`/admin/discounts/new`・`/admin/discounts/[id]/edit` | ページ側のログイン／ロール／MFA表示ガードなし。詳細と編集は窓口 `GET /api/admin/discounts/[id]` の返事（200で表示、403で「割引を見る権限がありません。」、404で「割引が見つかりません。」、その他は「割引を読み込めませんでした。」）で決め、編集と作成は応答の `permissions.manage` が無ければ操作を出さない | 読取は `admin.discounts.read`、書込は `admin.discounts.manage` を窓口とDBで確かめる。画面の出し分けは許可を意味しない |
| `/loading` | 認証確認中は読込。未ログイン・admin以外は同じURLの権限なし表示。ページ側のMFA確認なし | メニューの表示条件とページ自体のadmin確認を両方実装している |
| 共通レイアウト・proxy | [Providers](../../../src/contexts/Providers.tsx)は全画面に共通ナビを配置。[admin/layout](../../../src/app/admin/layout.tsx)はスタイル制御。[proxy](../../../src/proxy.ts)には画面のログイン・ロールによるリダイレクトなし | proxyはAPI変更リクエストのOrigin検査、セキュリティヘッダー、セッション識別Cookieを扱う |

## 同じルート内の状態とクエリ

> FREQ-418・421 により、購入の入力画面と最終確認画面を分け、完了後も `session_id` を URL に残す形へ変更した。

| ルート | クエリ・状態 | URL・画面数への扱い |
| --- | --- | --- |
| `/news`・NEWS詳細 | `category`：カンマ区切りの複数カテゴリ。未指定はALL | 一覧の絞り込みは同じルート。選択を詳細・一覧へ戻るリンク・前後の記事へ引き継ぐ |
| `/item` | `category`、`collection`、`size`、`color`、`stock`、`collectionYearMin`、`collectionYearMax`、`collectionSeasons`、`priceMin`、`priceMax`、`sort` | フィルタ・並び順は同じルートのクエリ。追加読込の `page`・`pageSize` は `/api/items` のリクエスト用で、独立した画面や一覧URLのページ遷移ではない |
| `/look` | `season` | 同じ一覧ルートのシーズン選択 |
| `/stockist` | `pref`：カンマ区切りの都道府県 | 地方・都道府県の選択を同じルートに反映 |
| `/search` | `q`、`tab=all/item/look/news` | 検索・結果種別の切替でクエリをreplace。追加表示・入力候補は同画面内の状態 |
| `/login` | `tab=register`、`email` | 初期タブと登録メール初期値。タブ操作後のURLは両方 `/login`。フォーム送信結果は同画面 |
| `/auth/password-reset` | `error=link_invalid/link_expired` | 案内を表示後にクエリを除去。メール入力・新パスワード入力・送信／更新完了も同じルート |
| `/auth/password-reset/verify` | `token` | 自動確認の入力。確認結果に応じて再設定画面へ移動 |
| `/account` | `tab=profile/shipping/orders/inquiries` | 無指定・未知値はprofile。`address` はshippingへ正規化。タブ切替でreplaceし、他のクエリを保持 |
| `/checkout` | `session_id`、入力・最終確認・完了・エラー | 開き直し・外部認証からの復帰はresumeを照会。支払い済みならcomplete、開いていれば最終確認、ほかは入力へ進む。最終確認・完了後も`session_id`をURLに残す（FREQ-421・D9）。最終確認画面の埋め込み決済、完了表示、エラー境界も同じルート |
| `/admin/orders` | クエリなし。絞り込みの値・頁は URL に載せない | 画面の state と、このタブの sessionStorage（キー `admin-order-list-state`。適用した条件と頁だけ。読み書きは try/catch で包み、使えなくても動く）に持ち、詳細から戻って開き直すと復元する（個人情報を URL にしない） |
| `/admin` | `tab`、`meta`、`meta_reason`、各タブの一覧・編集・確認状態 | tabは許可された初期タブを選ぶ。サイドナビ操作はURLを書き換えない。Meta callbackは結果をクエリに付与して同じadminルートへ戻す |

上表は画面のURLと状態の対応を示す。クエリがあることだけで、その絞り込みをサーバー・クライアントのどちらが処理するかや、全データに適用されることを保証しない。該当ページと描画コンポーネントを根拠とする。

## ルート数とレビュー方法

- `src/app/**/page.tsx` の全51件を棚卸しし、この一覧と[1つの画面遷移図](screen-flow.md#全画面遷移図)に各1件ずつ対応させる。
- ページから描画されるコンポーネントのリンク・ルーター操作、認証APIと外部サービスからの戻り先、表示ガード、クエリ更新を確認する。共通ナビは[Providers](../../../src/contexts/Providers.tsx)、[Header](../../../src/components/Header.tsx)、[Footer](../../../src/components/Footer.tsx)を確認する。
- `error.tsx`、API Route Handler、外部サービス、タブやダイアログは独立した画面ルート数に加えない。詳細ページ間の `[id]` 変更は画面遷移として図示するが、同じルート定義の1件に数える。
- `AdminTabs`・`AdminSideNav` の型にあるCONTACTは、波4（2026-10-28）から `/admin` の表示タブ配列に含まれる。現在表示するadminの13タブ（INVENTORYはORDERの次、PACKINGはINVENTORYの次、CONTACTはPACKINGの次、DISCOUNTはCONTACTの次、SETTINGSは最後）とsupporterのORDER・INVENTORY・PACKING・CONTACT・DISCOUNTを記録する。

## 主な実装根拠

| 分類 | 確認元 |
| --- | --- |
| 公開画面の絞り込み・詳細 | [PublicItemGrid](../../../src/features/items/components/PublicItemGrid.tsx)、[PublicLookGrid](../../../src/features/look/components/PublicLookGrid.tsx)、[PublicNewsGrid](../../../src/features/news/components/PublicNewsGrid.tsx)、[PublicStockistGrid](../../../src/features/stockist/components/PublicStockistGrid.tsx)、[SearchPageClient](../../../src/features/search/components/SearchPageClient.tsx)、[RelatedItems](../../../src/features/items/components/RelatedItems.tsx) |
| 認証 | [LoginContext](../../../src/contexts/LoginContext.tsx)、[AuthTabs](../../../src/components/AuthTabs.tsx)、[OTP確認](../../../src/app/login/verify/VerifyOtpClient.tsx)、[再設定リンク確認](../../../src/app/auth/password-reset/verify/VerifyClient.tsx)、[認証シーケンス](../../04_DetailDesign/sequence/auth-login-mfa.md) |
| 注文・アカウント | [ゲスト登録案内](../../../src/features/checkout/components/GuestRegisterPrompt.tsx)、[再度購入](../../../src/features/account/hooks/useReorder.ts)、[配送業者](../../../src/lib/orders/shipping-carriers.ts)、[問い合わせタブ](../../../src/components/AccountInquiries.tsx)、[注文商品行](../../../src/features/account/components/OrderItemRow.tsx) |
| 管理の戻り先 | [ItemForm](../../../src/app/admin/item/ItemForm.tsx)、[LookForm](../../../src/app/admin/look/LookForm.tsx)、[NewsForm](../../../src/app/admin/news/NewsForm.tsx)、[StockistForm](../../../src/app/admin/stockist/StockistForm.tsx) |
| 管理タブ・Meta | [AdminTabs](../../../src/components/AdminTabs.tsx)、[AdminSideNav](../../../src/components/AdminSideNav.tsx)、[Meta接続UI](../../../src/components/MetaKpiConnection.tsx)、[Meta callback](../../../src/app/api/admin/kpi/meta/callback/route.ts)、[ACCOUNTING](../../../src/components/CostProfitSection.tsx)、[証憑閲覧API](../../../src/app/api/admin/kpi/cost-profit/receipt/route.ts) |

## 未確認事項

本レビューは現行ソースの棚卸しであり、本番の公開URL・配置設定、実データでの全画面表示・全ロール操作、外部サービス側の動作は実行検証していない。`/admin/create-user` の通常導線における意図された入口は未確認で、既存の出口・画面内状態は記録した。

## 配送の状況（E-4 / FREQ-488〜497）

[配送の詳細設計](../../superpowers/specs/2026-10-21-delivery-status-design.md)・[実装計画](../../superpowers/plans/2026-10-21-delivery-status.md)を参照。以下は実装後の契約であり、既存の決定の本文は履歴として残す。

G-1停止（Task 15、2026-10-24）: 注文の履歴の「伝票番号を直す」「配達済みにする」と2つのdialog、一覧の「発送済みにする」「仕上がりを記録する」、履歴の「この発送を取り消す」は撤去した。G-3 で、一覧の表の上は「発送は荷作り表から行います。」と「荷作り表を開く」（`/admin/packing`）、履歴の上は「発送・発送取消・伝票番号の訂正・手動の配達済みは、発送票から行います。」に置き換えた（履歴の発送の行には、票に属する発送なら「発送票 ○○ を開く」を出す）。下の表の2つの操作は移行前の契約。

E-4 の新しいページURLは0。既存の38画面ルートを維持し、以下を同じルート内の状態として追加する。

| 既存画面 | 追加する表示・操作 |
| --- | --- |
| `/admin` の注文・注文履歴 | 配送の出来事・番号の直し、履歴内の「伝票番号を直す」「配達済みにする」dialog。要対応の「配送」から同じ履歴を開く |
| `/admin` のSETTINGS | 配送の追跡、鍵の有無・対象件数・オン/オフの確認。店長だけ |
| `/account/orders/[id]` | 発送ごとのお届け日、条件に合う現版の状況と移り変わり、新番号の追跡リンク、配達済みの進み具合 |
| `/privacy` | ショップの追跡オンの時だけ17TRACKの委託の文 |

dialogから戻った時は履歴の操作位置へフォーカスを戻し、保存や結果不明では履歴・一覧を再取得する。詳細な表示条件はaccount/admin/privacyの設計とAPI仕様を参照。

## 注文の状況の画面（E-5 / FREQ-498〜505）

[詳細設計](../../superpowers/specs/2026-10-22-order-status-page-design.md)・[実装計画](../../superpowers/plans/2026-10-22-order-status-page.md)・[ページ仕様](../../04_DetailDesign/pages/20_order_status.md)を参照。

新しい `/order-status/[token]` を顧客向けへ1ルート追加し、全39ルート・顧客向け18ルート。公開情報の後に専用GETで個人情報を追加する同一画面内の状態を持つ。確認期限後も公開は残す。取り消した注文は表示し、隠す2状態と存在しない注文は同じ404。

| 対象 | 行き先 |
| --- | --- |
| ログイン | `/login` |
| 持ち主以外の登録 | `/login?tab=register`。同じメールで登録しメール確認 |
| 問い合わせ | `/contact?type=order&order={orderNumber}`。入力済みで開き編集可能 |
| 持ち主の申し込み | `/account/orders/{id}`。このページは返品・キャンセルの記録だけを表示 |

## 発送票の確認と確定（G-3 Task 5）

下書きに「荷物の情報」を表示する。運送会社（未定・ヤマト運輸・佐川急便・日本郵便）・伝票番号・出荷日（JSTの今日）・「お客様に発送のメールを送る」（初期オン）を入力し「発送票確認」で確認へ進む。issuesがある間は確認不可。「発送票の確認」は注文ごとの品物と数、送り先、荷物の情報を並べ、「発送確定」・「戻る」を出す。戻っても入力を保つ。

確定は `POST /api/admin/shipment-slips/[id]/confirm`。二重押下は通信1回。同じ内容の再押下・通信不明の「もう一度確かめる」は同じ要求番号と本文、内容変更は新しい要求番号。確定を断られたら確認画面を閉じて票を読み直し、表と問題を表示する。問題がある間は確認・確定へ進めない。版競合でも入力を保つ。成功は「発送を確定しました。」を出して票を読み直す。確定済みは出荷日・発送した時刻・伝票（なければ「伝票番号は未入力です」）・注文ごとの発送と配達状況・「出荷日の履歴」・「荷物の履歴」を表示する。発送した時刻と両履歴の時刻は、発注書の管理画面と同じ日本時間のYYYY/MM/DD HH:mmで出す。後続操作のボタンはまだ追加しない。

[画面単体](../../../tests/unit/components/ShipmentSlipSection.test.tsx)と[確定窓口単体](../../../tests/unit/api/admin/shipment-slip-confirm-route.test.ts)で検証する。DB・実ブラウザ・3幅の確認はcontrollerの担当。

## 発送の取消（G-3 Task 6）

確定済みの票（発送済み）に「発送を取り消す」を出す（下書き・取消済み・破棄済みには出さない）。押すとダイアログ「発送を取り消す」を開く。説明は「票に含まれるすべての注文の発送を取り消し、品物を発送準備中に戻します。」、ボタンは「取り消す」「戻る」。`cancelBlockers` を持つ票は、ボタンの上に「注文 ○○ は返品の対象です」「注文 ○○ は発送後に返金済みです」「注文 ○○ は取り消せない状態です」を先に出す（ボタンは押せ、DB が最終の判断をする）。DB が断った時（返品・発送後の返金・取り消せない状態・版の競合など）は、表の本文をダイアログの中に出して開いたまま票を読み直し、票は変えない。送信中は閉じず、二重に押しても通信は1回。結果が分からない時は「結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。」と「もう一度確かめる」を出し、同じ本文・同じ要求番号で送り直す。成功は「発送を取り消しました。」を出してダイアログを閉じ、票を読み直して状態「取消済み」にする。窓口は `POST /api/admin/shipment-slips/[id]/cancel`（[APIの主要契約](../api/api-spec.md)）。

[取消のダイアログ単体](../../../tests/unit/components/ShipmentSlipCancelDialog.test.tsx)と[票の頁単体](../../../tests/unit/components/ShipmentSlipSection.test.tsx)で検証する。実ブラウザ・390/768/1280pxの確認はcontrollerの担当。

## 伝票番号の入力・訂正と手動の配達済み（G-3 Task 7）

確定済みの票（発送済み）に「伝票番号を直す」（伝票番号が無い票は「伝票番号を入れる」）と「配達済みにする」を出す（下書き・取消済み・破棄済みには出さない。「配達済みにする」は、有効な発送のどれかがすでに配達済みの票にも出さない）。「伝票番号を直す」のダイアログは、運送会社（今の値で始まる。まだ無い票は何も選ばれておらず、選ぶまで送れない）・伝票番号・「お客様に更新のメールを送る」（初期オン）、説明「票に含まれるすべての注文に反映します。」、ボタン「直す」（番号が無い票は「入れる」）「戻る」。運送会社と伝票番号は両方必須で、空では送れない（空には戻せない）。「配達済みにする」のダイアログは、「届いた日」（初期値は日本時間の今日）・「お客様に配達済みのメールを送る」（初期オン）、説明「票に含まれるすべての注文を配達済みにします。」、ボタン「配達済みにする」「戻る」。どちらも DB が断った時（同じ値・すでに配達済み・届いた日の範囲・版の競合など）は表の本文をダイアログの中に出し、入力を保ったまま開いておき、票を読み直す。送信中は閉じず、二重に押しても通信は1回。結果が分からない時は「もう一度確かめる」で同じ本文・同じ要求番号を送り直す。成功は「伝票番号を更新しました。」「配達済みにしました。」を出してダイアログを閉じ、票を読み直す。窓口は `POST /api/admin/shipment-slips/[id]/tracking`・`POST /api/admin/shipment-slips/[id]/delivered`（[APIの主要契約](../api/api-spec.md)）。

[伝票番号のダイアログ単体](../../../tests/unit/components/ShipmentSlipTrackingDialog.test.tsx)・[配達済みのダイアログ単体](../../../tests/unit/components/ShipmentSlipDeliveredDialog.test.tsx)・[票の頁単体](../../../tests/unit/components/ShipmentSlipSection.test.tsx)で検証する。実ブラウザ・390/768/1280pxの確認はcontrollerの担当。

## 発送票の出荷日訂正（G-3 Task 9）

確認日: 2026-10-26。確定済みの票で詳細GETのcanCorrectDateがtrueなら「出荷日を訂正する」。falseなら「出荷日の訂正は店長だけができます。」。ダイアログは新しい出荷日・必須理由、説明「お客様の返品期限は変わりません。」、訂正する／戻る。履歴は初回／訂正・前後日付・理由・日時。[管理画面詳細](../../04_DetailDesign/pages/16_admin.md)を参照。ブラウザ実測は未実行。

Task 5 fix round 1（2026-10-29）: DISCOUNT一覧の「使った回数」と「上限」は2列に分けた合計7列（controller受け入れ）。作成画面もmanageを確認してから入力を出す。

## 返品の受け取りの品ごとの返金（FREQ-641 / DD-ADMIN-019）

確認日: 2026-11-06。根拠は[設計書](../../superpowers/specs/2026-11-06-return-receive-per-item-design.md)3章。ルートは増やさない（`/admin/orders/[id]` の返品の欄から開く dialog「受け取る（返品の番号）」）。

| 部分 | 表示と条件 |
| --- | --- |
| 品の行（list「受け取る品」） | 1点1行。「届いた」・「品の状態」のすぐ下に、radiogroup「返金」の「今すぐ返金」「額を相談」を置く（最初は今すぐ返金）。出すのは、チェックして状態を選んだ返金の品（解決が返金の品と、交換を「返金に変える」にした品）だけ。状態が未選択・お返し・交換の品には出さない。ラジオの name は品ごとに分ける |
| 今すぐ返金（n点） | 権限「返金」を持つ人: 内訳（今すぐの品の商品・手数料・送料・返金額）、入力「返金額」と「上限 ￥X」（X = min(注文の返せる額, 今すぐの品の額＋送料)。input の max も X）、入力「送料（返せる送料: ￥Y）」。X を超えた額は丸めず、欄の下に「この受け取りの商品の額と送料（￥X）を超えて入れられません。ほかの受け取りの分は、返品の画面の「額を決めて返金する」で返してください。」を出し（aria-invalid・aria-describedby で結ぶ）、直るまで押せない。持たない人で P9（お客様の申し込みの返品で返送不要でない）の時: 「受け取ると、計算どおり ￥X を自動で返金します（額は変えられません）。」だけ |
| 額を相談（m点） | 相談にした品の名前の list「額を相談の品」と「返金待ちになります。額はあとで「額を決めて返金する」で決めます。」 |
| 権限で出し分け | 権限「返金」（窓口の `canRefund`）を持つ人は選びと額・送料の入力。持たない人で P9 の時は選びだけ（今の選びに関わらず出す。今すぐの分の見込みが注文の返せる額を超える時は押せなくし、一部を「額を相談」にするよう文を出す）。それ以外は選びも入力も出さず「返金は店長が行います（受け取ると「返金待ち」になります）。」で、全部の品を相談として送る |
| 確定のボタン | 今すぐと相談が両方ある時は「受け取る（n点を ￥X 返金・m点は相談）」（0円も同じ形）。片方だけの時は今までの言葉（「すべて受け取って ￥X を返金する」「受け取りだけ記録する（…）」など） |

[受け取りの画面単体](../../../tests/unit/components/OrderReturnReceiveDialog.test.tsx)・[サポートの受け取り単体](../../../tests/unit/components/OrderReturnReceiveDialogSupport.test.tsx)・[返金の欄の部品単体](../../../tests/unit/components/return-dialog-parts.test.tsx)・[画面結合](../../../tests/integration/ui/admin-return-receive.test.tsx)で検証する。390/768/1280px は E2E `FR-ADMIN-164` で18/18通過（2026-11-06、調整役の手元の実行・ログ保管。[テスト仕様](../../05_Quality/tests/test-spec.md)参照）。
