## タイトル
- `商品 (Items)`

基づく仕様ファイル: docs/ECSiteSpec.md
推奨タスクID: [DOC-02]

## 概要
- 商品カタログと商品詳細（PDP）を管理する機能群。バリエーション（サイズ・カラー・素材）と SKU レベルの在庫・価格管理、画像ギャラリーを含む。

## 範囲 (In / Out)
- 含むもの: 商品一覧、フィルタ/検索、商品詳細ページ、SKU/バリアント管理、入荷通知（メール）。
- 含まないもの: 商品レビュー（現フェーズでは不要）、PIM 導入は将来検討。

## 機能要件
1. 商品一覧/カテゴリ表示: カテゴリ・コレクションでの商品一覧表示（モバイルは無限スクロール、デスクトップはページネーション）。
2. 商品詳細 (PDP): 画像ギャラリー（最大 15 枚）、サイズ表、素材・ケア情報、関連商品表示。
3. バリアント管理: サイズ/カラーごとの SKU、在庫・価格を SKU 単位で管理。
4. 在庫切れ時の入荷通知: ユーザが E メールで入荷通知登録可能。

## 非機能要件
- 画像最適化（Next/Image）、LCP を考慮した最適化。検索は Supabase のフルテキストを推奨。
- レスポンス目標: 商品詳細 API 95% < 200ms。

## データ整合性・ソースオブトゥルース（追加）
- ソースオブトゥルース (Source of Truth): 在庫・価格などの正確性は DB（Postgres）を根拠とする。検索インデックスやキャッシュは派生データと見なす。
- インデックス更新ポリシー: 商品/在庫更新は DB に書き込み後、非同期で検索インデックスを更新する（イベントキュー + バックグラウンドジョブ）。インデックス遅延による一時的不整合を許容するが、注文確定は DB の在庫で検証する。
- リコンシリエーション: 夜次または定期的な整合性チェックジョブを実装し、インデックスと DB の差異を検出・修正する。


## API / インターフェース
- GET `/api/items` (クエリ: category, filters, sort, page/infinite)
- GET `/api/items/:id` (商品詳細、バリアント情報含む)
- POST `/api/items/:id/notify` (在庫通知登録)

## データモデル（概要）
```sql
products (
  id uuid PRIMARY KEY,
  title text,
  description text,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

skus (
  id uuid PRIMARY KEY,
  product_id uuid REFERENCES products(id),
  sku text UNIQUE,
  price integer,
  stock integer
);
```

## バリデーションルール
- title: 必須、最大長 255。
- price: 整数（最小単位で管理）。

## テストケース（受け入れ基準）
- 正常系: 商品一覧取得、PDP 表示、カートに SKU を追加できる。
- 異常系: 存在しない SKU の参照は 404。

## マイグレーション影響
- products / skus テーブルの追加。CSV インポートを考慮したフィールド設計。

## セキュリティ / プライバシー考慮
- 管理 API は認証・RBAC で保護。

## 実装ノート
- 画像は `next/image` で配信、CDN 経由で最適化。
- 検索はまず Supabase のフルテキストで実装、必要に応じて Meilisearch を導入。

## 関連ドキュメント
- docs/ECSiteSpec.md（カタログ・商品ページ、検索・フィルタ）

## 担当 / 依存
- 担当: Backend（商品API・CSVインポート）、Frontend（PDP / List）
- 依存: CDN、オブジェクトストレージ、CSVインポート処理

## 受け入れ基準（まとめ）
- PDP が表示され、SKU 単位で在庫・価格が反映されること。入荷通知登録が機能すること。

## チケット分割例
- TASK-1: `GET /api/items` 実装（フィルタ/ソート対応）
- TASK-2: PDP API 実装
- TASK-3: CSV インポート実装

### 在庫予約フロー（運用・実装選択肢）
在庫予約はスケーラビリティと整合性のトレードオフがあるため、以下の方式を検討する。

1) 悲観的ロック（トランザクション内 SELECT FOR UPDATE）
  - フロー: 注文作成時に DB トランザクションで SKU 行を `SELECT ... FOR UPDATE` し、在庫をデクリメントしてコミット。
  - メリット: 強い整合性。競合が少ない場合は確実。
  - デメリット: 長時間のロックはスループットを阻害。分散環境や高並列でスケールしにくい。

2) 楽観的ロック + 補償（推奨）
  - フロー: 注文確定前に `reservation` レコードを作成して在庫を一時的に確保（reservation TTL を設定）。注文確定時に在庫を正式にデクリメント。reservation が期限切れの場合は自動でリリース。
  - 実装例: `skus` テーブルに `version` カラムを持ち、更新時に `WHERE id = ? AND version = ?` を使う。失敗時は再試行か補償処理を行う。
  - メリット: スケーラブルでパフォーマンスに優れる。ロック競合が低い。
  - デメリット: 一時的不整合が発生しうるため、補償ロジックとリコンシリエーションが必要。

3) ハイブリッド（推奨運用）
  - 高コンテンツ競合 SKU は悲観ロック、通常 SKU は楽観ロックを採用。

### reservation テーブル（楽観方式の実装例）
```sql
reservations (
  id uuid PRIMARY KEY,
  sku_id uuid REFERENCES skus(id),
  user_id uuid NULL,
  quantity integer NOT NULL,
  status text CHECK (status IN ('reserved','confirmed','released')) DEFAULT 'reserved',
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
)
```

処理フロー:
- ユーザが購入プロセスを進めると `reservations` を作成して在庫を一時確保（expires_at を 10-15 分程度に設定）
- 支払い成功で `confirmed` に遷移し、`skus.stock` をデクリメントする
- TTL 到達で未確定の `reserved` はバッチ/ワーカーで `released` にし、在庫を戻す

### 夜次リコンシリエーション運用手順
1. 毎晩実行ジョブ: `skus` の実在庫と `reservations` / `processed_orders` の集計を比較
2. 差異検出: ±閾値を越える差分は自動調整候補としてレポート化
3. 手動確認: 調査が必要なケースはオペレータが確認し、必要ならば修正パッチを適用
4. アラート: 差分が重大（例: 商品群で在庫差異率 > 1%）な場合はオンコールを呼び出す

