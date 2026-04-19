# Code Review: Auth Security Hardening
**Ready for Production**: No
**Critical Issues**: 3

## Priority 1 (Must Fix) ⛔

### 1. Account-based rate limiting is effectively bypassed
- Files:
  - [src/features/auth/ratelimit/index.ts](src/features/auth/ratelimit/index.ts#L16)
  - [migrations/033_auth_security_hardening.sql](migrations/033_auth_security_hardening.sql#L48)
  - [migrations/005_create_rate_limit_counters.sql](migrations/005_create_rate_limit_counters.sql#L12)
  - [src/app/api/auth/login/route.ts](src/app/api/auth/login/route.ts#L29)
  - [src/app/api/auth/identify/route.ts](src/app/api/auth/identify/route.ts#L41)
  - [src/app/api/auth/password-reset/request/route.ts](src/app/api/auth/password-reset/request/route.ts#L37)
- Issue:
  - subject 指定時に ip を null に落として endpoint 側へ subject を埋め込んでいますが、DB 側の一意制約は UNIQUE(ip, endpoint, bucket) のままです。PostgreSQL の UNIQUE は null を同値扱いしないため、ip=null の行は衝突せず、ON CONFLICT が発火しません。
  - その結果、メールアドレス単位のレート制限は毎回 count=1 の新規行になり、実質的に無効です。
- Why this matters:
  - ログイン総当たり、OTP 送信乱発、パスワードリセットメール爆撃を、今回追加した「アカウント単位制限」で止められません。今回のセキュリティ修正の中心が無効化されています。
- Suggested fix:
  - subject 専用の列を追加して UNIQUE(subject, endpoint, bucket) に分ける、または NULLS NOT DISTINCT を使う一意制約へ変更する。
  - 少なくとも RPC の衝突条件とテーブル制約を一致させる必要があります。

### 2. Password reset breaks for users outside the first 200 accounts
- Files:
  - [src/app/api/auth/password-reset/request/route.ts](src/app/api/auth/password-reset/request/route.ts#L44)
  - [src/app/api/auth/password-reset/confirm/route.ts](src/app/api/auth/password-reset/confirm/route.ts#L52)
- Issue:
  - request/confirm の両方で listUsers({ page: 1, perPage: 200 }) の先頭 200 件だけを走査して user_id を解決しています。
  - 201 件目以降のユーザーは token 発行時に user_id が入らず、confirm 時も再解決できず 404 になります。
- Why this matters:
  - 本番データが 200 ユーザーを超えた時点で、一部ユーザーのパスワード再設定が永続的に失敗します。セキュリティ強化のためのフロー変更が、認証復旧手段そのものを壊しています。
- Suggested fix:
  - password_reset_tokens に user_id を確実に保存できる手段へ戻すか、Supabase Admin API の検索をページングで最後まで追う実装にする。
  - 可能なら email ではなく user_id を発行時点で固定する設計に戻すべきです。

### 3. Admin create-user UI is now broken by CSRF enforcement
- Files:
  - [src/app/api/admin/create-user/route.ts](src/app/api/admin/create-user/route.ts#L16)
  - [src/app/admin/create-user/page.tsx](src/app/admin/create-user/page.tsx#L28)
- Issue:
  - API 側は requireCsrfOrDeny() を必須化していますが、呼び出し元 UI は素の fetch で x-csrf-token を送っていません。
  - 認証済み管理者が画面からユーザー作成すると 403 になります。
- Why this matters:
  - セキュリティ修正が管理者運用を直接停止させています。管理系機能は復旧時のオペレーションにも使うため、ここが塞がる影響は大きいです。
- Suggested fix:
  - [src/app/admin/create-user/page.tsx](src/app/admin/create-user/page.tsx#L28) を clientFetch ベースへ統一するか、既存 logout と同様に CSRF Cookie から x-csrf-token を明示付与する。

## Recommended Changes

### 4. Internal authorization error details are exposed to clients
- File:
  - [src/lib/auth/admin-rbac.ts](src/lib/auth/admin-rbac.ts#L164)
- Issue:
  - authorizeAdminPermission() の例外時に err.message をそのまま details として返しています。
- Why this matters:
  - 認可基盤の障害時に、DB エラーや内部構成が外部へ漏れる可能性があります。
- Suggested fix:
  - クライアント返却は固定メッセージにして、詳細はサーバログへ限定してください。