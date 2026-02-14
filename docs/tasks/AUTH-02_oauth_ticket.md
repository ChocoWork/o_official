---
status: done
id: AUTH-02
title: OAuth（Google）ログイン実装
priority: low
estimate: 3-5d
assignee: unassigned
dependencies:
  - AUTH-01
created: 2026-02-12
updated: 2026-02-13
refs:
  - docs/specs/01_auth.md
  - docs/seq/01_auth_seq.md
  - docs/ArchitectureDesign/auth-structure.md
  - https://supabase.com/docs/guides/auth
---

# 概要

Google OAuth による「新規アカウント作成」と「ログイン」を実装する。

- 仕様: docs/specs/01_auth.md §4.5（OAuth Google）
- 仕様準拠として、`/api/auth/oauth/start` と `/api/auth/oauth/callback` で state/PKCE と `oauth_requests` をサーバ側管理する。
- 既存メール衝突時の「リンク提案フロー」は今回 **未実装（衝突時はエラー方針）**。

# 実装範囲

## In
- Google OAuth の開始（Login UIボタンから）
- OAuth callback で `code` をサーバ交換し、Cookie発行 + 303リダイレクト
- `oauth_requests` による state/PKCE の短期保存（TTL/one-time）
- callback 異常系（state期限切れ・再利用・トークン交換失敗）と正常系の統合テスト

## Out
- 既存メール衝突時のリンク提案（link-proposal/link-confirm）
- OAuth unlink/re-link 管理API

# 実装ファイル

- src/app/components/LoginContext.tsx
- src/app/components/LoginModal.tsx
- src/app/api/auth/oauth/start/route.ts
- src/app/api/auth/oauth/callback/route.ts
- migrations/011_create_oauth_requests.sql
- tests/integration/api/auth/oauth-start.test.ts
- tests/integration/api/auth/oauth-callback.test.ts

# 受け入れ条件

- [x] ログイン画面の「Googleでログイン」から Google OAuth を開始できる
- [x] OAuth callback で `code` をサーバ交換し、Cookie発行 + 303リダイレクトできる
- [x] callback URL から `code` 等が残らない（クリーン遷移）
- [x] callback 異常系（state期限切れ/再利用/トークン交換失敗）の統合テストがある
- [x] callback 正常系（token交換成功→Cookie発行→303リダイレクト）の統合テストがある
- [x] callback の入力不正（code/state欠落）で 400 を返すテストがある
- [x] callback で session persist 失敗時も 303 を返すテストがある
- [ ] 既存メール衝突時はエラー（暫定・次フェーズ）
- [x] Google OAuth で新規登録（初回ログイン）と既存Googleユーザーのログインが可能

# セットアップ（Supabase側）

- Supabase Dashboard > Authentication > Providers > Google を有効化
- Redirect URL に以下を追加:
  - `http://localhost:3000/api/auth/oauth/callback`
  - 本番ドメイン（例）: `https://<your-domain>/api/auth/oauth/callback`

# 実行/確認手順

1. `npm run dev`
2. `/login` を開き「Googleでログイン」を押下
3. 認証後 `/api/auth/oauth/callback` を経由して `/auth/verified`（→ `/account`）へ遷移すること

# 残タスク（洗い出し）

- [ ] 既存メール衝突時のリンク提案/再認証フロー（link-proposal/link-confirm）
- [ ] `oauth_accounts` 管理（provider_user_id ユニーク制約を含む）
- [ ] unlink/re-link 管理API
- [ ] cleanup ジョブ（期限切れ/used の oauth_requests 定期削除）

