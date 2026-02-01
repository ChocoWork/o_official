# 認証 (Auth) シーケンス図 — Mermaid

以下は `docs/specs/01_auth.md` の主要フローと運用・非機能要件を網羅した Mermaid シーケンス図です。

```mermaid
sequenceDiagram
    autonumber
    participant User as ユーザ
    participant Browser as ブラウザ
    participant API as API サーバ
    participant Auth as AuthService (Supabase)
    participant Mail as MailService
    participant DB as Postgres (users/sessions)
    participant Audit as AuditLog

    Note over User,Browser: ユーザ登録フロー
    User->>Browser: 登録フォーム入力
    Browser->>API: POST /api/auth/register {email,password,...profile}
    API->>Auth: Create user via Supabase Auth (redirect_to => /api/auth/confirm)
    Auth->>DB: INSERT users (managed by Supabase)
    DB-->>Auth: user created
    Auth->>Mail: send confirmation email (Supabase template)
    API->>Audit: auth.register (created)
    API-->>Browser: 201 Created (登録完了。確認メールを送信)

    Note over Mail,User: 確認メール (例: /auth/v1/verify?token=...&type=signup&redirect_to=/api/auth/confirm)
    Mail-->>User: 確認メール送信

    Note over User,Auth: メール内リンクをクリック -> 自動ログイン（サーバ側確認）
    User->>Auth: GET /auth/v1/verify?token=...&type=signup&redirect_to=/api/auth/confirm
    Auth-->>User: Supabase verifies token, redirects to /api/auth/confirm?token=...
    User->>API: GET /api/auth/confirm?token=...
    API->>Auth: Server-side verify token using SUPABASE_SERVICE_ROLE_KEY
    Auth->>DB: Confirm user record (email_confirmed)
    Auth-->>API: verification success
    API->>DB: Create session / INSERT sessions (refresh_token_hash, expires_at)
    API->>Browser: Set-Cookie (HttpOnly, Secure, SameSite=Lax)
    API->>Audit: auth.confirm (success) + auth.login (auto)
    API-->>Browser: Redirect to /account (ログイン済み状態)
    Note right of Browser: UI update — Header shows ri-user-fill linking to /account

    Note right of API: 運用上の必須ルール:
    Note right of API: - `SUPABASE_SERVICE_ROLE_KEY` はサーバ側のみ保持（Secrets Manager 推奨）
    Note right of API: - `redirect_to` はホワイトリストで検証（オープンリダイレクト防止）
    Note right of API: - トークンは即時消費（ワンタイム化）し、ログに平文で保存しない（マスキング）
    Note right of API: - レート制限・監査ログ・Referrer-Policy: no-referrer を付与

    Note over User,API: ログインフロー
    User->>Browser: ログイン情報送信
    Browser->>API: POST /api/auth/login {email,password}
    API->>Auth: Verify credentials
    Auth->>DB: SELECT users
    DB-->>Auth: user row
    Auth-->>API: Issue access_token (15m) + refresh_token (7d sliding)
    API->>DB: INSERT sessions (refresh_token_hash, expires_at)
    API->>Browser: Set-Cookie (HttpOnly, Secure, SameSite=Lax)
    API->>Audit: auth.login (success)

    Note over User,API: パスワードリセット要求 (request)
    User->>Browser: パスワードリセット要求フォーム送信
    Browser->>API: POST /api/auth/password-reset/request {email}
    API->>Auth: Generate password reset token (expires 1h)
    API->>DB: INSERT password_reset_tokens (hashed token, expires_at)
    API->>Mail: send reset email (含 token)
    Mail-->>User: パスワード再設定メール送信
    API->>Audit: auth.password_reset.request

    Note over User,API: パスワード再設定確定 (confirm)
    User->>Browser: リセットフォーム入力 (token,newPassword)
    Browser->>API: POST /api/auth/password-reset/confirm {token,newPassword}
    API->>DB: Validate token (check hashed token & expires_at)
    DB-->>API: token valid / or invalid
    alt valid
        API->>Auth: Update password_hash (Argon2/Bcrypt 推奨)
        API->>DB: Revoke related sessions (revoked_at)
        API->>Audit: auth.password_reset.confirm
        API-->>Browser: 200 OK
    else invalid
        API->>Audit: auth.password_reset.confirm_failure
        API-->>Browser: 400/401
    end

    Note over Browser,API: リフレッシュ (トークンローテーション)
    Browser->>API: POST /api/auth/refresh (HttpOnly Cookie)
    API->>DB: Lookup session by refresh_token_hash
    DB-->>API: session row
    API->>Auth: Issue new access_token + new refresh_token
    API->>DB: Update session refresh_token_hash -> new hash, expires_at
    alt refresh token mismatch
        API->>DB: Revoke all user sessions
        API->>Audit: auth.refresh.failure
        API-->>Browser: 401 Unauthorized
    else success
        API->>Audit: auth.refresh.success
        API-->>Browser: 200 OK + Set-Cookie (rotated)
    end

    Note over Browser,API: ログアウト
    Browser->>API: POST /api/auth/logout (HttpOnly Cookie)
    API->>DB: Mark session revoked_at
    API->>Audit: auth.logout
    API-->>Browser: 204 No Content

    Note over API,Audit: 監査ログは JSON Lines フォーマットで出力
    Audit-->>DB: append audit entry {id,timestamp,actor_id,actor_email,action,resource,resource_id,ip,user_agent,outcome,metadata}

    Note over API,Auth: セキュリティ・運用・非機能（要点）
    Note right of API: - 環境変数 / シークレット:
    Note right of API:   JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AWS_SES_* or SENDGRID_API_KEY, SES_FROM_ADDRESS, NEXT_PUBLIC_*
    Note right of API: - Cookie 設計: HttpOnly, Secure, SameSite=Lax
    Note right of API: - CSRF: 同期トークン/ダブルサブミットまたは適切な SameSite
    Note right of API: - パスワードハッシュ: Argon2 または Bcrypt を推奨
    Note right of API: - ネットワーク/IP 制限・最小権限・監査ログ・即時ローテーション体制
    Note right of API: - 非機能要件: TLS/HSTS 必須, 認証 API 応答 95% < 200ms など
    Note right of API: - トークン寿命: access 15m / refresh 7d (sliding, max 30d) / pw-reset 1h / email-confirm 24h
    Note right of API: - 運用: SUPABASE_SERVICE_ROLE_KEY の保管は Secrets Manager。定期ローテーションと自動化必須
    Note right of API: - ログ出力はトークン等をマスク。クエリ文字列をそのまま保存しない

    Note over API,Auth: OpenAPI / エラーハンドリング
    Note right of API: - 共通エラー: 400 (validation), 401 (invalid credentials), 429 (rate limit)
    Note right of API: - 各エンドポイントは OpenAPI で定義し契約テストを推奨

```