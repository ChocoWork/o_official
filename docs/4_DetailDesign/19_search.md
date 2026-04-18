# 1.19 検索ページ（SEARCH）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-SEARCH-001 | `/search?q=` ページは入力キーワードを URL パラメータとして受け取り全コンテンツ（商品・ルック・ニュース）を横断して検索し結果を種別タブで切り替えられるよう表示する | IMPL-SEARCH-001 | `src/app/search/page.tsx`, `src/features/search/components/SearchPageClient.tsx`, `src/app/api/search/route.ts` | `q` / `tab` を URL 同期し、ALL / ITEM / LOOK / NEWS タブで検索結果を切り替える横断検索ページを実装 | 済 |
| FR-SEARCH-002 | ヘッダーの検索アイコンから検索モーダルまたは検索ページへ遷移し `/?q=` で即時プレビューを表示する | IMPL-SEARCH-002 | `src/components/Header.tsx`, `src/app/page.tsx`, `src/features/search/components/SearchHomePreview.tsx` | ヘッダー検索アイコンから `/search` へ遷移し、ホームの `/?q=` では検索プレビューを即時表示する | 済 |
| FR-SEARCH-003 | 商品・ルック・ニュース各エンティティへのフルテキスト検索および結果ハイライトを実装する | IMPL-SEARCH-003 | `src/app/api/search/route.ts`, `src/app/api/suggest/route.ts`, `src/features/search/services/search.service.ts`, `src/features/search/components/SearchPageClient.tsx` | DB 側の部分一致検索で商品・ルック・ニュースを横断検索し、UI では一致箇所を `mark` でハイライト表示する | 済 |
| FR-SEARCH-004 | 検索結果ゼロの場合は「○○ の検索結果はありません」メッセージと人気商品の提案を表示する | IMPL-SEARCH-004 | `src/features/search/components/SearchPageClient.tsx` | ゼロ件時に検索語付きメッセージと popular items セクションを表示する | 済 |
| FR-SEARCH-005 | 検索履歴を `localStorage` に保持し再訪時にサジェストとして表示する | IMPL-SEARCH-005 | `src/features/search/components/SearchPageClient.tsx`, `src/app/api/suggest/route.ts` | `search.history` を保持し、再訪時の履歴候補と入力中のサジェスト候補を表示する | 済 |

---

## 実装タスク管理 (SEARCH-01)

**タスクID**: SEARCH-01  
**ステータス**: 一部実装済  
**元ファイル**: `docs/tasks/07_search_and_filters_ticket.md`

### チェックリスト

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-SEARCH-001 | 横断検索ページを提供する | IMPL-SEARCH-001 | `src/app/search/page.tsx`, `src/features/search/components/SearchPageClient.tsx`, `e2e/FR-SEARCH-001-cross-content-search.spec.ts` | `/search` ルートとタブ切り替え UI を実装 | 済 |
| FR-SEARCH-002 | 検索導線と即時プレビューを提供する | IMPL-SEARCH-002 | `src/components/Header.tsx`, `src/app/page.tsx`, `src/features/search/components/SearchHomePreview.tsx`, `e2e/FR-SEARCH-002-search-entry-preview.spec.ts` | ヘッダー導線とホームの即時プレビューを実装 | 済 |
| FR-SEARCH-003 | フルテキスト検索と結果ハイライトを提供する | IMPL-SEARCH-003 | `src/app/api/search/route.ts`, `src/app/api/suggest/route.ts`, `src/features/search/services/search.service.ts`, `e2e/FR-SEARCH-003-fulltext-highlight.spec.ts` | DB 側検索 API と一致箇所のハイライトを実装 | 済 |
| FR-SEARCH-004 | 検索結果ゼロ時の提案 UI を提供する | IMPL-SEARCH-004 | `src/features/search/components/SearchPageClient.tsx`, `e2e/FR-SEARCH-004-empty-results.spec.ts` | ゼロ件メッセージと人気商品提案を実装 | 済 |
| FR-SEARCH-005 | 検索履歴サジェストを提供する | IMPL-SEARCH-005 | `src/features/search/components/SearchPageClient.tsx`, `src/app/api/suggest/route.ts`, `e2e/FR-SEARCH-005-search-history.spec.ts` | localStorage 履歴とサジェスト表示を実装 | 済 |

---

## TODO（SEARCH-01）

- [x] FR-SEARCH-001: Playwright 試験 `e2e/FR-SEARCH-001-cross-content-search.spec.ts` を追加する
- [x] FR-SEARCH-002: Playwright 試験 `e2e/FR-SEARCH-002-search-entry-preview.spec.ts` を追加する
- [x] FR-SEARCH-003: Playwright 試験 `e2e/FR-SEARCH-003-fulltext-highlight.spec.ts` を追加する
- [x] FR-SEARCH-004: Playwright 試験 `e2e/FR-SEARCH-004-empty-results.spec.ts` を追加する
- [x] FR-SEARCH-005: Playwright 試験 `e2e/FR-SEARCH-005-search-history.spec.ts` を追加する
- [x] SEARCH-01-001: `/api/search` を実装する
- [x] SEARCH-01-002: `/api/suggest` を実装する
- [x] SEARCH-01-003: 検索用インデックス migration を追加する
- [ ] SEARCH-01-004: 検索 API の P95 < 200ms を満たす最適化を完了する

## 修正計画（実装前）

1. `/search` ルートと `api/search` / `api/suggest` を追加し、URL 同期の横断検索を実装する
2. ヘッダー導線とホームの `/?q=` プレビューを接続する
3. 要件単位の Playwright を追加して、検索結果・即時プレビュー・ハイライト・ゼロ件・履歴保持を検証する

---

## 検索アーキテクチャ（SEARCH-ARCH）

| 項目 | 内容 |
|---|---|
| プライマリバックエンド | Supabase フルテキスト検索（`tsvector` + `GIN インデックス`） |
| スケールアップ候補 | Meilisearch / Algolia（需要増加時に検討） |
| Source of Truth | DB（在庫情報・商品データ）。検索インデックスは非同期更新のため在庫表示は参考値 |
| 在庫チェック | 注文フローでは必ず DB で検証する（インデックスの在庫情報は参照不可） |

---

## API 仕様（SEARCH-API）

| エンドポイント | メソッド | 概要 | 主なパラメータ |
|---|---|---|---|
| `/api/search` | GET | フルテキスト + フィルタ検索 | `q`, `filters`, `sort`, `page` |
| `/api/suggest` | GET | クエリ補完・サジェスト | `q` |

- NFR: 検索応答 P95 < 200ms
- 不正クエリ（過長・禁止文字）は 400 を返す

---

## インデックス整合性・夜次リコンシリエーション（SEARCH-RECONCILE）

1. 集計ジョブを実行し、検索インデックスの在庫値と DB の在庫値を照合する。
2. 差分リストを生成し、しきい値（差分が在庫の 1% 超 または absolute 10 個超）を超える場合は自動修正候補としてマーク。
3. 自動修正前に最新注文ログと reservation ログを参照し、訂正が安全かを確認する。
4. 手動レビューが必要なケースはオペレータにタスクを作成し、完了後にインデックスを再構築する。

> インデックス更新遅延により在庫が不一致だった場合は、注文時にユーザへ明示的にエラー/案内を表示すること。
| SEARCH-01-001 | `GET /api/search?q=&filters=&sort=&page=` 実装 | IMPL-SEARCH-API-01 | `src/app/api/search/route.ts`, `src/features/search/services/search.service.ts` | 横断検索 API を実装。`q` / `tab` / `preview` を受け取り結果と popular items を返す | 済 |
| SEARCH-01-002 | `GET /api/suggest?q=` サジェスト API 実装 | IMPL-SEARCH-SUGGEST-01 | `src/app/api/suggest/route.ts`, `src/features/search/services/search.service.ts` | 部分一致に基づくサジェスト API を実装 | 済 |
| SEARCH-01-003 | Supabase フルテキスト検索インデックス作成 | IMPL-SEARCH-INDEX-01 | `migrations/032_create_search_indexes.sql` | items / looks / news_articles 向け GIN インデックス migration を追加 | 済 |
| SEARCH-01-004 | パフォーマンステスト（閾値: 95% < 200ms） | IMPL-SEARCH-PERF-01 | `e2e/SEARCH-01-004-search-api-performance.spec.ts` | 性能試験を追加したが、現行ローカル環境では閾値未達のため `fixme` 管理 | 未 |

### 実装ノート

- 現行実装: `ilike` ベースの DB 検索 API と UI ハイライトを採用
- 追加済み migration: `migrations/032_create_search_indexes.sql`
- 将来検討: `to_tsvector` / `plainto_tsquery` への切り替え、または Meilisearch / Algolia の導入
