# signup セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/14_login.md](../4_DetailDesign/14_login.md)
- 対象補足: signup 専用ページは未確認のため、signup 相当の OTP/register/confirm 導線をレビュー
- レビュー観点: フロントエンド導線、バックエンド/API、DB/セッション/監査 を 3 パスで確認

---

## ステータス凡例

|ステータス|意味|
|---|---|
| Open | 未修正 |
| Partially Fixed | アプリケーション層では対処済み、DB/インフラ層は未対処 |
| Fixed | 修正済み |

---

## セキュリティレビュー結果
| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/api/auth/otp/verify/route.ts](../../src/app/api/auth/otp/verify/route.ts) | 認証成功時に access token / refresh token を JSON と localStorage に露出しており、XSS 1 回でセッション奪取が成立する | トークンは HttpOnly Cookie のみで扱い、API レスポンスから除去する | Fixed | High |
| [src/app/api/auth/identify/route.ts](../../src/app/api/auth/identify/route.ts) | JIT 作成で email_confirm: true を使っており、メール所有確認前に確認済みアカウントを作成している | email_confirm: true を廃止し、未確認状態のまま OTP/confirm 完了時に確定させる | Fixed | High |
| [src/lib/redirect.ts](../../src/lib/redirect.ts) | x-forwarded-host / x-forwarded-proto を無条件で信頼して origin を組み立てており、確認メールリンクや confirm リダイレクトで Host header poisoning が成立しうる | origin は設定済み allowlist で固定し、信頼済み proxy 由来ヘッダのみ採用する | Fixed | High |
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Cookie ヘッダや token の一部をログ出力しており、認証情報がサーバログやブラウザコンソールに残る | 認証トークン、Cookie、Authorization ヘッダはログ出力しない | Fixed | High |
| [migrations/004_create_sessions.sql](../../migrations/004_create_sessions.sql) | sessions、rate_limit_counters、audit_logs に RLS/policy 定義がなく、認証系保護テーブルの防御が不足している | 全テーブルで RLS を有効化し、service_role のみ全面許可、必要最小限の authenticated policy のみに絞る | Fixed | High |
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | DB 障害時に rate limit が fail-open で素通しになり、認証 API の総当たり防御が消える | 高リスク endpoint は fail-closed、少なくとも edge/in-memory fallback を追加する | Fixed | High |

---

## 追加レビュー追記（2026-04-29 / signup OWASP Top10 再点検）

- 対象: [src/app/signup/](../../src/app/signup/), [src/app/api/auth/register/route.ts](../../src/app/api/auth/register/route.ts), signup 導線の認証関連
- 実施観点: OWASP Top 10（A01, A05, A07）と Secure Coding
- 事実確認: [src/app/signup/](../../src/app/signup/) は空ディレクトリで、実装本体は [src/app/login/page.tsx](../../src/app/login/page.tsx) と認証 API 群に集約

### サマリー（追加分）

- High: 1件（Open）
- Medium: 2件（Open）
- Low: 2件（Open）
- N/A: 1件

### 追加指摘一覧

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/api/auth/register/route.ts](../../src/app/api/auth/register/route.ts) | 公開登録フロー成功時に `access_token` を JSON 返却しており、XSS 到達時のトークン窃取面が復活している（A02/A07）。`NextResponse.json({ access_token: ... })` が残存 | レスポンスからトークンを完全除去し、HttpOnly Cookie のみでセッションを確立する。クライアント返却は最小情報（成功メッセージ等）に限定する | Open | High |
| [src/app/api/auth/register/route.ts](../../src/app/api/auth/register/route.ts) | 既存メール時のみ 409 + 固定メッセージを返し、新規時 202/201 と明確に分岐するためアカウント列挙が可能（A07） | 登録可否を同一レスポンスに寄せる（例: 常に 202 + 汎用文言）か、列挙対策の遅延・ダミー処理を導入する | Open | Medium |
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | `x-forwarded-for` / `x-real-ip` を無条件採用しており、環境次第でヘッダ偽装によりレート制限キーを回避できる（A05） | 信頼済みプロキシ環境でのみ転送ヘッダを採用し、それ以外はプラットフォーム提供の信頼 IP を使用する。認証系は `subject` 軸を必須化する | Open | Medium |
| [src/app/api/auth/register/route.ts](../../src/app/api/auth/register/route.ts) | 管理者作成と公開登録が同一 endpoint に混在し、`x-admin-token` ヘッダだけで分岐しているため、運用ミス時の権限境界が複雑化（A01 設計リスク） | 管理者作成を専用管理 endpoint に分離し、通常登録 endpoint から特権分岐を削除する。加えて管理操作は監査項目を拡充する | Open | Low |
| [tests/integration/api/auth/register.test.ts](../../tests/integration/api/auth/register.test.ts) | テストが `access_token` の JSON 返却を期待しており、セキュア化時に退行を見逃しやすい | トークン非返却を期待値に変更し、Cookie 設定有無とレスポンス最小化を検証するセキュリティ回帰テストへ更新する | Open | Low |
| [src/app/signup/](../../src/app/signup/) | ディレクトリは存在するが実装ファイルなし。signup 実体は login/OTP 導線で提供されている | セキュリティ問題ではないため N/A。ただし仕様と実装の対応関係を設計書に明記して監査対象の曖昧さを減らす | N/A | Low |

### 追加レビュー時点の重点結論

1. 最優先は、[src/app/api/auth/register/route.ts](../../src/app/api/auth/register/route.ts) のトークン JSON 返却を停止すること。
2. 次点で、列挙耐性（登録レスポンスの均質化）とレート制限キーの信頼境界を強化すること。
3. [src/app/signup/](../../src/app/signup/) が空である点は脆弱性ではないが、レビュー対象誤認を防ぐためドキュメント整備が必要。

### 推奨対応順序（追加分）

1. `register` 成功レスポンスから `access_token` を除去（High）
2. 既存/新規のレスポンス差分を縮小し列挙耐性を確保（Medium）
3. `rateLimit` の IP 信頼境界をプロキシ前提で明確化（Medium）
4. 管理者登録フローの endpoint 分離と監査項目拡張（Low）
5. 統合テストを「トークン非露出」前提へ更新（Low）