# タイトル
- `認証 (Auth)`

## 概要
- 目的: メール/パスワード認証を中心に、ユーザープロファイル管理とパスワード再発行を提供する認証基盤。セキュリティ運用要件（トークン寿命、リフレッシュ、CSRF、セッション失効）を含む。
- 背景: Next.js + Supabase を想定した EC サイトの認証基盤。ソーシャルログインは UI 表示のみ（実装は別タスク）。

## 範囲 (In / Out)
- 含むもの:
  - メール/パスワード登録、ログイン、パスワードリセット、セッション管理、顧客プロファイル保存（名前、フリガナ、住所、電話）。
  - 認証に関する監査ログ、CSRF 対策、トークン運用方針。
- 含まないもの:
  - SSO フェデレーション、外部 IdP のフェデレーション（別タスク）、高度な MFA（別タスク）。

## 用語定義
- RLS: Row Level Security
- JWT: JSON Web Token
- TOTP: Time-based One-time Password (二段階認証)

## 機能要件
1. ユーザ登録（必須）
   - 受け入れ基準: 201 Created、ユーザレコード作成。重複メールは拒否。
   - 依存: メール送信プロバイダ
   - 推定工数: 1-2d
2. ログイン（必須）
   - 受け入れ基準: 200 OK + セッション Cookie（HttpOnly）発行
   - 依存: Rate limiter, ブルートフォース検出
   - 推定工数: 1-2d
3. パスワードリセット（必須）
   - 受け入れ基準: 再設定トークン発行（有効期限 1h）、再設定成功で 200
   - 依存: メール送信
   - 推定工数: 1d
4. セッション管理（必須）
   - 受け入れ基準: ログアウトで即時セッション失効、リフレッシュでトークンローテーション
   - 推定工数: 1-2d
5. 監査ログ（必須）
   - 受け入れ基準: 重要操作が構造化ログで保存されること

## 非機能要件
- パスワード: Argon2/Bcrypt を推奨
- TLS/HSTS: 必須
- パフォーマンス: 認証 API 応答 95% < 200ms
- 可用性: 認証は高可用化
- シークレット管理: `JWT_SECRET`, `SUPABASE_SERVICE_KEY` 等は Secrets Manager で管理

## API / インターフェース
- POST `/api/auth/register`
  - Request: { "email": string, "password": string }
  - Response: 201 Created
- POST `/api/auth/login`
  - Request: { "email": string, "password": string }
  - Response: 200 OK + Set-Cookie (session)
- POST `/api/auth/password-reset/request`
  - Request: { "email": string }
  - Response: 200 OK
- POST `/api/auth/password-reset/confirm`
  - Request: { "token": string, "newPassword": string }
  - Response: 200 OK
- POST `/api/auth/refresh`
  - 説明: Cookie (HttpOnly) のリフレッシュトークンでアクセストークンと新リフレッシュトークンを発行する
  - Response: 200 OK + Set-Cookie
- POST `/api/auth/logout`
  - 説明: 現セッションを失効（204 No Content）

エラー共通: 400 (validation), 401 (invalid credentials), 429 (rate limit)

### OpenAPI スニペット (例)
```yaml
paths:
  /api/auth/login:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                email:
                  type: string
                password:
                  type: string
      responses:
        '200':
          description: OK
```

## データモデル
```sql
-- users テーブル
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  display_name text,
  kana_name text,
  phone text,
  address jsonb,
  created_at timestamptz DEFAULT now()
);

-- sessions テーブル
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  refresh_token_hash text NOT NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz NULL,
  last_seen_at timestamptz
);
```

## バリデーションルール
- `email`: RFC 準拠
- `password`: 最低 8 文字、英数字 + 記号を推奨
- 推奨ライブラリ: Zod (フロント/バック双方)

## テストケース（受け入れ基準）
- 正常系: 登録 -> ログイン -> プロファイル参照
- 異常系: 重複メールで 400, 誤パスワードで 401
- E2E: 購入フローと連携する認証シナリオ

## マイグレーション影響
- `users` / `sessions` テーブル追加。既存データがある場合は移行スクリプト・バックアップ・ロールバック指示を準備。

## セキュリティ / プライバシー考慮 (実務仕様)
### トークン寿命
- アクセストークン: 15 分
- リフレッシュトークン: 7 日 (スライディング)、最大延長 30 日
- パスワードリセットトークン: 1 時間
- メール確認トークン: 24 時間

### リフレッシュフロー
- POST `/api/auth/refresh`: Cookie のリフレッシュトークンを検証し、トークンローテーションを実施。無効は 401。

### セッション無効化 / ログアウト
- POST `/api/auth/logout`: 現セッションを `revoked_at` で失効する。応答 204。

### 強制ログアウト
- POST `/api/auth/revoke-user-sessions`: 指定ユーザのすべてのセッションを失効。

### CSRF 実装パターン
- Cookie: `HttpOnly; Secure; SameSite=Lax` を推奨
- CSRF トークン: 同期トークン方式またはダブルサブミット方式を併用。`X-CSRF-Token` ヘッダで検証。

### ローテーションと不正検出
- リフレッシュ時に `refresh_token_hash` の突合を行い、不一致は全セッション失効 + アラート。

### 監査ログ（認証関連）
- ログ対象: ログイン成功/失敗、リフレッシュ、ログアウト、セッション失効、パスワード変更
- フォーマット: JSON Lines、WORM/署名保管推奨
```json
{
  "id": "uuid",
  "timestamp": "2025-01-01T12:00:00Z",
  "actor_id": "uuid",
  "actor_email": "admin@example.com",
  "action": "auth.login",
  "resource": "users",
  "resource_id": "uuid",
  "ip": "203.0.113.1",
  "user_agent": "Mozilla/5.0...",
  "outcome": "success|failure",
  "metadata": {}
}
```

## 実装ノート
- 推奨スタック: Next.js API routes + Supabase Postgres/Auth
- 環境変数: `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SENDGRID_API_KEY`
- トークンは最小単位（整数）や期限の検証をサーバ側で必ず行う

## 関連ドキュメント
- docs/ECSiteSpec.md

## 担当 / 依存
- 担当: Backend (Auth API), Frontend (UI/Forms)
- 依存: SendGrid 等メールプロバイダ、Supabase

## 受け入れ基準（まとめ）
- 新規登録 201
- ログイン 200 + セッション発行
- パスワード再設定メール送信 200
- リフレッシュ処理がトークンローテーションと revocation を行う

## チケット分割例
- TASK-1: `POST /api/auth/register` 実装
- TASK-2: `POST /api/auth/login` 実装
- TASK-3: パスワードリセットフロー実装

