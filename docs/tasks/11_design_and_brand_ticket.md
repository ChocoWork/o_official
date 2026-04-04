---
status: todo
id: DESIGN-01
title: デザイントークンと共通コンポーネント実装
priority: medium
estimate: 2d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-04-02
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
  *(現在は未使用のため `LinkButton` は削除済み)*
- [x] Admin `news/item/look` の新規作成・編集・公開切替・削除で認証付きAPI呼び出しが動作するよう `clientFetch` 統一
- [x] Admin `news/look/item` edit ページで Next.js 15 の動的ルートID取得を `useParams` に統一し、編集失敗の真因を修正
- [x] Header に `UI` メニューを追加し、`/ui` で `src/app/components/ui` の全コンポーネント確認サンプルを提供
- [x] `/ui` を提供モックに合わせて全面拡張し、`forms/navigation/data-display` コンポーネントAPIをデモ向けに更新
- [x] `src/app/components/ui` を 1コンポーネント1ファイル構成へ分解し、既存利用箇所が壊れないよう互換exportを維持
- [x] 利用側importを `@/components/ui` バレル経由から、`@/components/ui/<Component>` 直接importへ統一
- [x] 直接import統一後、未使用となった互換re-exportファイル（`forms/navigation/overlays/data-display`）を削除
- [x] export方針を「直接import優先」に決定し、`src/app/components/ui/index.ts` バレルを廃止
- [x] ESLintで `@/components/ui`（ディレクトリ直import）を禁止し、直接import運用を固定化
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
- [x] `/ui` の `Toast / Snackbar` / `Tooltip` / `Float Button` / `Table` / `List` 仕様を各UIコンポーネントへ反映
- [x] `/ui` の `Toast / Snackbar` / `Tooltip` / `Float Button` / `Table` / `List` セクションを生HTMLから `src/app/components/ui` コンポーネント利用へ置換
- [x] `/ui` の `Accordion` / `Card` / `Carousel` / `Map` / `Chart` / `Stats` 仕様を各UIコンポーネントへ反映
- [x] `/ui` の `Accordion` / `Card` / `Carousel` / `Map` / `Chart` / `Stats` セクションを生HTMLから `src/app/components/ui` コンポーネント利用へ置換
- [x] `/ui` の `Chart > CATEGORY DISTRIBUTION` が描画されない問題を `Graph` のドーナツ描画方式見直し（SVGセグメント化）で修正
- [x] `/ui` の `Map` が表示不安定になる問題を `MapView` の埋め込みレイアウトを生HTML準拠構造へ戻して修正
- [x] `/ui` の `Banner / Alert` / `Avatar` / `Toolbar` / `Tag / Label` / `Badge` 仕様を各UIコンポーネントへ反映
- [x] `/ui` の `Banner / Alert` / `Avatar` / `Toolbar` / `Tag / Label` / `Badge` セクションを生HTMLから `src/app/components/ui` コンポーネント利用へ置換
- [x] Home の `ITEMS` セクションを `item/page.tsx` と同じ `/api/items` 取得・カード描画方式へ統一し、表示件数を最大6件に制限
- [x] Home/`item/page.tsx` の公開商品取得処理を `usePublicItems` へ共通化し、Home は `limit` 指定（`<HomeItemsSection limit={...} />`）で表示件数を変更可能にした
- [x] Home/`item/page.tsx` の商品カード描画（`displayItems.map(...)`）を `PublicItemGrid` に共通化し、画面差分は `className` 指定のみで管理するよう統一
- [x] Home LOOK セクションと `/look` ページのカード描画を `PublicLookGrid` に共通化し、差分は `variant` と `className` のみで管理するよう統一
- [x] Home NEWS セクションと `/news` ページのカード描画を `PublicNewsGrid` に共通化し、差分は `buildHref`（カテゴリ維持）と `className` のみで管理するよう統一
- [x] Home の `STOCKIST` セクションと `/stockist` ページの表示を `features/stockist/components/PublicStockistGrid.tsx` に共通化し、公開データを feature 配下へ集約
- [x] Home の `ITEMS` / `LOOK` / `NEWS` セクションで、`main` の `gap` 依存を廃止し、8ptグリッド基準の `pt/pb`（`pt-14 pb-16`〜`lg:pt-20 lg:pb-24`）へ統一して縦方向リズムを最適化
- [x] HOME 実機比較（375px / 768px / 1440px）を行い、`LOOK -> NEWS` の切り替え強調のため `LOOK` セクション下余白のみ 8px 増加（`pb-[72px] md:pb-[88px] lg:pb-[104px]`）、md は追加微調整不要と判断
- [x] Home NEWS（`getLatestNews`）と `/news` 一覧の取得処理を `features/news/services/public.ts` の `getPublishedNews` に共通化
- [x] HOME 初回表示の体感速度改善のため、`page.tsx` で ITEM / NEWS をサーバー事前取得して `PublicItemGrid` / `PublicNewsGrid` へ props 注入する方式へ変更（LOOK と同等の初回描画特性に統一）
- [x] `news/[id]` の取得処理（詳細記事 + 前後ナビ記事）を `features/news/services/public.ts` に共通化し、NEWS系データ取得をサービス層へ一本化
- [x] `item/[id]` の購入操作ボタンを `/ui` の `Button` サンプル（`WITH ICON` / `ICON ONLY` / `DISABLED`）準拠の見た目・状態表示に統一
- [x] `look/[id]` の `STYLING ITEMS` 表示を `/ui` の `List` サンプル準拠に差し替え、共通 `List` コンポーネントを適用
- [x] `look/[id]` の `STYLING ITEMS` で `item.category` が表示されるよう、`getPublishedLooks` の linked item 取得項目に `category` を追加
- [x] `look/[id]` の PREV/NEXT 遷移後にメイン画像が空描画になることがある不具合を修正し、hero画像を `key + priority + sizes` で安定描画させる
- [x] `look/[id]` の初回遷移時に `STYLING ITEMS` サムネイルが出ないことがある不具合を修正し、`List` showcase画像を「高さ基準 + 幅auto」のアスペクト比表示へ変更して、リロード時の正方形見えを解消した
- [x] `src/app/components/ui` の全コンポーネントで `size`（`sm` / `md` / `lg`）指定を可能にし、共通サイズトークン（`uiSizeClass`）で反映
- [x] `/ui` に `sm` / `md` / `lg` のデモサイズ切替を追加し、主要デモを `size={demoSize}` で確認可能にした
- [x] `src/app`（`src/app/components/ui` 除外）の UI利用箇所で、`size` 対応コンポーネント未指定分へ `size="md"` を明示追加（既存指定は維持）
- [x] `size` 対応導入で崩れた `/ui` の主要表示（`ICON ONLY` 高さ差 / `Stepper` ±消失 / `SEGMENT CONTROL` 余白 / `Search Field` アイコン位置 / `Float Button` md寸法 / `Map` md寸法 / `Badge` つぶれ）を原因別に修正
- [x] `/ui` / `cart` / `item/[id]` の `Stepper` ホバー見た目を改善し、`cart` と `item/[id]` は統合前相当のコンパクト寸法（`size="sm"`）へ調整
- [x] `Stepper` の `size` 対応を維持したまま、`size` 以外の構造・操作互換（`compact` の数値入力編集、`±` 表示、`field` 構造）を統合前実装へ復元
- [x] `/ui` の `Toolbar` デモで `lg` が反映されない問題を修正（`size={compactDemoSize}` を `size={demoSize}` に変更）
- [x] `Toolbar` の `sm` 見た目を改善し、`Button` の `sm` 高さ（`h-8`）に揃えるようサイズマップを調整
- [x] `Toolbar` の `md` / `lg` 高さを `Button` と一致（`h-10` / `h-12`）させ、視認性を保つよう余白・アイコン・区切り線寸法を再調整
- [x] `/ui` の `Toolbar`（`md` / `lg`）でラベル付き・アイコンのみ両パターンの横余白を1段階だけ微調整（`label px` / `icon-only width`）
- [x] `Toolbar` の `muted` バリアントのみ hover 表現を1段階調整し、白背景との差が出るよう `hover:bg-black/[0.04]` を適用
- [x] `Toolbar` 外枠の縦パディングを除去（`p-*` -> `px-*`）し、`/ui` 上で `Button` との高さ差が出ないよう見た目を再調整
- [x] `ToastSnackbar` の `size` トークン（高さ・文字サイズ・横パディング）を `Button` と同値に統一（`sm: h-8 text-xs px-3`, `md: h-10 text-sm px-4`, `lg: h-12 text-sm px-5`）
- [x] `ToastSnackbar` の固定最小幅（`min-w-[300px]`）を廃止し、内容幅ベース（`w-fit`）へ変更して `Button` と同等のサイズ感に調整
- [x] `List` コンポーネントが `size` を受けても変化が分かりにくかったため、gap 値を大きくしテキストサイズマップを追加して `sm/md/lg` で明確に差が出るよう改善
- [x] `List` に `showcase` バリアントを追加し、`/ui` と `look/[id]` の重複HTMLをコンポーネントへ集約（`md` を既存見た目として `sm/md/lg` 対応）
- [x] `TagLabel` のサイズ感を過去コミット基準へ寄せるため `md` を `px-3 py-1 text-xs` に固定し、`sm/lg` の拡大量を抑制（`lg` の文字サイズを `text-xs` へ）
- [x] `/ui` の `Tag / Label` デモで `className="px-4 py-2"` 上書きを削除し、`TagLabel` の `size` 設計がそのまま反映されるよう修正
- [x] `TabSegmentControl` に導入されたサイズ拡大を元に戻し、md がコミット当初の標準サイズ相当（segment px-4 py-2 text-xs, pill px-6 py-2, tabs-standard text-sm, gap-8）になるようマップを調整
- [x] `Button` の型定義を `href` 有無で判別共用体化し、`ButtonHTMLAttributes` と `AnchorHTMLAttributes` の同時拡張による型衝突（`onAbort`/`onSubmit` 不一致）を解消
- [x] `Footer` のブランド文言ブロックをグリッド外へ分離し、`md` 以上で固定幅を確保してタブレット表示時の文言折り返しを防止
- [x] `news` / `item` カタログの `TabSegmentControl` をモバイル・タブレット向けに再調整し、ページ側で横スクロール許可 + スクロールバー非表示 + 余白最適化を適用（Playwright: iPhone 12 / iPad gen7 で確認）
