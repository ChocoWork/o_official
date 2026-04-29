# search セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/19_search.md](../4_DetailDesign/19_search.md)
- レビュー対象: `src/app/search/page.tsx`, `src/app/api/search/**`, `src/app/api/suggest/route.ts`, `src/features/search/**`, 関連 `migrations/*search*.sql` および公開/RLS 関連 migration
- 実施日: 2026-04-29
- レビュー基準: Secure Coding / OWASP Top 10（A01, A03, A05 を重点）

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| Open | 未修正 |
| Partially Fixed | 一部レイヤのみ対処済み |
| Fixed | 修正済み |
| N/A | 現時点で問題なし |

---

## サマリー

- **High: 1件（Open 1）**
- **Medium: 3件（Open 3）**
- **Low: 3件（Open 2 / Fixed 1）**
- **Fixed/N/A: 5件**

重点確認した `SQL/全文検索インジェクション耐性 / private コンテンツ露出 / レート制限 / キャッシュ / クエリ露出` のうち、`SQL/全文検索インジェクション耐性` と `private コンテンツ露出（published 制約）` は現行実装で防御できています。一方で、**レート制限の識別子信頼境界** と **検索 API のキャッシュ/クエリ露出制御** は未対処です。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | `x-forwarded-for` / `x-real-ip` を無条件信頼しており、クライアントがヘッダを偽装できる経路ではレート制限回避が可能 | 信頼プロキシ配下でのみ `x-forwarded-for` を採用し、それ以外は実接続IPを使用。公開APIでも `subject`（セッションID等）を併用し多層制限にする | Open | `getIpFromRequest()` が受信ヘッダ値をそのまま採用。`search:public` / `search:preview` / `suggest:public` に横断影響 | High |
| [src/app/api/search/route.ts](../../src/app/api/search/route.ts) | 検索語を含むレスポンスに `Cache-Control` がないため、中間キャッシュでクエリ情報が保持される余地がある | `Cache-Control: private, no-store` を明示し、検索語・結果の共有キャッシュ保持を抑止する | Open | 成功時ヘッダは `x-search-duration-ms` のみ。キャッシュ方針が未宣言 | Medium |
| [src/app/api/suggest/route.ts](../../src/app/api/suggest/route.ts) | サジェスト応答にも `Cache-Control` がなく、入力途中のクエリ断片がキャッシュ経由で残る可能性がある | `Cache-Control: private, no-store` を明示する | Open | `GET /api/suggest` の成功レスポンスでキャッシュ制御ヘッダ未設定 | Medium |
| [src/app/search/page.tsx](../../src/app/search/page.tsx), [src/features/search/components/SearchPageClient.tsx](../../src/features/search/components/SearchPageClient.tsx) | 仕様どおり `q` を URL クエリに保持する設計のため、検索語がブラウザ履歴・参照元ヘッダ等に露出しうる | 個人情報検索を禁止する利用規約と UI 注意喚起を追加。必要に応じ POST 検索モード（履歴非保持）を別途提供する | Open | 現行は `/search?q=` 同期が必須仕様。機能要件上の設計トレードオフとして情報露出面の残余リスクあり | Medium |
| [src/app/api/search/route.ts](../../src/app/api/search/route.ts) | 不正クエリの拒否が最大長中心で、`suggest` 側より入力制約が緩い（境界防御の不一致） | `suggest` と同等の禁止制御文字チェックを `search` にも適用し、入力境界の一貫性を確保する | Open | `q` は `trim().max(100)` のみ。SQL注入耐性は別層で確保されているが API 境界の厳格性に差分あり | Low |
| [src/features/search/components/SearchPageClient.tsx](../../src/features/search/components/SearchPageClient.tsx) | `search.history` を平文で localStorage 保存しており、共有端末で検索語が残存する | 設定で履歴保存無効化を可能にするか、短期TTL・明示削除UIを提供する | Open | XSS 前提がなければ直接侵害ではないが、端末共有時のプライバシー漏えいリスクは残る | Low |
| [src/app/api/search/route.ts](../../src/app/api/search/route.ts) | `x-search-duration-ms` の露出は内部性能情報の外部化にあたる | 本番では除去するか、粗いレンジ値（例: fast/normal/slow）へ丸める | Open | 直接機密漏えいではないが、観測情報を攻撃者へ与える可能性がある | Low |
| [src/features/search/services/search.service.ts](../../src/features/search/services/search.service.ts), [migrations/048_create_search_rpc_functions.sql](../../migrations/048_create_search_rpc_functions.sql) | SQL/全文検索インジェクション | RPC 引数バインド + SQL 内エスケープ方針を維持する | Fixed | 文字列連結フィルタではなく `search_items/search_looks/search_news` RPC へバインド引数で渡し、`%`/`_` を SQL 側でエスケープ | High |
| [migrations/048_create_search_rpc_functions.sql](../../migrations/048_create_search_rpc_functions.sql), [migrations/016_create_items_and_item_images_bucket.sql](../../migrations/016_create_items_and_item_images_bucket.sql), [migrations/018_create_looks_and_look_images_bucket.sql](../../migrations/018_create_looks_and_look_images_bucket.sql), [migrations/015_add_news_articles_rls.sql](../../migrations/015_add_news_articles_rls.sql) | private コンテンツ露出 | `status='published'` 制約と RLS を継続し、検索関数は `SECURITY INVOKER` を維持する | Fixed | 検索RPCは各テーブルで `status = 'published'` を強制。RLSポリシーも公開SELECTを published 限定に設定 | High |
| [src/app/api/search/route.ts](../../src/app/api/search/route.ts), [src/app/api/suggest/route.ts](../../src/app/api/suggest/route.ts), [src/features/auth/ratelimit/index.ts](../../src/features/auth/ratelimit/index.ts), [migrations/005_create_rate_limit_counters.sql](../../migrations/005_create_rate_limit_counters.sql) | レート制限自体の欠如 | 既存の 429 制御と DB 原子的カウンタを維持する | Fixed | `enforceRateLimit()` と `increment_rate_limit_counter` で API 境界の制限は実装済み | Medium |
| [migrations/032_create_search_indexes.sql](../../migrations/032_create_search_indexes.sql) | 検索性能劣化による DoS 耐性低下 | GIN インデックスの維持と、将来的な FTS 最適化を継続する | N/A | items/looks/news の検索用インデックスが作成済みで、全表走査のリスクを軽減 | Low |

---

## 重点観点ごとの結論

1. SQL/全文検索インジェクション耐性: **現状は対策済み（Fixed）**
2. private コンテンツ露出: **published 制約 + RLS + SECURITY INVOKER で概ね防止（Fixed）**
3. レート制限: **制限機構は実装済みだが、IP 識別子の信頼境界に課題（Open）**
4. キャッシュ: **検索/サジェスト API の `Cache-Control` 未指定が残課題（Open）**
5. クエリ露出: **`/search?q=` 設計起因の残余リスクと API 応答露出（Open）**

---

## 推奨対応順序

1. `rateLimit` の IP 信頼境界修正（High）
2. `/api/search` と `/api/suggest` の `Cache-Control: private, no-store` 明示（Medium）
3. `q` の URL 露出リスクに対する運用/UX ガード（PII 禁止明示、履歴レスモード検討）（Medium）
4. `search` API の入力制約を `suggest` と同等化（Low）
5. `localStorage` 検索履歴の保持方針（TTL/無効化/削除UI）を導入（Low）

---

## 追加レビュー追記（2026-04-29 / 2nd pass）

### サマリー

- High: 0件
- Medium: 2件（Open）
- Low: 1件（Open）
- 既存レビューとの差分: URL クエリ露出に対するブラウザ制御不足、ログ情報の機微露出、サジェスト連打時の負荷増幅リスクを追加

### 追加指摘一覧

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/search/page.tsx](../../src/app/search/page.tsx), [src/features/search/components/SearchPageClient.tsx](../../src/features/search/components/SearchPageClient.tsx) | `q` を URL 保持する仕様に対し、`Referrer-Policy` の明示制御がない。外部オリジンへ遷移・外部リソース取得時に参照元URL（`/search?q=...`）が送信される余地がある（A01/A05） | 検索ページ応答に `Referrer-Policy: strict-origin-when-cross-origin` または `no-referrer` を適用し、クエリ文字列の外部送信を抑止する。要件次第で `<meta name="referrer">` も併用する | Open | Medium |
| [src/app/api/search/route.ts](../../src/app/api/search/route.ts), [src/app/api/suggest/route.ts](../../src/app/api/suggest/route.ts), [src/features/search/services/search.service.ts](../../src/features/search/services/search.service.ts) | 例外時に `console.error(..., error)` で raw error を出力しており、実行環境によっては検索語や SQL 実行情報がログへ残る可能性（A09: Security Logging and Monitoring Failures） | 外部公開ログは構造化して最小化し、`query` や SQL 由来詳細をマスクする。内部監査ログにのみ相関ID付き詳細を記録する | Open | Medium |
| [src/features/search/components/SearchPageClient.tsx](../../src/features/search/components/SearchPageClient.tsx) | 入力ごとに `/api/suggest` を即時呼び出しし、デバウンス/最小入力長がないため、Bot や自動入力で容易に高頻度アクセスを発生できる（A04: Insecure Design、可用性リスク） | 250-400ms のデバウンス、最小入力長（例: 2文字）導入、同一値再送の抑止を追加し、サーバー側 429 と組み合わせて防御を二層化する | Open | Low |

### 重点結論

1. 既存レビューで指摘済みの `rateLimit` 信頼境界と `Cache-Control` 未指定は引き続き優先度高。
2. 今回の追加差分では、URL クエリ露出を運用注意だけでなく技術制御（`Referrer-Policy`）に落とし込む必要を確認。
3. 検索失敗ログの最小化と、サジェスト連打に対するクライアント側抑制を実装すると、プライバシー/可用性の残余リスクを同時に下げられる。

### 推奨対応順序（追加分）

1. 検索ページの `Referrer-Policy` 制御導入（Medium）
2. 検索系 API/Service の raw error ログ最小化（Medium）
3. サジェスト呼び出しにデバウンス＋最小入力長を導入（Low）