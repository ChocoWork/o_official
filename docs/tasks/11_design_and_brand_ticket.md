---
status: todo
id: DESIGN-01
title: デザイントークンと共通コンポーネント実装
priority: medium
estimate: 2d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-02-27
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
- [x] `src/app/components/ui` に再利用 UI コンポーネント群を追加（フォーム・ナビゲーション・オーバーレイ・表示系）
- [x] 主要画面（`contact` / `checkout` / Admin の `Item`・`Look`・`News`・`Order`）で共通UIを適用
- [x] ページ層の共通UI置換（`news` / `news/[id]` / `stockist` / `item` / `item/[id]`）
- [x] `account` ページの主要操作（タブ・プロフィール編集・住所入力・ログイン導線）を共通UIへ置換
- [x] 認証/管理フォームの追加置換（`auth/password-reset` / `admin/create-user`）
- [x] Admin `item/look/news` の create/edit ページで入力UIを共通コンポーネントへ統一
- [x] Admin 一覧ページ側のアクション導線（新規作成/編集リンク）を `LinkButton` に統一
- [x] Admin `news/item/look` の新規作成・編集・公開切替・削除で認証付きAPI呼び出しが動作するよう `clientFetch` 統一
- [x] Admin `news/look/item` edit ページで Next.js 15 の動的ルートID取得を `useParams` に統一し、編集失敗の真因を修正
- [x] Header に `UI` メニューを追加し、`/ui` で `src/app/components/ui` の全コンポーネント確認サンプルを提供
- [x] `/ui` を提供モックに合わせて全面拡張し、`forms/navigation/data-display` コンポーネントAPIをデモ向けに更新
- [x] `src/app/components/ui` を 1コンポーネント1ファイル構成へ分解し、既存利用箇所が壊れないよう互換exportを維持
- [x] 利用側importを `@/app/components/ui` バレル経由から、`@/app/components/ui/<Component>` 直接importへ統一
- [x] 直接import統一後、未使用となった互換re-exportファイル（`forms/navigation/overlays/data-display`）を削除
- [x] export方針を「直接import優先」に決定し、`src/app/components/ui/index.ts` バレルを廃止
- [x] ESLintで `@/app/components/ui`（ディレクトリ直import）を禁止し、直接import運用を固定化
- [x] PR時に `npm run lint` を自動実行する GitHub Actions（`.github/workflows/lint.yml`）を追加
- [x] `/ui` の `Color Picker` で `PRESET COLORS` が未着色になる問題を修正（CSP下でのインライン背景指定をクラス指定へ変更）
- [x] `/ui` の `Date / Time Picker` で `DATE` / `TIME` / `DATETIME` 入力が固定値で編集不能だった問題を修正（state + onChange で制御）
- [x] `/ui` の `Page Control` / `Bottom Navigation` / `STANDARD TABS` / `SEGMENT CONTROL` を状態管理付きで動作化（選択状態の見た目更新と前後ページ遷移を実装）
- [x] `/ui` の `Search Field` を入力可能に修正し、`WITH CLEAR BUTTON` で入力時のみクリアボタン表示・ワンクリック消去を実装
- [x] `/ui` の `Toast / Snackbar` で SUCCESS ボタンを押すとトーストが表示されるように実装
- [x] `/ui` の `Text Field`（`STANDARD` / `WITH ICON` / `DISABLED` / `TEXTAREA`）仕様を `TextField.tsx` / `TextAreaField.tsx` に反映
- [x] `/ui` の `Button`（`PRIMARY` / `SECONDARY` / `TEXT` / `WITH ICON` / `ICON ONLY` / `DISABLED`）、`Radio Button`、`Checkbox` 仕様を各UIコンポーネントへ反映
- [x] `/ui` の `Text Field` / `Button` / `Radio Button` / `Checkbox` セクションを生HTMLから `src/app/components/ui` コンポーネント利用へ置換
- [x] `/ui` の `Single Select` / `Multi Select` / `Switch / Toggle` / `Slider` 仕様を各UIコンポーネントへ反映
- [x] `/ui` の `Single Select` / `Multi Select` / `Switch / Toggle` / `Slider` セクションを生HTMLから `src/app/components/ui` コンポーネント利用へ置換
- [x] `/ui` の `Stepper` / `Rating`（`INTERACTIVE`・`READ ONLY`）/ `Color Picker`（`PRESET COLORS`・`CUSTOM COLOR`）/ `Date / Time Picker`（`DATE`・`TIME`・`DATETIME`）仕様を各UIコンポーネントへ反映
- [x] `/ui` の `Stepper` / `Rating` / `Color Picker` / `Date / Time Picker` セクションを生HTMLから `src/app/components/ui` コンポーネント利用へ置換
- [x] `/ui` の `Page Control` / `Bottom Navigation` / `Tab / Segment Control`（`STANDARD TABS`・`SEGMENT CONTROL`）/ `Search Field`（`STANDARD`・`WITH CLEAR BUTTON`）/ `Dialog` 仕様を各UIコンポーネントへ反映
- [x] `/ui` の `Page Control` / `Bottom Navigation` / `Tab / Segment Control` / `Search Field` / `Dialog` セクションを生HTMLから `src/app/components/ui` コンポーネント利用へ置換
- [x] `/ui` の `Sheet`（`MEDIUM SHEET`・`LARGE SHEET`）/ `Action Sheet` / `Dropdown` / `Drawer` 仕様を各UIコンポーネントへ反映
- [x] `/ui` の `Sheet` / `Action Sheet` / `Dropdown` / `Drawer` セクションを生HTMLから `src/app/components/ui` コンポーネント利用へ置換
