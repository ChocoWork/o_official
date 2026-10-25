# 画面一覧

> 状態: 全画面ルートと導線・表示条件をレビュー | 確認日: 2026-10-03（購入の行は2026-10-07、E-5は2026-10-22、G-1 の旧配送の入口の撤去は2026-10-24に、G-2 Task 3 の在庫一覧表と Task 4 の発注の入力・確認・確定と Task 5 の発注一覧表・発注書の頁と Task 6 の発注書の頁の操作と Task 7 の受け取りとその取消・数量訂正と Task 8 の取引書類の節と書類検索と G-3 Task 3 の荷作り表は2026-10-25に反映） | 根拠: `src/app/**/page.tsx` 45件（顧客向け18・認証・アカウント9・管理・開発補助18。2026-10-25 に数え直し、G-0 の権限画面と G-2 の発注一覧表・発注書の頁・取引書類の検索と G-3 の荷作り表を足した）

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
| `/auth/callback` | 認証コールバック状態表示 | 通常の入口参照は未確認。`code` ありはAPI callbackへ転送。codeなし・認証済みなら `next`（既定は認証確認）へ。失敗時はログイン案内リンク | [page.tsx](../../../src/app/auth/callback/page.tsx) |
| `/auth/verified` | 認証確認・特権ユーザーのTOTP | 一般利用者はアカウントへ自動遷移。admin/supporterはMFA確認済みなら直ちに管理へ、未確認ならTOTP登録・確認後に管理へ。未認証はログイン案内リンク | [page.tsx](../../../src/app/auth/verified/page.tsx) |
| `/auth/password-reset` | パスワード再設定 | メール送信、リンクエラー、新パスワード入力、更新完了を同画面に表示。送信・更新完了からログインへ。errorクエリは案内後に除去 | [page.tsx](../../../src/app/auth/password-reset/page.tsx) |
| `/auth/password-reset/verify` | 再設定リンク確認 | `token` をPOSTで確認し再設定画面へ。token不在・確認失敗もエラー付き再設定URLへ。通信例外では同画面の再試行とログイン案内 | [page.tsx](../../../src/app/auth/password-reset/verify/page.tsx) |
| `/account` | アカウント情報 | プロフィール・配送先・注文・問い合わせの4タブ。注文詳細へ移動。未ログインは案内リンク、ログアウト成功はホームへ。各編集・返信は同画面 | [page.tsx](../../../src/app/account/page.tsx) |
| `/account/orders/[id]` | 注文詳細 | 自分の注文を取得し、`/account?tab=orders` に戻る。お問い合わせ、条件付き外部配送追跡へ。再度購入はカート追加後も同画面。商品行の予約注文分岐は下の補足を参照。未ログインは案内リンク | [[id]/page.tsx](../../../src/app/account/orders/%5Bid%5D/page.tsx) |
| `/account/orders/[id]/return` | 返品・交換のお申し込み | 注文詳細の「返品・交換を申し込む」から開く3段（商品を選ぶ・内容を確かめる・お申し込みの受付）。受付の状態が closed・ended・none の注文は文と「注文の画面に戻る」だけ。未ログインは案内リンク。受け付けた段から注文詳細へ戻れる | [return/page.tsx](../../../src/app/account/orders/%5Bid%5D/return/page.tsx) |

[注文商品の共通表示](../../../src/features/account/components/OrderItemRow.tsx)には、`itemId` があり `stockStatus=sold_out` の商品から `/contact?subject=予約注文：{商品名}` へ進む分岐がある。ただし現行の注文詳細APIは `stockStatus` を返さないため、注文詳細での表示条件は成立しない。contactはこのクエリから件名を初期入力しない。

## 管理・開発補助画面（16ルート）

個別フォームの画面表示と操作APIの認可は[表示条件の表](#画面表示と操作権限)を参照する。

| パス | 画面・役割 | 導線・同一画面内の状態 | 実装 |
| --- | --- | --- | --- |
| `/admin` | 管理タブ | adminはKPI・ACCOUNTING・NEWS・ITEM・LOOK・STOCKIST・USER・ORDER・INVENTORY・PACKING・SETTINGS、supporterはORDER・INVENTORY・PACKING。`tab` は初期選択、タブ操作は同画面の状態変更。INVENTORYタブは店長とsupporterの両方に同じ中身（`nav` 「在庫・発注メニュー」の「在庫一覧表」「発注一覧表」リンク）。PACKINGタブも店長とsupporterの両方に同じ中身（`nav` 「荷作りメニュー」の「荷作り表」リンク）。KPIからMeta OAuthへ。ACCOUNTING・固定資産の添付証憑は閲覧API経由で別タブに開く。権限なし・MFA未確認も同画面に案内 | [page.tsx](../../../src/app/admin/page.tsx) |
| `/admin/create-user` | ユーザー作成フォーム | 専用入口リンクは未確認。成功時は入力を初期化し同画面に留まる。専用の戻るリンクなし | [page.tsx](../../../src/app/admin/create-user/page.tsx) |
| `/admin/inventory` | 在庫一覧表（G-2 / FREQ-525） | `/admin` のINVENTORYタブの「在庫一覧表」から移動。「管理画面に戻る」は `/admin`。同画面で「在庫の内訳」を行ごとに開閉。読込中・権限なし（403）・2要素認証が必要・ログインし直し（401）・読込失敗・空は同じURLの表示で、権限なしと失敗では表とボタンを出さない。同画面で「発注」から発注モード（各行に「発注数量」）→「発注書確認」→「発注書の確認」（発注先・メモ）→「発注確定」の3段（G-2 Task 4 / FREQ-526。通信は確定の1回だけで、成功すると `/admin/purchase-orders/[id]?created=1` へ移り、通知は移動先の頁が出す）。移動先の発注書の頁と、タブの「発注一覧表」のリンク先 `/admin/purchase-orders` は G-2 Task 5 の行に記す | [page.tsx](../../../src/app/admin/inventory/page.tsx)、[AdminInventorySection](../../../src/components/AdminInventorySection.tsx) |
| `/admin/purchase-orders` | 発注一覧表（G-2 Task 5 / FREQ-526） | `/admin` のINVENTORYタブの「発注一覧表」から移動。リンク「取引書類を検索」（`/admin/purchase-orders/documents`。G-2 Task 8 の行に記す）・「在庫一覧表」（`/admin/inventory`）・「管理画面に戻る」（`/admin`）。明細ごとの行を 発注書番号（発注書の頁へのリンク）・商品名・色・サイズ・発注数量・納品済み・未納 の7列で見る（「打切り」の列は無い）。数量確定前の行は発注数量と未納が「数量未確定」。20行ごとの頁送り（「前へ」「次へ」と「1〜20 / 45」の形の範囲）は同じURLの状態。読込中・権限なし（403）・2要素認証が必要・ログインし直し（401）・読込失敗・空（「発注書はまだありません。」）は同じURLの表示で、権限なしと失敗では表と頁送りを出さない | [page.tsx](../../../src/app/admin/purchase-orders/page.tsx)、[PurchaseOrderListSection](../../../src/components/PurchaseOrderListSection.tsx) |
| `/admin/purchase-orders/[id]` | 発注書の詳細（G-2 Task 5 / FREQ-526） | 発注一覧表の発注書番号、または在庫一覧表の発注確定（`?created=1` つき）から移動。「発注一覧表に戻る」は `/admin/purchase-orders`。h1「発注書 ○○」・発注先・メモ・発注日・段階、明細の表、数量確定後だけ「単価未登録」「証憑未添付」のバッジと「発注見込額 ¥…」（「税の扱いは書類に従います」を添える）、数量の履歴・受け取りの履歴・取引書類の節。`?created=1` がある時は、読み込んだ発注書の番号で作成の通知を出す。読込中・権限なし（403）・2要素認証が必要・ログインし直し（401）・見つからない（404）・読込失敗は同じURLの表示。操作（G-2 Task 6 / FREQ-527・528）: 数量確定待ちは「数量確定」（ダイアログ「数量の確定」）と「発注を取り消す」（ダイアログ「発注の取消」）、数量確定後は「数量を訂正」（ダイアログ「数量の訂正」）、どの段階でも「発注先・メモを訂正」（ダイアログ「発注先・メモの訂正」）。数量確定後は未納のある行のチェック欄と「未納のある行をすべて選ぶ」で行を選び、選んだ時だけ「残りを打ち切る」（ダイアログ）。成功すると通知を出して発注書を読み直し、版の競合は本文を出して読み直す。受け取りと取消（G-2 Task 7 / FREQ-529）: 数量確定後で未納のある行がある時だけ「全部受け取る」（ダイアログ「全部を受け取る」）と「一部を受け取る」（ダイアログ「一部を受け取る」）。受け取りの履歴の、取り消せる数が残る受取には「この受け取りを取り消す」（ダイアログ「受け取りの取消」）と「数量を訂正」（ダイアログ「受け取り数量の訂正」）。外す割当があると取消・訂正のダイアログは確認の段（本文「割り当て済みの品を○点外し、受注生産中に戻します。」）に移り、確認の後に送り直す。取引書類（G-2 Task 8 / FREQ-530）: 節の見出し「取引書類」の下に「書類を追加」（ダイアログ「書類を追加」。種類・取引日・金額（円）・取引先・ファイル）、書類の一覧（種類・ファイル名・取引日・金額・取引先、無効はバッジ「無効」と理由）、各書類の「表示」「ダウンロード」「印刷」（60秒の署名つきリンクを新しいタブ／保存で開く）「情報を訂正」「差し替える」「無効にする」（理由必須。無効の書類に「無効にする」は無い）、保存が終わっていないファイルは見出し「保存が終わっていないファイル」に「続きから保存」（期限を過ぎた予約は「期限を過ぎています。内容を確認してください。」）。保存・訂正・無効化の後は通知を出して発注書を読み直す | [[id]/page.tsx](../../../src/app/admin/purchase-orders/%5Bid%5D/page.tsx)、[PurchaseOrderDetailSection](../../../src/components/PurchaseOrderDetailSection.tsx)、[PurchaseOrderDocumentsSection](../../../src/components/PurchaseOrderDocumentsSection.tsx) |
| `/admin/purchase-orders/documents` | 取引書類の検索（G-2 Task 8 / FREQ-530） | 発注一覧表のリンク「取引書類を検索」から移動。「発注一覧表に戻る」は `/admin/purchase-orders`。h1「取引書類の検索」。条件は 取引日（から・まで）・金額（円）（から・まで）・取引先・発注書番号・種類・「訂正前の情報も探す」で、ボタンは「検索」「条件をクリア」「印刷」（結果の表を `window.print()` で印刷し、条件欄・ボタン・頁送りは印刷しない）。結果の列は 発注書番号（発注書の頁へのリンク）・種類・ファイル名・取引日・金額（円）・取引先・状態（有効／無効／訂正前）・原本（各行の「原本を見る」。60秒の署名つきリンクを新しいタブで開く。印刷しない）。50件ごとの頁送り（「前へ」「次へ」と「1〜50 / 120」の形の範囲）は同じURLの状態。読込中・権限なし（403。「取引書類を見る権限がありません。」）・2要素認証が必要・ログインし直し（401）・読込失敗・空（「該当する書類はありません。」）は同じURLの表示 | [page.tsx](../../../src/app/admin/purchase-orders/documents/page.tsx)、[PurchaseOrderDocumentSearchSection](../../../src/components/PurchaseOrderDocumentSearchSection.tsx) |
| `/admin/packing` | 荷作り表（G-3 Task 3 / FREQ-531） | `/admin` のPACKINGタブの「荷作り表」から移動（`nav` 「荷作りメニュー」。店長とsupporterの両方）。「管理画面に戻る」は `/admin?tab=PACKING`。h1「荷作り表」。発送準備中の品物を古い注文から 注文ID・注文日・顧客名・メールアドレス・商品名・色・サイズ・数量・単価 の9列で見る（読むだけ。選択欄と「発送」は後続Task）。注文IDは注文番号のボタンで、押すと注文の履歴のダイアログを開く。交換の品は「交換の品」、選べない行は理由の文、別の下書きにも選ばれている行は「別の発送票（番号）にも選ばれています」を行の下に出す。50行ごとの頁送り（「前の頁」「次の頁」と「1〜50 / 120」の形の範囲）は同じURLの状態。下に「発送票の下書き」「確定済みの発送票」（各最新20件。「開く」は `/admin/shipment-slips/[id]`。移動先の頁は後続Task）。読込中・権限なし（403）・2要素認証が必要・ログインし直し（401）・読込失敗・空（「発送準備中の品物はありません。」）は同じURLの表示で、権限なしでは表も下の一覧も出さない | [page.tsx](../../../src/app/admin/packing/page.tsx)、[PackingSection](../../../src/components/PackingSection.tsx) |
| `/admin/item/create` | 商品作成 | ITEMタブから移動。保存成功・キャンセルで `/admin?tab=ITEM` へ | [page.tsx](../../../src/app/admin/item/create/page.tsx) |
| `/admin/item/edit/[id]` | 商品編集 | ITEM一覧の編集から移動。保存成功・キャンセルで `/admin?tab=ITEM` へ。取得失敗は同画面に表示 | [[id]/page.tsx](../../../src/app/admin/item/edit/%5Bid%5D/page.tsx) |
| `/admin/look/create` | LOOK作成 | LOOKタブから移動。保存成功・キャンセルで `/admin?tab=LOOK` へ | [page.tsx](../../../src/app/admin/look/create/page.tsx) |
| `/admin/look/edit/[id]` | LOOK編集 | LOOK一覧の編集から移動。保存成功・キャンセルで `/admin?tab=LOOK` へ。取得失敗は同画面に表示 | [[id]/page.tsx](../../../src/app/admin/look/edit/%5Bid%5D/page.tsx) |
| `/admin/news/create` | NEWS作成 | NEWSタブから移動。保存成功・キャンセルで `/admin?tab=NEWS` へ | [page.tsx](../../../src/app/admin/news/create/page.tsx) |
| `/admin/news/edit/[id]` | NEWS編集 | NEWS一覧の編集から移動。保存成功・キャンセルで `/admin?tab=NEWS` へ。取得失敗は同画面に表示 | [[id]/page.tsx](../../../src/app/admin/news/edit/%5Bid%5D/page.tsx) |
| `/admin/settings/permissions` | 権限（G-0 / FREQ-519） | `/admin` のSETTINGSタブの「権限」から移動。「管理画面に戻る」は `/admin?tab=SETTINGS`。`GET /api/admin/permissions` の成功後だけ表を表示（直URLでも同じ） | [page.tsx](../../../src/app/admin/settings/permissions/page.tsx)、[RolePermissionsSection](../../../src/components/RolePermissionsSection.tsx) |
| `/admin/stockist/create` | 取扱店作成 | STOCKISTタブから移動。保存成功で `/admin?tab=STOCKIST` へ。キャンセル・戻るボタンなし | [page.tsx](../../../src/app/admin/stockist/create/page.tsx) |
| `/admin/stockist/edit/[id]` | 取扱店編集 | STOCKIST一覧の編集から移動。保存成功で `/admin?tab=STOCKIST` へ。取得失敗は同画面に表示。キャンセル・戻るボタンなし | [[id]/page.tsx](../../../src/app/admin/stockist/edit/%5Bid%5D/page.tsx) |
| `/ui` | UIコンポーネントギャラリー | 共通ヘッダーのUIメニューから移動。デモの選択・開閉は同画面。描画済みデモに専用のルートリンクなし | [page.tsx](../../../src/app/ui/page.tsx) |
| `/loading` | LOADINGデザインギャラリー | 共通ヘッダーのadmin向けメニューから移動。コピー・開閉・再生は同画面。専用のルートリンクなし | [page.tsx](../../../src/app/loading/page.tsx) |

## 画面表示と操作権限

| 対象 | 現在のページ側の表示条件 | データ・操作との区別 |
| --- | --- | --- |
| 顧客向け18ルート、`/ui` | ログインを必須にするページ表示ガードなし。カート・購入はゲストにも提供 | データ取得・入力検証・決済可否は各APIで判断する。空カートのcheckoutは同じURLに案内を表示 |
| `/login`・`/login/verify` | 検証待ちCookieの有無・有効性でOTP確認への移動／ログインへの戻りを判断 | メール・パスワードの検証とOTPの検証はAPIで実行する |
| `/auth/verified` | 未認証は同じURLの案内、一般利用者はアカウントへ、特権ロールはTOTP確認へ | MFA済みの特権ロールは管理へ直行する。未認証案内のリンクは利用者が押して移動する |
| `/account`・注文詳細 | 認証確認中は読込、未ログインは同じURLのログイン案内。ロール限定なし | [注文詳細API](../../../src/app/api/orders/%5Bid%5D/route.ts)は認証と注文所有者の一致を確認する |
| `/admin` | 認証確認中は読込。未ログイン・admin/supporter以外は権限なし。MFA未確認は2要素認証案内。いずれも同じURLに留まる | ロールで表示タブ・操作候補が変わり、操作APIでも認可を確認する |
| 管理の8作成・編集ルート、`/admin/create-user` | ページ・フォーム固有のログイン／ロール／MFA表示ガードなし。編集ページの取得失敗は同じURLのエラー表示 | フォーム表示は操作許可を意味しない。[管理API認可](../../../src/lib/auth/admin-rbac.ts)で認証、セッション、DBのACL権限、AAL2を確認する |
| `/admin/inventory` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/inventory` の返事（200で表、403で「在庫一覧を見る権限がありません。」、MFAなしの403で「2要素認証が必要です」、401で「ログインし直してください。」、その他は読込失敗）で決める | 窓口が `admin.stock.read` を、DBの関数も実行者の権限を確かめる。表の読込は読むだけ。発注の確定（`POST /api/admin/purchase-orders`）は `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read` を窓口とDBの関数の両方が確かめ、ボタン「発注」は役割では隠さない（権限が無い人は確定で「発注を扱う権限がありません。」） |
| `/admin/purchase-orders`・`/admin/purchase-orders/[id]` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/purchase-orders`・`GET /api/admin/purchase-orders/[id]` の返事（200で表示、403で「発注一覧を見る権限がありません。」／「発注書を見る権限がありません。」、MFAなしの403で「2要素認証が必要です」、401で「ログインし直してください。」、発注書の頁の404で「発注書が見つかりません。」、その他は読込失敗）で決める | 窓口が `admin.purchase_orders.read` だけを、DBの関数も実行者の権限を確かめる（`manage` は要らない）。読むだけで、CSRF・回数制限・監査は無い。`admin.items.*` や在庫の権限だけの人は403。発注書の頁の操作（数量の確定・訂正、打切り、取消、発注先・メモの訂正。G-2 Task 6）は窓口 `PATCH /api/admin/purchase-orders/[id]`・`POST …/quantities`・`POST …/short-closures` が `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read` を要し、足りない人には 403 の文「発注を扱う権限がありません。」を操作の画面に出す（ボタンは権限で出し分けない）。CSRF・回数制限・監査あり |
| `/admin/purchase-orders/documents` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/purchase-order-documents` の返事（200で表示、403で「取引書類を見る権限がありません。」、MFAなしの403で「2要素認証が必要です」、401で「ログインし直してください。」、その他は読込失敗）で決める | 窓口が `admin.purchase_orders.read` だけを、DBの関数も実行者の権限を確かめる（`manage` は要らない）。読むだけで、CSRF・回数制限・監査は無い。取引書類の原本を見る・保存するリンク（`GET …/attachments/[attachmentId]/url`）も `admin.purchase_orders.read` で、回数制限あり（リンクは60秒で、記録しない）。書類の追加・訂正・差し替え・無効化・続きから保存（G-2 Task 8）は `admin.purchase_orders.manage` ＋ `admin.purchase_orders.read` を要し、足りない人には 403 の文「発注を扱う権限がありません。」を操作の画面に出す（ボタンは権限で出し分けない）。CSRF・回数制限・監査あり |
| `/admin/packing` | ページ側のログイン／ロール／MFA表示ガードなし。表示可否は窓口 `GET /api/admin/packing` の返事（200で表、403で「荷作り表を見る権限がありません。」、MFAなしの403で「2要素認証が必要です」、401で「ログインし直してください。」、その他は読込失敗）で決める | 窓口が `admin.shipping.read` ＋ `admin.orders.read` の両方を、DBの関数も実行者の権限を確かめる（`manage` は要らない）。読むだけで、CSRF・回数制限・監査は無い。下の発送票の一覧（`GET /api/admin/shipment-slips`）も同じ組。注文IDから開く履歴は `admin.orders.read` で、票へのリンクは発送の権限があるときだけ付く |
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
| `/auth/callback` | `code`、`next` | codeはAPIへ転送。codeなし・認証済みの出口はnext指定先、無指定は `/auth/verified` |
| `/auth/password-reset` | `error=link_invalid/link_expired` | 案内を表示後にクエリを除去。メール入力・新パスワード入力・送信／更新完了も同じルート |
| `/auth/password-reset/verify` | `token` | 自動確認の入力。確認結果に応じて再設定画面へ移動 |
| `/account` | `tab=profile/shipping/orders/inquiries` | 無指定・未知値はprofile。`address` はshippingへ正規化。タブ切替でreplaceし、他のクエリを保持 |
| `/checkout` | `session_id`、入力・最終確認・完了・エラー | 開き直し・外部認証からの復帰はresumeを照会。支払い済みならcomplete、開いていれば最終確認、ほかは入力へ進む。最終確認・完了後も`session_id`をURLに残す（FREQ-421・D9）。最終確認画面の埋め込み決済、完了表示、エラー境界も同じルート |
| `/admin` | `tab`、`meta`、`meta_reason`、各タブの一覧・編集・確認状態 | tabは許可された初期タブを選ぶ。サイドナビ操作はURLを書き換えない。Meta callbackは結果をクエリに付与して同じadminルートへ戻す |

上表は画面のURLと状態の対応を示す。クエリがあることだけで、その絞り込みをサーバー・クライアントのどちらが処理するかや、全データに適用されることを保証しない。該当ページと描画コンポーネントを根拠とする。

## ルート数とレビュー方法

- `src/app/**/page.tsx` の全43件を棚卸しし、この一覧と[1つの画面遷移図](screen-flow.md#全画面遷移図)に各1件ずつ対応させる。
- ページから描画されるコンポーネントのリンク・ルーター操作、認証APIと外部サービスからの戻り先、表示ガード、クエリ更新を確認する。共通ナビは[Providers](../../../src/contexts/Providers.tsx)、[Header](../../../src/components/Header.tsx)、[Footer](../../../src/components/Footer.tsx)を確認する。
- `error.tsx`、API Route Handler、外部サービス、タブやダイアログは独立した画面ルート数に加えない。詳細ページ間の `[id]` 変更は画面遷移として図示するが、同じルート定義の1件に数える。
- `AdminTabs`・`AdminSideNav` の型にあるCONTACTは、現行 `/admin` の表示タブ配列に含まれない。現在表示するadminの11タブ（INVENTORYはORDERの次、PACKINGはINVENTORYの次、SETTINGSは最後）とsupporterのORDER・INVENTORY・PACKINGを記録する。

## 主な実装根拠

| 分類 | 確認元 |
| --- | --- |
| 公開画面の絞り込み・詳細 | [PublicItemGrid](../../../src/features/items/components/PublicItemGrid.tsx)、[PublicLookGrid](../../../src/features/look/components/PublicLookGrid.tsx)、[PublicNewsGrid](../../../src/features/news/components/PublicNewsGrid.tsx)、[PublicStockistGrid](../../../src/features/stockist/components/PublicStockistGrid.tsx)、[SearchPageClient](../../../src/features/search/components/SearchPageClient.tsx)、[RelatedItems](../../../src/features/items/components/RelatedItems.tsx) |
| 認証 | [LoginContext](../../../src/contexts/LoginContext.tsx)、[AuthTabs](../../../src/components/AuthTabs.tsx)、[OTP確認](../../../src/app/login/verify/VerifyOtpClient.tsx)、[再設定リンク確認](../../../src/app/auth/password-reset/verify/VerifyClient.tsx)、[認証シーケンス](../../04_DetailDesign/sequence/auth-login-mfa.md) |
| 注文・アカウント | [ゲスト登録案内](../../../src/features/checkout/components/GuestRegisterPrompt.tsx)、[再度購入](../../../src/features/account/hooks/useReorder.ts)、[配送業者](../../../src/lib/orders/shipping-carriers.ts)、[問い合わせタブ](../../../src/components/AccountInquiries.tsx)、[注文商品行](../../../src/features/account/components/OrderItemRow.tsx) |
| 管理の戻り先 | [ItemForm](../../../src/app/admin/item/ItemForm.tsx)、[LookForm](../../../src/app/admin/look/LookForm.tsx)、[NewsForm](../../../src/app/admin/news/NewsForm.tsx)、[StockistForm](../../../src/app/admin/stockist/StockistForm.tsx) |
| 管理タブ・Meta | [AdminTabs](../../../src/components/AdminTabs.tsx)、[AdminSideNav](../../../src/components/AdminSideNav.tsx)、[Meta接続UI](../../../src/components/MetaKpiConnection.tsx)、[Meta callback](../../../src/app/api/admin/kpi/meta/callback/route.ts)、[ACCOUNTING](../../../src/components/CostProfitSection.tsx)、[証憑閲覧API](../../../src/app/api/admin/kpi/cost-profit/receipt/route.ts) |

## 未確認事項

本レビューは現行ソースの棚卸しであり、本番の公開URL・配置設定、実データでの全画面表示・全ロール操作、外部サービス側の動作は実行検証していない。`/admin/create-user` と `/auth/callback` の通常導線における意図された入口は未確認で、既存の出口・画面内状態は記録した。

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
