---
status: todo
id: CHECKOUT-01
title: チェックアウトフローと Stripe 統合
priority: high
estimate: 3d
assignee: unassigned
dependencies: [CART-01]
created: 2026-01-17
updated: 2026-01-17
---

# 概要

ゲストおよび会員向けのチェックアウトフローを実装し、Stripe で決済を行う。Webhook の署名検証と冪等性処理を含む。

# 詳細

- エンドポイント: `POST /api/checkout/create-session`, `POST /api/checkout/complete`, `POST /api/webhook/stripe`
- Webhook は `STRIPE_WEBHOOK_SECRET` による署名検証、イベントは永続化キューで処理し冪等性を担保する。

# 受け入れ条件

1. Stripe セッション作成から支払完了後に注文が `paid` で保存される。
2. Webhook の署名検証に失敗したイベントは 400 を返す。
3. 重複イベントに対して冪等に処理される。

# 実装ノート

- 金額はサーバ側で再計算し最小単位（整数）で扱う。
- Webhook は先に永続化してワーカーで処理するパターンを採用。

# 依存関係

- Stripe, メール送信サービス

# チェックリスト

- [ ] Stripe セッション作成実装
- [ ] Webhook 受信と署名検証
- [ ] 注文確定ロジックとメール送信
