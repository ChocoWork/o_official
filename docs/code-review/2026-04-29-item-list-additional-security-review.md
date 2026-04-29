# Code Review: item list 追加セキュリティレビュー
**Ready for Production**: No
**Critical Issues**: 0

## 対象

- src/app/item/page.tsx
- src/app/api/items/route.ts
- src/lib/items/public.ts
- src/lib/storage/item-images.ts

## サマリー

- High: 0
- Medium: 1
- Low: 3

既存レビューに未記載だった差分として、SSR 直呼び経路の防御境界不一致、公開一覧サービスの最小権限設計、署名 URL 失敗時フォールバックによる情報露出余地、詳細バリデーションエラーの過開示を確認。

## Priority 2 (Should Fix)

### 1. SSR と API で防御境界が分離
- Files: src/app/item/page.tsx, src/app/api/items/route.ts
- Issue: SSR 初回取得は `/api/items` を経由せず `getPublishedItemsPage()` を直接呼び出しており、API 側で整備した入力検証・レート制限・監査が同一境界で適用されない。
- Why this matters: 脅威モデルが経路ごとに分裂し、将来の検証ルール追加時に片系のみ更新される運用リスクが高い（OWASP A04）。
- Suggested fix: クエリ検証を共通 Zod スキーマ化して SSR/API で共有、または SSR も API 経由に統一。

## Recommended Changes

### 2. 公開一覧処理で匿名固定クライアントを使用していない
- Files: src/lib/items/public.ts
- Issue: 公開 read 用途でも `createClient()` を使用し、閲覧者コンテキスト依存になる余地がある。
- Why this matters: 現時点で直ちに漏えいは確認していないが、将来の RLS/列追加時に意図せぬ差分を生みやすい（最小権限原則）。
- Suggested fix: 公開用途は `createPublicClient()` に統一し、匿名固定で実行。

### 3. 署名 URL 生成失敗時に生 URL を返却
- Files: src/lib/storage/item-images.ts
- Issue: 署名生成失敗時に `rawUrl` を返し、内部オブジェクトパスが公開レスポンスへ残る可能性。
- Why this matters: private bucket 運用でも内部パス情報の露出は攻撃面を広げる（A09 情報露出）。
- Suggested fix: 失敗時は `null`/プレースホルダ返却に変更し、生 URL を出さない。

### 4. バリデーション詳細の外部開示
- Files: src/app/api/items/route.ts
- Issue: 400 応答で `fieldErrors` をそのまま返している。
- Why this matters: 直接侵害には直結しないが、検証境界の内部情報を攻撃者に与える。
- Suggested fix: 外部応答は汎用エラーに縮小し、詳細は監査ログへ。

## Residual Risks

- `rateLimit` の IP 信頼境界、数値 fail-fast、HTTP キャッシュ方針は既存レビューの Open 項目として継続管理が必要。