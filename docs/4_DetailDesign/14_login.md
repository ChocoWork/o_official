# 1.14 ログインページ（LOGIN）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-LOGIN-001 | `/login` ページはメールアドレス OTP 認証を提供し Cloudflare Turnstile による CAPTCHA を組み込む | IMPL-LOGIN-001 | `src/app/login/page.tsx`, `src/components/LoginModal.tsx` | `LoginModal` 内に OTP フロー + Turnstile CAPTCHA を実装。`page.tsx` は `<LoginModal>` の呼び出しのみ | 済 |
| FR-LOGIN-002 | Google OAuth によるソーシャルログインボタンを設置する | IMPL-LOGIN-002 | `src/components/LoginModal.tsx`, `src/contexts/LoginContext.tsx`, `src/app/auth/callback/page.tsx` | `signInWithOAuth({ provider: 'google' })` ボタンを実装し、`queryParams.prompt = 'select_account'` を付与してアカウント選択を強制。コールバックは `/auth/callback/page.tsx` で処理 | 済 |
| FR-LOGIN-003 | 「パスワードを忘れた方はこちら」リンクを設置し `/auth/password-reset` に遷移させる | IMPL-LOGIN-003 | `src/components/LoginModal.tsx`, `src/app/auth/password-reset/page.tsx` | 「パスワードをお忘れの方」リンクを設置し `/auth/password-reset` へ遷移 | 済 |
| FR-LOGIN-004 | 新規ユーザー向けの専用サインアップページを設置する（WONT） | — | — | 現フェーズ対象外。OTP フローで既存・新規ユーザーを区別なく処理 | 未 |
| FR-LOGIN-005 | `generateMetadata` を実装しページタイトル・OGP を設定する | IMPL-LOGIN-004 | `src/app/login/page.tsx` | login ページを Server Component とし、`generateMetadata` で title / description / OGP を設定 | 済 |
| FR-LOGIN-006 | メール送信後に「○分 ○秒後に再送可能」のカウントダウンタイマーを表示し再送ボタンの多重押しを防ぐ | IMPL-LOGIN-005 | `src/components/LoginModal.tsx` | `otpSentTime` + `timeRemaining` の `useEffect` カウントダウンを実装。経過後リセットで再送ボタン有効化 | 済 |
| FR-LOGIN-007 | 二要素認証（2FA）の追加サポート（WONT） | — | — | 現フェーズ対象外 | 未 |

---

## TODO一覧 (AUTH-LOGIN-FOLLOWUPS)

**タスクID**: AUTH-LOGIN-FOLLOWUPS  
**元ファイル**: `docs/tasks/AUTH-LOGIN-followups.md`

| 要件ID | 種別 | 現状 | 修正/確認計画 |
|--------|------|------|--------------|
| FR-LOGIN-003 | 実装 | LoginModal にパスワード再設定導線を追加済み | `/auth/password-reset` へのリンク実装を維持し UI テストで確認する |
| FR-LOGIN-004 | WONT | 現フェーズ対象外 | 専用サインアップ画面は実装せず、将来タスクとして保留 |
| FR-LOGIN-005 | 実装 | Server Component 化と metadata 追加を反映済み | `src/app/login/page.tsx` の metadata 実装と Playwright で継続確認する |
| FR-LOGIN-007 | WONT | 現フェーズ対象外 | 2FA は別フェーズで実装 |
| AUTH-01-SUPA-05 | テスト | register / confirm の統合テスト実装有無を確認済み | 実装ステータスは `済` とし、追加差分が出た場合のみ更新する |
| AUTH-01-IDF-09 | テスト | `tests/unit/components/LoginModal.test.tsx` を追加済み | LoginModal の Google ボタン / パスワード再設定導線 / OTP 切替を回帰確認する |
| AUTH-01-IDF-10 | E2E | `e2e/FR-LOGIN-*.spec.ts` を追加済み | 要件単位の Playwright を継続運用し、WONT は skip で明示する |
| AUTH-01-IDF-14 | 手動設定 | Supabase Dashboard 未確認 | Dashboard の OTP コード送信モードを手動確認 |
| AUTH-SEC-001 | 実装確認 | HSTS 実装を確認済み | middleware の `Strict-Transport-Security` 設定を維持する |
| AUTH-SEC-007 | ドキュメント確認 | secrets 運用手順の既存ドキュメントを確認済み | `docs/ops/secrets.md` を参照元として維持する |
| AUTH-SEC-008 | テスト確認 | JTI 再利用検出テストの既存有無を確認済み | 認証基盤変更時は再実行して整合性を確認する |
| AUTH-SEC-009 | 実装確認 | CSP ヘッダの既存実装を確認済み | nonce ベース CSP の維持を前提とする |
| AUTH-SEC-010 | インフラ | WAF/CDN 未確認 | Vercel / Cloudflare 設定を手動確認 |
| AUTH-SEC-012 | 設計 | ハッシュチェーン未実装 | 監査証跡保全は別設計タスクで対応 |
| AUTH-02-AC-009 | 実装 | 既存メール衝突時の導線なし | link-proposal / link-confirm フローを別タスクで実装 |
| AUTH-02-CFG-001〜003 | 手動設定 | Google / Supabase OAuth 設定未確認 | 各ダッシュボード設定を手動確認 |

---

## 統合メモ (AUTH-LOGIN-FOLLOWUPS)

- コード修正対象は login ページ metadata と LoginModal 導線を優先する。
- 試験ファイルは FR-LOGIN 要件ごとに Playwright で追加し、WONT / 外部設定依存は skip で明示する。
- 外部サービス設定が必要な項目は TODO を残し、コード側から確認できる範囲のみ反映する。

---

## 認証基盤 実装タスク管理 (AUTH-01)

**タスクID**: AUTH-01  
**ステータス**: in-progress  
**元ファイル**: `docs/tasks/01_auth_ticket.md`

### Supabase Auth 必須対応

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| AUTH-01-SUPA-01 | 登録フローで `emailRedirectTo` を `/api/auth/confirm` に固定し `redirect_to` ホワイトリスト検証を追加 | IMPL-AUTH-REG-01 | `src/app/api/auth/register/route.ts` | emailRedirectTo 固定・ホワイトリスト検証追加済み | 済 |
| AUTH-01-SUPA-02 | `/api/auth/confirm` 実装（トークン検証・ワンタイム消費・セッション発行・監査ログ・クリーン URL リダイレクト） | IMPL-AUTH-CONF-01 | `src/app/api/auth/confirm/route.ts` | verifyOtp でトークン検証、セッション Cookie 発行、303 クリーン URL リダイレクト実装済み | 済 |
| AUTH-01-SUPA-03 | `/api/auth/confirm` 失敗時エラーハンドリング（期限切れ/不正/再利用）と監査ログ | IMPL-AUTH-CONF-02 | `src/app/api/auth/confirm/route.ts` | 期限切れ/不正/再利用の各エラーケースと監査ログ実装済み | 済 |
| AUTH-01-SUPA-04 | 認証 Cookie 整合性確認（refresh/csrf/access の設定統一・削除・ローテーション） | IMPL-AUTH-COOKIE-01 | `src/lib/cookie.ts`, `src/app/api/auth/` 各 route | HttpOnly/Secure/SameSite=Lax Cookie 統一設定済み | 済 |
| AUTH-01-SUPA-05 | 登録/確認フローの統合テスト追加 | IMPL-AUTH-TEST-01 | `tests/integration/api/auth/register.test.ts`, `tests/integration/api/auth/confirm.test.ts` | register / confirm の統合テストを実装済み | 済 |

### Passwordless / OTP フロー

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| AUTH-01-IDF-01〜08 | 仕様整理・UI 方針・API 設計/実装・LoginModal 変更・LoginContext 更新・Turnstile 連携・監査ログ | IMPL-AUTH-OTP-01 | `src/components/LoginModal.tsx`, `src/app/components/LoginContext.tsx`, `src/lib/turnstile.ts` | OTP フロー全体実装済み | 済 |
| AUTH-01-IDF-09 | identify API 統合テスト + LoginModal UI テスト | IMPL-AUTH-OTP-09 | `tests/unit/components/LoginModal.test.tsx` | LoginModal の Google ボタン表示、パスワード再設定導線、OTP 切替 UI テストを追加済み | 済 |
| AUTH-01-IDF-10 | E2E テスト追加（OTP メールリンク遷移 + Google 導線） | IMPL-AUTH-OTP-10 | `e2e/FR-LOGIN-001-otp-turnstile.spec.ts`, `e2e/FR-LOGIN-002-google-oauth.spec.ts`, `e2e/FR-LOGIN-003-password-reset-link.spec.ts`, `e2e/FR-LOGIN-005-metadata.spec.ts`, `e2e/FR-LOGIN-006-otp-resend-countdown.spec.ts` | ログイン要件単位の Playwright 試験を追加済み。WONT 要件は skip で管理 | 済 |
| AUTH-01-IDF-11〜13 | UI 順序変更（Google 上部）・OTP 方式切替・パスワード再設定導線見直し | IMPL-AUTH-OTP-02 | `src/components/LoginModal.tsx` | UI 更新済み | 済 |
| AUTH-01-IDF-14 | Supabase Dashboard: OTP コード送信モードへの切替確認 | IMPL-AUTH-OTP-14 | Supabase Dashboard 設定 | 設定確認要 | 未 |
| AUTH-01-IDF-15a〜c | 未登録メール JIT 作成 + OTP 統一、テスト追加 | IMPL-AUTH-OTP-03 | `src/app/api/auth/identify/route.ts` | JIT ユーザー作成 + OTP 統一フロー実装済み | 済 |

### Account 画面ログイン判定

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| AUTH-01-UI-ACCOUNT-01 | `account/page.tsx` サーバー側ログイン判定・`LoginContext`（`isAuthResolved`）・タブ切替・注文時入力への切替 | IMPL-AUTH-ACCOUNT-01 | `src/app/account/page.tsx`, `src/app/components/LoginContext.tsx` | サーバー側ログイン判定 + isAuthResolved フラグ + タブ切替実装済み | 済 |
| FR-ACCOUNT-007 | account ページからログアウトできる導線を提供し、ログアウト後は未ログイン状態を明示する | IMPL-AUTH-ACCOUNT-02 | `src/app/account/page.tsx`, `src/contexts/LoginContext.tsx`, `src/app/api/auth/logout/route.ts` | account サイドバーにログアウトボタンを追加し、`/api/auth/logout` 呼び出し後にクライアント認証状態を未ログインへ更新 | 済 |

### セキュリティ対策

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| AUTH-SEC-001 | TLS/HSTS 強制（必須） | IMPL-AUTH-SEC-001 | `src/proxy.ts` | `Strict-Transport-Security` ヘッダを proxy で付与済み | 済 |
| AUTH-SEC-002 | セキュア Cookie（HttpOnly/Secure/SameSite）（必須） | IMPL-AUTH-COOKIE-01 | `src/lib/cookie.ts` | HttpOnly/Secure/SameSite=Lax 設定済み | 済 |
| AUTH-SEC-003 | CSRF ダブルサブミット（必須） | IMPL-AUTH-CSRF-01 | `src/lib/csrf.ts`, `src/lib/csrfMiddleware.ts` | ダブルサブミットパターン実装済み | 済 |
| AUTH-SEC-004 | 入力バリデーション（Zod）（必須） | IMPL-AUTH-VAL-01 | `src/features/auth/schemas/` | Zod スキーマで全入力検証済み | 済 |
| AUTH-SEC-005 | 連続試行制限（IP/アカウント軸）（必須） | IMPL-AUTH-RATE-01 | `src/features/auth/middleware/rateLimit.ts` | Postgres カウンタベースのレート制限実装済み | 済 |
| AUTH-SEC-006 | 監査ログ（認証イベント）（必須） | IMPL-AUTH-AUDIT-01 | `src/lib/audit.ts` | audit_logs テーブルへの記録 + cleanup 実装済み | 済 |
| AUTH-SEC-007 | シークレット管理/ローテーション手順（必須） | IMPL-AUTH-SEC-007 | `docs/ops/secrets.md` | シークレット手動運用・ローテーション手順をドキュメント化済み | 済 |
| AUTH-SEC-008 | セッション管理 JTI 再利用検出テスト（必須） | IMPL-AUTH-JTI-01 | `src/features/auth/services/session.ts`, `tests/unit/features/auth/services/session.test.ts` | JTI 再利用検出の単体テストを実装済み | 済 |
| AUTH-SEC-009 | CSP ヘッダ（nonce ベース）（推奨） | IMPL-AUTH-SEC-009 | `src/proxy.ts` | nonce 付き CSP ヘッダを proxy で付与済み | 済 |
| AUTH-SEC-010 | WAF/CDN（推奨） | — | インフラ（Vercel/Cloudflare） | 未実装 | 未 |
| AUTH-SEC-011 | Bot 対策（Turnstile 常時表示）（推奨） | IMPL-AUTH-TURNSTILE-01 | `src/lib/turnstile.ts` | Cloudflare Turnstile 実装済み | 済 |
| AUTH-SEC-012 | 監査証跡保全（ハッシュチェーン）（推奨） | — | — | 未実装 | 未 |

### 実装フェーズ 完了状況

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| AUTH-01-01 | DB マイグレーション（users/profiles/sessions/rate_limit_counters） | IMPL-AUTH-DB-01 | `migrations/001` 〜 `005` 各 .sql | スキーマ作成済み。テスト一部未 | 済 |
| AUTH-01-02 | Zod スキーマ定義（register/login/refresh/password-reset） | IMPL-AUTH-ZOD-01 | `src/features/auth/schemas/` | 全スキーマ定義済み | 済 |
| AUTH-01-05 | Register エンドポイント + テスト（2/2 成功） | IMPL-AUTH-REG-01 | `src/app/api/auth/register/route.ts` | 登録 API 実装済み（2/2 テスト成功） | 済 |
| AUTH-01-06 | Login エンドポイント + テスト（9/9 成功） | IMPL-AUTH-LOGIN-01 | `src/app/api/auth/login/route.ts` | ログイン API 実装済み（9/9 テスト成功） | 済 |
| AUTH-01-07 | Refresh エンドポイント + JTI ローテーション + テスト | IMPL-AUTH-REFRESH-01 | `src/app/api/auth/refresh/route.ts`, `src/features/auth/services/session.ts` | JTI ローテーション実装済み | 済 |
| AUTH-01-08 | Logout エンドポイント + CSRF 検証 + テスト（3/3 成功） | IMPL-AUTH-LOGOUT-01 | `src/app/api/auth/logout/route.ts` | ログアウト + CSRF 検証実装済み（3/3 テスト成功） | 済 |
| AUTH-01-09 | Password Reset フロー + テスト（6/12 成功、モック調整要） | IMPL-AUTH-PWR-01 | `src/app/api/auth/password-reset/` | パスワードリセットフロー実装済み（テスト 6/12 成功） | 一部未 |
| AUTH-01-10 | Admin Revoke User Sessions + テスト（3/3 成功） | IMPL-AUTH-ADMIN-01 | `src/app/api/admin/users/[id]/sessions/route.ts` | セッション強制失効実装済み（3/3 テスト成功） | 済 |
| AUTH-01-11 | CSRF 対策（`src/lib/csrf.ts`, `csrfMiddleware.ts`） + テスト | IMPL-AUTH-CSRF-01 | `src/lib/csrf.ts`, `src/lib/csrfMiddleware.ts` | CSRF 対策実装済み | 済 |
| AUTH-01-12 | 監査ログ（`src/lib/audit.ts`, cleanup, CI workflow） + テスト（2/2 成功） | IMPL-AUTH-AUDIT-01 | `src/lib/audit.ts`, `.github/workflows/cleanup-audit-logs.yml` | 監査ログ + cleanup 実装済み（2/2 テスト成功） | 済 |

### Confirm 後の UX

- `/api/auth/confirm` はクリーンURL へ 303 リダイレクト（トークンを URL に残さない）
- デフォルトリダイレクト先: `/account`
- `/auth/verified` → 確認完了メッセージ表示 → `/account` 自動遷移

---

## Google OAuth 実装 (AUTH-02)

**タスクID**: AUTH-02  
**ステータス**: done  
**元ファイル**: `docs/tasks/AUTH-02_oauth_ticket.md`

### 実装ファイル

- `src/contexts/LoginContext.tsx` — `signInWithOAuth` 呼び出しに変更
- `src/app/auth/callback/page.tsx` — コールバック処理（既存実装済み）
- `migrations/011_create_oauth_requests.sql` — oauth_requests テーブル

### 受け入れ条件

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| AUTH-02-AC-001 | 「Googleでログイン」ボタンで OAuth フロー開始 | IMPL-OAUTH-001 | `src/contexts/LoginContext.tsx` | `signInWithOAuth({ provider: 'google' })` 実装済み | 済 |
| AUTH-02-AC-002 | callback で Cookie 発行 + 303 リダイレクト | IMPL-OAUTH-002 | `src/app/auth/callback/page.tsx` | コールバック処理で Cookie 発行 + リダイレクト実装済み | 済 |
| AUTH-02-AC-003 | callback URL から code 等が残らない | IMPL-OAUTH-003 | `src/app/auth/callback/page.tsx` | クリーン URL リダイレクト実装済み | 済 |
| AUTH-02-AC-004 | callback 異常系の統合テスト | IMPL-OAUTH-004 | `tests/auth/` | 統合テスト実装済み | 済 |
| AUTH-02-AC-005 | callback 正常系の統合テスト | IMPL-OAUTH-005 | `tests/auth/` | 統合テスト実装済み | 済 |
| AUTH-02-AC-006 | callback 入力不正で 400 | IMPL-OAUTH-006 | `src/app/auth/callback/page.tsx` | 不正入力時 400 実装済み | 済 |
| AUTH-02-AC-007 | session persist 失敗時も 303 | IMPL-OAUTH-007 | `src/app/auth/callback/page.tsx` | セッション保存失敗時も 303 リダイレクト実装済み | 済 |
| AUTH-02-AC-008 | Google OAuth 新規登録・既存ログイン | IMPL-OAUTH-008 | `src/app/auth/callback/page.tsx` | 新規/既存ユーザー両対応実装済み | 済 |
| AUTH-02-AC-009 | 既存メール衝突時エラー（暫定） | — | — | 次フェーズで link-proposal を実装予定 | 未 |
| AUTH-02-AC-010 | Google サインイン時に利用アカウントを選択できる | IMPL-OAUTH-009 | `src/contexts/LoginContext.tsx` | `signInWithOAuth` の `queryParams.prompt` に `select_account` を設定し、Google アカウント選択画面を表示 | 済 |

---

## Google アカウント選択対応 (AUTH-02-GOOGLE-ACCOUNT-CHOOSER)

### 背景

- Google でサインイン押下時、Google 側の既存セッションによりアカウント選択画面を経ずにログインすることがある。
- ログイン先アカウントを利用者が選べる挙動が必要。

### 対象ファイル

- `src/contexts/LoginContext.tsx`
- `src/components/LoginModal.tsx`
- `e2e/FR-LOGIN-002-google-oauth.spec.ts`
- `tests/unit/components/LoginContext.test.tsx`

### 反映内容

- FR-LOGIN-002 の Playwright 試験をアカウント選択要件まで拡張済み。
- `signInWithOAuth` に Google アカウント選択を強制するクエリを付与済み。
- 単体テストで OAuth オプションを固定化済み。
- 詳細設計と仕様レビューを更新済み。
- Chromium Playwright と Jest で再検証済み。

---

## 認証 アーキテクチャ詳細設計 (ARCH-AUTH)

> 元ファイル: `docs/4_DetailDesign/auth-detailed.md`

### 対応 ARCH-ID
- ARCH-AUTH-01: Register / Confirm
- ARCH-AUTH-02: Login
- ARCH-AUTH-03: Refresh / JTI
- ARCH-AUTH-04: Password Reset
- ARCH-AUTH-05: Logout / Revoke Sessions
- ARCH-AUTH-06: OAuth
- ARCH-AUTH-07: CSRF / Cookie
- ARCH-AUTH-08: Audit Log
- ARCH-AUTH-09: Rate Limit
- ARCH-AUTH-10: Secrets Management (現行は手動運用、`docs/ops/secrets.md` を参照)

### OAuth: 既存アカウント衝突時のポリシー

#### 概要
OAuth ログインでプロバイダから返るメールアドレスが既存アカウントのメールと一致した場合、衝突（同一メールに対する既存アカウントの可能性）が発生します。

#### 推奨ポリシー
1. **検証されたメール (`email_verified=true`) の場合**
   - ユーザーに「アカウント連携（Link accounts）」を促す画面を表示し、ユーザーの明示的承認を得た上で OAuth アカウントを既存アカウントにリンクする。再ログイン（メール確認リンク or パスワード確認）を要求して本人確認を強化する。
2. **検証されていないメール or メール欠如の場合**
   - ユーザーに既存アカウントへのリンクを手動で要求し、メール確認フローを通じて照合する。自動マージは行わない。

#### 自動マージについての注意点
- 自動マージは利便性が高い一方で、アカウント乗っ取りのリスクを増加させます。初期実装では自動マージを採用しないことを推奨します。

#### 実装上の要件
- OAuth callback で provider の `email` と `email_verified` を取得すること
- 既存メール一致時は「リンク提案ページ」へリダイレクトし、ユーザーの承認を得る
- リンク後の audit event を残す（`auth.oauth.link`）
- E2E: OAuth での既存アカウントリンクケースと不一致ケースをカバーする

### OAuth 詳細設計

#### DB マイグレーション
- `migrations/011_create_oauth_requests.sql` — oauth_requests テーブル
  ```sql
  CREATE TABLE oauth_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    state text NOT NULL UNIQUE,
    code_challenge text NOT NULL,
    code_challenge_method text NOT NULL,
    redirect_to text,
    client_ip inet NULL,
    created_at timestamptz DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz NULL
  );
  ```

#### ユーザー／プロフィール方針（設計決定）
- `auth.users` を認証のソース・オブ・トゥルースとし、アプリ側のプロフィール情報は `public.profiles` に格納する。
- `profiles.user_id` は `auth.users(id)` を参照する主キーとし、表示名・電話・住所などの可変情報を保持する。

#### state / PKCE 保存方針
- 保存: Redis（推奨）または Postgres（`oauth_requests`）
- TTL: 10 分（5〜15 分の許容）
- 再利用検出: `used_at` がセット済みまたは `expires_at` を過ぎていたら拒否（監査ログ記録）
- cleanup: 定期ジョブで expired/used を削除

#### Exchange & エラーハンドリング
- callback で code をサーバ側で交換（code_verifier 使用）
- 交換失敗: `502 Bad Gateway`（Provider 側問題）& audit log `auth.oauth.callback.exchange_failure`
- PKCE 検証失敗: `401 Unauthorized` & audit `auth.oauth.callback.pkce_failure`
- state 無効: `400 Bad Request` & audit `auth.oauth.callback.invalid_state`

#### テスト計画
- 単体: state/PKCE の生成・検証・期限切れ・再利用検出ユニットテスト
- 結合: Provider モックで code 交換の正常系/異常系テスト
- セキュリティ: id_token JWKS 署名検証、リプレイ攻撃検出テスト

---

## 実装レビュー・修正計画

> 元ファイル: `docs/4_DetailDesign/auth-implementation-review.md`

### 実装状況サマリ

#### 完了している実装
1. **Supabase Auth 統合の基本実装** — Service role client、確認フロー（`verifyOtp`）
2. **セッション管理** — `sessions` テーブル管理、JTI ローテーション + 再利用検出、refresh_token_hash 保存
3. **セキュリティ実装** — Cookie 設定（HttpOnly/Secure/SameSite）、レート制限、監査ログ、CSRF トークン管理、Turnstile 検証
4. **OAuth 基本実装** — state/PKCE 生成・検証、`oauth_requests` テーブル管理、コールバック処理
5. **メール送信（部分）** — Amazon SES アダプタ実装済み（`src/lib/mail/adapters/ses.ts`）

### 修正項目一覧

#### 1. 新規登録メールの SES 統合（優先度: 🔴 高）

**現状**: `/api/auth/register` では Supabase の確認メール機能を使用。ブランディングカスタマイズが困難。

**修正方針**:
- Supabase Dashboard → Authentication → Email Templates → "Confirm signup" を無効化
- アプリ側で `email_confirmation_tokens` テーブルを作成し、テーブルに保存したトークンを SES 経由で送信
- `/api/auth/confirm` を `verifyOtp` から `email_confirmation_tokens` テーブル検証に変更

**新規マイグレーション**: `migrations/012_create_email_confirmation_tokens.sql`
```sql
CREATE TABLE IF NOT EXISTS email_confirmation_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used boolean DEFAULT false,
  used_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_email_confirmation_tokens_hash ON email_confirmation_tokens(token_hash);
CREATE INDEX idx_email_confirmation_tokens_expires ON email_confirmation_tokens(expires_at);
```

**影響範囲**: 高 / **工数**: 4–6 時間

#### 2. RLS ポリシーの適用（優先度: 🔴 高）

**新規マイグレーション**: `migrations/013_enable_rls_policies.sql`

主要ポリシー:
- `profiles`: ユーザーは自分のプロフィールのみ閲覧・更新可能
- `sessions`: service role のみアクセス / ユーザー自身のセッション一覧は閲覧可
- `audit_logs`, `rate_limit_counters`, `oauth_requests`, `password_reset_tokens`, `email_confirmation_tokens`: service role のみ
- `oauth_accounts`: ユーザーは自身の閲覧可、管理は service role

**影響範囲**: 高 / **工数**: 1–2 時間

#### 3. OAuth リンク提案 UI の実装（優先度: 🟡 中）

**新規ファイル**:
- `src/app/auth/oauth/link-proposal/page.tsx` — パスワード再認証付きリンク提案画面
- `src/app/api/auth/oauth/link-confirm/route.ts` — リンク確認 API（Zod バリデーション付き）

**影響範囲**: 中 / **工数**: 2–3 時間

#### 4. クリーンアップジョブの実装（優先度: 🟡 中）

---

## Supabase Auth 統合設計（SUPA-DESIGN）

> 元ファイル: `docs/2_Specs/01_auth.md` § 3.5

### 設計方針

当プロジェクトは **Supabase Auth を ID 管理層（認証ストア）** として使用し、**アプリ側でセッション・セキュリティポリシーを実装** する設計を採用しています。

### 役割分担

| 役割 | Supabase Auth が担当 | アプリ側が担当 |
|------|---------------------|--------------|
| ユーザー管理 | `auth.users` テーブルの管理（作成・削除・検証）| `profiles` テーブルで追加情報を管理 |
| 認証情報検証 | メール/パスワード・OAuth 検証 | カスタムレート制限・監査ログ記録 |
| トークン発行 | JWT (access_token / refresh_token) の発行と署名検証 | `sessions` テーブルで refresh_token_hash 管理 |
| セッション管理 | — | HttpOnly Cookie + JTI ローテーション |
| メール確認 | OTP/メールリンクの発行と検証 (`verifyOtp`) | `emailRedirectTo` で `/api/auth/confirm` に固定 |
| CSRF 対策 | — | ダブルサブミット方式 (`src/lib/csrf.ts`) |
| OAuth | Google 等の OAuth プロバイダ連携 | link-proposal フロー（自動マージ禁止） |

### 認証フロー図

#### 新規登録フロー

```
クライアント          Supabase Auth          アプリ API             DB
     |                     |                     |                    |
     | POST /api/auth/register                    |                    |
     |-------------------------------------------->                    |
     |                     | signUp()             |                    |
     |                     |--------------------->|                    |
     |                     |    確認メール送信      |                    |
     |                     | (redirect_to=/api/auth/confirm)            |
     |                     |<---------------------|                    |
     | 201 Created         |                     |                    |
     |<--------------------------------------------|                    |
     |                                                                  |
     | (ユーザがメールリンクをクリック)                                       |
     | GET /auth/v1/verify?token=...&redirect_to=/api/auth/confirm       |
     |-------------------------------------------->                    |
     |                     | トークン検証          |                    |
     |                     | 302 /api/auth/confirm?token_hash=...        |
     |                     |--------------------------------------------->
     |                     |                     | verifyOtp            |
     |                     |                     | → セッション作成      |
     |                     |                     |-------------------->|
     |                     |                     | HttpOnly Cookie 発行 |
     | 302 /account (Set-Cookie)                                        |
     |<-----------------------------------------------------------------|
```

#### ログインフロー

```
クライアント          Supabase Auth          アプリ API             DB
     |                     |                     |                    |
     | POST /api/auth/login {email, password}     |                    |
     |-------------------------------------------->                    |
     |                     | レート制限チェック    |                    |
     |                     | signInWithPassword() |                    |
     |                     |--------------------->|                    |
     |                     | access_token + refresh_token               |
     |                     |<---------------------|                    |
     |                     |                     | refresh_token_hash 保存 |
     |                     |                     | current_jti 生成   |
     |                     |                     |-------------------->|
     |                     |                     | HttpOnly Cookie 発行|
     | 200 OK (Set-Cookie) |                     |                    |
     |<--------------------------------------------|                    |
```

#### リフレッシュフロー（JTI ローテーション）

```
クライアント          アプリ API             DB                 Supabase Auth
     |                     |                    |                    |
     | POST /api/auth/refresh (Cookie)           |                    |
     |--------------------->|                    |                    |
     |                     | sessions.current_jti 照合              |
     |                     |------------------->|                    |
     |                     | JTI 不一致?                             |
     |                     |   → 再利用検出！                        |
     |                     |   → quarantine / 全失効                 |
     |                     |<-------------------|                    |
     |                     | JTI 一致            |                    |
     |                     | /auth/v1/token (refresh grant)          |
     |                     |---------------------------------------------->
     |                     | 新 access_token + refresh_token         |
     |                     |<----------------------------------------------
     |                     | 新 JTI 生成・更新   |                    |
     |                     |------------------->|                    |
     | 200 OK (新 Cookie)  |                    |                    |
     |<---------------------|                    |                    |
```

### Supabase API 利用箇所

| API / 機能 | 使用箇所 | 目的 |
|-----------|---------|-----|
| `auth.admin.createUser()` | `/api/auth/register` (管理者用) | ユーザー作成（確認済み状態） |
| `auth.signUp()` | `/api/auth/register` (公開用) | ユーザー作成 + 確認メール送信 |
| `auth.verifyOtp()` | `/api/auth/confirm` | メール確認トークンの検証 |
| `auth.signInWithPassword()` | `/api/auth/login` | メール/パスワード認証 |
| `/auth/v1/token` (refresh grant) | `/api/auth/refresh` | refresh_token から新トークン取得 |
| OAuth プロバイダ設定 | `/api/auth/oauth/*` | Google OAuth 連携 |

### セキュリティ境界

| キー種別 | 使用箇所 | 保管方法 |
|---------|---------|---------|
| `SUPABASE_SERVICE_ROLE_KEY` | `/api/auth/confirm`, `/api/auth/register`, `/api/auth/refresh`, `sessions` CRUD | Secrets Manager のみ・VCS 不可 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | フロントエンド (RSC/クライアント) | RLS で保護されているため公開可 |

### トークン寿命

| トークン種別 | 寿命 | 備考 |
|-----------|-----|-----|
| Access token | 15 分 | メモリ/短期 Cookie 管理 |
| Refresh token | 7 日（スライディング、最大 30 日） | HttpOnly; Secure; SameSite=Lax; Path=/ |
| Password reset token | 1 時間 | ワンタイム・即時消費 |
| Email confirmation token | 24 時間 | ワンタイム・即時消費 |

### セッション同時数制限

- 方針: **有効（デフォルト）**。ユーザー単位上限 **5 セッション**。
- 超過時: 最古セッションを自動削除（ローテーション方式、UX 配慮）。
- 管理画面からセッション列挙・個別リボーク・全失効が操作可能。

**新規ファイル**:
- `src/workers/cleanup-expired-tokens.ts` — password_reset_tokens / email_confirmation_tokens / oauth_requests の期限切れレコード削除
- `src/workers/cleanup-revoked-sessions.ts` — 失効済みセッションの削除（30 日保持後）
- `src/app/api/cron/cleanup-tokens/route.ts` — Vercel Cron エンドポイント（`CRON_SECRET` 検証）
- `src/app/api/cron/cleanup-sessions/route.ts` — Vercel Cron エンドポイント
- `vercel.json` — Cron スケジュール設定（毎日 02:00 / 03:00 UTC）

**環境変数追加**: `CRON_SECRET`  
**影響範囲**: 低 / **工数**: 2 時間

#### 5. Service Role Key チェック強化（優先度: 🔴 高）

`src/lib/supabase/server.ts` の `createServiceRoleClient` に以下を追加:
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 未設定時の詳細エラーログ
- JWT 形式チェック（`eyJ` で始まるか確認）
- 最小長チェック（100 文字以上）

**影響範囲**: 低 / **工数**: 0.5 時間

### 実装優先度と工数サマリ

| 優先度 | 項目 | 工数 | 影響範囲 |
|-------|-----|------|---------|
| 🔴 高 | RLS ポリシー適用 | 1–2h | 高 |
| 🔴 高 | Service role key チェック強化 | 0.5h | 低 |
| 🔴 高 | 新規登録メール SES 統合 | 4–6h | 高 |
| 🟡 中 | OAuth リンク提案 UI | 2–3h | 中 |
| 🟡 中 | クリーンアップジョブ | 2h | 低 |
| 🟢 低 | E2E テスト拡充 | 4–6h | 中 |

**合計工数**: 14–20 時間

### 実装フェーズ

1. フェーズ 1（セキュリティ必須）: Service role key チェック強化 → RLS ポリシー適用
2. フェーズ 2（メール統合）: 新規登録メール SES 統合
3. フェーズ 3（OAuth 完成）: OAuth リンク提案 UI
4. フェーズ 4（運用改善）: クリーンアップジョブ
5. フェーズ 5（テスト拡充）: E2E テスト追加

### 注意事項

- **新規登録メール SES 統合**: 既存ユーザーへの影響なし（新規登録のみ変更）
- **RLS ポリシー適用**: service role を使わずにテーブルへ直接アクセスしている既存コードは要確認
- デプロイ前に `SUPABASE_SERVICE_ROLE_KEY`、`CRON_SECRET` などの環境変数を確認すること

### 残タスク

- 既存メール衝突時のリンク提案/再認証フロー（link-proposal/link-confirm）
- `oauth_accounts` 管理（provider_user_id ユニーク制約）
- unlink/re-link 管理 API
- cleanup ジョブ（期限切れ oauth_requests 削除）

---

## Google OAuth フロー修正メモ (AUTH-02-FIX)

**タスクID**: AUTH-02-FIX  
**ステータス**: done（修正適用済み）  
**元ファイル**: `docs/tasks/AUTH-02-FIX_oauth_flow_mismatch.md`

### 問題と修正

- **問題**: 自前の state/PKCE を `/auth/v1/authorize` に渡す実装 → Supabase Auth が独自 state 管理するため state 不一致エラー（`bad_oauth_state`）
- **修正**: `LoginContext.tsx` を `signInWithOAuth({ provider: 'google' })` に変更（Supabase 公式パターン）
- **追加修正**: `signInWithOAuth` の `queryParams.prompt` に `select_account` を設定し、Google 側でアカウント選択画面を必ず表示する。

### Google OAuth 設定チェックリスト

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| AUTH-02-CFG-001 | Google Cloud Console: Authorized redirect URI に Supabase callback URL を登録 | — | Google Cloud Console 設定 | `https://pjidrgofvaglnuuznnyj.supabase.co/auth/v1/callback` を登録 | 要確認 |
| AUTH-02-CFG-002 | Supabase Dashboard > Providers: Google Enabled = ON、Client ID/Secret 設定 | — | Supabase Dashboard 設定 | Google プロバイダー有効化 + 認証情報設定 | 要確認 |
| AUTH-02-CFG-003 | Supabase Dashboard > URL Configuration: Site URL + Redirect URLs 設定 | — | Supabase Dashboard 設定 | `http://localhost:3000/auth/callback` と本番 URL を Redirect URLs に追加 | 要確認 |

### トラブルシューティング

| エラー | 対処 |
|--------|------|
| `redirect_uri_mismatch`（Google 側） | Google Console の Authorized redirect URIs に Supabase callback URL を追加 |
| `bad_oauth_state`（Supabase 側） | 修正済み（`signInWithOAuth` 使用） |
| `Invalid Redirect URL`（Supabase 側） | Redirect URLs に `/auth/callback` を追加 |
