# ADR-0011 記事の本文は React の文字として出し、HTML として解釈させない

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/news/[id]/page.tsx`、`src/features/news/components/PublicNewsGrid.tsx` | 基準コミット: `a03beaff`

## 概要

詳細の本文は空行で段落に分けて文字として出し、一覧の概要も文字で出す。HTML を差し込む書き方は使わない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | SEC-NEWS-013、FR-NEWS-DETAIL-008 |
| 対象のコード | `src/app/news/[id]/page.tsx`、`src/features/news/components/PublicNewsGrid.tsx`、`src/features/news/components/ArticleBody.tsx` |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-news-id-security-review.md`、`docs/05_Quality/reviews/security/security_review_news.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0011 記事の本文は React の文字として出し、HTML として解釈させない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-013、FR-NEWS-DETAIL-008 |
| 根拠 | 管理で書いた本文を HTML として出すと、保存された XSS の入口になるため、文字のまま出す。リッチテキストの HTML を出す形に変える時はもう一度見直す（2026-04-18 のレビューの残りの危険） |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-news-id-security-review.md`、`docs/05_Quality/reviews/security/security_review_news.md` |

#### 背景

本文（`detailed_content`）は管理の画面から自由な文字で入る。

#### 決定

- 詳細は `detailed_content` を `\n\n` で段落に分け、段落ごとに `<p>` の文字として出す（`src/app/news/[id]/page.tsx`）
- 一覧の概要も文字として出す（`PublicNewsGrid.tsx`）
- `dangerouslySetInnerHTML` は範囲のコードのどこにも無い

#### 退けた案

記録なし

#### 結果

- 良くなること: 本文に HTML の印を書いても文字として出る
- 悪くなること: 本文に Markdown を書くと詳細では記号のまま出る。一覧の概要は記号を外す（DRV-NEWS-004）
- 食い違い: uiux のレビューは本文を軽い Markdown（`ArticleBody.tsx`）で出す形を「対応済」と書くが、`ArticleBody` はどこからも使われていない。つなぐ時はリンク・画像の URL の種類を絞る必要がある（`ArticleBody.tsx`）
- 見直す条件: リッチテキスト・Markdown を出す時

## 未確認事項

- 無し
