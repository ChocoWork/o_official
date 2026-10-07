# 画面一覧

> 状態: 全画面ルートと導線・表示条件をレビュー | 確認日: 2026-10-03（購入の行は2026-10-07に再確認） | 根拠: `src/app/**/page.tsx` 37件

## 概要

`page.tsx` が定義する画面ルートを1ルート1行で示す。[画面遷移図](screen-flow.md)と対応し、リンクの入口・出口、同じルート内の状態、現在の表示条件を記録する。角括弧の `[id]` は実行時の識別子に置き換わる。ルートの存在と、画面表示・API操作の許可はそれぞれの実装で確認する。

## 顧客向け画面（17ルート）

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
| `/search` | サイト内検索 | `q`・`tab` を更新し同じルートで検索。結果から商品・LOOK・NEWS詳細へ移動。LOAD MOREは同画面の追加表示 | [page.tsx](../../../src/app/search/page.tsx) |
| `/wishlist` | ウィッシュリスト | 商品詳細へ移動。保存解除・カート追加は同画面。空状態から商品一覧へ移動 | [page.tsx](../../../src/app/wishlist/page.tsx) |
| `/cart` | カート | 数量変更・削除は同画面。商品詳細、商品一覧、購入手続きへ移動。空状態からも商品一覧へ移動 | [page.tsx](../../../src/app/cart/page.tsx) |
| `/checkout` | 注文・決済 | ゲスト購入。入力画面の「確認へ進む」でSessionを作り、Stripeの部品を置く最終確認画面へ進む。「注文する」で受付・支払い・完了を行い、外部認証からの復帰も同ルートで扱う。最終確認・完了後もURLに`session_id`を残す（D9）。完了から商品一覧・アカウント・ゲスト登録へ移動。空カートは同画面に案内 | [page.tsx](../../../src/app/checkout/page.tsx)、[FinalConfirmationStep](../../../src/app/checkout/_components/FinalConfirmationStep.tsx) |
| `/privacy` | プライバシーポリシー | お問い合わせへのリンク | [page.tsx](../../../src/app/privacy/page.tsx) |
| `/terms` | 利用規約 | 規約本文を表示。ページ固有のルートリンクなし | [page.tsx](../../../src/app/terms/page.tsx) |
| `/legal` | 法定表記 | お問い合わせへのリンク | [page.tsx](../../../src/app/legal/page.tsx) |

## 認証・アカウント画面（8ルート）

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

[注文商品の共通表示](../../../src/features/account/components/OrderItemRow.tsx)には、`itemId` があり `stockStatus=sold_out` の商品から `/contact?subject=予約注文：{商品名}` へ進む分岐がある。ただし現行の注文詳細APIは `stockStatus` を返さないため、注文詳細での表示条件は成立しない。contactはこのクエリから件名を初期入力しない。

## 管理・開発補助画面（12ルート）

個別フォームの画面表示と操作APIの認可は[表示条件の表](#画面表示と操作権限)を参照する。

| パス | 画面・役割 | 導線・同一画面内の状態 | 実装 |
| --- | --- | --- | --- |
| `/admin` | 管理タブ | adminはKPI・ACCOUNTING・NEWS・ITEM・LOOK・STOCKIST・USER・ORDER、supporterはORDER。`tab` は初期選択、タブ操作は同画面の状態変更。KPIからMeta OAuthへ。ACCOUNTING・固定資産の添付証憑は閲覧API経由で別タブに開く。権限なし・MFA未確認も同画面に案内 | [page.tsx](../../../src/app/admin/page.tsx) |
| `/admin/create-user` | ユーザー作成フォーム | 専用入口リンクは未確認。成功時は入力を初期化し同画面に留まる。専用の戻るリンクなし | [page.tsx](../../../src/app/admin/create-user/page.tsx) |
| `/admin/item/create` | 商品作成 | ITEMタブから移動。保存成功・キャンセルで `/admin?tab=ITEM` へ | [page.tsx](../../../src/app/admin/item/create/page.tsx) |
| `/admin/item/edit/[id]` | 商品編集 | ITEM一覧の編集から移動。保存成功・キャンセルで `/admin?tab=ITEM` へ。取得失敗は同画面に表示 | [[id]/page.tsx](../../../src/app/admin/item/edit/%5Bid%5D/page.tsx) |
| `/admin/look/create` | LOOK作成 | LOOKタブから移動。保存成功・キャンセルで `/admin?tab=LOOK` へ | [page.tsx](../../../src/app/admin/look/create/page.tsx) |
| `/admin/look/edit/[id]` | LOOK編集 | LOOK一覧の編集から移動。保存成功・キャンセルで `/admin?tab=LOOK` へ。取得失敗は同画面に表示 | [[id]/page.tsx](../../../src/app/admin/look/edit/%5Bid%5D/page.tsx) |
| `/admin/news/create` | NEWS作成 | NEWSタブから移動。保存成功・キャンセルで `/admin?tab=NEWS` へ | [page.tsx](../../../src/app/admin/news/create/page.tsx) |
| `/admin/news/edit/[id]` | NEWS編集 | NEWS一覧の編集から移動。保存成功・キャンセルで `/admin?tab=NEWS` へ。取得失敗は同画面に表示 | [[id]/page.tsx](../../../src/app/admin/news/edit/%5Bid%5D/page.tsx) |
| `/admin/stockist/create` | 取扱店作成 | STOCKISTタブから移動。保存成功で `/admin?tab=STOCKIST` へ。キャンセル・戻るボタンなし | [page.tsx](../../../src/app/admin/stockist/create/page.tsx) |
| `/admin/stockist/edit/[id]` | 取扱店編集 | STOCKIST一覧の編集から移動。保存成功で `/admin?tab=STOCKIST` へ。取得失敗は同画面に表示。キャンセル・戻るボタンなし | [[id]/page.tsx](../../../src/app/admin/stockist/edit/%5Bid%5D/page.tsx) |
| `/ui` | UIコンポーネントギャラリー | 共通ヘッダーのUIメニューから移動。デモの選択・開閉は同画面。描画済みデモに専用のルートリンクなし | [page.tsx](../../../src/app/ui/page.tsx) |
| `/loading` | LOADINGデザインギャラリー | 共通ヘッダーのadmin向けメニューから移動。コピー・開閉・再生は同画面。専用のルートリンクなし | [page.tsx](../../../src/app/loading/page.tsx) |

## 画面表示と操作権限

| 対象 | 現在のページ側の表示条件 | データ・操作との区別 |
| --- | --- | --- |
| 顧客向け17ルート、`/ui` | ログインを必須にするページ表示ガードなし。カート・購入はゲストにも提供 | データ取得・入力検証・決済可否は各APIで判断する。空カートのcheckoutは同じURLに案内を表示 |
| `/login`・`/login/verify` | 検証待ちCookieの有無・有効性でOTP確認への移動／ログインへの戻りを判断 | メール・パスワードの検証とOTPの検証はAPIで実行する |
| `/auth/verified` | 未認証は同じURLの案内、一般利用者はアカウントへ、特権ロールはTOTP確認へ | MFA済みの特権ロールは管理へ直行する。未認証案内のリンクは利用者が押して移動する |
| `/account`・注文詳細 | 認証確認中は読込、未ログインは同じURLのログイン案内。ロール限定なし | [注文詳細API](../../../src/app/api/orders/%5Bid%5D/route.ts)は認証と注文所有者の一致を確認する |
| `/admin` | 認証確認中は読込。未ログイン・admin/supporter以外は権限なし。MFA未確認は2要素認証案内。いずれも同じURLに留まる | ロールで表示タブ・操作候補が変わり、操作APIでも認可を確認する |
| 管理の8作成・編集ルート、`/admin/create-user` | ページ・フォーム固有のログイン／ロール／MFA表示ガードなし。編集ページの取得失敗は同じURLのエラー表示 | フォーム表示は操作許可を意味しない。[管理API認可](../../../src/lib/auth/admin-rbac.ts)で認証、セッション、DBのACL権限、AAL2を確認する |
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

- `src/app/**/page.tsx` の全37件を棚卸しし、この一覧と[1つの画面遷移図](screen-flow.md#全画面遷移図)に各1件ずつ対応させる。
- ページから描画されるコンポーネントのリンク・ルーター操作、認証APIと外部サービスからの戻り先、表示ガード、クエリ更新を確認する。共通ナビは[Providers](../../../src/contexts/Providers.tsx)、[Header](../../../src/components/Header.tsx)、[Footer](../../../src/components/Footer.tsx)を確認する。
- `error.tsx`、API Route Handler、外部サービス、タブやダイアログは独立した画面ルート数に加えない。詳細ページ間の `[id]` 変更は画面遷移として図示するが、同じルート定義の1件に数える。
- `AdminTabs`・`AdminSideNav` の型にあるCONTACTは、現行 `/admin` の表示タブ配列に含まれない。現在表示する8タブとsupporterのORDERを記録する。

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
