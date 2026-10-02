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
| FR-ADMIN-008 | ORDER 管理タブでは注文一覧・ステータスフィルタ・キーワード検索・ページネーション（20件ずつ）・CSV エクスポートを提供する | IMPL-ADMIN-008 | `src/components/OrderSection.tsx`, `src/app/api/admin/orders/route.ts` | 未決済にキャンセル、決済完了に発送、決済完了・発送済みに返金を表示する。返金後は一覧を再取得し、Stripeの確定状態を表示する | 済 |

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
| `/api/admin/orders` | GET | 注文一覧（ページネーション・ステータスフィルタ。放棄は既定で出さない。`review=only` で要確認だけ）。各行に要確認・発送止めの理由・取消の可否・払込期限を付ける | `admin`, `supporter` |
| `/api/admin/orders/:id/status` | POST | 支払い手続き中・未決済・決済失敗の取消（理由は必須、メモ・お客様へのお知らせ）、決済完了の発送（用途別RPC）。Stripe が払込票の期限切れを確定するまでの取消は409と払込期限、Stripe・DBの一時的な失敗は503 | `admin`, `supporter` |
| `/api/admin/orders/:id/refund` | POST | 決済完了・発送済み注文の返金とStripe現在値からの状態投影 | `admin` |
| `/api/admin/items/:id/variants` | GET | 色 × サイズの一覧（在庫数・受注生産の受注数）と台帳の履歴（FREQ-399） | `admin.items.read` |
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
| `paid` | 発送 | `admin_ship_paid_order`が`paid`かつ未発送・配送先必須項目充足・支払額の違いの要対応が開いていないことを条件に`shipped`へ更新する。満たさないか競合で0件なら409。DBトリガーも直接更新を拒否する |
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

## ORDER タブの要対応・要確認と取消の画面（ADMIN-ORDER-ATTENTION / FREQ-411〜413）

| 部品 | 内容 |
| --- | --- |
| 要対応・要確認の欄（`src/components/AttentionInbox.tsx`） | 注文一覧の上に件数付きで出す。未処理が0件なら出さない。お客様の氏名・住所・メールは出さない。読み込めなかったときは未処理なしに見せず「要対応・要確認を読み込めませんでした。」を出す。操作が断られたら（払込票が有効・Stripe が一時的に使えないなど）理由を欄のすぐ下に出し、行は残る |
| 件数 | 未処理の件数をサイドナビの ORDER（`src/components/AdminSideNav.tsx` の `badges`）と KPI 画面の上部の1行に出す |
| 状態の絞り込み | 「支払い手続き中」「放棄」を足す。放棄は既定の一覧に出さず、「放棄」で絞り込めば出る。「放棄」は他の状態と一緒に選べない（選ぶと他の状態が外れ、他の状態を選ぶと「放棄」が外れる） |
| 要確認の印 | 要確認の注文に「要確認」の印を出し、「要確認のみ」で絞り込める |
| 発送止め | 支払額の違いの要対応が開いている注文は「発送済みにする」を出さず、理由を出す（`admin_ship_paid_order` も断る） |
| 取消の可否 | 取り消せない未決済の注文には「キャンセル」を出さず理由を出す。Stripe が払込票の期限切れを確定するまでは「払込票の期限切れが確定するまで取り消せません（払込期限 …）」、Stripe の状態を確かめられないときは「支払いの状態を確かめられないため、今は取り消せません」（一覧の GET の `canCancel`・`cancelBlockedUntil`。払込票が有効な間は取消 API も409で断る） |
| 取消の画面（`src/components/OrderCancelDialog.tsx`） | Shopify の取消画面に合わせる。項目は下の表 |

- 要対応（`payment_exceptions`）: 注文を作れない支払い・支払額の違い・取り消した注文への入金など。理由の表示名は `PAYMENT_EXCEPTION_REASON_LABELS`（`src/lib/orders/order-payment-types.ts`）。「解決済みにする」（メモは任意）で欄から消す。未入金の注文が付いていれば「注文を取り消して解決」（理由とメモが必須）も選べる。別の管理者が先に解決していたら409で、二重に取り消さない
- 要確認（`orders.review_reason`）: 在庫を確保できなかった注文（`stock_not_reserved`）。「確認済みにする」で欄から消す
- どちらも実行者と日時を残す

| 取消の画面の項目 | 内容 |
| --- | --- |
| 理由 | 必須。在庫切れ・お客様の依頼・不正の疑い・その他（`CANCEL_REASONS`） |
| メモ | 店内だけに残る（500文字まで）。「その他」と要対応の解決では必須 |
| お客様へのお知らせ | 「お客様に取消のお知らせを送る」は既定でオン、外せる。失敗の注文の取消では出さない |
| 在庫 | 常に戻すので選択肢を置かない |

## ITEM タブの非公開と削除（ADMIN-ITEM-GUARD / FREQ-414）

- 商品一覧の削除ボタンは、削除できない商品にも常に出す（無効化・非表示にしない。R-44）
- 注文の明細・在庫の記録・決済中のある商品は、押した時点で削除を送らず、理由と非公開への案内を出す（`buildItemDeleteGuidance`。一覧の GET が `canDelete`・`deleteBlockedReasons` を返す）
- 一覧を読んだ後に削除できなくなった商品は、DELETE API が理由付きの409で断る（外部キーで断られた競合も409）。画面はサーバーの案内を出し、商品は残る
- 商品を非公開にしたら、その商品を含み受付の済んでいない開いている決済（24時間以内）を Stripe で失効させる。失効に失敗しても商品の変更は止めない（受付 RPC が非公開の商品を断る）。削除できたときも同じく失効させる

## 在庫の入力（ADMIN-STOCK / FREQ-399）

在庫の単位は色 × サイズ（`item_variants`）。商品編集画面の「在庫」欄から入れる。

- **在庫は台帳（`stock_movements`）への追記でしか動かさない。** 画面は数量と理由を送るだけで、`item_variants` は直接書き換えない（DB 側もトリガーで追記以外を拒む）
- 管理画面から打てる理由は **入荷（`restock`）と棚卸調整（`adjustment`）だけ**。注文の処理が書く `purchase` / `cancel` / `refund` は API が 400 で断る。打てると「注文に紐づかない販売」が台帳に混ざり、受注数と突合の意味が壊れる
- 読み出しの前に `backfill_item_variants(item_id)` を呼ぶ。商品の色・サイズを足した直後でも入れる先が並ぶ（この関数は冪等）
- 在庫が 0 を下回る追記は `item_variants.stock_quantity >= 0` の CHECK で弾かれる。API は 409 と「在庫が足りない」旨を返し、画面に出す
- 他の商品のバリアントに入れられないよう、`variant_id` は `item_id` と合わせて引く（BOLA 対策）
- 追記は成否どちらも監査ログ（`admin.items.stock.move`）に残し、`created_by` に実行者を入れる

在庫数は「すぐ出せる数」であって「売れる数」ではない。0 でも受注生産として注文は通る（ブランドの前提）。製造の判断に使えるよう、受注生産の受注数（`variant_backorder_summary`）を同じ行に並べる。
| ADMIN-01-010 | Migration 023: roles/permissions/role_permissions/user_roles + `has_permission()` | IMPL-ADMIN-MIG-023 | `migrations/023_add_acl_rbac_tables_and_policies.sql` | ACL/RBAC テーブル + RLS ポリシー作成済み | 済 |
| ADMIN-01-011 | CSV インポートジョブ実装 | IMPL-ADMIN-CSV-01 | `src/app/api/admin/import/route.ts` | 未実装 | 未 |
| ADMIN-01-012 | 監査ログ出力追加（部分未実装） | IMPL-ADMIN-AUDIT-01 | `src/lib/audit.ts` | 一部未実装 | 未 |

### 依存関係

- 監査ログ基盤: `audit_logs` テーブル（済み）
- 認証（管理者向け 2FA）: 未実装
