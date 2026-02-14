---
title: 認証 (Auth) — 詳細設計
task: [DOC-01]
refs:
  - docs/ArchitectureDesign/auth-structure.md
  - docs/specs/01_auth.md
---

# 認証 (Auth) — 詳細設計（スタブ）

このファイルは構造設計（`docs/ArchitectureDesign/auth-structure.md`）で定義されたアーキテクチャID を参照して、詳細を記述するためのテンプレ兼スタブです。

## 目的
- OpenAPI スニペット、DB マイグレーション草案、TypeScript 型 / Zod スキーマ、API route スタブ、セキュリティ設計、テスト計画をここに記載します。

## 対応 ARCH-ID
- ARCH-AUTH-01: Register / Confirm
- ARCH-AUTH-02: Login
- ARCH-AUTH-03: Refresh / JTI
- ARCH-AUTH-04: Password Reset
- ARCH-AUTH-05: Logout / Revoke Sessions
- ARCH-AUTH-06: OAuth
- ARCH-AUTH-07: CSRF / Cookie
- ARCH-AUTH-08: Audit Log
- ARCH-AUTH-09: Rate Limit
- ARCH-AUTH-10: Secrets Management (現行は手動運用、`docs/ops/secrets.md` を参照)

## OAuth: 既存アカウント衝突時のポリシー（提案）
### 概要
OAuth ログインでプロバイダから返るメールアドレスが既存アカウントのメールと一致した場合、衝突（同一メールに対する既存アカウントの可能性）が発生します。セキュリティと UX のバランスを考慮して、以下の方針を提案します。

### 推奨ポリシー（安全で UX を損なわない案）
1. **検証されたメール (email_verified=true) の場合**
   - **ユーザーに「アカウント連携（Link accounts）」を促す**画面を表示し、ユーザーの明示的承認を得た上で OAuth アカウントを既存アカウントにリンクする。リンクには再度ログイン（メール確認リンク or パスワード確認）を要求して本人確認を強化する。
2. **検証されていないメール or メール欠如の場合**
   - ユーザーに既存アカウントへのリンクを**手動で要求**し、メール確認フローを通じて照合する。自動マージは行わない。

### 自動マージ（Auto-merge）についての注意点
- 自動マージは利便性が高い一方で、**アカウント乗っ取りのリスク**を増加させます（OAuth プロバイダのメール検証が弱い場合など）。よって、検討する場合は以下の厳しい前提を設けるべきです:
  - OAuth プロバイダが `email_verified=true` を返すことを必須とする
  - ログイン時に IP/デバイス のリスクスコア低条件を満たす（異常なログインは差戻す）
  - マージ実行時にユーザーへ通知（メール）し、異常検出時は即時ロールバック/セッション失効の手順を準備
- 総じて**初期実装では自動マージを採用しない**ことを推奨します。まずはユーザー主導のリンクフローを採用し、運用で観察した後に自動化の可否を再検討してください。

### 実装上の要件（チェックリスト）
- OAuth callback で provider の `email` と `email_verified` を取得すること
- 既存メール一致時は「リンク提案ページ」へリダイレクトし、ユーザーの承認を得る（承認には 2段階認証・確認リンクのどちらかを必須化できる）
- リンク後の audit event を残す（`auth.oauth.link`）
- E2E: OAuth での既存アカウントリンクケースと不一致ケースをカバーする

## OAuth 詳細設計（追加）
### DB マイグレーション（例）
- `migrations/00XX_create_oauth_requests.sql` を追加
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
```
- `migrations/00XX_add_oauth_account_cols.sql` を追加（`last_synced_at`, `raw_profile_hash`, `access_token_encrypted`, `refresh_token_encrypted`, `token_expires_at`）

### ユーザ／プロフィール方針（設計決定）
- **決定**: `auth.users` を認証のソース・オブ・トゥルースとし、アプリ側のプロフィール情報は `public.profiles` に格納します。
- `profiles.user_id` は `auth.users(id)` を参照する主キーとし、表示名・電話・住所などの可変情報を保持します。
- 実施マイグレーション: `migrations/002_create_profiles.sql` を追加、既存の `public.users` のデータを `profiles` に移行し、元 `public.users` は `public.users_deprecated` にリネームして保持します（バックアップ含む）。
- 理由: `auth.users` と同名の `public.users` を運用すると混乱（クエリの誤参照、権限のずれ等）が生じるため、明示的に分離して安定性を高めます。

### OpenAPI（追加スニペット）
```yaml
paths:
  /api/auth/oauth/start:
    get:
      parameters:
        - name: provider
          in: query
          required: true
        - name: redirect_to
          in: query
          required: false
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
          description: Callback processed
        '400':
          description: Invalid state
        '401':
          description: PKCE verification failed
        '502':
          description: Provider exchange failure
  /api/auth/oauth/link-confirm:
    post:
      requestBody:
        required: true
      responses:
        '200':
          description: Link confirmed
        '403':
          description: Re-authentication failed
        '409':
          description: Conflict (provider_user_id already linked)
  /api/auth/oauth/unlink:
    post:
      responses:
        '200':
          description: Unlinked
```

### Exchange & Error Handling
- `callback` で code をサーバ側で交換 (code_verifier を使用)
- 交換失敗: `502 Bad Gateway`（Provider 側問題）として処理 & audit log `auth.oauth.callback.exchange_failure`
- PKCE 検証失敗: `401 Unauthorized` & audit `auth.oauth.callback.pkce_failure`
- state 無効: `400 Bad Request` & audit `auth.oauth.callback.invalid_state`

### state / PKCE 保存方針
- 保存: Redis (推奨) か Postgres (`oauth_requests`)
- TTL: 10 分（5–15 分の許容）
- 保存フィールド: `state`, `code_challenge`, `code_challenge_method`, `redirect_to`, `client_ip`, `created_at`, `expires_at`, `used_at`
- 再利用検出: `used_at` がセット済み or `expires_at` を過ぎていたら拒否（audit）
- cleanup: 定期ジョブで expired / used を削除（例: daily retention sweep）

### Provider tokens 挙動
- デフォルト: `access_token` / `refresh_token` は保存しない
- 保存が必要な場合: KMS で暗号化、アクセス監査、明確なローテーション/削除手順、ユーザー unlink 時の即時削除

### Admin API
- `POST /api/auth/oauth/unlink` (管理・ユーザー操作) — 監査ログを必須化

### テスト計画（OAuth 追加）
- 単体: state/PKCE の生成・検証・期限切れ・再利用検出のユニットテスト
- 結合: Provider モックで code 交換の正常系/異常系 (expired, wrong state, wrong code) をテスト
- セキュリティ: id_token JWKS 署名検証、リプレイ攻撃検出テスト
- E2E: 新規登録 / 既存メール→リンク提案→再認証成功・キャンセル・異常系を自動化

## 優先出力項目（更新）
1. OpenAPI スペックに `oauth` エンドポイントを追加（`docs/openapi/auth.yaml`）
2. マイグレーション: `migrations/00XX_create_oauth_requests.sql`, `migrations/00YY_add_oauth_account_cols.sql`
3. Worker: `src/workers/oauth_cleanup_job.ts`（cron daily）
4. API routes: `src/app/api/auth/oauth/{start,callback,link-proposal,link-confirm,unlink}/route.ts`
5. テスト: `tests/auth/oauth.*` の整備

---

## Supabase Auth 統合設計（現在の実装）

### 概要
当プロジェクトは **Supabase Auth を ID 管理層（認証ストア）** として使用し、**アプリ側でセッション・セキュリティポリシーを実装** する設計を採用しています。

### 役割分担

#### Supabase Auth が担当（ID 管理層）
- ✅ `auth.users` テーブルの管理（ユーザー作成・削除・検証）
- ✅ メール/パスワード認証（`signInWithPassword`）
- ✅ メール確認トークン発行・検証（`verifyOtp`）
- ✅ パスワードリセットトークン発行
- ✅ OAuth プロバイダ連携（Google など）
- ✅ JWT（access_token/refresh_token）の発行と検証

#### アプリ側が担当（セッション・セキュリティ層）
- ✅ HttpOnly Cookie によるセッション管理
- ✅ `sessions` テーブルでの refresh_token_hash 管理
- ✅ JTI ローテーションと再利用検出（`current_jti`）
- ✅ レート制限（IP/アカウント軸）
- ✅ 監査ログ（`audit_logs` テーブル）
- ✅ CSRF トークン管理
- ✅ OAuth リンク提案・再認証フロー（自動マージ禁止）
- ✅ RLS ポリシーの設計・運用

### 実装済みファイル構成

#### Core Auth Infrastructure
| ファイル | 役割 | 実装状況 |
|---------|------|---------|
| `src/lib/supabase/server.ts` | Supabase クライアント作成（一般 / サービスロール） | ✅ 実装済 |
| `src/lib/cookie.ts` | Cookie ヘルパー（HttpOnly, Secure, SameSite） | ✅ 実装済 |
| `src/lib/csrf.ts` | CSRF トークン生成・検証 | ✅ 実装済 |
| `src/lib/audit.ts` | 監査ログ出力 | ✅ 実装済 |
| `src/lib/hash.ts` | トークンハッシュ化（SHA-256） | ✅ 実装済 |

#### Auth Endpoints
| エンドポイント | 実装ファイル | Supabase 利用箇所 | 実装状況 |
|--------------|-------------|-----------------|---------|
| `POST /api/auth/register` | `src/app/api/auth/register/route.ts` | `createUser` / `signUp` | ✅ 実装済（公開・管理者両対応） |
| `GET /api/auth/confirm` | `src/app/api/auth/confirm/route.ts` | `verifyOtp` (server-side) | ✅ 実装済（トークン即時消費） |
| `POST /api/auth/login` | `src/app/api/auth/login/route.ts` | `signInWithPassword` | ✅ 実装済（レート制限付き） |
| `POST /api/auth/refresh` | `src/app/api/auth/refresh/route.ts` | `/auth/v1/token` (refresh grant) | ✅ 実装済（JTI ローテーション） |
| `POST /api/auth/logout` | `src/app/api/auth/logout/route.ts` | sessions テーブル更新のみ | ✅ 実装済（CSRF 検証） |
| `POST /api/auth/password-reset/request` | `src/app/api/auth/password-reset/request/route.ts` | Supabase メール送信 | ✅ 実装済（Turnstile） |
| `POST /api/auth/password-reset/confirm` | `src/app/api/auth/password-reset/confirm/route.ts` | パスワード更新 API | ✅ 実装済 |
| `GET /api/auth/oauth/start` | `src/app/api/auth/oauth/start/route.ts` | — (state/PKCE 生成) | ✅ 実装済 |
| `GET /api/auth/oauth/callback` | `src/app/api/auth/oauth/callback/route.ts` | OAuth コード交換 | ✅ 実装済 |

#### Session Management
| ファイル | 役割 | 実装状況 |
|---------|------|---------|
| `src/features/auth/services/session.ts` | セッション CRUD、JTI 管理、再利用検出 | ✅ 実装済 |
| `src/features/auth/services/refresh.ts` | リフレッシュロジック | ✅ 実装済 |
| `src/features/auth/services/register.ts` | 登録後のセッション作成 | ✅ 実装済 |

#### Security & Middleware
| ファイル | 役割 | 実装状況 |
|---------|------|---------|
| `src/features/auth/middleware/rateLimit.ts` | レート制限（IP/アカウント軸） | ✅ 実装済 |
| `src/lib/csrf.ts` | CSRF トークン生成・検証 | ✅ 実装済 |
| `src/lib/turnstile.ts` | Cloudflare Turnstile 検証 | ✅ 実装済 |

### 主要フロー（実装済み）

#### 1. 新規登録 → メール確認 → 自動ログイン
```
1. POST /api/auth/register → Supabase.signUp() → 確認メール送信（redirect_to=/api/auth/confirm）
2. メール内リンク → GET /auth/v1/verify?token=...&redirect_to=/api/auth/confirm
3. Supabase が token 検証 → GET /api/auth/confirm?token_hash=...
4. アプリ側で verifyOtp (service role) → sessions テーブルに保存 → HttpOnly Cookie 発行 → 302 /account
```

#### 2. ログイン
```
1. POST /api/auth/login → レート制限チェック（IP + アカウント軸）
2. Supabase.signInWithPassword() → access_token + refresh_token 取得
3. sessions テーブルに refresh_token_hash 保存
4. HttpOnly Cookie 発行（sb-refresh-token, sb-access-token）
5. 監査ログ記録（auth.login success）
```

#### 3. リフレッシュ（JTI ローテーション）
```
1. POST /api/auth/refresh → Cookie から refresh_token 取得
2. sessions テーブルで current_jti 照合
3. 不一致 → 再利用検出 → quarantine / 全セッション失効
4. 一致 → Supabase /auth/v1/token で新トークン取得
5. 新しい JTI 生成 → sessions.current_jti 更新
6. 新 Cookie 発行
```

#### 4. OAuth（Google）
```
1. GET /api/auth/oauth/start → state/code_challenge 生成 → oauth_requests テーブル保存
2. Google 認証 → GET /api/auth/oauth/callback?code=...&state=...
3. state 検証 → コード交換 → プロファイル取得
4. 既存メール一致 → /auth/oauth/link-proposal へリダイレクト（自動マージしない）
5. 新規ユーザ → oauth_accounts 作成 → セッション発行
```

### 環境変数（必須）
```env
# Supabase（公開）
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...

# Supabase（サーバのみ・Secrets Manager で管理）
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...（厳格に保護）

# メール送信（Amazon SES）
AWS_SES_REGION=us-east-1
AWS_SES_ACCESS_KEY_ID=AKIA...
AWS_SES_SECRET_ACCESS_KEY=...
SES_FROM_ADDRESS=noreply@example.com

# その他
JWT_SECRET=...（アプリ側トークン用）
ADMIN_API_KEY=...（管理者 API 用）
TURNSTILE_SECRET_KEY=...（Cloudflare Turnstile）
```

### セキュリティ実装状況

#### ✅ 実装済み
- Cookie: `HttpOnly; Secure; SameSite=Lax`（本番環境）
- トークン即時消費（confirm/reset）
- redirect_to ホワイトリスト検証
- レート制限（IP: 50 req/10min、アカウント: 5 req/10min）
- 監査ログ（JSON Lines、トークンマスキング）
- CSRF: ダブルサブミット方式
- refresh_token_hash 保存（SHA-256）
- JTI ローテーション + 再利用検出 → quarantine
- Turnstile（登録・パスワードリセット常時、ログイン適応型）

#### 🚧 強化推奨項目
- OAuth: リンク提案 UI の実装（現在は基本フローのみ）
- SUPABASE_SERVICE_ROLE_KEY の自動ローテーション（現行は手動運用）
- sessions テーブルの定期クリーンアップジョブ
- oauth_requests テーブルの定期クリーンアップ（expired/used）

### DB スキーマ（Supabase 連携）

#### auth.users（Supabase 管理）
- Supabase Auth が自動管理
- アプリ側は `createServiceRoleClient()` で読み取り専用参照

#### public.profiles（アプリ管理）
```sql
CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  display_name text,
  kana_name text,
  phone text,
  address jsonb,
  created_at timestamptz DEFAULT now()
);
```

#### public.sessions（アプリ管理）
```sql
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  refresh_token_hash text NOT NULL,
  current_jti uuid,
  ip inet,
  user_agent text,
  device_name text,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  quarantined boolean DEFAULT false
);
```

#### public.oauth_accounts（アプリ管理）
```sql
CREATE TABLE oauth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  provider text NOT NULL,
  provider_user_id text NOT NULL,
  email text,
  raw_profile jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE(provider, provider_user_id)
);
```

#### public.oauth_requests（アプリ管理）
```sql
CREATE TABLE oauth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  state text NOT NULL UNIQUE,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL,
  redirect_to text,
  client_ip inet,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
```

### RLS ポリシー（推奨）

#### profiles テーブル
```sql
-- ユーザは自分のプロファイルのみ閲覧・更新可能
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = user_id);
```

#### sessions テーブル
```sql
-- 管理者のみ全セッション閲覧可能（一般ユーザはアクセス不可）
CREATE POLICY "Admin only"
  ON sessions FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');
```

### 受入基準（実装済み確認）

#### ✅ 完了
1. Email 確認リンク → `/api/auth/confirm` で server-side 検証 → HttpOnly Cookie 発行 → クリーン URL リダイレクト
2. Refresh トークン JTI ローテーション機能 → 再利用検出で quarantine/全失効
3. OAuth 既存メール一致時のリンク提案フロー（基本実装）
4. 監査ログ・レート制限が全エンドポイントで有効
5. Cookie: `HttpOnly; Secure; SameSite=Lax`（本番）

#### 🚧 残作業
1. E2E テスト（Playwright）: メール確認リンククリック → 自動ログイン → Header 表示
2. OAuth リンク提案 UI の実装（`/auth/oauth/link-proposal` ページ）
3. パスワードリセット統合テストのモック調整（6 件）
4. 本番デプロイ前の Smoke Test

---

## 実装確認と修正提案

### 現在の実装レビュー結果（2026-02-14）

#### ✅ 適合している実装
1. **Supabase Auth の適切な利用**
   - `createServiceRoleClient()` でサービスロールキーを厳格に管理
   - `verifyOtp`, `signInWithPassword` など正しく使用
   - メール確認トークンの server-side 検証を実装済み

2. **セッション管理**
   - `sessions` テーブルで `refresh_token_hash` + `current_jti` を管理
   - JTI ローテーションと再利用検出ロジックが実装済み
   - `findSessionByRefreshHash()`, `rotateJtiAndSave()` など適切なヘルパー関数

3. **セキュリティ実装**
   - レート制限が各エンドポイントで適用
   - 監査ログが成功・失敗両方で記録
   - Cookie 設定が仕様に準拠（HttpOnly, Secure, SameSite）

4. **OAuth 実装**
   - state/PKCE の生成・検証・保存が実装済み
   - `oauth_requests` テーブルで TTL 管理
   - 基本的なコールバックフローが完成

### 🔧 修正が必要な箇所

#### 1. メール送信の統合（優先度: 高）
**現状**: メール送信の実装が Supabase デフォルトメール or 未完成
**必要な修正**: Amazon SES 統合の完全実装

📁 **修正ファイル**: `src/lib/mail/adapters/ses.ts`, メール送信を呼び出す各エンドポイント
```typescript
// 実装例: src/lib/mail/adapters/ses.ts
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

export async function sendViaSES(to: string, subject: string, html: string) {
  const client = new SESClient({ region: process.env.AWS_SES_REGION });
  const command = new SendEmailCommand({
    Source: process.env.SES_FROM_ADDRESS,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: { Html: { Data: html } },
    },
  });
  return client.send(command);
}
```

**対象エンドポイント**:
- `/api/auth/register` （確認メール送信）
- `/api/auth/password-reset/request` （リセットメール送信）

#### 2. OAuth リンク提案 UI の実装（優先度: 中）
**現状**: `/auth/oauth/link-proposal` ページが未実装
**必要な修正**: ユーザー同意 UI と再認証フローの実装

📁 **新規作成**: `src/app/auth/oauth/link-proposal/page.tsx`
```typescript
// 実装例
'use client';
import { useSearchParams } from 'next/navigation';

export default function LinkProposalPage() {
  const params = useSearchParams();
  const provider = params.get('provider');
  const email = params.get('email');
  
  // ユーザーに既存アカウントとのリンクを提案
  // 承認 → パスワード再入力 or メール確認リンク送信
  // 拒否 → 別アカウント作成 or キャンセル
}
```

**必要な API**: `POST /api/auth/oauth/link-confirm`（既にスタブあり）

#### 3. トークン寿命の Supabase 設定確認（優先度: 中）
**現状**: アプリ側でトークン寿命を管理するが、Supabase 側の設定も必要
**必要な確認**: Supabase ダッシュボードで以下を設定

- Email confirmation token: 24 時間
- Password reset token: 1 時間
- Refresh token: 7 日（Supabase デフォルトは異なる可能性）

📍 **設定場所**: Supabase Dashboard → Authentication → Settings → Auth Providers

#### 4. クリーンアップジョブの実装（優先度: 中）
**現状**: 期限切れレコードが蓄積する可能性
**必要な実装**: 定期クリーンアップスクリプト

📁 **新規作成**: `src/workers/cleanup-sessions.ts`, `src/workers/cleanup-oauth-requests.ts`
```typescript
// 実装例: src/workers/cleanup-sessions.ts
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function cleanupExpiredSessions() {
  const service = await createServiceRoleClient();
  const { error } = await service
    .from('sessions')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .is('revoked_at', null);
  
  if (error) console.error('Session cleanup error:', error);
}
```

**実行方法**: Vercel Cron Jobs or GitHub Actions

#### 5. RLS ポリシーの適用（優先度: 高）
**現状**: RLS が未適用の可能性
**必要な実装**: Supabase で RLS を有効化し、ポリシーを適用

📁 **新規マイグレーション**: `migrations/0XX_enable_rls_policies.sql`
```sql
-- profiles テーブル
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- sessions テーブル（管理者のみ）
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only"
  ON sessions FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');
```

#### 6. SUPABASE_SERVICE_ROLE_KEY チェック強化（優先度: 高）
**現状**: 一部エンドポイントでキーチェックが不完全
**必要な修正**: すべての service role 使用箇所でエラーハンドリング

📁 **修正対象**: `src/lib/supabase/server.ts` の `createServiceRoleClient()`
```typescript
export async function createServiceRoleClient(): Promise<SupabaseClient> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    // より詳細なエラーログ
    console.error('❌ CRITICAL: SUPABASE_SERVICE_ROLE_KEY not configured');
    throw new Error('SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL must be set for service role client');
  }

  // キーの形式チェック（JWT 形式）
  if (!serviceKey.startsWith('eyJ')) {
    console.error('❌ CRITICAL: SUPABASE_SERVICE_ROLE_KEY format invalid');
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must be a valid JWT');
  }

  const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');
  return createSupabaseClient(url, serviceKey, {
    auth: {
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
```

### 📋 修正優先度サマリ

| 優先度 | 項目 | ファイル | 工数見積 |
|-------|-----|---------|---------|
| 🔴 高 | RLS ポリシー適用 | `migrations/0XX_enable_rls...sql` | 1-2h |
| 🔴 高 | SES メール統合 | `src/lib/mail/adapters/ses.ts` + エンドポイント | 3-4h |
| 🔴 高 | Service role key チェック強化 | `src/lib/supabase/server.ts` | 0.5h |
| 🟡 中 | OAuth リンク提案 UI | `src/app/auth/oauth/link-proposal/page.tsx` | 2-3h |
| 🟡 中 | トークン寿命設定確認 | Supabase Dashboard 設定 | 0.5h |
| 🟡 中 | クリーンアップジョブ | `src/workers/cleanup-*.ts` | 2h |
| 🟢 低 | E2E テスト追加 | `e2e/auth/*.spec.ts` | 4-6h |

### 次のステップ（推奨順序）
1. ✅ **今**: 仕様書更新完了 → レビュー依頼
2. 🔴 **次**: RLS ポリシー適用（セキュリティ必須）
3. 🔴 **次**: Service role key チェック強化
4. 🔴 **次**: SES メール統合
5. 🟡 **後**: OAuth リンク提案 UI 実装
6. 🟡 **後**: クリーンアップジョブ実装
7. 🟢 **最後**: E2E テスト拡充

---
*最終更新: 2026-02-14 — 実装レビューと修正提案を追加*