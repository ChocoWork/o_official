---
name: create-cicd
description: 'CI/CD パイプラインを構築するためのスキル。GitHub Actions を用いて、コードのビルド、テスト、デプロイを自動化する方法を定義する。'
---

## Your Mission

セキュリティ優先のプラクティス、効率的なリソース利用、信頼性の高い自動化を重視した GitHub Actions ワークフローを設計および最適化します。すべてのワークフローは、最小権限の原則に従い、不変のアクション参照を使用し、包括的なセキュリティスキャンを実装する必要があります。

## Clarifying Questions Checklist

ワークフローを作成または変更する前に確認する事項：

### Workflow Purpose & Scope
- ワークフローの種類（CI、CD、セキュリティスキャン、リリース管理）
- トリガー（push、PR、スケジュール、手動）と対象ブランチ
- 対象環境とクラウドプロバイダー
- 承認要件

### Security & Compliance
- セキュリティスキャンの要件（SAST、依存関係レビュー、コンテナスキャン）
- 準拠すべき規制（SOC2、HIPAA、PCI-DSS）
- シークレット管理および OIDC の利用可否
- サプライチェーンセキュリティ要件（SBOM、署名）

### Performance
- 期待される実行時間とキャッシュの必要性
- セルフホストランナーと GitHub ホストランナーのどちらを使用するか
- 同時実行要件

## Security-First Principles

**Permissions**:
- ワークフローレベルではデフォルトで `contents: read`
- 必要な場合のみジョブレベルで上書き
- 最小限の権限を付与

**Action Pinning**:
- 安定性のために特定のバージョンを固定
- セキュリティと保守性のバランスを取るために `@v4` のようなメジャーバージョンタグを使用
- 最高のセキュリティを求める場合はコミット SHA 固定を検討（ただし保守は増える）
- `@main` や `@latest` は使用しない

**Secrets**:
- 環境変数経由でのみアクセス
- 出力にログや露出をしない
- 本番では環境別のシークレットを使用
- 長期有効な資格情報より OIDC を優先

## OIDC Authentication

長期有効な資格情報を排除します：
- **AWS**：GitHub OIDC プロバイダーを信頼する IAM ロールを構成
- **Azure**：ワークロード ID フェデレーションを使用
- **GCP**：ワークロード ID プロバイダーを使用
- `id-token: write` 権限が必要

## Concurrency Control

- 同時デプロイを防ぐ: `cancel-in-progress: false`
- 古い PR ビルドをキャンセル: `cancel-in-progress: true`
- `concurrency.group` で並列実行を制御

## Security Hardening

**Dependency Review**: PR で脆弱な依存関係をスキャン
**CodeQL Analysis**: push、PR、スケジュールで SAST スキャン
**Container Scanning**: Trivy などでイメージをスキャン
**SBOM Generation**: ソフトウェア部品表を生成
**Secret Scanning**: push protection を有効にしてシークレット検出

## Caching & Optimization

- 利用可能な場合は組み込みのキャッシュを使用（setup-node、setup-python など）
- `actions/cache` で依存関係をキャッシュ
- ロックファイルのハッシュなど、効果的なキャッシュキーを使用
- フォールバックのために restore-keys を実装

## Workflow Validation

- actionlint でワークフローを lint
- YAML 構文を検証
- main リポジトリで有効化する前に fork でテスト

## Workflow Security Checklist

- [ ] アクションが特定のバージョンに固定されている
- [ ] 権限は最小限（デフォルトは `contents: read`）
- [ ] シークレットは環境変数でのみ扱われる
- [ ] クラウド認証に OIDC を使用している
- [ ] 同時実行制御が設定されている
- [ ] キャッシュが実装されている
- [ ] アーティファクト保持が適切に設定されている
- [ ] PR で依存関係レビューが行われている
- [ ] セキュリティスキャンが実装されている（CodeQL、コンテナ、依存関係）
- [ ] actionlint でワークフロー検証が行われている
- [ ] 本番環境向けに環境保護が設定されている
- [ ] ブランチ保護ルールが有効
- [ ] push protection でシークレットスキャンが有効
- [ ] ハードコードされた資格情報がない
- [ ] 信頼できるサードパーティアクションを使用している

## Best Practices Summary

1. アクションを特定のバージョンに固定する
2. 最小権限の権限を使用する
3. シークレットをログに記録しない
4. クラウドアクセスには OIDC を優先する
5. 同時実行制御を実装する
6. 依存関係をキャッシュする
7. アーティファクト保持ポリシーを設定する
8. 脆弱性をスキャンする
9. マージ前にワークフローを検証する
10. 本番環境向けに環境保護を使用する
11. シークレットスキャンを有効にする
12. 透明性のために SBOM を生成する
13. サードパーティアクションを監査する
14. Dependabot でアクションを最新に保つ
15. fork でまずテストする

## Important Reminders

- デフォルトの権限は読み取り専用にするべき
- OIDC は静的資格情報より優先される
- actionlint でワークフローを検証する
- セキュリティスキャンを決して省略しない
- 障害や異常を監視する