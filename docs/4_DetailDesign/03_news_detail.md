# 1.3 ニュース詳細ページ（NEWS DETAIL）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-NEWS-DETAIL-001 | 公開済みニュース記事の詳細ページを表示する | IMPL-NEWS-DETAIL-001 | `src/app/news/[id]/page.tsx` | RSC で `getPublishedNewsDetailById` を呼び出し。存在しない場合は `notFound()` | 済 |
| FR-NEWS-DETAIL-002 | タイトル・公開日・カテゴリタグ・本文を掲載する | IMPL-NEWS-DETAIL-002 | `src/app/news/[id]/page.tsx` | `h1` にタイトル、`TagLabel` にカテゴリ、`published_date` 表示。`detailed_content` を段落分割して `<p>` タグでレンダリング | 済 |
| FR-NEWS-DETAIL-003 | 前後の記事へのナビゲーションとニュース一覧ページへの遷移を提供する | IMPL-NEWS-DETAIL-003 | `src/app/news/[id]/page.tsx`, `src/features/news/services/public.ts` | `getPublishedNewsNavigation` で前後記事リンクを表示。"VIEW ALL" ボタンで一覧へ遷移 | 済 |
| FR-NEWS-DETAIL-004 | `category` クエリパラメータが指定されている場合は同カテゴリ内の前後記事を辿れるようにし無効なカテゴリは ALL として扱う | IMPL-NEWS-DETAIL-004 | `src/app/news/[id]/page.tsx` | `searchParams.category` を取得・検証後に `getPublishedNewsNavigation` へ渡す。無効値は ALL にフォールバック | 済 |
| FR-NEWS-DETAIL-005 | `generateMetadata` で `title` / `description` のメタ情報を設定する | IMPL-NEWS-DETAIL-005 | `src/app/news/[id]/page.tsx` | `generateMetadata` を追加し記事タイトルと本文要約を反映 | 済 |
| FR-NEWS-DETAIL-006 | パンくずまたはカテゴリリンクを提供し現在位置の把握とカテゴリ内移動を容易にする | IMPL-NEWS-DETAIL-006 | `src/app/news/[id]/page.tsx` | パンくず（NEWS > CATEGORY > 現在記事）とカテゴリリンクを追加 | 済 |
| FR-NEWS-DETAIL-007 | 前後リンクに `aria-label` などのアクセシビリティ属性を付与する | IMPL-NEWS-DETAIL-007 | `src/app/news/[id]/page.tsx` | PREV/NEXT リンクに遷移先タイトルを含む `aria-label` を追加 | 済 |
| FR-NEWS-DETAIL-008 | 本文はアクセシビリティ対応を考慮して段落・改行を適切にレンダリングする | IMPL-NEWS-DETAIL-008 | `src/app/news/[id]/page.tsx` | `detailed_content.split("\n\n").map(paragraph => <p>)` で段落分割。`whitespace-pre-line` クラスで改行保持 | 済 |
