# look_id セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/07_look_detail.md](../4_DetailDesign/07_look_detail.md)
- レビュー対象: `src/app/look/[id]/**`, `src/app/api/looks/**（実体なし）`, `src/app/api/admin/looks/**`, `src/lib/look/public.ts`, `src/lib/storage/look-images.ts`, `migrations/*look*`
- 実施日: 2026-04-29
- レビュー基準: Secure Coding / OWASP Top 10（A01, A03, A05, A06 を重点）

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

重点確認した `private look 露出 / 入力検証 / 公開画像 / 関連 item/URL の安全性 / キャッシュ / レート制限` のうち、`private look 本体露出` と `公開画像バケット設定` は対策されています。一方で、**公開ポリシーの情報露出（look_items）**、**公開詳細取得時の全件ハイドレーションによる可用性リスク**、**レート制限の信頼境界** が未対処です。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [migrations/019_add_public_select_policy_to_look_items.sql](../../migrations/019_add_public_select_policy_to_look_items.sql) | `look_items` の公開ポリシーが `looks.status='published'` のみを条件にしており、published look に private item が紐づくと `item_id` が匿名クエリで取得可能 | `USING` 条件に `items.status='published'` の存在確認を追加する。もしくは公開用 view/RPC を作成し private item を除外して返却する | Open | `src/lib/look/public.ts` 側は `items.status='published'` で再フィルタしているが、DB レイヤで匿名 `look_items` 直読時の漏えい経路が残る | High |
| [src/lib/look/public.ts](../../src/lib/look/public.ts) | `getPublishedLookById()` が `getPublishedLooks()` を全件実行してから `find` しており、単一 ID 参照で全 look + 画像署名発行が走る。大量アクセス時に可用性低下を誘発 | `getPublishedLookById(id)` は `eq('id', id).eq('status','published').single()` で単体取得に変更し、画像署名も当該 look のみに限定する | Open | `generateMetadata` と本体表示の双方がこの経路を利用。攻撃者が単一ページを高頻度要求すると不要な DB/Storage 署名コストが増幅される | Medium |
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | `x-forwarded-for` / `x-real-ip` を無条件で信頼しており、構成によってはヘッダ偽装で IP ベース制限を回避可能 | 信頼プロキシ経由時のみ転送ヘッダを採用し、それ以外はプラットフォーム提供 IP を使用。`subject` ベース制限を優先し多層化する | Open | look 管理 API の `enforceAdminLookMutationRateLimit()` はこの共通関数に依存し、全 mutation 制限に横断影響 | Medium |
| [src/app/look/[id]/page.tsx](../../src/app/look/%5Bid%5D/page.tsx) | `id` を `Number()` 変換のみで扱っており、API 層と比較すると入力検証の厳密性が不足 | `z.coerce.number().int().positive()` などでフェイルファストに統一し、無効値は早期 404 へ | Open | 直ちに SQL Injection にはならないが、入力検証ポリシーが API と不整合 | Low |
| [src/app/look/[id]/page.tsx](../../src/app/look/%5Bid%5D/page.tsx) | 詳細ページ応答の `Cache-Control` 方針が明示されていない | `revalidate` / `dynamic` 設計を明文化し、署名 URL 寿命（1時間）と整合するキャッシュ戦略を定義 | Open | 現状は実行環境依存のため、署名 URL 期限切れと表示失敗の運用リスクが残る | Low |
| [src/app/look/[id]/page.tsx](../../src/app/look/%5Bid%5D/page.tsx) | `List` の `getHref` は DB の `item.id` を直接 URL 化するのみで、将来 slug 化など入力ソースが変わった場合の安全境界が曖昧 | URL 生成用ユーティリティを切り出し、数値 ID 前提を型で固定する（`number` 以外は拒否） | Open | 現実装では `item.id` が数値であり即時脆弱性ではないが、将来変更時の予防的ハードニング余地 | Low |
| [src/lib/look/public.ts](../../src/lib/look/public.ts) | private look 露出 | `looks.status='published'` 条件と RLS を維持 | Fixed | 公開取得は常に `.eq('status','published')`。private look 本体は取得されない | High |
| [migrations/018_create_looks_and_look_images_bucket.sql](../../migrations/018_create_looks_and_look_images_bucket.sql) | look テーブル公開条件 | 公開 SELECT を `status='published'` に限定する方針を維持 | Fixed | `public.looks` の RLS が匿名閲覧を published のみに制限 | High |
| [migrations/030_make_look_images_bucket_private.sql](../../migrations/030_make_look_images_bucket_private.sql) | 公開画像の直接露出 | `look-images` バケット private を維持 | Fixed | `storage.buckets.public = false` へ更新済み | High |
| [src/lib/storage/look-images.ts](../../src/lib/storage/look-images.ts) | 画像配信方式 | 署名 URL 配信・短命 URL（1時間）を維持 | Fixed | private bucket 前提で `createSignedUrl` を使用。公開 URL 直配信ではない | Medium |
| [src/lib/look/public.ts](../../src/lib/look/public.ts) | 関連 item の公開制御 | `items.status='published'` フィルタを維持 | Fixed | linked item 取得時に公開済みのみ採用し、private item は表示対象外 | Medium |
| [src/app/api/admin/looks/route.ts](../../src/app/api/admin/looks/route.ts) | 入力検証（テーマ、シーズン、linkedItemIds、画像 MIME/サイズ） | 現行 Zod + MIME/サイズ検証を維持 | N/A | 主要パラメータに型・範囲チェックあり。基本的な A03/A05 対策は機能 | Low |

---

## 重点観点ごとの結論

1. private look 露出: **本体露出は防止（Fixed）**
2. 入力検証: **管理 API は良好、RSC ルートは厳密化余地あり（Open）**
3. 公開画像: **private bucket + 署名 URL で対策済み（Fixed）**
4. 関連 item/URL の安全性: **表示層は published 限定だが、DB ポリシーに漏えい余地（Open）**
5. キャッシュ: **署名 URL 寿命に対する明示戦略が不足（Open）**
6. レート制限: **機構はあるが IP 信頼境界に課題（Open）**

---

## 推奨対応順序

1. `look_items` 公開ポリシーに `items.status='published'` 条件を追加（High）
2. `getPublishedLookById()` を単体取得化し、全件ハイドレーションを解消（Medium）
3. `rateLimit` の IP ヘッダ信頼境界を修正し、subject ベース制限を主軸化（Medium）
4. `src/app/look/[id]/page.tsx` の `id` 検証を API と同等に統一（Low）
5. look 詳細のキャッシュ方針（`revalidate` / `dynamic`）を署名 URL TTL と整合させて明文化（Low）

---

## 追加レビュー（2026-04-29, 差分）

### サマリー

- 追加 High: 0件
- 追加 Medium: 2件（Open）
- 追加 Low: 2件（Open）

`src/app/api/looks/[id]/route.ts` はリポジトリ上に実体がなく、公開詳細の実装は [src/app/look/[id]/page.tsx](../../src/app/look/%5Bid%5D/page.tsx) と [src/lib/look/public.ts](../../src/lib/look/public.ts) に集約されています。今回の差分では、関連サービス層（画像署名・管理認可）の情報露出と fail-open 挙動を追加確認しました。

### 追加指摘一覧

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/lib/auth/admin-rbac.ts](../../src/lib/auth/admin-rbac.ts) | `authorizeAdminPermission()` の例外時に `err.message` を `details` としてクライアントへ返しており、認可基盤の内部情報（DB/接続/構成）を外部露出しうる（OWASP A05 Security Misconfiguration） | クライアント向けは固定文言（例: `Internal server error`）のみ返し、詳細はサーバログに限定する | Open | Medium |
| [src/lib/storage/look-images.ts](../../src/lib/storage/look-images.ts) | `signLookImageUrl()` が署名失敗時に `rawUrl` を返す fail-open 実装のため、データ汚染時に意図しない外部 URL/内部パスをそのまま配信しうる（OWASP A01/A05） | 署名失敗時は `null` またはプレースホルダーへ fail-safe でフォールバックし、許可プレフィックス検証（例: `looks/`）を追加する | Open | Medium |
| [src/lib/auth/admin-rbac.ts](../../src/lib/auth/admin-rbac.ts) | 通常系ログで user id・role・permission 一覧を詳細出力しており、ログ閲覧権限者に認可トポロジーを過剰公開する（OWASP A09 Security Logging and Monitoring Failures の逆方向リスク） | 本番ログは decision 結果と request id の最小情報に絞り、permission の生値列挙を避ける | Open | Low |
| [src/app/api/admin/looks/[id]/route.ts](../../src/app/api/admin/looks/%5Bid%5D/route.ts), [src/app/api/admin/looks/route.ts](../../src/app/api/admin/looks/route.ts) | `id` パラメータを Zod 等で明示検証せず文字列のままクエリへ渡しており、境界検証ポリシーが他 API と不統一（直ちに A03 ではないが fail-fast 不足） | `z.coerce.number().int().positive()` で route param を先頭検証し、異常値は 400 で即時拒否する | Open | Low |

### 追加の重点結論

1. 公開 look 詳細本体の High は追加なし（既存指摘の優先度は維持）。
2. 追加で優先すべきは、関連サービス層の **情報露出抑制（admin-rbac）** と **画像署名の fail-safe 化（look-images）**。
3. `src/app/api/looks/[id]/route.ts` は未実装のため、将来追加時は `id` 検証、`Cache-Control`, レート制限を初期実装に含める。 

### 追加推奨対応順序

1. `authorizeAdminPermission()` の 500 応答から `details` を削除（Medium）
2. `signLookImageUrl()` を fail-open から fail-safe へ変更（Medium）
3. RBAC 詳細ログの削減（Low）
4. admin looks API の route param 検証を統一（Low）