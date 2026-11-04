# 会計の作り直し 計画7「freee・マネーフォワードへの写し」実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保存した仕訳を1本ずつ、freee・マネーフォワード（MF）の CSV と、設定でオンにする API で写す。対応の無い勘定・税区分・インボイス区分、取り込みの確認待ち、結果の分からない送信を止め、月・年度の照合と月の仮締めまでを作る。この店の仕訳・締めた版・ハッシュのつながりが正本のままとなる。

**Architecture:** 計画6の仕訳の読み口と書き出しの共通層を使い、相手ごとの差は列・変換器・`CopySafeOptions` と API adapter に閉じる。対応表・行の税の分類は改版を追記し、束は元の仕訳の集合、締めの版または開いた期間の上限番号、分類・対応表の版を固定する。CSV の確認と API の送信は同じ仕訳ごとの占有を使い、確認待ちと成功した仕訳を次の未転記分から外す。HTTP 中は DB の鍵を持たず、結果が不明なら照合してから再送する。

**Tech Stack:** 計画1〜6の Next.js `^16.3.6`、React `^19.0.0`、TypeScript `^5`、Supabase Postgres 17・PostgREST、Zod `^4.3.6`、`pg`、Jest、React Testing Library、Playwright。依存を増やさない。Shift-JIS は Node の `TextDecoder('shift_jis')` の逆引きを使う `ExportEncoder` とし、公式見本とのバイトの一致を Task 1 で確かめる。外部 HTTP は差し替えて試験する。

**Spec:** [承認済みの設計](../specs/2026-11-03-accounting-redesign-design.md)の15章全部、16章の関係する行、A1・A2・A4・A6、10-j・10-k・11-e2を正本とする。[計画1](2026-11-04-accounting-p1-journal-foundation.md)の地図・Global Constraints・共通の型・値・拒否と、[計画6](2026-11-04-accounting-p6-closing-records.md) Task 12・13の Interfaces を引き継ぐ。書式と密度は[計画5](2026-11-04-accounting-p5-inventory-cost.md)を手本とする。[brief](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-brief.md)の2026-11-05 controller の決定により API も含む。CSV は Task 1〜10、API はその完了後の Task 11〜16。

## 概要

確認日 2026-11-05、基準 `master / 9d637559`。計画1〜6と直しはコミット済みだが、計画に書かれた新しい表・関数が今の DB に実装済みという意味ではない。この文書の作成では実装・DB・ブラウザー・provider の試験をしていない。既存グラフ（36,234ノード）への `graphify query` で設計15章、会計の読み口、計画1〜6の場所を確かめた。表示は途中で切れたため、結論は各計画とソースを直接読んで確かめた。グラフの更新はしていない。

### 今の作りと引き継ぐ物

| 区別 | 根拠と計画7での扱い |
| --- | --- |
| 今の CSV | `src/components/CostProfitSection.tsx:778`・`:2766`、`recon-part-D.md:118`。ブラウザーで合成した年の仕訳を出す。これを写しの元にしない |
| 今は無い物 | `recon-part-D.md:126`、`recon-part-B.md:127`。対応表・写しの記録・API 接続は新規。今の DB に無い関数を「作り直す」と書かない |
| 計画1が用意する物 | `AccountingPeriod`・`SavedJournalEntry`・`SavedJournalLine`・`PeriodMonthSlice`、`MAX_JOURNAL_LINES=200`・`MAX_JOURNAL_PAGE=200`、`ACCOUNTING_ERRORS`、権限38件のうち `admin.accounting.export.read`。番号と日付と金額の契約を変えない |
| 計画6が用意する物 | `ExportMode`・`ExportColumn`・`ExportEncoder`・`CopySafeOptions`・`renderCopySafeCsv`・`UTF8_ENCODER`・`sha256Hex`・`sanitizeExportFileName`・`csvResponse(bytes,fileName,encoding)`・`admin_record_accounting_export`・`list_accounting_exports`・`list_exportable_entries`。共通の CSV 層を作り直さない |
| 締めた版 | 計画6 Task 2の `accounting_closing_versions` の `through_entry_no`・`opening_version`・`opening_source` と `get_closing_version_trial_balance`。版は追記専用。法人の `tax_only` の版は会計の仕訳の版として写さない |
| 注文の番号と取引先 | `src/lib/orders/order-number.ts:2` の `toOrderNumber` を使う。計画6 Task 13の `ACCOUNTING_LABELS.stripeJapan` と「一般の購入者」を使い、お客様の名前などを引かない |
| HTTP と暗号の手本 | `tests/unit/lib/stripe/accounting-sync.test.ts:1` の依存の差し込み、`tests/unit/api/webhook/resend-delivery-route.test.ts:1` の route の差し替え、`src/lib/meta/token-crypto.ts:1` のサーバー専用 AES-256-GCM。既存の Meta の暗号関数や Stripe の処理は変更しない |
| 調査・レビュー記録 | [recon-report](../../../.superpowers/sdd/2026-11-04-accounting-redesign/recon-report.md)、`recon-part-A.md`〜`recon-part-D.md`、計画2〜6の `planN-review.md`・`planN-rereview*.md`。計画6 中-12・小-14の直し（文字セルだけの式対策・応答の文字コード）と、最新定義を写す・既存の本文検査も Files に入れる決まりを Task 1・3・5・8で固定する |

### Task と移行の地図

| Task | 中身 | 移行 | FREQ | 確かめ |
| --- | --- | --- | --- | --- |
| 1 | 公式の取込形式・型・文字コード・見本 | — | 625 | 単体・見本の照合 |
| 2 | 相手の設定・勘定と税の対応表の改版 | S53 copy_settings | 626 | DB・単体 |
| 3 | 行の税の分類・経過措置・特例 | S54 copy_tax_classes | 627 | DB・単体 |
| 4 | 元の集合の固定・束・仕訳ごとの占有と履歴 | S55 copy_batches | 628 | DB・並行 |
| 5 | 1本を崩さない freee・MF CSV の組み立て | — | 629 | 単体 |
| 6 | CSV 作成・取得・仕訳ごとの成功／失敗・再出力 | — | 630 | route・store |
| 7 | CSV の月・勘定・件数の照合 | S56 copy_reconciliation | 631 | DB・単体 |
| 8 | 合った月の仮締め・変更の確認・自動計上の止め | S57 copy_month_holds | 632 | DB・並行 |
| 9 | CSV と対応表・税の確認・照合の画面 | — | 633 | RTL |
| 10 | CSV の E2E | — | 625〜633 | controller・本番 build |
| 11 | API 契約・暗号・接続・OAuth・期限 | S58 copy_connections | 634 | HTTP 差し替え・DB |
| 12 | freee の取引／振替伝票 adapter | — | 635 | HTTP 差し替え |
| 13 | MF adapter・事業者の固定・回数制限 | — | 636 | HTTP 差し替え |
| 14 | API 待ち行列・lease・不明な結果の照合と再試行 | S59 copy_api_jobs | 637 | DB・並行・HTTP 差し替え |
| 15 | API の1本ずつの照合と試算表の照合 | — | 638 | HTTP 差し替え・単体 |
| 16 | API の route・画面・E2E | — | 639 | 単体・RTL・controller |
| 17 | 正本・運用・委託と外国の記録 | — | 640 | 文書・有効化の拒否 |
| 18（controller） | 全体検証・本番を読む・適用・鍵の準備後の実接続 | — | 全部 | 境界別の記録 |

移行は7本。`supabase/migrations/<ts53>_accounting_p7_copy_settings.sql`〜`<ts59>_accounting_p7_copy_api_jobs.sql`（末尾の語は上表）。controller が実装時に S52 の後の時刻を採番し、S53→S59の順にする。適用時の既存データへの DML は0件。対応表・税の規則・接続の初期行は、移行で勝手に入れず、後日の権限のある設定操作で記録する。定数の既定値は TS と純粋な SQL helper の同じ答えの試験で守る。

## 前の計画への直しの願い

1. **計画6 Task 13の `list_exportable_entries` の JSON の鍵を明文化する。** 引数・戻り型 `RETURNS jsonb` は変えず、計画1:436の既存契約 `{entries:[SavedJournalEntry相当の見出しと全lines],next_after_date,next_after_no}` を記すだけとする。TS は `{entries:SavedJournalEntry[],nextAfter:{entryDate,entryNo}|null}`。新しい期間・版・範囲の引数や税の読み方の変更は求めない。固定した豊かな税の分類は計画7 S55の専用読み口が担う。Task 4の最初にこの既存契約を確認し、片方の目印だけで進めない。前の計画のファイルは今回変更しない。

### 決めたこと

- 仕訳一覧の DB の目印は計画1:436の `next_after_date`・`next_after_no`。未確認事項から外し、計画6への願いはこの既存契約の明記だけとした。
- APIを含み、既定オフ、CSVのTaskを先に置く。本物への試験はcontroller、鍵の準備と本番送信の承認はオーナーの担当。
- 2026-11-05 計画7の確かめから直した
- 2026-11-05 計画7の確かめ直し（1回目）から直した
- 行の税の分け方は、その行より前の行（取引日、同じ日は仕訳番号・行番号の順）の累計だけで決める。後の行・後の月の未確認や新しい仕入れで前の月の写しを止めない（AIの判断。確かめ直し2回目の中-C）。1億円の上限の行の累計の数え方は、下の規則T1で置き換えた。
- 2026-11-05 計画7の確かめ直し（2回目）から直した
- **規則T1（1億円を超える所は自動で分けない。2026-11-05 確かめ直し4回目の後に書き直し）:** 1億円の上限に関わる行の分け方は、その行を初めて束の元に固定する時に決め、後から変えない。固定は行ごとに1回だけで、target・束・出し直しをまたいで同じ物を使う（Task 3 S54の固定の表）。
  - 取引先×課税期間の経過措置の累計が1億円（税込み）以下の間は、全部の行が経過措置に入る。届く順で分け方は変わらない。
  - 1億円を超える行が出たら、その行と、その取引先×課税期間で後から来る経過措置の行（まだ固定していない行の全部）を `tax_unconfirmed` で止め、画面に「1億円の上限を超えます。分け方を税理士に確かめてください」と出す。
  - 自動で「控除なし」に分けない。止めた行は、オーナーが税理士と決めた分け方を新しい入口（Task 3 `admin_decide_accounting_copy_cap`）で入れた時だけ写せる。
- **規則T2（元の行の分け方を写す）:** 取り消し・訂正（法人の締めた年の訂正を含む）・返品の行は、元の行の固定の分け方（割合も元の行のまま）を写す。額はその行の額で、一部の額でもよい。法人の締めた年の訂正は計画6の仕訳（見つけた年の日付・`8015`・`8025`）をそのまま写す。元の行が分からない返品は、経過措置に当たる相手の物なら `tax_unconfirmed` で止め、オーナーが元の仕入れを選んだ後に写す。返品の日の割合では引かない（627-AC-06 の「元の仕入れの日で決める」とそろえる）。AIの判断で、未確認#4で税理士に確かめる。
- **規則T3（取り過ぎが起きない理由）:** 1億円以下の間は全部が経過措置なので、届く順で分け方の違いは起きない。超える所は、人が決めるまで写さない。元の行の無い返品は、元を選ぶまで写さない。人が決めた分け方も、入口が日付の順に厳密に数えた控除を超えないことを確かめる。
- **規則T4（試験）:** 全部の届く順の試験に「古い日付の仕入れが写した後に入る」「取り消し」「返品」「束の出し直し」を入れ、不変⑦〜⑩を各操作の後に検査する。⑦取引先×課税期間ごとの経過措置の合計は1億円以下、⑧写した行の分け方は変わらない、⑨1億円を超える行と元の行の無い経過措置の返品は人が決めるまで写らない、⑩写した控除の額（税額×割合、端数の前）は日付の順に厳密に数えた額を、税率（8%と10%）が混ざっても超えない。固定ベクトルは確かめの例の数字（627-AC-10〜12）と、8%と10%が混ざる例で書く。
- **送信を始めた後のjob:** `send_started_at` のあるjobは、黙って取り下げもCSVへの移動もしない。つなぎ直した後に、関門の手段（手段1は同じ冪等の鍵で送り直す、手段2は店の番号で相手の仕訳を読む）で相手にあるかを確かめて決める。手段を使えない時（再接続しない・APIをやめる・手段が無効になった）は、オーナーが相手の画面で確かめ「相手にある（写した）」「相手に無い（取り下げ）」を押す（Task 14・16）。
- **関門の結果で止める:** 相手ごとに手段1（冪等の鍵）か手段2（店の番号での不在確認）が関門で決まっていない接続は、APIのオン・enqueue・markSendingを `ACCOUNTING_COPY_DISABLED` で断る（S58の `dedupe_method`）。
- **401と403:** 401は再接続（job=reconnect_required）、403は受理されなかった確定の拒否（`permission`、job=failed）とする（AIの判断）。
- 2026-11-05 計画7の確かめ直し（3回目）から直した
- **再接続の後の付け直し:** 再接続の後の人のretryは、同じtarget・同じ相手の事業者（`remote_office_ref` と事業者の確認の証拠が新しい版に結ばれている）の時だけ、jobのbinding_versionを今の版へ付け直す。付け直しの前に関門の手段で相手にあるかを確かめる（手段1は鍵の有効期間の内なら同じ冪等の鍵、手段2は店の番号で相手の仕訳を読む）。冪等の鍵と固定の入力は変えない。
- **関門の版の一致:** `dedupe_contract_revision` と今の `CopyApiContracts` の版の一致はTS（routeとworker）が比べ、DBは `dedupe_*` が空でないことを比べる。
- **確認中の401:** verifyingの読みで401が返った時は、不明のまま（claimはresult_unknown）jobだけ `reconnect_required` にし、`failed` にしない。
- 2026-11-05 計画7の確かめ直し（4回目）から直した

## Global Constraints

- 計画1の Global Constraints 全項を適用する。今回書くのはこの計画7のファイルだけ。実装は後日 master、実装者はコミットせず、controller が各 Task の Files だけを確認して記載のメッセージでコミットする。既存差分 `.claude/CLAUDE.md`・`package.json`・`.superpowers/` を保持し、ブランチ・worktree・push を作らない。
- 移行は最初に `BEGIN;`、末尾 assert → `NOTIFY pgrst, 'reload schema';` → `COMMIT;` の1組。UTF-8/BOMなし/LF、SQL はコメント・文字列も ASCII（日本語は `U&'\XXXX'`）。既存データの清掃・補完はしない。新移行 S53〜S59の DML は上記の0件。適用済みの移行は編集しない。
- private 本体は postgres 所有・`SECURITY DEFINER SET search_path = ''`・完全修飾名。public 入口は同名同引数同戻り型の `LANGUAGE sql SECURITY INVOKER`、service_role だけ EXECUTE。読み口は `STABLE`。入口の無い helper は service_role からも REVOKE、private schema の USAGE は一括変更しない。
- 新しい表は public・RLS有効・postgres 所有、PUBLIC/anon/authenticated の権限なし。service_role は通常の記録の SELECT だけ、書き込みは private 関数。鍵の暗号文は例外として通常の SELECT も許さず、秘密専用の入口だけが読む（Task 11）。アクター列に FK を付けない。履歴・改版・束・送信結果は追記専用。占有・lease・現在値の表だけは限定した private 書き口が更新する。
- 各移行は `-- ACC_S53_FINAL_ASSERT_BEGIN/END`（後続は番号だけ変更）を持ち、拒否は `ACCOUNTING_MIGRATION_ASSERTION_FAILED / 55000`、DETAIL は各 Task の固定コードだけ。表・列・CHECK・FK・索引・RLS・所有者・ACL・属性・余分な overload と、DML 0件を意味で検査する。改ざん試験は改ざんごとに SAVEPOINT で戻す。
- 書き込みの鍵は計画1の①G共通 `(190521,1)` →②会計 `(190524,0)` →③期間 `(190524,hashtext(period_id::text))` →④対象行。`accounting_lock_all(_period_id)` を使う。複数期間は期間ID順で③を取る。新しい独立した鍵を①②の前に取らない。HTTP 中はトランザクションを閉じ、lease の claim／結果記録だけで鍵を取る。
- route の書き込みは認可 → `requireCsrfOrDeny` → IP・actor の回数制限 → Zod → DB → `logAudit`。IP は `getClientIp` だけ。actor は認可の userId。監査は固定コード・件数・内部の記録IDだけで、鍵・本文・名前・メール・取引先住所・注文番号を入れない。管理の成否とも `NO_STORE_CACHE_CONTROL`、クライアントは失敗応答の本文も消費または await cancel する。
- 権限は計画1で用意する38件を使う。CSV の作成・履歴・取得・確認は `admin.accounting.export.read`、対応表・税の方式・接続・鍵・利用のオン／オフは `admin.accounting.settings.manage`、税の行の確認は `admin.accounting.entries.correct`、仮締めとその解除は `admin.accounting.close.manage`。API への新しい送信指示は export.read と settings.manage の両方を要し、worker はその指示と接続の許可を再確認する。新しい権限は増やさない。
- DB 試験は `describeLocalDb`・`PgClient`・`adminTableTools(db)`・既存の会計 fixture を使う。RLS の回帰以外は JWT/session を作らず service_role＋actor を検査する。遅延制約は `BEGIN` → 操作 → `SET CONSTRAINTS ALL IMMEDIATE` → 検査 → `ROLLBACK`。並行など commit が必要な suite は別の Jest 実行とし、controller が前後に reset する。消せない仕訳を通常 suite の後始末で消そうとしない。
- E2E の認証は `createAdminSessionActor`、production build・手元 Supabase・port3000・390/768/1280px・試験ごとの `x-real-ip`。dev サーバーでの成功を合否にしない。計画1の会計 E2E 回帰一覧を取り直し、計画2〜6の追加分も含める。
- FREQ は **625から640**、移行は **S53からS59**、管理画面の E2E は **FR-ADMIN-157から163**。計画6の末尾は FREQ-624・S52・FR-ADMIN-156（Task 18・20・21）で確認済み。実装時に別セッションとの重なりを再確認する。会計・KPI は trace の範囲外なので要求は `requirements.md` の6列、試験名は `FREQ-NNN-AC-NN: …`。
- 共有文書・`CostProfitSection.tsx`・`src/lib/finance/**` を触る Task の最初に「controller が別セッションへ先に知らせる」と置く。編集前に最新差分を読む。計画3の返金・返品の7本、計画4の受付・期限・設定の7本、決済のファイル・関数、G・Hの書き手と閉じた一覧は変更しない。会計の月の止めは会計の core と係だけに足す。
- 実装者は単体・型・lint、controller は reset・DB・並行・PostgREST・build/E2E・provider・本番を担当する。計画作成中は Playwright・サーバー・Supabase CLI・Docker・DB試験・変更系git・`.env*` 読取をしない。サブエージェントも使わない。
- 最終コード変更後、controller が commit 前に `graphify update .` を1回完了させる。commit 後は `graphify hook status` とフックの結果を確認するだけ。今回はコードを変更しないので update はしない。
- 本番適用の前提は **計画1〜6の S0〜S52が本番に適用済み**。本番の注文は試しだけで0件（設計0-4）。本番の検証は読むだけで、試しの仕訳・束・照合・送信を作らない。移行適用とオーナーの実運用の設定はこの読取検証と分ける。
- API は既定オフ。CSV の Task 1〜10が全部終わってから Task 11を始める。試験から freee・MF の本物へ接続しない。鍵は値を計画・ログ・fixture・snapshot に書かず、試験では実行時に生成する。APIの実接続は鍵をオーナーが用意した後の Task 18だけ。Task 18 Step 7のCSVの実取込確認だけは、試しの事業者の準備後にTask 10より前へ移せ、APIの鍵を待たない。本番の仕訳を送る前には **対象事業者・仕訳の集合・件数・期間を示してオーナーの承認を取る**（2026-11-05 controller の決定）。

**共通 verify（後日の controller）:** SQL Task は未実装 DB に対する RED → 最終 SQL を含む fresh reset → anon/authenticated の既存 `items` 読取が各200 → 対象 suite → 新 public 入口の実 PostgREST（service_role 成功、anon/authenticated 拒否）。並行は `pg_blocking_pids`・`pg_locks` で待ちを観測し3連続成功、固定 sleep を使わない。変更した SQL は最終本文で reset から再試験する。HTTP 差し替えと実接続の証拠を分ける。

### 出来事と状態の共通規則（Task 4・8・14の正本）

単位は `(target_id,entry_id)`。成功とは最初の転記の確定1回を指し、全件の再出力の確認回数とは分ける。`reserved`・`awaiting_confirmation`・`result_unknown` を「未確定」と呼ぶ。全入口が同じ鍵の中で次の表と版の比較を行う。

| 出来事 | 許す前の状態・条件 | 変化と拒否・復旧 |
| --- | --- | --- |
| 束を作る／CSV準備／API準備 | 履歴なし・failedだけが通常のclaimを取る。未終了のAPI jobがあるfailedは取れない（S59のguard）。1億円の上限の行は、固定済みなら固定の分け方、未固定なら規則T1・T2で今の束に固定する。1億円を超える行・その後に来る未固定の行・元の行の分からない経過措置の返品は、人が決めるまで `tax_unconfirmed` で止める | reserved。未確定は別の束を拒否。成功は未転記分から除外。APIの全件指定も成功を除く |
| CSVを書き出す | 自分のreserved、固定元の検証・履歴記録が成功 | awaiting_confirmation。失敗・停止したreservedは再作成か取下げを選べる。バイトを返した後の確認待ちは取下げで解放しない |
| 取り込めた／API成功 | 自分の確認待ち、または結果を確かめたAPIの未確定 | succeededと最初のconfirmedを原子的に1回だけ記録。同じ要求は同じ結果。成功から失敗への変更は禁止 |
| 失敗が確定 | 自分のclaim_ownerで、相手に未作成と確かめた失敗 | failed、再試行可能。送信の受理が不明ならresult_unknownのまま。既存の成功は失敗にしない |
| 未出力CSVを取下げ | reserved、exportedなし、版一致 | withdrawn履歴とclaimのfailed。時間切れでは戻さない。他の方法で取り直せる |
| 未送信APIを取下げ | queued/retry_wait/reconnect_required、send_started_atなし、曖昧な過去attemptなし、版一致 | jobはcancelled、claimはfailed、取下げ履歴。オフでも操作可能。markSendingが先なら拒否、取下げが先ならmarkSendingを拒否 |
| 送信開始後のjobを閉じる | queued/retry_wait/reconnect_required/verifyingでsend_started_atあり、leaseなし、自分のclaim_owner、版一致 | 黙って取下げ・CSVへ移さない。再接続後は下の「再接続の後の付け直し」で関門の手段により決める（手段1は鍵の有効期間の内なら同じ冪等鍵でqueued、期間の外か手段2ならverifyingへ入れ店の番号で相手を読む）。手段を使えない時だけ、オーナーが相手の画面で確かめた理由と根拠で「相手にある」（job=succeeded・claim=succeeded・confirmed）か「相手に無い」（job=cancelled・claim=failed・withdrawn、その後CSVが取れる）を記録。markSendingとはCASで排他 |
| 同じCSVを再作成／再取得 | reservedの明示復旧、または作成済みの同じ束 | 同じsource・番号・formatter/profileで再生成。元のclaimを保ち、確定失敗のretry子も同じ固定元を読む。新しい元へのすり替えは禁止 |
| CSVの失敗分を再試行 | 現在のclaim.batch_idが親の束、claim_role=claim_owner、claim.state=failed、親の版一致 | 同じ固定元・番号の子へclaimを原子的に移す。別の束のreserved等はACCOUNTING_COPY_PENDINGで拒否し、他のjobの占有を奪わない |
| 全件を再出力 | 明示確認、対象に未確定なし | 成功済みはhistory_only、未転記・failedはclaim_owner。前者はclaimを取らず成功／失敗の確認を別の履歴にだけ追記、後者は通常の確認待ちと成功／失敗の規則を適用 |
| APIを送信開始／結果不明 | 有効・監督ready・接続版一致の自分のreserved | markSendingで送信開始を記録。不明ならresult_unknown＋verifying、全頁照合と人の不在確認前は再POST・解放禁止 |
| APIを再試行（通常／不在確認後） | 現在のclaimの束・entryがjobの束・entryと一致しclaim_owner。通常はfailed、不在確認後はresult_unknownと確認理由・版一致 | 他の束が持つclaimはACCOUNTING_COPY_PENDING。元のjob・固定入力・冪等鍵を保ちreserved＋queuedへ。不在確認前のunknownと成功は再試行不可。未送信の自動待ち戻しも自分のreservedだけ |
| 結果確認中の決着（resolved） | verifyingで自分のresult_unknown、lease/版一致 | 全頁で1件同内容なら同じIDで成功。確定不在は不在確認履歴を残して上の再試行へ。複数・内容違い・未完了はunknownのまま人の確認へ。claimを解放しない |
| 期限切れ（lease／鍵） | 現在のlease・接続の版に対する判定 | 未送信のlease切れは自分のreservedを保ちqueue、開始後はverifying＋result_unknown。鍵の期限切れ・401は、jobをreconnect_requiredにして送信停止し、送信・未送信の道ではclaimを同じ束のfailedにする（guardで他の束へ移れない）。verifyingの読みで401が返った時は、不明のままclaimをresult_unknownに保ちjobだけreconnect_requiredにし、failedにしない（再接続後も不在の確認の前に再POSTしない）。403は確定の拒否（permission）でjob=failed。接続の版が上がっても自動でqueuedへ戻さず、再接続後は人の通常のretryだけで戻す（送信開始後のjobは上の「閉じる」の手段を通す）。時間だけでclaimを別の束へ渡さない |
| 再接続の後の付け直し | 人のretry、同じtarget、新しいbinding版に `remote_office_ref` と事業者の確認の証拠が結ばれている、自分のclaim_owner、job・接続の版一致 | 付け直しの前に関門の手段で相手にあるかを確かめる（手段1は鍵の有効期間の内なら同じ冪等鍵で送ってよい、期間の外か手段2はverifyingで店の番号を読む）。そのあとjobのbinding_versionを今の版へ移す。冪等鍵と固定の入力は変えない。別の事業者・証拠なしは付け直さず、取下げか「閉じる」へ |
| APIをオフ | どの状態でも設定の版一致 | 新しいmarkSendingを止める。未送信は上の取下げでCSVへ移れる。送信開始後のjobは上の「閉じる」だけで出る。進行中の結果は記録、不明は人が明示的に照合して解決し成功を消さない。全オフの定期cronから外部HTTPは出さない |
| 鍵の更新／接続先の変更 | settings.manage、接続の版一致 | binding版を進め、古いqueuedは新しい鍵／相手へ送らない（同じ事業者への再接続だけは上の付け直しを人が行う）。未送信なら取下げ、送信開始済みなら元の接続先で結果確認。正当なOAuth refreshはcredential版だけを進める |
| 税・対応表の改版 | 各設定／分類の権限と版一致 | 新規候補にだけ反映し、既存sourceは固定。準備後・出力前でも古いsourceを再解釈しない。1億円の上限の行の固定の分け方（規則T1）は分類の改版でも変えず、「固定後に分類を改めた行」として表示するだけ。既転記の差と照合の無効化を表示する |
| 締めた版の訂正／古い日付の追加・分類変更 | 先行計画の訂正契約と月のguardを満たす | 新しいentry・版を追加。既存sourceと成功と固定の分け方は不変。古い日付の仕入れは、累計が1億円以下なら全部経過措置で固定し、超えるなら規則T1で止めて人が決める。取消し・訂正・返品の行は規則T2で元の行の固定の分け方を写す（一部の額でもよい） |
| 月を仮締め | close.manage、全利用targetの現行照合がmatched、fingerprint一致 | heldを追記。追加・分類改版等が先なら古い照合を拒否し、heldが先なら後の追加を次の行で止める |
| 仮締め中に仕訳が来る | 手入力・訂正、または自動の出来事の実際の日とE/Nの経済日を検査 | 手入力は409で番号も増やさず、理由・待ち件数の確認を伴う解除後だけ再操作。自動は組ごとmonth_holdの計上待ち、勝手に解除しない。成功の確認自体は仕訳を追加しないので許し、既存のheldと履歴を消さない |
| 月を解除 | close.manage、理由、月の版と計上待ち集合の件数・指紋を確認済み | releasedへ確認対象の安全なID集合・件数・指紋を保存。待ちが変われば再確認。年のgateは維持し、解除後の自動計上もchangedを追記 |

**全ての順で守る不変条件:** ①各仕訳の「写した」は0回か1回。`N_success = CSVのclaim_ownerのconfirmedイベント数 + APIのsucceeded job数` をtarget・entryごとに集計して `N_success<=1` とする。APIのconfirmedと同じsucceeded jobを二重加算せず、別にAPI成功イベントとjobが1対1であることも検査する。UNIQUEの存在だけを根拠にせず、履歴とjobから実数を数える。②未確定の仕訳は、新規の束・CSV retry子・API retryのいずれも他の持ち主へ移さない。③未転記の仕訳には再作成・未送信取下げ・確定失敗retry・不明結果の照合後の確認・送信開始後のjobを閉じる操作のいずれかの明示経路があり、孤立claimを作らない（APIを使わなくなっても、送信開始後のjobはオーナーの「相手にある／相手に無い」で閉じられる）。時間で受理不明を戻すことは③の解決にしない。

④target・entryごとのclaim_ownerの出力のうち、CSVのexportedまたはAPIのsend_startedを持ち、確定失敗・不在確認・取下げで閉じていない物は1つ以下。同じ束のファイル再取得と同じAPI jobの同じ冪等鍵による再要求は同じ出力単位として数え、history_onlyの意図した再出力は別に数える。⑤queued・retry_wait・reconnect_requiredのjobは、そのentryの現在のclaimと同じ束を指す。逆にAPIのreservedのclaimには同じ束のqueued/retry_wait/sendingのjobが、result_unknownのclaimにはverifying（確認中に401が返った後はreconnect_required）のjobがある（awaiting_confirmationはCSVだけ）。持ち主のないjobを作らない。⑥**APIの送信はjobごとに相手のソフトで1本だけ（Task 11 Step 0の関門で決めた手段1の冪等の鍵、または手段2の店の番号での不在確認で守る）**。Task 11・14で固定する同じjobの冪等鍵と入力を再試行でも変えず、HTTP差し替え側に保存する `(targetId,idempotencyKey)→remoteId` の実数も1以下と検査する。相手が受理した実数と①のDB成功数を別々に数え、DB成功前の二重作成も捕まえる。相手の冪等契約の未確認を、DBのUNIQUEだけで解決済みとはしない。さらに、同じ鍵でも余分なPOSTを数えるため、jobごとの作成POSTの回数は不在確認の前は1回以下とHTTP試験道具の呼び出し数で検査する。⑦**取引先×課税期間ごとの経過措置の合計は1億円（税込み）以下。** 次の2つで検査する: 固定の表の `cap_delta` の和が1億円以下、各固定行の `cap_used_before` がそれより前の `fixing_seq` の `cap_delta` の和と等しい。⑧**一度固定した行の分け方（S54の固定の表とsourceのline_facts）は、古い日付の仕入れ・取消し・返品・分類改版・束の出し直しのどの後も変わらない。** ⑨**1億円を超える行（とその後に来る未固定の行）と、元の行の無い経過措置の返品は、人が決める（`admin_decide_accounting_copy_cap` か元の仕入れの選択）まで、新しい束・CSV retry子・API enqueueのどれにも写らない。** ⑩**写した控除の額（税額×割合の和。端数処理の前）は、取引先×課税期間ごとに、同じ行を取引の日の順（`(taxable_on,entry_no,line_no)`。取消し・訂正・返品は元の行の取引の日と割合）に厳密に数えた額を、税率（8%と10%）が混ざっても超えない。** ⑦〜⑩は規則T1〜T3（「決めたこと」）を検査する式。

**順を全部試す共通suite:** `tests/integration/db/accounting_p7_copy_order.integration.test.ts` をTask 4で作り、Task 8・14で拡張する。各独立fixtureについて次の各組の全順列を列挙し、毎回 `BEGIN`〜`ROLLBACK` 内で実行する（前提未成立の操作はSAVEPOINTで期待した拒否を確認）。組は「CSV準備・再作成・取下げ・別CSV準備」「CSV出力・成功確認・失敗確認・全件再出力」「全件再出力準備・既存成功の再確認・再出力失敗・未転記準備」「CSV準備・API準備・API送信開始・オフ・未送信取下げ」「送信開始・timeout記録・照合・retry・CSV準備」「月仮締め・自動出来事追加・解除の確認・月解除・係の再訪」「締めた版の訂正・古い日付の追加・固定元再読込・再出力」。組の一部や二者だけの順に減らさない。各操作の直後に①②④⑤⑦⑧⑨⑩をSQLで、⑥をHTTPの受理記録とSQLのjob/冪等鍵で検査し、最後に状態に合う復旧操作を続けて③を確認する。HTTPはfixture応答だけ、同時実行は別の並行suiteで検証する。

さらに「verifyingのjob・CSVのretry・APIのretry・結果の照合」「月仮締め・CSV成功確認・解除・係の再訪」「API準備・claim・鍵の更新・markSending・finish」「API準備・接続先変更・オフ・markSending・未送信取下げ」「CSV準備・税分類改版・対応表改版・CSV記録・固定元再読込」「締め・締めた版の捕捉・訂正・全件再出力」を各々全順で流す。初期状態を未転記・確定失敗・成功・CSV確認待ち・API結果不明に切り替え、対象に該当する全組を実行する。単に例の成功順だけを通さず、各組の全順列の件数と実行件数を照合する。Task 4・8・14のRED/GREENではこの同じsuiteの、その時点の全組を必ず実行する。

規則T4の4出来事（古い日付の仕入れが写した後に入る・取り消し・返品・束の出し直し）も入れ、「CSV成功確認・古い日付の仕入れ追加・新しい束の準備・取消し仕訳・元の行が無い返品・束の出し直し（同じ束の再作成／再取得とCSV retry子）」と「API成功・古い日付の仕入れ追加・API enqueue・取消し仕訳・正しい仕訳の追加・再準備」の組と、「1億円を超える古い日付の仕入れ追加・新しい束の準備（止まる）・オーナーの分け方の決定・再準備」「元の行の無い返品・新しい束の準備（止まる）・元の仕入れの選択・再準備」の組を全順で流し、⑦⑧⑨⑩と③を各操作後に検査する。どの順でも写した行の固定segments・番号・sourceHash・ファイルsha256は変わらない。⑩の厳密な数えは、試験道具が同じ行を `(taxable_on,entry_no,line_no)` 順に並べ直し、上限の所を日付の早い行から埋めて超えた分を控除なしにした税額×割合を、規則とは別の式で計算した値と比べる。今回足す5出来事（API再試行・結果確認中の決着・期限切れ・月仮締め・仮締め中の仕訳）もイベント集合に入れ、「CSV失敗確定・API準備・元CSVのretry・API再試行・markSending」「API送信開始・lease切れ・resolved・API再試行・CSV準備」「鍵の期限切れ・再接続・API再試行・オフ・未送信取下げ」「送信開始後の401・オフ・再接続・関門の手段での確認・付け直し・markSending・CSV準備」「verifying中の401・再接続・付け直し・店の番号の読み・resolved」「送信開始後の401・オフ（再接続しない）・オーナーの相手にある／相手に無い・CSV準備」「月仮締め・手入力・自動計上・CSV成功確認・月解除」の各組を全順で流す。送信開始後の2組は、閉じる前のCSV準備がACCOUNTING_COPY_PENDINGで拒否され、「相手に無い」の後だけCSVが取れ、「相手にある」の後は成功のまま①を超えないことを含む。1つ目はCSV失敗→API reserved→元CSV retryの奪取を拒否してAPIの所有を保持すること、2つ目は送信直後DB失敗や期限切れでも同じ冪等鍵の相手側1本を超えないことを含む。

## Review Focus

1. **再クリック・部分成功・CSV/API の競合・送信後の timeout:** 1本が二重にならず、確認待ちと不明な結果は人に見え、成功した分を再送しない（Task 4・6・14・16）。
2. **2026-10-01の境・年の途中の登録・同じ相手から1億円・特例:** 間違った控除割合や空の適格への補完を避け、未確認の分類は止める（Task 2・3・5・13）。
3. **頁の境の複合仕訳・訂正・締めの版・翌期へのつながり:** 仕訳を分割・集約せず、版と元の集合を固定し、古い日付の訂正も落とさない（Task 4・5・7・12・15）。
4. **式の先頭・負の数・引用符と改行・表せない字・お客様の情報:** 元の帳簿を変えず、写しの制限と応答の文字コードが合い、個人情報を送らない（Task 1・5・6・12・13・17）。
5. **合計だけ合う入れ替わり・仮締め後の自動計上・鍵更新の競合と期限:** 不一致を隠さず、仮締めを無断で通さず、オフ・期限切れ・別事業者へ送らない（Task 7・8・11・13〜16）。

---

## 設計の行から Task への対応

行番号は承認済み設計のこの HEAD の物。15章の語の定義・図・根拠・例・比較の行も含める。範囲外は担当計画を明記する。

| 設計の行 | Task または範囲外 | 確かめる物 |
| --- | --- | --- |
| 15の定義（1241〜1244）・15-1 仕訳CSV（1250） | 4・5 | 正本の保存した仕訳1本ずつ |
| 15-1 総勘定元帳等（1251） | 7・15。帳簿そのものの出力は計画6 Task 13 | 月・勘定の比較 |
| 15-1 APIなし（1252） | 11〜16 | オフと HTTP 差し替え |
| 15-1 記録なし（1253） | 4・6・14 | 仕訳ごとの履歴と占有 |
| 15-a（1259） | 4・5・12・13 | 連続する複合仕訳、数字の番号、決算整理の全行 |
| 15-b（1260） | 2・5・9 | 30字と未対応で停止、無断の既定値なし |
| 15-c（1261）税区分・経過措置 | 2・3・5 | 区分・率・インボイスの組、日付の表 |
| 15-c（同）1億円・帳簿のみ・少額特例 | 3・9・17 | 年度全体の同じ相手、必要な記載、対応不能で停止 |
| 15-c2（1262） | 2・3・5・7・13 | 免税・登録日・税込／税抜、MF税額は空、端数差 |
| 15-d（1263） | 1・4〜6・9 | 年度分割、全部／未転記、文字コード・置換・不可能字 |
| 15-e（1264） | 4・6・14 | 確認待ち／成功／失敗、部分成功、同じ番号の再出力 |
| 15-f（1265） | 4〜6・12〜15 | 取り消しと正しい仕訳を追加、相手への更新・削除なし。仕訳を作るのは計画1・3・6 |
| 15-g（1266） | 11〜16・18 | 暗号・期限・待ち行列・再試行・MFの事業者と回数 |
| 15-g2（1267） | 1・12・18 | freee取引＋支払い、現預金の制限。CSVの制限は未確認#2 |
| 15-h（1268） | 7・8・15 | 月・年末の試算表、CSV件数、APIの1本比較 |
| 15-i（1269） | 5・9・11〜13・17・18 | 名前・住所・メールなし、注文番号の取扱いと規約・国 |
| 15-j（1270） | 9・17・18 | MF確定申告を既定、税理士との決定を記録。決算書を作るのは計画1・5・6 |
| 15-2の図（1272〜1282） | 2・4〜7・11〜15 | CSV・APIが同じ正本と対応表を通る |
| 15-3 年末にMF（1288） | 5・10 | 税区分・番号つき1年度CSV |
| 15-3 同じ月を2回（1289） | 4・6・10 | 未転記分から成功・確認待ちを除く |
| 15-3 11/1売上の11/20訂正（1290） | 4・5・15 | 元は残し新しい2本、税は元の取引日を参照 |
| 15-3 工場への支払い（1291） | 12 | 課税の仕入を現預金の明細にしない |
| 15-3 未登録の職人（1292） | 3・5 | インボイスを空にしない |
| 15-3 2026年11月70%（1293） | 3・5 | 80%を拒否、freeeは率付きの対応 |
| 15-3 免税年（1294） | 3・5・10 | MFの税区分・税額が空、店の分類は保持 |
| 15-3 freeeへ2回（1295） | 4・5・6 | 不変の伝票番号と確認待ち |
| 15-3 新しい勘定（1296） | 2・5・9 | 未対応一覧を示して停止 |
| 15-4 複合仕訳・未対応・空の適格（1302〜1304） | 1・2・4・5 | 公式ヘルプから見本を固定 |
| 15-4 経過措置・freee税名（1305〜1306） | 1・3・5 | 日付の境と原文・表の版 |
| 15-4 合わない名前・税額・freee番号（1307〜1309） | 1〜6 | 無断補完なし、税額と番号の制約 |
| 15-4 制限・免税・年度・二重（1310〜1313） | 1・3〜6 | ファイルと仕訳の行数・期首日 |
| 15-4 訂正（1314） | 4・5・14 | 相手にPUT/DELETEしない。訂正を作るのは計画6 |
| 15-4 鍵・API・現預金（1315〜1317） | 11〜14・18 | 原文と HTTP 契約、秘密を出さない |
| 15-4 試算表・個人データ・委託（1318〜1320） | 7・15・17 | 照合と規約・国の記録 |
| 15-5 正本・単位（1326〜1327） | 4・5・12・13 | 集約しない |
| 15-5 二重・直し（1328〜1329） | 4・6・14 | 成功した元を上書きしない |
| 15-5 区分・割合（1330〜1331） | 2・3・5 | 自前の日付の表 |
| 15-5 照合（1332） | 7・15 | CSVは残高と件数、APIは1本ずつ |
| 10-j（768）・11-e2・15-d | 5・6・9・12・13 | 個人の古い年への案内、MFの年度と期間制限。法人は見つけた年の日付 |
| 10-k（769） | 8・9・15・16 | 理由と人・日時・変更前後、自動の確認待ち |
| 16 仕訳の取消し等の税区分・Stripe手数料（1340〜1341・1366・1369） | 分類の未確認は3・9、税判断は計画2・3の未確認事項 | 「対象外」で勝手に埋めない |
| 16 MFの文字コード（1359） | 1・18 | 設定が取込にも効くかは見本と実接続で確認 |
| 16 freee現預金（1360） | 1・12・18 | HTTP契約とオーナー準備後の試しの事業所 |
| 16 MFの鍵の期限（1361） | 11・18 | 原文から取得、無ければ不明表示 |
| 16 届出の正本（1362） | 17・18 | 税理士との決定 |
| 16 委託の範囲・外国の国（1363） | 17・18 | 法務確認・版・日付・国の記録 |
| 16-sr11（1374） | 1・3・5 | 特例の区分を実装時に原文から取得し、無ければ停止 |

### 計画2〜6の「計画7」を拾った一覧

`rg -n "計画7" docs/superpowers/plans -g '2026-11-04-accounting-p[2-6]-*.md'` の一致は18行（計画2・3・4は0行）。1行に複数の言及がある所は同じ欄で全て受ける。行番号は HEAD の物。

| # | 出典 | 引き継ぐ内容 | Task／範囲外 |
| --- | --- | --- | --- |
| 1 | 計画5:37 | 写しは計画7 | 1〜18 |
| 2 | 計画5:167 | 広告宣伝費のインボイス区分、課税切替期首の在庫調整 | 行の分類と写しは3・5。期首在庫の税の調整仕訳は7計画の外にある別途の課税切替計画が担当する。計画5・6へ実装を割り当てず、計画7も作らない |
| 3 | 計画6:5 | 書き出しの共通層を使う | 1・5・6 |
| 4 | 計画6:9 | Shift-JIS変換器を決める | 1 |
| 5 | 計画6:41 | 15章の担当、共通層と元の字の出力を受ける | 1〜18。税務署用は計画6 |
| 6 | 計画6:81 | 文字セルだけの式対策、相手ごとの設定 | 1・5 |
| 7 | 計画6:204 | 10-jの案内 | 5・6・9・12・13 |
| 8 | 計画6:205 | 10-kの月の仮締め | 8・9・15・16 |
| 9 | 計画6:253 | 税務署用にも行の税区分の値を供給 | 3。元の文字を出す経路は変更しない |
| 10 | 計画6:592 | Task12の型と名前を変えない | 1・5・6 |
| 11 | 計画6:603 | neutralizeFormulasとreplacements・encoderを渡す | 1・5 |
| 12 | 計画6:606 | 公開名の一覧とShift-JIS | 1・5・6 |
| 13 | 計画6:629 | `accounting_line_tax_class` のNULL本体を置き換える | 3。S48の最新定義を確認する |
| 14 | 計画6:631 | `list_exportable_entries` と写しの記録の所有 | 4。JSONの願い1を先に確定 |
| 15 | 計画6:634 | order_idつき空の取引先の決めた値 | 5・12・13。税務署用には入れない |
| 16 | 計画6:638 | NULLの間の試験と値が入った後の試験 | 3の意図して直す試験 |
| 17 | 計画6:921 | 税区分・インボイス値は未設定 | 3 |
| 18 | 計画6:942 | 10-j・10-k・15章は範囲外の引継ぎ | 1〜18、対応表の各行 |

## 公式の原文と、まだ値を写さない所

確認日2026-11-05。初稿の取得記録と今回のレビューを区別する。以下の「原文で確認できた契約」は初稿で読めた範囲を示し、公式見本の取得や今回の再確認まで意味しない。検索結果の断片は原文確認の証拠に数えない。freee取込ヘルプはレビュー時403で未再確認、公式見本も未取得。Task 1・11が公式本文・公式見本・検索断片を別の証拠種別として、URL・節・取得日・取得方法・原本sha256・確認者と版をmetadataへ記録する。推測の列・APIのIDを実装へ移さない。

直し1ではWebの本文取得でMFの取込ヘルプ（項目リスト末尾・更新日）、API利用ヘルプ（APIキー認証の注意）、freee現預金制限（変更の概要・詳細②）を再確認した。見本ファイルは取得していない。MFのrate_limiterは直し1の取得では到達できず、回数はレビューの原文確認記録、Retry-Afterは保証未確認と区別する。freeeの大きいschemaの作成入力と旧10億円の開始日は今回確定していない。

| 出典 | 原文で確認できた契約 | 実装で固定する所 |
| --- | --- | --- |
| [freee その他の会計ソフトから仕訳データを移行する](https://support.freee.co.jp/hc/ja/articles/204847430)（初稿記録では2026-10-15更新） | 初稿の本文抽出では日付・借貸、`[表題行]`・`[明細行]`、数字20字以内の伝票番号、同番号で1本、同日同番号の拒否、決算整理1、文字コード別見本への案内。**レビュー時403、原文は未再確認・見本は未取得** | Task 1で取得可能な公式本文と公式見本を取り、全列順・内税／外税・BOMを確定する。初稿の抽出・検索断片だけで確認済みにしない |
| [MF 仕訳帳をインポートする](https://biz.moneyforward.com/support/tax-return/guide/import-books/ib01.html)（2026-07-09更新） | 公式本文の列一覧は作成日時・作成者の後のZ「最終更新日時」・AA「最終更新者」まである。9桁の取引No、日・Noと貸借合計で複合仕訳、勘定30字、借貸税額は0か空、摘要・仕訳メモ200字、決算整理の印は全行、既存Noは振り直す | 列数を計画で固定せず、Task 1で公式本文と公式見本から全列と順をfixtureへ採る。未使用の作成・最終更新の日時と人の列も削らず空で出す |
| [MF インポートのエラー](https://biz.moneyforward.com/support/tax-return/faq/import-error/ie03.html) | 摘要等の二重引用符と、摘要・メモの改行は取込失敗の原因 | Task 1・5で写しだけを置換。原文の帳簿は変えない |
| [MF CSVの文字化け](https://biz.moneyforward.com/support/tax-return/faq/import-error/ie04.html) | 事業者の文字コードはShift-JIS/UTF-8から選べる。本文はダウンロードの説明 | 取込がこの設定に従うとは断定しない。Task 1の見本確認と Task 18の実接続で確かめる（未確認#1） |
| [freee 振替伝票](https://support.freee.co.jp/hc/ja/articles/202848040)・[freee 税区分の追加](https://developer.freee.co.jp/accounting/accounting-improvement/8133) | 8133は控70・控30の追加と期間別の割合を説明する。「買い手側対応機能の設定」は設計15-cの記述で、8133では原文未確認。202848040は確かめ直し時403 | Task 1・2で機能の有無・適用条件と正式な税名を公式原文から得る。取得できるまで設定の必要性を確認済みとはせず、626-AC-03の値を推定しない |
| [MF 消費税設定](https://biz.moneyforward.com/support/account/guide/office02/of02.html)・[年度途中から課税](https://biz.moneyforward.com/support/tax-return/faq/invoice/invoice02.html) | 免税は税区分を登録できない。登録前の仕訳を対象外にする操作がある。税込／税抜と端数処理を設定する | Task 2・3・5で登録日を使い分ける。MFの自動計算との端数差は Task 7・15で独立表示 |
| [freee 現預金の制限](https://developer.freee.co.jp/news/5930) | 現預金の明細と課税区分／税額がある取引・振替伝票の制限 | Task 12は仕入等の明細＋支払行の取引へ変換。CSVにも制限があるかは未確認#2 |
| [freee 作成応答の変更](https://developer.freee.co.jp/accounting/accounting-improvement/7937)・[公式schema](https://raw.githubusercontent.com/freee/freee-api-schema/master/v2020_06_15/open-api-3/api-schema.json) | 振替伝票POSTの返答からtxn_numberが外れ、IDでGETして番号を得る。schema本文は取得可能 | Task 11・12で使う操作だけを抜き出しfixture化。作成の応答に番号を必須にしない |
| [freee 鍵の期限](https://developer.freee.co.jp/reference/faq/token_lifetime) | accessは6時間、refreshは90日、refreshは一度使うと再利用できない | Task 11で期限とrefreshの直列化、更新後の原子的な保存 |
| [MF API利用](https://biz.moneyforward.com/support/tax-return/guide/others/ot09.html)・[API仕様](https://developers.api-accounting.moneyforward.com/)・[回数制限](https://developers.api-accounting.moneyforward.com/rate_limiter) | OAuth/APIキー、ポータルで許可事業者を指定・変更できる。仕訳のPOST/GET、access tokenごとに1秒3回。ot09には許可事業者一覧APIとキーのBearer交換の記載がなく、Retry-Afterも保証未確認 | Task 11で一覧操作と認証方式を公式仕様から取得し、無ければTask 18の試しの事業者で確認。事業者を1つに絞った確認は一覧API未確認時にオーナーのMF画面と秘密を隠した画面の写しの記録へ替える。認証方式は未確認なら使わない |
| [国税庁 No.6496](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6496.htm)・[No.6497](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6497.htm)・[改正の資料](https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/0026004-066_02.pdf) | 特例の確認先。No.6496・6497本文は読める。改正のPDFの表はこの計画作成では画像まで照合していない | Task 3で法令の日付の表・特例の種類・住所省略の条件を原文から得て固定ベクトルへ。設計の割合と矛盾すれば有効化を止めてcontrollerへ |

式注入の記号は両社の取込にそのまま文字として入る可能性がある。**取込用は両社とも `neutralizeFormulas:false` を初期profileとする**（AIの実装判断）。金額はnumber、勘定・税区分は承認済みの対応表、注文摘要は固定文で作り、自由文を流さない。一般のExcel閲覧用の安全な出力は計画6のブラウザーCSVを使う。変更する場合も Task 1のprofileと期待バイトを変え、共通層に相手名の分岐を足さない。

### 未取得の値を確定する経路と、止める範囲

| 値 | 最初に得る証拠／得られない場合 | 出力・試験の扱い |
| --- | --- | --- |
| 全列・順・必須欄・表題／明細 | Task 1で公式本文と公式配布見本を照合。403等ならオーナーが公式画面から取得した原本と取得記録をcontrollerへ渡す。検索断片で代用しない | 得られない書式は本番用無効。確認できた他方の書式まで止めない |
| BOM・Shift-JISの実バイト・MF取込の文字コード設定 | 公式配布見本のバイト。説明が無ければTask 18 Step 7のCSV部分を前倒しし、試しの事業者で入力条件と結果を記録してオーナーが採用版を決める | 本番で使うencodingごとに証拠を持つ。他のencodingや全profileの一括無効にしない |
| 公式の行数／ファイル上限が見つからない | Task 1で原文を探し、無ければ店の保守的上限をオーナーの決定として記録し試しの取込で確かめる | 店の上限を相手の保証と呼ばない。本番受入れの未確認は実取込で解消。通常行の確認と特殊な形の未確認を分ける |
| MF免税のinvoice欄・freee内税／外税・特例名 | 公式本文・見本→必要なら試しの事業者の実取込・カタログと確認記録 | 未確認の組だけ `profile_unverified` / `tax_unconfirmed` で止め、確認済みの通常の入力を使えるようにする |
| freee現預金のCSV制限 | Task 1で現預金制限の公式原文とCSVヘルプを読み、Task 18のCSV部分をTask 10より前に実施可能とする | 現預金の分類IDの勘定を明細に含む仕訳で、いずれかの明細の税区分が対象外・未選択・不課税以外、または税額が0以外なら、CSVで可否を確認するまで停止。課税の行自体が現預金である場合だけに狭めない。分類IDは原文の個人19・法人36をfixtureで再照合し、勘定名の文字では判定しない |
| ローカルE2Eに必要な値 | Task 1で明示的な `fixture_only` 版を作り、Task 10のlocalhost限定bootstrapだけが渡す | 本番用verifiedを偽装しない。Task 10はこのfixtureで全経路を検証でき、実取込の完了を待たずCSVのgateを通せる。実接続が未実施なら本番用の該当能力は無効のまま |

freeeの現預金の固定ベクトルは、現預金なし／現預金＋許容税区分かつ税額0／現預金＋課税／現預金＋税額あり／分類ID不明を別にする。公式でCSVの適用範囲が確定しなければ、該当する後3種だけを止める。原文の裏付けのないIDや区分名を計画に足さない。

## 共通の型・値・拒否

計画1・6の型は import して使い、同名の定義を足さない。UUIDは検証済みstring、日付は `YYYY-MM-DD`、金額は円の安全整数。DB bigintの版・通番の保持には10進文字列、CSVの金額・数値セルへの変換時に安全整数を検査する。

| 型・名前 | 契約と定義するTask |
| --- | --- |
| `CopyProvider` / `CopyMethod` | `'freee'|'mf'` / `'csv'|'api'`（1） |
| `CopySelection` | `{periodId:string;from:string;to:string;scope:'uncopied'|'all';closingVersionId:string|null}`（1）。1要求1期間。closed期間はclosingVersionId必須、open方式は実際に開いた期間だけ。`all`でもreservedを含む未確定の占有を無視しない |
| `CopySourceRef` | `{kind:'open'|'closing';periodId:string;closingVersionId:string|null;throughEntryNo:string;openingVersion:number|null;openingSource:'stored'|'computed'|'first_term';taxRevision:string;mappingRevision:string;profileVersion:string;formatterVersion:string;sourceHash:string}`（4）。openとclosingVersionIdは排他的 |
| `CopyLineTax` | `{revisionId:string;entryId:string;lineNo:number;taxCategory:string;rateBps:number;invoice:InvoiceClass;taxableOn:string;grossAmount:number;taxAmount:number|null;supplierRef:string|null;exceptionKind:string|null;evidenceId:string|null}`（3）。`InvoiceClass='qualified'|'transitional'|'no_credit'|'books_only'|'small_amount'|'not_applicable'`。transitionalの割合は日付の表から引く |
| `CopyProfile` | `{provider:CopyProvider;version:string;columns:readonly ExportColumn<CopyCsvRow>[];options:CopySafeOptions;maxRowsPerEntry:number;maxRowsPerFile:number;headerMode:'plain'|'freee_labels';usage:'production'|'fixture_only';evidence:readonly string[];blockedCases:readonly string[]}`（1）。列・上限・BOMの根拠は上の値別の表で固定し、未確認の組だけ止める |
| `CopyCsvRow` | `{entryId:string;entryNo:string;voucherNo:string;date:string;adjustment:boolean;debit:CopySide|null;credit:CopySide|null;description:string;entryMemo:string}`（1）。`CopySide={accountName:string;subAccount:string|null;counterparty:string|null;taxName:string|null;invoiceName:string|null;amount:number;taxAmount:number|null}`。会計上の正負と借貸は元の行のまま |
| `CopyBatchState` / `CopyEntryState` | 束は `'prepared'|'awaiting_confirmation'|'partially_confirmed'|'succeeded'|'failed'|'withdrawn'`、行は `'reserved'|'awaiting_confirmation'|'succeeded'|'failed'|'result_unknown'`（4）。未転記は履歴が無い／確定失敗だけ。送信の技術状態は14のjobに分離 |
| `CopyIssue` | `{code:(typeof COPY_ISSUE_CODES)[number];entryNo:string|null;lineNo:number|null;accountCode:string|null}`（1）。本文・鍵・相手の生のエラーを入れない。不可能字は権限のある画面への別の検査結果でだけ返す |
| `CopyBuildResult` | `{ok:true;bytes:Uint8Array;sha256:string;rowCount:number;entryCount:number;fileName:string;encoding:string}|{ok:false;issues:readonly CopyIssue[];unrepresentable:readonly string[]}`（5） |
| `CopyReconciliation` | `{id:string;targetId:string;source:CopySourceRef;slice:PeriodMonthSlice;status:'matched'|'mismatch'|'incomplete';accounts:readonly CopyAccountComparison[];counts:{local:number;remote:number|null};differences:readonly CopyDifference[];roundingOnly:boolean;fingerprint:string}`（7）。年末は同じ月の比較と年度合計。`CopyAccountComparison={accountCode:string;localDebit:number;localCredit:number;localClosing:number;remoteDebit:number|null;remoteCredit:number|null;remoteClosing:number|null}`、`CopyDifference={kind:'missing'|'extra'|'amount'|'date'|'account'|'tax'|'invoice'|'rounding'|'opening'|'count';entryNo:string|null;remoteId:string|null}` |

**拒否の追加（Task 6で `ACCOUNTING_ERRORS` に追記、既存は変更しない）:**

| DB message / SQLSTATE | HTTP | 日本語本文 |
| --- | --- | --- |
| `ACCOUNTING_COPY_MAPPING_MISSING / 55000` | 409 | `対応していない勘定・税区分・インボイス区分があります。` |
| `ACCOUNTING_COPY_TAX_UNCONFIRMED / 55000` | 409 | `税の区分が未確認の仕訳があります。` |
| `ACCOUNTING_COPY_PENDING / 55000` | 409 | `取り込みの確認待ちの仕訳があります。先に結果を確認してください。` |
| `ACCOUNTING_COPY_SOURCE_CHANGED / 40001` | 409 | `写しの元が変わりました。読み直してください。` |
| `ACCOUNTING_COPY_UNREPRESENTABLE / 22021` | 422 | `選んだ文字コードで表せない文字があります。` |
| `ACCOUNTING_COPY_LIMIT / 22023` | 422 | `相手のソフトの取込上限を超えています。仕訳を確認してください。` |
| `ACCOUNTING_COPY_DISABLED / 55000` | 409 | `APIの連携はオフです。` |
| `ACCOUNTING_COPY_RECONNECT / 55000` | 409 | `接続し直してください。` |
| `ACCOUNTING_COPY_RESULT_UNKNOWN / 55000` | 409 | `送信の結果を確認中です。再送する前に照合してください。` |
| `ACCOUNTING_MONTH_HELD / 55000` | 409 | `この月は仮締めしてあります。確認と理由が必要です。` |
| `ACCOUNTING_COPY_SUPERVISION_REQUIRED / 55000` | 409 | `利用条件と個人情報の取扱いを先に確認してください。` |

引数・権限・版・要求番号・不在は計画1の固定コード、未知は500 `会計の処理に失敗しました。`。DBに例外を出すほどでない事前検査は `issues` を返すが、DB確定時も同じ条件を再確認する。外部の400・401・403・429・5xx・timeoutは API adapter の固定の結果へ変換し、本文をログや画面へ流さない。

---

### Task 1: 公式の見本・写しの型・profile・文字コード（CSVの土台）

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-625）
- Create: `src/lib/accounting/copy/copy-types.ts`、`profiles/freee-csv.ts`、`profiles/mf-csv.ts`、`profiles/profile-types.ts`、`encoders/shift-jis-encoder.ts`、`encoders/bom-encoder.ts`、`tests/unit/lib/accounting/copy/profiles.test.ts`、`encoders.test.ts`、`tests/fixtures/accounting-copy/freee-import-schema.json`、`mf-import-schema.json`、`csv-vectors.json`、`source-metadata.json`
- Read: 計画6 Task 12、上の公式原文、両社がそのページから配る見本のファイル。fixture は公表された書式と架空の会計の数値だけ。利用者の情報・鍵の値は含めない

**Interfaces:**
- Consumes: 計画6の `ExportColumn<T>`・`ExportEncoder`・`CopySafeOptions`・`UTF8_ENCODER`。共通の `csv-writer.ts` は Read のみ。
- Produces: 上の共通の型、`getCopyProfile(provider:CopyProvider,encoding:'utf-8'|'shift_jis',version:string):CopyProfile`、`SHIFT_JIS_ENCODER:ExportEncoder`（name=`shift_jis`）、`withBom(encoder:ExportEncoder,bom:readonly number[]):ExportEncoder`。**withBomの戻り値のnameは元のencoder.nameと厳密に同じ**で、BOMの有無を名前へ足さない。版ごとのprofileを保持し、過去の束はそのprofileVersionで引く。BOMの根拠は値別の表に従い、sha256はBOMを含む実バイトから出す。fixture_only版は別registryで、Task 10のlocalhost検査を通るbootstrapだけが選択可能、本番registryでは必ず拒否する。
- Produces: `COPY_ISSUE_CODES=['mapping_missing','tax_unconfirmed','profile_unverified','unrepresentable','name_too_long','limit','remote_period_closed','not_imported','unsupported_entry','period_mismatch','source_changed','result_unknown','supervision_required','incomplete_remote','validation','permission','reconnect','rate_limited'] as const`。画面から受け取る失敗codeとDBのdetailもこの集合だけ。`CopyIssue.code`はこの要素の型へ狭め、外部の文をcodeにしない。
- Produces（公式書式の固定）: 両社とも列数を計画に固定せず、公式本文と配布見本の全列名・順をfixtureへ取り込み、それから `ExportColumn` を作る。MFは作成日時・作成者に続く最終更新日時・最終更新者も含め、未使用の管理列・部門・タグ等は削らず空。freeeは `[表題行]`・`[明細行]`、日付・伝票番号・決算整理・借貸の勘定／金額／税額／税区分／摘要を見本の列へ対応させる。ヘルプと見本が違えばcontrollerが根拠と採用版を記録するまでその書式を完了にしない。
- Produces（profileの値）: 両社とも `neutralizeFormulas:false`。MFの文字セルに順に `\r\n→半角空白`、`\r→半角空白`、`\n→半角空白`、ASCII二重引用符→全角の `＂` を指定する（既定の置換はAIの判断。公式は「別の記号」まで）。置換後の値が禁止文字・長さを満たすか検査する。勘定・税の正式名をこの置換で変えてしまう場合は、置換して通さず停止。freeeの置換は公式見本で必要と判明した物だけ。いずれも共通層の相手名分岐は0件。
- Produces（Shift-JIS）: サーバーで利用できる WHATWG decoder の1バイト（ASCII・半角カナ）と有効な2バイト列を列挙し、fatal decodeが成功し1文字へ戻る対応だけを逆引きする。重複は最短、同長ならバイトの辞書順。encode後に同じdecoderで元の文字へ戻らない対応を使わない。`?`・空白・近い字への置換はしない。yen・波ダッシュ・機種依存字も固定ベクトルで検査し、見本のCP932との差があれば不可能字として止め、勝手にUnicode正規化しない。Nodeの対応が無い環境は構成不備で停止（依存の追加はcontroller判断）。
- Produces: `MAX_COPY_ENTRIES=5000`・`MAX_COPY_ROWS=10000` は店のアプリの上限（相手の公式上限とは別）。未取得値は上の値別の表どおりに取得・確認し、能力とencodingごとのevidence・blockedCasesを持つ。未確認の特例1つで全profileを止めない。本番用の受入れの根拠とfixture_onlyの期待バイトは別に保持し、fixtureで本番用の確認済み表示へ進めない。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-625-AC-01: MFの列は最終更新日時と最終更新者を含む公式fixtureの全列と順に一致し、freeeは表題行と明細行を含む公式見本と一致する`、`FREQ-625-AC-02: UTF-8とShift-JISは公式見本の日本語・半角カナ・BOMを含むバイトと一致する`、`FREQ-625-AC-02: 絵文字・不正なサロゲート・復号で違う字になる入力は不可能字を返し、疑問符へ変えない`、`FREQ-625-AC-03: profileで文字セルの置換と式対策を渡し、共通層にはfreeeとmfという条件分岐が無い`、`FREQ-625-AC-04: -500は数のセルのままで、文字セルの=・+・-・@・タブ・CRだけがneutralizeFormulasの真偽に従う`（計画6の共通層の試験も併用）、`FREQ-625-AC-05: 未確認の組だけ拒否し通常行は通るがfixture_only版を本番で使えず、その成功を本番profileの確認済みへ流用しない`。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting/copy/profiles.test.ts tests/unit/lib/accounting/copy/encoders.test.ts --runInBand`。モジュールまたはfixtureが未定義でFAIL、公式サイトへHTTPを出して失敗した結果はREDに数えない。
- [ ] **Step 3: 公式の見本を読み、Interfacesどおり実装する。** 公式原文から書式・日付・値・上限を抜き出し、取得日・URL・見本sha256をmetadataに残す。Jestからネットへ取りに行かない。CSVの引用符・CRLF・sha256自体は計画6の関数を使う。
- [ ] **Step 4: GREEN を測る。** 上の単体と `npx.cmd jest tests/unit/lib/accounting/export --runInBand`、`npx.cmd tsc --noEmit --incremental false`、変更ファイルのESLint。未取得値が関係する組だけを無効にした拒否試験と通常行の成功を確認し、fixture_onlyの成功と本番用見本の取得の報告を区別する。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 写しの公式書式と文字コードのprofileを足す`

### Task 2: 相手の事業者・年度の設定と対応表の改版

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-626）
- Create: `supabase/migrations/<ts53>_accounting_p7_copy_settings.sql`、`src/lib/accounting/copy/copy-settings.ts`、`mapping.ts`、`tests/unit/lib/accounting/copy/mapping.test.ts`、`tests/integration/db/accounting_p7_copy_settings.integration.test.ts`、`tests/integration/db/accounting_p7_migration_asserts.integration.test.ts`
- Read: 計画1 Task 7の設定の版・要求番号、計画5 Task 4・7の税の材料（読むだけ）

**Interfaces:**
- Consumes: `AccountingPeriod`・`AccountingSettings`・`ACCOUNTS`・`ACCOUNTING_SUB_ACCOUNTS`。税の設定は `consumptionTaxStatus`・`consumptionTaxableFrom` を正とし、別の日を重複して設定しない。
- Produces（S53、全て新規）: `accounting_copy_targets(id uuid PK,provider text CHECK IN ('freee','mf'),business_type text,remote_office_ref text,created_by uuid,created_at timestamptz)`。同じprovider・事業の形・事業者番号はUNIQUE。接続先を変える時は別targetを作り、前の成功記録を消さない。`accounting_copy_setting_revisions(id uuid PK,target_id uuid FK,version bigint,period_id uuid FK,remote_starts_on date,remote_ends_on date,encoding text CHECK IN ('utf-8','shift_jis'),accounting_method text CHECK IN ('tax_inclusive','tax_exclusive'),rounding text CHECK IN ('floor','ceil','round'),remote_tax_mode text CHECK IN ('exempt','taxable'),buyer_invoice_feature boolean,profile_version text,settings jsonb,created_by uuid,created_at timestamptz,request_key uuid UNIQUE,request_hash text,UNIQUE(target_id,period_id,version))`。期間は相手の会計年度と一致させ、1年超を断る。settingsは `enabled_tax_names`・`catalog_checked_on`・`catalog_source` の固定鍵だけ。
- Produces: `accounting_copy_mapping_revisions(id uuid PK,target_id uuid FK,version bigint,kind text CHECK IN ('account','tax','invoice','sub_account','counterparty'),source_key text,target_name text CHECK(char_length(target_name) BETWEEN 1 AND 30),remote_id text NULL,enabled boolean,source_url text,checked_on date,created_by uuid,created_at timestamptz,request_key uuid UNIQUE,request_hash text,UNIQUE(target_id,kind,source_key,version))`。30字は設計15-bの名前の上限。CSVで使う正式名とAPIで使うIDを分ける。`source_key` は勘定符号、または税区分・率・invoice class・特例の種類の正規化した組。勝手な略称を作らない。
- Produces（CSVから使う監督の記録）: `accounting_copy_supervision_checks(id uuid PK,target_id uuid FK,event text CHECK IN ('checked','invalidated'),terms_version text,terms_url text,checked_on date,handling text CHECK IN ('entrusted','not_handled'),purpose_reviewed boolean,security_reviewed boolean,countries jsonb,foreign_disclosure_required boolean,foreign_disclosure_completed boolean,open_questions jsonb,evidence_ref text,valid_until date,created_by uuid,created_at timestamptz,request_key uuid UNIQUE,request_hash text)`（追記専用）。`CopySupervisionInput={termsVersion:string;termsUrl:string;checkedOn:string;handling:'entrusted'|'not_handled';purposeReviewed:boolean;securityReviewed:boolean;countries:readonly string[];foreignDisclosureRequired:boolean;foreignDisclosureCompleted:boolean;openQuestions:readonly string[];evidenceRef:string;validUntil:string}`。国はISOの国名の識別子で、空や不明を国内扱いしない。`admin_record_accounting_copy_supervision(_actor_id uuid,_target_id uuid,_input jsonb,_request_key uuid) RETURNS jsonb`（settings.manage）、`private.accounting_copy_supervision_ready(_target_id uuid) RETURNS boolean`（STABLE・入口なし）、`public.get_accounting_copy_supervision(_target_id uuid) RETURNS jsonb`（STABLE）。現行規約の確認と目的・安全対策・必要な国の公表が済み、未解決0件・有効期限内のcheckedだけがready。Task17はこの記録の確認手順と根拠を文書にする。
- Produces（TS）: `CopySettings={targetId:string;provider:CopyProvider;period:AccountingPeriod;remoteStartsOn:string;remoteEndsOn:string;encoding:'utf-8'|'shift_jis';accountingMethod:'tax_inclusive'|'tax_exclusive';rounding:'floor'|'ceil'|'round';remoteTaxMode:'exempt'|'taxable';buyerInvoiceFeature:boolean;revisionId:string;profileVersion:string}`、`CopyMapping={revisionId:string;kind:'account'|'tax'|'invoice'|'sub_account'|'counterparty';sourceKey:string;targetName:string;remoteId:string|null;enabled:boolean}`。`resolveCopyMapping(settings:CopySettings,mappings:readonly CopyMapping[],line:CopyLineTax,accountCode:string):{ok:true;account:CopyMapping;tax:CopyMapping|null;invoice:CopyMapping|null}|{ok:false;issues:readonly CopyIssue[]}`。freeeは税・率・invoiceを税名1つへ、MFは税名とinvoice名へ。免税の出力の例外も内部分類の欠落を許す意味ではない。
- Produces（freee機能の未確認）: buyerInvoiceFeatureは原文確認後の設定値だけを持つ。Task 1・2で買い手側対応機能の有無と適用条件を原文から取得し、その後にFREQ-626-AC-03の必要な設定と期待値を決める。設計の記述を、取得できたヘルプの保証とは扱わない。確認未了の経過措置の組だけを停止し、falseを「機能不要と確認済み」の代用にしない。
- Produces（private本体＋public入口）: `admin_create_accounting_copy_target(_actor_id uuid,_input jsonb,_request_key uuid) RETURNS jsonb`、`admin_set_accounting_copy_settings(_actor_id uuid,_target_id uuid,_period_id uuid,_input jsonb,_expected_version bigint,_request_key uuid) RETURNS jsonb`、`admin_set_accounting_copy_mapping(_actor_id uuid,_target_id uuid,_input jsonb,_expected_version bigint,_request_key uuid) RETURNS jsonb`。権限settings.manage。`public.get_accounting_copy_settings(_target_id uuid,_period_id uuid) RETURNS jsonb`、`public.list_accounting_copy_mappings(_target_id uuid) RETURNS jsonb` はSTABLE。現物の登録・利用の有無はCSVではオーナーの確認済みカタログ、APIではTask11の取得結果と照合し、不明・未登録なら停止。
- Produces: S53 DETAIL `acc_s53_tables`・`acc_s53_immutable`・`acc_s53_rls_acl`・`acc_s53_function_attrs`・`acc_s53_reads_stable`・`acc_s53_existing_dml_allowlist`。全FKはON DELETE RESTRICT、履歴の版は更新・削除・TRUNCATEを断る。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-626-AC-01: 対応名は30字が通り31字は断られ、無い勘定を未確定勘定へ落とさない`、`FREQ-626-AC-02: 税区分・率・インボイスの組が違えば別の対応で、未使用の相手の区分は使えない`、`FREQ-626-AC-03: freeeの経過措置はTask 1・2で原文取得後に機能と条件の期待値を決め、未確認の組は出さない`、`FREQ-626-AC-04: MF免税年と年度途中の登録の設定は計画1の期間の設定と一致し、独自の登録日で上書きできない`、`FREQ-626-AC-05: 版の競合は409、同じ要求の再送は同じ改版、内容違いは拒否`、`FREQ-626-AC-06: 対応表の旧版と旧targetは残り、別事業者に前の転記済みが流用されない`、`FREQ-626-AC-07: settings.manageが無い人は42501、anon/authenticatedは読書不可、service_roleは直接書けない`、`FREQ-640-AC-01: 監督の確認に規約の版・日付・国・根拠が残り、未解決と期限切れはreadyにならない`、`FREQ-640-AC-03: 国や必要な公表が未確認ならCSVもAPIも有効化の確認を通らず、記録には秘密の値を持たない`。
- [ ] **Step 2: RED を測る。** 単体は `npx.cmd jest tests/unit/lib/accounting/copy/mapping.test.ts --runInBand`、controllerは `npx.cmd jest tests/integration/db/accounting_p7_copy_settings.integration.test.ts --runInBand`。まだ無い表・関数でFAIL。
- [ ] **Step 3: S53と純粋な対応の関数を実装する。** 現行DBへの置換ではなく新規作成。文字数はUnicodeの文字数でTSとDBを合わせ、末尾を切って通す実装をしない。APIをオンにする道はまだ作らない。
- [ ] **Step 4（controller）: GREEN を測る。** 単体・型・lintと共通verify。NULL・空文字・異なる事業の形・改ざんした最新版の索引も拒否試験へ入れる。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 写しの設定と対応表を改版で持つ`

### Task 3: 仕訳の行の税の分類・日付の表・1億円・特例

controller が別セッションへ先に知らせる（計画6の行の税のhelperと、その本文を検査する試験）。Task 2のコミット後に始める。

最初に国税庁の原文から旧10億円の適用開始日・課税期間の境界を取り、下の固定ベクトルへ入れる。レビューの推測の日付をそのまま採用しない。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-627）、`tests/integration/db/accounting_p6_audit_reads.integration.test.ts`・`accounting_p6_migration_asserts.integration.test.ts`（S48の仮のNULL本文だけを置き換える意図した変更）
- Create: `supabase/migrations/<ts54>_accounting_p7_copy_tax_classes.sql`、`src/lib/accounting/copy/tax-policy.ts`、`tax-classification.ts`、`tests/fixtures/accounting-copy/tax-policy-vectors.json`、`tests/unit/lib/accounting/copy/tax-policy.test.ts`、`tests/integration/db/accounting_p7_copy_tax_classes.integration.test.ts`
- Modify: `tests/integration/db/accounting_p7_migration_asserts.integration.test.ts`
- Read: 計画3の消費税用返金一覧、計画5の `accounting_line_tax_marks`・持ち出しの税区分。金額・仕訳の書き手は変更しない

**Interfaces:**
- Consumes: Task 2の設定、計画1の仕訳・期間、計画6の `private.accounting_line_tax_class(entry_id,line_no) RETURNS TABLE(tax_category text,invoice_category text)`（実装時にpg_procで実際の引数名・型を取得し同一署名にする）。
- Produces（S54）: `accounting_copy_line_tax_revisions(id uuid PK,entry_id uuid FK,line_no integer,version bigint,tax_category text NOT NULL,rate_bps integer CHECK IN (0,500,800,1000),invoice_class text,invoice_percentage integer NULL CHECK IN (0,30,50,70,80,100),taxable_on date NOT NULL,gross_amount bigint CHECK>=0,tax_amount bigint NULL CHECK>=0,supplier_ref uuid NULL,exception_kind text NULL,evidence_id uuid NULL,original_entry_id uuid NULL,original_line_no integer NULL,details jsonb,confirmed_by uuid,confirmed_at timestamptz,request_key uuid UNIQUE,request_hash text,UNIQUE(entry_id,line_no,version))`。仕訳の行への複合FKと、税額<=税込額、分類ごとの必須列をCHECK。`original_*` は規則T2の元の行で、両方NULLか両方非NULL、元の行への複合FK。計画1の取消し（`reverses_entry_id` あり）は元の仕訳と同じline_noを初期値に示し、法人の締めた年の訂正（計画6の前期損益修正。`reverses_entry_id` なし）と仕入れの返品・値引きは人が確認で元の行（元の仕入れ）を選ぶ。経過措置に当たる相手の返品・値引きで元の行が無い確認は通さず、`tax_unconfirmed` のまま残す。実装時に計画1の取り消しの道具が行の順を保つことを確かめ、保たなければ止めてcontrollerへ知らせる。帳簿のみの住所・所在地は外へ送らずrestrictedなdetailsに記録し、個人の名前をsource_keyに使わない。invoiceの売上等の非該当は明示的にnot_applicable、NULLを適格と見なさない。
- Produces: `accounting_copy_tax_policy_revisions(id uuid PK,version bigint,valid_from date,valid_to date NULL,transition_percentage integer,annual_supplier_cap bigint NULL,source_url text,checked_on date,created_by uuid,created_at timestamptz,request_key uuid UNIQUE,request_hash text)`。設定操作が法律の日付表を改版し、期間の重複・すき間を断る。既定の表は 2023-10-01〜2026-09-30=80、2026-10-01〜2028-09-30=70、2028-10-01〜2030-09-30=50、2030-10-01〜2031-09-30=30、2031-10-01以後=0。これより前は自動で経過措置にしない。
- Produces（規則T1の固定の表。S54）: `accounting_copy_line_tax_fixings(entry_id uuid,line_no integer,line_tax_revision_id uuid FK,supplier_ref uuid NOT NULL,tax_period_starts_on date,tax_period_ends_on date,fixing_seq bigint CHECK>=1,cap_rule text CHECK IN ('within_cap','from_original','owner_decided'),original_entry_id uuid NULL,original_line_no integer NULL,cap_decision_id uuid NULL FK,cap_used_before bigint CHECK>=0,cap_delta bigint,segments jsonb,first_source_id uuid NOT NULL,created_at timestamptz,PRIMARY KEY(entry_id,line_no),UNIQUE(supplier_ref,tax_period_starts_on,fixing_seq))`。仕訳の行への複合FK。2026-10-01以後に始まる課税期間の経過措置の行（1億円の上限の対象）だけを持つ。追記専用でUPDATE・DELETE・TRUNCATEを断る。`first_source_id` のFKはS55がALTERで足す。書くのはS55の `private.accounting_prepare_copy_batch_core` だけで、targetをまたいで1行1回。`within_cap` は全部が経過措置、`from_original` は規則T2で元の行の分け方を写した行（`original_*` 必須）、`owner_decided` は下の入口で人が決めた分け方（`cap_decision_id` 必須）。`cap_delta` は上限の使用額への寄与で、行の経過措置の区分の符号つきの額（取消し・返品の負の行は負）。`cap_used_before` はそれより前の `fixing_seq` の `cap_delta` の和に等しく、`cap_used_before + cap_delta <= 100,000,000` をCHECKと書き口の両方で守る。
- Produces（人が決めた分け方。S54）: `accounting_copy_cap_decisions(id uuid PK,entry_id uuid,line_no integer,version bigint,line_tax_revision_id uuid FK,segments jsonb,evidence_ref text,reason text CHECK(char_length(reason) BETWEEN 1 AND 500),decided_by uuid,decided_at timestamptz,request_key uuid UNIQUE,request_hash text,UNIQUE(entry_id,line_no,version))`（追記専用）と入口 `admin_decide_accounting_copy_cap(_actor_id uuid,_entry_id uuid,_line_no integer,_input jsonb,_expected_version bigint,_request_key uuid) RETURNS jsonb`（entries.correct、private同署名本体＋public入口）。inputは `{segments:[{invoice:'transitional'|'no_credit',grossAmount}],evidenceRef,reason}` で、オーナーが税理士と決めた分け方。割合は行の `taxable_on`（`from_original` なら元の行）から引き、入力で受けない。入口とprepareの両方で、①区分の額の和が行の額と等しい、②固定済みの和と今の束の前の行に足して1億円以下、③写した行とこの行の控除の元（税額×割合、端数の前）が、同じ行を日付の順に厳密に数えた額を超えない、を確かめ、③を破れば `ACCOUNTING_COPY_TAX_UNCONFIRMED`（DETAIL `cap_decision_exceeds_strict`）で断り、画面に厳密な数えの分け方を参考として出す。固定済みの行には使えない。
- Produces（TSの下見用の写し）: `transitionPercentage(on:string,rules:readonly TaxPolicyRule[]):0|30|50|70|80`、`classifyCopyTax(input:TaxClassificationInput):{ok:true;segments:readonly CopyTaxSegment[];warnings:readonly string[]}|{ok:false;issues:readonly CopyIssue[]}`。`TaxPolicyRule={revisionId:string;from:string;to:string|null;percentage:0|30|50|70|80;annualSupplierCap:number|null}`、`CopyTaxSegment={grossAmount:number;taxAmount:number|null;invoice:InvoiceClass;percentage:number|null}`。`TaxClassificationInput={line:CopyLineTax;period:AccountingPeriod;settings:CopySettings;rules:readonly TaxPolicyRule[];capUsedBefore:number;capProjected:number;fixed:readonly CopyTaxSegment[]|null;original:readonly CopyTaxSegment[]|null;ownerDecision:readonly CopyTaxSegment[]|null;taxPeriodStartsOn:string;transactionGross:number;eligibility:{baseSales:number|null;specificSales:number|null;booksKindAllowed:boolean|null;addressOmissionAllowed:boolean|null}}`。TSは画面の下見と、同じ固定入力で下のDBの正本と同じ答えになるかを確かめるためだけに使う。束の中身・配賦・sourceHashの材料には使わず、TS計算のsegmentsをprepareへ渡さない。値が不明ならfalseで通さず未確認にする。
- Produces（S54の税の計算の正本）: `private.accounting_copy_tax_segments(_period_id uuid,_entry_ids uuid[],_line_tax_revision_ids uuid[],_policy_revision_ids uuid[]) RETURNS jsonb`（STABLE、postgres所有、SECURITY DEFINER SET search_path=''、public入口なし、service_roleもREVOKE）。戻りは `{ok:true,lines:[{entry_id,line_no,line_tax_revision_id,segments:[{grossAmount,taxAmount,invoice,percentage}],annual_basis:{basis_id,cap_rule,already_fixed,cap_used_before,cap_delta,transaction_gross}|null}],supplier_bases:[{basis_id,tax_period_starts_on,tax_period_ends_on,supplier_ref,policy_revision_ids,fixed_through_seq,fixed_cap_used,cap_projected,cap_decision_ids}],warnings:[固定code]}` または `{ok:false,issues:[CopyIssue相当]}`。引数のentryと全行の分類版の対応、policyの期間と割合を検査する。税の割合・特例判定・規則T1の累計と1億円を超える行の止め・規則T2の写し・人が決めた分け方の検査・最大剰余法での税額配賦の全てをDBで計算する。上限を超える所を自動で控除なしに分ける計算は持たない。固定済みの行は固定の表のsegmentsと分類版をそのまま返し（`already_fixed=true`）、計算し直さない。返還の扱い・資格・対象候補の分類が未確認ならissuesで止め、未確認行を累計から黙って落とさない。
- Produces（累計を読む範囲と鍵。規則T1）: 同じsupplier×課税期間について、①固定済みの和 = 固定の表の `cap_delta` の和、②見込みの累計 = ①＋帳簿にある未固定の確認済みの経過措置の行（束の外・後の月も含む。取消し・訂正・返品の負の行は規則T2の経過措置の区分の額、人が決めた行はその経過措置の区分の額）の和、③束の中の累計 = ①＋今の束の中でその行より前の未固定の行（`(taxable_on,entry_no,line_no)` 順）の寄与。②が1億円以下で③も1億円以下なら、その行は全部経過措置（`within_cap`）か規則T2（`from_original`）で固定する。②が1億円を超えたら、その取引先×課税期間の未固定の経過措置の行は、人が決めた行と規則T2の負の行を除いて全部 `tax_unconfirmed`（warning `cap_exceeded`、「1億円の上限を超えます。分け方を税理士に確かめてください」）で止める。②が1億円以下でも③が超える時（束の外の取消し・返品で下がる形）は、その行を止めて「同じ取引先の取消し・返品を同じ束に入れてください」と出す。後の行は前の行の分け方を変えないので、見込みの累計が1億円以下の間は、後の月の未確認の行や新しい仕入れで前の月のpreview・sourceHashは変わらず止まらない。supplier_basesは、そのsourceが読んだ固定の到達点 `fixed_through_seq` とその時点の `fixed_cap_used`、見込みの累計 `cap_projected`、使った人の決定のID集合を課税期間×supplierごとに1回だけ持つ（固定の表と決定の表は追記専用なので、これで読んだ範囲を再現できる）。`cap_projected` は記録と画面の表示だけに使い、basis_idとsourceHashの材料に入れない（見込みの累計が1億円以下のまま変わっても前の月のsourceHashを変えないため。prepareは鍵の中で②を計算し直し、1億円を超えていれば止める）。順は `(taxable_on,entry_no,line_no,period_id,entry_id)`。Task 4のprepareは①G・②会計・③出力期間と対象の課税期間に重なる全期間をID順・④の鍵の中でこの関数を呼んで固定の表へ書き、確認・新しい仕入れ・取消し・ほかのtargetのprepareと競合しない。previewはSTABLEの同じ文のsnapshotから同じ計算関数を呼ぶ下見であり、確定を保証しない（間にほかの束が同じ相手の行を固定すれば `fixed_through_seq` が進み、prepareはexpected_source_hashの不一致で断る）。prepareが鍵取得後に再計算しexpected_source_hashと照合する。STABLE helper自身は書込・鍵取得をしない。
- Produces（1億円）: 2026-10-01以後に始まる課税期間は、同じsupplierの暦年（法人は事業年度）の経過措置の仕入れを規則T1で税込みに数える。1億円以下の間は全部が経過措置。1億円を超える所を自動でno_creditへ分けず、上のとおり止めて、人が `admin_decide_accounting_copy_cap` で入れた分け方だけで写す（`owner_decided`）。累計は選んだ月・出力範囲・未転記分に狭めない。相手のsupplier_refが無い（NULL）経過措置の行は、1億円の累計を作れないので `tax_unconfirmed` で止める（固定ベクトルに入れる）。人が決めた分け方で1行が2区分になる時は派生行にするが同じ仕訳の中に保つ。税額の分けは元の税額を上限とした最大剰余法（同率なら元のline_no順、同じ元行の派生区分はsegmentのordinal順）で合計を一致させる。旧10億円の対象期間は原文から適用開始日を確認して別ルールにし、未確認なら該当行を止める。90,000,000円以上で「経過措置の上限に近づいています」を出すのは店の注意の閾値（AIの判断）。取消し・訂正・返品の行（`original_*` あり、`cap_rule='from_original'`）は規則T2で元の行の固定の分け方を写す（割合は元の行のまま。今の累計や返品の日の割合で計算し直さない）。額はその行の額で、元の行の一部の額でもよい。元の行が1区分（全部が経過措置）なら行の額を全部その区分に、元の行が人の決めた2区分なら行の額を元の区分の比で最大剰余法により分け、端の1円は経過措置の側へ寄せる（負の行で控除を多く減らす側）。`cap_delta` はその行の経過措置の区分の符号つきの額で、元の行のsupplier×課税期間の累計に入れる。正の額の訂正で1億円を超えるならT1で止める。元の行がまだ固定されていなければ同じ束で元の行を先に固定してから写し、元の行を同じ束に入れられない時は `tax_unconfirmed` で止めて「元の仕訳を先に写す」と出す。法人の締めた年の訂正は、計画6 Task 9の訂正の仕訳（見つけた年の日付・前期損益修正の勘定 `8015`・`8025`、誤りの差の額）をそのまま写し、仕入れの行に当たる行は同じ規則T2で元の行に倣う。元の行が分からない返品・値引き（仕入れの勘定の貸方の行）は、経過措置に当たる相手の物なら `tax_unconfirmed`（warning `return_original_required`）で止め、オーナーが元の仕入れを選んだ後に同じ規則T2で写す。T2の扱いはAIの判断で、未確認#4で税理士に確かめる。
- Produces（固定の保存と後日の出来事）: Task 4のS55は上のDB計算のlinesとsupplier_basesをそのまま保存し、同じトランザクションで未固定の上限の行を固定の表へ書く（`fixing_seq` はsupplier×課税期間ごとに鍵の中で次の番号）。行はbasis_idと `cap_used_before`・`cap_delta`・取引全体額を指す。過去の束の再読込・再出力・retry子・別targetの束は、固定の表と保存したsegmentsだけを使い、今の累計で計算し直さない（規則T1）。古い日付の仕入れ・取消し・返品・分類改版の後も、固定した行の分け方を変えない。新しい行は次の束で規則T1・T2により固定するか、1億円を超えれば止まる。`list_accounting_copy_tax_issues` は、止めた行（1億円を超える行・元の行の分からない返品・supplierの無い行）を「人が決める」一覧として、決める入口（`admin_decide_accounting_copy_cap`、元の仕入れの選択）とともに出す。案内として「固定後に分類を改めた行」と、見込みの累計が1億円を超えた取引先×課税期間で「先に写した行より日付の早い仕入れが止まっている」物（8%と10%が混ざると先に写した行の控除が日付の順より多い可能性がある）も出す。直すかはオーナーが税理士と決め、直す時は設計15-fの取消し仕訳と正しい仕訳を計画1の取り消しの道具と計画1・3・6の既存の入口で入れる（合う入口が無い形は未確認#4）。照合(Task 7・15)は固定のsegmentsを店の側の元にして比べ、この案内だけでmismatchにしない。過去のsource・sha256・成功claimは保持する。税の確認の入口で帳簿の訂正を自動作成しない。
- Produces（特例）: 帳簿のみはNo.6496・6497の種類、相手の住所等、住所を省略できる種類の表を原文から取得する。少額は2023-10-01〜2029-09-30、**取引単位**の税込み10,000円未満、基準期間売上100,000,000円以下または特定期間50,000,000円以下等の条件を確認する。仕訳の1行ごとに9,999円へ割って使わない。特例とqualifiedは別。両社の取込区分はTask 1で取得した正式名だけを使い、未対応は停止。
- Produces（入口）: `admin_confirm_accounting_copy_line_tax(_actor_id uuid,_entry_id uuid,_line_no integer,_input jsonb,_expected_version bigint,_request_key uuid) RETURNS jsonb`（entries.correct）、`admin_set_accounting_copy_tax_policy(_actor_id uuid,_input jsonb,_expected_version bigint,_request_key uuid) RETURNS jsonb`（settings.manage）、`public.list_accounting_copy_tax_issues(_period_id uuid,_limit integer DEFAULT 200,_after_entry_date date DEFAULT NULL,_after_entry_no bigint DEFAULT NULL) RETURNS jsonb`（STABLE）。S48のhelperは最新の確認済み分類の2列を返し、未設定は従来どおりNULL。**仕訳の行・金額・締めの版・ハッシュはUPDATEしない。** 税の分類の訂正は理由つき改版で、既存の束は古い改版を指したまま、写した分は「分類の差の確認が必要」にする。1億円の上限の行で固定済みの物は、改版の後も固定の分け方と分類版で写し（規則T1）、案内に「固定後に分類を改めた行」と出す。
- Produces: S54 DETAIL `acc_s54_tables`・`acc_s54_tax_helper`・`acc_s54_tax_segments`・`acc_s54_policy_vectors`・`acc_s54_cap_fixings`・`acc_s54_cap_decisions`・`acc_s54_immutable`・`acc_s54_rls_acl`・`acc_s54_function_attrs`・`acc_s54_existing_dml_allowlist`。税の計算口の署名・STABLE・private専用・service_roleのEXECUTEなしもassertする。税務署向けは元の字のままの経路を保つ。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-627-AC-01: 9月30日と10月1日の80から70、2028の70から50、2030の50から30、2031の30から0の全境界は取引日で決まる`、`FREQ-627-AC-02: 2026年11月の経過措置に80を指定しても拒否し、freee税名は税率を含む`、`FREQ-627-AC-03: 見込みの累計が1億円ちょうどなら全部経過措置、1円でも超えれば超える行とその後の未固定の行は止まり自動で控除なしに分けず、別supplierは別累計、累計は選んだ月に狭めず固定した行と束の外の未固定の行も数える`、`FREQ-627-AC-04: 少額は9999円が通り10000円は通らず、同じ取引を分けた2行は合計で判定する`、`FREQ-627-AC-04: 売上条件不明・帳簿のみの種類か住所が不足・未対応の相手区分は未確認で止まり適格へ落ちない`、`FREQ-627-AC-05: 免税の税込みと店の税分類を保持し、登録前日と当日で出力の税区分の扱いを変える`、`FREQ-627-AC-06: 元の取消し・返還は元の課税仕入日を参照し、写す日から割合を決めない`、`FREQ-627-AC-07: 分類なしのaudit列はNULL、確認後は値が出て仕訳とledger chainは前後で同じ`、`FREQ-627-AC-08: TSとSQLは同じ固定ベクトルで、分類の再送・版競合・権限・履歴の不変を守る`、`FREQ-627-AC-09: 後の月の行が未確認でも、新しい仕入れが入っても、見込みの累計が1億円以下の間は前の月の分け方とpreviewのsourceHashは変わらず止まらない`、`FREQ-627-AC-10: 写した後に古い日付の仕入れが入っても写した行の分け方・番号・sourceHashは変わらず、1億円を超える古い仕入れとその後の未固定の行は止まって「1億円の上限を超えます。分け方を税理士に確かめてください」が出て、人が決めた分け方だけで写る（2027年に1月6,000万円とAの6月3,000万円を写した後の2月B 2,000万円は止まり、Aは3,000万円全部が経過措置のまま。Bを経過措置1,000万円・控除なし1,000万円と決めると写る）。supplier_refが無い経過措置の行は止まる`、`FREQ-627-AC-11: 取消し・訂正・返品の行は元の行の分け方と割合を写し額はその行の額で（AC-10の後にAを全部取り消すと使用額7,000万円、A′は3,000万円全部が経過措置）、法人の締めた年にAの3,000万円を1,000万円へ直す訂正は見つけた年の日付と8015・8025の2,000万円のまま写し全部がAの割合の経過措置の負の区分になり、元の行が分からない返品は止まり、2028年2月の仕入れ500万円（70%）を11月に返品して元の仕入れを選ぶと控除の元は350万円減って返品の日の50%では引かず、元の行が未固定で同じ束に無い取消しは止まる`、`FREQ-627-AC-12: 全順の固定ベクトルで、取引先×課税期間の経過措置の合計は1億円以下、固定した行の分け方は不変、1億円を超える行と元の行の無い返品は人が決めるまで写らず、写した控除の元（税額×割合）は日付の順に厳密に数えた額以下（2028年に1月6,000万円・10月A 3,000万円を写した後の2月B 2,000万円を経過措置1,000万円と決めると、税込み額×割合は6,400万円で厳密な順の6,600万円以下（同じ10%なので税額×割合も同じ向き）で通る。2027年に10%の9,000万円と6月の10%のL 800万円を写した後の1月の8%のE 500万円は止まり、Eの200万円を経過措置にする決定は日付の順を超えるので断られ、全部控除なしの決定は通る）`。
- [ ] **Step 1の追加ケース（AC-03・08・10〜12）:** 先に年度後半を転記し、後から古い日付で累計を上限へ押し上げる仕入れを追加する。古い束の固定segments・番号・sourceHash・ファイルsha256と固定の表の行は同じ、1億円を超える古い日付の仕入れとその後の未固定の行は止まり、人の決定の後だけ写ることをSQLとTSの固定ベクトルで検査する。AC-10〜12の数字（6,000万・3,000万・2,000万円、全部と一部の取消し・訂正、2028年の返品500万円、2028年の割合が70%から50%へ変わる例、8%と10%が混ざるE・Lの例）を同じベクトルに入れ、⑦⑧⑨⑩を数で確かめる。2つのtargetで同じ行を写しても固定は1回で同じ分け方になることも入れる。旧10億円の開始日前日・当日・課税期間境界も原文取得後に同じベクトルへ入れる。
- [ ] **Step 1のDB計算のケース（AC-08）:** 同じfixture入力をDBのaccounting_copy_tax_segmentsとTSのclassifyCopyTaxへ渡し、各行のsegments・割合・税額合計・1億円を超える行の止め・不明時のissuesが一致することを検査する。境界日、見込みの累計が99,999,999円の後の1円・2円、人の決めた2区分の最大剰余の同率、別supplier、出力外の月・先行年度行、特例・未確認・返還、固定済みの行（計算し直さない）・規則T2の全部と一部の取消し・訂正・元を選んだ返品・元の分からない返品を含める。DBへ渡す引数とfixtureから導いた累計（固定済みの和・見込みの累計・束の中の前の行）・固定済みsegments・元の行のsegments・人の決定・eligibilityをTSへ渡すだけで、TSの結果をDBへ注入しない。private helperの計算検証はcontrollerのDB接続で行い、public入口や通常service_roleのEXECUTEを追加しない。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting/copy/tax-policy.test.ts --runInBand`、controllerは上のDB suite。
- [ ] **Step 3: 原文の表とS54を実装する。** 最初に国税庁の原文から旧10億円上限の適用開始日・課税期間の境と終了条件を取得し、URL・節・日付・境界ベクトルへ固定する。未取得なら該当期間の規則を実装完了にせず、無関係の2026年以後まで一括停止しない。S48の最新定義を取得し、仮のNULL本文だけを差し替える（計画6が明示した受渡し）。ほかの関数を再定義しない。注文・経費・持ち出しの分類を推測で自動確定せず、元の税の証拠を読み、足りない物だけ人が確認する。税抜時の正本の税額が無ければ計算で帳簿の金額を変更せず停止する。
- [ ] **Step 4（controller）: GREEN を測る。** 共通verify、計画6のauditと元の字のCSVの回帰。旧試験の題は変えず「未設定時はNULL」を残し、確認後の値の試験を追加する。S48を再実行したつもりで今のhelperがNULL本文であることを求めない。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 写しの行の税分類と経過措置の規則を足す`

### Task 4: 元の仕訳の集合の固定・束・占有と仕訳ごとの履歴

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-628）、`tests/integration/db/accounting_p7_migration_asserts.integration.test.ts`
- Create: `supabase/migrations/<ts55>_accounting_p7_copy_batches.sql`、`src/lib/accounting/copy/source.ts`、`batch-types.ts`、`tests/unit/lib/accounting/copy/source.test.ts`、`tests/integration/db/accounting_p7_copy_batches.integration.test.ts`、`accounting_p7_copy_concurrency.integration.test.ts`、`accounting_p7_copy_order.integration.test.ts`、`tests/integration/db/helpers/accounting-copy-fixtures.ts`
- Read: 計画6 Task 2・12・13の版と読み口、計画1の仕訳一覧の目印。願い1のJSONの契約を先にcontrollerと確定する

**Interfaces:**
- Consumes: `public.list_exportable_entries(_period_id uuid,_limit integer DEFAULT 200,_after_entry_date date DEFAULT NULL,_after_entry_no bigint DEFAULT NULL) RETURNS jsonb` を**そのまま**使う。目印は日＋番号、全行がそろった1仕訳を1項目にする。`get_closing_state`・`list_closing_versions`・`get_closing_version_trial_balance`、S54の分類とS53の改版。
- Produces（S55）: `accounting_copy_sources(id uuid PK,target_id uuid FK,period_id uuid FK,kind text CHECK IN ('open','closing'),closing_version_id uuid NULL FK,through_entry_no bigint,opening_version integer NULL,opening_source text,setting_revision_id uuid FK,tax_revision text,mapping_revision text,profile_version text,formatter_version text,source_hash text,created_by uuid,created_at timestamptz)`、`accounting_copy_source_entries(source_id uuid FK,entry_id uuid FK,entry_no bigint,entry_date date,line_tax_revision_ids uuid[],PRIMARY KEY(source_id,entry_id))`、`accounting_copy_source_mappings(source_id uuid FK,mapping_revision_id uuid FK,PRIMARY KEY(source_id,mapping_revision_id))`、`accounting_copy_source_policies(source_id uuid FK,tax_policy_revision_id uuid FK,PRIMARY KEY(source_id,tax_policy_revision_id))`。`CHECK((kind='closing')=(closing_version_id IS NOT NULL))`。元の見出し・行は追記専用なのでそのIDを指し、分類・対応表は固定した版IDを指す。配列の分類IDもprivate書き口が対象の全行との一致を検査する。tax_revision・mapping_revisionは選んだ版ID集合のhashであり、そのhashだけを持って最新版から再生成しない。ファイル内容は保存しない。
- Produces: `accounting_copy_batches(id uuid PK,target_id uuid FK,source_id uuid FK,method text CHECK IN ('csv','api'),selection jsonb,scope text,purpose text CHECK IN ('import','reexport'),reexport_acknowledged boolean,created_by uuid,created_at timestamptz,request_key uuid UNIQUE,request_hash text)`、`accounting_copy_batch_entries(batch_id uuid FK,entry_id uuid FK,ordinal integer CHECK BETWEEN 1 AND 999999999,voucher_no text CHECK ~ '^[0-9]{1,20}$',claim_role text CHECK IN ('claim_owner','history_only'),PRIMARY KEY(batch_id,entry_id),UNIQUE(batch_id,ordinal))`、`accounting_copy_events(id bigserial PK,target_id uuid FK,batch_id uuid FK,entry_id uuid NULL FK,event text,method text,at timestamptz,actor_id uuid,code text NULL,remote_kind text NULL,remote_id text NULL,export_id uuid NULL FK,request_key uuid UNIQUE,request_hash text)`。イベントはprepared・exported・confirmed・failed・unknown・resolved・retry_prepared・rebuild_requested・withdrawn・reexport_confirmed・reexport_failedを許し、履歴は変更不可。targetと束とentryの整合を複合FKで守る。`event='confirmed'` の `(target_id,entry_id)` は部分UNIQUEで最初の成功を1回に制限し、history_onlyの確認にはreexport_confirmed/reexport_failedを使う。
- Produces: `accounting_copy_claims(target_id uuid FK,entry_id uuid FK,batch_id uuid FK,state text CHECK IN ('reserved','awaiting_confirmation','succeeded','failed','result_unknown'),version bigint,PRIMARY KEY(target_id,entry_id))` は現在値。privateだけが更新。**方法では分けない**のでCSV確認待ちとAPIが競合できない。別ソフト・別事業者は別target。失敗からやり直す場合も旧イベントと束を残す。
- Produces（元の集合）: openは①②③の鍵の中で現在の最大entry_no・期首の根拠・分類改版を捕まえ、同一トランザクションで既存の読み口を200本ずつ最後まで読み、上限番号以下の集合を固定する。closingは選んだ版の期間・through_entry_no・期首の版に限定する。個人は指定した訂正後の版を選べる。法人は `tax_only=false` の会計の締めの版だけで、税の調整を仕訳として水増ししない。`scope='all'` でも確認待ち・不明の仕訳は新しい束を拒否。成功済みを含む全件出力は明示のreexport確認を要し、元の成功の状態は消さない。
- Produces（private本体＋public入口）: `admin_prepare_accounting_copy_batch(_actor_id uuid,_target_id uuid,_selection jsonb,_expected_source_hash text,_reexport_acknowledged boolean,_request_key uuid) RETURNS jsonb`（export.read。監督readyをDBでも確認）、`admin_record_accounting_copy_export(_actor_id uuid,_batch_id uuid,_meta jsonb,_request_key uuid) RETURNS jsonb`、`admin_confirm_accounting_copy_entries(_actor_id uuid,_batch_id uuid,_results jsonb,_expected_version bigint,_request_key uuid) RETURNS jsonb`（export.read）。`_results=[{entry_id,status:'succeeded'|'failed',code:string|null}]` は束にある仕訳だけ、重複・空・別targetは拒否。成功→失敗で消して再送する操作は無い。`public.preview_accounting_copy(_target_id uuid,_selection jsonb) RETURNS jsonb`、`public.get_accounting_copy_batch(_batch_id uuid) RETURNS jsonb`、`public.list_accounting_copy_batches(_target_id uuid,_limit integer DEFAULT 50,_after_at timestamptz DEFAULT NULL,_after_id uuid DEFAULT NULL) RETURNS jsonb` はSTABLE。
- Produces（出力の確定）: record関数は計画6の `private.admin_record_accounting_export` を同じトランザクションで呼び、kind=`freee_copy`または`mf_copy`、mode=`copy_safe`、列・rowCount・実バイトのsha256・encodingを記録し、exportedを足してawaiting_confirmationへ移す。二重の書き出し履歴表を作らない。metaは記録だけで、source_refとの結びは新しいcopy側の表に持つ。応答が失われても確認待ちは時間で解放しない。
- Produces（固定税の表）: S55へ追記専用の `accounting_copy_source_supplier_bases(source_id uuid FK,basis_id text,tax_period_starts_on date,tax_period_ends_on date,supplier_ref uuid,policy_revision_ids uuid[],fixed_through_seq bigint CHECK>=0,fixed_cap_used bigint CHECK>=0,cap_projected bigint CHECK>=0,cap_decision_ids uuid[],PRIMARY KEY(source_id,basis_id),UNIQUE(source_id,tax_period_starts_on,tax_period_ends_on,supplier_ref))` と `accounting_copy_source_line_facts(source_id uuid,entry_id uuid,line_no integer,line_tax_revision_id uuid FK,segments jsonb,annual_basis_id text NULL,cap_rule text NULL,cap_used_before bigint NULL,cap_delta bigint NULL,transaction_gross bigint NULL,PRIMARY KEY(source_id,entry_id,line_no),FOREIGN KEY(source_id,entry_id) REFERENCES accounting_copy_source_entries ON DELETE RESTRICT,FOREIGN KEY(source_id,annual_basis_id) REFERENCES accounting_copy_source_supplier_bases(source_id,basis_id) ON DELETE RESTRICT)` を足す。annual_basis_id等は全てNULLか全て非NULL、`cap_used_before`・`transaction_gross` は非負をCHECK。上限の行のline_factsのsegments・分類版・`cap_*` は、S54の固定の表の同じ行と一致することをprivate書き口とassertで検査する。S55はS54の固定の表の `first_source_id` へ `accounting_copy_sources(id)` のFK（ON DELETE RESTRICT）をALTERで足す。基礎は課税期間×supplierで1回だけ保存し、行に複製しない。segmentsと基礎はS54のDBの戻りをそのまま保存する。basis_idはS54内でdomain=`accounting-copy-supplier-basis-v1`と課税期間・supplier・policy版・`fixed_through_seq`・`fixed_cap_used` のJSONBから出すSHA256のhexであり、ランダムIDをpreviewとprepareで別々に作らない。このbasis用の指紋はsourceHashとは別。分類等の全固定payloadを読めることを保証し、最新版の2列helperを再読込に使わない。
- Produces（固定元のSQL読み口）: `public.get_accounting_copy_source(_source_id uuid,_limit integer DEFAULT 200,_after_entry_date date DEFAULT NULL,_after_entry_no bigint DEFAULT NULL) RETURNS jsonb`（private同署名本体、STABLE、service_roleだけ）。`{source_id,source:CopySourceRef,settings:CopySettings,mappings:CopyMapping[],policies:[固定policyの全列],entries:[SavedJournalEntry相当の見出しと全lines],taxes:[固定税改版の全列],line_facts:[{entry_id,line_no,line_tax_revision_id,segments,annual_basis_id,cap_rule,cap_used_before,cap_delta,transaction_gross}],next_after_date,next_after_no}` を返す。entriesはsource_entriesへ限定、行の税・設定・対応・policyは固定版だけへJOIN。最大200仕訳、全lines/taxes/line_factsを同じ頁へ返す。supplierの基礎はこの入口で繰返し返さず、別の `public.get_accounting_copy_supplier_basis(_source_id uuid,_basis_id text) RETURNS jsonb`（同じ属性）で固定した1基礎の全列を読む。TSは必要なbasis_idごとに1回だけ取得してMapへ置く。空のsourceはmetadataと終端null。不在・不正cursor・別sourceの基礎は拒否する。get_batchは `{id,targetId,sourceId,selection,method,state,version,entries:[{entryId,ordinal,voucherNo,claimRole}],recovery:{canRebuild,canWithdraw}}` を返す。
- Produces（sourceHashの唯一の計算口）: `private.accounting_copy_source_hash(_manifest jsonb) RETURNS text`（STABLE、入口なし、service_roleもREVOKE）だけがsourceHashを計算する。式は `hex(SHA256(UTF8(jsonb_build_object('domain','accounting-copy-source-v1','manifest',_manifest)::text)))`、既存pgcryptoのschemaは実装時に確認し完全修飾する。manifestはtarget・period・選択範囲とscope・kind・締めの版／上限番号・期首根拠・設定版・profile/formatter版・仕訳ID/日/番号、S54のDB計算のlines（segments・basis_id・`cap_rule`・`cap_used_before`・`cap_delta`等）、supplier_basesの全固定内容（`fixed_through_seq`・`fixed_cap_used` を含む）をbasis_id順に各1回、対応表版とpolicy版。仕訳は日・番号・ID順、行はline_no順、版集合はID順。previewとprepareは同じ内部manifest構築で `accounting_copy_tax_segments` を呼び、その答えだけをこのhelperへ渡す。prepareは対象年度全体の期間も含む①②③④の鍵の中で再計算しexpectedと照合、その答えをline_facts/supplier_basesへそのまま保存する。ok=falseなら保存・claim取得をせず拒否。TSの税計算結果は一切受け取らず、TSはsourceHashも計算・正規化しない。ファイル実バイトのsha256だけは従来の計画6の関数を使う。
- Produces（固定payloadの型）: `FixedCopyTaxRevision={classification:CopyLineTax;version:string;invoicePercentage:number|null;details:Readonly<Record<string,unknown>>;confirmedBy:string;confirmedAt:string;requestKey:string;requestHash:string}` と `FixedCopyPolicy={id:string;version:string;validFrom:string;validTo:string|null;transitionPercentage:number;annualSupplierCap:number|null;sourceUrl:string;checkedOn:string;createdBy:string;createdAt:string;requestKey:string;requestHash:string}` をTask 4で定義する。税の全SQL列はclassificationと残る列へ欠落なく写し、固定元の戻りにtaxRevisionsを保持する。住所等を含み得るdetailsはserver-onlyの固定読みの内部だけで、CopyApiEntry・CSV・画面・監査へ流さない。invoice_percentageは対応するlineFacts.invoicePercentageにも結ぶ。policiesは日付と割合だけへ縮めず全固定列をFixedCopyPolicyとして保持する。
- Produces（TSの新規候補と固定元の分離）: `readCopySource(client:CopyRpcClient,targetId:string,selection:CopySelection):Promise<CopySourcePreview>` はpreviewだけを呼び、`CopySourcePreview={source:CopySourceRef;entryCount:number;rowCount:number;issues:readonly CopyIssue[]}`。`readFixedCopySource(client:CopyRpcClient,sourceId:string):Promise<FixedCopySource>` は専用SQLの全頁と必要な基礎を読み、`FixedCopySource={id:string;source:CopySourceRef;entries:readonly SavedJournalEntry[];taxes:readonly CopyLineTax[];taxRevisions:readonly FixedCopyTaxRevision[];settings:CopySettings;mappings:readonly CopyMapping[];policies:readonly FixedCopyPolicy[];lineFacts:readonly FixedCopyLineFact[];supplierBases:ReadonlyMap<string,FixedCopySupplierBasis>}`、`FixedCopyLineFact={entryId:string;lineNo:number;taxRevisionId:string;invoicePercentage:number|null;segments:readonly CopyTaxSegment[];annualBasis:{basisId:string;capRule:'within_cap'|'from_original'|'owner_decided';capUsedBefore:number;capDelta:number;transactionGross:number}|null}` を返す。`FixedCopySupplierBasis={sourceId:string;basisId:string;taxPeriodStartsOn:string;taxPeriodEndsOn:string;supplierRef:string;policyRevisionIds:readonly string[];fixedThroughSeq:string;fixedCapUsed:number;capProjected:number;capDecisionIds:readonly string[]}`。各頁のsourceId/版/両cursorと基礎の参照を検証する。税の全payloadを保持し、CSV・APIは保存segmentsだけを使う。CSV作成・file取得・再作成・retry子・API inputはこの固定読みだけで作り、TSで再配賦しない。番号は束の固定値を使う。
- Produces（再出力の確認）: claim_roleは束の準備時に固定する。history_onlyは既存succeededを一切更新せず、recordもconfirmも履歴だけを追記し、失敗しても未転記分へ戻さない。claim_ownerだけはreserved→確認待ち→成功／確定失敗を通常どおり適用する。新たな成功を数えるのはclaim_ownerの最初のconfirmedだけ。両roleの確認結果は束の表示には反映するが、成功claimの件数と混ぜない。
- Produces（未出力CSVの復旧）: `admin_recover_accounting_copy_batch(_actor_id uuid,_batch_id uuid,_action text,_reason text,_expected_version bigint,_request_key uuid) RETURNS jsonb`（export.read、actionはrebuild/withdraw）。未出力preparedのCSV束を、同じ鍵と版CASで処理する。claim_ownerがある場合は全て自分のreservedを必須とし、history_onlyだけの束も既存claimを変えず復旧できる。rebuildは同じ束/source/番号を返しrebuild_requestedを追記、TSが固定元から再生成してrecordする。withdrawは理由必須でwithdrawnを追記し自分のclaim_ownerだけをfailedへ移す。record対withdrawの競合は片方だけを許し、withdrawが先ならバイトを返さない。get/listに経過時間と復旧可能操作を返し、process停止後は別request_keyでも明示復旧できる。確認待ち・不明・成功のclaimとAPI束はこの入口で解放しない。
- Produces（CSV/APIが同じ占有を取る内部口）: `private.accounting_prepare_copy_batch_core(_actor_id uuid,_target_id uuid,_selection jsonb,_method text,_expected_source_hash text,_reexport_acknowledged boolean,_request_key uuid) RETURNS jsonb`。service_roleからもREVOKEし、CSVのadmin入口はmethod=`csv`、Task14のAPI入口はmethod=`api`で呼ぶ。request_hashにはmethodとselectionとtargetも含める。claim_ownerの未固定の上限の行は、このcoreだけがS54の固定の表へ規則T1・T2と人の決定で書く（CSVとAPI・targetをまたいで同じ行は1回。history_onlyと固定済みの行は書かない。1億円を超えて止まった行・元の分からない返品は書かず、束をissuesで断る）。APIは成功済みを再送せず、scope=allでも既に成功した物は除き、確認待ち・不明があれば停止する。全件を再びファイルにする操作はCSVのreexportだけ。
- Produces（未終了jobからの移動を止める拡張口）: S55で `private.accounting_copy_claim_transfer_guard(_target_id uuid,_entry_id uuid,_from_batch_id uuid) RETURNS void`（STABLE、public入口なし、service_roleもREVOKE）を作り、通常の準備・CSV retryがfailedのclaimを他の束へ移す直前に呼ぶ。S55時点はCSVだけなので所有検査以外の追加拒否なし。Task 14のS59で同じ署名の本文へ未終了API jobの検査を足す。再試行の所有検査をこの拡張口で代用しない。
- Produces（CSV再試行の入口）: S55のbatchesに `parent_batch_id uuid NULL REFERENCES accounting_copy_batches(id) ON DELETE RESTRICT` を持たせ、`admin_prepare_accounting_copy_retry(_actor_id uuid,_batch_id uuid,_entry_ids uuid[],_expected_version bigint,_request_key uuid) RETURNS jsonb`（export.read）を足す。現在のclaimが親の束・対象entryを指すclaim_ownerでstate=failed、親の版一致の時だけ、同じsource・ordinal・voucherの子へ原子的にclaimを移しretry_preparedを追記する。別の束のreservedを含む所有不一致・成功・確認待ち・不明はACCOUNTING_COPY_PENDINGで拒否し、他のjobから奪わない。API束も不可。confirmed入口はmethod=csvだけ、API成功はworkerだけ。束のversionは最後のイベントIDの10進文字列でexpectedと照合する。同じ鍵の中で検査・子作成・移動を行い、親の履歴を残す。
- Produces: S55 DETAIL `acc_s55_tables`・`acc_s55_source_bounds`・`acc_s55_cap_fixing_fk`・`acc_s55_claim_unique`・`acc_s55_immutable`・`acc_s55_rls_acl`・`acc_s55_function_attrs`・`acc_s55_existing_dml_allowlist`。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-628-AC-01: 201本目と古い日付の訂正が頁の境にあっても欠落・重複が無く全行を読む`、`FREQ-628-AC-02: 版1と個人の版2は各through番号と期首の版を保持し、後から入る古い日付の仕訳は前の束へ混ざらない`、`FREQ-628-AC-02: 法人の税だけの版を会計の仕訳として選ぶと拒否する`、`FREQ-628-AC-03: 未転記分は成功と確認待ちと結果不明を除き、別ソフトの成功は除かない`、`FREQ-628-AC-04: 同時に2つのCSVとAPIを準備しても同じtargetと仕訳の占有は1つで、同じrequest_keyは同じ束`、`FREQ-628-AC-05: 仕訳ごとの部分成功を追記し、成功済みを失敗へ戻しても再送可能にならない`、`FREQ-628-AC-06: 同じ束の再出力は同じ番号・版・sha256で、対応表の変更は過去の束を書き換えない`、`FREQ-628-AC-07: 書き出し記録は計画6のaccounting_exportsにつながり、元のkindと版を追える`、`FREQ-628-AC-08: 全件の再出力は確認を要し、確認待ちがあれば新しい束は拒否、アプリ上限超過は一部の仕訳を黙って切らない`。
- [ ] **Step 1の追加ケース:** AC-02はclosed期間のclosingVersionIdなしを拒否しopen方式を使わせない。AC-06は既転記→古い日付の仕入れ→新しい束で、見込みの累計が1億円以下なら古い仕入れは全部経過措置で写り、超えるならその行とその後の未固定の行が `tax_unconfirmed` で止まり、どちらでも写した行の固定segments・固定の表・番号・sourceHashは変わらないことを検査し、さらに分類・累計・対応表を変更しても専用読み口の全行と固定segmentsが同じでpreview/prepareは唯一のDB helperのsourceHashを使うことを検査。AC-05/08は成功済みと未転記が混ざるallの成功／失敗確認でhistory_onlyのclaimを変えない。AC-04はprepare直後・render後・record直前の停止から再作成すると同じsource・番号・sha256になり、取下げなら未転記を別の方法で写せることを検査。history_onlyだけの未出力束も復旧でき成功claimは不変。Global Constraintsの共通order suiteはTask 4で可能な組の全順をROLLBACK内で実行する。
- [ ] **Step 1のDB計算・所有の追加（AC-04・06）:** preview/prepareがS54のDBの答えだけをmanifestと保存値へ使い、TSのclassifyCopyTaxを意図的に違う答えへ差し替えても束のsourceHash・segmentsに影響しないことを検査する。sourceの各supplier basisの保存件数は課税期間×supplierの数と一致、同じbasisを複数行と複数頁が参照しても基礎は1回だけ取得される。2つのtarget（freeeとMF）の束が同じ上限の行を同時に準備しても固定の表の行は1つで、後の束は（`fixed_through_seq` が進んでsourceHashが変われば読み直した後に）同じsegmentsを使う。CSV失敗→別束がreserved→元CSV retryはACCOUNTING_COPY_PENDINGで拒否し、占有の束と既存jobを変えない。
- [ ] **Step 2（controller）: RED を測る。** 上のDB2suiteと `npx.cmd jest tests/unit/lib/accounting/copy/source.test.ts --runInBand`。並行試験は初めから別の実行へ分ける。
- [ ] **Step 3: S55とsourceのadapterを実装する。** 締める処理・税分類変更も同じ鍵を取るため、捕まえる途中に集合が変わらない。closed期間は必ず会計のclosingVersionIdを要求し、kind=openは実際にopenな期間だけ許す。HTTP・CSV変換はこのトランザクションの外。変換失敗は自分のclaim_ownerだけをfailedにして解放する記録を残し、history_onlyの成功claimには触れず、まだ応答へバイトを返さない。process停止は上の明示復旧へ残す。元の仕訳・版・連鎖の表への書き込みは0件。
- [ ] **Step 4（controller）: GREEN を測る。** 共通verify、競合を観測して3連続。closing capture対訂正・open capture対新しい仕訳・分類変更の順を入れ替えても束のsourceHashと内訳が自己矛盾しないことを確かめる。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 写しの元の集合と仕訳ごとの確認待ちを固定する`

### Task 5: freee・MFのCSVを1仕訳ずつ組み立てる

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-629）
- Create: `src/lib/accounting/copy/csv/entry-rows.ts`、`safe-description.ts`、`build-copy-csv.ts`、`copy-guide.ts`、`tests/unit/lib/accounting/copy/entry-rows.test.ts`、`build-copy-csv.test.ts`、`safe-description.test.ts`
- Read: 計画6のexport共通層、`src/lib/orders/order-number.ts`、`ACCOUNTING_LABELS`、Task1の公式fixture

**Interfaces:**
- Consumes: `CopySourceRef`・`SavedJournalEntry`・`CopyLineTax`・`CopySettings`・`CopyMapping`・`CopyProfile`、**計画6の** `renderCopySafeCsv<T>(rows,columns,opts)`・`sha256Hex`・`sanitizeExportFileName`。`renderVerbatimCsv`・ブラウザーの合成仕訳を参照しない。
- Produces: `copyDescription(entry:SavedJournalEntry):string`（出来事の固定ラベル＋`toOrderNumber(orderId)`まで。sourceのdescription・memo・reasonを丸ごと流さない）、`buildCopyRows(input:{fixed:FixedCopySource;entryIds:readonly string[];ordinals:ReadonlyMap<string,number>;voucherNos:ReadonlyMap<string,string>}):{ok:true;rows:readonly CopyCsvRow[]}|{ok:false;issues:readonly CopyIssue[]}`、`buildCopyCsv(input:{rows:readonly CopyCsvRow[];profile:CopyProfile;source:CopySourceRef}):CopyBuildResult`、`copyPeriodGuide(input:{provider:CopyProvider;businessType:AccountingPeriod['businessType'];isClosedYearCorrection:boolean;outsideCurrentYear:boolean}):readonly string[]`。entryIdsはDBの当該batch_entriesだけを渡し、固定元にあること・重複なし・番号集合との一致を検査してその全行を選ぶ。retry子が親とsourceを共有しても親の成功分を出さない。派生行はfixed.lineFactsの確定済みsegmentsだけから作り、年度累計や最新の分類を再計算しない。
- Produces（1本の構造）: 仕訳の各側をlineNo順に並べ、借方配列と貸方配列を同じindexで組み、足りない側は勘定・金額・税等を空にする。ゼロの架空行を作らない。行は仕訳順に連続。集約・別仕訳への分割はしない。税区分で派生行が増えた時も同じ伝票／Noで、借貸合計が元と等しいことを確かめる。元の仕訳の最大200行と相手の上限の両方を確認し、超えたら止める。
- Produces（番号と決算）: freeeの伝票番号は不変の `entryNo` の10進表記（数字20字以内）。MF取引Noは束のordinal（1〜999999999）、店の番号は仕訳メモの最初の行に1回だけ `店仕訳:<entryNo>`。決算は `period_closing_entry`、その取り消しと訂正は元の決算仕訳へのリンクをたどって判定する。MFの印は全行に `1`、freeeも `1`、その他は空。MFの印で期末へ日付が移るため、元の日が期末でなければ勝手に日を変えず停止してcontrollerへ（未確認#6）。
- Produces（税額）: 免税は税込み金額、税額は空。MFは課税でも税額を空にし、免税年は税区分も空、年度途中登録の前は対象外、当日以後は本来の区分。freeeは税抜方式の課税行に確定した税額を必須で出す。元の仕訳に税の別記行がある場合は公式の別記方式へ対応させ、再計算で二重の仮払／仮受税を作らない。方式の対応が未確認なら停止し、元の額を合わせるために変更しない。
- Produces（個人情報と変換）: 名前・住所・メール・電話・自由な摘要／メモ・顧客の取引先タグは出力の許可欄に含めない。注文のcounterpartyは計画6の決めた値だけ、その他は承認済みの事業者の対応名だけ。置換は文字セルにだけ適用し、数値セルを文字にしない。置換前後で正式な勘定・税名が変わる、長さを超える、文字が表せない時は停止して問題の仕訳番号を示す。元の仕訳の文字は変えない。
- Produces（列別の長さ）: MFの摘要と仕訳メモはそれぞれ200字以下、勘定等の対応名は30字以下。`店仕訳:<entryNo>` の接頭辞・区切りと置換後の全体をUnicode code point数で検査し、DBのchar_lengthと一致させる。全セルへmaxCellLength=30を一括指定せず、各列の制限をbuilderで検査してから共通writerを呼ぶ。切捨て・省略で通さない。
- Produces（案内）: 個人の締めた年の直しには「相手のソフトでその年を締めていたら、先に締めを外す」。freeeで過年度は「年度締めを前の年まで戻してから写す」、MFは「写す年度に切り替えてから取り込む」「仕訳入力の期間制限を確認する」。法人の見つけた年の前期損益修正には過年度解除を求めない。外側の年度と日付が合わないCSVを一緒にしない。
- Produces（再現）: 行の組み立てと固定ラベルはformatterVersionごとのregistryに置き、`source.formatter_version` の実装で再生成する。新しい列やラベルの版を足しても古いformatterを消さない。古い版を読めない場合は最新版で代用せず取得を止める。

- [ ] **Step 1: 失敗する単体を書く。** `FREQ-629-AC-01: 借方3行と貸方1行の200行以内の仕訳は同じ番号で連続し、元の行と貸借合計を保つ`、`FREQ-629-AC-02: 2本の同日同額の仕訳もまとめず、MF番号と店番号とfreee番号の意味を混ぜない`、`FREQ-629-AC-03: 決算の全行に印が付き、期末でない決算の直しは黙って日を移さない`、`FREQ-629-AC-04: 免税年のMFの税区分・税額は空、登録前日が対象外で当日は本来の区分、freee税抜の税額欠落は停止`、`FREQ-629-AC-05: MF税額は課税でも空、税の別記の行を二重に作らない`、`FREQ-629-AC-06: 数の-500は数のまま、MFの引用符・CRLF・CR・LFは文字セルだけ置換し、元の帳簿のバイトは変わらない`、`FREQ-629-AC-07: お客様の情報を全自由文へ入れてもCSVにはなく、注文番号と決めた取引先だけが出る`、`FREQ-629-AC-08: 未対応・名前31字・表せない字・上限超過は全体を停止し一部のCSVを返さない`、`FREQ-629-AC-09: 年度をまたぐ要求は年度別で、個人と法人の案内が10-jに一致する`。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting/copy/entry-rows.test.ts tests/unit/lib/accounting/copy/build-copy-csv.test.ts tests/unit/lib/accounting/copy/safe-description.test.ts --runInBand`。
- [ ] **Step 3: Interfacesどおり実装する。** 変換の選択はprofileだけ。文字コードと列の差を共通writerのifへ押し込まない。ファイル名は `accounting-copy_<provider>_<period名>_<batchの短い番号>.csv` を共通sanitizeへ渡す。番号はバイト再現のため束から受ける。
- [ ] **Step 4: GREEN を測る。** 上の単体と計画6のexportの回帰、型・lint。公式fixtureでの期待バイトと、仕訳の貸借・件数の不変条件を両方確かめる。AC-08に置換と店番号の接頭辞を含む摘要／メモ200字・201字、名前30字・31字の境界を追加し、200/30字は通り201/31字は拒否する。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 保存した仕訳からfreeeとMFのCSVを作る`

### Task 6: CSVのroute・取得・確認・部分失敗の再出力

controller が別セッションへ先に知らせる（共有の `src/lib/accounting/accounting-types.ts`）。Task 5のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-630）、`src/lib/accounting/accounting-types.ts`（拒否表だけ）
- Create: `src/lib/accounting/copy/copy-store.ts`、`copy-schema.ts`、`copy-route.ts`、`csv-service.ts`、`src/app/api/admin/accounting/copies/preview/route.ts`、`batches/route.ts`、`batches/[id]/file/route.ts`、`batches/[id]/confirm/route.ts`、`batches/[id]/retry/route.ts`、`settings/route.ts`、`mappings/route.ts`、`tax/route.ts`、`supervision/route.ts`（以後この節のrouteはすべて `src/app/api/admin/accounting/copies/` 配下）、`tests/unit/lib/accounting/copy/copy-store.test.ts`、`csv-service.test.ts`、`tests/unit/api/admin/accounting-copy-csv-route.test.ts`
- Read: 計画1の `accounting-route.ts`、計画6の `csvResponse(bytes,fileName,encoding)`、Nextのローカル `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- Create: `src/app/api/admin/accounting/copies/batches/[id]/recover/route.ts`

**Interfaces:**
- Consumes: Task 2〜5のDB入口とbuilder、計画6の書き出し記録と `csvResponse`。`CopyRpcClient`、`AccountingStoreError`、共有の認可・CSRF・回数制限・監査を使う。
- Produces（store）: `previewCopy(client,targetId,selection)`、`prepareCopyBatch(client,actorId,input)`、`recordCopyExport(client,actorId,batchId,meta,requestKey)`、`confirmCopyEntries(client,actorId,batchId,results,expectedVersion,requestKey)`、`getCopyBatch(client,batchId)`、`listCopyBatches(client,query)`。各戻り値はZodで検査し、rawのDBエラーを返さない。`createCsvCopy(deps:CsvCopyDeps,input:CreateCsvCopyInput):Promise<{batchId:string;state:CopyBatchState;version:string}>`。`CsvCopyDeps={client:CopyRpcClient;build:typeof buildCopyCsv;now:()=>Date}`、`CreateCsvCopyInput={actorId:string;targetId:string;selection:CopySelection;expectedSourceHash:string;reexportAcknowledged:boolean;requestKey:string}`。
- Produces（route）: `POST preview` body `{targetId,selection}` → `{data:{source:CopySourceRef,entryCount,rowCount,issues,guide}}`。`POST batches` body `{targetId,selection,expectedSourceHash,reexportAcknowledged,requestKey}` →201 `{data:{batchId,state,version}}`（再送は200）。生成・sha256・DB記録を全て終えてから返す。`GET batches?targetId=&limit=&afterAt=&afterId=`、`GET batches/[id]/file` → `csvResponse(bytes,fileName,encoding)`（**取得だけでは写したにしない**）。`POST batches/[id]/confirm` body `{results:[{entryId,status:'succeeded'|'failed',code}],expectedVersion,requestKey}` → `{data:{batchId,state,version,entries}}`。`POST batches/[id]/retry` body `{entryIds,expectedVersion,requestKey}` はS55のretry入口で確定失敗だけの子の束と派生ファイルを作り、元の取引No／伝票番号・source・対応表の版を保つ。成功・不明・確認待ちが混ざれば409。
- Produces（設定route）: `GET/PUT settings`、`GET/PUT mappings`（Task2の権限）、`GET/POST tax`（一覧はfinance.read、確認と1億円を超える行の分け方の決定〔body `operation:'confirm'|'decide_cap'`、後者はS54の `admin_decide_accounting_copy_cap`〕はentries.correct）、`GET/POST supervision`（読取はexport.read、記録はsettings.manage。body `{targetId,input:CopySupervisionInput,requestKey}`）。書込bodyは各DB入口のinput・expectedVersion・requestKeyに対応し、actorはbodyから受けない。previewとfileと履歴と確認はexport.read。IP/actorそれぞれ600秒で20回（作成・確認・retry）、読取60回。共通429の本文とRetry-Afterを保つ。
- Produces（再取得と全件）: 作成・file取得・retry子は `getCopyBatch` のsourceIdで `readFixedCopySource` を呼び、固定元と固定番号で再生成する。file取得は記録したsha256と同じ時だけ返す。変換失敗・DB失敗時は部分バイトを返さない。`scope='all'` は成功済みを含むこと、MFは二重になることをpreviewに出しreexport確認を求める。reservedを含む未確定はallでも新しい束を拒否。同じ束の再取得は許すが「再取込しない」を表示する。history_onlyの確認は履歴だけ、claim_ownerだけ通常の状態遷移を適用する。外でCSVを再取込する行為をアプリだけで阻止できるとは報告しない。
- Produces（復旧route/store）: `POST batches/[id]/recover` body `{action:'rebuild'|'withdraw',reason,expectedVersion,requestKey}` をS55の `admin_recover_accounting_copy_batch` へ渡す。`recoverCopyBatch(client,actorId,batchId,input)` をstoreへ足す。export.read＋CSRF＋600秒20回、actorは認可から取る。rebuildは戻されたsourceIdで固定元を読み同じ束を再生成・record、withdrawはバイトを返さず履歴とversionを返す。元の作成request_keyを失ってもget/listから復旧可能。
- Produces（監査）: `admin.accounting.copy.prepare`・`.export`・`.confirm`・`.retry`、metadataはtarget_id・batch_id・result_code・entry_countのみ。外部の締めにより拒否された入力は安全な `remote_period_closed` コードと対象年度だけを保存し、失敗として10-jの案内へ戻す。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-630-AC-01: 認可とCSRFとIPとactorの制限を通った後だけDBを呼び、全応答はno-store`、`FREQ-630-AC-02: 生成とaccounting_exportsへの記録が成功するまでファイルを返さず、記録失敗後の同じrequest_keyは二重の束を作らない`、`FREQ-630-AC-03: ダウンロードの切断後も確認待ちが残り、新規出力で同じ仕訳を取らない`、`FREQ-630-AC-04: 10本中7本の成功と3本の失敗を受け、再出力は失敗3本だけで番号は元と同じ`、`FREQ-630-AC-05: 別の束の仕訳や二重の結果や成功から失敗への差戻しは拒否する`、`FREQ-630-AC-06: Content-Typeはバイトのutf-8またはshift_jisと合い、nosniffと共通sanitizeしたfilenameが付く`、`FREQ-630-AC-07: 取込結果を確認していないダウンロードだけではsucceededにならない`、`FREQ-630-AC-08: rawエラーと鍵とお客様の情報を応答・監査へ出さず、未知の失敗は共通500`。
- [ ] **Step 1の追加ケース:** AC-04は分類改版・古い日付の追加後もfile取得とretry子が固定元の番号・税区分を保つことを含む。各束の再取得sha256はその束の初回と同じで、失敗分だけの子のsha256を親の全件の値と比較しない。子のentryIdsだけを選び成功分は含めない。AC-02はpreparedでprocess停止後に同じバイトへ再作成／取下げでき、取下げ後は別の方法で写せることを含む。AC-05はallのhistory_onlyを失敗確認しても成功claimと最初の成功件数が不変。AC-06はwithBomがencoder.nameを保持し、BOMありでもContent-Typeがutf-8/shift_jisのままであることを含む。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting/copy/copy-store.test.ts tests/unit/lib/accounting/copy/csv-service.test.ts tests/unit/api/admin/accounting-copy-csv-route.test.ts --runInBand`。route試験は既存のResponse polyfillの制約を読み、静的 `Response.json` 不足を業務のREDと混ぜない。
- [ ] **Step 3: storeとrouteを実装する。** Nextのparamsは `Promise<{id:string}>` をawait。server-onlyを守り、ファイル取得にStorageの署名URLを使わない。入力の成功／失敗のコードは許可した固定語だけ、自由な外部エラーを受け取らない。
- [ ] **Step 4: GREEN を測る。** 上の単体、型・lint、計画6のresponse・exportの回帰。controllerはservice_role／anon／authenticatedのPostgRESTと、権限を落としたrouteの実HTTPを確かめる。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): CSVの書き出しと取込結果の確認をつなぐ`

### Task 7: CSVの月・勘定・年度末の試算表と件数の照合

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-631）、`tests/integration/db/accounting_p7_migration_asserts.integration.test.ts`
- Create: `supabase/migrations/<ts56>_accounting_p7_copy_reconciliation.sql`、`src/lib/accounting/copy/reconciliation.ts`、`reconciliation-store.ts`、`src/app/api/admin/accounting/copies/reconciliations/route.ts`、`tests/unit/lib/accounting/copy/reconciliation.test.ts`、`tests/unit/api/admin/accounting-copy-reconciliation-route.test.ts`、`tests/integration/db/accounting_p7_copy_reconciliation.integration.test.ts`
- Read: 計画1の `splitPeriodByMonth(startsOn:string,endsOn:string):PeriodMonthSlice[]` と期首、計画6の版の試算表。相手の帳簿を変更する処理は持たない

**Interfaces:**
- Consumes: `CopyReconciliation`・`CopyAccountComparison`・`CopyDifference`・`PeriodMonthSlice`・`CopySourceRef`、`public.get_closing_version_trial_balance(_version_id uuid)`（計画6の同じ戻り型）、開いた期間の計画1の試算表の読み口。月の切り方は11-e2の `splitPeriodByMonth(period.startsOn,period.endsOn)` を使い、個人の年末・法人の最初と最後の短い月を期間端で切る。
- Produces（S56）: `accounting_copy_reconciliations(id uuid PK,target_id uuid FK,source_id uuid FK,starts_on date,ends_on date,method text CHECK IN ('csv','api'),status text CHECK IN ('matched','mismatch','incomplete'),local_totals jsonb,remote_totals jsonb,entry_counts jsonb,differences jsonb,rounding_only boolean,fingerprint text,remote_checked_on date,created_by uuid,created_at timestamptz,request_key uuid UNIQUE,request_hash text)`、`accounting_copy_reconciliation_events(id bigserial PK,reconciliation_id uuid FK,event text CHECK IN ('checked','invalidated'),reason_code text,created_by uuid,created_at timestamptz)`。どちらも追記専用。税・勘定の対応が多対1なら相手の勘定単位に店の額をまとめ、対応する店の勘定の内訳を保持して見せる。件数は行数でなく仕訳1本の数。
- Produces（純粋関数）: `compareCopyTrialBalance(input:{local:readonly CopyAccountComparison[];remote:readonly RemoteAccountTotal[];localEntryCount:number;remoteEntryCount:number|null;roundingEvidence:readonly RoundingDifference[]}):{status:CopyReconciliation['status'];accounts:readonly CopyAccountComparison[];differences:readonly CopyDifference[];roundingOnly:boolean}`。`RemoteAccountTotal={remoteAccountKey:string;debit:number;credit:number;closing:number;opening:number}`、`RoundingDifference={entryNo:string;accountCode:string;localTax:number;remoteTax:number;expectedRemoteTax:number}`。単に差が1円だから端数と判断せず、同じ方式・税区分・端数設定からその差が再現する時だけroundingに分ける。**端数差があってもmatchedにはしない。** 設定をそろえ再確認する。
- Produces（入口）: `admin_record_accounting_copy_reconciliation(_actor_id uuid,_target_id uuid,_source_id uuid,_slice jsonb,_remote jsonb,_expected_fingerprint text,_request_key uuid) RETURNS jsonb`（export.read）、`public.list_accounting_copy_reconciliations(_target_id uuid,_period_id uuid,_limit integer DEFAULT 50) RETURNS jsonb`（STABLE）。CSVの_remoteはオーナーが相手の試算表から入れる `{accounts:RemoteAccountTotal[],entryCount:number,checkedOn:string}`。空・欠け・別年度・未対応勘定・件数不明はincompleteであり、0と見なさない。Task15は同じ表へmethod=apiの結果を記録する。
- Produces（route）: `GET reconciliations?targetId=&periodId=`、`POST reconciliations` body `{targetId,sourceId,slice,remote,expectedFingerprint,requestKey}` → `{data:CopyReconciliation}`。postはexport.read＋CSRF＋600秒20回。成功／失敗ともno-store。比較する店の額はDBから出し、bodyのlocal_totalsを信用しない。
- Produces（範囲）: 月ごとに借方計・貸方計・期首・期末残高・件数、年度末は12か月ではなく当該期間の全sliceと期間合計を表示する。選択した一部のCSV束だけを年度全体の残高と比べない。期首がまだ相手に入っていない場合は `opening` 差として止め、写しが勝手に期首仕訳を作らない。相手の開始残高の設定はオーナーが確認する。訂正・税分類・対応表の改版でfingerprintが変われば前の一致は履歴だけになり再照合が必要。
- Produces: S56 DETAIL `acc_s56_tables`・`acc_s56_immutable`・`acc_s56_rls_acl`・`acc_s56_function_attrs`・`acc_s56_reads_stable`・`acc_s56_existing_dml_allowlist`。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-631-AC-01: 個人の月と法人の短い最初・最後の月を11-e2で切り、月・勘定・仕訳件数を並べる`、`FREQ-631-AC-02: 期首未設定と勘定欠落と件数不明を0にせずincompleteにする`、`FREQ-631-AC-03: 複合仕訳3行は1件と数え、未転記の束だけを年度の全額と比べない`、`FREQ-631-AC-04: 端数設定から再現する1円差はroundingに分けるがmatchedにしない`、`FREQ-631-AC-05: 合計が同じでも勘定と月の入れ替わりと件数差を出し、0-3の不一致として表示する`、`FREQ-631-AC-06: 締めた版の試算表と期首の版を使い、分類改版後の古い一致を現行として返さない`、`FREQ-631-AC-07: 相手の全勘定と店の多対1対応の内訳が出て、未対応の相手勘定を捨てない`。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting/copy/reconciliation.test.ts tests/unit/api/admin/accounting-copy-reconciliation-route.test.ts --runInBand`、controllerはDB suite。
- [ ] **Step 3: S56・比較・store・routeを実装する。** CSVでは相手から自動取得したと表示せず、「相手の試算表を見て入力した値」と日時を出す。MF確定申告を既定の使い方として案内し、freeeも同じ比較を持つ。
- [ ] **Step 4（controller）: GREEN を測る。** 単体・型・lint、共通verify。月の合計の和と年度全体の借貸・残高の式も固定ベクトルで一致すること。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 写しと店の月と年度の残高を照合する`

### Task 8: 照合した月の仮締め・理由つき変更・自動計上を待たせる

controller が別セッションへ先に知らせる（会計のcore・期間の道具・係と、旧本文を検査する試験）。Task 7のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-632）、`tests/integration/db/accounting_p1_migration_asserts.integration.test.ts`・`accounting_p2_migration_asserts.integration.test.ts`・`accounting_p3_migration_asserts.integration.test.ts`・`accounting_p5_migration_asserts.integration.test.ts`・`accounting_p6_migration_asserts.integration.test.ts`（会計の関数のP7囲みだけを意図して許す。最新の試験を検索して対象を確定し、題は変えない）、`tests/integration/db/accounting_p7_migration_asserts.integration.test.ts`
- Create: `supabase/migrations/<ts57>_accounting_p7_copy_month_holds.sql`、`src/lib/accounting/copy/month-hold-store.ts`、`src/app/api/admin/accounting/copies/months/route.ts`、`tests/integration/db/accounting_p7_month_holds.integration.test.ts`、`accounting_p7_month_holds_concurrency.integration.test.ts`、`tests/unit/api/admin/accounting-copy-months-route.test.ts`
- Read: 計画6 Task 3・8・9・15の最新定義、計画2 Task 1の計上待ちの契約。G・Hの関数や返金・返品の14本はReadだけ
- Modify: `tests/integration/db/accounting_p7_copy_order.integration.test.ts`（共通規則の月解除・訂正・固定元再読込の全順を追加）

**Interfaces:**
- Consumes: `private.accounting_lock_all(_period_id uuid DEFAULT NULL) RETURNS void`、計画6の `accounting_period_gate(_period_id uuid) RETURNS text`、`accounting.posting_run` の文脈、`accounting.correction_ctx`と`accounting.correction_periods`の扱い、Task7のmatchedな照合とfingerprint。`private.accounting_park_event(_kind text,_source_table text,_source_id text,_order_id uuid,_reason text,_detail jsonb) RETURNS void`・`private.accounting_unpark_event(_kind text,_source_table text,_source_id text,_entry_id uuid) RETURNS void` の名前・署名・既存の理由を変えない。
- Produces（S57）: `accounting_copy_month_events(id bigserial PK,period_id uuid FK,month_key text,reconciliation_id uuid NULL FK,event text CHECK IN ('held','released','changed','invalidated'),before_fingerprint text,after_fingerprint text NULL,before_totals jsonb,after_totals jsonb NULL,entry_id uuid NULL FK,reason text NULL,actor_id uuid,created_at timestamptz,request_key uuid UNIQUE,request_hash text)`。heldは一致した現行照合を必須、releasedは1〜500字の理由と確認を必須、changedはDBが計算する前後の額と新しいentry_idを必須にする。予告のreleasedに後からafterをUPDATEせず、実際の追加時に別のchanged行を足す。月の現在値は最新イベントから導く。
- Produces（入口）: `admin_hold_accounting_copy_month(_actor_id uuid,_period_id uuid,_month_key text,_reconciliation_id uuid,_expected_fingerprint text,_request_key uuid) RETURNS jsonb`、`admin_release_accounting_copy_month(_actor_id uuid,_period_id uuid,_month_key text,_reason text,_confirmed boolean,_expected_fingerprint text,_expected_pending_count integer,_expected_pending_fingerprint text,_request_key uuid) RETURNS jsonb`（close.manage）。matched以外、古いfingerprint、別期間、別の事業者の不一致が残る月はheldにできない。releaseは**年の締めを解除しない**。`public.list_accounting_copy_months(_period_id uuid) RETURNS jsonb`、`public.list_accounting_month_pending(_period_id uuid,_limit integer DEFAULT 200) RETURNS jsonb` はSTABLE。複数targetで写す月は全利用targetの現行照合の一致を要する（AIの安全側の判断）。
- Produces（解除前の計上待ちの確認）: `public.preview_accounting_copy_month_release(_period_id uuid,_month_key text) RETURNS jsonb`（STABLE、service_roleだけ、private同署名本体）で `{monthKey,fingerprint,pendingCount,pendingFingerprint,pending:[{kind,sourceTable,sourceId,entryDate,eEntryDate,nEntryDate}]}` を返す。全件をDBで数え指紋を計算し、画面には安全な種類別件数・日付の内訳と「この月で止まっている自動の出来事 N 件も入る」を表示する。入力ID一覧を信用せず、releaseが鍵の中で全件数・指紋を再計算し、確認値と違えば409で再読込・再確認する。S57のmonth_eventsへ `released_pending_count integer NULL,released_pending_refs jsonb NULL,pending_fingerprint text NULL` を足し、releasedに確認した全IDと件数・指紋を保存する。手入力1本の許可だけと誤認する確認では解除しない。解除後に新たに到着する出来事にもopen月の通常規則が適用されることを同じ画面で示す。
- Produces（内部）: `private.accounting_month_is_held(_period_id uuid,_date date) RETURNS boolean`（STABLE）、`private.accounting_record_month_change(_period_id uuid,_entry_id uuid,_before jsonb) RETURNS void`。入口なし・service_roleからもREVOKE。月の区切りは11-e2。元の仕訳の日だけでなく、新しい仕訳が実際に入る日と組のE/Nの経済日を検査する。
- Produces（既存の会計関数への最小追加）: coreは**計画6 S50までの最新定義**を写し、同じ仕訳の再送の返却を済ませて新しく作ると決まった後、採番・行INSERT前にheldなら `ACCOUNTING_MONTH_HELD` で拒否する。追加前の残高を読み、行とハッシュ記録の完了後にDBの計算したafterとともにchangedを追記する。再送でcreated=falseの時はguardによる新しい拒否やchangedを足さない。期間を引く道具は**S40以後の最新定義**を写し、posting_run中のheldなら `ACCOUNTING_PERIOD_MISSING`（DETAIL `month_hold`）にする。自動の単独取り消し・組の取り消しに届く前の止めは、計画6が作り直す会計の係4本（`accounting_post_shipment_events`・`accounting_post_refund_events`・`accounting_post_return_events`・`accounting_post_withdrawal_events`）の最新本文を写し、既存の年のgateの検査の直前に月の検査を囲みで足す。EかNのどちらかがheldなら組ごと `period_missing`、detail `{why:'month_hold',entry_date,e_entry_date,n_entry_date,record_kind,record_id}` に待たせ、他の候補へ進む。新しいPendingReasonを増やさず、既存の計上待ちの表を使う。
- Produces（変更の確認）: heldな月への手入力・訂正は初回に409でロールバックし、画面が対象月と前の照合の額を示して確認・理由を受け、release後に元の操作を新しい要求番号で再実行する。操作が失敗してもreleaseの事実は残り、再照合が必要。実際に入った各仕訳についてDBが前後の残高と人・時刻・entry_idをchangedへ足す。自動の係は自分でreleaseしない。release後も年のgateがopenでない出来事は計画6の止めに残り、openなら次の計上係の再訪で一度だけ解決する。組は計画6のsettleの既存契約を通し、別の続行ロジックを作らない。
- Produces（囲みと回帰）: 追加箇所は `-- ACC_P7_BEGIN`〜`-- ACC_P7_END`。①既存関数の最終定義の属性・引数・戻り・ACL・所有者の一致、②P7囲みを除く本文は移行前と一致、③P6以前の囲みを全部除くと各元定義と一致、を別々に検査する。P6のハッシュをつなぐ呼び出しを移動・削除しない。月の記録はハッシュの正本へ追加の上書きをしない。実装時に `rg 'accounting_reverse_journal_core\(NULL'` で会計の呼び所を取り直し、新しい呼び所があれば同じguardを計画に追記してから実装する。
- Produces（route）: `GET months?periodId=`、`GET months?periodId=&monthKey=&previewRelease=true`（解除preview）、`POST months` body `{operation:'hold'|'release',periodId,monthKey,reconciliationId?,expectedFingerprint,expectedPendingCount?,expectedPendingFingerprint?,confirmed?,reason?,requestKey}` → `{data:{monthKey,state:'held'|'open',needsReconciliation:boolean}}`。holdは確認済み一致、releaseはconfirmed=trueと計上待ち件数・指紋を必須にする。
- Produces: S57 DETAIL `acc_s57_tables`・`acc_s57_base_bodies`・`acc_s57_wrapped_bodies`・`acc_s57_month_guards`・`acc_s57_immutable`・`acc_s57_rls_acl`・`acc_s57_function_attrs`・`acc_s57_existing_dml_allowlist`。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-632-AC-01: 一致した月だけ仮締めでき、古い照合と別期間と不一致ではできない`、`FREQ-632-AC-02: 仮締めの月への手入力は拒否して仕訳も番号も増えず、確認と理由の後だけ追加でき人・日時・変更前後が残る`、`FREQ-632-AC-03: 自動の出荷と単独取消しとE/Nの組のどちらの月がheldでも組ごと確認待ちに止まり、係は次の候補へ進む`、`FREQ-632-AC-04: release後は照合の一致の印が外れ、次の再訪で1本だけ入り、年がclosedなら年の止めは外れない`、`FREQ-632-AC-05: 仮締め対新しい仕訳の並行は先に入れば一致が古くなりheldを拒否、先にheldなら仕訳を待たせ、両方通ることが無い`、`FREQ-632-AC-06: P7囲み以外とG/Hと返金返品14本の本文は不変で、hash chainの検証はok`、`FREQ-632-AC-07: 税分類と対応表の変更後は再照合が必要で、元の仮締めの事実は消えない`、`FREQ-632-AC-08: 同じ要求とcreated=falseの再送は変更の履歴を二重に足さない`。
- [ ] **Step 1の追加ケース（AC-02・04・08）:** 待ちの自動出来事がある解除を件数・指紋の確認なしで行うと拒否。preview後に1件増えると拒否して読み直し、確認後だけ解除して保存ID集合が一致する。次の係の再訪で各対象が1回だけ入り、年closedは残る。共通order suiteの対象の全順列をそれぞれROLLBACK内で検証し、解除の履歴・成功claim・固定元が順によって破壊されないことを確かめる。
- [ ] **Step 2（controller）: RED を測る。** DB2suiteとroute単体。P1・P2・P3・P5・P6の本文試験は先に取り直し、意図して変える期待値を `changed-tests.md` の対象にする。
- [ ] **Step 3: 最新の定義を取得してS57を実装する。** 実装予定のP1〜P6のファイルがまだ無ければ先行計画が終わるまで始めない。今のDBに無い関数を手で再構築しない。新しい税の分類や対応表による一致の無効化は追記イベントで、過去のmatchedを書き換えない。
- [ ] **Step 4（controller）: GREEN を測る。** 共通verify・並行3連続・計画1〜6の月に関わらない試験の回帰。取り消しの日・組のE/Nの両月・法人調整の経済日を変えた固定ベクトルを通す。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): 照合した月の仮締めと理由つき変更を守る`

### Task 9: CSV・設定・税の確認・照合・仮締めの画面

controller が別セッションへ先に知らせる（`CostProfitSection.tsx` のサブタブ）。Task 8のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-633）、`src/components/CostProfitSection.tsx`（計画1で分割した後の最新のサブタブの定義と呼び出しだけ）
- Create: `src/components/cost-profit/AccountingCopyView.tsx`、`copy/CopyCsvPanel.tsx`、`CopyMappingPanel.tsx`、`CopyTaxPanel.tsx`、`CopyReconciliationPanel.tsx`、`CopyMonthPanel.tsx`、`CopyBatchPanel.tsx`、`src/lib/accounting/copy/copy-client.ts`、`tests/unit/components/cost-profit/accounting-copy-view.test.tsx`
- Read: 計画1の期間の選択、計画6の `ExportsSearchView.tsx` とUIの部品。既存の帳簿の書き出しをこのタブへ移さない

**Interfaces:**
- Consumes: Task6〜8のroute、`AccountingPeriod`、`CopySelection`・`CopyReconciliation`。期間の選択は親のものを使い、独自の暦年pickerを増やさない。
- Produces: `AccountingCopyView({period,permissions}:{period:AccountingPeriod;permissions:readonly string[]}):React.JSX.Element`。サブタブ名「freee・MFへの写し」。既定の相手はMF（設計15-j）。選択「まだ写していない分」「全部」、相手の年度・元が「開いている期間の今の仕訳」か「締めた版N」か、期間と件数と文字コードをプレビューに出す。
- Produces（文と操作）: 「CSVを作る」「取り込めた」「失敗」「失敗した仕訳だけを出し直す」。状態は「写していない」「書き出した（取り込みの確認待ち）」「写した」「失敗」「送信の結果を確認中」。確認待ちは「相手のソフトの取込結果を先に確かめてください」。全部は「MFでは二重に登録されます。取り込み済みを含めて出力します」の明示確認。取得しただけでは成功表示にしない。
- Produces（復旧と分類差の表示）: 作成中のまま残る束には「同じ元から作り直す」「取り下げる」を表示し、権限・版・理由を検査してTask 6のrecoverへつなぐ。確認待ちには取下げを出さない。税の問題一覧は止める物（未確認の行、1億円を超える行とその後の行、元の行の分からない返品）と、案内だけの「固定後に分類を改めた行」「先に写した行より日付の早い仕入れが止まっている取引先×課税期間」を分けて出す。1億円を超える行には「1億円の上限を超えます。分け方を税理士に確かめてください」と、経過措置の使用額・見込みの累計・日付の順に厳密に数えた分け方の参考を出し、entries.correctの人だけに分け方を決める操作（理由と根拠つき）を出す。元の行の分からない返品には元の仕入れを選ぶ操作を出す。既転記分を上書きせず、直す時だけ取消し仕訳と正しい仕訳の操作へ案内する。照合の画面は差があればmatchedにせず、仮締めへ進ませない。allのhistory_onlyの再確認は既存の成功件数を増減させない。
- Produces: 未対応の勘定符号・税・invoice、未確認の税、表せない字は権限のある画面にだけ表示し、金額の明細やお客様の情報をトースト・consoleへ出さない。対応表を作る権限が無い場合は設定担当へ案内。年度の案内はTask5の同じ `copyPeriodGuide`。税務署向けには元の字の書き出しへリンクを出す。
- Produces（監督の確認）: CopyMappingPanelの設定に現行規約の版・国・目的と安全対策・未解決事項と確認日を表示し、settings.manageの人が根拠を見てTask2の監督の記録を入れる。readyでなければCSVの作成を止め、必要な確認先を示す。法律の判断をチェックボックスだけで自動確定しない。試験の架空のtargetにも根拠つきのfixtureを用意する。
- Produces（照合と仮締め）: 月・勘定ごとの借貸・期首・期末と仕訳件数を並べ、相手で確認した日付を表示。不一致は赤い固定の注意、端数差は別欄。一致だけが仮締めへ進める。変更は確認・理由を必須にし、年の解除とは別の操作として出す。0件は「写す仕訳はありません」。apiEnabledの設定・鍵入力・API送信ボタンはTask16まで出さない。
- Produces（解除の画面とRTL）: Task 8のpreviewから自動の計上待ちN件と安全な内訳を確認画面に出し、理由と集合の確認後だけexpectedPendingCount/Fingerprintを送る。FREQ-633-AC-08に件数確認なしの拒否、件数変更時の再確認と成功後の履歴を加える。AC-03に停止したreservedの再作成／取下げ、AC-06に分類差の案内と、1億円を超える行の止めの表示・分け方を決める操作（権限・理由・根拠が無いと送れない）・元の仕入れを選ぶ操作を加える。

- [ ] **Step 1: 失敗するRTLを書く。** `FREQ-633-AC-01: 元の期間と版・相手の年度・文字コード・件数を示し、0件なら空のファイルを勝手に作らない`、`FREQ-633-AC-02: export権限が無いと出力と確認ができず、settings権限が無いと対応表を直せない`、`FREQ-633-AC-03: ダウンロード後は確認待ちのままで、部分成功の選択と失敗だけの再出力ができる`、`FREQ-633-AC-04: 全部は二重の注意と確認を要し、確認待ちの束の結果を先に促す`、`FREQ-633-AC-05: 個人の過年度と法人の見つけた年で締めの案内が違う`、`FREQ-633-AC-06: 対応不足・未確認税・不可能字を表示し、失敗応答のbodyを消費する`、`FREQ-633-AC-07: 月と年度の比較、端数差、不一致と再照合の状態を表示し、一致だけ仮締めできる`、`FREQ-633-AC-08: 仮締めの変更は確認と理由が無ければ実行できず、旧版と変更前後の履歴が残る`。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/components/cost-profit/accounting-copy-view.test.tsx --runInBand`。
- [ ] **Step 3: Interfacesどおり実装する。** 既存のbutton・form・dialogを使い、名前のある見出し・ラベル・エラー関連付け・キーボード移動を持つ。画面にDBの関数名や鍵の保管の実装は出さない。
- [ ] **Step 4: GREEN を測る。** 上のRTL、既存CostProfitSectionの回帰、型・lint。待ち中の二重クリックと、失敗後に再度操作できることも確かめる。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): CSVの写しと照合の管理画面を足す`

### Task 10: CSVのE2EとCSV側の完了の確認

controller が別セッションへ先に知らせる（会計E2E helper）。**このTaskの完了までAPIのTaskを始めない。**

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-625〜633の受入条件）、`e2e/admin-accounting-test-utils.ts`（写しの設定・分類・束・照合のfixtureを追加）、`scripts/e2e/environment.ts`（手元のE2Eにだけ `E2E_ACCOUNTING_COPY_PROFILE=fixture`、`.env*` は編集しない）
- Create: `src/lib/accounting/copy/csv/e2e-profile.ts`（server-only。flagだけで許可せず手元環境とlocalhostのDB・アプリのURLを既存guardで検査し、本番ではfixture_onlyを拒否するbootstrap）
- Create: `e2e/FR-ADMIN-157-copy-csv-import-confirm.spec.ts`、`FR-ADMIN-158-copy-mapping-tax-encoding.spec.ts`、`FR-ADMIN-159-copy-reconcile-month-hold.spec.ts`、`FR-ADMIN-160-copy-version-corrections.spec.ts`
- Test: 上の4本と計画1〜6の会計E2E回帰。freee・MFへの通信は0件

**Interfaces:**
- Consumes: Task1〜9の画面・route・DB、`createAdminSessionActor`・既存fixtureのlocalhost制限。downloadのバイトを解析する試験は文字コードに合うdecoderを使う。
- Produces（試験用profileの配線）: Task 1のfixture_only registryをサーバーの依存から渡し、管理routeの入力では選択できなくする。架空のsupervision記録も手元fixtureに限る。FREQ-625-AC-05に本番起動・外部DB・flagだけでのfixture版利用の拒否を加え、FREQ-630-AC-02/04にCSV停止復旧と固定元の全頁読込、FREQ-632-AC-04に待ちN件の確認を加える。このE2E成功で本番用profileや実取込を確認済みにしない。
- Produces: `FREQ-630-AC-04: 3仕訳のうち2成功1失敗を確認して失敗だけ同じ番号で出し直す`、`FREQ-633-AC-04: 確認待ちと全部の再出力の注意が画面とAPIの両方にある`（157）。`FREQ-626-AC-01: 新しい勘定の対応不足で止まり、対応後だけCSVが出る`、`FREQ-627-AC-02: 境の日の税区分とMF免税欄と登録日が合う`、`FREQ-630-AC-06: Shift-JISのdownloadは正しいcharsetで、表せない字は止まる`（158）。`FREQ-631-AC-05: 残高や件数の差が見え、一致を記録して月を仮締めし、後の自動計上は確認待ち`（159）。`FREQ-628-AC-02: 締めた版1と個人の訂正の版の出力の差が新しい仕訳として見え、元の版は変わらない`、`FREQ-629-AC-09: 法人の前期損益修正は見つけた年の出力である`（160）。

- [ ] **Step 1: 受入条件と失敗するE2Eを書く。** 各ファイルは390・768・1280px。fixtureはテスト用の個人・法人・複合仕訳・古い日付の訂正・未確認税を使い、本番の行をコピーしない。
- [ ] **Step 2（controller）: RED を測る。** 実装前の該当画面／routeに対して対象4本が機能不足で落ちる証拠を残す。既に実装後ならTaskの途中で測ったREDを参照し、あらためて本番DBで失敗を作らない。
- [ ] **Step 3（controller）: 本番buildでGREEN。** `npx.cmd playwright test e2e/FR-ADMIN-157-copy-csv-import-confirm.spec.ts e2e/FR-ADMIN-158-copy-mapping-tax-encoding.spec.ts e2e/FR-ADMIN-159-copy-reconcile-month-hold.spec.ts e2e/FR-ADMIN-160-copy-version-corrections.spec.ts`。production build・port3000・手元DBはGlobal Constraintsに従う。未登録番号への採番修正は作業台帳に記録する。
- [ ] **Step 4（controller）: CSV側のgateを確認する。** Task1〜9の単体・型・lint・DB・PostgREST・並行・4本の全幅と回帰を確認し、新しい失敗が0件ならTask11へ進む。公式で未確認のprofileがある時はその出力を無効にしたまま残し、実接続の確認前に使えるとは報告しない。
- [ ] **Step 5（controller）: Files だけコミットする。** `test(accounting): CSVの写しと部分失敗と月の仮締めを確かめる`

### Task 11: APIの契約・暗号・接続とOAuth・鍵の期限

Task 10のCSV側のgateを通ってから始める。**このTaskの試験は本物へ接続しない。**

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-634）、`tests/integration/db/accounting_p7_migration_asserts.integration.test.ts`
- Create: `supabase/migrations/<ts58>_accounting_p7_copy_connections.sql`、`src/lib/accounting/copy/api/api-types.ts`、`http-client.ts`、`secret-crypto.ts`、`connection-store.ts`、`oauth-service.ts`、`expiry.ts`、`tests/fixtures/accounting-copy/freee-api-contract.json`、`mf-api-contract.json`、`tests/unit/lib/accounting/copy/api/secret-crypto.test.ts`、`oauth-service.test.ts`、`http-client.test.ts`、`expiry.test.ts`、`tests/integration/db/accounting_p7_copy_connections.integration.test.ts`
- Read: [秘密情報の正本](../../06_Operations/secrets.md)、既存のMetaの暗号（値・設定は読まない）、上の公式API仕様・MFアプリポータル、Nextのローカルdata-security guide

**Interfaces:**
- Consumes: `CopyProvider`・`CopySourceRef`・`CopySettings`・`CopyLineTax`・`CopyMapping`、S55の同じ仕訳の占有。CSVの `CopySafeOptions` をAPIのJSONへ適用しない（摘要を安全な固定文にする関数は共通で使う）。
- Produces（内部のAPI型）: `CopyApiEntry={entry:SavedJournalEntry;taxes:readonly CopyLineTax[];lineFacts:readonly FixedCopyLineFact[];source:CopySourceRef;settings:CopySettings;mappings:readonly CopyMapping[];voucherNo:string;ordinal:number}`、`CopyRemoteEntry={remoteId:string;remoteKind:'deal'|'manual_journal'|'journal';storeEntryNo:string|null;date:string;adjustment:boolean;lines:readonly CopyRemoteLine[]}`、`CopyRemoteLine={side:'debit'|'credit';accountKey:string;subAccountKey:string|null;amount:number;taxKey:string|null;invoiceKey:string|null;taxAmount:number|null}`。固定元から当該entryの全lines/taxes/lineFactsを渡し、派生行は固定segmentsを使う。店の番号はperiod+targetを組にして解釈し、entryNoだけで年度をまたいで結ばない。
- Produces: `CopySendResult={kind:'succeeded';remoteId:string;remoteKind:CopyRemoteEntry['remoteKind'];remoteNumber:string|null}|{kind:'rejected';code:'validation'|'remote_period_closed'|'mapping'|'permission'|'reconnect'|'rate_limited';retryAfterMs:number|null}|{kind:'unknown';code:'timeout'|'network'|'invalid_response'|'server_error'}`。`CopyRemotePage={entries:readonly CopyRemoteEntry[];nextCursor:string|null;complete:boolean}`、`CopyTrialResult={accounts:readonly RemoteAccountTotal[];complete:boolean;asOf:string}`。外部生エラー・Authorizationは型に含めない。
- Produces（adapter）: `CopyApiSendContext={jobId:string;idempotencyKey:string}`、`AccountingCopyAdapter={provider:CopyProvider;create(entry:CopyApiEntry,context:CopyApiSendContext):Promise<CopySendResult>;find(input:{targetId:string;periodId:string;date:string;storeEntryNo:string;cursor:string|null}):Promise<CopyRemotePage>;list(input:{targetId:string;periodId:string;from:string;to:string;cursor:string|null}):Promise<CopyRemotePage>;trialBalance(input:{targetId:string;periodId:string;slice:PeriodMonthSlice}):Promise<CopyTrialResult>}`。`createFreeeAdapter(deps:CopyApiDeps):AccountingCopyAdapter` は12、`createMfAdapter(deps:CopyApiDeps):AccountingCopyAdapter` は13。PUT/DELETEメソッドは型に設けない。
- Produces（HTTP）: `CopyHttp={request(input:{method:'GET'|'POST';url:URL;headers:Readonly<Record<string,string>>;body?:string;timeoutMs:number}):Promise<{status:number;headers:Readonly<Record<string,string>>;body:unknown}>}`、`CopyApiDeps={http:CopyHttp;secrets:CopySecretAccess;clock:()=>number;rateGate:CopyRateGate;contracts:CopyApiContracts}`。`CopySecretAccess.withAccess<T>(targetId:string,run:(access:{authHeaders:Readonly<Record<string,string>>;officeRef:string;credentialRef:string;bindingVersion:string;credentialVersion:string})=>Promise<T>):Promise<T>`、`CopyRateGate.reserve(targetId:string,credentialRef:string):Promise<{allowed:boolean;retryAt:number|null}>`。authHeadersは確認済みの認証方式から秘密専用層が作りコールバック内だけで使う。全方式でbearerが得られるとは仮定せず、値を戻り・ログへ入れない。URLは公式hostと許可パスだけ、任意URL・redirectを追わない。
- Produces（検査の型）: `CopyApiContracts={revision:string;operations:Readonly<Record<string,{method:'GET'|'POST';path:string;scopes:readonly string[]}>>;validateRequest:(operation:string,body:unknown)=>void;parseResponse:(operation:string,body:unknown)=>unknown}`。validatorは公式抜粋に対応するZodで固定コードだけをthrowする。`createCopyHttp(input:{transport:typeof fetch}):CopyHttp` を実体のfactoryにし、bootstrapだけが本物のfetchを渡す。単体は必ず差し替えたtransportを渡す。
- Produces（原文から得る能力の記録）: CopyApiContractsにoperationごとの `maxRows:number|null` と認証方式・キー交換の要否・許可事業者一覧操作の有無・冪等鍵の位置と名前／保証範囲／有効期間・evidenceRefを追加する。未確認はnullとし、ヘッダー名や交換endpointを推定しない。freeeのdealsとmanual_journalsのdetails上限はそれぞれ公式schemaから取得し、上限NとN+1をfixtureへ入れる。資料に無い値はTask 18の試しの事業者で条件を記録して確かめ、未確認の操作を有効化しない。冪等鍵が同じjobの再要求を1本へ結ぶ保証はDBのUNIQUEとは別に確認する。Step 0の関門で手段1（冪等の鍵）か手段2（店の番号での不在確認）が決まっていない作成操作は本番送信を無効とし、CSVと確認済みの読取を使えるようにする。手段2の相手は冪等の鍵の保証が無くても、店の番号で読む操作が確認済みなら送れる。
- Produces（公式契約fixture）: Task中に公開schemaから使うrequest/responseだけを取得日・schemaのcommit/sha256・必要なscopeとともに抜き出す。freeeは `/api/1/manual_journals`・`/api/1/deals`・そのGET、勘定と税のカタログ、BS/PLのレポート。MFは `/api/v3/journals`・GET一覧/ID、勘定と税、事業者、`/api/v3/reports/trial_balance_bs` と同原文のPLの読み口。freeeのref_numberとCSV伝票番号の対応、取得側の頁・非同期帳簿出力・税額欄、MFのscope・認証方式（交換の要否を含む）・PLのパス・invoice列の値・日付範囲と件数上限は原文から取ってfixtureに入れる。この計画に未確認の値は書かない。仕様を取得できない操作は未確認で停止する試験を持ち、成功を偽るadapterを置かない。
- Produces（未確認の作成入力を確定する手順）: freeeのdealsとmanual_journalsの**POST入力を別々に**原文schemaから抜き出し、ref_numberの有無・型・長さ・意味・GETの返却とCSV伝票番号との関係をoperation単位で記録する。GETにあることや検索断片からPOST可／20字を推定しない。無い操作へそのfieldを送らない。作成成功は確認済み契約の相手IDで保存し、txn_numberの補充GETの可否も操作別に原文で確定する。店番号との安全な対応や受理不明の回復が未確定な操作は有効化せず、送信後の不明結果を推測で成功／不在へ落とさない。
- Produces（S58）: `accounting_copy_connections(target_id uuid PK FK,auth_kind text CHECK IN ('freee_oauth','mf_oauth','mf_api_key'),enabled boolean NOT NULL DEFAULT false,binding_version bigint,credential_version bigint,access_expires_at timestamptz NULL,refresh_expires_at timestamptz NULL,refresh_expiry_known boolean,refresh_lease_token uuid NULL,refresh_lease_until timestamptz NULL,dedupe_method text NULL CHECK IN ('idempotency_key','lookup_by_store_no'),dedupe_evidence_ref text NULL,dedupe_checked_on date NULL,dedupe_contract_revision text NULL,version bigint,status text CHECK IN ('disconnected','ready','reconnect_required','refresh_unknown'))`。`dedupe_*` はStep 0の関門の結果（相手×作成操作の手段・証拠の参照・確認日・CopyApiContractsの版）で、4列とも入るか全部NULL。その相手で使う全ての作成操作に手段がある時だけ入れ、操作ごとの手段はCopyApiContractsに持つ（手段1と手段2が操作で違えば `dedupe_method` は手段2を記録し、workerは操作ごとの契約に従う）。controllerが関門を確かめた後にsettings.manageの設定操作で記録し、移行では入れない。鍵は別の `accounting_copy_credentials(target_id uuid FK,version bigint,credential_ref uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),key_version text,encrypted_access text NULL,encrypted_refresh text NULL,encrypted_api_key text NULL,created_at timestamptz,PRIMARY KEY(target_id,version))` に暗号文だけを置き、PUBLIC/anon/authenticated/**service_roleのSELECTもREVOKE**。期限・接続状態だけを返す読み口と秘密を読むsystem入口を分離する。binding_versionはオーナーの認可・鍵・接続先の変更で進め、同じ認可のOAuth refreshはcredential_versionだけを進める。正当なrefreshで準備済みjobを全て無効にしない。
- Produces: `accounting_copy_oauth_states(id uuid PK,state_hash text UNIQUE,target_id uuid FK,actor_id uuid,session_hash text,expires_at timestamptz,consumed_at timestamptz NULL,encrypted_verifier text NULL)`。nonceはランダム・有効10分・1回のみ・actor/sessionに結ぶ。PKCEの対応は両社の原文で確かめて使う。raw state・認可code・verifierをDBの監査やURLアクセスログに残さない。callbackはGETだが状態変更の通常CSRF tokenの代わりに、認可開始のPOSTのCSRF＋session＋1回限りstateを検査する例外を明記する。
- Produces（暗号）: `encryptCopySecret(value:string,key:Buffer,aad:{targetId:string;kind:'access'|'refresh'|'api_key';version:string}):string`、`decryptCopySecret(payload:string,key:Buffer,aad):string`。AES-256-GCM・12byte random IV・認証tag、AADでtarget・用途・版を結び、取り違え・改ざんは固定エラー。masterはサーバー専用 `ACCOUNTING_COPY_ENCRYPTION_KEY`、OAuthアプリのclient secretはサーバーの安全なstoreでオーナーが準備する。値・例の文字列は計画にも試験にも書かず、試験は `randomBytes` で毎回生成する。暗号文やfixtureの丸ごとのsnapshotを取らない。
- Produces（入口）: `admin_configure_accounting_copy_connection(_actor_id uuid,_target_id uuid,_input jsonb,_expected_version bigint,_request_key uuid) RETURNS jsonb`（settings.manage。暗号化はサーバーで済ませ、DBに平文を渡さない）、`admin_set_accounting_copy_api_enabled(_actor_id uuid,_target_id uuid,_enabled boolean,_expected_version bigint,_request_key uuid) RETURNS jsonb`（settings.manage）、`public.get_accounting_copy_connection_status(_target_id uuid) RETURNS jsonb`（STABLE、期限・鍵あり/なしだけ）。system用 `claim_accounting_copy_refresh(_target_id uuid,_expected_version bigint,_lease_seconds integer) RETURNS jsonb`、`finish_accounting_copy_refresh(_target_id uuid,_lease_token uuid,_encrypted jsonb,_expiries jsonb) RETURNS jsonb` と秘密専用の `read_accounting_copy_credentials(_target_id uuid) RETURNS jsonb` はservice_roleだけ・一般のstoreから参照しない。HTTPの間はDBのlockを持たない。
- Produces（期限）: freeeは発行時からaccess6時間、refresh90日、応答にexpires_inがあればその値を検査して使用する。access残り5分で更新、refresh残り7日でつなぎ直しを画面に知らせる（通知の閾値はAIの判断）。refreshはleaseで1つにし、新しいaccess/refreshを同じDB操作で保存して版を進める。応答不明なら古いrefreshを再利用せず `refresh_unknown`→再接続。MFの期限は公式の応答／アプリポータルで得る。無ければ `refreshExpiryKnown:false`・「期限を確認できません」と表示し、無期限と推定しない。
- Produces（有効化の条件）: **S53で作った** `accounting_copy_supervision_checks` と `private.accounting_copy_supervision_ready(_target_id uuid) RETURNS boolean` を使う。作り直さない。オンは接続ready、設定と対応が確認済み、監督の記録が有効、`dedupe_*` が入っている時だけ（空なら `ACCOUNTING_COPY_DISABLED`）。DBの3つの入口（オン・Task 14のenqueue・markSending）は `dedupe_*` が空でないことを鍵の中で比べる。`dedupe_contract_revision` と今の `CopyApiContracts.revision` の一致は、DBの入口の引数に版が無いのでTSが比べる: オンとenqueueのrouteはDBを呼ぶ前、workerはmarkSendingの前に `connectionStatus` の戻りで比べ、違えば `ACCOUNTING_COPY_DISABLED` で止めてPOSTしない。キーの更新・target変更・規約の版の変更で古い承認を流用しない。オフは待ちjobの新規送信と外部の定期読取を止め、占有と履歴は消さない。
- Produces（MFキーの許可事業者と代替確認）: ポータルでこの店の1事業者だけを許可する。キーで見える許可事業者一覧APIとキーをBearer等へ換える手順は未確認#3。Task 11で公式文書の操作を取得し、原文に無ければTask 18で試しの事業者で確認する。公式の一覧操作が確認できた場合だけ全頁で `{target.remote_office_ref}` との一致を検査する。一覧APIを確認できない時は、オーナーがMFの画面で許可事業者をこの店の1つに設定し、秘密・個人情報を隠した画面の写しと確認日・確認者・対象事業者・credential/binding版を安全な記録へ残す方法へ替える。S58のconnectionに `office_scope_checked_at timestamptz NULL,office_scope_fingerprint text NULL,office_scope_evidence_kind text NULL CHECK IN ('api','owner_screen'),office_scope_evidence_ref text NULL` を持ち、証拠をcredential/binding版に結ぶ。画面原本や鍵をDB・ログ・fixtureへ入れず参照だけ保存する。複数許可・証拠なし・版違いはready/オン不可。キー更新後は再確認。認証方式自体を確認できなければMF APIキー方式は無効のまま、確認済みOAuth方式だけを使う。
- Produces: S58 DETAIL `acc_s58_tables`・`acc_s58_secret_acl`・`acc_s58_oauth_state`・`acc_s58_function_attrs`・`acc_s58_enabled_default_off`・`acc_s58_existing_dml_allowlist`。

- [ ] **Step 0（関門・Task 12以後の前）: 二重を防ぐ手段を相手ごとに決める。** freee・MFの作成操作それぞれについて、手段1=公式の冪等の鍵（位置・名前・保証範囲・有効期間）、手段2=冪等の鍵が無い相手は、送り直しの前に相手の仕訳を店の番号（freeeの伝票番号・MFの仕訳メモ）で読み、既にあれば送らない（読む操作で探せることを公式の文書か試しの事業者で確かめる）。結果を相手×操作ごとにCopyApiContractsへ記録し、controllerが確認するまでTask 12〜16を始めない。結果は後日S58の `dedupe_*` に記録し、オン・enqueue・markSendingの条件にする（記録が無ければ `ACCOUNTING_COPY_DISABLED`）。どちらも無い相手は、API送信をオフのままにし、CSVで写すと画面に出す（API Taskはその相手の分を作らない）。公式の文書だけで決まらない相手は、その相手のTask 12〜16を始めずCSVのままにする。オーナーの鍵（Task 18 Step 6）と試しの事業者がそろってから、読む操作（店の番号での検索）だけを先に試してStep 0を決め直し、決まった後にその相手のTask 12〜16を始める（もう一方の相手の進みは止めない）。手段2を採る相手では、⑥を「jobごとの作成POSTは、店の番号での不在確認の前は1回」と読み替えてTask 14の試験に入れる。この結末をオーナーへの報告にも書く。
- [ ] **Step 1: 失敗する試験を書く。** `FREQ-634-AC-01: 新規接続はオフで、鍵なし・監督の記録なし・別事業者・二重を防ぐ手段（手段1か手段2）が未確認ならオンにできない`、`FREQ-634-AC-02: 暗号の改ざんと別targetと別用途の復号は拒否、service_roleも表を直接読めず通常の状態の応答には鍵が無い`、`FREQ-634-AC-03: stateの期限切れ・使い回し・別session・actorとCSRF不正はtoken交換前に拒否する`、`FREQ-634-AC-04: freeeの同時refreshは1回で新しい2本を原子的に保存し、timeout後は古いrefreshを再送しない`、`FREQ-634-AC-05: 6時間と90日と通知の境界、MFの期限不明を表示し、期限切れはreconnectにする`、`FREQ-634-AC-06: 任意URLとredirectとhttpsでないMFcallbackは拒否し、HTTP・監査・例外の出力に鍵もcodeも無い`、`FREQ-634-AC-07: HTTPを渡さない試験はネットへ出られず、公式契約の欠落は成功として扱わない`。
- [ ] **Step 1の追加ケース（AC-01・07）:** `dedupe_*` が空・一部だけの接続はDBがオンを `ACCOUNTING_COPY_DISABLED` で拒否し、`dedupe_contract_revision` が今の契約の版と違う接続はrouteとworkerが同じコードで拒否し、手段2だけの相手（冪等の鍵の保証なし）は読む操作が確認済みならオンにできる。許可事業者一覧操作がある契約では複数許可のオンを拒否し、一覧操作を持たない契約では架空のendpointを呼ばずowner_screenの対象・日・確認者・版・evidenceRefを検査する。証拠なし・複数事業者の画面・旧credential版は拒否、1事業者の有効な画面証拠は一覧APIなしでも通る。キーの認証方式が未確認ならAPIキー方式を有効化せず、確認済みOAuthとCSVは使える。試験の画面証拠は架空の安全なmetadataだけで、実画像・鍵の値をfixtureに入れない。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting/copy/api/secret-crypto.test.ts tests/unit/lib/accounting/copy/api/oauth-service.test.ts tests/unit/lib/accounting/copy/api/http-client.test.ts tests/unit/lib/accounting/copy/api/expiry.test.ts --runInBand`。controllerはDB suite。
- [ ] **Step 3: 公開仕様の必要な操作をfixture化しS58を実装する。** OAuthの認可・token交換の本物は呼ばず、`CopyHttp` の応答を差し替える。単体の外部通信は `global.fetch` を失敗させるguardも置く。秘密のローテーションと承認・記録はsecrets.mdに従いTask18へ分ける。
- [ ] **Step 4（controller）: GREEN を測る。** 単体・型・lint・共通verify、refreshの同時claim3連続。秘密専用入口のservice_role成功は実行時に生成した値を比較し値そのものを出力しない。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): APIの接続と暗号と鍵の期限を持つ`

### Task 12: freee adapter（現預金は取引＋支払行、その他は振替伝票）

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-635）
- Create: `src/lib/accounting/copy/api/freee-adapter.ts`、`freee-payload.ts`、`freee-normalize.ts`、`tests/unit/lib/accounting/copy/api/freee-adapter.test.ts`、`freee-payload.test.ts`、`freee-normalize.test.ts`
- Read: Task11の公式契約fixtureと公式schema。freeeの本物への試験はTask18

**Interfaces:**
- Consumes: `createFreeeAdapter(deps:CopyApiDeps):AccountingCopyAdapter` の契約、Task5の安全な摘要、S53のfreeeの勘定／税／口座のID。口座の取引先タグにお客様を新規作成しない。
- Produces: 上のfactory、`buildFreeePayload(input:CopyApiEntry):{ok:true;kind:'deal'|'manual_journal';body:unknown}|{ok:false;issues:readonly CopyIssue[]}`、`normalizeFreeeEntry(body:unknown,contracts:CopyApiContracts):CopyRemoteEntry`。bodyの検証schemaはTask11の公式抜粋から作り、JSONのkeyを推測で足さない。
- Produces（仕入／普通預金の例）: 仕入高10% 11,000円／普通預金11,000円は、dealsへ支出の取引として送り、課税の仕入をdetails、普通預金を支払いのwalletにする。現預金の勘定をdetailsへ残したままPOSTしない。1本の店の仕訳が1つの相手の取引から同じ複合仕訳へ展開されることを正規化で確かめる。分割が必要な形・Task 11で操作ごとに原文から取得した行数上限Nの超過・複数支払の表現不能は部分送信せず停止し、CSVを案内する。上限が未取得ならその操作は未確認のままとし、数値を仮定しない。決算等の非現預金の複合仕訳はmanual_journalsで同じ1本を作る。現預金同士の振替等も公式契約で確認し、税を対象外へ変えて制限を逃がさない。
- Produces（番号）: ref_numberがPOSTで指定できるか・長さ・意味は未確認。Task 11でdeals/manual_journalsそれぞれの原文から確定した場合だけ、店の不変の番号との対応を実装する。指定できない操作へ架空の欄を送らない。freee採番のtxn_numberは別の番号で、manual_journalのPOSTはIDだけでも成功とし確認済みGETから補う。dealもremote_kindとIDを必ず保存し、補充の可否は別に確定する。照合は確認できた店番号＋日付＋保存した相手IDで結ぶ。作成入力の未確認で安全な照合を作れなければ該当操作を無効のままにする。
- Produces（取得）: 相手の実仕訳とBS/PL試算表を取る。manual_journalsだけを読むとdealから出来た仕訳や相手の手入力を落とすため、公式の仕訳帳の取得口を含む全体の読みを使う。非同期の仕訳帳出力が必要なら要求ID・状態・downloadをTask11の公式契約どおり処理し、未完了はcomplete=falseにする。署名URLやdownload_urlをDB・監査・ログへ置かない。期間・事業所・全頁を確かめ、BS/PLのup_to_dateがfalseなら照合を一致にしない。
- Produces（失敗）: 400の内容不正・締められた年は固定のrejected、401は再接続（`reconnect`）、403は確定の拒否（`permission`）、429はrate_limited、受理の可能性のあるtimeout/5xxはunknown。createの自動再POSTはadapterで行わない。相手への更新・削除・補助タグの自動作成は0回。

- [ ] **Step 1: 失敗するHTTP差し替え試験を書く。** `FREQ-635-AC-01: 仕入高課税10%と普通預金はdealsのdetailsとpaymentsになり、manual_journalsを呼ばない`、`FREQ-635-AC-02: 非現預金の複合仕訳は1つのmanual_journalで日・勘定・税・額・決算整理を保持する`、`FREQ-635-AC-03: POSTにtxn_numberが無くてもIDを保存して確認済みGETで補い、ref_numberは作成入力を原文確認済みの操作だけに指定する`、`FREQ-635-AC-04: 操作ごとに原文から取得した行数上限NとN+1の境界と表現不能の現預金の複合仕訳は全体で止め分割送信しない`、`FREQ-635-AC-05: 締めた年の拒否は失敗と年度案内になり、timeoutはunknownでPOSTを繰り返さない`、`FREQ-635-AC-06: 仕訳帳の複数頁・非同期未完了・up_to_date=falseを欠落した成功と扱わない`、`FREQ-635-AC-07: 自由文のお客様の情報・鍵・download_urlを出力せず、PUTとDELETEは一度も呼ばれない`。
- [ ] **Step 1の追加ケース（AC-03・05）:** 作成入力にref_numberが無い公式fixtureには同fieldをPOSTしない。取引と振替伝票の契約を取り違えず、ID成功・確認済みGETの番号補充・照合不能の操作の無効化を分ける。送信後timeoutで店番号の照合を保証できなければunknownのまま人の確認へ残す。ref_numberを指定できる操作は店の不変の数字を保つ。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting/copy/api/freee-adapter.test.ts tests/unit/lib/accounting/copy/api/freee-payload.test.ts tests/unit/lib/accounting/copy/api/freee-normalize.test.ts --runInBand`。
- [ ] **Step 3: adapterを実装する。** 許可したhostへだけ `CopyHttp` で送る。式の無害化やMF用の文字の置換はAPIへ持ち込まない。読んだ取引先などの生データはメモリ内だけで必要なIDに正規化し、保存・ログへ丸ごと流さない。
- [ ] **Step 4: GREEN を測る。** 単体・型・lint。payloadを公式schemaに照合し、正規化した仕訳と元の全行の借貸・税区分・日付・件数が同じことを固定ベクトルで検査する。実際に取り込めた証拠とは書かない。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): freeeの取引と振替伝票のadapterを足す`

### Task 13: MF adapter（OAuth／APIキー・固定事業者・3回／秒）

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-636）
- Create: `src/lib/accounting/copy/api/mf-adapter.ts`、`mf-payload.ts`、`mf-normalize.ts`、`mf-rate-gate.ts`、`tests/unit/lib/accounting/copy/api/mf-adapter.test.ts`、`mf-payload.test.ts`、`mf-rate-gate.test.ts`
- Read: Task11の公式契約fixture、MF APIの認証・reports・journalsの原文

**Interfaces:**
- Consumes: `CopyApiDeps`・`AccountingCopyAdapter`・`CopySendResult`・`CopyRemotePage`・`CopyTrialResult` と固定元の税分類・segments。CSVの列や空の税額欄をそのままAPIのJSONの仕様と思わない。
- Produces: `createMfAdapter(deps:CopyApiDeps):AccountingCopyAdapter`、`buildMfPayload(input:CopyApiEntry):{ok:true;body:unknown}|{ok:false;issues:readonly CopyIssue[]}`、`normalizeMfEntry(body:unknown,contracts:CopyApiContracts):CopyRemoteEntry`。POSTはjournalsに1仕訳1要求、branchesで全行を表す。memoに `店仕訳:<entryNo>`、同じ年度のtargetと組で照合する。account_id・tax_id・invoiceの値・journal_typeの決算値は原文のschemaとカタログから引き、CSV名をAPIコードとして送らない。
- Produces（事業者）: APIキーはポータルでこの店の1事業者だけを許可する。キーからの認証方式はTask 11の確認済み契約だけで実装し、Bearerへの交換を仮定しない。許可事業者一覧の公式操作が確認できれば全頁で検査し、未確認ならオーナーがMFの画面で設定して安全な画面の写しを残したowner_screenの記録へ切り替える。どちらも複数許可・証拠なし・鍵の版違いはready/オン不可。targetのoffice_codeを付けることだけでキー権限を絞ったとは扱わない。OAuthも確認済み契約でtargetを検査し、最初の事業者を自動選択しない。相手の勘定・税・期間を確認し、既定税区分への落とし込みをしない。
- Produces（制限と取得）: 全てのPOST/GET/token後の読取で `CopyRateGate` を通る。accessの同じcredentialRefの全workerと照合が共有するDBの予約を使い、発行間隔は334ms以上（1秒3回以下にする店の保守的な値）。待ちが長ければDBにretryAtを記録して処理を返す。回数の識別は秘密でなく内部ID。429に有効なRetry-Afterがあれば秒数／HTTP-dateを検証してその時刻以後に待つ。ヘッダーなし・不正・過去なら店の方針として30秒待ち、adapter内では再POSTしない。常にヘッダーが返るとは仮定しない。GETの頁・範囲・年度は原文どおり。reportsのBS/PLは末端勘定だけを足し小計を重複させない。
- Produces（税と失敗）: 免税・年度途中の登録・経理方式・端数設定はTask2・3と一致させる。APIで税額を指定できるか、MF自身の計算になるかはTask11の公式schemaの契約で固定する。設定が違う場合は送信を止める。額を合わせるための架空仕訳は作らない。GETの省略されたゼロ勘定は、公式が全項目ゼロの時だけ省くと確認できる場合だけ0に展開し、未知の勘定は捨てない。削除・更新のendpointは使用しない。

- [ ] **Step 1: 失敗するHTTP差し替え試験を書く。** `FREQ-636-AC-01: 原文または試しの事業者で認証方式を確認済みのOAuthとAPIキーだけを使い、許可を確認したこの店の事業者へだけPOSTする`、`FREQ-636-AC-02: 別officeと未登録勘定と未使用税区分はPOST前に止め、デフォルトへ落ちない`、`FREQ-636-AC-03: 2workerと照合の同じcredentialの要求は334ms以上空き、異なるworkerでも1秒3回を超えず429はRetry-Afterを使う`（fake clockとDB予約を分けて検査）、`FREQ-636-AC-04: 複合仕訳は1POSTでmemoの番号と全行を保ち、PUTとDELETEは0回`、`FREQ-636-AC-05: 免税と登録日と経過措置の割合と税の方式の不一致を送らない`、`FREQ-636-AC-06: 2頁目の仕訳とBS/PLの末端勘定が含まれ、小計を二重に足さず未対応の相手勘定を差に出す`、`FREQ-636-AC-07: timeoutと不正な成功応答はunknownで、鍵の値と生エラーが監査に無い`。
- [ ] **Step 1の追加ケース:** AC-01/02で一覧操作ありの複数許可を拒否するケースと、一覧操作なしでも1事業者に絞ったowner_screenの有効な記録を検査するケースを分ける。認証方式は原文／試しの事業者で確定した契約fixtureだけを使い、未確認のキー交換HTTPを出さない。AC-03は429のRetry-Afterあり／なし／不正を検査し、欠落時は30秒より前に次の要求を予約しない。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting/copy/api/mf-adapter.test.ts tests/unit/lib/accounting/copy/api/mf-payload.test.ts tests/unit/lib/accounting/copy/api/mf-rate-gate.test.ts --runInBand`。
- [ ] **Step 3: adapterを実装する。** DBで予約するrate gateの書き口はTask14のS59が実体を持つ。このTaskではinterfaceを差し替え、Task14で分散の実証をする。APIのIDがすでにURLエンコードされて返る仕様をfixtureで固定し二重エンコードしない。
- [ ] **Step 4: GREEN を測る。** 単体・型・lint、公式schemaとの照合。試験はnetwork guardで本物へのリクエストが0であることを確認する。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): MFの固定事業者と回数制限つきadapterを足す`

### Task 14: API待ち行列・lease・結果不明の照合・再試行

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-637）、`tests/integration/db/accounting_p7_migration_asserts.integration.test.ts`
- Create: `supabase/migrations/<ts59>_accounting_p7_copy_api_jobs.sql`、`src/lib/accounting/copy/api/job-store.ts`、`copy-worker.ts`、`copy-worker-deps.ts`、`copy-failure.ts`、`src/app/api/cron/accounting-copy/route.ts`、`supabase/pending/schedule_accounting_copy.sql`、`tests/unit/lib/accounting/copy/api/copy-worker.test.ts`、`copy-worker-deps.test.ts`、`tests/unit/api/cron/accounting-copy-route.test.ts`、`tests/integration/db/accounting_p7_copy_api_jobs.integration.test.ts`、`accounting_p7_copy_api_concurrency.integration.test.ts`
- Read: 既存workerの依存差し込み・cron認証・IP抽出。Stripe・Resendのqueueやメールの処理は変更しない
- Modify: `tests/integration/db/accounting_p7_copy_order.integration.test.ts`（CSV/API準備・送信開始・オフ・取下げ・不明結果の全順を追加）

**Interfaces:**
- Consumes: S55のclaim・source、S58のenabled・credential版・秘密のsystem入口、`AccountingCopyAdapter`、`CopyRateGate`、`src/lib/cron/auth.ts` の `authorizeCronRequest(request:Request,endpoint:string,configuredSecret?:string):CronAuthResult`（endpoint=`accounting-copy`）。
- Produces（S59）: `accounting_copy_api_jobs(id uuid PK,batch_id uuid FK,entry_id uuid FK,target_id uuid FK,state text CHECK IN ('queued','sending','verifying','retry_wait','succeeded','failed','reconnect_required','cancelled'),version bigint,attempts integer CHECK>=0,next_run_at timestamptz,lease_token uuid NULL,lease_until timestamptz NULL,send_started_at timestamptz NULL,idempotency_key uuid NOT NULL UNIQUE,binding_version bigint,credential_version bigint,source_hash text,UNIQUE(batch_id,entry_id))` と `accounting_copy_api_attempts(id uuid PK,job_id uuid FK,attempt_no integer,started_at timestamptz,finished_at timestamptz,result_code text,remote_kind text NULL,remote_id text NULL,http_status integer NULL,UNIQUE(job_id,attempt_no))`。attemptsは追記専用、jobはprivateだけが更新。本文・鍵・相手の自由なエラー・個人情報は列を持たない。rate予約は `accounting_copy_api_rate_slots(credential_ref uuid PK REFERENCES accounting_copy_credentials(credential_ref),next_allowed_at timestamptz)`（秘密の値でなく内部のcredential識別子）。
- Produces（入口）: `admin_enqueue_accounting_copy_api(_actor_id uuid,_target_id uuid,_selection jsonb,_expected_source_hash text,_request_key uuid) RETURNS jsonb`（export.read＋settings.manage。S55のcoreで同じ占有を原子的に取得。占有を取る前に、オン・監督・S58の `dedupe_*` の関門の結果を鍵の中で確かめ、無ければ `ACCOUNTING_COPY_DISABLED` で占有を取らない）、`admin_retry_accounting_copy_api(_actor_id uuid,_job_id uuid,_confirmed_absent boolean,_reason text,_expected_version bigint,_request_key uuid) RETURNS jsonb`（同権限。確定失敗・再接続後は通常retry、verifyingはconfirmed_absent=trueと1〜500字の理由を必須にし確認のイベントを追記。jobのbinding_versionが今の接続の版より古い時は、下の「再接続の後の付け直し」の条件を鍵の中で検査してから今の版へ移す）、system用 `claim_accounting_copy_jobs(_limit integer DEFAULT 20,_lease_seconds integer DEFAULT 120) RETURNS jsonb`、`mark_accounting_copy_sending(_job_id uuid,_lease_token uuid,_binding_version bigint) RETURNS jsonb`、`finish_accounting_copy_job(_job_id uuid,_lease_token uuid,_result jsonb) RETURNS jsonb`、`reserve_accounting_copy_api_slot(_credential_ref uuid,_not_before timestamptz) RETURNS jsonb`。private本体＋同署名public入口、system入口はservice_roleだけ。claim・markSending・finish・rateの短いDB操作でのみ鍵を取る。
- Produces（未送信の取下げ）: `admin_cancel_accounting_copy_api(_actor_id uuid,_job_id uuid,_reason text,_expected_version bigint,_request_key uuid) RETURNS jsonb`（export.read＋settings.manage、private同署名本体＋public入口）。queued/retry_wait/reconnect_requiredで、send_started_at IS NULL、受理不明のattempt・remote IDなし、現在のclaim_ownerと版が一致する時だけ許す。理由1〜500字、オフでも操作可能。同じ①②③④の鍵でjobをcancelled・claimをfailedとしwithdrawnを追記しleaseを無効化する。request再送は同じ結果、内容違いは拒否。markSendingと取下げをCASで排他にし、先に送信開始したjobは取下げ不可。send_started_atは過去の送信開始の証拠で、再queueやオフ時にNULLへ戻さない。取下げ後はCSVの通常準備が同じentryを取れる。send_started_atのあるjobはこの入口で断り、下の「送信開始後のjobを閉じる」だけを使う。
- Produces（再接続の後の付け直し）: reconnect_requiredのjobは古いbinding_versionを持つので、そのままではmarkSendingのbinding版の一致で止まる。人の通常の `admin_retry_accounting_copy_api` が、鍵の中で次を全部満たす時だけjobのbinding_versionを今の版へ移す: 同じtarget、今のbinding版に `remote_office_ref` と事業者の確認の証拠（S58）が結ばれ、jobの元の版と同じ事業者、自分のclaim_owner、jobと接続の版が一致、`dedupe_*` が空でない。冪等鍵・固定の入力・source_hashは変えない。付け直しの前に関門の手段で相手にあるかを確かめる: 送信開始なしのjobはそのままqueued、送信開始後のjobは手段1で鍵の有効期間（Task 11で確かめた期間）の内なら同じ冪等鍵でqueued、期間の外か手段2ならverifyingへ入れて店の番号で相手を読んでから決める。別の事業者・証拠なしは付け直さずACCOUNTING_COPY_DISABLEDで断り、未送信なら取下げ、送信開始後なら下の「閉じる」へ案内する。付け直しは `retried` のイベントに元と今のbinding版を残す。
- Produces（送信開始後のjobを閉じる）: 再接続後は、人の通常の `admin_retry_accounting_copy_api` が上の付け直しと関門の手段で決める。手段1で鍵の有効期間の内の相手は同じ冪等鍵のままqueuedへ戻し、期間の外か手段2の相手はqueuedでなくverifyingへ入れ、下の「照合してからの再送」で店の番号で相手を読んでから決める（1件同じならそのIDで成功、確定不在なら不在確認の履歴を残して再試行か取下げ）。手段を使えない時（再接続しない・APIをやめる・`dedupe_*` が無効になった）は、`admin_resolve_accounting_copy_api_started(_actor_id uuid,_job_id uuid,_outcome text,_remote_id text,_evidence_ref text,_reason text,_expected_version bigint,_request_key uuid) RETURNS jsonb`（export.read＋settings.manage、private同署名本体＋public入口）でオーナーが相手の画面で確かめた結果を記録する。outcomeは `present`（相手にある＝写した）か `absent`（相手に無い＝取り下げ）、理由1〜500字と根拠の参照（画面の写しの安全な参照。鍵・個人情報を入れない）が必須、remote_idはpresentで分かる時だけ。対象はqueued/retry_wait/reconnect_required/verifyingでsend_started_atあり、leaseなし、現在のclaim_ownerと版が一致するjobだけ。同じ①②③④の鍵で、presentはjob=succeeded・claim=succeeded・confirmed（code `owner_confirmed_present`）を1回だけ足し、absentはjob=cancelled・claim=failed・withdrawn（code `owner_confirmed_absent`）を足してleaseを無効にし、その後CSVの通常準備が同じentryを取れる。markSending・claim・finishとCASで排他、同じrequest_keyは同じ結果、内容違いは拒否。オフでも操作できる。自動でこの結末へ落とす道は作らない。
- Produces（retryと全入口の持ち主検査）: admin_retryは現在のclaimがjobのtarget・entry・batchを指すclaim_ownerであることを鍵の中で必須検査する。通常はclaim.state=failed、verifyingの不在確認後はresult_unknownだけからreserved＋queuedへ戻す。再接続が必要な確定拒否・鍵の期限切れ・401は全てjobをreconnect_required、送信・未送信の道では自分のclaimを同じ束のfailedとし（guardで他の束へ移らない）、verifyingの読みで401が返った時は受理の有無が不明のままなのでclaimをresult_unknownに保ちjobだけreconnect_requiredにする（failedにしない。再接続と付け直しの後もverifyingへ戻して店の番号で読み、不在の確認の前に再POSTしない）、接続の版が上がっても自動でqueuedへ戻さず、再接続後は人のこの通常retryだけで戻す（画面はTask 16の再試行の操作に案内。send_started_atのあるjobは上の「閉じる」の手段を通る）。403は受理されなかった確定の拒否（`permission`）としてjob=failed・claim=failedにし、権限を直した後の人の通常retryで戻す。不在未確認のunknownは不可。別束のreservedを含む所有不一致はACCOUNTING_COPY_PENDING。同じrequest_keyの既完了結果以外は条件を再検査する。claim・markSending・finish・自動retry_waitからの再queueも、自分のclaimとjobの版・lease・状態を検査し、奪われたclaimで送信／結果更新しない。
- Produces（未終了jobとclaimの整合）: S59でS55の `private.accounting_copy_claim_transfer_guard(_target_id uuid,_entry_id uuid,_from_batch_id uuid) RETURNS void` を同署名・属性のまま置き換える。from_batchにqueued/sending/verifying/retry_wait/reconnect_requiredのjobがあれば、failedのclaimであっても他の束への移動をACCOUNTING_COPY_PENDINGで拒否する。元jobを同じ所有の下で再試行するか、送信開始なしならcancelし、送信開始後なら上の「閉じる」で決め、確定結果ならterminalなfailed/succeededへ閉じてから移る。reconnect_requiredだけが残って所有が消える経路を作らない。S55の既存移行は編集せずS59で再定義し、既存のP7 assertの期待を最新定義へ更新する。
- Produces（jobの冪等鍵）: S59のjobへ `idempotency_key uuid NOT NULL UNIQUE` を足し、enqueueのDB書き口で一度だけランダム生成する。再試行・lease再取得・再接続・送信応答消失でも同じjobの鍵を保持し、CopyJobへidempotencyKeyとして渡す。workerは `adapter.create(job.input,{jobId:job.id,idempotencyKey:job.idempotencyKey})` を呼び、固定sourceとformatter版の入力を変えない。adapterはTask 11で確認済みの位置・名前だけへ鍵を付け、未確認のヘッダーを発明しない。同じ鍵で違う入力を送らず、相手の保証期間が切れた後も再作成を保証できるとは扱わない。その場合は再POSTを止め照合へ残す。Step 0の関門で手段1か手段2が決まっていない作成操作は本番送信を無効のままにし（手段2の相手は鍵の保証が無くても、送り直しの前に店の番号で読むverifyingを必ず通す）、試験の冪等応答を実接続の証拠にしない。鍵の値を計画・ログ・固定fixtureへ書かない。
- Produces（worker）: `runAccountingCopy(deps:CopyWorkerDeps,input:{limit:number;budgetMs:number}):Promise<CopyWorkerResult>`。`CopyWorkerDeps={store:CopyJobStore;adapterFor:(provider:CopyProvider,targetId:string)=>AccountingCopyAdapter;clock:()=>number}`、`CopyWorkerResult={claimed:number;succeeded:number;failed:number;verifying:number;deferred:number;hasMore:boolean}`。`CopyJobStore` は上のclaim／finish／rate／connection statusと、jobとsourceを読むinterface。limit1〜20、実行予算20秒、HTTP1回のtimeoutは最大5秒か残り時間の短い方。残り時間が足りなければ次をclaimしない。
- Produces（storeの型）: `CopyJob={id:string;batchId:string;idempotencyKey:string;targetId:string;provider:CopyProvider;phase:'send'|'verify';leaseToken:string;bindingVersion:string;credentialVersion:string;version:string;input:CopyApiEntry}`、`CopyJobOutcome={state:'retry_wait'|'verifying'|'succeeded'|'failed'|'reconnect_required';code:string;retryAt:number|null;remoteId:string|null;remoteKind:CopyRemoteEntry['remoteKind']|null}`、`CopyJobStore={claim:(limit:number,leaseSeconds:number)=>Promise<readonly CopyJob[]>;markSending:(job:CopyJob)=>Promise<boolean>;finish:(job:CopyJob,outcome:CopyJobOutcome)=>Promise<void>;connectionStatus:(targetId:string)=>Promise<{enabled:boolean;bindingVersion:string;credentialVersion:string;supervisionReady:boolean;dedupeMethod:'idempotency_key'|'lookup_by_store_no'|null;dedupeContractRevision:string|null}>}`。workerはmarkSendingの前に `dedupeContractRevision` を今の `CopyApiContracts.revision` と比べ、違うか `dedupeMethod` がnullならPOSTせず `ACCOUNTING_COPY_DISABLED` でjobを止める。jobのinputは固定したsourceから読み、現在の対応表から作り直さない。rate予約はTask11の `CopyRateGate` の実体が上のDB入口を呼ぶ。
- Produces（固定元のworker入力）: job-storeはbatch.sourceIdを `readFixedCopySource` へ渡し、当該entryの全行・分類・lineFacts・固定settings/mappingsからCopyApiEntryを作る。retryやlease再取得も同じsourceIdで、最新の税区分・年度累計・対応表へ置換しない。job.source_hashは保存sourceの値と照合しTSで再計算しない。FREQ-637-AC-05にprepare後の分類／対応／累計変更と201本以上の頁境界を含め、固定元が旧値のままであることを検査する。
- Produces（claimの粒度）: workerは予算を確認して1本ずつ `claim(1,120)` する。送信前にprocessが止まりsend_started_atが無いlease切れは未送信として再queueできる。markSendingを通ってsend_started_atがあるlease切れはverifyingへ移し、再POSTしない。20本を一括claimして未着手の仕訳まで結果不明にしない。
- Produces（状態の規則）: claim時とPOST直前のmarkSendingでenabled・監督・`dedupe_*` の関門の結果・相手・binding版・sourceの固定参照の整合を再確認する（関門の結果が無ければ `ACCOUNTING_COPY_DISABLED` でPOSTしない）。正本に新しい仕訳や対応の改版が足されたことだけで古いsourceを無効にせず、元と訂正の両方を別jobで写せるようにする。正当なrefreshでは最新accessを読み直し、オーナーによる鍵や相手の変更はbinding版不一致で止める。queueを準備しただけで成功にしない。相手の成功IDを得てDBへ記録した時だけcopy_eventsへconfirmedを足しclaimをsucceededにする。外部success後のDB失敗、送信中のprocess停止、lease期限切れ、timeout、受理した可能性のある5xxは**verifying＋result_unknown**。leaseを取り直してもcreateをそのまま呼ばない。オフは新しいmarkSendingを拒否するが、既にmarkSendingを通って進行中の外部要求を巻き戻せるとは表示しない。その結果も記録し、画面に進行中の件数を残す。
- Produces（照合してからの再送）: verifyingは同じ店番号・日付・targetで相手の全頁を読み、1件だけあり日・勘定・税・額・決算が同じならそのIDで成功。複数・内容違い・頁未完了は人の確認が必要なunknownに残し、確定失敗として解放しない。見つからない場合も未反映の受理が無いと保証できなければ自動再POSTせず、オーナーが不在を確認した理由を記録して、上の同じ所有・同じ冪等鍵のretryだけを許す。拒否が確定した429は有効なRetry-After、欠落／不正は30秒待ち。接続前の明らかな未送信は30秒・2分・10分で最大3回、400と403（permission）は確定の失敗、401はreconnect。手段2の相手のverifyingと送り直しの前の確認も、この店の番号での全頁の読みで行う。送信済みを消してやり直す道は持たず、訂正は別entryとして新しいjobを作る。
- Produces（cron）: `POST /api/cron/accounting-copy` は既存のcron認証・no-storeで、HTTP200 `{claimed,succeeded,failed,verifying,deferred,hasMore}`、構成不備503・依存不備502の固定コード。job・接続0件または全オフなら外部HTTP0回。pendingのscheduleは既定で登録しない。controllerが鍵の準備・オーナーの有効化と送信承認の後にだけpg_cron/pg_netへ登録する手順をTask18へ置く。cronへ鍵を埋め込まない。
- Produces: S59 DETAIL `acc_s59_tables`・`acc_s59_job_claim`・`acc_s59_lease_cas`・`acc_s59_rate_slots`・`acc_s59_started_job_close`・`acc_s59_rebind_after_reconnect`・`acc_s59_rls_acl`・`acc_s59_function_attrs`・`acc_s59_no_automatic_schedule`・`acc_s59_existing_dml_allowlist`。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-637-AC-01: CSVの確認待ちとAPIの同時enqueueは同じ仕訳を二重に占有せず、オフではclaimしてもHTTPが0回`、`FREQ-637-AC-02: 2workerは同じleaseを取らず古いleaseのfinishは状態を変えない`、`FREQ-637-AC-03: 成功POST直後のDB失敗・timeout・lease切れはverifyingとなり、次の実行はGETだけでPOSTを繰り返さない`、`FREQ-637-AC-04: GETで1件同じ内容ならIDを記録して成功、違いと複数と未完了の頁なら人の確認へ止める`、`FREQ-637-AC-05: 1本だけ失敗した束のretryは成功した仕訳を含めず、同じ店番号を使う`、`FREQ-637-AC-06: 2workerと照合のMF rate予約は1秒3回以下で、Retry-Afterを守る`、`FREQ-637-AC-07: オフ切替と鍵の更新とtargetの変更をPOST前に検査し、新しい接続へ古いjobを送らない`、`FREQ-637-AC-08: HTTP中は会計の鍵を持たず、制限の予算を超えて次の送信を始めない`、`FREQ-637-AC-09: cronは既定未登録で認証の失敗は外部HTTP0回、ログには固定コードと件数だけ`、`FREQ-637-AC-10: 送信を始めた後の401のjobは黙って取下げもCSVへの移動もせず、再接続後は手段1なら同じ冪等鍵、手段2なら店の番号での読みで決め、手段を使えない時はオーナーの「相手にある」で成功・「相手に無い」で取下げとなりCSVが取れ、関門の手段が無い接続はオン・enqueue・markSendingが拒否され、再接続→付け直し→markSendingが通って相手の作成の実数が1以下、verifying中の401はfailedにならずresult_unknownのままreconnect_requiredになる`。
- [ ] **Step 1の追加ケース:** AC-01/07でqueued→オフ→未送信取下げ→同じ仕訳をCSV準備、停止後のretry_wait/reconnect_requiredも送信開始なしなら同じ復旧を検証。markSendingが先なら取下げを拒否し、取下げが先ならPOSTは0回。成功・送信開始済み・unknownを取下げで解放しない。AC-06はRetry-After欠落／不正の429を30秒待ちへ保存。AC-10は送信開始後の401→オフ→CSV準備の拒否→（再接続→手段1の同じ鍵の送り直し／手段2の店の番号の読み）と、（再接続しない→オーナーの相手にある／相手に無い→CSV準備）を分け、相手側の作成の実数が1以下、「相手にある」の後に①が1を超えないことを検査する。付け直しは、同じ事業者の再接続→retry→binding_versionが今の版になりmarkSendingが通る、別の事業者・証拠なしの再接続→付け直しを拒否、手段1の鍵の有効期間の外→verifyingで店の番号を読む、を分けて検査し、冪等鍵とsource_hashが変わらないことを見る。verifying中の401は、job=reconnect_required・claim=result_unknown・failedのイベントなし、再接続後もPOSTの前に読みが入ることを検査する。版の一致は、DBの `dedupe_*` が埋まっていて `dedupe_contract_revision` だけが今の版と違う接続で、routeのオン・enqueueとworkerのmarkSendingの前がPOST0回で止まることを検査する。共通order suiteの残る全組を全順列でROLLBACK内に実行し、①〜⑩の不変条件を確認する。Task 4・8・14の共通suiteのRED/GREENコマンドは `npx.cmd jest tests/integration/db/accounting_p7_copy_order.integration.test.ts --runInBand` とする（controllerだけ）。
- [ ] **Step 1の所有・冪等の追加（AC-01〜05・07）:** CSV失敗→API reserved→元CSV retry、API失敗→別CSV reserved→旧API retry、reconnect_requiredのまま別束準備、resolvedとretryとlease切れの全順で所有の奪取と孤立jobを拒否する。相手のHTTP試験道具は実行時生成の冪等鍵と入力を保持し、POSTを受理した直後にDB失敗・timeout・lease切れを起こす。同じjobの後続要求は同じremoteId、相手で作られた実数は1で、DB成功数が0の時も外部の二重を検出できることを確認する。別の鍵や別入力を使う誤実装を試験道具が検出することも検査する。①②④⑤は各操作後のSQL、⑥は相手の受理記録も使って確かめる。全組はROLLBACK内、HTTPは差し替えのみ。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting/copy/api/copy-worker.test.ts tests/unit/lib/accounting/copy/api/copy-worker-deps.test.ts tests/unit/api/cron/accounting-copy-route.test.ts --runInBand`、controllerはDB2suite（並行は別実行）。
- [ ] **Step 3: S59とworkerを実装する。** external POSTとDBのtransactionは原子的にできないため、相手の重複拒否や未確認のidempotency headerを保証として扱わない。正本の仕訳のpostや期首・ハッシュのcoreは呼ばない。workerで必要な状態の保存はcopy側の表だけ。
- [ ] **Step 4（controller）: GREEN を測る。** 単体・型・lint・共通verify、claimとrateとoff切替の並行3連続。全てHTTP差し替えのまま、通信を止めた試験で本物への接続が無いことを確かめる。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): APIの待ち行列と不明な送信結果の確認を足す`

### Task 15: APIの1本ずつの照合・月と年度末の試算表

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-638）、`src/lib/accounting/copy/reconciliation-store.ts`（method=apiの結果の記録）
- Create: `src/lib/accounting/copy/api/entry-reconciliation.ts`、`api-reconciliation-service.ts`、`tests/unit/lib/accounting/copy/api/entry-reconciliation.test.ts`、`api-reconciliation-service.test.ts`
- Read: Task7の比較、Task8の月の印、Task12・13のadapter。相手の仕訳への書き口は呼ばない

**Interfaces:**
- Consumes: `AccountingCopyAdapter.list`・`.trialBalance`、`CopyRemoteEntry`・`CopyRemotePage`、Task7の `compareCopyTrialBalance` と `admin_record_accounting_copy_reconciliation`、S55のsource。
- Produces: `compareCopyEntries(input:{local:readonly CopyApiEntry[];remote:readonly CopyRemoteEntry[]}):readonly CopyDifference[]`、`reconcileCopyApi(deps:{adapter:AccountingCopyAdapter;client:CopyRpcClient},input:{actorId:string;targetId:string;sourceId:string;slice:PeriodMonthSlice;requestKey:string}):Promise<CopyReconciliation>`。仕訳ごとの比較とBS/PLの試算表の比較を**両方**行う。どちらかの読取が不完全・未反映ならincompleteで、先に成功した部分だけでmatchedにしない。
- Produces（照合の鍵と内容）: 店の側はsourceIdを `readFixedCopySource` で読み、固定された分類・segments・対応表を比較の元にする。MFは仕訳メモの店番号、freeeはTask 11で操作ごとに確認した管理番号と保存した相手IDを店の `(targetId,periodId,entryNo)` へ結ぶ。ref_numberが作成時に使えない操作はIDと確認済みGETのtxn_numberとの対応を用い、それも未確認なら操作を無効とし照合をincompleteにする。番号が変わった・重複した物はmissing／extra、日・額だけで結ばない。日・借貸・勘定・補助・税区分・invoice・税額・決算・全行の多重集合を比較する。並びだけの違いは一致、同じ行2本を落とさず、訂正・取消しも独立のentryとして比較する。
- Produces（余分な物）: 自分が送ったIDだけでなく、相手の対象期間の全仕訳を読む。手で追加された仕訳・同番号の複数・店の番号を消した仕訳・相手での勘定と税の入れ替えも拾う。確認済みの相手の開始残高は期首の比較へ分け、それ以外の無関係な取引を無視して帳尻を合わせない。元の帳簿へ差額を反映せず0-3の不一致にする。
- Produces（時点）: 相手に一貫したsnapshot機能が無ければ、全頁取得の前後で更新の境界と件数を確かめ、途中変更が見えたらincompleteとして再読を促す。仕様に境界が無い時は「相手側を変更しないで照合」を表示し、同じ結果を2回読んだ確認を残す。原子的なsnapshotが証明できたとは書かない。BS/PLの集計が未完了なら待ちの状態を返す。MFで全0の勘定が省略される扱いはTask13の根拠つき規則だけを使う。
- Produces（印）: APIの行の比較で差が1件でもあれば、試算表が合っていてもmismatch。端数差も別表示しmatchedにしない。matchedになった現行fingerprintの月だけTask8の仮締めへ進める。再照合は過去の結果を更新せず新しいreconciliationを足す。

- [ ] **Step 1: 失敗する試験を書く。** `FREQ-638-AC-01: 合計が同じでも2仕訳の金額交換・日付交換・税区分交換を検出する`、`FREQ-638-AC-02: 店番号が無い仕訳・重複・相手の手入力・相手で消された仕訳はmissingとextraで出る`、`FREQ-638-AC-03: 複合仕訳の同じ行2本を1本へ落とさず、取引と振替伝票も1本単位で比較する`、`FREQ-638-AC-04: 2頁目の失敗・頁の循環・途中更新・試算表集計中はincompleteで一致の印を付けない`、`FREQ-638-AC-05: 月の切り方と期首と締めの版がCSVの照合と同じで、個人の訂正後も前の版を書き換えない`、`FREQ-638-AC-06: 端数差は別に表示し、試算表だけ一致しても明細の差があればmismatch`、`FREQ-638-AC-07: 照合はGETだけで、相手の不一致をPUTとDELETEと新しい差額仕訳で直さない`。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/lib/accounting/copy/api/entry-reconciliation.test.ts tests/unit/lib/accounting/copy/api/api-reconciliation-service.test.ts --runInBand`。
- [ ] **Step 3: 1本の差と試算表の差を同じ記録へ保存する。** freeeの非同期の仕訳帳の取得や署名URLはメモリ内で扱い、tokenやURLを例外に足さない。失敗しても前の照合が新しい一致へ見えるようなfallbackをしない。
- [ ] **Step 4: GREEN を測る。** 上の単体とTask7の比較の回帰、型・lint。全fixtureで店のjournalとclosing versionsとledger hashesへの書き込み0回を検査する。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): APIの写しを仕訳1本ずつと試算表で照合する`

### Task 16: APIのroute・接続状態と失敗一覧の画面・E2E

controller が別セッションへ先に知らせる（会計の画面とE2E helper）。Task 15のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-639）、`src/components/cost-profit/AccountingCopyView.tsx`、`src/lib/accounting/copy/copy-client.ts`、`e2e/admin-accounting-test-utils.ts`
- Create: `src/app/api/admin/accounting/copies/connections/route.ts`、`connections/[id]/enabled/route.ts`、`connections/[id]/oauth/start/route.ts`、`connections/[id]/oauth/callback/route.ts`、`api-jobs/route.ts`、`api-jobs/[id]/retry/route.ts`、`api-reconciliations/route.ts`（connections以後のパスは同じcopies配下）、`src/components/cost-profit/copy/CopyConnectionPanel.tsx`、`CopyApiJobsPanel.tsx`、`CopyApiReconciliationPanel.tsx`、`src/lib/accounting/copy/api/e2e-http.ts`、`e2e/accounting-copy-http-test-utils.ts`、`tests/unit/api/admin/accounting-copy-api-route.test.ts`、`tests/unit/components/cost-profit/accounting-copy-api-view.test.tsx`、`e2e/FR-ADMIN-161-copy-api-settings-jobs.spec.ts`、`FR-ADMIN-162-copy-api-reconciliation.spec.ts`、`FR-ADMIN-163-copy-api-permissions-secrets.spec.ts`
- Modify: `src/lib/accounting/copy/api/copy-worker-deps.ts`（HTTP差し替えの配線）、`scripts/e2e/environment.ts`（手元のE2E起動時だけ `E2E_ACCOUNTING_COPY_HTTP=fixture` をセット。`.env*` は編集しない）
- Test: 単体・RTLと上のE2E3本。HTTP差し替えはサーバーの依存の層に置く。ブラウザーのpage.routeだけでサーバーの外部通信が止まると思わない
- Create: `src/app/api/admin/accounting/copies/api-jobs/[id]/cancel/route.ts`、`api-jobs/[id]/resolve-started/route.ts`

**Interfaces:**
- Consumes: Task11のconnectionとOAuth、Task14のenqueue/retry、Task15の照合、Task9のCSV画面。未接続でもCSVの操作は利用できる。
- Produces（route）: `GET/POST connections`（一覧と鍵の構成。返りは `{targetId,provider,enabled,status,hasCredential,accessExpiresAt,refreshExpiresAt,refreshExpiryKnown,version}`だけ。入力の鍵はPOST後に戻さない）、`PUT connections/[id]/enabled` body `{enabled,expectedVersion,requestKey}`。`POST .../oauth/start`（settings.manage＋CSRF）、`GET .../oauth/callback`（同じログインsessionと一回限りstate、codeの消費後に状態頁へ303、codeを返さない）。MFのredirect URIはhttpsを必須、戻り先は固定の画面だけ。
- Produces（route）: `GET api-jobs?targetId=&periodId=` → `{data:{jobs:[{id,batchId,entryNo,state,version,attempts,nextRunAt,code}],nextAfter}}`（秘密と生bodyなし）。`POST api-jobs` body `{targetId,selection,expectedSourceHash,requestKey}` →202 `{data:{batchId,queued}}`。`POST api-jobs/[id]/retry` body `{confirmedAbsent,reason,expectedVersion,requestKey}`（unknown時の再送は相手に無い確認と理由が必要）。`POST api-reconciliations` body `{targetId,sourceId,slice,requestKey}` → `{data:CopyReconciliation}`。enqueue/retryはexport.readとsettings.manageの両方、照合と一覧はexport.read、接続とオン/オフはsettings.manage。state callbackだけ通常CSRFの例外、他は順序と回数制限を共通化する。
- Produces（UI）: 「APIの連携」（既定オフ）、「つなぎ直す」、access/refreshの期限（MF不明なら不明の文）、相手の事業者と年度、送信前の期間・版・件数、「送信を待つ」「送信中」「結果を照合中」「再接続が必要」「失敗」。queuedは「写した」と表示しない。unknownには通常の「もう一度送る」を出さず「相手の記録を確認する」。設定をオフにしても失敗と未確認の記録は残る。
- Produces（未送信の取下げroute/UI）: `POST api-jobs/[id]/cancel` body `{reason,expectedVersion,requestKey}` をS59のadmin_cancel入口へ渡し、enqueue/retryと同じ2権限・CSRF・回数制限を適用する。一覧の各jobにsendStarted/canCancel/canResolveStartedを秘密なしで返し、未送信にだけ「取り下げてCSVへ戻す」を表示する。開始済み・unknownには出さず、送信中の結果と履歴を残す。
- Produces（送信開始後のjobを閉じるroute/UI）: `POST api-jobs/[id]/resolve-started` body `{outcome:'present'|'absent',remoteId,evidenceRef,reason,expectedVersion,requestKey}` をS59の `admin_resolve_accounting_copy_api_started` へ渡し、cancelと同じ2権限・CSRF・回数制限を適用する。送信開始後のjobには、まず「つなぎ直して相手の記録を確かめる」を出し、関門の手段を使えない時だけ「相手の画面で確かめました: 相手にある（写した）」「相手に無い（取り下げてCSVへ）」を、理由と根拠の入力つきで出す。黙ってCSVへ戻す操作は出さない。
- Produces（E2Eの依存）: `e2e/accounting-copy-http-test-utils.ts` は架空targetと各試験の応答の組をfixtureとして提供する。`api/e2e-http.ts` は `E2E_ACCOUNTING_COPY_HTTP=fixture`・E2E fingerprint・Supabaseのlocalhost制限が全て通る時だけ、workerと接続/OAuth/照合のbootstrapの `CopyHttp` を差し替える。実本番（`VERCEL_ENV=production` または手元以外のDB）では拒否するが、手元のproduction buildは使える。失敗時に本物のfetchへfallbackしない。新しい公開のモック操作routeは作らない。fixture外の外部要求は即失敗、到達0回を記録する。trialの本物の事業者の成功とは区別する。

- [ ] **Step 1: 失敗する単体とRTLを書く。** `FREQ-639-AC-01: 設定は既定オフで、鍵があるかと期限だけを返し値を表示しない`、`FREQ-639-AC-02: exportだけの人はCSVを作れてもAPIをオンにしたりenqueueできず、settingsだけでも仕訳を送れない`、`FREQ-639-AC-03: unknownでは再送を促さず結果の照合と相手に無い確認を求め、部分失敗は失敗だけを再試行する`、`FREQ-639-AC-04: オフと再接続と期限不明と別事業者を画面とrouteの両方で守る`、`FREQ-639-AC-05: APIの同額の仕訳の入れ替えと余分な仕訳を表示し、仮締めには進めない`、`FREQ-639-AC-06: callbackの生URLと鍵がログ・historyの表示・snapshotへ残らず、失敗のbodyも消費する`。
- [ ] **Step 1の追加ケース（AC-03・04）:** オフのまま未送信を取り下げて同じ仕訳のCSVを作れる経路、開始済みの取下げ拒否、markSendingとの版競合をroute・RTL・161のE2Eで検査する。オフは結果照合を不要にする意味ではなく、未確定を成功扱い・失敗扱いへ変えないことも検査する。送信開始後の401のjobには取下げを出さず、「相手にある／相手に無い」は理由と根拠が無いと送れず、「相手に無い」の後だけ同じ仕訳のCSVを作れることをroute・RTL・161で検査する。
- [ ] **Step 2: RED を測る。** `npx.cmd jest tests/unit/api/admin/accounting-copy-api-route.test.ts tests/unit/components/cost-profit/accounting-copy-api-view.test.tsx --runInBand`。callbackのstate不一致は認可の前段の正しい拒否で検査し、鍵をconsoleで見る試験にしない。
- [ ] **Step 3: routeとUI、3本のE2Eを実装する。** 161はオフ→準備不足の拒否→架空の接続→enqueue→部分失敗、162は合計が同じでも仕訳の差が出る照合と月の印、163は権限差・CSRF・stateの使い回し・秘密なしの応答。試験の先頭IDは上のFREQ-639-AC-01〜06、各390/768/1280px。HTTP fixtureの見本に鍵の値を書かない。
- [ ] **Step 4（controller）: GREEN を測る。** 単体・RTL・型・lint、共通verify、production build・port3000・手元DBで `npx.cmd playwright test e2e/FR-ADMIN-161-copy-api-settings-jobs.spec.ts e2e/FR-ADMIN-162-copy-api-reconciliation.spec.ts e2e/FR-ADMIN-163-copy-api-permissions-secrets.spec.ts`。サーバーの外部HTTPが試験の応答へ差し替わる証拠と、本物への到達0回を確認する。
- [ ] **Step 5（controller）: Files だけコミットする。** `feat(accounting): APIの接続と待ち行列と照合の画面をつなぐ`

### Task 17: 正本の文書・運用・委託と外国の記録

controller が別セッションへ先に知らせる（要求・API・画面・台帳・運用の共有文書）。Task 16のコミット後に始める。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-625〜640と全ACの6列）、`docs/03_BasicDesign/data/er.md`、`docs/03_BasicDesign/api/api-spec.md`・`route-inventory.md`、`docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md`、`docs/04_DetailDesign/shared/finance.md`、`docs/05_Quality/tests/test-spec.md`、`docs/06_Operations/db-migrations.md`（S53〜S59）、`docs/06_Operations/README.md`、`docs/06_Operations/secrets.md`（新しい鍵の種類と担当・ローテーションだけ）、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（状態欄だけ）
- Create: `docs/03_BasicDesign/architecture/accounting-copy.md`、`docs/04_DetailDesign/pages/admin-accounting-copy.md`、`docs/04_DetailDesign/sequence/accounting-copy.md`、`docs/04_DetailDesign/states/accounting-copy.md`、`docs/06_Operations/accounting-copy.md`、`docs/06_Operations/accounting-copy-supervision.md`
- Read: [freee利用規約](https://www.freee.co.jp/terms/)・[privacy](https://www.freee.co.jp/privacy_policy/)・[MF利用規約](https://biz.moneyforward.com/agreement/)、個人情報保護委員会Q&A7-53・7-54・10-25、`docs/README.md`。原文の取得は文書の確認で、本物の会計APIへ接続する試験ではない

**Interfaces:**
- Consumes: Task2の監督の記録、Task11の有効化のguard、全Taskの契約・試験結果・未確認事項。図はMermaidで、CSV確認待ちとAPIの結果不明を別に描く。
- Produces（運用の手順）: 対応表の作成と公式見本の更新、税の法改正の表の追加、MFの文字コードと端数設定、CSVの「取り込めた／失敗」と部分失敗、確認待ちと全件再出力の注意、古い年の解除とMFの期間制限、月の比較と仮締めと変更理由、APIのオン／オフ・つなぎ直し・unknownの照合、相手の開始残高の確認、保存期間・退会後の会計の目的限定、紙／電子の操作説明書を記す。正本はこの店、写しを手で直さず訂正を新しく写すことを明記する。
- Produces（15-iの記録）: 版・確認日・規約URL・相手がデータを取り扱う契約か・目的の範囲・安全対策・アクセス管理・サーバーと再委託先の国・確認した人・法務への質問と回答・次の見直し日を `accounting-copy-supervision.md` とDBのチェックの参照で残す。規約の内容は設計の2026-11-04時点の記述を現在と断定せず読み直す。freeeは利用規約25条の委託の範囲と開発・研究への利用、外国の委託先の国が未確認なら未解決と記す。MFは22条の契約者以外の個人情報を扱わない約束を確認し、自らの安全管理措置を記す。条番号が変われば新しい版の原文を記録する。
- Produces（止める境界）: お客様の名前・住所・メールは送らないが、注文番号も店では本人を識別できる個人データとして扱う。外国で扱う国が未確定なら「国内」と推測しない。弁護士／個人情報保護委員会の判断や国の公表が必要な点はオーナーが確認し、必要ならプライバシーページの変更を別の承認された作業として行う。未完了のままCSVを外部に取り込む／APIをオンにする運用へ進めない。鍵の値や個人データの実例を文書に貼らない。
- Produces（15-j）: MF確定申告で写しから決算書と申告書を作る既定を記す。店の決算書を申告に使うか、優良な電子帳簿の届出でどの帳簿を指すかは税理士の確認記録が要る。写しを作る機能の試験だけでその判断が済んだとは書かない。

- [ ] **Step 1: 根拠と状態を記入する。** FREQ-640-AC-01は規約の版・日付・国・監督と未解決項目、AC-02は操作説明と復旧手順、AC-03は秘密なしと有効化の拒否、AC-04は申告・届出の税理士の確認の記録とする。機械の拒否はTask2・11の試験で持ち、文書の存在だけを成功証拠にしない。
- [ ] **Step 2: 正本を更新する。** `requirements.md` では実装のTaskで追加したACと下の要求表が全て対応すること、API・画面・ER・状態図が最終の名前にそろうことを確かめる。test-specは単体／DB／PostgREST／E2E／provider実接続の結果と未実施を別欄にする。
- [ ] **Step 3: 文書を検証する。** `npm.cmd run validate-docs`。自動生成のtraceability reportは手で直さず、更新が必要なら既存の生成コマンドで作る（計画作成時には実行しない）。共有文書の変更不要を判断した場合は理由と代わりの参照を完了報告に残す。
- [ ] **Step 4（controller）: Files だけコミットする。** `docs(accounting): 写しと接続と照合の正本と運用を更新する`

### Task 18（controller）: 全体検証・本番を読む・適用・鍵の準備後の実接続

**Files:**
- Create: 後日の実装記録 `.superpowers/sdd/2026-11-04-accounting-redesign/plan7-verification.md`、`plan7-changed-tests.md`、`plan7-report-to-owner.md`（この計画作成の作業では作らない）
- Modify: 必要な共有台帳の状態欄だけ。実装コードの追加はしない

**Interfaces:**
- Consumes: Task1〜17の最終差分・Review Focus5行・全試験結果、計画1〜6の本番適用の記録、オーナーの鍵と利用の準備・監督の確認。
- Produces: 静的／単体、DB・並行、PostgREST、build/E2E、公式書式の照合、実接続、本番読取、適用の7つを分けた記録。結果のない境界は「未実施」とする。承認前の外部送信成功と書かない。

- [ ] **Step 1: 全体検証。** `npx.cmd jest tests/unit/lib/accounting/copy tests/unit/api/admin/accounting-copy tests/unit/api/cron/accounting-copy-route.test.ts tests/unit/components/cost-profit/accounting-copy --runInBand`、型・lint、最終SQLでfresh reset、S53〜S59のDB suiteと改ざん試験、service_role／anon／authenticatedのPostgREST、並行3連続、production buildと新E2E7本の3幅、計画1〜6の会計E2E回帰を流す。providerのHTTPは全て差し替えたまま。本物へ到達したら試験の失敗とする。
- [ ] **Step 2: 保護する境界の回帰。** G・Hのsuiteと80本の書き手、決済のファイル／関数、計画3の7本・計画4の7本の本文が前後で同じことを検査する。会計関数の変更はTask8のP7囲みだけ、例外はTask3のS48の仮の税helperだけ。意図して直した本文検査をchanged-testsへ列挙し、その他を無改造で通す。全体の既知の赤はbaselineと分け、新しい赤0件を確認する。
- [ ] **Step 3: 最終レビュー。** controllerが全差分をReview Focus5行・設計15章の対応表・前計画の18行・名前と型・ロック順・鍵の出力0の観点で確認する。別のレビューを依頼する時はcontrollerの作業として扱い、この計画作成セッションからサブエージェントを起動しない。最終コード変更後の `graphify update .` を完了し、未検証の変更を残さない。
- [ ] **Step 4: 本番を読むだけ。** S0〜S52の適用とmd5、現行の権限38件、保護対象の定義、注文が試しだけで0件、必要な会計の表とS48のhelper・S50のcoreが先行計画と一致することを確認する。注文・帳簿の本文・鍵・署名URLを出力しない。本番に試しの仕訳・束・照合・jobを作らない。先行計画が未適用ならここで止める。
- [ ] **Step 5: 本番へ適用。** 作業の承認範囲を確認し、S53→S59を順に適用する。大きいSQLはCLIの現在のhelpで手順を確認して `db push --linked`。schema_migrationsの `md5(statements[1])` とファイルを突き合わせ、schema reloadとanon/authenticatedのitems読取smokeを確かめる。DML0・APIオフ・cron未登録を読む。通常の本番検証は引き続き読取だけ。
- [ ] **Step 6: オーナーによる鍵・接続先の準備。** オーナーがアプリ登録・必要なscope・MFアプリポータル権限・https戻り先・安全なstoreへの秘密の登録・暗号鍵を準備する。MFの「APIキーを有効にする事業者」はこの店の1つだけ。公式の一覧APIを確認できれば接続時の全頁で照合し、確認できなければオーナーがMFの設定画面を見て1事業者だけに絞り、秘密・個人情報を隠した画面の写しと確認日・人・対象・鍵の版を安全な記録へ残す代替手順で確かめる。複数許可・証拠なし・旧版はオン不可。secrets.mdの承認と監査を守り、値は会話・計画・ログ・試験へ貼らず、通常の記録は証拠の参照だけ。監督・外国・必要な公表・税理士の確認の未完了があれば有効化しない。
- [ ] **Step 7: 実接続（別の境界）。** オーナーが用意したfreeeの試しの事業所とMFの試しの事業者で、別環境の架空の仕訳を使って確認する。**CSV部分は準備ができ次第Task 5〜9の後・Task 10の前にもcontrollerが前倒しでき、APIの実装・鍵を待たない。** 公式見本の原本、BOM、MF取込の文字コード設定、引用符／改行、部分失敗、freee現預金と税の組、免税のinvoice欄と値別の未確認項目を確認し、取得原本・入力条件・採用版のオーナー決定・結果を記録する。API部分はTask 11〜16と鍵の準備後だけ、現預金の取引・決算・複合仕訳・期限更新・番号取得・BS/PLと1本ずつの照合を確かめる。試しの事業者が無ければ実接続は未実施、該当する本番profileの能力は無効・APIオフ。ローカルE2Eはfixture_onlyで独立して実行でき、その成功を実取込の証拠にしない。本番のDBから架空の仕訳を作って送らない。
- [ ] **Step 7のAPI契約の未確認を解く。** Task 11で原文から得られなかったMFキーの認証／交換方式・許可事業者一覧操作、freeeの作成操作別の上限と番号、同じjobの冪等鍵の保証を試しの事業者で確かめ、条件と結果の参照だけを残す。一覧操作が確認できない時はStep 6のオーナーの画面記録で1事業者への限定を確かめる。認証・作成の契約が確認できない操作と、Task 11 Step 0の関門で手段1（冪等の鍵）か手段2（店の番号での不在確認）が決まっていない作成操作は本番送信を有効にせず（S58の `dedupe_*` を入れない）、確認済みの方式とCSVを使う。公式の文書で決まる相手はStep 0をオーナーの鍵のStep 6より前に済ませる。公式の文書で決まらない相手は、Step 6の鍵と試しの事業者がそろった後に読む操作だけを先に試してStep 0を決め直し、それまでその相手のTask 12〜16を始めない。HTTP差し替えの成功を原文や実接続の証拠へ置き換えない。
- [ ] **Step 8: 本番の仕訳を送る前の承認。** 対象provider・事業者・年度・版／上限番号・対象の仕訳の集合と件数・送る方法・訂正の有無をプレビューして、**オーナーの明示承認を取る**。承認が無ければ本番のAPIをオンにせずjobをenqueueせず、CSVも本番の相手へ取り込まない。承認後も最初は対象を限定し、成功と照合を確認してから通常運用とcron登録へ進む。試しの事業者への成功を本番送信の承認の代わりにしない。相手の仕訳の削除を確認作業の後始末に使わない。
- [ ] **Step 9: 記録と報告。** 何が検証済みで何が未実施か、前計画の願いの処理、未確認事項の残り、オーナーの設定と承認の記録の参照、意図した試験の変更を残す。commit後はフックと `graphify hook status` を確認するだけで手動updateを重ねない。

---

## 要求と受入条件（後日の `requirements.md` への書き入れ）

現行の6列 `要求ID | 要求 | 要件ID | 要件 | 受け付け基準ID | 受け付け基準` をそのまま使う。各FREQに `FREQ-NNN-REQ-01` を1つ起こし、以下の「実装する内容」を要件へ、各TaskのStep 1のAC番号・具体的な条件を後ろの2列へ1行ずつ入れる。下表の検証先は実装Taskの案内であり、6列を増やす欄ではない。実装・検証の前に完了と記さない。ACは各Taskの同じ番号と内容を正とし、省略名だけで新しいACを作らない。

| 要求 | 実装する内容 | ACの範囲と検証先 | Task |
| --- | --- | --- | --- |
| FREQ-625 | 公式の2書式と文字コードと共通層の利用 | AC-01〜05、profiles・encoders単体 | 1 |
| FREQ-626 | 勘定・税・invoice対応の改版と利用可否 | AC-01〜07、mapping単体・設定DB | 2 |
| FREQ-627 | 行の税分類・日付の割合・1億円（規則T1〜T3）・特例 | AC-01〜12、固定ベクトル単体・DB・全順suite | 3 |
| FREQ-628 | 元の集合・版・占有・仕訳ごとの履歴 | AC-01〜08、source単体・DB・並行 | 4 |
| FREQ-629 | 1本ずつのfreee/MF CSVと安全な摘要 | AC-01〜09、CSV単体 | 5 |
| FREQ-630 | CSVの作成・取得・結果確認・部分失敗 | AC-01〜08、store・route・157/158 | 6・10 |
| FREQ-631 | 月・勘定・期首・件数と年度末の照合 | AC-01〜07、比較単体・DB・159 | 7・10 |
| FREQ-632 | 月の仮締め・理由と変更前後・自動の止め | AC-01〜08、DB・並行・159 | 8・10 |
| FREQ-633 | CSV・設定・照合の画面 | AC-01〜08、RTL・157〜160 | 9・10 |
| FREQ-634 | API接続・暗号・OAuth・期限と既定オフ | AC-01〜07、HTTP差し替え・DB | 11 |
| FREQ-635 | freeeの取引／振替伝票と取得 | AC-01〜07、公式契約・HTTP差し替え | 12 |
| FREQ-636 | MFの事業者・認証・回数・仕訳と取得 | AC-01〜07、公式契約・HTTP差し替え | 13 |
| FREQ-637 | API待ち行列と不明な結果を照合して再試行・送信開始後のjobを閉じる | AC-01〜10、単体・DB・並行 | 14 |
| FREQ-638 | APIの1本比較と試算表の照合 | AC-01〜07、比較単体・HTTP差し替え | 15 |
| FREQ-639 | APIの権限・状態・画面 | AC-01〜06、route・RTL・161〜163 | 16 |
| FREQ-640 | 個人データ・規約・監督・運用と申告の境界 | AC-01〜04、設定の拒否試験・文書・controller確認 | 2・11・17・18 |

## 未確認事項

1. **MFの取込と文字コードの設定、BOM。** 公式FAQは出力の説明で、取込に同じ設定が効くことを証明していない。全列と順はTask 1の公式見本から取り、未使用の最終更新列も空で保持する。末尾列を省く互換形式は採用せず、必要なら別途の見本と試しの取込で確かめる。文字コード・BOM・CP932固有字は値別の表に従い、公式原本→早期のTask 18 CSV確認→採用版の記録で決める。未確認のencoding/入力の組だけ止め、Task 10はfixture_onlyで独立して進める。
2. **freeeの現預金の制限がCSVにも適用されるか。** APIの原文はあるがCSVの可否は未確認。Task 1で最新原文と分類IDを取得し、現預金を明細に含み、いずれかの行に原文の許容区分以外の税区分または税額0以外がある組を固定ベクトルにする。そのCSVだけを確認待ちにし、Task 18のCSV部分を早めて試しの事業所で判定する。適用されない通常行まで止めない。APIの取引形式で同じ仕訳を表現できない形も部分送信しない。
3. **MFの鍵の期限・許可事業者一覧API・キーの認証／Bearer交換の方式、両社の必要なAPI契約。** ポータルで許可事業者を指定・変更できることは確認済みだが、キーで使える事業者の一覧を読むAPIとBearerへ換える手順は原文未確認。Task 11で公式文書から取得し、無ければTask 18の試しの事業者で確認する。一覧APIを確認できなければオーナーがMFの画面で1事業者に絞り安全な画面の写しを記録する方法へ替え、一覧が無いことだけで全方式を使えなくしない。認証方式自体を確認できなければAPIキー方式は無効、確認済みOAuthを使う。期限不明は不明のまま、scope・税額・invoice・operationごとの冪等契約も原文／実接続の証拠で確定する。HTTP差し替えを本物の権限・取込・冪等の保証の証拠にはしない。
4. **経過措置の1億円の上限の数え方（規則T1〜T3）、返品・返還・取消しの扱い、帳簿のみ／少額特例の相手の正式区分。** 次はAIの判断で作り、**税理士に確かめる**（違えば固定ベクトルと規則の式だけ直す）。①規則T1: 行の分け方は初めて束に固定した時に決めて変えない。取引先×課税期間の経過措置の累計が1億円以下の間は全部を経過措置にし、超える行とその後に来る経過措置の行は `tax_unconfirmed` で止め、オーナーが税理士と決めた分け方を `admin_decide_accounting_copy_cap` で入れた時だけ写す（自動で控除なしに分けない）。②規則T2: 取り消し・訂正・返品の行は元の行の固定の分け方と割合（元の仕入れの日の割合）を、その行の額（一部の額でもよい）で写す。法人の締めた年の訂正（見つけた年の日付・`8015`・`8025`）も分け方は元の行に倣う。③元の行が分からない経過措置の返品・値引きは止め、オーナーが元の仕入れを選ぶまで写さない（返品の日の割合では引かない）。④規則T3: 1億円以下の間は分け方の違いが起きず、超える所と元の無い返品は人が決めるまで写さないので、写した控除は日付の順に厳密に数えた額を、8%と10%が混ざっても超えない（入口が人の決めた分け方もこの額と比べる）。税理士に確かめる点: 上限の数え方と超えた所の分け方、返品・取消しの割合を元の仕入れの日で決めてよいか、税率の混ざる相手で先に写した行の分け方が後の決定と合うか、法人の締めた年の訂正を見つけた年に元の割合で引くと前の年と二重に減らさないか。Task3でNo.6496・6497と改正の原文・税理士の回答を得る。住所の省略の種類、同一取引の範囲、課税期間の境、元の課税仕入日を固定ベクトルへ入れる。帳簿のみ等の区分が決まらない行は出力を止める。計画2・3で税判断が未確定のdispute・Stripe手数料はここで対象外に決めない。
5. **freeeの委託の範囲と外国の委託先の国、MFの現行の約束、申告と届出の正本。** Task17・18でオーナーが法務・税理士へ確認する。計画1〜6の決定を変更しない。国と必要な公表が未完了なら外部への取込／API有効化を止める。
6. **期末でない日の決算の訂正とMFの決算整理の印。** MFの印は日付を期末へ変えるため、元の日を保つことと衝突する入力は停止する。Task5で実例を検出しcontrollerへ知らせる。日付を動かす／印を落とす／仕訳を別物へ作り替える判断を実装者がしない。
7. **freeeのAPIの管理番号・行数上限・取得の一貫した時点。** ref_numberの作成入力での有無・長さとdetailsの上限は未確認であり、dealsとmanual_journalsを分けTask 11で公式schemaから取得する。行数の境は取得したNとN+1で、計画に数を固定しない。manual_journalsのPOSTからtxn_numberが外れGETで取ることは確認済み。ref_numberなしのIDと確認済みGETのtxn_numberによる結びもfixtureへ固定し、安全に結べなければ該当操作を停止する。Task 18で試しの事業所を確認する。MFも含めsnapshot保証が無ければ限界を表示しincompleteを残す。買い手側対応機能の必要性は設計の記述と原文を区別してTask 1・2で取得し、未確認の経過措置の組を確認済みとしない。

## オーナーへの報告（後日のTask 18で載せること）

1. 正本はこの店の保存した仕訳。CSVの取得だけでは写したことにならず、相手の結果を確かめて「取り込めた／失敗」を仕訳ごとに記録する。確認待ちを放置して新しい束を作らない。
2. 「全部」の再出力はMFで二重になる危険があり、通常は未転記分を使う。freeeの同日・同番号の拒否も、店の確認の代わりではない。
3. 対応表・行の税・期間・文字コード・MFの経理方式と端数設定・相手の期首を確認する。未対応や特例の未確認は出力を止める。端数差は隠さない。
4. APIは最初オフ。鍵はオーナーが安全なstoreへ置き、値を報告しない。試しの事業者の確認と、本番の仕訳を送る集合の承認は別。オフでもCSVは使えるが、外部への取込の前に監督と個人データの確認は必要。
5. 送信の結果が分からない時は再送せず照合する。相手に冪等の鍵が無く店の番号での不在確認もできない相手は、APIをオフのままCSVで写す（関門の手段が決まるまでオンにできない）。送信を始めた後に再接続が必要になった仕訳は、黙ってCSVへ移さず、再接続して確かめるか、相手の画面で確かめて「相手にある／相手に無い」を押す。1億円の上限の税の分け方は、初めて写す時に決めて変えない。1つの相手（インボイスの登録の無い相手）の経過措置の仕入れが1つの課税期間で1億円以下の間は全部を経過措置で写す。超える行とその後の行は「1億円の上限を超えます。分け方を税理士に確かめてください」で止まり、税理士と決めた分け方を入れるまで写らない。元の仕入れが分からない返品も、元を選ぶまで止まる。取消し・訂正・返品は元の仕入れの分け方と割合で引く（数え方と返品・取消しの扱いは税理士に確認）。相手で手で直した差は表示するだけで、自動修復や削除をしない。月の仮締めの後の変更は理由を残し再照合する。
6. 未確認事項1〜7と実接続の未実施の有無、MFで申告する既定と届出の正本の税理士の確認、規約・委託先の国・必要な公表を報告する。元の#8の頁の鍵は「決めたこと」へ移し未確認として残さない。

## セルフレビュー（writing-plans）

- **設計の網羅:** 15-1の4行、15-a〜j（c2・g2を含む）、図、15-3の9例、15-4の根拠19行、15-5の比較7行、10-j・10-k、16章の関係する行を対応表にした。期首の税調整・決算書・訂正の仕訳を作る処理は計画1〜6へ分け、写しが正本を直さない。
- **前計画の網羅:** `計画7` の一致18行を1行ずつ表にした。計画2〜4は0行、計画5は2行、計画6は16行。計画6の公開名と型は再定義せず使う。願いはJSON契約の明文化1件だけで、前のファイルは変更しない。
- **Task間の名前:** `CopyProvider`・`CopySelection`・`CopySourceRef`・`CopyProfile`・`CopyLineTax`・`CopyBuildResult`・`CopyReconciliation`・`CopyApiDeps`・`AccountingCopyAdapter`・`CopySendResult` は定義Taskと消費Taskをそろえた。相手IDと店の期間内の仕訳番号とファイル内ordinalとfreeeの相手側番号を分けた。
- **Review Focusの試験:** 1→628-AC-03〜06・630-AC-03〜05・637-AC-01〜05・639-AC-03。2→626-AC-02〜04・627-AC-01〜06・627-AC-10〜12・629-AC-04〜05・636-AC-05。3→628-AC-01〜02・629-AC-01〜03・631-AC-06・635-AC-02〜04・638-AC-03〜05。4→625-AC-02〜04・629-AC-06〜08・630-AC-06/08・635-AC-07。5→631-AC-05・632-AC-02〜07・634-AC-03〜06・636-AC-01〜03・637-AC-07・638-AC-01〜07。いずれも該当TaskのStep 1に置いた。
- **作業の境界:** この文書は計画であり、列と取込の実証、DB・並行・PostgREST・build/E2E・本物のprovider・本番送信の成功を表さない。全TaskはFiles／Interfaces／チェック可能なStepを持つ。CSV Task 1〜10の後にAPI Task 11〜16、正本17、controller18の順。実装中のコミットはcontrollerだけ、今回の計画作成ではコミットしない。

### 2026-11-05 直し1の対応（19件）

[修正指示](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-fix-1.md)と[確かめの結果](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-review.md)の全件を反映する。ここでの対応済みは計画の修正であり、後日の実装・試験・原文取得の完了ではない。

| 指摘 | 直した契約・確認先 |
| --- | --- |
| 重大-1 | Task 4の固定元SQL・全頁と全分類、唯一のDB sourceHash helper。Task 6・14の固定読みと628-AC-06・630-AC-04・637-AC-05 |
| 重大-2 | Task 4・6・9のCSV再作成／取下げ、Task 14・16の未送信API取下げ。送信開始とのCAS、同じ番号・sha256、オフからCSVへの復旧 |
| 中-1 | Task 1で列数を計画から外し、公式fixtureの全列順と最終更新列を保持 |
| 中-2 | Task 11・13・18でMFポータルの許可を1事業者に絞る。公式一覧API未確認時はオーナーの画面設定と安全な画面の写しの記録で確認し、複数許可・証拠なしのオンを拒否 |
| 中-3 | Task 3・4で累計入力と計算済み配賦を固定、古い日付の追加による差をTask 9で表示し15-fの訂正へ |
| 中-4 | 願い1を既存next_after_date/next_after_noに統一、税の変更願いを除去 |
| 中-5 | 値別の根拠・代替確認表、未確認の組だけ拒否、Task 10のfixture_only、Task 18 CSV確認の前倒し |
| 中-6 | Global Constraintsの出来事×状態と6不変条件、Task 4・8・14の共通order suiteで全順をROLLBACK内に実行 |
| 中-7 | Task 4・6でclaim_owner/history_onlyを固定し、再出力失敗でも既存の成功を保持 |
| 中-8 | Task 8・9の解除前N件と内訳の確認、集合の件数・指紋CASとreleasedへの保存 |
| 小-1 | 出典表で初稿抽出・レビュー403・今回の原文再確認・見本未取得を区別。Task 1で公式原本を取得 |
| 小-2 | Task 13・14でRetry-Afterなし／不正の429は店の方針で30秒待ちとし試験へ |
| 小-3 | Task 11・12・15と未確認#7でdeals/manual_journalsのPOST入力を原文確認、ID/GETの結びを確認するまで該当操作を無効 |
| 小-4 | Task 3の最初に旧10億円の開始日を国税庁の原文から取り境界ベクトルへ |
| 小-5 | Task 1のwithBomはname不変、Task 6の630-AC-06でBOMとcharsetを検査 |
| 小-6 | CopySelectionとTask 4でclosedは版必須、open方式は開いた期間だけ、拒否をACへ |
| 小-7 | 計画5:167の期首税調整は7計画の外に別途起こす課税切替計画の担当 |
| 小-8 | Task 6の最初に共有accounting-typesの変更を別セッションへ先に知らせる行を追加 |
| 小-9 | Task 5の列別検査で摘要・メモ200/201字、接頭辞と置換後を含め名前30/31字を検査 |

直し1の後の確かめ直しでは、上の19件のうち15件が対応済み、4件が一部対応と判定された。残った4件と新しい7件の今回の対応は下表。未確認の値は7項目に取得・判断のTaskを残し、原文未確認を今回確認済みとはしない。

### 2026-11-05 直し2の対応（11件）

[修正指示2](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-fix-2.md)と[確かめ直し1](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-rereview.md)の残り4件・新規7件を反映する。対応済みは計画の修正を指し、実装・DB試験・本物のAPIの契約確認が済んだ意味ではない。

| 指摘 | 直した契約・確認先 |
| --- | --- |
| 前回重大-1の残り | Task 3のS54にDBの税計算口を定義、Task 4のpreview/prepareはその戻りだけをsourceHashと固定元へ使う |
| 前回中-2の残り | Task 11・13・18で公式の一覧操作を未確認へ戻し、オーナーのMF画面設定と安全な画面の写しの証拠を代替にする |
| 前回中-3の残り | Task 3・4で年度累計と配賦をDBが計算し、1回保存した基礎を行から参照して固定値の再生成と現行との差を検査する |
| 前回中-6の残り | 共通表に5出来事とCSV retryを追加、所有検査と6不変条件・相手側の受理実数を全順suiteへ反映 |
| 新規重大-A | accounting_copy_tax_segmentsの署名・入力・戻り・年度全体の読取と鍵、627-AC-08のDB/TS同一ベクトル、628-AC-06のDBの答えだけによる固定 |
| 新規中-A | Task 4・14でretryは現在の親／jobのclaim_ownerだけ。未終了jobの移動guard、相手側1本の冪等鍵と出力数・所有の不変式、5出来事の全順 |
| 新規中-B | 未確認#3にMFの一覧APIと認証／Bearer交換を戻す。原文／試しの事業者で確認、一覧なしは画面記録、認証未確認はAPIキー方式無効 |
| 新規小-A | 出典表とTask 1・2で買い手側対応機能を設計由来・原文未確認と記し、626-AC-03の期待値は原文取得後に決める |
| 新規小-B | Task 11で作成操作別の上限Nを公式schemaから取得、Task 12のACはN/N+1、未確認#7に残す |
| 新規小-C | Global Constraintsを「この計画7のファイルだけ」へ訂正 |
| 新規小-D | source_supplier_basesへ課税期間×supplierのmanifestを1回保存、line_factsはbasis_idと累計前額等だけ。sourceHashもそのIDと基礎の1個分を含む |

今回の11件は計画へ反映済みで未修正の指摘は0件。未確認の原文値と実接続は担当Taskで確かめ、今の成功とは報告しない。

### 2026-11-05 直し3の対応（7件）

[修正指示3](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-fix-3.md)と[確かめ直し2](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-rereview-2.md)の7件を反映する。対応済みは計画の修正を指す。

| 指摘 | 直した契約・確認先 |
| --- | --- |
| 中-C | Task 3：分け方はその行より前の行の累計だけ、manifestは出力行までの前の行に限る。627-AC-09 |
| 重大-B | Task 3・4・9と規則の表・不変⑦：差のある取引先×課税期間は固定コードの差の止めで新しい束に出さず、照合はmatchedにしない（直し4で規則T1〜T4に置き換えた）。直しは15-fの取消しと正しい仕訳。取消し・返品は元の取引日で引く（税理士確認は#4）。627-AC-10・628-AC-06、全順の組 |
| 中-D | 規則の表と Task 14：鍵の期限切れ・401はjob=reconnect_required・claim=同じ束のfailed、再開は人の通常retryだけ |
| 中-E | Task 11にStep 0の関門（公式の冪等の鍵／店の番号での不在確認／どちらも無ければオフでCSV）。Task 18とオーナーの報告にも反映 |
| 小-E | supplier_refが無い経過措置の行はtax_unconfirmedで止める。627-AC-10 |
| 小-F | 規則の表の行93にS59 guardと差の止め、不変⑤をAPIの実在の状態に直した |
| 小-G | 不変⑥にjobごとの作成POST回数（不在確認の前は1回以下）を足した |

### 2026-11-05 直し4の対応（11件）

[修正指示4](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-fix-4.md)と[確かめ直し3](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-rereview-3.md)の一部2件・新規9件を反映する。対応済みは計画の修正を指す。

| 指摘 | 直した契約・確認先 |
| --- | --- |
| 重大-B・重大-C・重大-D・中-C | controllerの決定で差の止めをやめ、規則T1〜T4（「決めたこと」）にした。Task 3のS54に固定の表 `accounting_copy_line_tax_fixings`、累計は固定した行の和と束の中の前の行、取消しは元の行の写し（上限と返品の扱いは直し5で、超える所と元の無い返品を止めて人が決める形へ書き直した）。Task 4のsupplier_bases・line_facts・prepareのcore、規則の表、不変⑦〜⑨、全順の組、627-AC-03・10〜12、628-AC-06、Task 9、未確認#4、オーナーへの報告5 |
| 中-G | 法人の締めた年の訂正は計画6の仕訳（見つけた年の日付・`8015`・`8025`）のまま写し、分け方は規則T2で元の行に倣う（S54の `original_*`、627-AC-11） |
| 中-E・中-I | 関門の結果をS58の `dedupe_*` に記録し、オン・enqueue・markSendingの条件にした。「冪等の保証が無ければ無効」の3か所（Task 11・14・18）を「関門で手段1か手段2が決まっていなければ無効」にそろえ、文書で決まらない相手の順を決めた。634-AC-01 |
| 中-H | 送信開始後のjobは黙って取下げ・CSVへ移さない。再接続後は関門の手段で決め、使えない時はオーナーの「相手にある／相手に無い」（Task 14 `admin_resolve_accounting_copy_api_started`、Task 16のroute/UI、規則の表、不変③、全順の組、637-AC-10） |
| 小-H | 差の止めの固定コードをやめたので、`COPY_ISSUE_CODES` と拒否の表には足さない |
| 小-I | 要求の表をFREQ-627はAC-01〜12、FREQ-637はAC-01〜10にした |
| 小-J | 401は再接続、403は確定の拒否（permission、job=failed）に規則の表・Task 12・14でそろえた |

### 2026-11-05 直し5の対応（8件）

[修正指示5](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-fix-5.md)と[確かめ直し4](../../../.superpowers/sdd/2026-11-04-accounting-redesign/plan7-rereview-4.md)の一部1件・新規7件を反映する。controllerの決定で、1億円を超える所は自動で分けず止めて人が決める形に、規則T1〜T4を書き直した。

| 指摘 | 直した契約・確認先 |
| --- | --- |
| 中-G・中-K | 規則T2で取り消し・訂正（法人の締めた年の訂正を含む）・返品は元の行の分け方と割合を、その行の額（一部の額でもよい）で写す。複数の区分の元は額の比で分け、端数は経過措置の側へ。前の年と二重に減らす心配は未確認#4で税理士に確かめる。627-AC-11 |
| 重大-E | 元の行が分からない経過措置の返品は `tax_unconfirmed`（`return_original_required`）で止め、オーナーが元の仕入れを選んだ後に元の日の割合で写す。返品の日の割合で引かない。627-AC-06・12、不変⑨ |
| 中-J | controllerの決定で規則T1〜T4を書き直した。1億円以下は全部経過措置、超える行とその後の行は `cap_exceeded` で止め、自動の控除なしをやめた（Task 3に `accounting_copy_cap_decisions` と `admin_decide_accounting_copy_cap`）。規則T3から「後ろに足しても取り過ぎない」理由を消し、8%と10%が混ざっても超えないことを不変⑩（税額×割合）と人の決定の入口の検査にした。Task 4・6・9、627-AC-10・12、全順の組 |
| 中-L | 再接続の後の付け直し（同じ事業者・証拠・関門の手段で確かめてからbinding版を移す）を「決めたこと」・規則の表・Task 14・637-AC-10・全順の組に置いた |
| 小-K | `dedupe_contract_revision` と今の契約の版の一致はTS（routeとworker）が比べ、DBは `dedupe_*` が空でないことを比べる（Task 11・14の `connectionStatus`） |
| 小-L | 不変⑦を「`cap_delta` の和が1億円以下」と「各固定行の `cap_used_before` が前の `fixing_seq` の `cap_delta` の和と等しい」の2つにした |
| 小-M | verifyingの読みで401が返った時は、claimをresult_unknownに保ちjobだけreconnect_required（failedにしない）。規則の表・不変⑤・Task 14・637-AC-10 |
