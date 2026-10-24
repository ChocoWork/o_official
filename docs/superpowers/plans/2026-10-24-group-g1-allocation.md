# グループ G-1 データモデル・品物状態・FIFO割当 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 注文の原本と決済契約を保ち、実割当を正とする品物状態・F/A/H・FIFO・初回入金日時を導入し、旧仕上がりと旧配送操作を停止する。

**Architecture:** 空き在庫の正は既存の `item_variants.stock_quantity` と追記台帳のままにし、仮確保と入金済み割当を新台帳で区別する。非公開DB関数が共通在庫lockの下で既存の入金・取消・返金・返品・交換を処理し、割当・在庫移動・状態履歴を同時保存する。清掃を先頭に含む1ファイルをSupabase MCPの1回のapply_migrationで原子的に適用し、旧行の補完は作らない。

**Tech Stack:** 現行の Next.js `^16.3.6`、React `^19.0.0`、TypeScript `^5`、Supabase Postgres 17、Zod `^4.3.6`、`pg`、`tsx`、Jest、React Testing Library、Playwright。依存を増やさない。

**Spec:** [承認済みG設計](../specs/2026-10-23-group-g-design.md)の6〜8章・9-1/9-3・11章・13章・14章G-1行と直後の適用条件。[現状調査](../specs/2026-10-23-group-g-research/facts.md)は索引とし、下記の最終定義を正とする。形式は[G-0計画](2026-10-23-group-g0-permissions.md)に合わせる。

## 概要

| Task | 中身 | 移行 | FREQ | E2E |
|---|---|---|---|---|
| 1 | 清掃節・空本体の原子性試験・清掃節単独レビュー | 1本を作成 | 524 | 手順/DB |
| 2 | モデル/列/履歴制約/個別grants | 同じ本体節へ追記 | 521・523基盤・540 | DB |
| 3 | 12状態の投影/状態履歴/TS | 同上 | 520・541 | 110はG-4 |
| 4 | 共通lock/FIFO/trigger/seed/最小DB fixture | 同上 | 521〜523基盤 | DB |
| 5 | 在庫RPC/API/画面/履歴/互換読取 | 同上 | 521〜523基盤 | 058/081/093書換 |
| 6 | 注文受付/H/未入金解放・取消/ゲスト注文RPC | 同上 | 521〜522・540〜541 | DB/単体 |
| 7 | 入金/paid_at/mismatch hold/両resolver | 同上 | 520〜522・535基盤・540〜541 | DB |
| 8 | 返金開始/結果/復元（既存7本） | 同上 | 520〜522・541 | DB |
| 9 | 取消申請/共通顧客lock（既存6本） | 同上 | 520〜522・541 | DB |
| 10 | 返品申請/作成/審査/取消（既存6本） | 同上 | 520・541 | DB |
| 11 | 返品受取/検品/返金額/未着/交換（既存6本） | 同上 | 520〜522・541 | DB |
| 12 | 交換手数料/保留解除（既存2本） | 同上 | 522・535基盤 | DB |
| 13 | 配送反映/版付き再送キー（既存2本） | 同上 | 520・541 | DB |
| 14 | 旧6RPC/7HTTP停止・store/履歴/文書・末尾assert | 1本を完成 | 524・540〜541 | 単体/DB |
| 15 | 旧UI/dialog撤去/client停止/単体 | — | 524・540〜541 | 123追加へ |
| 16 | DB helper/seed/既存DB suiteの最終整合 | — | 521〜524・541 | 清掃再試験/全DB |
| 17 | E2E helperの同取引allocation/実restock | — | 521〜524・541 | helper9本 |
| 18 | E2E全90ファイル処置/spec書換/検証 | — | 上記 | 123のG-1分 |
| 19 | 全体/Opus high/hash/直前確認/MCP適用/改名/push | — | — | 全件baseline比較 |

**決めたこと（ruling）**

- 範囲は設計14章のG-1行だけ。発注/受取/添付の表・画面、荷作り/発送票・出荷日列、注文の新一覧/詳細/CSV、割当入替の公開RPC/API/UIは作らない。FREQ-523は入替を表現できる台帳・履歴だけ。新しい在庫権限への切替はG-2で、G-1の既存商品在庫窓口はGET=`admin.items.read`、POST=`admin.items.manage`を維持する。G-0のACL初期値を再投入しない。
- 移行は **1本**：`supabase/migrations/<ts>_group_g1_allocation.sql`。独立した清掃節を第一節としてレビューし、全体を自身の `BEGIN; … COMMIT;` に入れる。本番はSupabase MCPの1回のapply_migrationで清掃/本体/末尾assertを同時適用する。途中版は本番適用しない。
- 入金割当は設計の **案A**。checkoutで取り分けたHは買い手本人のAへ変え、古い待ち注文へ渡さない。未確保分だけが通常FIFOへ参加する。交換のstock/makeは原本の購入時区分として残すが、stock交換も先取りせず元注文日による通常FIFOへ参加する。
- `finalize_order_from_checkout_draft(uuid,text,text,public.order_status,integer,text)` は `20260927100800_retire_legacy_order_rpcs.sql:10` でDROP済み。最終CREATEは `20260921121038_retire_item_stock_quantity.sql:325` だが、再作成しない。現在の確定経路は `place_order_from_checkout_draft → mark_order_paid / mark_order_awaiting_payment`。同様に `admin_ship_paid_order(uuid,uuid,text,text,boolean)` は `20261010122320_fulfillment_order_emails.sql:639`、旧 `apply_order_refund_projection` は `20261011223453_order_refund_results.sql:1286` でDROP済みで、復活させない。
- 設計は旧配送のmessageだけを固定しているため、SQLSTATEは **`55000`** に固定する。手動仕上がりは `MANUAL_COMPLETION_DISABLED / 55000`。旧HTTP入口は認可等の既存ガード後に410を返し、処理を行わない。停止の画面文言は設計に固定文がないためTask 14で本計画の値を定める。
- `paid_at timestamptz` は入金をDBに初めて記録した時刻 `clock_timestamp()`。Stripeイベント時刻や注文日時を代用しない。金額不一致でも実入金なら設定し、0円の正常決済も含む。取消済み注文への入金記録も対象だが、交換手数料の入金/免除/発送保留解除は対象外。
- 清掃はTask 1の永続31表に限定する。商品/variant/ACL/G-0履歴と注文外会計/全webhookイベント行/全メール共通dedupe/Storageを保持（未完了の注文連動webhookだけdeadへ）し、問い合わせの注文関連だけ外す。payout行を残し、影響分の集計だけ残存balanceから再計算してpendingへ戻す。全variant空き0と売切れ表示をowner確認に含める。

```mermaid
flowchart LR
  T1[1 清掃レビュー] --> T2[2 モデル] --> T3[3 状態] --> T4[4 FIFO] --> T5[5 在庫窓口]
  T5 --> T6[6 受付解放と関連付け] --> T7[7 入金保留] --> T8[8 返金] --> T9[9 取消申請]
  T9 --> T10[10 返品審査] --> T11[11 受取交換] --> T12[12 手数料] --> T13[13 配送]
  T13 --> T14[14 RPCとAPI停止] --> T15[15 UI撤去] --> T16[16 DB材料]
  T16 --> T17[17 E2E材料] --> T18[18 E2E仕様] --> T19[19 最終と本番]
```

## Global Constraints

- 実装はmaster。実装者はコミットせず、controllerがTaskのFilesだけを確認してコミットする。既存の `.claude/CLAUDE.md`・`package.json`・`.superpowers/` の差分を保持する。ブランチ/worktreeは作らない。
- 新規移行はローカルCLIの `migration new --help` を確認して実装時UTCの `<ts>` で1本作る。現在末尾 `20261023175712_group_g0_permissions.sql` より後。適用済みSQLを変えず、UTF-8/BOMなし/LF。先頭BEGIN、最終assert/NOTIFY後の末尾COMMITを1組だけ持つ。
- 新しい本体関数はprivate schema、所有者postgres、`SECURITY DEFINER SET search_path = ''`、完全修飾名。公開RPCはservice_role専用のSECURITY INVOKER委譲。本体を直接呼ぶ公開口に必要なprivate関数のEXECUTEだけservice_roleへ付与し、各新objectのPUBLIC/anon/authenticated権限は個別REVOKEする。内部helperはservice_roleからも直接EXECUTEを剥がす。旧即拒否stubは公開SECURITY INVOKERのまま。**`USAGE ON SCHEMA private` をREVOKE/GRANTする文は一切書かない**。既存のanon/authenticated USAGEと `private.set_request_context()` EXECUTEはPostgREST pre-request hookに必要なので保持する（base `:1247,3916,4052`、search_path最終ALTER=`20260921011535_harden_security_definer_search_path.sql:32`）。
- 新4表はRLS有効、anon/authenticatedのrestrictive deny-all、PUBLIC/anon/authenticated/service_roleのALLを剥がしservice_roleは必要なSELECTだけ。新sequenceは作らない。service_roleからの直接DMLで割当/履歴を作らせない。所有者の通常SQLによる履歴UPDATE/DELETE/TRUNCATEもトリガーで拒否する。
- 新規在庫RPCも既存APIの認可→CSRF→IP/actor回数制限→検証→RPC→監査を守る。actorは認可結果だけから渡す。ブラウザへservice_role鍵を渡さない。DB lock中にStripe/メール/追跡/Storage等のI/Oを行わない。
- 原本の注文enum・金額・区分・返品/返金の金銭状態を維持する。品物状態の保存列をorders/order_itemsへ足さない。旧completionの補完/移行/履歴表示は作らない。J-02は不要。J-19は現行の決済/返金契約と照合し、別の状態制限migrationを混ぜない。
- 秘密値・トークン・cookie・メール本文・住所/電話・署名URL・Storageキー・生のDBエラーをログ/報告へ出さない。本番の清掃件数読取は表名・条件・件数・在庫合計だけで、ID/メールを結果に出さない。schema照合は定義hash/型/ACL等の非機密catalog、cron照合はTask 19の安全な4列だけ。
- UI変更前に `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` と `01-app/01-getting-started/15-route-handlers.md` を読む。新storeはserver-only、画面と共有するtypes/停止文は純粋な定義とする。単体は `npx.cmd jest <paths> --runInBand`、型は `npx.cmd tsc --noEmit --incremental false`。実装者は単体/型、controllerはreset・DB結合/別接続競合・build/E2E・最終レビュー・本番適用/pushを担当する。
- 全画面検証は390/768/1280px。後段E2E/停止case/DB未設定skipを合格に数えない。RED/GREENと単体/実DB/bridge/本番の境界を分ける。`graphify hook status` だけ確認し、commit hookによる再構築に任せる。

**全SQL Task共通のcontroller検証:**

実装者はDocker/Supabase CLI/DBを起動・実行しない。各SQL Taskの実装後、controllerが必ず `npx.cmd supabase db reset` → 下記PostgREST 2要求 → そのTaskのDB integrationを実行し、失敗を実装者へ返す。修正後も同じ順で再実行しGREENを得てからレビューする。Task 1/16の旧schema清掃枠だけは `npx.cmd supabase db reset --version 20261023175712 --no-seed`（古いschemaへ新seedを走らせない）。通常のresetはseed.sqlも実行して成功する必要があり、Task 4でseedの取引先頭にも共通advisoryを加える。

各SQL TaskのFilesには、共通のDB材料 `tests/integration/db/helpers/order-fixtures.ts` とTask 4で作る `tests/integration/db/helpers/group-g1-fixtures.ts` の必要な更新も含む。既存DB suiteの発送材料を先に合成fixtureへ切り替え、そのTaskのGREENをTask 16まで延期しない。実装者はこの共通2ファイルも当該Taskのレビュー/コミット対象として明示する。

**毎回のreset直後のPostgREST smoke:** local Supabaseでpre-request設定を確認し、必要ならseed.sql末尾と同じ `ALTER ROLE authenticator SET pgrst.db_pre_request TO 'private.set_request_context'; NOTIFY pgrst,'reload config';` をlocalだけに適用する。匿名apikeyだけのanon要求と、local Authで作った実authenticated JWTの要求でそれぞれ `GET /rest/v1/items?select=id&limit=0` が **HTTP 200** であることを確認する。2要求ともpre-request hookを通り、レスポンスは空配列。URLはlocalhost/127.0.0.1だけ、key/JWT/利用者情報を出力せずstatus2件だけ記録する。JWT mockで代用せず、片方でも失敗ならそのTaskのDB/レビューを止めて修正する。

**裁定の突き合わせ:**

| 指摘箇所 | 本計画での確定値 |
|---|---|
| 本番適用の二重定義 | 清掃先頭の1ファイル、自身のBEGIN/COMMIT、MCP apply_migration 1回のみ |
| 清掃表数/存在 | 31表。存在しない表を外し、全メールdedupe/webhookイベント行は保持（対象未完了イベントをdeadへ移し通知済み時刻を設定）、影響payoutは集計だけ更新 |
| UI/client/storeのFiles | Task 14/15のdialog/client/store/全単体/ShopSettingsと64 direct importersの表で固定 |
| E2E依存の漏れ | Task 18の90ファイルを一つの表で処置 |
| hold作成/解除 | payment exceptionと同取引で作成、人とsystem双方のresolveと同取引で解除 |
| 配送再送キー | fulfillment_id＋tracking_version＋event。Task 13の完全なmd5式 |

**全体ロック順（全Taskの更新関数に適用）**

`pg_catalog.pg_advisory_xact_lock(190521, 1)` → 注文作成時だけ `checkout_drafts FOR UPDATE` → `items FOR KEY SHARE` id昇順 → `item_variants FOR UPDATE` id昇順 → `orders FOR UPDATE` id昇順 → `order_items FOR UPDATE` id昇順 → `order_item_allocations FOR UPDATE` id昇順 → `order_returns` → `order_return_lines` → `order_return_receipts` → `order_return_receipt_lines` → `order_refunds` → `order_refund_lines` → `order_cancel_requests` → `order_cancel_request_lines`。後段で必要になった行もこの順で事前取得し、不要な表だけを省く。将来の発注書→発送票はこの後。既存の配送/例外/設定等の補助行は上記の後で取り、そこから前段へ戻らない。ただし配送の追跡の設定の行（`shop_settings`）だけは、共通advisoryの直後・`orders`の前に取る（2026-10-24 Task 13 で決定。変えない `admin_set_delivery_tracking` が「設定 FOR UPDATE → 注文」の順のため、注文の後に設定を待つと deadlock になる）。FIFOで `SKIP LOCKED` を使わない。

公開更新入口のprivate本体が一度だけ全対象を事前ロックする。内部のrefund core/apply/refresh/FIFOは取得済み行で動き、入れ子から公開RPCやlock helperを呼ばない。操作IDの受渡しは取引ローカルの `app.group_g_operation_id` を使い、外側が設定/復帰する。これは認可やlock済み判定には使わず、公開入口は設定値にかかわらず必ずロックを取る。状態before/afterを記録する責任も外側に一つだけ置く。

**操作識別の共通値:**

- 操作識別: 既存request_keyがあればそのUUID、Stripeはevent IDがある時は `md5('stripe:'||event_id)::uuid`、ない時は `md5(operation||':'||order_id||':'||payment_intent_id)::uuid`。releaseはoperation/注文/expected/next/source_event_idから同様に安定UUIDを作る。再送は既存CASとoperation記録の両方で増分0。原因cause_idには元event/注文IDを保持する。
- ほかの既存のキーなし操作の履歴識別は `md5(operation||':'||cause_id)::uuid`。operationには既存関数名を使い、cause_idは取消申請/返品/exceptionのID。mark_reviewedだけは `order_id||':'||review_marked_at`。これらの既存RPCは元のCAS/状態遷移の再送応答を保持し、同じ原因の在庫/eventを再実行しない。新しいstock_moveの同一結果再送と、既存RPCのupdated=false等を混同しない。

**並行試験で証明するlock境界（Task 4のgroup_g1_concurrency、Task 14のwriter inventory）:**

- 全変更入口（Task 4〜13の公開更新RPC、内部coreはその入口経由）ごとに、A接続でadvisory `(190521,1)` だけを保持して有効入力のBを開始する。`pg_blocking_pids(B)` とpg_locksでBが **advisory待ち** と確認してから、C接続で対象draft/items/variants/orders/order_items/割当/返品/返金/申請の各既存行を `NOWAIT` で取得できることをassertする。これでBがadvisoryより前に行lockを持たないことを証明する。A解放後はB完了/保存則をassertし、逆variant入力・同時入金/解放/返金失敗/受取/保留解除でもdeadlock0・二重割当0・最古待ち優先を確認する。
- 内部apply/refresh/FIFO/triggerは事前取得済み行だけで動き、新しく前段行を待たない。トリガー発火後にadvisoryを取り直す実装にしない。public/privateの委譲と全呼出し先を含む `pg_get_functiondef` / `pg_proc.prosrc` の構造確認も併用する。停止RPCは行lock/参照より前に拒否する。
- orders/order_itemsの明示row lockだけでなくUPDATEによる暗黙lockも全migrationの最終定義で検索し、未変更経路を下表で固定する。明示的な未変更RPC/worker経路は在庫lock保持中にも完了し、呼出し先/triggerに在庫write・FIFO・前段lockがないことを確認する。profile削除のFK参照動作だけは下表の40P01/全rollbackを許容する別枠とする。新しい経路が見つかったら未審査のまま放置しない。

| 行lock経路（正確なsignature） | 最終定義（supabase/migrations/）・stock待ちを作らない根拠 |
|---|---|
| `public.request_order_email_resend(uuid,text,uuid,uuid)` | `20261013001143_order_return_receipts.sql:770`。order→outbox/配送/返品の読取と再送受付のみ。enqueue先にもstock/割当writeなし |
| `public.admin_set_delivery_tracking(boolean,uuid)` | `20261021221140_delivery_tracking_admin.sql:834`。order/配送登録/設定のみ。呼出すdelivery_tracking_backfill_targetsは読取、stock/FIFO呼出しなし |
| `public.claim_delivery_tracking(integer,integer)` | `20261021221410_delivery_tracking_sync.sql:160`。order→fulfillment→registrationのleaseだけ。stock/割当行を取らない |
| `public.record_delivery_registration_result(uuid,integer,uuid,text,text)` | 同 `:341`。order→fulfillment→registration/attentionだけ。set_delivery_attentionもstockを取らない |
| `public.expire_delivery_tracking(integer)` | 同 `:815`。order→fulfillment→registration/attentionだけ。stockを取らない |
| `public.record_delivery_stop_result(uuid,integer,uuid,boolean,text)` | 同 `:901`。order→fulfillment→registrationだけ。stockを取らない |
| `public.mark_order_recovered_from_payment(uuid)` | `20261007030336_ops_alerting.sql:176`。review列UPDATEによるorder lockとrevisionだけ。stock/割当更新なし |
| `src/lib/orders/link-guest-orders.ts:122-127` → `public.link_guest_orders(uuid,text)` | **changed in G-1（Task 6）**。bulk UPDATEの暗黙order lock順が未定義でG-1のid昇順lockと衝突するため変更する。共通advisoryを最初に取り、対象ordersをid昇順にlock/更新するservice_role専用RPCへ置換。stock行は取得しない。下記の未変更経路の証明対象には混ぜない |
| `public.orders.orders_user_id_fkey`（profile DELETE → orders.user_id SET NULL） | 最終定義=`20260901102912_remote_schema.sql:2714`、`REFERENCES public.profiles(user_id) ON DELETE SET NULL`。未変更。参照動作がordersに暗黙row lockを取るため、profile側を先に保持する削除とG-1の注文/FK lockは稀にdeadlockし得る。PostgreSQLが検出して片方をSQLSTATE `40P01` で中止し、その取引全体をrollbackすることを許容する。stockを待つ新しい処理は追加せず、両側の成功/永久待ちを要求しない。このFK競合は通常のG-1入口同士のdeadlock0とは別枠 |
| `private.backfill_legacy_order_refunds()` | `20261011222930_order_refund_records.sql:761`。旧返金写し/paid_amountのみ。PUBLIC実行不可、通常業務から呼ばない。stock/割当呼出しなし |

`private.clear_cart_for_order(uuid)` は `FOR UPDATE OF c` でcartsだけ、`public.verify_order_status_phone(text,text)` は `FOR UPDATE OF l` でprivate.order_status_linksだけであり、JOIN先ordersをlockする経路ではない。DROP済みfinalize/admin_ship_paid_order/apply_order_refund_projectionは不在を検査する。orders/order_itemsの既存保護/revision triggerもstock/割当へ待ちを足さないことを読取確認する。

**writerの閉集合（Task 14 DB試験の固定allowlist）:**

public/private全pg_procのprosrc（SQL/PLpgSQL、全overload）を走査し、`stock_movements`、`order_fulfillments`、`order_item_completions`、`order_item_allocations`、`order_item_allocation_events`、`order_item_state_events`、`private.group_g_operations` へのINSERT/UPDATE/DELETE/MERGE/TRUNCATE、および `item_variants.stock_quantity` UPDATEを抽出する。引用名/改行/コメントを正規化し、dynamic EXECUTEでこれらを参照する未審査関数も拒否する。対象schemaはpublic/privateに限定し、無関係な全DB関数を名前で許可しない。

固定allowlistは最終SQLを完成するTask 14の「末尾assertの期待object集合」に一度だけ列挙する。`private.group_g_writer_allowlist() RETURNS regprocedure[]` が返す正確なOID集合と比較し、prefix/関数名だけの一致を禁止する。public委譲はwriteを持たず、旧stubの即拒否は別試験、DROP helperは不在を守る。SAVEPOINT内で `private.allocate_group_g_fifo(uuid)` の試験用writer overloadを作り、そのOIDを未許可として検出後ROLLBACKする。未審査overload/dynamic EXECUTEを許可しない。DMLしないguard/read helperはwriter集合外でよい。

## Review Focus

- **全体lockとdeadlock:** 共通advisoryより先にdraft/variant/order/返品/返金行を取らない。全入口の別接続待ち試験と、未変更RPCのstock非待ちを確認する。profile削除のorders_user_id_fkeyだけは稀な40P01/片側全rollbackを許容し別枠で検証する → Task 4〜14。
- **FIFO/案A:** 最古注文優先・日時同値UUID順・部分割当・交換の元注文日・買い手のH→A保持。NULL/不一致hold/手数料待ち除外と解消後の再参加 → Task 4/6/8/11/12。
- **数量と二重割当:** F/A/H保存則、再送/二重受取/返金復元の増分0、在庫/状態/履歴の一括rollback、追記専用拒否 → Task 2〜13。
- **paid_at:** 初回正常/不一致/期限後/取消後の記録が一度だけ、再送/返金/交換手数料で不変 → Task 7/12。
- **旧入口拒否/残存writer:** 4RPCはLEGACY_FULFILLMENT_DISABLED/55000、completion2本はMANUAL_COMPLETION_DISABLED/55000、legacy helperはDROP、HTTP410/UI入口0、pg_proc overload走査 → Task 14/15/18。
- **清掃と適用:** 31表のWHERE/件数、全variant0、法定triggerの取引内だけの停止/復元、保持対象/payout整合、末尾assert/故障注入の全rollback、直前writer/cron/count再読取とowner明示確認 → Task 1/16/19。
- **private hook/文書:** private USAGE/既存hookを保持、新objectだけ個別REVOKE、resetごとにanon/authenticated実PostgREST 200、route counts132/171と6列FREQ予約を保持 → Task 2/14/18。

---

### Task 1: 1本のmigrationの清掃節と、本番相当データでの原子性試験

**Files:**
- Create: `supabase/migrations/<ts>_group_g1_allocation.sql`、`tests/integration/db/group_g1_cleanup.integration.test.ts`
- Read: 下表の最終CREATE/ALTER、`tests/integration/db/helpers/local-db.ts`、`src/lib/stripe/accounting-sync.ts:168-192`。

**Interfaces / 値:**
- migrationは **1本**。先頭の `BEGIN;` → `-- G1_CLEANUP_BEGIN` → `SET LOCAL lock_timeout = '15s';` / 共通advisory / 固定table lock / 清掃 → `-- G1_CLEANUP_END` → `-- G1_BODY_BEGIN`〜`-- G1_BODY_END` → `-- G1_FINAL_ASSERT_BEGIN`〜`-- G1_FINAL_ASSERT_END` のDO assertion → `NOTIFY pgrst, 'reload schema';` → `COMMIT;`。Task 1では本体節は空、後続SQL Taskが同じ本体節だけを完成させる。清掃を独立適用しない。清掃の独立レビューと、本体を含む全rollbackの両方を1ファイルで満たすため。
- 本番への書込みはcontrollerが **Supabase MCP `apply_migration({ name:'group_g1_allocation', query:ファイル全文 })` を1回だけ**呼ぶ。スクリプト用の本番DB接続は存在しない。ClaudeはDB passwordを受け取らず、扱わない。読取はMCP `execute_sql`、移行履歴はMCPが管理する。
- 取引先頭は次の固定順とする。cron設定を変更せず、advisoryと清掃31表のACCESS EXCLUSIVEでcron/workerと直列化する。lock_timeoutはadvisory/各table lockにも適用し、15秒で取れなければSQLSTATE `55P03` で全ファイル失敗/rollback。controllerは後で件数読取・確認からやり直し、同じ枠で強制再試行しない。

```sql
BEGIN;
-- G1_CLEANUP_BEGIN
SET LOCAL lock_timeout = '15s';
SELECT pg_catalog.pg_advisory_xact_lock(190521,1);
LOCK TABLE
  private.fulfillment_tracking_registrations,
  private.order_email_outbox,
  private.order_status_links,
  public.checkout_drafts,
  public.contact_inquiries,
  public.item_variants,
  public.order_cancel_request_lines,
  public.order_cancel_requests,
  public.order_fulfillment_attention,
  public.order_fulfillment_events,
  public.order_fulfillment_lines,
  public.order_fulfillment_tracking_changes,
  public.order_fulfillments,
  public.order_item_completions,
  public.order_items,
  public.order_refund_lines,
  public.order_refunds,
  public.order_return_lines,
  public.order_return_photo_uploads,
  public.order_return_photos,
  public.order_return_receipt_lines,
  public.order_return_receipts,
  public.order_returns,
  public.order_revisions,
  public.orders,
  public.payment_exceptions,
  public.stock_movements,
  public.stripe_balance_transactions,
  public.stripe_payouts,
  public.stripe_refunds,
  public.stripe_webhook_events
IN ACCESS EXCLUSIVE MODE;
```

- この後、Oを `pg_temp.group_g_cleanup_order_ids(id uuid PRIMARY KEY,checkout_session_id text,payment_intent_id text) ON COMMIT DROP`、注文連動balanceの非NULL payout_idを `pg_temp.group_g_cleanup_payout_ids(id text PRIMARY KEY) ON COMMIT DROP`、Wを上記temp表へ保存する。tempは31表に数えずIDは結果に出さない。
- count-only読取の結果列は `table_name text,action text,affected_count text,total_count text NULL,quantity_sum text NULL`。actionは下表操作に対応する `delete_all/delete_linked/unlink/reset/recompute/terminalize_webhook`。COUNT/SUMはbigintの10進文字列、IDや秘密値は結果に含めない。MCP execute_sqlでは `group_g_cleanup_order_ids AS (SELECT id,checkout_session_id,payment_intent_id FROM public.orders)`、`group_g_cleanup_payout_ids AS (SELECT DISTINCT payout_id AS id FROM public.stripe_balance_transactions WHERE order_id IN (SELECT id FROM group_g_cleanup_order_ids) AND payout_id IS NOT NULL)` の読取CTEだけを使い、下表WHEREの `pg_temp.` 修飾を外した同じ条件で31表のCOUNTをUNION ALLしtable_name順で返す。temp表を作らず、SELECT idはこのCTE/FK照合の内部だけ。variantだけtotal_count=全variant件数/quantity_sum=全stock合計も返し、他はNULL。影響payout行数はrecompute行のaffected_countそのもの。参照先payoutがない補足行は下記の `balance_without_payout` 1行とする。
- **永続表31表＝全件DELETE 25表＋注文連動DELETE 2表＋関連解除1表＋在庫リセット1表＋payout集計更新1表＋webhook終端化1表**。下表を件数読取とSQLの唯一の対象一覧とする。`WHERE TRUE`は全状態・全日時・全所有者でありprefixで推測しない。定義の出典は `supabase/migrations/` 内を全検索した最後のCREATEと後続ALTER。実装時にもDROP/FK/trigger/ACLまで再照合し、存在しない表を `IF EXISTS` で隠さない。

| 表 | 操作・正確なWHERE | 定義の出典（supabase/migrations/） |
|---|---|---|
| `private.order_email_outbox` | DELETE WHERE TRUE | `20261009095633_order_email_outbox.sql:11；最終ALTER 20261021220816_delivery_tracking_records.sql:365` |
| `private.order_status_links` | DELETE WHERE TRUE | `20261022084844_order_status_links.sql:23` |
| `private.fulfillment_tracking_registrations` | DELETE WHERE TRUE | `20261021220816_delivery_tracking_records.sql:158` |
| `public.order_fulfillment_attention` | DELETE WHERE TRUE | `20261021220816_delivery_tracking_records.sql:204` |
| `public.order_fulfillment_events` | DELETE WHERE TRUE | `20261021220816_delivery_tracking_records.sql:114` |
| `public.order_fulfillment_tracking_changes` | DELETE WHERE TRUE | `20261021220816_delivery_tracking_records.sql:139` |
| `public.order_return_photos` | DELETE WHERE TRUE | `20261020144439_order_return_request_records.sql:42` |
| `public.order_return_photo_uploads` | DELETE WHERE TRUE | `20261020144439_order_return_request_records.sql:28` |
| `public.order_cancel_request_lines` | DELETE WHERE TRUE | `20261020144439_order_return_request_records.sql:92` |
| `public.order_cancel_requests` | DELETE WHERE TRUE | `20261020144439_order_return_request_records.sql:65` |
| `public.order_return_receipt_lines` | DELETE WHERE TRUE | `20261012235910_order_return_records.sql:135` |
| `public.order_return_receipts` | DELETE WHERE TRUE | `20261012235910_order_return_records.sql:111；最終ALTER 20261013001143_order_return_receipts.sql:11` |
| `public.order_refund_lines` | DELETE WHERE TRUE | `20261011222930_order_refund_records.sql:79；最終ALTER 20261012235910_order_return_records.sql:208` |
| `public.stock_movements` | DELETE WHERE TRUE | `20260919065355_add_stock_movements.sql:6；最終ALTER 20261012235910_order_return_records.sql:219` |
| `public.order_refunds` | DELETE WHERE TRUE | `20261011222930_order_refund_records.sql:14；最終ALTER 20261023061408_order_cancel_reasons.sql:9` |
| `public.order_return_lines` | DELETE WHERE TRUE | `20261012235910_order_return_records.sql:81` |
| `public.order_fulfillment_lines` | DELETE WHERE TRUE | `20261010120303_order_fulfillments.sql:32` |
| `public.order_item_completions` | DELETE WHERE TRUE | `20261010120303_order_fulfillments.sql:39` |
| `public.order_items` | DELETE WHERE TRUE | `20260901102912_remote_schema.sql:677；最終ALTER 20261012235910_order_return_records.sql:181` |
| `public.order_fulfillments` | DELETE WHERE TRUE | `20261010120303_order_fulfillments.sql:11；最終ALTER 20261021221140_delivery_tracking_admin.sql:55` |
| `public.order_returns` | DELETE WHERE TRUE | `20261012235910_order_return_records.sql:21` |
| `public.order_revisions` | DELETE WHERE TRUE | `20260901102912_remote_schema.sql:698` |
| `public.payment_exceptions` | DELETE WHERE TRUE | `20260927100500_payment_exceptions.sql:6；最終ALTER 20261011223453_order_refund_results.sql:53` |
| `public.checkout_drafts` | DELETE WHERE TRUE | `20260901102912_remote_schema.sql:461；最終ALTER 20261008220825_cart_wishlist_ownership.sql:125` |
| `public.stripe_refunds` | DELETE WHERE order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids) | `20260901102912_remote_schema.sql:963` |
| `public.stripe_balance_transactions` | DELETE WHERE order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids) | `20260901102912_remote_schema.sql:907` |
| `public.stripe_webhook_events` | UPDATE WHERE id IN (SELECT id FROM pg_temp.group_g_cleanup_webhook_ids)：processing_status='dead',dead_at=clock_timestamp(),dead_notified_at=clock_timestamp(),completed_at=NULL,claim_token=NULL,lease_expires_at=NULL,last_error='group_g1_test_data_cleanup'。next_attempt_at/attempt_count/received_at/processed_at/raw_payload/id/event_typeは保持、DELETEしない | `20260901102912_remote_schema.sql:988；最終状態CHECK 20261007030242_webhook_queue_dead_letter.sql:21-24` |
| `public.stripe_payouts` | UPDATE WHERE id IN (SELECT id FROM pg_temp.group_g_cleanup_payout_ids)：reconciled_net=COALESCE((SELECT sum(b.net) FROM public.stripe_balance_transactions b WHERE b.payout_id=public.stripe_payouts.id),0)、reconciliation_status='pending'。行自体は保持 | `20260901102912_remote_schema.sql:934` |
| `public.contact_inquiries` | UPDATE SET order_id=NULL WHERE order_id IN (SELECT id FROM pg_temp.group_g_cleanup_order_ids)。本文/子メッセージは保持 | `20260901102912_remote_schema.sql:488` |
| `public.orders` | DELETE WHERE TRUE | `20260901102912_remote_schema.sql:718；最終ALTER 20261023082632_orders_shipping_default_zero.sql:5` |
| `public.item_variants` | UPDATE SET stock_quantity=0,updated_at=now() WHERE stock_quantity<>0。inactiveも含む全variantが対象 | `20260919065336_add_variant_inventory_tables.sql:27` |

- `private.order_emails` は `20261009095736_order_email_enqueue.sql:403` でDROP済みで対象に含めない。`private.resend_webhook_receipts`（`20261009095633_order_email_outbox.sql:110`）は全メールのResend重複防止記録で注文FKがなく全件不変。`public.stripe_webhook_events` は全行を残し、下記Wだけをdeadへ移す。completed/dead/注文非連動行とpayloadは保持する。
- balance行は `stripe_balance_transactions_order_id_fkey` の `orders` 参照がRESTRICT（base `:2735`）なので注文連動行だけ削除する。先に注文連動のstripe_refundsを削除する（balance/failure_balance FKはbase `:2741,2744`、order FKは `:2748`）。`stripe_refunds.order_id` はNOT NULL FK。全旧ordersの集合Oに属するrefundを先に消し、balance参照を解く。
- payout_idはFKではないが、削除したnetを `reconciled_net` に残す不整合を避けるため影響payoutだけ残存balance.net合計へ更新し、照合状態を `pending` に戻す。amount/status/銀行確認/raw/synced_atは変えず、他payoutは不変。ownerには **影響する実在 `stripe_payouts` 行数**（上表WHEREのCOUNT）とbalance削除件数を提示する。providerの照合成功と扱わず、再照合は既存会計同期に委ねる。参照先payoutがないbalanceの件数もCOUNTのみで補足する。
**値（balance without payoutの件数行）:**

`table_name='public.stripe_balance_transactions'`、`action='balance_without_payout'`、`affected_count=COUNT(*)::text`、`total_count=NULL`、`quantity_sum=NULL`。WHEREは `b.order_id IN (SELECT id FROM group_g_cleanup_order_ids) AND (b.payout_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.stripe_payouts p WHERE p.id=b.payout_id))`。NULL payoutも含め「payoutへ結び付かない削除予定balance」を数える。常にこの5列/1行で返す補足で、清掃31表とは別計上。対象balance自体は注文連動DELETEの対象であり、存在しないpayoutを作らない。

**値（未完了webhookの対象集合W・唯一の条件）:**

Oは清掃開始時の全orders（id/checkout_session_id/payment_intent_id）。下記の `group_g_cleanup_order_ids` は本番前読取では同名CTE、清掃SQLでは `pg_temp.group_g_cleanup_order_ids`。revisionの照合は削除前に行う。UUID文字列へcastせず `o.id::text` と比較する。

```sql
e.processing_status IN ('queued','processing','failed')
AND e.next_attempt_at IS NOT NULL
AND (
  EXISTS (
    SELECT 1 FROM group_g_cleanup_order_ids o
    WHERE e.raw_payload #>> '{data,object,metadata,order_id}' = o.id::text
       OR e.raw_payload #>> '{data,object,order_id}' = o.id::text
       OR (o.checkout_session_id IS NOT NULL
           AND e.raw_payload #>> '{data,object,id}' = o.checkout_session_id)
       OR (o.payment_intent_id IS NOT NULL AND (
            e.raw_payload #>> '{data,object,id}' = o.payment_intent_id
         OR e.raw_payload #>> '{data,object,payment_intent}' = o.payment_intent_id
         OR e.raw_payload #>> '{data,object,payment_intent,id}' = o.payment_intent_id
       ))
  )
  OR EXISTS (
    SELECT 1 FROM public.order_revisions r
    JOIN group_g_cleanup_order_ids o ON o.id=r.order_id
    WHERE r.source_event_id=e.id
  )
)
```

- `next_attempt_at` は `20260925000303_add_stripe_webhook_queue.sql:5-8` でNOT NULL。上の条件は期限到来済/将来のretryを両方含め、failedの再試行待ちも対象とする。最終CHECK=`20261007030242_webhook_queue_dead_letter.sql:21-24` はqueued/processing/completed/failed/**dead**、同 `:86-105` のclaimはqueued/failedだけを取るため、既存の「これ以上処理しない」状態 **dead** を使う。NULLへは変更しない。
- 清掃前readはWをCTE `group_g_cleanup_webhook_ids AS (SELECT e.id FROM public.stripe_webhook_events e WHERE 上記条件)` とし、31表の `terminalize_webhook` 行のaffected_countでownerへ件数を提示する。清掃ではlock取得後・revision削除前に `pg_temp.group_g_cleanup_webhook_ids(id text PRIMARY KEY) ON COMMIT DROP` へ固定し、上表のUPDATEを最初のデータ変更として行う。理由 `last_error='group_g1_test_data_cleanup'` は固定、秘密値を含めない。**裁定(a): 同じUPDATEで `dead_notified_at=clock_timestamp()` も設定する**。`public.list_unnotified_dead_stripe_webhook_events(integer)`（最終CREATE=`20261007030242_webhook_queue_dead_letter.sql:185`、同 `:204` はdead_notified_at IS NULLのみ）/`src/lib/ops/ops-checks.ts:83-89` のdead-letter通知対象からWを外し、テストデータについてownerへ知らせのメールは送らない。総行数/payloadは不変、old claim_tokenによるcomplete/failは不成立になる。
- 本番相当DB試験にはO直結/PaymentIntent文字列・展開object/Checkout Session/revisionだけで関連するqueued・processing・failedを置き、全Wだけdead/lease解除/固定reason/dead_notified_at非NULL（清掃取引の開始後から終了までの時刻）をassertする。Wを通知関数のlimitから漏らして偽の0にせず、対照を含む全deadが200行以下のfixtureで `SELECT count(*) FROM public.list_unnotified_dead_stripe_webhook_events(200) n WHERE n.event_id=ANY($1::text[])` が0（$1は清掃前に試験メモリへ保持したWのID配列、出力しない。成功COMMITで消えるpg_temp表を実行後の試験から参照しない）、清掃外の未通知dead対照は同関数に残ることをassertする。既存completed/deadと非関連の同event_typeは全列不変、総行数不変、Wの再claim0をassertする。cron相当の別接続が清掃表の行lockを持つ状態では全文が15s timeout/55P03で失敗し全件/定義不変、解放後の成功版は全assertを満たすことも検証する。末尾故障注入時は状態/token/lease/reason/dead_notified_atも全復元する。

- 追記/法定保存の拒否は清掃節の同一取引内だけで回避する。DELETE対象表のUSER triggerの有効状態を事前照合してから `DISABLE TRIGGER USER`、削除後に `ENABLE TRIGGER USER`。`protect_legal_order_delete` / `protect_legal_order_item_delete`（base `:3047/:3037`）を含む。内部FK trigger、RLS、session_replication_roleを変更しない。開始時に通常有効でなければ `GROUP_G_CLEANUP_PRECONDITION / 55000`。triggerを無効のまま本体へ進めない。
- 循環FKは `public.order_items.order_items_exchange_return_line_id_fkey` のみ一時DROPし、削除後に同名・同列・`REFERENCES public.order_return_lines(id) ON DELETE RESTRICT`・NOT DEFERRABLEで復元する。outbox/追跡/写真/申請→受取行/受取→返金行/台帳→返金→返品行/発送行/completion→order_items→発送/返品→revision/例外/Stripe写し/問い合わせの関連解除→orders→draft→variantの順をFK試験で確定する。payout再集計はbalance削除後。`TRUNCATE CASCADE`や本番seedを使わない。
- 保持するもの: 商品/variant/色/サイズ、利用者/全ACL/G-0イベント、問い合わせ本文/子メッセージ、注文外Stripe写し、payout行、Resend dedupe全行/Stripe webhook全行（Wは終端状態/通知済み時刻等だけ変更）、`private.refund_ledger_state` / `private.order_email_send_pause` / `private.delivery_tracking_provider_gate`、audit_logs/legal_archive_runs、Storageの全オブジェクト。写真は注文連動のDBメタデータだけ削除する。
- 最終DOはCOMMITより前に、25表全件0・2表のO連動行0・問い合わせO関連0・**全variant stock_quantity=0**・payout再集計/状態・全Wのdead/固定reason/lease解除/dead_notified_at非NULL・Wの未通知dead一覧0・webhook総行数不変・全trigger/FK復元をassertする。新objectの完全な期待集合は最終SQLを仕上げるTask 14の一箇所に固定する。失敗は `GROUP_G_MIGRATION_ASSERTION_FAILED / 55000` で全rollback。新しい履歴は空、既存注文/台帳がない前提をここで検証する。

- [ ] **Step 1: 本番相当fixtureのDB試験を書く。** G-0までの実schema・実triggerで、下表31表すべてに対象行が最低1行あることを清掃前COUNTでassertする。未入金/入金/期限切れ、stock/backorder/completion、発送/追跡、部分返金/返品/受取/交換循環FK、写真、outbox/リンク、order_id=NULLの例外/draft、inactiveを含む非0在庫、注文連動/注文外balanceとそれぞれのpayoutを作る。保持対象にも対照行を作る。特にpayoutに注文内外のbalanceが混在し、削除後に残存netだけ・pendingとなること、問い合わせ本文は同一のままorder_idだけNULLとなることをassertする。
- [ ] **Step 2: 全文実行と故障注入の試験を書く。** `readFile`したSQL全文（自身のBEGIN/COMMITを含む）を専用local接続で実行する。最初に最終assertのmarker間だけを `DO $g1_fail$ BEGIN RAISE EXCEPTION 'GROUP_G_TEST_INJECTED_FAILURE' USING ERRCODE='55000'; END $g1_fail$;` へ差替えた文字列を実行し、ROLLBACK後に31表の清掃前件数/値/在庫、trigger/FK、既存関数定義MD5/ACLが同じで、新objectが一つもないことをassertする。Task 1は空本体なので試験文字列だけに `CREATE TABLE private.group_g1_atomicity_probe(id integer);` を注入して不在をassertする。成功版は原文のまま実行し、全assertと保持対照を検証する。最終SQL完成後にも同じ故障注入で新4表/paid_at/関数も全て戻ることを再検証する。試験全体を外側BEGINで包んで成功扱いにしない。
- [ ] **Step 3: 上記構造で清掃節と空本体・最終assertを実装する。** 関数bodyは試験に従って書き、恒久的な削除バイパスを作らない。
- [ ] **Step 4（controller）: Task 1直後に清掃DBをRED→GREENで検証する。** `npx.cmd supabase db reset --version 20261023175712 --no-seed`（helpで対応を確認。G-0 schemaに後段seedを走らせない）→ 共通のanon/authenticated PostgREST各HTTP 200確認 → `npx.cmd jest tests/integration/db/group_g1_cleanup.integration.test.ts --runInBand`。suiteはG-0へfixtureを入れてSQL原文を実行する。実装者はDocker/CLI/DBを起動しない。失敗を実装者へ返し、修正後は同じreset/HTTP/DBを再実行してGREENを確認する。
- [ ] **Step 5（controller）: 清掃節だけをOpus・effort highへレビュー依頼する。** `G1_CLEANUP_BEGIN`〜`G1_CLEANUP_END`のみを送り、31表のWHERE/FK/trigger/保持対象/payout整合を確認させる。指摘を解消しStep 4を再確認するまで **Task 2を開始しない**。
- [ ] **Step 6（controller）: Filesだけ確認してコミットする。** `feat(inventory): G-1の原子的な清掃節と本番相当rollback試験を追加する`

### Task 2: 割当・履歴モデル、列・制約・object単位のgrants

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`（本体節に追記）
- Create: `tests/integration/db/group_g1_model.integration.test.ts`
- Read: `20261011222930_order_refund_records.sql:335,408,451`、`20261012235910_order_return_records.sql:645,877,942,996`、`20261020150415_order_return_request_reviews.sql:137`、private pre-request hookの定義/ACL。

**Interfaces / 値（本体のモデル）:**

| 対象 | 列・制約 |
|---|---|
| `private.group_g_operations` | `id uuid PK`、`operation text NOT NULL`、`request_key uuid NOT NULL`、`fingerprint text NOT NULL`（64桁小文字SHA-256）、`cause_type text NOT NULL`、`cause_id text NOT NULL`、`exception_id uuid NULL REFERENCES public.payment_exceptions(id) ON DELETE RESTRICT`、`actor_id uuid NULL`、`result jsonb NOT NULL`、`created_at timestamptz NOT NULL DEFAULT now()`。`UNIQUE(operation,request_key)`。actorは削除で変わらない写しでFKなし。`CHECK ((operation='payment_review_hold')=(exception_id IS NOT NULL))`。holdはcause_type=`payment_exception`/cause_id=`exception_id::text`/result=`{ active:true,order_id:注文ID }` |
| `public.order_item_allocations` | `id uuid PK DEFAULT gen_random_uuid()`、`order_item_id uuid NOT NULL FK order_items RESTRICT`、`variant_id bigint NOT NULL FK item_variants RESTRICT`、`quantity integer NOT NULL CHECK >0`、`remaining_quantity integer NOT NULL CHECK 0..quantity`、`kind text NOT NULL CHECK IN ('payment_hold','paid')`、`operation_id uuid NOT NULL`、`version bigint NOT NULL DEFAULT 0 CHECK >=0`、`created_at/updated_at timestamptz NOT NULL DEFAULT now()`。索引`(variant_id,kind,order_item_id)`と`(order_item_id,id)` |
| `public.order_item_allocation_events` | `id uuid PK DEFAULT gen_random_uuid()`、`allocation_id uuid NOT NULL FK allocations RESTRICT`、`event_type text NOT NULL CHECK IN ('hold','promote','allocate','release','consume','restore','transfer')`、`quantity integer NOT NULL CHECK >0`、`operation_id uuid NOT NULL`、`sequence integer NOT NULL CHECK >0`、`counterpart_allocation_id uuid NULL FK allocations RESTRICT`、`reverses_event_id uuid NULL FK allocation_events RESTRICT`、`stock_movement_id bigint NULL FK stock_movements RESTRICT`、`reason text NULL`、`actor_id uuid NULL`、`created_at timestamptz NOT NULL DEFAULT now()`。`UNIQUE(operation_id,allocation_id,event_type,sequence)`、`UNIQUE(stock_movement_id)`、`UNIQUE(reverses_event_id)`（NULLは複数可）、索引`(allocation_id,created_at,id)` |
| `public.order_item_state_events` | `id uuid PK DEFAULT gen_random_uuid()`、`order_item_id uuid NOT NULL FK order_items RESTRICT`、`unit_from integer NOT NULL CHECK >=0`、`unit_to integer NOT NULL CHECK >unit_from`、`quantity integer GENERATED ALWAYS AS (unit_to-unit_from) STORED`、`from_status/to_status text NULL`（下表12値のみ）、`operation_id uuid NOT NULL`、`sequence integer NOT NULL CHECK >0`、`reason text NULL`、`actor_id uuid NULL`、`created_at timestamptz NOT NULL DEFAULT now()`、`version bigint NOT NULL CHECK >0`。from/toの少なくとも一方は非NULLかつ相違。`UNIQUE(operation_id,order_item_id,sequence,unit_from)`、索引`(order_item_id,version,id)` |
| `public.orders` | `paid_at timestamptz NULL`だけ追加。後述の初回入金関数と不変triggerで守る |
| `public.stock_movements` | `allocation_operation_id uuid NULL`を追加しoperationと関連付ける。reasonのCHECKは既存7値＋`allocation_release`。過去SQLは変更しない |

- 各 `operation_id` と `allocation_operation_id` は `private.group_g_operations(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`。操作IDを先に生成し、結果の受付行は処理末尾で一度INSERTする。同じ取引で必ず存在させる。operation表も追記専用。
- `private.reject_group_g_event_mutation() RETURNS trigger` は `GROUP_G_HISTORY_IMMUTABLE / 55000`。allocation_events/state_events/group_g_operationsに `<table>_no_update`・`_no_delete`（BEFORE行）・`_no_truncate`（BEFORE文）を付ける。`private.guard_group_g_allocation_change() RETURNS trigger` を `order_item_allocations_change_guard`（BEFORE UPDATE OR DELETE、行）に付ける。id/item/variant/quantity/作成原因の変更とDELETEは同エラー、H→A以外のkind変更も拒否。現在値の残数量/kind変更ごとにversion+1とイベントを必須にする。集計制約は遅延constraint triggerでcommit時にも検証する。
- `private.check_group_g_allocation_bounds() RETURNS trigger` をallocations/allocation_eventsの `group_g_allocation_bounds`（AFTER INSERT OR UPDATE、DEFERRABLE INITIALLY DEFERRED、行）に付ける。variantの一致、残数量とイベントの整合、H/Aの排他、明細ごとに `A+H <= quantity-有効発送数量` を確認し、違反は `GROUP_G_ALLOCATION_BOUNDS / 23514`。これは物理的な保留を含む上限であり、awaiting_responseでまだ解放していないAから返金の覆いを重ねて引かない。新規割当可能数は別に、返金/申請等の覆いを除いた数量から、その領域に残るAを引いて求める。原本区分stock/backorderを制約の分岐に使わない。発送消費/解放は同じ数量を二回使えず、restoreはreverses_event_idで同数の元consumeを一度だけ反転し、新割当行へ戻す。transferは同一operation・同variant・同数量の両側eventと相互counterpartを必要とする。`consume/restore/transfer`は基盤の整合試験用に表現できるようにし、G-1の公開業務入口は追加しない。

- `private.ensure_group_g_payment_review_hold(_order_id uuid,_payment_ref text,_checkout_session_id text,_payment_intent_id text,_draft_id uuid) RETURNS uuid` は取得済み全体lockの下でmismatch例外のupsertとhold作成を **同一取引** で行いexception IDを返す。payment_refは `COALESCE(order.checkout_session_id,_payment_intent_id)`、reason=`paid_amount_mismatch`、detail=NULL。既存のresolved例外は再開せずholdも作らない。hold request_key=`pg_catalog.md5('review-hold:'||exception_id::text)::uuid`。既存の未解除holdは再利用する。単独のhold INSERTで例外なしを許さないFK/CHECKを付ける。
- 新private objectは個別REVOKEする。**private schemaのUSAGEには一切触れない**。既存 `private.set_request_context()` の実行権限も保持する。

- [ ] **Step 1: モデルDB試験を書く。** grants/RLS/owner/search_path、H/A排他・variant一致・数量上限・eventなし変更拒否、追記3表のowner/service_roleのUPDATE/DELETE/TRUNCATE拒否、restore再送拒否/transfer両側保存則/途中失敗の全rollbackをassertする。想定エラーはSAVEPOINTで回収する。
- [ ] **Step 2: private hookのDB試験を書く。** `has_schema_privilege('anon','private','USAGE')` とauthenticated版が共にtrue。各SAVEPOINT内で `SET LOCAL ROLE anon; SELECT private.set_request_context();`、authenticated版も成功し、roleを戻せることをassertする。新private表/関数への直接アクセス拒否も別にassertする。
- [ ] **Step 3: DDLと上記trigger/helperを実装する。** 12状態の投影はTask 3へ分け、清掃節はレビュー済みのまま保つ。最終assertへ新4表/列/制約/trigger存在と初期行0を追加する。
- [ ] **Step 4（controller）: resetとTaskのDBを検証してからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ `npx.cmd jest tests/integration/db/group_g1_model.integration.test.ts --runInBand`。RED/GREENと失敗を実装者に返す。失敗修正後はresetから再確認し、GREEN後にレビューへ送る。
- [ ] **Step 5（controller）: Filesだけコミットする。** `feat(orders): G-1割当モデルと追記制約と個別ACLを追加する`

### Task 3: 排他的な12状態の投影と状態履歴

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`
- Create: `src/lib/orders/item-state/item-state-types.ts`、`src/lib/orders/item-state/item-state-store.ts`、`tests/integration/db/group_g1_item_states.integration.test.ts`、`tests/unit/lib/orders/item-state/item-state-store.test.ts`
- Read: `src/lib/orders/order-progress.ts`、`src/lib/orders/customer-order-view.ts`、`src/lib/orders/returns/return-types.ts`、Task 2の最終定義出典。

**Interfaces（投影）:**
- `private.group_g_item_state_ranges(_order_ids uuid[]) RETURNS TABLE(order_id uuid, order_item_id uuid, status text, unit_from integer, unit_to integer, blocked_reasons text[])`。各明細の数量区間は0始まり半開区間 `[0,quantity)`。公開2状態除外時は0行、他は重複なし/穴なし。
- `public.list_admin_order_item_states(_order_ids uuid[]) RETURNS TABLE(order_id uuid, order_item_id uuid, status text, quantity integer, blocked_reasons text[])`。privateの同名本体へ委譲し、同じ状態/不可理由の区間を集約する。NULL/空配列は0行、200注文超は `TOO_MANY_ORDERS / 22023`。G-1ではservice_role用の読取基盤だけで、新一覧APIを作らない。
- `private.capture_group_g_item_states(_order_ids uuid[]) RETURNS jsonb` と `private.record_group_g_item_state_changes(_before jsonb, _order_ids uuid[], _operation_id uuid, _sequence integer, _reason text, _actor_id uuid) RETURNS integer`。同じ原因の変更前/後を照合し、変化した区間だけ追記。明細ごとのversionは直前+1。導入前の履歴は作らず、新規に表示対象になった数量だけfrom=NULL。同一操作内の入金→FIFOは別sequenceで残す。
- TS: `AdminItemStatus`は下表のunion、`AdminItemState = { orderId: string; orderItemId: string; status: AdminItemStatus; quantity: number; blockedReasons: ItemBlockedReason[] }`、`ItemBlockedReason = 'variant_missing'|'payment_review'|'exchange_fee_waiting'|'cancel_requested'|'refund_processing'|'stock_shortage'`。`ADMIN_ITEM_STATUS_LABELS: Record<AdminItemStatus,string>`、`listAdminOrderItemStates(client: SupabaseClient, orderIds: string[]): Promise<AdminItemState[]>`。生SQLエラーを返さず未知値/不正数量は内部失敗にする。客向け辞書は変更しない。

| code | 日本語 | 数量の根拠 |
|---|---|---|
| `unpaid` | 未払い | pending、期限切れ以外のfailedの未入金残数 |
| `payment_expired` | 支払い期限切れ | failedかつ直近のfailedへのstatus変更revisionのreasonが `stripe_voucher_expired`。`changed_fields`にstatusを含み、`after_data->>'status'='failed'`の行を `changed_at DESC,id DESC` で1件読む。単なるfailedを含めない |
| `in_production` | 受注生産中 | 入金済み未発送残数のうち有効Aなし |
| `ready` | 発送準備中 | 同じ残数のうち有効Aあり。Hを含めない |
| `shipped` | 発送済み | 有効発送数量から配達/返品の覆いを引いた数 |
| `delivered` | 配達済み | 実配達数量、または返品却下で復帰した数量 |
| `cancel_requested` | キャンセル申請中 | requestedの取消申請数量だけ |
| `cancelled` | キャンセル済み | 未入金取消、または発送前返金の覆い。発送後返金をここへ移さない |
| `return_requested` | 返品申請中 | requested返品の対象発送数量だけ |
| `return_in_progress` | 返品受付中 | 承認/店作成後の未処理・検品中・金額決定済み返金処理中 |
| `refund_waiting` | 返金待ち | 返品受取の店長金額相談数量だけ。Stripe pending等は含めない |
| `returned` | 返品済み | 返品で処理完了した数量。交換/返金不要/未着終了/お返しも既存完了条件を継承 |

- 発送済み領域と未発送領域を最初に分ける。発送は `shipped_at,id` 昇順、各発送内は明細ID順で仮想区間を置く。同じ領域内では、返品完了→店長相談→承認返品の未処理→返品申請→返品却下による復帰→実配達→発送の順に数量を覆う。返品countsは既存coreの排他的な内訳を使い、processedとrefundCovered等を重複加算しない。
- 未発送領域は発送前取消/返金の覆い→未解決取消申請→A→未割当の順。返金の未割当分優先という既存契約を守る。申請中のAは保持し、状態だけ申請に覆う。`awaiting_response/pending/succeeded`の発送前返金数量は取消済みに含め、前2者には `refund_processing` を付ける。error/failedは覆いを外して実Aから再導出する。
- paid/shippedだけでなく、全額返金でorders.cancelledとなった場合も実発送/返品記録から導出する。交換品は独立明細。`payment_in_progress/abandoned`は表示0行。NULL variantは `variant_missing`、入金済未割当なら受注生産中。返品却下は管理の配達済みへ戻すが、配送event/delivered_atは作らず、reason=`return_declined_restore`で根拠を残す。

- [ ] **Step 1: store/辞書の単体を書く。** 12コード/日本語全文、未知コード/負数/不正数量の拒否、RPC名/引数、空配列、`ADMIN_ITEM_STATUS_LABELS.shipped='発送済み'`、客語「配送中」維持をassertする。
- [ ] **Step 2: 状態DB試験を書く。** 各12状態・混在数量・部分発送/配達/返品/取消/交換・返金失敗・期限切れ対通常failed・非表示2状態をtable testにし、数量和が原本、交差/穴0をassertする。返品却下復帰はreason=`return_declined_restore`でdelivered_at非改変、無変化操作はevent0件。
- [ ] **Step 3: 単体REDを確認する。** `npx.cmd jest tests/unit/lib/orders/item-state/item-state-store.test.ts --runInBand`。
- [ ] **Step 4: 上記projection/helper/TSを実装し、単体と型をGREENにする。** 新UI/API一覧を作らず、現在値は投影を正とする。最終assertに読取RPC/履歴helperの存在を加える。
- [ ] **Step 5（controller）: resetとDBの失敗を返してからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ `npx.cmd jest tests/integration/db/group_g1_item_states.integration.test.ts tests/integration/db/group_g1_model.integration.test.ts --runInBand`。失敗修正後は同順でGREENを確認する。
- [ ] **Step 6（controller）: Filesだけコミットする。** `feat(orders): 12状態の数量投影と差分履歴を追加する（G-1）`

### Task 4: 共通lock・FIFO・台帳trigger・seed・最小DB fixture

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`、`supabase/seed.sql`、`tests/integration/db/helpers/order-fixtures.ts`、`tests/integration/db/stock_movements.integration.test.ts`
- Create: `tests/integration/db/helpers/group-g1-fixtures.ts`、`tests/integration/db/group_g1_fifo.integration.test.ts`、`tests/integration/db/group_g1_concurrency.integration.test.ts`
- Read/replace: `public.apply_stock_movement()` の最終CREATE=`20260919065355_add_stock_movements.sql:26`、search_path最終ALTER=`20260921011535_harden_security_definer_search_path.sql:36`。

**Interfaces:**
- `private.lock_group_g_inventory(_variant_ids bigint[], _order_ids uuid[], _draft_id uuid DEFAULT NULL) RETURNS uuid[]`。**最初に共通lock**を取り、draft指定時は次にdraftを取る。対象注文の全variant、同variantの待ち注文、関連返品の交換variantまで読み取りで対象を閉じてから、Global Constraintsの順で既存行を一度ずつロックする。戻り値はロックした全注文IDの昇順。後から対象を追加して前段へ戻る呼出しは禁止。新規INSERT行は待ち対象の既存行と区別する。
- `private.allocate_group_g_fifo(_variant_ids bigint[], _operation_id uuid, _actor_id uuid) RETURNS integer`。取得済みロックの下で動き、割当点数を返す。呼出し側が変更前状態を採取し、処理後に状態差分を保存する。SQLのrow triggerから再帰的にFIFOを呼ばない。
- `private.apply_group_g_stock_movement(_variant_id bigint,_delta integer) RETURNS void`、既存の `public.apply_stock_movement() RETURNS trigger`。台帳trigger `stock_movements_apply` は既存名のままprivate本体へ値を渡す。
- local DB fixtureの `withGroupG1FixtureTransaction` / `seedGroupG1Allocation` / `seedGroupG1Shipment` はTask 16の正確なsignatureで最小版をここから用意する。既存order-fixturesの発送材料も停止RPCから切り離す。restockの公開RPC adapterはTask 5で追加し、全DB helperの最終整合はTask 16で検証する。

**値:**
- FIFO順は `orders.created_at ASC, orders.id ASC, order_items.id ASC`。同variantで古い行から `min(未割当数,F)`、部分割当可。入金済み、未発送、未取消、申請/返金対象外、支払額要確認なし、交換手数料保留なし、非NULL variantだけ。原本区分を変更せず、既存A/Hを奪わない。inactiveだけを理由に既存注文を排除しない。
- Fの増減は既存 `stock_movements_apply` triggerだけ。公開 `apply_stock_movement() RETURNS trigger` はNEWを受け、private `apply_group_g_stock_movement(_variant_id bigint,_delta integer) RETURNS void` を呼ぶSECURITY INVOKERへ置換する（trigger関数そのものを通常関数として呼ばない）。private本体はpostgres所有/DEFINER/search_path空/個別REVOKE。呼出し元の事前lockを前提とし、台帳INSERT後に共通lockを取りにいく方式を使わない。service_roleのstock_movements直接INSERTとsequence USAGEを剥がす。商品在庫POSTは直接INSERTを新RPCへ置換する。
- seed.sqlは単一BEGIN/COMMIT、最初のDML/行lockより前に共通advisory。seedは注文/アカウントを作らず、商品/初期restockの見本値を維持する。FIFOをSQL行triggerから再帰的に呼ばない。正の流入を起こす業務入口が取引末尾でFIFOを呼ぶ。

- [ ] **Step 1: FIFO/trigger/fixtureのDB試験を書く。** 古2/新2へ入荷2→A=2/0、同時刻UUID順、部分割当/余剰F、H→A手元不変、consume/restore保存則、保留/NULL除外、負数/二重割当拒否、event故障時の全rollbackをassertする。内部基盤のconsume/restoreは旧配送RPCを使わない。
- [ ] **Step 2: 別接続のlock試験を書く。** Global Constraintsのadvisory待ち中C接続NOWAITによる全入口検査、逆variant入力順、同variantへの入荷2本、pg_blocking_pidsで待ちを確認してから解放する試験を追加する。sleepだけで競合を証明しない。
- [ ] **Step 3（controller）: REDを返す。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ `npx.cmd jest tests/integration/db/group_g1_fifo.integration.test.ts tests/integration/db/group_g1_concurrency.integration.test.ts tests/integration/db/stock_movements.integration.test.ts --runInBand`。
- [ ] **Step 4: lock/FIFO/台帳triggerとseed/最小fixtureを実装する。** 状態差分/operationは同取引。新しい在庫権限へ切り替えず、fixtureもadvisoryを最初に取る。
- [ ] **Step 5（controller）: DB検証を行ってからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST各HTTP 200 → Step 3のDBコマンド。失敗を実装者へ返し、修正後はresetからGREENを確認する。実装者の単体/型の成功で置き換えない。
- [ ] **Step 6（controller）: Filesだけコミットする。** `feat(inventory): G-1の共通lockとFIFOと台帳triggerを追加する`

### Task 5: 在庫RPC・互換読取・履歴・既存API/画面

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`、`src/app/api/admin/items/[id]/variants/route.ts`、`src/app/admin/item/ItemStockSection.tsx`、`tests/integration/db/helpers/group-g1-fixtures.ts`
- Create: `src/lib/inventory/allocation-types.ts`、`src/lib/inventory/allocation-store.ts`、`tests/integration/db/group_g1_stock_api.integration.test.ts`、`tests/integration/db/group_g1_inventory_reads.integration.test.ts`、`tests/unit/lib/inventory/allocation-store.test.ts`
- Modify tests: `tests/unit/api/admin/item-variants-route.test.ts`、`tests/unit/components/ItemStockSection.test.tsx`
- Read/replace: `private.order_line_reservations(uuid)`=`20261012235910_order_return_records.sql:599`、`private.order_line_fulfillment(uuid)` / `private.check_order_line_fulfillment_bounds()`=`20261011222930_order_refund_records.sql:335/451`、`public.list_variant_stock_states(bigint[])`=`20261010120303_order_fulfillments.sql:581`、`public.list_item_stock_history(bigint,integer)`=`20261012235910_order_return_records.sql:1222`。後続ALTER/ACLも保持する。

**Interfaces:**
- `private.admin_record_stock_movement(_item_id bigint, _variant_id bigint, _delta integer, _reason text, _note text, _actor_id uuid, _request_key uuid, _expected_release_quantity integer) RETURNS jsonb` と同signatureのpublic入口。成功JSONは `{ movementId: string, releasedQuantity: number, allocatedQuantity: number, replayed: boolean }`。operation=`stock_move`。
- このprivate本体は有効な `user_roles → roles → role_permissions → permissions` をactor IDで照会して `admin.items.manage` を必須にする。G-0の `has_permission(text)` はauth.uid()用なので、service_role接続でactor引数付き関数のようには呼ばない。item_idとvariant_idの所属も同じlock内で再検証する。
- `private.list_group_g_variant_inventory(_variant_ids bigint[]) RETURNS TABLE(variant_id bigint, free integer, paid_allocated integer, payment_held integer, on_hand integer, waiting integer)` と同signature/戻り型のpublic入口。一つのSQL snapshotで読む。A/Hは残数量、`on_hand=F+A+H`、waitingは品物投影の受注生産中数量（手数料/要確認の保留分も含む）で、FIFOの参加資格とは別。NULL/空は0行、500variant超は `TOO_MANY_VARIANTS / 22023`。inactive variantの既存履行を消さない。
- `private.list_item_allocation_history(_item_id bigint,_limit integer)` と同signatureのpublic入口は `RETURNS TABLE(event_id uuid,allocation_id uuid,order_id uuid,order_item_id uuid,variant_id bigint,event_type text,quantity integer,operation_id uuid,counterpart_allocation_id uuid,reverses_event_id uuid,stock_movement_id bigint,reason text,actor_id uuid,created_at timestamptz)`。新規のservice_role専用読取で、`created_at DESC,event_id DESC`、limitは既存historyと同じdefault50/最小1/最大200。商品に属するvariantだけを読む。
- TS: `recordStockMovement(client: SupabaseClient, actorId: string, input: { itemId: number; variantId: number; delta: number; reason: 'restock'|'adjustment'; note: string|null; requestKey: string; expectedReleaseQuantity: number|null }): Promise<{ movementId: string; releasedQuantity: number; allocatedQuantity: number; replayed: boolean }>`。SQLSTATEとmessageの完全一致でだけ分類する。
- TS: `AllocationHistoryEvent = { id: string; allocationId: string; orderId: string; orderItemId: string; variantId: number; type: 'hold'|'promote'|'allocate'|'release'|'consume'|'restore'|'transfer'; quantity: number; operationId: string; counterpartAllocationId: string|null; reversesEventId: string|null; stockMovementId: string|null; reason: string|null; actorId: string|null; createdAt: string }`、`listItemAllocationHistory(client: SupabaseClient,itemId: number,limit: number): Promise<AllocationHistoryEvent[]>`。既存GETのmovementsを保ち、`allocationEvents: AllocationHistoryEvent[]`を追加する。
- `seedGroupG1Restock` はTask 16のsignatureでここで追加する。local helperからも `public.admin_record_stock_movement(...,'restock','E2E fixture restock',actorId,requestKey,NULL)` を呼び、直接stock_movements INSERTでFIFOを迂回しない。

**値:**
- 通常確保は `purchase/-n`、交換は `exchange/-n`。checkout仮確保もpurchase、H→Aはmovement0件。解放は `cancel/+n` または `refund/+n`。棚卸/将来入替は `allocation_release/+n`。通常入荷 `restock/+n`、返品戻し `return/+n`、棚卸 `adjustment/±n`。stock履歴の既存戻り列を保ち、自動割当/解放も表示する。movementと結び付くeventはそのmovement行へ関連付けて二重表示しない。stockMovementId=NULLのeventは独立行で表示し、promoteの文言は `入金による割当への切替`、数量は `割当 ${quantity}点`、空き在庫の増減/残高は `—`。0数量台帳は作らない。
- allocation-typesに `ALLOCATION_EVENT_LABELS` を置く。hold=`支払い前の仮確保`、promote=`入金による割当への切替`、allocate=`注文への割当`、release=`割当の解放`、consume=`発送による割当の消費`、restore=`発送取消による割当の復元`、transfer=`割当の入替`。取引原因/対象明細は記録に残し、画面の注文番号は既存formatter、actorがNULLなら `自動処理`。後段の操作を行うbuttonは追加しない。
- 棚卸減はFから使い、不足だけ未発送Aを新しい注文から `orders.created_at DESC,orders.id DESC,order_items.id DESC,order_item_allocations.id DESC` で外す。Hと発送済みは外さない。`-delta > F+A`なら `GROUP_G_STOCK_INSUFFICIENT / 23514`。Aを外す場合は空でないnoteと、再計算した解除数に一致するexpectedReleaseQuantityが必須。解除でFを足した後にadjustmentで引き、余剰だけFIFO。
- 既存POST本文に `requestKey: UUID`、`expectedReleaseQuantity?: nonnegative integer` を追加する。初回で解除確認が必要ならDBは `GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED / 55000`、自分で生成したDETAILは `{ releasedQuantity:n }` のみ。storeはこの完全一致の組と非負整数だけを解釈し、routeは409 `{ code:'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', error:'割り当て済みの品を外す必要があります。数量を確認してください。', releasedQuantity:n }` を返す。書込み0件。理由なしは `GROUP_G_STOCK_RELEASE_REASON_REQUIRED / 22023`→400。確認後は**新しいrequestKey**とn、必須noteで再送。変化していれば再び409で再確認。同一確定送信の通信再送は同じkey/本文を使う。
- 確認dialogは見出し `在庫を減らす`、本文 `割り当て済みの品を${n}点外し、受注生産中に戻します。`、ボタン `在庫を減らす` / `戻る`。保存中は閉じない。note未入力は `割り当てを外す理由を入力してください。`。既存の入荷/棚卸画面内の確認だけで、新しい一覧を作らない。
- 旧読取互換: reservations.reservedはA+Hの残数。fulfillmentの戻り11列とpublic一覧の12列は維持する。`completed=shipped+A`、`unshipped=max(quantity-shipped-refunded_before_shipment,0)`、入金済みは `ready_unshipped=min(A,unshipped)`・`in_production=unshipped-ready_unshipped`。未入金は後2列を0とし、Hを準備中にしない。これは客向けの準備数量で、管理12状態の取消申請等による分割とは別。保持中のAを二重控除せず、発送の不可理由は別に判定する。variantのcommitted=A+H、backorderは管理投影の受注生産中数量へ。既存GETの数量は新public.list_group_g_variant_inventoryの一回の応答からstockQuantity=free、committedQuantity=paid_allocated+payment_held、onHandQuantity=on_hand、backorderQuantity=waitingを作る。先に別queryで読んだvariant.stock_quantityと別snapshotのA/Hを足さない。色/サイズ/SKU取得と既存のvariant補完は維持する。
- 再送はoperation+request_key、正規化入力のSHA-256。入力配列はID順、actor/数量/reason/noteも指紋へ含める。同一結果を返し、異入力は下表の409。既存RPCのrequest_key/fingerprint/CAS契約は各Taskで保持する。新RPCのエラーは下表のmessage+SQLSTATEの完全一致だけを分類する。

| DB message / SQLSTATE | HTTP | 新在庫窓口のerror本文 |
|---|---|---|
| `GROUP_G_ARGUMENT_INVALID / 22023` | 400 | `入力を確かめてください。` |
| `GROUP_G_FORBIDDEN / 42501` | 403 | `在庫を変更する権限がありません。` |
| `GROUP_G_STOCK_INSUFFICIENT / 23514` | 409 | `在庫が足りないため、この数量は引けません。` |
| `GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED / 55000` | 409 | `割り当て済みの品を外す必要があります。数量を確認してください。` |
| `GROUP_G_STOCK_RELEASE_REASON_REQUIRED / 22023` | 400 | `割り当てを外す理由を入力してください。` |
| `GROUP_G_REQUEST_KEY_CONFLICT / 23505` | 409 | `同じ要求番号で異なる在庫操作は実行できません。` |
| 未知message/SQLSTATE、不正な戻り値 | 500 | `在庫の記録に失敗しました`（生のエラーは返さない） |

既知拒否の本文は `{ code:上表message,error:上表本文 }`、解除確認だけreleasedQuantityを追加。未知500はerrorだけ。既存の認可/MFA/CSRF/制限による応答は既存契約のまま先に返す。


- variants GETの成功は200 `{variants,movements,allocationEvents}`（既存2配列を保持しallocationEventsを追加）。POSTは既存入力＋必須requestKey、成功201 `{success:true}` を保持し、内部RPC結果のmovementId/割当数は監査へ使う。POSTの直接台帳INSERTは0回。FR-ADMIN-058/081/093のmock/理由順はTask 18の固定値へ追従する。
- list_item_stock_historyは台帳行だけを `movement_id DESC` で返し、既存11列を維持する。割当eventは別allocationEventsへ `created_at DESC,event_id DESC`。台帳に結び付くeventをUIで二重表示しない。FIFOが失敗返金/返品交換により作る台帳行はその同一operationのrefund_id/return_idを引き継ぎ、元の金銭/返品根拠を落とさない。
- UI理由はpurchase=`注文への確保`、purchaseかつrefundIdあり=`注文への確保（返金の失敗で再割当）`、exchange=`交換品への確保`、return=`返品の受け取り`、restock=`入荷`、refund=`返金`、cancel=`取消`、adjustment=`棚卸調整`、adjustmentかつrefundIdあり=`棚卸調整（返金で在庫に戻さない）`、allocation_release=`割当の解放`。これ以外の旧「販売」表示を残さない。

- [ ] **Step 1: 在庫store/API/UIの単体を書く。** RPC1回/直接INSERT0、requestKey必須、actor差替え不可、既存認可/MFA/CSRF/制限/監査、確認前0更新・確認値変更409・保存中二重送信なし・同キー再送、上記の日本語全文をassertする。
- [ ] **Step 2: 在庫RPC/互換読取DB試験を書く。** 棚卸減は新しいAから解除、H/発送済み不変、理由/確認数なし拒否、F/A/H保存則、同キー異入力拒否、reason/原因/履歴一対一、単一snapshotの数量/11列互換/新allocationEventsをassertする。
- [ ] **Step 3: 単体REDを採取する。** `npx.cmd jest tests/unit/lib/inventory/allocation-store.test.ts tests/unit/api/admin/item-variants-route.test.ts tests/unit/components/ItemStockSection.test.tsx --runInBand`。
- [ ] **Step 4: RPC/store/互換読取/API/画面を実装する。** Task 4のlock/FIFOを使い、readと書込みの数量計算を二重実装しない。Step 3と `npx.cmd tsc --noEmit --incremental false` をGREENにする。
- [ ] **Step 5（controller）: 独立したDB検証をレビュー前に実行する。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ `npx.cmd jest tests/integration/db/group_g1_stock_api.integration.test.ts tests/integration/db/group_g1_inventory_reads.integration.test.ts tests/integration/db/group_g1_fifo.integration.test.ts --runInBand`。失敗を実装者へ返し、修正後はresetから再実行する。
- [ ] **Step 6（controller）: Filesだけコミットする。** `feat(inventory): G-1在庫RPCと互換履歴を既存窓口へ接続する`

### Task 6: 注文受付・仮確保・未入金の解放/取消（既存4本＋関連付けRPC）

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`、`tests/integration/db/helpers/order-fixtures.ts`
- Modify: `src/lib/orders/link-guest-orders.ts`、`tests/unit/lib/orders/link-guest-orders.test.ts`
- Create: `tests/integration/db/group_g1_checkout.integration.test.ts`、`tests/integration/db/group_g1_link_guest_orders.integration.test.ts`
- Modify tests: `tests/integration/db/place_order_from_checkout_draft.integration.test.ts`、`tests/integration/db/place_order_shown_stock.integration.test.ts`、`tests/integration/db/release_stock_by_order.integration.test.ts`、`tests/integration/db/group_g1_concurrency.integration.test.ts`
- Read: `src/features/checkout/services/checkout-fulfillment.service.ts`、`src/lib/stripe/checkout-payment-reconciler.ts`。

**Interfaces（最後のCREATE、引数名/default/戻り値を維持）:**

| 既存関数 | 最終定義（supabase/migrations/） | 戻り値 |
|---|---|---|
| `public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)` | `20261023082740_item_variant_retire.sql:166` | `(order_id uuid,order_status order_status,created boolean,rejection text)`。引数名/default/所有者照合も保持 |
| `public.mark_order_awaiting_payment(uuid,text,text)` | `20261009095736_order_email_enqueue.sql:147` | `(updated boolean)` |
| `public.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)` | `20261023061408_order_cancel_reasons.sql:63` | `(released boolean,order_id uuid,status order_status)` |
| `public.admin_cancel_failed_order(uuid,uuid,text,text)` | `20261023061408_order_cancel_reasons.sql:12` | `(id uuid,status order_status)` |

**Interfaces（関連付け）:**
- 新 `public.link_guest_orders(_user_id uuid,_email text) RETURNS TABLE(id uuid,shipping_full_name text,shipping_postal_code text,shipping_prefecture text,shipping_city text,shipping_address text,shipping_building text,created_at timestamptz)` は同signatureのprivate本体へSECURITY INVOKERで委譲する。private本体はpostgres所有・SECURITY DEFINER・search_path=''。両関数のPUBLIC/anon/authenticated EXECUTEを個別REVOKEしservice_roleだけGRANTする。private schema USAGEは変更しない。
- `_user_id IS NULL` / NULL・trim後空のemailは `GROUP_G_ARGUMENT_INVALID / 22023`。auth.usersの当該userが存在しemail_confirmed_at非NULLかつ `lower(email)=lower(btrim(_email))` でなければ `GROUP_G_FORBIDDEN / 42501`。ユーザーの読取は非locking、最初のlockは必ず `pg_catalog.pg_advisory_xact_lock(190521,1)`。その後 `orders.user_id IS NULL AND lower(orders.shipping_email)=lower(btrim(_email))` の行を **id昇順でFOR UPDATE** し、同じ順にuser_idを更新する。取得後にもuser_id IS NULLを確認し、他人から付替えない。stock/variant行は取らない。返却は更新した行の上記8列をid昇順、対象なし/再送は0行。%・_・\は文字そのものでありパターン一致にしない。
- `linkGuestOrdersByEmail` のsignature/未確認・空なら0/失敗0/既存profileコピー/件数監査を維持する。bulk `.from('orders').update(...)` とILIKE用escapeを外し、`.rpc('link_guest_orders',{_user_id:params.userId,_email:normalizedEmail})` へ。RPCの返却行で既存 `copyGuestProfileFromOrder` を行い、住所の選択はcreated_at最新の既存規則のまま。RPC外のprofileコピー・監査でstock lockを保持しない。失敗時のconsole/error audit detailは固定 `GROUP_G_LINK_GUEST_ORDERS_FAILED` だけにし、生error/メール/住所を記録しない。

**値:**
- 既存置換4本。同signatureのprivate本体へ公開口が委譲する。受付は同variant合計が全数足りる時だけstockとして `purchase/-n` と同数のHを一度作る。shown variant/owner/廃止variantの拒否は保持し、draftより先に共通advisoryを取る。未入金はAを持たない。旧finalizeは復活させない。
- releaseは現存Hだけ `cancel/+n` で解放して同variantの古い待ち注文へFIFO。failed/abandoned/cancelled再送は増分0。admin_cancel_failed_orderも共通lock/状態差分を通し、6取消理由/other必須note/期限切れメール条件を維持する。
- 状態before/afterとoperationは同取引。入金のH→Aと例外作成/自動返金はTask 7で同時導入する。このTaskの新規DB試験はcheckout/awaiting/releaseを対象にし、未導入の入金契約をGREENと数えない。

- [ ] **Step 1: checkout/解放のDB試験を書く。** 原本区分/表示在庫/持主照合の拒否、Hだけの確保、未入金の準備中0、期限切れ/放棄/取消で解放1回、他の古い待ち注文へのFIFO、同時受付で注文1件・台帳1組・負在庫0をassertする。fixtureはこの段階の試験に必要なH/A合成をlocalだけで整える。関連付けDB試験は大小文字・%/_/\の完全一致、未確認/別user拒否、他人のuser_id保持、再送0行、8列の戻り、anon/authenticated拒否/service_role成功を確認する。別接続でadvisoryより前の行lockがないこと、逆順に作られた複数注文でもid順で完了しcheckout/入金とのdeadlockがないことをassertする。未変更orders_user_id_fkeyは別接続のprofile DELETEとG-1の注文/FK lockを逆待ちにするスケジュールを作り、PostgreSQLが片方を40P01で中止してその取引全体を戻し、永久待ちや部分更新を残さないことを別枠でassertする。
- [ ] **Step 2（controller）: REDを返す。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ `npx.cmd jest tests/integration/db/group_g1_checkout.integration.test.ts tests/integration/db/group_g1_link_guest_orders.integration.test.ts tests/integration/db/place_order_from_checkout_draft.integration.test.ts tests/integration/db/place_order_shown_stock.integration.test.ts tests/integration/db/release_stock_by_order.integration.test.ts tests/integration/db/group_g1_concurrency.integration.test.ts --runInBand`。
- [ ] **Step 3: caller単体をREDにして、既存4本と関連付けRPC/callerを実装する。** `npx.cmd jest tests/unit/lib/orders/link-guest-orders.test.ts --runInBand` でRPC名/正規化済み値/8列からのprofileコピー/無対象・未確認・失敗・監査を固定する。 Task 4の全体lock/在庫/FIFOとTask 3の差分履歴を使い、公開RPCへ入れ子で戻らない。既存RPC引数/戻り値/CAS/拒否codeを保持する。caller単体と型をGREENにする。
- [ ] **Step 4（controller）: reset後の同DBをGREENにしてからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST各HTTP 200 → Step 2のDBコマンド。失敗を実装者へ返し、修正後はresetから再実行する。
- [ ] **Step 5（controller）: Filesだけコミットする。** `feat(checkout): 仮確保と未入金解放をFIFOへ接続する（G-1）`

### Task 7: 入金・初回paid_at・支払例外holdと両resolver（既存6本）

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`
- Test/modify tests: `tests/integration/db/group_g1_payment_review.integration.test.ts`、`tests/integration/db/payment_exceptions.integration.test.ts`、`tests/integration/db/group_g1_payment.integration.test.ts`、`tests/integration/db/group_g1_concurrency.integration.test.ts`
- Modify tests: `tests/integration/db/mark_order_payment.integration.test.ts`、`tests/integration/db/reconciler_composed.integration.test.ts`、`tests/integration/db/reconciler_postgrest.integration.test.ts`
- Read: `src/lib/stripe/checkout-payment-reconciler.ts:333,417,526-556`、`src/lib/stripe/checkout-payment-reconciler-deps.ts:154-213`、`src/lib/stripe/webhook-processor.ts`
- Modify tests: `tests/unit/lib/stripe/checkout-payment-reconciler.test.ts`、`tests/unit/lib/stripe/checkout-payment-reconciler-deps.test.ts`

**Interfaces（引数名/default/戻り型を最終定義どおり保持）:**

| 既存関数 | 最終CREATEの出典（supabase/migrations/） |
|---|---|
| `public.mark_order_reviewed(uuid,uuid)`、`public.record_payment_exception(text,text,text,text,text,uuid,uuid)` | `20260927100500_payment_exceptions.sql:223,53` |
| `public.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)` | `20261023061434_payment_exception_refund_failed_note.sql:5` |
| `public.resolve_payment_exception_by_system(uuid,text)` | `20261011223453_order_refund_results.sql:1260` |
| `public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)` | `20261011222930_order_refund_records.sql:574` |
| `public.record_cancelled_order_paid_amount(uuid,text,integer)` | `20261011223147_order_refund_requests.sql:758` |

**値:**
- mark_paidはH→Aを先に行い、本人の確保は案Aで保持する。不一致時はTask 2のensure helperで **payment_exceptions行とholdを同時作成してから** FIFOへ進む。後続TSのrecordExceptionが失敗しても例外とholdの両方が残る。active条件はTask 7の式。新規FIFOは保留中除外、既存の本人Aは維持する。未確保分の正常入金は通常FIFO。期限後入金は期限切れ→受注生産中→割当済みだけ準備中。他のAを奪わず、通常backorder不足をstock_not_reservedにしない。
- mark_paid/record_cancelled_order_paid_amountは実入金成功のUPDATEで `paid_at=COALESCE(paid_at,clock_timestamp())`。再送/CAS不一致では更新しない。新 `private.guard_group_g_paid_at() RETURNS trigger` の `orders_paid_at_once`（BEFORE UPDATE）で、非NULLのpaid_atの変更/NULL戻しを `GROUP_G_PAID_AT_IMMUTABLE / 55000` とする。
- 入金時にNULL variantがあれば既存の `review_reason='stock_not_reserved'`・review_marked_atを設定し、既存の「要確認」に出す。同時に品物投影の不可理由は `variant_missing`。この要確認を確認済みにしてもNULL自体を修復したことにはせず、FIFO除外を保つ。既存理由コード/画面辞書は増やさない。
- mark_paidからcheckout_draftsへのpayment_intent_id書戻しを削除する。draftの支払参照は注文作成/Session attachまでで記録し、入金照合はordersの参照を正とする。入金後にdraft lockへ戻らない。カート清掃/メールoutboxはDB取引内の既存契約を維持する。
- mark_order_paidの戻りは `(updated boolean,amount_matches boolean,needs_review boolean)`、record_cancelled_order_paid_amountはboolean、他4本も最終戻り/defaultを維持する。
- 既存置換6本＋新 `private.release_group_g_payment_review_holds(_exception_id uuid,_actor_id uuid) RETURNS integer`。resolveは注文/在庫等の全体順を終えた後にexceptionをlockする。取消を伴う人のresolveも取得済みprivate release本体へ渡し、exception→stock待ちを残さない。
- **hold activeの正確な条件:** `h.operation='payment_review_hold' AND h.exception_id=e.id AND e.reason='paid_amount_mismatch' AND e.order_id=対象注文ID AND e.resolved_at IS NULL AND NOT EXISTS (SELECT 1 FROM private.group_g_operations r WHERE r.operation='payment_review_release' AND r.cause_type='payment_review_hold' AND r.cause_id=h.id::text)`。result.activeだけで判断しない。Task 2のhelperはmark_paidの不一致分岐と、`record_payment_exception` の **reason='paid_amount_mismatch' AND order_id IS NOT NULL** の分岐だけで使い、例外とholdを同時作成する。他reasonのrecord_payment_exceptionはholdを作らない。
- **両resolverとも** resolved_at更新と、全対応holdに `operation='payment_review_release'` / cause_type=`payment_review_hold` / cause_id=`hold_id::text` / request_key=`pg_catalog.md5('review-release:'||hold_id::text)::uuid` / result=`{active:false}` を一度追記する処理を同取引で行う。人/システムを区別せず、閉じた例外に未解除holdを残さない。他の保留が全て解けた時だけFIFO。`mark_order_reviewed`は既存review_reasonの確認だけでmismatch holdを解除しない。NULL variantは解消操作後も除外。
- DBが先に例外を作るため、後続TSのrecordExceptionの初回自動返金権を失わない。mismatchについて `operation='payment_exception_dispatch'` / cause_type=`payment_exception` / cause_id=`exception_id::text` / request_key=`pg_catalog.md5('exception-dispatch:'||exception_id::text)::uuid` を同取引で一度claimする。未解決かつ最初のdispatch成功だけ `is_new=true`、再送/解決済みはfalse。通常の初回INSERTも同じclaimへ統一し、検知回数の更新は既存どおり。API/TSの戻りshapeを変えず、DB先行作成→TS初回true→再送false→既存自動返金1回をunit/実DBの両方でassertする。
- J-04 `RESOLUTION_NOTE_REQUIRED / 22023`、system resolverの `(uuid,text)` と明示NULLの既存呼出しを維持する。実通貨をorders.currencyだけで再推測しない。

- [ ] **Step 1: この関数群の失敗するDB試験を書く。** 案A（古い待ち2/新しいH2→新しい本人A2/古0、次入荷で古2）、正常/0円/金額不一致/期限後/取消後の初回paid_at、再送/CAS不一致/返金/手数料で不変、直接変更/NULL戻しはGROUP_G_PAID_AT_IMMUTABLE/55000、NULL variant要確認をassertする。 人のresolveでhold解除/通常FIFO、system resolveでも同じ結果、mark_reviewedだけでは未解除、例外作成の故障でholdも0、hold作成の故障で例外も0、dispatch初回/再送、refund_failed空note拒否をassertする。全resolve後 `SELECT count(*) FROM private.group_g_operations h JOIN public.payment_exceptions e ON e.id=h.exception_id WHERE h.operation='payment_review_hold' AND e.resolved_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM private.group_g_operations r WHERE r.operation='payment_review_release' AND r.cause_type='payment_review_hold' AND r.cause_id=h.id::text)` は0。 想定拒否はSAVEPOINTで回収し、単純なmockを実経路成功としない。
- [ ] **Step 2（controller）: SQL実装前のREDを返す。** `npx.cmd supabase db reset` → 共通anon/authenticated PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db/group_g1_payment_review.integration.test.ts tests/integration/db/payment_exceptions.integration.test.ts tests/integration/db/group_g1_payment.integration.test.ts tests/integration/db/mark_order_payment.integration.test.ts tests/integration/db/reconciler_composed.integration.test.ts tests/integration/db/reconciler_postgrest.integration.test.ts tests/integration/db/group_g1_concurrency.integration.test.ts --runInBand`。未導入/契約違反のREDを記録して実装者へ返す。
- [ ] **Step 3: 上表の関数群だけを置換する。** 共通lockより前の行lockを除き、全対象を事前収集/取得してから既存coreへ進む。before→業務変更→解放/復元→FIFO→after/event/operationを同取引とし、子から公開RPCへ再入しない。外部I/Oは取引外に保つ。`npx.cmd jest tests/unit/lib/stripe/checkout-payment-reconciler.test.ts tests/unit/lib/stripe/checkout-payment-reconciler-deps.test.ts --runInBand` と型をGREENにする。
- [ ] **Step 4（controller）: reset後のDB結果を実装者へ返してからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ Step 2のDBコマンド。失敗修正後も同順で再実行し、GREEN/skip実数を記録する。
- [ ] **Step 5（controller）: レビュー後、Filesだけコミットする。** `feat(orders): 初回入金と例外holdと両解消を原子的にする（G-1）`

### Task 8: 返金開始・返金結果・復元をFIFOへ接続する（既存7本）

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`
- Test/modify tests: `tests/integration/db/group_g1_refund_cancel.integration.test.ts`、`tests/integration/db/order_refund_requests.integration.test.ts`、`tests/integration/db/order_refund_results.integration.test.ts`、`tests/integration/db/order_state_transition_hardening.integration.test.ts`、`tests/integration/db/group_g1_concurrency.integration.test.ts`
- Read: `src/lib/orders/refund/refund-service.ts`、`src/lib/orders/refund/refund-store.ts`、`src/app/api/admin/orders/[id]/status/route.ts`

**Interfaces（引数名/default/戻り型を最終定義どおり保持）:**

| 既存関数 | 最終CREATEの出典（supabase/migrations/） |
|---|---|
| `public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)`、`private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)` | public=`20261013001143_order_return_receipts.sql:482`、core=`20261023061408_order_cancel_reasons.sql:181` |
| `private.apply_order_refund_state(uuid)`、`private.apply_return_refund_outcome(uuid,text)` | `20261013001143_order_return_receipts.sql:922,1263` |
| `public.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)`、`public.mark_order_refund_error(uuid,text,boolean)` | 同 `:1309,1483` |
| `public.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)` | `20261011223453_order_refund_results.sql:973` |

**値:**
- 既存置換は7本。beginの外側が取得済みlockで最新private coreへ渡す。返品からも同coreを呼び、公開beginを入れ子にしない。既存CAS/request_key/fingerprint、金額上限、J-06の6取消理由を維持する。
- `awaiting_response`から発送不可/取消済みの覆いを作るがAは保持する。物理解放は初回pending/succeededのstock_applied時だけ、未割当分優先で残るAへ `refund/+n`、その後FIFO。backorder由来のAも対象。
- no_restockは `refund/+n` と `adjustment/-n` を同じ原因で対にし中間FIFOなし。発送後返金は在庫非増加。失敗で覆いを外し、既に解放した分だけ元注文日の通常FIFOへ戻す。他注文のAを奪わず不足は `rereserve_shortage` / `stock_shortage` と既存要確認へ。未解放Aを持つawaiting_response→errorでAを増やさない。

- [ ] **Step 1: この関数群の失敗するDB試験を書く。** q=2/A=2/返金1のawaiting_responseで取消済み1・準備中1/物理A=2、pendingで1解放、succeeded再送増分0。no_restock、発送後返金、pending→failed不足、error復元、同キー再送、返金失敗対FIFOで古い別注文のA不変、金銭/通知/数量履歴の原子性をassertする。 想定拒否はSAVEPOINTで回収し、単純なmockを実経路成功としない。
- [ ] **Step 2（controller）: SQL実装前のREDを返す。** `npx.cmd supabase db reset` → 共通anon/authenticated PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db/group_g1_refund_cancel.integration.test.ts tests/integration/db/order_refund_requests.integration.test.ts tests/integration/db/order_refund_results.integration.test.ts tests/integration/db/order_state_transition_hardening.integration.test.ts tests/integration/db/group_g1_concurrency.integration.test.ts --runInBand`。未導入/契約違反のREDを記録して実装者へ返す。
- [ ] **Step 3: 上表の関数群だけを置換する。** 共通lockより前の行lockを除き、全対象を事前収集/取得してから既存coreへ進む。before→業務変更→解放/復元→FIFO→after/event/operationを同取引とし、子から公開RPCへ再入しない。外部I/Oは取引外に保つ。
- [ ] **Step 4（controller）: reset後のDB結果を実装者へ返してからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ Step 2のDBコマンド。失敗修正後も同順で再実行し、GREEN/skip実数を記録する。
- [ ] **Step 5（controller）: レビュー後、Filesだけコミットする。** `feat(orders): 返金の解放と失敗復元をFIFOへ統一する（G-1）`

### Task 9: 取消申請の受付・却下・解決と共通顧客lock（既存6本）

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`
- Test/modify tests: `tests/integration/db/group_g1_cancel_request.integration.test.ts`、`tests/integration/db/group_g1_refund_cancel.integration.test.ts`、`tests/integration/db/order_return_customer_requests.integration.test.ts`、`tests/integration/db/order_return_request_reviews.integration.test.ts`、`tests/integration/db/group_g1_concurrency.integration.test.ts`
- Read: `src/lib/orders/returns/cancel-request-store.ts`

**Interfaces（引数名/default/戻り型を最終定義どおり保持）:**

| 既存関数 | 最終CREATEの出典（supabase/migrations/） |
|---|---|
| `private.customer_order_for_request(uuid,uuid,boolean)`、`public.customer_request_cancel(uuid,uuid,uuid,jsonb,text)` | `20261020144842_order_return_customer_requests.sql:22,922` |
| `private.lock_order_cancel_request(uuid)`、`public.admin_decline_cancel_request(uuid,uuid,text,text)`、`public.admin_close_cancel_request(uuid,uuid)`、`public.admin_resolve_cancel_request(uuid,uuid,uuid,boolean)` | `20261020150415_order_return_request_reviews.sql:937,980,1006,1026` |

**値:**
- 既存置換6本。`customer_order_for_request(...,_lock=false)` は読取を維持。trueの更新経路は外側の全体lockへ従い、独自に先にorderを取らない。
- customer_request_cancelは申請数量の状態だけを変えAを保持する。decline/closeで未割当数が候補へ戻ればFIFO、既存Aは準備中へ戻す。resolveはrefund行までの事前lock後にcancel_requestを取る。申請→refundの逆順を残さず、承認による解放は返金/取消本体の一度だけ。

- [ ] **Step 1: この関数群の失敗するDB試験を書く。** 申請中A保持、却下/closeで準備中復帰と未割当のFIFO再参加、承認解放1回、同キー再送、申請却下対入荷で数量保存/逆順待ち0をassertする。 想定拒否はSAVEPOINTで回収し、単純なmockを実経路成功としない。
- [ ] **Step 2（controller）: SQL実装前のREDを返す。** `npx.cmd supabase db reset` → 共通anon/authenticated PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db/group_g1_cancel_request.integration.test.ts tests/integration/db/group_g1_refund_cancel.integration.test.ts tests/integration/db/order_return_customer_requests.integration.test.ts tests/integration/db/order_return_request_reviews.integration.test.ts tests/integration/db/group_g1_concurrency.integration.test.ts --runInBand`。未導入/契約違反のREDを記録して実装者へ返す。
- [ ] **Step 3: 上表の関数群だけを置換する。** 共通lockより前の行lockを除き、全対象を事前収集/取得してから既存coreへ進む。before→業務変更→解放/復元→FIFO→after/event/operationを同取引とし、子から公開RPCへ再入しない。外部I/Oは取引外に保つ。
- [ ] **Step 4（controller）: reset後のDB結果を実装者へ返してからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ Step 2のDBコマンド。失敗修正後も同順で再実行し、GREEN/skip実数を記録する。
- [ ] **Step 5（controller）: レビュー後、Filesだけコミットする。** `feat(orders): 取消申請の保留と解消をFIFOへ接続する（G-1）`

### Task 10: 返品申請・作成・承認/却下/取消（既存6本）

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`
- Test/modify tests: `tests/integration/db/group_g1_return_requests.integration.test.ts`、`tests/integration/db/order_return_customer_requests.integration.test.ts`、`tests/integration/db/order_return_request_reviews.integration.test.ts`、`tests/integration/db/order_return_actions.integration.test.ts`、`tests/integration/db/group_g1_concurrency.integration.test.ts`

**Interfaces（引数名/default/戻り型を最終定義どおり保持）:**

| 既存関数 | 最終CREATEの出典（supabase/migrations/） |
|---|---|
| `private.lock_order_return(uuid)`、`public.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)`、`public.admin_cancel_return(uuid,uuid)` | `20261013000456_order_return_actions.sql:150,629,897` |
| `public.customer_request_return(uuid,uuid,uuid,jsonb)` | `20261020144842_order_return_customer_requests.sql:578` |
| `public.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)`、`public.admin_decline_return(uuid,uuid,text,text)` | `20261020150415_order_return_request_reviews.sql:18,137` |

**値:**
- 既存置換6本。request/create/approve/decline/cancelは返品行を先に取らず、readで注文・元/交換variant・関連行を閉じて全体順で事前取得する。`private.lock_order_return`も取得済み経路を前提とし、前段へ戻らない。Task 9の顧客helperを共用する。
- 申請対象数量だけを返品申請中、承認/店作成で返品受付中へ。却下はreason=`return_declined_restore`で管理の配達済みへ戻すが、実配送event/delivered_atは作らない。発送済み/未発送を混ぜず数量履歴を同時保存する。

- [ ] **Step 1: この関数群の失敗するDB試験を書く。** 申請/承認/却下/店作成/取消の部分数量と穴/重複0、却下復帰reason・delivered_at不変、顧客公開範囲維持、並行する入金/FIFOとのlock順をassertする。 想定拒否はSAVEPOINTで回収し、単純なmockを実経路成功としない。
- [ ] **Step 2（controller）: SQL実装前のREDを返す。** `npx.cmd supabase db reset` → 共通anon/authenticated PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db/group_g1_return_requests.integration.test.ts tests/integration/db/order_return_customer_requests.integration.test.ts tests/integration/db/order_return_request_reviews.integration.test.ts tests/integration/db/order_return_actions.integration.test.ts tests/integration/db/group_g1_concurrency.integration.test.ts --runInBand`。未導入/契約違反のREDを記録して実装者へ返す。
- [ ] **Step 3: 上表の関数群だけを置換する。** 共通lockより前の行lockを除き、全対象を事前収集/取得してから既存coreへ進む。before→業務変更→解放/復元→FIFO→after/event/operationを同取引とし、子から公開RPCへ再入しない。外部I/Oは取引外に保つ。
- [ ] **Step 4（controller）: reset後のDB結果を実装者へ返してからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ Step 2のDBコマンド。失敗修正後も同順で再実行し、GREEN/skip実数を記録する。
- [ ] **Step 5（controller）: レビュー後、Filesだけコミットする。** `feat(returns): 返品の受付と審査を状態履歴へ接続する（G-1）`

### Task 11: 返品受取・検品・金額決定・未着/再開と交換明細（既存6本）

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`
- Test/modify tests: `tests/integration/db/group_g1_return_exchange.integration.test.ts`、`tests/integration/db/order_return_actions.integration.test.ts`、`tests/integration/db/order_return_receipts.integration.test.ts`、`tests/integration/db/order_return_request_reviews.integration.test.ts`、`tests/integration/db/group_g1_concurrency.integration.test.ts`
- Modify: `src/components/OrderReturnReceiveDialog.tsx`
- Modify tests: `tests/unit/components/OrderReturnReceiveDialog.test.tsx`、`tests/unit/components/OrderReturnReceiveDialogSupport.test.tsx`
- Read/regression: `src/lib/orders/returns/return-calc.ts`、`src/lib/orders/returns/return-types.ts`、`src/lib/orders/returns/return-store.ts`、`tests/unit/lib/orders/returns/return-calc.test.ts`

**Interfaces（引数名/default/戻り型を最終定義どおり保持）:**

| 既存関数 | 最終CREATEの出典（supabase/migrations/） |
|---|---|
| `public.admin_close_return_missing(uuid,uuid,uuid)`、`public.admin_reopen_return(uuid,uuid,uuid)`、`public.admin_inspect_return(uuid,uuid,uuid,jsonb)` | `20261013000456_order_return_actions.sql:948,1009,1096` |
| `public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)` | `20261020150415_order_return_request_reviews.sql:598`（**20261013001143版を使わない**） |
| `public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)` | `20261013001143_order_return_receipts.sql:2118` |
| `private.refresh_order_return_status(uuid)` | `20261012235910_order_return_records.sql:1107` |

**値:**
- 既存置換6本。receiveは **`20261020150415_order_return_request_reviews.sql:598` の最後の定義**を使い、古い受取関数を戻さない。全対象variant/返品/受取/返金行を先に取得し、内部refresh/coreで公開RPCへ再入しない。
- 良品として在庫へ戻す時だけ `return/+n` を受取/検品で一度記録し取引末尾でFIFO。pending_inspection/not_restocked/sent_back/missingでは増やさず、返金結果で再度戻さない。
- 交換明細の決定IDは既存 `private.return_exchange_item_id(uuid,uuid,text)`（`20261013001143_order_return_receipts.sql:1772`）を再利用。stock直接確保を除き、新明細→受取記録/手数料判定→返品戻し→通常FIFO。元注文日で待ち、stock/make由来で順位を変えない。out_of_stock_exchangeの方法/返金選択は保持するが確保保証にしない。複数行の方法選択は受取前Fのローカル残数を既存行順で減らして決め、返品戻しを先に含めない。
- 受取UIのstock表示は `在庫から（空き在庫 ${exchange.stockQuantity}・割り当ては注文順）`、共通説明は `交換品は、在庫から注文の古い順に割り当てます。`、手数料保留は `手数料のお支払い待ちのため、交換品の割り当てを保留します。`。方法選択上限/返金選択/入力保持/サポーター金額不可を維持する。

- [ ] **Step 1: この関数群の失敗するDB試験を書く。** 受取再送で在庫/event/交換明細が1回、交換より古い別注文優先、makeも通常割当、部分受取/検品待ち/相談/返金処理中と失敗/不要/未着再開/お返しの数量和と元注文paid_at不変をassertする。返品戻し対入金/入庫で二重戻し/負在庫0。 想定拒否はSAVEPOINTで回収し、単純なmockを実経路成功としない。
- [ ] **Step 2（controller）: SQL実装前のREDを返す。** `npx.cmd supabase db reset` → 共通anon/authenticated PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db/group_g1_return_exchange.integration.test.ts tests/integration/db/order_return_actions.integration.test.ts tests/integration/db/order_return_receipts.integration.test.ts tests/integration/db/order_return_request_reviews.integration.test.ts tests/integration/db/group_g1_concurrency.integration.test.ts --runInBand`。未導入/契約違反のREDを記録して実装者へ返す。
- [ ] **Step 3: 上表の関数群だけを置換する。** 共通lockより前の行lockを除き、全対象を事前収集/取得してから既存coreへ進む。before→業務変更→解放/復元→FIFO→after/event/operationを同取引とし、子から公開RPCへ再入しない。外部I/Oは取引外に保つ。上記3単体をRED→GREENにする：`npx.cmd jest tests/unit/lib/orders/returns/return-calc.test.ts tests/unit/components/OrderReturnReceiveDialog.test.tsx tests/unit/components/OrderReturnReceiveDialogSupport.test.tsx --runInBand`。
- [ ] **Step 4（controller）: reset後のDB結果を実装者へ返してからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ Step 2のDBコマンド。失敗修正後も同順で再実行し、GREEN/skip実数を記録する。
- [ ] **Step 5（controller）: レビュー後、Filesだけコミットする。** `feat(returns): 返品戻しと交換明細を通常FIFOへ接続する（G-1）`

### Task 12: 交換手数料の入金/免除・発送保留解除（既存2本）

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`
- Test/modify tests: `tests/integration/db/group_g1_exchange_fee.integration.test.ts`、`tests/integration/db/group_g1_return_exchange.integration.test.ts`、`tests/integration/db/order_return_actions.integration.test.ts`、`tests/integration/db/group_g1_concurrency.integration.test.ts`

**Interfaces（引数名/default/戻り型を最終定義どおり保持）:**

| 既存関数 | 最終CREATEの出典（supabase/migrations/） |
|---|---|
| `public.admin_record_return_fee_payment(uuid,uuid,text,boolean)`、`public.admin_release_return_exchange(uuid,uuid)` | `20261013000456_order_return_actions.sql:1231,1272` |

**値:**
- 既存置換2本。交換行のactive保留は `fee_due_amount>0 AND fee_received_at IS NULL AND exchange_released_at IS NULL`。保留中は自動割当/発送/将来入替の対象外。入金・免除・支払前発送承認で解ければ元注文日で通常FIFO。他の保留は維持しorders.paid_atを変えない。

- [ ] **Step 1: この関数群の失敗するDB試験を書く。** 保留中A0、入金/免除/支払前承認後は通常順位、他の保留中はA0、再送増分0/paid_at不変、保留解除対入庫の並行性をassertする。 想定拒否はSAVEPOINTで回収し、単純なmockを実経路成功としない。
- [ ] **Step 2（controller）: SQL実装前のREDを返す。** `npx.cmd supabase db reset` → 共通anon/authenticated PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db/group_g1_exchange_fee.integration.test.ts tests/integration/db/group_g1_return_exchange.integration.test.ts tests/integration/db/order_return_actions.integration.test.ts tests/integration/db/group_g1_concurrency.integration.test.ts --runInBand`。未導入/契約違反のREDを記録して実装者へ返す。
- [ ] **Step 3: 上表の関数群だけを置換する。** 共通lockより前の行lockを除き、全対象を事前収集/取得してから既存coreへ進む。before→業務変更→解放/復元→FIFO→after/event/operationを同取引とし、子から公開RPCへ再入しない。外部I/Oは取引外に保つ。
- [ ] **Step 4（controller）: reset後のDB結果を実装者へ返してからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ Step 2のDBコマンド。失敗修正後も同順で再実行し、GREEN/skip実数を記録する。
- [ ] **Step 5（controller）: レビュー後、Filesだけコミットする。** `feat(returns): 交換手数料の保留解除を通常FIFOへ接続する（G-1）`

### Task 13: 配送反映と版を含む再送キー（既存2本）

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`
- Test/modify tests: `tests/integration/db/group_g1_delivery.integration.test.ts`、`tests/integration/db/delivery_tracking_sync.integration.test.ts`、`tests/integration/db/group_g1_concurrency.integration.test.ts`

**Interfaces（引数名/default/戻り型を最終定義どおり保持）:**

| 既存関数 | 最終CREATEの出典（supabase/migrations/） |
|---|---|
| `public.record_delivery_read_result(uuid,integer,uuid,jsonb)`、`private.apply_tracking_status(uuid,text,timestamptz,timestamptz)` | `20261021221410_delivery_tracking_sync.sql:493,35` |

**値:**
- 既存置換2本。外側record_delivery_read_resultが共通advisory→前段の対象行→配送/登録/設定の順に取り、private.apply_tracking_statusは取得済みlockだけで動く。有効な配送反映と品物状態eventを同取引で確定する。lease/旧版/取消/通知のE-4契約を維持する。
- 配達反映operation=`delivery_reflect`、event=`delivered`。冪等キーを **`pg_catalog.md5('delivery:' || _fulfillment_id::text || ':' || _tracking_version::text || ':' || 'delivered')::uuid`** と固定する（fulfillment_id＋tracking_version＋event）。cause_type=`fulfillment`、cause_id=`_fulfillment_id::text`。同版同eventは0増分だが訂正版の正当なdeliveredを抑止しない。発送票/追跡親/訂正の新公開入口は作らない。

- [ ] **Step 1: この関数群の失敗するDB試験を書く。** 版1のdelivered→同一再送はoperation/状態履歴1件、local fixtureだけでtracking訂正を合成して版2/発送済みに戻す→新deliveredは2件目が保存されることをassertする。旧版/lease不一致は増分0。訂正fixtureを旧RPCの成功試験と報告しない。 想定拒否はSAVEPOINTで回収し、単純なmockを実経路成功としない。
- [ ] **Step 2（controller）: SQL実装前のREDを返す。** `npx.cmd supabase db reset` → 共通anon/authenticated PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db/group_g1_delivery.integration.test.ts tests/integration/db/delivery_tracking_sync.integration.test.ts tests/integration/db/group_g1_concurrency.integration.test.ts --runInBand`。未導入/契約違反のREDを記録して実装者へ返す。
- [ ] **Step 3: 上表の関数群だけを置換する。** 共通lockより前の行lockを除き、全対象を事前収集/取得してから既存coreへ進む。before→業務変更→解放/復元→FIFO→after/event/operationを同取引とし、子から公開RPCへ再入しない。外部I/Oは取引外に保つ。
- [ ] **Step 4（controller）: reset後のDB結果を実装者へ返してからレビューする。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ Step 2のDBコマンド。失敗修正後も同順で再実行し、GREEN/skip実数を記録する。
- [ ] **Step 5（controller）: レビュー後、Filesだけコミットする。** `feat(delivery): tracking版ごとの配達反映と状態履歴を保存する（G-1）`

### Task 14: 旧RPC・HTTP入口の停止、API/store/履歴・文書と末尾assert

**Files:**
- Modify: `supabase/migrations/<ts>_group_g1_allocation.sql`、`src/app/api/admin/orders/route.ts`、`src/app/api/admin/orders/[id]/history/route.ts`、`src/lib/orders/email/order-history.ts`
- Modify: `src/app/api/admin/orders/[id]/fulfillments/route.ts`、`src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route.ts`、`src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking/route.ts`、`src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered/route.ts`、`src/app/api/admin/orders/[id]/completions/route.ts`、`src/app/api/admin/orders/[id]/completions/[completionId]/cancel/route.ts`
- Modify: `src/lib/orders/tracking/delivery-store.ts`、`src/lib/orders/fulfillment/fulfillment-store.ts`、`src/lib/orders/fulfillment/fulfillment-materials.ts`
- Create: `src/lib/orders/fulfillment/legacy-fulfillment-disabled.ts`、`tests/integration/db/group_g1_legacy_disabled.integration.test.ts`、`tests/integration/db/group_g1_writer_inventory.integration.test.ts`
- Modify tests: `tests/unit/lib/orders/tracking/delivery-store.test.ts`、`tests/unit/lib/orders/fulfillment/fulfillment-store.test.ts`、`tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts`、`tests/unit/api/admin/order-fulfillment-routes.test.ts`、`tests/unit/api/admin/order-delivery-routes.test.ts`、`tests/unit/api/admin/order-completion-routes.test.ts`、`tests/unit/api/admin/orders-search-route.test.ts`、`tests/unit/lib/orders/email/order-history.test.ts`、`tests/unit/lib/orders/email/order-history-requests.test.ts`、`tests/unit/lib/orders/email/order-history-delivery.test.ts`、`tests/unit/docs/delivery-status-traceability.test.ts`
- Modify tests（停止と同じTaskで変更）: `tests/integration/db/order_fulfillments.integration.test.ts`、`tests/integration/db/fulfillment_order_emails.integration.test.ts`、`tests/integration/db/delivery_tracking_admin.integration.test.ts`、`tests/integration/db/fulfillment_postgrest.integration.test.ts`、`tests/integration/db/delivery_tracking_postgrest.integration.test.ts`、`tests/integration/db/return_postgrest.integration.test.ts`。旧4RPCの成功期待はLEGACY_FULFILLMENT_DISABLED/55000へ、completionの旧成功期待はMANUAL_COMPLETION_DISABLED/55000へ。返金/返品/readの材料だけはlocal合成発送へ置換する。
- Docs: `docs/02_Requirements/requirements.md`、`docs/04_DetailDesign/pages/16_admin.md`、`docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`
- Read/regression: 下の64 direct importers。UI/client行はTask 15が担当し、そのtaskへFilesを分ける。維持行は不要な編集をしない。

**Interfaces（実コードで見つかった旧4RPCの正確なsignature）:**

| 関数 | 最終定義 | 維持するRETURNS |
|---|---|---|
| `public.admin_create_fulfillment(_order_id uuid,_actor_id uuid,_request_key uuid,_shipping_carrier text,_tracking_number text,_notify_customer boolean,_lines jsonb)` | `supabase/migrations/20261021221140_delivery_tracking_admin.sql:223` | TABLE(fulfillment_id uuid,number integer,completes_order boolean,order_status public.order_status,replayed boolean) |
| `public.admin_cancel_fulfillment(_order_id uuid,_fulfillment_id uuid,_actor_id uuid)` | 同 `:438` | TABLE(outcome text,order_status public.order_status) |
| `public.admin_update_fulfillment_tracking(_order_id uuid,_fulfillment_id uuid,_actor_id uuid,_request_key uuid,_shipping_carrier text,_tracking_number text,_notify_customer boolean)` | 同 `:545` | TABLE(tracking_change_id uuid,tracking_version integer,replayed boolean) |
| `public.admin_mark_fulfillment_delivered(_order_id uuid,_fulfillment_id uuid,_actor_id uuid,_request_key uuid,_delivered_on date,_notify_customer boolean)` | 同 `:702` | TABLE(event_id uuid,delivered_at timestamptz,replayed boolean) |

- 4本とも引数検証/lock/参照/再送判定より先に `RAISE EXCEPTION 'LEGACY_FULFILLMENT_DISABLED' USING ERRCODE='55000'`。旧bodyをprivateへ移して残さず、service_role用の固定拒否入口だけ残す。G-3でも再開しない。
- 手動仕上がりの最終定義は `public.admin_record_completion(uuid,uuid,uuid,jsonb)` / `public.admin_cancel_completion(uuid,uuid,uuid)`、`20261010120303_order_fulfillments.sql:354/450`。戻り型を保ち、同様に `MANUAL_COMPLETION_DISABLED / 55000` で即拒否。completion表はservice_role含む書込みを剥がし、通常owner SQLの新規INSERT/UPDATEも `MANUAL_COMPLETION_DISABLED / 55000` の `private.reject_group_g_manual_completion() RETURNS trigger` / `order_item_completions_disabled`（BEFORE INSERT OR UPDATE、行）で拒否する。旧read/backfillを新投影から呼ばない。`private.backfill_legacy_fulfillments()`（`20261010120303_order_fulfillments.sql:670`）と `private.link_legacy_shipped_emails()`（`20261010122320_fulfillment_order_emails.sql:15`）は **DROP（CASCADEなし）**。この2本を加えて既存関数の置換/廃止は8本。DROP済みfinalize/admin_ship_paid_order/apply_order_refund_projectionも復活させない。
- 停止4HTTP POSTは既存認可/MFA/CSRF/回数制限後に410 `{ code:'LEGACY_FULFILLMENT_DISABLED', error:LEGACY_FULFILLMENT_DISABLED_TEXT }`。completion POST2本は410 `{ code:'MANUAL_COMPLETION_DISABLED', error:MANUAL_COMPLETION_DISABLED_TEXT }`。fulfillments GETも認可後同410。`Cache-Control: no-store`、副作用RPC0回、監査は既存actionのfailureと固定codeのみ。未知入力を理由に旧業務へ落とさない。

**値（固定停止定義/API）:**

- `LEGACY_FULFILLMENT_DISABLED_TEXT = '発送・発送取消・伝票番号の訂正・手動の配達済みは、発送票の公開まで利用できません。'`
- `MANUAL_COMPLETION_DISABLED_TEXT = '仕上がりの手動記録・取消は終了しました。在庫の入荷から自動で割り当てます。'`

- `LegacyFulfillmentDisabledError` を停止文moduleに定義し、`code: 'LEGACY_FULFILLMENT_DISABLED'|'MANUAL_COMPLETION_DISABLED'`、`sqlstate:'55000'`、messageはcodeとする。fulfillment-storeのcreate/cancelは前者、recordCompletion/cancelCompletionは後者を直ちにthrowしRPC0。delivery-storeのupdateFulfillmentTracking/markFulfillmentDeliveredも前者で即throw。他の読取/worker/設定/要対応関数は維持する。
- routeファイル/HTTP exportは削除しない。停止6POST＋fulfillments GETの **7メソッド** は上記410 body全文/固定code。route数は **132ファイル / 171メソッド** を維持する（一覧はE2E用1入口を除く131行/170メソッド）。`api-spec.md`の旧成功契約/入力schema参照と追跡節、`route-inventory.md`の6パス/7メソッド行をG-1停止へ更新し、認可/CSRF/回数制限後410・G-3の新票へ移ることを書く。

**値（importerの全検索結果）:**

`rg -l 'OrderShipDialog|OrderCompletionDialog|OrderTrackingEditDialog|OrderDeliveredDialog|orders/fulfillment/fulfillment-(store|materials|client)|orders/tracking/delivery-(store|client)' src tests -g '*.ts' -g '*.tsx'` で列挙する。module自体のimportも含める。64 direct importersを列挙する。相対importも解決して照合し、追加importerが出たら同じ判定を行う。

| importer | 処置 |
|---|---|
| `src/app/admin/page.tsx` | Task 15で旧4dialogのimport/state/mountと発送・仕上がりhandler/propsを撤去。注文取得/履歴を開く配線は残し、一覧に固定停止文を表示する。HTTP routeではない。 |
| `src/app/api/admin/order-attention/deliveries/[attentionId]/resolve/route.ts` | 維持。配送要対応のresolveDeliveryAttentionを維持、既存guard/RPC/200の回帰。旧手動配達RPCを使わない。 |
| `src/app/api/admin/order-attention/route.ts` | 維持。要対応の集計/配送summary読取を維持。GET200と既存権限/非公開項目の回帰。 |
| `src/app/api/admin/orders/[id]/completions/[completionId]/cancel/route.ts` | POSTを認可/MFA/CSRF/回数制限後410・MANUAL_COMPLETION_DISABLEDの固定body、RPC0へ。 |
| `src/app/api/admin/orders/[id]/completions/route.ts` | POSTを認可/MFA/CSRF/回数制限後410・MANUAL_COMPLETION_DISABLEDの固定body、RPC0へ。 |
| `src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route.ts` | POSTを認可/MFA/CSRF/回数制限後410・LEGACY_FULFILLMENT_DISABLEDの固定body、RPC0へ。 |
| `src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered/route.ts` | POSTを認可/MFA/CSRF/回数制限後410・LEGACY_FULFILLMENT_DISABLEDの固定body、RPC0へ。 |
| `src/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking/route.ts` | POSTを認可/MFA/CSRF/回数制限後410・LEGACY_FULFILLMENT_DISABLEDの固定body、RPC0へ。 |
| `src/app/api/admin/orders/[id]/fulfillments/route.ts` | POSTは認可/MFA/CSRF/回数制限後、GETは既存認可後、それぞれ410・LEGACY_FULFILLMENT_DISABLEDの固定body。loadFulfillmentMaterials/RPCとも0回。 |
| `src/app/api/admin/orders/[id]/history/route.ts` | GETの200/history shapeを維持。Promise.allからlistOrderCompletionsとcompletions引数を削除。発送/追跡/メール/返金/返品/取消申請とread用の明細数量は残す。410にしない。 |
| `src/app/api/admin/orders/route.ts` | GETの200/検索/既存JSON shapeを維持しcanShip=false・canRecordCompletion=false。listOrderLineFulfillmentはTask 5のG-1互換読取を使い、取消/返金/返品/要対応の能力は残す。410にしない。 |
| `src/app/api/admin/settings/shop/route.ts` | 維持。deliveryTrackingの設定保存/再読込・backfill契約を維持。旧伝票訂正/手動配達の成功条件を増やさない。 |
| `src/app/api/orders/[id]/route.ts` | 維持。会員の明細/実配送読取を維持。客向け語彙/公開shape/所有権の回帰。 |
| `src/app/api/orders/route.ts` | 維持。会員一覧の実配送summary/数量読取を維持。客向け語彙/公開shapeの回帰。 |
| `src/app/api/webhook/17track/route.ts` | 維持。raw body署名検証/配送イベント受付とworker用storeを維持。新再送キーはTask 13でDB反映する。 |
| `src/app/privacy/page.tsx` | 維持。追跡設定によるプライバシー説明の読取だけを維持。配送操作入口を追加しない。 |
| `src/components/OrderCancelRequestDialog.tsx` | 維持。lineLabel/clampQuantity等の共有helperと取消申請の既存操作を維持。注文取消は停止対象外。 |
| `src/components/OrderCompletionDialog.tsx` | Task 15で削除。停止は既存OrderSection内の固定停止文をAdminGroupG1LegacyStop.test.tsxで検証 |
| `src/components/OrderDeliveredDialog.tsx` | Task 15で削除。停止は既存OrderHistoryDialog内の固定停止文をAdminGroupG1LegacyStop.test.tsxで検証 |
| `src/components/OrderHistoryDialog.tsx` | Task 15で伝票訂正/手動配達/この発送を取り消すのbutton・POST・dialogとcompletion/cancel描画を削除。発送/追跡/返金/返品/申請/メール履歴は表示し配送停止文を1回置く。 |
| `src/components/OrderRefundDialog.tsx` | 維持。返金の数量入力/共有helperを維持、返金の実処理と状態を回帰。 |
| `src/components/OrderReturnActionDialogs.tsx` | 維持。返品取消/未着等の既存操作と共有helperを維持。旧発送取消との混同を防ぐ。 |
| `src/components/OrderReturnCreateForm.tsx` | 維持。返品対象の発送/明細readと共有helperを維持、実返品受付を回帰。 |
| `src/components/OrderReturnReceiveDialog.tsx` | 維持。返品受取/棚戻しの入力と共有helperを維持、棚戻しはTask 11の実FIFO経路。 |
| `src/components/OrderReturnRefundDialog.tsx` | 維持。返品返金の入力/金銭操作を維持。発送操作の成功をstubしない。 |
| `src/components/OrderReturnReviewDialog.tsx` | 維持。返品申請の承認/却下と共有helperを維持。既存readを回帰。 |
| `src/components/OrderReturnsDialog.tsx` | 維持。返品一覧/操作/共有helperを維持、発送材料のみlocal合成fixture。 |
| `src/components/OrderShipDialog.tsx` | Task 15で削除。停止は既存OrderSection内の固定停止文をAdminGroupG1LegacyStop.test.tsxで検証 |
| `src/components/OrderTrackingEditDialog.tsx` | Task 15で削除。停止は既存OrderHistoryDialog内の固定停止文をAdminGroupG1LegacyStop.test.tsxで検証 |
| `src/components/ReturnDialogParts.tsx` | 維持。lineLabel/clampQuantityなど返品用の共有部品を維持。 |
| `src/lib/orders/customer-order-view-types.ts` | 維持。公開配送の型importを維持。管理停止code/内部割当情報を顧客JSONへ追加しない。 |
| `src/lib/orders/email/order-email-compose.ts` | 維持。メール組立用の発送/配送readを維持、G-1停止操作の成功メールを新規生成しない。 |
| `src/lib/orders/email/order-history.ts` | Task 14でcompletion/completion_cancelの合成/並び優先度を削除し、引数completionsは渡されても無視する。次TaskのUIを型検証可能にする間だけ `completions?: OrderCompletionHistoryRow[]` と既存entry型/unionを残し、Task 15で最後のUI参照と同時にその入力/型/importを削除する。発送/追跡/金銭/申請/メールの時系列と公開shapeを維持。旧completion表示の互換機能は作らない。HTTPは扱わない。 |
| `src/lib/orders/fulfillment/fulfillment-materials.ts` | loadFulfillmentMaterials(client,orderId)のsignatureを残しLegacyFulfillmentDisabledErrorを即throw。orders/例外/明細/発送/配送のDB読取を全て0回にする。HTTP応答はroute側の責任。 |
| `src/lib/orders/returns/cancel-request-reads.ts` | 維持。取消申請用の実明細数量読取を維持。Task 5の互換RPCでG-1数量を得る。 |
| `src/lib/orders/status/status-store.ts` | 維持。公開リンクの実配送/返金/返品readを維持、公開範囲を回帰。 |
| `src/lib/orders/tracking/delivery-route-support.ts` | 維持。配送guard/error整形などworker/設定/要対応の共通処理を維持。停止POSTはguard後の固定410。 |
| `src/lib/orders/tracking/delivery-worker.ts` | 維持。配送claim/register/read/stop/expireのworker契約を維持。旧管理4RPCを呼ばない。 |
| `tests/integration/db/delivery_tracking_postgrest.integration.test.ts` | **Task 14担当**。旧4RPCの成功caseを直接PostgREST RPCのLEGACY_FULFILLMENT_DISABLED/code=55000へ書換。戻り型/readの回帰に必要な材料はlocal合成発送。G-1完了まで変更を延期しない |
| `tests/integration/db/fulfillment_postgrest.integration.test.ts` | **Task 14担当**。旧4RPCの成功caseを直接PostgREST RPCのLEGACY_FULFILLMENT_DISABLED/code=55000へ書換。戻り型/readの回帰に必要な材料はlocal合成発送。G-1完了まで変更を延期しない |
| `tests/integration/db/return_postgrest.integration.test.ts` | **Task 14担当**。createFulfillment(store)による材料作成をlocal pgのseedGroupG1Allocation/seedGroupG1Shipmentへ置換し、返品の実PostgREST操作とread/公開shapeは維持。旧発送の成功を試験しない |
| `tests/unit/api/admin/order-attention-route.test.ts` | 維持。対応する上表のread/worker/設定/共有helper契約をその既存suiteで回帰し、旧操作の成功期待を追加しない |
| `tests/unit/api/admin/order-delivery-routes.test.ts` | 変更。入口なし/410と既存readの両方を検証 |
| `tests/unit/api/admin/order-email-routes.test.ts` | 維持。対応する上表のread/worker/設定/共有helper契約をその既存suiteで回帰し、旧操作の成功期待を追加しない |
| `tests/unit/api/admin/order-fulfillment-routes.test.ts` | 変更。入口なし/410と既存readの両方を検証 |
| `tests/unit/api/admin/orders-search-route.test.ts` | 200/検索/数量shapeを維持し、canShipとcanRecordCompletionは入力にかかわらずfalseとassert。取消/返金/返品等の既存能力は回帰。 |
| `tests/unit/api/admin/shop-settings-route.test.ts` | 維持。対応する上表のread/worker/設定/共有helper契約をその既存suiteで回帰し、旧操作の成功期待を追加しない |
| `tests/unit/api/orders/order-detail-progress.test.ts` | 維持。対応する上表のread/worker/設定/共有helper契約をその既存suiteで回帰し、旧操作の成功期待を追加しない |
| `tests/unit/api/orders/orders-list-progress.test.ts` | 維持。対応する上表のread/worker/設定/共有helper契約をその既存suiteで回帰し、旧操作の成功期待を追加しない |
| `tests/unit/api/webhook/17track-route.test.ts` | 維持。対応する上表のread/worker/設定/共有helper契約をその既存suiteで回帰し、旧操作の成功期待を追加しない |
| `tests/unit/components/AdminOrderHistoryWiring.test.tsx` | Task 15でAdminPageの履歴GET配線/表示は維持し、旧dialog mount/handlerがないことをassert。UIから410要求を送らない。 |
| `tests/unit/components/OrderCompletionDialog.test.tsx` | Task 15で削除。停止は既存OrderSection内の固定停止文をAdminGroupG1LegacyStop.test.tsxで検証 |
| `tests/unit/components/OrderDeliveredDialog.test.tsx` | Task 15で削除。停止は既存OrderHistoryDialog内の固定停止文をAdminGroupG1LegacyStop.test.tsxで検証 |
| `tests/unit/components/OrderShipDialog.test.tsx` | Task 15で削除。停止は既存OrderSection内の固定停止文をAdminGroupG1LegacyStop.test.tsxで検証 |
| `tests/unit/components/OrderTrackingEditDialog.test.tsx` | Task 15で削除。停止は既存OrderHistoryDialog内の固定停止文をAdminGroupG1LegacyStop.test.tsxで検証 |
| `tests/unit/components/PrivacyPage.test.tsx` | 維持。対応する上表のread/worker/設定/共有helper契約をその既存suiteで回帰し、旧操作の成功期待を追加しない |
| `tests/unit/lib/orders/email/order-history.test.ts` | completion/completion_cancelの成功合成だけ撤去し、発送/追跡/返金/返品/申請/メールの時系列回帰を維持。HTTP410のassertは追加しない。 |
| `tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts` | 変更。停止write/materialは固定拒否・I/O 0、read/helper回帰は保持 |
| `tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts` | 変更。停止write/materialは固定拒否・I/O 0、read/helper回帰は保持 |
| `tests/unit/lib/orders/fulfillment/fulfillment-store.test.ts` | 変更。停止write/materialは固定拒否・I/O 0、read/helper回帰は保持 |
| `tests/unit/lib/orders/returns/cancel-request-reads.test.ts` | 維持。対応する上表のread/worker/設定/共有helper契約をその既存suiteで回帰し、旧操作の成功期待を追加しない |
| `tests/unit/lib/orders/tracking/delivery-client.test.ts` | 変更。停止write/materialは固定拒否・I/O 0、read/helper回帰は保持 |
| `tests/unit/lib/orders/tracking/delivery-store.test.ts` | 変更。停止write/materialは固定拒否・I/O 0、read/helper回帰は保持 |
| `tests/unit/lib/orders/tracking/delivery-worker.test.ts` | 維持。対応する上表のread/worker/設定/共有helper契約をその既存suiteで回帰し、旧操作の成功期待を追加しない |

**値（末尾assertの期待object集合・唯一の一覧）:**

最終 `G1_FINAL_ASSERT_BEGIN`〜`G1_FINAL_ASSERT_END` はTask 1の清掃assertに加え、以下をcatalogで検査する。不存在・型/trigger結合先の相違・ACL/owner不一致は `GROUP_G_MIGRATION_ASSERTION_FAILED / 55000`。清掃のみのTask 1では本体集合は空、各SQL Taskではここに固定した集合の導入済み部分をassertし、このTaskで全件を完成する。

| 種別 | 完全な期待値 |
|---|---|
| 新表4（全行0） | `private.group_g_operations`、`public.order_item_allocations`、`public.order_item_allocation_events`、`public.order_item_state_events`。Task 2の列/PK/FK/CHECK/UNIQUE/RLS/個別ACLと一致 |
| 追加列2 | `public.orders.paid_at timestamptz NULL`、`public.stock_movements.allocation_operation_id uuid NULL`（後者の遅延operation FKを含む） |
| 追記保護trigger9 | `public.order_item_allocation_events` の `order_item_allocation_events_no_update/order_item_allocation_events_no_delete/order_item_allocation_events_no_truncate`、`public.order_item_state_events` の `order_item_state_events_no_update/order_item_state_events_no_delete/order_item_state_events_no_truncate`、`private.group_g_operations` の `group_g_operations_no_update/group_g_operations_no_delete/group_g_operations_no_truncate`。全て `private.reject_group_g_event_mutation()` に結合、Task 2の発火時機に一致 |
| 割当trigger3 | `public.order_item_allocations` の `order_item_allocations_change_guard` → `private.guard_group_g_allocation_change()`、同表と `public.order_item_allocation_events` 各1個の `group_g_allocation_bounds` → `private.check_group_g_allocation_bounds()`（遅延constraint trigger） |
| paid_at/旧completion/stock trigger | `public.orders.orders_paid_at_once` → `private.guard_group_g_paid_at()`（BEFORE UPDATE）、`public.order_item_completions.order_item_completions_disabled` → `private.reject_group_g_manual_completion()`（BEFORE INSERT OR UPDATE）、既存 `public.stock_movements.stock_movements_apply` → `public.apply_stock_movement()`（AFTER INSERT）。これらの実在/有効状態/結合を検査 |
| writer/停止function | 下記53regprocedureが全て解決すること。private本体と公開wrapperのSECURITY/owner/search_path/個別EXECUTEは各Interfacesどおり。旧6stubは即固定error、委譲wrapperはwriteなし |
| 新non-writer function | `private.reject_group_g_event_mutation()`、`private.guard_group_g_allocation_change()`、`private.check_group_g_allocation_bounds()`、`private.guard_group_g_paid_at()`、`private.reject_group_g_manual_completion()`、`private.lock_group_g_inventory(bigint[],uuid[],uuid)`、`private.group_g_item_state_ranges(uuid[])`、`private.list_admin_order_item_states(uuid[])`、`public.list_admin_order_item_states(uuid[])`、`private.capture_group_g_item_states(uuid[])`、`private.list_group_g_variant_inventory(bigint[])`、`public.list_group_g_variant_inventory(bigint[])`、`private.list_item_allocation_history(bigint,integer)`、`public.list_item_allocation_history(bigint,integer)`、`private.group_g_writer_allowlist()`、`public.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer)`、`public.link_guest_orders(uuid,text)` |
| DROPの負の期待値2 | `to_regprocedure('private.backfill_legacy_fulfillments()') IS NULL`、`to_regprocedure('private.link_legacy_shipped_emails()') IS NULL`。CASCADEせず削除、残存依存を先に解消する |

`private.group_g_writer_allowlist() RETURNS regprocedure[]` は下記の完全な文字列53個を解決した固定配列を返すSTABLE function。postgres所有・SECURITY DEFINER・search_path=''、PUBLIC/anon/authenticated/service_role EXECUTEを個別REVOKEし、assertとpostgres DB試験だけから呼ぶ。DB writer scannerはこの集合外0をassertし、allowlist自体の値も下記と一致させる。注文関連付けはstockへ書かなくても全体lock監査のため含める。

```text
private.apply_group_g_stock_movement(bigint,integer)
private.allocate_group_g_fifo(bigint[],uuid,uuid)
private.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer)
private.record_group_g_item_state_changes(jsonb,uuid[],uuid,integer,text,uuid)
private.ensure_group_g_payment_review_hold(uuid,text,text,text,uuid)
private.release_group_g_payment_review_holds(uuid,uuid)
private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)
private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)
private.mark_order_awaiting_payment(uuid,text,text)
private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)
private.record_cancelled_order_paid_amount(uuid,text,integer)
private.admin_cancel_failed_order(uuid,uuid,text,text)
private.link_guest_orders(uuid,text)
private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)
private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)
private.apply_order_refund_state(uuid)
private.apply_return_refund_outcome(uuid,text)
private.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)
private.mark_order_refund_error(uuid,text,boolean)
private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)
private.mark_order_reviewed(uuid,uuid)
private.record_payment_exception(text,text,text,text,text,uuid,uuid)
private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)
private.resolve_payment_exception_by_system(uuid,text)
private.customer_order_for_request(uuid,uuid,boolean)
private.customer_request_cancel(uuid,uuid,uuid,jsonb,text)
private.lock_order_cancel_request(uuid)
private.admin_decline_cancel_request(uuid,uuid,text,text)
private.admin_close_cancel_request(uuid,uuid)
private.admin_resolve_cancel_request(uuid,uuid,uuid,boolean)
private.lock_order_return(uuid)
private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)
private.admin_cancel_return(uuid,uuid)
private.customer_request_return(uuid,uuid,uuid,jsonb)
private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)
private.admin_decline_return(uuid,uuid,text,text)
private.admin_close_return_missing(uuid,uuid,uuid)
private.admin_reopen_return(uuid,uuid,uuid)
private.admin_inspect_return(uuid,uuid,uuid,jsonb)
private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)
private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)
private.refresh_order_return_status(uuid)
private.admin_record_return_fee_payment(uuid,uuid,text,boolean)
private.admin_release_return_exchange(uuid,uuid)
private.record_delivery_read_result(uuid,integer,uuid,jsonb)
private.apply_tracking_status(uuid,text,timestamptz,timestamptz)
public.apply_stock_movement()
public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)
public.admin_cancel_fulfillment(uuid,uuid,uuid)
public.admin_update_fulfillment_tracking(uuid,uuid,uuid,uuid,text,text,boolean)
public.admin_mark_fulfillment_delivered(uuid,uuid,uuid,uuid,date,boolean)
public.admin_record_completion(uuid,uuid,uuid,jsonb)
public.admin_cancel_completion(uuid,uuid,uuid)
```

**値（E-4 traceabilityの保持）:**

`tests/unit/docs/delivery-status-traceability.test.ts:120-136,165,184,231` が固定する文字列は削除しない。api-spec/route-inventory/ERの `配送の入口・表は E-4 の変更を 2026-10-21 に反映`、APIのE-4節・停止対象のpath/method行頭、E-4 error行、deliveryTracking/keyConfigured/backfillCount/backfilledCount/everRegistered/admin.orders.manage/CSRF/30回/600秒、16_adminのcounts.deliveries/保存の直前/登録待ち/追跡中/対応済みにする/もう一度確かめるは保持する。旧成功契約は「停止前の契約」と明示し、各対象行の隣とE-4節内に **`G-1停止: 旧発送・発送取消・伝票訂正・手動配達済みはG-3の新発送票まで利用できません。旧入口は認可後410を返します。以下のE-4記述は停止前の契約として保持します。`** を追記する。現在の応答は上の固定410を併記する。ADMIN100〜104 / ACCOUNT041〜043内のFREQ-488〜497 ACコメントはskipしてもそのまま保持する（Task 18）。新停止注記もdoc単体で検証する。既存固定文字列の変更が必要になった場合は、このTaskのFilesにあるdelivery-status-traceability.test.tsの対応期待値と同時変更・同時検証し、文書だけを変更しない。route countsは132/171のまま。

- [ ] **Step 1: RPC停止・writer inventory・routes/store/履歴の試験を書く。** 旧4RPCの有効/NULL/再送はLEGACY_FULFILLMENT_DISABLED/55000、completion2本はMANUAL_COMPLETION_DISABLED/55000、データ/メール/割当/履歴差分0。匿名/会員拒否・2helper DROP・未許可overload検出をassertする。Filesに移した既存5停止suiteも同じTaskで書換え、4RPCのDB/PostgRESTエラーmessage/codeはLEGACY_FULFILLMENT_DISABLED/55000とする。return_postgrestの材料生成もこの段階で合成へ替え、Task 16までDB suiteのREDを持ち越さない。単体はguardが410より先、7メソッドのbody/code全文/no-store/RPC0、他のorders/history GET200、canShip/canRecordCompletion false、completion取得/合成0、store/material I/O0とread維持を固定する。
- [ ] **Step 2: 単体REDを確認する。** `npx.cmd jest tests/unit/api/admin/order-fulfillment-routes.test.ts tests/unit/api/admin/order-delivery-routes.test.ts tests/unit/api/admin/order-completion-routes.test.ts tests/unit/api/admin/orders-search-route.test.ts tests/unit/lib/orders/fulfillment/fulfillment-store.test.ts tests/unit/lib/orders/fulfillment/fulfillment-materials.test.ts tests/unit/lib/orders/tracking/delivery-store.test.ts tests/unit/lib/orders/email/order-history.test.ts --runInBand`。
- [ ] **Step 3: 6stub・2DROP・completion trigger・routes/store/履歴変更を実装する。** 表のHTTP以外を410扱いにしない。上の期待object集合/allowlist functionを作り、末尾assertを完成する。
- [ ] **Step 4: 要求8行とAPI/画面文書を最終文へ更新する。** E-4固定語/ACコメントを保持して隣に停止注記を置く。`npx.cmd jest tests/unit/docs --runInBand`、Step 2/Filesの変更単体と `npx.cmd tsc --noEmit --incremental false` をGREENにする。UI撤去は次Taskへ分ける。
- [ ] **Step 5（controller）: resetとこのSQL TaskのDBをレビュー前に行う。** `npx.cmd supabase db reset` → 共通PostgREST 2要求（各HTTP 200）→ `npx.cmd jest tests/integration/db/group_g1_legacy_disabled.integration.test.ts tests/integration/db/group_g1_writer_inventory.integration.test.ts tests/integration/db/group_g1_model.integration.test.ts tests/integration/db/order_fulfillments.integration.test.ts tests/integration/db/fulfillment_order_emails.integration.test.ts tests/integration/db/delivery_tracking_admin.integration.test.ts tests/integration/db/fulfillment_postgrest.integration.test.ts tests/integration/db/delivery_tracking_postgrest.integration.test.ts tests/integration/db/return_postgrest.integration.test.ts --runInBand`。失敗を実装者へ返し、修正後resetからGREENを確認してレビューする。
- [ ] **Step 6（controller）: Filesだけコミットする。** `feat(admin): G-1の旧RPCとHTTP入口を止めAPI文書を揃える`

**値（requirements.mdへ入れる最終6列）:**

設計13章の予約 **FREQ-520〜524・535・540〜541** を使う。最大番号+1で採番しない。535はpaid_at基盤だけ、523は入替台帳基盤だけ。540の既存AC-01〜04はそのまま保持してAC-05を追加する（それらのTask番号はG-0計画）。後段画面110〜122を完了扱いにしない。

| FREQ | 要求 | REQ-01 | 要件 | AC-xx | 検証できる受入条件 |
|---|---|---|---|---|---|
| FREQ-520 | 実割当に基づく管理の品物12状態を提供すること（G-1） | FREQ-520-REQ-01 | ・原本のenum/金額/区分と客向けの言葉を保ち、数量区間から状態を導出すること | FREQ-520-AC-01<br>FREQ-520-AC-02 | ・FREQ-520-AC-01: 12状態の数量和が原明細数量に一致し区間の重複/穴がなく、payment_in_progress/abandonedを非表示にすること（DB [状態](../../tests/integration/db/group_g1_item_states.integration.test.ts)、Task 3）<br>・FREQ-520-AC-02: NULL variantは要確認・FIFO外とし、部分取消/返品却下/返金失敗/交換と変化数量の履歴が一致すること（DB [状態](../../tests/integration/db/group_g1_item_states.integration.test.ts)、Task 3/6〜13。新一覧110はG-4） |
| FREQ-521 | F/A/Hの保存則と追記可能な割当台帳を提供すること（G-1） | FREQ-521-REQ-01 | ・空きF、入金済割当A、仮確保Hを区別し、変更を原因/数量/actor付きで同時保存すること | FREQ-521-AC-01<br>FREQ-521-AC-02 | ・FREQ-521-AC-01: F+A+Hが手元在庫となりH→A/割当では手元不変、consume/restore/release/transferが二重適用されず保存則と台帳残高が一致すること（DB [モデル](../../tests/integration/db/group_g1_model.integration.test.ts)・[FIFO](../../tests/integration/db/group_g1_fifo.integration.test.ts)、Task 2/4/6）<br>・FREQ-521-AC-02: 割当/状態/操作履歴のUPDATE/DELETE/TRUNCATEと直接DMLを拒否し、eventの失敗で在庫も全rollbackすること（同モデル、Task 2/14） |
| FREQ-522 | 古い待ち注文からFIFOで自動割当すること（G-1） | FREQ-522-REQ-01 | ・入荷/未確保入金/解放/返品戻し/棚卸増/保留解除/申請却下の全契機で同じ全体lock順を使うこと | FREQ-522-AC-01<br>FREQ-522-AC-02 | ・FREQ-522-AC-01: orders.created_at・orders.id・order_items.idの昇順で部分割当し、案Aで買い手自身のcheckout確保を保持し、NULL/不一致hold/交換手数料待ちを除外すること（DB [FIFO](../../tests/integration/db/group_g1_fifo.integration.test.ts)・[支払保留](../../tests/integration/db/group_g1_payment_review.integration.test.ts)、Task 4〜13）<br>・FREQ-522-AC-02: 全更新入口が行lockより前に共通advisoryを取り、並行入荷/入金/解放/返金/返品/保留解除で逆順待ち・二重割当・負在庫が起きないこと（DB [並行](../../tests/integration/db/group_g1_concurrency.integration.test.ts)、Task 4〜14） |
| FREQ-523 | 同variant間の割当入替を表現する基盤を提供すること（G-1基盤） | FREQ-523-REQ-01 | ・双方の数量/相手参照/理由を追記可能な台帳で表し、公開の入替業務はG-4で提供すること | FREQ-523-AC-01 | ・FREQ-523-AC-01: transferの両側同数量・相互参照を必須とし片側だけの取引を拒否、全A/F数量を保存すること（DB [モデル](../../tests/integration/db/group_g1_model.integration.test.ts)、Task 2。公開操作/FR-ADMIN-112はG-4未実装） |
| FREQ-524 | 確認付き清掃とG-1への原子的切替・旧入口停止を提供すること | FREQ-524-REQ-01 | ・31表の条件/件数を明示確認し、1 migrationの清掃と本体を同時確定すること | FREQ-524-AC-01<br>FREQ-524-AC-02<br>FREQ-524-AC-03<br>FREQ-524-AC-04 | ・FREQ-524-AC-01: 全対象表に行がある本番相当状態で清掃と本体が一度に成功し、末尾の故障注入で全行/在庫/定義が復元すること（DB [清掃](../../tests/integration/db/group_g1_cleanup.integration.test.ts)、Task 1/16）<br>・FREQ-524-AC-02: 本番直前のwriter/cron確認とcount再読取・owner明示確認を行い、未確認/説明不能の差があれば適用を止め、法定削除保護の取引内停止と全商品売切れを説明すること（controller Task 19）<br>・FREQ-524-AC-03: 手動仕上がりをMANUAL_COMPLETION_DISABLED、旧配送4RPCをLEGACY_FULFILLMENT_DISABLEDで即拒否し、旧操作入口を撤去して停止文を表示すること（DB [停止](../../tests/integration/db/group_g1_legacy_disabled.integration.test.ts)、単体 [入口](../../tests/unit/components/AdminGroupG1LegacyStop.test.tsx)、E2E [123](../../e2e/FR-ADMIN-123-group-g-permissions.spec.ts)、Task 14/15/18）<br>・FREQ-524-AC-04: 新seed/fixtureがG-1制約に整合し、旧配送成功試験の停止/書換とG-3再開先を記録すること（Task 16/17/18、FR-ADMIN-069/073/123） |
| FREQ-535 | 初回入金日時を一度だけ記録すること（G-1基盤） | FREQ-535-REQ-01 | ・orders.paid_atを実入金成功を初めてDBへ記録した時刻で固定すること | FREQ-535-AC-01 | ・FREQ-535-AC-01: 正常/不一致/期限後/取消後の初回入金で一度だけ設定し、再送/CAS不一致/交換手数料/返金で変更せずNULL戻しも拒否すること（DB [入金](../../tests/integration/db/group_g1_payment.integration.test.ts)・[手数料](../../tests/integration/db/group_g1_exchange_fee.integration.test.ts)、Task 7/12。出荷日範囲/訂正/FR-ADMIN-118はG-3未実装） |
| FREQ-540 | DB ACL・有効なsession・2要素認証と固定権限で、管理操作の権限と店長の保護を保証すること（G-0/G-1部分） | FREQ-540-REQ-01 | ・G-0の権限設定/固定2権限/昇格と最後の店長の保護を維持し、G-1の新object直接DMLと旧業務の迂回を拒否すること。在庫/発送の新権限への業務切替はG-2/G-3に残すこと | FREQ-540-AC-01<br>FREQ-540-AC-02<br>FREQ-540-AC-03<br>FREQ-540-AC-04<br>FREQ-540-AC-05 | ・FREQ-540-AC-01: 新GET/POSTは毎回DB ACL・active session・aal2のadmin.permissions.manage、既存PATCHはadmin.users.manageで許可すること。直URLのGET拒否では表を出さないこと（単体 [GET](../../tests/unit/api/admin/permissions-route.test.ts)・[POST](../../tests/unit/api/admin/role-permissions-route.test.ts)・[PATCH](../../tests/unit/api/admin/users-route.test.ts)・[RBAC](../../tests/unit/lib/auth/admin-rbac.test.ts)＝Task 2、[ページ](../../tests/unit/components/RolePermissionsPage.test.tsx)＝Task 3、DB [role_permissions](../../tests/integration/db/role_permissions.integration.test.ts)＝Task 1 / controller、E2E [FR-ADMIN-123](../../e2e/FR-ADMIN-123-group-g-permissions.spec.ts)＝Task 4）<br>・FREQ-540-AC-02: supporter/userの昇格とuser_roles直接DML、自己役割変更を拒否し、有効な店長を1人以上保持すること。固定2コード以外を全解除した店長も権限画面/戻るリンクを使えること（単体 [PATCH](../../tests/unit/api/admin/users-route.test.ts)＝Task 2、[ページ](../../tests/unit/components/RolePermissionsPage.test.tsx)＝Task 3、DB [role_permissions](../../tests/integration/db/role_permissions.integration.test.ts)・[別接続競合](../../tests/integration/db/role_permissions_concurrency.integration.test.ts)＝Task 1 / controller、E2E [FR-ADMIN-123](../../e2e/FR-ADMIN-123-group-g-permissions.spec.ts)＝Task 4）<br>・FREQ-540-AC-03: ACLの直接更新と差分イベントのUPDATE/DELETE/TRUNCATEを拒否し、has_permissionの役割名による固定許可を撤去してDB ACLへ統一すること。画面は既知code→既知reason→statusの固定文だけを表示すること（単体 [RBAC](../../tests/unit/lib/auth/admin-rbac.test.ts)＝Task 2、[画面](../../tests/unit/components/RolePermissionsSection.test.tsx)＝Task 3、DB [role_permissions](../../tests/integration/db/role_permissions.integration.test.ts)＝Task 1 / controller、E2E [FR-ADMIN-123](../../e2e/FR-ADMIN-123-group-g-permissions.spec.ts)＝Task 4）<br>・FREQ-540-AC-04: 初期発送2コードの登録/付与/設定保存と再読込に対応し、G-0初期値合わせは一度だけとすること。後続移行は既存設定を再投入せず、新コードだけをadminへON CONFLICT DO NOTHINGで追加し、固定2コードを保護すること（現G-0のDB [role_permissions](../../tests/integration/db/role_permissions.integration.test.ts)＝Task 1 / controller、単体 [catalog](../../tests/unit/lib/auth/role-permission-catalog.test.ts)＝Task 2、[画面](../../tests/unit/components/RolePermissionsSection.test.tsx)＝Task 3、E2E [FR-ADMIN-109](../../e2e/FR-ADMIN-109-permission-settings.spec.ts)＝Task 4。後続移行の順守と業務窓口のAND条件は後段担当、未実装/未検証）<br>・FREQ-540-AC-05: 新private objectを個別REVOKEしprivate schema USAGEとpre-request hookを保持し、旧6RPC/HTTPとclient/storeからの迂回を拒否すること（DB [モデル](../../tests/integration/db/group_g1_model.integration.test.ts)・[停止](../../tests/integration/db/group_g1_legacy_disabled.integration.test.ts)、単体 [入口](../../tests/unit/components/AdminGroupG1LegacyStop.test.tsx)、E2E [123](../../e2e/FR-ADMIN-123-group-g-permissions.spec.ts)、G-1 Task 2/14/15/18） |
| FREQ-541 | E-1〜E-5の金銭/数量/配送/返品/メールと顧客公開範囲を保持すること（G-1部分） | FREQ-541-REQ-01 | ・G-1の停止操作を除く既存契約を回帰し、除外理由と再開先を追跡すること | FREQ-541-AC-01<br>FREQ-541-AC-02 | ・FREQ-541-AC-01: 合成発送を材料にする回帰で金銭/数量/客語/公開フィールドが変わらず、別注文情報を漏らさないこと（DB/単体 Task 3〜17、既存E2Eの処置表 Task 18）<br>・FREQ-541-AC-02: 全件E2Eを最新baselineと比較し停止/削除/追加と未確認境界を分け、停止操作を成功と数えないこと（controller Task 19。FR-ADMIN-120はG-3、122はG-4） |

### Task 15: 旧配送・手動仕上がりUIの撤去とclient/単体

**Files:**
- Modify: `src/app/admin/page.tsx`、`src/components/OrderSection.tsx`、`src/components/OrderHistoryDialog.tsx`、`src/components/ShopSettingsSection.tsx`、`src/lib/orders/fulfillment/fulfillment-client.ts`、`src/lib/orders/tracking/delivery-client.ts`、`src/lib/orders/email/order-history.ts`（一時的なcompletion型/入力を最後に削除）
- Delete: `src/components/OrderShipDialog.tsx`、`src/components/OrderCompletionDialog.tsx`、`src/components/OrderTrackingEditDialog.tsx`、`src/components/OrderDeliveredDialog.tsx`、`tests/unit/components/OrderShipDialog.test.tsx`、`tests/unit/components/OrderCompletionDialog.test.tsx`、`tests/unit/components/OrderTrackingEditDialog.test.tsx`、`tests/unit/components/OrderDeliveredDialog.test.tsx`
- Create: `tests/unit/components/AdminGroupG1LegacyStop.test.tsx`
- Modify tests: `tests/unit/components/OrderSection.actions.test.tsx`、`tests/unit/components/OrderHistoryDialog.test.tsx`、`tests/unit/components/AdminOrderHistoryWiring.test.tsx`、`tests/unit/components/ShopSettingsSection.test.tsx`、`tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts`、`tests/unit/lib/orders/tracking/delivery-client.test.ts`
- Read: Task 14の2定数/store/material契約・64 direct importers、`tests/unit/docs/delivery-status-traceability.test.ts`、`docs/04_DetailDesign/pages/16_admin.md`。文書を追加変更する場合はこのTaskのFilesへ移して同時検証する。

**Interfaces:** 既存client exportの引数/戻り型は保持する。shared純粋helperは保持し、停止対象clientは下記固定拒否・fetch0。新しい画面/routeは作らない。Task 14で一時保持したcompletionのTS型/optional入力も、最後のUI参照を外すこのTaskで削除する。

**値（UI入口・停止文）:** Task 14の2定数を既存 `OrderSection` / `OrderHistoryDialog` 内へ直接表示する。`tests/unit/components/AdminGroupG1LegacyStop.test.tsx` はその2componentをrenderする単体であり、同名の新componentファイルは作らない。

| 既存入口のfile:line | 変更 |
|---|---|
| `src/components/OrderSection.tsx:456,467`、`src/app/admin/page.tsx:792,797,1343,1344,1351,1358` | 「仕上がりを記録する」「発送済みにする」のbutton/props/handler/dialog state/import/mountを撤去。注文一覧の操作欄の上に停止文2つを1回表示 |
| `src/components/OrderHistoryDialog.tsx:493,520,534,548` | 「伝票番号を直す」「配達済みにする」「この発送を取り消す」と関連dialog/POST処理を撤去。履歴の上に配送停止文を表示 |
| `src/components/OrderHistoryDialog.tsx:577`以降 | completion/cancelの描画・取消操作を撤去。Task 14で除いたcompletion取得/合成に合わせて一時保持のTS型/union/入力も外す。旧履歴互換表示は追加しない |

- 注文自体の「キャンセル」は停止対象ではない。「発送取消」と区別し、返金/返品/申請/履歴の閲覧・配送の要対応を閉じる操作を残す。共有UI部品を作り替えず、390/768/1280で停止文が折り返されるようにする。

- 既存TS exportのsignatureは保持する。`callFulfillmentApi`はcompletionsパスなら手動停止文、それ以外は配送停止文の `{kind:'refused',message:固定文}` を返しfetch0。`fetchFulfillmentMaterials`は `{ok:false,message:LEGACY_FULFILLMENT_DISABLED_TEXT}`、delivery-clientのsubmitTrackingEdit/submitManualDeliveredは `{kind:'refused',message:LEGACY_FULFILLMENT_DISABLED_TEXT}` でfetch0。lineLabel/clampQuantityと履歴/返品用の読取は保持する。
- `src/components/ShopSettingsSection.tsx:57` の第三説明を **`伝票番号の訂正と手動の配達済みは、発送票の公開まで利用できません。`** に置換する。「オフの間も…できます」は表示しない。


- [ ] **Step 1: UI/clientの停止単体を書く。** 偽canShip/canRecordCompletion/cancellableでも「発送済みにする」「この発送を取り消す」/伝票訂正/手動配達/手動仕上がりの入口0、2停止文が指定箇所に各1回、注文取消/返金/返品/readと履歴を開く配線は残ることをassertする。ShopSettings第三説明の新全文と旧文不存在、client fetch0/共有helper維持を固定する。
- [ ] **Step 2: REDを確認する。** `npx.cmd jest tests/unit/components/AdminGroupG1LegacyStop.test.tsx tests/unit/components/OrderSection.actions.test.tsx tests/unit/components/OrderHistoryDialog.test.tsx tests/unit/components/AdminOrderHistoryWiring.test.tsx tests/unit/components/ShopSettingsSection.test.tsx tests/unit/lib/orders/fulfillment/fulfillment-client.test.ts tests/unit/lib/orders/tracking/delivery-client.test.ts --runInBand`。
- [ ] **Step 3: 旧button/handler/state/import/mount/dialogを撤去しclientを固定拒否へ変える。** 削除dialogの成功単体を停止単体へ置換し、order-historyの一時保持completion型/optional入力と全参照を削除する。Task 14のimporter表を再grepする。390/768/1280で停止文を折り返す。新しい業務UIを足さない。
- [ ] **Step 4: 単体/文書/型をGREENにする。** Step 2に加え `npx.cmd jest tests/unit/docs --runInBand` と `npx.cmd tsc --noEmit --incremental false`。E-4の固定語は保持し、変更が必要ならdelivery-status-traceability.test.tsを同じFilesへ追加して同時修正する。
- [ ] **Step 5（controller）: レビュー後Filesだけコミットする。** `feat(admin): G-1の旧配送と手動仕上がりのUI入口を撤去する`

### Task 16: DB合成fixture・seed・既存DB suiteの最終整合

**Files:**
- Modify: `supabase/seed.sql`、`tests/integration/db/helpers/order-fixtures.ts`、`tests/integration/db/helpers/delivery-tracking-fixtures.ts`、`tests/integration/db/helpers/group-g1-fixtures.ts`（Task 4作成/Task 5拡張済み）
- Create: `tests/integration/db/group_g1_fixtures.integration.test.ts`
- Modify tests: Task 4〜13のDB suiteと `tests/integration/db/order_email_enqueue.integration.test.ts`、`tests/integration/db/order_refund_records.integration.test.ts`、`tests/integration/db/order_return_records.integration.test.ts`、`tests/integration/db/order_status_returns.integration.test.ts`、`tests/integration/db/refund_postgrest.integration.test.ts`。
- Read/regression: Task 14のFilesに列挙し既に書換/合成化済みの6suite。停止成功期待の修正をこのTaskまで残さない。

**Interfaces / 値（DB/E2E材料の共通契約）:**
- `withGroupG1FixtureTransaction<T>(client: PgClient,run:()=>Promise<T>): Promise<T>`。localhost/127.0.0.1接続だけ許可。外側transactionがなければBEGIN→共通advisory→run→COMMIT、既存transaction内なら共通advisoryを最初の行lockより前に取得済みであることをcaller契約にしSAVEPOINT→run→RELEASE。失敗時は該当transaction/SAVEPOINTへROLLBACK。callerの取引を勝手にCOMMITしない。nestedであるかはhelper側のtransaction contextで管理し、エラー試行で検出しない。
- `seedGroupG1Allocation(client: PgClient,input:{orderItemId:string;quantity:number;kind:'payment_hold'|'paid'}): Promise<string|null>`。quantityは非負整数、0は割当/event/movementなしでnull。正数は同じ取引でoperation/purchase(-quantity)/割当/eventを1組作りallocation IDを返す。未入金はpayment_hold/hold、入金済はpaid/allocate。variant stockとA/H・event・state履歴はG-1保存則に一致し、同じpurchaseをcallerで重ねない。fixture用operationは `operation='fixture_allocation'`、request_key=randomUUID、cause_type='order_item'、cause_id=orderItemId、actor_id=NULL、fingerprintは同じ正規化規則。公開bypass RPCは作らない。
- `seedGroupG1Shipment(client: PgClient,input:{orderId:string;lines:{orderItemId:string;quantity:number}[];shippedAt:string;deliveredAt?:string;cancelledAt?:string;actorId?:string;carrier?:'yamato'|'sagawa'|'japanpost';trackingNumber?:string;notifyCustomer?:boolean;requestKey?:string}): Promise<string>`。cancelledAt未指定の有効発送はAをconsumeして発送/明細/eventを作りfulfillment IDを返す。この有効発送のA不足はfixture失敗とし、二度目のpurchaseやcompletionで補わない。caller既存のcarrier/番号/actor/notify/keyを渡し、省略時はcarrier='yamato'、trackingNumber='G1-'+hyphenなしrandomUUID、notifyCustomer=false、requestKey=randomUUID、actorId=NULL。shippedAt/deliveredAt/cancelledAtはISOを明示する。必要な登録/配送event/outboxは明示seedし、業務操作成功と報告しない。 **取消済み材料は `cancelledAt` 指定時に最初からcancelled_at付きで発送/明細を作りconsume/restore/在庫移動は0件とする方式**を選び、`e2e/order-status-test-utils.ts:211-212` と `tests/integration/db/helpers/order-fixtures.ts:527` の「作成後cancelled_atだけUPDATE」をDB側はTask 16/E2E側はTask 17でこの入力へ置換し、deliveredAtとの同時指定は `GROUP_G_ARGUMENT_INVALID` でfixture失敗とする。
- `seedGroupG1Restock(client: PgClient,input:{itemId:number;variantId:number;quantity:number;actorId:string;requestKey:string}): Promise<string>`。同取引で `public.admin_record_stock_movement(itemId,variantId,quantity,'restock','E2E fixture restock',actorId,requestKey,NULL)` を呼び成功JSONのmovementIdを10進文字列で返す。G-1のlock/FIFO/履歴をそのまま通し、直接stock_movements INSERTやstock_quantity UPDATEで迂回しない。actorIdはlocal fixtureの有効なadminから渡す。
- seed.sqlは注文/アカウントなし・商品在庫はrestock台帳。BEGIN後の最初のlockは共通advisory。各SQL Task途中に必要な最小fixtureは当該Taskで既に更新し、このTaskまでGREENを延期しない。旧RPC成功を試すDB caseはTask 14で固定拒否へ変更済みとし、ここではそのGREENを回帰する。数量/返金/返品/公開表示は合成材料へ揃える。

- [ ] **Step 1: fixture DB試験を書く。** paid=A・unpaid=H・不足0/NULL variant・通常発送consume・cancelledAt指定は取消済み行だけでA/F不変かつconsume/restore/movement0（後続の有効発送はそのAを使用可）・deliveredAt同時指定拒否・restockで最古待ちへのFIFO・再送/保存則をassert。order/items作成後または割当event直後に故障を注入し、order/item/allocation/movement/event/operationが全て戻ることと、nested helperがcallerをCOMMITしないことを別接続で確認する。
- [ ] **Step 2: DB helperとseed/各DB suiteを仕上げる。** stopped RPC/completionを材料に使わず、合成shipmentと実返金/返品/FIFOを区別する。型を確認し、直接writerの残存を検索する。
- [ ] **Step 3（controller）: 完成SQLの清掃pre-cutoverを再検証する。** `npx.cmd supabase db reset --version 20261023175712 --no-seed` → 共通PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db/group_g1_cleanup.integration.test.ts --runInBand`。完成全文の正常確定/末尾故障注入の全rollbackを確認する。
- [ ] **Step 4（controller）: reset後DB全体をGREENにしてレビューする。** `npx.cmd supabase db reset` → 共通PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db --runInBand --testPathIgnorePatterns=group_g1_cleanup.integration.test.ts`。fixture suiteを含め失敗を実装者へ返し、修正後はresetから再検証する。清掃suiteはStep 3の別枠結果を示す。
- [ ] **Step 5（controller）: Filesだけコミットする。** `test(db): G-1の割当と発送材料を保存則に揃える`

### Task 17: E2E材料helperの同一取引割当と実restock adapter

**Files:**
- Create: `e2e/group-g1-test-utils.ts`、`tests/unit/e2e/group-g1-test-utils.test.ts`
- Modify: `e2e/delivery-tracking-test-utils.ts`、`e2e/order-email-test-utils.ts`、`e2e/order-fulfillment-test-utils.ts`、`e2e/order-status-test-utils.ts`、`e2e/permission-settings-test-utils.ts`、`e2e/refund-test-utils.ts`、`e2e/return-request-test-utils.ts`、`e2e/return-test-utils.ts`
- Read: Task 16のDB helper、`scripts/e2e/environment.ts`、既存各helperの全export/signature。

**Interfaces / 値:**
- `e2e/group-g1-test-utils.ts` はTask 16の4helperをlocal DB guard付きでre-export/adapterする。既存 `createFulfillment` / `shipFixture` / `createShippedOrder` / `createShippedFixture` 等の引数名/型/default/戻り型は保持。`markDeliveredInDb` / `editTrackingInDb` は同signatureのままLEGACY_FULFILLMENT_DISABLEDをthrowし、手動操作成功を偽装しない。配達を材料に使うcaseだけseed入力deliveredAtへ移す。
- **注文を作る全E2E helperはorder/items INSERTと `seedGroupG1Allocation` を同じwithGroupG1FixtureTransactionに置く**。各明細についてpaidはkind='paid'、未入金はkind='payment_hold'。通常の材料は必要数を先に実restockしてquantity=対象数。意図した不足/backorder/NULL variantの材料だけquantity=実確保可能数（0可）を明示し、未割当を全数確保に変えない。cancelled/abandoned/failedの未入金材料はH作成後に同じ取引のG-1 releaseで残H0へしてから目的状態を確定する。発送済み材料はpaid allocation→shipment consumeまで同じ取引、purchaseを二重作成しない。
- `order-email-test-utils.ts:createOrderWithLines(:223)` / `order-status-test-utils.ts:createBase(:130)` の直接purchase INSERTを削除する。これらを包む上位helperも同じtransaction contextを使い、注文だけ先にcommitしない。直接order INSERTが別のhelperに見つかったら同じ規則を適用し処置表へ追加する。
- `return-test-utils.ts:addVariant(:222)` / `return-request-test-utils.ts:addSizeVariant(:169)` のrestock INSERTを削除しseedGroupG1Restockへ。その他の全restock helperも同じ実G-1経路へ統一する。初期variantはstock_quantity=0で作り、FIFOを通る入荷だけで増やす。actorを受け取らない既存signatureでは内部でlocal有効admin材料を得る。variantを先に全作成してid昇順で事前lockし、order作成後にvariant lockへ戻らない。
- 外側BEGIN/共通advisoryより前にhelperが行lock/書込みを行わない。local専用合成と実API/RPCの操作成功を区別し、公開bypassや本番接続を作らない。処置表は次Taskに全90ファイルをまとめて一度だけ載せる。

- [ ] **Step 1: helper adapterの単体を書く。** paid/unpaidのkind、同一transaction context/順序、直接purchase/restock0、例外時rollback伝播、既存signature/default/返却shape、localhost以外拒否、停止2helper固定throwをassertする。
- [ ] **Step 2: RED→helper変更→GREENを確認する。** `npx.cmd jest tests/unit/e2e/group-g1-test-utils.test.ts --runInBand` と `npx.cmd tsc --noEmit --incremental false`。全E2E helperのorder/purchase/restock直接SQLをrgし、注文は同取引seedAllocation、入荷は実restock adapter以外の経路が0と確認する。
- [ ] **Step 3（controller）: 同一取引をDBで回帰してレビューする。** `npx.cmd supabase db reset` → 共通PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db/group_g1_fixtures.integration.test.ts tests/integration/db/group_g1_fifo.integration.test.ts --runInBand`。失敗を実装者へ返し、修正後resetから検証する。E2Eの実行は次Task。
- [ ] **Step 4（controller）: Filesだけコミットする。** `test(e2e): 注文材料の割当と入荷をG-1取引へ揃える`

### Task 18: E2E全90ファイルの処置表とspec書換・controller検証

**Files:**
- Modify/read: 下表の90ファイル（81 spec＋既存helper8＋新helper1）。helper変更はTask 17、ここでは(iii)のspecを書換え(ii)のcaseだけを停止する。(i)の維持specは不要な編集をせず回帰対象とする。
- Modify: `e2e/FR-ADMIN-123-group-g-permissions.spec.ts`、`e2e/FR-ADMIN-051-order-refund-safety.spec.ts`、`e2e/FR-ADMIN-058-item-variant-stock.spec.ts`、`e2e/FR-ADMIN-061-order-list-review-states.spec.ts`、`e2e/FR-ADMIN-081-inventory-history-refund.spec.ts`、`e2e/FR-ADMIN-093-return-guards-history.spec.ts`、`e2e/FR-CHECKOUT-045-in-stock-line.spec.ts`、`e2e/FR-ITEM-DETAIL-067-retired-variant.spec.ts`、`e2e/FR-ADMIN-073-inventory-states.spec.ts`、`e2e/FR-ADMIN-082-fulfillment-after-refund.spec.ts` を含む下表(iii)/(ii)全spec。
- Read: `playwright.config.ts`、`scripts/e2e/environment.ts`、`scripts/e2e/compare-baseline.ts`、G-0 E2E/bridge、`tests/unit/docs/delivery-status-traceability.test.ts`。その固定語変更が必要なら当該TaskのFilesへ追加して同時更新する。

**Interfaces / 値:**
- 123のG-0ケースを保持してserialにG-1を追加する。390×844/768×1024/1280×900、店長/サポーターの一覧/履歴に旧4配送/手動仕上がり入口0と固定停止文、注文取消/返金/返品/readは残る。未認証401/権限なし403は実HTTP、認可済み410/UIは既存session mock＋明示したroute bridge。実guard/実DBの拒否はTask 14単体/DBで別検証し、bridgeを完全route-to-DBと報告しない。
- E-4のFREQ-488〜497 ACコメントはADMIN100〜104 / ACCOUNT041〜043のskip case内も全て保持する。caseを分割するときは該当コメントを対応するskip側へ残す。G-1停止注記/理由を隣に加え、traceabilityの既存E-4 section words/row heads/AC coverageを削らない。
- **実在庫履歴の順序はmovement_id DESC**。081/093はlist_item_stock_historyが返した配列をそのままassertし、reason/deltaのsortで順序を隠さない。allocationEventsは別配列created_at DESC,event_id DESC、台帳行を重複表示しない。
- 081実DB fixtureは入荷+3→paid allocation purchase-3→戻さない返金+1/adjustment-1→戻す返金+1→返金失敗のFIFO purchase-1。最後のRPC結果は **`[['purchase',-1],['refund',1],['adjustment',-1],['refund',1],['purchase',-3],['restock',3]]`**。refund_idは順にrestocked.refundId/restocked.refundId/kept.refundId/kept.refundId/NULL/NULL。mockもこの時系列に揃え、最後に普通のadjustment+1を置く。表示理由の新しい順は **`['棚卸調整','注文への確保（返金の失敗で再割当）','返金','棚卸調整（返金で在庫に戻さない）','返金','注文への確保','入荷']`**。mockのbalanceAfterは古い順に3/0/1/0/1/0/1、allocationEventsを付ける。
- 093実DB fixtureは元variant入荷+2→paid purchase-2→交換先variant入荷+2→返品aの棚戻しreturn+1→返品bの交換FIFO exchange-1。RPC結果は **`[['exchange',-1],['return',1],['restock',2],['purchase',-2],['restock',2]]`**、return_idはb.returnId/a.returnId/NULL/NULL/NULL。既存3行mockの表示理由は **`['交換品への確保','返品の受け取り','棚卸調整']`**、allocationEvents追加。原因return_id/refund_idをFIFOでも維持することを確認する。発送取消caseはこの履歴caseと分けてskipする。
- 058のGET mockは既存variants/movementsにallocationEvents=[]を追加、POSTはrequestKeyがUUIDであることを検査。確認前409/no mutation、確認後は新requestKey、確定送信の再送は同keyというTask 5の契約を保持する。

- **spec内の直接stock writerも廃止する。** 045はservice_role SupabaseClient/createClientによる在庫準備・復元をlocal pg adapterへ切替える。targetとの差分deltaはG-1 RPCの `public.admin_record_stock_movement(variant.item_id,variant.id,delta,'adjustment','FR-CHECKOUT-045 の一時在庫・復元',actorId,requestKey,NULL)`（delta=0は呼ばない）で処理する。067のrestock+2はseedGroupG1Restock、073のadjustment+2は `public.admin_record_stock_movement(itemId,variantId,2,'adjustment','E2E',actorId,requestKey,NULL)` へ。いずれもTask 17のlocalhost pg接続/withGroupG1FixtureTransaction、有効admin actor、送信ごとのrandomUUID requestKeyを使い、FIFO/保存則を迂回しない。045の準備/復元の差分はその取引内のlock後に読み、F/A/Hを再読取してassertする。必要な解除確認はTask 5の固定契約を使い、直接INSERT/grant復活で代用しない。
- **082のcase別契約:** :279-346はmock返金の回帰として継続し、題名を `残りの商品を全部返金すると一覧を読み直して「配送中」になり、旧発送入口は表示しない` へ。mock.canShip=trueでも返金前後の `row.getByRole('button',{name:'発送済みにする'})` は0件、`page.getByText(LEGACY_FULFILLMENT_DISABLED_TEXT,{exact:true})` は1件/可視。返金操作・一覧再読込・配送中/一部返金の期待とFREQ-454-AC-03コメントは保持する。:348-381は `Aがない受注生産品の発送前返金は在庫台帳を動かさない（手元のDB）` へ。数量2/F0/A0のbackorderから1返金後、refundedBeforeShipment=1/inProduction=1/readyUnshipped=0/unshipped=1・有効A0・`stockLedger(db,order.orderId)=[]` をassert。recordCompletionの呼出し/数量上限の期待/未使用importを削除しFREQ-454-AC-04を保持する。:227-277の返金失敗時の原注文status/発送値の投影は材料だけ合成へ替えて継続し、発送成功/取消caseは上表のG-3再開先でskipする。

**値（全spec/helperの処置表）:**

`rg`で `e2e/` 全体を旧4RPC名、`admin_complete`/completion helper、`createFulfillment|shipFixture|createShippedOrder|markDeliveredInDb|editTrackingInDb`、order_fulfillments/order_item_completionsへの直接INSERT/SQL、旧dialog文言（**発送済みにする** / **この発送を取り消す** / 仕上がりを記録する / 発送する / 発送を記録 / 伝票番号を直す / 配達済みにする）について検索する。helperのimport先を再帰的に加え、API変更の058と実buttonをassertする061、設計13-3対象も照合する。直接一致40ファイル、関連importer/明示対象と新helperを合わせた最終集合は **90ファイル＝81 spec＋9 helper**。分類(i)は材料signature維持、(ii)は停止caseとG-3再開先、(iii)はG-1契約への書換。混在specはcase単位で処置する。

再実行するgrepは次で固定し、completionを広めに検索してから直接SQL/操作case/無関係なコメントを処置表で判定する（この直接一致集合が40）。この後、上記helperのimportを再帰的に照合し、058等の明示対象を加えて90行と比較する。

```powershell
rg -l -i 'admin_create_fulfillment|admin_cancel_fulfillment|admin_update_fulfillment_tracking|admin_mark_fulfillment_delivered|admin_complete|completion|createFulfillment|shipFixture|createShippedOrder|markDeliveredInDb|editTrackingInDb|order_fulfillments|order_item_completions|仕上がりを記録する|発送する|発送を記録|発送済みにする|この発送を取り消す|伝票番号を直す|配達済みにする' e2e -g '*.ts'
```


| spec / helper | G-1の処置・再開先 |
|---|---|
| `e2e/FR-ACCOUNT-033-order-refunds.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ACCOUNT-034-order-exchange-items.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ACCOUNT-035-return-request.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ACCOUNT-036-return-request-photos.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ACCOUNT-037-return-request-eligibility.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ACCOUNT-038-order-returns.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ACCOUNT-039-cancel-request.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ACCOUNT-040-cancel-request-closed-message.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ACCOUNT-041-delivery-without-tracking.spec.ts` | (ii)「追跡オフはリンクだけで手の配達済みは見える」「追跡オフの知らせは無視し返品は届いた日を使う」をskip。手動配達済みはG-3 FR-ADMIN-117/118/120で新票契約へ書換/再開。 |
| `e2e/FR-ACCOUNT-042-delivery-tracking.spec.ts` | (i)「配達中から配達済みと新しい順の移り変わりを出す」は合成発送から実tracking読取で継続。(ii)「直した番号だけを出し一部の配達済みは配送中のまま」は旧訂正依存でskip、G-3 FR-ADMIN-117/118/120で再開。 |
| `e2e/FR-ACCOUNT-043-delivery-visibility.spec.ts` | (ii)「登録待ちと失敗と鍵なしとオフで状況を隠す」「オンだけ委託の文を出し顧客JSONに店内の情報を出さない」は手動配達済みを契約に含むのでskip、G-3 FR-ADMIN-117/118/120で再開。公開フィールド拒否のDB/単体は維持。 |
| `e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-050-order-shipping.spec.ts` | (ii)旧発送dialogの成功/入力caseをskip、G-3 FR-ADMIN-116へ。廃止dialog固有の操作を削除し、入口停止は123へ。 |
| `e2e/FR-ADMIN-051-order-refund-safety.spec.ts` | (iii):96の発送button件数を0へ変更し固定配送停止文をassert。返金/注文取消の安全性は合成H/A材料で継続。発送可能数の旧契約はG-3 FR-ADMIN-116で新票へ書換。 |
| `e2e/FR-ADMIN-058-item-variant-stock.spec.ts` | (iii)Task 5のvariants API契約へ。GET mockは{variants,movements,allocationEvents:[]}、POST本文は必須UUID requestKeyを検査し201 {success:true}。F/A/H/棚卸確認409と新key再送・同確定key再送をmock/実契約に合わせる。 |
| `e2e/FR-ADMIN-060-order-attention-inbox.spec.ts` | (i)維持・材料置換不要。mockだけの要対応一覧/導線試験で、DB合成発送/H/A材料を使わない。 |
| `e2e/FR-ADMIN-061-order-list-review-states.spec.ts` | (iii):193の要確認/確認済みrow両方で「発送済みにする」0件と固定配送停止文をassert。要確認理由/確認操作/絞込みを継続し、発送能力の差はG-3 FR-ADMIN-116で新票へ書換。 |
| `e2e/FR-ADMIN-065-order-history-and-email-resend.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-066-ship-email-opt-out.spec.ts` | (ii)旧発送操作/opt-out成功caseをskip、G-3 FR-ADMIN-116/120へ。 |
| `e2e/FR-ADMIN-068-partial-fulfillment.spec.ts` | (iii)completion依存の数量/文言/fixtureを削除してA/Hへ。(ii)旧部分/全発送・超過/再送/競合の操作成功caseはskip、G-3 FR-ADMIN-116/117へ。 |
| `e2e/FR-ADMIN-069-made-to-order-completion.spec.ts` | (iii)手動記録/取消/発送画面内仕上がりの成功caseを削除し、入口なし/固定停止文へ書換。手動仕上がりは再開しない。 |
| `e2e/FR-ADMIN-070-order-progress-labels.spec.ts` | (iii)completionをA/Hへ書換し客語を維持。(ii)実発送UIの成功caseだけskip、G-3 FR-ADMIN-116/120。管理12状態UIはG-4 FR-ADMIN-110。 |
| `e2e/FR-ADMIN-071-fulfillment-shipping-email.spec.ts` | (ii)旧発送操作/注文別メール成功caseをskip、G-3 FR-ADMIN-116/120へ。 |
| `e2e/FR-ADMIN-072-fulfillment-cancel.spec.ts` | (ii)旧発送取消成功caseをskip、G-3 FR-ADMIN-117へ。 |
| `e2e/FR-ADMIN-073-inventory-states.spec.ts` | (iii)completionを削除しF/A/H・自動割当理由/履歴へ。:185-189の直接adjustment(+2)はlocal pg adapterからpublic.admin_record_stock_movementへ（reason=adjustment,note=E2E、actor維持、UUID requestKey、expectedReleaseQuantity=NULL）。FIFO後の残高/割当数をassert。既存在庫窓口を継続、G-2 FR-ADMIN-111/113。 |
| `e2e/FR-ADMIN-074-refund-dialog.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-075-paid-order-cancel.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-076-order-list-payment-column.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-077-order-history-refunds.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-078-refund-failure-attention.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-079-shop-settings.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-080-stripe-dashboard-refund.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-081-inventory-history-refund.spec.ts` | (iii)variants GET mockへallocationEventsを追加、purchase/exchangeのG-1理由文と下記movement_id DESCの実DB理由順へ書換。配列をsortして順序を隠さず、返金失敗のFIFO再割当/原因IDをassert。 |
| `e2e/FR-ADMIN-082-fulfillment-after-refund.spec.ts` | (ii):59-134の旧発送画面/RPC成功はG-3 FR-ADMIN-116/120、:136-181の旧発送取消RPCと:183-225（:219で取消button押下）の旧取消UIはG-3 FR-ADMIN-117/120で新票へ書換/再開するまでskip。(i):227-277の実返金投影は合成発送材料で継続。(iii):279-346のmock返金は前後のship button0＋G-1停止文へ、:348-381のA0受注生産返金はcompletion部を削除し台帳空をassert。詳細は直前のcase契約。 |
| `e2e/FR-ADMIN-083-paid-cancel-email.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-084-return-create.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-085-return-receive-refund.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-086-return-partial-missing-cancel.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-087-return-consult-refund.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-088-return-exchange.spec.ts` | (iii)make手動仕上がりを削除、stock即先取りを通常FIFO/手数料待ちA0へ。(i)返品/交換材料は合成発送。(ii)実発送操作caseだけskip、G-3 FR-ADMIN-116/120。 |
| `e2e/FR-ADMIN-089-return-sent-back.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-090-return-support-receive.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-091-order-list-returns.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-092-shop-return-settings.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-093-return-guards-history.spec.ts` | (ii):248「この発送を取り消す」で旧FULFILLMENT_HAS_RETURNを試すcaseはskip、G-3 FR-ADMIN-117/120の新発送票取消・通知で書換/再開。(iii)履歴mock/実list_item_stock_historyを下記G-1理由/降順へ書換、allocationEvents追加。(i)その他の返品guardは合成材料で継続。 |
| `e2e/FR-ADMIN-094-return-request-approve.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-095-return-request-decline.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-096-customer-return-support-refund.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-097-cancel-requests.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-098-return-request-settings.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-099-item-return-ineligible.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-100-fulfillment-tracking-edit.spec.ts` | (ii)旧履歴/API訂正の成功caseをskip、G-3 FR-ADMIN-117/118/120へ。材料fixtureは(i)、停止確認は123/DBへ。 |
| `e2e/FR-ADMIN-101-fulfillment-delivered.spec.ts` | (ii)旧手動配達済み成功caseをskip、G-3 FR-ADMIN-117/118/120へ。材料fixtureは(i)、停止確認は123/DBへ。 |
| `e2e/FR-ADMIN-102-delivery-tracking-sync.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-103-delivery-attention.spec.ts` | (i)配送要対応の発生/解消/再発・不在/追跡不能の優先・履歴readは合成発送から継続。対応済み操作は停止対象ではない。 |
| `e2e/FR-ADMIN-104-delivery-tracking-settings.spec.ts` | (iii)説明配列の第三文をShopSettingsのG-1固定文へ変更し設定/readは継続。(ii)旧「オフの間も、伝票番号の直しと、手で配達済みにすることはできます」の能力保証だけ独立caseとしてskip、G-3 FR-ADMIN-117/118/120で再開。旧文を現在の可視期待として残さない。 |
| `e2e/FR-ADMIN-105-cancel-reasons.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-106-refund-failure-note-required.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-107-dialog-order-number-close.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-108-select-fields.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ADMIN-109-permission-settings.spec.ts` | (i)permission-settings-test-utilsのread/設定材料を保持。G-0の許可設定/保存契約を変えず回帰。 |
| `e2e/FR-ADMIN-123-group-g-permissions.spec.ts` | (iii)G-0を保持しG-1の旧4配送/手動仕上がり入口停止、410/401/403、3画面幅を追加。後段G-2/G-3/G-4は合格に数えない。 |
| `e2e/FR-CHECKOUT-006-confirmation-email.spec.ts` | (i)維持・材料置換不要。検索一致は決済完了コメントのcompletionだけで、手動仕上がり/RPC/fixture依存はない。既存のデモskipをG-1成功に数えない。 |
| `e2e/FR-CHECKOUT-041-confirmation-email-fulfillment.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-CHECKOUT-045-in-stock-line.spec.ts` | (iii):40のservice_role supabase-js stock_movements INSERTを廃止。beforeAll/afterAllのsetStockCountをlocalhost pg adapter＋public.admin_record_stock_movement（adjustment、既存note維持、有効admin actor/UUID requestKey）へ。商品/variant選択もlocal pgへ替え、FIFO後の数量/購入・メール回帰を確認する。直接DML権限を戻さない。 |
| `e2e/FR-CHECKOUT-049-order-email-sent-once.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-CHECKOUT-050-split-shipment-notice.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-CHECKOUT-051-auto-refund-cancelled-order.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-CONTACT-014-order-status-prefill.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ITEM-DETAIL-066-return-ineligible.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ITEM-DETAIL-067-retired-variant.spec.ts` | (iii):55-58の直接restockをlocal pg adapterのseedGroupG1Restock（quantity=2）へ。inactive variantのまま実G-1入荷/FIFOを通し、is_active=falseと顧客の在庫あり集計に含まれない契約を維持。 |
| `e2e/FR-ORDER-001-public-view.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ORDER-002-verify-private.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ORDER-003-verify-limits.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ORDER-004-expiry.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ORDER-005-returns-guidance.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ORDER-006-email-link.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ORDER-007-not-found-security.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ORDER-008-delivery-refund-visibility.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ORDER-009-no-shipping-needed-before-verify.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/FR-ORDER-010-keep-display-on-return.spec.ts` | (i)既存helperのsignatureを保った合成発送/H/A材料へ差替え、返金/返品/公開範囲/客語/表示または設定の本来の回帰を継続。spec自体の不要な編集はしない。 |
| `e2e/delivery-tracking-test-utils.ts` | (i)注文を作るshipFixture/createShippedFixtureは既存signatureで同一transactionのseedGroupG1Allocation→seedGroupG1Shipment/登録へ。markDeliveredInDb/editTrackingInDbは同signatureの固定throw、操作caseは(ii)へ。 |
| `e2e/group-g1-test-utils.ts` | (i)Task 17で新設。localhost専用transaction/allocation/shipment/restock adapterを再export。公開/本番bypassを作らない。 |
| `e2e/order-email-test-utils.ts` | (i)createOrderWithLinesのorder/items作成とseedGroupG1Allocationを同一transactionへ。:223の直接purchaseを削除しhelperがmovement/event/割当を1組作る。createFulfillmentは同signatureでseedGroupG1Shipmentへ、outbox材料は明示seed。 |
| `e2e/order-fulfillment-test-utils.ts` | (i)原本/型/既存exportを保持し、注文生成は同一transactionのallocation、completedは実Aから作る。(iii)旧create/completion/発送/cancelのbridgeは固定410拒否へ。 |
| `e2e/order-status-test-utils.ts` | (i)createBaseのorder/itemsとseedGroupG1Allocationを同一transactionへ。:130の直接purchaseを削除。公開リンク/会員/電話/客語のsignatureと公開範囲は保持し、材料の配達だけseed入力deliveredAtへ。 |
| `e2e/permission-settings-test-utils.ts` | (iii)権限/readのsignatureとG-0ケースを保持。注文生成は同一transactionのallocation。旧配送/仕上がりbridge成功を固定410拒否へ。 |
| `e2e/refund-test-utils.ts` | (i)既存signature/金額/Stripe fakeを保持。注文生成は同一transactionのallocation、発送材料はseedGroupG1Shipmentへ。実返金/復元/FIFOをstubしない。 |
| `e2e/return-request-test-utils.ts` | (i)既存signatureを保持。addSizeVariant :169の直接restockをseedGroupG1Restock経由のG-1実在庫RPCへ。createShippedFixture等は同一transactionのallocation→shipment、材料の配達はdeliveredAtへ。 |
| `e2e/return-test-utils.ts` | (i)既存signature/ReturnFixtureを保持。addVariant :222の直接restockはseedGroupG1Restock→G-1実在庫RPCへ。注文は同取引allocation→shipment、返品/受取/返金は実関数。(iii)stock先取り期待はFIFOへ。 |

- [ ] **Step 1: 上表(iii)をG-1へ書換え、(ii)を理由付きskipにする。** 123/051/058/061/073/081/082/093とCHECKOUT-045/ITEM-DETAIL-067を上の固定値へ。045/067/073の直接台帳書込みをlocal pgの実G-1経路へ替え、082をcase単位に分ける。停止caseはfixture/旧UI操作より先に `test.skip(true,'G-1: 旧配送操作停止。G-3 FR-ADMIN-117/118/120で新票へ書換・再開')` を置き、発送は116・取消は117・通知は120の必要な番号だけに絞る。ACコメントは保持する。旧手動completion成功caseだけ削除し、停止/削除/継続/追加case数を記録する。
- [ ] **Step 2: 全検索/文書単体/型を確認する。** 追加した実button2語を含むrgを再実行し、90行と漏れ0を照合する。停止RPC名は拒否/skip/固定拒否adapterだけ、`rg -n -i 'stock_movements|stock_quantity\s*=' e2e -g '*.ts'` でもspec内の直接INSERT/stock_quantity UPDATE（045のsupabase-jsも含む）が0で、在庫準備/復元/棚卸はlocal pgのG-1 RPC/seedGroupG1Restockだけ。直接allocation/movement/shipment SQLはlocal DB synthetic helperだけ。`npx.cmd jest tests/unit/docs --runInBand` と `npx.cmd tsc --noEmit --incremental false`、route counts132/171とE-4 ACコメントの維持を確認する。
- [ ] **Step 3（controller）: reset→DBを確認する。** `npx.cmd supabase db reset` → 共通PostgREST各HTTP 200 → `npx.cmd jest tests/integration/db --runInBand --testPathIgnorePatterns=group_g1_cleanup.integration.test.ts`。清掃suiteはTask 16の旧schema別枠結果を併記する。失敗は実装者へ返しresetから再検証する。
- [ ] **Step 4（controller）: 再reset→production build E2Eを確認する。** `npx.cmd supabase db reset` → 共通PostgREST各HTTP 200 → `$env:E2E_STRICT='1'`、`Remove-Item Env:E2E_DEV_SERVER -ErrorAction SilentlyContinue` → `npx.cmd playwright test e2e/FR-ADMIN-123-group-g-permissions.spec.ts e2e/FR-ADMIN-069-made-to-order-completion.spec.ts e2e/FR-ADMIN-073-inventory-states.spec.ts e2e/FR-ADMIN-051-order-refund-safety.spec.ts e2e/FR-ADMIN-058-item-variant-stock.spec.ts e2e/FR-ADMIN-061-order-list-review-states.spec.ts e2e/FR-ADMIN-081-inventory-history-refund.spec.ts e2e/FR-ADMIN-093-return-guards-history.spec.ts e2e/FR-ADMIN-082-fulfillment-after-refund.spec.ts e2e/FR-CHECKOUT-045-in-stock-line.spec.ts e2e/FR-ITEM-DETAIL-067-retired-variant.spec.ts --project=chromium --workers=1`。3000番＋local Supabase、既存configのbuild/startを使い終了後のlocal E2E appは維持する（最終push前に停止）。DB後の2回目resetを省略しない。
- [ ] **Step 5（controller）: レビュー後Filesだけコミットする。** `test(admin): G-1の旧操作停止と在庫履歴をE2Eへ反映する`

### Task 19（controller）: 全体検証・最終レビュー・直前確認・MCP適用・改名/push

**Files:** 検証記録 `.superpowers/sdd/2026-10-24-group-g1-allocation/`、`e2e-baseline-tests.json`、`e2e-disposition.md`、対象migrationの適用versionへの時刻部分改名。既存の無関係差分は取り込まない。

**Interfaces / 値:** 本番読取=`Supabase MCP execute_sql`、本番適用=`apply_migration` 1回/1ファイル。DB password/接続文字列を受け取らず、スクリプトから本番へ接続しない。**pg_cronの設定変更は行わない**（別のowner承認が必要な本番設定変更）。cronの停止/無効化/再設定をこの手順の前提にしない。移行はTask 1のBEGIN直後の `SET LOCAL lock_timeout = '15s';` → advisory `(190521,1)` → 固定31表ACCESS EXCLUSIVEで直列化し、取れなければ全rollbackして後の時間枠で読取/確認からやり直す。

**値（cronの安全なread-only SQL）:** 次のSELECTだけをMCP execute_sqlへ渡す。返す列は **jobname/schedule/active/function_names** の4列だけ。commandは内部でSQL文字列literalを除去して関数呼出し名を抽出するためにだけ使い、command本文/URL/key/payloadを結果/ログ/レビューへ出さない。抽出できないjobも消さずfunction_names={}として残す。

```sql
WITH safe_jobs AS (
  SELECT jobname, schedule, active,
         regexp_replace(command, $g1str$'([^']|'')*'$g1str$, '', 'g') AS code
  FROM cron.job
)
SELECT j.jobname, j.schedule, j.active,
       COALESCE((
         SELECT array_agg(DISTINCT lower(replace(m.parts[1], '"', ''))
                          ORDER BY lower(replace(m.parts[1], '"', '')))
         FROM regexp_matches(
           j.code,
           $g1fn$(("?[[:alpha:]_][[:alnum:]_]*"?\.)?"?[[:alpha:]_][[:alnum:]_]*"?)[[:space:]]*\($g1fn$,
           'g'
         ) AS m(parts)
         WHERE lower(replace(m.parts[1], '"', ''))
               NOT IN ('if','while','in','values','for','case')
       ), ARRAY[]::text[]) AS function_names
FROM safe_jobs j
ORDER BY j.jobname;
```

候補は既存 `checkout-drafts-retention` / `order-email-retention` と、`supabase/pending/` にある **`expire-pending-orders` / `process-stripe-webhooks` / `stripe-reconcile` / `purge-return-photos`**。pendingだけで本番登録済みと決め付けず上の実結果と照合し、呼出し先の既知関数のwrite先を31表一覧へ対応付ける。追加jobも同じ安全なメタデータで調べ、writer jobの件数/名前/schedule/active/関数名だけownerへ示す。`cron.alter_job` / `cron.unschedule` / cron.job UPDATEはしない。解析不能/用途不明は原文を取得・開示せずcontrollerが安全な登録元/関数定義で解消するまで適用しない。

**値（local writerのPowerShell確認、秘密値を表示しない）:**

```powershell
$g1Processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(node|stripe|npm|npx)(\.exe|\.cmd)?$'
})
$g1Processes | ForEach-Object {
  $g1Command = [string]$_.CommandLine
  [pscustomobject]@{
    Pid = $_.ProcessId
    ParentPid = $_.ParentProcessId
    Name = $_.Name
    Workspace = $g1Command -match 'C:[\\/]work[\\/]o_official(?:[\\/\s]|$)'
    NpmDev = $g1Command -match '(npm(?:\.cmd)?\s+run\s+dev|next(?:[\\/\s]|\.js).*\bdev\b)'
    StripeListen = $g1Command -match '\bstripe(?:\.exe)?\s+listen\b'
  }
} | Format-Table -AutoSize
Get-NetTCPConnection -State Listen | Select-Object LocalPort, OwningProcess |
  Sort-Object LocalPort, OwningProcess -Unique | Format-Table -AutoSize
```

実行引数の原文/環境変数は出力しない。controllerは自分の起動記録/親PIDで全候補をこのrepoのwriterか無関係かに分類し、判定不能を「安全」と推定しない。Task 18のport3000 E2E appはstrict環境確認済みの **local Supabase向けでproduction writerではない** が、push前にはこれも止める。確認済みrepo writerとその子のPIDだけを `$g1WriterPids = @(確認した数値PID)` に固定して `Stop-Process -Id $g1WriterPids`、同じ棚卸しを再実行する。無関係なnode/stripeを一括停止しない。残存候補を許すのはこのrepo/productionと無関係と確認済みのPIDだけで、未分類があれば停止。終了確認は次の固定コマンドで行う（配列は数値だけ、commandは表示しない）。

```powershell
$g1RemainingWriters = @(Get-Process -Id $g1WriterPids -ErrorAction SilentlyContinue)
$g1Port3000 = @(Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue)
if ($g1RemainingWriters.Count -ne 0 -or $g1Port3000.Count -ne 0) {
  throw 'GROUP_G_LOCAL_WRITER_ACTIVE'
}
[pscustomobject]@{ RemainingWriterCount = 0; Port3000ListenerCount = 0 }
```

新PIDのspawnも棚卸しで再確認する。これにより3000 app/npm run dev/stripe listenを含むrepo writerが停止した状態を証明し、接続先の秘密設定を読まない。未知/残存writerは適用不可。

- [ ] **Step 1: 全体検証を集約する。** 型/単体/lint、`npx.cmd jest tests/unit/docs --runInBand`、清掃pre-cutover、`npx.cmd supabase db reset` → 共通PostgREST各HTTP 200 → DB結合全体 → `npx.cmd supabase db reset` → 共通PostgREST各HTTP 200 → production build E2Eの実数を確認する。既存validate-docs/traceability失敗を分け、`graphify hook status` だけを確認する。
- [ ] **Step 2: E2E全件を最新baselineと比較する。** devサーバーを止めた本番build＋ローカルSupabaseで `npx.cmd playwright test` を流す。基準は今回指定の **182 failed / 3477 passed / 28 skipped / 3687 total**（G-0 progress.md:55の全件）。現在の `test-results/e2e-results.json` は183 failed / 3476 passed / 28 skippedで、指定baselineと違うためコピーして代用しない。controllerが182/3477の全件artifactを取得し、既存compare-baselineの `TestOutcome[]` 形式へ正規化して上記 `e2e-baseline-tests.json` に固定する。既定は古い2026-10-05なので `npm.cmd run e2e:compare -- .superpowers/sdd/2026-10-24-group-g1-allocation/e2e-baseline-tests.json test-results/e2e-results.json` と明示する。元artifactが無ければ件数だけでcase結果を再構成せず、取得まで比較完了としない。実行/成功/失敗/skip/削除/追加を別計上し、13-3で許された停止/削除によるmissing/regressionだけを対応表で説明する。既存失敗をG-1の成功に振り替えず、新規の説明不能な退行を残さない。
- [ ] **Step 3: 最終レビュー（Opus、effort high）を行う。** 全体lock/行lock前advisory・link_guest_ordersのid順・未変更RPCのstock非待ち/既存FKの40P01許容・writer overload、FIFO案A/NULL/holdと両resolver、版付きdelivery再送、paid_at一度、旧6RPC/2helper/UI不達、31表WHERE/法定trigger/FK/payout/未完了webhook終端化/通知抑止・保持、末尾故障注入の全rollbackを確認する。清掃節単独レビューも記録し、指摘後は該当reset/HTTP/DB/単体/E2Eを再実行して再レビューする。
- [ ] **Step 4: MCPで最初のcount-only読取を行う。** Task 1の31表を同じWHERE/5列でCOUNTし固定順保存。O/P/WはCTEだけ（temp作成なし）。全variant件数/リセット件数/在庫合計、削除balance件数、影響する実在payout件数、補足balance_without_payout件数、問い合わせ解除件数、**Wの未完了webhook件数**を含む。ID/メール/payload/本文は返さない。最終関数MD5/owner/search_path/ACL/trigger/FKをMCP読取でlocal G-0と照合し差があれば停止する。
- [ ] **Step 5: pushより前にSQLのencoding/hashを固定する。** UTF-8/BOMなし/LF・CR/U+3000=0、dollar-quoted関数/DOを除くトップレベルBEGIN/COMMIT各1、先頭清掃/末尾assertを検査する。MD5小文字/byte数を保存し、新4表/paid_at未適用も確認する。以後本文を変えたら該当検証/レビュー/hash固定からやり直す。
- [ ] **Step 6: local writerを止め、検証済み対象コミットをpushする。** 上のPowerShell棚卸し/停止/再確認を実施する。3000 local E2E appも停止してからmasterの対象コミットだけpushしpre-pushを確認する。別管理のproduction writer設定やcronには触れない。アプリ/DBが揃うまでrepo local writerを再開しない。
- [ ] **Step 7: apply直前にwriter/cron/件数を再読取する。** 上のPowerShell棚卸しで新たなrepo/不明writer0・3000 listener0を確認し、MCP execute_sqlで上記cron SELECTを実行する。続けてStep 4と完全に同じ31表＋補足のCOUNT/SUMをMCP execute_sqlで再読取する。**どれかの件数が前回より高い場合はwriterが活動したと判断して停止**し、原因を解消して最初の読取からやり直す。**どれかが低い場合も停止して再読取**し、減少原因を確認したうえで連続2回の件数が一致する新しい読取を作る。増減を説明しただけで進めず、安定した最新の具体的な件数でowner確認を取り直す。variantの在庫合計だけの変動も同じ停止/再読取とする。cron設定は変更しない。
- [ ] **Step 8: ownerへ次の文と全件数を示し明示確認を待つ。** `表示した31表の条件と件数で、旧注文・関連記録を削除し、問い合わせの注文関連だけを外し、影響する入金照合の集計を残存行で計算し直して未照合に戻します。表示した未完了Stripeイベントは削除せずdead（これ以上処理しない）へ移し、理由をgroup_g1_test_data_cleanupとして保存し、同じ取引で通知済み時刻も設定します。このテストデータについて知らせのメールは送らない運用にします。法定保存の削除保護トリガー（protect_legal_order_delete / protect_legal_order_item_delete）は、この1取引の中だけ無効にして復元します。全商品の在庫は0になり、再入荷を記録するまで売り切れ表示になります。cron設定は変えず、15秒以内に必要なロックを取れなければ全体を取り消します。表示した件数の清掃とG-1を一つの取引で適用してよいですか。` **明示確認がなければ停止**。一般的な実装承認/時間経過を代用しない。確認後のwriter再開/時間枠変更/件数変化はStep 7へ戻し再確認する。
- [ ] **Step 9: MCP apply_migrationの1回で全文を適用する。** Step 8の直後に `apply_migration({name:'group_g1_allocation',query:固定した1ファイル全文})` を1回だけ呼ぶ。BEGIN/15s timeout/共通advisory/固定31表lock→清掃→本体→末尾assert→COMMIT、清掃単独確定/履歴手INSERTは禁止。55P03/40P01を含む失敗は全rollback/履歴を読取で確認し、個別節適用や即時の強制再試行をせず、後の時間枠にStep 4/7/8からやり直す。cron設定を変えて通さない。
- [ ] **Step 10: 履歴と実schemaをMCPで照合する。** 実適用versionの `md5(statements[1]) AS statement_md5,octet_length(statements[1]) AS statement_bytes,array_length(statements,1) AS statement_count` がcount=1・固定MD5/bytes一致。不一致は停止。Task 14の全期待objects/2DROP、31表/全variant0/Wのdead・固定reason・dead_notified_at非NULL/未通知dead一覧0（適用後は固定reason='group_g1_test_data_cleanup'の件数と通知済み時刻を清掃前W件数に照合し、pg_tempへ依存しない）・総行数保持、payout/問い合わせ、private USAGE/hook/個別ACL、G-0保持も再照合する。本番で試験注文は作らない。
- [ ] **Step 11: 実適用versionへ改名し記録してpushする。** 1ファイルの時刻部分だけMCPのversionへ改名（同じなら不要）、suffix/本文不変。suffix1本、改名前後MD5＝本番md5(statements[1])、ファイルversion/name＝履歴を確認し、`chore(inventory): G-1の本番適用番号と検証結果を記録する` で対象だけcommit/pushする。アプリ/DB整合確認後に必要なlocal writerを再開する。cron設定は元から変えていない。旧4配送はG-3新票まで停止を維持し、実数/baseline差/停止削除数/未確認境界/清掃確認を報告する。
