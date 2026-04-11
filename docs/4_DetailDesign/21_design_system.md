# デザインシステム・UI コンポーネント 詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-DESIGN-001 | Tailwind 設定または CSS 変数でブランドカラー・タイポグラフィ・スペーシングのトークンを定義する | IMPL-DESIGN-001 | `tailwind.config.ts` | Tailwind デフォルト設定のまま。ブランドガイドのカラートークン未反映 | 未 |
| FR-DESIGN-002 | `src/components/ui/` に再利用 UI コンポーネント群を実装し `/ui` プレビューページで確認できるようにする | IMPL-DESIGN-002 | `src/components/ui/`, `src/app/ui/page.tsx` | Button/Card/Form/Nav/Overlay/Data Display 系統の全コンポーネントを実装済み。`/ui` プレビューページ完成 | 済 |
| FR-DESIGN-003 | 各コンポーネントに `size`（sm/md/lg）指定を可能にし共通サイズトークンで反映する | IMPL-DESIGN-003 | `src/components/ui/` | `uiSizeClass` トークンで全コンポーネントのサイズバリエーションを実装済み | 済 |
| FR-DESIGN-004 | ESLint でバレル経由インポート禁止ルールを設定し直接インポートを強制する | IMPL-DESIGN-004 | `eslint.config.mjs` | `@/components/ui` ディレクトリ直接インポートを ESLint で禁止。直接インポート運用を固定 | 済 |
| FR-DESIGN-005 | GitHub Actions に lint ワークフローを追加し PR 時に自動実行する | IMPL-DESIGN-005 | `.github/workflows/lint.yml` | `npm run lint` を PR / push 時に自動実行するワークフロー実装済み | 済 |
| FR-DESIGN-006 | Storybook を導入し主要コンポーネントをデザイナーと確認できるようにする | — | — | 未実装 | 未 |

---

## 実装タスク管理 (DESIGN-01)

**タスクID**: DESIGN-01  
**ステータス**: 大半実装済み、Storybook 未着手  
**元ファイル**: `docs/tasks/11_design_and_brand_ticket.md`

### チェックリスト

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| DESIGN-01-001 | Tailwind トークン反映（ブランドカラー/フォント） | IMPL-DESIGN-TOKEN-01 | `tailwind.config.ts` | 未実装 | 未 |
| DESIGN-01-002 | Storybook にコンポーネント追加 | IMPL-DESIGN-STORYBOOK-01 | `.storybook/`, `src/stories/` | 未実装 | 未 |

### 実装済みコンポーネント一覧

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| DESIGN-01-COMP-001 | Form: TextField, TextAreaField, Button, RadioButton, Checkbox | IMPL-DESIGN-FORM-01 | `src/components/ui/TextField.tsx`, `src/components/ui/Button.tsx` 他 | 全コンポーネント実装済み | 済 |
| DESIGN-01-COMP-002 | Form: SingleSelect, MultiSelect, Switch, Slider, Stepper | IMPL-DESIGN-FORM-02 | `src/components/ui/SingleSelect.tsx` 他 | 全コンポーネント実装済み | 済 |
| DESIGN-01-COMP-003 | Form: Rating, ColorPicker, DateTimePicker | IMPL-DESIGN-FORM-03 | `src/components/ui/Rating.tsx` 他 | 全コンポーネント実装済み | 済 |
| DESIGN-01-COMP-004 | Navigation: PageControl, BottomNavigation, TabSegmentControl, SearchField | IMPL-DESIGN-NAV-01 | `src/components/ui/PageControl.tsx` 他 | 全コンポーネント実装済み | 済 |
| DESIGN-01-COMP-005 | Overlay: Dialog, Sheet, ActionSheet, Dropdown, Drawer | IMPL-DESIGN-OVERLAY-01 | `src/components/ui/Dialog.tsx` 他 | 全コンポーネント実装済み | 済 |
| DESIGN-01-COMP-006 | Data Display: Toast/Snackbar, Tooltip, FloatButton, Table, List | IMPL-DESIGN-DATA-01 | `src/components/ui/Toast.tsx` 他 | 全コンポーネント実装済み | 済 |
| DESIGN-01-COMP-007 | Data Display: Accordion, Card, Carousel, Map, Chart (SVG セグメント), Stats | IMPL-DESIGN-DATA-02 | `src/components/ui/Accordion.tsx` 他 | 全コンポーネント実装済み | 済 |
| DESIGN-01-COMP-008 | Feedback: Banner/Alert, Avatar, Toolbar, Tag/Label, Badge | IMPL-DESIGN-FEED-01 | `src/components/ui/Banner.tsx` 他 | 全コンポーネント実装済み | 済 |

### コンポーネント運用ルール

- インポートパス: `@/components/ui/Button` 形式（バレル経由 `@/components/ui` は ESLint で禁止）
- 参照: `docs/specs/brand-guidelines.md` に従いデザイントークンを適用する
- サイズ変数: `sm` / `md` / `lg` を `size` prop で指定可能

### 共通化済みグリッドコンポーネント

| コンポーネント | 使用箇所 |
|-----------|---------|
| `PublicItemGrid` | Home ITEMS セクション + `/item` 一覧 |
| `PublicLookGrid` | Home LOOK セクション + `/look` 一覧 |
| `PublicNewsGrid` | Home NEWS セクション + `/news` 一覧 |
| `PublicStockistGrid` | Home STOCKIST セクション + `/stockist` 一覧 |
