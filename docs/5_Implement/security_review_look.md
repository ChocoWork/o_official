# look セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/06_look_list.md](../4_DetailDesign/06_look_list.md)
- レビュー対象: `src/app/look/page.tsx`, `src/app/api/admin/looks/**`, `src/lib/look/public.ts`, 関連 storage/migrations
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

- **High: 2件（Open）**
- **Medium: 2件（Open）**
- **Low: 2件（Open）**
- **Fixed/N/A: 7件**

重点確認した `列挙耐性 / 公開条件 / 署名 URL / キャッシュ / 過剰データ返却 / レート制限` のうち、`公開条件` と `署名 URL（private bucket 化）` は改善済みです。一方で、**look_items の公開ポリシーによる item_id 列挙** と **レート制限識別子の信頼境界** は High で未対処です。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [migrations/019_add_public_select_policy_to_look_items.sql](../../migrations/019_add_public_select_policy_to_look_items.sql) | 公開ポリシーが「公開 look に紐づくこと」だけを条件にしており、`look_items` 直読で private item の `item_id` を列挙できる | `look_items` の公開 SELECT 条件に `items.status = 'published'` を追加するか、公開用 SECURITY DEFINER RPC/View に置換して返却項目を最小化する | Open | `looks.status='published'` のみを条件に許可。`items` 側公開状態を見ていないため列挙耐性が不足 | High |
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | `x-forwarded-for` / `x-real-ip` を無条件信頼しており、環境次第で IP 偽装により制限回避できる | 信頼プロキシ経由時のみ転送ヘッダを採用し、それ以外はプラットフォーム提供の信頼済み IP を使用する。`subject` ベース制限を主制御にする | Open | look 管理 API の制限実装はあるが、基盤関数の信頼境界が弱く横断的に影響 | High |
| [src/lib/look/public.ts](../../src/lib/look/public.ts) | `getPublishedLooks()` が catalog で上限なし取得のため、公開件数増加時に大量署名 URL 発行が発生し可用性リスクになる | 一覧はページング/limit を必須化し、署名 URL は短TTL+バッチ上限で生成する。必要に応じて ISR/`revalidate` で再生成頻度を下げる | Open | 一覧表示時に全件 + 画像ごと署名生成。攻撃者の反復アクセスで CPU/Storage API を消費しやすい | Medium |
| [src/lib/look/public.ts](../../src/lib/look/public.ts) | LOOK 一覧用途でも `themeDescription` や `linkedItems.price/imageUrl` まで返却し、表示不要データを過剰取得している | 一覧用 DTO と詳細用 DTO を分離し、一覧では `id/season/theme/thumbnail/itemName` 程度に最小化する | Open | `PublicLookGrid`（catalog）では商品名のみ表示。価格・商品画像・説明文は不要な返却 | Medium |
| [src/lib/storage/look-images.ts](../../src/lib/storage/look-images.ts) | 署名 URL 生成失敗時に `rawUrl` を返すフォールバックがあり、データ汚染時に外部 URL がそのまま配信され得る | 失敗時は `null` またはプレースホルダにフォールバックし、許可ホスト/許可パスの allowlist 検証を追加する | Open | 現在は通常運用で `filePath` 保存だが、防御としては fail-open 挙動 | Low |
| [src/app/look/[id]/page.tsx](../../src/app/look/%5Bid%5D/page.tsx) | `id` を `Number()` 変換のみで扱っており、API と比較して入力検証ポリシーが不統一 | `z.coerce.number().int().positive()` で統一検証し、不正値は早期 404 に寄せる | Open | 直ちに注入脆弱性ではないが、フェイルファストと保守整合性の観点で弱い | Low |
| [migrations/030_make_look_images_bucket_private.sql](../../migrations/030_make_look_images_bucket_private.sql) | look 画像の公開バケット露出 | private bucket + 署名 URL 配信を継続 | Fixed | `storage.buckets.public=false` が適用済みで直リンク露出を抑制 | High |
| [src/lib/storage/look-images.ts](../../src/lib/storage/look-images.ts) | 署名 URL 配信 | 期限付き署名 URL 運用を継続 | Fixed | `createSignedUrl` を経由し、公開/非公開の直接配信を分離 | Medium |
| [src/lib/look/public.ts](../../src/lib/look/public.ts) | 公開条件（look） | `status='published'` フィルタを維持 | Fixed | 取得クエリで公開状態を明示。private look は一覧/詳細の対象外 | High |
| [src/lib/look/public.ts](../../src/lib/look/public.ts) | 公開条件（linked item） | `items.status='published'` フィルタを維持 | Fixed | link 解決時に公開 item のみマップし、private item 実体の返却を防止 | High |
| [src/app/api/admin/looks/route.ts](../../src/app/api/admin/looks/route.ts) | 管理者 API の乱用耐性 | 現行の多層制限（IP + actor + upload quota）を継続 | Fixed | 作成でレート制限・画像数/容量上限・時間帯クォータが実装済み | Medium |
| [src/app/api/admin/looks/[id]/route.ts](../../src/app/api/admin/looks/%5Bid%5D/route.ts) | 管理者 API の乱用耐性 | PUT/PATCH/DELETE への制限適用を維持 | Fixed | 更新/公開切替/削除にも制限が適用済み | Medium |
| [src/features/look/services/admin-audit.ts](../../src/features/look/services/admin-audit.ts) | 監査証跡不足 | 変更系 API の監査ログ運用を継続 | Fixed | 成功/失敗双方で actor・action・resource を記録 | Medium |

---

## 重点観点ごとの結論

1. 列挙耐性: **`look_items` 直読経路に課題あり（Open / High）**
2. 公開条件: **アプリ層クエリは `published` で防御できている（Fixed）**
3. 署名 URL: **private bucket + 署名 URL 化は有効（Fixed）**
4. キャッシュ: **一覧全件取得と再署名頻度の制御が弱く、可用性面で改善余地（Open / Medium）**
5. 過剰データ返却: **一覧用途に対して返却項目が多い（Open / Medium）**
6. レート制限: **管理 API は実装済みだが識別子の信頼境界に課題（Open / High）**

---

## 推奨対応順序

1. `look_items` 公開ポリシー修正（`items.status='published'` を追加）
2. `rateLimit` の IP 信頼境界修正（信頼プロキシ判定 + subject 主体）
3. LOOK 一覧のページング/上限制御と署名 URL 生成負荷の抑制
4. LOOK 一覧 DTO の最小化（不要フィールド非返却）
5. `signLookImageUrl` の fail-open フォールバックを fail-safe に変更
6. `look/[id]` の `id` 検証を API と同一スキーマに統一

---

## 追加レビュー追記（2026-04-29 / look一覧・公開取得経路）

### サマリー

- **High: 1件（Open）**
- **Medium: 2件（Open）**
- **Low: 2件（Open）**
- **Fixed/N/A: 1件**

今回の追加レビューでは、ユーザー指定の `src/app/look/page.tsx` と `src/app/api/looks/route.ts`、および公開取得の実体である `src/features/look/components/PublicLookGrid.tsx` / `src/lib/look/public.ts` / `src/lib/storage/look-images.ts` を確認しました。`src/app/api/looks/route.ts` は現時点で実体がなく、公開 LOOK 一覧は RSC から直接 `getPublishedLooks()` を呼ぶ構成です。主な追加論点は **service role 署名の許可境界**、**署名 URL とキャッシュ戦略の不整合**、**公開取得経路の制御点分散** です。

### セキュリティレビュー結果（追加分）

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/lib/look/public.ts](../../src/lib/look/public.ts) | `createServiceRoleClient()` で private bucket 署名を行う際、`image_urls` のオブジェクトパス許可境界が未定義。DB 汚染時に同一 bucket 内の意図しないオブジェクトへ署名を発行し得る（A01: Broken Access Control） | 署名前に strict allowlist（例: `looks/` プレフィックス + 期待フォーマット）を適用し、逸脱値は署名拒否 + 監査ログ記録に変更する | Open | `hydrateLooks()` で service role を用いて全 LOOK の `image_urls` を署名。パス妥当性は `extractLookImageObjectPath` 依存で、業務境界の検証が不足 | High |
| [src/features/look/components/PublicLookGrid.tsx](../../src/features/look/components/PublicLookGrid.tsx) | catalog では `getPublishedLooks(undefined)` により実質全件取得し、各画像で署名 URL を生成。反復アクセス時に DB/Storage API 消費が増幅し可用性低下（A04: Insecure Design） | 一覧 API/サービスでページングを必須化し、1リクエスト当たりの署名件数上限を設ける。`revalidate` と組み合わせて再署名頻度を制御する | Open | 現行はホーム以外で上限未設定。RSC 再評価ごとに署名処理が走る構造 | Medium |
| [src/app/look/page.tsx](../../src/app/look/page.tsx) | 署名 URL の有効期限（1時間）に対して `revalidate`/`dynamic` 方針が明示されず、環境依存キャッシュで期限切れ URL 配信の運用リスク（A05: Security Misconfiguration） | `revalidate` を明示して署名 URL TTL と整合させる。必要なら API 経由へ寄せ、`Cache-Control` を明文化する | Open | `LookPage` は `PublicLookGrid` 呼び出しのみでキャッシュ方針の明示がない | Medium |
| src/app/api/looks/route.ts（実体なし） | 対象指定された公開 API ルートの実体が存在せず、入力検証/レート制限/レスポンスヘッダの統一制御点がない（A05: Security Misconfiguration） | 公開 LOOK 一覧を API 化する場合は Zod 検証（pagination/limit）、`Cache-Control`、必要に応じたレート制限を同一地点へ集約する | Open | ファイル実体なし（確認日 2026-04-29）。現行は RSC 直結で公開取得を実行 | Low |
| [src/lib/storage/look-images.ts](../../src/lib/storage/look-images.ts) | `extractLookImageObjectPath()` が復号パスをそのまま返し、`..` などの不正セグメント拒否がない。現状で直ちに侵害ではないが、防御層としては弱い（A05） | `..`、制御文字、先頭 `/`、二重スラッシュ等を拒否する正規化/検証を追加し、不正値は `null` 扱いにする | Open | 署名可否は downstream API 依存。ユーティリティ層での fail-fast が不足 | Low |
| [src/app/look/page.tsx](../../src/app/look/page.tsx) | メタデータ生成にユーザー入力を使用していない点 | 現行維持 | N/A | `title/description/openGraph` は静的値で、直接的な注入経路は未確認 | Low |

### 重点観点ごとの結論（追加分）

1. アクセス制御（A01）: **service role 署名時のパス許可境界が不足（Open / High）**
2. 可用性設計（A04）: **全件取得 + 全件署名で DoS 耐性に課題（Open / Medium）**
3. 設定不備（A05）: **署名 URL TTL とキャッシュ方針、公開 API 制御点の整合不足（Open / Medium-Low）**
4. 入力/パス検証（A03/A05）: **`look-images` パス正規化の防御余地あり（Open / Low）**

### 推奨対応順序（追加分）

1. `src/lib/look/public.ts` の署名前 allowlist 検証 + 監査ログ追加（High）
2. LOOK 一覧のページング必須化と署名件数上限（Medium）
3. `src/app/look/page.tsx` の `revalidate` 方針を署名 TTL と整合（Medium）
4. `src/lib/storage/look-images.ts` のパス正規化/拒否条件を強化（Low）
5. 将来 `src/app/api/looks/route.ts` を導入する場合は検証・制限・キャッシュ制御を集約（Low）