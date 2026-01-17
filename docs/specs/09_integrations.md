## タイトル
- `外部連携 (Integrations)`

基づく仕様ファイル: docs/ECSiteSpec.md
推奨タスクID: [DOC-09]

## 概要
- 外部サービス連携（決済、メール、配送、分析、PIM/ERP）とその運用要件、SLA/セキュリティ要件をまとめる。

## 範囲 (In / Out)
- 含むもの: Stripe, Supabase, SendGrid/Mailgun, CDN, 配送業者 API、分析（GA4/BigQuery）、税計算（国内）
- 含まないもの: 各ベンダーとの契約詳細（別ドキュメント）

## 決済（Stripe）
- 使用: Stripe Checkout / Payment Element を採用。カード情報はトークン化。
- Webhook: `STRIPE_WEBHOOK_SECRET` による署名検証必須。idempotency と再試行設計を行う。
- 受け入れ基準: ステージングで決済フローが正常に動作すること、Webhook の署名検証が動作すること。

## GAFA的運用・イベント設計（追加項目）
- イベントスキーマ管理: すべての外部イベントはバージョン付きスキーマ（例: v1, v2）で管理し、後方互換性の方針をドキュメント化する。
- idempotency と再試行: すべての外部イベント受信は idempotency key を利用し、重複処理を防止。再試行ポリシーと DLQ を設置する。
- 機密情報ローテーション: API キー / Webhook シークレットは定期ローテーション（例: 90 日）方針を定め、ローテーション手順を文書化する。
- テスト環境: ステージングは可能な限り実運用と同等の連携を行い、契約テスト（contract tests）で互換性を担保する。


## DB / 認証（Supabase）
- 利用: Postgres + Supabase Auth を想定。RLS を適用して権限管理を行う。
- シークレット管理: サービスキーはサーバ側でのみ利用。

## メール（SendGrid/Mailgun）
- 用途: 注文・通知メール
- テンプレート: HTML テンプレートはブランドガイドに準拠

## 配送業者 API
- 要件: 追跡番号取得、ラベル発行、配送ステータス更新の受信をサポート

## 税計算
- 日本国内向けの税計算を優先。税額はサーバ側で計算。

## 分析・DWH
- GA4 イベントの定義、BigQuery へのイベント集約設計を定義

## マイグレーション / 影響
- 各統合は環境ごとに鍵を分離し、ステージングでの接続確認を必須化
## API / 公開 API ポリシー（追加）
- API バージョニング: 公開 API はバージョニングポリシーを採用する（例: `v1` を URL または Accept ヘッダで明示）。非互換変更は deprecation スケジュールを設け、十分な猶予期間を与える。
- 契約テスト: 主要外部連携は contract tests を用意し、ステージングで自動検証する。

## 実装ノート
- 各 API 連携は冪等性とリトライ戦略を組み込む
- 機密情報は Secrets Manager で管理

## チケット分割例
- TASK-1: Stripe Checkout 統合 + Webhook 実装
- TASK-2: SendGrid テンプレートと送信ロジック実装
- TASK-3: 配送 API の初期統合（ラベル・追跡）

### Webhook / イベント受信の運用フロー（追記）

```mermaid
flowchart LR
	In[受信: Webhook endpoint] --> Verify[署名検証]
	Verify --> Persist[永続化キュー(DB/MQ)]
	Persist --> Worker[ワーカー処理]
	Worker -->|成功| Done[処理済みテーブルに記録]
	Worker -->|失敗| DLQ[DLQ に退避 + アラート]
	DLQ --> Manual[手動調査/再処理]
```

#### 冪等性（idempotency）実装例
- イベントは `provider:event:<event_id>` の識別子で保存し、`processed_events.event_id` にユニーク制約を付与する。
- 受信ハンドラは `INSERT ... ON CONFLICT DO NOTHING` を用いて重複を吸収し、ワーカー側で `status` を更新して処理済み判定を行う。

#### idempotency テーブル（再掲/参考）
```sql
processed_events (
	id uuid PRIMARY KEY,
	provider text,
	event_id text UNIQUE,
	payload jsonb,
	status text,
	attempts int,
	created_at timestamptz,
	processed_at timestamptz
)
```

### OpenAPI スキーマ雛形（公開 API 用）
以下は `GET /api/items` の最小サンプル。公開 API は OpenAPI 仕様で管理し、自動生成/契約テストに利用する。

```yaml
openapi: 3.0.3
info:
	title: EC Public API
	version: v1
paths:
	/api/items:
		get:
			summary: 商品一覧取得
			parameters:
				- in: query
					name: q
					schema:
						type: string
					required: false
			responses:
				'200':
					description: OK
					content:
						application/json:
							schema:
								type: object
								properties:
									items:
										type: array
										items:
											$ref: '#/components/schemas/Item'
components:
	schemas:
		Item:
			type: object
			properties:
				id:
					type: string
					format: uuid
				title:
					type: string
				price:
					type: integer
					description: price in smallest currency unit

```

### Deprecation ポリシー & バージョニング規則
- バージョニング方式: URL パス（推奨） `/api/v1/...` を採用。ヘッダ方式は補助的に使用可。
- 非互換変更: メジャーバージョンを上げてリリース（例: v1 -> v2）。メジャー非互換の際は 90 日以上の移行猶予期間を設け、既存クライアントへ事前通知とデprecation ヘッダを付与する。
- 後方互換（機能追加/非破壊変更）: マイナーバージョンで管理し、既存クライアントの挙動を崩さないこと。
- 廃止手順:
	1. 変更計画と影響範囲をドキュメント化
	2. 既存クライアントへ 90 日前に通知
	3. Deprecation のヘッダ `Deprecation: true; sunset="2026-04-01"` を付与
	4. 期限経過後に削除

