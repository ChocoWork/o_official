## タイトル
- `チェックアウト (Checkout)`

基づく仕様ファイル: docs/ECSiteSpec.md
推奨タスクID: [DOC-04]

## 概要
- ゲストおよび会員向けのチェックアウトフロー。Stripe を決済プロバイダとして利用し、注文作成・決済・注文完了通知を扱う。

## 範囲 (In / Out)
- 含むもの: 注文確認画面、支払処理（Stripe Checkout/Payment Element）、税（国内優先）、配送方法選択（国内）。
- 含まないもの: 複数配送先、国際税の完全対応（将来対応）。

## 機能要件
1. ゲストチェックアウト（必須）: メールと配送先を入力して購入できる。
2. 会員チェックアウト: アドレス帳から選択可能。
3. 支払い: Stripe を利用しカード/ApplePay/GooglePay をサポート。カード情報はトークン化。
4. 注文確定: 注文データを保存し、注文完了メールを送信。

## 非機能要件
- 決済成功率目標: 99%以上。
- Webhook は署名検証を必須化してイベント整合性を保つ。

## API / インターフェース
- POST `/api/checkout/create-session` - カート内容から Stripe セッションを作成
- POST `/api/checkout/complete` - (Webhook/サーバ確認後) 注文を確定
- Stripe Webhook `/api/webhook/stripe` - `STRIPE_WEBHOOK_SECRET` による署名検証

## Webhook / イベント整合性（必須追記）
- 署名検証: 受信時に `STRIPE_WEBHOOK_SECRET` による署名検証を必須化する。検証に失敗したイベントは 400 を返す。
- idempotency: Stripe イベントは `idempotency_key` またはイベントID を保存して冪等処理を行う。重複イベントは既存処理の再実行を避ける。
- 永続化キュー: 受信イベントはまず永続化キュー（DB もしくはメッセージキュー）に格納し、ワーカーで処理。処理失敗時は DLQ に退避して手動確認する。
- イベントバージョンとスキーマ: イベントハンドラはバージョン付きスキーマでパースし、将来の互換性を維持する。


## データモデル（概要）
```sql
orders (
  id uuid PRIMARY KEY,
  user_id uuid NULL,
  items jsonb,
  total_amount integer,
  currency text,
  status text,
  created_at timestamptz DEFAULT now()
)
```

## バリデーションルール
- 金額は最小単位（円）で整数管理。必ずサーバ側で再計算して検証。

## テストケース（受け入れ基準）
- 正常系: Checkout で Stripe セッション作成→支払成功→注文状態が `paid` になる。
- 異常系: Webhook 署名不正は 400 を返す。支払失敗時は注文を `failed` とする。

## マイグレーション影響
- orders テーブル作成が必要。決済メタデータや外部IDの格納を設計する。

## セキュリティ / プライバシー考慮
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` は秘密管理ツールで保管。
- Webhook 受信での idempotency を考慮（重複イベント対策）。

## 実装ノート
- 決済は Stripe Checkout または Payment Element の最新ベストプラクティスに従う。
- 金額はサーバ側で計算し、クライアント送信値は参照として扱う。

## 関連ドキュメント
- docs/ECSiteSpec.md（カート・チェックアウト・決済セクション）

## 担当 / 依存
- 担当: Backend（Checkout API, Webhook）, Frontend（Checkout UI）
- 依存: Stripe, メールプロバイダ

## 受け入れ基準（まとめ）
- Stripe での支払完了後、注文が保存され注文完了メールが送信されること。Webhook は署名検証を通過すること。

## チケット分割例
- TASK-1: `POST /api/checkout/create-session` 実装
- TASK-2: Stripe Webhook エンドポイント実装（署名検証・idempotency）
- TASK-3: 注文確定ロジックとメール送信実装

### Webhook 処理の運用手順（フロー図・冪等性）

```mermaid
flowchart TD
  A[受信: /api/webhook/stripe] --> B{署名検証}
  B -- fail --> C[400 + ログ]
  B -- ok --> D[永続化キュー(DB or MQ)]
  D --> E[ワーカー(バックグラウンド)]
  E -- success --> F[処理済みテーブルにマーク]
  E -- failure --> G[DLQ (dead-letter queue) / アラート]
  G --> H[手動再処理/調査]
```

フロー説明:
- 1) 受信: 署名検証 (`STRIPE_WEBHOOK_SECRET`) を最初に行い、不正なイベントは破棄する。
- 2) 永続化: 検証通過したイベントは冪等キー（例: `stripe:event_<event_id>`) とともに永続化キューへ格納する。
- 3) ワーカー: キューからイベントを取り出し、処理前に `processed_events` テーブルをチェックして重複処理を回避する。
- 4) 失敗処理: 処理に失敗した場合は retry ポリシー（指数バックオフ）で再試行し、一定回数超過で DLQ に移す。

#### 冪等性の実装例（テーブル設計）
```sql
processed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL, -- 'stripe'
  event_id text NOT NULL UNIQUE,
  idempotency_key text, -- 例: 'stripe:event_<event_id>'
  payload jsonb,
  status text CHECK (status IN ('pending','processing','processed','failed')) DEFAULT 'pending',
  attempts integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz NULL
)
```

処理手順（疑似コード）:
1. 受信 -> 署名検証
2. 永続化キューに挿入（INSERT ON CONFLICT DO NOTHING using event_id）
3. ワーカーは SELECT ... FOR UPDATE で行ロックを取り status を `processing` に更新
4. 実処理 -> 正常なら `processed` に更新、失敗なら `attempts++` として再エンキュー or DLQ

キー命名例:
- `provider:event:<event_id>` 例: `stripe:event:evt_1AbCdeF`。

