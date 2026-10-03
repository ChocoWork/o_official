# 画面遷移図

> 状態: 現行コードで追跡した主要な画面遷移 | 確認日: 2026-10-03 | 対象: 顧客向け、認証、購入、管理

## 概要

共通ナビゲーションと利用者の主要な目的ごとに、実装で確認できる画面遷移を示す。矢印は画面リンク、自動遷移、または画面内操作後の結果を表し、外部 API の処理自体は画面として数えない。

## 共通ナビゲーションとコンテンツ閲覧

```mermaid
flowchart LR
    Header["共通ヘッダー"] --> Home["/"]
    Header --> NewsList["/news 一覧"]
    Header --> ItemList["/item 一覧"]
    Header --> LookList["/look 一覧"]
    Header --> Stockist["/stockist"]
    Header --> About["/about"]
    Header --> Contact["/contact"]
    Header --> UiGallery["/ui"]
    Header --> Search["/search"]
    Header --> Wishlist["/wishlist"]
    Header --> Cart["/cart"]
    Header --> Login["/login 未ログイン時"]
    Header --> Account["/account ログイン時"]
    Header -. admin のみ .-> Loading["/loading"]
    Header -. admin または supporter .-> Admin["/admin"]

    Home --> Search
    Home --> NewsList
    Home --> ItemList
    Home --> LookList
    Home --> About
    NewsList --> NewsDetail["/news/[id]"]
    ItemList --> ItemDetail["/item/[id]"]
    LookList --> LookDetail["/look/[id]"]
    LookDetail --> ItemDetail
    Wishlist --> ItemDetail
    Search --> ItemDetail
    Search --> NewsDetail
    Search --> LookDetail
    NewsDetail --> NewsList

    Footer["共通フッター"] --> ItemList
    Footer --> LookList
    Footer --> NewsList
    Footer --> Stockist
    Footer --> About
    Footer --> Contact
    Footer --> Privacy["/privacy"]
    Footer --> Terms["/terms"]
    Footer --> Legal["/legal"]
    Privacy --> Contact
    Legal --> Contact
```

ニュース、商品、LOOK の絞り込みは `category` / `season` クエリを更新して同じ一覧画面に留まる。検索キーワードや結果種別も `/search` 内の表示状態である。お問い合わせの送信完了は `/contact` 内に表示する。前後の記事・LOOK の移動も同じ詳細ルート種別の間で行う。

## 商品選択から注文

```mermaid
flowchart LR
    ItemList["/item"] --> ItemDetail["/item/[id]"]
    LookDetail["/look/[id]"] --> ItemDetail
    Wishlist["/wishlist"] --> ItemDetail
    ItemDetail -. "POST /api/cart 成功: 詳細画面に留まる" .-> ItemDetail
    Header["共通ヘッダーのカート"] --> Cart["/cart"]
    Cart --> ItemDetail
    Cart --> ItemList
    Cart --> Checkout["/checkout 入力・決済"]
    Checkout --> Stripe["Stripe Payment Element / 必要な外部認証"]
    Stripe --> Returned["/checkout?session_id=... に復帰"]
    Returned --> Complete["同じ /checkout の注文完了表示"]
    Complete --> Account["/account"]
    Complete --> ItemList
    Checkout -. "エラー境界: URL は同じ" .-> CheckoutError["checkout/error.tsx"]
    CheckoutError --> Cart
```

商品詳細でのカート追加は `/api/cart` への送信で、成功後も `/item/[id]` に留まる。利用者は共通ヘッダーから `/cart` を開き、注文概要から `/checkout` に進む。Stripe の戻り先は `/checkout?session_id=...` で、決済照合後の完了表示も `/checkout` に含まれる。`checkout/error.tsx` は別ルートではなく、同じ URL に対する Next.js のエラー境界である。

## ログイン、新規登録、アカウント

```mermaid
flowchart LR
    Login["/login"] -->|メール・パスワードを送信| Otp["/login/verify メール OTP"]
    Otp -->|一般利用者| Account["/account"]
    Otp -->|admin / supporter| Verified["/auth/verified 認証確認・TOTP"]
    Verified -->|一般利用者| Account
    Verified -->|TOTP 済み| Admin["/admin"]
    Verified -. "TOTP 未設定時は同じ画面で登録" .-> Verified

    Login -->|Google OAuth 開始| Google["Google 外部認証"]
    Google --> OAuthApi["/api/auth/oauth/callback"]
    OAuthApi -->|一般利用者| Account
    OAuthApi -->|admin / supporter| Verified

    Login -->|?tab=register| Register["/login の新規登録タブ"]
    Register --> ConfirmApi["メール確認リンク /api/auth/confirm"]
    ConfirmApi --> Verified

    Login -->|パスワードを忘れた場合| Reset["/auth/password-reset"]
    Reset -->|メールのリンク| ResetVerify["/auth/password-reset/verify?token=..."]
    ResetVerify -->|リンク確認後に戻る| Reset
    Reset -->|更新完了の状態表示| Reset

    Account --> Orders["/account?tab=orders"]
    Orders --> OrderDetail["/account/orders/[id]"]
    OrderDetail --> Orders
    OrderDetail --> Contact["/contact"]
    Account -. "未ログイン時の案内から" .-> Login
```

`/login/verify` はメール OTP 用で、ログイン検証セッションが無ければ `/login` に戻る。特権ロールは `/auth/verified` で TOTP を登録または確認し、認証済みなら `/admin` へ進む。一般利用者の Google OAuth は API callback から `/account` へ、admin/supporter は `/auth/verified` へ戻る。各タブや成功・失敗表示の多くは同じ画面ルートの状態である。

`/auth/callback` という画面ルートも実装されているが、通常の Google OAuth フローは API callback を直接利用する。現行ソースでこの画面を標準導線として指定する呼び出し元は確認できていないため、上図の通常経路には含めていない。

## 管理

```mermaid
flowchart LR
    Header["管理可能ロールの共通ヘッダー"] --> Admin["/admin"]
    Admin --> AdminTabs["同一ルート内のタブ"]
    AdminTabs --> News["NEWS"]
    AdminTabs --> Item["ITEM"]
    AdminTabs --> Look["LOOK"]
    AdminTabs --> Stockist["STOCKIST"]
    AdminTabs --> User["USER"]
    AdminTabs --> Order["ORDER"]
    AdminTabs --> Kpi["KPI"]
    AdminTabs --> Accounting["ACCOUNTING"]
    News --> NewsCreate["/admin/news/create"]
    News --> NewsEdit["/admin/news/edit/[id]"]
    Item --> ItemCreate["/admin/item/create"]
    Item --> ItemEdit["/admin/item/edit/[id]"]
    Look --> LookCreate["/admin/look/create"]
    Look --> LookEdit["/admin/look/edit/[id]"]
    Stockist --> StockistCreate["/admin/stockist/create"]
    Stockist --> StockistEdit["/admin/stockist/edit/[id]"]
    Header -. admin のみ .-> Loading["/loading"]
```

`/admin` のタブ切替は同じ画面内で行う。現行の表示タブは admin が8種類、supporter が `ORDER` のみである。`CONTACT` はタブ型に定義されているが `/admin` の表示配列には渡されない。新規作成・編集は NEWS、ITEM、LOOK、STOCKIST のタブから個別ルートへ進む。

`/admin/create-user` は画面ルートとフォームがあるものの、現行ソースから `/admin` を含む画面内リンクを確認できなかった。図では実装された導線として扱わない。`/admin` の画面表示、個別操作 API の認証・権限確認は別々に確認する。

## 根拠と図の範囲

| 導線 | 実装根拠 |
| --- | --- |
| 共通ヘッダー・フッター | [Header](../../../src/components/Header.tsx)、[Footer](../../../src/components/Footer.tsx) |
| 一覧から詳細・関連商品 | [公開商品一覧](../../../src/features/items/components/PublicItemGrid.tsx)、[公開LOOK一覧](../../../src/features/look/components/PublicLookGrid.tsx)、[公開NEWS一覧](../../../src/features/news/components/PublicNewsGrid.tsx) |
| カート・決済 | [商品詳細](../../../src/app/item/%5Bid%5D/ItemDetailClient.tsx)、[注文概要](../../../src/app/cart/_components/OrderSummary.tsx)、[チェックアウト](../../../src/app/checkout/page.tsx) |
| 認証 | [LoginContext](../../../src/contexts/LoginContext.tsx)、[OTP確認](../../../src/app/login/verify/VerifyOtpClient.tsx)、[OAuth callback API](../../../src/app/api/auth/oauth/callback/route.ts)、[認証確認画面](../../../src/app/auth/verified/page.tsx) |
| 管理 | [管理ページ](../../../src/app/admin/page.tsx)、[AdminTabs](../../../src/components/AdminTabs.tsx)、[AdminSideNav](../../../src/components/AdminSideNav.tsx) |

実際に読み込まれるページの確認、全エラー分岐、外部 OAuth/Stripe のサービス側画面、各ロール・機能フラグの組合せはこの静的な導線図の範囲外である。境界は画面一覧の[ルート一覧](screen-list.md)と、認証の[シーケンス図](../../04_DetailDesign/sequence/auth-login-mfa.md)、購入の[注文・決済状態図](../../04_DetailDesign/states/order-payment.md)を参照する。