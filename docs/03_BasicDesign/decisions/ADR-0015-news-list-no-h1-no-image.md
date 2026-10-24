# ADR-0015 NEWS の一覧に h1 の見出しと記事の画像を出さない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/news/page.tsx`、`src/features/news/components/PublicNewsGrid.tsx` | 基準コミット: `a03beaff`

## 概要

NEWS の一覧のページには「NEWS」の h1 を置かず、記事カードに画像を出さない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | FREQ-31-REQ-01、FREQ-32-REQ-01 |
| 対象のコード | `src/app/news/page.tsx`、`src/features/news/components/PublicNewsGrid.tsx` |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-31・32）、`docs/05_Quality/reviews/uiux/uiux_review_news.md`、`e2e/FR-NEWS-ALL-012-no-page-title.spec.ts`、`e2e/FR-NEWS-ALL-013-no-card-image.spec.ts` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0015 NEWS の一覧に h1 の見出しと記事の画像を出さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-31-REQ-01、FREQ-32-REQ-01 |
| 根拠 | 一覧に見出しも画像も置かない（FREQ-31・32）。その理由は要件に書かれておらず、フィルターと文字の記事だけの静かな並びで見せたいため、と推定する。uiux のレビューも、サムネイルの無い文字が主の一覧はエディトリアルの表し方として妥当とした |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`、`docs/05_Quality/reviews/uiux/uiux_review_news.md`、git `fa4f79b5`（2026-06-24） |

#### 背景

uiux のレビューは、一覧に h1「NEWS」を足す案（N-1）と、画像のある記事に小さなサムネイルを出す案（N-4）を出し、「対応済」と書いた。その後のユーザーの依頼で、どちらも出さないと決めた（推定。どちらが後かの記録は無い）。

#### 決定

- 一覧のページと部品に `<h1>` を置かない（`src/app/news/page.tsx`）
- 記事カードは `image_url` を描かない（`PublicNewsGrid.tsx`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 一覧に h1「NEWS」を足す（uiux N-1） | FREQ-31 で打ち消した（推定） |
| 画像のある記事に小さなサムネイルを出す（uiux N-4） | FREQ-32 で打ち消した。レビューも必須ではないとした |

#### 結果

- 良くなること: 一覧が文字だけの落ち着いた並びになる
- 悪くなること: ページに h1 が無いので、読み上げの見出しの移動でページの頭が分かりにくい（推定）
- 食い違い: uiux のレビューは N-1・N-4 を「対応済」と書いたまま
- 画像を出さないのに署名している（ADR-0001・0004）

## 未確認事項

- 無し
