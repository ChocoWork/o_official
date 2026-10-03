# 画面遷移図

> 状態: 現行コードで追跡した主要な画面遷移 | 確認日: 2026-10-03 | 対象: 顧客向け、認証、購入、管理

## 概要

共通ナビゲーションと利用者の主要な目的ごとに、実装で確認できる画面遷移を示す。矢印は画面リンク、自動遷移、または画面内操作後の結果を表し、外部 API の処理自体は画面として数えない。

## 全画面遷移図

```mermaid
flowchart LR
    Header["共通ヘッダー"]
    Footer["共通フッター"]

    subgraph Browse["顧客向け閲覧 (15ルート)"]
        direction TB
        Home["/"]
        About["/about"]
        NewsList["/news"]
        NewsDetail["/news/[id]"]
        ItemList["/item"]
        ItemDetail["/item/[id]"]
        LookList["/look"]
        LookDetail["/look/[id]"]
        Stockist["/stockist"]
        Contact["/contact"]
        Search["/search"]
        Wishlist["/wishlist"]
        Privacy["/privacy"]
        Terms["/terms"]
        Legal["/legal"]
    end

    subgraph Purchase["購入 (2ルート)"]
        direction TB
        Cart["/cart"]
        Checkout["/checkout"]
    end

    subgraph AuthAccount["認証・アカウント (8ルート)"]
        direction TB
        Login["/login"]
        LoginVerify["/login/verify メール OTP"]
        AuthCallback["/auth/callback 通常導線から未参照"]
        AuthVerified["/auth/verified"]
        PasswordReset["/auth/password-reset"]
        PasswordResetVerify["/auth/password-reset/verify?token=..."]
        Account["/account"]
        OrderDetail["/account/orders/[id]"]
    end

    subgraph Management["管理・開発補助 (12ルート)"]
        direction TB
        Admin["/admin"]
        AdminCreateUser["/admin/create-user 画面内リンク未確認"]
        AdminItemCreate["/admin/item/create"]
        AdminItemEdit["/admin/item/edit/[id]"]
        AdminLookCreate["/admin/look/create"]
        AdminLookEdit["/admin/look/edit/[id]"]
        AdminNewsCreate["/admin/news/create"]
        AdminNewsEdit["/admin/news/edit/[id]"]
        AdminStockistCreate["/admin/stockist/create"]
        AdminStockistEdit["/admin/stockist/edit/[id]"]
        UiGallery["/ui"]
        LoadingGallery["/loading"]
    end

    Google["外部: Google OAuth"]
    OAuthCallback["API: /api/auth/oauth/callback"]
    RegisterApi["POST /api/auth/register"]
    ConfirmationEmail["確認メール"]
    ConfirmApi["GET /api/auth/confirm"]
    Stripe["外部: Stripe Payment Element / 必要な決済認証"]
    CheckoutError["checkout/error.tsx エラー境界"]

    Header --> Home
    Header --> NewsList
    Header --> ItemList
    Header --> LookList
    Header --> Stockist
    Header --> About
    Header --> Contact
    Header --> UiGallery
    Header --> Search
    Header --> Wishlist
    Header --> Cart
    Header -->|未ログイン| Login
    Header -->|ログイン済み| Account
    Header -. admin のみ .-> LoadingGallery
    Header -. admin / supporter .-> Admin

    Footer --> ItemList
    Footer --> LookList
    Footer --> NewsList
    Footer --> Stockist
    Footer --> About
    Footer --> Contact
    Footer --> Privacy
    Footer --> Terms
    Footer --> Legal

    Home --> Search
    Home --> NewsList
    Home --> ItemList
    Home --> LookList
    Home --> About
    About --> ItemList
    About --> LookList
    NewsList --> NewsDetail
    NewsDetail --> NewsList
    NewsDetail -. 前後の記事 .-> NewsDetail
    ItemList --> ItemDetail
    LookList --> LookDetail
    LookList --> ItemDetail
    LookDetail --> ItemDetail
    LookDetail -. 前後のLOOK .-> LookDetail
    Wishlist --> ItemDetail
    Search --> ItemDetail
    Search --> NewsDetail
    Search --> LookDetail
    Privacy --> Contact
    Legal --> Contact
    NewsList -. category クエリ .-> NewsList
    ItemList -. category クエリ .-> ItemList
    LookList -. season クエリ .-> LookList
    Search -. query / 結果種別 .-> Search
    Contact -. 送信完了状態 .-> Contact

    ItemDetail -. カート追加後も同画面 .-> ItemDetail
    Cart --> ItemDetail
    Cart --> ItemList
    Cart --> Checkout
    Checkout --> Stripe
    Stripe -->|session_id 付きで復帰| Checkout
    Checkout -. 決済照合後の完了状態 .-> Checkout
    Checkout -. エラー発生時 .-> CheckoutError
    CheckoutError -->|カートへ戻る| Cart
    Checkout -->|完了表示から| Account
    Checkout -->|買い物を続ける| ItemList

    Login -->|メール・パスワード送信| LoginVerify
    LoginVerify -->|一般利用者| Account
    LoginVerify -->|admin / supporter| AuthVerified
    LoginVerify -->|検証セッション切れ| Login
    Login -. 会員登録タブ (同じ /login) .-> Login
    Login -->|登録 POST| RegisterApi
    RegisterApi -. 確認メール送信の完了通知 .-> Login
    RegisterApi -->|登録受付後| ConfirmationEmail
    ConfirmationEmail --> ConfirmApi
    ConfirmApi -->|redirect_to に従って遷移| AuthVerified
    Login -->|Google OAuth 開始| Google
    Google --> OAuthCallback
    OAuthCallback -->|一般利用者| Account
    OAuthCallback -->|admin / supporter| AuthVerified
    AuthVerified -->|一般利用者| Account
    AuthVerified -->|TOTP 確認後| Admin
    AuthVerified -. TOTP 未設定なら同画面で登録 .-> AuthVerified
    AuthVerified -. 未認証時のログインページ案内 .-> Login
    Login --> PasswordReset
    PasswordReset -->|確認メール| PasswordResetVerify
    PasswordResetVerify -->|リンク確認後| PasswordReset
    PasswordResetVerify -->|token 不在| PasswordReset
    PasswordReset -. パスワード更新完了状態 .-> PasswordReset
    Account -->|注文タブ| Account
    Account --> OrderDetail
    Account -. 未ログイン時 .-> Login
    OrderDetail -->|注文一覧へ戻る| Account
    OrderDetail --> Contact

    Admin -. タブ切替: admin は8種 / supporter は ORDER .-> Admin
    Admin --> AdminNewsCreate
    Admin --> AdminNewsEdit
    Admin --> AdminItemCreate
    Admin --> AdminItemEdit
    Admin --> AdminLookCreate
    Admin --> AdminLookEdit
    Admin --> AdminStockistCreate
    Admin --> AdminStockistEdit
```

実線は別ルートへの画面遷移、または API・外部サービスを経由する処理とその戻りを示す。点線は同一ルート内の状態変化、条件付き遷移、画面からの案内を示す。図は1つに統合し、内部の `subgraph` は37画面の所在を探しやすくするための区分である。外部サービスと API は画面ルートではないが、画面に戻る経路を示すために含めた。

商品詳細でのカート追加、お問い合わせ送信、パスワード更新、タブ切替、絞り込みは同じ画面に留まる。`/auth/callback` と `/admin/create-user` はルート実装があるが、通常フローからの呼び出し元・画面内リンクを確認できていないため、図の中で未接続として示した。管理タブの個別ルートへの移動、認証後のロール別遷移、決済後の同一 `/checkout` への復帰は、独立した図に分けずこの図にまとめている。
## 根拠と図の範囲

| 導線 | 実装根拠 |
| --- | --- |
| 共通ヘッダー・フッター | [Header](../../../src/components/Header.tsx)、[Footer](../../../src/components/Footer.tsx) |
| 一覧から詳細・関連商品 | [公開商品一覧](../../../src/features/items/components/PublicItemGrid.tsx)、[公開LOOK一覧](../../../src/features/look/components/PublicLookGrid.tsx)、[公開NEWS一覧](../../../src/features/news/components/PublicNewsGrid.tsx) |
| カート・決済 | [商品詳細](../../../src/app/item/%5Bid%5D/ItemDetailClient.tsx)、[注文概要](../../../src/app/cart/_components/OrderSummary.tsx)、[チェックアウト](../../../src/app/checkout/page.tsx) |
| 認証 | [LoginContext](../../../src/contexts/LoginContext.tsx)、[OTP確認](../../../src/app/login/verify/VerifyOtpClient.tsx)、[OAuth callback API](../../../src/app/api/auth/oauth/callback/route.ts)、[認証確認画面](../../../src/app/auth/verified/page.tsx) |
| 管理 | [管理ページ](../../../src/app/admin/page.tsx)、[AdminTabs](../../../src/components/AdminTabs.tsx)、[AdminSideNav](../../../src/components/AdminSideNav.tsx) |

実際に読み込まれるページの確認、全エラー分岐、外部 OAuth/Stripe のサービス側画面、各ロール・機能フラグの組合せはこの静的な導線図の範囲外である。境界は画面一覧の[ルート一覧](screen-list.md)と、認証の[シーケンス図](../../04_DetailDesign/sequence/auth-login-mfa.md)、購入の[注文・決済状態図](../../04_DetailDesign/states/order-payment.md)を参照する。
