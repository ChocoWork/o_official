# login セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/14_login.md](../4_DetailDesign/14_login.md), [docs/4_DetailDesign/01_auth_seq.md](../4_DetailDesign/01_auth_seq.md)
- レビュー観点: OTP/Google OAuth、CSRF/state、レート制限、メール列挙、トークン保持、Cookie、監査、アカウントリンク安全性

---

## ステータス凡例

|ステータス|意味|
|---|---|
| Open | 未修正 |
| Partially Fixed | アプリケーション層では対処済み、DB/インフラ層は未対処 |
| Fixed | 修正済み |

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/api/auth/login/route.ts](../../src/app/api/auth/login/route.ts), [src/app/api/auth/refresh/route.ts](../../src/app/api/auth/refresh/route.ts), [src/app/api/auth/register/route.ts](../../src/app/api/auth/register/route.ts) | HttpOnly Cookie 運用を採用している一方で access_token をレスポンス JSON にも返却しており、ブラウザ拡張・XSS・ログ収集経路へ露出する余地が残る | access_token の JSON 返却を廃止し、認証状態は HttpOnly Cookie のみに統一する。フロントは /api/auth/me で状態同期する | Open | login/refresh/register の各 route で access_token を JSON に含めて返却している実装を確認 | High |
| [src/app/api/auth/oauth/callback/route.ts](../../src/app/api/auth/oauth/callback/route.ts) | OAuth state の消費が select 後 update の二段階で、同時リクエスト時に used_at 未設定の同一 state が並行通過する競合余地がある | state 消費を単一 SQL で原子的に実施する。例: used_at is null and expires_at >= now() 条件付き update returning で 1 回のみ成功させる | Open | 現状は maybeSingle で取得後に別 update を実施しており、競合時の one-time 保証がアプリ層依存 | High |
| [src/app/api/auth/oauth/callback/route.ts](../../src/app/api/auth/oauth/callback/route.ts), [docs/4_DetailDesign/14_login.md](../4_DetailDesign/14_login.md) | 既存メール衝突時の link-proposal/link-confirm フローが未実装で、設計上必須の再認証付きアカウントリンク制御が欠落している | 既存メール衝突時は即ログインや自動マージを行わず、link-proposal へ遷移して再認証後に link-confirm で連携する | Open | callback 内コメントで別途実装扱いとなっており、AUTH-02-AC-009 も未完了のまま | High |
| [src/app/api/auth/oauth/start/route.ts](../../src/app/api/auth/oauth/start/route.ts), [src/app/api/auth/oauth/callback/route.ts](../../src/app/api/auth/oauth/callback/route.ts) | oauth_requests に client_ip を保存しているが callback 側で照合しておらず、state 流出時の防御が state 文字列の秘匿みに依存している | callback で client_ip または追加バインディング情報を検証し、乖離時は拒否と監査ログ記録を行う | Open | start は client_ip 保存済み、callback では state/期限/used_at しか検証していない | Medium |
| [src/app/api/auth/login/route.ts](../../src/app/api/auth/login/route.ts), [src/app/api/auth/identify/route.ts](../../src/app/api/auth/identify/route.ts), [src/app/api/auth/otp/verify/route.ts](../../src/app/api/auth/otp/verify/route.ts), [src/app/api/auth/password-reset/request/route.ts](../../src/app/api/auth/password-reset/request/route.ts), [src/app/api/auth/oauth/start/route.ts](../../src/app/api/auth/oauth/start/route.ts), [src/app/api/auth/oauth/callback/route.ts](../../src/app/api/auth/oauth/callback/route.ts) | レート制限処理の失敗を catch で握りつぶして処理続行している箇所があり、DB/RPC 障害時に認証防御が fail-open になり得る | enforceRateLimit の失敗時は route 側で即 503 を返すか、共通ミドルウェア化して fail-closed を徹底する | Open | 多数 route で Rate limit middleware error をログした後に本処理を続行する分岐を確認 | Medium |
| [src/lib/audit.ts](../../src/lib/audit.ts) | 監査ログ書き込み失敗時に未マスクの event オブジェクトを console.warn 出力しており、障害時ログに機微情報が混入する余地がある | 失敗時ログも maskAuditEvent 済みオブジェクトのみを出力し、detail と metadata は強制マスクする | Open | catch で Failed to write audit log とともに event 原文を出力している実装を確認 | Medium |
| [src/lib/csrf.ts](../../src/lib/csrf.ts) | CSRF トークン生成でランダムバイト列をそのまま文字列化しており、制御文字を含む不安定な値になる可能性がある | base64url など Cookie/HTTP ヘッダ安全なエンコーディングへ変更する | Open | generateCsrfToken が byte を String.fromCharCode 連結する実装で、可搬性と検証安定性に課題 | Medium |
| [src/app/api/auth/otp/verify/route.ts](../../src/app/api/auth/otp/verify/route.ts) | OTP 検証は IP 軸レート制限のみで、メールアドレス単位の検証回数制御がない | subject=email での追加レート制限と、失敗回数に応じた段階的遅延を導入する | Open | auth:otp:verify は limit 30/10分 のみで subject 指定なし | Medium |
| [src/features/auth/ratelimit/index.ts](../../src/features/auth/ratelimit/index.ts), [migrations/005_create_rate_limit_counters.sql](../../migrations/005_create_rate_limit_counters.sql) | subject ベース制限で endpoint に acct:email を埋め込み保存しており、レート制限テーブルにメールアドレス平文が残る | subject は email 正規化ハッシュで保存し、可読 PII を残さない。監査用途は別テーブルで最小化する | Open | normalizeCounterTarget で endpoint へ acct:subject を連結している | Low |
| [src/app/api/auth/login/route.ts](../../src/app/api/auth/login/route.ts), [src/app/api/auth/refresh/route.ts](../../src/app/api/auth/refresh/route.ts) | トークンを含むレスポンスに no-store が付いておらず、共有キャッシュやデバッグプロキシでの残留リスクがある | トークン関連レスポンスは Cache-Control: no-store と Referrer-Policy: no-referrer を統一付与する | Open | oauth 系は no-store 済みだが login/refresh は未設定を確認 | Low |
| [src/app/api/auth/password-reset/request/route.ts](../../src/app/api/auth/password-reset/request/route.ts) | メール列挙対策として存在有無に関わらず 200 を返す実装を採用している | 現行方針を維持しつつ、固定応答時間化と cleanup ジョブ監視を追加するとより堅牢 | Fixed | user 不在でも同一応答で終了し、エラー文言で存在有無を返さない実装を確認 | Low |
| [src/app/api/auth/oauth/start/route.ts](../../src/app/api/auth/oauth/start/route.ts), [src/app/api/auth/oauth/callback/route.ts](../../src/app/api/auth/oauth/callback/route.ts), [migrations/011_create_oauth_requests.sql](../../migrations/011_create_oauth_requests.sql), [migrations/045_harden_auth_internal_tables_rls.sql](../../migrations/045_harden_auth_internal_tables_rls.sql) | state/PKCE 保持、期限管理、one-time 使用、RLS 強化の基盤は実装済み | callback 側の原子的消費とリンク安全性を追加すれば設計整合性がさらに高まる | Partially Fixed | oauth_requests テーブル、TTL、used_at、service_role 限定ポリシーを確認。競合対策とリンク要件は未完了 | Medium |

---

## 追加レビュー（2026-04-29）

### サマリー

- 対象: [src/app/login/page.tsx](../../src/app/login/page.tsx), [src/app/api/auth/login/route.ts](../../src/app/api/auth/login/route.ts), auth 関連（レート制限・CSRF・クライアント logout 動作）
- 追加指摘件数: 3件（High: 1 / Medium: 1 / Low: 1）
- 既存レビューとの関係: 既存項目は保持し、未記載だった論点のみ追記

### 表（追加指摘のみ）

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts), [src/app/api/auth/login/route.ts](../../src/app/api/auth/login/route.ts) | レート制限の送信元IP判定で `x-forwarded-for` / `x-real-ip` をそのまま信用しており、プロキシ信頼境界が未固定な環境ではヘッダ偽装でIPベース制限を回避できる | 信頼済みプロキシ経由のヘッダのみ採用し、未信頼直接到達時は接続元IPを強制利用する。併せて WAF/Ingress で該当ヘッダ上書きを統一する | Open | `getIpFromRequest` がヘッダ値を無条件採用。`auth:login` のIP制御はこの値に依存 | High |
| [src/app/api/auth/login/route.ts](../../src/app/api/auth/login/route.ts), [src/lib/cookie.ts](../../src/lib/cookie.ts) | 認証成功後の Cookie設定・sessions保存が失敗しても catch で握りつぶし 200 を返却するため、サーバ側セッション追跡なしで成功応答となる不整合が起きる | `sessions` 永続化と主要Cookie設定（refresh/csrf）失敗時は fail-closed で 500/503 を返し、発行済みCookieを明示クリアする | Open | `Failed to set cookies/persist session` ログ後も success レスポンスを返却する分岐を確認 | Medium |
| [src/contexts/LoginContext.tsx](../../src/contexts/LoginContext.tsx), [src/app/api/auth/logout/route.ts](../../src/app/api/auth/logout/route.ts) | クライアント logout は `/api/auth/logout` の失敗判定をせず常にローカル状態をログアウト済みに更新するため、サーバ側失敗時に「見かけ上ログアウト成功」の誤認を招く | `/api/auth/logout` の `resp.ok` を必須判定し、失敗時は再試行導線と警告表示を行う。成功時のみローカル認証状態を確定更新する | Open | `logout()` で API レスポンス判定なし。`finally` で常に `isLoggedIn=false` を適用 | Low |

### 重点結論

1. 追加レビューの最重要は、IPヘッダ信頼境界の未固定によるレート制限回避余地（A01/A07 防御劣化）
2. 次点は、login成功判定の fail-open 分岐でセッション管理整合性が崩れる点（A04/A09 相当の運用リスク）
3. login page 自体（[src/app/login/page.tsx](../../src/app/login/page.tsx)）には、今回スコープ内で新規の直接脆弱性は未確認

### 推奨順序

1. `rateLimit.ts` のIP解決を信頼済みプロキシ前提に固定し、インフラ設定（CDN/WAF/Ingress）と合わせて閉域化
2. `login/route.ts` のセッション永続化失敗時を fail-closed 化し、成功条件を「Cookie発行 + DB永続化完了」に統一
3. `LoginContext.logout()` の失敗ハンドリングを是正し、ユーザに実際のセッション失効結果を表示