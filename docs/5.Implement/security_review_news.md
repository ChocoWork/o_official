# news セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/02_news_list.md](../4_DetailDesign/02_news_list.md)
- レビュー対象: `src/app/news/page.tsx`, `src/app/api/news/**`, 関連する news services/storage/migrations
- 実施日: 2026-04-29
- レビュー基準: Secure Coding / OWASP Top 10（A01, A03, A05, A09 を重点）

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

- **High: 1件（Open）**
- **Medium: 4件（Open）**
- **Low: 3件（Open）**
- **Fixed/N/A: 5件**

重点確認した `公開条件 / カテゴリ入力検証 / キャッシュ / 過剰データ返却 / レート制限` のうち、`公開条件（published 制約 + RLS）` と `limit の上限 clamp` は実装済みです。一方で、**レート制限の識別子信頼境界**、**service 境界のカテゴリ検証欠如**、**公開APIのキャッシュ方針未明示**、**一覧用途を超える返却項目**は改善余地があります。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | `x-forwarded-for` / `x-real-ip` を無条件信頼しており、ヘッダ偽装可能な経路では `news:list` のIP制限を回避できる | 信頼済みプロキシ経由時のみ forwarded ヘッダを採用し、それ以外はプラットフォーム提供IPを使用する。`subject`（session/user）併用で多層化する | Open | `getIpFromRequest()` がヘッダ値をそのまま採用。`/api/news` の `enforceRateLimit` 品質に横断影響 | High |
| [src/features/news/services/public.ts](../../src/features/news/services/public.ts), [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | category を service 境界で allowlist 検証せず、`eq('category', options.category)` に直接渡している。SQL Injection は成立しにくいが fail-fast 不足で仕様逸脱入力を許容 | `categories` allowlist か Zod enum を service 入口で共通化し、無効値は reject か `ALL` へ正規化する | Open | `news/page.tsx` は `resolveCategory` を持つ一方、`/api/news` 経由は生文字列を service に渡すため入力検証の一貫性がない | Medium |
| [src/features/news/services/public.ts](../../src/features/news/services/public.ts) | Supabase クエリで `error` を評価せず `data` のみ参照しており、RLS/DB障害時に fail-silent になる | `data` と同時に `error` を必ず評価し、異常時は 5xx で明示。監査/構造化ログに最小限の失敗情報を記録する | Open | `getPublishedNews` / `getPublishedNewsDetailById` / `getPublishedNewsNavigation` で `const { data } = await query` 形式を確認 | Medium |
| [src/app/news/page.tsx](../../src/app/news/page.tsx), [src/features/news/services/public.ts](../../src/features/news/services/public.ts) | `/news` ページは API を経由せず直接 DB 取得するため、`/api/news` のレート制限を回避した高頻度アクセス経路が残る | CDN/WAF で `/news` にもレート制御を設定するか、取得経路を統一して同一制限ポリシーを適用する | Open | `NewsPage` が `getPublishedNews()` を直接呼び出し。`/api/news` の `news:list` 制限はこの経路に適用されない | Medium |
| [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts) | 署名URL生成失敗時に `rawUrl` を返すため、設定崩れ時に内部パス/外部URLをそのまま返す fail-open 動作になる | 署名失敗時は `null` またはプレースホルダへ fail-closed し、必要なら許可ホスト allowlist のみ例外許可する | Open | `signNewsImageUrl()` が `signedUrl ?? rawUrl` を返す。現行 bucket は private だが将来回帰検知を阻害 | Medium |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | 成功レスポンスに `Cache-Control` がなく、署名URL付きデータの保持ポリシーが実行環境依存 | `Cache-Control` を明示（例: `private, no-store` もしくは署名TTLと整合する短寿命）し、共有キャッシュ残留を防ぐ | Open | `NextResponse.json(articles)` でキャッシュヘッダ未指定。レスポンスに signed URL を含む | Medium |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts), [src/features/news/components/PublicNewsGrid.tsx](../../src/features/news/components/PublicNewsGrid.tsx) | 一覧APIが `image_url` を返すが、現行一覧UIは画像を使用せず不要データとなっている（漏えい面とコストの拡大） | 一覧専用DTOを定義し、未使用項目は返却しない。必要な画面だけ明示的に項目追加する | Open | `PublicNewsGrid` は公開日/カテゴリ/タイトル/contentのみ描画。`image_url` は未使用 | Low |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | エラーレスポンスに `Cache-Control: no-store` がなく、中間キャッシュに障害応答が残る可能性 | 4xx/5xx 応答に `Cache-Control: no-store` を付与する | Open | 500系応答は `{ error: 'Failed to fetch news' }` のみ返却でヘッダ未指定 | Low |
| [src/app/news/page.tsx](../../src/app/news/page.tsx), [src/features/news/components/PublicNewsGrid.tsx](../../src/features/news/components/PublicNewsGrid.tsx) | カテゴリ入力検証（allowlist） | 現行の正規化処理を維持 | Fixed | `resolveCategory()` / `parseCategorySelection()` で `categories` allowlist 化し、不正値は `ALL` へフォールバック | Medium |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | 公開APIの件数制御 | 現行の上限 clamp と endpoint 固有制限を維持 | Fixed | `MAX_LIMIT=20` で `limit` を clamp。`news:list` に 60 req / 10分 の制限あり | Medium |
| [migrations/015_add_news_articles_rls.sql](../../migrations/015_add_news_articles_rls.sql), [src/features/news/services/public.ts](../../src/features/news/services/public.ts) | 公開条件（公開済みのみ返却） | `status='published'` 制約と RLS を維持 | Fixed | DB policy が `USING (status = 'published')`、service 側も `.eq('status', 'published')` を適用 | High |
| [migrations/013_create_news_images_bucket.sql](../../migrations/013_create_news_images_bucket.sql) | 画像公開設定 | private bucket 方針を維持 | Fixed | `news-images` は `public=false` で作成され、恒久公開URLを前提にしていない | High |
| [migrations/012_create_news_articles.sql](../../migrations/012_create_news_articles.sql) | カテゴリ列のDB制約 | 現状問題なし（仕様変更時のみ同期要） | N/A | `category` は CHECK 制約で固定値のみ許可。入力値の自由注入はDB層で抑制 | Low |

---

## 重点観点ごとの結論

1. 公開条件: **`status='published'` + RLS で防御できている（Fixed）**
2. カテゴリ入力検証: **UI/RSC は良好だが API/service 境界で未統一（Open）**
3. キャッシュ: **`/api/news` 応答ヘッダ未明示で運用依存（Open）**
4. 過剰データ返却: **一覧で未使用の `image_url` 返却が残存（Open）**
5. レート制限: **実装あり。ただし IP 識別子の信頼境界に課題（Open）**

---

## 推奨対応順序

1. `rateLimit` の IP 信頼境界修正（High）
2. service/API のカテゴリ検証一元化 + DB異常の fail-fast 化（Medium）
3. `/api/news` の `Cache-Control` 明示とエラー応答 no-store 化（Medium/Low）
4. 一覧APIの返却DTO最小化（`image_url` 返却見直し）（Low）

---

## 追加レビュー追記（2026-04-29）

### サマリー

- **High: 0件**
- **Medium: 2件（Open）**
- **Low: 2件（Open）**
- 既存レビューとの差分: 画像署名の trust boundary と API 応答ヘッダ運用、ログ露出面を追加評価

### 追加指摘一覧

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts) | `extractNewsImageObjectPath()` は URL ホストを検証せず、`/storage/v1/object/.../news-images/` というパス断片だけで署名対象パスを抽出する。DB 改ざん等で不正な URL が混入した場合、service role で同一バケット内の任意オブジェクト署名に悪用される余地がある（A01: Broken Access Control / A05: Security Misconfiguration） | 署名前に object path の allowlist（例: `news/` プレフィックス）を適用し、加えて URL 入力は Supabase URL 等の許可ホストのみ解析対象に限定する。拒否時は監査ログへ記録し、null/プレースホルダへフォールバックする | Open | Medium |
| [src/features/news/services/public.ts](../../src/features/news/services/public.ts) | 一覧取得で `createServiceRoleClient()` を毎回生成し画像署名処理を実行するため、失敗時に service role 依存障害がニュース一覧全体の可用性へ波及する（A04: Insecure Design） | 一覧系は署名不要項目を返さない DTO 分離を行い、署名が必要な場合もフェイルクローズ方針と degrade 戦略を明示する。少なくとも service role 初期化失敗時のエラー分類を追加し監視可能にする | Open | Medium |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | 200 応答・500 応答で `Vary` / `Cache-Control` / `X-Content-Type-Options` 等の防御ヘッダ方針が未明示で、環境差によるキャッシュ/解釈ブレを招く（A05: Security Misconfiguration） | API 共通レスポンスヘルパを導入し、`Cache-Control` と `X-Content-Type-Options: nosniff`、必要に応じ `Vary` を統一適用する | Open | Low |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | `console.error('GET /api/news error:', error)` で例外オブジェクトをそのまま記録しており、運用ログ経由で内部情報が過剰露出する可能性がある（A09: Security Logging and Monitoring Failures） | 構造化ログへ置換し、`message` とエラー種別のみ記録する。リクエスト入力やスタック全文を本番ログに直接残さない | Open | Low |

### 追加レビュー結論

1. 既存レビューの High 指摘（IP 識別子信頼境界）は継続して最優先。今回追加では新規 High は確認されなかった。
2. ただし、`news-images` 署名処理は「URLホスト未検証 + object path allowlist 未実装」で trust boundary が広く、将来のデータ改ざんシナリオに対して防御が弱い。
3. `/api/news` は機能上は成立しているが、セキュリティヘッダ/ログ最小化を共通化しない限り、環境依存の設定崩れで情報露出リスクが再発しやすい。

### 追加推奨対応順序

1. `news-images` の署名対象 path/host allowlist 実装（Medium）
2. 一覧取得の service role 依存点を最小化（DTO分離 + 署名対象の明確化）（Medium）
3. `/api/news` の共通セキュリティヘッダ適用とログ最小化（Low）