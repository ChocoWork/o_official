---
status: todo
id: TECH-01
title: 技術スタック初期設定（Next.js, Tailwind, Supabase）
priority: high
estimate: 2d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-01-17
---

# 概要

プロジェクトのコア技術スタック（Next.js App Router, TypeScript, Tailwind, Supabase）を初期セットアップし、ESLint/Prettier/CI の基本を整える。

# 詳細

- 初期セットアップ: `next`, `tailwindcss`, `typescript` の設定、`.env.example` の作成
- 開発ツール: ESLint/Prettier、Pre-commit hook の導入
- CI: GitHub Actions に基本パイプラインを作成（lint → tests）

# 受け入れ条件

1. `npm run dev` でアプリが起動する。
2. ESLint/TypeScript の基本チェックが CI で走る。
3. `.env.example` に必須環境変数が記載されている。

# 実装ノート

- OpenAPI/contract tests の導入は別チケットで実施する。

# 依存関係

- none

# チェックリスト

- [ ] Next.js + Tailwind の初期設定
- [ ] ESLint / Prettier 設定
- [ ] CI 基本パイプライン作成
