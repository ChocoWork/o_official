# 会計の仕訳の土台の運用（会計の作り直し 計画1）

> 状態: 運用手順（本番には未適用） | 確認日: 2026-11-08 | 対象: 移行 S0〜S5（`supabase/migrations/20261107130000` 〜 `20261107130500_accounting_p1_*.sql`）、仕訳を入れる関数、期間、手入力のトリガー、A8 の移しかえ、領収書の置き場

## 概要

計画1は会計の土台を DB に作る。権限6件を足し（S0）、会計の12表を `service_role` 専用に締めて領収書の種類と置き場を整え（S1）、仕訳と期間の表と書き手を作り（S2・S3）、手入力の取引を仕訳にするトリガーを足し（S4）、過去の取引を一度だけ移す（S5 = A8）。S2〜S5 は追記のみの表を作るので、当てた後に戻せない部分がある（仕訳は消せない）。本番へ当てる前に、普段の開発の接続先が手元の Supabase であることをオーナーが確かめる。

| 項目 | 内容 |
| --- | --- |
| 適用の順 | S0 → S1 → S2 → S3 → S4 → S5。ファイル名の順が適用の順 |
| 本番への当て方 | 下の「適用の手順（T16-1）」の2回。2回とも Supabase MCP の `apply_migration` で1本ずつ当てる（素の `supabase db push` と CI は使わない）。S4 の直後に S5 |
| 戻せるか | S0・S1 は戻せる（値を先に控える）。S2・S3 は仕訳・期間・設定の変更が無い間だけ。S4 は手入力の仕訳が無い間だけ。S5 は戻せない（直しは取り消しと正しい仕訳） |
| 先に済ませること | 本番の接続先の確認（下の「確認の記録」）。事前の読み取り（下の「本番の事前確認」） |
| 関連 | 仕訳の流れ: [会計の仕訳のシーケンス](../04_DetailDesign/sequence/accounting-journal.md)、期間: [会計の期間の状態](../04_DetailDesign/states/accounting-period.md)、移行の台帳: [DB 移行](db-migrations.md) |

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 対応要求 | FREQ-553（権限・表の権限・領収書の置き場）、FREQ-554（仕訳の土台）、FREQ-555（期間）、FREQ-556（手入力のトリガー）、FREQ-559（証憑の種類）、FREQ-560（A8）、FREQ-561（申告の期限） |
| 計画 | [会計の作り直し 計画1](../superpowers/plans/2026-11-04-accounting-p1-journal-foundation.md) |
| 調査時点 | 2026-11-08 のソース。手元の Supabase と使い捨てのコンテナで確かめた。本番の DB の状態は読んでいない |

## 移行ごとの目的と戻し方

| 移行 | 目的 | 末尾の検査（DETAIL） | 戻し方 |
| --- | --- | --- | --- |
| S0 `..130000_accounting_p1_permissions.sql` | 権限6件を足す（32 → 38）。店長だけに付ける | `acc_s0_permission_catalogs`・`acc_s0_permission_seed`・`acc_s0_existing_dml_allowlist` | 移行のファイルに戻しの文は無い。S1〜S5 を先に戻した後だけ（S3 の書き手が `admin.accounting.settings.manage` を確かめるため）。H1（`20261029130000`）の2関数の本体へ `CREATE OR REPLACE` し、`role_permissions`・`permissions` から6件を消す（外部キーで止まらない。`role_permission_events` の文字の記録は残る）。6件を消した役割の版を+1する（店長。画面でサポーターへ付けていればサポーターも）。アプリの目録（`admin-rbac.ts`・`role-permission-catalog.ts`・保存の上限、38 → 32）を同じデプロイで戻す（要レビュー） |
| S1 `..130100_accounting_p1_grants_receipts.sql` | 12表と8連番の `anon`・`authenticated` の権限を外す。`admin_finance_receipts` に `evidence_kind`・`paper_original_kept`。置き場 `finance-receipts` を非公開・20MiB・5形式に | `acc_s1_finance_table_acl`・`acc_s1_finance_seq_acl`・`acc_s1_bucket`・`acc_s1_receipt_columns`・`acc_s1_policies_unchanged` | 移行のファイルの先頭の ROLLBACK のとおり。適用前に読んだ権限・置き場の行の値へ戻す。種類の列を消すと適用後に記録した種類が消えるので先に書き出す。`public` は `true` に戻さない |
| S2 `..130200_accounting_p1_journal_foundation.sql` | 仕訳・期間・勘定の5表、仕訳を入れる関数・取り消しの関数、勘定163行（162＋`9999`） | `acc_s2_tables` ほか9つ | 仕訳が1件も無い間だけ、ファイル先頭の DROP の文。仕訳は消せない |
| S3 `..130300_accounting_p1_period_reads.sql` | 設定・期首の表、期間の作成・やめた日・設定・申告の設定の書き手、読み5つ、トリガー | `acc_s3_settings_row`・`acc_s3_period_layout_trigger`・`acc_s3_functions`・`acc_s3_rls_acl`・`acc_s3_reads_stable` | 期間・設定の変更・期首の行が残らない間だけ、ファイル先頭の DROP の文 |
| S4 `..130400_accounting_p1_manual_entry_journal.sql` | 手入力の取引を仕訳にするトリガー、分類・支払方法の写し、履歴の保護、履歴を書く関数の入れ替え | `acc_s4_map_table`・`acc_s4_trigger`・`acc_s4_functions`・`acc_s4_legacy_trigger_untouched` | 手入力の仕訳が無い間だけ、ファイル先頭の DROP の文。履歴の関数は `remote_schema.sql` の本体へ `CREATE OR REPLACE` で戻し、続けて `ALTER FUNCTION public.record_admin_finance_entry_revision() SET search_path = public, pg_temp;` も流す |
| S5 `..130500_accounting_p1_a8_migrate_manual.sql` | 削除されていない手入力の取引を `migrated_entry` として移す（A8） | `acc_s5_counts`・`acc_s5_numbering`・`acc_s5_revisions_unchanged`・`acc_s5_receipts_unchanged`・`acc_s5_triggers_unchanged` | 戻せない。誤りは取り消しと正しい仕訳で直す |

各移行は1本の取引（`BEGIN`〜`COMMIT`）で、末尾に自己検査を持つ。検査が崩れると全部戻る。失敗の詳細は固定の `DETAIL` の語だけ。

## 仕訳を入れる関数の使い方

呼べるのは `service_role` だけ（`anon`・`authenticated` は 42501）。窓口は INVOKER の `public.*`、本体は DEFINER の `private.*`。どちらも `admin.finance.manage` を持つ実行者（`_actor_id`）を要る。

| 関数 | 引数 | 使い方 |
| --- | --- | --- |
| `public.admin_post_accounting_journal` | `_actor_id`・`_period_id`・`_entry_date`・`_event_kind`・`_event_parts text[]`・`_description`・`_lines jsonb`・（`_source_table`・`_source_id`）。`_reverses_entry_id`・`_reason` は引数にあるが、値を入れると 22023 で断る。`_source_table` に `admin_finance_expenses` を入れても断る | 一般の仕訳を1本入れる。戻りは `{entry_id, entry_no, period_id, created}`。`created=false` は同じ印・同じ内容の再送 |
| `public.admin_reverse_accounting_journal` | `_actor_id`・`_entry_id`・`_reason`・`_entry_date`（省略は元の日） | 元の仕訳の借方・貸方を入れ替えた取り消しを入れる。日付は省略なら元の日、渡せばその日を含む期間（元の期間と同じ事業の形。個人で期間が無ければ暦年の期間を作る）に入る |

- `_lines` は2〜200行の配列で、行のキーは `account_code`・`debit`・`credit`・`sub_account`・`counterparty`・`order_id`・`memo` の7つだけ（他のキーは 22023）。金額は整数の JSON 数（文字列は不可、0〜2^53−1）。1行は借方か貸方の片方だけ。全行の借方の合計 = 貸方の合計。
- 印は `_event_kind`（27種）と `_event_parts` から作る（`stripe_fee` だけ前置きが `stripe:fee`）。要素は `[A-Za-z0-9_.-]{1,128}`。種類ごとの個数は [event-kinds.ts](../../src/lib/accounting/event-kinds.ts)。同じ印で内容が違うと 409。
- 日付は期間の中でなければならない（外は 409 `ACCOUNTING_DATE_OUT_OF_PERIOD`）。記録の時刻は入口から渡せず、DB が決める。遅れの印（`is_late`）は、日付の2か月後（日本時間）より後に記録された時に付く（移しかえは付かない）。
- この一般の入口を呼ぶ窓口は計画1には無い（計画2が使う）。手入力・移しかえ・期末の仕訳・取り消しには専用の種類があり、一般の入口からは入れない（`manual_entry`・`migrated_entry`・`period_closing_entry`・`closed_year_correction`・`reversal`）。一般の取り消しの入口は、専用の道具を持つ種類の元には使えない。
- 鍵は `(190521, 1)` → `(190525, 0)` → `(190525, hashtext(期間))` の順。一覧は `private.accounting_lock_all`。仕訳を書く新しい関数もこの順で取る。

## 期間の作り方

| 方法 | 内容 |
| --- | --- |
| 画面 | 設定・期間のタブの追加フォーム（`POST /api/admin/accounting/periods`）。権限は `admin.accounting.settings.manage` |
| DB | `public.admin_create_accounting_period(_actor_id, _business_type, _starts_on, _ends_on, _name, _request_key)`。名前の NULL は既定の名前。個人は暦年、法人は1年以内で前の期間の翌日から。重なり・すき間・1年超は拒む |
| 自動 | 手入力の取引の日に個人の期間が無い時だけ、暦年の個人の期間を作る（開業日の年〜今年の翌年。やめた日より後の年は作らない） |

開業日（`business_start_date`）は一度入れたら選び直せない（入れ違いを防ぐため 2000-01-01 〜 今日の日本時間の1年後だけ受ける）。

## 取り消しの道具

- 画面から仕訳を取り消す入口は計画1には無い（権限 `admin.accounting.entries.correct` を使う入口は後の計画）。
- 一般の仕訳は `admin_reverse_accounting_journal` で取り消す。1つの元に取り消しは1本（二重は 409 `ACCOUNTING_ALREADY_REVERSED`）。取り消しは（日付を渡さなければ）元の日の期間に入り、説明・出どころを元から写す。
- 手入力の取引の取り消しは、取引の直し・削除に伴ってトリガーが入れる（直接は入れられない）。

## 手入力のトリガーの動き

詳細は[仕訳のシーケンス](../04_DetailDesign/sequence/accounting-journal.md)。運用で知っておくこと。

- 取引の追加・直し・論理削除は、窓口（`POST /api/admin/kpi/cost-profit`）が取引の行を書くだけで、同じ取引の中で仕訳ができる。期間が無い・範囲外などはトリガーが断り、取引の行ごと戻る（画面には固定の日本語の本文が出る）。
- 直しは「元の取り消し＋正しい仕訳」。印は `manual_entry:<取引の番号>:<n>`。
- 分類・支払方法が写し先に無ければ `9999` の行に入り、元の文字を行の `memo` に残す。`9999` に入った行は、後で正しい科目へ取り消しと正しい仕訳で直す。
- 取引・履歴の表を DB で直接 `DELETE`・`TRUNCATE` しない（拒まれる）。

## A8 の適用の手順と戻し方

### 適用の手順（T16-1）

Ruling T16-1 (refines C11): Task 16 applies in two pushes — (1) S0–S3 first; (2) run ALL S5 stop pre-checks read-only on production (task-13-report's 9 checks + earliest live expense year ≥ 2025 when start date NULL + max(created_at) ≤ now + category listing incl. 開業費 0 rows); (3) owner confirms no admin expense writes; (4) push S4+S5 together; if S5 fails, nobody edits expenses (S4 alone posts only on writes), fix S5 and push again — because db push commits each file separately and an S4-only state + any write would make S5 stop permanently (M-4) — cost if wrong: manual reconciliation decision needed.

意味: 1回目で S0〜S3 を当てる。続けて下の「本番の事前確認」をすべて読み取り専用で流す。管理者が会計の取引を書いていないことをオーナーが確かめてから、2回目で S4 を当てて続けて S5 を当てる。S5 が失敗したら、直して S5 を当て直すまで誰も取引を書かない（S4 だけの状態で取引を書くと、S5 が `acc_s5_counts` で永久に止まる）。2本を別の日に分けない。

当て方（Ruling T15b-apply）: 2 回とも Supabase MCP の `apply_migration` で 1 本ずつ当てる。1 回目は S0 → S1 → S2 → S3、2 回目は S4 の直後に S5。`name` はファイル名の版（`20261107130000_` など）を除いた部分に合わせ、`query` はファイルの全文にする。素の `supabase db push` と CI（master への push で動く `db-migrations.yml`）は、この 6 本には使わない。6 本を一度に当てるため、S5 で止まると T16-1 が避けたい「S4 だけ」の状態が残る。返品の `20261108120000` が先に本番へ当たっていても、この当て方なら止まらない（MCP は版を当てた時刻で付けるので、S0〜S5 のファイルの版が本番の最新より古くても関係しない。素の `db push` ならその時点で止まる）。当てた直後に `list_migrations` で記録された版を見て、[DB 移行](db-migrations.md)の「MCP の apply_migration で当てた場合」の決まりでファイル名の版を付け直し、`schema_migrations` の文の `md5(statements[1])` をファイルと突き合わせる。付け直すと手元の `db reset` の適用順が変わりうるので、付け直した後に `db reset` が通ることも確かめる。付け直したら、ファイル名を固定で書いた試験と文書の参照も同じ版にそろえる（`grep -rn 20261107130 tests e2e docs` で拾う）。S0〜S5 のコミットの master への push は、当て終えて版を付け直した後にする（先に push すると、CI が動いた場合に 6 本が一度に当たる。今は CI が `supabase link` で落ちているが、当てにしない）。

### 本番の事前確認（読み取りだけ）

1. `select count(*) filter (where deleted_at is null) as live, count(*) filter (where deleted_at is not null) as deleted, count(*) as total, min(expense_date) filter (where deleted_at is null), max(expense_date) filter (where deleted_at is null), max(created_at) from public.admin_finance_expenses;` を控える。生きている行の数の見込みは18（削除済みを含む総数ではない）。最初の日の年が2025以上であること（開業日が未入力の時）、`max(created_at)` が今以前であること。
2. `select count(*) from public.admin_finance_entry_revisions;`（見込み25）と `select count(*), count(*) filter (where evidence_kind <> 'unconfirmed') from public.admin_finance_receipts;`（見込み8件。S1 の後は `unconfirmed` 以外が 0 件）。
3. `select fiscal_year, business_type, opening_cash, accounts_receivable, fixed_assets, accounts_payable, opening_capital from public.admin_finance_years;` — 法人の年が無く、期首の5列がすべて 0。違えば S5 が止まる（オーナーに尋ねる）。
4. `select count(*) from public.admin_finance_year_closings;` — 0。
5. `select * from public.accounting_settings;`（S3 の後）— 開業日は NULL か、その年が最初の生きた取引の年以前。個人事業を終えた日は NULL。事業の形は個人。最後の生きた取引の年が今年（日本時間）+1 以下。
6. `select count(*) from public.accounting_journal_entries; select count(*) from public.accounting_periods;` — 0 と 0（番号を1から振る前提）。
7. `select tgenabled from pg_trigger where tgrelid = 'public.admin_finance_expenses'::regclass and tgname = 'trigger_admin_finance_entry_revisions';` — `O`。
8. `select category, payment_method, entry_type, count(*) from public.admin_finance_expenses where deleted_at is null group by 1,2,3 order by 1,2,3;` を S4 の写し（`ACC_MANUAL_MAP` の行）と照らす。分類にも支払方法にも `開業費`（`U&'\958B\696D\8CBB'`）の行が 0 件であること（あれば S5 が `a8_startup_cost_category` で止まる。先にオーナーが決める）。直接の確認: `select id, expense_date, category, payment_method from public.admin_finance_expenses where deleted_at is null and (category = U&'\958B\696D\8CBB' or payment_method = U&'\958B\696D\8CBB');` — 0 行。`9999` に入る行と資産・在庫の分類の行も控える（S5 は S4 の規則のまま移し、直しは移した後に取り消しと正しい仕訳で行う）。
9. S4 と S5 を `apply_migration` で続けて当て、その間に管理者が取引を編集しない（S5 の途中で履歴だけが増えると `acc_s5_revisions_unchanged` で S5 が戻る。安全だが再実行になる）。

### 成功の確認

- S5 の NOTICE（`acc_s5_counts moved=<n> deleted_not_moved=<n> ...`）の `moved` が事前確認1の生きた行の数、`deleted_not_moved` が削除済みの行の数と等しい。
- `select count(*) from public.accounting_journal_entries where event_kind = 'migrated_entry';` が生きた行の数と等しい。
- `admin_finance_expenses`・`admin_finance_entry_revisions`・`admin_finance_receipts` の行の数が事前確認の値のまま。
- `supabase_migrations.schema_migrations` に S0〜S5 の版が載り、文の md5 がコミットしたファイルと一致する（[DB 移行](db-migrations.md)の照合の書き方）。
- 画面の帳簿（仕訳帳）に、移した仕訳（`migrated_entry`）が読めて出る。確かめのためだけに本番で取引を足したり直したりしない（S4 の後は仕訳と取り消しの行が消せずに残る）。手入力の取引が仕訳に出ることは、次の本物の取引で確かめる。

### 戻し方

S5 に戻しは無い。仕訳の誤りは取り消しと正しい仕訳で直す。S4 を外すのは手入力の仕訳が1件も無い間だけ。S5 が止まった時は、取引の書き込みを止めたまま原因（`DETAIL` の語）を直して S5 を `apply_migration` で当て直す。

## 領収書の置き場

- 置き場 `finance-receipts`: 非公開、1ファイル 20MiB（20971520 バイト）まで、形式は PDF・JPEG・PNG・WebP・HEIC の5つ。`storage.objects` にこの置き場を名指しする方針は置かない（`anon` と一般の管理者の JWT からは読み書きできない。画面は署名付きの URL を使う）。
- 適用前に既に同じ名前の置き場があるときは、S1 の先頭の読み取りの文で行の値を控える。20MiB を超える既存のファイルと他の形式のファイルはそのまま残り、新しい上げ下ろしだけが断られる。
- 領収書の種類は `evidence_kind`（`electronic`・`paper`・`unconfirmed`）と `paper_original_kept`（紙だけ。ほかは NULL）。既存の行は `unconfirmed` のまま。画面は「種類を確かめてください」を出す。route は `unconfirmed` を書かない。

## 個人の最後の期間の登録・選び直しと再作成を防ぐ規則

- 事業をやめたら、年が変わる前、かつ事業の形を法人へ変える前に、設定・期間のタブの「事業をやめた日を登録する」（`POST /api/admin/accounting/periods/[id]/final-sole`）で、最後の個人の期間のやめた日を登録する。
- 登録済みの日より後の日付の取引は、事業の形が個人のままなら断られる（法人の期間が無いか、法人へ切り替えるまで）。個人の期間は黙って作られない。
- 翌年以降の個人の期間が先にできてしまうと、やめた日を登録できない（`ACCOUNTING_PERIOD_SHORTEN_BLOCKED`）。翌年の日付の取引を書く前に登録する。
- 選び直しは理由が必須。縮める時は、その日より後に仕訳（取り消しを含む）が無いこと。12月31日までは延ばせる。記録は設定の `sole_end_changes` に追記される。
- 規則の全体は[会計の期間の状態](../04_DetailDesign/states/accounting-period.md)。

## 本番適用前の普段の開発の接続先のオーナー確認

理由: 会計の移行を本番に当てると、消せない仕訳・期間が本番に残る。普段の開発（`npm run dev`）が本番の DB のままだと、開発中の操作が本番の仕訳を作ってしまう。本番に当てる前に、`npm run dev` が手元の Supabase を向いていることをオーナーが確かめる。

- 確かめるのはオーナー。Claude と書き手は環境変数の値を読まない。
- 記録するのは確認した日と、確認済みかどうかだけ（接続先の住所・鍵・環境変数の値は書かない）。

| 確認日 | 確認済み |
| --- | --- |
| 未（本番への適用の直前に記入する） | いいえ（未確認） |

済むまで S0〜S5 を本番に当てない。

## 運用の注意

- E2E の後に DB 結合を流すときは `npm run db:reset` を挟む。E2E の FR-ADMIN-128 は手元の DB に開業日、個人事業を終えた日（一度入れると戻せない）、空きの個人の期間（約60件）を残す。DB 結合は期間の前提が崩れて `ACCOUNTING_PERIOD_MISSING` などで落ちる。DB 結合の後の E2E も `db reset` してから流す（コミットする試験が仕訳・期間を残す）。
- 仕訳・期間・設定は消せないので、手元の DB を戻すには `npm run db:reset` を使う（本番では使えない）。
- 設定・期間のタブの申告の期限のうち、地方税の延長の注記（「都道府県・市町村への申請が別に要ります」）は税理士の確認待ち。確認が済むまでは目安として扱う。
- 祝日の表は内閣府の公表（1955〜2027年）。2028年以後は表が無く、繰り下げずに目安として出る。令和10年分の公表（令和9年2月予定）の後に [jp-holidays.ts](../../src/lib/accounting/jp-holidays.ts) へ足す。

## 未確認事項

- 本番の DB の状態（表の権限・置き場・取引の件数・分類の一覧・期首の列・締めの行）は読んでいない。上の事前確認で確かめる。
- 手元の Supabase での公式の実行（DB 結合・コミットする試験）は、調整役の担当で、使い捨てのコンテナで流した分と区別する。
- 接続先のオーナー確認は未記入。
