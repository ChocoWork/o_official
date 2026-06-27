# auth/callback セキュリティレビュー

- レビュー日: 2026-06-27（dynamic workflow / security-check skill + `scripts/page-audit.sh`）
- 対象: [src/app/auth/callback/page.tsx](../../src/app/auth/callback/page.tsx)、関連: [src/app/api/auth/oauth/callback/route.ts](../../src/app/api/auth/oauth/callback/route.ts), [src/app/api/auth/me/route.ts](../../src/app/api/auth/me/route.ts)
- レビュー観点: OAuth code 受け渡し、リダイレクト先検証（open redirect）、認証状態確認、CSP/同一オリジン
- 機械監査スコープ: UI到達クロージャ 1 ファイル / 関連Route Handler 2 件（`scripts/page-audit.sh src/app/auth/callback`）

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| Open | 未修正 |
| Partially Fixed | アプリ層は対処済み、別層は未対処 |
| Fixed | 修正済み |

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/auth/callback/page.tsx](../../src/app/auth/callback/page.tsx) | `next` パラメータ検証が `raw.startsWith('/')` のみで、protocol-relative URL（`//evil.com`）やバックスラッシュ（`/\evil.com`）が通過する。`router.replace(next)` でオフサイト遷移し open redirect になる | `startsWith('/')` かつ `startsWith('//')`・`startsWith('/\\')` を除外する。共通の安全リダイレクト判定（`@/lib/redirect`）に集約し、許可は内部パスのみとする | Open | L19-22 で `next` を導出し L54 `router.replace(next)` に使用。`//evil.com`.startsWith('/') は true | Medium |
| [src/app/auth/callback/page.tsx](../../src/app/auth/callback/page.tsx), [src/app/api/auth/oauth/callback/route.ts](../../src/app/api/auth/oauth/callback/route.ts) | code 検出時に元クエリ（`next` 含む）を全て `window.location.replace('/api/auth/oauth/callback?...')` へ転送。サーバ側 callback の最終リダイレクトでも `next` を使うなら同じ open redirect 面が残る | サーバ側 callback でも `next` を内部パス許可リストで検証してから 3xx する。クライアント・サーバ双方で同一の検証ロジックを使う | Open | L34-37 で redirectParams を素通し転送。サーバ側の `next` 取り扱いは login レビュー（[security_review_login.md](./security_review_login.md)）と合わせて要確認 | Medium |
| [src/app/auth/callback/page.tsx](../../src/app/auth/callback/page.tsx) | 認証判定を `/api/auth/me` の `authenticated===true` で行い、失敗時はログイン誘導。トークンはクライアントに保持せず Cookie 前提で適切 | 現行方針を維持。`/api/auth/me` は `no-store`・`credentials:'same-origin'` 済み | Fixed | L40-54。応答型を厳密に narrowing してから判定 | Info |

---

## 機械監査（page-audit.sh）所見の分類

- UI到達クロージャ=1（ページ単体）、関連Route=2（oauth/callback, me）。入力フォーカス検査は追加指摘なし。
- OWASP机上（audit.sh --files-only）: ページ単体に injection sink / 危険な DOM API なし。CSP/HSTS は `proxy.ts` で全レスポンスに付与（[proxy.ts](../../src/proxy.ts) L137-142）。

## 重点結論

1. 最重要は `next` の open redirect（protocol-relative バイパス）。フィッシング誘導に悪用余地があり、クライアント・サーバ両方で内部パス許可に統一する。
2. OAuth state/PKCE/one-time 消費はサーバ側 callback の責務で、詳細は [security_review_login.md](./security_review_login.md) の oauth callback 指摘を参照。
3. ページ自体の認証状態同期（Cookie + `/api/auth/me`）は適切。
