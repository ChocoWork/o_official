# auth/password-reset セキュリティレビュー

- レビュー日: 2026-06-27（dynamic workflow / security-check skill + `scripts/page-audit.sh`）
- 対象: [src/app/auth/password-reset/page.tsx](../../src/app/auth/password-reset/page.tsx)、関連: [confirm](../../src/app/api/auth/password-reset/confirm/route.ts) / [request](../../src/app/api/auth/password-reset/request/route.ts) / [session](../../src/app/api/auth/password-reset/session/route.ts)
- レビュー観点: トークン/セッション一回性、パスワードポリシー、CSRF、列挙、Bot対策、レート制限
- 機械監査スコープ: UI到達クロージャ 9 ファイル / 関連Route Handler 3 件

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
| [src/app/api/auth/password-reset/confirm/route.ts](../../src/app/api/auth/password-reset/confirm/route.ts), [src/proxy.ts](../../src/proxy.ts) | パスワード変更（POST）に route 層の同一オリジン/CSRF 検証がなく、`proxy.ts` の `STATE_CHANGING_PATH_PREFIXES` も `/api/cart|wishlist|checkout` のみで `/api/auth/*` を含まない。アカウント乗っ取り級の影響面が SameSite Cookie 依存に偏る | `proxy.ts` の保護プレフィックスに `/api/auth/` の状態変更系を追加するか、route で `getRequestOrigin` 同一オリジン検証を行い fail-closed にする | Open | confirm はセッションCookie（`sb-password-reset-session`）で更新。route に csrf/same-origin 検証なし | Low |
| [src/app/api/auth/password-reset/confirm/route.ts](../../src/app/api/auth/password-reset/confirm/route.ts), [src/lib/cookie.ts](../../src/lib/cookie.ts) | 上記の主たる緩和はリセットセッションCookieが `SameSite=Strict`・HttpOnly である点。クロスサイトからは送出されないため CSRF 実現は困難 | 現行の Strict を維持。併せて defense-in-depth の same-origin 検証を足すと堅牢 | Partially Fixed | `cookieOptionsForPasswordReset` は `sameSite:'strict'`, `httpOnly:true` を確認 | Info |
| [src/app/api/auth/password-reset/confirm/route.ts](../../src/app/api/auth/password-reset/confirm/route.ts) | confirm にレート制限なし。legacy トークン経路はトークンハッシュ一致＋期限＋used で守られるが、総当たり耐性を多層化する余地 | confirm にも IP/セッション軸のレート制限を付与し、失敗時 audit を残す | Open | request 側は Turnstile+レート制限。confirm 側は未設定 | Low |
| [src/app/api/auth/password-reset/confirm/route.ts](../../src/app/api/auth/password-reset/confirm/route.ts) | トークン一回性・期限・used 管理、セッション経路の Cookie 失効（maxAge 0）まで実装済み。zod 検証・admin API 経由更新も適切 | 現行維持 | Fixed | session 経路: 成功時 Cookie クリア。legacy: `used=true` 更新を確認 | Info |
| [src/features/auth/schemas/password-reset.ts](../../src/features/auth/schemas/password-reset.ts) | 新パスワードは 8〜128 文字長検証のみ（UI helper も「8文字以上」）。複雑性は不問で NIST 準拠だが、流出パスワード照合は未導入 | 長さ重視方針は妥当。可能なら HIBP k-Anonymity 等で漏洩パスワード拒否を追加 | Open | `ResetSessionConfirmSchema` で new_password を長さ検証 | Low |
| [src/app/auth/password-reset/page.tsx](../../src/app/auth/password-reset/page.tsx) | request フォームは Turnstile（Bot対策）必須化、zod 事前検証あり。トークンはURLに残さずセッションCookie方式で confirm | 現行維持 | Fixed | L101-104 Turnstile 必須、L36 session 解決で confirm モード判定 | Info |

---

## 機械監査（page-audit.sh）所見の分類

| 機械検出 | 分類 | 根拠 |
|---|---|---|
| confirm/request「auth check なし」(HIGH) | 偽陽性 | 設計上の公開エンドポイント（未ログインで実行）。トークン/セッションが認可境界 |
| confirm「same-origin/CSRF なし」 | 真（但し Low） | 上表のとおり Cookie `SameSite=Strict` が主緩和。route 層 DiD は欠如 |

## 重点結論

1. パスワード変更の route 層に same-origin 検証がない点は、`SameSite=Strict` で実害は限定的だが、影響度の高さから `proxy.ts` の保護プレフィックスに `/api/auth/` を追加し多層化すべき。
2. confirm のレート制限と漏洩パスワード照合は次スプリント候補（Low）。
3. トークン一回性・期限・Bot対策・zod は良好。
