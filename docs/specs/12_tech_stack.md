## タイトル
- `技術スタック (Tech Stack)`

基づく仕様ファイル: docs/ECSiteSpec.md
推奨タスクID: [DOC-12]

## 概要
- コア技術選定と推奨ライブラリ・ツールチェーンを明記し、開発の一貫性を担保する。

## 推奨コアスタック
- フロントエンド: Next.js (App Router) + React + TypeScript
- スタイル: Tailwind CSS（トークン化）
- バックエンド/DB: Supabase (Postgres + Auth)
- 決済: Stripe
- CI/CD: GitHub Actions

## 推奨ライブラリ
- データフェッチ: `@tanstack/react-query`
- フォーム: `react-hook-form` + Zod
- E2E: Playwright
- テスト: Jest / Testing Library or Vitest
- 画像最適化: `next/image`、CDN（Cloudflare/Vercel）

## 開発環境要件
- `npm run dev` でアプリが起動し、型チェック・Lint が動作すること
- .env サンプルを `docs/` に置き、必要な環境変数を一覧化する

## デプロイ / 環境
- ステージング / 本番は分離、Secrets は Secrets Manager で管理
- Canary / Blue-Green 対応を推奨

## IaC と API 管理（追加）
- インフラは IaC（Terraform / CloudFormation）で管理し、環境再現性とコードレビューを必須化する。
- API 設計: OpenAPI を用いた API 仕様管理と自動生成、契約テスト（contract tests）による互換性担保を行う。

### Terraform モジュール設計概要（追記）

#### State 管理方針
- リモートバックエンドを必須化（例: S3 バケット + DynamoDB ロック（AWS）または Terraform Cloud）。
- State ファイルは環境単位に分割（例: `state/production`, `state/staging`）し、アクセス制御を適用する。

#### モジュール分割（環境別ではなく機能別）
- `modules/network` - VPC, Subnets, NAT, DNS
- `modules/iam` - Service roles, policies
- `modules/app` - App service (ECS/VM/App Platform) のデプロイ
- `modules/data` - DB (RDS/CloudSQL), Redis
- `modules/monitoring` - Logs, Metrics, Alerting

#### 環境分割方針
- ワークスペース/バックエンドを使い `staging`, `production` を分離。各環境は同じモジュールを使うが変数で設定を切り替える。
- ブルー/グリーンや Canary のための追加設定は module 引数で制御する。

#### 運用注意点
- State の変更は PR ベースでレビューを行い、`plan` の差分を確認すること。
- 機密情報は Terraform の `sensitive` を使用し、直接 state にプレーンテキストを書き込まない。必要ならば Secrets Manager を参照する設計にする。

### OpenAPI と契約テスト（補足）
- OpenAPI 仕様をソースとして SDK/クライアントの自動生成と contract tests を実行する。CI で差分検出と自動テストを実施する。



## チケット分割例
- TASK-1: Monorepo / Workspace の初期セットアップ（if needed）
- TASK-2: ESLint / Prettier / TypeScript 設定の整備
