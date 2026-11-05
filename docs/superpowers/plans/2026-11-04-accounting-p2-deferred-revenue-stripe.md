# 会計の作り直し 計画2「前受金・出荷の日の売上・Stripe・受注高」実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支払い・出荷・Stripe の手数料と入金・カード会社からの支払いの取り消しを、起きた時に1本ずつ仕訳として保存する（支払いは「Stripe 未収金／前受金」、出荷した日に「前受金／売上高」）。今の画面が毎回作り直している注文の売上と Stripe の仕訳（計画1が残した合成）を、保存した仕訳に取り替える。仕訳にできない出来事は止めて「計上待ち」の一覧に出す。KPI の「売上」を「受注高」に改め、受注残と帳簿の売上高との照らし合わせを出す。本番に無い月の KPI の表 `admin_kpi_monthly_records` を移行で作る。

**Architecture:** 仕訳を作る係（計上係）を DB の関数にする。注文・発送票・Stripe の残高の取引・入金・dispute の行を読み、計画1の印（`buildEventKey` と同じ文字列）で1本ずつ `private.accounting_post_journal_core` に渡す。印が一意なので、何回流しても同じ結果になり、知らせの届く順番に頼らない。流す入口は `public.accounting_run_posting(_limit)` の1つ（service_role 専用、1回に処理する出来事は最大 `_limit` 件で、G の鍵を持つ時間を短くする）。呼ぶのは ①Stripe の知らせの処理の直後 ②発送票の確定・取り消し・日の直しの route の直後 ③銀行の着金の確認の直後 ④10分ごとの cron。支払いの仕訳が無い注文の出荷、注文の合計が合わない注文、切り替えの日より前の出来事などは、仕訳を作らず `accounting_pending_events`（計上待ち）に理由つきで置き、直った時に係が自動で入れる。出荷の仕訳は、送った品1着ごとの支払額（割引後）から出荷前の返金を引いた額を、番号の若い着から割り当てて作り、どの着を送ったかを表に残す。G の表（発送票・出荷・返金・返品）・Stripe の既存の表にはトリガーも列も足さない（G-3 の試験が列とトリガーを名前で固定しているため）。

**Tech Stack:** 現行の Next.js `^16.3.6`、React `^19.0.0`、TypeScript `^5`、Supabase Postgres 17・PostgREST、Zod `^4.3.6`、`pg`、Stripe SDK（現行の版）、Jest、React Testing Library、Playwright。依存を増やさない。

**Spec:** [承認済みの設計](../specs/2026-11-03-accounting-redesign-design.md)の 2章・4章・6章・8章、1章のうち 1-a01〜1-a03・1-a10〜1-a17（1-a17 の原価・在庫は計画5）・1-d の「支払いの仕訳が無い注文の出荷を待っている一覧に止める」、7章の 7-b・7-h・7-i〜7-i5、3章の 3-h、16章のうち範囲に関わる行を正本とする。[計画1](2026-11-04-accounting-p1-journal-foundation.md)が作る物（仕訳の表・入れる関数・印・期間・権限）を使う。[今の作りの地図](../../../.superpowers/sdd/2026-11-04-accounting-redesign/recon-report.md)と `recon-part-A.md`〜`recon-part-D.md` は現状と file:line の手掛かり。形式は計画1と [H の計画](2026-10-29-group-h-promotions.md)を引き継ぐ。設計で決まったことは変えない。決められない所は末尾「未確認事項」に置く。

## 概要

確認日 2026-11-04、基準 `master / da0a6336`（計画1が書かれた時点。計画1の実装は未着手）。この文書を書く作業は計画だけで、実装・DB・provider・ブラウザーの成功を表さない。graphify の既存グラフ（36086 ノード）で入口を確かめたが、グラフはその後の編集より古い可能性があり、結論はソースを直接読んで確かめた。

### 7本の計画の中の位置

地図は計画1の「7本の計画の地図」のとおり。計画2は、計画1が作った物の上に載る。

| 計画1から使う物 | 計画2での使い方 |
| --- | --- |
| `private.accounting_post_journal_core`（印・借貸の一致・期間・採番・取り消しの検査） | 計上係の全部の仕訳の入れ口。直接 INSERT しない |
| `private.accounting_reverse_journal_core`、`private.accounting_period_for`、`private.accounting_jst_date`、`private.accounting_lock_all` | 出荷の取り消し・日の直し、日の変換、ロック順 |
| `buildEventKey` / `private.accounting_event_key`（27種の印） | 係が付ける印。計画2は新しい種類を足さない |
| `accounting_periods`・`accounting_settings`（`cutover_on`・`current_business_type`）・`consumption_tax_status` | 期間の決め方、切り替えの日より前を止める、手数料の税の分け方 |
| 権限6件（`admin.accounting.settings.manage` ほか）と `admin.finance.read/manage` | 新しい権限は足さない。選び方は各 Task に書く |
| `ACCOUNTING_ERRORS`・`AccountingStoreError`・route の順序（認可 → CSRF → 回数 → zod → DB → 監査） | 同じ型と順序を使う。コードは Task 10 で足す |
| 画面の分割（`use-cost-profit-model.ts` と各 View）・`COST_PROFIT_TABS`・`mergeJournalEntries` | 新しい View を足す。仕訳の合成を保存した仕訳に取り替える |
| 計画1の S0〜S5 が本番に当たっていること | 計画2の本番適用の前提（Task 16）。計画1 Task 16 Step 0 の接続先のオーナー確認も引き継ぐ |

**計画2が受け持たない物:** 返金・返品の出来事（1-a04〜1-a09・1-a22）と、返金・返品の SQL 関数（`begin_order_refund_core`・`record_order_refund_result`・`admin_receive_return`・`admin_refund_return` など）の手入れは計画3だけが行う。計画2は返金・返品の関数を変えない。読む口が要る所は新しい読む関数を作る。原価・在庫（1-a17 の原価、9・13章）は計画5。締め・書き出しは計画6。

| Task | 中身 | 移行 | FREQ | 検証 |
| --- | --- | --- | --- | --- |
| 1 | 計上の土台の表（計上待ち・送った着の記録・返金の割り当て）と割り振りの道具 | S6 posting_tables | 562・563・569 | DB/単体 |
| 2 | 支払いの仕訳（1-a01・2-a・4-a） | S7 payment_posting | 562 | DB/並行 |
| 3 | 出荷の仕訳・取り消し・日の直し（1-a02・1-a03・2-b〜2-i・6-a・6-b） | S8 shipment_posting | 563・564 | DB/並行 |
| 4 | Stripe の手数料・税額調整・入金・着金・入金の失敗・残高の補充・照合 | S9 stripe_posting | 565・566 | DB/単体 |
| 5 | カード会社からの支払いの取り消しの受け取り（表・Webhook・同期） | S10 dispute_intake | 567 | DB/単体 |
| 6 | 支払いの取り消しの仕訳・設定・保留の読み口・計上係の入口 | S11 dispute_posting | 568 | DB/並行/PostgREST |
| 7 | 受注高・受注残・前受金の確認・照らし合わせの読み口 | S12 intake_reads | 569・571 | DB |
| 8 | 月の KPI の表 `admin_kpi_monthly_records` | S13 kpi_monthly_records | 573 | DB/単体 |
| 9 | 出荷の年末の照合と運送会社の受付日の照合 | S14 year_end_shipments | 574 | DB |
| 10 | 計上係の呼び出し（store・cron・各 route の直後）と計上待ちほかの route | — | 562〜569・574 | 単体 |
| 11 | 画面（計上待ち・照合・設定・仕訳帳の列・前受金の確認・年末の出荷） | — | 564・566・568・569・574 | RTL |
| 12 | 注文の売上と Stripe の合成を、保存した仕訳に取り替える | — | 570 | 単体/RTL |
| 13 | KPI の route と画面（受注高の名前と数え方） | — | 572・573 | 単体/RTL |
| 14 | 新しい E2E | — | 562〜574 | 本番 build/手元 DB |
| 15 | 文書の正本の更新（Stripe の購読の運用を含む） | — | 全部 | validate-docs |
| 16（controller） | 全体検証・最終 Opus レビュー・本番を読む・適用・記録 | — | 全部 | baseline 比較 |

**決めたこと（この計画の細部。設計の決定は変えない）**

- 移行は9本。`supabase/migrations/<ts6>_accounting_p2_posting_tables.sql`（S6）、`<ts7>_accounting_p2_payment_posting.sql`（S7）、`<ts8>_accounting_p2_shipment_posting.sql`（S8）、`<ts9>_accounting_p2_stripe_posting.sql`（S9）、`<ts10>_accounting_p2_dispute_intake.sql`（S10）、`<ts11>_accounting_p2_dispute_posting.sql`（S11）、`<ts12>_accounting_p2_intake_reads.sql`（S12）、`<ts13>_accounting_p2_kpi_monthly_records.sql`（S13）、`<ts14>_accounting_p2_year_end_shipments.sql`（S14）。時刻は計画1の S5 の後に controller が実装時に採番し、S6→S14 の順にする。適用済みの移行は編集しない。S6〜S14 は新しい表・関数・権限のほか、既存データを変えない（移行実行時の DML は、S14 の運送会社の受付日のオプションの初期行1行だけ。本番の注文は試しだけで0件のため、移しかえは無い。設計 0-4・2-j）。
- 計上係は DB の関数にして、何回流しても同じにする（印の一意制約が守る）。G の表・Stripe の既存の表・返金の関数にトリガーも列も足さない。読むだけ。例外は1つ: 発送票の確定と取り消しの2本の関数に、G の鍵の中で順番の番号を取る1行ずつを S6 で足す（Task 1。表・トリガー・列は足さない。2026-11-04 計画3の確かめ直し〔3回目〕の controller の決定）。理由: G-3 の試験が表の列とトリガーを名前で固定していること、返金・返品の関数の手入れを計画3に寄せる決定、出来事の順番に頼らない（1-d）こと。出来事の「起きた時に保存する」（1-b）は、①〜③の呼び出し（Task 10）で数秒以内に満たし、取りこぼしは cron が拾う。
- 仕訳を入れる口は `private.accounting_post_journal_core` と `private.accounting_reverse_journal_core` だけ。記録の人（`recorded_by`）は係が自動で入れるので NULL。登録した日時（`recorded_at`）は係が入れた時刻のまま。入力の遅れの印（`is_late`）は、設計 2-3 のとおり発送票を確定した日時（`shipment_slips.confirmed_at`）で決める: 計画1の core の `_source_recorded_at`（2026-11-04 に計画1へ足した）に `confirmed_at`（日の直しは `shipment_date_history.created_at`）を渡す。支払い・Stripe・dispute の仕訳は NULL を渡し、`recorded_at` で決まる。6-c の「登録した日」は、読み口が発送票の `confirmed_at` を並べて見せる（Task 3・11）。
- 計上の対象は、切り替えの日（`accounting_settings.cutover_on`）以後の出来事の日の物だけ。それより前の日の出来事は仕訳にせず、理由 `before_cutover` で計上待ちに置く（2-j・0-4。本番には無いはず）。
- 支払いの仕訳（1-a01）の額は Stripe の残高の取引の総額（手数料を引く前。4-a）。日は残高の取引の時刻を日本時間に直した日。注文の合計・1着ごとの支払額の合計・送料の欄と合わなければ仕訳にせず `amount_mismatch` / `order_not_postable` で止める（2-c）。
- 出荷の仕訳（1-a02）は発送票1枚に1本。行は品（`order_items`）ごとに「前受金（借方）／売上高（貸方）」の対。額は、その発送で送った着の1着ごとの支払額（割引後）の合計から、その着に当てた出荷前の返金を引いた額。送る着は、その品の「まだ送っていない着」の番号の若い順（2-h）。どの着が出荷済みかは Task 1 の道具 `private.accounting_shipped_units` が G の鍵の中で取った番号だけで決める（出荷の仕訳の有無では決めない）。出荷の仕訳が使った着は `accounting_shipment_units`（追記専用）に記録として残す。交換の品の行（`order_items.line_kind='exchange'`）は売上にしない（2-i・1-a17）。
- 出荷前の返金の割り当て（2-c の「その品に当てた出荷前の返金」）は、計画3が返金の時に `accounting_unit_refund_allocations`（計画2が空の表と読む側を作る）へ書く。計画3が書くまで、この表は空で、出荷の額は1着ごとの支払額そのままになる。計画3は、H が出荷前の返金として確保した着にその着の支払額を割り当て、品を決めない額は残りの値打ちの比でまだ送っていない着へ割り振る（出荷は番号の小さい着から取る今の順のまま。H の確保は、同じトランザクションで書く全額の割り当てを通して送る着から除かれる。2026-11-04 計画3の確かめから）。
- 店頭の売上（1130 の補助での振り分け、7-i・7-i4）は作らない。今は全部 1160 に入れる。支払いに結び付かない単独の手数料・調整も 1160（7-i2）。
- 返金・返品に関わる Stripe の残高の取引（`refund`・`payment_refund`・`refund_failure` など）の元本は計画3が仕訳にする。計画2の係は元本を飛ばし（計上待ちに置かない）、手数料の部分だけを 1-a10 として扱う。Stripe の残高との照らし合わせ（Task 4）は、この元本の差を「計画3で計上する種類」として名指しで示す。
- カード会社からの支払いの取り消し（4章）の「原因に合う科目」は設定に持つ（4-e）。設定が無い間は「仮払金（確定・科目の決定待ち）」＝ 1470 の補助 `dispute_confirmed_unassigned` に分けて置く。振り替え先の科目と消費税の区分は税理士と決める（16章）。
- 4-e3（判断待ちの注文の返金と出荷を止める）: 計画2は出荷の route と画面で止める（読み口 `public.get_order_dispute_holds`）。DB の関数の中で止める作りは、G-3/G-4 の出荷の関数と計画3の返金の関数を変えるので、計画2では行わない。返金と出荷の両方の DB の止めは計画3が作る（2026-11-04 controller の決定。計画1の地図の計画3の行に書いた）。
- 1-a14（残高のマイナスを銀行から引かれた）は、Stripe 側の記録の種類名も銀行の取引の番号も今は取れないので、画面からの手入力（Task 4・11）で1回だけ入れる。銀行の取引の番号は自由な文字列（空なら Stripe の取引の番号）で、印の一意で二重を止める。
- 1-a12 の銀行への着金の印には、銀行の取引の番号が無いので入金の番号（`po_…`）を使う（recon-part-C 1.7）。銀行の取引を取り込む仕組みができた時に差し替える。
- `list_shipment_accounting_inputs`（G-3、続きの目印なし）は変えない。計上係が DB の中で表を直接読み、1回に処理する件数を `_limit` で区切るので、この口で大量に読む必要が無い。G-3 の試験（`group_g3_reads`・`group_g3_date`・`group_g3_postgrest_paths`・`group_g1_writer_inventory`）は無改造のまま通す。年末の出荷の一覧（6-d）は新しい読み口（Task 9）で続きの目印つきにする。
- KPI は権限を足さない。KPI の route 4つは今のまま店長だけ（`authz.role !== 'admin'` で 403）。月の KPI の表の書き込みは `admin.orders.read`（route の既存の権限）で DB 関数が確かめ、店長の確認は route が行う。
- `admin_kpi_monthly_records` は、コードが使うのに移行にも本番にも無い（2026-11-04 に本番で確かめた）。今の動き: 月の記録のタブの読み取りは表が無くても空の値を返し（警告だけ）、保存は 503「月次記録テーブルが未作成です」で失敗し、Meta の同期（`src/lib/meta/sync-kpi.ts:206`）の書き込みも失敗する。8-a が月の記録の「売上額」を「受注高」に改め、月の記録の入力（手入力の上書き）も同じ画面に残すので、表を移行で作る（外さない）。Meta 連携の表（`admin_meta_kpi_connections` など）も移行に無い疑いがあるが、8章の範囲の外なので作らず、未確認事項 #6 に置く。
- CVR（注文数に対する支払い済みの割合）は、注文を作った月で数える（8-f の範囲外。私の判断）。客単価・LTV・リピート率・セット購入率・受注高は支払いを受けた日（4-a の仕訳の日）の月で数える。返品率は今の「取り消した率」の代わりのまま（8-1 のとおり範囲の外）。
- 取引管理の画面にあった、読み取り専用の注文の収入の行は、保存した出荷の仕訳（取り消しを含む）から1行ずつ作って出す（列は今と同じ。仕訳の日・額・読み取り専用）。画面の動きを変えないための私の判断で、オーナーが覆せる。
- Stripe の日付は日本時間の日（1-e・4-b）。入金の `arrival_date` が世界標準時の日付（`src/lib/stripe/accounting-sync.ts:188` の `slice(0,10)`）なのを、計画1の `toJstDate` で日本時間に直す（Task 4）。

- 2026-11-04 AI の判断（確かめ1回目の直し。オーナーが覆せる）:
  - 支払いの取り消しの「確定」は dispute 1つに1回。印は `[dispute,'confirmed','lost']` で、きっかけは「その dispute の履歴に `status='lost'` の行が1つでもある」（知らせの行でも毎晩の再照合の行でも同じ）。毎晩の再照合は、表に既にある最新の状態と同じなら履歴を足さない。確定・科目の決定待ちの振り替えも dispute 1つに1回（印 `[dispute,'assigned','1']`）。
  - Stripe の取引の種類の対応の鍵は `type`（`reporting_category` は補助。dispute の取引だけ `reporting_category` で見る）。dispute の知らせ5種の名前は Stripe の一覧にあるので決まりとし、Task 5 Step 4 は実機の確認として残す。`orders` に税の別欄は無い（税の欄は `checkout_drafts.tax_amount` だけ）。`orders.shipping_amount` の既定は500だが決済は0を入れるので、0でない注文は止める。
  - 送った品と数の正は、設計 2-3 のとおり発送票の明細 `shipment_slip_lines`。発送ごとの `order_fulfillment_lines` の品ごとの数量と食い違えば、理由 `shipment_lines_mismatch` で止める（設計を変えない）。前受金の残りと受注高の出来事の一覧は、元の仕訳も取り消しの仕訳も全部の行を足す（取り消しは符号が逆で打ち消し合う。「取り消された元を外す」扱いは併用しない）。
  - 引かれた額は `A = -amount`（代金。`net` は使わない）。手数料の税は、仕訳の日が期間の `consumption_taxable_from` 以後の時だけ課税。
  - 計上待ちの「確認済み」にできるのは、新しい帳簿の外の出来事の理由か、額が0の理由（`before_cutover`・`no_revenue`）だけ。お金の動く出来事（支払い・カード会社の取り消し）は、仕訳が入るまで閉じられない。手で仕訳を入れる route と画面（計画1の一般の入口を使う物）は計画2では作らない（オーナーの報告に載せる）。
  - 係の候補は、新しい出来事（印が無く、計上待ちにも無い物）を先に `_limit` 件まで取り、未解決の計上待ちは `last_detected_at` の古い順に別枠で1回10件だけ見直す。`has_more` は入れた・新しく止めた件数で決める。webhook の worker は1回の処理の終わりに1回だけ係を呼ぶ（知らせ1件ごとには呼ばない）。
  - 10分ごとの cron の登録 SQL は `supabase/pending/schedule_accounting_post.sql` に置く（既存の定期処理と同じ置き場）。`ops_job_heartbeats` の job 名は `accounting_post` で、S6 が CHECK を作り直して足す。

- 2026-11-04 計画2の確かめ直し（1回目）から直した: ①確定は引かれた時の仕訳がある時だけ入れ、無ければ `dispute_withdrawal_missing` で待つ。振り替える額は補助の今の残高で、遅れた取り下げの貸方はその dispute の S が今ある科目。②送った品と数の正を設計 2-3 のとおり `shipment_slip_lines` に戻し、食い違えば `shipment_lines_mismatch`。③出荷の仕訳の遅れの印は発送票の `confirmed_at` で決める（計画1の core に `_source_recorded_at` を足した）。④カード会社の取り消しの出荷済み・未出荷は、発送票の `confirmed_at` と引かれた取引の時刻の前後で決める。⑤係の候補は SQL の条件で絞り、飛ばす取引が新しい出来事を邪魔しない。⑥「確認済み」にできる理由の言い方を「新しい帳簿の外の出来事」に直した。計画1は、`accounting_period_for_event` の置き場を Task 7 にそろえ、`_source_recorded_at`・印の表・store の引数を直した。

- 2026-11-04 計画2の確かめ直し（2回目）から直した: 支払いの取り消しの仕訳を、届く順で額が変わらない5つの規則で書き直した。①段の順と待ち（W→C・R→X・L。前の段が済むまで `dispute_withdrawal_missing`、W は先に確定した発送票の出荷の仕訳を待つ `dispute_shipment_pending`）。②額は補助ごとの今の残高から（前受金に戻す分は W の行から）。③戻りの取引1件に仕訳1本（印 `[dispute,'reversal',取引の番号]`、L か R かは履歴の lost の有無と C の済み具合で決める。3回目で、決着の後に Stripe 側の時刻で決める形に直した）。④L の貸方は S が今ある科目（設定の科目・X の科目・補助。S=0 なら前受金だけ。4回目で、補助の時は X を待つ形に直した）。⑤全部の順番の試験 `FREQ-568-AC-07`。あわせて入金の失敗の自動解決を `failed`/`canceled` かつ `paid_at` NULL に絞り、計画1の `_source_recorded_at` を core だけの引数にした。

- 引かれた後に発送票を取り消した時（2026-11-04 AI の判断）: W の S と U は変えず、出荷の取り消しの仕訳が 2150 を戻すだけになる（引かれたお金の分の前受金が残る）。4-e3 で判断待ちの注文の出荷を止めるのと同じく、取り消しを画面で止めるか知らせるかは controller が決める。
- 遅れた取り下げの印（2026-11-04 AI の判断）: 設計 1-a16 は「dispute の番号＋遅れての取り下げ＋戻りの取引の番号」だが、計画は R と L を `dispute_event` の `[dispute,'reversal',戻りの取引の番号]` の1つにした。理由は、同じ戻りの取引に R と L の2本が入らないようにするため（どちらにするかは入れる時に規則3で決める）。設計の行の書き足しは未確認事項 #12。
- 2026-11-04 計画2の確かめ直し（3回目）から直した: 中-1 の決め方は次のとおり。戻りの取引は dispute が決着（`won`・`lost`・`warning_closed`、または履歴に lost の行がある）するまで、既存の理由 `dispute_withdrawal_missing`（お金の動く理由で手では閉じられない）で待つ。決着の後に、戻りの取引の `stripe_created_at` と lost の時刻（lost の行の Stripe 側の出来事の時刻 `stripe_event_created_at` の最も古い物。こちらが受けた時刻 `occurred_at` ではない）を比べ、後なら L、同じか前なら R。どの lost の行にも Stripe の時刻が無い時だけ、lost の行の `occurred_at` の最も古い物を lost の時刻とみなす。確定の日も lost の時刻の日にし、確定は lost の時刻より前の R を待つ。戻りの取引1件に仕訳1本（規則3の印）は変えない。あわせて、①カード会社の取り消しの出荷済み・未出荷を、発送票の `confirmed_at`・`cancelled_at` と引かれた取引の `stripe_created_at` の比べだけで決め、待つのは `stage='confirmed'` の発送票だけにした（中-2）。②`FREQ-568-AC-07` の表を、事実と人の操作で場合を分けて13行にし、年ごとの利益の列と届く順ごとの本数を書いた（中-3）。③戻りの S と U の分け方を、戻りの取引の時刻の順の累計の式にした（小-3）。④振り替え（X）の日を確定の仕訳の日にした（4-e。年ごとの利益を X の操作の日で変えないため）。⑤計画1の取り消しの一般の入口から `_source_recorded_at` を外した（中-4）。
- 2026-11-04 計画2の確かめ直し（4回目）から直した: ①lost の時刻に使う Stripe の時刻は、出来事の中身の状態が lost の時だけ入れる（遅れて処理した前の知らせの時刻で確定の日が早まらない。中-1）。②確定が補助に置かれ振り替えがまだなら、遅れた取り下げは `dispute_withdrawal_missing`（`dispute_account_unassigned`）で振り替えを待ち、振り替えの科目から戻す。設定が入るまで待ち続け、手では閉じられない（中-2。未確認 #11 は外した）。③Task 7 は確定の日と R か L かを、入った仕訳の日・`no_revenue` の行の `lost_on`・戻りの仕訳のメモで読む（小-2）。④終わりの状態の突き合わせを未確認 #9 に、出来事の一覧を探すページの上限と DB の試験を Task 5 に足した（小-1・小-3）。

- 2026-11-04 計画3の確かめから直した: 出荷前の返金の割り当ての表を符号つきにし（`amount <> 0`、戻しは `release:` の負の行、書き直しは `reapply:` の正の行、合計は 0 以上・`paid_amount` 以下）、出荷の仕訳に結ばれた着への負の行も断る。送る着の選び方から全額の割り当てを受けた着を除く（計画3は割り当てを番号の大きい着から詰める）。

- 2026-11-04 計画3の確かめ直し（1回目）から直した: 送る着から H が出荷前の返金として確保した着も除く。`accounting_record_unit_refund` の『結ばれた着』を G で取り消されていない発送票の着に限り、負の行の範囲を `reapply:` を含めた形にそろえた。

- 2026-11-04 計画3の確かめ直し（2回目）から直した: 『出荷済みの着』を G の事実の時刻で決める道具 `private.accounting_shipped_units(_order_item_id, _as_of)` を Task 1 に足し、送る着・W の値打ち・`accounting_record_unit_refund` の検査がそれを使う形にした（出荷の仕訳の有無で決めない）。

- 2026-11-04 計画3の確かめ直し（3回目）から直した: 出荷済みかどうかを時刻（`now()` の `confirmed_at`・`cancelled_at`・`created_at`）で比べず、G の鍵の中で取る番号で比べる。番号の決め方は次のとおり。①番号は1本の sequence `private.accounting_g_fact_seq` から取る（S6）。②取るのは G の鍵 `pg_advisory_xact_lock(190521,1)` を持っている間だけで、取る道具 `private.accounting_take_g_fact_seq()` が鍵を確かめる（鍵はコミットまで外れないので、番号の順＝鍵の順＝コミットの順）。③置き場所は、発送票の確定と取り消しの事実の表 `accounting_g_slip_facts.fact_seq`（S6 が確定と取り消しの関数に1行ずつ足して、状態を変えた直後に取る）と、割り当ての表 `accounting_unit_refund_allocations.fact_seq`（`accounting_record_unit_refund` が書く時に取る）。計画3は返金の状態の履歴と移した差の表にも同じ番号を取る。④道具は `private.accounting_shipped_units(_order_item_id uuid, _as_of_seq bigint)` にし、`_as_of_seq` が NULL なら「今（見えている全部）」。⑤Stripe の時刻と比べる W だけは、番号を取った時の `clock_timestamp()`（`locked_at`）から番号に直す道具 `private.accounting_g_fact_seq_at` を使う。あわせて、W の値打ちを計画3の 5-g の重みと同じ1つの式（道具 `private.accounting_unit_values` の『支払額 − 番号までの割り当て』）にし、出荷の仕訳とのつながりで出荷済みを決める古い文を消し、「H の確保」は同じトランザクションの全額の割り当てを通して除かれると書き直した。

- 2026-11-04 計画3の確かめ直し（4回目）から直した: ①確定と取り消しの2本の本文の比べ（`acc_s6_g_body_unchanged`・`FREQ-563-AC-03`・`group_g4_foundation` の `FREQ-540-AC-14`）を、初めから `-- ACC_P<数字>_BEGIN/END` の囲みを全部除く1つの式にした。計画3の S19 が `ACC_P3` の囲みを足しても、この確かめと試験は直さずに通る。②W の番号 N は、係が G の鍵を持ってから数えるので、まだコミットしていない取引を見落とさない。残る時計の差の隙は未確認事項 #13 に、起きる条件と出る物を書いた。

- 2026-11-05 計画6の願い（entry_date）を入れた

- 単独の手数料も候補に入れ、出来事1件ごとに失敗を捕まえて保留し、ほかの出来事へ進む。本番適用は計画1の普段の開発の接続先のオーナー確認を引き継ぎ、S6 前に確定・取り消し済みの発送票を件数だけで確認する。
- 2026-11-05 全体の最終レビュー（final-review-p1-p2）の指摘を入れた。

## 計画1への直しの願い（確かめ1回目の結果）

計画1は未実装なので、実装前に取り込む。確かめ1回目で次のとおりにした。

| # | 計画1の場所 | 結果 |
| --- | --- | --- |
| 1 | Task 6 の core の記録の人 NULL | 要らない。計画1の core は権限を確かめず、`recorded_by` は NULL を許すので、自動の計上はそのまま通る。計画2は試験（`FREQ-562-AC-01: 記録の人がNULL…`）だけ置く。計画1の関数を計画2が書き換える道は作らない |
| 2 | Task 7 と Task 9 の「期間の決め方」 | 計画1を直した（2026-11-04）。`private.accounting_period_for_event(_date date,_actor_id uuid DEFAULT NULL)` を計画1の Task 7 の道具に置き、規則の正本も Task 7 だけにした。Task 9 のトリガーもこれを呼ぶ。計画2はこの道具を呼ぶだけで作らない。計画2の試験（`FREQ-569-AC-05`）は期待の答えの表と比べる（トリガーと同じ答えの試験は計画1の Task 9） |
| 3 | Task 7 の `list_accounting_journal` と Task 8 の route | 計画1を直した（2026-11-04）。続きの目印を `(entry_date, entry_no)` の組にした。計画1 Task 10 からその組で最後まで読み、計画2 Task 12 も上限と取得が途中の時の拒否・表示を引き継ぐ |
| 5（確かめ直しで追加） | 計画1の core・取り消しの core・見出し・印の表・store・fixture | 計画1を直した（2026-11-04）。`_source_recorded_at`〔core と取り消しの core だけ。仕訳と取り消しの一般の入口は持たない。見出しの列 `source_recorded_at` に `least(_source_recorded_at, recorded_at)` を残し、型と読み口にも出す〕、印の表の固定の語（`lost`・`1`）と戻りの `reversal`、store の `afterEntryDate`・`afterEntryNo`、`accounting_period_for_event` の記録の人の引数、fixture の `sourceRecordedAt`。計画2は core を直接呼ぶ係でだけ使う |
| 4（controller への願い） | 計画1の「7本の計画の地図」の計画3の行 | 計画3の行に「4-e2 の返品の返金待ちとの相殺の仕訳（確定した日に未払金／仮払金、返金済みを超える額だけ振り替え）と、4-e3 の返金と出荷の DB の中の止め」を足してほしい。計画2は両方を作らず、`dispute_refund_overlap`・`dispute_return_refund_pending` で止め、出荷は route と画面で止める。controller が計画1の地図の計画3の行に足した（2026-11-04）。返金と出荷の両方の DB の止め（出荷の確定の関数の手入れを含む）と相殺の仕訳は計画3が作る。設計 4-e3 が DB の止めを求めるため、G の関数を変えない形（計上係だけが止める）は採らない |

## Global Constraints

計画1の Global Constraints を全部そのまま当てる。違う所は次の3つだけ。

- 要件の FREQ の番号と E2E の番号は、計画1が使った最後の番号の次から。FREQ は 562〜574（計画1は 553〜561、現在の最大は 552。実装時に別セッションとの重なりを確かめる）。E2E のファイルは `e2e/FR-ADMIN-132-…` から（計画1は 128〜131、現在の最大は 127）。試験の題は `FREQ-NNN-AC-NN: …` で始める。
- 本番への適用の Task（最後の controller の Task 16）の前提: 計画1の移行（S0〜S5）が本番に当たっていること。計画1 Task 16 Step 0 の接続先のオーナー確認（普段の開発は手元の Supabase。環境変数の値は Claude・書き手が読まない）が済むまで本番に当てない。
- 本番の注文は試しだけで0件（設計 0-4）。本番の Stripe の残高の取引を今の仕組み（`stripe-backfill`・`stripe-reconcile`）で読む所は、本番では読むだけにする。本番で `stripe-backfill` を流さず、本番の DB に試しの仕訳・期間・Stripe の行を作らない。

計画2で足す決まり（計画1の決まりと矛盾しない）:

- 新しい移行は計画1と同じ形（最初の行 `BEGIN;`、末尾 assert → `NOTIFY pgrst, 'reload schema';` → `COMMIT;`、`-- ACC_S6_FINAL_ASSERT_BEGIN/END`〜`ACC_S14_…`、失敗は `ACCOUNTING_MIGRATION_ASSERTION_FAILED / 55000` と固定コード `acc_s6_*`〜`acc_s14_*`）。SQL の日本語は `U&'\XXXX'` 形で、`src/lib/accounting/labels.ts` の `ACCOUNTING_LABELS` から `scripts/accounting/emit-labels.ts` が出す文字列を貼り、試験が TS と一致を確かめる。
- 計上係の private 関数は、最初に `private.accounting_lock_all(NULL)` で①②を取り、各仕訳を入れる `accounting_post_journal_core` が③を取る（計画1のロック順）。係は **G の表の行にも `admin_finance_expenses` にもロックを取らない**（読むだけ。`FOR SHARE`・`FOR UPDATE` を使わない）。係の1回の呼び出しは最大 `_limit`（既定 50、上限 200）件で終わる。TS が `has_more` が偽になるまで繰り返す（最大 20 回）。
- 新しい表で route が書く物（計上待ちの解決、設定、請求書の記録など）は、計画1の決まりのとおり、private 関数 + service_role だけの public 入口で書く。Stripe の既存の表（`stripe_balance_transactions`・`stripe_refunds`・`stripe_payouts`）は今のとおり TS の adapter が service_role で書く（計画2では書き方を変えない）。
- 画面に出す文は、穏やかな日本語・絵文字なし・感嘆符なし。カード会社からの支払いの取り消しは「カード会社からの支払いの取り消し」と書き、「チャージバック」と書かない。計上待ちの理由の文・メモ・監査に、お客様の名前・メール・住所を入れない。
- `src/lib/stripe/**`・`src/app/api/webhook/**`（ブリーフの `src/app/api/webhooks/**` に当たる実際のパス）・`src/app/api/checkout/**`・`src/lib/checkout/**`・`src/features/checkout/**` を触る Task（Task 4・5・10）の最初の行に「controller が別セッションへ先に知らせる」と書く。決済のファイル（`checkout/**`・`lib/checkout/**`・`features/checkout/**`）は計画2では変えない見込みで、触る必要が出たら止めて controller に知らせる。
- 試験の日付: 係は `cutover_on` より前の日を止め、G の発送票の確定と日の直しは今日より後・支払いの日より前の出荷日を断る。このため ROLLBACK の DB 試験は、fixture の `setCutoverForTest(client, date)`（postgres として `accounting_settings.cutover_on` を前へ動かす。ROLLBACK で戻る）を使い、出荷日を決める例は G の関数でなく G の表へ直接入れる fixture（`group-g3-fixtures.ts` の作り方）で作る。コミットする試験と E2E は今日の日付だけを使い、年末の一覧の E2E は範囲を今日を含む日に変えて確かめる。
- 係の候補の選び方: 新しい出来事（印が無く、計上待ちにも解決済みの行にも無い物）を古い順に `_limit` 件まで取り、そのあとで未解決の計上待ちを `last_detected_at` の古い順に別枠で1回10件だけ見直す。未解決が `_limit` 件以上あっても、新しい出来事に必ず届く。`has_more` は、入れた件数と新しく止めた件数の合計が `_limit` に達した時だけ真で、同じ未解決を止め直しただけでは真にならない。各係の候補は SQL の条件で絞る（手数料の係は「種類の対応 `accounting_stripe_category_kind` が単独の手数料なら `net <> 0`、それ以外なら `fee <> 0`」（符号つきの手数料 `fee_amount <> 0` と同じ。種類の名前を SQL に直接書かず、対応の関数から引く）の取引、元本の係は自分の種類だけ、知らない種類の拾いは種類の対応が NULL の物だけ）。飛ばす取引（返金の元本・入金の取引の行・補充）はそれぞれの元本の係の候補に入れない。手数料の係で飛ばすのは `fee_amount = 0` の物（単独の手数料の種類で `net = 0`、それ以外で `fee = 0`）で、候補の条件と同じ。候補に入れず、毎回枠を占めない。数が増えても新しい出来事に届く。
- 出来事ごとの失敗の扱い（Task 2・3・4・6 共通）: 新しい出来事も未解決の見直しも、1件の期間の解決から仕訳・付随する記録・計上待ちの解決までを1つの `BEGIN … EXCEPTION WHEN OTHERS … END`（savepoint 相当）で包む。`ACCOUNTING_PERIOD_MISSING` は従来の `period_missing`、それ以外の出来事の例外は `posting_error` にする。`ACCOUNTING_PERIOD_MISSING` の DETAIL が `sole_ended_not_switched` の時だけ、detail に固定の語 `cause: 'sole_ended_not_switched'` を入れる（生の DETAIL は残さない）。失敗した1件の書き込みと採番を巻き戻してから、例外を捕まえた側で `accounting_park_event` に理由を残し、次の出来事へ進む。core は計画1の `accounting_assert_journal`・`accounting_assert_period_layout` で返る前に確かめるため、借貸・期間の失敗もこの中で捕まえられる。`posting_error` の詳細は `error_sqlstate`（5桁の英数字）・`error_code`（既知の `ACCOUNTING_ERRORS` の固定コード、未知なら `unexpected_error`）と、分かる時だけ `entry_date`。生の `SQLERRM`・DETAIL・CONTEXT は保存も表示もログ出力もしない。新しく保留した1件は `parked` に数え、次の回は新しい候補から外して未解決の別枠で見直すので、同じ1件が先頭を塞がない。正常に計上できた時だけ自動で解決する。
- 実装者は単体/型/lint、controller は reset・DB 結合/並行・PostgREST・build/E2E・provider（Stripe のテストモードを含む）・本番を担当する。計画作成中は Playwright・サーバー・Supabase CLI・Docker・DB 試験・変更系 git・`.env*` の読取をしない。

**共通 verify（後日の controller 手順）:** 計画1の共通 verify と同じ（RED → reset → 既存 `items` 読取 smoke → 対象 DB suite → PostgREST で新 public 入口の service_role 成功/anon・authenticated 拒否）。計上係の試験は、DB に支払い・出荷・Stripe の行を fixture で入れ、`private.*` の係を直接呼んで仕訳を確かめる（ROLLBACK の形）。係の並行の試験と public 入口の PostgREST の試験だけがコミットする試験で、別の jest 実行で流し、前後に `db reset` する。

## Review Focus

- **売上は出荷した日に、送った分だけ立ち、前受金が合う:** 支払いは「Stripe 未収金／前受金」、出荷は「前受金／売上高」で、一部だけの出荷は送った着の額だけ、端数は番号の若い着、取り消し・日の直しは取り消しと正しい仕訳、全部送るか返金すると前受金が0になり、年をまたぐ未出荷は前受金のまま繰り越す。交換の品は売上にならない → Task 2 の `FREQ-562-AC-01`〜`AC-05`・Task 3 の `FREQ-563-AC-01`〜`AC-06`・`FREQ-564-AC-01`〜`AC-04`。
- **順番に頼らず、二重も抜けも無い:** 出荷が支払いより先でも仕訳にせず計上待ちに止まり、支払いが入ると1本ずつ入る。同じ出来事を何度・同時に流しても1本。仕訳にできない理由（金額の不一致・送料の欄・切り替えより前・前受金がマイナス）が一覧に出る → Task 3 の `FREQ-563-AC-04`、Task 10・11 と Task 2・3・4・6 の `FREQ-569-AC-01`〜`AC-03`・`AC-06`（1件の失敗でもほかは続く）、Task 1 の `FREQ-569-AC-05`。
- **Stripe は日本時間の日で、1件ずつ印がつく:** 手数料は残高の取引1件に1本（`stripe:fee:<番号>`）、免税の間は税込み1本、課税なら本体と消費税、入金・着金・入金の失敗が元の仕訳に戻り、日本時間の月と UTC の月と請求書の差が2段で説明される。カード会社からの支払いの取り消しは、未出荷と出荷済みで違う科目に入り、原因が残り、取り下げと遅れた取り下げが戻る → Task 4 の `FREQ-565-AC-01`〜`AC-06`・`FREQ-566-AC-01`〜`AC-03`、Task 5 の `FREQ-567-AC-01`〜`AC-04`、Task 6 の `FREQ-568-AC-01`〜`AC-07`。
- **受注高は帳簿の売上高と分け、2段の照らし合わせの差が0:** 受注高は支払いを受けた日（4-a の仕訳の日）に足し、出荷前の取り消しだけを引き、出荷後の返品は引かない。受注残は 2150 の注文ごとの残高の合計で、期首の受注残＋受注高−売上高（返品の前）＝期末の受注残が合い、カード会社の判断待ちなどの例外は行で説明される。画面に「帳簿の売上高ではない」と出る → Task 7 の `FREQ-571-AC-01`〜`AC-06`、Task 13 の `FREQ-572-AC-01`〜`AC-05`。
- **置き換えと表と購読が本番で壊れない:** 画面は保存した仕訳だけで注文・Stripe の売上を数え、合成が残らない。`admin_kpi_monthly_records` が移行にあり月の記録の保存が通る。Webhook の受け取りの種類（18種）が処理する側の分け方と一致し、Stripe の宛先に足す手順が運用の文書にある → Task 12 の `FREQ-570-AC-01`〜`AC-04`、Task 8 の `FREQ-573-AC-01`〜`AC-03`、Task 5 の `FREQ-567-AC-01`、Task 15。

---

## 設計の行から Task への対応

「計画N」は後の計画が作る物。

| 設計の行 | 作る Task | 固定する試験 |
| --- | --- | --- |
| 1-a01（支払いの確定） | 2 | 562-AC-01〜04 |
| 1-a02（出荷の確定） | 3 | 563-AC-01〜06 |
| 1-a03（発送の取り消し・出荷日の直し） | 3 | 564-AC-01〜04 |
| 1-a04〜1-a09・1-a22（返金・返品） | 計画3 | — |
| 1-a10（Stripe の手数料）・1-a11（JCT tax adjustment） | 4 | 565-AC-01〜03 |
| 1-a12（入金・銀行への着金）・1-a13（入金の失敗）・1-a14（残高の補充） | 4 | 565-AC-04〜06 |
| 1-a15（カード会社からの支払いの取り消し）・1-a16（遅れた取り下げ） | 5（受け取り）・6（仕訳） | 567-AC-01〜04、568-AC-01〜07 |
| 1-a17（交換の出荷・戻り） | 3（売上を作らない確認）。原価・在庫は計画5 | 563-AC-05 |
| 1-d の「支払いの仕訳が無い注文の出荷を待っている一覧に止める」 | 1・3・10・11 | 563-AC-04、569-AC-01〜03 |
| 2-a（支払い＝Stripe 未収金／前受金・注文番号つき・前受金がマイナスでない） | 2・3・7・11 | 562-AC-01〜03、569-AC-04 |
| 2-b・2-c・2-g（出荷の売上・額・発送票1枚に1本） | 3 | 563-AC-01〜04 |
| 2-d（出荷前の返金の仕訳） | 計画3（係は割り当ての表を読む側だけ作る） | 563-AC-02 |
| 2-e（年末の未出荷は前受金のまま繰り越す・繰り越した前受金の一覧） | 7・11 | 571-AC-05、569-AC-04 |
| 2-f（取り消しと正しい日の仕訳） | 3 | 564-AC-01〜02 |
| 2-h（端数は番号の若い順） | 1（割り振りの道具）・3 | 563-AC-03 |
| 2-i（交換は売上を変えない） | 3 | 563-AC-05 |
| 2-j（切り替え前の注文は無い・切り替えの日から新しい形） | 2・3（切り替えより前は止める） | 562-AC-04 |
| 3-h（受注高と帳簿を分ける） | 7・13 | 571-AC-01〜06 |
| 4-a（支払いの仕訳・日は残高の取引の日本時間・paid_at を使わない） | 2 | 562-AC-01〜03 |
| 4-b（日本時間・入金の仕訳も同じ・レポートの時間帯） | 2・4 | 562-AC-03、565-AC-04 |
| 4-c・4-c2・4-c3・4-c4（手数料の1件1本・税の分け方・相手・JCT tax adjustment・月の照合の2段） | 4 | 565-AC-01〜03、566-AC-01〜02 |
| 4-d・4-e・4-e2（支払いの取り消しの仕訳・原因・一部出荷の分け方） | 6 | 568-AC-01〜05・07 |
| 4-e3（判断待ちの注文の返金と出荷を止める） | 6・10・11（出荷の route と画面）。DB の止めは計画3 | 568-AC-06 |
| 4-f（取り消しの原因と申し立ての資料の保存） | 5 | 567-AC-03 |
| 4-g（入金の失敗・取り消し） | 4 | 565-AC-05 |
| 4-h（残高のマイナスの銀行引き落とし） | 4・11 | 565-AC-06 |
| 6-a（売上の日は発送ごとの出荷日・食い違えば止める） | 3 | 563-AC-04 |
| 6-b（直しは古い日の取り消しと新しい日の仕訳・跡をたどれる） | 3 | 564-AC-02〜03 |
| 6-b2（締めた年にかかる直しは画面で止める） | 計画6（締めの機能ができてから） | — |
| 6-c（出荷した日と登録した日を並べる） | 3（読み口）・10・11 | 564-AC-04 |
| 6-d（年末の前後の照合と確かめた印） | 9・10・11 | 574-AC-01〜02 |
| 6-d2（運送会社の受付の日との自動の照らし合わせ・既定オフ） | 9・10・11 | 574-AC-03〜04 |
| 6-e（返品の期限の数え方は変えない） | 変えない | — |
| 6-f（直した跡・優良な電子帳簿の届出・検索） | 計画6 | — |
| 7-b・7-h（1160 を番号で使う・1130 の名前は残す） | 2・4（係は 1160 を番号で使う） | 562-AC-01、565-AC-01 |
| 7-i・7-i3・7-i4（店頭と通販の振り分け） | 作らない（今は全部 1160）。仕組みは店頭で Stripe を使い始める時 | — |
| 7-i2（単独の手数料・調整は 1160） | 4 | 565-AC-01 |
| 7-i5（1130 の Stripe の分＋1160 と Stripe の残高の照らし合わせ） | 4・10・11 | 566-AC-03 |
| 8-a・8-b・8-c・8-e・8-f（名前・数える注文・日・交換・指標） | 7・13 | 571-AC-01〜02、572-AC-01〜04 |
| 8-d（引くのは出荷前の取り消しだけ・日・dispute の確定した日） | 7 | 571-AC-03〜04 |
| 8-g・8-g2（2段の照らし合わせ・例外の行） | 7・10・11 | 571-AC-05〜06 |
| 8-h・8-h2（受注高の内訳・明細の無い返金） | 7・13（内訳）。明細の無い返金の分け方は計画3 | 571-AC-02 |
| 8-i（画面に「帳簿の売上高ではない」） | 11・13 | 572-AC-05 |
| 8-j（税抜きにした時の消費税の行） | 作らない（課税事業者になり税抜きを選ぶ時。未確認事項 #8） | — |
| 11-g（KPI は暦のまま） | 変えない（月の記録の表だけ Task 8） | 573-AC-01〜03 |
| 16章（範囲の行） | 未確認事項に1行ずつ（#1・#2・#5・#7） | — |
| A6 の設定のオプション 6-d2 | 9 | 574-AC-03 |

---

## 要求と受入条件（`docs/02_Requirements/requirements.md` の6列の表へ足す文）

計画1の最後の番号は FREQ-561。下表の各行を「要求ID／要求内容／要件ID／要件内容／受入条件ID／受入条件内容」の6列へ展開する。要件 ID は `FREQ-NNN-REQ-01`、AC は同じ番号の `FREQ-NNN-AC-NN`。各 Task は、自分が証明する AC の行を同じコミットで足す（要求管理ルール）。Task 15 は全部そろっているかの確かめと体裁だけ。

| 要求 | REQ-01 の要件 | AC | 証明する Task |
| --- | --- | --- | --- |
| FREQ-562（支払いを前受金で残す） | 支払いの確定ごとに、payment_intent の番号1つに1本、「Stripe 未収金（1160）／前受金（2150）」を注文番号つきで保存する。日は Stripe の残高の取引の時刻の日本時間の日 | AC-01 額は手数料を引く前の総額で2150の行に注文番号が付く／AC-02 注文の合計・1着ごとの支払額の合計・送料の欄が合わなければ仕訳にせず止める／AC-03 日は日本時間（1月1日朝8時は1月1日）で `orders.paid_at` を使わない／AC-04 切り替えの日より前の日は仕訳にせず計上待ちに置く／AC-05 同じ支払いを何度・同時に流しても1本 | 1・2・6・10 |
| FREQ-563（出荷した日に送った分だけ売上にする） | 確定した発送票1枚に1本、品ごとの行で「前受金／売上高」を、送った着の支払額（割引後）−出荷前の返金の額で保存する。日は発送ごとの出荷日 | AC-01 一部の出荷は送った着の額だけ（2-4 の表のとおり 18,750・10,250）／AC-02 出荷前の返金の割り当てがあれば引く／AC-03 同じ品で端数の差があれば番号の若い着から送る／AC-04 支払いの仕訳が無い注文・出荷日の食い違い・前受金が足りない出荷は仕訳にせず計上待ちに置き、支払いが入ると自動で入る／AC-05 交換の品は売上にならない／AC-06 同じ発送票を何度・同時に流しても1本 | 3 |
| FREQ-564（出荷の取り消しと出荷日の直し） | 出荷の取り消しは元の仕訳を打ち消す仕訳を足し、出荷日の直しは古い日の取り消しと新しい日の仕訳を足す。元の仕訳は変えない | AC-01 取り消しは元の日の逆の仕訳で、送った着が「まだ送っていない」に戻る／AC-02 日の直しは取り消し（元の日）と正しい仕訳（直した日）で、日が別の期間にまたがっても動く／AC-03 仕訳から発送票の直した跡（理由・人・前後の日）をたどれる／AC-04 帳簿の一覧に出荷した日と登録した日（発送票を確定した日）が並ぶ | 3・10・11 |
| FREQ-565（Stripe の手数料・入金・着金を1件ずつ残す） | Stripe の残高の取引1件に手数料1本（`stripe:fee:<番号>`）、税額調整・入金・着金・入金の失敗を1本ずつ保存し、残高の補充は画面から1回だけ入れる。日は日本時間 | AC-01 手数料は取引1件に1本（typeがstripe_fee・stripe_fx_feeならfee=0でも-net、ほかはfee）で免税の期間は税込み1本、課税の期間は本体と仮払消費税、相手は「ストライプジャパン株式会社」／AC-02 税額調整は調整の取引の日に1本、符号つきの費用は-net、行の正の額はabs(net)で元の手数料と二重にならない／AC-03 種類を知らない取引は黙って捨てず計上待ちに置く／AC-04 入金は中身と額が一致した時だけ「Stripe 入金途上／Stripe 未収金」、着金は着金の日に「普通預金／Stripe 入金途上」／AC-05 入金の失敗・取り消しは戻りの取引の日に戻す／AC-06 残高の補充は銀行の取引の番号で二重を止める | 4 |
| FREQ-566（Stripe の残高と手数料を照らし合わせる） | 日本時間の月と UTC の月と請求書の差を2段で、Stripe の残高と 1160＋1130 の Stripe の分を月末に照らし、説明のつかない差だけを出す | AC-01 日本時間の月と UTC の月の差は月初0〜9時の取引の一覧で説明される（単独の手数料も-netで含む）／AC-02 UTC の月と請求書の差は翌月の税額調整と端数で説明され、残りが「説明のつかない差」／AC-03 Stripe の残高と台帳の差に、計画3で計上する種類と計上待ちの分が名指しで出る | 4・10・11 |
| FREQ-567（カード会社からの支払いの取り消しを受け取る） | `charge.dispute.*` の5種を受け取り、dispute の表と状態の履歴に保存し、残高の取引を取り込む。原因と申し立ての資料の写しを残す | AC-01 受け取りの種類が18種で処理する側の分け方と一致する／AC-02 同じ知らせの2回目は履歴を増やさない／AC-03 原因と期限と資料の写し（`raw_payload`）が残り、書き換えられない／AC-04 毎晩の再照合が取りこぼした dispute を拾う | 5 |
| FREQ-568（支払いの取り消しを原因つきで仕訳にする） | 未出荷は前受金を減らし、出荷済みは仮払金（判断待ち）に置き、確定で原因に合う科目へ、取り下げで戻す。一部出荷は実際に引かれた額を着の支払額の比で分ける | AC-01 未出荷：引かれた日に「前受金／Stripe 未収金」、手数料は「支払手数料／Stripe 未収金」、取り下げで代金だけ戻る／AC-02 出荷済み：「仮払金（判断待ち）／Stripe 未収金」、確定で設定の科目へ、設定が無ければ「確定・科目の決定待ち」の補助に置く／AC-03 一部出荷は比で分け端数は番号の若い順／AC-04 確定の後に遅れて取り下げられた時は確定の時の科目で戻す／AC-05 科目の設定と後からの振り替え／AC-06 判断待ちの注文は出荷の route と画面で止まり、理由が出る／AC-07 dispute の出来事がどの順で届いても最後の残高が同じ | 6・10・11 |
| FREQ-569（計上待ちと前受金の確認を出す） | 仕訳にできない出来事を理由つきで一覧に出し、直ったら自動で入れ、手で再実行・確認済みにできる。前受金の異常と繰り越した前受金の一覧を出す | AC-01 理由つきで一覧に出る（名前・メールを含まない）。`period_missing` の `detail` に出来事の日 `entry_date`（`YYYY-MM-DD`）が必ず入る／AC-02 直ったら自動で解決する／AC-03 手で再実行でき、確認済みにできるのは `admin.accounting.entries.correct` の人だけ／AC-04 前受金がマイナスの注文・全部送った後に0でない注文・繰り越した前受金が一覧に出る／AC-05 期間の決め方が期待の答えの表のとおり（計画1の Task 7 の道具）／AC-06 出来事1件の失敗を理由つきの保留に残し、ほかは計上する。直して再計上でき、同じ失敗で新しい出来事を止めない | 1・2・3・4・6・7・10・11（計画3 Task 6・7・8、計画5 Task 5・6 の試験も AC-01 を使う） |
| FREQ-570（保存した仕訳で数える） | 画面は注文の売上と Stripe の仕訳を合成せず、保存した仕訳だけで数える。取引管理の注文の収入の行は出荷の仕訳から作る | AC-01 合成が残らず二重にならない／AC-02 取引管理の注文の収入のgrossAmountとnetAmountは出荷の仕訳の4010のcredit−debitの合計と一致する／AC-03 Stripe の精算のタブ（原始記録）は動きを変えない／AC-04 コードに `buildStripeJournal`・`toOrderSalesTransaction` の呼び出しが残らない | 12・13 |
| FREQ-571（受注高・受注残を帳簿と分けて照らす） | 受注高は支払いの仕訳の日に足し出荷前の取り消しだけを引く。受注残は 2150 の注文ごとの残高。2段で帳簿と照らし、例外は行で説明する | AC-01 受注高の対象は支払いを受けた注文（支払い済み・発送済み・あとで取り消した）で、支払いの途中・失敗・放棄を含まない／AC-02 内訳（割引の前の商品の額・割引・出荷前の取り消し・受注高）の合計が受注高に合う／AC-03 出荷後の返品は受注高から引かない／AC-04 カード会社の取り消しは確定した日に未出荷の分だけ引く／AC-05 期首の受注残＋受注高−売上高（返品の前）＝期末の受注残（例外の行を足して差が0）／AC-06 売上高（返品の前）−返品＝帳簿の売上高（4010−4020。4050を入れない） | 7 |
| FREQ-572（KPI を受注高の名前と数え方にする） | KPI の「売上」を「受注高」に改め、受注残を出し、客単価・LTV・リピート率・セット購入率を支払いを受けた注文で数える。画面に帳簿の売上高ではないと書く | AC-01 名前が「受注高」になり目標の鍵 `sales` は変わらない／AC-02 出荷して状態が「発送済み」になっても受注高から外れない／AC-03 指標が支払いを受けた日の月で数えられる／AC-04 KPI の route は店長だけで、サポーターは403／AC-05 画面に「帳簿の売上高ではありません。申告には使いません」と出る | 13 |
| FREQ-573（月の KPI の表を持つ） | `admin_kpi_monthly_records` を移行で作り、書き込みは DB の関数で行い、月の記録の保存と Meta の同期が通る | AC-01 表が移行にあり、anon・authenticated に権限が無い／AC-02 保存と削除（空値）が通り、同じ月・指標は1行／AC-03 route は店長だけで、表が無い時の 503 の文が消える／AC-04 月の記録の名前が「受注高」になる | 8・13 |
| FREQ-574（出荷の年末の照合と運送会社の受付日） | 年末の発送票の一覧を出し確かめた印を残す。運送会社の受付日との照らし合わせは設定で入れた時だけ働く | AC-01 12月25日〜1月10日の発送票が運送会社・追跡番号・出荷した日つきで続きの目印つきに出る／AC-02 確かめた印が人・時刻つきで残り、二重に付かない／AC-03 設定の既定はオフで、切り替えた日と人が残る／AC-04 オンの時だけ、受付の日と出荷した日が1日以上ずれた発送票が出る | 9・10・11 |

## 共通の型・値・拒否

Task 1・10 が定義し、以降は同じ名前を使う。計画1の型（`AccountingPeriod`・`SavedJournalEntry`・`AccountingEventKind` など）はそのまま使う。

| 型/定数 | 正確な契約 |
| --- | --- |
| `PendingReason` | `src/lib/accounting/posting-types.ts` の `PENDING_REASONS`（下の表の値）。文字列の組 |
| `PendingEvent` | `{id:string;eventKind:AccountingEventKind;sourceTable:string;sourceId:string;orderId:string\|null;reason:PendingReason;detail:Record<string,string\|number\|boolean\|null>;firstDetectedAt:string;lastDetectedAt:string;detectionCount:number;resolvedAt:string\|null;resolvedEntryId:string\|null}`。`detail` は止めの理由ごとに決めた固定の鍵（`order_count`・`shortage`・`error_sqlstate`・`error_code` など。全部の一覧は Task 3 Step 1）で、個人の情報や生の例外の文を入れない |
| `PostingRunResult` | `{payments:number;shipments:number;stripe:number;disputes:number;parked:number;resolved:number;hasMore:boolean}`。`accounting_run_posting` の戻りの jsonb（snake_case）を store が直す |
| `ACCOUNTING_SUB_ACCOUNTS`（計画1）への追加 | `dispute_confirmed_unassigned:{accountCode:'1470'}`（確定・科目の決定待ち。4-e） |
| `DisputeCause` | Stripe の dispute の `reason` の文字列（`fraudulent`・`product_not_received`・`product_unacceptable`・`unrecognized`・`duplicate`・`subscription_canceled`・`credit_not_processed`・`general`・`bank_cannot_process`・`check_returned`・`customer_initiated`・`debit_not_authorized`・`incorrect_account_details`・`insufficient_funds`・`noncompliant`・`other`）。設定の鍵。知らない値は `other` 扱い |
| 上限 | `MAX_POSTING_BATCH=200`（既定 50）、`MAX_POSTING_LOOPS=20`、`MAX_PENDING_PAGE=100`、`MAX_DISPUTE_NOTE=500` |

**計上待ちの理由（`PendingReason`）と意味:**

| 値 | 意味 | 直ると自動で入る |
| --- | --- | --- |
| `payment_journal_missing` | 出荷の仕訳を作ろうとしたが、注文の支払いの仕訳が無い（1-d） | 支払いの仕訳が入った時 |
| `order_not_postable` | 送料の欄が0でない・注文の合計と1着ごとの支払額の合計が合わない・1着ごとの支払額が無い（2-c） | 直った時 |
| `amount_mismatch` | Stripe の残高の取引の総額が注文の支払額と違う | 取引が同期し直された時 |
| `no_order` | Stripe の支払いに結び付く注文が無い（店頭の売上の道は未作成。7-i4） | 注文が結び付いた時 |
| `units_insufficient` | 送る着の数が、まだ送っていない着より多い | 取り消しで着が戻った時 |
| `shipment_date_mismatch` | 発送ごとの出荷日と発送票の出荷日が食い違う（6-a） | 日が直された時 |
| `deferred_revenue_short` | 出荷の額が、その注文の前受金の残りより多い（2-a） | 支払いや戻しが入った時 |
| `period_missing` | その日を含む会計の期間が無い（やめた日より後で法人へ未切り替えの時は detail の `cause: 'sole_ended_not_switched'` で区別して載せ、案内は「やめた日が正しいか確かめ、正しければ法人へ切り替える」の順） | 期間が作られた時・法人へ切り替えた時・やめた日を選び直した時 |
| `posting_error` | 出来事1件の期間の解決・仕訳・付随する記録の処理で失敗した。理由の固定コードと SQLSTATE だけを残し、ほかの出来事へ進む | 元の記録・設定または処理を直して再計上した時（手では確認済みにできない） |
| `before_cutover` | 出来事の日が切り替えの日より前（2-j） | 自動では入らない（確認済みにする） |
| `unknown_category` | 知らない Stripe の残高の取引の種類 | 種類の対応が足された時 |
| `payout_mismatch` | 入金の中身の合計と額が一致しない（`reconciliation_status<>'matched'`） | 一致した時 |
| `dispute_refund_overlap` | 支払いの取り消しの注文に、成功した返金がある（4-e2：二重に費用にしない） | 計画3の返金・返品の仕訳と合わせた時（手では閉じられない） |
| `dispute_return_refund_pending` | 支払いの取り消しの注文に、返品の返金待ち（2130）がある（4-e2。計画3が相殺を作る） | 計画3 |
| `dispute_withdrawal_missing` | 確定・確定の前の取り下げ・遅れた取り下げを仕訳にしようとしたが、前の段（引かれた時、確定なら lost の時刻より前の戻りの取り下げ、遅れた取り下げなら確定、確定が補助 `dispute_confirmed_unassigned` に置かれていれば振り替え〔detail `waiting_on: 'dispute_account_unassigned'`〕）の仕訳がまだ無い。または、戻りの取引があるが dispute がまだ決着していない（戻りを R と L のどちらにするかを決めるため。Task 6 の規則3）（1-d）。お金の動く理由なので手では閉じられない | 前の段の仕訳が入った（または確定が `no_revenue` で済んだ）時、dispute が決着した時、科目の設定を入れて振り替えた時 |
| `dispute_shipment_pending` | 引かれた時を仕訳にしようとしたが、その注文に、引かれた時刻より前に確定した `stage='confirmed'` の発送票で出荷の仕訳がまだ無い物がある（出荷済みの分け方が処理の順で変わらないように待つ） | 出荷の仕訳が入った時 |
| `shipment_lines_mismatch` | 発送票の明細（`shipment_slip_lines`）と発送ごとの明細（`order_fulfillment_lines`）の品ごとの数量が食い違う（2-3） | 直った時 |
| `no_revenue` | 仕訳にする額が0（交換の品だけの発送票など）。入れた直後に自動で解決済みになり、係の候補から外れる印 | 入れた直後に解決済み |

**DB と HTTP の拒否表への追加（計画1の `ACCOUNTING_ERRORS` へ足す。Task 10）:**

| DB message / SQLSTATE | HTTP | 日本語本文 |
| --- | --- | --- |
| `ACCOUNTING_EVENT_NOT_POSTABLE / 55000` | 409 | `この出来事は今は仕訳にできません。計上待ちの一覧で理由を確かめてください。` |
| `ACCOUNTING_PENDING_RESOLVED / 55000` | 409 | `この計上待ちは既に解決されています。` |
| `ACCOUNTING_DISPUTE_ACCOUNT_INVALID / 22023` | 400 | `選んだ勘定は、支払いの取り消しの振り替え先に使えません。` |
| `ACCOUNTING_ARGUMENT_INVALID / 22023`（既存） | 400 | `入力を確かめてください。`（計上待ち・設定・請求書の記録の入力） |

その他の失敗は計画1の表のまま（未知は 500 `会計の処理に失敗しました。`）。KPI の route は今の本文（`Forbidden`・`Failed to ...`）を保つ。

---

### Task 1: 計上の土台の表と道具（計上待ち・送った着の記録・返金の割り当て・割り振り）

controller が別セッションへ `docs/06_Operations/db-migrations.md`・`docs/03_BasicDesign/data/er.md` の更新と、発送票の確定・取り消しの関数（G-3・G-4 の物）に番号を取る1行を足すことを先に知らせる。計画1の Task 6・7（S2・S3）のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-562・569 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts6>_accounting_p2_posting_tables.sql`、`tests/integration/db/accounting_p2_posting_tables.integration.test.ts`、`tests/integration/db/accounting_p2_migration_asserts.integration.test.ts`、`tests/integration/db/helpers/accounting-orders-fixtures.ts`、`src/lib/accounting/posting-types.ts`、`src/lib/accounting/allocate.ts`、`src/lib/accounting/labels.ts`、`scripts/accounting/emit-labels.ts`、`tests/unit/lib/accounting/posting-types.test.ts`、`tests/unit/lib/accounting/allocate.test.ts`、`tests/unit/lib/accounting/labels.test.ts`
- Modify（番号を取る1行を足す G の関数の、意図して直す試験）: `tests/integration/db/group_g4_foundation.integration.test.ts:57-60`（`FREQ-540-AC-14`。確定の関数の本文を文字で比べるので、`-- ACC_P<数字>_BEGIN` 〜 `-- ACC_P<数字>_END` の囲みを全部除いた本文で比べる形に直す〔`ACC_P2` だけを除く形にしない。計画3の S19 が同じ関数に `ACC_P3` の囲みを足しても、直し直さずに通すため〕。題は変えない）
- Test: 上の DB 2 suite と単体3本。加えて、確定と取り消しの関数を触る既存の suite（`group_g3_confirm`・`group_g3_cancel`・`group_g3_migration_asserts`・`group_g3_date`・`group_g3_tracking*`・`group_g4_*`・`group_g1_writer_inventory`・`group_h_migration_asserts`）が、`FREQ-540-AC-14` 以外は無改造で通ること
- Read: 計画1の Task 6・7 の成果（`accounting_post_journal_core`・`accounting_reverse_journal_core`・`accounting_period_for`・`accounting_lock_all`・`reject_accounting_mutation`）、`supabase/migrations/20261029130000_group_h_discounts_foundation.sql:118-145`（`order_line_unit_amounts`）、`tests/integration/db/helpers/group-h-fixtures.ts`（注文・支払いの fixture の手本）、`20261026045859_group_g4_orders_foundation.sql:6-215`（確定の関数の最新の定義。:51 で鍵、:189 で状態を変える）、`20261025100130_group_g3_shipping_slips.sql:749-894`（取り消しの関数の最新の定義。:775 で鍵、:867 で状態を変える）、`20261029130400_group_h_discounts_refunds.sql:30-39`（`group_h_assert_unit_lock`）

**Interfaces:**
- Consumes: 計画1の S2・S3 の表と関数。`public.orders`・`order_items`・`order_line_unit_amounts`（service_role にも権限が無いので、private 関数からだけ読む）。
- Produces（表。すべて `public`、所有者 postgres、RLS 有効、PUBLIC/anon/authenticated に権限なし、service_role は SELECT のみ）:
  - `accounting_pending_events(id uuid PK DEFAULT gen_random_uuid(), event_kind text NOT NULL CHECK (event_kind = ANY (private.accounting_event_kinds())), source_table text NOT NULL, source_id text NOT NULL, order_id uuid NULL, reason text NOT NULL CHECK (reason IN (…上の「計上待ちの理由」の値と `no_revenue`)), detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail)='object'), first_detected_at timestamptz NOT NULL DEFAULT now(), last_detected_at timestamptz NOT NULL DEFAULT now(), detection_count integer NOT NULL DEFAULT 1 CHECK (detection_count >= 1), resolved_at timestamptz NULL, resolved_entry_id uuid NULL FK accounting_journal_entries RESTRICT, resolved_by uuid NULL, resolution_note text NULL CHECK (char_length(resolution_note) <= 500), resolution_request_key uuid NULL UNIQUE, resolution_request_hash text NULL, UNIQUE (event_kind, source_table, source_id))`。索引: (resolved_at, first_detected_at)、(order_id)。`reason` の `no_revenue` は「仕訳にする額が0」で、入れた直後に自動で解決済みにする（交換の品だけの発送票など。Task 3）。解決済みの行（人が確認済みにした物、`no_revenue`、仕訳が入った物）は、係の候補から外す印になる。
  - `accounting_shipment_units(entry_id uuid NOT NULL FK accounting_journal_entries RESTRICT, order_item_id uuid NOT NULL FK order_items RESTRICT, unit_index integer NOT NULL CHECK (unit_index >= 0), paid_amount integer NOT NULL CHECK (paid_amount >= 0), refunded_amount integer NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0), PRIMARY KEY (entry_id, order_item_id, unit_index))`。追記専用（`reject_accounting_mutation` を UPDATE/DELETE/TRUNCATE に付ける）。出荷の仕訳が使った着の記録で、どの着が出荷済みかはこの表では決めない（下の道具が決める）。
  - `accounting_unit_refund_allocations(order_item_id uuid NOT NULL FK order_items RESTRICT, unit_index integer NOT NULL, refund_key text NOT NULL CHECK (refund_key ~ '^[A-Za-z0-9_.:-]{1,128}$'), amount integer NOT NULL CHECK (amount <> 0), fact_seq bigint NOT NULL UNIQUE, locked_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (order_item_id, unit_index, refund_key), FOREIGN KEY (order_item_id, unit_index) REFERENCES order_line_unit_amounts(order_item_id, unit_index) RESTRICT)`。追記専用。1着ごとの合計が `0 以上・paid_amount 以下` であることを遅らせて確かめる制約トリガーで守る。キーは、返金の番号（正）、`reapply:<返金の番号>`（正。エラーの後の書き直し）、`cover:<返金の番号>`（正。前の返金の借りが決まった後の当て直し。計画3）、`release:<元のキー>:<n>`（負。戻し。2026-11-04 計画3の確かめから）。`fact_seq`・`locked_at` は書き手が G の鍵の中で取る番号と、その時の `clock_timestamp()`（下の「順番の番号」）。比べには `fact_seq` だけを使い、`created_at` は比べに使わない。書き手は下の `private.accounting_record_unit_refund`（計画3だけが呼ぶ。計画2では行が入らない）。
  - **順番の番号（2026-11-04 計画3の確かめ直し〔3回目〕の controller の決定）:** `CREATE SEQUENCE private.accounting_g_fact_seq AS bigint`（所有者 postgres、PUBLIC/anon/authenticated/service_role に権限なし）。番号は G の鍵 `pg_advisory_xact_lock(190521,1)` を持っている間だけ、道具 `private.accounting_take_g_fact_seq() RETURNS TABLE(fact_seq bigint, locked_at timestamptz)`（`private.group_h_assert_unit_lock()` で鍵を確かめ、無ければ `GROUP_H_LOCK_REQUIRED / 55000`。`nextval` と `clock_timestamp()` を返す。入口なし・service_role からも REVOKE）で取る。鍵はトランザクションの終わりまで外れないので、コミットした行の番号の順は鍵を取った順でありコミットの順になる（`now()` はトランザクションの始まりの時刻で、鍵の順と入れ替わるので比べに使わない）。番号の抜け（中断したトランザクション）は気にしない。
  - `accounting_g_slip_facts(slip_id uuid NOT NULL FK shipment_slips RESTRICT, kind text NOT NULL CHECK (kind IN ('confirm','cancel')), fact_seq bigint NOT NULL UNIQUE, locked_at timestamptz NOT NULL, PRIMARY KEY (slip_id, kind))`。追記専用。発送票の確定と取り消しの事実を、G の関数が状態を変えた直後に1行ずつ入れる（下の「G の関数に足す1行」）。書き手は `private.accounting_record_slip_fact(_slip_id uuid, _kind text) RETURNS bigint`（番号を取って1行入れ、番号を返す。同じ `(slip_id, kind)` の2回目は主キーで断る。入口なし・service_role からも REVOKE）。
  - 仕訳の行への索引 `accounting_journal_lines (order_id, account_code) WHERE order_id IS NOT NULL`（前受金の注文ごとの残高と受注残を速く読むため。計画1の表への索引の追加だけで、列も制約も変えない）。
- Produces（道具）:
  - `private.accounting_allocate_amount(_total bigint, _weights bigint[]) RETURNS bigint[]`（IMMUTABLE）。各 i に `floor(_total * w[i] / sum(w))` を割り、余り（`_total` − 合計。0以上、`cardinality - 1` 以下）を、重み0でない要素の番号の若い順に1円ずつ足す。`sum(w)=0` で `_total > 0` なら `ACCOUNTING_ARGUMENT_INVALID`。負の重み・負の額も同じ。合計は必ず `_total` になる（2-h・4-e2・5-g の端数の決め方。計画3も同じ関数を使う）。TS の双子 `allocateByWeight(total, weights): number[]`（`src/lib/accounting/allocate.ts`）。両方に同じ値のテストを置く。
  - `private.accounting_shipped_units(_order_item_id uuid, _as_of_seq bigint) RETURNS TABLE(unit_index integer, slip_id uuid)`（STABLE・DEFINER・入口なし・service_role からも EXECUTE なし）。比べは全部、上の順番の番号で行い、時刻（`confirmed_at`・`cancelled_at`・`created_at`）は使わない。発送票 s の確定の番号を c(s)、取り消しの番号を x(s)（無ければ無い）とする。`_as_of_seq` を N とし、NULL なら「今」（見えている全部の行。G の鍵を持つ呼び出しだけが NULL を渡す）。その品について、c(s) ≤ N で、x(s) が無いか N より大きい発送票を c(s) の順に見て、各発送票が `shipment_slip_lines` の数量ぶん着を取る。取る着は `unit_index` の若い順で、次の2つを除く: ①前の発送票（c(s′) < c(s)）のうち、**c(s) の時に生きていた物**（x(s′) が無いか c(s) より大きい）が取った着（後から取り消されても、後の発送票の取り方は変わらない）、②`fact_seq < c(s)` の割り当ての行（`release:`・`reapply:`・`cover:` の行も含む）の合計が `paid_amount` と同じ着。**出荷の仕訳が入っているかどうかは見ない。** H の確保（`order_line_unit_amounts.refund_id`）も見ない: H の確保は時刻も番号も持たない今の状態の列なので、見ると前の番号の答えが変わる。H が出荷前の返金として確保した着は、計画3が同じトランザクションで書く全額の割り当て（②）を通して除かれる。番号は鍵の順でコミットの順なので、ある N の答えは、その N より後にコミットした行で変わらない（何回・いつ計算しても同じ）。計画3の割り当て（`_as_of_seq` NULL）・計画2の送る着（その発送票の c(s)）・W の値打ち（下の `accounting_g_fact_seq_at` で直した番号）・`accounting_record_unit_refund` の検査（NULL）が、この道具だけを使う。
  - `private.accounting_g_fact_seq_at(_at timestamptz) RETURNS bigint`（STABLE。入口なし）。Stripe の時刻と比べる W だけが使う。`accounting_g_slip_facts` と `accounting_unit_refund_allocations` の行のうち `locked_at <= _at` の物の `fact_seq` の最大（無ければ0）。`locked_at` は番号を取った時の `clock_timestamp()` で、鍵を持ってから取るので、トランザクションの始まりと鍵の間の隙間で順が入れ替わらない。番号で切るので、時計が戻った時も前後の番号の順は崩れない。
  - `private.accounting_unit_values(_order_id uuid, _as_of_seq bigint) RETURNS TABLE(order_item_id uuid, unit_index integer, shipped boolean, value integer)`（STABLE。入口なし）。着の値打ちの式を1つにする道具。その注文の `order_line_unit_amounts` の各着について、`value` は `paid_amount` から `fact_seq <= N` の割り当ての合計（N が NULL なら全部）を引いた額、`shipped` は `accounting_shipped_units(その品, N)` に含まれるか。出荷済みの着も未出荷の着も同じ『支払額 − 割り当て』で数える（出荷の仕訳の額と同じ物差し）。W の値打ち（Task 6）と計画3の 5-g の重みがこの道具を使う。
  - `private.accounting_cutover_on() RETURNS date`（STABLE。`accounting_settings` の `cutover_on`）。
  - `private.accounting_period_for_event(_date date, _actor_id uuid DEFAULT NULL) RETURNS uuid`（計画1の Task 7 が作る道具をそのまま使い、ここでは作らない。計画2の係は `_actor_id` に NULL を渡す。VOLATILE）。規則の正本は計画1 Task 7 だけで、個人のやめた日より後に新しい個人の期間を作らない決まりも引き継ぎ、やめた日より後の日付の出来事は、`current_business_type` を法人へ切り替えるまで法人の期間へ入れず `ACCOUNTING_PERIOD_MISSING`（`period_missing`。早すぎるやめた日の登録だけでは黙って法人へ入らない）で止める。出荷の取り消しの期間は計画1の core が元の事業の形で引く（ここでは選ばない）。期間が無ければ `ACCOUNTING_PERIOD_MISSING / 55000`、自動で作れる年の範囲外は `ACCOUNTING_ARGUMENT_INVALID`。後者は出来事ごとの `posting_error` に止める。
  - `private.accounting_park_event(_kind text, _source_table text, _source_id text, _order_id uuid, _reason text, _detail jsonb) RETURNS void`。同じ `(_kind, _source_table, _source_id)` の未解決の行があれば `reason`・`detail`・`last_detected_at` を更新して回数を増やし、無ければ入れる。解決済みの行があれば何もしない（人が確認済みにした物を開き直さない）。`private.accounting_unpark_event(_kind text, _source_table text, _source_id text, _entry_id uuid) RETURNS void` は未解決の行を解決済みにして `resolved_entry_id` を入れる。どちらも入口なし・service_role からも REVOKE。理由が `period_missing` の呼び出しはすべて、`_detail` に入れようとした仕訳の日 `entry_date`（`YYYY-MM-DD`）を必ず入れる。`ACCOUNTING_PERIOD_MISSING` の DETAIL が `sole_ended_not_switched` の時は、`cause: 'sole_ended_not_switched'` も入れる（出来事ごとの失敗の扱いと同じ。生の DETAIL は残さない）。計画3・5の係と、計画6が作り直す係にも同じ契約（`entry_date` と、DETAIL の時だけの `cause`）を当てる。計画3（S20・S21・S22）・計画5（S32・S33）・計画6（Task 3）の本文にも `cause` の受け渡しを書いてある。`posting_error` の `_detail` は上の出来事ごとの失敗の扱いの鍵と値だけを許す。
  - `private.accounting_record_unit_refund(_refund_key text, _order_item_id uuid, _unit_index integer, _amount integer) RETURNS void`（入口なし。計画3が出荷前の返金の時に呼ぶ）。最初に `accounting_take_g_fact_seq()` で番号を取る（G の鍵を持たない呼び出しは `GROUP_H_LOCK_REQUIRED` で断る）。その着が `private.accounting_shipped_units(その品, NULL)`（今。計画3が書く前に確かめるのと同じ物差し）に含まれる（出荷済み）なら `ACCOUNTING_ARGUMENT_INVALID`（出荷前の返金だけ。負の行も同じ。出荷の額は『支払額 − 割り当て』で固定されるため、戻せない。G で取り消した発送票の着は、取り消しの番号の後は出荷済みでない）。負の行は、キーが `release:<元のキー>:<n>` で、元のキーと `reapply:<元のキー>`・`cover:<元のキー>` の正の合計から `release:<元のキー>:*` の合計を引いた範囲だけ受ける。`reapply:<キー>`・`cover:<キー>` の正の行も受ける。行の `fact_seq`・`locked_at` には取った番号と時刻を入れる。
- Produces（G の関数に足す1行。S6）: 確定と取り消しの2本だけ。どちらも最新の定義（確定は `20261026045859_group_g4_orders_foundation.sql:6`、取り消しは `20261025100130_group_g3_shipping_slips.sql:749`）を一字も変えずに写し、足す所だけ `-- ACC_P2_BEGIN` 〜 `-- ACC_P2_END` で囲む。**本文の比べ方は初めから『囲みを全部除く』形にする**: SQL は `regexp_replace(本文, '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g')`、TS は `/-- ACC_P\d_BEGIN[\s\S]*?-- ACC_P\d_END/g` で、両方の側（DB の本文と G-4・G-3 の文）を除いてから空白を除いて比べる（後の計画が `ACC_P3` などの囲みを足しても、この確かめと試験は直さずに通る）。番号は1桁で書く（SQL で `[0-9]+` と書くと、Postgres の正規表現は式の最初の数え方で式全体が欲張りになり、最初の BEGIN から最後の END までを一度に消して、囲みの間の元の文の違いを見逃すため）。引数・戻り型・SECURITY・`search_path`・ACL・所有者は変えない。G の鍵を取る順も変えない（どちらも最初の `lock_group_g_shipment_slips` で鍵を取った後に足す）。
  - `private.admin_confirm_shipment_slip`: `UPDATE public.shipment_slips SET stage = 'confirmed', …` の直後に `PERFORM private.accounting_record_slip_fact(_slip_id, 'confirm')`。
  - `private.admin_cancel_shipment_slip`: `UPDATE public.shipment_slips SET stage = 'cancelled', …` の直後に `PERFORM private.accounting_record_slip_fact(_slip_id, 'cancel')`。
  - 再送の枝（同じ要求番号で前の結果を返す枝）は変えないので、再送で番号は増えない。拒否で落ちれば番号の行も残らない。G の書き手の一覧 `private.group_g_writer_allowlist()` は変えない（足す道具は G の表を書かない）。
  - 移行の最初に、`stage IN ('confirmed','cancelled')` の発送票が0件であることを確かめる（本番・`db reset` した手元とも0。設計 0-4）。0でなければ番号の無い発送票ができるので `ACCOUNTING_MIGRATION_ASSERTION_FAILED`（DETAIL `acc_s6_slip_fact_backfill`）で止める。
  - 試験の fixture が G の表へ直接発送票を入れる時（Task 3 の `seedConfirmedSlip`）は、同じトランザクションで G の鍵を取ってから `accounting_record_slip_fact` を呼ぶ。
- Produces（読み口と書き口）: `public.list_accounting_pending_events(_include_resolved boolean DEFAULT false, _limit integer DEFAULT 50, _after_at timestamptz DEFAULT NULL, _after_id uuid DEFAULT NULL) RETURNS jsonb`（`{events:[…],next_after_at,next_after_id,open_count}`、STABLE・service_role 専用、`MAX_PENDING_PAGE=100`、`first_detected_at` の新しい順）と `public.get_accounting_pending_summary() RETURNS jsonb`（`{open_count,by_reason:{<reason>:n},oldest_at}`）。書き口 `admin_resolve_accounting_pending_event(_actor_id uuid, _event_id uuid, _note text, _request_key uuid) RETURNS jsonb`（private 本体＋service_role 専用の public 入口。権限 `admin.accounting.entries.correct`。メモは1〜500字。未解決の行を人の確認済みにする。確認済みにできるのは、新しい帳簿の外の出来事の理由か、額が0の理由 `before_cutover`（切り替えより前の出来事）と `no_revenue` だけで、ほかの理由は `ACCOUNTING_EVENT_NOT_POSTABLE`（お金の動く出来事は、仕訳が入るまで閉じられない。2026-11-04 AI の判断）。解決済みなら `ACCOUNTING_PENDING_RESOLVED`、同じ要求番号で同じ内容は前の結果、違う内容は `ACCOUNTING_REQUEST_KEY_CONFLICT`）。
- Produces（ラベル）: `ACCOUNTING_LABELS`（`src/lib/accounting/labels.ts`。仕訳の説明・メモ・相手の日本語。例: `stripeJapan:'ストライプジャパン株式会社'`、`feePayment:'決済の手数料'`、`feeDispute:'取り消しの手数料'`、`feeFx:'為替の手数料'`、`shipmentCancelled:'出荷の取り消し'`）。`scripts/accounting/emit-labels.ts` が SQL の `U&'\XXXX'` 形を標準出力へ出し、S7〜S11 の本文に貼る。`labels.test.ts` が SQL の本文と TS の一致を確かめる。
- Produces（定期処理の名前）: `ops_job_heartbeats_job_check` を作り直し、今の7つに `accounting_post` を足す（既存の行は変えない DDL。最新の定義は `20261021220816_delivery_tracking_records.sql:534-536`）。S6 の assert の許可の一覧に書く。
- Produces（試験の道具）: `tests/integration/db/helpers/accounting-orders-fixtures.ts` に `setCutoverForTest(client, date)`（ROLLBACK の中で postgres として `accounting_settings.cutover_on` を前へ動かす）を置く。
- Produces: S6 assert DETAIL `acc_s6_tables`・`acc_s6_constraints`・`acc_s6_immutable`・`acc_s6_rls_acl`・`acc_s6_function_attrs`・`acc_s6_heartbeat_check`・`acc_s6_seq_acl`（sequence に権限なし）・`acc_s6_slip_fact_backfill`・`acc_s6_g_body_unchanged`（確定と取り消しの2本の、囲みを全部除いた本文が最新の定義と同じ。上の式で除き、空白を除いて比べる）・`acc_s6_g_function_attrs`（2本の引数・戻り型・属性・ACL・`search_path`・所有者が前と同じ）・`acc_s6_g_allowlist_unchanged`・`acc_s6_existing_dml_allowlist`（DML は無い）。

- **計画6への試験の引き渡し:** 計画6の実装の最初に controller が Task 3 の Files へ `tests/integration/db/accounting_p2_posting_tables.integration.test.ts` を足し、`FREQ-569-AC-01` の `detail` の鍵の許可の一覧が、計画6の止めで使う `why`・`e_entry_date`・`n_entry_date`・`record_kind`・`record_id` でも通るかを確かめる。各鍵を日付・固定の語・識別子・0以上の整数に限る既存の守り（理由ごとの許可の一覧は Task 3 Step 1）は保ち、必要な鍵だけを許可の一覧へ足す。計画2の `cause`（やめた日より後で法人へ未切り替えの印）は計画6の `why` と別の鍵とし、`why` に寄せない。計画6の Task 本文と試験を直すのはその実装時で、今回の引き渡しは計画6の「前の計画から計画6への引き渡し（2026-11-05）」に記録する。

- [ ] **Step 1: 失敗する試験を書く。** DB の試験は ROLLBACK の形。`FREQ-569-AC-01: 計上待ちは出来事ごとに1行で、同じ出来事の2回目は回数と最後の日時だけが変わる`、`FREQ-569-AC-01: 理由の値は決めた値だけを受ける`、`FREQ-569-AC-01: 計上待ちの詳細に個人の情報を入れる鍵は無い（鍵は固定）`（`detail` の鍵の許可の一覧は止めの理由ごとに、次で全部とする。`period_missing` は `entry_date`（`YYYY-MM-DD`、必須）・`cause`（値は `sole_ended_not_switched` だけ。DETAIL の時だけ）。`posting_error` は `error_sqlstate`（5桁の英数字）・`error_code`（固定コードまたは `unexpected_error`）・`entry_date`（`YYYY-MM-DD`、分かる時だけ）。`amount_mismatch` は `stripe_amount`・`order_total`（どちらも0以上の整数）。`order_not_postable` は `reason`（`shipping`・`units_sum`・`units_missing`）。`payment_journal_missing` は `order_count`（0以上の整数）。`deferred_revenue_short` は `shortage`（0以上の整数）。`payout_mismatch` は `payout_state`（`payout_not_posted`・`payout_net_zero`。どちらでもない照合待ちは鍵なしの `{}`）。`dispute_withdrawal_missing` は `waiting_on`（`dispute_account_unassigned`）・`dispute_status`（Stripe の dispute の状態の名前。英小文字と `_` の40字まで）。`no_revenue` は `lost_on`（`YYYY-MM-DD`）。ほかの理由は鍵なしの `{}`。その理由に許していない鍵・生の例外の文・未知の鍵・`cause` の別の値・整数の鍵の負の数や文字を断ることを確かめる）、`FREQ-569-AC-03: 確認済みにできる理由はbefore_cutoverとno_revenueだけで、お金の動く理由はEVENT_NOT_POSTABLEで断られる`、`FREQ-569-AC-01: ops_job_heartbeatsのjobにaccounting_postが通る`、`FREQ-569-AC-03: 確認済みにできるのは権限のある人だけで、2回目はPENDING_RESOLVED、同じ要求番号の再送は前の結果`、`FREQ-569-AC-03: 確認済みの行は同じ出来事を再び止めても開き直されない`、`FREQ-563-AC-03: 割り振りは端数を番号の若い順に1円ずつ足し合計が元の額に合う`（`10円を[1,1,1]→[4,3,3]`、`0円`、重み0の要素は0のまま、`[2,0,1]`で`5円→[4,0,1]`）、`FREQ-563-AC-03: 重みの合計が0で額が正なら拒む`、`FREQ-563-AC-03: TSとSQLの割り振りは同じ値を返す`（15本の固定のベクトル）、`FREQ-563-AC-03: 送った着の記録と返金の割り当ては追記専用でUPDATEとDELETEとTRUNCATEを断る`、`FREQ-563-AC-02: 返金の割り当ての合計が1着の支払額を超えると断る`、`FREQ-563-AC-02: 戻しの負の行は release のキーで元の正の合計の範囲だけ受け、出荷済みの着（accounting_shipped_units）への負の行と正の行を断り、reapply と cover の正の行を受ける`、`FREQ-563-AC-03: 出荷済みの着は G の鍵の中で取った番号で決まり、出荷の仕訳が入る前でも後でも同じ着になる（全額の割り当てを受けた着は送る着から除かれ、H の確保は同じトランザクションで書く全額の割り当てを通して除かれ、番号の小さい着から数量ぶん取る）`、`FREQ-563-AC-03: 確定のトランザクションが先に始まっても鍵を後に取った発送票は後に数え、確定の時刻（now()）の順と鍵の順が入れ替わっても2つの発送票の取る着が重ならず、ある番号の答えは後からコミットした行で変わらない`（2つの接続で、先に始めた方を鍵の前で待たせる。並行。3連続）、`FREQ-563-AC-03: 番号はG の鍵を持たない呼び出しでは取れずGROUP_H_LOCK_REQUIRED、確定と取り消しの再送では増えず、拒否された確定では残らない`、`FREQ-563-AC-03: Stripe の時刻から直した番号は、その時刻までに鍵の中で取った番号の最大`、`FREQ-563-AC-03: 着の値打ちは出荷済みでも未出荷でも支払額−番号までの割り当て`、`FREQ-563-AC-02: 出荷済みの着（accounting_shipped_units）への返金の割り当ては断る`、`FREQ-563-AC-03: 番号を取る1行を足した確定と取り消しの2本は、囲みを全部除いた本文が最新の定義と同じで、属性とACLが前と同じ`（既存の `group_g4_foundation` の `FREQ-540-AC-14` は題を変えず、囲みを全部除いた本文で比べる期待に直す）、`FREQ-563-AC-03: 囲みの除き方は、ACC_P2 と別の番号（ACC_P3）の囲みを足した本文も最新の定義と同じと見て、2つの囲みの間の元の文の1字の違いは見逃さない`（作った文に同じ式を当てる）、`FREQ-569-AC-05: 期間の決め方は取引の日を含む期間を探し、個人と法人の両方があればcurrent_business_typeの期間を選ぶ`（期待の答えの表と比べる。トリガーと同じ答えの試験は計画1の Task 9 に置く）、`FREQ-562-AC-01: 記録の人がNULLの自動の計上を受けてrecorded_byがNULLになる`（計画1の core の動きの確認。落ちたら controller に知らせ、計画1の側を直す）、`FREQ-569-AC-01: 計上待ちの表はanonとauthenticatedに権限が無くservice_roleはSELECTだけ`。単体: `FREQ-563-AC-03: TSの割り振りは合計を保つ`（ランダム100本、合計一致・非負）、`FREQ-569-AC-01: 計上待ちの理由の一覧はSQLのCHECKと一致する`。
- [ ] **Step 2（controller）: RED を測る。** `npx.cmd jest tests/integration/db/accounting_p2_posting_tables.integration.test.ts tests/integration/db/accounting_p2_migration_asserts.integration.test.ts --runInBand` と単体3本。表が無い失敗を記録し、接続の失敗を RED に数えない。
- [ ] **Step 3: S6 と TS を実装する。** Interfaces どおり。`private.accounting_period_for_event` は計画1の Task 7 の道具を呼ぶだけで、作らない（試験 `FREQ-569-AC-05` が期待の答えの表を守る。トリガーと同じ答えの試験は計画1の Task 9）。計画1の core は `_actor_id IS NULL` をそのまま受ける作りなので、直さない。
- [ ] **Step 4（controller）: 共通 verify で GREEN を測る。** 末尾 assert を SAVEPOINT 内で、RLS 無効/追記専用トリガー無効/UNIQUE 欠落/CHECK 欠落/確定の関数の囲みの外の1字の改ざんへ1つずつ改ざんして流し、55000 と対応 DETAIL を検査する。Files の Test に書いた G の既存の suite を流し、`FREQ-540-AC-14` 以外は無改造で通ること。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 計上待ちと送った着の記録と割り振りの道具を追加する`

### Task 2: 支払いの仕訳（1-a01・2-a・4-a）

controller が別セッションへ `src/lib/stripe/**` の変更を先に知らせる（この Task では `accounting-sync.ts` の確認だけで、変更は Task 4・5・10）。Task 1 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-562 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts7>_accounting_p2_payment_posting.sql`、`tests/integration/db/accounting_p2_payment_posting.integration.test.ts`、`tests/integration/db/accounting_p2_payment_concurrency.integration.test.ts`
- Modify: `tests/integration/db/accounting_p2_migration_asserts.integration.test.ts`（S7 の assert を足す）、`tests/integration/db/helpers/accounting-orders-fixtures.ts`（`seedPaidOrder`・`seedStripeCharge` を足す）
- Test: 上の DB 2 suite
- Read: `src/lib/stripe/accounting-sync.ts:69-82`（残高の取引を `order_id`・`payment_intent_id` つきで保存する所）、`src/lib/stripe/accounting-types.ts`、`supabase/migrations/20260901102912_remote_schema.sql:907`（`stripe_balance_transactions`）、recon-part-C 1.1

**Interfaces:**
- Consumes: `stripe_balance_transactions`（`type in ('charge','payment')` の行〔`reporting_category` は `charge`〕で `payment_intent_id` がある物）、`orders`（`payment_intent_id`・`total_amount`・`shipping_amount`。`orders` に税の別欄は無い〔税の欄は `checkout_drafts.tax_amount` だけ〕）、`order_line_unit_amounts`、計画1の core。
- Produces: `private.accounting_post_payment_events(_limit integer) RETURNS jsonb`（`{posted,parked,resolved}`。入口なし・service_role からも REVOKE。Task 6 の `public.accounting_run_posting` だけが呼ぶ）。試験は postgres 接続から直接呼ぶ。
- 擬似コード（試験で決まらない所だけ）:
  1. 最初に `private.accounting_lock_all(NULL)`。行ロックは取らない。
  2. 候補: 上の取引のうち、印 `payment_confirmed:<payment_intent の番号>`（`private.accounting_event_key('payment_confirmed', ARRAY[pi])`）の仕訳が無く、計上待ちの行（未解決も解決済みも）も無い物（新しい出来事）。`stripe_created_at`、`id` の順に `_limit` 件（候補の選び方は上の「係の候補の選び方」に従い、未解決は別枠で10件見直す）。
  3. 注文を探す: `orders.payment_intent_id = 取引.payment_intent_id`（UNIQUE）。無ければ取引の `order_id`。それも無ければ `no_revenue` でなく `no_order` で止める。
  4. 日: `d = private.accounting_jst_date(取引.stripe_created_at)`（4-a: `orders.paid_at` は使わない）。`d < private.accounting_cutover_on()` なら `before_cutover`。期間は `private.accounting_period_for_event(d)`（`ACCOUNTING_PERIOD_MISSING` を捕まえて `period_missing`。`accounting_park_event` の `_detail` に `entry_date = d`〔`YYYY-MM-DD`〕を必ず入れる）。
  5. 検査（2-c）: 取引の `amount` ≠ `orders.total_amount` → `amount_mismatch`（detail は `stripe_amount`〔取引の額〕・`order_total`〔`orders.total_amount`〕の2つ）。`orders.shipping_amount <> 0`（既定は500だが決済は0を入れる。fixture は送料0を必ず入れる）または `order_line_unit_amounts` の `paid_amount` の合計 ≠ `orders.total_amount`（旧い注文で行が無い場合を含む）→ `order_not_postable`（detail に `reason`: `shipping`・`units_sum`・`units_missing`）。
  6. 仕訳: 種類 `payment_confirmed`、印の番号 `[payment_intent の番号]`、日 `d`、期間、`description = ACCOUNTING_LABELS.paymentReceived`、行1: 借方 1160 に総額（`order_id` つき）、行2: 貸方 2150 に総額（`order_id` つき）。`source_table='stripe_balance_transactions'`、`source_id=取引.id`、`_actor_id` は NULL。返りが `created=false`（既にあった）でも成功として扱う。
  7. 成功したら `accounting_unpark_event`。止めた時は `accounting_park_event('payment_confirmed','stripe_balance_transactions',取引.id,注文,理由,detail)`。
- Produces: S7 assert DETAIL `acc_s7_functions`・`acc_s7_function_attrs`・`acc_s7_existing_dml_allowlist`。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-562-AC-01: 支払いは借方1160貸方2150の仕訳1本で、額は手数料を引く前の総額で、2150の行に注文番号が付く`、`FREQ-562-AC-01: 印は payment_confirmed:<payment_intent>`、`FREQ-562-AC-02: Stripeの総額が注文の合計と違えばamount_mismatchで止め仕訳を作らない`、`FREQ-562-AC-02: 送料の欄が0でない注文はorder_not_postableで止まる`、`FREQ-562-AC-02: 1着ごとの支払額の合計が注文の合計と違う注文と、支払額の行が無い注文は止まる`、`FREQ-562-AC-03: 1月1日の朝8時（日本時間）の支払いは1月1日の仕訳で、12月31日の期間に入らない`（`stripe_created_at='2026-12-31T23:00:00Z'` と `orders.paid_at` を別の日にして、`paid_at` を使っていないことを確かめる）、`FREQ-562-AC-04: 切り替えの日より前の日の支払いはbefore_cutoverで止まる`、`FREQ-562-AC-04: 期間が無い日はperiod_missingで止まり、期間を作ると次の呼び出しで入って計上待ちが解決される`、`FREQ-562-AC-05: 同じ支払いを2回流しても1本で2回目はcreated=false`、`FREQ-562-AC-05: 同時に流しても1本だけ残り通し番号に欠番ができない`（並行。`pg_blocking_pids` で待ちを観測、3連続成功）、`FREQ-562-AC-01: 支払いの途中の注文でも払われたお金があれば仕訳にする（お金の事実を正とする）`、`FREQ-562-AC-01: 記録の人はNULLで登録日時は流した時刻になる`、`FREQ-562-AC-02: 手数料の行は支払いの仕訳に入れず別の出来事にする`（支払いの仕訳は2行だけ）、`FREQ-562-AC-05: 店頭の取引（注文に結び付かない支払い）はno_orderで止まる`、`FREQ-569-AC-01: 支払いがperiod_missingで止まるとdetail.entry_dateに取引の日本時間の日がYYYY-MM-DDで入る`。
- [ ] **追加の試験を書く。** `FREQ-569-AC-06: 支払い1件がcoreで失敗しても次の支払いは計上され失敗した方だけがposting_errorに残る`（最初を core の検査で落とし、見出し・行・採番が残らず、次は入ることを確かめる）、`FREQ-569-AC-06: 範囲外の年の出来事はposting_errorになり同じ呼び出しの正常な出来事は入る`。
- [ ] **Step 2（controller）: RED を測る。** 上の DB suite。関数が無い失敗を記録する。
- [ ] **Step 3: S7 を実装する。** SQL は ASCII、ラベルは Task 1 の出力を貼る。期間の解決から成功の記録までを出来事1件ごとの例外処理にする。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。並行は3連続成功。S7 の末尾 assert の改ざん試験。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 支払いの確定を前受金の仕訳として保存する`

### Task 3: 出荷の仕訳・取り消し・日の直し（1-a02・1-a03・2-b〜2-i・6-a・6-b）

controller が別セッションへ先に知らせる（G の出荷の関数と表は読むだけで変えない）。Task 2 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-563・564 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts8>_accounting_p2_shipment_posting.sql`、`tests/integration/db/accounting_p2_shipment_posting.integration.test.ts`、`tests/integration/db/accounting_p2_shipment_corrections.integration.test.ts`、`tests/integration/db/accounting_p2_shipment_concurrency.integration.test.ts`
- Modify: `tests/integration/db/accounting_p2_migration_asserts.integration.test.ts`、`tests/integration/db/helpers/accounting-orders-fixtures.ts`（`seedConfirmedSlip`〔G の表へ直接入れて出荷日を決める。同じトランザクションで G の鍵を取り `accounting_record_slip_fact` で確定の番号も入れる。Task 1〕・`cancelSlip`・`correctShipmentDate`〔G の関数を呼ぶ。日は支払いの日以後・今日以前〕を足す。上の「試験の日付」の決まりに従う）
- Test: 上の DB 3 suite
- Read: `supabase/migrations/20261026045859_group_g4_orders_foundation.sql:134-215`（確定の関数の順序）、`20261025134538_group_g3_shipping_actions.sql:841-948`（日の直し）、`20261025100130_group_g3_shipping_slips.sql:749-894`（取り消し）、`20261025070821_group_g3_shipping_reads.sql:298-318`（変えない読み口）、`tests/integration/db/group_g3_date.integration.test.ts`（fixture の手本）

**Interfaces:**
- Consumes: `shipment_slips`（`id`・`number`・`stage`・`shipment_date`・`confirmed_at`）、`shipment_slip_fulfillments`、`shipment_slip_lines`、`order_fulfillments`（`shipment_date`・`cancelled_at`）、`order_fulfillment_lines`、`order_items`（`line_kind`・`item_name`）、`order_line_unit_amounts`、`shipment_date_history`、Task 1 の表と道具、Task 2 の支払いの仕訳。G の表・関数は変えない。送った品と数の正は `shipment_slip_lines`（設計 2-3。決めたこと）。`order_fulfillment_lines` と食い違えば `shipment_lines_mismatch` で止める。
- Produces: `private.accounting_post_shipment_events(_limit integer) RETURNS jsonb`（`{posted,parked,resolved,reversed,redated}`。入口なし）。
- 擬似コード（試験で決まらない所だけ）:
  1. 最初に `private.accounting_lock_all(NULL)`。G の表の行ロックは取らない。以下 (a)(b)(c) の順に、合わせて `_limit` 件まで。
  2. **(a) 確定** 候補: `shipment_slips.stage='confirmed'` で、印 `shipment_confirmed:<number>` の仕訳も、計上待ちの行（未解決も解決済みも）も無い物（新しい出来事。確定の番号の順。候補の選び方は「係の候補の選び方」に従う）。
     - 日の検査（6-a）: その発送票の全部の `order_fulfillments.shipment_date` が `shipment_slips.shipment_date` と同じ。違えば `shipment_date_mismatch`。`d < cutover_on` なら `before_cutover`。期間は `accounting_period_for_event(d)`（無ければ `period_missing`）。
     - 注文ごとに、取り消されていない `payment_confirmed` の仕訳が必要。1つでも無ければ `payment_journal_missing`（detail は注文の数 `order_count` だけ。個人の情報を入れない）。**仕訳の有無だけで判断し、`orders.status` や `paid_at` を見ない**（1-d）。
     - 発送票の中の品ごとに数量を集める（`shipment_slip_lines`。`order_fulfillment_lines` の品ごとの数量と比べ、違えば `shipment_lines_mismatch`）。`order_items.line_kind='exchange'` の品は飛ばす（2-i・1-a17。売上を作らない。原価・在庫の動きは計画5が `exchange_movement` で足す）。
     - 送る着: `private.accounting_shipped_units(その品, その発送票の確定の番号 c(s))`（Task 1。`accounting_g_slip_facts` の `kind='confirm'` の `fact_seq`）が、その発送票に当てる着（`slip_id` がその発送票の行。数量ぶん、番号の若い順。除く着は道具の中で決まる。出荷の仕訳が入っているかどうかは見ない）を使う（2-h）。確定の事実の行が無い発送票は無い（S6 の後の確定は必ず番号を取り、S6 の前の確定は0件）。足りなければ `units_insufficient`。額は各着の `paid_amount` から、その着の `accounting_unit_refund_allocations` の合計を引いた値（2-c。割り当ては計画3が書く。無ければ引かない）。
     - 前受金の確認（2-a）: 注文ごとに、その発送の額が、全部の仕訳（元も取り消しも足す）の `order_id` つき 2150 の残高（貸方−借方）以下であること。超えれば `deferred_revenue_short`（detail は不足額 `shortage`）。
     - 行: 品ごとに、借方 2150 に額（`order_id` つき、メモは `品名 × 数量`）、貸方 4010 に同じ額（`order_id` つき）。額が0の品は行にしない。行が1つも無ければ `no_revenue` を入れて直ちに解決済みにして終わる。
     - 仕訳: 種類 `shipment_confirmed`、番号 `[発送票の番号]`、日 `d`、説明 `ACCOUNTING_LABELS.shipmentRevenue`、`source_table='shipment_slips'`・`source_id=発送票の id`。`_source_recorded_at` に発送票の `confirmed_at` を渡す（出荷が計上待ちに長く止まっても、発送票をすぐ確定していれば遅れの印が付かない）。続けて、使った着を `accounting_shipment_units(entry_id, …)` に入れる。成功したら `accounting_unpark_event`。
  3. **(b) 取り消し** 候補: 取り消されていない `shipment_confirmed`/`shipment_redated` の仕訳で、その発送票が `stage='cancelled'` の物。`private.accounting_reverse_journal_core(NULL, 仕訳, ACCOUNTING_LABELS.shipmentCancelled, NULL, 発送票の cancelled_at)`（日は元の日。2-f。最後は出来事の記録の日時）。着は取り消しで自動で「まだ送っていない」に戻る（道具は取り消しの番号より後の番号では、その発送票を数えないから）。その発送票に未解決の計上待ちの行があれば、取り消されたので自動で解決済みにする（`no_revenue` と同じ印）。
  4. **(c) 日の直し** 候補: 取り消されていない出荷の仕訳 E で、発送票が `stage='confirmed'` かつ E の日 ≠ 今の `shipment_date` の物。最新の `shipment_date_history`（`kind='correction'`、`version` の大きい順）の行 h を取る（無ければ飛ばす）。**先に**新しい日の検査（切り替え・期間・発送ごとの日の食い違い）を済ませ、止める時は E を取り消さず、種類 `shipment_redated`・`source_id=h.id` で計上待ちに置く。通れば、E を取り消し（理由は h の理由、日は元の日、出来事の記録の日時は h の `created_at`）、種類 `shipment_redated`・番号 `[h.id]`・新しい日・E と同じ行で入れ直し、E の着の記録を新しい仕訳へ写す。取り消しと入れ直しは同じ呼び出しの中で行う。古い日の直しが新しい直しに追い越された場合は、古い直しの未解決の計上待ちの行を自動で解決済みにする。
- Produces（読み口。STABLE・service_role 専用）: `public.get_shipment_journal_trace(_slip_id uuid) RETURNS jsonb`（`{slip:{number,confirmed_at,shipment_date,stage},history:[{version,kind,previous_date,new_date,reason,actor_id,created_at}],entries:[{entry_id,entry_no,event_kind,entry_date,recorded_at,reverses_entry_id}]}`。6-b の「仕訳から発送票の直した跡をたどる」）と、`public.list_journal_shipment_meta(_entry_ids uuid[]) RETURNS TABLE(entry_id uuid, slip_number text, shipment_date date, confirmed_at timestamptz)`（6-c の「出荷した日」と「登録した日」を並べる材料。200件まで）。
- Produces: S8 assert DETAIL `acc_s8_functions`・`acc_s8_function_attrs`・`acc_s8_reads_stable`・`acc_s8_g_untouched`（G の表・トリガー・関数の定義が移行の前後で同じ。比べるトリガーは `tgisinternal = false` だけで、外部キーが作る内部のトリガーは除く）・`acc_s8_existing_dml_allowlist`。

- **出来事の失敗（S8）:** 確定・取り消し・日の直しは、1件に含まれる仕訳と送った着の記録を丸ごと例外処理で包む。日の直しの後半で落ちた時も前半の取り消しを残さず、`posting_error` に理由を残して次の発送票へ進む（Global Constraints）。`FREQ-569-AC-06: 出荷1件の失敗で取り消しや着の記録の片方だけを残さずほかの出荷は計上される` を Step 1 の DB の試験に足す。
- **期間が無い時の日付（S8）:** 確定・日の直しを含むすべての `period_missing` の止めで、`accounting_park_event` の `_detail.entry_date`（`YYYY-MM-DD`）を必須にする。確定は `shipment_date`、日の直しは新しい `shipment_date`。計画6 Task 3 がこの係を作り直して取り消しの止めを足す時も必須で、取り消しは取り消そうとした仕訳の日、組の出来事は計画6の規則どおり `open` でない方の日（両方とも `open` でなければ早い方の日）を入れる。

- [ ] **Step 1: 失敗する試験を書く。** 設計 2-4 の例を数字で固定する: 注文 30,000円（シャツ 18,750・パンツ 11,250）。`FREQ-563-AC-01: 一部の出荷は送った着の額だけで、シャツの出荷は18,750円、前受金の残りは11,250円になる`、`FREQ-563-AC-01: パンツの出荷で前受金が0になり売上の累計は29,000円になる`（出荷前の返金の割り当て1,000円を挟む。次の AC-02 と同じ流れで）、`FREQ-563-AC-02: 出荷前の返金の割り当てがあれば、その着の額から引く（パンツ11,250−1,000＝10,250円）`、`FREQ-563-AC-03: 同じ品を2着、支払額が9,999円と10,001円なら1着目の出荷は番号の若い着の9,999円、2着目は10,001円`、`FREQ-563-AC-03: 同じ発送票を取り消して出し直すと、送った着は番号の若い順に戻る`、`FREQ-563-AC-04: 支払いの仕訳が無い注文の出荷はpayment_journal_missingで止まり、支払いの仕訳が入ると次の呼び出しで1本入って計上待ちが解決される`、`FREQ-563-AC-04: orders.statusやpaid_atが払い済みでも、支払いの仕訳が無ければ出荷を仕訳にしない`、`FREQ-563-AC-04: 発送ごとの出荷日と発送票の出荷日が違えばshipment_date_mismatchで止まる`、`FREQ-563-AC-04: 出荷の額が前受金の残りより多ければdeferred_revenue_shortで止まる`、`FREQ-563-AC-04: 送る着が足りなければunits_insufficientで止まる`、`FREQ-563-AC-04: 切り替えの日より前の出荷日はbefore_cutover`、`FREQ-563-AC-05: 交換の品（line_kind=exchange）の行は売上にならず、交換だけの発送票はno_revenueで解決済みになる`、`FREQ-563-AC-06: 同じ発送票を2回・同時に流しても1本だけ`（並行。3連続）、`FREQ-563-AC-01: 1枚の発送票に2つの注文があれば、品ごとの行にそれぞれの注文番号が付き、仕訳は1本`、`FREQ-563-AC-01: 12月28日に払い翌年1月5日に出荷した注文は、前受金が12月31日の残高に残り、売上は翌年の期間に入る`（2つの期間）、`FREQ-563-AC-04: 発送票の明細と発送ごとの明細の数量が食い違えばshipment_lines_mismatchで止まり、直ると入る`、`FREQ-563-AC-04: 未解決の計上待ちの発送票が取り消されると、計上待ちが自動で解決済みになる`、`FREQ-564-AC-04: 出荷が計上待ちに2か月以上止まっても、発送票をすぐ確定していれば遅れの印が付かず、recorded_atは係が入れた時刻になる`、`FREQ-563-AC-01: 手数料や入金の行を出荷の仕訳に入れない`、`FREQ-569-AC-01: 出荷の確定と日の直しがperiod_missingで止まるとdetail.entry_dateに入れようとした仕訳の日が入る`。
  取り消し・日の直し: `FREQ-564-AC-01: 発送の取り消しは元の仕訳の借貸を入れ替えた仕訳を足し、元の日の日付で、元の仕訳は変わらない`、`FREQ-564-AC-01: 取り消した発送票の着は、もう一度出荷すれば同じ着から送られる`、`FREQ-564-AC-02: 出荷日の直しは、元の日の取り消しと、直した日の同じ行の仕訳になる`（印は `reversal:<元>` と `shipment_redated:<履歴の行の番号>`）、`FREQ-564-AC-02: 日の直しで別の期間にまたがっても、取り消しは元の期間、正しい仕訳は新しい期間に入る`、`FREQ-564-AC-02: 直した先の日が期間の無い日ならperiod_missingで止まり、元の仕訳は取り消されないまま残る`、`FREQ-564-AC-02: 日を2回直しても取り消しは1回ずつで、最後の日の仕訳だけが残る`、`FREQ-564-AC-02: 同じ直しを何度・同時に流しても1回だけ`、`FREQ-564-AC-03: 仕訳から発送票の直した跡（理由・人・前後の日）をたどれる`（`get_shipment_journal_trace`）、`FREQ-564-AC-04: 出荷した日と登録した日を並べる材料に、出荷の仕訳の日と発送票を確定した日が出る`（確定した日は仕訳の登録日時ではない）、`FREQ-563-AC-04: G-3の読み口list_shipment_accounting_inputsの列と動きは変わらない`（`group_g3_reads` の既存の期待をそのまま引く）。
- [ ] **Step 2（controller）: RED を測る。** 上の DB suite。
- [ ] **Step 3: S8 を実装する。** 係は G の表を読むだけで、`FOR SHARE`/`FOR UPDATE` を使わない。着の選び方・額の計算は plpgsql の中の1か所の関数にまとめ、確定と日の直しの両方がそれを使う。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。加えて `group_g3_*`・`group_g1_writer_inventory`・`group_h_migration_asserts` の既存の suite が無改造で通ること（`acc_s8_g_untouched` の確認）。並行は3連続成功。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 出荷の確定と取り消しと日の直しを仕訳として保存する`

### Task 4: Stripe の手数料・税額調整・入金・着金・入金の失敗・残高の補充・照合

controller が別セッションへ `src/lib/stripe/accounting-sync.ts` と `docs/06_Operations/` の更新を先に知らせる（Stripe のファイルを触る）。この Task の照合の route と画面は Task 10・11。Task 3 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-565・566 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts9>_accounting_p2_stripe_posting.sql`、`src/lib/accounting/stripe-categories.ts`、`scripts/accounting/emit-stripe-categories.ts`、`tests/integration/db/accounting_p2_stripe_posting.integration.test.ts`、`tests/integration/db/accounting_p2_stripe_reconciliation.integration.test.ts`、`tests/unit/lib/accounting/stripe-categories.test.ts`
- Modify: `src/lib/stripe/accounting-sync.ts`（`arrival_date` を日本時間の日にする。`payout.failure_balance_transaction` を保存する）、`tests/unit/lib/stripe/accounting-sync.test.ts`、`tests/integration/db/accounting_p2_migration_asserts.integration.test.ts`、`tests/integration/db/helpers/accounting-orders-fixtures.ts`（`seedStripeFee`・`seedStripePayout` を足す）
- Test: 上の DB 2 suite と単体2本
- Read: `src/lib/finance/stripe-journal.ts:53-130`（今の合成。Task 12 で外す）、`src/lib/stripe/accounting-sync.ts:60-200`、recon-part-C 1.7、`docs/superpowers/specs/…` の 4-c・4-c4・16-sr3

**Interfaces:**
- Consumes: `stripe_balance_transactions`（`type`・`reporting_category`・`amount`・`fee`・`net`・`fee_details`・`stripe_created_at`・`source_id`・`payout_id`）、`stripe_payouts`（`amount`・`paid_at`・`reconciliation_status`・`bank_arrival_date`・`bank_confirmed_at`）、期間の `consumption_tax_status`、`toJstDate`（計画1）。
- Produces（種類の対応。鍵は `type`。`reporting_category` は補助で、dispute の取引だけ `reporting_category` で見る。`stripe-categories.ts` が正本で、`scripts/accounting/emit-stripe-categories.ts` が SQL の `private.accounting_stripe_category_kind(_type text, _reporting_category text) RETURNS text`（IMMUTABLE）の本文を出し、試験が一致を確かめる）:

| `type`（`reporting_category`） | 係の扱い |
| --- | --- |
| `charge`・`payment`（`charge`） | 売上の元本は Task 2。手数料は 1-a10 |
| `refund`・`payment_refund`・`refund_failure`（`refund`・`refund_failure`） | 元本は計画3（係は飛ばす）。手数料があれば 1-a10 |
| `stripe_fee`・`stripe_fx_fee`（`fee`） | 単独の手数料（1-a10） |
| `tax_fee`（`tax`） | 税額調整（1-a11）。**この名前が JCT tax adjustment に当たるかは未確認 #1**。確かめるまでの仮の対応で、違えば `unknown_category` で止まるだけ |
| `payout` | 入金の本体は `stripe_payouts` から（1-a12）。取引の行は飛ばす |
| `payout_failure`・`payout_cancel`（`payout_reversal`） | 戻りの取引（1-a13） |
| `adjustment`（`dispute`・`dispute_reversal`） | 元本は Task 6。手数料は 1-a10（Task 4 の手数料の係が `fee` を見る。メモは「取り消しの手数料」） |
| `topup`・`topup_reversal`（`topup`） | 手入力で入れる種類（1-a14）。止めずに飛ばし、残高の照合で「手入力で入れる補充」として名指す |
| 上以外 | 黙って捨てず `unknown_category` で計上待ち（4-c の抜け防止） |

- Produces（係。入口なし。Task 6 の `public.accounting_run_posting` が呼ぶ）: `private.accounting_post_stripe_events(_limit integer) RETURNS jsonb`。中は5つの小さな関数（`…_fee_events`・`…_tax_adjustment_events`・`…_payout_events`・`…_bank_events`・`…_payout_failure_events`）。それぞれ最初に `private.accounting_lock_all(NULL)`、行ロックなし、切り替えの日・期間の検査は Task 2 と同じ。出来事ごとの例外処理は Global Constraints の共通規則どおり。候補は「係の候補の選び方」に従い、飛ばす取引は SQL の条件で最初から除く。
  - 手数料（1-a10）: 取引1件に1本、種類 `stripe_fee`、番号 `[取引の id]`（印は `stripe:fee:<id>`）。候補は `fee_amount <> 0`（単独の手数料の種類は `net <> 0`、それ以外は `fee <> 0`。種類は `accounting_stripe_category_kind` から引く）。符号つきの手数料 `fee_amount` は、種類の対応（`accounting_stripe_category_kind`）が単独の手数料なら `-net`（`fee = 0` でも使う）、それ以外は `fee`。`fee_amount > 0`: 借方 6280 と（課税の期間なら）1480、貸方 1160。`fee_amount < 0` は逆。行の額は `abs(fee_amount)` を本体と税に分け、正の整数で渡す。免税の期間は税込みの1行（借方 6280 に総額）。課税の期間は `fee_details` の `type='tax'` の合計を借方 1480、残りを 6280。`fee_details` に税が無ければ既定の課税10%で、総額から `round(総額 / 1.1)` を本体とし、メモに `tax_default_10` を残す。相手は `ACCOUNTING_LABELS.stripeJapan`（4-c2）、メモは内容（`feePayment`・`feeDispute`・`feeFx`）。免税か課税かは、仕訳の日を含む期間の `consumption_tax_status` が `taxable` で、かつ仕訳の日が `consumption_taxable_from` 以後の時だけ課税（5-j・計画1 Task 7。期間の途中で課税事業者になる場合）。
  - 税額調整（1-a11・4-c4）: 種類 `stripe_tax_adjustment`、番号 `[取引の id]`、日は調整の取引の日。免税の期間は「支払手数料（税込み）／1160」、課税の期間は「仮払消費税（1480）／1160」。符号つきの費用の額は `adjustment_amount = -取引.net`、行に入れる正の額は `abs(取引.net)`。`net < 0` は費用（6280、課税なら1480）の借方／1160の貸方、`net > 0` は1160の借方／同じ費用の貸方、`net = 0` は仕訳を作らない。元の手数料と二重にしない（通常の手数料は `fee`、単独の手数料は上の種類だけの `-net`、税額調整はこの種類の `-net`）。
  - 入金（1-a12）: `stripe_payouts` のうち `reconciliation_status='matched'` かつ `paid_at` がある物に、種類 `payout_started`、番号 `[入金の id]`、日 `toJstDate(paid_at)`、借方 1150、貸方 1160（額は入金の額）。`mismatch` は `payout_mismatch` で止める。`pending` は待つだけ。
  - 着金（1-a12）: 入金の仕訳があり、`bank_arrival_date` と `bank_confirmed_at` がある入金に、種類 `bank_arrived`、番号 `[入金の id]`（銀行の取引の番号が取れないため。決めたことのとおり）、日 `bank_arrival_date`、借方 1040、貸方 1150。
  - 入金の失敗（1-a13・4-g）: `type` が `payout_failure`/`payout_cancel` の取引に、種類 `payout_failed`、番号 `[取引の id]`、日 `toJstDate(stripe_created_at)`、借方 1160、貸方 1150、額 `abs(net)`、メモに `payout:<source_id>`（出し直しの `retried_payout_id` が取引の `raw_payload` にあればそれも）。**その入金の `payout_started` の仕訳がある時だけ**入れる（無ければ 1150 がマイナスになるので、`payout_mismatch`〔detail は `payout_state: 'payout_not_posted'`〕で止める）。入金の仕訳がこの先も入らない入金（`stripe_payouts.status` が `failed`/`canceled` で `paid_at` が NULL）だけ、入金の取引と戻りの取引が打ち消し合うとみなし、両方の取引の行と入金そのものに解決済みの行（`reason='payout_mismatch'`、`resolved_at` を入れた解決済みの印、`resolved_entry_id` は NULL、detail `payout_state: 'payout_net_zero'`）を置いて、入金の係の候補から外す。それ以外（照合待ちの入金など）は `payout_mismatch`（`payout_state: 'payout_not_posted'`）で待つ。
- Produces（残高の補充 1-a14・4-h。private 本体＋service_role 専用の public 入口）: `admin_record_balance_topup(_actor_id uuid, _amount bigint, _bank_date date, _bank_txn_no text, _stripe_txn_id text, _note text, _request_key uuid) RETURNS jsonb`。権限 `admin.finance.manage`。額は正の整数、日は日本時間の日（未来は断る）、銀行の取引の番号は空でもよい（空なら `_stripe_txn_id`、両方空なら `ACCOUNTING_ARGUMENT_INVALID`）。種類 `balance_topup`、番号 `[銀行の取引の番号または Stripe の取引の番号]`、借方 1160、貸方 1040、メモに Stripe の取引の番号。二重は印の一意で止まる（同じ番号で違う額は `ACCOUNTING_DEDUPE_CONTENT_MISMATCH`）。
- Produces（照合の表と書き口）: `accounting_stripe_invoice_records(invoice_month text PK CHECK (invoice_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), invoice_total bigint NOT NULL CHECK (invoice_total >= 0), invoice_tax bigint NOT NULL DEFAULT 0 CHECK (invoice_tax >= 0), document_ref text NULL CHECK (char_length(document_ref) <= 200), entered_by uuid, entered_at timestamptz DEFAULT now(), version bigint NOT NULL DEFAULT 1, admin_requests jsonb NOT NULL DEFAULT '{}')`（`invoice_month` は適格請求書の対象の UTC の月。RLS・権限は Task 1 と同じ）と `admin_set_stripe_invoice_record(_actor_id uuid, _invoice_month text, _invoice_total bigint, _invoice_tax bigint, _document_ref text, _expected_version bigint, _request_key uuid) RETURNS jsonb`（権限 `admin.finance.manage`。新規は `_expected_version` が NULL、直しは版が合う時だけ。版違いは `ACCOUNTING_VERSION_CONFLICT`）。請求書そのものの電子保存は計画6・12章で、ここは合計と参照の文字列だけ。
- Produces（読み口。STABLE・service_role 専用）:
  - `public.get_stripe_fee_reconciliation(_month text) RETURNS jsonb`（`_month` は日本時間の月 `YYYY-MM`）: `{jst_total, utc_total, invoice_total, boundary_in:[{txn_id,jst_date,utc_date,fee}], boundary_out:[…], next_month_adjustments:[{txn_id,jst_date,amount}], diff_jst_utc, explained_boundary, unexplained_jst_utc, diff_utc_invoice, explained_adjustments, unexplained_utc_invoice, journal_vs_txn_diff}`。日本時間の月の合計も UTC の月の合計も、**同じ元（上の `fee_amount`: 単独の手数料は `-net`、ほかは `fee`）**から出す（日本時間の月は `stripe_created_at` の日本時間の日がその月、UTC の月は UTC の日がその月）。`boundary_in`・`boundary_out` の `fee` も生の `fee` 列でなく同じ `fee_amount`、`next_month_adjustments.amount` は税額調整の符号つきの費用 `-net` を返す。`boundary_in` は M の1日の日本時間0〜9時（UTC では前の月）の取引、`boundary_out` は次の月の1日の日本時間0〜9時（UTC では M）の取引。`unexplained_jst_utc = (jst_total − utc_total) − (boundary_in の合計 − boundary_out の合計)`（4-c の1段目。次の月の1日の朝に取引があっても0になる）。`unexplained_utc_invoice = (utc_total − invoice_total) − 翌月の税額調整の合計（符号つき）`（2段目）。保存した仕訳の合計との差は別の行 `journal_vs_txn_diff`（計上待ちの手数料があると出る）で示し、説明のつかない差に混ぜない。請求書の記録が無い月は `invoice_total` を NULL にして2段目を出さない。
  - `public.get_stripe_balance_reconciliation(_through date) RETURNS jsonb`（7-i5）: `{through, stripe_balance, ledger_1160, ledger_1130_stripe, difference, unjournaled:[{kind,count,net_sum}], payout_in_transit_1150}`。`stripe_balance` は `stripe_balance_transactions` の `net` の合計（日本時間の日で `through` 以前）、`ledger_1160` は取り消されていない仕訳の 1160 の借方−貸方、`ledger_1130_stripe` は補助 `processor:stripe` の 1130（今は0）。`unjournaled` は仕訳になっていない取引を種類で分けた合計（`planned_p3`＝計画3で計上する種類〔refund 系〕、`pending`＝計上待ち、`unknown`、`payout_unposted`＝入金の仕訳待ちの入金の取引、`manual_topup`＝手入力で入れる補充の取引〔画面から入れた補充の仕訳と合わせて説明し、二重に数えない〕）。`difference` は `stripe_balance − (ledger_1160 + ledger_1130_stripe)` で、`unjournaled` の合計と一致する差だけが説明がつく。1150 は別に表示するだけで足さない（銀行の着金まで追う）。
- Produces（TS）: `src/lib/accounting/stripe-categories.ts`（表の対応と `kindOfStripeCategory(type, reportingCategory): 'sale'|'refund_principal'|'fee_only'|'tax_adjustment'|'payout'|'payout_failure'|'dispute'|'manual_topup'|null`）。`accounting-sync.ts` の `arrival_date` を `toJstDate`（`iso(payout.arrival_date)` の日本時間の日）に直す。あわせて `syncPayoutAccounting` が `payout.failure_balance_transaction` があれば取り直して `upsertBalanceTransaction` で保存する（今は入金の取引と中身の一覧だけで、失敗で戻った取引を保存せず、1-a13 の元の記録が入らない。返金の `failure_balance_transaction_id` と同じ扱い）。
- Produces: S9 assert DETAIL `acc_s9_tables`・`acc_s9_functions`・`acc_s9_function_attrs`・`acc_s9_rls_acl`・`acc_s9_reads_stable`・`acc_s9_category_map`・`acc_s9_existing_dml_allowlist`。

- **追加の試験（Task 4 の Step 1 で書く）:** `FREQ-565-AC-01: fee=0のstripe_feeとstripe_fx_feeも候補に入り-netで1本ずつ計上され、照合の合計にも同じ符号で入る`、`FREQ-565-AC-02: 税額調整はnet=-110なら費用側の借方110と1160の貸方110、net=110なら逆で、net=0は仕訳を作らない`（免税・課税の両方）、`FREQ-569-AC-06: 手数料1件の失敗は保留に残りほかの手数料と入金は計上される`。
- **期間が無い時の日付:** 5つの小さな係のすべてで、`period_missing` に止める `accounting_park_event` の `_detail` に `entry_date`（`YYYY-MM-DD`）を必ず入れる。手数料・税額調整・入金の失敗は残高の取引の日本時間の日、入金は `toJstDate(paid_at)`、着金は `bank_arrival_date`。計上待ちを見直して止め直す時も同じ。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-565-AC-01: 手数料は取引1件に1本で、印は stripe:fee:<取引の番号>、相手はストライプジャパン株式会社`、`FREQ-565-AC-01: 免税の期間は税込みの1行で、課税の期間は本体と仮払消費税に分かれる`、`FREQ-565-AC-01: 課税でfee_detailsに税が無ければ既定の課税10%で分けメモに残る`、`FREQ-565-AC-01: 単独の手数料の取引と返金の取引に付いた手数料も1件1本で、負の手数料は逆の仕訳`、`FREQ-565-AC-01: 手数料の日は日本時間の日で、UTCの月末の夜の取引は日本時間の翌月の仕訳になる`、`FREQ-565-AC-01: 手数料も入金も1160から引く（1130は使わない）`、`FREQ-565-AC-02: 税額調整は調整の取引の日に1本で、元の手数料の仕訳と合計が二重にならない`、`FREQ-565-AC-03: 知らない種類の取引は仕訳にせずunknown_categoryで計上待ちに置き、種類を足すと入る`、`FREQ-565-AC-03: 返金系の取引の元本は係が飛ばし、計上待ちにもしない`、`FREQ-565-AC-04: 入金は中身と額が一致した時だけ「1150／1160」で、mismatchはpayout_mismatchで止まる`、`FREQ-565-AC-04: 入金の日は入金の取引の日本時間の日`、`FREQ-565-AC-04: 着金は着金の日に「1040／1150」で、入金の仕訳が先に無ければ入れない`、`FREQ-565-AC-05: 入金の失敗と取り消しは戻りの取引の日に「1160／1150」で戻り、同じ取引は1本`、`FREQ-565-AC-06: 残高の補充は画面の入力から「1160／1040」で入り、同じ銀行の取引の番号で2回目は何も足さず、額が違えばDEDUPE_CONTENT_MISMATCH`、`FREQ-565-AC-06: 補充は権限なしを42501で断り、未来の日と額0を断る`、`FREQ-565-AC-01: 全部の入口は同時に流しても1本`（並行）、`FREQ-565-AC-04: 入金の到着日（arrival_date）は日本時間の日になる`（単体。`accounting-sync.test.ts`。UTC 15:30 の入金が翌日になる）、`FREQ-565-AC-05: 入金の失敗の取引（failure_balance_transaction）を同期で保存する`（単体）、`FREQ-565-AC-05: 入金の仕訳が無い入金の失敗は仕訳にせず止める`、`FREQ-565-AC-05: 照合待ちの入金が失敗しても、入金と戻りは両方入るか両方入らないかのどちらかで、1150が残らない`、`FREQ-565-AC-03: topupの取引は止めずに飛ばし、照合でmanual_topupとして名指される`、`FREQ-565-AC-03: 飛ばす取引（返金の元本・入金の行・補充・単独の手数料の種類でなくfee=0の物）が_limit件以上あっても、新しい手数料の取引が入る`、`FREQ-565-AC-03: 種類の対応は type を鍵にし、単独の手数料（type=stripe_fee・stripe_fx_fee、fee=0、netは正負の両方）と入金の失敗（type=payout_failure）が正しい出来事になる`、`FREQ-565-AC-03: 種類の対応はTSとSQLで一致する`、`FREQ-569-AC-01: 手数料・税額調整・入金・着金・入金の失敗のすべてでperiod_missingのdetail.entry_dateが各仕訳の日になる`。
  照合: `FREQ-566-AC-01: 日本時間の月と UTC の月の差は、月初0〜9時の取引と、次の月の月初0〜9時の取引の両方で説明され、説明のつかない差は0`（次の月の1日の朝8時の手数料を含める）、`FREQ-566-AC-02: UTCの月と請求書の差は翌月の税額調整で説明され、残りが説明のつかない差として出る`、`FREQ-566-AC-02: 請求書の記録が無い月は2段目を出さない`、`FREQ-566-AC-02: 請求書の記録は版が違えばVERSION_CONFLICTで、同じ要求番号の再送は前の結果`、`FREQ-566-AC-03: Stripeの残高と台帳の差は、仕訳になっていない取引の合計（計画3で計上する種類・計上待ち・未知の種類）と一致する`、`FREQ-566-AC-03: 入金途上1150は足さずに別に出る`。
- [ ] **Step 2（controller）: RED を測る。** 上の DB suite と単体2本。
- [ ] **Step 3: S9 と TS を実装する。** 種類の対応の SQL は生成スクリプトの出力を貼る。`fee_details` の形（`type` が `tax` か）は実装時に手元の fixture と Stripe の公開の資料で確かめ、確かめられない分は未確認 #2 のまま既定の 10% で動かす。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。加えて Stripe のテストモードで、本物の残高の取引の `type` と `reporting_category` の組の一覧と `fee_details` の形を**読むだけ**で確かめ（本番の Stripe には触らない）、結果を `.superpowers/sdd/2026-11-04-accounting-p2/stripe-categories-check.md` に書く。違いがあれば未確認 #1・#2 を更新し、種類の対応を直す。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): Stripeの手数料と入金と着金と照合を仕訳と読み口にする`

### Task 5: カード会社からの支払いの取り消しの受け取り（表・Webhook・同期）

controller が別セッションへ `src/lib/stripe/**` と `src/app/api/webhook/**` の変更を先に知らせる。Task 4 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-567 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts10>_accounting_p2_dispute_intake.sql`、`src/lib/stripe/dispute-sync.ts`、`tests/integration/db/accounting_p2_dispute_intake.integration.test.ts`、`tests/unit/lib/stripe/dispute-sync.test.ts`
- Modify: `src/lib/stripe/handled-webhook-events.ts`（13種→18種。冒頭の説明文も）、`src/lib/stripe/webhook-processor.ts`（`syncAccountingForEvent` に5つの `case`）、`src/lib/stripe/accounting-types.ts`（dispute の型と `StripeAccountingDatabase` の `recordDispute`）、`src/lib/stripe/supabase-accounting-database.ts`（`recordDispute` を RPC で実装）、`src/lib/stripe/reconcile-orders.ts` と `src/app/api/cron/stripe-reconcile/route.ts`（毎晩の dispute の取りこぼし拾い）、`tests/unit/lib/stripe/handled-webhook-events.test.ts`（13→18）、`tests/unit/api/webhook/stripe-route.test.ts`、`tests/unit/lib/stripe/reconcile-orders.test.ts`、`tests/unit/api/cron/stripe-reconcile-route.test.ts`、`tests/integration/db/accounting_p2_migration_asserts.integration.test.ts`
- Test: 上の DB 1 suite と単体
- Read: `src/lib/stripe/webhook-processor.ts:150-200`、`src/lib/stripe/accounting-sync.ts`（`syncPayoutAccounting` の取り込み方）、`docs/06_Operations/webhook-queue-operations.md` §4、`tests/integration/db/group_g1_cleanup.integration.test.ts:637`（`charge.dispute.created` を例に使っている所。受け取りの種類が増えても壊れないことを確かめる）

**Interfaces:**
- Produces（受け取りの種類）: `HANDLED_STRIPE_EVENT_TYPES` に `charge.dispute.created`・`charge.dispute.updated`・`charge.dispute.closed`・`charge.dispute.funds_withdrawn`・`charge.dispute.funds_reinstated` の5つ（計18種）。名前は実装時に Stripe の公式の一覧で確かめる（未確認 #9）。`webhook-processor.ts` の `syncAccountingForEvent` に同じ5つの `case` を足す（`handled-webhook-events.test.ts` が `case` の集合と一致を確かめる）。受け取りの種類を増やしても、Stripe の宛先に足すまで知らせは届かない。運用の手順は Task 15 で文書に足す。
- Produces（表。すべて `public`、RLS 有効、所有者 postgres、PUBLIC/anon/authenticated に権限なし、service_role は SELECT のみ。書くのは下の private 関数）:
  - `stripe_disputes(id text PK CHECK (id ~ '^dp_[A-Za-z0-9]+$'), payment_intent_id text NULL, charge_id text NULL, order_id uuid NULL, amount bigint NOT NULL CHECK (amount > 0), currency text NOT NULL, reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 64), status text NOT NULL CHECK (char_length(status) BETWEEN 1 AND 64), is_charge_refundable boolean NULL, evidence_due_by timestamptz NULL, evidence_details jsonb NOT NULL DEFAULT '{}', stripe_created_at timestamptz NOT NULL, synced_at timestamptz NOT NULL DEFAULT now())`。更新できるのは `status`・`is_charge_refundable`・`evidence_due_by`・`evidence_details`・`order_id`・`synced_at` だけ（`id`・`amount`・`reason`・`charge_id`・`payment_intent_id`・`stripe_created_at` を変える UPDATE はトリガーで断る）。注文への外部キーは付けない（`stripe_balance_transactions` と同じ。結び付かない取り消しも保存する）。
  - `stripe_dispute_events(id uuid PK DEFAULT gen_random_uuid(), dispute_id text NOT NULL FK stripe_disputes RESTRICT, stripe_event_id text NOT NULL UNIQUE, event_type text NOT NULL, status text NOT NULL, occurred_at timestamptz NOT NULL, stripe_event_created_at timestamptz NULL, balance_transaction_ids text[] NOT NULL DEFAULT '{}', raw_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`。追記専用（`reject_accounting_mutation`）。1つの知らせ（または再照合の1回）につき1行。`occurred_at` はこちらが知らせを受けた・取り直した時刻。`status` は①で取り直した今の状態。`stripe_event_created_at` は lost の時刻だけに使う Stripe 側の出来事の時刻で、**その出来事の中身の状態（`event.data.object.status`）が `lost` の時だけ**入れる（知らせの行は Stripe の知らせの `created`、再照合の行は下の「毎晩の拾い」が Stripe の出来事の一覧から取った `created`）。中身の状態が lost でない知らせ（遅れて処理した前の `charge.dispute.updated` など）は、取り直した状態が lost でも NULL。取れなければ NULL。Task 6 の lost の時刻はこの列から決める。`raw_payload` は、その時点の dispute の写し（原因・期限・提出した資料の一覧を含む）で、後から書き換えない（4-f の電子取引の記録）。
- Produces（書く関数）: `private.record_stripe_dispute(_dispute jsonb, _event jsonb) RETURNS jsonb` ＋ 同名の `public.record_stripe_dispute(…)`（INVOKER・service_role だけ）。`_dispute` は `{id,payment_intent_id,charge_id,order_id,amount,currency,reason,status,is_charge_refundable,evidence_due_by,evidence_details,stripe_created_at}`、`_event` は `{stripe_event_id,event_type,status,occurred_at,stripe_event_created_at,balance_transaction_ids,raw_payload}`（`stripe_event_created_at` は NULL を許す）。表の dispute を作るか可変の欄を更新し、履歴を `ON CONFLICT (stripe_event_id) DO NOTHING` で足す。戻りは `{dispute_id,event_inserted:true|false}`。同じ `stripe_event_id` の2回目は何も足さない。
- Produces（TS）: `syncDisputeAccounting({stripe, database, disputeId, eventId, eventType, eventCreated, eventObjectStatus}): Promise<{disposition:'inserted'|'unchanged'}>`（`src/lib/stripe/dispute-sync.ts`）。順序: ①Stripe から dispute を取り直す（`stripe.disputes.retrieve`。知らせの中身でなく Stripe の今の状態を正とする）。②`dispute.balance_transactions`（引かれた分・戻った分の残高の取引、0〜2件）を、既存の `upsertBalanceTransaction` で保存する。注文は `database.findOrderByPaymentIntent(dispute.payment_intent)` で結び、`order_id` を入れる。③`database.recordDispute` で dispute と履歴を保存する（知らせから呼ぶ時は、知らせの中身の状態 `event.data.object.status` が `lost` の時だけ `stripe_event_created_at` に `eventCreated`〔Stripe の知らせの `created`〕を入れ、それ以外は NULL。引数に `eventObjectStatus` を足して渡す）。④例外は握りつぶさず投げる（知らせの再試行に任せる）。`syncAccountingForEvent` の5つの `case` から呼ぶ。
- Produces（毎晩の拾い）: `reconcileStripeDisputes`（`reconcile-orders.ts`）が、①表の中で決着していない dispute（状態が `won`・`lost`・`warning_closed` 以外。判断は2か月以上かかる〔設計 4-3〕ので作成から30日を過ぎた物も）を全部 `stripe.disputes.retrieve` で取り直し、②新しい物を `stripe.disputes.list({limit:100, created:{gte:<30日前>}})` で最大5ページ拾い、各 dispute を `syncDisputeAccounting` に渡す。履歴の `stripe_event_id` は `reconcile:<dispute の番号>:<status>` で、表に既にある最新の状態と同じなら履歴を足さない（知らせの行がある時も足さない）。再照合で `status='lost'` の行を足す時は、`stripe.events.list({type:'charge.dispute.closed', created:{gte:<dispute の作成>}})`（Stripe が出来事を残す30日の中）を `limit:100` で最大5ページ探し、中身の状態が `lost` のその dispute の出来事の `created` を `stripe_event_created_at` に入れる。5ページで見つからなければ NULL。結果は `StripeReconcileResponse` に `syncedDisputes` を足して返し、heartbeat と監査の既存の形に載せる。`payout.canceled` を受けない今の作りは変えない（毎晩の同期が拾う）。
- Produces: S10 assert DETAIL `acc_s10_tables`・`acc_s10_constraints`・`acc_s10_immutable`・`acc_s10_rls_acl`・`acc_s10_function_attrs`・`acc_s10_existing_dml_allowlist`。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-567-AC-01: 受け取りの種類は18種で、処理する側のcaseの集合と一致する`（`handled-webhook-events.test.ts` の2本を18に）、`FREQ-567-AC-01: charge.dispute の5種を処理するとdisputeの表と履歴と残高の取引が保存され、注文が結び付く`（単体。Stripe とDBは作り物）、`FREQ-567-AC-01: 支払いに結び付く注文が無い取り消しも保存し order_id はNULL`、`FREQ-567-AC-02: 同じ知らせの2回目は履歴の行を増やさない`（DB。`event_inserted=false`）、`FREQ-567-AC-03: record_stripe_disputeはstripe_event_created_atの値もNULLも保存する`（DB）、`FREQ-567-AC-03: 中身の状態がlostでない知らせは、取り直した状態がlostでもstripe_event_created_atがNULL`（単体）、`FREQ-567-AC-02: 知らせが前後して届いても、Stripe から取り直した最後の状態が表に残る`、`FREQ-567-AC-02: 取り直しが失敗したら例外を投げて何も保存しない`、`FREQ-567-AC-03: 原因・期限・資料の写しは履歴に残り、履歴と dispute の固定の欄のUPDATEとDELETEとTRUNCATEを断る`、`FREQ-567-AC-03: 表はanonとauthenticatedに権限が無く、service_roleはSELECTだけ`、`FREQ-567-AC-04: 毎晩の再照合は取りこぼした dispute を保存し、状態が同じ夜は履歴を増やさない`、`FREQ-567-AC-04: 作成から30日を過ぎた未決着の dispute の確定も、毎晩の取り直しで拾う`、`FREQ-567-AC-02: 知らせの行がある状態は、再照合が履歴を足さない`、`FREQ-567-AC-04: 再照合の件数がheartbeatと監査の応答に載る`、`FREQ-567-AC-03: 知らせの行はStripeの知らせの時刻を、再照合のlostの行はStripeの出来事の一覧の時刻をstripe_event_created_atに残し、見つからなければNULL`（単体。Stripe は作り物）。
- [ ] **Step 2（controller）: RED を測る。** `npx.cmd jest tests/integration/db/accounting_p2_dispute_intake.integration.test.ts` と上の単体。
- [ ] **Step 3: S10 と TS を実装する。** 既存の `webhook-processor.ts` の他の `case` と処理の流れは変えない。dispute の知らせで仕訳は作らない（仕訳は Task 6 の係が表を読んで作る）。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。加えて Stripe の**テストモード**で `charge.dispute.created` などを起こし（Stripe CLI の `trigger` か、テスト用のカードの不審請求のカード番号の決済）、手元の受け取り口に届いて表と履歴に入ることを確かめる。名前が公式の一覧と違えば未確認 #9 を直す。テストモードの宛先に5種を足す手順は Task 15 の文書のとおり。本番の Stripe には触らない。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): カード会社からの支払いの取り消しを受け取り保存する`

### Task 6: 支払いの取り消しの仕訳・設定・保留の読み口・計上係の入口（4-d・4-e・4-e2・1-a15・1-a16）

controller が別セッションへ先に知らせる（計上係の入口を足す）。Task 5 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-568 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts11>_accounting_p2_dispute_posting.sql`、`tests/integration/db/accounting_p2_dispute_posting.integration.test.ts`、`tests/integration/db/accounting_p2_dispute_concurrency.integration.test.ts`、`tests/integration/db/accounting_p2_run_posting.integration.test.ts`、`tests/integration/db/accounting_p2_run_posting_postgrest.integration.test.ts`
- Modify: `tests/integration/db/accounting_p2_migration_asserts.integration.test.ts`、`tests/integration/db/helpers/accounting-orders-fixtures.ts`（`seedDispute` を足す）
- Test: 上の DB 4 suite
- Read: Task 2〜5 の成果、設計 4-d・4-e・4-e2・16章の最初の行

**Interfaces:**
- Consumes: `stripe_disputes`・`stripe_dispute_events`、`stripe_balance_transactions`（`reporting_category` が `dispute`／`dispute_reversal`、`source_id`＝dispute の番号）、`accounting_shipment_units`・`order_line_unit_amounts`・`accounting_unit_refund_allocations`、`stripe_refunds`（成功した返金の有無）、Task 1 の割り振りの道具と、着の値打ち・出荷済み・番号の道具（`accounting_unit_values`・`accounting_shipped_units`・`accounting_g_fact_seq_at`）。
- Produces（表と書き口）: `accounting_dispute_account_settings(reason text PK CHECK (char_length(reason) BETWEEN 1 AND 64), account_code text NOT NULL FK accounting_accounts, version bigint NOT NULL DEFAULT 1, updated_by uuid, updated_at timestamptz, admin_requests jsonb NOT NULL DEFAULT '{}')`（4-e の「振り替える先の科目は設定に持つ」。Task 1 と同じ RLS・権限）。`admin_set_dispute_account_setting(_actor_id uuid, _reason text, _account_code text, _expected_version bigint, _request_key uuid) RETURNS jsonb`（private 本体＋public 入口。権限 `admin.accounting.settings.manage`。勘定は `accounting_accounts` にあり種類が費用か収益のものだけ。それ以外は `ACCOUNTING_DISPUTE_ACCOUNT_INVALID`。新規は `_expected_version` が NULL、直しは版が合う時だけ）。`admin_assign_dispute_confirmed(_actor_id uuid, _dispute_id text, _request_key uuid) RETURNS jsonb`（権限 `admin.accounting.entries.correct`。確定した時に設定が無く「確定・科目の決定待ち」に置いた分を、今の設定の科目へ**dispute 1つに1回だけ**振り替える。種類 `dispute_event`・番号 `[dispute の番号,'assigned','1']`、日は C の仕訳の日（4-e「確定した日に、原因に合う科目へ振り替える」。振り替えの操作をいつしても、費用が立つ年は変わらない）、額は、その dispute の補助 `dispute_confirmed_unassigned` の今の残高（その dispute の印〔`dispute_event:<dispute>:` で始まる〕の仕訳の、その補助の行の借方−貸方）、行は「設定の科目／1470（補助 `dispute_confirmed_unassigned`）」。先に `accounting_dispute_assignments` を見て、振り替え済みなら `created:false` で前の結果を返す（振り替えの後は補助の残高が0になるので、この順で見る）。無ければ、補助の残高が0以下・確定の仕訳が無い・設定がまだ無いときは `ACCOUNTING_EVENT_NOT_POSTABLE`。振り替えの要求は Stripe の記録の写しの表 `stripe_dispute_events` に混ぜず、別の表 `accounting_dispute_assignments(dispute_id text PK FK stripe_disputes, entry_id uuid NOT NULL FK accounting_journal_entries, assigned_by uuid, assigned_at timestamptz DEFAULT now(), request_key uuid NOT NULL UNIQUE, request_hash text NOT NULL)`〔追記専用。Task 1 と同じ RLS・権限〕に置く。同じ要求番号で違う内容は `ACCOUNTING_REQUEST_KEY_CONFLICT`）。
- Produces（読み口。STABLE・service_role 専用）: `public.list_dispute_account_settings() RETURNS jsonb`、`public.list_accounting_disputes(_limit integer DEFAULT 50, _after_at timestamptz DEFAULT NULL, _after_id text DEFAULT NULL) RETURNS jsonb`（画面用: dispute の番号・原因・状態・額・注文番号・引かれた日・確定の日・振り替え先の科目・計上待ちの理由。名前・メールを含めない）、`public.get_order_dispute_holds(_order_ids uuid[]) RETURNS TABLE(order_id uuid, dispute_id text, status text, amount bigint, since timestamptz)`（4-e3。資金が引かれて、まだ確定も取り下げもされていない取り消し。`status in ('needs_response','under_review')` で、引かれた残高の取引があり、戻りの取引が無い物。事前の問い合わせ〔`warning_*`〕は資金が動かないので保留に数えない）、`public.get_slip_dispute_holds(_slip_id uuid) RETURNS TABLE(order_id uuid, dispute_id text)`（下書きの発送票の `draft_lines` の注文が保留に当たるか。出荷の route が使う）。
- Produces（係。入口なし）: `private.accounting_post_dispute_events(_limit integer) RETURNS jsonb`。最初に `accounting_lock_all(NULL)`、行ロックなし。W・C・R・L の出来事1件ずつに Global Constraints の例外処理を当てる（X は人の操作の入口なので失敗をその操作へ返す）。日の検査は Task 2 と同じ（日本時間の日、切り替え、期間）。仕訳ごとに額の出どころを変えると、届く順で額が変わる誤りが出たので、次の5つの規則で決める（2026-11-04 AI の判断）。
  1. **段の順と待ち。** 段は W（引かれた）→ C（確定）・R（確定の前の取り下げ）→ X（科目の振り替え。画面の操作）・L（遅れた取り下げ）。どの段も前の段が済むまで入れず、済んでいなければ `dispute_withdrawal_missing` で待つ。「済んだ」とは、前の段の仕訳がある時、または前の段が `no_revenue` で解決済みの時。C の前の段は、W と、lost の時刻と同じかそれより前の戻りの取引の R の全部（C の額を R の後の残高にするため）。W は、その注文に、確定の番号が W の番号 N（下の W の段。引かれた残高の取引の `stripe_created_at` から `accounting_g_fact_seq_at` で直した番号）以下の `stage='confirmed'` の発送票で、出荷の仕訳がまだ無い物（`no_revenue` で解決済みの物は除く）があれば、`dispute_shipment_pending` で待つ（出荷済みかどうかが処理の順で変わらないように）。
  2. **額は今の残高から。** C・R・X・L の額は、前の仕訳の固定の額から出さず、その dispute の補助ごとの今の残高から出す。補助は 1470 の `dispute_pending` と `dispute_confirmed_unassigned`。費用の科目の額は、その dispute の印（`dispute_event:<dispute>:` で始まる）で入った行の合計。残高は取り消しの仕訳も含めた全部の行の借方−貸方。前受金に戻す分（U の比）と 1470 に戻す分（S の比）は、W の仕訳の行（2150 の借方と 1470 の借方）から読む。
  3. **戻りの取引1件に仕訳1本。R か L かは、決着の後に Stripe 側の時刻で決める。** 確定の前の取り下げ（R）と遅れた取り下げ（L）は、印を1つの形 `dispute_event` の `[dispute,'reversal',戻りの取引の番号]` にまとめる。印が1つなので、同じ戻りの取引に2本は入らない。
     - 決着を待つ: 戻りの取引は、dispute が決着するまで入れず、`dispute_withdrawal_missing` で待つ（新しい理由は足さず、既存の待ちの理由を使う。お金の動く理由なので手では閉じられない）。決着とは、`stripe_disputes.status` が `won`・`lost`・`warning_closed`（Task 5 の毎晩の拾いの「決着した」と同じ集まり。使う API の版の終わりの状態との突き合わせは未確認 #9。待っている間の detail には `dispute_status` に今の状態の名前を出す）の時か、履歴に `status='lost'` の行がある時。資金が戻るのは決着の時なので、待っても遅れない。残高の取引の保存（`syncDisputeAccounting` の②）と履歴の保存（③）の間に係が流れても、決着の前なので入らない。
     - lost の時刻: その dispute の `status='lost'` の履歴の行の `stripe_event_created_at`（Stripe 側の出来事の時刻。Task 5 で、中身の状態が lost の出来事の時だけ入る）のうち最も古い物。こちらが受けた時刻 `occurred_at` では決めない。**どの lost の行にも Stripe の時刻が無い時だけ**（知らせを取りこぼし、Stripe の出来事の一覧に残る30日も過ぎた時）、lost の行の `occurred_at` の最も古い物を lost の時刻とみなす（1つに決めた扱い。後から Stripe の時刻が届いても、入れた仕訳は変えない。Task 7 は道具を読み直さず、入った仕訳の日とメモで読む）。道具 `private.accounting_dispute_lost_at(_dispute_id text) RETURNS timestamptz`（STABLE。lost の行が無ければ NULL）にまとめ、係と Task 7 の読み口が同じ物を使う。
     - 決め方: 決着した後、lost の時刻があり、戻りの取引の `stripe_created_at` が lost の時刻より後なら L（C が済むまで待つ）。lost の時刻が無いか、戻りの取引が lost の時刻と同じかそれより前なら R。届く順・係が流れる順・`occurred_at` では決めない。
  4. **L の貸方は、S が今ある科目から戻す。** C の借方が設定の科目なら、その科目。C の借方が補助 `dispute_confirmed_unassigned` で、X があれば、X の借方の科目。**X がまだ無ければ、L は入れず `dispute_withdrawal_missing`（detail `waiting_on: 'dispute_account_unassigned'`。お金の動く理由なので手では閉じられない）で待ち**、設定の科目が入って X が済んだ後に X の科目から戻す（補助から戻すと X が残高0で断られ、確定の年に費用が立たないため。設定が入るまで待ち続ける）。S=0（C が `no_revenue`）なら、借方 1160／貸方 2150（U の分だけ）。
  5. **全部の順番の試験。** 下の Step 1 の `FREQ-568-AC-07` が、届く順をすべて試して最後の残高と年ごとの利益を比べる。
  - **W（引かれた時。4-d・4-e）**: `dispute` の残高の取引（`amount<0`）1件に、種類 `dispute_event`、番号 `[dispute の番号,'withdrawn',取引の番号]`、日は取引の日本時間の日。引かれた額 A（`A = -amount`、代金。手数料込みの `net` を使うと取り消しの手数料が Task 4 と二重になる）を、その注文の着ごとの「残りの値打ち」で分ける（4-e2）。W の番号を N = `private.accounting_g_fact_seq_at(引かれた取引の stripe_created_at)` とする（Task 1。引かれた時までに G の鍵の中で取った番号の最大）。係は最初の `accounting_lock_all(NULL)` で G の鍵を持ってから N を数えるので、その時刻より前に番号を取った取引は全部終わっていて（番号は G の鍵の中でだけ取り、鍵はコミットまで外れない）、まだコミットしていない取引を見落とさず、N は数えた後に変わらない。残る隙は未確認事項 #13。値打ちと出荷済みかは `private.accounting_unit_values(注文, N)`（Task 1）の `value`・`shipped` で、出荷済みの着も未出荷の着も『支払額 − 番号 N までの割り当て』（計画3の 5-g の重みと同じ1つの式。出荷済みの着の値打ちは出荷の仕訳の額と同じ）。出荷済みかは `private.accounting_shipped_units(品, N)` だけで決まり（送る着・割り当ての検査と同じ道具）、出荷の仕訳や出荷の取り消しの仕訳が入っているかは見ない（出荷の係と dispute の係のどちらが先でも S と U が同じ）。割り振りは `private.accounting_allocate_amount(A, 値打ちの配列)`（端数は番号の若い着から）。出荷済みの着の合計を S、未出荷の着の合計を U とする（S+U=A）。注文に結び付かなければ `no_order`、成功した返金（`stripe_refunds.status='succeeded'`）があれば `dispute_refund_overlap`、返品の返金待ち（その注文の `order_id` つき 2130 の残高）があれば `dispute_return_refund_pending` で止める（相殺は計画3。4-e2）。行は、貸方 1160（A）、借方 2150（U、`order_id` つき。U>0 の時）、借方 1470（S、補助 `dispute_pending`、メモに原因。S>0 の時）。U が、その注文の前受金の残り（全部の仕訳の `order_id` つき 2150 の貸方−借方）を超えるなら `deferred_revenue_short`。取り消しの手数料は Task 4 の係が `stripe_fee`（メモ「取り消しの手数料」）で入れる。
  - **C（確定。4-e）**: その dispute の履歴に `status='lost'` の行が1つでもあり（`event_type` は問わない。知らせの行も毎晩の再照合の行も同じ扱い）、W の仕訳があり、lost の時刻と同じかそれより前の戻りの取引の R がすべて済んでいる時。dispute 1つに1回、種類 `dispute_event`、番号 `[dispute,'confirmed','lost']`、日は lost の時刻（規則3。Stripe 側の時刻）の日本時間の日。額は、その dispute の 1470 `dispute_pending` の今の残高。残高が0なら（S=0 の取り消し、または確定の前の取り下げで S の分が全部戻った後）、仕訳は作らず `no_revenue` で解決済みにする（解決済みの行の detail `lost_on` に、使った lost の時刻の日本時間の日を残す。Task 7 が読む）。残高が正なら、借方に「原因に合う科目」（`stripe_disputes.reason` から `accounting_dispute_account_settings` を引く。無ければ 1470 の補助 `dispute_confirmed_unassigned` に置く）、貸方 1470（補助 `dispute_pending`）。W の仕訳か、lost の時刻と同じかそれより前の R が無ければ `dispute_withdrawal_missing` で待つ（引かれた時が止まっている間に S が0に見えて `no_revenue` で閉じることはしない。R より先に C が残高の全部を振り替えて `dispute_pending` がマイナスになることもしない）。
  - **R（確定の前の取り下げ）と L（遅れた取り下げ。4-e2・1-a16）**: `dispute_reversal` の残高の取引（`amount>0`）1件に1本。種類 `dispute_event`、番号 `[dispute,'reversal',取引の番号]`、日は取引の日本時間の日。R か L かは規則3（決着の後に Stripe 側の時刻で決める）。戻った額 B を、W の仕訳の 2150 の借方 U と 1470 の借方 S の比で分ける（B が代金の全部でなくても比で分ける。代金だけが戻り、手数料は戻らない）。分け方: その dispute の戻りの取引を `stripe_created_at`、`id` の順に並べ、この取引までの戻りの累計を Bc、この取引の前までの累計を Bp として、S の分 = `floor(S × Bc / A) − floor(S × Bp / A)`、U の分 = B − S の分。Stripe 側の事実だけで決まり、入れる順に左右されない。戻りの合計が A になれば S の分の合計はちょうど S で、戻りが2回あっても `dispute_pending` がマイナスにも端数の残りにもならない。借方 1160（B。メモに `dispute_reversal_kind:R` か `dispute_reversal_kind:L` を残す。S=0 の時は貸方だけでは R と L を分けられないので、Task 7 はこのメモで読む）。貸方は、R なら 2150（U の分）と 1470（補助 `dispute_pending`。S の分）。L なら 2150（U の分）と、規則4の科目（S の分）。R は W の仕訳がある時、L は W と C が済んでいる時だけ入れ、そうでなければ `dispute_withdrawal_missing` で待つ。
- Produces（計上係の入口）: `private.accounting_run_posting(_limit integer) RETURNS jsonb` ＋ `public.accounting_run_posting(_limit integer DEFAULT 50) RETURNS jsonb`（INVOKER・service_role だけ）。`_limit` は 1〜200（外れたら `ACCOUNTING_ARGUMENT_INVALID`）。順に Task 2 の支払い → Task 3 の出荷 → Task 4 の Stripe → 本 Task の dispute を呼び、`{payments,shipments,stripe,disputes,parked,resolved,has_more}` を返す（`has_more` は、どれかの係で入れた・新しく止めた件数が `_limit` に達した時に真。同じ未解決を止め直しただけでは真にならない）。1回の呼び出しは1つのトランザクションで、各係が自分で鍵を取る。その中で出来事1件ごとの例外処理を行い、失敗は `posting_error` として保留し、ほかの出来事の成功を巻き戻さない（Global Constraints の共通規則）。
- Produces: S11 assert DETAIL `acc_s11_tables`・`acc_s11_functions`・`acc_s11_function_attrs`・`acc_s11_rls_acl`・`acc_s11_reads_stable`・`acc_s11_run_posting`・`acc_s11_existing_dml_allowlist`。

- **期間が無い時の日付:** W・C・R・X・L のすべてで、`period_missing` に止める `accounting_park_event` の `_detail` に、その段で入れようとした仕訳の日 `entry_date`（`YYYY-MM-DD`）を必ず入れる。W・R・L は対象の残高の取引の日本時間の日、C・X は確定の日（lost の時刻の日本時間の日）。未解決を見直して止め直す時も同じ。

- [ ] **Step 1: 失敗する試験を書く。** 設計 4-3 の例を数字で固定する。`FREQ-568-AC-01: 未出荷の注文の支払いの取り消し30,000円は、引かれた日に「前受金／Stripe未収金」30,000円で、取り消しの手数料1,500円は「支払手数料／Stripe未収金」`、`FREQ-568-AC-01: 取り下げられて代金が戻ると、戻った日に「Stripe未収金／前受金」30,000円だけで、手数料は戻らない`、`FREQ-568-AC-02: 出荷済みの注文の取り消し30,000円は、引かれた日に「仮払金（判断待ち）／Stripe未収金」で、原因がメモに残る`、`FREQ-568-AC-02: 2か月後に確定すると、設定の科目へ「設定の科目／仮払金」で振り替わる`、`FREQ-568-AC-02: 設定が無いまま確定すると「仮払金（確定・科目の決定待ち）」の補助に分けて置く`、`FREQ-568-AC-03: 引かれた後に確定した発送票の着は未出荷の分として分け、同じ回に流しても結果が変わらない`、`FREQ-568-AC-02: 知らせの行と再照合の行の両方でlostが来ても、確定の仕訳は1本`、`FREQ-568-AC-04: 決着の後に、戻りの取引の時刻がlostの時刻より後なら遅れた取り下げ、同じかそれより前なら確定の前の取り下げとして、戻りの取引1件に仕訳1本だけ入る（同じ回に確定の履歴と戻りが見つかっても）`、`FREQ-568-AC-04: 決着していないdisputeの戻りの取引はdispute_withdrawal_missingで待ち、手では確認済みにできず、決着すると入る`、`FREQ-568-AC-02: 引かれた時が計上待ちに止まっている間にlostが来ても、確定はdispute_withdrawal_missingで待ち、引かれた時が入った後に確定が1本入る（no_revenueで閉じない）`、`FREQ-568-AC-02: 確定の前に取り下げられると「Stripe未収金／仮払金」で戻り、確定の仕訳は作らない`、`FREQ-568-AC-03: 一部だけ出荷した注文は、引かれた額を出荷した着とまだの着の支払額の比で分け、端数は番号の若い着から`（例: 3着で支払額 10,000・10,000・10,001、1着目だけ出荷、引かれた額 10,000）、`FREQ-568-AC-03: 出荷前の返金の割り当てが一部当たった後に出荷した着の値打ちは支払額−割り当てで、前受金が残らない`（X 10,000円〔割り当て 1,000円の後に出荷〕・Y 10,000円〔未出荷〕、引かれた額 A = 19,000円。値打ち [9,000, 10,000] で S = 9,000・U = 10,000、W の後の前受金は0。`paid_amount` で数えると [10,000, 10,000] で S = U = 9,500 になり 500円残る。計画3の割り当てを fixture で直接入れる）、`FREQ-568-AC-03: 引かれた取引の時刻の前に鍵を取った発送票・割り当てだけを W が数え、後に鍵を取った物は数えない`、`FREQ-568-AC-03: 同じ支払いに2つの取り消しがあれば、取り消しの番号ごとに別の仕訳になる`、`FREQ-568-AC-04: 確定の後に遅れて取り下げられると、戻った日に「Stripe未収金／確定の時に振り替えた科目」で戻り、未出荷の分は前受金を戻す`、`FREQ-568-AC-05: 科目の設定は費用か収益の勘定だけを受け、それ以外はACCOUNTING_DISPUTE_ACCOUNT_INVALID、版違いはVERSION_CONFLICT、同じ要求番号の再送は前の結果`、`FREQ-568-AC-05: 設定を後から入れて振り替えると「設定の科目／仮払金（確定・科目の決定待ち）」が1本入り、2回目は要求番号を変えても何も足さず、補助の残高がマイナスにならない`、`FREQ-568-AC-04: 確定→遅れた取り下げ→振り替えの順に届いても、確定→振り替え→遅れた取り下げの順でも、遅れた取り下げは振り替えの後に振り替えの科目から入り、補助の残高が0になり、費用はS−Rになる`、`FREQ-568-AC-04: 設定が無いまま確定し遅れて取り下げられると、遅れた取り下げはdispute_withdrawal_missing（dispute_account_unassigned）で待ち、手では確認済みにできず、設定を入れて振り替えた後に入り、確定の年の費用がSになる`（年をまたぐ例。Y: −18,750、Y+1: +18,750）、`FREQ-568-AC-04: 確定の仕訳が計上待ちに止まっている間の遅れた取り下げは入らず、確定が入った後に入る`、`FREQ-568-AC-04: 設定がある時に確定し、遅れて取り下げられると、設定の科目から戻り、補助は0のまま`、`FREQ-568-AC-04: 未出荷だけの取り消しが確定した後に遅れて取り下げられると、借方1160貸方2150（Uの分だけ）で前受金が戻り、計上待ちに残らない`、`FREQ-568-AC-04: 引かれた時が止まっている間に取り下げられても、引かれた時が入った後に取り下げが入り、補助は0`、`FREQ-568-AC-04: 戻りの取引が先に保存されlostの行が後で届いても、決着を待って遅れた取り下げ（L）で入り、確定はSの額で入る`（`syncDisputeAccounting` の②と③の間に係を流す形も含める）、`FREQ-568-AC-04: lostの知らせと毎晩の再照合の届く順を入れ替えても、RかLかと年ごとの利益が同じ`（年をまたぐ例: lost の Stripe の時刻が 12月20日、戻りの取引が翌年1月15日。知らせの行が先・再照合の行が先・再照合の行だけ〔Stripe の出来事の一覧から時刻を取る〕の3つで、確定の日が12月20日、戻りが L で1月15日、12月の年の利益が −18,750、翌年が +18,750。戻りの取引が12月10日の例は3つとも R）、`FREQ-568-AC-04: lostより前の知らせ（12月15日のcharge.dispute.updated）をlostの後に処理しても、lostの時刻は負けた出来事（12月20日）の時刻`、`FREQ-568-AC-04: どのlostの行にもStripeの時刻が無い時だけ、lostの行のoccurred_atの最も古い物をlostの時刻とする`、`FREQ-568-AC-04: lostの時刻より前の戻り（R）が止まっている間は確定も待ち、Rの後の残高で確定が入りdispute_pendingがマイナスにならない`、`FREQ-568-AC-04: 戻りが2回（B1+B2=A）あっても、Sの分の合計はちょうどSで補助が0になる`（S=18,750・A=30,000・B1=10,001・B2=19,999。入れる順を入れ替えても各仕訳の額が同じ）、`FREQ-568-AC-05: 振り替えの日は確定の仕訳の日で、年を越してから振り替えても費用は確定の年に立つ`、`FREQ-568-AC-03: 引かれる前に確定した発送票の出荷の仕訳が止まっている間は引かれた時も待ち（dispute_shipment_pending）、両方入った後に出荷済みとして分かれる`、`FREQ-568-AC-03: 引かれた後に発送票を取り消しても、出荷の係とdisputeの係のどちらを先に流してもWのSとUが同じ`（引かれる前に確定し出荷の仕訳が入った発送票を、引かれた後に取り消す。W の S は変わらず、出荷の取り消しの仕訳は 2150 を戻すだけ）、`FREQ-568-AC-07: disputeの出来事がどの順で届いても、最後の残高は同じ`（下の表）、`FREQ-568-AC-05: 設定が無い時に振り替えようとするとEVENT_NOT_POSTABLE`、`FREQ-568-AC-06: 判断待ちの注文を、読み口が注文と取り消しの番号つきで返す`、`FREQ-568-AC-06: 事前の問い合わせ（warning系）は保留に数えない`、`FREQ-568-AC-06: 確定または取り下げ後は保留から外れる`、`FREQ-568-AC-01: 成功した返金がある注文はdispute_refund_overlapで止まり、二重に費用にしない`、`FREQ-568-AC-01: 返品の返金待ち（2130）がある注文はdispute_return_refund_pendingで止まる`、`FREQ-568-AC-01: 結び付く注文が無い取り消しはno_orderで止まる`、`FREQ-568-AC-01: 同じ取り消しを2回・同時に流しても1本ずつ`（並行。3連続）、`FREQ-569-AC-01: W・C・R・X・Lがperiod_missingで止まるとdetail.entry_dateがその段の仕訳の日になり、止め直しても日付が残る`。
  `FREQ-568-AC-07` の期待の表（注文30,000円・W の A=30,000円。特に書かない時は S=18,750・U=11,250。lost の Stripe の時刻は Y 年12月20日、L の戻りは Y+1 年1月15日、R の戻りは Y 年12月10日）。
  - 「場合」は、Stripe 側の事実（lost の有無と時刻、戻りの時刻と額）と人の操作（C を入れる前に設定があるか、X を戻りの前にするか後にするか）で分ける。「設定あり」は「C を入れる前に設定がある」こと。C の後に入れた設定は「設定なし」の行で X を待つ。
  - 届く順（知らせ・毎晩の再照合・遅れた知らせ、残高の取引の保存と履歴の保存の間に係が流れる、lost の知らせと再照合の入れ替え、W が止まって後で入る）は、同じ行の中で全部試す。1つの答えになるのは、最後の残高と年ごとの利益。
  - 本数は届く順ごとに書く。どの行でも、届く順で本数は変わらない（R か L かは Stripe 側の時刻で決まり、C の `no_revenue` も事実だけで決まる）。本数が行で違うのは設定と X の有無だけで、それも1つの出来事に1本までの範囲（戻りの取引1件に1本、確定と振り替えは dispute 1つに1回）。試験は、どの出来事にも仕訳が2本以上入らないことも確かめる。

  | 場合 | 最後の `dispute_pending` | 最後の `dispute_confirmed_unassigned` | 費用の科目 | 2150 の増減 | 年ごとの利益 | 仕訳の本数（届く順ごと） |
  | --- | --- | --- | --- | --- | --- | --- |
  | 1. lost のみ、設定あり | 0 | 0 | 18,750 | −11,250 | Y: −18,750 | どの順でも 2（W・C） |
  | 2. lost のみ、設定なし。C の後に設定を入れて X | 0 | 0 | 18,750 | −11,250 | Y: −18,750（X の日は C の日） | どの順でも 3（W・C・X）。X の前は補助 18,750・費用 0 |
  | 3. lost の後に全額の戻り（L）、設定あり | 0 | 0 | 0 | 0 | Y: −18,750、Y+1: +18,750 | どの順でも 3（W・C・L）。戻りの取引が lost の行より先に保存されても、決着を待つので同じ |
  | 4. 同（L）、設定なし、X が戻りより前 | 0 | 0 | 0 | 0 | Y: −18,750、Y+1: +18,750 | どの順でも 4（W・C・X・L。L は X の科目から戻す） |
  | 5. 同（L）、設定なし、戻りが X より先に届く | 0 | 0 | 0 | 0 | Y: −18,750、Y+1: +18,750（L は X を待つので4行目と同じ） | どの順でも 4（W・C・X・L）。X の前は L が `dispute_account_unassigned` で待つ |
  | 6. 全額の戻りが lost の時刻より前（R）、設定あり | 0 | 0 | 0 | 0 | 0 | どの順でも 2（W・R。C は残高0で `no_revenue`） |
  | 7. lost の後に一部の戻り B=10,000（L。U'=3,750・S'=6,250）、設定あり | 0 | 0 | 12,500（S−S'） | −7,500 | Y: −18,750、Y+1: +6,250 | どの順でも 3（W・C・L） |
  | 8. 一部の戻り B=10,000 が lost の時刻より前（R）、設定あり | 0 | 0 | 12,500 | −7,500 | Y: −12,500 | どの順でも 3（W・R・C。C は R の後の残高 12,500） |
  | 9. S=0・U=30,000、lost の後に戻り（L） | 0 | 0 | 0 | 0 | 0 | どの順でも 2（W・L。C は `no_revenue`） |
  | 10. U=0・S=30,000、戻りのみ（lost 無し、`won`） | 0 | 0 | 0 | 0 | 0 | どの順でも 2（W・R） |
  | 11. U=0・S=30,000、lost のみ、設定あり | 0 | 0 | 30,000 | 0 | Y: −30,000 | どの順でも 2（W・C） |
  | 12. 判断待ちのまま（lost も戻りも無い） | 18,750 | 0 | 0 | −11,250 | 0 | どの順でも 1（W） |
  | 13. W が止まっている間に lost と戻りが届き、あとで W が入る | 同じ場合の行と同じ | 同じ | 同じ | 同じ | 同じ | 同じ。待っている間は仕訳が増えない |

  係の入口: `FREQ-569-AC-06: 1件の出来事がcoreで失敗してもほかの係の出来事は計上され、SET CONSTRAINTS ALL IMMEDIATEの後にも成功と保留が残る`、`FREQ-569-AC-06: posting_errorが毎回失敗しても新しい候補を塞がず、直した後の再計上で保留が解決する`、`FREQ-562-AC-05: 係の入口は支払い・出荷・Stripe・取り消しを順に処理し、同じ内容を2回流すと2回目は0件`、`FREQ-562-AC-05: 支払いより先に出荷が起きていても、1回の呼び出しの中で支払い→出荷の順に入り、出荷は計上待ちに止まらない`、`FREQ-569-AC-02: 計上待ちの出来事は、直ると次の呼び出しで入り解決済みになる`、`FREQ-569-AC-02: 直らない未解決の計上待ちが_limit件あっても、後ろの新しい出来事は入り、has_moreは偽になる`、`FREQ-562-AC-05: 入口は limit が範囲の外なら断り、has_more は入れた・新しく止めた件数が上限に達した時だけ真`、`FREQ-562-AC-05: 入口はservice_roleだけが呼べ、anonとauthenticatedはPostgRESTで断られる`（コミットする試験。別の jest 実行で、前後に `db reset`）。
- [ ] **Step 2（controller）: RED を測る。** 上の DB suite。
- [ ] **Step 3: S11 を実装する。** 引かれた時の分け方（値打ちの配列を作り、時刻で出荷済みと未出荷に分ける）と、戻りの分け方（累計の式。R と L が同じ関数を使う）は、それぞれ1つの plpgsql の関数にまとめる。R か L かと lost の時刻は `private.accounting_dispute_lost_at` だけで決める。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。並行は3連続成功。入口の PostgREST の試験。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 支払いの取り消しを原因つきで仕訳にし計上係の入口を足す`

### Task 7: 受注高・受注残・前受金の確認・照らし合わせの読み口（8章・2-e）

controller が別セッションへ先に知らせる（新しい読み関数だけ。G の表は読むだけ）。Task 6 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-569・571 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts12>_accounting_p2_intake_reads.sql`、`tests/integration/db/accounting_p2_intake_reads.integration.test.ts`、`tests/integration/db/accounting_p2_intake_reconciliation.integration.test.ts`、`tests/integration/db/accounting_p2_deferred_revenue.integration.test.ts`
- Modify: `tests/integration/db/accounting_p2_migration_asserts.integration.test.ts`、`tests/integration/db/helpers/accounting-orders-fixtures.ts`（`postManualEntryFixture` を足す。返品・返金の仕訳を計画3の前に試験で作るため、core を直接呼ぶ）
- Test: 上の DB 3 suite
- Read: 設計 8-2・8-3・8-g2、`supabase/migrations/20261023211425_group_g1_allocation.sql`（`private.list_admin_order_item_states`）、`orders` の列（`subtotal_amount`・`discount_amount`・`total_amount`・`user_id`・`session_id`）

**Interfaces:**
- Consumes: 仕訳の行（元も取り消しも全部。`accounting_journal_lines.order_id` と 2150・4010・4020・4050・2130）、`accounting_journal_entries.event_kind`、Task 6 の dispute の表と仕訳、`orders`、`private.list_admin_order_item_states`。
- Produces（読み口。STABLE・service_role 専用・actor なし）:
  - `public.list_order_intake_events(_from date, _to date, _limit integer DEFAULT 5000, _after_date date DEFAULT NULL, _after_key text DEFAULT NULL) RETURNS jsonb` → `{events:[{order_id,event_date,kind,amount,key}],next_after_date,next_after_key}`。`kind` と符号（日本時間の日で `_from`〜`_to`）:
    - `payment`（＋）: `payment_confirmed` の仕訳の 2150 の貸方（8-c: 日は4-aの前受金の仕訳の日）。
    - `pre_shipment_cancel`（−）: `pre_shipment_refund` の仕訳の 2150 の借方（日は返金の残高の取引の日。計画3が仕訳を入れる。入るまで0）。
    - `dispute_unshipped`（−）: 確定（`lost`）した dispute の、引かれた時の仕訳の 2150 の借方 U から、その dispute の R の仕訳の 2150 の貸方の合計を引いた額を、確定の日に（8-d）。確定の前に取り下げられた分（R）は引かない。確定の日は、C の仕訳があればその仕訳の日、C が `no_revenue` ならその解決済みの行の detail `lost_on`（どちらも入れた時の lost の時刻の日。後から道具の答えが変わっても、入った仕訳と食い違わない）。C が `no_revenue` でも U が残れば引く。
    - `dispute_unshipped_restored`（＋）: 遅れた取り下げ（L）の仕訳の 2150 の貸方を、戻った日に。L か R かは、入った仕訳の 1160 の行のメモ（`dispute_reversal_kind:L`／`R`。Task 6）で読み、道具を読み直さない。確定の前の取り下げ（R）は受注高に足さない（確定の前なので引いていない）。
    `key` は続きの目印（`<entry_id>:<line_no>`）。上限 `5000`。元の仕訳も取り消しの仕訳も、全部の行を足す（取り消しは符号が逆なので打ち消し合う。「取り消された元を外す」扱いは併用しない。二重に引かないため）。
  - `public.get_intake_breakdown(_from date, _to date) RETURNS jsonb`（8-h）: `{subtotal_before_discount, discount, pre_shipment_cancel, dispute_unshipped, intake, order_count, breakdown_ok}`。`subtotal_before_discount` と `discount` は、期間に支払いの仕訳がある注文の `orders.subtotal_amount`・`orders.discount_amount` の合計。`intake = payment + pre_shipment_cancel + dispute…`（符号つき）。`breakdown_ok` は `subtotal − discount + 送料(0) − …` が `intake` に合うか。出荷後の返品・返品の手数料の売上は足し引きしない。
  - `public.get_order_backlog(_as_of date) RETURNS jsonb` → `{backlog_total, order_count}`（受注残＝ `_as_of` までの、注文番号つき 2150 の貸方−借方の合計。8-2「言葉」）。
  - `public.get_intake_reconciliation(_from date, _to date) RETURNS jsonb`（8-g・8-g2）。
    - 1段目: `{opening_backlog, intake, sales_before_return, closing_backlog, exceptions:[{kind,label_key,amount}], unexplained}`。`sales_before_return` は、注文番号つきの 4010 の貸方−借方のうち、出荷の仕訳（`shipment_confirmed`/`shipment_redated`）とその取り消しの分（日の直しと取り消しは打ち消し合う）。`closing_backlog` は読み取った値。`exceptions` は 8-g2 の行: `dispute_pending`（引かれた時に前受金を減らしたが受注高にはまだ引いていない額の増減）、`return_refund_2130`（2130 の動きに伴う 2150 の動き。計画3が入れるまで0）、`other`（上に当たらない種類で 2150 を動かした仕訳。種類ごと）。`unexplained = closing_backlog − (opening_backlog + intake − sales_before_return + Σ exceptions)`。0でなければ画面は赤く出す。
    - 2段目: `{sales_before_return, returns, booked_sales_net_orders, return_fee_revenue_4050, other_4010, book_sales_total, unexplained2}`。`returns` は注文番号つきの 4020 の借方−貸方（出荷後の返品・値引き）、`booked_sales_net_orders = 4010 − 4020`（注文番号つき）、`return_fee_revenue_4050` は 4050 の貸方−借方（別の行）、`other_4010` は注文番号なしの 4010（店頭・持ち出し・投稿との交換など。全体の帳簿へつなぐ）、`book_sales_total` は全体の 4010−4020（4050 を入れない）。`unexplained2 = (sales_before_return − returns) − booked_sales_net_orders`。8-g2 の「確定した出荷済みの取り消しは振替先の勘定ごとに示す」行として、`dispute_confirmed_by_account:[{account_code,amount}]`（確定の仕訳の借方を勘定ごと。決まるまでは 1470 の補助 `dispute_confirmed_unassigned`）を2段目の例外の行に足す。
  - `public.list_deferred_revenue(_as_of date, _limit integer DEFAULT 100, _after_order uuid DEFAULT NULL) RETURNS jsonb`（2-e）: `_as_of` 時点で前受金の残りがある注文を、`{orders:[{order_id,order_number,balance,paid_on,unshipped_units,states:{ready,in_production,…}}],next_after_order,total_balance}` で返す。`states` は `private.list_admin_order_item_states` の未出荷の着の状態別の数（出荷の見込み）。画面は、課税事業者になる期間の初めの前の日を `_as_of` にして出す。
  - `public.list_deferred_revenue_anomalies() RETURNS jsonb`（2-a）: 前受金の残りがマイナスの注文、全部の着を送るか返金済みなのに前受金が0でない注文を、理由つきで。個人の情報を含めない。
- Produces: S12 assert DETAIL `acc_s12_functions`・`acc_s12_function_attrs`・`acc_s12_reads_stable`・`acc_s12_existing_dml_allowlist`。

- [ ] **Step 1: 失敗する試験を書く。** 設計 8-3 の例（1/20 に支払い 18,750、2/3 に出荷、3/10 に返品の品が届き、3/12 に返金。返品の手数料 1,000）の表を数字で固定する（返品・返金の仕訳は `postManualEntryFixture` で、種類 `return_arrived` などを core に直接入れて作る。計画3の実装に頼らない）。`FREQ-571-AC-01: 受注高の対象は支払いを受けた注文（支払い済み・発送済み・あとで取り消した）で、支払いの途中・失敗・放棄の注文を含まない`、`FREQ-571-AC-01: 受注高の日は支払いの仕訳の日で、orders.paid_atやcreated_atを使わない`、`FREQ-571-AC-02: 内訳（割引の前の商品の額−割引−出荷前の取り消し）の合計が受注高に合い、合わなければbreakdown_okが偽`、`FREQ-571-AC-03: 出荷して発送済みになった注文も、出荷後に返品が届いても受注高は変わらない`（1月の受注高18,750、3月の受注高0）、`FREQ-571-AC-03: 出荷前の取り消しの仕訳があれば、その返金の日に受注高から引く`、`FREQ-571-AC-04: カード会社の取り消しは、確定した日に未出荷の分だけ受注高から引き、確定の前に取り下げられた分は引かない`、`FREQ-571-AC-04: 確定の後に遅れて戻った分は戻った日に未出荷の受注高を戻す`、`FREQ-571-AC-04: 確定の前に一部が戻った時は、UからRの2150の貸方を引いた額を、確定がno_revenueの時もlostの日に引く`、`FREQ-571-AC-04: 2つの取り消しがあっても同じ額を二重に引かない`、`FREQ-571-AC-05: 1月から3月まで、期首の受注残＋受注高−売上高（返品の前）＝期末の受注残が合う（8-3 の表）`、`FREQ-571-AC-05: 判断待ちの取り消しで前受金を先に減らした分は例外の行（dispute_pending）で説明され、説明のつかない差は0`、`FREQ-571-AC-05: 上に当たらない種類で2150を動かした仕訳は other の行に種類ごとに出る`、`FREQ-571-AC-06: 3月の売上高（返品の前）0−返品18,750＝帳簿の売上高−18,750、返品の手数料の売上1,000は別の行`、`FREQ-571-AC-06: 注文番号なしの4010（店頭など）はother_4010に出て全体の帳簿へつながり、4050は帳簿の売上高に入らない`、`FREQ-571-AC-05: 続きの目印で最後まで読め、元と取り消しを両方足して合計が合う（二重に引かない）`。`FREQ-571-AC-05: 年末に払って翌年に出荷する注文は、年末の受注残に残り翌年の売上高になる`、`FREQ-569-AC-04: 繰り越した前受金の一覧が注文・額・出荷の見込みつきで出る`、`FREQ-569-AC-04: 前受金がマイナスの注文と、全部送った後に0でない注文が異常の一覧に出る`、`FREQ-569-AC-04: 異常の一覧にお客様の名前・メールを含めない`。
- [ ] **Step 2（controller）: RED を測る。** 上の DB suite。
- [ ] **Step 3: S12 を実装する。** 日はすべて仕訳の `entry_date`（日本時間の日）。読み口は1回の呼び出しで大量に読まない作り（続きの目印）にする。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify（読み口は STABLE の assert）。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 受注高と受注残と照らし合わせの読み口を追加する`

### Task 8: 月の KPI の表 `admin_kpi_monthly_records`（8章・11-g）

controller が別セッションへ `src/lib/meta/sync-kpi.ts` と `monthly-record/route.ts` の対象を先に知らせる。Task 7 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-573 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts13>_accounting_p2_kpi_monthly_records.sql`、`tests/integration/db/accounting_p2_kpi_monthly_records.integration.test.ts`、`tests/unit/api/admin/kpi-monthly-record-route.test.ts`
- Modify: `src/app/api/admin/kpi/monthly-record/route.ts`（表への直接書き込みをやめ、下の RPC を使う。表が無い時の 503 の文と `TABLE_MISSING_DETAIL` を消す）、`src/lib/meta/sync-kpi.ts:206`（`system_upsert_kpi_monthly_records` を使う）、`tests/unit/lib/meta/*`（同期の試験がある場合）、`tests/integration/db/accounting_p2_migration_asserts.integration.test.ts`
- Test: 上の DB 1 suite と単体
- Read: `migrations/063_create_admin_kpi_monthly_records.sql`（旧定義）、`src/lib/kpi/monthly-metrics.ts:93-200`（`isValidStorageKey`・保存の鍵）、`src/components/KpiSection.tsx:975,1634`

**Interfaces:**
- Consumes: 今のコードが使う列 `month_key`・`metric_key`・`value`（`UNIQUE (month_key, metric_key)`）。
- Produces（表。`public`、RLS 有効、所有者 postgres、PUBLIC/anon/authenticated に権限なし、service_role は SELECT のみ。計画1の新しい表の決まり）: `admin_kpi_monthly_records(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, month_key text NOT NULL CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), metric_key text NOT NULL CHECK (metric_key ~ '^(src|kpi):[A-Za-z0-9_]{1,64}$'), value numeric NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (month_key, metric_key))`、索引 `(month_key)`、更新時刻のトリガー `private.admin_kpi_monthly_records_touch()`。`IF NOT EXISTS` を付けない（既にあれば適用が止まり、本番の事前の読みで想定外と分かる）。方針は表の RLS 有効のみ（直接の経路を持たない）。
- Produces（書き口）: `private.admin_set_kpi_monthly_records(_actor_id uuid, _updates jsonb) RETURNS integer` ＋ 同名の `public` 入口（INVOKER・service_role だけ）。`_updates` は `[{"month_key":"2026-07","metric_key":"kpi:sales","value":123.4}]` を最大200件（`value` が NULL は削除）。最初に `private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.read'])`（外れたら `ACCOUNTING_FORBIDDEN / 42501`）。route が既に確かめている店長の確認（`role === 'admin'`）は route に残す。月の鍵・指標の鍵は CHECK と route の zod の両方で確かめる。戻りは書いた件数。`public.system_upsert_kpi_monthly_records(_rows jsonb) RETURNS integer`（actor なし・権限の確認なし。Meta の同期 cron だけが使う service_role 専用。最大200件の upsert）。読み口 `public.list_kpi_monthly_records(_month_keys text[]) RETURNS TABLE(month_key text, metric_key text, value numeric)`（STABLE・service_role 専用。月は24件まで）。
- Produces（TS）: `monthly-record/route.ts` の GET は `list_kpi_monthly_records` を、PUT は `admin_set_kpi_monthly_records` を呼ぶ。認可（`admin.orders.read` ＋ `role === 'admin'`）と本文・応答の形は今のまま。表が無い時の 503 の分岐は消す。`src/lib/meta/sync-kpi.ts` の upsert を `system_upsert_kpi_monthly_records` に替える。
- Produces: S13 assert DETAIL `acc_s13_table`・`acc_s13_constraints`・`acc_s13_rls_acl`・`acc_s13_function_attrs`・`acc_s13_existing_dml_allowlist`。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-573-AC-01: 表は移行にあり、anonとauthenticatedに権限が無くservice_roleはSELECTだけ`、`FREQ-573-AC-01: 月と指標の鍵の形が違う行を断る`、`FREQ-573-AC-02: 保存と、値NULLでの削除が通り、同じ月・指標は1行のまま更新される`、`FREQ-573-AC-02: 更新時刻が更新で進む`、`FREQ-573-AC-02: 書き口は権限なしを42501で断り、201件は断る`、`FREQ-573-AC-02: Metaの同期の書き口は権限の確認なしでupsertできる`、`FREQ-573-AC-03: 月の記録のrouteはaal1・権限なし・サポーターを断り、店長だけ保存できる`（単体）、`FREQ-573-AC-03: 保存の失敗でも本文に表の名前や作り方の案内を出さない`、`FREQ-573-AC-02: GETは期間の月の値を返し、表が空でも空の値を返す`。
- [ ] **Step 2（controller）: RED を測る。** 上の DB suite と単体。
- [ ] **Step 3: S13 と TS を実装する。** 旧 `migrations/063` と `tests/unit/migrations/063_*.test.ts` は履歴として残し、触らない。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。月の記録の既存の E2E（`FR-ADMIN-017`・`FR-ADMIN-018`）は作り物の応答なので、画面の回帰として流すだけにする（実際の保存の確かめは Task 14 の ADMIN-135）。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(kpi): 月の記録の表を移行で作り書き込みをDB関数にする`

### Task 9: 出荷の年末の照合と運送会社の受付日の照合（6-d・6-d2）

controller が別セッションへ先に知らせる（読み口と設定だけ。G の表は読むだけ）。Task 8 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-574 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts14>_accounting_p2_year_end_shipments.sql`、`tests/integration/db/accounting_p2_year_end_shipments.integration.test.ts`
- Modify: `tests/integration/db/accounting_p2_migration_asserts.integration.test.ts`
- Test: 上の DB 1 suite
- Read: `supabase/migrations/20261025053324_group_g3_shipping_foundation.sql`（`shipment_slips` の列）、`20261021220816_delivery_tracking_records.sql:114-135`（`order_fulfillment_events`）

**Interfaces:**
- Consumes: `shipment_slips`（`id`・`number`・`stage`・`shipment_date`・`confirmed_at`・`shipping_carrier`・`tracking_number`）、`shipment_slip_fulfillments`、`order_fulfillment_events`（`status='in_transit'`・`source='tracking'`・`happened_at`）。
- Produces（表。`public`、RLS 有効、所有者 postgres、PUBLIC/anon/authenticated に権限なし、service_role は SELECT のみ）:
  - `accounting_shipment_checks(slip_id uuid PRIMARY KEY FK shipment_slips RESTRICT, checked_by uuid NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), note text NULL CHECK (char_length(note) <= 200), request_key uuid NOT NULL UNIQUE, request_hash text NOT NULL)`。追記専用。1枚の発送票に確かめた印は1つ。
  - `accounting_shipping_options(id smallint PRIMARY KEY CHECK (id = 1), carrier_date_check_enabled boolean NOT NULL DEFAULT false, changed_at timestamptz NULL, changed_by uuid NULL, version bigint NOT NULL DEFAULT 1, admin_requests jsonb NOT NULL DEFAULT '{}')`。1行。S14 が初期行を入れる（移行実行時の DML はこの1行だけ）。
- Produces（関数）:
  - `public.list_year_end_shipments(_from date, _to date, _limit integer DEFAULT 100, _after_date date DEFAULT NULL, _after_slip uuid DEFAULT NULL) RETURNS jsonb`（STABLE・service_role 専用）: `{slips:[{slip_id,number,shipment_date,confirmed_at,stage,shipping_carrier,tracking_number,checked_at,checked_by}],next_after_date,next_after_slip}`。`shipment_date` が `_from`〜`_to` の確定または取り消し済みの発送票を、出荷した日・発送票の順に。範囲は最長60日、上限200件。画面の既定は、締める年の12月25日〜翌年1月10日（6-d）。
  - `admin_check_year_end_shipment(_actor_id uuid, _slip_id uuid, _note text, _request_key uuid) RETURNS jsonb`（private 本体＋service_role 専用の public 入口。権限 `admin.finance.manage`。確かめた印を1つ入れる。同じ票への2回目は前の印をそのまま返す〔`created:false`〕。同じ要求番号で違う内容は `ACCOUNTING_REQUEST_KEY_CONFLICT`）。
  - `public.get_shipping_options() RETURNS jsonb` と `admin_set_shipping_options(_actor_id uuid, _carrier_date_check_enabled boolean, _expected_version bigint, _request_key uuid) RETURNS jsonb`（権限 `admin.accounting.settings.manage`。版違いは `ACCOUNTING_VERSION_CONFLICT`。切り替えた日時と人を残す）。
  - `public.list_carrier_date_gaps(_from date, _to date, _limit integer DEFAULT 100) RETURNS jsonb`（STABLE・service_role 専用）: オプションがオフなら `{enabled:false,slips:[]}`。オンなら、発送票ごとに、その票の発送の追跡の `in_transit`（`source='tracking'`）の最初の `happened_at` の日本時間の日を「運送会社の受付の日」として、出荷した日とのずれが1日以上の票を `{slip_id,number,shipment_date,carrier_accepted_date,gap_days}` で返す。受付の日が取れない票は含めない（追跡が動いていない間は空）。
- Produces: S14 assert DETAIL `acc_s14_tables`・`acc_s14_constraints`・`acc_s14_immutable`・`acc_s14_rls_acl`・`acc_s14_function_attrs`・`acc_s14_existing_dml_allowlist`（DML は `accounting_shipping_options` の1行だけ）。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-574-AC-01: 12月25日から1月10日の発送票が運送会社・追跡番号・出荷した日つきで、出荷した日の順に出る`、`FREQ-574-AC-01: 続きの目印で最後まで読め、範囲の外の日の票は出ない`、`FREQ-574-AC-01: 60日を超える範囲と200件を超える上限は断る`、`FREQ-574-AC-02: 確かめた印は人と時刻つきで入り、同じ票への2回目は二重に付かない`、`FREQ-574-AC-02: 確かめた印は権限なしを42501で断り、追記専用でUPDATEとDELETEを断る`、`FREQ-574-AC-03: 設定の既定はオフで、切り替えると切り替えた日時と人が残り、版違いはVERSION_CONFLICT`、`FREQ-574-AC-03: 設定の切り替えは権限なしを42501で断る`、`FREQ-574-AC-04: オフの間は受付の日とのずれの一覧が空で、オンの時だけ1日以上ずれた票が出る`、`FREQ-574-AC-04: 追跡が動いていない票（受付の日が取れない票）はずれの一覧に出ない`。
- [ ] **Step 2（controller）: RED を測る。** 上の DB suite。
- [ ] **Step 3: S14 を実装する。** `in_transit` を「運送会社の受付」に当てるのは仮定（未確認 #3）。追跡の状態の意味は E-4 の追跡が動いてから確かめる。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 出荷の年末の照合と運送会社の受付日の照合を追加する`

### Task 10: 計上係の呼び出し・cron・計上待ちほかの route

controller が別セッションへ `src/lib/stripe/webhook-processor.ts`・`src/app/api/webhook/**`・`src/app/api/cron/stripe-reconcile/route.ts`・発送票の3つの route の変更を先に知らせる。Task 9 のコミット後に始める。決済のファイル（`checkout/**`）は触らない。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-562〜569 のうちこの Task が証明する AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/pending/schedule_accounting_post.sql`（10分ごとの登録。置き場は `schedule_stripe_reconcile.sql` などと同じ。当てるのは運用の手順 3）、`src/lib/accounting/posting-schema.ts`、`src/lib/accounting/posting-store.ts`（`server-only`）、`src/lib/accounting/posting-runner.ts`、`src/lib/accounting/posting-route.ts`、`src/app/api/cron/accounting-post/route.ts`、`src/app/api/admin/accounting/pending-events/route.ts`、`src/app/api/admin/accounting/pending-events/[id]/resolve/route.ts`、`src/app/api/admin/accounting/posting/run/route.ts`、`src/app/api/admin/accounting/dispute-settings/route.ts`、`src/app/api/admin/accounting/disputes/route.ts`、`src/app/api/admin/accounting/disputes/[id]/assign/route.ts`、`src/app/api/admin/accounting/stripe-invoices/route.ts`、`src/app/api/admin/accounting/balance-topups/route.ts`、`src/app/api/admin/accounting/reconciliation/route.ts`、`src/app/api/admin/accounting/deferred-revenue/route.ts`、`src/app/api/admin/accounting/year-end-shipments/route.ts`、`src/app/api/admin/accounting/shipment-trace/route.ts`、対応する単体（`tests/unit/lib/accounting/posting-store.test.ts`・`posting-runner.test.ts`、`tests/unit/api/cron/accounting-post-route.test.ts`、`tests/unit/api/admin/accounting-pending-events-route.test.ts`・`accounting-disputes-route.test.ts`・`accounting-stripe-route.test.ts`・`accounting-reconciliation-route.test.ts`・`accounting-year-end-route.test.ts`）
- Modify: `src/lib/accounting/accounting-types.ts`（計画1の `ACCOUNTING_ERRORS` に共通の型の節の3行を足す）、`src/lib/stripe/webhook-worker.ts`（1回の処理の終わりに1回だけ `safeRunAccountingPosting` を待つ。注文のメールの前）、`src/lib/ops/ops-store.ts`（`OpsJob` に `accounting_post`、`OpsAlertKey` に `job_stale_accounting_post`）、`src/lib/ops/ops-alert-mail.ts`（`staleJobMail` の札・30分・手順の節）、`src/lib/ops/ops-checks.ts`（止まったと見なす時間 `staleAfterSeconds` を30分〔10分ごとの3回分〕で足す）、`src/app/api/cron/stripe-reconcile/route.ts`（最後に呼ぶ）、`src/app/api/admin/accounting/stripe-payouts/[id]/confirm/route.ts`（着金の確認の直後）、`src/app/api/admin/shipment-slips/[id]/confirm/route.ts`・`[id]/cancel/route.ts`・`[id]/shipment-date/route.ts`、`src/lib/orders/shipment-slips/shipment-slip-notice.ts`（`DISPUTE_HOLD` の文）、`src/app/api/admin/accounting/journal/route.ts`（計画1の route。応答に `shipmentMeta` を足す）、各 route の既存の単体
- Test: 上の単体
- Read: `src/lib/discounts/admin-discount-route.ts`（書込の順序の手本）、`src/app/api/cron/stripe-reconcile/route.ts`（cron の認可・heartbeat・監査の手本）、`src/lib/cron/auth.ts`、`src/lib/ops/ops-store.ts`、`src/app/api/admin/shipment-slips/[id]/confirm/route.ts`

**Interfaces:**
- Consumes: Task 1〜9 の public 入口（`accounting_run_posting`・`list_accounting_pending_events`・`admin_resolve_accounting_pending_event`・`get_slip_dispute_holds`・`get_order_dispute_holds`・`list_dispute_account_settings`・`admin_set_dispute_account_setting`・`admin_assign_dispute_confirmed`・`list_accounting_disputes`・`admin_set_stripe_invoice_record`・`admin_record_balance_topup`・`get_stripe_fee_reconciliation`・`get_stripe_balance_reconciliation`・`get_intake_reconciliation`・`get_intake_breakdown`・`list_deferred_revenue`・`list_deferred_revenue_anomalies`・`list_year_end_shipments`・`admin_check_year_end_shipment`・`get_shipping_options`・`admin_set_shipping_options`・`list_carrier_date_gaps`・`get_shipment_journal_trace`・`list_journal_shipment_meta`）。
- Produces（計上係の呼び出し）: `runAccountingPosting(client, opts?: {limit?: number}): Promise<PostingRunResult>` は `accounting_run_posting` を `hasMore` が偽になるまで繰り返す（最大 `MAX_POSTING_LOOPS=20`）。`safeRunAccountingPosting(source: 'webhook'|'shipment_confirm'|'shipment_cancel'|'shipment_date'|'bank_confirm'|'reconcile'|'cron'|'manual'): Promise<PostingRunResult|null>` は例外を握って `console.error('[accounting.posting]', source, 失敗の種類)` だけを残し null を返す（個人の情報・金額を書かない）。呼び出し側の応答や知らせの処理を、計上の失敗で失敗にしない。発送票の3つの route は応答を返した後に Next の `after()` で呼ぶ（応答を遅らせない）。webhook の worker は、その起動で知らせを1件以上処理した時だけ、1回の処理の終わりに1回（`limit` 20、繰り返さない。知らせ1件ごとには呼ばない。worker の時間と G の鍵を食わないため）、再照合は最後に待って呼ぶ。取りこぼしは cron が拾う。
- Produces（cron）: `POST /api/cron/accounting-post`（10分ごとに pg_cron＋pg_net が呼ぶ。`authorizeCronRequest`、`recordHeartbeat('accounting_post')`（`ops_job_heartbeats` の job 名。S6 が CHECK に足す。route のパスは `accounting-post`）、`logAudit`。応答は `PostingRunResult` と計上待ちの未解決の数。`maxDuration=120`）。登録の手順は運用の文書（Task 15）。
- Produces（route）。順序: 認可 → CSRF（書込）→ IP の制限 → actor の制限 → zod → store → 監査 → 応答。回数の制限の窓は 600 秒。読み取りは成功・失敗とも no-store。

| route | 権限 | 中身 |
| --- | --- | --- |
| `GET pending-events?includeResolved=&limit=&afterAt=&afterId=` | `admin.finance.read` | `{events,nextAfterAt,nextAfterId,openCount,byReason}`。個人の情報を含めない |
| `POST pending-events/[id]/resolve` | `admin.accounting.entries.correct` | body `{note,requestKey}`。監査 `admin.accounting.pending.resolve`（メモの本文を入れず `event_id` と結果だけ） |
| `POST posting/run` | `admin.finance.manage` | 今すぐ計上係を流す。監査 `admin.accounting.posting.run`（件数だけ） |
| `GET/PUT dispute-settings` | GET: `admin.finance.read`、PUT: `admin.accounting.settings.manage` | 原因ごとの振り替え先の科目。監査 `admin.accounting.dispute.setting`（原因と勘定の符号だけ） |
| `GET disputes`、`POST disputes/[id]/assign` | GET: `admin.finance.read`、POST: `admin.accounting.entries.correct` | 一覧と、確定・科目の決定待ちの振り替え。監査 `admin.accounting.dispute.assign` |
| `GET/PUT stripe-invoices` | GET: `admin.finance.read`、PUT: `admin.finance.manage` | 適格請求書の合計の記録（版つき）。監査 `admin.accounting.stripe.invoice`（月と結果だけ。金額を入れない） |
| `POST balance-topups` | `admin.finance.manage` | 残高の補充の記録（1-a14）。監査 `admin.accounting.stripe.topup`（結果だけ） |
| `GET reconciliation?kind=stripe-balance&through=` / `kind=stripe-fee&month=` / `kind=intake&from=&to=` | `admin.finance.read` | 3つの照合の読み口をそのまま返す。`from`/`to` は期間の範囲 |
| `GET deferred-revenue?asOf=&limit=&afterOrder=` | `admin.finance.read` | 繰り越した前受金の一覧と異常の一覧 |
| `GET/POST/PUT year-end-shipments` | GET: `admin.finance.read`、POST（確かめた印）: `admin.finance.manage`、PUT（運送会社の受付日のオプション）: `admin.accounting.settings.manage` | 一覧（受付日とのずれを含む）・印・オプション。監査 `admin.accounting.year_end.check`・`admin.accounting.shipping.options` |
| `GET shipment-trace?slipId=` | `admin.finance.read` | 発送票の直した跡と仕訳（6-b） |

- Produces（発送票の route）: `confirm` は DB の確定の関数を呼ぶ**前に** `get_slip_dispute_holds` を読み、1件でもあれば 409 `{error:'カード会社の判断待ちの注文が含まれているため、出荷できません。', code:'DISPUTE_HOLD', orderIds:[…]}` を返して確定の関数を呼ばない（4-e3 の route と画面の止め。DB の止めは計画3）。止めが無ければ従来どおり。`cancel`・`shipment-date` は応答の形を変えず、成功後に係を流す。3つとも既存の認可・CSRF・制限・監査の順序は変えない。
- Produces（journal の route への追加。計画1の route）: 応答に `shipmentMeta:[{entryId,slipNumber,shipmentDate,confirmedAt}]`（そのページの出荷の仕訳だけ。`list_journal_shipment_meta`）を足す。既存の欄は消さない。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-562-AC-05: 計上係の呼び出しは has_more が偽になるまで繰り返し、20回で止まる`、`FREQ-562-AC-05: 呼び出しの失敗はログだけで、知らせの処理も発送票の応答も失敗にしない`、`FREQ-569-AC-01: cronは合言葉なしを断り、heartbeatと監査を残し、応答は件数だけ`、`FREQ-569-AC-01: 計上待ちの一覧の応答に名前・メールの鍵が無い`、`FREQ-569-AC-03: 確認済みのrouteはaal1・権限なし・CSRF欠落・429・不正入力でstoreを呼ばず、権限があればメモ本文を監査に入れない`、`FREQ-569-AC-03: 今すぐ計上はadmin.finance.manageの人だけ`、`FREQ-568-AC-06: 発送票の確定は判断待ちの注文を含むと409とDISPUTE_HOLDを返し確定の関数を呼ばない`、`FREQ-568-AC-06: 判断待ちが無ければ従来どおり確定し、応答の形は変わらない（既存の単体が無改造で通る）`、`FREQ-568-AC-06: 発送票の確定画面の文にDISPUTE_HOLDが出る`、`FREQ-568-AC-05: 科目の設定のPUTは権限のある人だけで、監査に金額を入れず、不正な勘定は400`、`FREQ-565-AC-06: 残高の補充のrouteは未来の日・額0・権限なしを断り、同じ要求番号の再送は前の結果`、`FREQ-566-AC-02: 請求書の記録のPUTは版違いを409で返す`、`FREQ-566-AC-03: 照合のrouteはkindごとに入力を検証しno-storeで返す`、`FREQ-574-AC-02: 確かめた印のPOSTは権限のある人だけ`、`FREQ-564-AC-03: 発送票の跡のrouteは発送票の番号・直した理由・人・前後の日と仕訳を返す`、`FREQ-564-AC-04: 仕訳のrouteは出荷の仕訳にだけ出荷した日と登録した日を付ける`、`FREQ-562-AC-05: webhookのworkerは1回の処理の終わりに1回だけ係を呼び、知らせ1件ごとには呼ばず、係が失敗しても知らせは成功として完了する`、`FREQ-569-AC-01: 見回りの対象にaccounting_postが入り、30分止まると止まったと見なされる`、`FREQ-565-AC-04: 着金の確認の後に係を呼ぶ`。非 ok の応答の本文は読み切る（画面側は Task 11）。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting tests/unit/api --runInBand --testPathPattern "accounting|stripe-reconcile|shipment-slip"`。
- [ ] **Step 3: Interfaces どおり実装する。** 書込の route は計画1の `accounting-route.ts` の共通の流れを使う。cron は `stripe-reconcile` の route の形（認可・heartbeat・監査・`maxDuration`）を写す。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 計上係の呼び出しと計上待ちと照合のAPIを追加する`

### Task 11: 画面（計上待ち・照合・設定・仕訳帳の列・前受金の確認）

controller が別セッションへ `CostProfitSection` 系・`use-cost-profit-model.ts` の対象と開始を先に知らせる。Task 10 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-564・566・568・569 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `src/components/cost-profit/pending-view.tsx`、`src/components/cost-profit/reconciliation-view.tsx`、`src/components/cost-profit/dispute-settings-panel.tsx`、`src/components/cost-profit/deferred-revenue-panel.tsx`、`src/components/cost-profit/balance-topup-form.tsx`、`src/components/cost-profit/dispute-list.tsx`、`src/components/cost-profit/year-end-shipments-panel.tsx`、`tests/unit/components/cost-profit/pending-view.test.tsx`、`reconciliation-view.test.tsx`、`dispute-settings-panel.test.tsx`、`balance-topup-form.test.tsx`、`journal-shipment-columns.test.tsx`、`year-end-shipments-panel.test.tsx`
- Modify: `src/components/CostProfitSection.tsx`（`COST_PROFIT_TABS` に `pending`「計上待ち」・`reconciliation`「照合」を設定タブの後ろに足す。他のタブの順と題は変えない）、`src/components/cost-profit/use-cost-profit-model.ts`、`journal-view.tsx`（出荷の仕訳に「出荷した日」「登録した日」の列と「出荷の跡」を開く操作）、`stripe-settlement-view.tsx`（残高の補充の入力、支払いの取り消しの一覧、請求書の記録）、`settings-view.tsx`（支払いの取り消しの科目の設定、運送会社の受付日のオプション）
- Test: 上の RTL
- Read: Task 10 の route、`src/components/cost-profit/settings-view.tsx`（計画1）、`src/components/DiscountSection.tsx`（`clientFetch`・非 ok の本文の扱い）

**Interfaces:**
- Consumes: Task 10 の route（`clientFetch`）。非 ok の応答は本文を読み切るか `response.body?.cancel()` を await する。権限は計画1と同じく、無い利用者にはボタンを出さず読み取りだけにする。
- Produces: ①「計上待ち」タブ: 未解決の件数、`posting_error` は「この出来事を帳簿に入れる処理で失敗しました。元の記録や設定を確かめ、直してから『もう一度計上する』を押してください。他の出来事の計上は続けています」と、理由の固定コード・対象の出来事の日を出す。元の記録を開く既存の画面へ案内し、処理の修正が必要な時は運用の担当へ固定コードを伝える出口も示す。生の例外の文は出さず、「確認済みにする」は出さない。そのほかの理由はやさしい文（例 `payment_journal_missing`: 「この出荷の注文の支払いが、まだ帳簿に入っていません。支払いが入ると自動で計上されます。」、`order_not_postable`: 「この注文は送料や合計が決まりの形と合わないため、自動で計上できません。内容を確かめてください。」、`before_cutover`: 「新しい帳簿を始めた日より前の出来事です。確かめて、確認済みにしてください。」ほか全理由）、「もう一度計上する」（`posting/run`）と「確認済みにする」（メモ必須・`admin.accounting.entries.correct` の人だけ。`before_cutover` と `no_revenue` の行だけに出し、お金の動く理由の行には出さない。代わりに『仕訳が入るまで閉じられません』と出す）。文に名前・メールを入れない。下に前受金の確認（Task 7 の異常の一覧と、日付を選んで出す「繰り越した前受金の一覧」。課税事業者になる期間の初めの前の日が既定）。②「照合」タブ: Stripe の残高の照合（日付を選ぶ。差が仕訳になっていない取引の種類で説明される）、手数料の月の照合（月を選び、請求書の合計を入れる。2段の差と「説明のつかない差」。0でなければ赤字）、受注高と帳簿の2段の照らし合わせ（期間を選ぶ。例外の行と「説明のつかない差」。画面に「受注高は帳簿の売上高ではありません。申告には使いません」）。③仕訳帳に「出荷した日」「登録した日」の列を並べる（出荷の仕訳だけ。ほかは空）。④出荷の跡（理由・人・前後の日・取り消しと正しい仕訳のつながり）。⑤Stripe の精算のタブに、残高の補充の入力、請求書の記録、カード会社からの支払いの取り消しの一覧（言葉は設計 4章の頭の定義のとおり: 「カード会社の判断待ち」「取り消しが確定した（お金は戻らない）」「取り消しが取り下げられた（お金が戻った）」。「チャージバック」とは書かない）。⑥設定タブに、原因ごとの振り替え先の科目と「確定・科目の決定待ち」の振り替えの操作、運送会社の受付日のオプション（既定はオフ。「追跡の登録が動いてから使えます」の注意）。⑦年末の出荷の一覧（12月25日〜1月10日、確かめた印、オンの時は受付日とのずれ）。
- Produces: 文は穏やかな日本語・絵文字なし・感嘆符なし。390/768/1280px で崩れない（確かめは Task 14）。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-569-AC-01: 計上待ちのタブは理由をやさしい文で出し、名前やメールを出さない`、`FREQ-569-AC-02: 一覧が空なら「計上待ちはありません」と出る`、`FREQ-569-AC-03: 確認済みにするボタンは権限のある人だけに出て、メモが空なら送れない`、`FREQ-569-AC-03: もう一度計上するは押すと二重に押せず、結果の件数を出す`、`FREQ-569-AC-04: 前受金の確認に繰り越した前受金の一覧と異常が出る`、`FREQ-566-AC-01: 手数料の月の照合は2段の差と説明のつかない差を出し、0でなければ赤字で出す`、`FREQ-566-AC-02: 請求書の合計を入れて保存でき、版違いは読み直しを案内する`、`FREQ-566-AC-03: Stripeの残高の照合は差を仕訳になっていない取引の種類で示す`、`FREQ-571-AC-05: 受注高と帳簿の2段の照らし合わせに「帳簿の売上高ではありません。申告には使いません」が出る`、`FREQ-564-AC-04: 仕訳帳の出荷の仕訳に出荷した日と登録した日が並び、ほかの仕訳は空`、`FREQ-564-AC-03: 出荷の跡に直した理由・人・前後の日と、取り消しと正しい仕訳が並ぶ`、`FREQ-568-AC-05: 科目の設定は勘定を選んで保存でき、権限が無ければ読み取りだけ`、`FREQ-568-AC-02: 確定・科目の決定待ちの分に振り替える操作が出て、設定が無い時は設定を促す`、`FREQ-568-AC-01: 支払いの取り消しの一覧は「カード会社からの支払いの取り消し」の言葉で出し、チャージバックと書かない`、`FREQ-565-AC-06: 残高の補充の入力は未来の日と額0を送る前に止める`、`FREQ-574-AC-01: 年末の出荷の一覧に運送会社・追跡番号・出荷した日が出て、確かめた印を付けられる`、`FREQ-574-AC-03: 運送会社の受付日のオプションは既定がオフで、オンの時だけずれの一覧が出る`、`FREQ-569-AC-03: 非okの応答の本文を読み切る`。
- [ ] **追加の試験を書く。** `FREQ-569-AC-06: posting_errorの行に理由と元の記録を直して再計上する案内が出て確認済みにはできない`、`FREQ-569-AC-06: 元の記録を直して再計上すると保留が消えほかの成功した出来事は増えない`、`FREQ-569-AC-01: やめた日より後で止まった行は、日を確かめてから法人へ切り替える順の案内が出る`（`cause` が `sole_ended_not_switched` の行）。
- [ ] **Step 2: RED を測る。** RTL 6本。
- [ ] **Step 3: 実装する。** 作る順: ①`pending-view`（計上待ち）→ ②`deferred-revenue-panel` → ③`reconciliation-view` → ④`journal-view` の列と出荷の跡 → ⑤`stripe-settlement-view` の追加 → ⑥`settings-view` の追加 → ⑦`year-end-shipments-panel`。各段で RTL が通ることを確かめる。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 計上待ちと照合と支払いの取り消しの設定の画面を足す`

### Task 12: 注文の売上と Stripe の合成を、保存した仕訳に取り替える

controller が別セッションへ `CostProfitSection` 系・`cost-profit/route.ts`・`src/lib/finance/**` の対象と開始を先に知らせる。Task 11 のコミット後に始める。計画1の Task 10 が残した合成（注文の売上の合成と `buildStripeJournal`）をここで外す。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-570 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Modify: `src/app/api/admin/kpi/cost-profit/route.ts`（`orders` の読み込み・`mapOrderIncome`・`hasStripeAccounting`・`projectedPaymentIntents` を外す。Stripe の3表の読み込みは精算のタブ用に残す。`savedJournal` を最後まで読む〔計画1への願い #3〕。`orderIncomes` は保存した出荷の仕訳から作る）、`src/components/CostProfitSection.tsx`、`src/components/cost-profit/use-cost-profit-model.ts`（`buildStripeJournal` の呼び出しを外し、保存した仕訳 ＋ 減価償却 ＋ 年末の整理を `mergeJournalEntries` で合わせる）、`src/lib/finance/stripe-journal.ts`（`buildStripeJournal`・`StripeJournalInput`・`StripeJournalOrder` を消し、`mergeJournalEntries` だけ残す。他に使い手が無いことを grep で確かめる）、`tests/unit/lib/finance/stripe-journal.test.ts`（`mergeJournalEntries` の試験だけ残す）、`tests/unit/api/admin/cost-profit-route.test.ts`、`tests/unit/components/CostProfitSection.test.tsx`、`e2e/admin-accounting-test-utils.ts`（`buildCostProfitMock` の注文・Stripe の合成用の入力を、保存した仕訳〔支払い・出荷・手数料・入金〕の組み立てに替える）、「会計の E2E 回帰の対象」のうち 1130「クレジット売掛金」を期待している `FR-ADMIN-044`・`FR-ADMIN-050-stripe-settlement`（Stripe の売上の道は 1160「Stripe未収金」と 2150「前受金」・4010 に替わる。題は変えず、期待する勘定名と額だけを直す）
- Create: `tests/unit/lib/finance/no-synthesis.test.ts`
- Test: 上の単体と RTL
- Read: 計画1の Task 10 の成果、`src/lib/finance/stripe-journal.ts`、`src/components/cost-profit/use-cost-profit-model.ts`（仕訳の合成の所）、recon-part-A（`orderIncomes` の使い手）

**Interfaces:**
- Consumes: Task 2〜4・6 の保存した仕訳、計画1の `savedEntryToJournalEntry`・`GET /api/admin/accounting/journal`・store の `listSavedJournal`。
- Produces: `cost-profit` GET の `savedJournal` は、期間の仕訳を、計画1の store `listSavedJournal` の `nextAfter:{entryDate,entryNo}` を次の `afterEntryDate`・`afterEntryNo` に渡して最後まで読んだ全部（200件ごとのページを繰り返し、最大 100 ページ）。上限を超えたら、計画1 Task 10 と同じく画面に「一部しか読めていないため、合計を表示できません。もう一度読み込んでください」と出し、合計と書き出しを止め、500 `{error:'会計データの取得に失敗しました。',code:'JOURNAL_TOO_LARGE'}` を返す（途中の取得失敗も一部の配列を成功として返さず、前の合計を残さない）。応答から `orders`（収入への変換前の注文）の欄は無くなる。`orderIncomes` は、取り消されていない出荷の仕訳（`shipment_confirmed`/`shipment_redated`）1本につき1行 `{source:'order', sourceId:<仕訳の id>, date:<仕訳の日>, grossAmount:<その仕訳の4010のcredit−debitの合計>, refundedAmount:0, netAmount:<同じ4010のcredit−debitの合計>, currency:'jpy', readOnly:true}`（取引管理の画面の動きを変えないため。列は今と同じ）。`grossAmount` と `netAmount` はどちらもその出荷の保存した4010の行の合計で、元の注文の `total_amount`・支払いの `amount` や `abs` から作らない。
- Produces: 画面の仕訳 ＝ 保存した仕訳（`savedEntryToJournalEntry`）＋ 減価償却 ＋ 年末の整理。注文の売上の合成・Stripe の合成は無くなる。Stripe の精算のタブ（原始記録の一覧・入金の確認）は今のまま動く。
- Produces（確かめる試験）: `no-synthesis.test.ts` が `src/` の中に `buildStripeJournal`・`mapOrderIncome`・`stripe:sale:` が残っていないことを `fs` で数える（`mergeJournalEntries` と過去の履歴の文書は除く）。`src/components/CostProfitSection.tsx:565` のコメントにある `buildStripeJournal` の名前も消す。`order:` の文字列は数えない（`entry-review.ts` の `order:${…}` は合成でない）。`toOrderSalesTransaction` と `order-sales.ts` を数える部分は、KPI の route がまだ使っているため Task 13 が足す。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-570-AC-01: 画面の仕訳は保存した仕訳だけから注文と Stripe の売上を数え、合成の仕訳が重ならない`、`FREQ-570-AC-01: 支払い・出荷・手数料・入金の保存した仕訳が、仕訳帳と元帳と試算表に1度ずつ出る`、`FREQ-570-AC-01: 保存した仕訳が1000件を超えてもページを最後まで読み、数字が合う`、`FREQ-570-AC-01: 日付の古い取り消しの仕訳（通し番号は大きい）がページの境目にあっても、抜けも重なりも無く数字が合う`、`FREQ-570-AC-01: ページの上限を超えた時は数字を出さずに止まり、JOURNAL_TOO_LARGEを返す`、`FREQ-570-AC-02: 取引管理の注文の収入の行は出荷の仕訳と一致し、取り消された出荷は出ない`、`FREQ-570-AC-02: 日の直しがあれば直した日の行だけが出る`、`FREQ-570-AC-02: 一部出荷のgrossAmountとnetAmountは保存した4010のcredit−debitの合計で元の注文の総額を使わない`、`FREQ-570-AC-03: Stripeの精算のタブは原始記録の一覧と入金の確認を今のまま出す`、`FREQ-570-AC-04: srcに buildStripeJournal・mapOrderIncome・stripe:sale: が残っていない`、`FREQ-570-AC-01: 個人の暦年の期間では、手入力と保存した仕訳だけの従来の画面の数字が同じ`（既存の `CostProfitSection.test.tsx` が題を変えず通る）。
- [ ] **Step 2: RED を測る。** 上の単体。
- [ ] **Step 3: 実装する。** 外す順: ①route の注文の読み込みと変換 → ②画面の合成 → ③`stripe-journal.ts` の削除（使い手ゼロを確かめてから）。1130 の名前を探す所（入出金方法「Stripe」。7-h）は変えない。
- [ ] **Step 4（controller）: GREEN を測る。** 単体、型、lint、「会計の E2E 回帰の対象」の全部を production build で流す。直した E2E（044・050）以外は題も期待も同じで通ること。直した E2E は期待の変更点を表で報告する。
- [ ] **Step 5（controller）: Files だけコミットする。** `refactor(accounting): 注文とStripeの売上の合成をやめ保存した仕訳で数える`

### Task 13: KPI の route と画面（受注高の名前と数え方）

controller が別セッションへ `KpiSection.tsx`・`kpi/route.ts`・`src/lib/sales/**` の対象を先に知らせる。Task 12 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-572・573 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Modify: `src/app/api/admin/kpi/route.ts`（`applyOrderToAccumulator` の入力を、Task 7 の `list_order_intake_events` の行に替える。応答に `backlog`・`intakeBreakdown`・`returnsThisMonth` を足す）、`src/components/KpiSection.tsx`（「売上」を「受注高」に改め、受注残・返品・内訳のカードと注意書きを足す）、`src/lib/kpi/monthly-metrics.ts`（月の記録の「売上額」を「受注高」に改める。保存の鍵 `kpi:sales` は変えない）、`tests/unit/api/admin/kpi-hidden-statuses.test.ts`、`tests/unit/api/admin/kpi-exchange-lines.test.ts`、`tests/unit/lib/kpi/monthly-metrics.test.ts`、`tests/unit/components/KpiSection*.test.tsx`、KPI の E2E（`grep -l "kpi" e2e` で数える。`FR-ADMIN-006`・`017`・`018`・`021` ほか。題は変えず、期待する文字だけ「売上」→「受注高」に）
- Delete: `src/lib/sales/order-sales.ts`、`tests/unit/lib/sales/order-sales.test.ts`（Task 12 でも KPI でも使い手が無くなったことを `grep` で確かめてから）
- Create: `tests/unit/api/admin/kpi-order-intake.test.ts`、`tests/unit/components/KpiSection.intake.test.tsx`
- Test: 上の単体と RTL
- Read: `src/app/api/admin/kpi/route.ts`（`applyOrderToAccumulator :179`・`toKpiMetricsResponse :214`・GET `:292`）、`src/components/KpiSection.tsx:37,137-199,459,487-640,901`、`src/lib/kpi/monthly-metrics.ts`

**Interfaces:**
- Consumes: Task 7 の `list_order_intake_events`（続きの目印で `FIRST_FISCAL_YEAR` の1月1日から今日まで全部読む）・`get_order_backlog`・`get_intake_breakdown`・`get_intake_reconciliation`、`orders`（`user_id`・`session_id` のみ）、`order_items`。
- Produces（数え方）: 月の足し込みは**支払いを受けた日（`payment` の `event_date`）の日本時間の月**。受注高 ＝ 月ごとの `payment` ＋ `pre_shipment_cancel` ＋ `dispute_unshipped` ＋ `dispute_unshipped_restored` の合計。出荷して発送済みになった注文も外れない。客単価 ＝ 受注高 ÷ 支払いを受けた注文の数、LTV ＝ 受注高 ÷ 顧客の数、リピート率・セット購入率も同じ注文（8-f）。CVR だけは注文を作った日の月で数える（決めたこと。`allOrders` は今のまま作成月、分子は支払いを受けた注文のうちその月に作ったもの）。返品率は今の「取り消した率」のまま（`returnRateNote` を変えない）。交換の品の行はセット購入率から除く（今のまま）。応答の JSON の鍵 `salesAmount`・`formattedSales` は互換のため据え置き、コードのコメントに「受注高。鍵は目標の鍵 `sales` と同じ理由で据え置き」と書く。権限は今のまま（`admin.orders.read` ＋ 店長だけ）。
- Produces（画面）: 「売上」の見出し・目標のラベル・説明（`sales: "期間内に売れた総額"`）を「受注高」「期間内に支払いを受けた注文の額（出荷前の取り消しを引く）」に。月の記録の指標の名前も「受注高」。受注残のカード（`backlog.total`・件数）、返品の行（今の月の `returns`。出荷後の返品は受注高から引かない旨）、内訳（割引の前の商品の額・割引・出荷前の取り消し・受注高）を足す。注意書き「受注高は帳簿の売上高ではありません。申告には使いません。」（8-i）と、「帳簿との照らし合わせは会計の『照合』で見られます」のリンク。目標の鍵 `sales` はそのまま（8-a）。
- Produces: 計上待ちの注文（支払いの仕訳がまだ無い）は受注高に入らない。画面の注に「支払いの確認が帳簿に入るまで数えません」と出す。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-572-AC-01: 見出しと説明と月の記録の名前が「受注高」になり、目標の鍵 sales は変わらない`、`FREQ-572-AC-02: 発送済みの注文も受注高に入り、出荷しても数字が小さくならない`、`FREQ-572-AC-02: 出荷後の返品が届いても受注高は変わらず、返品の行に別に出る`、`FREQ-572-AC-03: 受注高と客単価とLTVとリピート率とセット購入率は支払いを受けた日の月で数える`、`FREQ-572-AC-03: 日をまたいで支払いが記録された注文は、支払いの仕訳の日の月に入る（created_atやpaid_atの月ではない）`、`FREQ-572-AC-03: CVRは注文を作った月で数え、支払いの途中・失敗・放棄の注文を入れない`、`FREQ-572-AC-03: 交換の品はセット購入率に入らない`、`FREQ-572-AC-02: 出荷前の取り消しは取り消しの日の月の受注高から引き、前の月の数字を後から変えない`、`FREQ-572-AC-04: KPIのrouteはサポーターを403で断り、店長だけが読める`、`FREQ-572-AC-05: 画面に「帳簿の売上高ではありません。申告には使いません」と受注残のカードと内訳が出る`、`FREQ-572-AC-02: 内訳の合計が受注高に合わない時は画面が注意を出す`、`FREQ-573-AC-04: 月の記録の指標名が「受注高」になる`（Task 8 の表を使う route と合わせる）、`FREQ-570-AC-04: srcに toOrderSalesTransaction と order-sales.ts への参照が残らない`（`no-synthesis.test.ts` に数える対象を足す）。
- [ ] **Step 2: RED を測る。** 上の単体と RTL。
- [ ] **Step 3: 実装する。** `applyOrderToAccumulator` の入力を変えるので、顧客の鍵（`user_id`・`session_id`）は `orders` を注文の番号で引いて足す（1回200件ずつ）。KPI の対象の期間が広いので、読み込みは続きの目印で区切る。
- [ ] **Step 4（controller）: GREEN を測る。** 単体、型、lint、KPI の E2E の回帰を production build で流す（`FR-ADMIN-006`・`017`・`018`・`021` ほか。期待の文字だけ変えたものを表で報告する）。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(kpi): 売上を受注高に改め支払いを受けた日と受注残で数える`

### Task 14: 新しい E2E

controller が別セッションへ `docs/05_Quality/tests/test-spec.md` の更新を先に知らせる。

**Files:**
- Create: `e2e/FR-ADMIN-132-accounting-order-journals.spec.ts`、`e2e/FR-ADMIN-133-accounting-stripe-disputes.spec.ts`、`e2e/FR-ADMIN-134-kpi-order-intake.spec.ts`、`e2e/FR-ADMIN-135-kpi-monthly-records.spec.ts`、`e2e/FR-ADMIN-136-accounting-year-end-shipments.spec.ts`
- Modify: `e2e/accounting-test-utils.ts`（計画1。`withAccountingScenario` に `seedPaidOrder`・`seedStripeCharge`・`seedConfirmedSlip`・`seedDispute`・`runPosting` を足す）、`e2e/admin-accounting-test-utils.ts`（Task 12 で済む分を確かめる）。`requirements.md` の自分の AC の行は各 Task が足し、`test-spec.md` は Task 15 が直す
- Test: 新規5本＋既存の会計・KPI の E2E（「会計の E2E 回帰の対象」と KPI の E2E）の回帰
- Read: `e2e/admin-session-test-utils.ts`、`e2e/order-admin-test-utils.ts`、`e2e/accounting-test-utils.ts`（計画1）、`e2e/FR-ADMIN-127-discount-refund-amounts.spec.ts`（注文・返金の fixture の手本）

**Interfaces:**
- Consumes: S6〜S14・route・画面。実 route の aal2/live-session は `createAdminSessionActor(db,role,aal)`。Stripe は呼ばず、`stripe_*` の行を DB に直接入れる（表示の証拠であり、実 Stripe の証拠ではない）。
- Produces: E2E は今日の日付だけを使う（切り替えの日を動かせず、G の確定は今日より後の出荷日を断るため）。ADMIN-136 の年末の一覧は範囲を今日を含む日に変えて確かめ、年をまたぐ例は DB の試験で確かめる。試験ごとに固有の IP。仕訳・期間・Stripe の行は消せないので、計画1と同じく `db reset` を前に流し、期間は `seedAccountingPeriod` が作る。

| spec | 新規テストの正確な題と assert（各 390/768/1280px） |
| --- | --- |
| ADMIN-132 | `FREQ-569-AC-06: 1件の失敗の理由と直して再計上する案内が計上待ちに出てほかの出来事の仕訳は見える`（処理の失敗は手元 DB の試験用の例で作り本番には作らない）、`FREQ-562-AC-01: 支払いを計上すると仕訳帳に前受金の仕訳が出る`、`FREQ-563-AC-01: 発送票を確定して計上すると売上の仕訳が出て前受金が減る`、`FREQ-564-AC-02: 出荷日を直すと取り消しと正しい仕訳が並び、出荷した日と登録した日の列が出る`、`FREQ-569-AC-01: 支払いより先に出荷した注文は計上待ちに理由が出て、支払いを入れて「もう一度計上する」で消える`、`FREQ-570-AC-02: 取引管理の注文の収入の行が出荷の仕訳と同じ額で出る`。横幅内・ボタンの無効化・非 ok の本文の読み切り |
| ADMIN-133 | `FREQ-565-AC-01: 手数料が1件ずつ仕訳に出る`、`FREQ-566-AC-02: 手数料の月の照合で請求書の合計を入れると説明のつかない差が出る`、`FREQ-566-AC-03: Stripeの残高の照合で仕訳になっていない取引の種類が出る`、`FREQ-568-AC-02: 出荷済みの注文の支払いの取り消しが判断待ちの仮払金に出て、科目を設定して確定すると振り替わる`、`FREQ-568-AC-06: 判断待ちの注文を含む発送票は確定が止まり理由が出る（本物のroute）`、`FREQ-565-AC-06: 残高の補充を入れると仕訳が1本出て、2回目は増えない` |
| ADMIN-134 | `FREQ-572-AC-02: 発送済みの注文も受注高に入り、受注残が前受金の残りと合う`、`FREQ-572-AC-05: 画面に帳簿の売上高ではないと書いてある`、`FREQ-571-AC-05: 照合の画面で期首の受注残＋受注高−売上高＝期末の受注残の差が0`、`FREQ-572-AC-04: サポーターはKPIを読めない` |
| ADMIN-135 | `FREQ-573-AC-02: 月の記録を保存して読み直すと値が残り、空にすると消える（本物のroute）`、`FREQ-573-AC-03: サポーターは保存できない` |
| ADMIN-136 | `FREQ-574-AC-01: 年末の出荷の一覧が出て確かめた印を付けると残る`、`FREQ-574-AC-03: 運送会社の受付日のオプションは既定がオフで、切り替えられる` |

- [ ] **Step 1: 上表の失敗する試験を書く。** helper をまだ実装しない。表示差し替えと DB 経由の別を test-spec に明記し、実 Stripe の証拠と誤記しない。
- [ ] **Step 2（controller）: RED を測る。** production build/手元 DB を用意し `npx.cmd playwright test e2e/FR-ADMIN-132-accounting-order-journals.spec.ts e2e/FR-ADMIN-135-kpi-monthly-records.spec.ts --workers=1 --retries=0`。helper 未定義の失敗は道具の RED であり画面の回帰の RED とは言わない。
- [ ] **Step 3: helper と5本を接続する。** exact な role/name を使い、応答の本文を読み切る。rate-limit を全体で無効にせず IP を分ける。計上は画面の「今すぐ計上」または `runPosting`（DB の入口）で流す。
- [ ] **Step 4（controller）: GREEN を測る。** `npm.cmd run build` 後、port3000 の production server で新5本と「会計の E2E 回帰の対象」と KPI の E2E の全部、390/768/1280 を `--retries=0` で流し、件数・pass/fail/skip を実測で記録する。3000番に残った E2E 用でないアプリを先に止める。
- [ ] **Step 5（controller）: Files だけコミットする。** `test(accounting): 計上と照合とKPIと年末の出荷のE2Eを追加する`

### Task 15: 文書の正本の更新（Stripe の購読の運用を含む）

controller が別セッションへ先に知らせる（`db-migrations.md`・`test-spec.md`・台帳・`webhook-queue-operations.md`・`docs/06_Operations/README.md` は共有の文書）。会計・KPI は `scripts/trace/scope.json` の範囲の外なので、CLAUDE.md の「範囲に入っていない領域」の表に従い、同じコミットで直す。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-562〜574 の6列の行。各 Task が足した物を確かめ、足りない行を足す）、`docs/03_BasicDesign/api/api-spec.md`・`route-inventory.md`（Task 10 の新 route と cron 1本、Task 8 の月の記録の route の変更、`kpi` の応答の追加、`journal` の `shipmentMeta`）、`docs/03_BasicDesign/data/er.md`（S6〜S14 の表、`stripe_disputes` ほか、旧 `admin_kpi_monthly_records` の食い違いの解消）、`docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md`（計上待ち・照合）、`docs/03_BasicDesign/architecture/`（計上係の流れ・呼び出しの4か所・鍵の順）、`docs/04_DetailDesign/pages/` の会計・KPI のページ・`sequence/`（支払い→出荷→取り消し→日の直し、dispute）・`states/`（計上待ちの状態、dispute の状態）・`docs/04_DetailDesign/shared/finance.md`（1160 の使い方、補助の符号 `dispute_confirmed_unassigned`）、`docs/05_Quality/tests/test-spec.md`（手で書く）、`docs/06_Operations/db-migrations.md`（S6〜S14 の目的・適用順・assert・戻し方）、`docs/06_Operations/webhook-queue-operations.md`（§4 の13種→18種、手順 5 の文、定期処理の表に `accounting-post` を10分ごとで足す。手順 3・4 の登録する数の確かめの行を1つ増やす。登録の SQL は `supabase/pending/schedule_accounting_post.sql`）、`docs/06_Operations/README.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（台帳の S-2・KPI の表・dispute の状態欄）、`src/lib/stripe/handled-webhook-events.ts` の冒頭のコメントの数（Task 5 で済む分を確かめる）
- Create: `docs/06_Operations/accounting-p2-posting-stripe.md`
- Test: `npm.cmd run validate-docs`、`npx.cmd jest tests/unit/docs --runInBand`

**Interfaces:**
- Consumes: Task 1〜14 の確定した名前と route。
- Produces: `accounting-p2-posting-stripe.md`: ①計上係の仕組み（入口・呼ぶ4か所・何回流しても同じ・出来事1件の失敗は保留して続けること・失敗した時の見方〔heartbeat・計上待ちの件数〕）、②計上待ちの理由ごとの意味と対処、③cron の登録（10分ごと。pg_cron＋pg_net の設定と合言葉の扱い。値は文書に書かない）、④**Stripe の受け取りの種類を変える手順**: 受け取りの種類は18種（既存の13種＋`charge.dispute.created`・`charge.dispute.updated`・`charge.dispute.closed`・`charge.dispute.funds_withdrawn`・`charge.dispute.funds_reinstated`）。順番は ア）コードを先に出す（5種を処理する版を出すまでは、Stripe から届いても保存せず200を返すだけで害はない）→ イ）Stripe の管理画面で宛先（`<公開した URL>/api/webhook/stripe`）を開き、イベントの追加で5種を足す（**コードだけ変えても知らせは届かない**）→ ウ）テストモードの宛先で `stripe trigger charge.dispute.created` などを流し、dispute の表に1行入ることを管理画面の「カード会社からの支払いの取り消し」の一覧で確かめる → エ）本番の宛先は開店の準備の「Stripe の知らせの宛先を登録する」（手順 5）で作る時に18種を購読する（今の本番には宛先が無い）。購読の種類を戻す・減らす時は、先に処理する版を戻さず、宛先から外すだけにする、⑤照合の見方（手数料の月の2段の差、Stripe の残高の差の読み方）、⑥月の記録の表と、Meta 連携の表が移行に無い疑い（未確認 #6）、⑦本番で `stripe-backfill` を流さない決まり、⑧計画1 Task 16 Step 0 の普段の開発の接続先のオーナー確認、⑨S6 適用前の発送票の状態別の件数の読み取りと、0でない時・assert で止まった時は当てずに報告してオーナーと対応を決める手順（Task 16 Step 6）。
- Produces: 各文書の冒頭の確認日の更新。`docs/05_Quality/reports/traceability-report.md` は自動生成なので手で直さず `npm run report:traceability` で作り直す。更新不要と判断した文書は理由を完了報告に1行書く。

- [ ] **Step 1: 文書を直す。** 上の Files の順に、Task 1〜14 の実装の確定後の名前で書く。`docs/06_Operations/accounting-p2-posting-stripe.md` と `db-migrations.md` に、計画1の接続先のオーナー確認の参照、S6 前の件数の SQL、停止時に適用せず報告してオーナーと決める手順を追加する（今のレビュー作業では運用の文書は直さない）。
- [ ] **Step 2: 検証する。** `npm.cmd run validate-docs` と `npx.cmd jest tests/unit/docs --runInBand` が通る。`npm.cmd run report:traceability` の生成差分を確認し、要求表から全新 AC の試験まで辿れる。
- [ ] **Step 3（controller）: Files だけコミットする。** `docs(accounting): 計画2の前受金とStripeと受注高の正本を更新する`

### Task 16（controller）: 全体検証・最終レビュー・本番を読む・適用・記録

controller が別セッションへ `docs/06_Operations/db-migrations.md`・`test-spec.md`・台帳の更新を先に知らせる。**前提: 計画1の S0〜S5 が本番に当たっていること**。計画1 Task 16 Step 0 の普段の開発の接続先のオーナー確認も済んでいること（未確認なら適用しない。環境変数の値は Claude・書き手が読まない）（当たっていなければここで止め、計画1の Task 16 を先に終える）。

**Files:**
- Create: `.superpowers/sdd/2026-11-04-accounting-p2/progress.md`、`final-review.md`、`production-pre-read.md`、`verification-report.md`、`report-to-owner.md`、`stripe-categories-check.md`（Task 4 Step 4 の記録）
- Modify: `docs/06_Operations/db-migrations.md`、`docs/05_Quality/tests/test-spec.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`、この計画のチェックボックスと未確認事項。生成レポート/graph は生成手順の出力として確認する
- Test: 計画2の全単体/DB/並行/PostgREST、計画1・G・H・checkout・refund・return・status・email の回帰、E2E 全件

**Interfaces:**
- Consumes: Task 1〜15 のコミット一覧、計画1の Task 16 の記録、最新 E2E baseline（`.superpowers/sdd/2026-10-26-group-g4-orders/e2e-results-g4-full.json` を `flattenPlaywrightJson` で直して渡す）。
- Produces: `verification-report.md` はコミット/差分範囲/コマンド/RED・GREEN の実測件数/未実行境界/3連続の並行の結果/最新 baseline との差分を残す。`final-review.md` は最終 Opus レビュー（実作業は Codex または Sonnet、レビューは Opus）の対象コミット・指摘・修正コミット・再検証を残す。
- Produces: 計画1 Task 16 Step 0 の接続先のオーナー確認と、下の Step 6 の発送票の件数の前提がそろってから、**適用の順は S6→S7→…→S14。** push はしない。本番の Stripe の宛先は無いので、5種の購読は開店の準備の手順 5 で行う（Task 15 の文書）。

- [ ] **Step 1: 検証の判定を先に固定する。** 必須 assert: `FREQ-562-AC-05: 同じ支払いは何度・同時に流しても1本`、`FREQ-563-AC-04: 支払いの仕訳が無い出荷は計上待ちに止まり、支払いが入ると入る`、`FREQ-563-AC-01: 一部の出荷は送った着の額だけ`、`FREQ-564-AC-02: 出荷日の直しは取り消しと正しい仕訳`、`FREQ-565-AC-01: 手数料は1件1本`、`FREQ-568-AC-02: 出荷済みの支払いの取り消しは判断待ちの仮払金から原因の科目へ`、`FREQ-571-AC-05: 2段の照らし合わせの説明のつかない差が0`、`FREQ-570-AC-04: 合成が残らない`、`FREQ-573-AC-02: 月の記録が保存できる`、`FREQ-567-AC-01: 受け取りの種類と処理する側が一致`、`FREQ-569-AC-06: 1件の失敗は保留に残りほかは計上され直して再計上できる`、`FREQ-565-AC-01: fee=0の単独の手数料も-netで計上する`。最新 baseline の commit/build/DB 前提から比較し、古い件数を転記しない。
- [ ] **Step 2: 追加試験の RED と各 Task の GREEN の証拠を照合する。** 欠けた RED/DB/provider の境界は未実施と書き、必要な再現を手元で実行する。全 SQL を reset して S0〜S14 と G・H の回帰、PostgREST、並行3連続を通す。過去の本文の DB 成功で最終 SQL を検証済みとしない。G-3 の試験（`group_g3_reads` ほか）が無改造で通ることを明記する。
- [ ] **Step 3: 単体・型・lint・docs・security を最終本文で実行する。** `npx.cmd jest tests/unit --runInBand`、`npx.cmd tsc --noEmit --incremental false`、`npm.cmd run lint`、`npm.cmd run validate-docs`、`npx.cmd jest tests/unit/docs --runInBand`。implement-component/security-check の現行 skill を読んで指定の機械検証を行う。
- [ ] **Step 4: production build で E2E 全件を実行し baseline と比べる。** `npm.cmd run build` → 既存の E2E 起動手順 → `npx.cmd playwright test --retries=0` → `npm.cmd run e2e:compare`。新規/置換/失敗/skip をファイルと題で説明する。計画2以外の既存の赤は勝手に直さず、前に通って後で落ちたものは単独で再実行して揺れか実装かを切り分ける。3000番に残るアプリは先に止める。
- [ ] **Step 5: 最終 Opus レビューを受ける。** Review Focus の5行・設計の行の対応表・未確認事項を渡す。重大/中を直したら影響する DB reset/build/E2E を再実行する。
- [ ] **Step 6: 本番と Stripe を先に読む（数だけ。書かない）。** 最初に計画1 Task 16 Step 0 のオーナー確認済みの記録を参照し、済んでいなければ当てずに報告する。S6 を当てる前に本番で `SELECT count(*) FILTER (WHERE stage = 'confirmed') AS confirmed_count, count(*) FILTER (WHERE stage = 'cancelled') AS cancelled_count FROM public.shipment_slips;` を読む（件数だけ。発送票の明細や相手は読まない）。どちらも0であることを確かめる。1件でもあれば S6〜S14 を当てず、状態別の件数と止めた理由を `production-pre-read.md`・`report-to-owner.md` に残し、オーナーと既存の事実の移しかえを別に設計するか等の対応を決める。承認された直しと手元の検証が終わるまで再開しない。S6 の `acc_s6_slip_fact_backfill` は外さず、件数を読んだ後に増えて assert で止まった時も S6 のトランザクションを巻き戻したまま止めて報告する。発送票の清掃・assert の無効化・番号の推測による補完をその場で行わない。Supabase MCP の `execute_sql` で次を数える: 計画1の S0〜S5 が当たっていること（`accounting_journal_entries` の件数と、`permissions` の `admin.accounting.%` が6件）、`orders` の払い済みの件数（0のはず。試しだけ）、`stripe_balance_transactions`・`stripe_refunds`・`stripe_payouts`・`order_fulfillments` の件数（想定は G-1 の清掃のとおり0に近い）、`admin_kpi_monthly_records` と `admin_meta_kpi_connections` が**まだ無い**こと、`accounting_settings.cutover_on`、S6〜S14 のバイト数/MD5/ASCII/1組の取引/末尾 assert。Stripe は**テストモードだけ**で、`type` と `reporting_category` の組の一覧と `fee_details` の形、dispute の知らせの名前を読んで確かめる（本番の Stripe には触らない。本番の `stripe-backfill`・`stripe-reconcile` は流さない）。結果は `production-pre-read.md` へ数だけ書く（取引の中身・金額・相手を書かない）。想定と違えば適用せず理由とともにオーナーへ示す。
- [ ] **Step 7: オーナーへ適用の判断を求める。** `report-to-owner.md` に、使える物、設計の行の対応、実測/未実測、本番を読んだ数、未確認事項、次を載せる: 計画1の接続先のオーナー確認日と確認済みか、S6 前の確定・取り消し済みの発送票の件数と停止の有無、S6〜S14 を適用してよいか。前提が満たせなければ適用を求めず止めた理由と次の対応を相談する。あわせて「計画3が入るまで、出荷前に返金した注文の売上と前受金も正しくない。実際の注文を受ける開店は計画3の後」を伝える（適用の条件）。適用で本番の DB に入るのは表・関数・月の KPI の空の表だけで、仕訳・Stripe の行は増えない（本番の注文は0件）。無回答を承認としない。
- [ ] **Step 8: 承認された範囲だけ適用し、読むだけで確かめる。** Step 6 の両方0件と接続先の確認済みの記録を確かめてから、既存の controller 手順で適用する（`supabase/migrations` との名前の一致を `list_migrations` で確かめ、適用した文は `schema_migrations` の `md5(statements[1])` とファイルを突き合わせる。大きい移行は MCP でなく CLI の `db push --linked`）。適用後の確かめは**読むだけ**: S6〜S14 の assert の結果、`admin_kpi_monthly_records` が空で存在すること、`accounting_pending_events` が0件であること、`accounting_settings` の設定が変わっていないこと、権限が38件のままであること。**本番に書いて確かめることはしない**（仕訳は消せないため）。計上係・照合・月の記録の保存は手元の DB だけで確かめる。失敗は固定 SQLSTATE/DETAIL/適用済みの位置を残して止め、データの戻しを即興で実行しない。特に S6 の `acc_s6_slip_fact_backfill` で止まった時は S7 以後へ進まず、Step 6 の停止時の手順へ戻ってオーナーと対応を決める。
- [ ] **Step 9: 記録を更新して Files だけコミットし、graph フックの結果を確認する。** 実装コードの最終変更後・commit 前に `graphify update .` を1回だけ完了し、進捗/レビュー/検証/適用の記録を更新して `docs(accounting): 計画2の検証と本番適用結果を記録する` でコミット。commit 後は `graphify hook status` を確認するだけで手動 update を重ねない。未適用なら明記し、push しない。

## 未確認事項

設計として決められなかった所と、実装・本番・外部サービスの読み取りで確かめる所。推測で埋めていない。

| # | 内容 | 確かめる Task / 決め方 |
| --- | --- | --- |
| 1 | **Stripe の取引の種類のうち未定の名前。** dispute は `type='adjustment'`・`reporting_category='dispute'`／`dispute_reversal` で決まり（Task 4 の表）。未定は、JCT tax adjustment が `tax_fee` か別の取引か、残高の補充（`topup`）の取引の実際の名前。仮の対応で動かし、知らない名前は `unknown_category` で計上待ちに止まる（黙って捨てない） | Task 4 Step 4（Stripe のテストモードを読むだけ）。結果は `stripe-categories-check.md` |
| 2 | **`fee_details` の分け方（16-sr3）。** 日本の手数料の消費税が取引ごとに `type='tax'` で入るか、請求書の月の調整だけか。分けられない時の既定は課税10%、免税の間は税込み1本（設計 4-c で決まり）。手数料の契約の形は税理士に確かめる（4-c3） | Task 4 Step 3・4。税理士は開店前 |
| 3 | **運送会社の受付の日。** 追跡の状態には `in_transit` の前に `confirmed` もあり、どちらが「受付」かは追跡が動いてから決める。仮に `in_transit` の最初の日 | 追跡をオンにした後（controller） |
| 5 | **遅れて取り下げられた額の、年をまたぐ時の科目（16-sr6）。** 相殺の仕訳そのものは設計 4-e2 で決まっていて計画3の担当（願い #4）。科目だけが税理士待ち | 税理士 |
| 6 | **Meta 連携の表（`admin_meta_kpi_connections`・`admin_meta_kpi_sync_runs`）が移行に無い。** `supabase/migrations` に無く、旧 `migrations/079` だけにあるのは確かめた。本番に在るかは Task 16 Step 6 で読む。作るかどうかは8章の外なのでオーナーが決める | オーナーに報告 |
| 7 | **出荷済みの品の支払いの取り消しの消費税の区分と、原因ごとの振り替え先の科目（16章の最初の行）。** 設定に持ち、決まるまで「確定・科目の決定待ち」に置く。締めの前に設定が無ければ止める仕組みは計画6 | 課税事業者になる前に税理士と決める |
| 8 | **送料を取る時の売上の日（2-c）と、税抜きの帳簿にする時の消費税の行（8-j）。** 送料は0固定で、そうでない注文は `order_not_postable` で止める（`orders` に税の別欄は無いことは確かめ済みで、決めたこと） | 送料・税抜きを使うと決めた時に設計 |
| 9 | **1-a14 の銀行の取引の番号の取り方と、1-a12 の着金の印。** 銀行の取引の取り込みができるまで、手入力の自由な文字列と入金の番号を使う（dispute の知らせの名前5種は決まり。Task 5 Step 4 は実機の確認）。あわせて、dispute の終わりの状態の集まり（今は `won`・`lost`・`warning_closed`）を、Task 5 Step 4 で使う API の版の Stripe の状態の一覧（`prevented`、古い版の `charge_refunded` など）と突き合わせ、足りなければ Task 5 と Task 6 の「決着」に足す | 銀行の取引の取り込みができた時。終わりの状態は Task 5 Step 4 |
| 10 | **CVR は注文を作った月で数える**（8-f の範囲外の私の判断）。取引管理の注文の収入の行を出荷の仕訳から作る形（決めたこと）も私の判断。オーナーが覆せる | オーナーの確認 |
| 12 | **設計 1-a16 の印の形。** 設計は遅れた取り下げの印を「dispute の番号＋遅れての取り下げ＋戻りの取引の番号」としている。計画は `dispute_event` の `[dispute,'reversal',戻りの取引の番号]` の1つにした（決めたこと。理由は、R と L を同じ戻りの取引に2本入れないため）。設計の 1-a16 の行に今回の決定を書き足すのは controller の作業（この計画を直す作業では設計を変えない） | 済み。controller が設計の 1-a15・1-a16 の行と18章に書き足した（2026-11-04） |
| 13 | **W の番号 N の、時計の差の隙（計画3の確かめ直し4回目の新-小S）。** 起きる条件: DB の時計（`locked_at` の `clock_timestamp()`）が Stripe の時計（`stripe_created_at`）より遅れていて、dispute の係が、引かれた時刻からその遅れより短い間に W を数えた時。その後に G の鍵を取った発送票の確定・取り消しや割り当ての行の `locked_at` が引かれた時刻以下になり、後で数えると N が大きくなる。起きた時に出る物: 計上待ちも拒否も出ない。W の仕訳はその時の N で1回だけ入り、出荷済みの額 S と未出荷の額 U の分け方が、その隙に番号を取った1件の分だけ変わる（A の合計は同じ）。知らせは引かれた後に届き、係はその後に流れるので、ほぼ起きない | Task 16 Step 6 で、本番の DB の時刻と Stripe の取引の時刻の差を読む（読むだけ）。差が大きければ、W を引かれた時刻から一定の間おいて入れる形を controller が決める |
| 14 | **本番適用の前提の実測。** 計画1 Task 16 Step 0 の普段の開発の接続先のオーナー確認と、S6 前の確定・取り消し済みの発送票がともに0件か。確認が済まない・1件でもある・assert で止まる時は当てずに報告し、オーナーと対応を決める | Task 16 Step 6。運用の文書への記載は Task 15 |

## オーナーへの報告（Task 16 の `report-to-owner.md` に載せる）

- 本番適用は計画1の普段の開発の接続先のオーナー確認が前提。S6 前に確定・取り消し済みの発送票の数を読み、0でない時や assert の停止時は当てずに報告して対応を決める。値は Claude・書き手が読まず、確認済みか・確認日・状態別の件数と停止の理由だけを載せる。
- 1件の処理が失敗してもほかの出来事は計上し、失敗した物は理由つきの保留に残す。元の記録や設定・処理を直して再計上する出口を出す。生の例外の文は残さない。
- 売上が「支払いの日」から「出荷した日」に移る。未出荷の分は前受金として残り、年をまたいでも前受金のまま。計上は自動で、仕訳にできない出来事（支払いの記録が先に無い出荷、送料や合計が合わない注文など）は「計上待ち」の一覧に理由つきで出る。
- KPI の「売上」は「受注高」の名前になり、出荷しても小さくならない。帳簿の売上高ではなく、申告には使わない。受注残も出る。
- カード会社からの支払いの取り消しを受け取る形を足した。コードを出しても、Stripe の宛先に5種を足すまで知らせは届かない（今の本番には宛先が無い。開店の準備の手順 5 で18種を購読する）。出荷済みの品の取り消しの科目と消費税の区分は、課税事業者になる前に税理士と決める。
- 月の KPI の表は本番に無く、月の記録の保存が今も失敗している。計画2で表を作る。Meta 連携の表も同じ事情の疑いがあり、別の作業にするかを決めてほしい（未確認事項 #6）。
- 科目の設定が無いと、カード会社からの支払いの取り消しで遅れて戻ったお金も計上待ちに残る（確定の年の費用を正しくするため、振り替えの後に入る）。開店前に、原因ごとの振り替え先の科目の設定を入れる。
- 判断待ちの注文の出荷は画面と route で止めるが、DB の中の止めは計画3が入れる（2026-11-04 controller の決定）。
- 計上待ちの「確認済み」にできるのは、新しい帳簿の外の出来事の理由か、額が0の理由（切り替えより前の出来事、額が0の出荷）だけ。支払いやカード会社の取り消しのお金が動く出来事は、仕訳が入るまで閉じられない。手で仕訳を入れる画面は計画2では作らない（必要ならオーナーが決める）。
- 計画3が入るまで、出荷前に返金した注文の売上と前受金も正しくない（返金の分だけ売上が多く立ち、前受金が減らない）。実際の注文を受ける開店は計画3の後にする。
- 返金の画面は、計画3までカード会社の判断待ちの注文でも止まらない（出荷の画面と route だけ止める）。
- 注文に結び付かない Stripe の入金と知らない種類の取引は、手で仕訳を入れる画面ができるまで、計上待ちに残る。
- KPI の受注高は、計画3が出荷前の返金の仕訳を入れるまで、返金を引かない。今の KPI は返金を元の月から引いているので、その間は数字が違って見える。
- 本番の注文・Stripe の行は0件なので、移しかえは無い。本番で Stripe の取り込みを流して確かめることはしない。

## セルフレビュー（writing-plans）

**仕様の網羅:** 設計の行から Task への対応表で、2・4・6・8章の全部の行、1-a01〜1-a03・1-a10〜1-a17、1-d の待っている一覧、3-h、7章の 7-b・7-h・7-i〜7-i5、16章の範囲の行を、作る Task と固定する試験に結んだ。範囲の外の行（返金・返品の 1-a04〜1-a09・1-a22、2-d、6-b2・6-f、7-k、原価・在庫）は「計画N」と書いた。決められない所は未確認事項に置いた。

**型・名前:** `PendingReason`・`PostingRunResult`・`private.accounting_post_payment_events`・`…_shipment_events`・`…_stripe_events`・`…_dispute_events`・`public.accounting_run_posting`・`private.accounting_allocate_amount`・`private.accounting_period_for_event`・`private.accounting_dispute_lost_at`・`public.list_order_intake_events`・`get_intake_reconciliation`・`admin_set_kpi_monthly_records` は、Task 1〜13 で同じ綴り・同じ引数で使う。印は計画1の `buildEventKey` の27種と arity をそのまま使い、新しい種類は足さない（`payment_confirmed` 1・`shipment_confirmed` 1・`shipment_redated` 1・`stripe_fee` 1・`stripe_tax_adjustment` 1・`payout_started` 1・`bank_arrived` 1・`payout_failed` 1・`balance_topup` 1・`dispute_event` 3・`reversal` 1。戻りは `dispute_event` の `reversal` に統一し `dispute_withdrawn_late` は使わない）。権限は計画1の6件と `admin.finance.read/manage`・`admin.orders.read` だけを使い、新しい権限は足さない。

**Review Focus の5行:** 1行目は Task 2・3、2行目は Task 1・3・10、3行目は Task 4・5・6、4行目は Task 7・13、5行目は Task 5・8・12・15 の試験で確かめられる。

**計画1への直し:** 願い4件のうち、計画1に取り込んだのは2件（期間の決め方の切り出し、仕訳の一覧の続きの目印を日と番号の組にすること）、不要が1件（core の記録の人 NULL）、controller への願いが1件（計画3の地図の行）。確かめ直しで計画1に足した物: 出来事の記録の日時 `_source_recorded_at`（core と取り消しの core だけ、見出しの列に残す）、印の表の固定の語と `reversal`、store の引数、`accounting_period_for_event` の記録の人の引数、fixture の `sourceRecordedAt`。3回目で、取り消しの一般の入口の引数の書き分け（`_source_recorded_at` を持たない）、未来の時刻の比べ方、型と読み口の `source_recorded_at`、期間の決め方の正本を Task 7 の1か所にすること。
