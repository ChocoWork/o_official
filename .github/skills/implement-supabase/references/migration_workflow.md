# マイグレーション運用

## ファイル命名
`supabase/migrations/<UTC timestamp>_<snake_case_name>.sql`
例: `20260501120000_create_notes_with_rls.sql`

## 1マイグレーション = 1論理変更
- スキーマ + そのRLS + 必要なインデックスを**同一ファイル**に
- データ移行は別ファイルに分離

## ロールバック戦略
- Supabaseは自動rollbackなし。**前向きマイグレーション**で対応
- 危険変更は (1)新カラム追加→(2)二重書き込み→(3)旧カラム削除 の3段階

## DBブランチ運用
1. `supabase branches create feature-x`
2. PR で migration を追加
3. preview branch で E2E
4. main にマージ → 本番自動適用（GitHub連携）

## CI チェック
- `supabase db lint`
- `audit_rls.py` で新規テーブルのRLS漏れ検出
- `get_advisors --type security` を CI ステップに