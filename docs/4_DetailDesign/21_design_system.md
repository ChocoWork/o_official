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

### TextField の見出しと案内（FREQ-375）

`TextField` は部品全体を `label` で包まず、外枠を `div` にして見出しを `label` の `for` で入力欄に結びつける（MDN は `for` による明示的な結びつけを推奨）。

| 要素 | 作り | 理由 |
|---|---|---|
| 見出し（`label`） | `<label for>`。必須の `*` は `aria-hidden` | 入力欄の名前を見出しの文言だけにする |
| 左端の文言（`leadingText`） | これも `<label for>` | アカウント画面では欄の見出しとして使われ、名前になる。押すと入力欄へ移る |
| 右端の要素（`trailingIcon`） | `label` の外 | 表示切替ボタンなどの名前が入力欄の名前に混ざらない。MDN は `label` の中に操作要素を置かないよう求める |
| 案内（`errorText`） | 読み上げの入れ物（`LiveMessage`。FREQ-376 により `role="alert"` から割り込まない `aria-live="polite"` に変更）を常に置き、中身だけを入れ替える。空のあいだは画面と余白から外す | 案内ごと後から差し込むと読み上げられないことがある（MDN alert role） |
| 入力欄の説明 | 案内があるときは案内、無いときは補足文（`helperText`）を `aria-describedby` で指す。案内があるときだけ `aria-invalid="true"` | WCAG 3.3.1、W3C ARIA21 |

- id も name も無いときは `useId()` で id を作り、見出しと結びつける
- 以前は外枠の `label` の中に案内があったため、Chromium では入力欄の名前が「氏名 氏名を入力してください」のように案内まで含んでいた
- `TextAreaField` も同じ作りに直した（FREQ-376）。お問い合わせのメッセージ欄は、画面側に置いていた案内をやめ、`errorText` で部品の入れ物（`#message-error`）に出す
- 検証: `tests/unit/components/TextField.test.tsx`、`tests/unit/components/TextAreaField.test.tsx`、`e2e/FR-UI-006-text-field-error-a11y.spec.ts`

### 案内の読み上げ（LiveMessage、FREQ-376）

画面の途中で出る案内は `src/components/ui/LiveMessage/LiveMessage.tsx` で出す。読み上げの入れ物を最初から置き、中身だけを入れ替える。案内ごと後から差し込むと、読み上げられないことがある（MDN alert role / ARIA live regions。Chakra UI #3240 では NVDA で読まれなかった）。

| 案内の種類 | `politeness` | 出力 | 例 |
|---|---|---|---|
| 操作の結果として出る単発の案内 | `assertive`（既定） | `role="alert"` | 送信・保存の失敗、回数制限、決済の準備・注文の確定の失敗、カートの操作失敗の Toast |
| 入力欄ごとの誤り | `polite` | `aria-live="polite"` `aria-atomic="true"` | `TextField` / `TextAreaField` / `SingleSelect` の `errorText` |
| 完了や状況の案内（FREQ-377） | `status` | `role="status"` | 保存しました、送信完了、返信を送信しました、カートの同期の失敗 |

- 空のあいだは `className` と `style` を外し、`.live-message--empty`（sr-only）にする。並びから外れるので、flex の gap や余白を増やさない
- 確定で入力欄の誤りが一度に何件も出る（checkout を空のまま確定すると最大8件）。割り込む `role="alert"` にすると一斉に読み上げられるので polite にし、先頭の誤りの欄へのフォーカス移動（FREQ-354）で知らせる
- 読み上げ領域を入れ子にしない。`ToastSnackbar` 自体は `role` も `aria-live` も持たず、外側の `LiveMessage` が読む
- Toast の `data-testid` は表示中だけ付ける（入れ物は閉じても残るため）
- 押すと文言が変わるボタン（「最新状態を再取得」→「再同期中...」）は入れ物の外に置く。中に置くと押すたびに案内全体が読み直される。外枠を常に置き、枠の見た目だけを案内があるときに当てる（カートの同期の失敗）
- 対象外: `checkout/error.tsx`（エラー境界として画面ごと出る）、`BannerAlert`（`/ui` の見本だけで使う）。最初から置いてあり中身だけが変わる `role="status"`（読み込み中の表示、件数の通知など）はそのまま
- 検証: `tests/unit/components/LiveMessage.test.tsx`、`tests/unit/components/ToastSnackbar.test.tsx`、`e2e/FR-UI-007-live-message.spec.ts`、`e2e/FR-UI-008-status-messages.spec.ts`、`e2e/FR-CART-021-action-error-toast.spec.ts`（AC-03）

### フォームごと結果の画面に入れ替わるとき（FREQ-377）

送信するとフォームが結果の画面に入れ替わる箇所では、押したボタンが消えてフォーカスが外れる（body に落ちる）。読み上げの入れ物を置く代わりに、結果の見出し・文言へフォーカスを移す。フォーカスで読ませるので、同じ内容を `role="status"` でも読ませない（二重に読まれる）。

| 画面 | フォーカスの移し先 | 作り |
|---|---|---|
| パスワード再設定の結果（`AuthResultScreen`） | 結果の見出し（h1） | `tabIndex={-1}` と表示時の `focus()` |
| 会員登録の確認メール送信（`RegisterModal`） | 完了の文言 | `tabIndex={-1}` と callback ref の `focus()` |

- 読み込み中から次の案内に変わるだけの画面（`auth/verified`）は、同じ `role="status"` の要素の中身を入れ替える
- 検証: `tests/unit/components/AuthResultScreen.test.tsx`、`e2e/FR-UI-008-status-messages.spec.ts`（AC-04・AC-05）

### 選択欄 SingleSelect（dropdown）の combobox（FREQ-379）

dropdown の引き金は APG の select-only combobox にする。`button` の役割では `aria-invalid` を使えない（ARIA 1.2 で対象外）ため、Radix Select と同じく `<button role="combobox">` にする。

| 要素 | 作り |
|---|---|
| 見出し | `<label for>`。部品全体を `label` で包まない（TextField と同じ） |
| 引き金 | `role="combobox"`、`aria-haspopup="listbox"`、`aria-expanded`、開いているあいだ `aria-controls` と `aria-activedescendant` |
| 一覧 | ポータルの `role="listbox"`。選択肢は `role="option"` の div で、押してもフォーカスを引き金に残す |
| 誤りの案内 | `errorText` で部品の中に polite の入れ物（`#<id>-error`）を置き、`aria-invalid="true"` と `aria-describedby` を付ける。枠はエラー色 |

| キー | 閉じているとき | 開いているとき |
|---|---|---|
| ↓ / ↑ / Enter / Space | 開く（選択中の項目を指す） | ↓↑ で移る。Enter / Space で選んで閉じる。Alt+↑ で選んで閉じる |
| Home / End | 開いて先頭 / 末尾を指す | 先頭 / 末尾へ |
| PageUp / PageDown | — | 10件ずつ移る |
| Esc | — | 選ばずに閉じる（外側のダイアログまで閉じない） |
| Tab | 次の欄へ | 指している項目を選んで閉じ、次の欄へ |

- 文字を打って項目へ飛ぶ操作（type-ahead）は入れていない。選択肢の多くが日本語で、キー入力と対応しにくいため
- 選択肢の横の削除ボタン（`option.onAction`。会計画面の摘要など）はマウス操作だけで届く。一覧は開いたまま Tab を押すと選んで閉じるので、キーボードでは届かない（以前もポータルがページ末尾にあり、実質届かなかった）。キーボードで消す手段は未対応
- 引き金を `button` として探していたテストは `combobox` に直した（E2E 19本・単体テスト）
- 検証: `tests/unit/components/SingleSelect.combobox.test.tsx`、`e2e/FR-UI-009-select-combobox.spec.ts`

### 共通化済みグリッドコンポーネント

| コンポーネント | 使用箇所 |
|-----------|---------|
| `PublicItemGrid` | Home ITEMS セクション + `/item` 一覧 |
| `PublicLookGrid` | Home LOOK セクション + `/look` 一覧 |
| `PublicNewsGrid` | Home NEWS セクション + `/news` 一覧 |
| `PublicStockistGrid` | Home STOCKIST セクション + `/stockist` 一覧 |
