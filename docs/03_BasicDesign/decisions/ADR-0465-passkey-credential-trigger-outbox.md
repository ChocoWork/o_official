# ADR-0465 パスキーの足し・消しは GoTrue の表への引き金で拾い、認めの控えを先に消して outbox は失敗を握る

> 状態: 推定 | 確認日: 2026-11-16 | 対象: `supabase/migrations/20261116232141_passkey_credential_events.sql` | 基準コミット: 2dca811c

## 概要

パスキーの足し・消し・鍵の差し替えは、`auth.webauthn_credentials` への行ごとの引き金 1 本で拾う。引き金は、同じ鍵の認めの控え（`private.approved_passkeys`）を先に消し、その後で送る予定の表（`private.passkey_notification_outbox`）に積む。積む処理だけを例外の囲みに入れ、失敗しても鍵とユーザーの削除は止めない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-012、FR-AUTH-009、FR-AUTH-009-AC-01、SEC-AUTH-038、THR-AUTH-038、DATA-AUTH-014、DD-AUTH-045 |
| 対象のコード | 移行 `supabase/migrations/20261116232141_passkey_credential_events.sql`、`src/lib/auth/staff-passkey-credential-events.ts` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（5-4・8-2）、[計画](../../superpowers/plans/2026-11-16-passkey-stage1a-foundation.md)、[ADR-0464](ADR-0464-access-token-hook-single-gate.md) |
| 試験 | DB 結合 `tests/integration/db/auth_passkey_credential_events.integration.test.ts`、単体 `tests/unit/lib/auth/staff-passkey-credential-trigger.test.ts`、E2E `e2e/FR-LOGIN-043-passkey-trigger-function-grants.spec.ts` |
| 調べた時点 | 2026-11-16（手元の Supabase で `db reset` の後に DB 結合を流した。E2E は書いただけで、調整役が流す） |

## 判断

### ADR-0465 パスキーの足し・消しは GoTrue の表への引き金で拾い、認めの控えを先に消して outbox は失敗を握る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-AUTH-009、SEC-AUTH-038 |
| 根拠 | 鍵は GoTrue の窓口・直叩き・ユーザー削除の連鎖のどこからでも足し・消しされるので、アプリの窓口だけで拾うと漏れる。DB の表の引き金ならどの道でも走る（設計 5-4）。認めの控えの削除は、outbox の失敗で取り消されてはならず、通知の取りこぼしより鍵・ユーザーの削除を優先する |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（5-4・8-2）、ユーザーの決定 2026-11-16 |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 認証の資格情報の変更の通知 | 無し | 確かめていない（Shopify の公式資料でスタッフの鍵の通知を読んでいない） | 資格情報の追加・削除は本人と管理者に通知する（NIST SP 800-63B 6.1.2.3 の考え方） | 引き金で予定を積む。送るのは段2・3 |
| 認めの控えの掃除 | 無し | - | 派生データは元の行と同じ取引で消す | 鍵の削除と同じ取引で認めの行を消す |

#### 決定

- 引き金 `passkey_credentials_notify`（`AFTER INSERT OR UPDATE OR DELETE`・行ごと）と関数 `private.passkey_credentials_notify()`（`SECURITY DEFINER`・持ち主 `postgres`・`search_path` 空・`execute` は誰にも渡さない）
- 認めの行の削除は例外の囲みの外で先に行い、次の文で `FOUND` を控える。`RETURNING` は使わない。outbox への書き込みだけを囲みに入れ、失敗は `RAISE WARNING` に留める
- 店員は `user_roles` の有効な admin・supporter（フックと同じ）か、その鍵の認めの行を今回消したか。`notify_subject` は `auth.users` の行が在るか。お客さんの削除の連鎖は積まない
- `approved_passkeys.user_id` に外部キーを付けない（移行 A）ので、ユーザー削除の連鎖で控えが先に消えない。控えを消すのは引き金だけ

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| アプリの窓口で足し・消しを記録する | GoTrue の直叩き・ユーザー削除の連鎖が漏れる |
| 認めの削除も outbox と同じ囲みに入れる | outbox の失敗で削除が取り消され、消えた鍵の認めが残る |
| 削除に `RETURNING` を付けて控える | 控え方が1つに決まらず、次の文の `FOUND` と二重になる。単純な `DELETE` と直後の `FOUND` に統一する |
| outbox の失敗で鍵の削除を止める | 通知の取りこぼしより、鍵・ユーザーを消せなくなる害のほうが大きい |

#### 結果

- 良くなること: どの道でも足し・消しが残り、認めの控えが鍵と同時に消える。数え方は実在の鍵とも突き合わせるので、引き金が働かない道でも管理の権限は増えない
- `src/lib/auth/staff-passkey-credential-events.ts` はいまは製品のコードから呼ばれず、追跡の単位を置くための物（Task 4・5 と同じ形）。段2の送る側が使う
- 悪くなること: 通知の取りこぼしが起こりうる（WARNING のみ）。認めた鍵が無い店員を削除し、連鎖で `user_roles` が先に消えると、店長への知らせが出ないことがある（SEC-AUTH-038 で受け入れる）
- 戻し方: `postgres` は表の持ち主でなく `DROP TRIGGER` を流せない。関数を空に置き換えて止め、引き金の削除は `supabase_auth_admin` の手順にする。移行の再実行は、引き金が無い時だけ作る
- 見直す条件: 本番で引き金を作れない・GoTrue の更新で消える時（設計 8-2 の3）は、別の拾い方を決める
