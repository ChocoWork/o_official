# Code Review: Signup/Auth Flow

**Ready for Production**: No
**Critical Issues**: 5

## Review Plan

1. Pass 1: フロントエンド、入力処理、トークン露出、XSS
2. Pass 2: API / バックエンド / 認証認可 / CSRF / レート制限 / メール確認フロー
3. Pass 3: DB / RLS / 監査 / シークレット / アカウント作成整合

## Spec Basis

- docs/4_DetailDesign/14_login.md
- docs/3_ArchitectureDesign/auth-structure.md
- src/features/auth/design.md

## Scope Notes

- `src/app/signup/**` は実ファイルが見つからず、signup 相当の実装として OTP / register / confirm / identify / 関連フロントを確認した。

## Related Files

- src/components/LoginModal.tsx
- src/contexts/LoginContext.tsx
- src/app/api/auth/register/route.ts
- src/app/api/auth/confirm/route.ts
- src/app/api/auth/identify/route.ts
- src/app/api/auth/otp/verify/route.ts
- src/features/auth/services/register.ts
- src/features/auth/middleware/rateLimit.ts
- src/features/auth/ratelimit/index.ts
- src/features/auth/schemas/register.ts
- src/features/auth/schemas/identify.ts
- src/lib/redirect.ts
- src/lib/cookie.ts
- src/lib/csrf.ts
- src/lib/audit.ts
- src/lib/supabase/server.ts
- migrations/004_create_sessions.sql
- migrations/005_create_rate_limit_counters.sql
- migrations/007_create_audit_logs.sql
- migrations/009_add_csrf_prev_token_hash.sql
- migrations/022_add_optional_profile_fields.sql

## Priority 1 (Must Fix) ⛔

### 1. OTP / signup tokens are exposed to client-side JavaScript
- Files: src/app/api/auth/otp/verify/route.ts, src/app/api/auth/register/route.ts, src/contexts/LoginContext.tsx
- Issue: OTP 検証 API が `access_token` と `refresh_token` を JSON で返し、クライアント側が `localStorage` に保存している。register も auto sign-in 時に `access_token` を JSON 返却する。
- Why this matters: HttpOnly Cookie に閉じるべき認証情報が DOM/XSS 到達範囲に出ており、XSS 1 回で長期セッション奪取が成立する。
- Suggested fix: API レスポンスからトークンを除去し、サーバ側で Cookie のみ発行する。クライアントは成功メッセージとユーザー最小情報だけを受け取る。

### 2. Identify flow marks users as email-confirmed before proof of email ownership
- Files: src/app/api/auth/identify/route.ts
- Issue: JIT 作成で `auth.admin.createUser({ email_confirm: true })` を実行しており、メール確認前に確認済み扱いのアカウントが作成される。
- Why this matters: メール確認フローの整合性が崩れ、`email_verified` 前提の downstream 判定や監査の意味が失われる。誤配送やアドレス入力ミス時にも確認済みユーザーが残る。
- Suggested fix: `email_confirm: true` を廃止し、未確認ユーザーのまま OTP / confirm 完了で確定させる。必要ならリンク送信専用の準備レコードを別テーブルで管理する。

### 3. Origin generation trusts client-controlled forwarded headers
- Files: src/lib/redirect.ts, src/app/api/auth/register/route.ts, src/app/api/auth/confirm/route.ts
- Issue: `getRequestOrigin()` が `x-forwarded-host` / `x-forwarded-proto` を無条件で採用し、register の `emailRedirectTo` と confirm の redirect URL を組み立てている。
- Why this matters: Host header poisoning により、確認メールリンクや 303 リダイレクト先の origin を攻撃者ドメインへ差し替えられる可能性がある。確認トークンの漏えいやフィッシング導線になる。
- Suggested fix: origin はサーバ設定の allowlist で固定し、信頼済み proxy が付与したヘッダのみ採用する。公開リクエストから任意 Host を反映しない。

### 4. Auth token and cookie values are logged to server/client logs
- Files: src/lib/supabase/server.ts, src/app/auth/callback/page.tsx
- Issue: サーバ側で Cookie ヘッダや token の先頭値を `console.log` しており、OAuth callback でも localStorage 上の access token をログ出力している。
- Why this matters: アプリログ、ブラウザコンソール、外部ログ基盤に認証情報が残り、内部不正やログ漏えい時の横展開につながる。
- Suggested fix: 認証トークン、Cookie、Authorization ヘッダはログ出力しない。必要なら presence のみを boolean で記録する。

### 5. RLS / policy hardening is missing for auth security tables
- Files: migrations/004_create_sessions.sql, migrations/005_create_rate_limit_counters.sql, migrations/007_create_audit_logs.sql, migrations/009_add_csrf_prev_token_hash.sql
- Issue: `sessions`, `rate_limit_counters`, `audit_logs` に対して RLS 有効化や policy 定義がない。
- Why this matters: 設計上は認証系データの保護が必須であり、将来の grant 追加や PostgREST 公開設定変更で即時に情報露出・改ざん面になる。少なくとも defense-in-depth が欠落している。
- Suggested fix: 全テーブルで RLS を有効化し、service_role のみ全面許可、必要最小限の authenticated policy のみ追加する。監査ログと rate-limit テーブルは原則アプリ内部専用にする。

## Important Issues

### 6. Rate limiting fails open on datastore errors
- Files: src/features/auth/middleware/rateLimit.ts
- Issue: DB エラー時に rate limit を素通ししており、認証 API 群が防御なしで継続実行される。
- Why this matters: 攻撃者が意図的にカウンタ保存を失敗させる、または DB 障害時に総当たり防御が無効化される。
- Suggested fix: 高リスクの auth endpoint は fail-closed か、少なくとも in-memory / edge fallback を持たせる。

## Residual Risk

- `src/app/signup/**` 自体は存在せず、レビュー対象は signup 相当の OTP / register 導線に読み替えている。
- Confirm の失敗時レスポンスはクリーン URL リダイレクトで統一されており、即時のトークン露出は確認していない。
- CSP / HSTS は設計上実装済み扱いだが、今回のスコープでは proxy 設定の本番値までは再検証していない。