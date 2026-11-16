# ADR-0463 管理の入口は `aal2` をやめ、パスキー・24時間以内・認めたパスキー2本以上を、その場で数えて判定する

> 状態: 推定（判定の部品は作った。管理の入口につなぐのは段1a の Task 9） | 確認日: 2026-11-17 | 対象: `src/lib/auth/staff-passkey.ts`、`supabase/migrations/20261117001500_passkey_staff_entry_conditions_fn.sql`

## 概要

店員（店長・サポーター）が管理の入口を通る条件を、「`aal2`（TOTP）」から次の3つ全部に置き換える。(1) `amr` に `passkey` がある、(2) その時刻から24時間以内、(3) 認めたパスキーが2本以上。3つ目は JWT の印を信じず、API も RLS も判定のたびに DB で数える。置き換えは Task 9 で有効になり、この ADR では判定の部品を作り、決めを記録する。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-014、FR-AUTH-011、FR-AUTH-011-AC-01、SEC-AUTH-039、THR-AUTH-039、DATA-AUTH-016、DD-AUTH-047 |
| 対象のコード | `src/lib/auth/staff-passkey.ts`、移行 `supabase/migrations/20261117001500_passkey_staff_entry_conditions_fn.sql` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（5-2・12 の18・12-2 の8）、[計画](../../superpowers/plans/2026-11-16-passkey-stage1a-foundation.md)、[ADR-0409](ADR-0409-mfa-role-from-jwt-claims.md)、[ADR-0418](ADR-0418-auth-has-permission-requires-aal2-and-bound-session.md)、[ADR-0464](ADR-0464-access-token-hook-single-gate.md) |
| 試験 | 単体 `tests/unit/lib/auth/staff-passkey.test.ts`、DB 結合 `tests/integration/db/auth_passkey_staff_entry_conditions.integration.test.ts`、E2E `e2e/FR-LOGIN-045-passkey-staff-entry-function-grants.spec.ts` |
| 調べた時点 | 2026-11-17（手元の Supabase で `db reset` の後に DB 結合を流した。E2E は書いただけで、調整役が流す） |

## 判断

### ADR-0463 管理の入口は `aal2` をやめ、パスキー・24時間以内・認めたパスキー2本以上を、その場で数えて判定する

| 属性 | 値 |
| --- | --- |
| 上位 | FR-AUTH-011、SEC-AUTH-039 |
| 根拠 | パスキーのログインでは JWT の `aal` が `aal1` のまま（手元の試し T1）なので、`aal2` を求める今の判定では店員が入れない。代わりに `amr` の `passkey` と時刻、認めた鍵の本数で判定する。本数を JWT の印で見ると、鍵が消された後も最長1時間、権限が残る。オーナーが、DB でその場で数えて止めると決めた（2026-11-16） |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（5-2・12 の18・12-2 の8）、ユーザーの決定 2026-11-16 |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 管理の入口の条件 | `aal2`（TOTP）かどうか | Shopify はスタッフのログインにパスキーと2段階認証を使える。店主が他のスタッフの2段階認証を有効にすることはできず、Plus の店だけが全員に安全なログイン方法（パスキーなど）を求められる（2026-11-17 に [2段階認証の説明](https://help.shopify.com/en/manual/your-account/account-security/two-step-authentication) で確認）。判定の中身（本数・時刻）は公開資料で確かめていない | パスキーは2つ目の要素を兼ねる。GitHub は「パスキーはパスワードと2FAの両方を満たす」（[About passkeys](https://docs.github.com/en/authentication/authenticating-with-a-passkey/about-passkeys)）、Google は2段階認証の2つ目にパスキーを使える（[ヘルプ](https://support.google.com/accounts/answer/13548313)）。NIST SP 800-63B-4 は同期できるパスキーを、書き出せる鍵として AAL3 未満（AAL2 以下）に置く（[3.2.13・3.1.6.1](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)。AAL2 に届くと明記した文は、取れた範囲では確認できず、読み取りは推定）。判定は都度サーバーで確かめる（OWASP ASVS V4.1.3。古い主張に頼らない向きは V3.3.1 と同じ） | 3つの条件に置き換え、3つ目は都度 DB で数える |
| 本数の持ち方 | なし | - | 権限に関わる事実は、署名された古い主張でなく、元の表で確かめる | JWT の印はヒントに下げる |

#### 決定

- `aal2` を管理の入口の判定に使わない（`aal` は見ない）。置き換えの範囲は、アプリの管理の認可（`admin-rbac`）と DB の `has_permission` の `aal2` の検査。結び付いた生きた session（ADR-0417・0418 の後半）はそのまま
- TS は `evaluateStaffEntry(claims, approvedCount, nowSeconds)`、SQL は `private.staff_passkey_amr_ok`・`staff_passkey_count_ok`・`staff_passkey_entry_ok`。同じ値の表で確かめる。API は `approvedCount` を RPC `passkey_approved_count` で取り、RLS は `has_permission` の中で関数を呼ぶ（Task 9）
- 3つ目の条件は、JWT の `staff_passkeys_ok` を使わず、判定のたびに DB で数える。数え方は認めの控えと実在の鍵（`id`・`user_id`・`credential_id`）の突き合わせ（ADR-0464）。印はヒントとして残す
- 定数と設定の行は同じ値にする。`STAFF_MAX_SESSION_SECONDS`（86400）・`STAFF_MIN_APPROVED_PASSKEYS`（2）は `defaultStaffPasskeySettings()` から取り、DB の設定の行の既定値と同時に変える（単体テストが一致を確かめる）。SQL の関数は設定の行を読む
- 3つの SQL の関数は `SECURITY DEFINER`・持ち主 `postgres`・`search_path` 空・`STABLE`。`public`・`anon`・`authenticated`・`service_role` から `execute` を外す（`private.app_session_is_live` と同じ）。`has_permission` が定義者の権限で呼ぶので、新しい権限は要らない
- 403 の本文 `MFA required` と `denial.reason = 'mfa'` は変えない。画面の判定が6ファイル・試験が76ファイルで使っているため、意味だけがパスキーの条件に変わる。名前の変更は MFA を消す段4

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `aal2` を保つ（パスキーの後に TOTP を求める） | パスキーは `aal1` のまま。TOTP を残すと、置き換える目的（パスワード・TOTP の廃止）に反する |
| 3つ目を JWT の印で判定する | 認めた鍵が消された後、JWT の期限（最長1時間）まで権限が残る（SEC-AUTH-039） |
| 印の値をトークンの更新ごとに作り直して短くする | 更新の間隔の間は古いまま。その場の判定にならない |
| 403 の文言と `reason` を今変える | 画面6ファイル・試験76ファイルを同時に変える大きな変更になり、段1a の「切り替えを1つのコミットにする」を重くする |
| 関数を `service_role` にも渡す | `has_permission` は定義者の権限で呼ぶので要らない。渡すと外へ判定の道具が増える |

#### 結果

- 良くなること: 鍵を消すとその場で管理の権限が止まる。TS と SQL が同じ表で確かめられ、食い違いに気づける
- 悪くなること: 判定のたびに認めの控えを数える（店員1人に数本の行。受け入れる）。「MFA required」の文言が、中身はパスキーの条件を指す（段4まで）
- 置き換え済みの決め: [ADR-0409](ADR-0409-mfa-role-from-jwt-claims.md)・[ADR-0418](ADR-0418-auth-has-permission-requires-aal2-and-bound-session.md) の `aal2` を求める部分は、この ADR で置き換える（有効になるのは Task 9）
- 見直す条件: 判定の費用が目に見える時（キャッシュを考える）。本番でフックや引き金が働かない道が見つかった時（SEC-AUTH-038）
