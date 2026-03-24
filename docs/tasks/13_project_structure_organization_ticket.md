---
status: done
id: STRUCT-01
title: Next.js 推奨トップレベル構成への整理
priority: high
estimate: 1d
assignee: copilot
dependencies: []
created: 2026-03-24
updated: 2026-03-24
---

# 概要

`.github/instructions/guide-nextjs.instructions.md` の「Project Structure & Organization」に合わせ、`src/` 配下の構成を整理する。

# 対応方針

- `styles/` を新設し、グローバルスタイルを移設
- `contexts/` を新設し、アプリ全体の Context を移設
- `types/` に型定義を統合し、`app/types` 依存を解消
- 参照インポートを更新し、ビルド/型エラーが出ない状態を維持

# 受け入れ条件

1. `src/` 配下に `app/`, `components/`, `contexts/`, `hooks/`, `lib/`, `styles/`, `types/` が存在する。
2. `src/app/layout.tsx` が `src/styles/globals.css` を読み込む。
3. 既存機能の import エラーが発生しない。
4. 影響箇所の型チェックが通る。

# チェックリスト

- [x] 現状構成・依存関係の調査
- [x] styles の整理（globals.css 移設）
- [x] contexts の整理（Cart/Login Context 移設）
- [x] types の整理（app/types の統合）
- [x] import 更新
- [x] 検証（型チェック）
