---
status: todo
id: AUTH-01
title: 認証基盤の実装（メール/パスワード、セッション管理、監査）
priority: high
estimate: 8d
assignee: unassigned
dependencies: []
created: 2026-01-17
updated: 2026-01-17
---

# 概要

Next.js + Supabase を前提とした認証基盤を実装する。メール/パスワード登録・ログイン・パスワード再設定・セッション管理（リフレッシュ含む）・監査ログ保存・CSRF 対策などを含む。

# 詳細

- エンドポイント（実装対象）:
  - `POST /api/auth/register` — 新規登録（重複メールは拒否、201 Created）
  - `POST /api/auth/login` — ログイン（200 OK + HttpOnly セッションクッキー）
  - `POST /api/auth/password-reset/request` — 再設定トークン発行（有効期限 1h）
  - `POST /api/auth/password-reset/confirm` — トークン検証・パスワード更新
  - `POST /api/auth/refresh` — リフレッシュトークン検証とトークンローテーション（200 OK + Set-Cookie）
  - `POST /api/auth/logout` — 現セッション失効（204 No Content）
  - `POST /api/auth/revoke-user-sessions` — 指定ユーザの全セッション失効（管理用）

- データモデル（参照）:
  - `users` テーブル: `id, email (unique), password_hash, display_name, kana_name, phone, address, created_at`
  - `sessions` テーブル: `id, user_id, refresh_token_hash, created_at, expires_at, revoked_at, last_seen_at`

- セキュリティ/運用:
  - パスワードハッシュ: Argon2 または Bcrypt
  - Cookie: `HttpOnly; Secure; SameSite=Lax`
  - CSRF: 同期トークンまたはダブルサブミット方式。`X-CSRF-Token` ヘッダ検証。
  - トークン寿命: アクセストークン 15分、リフレッシュ 7日（スライディング、最大延長 30日）、パスワードリセット 1時間
  - 監査ログ: ログイン成功/失敗、リフレッシュ、ログアウト、セッション失効、パスワード変更を JSON Lines で記録

# 受け入れ条件

1. 新規登録で `201 Created`、`users` にレコード作成される。
2. 正常なログインで `200 OK` と HttpOnly セッションクッキーが返る。
3. パスワード再設定トークンは発行から 1h で期限切れとなり、期限切れトークンは拒否される。
4. `POST /api/auth/refresh` でトークンローテーションが行われ、旧トークンは無効化される。
5. `POST /api/auth/logout` で当該セッションは即時に失効する。
6. 重要な認証操作は監査ログに構造化ログとして保存される。

# 実装ノート / 技術的考慮点

- バリデーション: フロント/サーバ共に Zod を使用。
- トークン保存はハッシュ化（`refresh_token_hash`）で DB に保存し、受け取ったトークンは一方向ハッシュで照合する。
- リフレッシュ時の不一致検出は全セッション失効 + アラートをトリガーする設計とする。
- 監査ログは WORM ストレージまたは署名で改ざん防止することを推奨。
- 破壊的 DB 変更が必要な場合はマイグレーション手順を別ドキュメントで提示する。

# 依存関係

- メール送信プロバイダ（SendGrid 等）
- Secrets 管理（`JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` 等）

# チェックリスト / サブタスク

- [ ] ユーザ登録エンドポイント実装（`POST /api/auth/register`）
- [ ] ログインエンドポイント実装（`POST /api/auth/login`）
- [ ] パスワードリセットフロー実装（発行・確認）
- [ ] セッション管理・リフレッシュ・ログアウト実装
- [ ] 監査ログ出力実装
- [ ] 単体テスト / E2E テスト（登録→ログイン→リフレッシュ→ログアウト）

# 備考 / TODO

- 必要に応じて、メール確認（email verification）を別チケットで実装するか本チケット内で扱うかをプロダクトに確認する。TODO: question for product
