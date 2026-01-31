# Auth-related DB マイグレーション手順

目的: `password_reset_tokens`, `audit_logs`, `sessions` など、認証周りに必要なテーブルを履歴管理された SQL マイグレーションで導入します。

場所:
- リポジトリ直下の `migrations/` に SQL ファイルを配置しています。

運用方針（推奨）:
1. 開発 → ステージング → 本番 の順で適用する。マイグレーションは必ず Git 管理する。
2. CI（GitHub Actions）で `DATABASE_URL` を Secrets に設定し、`migrations/*.sql` を自動適用するワークフローを用意しています（.github/workflows/db-migrations.yml）。
3. 破壊的変更がある場合は事前にバックアップ（DB スナップショット）を取得し、ステージングで動作確認後に本番適用する。

手動で実行する場合（開発 / 緊急適用）:

PowerShell 例:
```powershell
$env:PGPASSWORD = "<your_db_password>"
psql "<DATABASE_URL>" -f migrations/001_create_password_reset_tokens.sql
psql "<DATABASE_URL>" -f migrations/002_create_audit_logs.sql
psql "<DATABASE_URL>" -f migrations/003_create_sessions.sql
```

GitHub Actions のセットアップ:
1. リポジトリの `Settings > Secrets` に `DATABASE_URL` を追加（接続文字列: postgres://user:pass@host:port/dbname）。
2. `main` ブランチに push するとワークフローが走り、`migrations/*.sql` を順次適用します。

注意:
- Supabase を利用している場合は `SUPABASE_SERVICE_KEY` を用いた管理操作が必要なケースがあります。`DATABASE_URL` と `SUPABASE_SERVICE_KEY` のいずれを CI で使うかは環境に合わせて決めてください。
- `pgcrypto` 拡張が必要な SQL を含みます（`gen_random_uuid()` 等）。エラーが出た場合は管理者に確認してください。
