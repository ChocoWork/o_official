# 負けた取り消しと返品の0円の終わりの自動計上（S27） 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計上待ちの `order_not_postable` のうち `dispute_lost` と `return_closed_after_lost` を、人の操作なしに計上係が注文つきの仕訳（または入れない）として扱い、注文ごとの 2130 `return_refund`・1470 の残高を正しく動かす。

**Architecture:** 移行 S27 1本で、返品の計上係 `private.accounting_post_return_events(integer)` と取り消しの計上係 `private.accounting_post_dispute_events(integer)` の「止める」塊を作り直し、返金の計上係の待ち `private.accounting_refund_wait(uuid,text)` に「入れない決定は済み」の条件を足す。途中の返金（設計 3-3 の5つの形。負けた日で切らない）を集める私用の STABLE 関数 `private.accounting_order_refunds_in_flight(uuid,uuid)` を1つ足し、2つの計上係が呼ぶ。前提は新しい理由を作らず、今ある理由（`dispute_refund_overlap`・`dispute_return_refund_pending`・`dispute_withdrawal_missing`）の「待ち」にする。画面・route・新しい表は作らず、計上待ちの一覧の2つの理由の文と、`ORDER_NOT_POSTABLE_MANUAL_TEXT` の削除だけを直す。

**Tech Stack:** Supabase Postgres 17（plpgsql）、PostgREST、Jest（DB 結合試験は `describeLocalDb`）、React Testing Library、Playwright（本番ビルド）。依存は増やさない。

**Spec:** [設計](../specs/2026-11-15-accounting-pending-manual-entry-design.md)（コミット `a0860dd5`）。設計が正本。式・円の例 (a)〜(j)・印・待ち・文言は設計のとおりに実装し、食い違いに気づいたら黙って変えず controller に報告する。作りの手本は [計画3](2026-11-04-accounting-p3-returns-refunds.md)（置き換えの印・末尾の確かめ・改ざん試験・コミットする試験・本番を読んで尋ねる Task）。

## Global Constraints

計画3の Global Constraints を引き継ぐ（行ロックを取らない・鍵の順・見出しは `U&'\XXXX'` を含む）。足す・強める所:

- 作業は master だけ。ブランチ・worktree は作らない。push はしない。
- `.env*` を読まない。`supabase config push` を流さない。`graphify update .` を自分で流さない（コミットのフックに任せる）。
- 実装者（サブエージェント）は本番の DB に一切触れない（Supabase MCP の本番への読み書きも含む）。本番を読む・当てるのは controller だけで、当てるにはオーナーの許可が要る（無回答を承認としない）。
- 手元の Supabase と3000番は別セッションと共有。`db reset`・E2E・コミットする試験（`ACCOUNTING_COMMIT_SUITE=1`）の前に controller が他のセッションと調整する。実装者は調整なしに流さない。DB 試験を流す Step は、controller が `db reset` で育てた S27 を手元に当て直した後に流す（各 Task の「当て直す」Step）。
- E2E は本番ビルド（`next build && next start`）だけ。dev サーバーで流さない。3000番に残ったアプリは先に止める（`.claude/CLAUDE.md`）。
- 移行名は `20261115100000` より後の版。この計画では `20261116000000_accounting_p3_pending_auto_posting.sql`（既に別の移行がこの版以降にあれば、それより後に振り直す）。ASCII・BOM なし・LF・1つの取引（`BEGIN;` … 末尾の確かめ → `NOTIFY pgrst, 'reload schema';` → `COMMIT;`）。移行の中の区切りは `-- ACC_S27_PRECHECK_BEGIN/END`・`-- ACC_S27_BODY_BEGIN/END`・`-- ACC_S27_FINAL_ASSERT_BEGIN/END`。
- 作り直す関数は最新の定義を一字も変えずに写し、足す所は `-- ACC_P3_BEGIN`／`-- ACC_P3_END`、置き換える所は `-- ACC_P3_REPLACE_BEGIN <元の文を改行まで含めた md5>`／`-- ACC_P3_REPLACE_END` で囲む（md5 の取り方は `accounting_p3_migration_asserts.integration.test.ts:870-880` の `originalOf`）。引数・戻り・属性（SECURITY DEFINER・`search_path=''`・STABLE の別）・所有者 `postgres`・ACL は変えない。新しい塊に行ロック（`FOR UPDATE`・`PERFORM 1 FROM … FOR UPDATE`）を足さない（計画2の S11 の再生が needle で見る）。
- 新しい理由・新しい表・新しい権限・新しい `why` の値・新しい仕訳の種類は作らない。理由の CHECK は20個のまま。`accounting_pending_detail_valid` と `admin_link_accounting_pending_entry`（S24）は作り直さない。**新しい関数は私用の2つだけ**（controller の裁定。下の `private.accounting_order_refunds_in_flight` と `private.accounting_order_return_payable`）。
- 人が確かめて閉じる画面・route・関数、「仕訳なしで閉じる」道は作らない（D10）。
- 自動の仕訳は `recorded_by` が NULL。見出しは内容の印に入らない。
- 試験の題は `FREQ-643-AC-NN: …` で始める。要求番号は `FREQ-643`、E2E は `e2e/FR-ADMIN-169-pending-auto-posting.spec.ts`（2026-11-15 に docs・e2e・tests・src のどこにも未使用を確かめた。着手時にもう一度 `grep -rn "FREQ-643\|FR-ADMIN-169"` で確かめる）。
- 文書は日本語、「ページ」と書く（読みにくい漢字は使わない）。コミットは `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` で終える。コードを変えた同じコミットで docs の正本を更新する（`.claude/CLAUDE.md`）。
- 仕訳の円は設計 3-8 の表のとおりに DB 試験で固定する。各例で、入れる前と後の次の残高を円で `expect` する: 2130 `return_refund`、1470 を補助科目ごとに（`dispute_pending`・`dispute_refund_overlap_review`・`dispute_confirmed_unassigned`）、4020、4050、1160、費用の科目（(c1)(c2)(d2)）、売上の純額（4010 − 4020 + 4050）。
- 使う固定の部品（名前を変えない）:
  - 途中の返金の集まり: `private.accounting_order_refunds_in_flight(_order_id uuid, _decision_fact_id uuid) RETURNS TABLE(refund_id uuid, excluded boolean, post_shipment_amount integer)`。LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''、所有者 `postgres`、`REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`（誰にも GRANT しない。呼ぶのは同じ所有者の計上係だけ）。返すのは、その注文の返金（`order_refunds` と `accounting_refund_facts` が結ぶ物）のうち設計 3-3 の5つの形のどれかに当たる物で、**負けた日・決定の日では切らない**（S24 `accounting_dispute_offset_ready` の最初の段の `accounting_jst_date(r.created_at) <= _lost_on` は、この関数には持ち込まない）。5つの形の文は S24 `20261113110000:133-163` を写す。`_decision_fact_id` が NULL でなければ、設計 3-3 の「途中から外す3条件」を全部満たす返金の `excluded` が真になる。条件2（その決定と、日の鍵がそれより後の同じ注文の決定を済んだとすると `accounting_refund_wait(R,'success')` が NULL になる）の文の形は Task 1 Step 4 に書く。`post_shipment_amount` は `accounting_refund_facts.post_shipment_amount`。
  - R の式（設計 2-2・3-2）の関数: `private.accounting_order_return_payable(_order_id uuid, _through date) RETURNS bigint`。LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''、所有者 `postgres`、`REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`（誰にも GRANT しない）。2130 `return_refund` の（貸方 − 借方）を、日 `_through` 以前の仕訳だけで数える。**`_through` が NULL なら日の条件なし（P(今)）。0 で切らない（負をそのまま返す）。** 本体は S22 `20261113090000:165-172` の `v_r` の文を一字も変えずに写し、`_lost_on` を `_through` に替え、日の条件を `(_through IS NULL OR CASE WHEN f.id IS NULL THEN e.entry_date ELSE private.accounting_jst_date(f.created_at) END <= _through)` にする（返金の成功の仕訳〔`event_kind='return_refund'`・`source_table='order_refunds'`・取り消しでないもの〕は、仕訳の日でなく返金を作った日で数える）。名前は実装の時に `grep` で未使用を確かめる。呼ぶ所は P(D)＝`(order, D)`、P(今)＝`(order, NULL)`、B(d_n)＝`(order, d_n)`、入れた後の確かめ（日まで・今）。どれも仕訳を入れる文とは別の文で呼ぶ（STABLE は呼ぶ文の始めのスナップショットを読むので、入れた直後の値を読むには別の文が要る）。**`private.accounting_dispute_offset_amounts` は使えない**: `_lost_on` が NULL だと `pay = 0` で返る（:161-163）ので P(今) が出せず、`pay := LEAST(GREATEST(v_r, 0), _amount)`（:196）で負を落とすので B(d_n) が出せない。

## Review Focus

設計は書いたが、どの Task の本試験も主役にしない入力。それぞれ、持ち主の Task に試験を足す。

1. 同じ計上係を2回流す・前回で止まった行を再評価する時に、2本目の仕訳・2本目の `no_revenue` 行ができない（持ち主 Task 2・3。`dedupe_key` と「印があれば何もしない」）。
2. `return_closed_after_lost` で、負けた日より後の0円の終わりのうち取り消されたもの（`reverses_entry_id` で打ち消された）は数えず、直しを入れない。取り消した後の流しで C だけが入り、y_n は取り消されていない日のぶんだけ（持ち主 Task 3）。
3. C の期間は有るが、直しの d_n の期間が無い時は、C も直しも入らず（同じ取引の中で巻き戻る）、`period_missing` の計上待ちの `detail.entry_date` が d_n になる（人に「負けた日の期間を作れ」と読ませない。持ち主 Task 3）。
4. `refund_id` が NULL でない決定、`order_id` が無い取り消し（`no_order`）、決定日 D が負けた日より前の決定は、今までの動きのまま（持ち主 Task 2・3）。
5. S27 の前に作られた開いた `dispute_lost`／`return_closed_after_lost` の行（lane 1）が、S27 の後の最初の計上係の実行で、入る・待ちの理由に変わる・`no_revenue` で閉じる、のどれかになり、開いたまま残らない（持ち主 Task 2・3）。

---

## 作るファイルの全体

| ファイル | 作る・直す | 責務 |
| --- | --- | --- |
| `supabase/migrations/20261116000000_accounting_p3_pending_auto_posting.sql` | 作る（Task 1〜4で育てる） | S27。前の確かめ・私用の関数2つの追加・3関数の作り直し・末尾の確かめ |
| `tests/integration/db/accounting_p3_pending_auto_posting.integration.test.ts` | 作る | 円の例 (a)〜(j) と AC-01〜AC-09・AC-11（SQL 側） |
| `tests/integration/db/accounting_p3_pending_auto_posting_concurrency.integration.test.ts` | 作る | AC-10（コミットする試験）、AC-11 の流し |
| `tests/integration/db/helpers/accounting-pending-auto-fixtures.ts` | 作る | (a)〜(j) を作る部品（品の値段の並びを引数にする） |
| `tests/integration/db/helpers/accounting-returns-fixtures.ts` | 直す | `ACCOUNTING_S27_*`・`accountingS27Section('PRECHECK'｜'BODY'｜'FINAL_ASSERT')`・`pinAccountingS27Baseline`・`restoreS22DisputeAndReturnPosters` |
| `tests/integration/db/accounting_p3_migration_asserts.integration.test.ts` | 直す | S27 の確かめ・改ざん・前の確かめ。S22 の再生に戻す部品を挟む |
| `tests/integration/db/accounting_p3_dispute_offset.integration.test.ts` | 直す | 旧「止める」を期待した3か所（:400-410・:419-432・:488-497。どれも P=0 の形）を新しい動きへ |
| `tests/integration/db/accounting_p3_pending_manual_close.integration.test.ts` | 直す | :165-205 の本物の流れを S27 の動きに書き直し（`link` の部分を消す）、:68 の一覧から2つの理由を外す |
| `src/components/cost-profit/pending-view.tsx` | 直す | `REASON_TEXT` の2つの文を直し、`ORDER_NOT_POSTABLE_MANUAL_TEXT` とその呼び出しの枝を消す |
| `tests/unit/components/cost-profit/pending-view.test.tsx` | 直す | 12-3 の (1)〜(4) と `REASON_SNIPPETS` |
| `tests/unit/lib/accounting/event-key.test.ts` | 直す | `closefix` の印の往復 |
| `e2e/FR-ADMIN-169-pending-auto-posting.spec.ts`、`e2e/accounting-test-utils.ts` | 作る・直す | 3幅（390・768・1280）の一覧と仕訳帳。返金を成功させる部品を足す |
| docs（Task ごとに下に列挙） | 直す | 同じコミットで更新 |

## S27 の塊の数（Task 4 の末尾の確かめと一致させる）

| 関数 | 足す塊（`ACC_P3_BEGIN`） | 置き換え（`ACC_P3_REPLACE_BEGIN`） | 元の比べる md5（空白除去。ACC_P 除去後） |
| --- | --- | --- | --- |
| `accounting_post_return_events(integer)` | 1（S22 :1001-1012 の中身を作り直す） | 0 | `df6bc5cf1eb282500e2643b825eaa986`（S22 :1208-1211 の値） |
| `accounting_post_dispute_events(integer)` | 3（S22 の DECLARE の塊 :295-305 に変数を足す・止める塊 :626-645 の作り直し・**3つ目は C を入れた後の直し**。S22 :690 の `END IF;`（`v_confirmed_count` の加算を含む `IF (v_result ->> 'created')::boolean THEN … END IF;` の終わり）の後、:691 の `IF v_job.lane = 1 THEN` の前。どちらも C の ELSE の枝 :650-695 の中） | 4（S22 のまま :402・:511・:544・:652） | `be33247d41422ff1384c8037a7dba912`（同） |
| `accounting_refund_wait(uuid,text)` | 0 | 1（`return_prior` の決定の段の末尾の2行 S20 :221-222） | S20 の本文を空白除去した md5（実装の時に S20 適用後の `prosrc` から取る） |
| `accounting_order_refunds_in_flight(uuid,uuid)` | 新しい関数（`ACC_P3` の囲みは付けない。本体の md5 を末尾の確かめの needle と一緒に固定） | – | – |
| `accounting_order_return_payable(uuid,date)` | 新しい関数（同上。本体の md5 を固定） | – | – |

置き換え前の文の一覧（`ACC_P3_REPLACE` の md5 → 元の字。S22 の o1〜o4 は `20261113090000:1225-1263` をそのまま写す。refund_wait の元は S20 `:221-222` の2行（:221 `AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e`、:222 `WHERE e.dedupe_key = … ARRAY[a.id::text]))))) THEN`）を改行まで含めて1つの置き換えにする）。

---

### Task 1: S27 の骨組み・前の確かめ・`accounting_refund_wait`・途中の返金の関数・要求の行

**Files:**
- Create: `supabase/migrations/20261116000000_accounting_p3_pending_auto_posting.sql`、`tests/integration/db/accounting_p3_pending_auto_posting.integration.test.ts`、`tests/integration/db/helpers/accounting-pending-auto-fixtures.ts`
- Modify: `tests/integration/db/helpers/accounting-returns-fixtures.ts`、`docs/02_Requirements/requirements.md`（FREQ-643 の行を、番号の順に書く。設計 12-1・12-2 の表の AC-13 と AC-14 の並びは入れ替えて AC-13 → AC-14）、`docs/05_Quality/tests/test-spec.md`
- Read: `20261112214341_accounting_p3_refund_posting.sql:199-225`（`accounting_refund_wait`。後の移行に作り直しは無く、S26 は呼ぶだけ）、`20261113110000_accounting_p3_pending_manual_close.sql:121-196`（`accounting_dispute_offset_ready` の最新。最初の段の5つの形は :133-163）、S24 の前の確かめと末尾の確かめの形

**Interfaces:**
- Consumes: S20 の `accounting_refund_wait(_refund_id uuid, _step text) RETURNS text`（STABLE・SECURITY DEFINER・`search_path=''`）。
- Produces: 移行の骨組み（`ACC_S27_PRECHECK` → `ACC_S27_BODY` → `ACC_S27_FINAL_ASSERT`）、上の `private.accounting_order_refunds_in_flight(uuid,uuid)`、作り直した `accounting_refund_wait`。`accountingS27Section('PRECHECK' | 'BODY' | 'FINAL_ASSERT')`、`pinAccountingS27Baseline(client)`、`ACCOUNTING_S27_SQL`・`ACCOUNTING_S27_FILES`（`accounting-returns-fixtures.ts`。S26 の同名の部品と同じ形）。`accounting-pending-auto-fixtures.ts`: `seedAutoOrder(client, items: number[])`（品の値段の並び。例 (e) は `[5000,15000]`、(h)(i)(j) は `[10000,10000]`、(a) は `[10000]`）・`seedArrival`・`seedWithdrawn`・`seedLost`・`seedZeroClose`・`seedRefundInFlight`（引数は orderId・円・日付・返品の番号）。

- [ ] **Step 1: 失敗する試験を書く。**
  - `FREQ-643-AC-12: 閉じた dispute_lost の行（resolved_by と resolved_entry_id あり）が1件でもあれば S27 の前の確かめが ACCOUNTING_MIGRATION_ASSERTION_FAILED で止まる`（`order_not_postable`・`detail.reason` が `dispute_lost` と `return_closed_after_lost` のそれぞれで。開いた行だけなら通る）。前の確かめは `accountingS27Section('PRECHECK')` だけを流して確かめる。
  - `FREQ-643-AC-06: 入れない決定は return_prior で済んだと数えられ、同じ返品の後の返金の成功が入る`。**この時点では返品の計上係が `dispute_lost` で止めるので、`no_revenue` で閉じた決定は `accounting_park_event(…, 'no_revenue', '{}')` ＋ `accounting_unpark_event(…, NULL)` で直に作る**（payable_delta ≠ 0 の決定の事実に対して）。(j) の流れ全体の試験は Task 2。
  - `FREQ-643-AC-06: 今ある no_revenue（payable_delta = 0）は元から待ちの対象外のまま`・`FREQ-643-AC-06: 開いた行・resolved_entry_id が NULL でない行は済みと数えない`。
  - `FREQ-643-AC-03: accounting_order_refunds_in_flight は5つの形（requested・accepted・error／成功済みで仕訳なし／failed・owed で失敗の仕訳なし／canceled で abandoned・owed なし／abandoned で取りやめの仕訳なし）の返金だけを、作った日が負けた日より後でも返す`。仕訳が入った・閉じた行がある・`before_cutover` の行がある返金は返さない。`_decision_fact_id = NULL` なら全部 `excluded = false`。外す3条件の各句を1つずつ欠いた場面で `excluded = false`（条件1: `accounting_refund_wait` が NULL の普通の返金、条件2: 前の決定が自分より前に残る、条件3: (3) `failed`・`owed`、(4) `canceled`、(5) `abandoned` の返金。成功の仕訳が無く条件1・2は成り立つが、設計 3-3 の条件3は (1)・(2) だけなので `excluded = false`）。
  - `FREQ-643-AC-12: 関数2つ（途中の返金・R の式）は SECURITY DEFINER・search_path=''・STABLE・所有者 postgres で、anon・authenticated・service_role に EXECUTE が無い`。
  - `FREQ-643-AC-03: accounting_order_return_payable` の値の試験: 返金の成功は作った日で数える（仕訳の日で数えない）、成功の取り消しは仕訳の日で数える、`_through` NULL は全部、負の値をそのまま返す、別の注文・別の補助科目を数えない。`FREQ-643-AC-03: S22 の C の式と同じ`: (a)(b)(d)(f) の円で、`LEAST(GREATEST(accounting_order_return_payable(注文, 負けた日), 0), S)` が `accounting_dispute_offset_amounts(注文, 負けた日, S).pay` に等しい（S22 の文とのずれを試験で見る）。
- [ ] **Step 2: 失敗を確かめる。** Run: `npx.cmd jest tests/integration/db/accounting_p3_pending_auto_posting --runInBand`（controller が手元の DB の使用を調整した後に流す）。Expected: FAIL（S27 が無い）。
- [ ] **Step 3: 移行の前の確かめを書く。** `-- ACC_S27_PRECHECK_BEGIN/END` の中の `DO` ブロック。`accounting_pending_events` のうち `reason='order_not_postable'` かつ `detail->>'reason' IN ('dispute_lost','return_closed_after_lost')` かつ `resolved_at IS NOT NULL AND resolved_entry_id IS NOT NULL AND resolved_by IS NOT NULL` が0件であること。1件でもあれば `RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE='55000', DETAIL='acc_s27_precheck'`。開いた行の件数は `RAISE NOTICE` で出す。
- [ ] **Step 4: 関数2つを足し、`private.accounting_refund_wait(uuid,text)` を作り直す。**
  - `private.accounting_order_return_payable(_order_id uuid, _through date)` を `CREATE FUNCTION`（Global Constraints の定義のとおり）。
  - `private.accounting_order_refunds_in_flight(_order_id uuid, _decision_fact_id uuid)` を `CREATE FUNCTION`。属性・ACL は Global Constraints のとおり。条件2の文の形: 返金 R の返品 `return_id` について、`accounting_return_facts` の `kind = 'decision'` で `payable_delta <> 0`・`seq <= R の決定の seq`・`return_amount_decided` の印の仕訳なし・`no_revenue` で閉じた行なし、の物が **全部**、評価している決定 X の日の鍵（日 D、`created_at`、`return_id`、`seq`）以上であり（X 自身と X より後の同じ注文の決定は済んだものとして数える）、かつ R の決定より前の `kind = 'arrival'` に仕訳のない物が無いこと。条件1は `accounting_refund_wait(R, 'success')` が NULL でないこと。条件3は、その返金が5つの形のうち (1)（最後の状態が `requested`・`accepted`・`error`）か (2)（成功したが成功の仕訳が無い）に当たること（設計 3-3 :130。(3)〜(5) の返金は外さずに待つ。正本より広げない）。条件1・2は S20 :210-225 の `refund_wait` の `return_prior` の文を、評価している決定 X 以降を済んだ仮の前提で読み直す形で、`v_seq` が NULL（R に決定が無い）の時は S20 :217・:220 と同じに `(v_seq IS NULL OR …)` で全部を見る。
  - `accounting_refund_wait` は `CREATE OR REPLACE`。S20 の本文を一字も変えず写し、`return_prior` の決定の段の末尾の行（`AND NOT EXISTS (… dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[a.id::text]))))) THEN`）の2行（S20 :221-222。:221 `AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e`、:222 `WHERE e.dedupe_key = …`。改行まで含めて1つの md5）を `ACC_P3_REPLACE_BEGIN <その2行の md5>`／`END` で囲んで置き換え、元の `AND NOT EXISTS (…)` の後ろに設計 3-6 の条件を足した行にする（閉じ括弧と `THEN` の位置は元のまま）: `AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p WHERE p.event_kind = 'return_amount_decided' AND p.source_table = 'accounting_return_facts' AND p.source_id = a.id::text AND p.reason = 'no_revenue' AND p.resolved_at IS NOT NULL AND p.resolved_entry_id IS NULL)`。
- [ ] **Step 5: 当て直して通す。** controller が `db reset` で S27 を当て直した後、Step 2 と同じコマンド。Expected: Step 1 の試験が PASS。同じ実行で S20 の既存の返金の計上の試験（`accounting_p3_refund_posting`・`accounting_p3_refund_order_independence`）が無改造で通る。
- [ ] **Step 6: docs と commit。** requirements.md の FREQ-643、test-spec の行。コミット対象はこの Task で変えたファイルだけ（`git add` は名前で。`.superpowers/` は足さない）。
  ```bash
  git commit -m "feat(accounting): S27 の骨組みと途中の返金の関数・入れない決定を返金の待ちが済みと数える（FREQ-643）"
  ```

---

### Task 2: 返品の計上係の `dispute_lost`（0円の終わり）

**Files:**
- Modify: `supabase/migrations/20261116000000_accounting_p3_pending_auto_posting.sql`、`tests/integration/db/accounting_p3_pending_auto_posting.integration.test.ts`、`tests/integration/db/accounting_p3_dispute_offset.integration.test.ts`（:400-410・:488-497）、`tests/integration/db/accounting_p3_pending_manual_close.integration.test.ts`（:165-205）、`tests/integration/db/accounting_p3_migration_asserts.integration.test.ts`（S22 の再生）、`tests/integration/db/helpers/accounting-returns-fixtures.ts`（`restoreS22DisputeAndReturnPosters`）
- Docs（返品の計上係の動きが変わる同じコミット）: `docs/04_DetailDesign/states/accounting-pending.md`、`docs/04_DetailDesign/sequence/accounting-posting.md`、`docs/06_Operations/accounting-p3-returns-refunds.md`（`dispute_lost` の「手で入れる」を自動に。取り出しの順は返品の計上係が `ORDER BY lane, phase`、取り消しの計上係が `ORDER BY j.phase, j.lane`（S22 :357）で違うことも書く）、`docs/05_Quality/tests/test-spec.md`
- Read: `20261113090000:808-1095`（`accounting_post_return_events`。取り出し :880-924、IF 連なりは :989 から、止める塊 :1001-1012、ELSE の入れる枝 :1013-1024）、`20261115100000:149-159`（`v_left` の式）、`20261113110000:133-163`（途中の返金の5つの形）、`20261113090000:165-172`（R の式）

**Interfaces:**
- Consumes: Task 1 の関数・部品。`private.accounting_return_lines('waive', 注文, w, f)`、`accounting_post_journal_core`、`accounting_park_event`、`accounting_unpark_event`。
- Produces: 作り直した `private.accounting_post_return_events(integer)`（引数・戻り・属性は S22 と同じ）。足す塊は **1つ**（S22 :1001-1012 の ELSIF の枝の中身）、置き換え 0。

- [ ] **Step 1: 失敗する試験を書く。** 各題の中で、入れる前後の残高（Global Constraints の一覧）を円で固定する。
  - `FREQ-643-AC-01: (b) 一部だけ引かれた（S=4,000）の0円の終わりは w=6,000 で入る`（借 2130 6,000／貸 4020 6,000、全行に注文、印 `return_amount_decided:[事実の番号]`、`source_table='accounting_return_facts'`、日=決定の日。入れた後 2130 = 0、売上の純額 6,000。2回流しても1本）。**w で入れた仕訳の見出し・`_source_recorded_at`・`source_table`・`source_id`・memo が、普通の0円の終わりの仕訳（C が無い注文で同じ決定を入れた物）と同じ**ことを比べる。
  - `FREQ-643-AC-01: (c2) 手数料あり（G=10,000・F=1,000・S=4,000）は 借 2130 5,000・借 4050 1,000／貸 4020 6,000`、入れた後 4050 の純額0。
  - `FREQ-643-AC-02: (a) 返品が引かれた額と同じなら入れず no_revenue で閉じる`（`detail` `{}`・`resolved_entry_id` NULL。入れていれば 2130 が −10,000 だった）、`(c1)`、`(g) D より後の取り下げ L の戻りで 2130=10,000 が残る`、`(h) 2つの返品は両方決まるまで待ち、両方 P_eff=0 で入れない`、`P(D) が負でも入れない`。設計の続き: (e) の後に返品 B を0円で終えても入れない。(j) で返金が後で失敗すると 2130 = 10,000 が残る。
  - `FREQ-643-AC-03:` 途中の返金の5つの形それぞれで `dispute_refund_overlap`（detail `why` `refund`）、ほかの返品が未決（v_left > 0）で `dispute_return_refund_pending`（`why` `return`）、待っている間 2130 が変わらない、解けた後の次の流しで入る。`(h) 組2`（成功の仕訳が入る前は待ち・入った後に P_eff=0）。何も待っていない普通の途中の返金は外れず待つ。`error` の返金が再試行で成功した後に流しても 2130 が負にならない。理由の CHECK が20個のまま。
  - `FREQ-643-AC-05:` (h) 組1に day10 の L を足した円。新しい決定（lane 0）が古い待ち（lane 1）より先に取り出されても、日の早い物が先に入り終わりの 2130=10,000（`逆の順に入れると 2130=0 で L の借りが消える`との比べ）。同じ日の2つ・別の理由で止まった決定が鍵に入ること・`before_cutover` の行が鍵に入らないこと。
  - `FREQ-643-AC-06: (j) W1 を評価する時、R は途中の数から外れ、W1 が no_revenue で閉じ、R の成功が入る`（互いの待ちが残らない。1160 の貸が W と R で 10,000 ずつ）。外れない3条件（届いたものの仕訳待ちが残る・何も待っていない普通の途中の返金・成功の仕訳が入っている返金）。W1・W2 の順に解ける。別の返品の返金が鍵の遅い決定だけを待つ場合も外れる。
  - `FREQ-643-AC-08:` 期間が無い日（法人、または個人をやめた後の日で作る）は `period_missing`、切り替えの日より前は `before_cutover`、何も書かれない。**入れた後の 2130 が負になる細工**: savepoint の中で `private.accounting_return_lines` を、`waive` の時 w と w+f を2倍にした版（借方・貸方とも2倍で釣り合う）に作り直して流し、入れた後の確かめが `ACCOUNTING_POSTING_BALANCE_NEGATIVE`（SQLSTATE `23514`。`^(ACCOUNTING|GROUP_G|GROUP_H)_[A-Z0-9_]{1,80}$` に合う名前）の例外を投げ、`accounting_park_failure` の `error_code` にその名前が残り、何も書かれないこと。savepoint を戻す。
  - Review Focus 4・5: `refund_id` ありの決定と D が負けた日より前の決定は今までの動き（C が入っていても普通に入る）。S27 の前に作った開いた `dispute_lost` の行（`accounting_park_event` で作る）が、最初の流しで入る・待ちの理由に変わる・`no_revenue` で閉じるのどれかになる。
- [ ] **Step 2: 失敗を確かめる。** Expected: FAIL（`dispute_lost` で止まる、または2130が負）。
- [ ] **Step 3: `private.accounting_post_return_events(integer)` を作り直す。** S22 の本文を一字も変えず写し、`ACC_P3_BEGIN … ACC_P3_END`（S22 :1001-1012）の **ELSIF の枝の中身だけ**を作り直す（連なりの形・ELSE は変えない）。枝の中に入れ子の `DECLARE … BEGIN … END;` を置いて P(D)・P(今)′・w・待ちの結果を持つ。
  - 条件（今の止めと同じ）: `refund_id IS NULL`、その注文に取り消し d があり負けた日（JST）≤ D、かつ C の印の仕訳がある。
  - 待ち（設計 3-3 の順）: 日の早い物が先（3-5 の鍵。`before_cutover` の開いた行は数えない）→ 途中の返金（`private.accounting_order_refunds_in_flight(v_fact.order_id, v_fact.id)` に `excluded = false` の行が1つでもあれば `dispute_refund_overlap`、`why` `refund`）→ ほかの返品が未決（`v_left > 0`。`dispute_return_refund_pending`、`why` `return`）。当たれば `v_reason`・`v_detail` を決めて枝を終える（ELSE に進まない）。
  - 計算（設計 3-2）: P(D) ＝ `private.accounting_order_return_payable(v_fact.order_id, v_date)`、P(今) ＝ `private.accounting_order_return_payable(v_fact.order_id, NULL)`（返金の成功は作った日で数える。0 で切らない。式の写しは作らない）、`P(今)′ = P(今) − Σ（excluded = true の行の post_shipment_amount）`、`P_eff = LEAST(P(D), P(今)′)`、`w = LEAST(covers_amount, GREATEST(P_eff, 0))`。`P_eff <= 0` なら `v_reason := 'no_revenue'`（今の枝。`detail` `{}`）。`w > 0` なら、**枝の中で**、ELSE と同じ呼び出しを写して入れる: `accounting_period_for_event(v_date)`、`accounting_return_lines('waive', v_fact.order_id, w, v_fact.fee_amount)`、`accounting_post_journal_core(NULL, v_period, v_date, 'return_amount_decided', ARRAY[v_fact.id::text], U&'\8FD4\91D1\306E\984D\306E\6C7A\5B9A', v_lines, _source_table => 'accounting_return_facts', _source_id => v_fact.id::text, _source_recorded_at => LEAST(v_fact.created_at, pg_catalog.clock_timestamp()))`、`v_posted` の加算、`accounting_unpark_event(v_kind, v_table, v_source, v_entry_id)`、lane 1 の `v_resolved` の加算。`v_reason` は NULL のまま（連なりの後の park 処理を通らない）。
  - 入れた後の確かめ（設計 4-3 の3）: 入れた**後の別の文**で `accounting_order_return_payable(注文, v_date)` と `(注文, NULL)` を読み、どちらかが 0 未満なら `RAISE EXCEPTION 'ACCOUNTING_POSTING_BALANCE_NEGATIVE' USING ERRCODE = '23514'`（家の `ACCOUNTING_ENTRY_UNBALANCED` と同じ SQLSTATE。今の計上係の `posting_error` の道に入り、`accounting_park_failure` の `error_code` に名前、SQLSTATE も残る）。取り消しの計上係（Task 3）の入れた後の確かめも同じ例外・同じ SQLSTATE。
- [ ] **Step 4: 旧「止める」を期待した試験を直す。** `accounting_p3_dispute_offset.integration.test.ts` の :400-410 と :488-497 は、`order_not_postable`/`dispute_lost` の開いた行を期待している（どれも P=0 の (a) の形）。S27 の後は `no_revenue` で閉じる期待（`resolved_entry_id` NULL）に直し、円は設計 3-8 に合わせる。
  - 同じコミットで、旧「止める」に頼る既存の試験を全部直す（途中のコミットに落ちる試験を残さない）: (1) `accounting_p3_pending_manual_close.integration.test.ts:165-205`（返品を受け、引かれ、負け、0円で終え、`dispute_lost` の行を確かめ :178、2つ目の取り消し B を入れ、:202 でその行を手の仕訳と結ぶ流れ）を、**0円の終わりが `no_revenue` で閉じる形（P=0 の (a) の形）**に書き直す。`link` の部分は消し、B の確定は決定が仕訳として入っていないので普通に1本入り、`dispute_pending` が0であることを確かめる。B が入れた決定の後に来る形（C と直しで入る）は Task 3 が試験にする。(2) `restoreS22DisputeAndReturnPosters(client)` を `accounting-returns-fixtures.ts` に足し（S22 の2つの計上係を S22 の本文で作り直す。呼ぶ取引の中だけ）、`accounting_p3_migration_asserts.integration.test.ts` の S22 の再生が、控えを取る前にこれを同じ savepoint の中で呼ぶ形にする（S21 の `restoreS20RunPosting`、S24 の `restoreS23StripeReconciliation` と同じ形）。`accounting_p2_migration_asserts`（S11 の再生 :1287-1296）が今の計上係の字を needle で見るので、同じ点検をし、落ちる再生があれば同じ部品で戻す。
- [ ] **Step 5: 当て直して通す。** controller が `db reset` で S27 を当て直す。Run: Task 2 の試験と、`accounting_p3_return_posting`・`accounting_p3_return_arrival`・`accounting_p3_return_redate`・`accounting_p3_dispute_offset`・`accounting_p3_pending_manual_close`・`accounting_p3_migration_asserts`・`accounting_p2_migration_asserts`。Expected: 全部 PASS（コミットの時点で落ちる試験を残さない）。
- [ ] **Step 6: docs と commit。** Docs の4文書を更新し、`npm.cmd run validate-docs`。
  ```bash
  git commit -m "feat(accounting): 負けた後の0円の終わりを返品の計上係が自動で入れる（FREQ-643）"
  ```

---

### Task 3: 取り消しの計上係の `return_closed_after_lost`（C と直し）

**Files:**
- Modify: `supabase/migrations/20261116000000_accounting_p3_pending_auto_posting.sql`、`tests/integration/db/accounting_p3_pending_auto_posting.integration.test.ts`、`accounting_p3_dispute_offset.integration.test.ts`（:419-432 を新しい動きへ）
- Docs（取り消しの計上係の動きが変わる同じコミット）: `docs/04_DetailDesign/states/accounting-dispute.md`、`docs/04_DetailDesign/sequence/accounting-posting.md`、`docs/06_Operations/accounting-p3-returns-refunds.md`、`docs/05_Quality/tests/test-spec.md`、`docs/02_Requirements/requirements.md`（FREQ-581-AC-05 の「手で入れる待ちになり」を「計上係が自動で入れる（FREQ-643）」に）
- Read: `20261113090000:246-714`（`accounting_post_dispute_events`。DECLARE の塊 :295-305、C の前の取り下げの待ち :590-605、止める塊 :626-645、C の置き換え :652-676、`accounting_post_journal_core` :683-686、`v_confirmed_count` の加算 :688-691、lane 1 の unpark :692-695、例外の道 :697-701）、`20261113110000:121-196`（`accounting_dispute_offset_ready` の最新は S24）

**Interfaces:**
- Consumes: Task 1 の関数2つ（`accounting_order_refunds_in_flight`・`accounting_order_return_payable`）・Task 2 の鍵の文。`accounting_dispute_offset_ready(text,uuid,date)`（**最新は S24**。最初の段は `accounting_jst_date(r.created_at) <= _lost_on` で負けた日で切る）・`accounting_dispute_offset_amounts(uuid,date,bigint)`（S22）。
- Produces: 作り直した `private.accounting_post_dispute_events(integer)`。足す塊は **3つ**、置き換えは S22 のまま **4つ**。直しの印は `private.accounting_event_key('dispute_event', ARRAY['closefix', v_dispute_id, n::text])`。新しい変数は1つ目の DECLARE の塊に足す。直しの仕訳は C の `v_result`・`v_entry_id` と**別の変数**（`v_fix_result jsonb`・`v_fix_entry_id uuid`・`v_fix_n integer`・`v_fix_y bigint`・`v_fix_date date`）で受ける。

- [ ] **Step 1: 失敗する試験を書く。**
  - `FREQ-643-AC-04: (d) 逆の順（A=S=4,000、0円の終わりが day8 に先）は C と直し1本を1つのトランザクションで入れる`（C: 日 day5・借 2130 4,000／貸 1470 `dispute_pending` 4,000・印 `dispute_event:<dp>:confirmed:lost`。直し: 日 day8・借 4020 4,000／貸 2130 4,000・印 `dispute_event:closefix:<dp>:1`・`source_table='stripe_disputes'`・`source_id` が dp・見出しが打ち消す0円の終わりと同じ `U&'\8FD4\91D1\306E\984D\306E\6C7A\5B9A'`・注文あり・memo `closefix:1`・`_source_recorded_at` が入れた時刻。入れた後 2130=0、4020 の純額 借 4,000、売上の純額 6,000）。
  - `(d2) 手数料あり`（直し 9,000、4050 が0、費用 1,000。費用科目が 4020 の設定でも、後の取り下げ L の10,000が 費用1,000・返金待ち9,000 に振り分けられる。`FREQ-643-AC-09` と兼ねる）、`(e) 返品が2つ`（直し 5,000。銀行振込 15,000 が `ACCOUNTING_EVENT_NOT_POSTABLE`）、`(f) review が付く`（直し 6,000、review 4,000）。
  - `FREQ-643-AC-04:` y=0 なら直しを入れない。0円の終わりの日が2つで年をまたぐ時、直しが日ごとに各年へ入る。費用科目が未設定なら 1470 `dispute_confirmed_unassigned` に置かれ、振り替えの画面の道で振り替えられる。C の行が、今の計上係が普通の C で入れる行（見出し・`_source_recorded_at`・memo を含む）と一致する。待ちの理由と順は**文の順**で書く: C の前提の取り下げの2つ（塊の前）→ `dispute_withdrawal_missing`、続けて塊の中で `accounting_dispute_offset_ready` の `dispute_refund_overlap`・`dispute_return_refund_pending`、次に途中の返金（`accounting_order_refunds_in_flight(order, NULL)` の行が1つでも。全部待ち、外さない）→ `dispute_refund_overlap`、日の早い物が先 → `dispute_return_refund_pending`。それぞれ1本ずつ試験にする。`(i)` 直し y_1=10,000（B(d_n) は R の式で返金の成功を**作った日**で数える。仕訳の日で数えると y_1=0 で終わりの 2130 が −10,000 になる、という比べも入れる。成功の仕訳が入る前は C ごと待ち、入った後に入る）。
  - Review Focus 1〜3・5: 2回流して C も直しも1本・取り消された0円の終わりを数えない・直しの d_n の期間が無ければ C も直しも入らず、`period_missing` の `detail.entry_date` が d_n・S27 の前の開いた `return_closed_after_lost` の行が最初の流しで処理される。**その行（lane 1）の `resolved_entry_id` が、最後の直しでなく C の印の仕訳の番号であること**（円は変わらないので番号を直に比べる）。直しの有る場面で、C の仕訳は `dispute_event:<dp>:confirmed:lost`、`accounting_dispute_balance` の対象になり、直しは対象外のまま。
  - `FREQ-643-AC-07:` 入れた後に遅れての取り下げ L が来ると計上係が止めず入れる。取り消しごとの `dispute_pending` が0、取り消しの一覧の確定の日、照合の確定の科目別が C の印の仕訳を読む。(b)(e) の銀行振込は、**savepoint の中で**入れる前に流して通ることを確かめ、`rollback to savepoint` で戻してから入れる（戻さないと振込が 2130 を使い、後の円が変わる）。入れた後は断られる。`owed`／`failed` の返品の返金がある注文で `list_refund_accounting_states` の `owed_return` が新しい残高を反映する。
  - `FREQ-643-AC-07: 決定が w で入った後に、負けた日が D より前の2つ目の取り消し B が来ると、B は C と直しで入る`（入れる前と後の R・Z・pay・2130 を円で固定。設計 6章）、`FREQ-643-AC-07: 入れない決定（P_eff ≤ 0）の後の B は pay=0 で普通に入る`。
- [ ] **Step 2: 失敗を確かめる。** Expected: FAIL（`return_closed_after_lost` で止まる）。
- [ ] **Step 3: `private.accounting_post_dispute_events(integer)` を作り直す。** S22 の本文を一字も変えずに写し、次の3つの塊を足す・作り直す。
  1. DECLARE の塊（S22 :295-305）に、`v_fix_result`・`v_fix_entry_id`・`v_fix_n`・`v_fix_y`・`v_fix_date` を足す。
  2. 止める塊（S22 :626-645）。当たる条件は今の止めと同じ（その注文に、負けた日より後の日付の、取り消されていない返金なしの決定の仕訳がある）。その中の待ちは**文の順**に確かめる（C の前の取り下げの待ち :590-605 は塊の前に既にある）: 既存の `offset_ready` → 途中の返金（`accounting_order_refunds_in_flight(v_order_id, NULL)` の行が1つでもあれば `dispute_refund_overlap`、`why` `refund`。外さない）→ D13（2026-11-15 controller の裁定）・D14: C の pay が負けた日の R より小さく、かつ C の前の `accounting_order_return_payable(注文, NULL)` が 0 より大きい時だけ（返品の計上係の D3 も P(今)′ が 0 より大きい間だけ）、額が未決の別の返品（`dispute_lost` と同じ v_left）があれば `dispute_return_refund_pending`（`why` `return`）→ 日の早い物が先（`dispute_return_refund_pending`、`why` `return`）。全部当たらなければ `v_reason` は NULL のまま、C を ELSE の既存の文でそのまま入れる（C の形の写しを作らない）。
  3. 3つ目の塊（S22 :690 の `END IF;`〔`IF (v_result ->> 'created')::boolean THEN … END IF;` の終わり〕の後、:691 の `IF v_job.lane = 1 THEN` の前。C の ELSE の枝 :650-695 の中）。C が入ったとき、その注文の「負けた日より後の、返金なしの決定の仕訳（取り消されていない）」を日の早い順に `n = 1, 2, …` として、各 d_n で `y_n = GREATEST(−B(d_n), 0)` を計算する（**最後の d_n だけ D12（2026-11-15 controller の裁定）で `y_last = GREATEST(−B(d_last), LEAST(−P(今), pay_C − Σ前の y_n), 0)`**。P(今) は `accounting_order_return_payable(order, NULL)` を C と前の直しの後に別の文で読み、pay_C は C の `v_pay`）。**B(d_n) ＝ `private.accounting_order_return_payable(v_order_id, d_n)`（0 で切らない。返金の成功は作った日で数える。今入れた C・前の直しを含む。C や前の直しを入れた文とは別の文で読む）**。`y_n > 0` なら 借 4020 y_n／貸 2130 `return_refund` y_n（注文あり、日 d_n、`source_table='stripe_disputes'`・`source_id`=dp、見出し `U&'\8FD4\91D1\306E\984D\306E\6C7A\5B9A'`、`_source_recorded_at` NULL、memo `closefix:<n>`）を入れる。直しは **C の `v_result`・`v_entry_id` を上書きせず**、`v_fix_result`・`v_fix_entry_id` で受ける（C の計上待ちの行を lane 1 の unpark で C の仕訳の番号に結ぶため。直しは `v_posted`・`v_confirmed_count` に数えない）。**直しを入れる前に `v_date := d_n` にし、その後 `accounting_period_for_event(d_n)` を呼ぶ**（期間が無ければ例外 → 事象全体の巻き戻しで C も入らず、`accounting_park_failure` が `d_n` を `entry_date` に書く。C はもう入れた後なので、C の日付には影響しない）。入れた後、別の文で `accounting_order_return_payable(v_order_id, d_n)` と `(v_order_id, NULL)` が 0 以上、1470 `dispute_refund_overlap_review` が借方 0 以上であることを確かめる（違えば `RAISE EXCEPTION 'ACCOUNTING_POSTING_BALANCE_NEGATIVE' USING ERRCODE = '23514'` で `posting_error` の道）。
- [ ] **Step 4: 旧「止める」を期待した試験を直す。** `accounting_p3_dispute_offset.integration.test.ts:419-432`（`return_closed_after_lost` の開いた行）は、C と直しが入る期待に直す。
- [ ] **Step 5: 当て直して通す。** controller が `db reset` で S27 を当て直す。Run: Task 3 の試験と、`accounting_p3_dispute_offset`・`accounting_p3_dispute_order_independence`・`accounting_p3_dispute_offset_concurrency`・`accounting_p2_dispute_posting`・`accounting_p3_pending_manual_close`・`accounting_p3_migration_asserts`・`accounting_p2_migration_asserts`。Expected: 全部 PASS。
- [ ] **Step 6: docs と commit。** Docs の5文書を更新し、`npm.cmd run validate-docs`。
  ```bash
  git commit -m "feat(accounting): 負けた確定と戻しすぎの直しを取り消しの計上係が自動で入れる（FREQ-643）"
  ```

---

### Task 4: 末尾の確かめ・改ざん試験・既存の再生の直し・結ぶ試験の書き直し

**Files:**
- Modify: `supabase/migrations/20261116000000_accounting_p3_pending_auto_posting.sql`、`tests/integration/db/accounting_p3_migration_asserts.integration.test.ts`、`tests/integration/db/accounting_p3_pending_manual_close.integration.test.ts`（:68 の一覧だけ）
- Docs: `docs/06_Operations/db-migrations.md`（S27 の節・作り直した関数の一覧）、`docs/06_Operations/accounting-p3-returns-refunds.md`（S27 の手順・5-2 の件数の記録欄）、`docs/02_Requirements/requirements.md`（FREQ-569-AC-07 は「S27 の後に作られる行で結べるのは `shipping`・`units_*` の理由だけ。`dispute_lost`・`return_closed_after_lost` は計上係が自動で入れる（FREQ-643）」。S24 の結ぶ関数は作り直さないので、S27 の前に作った行は今も結べる）、`docs/03_BasicDesign/data/er.md`・`architecture/system-overview.md`・`ui/screen-list.md`（`grep -n "dispute_lost\|return_closed_after_lost"` で当たった所の文だけ直す。表・画面は変えない。screen-list には「画面の変更なし」を1行）
- Read: S22 の末尾の確かめ（`20261113090000:1100-1290`。形の手本。比べる定数は :1208-1211、置き換え前の元の字 o1〜o4 は :1225-1263）、`accounting_p3_migration_asserts.integration.test.ts:836-1010`（S22 の確かめと改ざんの手本）、`accounting-returns-fixtures.ts:508`（`restoreS20RunPosting`）・`:834`（`restoreS23StripeReconciliation`）

**Interfaces:**
- Consumes: Task 1〜3 の移行。
- Produces: 末尾の確かめの段 `acc_s27_functions`（新しい関数2つの存在〔`count = 2`〕・属性・ACL・本体の md5 と needle）、`acc_s27_function_attrs`、`acc_s27_body_unchanged`、`acc_s27_c_shape_unchanged`、`acc_s27_no_new_reason`、`acc_s27_existing_dml_allowlist`（固定 SQLSTATE `55000`・DETAIL）。`restoreS22DisputeAndReturnPosters(client)`（Task 2 で作る。S22 の2関数を S22 の本文で作り直す。呼ぶ取引の中だけ。**S20 の再生は戻さない**: S20 の確かめが `accounting_refund_wait` に見るのは存在と属性・ACL だけで、本文の md5 は `accounting_run_posting` にしか取らない）。

- [ ] **Step 1: 失敗する試験を書く。**
  - `FREQ-643-AC-12: 適用後の状態で S27 の末尾の確かめが通る（呼出元の search_path を問わない）`。
  - 改ざんの表。**塊の中身の改ざんは、塊を除いて md5 を取る `acc_s27_body_unchanged` の md5 には現れない**。S22 が `strpos` の needle で塊の中身を守るのと同じに、末尾の確かめに needle を並べ、各改ざんを落とす段の DETAIL を表にする。
    | 改ざん | 落ちる段 |
    | --- | --- |
    | 3関数の search_path・ACL・STABLE を変える | `acc_s27_function_attrs` |
    | 新しい R の関数（`accounting_order_return_payable`）の `<=` を `<` にする・`CASE WHEN f.id IS NULL` を外す・`GREATEST(` で0に切る・`_through IS NULL` の枝を消す | `acc_s27_functions`（本体の md5） |
    | 計上係の側で `accounting_order_return_payable(v_fact.order_id, v_date)`・`(v_fact.order_id, NULL)`・取り消しの計上係の `(v_order_id, d_n` の呼びを消す／R の式を計上係の中に写す | `acc_s27_body_unchanged`（呼びの needle） |
    | 直しを `v_entry_id` で受ける（`v_fix_entry_id` を消す） | `acc_s27_body_unchanged`（needle `v_fix_entry_id`） |
    | 新しい関数の search_path・ACL（anon・authenticated・service_role に GRANT）・STABLE・所有者 | `acc_s27_functions` |
    | 新しい関数から5つの形の1つ（`'requested', 'accepted', 'error'`・`refund_abandoned` など）を消す／`_lost_on`・`<=` の日の切りを持ち込む／外す3条件の句（`accounting_refund_wait(`・`'no_revenue'`）を消す | `acc_s27_functions`（needle） |
    | 返品の計上係で `LEAST(P(D)` の片方を外す・待ちの `accounting_order_refunds_in_flight(` の呼びを消す・`excluded` の読みを消す・`p.reason <> 'before_cutover'`（鍵）を消す・w を `covers_amount` のままにする | `acc_s27_body_unchanged`（needle） |
    | 取り消しの計上係で `ARRAY['closefix', v_dispute_id` を消す・`GREATEST(-` の直しの式を変える・3つ目の塊を消す（足す塊の数が3でなくなる）・`v_date := ` の d_n の代入を消す | `acc_s27_body_unchanged` |
    | `accounting_refund_wait` の足した条件から `p.reason = 'no_revenue'` または `p.resolved_entry_id IS NULL` を消す | `acc_s27_body_unchanged`（needle `p.reason = ''no_revenue'' AND p.resolved_at IS NOT NULL AND p.resolved_entry_id IS NULL`） |
    | ACC_P3 の囲みの数・置き換えの md5 を壊す、塊の外の本体に `PERFORM 1;` を足す | `acc_s27_body_unchanged`（md5） |
    | S22 の C の部分（:652-676）を1文字変える | `acc_s27_c_shape_unchanged` |
    | 理由の CHECK に21個目を足す／1つ消す | `acc_s27_no_new_reason` |
    | 控えの件数・書き手の一覧を変える | `acc_s27_existing_dml_allowlist` |
    needle で拾えない改ざん（式の中の数字だけを変える等）は、設計 5-3 のとおり円の DB 試験が落ちる側に置き、どの題が落ちるかを `accounting_p3_pending_auto_posting` の題の一覧に書いて表に足す。
  - `FREQ-643-AC-12: S24 の結ぶ関数は shipping・units_* の理由では今までどおり結べる`。`accounting_p3_pending_manual_close.integration.test.ts` は、:68 の一覧から `dispute_lost`・`return_closed_after_lost` を外す（設計 12-3。`parkManual` で行を手で作るので S27 の後も通るが、設計に合わせる）。:165-205 の本物の流れの書き直しは Task 2 で済んでいる。
- [ ] **Step 2: 失敗を確かめる。** Expected: 末尾の確かめが無く、改ざんが拒まれず FAIL。
- [ ] **Step 3: 末尾の確かめを書く。** 設計 5-3 と上の「S27 の塊の数」の表のとおり。新しい関数2つは、本体を空白を除いて取った md5 を2つとも固定する（実装の時に当てた関数の `prosrc` から取る）。置き換え前の文を `ACC_P3_REPLACE` の md5 で元の字に戻し、足す塊と `ACC_P[0-9]` を除いて空白を除いた md5 が元の値に等しいことを確かめる。2つの計上係の元の値と元の字 o1〜o4 は S22 の末尾の確かめの定数・一覧を写す。実装の時に取り直すのは、S20 の `accounting_refund_wait` の元の md5（と置き換え前の行）と、`acc_s27_c_shape_unchanged` の md5（S22 :652-676 の空白を除いた md5。設計 15章 #9）だけ。
- [ ] **Step 4: 既存の再生の確認。** `restoreS22DisputeAndReturnPosters` と S22・S11 の再生の直しは Task 2 で入れてある。ここでは、S27 の確かめ自体が S22 の再生と混ざらないことと、Task 3 の作り直しの後も両方の再生が通ることを確かめるだけにする。
- [ ] **Step 5: 当て直して通す。** controller が `db reset` で S27 を当て直す。Run: `npx.cmd jest tests/integration/db/accounting_p3_migration_asserts tests/integration/db/accounting_p3_pending_manual_close tests/integration/db/accounting_p2_migration_asserts --runInBand`。Expected: PASS。
- [ ] **Step 6: 文書を直し、`npm.cmd run validate-docs` を通す。** 更新不要と判断した文書は完了報告に1行で理由を書く。
- [ ] **Step 7: commit。**
  ```bash
  git commit -m "feat(accounting): S27 の末尾の確かめ・改ざん試験・既存の再生の直しと結ぶ試験の書き直し（FREQ-643）"
  ```

---

### Task 5: 同時・取り消しの試験（コミットする試験）

**Files:**
- Create: `tests/integration/db/accounting_p3_pending_auto_posting_concurrency.integration.test.ts`
- Modify: `tests/integration/db/accounting_p3_pending_auto_posting.integration.test.ts`（AC-11）、`docs/05_Quality/tests/test-spec.md`
- Read: 既存の `accounting_p3_dispute_offset_concurrency.integration.test.ts`（`ACCOUNTING_COMMIT_SUITE` の門と前後の `db reset` の手本。計画3の最終レビュー M7）

**Interfaces:**
- Consumes: Task 1〜4。
- Produces: なし（試験だけ）。

- [ ] **Step 1: 試験を書く。**
  - `FREQ-643-AC-10: 計上係を2つの接続で同時に流しても、仕訳は1本で重ならない`（`dispute_lost` の側と `return_closed_after_lost` の側で別々に）。
  - `FREQ-643-AC-10: 計上係と、同じ注文の返金の書き込み（返金を作る・返品の返金を決める）を同時に流しても、固まらず、2130 が負にならず、どちらが先でも最後の 2130 が同じ`（片方を先にした2通りで最後の残高を比べる。固まりは各接続に `statement_timeout`（例 15 秒）を付けて検知する）。
  - `FREQ-643-AC-11: この設計の仕訳（決定・C・直し）を admin_reverse_accounting_journal で取り消せる。取り消した後も行は閉じたまま、計上係を流しても入れ直されず、残高が取り消し分だけ元に戻る`（DB 試験の側。取引を巻き戻す形）。
- [ ] **Step 2: 流す。** controller が手元の Supabase・3000番を調整し、前後に `db reset` を入れる。Run: `ACCOUNTING_COMMIT_SUITE=1 npx.cmd jest tests/integration/db/accounting_p3_pending_auto_posting_concurrency --runInBand`（3連続）。Expected: 3回とも PASS。落ちたら、試験の書き方か実装かを切り分ける（`retries` で隠さない）。
- [ ] **Step 3: test-spec を更新し commit。** `git commit -m "test(accounting): 自動計上の同時の試験と取り消しの試験を足す（FREQ-643）"`

---

### Task 6: 計上待ちの一覧の文と単体試験

**Files:**
- Modify: `src/components/cost-profit/pending-view.tsx`（`REASON_TEXT` の :69-70、`ORDER_NOT_POSTABLE_MANUAL_TEXT` :79-82 と、`reasonText` の `order_not_postable` の枝 :98-100）、`tests/unit/components/cost-profit/pending-view.test.tsx`、`tests/unit/lib/accounting/event-key.test.ts`
- Docs: `docs/02_Requirements/requirements.md`（FREQ-569-AC-01 を設計 10章・11章のとおりに直す）、`docs/04_DetailDesign/pages/16_admin.md`（計上待ちの一覧の文）、`docs/05_Quality/tests/test-spec.md`

**Interfaces:**
- Consumes: なし（Task 1〜5 と独立。実装順は自由）。
- Produces: `reasonText(event: PendingEvent): string`（署名は同じ）。`order_not_postable` は常に `REASON_TEXT.order_not_postable` を返す。

- [ ] **Step 1: 失敗する試験を書く。**（設計 12-3 の単体の (1)〜(4)）
  - `FREQ-643-AC-14: dispute_refund_overlap と dispute_return_refund_pending の文が、設計 3-3 の文そのもの`。`REASON_TEXT` は export されていないので、`reasonText(pendingEvent({ reason: … }))` の戻りを `toBe` で比べる。`requested`・`accepted` は待つ、`error` はやり直し、`canceled` の決め待ちは区分を選ぶ、ほかの返品が未決は額を決める、が文に入ること。`REASON_SNIPPETS` の `dispute_refund_overlap: '成功した返金があります'`（`pending-view.test.tsx:111`）は新しい文に含まれないので、新しい文の一部に直す。
  - `FREQ-643-AC-14: order_not_postable の dispute_lost・return_closed_after_lost は専用の文を持たず、shipping と同じ文になる`、`ほかの理由の文は変わっていない`（`PENDING_REASONS` の全件を、2つ以外は直前の文のまま）。
  - 消す・直す: `FREQ-581-AC-05`（147行付近）の「手で仕訳を入れるよう伝える」期待を消す。`FREQ-569-AC-01`（443行付近）は `shipping` の行だけを残し、2つの理由の行と「主な文に回した補足を二重に出さない」を消す。`manual()`（537行付近）は `shipping`（または `units_sum`）の行を作る形に直す。
  - `FREQ-643-AC-09: buildEventKey('dispute_event', ['closefix', dp, '1']) と parseEventKey の往復が同じ3つの部品になる`（`event-key.test.ts`。実装を足さずに通る見込みで、通っても正〔設計 4-2: 直す所は無い〕）。
- [ ] **Step 2: 失敗を確かめる。** Run: `npx.cmd jest tests/unit/components/cost-profit/pending-view.test.tsx tests/unit/lib/accounting/event-key.test.ts`。Expected: 文の試験は FAIL（文が古い・専用の文が残る）。
- [ ] **Step 3: `pending-view.tsx` を直す。** `REASON_TEXT.dispute_refund_overlap`・`dispute_return_refund_pending` を設計 3-3 の文字列に置き換える（一字も変えない）。`ORDER_NOT_POSTABLE_MANUAL_TEXT` の定義と、`reasonText` の `order_not_postable` の枝の `manual` の読みを消し、`REASON_TEXT.order_not_postable` を返す。判定・route・型は変えない。
- [ ] **Step 4: 通ることを確かめる。** Run: 上と同じ + `npx.cmd tsc --noEmit --incremental false`。Expected: PASS・型エラーなし。
- [ ] **Step 5: 文書と commit。** `npm.cmd run validate-docs`。
  ```bash
  git commit -m "feat(accounting): 計上待ちの2つの理由の文を直し手で入れる案内を消す（FREQ-643）"
  ```

---

### Task 7: E2E（FR-ADMIN-169）

**Files:**
- Create: `e2e/FR-ADMIN-169-pending-auto-posting.spec.ts`
- Modify: `e2e/accounting-test-utils.ts`（返金を成功させる部品と、その返金の Stripe の取引を作る部品を足す。今ある `seedDispute`・`addDisputeHistory`・`receiveReturn`・`refundReturn`・`runPosting`〔:356-380 の範囲〕には無い）、`docs/05_Quality/tests/test-spec.md`
- Read: `e2e/FR-ADMIN-132-accounting-order-journals.spec.ts`（作りの手本）

**Interfaces:**
- Consumes: Task 1〜6。
- Produces: なし。

- [ ] **Step 1: 場面を円で決める（w>0 になる場面）。** 注文20,000円（品A・品B 各10,000）。返品 A・B が届く。引かれた額 5,000 で負け（C: pay=5,000、2130 は 15,000）。返品 B を返金ありで決め、返金（10,000）は `requested`（返金を作った日は D 以前）。返品 A を0円で終える（c=10,000）。
  - 期待: A の決定は途中の返金（B の返金は何も待っていない普通の返金なので外れない）で `dispute_refund_overlap` で待つ。返金が成功し成功の仕訳が入ると、P(D) = P(今) = 5,000、w = 5,000 で A の決定が入る（借 2130 5,000／貸 4020 5,000）。
  - 「もう一度計上する」（`POST posting/run`）は **2回押す**: 1回目で返金の計上係が返金の成功を入れ（実行の順は 返品 → 返金 → 取り消しで、待っていた決定はその回の返品の計上係で評価済み）、2回目で決定が入る。`has_more` は `posted + parked_new >= limit` の時だけ真なので（`src/lib/accounting/posting-runner.ts:33-44`）、1回押した後に行が残ることも確かめてよい。場面が DB で期待どおりでない時は実装前に DB 試験（Task 2 の (h) 組2 の変形）で先に確かめる。
- [ ] **Step 2: 試験を書く。** mobile 390・tablet 768・desktop 1280 の3幅で `FREQ-643-AC-13`: (1) 上の場面を `accounting-test-utils.ts` の部品で作る。(2) 計上待ちの一覧に、`dispute_refund_overlap` の行が設計 3-3 の文で出て、ボタンが無く「仕訳が入るまで閉じられません」と出る。(3) 返金を成功させ「もう一度計上する」を2回押すと行が一覧から消える。(4) 仕訳帳に、注文つきの自動の仕訳（返品の額の決定の見出し）が出る。(5) 3幅で横スクロールが出ない（`scrollWidth <= clientWidth`）。額は検証しない。
- [ ] **Step 3: 本番ビルドで流す。** controller が3000番を空け、手元の Supabase を調整した後に流す。Run: `npx.cmd playwright test e2e/FR-ADMIN-169 --retries=0`。Expected: 3幅とも PASS。失敗は `.claude/CLAUDE.md` の切り分けの順で扱う。
- [ ] **Step 4: test-spec を更新し commit。** `git commit -m "test(accounting): 自動計上の一覧と仕訳帳の E2E を3幅で足す（FREQ-643）"`

---

### Task 8（controller）: 全体検証・最終レビュー・本番を読む・適用の許可・記録

**Files:**
- Create（`.superpowers/sdd/2026-11-15-accounting-pending-manual-entry/`）: `verification-report.md`、`final-review.md`、`production-pre-read.md`、`report-to-owner.md`
- Modify: `docs/06_Operations/db-migrations.md`・`accounting-p3-returns-refunds.md`（本番の適用結果）、作業と指摘の台帳 `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（I1 の状態）、この計画のチェックボックス

- [ ] **Step 1: 手元で全部通す。** `db reset` の後に、S0〜S27 と計画1・2・3・G・H の DB 試験、PostgREST を使う既存の試験（`LOCAL_SUPABASE_*` が要る物。この計画は新しい断りが無いので足さない）、コミットする試験の3連続を流す。`npx.cmd jest tests/unit --runInBand`・`npx.cmd tsc --noEmit --incremental false`・`npm.cmd run lint`・`npm.cmd run validate-docs`・`npm.cmd run validate-trace`・`npm.cmd run test:trace-coverage`。作り直した3関数の既存の試験が、意図して直した所以外は無改造で通ることを `verification-report.md` に書く。
- [ ] **Step 2: 本番ビルドで E2E 全件を流し、基準と比べる。** 3000番を止めてから `npm.cmd run build` → `npx.cmd playwright test --retries=0` → `npm.cmd run e2e:compare`。前回の全件の結果（`.superpowers/sdd/2026-11-07-test-ng/e2e-full4.json`）と比べ、新しい失敗は単独で再実行して揺れか実装かを切り分ける。計画3以外の既存の赤は直さない。
- [ ] **Step 3: 最終レビュー（Opus、エフォート high）。** 設計・この計画・Review Focus の5行・3関数と新しい関数の差分（囲みの外が変わっていないこと）・円の例 (a)〜(j) の試験の対応を渡す。重大・中を直したら、影響する DB・E2E を流し直す。
- [ ] **Step 4: 本番を先に読む（数だけ。書かない）。** controller が Supabase MCP の読み取りで、次の数だけを数える。`production-pre-read.md` に数だけ書き、金額・中身・相手は書かない。
  - 前の移行がそろっていること（`list_migrations` に `20261115100000` までがあり、`20261116000000` 以降が無い）。
  - 5-2 の件数: 閉じた `dispute_lost`／`return_closed_after_lost` の行（0であること）と、開いた行（記録するだけ）。
  - `accounting_journal_entries`・`accounting_pending_events`・`order_refunds`・`order_returns` の件数（0または想定どおり）。
  - 手元のファイルのバイト数・MD5・ASCII・1組の取引・末尾の確かめがあること。
  想定と違えば適用せず、理由とともにオーナーへ示す。本番の Stripe には触らない。
- [ ] **Step 5: オーナーへ適用の許可を尋ねる。** `report-to-owner.md` に、作ったもの・円の例の結果・実測できたものとできないもの・本番の数・税理士に確かめること（設計 13章）・未確認事項を書き、「S27 を適用してよいか」を尋ねる。本番に入るのは私用の関数2つの追加と3関数の作り直しだけ（設計 5-1 は作り直す関数3つと書く。私用の関数2つは設計に無い追加として `report-to-owner.md` に1行書く）で、仕訳・返金・返品の行は増えない（本番の注文は0件）。無回答を承認としない。
- [ ] **Step 6: 許可の範囲だけ適用し、読むだけで確かめる。** `db push --linked --include-all --dry-run` で当たる移行が S27 の1本だけと確かめ、当てる直前に Step 4 の数を読み直してから `db push --linked --include-all` で当てる（自動の許可の判定で止まる時は、回り道せずオーナーに尋ねて許可を得る）。`list_migrations` の名前がファイルと一致することと、適用した文の `md5(statements[1])` がファイルと一致することを読む。作り直した3関数と新しい関数2つの本文の md5 が手元の期待と同じこと、新しい関数2つの ACL に anon・authenticated・service_role が無いこと、理由の CHECK が20個のこと、G の書き手の一覧が77本のままのことを読む。**本番に書いて確かめることはしない**（仕訳は消せないため）。失敗は固定の SQLSTATE・DETAIL を記録して止め、戻しを即興で流さない。
- [ ] **Step 7: 記録をコミットする。** 台帳・運用の文書・計画のチェックボックスを更新し、記録のファイルだけを名前で足してコミットする（`.superpowers/` の未追跡の物をまとめて足さない）。push はオーナーの指示があるまでしない。`graphify update .` は流さない。

---

## 設計の各節と Task の対応

| 設計 | Task |
| --- | --- |
| 3-2 式、4-1、(a)(b)(c)(g)(h)、AC-01・02 | 2 |
| 3-3 待ち（途中の返金・外す例外・ほかの返品が未決）、AC-03 | 1（関数）、2（`dispute_lost` の側。外す）、3（C の側。外さない） |
| 3-5 日の鍵、AC-05 | 2・3 |
| 3-6 `accounting_refund_wait`、(j)、AC-06 | 1（作り直し）、2（互いの待ちの試験） |
| 4-2 C と直し、(d)(d2)(e)(f)(i)、AC-04・09 | 3 |
| 4-3 入れた後の確かめ、AC-08 | 2・3 |
| 5-1〜5-3 S27、AC-12 | 1（骨組み・前の確かめ・関数）、4（末尾の確かめ・改ざん） |
| 6章 読みへの効き（2つ目の取り消しを含む）、AC-07 | 3 |
| 9章・12-3 の文と単体、AC-14 | 6 |
| AC-10・AC-11 | 5（AC-11 の DB 試験側は Task 5） |
| AC-13 | 7 |
| 11章・12-4 の docs | 1（FREQ-643）、2・3（状態・流れ・手順書・FREQ-581-AC-05）、4（FREQ-569-AC-07・運用・構成）、6（FREQ-569-AC-01・16_admin） |
| 13章・15章の税理士・オーナーの確かめ | 8（`report-to-owner.md`） |

## セルフレビュー

- 設計の網羅: S27（3関数の作り直し・前の確かめ・末尾の確かめ・改ざん）、円の例 (a)〜(j)（Task 2 に (a)(b)(c)(g)(h)(j)、Task 3 に (d)(d2)(e)(f)(i)）、D11 の外す例外（Task 1 の関数の `excluded` と Task 2。C の側は外さない）、同時（Task 5）、文言2つと `ORDER_NOT_POSTABLE_MANUAL_TEXT` の削除（Task 6）、12-3 の単体、FREQ-643・FR-ADMIN-169（Task 1・7）、12-4 の docs（Task 1〜8）を持つ。
- 塊の数: 返品の計上係 足す1・置き換え0、取り消しの計上係 足す3・置き換え4、`accounting_refund_wait` 足す0・置き換え1。Task 2・3・4 と「S27 の塊の数」の表で同じ。
- 食い違いの確認: 関数名・署名・行は 2026-11-15 に S20・S22・S24・S26 のファイルで確かめた。S23〜S26 は `accounting_post_return_events`・`accounting_post_dispute_events` を作り直しておらず、`accounting_refund_wait` は S20 だけが定義し S26 は呼ぶだけ。`accounting_dispute_offset_ready` の最新は S24。
- 設計に書かれていない作業（controller に報告済み）: (1) `accounting_p3_dispute_offset` の旧「止める」の期待3か所と `accounting_p3_pending_manual_close:165-205` の書き直し、(2) S22 の末尾の確かめの再生の前に S22 の2関数を元の本文へ戻す部品（S20 の再生は不要）、(3) 私用の関数2つ（途中の返金・R の式。controller の裁定）。
