---
status: todo
id: INTEG-01
title: 外部連携の初期統合（Stripe, SendGrid, 配送API）
priority: high
estimate: 3d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-01-17
---

# 概要

決済（Stripe）、メール（SendGrid）、配送 API の初期統合を行い、Webhook の署名検証、idempotency、契約テストの骨組みを作る。

# 詳細

- Stripe: Checkout/Payment Element 統合、Webhook の署名検証と永続化キューの実装
- SendGrid: テンプレート連携と送信ロジック実装
- 配送: ラベル発行・追跡 API の初期統合

# 受け入れ条件

1. ステージング環境で Stripe による決済フローが正常に動作する。
2. Webhook の署名検証と冪等性が動作する。
3. SendGrid 経由でメール送信が行える。

# 実装ノート

- 各種シークレットは Secrets Manager に保存し、環境ごとに分離する。

# 依存関係

- 環境（ステージング/本番）用の外部 API キー

# チェックリスト

- [ ] Stripe 統合 + Webhook 署名検証
- [ ] SendGrid テンプレート連携
- [ ] 配送 API 初期連携
