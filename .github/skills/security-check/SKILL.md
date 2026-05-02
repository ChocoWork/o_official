---
name: security-check
description: OWASP Top 10 (2021) / OWASP ASVS v4.0.3 / OWASP Secure Headers Project / OWASP Cheat Sheet Series / NIST SP 800-218 SSDF / MDN Web Security に準拠した、Next.js + React + TypeScript アプリケーションの厳格なセキュリティ監査を行う Skill。コード変更後・PR作成前・本番リリース前に必ず起動し、scripts/audit.sh による機械的検証を実施する。
---

# Security Check Skill

## 起動条件（必須）

以下のいずれかに該当する場合、このSkillを**必ず**起動する：

1. ユーザーが「セキュリティチェック」「監査」「audit」「脆弱性確認」「security review」を要求した
2. 認証・認可・暗号化・セッション管理・ファイルアップロード・外部API呼び出し・SQL関連のコードを変更した
3. `next.config.js` / `middleware.ts` / `.env*` / `package.json` を変更した
4. PR作成前 / リリース前のチェックを依頼された
5. ユーザー入力を扱う新規エンドポイント（Server Action / Route Handler）を追加した

## 実行フロー（厳守）

```
[1] スコープ特定    → 監査対象ファイル/ディレクトリの確定
[2] 静的解析        → scripts/audit.sh の実行（必須）
[3] 設定確認        → next.config.js / middleware.ts / tsconfig / env の検査
[4] 依存関係監査    → npm audit / lockfile 整合性
[5] 手動レビュー    → references/ の各チェックリストに沿って論点を提示
[6] 脅威分類        → 検出事項を OWASP Top 10 / ASVS の該当項目にマッピング
[7] リスク評価      → Critical / High / Medium / Low / Info で重大度を付与
[8] 修正提案        → 各検出事項に対し具体的な修正コードを提示
[9] 報告書生成      → Markdown 形式の監査レポートを出力
```

## 監査の必須カテゴリ

このSkillは以下の**14カテゴリ**を網羅的に検査する。1つでも省略してはならない。

### A. OWASP Top 10 (2021) 全項目

| ID | カテゴリ | 主要チェック観点 |
|---|---|---|
| A01 | Broken Access Control | Server Action/Route Handler の認証・認可、IDOR、Middleware バイパス |
| A02 | Cryptographic Failures | HTTPS強制、HSTS、Cookie属性、パスワードハッシュ、暗号アルゴリズム |
| A03 | Injection | SQLi、NoSQLi、コマンド、LDAP、XSS、テンプレート、`dangerouslySetInnerHTML` |
| A04 | Insecure Design | 脅威モデリング不在、レート制限不在、ビジネスロジック欠陥 |
| A05 | Security Misconfiguration | デフォルト設定、不要機能、エラーメッセージ過剰開示、`poweredByHeader` |
| A06 | Vulnerable Components | `npm audit`、依存パッケージのEOL、Lockfile欠落 |
| A07 | Identification & Auth Failures | セッション管理、パスワードポリシー、MFA、ブルートフォース対策 |
| A08 | Software & Data Integrity | SRI、署名検証、CI/CD整合性、信頼できないソースからの逆シリアライズ |
| A09 | Security Logging & Monitoring | ログ欠落、PIIログ漏洩、監査証跡、アラート |
| A10 | SSRF | 外部fetchの許可リスト、`images.remotePatterns`、内部IPアドレス禁止 |

### B. OWASP ASVS v4.0.3 重点章

- **V2 Authentication**: パスワードは Argon2id/bcrypt(cost≥12)/scrypt のみ、平文NG
- **V3 Session Management**: 推測不能なトークン、適切なTTL、ログアウトでの無効化
- **V4 Access Control**: Deny by default、リソース所有者検証、ロール検証
- **V5 Validation/Encoding**: 全境界での検証、出力エンコーディング、Zod/Valibot 必須
- **V7 Error Handling/Logging**: 機密情報を含まない汎用エラーメッセージ、構造化ログ
- **V8 Data Protection**: 機密データの暗号化（保管時/転送時）、不要な保持禁止
- **V9 Communications**: TLS 1.2+ 必須、HSTS preload、安全な暗号スイート
- **V10 Malicious Code**: サブリソース整合性、コードレビュー、依存関係署名検証
- **V13 API**: RESTfulバリデーション、レート制限、CORS最小許可
- **V14 Configuration**: ハードニング、不要なヘッダ削除、CSP

### C. OWASP Secure Headers Project

以下のレスポンスヘッダを必ず検査：

| ヘッダ | 推奨値 | 重要度 |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Critical |
| `Content-Security-Policy` | nonce/hash + `strict-dynamic`、`frame-ancestors 'none'` | Critical |
| `X-Frame-Options` | `DENY` (CSP `frame-ancestors` 併用) | High |
| `X-Content-Type-Options` | `nosniff` | High |
| `Referrer-Policy` | `strict-origin-when-cross-origin` または `no-referrer` | High |
| `Permissions-Policy` | 不要機能を空配列で無効化 | High |
| `Cross-Origin-Opener-Policy` | `same-origin` | Medium |
| `Cross-Origin-Embedder-Policy` | `require-corp`（必要時） | Medium |
| `Cross-Origin-Resource-Policy` | `same-origin` | Medium |
| `Cache-Control` | 認証ページは `no-store` | High |
| `Server` / `X-Powered-By` | 削除/隠蔽 | Medium |

### D. OWASP Cheat Sheet Series

参照する Cheat Sheet：
- XSS Prevention Cheat Sheet
- DOM-based XSS Prevention Cheat Sheet
- Content Security Policy Cheat Sheet
- Authentication Cheat Sheet
- Session Management Cheat Sheet
- Authorization Cheat Sheet
- Input Validation Cheat Sheet
- SQL Injection Prevention Cheat Sheet
- Cross-Site Request Forgery Prevention Cheat Sheet
- Password Storage Cheat Sheet
- HTTP Strict Transport Security Cheat Sheet
- File Upload Cheat Sheet

### E. NIST SP 800-218 SSDF (Secure Software Development Framework)

4つのプラクティスグループを検査：

- **PO (Prepare the Organization)**: セキュリティ要件、役割定義、ツール整備
- **PS (Protect the Software)**: コード署名、バージョン管理、改ざん検知
- **PW (Produce Well-Secured Software)**: 設計レビュー、セキュアコーディング、SAST/DAST、レビュー
- **RV (Respond to Vulnerabilities)**: 脆弱性受領窓口、修正、根本原因分析

### F. MDN Web Security

- Subresource Integrity (SRI)
- HTTPS / Mixed Content
- Cookie Security (Secure / HttpOnly / SameSite / __Host- prefix)
- CORS の最小権限設定
- Clickjacking 対策
- Trusted Types（CSP）

## 重大度評価基準

| 重大度 | CVSS目安 | 対応 |
|---|---|---|
| 🔴 Critical | 9.0-10.0 | リリース不可。即時修正必須 |
| 🟠 High | 7.0-8.9 | リリース前に修正必須 |
| 🟡 Medium | 4.0-6.9 | 次スプリントで修正 |
| 🔵 Low | 0.1-3.9 | バックログ管理 |
| ⚪ Info | — | 推奨事項 |

## 詳細リファレンス

- `references/owasp-top10-checklist.md` — OWASP Top 10 詳細チェックリスト
- `references/asvs-checklist.md` — ASVS v4.0.3 抜粋チェックリスト
- `references/secure-headers.md` — セキュアヘッダ詳細仕様
- `references/cheatsheets-summary.md` — Cheat Sheet Series サマリ
- `references/ssdf-mapping.md` — NIST SSDF マッピング表

## 検証スクリプト

すべての監査で以下を**必ず**実行する：

```bash
bash .claude/skills/security-check/scripts/audit.sh [対象パス]
```

引数なしの場合はプロジェクト全体（`app/`, `components/`, `lib/`, `pages/`, `next.config.*`, `middleware.*`）を対象とする。

## 出力フォーマット（監査レポート）

監査結果は必ず以下の構造で報告する：

```markdown
# Security Audit Report

**監査日時**: YYYY-MM-DD HH:MM
**対象**: <ファイル/ディレクトリ>
**監査基準**: OWASP Top 10 (2021), ASVS v4.0.3, NIST SSDF, OWASP Secure Headers

## エグゼクティブサマリ
- Critical: N件 / High: N件 / Medium: N件 / Low: N件 / Info: N件
- リリース可否判定: 🔴 NO-GO / 🟢 GO

## 検出事項

### 🔴 [CRITICAL] [カテゴリ] 概要
- **OWASP分類**: A03:2021-Injection
- **ASVS**: V5.3.4
- **CWE**: CWE-89
- **該当箇所**: app/api/users/route.ts:42
- **詳細**: ...
- **影響**: ...
- **再現手順**: ...
- **修正案**:
  ```typescript
  // 修正コード
  ```
- **参照**: <Cheat Sheet URL>

(以降、重大度順に列挙)

## 推奨事項
- ...

## 監査基準カバレッジ
- OWASP Top 10: A01 ✅ / A02 ✅ / ...
- ASVS V2 ✅ / V3 ✅ / ...
```

## 禁止事項

- 検査の省略・スキップ（「明らかに安全」という判断を理由とした省略を含む）
- 検出事項の重大度を独自基準で下げること
- 修正案を提示せず指摘のみで完了すること
- スクリプト未実行のまま「監査完了」と宣言すること
- 偽陽性の可能性を理由に検出事項を非表示にすること（必ず報告し、判断はユーザーに委ねる）