# contact セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/09_contact.md](../4_DetailDesign/09_contact.md)
- レビュー観点: スパム対策、メールヘッダインジェクション、入力検証、監査、レート制限、個人情報保護、CSRF、メール送信失敗時の情報露出

---

## ステータス凡例

|ステータス|意味|
|---|---|
| Open | 未修正 |
| Partially Fixed | アプリケーション層では対処済みだが、防御が部分的またはインフラ前提が残る |
| Fixed | 修正済み |

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts) | 公開問い合わせ API は認証不要のため、クロスサイト送信対策が弱いと CSRF 的な不正投稿の踏み台になり得る | 現在の Origin/Referer チェックを維持しつつ、将来の仕様変更に備えて二重化として CSRF トークン方式（Double Submit Cookie など）を導入する | Partially Fixed | isSameOriginRequest で Origin 優先、なければ Referer origin を検証し、不一致・欠落時は 403 を返す実装を確認。現時点で実害は抑止できているが、ヘッダ依存単独防御のため余地あり | Medium |
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts), [src/lib/turnstile.ts](../../src/lib/turnstile.ts) | Bot 対策が honeypot + レート制限中心で、turnstile 実装が問い合わせ API に未適用。分散 Bot や高度自動化で突破される余地がある | turnstileToken を contactSchema に追加し、サーバで verifyTurnstile を必須検証（本番）。失敗時は 403 で監査記録する | Partially Fixed | honeypot と IP/メール単位制限は実装済みだが、問い合わせ API 内で verifyTurnstile 呼び出しは未確認。src/lib/turnstile.ts は存在するが未接続 | Medium |
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts), [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts) | レート制限キーの IP 抽出が x-forwarded-for / x-real-ip をそのまま信頼しており、プロキシ境界の設定次第でヘッダ偽装による回避リスクが残る | 信頼プロキシ境界でのヘッダ上書きを前提にしつつ、アプリ側でも trusted proxy 前提を明文化。可能ならプラットフォーム提供 IP 取得 API へ寄せる | Partially Fixed | enforceRateLimit は実装済みで 429/Retry-After 返却も確認。ただし IP 真正性はインフラ依存。設計上の注意点として残存 | Medium |
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts) | メール件名にユーザー入力 subject をそのまま使用しており、CR/LF 混入によるメールヘッダインジェクション耐性が明示されていない | 送信前に subject.replace(/[\r\n]+/g, ' ') で改行除去し、必要なら許可文字 allowlist を追加する | Open | 現在は SES SDK 経由で構造化送信しているため即時の侵害確度は高くないが、防御は送信基盤挙動に依存。アプリ側の明示防御が未実装 | Medium |
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts) | バリデーション失敗時に details: parsed.error.flatten() を返却しており、攻撃者に入力ルール探索の手掛かりを追加提供する | 本番は詳細を返さず汎用エラーのみにし、詳細はサーバログまたは監査へ限定する | Open | 現在のレスポンスは機密情報漏えいではないが、攻撃効率を上げる情報露出になり得る。セキュリティ強化余地として確認 | Low |
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts), [src/lib/audit.ts](../../src/lib/audit.ts), [migrations/041_create_contact_inquiries.sql](../../migrations/041_create_contact_inquiries.sql) | 監査ログへ問い合わせ本文を保存しない方針は良いが、問い合わせ本体テーブルには PII が平文保持され、保持期間・マスキング・削除運用が DDL 上で定義されていない | contact_inquiries に保管期間ポリシー（例: 180日）を定義し、定期削除ジョブや暗号化方針（列暗号化/鍵管理）を運用設計へ追加する | Open | audit_logs には email_hash など最小情報のみ記録する実装を確認。一方 contact_inquiries は name/email/message/ip/user_agent を平文保持し続ける設計 | Medium |
| [migrations/041_create_contact_inquiries.sql](../../migrations/041_create_contact_inquiries.sql), [migrations/007_create_audit_logs.sql](../../migrations/007_create_audit_logs.sql), [src/app/api/admin/audit-logs/route.ts](../../src/app/api/admin/audit-logs/route.ts) | 監査・問い合わせデータへの広範アクセスがあると情報露出につながる | 現行の RLS + RBAC + safe column 選択を維持し、権限棚卸しを定期実施する | Fixed | contact_inquiries は直接操作 Deny ポリシー、audit_logs は RLS + has_permission('admin.audit.read')、管理 API は安全列のみ返却を確認 | High |
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts) | メール送信失敗時のエラーをそのまま利用者へ返すと内部構成が露出するリスクがある | 現行の「履歴保存優先・外部レスポンス成功固定」を維持し、詳細は監査ログに限定する | Fixed | sendMail 失敗時は console.warn と logAudit(contact.submit.mail) のみ実行し、API レスポンスは success: true を維持する実装を確認。外部への過剰情報露出なし | Low |
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts), [e2e/FR-CONTACT-011-security-controls.spec.ts](../../e2e/FR-CONTACT-011-security-controls.spec.ts) | セキュリティテストが Origin 拒否と honeypot 拒否に偏っており、レート制限超過・メールヘッダインジェクション・PII最小化の回帰検知が不足 | 429 応答、Retry-After、CR/LF 含む subject の拒否/正規化、監査ログの非PII保証を E2E/統合テストへ追加する | Open | 既存 E2E で Origin/honeypot は確認できる一方、重点観点のうち複数（レート制限実効性、ヘッダインジェクション耐性）は未自動化 | Low |

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 0件
- Medium: 3件
- Low: 2件

### セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts) | `request.json()` 前の本文サイズ上限が未設定 | Content-Length 上限を導入し、超過時 413 を返す | Open | 可用性リスクとして追加確認 | Medium |
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts) | 監査用 email_hash がソルトなし SHA-256 | HMAC-SHA256 へ変更または保存廃止 | Open | 再識別耐性の改善余地 | Medium |
| [src/lib/turnstile.ts](../../src/lib/turnstile.ts) | timeout/hostname/action 検証が不足 | AbortController と hostname/action 検証を追加 | Open | success 判定中心で厳密性不足 | Medium |
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts), [src/lib/mail/adapters/ses.ts](../../src/lib/mail/adapters/ses.ts) | 宛先フォールバックが設定ミス時の誤送信面になる | CONTACT_TO_EMAIL 固定運用へ寄せる | Open | 運用ミス耐性が弱い | Low |
| [src/app/api/contact/route.ts](../../src/app/api/contact/route.ts) | mailError のログが過剰になり得る | 外部可視ログは最小化し、詳細は保護基盤へ | Open | ログアクセス境界依存のリスク | Low |

### 重点観点ごとの結論

1. contact は入力サイズ制御と turnstile 厳格化が中心課題。
2. PII 最小化は hash 方式とログ方針の両面で改善余地あり。
3. 重大な新規 High は未検出。

### 推奨対応順序

1. 本文サイズ上限 + 413 制御（Medium）
2. email_hash の HMAC 化（Medium）
3. turnstile 厳格検証追加（Medium）
4. 宛先フォールバック/ログ最小化（Low）
