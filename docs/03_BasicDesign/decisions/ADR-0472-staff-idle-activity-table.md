# ADR-0472 店員の無操作の時刻は、`auth.sessions.refreshed_at` ではなく、アプリの表 `private.staff_session_activity` に持つ

> 状態: 推定 | 確認日: 2026-11-18 | 対象: `supabase/migrations/20261117001500_passkey_staff_entry_conditions_fn.sql`、`supabase/migrations/20261117013000_passkey_staff_entry_conditions.sql`

## 概要

店員の無操作1時間（設計 5-2 の条件）の時刻を、どこに持つかを決める。DB の表と関数は Task 3、窓口・ページの配線は Task 8・9。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-028、FR-AUTH-044、DATA-AUTH-021、ARC-AUTH-013、SEC-AUTH-055、THR-AUTH-054、DD-AUTH-074 |
| 対象のコード | `supabase/migrations/20261117001500_passkey_staff_entry_conditions_fn.sql`、`supabase/migrations/20261117013000_passkey_staff_entry_conditions.sql` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（5-2）、[段3の計画](../../superpowers/plans/2026-11-18-passkey-stage3-staff.md)、[無操作の DB の関数の詳細](../../04_DetailDesign/sequence/auth-staff-idle.md) |
| 調べた時点 | 2026-11-18（手元の Supabase で結合試験を流した） |

## 判断

### ADR-0472 店員の無操作の時刻は、`auth.sessions.refreshed_at` ではなく、アプリの表 `private.staff_session_activity` に持つ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-055 |
| 根拠 | `auth.sessions.refreshed_at` は GoTrue がトークンを更新した時にしか動かない。画面を使っているだけでは動かないので、無操作を測れない（使っていても切れる、または更新の間隔で延びる）。アプリが操作のたびに（60秒に1回まで）進める表なら、無操作そのものを測れる |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-11-18-passkey-stage3-staff/task-3-brief.md`、`docs/superpowers/plans/2026-11-18-passkey-stage3-staff.md`（Task 3） |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 無操作の上限 | 店員にはログインから24時間の上限だけ（条件2）。無操作の上限は無かった | 出典なし（社内の比較。管理画面のセッションが一定の無操作で切れる作りは知られているが、時間と測り方は確かめていない） | OWASP Session Management Cheat Sheet（https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html）の idle timeout（操作がない時間の上限をサーバー側で持つ）。NIST SP 800-63B-4 の reauthentication の考え方 | 無操作の上限をサーバー側（DB）で持つ。時刻は GoTrue の値ではなく、操作で進めるアプリの表 |

#### 決定

- 表は `private.staff_session_activity(session_id, user_id, last_seen_at)`。`session_id` を主キーにして、1セッション1行
- 判定は DB の関数 `private.staff_idle_ok` 1つ。行があれば `last_seen_at`、無ければ `auth.sessions` の時刻（`coalesce(refreshed_at AT TIME ZONE 'UTC', created_at)`）で、1時間を比べる
- 書き込みは `staff_session_touch`（60秒の間引き）。`staff_idle_check` は確かめと書き込みを1回の呼びで、`staff_idle_peek` は見るだけ（`/api/auth/me` が画面を開き直すだけで無操作を延ばさない）
- `auth.sessions.refreshed_at` は、行が無い時の代わりにだけ使う。理由: ログインの終わりを通らないセッション（E2E・手元の開発・DB 結合の JWT）と、書き込みが失敗した後でも、新しいセッションは1時間は通る。書き込みの失敗が永久の拒否にならない
- 変えるのは本番未適用の移行 D・E を同じファイルのまま直す形（新しい移行は作らない）

#### 結果

- 良くなること: `has_permission`（RLS）が無操作を直に見る。画面を使っている間は延び、離れれば1時間で切れる。見るだけの呼びで延びない
- 悪くなること: 操作のたびに60秒に1回、表への書き込みが増える。行が無い間（ログインの終わりの配線の前）は `auth.sessions` の時刻に頼る
- 残る危険: 行が無いセッションは1時間は通る（`auth.sessions` の時刻より後に使っても、行を書くまでは延びない）。書いた時に消す2日より前の行は、その人が次に書くまで残る
- 見直す条件: 書き込みが負荷になった時（間引きを伸ばす）、GoTrue が `refreshed_at` を操作でも進めるようになった時
