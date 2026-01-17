---
status: todo
id: ITEMS-01
title: 商品カタログと PDP の実装（商品一覧・商品詳細）
priority: high
estimate: 3d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-01-17
---

# 概要

商品一覧（カテゴリ/コレクション）、検索/フィルタ対応の `GET /api/items` と商品詳細 `GET /api/items/:id`（PDP）を実装する。SKU/バリアント管理と画像ギャラリーを含む。

# 詳細

- エンドポイント: `GET /api/items`, `GET /api/items/:id`, `POST /api/items/:id/notify`
- 画像最適化は `next/image`、SKU 単位で価格・在庫を返す
- 在庫は DB を Source of Truth とし、検索インデックスは非同期更新

# 受け入れ条件

1. 商品一覧 API がフィルタ/ソートを受け取り正常にレスポンスを返す（目標: 95% < 200ms）。
2. PDP で SKU 単位の価格・在庫が正しく表示される。
3. 在庫切れ商品に対して `POST /api/items/:id/notify` で入荷通知登録ができる。

# 実装ノート

- `products` / `skus` テーブル設計を反映する。画像は CDN 経由で配信。
- インデックス更新はイベントキュー + バックグラウンドジョブで非同期実行。

# 依存関係

- CDN / オブジェクトストレージ、検索インデックス基盤

# チェックリスト

- [ ] `GET /api/items` 実装（フィルタ/ソート）
- [ ] `GET /api/items/:id` 実装（PDP）
- [ ] 単体テスト + パフォーマンステスト
