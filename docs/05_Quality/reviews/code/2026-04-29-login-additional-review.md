# Code Review: Login/Auth Additional Security Review


> 状態: 履歴レビュー | 現行の指摘状態は未再検証

## 概要

本書は「Code Review: Login/Auth Additional Security Review」のレビュー時点の記録である。指摘の重大度と修正状態は当時の評価を示し、現在の実装を保証しない。

**Ready for Production**: No
**Critical Issues**: 1

## Priority 1 (Must Fix) ⛔

- [High] IPベースレート制限回避の余地
  - 対象: [src/features/auth/middleware/rateLimit.ts](../../../../src/features/auth/middleware/rateLimit.ts), [src/app/api/auth/login/route.ts](../../../../src/app/api/auth/login/route.ts)
  - 問題: `x-forwarded-for` / `x-real-ip` を無条件に採用しており、信頼境界が未固定な環境ではヘッダ偽装で制限回避が可能。
  - 影響: ブルートフォース耐性の低下、アカウント防御の実効性低下。
  - 修正案: 信頼済みプロキシ経由時のみ転送ヘッダを採用し、それ以外は接続元IPを使用。WAF/Ingress で転送ヘッダの上書き運用を必須化。

## Recommended Changes

- [Medium] login成功判定の fail-open 解消
  - 対象: [src/app/api/auth/login/route.ts](../../../../src/app/api/auth/login/route.ts)
  - 問題: Cookie発行/セッション永続化失敗を catch で握りつぶし 200 を返す。
  - 修正案: sessions 永続化と refresh/csrf Cookie 設定失敗時は 500/503 を返し、Cookie も明示クリアして fail-closed。

- [Low] logout 成否のクライアント誤認防止
  - 対象: [src/contexts/LoginContext.tsx](../../../../src/contexts/LoginContext.tsx), [src/app/api/auth/logout/route.ts](../../../../src/app/api/auth/logout/route.ts)
  - 問題: `/api/auth/logout` のレスポンスを検証せず、常にローカル状態をログアウト済みに更新。
  - 修正案: `resp.ok` 判定必須化、失敗時は警告と再試行導線、成功時のみ確定更新。

## Notes

- 既存レビュー [docs/05_Quality/reviews/security/security_review_login.md](../security/security_review_login.md) は維持し、重複を避けて追加所見のみ記載。
- login page 本体 [src/app/login/page.tsx](../../../../src/app/login/page.tsx) には今回スコープで新規の直接脆弱性は未検出。
