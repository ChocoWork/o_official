# 1.2 ニュース一覧ページ（NEWS LIST）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-NEWS-ALL-001 | 公開済みニュース記事を最新公開日順で一覧表示する | IMPL-NEWS-LIST-001 | `src/app/news/page.tsx`, `src/features/news/services/public.ts`, `src/features/news/components/PublicNewsGrid.tsx` | `getPublishedNews()` で `published_date` 降順取得、`PublicNewsGrid variant="catalog"` で表示 | 済 |
| FR-NEWS-ALL-002 | ALL / COLLECTION / EVENT / COLLABORATION / SUSTAINABILITY / STORE / BLOG のカテゴリ絞り込みを提供する | IMPL-NEWS-LIST-002 | `src/features/news/components/PublicNewsGrid.tsx` | カテゴリタブ UI をクライアント側に実装し、選択カテゴリに応じて記事をフィルタリング | 済 |
| FR-NEWS-ALL-003 | カテゴリ選択を URL の `category` クエリパラメータに反映し共有可能な状態にする | IMPL-NEWS-LIST-003 | `src/app/news/page.tsx`, `src/features/news/components/PublicNewsGrid.tsx` | `news/page.tsx` で `searchParams` を `await` しているが抽出値を `getPublishedNews()` に渡していない。`PublicNewsGrid` は `useRouter` 未使用で URL 同期が未実装 | 未 |
| FR-NEWS-ALL-004 | 記事カードは公開日・カテゴリ・タイトル・概要を表示しクリックで詳細ページへ遷移する | IMPL-NEWS-LIST-004 | `src/features/news/components/PublicNewsGrid.tsx` | 一覧行に公開日・カテゴリタグ・タイトルを表示しリンクで詳細へ遷移 | 済 |
| FR-NEWS-ALL-005 | サーバ側カテゴリ絞り込みを実装し DB レベルでフィルタリングする | IMPL-NEWS-LIST-005 | `src/app/news/page.tsx`, `src/features/news/services/public.ts` | `getPublishedNews()` はオプショナルな `category` パラメータをサポートするが、`news/page.tsx` がそれを渡していない | 未 |
| FR-NEWS-ALL-006 | ニュース一覧ページに `generateMetadata` を実装し `title` / `description` を設定する | IMPL-NEWS-LIST-006 | `src/app/news/page.tsx` | `generateMetadata` エクスポートが存在しない | 未 |
| FR-NEWS-ALL-007 | カテゴリ変化を URL で保持しブラウザ戻るで絞り込み状態を復元する | IMPL-NEWS-LIST-007 | `src/app/news/page.tsx`, `src/features/news/components/PublicNewsGrid.tsx` | FR-NEWS-ALL-003・005 の未実装に起因。URL 同期がないためブラウザバック時に絞り込み状態が失われる | 未 |
