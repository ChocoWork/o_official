# ADR-0415 `/api/auth` 配下の `Cache-Control: no-store` は route でなく proxy で付ける

> 状態: 現行 | 確認日: 2026-10-28 | 対象: 共有の `src/proxy.ts` が呼ぶ `src/lib/auth-no-store-policy.ts` の `shouldSetNoStore`（`/api/auth`） | 基準コミット: `90786822`（作業ツリー）

## 概要

`/api/auth` 配下の全部の応答に `Cache-Control: no-store` を付ける。窓口（route）ごとに書かず、共有の `src/proxy.ts` が、通常の応答（`NextResponse.next()` の後）と Origin 拒否の 403 の両方に、セグメントの境目（`/api/auth` か `/api/auth/…`）で当たる時だけ付ける。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH（呼び出す共有の `src/proxy.ts` はどの領域の範囲のコードでもない） |
| 対応する ID | SEC-AUTH-022（AC-02） |
| 対象のコード | `src/proxy.ts` の `proxy`（`shouldSetNoStore` を呼ぶ）、`src/lib/auth-no-store-policy.ts` の `shouldSetNoStore`。窓口が自分で付ける値は `src/app/api/auth/{confirm,login/cancel,login/resend,me,oauth/start,oauth/callback,password-reset/link,password-reset/session,post-login}/route.ts` |
| 関連文書 | [AUTH の要件](../../02_Requirements/areas/auth.md)、[AUTH の脅威](../../05_Quality/security/threats/auth.md)（THR-AUTH-022）、`docs/superpowers/plans/2026-10-28-wave3-csp-images-session.md`（Task 10）、`.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R10） |
| 試験 | `tests/unit/middleware/proxy-no-store.test.ts`、`e2e/FR-LOGIN-030-session-cookies-and-responses.spec.ts` |
| 調べた時点 | 2026-10-28（単体の試験は流した。E2E は書いただけで流していない） |

## 判断

### ADR-0415 `/api/auth` 配下の `Cache-Control: no-store` は route でなく proxy で付ける

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-022 |
| 根拠 | 認証の応答にはトークンの更新・確認コードの検証・TOTP の登録と確認・MFA の状態が含まれ、共有の端末や中継のキャッシュに残してはならない（ASVS V8.2.1）。以前は `confirm`・`me`・`oauth/*` などの一部の窓口だけが自分で `no-store` を付け、`login`・`otp/verify`・`refresh`・`register`・`mfa/*` は付けていなかった。窓口ごとの opt-in だと、新しい窓口を足すたびに付け忘れが起きる |
| 状態 | 現行 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R10）、`docs/05_Quality/reviews/security/security_review_login.md`、[OWASP ASVS 4.0.3 V8.2.1](https://github.com/OWASP/ASVS/blob/v4.0.3/4.0/en/0x16-V8-Data-Protection.md)、[MDN Cache-Control: no-store](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control#no-store) |

#### 背景

| 観点 | 今の私たち（直す前） | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 認証の応答のキャッシュ | 一部の窓口だけが `no-store` を付ける | 確かめていない（Shopify の公式資料でこの点を読んでいない。顧客のアカウントの応答を共有のキャッシュに載せない作りと推測するが、根拠にしない） | OWASP ASVS V8.2.1 は、機微なデータを含む応答をクライアントのキャッシュに残さないことを求める。付与は 1 か所に集めるほうが付け忘れにくい | 経路の単位で 1 か所に集める |
| 付ける場所 | 窓口ごと | 共通の層 | 共通のミドルウェアで既定を決め、例外だけを窓口で書く | 共有の proxy |

- proxy が付けた値と窓口が付けた値の関係: 窓口が自分で付ける値は全部 `no-store` で、proxy の値と同じ。Next.js では窓口の応答の見出しが後から同名を書く見込みだが、未実測（E2E `FR-LOGIN-030` が実応答を見る）。値が同じなので、どちらが残っても結果は変わらない。窓口が付けない窓口（`login`・`otp/verify`・`refresh`・`register`・`mfa/*`・`logout`）では proxy の値が出る

#### 決定

- `shouldSetNoStore(pathname)`（`src/lib/auth-no-store-policy.ts`。`/api/auth` か `/api/auth/…` の時だけ true）が true の時だけ、通常の応答と Origin 拒否の 403 の両方に `Cache-Control: no-store` を付ける。`/api/authx`・`/api/authentication` には付けない
- 判定を `src/proxy.ts` の中に置かず小さな関数に出した理由: `proxy` 全体は CSP・Origin の検査も持つ共有部品で AUTH の範囲に入れられず、`proxy.ts` の中のままだと `DD-AUTH-037` に「コードの単位」と「単体の試験」が付かず、`validate-trace` の違反が基準より増える。このため `matchesPathSegment`（`proxy.ts` 内）は呼ばず同じ式を書き直している（ADR-0355 の `session-cookie-policy.ts` と同じ形。式が 2 か所になる点は承知）
- 他の見出し（CSP・HSTS・`Referrer-Policy` など）は今までどおり全部の道に付ける。`/api/order-status` の Origin 拒否が持つ `no-store` と `Referrer-Policy: no-referrer` は変えない
- 窓口が自分で付ける `no-store` は消さない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `/api/*` 全体に既定で付ける | 検索・ニュースなど、窓口が `s-maxage` で共有のキャッシュを許す応答がある。proxy の値と窓口の値のどちらが勝つかの確かめ（順序）がまだ無い。別件にする |
| 窓口ごとに `withNoStore` を足す（検索・ニュース・取扱店の 1-C と同じ） | 認証は窓口が多く（19 本）、新しい窓口を足すたびに付け忘れが起きる。検索・ニュース・取扱店は窓口単位のまま残す（共有の proxy に領域ごとの道筋を持たせない） |
| 付けない（窓口で足りるとする） | `login`・`otp/verify`・`refresh`・`mfa/*` の応答に付かない |

#### 結果

- 良くなること: 認証の窓口を足しても付け忘れが起きない。Origin 拒否の 403（本文は固定の文字）にも付く
- 悪くなること: 共有の proxy に認証の道筋を 1 つ持つ。窓口が将来「共有のキャッシュを許す」値を付ける場合は、proxy の値と窓口の値の順を確かめてから決める
- 見直す条件: `/api/*` 全体の既定にしたい時（窓口の `s-maxage` との上書きの順を本番ビルドで確かめる）
