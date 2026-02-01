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

## まず出力するセクション（優先順）
1. OpenAPI スニペット（`/api/auth/register`, `/api/auth/login`, `/api/auth/refresh`, `/api/auth/password-reset/*`）
2. DB マイグレーション草案（sessions テーブル拡張, password_reset_tokens, oauth_accounts）
3. TypeScript 型 & Zod スキーマ（`src/features/auth/schemas.ts`）
4. API Route スタブ（`src/app/api/auth/*/route.ts`）
5. テスト計画（Unit / Integration / E2E）

---
*注: 詳細設計は構造設計の合意（文末の「次のアクション: 1. 構造設計のレビュー」）を受けてから作成します。続けて詳細設計を生成してよい場合は承認コメントをください。*