# プロンプト: 認証（Auth）SDD（構造設計＋詳細設計）

このプロンプトはリポジトリの仕様を基に「認証（Auth）」領域の**構造設計（Structure）**と**詳細設計（Detailed Design）**を生成するためのものです。

---
# 呼び出し例（使い方）
- スラッシュコマンド: `/auth-sdd TASK_ID=DOC-01 SPEC_FILES=docs/specs/01_auth.md OUTPUT_DIR=src/features/auth`

---
# 入力パラメータ（置き換えて使用してください）
- TASK_ID: 例: DOC-01
- SPEC_FILES: カンマ区切りの参照ファイルパス（必須）。例: `docs/specs/01_auth.md,docs/seq/01_auth_seq.md`
- OUTPUT_DIR: 設計成果物の推奨出力先ディレクトリ（例: `src/features/auth`）
- EXTRA: 任意の補足メモ（例: "BREAKING CHANGE は不可"）

---
# 要求事項（必須）
応答は以下の成果物を必ず作成し、リポジトリの SDD ルールに従ってください。

1. **要求—トレーサビリティマトリクス**（Markdown テーブル、必要なら CSV も）
   - 仕様の各要求（docs/specs/01_auth.md の節）と、対応する設計成果物／ファイルパス／チケットIDを紐付けること。
2. **構造設計（高レベル）**: モジュール境界図（Mermaid）とディレクトリ構成提案（例: `src/features/auth/`）
3. **詳細設計**:
   - OpenAPI（YAML）スニペット for `/api/auth/*`
   - DB マイグレーション SQL 草案
   - TypeScript 型定義 & Zod スキーマ（ファイルパスを明記）
   - Next.js App Router の API Route スタブ（ファイルパス明記）
   - セキュリティ設計（CSRF、Cookie、JTI ローテーション、シークレット管理、レート制御、監査ログ）
4. **シーケンス図（Mermaid）**: 登録確認（email confirm）、ログイン、refresh、password reset、再利用検出 等
5. **テスト計画**: 単体・結合・契約（OpenAPI）・E2E（Playwright/Cypress）
6. **受け入れ基準・チェックリスト**（各エンドポイント別）
7. **リスク & BREAKING CHANGE 一覧**（影響範囲・移行手順・承認テンプレ）
8. **見積り（人日）と優先度**（各成果物ごと）
9. **PR テンプレ**（`.github/PULL_REQUEST_TEMPLATE.md` 用の短いテンプレ）とレビューチェックリスト

---
# 制約（必ず守ること）
- TypeScript / Zod を用いること。サンプルに `any` を使用しないこと。
- スタック: Next.js (App Router), Supabase, Tailwind を前提とすること。
- 参照ファイル（SPEC_FILES）を必ず読み、各設計項目に仕様の要求IDを紐付けること。
- 破壊的変更は `BREAKING CHANGE` セクションに明示し、承認経路を書くこと。
- 各コード・スキーマにはファイルパス注記を付けること。

---
# 出力の初期要件（ワークフロー）
1. 最初に参照したファイル一覧と `TASK_ID` を一行で示す。
2. 次に「未解決の質問リスト（Question list）」を箇条書きで提示する。
3. 最初の納品として **トレーサビリティマトリクス**と**高レベル構造図（Mermaid）**を生成して停止し、続行の許可を待つこと。
   - 生成後、`npm run validate-docs` を実行して `docs/ArchitectureDesign` と `docs/DetailDesign` の Markdown が Markdown Preview Enhanced でエラーなく描画されることを確認すること。Mermaid のパースエラー、フロントマターの不整合、未閉鎖のコードフェンスがあれば修正すること。
- さらに、`SPEC_FILES` と参照した `docs/seq/*` を解析し、仕様に記載された要求（REQ-...）がすべて構造設計（`docs/ArchitectureDesign/*` のトレーサビリティマトリクス）と詳細設計（`docs/DetailDesign/*`）に**網羅されているか**を自動チェックし、`docs/ArchitectureDesign/coverage-report.md` を出力すること。coverage report の内容は以下の通りです:
  - covered: list of requirement IDs
  - missing_in_spec: list (requirements missing/unclear in spec/seq)
  - missing_in_detailed: list
  - notes: free text

- 実行手順: `npm run check-coverage` を実行し、`docs/ArchitectureDesign/coverage-report.md` を生成して PR に添付すること。

- これらの検証で欠落やレンダリングエラーがあった場合は、設計を修正して再実行し、検証が全てパスするまでコミットしないこと。
   - 【出力先（推奨）】 構造設計: `docs/ArchitectureDesign/<feature>-structure.md`、詳細設計: `docs/DetailDesign/<feature>-detailed.md`

---
# フォーマット（必須）
- Markdown 見出しを使い、簡潔にまとめること
- Mermaid をインラインで貼ること
- YAML/SQL/TS コードブロックは明示的に記載すること
- 各応答の先頭に短い要約（何を出したか、次に何を出すか）を付けること

まずは参照ファイルと `TASK_ID` を示し、未解決の質問リストを出力してください。その後、トレーサビリティマトリクスと高レベル構造図を出します。よろしくお願いします。