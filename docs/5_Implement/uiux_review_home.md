# HOME UI/UX レビュー

- 対象: [src/app/page.tsx](../../src/app/page.tsx)
- 共通コンポーネント: [src/components/Header.tsx](../../src/components/Header.tsx) / [src/components/Footer.tsx](../../src/components/Footer.tsx)（**全ページ共通。本ファイルに集約し、他ページは本ファイルを参照**）
- レビュー基準: `implement-uiux`（デザイン4原則 / ゲシュタルト / UX法則 / 黄金比 / WCAG 2.2 AA / インタラクション）+ ブランド適合（[brand.md](../1_RequirementsDifinition/brand.md)）
- ブランド: Le Fil des Heures｜「時を紡ぐニュートラルモードな日常着」｜Key Color = Absolute Black / Graphite Grey / Optical White｜見出し Didot

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| 未対応 | 未着手 |
| 対応中 | 一部対応・設計検討中 |
| 対応済 | 修正完了 |

優先度: High（離脱・信頼・購入に直結）/ Mid（体験品質）/ Low（磨き込み）

---

## ペルソナ適合サマリー

- コアペルソナ「中原玲央」は **「なぜこの服を作ったか」「天然繊維100%で洗える」「受注生産」** に金を払う層。HOMEのヒーローはブランド名のみで、刺さる言葉（コンセプト文・差別化要素）が一切提示されず、**第一印象で価値が伝わらない**のが最大の課題。
- ミニマルな世界観（静かで強い）は準ペルソナA/Cに刺さる方向で正しい。装飾を足すのではなく「思想の言語化」と「導線の明確化」で改善すべき。

---

## レビュー結果（HOME 本体）

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| H-1 | [page.tsx:56-60](../../src/app/page.tsx#L56-L60) ヒーロー | ブランド名 h1 のみで、コンセプト文・CTA が無い。コアペルソナが求める「思想・差別化（天然繊維100%/受注生産/洗える）」が第一画面でゼロ。Peak-End / Visual Hierarchy / Hick（次アクション不在） | h1 直下にコンセプト「時を紡ぐニュートラルモードな日常着」+ 一行の価値訴求、第一CTA（VIEW COLLECTION → /item）を1つだけ配置 | High | 対応済 |
| H-2 | [page.tsx:82](../../src/app/page.tsx#L82) About文 | 「普**遂**的なデザイン」は「普**遍**的」の誤字（about/page.tsx は正しく「普遍的」）。ブランドの信頼性を損なう（コアペルソナは細部の質を見る） | 「普遍的」へ修正 | High | 対応済 |
| H-3 | [page.tsx:48](../../src/app/page.tsx#L48) ヒーロー画像 | `alt="Hero Background"` は内容を表さない。ブランド主役画像で alt が無価値（WCAG 1.1.1） | ブランド世界観を表す alt（例「ニュートラルな日常着をまとうルックのメインビジュアル」）に変更 | Mid | 対応済 |
| H-4 | [page.tsx:43](../../src/app/page.tsx#L43) ヒーロー | `min-h-screen` + `pt-20` でヒーローが 100vh を超え、モバイルでファーストビューに余白/見切れが生じうる。整列・モバイル最適化 | `min-h-[100svh]` 等で svh を使い、ヘッダー高ぶん内側で吸収 | Mid | 対応済 |
| H-5 | ヒーロー全体 | スクロール誘導の手がかりが無い。ヒーローが全画面のため「下にコンテンツがある」ことが伝わりにくい（ゲシュタルト：閉合/連続） | 控えめなスクロールインジケータ（↓ / 細線）を最下部中央に追加 | Low | 対応済 |
| H-6 | [page.tsx:100-106](../../src/app/page.tsx#L100-L106) About画像 | `unoptimized` 指定で最適化を放棄。LCP/転送量に不利（高単価ECで表示品質と速度は信頼に直結） | next/image 最適化を有効化、または事前最適化済みアセットを使用 | Low | 対応済 |
| H-7 | About セクション | HOME の About は概要のみで、差別化（天然繊維100%・洗える・受注生産・ユニセックス・SS/AW固定）が無い。ブランド適合（供給の核/刺さる言葉） | 3つの価値（長く着られる / 天然繊維100%で洗える / 受注生産）をアイコン無しの簡潔な3項目で提示し /about へ誘導 | Mid | 対応済 |
| H-8 | セクション順（items→look→news→about→stockist） | 信頼性を重視する層には「思想（about）」が下方すぎる。読み進め（F/Z）と認知の流れ | about の要約を search preview 直後など上位に薄く差し込む、もしくはヒーローで思想を一言示す | Low | 対応済 |

---

## レビュー結果（共通 Header / Footer）※全ページ共通

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| C-1 | [Header.tsx:22](../../src/components/Header.tsx#L22) / [Header.tsx:153-162](../../src/components/Header.tsx#L153-L162) | `/ui`（開発用コンポーネントギャラリー）が公開ナビ・ドロワーに露出。一般ユーザーに無意味でブランド毀損・Hick（選択肢過多） | 本番ナビから `UI` を削除（ルートも要ガード） | High | 対応済（方針変更）公開ナビから削除＋本番ビルドで `notFound()` ガード。開発環境では直アクセス可（[uiux_review_ui.md](./uiux_review_ui.md) UI-1/UI-2 と統一） |
| C-2 | [Header.tsx:176-199](../../src/components/Header.tsx#L176-L199) アイコンリンク | クラス名が `icon-flame`（globals 定義は `icon-frame`）。タイポで 44px タップ領域が当たらず、クリック範囲が文字グリフのみ（≒20px）。Fitts / タッチターゲット44px / モバイル | `icon-frame` に修正し各アイコンを 44×44px の当たり判定に | High | 対応済 |
| C-3 | [Header.tsx:179-189](../../src/components/Header.tsx#L179-L189) wishlist/cart/account アイコン | `aria-label` 無し（search のみ有）。スクリーンリーダーで「リンク」としか読まれない（WCAG 4.1.2 / 名前） | wishlist/cart/account/menu に aria-label を付与（cart は件数も読み上げ） | High | 対応済 |
| C-4 | [Header.tsx:280-293](../../src/components/Header.tsx#L280-L293) ドロワーSNS | Instagram/Facebook/Twitter ボタンに href も onClick も無く**機能しない**。アフォーダンス詐称 + ブランド（SNSは集客の核） | 実SNS URL の `<a>` に変更。後述C-7と統一 | High | 対応済 |
| C-5 | [Footer.tsx:9-15](../../src/components/Footer.tsx#L9-L15) SHOPリンク | ALL/TOPS/BOTTOMS/OUTERWEAR/ACCESSORIES が**全て `/item`**（カテゴリ未指定）。リンク文言と遷移先が不一致（Jakob / アフォーダンス） | `/item?category=TOPS` 等カテゴリ付きへ。ヘッダードロワーは実装済みなので流用 | Mid | 対応済 |
| C-6 | [Footer.tsx:62-79](../../src/components/Footer.tsx#L62-L79) SNS | `href="#"` で遷移しない。ブランド（IG/TikTok が集客の核）の機会損失 | 実URLに。`target=_blank rel=noopener` 付与 | High | 対応済 |
| C-7 | [Footer.tsx:62-79](../../src/components/Footer.tsx#L62-L79) SNS構成 | brand.md の集客核は **TikTok / Instagram / note**。実装は Instagram/Facebook/X で **TikTok 欠落**・Facebook は非戦略 | TikTok を追加、Facebook を見直し（note/blog 導線も検討） | Mid | 対応済 |
| C-8 | [Footer.tsx:84-90](../../src/components/Footer.tsx#L84-L90) 法務テキスト | `footer-legal-*` は `--lk-size-4xs`（≈10px）+ `text-white/50`。極小フォント×低コントラストで可読性・WCAG 1.4.3 リスク | 文字は据え置きでも色を white/70 以上へ、最小可読サイズを再確認 | Mid | 対応済 |
| C-9 | [Header.tsx:70-92](../../src/components/Header.tsx#L70-L92) スクロール表示制御 | 下スクロールでヘッダー全消し。検索/カート/メニューが消え、再アクセスに上スクロールが必要（発見可能性低下）。モバイルThumb-zone | 完全非表示でなく縮小（コンパクト化）に留める案を検討 | Low | 対応済 |
| C-10 | 全ページ レイアウト | `layout.tsx` で `<Header/>`/`<Footer/>` が描画されていない（children のみ）。各ページが個別配置依存だと整合崩れ・スキップリンク等共通対応が困難 | 共通レイアウトでの Header/Footer 集約と「メインへスキップ」リンク・`<main>` ランドマーク追加を検討 | Mid | 対応済 |

> 注: C-2/C-3/C-4/C-6 は機能不全に近く、UI/UX 以前の不具合として優先対応推奨。

---

## 修正反映（2026-06-20｜共通不具合）

- **C-2（対応済）**: ヘッダーアイコンのクラス誤字 `icon-flame`→`icon-frame` を修正。各アイコンリンクに `min-h-[44px]` を付与し**縦方向のタップ領域を44pxに拡大**（Fitts）。※横幅は「長いブランド名＋5アイコン」のモバイル制約上 44px 確保は不可のため据え置き（横は要デザイン判断＝モバイルのアイコン数削減 等。menuボタンも同様に要追従）。
- **C-3（対応済）**: search/wishlist/cart/account に `aria-label` を付与（cart は `カート（N点）` と件数読み上げ）。menu は既存で付与済み。
- 実装: [src/components/Header.tsx](../../src/components/Header.tsx)。
- **C-4 / C-6 / C-7（対応済）**: SNSを一元管理する [src/lib/social.ts](../../src/lib/social.ts) を新設。Footer・ドロワーとも**実リンク化**（`target=_blank` `rel=noopener noreferrer` `aria-label` 付与）。構成を **Instagram / TikTok / X**（Facebook廃止）に変更。Instagram は実URL設定済み、TikTok・X は **URL未開設のため非表示**（`social.ts` に URL を入れると自動表示。死にリンクを出さない方針）。

---

## implement-uiux に「あえて従わない」判断（重要）

`implement-uiux` は汎用最強UIの指針だが、本ブランドの世界観と相反する箇所がある。以下は**意図的に従わない**。

1. **カラーシステム（Layer 5）の有彩色パレットを採用しない**
   - スキルは `--color-primary: blue`、success=緑 / warning=黄 / error=赤 等を推奨。だが本ブランドの Key Color は **黒・グレー・白の3色のみ**。コアペルソナ/準ペルソナAは「装飾が多い/色展開が派手」を**買わない理由**に挙げる。
   - 判断: **有彩色を導入しない**。状態（成功/エラー）は色相ではなく **アイコン+テキスト+太さ+罫線** で表現。例外として `error` の赤は「重大な失敗」最小限のみ許容（コントラスト確保目的）。

2. **本文最小 16px（Layer 4）を全面適用しない**
   - スキルは本文 1rem 以上を要求。本サイトは editorial な小型タイポ（ラベル `xs`〜`2xs` ≈10〜12px、`--lk-size-md` ≈14〜15px）でモード感を出しており、これはブランド表現として妥当（VOAAOV/Graphpaper 系の作法）。
   - 判断: **ラベル/キャプション/装飾テキストの小型は維持**。ただし **意思決定情報（価格・在庫・フォームのラベルとエラー・法務本文・本文段落）は可読下限（実測14px相当以上）を担保**する“部分的逸脱”とする（各ページ表で個別指摘）。

3. **CTA を色とサイズで「突出」させすぎない（Layer 1 対比 / Layer 3）**
   - スキルは primary CTA を派手に強調と説く。ラグジュアリーミニマルでは逆効果。
   - 判断: **トーンは抑制したまま、塗り（黒ベタ）vs 枠線/テキスト の“質”で優先度を表現**。1画面1主役は守る。

4. **マイクロインタラクションは最小限**
   - 過度なアニメは「静かで強い世界観」を壊す。150–300ms の控えめなフェード/アンダーライン/スケールに留める（既存実装の方向は妥当）。

> 逆に**必ず従うべき**スキル指針: タッチターゲット44px、ラベルとinputの紐付け、alt、フォーカス可視化、コントラスト下限、エラーは「原因＋解決策」、空状態に次アクション。これらはブランド表現と無関係に品質の前提。

---

## 修正反映（2026-06-20）

- **H-1**: ブランド意思決定により**ヒーローは名前のみ維持**し、直下に「CONCEPT」節を新設（コンセプト一文 + 天然繊維100%/受注生産・シーズンレス/ユニセックスの3本柱 + READ OUR STORY → /about）。AskUserQuestion で「名前のみ＋直下に新節」を選択。
- **H-2**: HOME本文の誤字「普遂的」→「普遍的」修正。
- **H-7**: CONCEPT節で差別化（天然繊維/受注生産/ユニセックス）を提示し /about へ誘導。
- 実装: [src/app/page.tsx](../../src/app/page.tsx)。

---

## 修正反映（2026-06-22）

- **CONCEPT → ABOUT 統合**: 独立していた CONCEPT 節を廃止し、ABOUT 節へ集約。ABOUT 節を「コンセプト一文（時を紡ぐ…）＋ マニフェスト ＋ ブランド概要 ＋ ビジュアル ＋ 差別化3本柱（天然繊維/受注生産/ユニセックス）＋ READ OUR STORY → /about」の単一構成に再編。H-1/H-7 の差別化提示は ABOUT 節内に移設して**維持（対応済のまま）**。
- **H-3（対応済）**: ヒーロー画像 alt を `Hero Background` → 「ニュートラルな日常着をまとう Le Fil des Heures のメインビジュアル」へ変更。
- **H-4（対応済）**: ヒーロー `min-h-screen` → `min-h-[100svh]`。モバイルの動的ビューポートで見切れ/余白を抑制。
- **H-5（対応済）**: ヒーロー最下部中央に控えめなスクロールインジケータ（`SCROLL` ラベル + 細い縦線、`aria-hidden`）を追加。トーンは抑制（モノクローム/極小）でブランド世界観を維持。
- **H-6（対応済）**: ABOUT 画像の `unoptimized` を撤去し next/image 最適化を有効化。`sizes="(min-width: 768px) 50vw, 100vw"` を付与。
- 実装: [src/app/page.tsx](../../src/app/page.tsx)。
- **H-8（→ 2026-06-23 で対応済）**: 上記統合により思想（concept/about）は**ヒーロー直下から news 下へ移動**したため、「思想が下方」という H-8 の論点はむしろ強まっていた。後述のとおり search preview 直後に薄い CONCEPT 抜粋を差し込み解消。

---

## 修正反映（2026-06-22｜共通不具合 第2弾）

- **C-1（→ 2026-06-23 で方針変更・対応済）**: 当初はナビ残置を意図したが、[uiux_review_ui.md](./uiux_review_ui.md) UI-1/UI-2 と統一し、公開ナビから削除＋本番ビルドで `notFound()` ガードに変更（開発環境では直アクセス可）。
- **C-5（対応済）**: Footer `shopLinks` の TOPS/BOTTOMS/OUTERWEAR/ACCESSORIES を `/item?category=XXX` へ修正。ALL は `/item` のまま（全件表示）。
- **C-8（対応済）**: `globals.css` の `.footer-legal-copy` / `.footer-legal-link` を `text-white/50` → `text-white/70` へ変更。WCAG 1.4.3 コントラスト改善（白黒大画面での実測 4.5:1 達成は背景色次第だが、体感上の可読性は大幅改善）。
- **C-9（対応済）**: ヘッダーの下スクロール時**完全非表示を廃止**し、コンパクト高さ（40–44px）に縮小する挙動へ変更。スクロール上昇時に元の高さ（52–60px）へ復帰。`shadow-sm` を compact 時に付与し境界を明示。`data-header-visible` は常に `"true"` になり、sticky サイドバーの `--site-header-offset` が常に `--site-header-height` になることで整合性向上。
- **C-10（対応済）**: Header/Footer は既に `Providers.tsx` で集約済みで `<main>` ランドマークも存在。追加対応として `<main id="main-content">` と `href="#main-content"` のスキップリンク（`sr-only` / focus 時に可視化）を `Providers.tsx` に追加。

---

## 修正反映（2026-06-23）

- **H-8（対応済）**: SearchHomePreview 直後に、薄い「CONCEPT 抜粋」節を新設（コンセプト一文「時を紡ぐニュートラルモードな日常着」+ 価値訴求一文 + READ OUR STORY → /about、罫線下線で区切る控えめなトーン）。思想を上位に差し込み、ABOUT が下方にあることによる認知遅延を緩和。ヒーローは「名前のみ維持」の H-1 決定を尊重。
- **C-1（方針変更・対応済）**: Header `menuItems` から `/ui` を削除し、`ui/page.tsx` を本番 `notFound()` ガード（[uiux_review_ui.md](./uiux_review_ui.md) UI-1/UI-2 と統一）。
- 実装: [src/app/page.tsx](../../src/app/page.tsx) / [src/components/Header.tsx](../../src/components/Header.tsx) / [src/app/ui/page.tsx](../../src/app/ui/page.tsx)。

---

## 総評（HOME）

- 世界観の方向性（静謐・モノクローム・余白）は**ターゲット適合として正しい**。
- 一方で **「思想・差別化の言語化（H-1/H-7）」「誤字（H-2）」「共通ヘッダ/フッタの機能不全（C-2〜C-7）」** が、コアペルソナの「信頼」軸を直接削いでいる。
- 優先対応: C-2（タップ領域バグ）, C-3（aria）, C-4/C-6（死にリンク）, H-1/H-2 → その後に H-7/C-5。
