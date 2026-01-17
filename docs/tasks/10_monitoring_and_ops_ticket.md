---
status: todo
id: MON-01
title: 監視基盤と CI/CD の整備
priority: high
estimate: 3d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-01-17
---

# 概要

RUM + サーバメトリクス + OpenTelemetry を使った監視基盤を整備し、CI/CD（品質ゲート・自動ロールバック）を構築する。

# 詳細

- 主要メトリクスの収集 (P95/P99, エラー率, 決済失敗率)
- CI パイプライン: Lint → Unit → Integration → Contract → E2E(ステージング)
- 自動ロールバック/デプロイ戦略設定（Canary / Blue-Green）

# 受け入れ条件

1. 監視ダッシュボードに主要メトリクスが表示される。
2. CI の品質ゲートが有効で、PR マージに必須チェックが適用される。

# 実装ノート

- デプロイ後のスモークチェック自動化を実装し、閾値超過でロールバックをトリガーする。

# 依存関係

- モニタリングサービス、CI プロバイダ

# チェックリスト

- [ ] APM / RUM 導入
- [ ] CI パイプライン整備
- [ ] ランブック / アラート設定
