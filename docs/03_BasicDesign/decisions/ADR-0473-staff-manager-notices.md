# ADR-0473 店長への知らせは、送り箱に3つの種類を足して操作と同じ取引で積み、宛先は本人を除く有効な店長全員にする

> 状態: 推定 | 確認日: 2026-11-20 | 対象: `supabase/migrations/20261116215034_passkey_foundation_tables.sql`、`supabase/migrations/20261118044338_passkey_notification_sending.sql`、`supabase/migrations/20261118130000_passkey_staff_invites.sql`

## 概要

店長が店員を招待した・やり直した・降格した時の、ほかの店長への知らせの積み方と宛先を決める。DB の側は Task 14。送る処理と文面は DD-AUTH-087（Task 15）。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-029、FR-AUTH-047、DATA-AUTH-022、ARC-AUTH-012、SEC-AUTH-058、THR-AUTH-057、DD-AUTH-086、DD-AUTH-087 |
| 対象のコード | `supabase/migrations/20261116215034_passkey_foundation_tables.sql`、`supabase/migrations/20261118044338_passkey_notification_sending.sql`、`supabase/migrations/20261118130000_passkey_staff_invites.sql` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)、[段3b の計画](../../superpowers/plans/2026-11-19-passkey-stage3b-staff-ops.md)、[知らせの積み込みの詳細](../../04_DetailDesign/sequence/auth-staff-manager-notices.md) |
| 調べた時点 | 2026-11-20（手元の Supabase で結合試験を流した） |

## 判断

### ADR-0473 店長への知らせは、送り箱に3つの種類を足して操作と同じ取引で積み、宛先は本人を除く有効な店長全員にする

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-058 |
| 根拠 | 既に鍵の足し引きの知らせを送る仕組み（送り箱・取り出し・再試行・一時停止）があるので、新しい表は作らず種類だけ足す。操作と同じ取引で積めば、失敗した操作の知らせが残らず、成功した操作の知らせが欠けない。宛先を送る時に決めれば、停止・削除された店長に出ない |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-11-19-passkey-stage3b-staff-ops/task-14-brief.md`、`docs/superpowers/plans/2026-11-19-passkey-stage3b-staff-ops.md`（Task 14） |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 管理者の増減の知らせ | 店長が店員を招待・降格しても、ほかの店長に知らせは行かない | 出典なし（社内の比較。スタッフの追加や権限の変更を店のオーナーのメールに知らせる作りは知られているが、宛先と文面は確かめていない） | OWASP ASVS V7.1（ログと通知）と Authentication Cheat Sheet（https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html）の「重要な変更は利用者に通知する」 | 操作の取引で積み、ほかの有効な店長全員に送る |

#### 決定

- 種類は `staff_redo_issued`・`staff_invited`・`staff_demoted`。送り箱 `private.passkey_notification_outbox` の `kind` の `CHECK` に足し、列 `actor_email` を足す（DATA-AUTH-022）
- 積む処理は私用の関数 `private.passkey_enqueue_staff_notice` の1つ。`staff_invite_issue_core`（`redo`・`invite`・`promote`）と `staff_demote` が、錠の後の同じ取引で呼ぶ。`last_resort` は積まない
- 宛先は `passkey_notification_recipients` が送る時に決める。本人（行の `user_id`）を除く、有効・期限内・削除と停止の無い `admin` 全員。操作した店長は含む。`notify_subject` は新しい3種類では無視する
- 店長と店員の間（`admin`↔`supporter`）の役割の変更（`admin_set_user_role`）は知らせを積まない（計画の判断8・オーナーの答え4）
- 変えるのは本番未適用の移行 A・G・H を同じファイルのまま直す形（新しい移行は作らない）

#### 結果

- 良くなること: 店長が増減・降格を見落とさない。失敗した操作の知らせが残らない。積み込みが1か所
- 悪くなること: 操作の取引が知らせの行の1つ分だけ長くなる。店長が1人だけの時は、宛先は操作した本人だけになる（操作した店長も宛先に含むので、宛先なしにはならない。送る側が宛先なしを `skipped` にするのは、宛先が本人しかいない行と、有効な店長が1人もいない行）
- 残る危険: 知らせは対象の本人には出さない（本人を宛先から除く。降格された人には何も届かない。鍵は残り、ログインが終わるだけ。やり直し・招待の本人には、店員の招待のメールが別に届く）。店長と店員の間（`admin` と `supporter`）の役割の変更（`admin_set_user_role`。PATCH）は、設計どおり知らせを積まない（今の店員の役割の付け替えで、招待・やり直し・降格のどれでもないため。店長の増減を知らせたい時は別に決める）。送る処理が止まると知らせは溜まる（点検は Task 16・17）
- 見直す条件: 店長が多くなり、全員への1通ずつが重くなった時
