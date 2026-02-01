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
*注: 詳細設計は実装方針の合意後にコードを起票します（PR として提出）。*