# item_id セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/05_item_detail.md](../4_DetailDesign/05_item_detail.md)
- レビュー対象: `src/app/item/[id]/**`, `src/app/api/items/[id]/route.ts`, 関連する item/cart/checkout/storage/migrations
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
- **Fixed/N/A: 7件**

重点確認した `private item 露出 / 在庫露出 / レート制限 / 入力検証 / 公開画像 / 関連商品安全性 / キャッシュ制御` のうち、`private item 露出` と `公開画像（バケット公開設定）` は現行実装で防御できています。一方で、**レート制限識別子の信頼境界** と **在庫数量の過度な露出** は未対処です。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | `x-forwarded-for` / `x-real-ip` を無条件信頼しており、クライアントがヘッダを偽装できる環境では IP ベース制限を回避できる | `x-forwarded-for` は信頼プロキシ経由時のみ採用し、それ以外はプラットフォーム提供の信頼済み IP を使う。加えて `subject`（session/user）を必須化して多層制限に寄せる | Open | `getIpFromRequest()` がヘッダ値をそのまま採用。`items:detail` / `items:list` / `checkout:*` の制限品質に横断影響 | High |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts) | 在庫不足時レスポンスで `availableQuantity`（実数在庫）を返し、リクエスト反復で在庫を推定できる | 公開 API では `sold_out / low_stock / insufficient_stock` 等の段階化情報のみ返し、厳密在庫は監査ログまたは内部用途に限定する | Open | `buildInventoryConflictBody(...availableQuantity...)` を返却。公開商品でも精密在庫の列挙が可能 | Medium |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | 成功レスポンスに明示的な `Cache-Control` がなく、共有キャッシュで署名URL付き商品一覧が意図せず保持される可能性がある | `Cache-Control` を明示（例: `private, no-store` または要件に応じ `s-maxage` を厳密設計）し、署名URL寿命と整合させる | Open | `GET /api/items` はメモリキャッシュを持つが HTTP キャッシュ方針は未指定。中間キャッシュ挙動が環境依存 | Medium |
| [src/app/item/[id]/page.tsx](../../src/app/item/[id]/page.tsx) | `generateMetadata` の `id` が未検証でクエリに渡される（注入リスクは低いがフェイルファスト不足） | `id` を `z.coerce.number().int().positive()` で先に検証し、不正値は 404 系メタへ早期フォールバック | Open | Supabase クエリはパラメータ化されており A03 直撃ではないが、入力検証一貫性が API と不一致 | Low |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts) | セッション依存のカート応答に `Cache-Control` がなく、プロキシ設定次第で意図しないキャッシュが起こり得る | `Cache-Control: private, no-store` を付与してセッションデータの中間保存を防止 | Open | 現状は Cookie 付き応答だが、明示ヘッダがないため安全側の挙動保証が弱い | Low |
| [src/features/items/components/RelatedItems.tsx](../../src/features/items/components/RelatedItems.tsx) | 関連商品 API 取得失敗を握り潰す実装で、異常時検知が遅れる（直接脆弱性ではない） | 監査ログまたは観測可能なエラーテレメトリへ記録し、異常検知可能にする | Open | `catch {}` で完全黙殺。安全性より運用検知性の問題 | Low |
| [src/app/api/items/[id]/route.ts](../../src/app/api/items/%5Bid%5D/route.ts) | private item 露出 | `status = 'published'` 条件と RLS を維持 | Fixed | `id` + `status='published'` で取得し、未公開は 404。直接露出経路は確認できず | High |
| [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts) | private item 混入 | `items` 取得時の `status='published'` と在庫整合チェックを維持 | Fixed | カート内 item を再取得時に `published` 制約あり。混入時は在庫不整合扱いで拒否 | High |
| [migrations/043_harden_finalize_order_from_checkout_draft_published_guard.sql](../../migrations/043_harden_finalize_order_from_checkout_draft_published_guard.sql) | DB 最終層での private item 混入 | `ITEM_NOT_PUBLISHED` ガードを継続 | Fixed | `finalize_order_from_checkout_draft` 内で `locked_item.status <> 'published'` を例外化 | High |
| [migrations/044_harden_item_images_bucket_private.sql](../../migrations/044_harden_item_images_bucket_private.sql) | item 画像の一括公開リスク | バケット private 化を維持し、配信は署名URL経由を継続 | Fixed | `storage.buckets.public=false` で公開バケット直読を遮断 | High |
| [src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts) | 公開画像配信方式 | 署名URL生成・短命化方針を維持 | N/A | 署名URL化され、`extractItemImageObjectPath` で bucket path を解決して配信 | Medium |
| [src/features/items/components/RelatedItems.tsx](../../src/features/items/components/RelatedItems.tsx) | 関連商品の安全性（カテゴリ注入） | allowlist 検証を維持 | Fixed | `ITEM_CATEGORIES` によるカテゴリ許可制で不正カテゴリ値の横流しを抑制 | Medium |
| [src/app/api/items/[id]/route.ts](../../src/app/api/items/%5Bid%5D/route.ts) | 入力検証（id） | 現行の Zod 検証を維持 | Fixed | `z.coerce.number().int().positive()` により不正 id を 400 拒否 | Medium |

---

## 重点観点ごとの結論

1. private item 露出: **概ね防止できている（Fixed）**
2. 在庫露出: **一部で過剰露出あり（Open）**
3. レート制限: **機構はあるが識別子の信頼境界に課題（Open）**
4. 入力検証: **`/api/items/[id]` は良好、`generateMetadata` 側は改善余地あり（Open）**
5. 公開画像: **private bucket + 署名URLで改善済み（Fixed）**
6. 関連商品の安全性: **カテゴリ allowlist で対策済み（Fixed）**
7. キャッシュ制御: **`/api/items/[id]` は良好、`/api/items` と `/api/cart` は改善余地あり（Open）**

---

## 推奨対応順序

1. `rateLimit` の IP 信頼境界修正（High）
2. `cart` 在庫実数レスポンスの段階化（Medium）
3. `items list / cart` の `Cache-Control` 明示（Medium/Low）
4. `generateMetadata` の `id` 検証統一（Low）

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 0件
- Medium: 1件（Open）
- Low: 2件（Open）
- 既存レビューとの差分: 画像署名処理の信頼境界と可用性寄りリスクを追加

### 追加指摘一覧

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts#L145) | 画像署名対象パスに許可リストがなく、DB に入った任意パスを service role で署名できる。公開済み item レコードが改ざんされた場合、同一 bucket 内の非公開オブジェクト配布に悪用されうる（A01: Broken Access Control） | 署名前に object path を strict allowlist で検証し、item ごとの管理下プレフィックス配下のみ署名許可する。拒否時は監査ログを残して 5xx ではなく安全な代替画像へフォールバックする | Open | Medium |
| [src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts#L98) | 署名生成失敗時に rawUrl をそのまま返すため、内部オブジェクトパスや古い署名 URL を露出する可能性がある（A05: Security Misconfiguration / A09: Security Logging and Monitoring Failures に伴う検知低下） | 署名失敗時は rawUrl を返さず null またはプレースホルダーにフォールバックし、失敗理由を機微情報なしで構造化ログへ送る | Open | Low |
| [src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts#L7) | signedUrlCache が無制限 Map で、ユニークパス増加時にプロセスメモリが単調増加する。高頻度アクセス時の可用性リスク（A04: Insecure Design） | LRU などで上限件数を設定し、TTL 到達時の掃除を定期実行する。運用でヒット率・件数・メモリをメトリクス化する | Open | Low |

### 重点結論

1. Item 詳細 API 本体（[src/app/api/items/[id]/route.ts](../../src/app/api/items/%5Bid%5D/route.ts#L84)）は入力検証・公開状態制約・no-store を満たしており、直近の High は追加なし。
2. ただし、画像署名サービス層（[src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts#L145)）の trust boundary が広く、将来の運用変更や管理系不備と組み合わさると情報露出面の踏み台になりうる。
3. したがって、次の改善優先は API ではなく画像署名サービス層の防御強化。

### 推奨対応順序

1. 署名対象パスの allowlist 化と拒否時ハンドリング実装（Medium）
2. 署名失敗時 rawUrl 返却の停止（Low）
3. signedUrlCache の上限制御とメトリクス監視（Low）