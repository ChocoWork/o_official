# NEWS 詳細（/news/[id]）UI/UX レビュー

- 対象: [src/app/news/[id]/page.tsx](../../src/app/news/[id]/page.tsx)
- 共通 Header/Footer は [uiux_review_home.md](./uiux_review_home.md) を参照
- レビュー基準: `implement-uiux` + ブランド適合（[brand.md](../1_RequirementsDifinition/brand.md)）

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| 未対応 | 未着手 |
| 対応中 | 一部対応・設計検討中 |
| 対応済 | 修正完了 |

---

## ペルソナ適合サマリー

brand.md の「透明性（note/blog）」を担う記事ページ。コアペルソナの信頼形成（思想・制作過程）に直結。`max-w-3xl` の可読幅・breadcrumb・前後記事ナビと、**読み物として基本が整っている**。改善は本文の表現力（画像/リッチテキスト）と回遊強化。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| ND-1 | 本文描画（[news/[id]/page.tsx:191-201](../../src/app/news/[id]/page.tsx#L191-L201)） | `detailed_content` を `\n\n` 分割の段落 + `whitespace-pre-line` のみ。見出し/画像/リスト/リンク等のリッチ表現が不可。制作過程の発信に視覚が乗らない。情報設計/ブランド適合 | 記事に画像・小見出し・リンクを持てる本文モデル（軽量Markdown等）を検討 | Mid | 対応済 |
| ND-2 | 本文先頭（[news/[id]/page.tsx:186-202](../../src/app/news/[id]/page.tsx#L186-L202)） | 記事にアイキャッチ画像が無く文字だけで始まる。NEWSは世界観の入口。図と地/対比 | 記事ヘッダーにキービジュアルを配置（任意） | Mid | 対応済 |
| ND-3 | 日付（[news/[id]/page.tsx:171-176](../../src/app/news/[id]/page.tsx#L171-L176)） | `<time dateTime>` 不使用（手動整形）。アクセシビリティ/SEO | `<time>` 化（表示は据え置き） | Low | 対応済 |
| ND-4 | 末尾回遊（[news/[id]/page.tsx:204-349](../../src/app/news/[id]/page.tsx#L204-L349)） | PREV/NEXT + VIEW ALL のみで「関連記事」が無い。回遊・滞在の機会損失 | カテゴリ関連記事の小カードを追加（任意） | Low | 対応済 |
| ND-5 | 共有導線 | 記事の共有（SNS/コピー）が無い。透明性コンテンツの拡散機会損失（IG/TikTok集客の核） | モノトーンの共有ボタンを追加 | Low | 対応済 |
| ND-6 | 本文サイズ（[news/[id]/page.tsx:197](../../src/app/news/[id]/page.tsx#L197)） | 本文 `--lk-size-sm`（≈14px）。読み物としては可読下限ぎりぎり。可読性（部分的逸脱の対象） | 記事本文のみ1段上げ（16px相当）も検討（ラベルは据え置き） | Low | 対応済 |

---

## 良い点（維持）

- `max-w-3xl` で**最適な行長（50–75字）**を確保（implement-uiux Layer 4 準拠）。読み物の基本に忠実。
- breadcrumb（aria-current）、カテゴリを保持した前後記事ナビ、モバイル/デスクトップ別レイアウトが丁寧。
- VIEW ALL を黒ベタの主役ボタンに、PREV/NEXT を控えめテキストにした**対比設計**が適切。

---

## implement-uiux に「あえて従わない」判断

- **記事に派手な装飾を入れない**: 読み物の静けさを保つ。ND-1/ND-2 のリッチ化も「画像と小見出し」程度に留め、過剰なUI部品は足さない。
- 本文16px化（ND-6）は**記事本文に限り推奨**だが、サイト全体のラベル小型方針は維持（部分的逸脱）。

---

## 修正反映（2026-06-23）

- **ND-1**: 軽量 Markdown レンダラー [ArticleBody.tsx](../../src/features/news/components/ArticleBody.tsx) を新設（見出し #/##/###、箇条書き、画像 `![]()`、リンク、強調 `**`/`*`、段落）。生 HTML は描画せず JSX のみ生成（XSS 安全）。`\n\n` 分割の素描画を置換。
- **ND-2**: `image_url` を持つ記事はヘッダー直下に 16:9 のキービジュアル（next/image・`priority`）を表示。
- **ND-3**: 日付を `<time dateTime>` 化（表示据え置き）。関連記事カードの日付も同様。
- **ND-4**: 同カテゴリの関連記事（自身を除く最大3件）を「RELATED」セクションとして末尾に追加。
- **ND-5**: モノトーンの共有ボタン（X / LINE / リンクコピー）汎用クライアントコンポーネント [ShareButtons.tsx](../../src/components/ShareButtons.tsx) を追加（LOOK 詳細と共用）。`getSiteUrl()` で絶対URLを生成。
- **ND-6**: 本文・箇条書きの本文サイズを `--lk-size-sm` → `--lk-size-md`（1段上げ）。ラベル類は据え置き（部分的逸脱方針）。
- 実装: [src/app/news/[id]/page.tsx](../../src/app/news/[id]/page.tsx) / [ArticleBody.tsx](../../src/features/news/components/ArticleBody.tsx) / [ShareButtons.tsx](../../src/components/ShareButtons.tsx)。

---

## 総評（NEWS 詳細）

読み物として完成度が高い。伸ばすなら**本文の表現力（ND-1/ND-2）** で制作過程・思想を“見せ”、信頼形成を強化する方向。
