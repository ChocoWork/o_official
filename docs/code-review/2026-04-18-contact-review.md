# Code Review: Contact

**Ready for Production**: No
**Critical Issues**: 4

## Review Scope

- Pass 1: フォーム入力、XSS、情報露出
- Pass 2: API、バックエンド、CSRF、レート制限、スパム対策、メール送信
- Pass 3: DB、監査、PII 取り扱い、シークレット

## Priority 1 (Must Fix)

1. 公開の contact API に Origin 検証、CSRF 相当の防御、レート制限、Bot 対策がない。
2. 問い合わせ本文、氏名、メールアドレスを監査ログへ平文保存しており、共通マスキング経路も通っていない。
3. 監査ログ閲覧 API が共有トークン 1 本で `select('*')` を返し、contact の PII をそのまま取得できる。
4. audit_logs テーブルに RLS と明示的ポリシーがなく、最小権限の DB 制約が DDL 上で担保されていない。

## Findings

### src/app/api/contact/route.ts

- `POST /api/contact` は公開エンドポイントだが、Origin/Referer 検証がなく、`enforceRateLimit` や Turnstile 相当の Bot 防御も未実装。
- `historyRecord` に `actor_email`, `detail`, `metadata.name`, `metadata.message` を格納しており、問い合わせ内容を監査ログへ過剰保存している。
- `logAudit` を使わず直接 `audit_logs` に insert しているため、既存のマスキング処理も適用されない。

### src/app/api/admin/audit-logs/route.ts

- `x-admin-token` の静的共有秘密だけで認可し、`audit_logs` を `select('*')` で返している。
- contact 由来の PII が監査ログに入っているため、この API がそのまま情報露出経路になる。

### migrations/007_create_audit_logs.sql

- `audit_logs` を作成しているが、RLS 有効化や明示的ポリシー定義がない。
- contact のような外部入力由来の PII を保存する用途には不十分。

## Recommended Changes

- contact API に Origin/Referer チェック、IP 単位とメール単位のレート制限、Turnstile か honeypot を追加する。
- 問い合わせ保存先を `audit_logs` から専用テーブルへ分離し、監査ログには問い合わせ ID と結果だけを残す。
- 監査ログ閲覧 API は共有トークン方式をやめ、既存の認証・権限制御へ統合し、返却列を最小化する。
- `audit_logs` に RLS と明示的ポリシーを追加し、用途ごとに保存データを最小化する。