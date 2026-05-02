# news_id セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/03_news_detail.md](../4_DetailDesign/03_news_detail.md)
- レビュー対象: `src/app/news/[id]/**`, `src/app/api/news/**`, 関連 `services/storage/migrations`
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

- **High: 1件（Open）**
- **Medium: 2件（Open）**
- **Low: 3件（Open）**
- **Fixed/N/A: 6件**

重点確認した `private news 露出 / slug-id 検証 / 画像 URL / XSS / キャッシュ / レート制限` のうち、`private news 露出` と `画像バケット公開設定` は防御できています。一方で、**レート制限の識別子信頼境界**、**レスポンスキャッシュ方針の未明示**、**[id] 入力検証の未統一** は未対処です。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | `x-forwarded-for` / `x-real-ip` を無条件信頼しており、ヘッダ偽装可能な経路では `news:list` のIP制限を回避できる | 信頼プロキシ配下のみ転送ヘッダを採用し、未信頼経路はプラットフォーム由来IPに固定。加えて subject（session/user）併用制限を導入 | Open | `getIpFromRequest()` がヘッダ値先頭をそのまま採用。`/api/news` でも同実装を使用 | High |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | 公開APIレスポンスに `Cache-Control` がなく、署名URLを含むレスポンスが共有キャッシュに保持されるリスクがある | `Cache-Control: private, no-store` などを明示し、署名URLのTTLと整合するキャッシュ方針を固定 | Open | `NextResponse.json(articles)` のみでキャッシュヘッダ未設定 | Medium |
| [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts) | 署名URL生成失敗時に `rawUrl` をそのまま返すため、想定外の外部URLが保存されるとそのまま公開レスポンスに流れる | 失敗時は `null` を返すか、`news-images` バケット配下パスのみ許可する厳格バリデーションを追加 | Open | `signNewsImageUrl()` で `signedUrl ?? rawUrl` を返却 | Medium |
| [src/app/news/[id]/page.tsx](../../src/app/news/[id]/page.tsx) | `[id]` を未検証で `getPublishedNewsDetailById()` に渡しており、フェイルファスト不十分 | `z.coerce.number().int().positive()` などで早期検証し、不正値は即 `notFound()` | Open | `params.id` は文字列のまま利用。DB側で結果的に弾かれるが境界検証不統一 | Low |
| [src/features/news/services/public.ts](../../src/features/news/services/public.ts) | `getPublishedNewsDetailById()` が `id: string` をそのままクエリ投入し、型境界での明示検証がない | サービス層でもID正規化（数値化）または検証済み型を受ける設計に変更 | Open | SQLインジェクションには該当しないが入力検証レイヤが弱い | Low |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | `category` は未検証のままサービスに渡されるため、不要なクエリ試行と観測ノイズが増える | allowlist（`categories`）で検証し、無効値は400またはALLフォールバックへ統一 | Open | 直接脆弱性ではないが入力境界が曖昧 | Low |
| [src/features/news/services/public.ts](../../src/features/news/services/public.ts) | private news 露出 | `status = 'published'` 条件を維持し、公開条件外は返さない | Fixed | 一覧・詳細・ナビゲーションの全クエリで `eq('status', 'published')` を強制 | High |
| [migrations/015_add_news_articles_rls.sql](../../migrations/015_add_news_articles_rls.sql) | 公開条件のDB境界 | `USING (status = 'published')` のRLSを維持 | Fixed | anon/readのRLSで公開済みのみ読み取り可能 | High |
| [migrations/013_create_news_images_bucket.sql](../../migrations/013_create_news_images_bucket.sql) | 画像の直接公開リスク | `public = false` を維持し、署名URL経由配信を継続 | Fixed | `news-images` は private bucket 設定 | High |
| [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts) | 画像URL配信方式 | 署名URL短命化方針を維持 | Fixed | `createSignedUrl(..., 3600)` により期限付きURL化 | Medium |
| [src/app/news/[id]/page.tsx](../../src/app/news/[id]/page.tsx) | XSS（本文レンダリング） | Reactテキストノード描画を維持し、`dangerouslySetInnerHTML` を導入しない | N/A | `detailed_content` は `<p>{paragraph}</p>` で描画されHTML解釈しない | Medium |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | レート制限未実装 | 現行設定（`endpoint: news:list`）を維持し、識別子のみ改善 | Fixed | `enforceRateLimit()` 呼び出しあり（60 req / 10分） | Medium |

---

## 重点観点ごとの結論

1. private news 露出: **防止できている（Fixed）**
2. slug/id 検証: **[id] の明示検証が不足（Open）**
3. 画像 URL: **private bucket + 署名URLは有効だが失敗時フォールバックに改善余地（Open）**
4. XSS: **現状は安全側（N/A）**
5. キャッシュ: **`/api/news` のHTTPキャッシュ方針が未明示（Open）**
6. レート制限: **機構はあるがIP信頼境界に課題（Open）**

---

## 推奨対応順序

1. `rateLimit` のIP信頼境界修正（High）
2. `/api/news` の `Cache-Control` 明示（Medium）
3. `signNewsImageUrl` の失敗時フォールバック厳格化（Medium）
4. `[id]` と `category` の入力検証統一（Low）

---

## 追加レビュー追記（2026-04-29, news詳細ページ追加監査）

### 対象・前提

- 対象: `src/app/news/[id]/**`, `src/app/api/news/[id]/route.ts`, `src/features/news/services/public.ts`, `src/lib/storage/news-images.ts`
- 実査結果: `src/app/api/news/[id]/route.ts` は現時点で未実装（存在しない）

### 追加サマリー

- **High: 0件**
- **Medium: 1件（Open）**
- **Low: 2件（Open）**
- **N/A: 1件**

### 追加指摘一覧

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts) | 署名対象の object path に許可制約がなく、DB 側データ改ざんや運用ミスと組み合わさると、`news-images` 内の意図しないオブジェクトを service role で署名して返せる（A01: Broken Access Control） | 署名前に object path を strict allowlist（例: `news/{yyyy-mm-dd}/` など運用ルール）で検証し、非準拠は署名拒否 + 監査ログ記録。署名処理は「公開許可済みプレフィックスのみ」へ制限 | Open | `signNewsImageUrl()` は `extractNewsImageObjectPath()` の戻り値をそのまま `createSignedUrl()` に渡している | Medium |
| [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts) | 署名失敗時に `rawUrl` を返すため、HTTP URL や想定外外部URLがそのままクライアントへ返却されうる（A02: Cryptographic Failures/A05: Security Misconfiguration） | 失敗時フォールバックを `null`（または安全なプレースホルダ）に変更し、`https` かつ自バケット由来 path のみ返却可能にする | Open | `return signedUrl ?? rawUrl` により失敗時に未検証 URL を返却 | Low |
| [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts) | 署名URLヘルパーに異常系の構造化監査ログがなく、異常頻発や改ざん兆候を追跡しづらい（A09: Security Logging and Monitoring Failures） | 署名失敗・パス検証失敗時に、機微情報を除いた構造化ログ（event, reason, hash化path）を出力して監視対象化 | Open | 現在は `null/rawUrl` の返却のみで、失敗原因のセキュリティ監視が困難 | Low |
| [src/app/api/news/[id]/route.ts](../../src/app/api/news/route.ts) | 対象指定された news 個別APIルートは未実装のため、当該ファイル単体の脆弱性診断は適用不可 | 個別APIを将来追加する場合は `/api/news` と同等以上の入力検証（id/cat）・`Cache-Control`・レート制限を実装時点で必須化 | N/A | ディレクトリ実査で `src/app/api/news/[id]/route.ts` は存在せず、news詳細は RSC + service 経由で取得 | N/A |

### 追加結論

1. 既存 High 論点の再指摘はなし（新規 High は確認されず）。
2. 追加で優先すべきは、`news-images` 署名処理の trust boundary 強化（Medium）。
3. 低優先ではあるが、署名失敗時フォールバックと監査ログ整備により、情報露出・検知遅延リスクを同時に下げられる。

### 追加推奨対応順序

1. `news-images` の署名対象パス allowlist 検証を導入（Medium）
2. 署名失敗時 `rawUrl` 返却を停止し安全フォールバックへ変更（Low）
3. 署名失敗/拒否イベントの構造化監査ログを追加（Low）