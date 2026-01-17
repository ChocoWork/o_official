---
status: todo
id: SEARCH-01
title: 検索・フィルタ基盤の実装（フルテキスト検索・サジェスト）
priority: high
estimate: 2d
assignee: unassigned
dependencies: [02_items]
created: 2026-01-17
updated: 2026-01-17
---

# 概要

フルテキスト検索、サジェスト、属性フィルタ、ソート機能を提供する検索 API を実装する。初期は Supabase のフルテキスト検索を採用する。

# 詳細

- エンドポイント: `GET /api/search?q=&filters=&sort=&page=`, `GET /api/suggest?q=`
- 検索インデックスは DB を Source of Truth とし、更新は非同期で行う

# 受け入れ条件

1. 基本的な検索クエリで合理的な結果が返る（簡易スペル補正・部分一致を含む）。
2. サジェスト API がクエリ補完を返す。
3. フィルタとソートが URL パラメータ経由で機能する。

# 実装ノート

- 必要に応じて Meilisearch/Algolia を導入検討する。パフォーマンス評価を行う。

# 依存関係

- `02_items` のインデックス更新フロー

# チェックリスト

- [ ] 基本検索実装
- [ ] サジェスト API 実装
- [ ] パフォーマンステスト
