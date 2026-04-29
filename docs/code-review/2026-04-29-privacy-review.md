# Code Review: Privacy Page and Shared Layers

**Ready for Production**: No  
**Critical Issues**: 1

## Priority 1 (Must Fix) ⛔

- `src/proxy.ts`: `x-forwarded-proto` / `x-forwarded-host` を無条件信頼して Origin を構築しており、非信頼経路でヘッダ注入が可能な構成では状態変更 API の Origin チェックをすり抜ける余地があります。

## Priority 2 (Should Fix)

- `src/app/api/auth/me/route.ts`: `email` を返しているが、クライアント利用用途に不要でデータ最小化原則に反します。

## Priority 3 (Improve)

- `src/proxy.ts`: `COOP/CORP` が未設定のため、将来のクロスオリジン連携追加時に境界設計が弱くなりやすい状態です。

## Recommended Changes

1. `src/proxy.ts`
   - Forwarded ヘッダ採用を `TRUST_PROXY_HEADERS=true` など明示条件に限定。
   - 許可オリジン集合で厳密照合。
2. `src/app/api/auth/me/route.ts`
   - レスポンスから `email` を除外し、必要時のみ専用 API で取得。
3. `src/proxy.ts`
   - `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Resource-Policy: same-origin` を追加。

## Security Mapping

- A01: Broken Access Control
- A05: Security Misconfiguration
- Zero Trust: ヘッダ信頼境界の明示化