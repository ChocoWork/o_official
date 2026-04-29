# Code Review: News List and API
**Ready for Production**: No
**Critical Issues**: 1

## Priority 1 (Must Fix) ⛔

- **High - Access Control / Rate Limit Bypass Risk**
  - File: [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts)
  - Issue: `x-forwarded-for` / `x-real-ip` を無条件信頼しており、偽装ヘッダにより制限回避が可能。
  - Fix:
    - 信頼済みプロキシ経由時のみ forwarded ヘッダを採用。
    - `subject`（session or user id）を必須化して IP 単独依存を避ける。

## Priority 2 (Important) ⚠

- **Medium - Signed URL Trust Boundary**
  - File: [src/lib/storage/news-images.ts](../../src/lib/storage/news-images.ts)
  - Issue: URL ホスト検証なしで署名対象パスを抽出し、service role で署名可能。
  - Fix:
    - 許可ホスト allowlist を導入。
    - object path prefix allowlist を導入（例: `news/` 配下のみ）。

- **Medium - Service Reliability Coupling**
  - File: [src/features/news/services/public.ts](../../src/features/news/services/public.ts)
  - Issue: 一覧で service role 初期化と署名を毎回実施し、障害時に一覧全体へ波及。
  - Fix:
    - 一覧 DTO から署名不要項目を除外。
    - 署名失敗時の degrade 戦略と監視イベントを明示。

## Priority 3 (Low) ℹ

- **Low - API Security Header Policy Gap**
  - File: [src/app/api/news/route.ts](../../src/app/api/news/route.ts)
  - Issue: `Cache-Control` / `X-Content-Type-Options` / `Vary` が未統一で運用依存。
  - Fix:
    - API 共通レスポンスヘルパで防御ヘッダを標準化。

- **Low - Logging Exposure**
  - File: [src/app/api/news/route.ts](../../src/app/api/news/route.ts)
  - Issue: `console.error(..., error)` による例外オブジェクトの過剰ログ出力。
  - Fix:
    - 構造化ログ化し、エラー種別と message のみ記録。

## Recommended Changes

1. `rateLimit` の信頼境界修正を最優先で実施（High）。
2. `news-images` の署名対象 host/path allowlist を実装（Medium）。
3. `news` 一覧 API のレスポンスヘッダとログポリシーを共通化（Low）。
