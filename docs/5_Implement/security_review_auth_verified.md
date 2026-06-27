# auth/verified セキュリティレビュー

- レビュー日: 2026-06-27（dynamic workflow / security-check skill + `scripts/page-audit.sh`）
- 対象: [src/app/auth/verified/page.tsx](../../src/app/auth/verified/page.tsx)、関連: [mfa/status](../../src/app/api/auth/mfa/status/route.ts) / [mfa/enroll-totp](../../src/app/api/auth/mfa/enroll-totp/route.ts) / [mfa/verify](../../src/app/api/auth/mfa/verify/route.ts) / [auth/me](../../src/app/api/auth/me/route.ts)
- レビュー観点: ロール判定、MFA(TOTP)登録/検証、権限昇格、CSRF、TOTPシークレット表示、リダイレクト
- 機械監査スコープ: UI到達クロージャ 7 ファイル / 関連Route Handler 4 件

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
| [src/app/api/auth/mfa/enroll-totp/route.ts](../../src/app/api/auth/mfa/enroll-totp/route.ts), [src/app/api/auth/mfa/verify/route.ts](../../src/app/api/auth/mfa/verify/route.ts), [src/proxy.ts](../../src/proxy.ts) | MFA 登録/検証（POST）に route 層の same-origin/CSRF 検証がなく、`proxy.ts` 保護プレフィックスにも `/api/auth/*` が含まれない。緩和はセッションCookie `SameSite=Lax` + JSON/CORS プリフライト依存 | `proxy.ts` の保護対象に `/api/auth/` 状態変更系を追加、または各 route で同一オリジン検証を実施 | Open | enroll/verify は `credentials:'same-origin'` で呼ばれるが route 層検証は未確認。Lax は cross-site POST を送出しないため実害は限定的 | Low |
| [src/app/auth/verified/page.tsx](../../src/app/auth/verified/page.tsx) | 管理画面アクセス可否は最終的にサーバ（`/api/auth/me` のロール + `mfaVerified`、MFA verify）で判定し、クライアント状態は表示制御のみ。権限昇格はサーバ権限に依存 | 現行維持。`/admin` 配下・各 admin API でも MFA/ロールを再検証していること（[security_review_admin.md](./security_review_admin.md)）と整合を保つ | Fixed | L137-159 ロール別分岐、L246-259 verify 成功時のみ `/admin` 遷移 | Info |
| [src/app/auth/verified/page.tsx](../../src/app/auth/verified/page.tsx) | TOTP シークレット/URI/QR を画面表示（登録フロー上は必要）。共有端末ではショルダーハッキング余地 | 現行は登録時のみ・details 折り畳み表示で妥当。完了後はシークレットを保持/再表示しない点を維持 | Partially Fixed | L302-322 QR/secret 表示。検証完了で `/admin` 遷移しシークレットは状態破棄 | Info |
| [src/app/auth/verified/page.tsx](../../src/app/auth/verified/page.tsx) | OTP 入力は `replace(/\D/g,'').slice(0,8)` でクライアント整形、検証も `^\d{6,8}$`。サーバ側でも factorId+code を検証 | 現行維持 | Fixed | L232, L348。`img src={qrCodeSvg}`（data: URI）は CSP `img-src data:` 許可済み | Info |

---

## 機械監査（page-audit.sh）所見の分類

| 機械検出 | 分類 | 根拠 |
|---|---|---|
| mfa/enroll-totp・mfa/verify「auth check なし」(HIGH) | 偽陽性 | enroll/verify/status とも `resolveRequestUser` で認証 + レート制限あり（確認済）。`scripts/page-audit.sh` の認証検出パターンに `resolveRequestUser` を追加済み |
| mfa/*「same-origin/CSRF なし」(HIGH) | 真（但し Low） | 上表。Cookie `SameSite=Lax` + CORS が主緩和。route 層 DiD 欠如 |

## 重点結論

1. MFA 状態変更系の route 層 same-origin 検証欠如は Low（Lax+CORS 緩和あり）だが、特権獲得の起点であるため `/api/auth/` を `proxy.ts` 保護対象へ追加することを推奨。
2. ロール/MFA の最終判定はサーバ側で行われ、クライアントは表示制御のみ。権限昇格面は admin レビューと併読。
3. TOTP シークレット表示は登録フロー上妥当。完了後の非保持を維持。
