# 画面一覧

> 状態: 現行ルートの実装棚卸し | 確認日: 2026-10-03 | 根拠: `src/app/**/page.tsx` 37件

## 概要

`page.tsx` が定義する画面ルートを1ルート1行で示す。画面の存在はソース上のルート定義を意味し、公開環境への配置、個々の利用者の権限、表示品質や動作テストの合格を保証しない。角括弧の `[id]` は実行時の識別子に置き換わる動的ルートを表す。

## 顧客向け画面（17ルート）

| パス | 画面・役割 | 同一画面内の状態・主な注記 | 実装 |
| --- | --- | --- | --- |
| `/` | ホーム | 商品・LOOK・NEWS・ABOUT・STOCKIST の各セクションと検索プレビューを表示 | [page.tsx](../../../src/app/page.tsx) |
| `/about` | ブランド紹介 | ITEM、LOOK 一覧へのリンク | [page.tsx](../../../src/app/about/page.tsx) |
| `/news` | NEWS 一覧 | `?category=` でカテゴリを指定。絞り込み後も同じルート | [page.tsx](../../../src/app/news/page.tsx) |
| `/news/[id]` | NEWS 詳細 | 一覧、カテゴリ絞り込み、前後の記事へ移動 | [[id]/page.tsx](../../../src/app/news/%5Bid%5D/page.tsx) |
| `/item` | 商品一覧 | `?category=` でカテゴリを指定。商品カードから詳細へ移動 | [page.tsx](../../../src/app/item/page.tsx) |
| `/item/[id]` | 商品詳細 | 色・サイズ等を選択してカートへ追加。追加後も画面に留まる | [[id]/page.tsx](../../../src/app/item/%5Bid%5D/page.tsx) |
| `/look` | LOOK 一覧 | `?season=` でシーズンを指定。絞り込み後も同じルート | [page.tsx](../../../src/app/look/page.tsx) |
| `/look/[id]` | LOOK 詳細 | 関連商品と前後のLOOKへ移動 | [[id]/page.tsx](../../../src/app/look/%5Bid%5D/page.tsx) |
| `/stockist` | 取扱店 | 取扱店情報を閲覧 | [page.tsx](../../../src/app/stockist/page.tsx) |
| `/contact` | お問い合わせ | 送信結果は同じ画面上の完了表示・確認モーダルで通知 | [page.tsx](../../../src/app/contact/page.tsx) |
| `/search` | サイト内検索 | `?q=` などを使い検索。結果から商品・LOOK・NEWS の詳細へ移動 | [page.tsx](../../../src/app/search/page.tsx) |
| `/wishlist` | ウィッシュリスト | 保存した商品の詳細へ移動 | [page.tsx](../../../src/app/wishlist/page.tsx) |
| `/cart` | カート | 商品詳細へ戻る、買い物を続ける、購入手続きへ進む | [page.tsx](../../../src/app/cart/page.tsx) |
| `/checkout` | 注文・決済 | Stripe Payment Element を表示。決済後の戻りと完了表示も同一ルート | [page.tsx](../../../src/app/checkout/page.tsx) |
| `/privacy` | プライバシーポリシー | お問い合わせへのリンク | [page.tsx](../../../src/app/privacy/page.tsx) |
| `/terms` | 利用規約 | 規約本文を表示 | [page.tsx](../../../src/app/terms/page.tsx) |
| `/legal` | 法定表記 | お問い合わせへのリンク | [page.tsx](../../../src/app/legal/page.tsx) |

## 認証・アカウント画面（8ルート）

| パス | 画面・役割 | 同一画面内の状態・主な注記 | 実装 |
| --- | --- | --- | --- |
| `/login` | ログイン・新規登録 | `?tab=register` で新規登録タブを初期表示。ログイン方法はメール・パスワードと Google | [page.tsx](../../../src/app/login/page.tsx) |
| `/login/verify` | ログインメール OTP の確認 | 有効なログイン検証セッションがない場合は `/login` へ戻る | [page.tsx](../../../src/app/login/verify/page.tsx) |
| `/auth/callback` | 認証コールバック状態表示 | 現行の OAuth 開始処理が使う callback URL は API ルート。通常フローの遷移先として本ページを指定するコードは確認できていない | [page.tsx](../../../src/app/auth/callback/page.tsx) |
| `/auth/verified` | 認証確認・特権ユーザーの TOTP | 一般利用者は `/account` へ進み、admin/supporter は TOTP 登録または確認を経て `/admin` へ進む | [page.tsx](../../../src/app/auth/verified/page.tsx) |
| `/auth/password-reset` | パスワード再設定 | メール送信、リンクエラー、新しいパスワードの入力、更新完了を同じルート内で表示 | [page.tsx](../../../src/app/auth/password-reset/page.tsx) |
| `/auth/password-reset/verify` | 再設定リンクの確認 | token を確認して `/auth/password-reset` に戻る中間画面 | [page.tsx](../../../src/app/auth/password-reset/verify/page.tsx) |
| `/account` | アカウント情報 | プロフィール、配送先、注文、問い合わせ関連のタブを表示。`?tab=` は同一ルート内の表示切替 | [page.tsx](../../../src/app/account/page.tsx) |
| `/account/orders/[id]` | 注文詳細 | 注文一覧に戻る。未ログイン時はログイン案内を表示 | [[id]/page.tsx](../../../src/app/account/orders/%5Bid%5D/page.tsx) |

## 管理・開発補助画面（12ルート）

| パス | 画面・役割 | 同一画面内の状態・主な注記 | 実装 |
| --- | --- | --- | --- |
| `/admin` | 管理タブ | admin は KPI・ACCOUNTING・NEWS・ITEM・LOOK・STOCKIST・USER・ORDER、supporter は ORDER のみ。タブ切替は同一ルート | [page.tsx](../../../src/app/admin/page.tsx) |
| `/admin/create-user` | 管理者によるユーザー作成 | フォーム実装あり。現在の画面内リンクからの到達元は確認できていない | [page.tsx](../../../src/app/admin/create-user/page.tsx) |
| `/admin/item/create` | 商品作成 | ITEM タブの新規作成操作から移動 | [page.tsx](../../../src/app/admin/item/create/page.tsx) |
| `/admin/item/edit/[id]` | 商品編集 | ITEM 一覧の編集操作から移動 | [[id]/page.tsx](../../../src/app/admin/item/edit/%5Bid%5D/page.tsx) |
| `/admin/look/create` | LOOK 作成 | LOOK タブの新規作成操作から移動 | [page.tsx](../../../src/app/admin/look/create/page.tsx) |
| `/admin/look/edit/[id]` | LOOK 編集 | LOOK 一覧の編集操作から移動 | [[id]/page.tsx](../../../src/app/admin/look/edit/%5Bid%5D/page.tsx) |
| `/admin/news/create` | NEWS 作成 | NEWS タブの新規作成操作から移動 | [page.tsx](../../../src/app/admin/news/create/page.tsx) |
| `/admin/news/edit/[id]` | NEWS 編集 | NEWS 一覧の編集操作から移動 | [[id]/page.tsx](../../../src/app/admin/news/edit/%5Bid%5D/page.tsx) |
| `/admin/stockist/create` | 取扱店作成 | STOCKIST タブの新規作成操作から移動 | [page.tsx](../../../src/app/admin/stockist/create/page.tsx) |
| `/admin/stockist/edit/[id]` | 取扱店編集 | STOCKIST 一覧の編集操作から移動 | [[id]/page.tsx](../../../src/app/admin/stockist/edit/%5Bid%5D/page.tsx) |
| `/ui` | UI コンポーネントギャラリー | 共通ヘッダーの UI メニューから移動。商品画面ではない | [page.tsx](../../../src/app/ui/page.tsx) |
| `/loading` | LOADING デザインギャラリー | Admin のみ利用可能。共通ヘッダーの LOADING メニューから移動 | [page.tsx](../../../src/app/loading/page.tsx) |

## 画面とルートの扱い

- 現行リポジトリで `page.tsx` を持つ画面ルートは37件。Next.js の `error.tsx` などのエラー境界、API Route Handler、外部サービスの画面はこの件数に含めない。
- ニュース・商品・LOOK のカテゴリや季節、アカウントと管理のタブ、決済完了は、独立した `page.tsx` がなければ別画面数に加えない。表示状態と URL クエリの対応は実装に従う。
- `/account` は未ログイン時にログイン案内を表示し、`/login/verify` は検証セッションがない場合にログインへ戻る。`/admin` の表示タブはロールで変わる。個別フォームの API 認可とページ表示の制御は、それぞれの実装で確認する。
- `AdminTabs` と `AdminSideNav` の型には `CONTACT` が定義されているが、現行 `/admin` が渡すタブ一覧には含まれない。この一覧では型の候補でなく実際に渡されるタブを記載した。
- 画面の存在だけから本番公開やアクセス可否を推定しない。配置環境の公開範囲は別途設定と実動作で確認する。

## 根拠

- 画面ルート: `rg --files src/app -g page.tsx`
- 共通ナビゲーション: [Header](../../../src/components/Header.tsx)、[Footer](../../../src/components/Footer.tsx)
- 管理タブ: [admin/page.tsx](../../../src/app/admin/page.tsx)、[AdminTabs](../../../src/components/AdminTabs.tsx)、[AdminSideNav](../../../src/components/AdminSideNav.tsx)
- アカウント・認証: [LoginContext](../../../src/contexts/LoginContext.tsx)、[認証シーケンス](../../04_DetailDesign/sequence/auth-login-mfa.md)
- 購入: [商品詳細](../../../src/app/item/%5Bid%5D/ItemDetailClient.tsx)、[カート](../../../src/app/cart/page.tsx)、[チェックアウト](../../../src/app/checkout/page.tsx)

## 未確認事項

本番の公開 URL と実際の権限設定、全画面の実行時表示、`/admin/create-user` および `/auth/callback` の意図された入口は確認していない。これらの画面が利用者向け導線に必要なら、入口と要件を決めてから追加する。