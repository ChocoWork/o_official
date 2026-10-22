# 1.15 マイアカウントページ（ACCOUNT）詳細設計

> 状態: 既存設計 | 実装状況は項目ごとに要再照合

## 概要

本書は「1.15 マイアカウントページ（ACCOUNT）詳細設計」の既存設計を記録する。要件IDと設計意図を保持しているが、表中の実装状況は現在のコードと一括再照合していない。E-3 段2の別画面の申し込み・写真・注文の返品とキャンセルの欄は末尾に記す。

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ACCOUNT-001 | `/account` ページはプロフィールタブ・配送情報タブ・注文履歴タブを提供し、`?tab=` クエリと表示状態を同期する | IMPL-ACCOUNT-001 | `src/app/account/page.tsx` | `useSearchParams` と `router.replace` を併用し、`profile` / `shipping` / `orders` の3タブと `?tab=` クエリを同期し、旧 `address` 指定は `shipping` へ正規化する | 済 |
| FR-ACCOUNT-002 | プロフィールタブではメールアドレス（読み取り専用）・氏名・電話番号を表示・編集できる | IMPL-ACCOUNT-002 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | `/api/profile` が認証済みユーザーの email / 氏名 / 電話番号を返し、account 画面で read-only メール表示と編集保存を行う | 済 |
| FR-ACCOUNT-003 | 未ログイン時のアクセスは案内表示またはログイン導線で適切にハンドリングする | IMPL-ACCOUNT-003 | `src/app/account/page.tsx` | `isLoggedIn` が false の場合に案内テキストと `/login` への誘導ボタンを表示する | 済 |
| FR-ACCOUNT-004 | 配送情報タブでは郵便番号・都道府県・市区町村・番地を入力・保存でき、郵便番号入力時に住所自動補完を行う | IMPL-ACCOUNT-004 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | 配送情報タブで住所を保存し、郵便番号補完は `/api/checkout/postal-code` 経由で実行する | 済 |
| FR-ACCOUNT-005 | 注文履歴タブでは過去の注文を一覧表示し、注文詳細への遷移を提供する | IMPL-ACCOUNT-005 | `src/app/account/page.tsx`, `src/app/api/orders/route.ts`, `src/app/api/orders/[id]/route.ts`, `src/app/account/orders/[id]/page.tsx` | `/api/orders` で本人注文一覧を返し、一覧カードと `/account/orders/[id]` の注文詳細導線を実装する。状態の言葉は進み具合の言葉（未決済・受注生産中・発送準備中・配送中。FREQ-441）で、注文詳細は進み具合の段と発送ごとの配送情報を出す（FREQ-444）。返金ごとの行と返金済みの印も出す（FREQ-460）。返品の交換の品の行には印「交換の品」を付け、値段は「—」にする（FREQ-473） | 済 |
| FR-ACCOUNT-006 | 顧客プロフィールの保存項目を拡張し、フリガナ・住所を含めた完全な顧客情報を管理できるようにする | IMPL-ACCOUNT-006 | `src/app/account/page.tsx`, `src/app/api/profile/route.ts` | `profiles.kana_name` / `phone` / `address` を保存対象に含め、プロフィール編集から完全な顧客情報を管理できるようにする | 済 |
| FR-ACCOUNT-007 | account ページからログアウトできる導線を提供し、ログアウト後は未ログイン状態を明示する | IMPL-ACCOUNT-007 | `src/app/account/page.tsx`, `src/contexts/LoginContext.tsx`, `src/app/api/auth/logout/route.ts` | account サイドバーにログアウトボタンを追加し、`/api/auth/logout` 呼び出し後に未ログイン案内表示へ戻す | 済 |
| FR-ACCOUNT-008 | メールアドレスをプロフィールカードへ含め、配送先住所 UI を配送情報タブへ分離する | IMPL-ACCOUNT-008 | `src/app/account/page.tsx`, `e2e/FR-ACCOUNT-008-profile-address-integration.spec.ts` | プロフィールカード内に read-only メール表示を含め、住所管理は配送情報タブへ分離する | 済 |
| FR-ACCOUNT-009 | ログイン中アカウントのメールアドレスをプロフィール欄へ表示し、プロフィール取得失敗を解消する | IMPL-ACCOUNT-009 | `src/app/api/profile/route.ts`, `src/lib/supabase/server.ts`, `e2e/FR-ACCOUNT-009-authenticated-profile-fetch.spec.ts` | account API が Bearer token または `sb-access-token` Cookie から本人を解決できるようにし、プロフィール取得を成功させる | 済 |
| FR-ACCOUNT-010 | 購入履歴をログイン中アカウントに紐づく注文で表示し、注文履歴取得失敗を解消する | IMPL-ACCOUNT-010 | `src/app/api/orders/route.ts`, `src/app/api/orders/[id]/route.ts`, `src/lib/supabase/server.ts`, `e2e/FR-ACCOUNT-010-authenticated-order-history-fetch.spec.ts` | orders API が Bearer token または `sb-access-token` Cookie から本人を解決できるようにし、購入履歴一覧と注文詳細取得を成功させる | 済 |

---

## TODO一覧 (ACCOUNT-FOLLOWUPS)

| 要件ID | 種別 | 現状 | 修正/確認計画 |
|--------|------|------|--------------|
| FR-ACCOUNT-008 | 完了 | 配送先住所 UI をプロフィールタブへ統合し、独立タブを廃止した | 旧 `?tab=address` の導線が `profile` へ正規化される状態を維持する |
| FR-ACCOUNT-009 | 完了 | profile API が custom auth cookie / Bearer token から本人を解決できるようになった | メールアドレス欄の実アカウント表示とプロフィール取得回帰を維持する |
| FR-ACCOUNT-010 | 完了 | orders API が custom auth cookie / Bearer token から本人を解決できるようになった | 購入履歴一覧と注文詳細取得の回帰を維持する |
| FR-ACCOUNT-002 | 完了 | `/api/profile` が認証済みユーザーの email / 氏名 / 電話番号を返すようになった | account 画面の read-only メール表示と Playwright 回帰を維持する |
| FR-ACCOUNT-004 | 完了 | 住所保存と `/api/checkout/postal-code` 経由の補完を実装した | 保存後メッセージと住所表示同期の回帰を維持する |
| FR-ACCOUNT-005 | 完了 | `/api/orders` と `/account/orders/[id]` による注文一覧・詳細導線を実装した | 注文が 0 件の空状態と本人注文のみ表示の前提を維持する |
| FR-ACCOUNT-006 | 完了 | フリガナ・住所を含む完全プロフィール保存を実装した | checkout からの既存 `/api/profile` payload 互換を維持する |
| FR-ACCOUNT-007 | 実装 | account ページからログアウトできる要件を追加済み | account 詳細設計と実装の整合性を維持する |
| FR-ACCOUNT-007 | UI | account ページにログアウトボタンを追加済み | ボタン文言・状態表示・エラー表示を回帰確認する |
| FR-ACCOUNT-007 | 認証 | `LoginContext.logout` を API `/api/auth/logout` と整合済み | サーバー logout とクライアント状態更新の両方を維持する |
| FR-ACCOUNT-001〜007 | E2E | account 認証モック共通 helper と要件単位の Playwright 試験を整備済み | Chromium で `FR-ACCOUNT-001` 〜 `007` が通る状態を維持する |
| FR-ACCOUNT-007 | E2E | logout フローの Playwright 試験を実行可能な形で実装済み | OTP モックから `/account` へ遷移する検証パターンを維持する |
| FR-ACCOUNT-001 / 002 / 004 / 005 / 006 | 検証 | 事前に作成した Playwright 試験を Chromium で実行し、skip を解消した | 実データ環境でも同一シナリオを継続確認する |

## 今回の実装計画

1. `FR-ACCOUNT-008〜010` の Playwright 試験ファイルを追加し、住所統合・認証付きプロフィール取得・認証付き注文履歴取得の期待挙動を固定した。
2. account 画面と関連 API の認証経路を調査し、client 側 login 状態と server 側 `supabase.auth.getUser()` の不整合原因が custom auth cookie 未考慮にあると切り分けた。
3. `src/app/account/page.tsx` を更新し、配送先住所 UI をプロフィールタブへ統合し、独立タブを廃止した。
4. profile / orders API を更新し、Bearer token または `sb-access-token` Cookie から本人を解決してメールアドレスと購入履歴を返せるようにした。
5. Playwright で account 要件と画面崩れを再確認し、詳細設計のステータス更新まで完了した。

### 統合メモ

- logout 後は `/account` 上で未ログイン案内表示へ戻し、明示的にログアウト完了を確認できるようにする。
- E2E は login ページの OTP モックから SPA 遷移で `/account` に入り、セッション永続化なしでも UI フローを確認する。
- 実運用では client の localStorage セッションと server API の認証判定がずれる可能性があるため、account 系 fetch は Bearer token を付与できる実装へ寄せる。
- OTP verify 成功時は browser 側の Supabase session / localStorage も同期し、ログイン直後のプロフィール取得で認証不整合が起きないようにする。
- Supabase の profiles 保存は RLS が有効なため、account/profile API は request ごとの Authorization ヘッダを Supabase client に引き渡し、DB query 自体もユーザー文脈で実行する。
- account の電話番号と郵便番号入力は、表示は自動整形しつつ、ユーザーは数字のみを意識して入力できる状態を維持する。郵便番号の補完 API 呼び出しと保存 payload は正規化済みの数字列を使う。
- account のプロフィールタブはメールアドレス・氏名・フリガナ・電話番号を扱い、配送情報タブは住所情報のみを扱う。削除操作もタブごとの情報範囲に限定する。

## 注文の言葉・進み具合・発送ごとの配送情報（ACCOUNT-ORDER / FREQ-441・444）

2026-10-10 から、購入履歴と注文詳細の状態は、商品ごとの数から出した進み具合の言葉で見せる（[グループ E-1 設計書](../../superpowers/specs/2026-10-10-partial-fulfillment-design.md) の 4 章・9-3）。DB の状態の値は変えない。

| 画面 | 内容 |
| --- | --- |
| 購入履歴の一覧（`GET /api/orders`） | 状態の言葉は「未決済・受注生産中・発送準備中・配送中・配達済み・決済失敗・キャンセル」。「支払い手続き中」「放棄」の注文は今までどおり出さない（FREQ-441） |
| 状態の言葉（注文詳細の上） | 進み具合の言葉を出し、決済完了・発送済みの注文で、発送した数が1以上かつ未発送の数も1以上なら「一部発送済み」の印を添える（窓口の progress.partiallyShipped。全額返金で取り消した注文には出ない） |
| 進み具合（注文詳細。名前「配送ステータス」の一覧） | 在庫の品だけの注文は「お支払い・発送準備中・配送中・配達済み」の4段、受注生産の品を含む注文は「お支払い・受注生産中・発送準備中・配送中・配達済み」の5段。済み・今の段は黒、これからの段は灰色。キャンセル・決済失敗の注文と、返金を待つ間の注文（「キャンセルの手続き中」）には出さない。今の段は、注文のいちばん手前の段階で決める（FREQ-444） |
| 配送情報 | 発送ごとに「配送情報（n回目）」の区切りを出し（n は DB の発送の番号のまま。取り消した発送があると、出す番号は飛ぶ）、発送日・配送業者・追跡番号・追跡のリンク（「配送状況を確認する」）・その発送の商品と数を並べる。取り消した発送と、発送が無い注文には出さない。窓口は注文の行の発送日時・配送業者・伝票番号を返さず、`shipments` に置き換える |
| まだ送っていない商品 | 「発送準備中の商品」「受注生産中の商品」の見出しの下に並べる（窓口が商品ごとの `readyQuantity`・`inProductionQuantity` を返す） |

注文の窓口（`GET /api/orders/[id]`）は、持ち主を確かめた後に、アプリ（service_role）でその注文の発送と数を読む。新しい発送の表はお客様から直接読めない。

### 受け付け基準と E2E（グループ E-1）

| 受け付け基準 | 確かめること | E2E |
| --- | --- | --- |
| FREQ-441-AC-03 | 購入履歴の一覧に進み具合の言葉が出る | [FR-ADMIN-070](../../../e2e/FR-ADMIN-070-order-progress-labels.spec.ts) |
| FREQ-444-AC-01 | 在庫の品だけは4段、受注生産の品を含むと5段の進み具合 | [FR-ACCOUNT-032](../../../e2e/FR-ACCOUNT-032-order-progress-and-shipments.spec.ts) |
| FREQ-444-AC-02 | 発送ごとの配送情報（n回目）。発送が無い注文には出ない | FR-ACCOUNT-032、[FR-ACCOUNT-031](../../../e2e/FR-ACCOUNT-031-order-shipping-info.spec.ts) |
| FREQ-444-AC-03 | 発送準備中の商品・受注生産中の商品の見出し | FR-ACCOUNT-032 |
| FREQ-444-AC-04 | 取り消した発送は出ず、キャンセルした注文には段を出さない | FR-ACCOUNT-032 |

## 注文の画面の返金（ACCOUNT-ORDER-REFUND / FREQ-460）

2026-10-11 から、注文の詳細に返金を見せる（[グループ E-2 設計書](../../superpowers/specs/2026-10-11-refund-and-cancel-design.md) の 9-3）。DB の状態の値は変えない。金額は全角の `￥` と桁区切り（例 `￥12,800`）で出す。

| 画面 | 内容 |
| --- | --- |
| 支払金額の欄 | 「ご返金」の行を返金ごとに出す: `{日付} ￥{n}` と状態（「手続き中」か「完了」）。手続き中は返事待ち・保留の返金、完了は成功した返金。コンビニ払いで手続き中の返金には「返金先の口座の入力をお願いしています（{M月D日}まで）」を添える（日付は、日本時間で期限の1分後の日付の前日＝その日のうちに入れれば必ず間に合う最後の日。メールと同じ決まり。[refund-messages.ts](../../../src/lib/orders/refund/refund-messages.ts) の `konbiniDeadlineLastDay`）。返金が2件以上なら、その下に「ご返金の合計」を出す。古い順に並べる |
| 商品の欄 | 返金した商品（発送前・発送後の返金の合計）に「返金済み {n}点」の印を出す |
| 状態の言葉 | キャンセルの注文は今のとおり「キャンセル」。支払い済みで未発送も発送も0の注文に、手続き中の返金がある間は「キャンセルの手続き中」（段は出さない）。購入履歴の一覧の言葉もそろえる |
| 出さない物 | エラーと失敗の返金（店が連絡するため）。操作した人・メモ・照会番号・失敗の理由・Stripe に伝えた理由・返金の道は、窓口が返さない |

注文の窓口（`GET /api/orders/[id]`）は、持ち主を確かめた後に、アプリ（service_role）でその注文の返金を読む。返金の表はお客様から直接読めない。返金の読み出しに失敗したら500を返す（失敗を隠して返金の無い画面にすると、手続き中の返金がある注文が「発送準備中」と出るため）。

### 受け付け基準と E2E（グループ E-2）

| 受け付け基準 | 確かめること | E2E |
| --- | --- | --- |
| FREQ-460-AC-01 | 支払金額の欄に、返金ごとの日付・額・状態（手続き中・完了）が出る | [FR-ACCOUNT-033](../../../e2e/FR-ACCOUNT-033-order-refunds.spec.ts) |
| FREQ-460-AC-02 | 返金した商品に「返金済み N点」が出る | FR-ACCOUNT-033 |
| FREQ-460-AC-03 | コンビニ払いで手続き中の返金に口座の入力の期限の文が出る | FR-ACCOUNT-033 |
| FREQ-460-AC-04 | 失敗した返金とエラーの返金は出ない | FR-ACCOUNT-033 |
| FREQ-460-AC-05 | 返金を待つキャンセルの注文の状態が「キャンセルの手続き中」になる | FR-ACCOUNT-033 |

## 注文の画面の交換の品（ACCOUNT-ORDER-EXCHANGE / FREQ-473）

2026-10-13 から、返品の交換でお店が足した品（値段0の行）に「交換の品」の印を付ける（[グループ E-3 設計書](../../superpowers/specs/2026-10-12-returns-design.md) の 8-2。お客様の申し込みと返品の欄は段2）。DB の状態の値は変えない。

| 画面 | 内容 |
| --- | --- |
| ご注文商品 | 交換の品の行に、印「交換の品」（`data-testid="order-item-exchange"`）を数量の下に出し、値段は「—」にする。通常の品には印も「—」も出さない。交換の品の行も発送前の返金ができるので、「返金済み {n}点」の印と並んでも崩れない |
| 配送情報 | 発送ごとの区切りの中の交換の品の行にも、印「交換の品」（`data-testid="order-shipment-exchange"`）を行の末尾に出す |
| まだ送っていない商品 | 「発送準備中の商品」「受注生産中の商品」の欄には付けない |
| 購入履歴の一覧 | 変えない（商品の金額も商品数も出していない） |

注文の窓口（`GET /api/orders/[id]`）は、商品の行と発送の商品の行に `lineKind`（`order`・`exchange`）を返す。金額 `amount` は DB の値のまま（交換の品の行は ￥0）で、値段を「—」にするのは画面。一覧の窓口（`GET /api/orders`）の `itemCount` は交換の品の行も数えるが、画面は使わない（管理画面の一覧の商品数は交換の品の行を数えない）。

### 受け付け基準と E2E（グループ E-3）

試験: [FR-ACCOUNT-034](../../../e2e/FR-ACCOUNT-034-order-exchange-items.spec.ts)、[OrderItemRow の単体](../../../tests/unit/components/OrderItemRow.test.tsx)、[注文の画面の単体](../../../tests/unit/components/AccountOrderDetailPage.test.tsx)、[注文の窓口の単体](../../../tests/unit/api/orders/order-detail-progress.test.ts)。

| 受け付け基準 | 確かめること | E2E・試験 |
| --- | --- | --- |
| FREQ-473-AC-01 | 注文の画面のご注文商品の交換の品に「交換の品」の印と値段「—」が出て、通常の品には出ない | E2E FR-ACCOUNT-034、単体 OrderItemRow・AccountOrderDetailPage |
| FREQ-473-AC-02 | 配送情報の交換の品にも「交換の品」の印が出る | E2E FR-ACCOUNT-034 |
| FREQ-473-AC-03 | 注文の窓口が品と発送の品に `lineKind` を返す（本物の窓口と手元の DB） | E2E FR-ACCOUNT-034（手元の DB）、単体 order-detail-progress |
| FREQ-473-AC-04 | 交換の品が無い注文には印も「—」も出ず、横方向のページスクロールも発生しない | E2E FR-ACCOUNT-034 |

## 返品・交換の申し込みと注文の欄（E-3 段2 / FREQ-475〜477・480・481）

注文の右の列（aside）の支払金額の後、問い合わせの前に OrderReturnsSection を置く。GET /api/orders/[id] の returnSection: CustomerOrderReturns | null を読み、null なら欄を出さない。欄を読めない場合も注文は200で返る。店のメモ・お断りの理由の記号・した人のメール・返金の失敗の中身は受け取らない。返送先は open の間だけ。

「返品・交換を申し込む」は available の時に別の /account/orders/[id]/return を開く。キャンセルの申し込みは同じ欄の中で CancelRequestForm を開き、Dialog にしない。入金後の選べる数は readyQuantity + inProductionQuantity、未入金は quantity。DB が未発送の数を再確認する。受付後は reloadCount で注文の答えを読み直す。

申し込みは3段で、写真を送っている間は確かめる段に進めない。二重防止の番号は確かめる段への移動時に作る。通信切れ・500番台は入力を止めて同じ番号と本文で確認、400・409は番号を作り直す。401・403・429は番号を保つ。RETURN_PHOTO_INVALID は品を選ぶ段へ戻して誤りへフォーカスを移す。見本は data: の画像で、署名つき URL を画面の文やログへ出さない。

### 文言と表示条件

- お客様の申し込みの画面: 題 `返品・交換のお申し込み`、注文番号の行 `ご注文番号: {注文番号}`、段の名前 `1. 商品を選ぶ`・`2. 内容を確かめる`・`3. お申し込みの受付`、注意書き（設定の文をそのまま。空なら出さない）、発送の見出し `{n}回目の発送（{M月D日}発送）`、期限 `返品・交換の受付：{M月D日}まで`・`返品・交換の受付：期限なし`、品 `{品名}（{色} / {サイズ}）`、選ぶ `この商品を申し込む`、数 `数`（選べる数まで）、理由 `理由`（選んでください `選んでください`）、詳しい内容 `詳しい内容（必須・300字まで）`・`詳しい内容（任意・300字まで）`、写真 `写真（必須・{n}枚まで）`・`写真（任意・{n}枚まで）`・案内の文（理由の設定の文をそのまま）・ボタン `写真を選ぶ`・`この写真を外す`・送っている間 `写真を送っています…`、ご希望 `ご希望`（`返金`・`交換`）、交換 `交換する色・サイズ`、作って送る `お作りしてお送りします（お届けの目安 {n}日）`（目安が無い・0日は `お作りしてお送りします`）、選べない色・サイズ `在庫がないため選べません`、返品不可の品 `この商品は返品不可の商品です。初期不良・誤送の時だけお申し込みいただけます。`、選べない品の言葉 `受付の期限を過ぎました`（`past_deadline`）・`お申し込み済み`（`requested`）・`お返しした商品のため、お申し込みいただけません`（`sent_back`）・`お申し込みいただける数がありません`（`unavailable`）、ボタン `内容を確かめる`・`戻る`・`申し込む`・`注文の画面に戻る`
- 確かめる段: 見出し `お申し込みの内容`、行 `{品名}（{色} / {サイズ}） × {n}`・`理由: {理由}`・`詳しい内容: {文}`・`ご希望: 返金`／`ご希望: 交換（{色} / {サイズ}）`・`写真 {n}枚`、返送料 `返送料: 当店が負担します（着払いでお送りください）`（負担が店）・`返送料: お客様のご負担です`（負担がお客様で `customer_ships`）・`返送料: ￥{n}（ご返金から差し引きます）`（負担がお客様で `shop_label`、返送料が1円以上）・`返送料: 当店がご用意する送り状でお送りください。`（負担がお客様で `shop_label`、返送料が0円）、手数料（使う物だけ）`返品の手数料: ご返金の商品の額の {n}%`・`交換の手数料: ￥{n}`・`交換の送料: ￥{n}`、手数料の添え書き（手数料がある時だけ。仕様書 6-4）は、返金の品がある時 `手数料はご返金から差し引きます。差し引けない分は、お支払いのご案内をお送りします。`、交換だけの時 `手数料は、お支払いのご案内をお送りします。お支払いの後に交換の品をお送りします。`、注意 `お申し込みの後、当店で内容を確かめてから、メールでご連絡します。`
- 受け付けた段: `お申し込みを受け付けました。内容を確かめて、メールでご連絡します。`（返品番号 `返品番号: {注文番号}-R{n}`）
- 申し込みの画面の入力の誤り: `申し込む商品を選んでください。`・`理由を選んでください。`・`詳しい内容を入れてください（300字まで）。`・`写真を1枚以上選んでください。`・`写真は{n}枚までです。`・`JPEG か PNG の写真を選んでください。`・`1枚 10MB までの写真を選んでください。`・`写真を送れませんでした。もう一度選んでください。`・`交換する色・サイズを選んでください。`
- 申し込みの画面のほかの文: 段の並びの見出し `お申し込みの手順`、ログインしていない時 `お申し込みにはログインが必要です`、読み込み中 `読み込み中...`、交換の色・サイズの欄の最初 `選んでください`
- 申し込みの画面の答えが分からない時: `お申し込みの結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。`（ボタン `もう一度確かめる`）
- 申し込みの画面を開けない時: `closed` `現在、返品・交換のお申し込みを受け付けていません。`、`ended` `返品・交換の受付は {M月D日} で終わりました`、`none` `この注文は、返品・交換のお申し込みを受け付けていません。`、読み込めない `お申し込みの画面を読み込めませんでした。時間をおいて、もう一度お試しください。`
- お客様の注文の画面: ボタン `返品・交換を申し込む`（`available` の時）、受付の終わり `返品・交換の受付は {M月D日} で終わりました`（`ended` の時）、欄の見出し `返品・交換`、返品の番号 `返品番号 {注文番号}-R{n}`、状態の言葉と添える文（`requested` `お申し込み中`・`内容を確かめて、メールでご連絡します。`／`accepted` `返品の受付済み`・返送のしかた／`partially_received` `一部をお受け取りしました`・`残りの商品の返送のしかたは、下のとおりです。`と返送のしかた／`inspecting` `お受け取りしました（確かめています）`・`確かめてから、ご連絡します。`／`awaiting_fee` `お支払いをお待ちしています`・`ご案内のメールをご覧ください。`／`refund_preparing` `ご返金の準備中`・添える文なし／`returned` `返品済み`・交換の品がある時 `交換の品をお送りします。`（`exchangeShipping` が `pending`）か `交換の品をお送りしました。`（`shipped`）／`declined` `お受けできませんでした`・`当店より:` とお店のメッセージ）、行 `{品名}（{色} / {サイズ}） × {n}`、申し込み中のご希望 `ご希望: 返金`／`ご希望: 交換（{色} / {サイズ}）`、承認の後の解決 `返金`／`交換: {色} / {サイズ}`、返金 `ご返金 ￥{n}`、返送のしかたの見出し `返送のしかた`、返送不要 `品物のご返送は不要です。`、ほか `下記の返送先へお送りください。`・返送料の文（負担が店 `返送料は当店が負担いたします。着払いでお送りください。`、お客様で `customer_ships` `恐れ入りますが、返送料はお客様のご負担でお送りください。`、`shop_label` `当店がご用意する送り状でお送りください。返送料 ￥{n} をご返金額から差し引きます。`、`shop_label` で返送料が0円 `当店がご用意する送り状でお送りください。`）・`返送先:`・`{名前}`・`〒{郵便番号} {住所}`・`{電話番号}`、お返しの見出し `お返しした商品`・`当店より:`・`送り返しの伝票番号: {配送業者} {伝票番号}`
- キャンセルの申し込み（お客様の注文の画面）: ボタン `キャンセルを申し込む`（`availability.cancel` の時）、画面の題 `キャンセルのお申し込み`、`キャンセルする商品`、品 `{品名}（{色} / {サイズ}）`・`数`、`ご連絡事項（任意・300字まで）`、ボタン `申し込む`・`戻る`、受け付けた `キャンセルのお申し込みを受け付けました。内容を確かめて、メールでご連絡します。`、受付オフで断られた時 `現在、キャンセルのお申し込みを受け付けていません。`（`RETURN_REQUESTS_CLOSED`）、入力の誤り `キャンセルする商品を選んでください。`、申し込みの状態 `requested` `キャンセルのお申し込み中`／`declined` `キャンセルのお申し込みをお受けできませんでした`・`当店より:` とメッセージ／`resolved`・`closed` `キャンセルのお申し込みのお手続きが済みました`

状態は DB の注文の状態とは別に表示する。requested の間はご希望、承認後は解決を出す。返金額は受け付けられた返金の合計、取消の返品は出さない。お店のメッセージは HTML として解釈しない。金額は formatYen の全角の ￥ と桁区切り、日付は日本時間の M月D日。

### 受け付け基準と検証

E2E は FR-ACCOUNT-035-return-request.spec.ts・036-return-request-photos.spec.ts・037-return-request-eligibility.spec.ts・038-order-returns.spec.ts・039-cancel-request.spec.ts。DB 結合は tests/integration/db/ の同名、単体は tests/unit/ 以下の同名のファイルで確かめる。

| 受け付け基準 | 確かめること | 確かめ方 |
| --- | --- | --- |
| FREQ-475-AC-01 | 発送ごとの品・数・理由・詳しい内容・ご希望を選び、品を選ぶ→確かめる→受け付けた段の3段で進むこと | E2E FR-ACCOUNT-035、単体 ReturnRequestForm・ReturnRequestConfirm |
| FREQ-475-AC-02 | 設定で出す理由だけを出し、unknown を出さず、defective・other の詳しい内容1〜300字を必須にすること | E2E FR-ACCOUNT-035、DB 結合 order_return_customer_requests、単体 return-request-model |
| FREQ-475-AC-03 | ご希望を理由の resolutions で絞り、同じ商品の有効な色・サイズだけを選べ、在庫不足は make の設定だけで選べること | E2E FR-ACCOUNT-035、DB 結合 order_return_customer_requests、単体 return-request-model |
| FREQ-475-AC-04 | 確かめる段に品・理由・詳しい内容・ご希望・写真の数、返送料の負担と手数料の仮の値（仕様書 5-1）と確認の文を出し、手数料の添え書きは、返金の品がある時と交換だけの時で分けること | E2E FR-ACCOUNT-035・FR-ACCOUNT-036、単体 ReturnRequestConfirm・return-request-model |
| FREQ-475-AC-05 | 受付の文「お申し込みを受け付けました。内容を確かめて、メールでご連絡します。」と返品番号を出すこと | E2E FR-ACCOUNT-035、単体 ReturnRequestConfirm |
| FREQ-475-AC-06 | requested・customer_request の返品、仮の解決・ご希望の行、写真、使用済みの印、受付と店への予定2行を同じ取引で作ること | E2E FR-ACCOUNT-035（本物の窓口・DB・Mailpit）、DB 結合 order_return_customer_requests |
| FREQ-475-AC-07 | 同じ発送の同じ商品は1行でご希望を1つ選び、未選択・理由なし・交換先なしを送信前に止めること | E2E FR-ACCOUNT-035（未選択の止め）、単体 return-request-model・ReturnRequestForm |
| FREQ-475-AC-08 | 通信切れ・500番台の後は入力を止め、同じ番号・本文で「もう一度確かめる」を出し、返品・写真・予定を増やさないこと | E2E FR-ACCOUNT-035、DB 結合 order_return_customer_requests、単体 customer-return-client・ReturnRequestConfirm・ReturnRequestForm・return-request-routes |
| FREQ-476-AC-01 | JPEG・PNG の1枚10MB（10,000,000バイト）までを選び、長い辺2000px・JPEG品質0.85に作り直して送ること | E2E FR-ACCOUNT-036、単体 return-photo-client・ReturnPhotoPicker |
| FREQ-476-AC-02 | none・optional・required と案内の文を反映し、1つの返品の行に5枚までで、送信中は「内容を確かめる」を押せないこと | E2E FR-ACCOUNT-036、単体 ReturnPhotoPicker・ReturnRequestForm |
| FREQ-476-AC-03 | 非公開 return-photos に requests/{注文の id}/{送り先の id} を出し、upsert: false・有効2時間の署名つきの送り先を使うこと | E2E FR-ACCOUNT-036（本物の Storage）、DB 結合 order_return_request_records、単体 return-photo-storage |
| FREQ-476-AC-04 | サーバーが印・大きさ・作りを調べ、JPEG の APP0・APP14 を残してほかの APP1〜APP15 と COM、PNG の eXIf・tEXt・zTXt・iTXt・tIME を外して置き直すこと | E2E FR-ACCOUNT-036（位置情報入り JPEG・文字入り PNG の直接送信）、単体 return-photo-sanitize・return-photo-storage |
| FREQ-476-AC-05 | 画像でない物・壊れた物を400 RETURN_PHOTO_INVALID と invalidPhotoUploadIds で断り、申し込みを記録しないこと | E2E FR-ACCOUNT-036、単体 return-photo-sanitize・return-request-routes |
| FREQ-476-AC-06 | 管理画面は権限を確認して10分の写真のリンクを出し、大きく見られ、消した写真は url: null・purged: true と消した旨の文になること | E2E FR-ADMIN-094（消していない写真のリンクと大きく見ること）、DB 結合 order_return_request_reviews（消した写真の印）、単体 ReturnPhotoViewer・order-return-review-routes（消した写真の url: null と文） |
| FREQ-476-AC-07 | 未使用は作成から1日、closed・cancelled・declined の写真は各終了時刻から90日より前だけを、古い順に合わせて500件まで対象にすること | E2E FR-ACCOUNT-036（未使用1日・終了後90日）、DB 結合 order_return_request_reviews |
| FREQ-476-AC-08 | Storage API の remove 成功分だけ purged_at を書き、行を消さず、再実行で安全に続けられること | 単体 return-photo-storage・purge-return-photos-route、DB 結合 order_return_request_reviews |
| FREQ-476-AC-09 | 定期処理の200は uploads・photos の数、失敗は502を返し、return_photo_purge の成功が49時間より古ければ job_stale_return_photo_purge で知らせること | 単体 purge-return-photos-route・ops-checks・ops-alert-mail、DB 結合 order_return_request_records（見回りの印の CHECK） |
| FREQ-477-AC-01 | selectable・past_deadline・requested・sent_back・unavailable を所定の優先順で決め、selectable だけ選べること | E2E FR-ACCOUNT-037、DB 結合 order_return_customer_requests、単体 ReturnRequestForm |
| FREQ-477-AC-02 | 日本時間の期限当日23:59:59までは申し込め、翌日0:00の直接送信は RETURN_NOT_ELIGIBLE、期限なしは null になること | DB 結合 order_return_customer_requests |
| FREQ-477-AC-03 | 返品不可は defective・wrong_item だけを選べ、ほかの理由の直接送信も DB が断ること | E2E FR-ACCOUNT-037、DB 結合 order_return_customer_requests、単体 return-request-model |
| FREQ-477-AC-04 | available・ended・closed・none を区別し、ended は終了日、closed は受付停止の文を出して直接送信も断ること | E2E FR-ACCOUNT-037、DB 結合 order_return_customer_requests、単体 ReturnRequestPage |
| FREQ-477-AC-05 | 申し込み済み・お返しした品・数が無い品を選べず、『お申し込み済み』『お返しした商品のため、お申し込みいただけません』『お申し込みいただける数がありません』を出すこと | E2E FR-ACCOUNT-037、単体 ReturnRequestForm |
| FREQ-477-AC-06 | paid・shipped の取り消していない発送だけを材料にし、発送の行と注文の商品ごとの返品できる数の小さい方まで受けること | DB 結合 order_return_customer_requests、単体 customer-return-store |
| FREQ-477-AC-07 | 出していない理由・unknown・理由に無いご希望・別の商品や無効な交換先を DB が断ること | DB 結合 order_return_customer_requests |
| FREQ-480-AC-01 | 注文の右の列の支払金額の後・問い合わせの前に「返品・交換」を置き、available だけ申し込みボタン、ended は終了日の文を出すこと | E2E FR-ACCOUNT-035（申し込みの入口）・FR-ACCOUNT-037（終了日の文）、単体 AccountOrderDetailPage（欄の位置）・OrderReturnsSection |
| FREQ-480-AC-02 | requested・accepted・partially_received・inspecting・awaiting_fee・refund_preparing・returned・declined を、順に『お申し込み中』『返品の受付済み』『一部をお受け取りしました』『お受け取りしました（確かめています）』『お支払いをお待ちしています』『ご返金の準備中』『返品済み』『お受けできませんでした』の言葉と添える文で出すこと | E2E FR-ACCOUNT-038、DB 結合 order_return_customer_requests、単体 OrderReturnsSection |
| FREQ-480-AC-03 | 受付中だけ返送先としかたを出し、返送不要・店負担・お客様負担・お店の送り状（返送料が0円なら金額を出さない）を区別すること | E2E FR-ACCOUNT-038、DB 結合 order_return_customer_requests、単体 OrderReturnsSection（返送料が0円の送り状を含む） |
| FREQ-480-AC-04 | お返しの品・メッセージ・伝票番号、受け付けられた返金の額、交換の発送待ち・発送済みの一文を出すこと | E2E FR-ACCOUNT-038、単体 OrderReturnsSection |
| FREQ-480-AC-05 | 取消の返品、店のメモ・理由の記号・した人のメール・返金の失敗の中身を返さないこと | DB 結合 order_return_customer_requests、単体 customer-return-store |
| FREQ-480-AC-06 | returnSection が読めない時は null・注文200、画面は欄を出さず、ログは誤りの名前だけにすること | 単体 order-detail-progress・AccountOrderDetailPage |
| FREQ-480-AC-07 | 受付後は注文を読み直し、3つの画面幅で横方向のページスクロールが出ないこと | E2E FR-ACCOUNT-038・FR-ACCOUNT-039、単体 AccountOrderDetailPage |

キャンセルの申し込みは FREQ-481-AC-01〜03 と FREQ-480-AC-07。管理側の解決・お断り・履歴は [管理画面](16_admin.md) に記す。

## 配送の状況（E-4 / FREQ-488〜497）

[配送の詳細設計](../../superpowers/specs/2026-10-21-delivery-status-design.md)・[実装計画](../../superpowers/plans/2026-10-21-delivery-status.md)を参照。以下は実装後の契約であり、既存の決定の本文は履歴として残す。

### 発送ごとの表示（設計7-1の実装後の条件）

| 表示 | 追跡オフ | 追跡オン |
| --- | --- | --- |
| 伝票番号・追跡リンク | いつも。直した後は新番号だけ | 同じ |
| 配達済み・お届け日 | 手または追跡の `deliveredAt` があれば表示 | 同じ |
| 今の8状況・最後の更新・配送の移り変わり | 出さない | 鍵あり・現版の登録が `registered`、または `stopped` かつ `everRegistered=true` の時だけ |
| 問題あり・遅れの案内 | 出さない | 上と同じ条件で「配送に遅れや問題が出ています。詳しくは配送業者のページをご確認ください」 |

状況の言葉は「受付済み」「輸送中」「配達中」「不在で持ち帰り」「受け取り待ち」「配達済み」「遅れ」「問題あり」。最後の更新は日本時間、届いた日は `M月D日`。移り変わりは現版だけを新しい順にし、状況と時刻だけを表示する。登録待ち・登録できない・一度も登録できず停止・鍵なしの間は状況のキー自体をAPIが返さず、リンクだけにする。取消済み発送は返さない。本人以外は404で、管理者名・細かい状況・登録状態は顧客へ渡さない。

`deriveOrderProgress` は受注生産中・発送準備中の品がなく、発送した数が1以上、取消でない発送の `activeCount>0` かつ `deliveredCount===activeCount` なら「配達済み」。一部だけなら「配送中」。追跡オフでも全部を手で配達済みにすれば同じ。

返品期限の起点は `deliveredAt` の日本時間の日付。NULLなら発送の日本時間の日付＋目安の日数に戻す。最後の品・受付の日数・日の終わり・無制限・既存の返品と申し込みは維持する。番号を直すと届いた時刻が消え、未作成の返品・申し込みの判定は目安へ戻る。

## 注文状況ページとの表示共有（E-5 / FREQ-501・502）

[詳細設計](../../superpowers/specs/2026-10-22-order-status-page-design.md)・[実装計画](../../superpowers/plans/2026-10-22-order-status-page.md)・[注文状況ページ](20_order_status.md)を参照。

会員にも同じ注文状況リンクを送る。持ち主のログインは確認期限後も個人情報を認可し、`/account/orders/{id}` から従来の返品・キャンセルを申し込める。別会員のログインだけでは認可しない。

`buildCustomerOrderDetailView` へ表示計算だけを共有し、会員APIの認証・所有者条件・エラー・JSONのキー/値/null/省略/配列順を維持する。返品だけの読取失敗は `returnSection:null` のまま。会員APIの口座期限や完全な返品の既存位置も変えない。

`OrderItemRow` と `OrderReturnsSection` の `readOnly:true` は注文状況の表示用。省略した会員側は既存の操作・ボタン・フォーム・送り返しの業者と番号の表記を維持する。公開の枝へダミーの個人情報やcallbackを渡さない。
