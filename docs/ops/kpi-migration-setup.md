# KPI 目標管理機能の有効化

## 概要

シーズン別 KPI 目標管理機能を使用するには、Supabase で `admin_kpi_targets` テーブルを作成する必要があります。

## 実行手順

### 方法 1: Supabase ダッシュボード（推奨）

1. [Supabase ダッシュボード](https://app.supabase.com) にログイン
2. プロジェクト `lgulpdcdwwajbzjftlbx` を選択
3. **SQL Editor** を開く
4. 以下の SQL を実行：

```sql
-- ============================================================
-- 026: Create admin_kpi_targets table for seasonal KPI planning
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_kpi_targets (
  id BIGSERIAL PRIMARY KEY,
  season_key TEXT NOT NULL,
  kpi_key TEXT NOT NULL,
  target_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (season_key, kpi_key)
);

CREATE INDEX IF NOT EXISTS idx_admin_kpi_targets_season_key
  ON admin_kpi_targets(season_key);

CREATE INDEX IF NOT EXISTS idx_admin_kpi_targets_kpi_key
  ON admin_kpi_targets(kpi_key);

CREATE OR REPLACE FUNCTION update_admin_kpi_targets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_admin_kpi_targets_updated_at ON admin_kpi_targets;

CREATE TRIGGER trigger_admin_kpi_targets_updated_at
  BEFORE UPDATE ON admin_kpi_targets
  FOR EACH ROW EXECUTE FUNCTION update_admin_kpi_targets_updated_at();

ALTER TABLE admin_kpi_targets ENABLE ROW LEVEL SECURITY;

-- No direct user policies. Access through admin API with service role only.
```

5. 「RUN」を押して実行

## トラブルシューティング

### エラー: "[object Object]" が表示される

**原因**: エラーハンドリングの問題。通常、以下の4つの理由が考えられます。

**対応策**:
1. **ブラウザのコンソールを開く** (F12 → Console タブ)
2. **詳細なエラーログを確認**
   - `Failed to save KPI targets:` で始まるログを探す
   - その中の `errorMessage` と `fullError` を確認
3. 以下のエラーメッセージに基づいて対応：

| エラー内容 | 原因 | 対応 |
|-----------|------|------|
| `Table does not exist` または `relation "admin_kpi_targets" does not exist` | テーブルが未作成 | 上記 SQL を実行してテーブルを作成 |
| `permission denied` または `permission denied for schema public` | 権限不足 | Supabase ダッシュボードで RLS ポリシーを確認 |
| `Invalid request body` | リクエスト形式が間違っている | ブラウザをリロードして再度試す |
| `Field validation failed` | KPI キーが不正 | コンソールの `details` フィールドで詳細確認 |
| `Failed to update KPI targets` | サーバー側の予期しないエラー | コンソールの `details` フィールドを確認して対応 |

### エラー: "KPI目標テーブルが未作成です"

- 上記の SQL をすべて実行したか確認
- 実行結果に `ERROR` がないか確認
- Supabase ダッシュボードの **Tables** セクションで `admin_kpi_targets` テーブルが表示されているか確認

### エラー: "KPI目標の更新に失敗しました。再ログインしてください" (401)

- ログアウトして再度ログインする
- ブラウザのキャッシュをクリアする (Ctrl+Shift+Delete)

### エラー: "KPI目標を編集する権限がありません" (403)

- ログインユーザーがゲストまたは一般ユーザーである
- サイト管理者ユーザーで再度ログインする

## デバッグ方法

### サーバー側ログを確認

開発環境で、次のコマンドで Next.js サーバーのログを確認：

```bash
npm run dev
```

出力に `PUT /api/admin/kpi/targets error:` で始まるログが表示されている場合、その詳細情報を確認してください。

### ブラウザコンソールでのネットワーク確認

1. **DevTools を開く** (F12)
2. **Network タブ** を開く
3. KPI 目標管理で「保存」をクリック
4. `admin/kpi/targets` という PUT リクエストを探す
5. **Response** タブで API の返却値を確認

例：成功時は以下のような形式:
```json
{
  "data": {
    "currentSeason": "2026SS",
    "seasons": [...],
    "definitions": [...],
    "values": {...}
  }
}
```

例：失敗時は以下のような形式:
```json
{
  "error": "Failed to update KPI targets",
  "details": "<詳細なエラーメッセージ>"
}
```

## 検証

テーブルが正しく作成されたか確認するには、Supabase SQL Editor で以下を実行：

```sql
SELECT * FROM admin_kpi_targets LIMIT 1;
```

結果が返されれば、テーブルは正しく作成されています（現在は空のテーブル）。

## さらにヘルプが必要な場合

以下の情報を収集して、開発チームに報告してください：

1. **エラーメッセージ全文**
2. **ブラウザコンソールの完全なエラーログ** (F12 → Console)
3. **サーバーログ** (`npm run dev` の出力)
4. **Network タブの API レスポンス** (F12 → Network)
5. **使用しているブラウザとバージョン**
