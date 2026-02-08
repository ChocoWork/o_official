---
status: in-progress
id: AUTH-01
title: 認証基盤の実装（メール/パスワード、セッション管理、監査）
priority: high
estimate: 12d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-02-01
refs:
  - docs/specs/01_auth.md
  - docs/seq/01_auth_seq.md
  - docs/ArchitectureDesign/auth-structure.md
  - docs/DetailDesign/auth-detailed.md
---

# 概要

Next.js + Supabase を前提とした認証基盤を実装する。メール/パスワード登録・ログイン・パスワード再設定・セッション管理（リフレッシュ含む）・監査ログ保存・CSRF 対策・レート制限を含む。

本チケットは以下の構造・詳細設計に準拠する：
- **構造設計**: `docs/ArchitectureDesign/auth-structure.md` (ARCH-AUTH-01 ~ ARCH-AUTH-10)
- **詳細設計**: `docs/DetailDesign/auth-detailed.md`
- **仕様書**: `docs/specs/01_auth.md`
- **シーケンス図**: `docs/seq/01_auth_seq.md`

---

# 実装フェーズ

## フェーズ 1: 基盤整備（DB・共通ユーティリティ）

### [AUTH-01-01] DB マイグレーション（users, sessions, rate_counters）
**依存**: なし  
**対応 REQ**: REQ-AUTH-001（Register users 定義）, REQ-AUTH-003（Refresh sessions 設計）, REQ-AUTH-005（Logout sessions 管理）, REQ-AUTH-009（Rate limit counters）  
**対応 ARCH-ID**: ARCH-AUTH-01, ARCH-AUTH-03, ARCH-AUTH-05, ARCH-AUTH-09  
**対応詳細設計**: `docs/DetailDesign/auth-detailed.md` 内で、各 ARCH-ID のセクションで DB スキーマを参照  
**仕様書参照**: `docs/specs/01_auth.md` §8（データモデル）

**実装ファイル**:
- `migrations/001_init_auth_tables.sql` — `users`, `sessions` テーブル作成
- `migrations/002_add_sessions_fields.sql` — `sessions` に `current_jti, ip, user_agent, device_name` を追加
- `migrations/005_create_rate_limit_counters.sql` — `rate_limit_counters` テーブル作成（IP/エンドポイント/バケット）

**テストファイル**:
- `tests/unit/migrations/001.test.ts`
- `tests/unit/migrations/002.test.ts`
- `tests/unit/migrations/003.test.ts`

**受け入れ条件**:
- [x] `users` テーブルが存在し、`id (PK), email (UNIQUE), password_hash, display_name, kana_name, phone, address (jsonb), created_at` を持つ（**注意: `public.users` は非推奨。`auth.users` を source-of-truth とし、`public.profiles` に移行済または移行予定**）  
- [x] `profiles` テーブルが存在し、`user_id (PK, FK -> auth.users.id), display_name, kana_name, phone, address (jsonb), created_at` を持つ（`migrations/002_create_profiles.sql` 実行済み / 現環境で `count(*) = 0`）  
- [x] `AUTH-01-15` マイグレーション: `auth.users` にユーザが作成された際に `public.profiles` を自動作成する DB トリガーを追加（実装: `migrations/003_profiles_trigger.sql`） — 検証済: 関数 `create_profile_for_new_auth_user` が DB に存在し、`public.profiles` に行が作成されることを確認（スクリーンショット/SQL確認）。ユニットテストを強化し、 `returns trigger` / `language plpgsql` / `execute procedure` のチェックを追加済み。
- [ ] （テスト未実施） `AUTH-01-16` マイグレーション: `profiles` を作成済みの `auth.users` が抜けている場合に一括でデフォルトレコードを作成する seed マイグレーション（必要に応じ）
- [x] `sessions` テーブルが存在し、`id, user_id (FK), refresh_token_hash, current_jti, ip, user_agent, device_name, created_at, expires_at, revoked_at, last_seen_at` を持つ — 完了 (2026-02-01: `migrations/004_create_sessions.sql` 適用、ユニット/統合テスト追加、ステージングでの動作確認済)
- [x] `rate_limit_counters` テーブルが存在し、`(ip, endpoint, bucket)` で GROUP BY カウント可能 — 完了 (2026-02-07: `migrations/005_create_rate_limit_counters.sql` 適用、upsert・集計・インデックス利用を手動検証済)
- [ ] （テスト未実施） マイグレーション実行後に逆実行（rollback）可能

**実行手順**:
```bash
npm run db:migrate:latest  # or Supabase CLI equivalent
npm run test -- tests/unit/migrations/
```

**メモ**: `migrations/002_create_profiles.sql` と対応ユニットテスト `tests/unit/migrations/002_create_profiles.test.ts` をリポジトリに追加済です。`profiles` 作成・データ移行・`public.users` のリネームは本マイグレーションにより実行されます。

---

### [AUTH-01-02] Zod スキーマ定義（バリデーション）
**依存**: なし  
**対応 REQ**: REQ-AUTH-001（Register validation）, REQ-AUTH-002（Login validation）, REQ-AUTH-004（Password Reset validation）  
**対応 ARCH-ID**: ARCH-AUTH-01, ARCH-AUTH-02, ARCH-AUTH-04  
**対応詳細設計**: `docs/DetailDesign/auth-detailed.md` 内で各エンドポイントの request/response スキーマ定義（OpenAPI スニペット 参照）  
**仕様書参照**: `docs/specs/01_auth.md` §9（バリデーションルール）

**実装ファイル（完了）**:
- `src/features/auth/schemas/register.ts` — `RegisterRequestSchema`, `RegisterResponseSchema` (追加済)
- `src/features/auth/schemas/login.ts` — `LoginRequestSchema`, `LoginResponseSchema` (追加済)
- `src/features/auth/schemas/refresh.ts` — `RefreshResponseSchema` (追加済)
- `src/features/auth/schemas/password-reset.ts` — `ResetRequestSchema`, `ResetConfirmSchema` (追加済)
- `src/features/auth/schemas/common.ts` — 共通（email, password, error responses、`formatZodError`）(追加済)

**テストファイル（追加状況）**:
- `tests/unit/schemas/register.test.ts` (追加・パス)
- `tests/unit/schemas/login.test.ts` (追加・パス)
- `tests/unit/schemas/password-reset.test.ts` (追加・パス)
- `tests/unit/schemas/refresh.test.ts` (追加・パス)   

**受け入れ条件（現状）**:
- [x] 有効なメール・パスワードはスキーマを通過（単体テストで確認済）
- [x] 無効なメール（非 RFC）・短いパスワード（<8 文字）は拒否（単体テストで確認済）
- [x] 各スキーマは `parse()` で型安全（`z.infer` 型をエクスポート）
- [x] エラーメッセージは日本語で返される（`z.setErrorMap` により統一）

**備考・関連変更**:
- サーバ側の該当エンドポイント（`/api/auth/login`, `/api/auth/register`, `/api/auth/password-reset/*`）は inline Zod を共通スキーマに差し替え済（バリデーションの一貫化）。
- フロント側の `LoginModal.tsx` にクライアント検証 (`LoginRequestSchema.parse()`) を追加、`LoginContext` の `login` は検証＋非同期結果を返すよう更新済。
- Jest / ts-jest / jsdom / Testing Library をプロジェクトに追加し、スキーマの単体テストとコンポーネント単体テスト（`LoginContext`）・統合テスト（auth API）を作成・実行し、既存のスイートは通過しています。
- 追加済: `tests/unit/services/refresh.test.ts`（追加・パス）、`tests/integration/api/auth/refresh.test.ts`（追加・パス）、`tests/integration/api/auth/logout.test.ts`（追加・パス）、`tests/integration/api/admin/revoke-user-sessions.test.ts`（追加・パス）、`tests/integration/auth-flow.test.ts`（追加・パス） — リフレッシュ/ログアウト/管理一括失効の統合シーケンスをカバー済。


**実行手順**:
```bash
npm run test -- tests/unit/schemas/
```

---

### [AUTH-01-03] 共通ユーティリティ（JWT, Cookie, CSRF, Hash）
**依存**: [AUTH-01-02]  
**対応 REQ**: REQ-AUTH-007（CSRF 実装）, REQ-AUTH-008（監査ログ）  
**対応 ARCH-ID**: ARCH-AUTH-07, ARCH-AUTH-08  
**対応詳細設計**: 詳細設計では「OAuth: 詳細設計」セクション内で各ユーティリティの使用例記載（将来拡張予定）  
**仕様書参照**: `docs/specs/01_auth.md` §5（セキュリティ・CSRF・Cookie）, §10（監査ログ）

**実装ファイル**:
- `src/lib/jwt.ts` — JWT 生成・検証（HS256, 実装済: `jsonwebtoken` 使用） ✅
- `src/lib/hash.ts` — Bcrypt/Argon2 ハッシュ・照合
- `src/lib/cookie.ts` — Cookie 設定（HttpOnly, Secure, SameSite）
- `src/lib/csrf.ts` — CSRF トークン生成・検証（ダブルサブミット方式）
- `src/lib/audit.ts` — 監査ログ出力（JSON Lines）

> **状態メモ**: `jwt.ts` を `jsonwebtoken` で本実装し、ユニットテストを追加しました。監査ログの DB 統合を実施し、`audit_logs` テーブル用マイグレーションと `logAudit` の DB 挿入テストを追加しました。管理画面向けの `GET /api/admin/audit-logs` エンドポイントも追加し、認可と取得（最大100件）を実装しています。CSRF の追加統合テスト、監査ログの保持・マスキング・クリーンアップは次フェーズで進めます。

**テストファイル**:
- `tests/unit/lib/jwt.test.ts`
- `tests/unit/lib/hash.test.ts` (Argon2 実装と互換性のユニットテストを追加・パス済)
- `tests/unit/lib/cookie.test.ts`
- `tests/unit/lib/csrf.test.ts`
- `tests/unit/lib/audit.test.ts`
- `tests/unit/features/auth/services/session.test.ts` (sessions DB helper のユニットテストを追加・パス済)

**受け入れ条件（現状）**:
- [x] JWT は 15 分で期限切れ、署名検証で改ざん検出 ✅ ユニットテストで確認済
- [x] パスワードハッシュは一方向で照合可能 ✅ `src/lib/hash.ts` を Argon2id に移行し、ユニットテストで検証済（legacy scrypt 互換対応含む）
- [ ] Cookie に `HttpOnly; Secure; SameSite=Lax` 設定 (要統合/ステージング検証)
- [ ] CSRF トークン生成・検証・ローテーション動作確認 (統合テスト待ち)
- [x] 監査ログ JSON Lines はマスキング済（DB 保存は実装済み、統合テスト残り）

**補足**:
- `src/lib/hash.ts` は Argon2id を主要アルゴリズムとし、既存の scrypt フォーマットをフォールバックで検証します。新規ハッシュは Argon2 で生成されます。パラメータは `timeCost=3, memoryCost=4096` の初期値でドキュメント化済（`docs/specs/01_auth.md` に記載）。
- `sessions` テーブル向けの DB ヘルパ（`src/features/auth/services/session.ts`）を実装し、refresh/logout フローで使われる SHA-256 トークンハッシュの照合・更新・失効処理をユニットテストで検証しました。

**次の作業（短期）**:
- CSRF ミドルウェアと cookie 設定の統合テストを作成しステージングで実行（推奨）
- `migrations/009_add_password_hash_algo.sql` のステージング適用検証（権限に注意）
- 結合テスト: `refresh` / `logout` / `password-reset` のシーケンスをステージング DB で確認


**実行手順**:
```bash
npm run test -- tests/unit/lib/
```

---

### [AUTH-01-04] レート制限ミドルウェア
**依存**: [AUTH-01-01], [AUTH-01-03]  
**対応 REQ**: REQ-AUTH-009（レート制限・不正検出）  
**対応 ARCH-ID**: ARCH-AUTH-09  
**対応詳細設計**: 詳細設計内で OAuth セクション「state / PKCE 保存方針」にて rate-limit 関連を参照  
**仕様書参照**: `docs/specs/01_auth.md` §5（レート制限・不正検出）, シーケンス図 `docs/seq/01_auth_seq.md` 内「IP and Account レート制御」

**実装ファイル**:
- `src/features/auth/middleware/rateLimit.ts` — IP/アカウント二軸レート制限ロジック
- `src/features/auth/ratelimit/index.ts` — レート制限サービス

**テストファイル**:
- `tests/unit/middleware/rateLimit.test.ts`
- `tests/integration/ratelimit.test.ts`

**受け入れ条件**:
- [ ] `/api/auth/*` エンドポイントで IP ベース 50 req/10min を制限
- [ ] アカウント別に `/api/auth/login` 5 failed attempts/10min で一時ブロック
- [ ] 429 Too Many Requests 応答で `Retry-After` ヘッダ付与
- [ ] 制限情報は `rate_limit_counters` テーブルに記録

**実行手順**:
```bash
npm run test -- tests/unit/middleware/rateLimit.test.ts
npm run test -- tests/integration/ratelimit.test.ts
```

---

## フェーズ 2: 認証エンドポイント実装

### [AUTH-01-05] Register エンドポイント（`POST /api/auth/register`）
**依存**: [AUTH-01-01], [AUTH-01-02], [AUTH-01-03]  
**対応 REQ**: REQ-AUTH-001（新規登録）  
**対応 ARCH-ID**: ARCH-AUTH-01  
**対応詳細設計**: 詳細設計内 OpenAPI スニペットに `/api/auth/register` POST 実装予定（現在 stub）  
**仕様書参照**: `docs/specs/01_auth.md` §4.1（新規登録）, シーケンス図 `docs/seq/01_auth_seq.md` §ユーザ登録フロー

**実装ファイル**:
- `src/app/api/auth/register/route.ts` — エンドポイント
- `src/features/auth/services/register.ts` — 登録ロジック
- `src/features/auth/schemas/register.ts` — スキーマ（既に [AUTH-01-02] で作成）

**テストファイル**:
- `tests/unit/services/register.test.ts`
- `tests/integration/api/auth/register.test.ts`

**E2E テスト**:
- `e2e/auth/register.spec.ts` — フロント登録フロー（Playwright）

**受け入れ条件**:
- [ ] （テスト未実施） 201 Created で新規ユーザレコード作成、`users` テーブルに記録
- [ ] （テスト未実施） 重複メールで 400 Bad Request
- [ ] （テスト未実施） レスポンス本体は `{ user: { id, email, display_name }, accessToken, refreshToken }`
- [ ] （テスト未実施） HTTP-only クッキーにリフレッシュトークン設定
- [ ] （テスト未実施） 監査ログ `auth.register.success` 記録

**実行手順**:
```bash
npm run test -- tests/unit/services/register.test.ts
npm run test -- tests/integration/api/auth/register.test.ts
npm run test:e2e -- e2e/auth/register.spec.ts
```

---

### [AUTH-01-06] Login エンドポイント（`POST /api/auth/login`）
**依存**: [AUTH-01-01], [AUTH-01-02], [AUTH-01-03], [AUTH-01-04]  
**対応 REQ**: REQ-AUTH-002（ログイン）, REQ-AUTH-009（レート制限）  
**対応 ARCH-ID**: ARCH-AUTH-02  
**対応詳細設計**: 詳細設計内 OpenAPI スニペットに `/api/auth/login` POST 実装予定（現在 stub）  
**仕様書参照**: `docs/specs/01_auth.md` §4.2（ログイン）, シーケンス図 `docs/seq/01_auth_seq.md` §ログインフロー

**実装ファイル**:
- `src/app/api/auth/login/route.ts` — エンドポイント
- `src/features/auth/services/auth.ts` — ログインロジック
- `src/features/auth/services/session.ts` — セッション管理ロジック

**テストファイル**:
- `tests/unit/services/auth.test.ts`
- `tests/integration/api/auth/login.test.ts`

**E2E テスト**:
- `e2e/auth/login.spec.ts` — ログインフロー（Playwright）

**受け入れ条件**:
- [ ] （テスト未実施） 200 OK で セッション Cookie 発行（`refresh_token_hash` をハッシュ化して DB に保存）
- [ ] （テスト未実施） 誤パスワード・存在しないメール → 401 Unauthorized
- [ ] （テスト未実施） `sessions` テーブルに `(user_id, refresh_token_hash, created_at, expires_at)` レコード作成
- [ ] （テスト未実施） レート制限：同一 IP から 50 req/10min、同一アカウント 5 failed/10min で 429
- [ ] （テスト未実施） 監査ログ `auth.login.success` or `auth.login.failure` 記録
- [ ] （テスト未実施） リスポンスに `accessToken` 含む（クライアント側で使用）

**実行手順**:
```bash
npm run test -- tests/unit/services/auth.test.ts
npm run test -- tests/integration/api/auth/login.test.ts
npm run test:e2e -- e2e/auth/login.spec.ts
```

---

### [AUTH-01-07] Refresh エンドポイント（`POST /api/auth/refresh`）— JTI ローテーション
**依存**: [AUTH-01-01], [AUTH-01-03], [AUTH-01-02]  
**対応 REQ**: REQ-AUTH-003（リフレッシュ・JTI 再利用検出）  
**対応 ARCH-ID**: ARCH-AUTH-03  
**対応詳細設計**: 詳細設計に JTI ローテーション・再利用検出ロジック記載予定  
**仕様書参照**: `docs/specs/01_auth.md` §4.3（ログアウト/セッション管理）, シーケンス図 `docs/seq/01_auth_seq.md` §リフレッシュ（JTI ローテーション/再利用検出）

**実装ファイル**:
- `src/app/api/auth/refresh/route.ts` — エンドポイント
- `src/features/auth/services/refresh.ts` — リフレッシュ・トークンローテーションロジック

**テストファイル**:
- `tests/unit/services/refresh.test.ts` (未作成)
- `tests/integration/api/auth/refresh.test.ts` (未作成 — JTI ローテーション / 再利用検出テストを追加予定, estimate: 0.5d) 

**E2E テスト**:
- `e2e/auth/refresh.spec.ts` — リフレッシュフロー（Playwright）

**受け入れ条件**:
- [ ] （テスト未実施） 200 OK で新しい accessToken + refreshToken 発行
- [ ] （テスト未実施） `sessions.current_jti` を新しい JTI に更新、旧トークン無効化
- [ ] （テスト未実施） リフレッシュトークン一致しない（改ざん検出） → 401 & 全セッション失効
- [ ] （テスト未実施） 有効期限切れ（expires_at < now） → 401
- [ ] （テスト未実施） 監査ログ `auth.refresh.success` or `auth.refresh.failure` 記録
- [ ] （テスト未実施） トークン再利用検出時は `quarantine` フラグ立てて通知準備

**実行手順**:
```bash
npm run test -- tests/unit/services/refresh.test.ts
npm run test -- tests/integration/api/auth/refresh.test.ts
npm run test:e2e -- e2e/auth/refresh.spec.ts
```

---

### [AUTH-01-08] Logout エンドポイント（`POST /api/auth/logout`）
**依存**: [AUTH-01-01], [AUTH-01-03]  
**対応 REQ**: REQ-AUTH-005（ログアウト/セッション管理）  
**対応 ARCH-ID**: ARCH-AUTH-05  
**対応詳細設計**: 詳細設計に logout エンドポイント実装例記載予定  
**仕様書参照**: `docs/specs/01_auth.md` §4.3（ログアウト）, シーケンス図 `docs/seq/01_auth_seq.md` §ログアウト

**実装ファイル**:
- `src/app/api/auth/logout/route.ts` — エンドポイント
- `src/features/auth/services/session.ts` — セッション無効化（既に [AUTH-01-07] で部分作成）

**テストファイル**:
- `tests/unit/services/session.test.ts` (未作成)
- `tests/integration/api/auth/logout.test.ts` (未作成 — セッション revoked_at / Cookie クリア検証, estimate: 0.5d) 

**E2E テスト**:
- `e2e/auth/logout.spec.ts` — ログアウトフロー（Playwright）

**受け入れ条件**:
- [ ] （テスト未実施） 204 No Content で当該セッション失効（`revoked_at` 設定）
- [ ] （テスト未実施） セッション Cookie クリア
- [ ] （テスト未実施） 監査ログ `auth.logout.success` 記録
- [ ] （テスト未実施） ログアウト後、旧リフレッシュトークン使用時は 401

**実行手順**:
```bash
npm run test -- tests/unit/services/session.test.ts
npm run test -- tests/integration/api/auth/logout.test.ts
npm run test:e2e -- e2e/auth/logout.spec.ts
```

---

### [AUTH-01-09] Password Reset フロー（`POST /api/auth/password-reset/{request,confirm}`）
**依存**: [AUTH-01-01], [AUTH-01-02], [AUTH-01-03]  
**対応 REQ**: REQ-AUTH-004（パスワード再設定）  
**対応 ARCH-ID**: ARCH-AUTH-04  
**対応詳細設計**: 詳細設計に password-reset エンドポイント（request/confirm）実装例記載予定  
**仕様書参照**: `docs/specs/01_auth.md` §4.4（パスワード再設定）, シーケンス図 `docs/seq/01_auth_seq.md` §パスワードリセット（request/confirm）

**実装ファイル**:
- `src/app/api/auth/password-reset/request/route.ts` — リセット要求
- `src/app/api/auth/password-reset/confirm/route.ts` — リセット確認
- `src/features/auth/services/password-reset.ts` — ロジック
- `migrations/001_create_password_reset_tokens.sql` — トークンテーブル（既に存在確認）

**テストファイル**:
- `tests/unit/services/password-reset.test.ts`
- `tests/integration/api/auth/password-reset.test.ts`

**E2E テスト**:
- `e2e/auth/password-reset.spec.ts` — リセットフロー（Playwright）

**受け入れ条件**:
- [ ] （テスト未実施） `/request` で 200 OK メール送信（Amazon SES）
- [ ] （テスト未実施） トークン `password_reset_tokens` テーブルに 1 時間 TTL で保存
- [ ] （テスト未実施） `/confirm` で 200 OK パスワード更新、トークン無効化（`used_at` 設定）
- [ ] （テスト未実施） 期限切れ・既使用トークンで 400
- [ ] （テスト未実施） 監査ログ `auth.password_reset.request` / `auth.password_reset.confirm` 記録

**実行手順**:
```bash
npm run test -- tests/unit/services/password-reset.test.ts
npm run test -- tests/integration/api/auth/password-reset.test.ts
npm run test:e2e -- e2e/auth/password-reset.spec.ts
```

---

### [AUTH-01-10] Admin: Revoke User Sessions（`POST /api/admin/revoke-user-sessions`）
**依存**: [AUTH-01-01], [AUTH-01-03]  
**対応 REQ**: REQ-AUTH-005（ログアウト/セッション管理・強制ログアウト）  
**対応 ARCH-ID**: ARCH-AUTH-05  
**対応詳細設計**: 詳細設計に管理 API revoke-user-sessions 記載予定  
**仕様書参照**: `docs/specs/01_auth.md` §4.3（強制ログアウト）

**実装ファイル**:
- `src/app/api/admin/revoke-user-sessions/route.ts` — エンドポイント（管理者認証必須）
- `src/features/auth/services/session.ts` — セッション一括無効化（既に [AUTH-01-07] で部分作成）

**テストファイル**:
- `tests/integration/api/admin/revoke-user-sessions.test.ts` (未作成 — 管理者認可と一括無効化検証, estimate: 0.5d) 

**受け入れ条件**:
- [ ] （テスト未実施） 200 OK で指定ユーザの全セッション失効（`revoked_at` 一括設定）
- [ ] （テスト未実施） 管理者認可のみ許可（401/403）
- [ ] （テスト未実施） 監査ログ `auth.admin.revoke_user_sessions` 記録

**実行手順**:
```bash
npm run test -- tests/integration/api/admin/revoke-user-sessions.test.ts
```

---

## フェーズ 3: セキュリティ実装

### [AUTH-01-11] CSRF 対策（ダブルサブミット）
**依存**: [AUTH-01-03]  
**対応 REQ**: REQ-AUTH-007（CSRF 対策）  
**対応 ARCH-ID**: ARCH-AUTH-07  
**対応詳細設計**: 詳細設計に CSRF ミドルウェア実装例記載予定（lib/csrf.ts）  
**仕様書参照**: `docs/specs/01_auth.md` §5（CSRF 実装パターン）, シーケンス図内「CSRF: ダブルサブミット方式」記載

**実装ファイル**:
- `src/lib/csrf.ts` — CSRF トークン管理（既に [AUTH-01-03] で基盤作成）
- `src/app/components/LoginForm.tsx` — フロント CSRF トークン取得・付与

**テストファイル**:
- `tests/unit/lib/csrf.test.ts` （既に [AUTH-01-03] 作成）
- `tests/integration/csrf.test.ts` — ミドルウェア統合テスト

**E2E テスト**:
- `e2e/security/csrf.spec.ts` — CSRF 攻撃シミュレーション（Playwright）

**受け入れ条件**:
- [ ] （テスト未実施） ログイン後に HttpOnly ではない CSRF Cookie 発行
- [ ] （テスト未実施） POST リクエストで `X-CSRF-Token` ヘッダ必須
- [ ] （テスト未実施） トークン不一致で 403 Forbidden
- [ ] （テスト未実施） トークン一回性ローテーション実装

**実行手順**:
```bash
npm run test -- tests/integration/csrf.test.ts
npm run test:e2e -- e2e/security/csrf.spec.ts
```

---

### [AUTH-01-12] 監査ログ保存・表示
**依存**: [AUTH-01-01], [AUTH-01-03]  
**対応 REQ**: REQ-AUTH-008（監査ログと保持ポリシー）  
**対応 ARCH-ID**: ARCH-AUTH-08  
**対応詳細設計**: 詳細設計に JSON Lines フォーマット・保持期間・マスキング例記載予定  
**仕様書参照**: `docs/specs/01_auth.md` §10（監査・観測・テスト）

**実装ファイル**:
- `src/lib/audit.ts` — 監査ログ出力（既に [AUTH-01-03] で基盤作成）
- `migrations/002_create_audit_logs.sql` — audit_logs テーブル（既に存在確認）
- `src/app/api/admin/audit-logs/route.ts` — 監査ログ取得エンドポイント

**テストファイル**:
- `tests/unit/lib/audit.test.ts` （既に [AUTH-01-03] 作成）
- `tests/integration/api/admin/audit-logs.test.ts`

**受け入れ条件**:
- [ ] （テスト未実施） 認証操作（login, logout, register, refresh）が JSON Lines で audit_logs テーブルに記録
- [ ] （テスト未実施） ログフォーマット: `{ id, timestamp, actor_id, action, resource, resource_id, ip, outcome, metadata }`
- [x] トークン・パスワードはマスク化（平文保存なし） ✅ 実装済
- [ ] （テスト未実施） 管理者のみ監査ログ参照可能（認可）
- [x] 保持期間 1 年（cleanup job で自動削除） ✅ 実装済（`scripts/cleanup-audit-logs.js` と `src/lib/auditCleanup.ts`）。ステージングで手動検証済：古いログ 1 件を削除（`audit.cleanup` に `deleted_count:1` が記録されました）。
- [x] cleanup を自動化する GitHub Actions ワークフローを追加（`.github/workflows/cleanup-audit-logs.yml`）。
  - 必要: リポジトリ Secrets に `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` を設定してください。`AUDIT_LOG_RETENTION_DAYS` はオプション（デフォルト 365 日）。
  - 実行スケジュール: 毎日 02:00 UTC（workflow_dispatch で手動実行可）

**実行手順**:
```bash
npm run test -- tests/integration/api/admin/audit-logs.test.ts
# 保持削除ジョブを手動実行する場合（環境変数を設定）
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run cleanup:audit-logs
# デフォルト保持期間は 365 日（AUDIT_LOG_RETENTION_DAYS 環境変数で上書き可）
```

---

## フェーズ 4: 統合テスト

### [AUTH-01-13] 結合テスト（登録→ログイン→リフレッシュ→ログアウトシーケンス）
**依存**: [AUTH-01-05], [AUTH-01-06], [AUTH-01-07], [AUTH-01-08]  
**対応 REQ**: REQ-AUTH-001/002/003/004/005/007/008/009（全機能統合）  
**対応 ARCH-ID**: ARCH-AUTH-01/02/03/04/05/07/08/09  
**対応詳細設計**: 詳細設計内で各エンドポイント/アーキテクチャ要素のテストケース参照  
**仕様書参照**: `docs/specs/01_auth.md` §10（テストケース）, シーケンス図 `docs/seq/01_auth_seq.md` 全体

**実装ファイル**:
- `tests/integration/auth-flow.test.ts` — フルシーケンステスト

**テストカバレッジ**:
1. ✅ 新規登録 → セッション発行
2. ✅ ログイン → 有効なセッション確認
3. ✅ リフレッシュ → トークンローテーション・JTI 更新
4. ✅ 同一リフレッシュトークン二回使用 → 全セッション失効
5. ✅ ログアウト → セッション無効
6. ✅ エラーシナリオ（存在しないメール、誤パスワード、期限切れトークン）

**受け入れ条件**:
- [ ] （テスト未実施） シーケンス図 `docs/seq/01_auth_seq.md` のフローすべてが実行可能
- [ ] （テスト未実施） 監査ログがシーケンスに従い記録される
- [ ] （テスト未実施） エラーハンドリング：不正状態で即座に検出・拒否

**実行手順**:
```bash
npm run test -- tests/integration/auth-flow.test.ts
```

---

### [AUTH-01-14] E2E テスト（Playwright）— ユーザーシナリオ全体
**依存**: すべての実装フェーズ  
**対応 REQ**: REQ-AUTH-001/002/003/004/005/007/008/009（全機能統合）  
**対応 ARCH-ID**: ARCH-AUTH-01/02/03/04/05/07/08/09  
**対応詳細設計**: 詳細設計内でシナリオごとのテスト計画記載予定  
**仕様書参照**: `docs/specs/01_auth.md` §10（E2E テスト自動化ポリシー）, シーケンス図全体

**実装ファイル**:
- `e2e/auth/full-flow.spec.ts` — 登録→確認→ログイン→買い物→リフレッシュ→ログアウト
- `e2e/auth/error-cases.spec.ts` — 異常系（誤パスワード、期限切れ、CSRF）
- `e2e/security/session-hijacking.spec.ts` — セッション盗聴シミュレーション

**テストシナリオ**:
1. ✅ 新規ユーザ登録フロー（Playwright で実施）
2. ✅ ログイン後、ヘッダーに `ri-user-fill` アイコン表示確認
3. ✅ 買い物フロー（認証セッション維持確認）
4. ✅ リフレッシュトークン自動更新（バックグラウンド）
5. ✅ ログアウト後、セッション無効確認
6. ✅ 重複登録 → 400 エラー
7. ✅ 誤パスワード → ログイン失敗
8. ✅ CSRF 攻撃ブロック
9. ✅ レート制限トリガー

**受け入れ条件**:
- [ ] すべてのシナリオで 期待通りの動作・エラー処理
- [ ] ログアウト後、保護されたリソースへのアクセス → 401
- [ ] パスワードリセットリンククリック → 自動ログイン → ヘッダー更新
- [ ] 監査ログがすべてのアクションで記録される

**実行手順**:
```bash
npm run test:e2e -- e2e/auth/full-flow.spec.ts
npm run test:e2e -- e2e/auth/error-cases.spec.ts
npm run test:e2e -- e2e/security/session-hijacking.spec.ts
```

---

# 実装前チェックリスト

実装開始前に以下を確認してください：

- [ ] `docs/specs/01_auth.md` §4.1-4.5 に目を通した
- [ ] `docs/seq/01_auth_seq.md` のシーケンス図を理解した
- [ ] `docs/ArchitectureDesign/auth-structure.md` の ARCH-ID マッピングを確認
- [ ] `docs/DetailDesign/auth-detailed.md` の詳細を参照
- [ ] Supabase 環境変数（`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`）をセット済み
- [ ] Amazon SES 認証情報（`AWS_SES_ACCESS_KEY_ID` 等）をセット済み

---

# 実装順序・依存関係

```
[AUTH-01-01] DB Migrations
    ↓
[AUTH-01-02] Zod Schemas
    ↓
[AUTH-01-03] Common Utils (JWT, CSRF, Audit)
    ↓
    ├─→ [AUTH-01-04] Rate Limit MW
    ├─→ [AUTH-01-05] Register Endpoint
    ├─→ [AUTH-01-06] Login Endpoint
    ├─→ [AUTH-01-07] Refresh Endpoint
    ├─→ [AUTH-01-08] Logout Endpoint
    ├─→ [AUTH-01-09] Password Reset
    └─→ [AUTH-01-10] Admin: Revoke Sessions
         ↓
    [AUTH-01-11] CSRF Implementation
    [AUTH-01-12] Audit Log Integration
         ↓
    [AUTH-01-13] Integration Tests (Full Sequence)
         ↓
    [AUTH-01-14] E2E Tests (Playwright)
```

---

# 完了基準（全体）

すべてのサブタスクが以下の条件を満たすと **[AUTH-01] 完了**:

1. ✅ すべての単体テスト実行 → pass
2. ✅ すべての結合テスト実行 → pass
3. ✅ E2E テスト（Playwright）すべて → pass
4. ✅ 監査ログが適切に記録される（管理画面で確認可）
5. ✅ 構造設計・詳細設計に記載されたすべての要件を実装
6. ✅ セキュリティレビュー完了（パスワードハッシュ、Cookie フラグ、CSRF、レート制限）
7. ✅ `npm run validate-docs` で設計ドキュメントが検証通過
8. ✅ 本番環境デプロイ前の smoke test 実行（CI/CD パイプライン）

---

# 紐づけ確認表（REQ / ARCH / 詳細設計 / 仕様書）

| チケットID | 対応 REQ-AUTH-XXX | 対応 ARCH-AUTH-XXX | 詳細設計セクション | 仕様書・シーケンス参照 |
|-----------|-----|-----|-----|-----|
| AUTH-01-01 | 001, 003, 005, 009 | 01, 03, 05, 09 | DB スキーマ各セクション | §8（データモデル） |
| AUTH-01-02 | 001, 002, 004 | 01, 02, 04 | OpenAPI スニペット（各パス） | §9（バリデーション） |
| AUTH-01-03 | 007, 008 | 07, 08 | OAuth 詳細設計内ユーティリティ | §5（セキュリティ）, §10（監査） |
| AUTH-01-04 | 009 | 09 | OAuth state/PKCE 保存方針 | §5（レート制限） |
| AUTH-01-05 | 001 | 01 | OpenAPI `/api/auth/register` | §4.1（新規登録） |
| AUTH-01-06 | 002, 009 | 02 | OpenAPI `/api/auth/login` | §4.2（ログイン） |
| AUTH-01-07 | 003 | 03 | JTI ローテーション実装 | §4.3（リフレッシュ） |
| AUTH-01-08 | 005 | 05 | logout エンドポイント | §4.3（ログアウト） |
| AUTH-01-09 | 004 | 04 | password-reset request/confirm | §4.4（パスワード再設定） |
| AUTH-01-10 | 005 | 05 | Admin revoke-user-sessions | §4.3（強制ログアウト） |
| AUTH-01-11 | 007 | 07 | CSRF ミドルウェア実装 | §5（CSRF 実装パターン） |
| AUTH-01-12 | 008 | 08 | 監査ログ JSON Lines フォーマット | §10（監査ログ） |
| AUTH-01-13 | 001～009 | 01～09 | 全セクション（統合テスト） | §10（テストケース）, シーケンス全体 |
| AUTH-01-14 | 001～009 | 01～09 | 全セクション（E2E テスト） | §10（E2E テスト自動化） |

---

# 漏れ確認リスト（仕様・設計の全体カバレッジ）

## 要求仕様（REQ-AUTH-XXX）の網羅性確認

- [x] **REQ-AUTH-001 — 新規登録**: AUTH-01-01 (DB), 01-02 (Schema), 01-05 (Endpoint), 01-13/14 (Test)
- [x] **REQ-AUTH-002 — ログイン**: AUTH-01-02 (Schema), 01-06 (Endpoint), 01-13/14 (Test)
- [x] **REQ-AUTH-003 — リフレッシュ**: AUTH-01-01 (DB), 01-02 (Schema), 01-07 (Endpoint), 01-13/14 (Test)
- [x] **REQ-AUTH-004 — パスワード再設定**: AUTH-01-02 (Schema), 01-09 (Endpoint), 01-13/14 (Test)
- [x] **REQ-AUTH-005 — ログアウト/セッション管理**: AUTH-01-01 (DB), 01-08 (Endpoint), 01-10 (Admin), 01-13/14 (Test)
- [x] **REQ-AUTH-006 — OAuth**: 別チケット AUTH-02（本チケットではカバーしない）
- [x] **REQ-AUTH-007 — CSRF 対策**: AUTH-01-03 (Util), 01-11 (Implementation), 01-13/14 (Test)
- [x] **REQ-AUTH-008 — 監査ログ**: AUTH-01-03 (Util), 01-12 (Implementation), 01-13/14 (Test)
- [x] **REQ-AUTH-009 — レート制限**: AUTH-01-01 (DB), 01-04 (MW), 01-06 (Login適用), 01-13/14 (Test)
- [x] **REQ-AUTH-010 — シークレット管理**: 本チケットでは `docs/ops/secrets.md` を参照、実装は運用タスク

## 構造設計（ARCH-AUTH-XXX）の実装カバレッジ

- [x] **ARCH-AUTH-01**: AUTH-01-01 (DB), 01-02 (Schema), 01-05 (Endpoint)
- [x] **ARCH-AUTH-02**: AUTH-01-02 (Schema), 01-06 (Endpoint)
- [x] **ARCH-AUTH-03**: AUTH-01-01 (DB), 01-02 (Schema), 01-07 (Endpoint)
- [x] **ARCH-AUTH-04**: AUTH-01-02 (Schema), 01-09 (Endpoint)
- [x] **ARCH-AUTH-05**: AUTH-01-01 (DB), 01-08 (Endpoint), 01-10 (Admin)
- [x] **ARCH-AUTH-06 (OAuth)**: 別チケット AUTH-02
- [x] **ARCH-AUTH-07**: AUTH-01-03 (Util), 01-11 (Implementation)
- [x] **ARCH-AUTH-08**: AUTH-01-03 (Util), 01-12 (Implementation)
- [x] **ARCH-AUTH-09**: AUTH-01-01 (DB), 01-04 (MW)
- [x] **ARCH-AUTH-10**: 運用タスク（secrets.md 参照）

## 詳細設計との対応確認

| 詳細設計セクション | 対応チケット | ステータス |
|---|---|---|
| OAuth: 既存アカウント衝突時ポリシー | AUTH-02（別チケット） | 後続 |
| OAuth 詳細設計 | AUTH-02（別チケット） | 後続 |
| DB マイグレーション（oauth_requests） | AUTH-02（別チケット） | 後続 |
| OpenAPI スニペット（oauth） | AUTH-02（別チケット） | 後続 |
| auth メール/パスワード系 API | AUTH-01-05 ~ 01-09 | **本チケット** |
| JWT/CSRF/Hash ユーティリティ | AUTH-01-03 | **本チケット** |
| 監査ログ JSON Lines 実装 | AUTH-01-12 | **本チケット** |

---

# 注：OAuth（REQ-AUTH-006, ARCH-AUTH-06）について

- **スコープ外**: 本チケット AUTH-01 では、メール/パスワード認証に限定
- **別チケット**: OAuth 実装は **AUTH-02** として分離（別途作成予定）
- **詳細設計**: `docs/DetailDesign/auth-detailed.md` に OAuth セクション記載済み

---

# チェックリスト / サブタスク進捗

## フェーズ 1: 基盤整備
- [x] AUTH-01-01: DB マイグレーション — `migrations/004_create_sessions.sql` を追加済（sessions テーブル初期実装）
- [ ] AUTH-01-02: Zod スキーマ
  - [ ] `tests/unit/schemas/refresh.test.ts` — 実装（estimate: 0.25d）
- [ ] AUTH-01-03: 共通ユーティリティ (jwt 実装済 — `jsonwebtoken` を追加。残作業: audit DB 統合、CSRF 統合テスト、ルート差し替え)
- [ ] AUTH-01-04: レート制限 MW
- [x] AUTH-01-15: Profiles trigger — 完了 (2026-02-01, 関数存在確認・ユニットテスト強化済) 

## フェーズ 2: エンドポイント
- [ ] AUTH-01-05: Register
- [ ] AUTH-01-06: Login
- [ ] AUTH-01-07: Refresh
  - [ ] `tests/unit/services/refresh.test.ts` — 実装（estimate: 0.5d）
  - [ ] `tests/integration/api/auth/refresh.test.ts` — 実装（estimate: 0.5d）
- [ ] AUTH-01-08: Logout
  - [ ] `tests/integration/api/auth/logout.test.ts` — 実装（estimate: 0.5d）
- [ ] AUTH-01-09: Password Reset
- [ ] AUTH-01-10: Admin: Revoke Sessions
  - [ ] `tests/integration/api/admin/revoke-user-sessions.test.ts` — 実装（estimate: 0.5d）

## フェーズ 3: セキュリティ
- [ ] AUTH-01-11: CSRF 対策
- [x] AUTH-01-12: 監査ログ (マスキング & 保持削除ジョブ実装済 — ステージング削除検証済: 1 件削除、統合テストの自動化/スケジュール化が残り)

## フェーズ 4: テスト
- [ ] AUTH-01-13: 結合テスト
- [ ] AUTH-01-14: E2E テスト（Playwright）

---

# 実装ノート

## 技術選択
- **パスワードハッシュ**: Bcrypt (npm: `bcrypt`)
- **JWT ライブラリ**: `jsonwebtoken` (npm: `jsonwebtoken`)
- **バリデーション**: Zod
- **テストフレームワーク**: Jest (unit/integration), Playwright (E2E)
- **メール送信**: Amazon SES

## セキュリティ考慮点
- リフレッシュトークンはハッシュ化して DB に保存し、平文は Cookie のみ
- JTI 再利用検出で quarantine & アラート
- 監査ログにはトークン・パスワード平文を保存しない（マスク化）
- CSRF Cookie は `HttpOnly=false, SameSite=Lax` で設定（ダブルサブミット方式）
- レート制限は IP + エンドポイント + アカウント の三軸で監視

## DB マイグレーション運用
- 各マイグレーションは `migrations/XXX_*.sql` 命名で Supabase に自動適用
- 破壊的変更前に必ずバックアップと롤백 테스트 실행
- ローカル開発では `npm run db:reset` で初期化可能

## デプロイ前チェック
- [ ] 環境変数すべてセット（`.env.local` に記載、本番は Secrets Manager）
- [ ] DB マイグレーション実行完了
- [ ] ユニット・結合・E2E テストすべて pass
- [ ] 監査ログ出力確認
- [ ] Playwright テスト本番環境で実行確認
- [ ] セキュリティスキャン（OWASP Top 10）実施

---

# 参考資料

- Supabase Auth: https://supabase.com/docs/guides/auth/
- OWASP Authentication: https://owasp.org/www-community/attacks/
- JWT Best Practices: https://tools.ietf.org/html/rfc7519
- Zod Documentation: https://zod.dev/
- Playwright: https://playwright.dev/

---

*最終更新: 2026-02-01 (SDD Agent)*
