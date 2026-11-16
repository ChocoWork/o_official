# パスキーのログインの始めの回数の制限は、オーナーが上げられるか（調べ）

> 目的: [パスキー設計書](2026-11-07-passkey-auth-design.md) の 5-1（始めの呼び方）の決定の根拠として、回数の制限（IP ごとに5分30回）を上げられるかを調べた記録
> 確認日: 2026-11-16。本文は調べた時の英語のまま。「有力・確定・暫定」は、確定 = 文書やソースで確かめた、有力 = 裏付けはあるが動かして確かめていない、暫定 = 推測を含む

## 結論（原文は英語）
- Raise via owner settings: NO (as of docs/OpenAPI fetched 2026-11-16). 確定 for "no documented knob"; 有力 that hosted does not let owner change GOTRUE_RATE_LIMIT_PASSKEY (not verified by calling API; forbidden).
- Counting without Sb-Forwarded-For: 有力 per server egress IP only if hosted sets GOTRUE_RATE_LIMIT_HEADER; if header is unset AND no sbff, source applies NO limit at all (確定 from source). Hosted header setting is not in public source -> 暫定.

## 根拠
1. Limiter exists, keyed GOTRUE_RATE_LIMIT_PASSKEY, default 30, route only POST /passkeys/authentication/options.
   - https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/api/api.go : `r.With(api.limitHandler(api.limiterOpts.PasskeyAuthentication)).` ... `Post("/options", api.PasskeyAuthenticationOptions)`; /verify and registration routes have no limiter.
   - .../internal/api/apilimiter/apilimiter.go : `o.PasskeyAuthentication = newLimiterPer5mOver1h(gc.RateLimitPasskey)`; env `GOTRUE_RATE_LIMIT_PASSKEY`.
   - .../internal/conf/configuration.go : `RateLimitPasskey ... default:"30"`.
   - Only affects that endpoint (own limiter field, own env var) -> no effect on other endpoints.
2. Management API has no passkey rate field. OpenAPI https://api.supabase.com/api/v1-json (PATCH /v1/projects/{ref}/config/auth) lists only rate_limit_anonymous_users, _email_sent, _otp, _sms_sent, _token_refresh, _verify, _web3; passkey appears only as `passkey_enabled`. Same on https://supabase.com/docs/reference/api/v1-update-auth-service-config (integer fields, max 9007199254740991 for those seven; no passkey).
3. Dashboard docs https://supabase.com/docs/guides/auth/rate-limits : table has no passkey row; "Some rate limits are customizable... Authentication > Rate Limits". MFA challenge/verify is explicitly "No" customizable. Plan (free) restrictions not stated on that page.
4. CLI config.toml keys https://supabase.com/docs/guides/local-development/cli/config : auth.rate_limit has email_sent, sms_sent, anonymous_users, token_refresh, sign_in_sign_ups, token_verifications only (no passkey, no otp/web3 either). Note: self-hosted/local GoTrue could still set the env var GOTRUE_RATE_LIMIT_PASSKEY directly; hosted cannot.
5. Keying: https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/api/middleware.go
   - `performRateLimiting`: if `sbff.GetIPAddress(req)` ok -> limit by that IP; else `performRateLimitingWithHeader`.
   - `performRateLimitingWithHeader`: `if limitHeader == "" { return nil }` (no limiting); empty header value -> warn, no limiting; else key = first comma value of the RateLimitHeader.
   - No service-role/secret-key exemption in limitHandler.
   - sbff middleware (https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/sbff/sbff.go): only active if `SbForwardedForEnabled`; missing header -> falls through to header path.
   - Docs: "By default, Supabase Auth uses the IP address of the client for rate limiting"; Sb-Forwarded-For needs a secret API key and must be enabled in project settings (rate-limits page).
   So: server call without Sb-Forwarded-For is counted by whatever the hosted GOTRUE_RATE_LIMIT_HEADER yields (docs say client IP as seen by the edge = the server's egress IP, e.g. Vercel function IP, shared across all shop users) -> shop-wide bucket of 30 burst / 5 min refill (newLimiterPer5mOver1h; refill detail not re-read).

## 現実的な選び方
- Pass end-user IP in `Sb-Forwarded-For` (secret key + enable in project settings) so the bucket is per customer.
- Or call the endpoint rarely / cache; or ask Supabase support to raise the hosted value (unverified path).
- Not tried: calling the live project (forbidden).
