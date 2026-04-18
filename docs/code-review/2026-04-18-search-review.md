# Code Review: Search Page

Ready for Production: No
Critical Issues: 4

## Review Plan

1. Pass 1: フロントエンド、クエリ反映、ハイライト表示、XSS
2. Pass 2: API、バックエンド、入力検証、認可、レート制限、列挙耐性
3. Pass 3: DB、RLS、検索インデックス、情報露出、監査

## Related Files

- src/app/search/page.tsx
- src/features/search/components/SearchPageClient.tsx
- src/features/search/components/SearchHomePreview.tsx
- src/features/search/services/search.service.ts
- src/features/search/types/search.types.ts
- src/app/api/search/route.ts
- src/app/api/suggest/route.ts
- src/app/page.tsx
- src/components/Header.tsx
- src/lib/supabase/server.ts
- src/features/auth/middleware/rateLimit.ts
- src/lib/audit.ts
- migrations/015_add_news_articles_rls.sql
- migrations/016_create_items_and_item_images_bucket.sql
- migrations/018_create_looks_and_look_images_bucket.sql
- migrations/019_add_public_select_policy_to_look_items.sql
- migrations/032_create_search_indexes.sql
- docs/4_DetailDesign/19_search.md

## Priority 1 (Must Fix) ⛔

### 1. Search requests leak cookie and token fragments into server logs
- Files: src/lib/supabase/server.ts, src/app/api/search/route.ts, src/app/api/suggest/route.ts
- Issue: 検索 API 経由で `createClient()` が呼ばれるたびに Cookie ヘッダ先頭や認証 Cookie の生値・デコード値断片を `console.log` へ出力します。
- Why this matters: セッショントークン断片や Cookie 情報がログ基盤、運用者端末、外部ログ転送先へ流出します。search は未認証でも高頻度に叩かれるため露出面積が大きいです。
- Suggested fix: 認証ヘッダ・Cookie 値のログ出力を削除し、必要なら開発限定でキー名のみを出す。機密値は常に完全マスクする。

### 2. Search query is interpolated into raw PostgREST filter grammar
- Files: src/features/search/services/search.service.ts
- Issue: `.or(...)` にユーザー入力由来の `likePattern` をそのまま連結しています。`buildLikePattern()` は `%` と `_` しか除去せず、`,` `)` など PostgREST フィルタ構文に意味を持つ文字を遮断していません。
- Why this matters: SQL injection ではないものの、フィルタ構文注入により検索条件の改変、意図しない広範囲検索、エラーベースの挙動観測を許します。列挙耐性も下がります。
- Suggested fix: 生の `.or(...)` 文字列組み立てをやめ、RPC/SQL 関数へパラメータとして渡すか、`websearch_to_tsquery` / `plainto_tsquery` ベースの検索へ切り替える。少なくとも許可文字方式でクエリを制限し、PostgREST の予約記号を拒否する。

## Important Issues

### 3. Search and suggest APIs have no throttling or abuse telemetry
- Files: src/app/api/search/route.ts, src/app/api/suggest/route.ts
- Issue: 既存の `enforceRateLimit()` と `logAudit()` 基盤があるにもかかわらず、search/suggest では未適用です。
- Why this matters: 未認証エンドポイントとしてスクレイピング、語彙列挙、人気ワード推測、負荷試行を低コストで繰り返せます。Pass 2 の列挙耐性と Pass 3 の監査要件を満たしていません。
- Suggested fix: IP ベースと必要に応じて subject ベースのレート制限を追加し、429 応答を返す。超過、異常頻度、バリデーション失敗は監査ログまたは alert webhook に送る。

### 4. API validation does not enforce the spec’s forbidden-character rule
- Files: src/app/api/search/route.ts, src/app/api/suggest/route.ts, docs/4_DetailDesign/19_search.md
- Issue: Zod 検証は `trim()` と `max(100)` のみで、仕様にある「過長・禁止文字は 400」を満たしていません。制御文字やフィルタ構文記号を拒否していません。
- Why this matters: Pass 1/2 での XSS 防止自体は React の自動エスケープで保たれている一方、バックエンド側では不正文字を許したまま検索層へ渡しており、構文注入・ログ汚染・異常負荷の入口になります。
- Suggested fix: `q` に対して許可文字セット、最小長、連続空白、制御文字拒否を明示したスキーマを追加し、禁止文字は 400 で即時拒否する。

## Residual Risk

- Pass 1 では `dangerouslySetInnerHTML` や生 HTML 挿入は見当たらず、検索語ハイライトも React ノード分割で実装されているため、即時に悪用可能な XSS は確認していません。
- DB 側の RLS は items / looks / news_articles とも `published` の公開条件があり、search API が service role を直接使っていない点は妥当です。ただし API 側の入力制御と abuse 対策が弱いため、公開データの大量収集リスクは残ります。