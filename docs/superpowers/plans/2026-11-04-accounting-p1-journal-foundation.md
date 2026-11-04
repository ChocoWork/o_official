# 会計の作り直し 計画1「仕訳の土台と期間」実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保存する仕訳の表（見出し・行）、勘定の一覧、会計の期間、期首の残高、設定を DB に作り、仕訳を入れる関数を1つに絞る。今の画面の数え方（注文を作った年で絞る形）を、保存した仕訳を期間で数える形に変える。本番に手で入れた経費18件・領収書8件・直しの履歴25件は新しい形へ移す（A8）。後の計画2〜7が使う権限・領収書の置き場・印の作り方・取り消しの道具を、ここで一度に用意する。

**Architecture:** 仕訳を入れる口は 中身だけの core 1つ（`private.accounting_post_journal_core`）と、権限を確かめる `private.admin_post_accounting_journal` ＋ service_role だけの public 入口（3段）。見出しと行は同じトランザクションで入り、遅らせて確かめる制約トリガーが「借方合計＝貸方合計」「額は正の整数」「1行は借方か貸方の片方」を守る。保存した仕訳は UPDATE・DELETE・TRUNCATE を DB が断る。印は出来事の種類＋元の番号の組を一意制約にし、取り消しは元1本につき1回だけ。期間は始まり・終わり・事業の形を持ち、重なり・すき間・1年超を DB が断る。期首の残高は「同じ事業の形の前の期間」からだけ計算する。手入力の取引は既存の表への書き込みに DB トリガーをぶら下げて仕訳にする（route の書き込みの形を変えない）。注文・Stripe の仕訳はこの計画では保存せず、今の画面での合成を残して期間で絞るだけにする（保存は計画2）。12146 行の画面は、動きを変えずにサブタブごとのファイルに分けてから触る。

**Tech Stack:** 現行の Next.js `^16.3.6`、React `^19.0.0`、TypeScript `^5`、Supabase Postgres 17・PostgREST、Zod `^4.3.6`、`pg`、Jest、React Testing Library、Playwright。依存を増やさない。

**Spec:** [承認済みの設計](../specs/2026-11-03-accounting-redesign-design.md)の A1〜A13、0章、1章（1-a〜1-e と 1-a01〜1-a22）、3章、7章、11章、2章の 2-j、12章の 12-c・12-i、16章を正本とする。[今の作りの地図](../../../.superpowers/sdd/2026-11-04-accounting-redesign/recon-report.md)と `recon-part-A.md`〜`recon-part-D.md` は現状と file:line の手掛かり。形式は [H の計画](2026-10-29-group-h-promotions.md)と [G-4 の計画](2026-10-26-group-g4-orders.md)を引き継ぐ。設計で決まったことは変えない。決められない所は末尾「未確認事項」に置く。

## 概要

確認日 2026-11-04、基準 `master / c87c6bf0`。この文書を書く作業は計画だけで、実装・DB・provider・ブラウザーの成功を表さない。

### 7本の計画の地図

設計の全体を7本に分けて順に作る。計画2〜7は後で別に書く。計画1は、後の計画が使う物を Interfaces に正確に書き、後の計画の中身は書かない。

| # | ファイル | 範囲（設計の章） | 前の計画から使う物 |
| --- | --- | --- | --- |
| 1 | `2026-11-04-accounting-p1-journal-foundation.md`（この文書） | 1・3・7・11章、2-j の移しかえ（A8）、下の「前倒しする物」6つ | なし |
| 2 | `…-p2-deferred-revenue-stripe.md` | 2・4・6・8章（KPI を含む。カード会社からの支払いの取り消しの表と Webhook も。月の KPI の表 `admin_kpi_monthly_records` は移行にも本番にも無いと 2026-11-04 に本番で確かめたので、ここで扱う） | 1 |
| 3 | `…-p3-returns-refunds.md` | 5章（返品・返金の状態の履歴の表を含む。返金・返品の SQL 関数の手入れはこの計画だけが行う） | 1・2 |
| 4 | `…-p4-return-terms-display.md` | 14章（14-f は決済の DB 関数に入るので、別セッションに先に知らせる） | 1・3 |
| 5 | `…-p5-inventory-cost.md` | 9・13章（法人の寄附金の勘定と、損金の上限と申告書での調整が要る印〔7-k〕は、13-g2 の時価で使うこの計画で足す。既存の 6320 寄附金は事業の形を問わない手入力用のまま） | 1・2・3 |
| 6 | `…-p6-closing-records.md` | 10・12章（書き出しの共通の層を作る）。法人の定率法（11-f の既定。償却率は「減価償却資産の耐用年数等に関する省令」の別表の値で、作る時に原文で確かめる）、3-d の「申告の期限を過ぎた期間へは自動で入れず一覧に止める」仕組み、中間申告の要否の判定（前の期の税額が入ってから）もここ | 1〜5 |
| 7 | `…-p7-freee-mf-copy.md` | 15章 | 1・6 |

**前倒しする物（調べで、後の計画どうしが同じ所を書き換えると分かったため、計画1がやる）:** (1) 画面を分ける（Task 1）、(2) 7本が使う権限を一度に足す（Task 2）、(3) 領収書の置き場のバケットと証憑の種類の列（Task 3）、(4) 会計の表の権限の締め直し（Task 3）、(5) 重ならない印の作り方を TS と SQL の両方に作る（Task 4・6）、(6) 取り消しの仕訳の共通の道具（Task 6）。

| Task | 中身 | 移行 | FREQ | 検証 |
| --- | --- | --- | --- | --- |
| 1 | 画面を分ける（動きは変えない）・CSV の関数を共通のファイルへ | — | 558 | 単体/RTL/E2E 回帰 |
| 2 | 権限6件を3か所の一覧と上限に一度に足す（32→38） | S0 permissions | 553 | DB/単体 |
| 3 | admin_finance_* の表の権限の締め直し・`finance-receipts` バケット・証憑の種類の列 | S1 grants_receipts | 553・559 | DB/単体 |
| 4 | 勘定の追加・印の作り方（TS）・仕訳の型 | — | 554 | 単体 |
| 5 | 期間・月ごとの区切り・申告の期限・開業日の期限（I/O なし） | — | 555・561 | 単体 |
| 6 | 仕訳の表・入れる関数・取り消しの道具・書き換え不可 | S2 journal_foundation | 554 | DB/並行 |
| 7 | 設定・期間・期首の残高・読み口 | S3 period_reads | 555 | DB |
| 8 | TS の store と route（期間・設定・仕訳の読み） | — | 555・561 | 単体 |
| 9 | 手入力の取引を仕訳にする（DB トリガー） | S4 manual_entry_journal | 556 | DB/単体 |
| 10 | 画面と読み口を期間で数える形にする | — | 557 | RTL/単体 |
| 11 | 設定・期間の画面と領収書の種類の選択 | — | 555・559・561 | RTL |
| 12 | 減価償却の月数を期間で数える | — | 557 | 単体 |
| 13 | A8 の移しかえ（手入力の経費18件・直しの履歴25件・領収書8件） | S5 a8_migrate_manual | 560 | DB |
| 14 | 新しい E2E | — | 553〜561 | 本番 build/手元 DB |
| 15 | 文書の正本の更新 | — | 全部 | validate-docs |
| 16（controller） | 全体検証・最終 Opus レビュー・本番を読む・適用・記録 | — | 全部 | baseline 比較 |

**決めたこと（この計画の細部。設計の決定は変えない）**

- 移行は6本。`supabase/migrations/<ts0>_accounting_p1_permissions.sql`（S0）、`<ts1>_accounting_p1_grants_receipts.sql`（S1）、`<ts2>_accounting_p1_journal_foundation.sql`（S2）、`<ts3>_accounting_p1_period_reads.sql`（S3）、`<ts4>_accounting_p1_manual_entry_journal.sql`（S4）、`<ts5>_accounting_p1_a8_migrate_manual.sql`（S5）。時刻は `20261101120000` の後に controller が実装時に採番し、S0→S5 の順にする。適用済みの移行は編集しない。S5 だけが既存データの移しかえ（DML）で、S0〜S4 は新しい表・関数・権限のほかデータを変えない（S0 の権限の登録と店長の版の更新、S1 の既存表の列の追加を除く。後の Global Constraints に正確に書く）。
- 仕訳を入れる口は `private.accounting_post_journal_core` 1つだけ。手入力のトリガー・A8・取り消しの core（`accounting_reverse_journal_core`）・後の計画の private 関数はすべてここを通す。直接 INSERT は service_role にも許さない。
- 手入力の取引は、既存の表 `admin_finance_expenses` を入力の表のまま残し、AFTER INSERT/UPDATE のトリガーで仕訳を作る（9章 Task 9）。route の書き込みの形（service_role から表へ直接書く）は変えない。これは「仕訳を入れる DB の関数は1つだけ」を保ったまま、route 1600 行の書き換えを避ける私の判断（オーナーが覆せる）。
- 注文・Stripe の仕訳は計画1では保存しない。画面は今の合成（`toOrderSalesTransaction`・`buildStripeJournal`）を残し、期間の範囲で絞って、保存した仕訳と合わせる。合成した仕訳の `sourceKey` は今の形（`stripe:sale:<order.id>` など）のまま保存しない。計画2が保存を始める時に、`payment_confirmed:<payment_intent>` など新しい印へ置き換え、合成を外す（今の印との違いは recon-part-C の C-7）。
- 期首の残高は計算で出す。前の期間を締めていない時（計画1の間は常にこちら）は、前の期間の仕訳を全部足して 3-d・3-e の式で出す。締めた版の期末から取る道（3-c）は計画6が `accounting_opening_balances` へ行を足して使う。DB が事業の形の違う期間から写す道を断つ。
- 開業日は設定に1度だけ入れられ、選び直せない（11-k）。日付は計画に書かず、オーナーが管理画面の設定で入れる値とする（未入力の間は NULL）。開業の届けの期限は、開業した日に適用される法令で出し分ける（11-k2）。令和5年法律第3号 附則1条6号・10条により、新しい所得税法229条（開業した年分の確定申告の期限まで）は 2026-01-01 以後に生じた事実から当たり、それより前の事実は前の条文（事実があった日から1か月以内）のまま。法律の版は表 `STARTUP_NOTICE_RULES` に持つ。2025年の開業は1か月以内の方になる。
- 法人の定率法（11-f の既定）は計画6（締め）で作る（地図）。償却率・保証率・改定償却率は「減価償却資産の耐用年数等に関する省令」の別表の値で、作る時に原文で確かめる。計画1は月数の割り振り（11-f ①②・11-f2）と定額法まで。
- 中間申告（11-h）は、第1期は前の期が無いので「不要」と期限を出す。第2期以後は前の期の税額が入るまで「判定できない」と出し、判定そのものは計画6以後。
- 一覧にある勘定は `accounting_accounts` に符号（ASCII）だけ持ち、名前は TS の `ACCOUNTS` が正本とする。SQL は ASCII のため、日本語の文字列は `U&'\XXXX'` 形で書く。移行に埋める表は `scripts/accounting/` の生成スクリプトで作り、試験が TS と一致を確かめる。
- 2-j は A11 に合わせて直された設計（4d11cb57）に従う。経費18件は元の取引の日の年分のまま移す（2025年の日付は申告済みの2025年分、2026年の日付は2026年分のふつうの経費）。開業費（1810）は使わない。棚卸資産・固定資産へ分ける物は、移した後に 1-c の取り消しと正しい仕訳で直す。移す前に税理士の確認を待たない。
- S4 と S5 は同じ時に一緒に当てる。S5 だけ見送る道は作らない。理由: 移しかえの前に税理士を待たないため。S4 だけが先に当たると、画面が保存した仕訳だけで手入力の分を数えるので本番の18件が帳簿から消え、移しかえ前の取引を直すと今の日時で仕訳ができ「元の登録の日時・移した印」が付かず、新しい取引が先に通し番号を取って S5 の番号の順が崩れる。
- 事業の形と期間の決め方: 取引の日を含む期間を探す。個人と法人の両方があれば `accounting_settings.current_business_type` の期間を使う。`admin_finance_years.business_type` は使わない（1年の途中の切り替えを表せないため）。`current_business_type` はこの選び方と、設定画面の既定の事業の形にだけ効く。
- 個人の期間を自動で作れる年は、開業日の年（未入力なら 2025）から今の日本時間の年+1 まで。外は `ACCOUNTING_ARGUMENT_INVALID` で断る（日付の打ち間違いで消せない期間を大量に作らないため）。
- 申告の期限を過ぎた期間（3-d）: 画面からの手入力・直しは店主の操作そのものなので通し、期限を過ぎた期間に入る時に画面で知らせる。A8 の移しかえは Task 16 のオーナーの承認をもって「確かめた」とする。「一覧に止める」仕組みは計画6。前の期間を締めていない間は「数字はまだ動く」を出す。
- 期間の重なり・すき間は拡張（btree_gist）を使わず、遅延 constraint trigger で見る（設計は拡張を求めていない）。
- 仕訳の説明は手入力の `item_name`（DB で1〜160字、route の zod も `max(160)`）なので、DB の 500 字の上限に届かない。
- KPI の route 4つは全部 `authz.role !== 'admin'` で 403 を返す（`kpi/route.ts:299`、`targets/route.ts:221`、`monthly-record/route.ts:39`、`migration-status/route.ts:17`）ので、サポーターは API からも読めない。新しい KPI の権限は足さない。
- 祝日の表は公表済みの年まで。表の無い年の期限は GET を落とさず、画面に「祝日の表がまだ無いので、休みの日の繰り下げを確かめられません」と出す。年の追加の手順は運用の文書に書く。
- 消費税の期限は、期間の設定に持つ課税事業者か免税事業者か（設計 5-j）と、年の途中のインボイスの登録に備えた「課税事業者になった日」（15-c2）で出す。期限は課税の期間だけに出す。今の期間は全部免税なので画面には出ない（「課税事業者になったら出します」）。
- 1920 資産譲渡損は `owner_draw`（区分が事業主貸の勘定は 1910 と 1920。期首は0）にする（設計 3-e・3-f）。今の `year-end.ts` が 1910 だけを0にしているのはコードの漏れで、計画1の Task 10 で直す。オーナーへ報告する（下の「オーナーへの報告」）。

## Global Constraints

- 今回の成果物はこの計画1ファイルだけ。実装は後日 master で行い、実装者はコミットせず controller が各 Task の Files だけを確認して記載のメッセージでコミットする。既存差分 `.claude/CLAUDE.md`・`package.json`・`.superpowers/` を保持し、ブランチ/worktree・push を作らない。
- 各移行の最初の行は `BEGIN;`、最後は末尾 assert → `NOTIFY pgrst, 'reload schema';` → `COMMIT;` の1組だけ。UTF-8/BOM なし/LF。SQL のコメントと文字列も ASCII（日本語は `U&'\XXXX'`）。移行実行時の DML は、S0 の `permissions` 登録・店長への `role_permissions` 追加・店長の `permissions_version + 1`、S2・S3 の初期行（勘定の一覧・設定の1行）、S4 の勘定の対応表の行、S5 の移しかえだけ。S1 は既存表の GRANT/REVOKE と `admin_finance_receipts` の列の追加と `storage.buckets` の upsert だけ。ほかの既存データの清掃・補完はしない。
- 新しい本体は private・所有者 postgres・`SECURITY DEFINER SET search_path = ''`・完全修飾名、public 入口は同名同引数同戻り型の `LANGUAGE sql SECURITY INVOKER`・service_role のみ EXECUTE。入口の無い内部 helper は service_role からも REVOKE。private schema の USAGE を一括変更しない。読み口は `STABLE`。
- 新しい表は `public`、RLS 有効、所有者 postgres、PUBLIC/anon/authenticated に権限なし。service_role は SELECT のみ（書き込みは private 関数）。アクター列（`recorded_by` など）は外部キーにしない（利用者の削除で履歴を壊さないため）。
- 全移行に `-- ACC_S0_FINAL_ASSERT_BEGIN/END`（S1〜S5 は数字だけ変更）の塊を置き、失敗は `ACCOUNTING_MIGRATION_ASSERTION_FAILED / 55000`、DETAIL はこの計画の固定コードだけ。表/列/CHECK/FK/索引/RLS/所有者/ACL/関数属性/余分な overload を意味で検査する。`BEGIN;`/`COMMIT;` は1つの移行に1組。
- 業務書込のロック順は、関数ごとに同じ: ①G 共通 `pg_advisory_xact_lock(190521,1)` → ②会計の鍵 `(190524,0)` → ③期間ごとの鍵 `(190524, hashtext(period_id::text))` → ④元の行。次の関数は最初に ①②③ をこの順で自分で取る（`private.accounting_lock_all(_period_id uuid DEFAULT NULL) RETURNS void` が1つにまとめる）: `accounting_post_journal_core`、`accounting_reverse_journal_core`、`admin_create_accounting_period`、`admin_update_accounting_settings`、`admin_update_accounting_period_filing`、`accounting_ensure_individual_periods`、`accounting_store_opening`、A8（S5）。例外は手入力のトリガー: `admin_finance_expenses` の行を書いた後（④を持った後）に動くので、トリガーの中で ①②③ を取る。そのため、**G の鍵を持つ処理（G・H の注文/在庫/返金の関数）は `admin_finance_expenses` の行を書かない**ことを `pg_locks` と関数のソースの検索で固定する試験を Task 9 に置く（`FREQ-556-AC-04`）。G・H のロックの先後を壊さない。
- route は 認可 → CSRF（`requireCsrfOrDeny`、`@/lib/csrfMiddleware`）→ 回数の制限（`enforceRateLimit`、IP は `src/lib/request-ip.ts` の `getClientIp` だけ、actor は別に数える）→ zod → DB 関数 → 監査（`logAudit`。名前・メール・金額の明細を入れない）。管理の読み取りは成功/失敗とも `Cache-Control: no-store`（`NO_STORE_CACHE_CONTROL`、`@/lib/http/no-store`）。画面のコードは ok でない応答の本文を読み切るか `response.body?.cancel()` を await する。
- DB 結合の試験の道具は、波5 で入った物を使う。`tests/integration/db/helpers/app-session.ts` の `createLiveAppSession`・`jwtClaims`（RLS とクレームの回帰だけ）、`admin-table-grants.ts` の `adminTableTools(db)`（`failureAs`・`rowsAs`・`privileges`・`WRITE_PRIVILEGES`）、`local-db.ts` の `describeLocalDb`・`PgClient`、`group-h-fixtures.ts` の作り方。service_role＋actor の DB 試験は JWT/session を作らず役割だけ検査する。route/E2E の aal2/live-session は `e2e/admin-session-test-utils.ts` の `createAdminSessionActor` を使う。
- 遅らせて確かめる制約（借貸・期間の重なり/すき間）は、COMMIT か `SET CONSTRAINTS ALL IMMEDIATE` まで動かない。DB 結合の試験は基本 `BEGIN` → 実行 → `SET CONSTRAINTS ALL IMMEDIATE` → 確かめ → `ROLLBACK` とする（`describeLocalDb` の接続は自動の ROLLBACK を持たないので、試験が自分で包む）。決め打ちの日付（個人2026・法人の第1期 2027-07-01 など）を使うのは ROLLBACK の中の試験だけ。コミットが要る試験（並行の試験・A8 の移行の再生）と E2E は、仕訳と期間が消せない（DELETE を断る）ので、①通常の suite とは別の jest 実行で最後にまとめて流し、前後に `db reset` する、②その中の期間は `seedAccountingPeriod`（その事業の形の最後の期間の次に続く期間）で作る。本番の DB には試験の行を作らない。
- 会計の E2E 回帰の対象（1か所に並べる。Task 1・10・14 はここを指す）: `grep -l "kpi/cost-profit\|ACCOUNTING" e2e` の結果（`FR-ADMIN-024`〜`043`・`045`〜`047`・`049`・`FR-ADMIN-050-stripe-settlement`・`FR-HEADER-007`）に、`admin-accounting-test-utils.ts` を import する `FR-ADMIN-044` を足した物。実装の時に grep で取り直し、この一覧との差を報告する。
- 要件: 会計・KPI は `scripts/trace/scope.json` の範囲の外。新しい行は `docs/02_Requirements/requirements.md` の6列の表に足す。今回の新規番号は FREQ-553〜561（現在の最大は 552）。実装時に別セッションとの重なりを確かめる。試験の題名は `FREQ-NNN-AC-NN: …` で始める。E2E のファイルは `e2e/FR-ADMIN-128-…` から（現在の最大は 127）。
- E2E は production build と手元 Supabase、port3000、390/768/1280px、`x-real-ip` を試験ごとに分ける。3000番に残った E2E 用でないアプリは先に止める。dev サーバーで流した結果を合否に使わない。
- 共有の文書（台帳・`db-migrations.md`・`test-spec.md`・`docs/06_Operations/README.md`）を直す Task の最初の行に「controller が別セッションへ先に知らせる」と書く。`CostProfitSection.tsx`・`cost-profit/route.ts`・`src/lib/finance/**` を触る各 Task（Task 1・3・4・5・9・10・11・12）と、共有の文書を直す Task（Task 6・14・15・16）も、最初の行に同じ「controller が別セッションへ先に知らせる」を置き、最新差分を読んでから編集する。
- 実装者は単体/型/lint、controller は reset・DB 結合/並行・PostgREST・build/E2E・provider・本番を担当する。計画作成中は Playwright・サーバー・Supabase CLI・Docker・DB 試験・変更系 git・`.env*` の読取をしない。
- 実装コードの最終変更後、controller は commit 前に `graphify update .` を1回だけ完了させる。commit 後はフックの結果を確認するだけで、手動 update を重ねない。

**共通 verify（後日の controller 手順）:** 各 SQL Task は、未実装 DB に対する RED → 新移行を含む手元 DB reset → anon/authenticated の既存 `items` 読取 smoke が各 200 → 対象 DB suite → PostgREST で新 public 入口の service_role 成功/anon・authenticated 拒否、の順。秘密値は表示しない。変更した SQL は最後の本文で reset から再試験する。並行試験は `pg_blocking_pids`/`pg_locks` で待ちを観測し、固定 sleep を使わず3連続成功を記録する。

## Review Focus

- **仕訳は偏らず、重ならず、後から変わらない:** 借方と貸方の不一致・片側の行・0や負の額・同じ印の2本目・同じ元への2回目の取り消しを DB が断り、保存後の UPDATE/DELETE/TRUNCATE も断る。並行して同じ印を入れても1本だけ → Task 6 の `FREQ-554-AC-01`〜`AC-05`。
- **期間と期首が事業の形を越えない:** 期間の重なり・すき間・1年超を断り、個人の期首を法人の第1期へ写さず、法人の第1期は全勘定0、期首の元入金＝資産−負債 → Task 7 の `FREQ-555-AC-01`〜`AC-04`。
- **手入力が二重にならず、移しかえが履歴を増やさない:** 手入力の作成・更新・削除が仕訳1本ずつ（直しは取り消し＋正しい仕訳）になり、A8 の後も `admin_finance_entry_revisions` の行数が変わらず、移しかえ後に直しても残高が合う → Task 9 の `FREQ-556-AC-01`〜`AC-03`・Task 13 の `FREQ-560-AC-01`〜`AC-03`。
- **権限が7本ぶん一度にそろい、締めた表で今の処理が壊れない:** 6件の追加は店長だけ・38件で上限もそろい、`admin_finance_*` 12表と連番の anon/authenticated の権限が（SELECT も）全部消えても、作り物にしない本物の route を手元 DB で叩く cost-profit・receipt・product-costs の処理が動く → Task 2 の `FREQ-553-AC-01`・Task 3 の `FREQ-553-AC-02`〜`AC-04`・Task 14 の ADMIN-130。
- **画面の分割が動きを変えず、数え方が期間になる:** 分割の前後で既存の単体・E2E が同じ題で通り（作り物の応答には保存した仕訳を足す）、注文は日本時間の作った日で期間に入り年をまたいでも二重に数えない（出荷の期間は計画2）→ Task 1 の `FREQ-558-AC-01`・Task 10 の `FREQ-557-AC-01`〜`AC-03`。

---

## 設計の行から Task への対応

「計画N」は後の計画が作る物。

| 設計の行 | 作る Task | 固定する試験 |
| --- | --- | --- |
| A1・A2・A3・A4 | 土台は Task 6（写しは計画7、書き出しは計画6） | — |
| A6（法人の期間を画面で足す） | 5・7・8・11 | 555-AC-01〜04 |
| A8（手入力の移しかえ） | 13 | 560-AC-01〜03 |
| A10（紙は配送の領収書だけ・種類の列） | 3・11 | 559-AC-01〜03 |
| A11（開業日） | 5・7・8・11 | 561-AC-01〜03 |
| A5・A7・A9・A12・A13 | 計画2〜5 | — |
| 1-a（出来事ごとに作る）・1-b（1つの関数・遅らせて確かめる） | 6 | 554-AC-01〜02 |
| 1-c（取り消しと正しい仕訳）・1-d（印・取り消し1回） | 4・6・9 | 554-AC-03〜04、556-AC-01 |
| 1-e（日本時間の出来事の日） | 6（`entry_date` は date で受け、timestamptz は JST の日へ変えて渡す道具 `toJstDate` を Task 4 に置く） | 554-AC-05 |
| 1-a01〜1-a22（出来事の種類） | 4（種類と必要な番号の数を全部定義）。仕訳を作るのは 1-a19 の手入力が Task 9、移しかえが Task 13、ほかは計画2〜6 | 554-AC-03 |
| 3-a（保存した仕訳を期間で数える） | 7・10 | 555-AC-04、557-AC-01 |
| 3-b（期間は初日〜末日・会計と課税の期間を分ける） | 5・7 | 555-AC-01 |
| 3-c（期首は同じ事業の形だけ・法人第1期は0） | 7 | 555-AC-02〜03 |
| 3-d・3-e（未締めの繰越・期限を過ぎた期間の扱い） | 7（繰越の計算）・10（「数字はまだ動く」と期限超過の知らせ）。期限を過ぎた期間へ自動で入れず一覧に止める仕組みは計画6 | 555-AC-03、557-AC-05 |
| 3-f（期首の元入金＝資産−負債） | 7 | 555-AC-03 |
| 3-g（控除前の所得の一致）・3-g2・3-g3 | 3-g は Task 10 の読み口で一致を確かめる。3-g2 は締めた版を使う計画6。3-g3 は Task 7 | 555-AC-03、557-AC-02 |
| 3-h（受注高と帳簿を分ける） | 計画2 | — |
| 7-a・7-g・7-h | 4（名前と区分を変えない確かめ） | 554-AC-06 |
| 7-b（1160 Stripe 未収金）・7-e（4050 返品の手数料） | 4 | 554-AC-06 |
| 7-k（寄附金） | 計画5（13-g2 の時価で使う時に、勘定と損金の上限の印を足す） | — |
| 7-c・7-d・7-f（前受金・補助） | 4（補助の符号の一覧）。仕訳に使うのは計画2・3 | 554-AC-06 |
| 7-i・7-i2〜7-i5（入金の振り分け） | 計画2 | — |
| 11-a（期間・名前・仕訳は期間を持つ） | 6・7 | 555-AC-01 |
| 11-b（個人・事業をやめた年・所得税の年分と消費税の課税期間を分けて見せる） | 5・7・11 | 555-AC-01、561-AC-02 |
| 11-c・11-c2（法人の期間・1年超を断る・届出の案内・定額法を選ぶ届け出の期限の表示） | 5・7・11 | 555-AC-01、561-AC-02 |
| 11-d（重ならず、すき間なく） | 7 | 555-AC-01 |
| 11-e（直接書いた1月1日・12月31日をなくす） | 10・12 | 557-AC-03 |
| 11-e2（月ごとの区切り） | 5 | 555-AC-05 |
| 11-f・11-f2（月数の割り振り） | 12（定率法は計画6） | 557-AC-04 |
| 11-g（KPI は暦のまま） | 変えない（計画2） | — |
| 11-h（期限を画面に出す） | 5・11（第1期の中間申告は不要と出す。第2期以後は「判定できない」と出し、判定は計画6以後） | 561-AC-01〜02 |
| 11-i（課税期間の短縮は作らない） | 作らない。期間に消費税の課税期間の欄を持たない | — |
| 11-j・11-k・11-k2 | 7・8・11 | 561-AC-01〜03 |
| 2-j（手入力の移しかえの細部） | 13（日付は元の取引の日の年分・登録した日時・通し番号・直しの履歴の残し方）。開業費は使わず、分ける物は移した後に 1-c で直す。移す前に税理士を待たない | 560-AC-01〜03 |
| 12-c（削除をやめ取り消しで直す・書き換え不可） | 6・9（手入力）。注文・発送票・返金の書き換え止めとハッシュは計画6 | 554-AC-02、556-AC-01〜02・05・06 |
| 12-i（証憑の種類・紙の原本） | 3・11（領収書8件の種類の確認は controller の Task 16） | 559-AC-01〜03 |

---

## 要求と受入条件（`docs/02_Requirements/requirements.md` の6列の表へ足す文）

現在の最大は FREQ-552（同ファイル 1793 行）。下表の各行を「要求ID／要求内容／要件ID／要件内容／受入条件ID／受入条件内容」の6列へ展開する。要件 ID は `FREQ-NNN-REQ-01`、AC は同じ番号の `FREQ-NNN-AC-NN`。各 Task は、自分が証明する AC の行を同じコミットで足す（要求管理ルール）。Task 15 は全部そろっているかの確かめと体裁だけ。

| 要求 | REQ-01 の要件 | AC | 証明する Task |
| --- | --- | --- | --- |
| FREQ-553（会計の権限と表の権限を守る） | 6権限を SQL/TS の3か所と上限に足して38件にし店長だけへ付与する。admin_finance_* の12表と連番から anon・authenticated の表の権限を（SELECT も）全部外す | AC-01 38件・店長だけ・版+1／AC-02 12表と連番の anon/authenticated の権限が無い／AC-03 service_role の処理は通る／AC-04 authenticated の JWT では会計の表を読めず、本物の route は動く | 2・3・14 |
| FREQ-554（仕訳を後から変えずに保存する） | 仕訳は1つの関数で見出しと行を同時に入れ、借貸の一致・正の整数・片側を DB が守り、印と取り消しは1回だけ、保存後は書き換えない | AC-01 不一致・片側・0・負・小数を断る／AC-02 UPDATE/DELETE/TRUNCATE を断る／AC-03 同じ印は1本だけ（並行も）／AC-04 取り消しは元1本につき1回（同じ内容の再送は前の結果、違う内容は ALREADY_REVERSED）／AC-05 日は日本時間／AC-06 勘定の一覧が TS と一致／AC-07 会計の表の権限（anon/authenticated なし、service_role は SELECT のみ）／AC-08 仕訳の日が期間の外を断る／AC-09 通し番号・登録日時・遅れの印は関数だけが決める | 4・6 |
| FREQ-555（会計の期間と期首の残高を持つ） | 期間は始まり・終わり・事業の形・名前を持ち、重なり・すき間・1年超を断る。期首は同じ事業の形の前の期間から計算し、法人の第1期は0 | AC-01 作成の拒否と受理／AC-02 事業の形が違うと写さない／AC-03 期首の元入金＝資産−負債と法人第1期0／AC-04 期間で数える読み口／AC-05 月ごとの区切りが合計に合う／AC-06 設定の版の衝突と期首の版の選び方（個人は最新、法人は版1） | 5・7・8・11・14 |
| FREQ-556（手入力の取引を仕訳に残す） | 手入力の作成・更新・削除が仕訳になり、直しは取り消しと正しい仕訳を足す。取引の行の DELETE と直しの履歴の書き換えは DB が断る | AC-01 作成・更新・削除の仕訳／AC-02 期間が無い日の扱い／AC-03 未登録の科目は9999／AC-04 G の鍵を持つ処理が手入力の行を書かない／AC-05 取引の行の DELETE と、直しの履歴の（changed_by を NULL に変える1つを除く）UPDATE/DELETE を断る／AC-06 履歴を持つ利用者を消せる（changed_by だけが NULL になる） | 9 |
| FREQ-557（保存した仕訳を期間で数える） | 帳簿・決算書は保存した仕訳を期間で数え、注文を作った年で絞らない。直接書いた1月1日・12月31日をなくす | AC-01 注文は日本時間の作った日で期間に入り二重に数えない（出荷の期間は計画2）／AC-02 控除前の所得が損益と貸借で一致／AC-03 期間の端が1月・12月でも動く／AC-04 減価償却の月数／AC-05 前の期間を締めていない間は数字がまだ動くと出し、期限を過ぎた期間への入力に知らせる | 10・12 |
| FREQ-558（画面の分割で動きを変えない） | 画面をサブタブごとのファイルに分け、CSV の関数を共通のファイルへ移す | AC-01 既存の単体・E2E が同じ題で通る | 1 |
| FREQ-559（領収書の置き場と種類を持つ） | `finance-receipts` バケットを移行で作り、証憑に種類（電子／紙／未確認）を持たせる | AC-01 バケットは非公開・上限・形式／AC-02 種類の列と検査／AC-03 画面で種類を選べる | 3・11 |
| FREQ-560（手入力の取引を新しい形へ移す） | 本番の手入力の取引を元の日付で仕訳に移し、直しの履歴を二重に作らない | AC-01 件数と日付と通し番号／AC-02 履歴の行数が変わらない／AC-03 移した後に直せる | 13 |
| FREQ-561（設定と申告の期限を出す） | 開業日を1度だけ入れられ、期間ごとの申告の期限を休みの日の繰り下げ付きで画面に出す | AC-01 期限の計算／AC-02 画面の表示と届出の案内／AC-03 開業日の選び直しを断る／AC-04 監査に名前・金額・開業日の値を入れない | 5・8・11・14 |

## 共通の型・値・拒否

Task 4・5 が定義し、以降は同じ名前を使う。UUID は検証済みの `string`、日付は `YYYY-MM-DD`、金額は円の安全整数。

| 型/定数 | 正確な契約 |
| --- | --- |
| `AccountingEventKind` | `src/lib/accounting/event-kinds.ts` の `ACCOUNTING_EVENT_KINDS`（下の表の27種）。`readonly` の文字列の組 |
| `EventKeyParts` | `readonly string[]`。各要素は `^[A-Za-z0-9_.-]{1,128}$`（`:` を含まない）。個数は種類ごとの `arity` と一致 |
| `AccountingEventKey` | `` `${string}:${string}` ``。`buildEventKey(kind, parts)` が作る。前置きは `EVENT_KEY_PREFIX[kind]`（種類の名前）。ただし `stripe_fee` だけ設計 1-a10 の形 `stripe:fee:<記録の番号>` にそろえる（印の形は設計の 1-a の一覧にそろえ、違う所を作らない）。SQL の `private.accounting_event_key(_kind,_parts)` と同じ文字列 |
| `AccountingPeriod` | `{id:string;businessType:'soleProprietor'\|'corporation';name:string;startsOn:string;endsOn:string;corporateTaxExtensionMonths:0\|1;consumptionTaxExtensionMonths:0\|1;consumptionTaxStatus:'exempt'\|'taxable';consumptionTaxableFrom:string\|null;version:string}`。`version` は bigint の10進文字列 |
| `AccountingSettings` | `{businessStartDate:string\|null;cutoverOn:string;currentBusinessType:'soleProprietor'\|'corporation';version:string}` |
| `SavedJournalLine` | `{lineNo:number;accountCode:string;debit:number;credit:number;subAccount:string\|null;counterparty:string\|null;orderId:string\|null;memo:string\|null}` |
| `SavedJournalEntry` | `{id:string;periodId:string;entryNo:number;entryDate:string;eventKind:AccountingEventKind;dedupeKey:string;description:string;recordedAt:string;recordedBy:string\|null;isLate:boolean;reversesEntryId:string\|null;reason:string\|null;sourceTable:string\|null;sourceId:string\|null;migratedFrom:string\|null;migratedAt:string\|null;lines:readonly SavedJournalLine[]}` |
| `OpeningBalanceRow` | `{accountCode:string;signedAmount:number;basis:'stored'\|'carryover'\|'none'}`。`signedAmount` は借方−貸方 |
| `PeriodMonthSlice` | `{key:string;startsOn:string;endsOn:string;partial:boolean}`（11-e2。`key` は `YYYY-MM`） |
| `FilingDeadline` | `{tax:'income_tax'\|'consumption_tax_individual'\|'corporate_tax'\|'consumption_tax_corporate'\|'local_tax';baseDue:string;due:string;rolled:boolean;extended:boolean;holidayTableMissing:boolean;note:string}`。別に `InterimFiling = {tax:'corporate_tax'\|'consumption_tax_corporate';required:boolean\|null;reason:'first_term'\|'prior_tax_unknown';dueOn:string\|null}` |
| 上限 | `MAX_JOURNAL_LINES=200`、`MAX_JOURNAL_PAGE=200`、`MAX_PERIOD_NAME_LENGTH=60`、期間の長さは最長1年（`ends_on <= starts_on + 1年 - 1日`） |

**出来事の種類（1-a01〜1-a22 の全部、27種。`arity` は印に使う番号の個数）:**

| 種類 | arity | 設計の行 | 番号の中身 |
| --- | --- | --- | --- |
| `payment_confirmed` | 1 | 1-a01 | payment_intent の番号 |
| `shipment_confirmed` | 1 | 1-a02 | 発送票の番号 |
| `shipment_redated` | 1 | 1-a03 | 直しの履歴の行の番号 |
| `pre_shipment_refund` | 1 | 1-a04 | 返金の残高の取引の番号 |
| `return_arrived` | 1 | 1-a05 | 返品の受け取りの行の番号 |
| `return_amount_decided` | 1 | 1-a06 | 相談・検品の直しの履歴の行の番号 |
| `return_refund` | 1 | 1-a07 | 残高の取引の番号（振込は銀行の取引の番号） |
| `refund_failed` | 2 | 1-a08 | 返金の番号、状態の履歴の行の番号 |
| `refund_abandoned` | 2 | 1-a08b | 返金の番号、状態の履歴の行の番号 |
| `stripe_fee` | 1 | 1-a10 | 残高の取引の番号（印は `stripe:fee:<番号>`） |
| `stripe_tax_adjustment` | 1 | 1-a11 | 調整の残高の取引の番号 |
| `payout_started` | 1 | 1-a12 | 入金の番号 |
| `bank_arrived` | 1 | 1-a12 | 銀行の取引の番号 |
| `payout_failed` | 1 | 1-a13 | 戻りの残高の取引の番号 |
| `balance_topup` | 1 | 1-a14 | 銀行の取引の番号 |
| `dispute_event` | 3 | 1-a15 | dispute の番号、出来事の種類、履歴の行または残高の取引の番号 |
| `dispute_withdrawn_late` | 2 | 1-a16 | dispute の番号、戻りの残高の取引の番号 |
| `exchange_movement` | 1 | 1-a17 | 交換の出荷・受け取りの行の番号 |
| `owner_use` | 1 | 1-a18 | 持ち出しの記録の番号 |
| `personal_discount` | 2 | 1-a18 | 注文番号、差の確定の履歴の番号 |
| `compensation_received` | 1 | 1-a18 | 入金の記録の番号 |
| `manual_entry` | 2 | 1-a19 | 手入力の行の番号、改版の番号（作成は `0`） |
| `migrated_entry` | 1 | 1-a19 | 元の取引の番号（A8） |
| `period_closing_entry` | 3 | 1-a20 | 期間の番号、仕訳の種類、確定した記録の番号 |
| `closed_year_correction` | 3 | 1-a21 | 訂正の記録の番号、対象の期間の番号、直しの種類 |
| `return_arrival_redated` | 1 | 1-a22 | 届いた日の直しの履歴の行の番号 |
| `reversal` | 1 | 1-c・1-d | 取り消す元の仕訳の番号（UUID）。1-a09（返品を断って送り返す決定）もこの種類だけで、別の種類は作らない |

**DB と HTTP の拒否表:** `ACCOUNTING_ERRORS: Readonly<Record<string, readonly [sqlstate:string,status:number,message:string]>>` を Task 8 の `src/lib/accounting/accounting-types.ts` に定義する。store は message と SQLSTATE の完全一致だけで分類する。

| DB message / SQLSTATE | HTTP | 日本語本文 |
| --- | --- | --- |
| `ACCOUNTING_ARGUMENT_INVALID / 22023` | 400 | `入力を確かめてください。` |
| `ACCOUNTING_FORBIDDEN / 42501` | 403 | `会計を操作する権限がありません。` |
| `ACCOUNTING_NOT_FOUND / P0002` | 404 | `会計の記録が見つかりません。` |
| `ACCOUNTING_ENTRY_UNBALANCED / 23514` | 409 | `仕訳の借方と貸方が合いません。`（DETAIL は `balance`・`sign`・`one_sided`・`min_lines`） |
| `ACCOUNTING_DEDUPE_CONTENT_MISMATCH / 23505` | 409 | `同じ出来事で内容の違う仕訳は入れられません。` |
| `ACCOUNTING_ALREADY_REVERSED / 23505` | 409 | `この仕訳は既に取り消されています。` |
| `ACCOUNTING_DATE_OUT_OF_PERIOD / 22023` | 409 | `仕訳の日が会計の期間に入っていません。` |
| `ACCOUNTING_PERIOD_MISSING / 55000` | 409 | `この日付の会計の期間がありません。先に期間を作ってください。` |
| `ACCOUNTING_PERIOD_OVERLAP / 23514` | 409 | `会計の期間が重なっています。` |
| `ACCOUNTING_PERIOD_GAP / 23514` | 409 | `会計の期間にすき間があります。` |
| `ACCOUNTING_PERIOD_TOO_LONG / 23514` | 409 | `会計の期間は1年を超えられません。` |
| `ACCOUNTING_OPENING_TYPE_MISMATCH / 55000` | 409 | `事業の形が違う期間から期首の残高は写せません。` |
| `ACCOUNTING_OPENING_UNBALANCED / 23514` | 409 | `期首の元入金が資産と負債の差と合いません。` |
| `ACCOUNTING_SETTINGS_LOCKED / 55000` | 409 | `開業日は一度入れると選び直せません。` |
| `ACCOUNTING_VERSION_CONFLICT / 40001` | 409 | `設定が変わりました。読み直してください。` |
| `ACCOUNTING_REQUEST_KEY_CONFLICT / 23505` | 409 | `同じ要求番号で異なる操作は実行できません。` |
| `ACCOUNTING_HISTORY_IMMUTABLE / 55000` | 500 | `会計の処理に失敗しました。`（保存した仕訳の書き換え。画面から起きない） |

未知の失敗は 500 `会計の処理に失敗しました。`。入力拒否は `{error:message,code:<固定コード>}`、zod 不正は 400 で同じ入力文、認証/CSRF/429/503 は共通 middleware の既存本文・`Retry-After` を維持する。

---

### Task 1: 画面を分ける（動きは変えない）・CSV の関数を共通のファイルへ

controller が別セッションへ `CostProfitSection.tsx` の対象と開始を先に知らせる。この Task は機械的な移動だけで、表示・文言・状態・fetch・試験の題を一切変えない。今の構造（実物）: 状態と処理が `:1372` 以降に続き、JSX の定数（`stripeSettlementView :3082`、`summaryView :3260`、`expensesView :6334`、`ledgerView :7945`、`assetsView :8885`、`closingView :9949`、`trialBalanceView :10241`、`balanceSheetView :10849`、`profitAndLossView :11274`、`cashFlowView :11389`、`statementsView :11505`、`journalView :11584`、`productView :11603`、`taxView :11989`）の間にも処理と hooks が混ざっている。`:3082` より後に `useMemo`・`useCallback` などの呼び出しが約66か所（最初は `:3996`、最後は `:11968`）あり、処理（`handleEntryCsvExport :4316`、`handleSaveFixedAsset :7062` など）と JSX の部品（`payoutConfirmDialog :3210`、`reviewDrawer :4695`、`filterDrawer :4942`、`receiptDrawer :5421`、`entryDrawer :5642` など）が View の間に置かれている。描画の切り替えは `:12099`〜`:12109`。移す前に `grep -n` で行を取り直す。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-558 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `src/lib/finance/csv-export.ts`、`src/components/cost-profit/constants.ts`（`:192`〜`:792` の定数・小さな関数）、`src/components/cost-profit/shared-ui.tsx`（`MetricCard :793`〜`EmptyIcon :1366` の部品）、`src/components/cost-profit/use-cost-profit-model.ts`（`:1372` 以降の hooks と処理の全部）、`src/components/cost-profit/{summary-view,stripe-settlement-view,expenses-view,ledger-view,assets-view,closing-view,trial-balance-view,balance-sheet-view,profit-and-loss-view,cash-flow-view,statements-view,journal-view,product-view,tax-view}.tsx`
- Modify: `src/components/CostProfitSection.tsx`（約300行の入れ物にする。props・export 名・描画の切り替えは同じ）、`tests/unit/lib/finance/csv-export.test.ts`（新規）
- Test: `tests/unit/components/CostProfitSection.test.tsx`（35件、無改造で通す）、`tests/unit/lib/finance/csv-export.test.ts`、E2E 回帰（下の Step 4）
- Read: `src/components/AccountingSection.tsx`、`src/components/tax/types.ts`（親が集計して渡す契約）

**Interfaces:**
- Consumes: `CostProfitSection({fiscalYear, fiscalYearLabel, fiscalYearOptions?, onFiscalYearChange?})` の今の props と export 名（`default function`）。`AccountingSection`・`page.tsx`・`TaxReportSection` の呼び方は変えない。
- Produces: `exportCsv(filename:string, rows:Array<Array<string|number>>):void`（ブラウザー。BOM 付き UTF-8、行末 CRLF、全セルを `"` で囲み `"` は二重化、区切りは `,`。今の `:778`〜`:791` と同じ）と、中身の文字列だけを返す純粋な `buildCsvText(rows:Array<Array<string|number>>):string`（試験用。`exportCsv` はこれを使う）。式注入の対策は足さない（動きを変えない。計画6が書き出しの共通の層で扱う）。
- Produces: `useCostProfitModel(props:CostProfitProps):CostProfitModel`（`CostProfitModel = ReturnType<typeof useCostProfitModel>`）。`:1372` 以降の hooks（`useState`・`useMemo`・`useCallback`・`useEffect` など）は、View の間にあるものも含め全部、元の出る順のままこのファイルへ移す（順を変えると hooks の規則が壊れる）。View の間にある処理は同じ戻り値に足す。ダイアログ・ドロワーの部品（`payoutConfirmDialog`・`reviewDrawer`・`filterDrawer`・`receiptDrawer`・`entryDrawer` など）は、使う View のファイルの中に置く（複数の View が使う物は `cost-profit/shared-ui.tsx`）。各 View は `export function XxxView({model}:{model:CostProfitModel}):JSX.Element` とし、先頭で `const {…} = model;` と分割代入して JSX を貼る。View の中に hooks を置かない。

- [ ] **Step 1: 失敗する試験を書く（分割の前に今の挙動を固定する）。** `FREQ-558-AC-01: 共通のCSV関数は全セルを引用符で囲み改行をCRLFにしBOMを付ける`（`buildCsvText` に `[['a"b',1],['c,d','e\nf']]` を渡し、引用符の二重化・CRLF・先頭 BOM を確かめる。期待値は今の `exportCsv` の挙動を読んで決める）。画面の分割そのものに新しい試験の題は足さない: 完了の条件は既存の `CostProfitSection.test.tsx` の35件と、下の E2E 回帰が同じ題で通ること。分割前に `grep -n "use[A-Z][A-Za-z]*(" src/components/CostProfitSection.tsx` の結果（行と順）を記録し、分割後の `use-cost-profit-model.ts` で同じ順に並ぶことを確かめる。
- [ ] **Step 2（controller）: 分割前のベースラインを測る。** `npx.cmd jest tests/unit/components/CostProfitSection.test.tsx tests/unit/lib/finance --runInBand` の件数と、下の E2E 回帰の対象（上の Global Constraints の「会計の E2E 回帰の対象」の全部）を production build で流した合否を記録する。既存の赤は「既存の赤」として別に控える（pre-push の揺れの前例あり）。
- [ ] **Step 3: 順に動かす。** (a) `csv-export.ts` を作り `:778` の関数を移して、元の場所は import に替える。(b) `constants.ts` へ `:192`〜`:792` の定数と関数（`exportCsv` を除く）を、`shared-ui.tsx` へ `:793`〜`:1371` の部品を移す。(c) 状態と処理を `use-cost-profit-model.ts` へ移し、戻り値は元の入れ物の中で参照されていた名前をすべて返す。(d) 各 View を `:3082` 以降の定数の範囲ごとに別ファイルへ移す。移すたびに `npx.cmd tsc --noEmit --incremental false` が通ることを確かめる（欠けた分割代入は型の誤りで分かる）。(e) `CostProfitSection.tsx` に残るのは props の受け取り・`useCostProfitModel`・描画の切り替え・`TaxReportSection`/`ProductCostSection` の接続だけ。
- [ ] **Step 4（controller）: GREEN を測る。** Step 2 と同じ単体・E2E を流し、件数・題・合否が同じであることを確かめる。390/768/1280px の3幅。`CostProfitSection.tsx` が 400 行以下、各 View が 3000 行以下であることも記録する。
- [ ] **Step 5（controller）: Files だけコミットする。** `refactor(accounting): 会計画面をサブタブごとのファイルに分けCSVの関数を共通へ移す`

### Task 2: 権限6件を一度に足す（32→38）

controller が別セッションへ先に知らせる（権限の3か所の一覧は他の作業と同じ行を触る）。Task 1 のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-553 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts0>_accounting_p1_permissions.sql`、`tests/integration/db/accounting_p1_permissions.integration.test.ts`
- Modify: `src/lib/auth/admin-rbac.ts:6-43`（`PermissionCode` に6個）と `legacyPermissionMap`（admin は全件、supporter は変えない）、`src/lib/auth/role-permission-catalog.ts`（6行と依存）、`src/lib/auth/role-permission-store.ts:21,33`（`.max(32)` を `.max(38)` に2か所）、`src/app/api/admin/role-permissions/route.ts:21`（`.max(32)` を `.max(38)`）、`tests/unit/lib/auth/role-permission-catalog.test.ts`、`tests/unit/lib/auth/role-permission-store.test.ts`、`tests/unit/api/admin/role-permissions-route.test.ts`、`tests/integration/db/role_permissions.integration.test.ts`、`tests/integration/db/group_h_foundation.integration.test.ts`（32件を検査している所）、`tests/unit/lib/auth/admin-rbac.test.ts:527-528`（店長の権限の数 32→38）、`e2e/FR-ADMIN-109-permission-settings.spec.ts` と `e2e/permission-settings-test-utils.ts`（件数）
- Test: 上の単体と DB の suite
- Read: `supabase/migrations/20261029130000_group_h_discounts_foundation.sql` の `private.admin_get_permissions`・`private.admin_set_role_permissions`（`catalog`・`fixed`・版・要求鍵・監査）と、H1 の権限の登録・`group_h_permission_baseline` の差分 assert の形（写す）。`20261023175712_group_g0_permissions.sql:221-363`。適用済みの両ファイルを変更しない。

**Interfaces:**
- Produces: 新しい権限6件。全部、店長（role code=`admin`）だけへ付与し、サポーター・利用者へは付けない。依存は表示用で、すべて `admin.finance.read` が前提（`requires`）。

| 符号 | 日本語名（領域「会計」） | 使う計画 | 使う場面 |
| --- | --- | --- | --- |
| `admin.accounting.settings.manage` | 会計の設定・期間 | 1 | 開業日・事業の形・期間の作成（Task 8・11） |
| `admin.accounting.entries.correct` | 仕訳の訂正・取り消し | 3・6 | 返品の届いた日の直し、締めた年の訂正、取り消しの仕訳を入れる操作（10-c〜10-e・1-a21・1-a22） |
| `admin.accounting.close.manage` | 期間の締め・締めの解除 | 6 | 締める・解く・版を作る（10章） |
| `admin.accounting.inventory.manage` | 棚卸・原価の確定 | 5 | 年末の棚卸、評価損、自家消費・宣伝用の印（9・13章） |
| `admin.accounting.export.read` | 帳簿・写しの書き出し | 6・7 | 税務署用の書き出し（12-a4）、freee・MF への CSV の書き出し（15章） |
| `admin.accounting.integration.manage` | 会計ソフトとの連携 | 7 | freee・MF の API 連携の設定（15-g） |

- Produces: `PermissionCode` に上の6個。`ROLE_PERMISSION_CATALOG` の `requires` は `admin.accounting.*` すべて `['admin.finance.read']`。`admin.accounting.export.read` は他の6つと違い名前が read だが、読み取りの権限として `admin.finance.read` と別にする（書き出しは外へ持ち出す操作なので閲覧と分ける）。
- Produces: `private.admin_get_permissions(_actor_id uuid) RETURNS jsonb`・`private.admin_set_role_permissions(_actor_id uuid,_role_code text,_permission_codes text[],_expected_version bigint,_request_key uuid) RETURNS jsonb` の両 `catalog` を38件に拡張し、固定2権限・版・要求鍵・監査・public INVOKER を保つ（H1 と同じ作り）。`permissions` へ6件を `ON CONFLICT(code) DO NOTHING`、`role_permissions` を role code=`admin` だけへ `ON CONFLICT DO NOTHING`、`roles.permissions_version` を admin だけ1回 +1。
- Produces: 権限DML前に `CREATE TEMP TABLE accounting_permission_baseline(payload jsonb) ON COMMIT DROP` へ控え、末尾 assert で差分が「permissions 6件・店長への付与6件・admin 版 +1」だけ、サポーター/利用者の付与0、他の付与と版が不変、を検査する（`withAccountingPermissionBaseline(client,assertSql)` を fixture に置く。H1 の `withH1PermissionBaseline` と同じ形）。DETAIL: `acc_s0_permission_catalogs`・`acc_s0_permission_seed`・`acc_s0_existing_dml_allowlist`。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-553-AC-01: 38コードの初期登録は店長だけへ6件を付与し店長の版だけを1増やす`（実 S0 を適用して旧版で SET が VERSION_CONFLICT、他の付与と版が不変、38件可/39件拒否）、`FREQ-553-AC-01: 6権限の表示の依存はfinance.readでmanage系もreadなしは不足と出る`（`getMissingPermissionDependencies`）、`FREQ-553-AC-01: DBは無効な役割と期限切れの割り当てと足りない権限を42501で拒む`（service_role で actor を渡す）、`FREQ-553-AC-01: role-permissions の保存は38件まで受け39件を断る`（route と store の上限が3か所そろう）。
- [ ] **Step 2（controller）: RED を測る。** `npx.cmd jest tests/integration/db/accounting_p1_permissions.integration.test.ts tests/integration/db/role_permissions.integration.test.ts --runInBand` と権限の単体3本。6件が無い失敗を記録し、接続の失敗を RED に数えない。
- [ ] **Step 3: S0 と TS の3か所を実装する。** `legacyPermissionMap` の admin 以外は変えない。`admin-rbac.ts` の `PermissionCode` と SQL の両 `catalog` と TS の表示の目録（`role-permission-catalog.ts`）と上限3か所を同じコミットで38にそろえる。
- [ ] **Step 4（controller）: 共通 verify で GREEN を測る。** 末尾 assert を SAVEPOINT 内で、RLS 無効/別 overload/`catalog` が37件、へ1つずつ改ざんして流し、55000 と対応 DETAIL を検査する。`npx.cmd tsc --noEmit --incremental false`・`npm.cmd run lint` も通す。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 会計の権限6件を権限の一覧と上限に足す`。店長だけへの付与と版 +1 の実測を記録する。

### Task 3: 会計の表の権限の締め直し・領収書の置き場・証憑の種類

controller が別セッションへ `cost-profit/route.ts`・`receipt/route.ts` の変更を先に知らせる。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-553・559 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts1>_accounting_p1_grants_receipts.sql`、`tests/integration/db/accounting_p1_grants.integration.test.ts`、`tests/integration/db/accounting_p1_routes_after_grants.integration.test.ts`、`tests/integration/db/accounting_p1_receipts_bucket.integration.test.ts`
- Modify: `src/app/api/admin/kpi/cost-profit/receipt/route.ts`（POST が `evidenceKind` を必須で受け、GET の応答に種類を足す。`:26,66`）、`src/app/api/admin/kpi/cost-profit/route.ts`（`ReceiptRow :271` と読み取りの射影に種類を足す。`receipt.attach :1239` も種類を受ける）、`tests/unit/api/admin/receipt-route.test.ts`、`tests/unit/api/admin/cost-profit-route.test.ts`、`tests/integration/db/auth_grants_inventory.integration.test.ts`（`KNOWN_EXCEPTION_PREFIXES` から `admin_finance_` を外し、12表を締まった表として検査する）
- Test: 上の DB 3本と単体2本
- Read: `supabase/migrations/20261026130200_sec_grants_hardening.sql`（形の手本）、`supabase/migrations/20261026130600_sec_storage_buckets.sql`（バケットの手本）、`tests/integration/db/helpers/admin-table-grants.ts`、`20260901102912_remote_schema.sql:3128-3285`（方針）・`:4116-4132`（権限）

**Interfaces:**
- Consumes: 2026-11-04 の本番の読み取りで、`admin_finance_entry_review_acks`・`_entry_revisions`・`_evidence_unavailable_records`・`_expense_templates`・`_expenses`・`_fixed_assets`・`_partners`・`_receipts`・`_seasons`・`_summary_options`・`_year_closings`・`_years` の12表すべてに anon と authenticated へ DELETE・INSERT・REFERENCES・SELECT・TRIGGER・TRUNCATE・UPDATE が付いたまま、RLS はどれもオン、方針は `entry_revisions` が1つ・ほかは4つずつと確かめてある。会計の route（`cost-profit/route.ts`・`receipt/route.ts`・`product-costs/route.ts`）と `entry-review.ts` の型 import は、`src/` で `createServiceRoleClient` だけを使い、利用者の JWT でこれらの表を読み書きする経路は見つからなかった（Step 1 で `grep -rn "admin_finance_" src scripts` を再実行して確かめる）。
- Produces（外す権限の決定）: 12表すべてで、**anon と authenticated の表の権限を SELECT も含めて全部外す**（controller の決定）。12表の連番も anon・authenticated から全部外す（今は SELECT・UPDATE・USAGE が付いたままで、UPDATE があると番号を進められる）。service_role は表に全権限、連番に `USAGE, SELECT` を明示して付け直す（後の REVOKE で消えないため。波2 の形）。根拠: 会計の表を読み書きするのは route 3つ（`cost-profit/route.ts`・`receipt/route.ts`・`product-costs/route.ts`）で、どれも `createServiceRoleClient` だけを使い、利用者の JWT でこれらの表を読み書きする経路は見つからなかった。既存の RLS の方針（読み取り `admin.finance.read`・書き込み `admin.finance.manage`）は権限が無くなって届かなくなるが、方針自体は消さない（既存の方針を触らない。第2の門として残る）。`admin_costing_items`・`admin_expense_cost_allocations`・`admin_kpi_*` は対象に含めない（前者2つは既に authenticated が SELECT のみ。後者は計画2）。
- Produces: `storage.buckets` に `finance-receipts`（`public=false`、`file_size_limit=20971520`、`allowed_mime_types=['application/pdf','image/jpeg','image/png','image/webp','image/heic']`）を `ON CONFLICT (id) DO UPDATE` で作る（route の `:11,15-21` の値と同じ。本番には手作りで既にあるので二重に作っても壊れない）。`storage.objects` に、このバケットを名指しする方針があれば末尾 assert で止まる（手本どおり）。移行のコメントに、適用前の読み取り（`select id, public, file_size_limit, allowed_mime_types from storage.buckets where id='finance-receipts'` と `pg_policies` と既存オブジェクトの最大の大きさ）と戻す値を書く。
- Produces: `public.admin_finance_receipts` に `evidence_kind text NOT NULL DEFAULT 'unconfirmed'`（CHECK: `electronic`・`paper`・`unconfirmed`）と `paper_original_kept boolean NULL`（CHECK: `paper_original_kept IS NULL OR evidence_kind = 'paper'`）。既存の行は `unconfirmed` のまま読める（行は書き換えない）。route の `ReceiptPostSchema` は `evidenceKind: 'electronic'|'paper'` を必須にし、`paper` のときは `paperOriginalKept: boolean` も必須（12-i: 紙の原本は残す）。`unconfirmed` は route から入れられない（既存の8件の確認前の状態だけ）。
- Produces: S1 assert DETAIL `acc_s1_finance_table_acl`（12表。`relkind = 'r'` で絞った `admin_finance_%` の表がこの12表と一致することも検査）・`acc_s1_finance_seq_acl`（12表の連番）・`acc_s1_bucket`・`acc_s1_receipt_columns`・`acc_s1_policies_unchanged`（12表の方針の数が移行前と同じ）。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-553-AC-02: 12表と連番でanonもauthenticatedも表の権限を何も持たない`（`adminTableTools(db).privileges` で12表×2役を、連番は `has_sequence_privilege` で検査）、`FREQ-553-AC-02: anonとauthenticatedのSELECT/INSERT/UPDATE/DELETE/TRUNCATEは42501で断られる`（`failureAs`）、`FREQ-553-AC-03: service_roleは12表を従来どおり読み書きできる`（SELECT/INSERT/UPDATE を表ごと savepoint 内で。`admin_finance_entry_revisions` はトリガーが書くので expenses の INSERT で行が増える）、`FREQ-553-AC-03: 手入力の経費のトリガーは権限を締めた後も履歴を書く`（SECURITY DEFINER のまま動く）、`FREQ-553-AC-04: admin.finance.readを持つ利用者のJWTでも会計の表をSELECTすると42501で断られる`（`createLiveAppSession`・`jwtClaims`）、`FREQ-559-AC-01: finance-receiptsは非公開で20MiB・5形式・方針なし`、`FREQ-559-AC-02: 証憑の種類の列は3値だけを受け紙以外はpaper_original_keptがNULL`。単体: `FREQ-559-AC-02: receiptのPOSTは種類を必須にし紙には原本の有無を必須にする`、`FREQ-559-AC-02: receiptのGETは種類を返す`。DB の試験は共通制約の ROLLBACK の形で書く（route の結合の試験を除く）。さらに `FREQ-553-AC-04: 表の権限を締めた後も、route の関数を直接呼ぶ結合の試験（cost-profit の GET と expense.create、receipt の POST、product-costs の GET）が手元の DB の service_role で200と行を返す`（`createServiceRoleClient` は手元の Supabase の service_role を指す環境で、`authorizeAdminPermission` をテスト用に差し替える）。この試験は前例 `tests/integration/db/refund_postgrest.integration.test.ts:26-41` の形で書く: `next/server`・`server-only`・権限・CSRF（`requireCsrfOrDeny`）・回数の制限を差し替え、手元の URL と鍵は環境変数（`LOCAL_SUPABASE_URL`・`LOCAL_SUPABASE_SERVICE_ROLE_KEY`）で渡し、localhost 以外なら失敗させる。PostgREST を通って書いた行（経費・領収書・監査・置き場の物）はコミットされ ROLLBACK で消せないので、コミットする試験として共通制約の別の jest 実行で流し、前後に `db reset` する。経費の日付は Task 9 の後も通るよう、開業日の年〜今の日本時間の年+1 の中の日にする。
- [ ] **Step 2（controller）: RED を測る。** 手元の DB で `accounting_p1_grants`・`accounting_p1_receipts_bucket` と単体2本。バケットが手元に無い失敗・権限が広い失敗を RED に記録する。
- [ ] **Step 3: S1 と route を実装する。** 移行は、12表を `REVOKE ALL ON TABLE <12表> FROM PUBLIC, anon, authenticated;`、`GRANT ALL ON TABLE <12表> TO service_role;`、12表それぞれの所有する連番（`admin_finance_*_id_seq`。`pg_depend` で拾う）を `REVOKE ALL ON SEQUENCE … FROM PUBLIC, anon, authenticated;` と `GRANT USAGE, SELECT ON SEQUENCE … TO service_role;` にする。12表の名前は移行にだけ並べ、`pg_class` から `admin_finance_%` を動的に拾う書き方にしない（増えた表を黙って巻き込まないため）。末尾 assert が「`relkind = 'r'` で絞った `admin_finance_%` の表がこの12表と一致」を検査する。route の変更は最小（zod と射影と応答だけ）。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。加えて `accounting_p1_routes_after_grants.integration.test.ts`（route の関数を直接呼び、cost-profit の GET と `expense.create`、receipt の POST、product-costs の GET が手元 DB の service_role で200と DB の行を返す）を締めた後に流して実測する（コミットする試験として別の jest 実行。前後に `db reset`）。`FR-ADMIN-130`（Task 14）は Task 14・16 でもう一度流す。応答を作り物にする E2E（`FR-ADMIN-038`・`029`・`030`・`047`）は DB の権限を通らないので権限の確かめには数えず、画面の回帰としてだけ流す。`auth_grants_inventory` の歯止めが12表を締まった表として数えることも確かめる。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 会計の表の権限を締め領収書の置き場と種類を移行に入れる`

### Task 4: 勘定の追加・印の作り方（TS）・仕訳の型

controller が別セッションへ `src/lib/finance/accounts.ts` の変更を先に知らせる。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-554 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `src/lib/accounting/event-kinds.ts`、`src/lib/accounting/event-key.ts`、`src/lib/accounting/jst-date.ts`、`src/lib/accounting/journal-types.ts`、`scripts/accounting/emit-accounts-seed.ts`、`tests/unit/lib/accounting/event-key.test.ts`、`tests/unit/lib/accounting/jst-date.test.ts`、`tests/unit/lib/accounting/accounts-contract.test.ts`
- Modify: `src/lib/finance/accounts.ts`（1160・4050 を足す）、`tests/unit/lib/finance/journal.test.ts`（科目数 160→162）、`docs/04_DetailDesign/shared/finance.md`（科目の表。表と `accounts.ts` は1対1）
- Test: 上の単体3本と既存の finance 単体
- Read: `src/lib/finance/accounts.ts:6-250`、`src/lib/finance/stripe-journal.ts:61-121`（今の印の形）

**Interfaces:**
- Produces（勘定）: `ACCOUNTS` に2件を足す。`{code:'1160',type:'asset',normalSide:'debit',name:'Stripe未収金',section:'その他流動資産',cashOut:false,cashIn:false,scope:'common'}`（7-b。取引管理のプルダウンに出さない）、`{code:'4050',type:'revenue',normalSide:'credit',name:'返品の手数料',section:'売上（収入）金額',cashOut:false,cashIn:false,scope:'common'}`（7-e。簡易課税の区分と雑収入の行へ分けるかは税理士に確かめる。16章）。1130 の名前・区分、1150、4020 は変えない（7-a・7-g・7-h）。寄附金（7-k）は既存の `6320`（`寄附金`）を使い、新しい番号は足さない。`resolveAccount` のフォールバック `9999`（諸口）は DB にも行を持つ（Task 6）。
- Produces（補助の符号）: `ACCOUNTING_SUB_ACCOUNTS = {return_refund:{accountCode:'2130'}, dispute_pending:{accountCode:'1470'}, processor:{accountCode:'1130'}}`（7-d・7-f・7-a）。仕訳の行の `subAccount` は `return_refund`・`dispute_pending`・`processor:<決済会社>` のいずれか、または null。
- Produces（印）: `ACCOUNTING_EVENT_KINDS`（上の27種、`as const`）と `EVENT_KEY_ARITY: Readonly<Record<AccountingEventKind, number>>`、`buildEventKey(kind:AccountingEventKind, parts:EventKeyParts):AccountingEventKey`（種類が一覧に無い・個数が違う・要素が `^[A-Za-z0-9_.-]{1,128}$` でないなら `AccountingEventKeyError` を投げる）、`parseEventKey(key:string):{kind:AccountingEventKind;parts:string[]}|null`。印の文字列は `<prefix>:<part>[:<part>…]`。`prefix` は種類の名前（`EVENT_KEY_PREFIX[kind]`）で、`stripe_fee` だけ設計 1-a10 の形 `stripe:fee` にする（印の形は設計の 1-a の一覧にそろえ、違う所を作らない）。
- Produces（日本時間）: `toJstDate(instant:string|Date):string`（`Asia/Tokyo` の暦日。`2026-12-31T15:30:00Z` → `2027-01-01`）。1-e のとおり仕訳の日は出来事の日の日本時間で、`stripe_created_at` など timestamptz はこの関数で日へ直して渡す。
- Produces（型）: `SavedJournalEntry`・`SavedJournalLine`（共通の型の表）と、既存の画面の型へ直す `savedEntryToJournalEntry(saved:SavedJournalEntry, accounts:(code:string)=>Account):JournalEntry`（`sourceKey=dedupeKey`、`number` は `JE-<yyyymmdd>-<3桁>` ではなく期間ごとの通し番号 `entryNo` を使った `JE-<entryNo の6桁>`、`entryId` は手入力の行の番号が分かるときだけ数値、無ければ -1）。`tax/**` と `statements.ts` の型は変えない。
- Produces（契約の試験）: `scripts/accounting/emit-accounts-seed.ts` は `ACCOUNTS` から `INSERT INTO public.accounting_accounts (code,account_type,normal_side,scope,carryover_role) VALUES …` の本文を標準出力へ出す（`carryover_role` は `capital_sole`（2910）・`owner_draw`（区分が事業主貸の勘定 = 1910 と 1920。期首は0。設計 3-e・3-f。`year-end.ts` の 1910 だけの扱いは Task 10 で直す）・`owner_contribution`（2920）・`retained_corp`（3040）・`pl_zero`（revenue/expense）・`carry`（その他）。`9999` を `scope=common,type=expense` で1行足す）。`accounts-contract.test.ts` が、S2 の本文の `accounting_accounts` の行（コメントの `-- ACC_ACCOUNTS_BEGIN/END` の間）と、この出力の一致を確かめる。同様に S2 の `private.accounting_event_kinds()` の本文と `ACCOUNTING_EVENT_KINDS`・`EVENT_KEY_ARITY` の一致を確かめる。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-554-AC-03: 印は種類と番号の組で作り個数と文字を検査する`（27種すべてに arity どおりの例、個数違い・`:` を含む要素・空・129字で拒否、`stripe:fee:txn_1`（設計 1-a10 の形））、`FREQ-554-AC-05: 日本時間の日付へ直す`（`2026-12-31T15:30:00Z`→`2027-01-01`、`2026-12-31T14:59:59Z`→`2026-12-31`、`Date` と文字列の両方）、`FREQ-554-AC-06: 勘定の一覧は162件で1130と1150と4020の名前と区分が変わらず1160と4050が増える`、`FREQ-554-AC-06: 勘定の符号は重ならず、補助の符号は存在する勘定を指す`、`FREQ-554-AC-06: 保存した仕訳を画面の仕訳の型へ直しても貸借と科目が変わらない`、`FREQ-554-AC-06: 勘定のSQLの行と種類の一覧はTSと一致する`（S2 が無い間は pending ではなく失敗させ、Task 6 で通す）。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting tests/unit/lib/finance/journal.test.ts --runInBand`。
- [ ] **Step 3: Interfaces どおり実装する。** `journal.test.ts` の「160科目」を162にするだけで、ほかの期待値は変えない。`finance.md` の科目の表へ2行足す。
- [ ] **Step 4: GREEN を測る。** 上の単体、`npx.cmd jest tests/unit/lib/finance --runInBand`（既存を壊さない）、型・lint。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 勘定の追加と重ならない印の作り方を足す`

### Task 5: 期間・月ごとの区切り・申告の期限・開業日の期限（I/O なし）

controller が別セッションへ `src/lib/finance/fiscal-year.ts` の変更を先に知らせる。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-555・561 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `src/lib/accounting/period.ts`、`src/lib/accounting/period-months.ts`、`src/lib/accounting/filing-deadlines.ts`、`src/lib/accounting/startup-deadlines.ts`、`src/lib/accounting/jp-holidays.ts`、`tests/unit/lib/accounting/period.test.ts`、`tests/unit/lib/accounting/period-months.test.ts`、`tests/unit/lib/accounting/filing-deadlines.test.ts`、`tests/unit/lib/accounting/startup-deadlines.test.ts`
- Modify: `src/lib/finance/fiscal-year.ts`（既存の関数は残し、`fiscalYearRange` に「暦年の期間」であることをコメントで示すだけ）
- Test: 上の単体4本

**Interfaces:**
- Produces: `validateNewPeriod(input:{businessType:AccountingPeriod['businessType'];startsOn:string;endsOn:string;existing:readonly Pick<AccountingPeriod,'businessType'|'startsOn'|'endsOn'>[]}):{ok:true}|{ok:false;code:'overlap'|'gap'|'too_long'|'bad_range'|'sole_not_calendar'}`。規則: 始まり≤終わり（`bad_range`）、終わり ≤ 始まり+1年−1日（`too_long`。11-c2）、同じ事業の形の既存と1日でも重なれば `overlap`（11-d）、既存の最後の次の日以外から始めるか最初の前の日まで終わらないなら `gap`、個人は始まりが1月1日で終わりが同じ年の12月31日以前（`sole_not_calendar`。11-b: 事業をやめた年は終わりが早くてよい）。個人から法人の期間は互いに重なってもよい（11-a。別の事業の形）が、実際に重なる期間の登録は DB が事業の形ごとに見るだけで、画面が止めることはしない。
- Produces: `formatPeriodName(p:{businessType;startsOn;endsOn;termNumber?:number}):string`（個人は `2026年（個人）`、法人は `第1期`。法人の期数は同じ事業の形の中の始まり順。SQL の `U&` 形の名前と同じ文字列になるよう試験で固定する）。
- Produces: `splitPeriodByMonth(startsOn:string, endsOn:string):PeriodMonthSlice[]`（11-e2。暦の月で区切り、最初と最後の月は期間の端で切り、1か月に満たない月に `partial=true`。例: `2027-07-15`〜`2028-07-14` は `2027-07-15〜07-31`（partial）から `2028-07-01〜07-14`（partial）まで。月ごとの額を足すと期間の合計に合うことを `sumByMonth` の試験で確かめる）。
- Produces: `filingDeadlines(period:AccountingPeriod, isHoliday:(date:string)=>boolean|undefined):{deadlines:FilingDeadline[];interim:InterimFiling[]}`（11-h）。個人: 所得税は翌年3月15日。法人: 法人税は「終了の日の翌日から2か月」（`addMonths(endsOn+1日, 2) − 1日`。`2028-06-30`→`2028-08-31`、`2027-12-31`→`2028-02-29`）、法人の地方税（法人住民税・法人事業税・特別法人事業税）も同じ日。消費税（個人は翌年3月31日、法人は法人税と同じ日）は、期間の `consumptionTaxStatus` が `taxable` の期間だけ出す（設計 5-j: 課税か免税かは期間の設定に置く）。年の途中で課税事業者になった期間（`consumptionTaxableFrom` が期間の途中）は、その日以後を課税の期間として出し、`note` に日を書く（15-c2）。今の期間は全部 `exempt` なので画面に出ない（「課税事業者になったら出します」）。期限が土曜・日曜・祝日・12月29日〜31日に当たるときは次の日（国税通則法10条2項・同施行令2条2項）にして `rolled=true`、`baseDue` に元の日を残す。`isHoliday` が `undefined` を返す年（表の無い年）は繰り下げを確かめられないので `holidayTableMissing=true` で元の日を返す。法人税の延長は `corporateTaxExtensionMonths`（0か1）、消費税は `consumptionTaxExtensionMonths`（法人税の延長を受けた法人だけ。消費税法45条の2）を足し、`extended=true` と `note` に「延ばした分に利子税がかかる」を入れる。中間申告は期限だけ返す: 第1期は `required:false, reason:'first_term'`（前の期が無いので不要）、第2期以後は `required:null, reason:'prior_tax_unknown'`（前の期の税額が入るまで判定できない）で、法人税の期限は「6か月を過ぎた日から2か月以内」。
- Produces: `isJpHoliday(date:string):boolean|undefined`（`jp-holidays.ts`。内閣府の「国民の祝日」の公表済みの年だけを表にする。春分・秋分は前の年の官報で決まるので、表にできるのは公表された年まで。実装の時に内閣府のページで確かめ、表の先頭のコメントに出典の URL と取得日を書く）。表の無い年は `undefined` を返し（`throw` しない）、`filingDeadlines` が `holidayTableMissing` を付けて返す。年の追加の手順は `docs/06_Operations/accounting-p1-journal-foundation.md` に書く（Task 15）。
- Produces: `startupDeadlines(businessStartDate:string, today:string, isHoliday):StartupDeadline[]`（11-k2、`{kind:'business_start_notice'|'blue_return_approval'|'inventory_method_notice'|'inventory_method_change';dueOn:string;passed:boolean;consequence:string|null}`）。青色申告の承認の申請は、開業が1月15日以前ならその年の3月15日、1月16日以後なら開業日から2か月以内（所得税法144条）。棚卸資産の評価の方法の届け出は、開業した年分の確定申告の期限（翌年3月15日を11-h の規則で繰り下げた日。2025年開業なら `2026-03-16`）で、過ぎていれば `consequence='最終仕入原価法（所得税法施行令102条1項）になる'`。変更の承認の申請は変えたい年の3月15日（同101条2項、`today` の翌年分を示す）。開業の届け（`business_start_notice`）の期限は、開業した日に適用される法令で出し分ける（11-k2）。表 `STARTUP_NOTICE_RULES`（出典: 令和5年法律第3号 附則1条6号・10条）: 開業日が 2026-01-01 より前は、前の所得税法229条のまま「事実があった日から1か月以内」（翌月の同じ日。無ければ月末。11-h の規則で繰り下げ）、2026-01-01 以後は新しい229条の「開業した年分の確定申告の期限まで」（翌年3月15日を11-h の規則で繰り下げた日）。2025年の開業は前者。開業日の日付そのものは計画に書かず、オーナーが管理画面の設定で入れる値を使う。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-555-AC-01: 期間の登録は重なりとすき間と1年超と個人の暦年外を断る`（2026年個人の後の `2027-01-01`〜`2027-06-30` は受理、`2027-02-01` 始まりは gap、`2026-06-01` 始まりは overlap、法人の `2027-07-01`〜`2028-07-01` は too_long、法人の第1期が `2027-07-01`〜`2027-12-31` の6か月は受理）。`FREQ-555-AC-05: 月ごとの区切りは暦の月で期間の端を切り足すと合計に合う`。`FREQ-561-AC-01: 令和7年分の所得税の期限は2026-03-16に繰り下がる`、`FREQ-561-AC-01: 法人の期限は終了日の翌日から2か月で休みの日は次の日にし延長の月を足す`（`2028-06-30`→`2028-08-31` は木曜で繰り下げなし、12月末の決算は `2028-02-29`、延長1か月で `2028-03-31` を基準に繰り下げ判定）、`FREQ-561-AC-01: 12月29日から31日と祝日は次の日にする`。`FREQ-561-AC-02: 開業日の期限は2025年開業なら棚卸資産の評価方法の届け出が過ぎたと最終仕入原価法を示す`、`FREQ-561-AC-02: 青色申告の承認の期限は1月15日までと16日以後で変わる`。`FREQ-561-AC-01: 祝日の表の無い年の期限は元の日にholidayTableMissingを付ける`、`FREQ-561-AC-01: 第1期の中間申告は不要、第2期以後は判定できないと返す`。 さらに `FREQ-561-AC-02: 開業の届けの期限は、2025年の開業なら開業日から1か月、2026年の開業なら年分の確定申告の期限になる`、`FREQ-561-AC-01: 消費税の期限は期間がexemptなら返さず、taxableなら課税の期間だけ返し、年の途中の課税事業者になった日をnoteに書く`。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting --runInBand`。
- [ ] **Step 3: Interfaces どおり実装する。** 日付計算は `Date` の UTC 部分だけを使い、実行環境のタイムゾーンに依存させない。擬似コード: `addMonths(d, n)` は月末を超える日を月末に丸める。祝日表は実装時に内閣府の最新の公表値を取り、表にない年は `undefined` を返す（例外にしない）。
- [ ] **Step 4: GREEN を測る。** 上の単体、型・lint。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 会計の期間と申告の期限の計算を足す`

### Task 6: 仕訳の表・入れる関数・取り消しの道具・書き換え不可

controller が別セッションへ `docs/06_Operations/db-migrations.md`・`docs/03_BasicDesign/data/er.md` の更新を先に知らせる。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-554 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts2>_accounting_p1_journal_foundation.sql`、`tests/integration/db/accounting_p1_journal.integration.test.ts`、`tests/integration/db/accounting_p1_journal_concurrency.integration.test.ts`、`tests/integration/db/accounting_p1_migration_asserts.integration.test.ts`、`tests/integration/db/helpers/accounting-fixtures.ts`
- Modify: `docs/06_Operations/db-migrations.md`、`docs/03_BasicDesign/data/er.md`（Task 15 でまとめて）
- Test: 上の DB 3 suite
- Read: `20261023211425_group_g1_allocation.sql:505-`（`private.reject_group_g_event_mutation` と追記専用のトリガー）、`20261025070821_group_g3_shipping_reads.sql:693-815`（末尾 assert の形）、`20261029130300_group_h_discounts_acceptance.sql:1610`（`group_g_writer_allowlist`。会計の表は G の表でないので足さない）

**Interfaces:**
- Produces（表）: すべて `public`、所有者 postgres、RLS 有効、PUBLIC/anon/authenticated 権限なし、service_role は SELECT のみ。
  - `accounting_accounts(code text PK CHECK (code ~ '^[0-9]{4}$'), account_type text CHECK in asset/liability/equity/revenue/expense, normal_side text CHECK in debit/credit, scope text CHECK in common/soleProprietor/corporation, carryover_role text CHECK in carry/capital_sole/owner_draw/owner_contribution/retained_corp/pl_zero)`。行は `scripts/accounting/emit-accounts-seed.ts` の出力を `-- ACC_ACCOUNTS_BEGIN/END` の間へ埋める（162行と `9999` の1行）。UPDATE/DELETE/TRUNCATE は追記専用トリガーで断る（勘定の追加は後の移行だけ）。
  - `accounting_periods(id uuid PK DEFAULT gen_random_uuid(), business_type text, name text CHECK (char_length(name) BETWEEN 1 AND 60), starts_on date, ends_on date, corporate_tax_extension_months smallint NOT NULL DEFAULT 0 CHECK (0..1), consumption_tax_extension_months smallint NOT NULL DEFAULT 0 CHECK (0..1) CHECK (consumption_tax_extension_months <= corporate_tax_extension_months), consumption_tax_status text NOT NULL DEFAULT 'exempt' CHECK in ('exempt','taxable'), consumption_taxable_from date NULL CHECK ((consumption_tax_status = 'exempt') = (consumption_taxable_from IS NULL)) CHECK (consumption_taxable_from BETWEEN starts_on AND ends_on), version bigint NOT NULL DEFAULT 1, created_by uuid, created_at timestamptz DEFAULT now(), updated_by uuid, updated_at timestamptz, creation_request_key uuid UNIQUE, creation_request_hash text, admin_requests jsonb NOT NULL DEFAULT '{}', legacy_fiscal_year integer NULL UNIQUE)`。CHECK: 始まり≤終わり、`ends_on <= starts_on + interval '1 year' - interval '1 day'`（1年超）、個人は始まりが1月1日で終わりが同年内。重なり・すき間は Task 7 の遅延 constraint trigger。`legacy_fiscal_year` は A8 と旧 `?year=` の道（個人の暦年の期間にだけ入る）。
  - `accounting_period_sequences(period_id uuid PK FK, last_entry_no bigint NOT NULL DEFAULT 0)`。仕訳の番号の採番だけが更新する（追記専用の対象外）。
  - `accounting_journal_entries(id uuid PK DEFAULT gen_random_uuid(), period_id uuid NOT NULL FK RESTRICT, entry_no bigint NOT NULL, entry_date date NOT NULL, event_kind text NOT NULL CHECK (event_kind = ANY (private.accounting_event_kinds())), dedupe_key text NOT NULL UNIQUE, content_hash text NOT NULL, description text NOT NULL CHECK (char_length(description) <= 500), recorded_at timestamptz NOT NULL DEFAULT now(), recorded_by uuid NULL, is_late boolean NOT NULL DEFAULT false, reverses_entry_id uuid NULL UNIQUE FK RESTRICT, reason text NULL, source_table text NULL, source_id text NULL, migrated_from text NULL, migrated_at timestamptz NULL, UNIQUE (period_id, entry_no))`。`reverses_entry_id` の UNIQUE が「元1本につき取り消しは1回」。CHECK: 取り消し（`event_kind='reversal'`）のときだけ `reverses_entry_id` と `reason` が NOT NULL、それ以外は NULL。`recorded_at`・`entry_no`・`is_late` はアプリが値を渡せない（関数だけが決める。12-b）。索引: (period_id, entry_date, entry_no)、(source_table, source_id)。
  - `accounting_journal_lines(entry_id uuid FK RESTRICT, line_no smallint CHECK (line_no BETWEEN 1 AND 200), account_code text NOT NULL FK accounting_accounts, debit bigint NOT NULL DEFAULT 0 CHECK (debit >= 0), credit bigint NOT NULL DEFAULT 0 CHECK (credit >= 0), sub_account text NULL CHECK (sub_account ~ '^[a-z0-9_:.-]{1,64}$'), counterparty text NULL, order_id uuid NULL, memo text NULL, PRIMARY KEY (entry_id, line_no))`。
- Produces（遅らせて確かめる）: `accounting_journal_lines` への `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` が、挿入された見出しごとに ①行が2行以上（DETAIL `min_lines`）、②各行で `(debit > 0) <> (credit > 0)`（片側だけ。`one_sided`）、③各行の額が整数で正（`sign`。額の検査は関数の最初でも行い、小数・文字・負は `ACCOUNTING_ENTRY_UNBALANCED/sign` か `ACCOUNTING_ARGUMENT_INVALID` に寄せる。bigint への変換の型の誤り 22P02 を外へ出さない）、④`sum(debit) = sum(credit)`（`balance`）を確かめ、外れたら `ACCOUNTING_ENTRY_UNBALANCED` / `23514`。見出しの INSERT に行が1つも付かなければ同じトリガーを見出し側にも置いて `min_lines` で断る。
- Produces（書き換え不可）: `private.reject_accounting_mutation()` を `accounting_accounts`・`accounting_journal_entries`・`accounting_journal_lines` の BEFORE UPDATE OR DELETE（行ごと）と、別に BEFORE TRUNCATE（文ごと。TRUNCATE は文のトリガーしか付けられない）の2本ずつ付け、`ACCOUNTING_HISTORY_IMMUTABLE` / `55000`。service_role にも postgres（所有者）にも効く（所有者が `ALTER TABLE … DISABLE TRIGGER` する操作は規程で禁じる。12-c。ここでは作りで守れる範囲まで）。
- Produces（印）: `private.accounting_event_kinds() RETURNS text[]` IMMUTABLE（TS の27種と同じ。印の前置きは種類の名前、stripe_fee だけ stripe:fee）、`private.accounting_event_arity(_kind text) RETURNS integer` IMMUTABLE、`private.accounting_event_key(_kind text,_parts text[]) RETURNS text` IMMUTABLE（TS の `buildEventKey` と同じ文字列。規則違反は `ACCOUNTING_ARGUMENT_INVALID / 22023`）。
- Produces（入れる関数。2段）: ①中身だけの `private.accounting_post_journal_core(_actor_id uuid,_period_id uuid,_entry_date date,_event_kind text,_event_parts text[],_description text,_lines jsonb,_reverses_entry_id uuid DEFAULT NULL,_reason text DEFAULT NULL,_source_table text DEFAULT NULL,_source_id text DEFAULT NULL,_recorded_at timestamptz DEFAULT NULL,_migrated_from text DEFAULT NULL) RETURNS jsonb`（DEFINER。入口なし・service_role からも REVOKE。権限は確かめない。手入力のトリガー・A8・取り消しの core・後の計画の private 関数が呼ぶ。`_recorded_at` と `_migrated_from` は `_event_kind='migrated_entry'` のときだけ使え、それ以外で値があれば `ACCOUNTING_ARGUMENT_INVALID`）。②権限を確かめてから core を呼ぶ `private.admin_post_accounting_journal(_actor_id uuid,_period_id uuid,_entry_date date,_event_kind text,_event_parts text[],_description text,_lines jsonb,_reverses_entry_id uuid DEFAULT NULL,_reason text DEFAULT NULL,_source_table text DEFAULT NULL,_source_id text DEFAULT NULL) RETURNS jsonb`（DEFINER。最初に `private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.finance.manage'])` を確かめ、外れたら `ACCOUNTING_FORBIDDEN / 42501`。G・H の本体＋入口と同じ形）と、同名・同引数・同戻り型の `public.admin_post_accounting_journal(…)`（`LANGUAGE sql SECURITY INVOKER`・service_role だけ）。`_lines` は `[{"account_code":"1160","debit":18750,"credit":0,"sub_account":null,"counterparty":null,"order_id":null,"memo":null}]`（`MAX_JOURNAL_LINES=200`）。戻りは `{"entry_id":"…","entry_no":12,"period_id":"…","created":true}`。
- core の守り: `_reverses_entry_id` があるとき、行は元の行の借方と貸方を入れ替えた物と完全に同じでなければ `ACCOUNTING_ARGUMENT_INVALID`。一般の入口（`private.admin_post_accounting_journal` と public 入口）は `_event_kind` が `reversal`・`manual_entry`・`migrated_entry`・`period_closing_entry`・`closed_year_correction` のとき `ACCOUNTING_ARGUMENT_INVALID` で断る（それぞれ専用の道具か後の計画の入口だけが core を呼ぶ）。計画1にはこの一般の入口を呼ぶ route が無い（計画2が使う）。 一般の入口は `_reverses_entry_id`・`_reason` に値があれば `ACCOUNTING_ARGUMENT_INVALID`（`reversal` は専用の道具だけ）、`_source_table = 'admin_finance_expenses'` も断る（手入力でない仕訳を手入力の source に混ぜない）。
- 擬似コード（試験で決まらない所だけ）:
  1. 権限: core は確かめない（入口の `private.admin_post_accounting_journal` だけが確かめる）。手入力のトリガーと A8 は core を直接呼び、記録の人として `_actor_id`（元の行の `created_by`。権限を失っていても、消えていても止まらない）を渡す。
  2. ロック: core は最初に `private.accounting_lock_all(_period_id)` を自分で取る（①G 共通 → ②会計の鍵 → ③期間の鍵の順。呼び手の鍵を当てにしない）。
  3. 期間を読み、`_entry_date` が `starts_on`〜`ends_on` に入らなければ `ACCOUNTING_DATE_OUT_OF_PERIOD`（11-a: 日付だけで期間を決めない。期間は呼び手が渡す。日付と事業の形から引く道具は `private.accounting_period_for`）。期首の残高の確定は要らない（期首は計算で出す。Task 7）。
  4. 取り消し（`_reverses_entry_id` あり）のときは、印を見る前に先頭で行う: 元を `FOR SHARE` で読み、元が `reversal` なら `ACCOUNTING_ARGUMENT_INVALID`。`reverses_entry_id = 元` の見出しが既にあれば、理由・日付・行が同じなら `{created:false, 既存の entry_id, entry_no}`（同じ内容の再送は前の結果）、違えば `ACCOUNTING_ALREADY_REVERSED / 23505`。無ければ 7 へ進む。
  5. 取り消し以外の印: `dedupe_key = private.accounting_event_key(_event_kind, _event_parts)`。`content_hash = sha256(period_id | event_kind | entry_date | 行を line 順に account_code,debit,credit,sub_account,counterparty,order_id を並べた文字列)`（摘要 `description` は入れない: 言い回しだけの違いは同じ出来事の再送とみなす）。同じ `dedupe_key` が既にあり、`content_hash` が同じなら `{created:false, 既存}` を返して何もしない。違えば `ACCOUNTING_DEDUPE_CONTENT_MISMATCH / 23505`（期間・相手が違う誤りもここで見える。種類が違えば印も違う）。この確かめは G の鍵の中で、採番の前に済ませる。
  6. 採番は、見出しを入れると決まってから行う: `UPDATE accounting_period_sequences SET last_entry_no = last_entry_no + 1 WHERE period_id = _period_id RETURNING last_entry_no`（行が無ければ先に1行入れる）→ その番号で見出しを INSERT。G の鍵が全体を直列化するので競合は起きないが、念のため一意制約の違反は 4 か 5 へ戻して再判定する。印の確かめに失敗した入力は番号を取らないので、番号が空かない。
  7. 行を `line_no` 1..n で入れる。`is_late = (timezone('Asia/Tokyo', recorded_at))::date > (_entry_date + interval '2 months')::date`（12-a2: 普通の入力の期間は最長2か月）。ただし `_migrated_from IS NOT NULL` のときは `false`。
  8. 取り消しの一意違反（`reverses_entry_id` の UNIQUE の 23505）は `ACCOUNTING_ALREADY_REVERSED` に直す（4 で先に判定済みの保険）。
- Produces（取り消しの道具。2段）: `private.accounting_reverse_journal_core(_actor_id uuid,_entry_id uuid,_reason text,_entry_date date DEFAULT NULL) RETURNS jsonb`（入口なし・権限は確かめない。手入力のトリガー・A8・後の計画の private 関数が呼ぶ）と、権限を確かめる `private.admin_reverse_accounting_journal(同じ引数)` ＋ 同名の `public.admin_reverse_accounting_journal(…)`（INVOKER・service_role だけ）。入口の権限は `admin.finance.manage`（手入力の取り消し）。締めた年の訂正や返品の届いた日の直しなど `admin.accounting.entries.correct` を要する取り消しは、後の計画が自分の入口で権限を確かめてから core を呼ぶ。元の行の借方と貸方を入れ替えた行で `accounting_post_journal_core` を `event_kind='reversal'`・`parts=[_entry_id::text]`・`reverses_entry_id=_entry_id` で呼ぶ。`_entry_date` が NULL なら元の日（2-f: 取り消す日は元の日）。期間は「その日を含む、元と同じ事業の形の期間」を `private.accounting_period_for(_entry_date, 元の期間の事業の形)` で引く（無ければ `ACCOUNTING_PERIOD_MISSING`）。戻りは post と同じ jsonb。取り消しの取り消しは作らない（元が `reversal` なら `ACCOUNTING_ARGUMENT_INVALID`）。
- Produces（道具）: `private.accounting_period_for(_date date,_business_type text) RETURNS uuid`（STABLE。その日を含む期間の id。無ければ `ACCOUNTING_PERIOD_MISSING`。計画2〜6 の出来事の仕訳が使う）、`private.accounting_jst_date(_at timestamptz) RETURNS date`（STABLE。`(_at AT TIME ZONE 'Asia/Tokyo')::date`。TS の `toJstDate` と同じ日を返す。1-e）、`private.accounting_lock_all(_period_id uuid DEFAULT NULL) RETURNS void`（ロック順の①②③。入口なし）。
- Produces: 追加 fixture `seedAccountingPeriod(client:PgClient,input:{businessType:'soleProprietor'|'corporation';startsOn:string;endsOn:string}):Promise<string>`、`postJournal(client:PgClient,input:{periodId:string;entryDate:string;kind:string;parts:string[];lines:{account:string;debit?:number;credit?:number}[]}):Promise<{entryId:string;entryNo:number;created:boolean}>`。
- Produces: S2 assert DETAIL `acc_s2_tables`・`acc_s2_constraints`・`acc_s2_triggers`・`acc_s2_rls_acl`・`acc_s2_immutable`・`acc_s2_event_kinds`・`acc_s2_accounts_seed`・`acc_s2_function_attrs`・`acc_s2_existing_dml_allowlist`。

- [ ] **Step 1: 失敗する試験を書く（共通制約の ROLLBACK の形で。並行の試験だけはコミットし、他の suite と別の jest 実行で流して前後に `db reset` する）。** `FREQ-554-AC-01: 借方と貸方が合わない仕訳と片側だけの行と0と負と小数の額と1行の仕訳を断る`（4つの DETAIL `balance`・`one_sided`・`sign`・`min_lines`）、`FREQ-554-AC-01: 見出しと行は1つのトランザクションで入り行の途中の失敗で見出しも残らない`、`FREQ-554-AC-02: 保存した見出しと行のUPDATEとDELETEとTRUNCATEは所有者でも断られる`、`FREQ-554-AC-03: 同じ印で同じ内容を2回入れると1本のままcreated=falseを返す`、`FREQ-554-AC-03: 同じ印で期間・相手のどちらかが違えばDEDUPE_CONTENT_MISMATCH`、`FREQ-554-AC-03: 同じ印を同時に入れても1本だけが残り通し番号に欠番ができない`（並行。`pg_blocking_pids` で待ちを観測、3連続成功）、`FREQ-554-AC-03: 種類の一覧と印の文字列はTSのbuildEventKeyと一致する（stripe_feeは stripe:fee: の形）`、`FREQ-554-AC-04: 取り消しは元の借貸を入れ替えて元1本につき1回だけ`、`FREQ-554-AC-04: 同じ内容で取り消し直すとcreated=falseで前の結果を返し、違う理由や日ならALREADY_REVERSED`、`FREQ-554-AC-04: 同じ元を同時に取り消しても1本だけ`、`FREQ-554-AC-04: 取り消しの取り消しは作れず、取り消しの仕訳には必ず元の番号と理由が付く`、`FREQ-554-AC-05: timestamptzを日本時間の日付に直すSQLの道具はTSのtoJstDateと同じ日を返す`、`FREQ-554-AC-06: DBの勘定とTSの勘定の符号が一致し9999がある`、`FREQ-554-AC-07: 会計の表はanonとauthenticatedに権限が無くservice_roleはSELECTだけで直接INSERTできない`、`FREQ-554-AC-08: 仕訳の日が期間の外ならDATE_OUT_OF_PERIOD`、`FREQ-554-AC-09: 登録した日時と通し番号と遅れの印は呼び手が渡せず通し番号は期間ごとに欠番なく増える`、`FREQ-554-AC-09: 登録が日付から2か月を超えると遅れの印が付く`、`FREQ-554-AC-07: 入口は権限なしを42501で断り、coreは直接呼べない`、`FREQ-554-AC-04: 取り消しのcoreは元と違う額の行をARGUMENT_INVALIDで断る`、`FREQ-554-AC-03: 一般の入口はreversal・manual_entry・migrated_entry・period_closing_entry・closed_year_correctionを断る`、`FREQ-554-AC-03: 一般の入口は_reverses_entry_idと_reasonの値と、_source_tableがadmin_finance_expensesの指定を断る`。
- [ ] **Step 2（controller）: RED を測る。** `npx.cmd jest tests/integration/db/accounting_p1_journal.integration.test.ts tests/integration/db/accounting_p1_migration_asserts.integration.test.ts --runInBand`。表が無い失敗を記録し、接続の失敗を RED に数えない。
- [ ] **Step 3: S2 を実装する。** 上の Interfaces どおり。関数は core（権限なし・入口なし）・権限を確かめる `private.admin_*`・同名の public 入口（INVOKER・service_role だけ）の3段に分ける。SQL は ASCII、勘定の行は生成スクリプトの出力を貼る。
- [ ] **Step 4（controller）: 共通 verify で GREEN を測る。** 末尾 assert を SAVEPOINT 内で、RLS 無効/追記専用トリガー無効/UNIQUE 欠落/CHECK 欠落/別 overload へ1つずつ改ざんして流し、55000 と対応 DETAIL を検査する。並行は3連続成功。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 仕訳の表と入れる関数と取り消しの道具を追加する`

### Task 7: 設定・期間・期首の残高・読み口

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-555 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts3>_accounting_p1_period_reads.sql`、`tests/integration/db/accounting_p1_periods.integration.test.ts`、`tests/integration/db/accounting_p1_opening.integration.test.ts`、`tests/integration/db/accounting_p1_reads.integration.test.ts`
- Test: 上の DB 3 suite と Task 6 の migration_asserts の更新
- Read: `src/lib/finance/year-end.ts:157-163`（今の年越しの式）、`src/lib/finance/accounts.ts`

**Interfaces:**
- Produces（表）: `accounting_settings(id smallint PK CHECK (id = 1), business_start_date date NULL, cutover_on date NOT NULL, current_business_type text NOT NULL DEFAULT 'soleProprietor', version bigint NOT NULL DEFAULT 1, updated_by uuid, updated_at timestamptz, admin_requests jsonb NOT NULL DEFAULT '{}')`（1行。S3 が入れる。`cutover_on` は S3 を適用した日本時間の日）。`accounting_opening_balances(period_id uuid FK, account_code text FK, signed_amount bigint NOT NULL, closing_version integer NOT NULL DEFAULT 1 CHECK (closing_version >= 1), source text NOT NULL CHECK in ('initial','closing_carryover'), source_period_id uuid NULL FK, PRIMARY KEY (period_id, closing_version, account_code))` は追記専用（計画6が締めた版の期末から取る行をここへ足す。計画1の間に行は入らない）。 `current_business_type` の役目: 取引の日に個人と法人の期間が両方ある時の選び方と、設定画面の既定の事業の形にだけ効く（Task 9）。
- Produces（期間の制約）: 期間の INSERT に付ける DEFERRABLE INITIALLY DEFERRED の constraint trigger `private.accounting_check_period_layout()`。同じ `business_type` の中で、重なりがあれば `ACCOUNTING_PERIOD_OVERLAP`、始まり順に並べて隣の `starts_on` が前の `ends_on + 1日` でなければ `ACCOUNTING_PERIOD_GAP`（11-d）、長さの CHECK 違反は `ACCOUNTING_PERIOD_TOO_LONG` に直す。期間の UPDATE は `name`・延長の月・`consumption_tax_status`・`consumption_taxable_from`・`version` 以外を断る（日付と事業の形は変えられない。DELETE/TRUNCATE は断る）。
- Produces（書く関数。private 本体＋service_role 専用の public 入口）:
  - `admin_create_accounting_period(_actor_id uuid,_business_type text,_starts_on date,_ends_on date,_name text,_request_key uuid) RETURNS jsonb`。権限 `admin.accounting.settings.manage`。同じ `_request_key` で同じ内容は再送として前の結果、違う内容は `ACCOUNTING_REQUEST_KEY_CONFLICT`。戻りは期間1件の jsonb（鍵は下の読み口と同じ）。
  - `admin_update_accounting_settings(_actor_id uuid,_business_start_date date,_current_business_type text,_expected_version bigint,_request_key uuid) RETURNS jsonb`。権限 `admin.accounting.settings.manage`。`business_start_date` が既に入っていて値が違えば `ACCOUNTING_SETTINGS_LOCKED`（11-k: 選び直せない。同じ値の再送は通す）。版が違えば `ACCOUNTING_VERSION_CONFLICT`。
  - `admin_update_accounting_period_filing(_actor_id uuid,_period_id uuid,_corporate_tax_extension_months smallint,_consumption_tax_extension_months smallint,_consumption_tax_status text,_consumption_taxable_from date,_expected_version bigint,_request_key uuid) RETURNS jsonb`（11-h の延長と、課税事業者か免税事業者か・課税事業者になった日。設計 5-j・15-c2）。延長は法人の期間だけ。要求番号は `accounting_periods.admin_requests` に置く。消費税の延長は法人税の延長を受けた法人だけ（`consumption <= corporate` の CHECK）。`taxable` のときは `_consumption_taxable_from` が期間の中の日で必須、`exempt` のときは NULL。
- Produces（読み口。STABLE・service_role 専用・actor なし。`list_shipment_accounting_inputs` と同じ「service-only accounting boundary」）:
  - `public.get_accounting_settings() RETURNS jsonb`
  - `public.list_accounting_periods() RETURNS SETOF jsonb`（始まり順）
  - `public.get_accounting_opening(_period_id uuid) RETURNS TABLE(account_code text, signed_amount bigint, basis text)`
  - `public.list_accounting_journal(_period_id uuid,_from date DEFAULT NULL,_to date DEFAULT NULL,_limit integer DEFAULT 100,_after_entry_no bigint DEFAULT NULL) RETURNS jsonb`（`MAX_JOURNAL_PAGE=200`。`{entries:[SavedJournalEntry の形],next_after:12}`。仕訳の日→通し番号の順。12-b: 画面は通し番号順でなく仕訳の日で並べる）
  - `public.get_accounting_trial_balance(_period_id uuid,_through date DEFAULT NULL) RETURNS TABLE(account_code text, debit_total bigint, credit_total bigint, opening_signed bigint)`
- 読み口の jsonb の鍵（snake_case。TS の store が camelCase へ直す）: 期間 `{id,business_type,name,starts_on,ends_on,corporate_tax_extension_months,consumption_tax_extension_months,consumption_tax_status,consumption_taxable_from,version,legacy_fiscal_year}`、設定 `{business_start_date,cutover_on,current_business_type,version}`、仕訳 `{id,period_id,entry_no,entry_date,event_kind,dedupe_key,description,recorded_at,recorded_by,is_late,reverses_entry_id,reason,source_table,source_id,migrated_from,migrated_at,lines:[{line_no,account_code,debit,credit,sub_account,counterparty,order_id,memo}]}`。手入力・移しかえの仕訳（`source_table='admin_finance_expenses'`）にだけ `legacy:{revision_count,receipt_count}` を足す（元の `admin_finance_entry_revisions` と `admin_finance_receipts` の件数を読み口が数えて返す。2-j の「移した仕訳から見られる」を表を増やさずに満たす）。
- Produces（期首の計算。`private.accounting_opening_balances(_period_id uuid) RETURNS TABLE(account_code text, signed_amount bigint, basis text)`）:
  1. その期間の `accounting_opening_balances` に行があれば `basis='stored'` で返す。版の選び方: 個人は `closing_version` が最も大きい行、法人は `closing_version = 1`（株主総会で確定した版1。税のためだけの版2以後は期首に使わない。3-c・10-c・10-e）。
  2. 無ければ、同じ `business_type` で `ends_on = 当期の starts_on − 1日` の期間（前の期間）を探す。無ければ空（`basis='none'`。法人の第1期と事業の最初の期間は全勘定0）。
  3. あれば（3-d。前の期間を締めていない）前の期間の期首（再帰）＋前の期間の仕訳の合計から前の期末を出し、`carryover_role` ごとに次の期首へ写す。`carry`（資産・負債・他の純資産）はそのまま、`pl_zero`（収益・費用）は0、個人は `owner_draw` と `owner_contribution` を0にして `capital_sole`（2910）の貸方残 = 前の2910 + 控除前の所得（収益−費用） + 事業主借の貸方残 − 事業主貸の借方残（3-e。今の年越しの式）、法人は `pl_zero` を0にして `retained_corp`（3040）の貸方残 += 当期純利益（3-e）。結果の合計（借方−貸方）は0になる。
  4. 事業の形が違う前の期間は探さない（3-c。個人から法人へ写す道を作らない）。`accounting_opening_balances` へ行を入れる private 関数 `private.accounting_store_opening(_actor_id,_period_id,_rows jsonb,_source,_source_period_id)` は、`source_period_id` の期間の事業の形が違えば `ACCOUNTING_OPENING_TYPE_MISMATCH`、資産の総額と負債の総額の差が元入金（または純資産）と合わなければ `ACCOUNTING_OPENING_UNBALANCED`（3-f）、法人の第1期（前の期間が無い）へ `initial` で0以外を入れるのは `ACCOUNTING_OPENING_TYPE_MISMATCH` で断る（3-c: 第1期は全部0）。これは service_role 専用の private で、public 入口は作らない（計画6が使う）。
- Produces（private の型）: `private.accounting_store_opening(_actor_id uuid,_period_id uuid,_rows jsonb,_closing_version integer,_source text,_source_period_id uuid) RETURNS integer`（`_rows` は `[{"account_code":"1040","signed_amount":120000}]`。戻りは入れた行数）。`private.accounting_ensure_individual_periods(_year integer,_actor_id uuid) RETURNS SETOF uuid`（作った期間の id。範囲は開業日の年〜今の日本時間の年+1 の外を `ACCOUNTING_ARGUMENT_INVALID` で断る。開業日が未入力なら下限は 2025）。
- Produces: S3 assert DETAIL `acc_s3_settings_row`・`acc_s3_period_layout_trigger`・`acc_s3_functions`・`acc_s3_rls_acl`・`acc_s3_reads_stable`。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-555-AC-01: 期間は重なりとすき間と1年超を断り受理は事業の形ごとに続く`（個人2026と2027の前半、法人の第1期、個人と法人が日付で重なる登録は事業の形が違うので通る）、`FREQ-555-AC-01: 期間の日付と事業の形のUPDATEとDELETEは断られる`、`FREQ-555-AC-01: 期間の作成は権限なしを42501で再送は同じ結果を返す`、`FREQ-555-AC-02: 個人の最後の期間の期末は法人の第1期の期首に写らない`、`FREQ-555-AC-02: 事業の形が違う期間を元にした期首の保存を断る`、`FREQ-555-AC-03: 個人の翌年の期首は元入金＝資産−負債で事業主貸と事業主借と損益が0になる`（前の年に売上と経費と事業主貸借（1910 と 1920 の両方）を入れて 3-e の式を数値で固定する）、`FREQ-555-AC-03: 法人の第1期は全勘定と在庫が0で個人の最後の期間に在庫があっても変わらない`（3-g3）、`FREQ-555-AC-03: 法人の次の期は損益が0になり繰越利益剰余金へ当期純利益が入る`、`FREQ-555-AC-04: 期間で数える読み口は注文を作った日でなく仕訳の期間で絞り日付順に並べる`、`FREQ-561-AC-03: 開業日は1度入れると別の値に選び直せず同じ値の再送は通る`、`FREQ-555-AC-06: 設定の版が違えば更新できない`、`FREQ-555-AC-06: 期首は個人なら最も新しい版、法人なら版1の行を選び版2は使わない`、`FREQ-555-AC-01: 消費税の延長は法人税の延長より大きくできない`、`FREQ-555-AC-04: 日付と事業の形から期間を引く道具は無ければPERIOD_MISSINGを返す`、`FREQ-555-AC-01: 範囲の外の年の個人の期間は作らず断る`、`FREQ-555-AC-01: 課税か免税かの欄は、免税ならNULL、課税なら期間の中の日だけを受け、日付と事業の形は変えられない`。
- [ ] **Step 2（controller）: RED を測る。** 上の3 suite。
- [ ] **Step 3: S3 を実装する。** 期間の制約トリガーは `FOR EACH ROW` の遅延 constraint trigger にして、同じ取引の中で複数の期間を作る A8 が最後にまとめて検査される形にする。期首の計算は再帰を `WITH RECURSIVE` でなく関数の再帰にしてよい（期間は数年分）。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify。S3 の末尾 assert の改ざん試験。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 設定と会計の期間と期首の計算と読み口を追加する`

### Task 8: TS の store と route（期間・設定・仕訳の読み）

controller が別セッションへ新しい route の追加を先に知らせる（`route-inventory.md`・`api-spec.md` を Task 15 で直す）。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-555・561 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `src/lib/accounting/accounting-types.ts`（`ACCOUNTING_ERRORS`、`AccountingStoreError`）、`src/lib/accounting/accounting-schema.ts`、`src/lib/accounting/accounting-store.ts`（`server-only`）、`src/lib/accounting/accounting-route.ts`、`src/app/api/admin/accounting/periods/route.ts`、`src/app/api/admin/accounting/periods/[id]/filing/route.ts`、`src/app/api/admin/accounting/settings/route.ts`、`src/app/api/admin/accounting/journal/route.ts`、`tests/unit/lib/accounting/accounting-store.test.ts`、`tests/unit/api/admin/accounting-periods-route.test.ts`、`tests/unit/api/admin/accounting-settings-route.test.ts`、`tests/unit/api/admin/accounting-journal-route.test.ts`
- Test: 上の単体4本と型
- Read: `src/lib/discounts/admin-discount-route.ts`（`handleDiscountList`・書込の順序の手本）、`src/lib/discounts/admin-discount-store.ts`

**Interfaces:**
- Consumes: Task 7 の public 入口。`authorizeAdminPermission(code, request)`、`requireCsrfOrDeny`、`enforceRateLimit`、`logAudit`。
- Produces（route）:
  - `GET /api/admin/accounting/periods` → `{data:{periods:AccountingPeriod[];settings:AccountingSettings;deadlines:Record<string,FilingDeadline[]>;startup:StartupDeadline[]}}`。権限 `admin.finance.read`。期限は Task 5 の関数でサーバー側で計算する（`isJpHoliday` を使い、期間の `consumptionTaxStatus` で消費税の期限を出し分ける）。祝日の表の無い年の期限は `holidayTableMissing:true` を付けて返す（GET は落とさない）。期間が1つも無い時は `periods:[]` を返す（404 にしない）。
  - `POST /api/admin/accounting/periods`（期間の作成）。権限 `admin.accounting.settings.manage`。body `{businessType,startsOn,endsOn,requestKey}`（`name` はサーバーが `formatPeriodName` で作る）。事前に `validateNewPeriod` を通し、DB の拒否と同じ code で返す。監査 `admin.accounting.period.create`（metadata に `period_id` と `result_code` だけ）。
  - `PUT /api/admin/accounting/periods/[id]/filing`（法人税・消費税の延長と、課税事業者か免税事業者か・課税事業者になった日。body に `consumptionTaxStatus`・`consumptionTaxableFrom` を足す）。権限同上。監査 `admin.accounting.period.filing`。
  - `GET/PUT /api/admin/accounting/settings`。GET は `admin.finance.read`、PUT は `admin.accounting.settings.manage`（`businessStartDate`・`currentBusinessType`・`expectedVersion`・`requestKey`）。監査 `admin.accounting.settings.update`（値は入れず `changed_fields` の名前だけ）。
  - `GET /api/admin/accounting/journal?periodId=&from=&to=&limit=&afterEntryNo=`。権限 `admin.finance.read`。`{data:{entries:SavedJournalEntry[];nextAfter:number|null;opening:OpeningBalanceRow[]}}`。 期間が無い・`periodId` 省略で期間が無いときは `{entries:[],nextAfter:null,opening:[]}` を返す。
- Produces（store）: `listAccountingPeriods(client)`・`getAccountingSettings(client)`・`createAccountingPeriod(client,actorId,input)`・`updateAccountingSettings(client,actorId,input)`・`updatePeriodFiling(client,actorId,input)`・`listSavedJournal(client,query)`・`getOpeningBalances(client,periodId)`。失敗は message と SQLSTATE の完全一致で `AccountingStoreError` に分類（`ACCOUNTING_ERRORS`）。
- 順序: 書込は 認可 → CSRF → IP の制限 → actor の制限 → zod → store → 監査 → 応答。回数の制限の窓は 600 秒。IP は `getClientIp` だけ、actor は `authz.userId`。全応答が no-store。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-555-AC-01: 期間の作成routeはaal1/権限なし/CSRF欠落/429/不正入力でstoreを呼ばない`、`FREQ-555-AC-01: 期間の作成は事前検査と同じcodeでDBの拒否を返す`（overlap/gap/too_long）、`FREQ-555-AC-04: 仕訳の読みrouteはperiodIdを検証しno-storeで返し本文に不要な識別子を含めない`、`FREQ-561-AC-03: 設定のPUTは開業日の選び直しを409とSETTINGS_LOCKEDで返す`、`FREQ-561-AC-01: 期間の一覧は期間ごとの期限と開業日の期限を含む`、`FREQ-561-AC-04: 監査に名前・金額・開業日の値を入れない`、`FREQ-555-AC-04: 期間が1つも無いときは404でなく空の一覧を返す`、`FREQ-561-AC-01: 祝日の表の無い年の期限は落とさずholidayTableMissingで返す`、`FREQ-555-AC-06: 設定の版が違えばVERSION_CONFLICTを返す`。
- [ ] **Step 2: RED を測る。** 単体4本。
- [ ] **Step 3: Interfaces どおり実装する。** 既存の `cost-profit/route.ts` は触らない（Task 10）。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 期間と設定と保存した仕訳の読みのAPIを追加する`

### Task 9: 手入力の取引を仕訳にする（DB トリガー）

controller が別セッションへ `cost-profit/route.ts` と手入力の表の挙動を先に知らせる。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-556 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts4>_accounting_p1_manual_entry_journal.sql`、`scripts/accounting/emit-manual-account-map.ts`、`tests/integration/db/accounting_p1_manual_entry.integration.test.ts`、`tests/unit/lib/accounting/manual-account-map.test.ts`
- Modify: `src/app/api/admin/kpi/cost-profit/route.ts`（`expense.create :978`・`expense.update :1050`・`expense.delete :1019` の `catch` で `ACCOUNTING_PERIOD_MISSING` を 409 の日本語に直す。書き込みの形は変えない）、`tests/unit/api/admin/cost-profit-route.test.ts`
- Modify（Task 3 の試験の直し）: `tests/integration/db/accounting_p1_grants.integration.test.ts`（履歴の表は SELECT・INSERT だけを確かめる形にする。経費の INSERT は Task 9 以後は期間と仕訳も作るので、ROLLBACK の中で『最後の次』の期間から作る）、`tests/integration/db/accounting_p1_routes_after_grants.integration.test.ts`（S4 の後は経費の作成で個人の期間と仕訳もできる、と期待を直す。コミットする試験）
- Test: 上の DB と単体
- Read: `src/lib/finance/journal.ts:50-100`（`toLines`・`buildJournal`）、`src/lib/finance/payment-methods.ts:65`、`20260901102912_remote_schema.sql:1958-1996`（`record_admin_finance_entry_revision`）

**Interfaces:**
- Produces（対応表。2つ）: `public.accounting_manual_category_map(source_text text PRIMARY KEY, account_code text NOT NULL FK accounting_accounts)`（科目名→符号。`resolveAccount` と同じく事業の形も向きも見ない）と、`public.accounting_manual_method_map(source_text text NOT NULL, direction text NOT NULL CHECK in ('expense','income'), business_type text NOT NULL CHECK in ('soleProprietor','corporation'), account_code text NOT NULL FK accounting_accounts, PRIMARY KEY (source_text, direction, business_type))`（入出金方法×向き×事業の形→資金科目。`paymentMethodAccountName`）。どちらも追記専用で、SQL は ASCII のため日本語は `U&'\XXXX'` 形で書く。行は `scripts/accounting/emit-manual-account-map.ts` の出力（`ACCOUNTS` の名前→符号、`paymentMethodAccountName` を方法×事業の形×向きで全部呼んだ結果）を `-- ACC_MANUAL_MAP_BEGIN/END` の間へ埋める。`manual-account-map.test.ts` が、全部の `(category, paymentMethod, entryType, businessType)` の組で `buildJournal` が作る借方・貸方の勘定と、この2つの表で引いた勘定が一致すること、未登録の科目名は `9999` になることを確かめる。
- Produces（トリガー）: `private.accounting_manual_entry_after_write()` DEFINER、`admin_finance_expenses` の AFTER INSERT と AFTER UPDATE に付ける。
  - 期間の決め方: `expense_date` を含む期間を探す。1つだけならそれ。個人と法人の両方があれば `accounting_settings.current_business_type` の期間。`admin_finance_years.business_type` は使わない（1年の途中の切り替えを表せないため）。期間が無く、`current_business_type` が個人なら `private.accounting_ensure_individual_periods` が暦年の期間を作る（開業日の年〜今の日本時間の年+1 の範囲だけ。範囲外は `ACCOUNTING_ARGUMENT_INVALID`。すき間なく間の年も作り、`legacy_fiscal_year` を入れる）。法人で無いときは `ACCOUNTING_PERIOD_MISSING / 55000`。期限を過ぎた期間への入力は断らず、画面が知らせる（Task 10）。
  - INSERT: `kind='manual_entry'`・`parts=[id, '0']`・日は `expense_date`・説明は `item_name`・相手は `partner`。支出（`entry_type='expense'`）は 借方=相手科目（`category`）/ 貸方=資金科目（`payment_method`）、収入は逆（`toLines` と同じ）。`recorded_at` は既定、`recorded_by` は `created_by`、`source_table='admin_finance_expenses'`・`source_id=id::text`。
  - UPDATE: 仕訳に関わる列（`expense_date`・`category`・`item_name`・`partner`・`amount`・`payment_method`・`entry_type`）か `deleted_at` が変わったときだけ動く（`created_by`・`updated_by`・`deleted_by` だけの変化では動かない）。同じ `source` の「まだ取り消されていない最新の仕訳」（見出しのうち `reverses_entry_id` に出てこず、種類が `reversal` でないもの）を `private.accounting_reverse_journal_core` で取り消す（理由 `edit` または `delete`、日は元の日）。正しい仕訳の印は `parts=[id, n]`。**n＝その行の `source` の `manual_entry` の仕訳の本数**（`reversal` と `migrated_entry` は数えない。最初は `0`。A8 の後の最初の直しも `0`）。
  - 履歴: 既存の `trigger_admin_finance_entry_revisions` は変えず、仕訳の取り消しは `admin_finance_entry_revisions` に何も書かない（二重にしない）。
  - UPDATE の順: ①NEW.`deleted_at` が NULL でなければ、新しい仕訳は足さない（未取り消しの仕訳があれば取り消すだけ、無ければ何もしない。削除済みの行の仕訳の列だけが変わる更新でも、取り消し済みの行を帳簿に戻さない）。②仕訳に関わる列が変わらなければ何もしない。③それ以外は取り消し（あれば）＋正しい仕訳。仕訳が1本も無い行の UPDATE（削除済みでないもの）は INSERT と同じに扱う。
  - 取引の行の削除と直しの履歴の守り（12-c）: `admin_finance_expenses` に BEFORE DELETE のトリガーを付けて断る（`ACCOUNTING_HISTORY_IMMUTABLE`。削除は論理削除だけ）。`admin_finance_entry_revisions` に追記専用のトリガーを付ける（INSERT は既存の `record_admin_finance_entry_revision` が行う）。許す UPDATE は1つだけ: `changed_by` が値から NULL に変わり、ほかの列は全部同じ（`IS NOT DISTINCT FROM`）。これは `auth.users` の削除が外部キーの `ON DELETE SET NULL` で出す更新で、これを断ると帳簿を触った利用者を消せなくなる。ほかの UPDATE・DELETE・TRUNCATE は断る。`admin_finance_expenses` の `created_by`・`updated_by`・`deleted_by` も `SET NULL` で行が更新されるが、仕訳に関わる列は変わらないので手入力のトリガーは何もしない。 既存の `record_admin_finance_entry_revision`（`remote_schema.sql:1958-1996`）は変えない（S4 の assert `acc_s4_legacy_trigger_untouched`）。利用者の削除で `created_by` が NULL になる更新は、既存のトリガーが `changed_by` に `NEW.updated_by` を入れて履歴を1行足す。作った人と最後に直した人が同じで `created_by` の SET NULL が先に動くと、消している最中の利用者の id を持つ履歴の行ができ、利用者の削除が外部キーで落ちる見込みがある（外部キーの動きの順に左右されるので、Step 2 で手元で測る）。
  - ロック: トリガーの先頭で `private.accounting_lock_all(period_id)` を取る。行の鍵を持った後の取得になるため、G の鍵を持つ処理が `admin_finance_expenses` の行を書かないことを試験で固定する（`FREQ-556-AC-04`）。
- Produces: S4 assert DETAIL `acc_s4_map_table`・`acc_s4_trigger`・`acc_s4_functions`・`acc_s4_legacy_trigger_untouched`（既存トリガーの定義とその有効状態が移行の前後で同じ）。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-556-AC-01: 手入力の支出の作成は借方が相手科目で貸方が資金科目の仕訳1本になり日は取引の日になる`、`FREQ-556-AC-01: 収入は貸借が逆になる`、`FREQ-556-AC-01: 更新は元の仕訳の取り消しと正しい仕訳を足し元の仕訳は変わらない`（印は `manual_entry:<id>:0` と `reversal:<元>` と `manual_entry:<id>:1`）、`FREQ-556-AC-01: 日付を別の年へ直すと取り消しは元の期間に正しい仕訳は新しい期間に入る`、`FREQ-556-AC-01: 論理削除は取り消しだけを足し正しい仕訳は足さない`、`FREQ-556-AC-01: 仕訳に関わらない列だけの更新は仕訳を足さない`、`FREQ-556-AC-01: 手入力の直しで直しの履歴の行は従来どおり1回ずつだけ増える`、`FREQ-556-AC-02: 個人で期間の無い年の取引は暦年の期間を間も含め作って入る`、`FREQ-556-AC-02: 法人で期間が無い日の取引はPERIOD_MISSINGで取引の行も残らない`、`FREQ-556-AC-02: 個人と法人の期間が両方ある日はcurrent_business_typeの期間に入る`、`FREQ-556-AC-02: 開業日の年より前や今の年+1より先の日付は期間を作らず断る`、`FREQ-556-AC-01: 削除済みで仕訳が無い行の更新は何もしない`、`FREQ-556-AC-01: 削除済みの行の仕訳の列だけを直す更新（service_roleの直書き）は取り消し済みの行を帳簿に戻さない`、`FREQ-556-AC-01: 改版の番号はmanual_entryの本数で、A8の後の最初の直しは0になる`、`FREQ-556-AC-05: 取引の行のDELETEと、直しの履歴のchanged_byをNULLにする1つ以外のUPDATEとDELETEとTRUNCATEは断られる`、`FREQ-556-AC-06: 履歴を持つ利用者を消すと履歴の行は残りchanged_byだけがNULLになる`、`FREQ-556-AC-06: 経費を作り最後にも直した利用者を消しても、経費の行と仕訳は残り手入力のトリガーは何も足さない`（履歴の行の扱いと「消せる」かどうかは、下の Step 2 の測定で決まる）、`FREQ-556-AC-04: G・Hの関数のソースがadmin_finance_expensesを書かず、手入力のトリガーが行の鍵の後にG共通鍵を取っても詰まらない`（pg_locks とソースの検索）、`FREQ-556-AC-03: 未登録の科目名は9999に入り元の名前がmemoに残る`、`FREQ-556-AC-01: 手入力の対応表はbuildJournalの借方貸方と全部の組で一致する`（単体）。route: `FREQ-556-AC-02: 経費の作成は期間が無いとき409と日本語の本文を返す`。
- [ ] **Step 2（controller）: RED を測る。** `accounting_p1_manual_entry.integration.test.ts` と単体2本。 あわせて `FREQ-556-AC-06` の2本目（経費を作り、最後にも直した利用者を消す）を手元で1回測り、結果を記録する。落ちるなら、計画1では既存の履歴のトリガーを変えず、2本目の題を「履歴の行は残り、手入力のトリガーは仕訳を足さない」までにして「消せる」を約束しない。落ちたことは「オーナーへの報告」に載せて直すかを尋ねる。
- [ ] **Step 3: S4 を実装する。** トリガーは同じトランザクションの中で動くので、仕訳が入らなければ取引の行も入らない（`FREQ-556-AC-02` の2つ目）。仕訳の説明は取引の `item_name`（DB で1〜160字、route の zod も `max(160)`）なので、DB の 500 字の上限に届かない。
- [ ] **Step 4（controller）: GREEN を測る。** 共通 verify に加え `FR-ADMIN-038`・`FR-ADMIN-029`・`FR-ADMIN-024` を production build で流す。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 手入力の取引を仕訳として残す`

### Task 10: 画面と読み口を期間で数える形にする

controller が別セッションへ `CostProfitSection` 系・`cost-profit/route.ts`・`src/lib/finance/**` の対象と開始を先に知らせる。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-557 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Modify: `src/app/api/admin/kpi/cost-profit/route.ts`（GET `:687` に `periodId` を受ける。`year` は旧入口として残し、個人の暦年の期間に結ぶ。集計の範囲 `${year}-01-01`〜`${year}-12-31` を期間の `starts_on`・`ends_on` にする。応答へ `period`・`periods`・`savedJournal`・`opening` を足す。注文は `orders.created_at` の日本時間の日付が期間に入るもの、Stripe は `stripe_created_at` の日本時間の日付が期間に入るもの）、`src/components/AccountingSection.tsx`（年の選択を期間の選択にする）、`src/components/CostProfitSection.tsx` と `src/components/cost-profit/use-cost-profit-model.ts`・`journal-view.tsx`・`ledger-view.tsx`・`trial-balance-view.tsx`・`summary-view.tsx`・`closing-view.tsx`、`src/lib/finance/journal.ts`・`year-end.ts`・`cumulative.ts`・`cumulative-balance-trend.ts`・`blue-return.ts`・`overview.ts`（直接書いた「1月1日」「12月31日」を期間の始まり・終わりの引数にする）、`src/lib/finance/stripe-journal.ts`（`mergeJournalEntries` が保存した仕訳と合成の仕訳を印で重ねない形を試験で固定するだけ。ロジックは変えない）、`tests/unit/api/admin/cost-profit-route.test.ts`、`tests/unit/lib/finance/*.test.ts`、`tests/unit/components/CostProfitSection.test.tsx`
- Modify（作り物の応答の直し）: `tests/unit/components/CostProfitSection.test.tsx`（作り物の応答に `savedJournal`・`period`・`periods`・`opening` を足す。題は変えない）、`e2e/admin-accounting-test-utils.ts` と、「会計の E2E 回帰の対象」のうち応答を作り物にしている spec（応答の組み立てを共通 helper `buildCostProfitMock(...)` に寄せ、手入力の取引ごとに対応する保存した仕訳を足す。題は変えない）
- Create: `src/lib/finance/period-range.ts`、`tests/unit/lib/finance/period-range.test.ts`、`tests/unit/components/cost-profit/period-count.test.tsx`
- Test: 上の単体と RTL
- Read: Task 1 で分けた後のファイル、`recon-part-A.md` の「1月1日が18か所」の節（`grep -n "01-01\|12-31\|1月1日\|12月31日" src` で再洗い出し）

**Interfaces:**
- Consumes: Task 7・8 の読み口（`GET /api/admin/accounting/journal` の store 関数をサーバー内で直接呼ぶ）。`SavedJournalEntry`、`savedEntryToJournalEntry`。
- Produces: `cost-profit` GET の応答に `period:AccountingPeriod|null`・`periods:AccountingPeriod[]`・`savedJournal:SavedJournalEntry[]`・`opening:OpeningBalanceRow[]`・`periodNotices:{filingDeadlinePassed:boolean;previousPeriodOpen:boolean}` を足す（既存の欄は消さない）。クライアントは、手入力の取引からの `buildJournal` による合成をやめ（保存した仕訳が正。S4 と S5 を一緒に当てるので、手入力の分が保存されていない期間は本番に残らない）、`savedJournal`（`savedEntryToJournalEntry`）＋ 注文の合成 ＋ Stripe の合成 ＋ 減価償却 ＋ 年末の整理を `mergeJournalEntries` で合わせる。期首の残高は `opening` から作り、以前の `admin_finance_years` の期首の欄からは作らない（期首の欄は0のはず。0でなければ S5 が止まる。Task 13）。`period.startsOn`・`endsOn` を `journal.ts` の締めの日・`year-end.ts` の年末の仕訳・累計の関数が引数で受ける。期間が1つも無い（`period:null`）ときは 404 でなく「期間がありません。設定・期間のタブで期間を作ってください」の空の画面を出す。`previousPeriodOpen` が真のとき「前の期間を締めていないため、数字はまだ動きます」を出し（3-d）、`filingDeadlinePassed` が真の期間（例: 期限 2026-03-16 を過ぎた2025年）への手入力・直しの画面には「この期間の申告の期限を過ぎています。入れた仕訳は取り消しと正しい仕訳として残ります」を出す（3-d の「一覧に止める」仕組みは計画6）。
- Produces: `periodRangeOf(period:Pick<AccountingPeriod,'startsOn'|'endsOn'>):{from:string;to:string;toExclusiveIso:string}`（`from`/`to` は日付、`toExclusiveIso` は次の日の 0 時 JST を UTC にしたもの。DB の timestamptz の絞りに使う）。
- 注文の売上の扱い（決める）: 計画1では今の作りを残す。`toOrderSalesTransaction`（`paid` または返金額が正の `cancelled`、`created_at` を日とする）と `buildStripeJournal` の結果を、仕訳の日（`created_at` の日本時間の日付／Stripe の残高の取引の日の日本時間）が期間に入るものだけ残す。保存した仕訳ではないので、画面の仕訳帳では「集計中（計画2で保存）」の印を付ける（注文の合成には `toOrderSalesTransaction` の結果から作る仕訳へ `order:<order.id>` の `sourceKey` を、この Task で付ける。今は `buildJournal` が `sourceKey` を持たない。Stripe の合成は今の `stripe:` のまま）。計画2が保存を始めたら、この合成を外し、`payment_confirmed:<payment_intent>` へ置き換える。年末に払い翌年に出荷する注文を出荷の期間へ移す（2章）のも計画2で、計画1では「注文を作った日の日本時間の日付」で期間に数える（今は世界標準時の日付。4章の直し）。
- 3-g（控除前の所得の一致）: 決算書を作る所（`statements.ts` の呼び出し側）で、損益計算書と貸借対照表の青色申告特別控除前の所得が一致することを確かめ、合わなければ画面に「事業主貸・事業主借の入れ漏れを確かめてください」を出す（新しい表示。`FREQ-557-AC-02`）。
- 1920（資産譲渡損）: 事業主貸の区分（1910 と 1920）の残高を期首で0にして元入金へ入れる（設計 3-e・3-f）。今の `src/lib/finance/year-end.ts:39,194-197,217` が 1910 だけを0にするのはコードの漏れなので、この Task で区分「事業主貸」の全部に直し、1920 の残高を入れた試験を `tests/unit/lib/finance/year-end.test.ts` に足す（`FREQ-557-AC-02: 年越しは事業主貸の区分の1910と1920を0にして元入金へ入れ、損益と貸借の控除前の所得が一致する`）。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-557-AC-01: 12月28日に払った注文は注文を作った日の期間に出て年を作り直しても二重に数えない`（合成の範囲。出荷の期間への移動は計画2と明記）、`FREQ-557-AC-01: 手入力の取引は保存した仕訳から一度だけ数え合成と重ならない`、`FREQ-557-AC-01: 期間を選ぶと選んだ期間の保存した仕訳と期首だけを数える`、`FREQ-557-AC-02: 損益と貸借の控除前の所得が一致し合わなければ入れ漏れを示す`、`FREQ-557-AC-03: 期間が7月15日から翌年7月14日でも累計と年末の仕訳と推移が動く`（`cumulative.ts` など4関数）、`FREQ-557-AC-03: 個人の1月1日から12月31日の期間では従来の画面の数字が同じ`（既存の `CostProfitSection.test.tsx` の35件が、作り物の応答に `savedJournal` と `period` を足しただけで、題を変えずに通る）、`FREQ-557-AC-01: 旧の year クエリは個人の暦年の期間に結ばれる`、`FREQ-557-AC-05: 期間が1つも無いときは404でなく空の画面を返し作成を案内する`、`FREQ-557-AC-05: 前の期間を締めていない間は数字がまだ動くと出し、期限を過ぎた期間への入力に知らせる`。
- [ ] **Step 2: RED を測る。** 上の単体。
- [ ] **Step 3: 実装する。** 1月1日・12月31日を直接書いた所を `grep` で洗い出し、計画の実装者の報告に表で残す（ファイル・行・直し方）。値が定数のままでよい所（締めの文言や画面の見出し）は残す。
- [ ] **Step 4（controller）: GREEN を測る。** 単体、型、lint、「会計の E2E 回帰の対象」の全部を production build で流す。作り物の応答を直した E2E は題が同じで通ることを確かめる。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 帳簿と決算書を保存した仕訳の期間で数える`

### Task 11: 設定・期間の画面と領収書の種類の選択

controller が別セッションへ `CostProfitSection` 系の対象と開始を先に知らせる。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-555・559・561 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `src/components/cost-profit/settings-view.tsx`、`src/components/cost-profit/period-picker.tsx`、`src/components/cost-profit/period-form.tsx`、`src/components/cost-profit/filing-deadlines-panel.tsx`、`tests/unit/components/cost-profit/settings-view.test.tsx`、`tests/unit/components/cost-profit/period-form.test.tsx`、`tests/unit/components/cost-profit/receipt-kind.test.tsx`
- Modify: `src/components/CostProfitSection.tsx`（`COST_PROFIT_TABS` に `settings`「設定・期間」を足す。他のタブの順と題は変えない）、`src/components/cost-profit/expenses-view.tsx`（領収書の添付に種類の選択を足す）、`src/components/cost-profit/use-cost-profit-model.ts`、`src/components/AccountingSection.tsx`（Task 10 の期間の選択を `period-picker` に差し替える）
- Test: 上の RTL3本
- Read: `src/components/DiscountSection.tsx` と `src/features/discounts/components/*`（管理画面の作り・`clientFetch`・非 ok の本文の扱い）

**Interfaces:**
- Consumes: Task 8 の route（`clientFetch`）。非 ok の応答は本文を読み切るか `response.body?.cancel()` を await する。
- Produces: 「設定・期間」タブ。①開業日（未入力なら入力欄と「一度入れると選び直せません」、入力済みなら読み取り専用）と事業の形、②期間の一覧（名前・始まり・終わり・事業の形）と追加フォーム（個人は年、法人は成立の日と決算日。1年を超えると送る前に止める）、③期間ごとの申告の期限の一覧（休みの日に繰り下がったものは「元の期限」を添え、延長を入れた法人は「延ばした分に利子税がかかります」を出す）、④法人の期間を追加する前に「決算月を変えた時は税務署へ遅滞なく届け出てください（法人税法15条）」を出す、⑤開業日から出す届け出の期限（2025年開業なら棚卸資産の評価の方法の届け出は過ぎたと、最終仕入原価法になることを出す）、⑥中間申告は、第1期は「前の期が無いため不要」と期限、第2期以後は「前の期の税額が入るまで判定できません」と出す。⑦個人の最後の期間（事業をやめた年）では所得税の年分（1月1日〜12月31日）・帳簿の期間（やめた日まで）・消費税の課税期間（1月1日〜12月31日）を分けて見せる（11-b）。⑧法人の期間に、減価償却で定額法を選ぶ届け出の期限（第1期の申告の期限。11-f）を出す。⑨祝日の表の無い年の期限には「祝日の表がまだ無いので、休みの日の繰り下げを確かめられません」を出す。⑩期間ごとに課税事業者か免税事業者かと「課税事業者になった日」を選べる（`admin.accounting.settings.manage` の人だけ）。消費税の期限は課税の期間だけに出し、免税の期間には「課税事業者になったら出します」と出す。権限の無い利用者（`admin.accounting.settings.manage` なし）には、追加・更新のボタンを出さず読み取りだけにする。
- Produces: 領収書の添付で種類を選ぶ（「電子で受け取った（PDF など）」「紙あり（画像は写し）」）。「紙あり」を選ぶと「紙の原本を残してある」の確認を必須にする。種類が `unconfirmed` の既存の領収書は一覧に「種類を確かめてください」を出す。文は穏やかな日本語、絵文字・感嘆符なし。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-561-AC-02: 設定タブは開業日の入力と事業の形と期間の一覧と期限を出す`、`FREQ-561-AC-03: 入力済みの開業日は読み取り専用で変えられない`、`FREQ-555-AC-01: 期間フォームは1年を超える入力を送る前に止めすき間を案内する`、`FREQ-555-AC-01: 権限の無い利用者には追加と更新のボタンが出ない`、`FREQ-561-AC-02: 休みの日に繰り下がった期限は元の期限を添える`、`FREQ-561-AC-02: 法人の期間の追加前に届出の案内を出す`、`FREQ-559-AC-03: 領収書の種類を選べ紙のときは原本の確認が必須で未確認の既存分に促しが出る`、`FREQ-555-AC-01: 非okの応答の本文を読み切り二重に押せない`。 さらに `FREQ-561-AC-02: 個人の最後の期間では所得税の年分と帳簿の期間と消費税の課税期間を分けて見せる`、`FREQ-561-AC-02: 法人の期間に定額法を選ぶ届け出の期限が出る`、`FREQ-561-AC-02: 免税の期間には消費税の期限が出ず、課税の期間には出る`。
- [ ] **Step 2: RED を測る。** RTL3本。
- [ ] **Step 3: 実装する。** 作る順: ①`period-picker.tsx` と `AccountingSection.tsx` の差し替え → ②`settings-view.tsx` の開業日・事業の形（読み取り専用の条件）→ ③`period-form.tsx`（個人は年、法人は成立の日と決算日。`validateNewPeriod` を送る前に使う）→ ④`filing-deadlines-panel.tsx`（Task 5 の `filingDeadlines`・`startupDeadlines` の結果をそのまま描く）→ ⑤`expenses-view.tsx` の領収書の種類。各段で RTL が通ることを確かめる。非 ok の応答は本文を読み切る。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint、390/768/1280pxの崩れを E2E（Task 14）で確かめる。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 設定と期間と申告の期限の画面と領収書の種類を足す`

### Task 12: 減価償却の月数を期間で数える（11-f・11-f2）

controller が別セッションへ `src/lib/finance/depreciation.ts` の変更を先に知らせる。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-557 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Modify: `src/lib/finance/depreciation.ts`（`depreciationForYear :143`・`depreciationSchedule :209` に期間を受ける引数を足す。暦年の呼び出しは従来と同じ値）、`src/components/cost-profit/use-cost-profit-model.ts`（期間を渡す）、`tests/unit/lib/finance/depreciation.test.ts`
- Create: `tests/unit/lib/finance/depreciation-period.test.ts`
- Test: 上の単体2本

**Interfaces:**
- Produces: `monthsInPeriod(startsOn:string, endsOn:string):number`（暦で数え、1か月に満たない端数は1か月に切り上げる。11-f・耐用年数省令5条5項）。`usedMonthsInPeriod(startedOn:string, period:{startsOn:string;endsOn:string}):number`（使い始めた日の月から期間の終わりの月までを数え、その月を1か月に数える。期間の終わりが早い個人の最後の期間は、事業をやめた日の月まで。11-f2）。
- Produces: 定額法の償却額の拡張。法人の期間が1年に満たないとき、償却率に `monthsInPeriod / 12` を掛ける（①）。期の途中で使い始めた資産は、①の後の限度額を `monthsInPeriod` で割り、`usedMonthsInPeriod` を掛ける（②）。個人の暦年（12か月）では従来の「その年に使った月数 ÷ 12」と同じ値にする。個人が事業をやめた年は、その年の償却費 ÷ 12 × 月数（11-f2。月数は1月から次の月まで）。定率法・損金経理した額と限度額を分ける法人の別表の印は計画6で作る。今の方法は `straightLine`・`lumpSum3Year`・`immediate` だけなので、定率法を指定する値 `decliningBalance` を `DepreciationMethod` に足す（型だけ。画面の選択肢には出さない）。法人の期間でこの値を渡すと `depreciationForYear` が `UnsupportedDepreciationMethodError` を投げる。個人の期間では従来の3つの値だけを受ける。
- 11-3 の例を試験で固定する: 6か月の第1期（`2027-07-01`〜`2027-12-31`）の定額法は償却率 × 6/12、`2027-09-10` に使い始めた資産は限度額 ÷ 6 × 4（9〜12月）。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-557-AC-04: 6か月の期間の定額法は償却率に6/12を掛け途中の使い始めは限度額を6で割って使った月数を掛ける`、`FREQ-557-AC-04: 月の途中の使い始めは1か月に数える`、`FREQ-557-AC-04: 個人の暦年では従来の償却額と同じ`（既存の `depreciation.test.ts` が無改造で通る）、`FREQ-557-AC-04: 事業をやめた年は月数を終わりの月までで割る`、`FREQ-557-AC-04: 法人で定率法の指定は未対応として明示的に拒否する`（黙って定額法にしない）。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/finance/depreciation*.test.ts --runInBand`。
- [ ] **Step 3: 実装する。** 暦年の呼び出しの既定を残し、期間を渡す呼び出しだけ新しい式にする。
- [ ] **Step 4: GREEN を測る。** 単体、型、lint、`FR-ADMIN-034`（固定資産と償却）を production build で流す。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 減価償却の月数を会計の期間で数える`

### Task 13: A8 の移しかえ（手入力の取引・直しの履歴・領収書）

controller が別セッションへ先に知らせる。本番への適用は Task 16 だけで行う。S5 は **既存データの移しかえ（DML）** で、S0〜S4 と違い新しい表のほかのデータに触る。ただし `admin_finance_expenses`・`admin_finance_receipts`・`admin_finance_entry_revisions` の行は読むだけで、書き換えも削除もしない。 S4 と S5 は同じ時に一緒に当てる（S5 だけ見送る道は作らない）。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-560 の自分の AC の行を、同じコミットで6列の表へ足す。要求管理ルール）
- Create: `supabase/migrations/<ts5>_accounting_p1_a8_migrate_manual.sql`、`tests/integration/db/accounting_p1_a8_migrate.integration.test.ts`、`tests/integration/db/helpers/accounting-legacy-fixtures.ts`
- Test: 上の DB 1 suite
- Read: recon-part-B の4節（本番の手入力の記録がある表と列）、`20260901102912_remote_schema.sql:108-121,173-,254-272,322-`、設計 2-j

**Interfaces:**
- Produces（元の直しの履歴の残し方）: 新しい表は作らない。移した仕訳の `source_table='admin_finance_expenses'`・`source_id` から、元の `admin_finance_entry_revisions`（`entry_id = source_id`）と `admin_finance_receipts`（`entry_id = source_id`）を引ける。件数の写しを別の表に持つと古くなるため持たない（2-j の「移した仕訳から見られるよう残す」は Task 7 の読み口の `legacy` で満たす）。
- 移しかえの手順（擬似コード）:
  1. 先頭で `pg_advisory_xact_lock(190521,1)` と会計の鍵を取り、前提を assert する: 会計の表と S4 のトリガーがある。`admin_finance_expenses` の `deleted_at IS NULL` の行数 n_live、`deleted_at IS NOT NULL` の行数 n_deleted、`admin_finance_entry_revisions` の行数 r0、`admin_finance_receipts` の行数 c0、`pg_trigger` の `trigger_admin_finance_entry_revisions` の `tgenabled` を控える。
  2. 法人の年（`admin_finance_years.business_type='corporation'`）があれば `a8_corporation_year` で止める（今は無いはず）。期首の欄（`opening_cash`・`accounts_receivable`・`fixed_assets`・`accounts_payable`・`opening_capital`）のどれかが0でない行があれば `a8_legacy_opening_nonzero` で止める（どの勘定に写すかが設計に無いため。止まったらオーナーに尋ねる。Task 16 Step 6 で本番を読んで0であることを先に確かめる）。
  2b. `admin_finance_year_closings` に行が1つでもあれば `a8_closings_exist` で止める（締めた年があると期首の扱いが変わるため。今は0件）。
  3. 取引（`deleted_at IS NULL`）の `expense_date` の最小〜最大の年に対し、`private.accounting_ensure_individual_periods` で暦年の期間を、すき間なく作る（開業日の年〜今の日本時間の年+1 の範囲の外は断る。取引の日付が2025年にもあれば2025年も作られる。2-j）。
  4. `deleted_at IS NULL` の取引を `(expense_date, id)` の昇順で1件ずつ、`private.accounting_post_journal_core` で入れる（権限は確かめない。記録の人は `created_by`。権限を失っている・消えている人でも止まらない）。`kind='migrated_entry'`・`parts=[id]`・日は `expense_date`（元の取引の日の年分のまま。開業費 1810 へは移さない）・`_recorded_at` は元の `created_at`・`_migrated_from='admin_finance_expenses'`・`source_table`/`source_id` を入れる。借貸は Task 9 の対応表と同じ規則。S4 と S5 は同じ時に当てるので S4 の後に入った取引は無いはずだが、すでに同じ `source` の仕訳がある行があれば、飛ばさず `acc_s5_counts` で止める（S4 と S5 を一緒に当てる決定と合う）。通し番号は期間ごとの採番で取引の日付の順に振られる。
  5. 論理削除済みの取引は移さない（仕訳に影響しない）。件数 n_deleted を assert の出力に残す。
  6. 末尾 assert: 移した仕訳数＝n_live（飛ばしは0）、全仕訳の貸借が一致（遅延トリガーが保証）、`admin_finance_entry_revisions` の行数が r0 のまま、`admin_finance_receipts` の行数が c0 のまま、`admin_finance_expenses` の行数が移行前と同じ、`trigger_admin_finance_entry_revisions` の `tgenabled` が同じ、移した仕訳どうしの通し番号の並びと `(entry_date, id)` の並びが一致（期間ごとに1から欠番なし）。DETAIL: `acc_s5_counts`・`acc_s5_revisions_unchanged`・`acc_s5_receipts_unchanged`・`acc_s5_numbering`・`acc_s5_triggers_unchanged`。
- 領収書8件の種類は `unconfirmed` のまま（Task 3 の既定）。種類を確かめて入れる操作は、Task 16 の後にオーナーが画面（Task 11）から行う。

- [ ] **Step 1: 失敗する試験を書く（手元 DB に本番相当の fixture を作って流す）。** `FREQ-560-AC-01: 取引18件を取引の日の順に仕訳へ移し日付は元の取引の日で登録した日時は元の作成日時になる`（fixture に論理削除2件を混ぜ、移されないことも確かめる）、`FREQ-560-AC-01: 通し番号は期間ごとに取引日の順で欠番なく振られ移した印と移した日が付く`、`FREQ-560-AC-02: 移しかえの前後で直しの履歴の行数と領収書の行数と取引の行数が変わらず履歴のトリガーが有効のまま`、`FREQ-560-AC-02: 2回目の流しはacc_s5_countsで止まり、仕訳も期間も増えない`、`FREQ-560-AC-03: 移した取引を後で直すと取り消しと正しい仕訳が足され残高が合う`（移しかえの後に S4 のトリガーが `migrated_entry` を取り消す）、`FREQ-560-AC-01: 期首の欄が0でない年があるときは移さず止まる`、`FREQ-560-AC-01: 2025年の日付の取引があれば2025年の期間も作られる`、`FREQ-560-AC-03: 移した仕訳のsource_idから元の直しの履歴と領収書を引ける`、`FREQ-560-AC-01: 締めの記録が1行でもあれば移さず止まる`、`FREQ-560-AC-01: 経費は元の取引の日の年分のまま移り開業費1810は使わない`。
- [ ] **Step 2（controller）: RED を測る。** 試験は「S0〜S3 までを当てた DB に本番相当の fixture（経費18・領収書8・履歴25）を入れ、その後 S4 → S5 の本文を順に流す」移行の再生の形で行う。作り方は `supabase db reset --version <ts3>` で S3 まで当て（CLI の旗は実装の時に `--help` で確かめる）、fixture を入れ、S4・S5 の本文を pg で順に流し、終わりに全部の `db reset` を行う（reset 済みの S0〜S5 に fixture を入れると S4 のトリガーが先に仕訳を作り、移しかえを試せない。トリガーを止める道は使わない）。コミットする試験なので別の jest 実行で流し、前後に `db reset` する。fixture は手元 DB だけに入れる。
- [ ] **Step 3: S5 を実装する。** 1つの取引の中で行う。DML は `INSERT INTO public.accounting_*` だけで、`admin_finance_*` へは `SELECT` のみ。
- [ ] **Step 4（controller）: GREEN を測る。** 手元で S0〜S5 を reset から流し、S5 の末尾 assert の改ざん試験（履歴の行を1行足す・トリガーを止める）が `acc_s5_*` で止まることを確かめる。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 手入力の取引を仕訳へ移す移行を追加する`

### Task 14: 新しい E2E

controller が別セッションへ `docs/05_Quality/tests/test-spec.md` の更新を先に知らせる。

**Files:**
- Create: `e2e/accounting-test-utils.ts`、`e2e/FR-ADMIN-128-accounting-periods-settings.spec.ts`、`e2e/FR-ADMIN-129-accounting-saved-journal.spec.ts`、`e2e/FR-ADMIN-130-accounting-permissions.spec.ts`、`e2e/FR-ADMIN-131-accounting-receipt-kind.spec.ts`
- Modify: `e2e/FR-ADMIN-109-permission-settings.spec.ts` と `e2e/permission-settings-test-utils.ts`（Task 2 で済む分を確かめる）、`e2e/admin-accounting-test-utils.ts`（作り物の応答の組み立て。Task 10）。`requirements.md` の自分の AC の行は各 Task が足し、`test-spec.md` は Task 15 が直す
- Test: 新規4本＋既存の会計 E2E（「会計の E2E 回帰の対象」の全部）の回帰
- Read: `e2e/admin-session-test-utils.ts`（`createAdminSessionActor`）、`e2e/order-admin-test-utils.ts`、`e2e/permission-settings-test-utils.ts`、`e2e/FR-ADMIN-126-discount-permissions.spec.ts`（権限の E2E の手本）

**Interfaces:**
- Consumes: S0〜S5 と route・画面。実 route の aal2/live-session は `createAdminSessionActor(db,role,aal)`。
- Produces: `withAccountingScenario<T>(name:string,run:(s:AccountingScenario)=>Promise<T>):Promise<T>`、`AccountingScenario={ip:string;periodId:string;createExpense:(input)=>Promise<number>;cleanup:()=>Promise<void>}`。試験ごとに固有の IP（`x-real-ip`）を使う。仕訳と期間は消せない（DELETE を断る）ので、期間は ①`seedAccountingPeriod` が「その事業の形の最後の期間の次に続く期間」を作る（すき間の決まりと合う）、②E2E を流す前に `db reset` して基準の状態から始める、の2つで扱う。個人の暦年の期間を遠い将来の年に作る道は、トリガーが間の年を全部作る・上限（今の日本時間の年+1）で断られるので使わない。cleanup は自分が作った取引の論理削除と、試験用の session だけ（試験用の利用者は消さない。E2E の前に `db reset` するので消す必要が無い）。経費を作って直した利用者は、既存の履歴のトリガーの動きで消せない見込みがある（Task 9 Step 2 で測る）。仕訳と期間は消さない。役割の変更は `withPermissionScenario` の既存の復元手順を使う。

| spec | 新規テストの正確な題と assert（各 390/768/1280px） |
| --- | --- |
| ADMIN-128 | `FREQ-555-AC-01: 設定タブで期間を足し重なりと1年超が日本語で断られる`、`FREQ-561-AC-02: 設定タブに申告の期限と開業日の案内が出る`、`FREQ-561-AC-03: 入力済みの開業日は画面で変えられない`。画面横幅内、ボタンの無効化、非 ok の本文の読み切り |
| ADMIN-129 | `FREQ-556-AC-01: 手入力の取引を作ると帳簿の仕訳帳に出て直すと取り消しと正しい仕訳が並ぶ`、`FREQ-557-AC-01: 期間を選ぶと選んだ期間の仕訳だけが試算表に出る`。仕訳帳は仕訳の日の順（通し番号の順でない） |
| ADMIN-130 | `FREQ-553-AC-01: 会計の新しい権限は店長にあり未付与のサポーターは操作できず付与後だけ操作できる`（DB と HTTP の両方）、`FREQ-553-AC-01: 管理routeは結付いたaal1を403、失効app sessionを401で拒む`、`FREQ-553-AC-04: 表の権限を締めた後も本物のcost-profit GETと経費の作成と更新とreceiptのPOSTとproduct-costs GETが手元DBで200を返し、authenticatedのJWTで会計の表を直接読むと断られる`（応答を作り物にしない。HTTP と DB の両方で確かめる） |
| ADMIN-131 | `FREQ-559-AC-03: 領収書を電子で添付でき紙を選ぶと原本の確認が必須になる`、`FREQ-559-AC-03: 種類が未確認の領収書に促しが出る` |

- [ ] **Step 1: 上表の失敗する試験を書く。** helper をまだ実装しない。表示差替えと DB 経由の別を test-spec に明記し、実 Stripe の証拠と誤記しない（会計の E2E に Stripe の実呼び出しは無い）。
- [ ] **Step 2（controller）: RED を測る。** production build/手元 DB を用意し `npx.cmd playwright test e2e/FR-ADMIN-128-accounting-periods-settings.spec.ts e2e/FR-ADMIN-130-accounting-permissions.spec.ts --workers=1 --retries=0`。helper 未定義の失敗は道具の RED であり画面の回帰の RED とは言わない。起動/権限/Docker の障害は RED に数えない。
- [ ] **Step 3: helper と4本を接続する。** exact な role/name を使い、応答の本文を読み切る。rate-limit を全体で無効にせず IP を分ける。
- [ ] **Step 4（controller）: GREEN を測る。** `npm.cmd run build` 後、port3000 の production server で新4本と「会計の E2E 回帰の対象」の全部と `FR-ADMIN-109`、390/768/1280 を `--retries=0` で流し、件数・pass/fail/skip を実測で記録する。3000番に残った E2E 用でないアプリを先に止める。
- [ ] **Step 5（controller）: Files だけコミットする。** `test(accounting): 期間と設定と保存した仕訳と権限のE2Eを追加する`

### Task 15: 文書の正本の更新

controller が別セッションへ先に知らせる（`db-migrations.md`・`test-spec.md`・台帳・`docs/06_Operations/README.md` は共有の文書）。会計・KPI は `scripts/trace/scope.json` の範囲の外なので、CLAUDE.md の「範囲に入っていない領域」の表に従い、同じコミットで直す。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-553〜561 の6列の行。各 Task が足した物を確かめ、足りない行を足す）、`docs/03_BasicDesign/architecture/` の権限の目録を書いた文書（`grep -rn "32" docs/03_BasicDesign/architecture` で権限の数を書いていれば38にする）、`docs/03_BasicDesign/api/api-spec.md`・`route-inventory.md`（Task 8 の新 route 4ファイル・6つの手続きと、`cost-profit` の GET の応答の追加、`receipt` の `evidenceKind`）、`docs/03_BasicDesign/data/er.md`（新しい表と `admin_finance_receipts` の列、旧 `admin_kpi_monthly_records` の食い違いは計画2に残す）、`docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md`（設定・期間タブ）、`docs/04_DetailDesign/pages/` の会計の頁・`sequence/`（手入力→仕訳のトリガー）・`states/`（期間）・`docs/04_DetailDesign/shared/finance.md`（科目 162 件、Task 4 で済む分を確かめる）、`docs/05_Quality/tests/test-spec.md`（手で書く）、`docs/06_Operations/db-migrations.md`（S0〜S5 の目的・適用順・assert・戻し方）、`docs/06_Operations/README.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（台帳の S-2・領収書のバケット・admin_finance_* の権限の締め直しの状態欄）
- Create: `docs/06_Operations/accounting-p1-journal-foundation.md`（仕訳を入れる関数の使い方、期間の作り方、取り消しの道具、手入力のトリガーの動き、A8 の適用の手順と戻し方、領収書の置き場）
- Test: `npm.cmd run validate-docs`、`npx.cmd jest tests/unit/docs --runInBand`

**Interfaces:**
- Consumes: Task 1〜14 の確定した名前と route。
- Produces: 各文書の冒頭の確認日の更新。`docs/05_Quality/reports/traceability-report.md` は自動生成なので手で直さず `npm run report:traceability` で作り直す。文書に書く相対リンクは `docs/README.md` または各工程の README から張る。更新不要と判断した文書は理由を完了報告に1行書く。

- [ ] **Step 1: 文書を直す。** 上の Files の順に、Task 1〜14 の実装の確定後の名前で書く（先に書いて名前が変わる食い違いを避ける）。
- [ ] **Step 2: 検証する。** `npm.cmd run validate-docs` と `npx.cmd jest tests/unit/docs --runInBand` が通る。`npm.cmd run report:traceability` の生成差分を確認し、要求表から全新 AC の試験まで辿れる。
- [ ] **Step 3（controller）: Files だけコミットする。** `docs(accounting): 計画1の仕訳の土台と期間の正本を更新する`

### Task 16（controller）: 全体検証・最終レビュー・本番を読む・適用・記録

controller が別セッションへ `docs/06_Operations/db-migrations.md`・`test-spec.md`・台帳の更新を先に知らせる。

**Files:**
- Create: `.superpowers/sdd/2026-11-04-accounting-p1/progress.md`、`final-review.md`、`production-pre-read.md`、`verification-report.md`、`report-to-owner.md`（同じディレクトリ）
- Modify: `docs/06_Operations/db-migrations.md`、`docs/05_Quality/tests/test-spec.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`、この計画のチェックボックスと未確認事項。生成レポート/graph は生成手順の出力として確認する
- Test: 計画1の全単体/DB/並行/PostgREST、既存の G・H・checkout・refund・return・status・email の回帰、E2E 全件

**Interfaces:**
- Consumes: Task 1〜15 のコミット一覧、波5のコミットと確定 helper、最新 E2E baseline（`.superpowers/sdd/2026-10-26-group-g4-orders/e2e-results-g4-full.json` を `flattenPlaywrightJson` で直して渡す）。
- Produces: `verification-report.md` はコミット/差分範囲/コマンド/RED・GREEN の実測件数/未実行境界/3連続の並行の結果/最新 baseline との差分を残す。`final-review.md` は最終 Opus レビュー（実作業は Codex または Sonnet、レビューは Opus）の対象コミット・指摘・修正コミット・再検証を残す。
- Produces: **適用の順は S0→S1→S2→S3→S4→S5。S4 と S5 は同じ時に一緒に当てる**（S5 だけ見送る道は作らない。2-j が移す前に税理士の確認を待たないと決めたため）。push はしない。

- [ ] **Step 1: 検証の判定を先に固定する。** 必須 assert: `FREQ-554-AC-01: 借貸の不一致・片側・非正を断る`、`FREQ-554-AC-03: 同じ印は並行しても1本`、`FREQ-554-AC-04: 取り消しは元1本につき1回`、`FREQ-555-AC-02: 事業の形が違う期首は写らない`、`FREQ-556-AC-01: 手入力の直しで履歴の行が従来どおり`、`FREQ-560-AC-02: 移しかえで履歴の行数が変わらない`、`FREQ-553-AC-03: 締めた表でservice_roleの処理が動く`。最新 baseline の commit/build/DB 前提から比較し、古い件数を転記しない。
- [ ] **Step 2: 追加試験の RED と各 Task の GREEN の証拠を照合する。** 欠けた RED/DB/provider の境界は未実施と書き、必要な再現を手元で実行する。全 SQL を reset して S0〜S5 と G・H の回帰、PostgREST、並行3連続を通す。過去の本文の DB 成功で最終 SQL を検証済みとしない。
- [ ] **Step 3: 単体・型・lint・docs・security を最終本文で実行する。** `npx.cmd jest tests/unit --runInBand`、`npx.cmd tsc --noEmit --incremental false`、`npm.cmd run lint`、`npm.cmd run validate-docs`、`npx.cmd jest tests/unit/docs --runInBand`。implement-component/security-check の現行 skill を読んで指定の機械検証を行う。SQL を検査しない scanner なら移行の安全の証拠にしない。
- [ ] **Step 4: production build で E2E 全件を実行し baseline と比べる。** `npm.cmd run build` → 既存の E2E 起動手順 → `npx.cmd playwright test --retries=0` → `npm.cmd run e2e:compare`。新規/置換/失敗/skip をファイルと題で説明する。計画1以外の既存の赤は勝手に直さず、前に通って後で落ちたものは単独で再実行して揺れか実装かを切り分ける。3000番に残るアプリは先に止める。
- [ ] **Step 5: 最終 Opus レビューを受ける。** Review Focus の5行・設計の行の対応表・未確認事項を渡す。重大/中を直したら影響する DB reset/build/E2E を再実行する。
- [ ] **Step 6: 本番を先に読む（数だけ。書かない）。** Supabase MCP の `execute_sql` で、次を数える: `admin_finance_expenses` の `deleted_at IS NULL`/`NOT NULL` の件数と最小・最大の `expense_date` と `fiscal_year`、`admin_finance_receipts` の件数、`admin_finance_entry_revisions` の件数（経費18・領収書8・履歴25のはず）、`admin_finance_years` の行（`business_type` と期首の5つの欄が0か。0でなければ止めてオーナーに写し先を尋ねる）、`admin_finance_fixed_assets`・`admin_finance_year_closings` の件数（0のはず）、`storage.buckets` の `finance-receipts` の設定と `pg_policies` の `storage.objects` にこのバケットを名指しするものが無いか、`pg_extension`・既存の `permissions` に `admin.accounting.%` が無いこと、12表と連番の現在の権限、S0〜S5 のバイト数/MD5/ASCII/1組の取引/末尾 assert。結果は `production-pre-read.md` へ数だけ書く（取引の中身・金額・相手を書かない）。想定と違えば適用せず理由とともにオーナーへ示す。
- [ ] **Step 7: オーナーへ適用の判断を求める。** `report-to-owner.md` に、使える物、設計の行の対応、実測/未実測、本番を読んだ数、未確認事項、次を載せる: S0〜S5 を適用してよいか（S4 と S5 は一緒）。2-j は A11 に合わせて、経費18件を元の取引の日の年分のまま移し、開業費は使わず、棚卸資産・固定資産へ分ける物は移した後に 1-c で直す、移す前に税理士の確認を待たないと決めた。分ける物の有無は税理士に確かめる（16-sr1）。無回答を承認としない。
- [ ] **Step 8: 承認された範囲だけ適用し、読むだけで確かめる。** 既存の controller 手順で適用する（大きい移行は MCP でなく CLI の `db push --linked`。この計画の移行は大きくない見込みだが、`supabase/migrations` との名前の一致を `list_migrations` で確かめ、適用した文は `schema_migrations` の `md5(statements[1])` とファイルを突き合わせる）。適用後の確かめは**読むだけ**: S0〜S5 の assert の結果、権限38件、12表と連番の権限、`finance-receipts` の設定、期間と仕訳の件数が Step 6 の読みと合うこと（仕訳は経費の未削除の件数、通し番号が1から欠番なし）、`pg_trigger` の状態。**本番に書いて確かめることはしない**（期間と仕訳は消せないため、試しの行が本物の帳簿に永く残る）。期間の作成・手入力の作成と直し・取り消しは手元の DB だけで確かめる。失敗は固定 SQLSTATE/DETAIL/適用済みの位置を残して止め、データの戻しを即興で実行しない。
- [ ] **Step 9: 記録を更新して Files だけコミットし、graph フックの結果を確認する。** 実装コードの最終変更後・commit 前に `graphify update .` を1回だけ完了し、進捗/レビュー/検証/適用の記録を更新して `docs(accounting): 計画1の検証と本番適用結果を記録する` でコミット。commit 後は `graphify hook status` を確認するだけで手動 update を重ねない。未適用なら明記し、push しない。

## 未確認事項

設計として決められなかった所と、実装・本番の読み取りで確かめる所。推測で埋めていない。

| # | 内容 | 確かめる Task / 決め方 |
| --- | --- | --- |
| 1 | **`admin_finance_years` の期首の5つの欄が本番で0か。** 設計に写し先が無いので、0でなければ S5 が止まり、オーナーと写し先を決める | Task 16 Step 6（本番を読む） |
| 2 | **本番の `finance-receipts` バケットの設定と `storage.objects` の方針。** 手作りで、移行に設定が無い。方針がバケットを名指ししていれば S1 が止まる（意図どおり） | Task 16 Step 6（本番を読む。戻す値を控える） |
| 3 | **祝日の表の公表年。** 実装の時に内閣府のページで確かめて表にする。表の無い年は画面に出す | Task 5 |

## オーナーへの報告（Task 16 の `report-to-owner.md` に載せる）

- 税理士に次に確かめる事: 棚卸資産・固定資産へ分ける物があるか（設計 16-sr1）。計画1の作りは答えに左右されない（2-j: 移した後に 1-c の取り消しと正しい仕訳で直す。移す前に税理士の確認を待たない）。
- 1920（資産譲渡損）: 今のコード（`year-end.ts`）は期首で 1910 だけを0にしていた。設計 3-e・3-f に合わせ、事業主貸の区分の 1910 と 1920 を0にするよう計画1で直す。今 1920 を使う取引は無い。オーナーが覆せる。
- 開業の届けの期限: 令和5年法律第3号 附則1条6号・10条により、新しい所得税法229条（開業した年分の確定申告の期限まで）は 2026-01-01 以後に生じた事実から当たる。2025年の開業は前の条文（事実があった日から1か月以内）。
- 消費税: 期間の設定に、課税事業者か免税事業者かと「課税事業者になった日」を持つ。今の期間は全部免税で、消費税の期限は画面に出ない。
- 利用者の削除: 経費を作って最後にも直した利用者は、既存の履歴のトリガーの動きで今も消せない見込み（前からの動きで、計画1が作った穴ではない）。Task 9 Step 2 で測った結果を載せ、落ちたなら既存のトリガーを直すかを尋ねる。

## セルフレビュー（writing-plans）

**仕様の網羅:** 設計の行から Task への対応表で（2026-11-04 の直し1・2・3で、確かめの結果と未確認事項への答え、2回目・3回目の確かめの残りを反映した）、計画1が受け持つ行（A6・A8・A10・A11・1-a〜1-e・1-a01〜1-a22 の定義と 1-a19・3-a〜3-h・7-a〜7-k・11-a〜11-k2・2-j・12-c と 12-i のうち計画1の分）を作る Task と固定する試験に結んだ。後の計画の行は「計画N」と書いた。

**型・名前:** `AccountingPeriod`・`SavedJournalEntry`・`AccountingEventKind`（27種）・`buildEventKey`・`private.accounting_post_journal_core`・`private.admin_post_accounting_journal`・`public.admin_post_accounting_journal`・`private.accounting_reverse_journal_core`・`private.admin_reverse_accounting_journal`・`public.admin_reverse_accounting_journal`・`private.accounting_period_for`・`private.accounting_jst_date`・`private.accounting_lock_all`・`admin_create_accounting_period`・`get_accounting_opening` は、Task 4・5・6・7・8・9・10・13 で同じ綴り・同じ引数で使う。権限6件の符号は Task 2 の表を正とし、Task 8 の route が使う `admin.accounting.settings.manage` と `admin.finance.read` は同表に含まれる。印の文字列は TS の `buildEventKey` と SQL の `private.accounting_event_key` が同じ（Task 6 の試験で固定）。

**Review Focus の5行:** 1行目は Task 6、2行目は Task 7、3行目は Task 9・13、4行目は Task 2・3、5行目は Task 1・10 の試験で確かめられる。
