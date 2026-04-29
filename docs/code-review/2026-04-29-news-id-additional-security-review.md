# Code Review: news detail

Ready for Production: No
Critical Issues: 0

## Priority 1 (Must Fix) ⛔

- 該当なし

## Priority 2 (Should Fix)

- Medium - 画像署名対象パスの信頼境界不足
  - 根拠: [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts#L70)
  - リスク: DB 値改ざんや運用ミス時に `news-images` 内の意図しないオブジェクトを service role で署名し、公開レスポンス経由で配布できる可能性
  - 推奨修正: 署名前に strict allowlist を適用し、許可外パスは署名拒否 + 監査ログ出力

## Priority 3 (Nice to Fix)

- Low - 署名失敗時 rawUrl 返却
  - 根拠: [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts#L84)
  - リスク: 想定外の外部URL（HTTP含む）がそのままクライアントに露出
  - 推奨修正: `null` または安全なプレースホルダへフォールバックし、返却URLを `https` + 自バケット由来に制限

- Low - 署名失敗/拒否イベントの監査ログ不足
  - 根拠: [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts#L70)
  - リスク: 改ざん兆候や異常頻発の検知遅延
  - 推奨修正: 機微情報を含まない構造化ログ（event/reason/path hash）を出力し監視対象化

## Confirmed Good Controls

- [src/features/news/services/public.ts](../../src/features/news/services/public.ts#L48): `status = 'published'` 制約で未公開記事を除外
- [src/app/news/[id]/page.tsx](../../src/app/news/%5Bid%5D/page.tsx#L140): 本文は React テキスト描画で HTML 非解釈（XSS耐性）
- [migrations/015_add_news_articles_rls.sql](../../migrations/015_add_news_articles_rls.sql#L7): RLS で published のみ read 許可