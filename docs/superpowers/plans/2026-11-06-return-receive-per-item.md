# 返品の受け取りで品ごとに返金の仕方を選ぶ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1回の返品の受け取りで品ごとに「今すぐ返金」「額を相談」を選び、今すぐ返金の額をその品の額と送料までに制限する。

**Architecture:** 受け取りの親行・requestKey・返金・履歴・お客様へのメールは各1つのまま、受け取り明細に返金の選びを保存する。DB が品ごとの選び、H の確保した着、手数料、上限、P9 を同じ取引で確定し、画面は同じ材料で見込みを出す。会計計画3の実装より先に入れ、同計画の受け取りの前提を更新する。

**Tech Stack:** 現行の Next.js 16、React 19、TypeScript、Zod、Supabase Postgres・PostgREST、Jest・React Testing Library、Playwright。依存を増やさない。

**Spec:** [承認済み設計書](../specs/2026-11-06-return-receive-per-item-design.md)（2026-11-06 オーナー承認）を正とする。[現状調査](../../../.superpowers/sdd/2026-11-06-return-receive-per-item/research-report.md)と[作る人への問い](../../../.superpowers/sdd/2026-11-06-return-receive-per-item/builder-check.md)は根拠。問い1は案イ、問い2は設計3-3で解決済み。

## 概要

状態: レビュー2の「再確認（3回目の直し）」の小1を受けた4回目の修正、確認日: 2026-11-06。今回の編集はこの計画だけ。以下の作成・編集・試験・コミットは後日の実装手順であり、今回実行しない。設計書と会計計画3も今は編集しない。

| Task | 成果物 | 設計の対応 | 主な検証 |
| --- | --- | --- | --- |
| 1 | 新移行・明細・DB の受け取りと H の接続 | 4、5、6の通知予定 | DB・PostgREST・H/G 回帰 |
| 2 | 窓口・型・store・service | 5-3 | 単体 |
| 3 | 計算・受け取りの画面 | 3、4 | 単体・RTL・画面結合 |
| 4 | メールの材料と文・履歴の細目 | 6 | 単体 |
| 5 | 新規 E2E・既存 E2E の期待更新 | 8 | 本番ビルド・手元 DB・3幅 |
| 6 | 範囲外の要求・画面・API・データ・流れ・試験・運用 | 8 | 文書・要求対応表・型・lint |
| 7 | 会計計画3の文書修正 | 7 | 計画の静的確認 |

Task 6 Step 1・2の採番と要求定義を最初に行う。Task 1→2→Task 5 Step 1・2（旧画面のE2E RED）→Task 3→4→Task 5 Step 3〜6→Task 7の順に進め、Task 6の最終確認で閉じる。Task 6の正本は各Taskの実装と同時に更新する。

## 範囲と根拠

| 根拠 | 確認する契約 |
| --- | --- |
| `research-report.md` 1・2・7章、`src/lib/orders/returns/return-store.ts:283` | 単一の受け取りと返り値、14引数、送り直し |
| `supabase/migrations/20261029130400_group_h_discounts_refunds.sql:2178` | private の最新の受け取り本体。public は `20261023211425_group_g1_allocation.sql:7371` |
| `research-report.md` 4・5・8・10章 | 手数料、P9、メール、既存試験の見直し先 |
| `docs/superpowers/plans/2026-10-29-group-h-promotions.md` Task 9 | 移行・private/public・H の着・controller の検証境界 |
| `docs/superpowers/plans/2026-11-04-accounting-p3-returns-refunds.md` Task 4・7、未確認 #17 | 将来の会計側の修正箇所。現行実装と扱わない |
| `.claude/CLAUDE.md`、`.claude/skills/documentation-guide/SKILL.md`、`docs/README.md` | 領域の正本、ID、テスト名、同じコミットでの文書更新 |
| [レビュー1](../../../.superpowers/sdd/2026-11-06-return-receive-per-item/plan-review-1.md)全文と末尾の追記3 | 案イを保つHの最小修正。重大2は追記で中へ訂正。今もある2回受け取りの不具合を含む |
| [レビュー2](../../../.superpowers/sdd/2026-11-06-return-receive-per-item/plan-review-2.md)の再確認（2回目）の中1〜3と、再確認（3回目）の小1 | 空きの容量・優先順・重複防止・取り直し。AC-07の場面2/3は承認時のid順の確保で作れる価格・期待値にそろえる |

Graphify queryで関係を絞り、指定文書・移行を読んだ。今回の判断は文書とソースの静的確認であり、実DB・適用状況・provider・実メール・ブラウザーの確認ではない。

## Global Constraints

- 正本は承認済み設計。相談後の `admin_refund_return` の対象（返品の返金待ち全部）と上限（注文の返せる額）、返品作成時の費用設定、お客様の申込画面、権限の初期割当を変えない。
- 計算どおりの額は `max(G今 − F今, 0) + S`、入力上限は `min(注文の返せる額, G今 + S)`。画面とDBで確かめ、DBを正とする。
- `S <= 注文の返せる送料の残り` かつ `S <= 返金額`。手数料を負ける額も上限まで。窓口は金額の形だけを確かめる。
- 返品手数料は `floor(G今 * p / 100)` と `floor(G相 * p / 100)` を別々に計算する。最初だけの固定費用は今すぐ分へ先に引き、不足は同じ受け取りに相談があれば `fee_pending_deduction`、なければ `fee_due_amount`。
- H は当該返品行が確保した着を使い、同じ返品行の今すぐ分へ安い着から当てる。見込みも同じ順。旧注文の均等式をHへ流用しない。
- 権限名は `admin.orders.refund`。`canRefund` は窓口の認可結果から取り、役割名で分岐しない。返品操作の既存権限 `admin.orders.return` も保つ。
- 権限なしのP9は `source='customer_request'` かつ `return_method<>'not_required'` の既存条件。品ごとの選びは出し、金額・送料の入力は出さない。P9外は全品相談。既存の数量・注文残額・返事待ち返金の拒否も保つ。
- 品ごとの選びを送る時、全体の `refund_choice` は実効返金明細がnowだけなら `now`、consultだけなら `consult`、両方なら `mixed`、どちらも無ければ `none`。本文・DBの親・監査をこの規則でそろえる。明細にmixedは許さない。受け取り1行・requestKey1つ・返金は最大1件・HTTP結果は既存の形。
- 新しい返金明細は選びを必ず保存する。旧NULL明細は親now/consultで補う。親mixedで返金明細NULLは拒否し、noneへ黙って補わない。既存行は更新せず、追記専用・RLS・直接DML拒否を保つ。
- `private.order_return_line_states_core` は変更しない。印は行を作った順のまま。案イのままHの関数の直しを今回に含める（2026-11-06 オーナー承認）。待ち額・初回確保・error後の取り直し・後続相談返金はTask 1で固定する。
- 返品は追跡の範囲外（2026-11-06 調整役判断）。ADMINはadmin-miscだけ。範囲を広げず、Task 6のFREQと範囲外の正本一式で管理する。ADRは範囲外なので不要。
- 適用済み移行を編集しない。新移行は `BEGIN;` 1組、末尾assert→`NOTIFY pgrst, 'reload schema';`→`COMMIT;`、UTF-8/BOMなし/LF、SQLはコメント・文字列もASCII。
- private本体はpostgres所有・`SECURITY DEFINER SET search_path = ''`、public入口は同署名の`SECURITY INVOKER`、EXECUTEはservice_roleだけ。内部helperはPUBLIC/anon/authenticated/service_roleからREVOKEし、private schemaのUSAGEを一括変更しない。
- G共通鍵 `pg_advisory_xact_lock(190521,1)` と現在の在庫・注文・返品・返金のロック順、交換判定の時点、FIFO、在庫台帳の合算を保つ。
- 書込の認可→CSRF→回数制限→入力→DB→監査を保つ。生のDBエラー、メモ、お客様情報、追跡番号を監査へ足さない。
- E2Eは手元Supabase・port3000・本番ビルド（`next build && next start`）、mobile 390px・tablet 768px・desktop 1280px。devの結果を回帰の合否に使わず、retriesで失敗を隠さない。
- 実装者は単体・型・lint、controllerは手元DB reset・DB結合・PostgREST・build/E2Eを担当する。本番DBへの適用・本番を読む作業はこの計画に入れない（未確認1）。
- 今回はDB・サーバー・試験・Supabase CLI・Docker・providerを動かさず、`.env*`を読まず、コミット・stage・branch/worktreeを作らない。既存の `.claude/CLAUDE.md`・`package.json`・`.superpowers/` の差分を保持する。
- 後日のUI/API実装前に関連skillと `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`・`15-route-handlers.md` を読む。最終コード変更後はcontrollerが `graphify update .`、コミット後は `graphify hook status`。今回graphを書き換えない。

## Review Focus

- 結果不明の再送で、明細の順序が違っても同じ選び・数量は同じ指紋になり、選びを変えた同じキーは拒否されるか → Task 1 `FREQ-641-AC-09`・Task 3 `DD-ADMIN-019`。
- 同じ返品行の2点を今すぐと相談に分けた時、Hの安い着が今すぐに当たり、同じ注文商品の別返品行で印が逆に見えても後の相談返金が通るか → Task 1 `FREQ-641-AC-10`・Task 3 `DD-ADMIN-017`。
- 今すぐ返金の失敗で戻す控除が、既存と今回の相談分の控除へ二重に足されたり、再受付で相談分まで消えたりしないか → Task 1 `FREQ-641-AC-07`。
- 0円の今すぐと相談の混在で、今すぐ分だけを免除し、相談分は返金待ちのまま、受け取りメール1通・履歴の受け取り1行になるか → Task 1 `FREQ-641-AC-07`・Task 4 `DD-ADMIN-020`・Task 5 `FREQ-641-AC-05`。
- P9の人が品ごとに相談も選べ、額入力はなく、P9外への細工や0円を含む指定額は窓口・DBで止まるか → Task 1 `FREQ-641-AC-09`・Task 2 `DD-ADMIN-018`・Task 5 `FREQ-641-AC-03`。

---

### Task 1: 明細の返金の選び・受け取り・上限・Hを新移行で接続する

**Files:**
- Create: `supabase/migrations/<tsRR>_return_receive_per_item.sql`（下記のCLIが生成する時刻だけを実装時に確定）、`tests/integration/db/return-receive-per-item.integration.test.ts`、`tests/integration/db/return-receive-per-item-migration.integration.test.ts`
- Modify: `tests/integration/db/order_return_receipts.integration.test.ts`、`tests/integration/db/order_return_request_reviews.integration.test.ts`、`tests/integration/db/return_postgrest.integration.test.ts`、`tests/integration/db/group_h_refunds.integration.test.ts`、`tests/integration/db/group_h_refund_outcomes.integration.test.ts`、`tests/integration/db/group_h_refund_concurrency.integration.test.ts`、`tests/integration/db/group_h_migration_asserts.integration.test.ts`、`tests/integration/db/helpers/group-h-refund-fixtures.ts`、`tests/integration/db/helpers/group-g-allowlist.ts`
- Modify（正本）: `docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`docs/03_BasicDesign/data/er.md`、`docs/04_DetailDesign/pages/16_admin.md`、`docs/04_DetailDesign/sequence/order-administration.md`、`docs/04_DetailDesign/states/order-payment.md`、`docs/06_Operations/db-migrations.md`
- Regression（読取・実行のみ。期待の変更が必要なら理由を個別に記録）: `tests/integration/db` 全体。直接影響する一覧はStep 5。
- Read: `20261012235910_order_return_records.sql:111`、`20261023211425_group_g1_allocation.sql:4626`、`20261029130400_group_h_discounts_refunds.sql:341,365,2178,2692`（すべて `supabase/migrations/` 内）。変更は新移行だけ。

**Interfaces:**
- Consumes: 既存の public/private `admin_receive_return(_return_id uuid,_actor_id uuid,_actor_can_refund boolean,_request_key uuid,_units jsonb,_exchange_overrides jsonb,_refund_choice text,_refund_amount integer,_refund_shipping_amount integer,_note text,_notify_customer boolean,_sent_back_message text,_sent_back_carrier text,_sent_back_tracking_number text)`。
- Produces: 同じ14引数・既定値なし・同じ `RETURNS TABLE(receipt_id uuid,return_status text,refund_id uuid,refund_amount integer,refund_status text,exchange_order_item_ids uuid[],fee_due_amount integer,shop_notice_enqueued boolean,replayed boolean)`。public入口の署名・OID・ACLを保ち、privateをCREATE OR REPLACEする。
- Produces: `_units[]` の `{return_line_id,disposition,quantity,refund_choice?: 'now'|'consult'}`。旧本文の省略は親now/consultで補う。親mixedで返金明細の選びが省略/NULLなら `RETURN_ARGUMENT_INVALID / 22023`。新本文は全返金明細へ選びを送り、親をGlobal Constraintsの規則で導出する。DBも実効解決後に導出し直し、不一致は同じ記号で拒否する。非返金明細はNULLへ正規化する。
- Produces: `order_return_receipt_lines.refund_choice text NULL`、`order_return_receipt_lines_refund_choice_check`。NULLを許して過去明細を保持し、非NULLは受取の返金明細にだけ許す。既存 `order_return_receipt_lines_line_key` を `UNIQUE NULLS NOT DISTINCT(receipt_id,return_line_id,disposition,resolution,exchange_method,refund_choice)` に置換する。
- Produces: 親の `order_return_receipts_refund_choice_check` に `mixed`、既存kindとのCHECKは維持。同じ返品行・状態でも選びが違えば明細2行。0円を終える `refund_waived` は今すぐの数量だけに付け、選び列はNULL。
- Produces: 指定額が `min(注文残額,G今+S)` を超えれば常に `RETURN_RECEIVE_REFUND_CAP_EXCEEDED / 22023`。両方超過でもこの記号を既存の `RETURN_REFUND_AMOUNT_INVALID` より先にする。理由: 同じ入力を上限のどちらが小さいかで別の断りにしないため。型・負数・S>額・送料残額超過は既存の検査を先に行う。P9外は `RETURN_FORBIDDEN / 22023`、同一キー異内容は `RETURN_REQUEST_MISMATCH / 22023`。末尾assertは `RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED / P0001`、DETAILは `rr_schema` / `rr_receive` / `rr_amounts` / `rr_acl` / `rr_writers`。
- Produces: `private.return_receive_amounts(_return_id uuid) RETURNS TABLE(return_line_id uuid,receive_refund_amounts_by_count integer[])`（STABLE、読取のみ）。`private.return_detail_json(_return_id uuid) RETURNS jsonb` の各linesへ `receive_refund_amounts_by_count` を追加。Hはその返品行が確保した今回受取可能な着の安い順の累計、前の受取分・他のactive claimを除外する。Hの記録のない旧行・交換品行はNULLで従来の注文商品共通配列へ戻す。既存JSONのキーと `group_h_return_amounts(uuid)` の戻り型は変えない。
- Produces（新移行の同署名CREATE OR REPLACE一覧）: `private.group_h_receiving_amount(_return_id uuid,_order_item_id uuid,_quantity integer,_effective jsonb) RETURNS integer`、`private.group_h_return_refund_slices(_return_id uuid,_order_item_id uuid,_quantity integer,_request_key uuid DEFAULT NULL) RETURNS TABLE(return_line_id uuid,quantity integer,unit_offset integer)`、`private.group_h_return_amounts(_return_id uuid) RETURNS TABLE(return_line_id uuid,refund_amounts_by_count integer[],refund_waiting_amount integer)`、`private.group_h_claim_refund_units(_refund_id uuid,_order_item_id uuid,_quantity integer,_before_shipment boolean,_return_line_id uuid DEFAULT NULL) RETURNS integer`。
- Produces（同じ一覧の続き）: `private.group_h_return_refund_amount(_return_id uuid,_order_item_id uuid,_quantity integer,_request_key uuid DEFAULT NULL) RETURNS integer`。受け取り番号なしでは、slicesと同じ行順・容量で着を直接仮割当して額を出す。自分の確保を先、空きは安い順（同額はunit_index）の共通キューから取り、前の行へ割り当てた空きの数だけ次の行では飛ばす。空き専用の消費位置を1回の返金×注文商品内で持ち、既存確保を飛ばすoffsetとは混ぜない。各着の識別子を1回だけ合計し、各行へ `group_h_return_line_amount(...,0)` を独立に呼んで同じ空きを足さない。受け取りありの額計算と旧注文へのfallbackは保つ。group_h_return_line_amountの署名・本文は変えない。
- Produces（同じ一覧の続き）: `private.record_group_g_refund_result(_refund_id uuid,_stripe_refund_id text,_stripe_status text,_stripe_pending_reason text,_stripe_failure_reason text,_customer_action_expires_at timestamptz,_payment_method_type text,_reference_number text,_reference_type text,_operation text,_orders uuid[],_before jsonb) RETURNS TABLE(refund_id uuid,order_id uuid,status text,newly_accepted boolean,newly_failed boolean,order_status public.order_status,refunded_amount integer,rereserve_shortage integer,email_enqueued boolean,exception_id uuid)`。受け取りありのerror取り直しは、そのrequest_keyの実効now明細の行を先にし、now数を上限にする。受け取り番号なしの返品返金は、まずその返金が元々結んでいてerror後もreturn_line_idが残る着の行から取り直す。その既存結びの再利用は、結ばれた総数が数量に達していても許す。足りない分だけ下表と同じ候補・優先順で空きを割り当てる。空きを数えるのは結ばれた着の総数が数量未満の行だけで、数量いっぱいの先の行へ空きを追加しない。`group_h_claim_refund_units` の選択も同じ容量に制限する。返品に結び付かない通常返金（return_id IS NULL）の経路と、実際の競合の例外記録は保つ。
- Produces（同じ一覧の続き）: `private.group_h_return_unit_dispositions(_return_line_id uuid) RETURNS TABLE(unit_index integer,paid_amount integer,exchange_unit boolean,released_unit boolean)`、`private.group_h_release_return_units(_return_id uuid) RETURNS void`、`private.group_h_release_completed_return_claims() RETURNS trigger`。release本体の解放規則はH5のまま同署名で再掲し、`admin_receive_return` の `begin_order_refund_core` 後、同じ取引・G共通鍵の中でreleaseを1回追加する（レビュー追記3の最小修正）。0円のdispositionsはnowへ当てた安い着だけを終え、相談の高い着は残す。旧NULL・交換・未着・お返しを保つ。
- Produces: `group_h_return_amounts` は注文商品ごとに、その返品の返金未確保の着と空きの着を重複なく安い順（同額はunit_index）に並べ、待ち数だけ加算する。別のactive claim・交換済み・解放済みを除く。空きの着の行への割当は、下表の受け取り番号なしslicesと同じ容量・優先順で読取用に仮割当し、待ち額もその割当で求める（この読取では着を更新しない）。印の個別待ち数だけで配分先を決めない。未処理の累計配列の意味は維持し、待ち用に使った着を重ねない。slicesと共有する空きの割当は1回だけ数え、合計は注文商品ごとの待ち数までにする。
- Produces（Hの記録が無い旧注文）: 注文商品ごとにnow数N・consult数Cを合算し、`G今=return_units_amount(item,N,0)`、`G相=return_units_amount(item,N+C,0)-return_units_amount(item,N,0)`（同じ意味の `_offset=N` も可）。画面も共通累計配列 `A[N-1]` と `A[N+C-1]-A[N-1]`（0点は0）でそろえ、返品行ごとに丸めない。
- Produces: 通知予定は `now` を含む正額なら返金メール経路、0円・失敗は既存の受取メール経路。権限なしでconsultを1点以上含めば `return_refund_pending_shop` を1件。既存の返金結果関数の控除戻し・通知fallbackを利用する。

Hの「何を数えるか」は次で固定する。N/Cは当該返品行・当該受け取りの実効now/consult数。Bは当該行の残るH確保のうち、未処理・交換・免除を除いた返金用の数（取り直す当該返金の着も含み、別のactive返金の着は除く）。W0は今回より前の待ち数。明細作成後の初回・取り直しとも `W0=max(B−N−C,0)`。行順の印の `p.refund_waiting` をW0へ流用しない。旧NULL明細は親now/consultで補って数える。

| 関数・時点 | 数える数量・飛ばす数量 |
| --- | --- |
| receiving_amount（明細作成前） | nowのcapacity=N、offset=W0。consultのcapacity=C、offset=W0+N。内部 `_effective` の要素へ `refund_choice` と `unit_offset` を付け、各群を別に渡す。旧要素にoffsetが無ければ従来のW0 |
| slices（受け取りあり・返金開始） | capacity=今回nowのNだけ（新たに返金可能になった数量まで）。unit_offset=max(B−N−C,0)=W0。consultをcapacityへ入れないが、offsetではNとCの両方を引く |
| claim（order_refund_lines作成前） | v_received=N+C、v_skip=max(B−N−C,0)。slicesのunit_offsetと同じ着を取る |
| claim（受け取りあり・error→pending/succeededの取り直し） | 対象は保存済みnow数N、v_skip=max(B−N−C,0)。Bにはまだ未確保の当該nowもある。nowを除いた待ち数B−Nから、同じ受け取りのCも引く。行順の印のW−Cへ置換しない（別行Bでは印の待ち1でも過去の待ちは0） |
| slices（受け取りなし・相談後の返金） | 印の個別待ち数で行を選ばず、残る返金可能な確保と空きを使う。空き（return_line_id=NULL）を結ぶ候補は、同じ返品・同じ注文商品の返品行で、結ばれた着の総数がl.quantityより少ない行だけ。総数は返金済みの着も含む。候補は、状態の芯のrefund_coveredが自分に結ばれて返金済みの着の数より多い行（印が逆の行）を先にし、その後created_at,idの昇順。各行の空きの割当数はl.quantity−結ばれた着の総数まで。capacityは残る返金可能な確保＋この規則で割り当てた空きの数。unit_offset=0は既存確保用で、空きの行間消費位置の代わりにはしない。額計算とclaimの両方で前の行に割り当てた空きの着を除外し、合計は注文商品ごとの待ち数まで。どの行も数量を超えない |
| return_refund_amount（受け取りなし） | 上のslicesと同じ仮割当を行い、選んだ着の識別子で額を合計する。空き専用キューの消費位置を行間で引き継ぎ、次の行は前の行が使った空きを飛ばす。自分の確保はこの空きの消費位置で飛ばさない。claimが同順で取る着と数量・額を一致させる |
| result / claim（受け取りなし返金のerror→succeeded） | 元の返金が結んでいた、error後もreturn_line_idが残る着の行を先に取り直す。既存結びを再利用した後の不足分だけ空きを使う。空きを追加できる行は総結合数<l.quantityだけ、順番は上の印の逆転優先→created_at,id。別の受け取りのreleaseで元の着が空きへ戻っていても同じ規則を使う。選ぶたびに空き・各行の残容量を更新し、前の行の消費を後の行で数えない |
| return_amounts / release | amountsは上のslicesと同じ候補・容量・優先順で空きを仮割当し、残る確保＋割り当てた空きから待ち額を安い順に合計。releaseはH5の本体を保持し、明細INSERT時・結果記録後に加えて返金開始直後にも呼ぶ |

DBの検査は親文字列で分岐せず、実効明細のhasNow/hasConsultで決める。H5の対応箇所を次のように置き換える。

| H5の行 | 検査・記録 |
| --- | --- |
| 2224〜2226 | 指定額・送料はhasNowの時だけ。mixedも通す。権限なしの指定額拒否は別に維持 |
| 2297 | hasNowかつ返金権限なしならP9の返品条件を検査 |
| 2432〜2440 | hasNowかつ額/送料指定ありで、今回nowの返金可能数が指定now数より減ったらSTATE_CONFLICT。consult数を比較へ混ぜない |
| 2442 | 実効返金明細があるのに選びnone/未解決なら拒否。明細の選びありならそこから親を導出 |
| 2531 | 返金権限なし、かつhasConsultなら店への知らせを1件 |
| 親保存・API監査 | hasNow/hasConsultからnow・consult・mixed・noneを導出。監査も同じ値。生の明細・メモは追加しない |

- [ ] **Step 1: 失敗するDB試験を書く。** 範囲外の結合試験名はFREQのACで始める。以下は入力とassertの抜粋。レビュー旧STATE-ADMIN-002のHケースはAC-07/08へ割り当てる。

```ts
test('FREQ-641-AC-10: 同じ返品行と状態の2点をnowとconsultの2明細にする');
// 各999円、p=10、送料0、固定費用0。now=1点、consult=1点。
expect(receipts).toHaveLength(1);
expect(receipts[0].refund_choice).toBe('mixed');
expect(lines.map(x => [x.refund_choice, x.quantity]).sort()).toEqual([['consult', 1], ['now', 1]]);
expect(refunds).toHaveLength(1);
expect(refunds[0]).toMatchObject({ amount: 900, return_fee_deduction: 99 });
expect(returnRow).toMatchObject({ fee_pending_deduction: 99, fee_due_amount: 0, status: 'open' });

test('FREQ-641-AC-09: 上限ちょうどは受け上限1円超過は取引を残さず断る');
// Hの確保[17000,20000]、now1/consult1、p=10、S=500、注文残額50000。
expect(calculatedAmount).toBe(15800);
expect(acceptedAmount).toBe(17500); // min(50000,17000+500)
expect(overCapError).toMatchObject({ message: 'RETURN_RECEIVE_REFUND_CAP_EXCEEDED', code: '22023' });
expect(afterRejected).toEqual(beforeRejected); // receipt/refund/stock/outbox/claimに追加なし
// 注文残額16000・G今17000・S500で17501を指定し、両上限超過も同じ記号。
expect(bothCapsError.message).toBe('RETURN_RECEIVE_REFUND_CAP_EXCEEDED');
expect(orderCapOnlyError.message).toBe('RETURN_RECEIVE_REFUND_CAP_EXCEEDED'); // 16001
// S=501かつ返せる送料500は、既存の送料検査で先に拒否。

test('FREQ-641-AC-09: 結果不明の同一キーは順序を変えても再送となり選びを変えると拒否する');
expect(reordered).toMatchObject({ receipt_id: first.receipt_id, refund_id: first.refund_id, replayed: true });
expect(changedChoiceError.message).toBe('RETURN_REQUEST_MISMATCH');
expect(operationCount).toBe(1);
// 選びを省いた旧本文の再送も同じ指紋。移行前の旧本文の指紋と既存行を更新しない。

test('FREQ-641-AC-10: Hの同じ行では17000の着をnowへ20000の着をconsultへ残す');
expect(nowClaimAmounts).toEqual([17000]);
expect(consultRemainingAmounts).toEqual([20000]);
expect(detailLine.receive_refund_amounts_by_count).toEqual([17000, 37000]);

test('FREQ-641-AC-07: 同じ注文商品の古い相談行に返金済みの印が付いても額と後の返金は合う');
// 先に作った返品行Aの確保17000をconsult、後のBの確保20000をnow、手数料0。
expect(nowAmount).toBe(20000);
expect(progress.map(x => [x.refund_covered, x.refund_waiting])).toEqual([[1, 0], [0, 1]]);
expect(waitingAmountWhileAwaitingResponse).toBe(17000);
expect(attemptConsultWhileAwaiting.message).toBe('AWAITING_REFUND_EXISTS');
expect(laterRefundAmount).toBe(17000); // admin_refund_return。単位不一致を起こさない
expect(laterConsultClaimLineIds).toEqual([lineAId]); // Bは20000の着で数量1に達している
// 後の相談返金IDをmark_order_refund_errorでerrorにし、record_group_g_refund_resultでsucceededへ戻す。
expect(laterConsultRefundStatus).toBe('succeeded');
expect(laterConsultRecoveredClaimAmounts).toEqual([17000]);
expect(laterConsultRecoveryThrown).toBeNull();
expect(laterConsultUnitMismatchExceptionCount).toBe(0);
expect(totalRefunded).toBe(37000);

test('FREQ-641-AC-07: 3行の相談2点へ空きを割り当てても同じ着を重ねて数えない');
// 同じ注文商品でA1数量1/17000、A2数量1/20000を相談、B数量2/[23000,26000]を今すぐ。
// Bの2点を1点ずつ別受け取りで返金して成功させ、A1/A2の印が逆になり両方の着が空きになる。
// 手数料・送料0。受け取り番号なしのadmin_refund_returnで相談2点をまとめて返す。
expect(consultBeginThrown).toBeNull();
expect(consultRefundAmount).toBe(37000); // 17000を2回足した34000ではない
expect(consultClaimAmounts).toEqual([17000, 20000]);
expect(consultClaimLineIds).toEqual([lineA1Id, lineA2Id]);
expect(new Set(consultClaimUnitKeys).size).toBe(2);
expect(unitMismatchExceptionCount).toBe(0);
expect(totalRefunded).toBe(86000);

test('FREQ-641-AC-07: 未返品の高い予備の着があっても相談返金の元の結びを先に取り直す');
// 着の値段の順は行のidの順と同じ（P<A<B、先の行が安い）。承認の関数で確保し、着を直接更新しない。
// 同じ注文商品4点。P数量1/12000は返金済み、A数量1/17000は相談、B数量1/20000は今すぐ。手数料・送料0。
// 返品していない一番高いU=24000が空きに残る。Bの成功後、Aの17000も空きになる。
// 後の相談返金は17000をAへ結ぶ。mark_order_refund_error→record_group_g_refund_resultでsucceededへ。
expect(originalConsultClaimAmounts).toEqual([17000]);
expect(recoveredConsultClaimAmounts).toEqual([17000]);
expect(recoveredConsultUnitKeys).toEqual(originalConsultUnitKeys);
expect(recoveredConsultClaimLineIds).toEqual([lineAId]); // 数量いっぱいのPへU=24000を追加しない
expect(consultRecoveryThrown).toBeNull();
expect(consultRefundStatus).toBe('succeeded');
expect(unitMismatchExceptionCount).toBe(0);
expect(totalRefunded).toBe(49000);

test('FREQ-641-AC-07: 相談返金のerrorと成功の間に別の受け取りのreleaseが入っても容量を守る');
// 着の値段の順は行のidの順と同じ（P<A<B、先の行が安い）。承認の関数で確保し、着を直接更新しない。
// P数量1/15000は返金済み、A数量1/17000は相談、B数量1/20000は今すぐ。予備の空きは無い。
// 同じ返品には別商品の未受取の交換品Cも残す。手数料・送料0。
// 後の相談返金17000をAへ結んだ後errorにし、Cを受け取る。そのtriggerのreleaseでAの着が空きへ戻る。
expect(consultUnitAfterInterveningReceipt.return_line_id).toBeNull();
// record_group_g_refund_resultでsucceededへ戻す。空きを足せるAを選び、P/Bへ追加しない。
expect(recoveredConsultClaimAmounts).toEqual([17000]);
expect(recoveredConsultUnitKeys).toEqual(originalConsultUnitKeys);
expect(recoveredConsultClaimLineIds).toEqual([lineAId]);
expect(consultRecoveryThrown).toBeNull();
expect(consultRefundStatus).toBe('succeeded');
expect(unitMismatchExceptionCount).toBe(0);
expect(totalRefunded).toBe(52000);

test('FREQ-641-AC-07: 同じ行のnow17000とconsult20000はerrorから成功へ戻っても同じ着を取る');
// 手数料・送料0。now返金をmark_order_refund_errorでerrorへ、record_group_g_refund_resultでsucceededへ。
expect(nowAmount).toBe(17000);
expect(recoveredClaimAmounts).toEqual([17000]);
expect(recoveryThrown).toBeNull();
expect(unitMismatchExceptionCount).toBe(0);
expect(unresolvedExceptionCount).toBe(0);
expect(laterConsultRefundAmount).toBe(20000);

test('FREQ-641-AC-08: 旧本文でA相談の後B今すぐの2回受け取りでも待ち額と再確保を保つ');
// 今の仕組みの再現。Aの確保17000、Bの確保20000。各本文は品ごとの選びを省略する。
expect(waitingAmountWhileAwaitingResponse).toBe(17000); // 0円へ落ちない
expect(attemptConsultWhileAwaiting.message).toBe('AWAITING_REFUND_EXISTS');
expect(waitingAmountAfterPendingOrSucceeded).toBe(17000);
// 別のsavepoint分岐でBの返金をerror→succeededへ戻す。
expect(recoveredClaimAmounts).toEqual([20000]);
expect(recoveryThrown).toBeNull();
expect(unitMismatchExceptionCount).toBe(0);
expect(unresolvedExceptionCount).toBe(0);
expect(laterConsultRefundAmount).toBe(17000);
expect(laterConsultClaimLineIds).toEqual([lineAId]);
// 後の相談返金IDもmark_order_refund_error→record_group_g_refund_resultでsucceededへ戻す。
expect(laterConsultRefundStatus).toBe('succeeded');
expect(laterConsultRecoveredClaimAmounts).toEqual([17000]);
expect(laterConsultRecoveryThrown).toBeNull();
expect(laterConsultUnitMismatchExceptionCount).toBe(0);
expect(totalRefunded).toBe(37000);

test('FREQ-641-AC-10: Hの無い旧注文のG相は累計の差で端数をそろえる');
// 単価1000円×3点、行割引1円、過去返金0、N=1,C=1、p=10%、固定費用0。
// return_units_amount(item,1)=1000、同(2)=1999。consult単独の1点=1000を使わない。
expect([nowGoods, consultGoods]).toEqual([1000, 999]);
expect([nowFee, consultFee, pendingFee]).toEqual([100, 99, 99]);

test('FREQ-641-AC-07: 固定費用の不足と返金失敗の控除戻しを混ぜない');
// G今100、G相2000、p10%、最初の固定費用240。F今=250、不足150、相談手数料200。
expect(pendingAfterReceive).toBe(350);
expect(feeDueAfterReceive).toBe(0);
// 正額へ調整して始めた返金のreturn_fee_deductionは100。既存相談の控除もある場合は加算前の値を別に保持。
expect(nowRefund.return_fee_deduction).toBe(100);
expect(pendingAfterFailure).toBe(450);
expect(pendingAfterRepeatedFailure).toBe(450);
expect(pendingAfterRecovered).toBe(350);
// 相談なしなら不足150はfee_due_amount。全相談なら固定費用もpendingへ。

test('FREQ-641-AC-07: 0円のnowはその1点だけを終えconsultの1点を待ちに残す');
expect(result).toMatchObject({ refund_id: null, refund_amount: 0, refund_status: 'waived', return_status: 'open' });
expect(refundWaivedQuantity).toBe(1);
expect(refundWaitingQuantity).toBe(1);
expect(customerMailKinds).toEqual(['return_received']);
// Hの同じ返品行の確保[0,20000]でも無料の着だけがnowで終わる。
expect(consultRemainingAmounts).toEqual([20000]);
expect(laterConsultRefundAmount).toBe(20000);

test('FREQ-641-AC-09: P9は品ごとに選べP9外のnowと権限なしの指定額を拒否する');
expect(p9Receipt.refund_choice).toBe('mixed');
expect(p9Receipt.actor_can_refund).toBe(false);
expect(p9ShopNoticeCount).toBe(1);
expect(nonP9Error.message).toBe('RETURN_FORBIDDEN');
// shop / not_required のnow、refund_amount=0、正の送料、exchange_overridesを個別に拒否。
```

AC-07の印が逆の同じ受け取り・3行への空きの割当・予備の空きあり・間に別の受け取りありと、AC-08の2回受け取りで、受取後・後の相談返金直後・その返金のerror直後・succeeded復帰後に、全返品行を対象に次を検査する。間に受け取りが入るケースは、そのrelease直後もsnapshotへ含める。3行のケースは受取後・相談返金直後を検査する。`boundCount` は `count(order_line_unit_amounts where return_line_id=l.id)`（返金済みも含む）、`dispositionCount` は `private.group_h_return_unit_dispositions(l.id)` の行数。0件の返品行も省略しない。

```ts
for (const snapshot of claimSnapshots) {
  for (const l of snapshot.returnLines) {
    expect(l.boundCount).toBeLessThanOrEqual(l.quantity);
    expect(l.dispositionCount).toBe(l.boundCount);
  }
}
```

さらにAC-09/10で、旧明細NULLの親now/consult補完、mixed＋返金明細NULLの拒否、新明細の選び非NULL、旧14引数RPCの9列、一意性・追記専用・ACLを固定する。親now/consult/mixed/noneの4通り、全体consult/noneにnow明細を付ける不一致、mixedで指定額あり、now対象減少、P9外への細工、consultを含む店への知らせを検査する。返金対象なし・交換→返金・既存返金の覆い・全consult・S>額・0額H・部分受取・在庫合算1回・再送outbox不増も保つ。

- [ ] **Step 2（controller）: 未実装の手元DBでREDを測る。** `npx.cmd jest tests/integration/db/return-receive-per-item.integration.test.ts tests/integration/db/return-receive-per-item-migration.integration.test.ts tests/integration/db/return_postgrest.integration.test.ts --runInBand`。接続は既存の手元専用設定を使い、値を表示しない。列不在・mixed不受理・上限未拒否に加え、AC-08は旧本文だけで独立して動かし、待ち額0と取り直しの不一致で落ちることを記録する。AC-07の場面1（3行）は空きの額の二重計上とclaim不一致。場面2（P12000/A17000/B20000/U24000）は旧取り直しがPへU24000を結び、保存額17000との単位不一致とPのboundCount=2>quantity1で落ちる。場面3（P15000/A17000/B20000）は間の受取/release後、旧取り直しがPへ空き17000を結び、額自体が合ってもPのboundCount=2>quantity1で落ちる。それぞれ承認による確保が成功した後のassertの失敗を証拠とし、準備の失敗・skip・接続失敗をREDに数えない。修正後は場面2/3とも回復[17000]・例外0、合計49000/52000になることをStep 5で確認する。
- [ ] **Step 3: 新移行にInterfacesの受け取りとHの修正を実装する。** controllerがCLIのhelpを確認して `npx.cmd supabase migration new return_receive_per_item` で1本生成し、正確なパスを計画と運用へ記入する。`<tsRR>`は既存移行末尾より後、会計計画3より前。全体mixedを入力検査へ追加し、明細を `(return_line_id,disposition,refund_choice)` 順で指紋へ含める。省略の旧本文は旧指紋を保つ。親・監査用のまとめ、hasNow/hasConsult検査、Hの表の数え方、G相の累計差、群別手数料、上限優先順を実装する。返金coreへnow分だけを渡した直後にreleaseする。受取・在庫・交換は分割しない。`rr_receive`で新しい返金明細の非NULL書込とmixed＋NULLの拒否、`rr_amounts`でHのoffset・取り直し・G相の式を検査する。
- [ ] **Step 4: H/Gの固定検査を維持する。** `withH5ReturnBaseline(client: PgClient, work: () => Promise<void>): Promise<void>` を `tests/integration/db/helpers/group-h-refund-fixtures.ts` に追加し、既存取引のsavepoint内で使う。対象はprivateの `admin_receive_return`、`return_detail_json`、`group_h_return_unit_dispositions`、`group_h_release_return_units`、`group_h_release_completed_return_claims`、`group_h_return_refund_slices`、`group_h_receiving_amount`、`group_h_return_amounts`、`group_h_claim_refund_units`、`record_group_g_refund_result`、`group_h_return_refund_amount` の11関数。各H5定義を `CREATE FUNCTION private.<name>(` または `CREATE OR REPLACE FUNCTION private.<name>(` から直後の独立行 `$$;` まで取り出す（trigger作成・末尾assert・GRANTは含めない）。先頭だけ `CREATE OR REPLACE FUNCTION` へ正規化し、同じ引数・戻り型・既定値で実行する。前後でregprocedure署名・OID・ACL・属性が同じこと、H5本文MD5で旧assertが通ることを検査し、finallyのROLLBACK TO SAVEPOINTで新本文へ戻す。H5ファイル・固定MD5は変えない。新移行の本文・属性・ACL・過剰overloadは別に検査し、追加したgroup_h_return_refund_amountの新本文も固定の検査対象に含める。`CURRENT_ALLOWLIST` の77本とOID集合を維持し、読取helperを加えない。AC-07/08の修正前再現にもこの隔離を使える。
- [ ] **Step 5（controller）: 最終SQLでGREENと全DB回帰を測る。** `npm.cmd run db:start` → `npm.cmd run db:reset` → Step 2 → `npx.cmd jest tests/integration/db --runInBand`。直接影響する `order_return_actions`・`order_return_records`・`order_return_receipts`・`order_return_request_reviews`・`order_refund_requests`・`order_refund_results`・`order_email_material_postgrest`・`group_g1_exchange_fee`・`group_g1_j19_compat`・`delivery_tracking_admin`・`order_state_transition_hardening`・Hのrefunds/outcomes/concurrency/migration_asserts・Gのreturn_exchange/writer_inventory・order_status_returnsを省かない。AC-07/08の修正前RED→最終SQLのGREENを別々に記録する。PostgRESTの14引数・9列・service_role成功/anon・authenticated拒否、items読取smokeの両者200を確認する。競合は `pg_blocking_pids` / `pg_locks` でG共通鍵待ちを観測し3連続。新assertは列・CHECK・一意性・追記専用・ACL・77 OID・芯の本文不変を検査する。
- [ ] **Step 6（実装時controller）: Filesと担当の正本だけコミットする。** `feat(returns): 受け取り明細ごとの返金選択と上限を記録する`

### Task 2: 窓口・型・store・serviceを品ごとの本文へつなぐ

**Files:**
- Modify: `src/app/api/admin/returns/[returnId]/receive/route.ts`、`src/lib/orders/returns/return-types.ts`、`src/lib/orders/returns/return-store.ts`、`src/lib/orders/returns/return-service.ts`、`src/lib/orders/returns/return-messages.ts`
- Modify/Test: `tests/unit/api/admin/order-return-money-routes.test.ts`（受取POST）、`tests/unit/api/admin/order-returns-routes.test.ts`（GETの新しい累計材料だけ）、`tests/unit/lib/orders/returns/return-store.test.ts`、`tests/unit/lib/orders/returns/return-service.test.ts`、`tests/unit/lib/orders/returns/return-messages.test.ts`、`tests/unit/lib/orders/returns/return-client.test.ts`、`tests/unit/lib/orders/returns/return-route-support.test.ts`
- Modify（正本）: `docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`docs/04_DetailDesign/pages/16_admin.md`

**Interfaces:**
- Consumes: Task 1の14引数RPC・9列・明細列と上限の拒否。既存 `resolveCanRefund(request)` の `canRefund`、認可失敗の応答。
- Produces: `ReceiveUnitRefundChoice = 'now' | 'consult'`、既存 `RefundChoice = 'now' | 'consult' | 'none'` を維持、`ReceiptRefundChoice = RefundChoice | 'mixed'` を親の送受信に使う。`ReceiveReturnInput.refundChoice` と `OrderReturnDetail.receipts[].refundChoice` とメール側は後者。品の型へmixedを入れない。
- Produces: `ReceiveUnitInput = { returnLineId: string; disposition: ReceiptDisposition; quantity: number; refundChoice?: ReceiveUnitRefundChoice }`。新本文は品ごとの選びとまとめの親を送る。親mixedで返金明細省略は拒否し、旧本文は従来のnow/consult既定へ解決する。重複キーは返品行・状態・解決した選び。既存のunits最大100、quantity1..999を維持する。
- Produces: `receiveReturn(store: ReturnStore,input: ReceiveReturnInput): Promise<ReceivedReturn>` が `refundChoice` を `refund_choice` に変換、省略は省略のまま渡す。読取は `OrderReturnLineDetail.receiveRefundAmountsByCount?: number[] | null` を追加する。storeは常に配列かNULLへ変換し、旧JSON/既存の型fixtureの省略も画面ではNULLとして扱う。
- Produces: `receiveReturnAndRefund(deps: ReturnServiceDeps,input: Parameters<typeof receiveReturn>[1]): Promise<ReceiveReturnResult>`、POSTの成功 `data.{receiptId,returnStatus,refundId,refundAmount,refundStatus,feeDueAmount,replayed}`、返金だけ拒否・結果不明時のreceiptIdを維持する。
- Produces: `RETURN_ERROR_CODES` に `RETURN_RECEIVE_REFUND_CAP_EXCEEDED`、`return-messages.ts` は400・固定文「この受け取りの商品の額と送料までにしてください。」。金額X入りの画面の文はTask 3が見込みから作る。

- [ ] **Step 1: 単体のREDを書く。** 以下のassertを既存のservice/store/routeのfixtureに追加する。

```ts
test('DD-ADMIN-018 同じ返品行と状態でも選びが違う2要素を受ける');
expect(response.status).toBe(200);
expect(rpcArgs._units).toEqual([
  { return_line_id: lineId, disposition: 'restocked', quantity: 1, refund_choice: 'now' },
  { return_line_id: lineId, disposition: 'restocked', quantity: 1, refund_choice: 'consult' },
]);
test('DD-ADMIN-018 同じ返品行と状態と選びの重複やmixedという品の選びは400');
expect(duplicate.status).toBe(400);
expect(invalidChoice.status).toBe(400);
expect(service).not.toHaveBeenCalled();
test('DD-ADMIN-018 P9の判定をDBに任せ指定額0と正の送料と交換変更は権限で止める');
expect(p9Input.actorCanRefund).toBe(false);
expect(p9Input.refundAmount).toBeNull();
expect(forbidden.status).toBe(403);
test('DD-ADMIN-018 単一の受取結果と上限拒否を既存のHTTP形へ返す');
expect(capResponse.status).toBe(400);
expect(capBody.code).toBe('RETURN_RECEIVE_REFUND_CAP_EXCEEDED');
expect(unknownBody.receiptId).toBe(receiptId); // 非成功時は既存どおり最上位
expect(refundRequestCount).toBe(1);
test('DD-ADMIN-018 親のまとめと監査をnow consult mixed noneでそろえる');
expect(rpcArgs._refund_choice).toBe('mixed');
expect(auditMetadata.refund_choice).toBe('mixed');
expect(mixedWithoutLineChoice.status).toBe(400);
// nowだけ/consultだけ/返金なしも各親値を確認。不一致はDBの入力拒否を返し、成功の監査に残さない。
```

品の選び省略の旧本文、上限ちょうどはrouteが額比較せずDBへ渡すこと、`receiveRefundAmountsByCount` のH配列/旧NULL、親mixedの読取、P9でないnowのDB拒否、権限確認の401/503をfalseへ潰さないこと、consult/none/0円でproviderを呼ばないこと、同じ返金IDの再送キーを固定することも `DD-ADMIN-018` で試験する。

- [ ] **Step 2: REDを測る。** `npx.cmd jest tests/unit/api/admin/order-return-money-routes.test.ts tests/unit/api/admin/order-returns-routes.test.ts tests/unit/lib/orders/returns/return-store.test.ts tests/unit/lib/orders/returns/return-service.test.ts tests/unit/lib/orders/returns/return-messages.test.ts tests/unit/lib/orders/returns/return-client.test.ts tests/unit/lib/orders/returns/return-route-support.test.ts --runInBand`。新しいキーの欠落・重複拒否・新記号の変換のassertで落ちること。
- [ ] **Step 3: Interfacesの型・Zod・変換・辞書を実装する。** 全体のZodはmixedを受け、品はnow/consultだけ。DBが実効解決と親の一致を確認した成功結果について、監査の `refund_choice` もその親値にそろえる。store/serviceは単一結果を保ち、窓口は商品の額・P9の返品条件を推測しない。生のunitsやメモを監査へ足さない。
- [ ] **Step 4: Step 2を再実行しGREENを確認する。** `npx.cmd tsc --noEmit --incremental false` で他の `RefundChoice` 利用者の型も確認する。HTTPの返り値キーを増減しないことを既存試験で確かめる。
- [ ] **Step 5（実装時controller）: Filesと担当の正本だけコミットする。** `feat(returns): 品ごとの返金選択を受け取りAPIへ渡す`

### Task 3: return-calcと受け取りの画面を見本Aへ変える

**Files:**
- Modify: `src/lib/orders/returns/return-calc.ts`、`src/components/OrderReturnReceiveDialog.tsx`、`src/components/ReturnDialogParts.tsx`
- Modify/Test: `tests/unit/lib/orders/returns/return-calc.test.ts`、`tests/unit/components/OrderReturnReceiveDialog.test.tsx`、`tests/unit/components/OrderReturnReceiveDialogSupport.test.tsx`、`tests/unit/components/OrderReturnRefundDialog.test.tsx`
- Create/Test: `tests/unit/components/return-dialog-parts.test.tsx`、`tests/integration/ui/admin-return-receive.test.tsx`（`FREQ-641-AC-11` の画面結合）
- Modify（正本）: `docs/03_BasicDesign/ui/screen-list.md`、`docs/03_BasicDesign/ui/screen-flow.md`、`docs/04_DetailDesign/pages/16_admin.md`

**Interfaces:**
- Consumes: Task 2の入力型・`canRefund`・`source`・`returnMethod`・`receiveRefundAmountsByCount`、既存の `refundAmountsByCount`、注文の `refundableAmount/refundableShipping`。
- Produces: `ReceivePreviewLine = { returnLineId: string; orderItemId: string; refundAmountsByCount: number[]; receiveRefundAmountsByCount: number[] | null; nowCount: number; consultCount: number }`、`PerItemReturnRefundPreviewInput` はこのlinesと既存previewの `firstReceipt/hasExchangeInThisReceipt/firstExchangeReceipt/returnMethod/returnShippingFee/restockingFeePercent/exchangeFee/exchangeShippingFee/shippingRefund` および `refundableAmount: number`。
- Produces: `computePerItemReturnRefundPreview(input: PerItemReturnRefundPreviewInput): { nowItemsAmount: number; consultItemsAmount: number; nowFees: { returnShipping: number; restocking: number; exchange: number; exchangeShipping: number }; consultRestockingFee: number; refundAmount: number; refundCap: number; feePendingDeduction: number; feeDue: number }`。従来の `computeReturnRefundPreview` とその呼出し契約は維持する。
- Produces: Hは行ごとの累計配列でnowの先頭分・consultの続き分を読む。旧行は同じorderItemIdで数量を合算する従来式を使い、now累計と全選択累計の差でconsultを求める。旧配列を返品行ごとに足して端数を二重計上しない。
- Produces: `buildReceiveButtonLabel(input: { checked: number; remaining: number; refundUnits: number; exchangeUnits: number; sentBackUnits: number; refundChoice: ReceiptRefundChoice; refundAmount: number; actorCanRefund: boolean; nowUnits?: number; consultUnits?: number }): string`。親の型をmixedまで広げ、混在時だけ「受け取る（n点を ￥X 返金・m点は相談）」、単独時は既存の言葉を保つ。
- Produces: 各1点の状態へ `refundChoice: ReceiveUnitRefundChoice`（初期now、P9外の権限なしはconsult固定）。選んだ返金の品・交換→返金だけに、状態の直下で選ばせる。送信は返品行・状態・選び別に集約し、全返金明細の選びを必ず送り、親もnow/consult/mixed/noneに導出して1POSTする。
- Produces: `ReturnRefundFieldsProps` に `amountCap?: number; amountCapLabel?: string; preserveAmountOverMax?: boolean; amountError?: string | null` を追加。受け取りだけ `amountCap=preview.refundCap`、`amountCapLabel='上限 '+formatYen(preview.refundCap)` を渡し、ラベル「返金額」と別の表示「上限 ￥X」を出す。inputのmaxもamountCap。省略時は従来の `refundableAmount` と「返金額（返せる額: X）」を使うため、相談後の返金画面の上限・見出しはそのまま。`ReturnNumberInputProps` に `preserveOverMax?: boolean; error?: string | null` を渡し、受け取りだけtrueで超過を丸めず保持する。エラーは `aria-invalid` / `aria-describedby` で結ぶ。

- [ ] **Step 1: 計算・RTL・画面結合のREDを書く。** 以下を固定する。

```ts
test('DD-ADMIN-017 999円ずつの今すぐと相談は手数料を99円ずつに分ける');
expect(preview).toMatchObject({ nowItemsAmount: 999, consultItemsAmount: 999,
  consultRestockingFee: 99, refundAmount: 900, refundCap: 999, feePendingDeduction: 99, feeDue: 0 });
expect(preview.nowFees.restocking).toBe(99);
test('DD-ADMIN-017 旧注文の割引端数を累計差で相談分へ残す');
expect(preview).toMatchObject({ nowItemsAmount: 1000, consultItemsAmount: 999, consultRestockingFee: 99, feePendingDeduction: 99 });
expect(preview.nowFees.restocking).toBe(100); // Task 1と同じ単価1000×3・割引1・今1相1・p10%
test('DD-ADMIN-017 Hの同じ行の安い17000円を今すぐ分に使う');
expect(preview).toMatchObject({ nowItemsAmount: 17000, consultItemsAmount: 20000, refundAmount: 15800, refundCap: 17500 });
// p10%、S500、注文残額50000。返品行BだけがnowならBの確保額を読み、他行の安い着へ替えない。
test('DD-ADMIN-017 固定費用の不足は相談があればpendingなければdue');
expect(withConsult).toMatchObject({ feePendingDeduction: 350, feeDue: 0 });
expect(withoutConsult).toMatchObject({ feePendingDeduction: 0, feeDue: 150 });
test('DD-ADMIN-019 混在の見出しと上限とボタンを出す');
expect(screen.getByText('今すぐ返金（1点）')).toBeVisible();
expect(screen.getByText('額を相談（1点）')).toBeVisible();
expect(screen.getByText('上限 ￥17,500')).toBeVisible();
expect(amountInput).toHaveAttribute('max', '17500');
expect(screen.getByRole('button', { name: '受け取る（1点を ￥15,800 返金・1点は相談）' })).toBeEnabled();
test('DD-ADMIN-019 上限1円超過は丸めず警告し上限ちょうどに直すと押せる');
expect(amountInput).toHaveValue(17501);
expect(screen.getByText('この受け取りの商品の額と送料（￥17,500）を超えて入れられません。ほかの受け取りの分は、返品の画面の「額を決めて返金する」で返してください。')).toBeVisible();
expect(submit).toBeDisabled();
// 17500へ変更後はenabled、POSTのrefundAmount=17500。
test('DD-ADMIN-019 結果不明の後も同じrequestKeyと送信した品ごとの本文を再送する');
expect(secondPost).toEqual(firstPost);
expect(postCount).toBe(2);
test('FREQ-641-AC-11: P9の品ごとの選びとAPI本文と再読込をつなぐ');
expect(post.units.map(x => x.refundChoice)).toEqual(['now', 'consult']);
expect(post).toMatchObject({ refundAmount: null, refundShippingAmount: 0 });
test('DD-ADMIN-019 P9の受け取りは品ごとに選べ金額と送料の入力が無い');
expect(perItemRefundRadios).toHaveLength(4); // 2点×now/consult
expect(amountInputCount).toBe(0);
expect(shippingInputCount).toBe(0);
expect(p9Post.refundChoice).toBe('mixed');
test('DD-ADMIN-019 P9外で返金権限が無ければ選びと額が無く全品相談になる');
expect(perItemRefundRadios).toHaveLength(0);
expect(nonP9Post.units.every(x => x.refundChoice === 'consult')).toBe(true);
test('DD-ADMIN-019 案イの待ち額17000円を相談後の返金画面に出す');
// Task 1の印は逆・返事待ち/結果記録後の材料を使う。返事待ち中の実行拒否はDB試験へ。
expect(refundDialogPreview).toHaveTextContent('￥17,000');
expect(screen.getByRole('button', { name: '￥17,000 を返金する' })).toBeVisible();
expect(screen.queryByRole('button', { name: '返金しないで終える' })).not.toBeInTheDocument();
```

`DD-ADMIN-019` で次も試験する: 相談の品名と設計3-2の全文「返金待ちになります。額はあとで「額を決めて返金する」で決めます。」、非選択・交換・お返しには選びを出さない、交換→返金では出す、同じ行の2点を別々に選べる、権限あり/P9/非P9の3通り、P9には額/送料入力なし、単独now/consult/noneの既存ボタンの維持、混在0円、注文残額がG今+Sより少ない場合、S>額で送れない場合。ラジオは品ごとにgroup/nameを分け、キーボードと警告の関連付けも確認する。

- [ ] **Step 2: REDを測る。** `npx.cmd jest tests/unit/lib/orders/returns/return-calc.test.ts tests/unit/components/OrderReturnReceiveDialog.test.tsx tests/unit/components/OrderReturnReceiveDialogSupport.test.tsx tests/unit/components/OrderReturnRefundDialog.test.tsx tests/unit/components/return-dialog-parts.test.tsx tests/integration/ui/admin-return-receive.test.tsx --runInBand`。品ごとの選択と新しい見出し・上限のassertで落ちること。
- [ ] **Step 3: Interfacesの純粋計算・1点ごとの選び・見込み・表示を実装する。** 設計3-1〜3-3の見本Aを使う。P9の既存の計算額・注文残額の条件も今すぐ分で確かめる。金額はcanRefundの時だけ指定し、送料も同じ条件。結果不明は `useReturnOperation` の送信済み本文の保持を利用する。
- [ ] **Step 4: Step 2（SupportとRefundDialogも含む）を再実行してGREENを測る。** Supportの旧「受け取り全体の選び」期待を品ごとへ置換し、額入力なし・P9外全相談を固定する。`npx.cmd jest tests/unit/components/OrderReturnReviewDialog.test.tsx tests/unit/components/OrderReturnsDialog.test.tsx --runInBand` も回帰する。ReturnRefundFieldsの属性省略時は従来のラベルとmaxを維持する試験を含める。3幅と実DBの一致はTask 5。
- [ ] **Step 5（実装時controller）: Filesと担当の正本だけコミットする。** `feat(returns): 受け取り画面で品ごとの返金方法を選べるようにする`

### Task 4: メールは1通・受け取り履歴は1行で品の選びを伝える

**Files:**
- Modify: `src/lib/orders/email/order-email-compose.ts`、`src/lib/orders/email/order-history.ts`、`src/app/api/admin/orders/[id]/history/route.ts`
- Modify/Test: `tests/unit/lib/orders/email/order-email-return-material.test.ts`、`tests/unit/lib/orders/email/order-email-compose-returns.test.ts`、`tests/unit/lib/orders/email/order-history.test.ts`、`tests/unit/api/admin/order-history-route.test.ts`
- Modify（正本）: `docs/03_BasicDesign/api/api-spec.md`、`docs/04_DetailDesign/pages/16_admin.md`

**Interfaces:**
- Consumes: 明細の `refund_choice`・`resolution`、親の `ReceiptRefundChoice`、Task 1のoutboxの予定、既存 `receipt.refundWaived/refundNotAccepted`。旧返金明細NULLは親now/consultで補い、非返金明細へ相談の印を付けない。親mixedの返金明細NULLは不正な材料として読取・compose・履歴生成を拒否し、相談やnowへ推測で分類しない。
- Produces: `OrderEmailReturnReceipt` に `refundNowItems: OrderEmailReturnItem[]; refundConsultItems: OrderEmailReturnItem[]`、`refundChoice: ReceiptRefundChoice | null`。同じ品名でも選びが違えば別グループで数量をまとめる。
- Produces: `loadOrderEmailMaterial(store: Pick<SupabaseClient,'from'|'rpc'>,orderId: string,fulfillmentId: string|null = null,refundId: string|null = null,returnId: string|null = null,returnReceiptId: string|null = null): Promise<OrderEmailMaterial|null>` と `composeOrderEmail(material: OrderEmailMaterial,request: ComposeRequest): ComposedOrderEmail|null` の署名を維持する。
- Produces: `OrderHistoryReturnReceiptLine` に `resolution: ReturnResolution | null; refundChoice: ReceiveUnitRefundChoice | null`、history窓口のselectと変換も追加。`buildOrderHistory(input: BuildOrderHistoryInput): OrderHistoryResponse` の署名は同じ。receiveのdetailsへ「今すぐ返金 n点・相談 m点」を追加し、`refund_waived` 等を受取点数へ重ねない。

- [ ] **Step 1: 材料・文面・履歴のREDを書く。** 以下のassertと旧NULL明細の互換試験を `DD-ADMIN-020` で追加する。

```ts
test('DD-ADMIN-020 mixedの受取は相談の品にだけ相談の一文を添える');
expect(material.orderReturn.receipt.refundNowItems.map(x => x.quantity)).toEqual([1]);
expect(material.orderReturn.receipt.refundConsultItems.map(x => x.quantity)).toEqual([1]);
expect(refundEmail.text).toContain('この品は状態を確かめてから、あらためてご連絡します');
test('DD-ADMIN-020 mixedで今すぐが0円か失敗なら受取メールに両方の品を書く');
expect(receivedEmail.text).toContain('今すぐ返金');
expect(receivedEmail.text).toContain('額を相談');
expect(receivedEmail.text).toContain(consultItemName);
test('DD-ADMIN-020 受け取り履歴は1行で選びの点数を添える');
expect(entries.filter(x => x.kind === 'receive')).toHaveLength(1);
expect(receiveEntry.details).toContain('今すぐ返金 1点・相談 1点');
test('DD-ADMIN-020 旧NULLは親で読みmixedのNULLは材料生成を拒否する');
expect(legacyNowItems).toHaveLength(1);
expect(legacyConsultItems).toHaveLength(1);
expect(mixedNullMaterialRejected).toBe(true);
expect(mixedNullHistoryRejected).toBe(true);
```

既存の返金メールへ受け取りの内容・交換・お返しが入ること、相談後の返金メールには受取を再添付しないこと、0円の免除履歴があっても「返品の受け取り」は1行であることも確認する。メールの通数は単体composeの呼出し数で証明せず、Task 1のoutbox・Task 5の手元workerの証拠で確かめる。

- [ ] **Step 2: REDを測る。** `npx.cmd jest tests/unit/lib/orders/email/order-email-return-material.test.ts tests/unit/lib/orders/email/order-email-compose-returns.test.ts tests/unit/lib/orders/email/order-history.test.ts tests/unit/api/admin/order-history-route.test.ts --runInBand`。品ごとの分類・新細目がないことで落ちること。
- [ ] **Step 3: Interfacesのselect・型・材料・文面・履歴を実装する。** 正額の今すぐは既存返金メールに受け取りを含める。0円・失敗は受取メール。同じ受け取りに相談があっても別のお客様メールをenqueueしない。相談の一文以外の細かい文面は現在の文体へ合わせる。
- [ ] **Step 4: Step 2を再実行してGREENを測る。** メール材料の欠落・読取エラー・旧now/consult・お返しだけの既存試験も維持する。外部へのメール送信成功とは報告しない。
- [ ] **Step 5（実装時controller）: Filesと担当の正本だけコミットする。** `feat(returns): 混在する受け取りのメールと履歴をまとめる`

### Task 5: 新規FR-ADMIN-164と既存の受け取りE2Eを3幅で確かめる

**Files:**
- Create: `e2e/FR-ADMIN-164-return-receive-per-item.spec.ts`
- Modify: `e2e/FR-ADMIN-085-return-receive-refund.spec.ts`、`e2e/FR-ADMIN-087-return-consult-refund.spec.ts`、`e2e/FR-ADMIN-090-return-support-receive.spec.ts`、`e2e/FR-ADMIN-096-customer-return-support-refund.spec.ts`、`e2e/return-test-utils.ts`、`e2e/return-request-test-utils.ts`
- Modify（正本）: `docs/02_Requirements/requirements.md`、`docs/03_BasicDesign/api/api-spec.md`、`docs/04_DetailDesign/pages/16_admin.md`
- Read/Regression: `e2e/FR-ADMIN-086-return-partial-missing-cancel.spec.ts`、`e2e/FR-ADMIN-088-return-exchange.spec.ts`、`e2e/FR-ADMIN-089-return-sent-back.spec.ts`、`e2e/FR-ADMIN-093-return-guards-history.spec.ts`、`e2e/FR-ADMIN-127-discount-refund-amounts.spec.ts`。設計で変わらない期待は維持する。

**Interfaces:**
- Consumes: Task 2の本文・同じHTTP結果、Task 3の各品のラジオ・見出し・エラー・ボタン、Task 4の履歴・メール材料、手元DBの既存fixture/worker。
- Produces: 既存の `viewports`（390/768/1280）を使う `FREQ-641-AC-01`〜`AC-06`。fixtureのPOST helperも `units[].refundChoice` を任意で受け、旧呼出しを壊さない。役割のfixture名を権限判定の実装に使わない。

- [ ] **Step 1: E2Eの失敗する期待を書く。** `e2e/` と `docs/superpowers/plans/` を2026-11-06に検索し、会計の予約128〜163の次で164が空いていると確認した。実装開始時も両方を検索する。以下を全3幅に登録し、試験名を `FREQ-641-AC-NN: …` で始める。ファイル番号FR-ADMIN-164と要求IDを混同しない。

```ts
test('FREQ-641-AC-01: 同じ受け取りの2点を1点返金と1点相談にする');
expect(receiptRows).toHaveLength(1);
expect(receiptRows[0].refund_choice).toBe('mixed');
expect(refundRows).toHaveLength(1);
expect(refundRows[0].amount).toBe(900); // 999円2点、p10%、送料0
expect(waitingQuantity).toBe(1);
expect(historyReceiveRows).toHaveLength(1);
expect(customerOutboxRows).toHaveLength(1);
test('FREQ-641-AC-02: 今すぐ分と送料の上限を超えると押せずちょうどなら返せる');
expect(submitOver17500).toBeDisabled();
expect(postCountBeforeFix).toBe(0);
expect(savedRefundAmount).toBe(17500);
test('FREQ-641-AC-03: 返金権限なしのP9でも品ごとに選べ金額入力は出ない');
expect(refundAmountInputCount).toBe(0);
expect(shippingAmountInputCount).toBe(0);
expect(p9ShopNoticeCount).toBe(1);
test('FREQ-641-AC-04: 同じ注文商品の別行で印が逆に付いても1点分を返し相談分が残る');
expect(nowAmount).toBe(20000);
expect(waitingQuantity).toBe(1);
expect(waitingAmountWhileAwaitingResponse).toBe(17000);
expect(refundDialogPreview).toHaveTextContent('￥17,000');
expect(refundDialogButton).toHaveAccessibleName('￥17,000 を返金する');
expect(laterConsultAmount).toBe(17000);
expect(actualConsultRefundAmount).toBe(17000); // 画面の見込みと実額が一致
test('FREQ-641-AC-05: 今すぐ0円と相談を1回受け取り相談だけを待ちに残す');
expect(refundRows).toHaveLength(0);
expect(refundWaivedQuantity).toBe(1);
expect(waitingQuantity).toBe(1);
expect(customerOutboxKinds).toEqual(['return_received']);
test('FREQ-641-AC-06: P9外の権限なしには選びも金額入力も出ず全品相談になる');
expect(refundChoiceRadioCount).toBe(0);
expect(refundAmountInputCount).toBe(0);
expect(receiptRows[0].refund_choice).toBe('consult');
```

各試験で横はみ出しなし、ラジオ/ボタンの名前とfocus、1POST、メール1通相当のoutboxを確認する。AC-01は手元workerで返金メールに相談の一文、AC-05は受取メールの両グループを確認する。外部Stripe/SESではなく既存fixture/API差替えと手元DBの証拠であることを報告する。

- [ ] **Step 2（controller）: 旧画面に対するREDを測る。** `npx.cmd playwright test e2e/FR-ADMIN-164-return-receive-per-item.spec.ts --retries=0`。このStepをTask 3の実装より前に行い、品ごとの選びのassertが落ちる証拠を取得する。既存の題へIDを付ける場合も変更前後を `--reporter=json` と `PLAYWRIGHT_JSON_OUTPUT_NAME` で別のJSONへ保存し、`npm.cmd run trace:compare-e2e -- <前のJSON> <後のJSON>` で比較する。単なる登録・listはREDではない。
- [ ] **Step 3: helperと既存期待を接続する。** FR-085は行内の選びと今回上限、087は全相談と後段の返金待ち全部/注文上限、090はP9外の相談固定と店への知らせ、096はP9の各品の選び・額入力なしへ置換する。既存試験の業務入力・返金結果を勝手に変えない。
- [ ] **Step 4（controller）: 最終コードの本番ビルドで対象のGREENを測る。** 手元DBへTask 1の最終移行をreset済みと確認する。3000番の既存アプリを既存手順で停止し、`npx.cmd playwright test e2e/FR-ADMIN-164-return-receive-per-item.spec.ts e2e/FR-ADMIN-085-return-receive-refund.spec.ts e2e/FR-ADMIN-087-return-consult-refund.spec.ts e2e/FR-ADMIN-090-return-support-receive.spec.ts e2e/FR-ADMIN-096-customer-return-support-refund.spec.ts --retries=0`。webServerがbuild→startする。回帰はFilesの086/088/089/093/127と `FR-ACCOUNT-045-discounted-return.spec.ts` も含む。
- [ ] **Step 5（controller）: G-4の全件結果と今回の全件結果を比べる。** 次のコマンドでG-4のJSONを `flattenPlaywrightJson` により `{tests: TestOutcome[]}` へ変換し、前後のファイルを明示する。一部実行のJSONを全件基準と比較して合否を出さない。

```powershell
npx.cmd tsx -e "const fs=require('node:fs'); const {flattenPlaywrightJson}=require('./scripts/e2e/compare-baseline'); const source='.superpowers/sdd/2026-10-26-group-g4-orders/e2e-results-g4-full.json'; fs.writeFileSync('.superpowers/sdd/2026-11-06-return-receive-per-item/e2e-baseline-g4-flat.json',JSON.stringify({tests:flattenPlaywrightJson(JSON.parse(fs.readFileSync(source,'utf8')))}));"
$env:PLAYWRIGHT_JSON_OUTPUT_NAME='.superpowers/sdd/2026-11-06-return-receive-per-item/e2e-results-full.json'
npx.cmd playwright test --retries=0 --reporter=json
npm.cmd run e2e:compare -- .superpowers/sdd/2026-11-06-return-receive-per-item/e2e-baseline-g4-flat.json .superpowers/sdd/2026-11-06-return-receive-per-item/e2e-results-full.json
```

期待: 回帰0・新失敗0・欠落0（compareは欠落を終了コードへ含めないので別途確認）。既存題名の変更はStep 2の対応表で追い、欠落を隠さない。失敗は単独再実行・他幅・タイムアウト/値不一致を分け、実測件数だけを書く。終了後のE2E用アプリは既存規則どおり残す。
- [ ] **Step 6（実装時controller）: Filesと担当の正本だけコミットする。** `test(returns): 品ごとの受け取りと返金上限を3幅で確かめる`

### Task 6: 追跡範囲外の正本を各実装へそろえる

**Files:**
- Modify: `docs/02_Requirements/requirements.md`、`docs/03_BasicDesign/ui/screen-list.md`、`docs/03_BasicDesign/ui/screen-flow.md`、`docs/04_DetailDesign/pages/16_admin.md`、`docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`docs/03_BasicDesign/data/er.md`、`docs/04_DetailDesign/sequence/order-administration.md`、`docs/04_DetailDesign/states/order-payment.md`、`docs/05_Quality/tests/test-spec.md`、`docs/06_Operations/db-migrations.md`
- Generate: `docs/05_Quality/reports/traceability-report.md`（手編集しない）
- Modify（作業状態だけ）: `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`

**Interfaces:**
- Consumes: 各Taskの契約・RED/GREENの実測・設計3〜8章と、範囲外にする調整役判断。scope.json・領域別admin正本を今回拡張しない。
- Produces: `requirements.md` の6列の表で `FREQ-641` → `FREQ-641-REQ-01` → `FREQ-641-AC-01`〜`11`。現行最大552、会計計画の予約553〜640の次。AC-01〜06はTask 5、07は混在H/控除/0円、08は旧2回受け取りのH不具合、09はRPC/再送/P9/親まとめ、10は明細/額/ACL、11は画面結合（Task 1〜3）に対応する。
- Produces: `16_admin.md` の `DD-ADMIN-017`（計算）、`018`（窓口/store/service）、`019`（画面）、`020`（メール/履歴）。016は欠番として使わない。単体の先頭はこのDD、DB/画面結合/E2Eは対応するFREQ-AC。既存のコメント・IDを保持し、範囲内用のIMPL番号を今回まとめて振らない。
- Produces: ADRは範囲外なので不要。手数料の別々の切捨て・案イとHの修正・厳しい上限の理由は、この計画と該当ページの根拠へ残す。権限モデルは既存のままなのでarchitectureの更新は不要。変更する入力検査・監査はAPI/ページに記す。

- [ ] **Step 1: 実装前に採番と範囲外の根拠を確認する。** `rg -n 'FREQ-641|DD-ADMIN-01[7-9]|DD-ADMIN-020' docs/02_Requirements/requirements.md docs/04_DetailDesign/pages` と `rg -n 'FR-ADMIN-164' e2e docs/superpowers/plans` で他機能との衝突が無いことを確認する。ADMINのadmin-misc限定と設計8章の範囲外判断が一致することを読む。今回の計画・設計内の予約は衝突に数えない。
- [ ] **Step 2: 要求と試験対応を先に定義する。** requirementsの6列、上のAC-01〜11、DD-017〜020の入出力・正常/異常・状態/永続化・権限・試験観点をそろえる。試験仕様にファイル・試験名・入力・期待・担当・証跡参照を書く。文書の不足確認を業務試験のREDと呼ばない。
- [ ] **Step 3: 各Taskと同時に正本を更新する。** Task 1はERの列/CHECK/一意性、sequence/statesの混在・0円・失敗/取り直し、移行運用。Task 2はAPI本文/旧互換/監査とroute-inventory。Task 3はscreen-list/flowとDD-017/019。Task 4はDD-020と通知/履歴。Task 5はACの結果、Task 7は会計の前提。DB運用は新移行名・手元での適用/検証・失敗時停止を記し、本番適用は未許可とする。
- [ ] **Step 4: 範囲外の要求対応表と文書を確認する。** `npm.cmd run report:traceability` → `npm.cmd run validate-docs`。前者の出力とtest-specを突き合わせ、FREQ-641の全ACに試験ファイル・題名・実測結果が対応すること、後者が終了コード0であることを確認する。生成表だけでDB/E2E成功とせず、未実行は未実行と記す。範囲内用の検査やcoverageを完了条件へ持ち込まない。
- [ ] **Step 5（controller）: 手元での最終検証を記録する。** `npx.cmd jest tests/unit/lib/orders/returns tests/unit/components/OrderReturnReceiveDialog.test.tsx tests/unit/components/OrderReturnReceiveDialogSupport.test.tsx tests/unit/components/OrderReturnRefundDialog.test.tsx tests/unit/components/return-dialog-parts.test.tsx tests/unit/lib/orders/email/order-email-return-material.test.ts tests/unit/lib/orders/email/order-email-compose-returns.test.ts tests/unit/lib/orders/email/order-history.test.ts tests/unit/api/admin/order-return-money-routes.test.ts tests/unit/api/admin/order-returns-routes.test.ts tests/unit/api/admin/order-history-route.test.ts --runInBand`、`npx.cmd tsc --noEmit --incremental false`、`npm.cmd run lint`、`git diff --check`。Task 1・5は最終SQL/最終buildでの証拠を確認し、未実行を明記する。実装時の関連skillによる機械検証も実施し、DB/provider/mail実送信の証拠と混同しない。
- [ ] **Step 6（実装時controller）: 残った文書・生成物と作業状態だけコミットする。** `docs(returns): 品ごとの受け取りの要求と検証結果をそろえる`。Task 1〜5の対応文書は既にそれぞれのコミットに含まれていること。コード最終変更後の `graphify update .` とコミット後の `graphify hook status` を確認する。本番適用へ進めない。

### Task 7: 会計計画3の#17と受け取りの決定を品ごとへ読み替える

**Files:**
- Modify: `docs/superpowers/plans/2026-11-04-accounting-p3-returns-refunds.md`（後日の実装と同時。今回編集しない）
- Read: 同計画のTask 1・4・7・12・13・14、未確認 #16・#17、オーナー報告とセルフレビュー。

**Interfaces:**
- Consumes: Task 1の明細 `refund_choice`、親mixed、1受取/1返金、G今・G相・F今と相談控除、上限拒否。会計計画3の未実装の `private.accounting_record_return_arrival(_receipt_id uuid,_return_id uuid,_order_id uuid,_goods_amount integer,_fee_amount integer) RETURNS void` と `private.accounting_record_return_decision(_return_id uuid,_order_id uuid,_refund_id uuid,_decided_amount integer,_receipt_id uuid DEFAULT NULL,_fee_amount integer DEFAULT 0) RETURNS void`。
- Produces: 会計のarrivalは受け取りごとに1つ、decisionは今すぐ分のG今・F今を使い、consultを同時のdecisionへ含めない。`covers_amount` は `max(G今−F今,0)` と同計画の残未払金の上限、`_decided_amount` は返金総額からSを除いた額、`payable_delta = _decided_amount − covers_amount`。手数料を負けた差は既存の差の処理を保つ。
- Produces: 親mixedと明細の選び/旧NULL補完を計画の読取・writer・0円の分岐・試験・画面・運用・未確認/オーナー報告へ一貫して反映する。S18はこの新移行後の受け取り本体を基準にし、品ごとの処理をH5の旧本文で上書きしない。

- [ ] **Step 1: 置き換える試験の名前と期待を文書へ先に書く。** 旧「16,200円で成功し差+9,000」期待を次へ置換する。会計実装時に書く試験であり、このTaskではDB試験ファイルを作成・実行しない。

| 試験名（FREQ-578-AC-02） | 入力 | assertの抜粋 |
| --- | --- | --- |
| 受け取り1の相談分を受け取り2の今すぐへ上乗せすると上限で拒否される | 受取1:G10000/F1000/consult、受取2:G今8000/F今800/S0/指定16200 | `expect(error.message).toBe('RETURN_RECEIVE_REFUND_CAP_EXCEEDED')`、receipt2/refund2/decision2各0件、受取1の未払金9000 |
| mixedの決定は今すぐ分だけを覆い相談分を残す | 1受取:G今8000/F今800/G相10000/F相1000/返金7200 | `expect(arrivalCount).toBe(1)`、decisionはcovers7200/fee800/delta0、未払金9000 |
| 上限内で手数料を負けた差は既存どおり記録する | 同じmixedで指定8000（上限8000） | `expect(decision).toMatchObject({ covers_amount: 7200, payable_delta: 800 })` |

now0円+consultのdecisionはnow分だけのC/Fを戻し、相談分の未払金と手数料を残す試験も `FREQ-578-AC-08` に足す。#16の未確認や他の税理士判断は#17と一緒に「済み」にしない。

- [ ] **Step 2: 古い前提が残る箇所を列挙する。** `rg -n 'refund_choice|covers|G − F|16,200|16,200円|#17|未確認.*17|v_goods|v_fees' docs/superpowers/plans/2026-11-04-accounting-p3-returns-refunds.md`。Task 4の受取decision、Task 7の旧試験、#17以外にも同じ前提の記載があることを確認する。期待: 修正対象をIDと節で対応付けできること。過去のレビュー記録を成功の根拠にしない。
- [ ] **Step 3: 同計画を新しい前提に直す。** #17は「済み（2026-11-06承認の品ごとの上限で解消。実装/検証結果は今回機能の記録を参照）」とする。旧現象の説明は解消理由が分かる短い履歴へ縮める。arrivalのG/Fは到着した全返金対象のまま、decisionのG/Fだけを今すぐ分へ読み替える。正額と0円の両方を直し、同計画の会計関数が明細から対象を読む指示を付ける。新しい仕訳規則や本番適用の手順は足さない。
- [ ] **Step 4: 静的確認で修正の整合を確かめる。** Step 2の検索を再実行し、旧「16,200が成功する」期待がなく、上限8000で拒否・mixedのcovers7200・手数料を負けた差800が一致すること。`npm.cmd run validate-docs` と `git diff --check -- docs/superpowers/plans/2026-11-04-accounting-p3-returns-refunds.md`。期待: 文書の終了コード0。会計のDB/仕訳の成功は、会計計画3を実装する時の試験に残す。
- [ ] **Step 5（実装時controller）: このTaskのFilesだけコミットする。** `docs(accounting): 計画3の受け取り決定を今すぐ返金分へ限定する`

## 未確認事項

| # | 内容 | 確認先・停止条件 |
| --- | --- | --- |
| 1 | 本番DBへ適用する時期と許可（設計10章の未確認1） | オーナー。この計画は手元Supabaseの検証まで。本番適用・本番へ書く試験・本番への接続を実行しない |

未確認事項は1件。追跡範囲の扱いは調整役判断で解決済み。実DB・単体・PostgREST・E2E・外部返金・実メールは今回未実行であり、後日の各Taskで証拠を取る。

## セルフレビュー（writing-plans）

- **設計の全節:** 概要と1-1〜1-3はTask 1〜5。2章の比較はTask 6の根拠へ残す（追加実装なし）。3-1/2/3はTask 3・5、4-1〜4-4はTask 1・3、5-1〜5-3はTask 1・2・4、6章はTask 1・4・5、7章はTask 7、8章はTask 5・6、9章の列名/拒否名はTask 1・2、文面/余白はTask 3・4、10章はTask 6の運用と未確認1に対応。未対応の節はない。
- **Step:** 入力とassert→意図したRED→署名・式・固定値の実装→GREENを置いた。Hの初回と取り直しは数え方の表で固定し、既存不具合AC-08も独立してRED→GREENを取る。文書Taskは静的な不足確認と整合確認に限る。今回、計画中の実装・試験・コミットは実行しない。
- **型と名前:** 品はReceiveUnitRefundChoice、親の送受信はReceiptRefundChoice、旧呼出しはRefundChoiceを保持。DD-017/018/019/020、FREQ-641、FR-ADMIN-164、camelCase/snake_case、amountCap/amountCapLabel、上限の記号、単一結果、見込み材料をTask間で統一した。
- **Review Focus:** 5項目すべてがTask 1〜5のassertへ対応。AC-07の3行で空きの額と着の二重利用を防ぎ、予備の空き/間に受け取りの2ケースで取り直しの行・着・例外0を固定する。AC-07/08の数量上限・dispositions行数も保つ。受け取りあり/なしの取り直しは表で分け、通常返金の不変はreturn_id IS NULLに限る。
- **長さと範囲:** 関数本体の転記を避け、Hの数え方・署名・試験assert・コマンドを中心にした。追加は額関数1本とAC-07の3ケースに絞り、共通の数量/dispositions検査は1つの抜粋へまとめ、7 Taskに維持した。額関数とH5復元/固定本文検査の対象は同じ11関数。今回の変更先は計画だけ。設計書は保持し、会計計画3は後日のTask 7に残す。
- **静的確認と限界:** 相対リンク・Task/Step・レビュー1と2の対応、UTF-8/BOMなし/LF・差分の空白を静的に確認する。今回の計画以外の既存差分は変更前後のハッシュで不変を確かめる。DB・サーバー・業務試験・コミットは実行しない。

## レビュー1・2 の指摘と直した場所

| 指摘 | Task・Step（Interfacesの表を含む） |
| --- | --- |
| 重大1: Hの取り直しとoffset | Task 1 Step 1〜3・5。claim/resultを置換一覧へ追加、数え方の表、AC-07のnow17000/consult20000→error→succeeded→確保[17000]・例外0・後続20000 |
| 重大2（追記で中へ訂正）: 印の逆転で待ち額0 | Task 1 Step 1・3・5のamounts/release/slices、Task 3 Step 1・4の￥17,000表示/ボタン、Task 5 Step 1・4のAC-04で画面と実額の一致 |
| 重大3: 返品がADMIN追跡範囲外 | Task 6 Step 1〜4、Global Constraints、設計8章。範囲外のFREQと正本一式に置換し、未確認2を解消 |
| 中1: E2E番号128の会計との衝突 | Task 5 Step 1、Task 6 Step 1。e2e/と全計画を検索し、予約128〜163の次の164を採番 |
| 中2: POST試験ファイル | Task 2 Files・Step 1・2・4、Task 6 Step 5。order-return-money-routesを追加、order-returns-routesはGET材料だけ |
| 中3: Support画面試験の欠落 | Task 3 Files・Step 1・2・4。P9の品別選択/額入力なし、P9外全相談に期待を置換 |
| 中4: 全体の選び・DB検査・監査 | Task 1 Step 1・3のhasNow/hasConsult表、Task 2 Step 1・3、Task 3 Step 3。親/監査now・consult・mixed・noneを統一 |
| 中5: DB回帰の欠落 | Task 1 Step 5でtests/integration/db全体と直接影響一覧を指定 |
| 中6: E2E比較元 | Task 5 Step 5。G-4全件JSONをflattenPlaywrightJsonで変換、前後を明示し全件同士で比較 |
| 中7: ADRと旧注文のG相 | Task 6 InterfacesにADR不要の理由。Task 1 Step 1・3とTask 3 Step 1・3で累計差、割引端数1000/999・手数料100/99を固定 |
| 小1: DD-016欠番 | Task 6 Step 1・2、Task 2〜4。DD-017〜020で統一 |
| 小2: 両上限超過の拒否順 | Task 1 Step 1・3、Task 2 Step 1。min超過をCAP_EXCEEDEDへ統一（理由はTask 1 Interfaces） |
| 小3: mixed＋明細NULL | Task 1 Step 1・3のrr_receive、Task 2 Step 1・3、Task 4 Step 1・3。新明細へ必ず保存、不正なmixedは拒否、旧NULLは親で補完 |
| 小4: H5本文の戻し方 | Task 1 Step 4。CREATEから独立行$$;まで抽出、CREATE OR REPLACE化、署名/OID/ACL/本文の検査、savepointで復元 |
| 小5: 共通額欄の見出しと上限 | Task 3 Step 1・3・4。amountCap/amountCapLabelを受け取りだけへ渡し、max・表示・既存画面の属性省略を試験 |
| 追記1〜3: 今もある2回受け取りの不具合と最小修正（番号なしslicesはレビュー2再確認で済み） | Task 1 Step 1・2・3・5のAC-08。A相談→B今すぐを旧本文で再現し、待ち額17000/拒否AWAITING_REFUND_EXISTS・結果後17000・Bのerror→成功の確保[20000]/例外0を固定。番号なしslicesは下記の空きの行選択へ統一。後の相談返金もerror→成功の確保[17000]/例外0/合計37000と、全行の数量上限・dispositions行数を検査。芯は保ち、H読取・取り直しと返金開始後releaseで直す |
| レビュー2 中1: 空きを結ぶ行（再確認で一部。中2・3で補完） | Task 1 Interfacesの表・return_amounts、Step 1〜5。同じ返品/注文商品の数量未満の行だけへ、印の逆転優先→created_at,idで空きを割当。amountsと額関数も同じ割当で空きを1回だけ数える。取り直しは元の結びを先にし、不足の空きだけ同じ容量と順で補う。AC-07/08の数量/dispositionsに加えて、下記3ケースで残りを固定 |
| レビュー2再確認 中2: 複数行が同じ安い空きを額へ重複計上する | Task 1 Interfaces・Step 1〜5。group_h_return_refund_amountを同署名で作り直し、slicesと同じ仮割当の着を直接合計。空き専用の消費位置を行間で引き継ぐ。H5復元と新本文固定検査を11関数へ更新。AC-07の3行A1/A2/Bで相談37000・確保[17000,20000]・異なる着2つ・例外0を固定 |
| レビュー2再確認 中3: 番号なし返金の取り直しで数量いっぱいの先の行へ空きを結ぶ | Task 1 Interfacesのresult/claim表・Step 1〜3・5。元の結びの再利用を先、不足の空きは総結合数<quantityの行だけへ印の逆転優先→created_at,idで割当。AC-07の場面2はP12000/A17000/B20000/未返品U24000で回復[17000]・合計49000。場面3はP15000/A17000/B20000で別商品Cの受取/release後も回復[17000]・合計52000。元の着/行・例外0・全行のboundCount<=quantityとdispositions一致を検査 |
| レビュー2再確認（3回目）小1: 場面2/3の価格が承認時の確保順で作れない | Task 1 Step 1・2・5。両場面に「先のidの行が安い着を取る」と承認で準備する前提を追記。場面2はP12000/U24000、場面3はP15000に修正し、回復[17000]と合計49000/52000へ統一。修正前はPへの空きの誤結合で数量超過（場面2は額も不一致）となるassertのREDを残す。場面1の値は維持 |
