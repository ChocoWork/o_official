# 認証 (Auth) — 詳細設計（スタブ）

> このファイルは `docs/ArchitectureDesign/auth-structure.md`（構造設計）に基づき、各アーキテクチャID を参照して詳細を記載するためのスタブです。

## 概要
- 構造設計で定義された ARCH-ID を参照して、以下の詳細を順次埋めます。
  - API（OpenAPI スキーマ）
  - DB マイグレーション SQL
  - TypeScript 型 / Zod スキーマ
  - Next.js App Router の route スタブ
  - セキュリティ設計（CSRF, Cookie, JTI, Rate-limits）
  - テストケース（Unit/Integration/Contract/E2E）

## 対応するアーキテクチャID
- ARCH-AUTH-01: Register / Confirm
- ARCH-AUTH-02: Login
- ARCH-AUTH-03: Refresh / JTI
- ARCH-AUTH-04: Password Reset
- ARCH-AUTH-05: Logout / Revoke Sessions
- ARCH-AUTH-06: OAuth
- ARCH-AUTH-07: CSRF / Cookie
- ARCH-AUTH-08: Audit Log
- ARCH-AUTH-09: Rate Limit
- ARCH-AUTH-10: Secrets Management
- ARCH-AUTH-11: Privileged MFA (Admin / Supporter)

## まず出力するセクション（優先順）
1. OpenAPI スニペット（`/api/auth/register`, `/api/auth/login`, `/api/auth/refresh`, `/api/auth/password-reset/*`）
2. DB マイグレーション草案（sessions テーブル拡張, password_reset_tokens, oauth_accounts）
3. TypeScript 型 & Zod スキーマ（`src/features/auth/schemas.ts`）
4. API Route スタブ（`src/app/api/auth/*/route.ts`）
5. テスト計画（Unit / Integration / E2E）

## ARCH-AUTH-11: Privileged MFA (Admin / Supporter)

### 目的
- 管理系権限（`admin` / `supporter`）のセッションに対して、各ログインセッションごとの 2 要素認証（MFA）を強制する。

### 脅威モデルと設計方針
- 認証済みセッション cookie の窃取だけで管理 API に到達されるリスクを低減する。
- 権限（ACL）と MFA は独立に検証し、どちらか一方のみ満たしても管理 API を許可しない。
- `admin_mfa_verified` は永続フラグではなく、セッション昇格状態として扱う。

### 運用ルール（いつ立てるか）
1. ログイン / セッション再生成時
 - `admin` / `supporter` は必ず `admin_mfa_verified=false` と `mfa_verified=false` に初期化する。
2. MFA 成功時
 - TOTP チャレンジ検証が成功した時点で `admin_mfa_verified=true` と `mfa_verified=true` を設定する。
3. 非特権ユーザー
 - 上記フラグは評価対象外（更新不要）とする。

### API フロー
1. `/api/auth/mfa/status`
 - 現在ユーザーの MFA 状態（AAL, verified factor 有無）を返す。
2. `/api/auth/mfa/enroll-totp`
 - 特権ユーザー向けに TOTP enroll を開始し、QR/secret を返す。
3. `/api/auth/mfa/verify`
 - factor challenge/verify を実施し、成功時に `admin_mfa_verified` をセットする。

### UI フロー
1. ログイン成功後は `/auth/verified` を経由する。
2. 特権ユーザーかつ `mfaVerified=false` の場合、MFA 登録またはコード検証 UI を表示。
3. 検証成功後に `/admin` へ遷移。

### セキュリティ制御
- `auth:mfa:enroll-totp`, `auth:mfa:verify` にレート制限を適用。
- API では `resolveRequestUser` でユーザーを確定し、`app_metadata.role` を再評価する。
- サービスロール操作はサーバー側のみで実施し、クライアントへ secret key を露出しない。

### 管理者運用: MFAリセット
1. 管理者は `admin.users.manage` かつ MFA 検証済みセッションでのみ実行可能。
2. API は `POST /api/admin/users/mfa/reset` を使用し、`userId`, `reason`, `confirm: "RESET_MFA"` を必須とする。
3. 対象は特権ユーザー（`admin` / `supporter`）のみ許可し、自己リセットは拒否する。
4. リセット時は Supabase Admin API で対象ユーザーの MFA factors を全削除し、`admin_mfa_verified=false`, `mfa_verified=false` に戻す。
5. すべての操作結果（成功/失敗）は `audit_logs` に記録し、運用監査証跡を残す。

#### 実行手順（運用）
1. 管理者が対象ユーザーIDとリセット理由を確認する。
2. `confirm` に固定値 `RESET_MFA` を指定して API 実行する。
3. 成功後、対象ユーザーに「再ログイン後に `/auth/verified` で再登録が必要」であることを通知する。
4. 監査ログで `admin.users.mfa.reset` の成功レコードを確認する。

---
*注: 詳細設計は構造設計の合意（文末の「次のアクション: 1. 構造設計のレビュー」）を受けてから作成します。続けて詳細設計を生成してよい場合は承認コメントをください。*