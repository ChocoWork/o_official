# checkout 1画面化 設計書

- 日付: 2026-09-11
- 対象: `src/app/checkout/page.tsx`、`src/app/api/checkout/create-session/route.ts`
- 分類: architectural（決済セッションのライフサイクルが変わるため）

## 1. 目的

checkout の step 1 が実質2画面（住所入力 →「お支払いに進む」→ 決済フォーム）に分かれている。
お客様情報・配送先・支払方法を1画面で入力できるようにし、購入までの往復を減らす。

ステッパーの2段（`注文を確定する` / `ご注文内容の確認`）は変更しない。step 2（確認）も変更しない。

## 2. 現状

| 要素 | 現状 |
|---|---|
| 画面遷移 | `paymentReady` が立つ → `/api/checkout/create-session` → `clientSecret` 取得 → `CheckoutProvider` 配下で決済フォーム描画 |
| `paymentReady` の立ち方 | (a) 保存済み住所＋連絡先が揃っているログインユーザーは自動、(b) それ以外は「お支払いに進む」押下 |
| 住所の反映 | セッションは作り直さず `/api/checkout/update-shipping` でドラフトの `shipping_snapshot` のみ更新（500ms デバウンス、`syncedShippingKey` で確定をゲート） |
| 確定ボタン | `確認へ進む`。`!clientSecret` または住所未同期で disabled |
| 住所スキーマ | `checkoutShippingSchema` は全項目 optional。空の配送先でもセッションは作れる |

## 3. 変更後の画面構成

```
[ステッパー] 1 注文を確定する ── 2 ご注文内容の確認   ← 変更なし

左列                                     右列
├ お客様情報（入力欄）                    ORDER SUMMARY
├ 配送先（保存済みプルダウン／入力欄）      商品明細
├ 支払方法（PaymentElement）               プロモコード
└ [確認へ進む]                             金額
```

廃止するもの:

- 「お支払いに進む」ボタンと `handleProceedToPayment`
- 「決済フォームを準備しています...」の単独画面
- 配送先セクションの「変更する」ボタンと `handleEditShipping`（セッションを捨てて入力に戻す必要がなくなる）
- `paymentReady` state

## 4. セッションのライフサイクル

### 4.1 生成タイミング

カート読み込み完了かつ `cartItems.length > 0` の時点で `create-session` を呼ぶ。配送先は空のまま送る。

- **二重生成ガード（必須）**: React StrictMode でマウント effect が2回走るため、in-flight を `useRef` で押さえ、`clientSecret` 取得済みなら再実行しない。
- カートが空、またはカート読込中は呼ばない（カートを持たないクローラがセッションを量産できない）。

### 4.2 セッション再利用（サーバ側）

`create-session` に再利用パスを追加する。毎表示で Stripe セッションと `checkout_drafts` 行が増えるのを防ぐ。

1. 既存フロー（CSRF → レート制限 → カート取得 → 在庫検証 → 金額再計算）はそのまま通す
2. `session_id`（Cookie）が一致し `status = 'created'` かつ `checkout_session_id` が非 NULL の最新 draft を1件引く
3. その draft の `items_snapshot` / `subtotal_amount` / `shipping_amount` / `total_amount` / `currency` が今回の再計算結果と一致するか照合
4. 一致したら `stripe.checkout.sessions.retrieve()` し、`status === 'open'` かつ `client_secret` があればそれを返す（新規 insert も新規 Stripe セッション作成もしない）
5. 不一致・`open` でない・retrieve 失敗のいずれかなら、現行どおり新規作成にフォールバックする

`payment_method_types` はセッション生成時に決まるので、再利用の照合キーには `selected_payment_method`（metadata）も含める。

### 4.3 配送先の反映

既存の仕組みをそのまま使う。`isShippingComplete` が真かつ `syncedShippingKey` と異なるときだけ 500ms デバウンスで `update-shipping` を呼ぶ。セッションは作り直さないので PaymentElement は再マウントされない。

## 5. 確定ボタンの挙動

押下時に順に実行する。未入力でも disabled にはしない。

1. `validateShippingForm()` → エラーがあれば `focusFirstError()`（FREQ-348）で先頭の欄へフォーカスして中断
2. 未同期なら `await updateDraftShipping()` を即時実行（デバウンス待ちを潰す）
3. 新規住所かつ保存 ON なら `persistSavedProfileAndAddress()`
4. `checkout.confirm()` → 成功で step 2 へ

disabled にするのは「セッション未準備（`!clientSecret`）」と「処理中」のみ。

## 6. エラー処理

| 事象 | 表示 |
|---|---|
| セッション生成失敗（500 等） | 支払方法セクションに再試行ボタン。入力欄は操作可能なまま |
| レート制限 429（リロード連打） | 同上。入力欄は `clientSecret` に依存せず描画するので、入力は止まらない |
| 在庫不足（`out_of_stock`） | ページ到着時に判明する（現状は「お支払いに進む」押下後）。既存メッセージを支払方法セクションに出す |
| 配送先同期失敗 | 確定ボタン押下時に再同期し、失敗時はエラー表示して確定しない |

## 7. コード構造

左列 JSX が「入力フォーム版」と「CheckoutProvider 版」で二重化している。これを単一の
`renderCheckoutSections()` に統合し、支払方法セクションの中身だけ `clientSecret` の有無で出し分ける。
`page.tsx` は約2000行あるため、この統合は重複を減らす方向に働く。

## 8. セキュリティレビュー結果

実装済みで今回も維持される保護:

| 観点 | 実装 |
|---|---|
| OWASP API1（BOLA/IDOR） | `update-shipping` は `checkout_session_id` と Cookie の `session_id` の二重条件で更新。`complete` は draft の `session_id` 一致を検証 |
| 価格改ざん | `create-session` はクライアントの `displayedAmounts` を信用せずカート行から再計算して照合。`complete` は Stripe 実請求額と draft 合計の一致を検証 |
| CSRF | 両エンドポイントで `requireCsrfOrDeny` + トークンローテーション |
| OWASP API4（リソース枯渇） | create-session: IP 20/分・セッション 10/分、update-shipping: IP 60/分・セッション 30/分 |
| 二重注文 | `payment_intent_id` による冪等化 |
| 在庫 | `complete` で発注直前に再検証 |
| データ保護 | `checkout_drafts` は RLS 有効、書き込みは service role のみ。Supabase security advisor に本テーブルの指摘なし |

今回の変更で増える露出と判断:

- 住所未入力でも決済フォームが立つため、カード試行（card testing）の露出がわずかに増える。金額はセッション固定、Stripe Radar と既存レート制限があるため追加対策は取らない。
- 未完了 draft に氏名・電話・住所が残り続ける。保持ポリシー（pg_cron で一定期間超の pending を削除）は**別タスク**とする。

## 9. スコープ外・別途確認

- `checkout_drafts` の保持ジョブ（pg_cron）。Supabase Cron の `cron.schedule` で日次削除する方針を別タスクで検討する。
- 既存の疑義: セッションは `paymentMethod` の初期値 `stripe_card` に基づき `payment_method_types: ['card']` で作られる。PayPay / コンビニを選ばせる設計と整合しない可能性がある。本設計では現行挙動を変えないが、別途確認する。

## 10. テスト

更新が必要な既存 E2E（「お支払いに進む」に依存）: `FR-CHECKOUT-001` / `002` / `004` / `007` / `008` / `018` / `019`。
確定ボタン（`確認へ進む`）への読み替えと、`007` は在庫エラーの表出タイミング変更に合わせる。

新規 E2E（mobile 390 / tablet 768 / desktop 1280）:

1. checkout 到着時点で「お客様情報」「配送先」「支払方法」の3セクションが同時に存在する
2. 未入力のまま確定ボタンを押すと氏名欄へフォーカスが移り、画面内に表示される
3. 配送先を変更しても PaymentElement が再マウントされない（`iframe` の要素同一性を保持）
4. 決済セッションの生成リクエストが1回だけ発生する（二重生成ガード）
5. セッション生成が 429 を返しても入力欄は操作できる

`spec.md` には FREQ-354 として要求・要件・受け入れ基準を追記する。
