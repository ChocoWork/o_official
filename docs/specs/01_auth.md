# タイトル
- `認証 (Auth)`

## 概要
- 目的: メール/パスワード認証を中心に、ユーザープロファイル管理とパスワード再発行を提供する認証基盤。セキュリティ運用要件（トークン寿命、リフレッシュ、CSRF、セッション失効）を含む。
- 背景: Next.js + Supabase Auth を前提とした EC サイトの認証基盤。ソーシャルログインは UI 表示のみ（実装は別タスク）。

注: 本仕様は Supabase Auth の挙動（サインアップ時の確認メール、`/auth/v1/verify` エンドポイント、`redirect_to` パラメータなど）を前提に記述しています。実装時は公式ドキュメント https://supabase.com/docs/guides/auth/ を参照してください。

## 範囲 (In / Out)
- 含むもの:
  - メール/パスワード登録、ログイン、パスワードリセット、セッション管理、顧客プロファイル保存（名前、フリガナ、住所、電話）。
  - 認証に関する監査ログ、CSRF 対策、トークン運用方針。
- 含まないもの:
  - SSO フェデレーション、外部 IdP のフェデレーション（別タスク）、高度な MFA（別タスク）。

## 用語定義
 シークレット管理: `JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` 等は Secrets Manager で管理
- JWT: JSON Web Token
- TOTP: Time-based One-time Password (二段階認証)
   - 受け入れ基準: 201 Created、ユーザレコード作成。重複メールは拒否。
   - 依存: メール送信プロバイダ
2. ログイン（必須）
   - 受け入れ基準: 200 OK + セッション Cookie（HttpOnly）発行
   - 依存: Rate limiter, ブルートフォース検出
 **Service Role キーの管理（必須）**: `SUPABASE_SERVICE_ROLE_KEY`（service role / service role key）はサーバー側の環境変数にのみ保持し、ソース管理 (VCS) やクライアントに決して含めないこと。キーは Secrets Manager（または Vercel の Environment Variables）で保管し、ローテーション手順を運用に含めること。
3. パスワードリセット（必須）
 環境変数: `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SENDGRID_API_KEY`
   - 依存: メール送信
  ---
  title: "認証 (Auth)"
  task: [DOC-01]
  ---

  # 認証 (Auth)

  更新概要:
  - `docs/specs/01_auth.md` を読みやすく章立てし、以下の主要機能を明確化しました: 新規登録、ログイン、ログアウト／セッション管理、パスワード再設定、OAuth (Google) のフル実装。メール送信は Amazon SES を利用する前提に更新しています。`SUPABASE_SERVICE_ROLE_KEY` の運用ポリシーは要相談として残しています。

  ## 1. 概要
  - 目的: メール/パスワード認証を中心に、ユーザープロファイル管理とパスワード再発行を提供する認証基盤。セキュリティ運用要件（トークン寿命、リフレッシュ、CSRF、セッション失効）を含む。
  - 背景: Next.js + Supabase Auth を前提とした EC サイト。OAuth（Google）は本仕様でフル実装範囲とします。

  > 注: 本仕様は Supabase Auth の挙動（サインアップ時の確認メール、`/auth/v1/verify`、`redirect_to`）を前提にします。実装時は https://supabase.com/docs/guides/auth/ を参照してください。

  ## 2. 範囲 (In / Out)
  - 含む:
    - メール/パスワード登録、ログイン、パスワードリセット、セッション管理、顧客プロファイル（名前、フリガナ、住所、電話）
    - OAuth (Google) のフル実装（認可フロー、アカウントリンク、既存ユーザ解決）
    - 監査ログ、CSRF 対策、トークン運用
  - 含まない:
    - SSO フェデレーション（企業向け SAML 等は別タスク）

  ## 3. 用語・環境変数
  - 重要な環境変数（運用で管理）:
    - `JWT_SECRET`
    - `SUPABASE_URL`
    - `SUPABASE_SERVICE_ROLE_KEY` (運用ポリシー要相談)
    - `AWS_SES_REGION`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `SES_FROM_ADDRESS`
    - `NEXT_PUBLIC_...` 系はクライアント公開用に限定
  - 用語:
    - JWT: JSON Web Token
    - TOTP: Time-based One-time Password

  ## 4. 主要機能（章立て）

  ### 4.1 新規登録 (Register)
  - Endpoint: `POST /api/auth/register`
    - Request: { "email": string, "password": string, ...profile }
    - Response: 201 Created
  - 挙動:
    - Supabase の確認メールを利用し、メール内 `redirect_to` を `/api/auth/confirm` に設定する
    - `/api/auth/confirm` は受け取った `token` を server-side (service role) で検証し、成功時に HttpOnly セッション Cookie を発行してユーザーを自動ログインする
    - 確認トークンはワンタイム化し、検証後は無効化する
  - バリデーション: RFC準拠の `email`、パスワードは最低8文字（英数字＋記号推奨）
    - 推奨ライブラリ: Zod

  ### 4.2 ログイン (Login)
  - Endpoint: `POST /api/auth/login`
    - Request: { "email": string, "password": string }
    - Response: 200 OK + Set-Cookie (HttpOnly セッション)
  - 要件:
    - レートリミッタとブルートフォース保護
    - 監査ログへの成功/失敗記録
    - フロントは `onAuthStateChange` を使いヘッダー表示を更新 (see `src/app/components/LoginContext.tsx`, `Header.tsx`)

  ### 4.3 ログアウト / セッション管理 (Logout & Session Management)
  - Endpoint: `POST /api/auth/logout` (204)
  - Endpoint: `POST /api/auth/refresh` (200 + Set-Cookie)
    - リフレッシュ時はトークンローテーションを行い、`refresh_token_hash` を DB にハッシュ保存して照合
    - 無効なリフレッシュは 401 を返し、必要なら全セッション失効
  - 管理用: `POST /api/auth/revoke-user-sessions` — 指定ユーザーの全セッションを `revoked_at` で失効

  ### 4.4 パスワード再設定 (Password Reset)
  - Request: `POST /api/auth/password-reset/request` { email }
    - 200: メール送信処理開始（Amazon SES を使用）
  - Confirm: `POST /api/auth/password-reset/confirm` { token, newPassword }
    - トークン寿命: 1時間。ワンタイムかつ即時消費。メールテンプレートは SES で管理。

  ### 4.5 OAuth (Google) — フル実装
  - 範囲:
    - OAuth 2.0 認可コードフローの実装（サーバー側でトークン交換）
    - 新規ユーザー作成 or 既存アカウントへのリンク処理
    - 安全な `redirect_uri` ホワイトリスト検証
    - 監査ログ記録・エラー処理・ユーザ通知

  ## 5. セキュリティ設計・運用 (Security & Ops)
  - Service Role キー管理:
    - `SUPABASE_SERVICE_ROLE_KEY` の保存場所・アクセス制御は未決定のため要相談。デフォルト方針は Secrets Manager（Vault / Vercel 環境変数）で厳格に管理し、最小権限の運用を推奨
  - Cookie 設計: `HttpOnly; Secure; SameSite=Lax`
  - リダイレクト制御: `redirect_to` はホワイトリストで検証（オープンリダイレクト防止）
  - Referrer-Policy: `no-referrer` を `/api/auth/confirm` のレスポンスに付与
  - ログと監査: トークン等は平文で保存しない（マスキング）
  - レート制限 / 不正検出: 認証系エンドポイント全般に適用

  ## 6. トークン寿命（再掲）
  - Access token: 15 分
  - Refresh token: 7 日（スライディング）、最大延長 30 日
  - Password reset token: 1 時間
  - Email confirmation token: 24 時間

  ## 7. API 仕様・エラーハンドリング
  - 共通エラー: 400 (validation), 401 (invalid credentials), 429 (rate limit)
  - 各エンドポイントの入出力は OpenAPI で定義し、契約テストを実施する

  ### OpenAPI スニペット（例）
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

  ## 8. データモデル / マイグレーション
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

  ※ パスワードリセット用や OAuth リンク用のテーブル（例: `password_reset_tokens`, `oauth_accounts`）は別マイグレーションで追加することを推奨。

  ## 9. バリデーションルール
  - `email`: RFC 準拠
  - `password`: 最低 8 文字、英数字 + 記号推奨
  - ライブラリ: Zod を Front/Back 両方で使用

  ## 10. 監査・観測・テスト
  - 監査ログ対象: login success/fail, refresh, logout, password change, oauth link
  - フォーマット: JSON Lines（例を下記に示す）

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

  - E2E: メール確認リンククリック→自動ログイン→`Header` が `ri-user-fill` に変わることを必須とする

  ## 11. 実装ノート
  - 推奨スタック: Next.js API routes + Supabase Postgres/Auth
  - メール送信: Amazon SES を使用する（SES の送信設定、DKIM/SPF, From address の設定を運用で行う）
  - 環境変数: `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (運用ポリシー要相談), `AWS_SES_*`

  ## 12. 担当 / 依存
  - 担当: Backend (Auth API), Frontend (UI/Forms)
  - 依存: Amazon SES, Supabase

  ## 13. 受け入れ基準（まとめ）
  - 新規登録: 201
  - ログイン: 200 + セッション発行
  - パスワード再設定メール送信: 200
  - リフレッシュ: トークンローテーション + revocation

  ## 14. 未解決・相談事項
  - `SUPABASE_SERVICE_ROLE_KEY` の取り扱い（Secrets Manager vs 他、アクセス制御・ローテーション方針） — 要議論
  - 監査ログの保持期間とアーカイブポリシー
  - OAuth アカウント衝突解決ポリシー（自動マージか別ユーザーか）

  ## 15. チケット分割例
  - TASK-1: `POST /api/auth/register` 実装（メール確認 + `/api/auth/confirm`）
  - TASK-2: `POST /api/auth/login` 実装
  - TASK-3: パスワードリセットフロー + SES 統合
  - TASK-4: OAuth (Google) 実装（認可フロー・アカウントリンク・マイグレーション）

  ---


- **redirect_to のホワイトリスト（必須）**: `redirect_to` パラメータは必ずホワイトリストで検証し、許可された自ドメインのパス以外にはリダイレクトしないこと（オープンリダイレクト対策）。
- **ログ出力のマスキング（必須）**: 監査ログやサーバーログに確認トークンやリフレッシュトークンを平文で保存しない。監査ログには event, actor, ip, user_agent, outcome のみを残し、トークンはマスクまたは除外すること。
  - リクエストの URL やクエリ文字列をそのままログに保存しないこと。どうしても保存が必要な場合は、クエリ内のトークン部分を確実にマスクして保存すること。
- **ワンタイムトークン再利用検出（必須）**: トークンの再利用が検出された場合は該当ユーザーの全セッションを失効させ、セキュリティアラートを発行する運用を準備すること。
- **Cookie 設定（必須）**: セッション Cookie は `HttpOnly; Secure; SameSite=Lax` を最低限付与し、Refresh トークンは DB にハッシュ保存する。ドメイン/Path を正しく設定し、`secure` を必須とする。
- **レート制限 / 不正検出（必須）**: `/api/auth/confirm` を含む確認・認証エンドポイントにはレート制限を実装し、異常な試行は IP ブロックや監査ログ出力のトリガーとすること。
- **CORS とオリジン制御（必須）**: API の CORS 設定は最小限の許可オリジンに限定すること。
- **運用ドキュメント（必須）**: SUPABASE のキーのローテーション手順、発見時の対応手順（キー漏洩時の即時ローテーション・再発行とデプロイ手順）を運用ドキュメントとして整備すること。

これらの対策は実装前に必須でレビューし、デプロイ前に E2E テスト（メールリンククリック → 自動ログイン → Header が `ri-user-fill` に変わること）で確認してください。

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
- 環境変数: `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SENDGRID_API_KEY`
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

