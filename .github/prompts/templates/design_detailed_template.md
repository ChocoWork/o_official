# 詳細設計テンプレート（Detailed Design）

## ヘッダ
- 機能: <機能名>
- タスクID: <TASK_ID>
- 構造設計参照: `<構造設計ファイルパス>` (必須、**構造設計のアーキテクチャID を参照してから詳細を作成すること**)
- 参照仕様: <参照ファイル一覧>
- 作成者: <名前>
- 日付: YYYY-MM-DD

- **出力先（推奨）**: `docs/DetailDesign/<feature>-detailed.md`（長文の設計）または `src/features/<feature>/design.md`（コード近傍の設計）。JSON/YAML/SQL/TS のスニペットは必ずファイルパス注記を入れること。


## 1. 概要
- 構造設計で定義されたアーキテクチャID と紐付けて、詳細を定義する

## 2. API（OpenAPI スニペット）
- 各エンドポイントごとに OpenAPI のスニペットを記載（YAML）
- 例: `/api/auth/register` の request/response schema

## 3. DB スキーマ / マイグレーション
- SQL マイグレーション草案（ファイル名例: `migrations/00XX_create_auth_sessions.sql`）
- 影響範囲とロールアウト/ロールバック手順を明記

## 4. 型定義 & バリデーション
- TypeScript の型定義と Zod スキーマ（ファイルパスを明記）
- 例: `src/features/auth/types.ts`, `src/features/auth/schemas.ts`

## 5. API Route スタブ（Next.js App Router）
- ファイルパスを明記してルートのスタブを示す（例: `src/app/api/auth/register/route.ts`）

## 6. セキュリティ設計
- CSRF 対策（ダブルサブミット / トークン）, Cookie 設定（HttpOnly, Secure, SameSite=Lax）
- Refresh トークンの JTI ローテーション設計、再利用検出時の対応
- シークレット管理（SUPABASE_SERVICE_ROLE_KEY はサーバ側）
- レート制限戦略（IP/アカウントの二軸制御）

## 7. 監査ログ・運用設計
- 監査イベントの形式（JSON Lines）と保持ポリシー

## 8. テスト計画
- 単体テスト、結合テスト、OpenAPI 契約テスト、E2E（Playwright/Cypress）ケース

## 9. 受け入れ基準 & チェックリスト
- 各エンドポイントごとに検証可能な基準を列挙

## 10. BREAKING CHANGE と移行手順
- 破壊的変更がある場合は影響範囲、ダウンタイム、承認者を明記

## 11. 見積り（人日）
- 各作業項目の概算

*詳細設計は必ず構造設計のアーキテクチャID を参照して記載してください。*

## ドキュメント検証（必須）
- 詳細設計を作成後、`npm run validate-docs` を実行して `docs/DetailDesign` と `docs/ArchitectureDesign` の Markdown が Markdown Preview Enhanced でエラーなく描画されることを確認してください。Mermaid のパースエラー、フロントマターの不整合、未閉鎖のコードフェンスがあれば修正してから次に進んでください。