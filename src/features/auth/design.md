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
- ARCH-AUTH-01: Register / Confirm（パスキー段4で窓口ごと廃止。メールのコードの `/api/auth/email-code/*` に一本化）
- ARCH-AUTH-02: Login（メールのコード・Google・パスキー。パスワードのログインは段4で廃止）
- ARCH-AUTH-03: Refresh / JTI
- ARCH-AUTH-04: Password Reset（段4で廃止）
- ARCH-AUTH-05: Logout / Revoke Sessions
- ARCH-AUTH-06: OAuth
- ARCH-AUTH-07: CSRF / Cookie
- ARCH-AUTH-08: Audit Log
- ARCH-AUTH-09: Rate Limit
- ARCH-AUTH-10: Secrets Management
- ARCH-AUTH-11: Privileged MFA (Admin / Supporter)（段4で TOTP を廃止。店員の入口はパスキー）

## まず出力するセクション（優先順）
1. OpenAPI スニペット（`/api/auth/email-code/*`, `/api/auth/refresh`。パスワードの登録・ログイン・再設定の窓口はパスキー段4で消えた）
2. DB マイグレーション草案（sessions テーブル拡張, oauth_accounts（password_reset_tokens は段4の移行 K で消す））
3. TypeScript 型 & Zod スキーマ（`src/features/auth/schemas.ts`）
4. API Route スタブ（`src/app/api/auth/*/route.ts`）
5. テスト計画（Unit / Integration / E2E）

## ARCH-AUTH-11: Privileged MFA (Admin / Supporter)

パスキー段4（ADR-0475）で、認証アプリ（TOTP）の登録・確認の窓口（`/api/auth/mfa/*`）、確認の画面 `/auth/verified`、MFA のやり直しの窓口
（`/api/admin/users/mfa/reset`）を消した。店員の入口は、パスキーでログインし、認めた鍵が2本そろっているか（`mfaVerified` の名前は変えない）で決める。
経緯の記録は ADR-0475 と `docs/03_BasicDesign/areas/auth.md` を参照。

---
*注: 詳細設計は構造設計の合意（文末の「次のアクション: 1. 構造設計のレビュー」）を受けてから作成します。続けて詳細設計を生成してよい場合は承認コメントをください。*