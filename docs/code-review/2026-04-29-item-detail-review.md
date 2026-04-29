# Code Review: item detail

Ready for Production: No
Critical Issues: 0

## Priority 1 (Must Fix) ⛔

- 該当なし

## Priority 2 (Should Fix)

- Medium - 画像署名対象パスの信頼境界不足
  - 根拠: [src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts#L145)
  - リスク: DB 値改ざん時に同一 bucket 内の意図しないオブジェクトを service role で署名し、公開 API から配布できる可能性
  - 推奨修正: 署名前に path allowlist を適用し、許可外パスは署名しない

## Priority 3 (Nice to Fix)

- Low - 署名失敗時 rawUrl 返却
  - 根拠: [src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts#L98)
  - リスク: 内部パスや旧署名 URL の情報露出
  - 推奨修正: null または固定プレースホルダーへフォールバック

- Low - signedUrlCache の無制限成長
  - 根拠: [src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts#L7)
  - リスク: メモリ逼迫による可用性低下
  - 推奨修正: LRU 上限、TTL クリーンアップ、メトリクス監視

## Confirmed Good Controls

- [src/app/api/items/[id]/route.ts](../../src/app/api/items/%5Bid%5D/route.ts#L44): id を Zod で検証
- [src/app/api/items/[id]/route.ts](../../src/app/api/items/%5Bid%5D/route.ts#L59): published 条件で公開商品のみに限定
- [src/app/api/items/[id]/route.ts](../../src/app/api/items/%5Bid%5D/route.ts#L10): no-store ヘッダ適用
