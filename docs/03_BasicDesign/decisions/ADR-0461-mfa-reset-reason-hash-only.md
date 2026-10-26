# ADR-0461 MFA リセットの理由の文は監査に残さず、長さとハッシュだけを残す

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `src/app/api/admin/users/mfa/reset/route.ts`、`src/lib/auth/revoke-user-sessions.ts` | 基準コミット: `77e7f844`

## 概要

2要素のリセットの監査には、理由の文・対象のメール・誤りの文を残さない。理由は前後の空白を除いた長さ（`reason_length`）と SHA-256 の 16 進（`reason_sha256`）だけを残し、誤りの文はアプリの記録（`console.error`）に回して監査には固定の文を書く。あわせて、対象の役割を `user_roles`（DB の ACL）で決め、2要素を全部消せた後に対象の自前と Auth の session を全部失効させる。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ADMIN |
| 対応する ID | SEC-ADMIN-008、SEC-ADMIN-014、THR-ADMIN-008、THR-ADMIN-014、DRV-ADMIN-002 |
| 対象のコード | `src/app/api/admin/users/mfa/reset/route.ts`。失効は共有の部品 `src/lib/auth/revoke-user-sessions.ts`（範囲外。強制失効の窓口とも共有） |
| 関連文書 | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1b-decisions.md`（ユーザー承認 2026-10-26。D4）、`docs/superpowers/plans/2026-10-26-wave1b-local-fixes.md` の P9 と Task 4、ADR-0454、ADR-0457 |
| 要件の文書 | `docs/02_Requirements/areas/admin.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（単体・結合試験の写しで確かめた。本物の GoTrue との通しと E2E は未実行） |

## 判断

### ADR-0461 MFA リセットの理由の文は監査に残さず、長さとハッシュだけを残す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ADMIN-008、SEC-ADMIN-014、DRV-ADMIN-002 |
| 根拠 | 監査ログは長く残り、店長と DB の運用者が読み、`ALERT_AUDIT_URL` を設定すれば外の Webhook にも写る。理由の文には個人の事情が、対象のメールには個人情報が入りうる。対象は `resource_id`（利用者の id）で特定できるので、メールは要らない。理由は後で別の記録の文と突き合わせられるよう、ハッシュと長さだけを残す。全文が要る場合は暗号化の保存が別に要る。ユーザーが 2026-10-26 に推奨の案（長さとハッシュ）を承認した。役割と失効は、権限を外された人の古い `app_metadata` で判定を誤らないことと、2要素を外した後に古い session で入れないことのため |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1b-decisions.md`、`.superpowers/sdd/2026-10-25-security-gap-fixes/ADMIN.md`、[OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)（機密を記録から外す・伏せる・ハッシュにする）、[Supabase JavaScript Reference: auth.admin.mfa.deleteFactor](https://supabase.com/docs/reference/javascript/auth-admin-deletefactor)、`docs/03_BasicDesign/architecture/hybrid-rbac.md` |

#### 背景

比べた物は次のとおり。

| 観点 | 以前の私たち | Supabase の文書 | OWASP | 結論 |
| --- | --- | --- | --- | --- |
| 監査の理由・メール | 平文で `metadata` に入れた | － | 機密は記録から外す・伏せる・ハッシュにする | 長さとハッシュだけ。メールは入れない |
| 誤りの文 | `error_message`・`delete_errors[].message` を入れた | － | 内部の詳細を利用者向けの記録に出さない | アプリの記録に回し、監査は固定の文 |
| 対象の役割 | `app_metadata.role`（古くなりうる） | `app_metadata` は利用者本人は変えられないが、ACL の付け外しとずれて古くなりうる | － | DB の ACL（`user_roles`、`active` かつ期限内）。`hybrid-rbac.md` の「認可は DB の ACL」に揃える |
| 要素を消した後の session | 失効しない | `deleteFactor` は「検証済みの要素を消すとき、利用者を全 session からログアウトさせる」と書く | － | 要素の状態に頼らず、自前と Auth の session を明示して全部失効させる。検証前の要素・0 件・自前の `sessions` の表もまとめて閉じる |

Shopify のスタッフの 2 段階認証のリセットで、監査にどこまで残すかは公式の文書で確かめられなかった（比べた根拠にしない）。

#### 決定

- 監査の `metadata` に残してよいのは `requested_user_id`（UUID の形の時だけ）・`target_role`・`deleted_factor_count`・`total_factors`・`delete_error_factor_ids`・`reason_length`・`reason_sha256` だけ。`reason`・`target_email`・`error_message`・`delete_errors[].message` は全部の分岐から外す。`reason_sha256` は前後の空白を除いた理由の SHA-256 の 16 進、`reason_length` はその長さ
- 本文の形の誤りの枝の `requested_user_id`・`resource_id` は、入力が UUID の形の時だけ残し、それ以外は空にする（確かめていない任意の長さの文字を監査に入れない）
- 誤りの文は `console.error` に回し、監査の `detail` は固定の文（`role_lookup_failed`・`target_not_privileged`・`Failed to list target MFA factors`・`Failed to delete one or more factors`・`session_revocation_failed`）にする
- 対象の役割は `user_roles` を `roles!inner(code)` で、対象の id・`active`・期限内（`expires_at` が空か未来）で引き、`admin` か `supporter` があれば特権とする。引く誤りは 500。`app_metadata` は使わない
- 要素を全部消せたら、共有の部品 `revokeAllSessionsForUser` で対象の自前の `sessions` に失効の時刻を入れ、Auth の session を消す（要素が 0 件でも呼ぶ）。失効が失敗したら 500 と固定の文の監査を返し、消した要素は戻さない。要素は既に消えているので、再実行すると要素 0 件で失効だけをやり直せる（冪等）
- 要素の削除に 1 つでも失敗した時は、失効に進まない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 理由の文を監査に平文で残す（以前の形） | 個人の事情が保存の期限なしに残り、外の Webhook にも写る |
| 理由の文を暗号化して残す | 暗号の鍵の管理が別に要る。後で突き合わせたいだけならハッシュで足りる |
| 理由を一切残さない | 取り違えや悪用を後から確かめる手掛かり（長さと突き合わせ用のハッシュ）が無くなる |
| 対象の役割を `app_metadata` で決める（以前の形） | 権限を外された後も `app_metadata` が残り、断るべき相手・断らない相手を取り違える |
| 失効を要素の削除より先に行う | 失効だけ成功して要素が残ると、対象は入り直して古い要素で通れる。要素を消す方を先にし、失効は後で再実行できる形にする |
| 失効の失敗で要素を戻す | 消した要素を同じ物として復元する道がアプリには無い（登録し直しは本人の操作） |
| `deleteFactor` の暗黙のログアウトに頼る | 検証済みの要素を消した時だけの動きで、自前の `sessions` の表は対象外。検証前の要素のみ・0 件の時に取りこぼす |

#### 結果

- 良くなること: 監査と外の Webhook に個人情報が残らない。権限を外された人を取り違えない。リセットの後に奪われた session が生き残らない
- 悪くなること: 理由の全文は後から読めない（ハッシュと長さで突き合わせるだけ）。ハッシュはソルト無しなので、短い決まった言い回しの理由は候補の文を並べてハッシュすれば推測で当てられる（突き合わせのための選択で、避けるなら鍵付きの HMAC が要る）。失効の失敗は 500 になり、要素は消えたまま（再実行で閉じる）。店長が別の店長の2要素を消せることと、本人への知らせが無いことは変わらない（ユーザーの決め待ち）
- 見直す条件: 理由の全文を監査に残す要件が出た時（暗号化の保存を別に設計する）。店長どうしのリセットを止める時、本人へ知らせる時

## 未確認事項

- 本物の GoTrue で、リセットの後に対象の JWT が管理の窓口で 401 になるか（E2E `SEC-ADMIN-014-AC-02`。書いただけで未実行）
- `ALERT_AUDIT_URL` を設定する時の送り先と保存の期間（THR-ADMIN-008 の未確認事項）
