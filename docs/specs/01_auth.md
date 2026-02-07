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
 環境変数: `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AWS_SES_REGION`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `SES_FROM_ADDRESS`
   - 依存: メール送信 (Amazon SES)
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
    - セキュリティ（トークン in URL の即時交換/消去）: サービスは受信したクエリの `token` を受け取ったら即時サーバ側で検証・消費（ワンタイム化）し、Set-Cookie を発行した後にクリーンなパス（例: `/account` または `/auth/confirmed`）へ 302/303 リダイレクトして URL にトークンを残さないこと。レスポンスには `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を付与し、トークンをログに保存しない（マスキング）ことを必須化する。可能であればサーバ側で検証→交換→リダイレクトを行い、ブラウザ側でトークンを露出しない設計（POST を使う交換パターン等）を優先する。
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
    - 実装要点:
      - 各 refresh トークンに **JTI (unique id)** を付与し、sessions レコードに `current_jti` を保存
      - refresh は一回限り（単一使用）。Refresh リクエスト時に DB の `current_jti` と照合し、成功したら新しい refresh を発行して `current_jti` を差し替える
      - 古い refresh が再利用された場合は「再利用検出」とし、まずは当該アカウントを**準隔離 (quarantine)** 状態に移行して監査ログ出力・ユーザ通知・管理者アラートを発行する。
      - システムは IP / 地理位置 / 時刻 / 過去のイベント 等に基づくリスクスコアを算出し、リスクが閾値を超える場合は自動的に**全セッションを失効（強制ログアウト）**する。閾値未満の場合は追加確認（メールリンク確認や 2FA）を要求し、ユーザが確認できない場合は最終的に失効を実施する。
      - 再利用検出の誤用（DoS）を防ぐため、再利用検出処理自体にもレート制限としきい値を適用すること。管理コンソールから即時全失効が実行できることを運用要件とする。
    - 無効なリフレッシュは 401 を返し、必要なら全セッション失効
  - 管理用: `POST /api/auth/revoke-user-sessions` — 指定ユーザーの全セッションを `revoked_at` で失効
  - 同時セッション数 / 強制ログアウト:
    - 方針: **On（デフォルト有効）**。上限: **ユーザ単位上限 5 セッション**。
    - 超過時: 最古セッションを自動削除する **ローテーション方式** を採用（UX を配慮）
    - 管理画面で上限値の変更およびセッションの列挙/個別リボークを可能にすること（管理者操作）

  ### 4.4 パスワード再設定 (Password Reset)
  - Request: `POST /api/auth/password-reset/request` { email }
    - 200: メール送信処理開始（Amazon SES を使用）
  - Confirm: `POST /api/auth/password-reset/confirm` { token, newPassword }
    - トークン寿命: 1時間。ワンタイムかつ即時消費。メールテンプレートは SES で管理。
    - セキュリティ（トークン in URL の取り扱い）: リセットリンクに含まれる `token` は受信時にサーバ側で検証・消費し、一時的な安全なセッション（または短寿命の one-time nonce）を発行してからクリーンな URL へリダイレクトすること。これによりブラウザ履歴や Referer にトークンが残らないようにする。JavaScript が無効な場合でも GET リクエストで受信した段階でサーバ側で即時検証→リダイレクト（トークン無効化）を行い、トークンが保存されないことを保証する。

  ### 4.5 OAuth (Google) — フル実装（詳細と安全設計）
  - 範囲:
    - OAuth 2.0 認可コードフロー（PKCE を含む）をサーバー側で実装し、トークン交換とプロファイル取得を行う。
    - 新規ユーザーの作成、既存ユーザーとのアカウントリンク（**自動マージは採用しない**）の実装。
    - 安全な `redirect_uri` のホワイトリスト検証と `state` / PKCE の検証による CSRF 対策。
    - 監査ログ（`auth.oauth.*`）の記録、ユーザ通知（リンク提案／リンク成功／異常検出）およびエラーハンドリング。

  - エンドポイント（例）:
    - `GET /api/auth/oauth/start?provider=google&redirect_to=...`  
      - サーバ側で `state` と PKCE の `code_challenge` を発行し、Provider へ redirect（`state` を Redis 等の短期キャッシュまたは `oauth_requests` テーブルに保持）。TTL と一回性を付与すること（推奨 TTL: 5–15 分、デフォルト 10 分）。
    - `GET /api/auth/oauth/callback?code=...&state=...`  
      - サーバ側で `state` を検証（再利用・期限切れ・client IP 等の整合性チェックを含む）し、トークン交換 → プロファイル取得（`email`, `email_verified`, `provider_user_id`, `raw_profile`）。ID token がある場合は JWKS による署名検証を必須化する（`sub`, `aud`, `exp` の検証）。
    - UI: `/auth/oauth/link-proposal?provider=google&provider_id=...`（既存メール一致時にユーザ同意を得るための画面）

  - 高優先度の追記（メール/パスワード仕様と揃えるための必須要件）
    - レート制限 / 不正検出:
      - `/api/auth/oauth/start` と `/api/auth/oauth/callback` は認証エンドポイント基準に従う（デフォルト: IP ベース・アカウント軸ともに **50 req / 10 min**）。異常検出時に Turnstile 挿入や一時ブロックを行う。IP/アカウント両軸での閾値超過は監査ログに記録すること。
    - state / PKCE の保存設計:
      - 保存場所: Redis 等の短期キャッシュを推奨。ただし運用上の理由で Postgres (`oauth_requests` テーブル) を採用しても可。保存内容: `state`, `code_challenge`, `code_challenge_method`, `redirect_to`, `client_ip`, `created_at`, `expires_at`, `used_at`。
      - TTL: 推奨 10 分 (5–15 分 の範囲)。ワンタイム使用を強制し、`used_at` を更新して再利用を拒否する。再利用や期限切れは監査ログ出力・アラートトリガーとする。
      - cleanup: 定期バッチで expired / used レコードを削除。
    - provider トークンの扱い:
      - デフォルト方針: Provider の `access_token` / `refresh_token` は**保存しない**（設計上は最小権限）。保存が必要な場合のみ明示的に許可する。
      - 保存する場合の要件: KMS（Vault/Cloud KMS）による暗号化、アクセスログ、トークン有効期限の管理、明確なローテーション・削除手順。ユーザが unlink したら即時削除。
    - DB 制約:
      - `oauth_accounts` に `(provider, provider_user_id)` のユニークインデックスを必須とする。衝突時は `409 Conflict` を返す。
      - `user_id` は `users(id)` の FK とし、ON DELETE 動作（例えば CASCADE）を運用ポリシーに従って設定する（破壊的変更時は事前承認）。
    - 再認証方式の詳細:
      - リンク実行時は常に再認証を要求。優先順は: 1) パスワード確認、2) メール確認リンク、3) 2FA（有効な場合）。再認証失敗時は `403 Forbidden` を返し、リンクは行わない。UX は明確なエラーメッセージと再試行/キャンセルを提供する。
    - エラー / ステータス設計:
      - `state` 検証失敗: `400 Bad Request`（監査ログ記録）
      - PKCE 検証失敗: `401 Unauthorized`（監査ログ記録）
      - 重複 `provider_user_id` のリンク試行: `409 Conflict`
      - Provider との交換失敗: `502 Bad Gateway`（Provider 問題）または `400 Bad Request`（パラメータ不正）
    - リダイレクトフローの安全化:
      - ブラウザに `code` / `token` を露出させないため、`callback` ではサーバ側で即時交換 → ワンタイム session / HttpOnly クッキーを発行 → クリーンな URL へ `302` リダイレクトすることを必須とする。レスポンスヘッダに `Cache-Control: no-store`, `Referrer-Policy: no-referrer` を付与する。
    - Provider 検証:
      - 受け取る ID token / profile の署名（JWKS）検証を必須化し、`sub` と `provider_user_id` の整合性、`aud`, `exp` の検証、`email_verified` の確認を行う。

  - 追加推奨・運用（中優先度）
    - PKCE/state の DB スキーマ例と TTL（例: 10 分）をドキュメント化し、cleanup ジョブを追加する。
    - `oauth_accounts` に `last_synced_at`, `raw_profile_hash`, `access_token_encrypted`, `refresh_token_encrypted`, `token_expires_at` カラムを追加（保存する場合のみ）。
    - 管理 API: OAuth unlink / re-link の管理 API と監査ログを定義すること。
    - Provider refresh token を保存する場合は KMS 暗号化 + アクセスログを必須化する。
    - OpenAPI に `start`, `callback`, `link-proposal`, `link-confirm`, `unlink` の定義を追加する。
    - E2E テストケース: 新規登録 / 既存メール→リンク提案→再認証成功・キャンセル・異常系（state 改竄、expired code、duplicated provider_user_id）を必ず含める。

  - テスト要件（追加）
    - 単体: state/PKCE の生成・検証・有効期限・再利用検出のテスト
    - 結合: Provider モックを用いて callback の正常系・異常系（expired, wrong state, wrong code）をテスト
    - セキュリティ: リプレイ攻撃、オープンリダイレクト検出、id_token 署名 (JWKS) 検証
    - E2E: UI のリンク提案フロー（承認／拒否）を自動化

  - 受け入れ基準（追記）
    - OAuth callback で `state`/PKCE 検証失敗は `400`/`401` を返し、監査ログに記録すること。
    - `oauth_accounts` に `(provider, provider_user_id)` のユニークキーが存在すること。
    - Provider の access/refresh token を保存する場合は、KMS 暗号化とアクセス監査が行われること。
    - すべての OAuth イベント（start/callback/link/unlink/失敗）は監査ログに記録されること。

  - DB スキーマ（追記例）
  ```sql
  CREATE TABLE oauth_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    state text NOT NULL UNIQUE,
    code_challenge text NOT NULL,
    code_challenge_method text NOT NULL,
    redirect_to text,
    client_ip inet NULL,
    created_at timestamptz DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz NULL
  );

  ALTER TABLE oauth_accounts
    ADD COLUMN IF NOT EXISTS last_synced_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS raw_profile_hash text NULL,
    ADD COLUMN IF NOT EXISTS access_token_encrypted text NULL,
    ADD COLUMN IF NOT EXISTS refresh_token_encrypted text NULL,
    ADD COLUMN IF NOT EXISTS token_expires_at timestamptz NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_provider_user ON oauth_accounts(provider, provider_user_id);
  ```

  - OpenAPI 例（追加）
  ```yaml
  paths:
    /api/auth/oauth/start:
      get:
        parameters:
          - name: provider
            in: query
            required: true
        responses:
          '302':
            description: Redirect to provider (state generated & stored)
    /api/auth/oauth/callback:
      get:
        parameters:
          - name: code
            in: query
            required: true
          - name: state
            in: query
            required: true
        responses:
          '200':
            description: Callback processed (or 400/401 on validation failure)
  ```

  - アカウント解決ポリシー（必須）:
    - Provider が返す `email_verified=true` の場合でも **自動マージは行わない**。既存メールと一致する場合は **リンク提案ページへ遷移**し、ユーザーの明示的承認を得た上でリンク（リンクには再認証を要求 — パスワード確認またはメール確認リンク）。
    - `email_verified=false` または Provider がメールを返さない場合は自動マージを行わず、ユーザーへ追加確認手順を提示する（メール確認 or 手動リンク）。

  - セキュリティ上の必須項目:
    - `state` の検証、PKCE の検証を必須化。`redirect_uri` はホワイトリストで検証。
    - 取得するプロファイルは最小限（email, email_verified, provider_user_id, name）とする。
    - すべての OAuth イベント（開始・callback・リンク成功・失敗）は監査ログへ記録する。

  - 受け入れ基準（例）:
    - OAuth 新規登録: 201 Created + セッション Cookie 発行。
    - OAuth 既存メール一致: リンク提案に遷移 → ユーザー承認 + 再認証でリンク完了（200）。
    - OAuth callback で `state`/PKCE 検証失敗は 400 / 401 を返す。

  - テスト計画（必須）:
    - 単体: PKCE/state 検証、プロファイルパース、oauth_accounts の CRUD。
    - 結合: Provider モックを用いて callback の正常系/異常系を確認。
    - E2E: OAuth フロー（新規登録 / 既存メール→リンク提案→リンク完了／キャンセル）を自動化。

  - 実装ノート:
    - 実装ファイル例: `src/app/api/auth/oauth/start/route.ts`, `src/app/api/auth/oauth/callback/route.ts`, `src/features/auth/oauth/handlers.ts`, `src/features/auth/schemas/oauth.ts`。
    - 監査: すべてのリンクイベントに `auth.oauth.link` の audit entry を追加する。

  - 仕様変更メモ:
    - 「自動マージは採用しない」という方針を仕様に明記しました。将来的に安全基準（厳格な `email_verified`、低リスクスコア、運用アラート）を満たす場合に限り、自動マージを再検討することができます。

  ## 5. セキュリティ設計・運用 (Security & Ops)
  - Service Role キー管理:
    - `SUPABASE_SERVICE_ROLE_KEY` の保存場所・アクセス制御は未決定のため要相談。デフォルト方針は Secrets Manager（Vault / Vercel 環境変数）で厳格に管理し、最小権限の運用を推奨
  - Cookie 設計:
    - 本番: `HttpOnly; Secure; SameSite=Lax` を必須
    - ローカル: `Secure=false` を許可するのは `NODE_ENV=development` または `ALLOW_INSECURE_COOKIES=true` が明示されている場合のみ
    - Access token: 基本はメモリ管理（短寿命、15 分）。必要に応じ短期 cookie を利用
    - Refresh token cookie: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`（7 日）を推奨（7 日は短めのデフォルト、運用でスライディング延長最大 30 日を選択可）
  - リダイレクト制御: `redirect_to` はホワイトリストで検証（オープンリダイレクト防止）
  - Referrer-Policy: `no-referrer` を `/api/auth/confirm` のレスポンスに付与
  - ログと監査: トークン等は平文で保存しない（マスキング）
  - レート制限 / 不正検出:
    - 一般 API (IP): **100 req / 10 min**
    - 認証エンドポイント (IP): **50 req / 10 min**
    - アカウント失敗カウント: パスワード誤り等の失敗はアカウント単位でカウントし、5 回失敗で段階的遅延/ロックアウトを適用（詳細は下記アルゴリズム参照）。
    - CAPTCHA: **Cloudflare Turnstile** を優先採用。登録 (`/api/auth/register`) およびパスワードリセット (`/api/auth/password-reset/request`) では常時表示し、ログインでは連続失敗や異常スコア閾値到達時に表示する **適応型** を採用する（4〜5 回失敗での挿入）。実装は Turnstile のサーバ検証とフロント統合を行う。
    - 実装メモ: Vercel のインスタンスローカルメモリはカウンタ保存に不向きなため、**Supabase(Postgres)** にカウンタ/メタデータを保持して分散制御を行うこと。IP とアカウントの二軸制御を必須とする。

  ## 6. トークン寿命（再掲）
  - Access token: 15 分
  - Refresh token: 7 日（スライディング）、最大延長 30 日
  - Password reset token: 1 時間
  - Email confirmation token: 24 時間

  ## 7. API 仕様・エラーハンドリング
  - 共通エラー: 400 (validation), 401 (invalid credentials), 429 (rate limit)
  - エラー構造 (OpenAPI 用スキーマ):

```json
{
  "type": "object",
  "properties": {
    "code": { "type": "string" },
    "message": { "type": "string" },
    "detail": { "type": "string" },
    "retry_after": { "type": "number", "description": "秒、オプション" }
  },
  "required": ["code","message"]
}
```

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

**注（設計決定、2026-02-01）**: `auth.users` を認証のソース・オブ・トゥルース（source-of-truth）とし、アプリ側のプロフィール情報は `public.profiles` テーブルに格納します。`migrations/002_create_profiles.sql` にて `profiles` テーブルを作成し、既存の `public.users` データを移行して `public.users` は `public.users_deprecated` にリネームしました。

  ## 9. バリデーションルール
  - `email`: RFC 準拠
  - `password`: 最低 8 文字、英数字 + 記号推奨
  - ライブラリ: Zod を Front/Back 両方で使用

  ## 10. 監査・観測・テスト
  - 監査ログ対象: login success/fail, refresh, logout, password change, oauth link
  - フォーマット: JSON Lines（例を下記に示す）
  - 保持期間・アクセス制御・マスキング:
    - 認証イベント（ログイン/失敗/トークン交換）: **1 年** 保持（例）
    - 管理操作: **3〜7 年**（規制に従う）
    - ログのマスキング: IP はハッシュ化または末尾のみ可視、トークンや敏感情報は記録しないか完全マスク
    - アクセス: RBAC による限定、ログの改竄検知（ハッシュチェーン）を導入することを推奨

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

  - E2E: メール確認リンククリック→自動ログイン→`Header` が `ri-user-fill` に変わることを必須とする。**自動化ポリシー**: 本番公開前に自動化を必須とし、今スプリントで CI スモークテストを導入、次スプリントで主要フロー（メールリンク含む）の自動 E2E を追加する。

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


- **redirect_to のホワイトリスト（必須）**: `redirect_to` パラメータは**自ドメインのパスのみ**をホワイトリスト化して検証すること（外部・サブドメイン等は運用で明示的に許可しない限り禁止）。オープンリダイレクト対策として厳格に扱うこと。
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
  current_jti uuid NULL,
  ip inet NULL,
  user_agent text NULL,
  device_name text NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz NULL,
  last_seen_at timestamptz
);

-- マイグレーション（既存 DB への追加例）
-- セッションに IP / user_agent / device_name / current_jti を追加する
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS current_jti uuid NULL,
  ADD COLUMN IF NOT EXISTS ip inet NULL,
  ADD COLUMN IF NOT EXISTS user_agent text NULL,
  ADD COLUMN IF NOT EXISTS device_name text NULL;

-- 必要に応じてインデックスを追加
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
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
- 方針: **ダブルサブミット方式 (X-CSRF-Token)** を採用。クライアントはログイン後に HttpOnly ではない CSRF cookie を受け取り、以降の状態変更リクエストで `X-CSRF-Token` ヘッダを付与して検証する。
- CSRF cookie 属性: `SameSite=Lax` を付与。`Secure` は本番環境で必須。ローカル開発では `NODE_ENV=development` または `ALLOW_INSECURE_COOKIES=true` が明示されている場合にのみ `Secure=false` を許可する。
- 検証: トークンは毎リクエストで検証し、ミスマッチは 401/403 を返却。トークンのローテーションや有効期限（例: 1 時間）を導入することを推奨。

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
  - 環境変数: `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AWS_SES_REGION`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `SES_FROM_ADDRESS`
- トークンは最小単位（整数）や期限の検証をサーバ側で必ず行う

## 関連ドキュメント
- docs/ECSiteSpec.md

## 担当 / 依存
- 担当: Backend (Auth API), Frontend (UI/Forms)
- 依存: Amazon SES, Supabase

## 受け入れ基準（まとめ）
- 新規登録 201
- ログイン 200 + セッション発行
- パスワード再設定メール送信 200
- リフレッシュ処理がトークンローテーションと revocation を行う

## チケット分割例
- TASK-1: `POST /api/auth/register` 実装
- TASK-2: `POST /api/auth/login` 実装
- TASK-3: パスワードリセットフロー実装

