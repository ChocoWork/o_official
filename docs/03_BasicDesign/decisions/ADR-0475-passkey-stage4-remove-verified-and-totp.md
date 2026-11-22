# ADR-0475 `/auth/verified` と認証アプリ（TOTP）の窓口・MFA のやり直しの窓口を消し、行き先はログインの判定が直に返す

> 状態: 推定 | 確認日: 2026-11-22 | 対象: `src/features/auth/passkey/post-login.ts`、`src/features/auth/return-intent/return-intent-service.ts`、`src/app/api/auth/post-login/route.ts`、`src/app/api/auth/oauth/callback/route.ts`、`supabase/config.toml`。消した物: `src/app/auth/verified/`、`src/app/api/auth/mfa/`、`src/app/api/admin/users/mfa/`

## 概要

店員の入口をパスキーの2本に替えたので、認証アプリ（TOTP）の登録・確認の窓口（`/api/auth/mfa/{enroll-totp,status,verify}`）、確認の画面 `/auth/verified`、店長が店員の2要素を全部消す窓口（`/api/admin/users/mfa/reset`）は使い道が無い。パスキー段4の Task 30 で、これらを窓口・画面・試験ごと消し、手元の Supabase の TOTP も止めた。

`/auth/verified` はログインの後の振り分けも担っていたので、行き先は `POST /api/auth/post-login` と、その結果を受けるブラウザ側の `resolvePostLoginPath`、Google の戻りの `oauth/callback` が直に返す形に付け替えた。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH・ADMIN |
| 対応する ID | SEC-AUTH-061、FR-AUTH-053、SR-AUTH-030、FR-AUTH-018、DD-AUTH-060 |
| 対象のコード | `src/features/auth/passkey/post-login.ts`、`src/features/auth/return-intent/return-intent-service.ts`、`src/app/api/auth/post-login/route.ts`、`src/app/api/auth/oauth/callback/route.ts`、`supabase/config.toml` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（2-1・2-2・6-2・7）、[段4の計画](../../superpowers/plans/2026-11-20-passkey-stage4-cleanup.md)（Task 30）、[ADR-0463](ADR-0463-staff-entry-by-passkey-conditions.md)、[ADR-0468](ADR-0468-passkey-post-login-destination.md) |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-11-22 の作業ツリー（手元の Supabase を止めて起動し直し、TOTP が無効になることを確かめた） |

## 判断

### ADR-0475 `/auth/verified` と認証アプリ（TOTP）の窓口・MFA のやり直しの窓口を消し、行き先はログインの判定が直に返す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-061 |
| 根拠 | 店員はパスキーだけで入る（設計 3 の決定 3・7）ので、認証アプリを登録・確認させる画面と窓口は動かない。残すと、消した入口へのリンクと戻り先が残り（SEC-AUTH-061）、今ある店員の TOTP の要素があるとパスキーの登録と削除に `aal2` を求められて止まる（設計 6-2。GoTrue の決まり）。行き先の振り分けは `/auth/verified` が持っていたので、先に付け替えてから画面を消す |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（2-1・2-2・6-2・7）、`docs/superpowers/plans/2026-11-20-passkey-stage4-cleanup.md`（Task 30）、`.superpowers/sdd/2026-11-20-passkey-stage4-cleanup/task-30-brief.md` |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 | 出典 |
| --- | --- | --- | --- | --- | --- |
| 店員の2要素目 | パスワード＋メールのコード＋認証アプリ（TOTP） | 店員のパスキーがある。「パスワードの代わり」で、2段階認証とは別（確定） | NIST は、AAL2 では、だましに強い方法（FIDO2/WebAuthn）を選べるようにする（SHALL）。OWASP も管理者には多要素を必ず求める | 認証アプリは使わない。店員はパスキー（認めた鍵2本）だけで入る | [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b/)、[OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)、[Shopify のパスキー](https://help.shopify.com/en/manual/your-account/logging-in/passkeys) |
| 店員への強制 | 店員の入口の条件は管理画面の側で数える | オーナーは店員に2段階認証を強制できない。Plus の組織は「パスキーか2段階認証」を必須にできる（確定） | 要素の変更は危険度が高い操作。やり直しで多要素を飛ばせてはならない | 店員は全員パスキー必須。やり直しは店長だけが出す（段3a の `redo`） | [Shopify の2段階認証](https://help.shopify.com/en/manual/your-account/account-security/two-step-authentication)、[Shopify の組織のセキュリティ](https://help.shopify.com/en/manual/organization-settings/security/two-step-authentication)、[OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html) |
| 要素のやり直し | 店長が店員の2要素を全部消す窓口（`mfa/reset`） | 再設定するとパスキーが全部消える（確定） | 要素の変更は知らせる | 窓口は消す。やり直しは店員のパスキーを全部消す店長の窓口（`redo`）に一本化し、足す・消すは本人と店長に知らせる | [Shopify のパスキー](https://help.shopify.com/en/manual/your-account/logging-in/passkeys)、[OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html) |

NIST の見立て、Shopify の説明、OWASP の資料は設計の 2-1・2-2 で読んだ物を引いた。Shopify の仕様の詳細は公開の説明で確かめた範囲に限る。

#### 決定

- `/auth/verified`、`/api/auth/mfa/{enroll-totp,status,verify}`、`/api/admin/users/mfa/reset` を、窓口・画面・それを調べる試験ごと消す。どれも 404 になる（`FR-LOGIN-080`。FR-AUTH-053-AC-03）
- 手元の `supabase/config.toml` の `[auth.mfa.totp]` の `enroll_enabled`・`verify_enabled` を `false` にする。手元の反映は `supabase stop` → `start`（本番のダッシュボードの設定は段4の範囲の外）
- 行き先を、`/auth/verified` を返さない形に付け替える。`post-login` の窓口と戻り先の解決（`resolveReturnDestination`）、Google の戻り（`oauth/callback`）が返す

  | 場面 | 行き先 |
  | --- | --- |
  | お客さん | 戻り先かホーム `/` |
  | 店員で入口の条件を満たす | 戻り先か `/admin` |
  | 店員で認めた鍵が1本 | `/admin/passkeys?more=1` |
  | 店員でそれ以外 | `/login?error=staff_passkey_required` |
  | 通信の失敗・2xx でない応答・読めない本文 | `/login` |

  窓口とサーバーの判定は、入口の条件を満たさない店員に `redirectTo: '/login?error=staff_passkey_required'`・`needsMfa: true` を返す。ブラウザ側の `resolvePostLoginPath` が `needsMfa` の時だけ鍵の数（`GET /api/auth/passkey` の `approvedCount`）を読み、ちょうど1本なら `/admin/passkeys?more=1` へ送る（JWT の印 `staff_passkeys_ok` は真偽しかないので、窓口は数を知らない）。数が読めない時は `/login?error=staff_passkey_required`
- **名前は変えない**（設計 7）: `/api/auth/me` の `mfaVerified`、`/api/auth/post-login` の `needsMfa`、`LoginContext` の `isMfaVerified`、拒否の理由 `admin_requires_privileged_aal2`。意味は「店員の入口の条件（パスキー・24時間以内・認めた2本）を満たすか」。約80本の E2E がこの形を偽装しているので、応答の形を保つ。ADR-0463・ADR-0468 にあった「段4でまとめて直す」は「変えない」に改める
- `src/lib/auth/amr.ts` の 2 段目の方法の一覧から `totp` を外す

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `/auth/verified` を残し、振り分けだけにする | 店員が認めた鍵不足で着く画面が `/login?error=staff_passkey_required` の既存の文で足りる。画面を残すと、消した TOTP の見せ方の状態が残る |
| `mfaVerified`・`needsMfa` を `staffEntryOk` のような名前に直す | 応答の形を約80本の E2E と6つの画面が使っている。名前を変える利点より、変える範囲の方が大きい |
| 窓口が認めた鍵の数を数えて `/admin/passkeys?more=1` を直に返す | 窓口は JWT のヒントしか持たない。数えるには DB を1回引く必要があり、ログインの後の窓口が重くなる。ブラウザ側は既に鍵の一覧の窓口を持つ |
| `mfa/reset` を `redo` と併存させる | 同じ操作の窓口が2つになり、確認の語・理由の文・監査の扱いが二重になる |

#### 結果

- 良くなること: 店員の入口がパスキーの条件の1つになり、消した TOTP の画面・窓口・状態が無い。ログインの後の行き先に、消した画面が現れない
- 悪くなること: 認めた鍵が1本の店員の行き先が、窓口でなくブラウザ側の読み（`resolvePostLoginPath`）で決まる。窓口を直接呼ぶ呼び出し手は `/login?error=staff_passkey_required` を受ける
- 見直す条件: 店員の認めた鍵の数を JWT の印で持てるようになった時（窓口が数を返せるようになる）

#### 測った事実（段4 Task 26。2026-11-22。手元の GoTrue。`.superpowers/sdd/2026-11-20-passkey-stage4-cleanup/baseline.md`）

- (a) パスワードを持つ確認済みのアカウントに `/auth/v1/otp` を送ると、件名「ログインの確認コード」で8桁のコードが届き、リンクは付かない。`/auth/v1/verify`（`type=email`）が 200 でトークンを返す
- (b) 確認前のアカウントに送ると、件名「メールアドレスの確認」で確認のリンクだけが届き、8桁のコードは付かない（ADR-0469 の「確認のメール」を実測で確かめた）
- (c) 確認前のアカウントは、リンクを開かないと、パスワードの grant が 400 `email_not_confirmed`、`verify` が 403 `otp_expired` になり、入れる道が無い。リンクの `token_hash`（`type=signup`）だけが 200
- (e) 確認のメールの雛形に `{{ .Token }}` を足すと、確認前のアカウントにもリンクと8桁のコードの両方が届き、コードで `verify` が 200 を返して確認済みになる。パスワードの grant は 400 のまま
