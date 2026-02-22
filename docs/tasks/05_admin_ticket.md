---
status: todo
id: ADMIN-01
title: 管理画面の基盤（商品管理・CSV インポート・権限）
priority: high
estimate: 4d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-02-22
---

# 概要

管理画面の基盤を作成し、商品 CRUD、CSV バルクインポート、RBAC（admin/supporter）および監査ログ記録を実装する。

# 詳細

- エンドポイント（例）: `POST /api/admin/items/import`, `GET /api/admin/orders`, `POST /api/admin/items`
- CSV インポートはジョブ化し、インポート結果のエラーレポートを返す。
- 管理 API は RLS/RBAC で保護、管理者は 2FA を必須にする。

# 受け入れ条件

1. 管理画面での商品登録・編集・削除が行える。
2. CSV インポートで一括登録が成功し、エラー時は詳細レポートを返す。
3. 管理操作は監査ログに記録される。

# 実装ノート

- CSV ジョブテーブルとジョブワーカーを設計する。
- RLS ポリシーのサンプルをドキュメントに含める。

# 依存関係

- 監査ログ基盤、認証（管理者向け 2FA）

# チェックリスト

- [x] 管理画面 `/admin/item/create` から `POST /api/admin/items` で商品を保存できる
- [x] 管理画面 ITEM タブに Supabase 登録済み商品を表示できる
- [x] 商品登録完了後に `/admin?tab=ITEM` へ遷移する
- [x] 管理画面 ITEM タブで公開/非公開切替（PATCH）と削除（DELETE）が動作する
- [x] 管理画面 ITEM タブの編集ボタンから編集ページへ遷移し、更新（PUT）できる
- [x] 保存済みカラーをDB永続化し、別の新規作成でも再利用できる
- [x] 編集画面でも保存済みカラーの表示/再利用/削除ができ、新規作成と同じUXになっている
- [ ] CSV インポートジョブ実装
- [ ] 管理 API の RBAC 実装
- [ ] 監査ログ出力追加
