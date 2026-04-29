# privacy セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/17_privacy.md](../4_DetailDesign/17_privacy.md)
- レビュー対象: `src/app/privacy/page.tsx`, `src/app/layout.tsx`, `src/contexts/Providers.tsx`, `src/components/Header.tsx`, `src/proxy.ts`, 関連 e2e
- 実施日: 2026-04-29
- レビュー基準: Secure Coding / OWASP Top 10（A01, A05 を重点。静的ページの情報露出・不要 API・CSP・クリックジャッキング・外部リンク/画像・キャッシュを重点確認）

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| Open | 未修正 |
| Partially Fixed | 一部レイヤのみ対処済み |
| Fixed | 修正済み |
| N/A | 現時点で問題なし |

---

## サマリー

- **High: 1件（Open）**
- **Medium: 3件（Open）**
- **Low: 2件（Open）**
- **Fixed/N/A: 4件**

`/privacy` 自体は静的本文ページとして大きな実装逸脱はありません。一方で、**共通層（proxy / Providers / LoginProvider）の横断適用**により、静的公開ページに不要な識別子付与・認証 API 通信・過剰な CSP 許可先が残っています。ページ単体ではなく共通セキュリティ境界の最小権限化が必要です。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/proxy.ts](../../src/proxy.ts) | 全ルート共通 CSP が `https://js.stripe.com` `https://challenges.cloudflare.com` `https://cdn.jsdelivr.net` 等を常時許可しており、`/privacy` のような静的ページで不要な外部接続先を抱えている（最小権限違反） | ルート特性ごとに CSP を分離し、`/privacy` は `script-src 'self'` を基本に外部ドメインを除外。決済/認証ページのみ Stripe/Turnstile を許可 | Open | `matcher: ['/:path*']` で全画面に同一 CSP を付与。静的情報ページにも決済・認証用ドメインが露出 | High |
| [src/proxy.ts](../../src/proxy.ts) | 全 GET アクセスで `session_id` Cookie を新規発行し、`/privacy` 閲覧時にも不要な永続識別子を付与している | `session_id` の発行対象を cart/wishlist/checkout 等の状態管理ルートへ限定。公開静的ページでは Cookie 非発行にする | Open | Cookie 未保持時に常時 `response.cookies.set(...)` を実行。静的ページにも識別子が付与される | Medium |
| [src/contexts/LoginContext.tsx](../../src/contexts/LoginContext.tsx) | `LoginProvider` が mount 時に `/api/auth/me` を必ず実行し、`/privacy` でも不要な認証 API 呼び出しが発生する | 情報ページ向けに auth state 同期を遅延化（ログイン UI 操作時のみ）または lightweight provider を分離 | Open | `React.useEffect(() => { void syncAuthState(); }, ...)` により全ページ初回表示で認証状態同期が走る | Medium |
| [src/app/privacy/page.tsx](../../src/app/privacy/page.tsx) | キャッシュ方針がページ仕様として明文化されておらず、将来の運用変更時に `no-store`/`public` が揺れる余地がある | `revalidate` もしくは `dynamic` 方針を仕様化し、法務文書の鮮度要件に合わせて HTTP キャッシュ方針を固定 | Open | 現時点では共通 Cookie 発行の影響で共有キャッシュ効率が低い。仕様上の期待値が未定義 | Medium |
| [e2e/FR-PRIVACY-001-policy-content.spec.ts](../../e2e/FR-PRIVACY-001-policy-content.spec.ts) | `/privacy` 固有のセキュリティヘッダ検証がなく、CSP/XFO/HSTS の回帰を terms テストに依存している | `FR-PRIVACY-003-security-headers.spec.ts` を追加し、`/privacy` 直接応答でヘッダを検証 | Open | 現在の privacy E2E は本文表示と metadata のみ。ヘッダ回帰の検知点が不足 | Low |
| [src/app/privacy/page.tsx](../../src/app/privacy/page.tsx) | 問い合わせ先メール・電話が機械収集されやすい平文露出になっている（直接脆弱性ではないが abuse 耐性が弱い） | 必要性を維持しつつ、問い合わせフォーム導線や軽量難読化（例: bot 対策）を運用要件に応じ検討 | Open | `privacy@...` と電話番号を静的本文で直接表示 | Low |
| [src/proxy.ts](../../src/proxy.ts) | クリックジャッキング対策 | `X-Frame-Options: DENY` と `frame-ancestors 'none'` を継続維持 | Fixed | `X-Frame-Options` と CSP の二重防御を確認 | High |
| [src/proxy.ts](../../src/proxy.ts) | 基本セキュリティヘッダ不足 | `Referrer-Policy` `Permissions-Policy` `X-Content-Type-Options` `HSTS` を継続維持 | Fixed | 主要ヘッダが共通適用されていることを確認 | Medium |
| [src/contexts/Providers.tsx](../../src/contexts/Providers.tsx) | privacy 表示時の cart/wishlist 自動取得 | `CartProvider enabled={!isPrivacyPage}` を維持 | Fixed | `/privacy` では cart/wishlist 自動 fetch が停止していることを確認 | Medium |
| [src/app/privacy/page.tsx](../../src/app/privacy/page.tsx) | 外部リンク/外部画像経由の情報露出 | 外部 URL を増やさない現行構成を維持 | N/A | 本文は内部コンテンツ中心で、OGP 画像もローカルパス `/mainphoto.png` | Low |

---

## 重点観点ごとの結論

1. 静的ページとしての情報露出: **本文由来の露出は限定的。ただし共通 Cookie 発行で不要識別子露出がある（Open）**
2. 不要 API 呼び出し: **`/api/auth/me` が privacy 初期表示で発生（Open）**
3. CSP: **防御自体は有効だが許可先が広すぎる（Open）**
4. クリックジャッキング: **`X-Frame-Options` + `frame-ancestors` で対策済み（Fixed）**
5. 外部リンク/画像: **privacy ページ単体では顕著な外部依存なし（N/A）**
6. キャッシュ: **共通 Cookie 発行の影響で静的公開ページとして最適化余地あり（Open）**

---

## 推奨対応順序

1. `src/proxy.ts` のルート別 CSP 分離（High）
2. `src/proxy.ts` の `session_id` 発行条件を状態管理ルートへ限定（Medium）
3. `src/contexts/LoginContext.tsx` の auth 同期を privacy では遅延化（Medium）
4. privacy のキャッシュ方針を仕様化し実装へ反映（Medium）
5. `/privacy` 固有セキュリティヘッダ E2E を追加（Low）
6. 問い合わせ先の bot abuse 耐性を運用設計で補強（Low）

---

## 追加レビュー追記（2026-04-29 / Round 2）

### サマリー

- **High: 1件（Open）**
- **Medium: 1件（Open）**
- **Low: 1件（Open）**
- 既存レビューとの差分: CSRF 起点防御の Origin 判定境界、認証状態 API のデータ最小化、共通ヘッダ強化を追加

### 追加指摘一覧

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/proxy.ts](../../src/proxy.ts) | `resolveRequestOrigin()` が `x-forwarded-proto` / `x-forwarded-host` を常時優先し、信頼されない経路から同ヘッダが流入すると、状態変更 API の Origin 検証を迂回できる余地がある（A01: Broken Access Control / A05: Security Misconfiguration） | `TRUST_PROXY_HEADERS=true` などの明示条件時のみ Forwarded ヘッダを採用し、既存の許可オリジン集合（`src/lib/redirect.ts`）で照合する。非信頼環境では `host` と `request.url` ベースを優先 | Open | High |
| [src/app/api/auth/me/route.ts](../../src/app/api/auth/me/route.ts) | `GET /api/auth/me` が `email` を返却するが、`LoginContext` 側でメール値を利用しておらず、privacy ページ表示時の不要呼び出しと組み合わさって PII 露出面を広げる（A01 最小権限 / A09 Logging & Monitoring の観点でも不要データ伝播） | レスポンスを用途最小化し、`authenticated` と最小限の権限情報（`role`, `mfaVerified`）へ削減。メールが必要な画面のみ専用 API で取得 | Open | Medium |
| [src/proxy.ts](../../src/proxy.ts) | セキュリティヘッダは主要項目を満たす一方、`Cross-Origin-Opener-Policy` と `Cross-Origin-Resource-Policy` が未設定で、将来の外部連携追加時に cross-origin 境界が緩む可能性がある（A05） | `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Resource-Policy: same-origin` を追加し、必要な埋め込みはルート単位で例外設計 | Open | Low |

### 重点結論

1. `/privacy` 単体の本文実装より、共通防御層（`proxy`）の trust boundary 明確化が優先課題。
2. 認証状態同期の不要通信に加え、`/api/auth/me` の返却属性を最小化することで、PII の伝播面を縮小できる。
3. 既存ヘッダは良好だが、将来の機能追加に備えて cross-origin 分離ヘッダを先行投入する価値がある。

### 推奨対応順序（追加差分）

1. `src/proxy.ts` の Forwarded ヘッダ信頼条件を明示化し、許可オリジン照合へ統一（High）
2. `src/app/api/auth/me/route.ts` のレスポンスをデータ最小化（Medium）
3. `src/proxy.ts` に `COOP/CORP` を追加し、将来の拡張時リスクを先回り低減（Low）