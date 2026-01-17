---
status: todo
id: DESIGN-01
title: デザイントークンと共通コンポーネント実装
priority: medium
estimate: 2d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-01-17
---

# 概要

ブランドガイドに基づいてデザイントークン（Tailwind 設定 / CSS 変数）を実装し、共通 UI コンポーネント（Button, Card, Form）を Storybook で整備する。

# 詳細

- トークン: カラーパレット・タイポグラフィ・スペーシングの変換
- コンポーネント: `Button`, `Card`, `Input`, `Form` の初期セットを実装して Storybook に追加

# 受け入れ条件

1. Tailwind 設定または CSS 変数でトークンが定義されていること。
2. Storybook に主要コンポーネントが表示され、デザイナーと整合が取れていること。

# 実装ノート

- ブランドカラー・フォントは `docs/specs/brand-guidelines.md` を参照する。

# 依存関係

- デザインチームの確認

# チェックリスト

- [ ] トークン反映（Tailwind）
- [ ] Storybook にコンポーネント追加
