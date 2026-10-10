# 1.16 管理画面（ADMIN）詳細設計

> 状態: 既存設計 | 実装状況は項目ごとに要再照合

## 概要

本書は「1.16 管理画面（ADMIN）詳細設計」の既存設計を記録する。要件IDと設計意図を保持しているが、表中の実装状況は現在のコードと一括再照合していない。

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ADMIN-001 | `/admin` ページは Supabase ACL のロールに基づき表示可能なタブを動的に制御する。`editor` は NEWS / ITEM / LOOK / STOCKIST タブのみ、`admin` は全タブを表示する | IMPL-ADMIN-001 | `src/app/admin/page.tsx`, `src/app/api/admin/acl/route.ts` | `visibleTabs` を `useMemo` で計算し `renderContent` でも二重チェックを実施。`acl_roles` テーブルとのロール照合 | 済 |
| FR-ADMIN-002 | KPI ダッシュボードタブでは期間選択（DateTimePicker）・売上・注文数・新規会員数・商品閲覧数の集計グラフを表示し KPI 目標値の設定機能を提供する | IMPL-ADMIN-002 | `src/components/KpiSection.tsx`, `src/app/api/admin/kpi/route.ts`, `src/app/api/admin/kpi/targets/route.ts` | `KpiSection` + `DateTimePicker` で期間・棒グラフ表示。`/api/admin/kpi/targets` で目標値の GET / PUT を実装 | 済 |
| FR-ADMIN-003 | NEWS 管理タブでは記事一覧・作成・編集・削除・公開ステータス変更を提供しカテゴリ・キーワード・ステータスフィルタを設ける | IMPL-ADMIN-003 | `src/components/NewsSection.tsx`, `src/app/api/admin/news/route.ts`, `src/app/api/admin/news/[id]/route.ts` | 一覧・作成・編集モーダル・削除・公開切替を実装。`admin` ロールのみ新規作成ボタンを表示 | 済 |
| FR-ADMIN-004 | ITEM 管理タブでは商品一覧・作成・編集・削除・在庫/公開ステータス管理を提供する | IMPL-ADMIN-004 | `src/components/ItemSection.tsx`, `src/app/api/admin/items/route.ts`, `src/app/api/admin/items/[id]/route.ts` | 一覧・作成・編集モーダル・削除・公開切替を実装。画像アップロード（`item-images` バケット）対応 | 済 |
| FR-ADMIN-005 | LOOK 管理タブではルック一覧・作成・編集・削除・アイテムタグ付けを提供する | IMPL-ADMIN-005 | `src/components/LookSection.tsx`, `src/app/api/admin/looks/route.ts`, `src/app/api/admin/looks/[id]/route.ts` | 一覧・作成・編集モーダル・削除を実装。`look_items` テーブルでアイテムタグ付け対応 | 済 |
| FR-ADMIN-006 | STOCKIST 管理タブでは店舗一覧・作成・編集・削除・公開ステータス管理を提供する | IMPL-ADMIN-006 | `src/components/StockistSection.tsx`, `src/app/api/admin/stockists/route.ts`, `src/app/api/admin/stockists/[id]/route.ts` | 一覧・作成・編集モーダル・削除・公開切替を実装 | 済 |
| FR-ADMIN-007 | USER 管理タブは `admin` ロール専用とし `roles` テーブルの編集・ACL 付与・ユーザー一覧を提供する | IMPL-ADMIN-007 | `src/components/UserSection.tsx`, `src/app/api/admin/users/route.ts`, `src/app/api/admin/users/[id]/role/route.ts` | ユーザー一覧・ロール変更フォームを実装。`admin` ロールのみ表示（`visibleTabs` で制御） | 済 |
| FR-ADMIN-008 | ORDER 管理タブでは注文一覧・ステータスフィルタ・キーワード検索・ページネーション（20件ずつ）・CSV エクスポートを提供する | IMPL-ADMIN-008 | `src/components/OrderSection.tsx`, `src/app/api/admin/orders/route.ts` | 未決済にキャンセル、発送準備中か受注生産中の数がある入金済みの注文に発送と仕上がりの記録、入金済み・配送中の注文に返金を表示する。状態の言葉は商品ごとの数から出す（未決済・受注生産中・発送準備中・配送中。一部発送済みの印）。返金後は一覧を再取得し、Stripeの確定状態を表示する | 済 |

---

## 実装タスク管理 (ADMIN-01)

**タスクID**: ADMIN-01
**ステータス**: 一部未実装
**元ファイル**: `docs/tasks/05_admin_ticket.md`

### 実装完了項目

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| ADMIN-01-001 | ITEM CRUD（作成/編集/削除/公開切替） | IMPL-ADMIN-ITEM-01 | `src/app/admin/items/`, `src/app/api/admin/items/` | 全 CRUD + 公開切替実装済み | 済 |
| ADMIN-01-002 | カラープリセット DB 永続化、再利用 | IMPL-ADMIN-COLOR-01 | `src/app/api/admin/color-presets/route.ts` | DB 永続化 + 再利用実装済み | 済 |
| ADMIN-01-003 | LOOK CRUD | IMPL-ADMIN-LOOK-01 | `src/app/admin/looks/`, `src/app/api/admin/looks/` | 全 CRUD 実装済み | 済 |
| ADMIN-01-004 | NEWS CRUD | IMPL-ADMIN-NEWS-01 | `src/app/admin/news/`, `src/app/api/admin/news/` | 全 CRUD 実装済み | 済 |
| ADMIN-01-005 | STOCKIST CRUD | IMPL-ADMIN-STOCKIST-01 | `src/app/admin/stockists/`, `src/app/api/admin/stockists/` | 全 CRUD 実装済み | 済 |
| ADMIN-01-006 | USER タブ（権限変更含む） | IMPL-ADMIN-USER-01 | `src/app/admin/users/`, `src/app/api/admin/users/` | ユーザー管理 + 権限変更実装済み | 済 |
| ADMIN-01-007 | ORDER タブ（ページング/期間フィルタ/CSV/ステータス変更/返金） | IMPL-ADMIN-ORDER-01 | `src/app/admin/orders/`, `src/app/api/admin/orders/` | ページング/フィルタ/CSV/ステータス/返金 実装済み | 済 |
| ADMIN-01-008 | KPI タブ（実データ集計/目標値編集） | IMPL-ADMIN-KPI-01 | `src/app/admin/kpi/`, `src/app/api/admin/kpi/` | 実データ集計 + 目標値編集実装済み | 済 |
| ADMIN-01-009 | `admin-rbac.ts` ハイブリッド RBAC | IMPL-ADMIN-RBAC-01 | `src/lib/admin-rbac.ts` | ハイブリッド RBAC 実装済み | 済 |

---

## RBAC 権限設計（ADMIN-RBAC）

| 機能 | `admin` | `supporter` |
|---|---|---|
| 商品 CRUD | ✅ | 編集のみ |
| ニュース CRUD | ✅ | ✅ |
| 注文ステータス変更 | ✅ | ✅ |
| 返金処理 | ✅ | ❌ |
| クーポン作成 | ✅ | ❌ |
| ユーザー権限変更 | ✅ | ❌ |
| KPI ダッシュボード閲覧 | ✅ | ✅ |
| 監査ログ閲覧 | ✅ | ❌ |

> Supabase RLS で `acl_roles` テーブルのロール列を条件とするポリシーを設定し、テーブルレベルのアクセス制御を実施する。

---

## 管理者オンボーディング手順（ADMIN-ONBOARDING）

1. **申請**: 管理者アカウント発行はチケット経由で申請する。
2. **身元確認**: 申請者の所属・メールを確認し、担当者が 2FA 設定まで案内する。
3. **最小権限付与**: 初期は `supporter` 相当の限定権限を付与し、業務確認後に `admin` 権限を付与する。
4. **初回ログイン**: 初回ログイン時にパスワード変更と 2FA の有効化を必須化する。
5. **ドキュメント配布**: 管理操作の利用規約・ランブック・オンボーディングチェックリストを配布する。

### 2FA 有効化手順

1. 管理画面で "Enable 2FA" を選択
2. サーバが TOTP シークレットを発行し、QR コードを表示
3. 管理者は Authenticator アプリで QR をスキャンし、初回コードを入力して検証
4. 端末名を登録し、リカバリコード（ワンタイム）を発行・保存することを義務付ける
5. `admin` ロールの全ユーザは 2FA を必須とし、未設定時はアクセスをブロックする

---

## 監査ログ設計（ADMIN-AUDIT）

### ログスキーマ

```json
{
  "id": "uuid",
  "timestamp": "2025-01-01T12:00:00Z",
  "actor_id": "uuid",
  "actor_email": "admin@example.com",
  "action": "items.update",
  "resource": "items",
  "resource_id": "uuid",
  "ip": "203.0.113.1",
  "user_agent": "Mozilla/5.0...",
  "outcome": "success|failure",
  "metadata": { "diff": { "price": { "from": 1000, "to": 1200 } } }
}
```

### 保存期間

| 区分 | 期間 | 用途 |
|---|---|---|
| ホット（即時検索） | 1 年 | 障害調査・コンプライアンス監査 |
| コールド（アーカイブ） | 7 年 | 法規制・会計要件 |

- 監査ログは変更不可なストレージに保存し、整合性検証（ハッシュ）を定期実行する。
- 重要操作（権限変更・払い戻し・高額割引）は即時アラート対象とし、オンコール担当に通知する。

---

## API 仕様（ADMIN-API）

| エンドポイント | メソッド | 概要 | ロール要件 |
|---|---|---|---|
| `/api/admin/items/import` | POST | CSV バルクインポート（必須カラム/型チェック/重複 SKU 検出） | `admin` |
| `/api/admin/orders` | GET | 注文一覧（ページネーション・ステータスフィルタ。放棄は既定で出さない。`review=only` で要確認だけ）。各行に要確認・発送止めの理由・取消の可否・払込期限を付け、商品ごとの数から出した注文の言葉と一部発送済みの印、商品の行ごとの数を付ける（FREQ-441） | `admin`, `supporter` |
| `/api/admin/orders/:id/status` | POST | 支払い手続き中・未決済・決済失敗の取消（理由は必須、メモ・お客様へのお知らせ）。Stripe が払込票の期限切れを確定するまでの取消は409と払込期限、Stripe・DBの一時的な失敗は503 | `admin`, `supporter` |
| `/api/admin/orders/:id/refund` | POST | 決済完了・発送済み注文の返金とStripe現在値からの状態投影 | `admin` |
| `/api/admin/orders/:id/fulfillments` | GET | 発送の画面と仕上がりの画面の材料（商品ごとの数・発送の一覧・発送できない理由）（FREQ-439・440） | `admin.orders.manage` |
| `/api/admin/orders/:id/fulfillments` | POST | 発送を1回分記録する（重複防止キー・配送業者・追跡番号・知らせるか・商品と数）。発送準備中の数を超えると409（FREQ-439） | `admin.orders.manage` |
| `/api/admin/orders/:id/fulfillments/:fulfillmentId/cancel` | POST | 発送の取消。送る前のその発送のメールを取りやめる（FREQ-443） | `admin.orders.manage` |
| `/api/admin/orders/:id/completions` | POST | 受注生産の品の仕上がりを記録する（FREQ-440） | `admin.orders.manage` |
| `/api/admin/orders/:id/completions/:completionId/cancel` | POST | 仕上がりの取消。もう発送した数を下回る取消は409（FREQ-440） | `admin.orders.manage` |
| `/api/admin/items/:id/variants` | GET | 色 × サイズの一覧（すぐ出せる数・引き当て済み・手元の数・受注生産）と、動かした人・注文・変わった後の数つきの台帳の履歴（FREQ-399・445） | `admin.items.read` |
| `/api/admin/items/:id/variants` | POST | 在庫台帳への追記（入荷 / 棚卸調整） | `admin.items.manage` |
| `/api/admin/order-attention` | GET | 未処理の要対応・要確認の一覧と件数（お客様の個人情報は返さない） | `admin.orders.read` |
| `/api/admin/orders/:id/review` | POST | 要確認を確認済みにする | `admin.orders.manage` |
| `/api/admin/payment-exceptions/:id/resolve` | POST | 要対応を解決済みにする。未入金の注文が付いていれば取り消して解決もできる。先に解決されていれば409 | `admin.orders.manage` |
| `/api/admin/items/:id` | DELETE | 商品の削除。注文の明細・在庫の記録・決済中のある商品は理由付きの409で断り、非公開を促す | `admin.items.manage` |

> CSV インポート時は必須カラムチェック・型チェック・重複 SKU 検出を行い、エラー行は一覧で返す。

## 注文のキャンセル・返金（ADMIN-ORDER / FREQ-404）

注文状態は画面の推測で変更せず、Stripeの成功済み返金とDBの条件付き更新を正本にする。

| 現在状態 | 操作 | 遷移・応答 |
|---|---|---|
| `payment_in_progress` | キャンセル（理由は必須） | 開いている Checkout Session を失効させてから、照合関数が Stripe の現在値で取り消し、確保した分だけ在庫を戻す（`release_stock_for_unpaid_order`）。先に支払いが完了していれば409 |
| `pending` | キャンセル（理由は必須） | Stripe が払込票の期限切れを確定するまで取り消さず、409と払込期限（`cancelBlockedUntil`）を返す（払込期限を過ぎても、確定するまでは409）。確定の後は照合関数が取り消し、確保した分だけ在庫を戻す（`release_stock_for_unpaid_order`）。Stripe を一時的に読めなければ503 |
| `failed` | キャンセル（理由は必須。お知らせは出さない） | `admin_cancel_failed_order`が`failed`を条件に理由・メモ付きで更新する。競合で0件なら409 |
| `abandoned` | キャンセル | 409（放棄された注文は取り消さない） |
| `paid` | 発送（商品と数を選ぶ） | `admin_create_fulfillment`が、`paid`・配送先必須項目充足・支払額の違いの要対応が開いていない・各商品が発送準備中の数以内を条件に、発送を1回分記録する。満たさない時は決まった言葉で止め、窓口が404/409/400と画面の言葉に直す（FREQ-439）。この発送で未発送が0になる時だけ`shipped`へ更新する。DBトリガーも直接更新を拒否する。「お客様に発送のメールを送る」（最初は入っている）を外すと、その発送のメールの行を書かない（FREQ-438・442）。 |
| `paid` | 仕上がりの記録 | `admin_record_completion`が、`paid`の注文の受注生産の品の、受注生産中の数まで記録する。状態は変えず、お客様にメールは送らない（FREQ-440） |
| `paid` / `shipped` | 発送の取消・仕上がりの取消 | `admin_cancel_fulfillment`が取消の時刻と人を書き、`shipped`なら`paid`へ戻して出荷日時・配送情報を空にし、送る前のその発送のメールを取りやめる。`admin_cancel_completion`は、もう発送した数を下回る取消を断る（仕上がりの取消は`paid`の注文だけ。`shipped`の注文は`ORDER_NOT_IN_PRODUCTION`で断る。FREQ-440・443） |
| `paid` / `shipped` | 通常キャンセル | 409。返金APIを案内する |
| `paid` / `shipped` | 部分返金、`pending`、`requires_action` | 状態を維持し、成功済み返金額だけを記録する |
| `paid` / `shipped` | 成功済み返金累計が注文総額以上 | `apply_order_refund_projection`が`cancelled`へ更新する |
| 全額返金由来の`cancelled` | `refund.failed`で成功額が総額未満 | `shipped_at`があれば`shipped`、なければ`paid`へ戻す |
| 未決済由来の`cancelled` | 返金同期 | `cancelled`を維持する |

`syncOrderRefunds`はStripe SDKのAsyncIterableで返金一覧を全ページ取得し、`succeeded`だけを合計する。更新は`status`、`refunded_amount`、`payment_status_updated_at`を比較条件にしたCAS RPCで行う。RPC成功後にもStripe返金一覧を全ページ再取得し、書き込んだ金額と導出状態が現在値に一致する場合だけ完了する。CAS競合または再検証不一致ならStripe取得から最大3回やり直し、収束しなければ例外を返し、workerがイベントをfailedとして永続キューから再試行する。未決済由来の既存`cancelled`は投影対象外のno-opとする。`refund.created`、`refund.updated`、`refund.failed`、`charge.refunded`は同じ再計算経路を通る。

管理画面は返金APIの`refundStatus`と`orderStatus`を検証してから一覧を再取得する。`pending`と`requires_action`は`role="status"`、`aria-live="polite"`で完了待ちを通知し、`failed`と`canceled`はエラーにする。400・409の検証済みメッセージだけを利用者へ表示し、内部障害は汎用文言にする。

DB変更は次の2段階で適用する。第1段階は本番適用済み、第2段階は対応アプリの本番動作確認後に適用する。

1. [20260925000218_add_order_state_transition_rpcs.sql](../../../supabase/migrations/20260925000218_add_order_state_transition_rpcs.sql): 3つのservice-role専用RPCと監査主体のGUC連携を追加する。既存権限は維持する。
2. [harden_order_state_transitions.sql](../../../supabase/pending/harden_order_state_transitions.sql): アプリ切替確認後に`anon` / `authenticated`の`orders` UPDATE、広範なUPDATE policyを削除し、不変条件トリガーを追加する。

3つのRPCは`SECURITY DEFINER`、`search_path=''`、完全修飾名を使い、`PUBLIC` / `anon` / `authenticated`から実行権限を剥奪する。人間の操作はサーバーが認証済みセッションから得た利用者IDを渡し、`order_revisions.changed_by`へ記録する。クライアント本文の利用者IDは受け付けない。

## ORDER タブの要対応・要確認と取消の画面（ADMIN-ORDER-ATTENTION / FREQ-411〜413・415・435）

| 部品 | 内容 |
| --- | --- |
| 送信の一時停止の帯（FREQ-435、E2E FR-ADMIN-067） | ORDER タブの上、要対応・要確認の欄より前に、`GET /api/admin/order-attention` の `data.emailSending.paused` が true の時だけ「お客様への注文のメールの送信を止めています」を出す（`BannerAlert`、`role="alert"`）。原因は `reasonLabel`（null なら「不明」）。「原因: {原因名}。原因を直すと、15分ごとに1件ずつ試して自動で再開します（1日の送信の上限の時は日本時間 9時から）。手順は「注文のメールの手順書」の「送信の一時停止」にあります。」と案内する。停止の知らせのメールも同じ鍵・送信元・上限を使うため届かず、この帯が店主の気づく道になる。止めていない時、項目が null・無い時は出さない。mobile（390px）・tablet（768px）・desktop（1280px）で確かめる |
| 要対応・要確認の欄（`src/components/AttentionInbox.tsx`） | 注文一覧の上に件数付きで出す。未処理が0件なら出さない。お客様の氏名・住所・メールは出さない。読み込めなかったときは未処理なしに見せず「要対応・要確認を読み込めませんでした。」を出す。操作が断られたら（払込票が有効・Stripe が一時的に使えないなど）理由を欄のすぐ下に出し、行は残る |
| 件数 | 未処理の件数をサイドナビの ORDER（`src/components/AdminSideNav.tsx` の `badges`）と KPI 画面の上部の1行に出す |
| 状態の絞り込み | 「すべて・支払い手続き中・未決済・発送待ち（受注生産中・発送準備中）・発送済み（配送中・配達済み）・決済失敗・放棄・キャンセル」。DB の状態で絞り（発送待ちは paid、発送済みは shipped）、2つ以上選んだ時は画面が DB の状態（`orderStatus`）で絞る（FREQ-441）。放棄は既定の一覧に出さず、「放棄」で絞り込めば出る。「放棄」は他の状態と一緒に選べない（選ぶと他の状態が外れ、他の状態を選ぶと「放棄」が外れる） |
| 要確認の印 | 要確認の注文に「要確認」の印を出し、「要確認のみ」で絞り込める |
| 発送止め | 支払額の違いの要対応が開いている注文は「発送済みにする」を出さず、理由を出す（`admin_create_fulfillment` も断る） |
| 取消の可否 | 取り消せない未決済の注文には「キャンセル」を出さず理由を出す。Stripe が払込票の期限切れを確定するまでは「払込票の期限切れが確定するまで取り消せません（払込期限 …）」、Stripe の状態を確かめられないときは「支払いの状態を確かめられないため、今は取り消せません」（一覧の GET の `canCancel`・`cancelBlockedUntil`。払込票が有効な間は取消 API も409で断る） |
| 取消の画面（`src/components/OrderCancelDialog.tsx`） | Shopify の取消画面に合わせる。項目は下の表 |

- 要対応（`payment_exceptions`）: 注文を作れない支払い・支払額の違い・取り消した注文への入金など。理由の表示名は `PAYMENT_EXCEPTION_REASON_LABELS`（`src/lib/orders/order-payment-types.ts`）。「解決済みにする」（メモは任意）で欄から消す。未入金の注文が付いていれば「注文を取り消して解決」（理由とメモが必須）も選べる。別の管理者が先に解決していたら409で、二重に取り消さない
- 要確認（`orders.review_reason`）: 在庫を確保できなかった注文（`stock_not_reserved`）と、毎時の見回りが注文の無い支払いから作った注文（`recovered_from_payment`。表示は「支払いから作った注文：お客様へ確認してください」。FREQ-415）。両方に当たる注文は在庫の理由を残す。「確認済みにする」で欄から消す
- どちらも実行者と日時を残す

| 取消の画面の項目 | 内容 |
| --- | --- |
| 理由 | 必須。在庫切れ・お客様の依頼・不正の疑い・その他（`CANCEL_REASONS`） |
| メモ | 店内だけに残る（500文字まで）。「その他」と要対応の解決では必須 |
| お客様へのお知らせ | 「お客様に取消のお知らせを送る」は既定でオン、外せる。失敗の注文の取消では出さない |
| 在庫 | 常に戻すので選択肢を置かない |

### 注文の履歴（FREQ-436・437）

各注文の「履歴」（読み上げの名前は「{注文番号} の履歴」）で「この注文の履歴」のダイアログを開く。

| 表示 | 中身 |
|---|---|
| 上 | 注文番号と状態、宛先（注文のメールアドレス）、送信を止めていれば「メールの送信を一時停止しています（原因）」 |
| 並び | 受付・状態の変化（配送業者と伝票番号、取消の理由、操作した管理者）・発送・発送の取消・仕上がり・仕上がりの取消・メール（種類・状態・時刻・原因・手で再送の印）を新しい順 |
| メールの状態 | 送信待ち・やり直し待ち・送信済み・配達済み・配達の遅れ・届かなかった・迷惑メールにされた・送信先が止められている・送信サービスで送れなかった・取りやめ・送れなかった。問題のある状態には「注意」 |
| 中身を見る | 送信済みのメールの件名と本文。送ってから45日を過ぎ、毎日の片付けで本文を消した後は「本文の保存期間（45日）を過ぎました」 |
| お客様へ再送 | 送信済み・送れなかったメールで、今の注文の状態で意味のある種類だけ。「{種類}のメールを、お客様（注文のメールアドレス）へもう一度送ります」で確かめ、「再送する」「やめる」。発送のメールは「発送（n回目）のメール」と出し、その発送のメールを再送する（取り消した発送は再送できない） |
| 発送の行 | 「発送（n回目）」。取り消した発送には印「取り消し済み」。「配送業者: {名前} / 伝票番号: {番号}」、「商品: {名前} × {数}」（商品が複数なら「 / 」で区切る）、「お客様へのメール: 送る」か「お客様へのメール: 送らない」、全部を送った発送には「この発送で全部を送りました」、操作した人。取り消せる時は「この発送を取り消す」（FREQ-443） |
| 発送の取消の行 | 「発送（n回目）を取り消しました」、操作した人 |
| 仕上がりの行 | 「受注生産の品が仕上がりました」。取り消した仕上がりには印「取り消し済み」。「商品: {名前} × {数}」、操作した人。取り消せる時は「この仕上がりを取り消す」 |
| 仕上がりの取消の行 | 「仕上がりを取り消しました」、操作した人 |

中身・再送の確かめ・発送と仕上がりの取消の確かめは同じダイアログの中で切り替える。「戻る」「やめる」の後は、開いたメールの行の「中身を見る」「お客様へ再送」のボタンへ焦点を戻す。ボタンが無ければパネルへ移す。再送の受付の知らせは焦点を移した後の描画で `role="status"` に入れる。Escape で閉じ、閉じたら「履歴」のボタンへ戻る。前の要求や別のメールの遅れた応答で今の画面を上書きしない。

注文の状態の表示名は [order-history.ts](../../../src/lib/orders/email/order-history.ts) の `ORDER_STATUS_LABELS` を、履歴の窓口が使う。グループ E-1 から、一覧の言葉は商品ごとの数から出した進み具合の言葉（下の「発送と仕上がりの画面と、注文の言葉」）に替わったので、一覧とは共有しない。履歴の見出し（「{注文番号}（決済完了）」など）と状態の変化の行は、DB の状態の言葉（決済完了・発送済みなど）のまま出す。

返金で状態が変わった行も履歴に含める。全額返金でキャンセルになった行は「理由: 全額返金」、返金が取り消されて戻った行は「返金の取り消し」を出す。

### 発送と仕上がりの画面と、注文の言葉（FREQ-439〜443）

2026-10-10 から、発送は商品と数を選ぶ1回ごとの記録になり、受注生産の品は仕上がりを記録するまで送れない（[グループ E-1 設計書](../../superpowers/specs/2026-10-10-partial-fulfillment-design.md)）。DB の状態の値（`paid`・`shipped` など）は変えず、一覧の言葉は商品ごとの数から出す（[注文・決済の状態](../states/order-payment.md)、[order-progress.ts](../../../src/lib/orders/order-progress.ts)）。

| 部品 | 内容 |
| --- | --- |
| 一覧の言葉 | 未決済・受注生産中・発送準備中・配送中（配達済みは E-4）・決済失敗・キャンセル・支払い手続き中・放棄。いちばん手前の段階の言葉を出し、発送した数が1以上で未発送の数も1以上なら「一部発送済み」の印を足す（FREQ-441） |
| 商品の欄 | 「ブラウス（白 / M）×2（受注生産中 1・発送済み 1）」のように、0でない数だけを括弧の中に出す。行の key は注文の商品の番号 |
| ボタン | 「仕上がりを記録する」: 決済完了で受注生産中の数がある時。「発送済みにする」: 決済完了で発送準備中か受注生産中の数があり、配送先がそろい、支払額の確かめが残っていない時。「配送先要確認」の印は、決済完了の注文で配送先の必須項目が実際に足りない時だけ出す（発送できない理由はほかに、支払額の確かめが残っている時があり、その時は理由の文を出す） |
| 発送の画面（`OrderShipDialog`） | 題「発送済みにする」。開く時に「読み込み中です...」を出して材料（`GET …/fulfillments`）を読み、重複防止キーを作る。商品の一覧（読み上げの名前は「発送する商品」）には、未発送の数が1以上の商品ごとに、印（在庫・受注生産）・発送準備中の数・今回送る数（最初は発送準備中の全部）を並べ、合計「今回送る数の合計: n点」を出す。合計0は「送る数を入れてください。」。受注生産中の品は「受注生産中 n」と「仕上がった数」の入力と「仕上がりを記録」を持つ。仕上がりの記録は商品ごとに行い（その商品の「仕上がりを記録」を押すか、入力欄で Enter を押す。Enter は発送の送信にならない）、その商品の「仕上がった数」が0なら「仕上がった数を入れてください。」を出す。記録できたら材料を読み直し、記録した数をその商品の今回送る数に足す（発送準備中の数まで）。この時、材料の読み直しの前に仕上がった数の入力を空にして「仕上がりを記録しました。」を出し（読み直しが失敗しても、押し直しが新しい記録にならないようにする）、仕上がり用の重複防止キーは読み直せた後に作り直す（読み直せなかった時は前のキーのまま。同じ数を押し直しても窓口が前の結果を返すので、記録は増えない）。配送業者・追跡番号・「お客様に発送のメールを送る」は今のまま。誤りは画面の中（`role="alert"`）。答えが分からない時は入力を止め、「もう一度確かめる」と「閉じる」だけを出す |
| 仕上がりの画面（`OrderCompletionDialog`） | 題「仕上がりを記録する」。商品の一覧（読み上げの名前は「仕上がりを記録する商品」）には、受注生産中の商品ごとに「仕上がった数」（0〜受注生産中の数）を入れ、「記録する」。受注生産中の商品が無ければ「受注生産中の商品はありません。」を出す。仕上がった数の合計が0なら「仕上がった数を入れてください。」を出す。成功したら「仕上がりを記録しました。」を出し、一覧を読み直す。お客様にメールは送らない |
| 取消 | 注文の履歴の発送・仕上がりの行から。確かめの画面（題「この発送を取り消す」「この仕上がりを取り消す」）に、文（「発送（n回目）を取り消し、その商品を発送準備中に戻します。お客様にメールは送りません。…」「この仕上がりを取り消し、その商品を受注生産中に戻します。」）と「取り消す」「やめる」を出す。取り消せない時は理由を確かめの画面の中に出す。取り消せたら履歴へ戻って「発送（n回目）を取り消しました。」「仕上がりを取り消しました。」を出し、履歴と一覧を読み直す。答えが分からない時（通信が切れた・500番台など）も履歴と一覧を読み直し、「結果を確かめられませんでした。履歴を読み直しました。取り消されたかどうかは、この履歴で確かめてください。」を出す（FREQ-443） |
| 窓口を呼ぶ道具 | 発送・仕上がり・2つの取消の呼び出しは [fulfillment-client.ts](../../../src/lib/orders/fulfillment/fulfillment-client.ts) の1か所にまとめ、答えを3つに分ける。記録できた。断られた（400・404・409 は窓口の日本語の文を出し、401 は「認証が必要です。再ログインしてください。」、403 は「この操作の権限がありません。」、回数の制限などは代わりの文を出す）。分からない（通信が切れた・500番台・成功なのに答えを読めない。記録されたかもしれないので、画面は同じ重複防止キーで確かめ直す） |
| 小さい画面 | 発送の画面と仕上がりの画面は、幅 768px 未満で画面いっぱいに開く（[Dialog](../../../src/components/ui/Dialog/Dialog.tsx) の任意の prop `fullScreenOnMobile`。ほかの画面の `Dialog` は今のまま） |
| 一覧の読み直し | 絞り込みやページを続けて変えて読みが重なった時は、最後に始めた読みの答えだけを使う（遅れて返った古い条件の答えで、新しい条件の一覧を上書きしない）。発送・仕上がり・取消のあとの読み直しも、この決まりを通る |

窓口の答えの誤りの言葉は [fulfillment-messages.ts](../../../src/lib/orders/fulfillment/fulfillment-messages.ts) の1か所で持つ。

#### 受け付け基準と E2E（グループ E-1。FREQ-439〜443・445）

| 受け付け基準 | 確かめること | E2E |
| --- | --- | --- |
| FREQ-439-AC-01 | 発送の画面に商品ごとの印と今回送る数が並び、最初は発送準備中の全部 | [FR-ADMIN-068](../../../e2e/FR-ADMIN-068-partial-fulfillment.spec.ts) |
| FREQ-439-AC-02 | 数を減らして発送すると、一覧に「一部発送済み」と残りを送るボタンが出る | FR-ADMIN-068 |
| FREQ-439-AC-03 | 残りを全部発送すると「配送中」になり、発送のボタンが消える | FR-ADMIN-068、[FR-ADMIN-050](../../../e2e/FR-ADMIN-050-order-shipping.spec.ts) |
| FREQ-439-AC-04 | 合計0は送らずに理由を出し、数の超過の断りの言葉が画面の中に出る | FR-ADMIN-068 |
| FREQ-439-AC-05 | 答えが分からない時は入力を止め、同じ重複防止キーで確かめ直す | FR-ADMIN-068 |
| FREQ-439-AC-06 | 発送の関数が数の超過・注文に無い商品・中身の違う同じキーを断り、同時の発送は片方だけが通る | FR-ADMIN-068（手元の DB） |
| FREQ-440-AC-01 | 受注生産の品を含む注文は「受注生産中」。発送の最初の数に入らない | [FR-ADMIN-069](../../../e2e/FR-ADMIN-069-made-to-order-completion.spec.ts) |
| FREQ-440-AC-02 | 仕上がりの画面で記録すると「発送準備中」になる | FR-ADMIN-069 |
| FREQ-440-AC-03 | 発送の画面の中でも仕上がりを記録できる | FR-ADMIN-069 |
| FREQ-440-AC-04 | 履歴から仕上がりを取り消せる。送った数を下回る取消は断られる | FR-ADMIN-069 |
| FREQ-440-AC-05 | 受注生産中の品は送れず、記録は決済完了の注文の受注生産の品だけ | FR-ADMIN-069（手元の DB） |
| FREQ-441-AC-01 | 一覧に注文の言葉と「一部発送済み」の印が出る | [FR-ADMIN-070](../../../e2e/FR-ADMIN-070-order-progress-labels.spec.ts) |
| FREQ-441-AC-02 | 絞り込みの名前と、DB の状態での絞り込み | FR-ADMIN-070 |
| FREQ-442-AC-01 | 発送ごとに発送のメールが1通届く | [FR-ADMIN-071](../../../e2e/FR-ADMIN-071-fulfillment-shipping-email.spec.ts) |
| FREQ-442-AC-02 | メールに、その発送の商品と数・配送業者・追跡番号が書かれ、値段は書かれない | FR-ADMIN-071 |
| FREQ-442-AC-03 | 未発送の品が残る発送のメールにだけ、残りの案内が入る | FR-ADMIN-071 |
| FREQ-442-AC-04 | 知らせない発送にはメールが届かない | FR-ADMIN-071、[FR-ADMIN-066](../../../e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts) |
| FREQ-443-AC-01 | 履歴から発送を取り消すと取消の行が残り、一覧が読み直される | [FR-ADMIN-072](../../../e2e/FR-ADMIN-072-fulfillment-cancel.spec.ts) |
| FREQ-443-AC-02 | 「やめる」では取り消さず、断られた理由が確かめの画面に出る | FR-ADMIN-072 |
| FREQ-443-AC-03 | 取消で発送準備中に戻り、決済完了に戻り、2回目は変更なし | FR-ADMIN-072（手元の DB） |
| FREQ-443-AC-04 | 送る前のメールは取りやめになり、取消のメールは行かない | FR-ADMIN-072（手元の DB と Mailpit） |
| FREQ-445-AC-01 | 在庫の欄に4つの数と言葉の説明が出る | [FR-ADMIN-073](../../../e2e/FR-ADMIN-073-inventory-states.spec.ts) |
| FREQ-445-AC-02 | 履歴に動かした人（空なら「自動」）・注文・変わった後の数が出る | FR-ADMIN-073 |
| FREQ-445-AC-03 | 引き当て済み・受注生産の数え方と、履歴の関数の答え | FR-ADMIN-073（手元の DB） |

## ITEM タブの非公開と削除（ADMIN-ITEM-GUARD / FREQ-414）

- 商品一覧の削除ボタンは、削除できない商品にも常に出す（無効化・非表示にしない。R-44）
- 注文の明細・在庫の記録・決済中のある商品は、押した時点で削除を送らず、理由と非公開への案内を出す（`buildItemDeleteGuidance`。一覧の GET が `canDelete`・`deleteBlockedReasons` を返す）
- 一覧を読んだ後に削除できなくなった商品は、DELETE API が理由付きの409で断る（外部キーで断られた競合も409）。画面はサーバーの案内を出し、商品は残る
- 商品を非公開にしたら、その商品を含み受付の済んでいない開いている決済（24時間以内）を Stripe で失効させる。失効に失敗しても商品の変更は止めない（受付 RPC が非公開の商品を断る）。削除できたときも同じく失効させる

## 在庫の入力（ADMIN-STOCK / FREQ-399・445）

在庫の単位は色 × サイズ（`item_variants`）。商品編集画面の「在庫」欄から入れる。

- **在庫は台帳（`stock_movements`）への追記でしか動かさない。** 画面は数量と理由を送るだけで、`item_variants` は直接書き換えない（DB 側もトリガーで追記以外を拒む）
- 管理画面から打てる理由は **入荷（`restock`）と棚卸調整（`adjustment`）だけ**。注文の処理が書く `purchase` / `cancel` / `refund` は API が 400 で断る。打てると「注文に紐づかない販売」が台帳に混ざり、受注数と突合の意味が壊れる
- 読み出しの前に `backfill_item_variants(item_id)` を呼ぶ。商品の色・サイズを足した直後でも入れる先が並ぶ（この関数は冪等）
- 在庫が 0 を下回る追記は `item_variants.stock_quantity >= 0` の CHECK で弾かれる。API は 409 と「在庫が足りない」旨を返し、画面に出す
- 他の商品のバリアントに入れられないよう、`variant_id` は `item_id` と合わせて引く（BOLA 対策）
- 追記は成否どちらも監査ログ（`admin.items.stock.move`）に残し、`created_by` に実行者を入れる

在庫数は「すぐ出せる数」であって「売れる数」ではない。0 でも受注生産として注文は通る（ブランドの前提）。

在庫の欄には、色 × サイズごとに4つの数を並べる（FREQ-445）。

| 数 | 求め方 |
| --- | --- |
| すぐ出せる数 | `item_variants.stock_quantity`（今のまま。今すぐ売れる数） |
| 引き当て済み | その色・サイズの注文の商品ごとに、max(0, 確保中の数 − 発送した数) を足した数（注文のために取ってある数。支払い手続き中の注文も、棚の品を確保しているので入る） |
| 手元の数 | すぐ出せる数 ＋ 引き当て済み（棚に実際にある数） |
| 受注生産 | 未入金（`pending`）と入金済み（`paid`）の注文の、受注生産の商品のまだ仕上がっていない数の合計（これから作る数。取り消した注文と、仕上がった数は入れない） |

数の説明は画面に1回だけ書く。数は `public.list_variant_stock_states` が返す（旧ビュー `variant_backorder_summary` は消した）。この関数は、発送した数と受注生産中の数を数える `private.order_line_fulfillment` と、確保中の数を数える `private.order_line_reservations` の上に組んであり、数え方は1か所にある。履歴は `public.list_item_stock_history` が新しい順に、日時・理由・増減・変わった後の数・備考・動かした人（空なら「自動」）・注文番号を返す。変わった後の数は、今の在庫数から、その行より後の動きの合計を引いて出す。発送は在庫の台帳を動かさない（注文の時に確保済み）ので、履歴に発送は出ない。
| ADMIN-01-010 | Migration 023: roles/permissions/role_permissions/user_roles + `has_permission()` | IMPL-ADMIN-MIG-023 | `migrations/023_add_acl_rbac_tables_and_policies.sql` | ACL/RBAC テーブル + RLS ポリシー作成済み | 済 |
| ADMIN-01-011 | CSV インポートジョブ実装 | IMPL-ADMIN-CSV-01 | `src/app/api/admin/import/route.ts` | 未実装 | 未 |
| ADMIN-01-012 | 監査ログ出力追加（部分未実装） | IMPL-ADMIN-AUDIT-01 | `src/lib/audit.ts` | 一部未実装 | 未 |

### 依存関係

- 監査ログ基盤: `audit_logs` テーブル（済み）
- 認証（管理者向け 2FA）: 未実装
