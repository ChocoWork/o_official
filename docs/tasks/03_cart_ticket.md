---
status: todo
id: CART-01
title: カート永続化と Cart API 実装
priority: high
estimate: 2d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-01-17
---

# 概要

ゲスト/会員向けの永続カートを実装する。Cookie ベースの永続化、アイテム追加/更新/削除、クーポン適用を含む API を提供する。

# 詳細

- エンドポイント: `GET /api/cart`, `POST /api/cart/add`, `POST /api/cart/update`, `POST /api/cart/apply-coupon`
- Cookie は署名付きまたは HttpOnly で改ざん防止。サーバ側で在庫チェックを行う。

# 受け入れ条件

1. ゲストが商品を追加 → ブラウザ再起動してもカートが復元される（TTL 例: 30 日）。
2. クーポン適用はサーバ側で検証され割引が正しく計算される。
3. 在庫より多い数量はエラーで拒否される。

# 実装ノート

- 永続化方式は署名付き Cookie もしくは短期 DB 保存を選択（推奨: 署名付き Cookie + サーバ側確認）。

# 依存関係

- 在庫管理（SKU 在庫情報）、プロモーションサービス

# チェックリスト

- [ ] Cart API 実装
- [ ] Cookie 永続化設計
- [ ] クーポン検証ロジック
