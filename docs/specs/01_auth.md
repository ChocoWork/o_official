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
- シークレット管理: `JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` 等は Secrets Manager で管理

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

### Supabase 確認 / 自動ログインフロー（追加仕様）

- 背景: Supabase はサインアップ直後にユーザーへ確認メールを送信します（メール内リンクは `/auth/v1/verify` へ向かう）。確認完了後にユーザが再度手動でログインする必要があると離脱の原因となるため、確認リンクをクリックした際に可能な限り自動でセッションを発行し、ユーザーをログイン状態にする仕組みを設計します。

- フロー（高レベル）:
  1. ユーザーがサインアップフォームで登録すると、Supabase Auth が確認メールを送信する（テンプレートは下記参照）。確認リンクは例として次の形式になる:

     https://pjidrgofvaglnuuznnyj.supabase.co/auth/v1/verify?token=cbf9625...&type=signup&redirect_to=https://example.com/api/auth/confirm

  2. 確認メール内の `redirect_to` は我々のアプリの専用エンドポイント（例: `/api/auth/confirm`）を指すように Supabase 側で設定する。
  3. ユーザーがリンクをクリックすると Supabase がメール確認を行い、その後 `redirect_to` にリダイレクトする。
  4. リダイレクト先のサーバー側エンドポイント（`/api/auth/confirm`）はクエリに含まれる `token` を受け取り、サーバー側（Supabase の service_role キーを使用）でトークン検証とセッション発行を行う。
     - 検証に成功したら、サーバーは HttpOnly なセッション Cookie（Refresh トークン等）を発行し、ユーザーをログイン状態にしたうえでフロントエンドの適切なページ（例: `/account`）にリダイレクトする。
     - 検証に失敗した場合はエラーページへ遷移させ、手動ログイン手順を案内する。

- 実装ノート（安全に実装するための指針）:
  - サーバーでのトークン検証・セッション発行には `SUPABASE_SERVICE_ROLE_KEY`（service role）を使用する。service role は非常に権限が強いため、該当エンドポイントは認可・ログ記録・レート制限を厳格に行う。
  - `/api/auth/confirm` はトークンの検査後に `revocation` を適切に行い、同一トークンの再利用を防止する。
  - セッション Cookie は `HttpOnly; Secure; SameSite=Lax` を付与する（cookie 設計は本仕様と同様）。
  - この設計は Supabase が発行する確認リンクと `redirect_to` の挙動に依存するため、Supabase 側のメール設定（Site URL / Redirect URLs）を正しく設定すること。

参考: Supabase の Auth ドキュメント https://supabase.com/docs/guides/auth/

UI 挙動（追加仕様）:
- 確認リンク経由で `/api/auth/confirm` が成功し、サーバーがセッション Cookie を発行して `/account` にリダイレクトした場合、フロントエンドはログイン済み状態を正しく反映する必要があります。
- 具体的には、ヘッダーコンポーネント（`src/app/components/Header.tsx`）内のユーザーアイコンは未ログイン時はアウトラインの `ri-user-line` を表示し、ログイン済み時は塗りつぶしの `ri-user-fill` を表示してリンク先を `/account` にすること。
- クライアント側の認証状態はアプリ起動時に Supabase のセッションを確認し、`onAuthStateChange` を購読して更新する設計とします（`src/app/components/LoginContext.tsx` にて実装）。

必須のセキュリティ対策（運用ルール）:
- **Service Role キーの管理（必須）**: `SUPABASE_SERVICE_ROLE_KEY`（service role / service role key）はサーバー側の環境変数にのみ保持し、ソース管理 (VCS) やクライアントに決して含めないこと。キーは Secrets Manager（または Vercel の Environment Variables）で保管し、ローテーション手順を運用に含めること。
- **確認トークンの漏洩対策（必須）**: メール確認トークンが URL クエリに含まれるため、受信後は **即時消費（ワンタイム化）** し、最終画面へのリダイレクトではクエリを含めないこと。サーバー側でトークンの検証後にトークンを無効化するワークフローを実装すること。
- **Referer/Referrer-Policy（必須）**: `/api/auth/confirm` のレスポンスに `Referrer-Policy: no-referrer` を付与して、外部への Referer でトークンが漏れないようにすること。
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

