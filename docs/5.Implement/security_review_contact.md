# contact セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/09_contact.md](../4_DetailDesign/09_contact.md)
- レビュー観点: フロントエンドフォーム、バックエンド/API、PII/監査 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts) | 公開問い合わせ API に Origin/Referer 検証、レート制限、Bot 対策がなく、クロスサイト送信や大量投稿で DB 書き込みとメール送信を悪用できる | IP・メール単位レート制限、Origin チェック、Turnstile か honeypot を追加する | Open | High |
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts) | 氏名、メール、件名、本文を audit_logs に平文保存し、監査用途を超えた PII 過収集と情報露出面を作っている | 問い合わせ本文は専用テーブルへ分離し、audit_logs には問い合わせ ID、結果、最小限の分類情報だけを記録する | Open | High |
| [src/app/api/admin/audit-logs/route.ts](../../src/app/api/admin/audit-logs/route.ts) | 共有秘密 1 本の x-admin-token だけで audit_logs を select(*) 返却しており、contact 由来の PII を広く取得できる | 既存の認証・RBAC に統合し、返却列を最小化し、機微情報を既定で返さない | Open | High |
| [migrations/007_create_audit_logs.sql](../../migrations/007_create_audit_logs.sql) | audit_logs に RLS と明示ポリシーがなく、外部入力 PII を入れる前提の最小権限が DDL 上で担保されていない | audit_logs を RLS 有効化し、管理者限定の参照ポリシーと service role 限定の書き込みポリシーを追加する | Open | High |