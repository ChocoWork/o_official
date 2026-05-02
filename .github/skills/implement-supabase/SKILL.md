---
name: implement-supabase
description: Use this skill when the user asks to work with Supabase — including Postgres schema design, migrations, Row Level Security (RLS) policies, Auth, Storage, Edge Functions, Realtime, or generating TypeScript types. Trigger on explicit mentions of "Supabase", "supabase-js", "@supabase/ssr", "supabase migration", or Supabase-specific concepts (auth.uid(), service_role, anon key, RLS). Do NOT trigger for generic Postgres questions without Supabase context.
---

# Implement Supabase Skill

## 1. 起動時チェックリスト

1. 操作対象が **ローカル(`supabase start`)** か **リモートプロジェクト** かを確認
2. リモートの場合、**本番** か **ステージング** かを確認
3. **`service_role` キー**を要する操作は、サーバーサイド限定であることを明示
4. 破壊的SQL（`DROP`, `TRUNCATE`, `ALTER ... DROP COLUMN`）は実行前に承認必須
5. シークレットをチャット・コードコメント・ログに出力しない

## 2. 利用するMCPツール

Supabase MCP server が提供する代表的ツール（`mcp__supabase__*`）:

- `search_docs` — 公式ドキュメント検索（**最優先**）
- `list_projects` / `get_project`
- `list_tables` / `list_extensions` / `list_migrations`
- `apply_migration` — **DDL専用**（versioned migration として記録）
- `execute_sql` — **読み取り中心のad-hoc SQL**（DDLには使わない）
- `get_logs` — `api`/`postgres`/`auth`/`storage`/`realtime`/`edge-function` のログ
- `get_advisors` — security/performance アドバイザ（**RLS漏れ検知に必須**）
- `generate_typescript_types`
- `create_branch` / `merge_branch` / `delete_branch`（DBブランチング）
- `deploy_edge_function`

> 実際のツール名はバージョンで揺れるため `ListMcpResourcesTool` で確認後に追従。

## 3. 標準ワークフロー

### A. スキーマ変更
1. `list_tables` で現状把握
2. マイグレーションSQLを `supabase/migrations/<timestamp>_<name>.sql` として作成
3. **同時にRLSポリシーも記述**（テーブル作成と同一マイグレーションが原則）
4. ローカルで `supabase db reset` → 動作確認
5. リモート反映は `apply_migration`（**プレビュー branch を優先**）
6. `get_advisors --type security` を**必ず**実行しRLS漏れチェック

### B. RLSポリシー設計
`references/rls_patterns.md` のパターンを適用。以下を**例外なく**確認:

- [ ] `ENABLE ROW LEVEL SECURITY` を設定したか
- [ ] `FORCE ROW LEVEL SECURITY` をテーブル所有者にも適用するか検討
- [ ] `SELECT` / `INSERT` / `UPDATE` / `DELETE` の **4オペレーション全て**にポリシーを書いたか
- [ ] `WITH CHECK` を `INSERT`/`UPDATE` に書いたか
- [ ] `auth.uid()` を `(select auth.uid())` でラップして**インデックス利用**を確保したか
- [ ] `service_role` バイパスの前提を明記したか
- [ ] **Storageバケット**にも個別ポリシーを書いたか

### C. 型生成
- フロントエンド側で型同期: `scripts/generate_types.sh` を CI に組み込み
- 生成物は `src/types/database.ts` 等に commit

### D. Edge Functions
- Deno ランタイム前提
- シークレットは `supabase secrets set` で投入。ハードコード禁止
- `service_role` 利用時は **request origin / JWT** を必ず検証
- CORS設定を明示

### E. デバッグ
- API 5xx → `get_logs --service api`
- RLS 拒否 → `get_logs --service postgres` で `permission denied for table` を grep
- Auth 不具合 → `get_logs --service auth`

## 4. シークレット管理（厳守）

| キー | 利用場所 | 公開可否 |
|------|----------|----------|
| `anon` key | クライアント | **公開可**（ただしRLS必須） |
| `service_role` key | **サーバーサイドのみ** | **絶対公開不可** |
| `JWT secret` | Edge Function/サーバー | 不可 |
| DB password | マイグレーションCI | 不可 |

`service_role` を使うコードを生成する際は、ファイル先頭に
`// SERVER-ONLY: never bundle to client` コメントを必ず付ける。

## 5. 危険操作リスト

- `DROP TABLE` / `DROP SCHEMA`
- `TRUNCATE`
- `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`
- `auth.users` への直接 `DELETE`（参照整合性が壊れる）
- 本番でのブランチ未経由の `apply_migration`
- Storageバケットの `public = true` 化

## 6. 参照ファイル

- `references/rls_patterns.md` — 主要RLSパターン集
- `references/migration_workflow.md` — マイグレーション運用
- `references/stripe_integration.md` — Stripe Webhook → Supabase の連携設計

## 7. Stripe Skill との連携

ユーザーが「Stripeで決済 → Supabaseで会員管理」を実装したい場合:
1. このSkillと `stripe-expert` Skill を**両方アクティブ**にする
2. `references/stripe_integration.md` のテーブル設計を採用
3. Webhook受信は **Edge Function** で実装し、`stripe-expert` の `verify_webhook.py` ロジックをDeno移植