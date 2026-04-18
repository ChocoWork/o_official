# 1.19 検索ページ（SEARCH）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-SEARCH-001 | `/search?q=` ページは入力キーワードを URL パラメータとして受け取り全コンテンツ（商品・ルック・ニュース）を横断して検索し結果を種別タブで切り替えられるよう表示する（WONT） | — | — | `src/app/search/` ディレクトリ未作成。現フェーズ対象外。E2E は `test.skip` で管理 | 不要 |
| FR-SEARCH-002 | ヘッダーの検索アイコンから検索モーダルまたは検索ページへ遷移し `/?q=` で即時プレビューを表示する（WONT） | — | — | 検索導線の一部は存在するが検索ページと即時プレビューは未実装。現フェーズ対象外。E2E は `test.skip` で管理 | 不要 |
| FR-SEARCH-003 | 商品・ルック・ニュース各エンティティへのフルテキスト検索および結果ハイライトを実装する（WONT） | — | — | Supabase の全文検索インデックス未作成。現フェーズ対象外。E2E は `test.skip` で管理 | 不要 |
| FR-SEARCH-004 | 検索結果ゼロの場合は「○○ の検索結果はありません」メッセージと人気商品の提案を表示する（WONT） | — | — | 現フェーズ対象外。E2E は `test.skip` で管理 | 不要 |
| FR-SEARCH-005 | 検索履歴を `localStorage` に保持し再訪時にサジェストとして表示する（WONT） | — | — | 現フェーズ対象外。E2E は `test.skip` で管理 | 不要 |

---

## 実装タスク管理 (SEARCH-01)

**タスクID**: SEARCH-01  
**ステータス**: 現フェーズ対象外  
**元ファイル**: `docs/tasks/07_search_and_filters_ticket.md`

### チェックリスト

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-SEARCH-001 | 横断検索ページを提供する（WONT） | — | — | `e2e/FR-SEARCH-001-cross-content-search-wont.spec.ts` で対象外を明示 | 不要 |
| FR-SEARCH-002 | 検索導線と即時プレビューを提供する（WONT） | — | — | `e2e/FR-SEARCH-002-search-entry-wont.spec.ts` で対象外を明示 | 不要 |
| FR-SEARCH-003 | フルテキスト検索と結果ハイライトを提供する（WONT） | — | — | `e2e/FR-SEARCH-003-fulltext-highlight-wont.spec.ts` で対象外を明示 | 不要 |
| FR-SEARCH-004 | 検索結果ゼロ時の提案 UI を提供する（WONT） | — | — | `e2e/FR-SEARCH-004-empty-results-wont.spec.ts` で対象外を明示 | 不要 |
| FR-SEARCH-005 | 検索履歴サジェストを提供する（WONT） | — | — | `e2e/FR-SEARCH-005-search-history-wont.spec.ts` で対象外を明示 | 不要 |

---

## TODO（SEARCH-01）

- [x] FR-SEARCH-001: WONT 要件として Playwright 試験 `e2e/FR-SEARCH-001-cross-content-search-wont.spec.ts` を追加する
- [x] FR-SEARCH-002: WONT 要件として Playwright 試験 `e2e/FR-SEARCH-002-search-entry-wont.spec.ts` を追加する
- [x] FR-SEARCH-003: WONT 要件として Playwright 試験 `e2e/FR-SEARCH-003-fulltext-highlight-wont.spec.ts` を追加する
- [x] FR-SEARCH-004: WONT 要件として Playwright 試験 `e2e/FR-SEARCH-004-empty-results-wont.spec.ts` を追加する
- [x] FR-SEARCH-005: WONT 要件として Playwright 試験 `e2e/FR-SEARCH-005-search-history-wont.spec.ts` を追加する

## 修正計画（実装前）

1. 現行フェーズでは検索機能を新規実装しない
2. 詳細設計の実装ステータスは `未` ではなく `不要` に更新し、対象外であることを明示する
3. 要件ごとに `test.skip` の Playwright 試験を追加し、将来対応項目であることを継続的に可視化する

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
| SEARCH-01-001 | `GET /api/search?q=&filters=&sort=&page=` 実装 | IMPL-SEARCH-API-01 | `src/app/api/search/route.ts` | 未実装 | 未 |
| SEARCH-01-002 | `GET /api/suggest?q=` サジェスト API 実装 | IMPL-SEARCH-SUGGEST-01 | `src/app/api/suggest/route.ts` | 未実装 | 未 |
| SEARCH-01-003 | Supabase フルテキスト検索インデックス作成 | IMPL-SEARCH-INDEX-01 | `migrations/` | 未実装 | 未 |
| SEARCH-01-004 | パフォーマンステスト（閾値: 95% < 200ms） | IMPL-SEARCH-PERF-01 | `tests/search/` | 未実装 | 未 |

### 実装ノート

- 初期実装: Supabase の `to_tsvector` / `plainto_tsquery` を使用
- 将来検討: Meilisearch / Algolia（パフォーマンス評価後に案決）
