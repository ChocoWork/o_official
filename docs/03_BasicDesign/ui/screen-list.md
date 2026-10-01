# 画面一覧

> 状態: 現行ルートの棚卸し | 確認日: 2026-10-01 | 根拠: `src/app/**/page.tsx`（37件）

## 概要

Next.js App Router に存在する画面ルートを、利用目的とともに列挙する。ここでの「存在」はソース上の `page.tsx` を意味し、公開設定、権限、表示品質、テスト成功を保証しない。管理画面の KPI・ACCOUNTING・ORDER などは `/admin` 内のタブであり、個別の `page.tsx` ルートではない。

## 公開・顧客向け画面

| ルート | 目的 | 実装 |
| --- | --- | --- |
| `/` | ホーム | `src/app/page.tsx` |
| `/about` | ブランド紹介 | `src/app/about/page.tsx` |
| `/news`、`/news/[id]` | ニュース一覧・詳細 | `src/app/news/` |
| `/item`、`/item/[id]` | 商品一覧・詳細 | `src/app/item/` |
| `/look`、`/look/[id]` | LOOK 一覧・詳細 | `src/app/look/` |
| `/stockist` | 取扱店 | `src/app/stockist/page.tsx` |
| `/contact` | 問い合わせ | `src/app/contact/page.tsx` |
| `/search` | 横断検索 | `src/app/search/page.tsx` |
| `/wishlist` | お気に入り | `src/app/wishlist/page.tsx` |
| `/cart` | カート | `src/app/cart/page.tsx` |
| `/checkout` | 注文・決済 | `src/app/checkout/page.tsx` |
| `/privacy`、`/terms`、`/legal` | 法的情報 | `src/app/privacy/`、`terms/`、`legal/` |

## アカウント・認証画面

| ルート | 目的 | 実装 |
| --- | --- | --- |
| `/login`、`/login/verify` | ログイン、追加認証 | `src/app/login/` |
| `/auth/callback`、`/auth/verified` | 認証後の戻り先・結果表示 | `src/app/auth/` |
| `/auth/password-reset`、`/auth/password-reset/verify` | パスワード再設定 | `src/app/auth/password-reset/` |
| `/account`、`/account/orders/[id]` | アカウントと注文詳細 | `src/app/account/` |

## 管理・補助画面

| ルート | 目的 | 実装 |
| --- | --- | --- |
| `/admin` | 管理タブの入口 | `src/app/admin/page.tsx` |
| `/admin/create-user` | 管理者による利用者作成 | `src/app/admin/create-user/page.tsx` |
| `/admin/item/create`、`/admin/item/edit/[id]` | 商品の作成・編集 | `src/app/admin/item/` |
| `/admin/look/create`、`/admin/look/edit/[id]` | LOOK の作成・編集 | `src/app/admin/look/` |
| `/admin/news/create`、`/admin/news/edit/[id]` | ニュースの作成・編集 | `src/app/admin/news/` |
| `/admin/stockist/create`、`/admin/stockist/edit/[id]` | 取扱店の作成・編集 | `src/app/admin/stockist/` |
| `/ui` | UI コンポーネントの確認用 | `src/app/ui/page.tsx` |
| `/loading` | 補助画面 | `src/app/loading/page.tsx` |

管理タブ名は `src/components/AdminSideNav.tsx` の `KPI`、`ACCOUNTING`、`NEWS`、`ITEM`、`LOOK`、`STOCKIST`、`USER`、`ORDER`、`CONTACT` を参照する。権限判定の正本は `src/lib/auth/admin-rbac.ts` と各 API Route Handler である。

## 詳細設計との対応

[ページ別詳細設計](../../04_DetailDesign/README.md)にはホーム、NEWS、ITEM、LOOK、ABOUT、CONTACT、STOCKIST、WISHLIST、CART、CHECKOUT、LOGIN、ACCOUNT、ADMIN、PRIVACY、TERMS、SEARCH がある。`/login/verify`、追加の認証画面、`/legal`、管理下位ルートなどは個別の詳細設計が未整備であり、この一覧と実装を起点に追加する。

## 未確認事項

ルートの存在以外のアクセス制御と実行時の表示は、この一覧作成時には画面実測していない。外部公開範囲を判断する際は `src/proxy.ts`、ページ実装、認証 API と E2E を確認する。
